'use strict';

const DEFAULT_BASE_URL = 'https://aihubcc.cc/v1';
const ASYNC_IMAGE_MODELS = new Set(['gpt-image-2-2k', 'gpt-image-2-3.5k']);
const FAILED_STATUSES = new Set(['failed', 'failure', 'error', 'cancelled', 'canceled', 'rejected']);
const DONE_STATUSES = new Set(['succeeded', 'success', 'completed', 'complete', 'done']);

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
}

function joinAihubccUrl(configOrBase, endpoint) {
  let base = normalizeBaseUrl(typeof configOrBase === 'object' ? configOrBase.base_url : configOrBase);
  let path = String(endpoint || '').trim();
  if (!path) return base;
  if (!path.startsWith('/')) path = `/${path}`;
  if (/^https?:\/\/aihubcc\.cc$/i.test(base) && !/^\/v1(?:\/|$)/i.test(path)) base += '/v1';
  const baseHasV1 = /\/v1$/i.test(base);
  const pathHasV1 = /^\/v1(?:\/|$)/i.test(path);
  if (baseHasV1 && pathHasV1) path = path.slice(3) || '/';
  return `${base}${path}`.replace(/([^:]\/)\/+/g, '$1');
}

function getSubmitUrl(config, endpoint) {
  return joinAihubccUrl(config, endpoint || config?.endpoint || '/videos');
}

function getQueryUrl(config, taskId, endpoint) {
  const template = endpoint || config?.query_endpoint || '/videos/{taskId}';
  const encoded = encodeURIComponent(String(taskId));
  const path = String(template)
    .replace(/\{taskId\}|\{task_id\}|\{id\}/gi, encoded);
  return joinAihubccUrl(config, path);
}

function getContentUrl(config, taskId) {
  return joinAihubccUrl(config, `/videos/${encodeURIComponent(String(taskId))}/content`);
}

function normalizeAspectRatio(value, fallback = '16:9') {
  const ratio = String(value || fallback).trim();
  return /^\d+:\d+$/.test(ratio) ? ratio : fallback;
}

function aspectRatioFromSize(size) {
  const match = String(size || '').toLowerCase().replace('*', 'x').match(/^(\d+)x(\d+)$/);
  if (!match) return undefined;
  const ratio = Number(match[1]) / Number(match[2]);
  if (Math.abs(ratio - 1) < 0.08) return '1:1';
  if (ratio > 1.35) return '16:9';
  if (ratio < 0.78) return '9:16';
  if (ratio > 1.12) return '4:3';
  return '3:4';
}

function isAsyncImageModel(model) {
  return ASYNC_IMAGE_MODELS.has(String(model || '').trim().toLowerCase());
}

function isFlowImageModel(model) {
  const name = String(model || '').trim().toLowerCase();
  return /^gemini-3\.[01]-(?:pro|flash)-image-/.test(name)
    || /^imagen-4\.0-generate-preview-/.test(name);
}

function isFlowVideoModel(model) {
  return /^veo_3_1_/i.test(String(model || '').trim());
}

function buildFlowImageBody({ model, prompt, referenceUrls = [] } = {}) {
  const refs = referenceUrls.filter(Boolean).slice(0, 6);
  const content = refs.length
    ? [
        { type: 'text', text: prompt || '' },
        ...refs.map((url) => ({ type: 'image_url', image_url: { url } })),
      ]
    : (prompt || '');
  return {
    model: model || 'gemini-3.1-flash-image-landscape',
    stream: false,
    messages: [{ role: 'user', content }],
  };
}

function extractFlowImageUrl(payload, config) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return null;
  const markdown = content.match(/!\[[^\]]*]\((https?:\/\/[^)\s]+|data:image\/[^)\s]+)\)/i);
  if (markdown?.[1]) return normalizeMediaUrl(markdown[1], config);
  const direct = content.match(/https?:\/\/[^\s<>"')]+/i);
  return direct?.[0] ? normalizeMediaUrl(direct[0], config) : null;
}

function buildImageBody({ model, prompt, size, quality, referenceUrls = [] } = {}) {
  const refs = referenceUrls.filter(Boolean).slice(0, 6);
  const body = {
    model: model || 'gpt-image-2',
    prompt: prompt || '',
    ...(size ? { size } : {}),
    ...(quality ? { quality } : {}),
  };
  if (refs.length) {
    body.reference_image_urls = refs;
  }
  if (isAsyncImageModel(model)) {
    const first = refs[0];
    if (first) body.image_url = first;
    delete body.image;
    const ratio = aspectRatioFromSize(size);
    if (ratio) body.aspect_ratio = ratio;
  }
  return body;
}

function buildVideoBody({
  model,
  prompt,
  duration,
  seconds,
  aspect_ratio,
  image_url,
  first_image_url,
  last_image_url,
  first_frame_url,
  last_frame_url,
  reference_urls = [],
  video_url,
} = {}) {
  const name = String(model || '').trim();
  const isOmni = /^omni-fast/i.test(name);
  const isFlow = isFlowVideoModel(name);
  const body = {
    model: name,
    prompt: prompt || '',
    ...(!isFlow ? { aspect_ratio: normalizeAspectRatio(aspect_ratio) } : {}),
  };
  const length = Number(seconds ?? duration);
  if (!isFlow && Number.isFinite(length)) {
    body[isOmni ? 'seconds' : 'duration'] = Math.min(15, Math.max(1, Math.round(length)));
  }
  const first = first_image_url || first_frame_url || image_url;
  const last = last_image_url || last_frame_url;
  if (first) body[isOmni ? 'image_url' : 'first_image_url'] = first;
  if (last) body.last_image_url = last;
  if (video_url) body.video = video_url;
  const refs = reference_urls.filter(Boolean).slice(0, isFlow ? 3 : (isOmni ? 5 : 9));
  if (refs.length) {
    if (isFlow) {
      if (/_r2v_/i.test(name)) body.images = refs;
    } else {
      body.reference_image_urls = refs;
      if (isOmni) body.images = refs;
    }
  }
  return body;
}

function extractTaskId(payload) {
  const data = payload?.data && !Array.isArray(payload.data) ? payload.data : payload;
  const id = payload?.task_id || payload?.id || data?.task_id || data?.id || payload?.task?.id;
  return id == null || String(id).trim() === '' ? null : String(id);
}

function normalizeMediaUrl(value, config) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const url = value.trim();
  if (/^(data:|https?:\/\/)/i.test(url)) return url;
  return joinAihubccUrl(config, url);
}

