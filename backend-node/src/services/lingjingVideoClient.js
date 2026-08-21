'use strict';

const crypto = require('node:crypto');

const PUBLIC_MODEL = 'lingjing-video-v1';
const UPSTREAM_MODEL = 'relay';
const OFFICIAL_ORIGIN = 'https://seed.alimyun.xyz';
const OFFICIAL_BASE_URL = `${OFFICIAL_ORIGIN}/api/open/v1`;
const DURATIONS = Object.freeze([4, 5, 6, 8, 10, 11, 15]);
const RATIOS = Object.freeze(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']);
const MAX_IMAGE_REFERENCES = 9;

const LINGJING_VIDEO_SPEC = Object.freeze({
  publicModel: PUBLIC_MODEL,
  upstreamModel: UPSTREAM_MODEL,
  durations: DURATIONS,
  aspectRatios: RATIOS,
  resolutions: Object.freeze([]),
  quantities: Object.freeze([1]),
  maxImageReferences: MAX_IMAGE_REFERENCES,
  maxVideoReferences: 0,
  maxAudioReferences: 0,
  supportsImageReference: true,
  supportsFirstFrame: false,
  supportsLastFrame: false,
  supportsVideoReference: false,
  supportsAudioReference: false,
  supportsAudio: false,
});

const FAILED_STATUSES = new Set(['failed', 'failure', 'error', 'cancelled', 'canceled', 'rejected']);
const DONE_STATUSES = new Set(['succeeded', 'success', 'completed', 'complete', 'done']);

function gateError(code, message) {
  return Object.assign(new Error(message), { code });
}

function normalizeLingjingBaseUrl(value = OFFICIAL_BASE_URL) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch (_) {
    throw gateError('LINGJING_CONFIG_MISMATCH', '灵境视频只允许官方已审核域名');
  }
  const pathname = parsed.pathname.replace(/\/+$/, '');
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.hostname !== 'seed.alimyun.xyz'
    || pathname !== '/api/open/v1'
    || parsed.search
    || parsed.hash
  ) {
    throw gateError('LINGJING_CONFIG_MISMATCH', '灵境视频只允许官方已审核域名');
  }
  return OFFICIAL_BASE_URL;
}

function buildLingjingModelsUrl(baseUrl) {
  return `${normalizeLingjingBaseUrl(baseUrl)}/models`;
}

function buildLingjingUploadUrl(baseUrl) {
  return `${normalizeLingjingBaseUrl(baseUrl)}/uploads`;
}

function buildLingjingCreateUrl(baseUrl) {
  return `${normalizeLingjingBaseUrl(baseUrl)}/videos`;
}

function encodeTaskId(taskId) {
  const value = String(taskId ?? '').trim();
  if (!value) throw gateError('LINGJING_TASK_ID_REQUIRED', '灵境任务编号不能为空');
  return encodeURIComponent(value);
}

function buildLingjingStatusUrl(baseUrl, taskId) {
  return `${normalizeLingjingBaseUrl(baseUrl)}/videos/${encodeTaskId(taskId)}`;
}

function buildLingjingDownloadUrl(baseUrl, taskId) {
  return `${buildLingjingStatusUrl(baseUrl, taskId)}/download`;
}

