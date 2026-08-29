'use strict';

const net = require('node:net');
const {
  normalizeToapisBaseUrl,
  parseToapisTask,
} = require('./toapisVideoClient');

const TOAPIS_WAN3_MODEL = 'wan3.0-video';
const TOAPIS_WAN3_SPEC = Object.freeze({
  aspectRatios: Object.freeze(['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4']),
  durations: Object.freeze(Array.from({ length: 29 }, (_, index) => index + 2)),
  resolutions: Object.freeze(['480p', '720p', '1080p']),
  maxReferences: 10,
  maxVideoReferences: 5,
  maxAudioReferences: 5,
  maxReferenceMediaDurationSeconds: 15,
  supportsFirstFrame: true,
  supportsLastFrame: true,
  supportsImageReference: true,
  supportsVideoReference: true,
  supportsAudioReference: true,
  supportsAudio: true,
});

function uniqueValues(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function isPrivateHost(hostname) {
  const value = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!value || value === 'localhost' || !value.includes('.')) return true;
  if (net.isIPv4(value)) {
    const [a, b] = value.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (net.isIPv6(value)) {
    return value === '::1' || value.startsWith('fc') || value.startsWith('fd')
      || /^fe[89ab]/.test(value) || /^::ffff:(?:10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/.test(value);
  }
  return false;
}

function assertReferenceUrl(value, field) {
  const raw = String(value || '').trim();
  let parsed;
  try { parsed = new URL(raw); } catch (_) {
    throw new Error(`ToAPIs Wan 3.0 ${field} 必须是公网 HTTPS URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || isPrivateHost(parsed.hostname)) {
    throw new Error(`ToAPIs Wan 3.0 ${field} 必须是公网 HTTPS URL`);
  }
  return raw;
}

function validateReferenceDurations(urls, values, field) {
  if (!urls.length) return [];
  if (!Array.isArray(values) || values.length !== urls.length) {
    throw new Error(`ToAPIs Wan 3.0 ${field}必须提供逐项可核验时长`);
  }
  const durations = values.map(Number);
  if (durations.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error(`ToAPIs Wan 3.0 ${field}时长必须是正数`);
  }
  const total = durations.reduce((sum, value) => sum + value, 0);
  if (total > TOAPIS_WAN3_SPEC.maxReferenceMediaDurationSeconds) {
    throw new Error(`ToAPIs Wan 3.0 ${field}总时长最多 15 秒`);
  }
  return durations;
}

function resolveToapisWan3ApiKey(config = {}, explicitApiKey = '') {
  return String(explicitApiKey || '').trim()
    || String(config.api_key || '').trim()
    || String(process.env.TOAPIS_WAN3_API_KEY || '').trim();
}

function validateToapisWan3VideoOptions(opts = {}) {
  const model = String(opts.model || '').trim().toLowerCase();
  if (model !== TOAPIS_WAN3_MODEL) throw new Error(`ToAPIs 模型 ${model || '(empty)'} 未开放，禁止提交`);
  const prompt = String(opts.prompt || '').trim();
  if (!prompt) throw new Error('ToAPIs Wan 3.0 视频提示词不能为空');
  const resolution = String(opts.resolution || '1080p').trim().toLowerCase();
  if (!TOAPIS_WAN3_SPEC.resolutions.includes(resolution)) {
    throw new Error(`ToAPIs Wan 3.0 不支持 ${resolution}；只开放 ${TOAPIS_WAN3_SPEC.resolutions.join('、')}`);
  }
  if (opts.duration == null || String(opts.duration).trim() === '') {
    throw new Error('ToAPIs Wan 3.0 必须显式指定 2 至 30 秒整数时长');
  }
  const duration = Number(opts.duration);
  if (!Number.isSafeInteger(duration) || !TOAPIS_WAN3_SPEC.durations.includes(duration)) {
    throw new Error(`ToAPIs Wan 3.0 不支持 ${duration} 秒；只开放 2 至 30 秒整数时长`);
  }
  const aspectRatio = String(opts.aspect_ratio || opts.ratio || 'adaptive').trim().replace('：', ':');
  if (!TOAPIS_WAN3_SPEC.aspectRatios.includes(aspectRatio)) {
    throw new Error(`ToAPIs Wan 3.0 不支持画幅 ${aspectRatio}`);
  }

  const mapUrls = (values, field) => uniqueValues(values).map((value) => assertReferenceUrl(value, field));
  const images = mapUrls(opts.reference_urls, '参考图');
  const videos = mapUrls(opts.reference_video_urls, '参考视频');
  const audio = mapUrls([
    ...(Array.isArray(opts.reference_audio_urls) ? opts.reference_audio_urls : []),
    opts.voice_reference_url,
  ], '参考音频');
  const firstRaw = String(opts.first_frame_url || opts.image_url || '').trim();
  const lastRaw = String(opts.last_frame_url || '').trim();
  const firstFrame = firstRaw ? assertReferenceUrl(firstRaw, '首帧') : '';
  const lastFrame = lastRaw ? assertReferenceUrl(lastRaw, '尾帧') : '';
  if (images.length > TOAPIS_WAN3_SPEC.maxReferences) throw new Error('ToAPIs Wan 3.0 最多支持 10 张参考图');
  if (videos.length > TOAPIS_WAN3_SPEC.maxVideoReferences) throw new Error('ToAPIs Wan 3.0 最多支持 5 个参考视频');
  if (audio.length > TOAPIS_WAN3_SPEC.maxAudioReferences) throw new Error('ToAPIs Wan 3.0 最多支持 5 个参考音频');
  validateReferenceDurations(videos, opts.reference_video_durations, '参考视频');
  validateReferenceDurations(audio, opts.reference_audio_durations, '参考音频');
  if ((firstFrame || lastFrame) && (images.length || videos.length || audio.length)) {
    throw new Error('ToAPIs Wan 3.0 首尾帧模式与多模态参考模式互斥');
  }
  if (lastFrame && !firstFrame) throw new Error('ToAPIs Wan 3.0 尾帧必须与首帧一起使用');
  return { model, prompt, resolution, duration, aspectRatio, firstFrame, lastFrame, images, videos, audio };
}

function buildToapisWan3VideoBody(opts = {}) {
  const checked = validateToapisWan3VideoOptions(opts);
  const body = {
    model: checked.model,
    prompt: checked.prompt,
    duration: checked.duration,
    ratio: checked.aspectRatio,
    resolution: checked.resolution,
    audio: typeof opts.audio === 'boolean'
      ? opts.audio
      : typeof opts.generate_audio === 'boolean'
        ? opts.generate_audio
        : true,
  };
  if (opts.watermark != null) body.watermark = opts.watermark === true;
  if (opts.seed != null) {
    const seed = Number(opts.seed);
    if (!Number.isSafeInteger(seed)) throw new Error('ToAPIs Wan 3.0 seed 必须是整数');
    body.seed = seed;
  }
  const clientBusinessId = String(opts.client_business_id || '').trim()
    || (Number.isSafeInteger(Number(opts.video_gen_id)) && Number(opts.video_gen_id) > 0
      ? `video-${Number(opts.video_gen_id)}`
      : '');
  if (clientBusinessId) body.client_business_id = clientBusinessId;
  const imageWithRoles = [];
  if (checked.firstFrame) imageWithRoles.push({ url: checked.firstFrame, role: 'first_frame' });
  if (checked.lastFrame) imageWithRoles.push({ url: checked.lastFrame, role: 'last_frame' });
  if (imageWithRoles.length) body.image_with_roles = imageWithRoles;
  if (checked.images.length) body.reference_images = checked.images;
  if (checked.videos.length) body.video_list = checked.videos.map((url) => ({ video_url: url }));
  if (checked.audio.length) body.audio_with_roles = checked.audio.map((url) => ({ url, role: 'reference_audio' }));
  return body;
}

function parseJson(raw) {
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function providerMessage(payload) {
  return String(payload?.error?.message || payload?.error || payload?.message || payload?.detail || '')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, '[redacted]')
    .replace(/(["']?\b(?:api[_-]?key|access_token|token|key)\b["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]+["']?/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url-redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function indeterminateCreateError(message, routeMeta = {}) {
  return {
    indeterminate: true,
    error: `ToAPIs Wan 3.0 创建请求结果未知，供应商可能已受理或扣费但本平台未取得 task_id；为避免重复扣费，不得自动重试。${message || ''}`.trim(),
    route_meta: { phase: 'submit', requestBodySent: true, ...routeMeta },
  };
}

async function callToapisWan3VideoApi(config, log, opts = {}, requestOpts = {}) {
  const apiKey = resolveToapisWan3ApiKey(config, requestOpts.apiKey);
  if (!apiKey) return {
    error: 'ToAPIs API Key 未配置',
    route_meta: { phase: 'validation', requestBodySent: false, providerCode: 'AUTH_INVALID', explicitlyRejected: true },
  };
  let body;
  let baseUrl;
  try {
    body = buildToapisWan3VideoBody(opts);
    baseUrl = normalizeToapisBaseUrl(config?.base_url);
  } catch (error) {
    return {
      error: error.message,
      route_meta: { phase: 'validation', requestBodySent: false, providerCode: 'INVALID_ARGUMENT', explicitlyRejected: true },
    };
  }
  if (!body.client_business_id) return {
    error: 'ToAPIs Wan 3.0 缺少稳定业务 ID，禁止提交以免未知结果无法对账',
    route_meta: { phase: 'validation', requestBodySent: false, providerCode: 'RECOVERY_ID_REQUIRED', explicitlyRejected: true },
  };
  const fetchImpl = requestOpts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return {
    error: 'ToAPIs fetch 不可用',
    route_meta: { phase: 'connect', requestBodySent: false },
  };
  const recoveryTaskId = String(body.client_business_id || '').trim();
  const recoveryMeta = recoveryTaskId ? { recoveryTaskId } : {};
  log?.info?.('[ToAPIs Wan 3.0] 创建任务', {
    video_gen_id: opts.video_gen_id,
    model: body.model,
    duration: body.duration,
    ratio: body.ratio,
    resolution: body.resolution,
    image_reference_count: (body.reference_images?.length || 0) + (body.image_with_roles?.length || 0),
    video_reference_count: body.video_list?.length || 0,
    audio_reference_count: body.audio_with_roles?.length || 0,
  });
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/v1/videos/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return indeterminateCreateError('连接中断。', {
      transportCode: error?.cause?.code || error?.code,
      ...recoveryMeta,
      recoveryCode: 'TOAPIS_WAN3_TRANSPORT_INTERRUPTED',
    });
  }
  let payload;
  try { payload = parseJson(await response.text()); } catch (_) { payload = null; }
  if (!response.ok) {
    if (response.status === 408 || response.status >= 500 || !payload) {
      return indeterminateCreateError(`HTTP ${response.status}${payload ? '。' : ' 返回非 JSON 响应。'}`, {
        httpStatus: response.status,
        ...recoveryMeta,
        recoveryCode: payload ? 'TOAPIS_WAN3_HTTP_STATUS_UNKNOWN' : 'TOAPIS_WAN3_NON_JSON_RESPONSE',
      });
    }
    const message = providerMessage(payload);
    return {
      error: `ToAPIs Wan 3.0 创建视频任务失败 (${response.status})${message ? `: ${message}` : ''}`,
      route_meta: {
        phase: 'submit',
        requestBodySent: true,
        httpStatus: response.status,
        providerCode: String(payload?.error?.code || payload?.code || '').trim() || undefined,
        explicitlyRejected: [400, 401, 413, 422, 429].includes(Number(response.status)),
      },
    };
  }
  if (!payload) return indeterminateCreateError('返回非 JSON 响应。', {
    httpStatus: response.status,
    ...recoveryMeta,
    recoveryCode: 'TOAPIS_WAN3_NON_JSON_RESPONSE',
  });
  const taskId = payload.id ?? payload.task_id ?? payload?.data?.id ?? payload?.data?.task_id;
  if (taskId == null || String(taskId).trim() === '') return indeterminateCreateError('未取得 task_id。', {
    httpStatus: response.status,
    ...recoveryMeta,
    recoveryCode: 'TOAPIS_WAN3_TASK_ID_MISSING',
  });
  return {
    task_id: String(taskId),
    status: String(payload.status || payload?.data?.status || 'processing').toLowerCase(),
    route_meta: { httpStatus: response.status, providerTaskId: String(taskId) },
  };
}

async function fetchToapisWan3Task(config, taskId, opts = {}) {
  const apiKey = resolveToapisWan3ApiKey(config, opts.apiKey);
  if (!apiKey) return { state: 'failed', queryFailed: true, error: 'ToAPIs API Key 未配置' };
  const id = String(taskId || '').trim();
  if (!id) return { state: 'failed', queryFailed: true, error: 'ToAPIs task_id 不能为空' };
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { state: 'failed', queryFailed: true, error: 'ToAPIs fetch 不可用' };
  let baseUrl;
  try {
    baseUrl = normalizeToapisBaseUrl(config?.base_url);
  } catch (error) {
    return { state: 'failed', queryFailed: true, error: error.message };
  }
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/v1/videos/generations/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (_) {
    return { state: 'processing', retryable: true, queryFailed: true, error: 'ToAPIs 查询连接中断，可稍后重试' };
  }
  let payload;
  try { payload = parseJson(await response.text()); } catch (_) { payload = null; }
  if (!payload) {
    return { state: 'processing', retryable: true, queryFailed: true, error: `ToAPIs 查询返回非 JSON 响应 (${response.status || 'unknown'})` };
  }
  if (!response.ok) {
    const message = providerMessage(payload);
    return { state: 'failed', queryFailed: true, error: `ToAPIs 查询任务失败 (${response.status})${message ? `: ${message}` : ''}` };
  }
  const result = parseToapisTask(payload);
  const status = String(payload?.status || payload?.data?.status || '').trim().toLowerCase();
  if (result.state === 'failed' && ['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(status)) {
    return { ...result, terminalFailure: true };
  }
  if (result.state === 'failed' && ['completed', 'succeeded', 'success'].includes(status)) {
    return { ...result, artifactUnreadable: true };
  }
  return result;
}

module.exports = {
  TOAPIS_WAN3_MODEL,
  TOAPIS_WAN3_SPEC,
  buildToapisWan3VideoBody,
  callToapisWan3VideoApi,
  fetchToapisWan3Task,
  resolveToapisWan3ApiKey,
  validateToapisWan3VideoOptions,
};
