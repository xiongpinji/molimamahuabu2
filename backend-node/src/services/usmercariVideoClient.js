const fs = require('fs');
const path = require('path');
let sharp; try { sharp = require('sharp'); } catch (_) { sharp = null; }

const USMERCARI_VIDEO_DURATIONS = Object.freeze(
  Array.from({ length: 12 }, (_, index) => index + 4),
);
const MINIMAX_H3_DURATIONS = Object.freeze(
  Array.from({ length: 11 }, (_, index) => index + 5),
);
const USMERCARI_MODELS = Object.freeze({
  'MiniMax H3': Object.freeze({
    maxImages: 3, maxVideos: 0, maxAudio: 3,
    resolutions: Object.freeze(['1440p']), durations: MINIMAX_H3_DURATIONS,
  }),
  'seedance-2.0-fast': Object.freeze({
    maxImages: 9, maxVideos: 3, maxAudio: 3,
    resolutions: Object.freeze(['480p', '720p']), durations: USMERCARI_VIDEO_DURATIONS,
  }),
  'seedance-2.0-mini': Object.freeze({
    maxImages: 9, maxVideos: 3, maxAudio: 3,
    resolutions: Object.freeze(['480p', '720p']), durations: USMERCARI_VIDEO_DURATIONS,
  }),
});

const DEFAULT_EXTENSION = Object.freeze({ image: 'png', audio: 'mp3', video: 'mp4' });
const DEFAULT_MIME = Object.freeze({ image: 'image/png', audio: 'audio/mpeg', video: 'video/mp4' });
const MAX_MEDIA_BYTES = Object.freeze({ image: 25 * 1024 * 1024, audio: 75 * 1024 * 1024, video: 250 * 1024 * 1024 });
const MAX_IMAGE_SOURCE_BYTES = 100 * 1024 * 1024;
const IMAGE_UPLOAD_TARGET_BYTES = 24 * 1024 * 1024;
const MEDIA_UPLOAD_MAX_ATTEMPTS = 2;
const MEDIA_UPLOAD_RETRY_DELAY_MS = 1000;
const RETRYABLE_MEDIA_UPLOAD_STATUSES = new Set([429, 502, 503, 504]);

function normalizeUsmercariBaseUrl(value) {
  return String(value || 'https://ai.usmercari.com')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/cpa-file\/(?:submit\/video|fetch)$/i, '')
    .replace(/\/v1$/i, '');
}

function resolveUsmercariApiKey(config = {}, env = process.env) {
  if (String(config.provider || '').toLowerCase() === 'usmercari_image'
      || String(config.api_protocol || '').toLowerCase() === 'usmercari_image') {
    return String(env.USMERCARI_IMAGE_API_KEY || env.USMERCARI_API_KEY || config.api_key || '').trim();
  }
  return String(env.USMERCARI_API_KEY || config.api_key || '').trim();
}

