'use strict';

const providerAssetUrl = require('./providerAssetUrlService');

const IMAGE_REFERENCE_LIMITS = Object.freeze({
  'doubao-seedream-5-0': 3,
  'gpt-image-2': 9,
  'token6688-gpt-image-2': 9,
  'gemini-3-pro-image': 3,
});

const IMAGE_MODEL_ALIASES = Object.freeze({
  'token6688-gpt-image-2': 'gpt-image-2',
});

const VIDEO_TIER_QUALITY = Object.freeze({
  'seedance-2-0-special-mini-720p': '标准',
  'seedance-2-0-special-fast-720p': '快速',
  'seedance-2-0-special-full-720p': '高清',
});

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || 'https://qd.token6688.com').trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function normalizeImageModel(model) {
  const value = String(model || '').trim();
  return IMAGE_MODEL_ALIASES[value] || value;
}

function parsePixelSize(size) {
  const match = String(size || '').trim().toLowerCase().replace(/\*/g, 'x').match(/^(\d+)x(\d+)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

function closestAspectRatio(size, allowed) {
  const raw = String(size || '').trim();
  if (allowed.includes(raw)) return raw;
  const pixels = parsePixelSize(raw);
  if (!pixels) return allowed.includes('1:1') ? '1:1' : allowed[0];
  const ratio = pixels.width / pixels.height;
  return allowed.reduce((best, label) => {
    const [width, height] = label.split(':').map(Number);
    const distance = Math.abs(Math.log(ratio) - Math.log(width / height));
    return distance < best.distance ? { label, distance } : best;
  }, { label: allowed[0], distance: Infinity }).label;
}

function token6688GptImageSize(size) {
  const raw = String(size || '').trim().toLowerCase().replace(/\*/g, 'x');
  const allowed = [
    '1024x1024', '2048x2048', '1536x1024', '1024x1536', '1280x960', '960x1280',
    '2048x1152', '1152x2048', '3840x2160', '2160x3840',
  ];
  if (allowed.includes(raw)) return raw;
  const pixels = parsePixelSize(raw);
  if (!pixels) return '1024x1024';
  const targetRatio = pixels.width / pixels.height;
  const targetArea = pixels.width * pixels.height;
  return allowed.reduce((best, candidate) => {
    const candidatePixels = parsePixelSize(candidate);
    const ratioDistance = Math.abs(Math.log(targetRatio / (candidatePixels.width / candidatePixels.height)));
    const areaDistance = Math.abs(Math.log(targetArea / (candidatePixels.width * candidatePixels.height)));
    const score = (ratioDistance * 4) + areaDistance;
    return score < best.score ? { value: candidate, score } : best;
  }, { value: '1024x1024', score: Infinity }).value;
}

function token6688GeminiImageSize(size) {
  const pixels = parsePixelSize(size);
  const longEdge = pixels ? Math.max(pixels.width, pixels.height) : 0;
  if (longEdge >= 3000) return '4K';
  if (longEdge >= 1536) return '2K';
  return '1K';
}

function buildImageBody({ model, prompt, size, quality, images = [] }) {
  const requestedModel = String(model || '').trim();
  const normalizedModel = normalizeImageModel(requestedModel);
  const references = [...new Set(images.map((value) => String(value || '').trim()).filter(Boolean))];
  const limit = IMAGE_REFERENCE_LIMITS[requestedModel] || IMAGE_REFERENCE_LIMITS[normalizedModel];
  if (!limit) throw new Error(`Token6688 未声明图片模型 ${requestedModel}`);
  if (references.length > limit) throw new Error(`${normalizedModel} 最多支持 ${limit} 个图片参考`);

  const body = {
    model: normalizedModel,
    prompt: String(prompt || ''),
    n: 1,
    response_format: 'url',
    mode: references.length ? 'multi-reference' : 'text-to-image',
  };
  if (normalizedModel === 'doubao-seedream-5-0') {
    body.size = closestAspectRatio(size, ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9']);
  } else if (normalizedModel === 'gemini-3-pro-image') {
    body.size = token6688GeminiImageSize(size);
    body.aspect_ratio = closestAspectRatio(size, ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);
  } else {
    body.size = token6688GptImageSize(size);
    if (quality) body.quality = quality;
  }
  if (references.length) body.images = references;
  return body;
}

function publicMediaUrl(value, filesBaseUrl) {
  const raw = String(value || '').trim();
  if (!raw || /^https?:\/\//i.test(raw) || /^data:/i.test(raw)) return raw;
  const base = String(filesBaseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return raw;
  if (/\/static$/i.test(base) && /^\/?static\//i.test(raw)) {
    return `${base}/${raw.replace(/^\/?static\//i, '')}`;
  }
  return `${base}/${raw.replace(/^\/+/, '')}`;
}

function publicMediaUrls(values, filesBaseUrl) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => publicMediaUrl(value, filesBaseUrl))
    .filter(Boolean))];
}

function providerMediaUrls(values, filesBaseUrl) {
  return publicMediaUrls(values, filesBaseUrl).map((value) => providerAssetUrl.signProviderAssetUrl(value, {
    filesBaseUrl,
  }));
}

async function requestJson(url, apiKey, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey || ''}`,
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch (_) {}
  return { response, raw, data };
}

function errorMessage(data, raw, fallback) {
  const message = data?.error?.message || data?.detail || data?.message || data?.error;
  return String(message || raw || fallback).slice(0, 500);
}

async function callImageApi(config, log, opts = {}) {
  let body;
  try {
    body = buildImageBody({
      model: opts.model,
      prompt: opts.prompt,
      size: opts.size,
      quality: opts.quality,
      images: providerMediaUrls(opts.reference_image_urls, opts.files_base_url),
    });
  } catch (error) {
    return { error: error.message };
  }
  const url = `${normalizeBaseUrl(config.base_url)}/v1/images/generations`;
  log?.info?.('[Token6688 image] 提交', {
    image_gen_id: opts.image_gen_id,
    model: body.model,
    mode: body.mode,
    reference_count: body.images?.length || 0,
  });
  try {
    const { response, raw, data } = await requestJson(url, config.api_key, body);
    if (!response.ok) return { error: `Token6688 图片生成失败 (${response.status}): ${errorMessage(data, raw, '请求失败')}` };
    const item = Array.isArray(data?.data) ? data.data[0] : null;
    const imageUrl = item?.url || item?.image_url || data?.image_url || data?.result?.url;
    if (imageUrl) return { image_url: imageUrl };
    return { error: 'Token6688 图片创建成功但未返回图片地址（结果未知）。请先核对供应商记录，不要连续重试。' };
  } catch (error) {
    return { error: `Token6688 图片连接中断，供应商可能已受理或扣费（结果未知），请勿连续重试: ${error.message}` };
  }
}

function buildVideoBody({ model, prompt, aspect_ratio, mode, images = [], videos = [], audios = [] }) {
  const alias = String(model || '').trim();
  const quality = VIDEO_TIER_QUALITY[alias];
  if (!quality) throw new Error(`Token6688 未声明视频档位 ${alias}`);
  const imageRefs = [...new Set(images.map(String).map((value) => value.trim()).filter(Boolean))];
  const videoRefs = [...new Set(videos.map(String).map((value) => value.trim()).filter(Boolean))];
  const audioRefs = [...new Set(audios.map(String).map((value) => value.trim()).filter(Boolean))];
  if (imageRefs.length > 9) throw new Error('Seedance 2.0 · 特价按次最多支持 9 个图片参考');
  if (videoRefs.length > 3) throw new Error('Seedance 2.0 · 特价按次最多支持 3 个视频参考');
  if (audioRefs.length > 9) throw new Error('Seedance 2.0 · 特价按次最多支持 9 个音频参考');
  const hasReferences = imageRefs.length || videoRefs.length || audioRefs.length;
  const requestedMode = String(mode || '').trim();
  const allowedModes = new Set(['reference', 'first-frame', 'first-last', 'text-to-video']);
  if (requestedMode && !allowedModes.has(requestedMode)) throw new Error(`Token6688 不支持视频模式 ${requestedMode}`);
  const body = {
    model: 'seedance-2-0-special',
    prompt: String(prompt || ''),
    duration: '15',
    aspect_ratio: String(aspect_ratio || '16:9'),
    resolution: '720p',
    quality,
    mode: requestedMode || (hasReferences ? 'reference' : 'text-to-video'),
    n: 1,
  };
  if (imageRefs.length) body.images = imageRefs;
  if (videoRefs.length) body.videos = videoRefs;
  if (audioRefs.length) body.audios = audioRefs;
  return body;
}

async function callVideoApi(config, log, opts = {}) {
  const hasFirstFrame = Boolean(String(opts.first_frame_url || opts.image_url || '').trim());
  const hasLastFrame = Boolean(String(opts.last_frame_url || '').trim());
  const mode = hasFirstFrame && hasLastFrame
    ? 'first-last'
    : (hasFirstFrame ? 'first-frame' : undefined);
  let images;
  let videos;
  let audios;
  let body;
  try {
    images = providerMediaUrls([
      opts.first_frame_url,
      opts.last_frame_url,
      opts.image_url,
      ...(Array.isArray(opts.reference_urls) ? opts.reference_urls : []),
    ], opts.files_base_url);
    videos = providerMediaUrls(opts.reference_video_urls, opts.files_base_url);
    audios = providerMediaUrls(opts.reference_audio_urls, opts.files_base_url);
    body = buildVideoBody({
      model: opts.model,
      prompt: opts.prompt,
      aspect_ratio: opts.aspect_ratio,
      mode,
      images,
      videos,
      audios,
    });
  } catch (error) {
    return { error: error.message };
  }
  const url = `${normalizeBaseUrl(config.base_url)}/v1/videos/generations`;
  log?.info?.('[Token6688 video] 提交', {
    video_gen_id: opts.video_gen_id,
    tier_model: opts.model,
    quality: body.quality,
    image_references: images.length,
    video_references: videos.length,
    audio_references: audios.length,
  });
  try {
    const { response, raw, data } = await requestJson(url, config.api_key, body);
    if (!response.ok) return { error: `Token6688 视频创建失败 (${response.status}): ${errorMessage(data, raw, '请求失败')}` };
    const directUrl = data?.video_url || data?.result_url || data?.result?.url
      || data?.result?.videos?.find((item) => /^https?:\/\//i.test(String(item?.url || '')))?.url;
    if (directUrl) return { video_url: directUrl };
    const taskId = data?.task_id || data?.id || data?.data?.task_id || data?.data?.id;
    if (taskId) return { task_id: String(taskId), status: data?.status || data?.state || 'pending' };
    return { error: 'Token6688 视频创建成功但未返回任务编号（结果未知）。请先核对供应商记录，不要连续重试。' };
  } catch (error) {
    return { error: `Token6688 视频连接中断，供应商可能已受理或扣费（结果未知），请勿连续重试: ${error.message}` };
  }
}

module.exports = {
  IMAGE_REFERENCE_LIMITS,
  IMAGE_MODEL_ALIASES,
  VIDEO_TIER_QUALITY,
  normalizeBaseUrl,
  normalizeImageModel,
  buildImageBody,
  buildVideoBody,
  callImageApi,
  callVideoApi,
};
