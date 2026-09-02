const VERIFIED_MODELS = Object.freeze([
  'seedance-2.0-fast',
  'seedance-2.0',
  'seedance-2.0-mini',
  'seedance-2.5',
  'minimax_h3_image_audio_to_video_v2',
]);
const VERIFIED_MODEL_SET = new Set(VERIFIED_MODELS);

function normalizeDuration(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(15, Math.max(4, Math.round(number))) : 5;
}

function normalizeRatio(value) {
  const ratio = String(value || '16:9').trim().replace(/：/g, ':');
  return ['16:9', '9:16', '1:1'].includes(ratio) ? ratio : '16:9';
}

function normalizeResolution(value, model) {
  const raw = String(value || '').trim().toLowerCase().replace(/\s/g, '');
  if (model === 'minimax_h3_image_audio_to_video_v2') {
    if (raw === '480' || raw === '480p') throw new Error('minimax_h3_image_audio_to_video_v2 不支持 480p，请使用 768p');
    if (!raw || raw === '720' || raw === '720p') return '768p';
  }
  if (!raw) return '720p';
  if (raw === '480') return '480p';
  if (raw === '720') return '720p';
  return raw;
}

function collectReferences(values, max, pattern) {
  const seen = new Set();
  return values
    .map((value) => String(value || '').trim())
    .filter((value) => pattern.test(value))
    .filter((value) => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    })
    .slice(0, max);
}

function collectImages(opts = {}) {
  return collectReferences([
    opts.first_frame_url,
    opts.last_frame_url,
    opts.image_url,
    ...(Array.isArray(opts.reference_urls) ? opts.reference_urls : []),
  ], 9, /^(?:https?:\/\/|data:image\/)/i);
}