function uniqueValues(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function validateUsmercariVideoOptions(opts = {}) {
  const model = String(opts.model || '').trim();
  const spec = USMERCARI_MODELS[model];
  if (!spec) throw new Error(`USMercari 模型 ${model || '(empty)'} 未经真实生成验证，禁止提交`);

  const duration = Number(opts.duration ?? 5);
  if (!Number.isSafeInteger(duration) || !spec.durations.includes(duration)) {
    throw new Error(`USMercari 模型 ${model} 时长必须是 ${spec.durations[0]} 到 ${spec.durations.at(-1)} 秒之间的整数`);
  }
  const aspectRatio = String(opts.aspect_ratio || '16:9').trim().replace('：', ':');
  if (aspectRatio !== '16:9') throw new Error('USMercari 三个视频模型目前仅开放已实测的 16:9 画幅');
  const resolution = String(opts.resolution || spec.resolutions[0]).trim().toLowerCase();
  if (!spec.resolutions.includes(resolution)) {
    throw new Error(`USMercari 模型 ${model} 不支持 ${resolution}；只开放已实测的 ${spec.resolutions.join('、')}`);
  }

  const firstFrame = String(opts.first_frame_url || opts.image_url || '').trim();
  const lastFrame = String(opts.last_frame_url || '').trim();
  const images = uniqueValues(Array.isArray(opts.reference_urls) ? opts.reference_urls : []);
  const videos = uniqueValues(Array.isArray(opts.reference_video_urls) ? opts.reference_video_urls : []);
  const audio = uniqueValues([
    ...(Array.isArray(opts.reference_audio_urls) ? opts.reference_audio_urls : []),
    opts.voice_reference_url,
  ]);
  const hasFirstFrame = Boolean(firstFrame || opts.image_id);
  const hasLastFrame = Boolean(lastFrame || opts.end_image_id);
  const imageIds = uniqueValues(Array.isArray(opts.image_ids) ? opts.image_ids : []);
  const videoIds = uniqueValues(Array.isArray(opts.video_reference_ids) ? opts.video_reference_ids : []);
  const audioIds = uniqueValues(Array.isArray(opts.audio_reference_ids) ? opts.audio_reference_ids : []);
  const referenceImageCount = Math.max(images.length, imageIds.length);
  const frameCount = Number(hasFirstFrame) + Number(hasLastFrame);
  const imageCount = referenceImageCount + frameCount;
  const videoCount = Math.max(videos.length, videoIds.length, opts.video_reference_id ? 1 : 0);
  const audioCount = Math.max(audio.length, audioIds.length, opts.audio_reference_id ? 1 : 0);
  if ((hasFirstFrame || hasLastFrame) && referenceImageCount > 0) {
    throw new Error('USMercari 首尾帧模式与多参考图模式互斥，不能同时提交首尾帧和参考图');
  }
  if (imageCount > spec.maxImages) {
    throw new Error(`USMercari 模型 ${model} 最多支持 ${spec.maxImages} 张参考图，本次完整请求需要 ${imageCount} 张（基础 ${referenceImageCount}、附加 ${frameCount}）`);
  }
  if (videoCount > spec.maxVideos) {
    throw new Error(spec.maxVideos === 0
      ? `USMercari 模型 ${model} 不支持参考视频`
      : `USMercari 模型 ${model} 最多支持 ${spec.maxVideos} 个参考视频`);
  }
  if (audioCount > spec.maxAudio) {
    throw new Error(spec.maxAudio === 0
      ? `USMercari 模型 ${model} 不支持参考音频`
      : `USMercari 模型 ${model} 最多支持 ${spec.maxAudio} 个参考音频`);
  }
  if (hasLastFrame && !hasFirstFrame) throw new Error('USMercari 尾帧必须与首帧一起使用');

  return { model, spec, duration, aspectRatio, resolution, firstFrame, lastFrame, images, videos, audio };
}

function buildUsmercariVideoBody(opts = {}) {
  const checked = validateUsmercariVideoOptions(opts);
  const metadata = {
    aspect_ratio: checked.aspectRatio,
    resolution: checked.resolution,
  };
  if (opts.image_id) metadata.image_id = String(opts.image_id);
  else if (opts.image_url) metadata.image_url = String(opts.image_url);
  if (opts.end_image_id) metadata.end_image_id = String(opts.end_image_id);
  if (Array.isArray(opts.image_ids) && opts.image_ids.length) metadata.image_ids = uniqueValues(opts.image_ids);
  if (Array.isArray(opts.video_reference_ids) && opts.video_reference_ids.length) metadata.video_reference_ids = uniqueValues(opts.video_reference_ids);
  else if (opts.video_reference_id) metadata.video_reference_id = String(opts.video_reference_id);
  if (Array.isArray(opts.audio_reference_ids) && opts.audio_reference_ids.length) metadata.audio_reference_ids = uniqueValues(opts.audio_reference_ids);
  else if (opts.audio_reference_id) metadata.audio_reference_id = String(opts.audio_reference_id);
  return {
    model: checked.model,
    prompt: String(opts.prompt || ''),
    duration: checked.duration,
    metadata,
  };
}

function extensionFrom(value, fallback) {
  const clean = String(value || '').split(/[?#]/)[0];
  const extension = path.extname(clean).replace(/^\./, '').toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(extension) ? extension : fallback;
}

function extensionFromMime(mime, fallback) {
  const normalized = String(mime || '').split(';')[0].trim().toLowerCase();
  const known = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  };
  return known[normalized] || fallback;
}

function mimeForExtension(extension, kind) {
  const known = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v',
  };
  return known[String(extension || '').toLowerCase()] || DEFAULT_MIME[kind];
}

function resolveStorageFile(source, storageLocalPath, filesBaseUrl) {
  if (!storageLocalPath) return '';
  const raw = String(source || '').trim();
  if (!raw || /^data:/i.test(raw)) return '';
  let storagePath = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const sourceUrl = new URL(raw);
      const baseUrl = new URL(String(filesBaseUrl || '').replace(/\/+$/, ''));
      const basePath = baseUrl.pathname.replace(/\/+$/, '');
      if (sourceUrl.origin !== baseUrl.origin
          || (sourceUrl.pathname !== basePath && !sourceUrl.pathname.startsWith(`${basePath}/`))) {
        return '';
      }
      storagePath = sourceUrl.pathname.slice(basePath.length);
    } catch (_) {
      return '';
    }
  }
  const relative = decodeURIComponent(storagePath.replace(/^\/static\//i, '').replace(/^static[\\/]/i, '')).replace(/^[/\\]+/, '');
  const root = path.resolve(storageLocalPath);
  const candidate = path.resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return '';
  return fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : '';
}

function assertMediaSize(kind, size) {
  const limit = MAX_MEDIA_BYTES[kind];
  if (Number(size) > limit) throw new Error(`USMercari 参考${kind === 'image' ? '图' : kind === 'video' ? '视频' : '音频'}超过 ${Math.round(limit / 1024 / 1024)}MB 上传上限`);
}

function assertMediaSourceSize(kind, size) {
  if (kind !== 'image') return assertMediaSize(kind, size);
  if (Number(size) > MAX_IMAGE_SOURCE_BYTES) throw new Error('USMercari 参考图超过 100MB 安全处理上限');
}

async function prepareMediaBytes(kind, bytes, mime, extension) {
  assertMediaSourceSize(kind, bytes.length);
  if (kind !== 'image' || bytes.length <= MAX_MEDIA_BYTES.image) {
    return { bytes, mime, extension, changed: false };
  }
  if (!sharp) return assertMediaSize(kind, bytes.length);

  try {
    for (const quality of [88, 76, 64]) {
      const compressed = await sharp(bytes, { failOn: 'none', limitInputPixels: 100_000_000 })
        .rotate()
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      if (compressed.length <= IMAGE_UPLOAD_TARGET_BYTES) {
        return { bytes: compressed, mime: 'image/jpeg', extension: 'jpg', changed: true };
      }
    }

    const resized = await sharp(bytes, { failOn: 'none', limitInputPixels: 100_000_000 })
      .rotate()
      .resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 76, mozjpeg: true })
      .toBuffer();
    assertMediaSize(kind, resized.length);
    return { bytes: resized, mime: 'image/jpeg', extension: 'jpg', changed: true };
  } catch (error) {
    if (/上传上限|安全处理上限/.test(String(error?.message || ''))) throw error;
    throw new Error(`USMercari 参考图压缩失败: ${error.message}`);
  }
}

