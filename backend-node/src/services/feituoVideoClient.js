const FEITUO_MODELS = Object.freeze({
  'xuan-video-v1-6e7b4763634e6206': Object.freeze({
    resolutions: Object.freeze(['2k']),
    durations: Object.freeze([15]),
    ratios: Object.freeze(['1:1', '16:9', '9:16', '3:4', '4:3', '21:9']),
    maxImages: 9,
    maxVideos: 0,
    maxAudio: 3,
  }),
  'xuan-seedance-2.5': Object.freeze({
    resolutions: Object.freeze(['480p', '720p']),
    durations: Object.freeze(Array.from({ length: 27 }, (_, index) => index + 4)),
    ratios: Object.freeze(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']),
    maxImages: 30,
    maxVideos: 10,
    maxAudio: 10,
  }),
  'sdas-lm-hailuo-h3-2k': Object.freeze({
    ratios: Object.freeze(['1:1', '16:9', '9:16', '3:4', '4:3', '21:9']),
    maxImages: 9,
    maxVideos: 0,
    maxAudio: 3,
  }),
  'sdas-my-seedance-2.0-fast-upscaled-1080p': Object.freeze({
    ratios: Object.freeze(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']),
    maxImages: 4,
    maxVideos: 3,
    maxAudio: 1,
  }),
});
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_RESPONSE_MAX_BYTES = 1024 * 1024;
const MAX_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;

function boundedPositiveInteger(value, fallback, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

function indeterminateTransportError(message) {
  return Object.assign(new Error(message), {
    code: 'FEITUO_STATUS_UNKNOWN',
    indeterminate: true,
  });
}

async function readBoundedResponseText(response, maxBytes, controller) {
  const declaredLength = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    controller.abort();
    throw indeterminateTransportError(`飞拓响应体超过 ${maxBytes} 字节上限`);
  }
  if (!response?.body || typeof response.body.getReader !== 'function') {
    const raw = await response.text();
    if (Buffer.byteLength(raw) > maxBytes) {
      controller.abort();
      throw indeterminateTransportError(`飞拓响应体超过 ${maxBytes} 字节上限`);
    }
    return raw;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) {
      controller.abort();
      try { await reader.cancel(); } catch (_) {}
      throw indeterminateTransportError(`飞拓响应体超过 ${maxBytes} 字节上限`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total).toString();
}

async function fetchFeituoText(url, fetchOptions = {}, controls = {}) {
  const timeoutMs = boundedPositiveInteger(
    controls.requestTimeoutMs ?? controls.request_timeout_ms,
    DEFAULT_REQUEST_TIMEOUT_MS,
    MAX_REQUEST_TIMEOUT_MS,
  );
  const maxBytes = boundedPositiveInteger(
    controls.responseMaxBytes ?? controls.response_max_bytes,
    DEFAULT_RESPONSE_MAX_BYTES,
    MAX_RESPONSE_MAX_BYTES,
  );
  const controller = new AbortController();
  let timedOut = false;
  let timer;
  const fetchImpl = controls.fetchImpl || fetch;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const error = indeterminateTransportError(`飞拓 HTTP 请求在 ${timeoutMs}ms 后超时`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetchImpl(url, { ...fetchOptions, signal: controller.signal }),
      timeout,
    ]);
    const raw = await Promise.race([
      readBoundedResponseText(response, maxBytes, controller),
      timeout,
    ]);
    return { response, raw };
  } catch (error) {
    if (timedOut && error?.code !== 'FEITUO_STATUS_UNKNOWN') {
      throw indeterminateTransportError(`飞拓 HTTP 请求在 ${timeoutMs}ms 后超时`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeFeituoBaseUrl(value) {
  return String(value || 'https://feituokuajing.com')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api\/open\/v1\/video\/(?:generate|status)$/i, '');
}

function uniqueValues(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function assertMaterialLimit(label, values, max) {
  if (values.length > max) throw new Error(`该飞拓模型最多支持 ${max} 个${label}素材`);
}

function buildFeituoVideoBody(opts = {}) {
  const model = String(opts.model || '').trim();
  const spec = FEITUO_MODELS[model];
  if (!spec) throw new Error(`飞拓模型 ${model || '(empty)'} 未经真实生成验证，禁止提交`);

  const duration = Number(opts.duration ?? 5);
  if (!Number.isSafeInteger(duration)) {
    throw new Error('飞拓视频时长必须是整数');
  }
  if (spec.durations && !spec.durations.includes(duration)) {
    throw new Error(`飞拓模型 ${model} 不支持 ${duration} 秒`);
  }
  if (!spec.durations && (duration < 4 || duration > 15)) {
    throw new Error('飞拓视频时长必须是 4 到 15 秒之间的整数');
  }
  const resolution = String(opts.resolution || '').trim().toLowerCase();
  if (spec.resolutions && !spec.resolutions.includes(resolution)) {
    throw new Error(`飞拓模型 ${model} 不支持分辨率 ${resolution || '(empty)'}`);
  }
  const ratio = String(opts.aspect_ratio || opts.ratio || '16:9').trim().replace('：', ':');
  if (!spec.ratios.includes(ratio)) throw new Error(`飞拓模型 ${model} 不支持画幅 ${ratio}`);

  const imageUrls = uniqueValues([
    opts.image_url,
    opts.first_frame_url,
    opts.last_frame_url,
    ...(Array.isArray(opts.reference_urls) ? opts.reference_urls : []),
  ]);
  const videoUrls = uniqueValues(Array.isArray(opts.reference_video_urls) ? opts.reference_video_urls : []);
  const audioUrls = uniqueValues([
    ...(Array.isArray(opts.reference_audio_urls) ? opts.reference_audio_urls : []),
    opts.voice_reference_url,
  ]);
  assertMaterialLimit('图片', imageUrls, spec.maxImages);
  assertMaterialLimit('视频', videoUrls, spec.maxVideos);
  assertMaterialLimit('音频', audioUrls, spec.maxAudio);

  const body = {
    model,
    prompt: String(opts.prompt || ''),
    ratio,
    duration,
    imageUrls,
    videoUrls,
    audioUrls,
  };
  if (spec.resolutions) body.resolution = resolution;
  return body;
}

function buildFeituoStatusUrl(baseUrl, jobId, timestamp = Date.now()) {
  return `${normalizeFeituoBaseUrl(baseUrl)}/api/open/v1/video/status?jobId=${encodeURIComponent(jobId)}&_=${timestamp}`;
}

function flattenPayload(payload) {
  if (payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
    return { ...payload, ...payload.data };
  }
  return payload || {};
}

function parseFeituoStatusPayload(payload) {
  const data = flattenPayload(payload);
  const status = String(data.status || data.state || '').trim().toLowerCase();
  const videoUrl = String(data.remoteVideoUrl || data.remote_video_url || data.videoUrl || data.video_url || '').trim();
  if (videoUrl) return { state: 'completed', videoUrl };
  if (['success', 'succeeded', 'completed', 'done'].includes(status)) {
    return { state: 'failed', error: '飞拓任务完成但未返回视频地址' };
  }
  if (data.success === false || ['failed', 'error', 'cancelled', 'canceled', 'not_found'].includes(status)) {
    const error = data.errorMessage || data.error_message || data.message || data.error || status || '飞拓视频生成失败';
    return { state: 'failed', error: String(error).slice(0, 500) };
  }
  return { state: 'processing' };
}

function parseJson(raw) {
  try { return JSON.parse(raw); } catch (_) { return null; }
}

async function callFeituoVideoApi(config, log, opts = {}, runtime = {}) {
  let body;
  try {
    body = buildFeituoVideoBody(opts);
  } catch (error) {
    return { error: error.message };
  }
  const url = `${normalizeFeituoBaseUrl(config?.base_url)}/api/open/v1/video/generate`;
  log?.info?.('[飞拓视频] 创建任务', {
    video_gen_id: opts.video_gen_id,
    model: body.model,
    duration: body.duration,
    ratio: body.ratio,
    image_count: body.imageUrls.length,
    video_count: body.videoUrls.length,
    audio_count: body.audioUrls.length,
  });
  const indeterminate = (detail) => ({
    indeterminate: true,
    error: `飞拓创建请求结果未知，供应商可能已受理或扣费但本平台未取得 jobId；为避免重复扣费，不得自动重试。${detail ? `原始错误: ${detail}` : ''}`,
  });
  let response;
  let raw;
  try {
    const fetched = await fetchFeituoText(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config?.api_key || ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, {
      requestTimeoutMs: opts.request_timeout_ms,
      responseMaxBytes: opts.response_max_bytes,
      fetchImpl: runtime.fetchImpl,
    });
    response = fetched.response;
    raw = fetched.raw;
  } catch (error) {
    return indeterminate(error.message);
  }
  const payload = parseJson(raw);
  if (!response.ok) {
    const message = payload?.errorMessage || payload?.message || payload?.error || raw || `HTTP ${response.status}`;
    if (Number(response.status) >= 500) return indeterminate(`HTTP ${response.status}: ${String(message).slice(0, 300)}`);
    return { error: `飞拓创建视频任务失败 (${response.status}): ${String(message).slice(0, 300)}` };
  }
  if (!payload) return indeterminate('供应商返回非 JSON 响应');

  const data = flattenPayload(payload);
  const direct = parseFeituoStatusPayload(payload);
  if (direct.state === 'completed') return { video_url: direct.videoUrl };
  if (direct.state === 'failed') return { error: direct.error || '飞拓创建视频任务失败' };
  const jobId = data.jobId ?? data.job_id;
  if (jobId == null || String(jobId).trim() === '') {
    return indeterminate('供应商响应未包含 jobId');
  }
  log?.info?.('[飞拓视频] 任务已受理', {
    video_gen_id: opts.video_gen_id,
    job_id: String(jobId),
    provider_task_id: data.taskId || data.task_id || null,
  });
  return { task_id: String(jobId), status: String(data.status || 'submitted').toLowerCase() };
}

module.exports = {
  FEITUO_MODELS,
  normalizeFeituoBaseUrl,
  buildFeituoVideoBody,
  buildFeituoStatusUrl,
  parseFeituoStatusPayload,
  fetchFeituoText,
  callFeituoVideoApi,
};