function uniqueValues(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function normalizeUploadPath(value) {
  const normalized = String(value || '').trim().replace(/^\/+/, '');
  if (
    !/^uploads\/[A-Za-z0-9._/-]+$/.test(normalized)
    || normalized.includes('..')
    || normalized.includes('\\')
  ) {
    throw gateError('LINGJING_UPLOAD_PATH_INVALID', '灵境上传接口未返回受控 uploads 路径');
  }
  return normalized;
}

function assertUnsupportedReferences(opts) {
  const videos = uniqueValues(opts.reference_video_urls);
  const audio = uniqueValues([
    ...(Array.isArray(opts.reference_audio_urls) ? opts.reference_audio_urls : []),
    opts.voice_reference_url,
  ]);
  if (videos.length || String(opts.video_url || '').trim()) {
    throw gateError('LINGJING_VIDEO_REFERENCE_UNSUPPORTED', '灵境 relay 当前不支持视频参考');
  }
  if (audio.length) {
    throw gateError('LINGJING_AUDIO_REFERENCE_UNSUPPORTED', '灵境 relay 当前不支持音频参考');
  }
  if (
    String(opts.first_frame_url || '').trim()
    || String(opts.last_frame_url || '').trim()
    || String(opts.first_image_url || '').trim()
    || String(opts.last_image_url || '').trim()
  ) {
    throw gateError('LINGJING_FRAME_REFERENCE_UNSUPPORTED', '灵境 relay 当前不支持首尾帧');
  }
}

function buildLingjingVideoBody(opts = {}) {
  const model = String(opts.model || '').trim();
  if (model !== PUBLIC_MODEL) {
    throw gateError('LINGJING_MODEL_MISMATCH', `灵境公开模型必须是 ${PUBLIC_MODEL}`);
  }
  const prompt = String(opts.prompt || '').trim();
  if (!prompt) throw gateError('LINGJING_PROMPT_REQUIRED', '灵境视频提示词不能为空');
  const duration = Number(opts.duration);
  if (!Number.isSafeInteger(duration) || !DURATIONS.includes(duration)) {
    throw gateError('LINGJING_DURATION_UNSUPPORTED', `灵境 relay 不支持 ${opts.duration} 秒；只开放 ${DURATIONS.join('、')} 秒`);
  }
  const ratio = String(opts.aspect_ratio || opts.ratio || '').trim().replace('：', ':');
  if (!RATIOS.includes(ratio)) {
    throw gateError('LINGJING_RATIO_UNSUPPORTED', `灵境 relay 不支持画幅 ${ratio || '(empty)'}`);
  }
  const requestId = String(opts.request_id || '').trim();
  if (!requestId) throw gateError('LINGJING_REQUEST_ID_REQUIRED', '灵境 request_id 不能为空');
  assertUnsupportedReferences(opts);
  const referenceImages = uniqueValues(opts.reference_image_paths).map(normalizeUploadPath);
  if (referenceImages.length > MAX_IMAGE_REFERENCES) {
    throw gateError('LINGJING_IMAGE_REFERENCE_LIMIT_EXCEEDED', `灵境 relay 最多支持 ${MAX_IMAGE_REFERENCES} 张参考图`);
  }
  return {
    model_key: UPSTREAM_MODEL,
    prompt,
    duration,
    ratio,
    reference_images: referenceImages,
    request_id: requestId,
  };
}

function parseJson(raw) {
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function supplierCostFields(payload, source) {
  const data = flattenPayload(payload);
  const allowed = ['cost', 'credits', 'credits_used', 'charged_credits', 'charge', 'charged_amount', 'amount'];
  return allowed.flatMap((field) => {
    if (!Object.hasOwn(data, field)) return [];
    const value = data[field];
    if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return [];
    return [{ source, field, value }];
  });
}

function responseMessage(payload, raw) {
  return String(
    payload?.detail
    || payload?.error?.message
    || payload?.error
    || payload?.message
    || raw
    || ''
  ).replace(/\bBearer\s+[^\s"'<>]+/gi, '[redacted]').trim().slice(0, 300);
}

async function requestJson(url, options, fetchImpl) {
  const response = await fetchImpl(url, options);
  const raw = await response.text();
  return { response, raw, payload: parseJson(raw) };
}

function authHeaders(config, json = false) {
  return {
    Authorization: `Bearer ${String(config?.api_key || '').trim()}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function uploadLingjingReference(config, reference, index, fetchImpl, auditUploads) {
  const bytes = Buffer.isBuffer(reference?.bytes) ? reference.bytes : Buffer.from(reference?.bytes || []);
  if (!bytes.length) throw gateError('LINGJING_REFERENCE_EMPTY', `灵境参考图 ${index + 1} 内容为空`);
  const mimeType = String(reference?.mimeType || 'image/png').trim().toLowerCase();
  if (!mimeType.startsWith('image/')) throw gateError('LINGJING_REFERENCE_TYPE_INVALID', `灵境参考图 ${index + 1} 不是图片`);
  const filename = String(reference?.filename || `reference-${index + 1}.png`).replace(/[^A-Za-z0-9._-]/g, '_');
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mimeType }), filename);
  const result = await requestJson(buildLingjingUploadUrl(config?.base_url), {
    method: 'POST',
    headers: authHeaders(config),
    body: form,
  }, fetchImpl);
  if (!result.response.ok) {
    throw gateError('LINGJING_UPLOAD_FAILED', `灵境参考图 ${index + 1} 上传失败 (${result.response.status}): ${responseMessage(result.payload, result.raw)}`);
  }
  const path = result.payload?.path || result.payload?.data?.path || result.payload?.file?.path;
  const uploadPath = normalizeUploadPath(path);
  if (Array.isArray(auditUploads)) {
    auditUploads.push({
      reference_sha256: sha256(bytes),
      upload_path: uploadPath,
      upload_response_sha256: sha256(result.raw),
      upload_http_status: Number(result.response.status),
    });
  }
  return uploadPath;
}

function flattenPayload(payload) {
  if (payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
    return { ...payload, ...payload.data };
  }
  return payload || {};
}

function parseLingjingTask(payload) {
  const data = flattenPayload(payload);
  const taskIdValue = data.id ?? data.task_id;
  const taskId = taskIdValue == null ? '' : String(taskIdValue).trim();
  const status = String(data.status || data.state || '').trim().toLowerCase();
  const videoUrl = String(data.video_url || data.result_url || data.url || '').trim();
  if (videoUrl) return { state: 'completed', taskId, videoUrl, needsDownload: false };
  if (FAILED_STATUSES.has(status) || data.success === false || data.error) {
    return { state: 'failed', taskId, error: responseMessage(data, '') || `灵境任务失败: ${status || 'unknown'}` };
  }
  if (DONE_STATUSES.has(status)) return { state: 'completed', taskId, videoUrl: '', needsDownload: true };
  return { state: 'processing', taskId };
}

async function callLingjingVideoApi(config, log, opts = {}, runtime = {}) {
  const fetchImpl = runtime.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { error: '灵境 fetch 不可用' };
  try {
    normalizeLingjingBaseUrl(config?.base_url);
    const references = Array.isArray(opts.reference_images) ? opts.reference_images : [];
    if (references.length > MAX_IMAGE_REFERENCES) {
      throw gateError('LINGJING_IMAGE_REFERENCE_LIMIT_EXCEEDED', `灵境 relay 最多支持 ${MAX_IMAGE_REFERENCES} 张参考图`);
    }
    const uploadedPaths = [];
    const auditUploads = runtime.captureAudit ? [] : null;
    for (let index = 0; index < references.length; index += 1) {
      uploadedPaths.push(await uploadLingjingReference(config, references[index], index, fetchImpl, auditUploads));
    }
    const body = buildLingjingVideoBody({ ...opts, reference_image_paths: uploadedPaths });
    const serializedBody = canonicalJson(body);
    log?.info?.('[灵境视频] 创建任务', {
      model: PUBLIC_MODEL,
      upstream_model: UPSTREAM_MODEL,
      duration: body.duration,
      ratio: body.ratio,
      reference_count: body.reference_images.length,
      request_id: body.request_id,
    });
    let result;
    try {
      result = await requestJson(buildLingjingCreateUrl(config?.base_url), {
        method: 'POST',
        headers: authHeaders(config, true),
        body: serializedBody,
      }, fetchImpl);
    } catch (error) {
      return {
        indeterminate: true,
        error: `灵境创建请求结果未知，供应商可能已受理或扣费但本平台未取得 task_id；为避免重复扣费，不得自动重试。${String(error?.message || '').slice(0, 180)}`,
      };
    }
    if (!result.response.ok) {
      const message = responseMessage(result.payload, result.raw);
      if (Number(result.response.status) >= 500) {
        return {
          indeterminate: true,
          error: `灵境创建请求结果未知，供应商可能已受理或扣费但本平台未取得 task_id；为避免重复扣费，不得自动重试。HTTP ${result.response.status}: ${message}`,
        };
      }
      return { error: `灵境创建视频任务失败 (${result.response.status}): ${message}` };
    }
    if (!result.payload) {
      return { indeterminate: true, error: '灵境创建请求返回非 JSON，无法确认是否已受理；为避免重复扣费，不得自动重试' };
    }
    const parsed = parseLingjingTask(result.payload);
    if (parsed.state === 'failed') return { error: parsed.error };
    const costFields = supplierCostFields(result.payload, 'creation');
    const providerAudit = runtime.captureAudit ? {
      request_body_sha256: sha256(serializedBody),
      creation_response_sha256: sha256(result.raw),
      creation_http_status: Number(result.response.status),
      uploads: auditUploads,
      supplier_cost_unavailable: costFields.length === 0,
      supplier_cost_fields: costFields,
    } : null;
    if (parsed.videoUrl) return {
      video_url: parsed.videoUrl,
      ...(providerAudit ? { provider_audit: providerAudit } : {}),
    };
    if (!parsed.taskId) {
      return { indeterminate: true, error: '灵境创建请求未返回 task_id，无法确认是否已受理；为避免重复扣费，不得自动重试' };
    }
    return {
      task_id: parsed.taskId,
      status: String(flattenPayload(result.payload).status || 'submitted').toLowerCase(),
      ...(providerAudit ? { provider_audit: providerAudit } : {}),
    };
  } catch (error) {
    return { error: error.message, code: error.code };
  }
}

async function fetchLingjingTask(config, taskId, runtime = {}) {
  const fetchImpl = runtime.fetchImpl || globalThis.fetch;
  const result = await requestJson(buildLingjingStatusUrl(config?.base_url, taskId), {
    headers: authHeaders(config),
  }, fetchImpl);
  if (!result.response.ok) {
    return { state: 'failed', error: `灵境查询任务失败 (${result.response.status}): ${responseMessage(result.payload, result.raw)}` };
  }
  if (!result.payload) return { state: 'failed', error: '灵境查询任务返回非 JSON' };
  const parsed = parseLingjingTask(result.payload);
  if (!runtime.captureAudit) return parsed;
  const costFields = supplierCostFields(result.payload, 'terminal');
  return {
    ...parsed,
    provider_audit: {
      terminal_response_sha256: sha256(result.raw),
      terminal_http_status: Number(result.response.status),
      supplier_cost_unavailable: costFields.length === 0,
      supplier_cost_fields: costFields,
    },
  };
}

module.exports = {
  PUBLIC_MODEL,
  UPSTREAM_MODEL,
  OFFICIAL_ORIGIN,
  OFFICIAL_BASE_URL,
  DURATIONS,
  RATIOS,
  MAX_IMAGE_REFERENCES,
  LINGJING_VIDEO_SPEC,
  normalizeLingjingBaseUrl,
  buildLingjingModelsUrl,
  buildLingjingUploadUrl,
  buildLingjingCreateUrl,
  buildLingjingStatusUrl,
  buildLingjingDownloadUrl,
  buildLingjingVideoBody,
  parseLingjingTask,
  uploadLingjingReference,
  callLingjingVideoApi,
  fetchLingjingTask,
  authHeaders,
  canonicalJson,
};