async function mediaUploadPayload(kind, source, opts = {}) {
  const raw = String(source || '').trim();
  if (!raw) throw new Error(`USMercari 参考${kind}地址为空`);
  const dataMatch = raw.match(/^data:([^;,]+)?;base64,([\s\S]+)$/i);
  if (dataMatch) {
    const bytes = Buffer.from(dataMatch[2].replace(/\s/g, ''), 'base64');
    const mime = dataMatch[1] || DEFAULT_MIME[kind];
    const extension = extensionFromMime(mime, DEFAULT_EXTENSION[kind]);
    const prepared = await prepareMediaBytes(kind, bytes, mime, extension);
    return {
      data: prepared.changed ? `data:${prepared.mime};base64,${prepared.bytes.toString('base64')}` : raw,
      extension: prepared.extension,
    };
  }

  const localFile = resolveStorageFile(raw, opts.storage_local_path, opts.files_base_url);
  if (localFile) {
    const bytes = fs.readFileSync(localFile);
    const extension = extensionFrom(localFile, DEFAULT_EXTENSION[kind]);
    const mime = mimeForExtension(extension, kind);
    const prepared = await prepareMediaBytes(kind, bytes, mime, extension);
    return {
      data: `data:${prepared.mime};base64,${prepared.bytes.toString('base64')}`,
      extension: prepared.extension,
    };
  }

  if (!/^https?:\/\//i.test(raw)) throw new Error(`USMercari 参考${kind}必须是站内素材、data URI 或 HTTP(S) 地址`);
  const response = await fetch(raw);
  if (!response.ok) throw new Error(`USMercari 下载参考${kind}失败 (${response.status})`);
  const contentLength = Number(response.headers?.get?.('content-length') || 0);
  if (contentLength) assertMediaSourceSize(kind, contentLength);
  const bytes = Buffer.from(await response.arrayBuffer());
  assertMediaSourceSize(kind, bytes.length);
  const contentType = response.headers?.get?.('content-type') || '';
  const extension = extensionFromMime(contentType, extensionFrom(raw, DEFAULT_EXTENSION[kind]));
  const mime = String(contentType).split(';')[0].trim() || mimeForExtension(extension, kind);
  const prepared = await prepareMediaBytes(kind, bytes, mime, extension);
  return {
    data: `data:${prepared.mime};base64,${prepared.bytes.toString('base64')}`,
    extension: prepared.extension,
  };
}

function parseJson(raw) {
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function mediaKindLabel(kind) {
  return kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频';
}

function mediaUploadErrorMessage(payload, raw, status) {
  const message = payload?.detail || payload?.message || payload?.error;
  if (message) return String(message).slice(0, 300);
  if (/<!doctype\s+html|<html[\s>]/i.test(String(raw || ''))) return '中转站媒体上传网关暂时不可用';
  return String(raw || `HTTP ${status}`).slice(0, 300);
}

async function uploadUsmercariMedia(config, kind, source, opts = {}) {
  if (!['image', 'audio', 'video'].includes(kind)) throw new Error(`USMercari 不支持媒体类型 ${kind}`);
  const apiKey = resolveUsmercariApiKey(config);
  if (!apiKey) throw new Error('USMercari API Key 未配置');
  const body = await mediaUploadPayload(kind, source, opts);
  const url = `${normalizeUsmercariBaseUrl(config?.base_url)}/v1/media/upload/${kind}`;
  for (let attempt = 1; attempt <= MEDIA_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (attempt < MEDIA_UPLOAD_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, MEDIA_UPLOAD_RETRY_DELAY_MS));
        continue;
      }
      throw new Error(
        `USMercari 上传参考${mediaKindLabel(kind)}连接中断，已重试 1 次: ${error.message}`,
      );
    }
    const raw = await response.text();
    const payload = parseJson(raw);
    if (!response.ok) {
      if (attempt < MEDIA_UPLOAD_MAX_ATTEMPTS && RETRYABLE_MEDIA_UPLOAD_STATUSES.has(response.status)) {
        await new Promise((resolve) => setTimeout(resolve, MEDIA_UPLOAD_RETRY_DELAY_MS));
        continue;
      }
      const message = mediaUploadErrorMessage(payload, raw, response.status);
      const retried = attempt > 1 ? '，已重试 1 次' : '';
      throw new Error(`USMercari 上传参考${mediaKindLabel(kind)}失败 (${response.status}${retried}): ${message}`);
    }
    const id = payload?.id ?? payload?.data?.id;
    if (id == null || String(id).trim() === '') throw new Error(`USMercari 上传参考${mediaKindLabel(kind)}成功但未返回 media id`);
    return String(id);
  }
  throw new Error(`USMercari 上传参考${mediaKindLabel(kind)}失败`);
}

