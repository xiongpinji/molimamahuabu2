'use strict';

const FUMIN_MODELS = Object.freeze({
  'fumin-seedance-2.0-fast': 'seedance-2.0-fast',
  'fumin-seedance-2.0-mini': 'seedance-2.0-mini',
});

const VERIFIED_UPSTREAM_MODELS = new Set(Object.values(FUMIN_MODELS));

const FUMIN_VIDEO_LIMITS = Object.freeze({
  minDuration: 5,
  maxDuration: 15,
  maxImageReferences: 9,
  maxVideoReferences: 3,
  maxAudioReferences: 3,
});

function normalizeFuminBaseUrl(value) {
  return String(value || 'https://fumin.ai').trim().replace(/\/+$/, '').replace(/\/api\/v3$/i, '');
}

function resolveFuminModel(model) {
  const value = String(model || '').trim();
  return FUMIN_MODELS[value] || value;
}

function buildFuminUrl(config = {}, fallbackPath, taskId) {
  const base = normalizeFuminBaseUrl(config.base_url);
  let endpoint = taskId == null
    ? (config.endpoint || fallbackPath)
    : (config.query_endpoint || fallbackPath.replace('{taskId}', encodeURIComponent(String(taskId))));
  endpoint = String(endpoint || '').trim();
  if (!endpoint.startsWith('/')) endpoint = '/' + endpoint;
  if (/\/api\/v3$/i.test(base) && endpoint.toLowerCase().startsWith('/api/v3/')) {
    endpoint = endpoint.slice('/api/v3'.length);
  }
  if (!endpoint.toLowerCase().startsWith('/api/v3/') && /^\/contents\/generations\/tasks(?:\/|$)/i.test(endpoint)) {
    endpoint = '/api/v3' + endpoint;
  }
  endpoint = endpoint.replace(/\{taskId\}|\{task_id\}|\{id\}/gi, encodeURIComponent(String(taskId || '')));
  return base + endpoint;
}

function buildFuminCreateUrl(config = {}) {
  return buildFuminUrl(config, '/api/v3/contents/generations/tasks');
}

function buildFuminQueryUrl(config = {}, taskId) {
  return buildFuminUrl(config, '/api/v3/contents/generations/tasks/{taskId}', taskId);
}