function collectVideos(opts = {}) {
  return collectReferences(opts.reference_video_urls || [], 3, /^https?:\/\//i);
}

function collectAudios(opts = {}) {
  return collectReferences([
    opts.voice_reference_url,
    ...(Array.isArray(opts.reference_audio_urls) ? opts.reference_audio_urls : []),
  ], 3, /^(?:https?:\/\/|data:audio\/)/i);
}

function validateVideoOptions(opts = {}) {
  const model = String(opts.model || '').trim();
  if (!VERIFIED_MODEL_SET.has(model)) throw new Error(`NewAPI 模型 ${model || '(空)'} 尚未通过真实生成验证，禁止提交`);
  normalizeResolution(opts.resolution, model);
  if (model === 'minimax_h3_image_audio_to_video_v2' && !collectImages(opts).length && !collectAudios(opts).length) {
    throw new Error('minimax_h3_image_audio_to_video_v2 至少需要一张参考图或一段参考音频');
  }
}

function buildVideoBody(opts = {}) {
  const model = String(opts.model || '').trim();
  validateVideoOptions(opts);
  const body = {
    model,
    prompt: String(opts.prompt || ''),
    duration: normalizeDuration(opts.duration),
    ratio: normalizeRatio(opts.aspect_ratio),
    resolution: normalizeResolution(opts.resolution, model),
  };
  const images = collectImages(opts);
  const videos = collectVideos(opts);
  const audios = collectAudios(opts);
  if (images.length) body.referenceImages = images;
  if (videos.length) body.referenceVideos = videos;
  if (audios.length) body.referenceAudios = audios;
  return body;
}

function parseSubmitResponse(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload || {};
  const taskId = payload?.task_id ?? payload?.id ?? data.task_id ?? data.id;
  if (taskId == null || String(taskId).trim() === '') return null;
  return { task_id: String(taskId), status: String(payload?.status || payload?.state || data.status || data.state || 'processing') };
}

function httpUrl(value) {
  const raw = String(value || '').trim();
  return /^https?:\/\//i.test(raw) ? raw : null;
}

function parsePollResponse(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload || {};
  const status = String(payload?.status || payload?.state || data.status || data.state || '').trim().toLowerCase();
  const videoUrl = httpUrl(payload?.video_url || payload?.url || payload?.content_url || data.video_url || data.url || data.content_url);
  if (videoUrl) return { state: 'completed', videoUrl };
  if (['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(status)) {
    return { state: 'failed', error: String(payload?.error?.message || payload?.error || data.error?.message || data.error || payload?.message || data.message || status || '任务失败') };
  }
  if (['completed', 'succeeded', 'success', 'done'].includes(status)) return { state: 'completed' };
  return { state: 'processing' };
}

function endpoint(config, fallback) {
  const base = String(config?.base_url || 'https://newapi.megabyai.cc').replace(/\/+$/, '');
  const configured = config?.[fallback === 'query' ? 'query_endpoint' : 'endpoint'];
  let path = String(configured || (fallback === 'query' ? '/v1/videos/{taskId}' : '/v1/videos'));
  if (!path.startsWith('/')) path = '/' + path;
  return { base, path };
}

function replaceTaskId(path, taskId) {
  return path.replace(/\{taskId\}|\{task_id\}|\{id\}/gi, encodeURIComponent(taskId));
}

async function callNewApiVideoApi(config, log, opts = {}) {
  let body;
  try { body = buildVideoBody(opts); } catch (error) { return { error: error.message }; }
  const target = endpoint(config, 'submit');
  const url = target.base + target.path;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  log?.info?.('[NewAPI video] 提交视频任务', { video_gen_id: opts.video_gen_id, model: body.model, url, duration: body.duration, ratio: body.ratio, resolution: body.resolution, reference_images: body.referenceImages?.length || 0, reference_videos: body.referenceVideos?.length || 0, reference_audios: body.referenceAudios?.length || 0 });
  let response;
  try {
    response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (config.api_key || '') }, body: JSON.stringify(body) });
  } catch (error) {
    return { indeterminate: true, error: 'NewAPI 视频请求结果未知，请勿重复提交。', route_meta: { phase: 'submit', requestBodySent: true, transportCode: error?.cause?.code || error?.code } };
  }
  const raw = await response.text();
  let payload;
  try { payload = JSON.parse(raw); } catch (_) { payload = null; }
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || payload?.error || raw || `HTTP ${response.status}`;
    return { error: `NewAPI 创建视频任务失败 (${response.status}): ${String(message).slice(0, 400)}`, route_meta: { phase: 'submit', httpStatus: response.status, providerCode: payload?.error?.code || payload?.code } };
  }
  const result = parseSubmitResponse(payload);
  if (result) return result;
  const directUrl = httpUrl(payload?.video_url || payload?.url || payload?.data?.video_url || payload?.data?.url);
  if (directUrl) return { video_url: directUrl };
  return { error: 'NewAPI 创建成功但未返回任务编号或视频地址' };
}

async function fetchNewApiTask(config, taskId, { fetchImpl = globalThis.fetch } = {}) {
  const target = endpoint(config, 'query');
  const url = target.base + replaceTaskId(target.path, taskId);
  const response = await fetchImpl(url, { method: 'GET', headers: { Authorization: 'Bearer ' + (config.api_key || '') } });
  const raw = await response.text();
  if (!response.ok) return { state: 'processing' };
  let payload;
  try { payload = JSON.parse(raw); } catch (_) { payload = null; }
  const result = parsePollResponse(payload);
  if (result.state !== 'completed' || result.videoUrl) return result;
  const contentUrl = target.base + replaceTaskId(target.path, taskId).replace(/\/+$/, '') + '/content';
  const content = await fetchImpl(contentUrl, { method: 'GET', headers: { Authorization: 'Bearer ' + (config.api_key || '') } });
  if (!content.ok) return { state: 'completed' };
  const location = httpUrl(content.headers?.get?.('location')) || (!String(content.headers?.get?.('content-type') || '').includes('json') ? httpUrl(content.url) : null);
  if (location) return { state: 'completed', videoUrl: location };
  let contentPayload;
  try { contentPayload = JSON.parse(await content.text()); } catch (_) { contentPayload = null; }
  return parsePollResponse(contentPayload);
}

module.exports = {
  VERIFIED_MODELS,
  buildVideoBody,
  validateVideoOptions,
  parseSubmitResponse,
  parsePollResponse,
  callNewApiVideoApi,
  fetchNewApiTask,
};