async function prepareUsmercariVideoBody(config, opts = {}) {
  const checked = validateUsmercariVideoOptions(opts);
  const uploadOpts = {
    storage_local_path: opts.storage_local_path,
    files_base_url: opts.files_base_url,
  };
  const [imageId, endImageId, imageIds, videoReferenceIds, audioReferenceIds] = await Promise.all([
    checked.firstFrame ? uploadUsmercariMedia(config, 'image', checked.firstFrame, uploadOpts) : '',
    checked.lastFrame ? uploadUsmercariMedia(config, 'image', checked.lastFrame, uploadOpts) : '',
    Promise.all(checked.images.map((source) => uploadUsmercariMedia(config, 'image', source, uploadOpts))),
    Promise.all(checked.videos.map((source) => uploadUsmercariMedia(config, 'video', source, uploadOpts))),
    Promise.all(checked.audio.map((source) => uploadUsmercariMedia(config, 'audio', source, uploadOpts))),
  ]);
  return buildUsmercariVideoBody({
    ...opts,
    image_url: '',
    first_frame_url: checked.firstFrame,
    last_frame_url: checked.lastFrame,
    reference_urls: checked.images,
    reference_video_urls: checked.videos,
    reference_audio_urls: checked.audio,
    image_id: imageId,
    end_image_id: endImageId,
    image_ids: imageIds,
    video_reference_ids: videoReferenceIds,
    audio_reference_ids: audioReferenceIds,
  });
}