function uniqueUrls(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function normalizedReferenceUrls(value) {
  return uniqueUrls(Array.isArray(value) ? value : []);
}

function buildFuminVideoBody(opts = {}) {
  const model = resolveFuminModel(opts.model);
  if (!VERIFIED_UPSTREAM_MODELS.has(model)) {
    throw new Error(`fumin 模型 ${model || '(empty)'} 未经真实生成验证，禁止提交`);
  }
  const duration = opts.duration == null || opts.duration === '' ? 5 : Number(opts.duration);
  if (!Number.isSafeInteger(duration) || duration < FUMIN_VIDEO_LIMITS.minDuration || duration > FUMIN_VIDEO_LIMITS.maxDuration) {
    throw new Error(`fumin 视频时长必须是 ${FUMIN_VIDEO_LIMITS.minDuration} 到 ${FUMIN_VIDEO_LIMITS.maxDuration} 秒之间的整数`);
  }
  const ratio = String(opts.aspect_ratio || '16:9').replace('：', ':');
  if (ratio !== '16:9') throw new Error('fumin 当前仅开放已实测的 16:9 比例');
  const resolution = opts.resolution ? String(opts.resolution).trim().toLowerCase() : '480p';
  if (resolution !== '480p') throw new Error('fumin 720P 尚未完成额度充足下的真实验证，暂不开放');
  const imageRefs = uniqueUrls([
    opts.image_url,
    opts.first_frame_url,
    opts.last_frame_url,
    ...(Array.isArray(opts.reference_urls) ? opts.reference_urls : []),
  ]);
  const videoRefs = normalizedReferenceUrls(opts.reference_video_urls);
  const audioRefs = normalizedReferenceUrls(opts.reference_audio_urls);
  if (imageRefs.length > FUMIN_VIDEO_LIMITS.maxImageReferences) {
    throw new Error(`fumin 参考图最多支持 ${FUMIN_VIDEO_LIMITS.maxImageReferences} 张`);
  }
  if (videoRefs.length > FUMIN_VIDEO_LIMITS.maxVideoReferences) {
    throw new Error(`fumin 视频参考最多支持 ${FUMIN_VIDEO_LIMITS.maxVideoReferences} 个视频`);
  }
  if (audioRefs.length > FUMIN_VIDEO_LIMITS.maxAudioReferences) {
    throw new Error(`fumin 音频参考最多支持 ${FUMIN_VIDEO_LIMITS.maxAudioReferences} 个音频`);
  }
  const body = {
    model,
    content: [{ type: 'text', text: String(opts.prompt || '').trim() }],
    ratio,
    duration,
    watermark: opts.watermark != null ? Boolean(opts.watermark) : false,
  };
  body.resolution = resolution;
  if (opts.seed != null) body.seed = Number(opts.seed);
  if (opts.guidance_scale != null) body.guidance_scale = Number(opts.guidance_scale);
  for (const url of imageRefs) body.content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' });
  for (const url of videoRefs) body.content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' });
  for (const url of audioRefs) body.content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' });
  return body;
}

function parseJson(raw) {
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function pickFuminVideoUrl(payload) {
  const candidates = [
    payload?.content?.video_url,
    payload?.data?.content?.video_url,
    payload?.video_url,
    payload?.data?.video_url,
    payload?.content?.video?.url,
    payload?.data?.content?.video?.url,
  ];
  return candidates.find((value) => /^https?:\/\//i.test(String(value || '').trim())) || null;
}

function parseFuminSubmitResponse(payload) {
  const videoUrl = pickFuminVideoUrl(payload);
  if (videoUrl) return { video_url: videoUrl };
  const taskId = payload?.id ?? payload?.task_id ?? payload?.data?.id ?? payload?.data?.task_id;
  if (taskId != null && String(taskId).trim()) {
    return { task_id: String(taskId), status: String(payload?.status || payload?.data?.status || 'queued').toLowerCase() };
  }
  const message = payload?.error?.message || payload?.message || payload?.error;
  return { error: String(message || 'fumin 创建成功但未返回 task_id 或 video_url').slice(0, 500) };
}

function parseFuminStatusPayload(payload) {
  const videoUrl = pickFuminVideoUrl(payload);
  if (videoUrl) return { state: 'completed', videoUrl };
  const status = String(payload?.status || payload?.state || payload?.data?.status || payload?.data?.state || '').trim().toLowerCase();
  const message = payload?.error?.message || payload?.message || payload?.error;
  if (['failed', 'error', 'cancelled', 'canceled'].includes(status) || message) {
    return { state: 'failed', error: String(message || `fumin 任务失败: ${status || 'unknown'}`).slice(0, 500) };
  }
  if (['succeeded', 'success', 'completed', 'done'].includes(status)) {
    return { state: 'failed', error: 'fumin 任务已完成但未返回视频地址' };
  }
  return { state: 'processing' };
}

async function callFuminVideoApi(config, log, opts = {}) {
  if (!String(config?.api_key || '').trim()) return { error: 'fumin API Key 未配置' };
  let imageUrls = [];
  const rawRefs = uniqueUrls([
    opts.image_url,
    opts.first_frame_url,
    opts.last_frame_url,
    ...(Array.isArray(opts.reference_urls) ? opts.reference_urls : []),
  ]);
  try {
    for (let index = 0; index < rawRefs.length; index += 1) {
      const resolved = typeof opts.resolve_image === 'function'
        ? await opts.resolve_image(rawRefs[index], index)
        : rawRefs[index];
      if (resolved) imageUrls.push(resolved);
    }
  } catch (error) {
    return { error: `fumin 参考图准备失败: ${error.message}` };
  }
  const resolveMedia = async (value, index, kind) => {
    if (kind === 'image' && typeof opts.resolve_image === 'function') {
      return opts.resolve_image(value, index);
    }
    return value;
  };
  let videoUrls = [];
  let audioUrls = [];
  try {
    const rawVideos = normalizedReferenceUrls(opts.reference_video_urls);
    for (let index = 0; index < rawVideos.length; index += 1) {
      const resolved = await resolveMedia(rawVideos[index], index, 'video');
      if (resolved) videoUrls.push(resolved);
    }
    const rawAudios = normalizedReferenceUrls(opts.reference_audio_urls);
    for (let index = 0; index < rawAudios.length; index += 1) {
      const resolved = await resolveMedia(rawAudios[index], index, 'audio');
      if (resolved) audioUrls.push(resolved);
    }
  } catch (error) {
    return { error: `fumin 参考视频或音频准备失败: ${error.message}` };
  }
  let body;
  try {
    body = buildFuminVideoBody({
      ...opts,
      image_url: '',
      first_frame_url: '',
      last_frame_url: '',
      reference_urls: imageUrls,
      reference_video_urls: videoUrls,
      reference_audio_urls: audioUrls,
    });
  } catch (error) {
    return { error: error.message };
  }
  const url = buildFuminCreateUrl(config);
  log?.info?.('[fumin 视频] 创建任务', {
    video_gen_id: opts.video_gen_id,
    model: body.model,
    duration: body.duration,
    resolution: body.resolution || null,
    ratio: body.ratio,
    reference_image_count: imageUrls.length,
    reference_video_count: videoUrls.length,
    reference_audio_count: audioUrls.length,
  });
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return {
      indeterminate: true,
      error: `fumin 创建请求连接中断，供应商可能已受理或扣费但本平台未取得 task_id，结果未知；为避免重复扣费，不得自动重试。原始错误: ${error.message}`,
    };
  }
  const raw = await response.text();
  const payload = parseJson(raw);
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || payload?.error || raw || `HTTP ${response.status}`;
    return { error: `fumin 创建视频任务失败 (${response.status}): ${String(message).slice(0, 500)}` };
  }
  if (!payload) return { error: 'fumin 创建视频任务返回非 JSON 响应' };
  return parseFuminSubmitResponse(payload);
}

module.exports = {
  FUMIN_MODELS,
  FUMIN_VIDEO_LIMITS,
  normalizeFuminBaseUrl,
  resolveFuminModel,
  buildFuminCreateUrl,
  buildFuminQueryUrl,
  buildFuminVideoBody,
  parseFuminSubmitResponse,
  parseFuminStatusPayload,
  callFuminVideoApi,
};