function extractMediaUrl(payload, config) {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload.data;
  const candidates = [
    payload.video_url,
    payload.image_url,
    payload.url,
    payload.output?.video_url,
    payload.output?.url,
    data && !Array.isArray(data) ? data.video_url : null,
    data && !Array.isArray(data) ? data.image_url : null,
    data && !Array.isArray(data) ? data.url : null,
    Array.isArray(data) ? data[0]?.video_url : null,
    Array.isArray(data) ? data[0]?.image_url : null,
    Array.isArray(data) ? data[0]?.url : null,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeMediaUrl(candidate, config);
    if (normalized) return normalized;
  }
  return null;
}

function extractStatus(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const data = payload.data && !Array.isArray(payload.data) ? payload.data : null;
  return String(
    payload.status || payload.state || payload.task_status || data?.status || data?.state || data?.task_status || ''
  ).trim().toLowerCase();
}

function isFailedStatus(status) { return FAILED_STATUSES.has(String(status || '').toLowerCase()); }
function isDoneStatus(status) { return DONE_STATUSES.has(String(status || '').toLowerCase()); }

function extractError(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const value = payload.error?.message || payload.error || payload.message || payload.msg || payload.data?.message;
  return value ? String(value) : '';
}

function authHeaders(config, json = false) {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    Authorization: `Bearer ${config?.api_key || ''}`,
  };
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || (typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(Number(options.timeoutMs || 600000))
      : undefined),
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : {}; } catch (_) {}
  return { response, raw, data };
}

async function pollTask(config, taskId, { maxAttempts = 180, intervalMs = 5000, log, mediaType = 'media' } = {}) {
  const delay = Number.isFinite(Number(intervalMs)) ? Math.max(0, Number(intervalMs)) : 5000;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const result = await requestJson(getQueryUrl(config, taskId), { headers: authHeaders(config), timeoutMs: 60000 });
    const payload = result.data || {};
    const status = extractStatus(payload);
    const url = extractMediaUrl(payload, config);
    log?.info?.('[AIHubCC poll] 状态', { task_id: taskId, attempt: attempt + 1, status, has_url: !!url });
    if (url) return { [mediaType === 'image' ? 'image_url' : 'video_url']: url };
    if (isFailedStatus(status) || payload.error) return { error: extractError(payload) || `AIHubCC 任务失败: ${status || 'unknown'}` };
    if (isDoneStatus(status)) {
      const content = await requestJson(getContentUrl(config, taskId), { headers: authHeaders(config), timeoutMs: 60000 });
      const contentUrl = extractMediaUrl(content.data || {}, config);
      if (contentUrl) return { [mediaType === 'image' ? 'image_url' : 'video_url']: contentUrl };
      return { error: `AIHubCC 任务完成但未返回${mediaType === 'image' ? '图片' : '视频'}地址` };
    }
  }
  return { indeterminate: true, provider_task_id: String(taskId), error: `AIHubCC 任务 ${taskId} 仍在处理中，请勿重复提交` };
}

module.exports = {
  DEFAULT_BASE_URL,
  ASYNC_IMAGE_MODELS,
  normalizeBaseUrl,
  joinAihubccUrl,
  getSubmitUrl,
  getQueryUrl,
  getContentUrl,
  aspectRatioFromSize,
  isAsyncImageModel,
  isFlowImageModel,
  isFlowVideoModel,
  buildImageBody,
  buildFlowImageBody,
  extractFlowImageUrl,
  buildVideoBody,
  extractTaskId,
  extractMediaUrl,
  extractStatus,
  isFailedStatus,
  isDoneStatus,
  extractError,
  authHeaders,
  requestJson,
  pollTask,
};