function buildUsmercariFetchUrl(baseUrl) {
  return `${normalizeUsmercariBaseUrl(baseUrl)}/cpa-file/fetch`;
}

function parseProgress(value) {
  const progress = Number.parseFloat(String(value ?? '').replace('%', ''));
  return Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : null;
}

function absoluteResultUrl(value, baseUrl) {
  const url = String(value || '').trim();
  if (!url) return '';
  try { return new URL(url, `${normalizeUsmercariBaseUrl(baseUrl)}/`).toString(); } catch (_) { return ''; }
}

function parseUsmercariFetchPayload(payload, taskId, baseUrl = 'https://ai.usmercari.com') {
  const tasks = Array.isArray(payload?.data) ? payload.data : [];
  const task = tasks.find((item) => String(item?.task_id || item?.taskId || '') === String(taskId)) || tasks[0];
  if (!task) return { state: 'processing', progress: null };
  const status = String(task.status || '').trim().toUpperCase();
  const progress = parseProgress(task.progress);
  const items = Array.isArray(task?.data?.items) ? task.data.items : [];
  const resultCandidates = [
    ...(typeof task?.data?.url === 'string' ? [{ url: task.data.url }] : []),
    ...items.flatMap((item) => Array.isArray(item?.data) ? item.data : []),
  ];
  const result = resultCandidates
    .map((item) => absoluteResultUrl(item?.url, baseUrl))
    .find(Boolean);
  if (result) return { state: 'completed', videoUrl: result, progress };
  if (status === 'SUCCESS') return { state: 'failed', error: 'USMercari 任务完成但未返回视频地址' };
  if (status === 'FAILURE') {
    const error = task.fail_reason || items[0]?.fail_reason || items[0]?.message || 'USMercari 视频生成失败';
    return { state: 'failed', error: String(error).slice(0, 500) };
  }
  return { state: 'processing', progress };
}

async function callUsmercariVideoApi(config, log, opts = {}) {
  const apiKey = resolveUsmercariApiKey(config);
  if (!apiKey) return { error: 'USMercari API Key 未配置' };
  let body;
  try {
    body = await prepareUsmercariVideoBody(config, opts);
  } catch (error) {
    return { error: error.message };
  }
  const url = `${normalizeUsmercariBaseUrl(config?.base_url)}/cpa-file/submit/video`;
  log?.info?.('[USMercari 视频] 创建任务', {
    video_gen_id: opts.video_gen_id,
    model: body.model,
    duration: body.duration,
    aspect_ratio: body.metadata.aspect_ratio,
    resolution: body.metadata.resolution,
    has_first_frame: !!body.metadata.image_id,
    reference_image_count: body.metadata.image_ids?.length || 0,
    has_reference_video: !!body.metadata.video_reference_id,
    has_reference_audio: !!body.metadata.audio_reference_id,
  });
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return {
      indeterminate: true,
      error: `USMercari 创建请求连接中断，供应商可能已受理或扣费但本平台未取得 task_id，结果未知；为避免重复扣费，不得自动重试。原始错误: ${error.message}`,
    };
  }
  const raw = await response.text();
  const payload = parseJson(raw);
  if (!response.ok) {
    const message = payload?.detail || payload?.message || payload?.error || raw || `HTTP ${response.status}`;
    return { error: `USMercari 创建视频任务失败 (${response.status}): ${String(message).slice(0, 300)}` };
  }
  if (!payload) return { error: 'USMercari 创建视频任务返回了非 JSON 响应' };
  const taskId = payload.task_id ?? payload?.data?.task_id;
  if (taskId == null || String(taskId).trim() === '') return { error: 'USMercari 创建视频任务成功但未返回 task_id' };
  return { task_id: String(taskId), status: String(payload.status || 'queued').toLowerCase() };
}

module.exports = {
  USMERCARI_MODELS,
  USMERCARI_VIDEO_DURATIONS,
  normalizeUsmercariBaseUrl,
  resolveUsmercariApiKey,
  validateUsmercariVideoOptions,
  buildUsmercariVideoBody,
  mediaUploadPayload,
  uploadUsmercariMedia,
  prepareUsmercariVideoBody,
  buildUsmercariFetchUrl,
  parseUsmercariFetchPayload,
  callUsmercariVideoApi,
};
