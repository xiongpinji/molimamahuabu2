'use strict';

const { createHash } = require('node:crypto');
const fumin = require('./fuminVideoClient');
const toapis = require('./toapisVideoClient');
const feituo = require('./feituoVideoClient');
const { normalizeVideoProviderResult } = require('./redrawProviderAdapters');

const OPTION_KEYS = new Set(['model', 'prompt', 'duration', 'aspect_ratio', 'resolution', 'generate_audio',
  'image_url', 'first_frame_url', 'last_frame_url', 'reference_urls', 'reference_video_urls',
  'reference_audio_urls', 'voice_reference_url', 'trusted_asset_urls', 'client_business_id']);
const REFERENCE_ARRAYS = new Set(['reference_urls', 'reference_video_urls', 'reference_audio_urls', 'trusted_asset_urls']);
const PROTOCOLS = new Set(['fumin_video', 'toapis_video', 'feituo_open']);
const REJECTION_HTTP = new Set([400, 401, 413, 422, 429]);
const MAX_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const ASYNC_FUNCTION_PROTOTYPE = Object.getPrototypeOf(async function () {});

function preflightError() {
  return Object.assign(new Error('Redraw unit video preflight rejected'), { code: 'REDRAW_UNIT_VIDEO_PREFLIGHT_INVALID' });
}

function plainRecord(value, allowed) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw preflightError();
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || (allowed && !allowed.has(key)) || !Object.hasOwn(descriptor, 'value')) throw preflightError();
    result[key] = descriptor.value;
  }
  return result;
}

function boundedControl(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw preflightError();
  return Math.min(value, maximum);
}

function safeString(value, maximum, key) {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) return '';
  const text = String(value).trim();
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/u.test(text) || (key && (text.includes(key) || text.includes(encodeURIComponent(key))))) return '';
  try {
    if (key && decodeURIComponent(text).includes(key)) return '';
  } catch (_) { return ''; }
  return text;
}

function prepare(input, runtime, query) {
  const value = plainRecord(input, new Set(query ? ['protocol', 'config', 'provider_task_id'] : ['protocol', 'config', 'opts']));
  if (!PROTOCOLS.has(value.protocol)) throw preflightError();
  const suppliedConfig = plainRecord(value.config);
  const config = {};
  for (const name of ['base_url', 'api_key', 'endpoint', 'query_endpoint']) {
    if (suppliedConfig[name] !== undefined) {
      if (typeof suppliedConfig[name] !== 'string') throw preflightError();
      config[name] = suppliedConfig[name].trim();
    }
  }
  if (!config.api_key || !config.base_url || /[\r\n]/u.test(config.api_key)) throw preflightError();
  const controls = plainRecord(runtime, new Set(query ? ['fetchImpl', 'signal', 'requestTimeoutMs', 'responseMaxBytes']
    : ['fetchImpl', 'beforeSubmit', 'signal', 'requestTimeoutMs', 'responseMaxBytes']));
  if (typeof controls.fetchImpl !== 'function' || (!query && typeof controls.beforeSubmit !== 'function')) throw preflightError();
  if (!query && Object.getPrototypeOf(controls.beforeSubmit) === ASYNC_FUNCTION_PROTOTYPE) throw preflightError();
  if (controls.signal !== undefined && !(controls.signal instanceof AbortSignal)) throw preflightError();
  if (controls.signal?.aborted) throw preflightError();
  controls.requestTimeoutMs = boundedControl(controls.requestTimeoutMs, 30_000, MAX_TIMEOUT_MS);
  controls.responseMaxBytes = boundedControl(controls.responseMaxBytes, 1024 * 1024, MAX_RESPONSE_BYTES);
  let providerId;
  let opts;
  if (query) {
    providerId = safeString(value.provider_task_id, 256, config.api_key);
    if (!providerId) throw preflightError();
  } else {
    opts = plainRecord(value.opts, OPTION_KEYS);
    for (const [name, item] of Object.entries(opts)) {
      if (REFERENCE_ARRAYS.has(name)) {
        if (!Array.isArray(item)) throw preflightError();
        const descriptors = Object.getOwnPropertyDescriptors(item);
        opts[name] = Array.from({ length: item.length }, (_, index) => {
          const descriptor = descriptors[index];
          if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') throw preflightError();
          return descriptor.value;
        });
      } else if (item != null && !['string', 'number', 'boolean'].includes(typeof item)) throw preflightError();
    }
  }
  return { protocol: value.protocol, config, opts, providerId, controls };
}

function submitDetails({ protocol, config, opts }) {
  if (protocol === 'fumin_video') return { url: fumin.buildFuminCreateUrl(config), body: fumin.buildFuminVideoBody(opts) };
  if (protocol === 'toapis_video') return { url: `${toapis.normalizeToapisBaseUrl(config.base_url)}/v1/videos/generations`, body: toapis.buildToapisVideoBody(opts) };
  return { url: `${feituo.normalizeFeituoBaseUrl(config.base_url)}/api/open/v1/video/generate`, body: feituo.buildFeituoVideoBody(opts) };
}

async function readBounded(response, maxBytes, controller) {
  const declared = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('response bound');
  if (!response?.body || typeof response.body.getReader !== 'function') {
    const raw = await response.text();
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > maxBytes) throw new Error('response bound');
    return raw;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) throw new Error('response bound');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } catch (error) {
    controller.abort();
    Promise.resolve(reader.cancel()).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function captureResponse(url, init, controls) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, ...[controls.signal, init.signal].filter(Boolean)]);
  let timer;
  let onAbort;
  const interrupted = new Promise((_, reject) => {
    onAbort = () => reject(new Error('transport interrupted'));
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => controller.abort(), controls.requestTimeoutMs);
  });
  try {
    if (signal.aborted) throw new Error('transport interrupted');
    return await Promise.race([(async () => {
      const response = await controls.fetchImpl(url, { ...init, redirect: 'error', signal });
      const raw = await readBounded(response, controls.responseMaxBytes, controller);
      let payload = null;
      try { payload = JSON.parse(raw); } catch (_) {}
      return { status: response.status, raw, payload };
    })(), interrupted]);
  } catch (_) {
    controller.abort();
    return { status: 0, raw: '', payload: null };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeObservation(observation, request, query) {
  const { protocol, config } = request;
  const raw = observation?.payload;
  const unknown = (id = request.providerId) => normalizeVideoProviderResult({ status: 'submission_unknown', provider_task_id: id });
  if (!isRecord(raw)) return unknown();
  const nested = isRecord(raw.data) ? raw.data : {};
  const data = protocol === 'feituo_open' ? { ...raw, ...nested } : raw;
  const idValues = protocol === 'feituo_open' ? [data.jobId, data.job_id] : [raw.id, raw.task_id, nested.id, nested.task_id];
  const suppliedIds = idValues.filter((value) => value != null && value !== '');
  const safeIds = suppliedIds.map((value) => safeString(value, 256, config.api_key));
  const providerId = request.providerId || safeIds.find(Boolean);
  const idConflict = safeIds.some((id) => !id) || new Set(safeIds).size > 1
    || (query && safeIds.some((id) => id !== request.providerId));
  if (idConflict) return unknown(providerId);

  const stateValues = protocol === 'feituo_open' ? [data.status, data.state]
    : protocol === 'fumin_video' ? [raw.status, raw.state, nested.status, nested.state] : [raw.status, nested.status];
  const suppliedStates = stateValues.filter((value) => value != null);
  const states = suppliedStates.map((value) => typeof value === 'string' ? safeString(value, 64, config.api_key) : '');
  if (states.some((value) => !value) || (protocol === 'toapis_video' && [raw.state, nested.state].some((value) => value != null))) return unknown(providerId);
  const categories = states.map((status) => normalizeVideoProviderResult({ status, result_url: 'https://classification.invalid/candidate' }).status);
  // Accepted/failed classifications must be calculated without a conflicting artificial URL.
  for (let index = 0; index < states.length; index += 1) {
    const withoutUrl = normalizeVideoProviderResult({ status: states[index] }).status;
    if (withoutUrl !== 'result_unavailable') categories[index] = withoutUrl;
  }
  if (new Set(categories).size > 1) return unknown(providerId);
  const category = categories[0];
  const bodies = protocol === 'feituo_open' ? [data] : [raw, nested];
  const hasError = bodies.some((body) => Boolean(body.error || body.errorMessage || body.error_message || body.error_msg) || body.success === false);
  const hasSuccessFlag = bodies.some((body) => body.success === true);
  let extractedUrl;
  try {
    extractedUrl = (protocol === 'fumin_video' ? fumin.parseFuminStatusPayload(raw)
      : protocol === 'toapis_video' ? toapis.parseToapisVideoStatus(raw) : feituo.parseFeituoStatusPayload(raw)).videoUrl;
  } catch (_) { return unknown(providerId); }
  let resultUrl = '';
  if (extractedUrl) {
    resultUrl = safeString(extractedUrl, 8192, config.api_key);
    try {
      const parsed = new URL(resultUrl);
      const queryEcho = [...parsed.searchParams].some(([name, value]) => name.includes(config.api_key) || value.includes(config.api_key));
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
        || queryEcho) resultUrl = '';
    } catch (_) { resultUrl = ''; }
    if (!resultUrl) return unknown(providerId);
  }
  if (!Number.isInteger(observation.status) || observation.status < 200 || observation.status >= 300) {
    if (!query && REJECTION_HTTP.has(observation.status) && hasError && !hasSuccessFlag && !providerId && !resultUrl
      && (!category || category === 'failed_terminal')) return normalizeVideoProviderResult({ status: 'failed_terminal' });
    return unknown(providerId);
  }
  if (!query && protocol === 'toapis_video' && !providerId) return unknown(providerId);
  let status = category;
  if (!suppliedStates.length) {
    if (hasError) return unknown(providerId);
    if (resultUrl) status = 'completed_candidate';
    else if (!query && providerId) status = 'accepted';
    else return unknown(providerId);
  }
  if (status === 'submission_unknown' || ((status === 'accepted' || status === 'running') && (!providerId || hasError))
    || (status === 'completed_candidate' && hasError)) return unknown(providerId);
  return normalizeVideoProviderResult({ status, provider_task_id: providerId, result_url: resultUrl });
}

async function submitRedrawUnitVideo(input, runtime) {
  let request;
  let details;
  let body;
  try {
    request = prepare(input, runtime, false);
    details = submitDetails(request);
    body = JSON.stringify(details.body);
  } catch (_) { throw preflightError(); }
  let entered = false;
  let preflightFailure;
  let observation;
  let transport;
  const fetchImpl = async (url, init) => {
    try {
      if (entered || url !== details.url || init.method !== 'POST' || typeof init.body !== 'string' || init.body !== body
        || init.headers?.Authorization !== `Bearer ${request.config.api_key}` || request.controls.signal?.aborted) throw preflightError();
      entered = true;
      const marker = { request_hash: createHash('sha256').update(init.body, 'utf8').digest('hex') };
      const marked = request.controls.beforeSubmit(marker);
      if (marked !== true) {
        // Consume native Promise rejection without awaiting or executing arbitrary thenable hooks.
        try { Promise.prototype.then.call(marked, undefined, () => {}); } catch (_) {}
        throw preflightError();
      }
      if (request.controls.signal?.aborted) throw preflightError();
    } catch (_) {
      preflightFailure = preflightError();
      throw preflightFailure;
    }
    transport = captureResponse(url, init, request.controls);
    observation = await transport;
    return { status: observation.status, ok: observation.status >= 200 && observation.status < 300, text: async () => observation.raw };
  };
  try {
    if (request.protocol === 'fumin_video') await fumin.callFuminVideoApi(request.config, null, { ...request.opts, fetchImpl });
    else if (request.protocol === 'toapis_video') await toapis.callToapisVideoApi(request.config, null, request.opts, { apiKey: request.config.api_key, fetchImpl });
    else await feituo.callFeituoVideoApi(request.config, null, request.opts, { fetchImpl });
  } catch (_) {
    // Legacy parsing errors cannot erase the separately captured transport observation.
  }
  if (preflightFailure || !entered) throw preflightFailure || preflightError();
  if (transport) observation = await transport;
  return normalizeObservation(observation, request, false);
}

async function queryRedrawUnitVideo(input, runtime) {
  let request;
  let url;
  try {
    request = prepare(input, runtime, true);
    if (request.protocol === 'fumin_video') url = fumin.buildFuminQueryUrl(request.config, request.providerId);
    else if (request.protocol === 'toapis_video') url = `${toapis.normalizeToapisBaseUrl(request.config.base_url)}/v1/videos/generations/${encodeURIComponent(request.providerId)}`;
    else url = feituo.buildFeituoStatusUrl(request.config.base_url, request.providerId);
  } catch (_) { throw preflightError(); }
  const observation = await captureResponse(url, { method: 'GET', headers: { Authorization: `Bearer ${request.config.api_key}` } }, request.controls);
  return normalizeObservation(observation, request, true);
}

module.exports = { submitRedrawUnitVideo, queryRedrawUnitVideo };
