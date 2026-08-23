// 与 Go pkg/image + ImageGenerationService 对齐：调用图片生成 API，更新 image_generations 与角色头像
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const aiConfigService = require('./aiConfigService');
const uploadService = require('./uploadService');
const storageLayout = require('./storageLayout');
const taskService = require('./taskService');
const { loadConfig } = require('../config');
const { postJSONWithTimeout } = require('./aiClient');
const seedance2AssetGuards = require('../utils/seedance2AssetGuards');
const { resolveKlingBearerToken } = require('./klingJwt');
const creditLedger = require('./creditLedgerService');
const auditEvent = require('./auditEventService');
const generationCost = require('./generationCostLedgerService');
const assetService = require('./assetService');
const aihubccClient = require('./aihubccClient');
const token6688Client = require('./token6688Client');
const mediaModelSelection = require('./mediaModelSelectionService');
const canvasProviderConfigService = require('./canvasProviderConfigService');
const { aspectRatioLabelFromPixelSize } = require('./mediaAspectRatioSpec');
const { downloadPublicImage } = require('./publicImageDownload');
const usmercariImageClient = require('./usmercariImageClient');
const fuminImageClient = require('./fuminImageClient');
const modelPriceService = require('./modelPriceService');
const { hasTrustedEvidenceBinding } = require('./externalModelEvidenceService');
const providerRouteStability = require('./providerRouteStabilityService');
const { classifyProviderFailure } = require('./providerErrorClassifier');

/** 图生 POST 使用 Node http(s)，默认 10 分钟，避免 undici fetch 大包体/慢链路下模糊失败 */
const IMAGE_HTTP_TIMEOUT_MS = 600000;

/** 角色/场景/道具资产生图：仅当请求显式传入模型时使用资产上已保存的负面词。 */
function resolveAssetUserNegativeForApi(explicitModelName, storedNegative) {
  const hasModel = explicitModelName != null && String(explicitModelName).trim().length > 0;
  const neg = storedNegative != null ? String(storedNegative).trim() : '';
  return hasModel && neg ? neg : '';
}

// sharp 惰性加载（参考图压缩用，sharp 已在 package.json 中声明）
let _sharp = null;
function getSharp() {
  if (!_sharp) {
    try { _sharp = require('sharp'); } catch (_) {}
  }
  return _sharp;
}

/**
 * 压缩单张参考图 buffer，目标 ≤ targetKB（默认 2048KB=2MB）
 * 用 JPEG 递减质量压缩直到达标或质量降到最低阈值。
 * 若 sharp 不可用或压缩后更大，返回原始 buffer。
 */
async function compressImageBuffer(buffer, mimeType, targetKB = 2048, log = null) {
  const sharp = getSharp();
  if (!sharp) return { buffer, mimeType };
  const targetBytes = targetKB * 1024;
  if (buffer.length <= targetBytes) return { buffer, mimeType };
  try {
    let quality = 80;
    let compressed = await sharp(buffer).jpeg({ quality }).toBuffer();
    while (compressed.length > targetBytes && quality > 30) {
      quality -= 15;
      compressed = await sharp(buffer).jpeg({ quality }).toBuffer();
    }
    if (compressed.length < buffer.length) {
      if (log) log.info('[参考图压缩] 压缩完成', {
        original_kb: Math.round(buffer.length / 1024),
        compressed_kb: Math.round(compressed.length / 1024),
        quality,
      });
      return { buffer: compressed, mimeType: 'image/jpeg' };
    }
  } catch (e) {
    if (log) log.warn('[参考图压缩] sharp 压缩失败，使用原图', { error: e.message });
  }
  return { buffer, mimeType };
}

/**
 * 压缩 JSON 请求中的 inline 参考图，避免多图同时触发供应商请求体限制。
 * 公网 HTTPS URL 不下载、不改写，交给供应商按 URL 拉取；仅处理 data:image/*;base64 引用。
 * @param {string[]} resolvedRefs - resolveImageRef 后的引用列表
 * @param {{ totalBytes?: number, log?: object }} options
 * @returns {Promise<string[]>}
 */
async function compressResolvedImageRefsForJson(resolvedRefs, options = {}) {
  const refs = Array.isArray(resolvedRefs) ? resolvedRefs : [];
  const totalBytes = Number(options.totalBytes || 5 * 1024 * 1024);
  const log = options.log || null;
  const inlineRefs = refs.filter((value) => /^data:image\/[^;]+;base64,/i.test(String(value || '')));
  let remainingBytes = totalBytes;
  let remainingInline = inlineRefs.length;
  const output = [];

  for (const ref of refs) {
    const match = /^data:(image\/[^;]+);base64,(.*)$/i.exec(String(ref || ''));
    if (!match) {
      output.push(ref);
      continue;
    }

    const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
    const fairShare = remainingInline > 0 ? Math.floor(remainingBytes / remainingInline) : totalBytes;
    const targetBytes = Math.max(256 * 1024, Math.min(2 * 1024 * 1024, fairShare));
    let prepared = buffer;
    let mimeType = match[1].toLowerCase();

    if (buffer.length > targetBytes) {
      const compressed = await compressImageBuffer(buffer, mimeType, Math.floor(targetBytes / 1024), log);
      prepared = compressed.buffer;
      mimeType = compressed.mimeType;

      // Highly detailed images can remain above the target at quality 30; reduce dimensions once more.
      if (prepared.length > targetBytes && getSharp()) {
        try {
          const metadata = await getSharp()(prepared).metadata();
          const scale = Math.sqrt(targetBytes / prepared.length) * 0.9;
          const width = Math.max(320, Math.floor((metadata.width || 1024) * scale));
          const height = Math.max(320, Math.floor((metadata.height || 1024) * scale));
          prepared = await getSharp()(prepared)
            .resize({ width, height, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 45 })
            .toBuffer();
          mimeType = 'image/jpeg';
        } catch (error) {
          if (log) log.warn('[参考图压缩] 尺寸压缩失败，保留质量压缩结果', { error: error.message });
        }
      }
    }

    if (log && prepared.length !== buffer.length) {
      log.info('[参考图压缩] JSON 提交前处理', {
        original_kb: Math.round(buffer.length / 1024),
        compressed_kb: Math.round(prepared.length / 1024),
        remaining_budget_kb: Math.round(Math.max(0, remainingBytes - prepared.length) / 1024),
      });
    }
    output.push(`data:${mimeType};base64,${prepared.toString('base64')}`);
    remainingBytes = Math.max(0, remainingBytes - prepared.length);
    remainingInline -= 1;
  }

  return output;
}

// 惰性加载配置，避免循环依赖与启动顺序问题
let _appConfig = null;
function getAppConfig() {
  if (!_appConfig) {
    try { _appConfig = loadConfig(); } catch (_) { _appConfig = {}; }
  }
  return _appConfig;
}

/** 从配置读取图床 URL 有效期（小时），默认 23h 留出余量 */
function getProxyExpireHours() {
  return Number(getAppConfig()?.image_proxy?.expire_hours ?? 23);
}

/**
 * 根据 provider 名推断接口规范（api_protocol 未设置时的兜底逻辑）
 * 已明确设置 api_protocol 的配置不会走此函数。
 */
function inferProtocol(provider, model) {
  const p = String(provider || '').toLowerCase();
  if (p === 'token6688' || p === 'tokengo') return 'token6688';
  if (p === 'aihubcc' || p === 'aihubcc_image') return 'aihubcc';
  if (p === 'djpsd_openapi' || p === 'djpsd') return 'djpsd_openapi';
  if (p === 'dashscope' || p === 'qwen_image') return 'dashscope';
  if (p === 'nano_banana') return 'nano_banana';
  if (p === 'usmercari_image') return 'usmercari_image';
  if (p === 'gemini' || p === 'google') return 'gemini';
  if (p === 'volces' || p === 'volcengine' || p === 'volc') return 'volcengine';
  if (/seedream|doubao/i.test(model || '')) return 'volcengine';
  if (p === 'kling' || p === 'klingai') return 'kling';
  if (/^kling-/i.test(model || '')) return 'kling';
  if (p === 'agnes' || /agnes-image|apihub\.agnes-ai\.com/i.test(String(model || ''))) return 'agnes';
  if (p === 'fumin_image') return 'openai';
  return 'openai';
}

function isAihubccBaseUrl(baseUrl) {
  try {
    const hostname = new URL(String(baseUrl || '')).hostname.toLowerCase();
    return hostname === 'aihubcc.cc' || hostname.endsWith('.aihubcc.cc');
  } catch (_) {
    return false;
  }
}

function providerErrorMeta(data, httpStatus, overrides = {}) {
  const message = String(data?.error?.message || data?.message || data?.error || '');
  let providerCode = String(data?.error?.code || data?.code || '').trim();
  if (/no available channel/i.test(message)) providerCode = 'NO_AVAILABLE_CHANNEL';
  const providerTaskId = aihubccClient.extractTaskId(data);
  const explicitlyRejected = [400, 401, 413, 422, 429].includes(Number(httpStatus))
    || providerCode === 'NO_AVAILABLE_CHANNEL';
  return {
    httpStatus: Number.isInteger(Number(httpStatus)) ? Number(httpStatus) : undefined,
    providerCode: providerCode || undefined,
    providerTaskId: providerTaskId || undefined,
    explicitlyRejected,
    ...overrides,
  };
}

async function aihubccReferenceToFile(value, index = 0) {
  const source = String(value || '').trim();
  const dataMatch = source.match(/^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
  let bytes;
  let mimeType;
  if (dataMatch) {
    mimeType = dataMatch[1].toLowerCase().replace('image/jpg', 'image/jpeg');
    bytes = Buffer.from(dataMatch[2].replace(/\s+/g, ''), 'base64');
  } else if (/^https?:\/\//i.test(source)) {
    throw new Error('远程参考图必须先保存为本地素材');
  } else {
    throw new Error('参考图无法转换为上传文件');
  }
  if (!bytes.length) throw new Error('参考图内容为空');
  if (bytes.length > 20 * 1024 * 1024) throw new Error('参考图超过 20MB 限制');
  const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  return {
    blob: new Blob([bytes], { type: mimeType }),
    filename: `reference-${index + 1}.${extension}`,
  };
}

async function callAihubccImageApi(config, log, opts = {}) {
  const model = String(opts.model || 'gpt-image-2').trim();
  const rawRefs = Array.isArray(opts.reference_image_urls) ? opts.reference_image_urls.filter(Boolean) : [];
  const gptImage2 = /^gpt-image-2$/i.test(model);
  if (gptImage2 && rawRefs.length > 20) {
    return {
      error: 'AIHubCC gpt-image-2 最多支持 20 张参考图，请移除超出的参考图后再生成',
      route_meta: { phase: 'prepare', requestBodySent: false, explicitlyRejected: true },
    };
  }
  const refs = rawRefs
    .map((value) => resolveImageRef(value, opts.files_base_url, opts.storage_local_path))
    .filter(Boolean)
    .slice(0, gptImage2 ? 20 : 6);
  const gptImage2Edit = gptImage2 && refs.length > 0;
  if (gptImage2 && rawRefs.length > 0 && refs.length !== rawRefs.length) {
    return {
      error: 'AIHubCC gpt-image-2 参考图无法读取，请重新上传后再生成',
      route_meta: { phase: 'prepare', requestBodySent: false, explicitlyRejected: true },
    };
  }
  const preparedRefs = gptImage2Edit ? refs : await compressResolvedImageRefsForJson(refs, { log });
  const flowModel = aihubccClient.isFlowImageModel(model);
  const asyncModel = aihubccClient.isAsyncImageModel(model);
  const requestSize = /^gpt-image-2(?:-1k)?$/i.test(model)
    ? normalizeGptImageSize(opts.size)
    : opts.size;
  const endpoint = gptImage2Edit
    ? '/images/edits'
    : (flowModel ? '/chat/completions' : (asyncModel ? '/videos' : (config.endpoint || '/images/generations')));
  let body;
  if (gptImage2Edit) {
    let files;
    try {
      files = await Promise.all(refs.map(aihubccReferenceToFile));
    } catch (error) {
      return {
        error: `AIHubCC gpt-image-2 参考图准备失败: ${error.message}`,
        route_meta: { phase: 'prepare', requestBodySent: false, explicitlyRejected: true },
      };
    }
    body = new FormData();
    body.append('model', model);
    body.append('prompt', opts.prompt || '');
    body.append('size', requestSize || '1024x1024');
    for (const file of files) body.append('image[]', file.blob, file.filename);
  } else {
    body = flowModel
      ? aihubccClient.buildFlowImageBody({
          model,
          prompt: opts.prompt,
          referenceUrls: preparedRefs,
        })
      : aihubccClient.buildImageBody({
          model,
          prompt: opts.prompt,
          size: requestSize,
          quality: opts.quality,
          referenceUrls: preparedRefs,
        });
  }
  const url = aihubccClient.getSubmitUrl(config, endpoint);
  log.info('[AIHubCC image] 提交', {
    image_gen_id: opts.image_gen_id,
    model,
    endpoint: url,
    async: asyncModel,
    flow: flowModel,
    ref_count: refs.length,
  });
  let result;
  try {
    result = await aihubccClient.requestJson(url, {
      method: 'POST',
      headers: aihubccClient.authHeaders(config, !gptImage2Edit),
      body: gptImage2Edit ? body : JSON.stringify(body),
      timeoutMs: IMAGE_HTTP_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      error: `AIHubCC 图片请求失败: ${error.message}`,
      route_meta: {
        phase: 'submit',
        requestBodySent: true,
        transportCode: error?.cause?.code || error?.code,
      },
    };
  }
  if (!result.response.ok) {
    return {
      error: `AIHubCC 图片请求失败: ${result.response.status} ${(result.data?.error?.message || result.data?.message || result.raw || '').slice(0, 300)}`,
      route_meta: providerErrorMeta(result.data, result.response.status),
    };
  }
  if (flowModel) {
    const flowUrl = normalizeProviderImageOutput(aihubccClient.extractFlowImageUrl(result.data, config));
    return flowUrl
      ? { image_url: flowUrl }
      : {
          indeterminate: true,
          error: 'AIHubCC Flow 图片接口未在 choices[0].message.content 返回图片地址',
          route_meta: providerErrorMeta(result.data, result.response.status, { artifactReadable: false }),
        };
  }
  const openAIResult = extractOpenAIImageResult(result.data);
  if (openAIResult) return openAIResult;
  const direct = normalizeProviderImageOutput(aihubccClient.extractMediaUrl(result.data, config));
  if (direct) return { image_url: direct };
  const b64 = normalizeProviderImageOutput(result.data?.data?.[0]?.b64_json, {
    allowRawBase64: true,
    mimeType: 'image/png',
  });
  if (b64) return { image_url: b64 };
  const taskId = aihubccClient.extractTaskId(result.data);
  if (!taskId) {
    log.warn('[AIHubCC image] 结果未知', summarizeImageResponse(
      result.data,
      result.raw,
      result.response.status,
      opts.image_gen_id,
      model,
    ));
    return {
      indeterminate: true,
      error: 'AIHubCC 图片接口未返回图片地址或任务编号',
      route_meta: providerErrorMeta(result.data, result.response.status, { artifactReadable: false }),
    };
  }
  const polled = await aihubccClient.pollTask(config, taskId, {
    mediaType: 'image',
    maxAttempts: Number(process.env.AIHUBCC_IMAGE_MAX_ATTEMPTS || 720),
    intervalMs: Number(process.env.AIHUBCC_POLL_INTERVAL_MS || 5000),
    log,
  });
  return { ...polled, route_meta: { providerTaskId: taskId } };
}

function normalizeDjpsdOpenApiBaseUrl(value) {
  return String(value || 'https://shiping.djpsd.com').trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function buildDjpsdOpenApiImageUrl(baseUrl, endpoint, defaultPath) {
  const root = normalizeDjpsdOpenApiBaseUrl(baseUrl);
  const raw = String(endpoint || defaultPath).trim();
  if (!/^https?:\/\//i.test(raw)) return root + (raw.startsWith('/') ? raw : `/${raw}`);
  const url = new URL(raw);
  if (url.origin !== new URL(root).origin) {
    throw new Error('DJPSD 开放 API 端点必须与 Base URL 同源');
  }
  return url.toString();
}

function buildDjpsdOpenApiImageQueryUrl(config, taskId) {
  const encoded = encodeURIComponent(String(taskId));
  let queryEndpoint = String(config.query_endpoint || '/v1/media/status?task_id={taskId}').trim();
  if (/\{taskId\}|\{task_id\}|\{id\}/i.test(queryEndpoint)) {
    queryEndpoint = queryEndpoint.replace(/\{taskId\}|\{task_id\}|\{id\}/gi, encoded);
  } else {
    const root = normalizeDjpsdOpenApiBaseUrl(config.base_url);
    const queryUrl = new URL(queryEndpoint, `${root}/`);
    queryUrl.searchParams.set('task_id', String(taskId));
    queryEndpoint = queryUrl.toString();
  }
  return buildDjpsdOpenApiImageUrl(
    config.base_url,
    queryEndpoint,
    '/v1/media/status?task_id={taskId}',
  );
}

function buildDjpsdOpenApiImageBody(opts = {}) {
  return {
    model: opts.model || 'image-v1',
    prompt: opts.prompt || '',
    params: {
      aspect_ratio: aspectRatioLabelFromPixelSize(opts.size),
      images: Array.isArray(opts.images) ? opts.images.filter(Boolean) : [],
    },
  };
}

function resolveDjpsdOpenApiImageResultUrl(baseUrl, value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return new URL(raw, `${normalizeDjpsdOpenApiBaseUrl(baseUrl)}/`).toString();
}

function parseDjpsdOpenApiImagePollResponse(payload, baseUrl) {
  const data = payload?.data || payload || {};
  const state = String(data.state || data.status || data.task_status || '').toLowerCase();
  const resultType = String(data.result_type || '').toLowerCase();
  if (resultType && resultType !== 'image') {
    return { state: 'failed', error: 'DJPSD 开放 API 返回的不是图片结果' };
  }
  const imageUrl = resolveDjpsdOpenApiImageResultUrl(
    baseUrl,
    data.image_url || data.result_url,
  );
  if (imageUrl) return { state: 'completed', imageUrl };
  if (state === 'failed' || state === 'error') {
    return { state: 'failed', error: data.error || data.message || 'DJPSD 开放 API 图片生成失败' };
  }
  if (data.is_final || ['success', 'succeeded', 'completed', 'done'].includes(state)) {
    return { state: 'failed', error: 'DJPSD 开放 API 任务已结束但未返回图片地址' };
  }
  return { state: 'processing' };
}

function parseDjpsdOpenApiImageDataUrl(value) {
  const match = String(value || '').match(/^data:([\w/+.-]+);base64,(.+)$/is);
  if (!match) throw new Error('参考图 data URL 格式无效');
  const mimeType = match[1].toLowerCase();
  if (!mimeType.startsWith('image/')) throw new Error('只允许图片 data URL');
  const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!bytes.length) throw new Error('参考图 data URL 内容为空');
  if (bytes.length > 20 * 1024 * 1024) throw new Error('参考图超过 20MB 限制');
  return { bytes, mimeType };
}

function djpsdImageExtension(mimeType) {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/gif') return 'gif';
  return 'jpg';
}

async function uploadDjpsdOpenApiImageReference(config, rawValue, opts, index) {
  const raw = String(rawValue || '').trim();
  if (!raw) return '';
  const root = normalizeDjpsdOpenApiBaseUrl(config.base_url);
  try {
    const url = new URL(raw, `${root}/`);
    if (url.origin === new URL(root).origin && url.pathname.startsWith('/uploads/')) {
      return `${url.pathname}${url.search}`;
    }
  } catch (_) {}

  const resolved = resolveImageRef(raw, opts.files_base_url, opts.storage_local_path);
  let image;
  if (String(resolved || '').startsWith('data:')) {
    image = parseDjpsdOpenApiImageDataUrl(resolved);
  } else if (/^https?:\/\//i.test(String(resolved || ''))) {
    image = await downloadPublicImage(resolved);
  } else {
    throw new Error('参考图不是可上传的本地图片、data URL 或公网 HTTP(S) 图片');
  }

  const form = new FormData();
  form.append(
    'file',
    new Blob([image.bytes], { type: image.mimeType }),
    `reference-${index + 1}.${djpsdImageExtension(image.mimeType)}`,
  );
  const uploadUrl = buildDjpsdOpenApiImageUrl(config.base_url, '/v1/media/upload', '/v1/media/upload');
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.api_key || ''}` },
    body: form,
  });
  const responseText = await res.text();
  let data = {};
  try { data = responseText ? JSON.parse(responseText) : {}; } catch (_) {}
  if (!res.ok) {
    const message = data.detail || data.message || responseText || `HTTP ${res.status}`;
    throw new Error(`参考图上传失败: ${String(message).slice(0, 300)}`);
  }
  const uploadedUrl = String(data.url || data.data?.url || '').trim();
  if (!uploadedUrl) throw new Error('参考图上传成功但未返回 URL');
  return uploadedUrl;
}

function formatDjpsdOpenApiImageUnknownSubmitError(error) {
  const detail = error?.message || String(error || '连接中断');
  return `DJPSD 图片创建请求连接中断，供应商可能已受理或扣费，但本平台未收到任务编号（结果未知）。为避免重复扣费，请先核对供应商任务记录，不要连续重试。原始错误: ${detail}`;
}

async function pollDjpsdOpenApiImageTask(config, log, taskId, opts = {}) {
  const maxAttempts = Math.max(1, Number(opts.max_poll_attempts || process.env.DJPSD_IMAGE_MAX_ATTEMPTS || 720));
  const intervalMs = Math.max(0, Number(opts.poll_interval_ms ?? process.env.DJPSD_IMAGE_POLL_INTERVAL_MS ?? 5000));
  const queryUrl = buildDjpsdOpenApiImageQueryUrl(config, taskId);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const res = await fetch(queryUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${config.api_key || ''}` },
      });
      const raw = await res.text();
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch (_) {}
      if (res.status === 401 || res.status === 403) {
        return { error: data.detail || data.message || `DJPSD 开放 API Key 无效 (${res.status})` };
      }
      if (res.ok) {
        const parsed = parseDjpsdOpenApiImagePollResponse(data, config.base_url);
        log.info('[DJPSD OpenAPI image] 轮询状态', {
          image_gen_id: opts.image_gen_id,
          task_id: String(taskId),
          round: attempt + 1,
          state: parsed.state,
        });
        if (parsed.state === 'completed') return { image_url: parsed.imageUrl };
        if (parsed.state === 'failed') return { error: parsed.error };
      }
    } catch (error) {
      log.warn('[DJPSD OpenAPI image] 轮询请求失败', {
        image_gen_id: opts.image_gen_id,
        task_id: String(taskId),
        round: attempt + 1,
        error: error.message,
      });
    }
    if (attempt + 1 < maxAttempts && intervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return {
    error: `DJPSD 图片任务 ${taskId} 最终状态未知，供应商任务仍可能处理中；为避免重复扣费，请勿重新提交`,
  };
}

async function callDjpsdOpenApiImageApi(config, log, opts = {}) {
  let submitUrl;
  try {
    submitUrl = buildDjpsdOpenApiImageUrl(config.base_url, config.endpoint, '/v1/media/generate');
    buildDjpsdOpenApiImageQueryUrl(config, 'connectivity-check');
  } catch (error) {
    return { error: `DJPSD 开放 API 配置错误: ${error.message}` };
  }

  const refs = Array.isArray(opts.reference_image_urls)
    ? opts.reference_image_urls.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const images = [];
  try {
    for (let index = 0; index < refs.length; index += 1) {
      images.push(await uploadDjpsdOpenApiImageReference(config, refs[index], opts, index));
    }
  } catch (error) {
    return { error: `DJPSD 开放 API ${error.message}` };
  }

  const body = buildDjpsdOpenApiImageBody({ ...opts, images });
  log.info('[DJPSD OpenAPI image] 创建任务', {
    image_gen_id: opts.image_gen_id,
    url: submitUrl,
    model: body.model,
    aspect_ratio: body.params.aspect_ratio,
    image_count: images.length,
  });
  let res;
  try {
    res = await fetch(submitUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.api_key || ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { error: formatDjpsdOpenApiImageUnknownSubmitError(error) };
  }
  const raw = await res.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch (_) {}
  if (!res.ok) {
    const message = data.detail || data.message || raw || `HTTP ${res.status}`;
    return { error: `DJPSD 开放 API 创建图片任务失败: ${String(message).slice(0, 300)}` };
  }
  const direct = parseDjpsdOpenApiImagePollResponse(data, config.base_url);
  if (direct.state === 'completed') return { image_url: direct.imageUrl };
  if (direct.state === 'failed') return { error: direct.error };
  const responseData = data?.data || data || {};
  const taskId = responseData.task_id ?? responseData.id;
  if (taskId == null) {
    return {
      error: 'DJPSD 开放 API 创建成功但未返回任务编号（结果未知）。供应商可能已受理或扣费，请先核对供应商任务记录，不要连续重试。',
    };
  }
  return pollDjpsdOpenApiImageTask(config, log, taskId, opts);
}

/**
 * 获取默认图片配置：优先使用前端勾选的「默认」配置（is_default），同类型内按优先级（priority）排序；
 * 可选按 preferredProvider / preferredModel 进一步筛选。
 * @param {object} db
 * @param {string} [preferredModel] - 指定模型名时，在匹配到的配置中选含该模型的
 * @param {string} [preferredProvider] - 指定供应商（如 openai / dashscope），只在该 provider 的配置中选
 * @param {string} [imageServiceType] - 'image' 文本生成图片（角色/场景/道具），'storyboard_image' 分镜图片生成（支持参考图）；缺省为 'image'
 */
function getDefaultImageConfig(db, preferredModel, preferredProvider, imageServiceType, preferredConfigId) {
  const candidates = getImageConfigCandidates(
    db,
    preferredModel,
    preferredProvider,
    imageServiceType,
    preferredConfigId,
  );
  if (candidates.length > 0) return candidates[0];
  const logicalRoute = findLogicalImageRoute(db, preferredModel, imageServiceType);
  if (logicalRoute) return aiConfigService.getConfig(db, logicalRoute.id);
  return preferredModel && !hasColumn(db, 'ai_service_configs', 'verification_status')
    ? canvasProviderConfigService.getConfig('image', preferredModel)
    : null;
}

function requiresImageVerification(config) {
  return String(config?.provider || '').toLowerCase() === 'usmercari_image'
    || String(config?.api_protocol || '').toLowerCase() === 'usmercari_image';
}

function hasVerifiedImageModel(config, preferredModel) {
  if (!requiresImageVerification(config)) return true;
  if (config.verification_status !== 'verified') return false;
  const selection = mediaModelSelection.parseQualifiedSelection(preferredModel);
  const model = String(selection?.upstreamModel || preferredModel || config.default_model || config.model?.[0] || '').trim();
  const key = Object.keys(config.verified_capabilities || {})
    .find((item) => String(item).trim().toLowerCase() === model.toLowerCase());
  const capabilities = key ? config.verified_capabilities[key] : null;
  return Boolean(capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities));
}

function imageGateError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function verifiedImageCapabilities(config, model) {
  let all = config?.verified_capabilities || {};
  try {
    if (typeof all === 'string') all = JSON.parse(all || '{}');
  } catch (_) {
    all = {};
  }
  const target = String(model || '').trim().toLowerCase();
  const key = Object.keys(all || {}).find((item) => String(item).trim().toLowerCase() === target);
  const capabilities = key ? all[key] : null;
  return capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities)
    ? capabilities
    : null;
}

function assertUsmercariImageSubmitReady(db, config, model, opts, evidenceRoots) {
  const target = String(model || '').trim().toLowerCase();
  const official = usmercariImageClient.USMERCARI_IMAGE_MODELS[target];
  if (!official || config?.verification_status !== 'verified') {
    throw imageGateError('MODEL_NOT_VERIFIED', `${target || 'USMercari 图片模型'} 尚未通过真实生成验证`);
  }
  if (!aiConfigService.hasConnectionCredential(config)) {
    throw imageGateError('MODEL_CREDENTIAL_MISSING', `${target} 未配置有效的 USMercari API Key`);
  }
  const capabilities = verifiedImageCapabilities(config, target);
  if (!capabilities || !hasTrustedEvidenceBinding(target, capabilities, evidenceRoots)
      || capabilities.supportsTextToImage !== true) {
    throw imageGateError('MODEL_NOT_VERIFIED', `${target} 的真实生成证据与当前发布不一致`);
  }
  const resolution = usmercariImageClient.normalizeResolution(opts?.resolution);
  const verifiedResolutions = Array.isArray(capabilities.resolutions)
    ? capabilities.resolutions.map((item) => String(item || '').trim().toLowerCase())
    : [];
  if (!official.resolutions.includes(resolution) || !verifiedResolutions.includes(resolution)) {
    throw imageGateError('IMAGE_RESOLUTION_NOT_VERIFIED', `${target} 的 ${resolution} 尚未通过真实生成验证`);
  }
  const references = Array.isArray(opts?.reference_image_urls)
    ? opts.reference_image_urls.filter(Boolean)
    : [];
  if (references.length > 0 && capabilities.supportsImageReference !== true) {
    throw imageGateError('IMAGE_REFERENCE_NOT_VERIFIED', `${target} 尚未通过参考图真实验证`);
  }
  const maxReferences = Math.min(Number(official.maxReferences), Number(capabilities.maxReferences));
  if (!Number.isSafeInteger(maxReferences) || maxReferences < 0 || references.length > maxReferences) {
    throw imageGateError('IMAGE_REFERENCE_LIMIT_EXCEEDED', `${target} 的参考图数量超过已验证上限`);
  }
  const quantity = Number(opts?.n ?? 1);
  if (quantity !== 1) throw imageGateError('INVALID_IMAGE_QUANTITY', 'USMercari 图片数量目前仅开放已实测的 1 张');
  const price = modelPriceService.list(db)
    .find((item) => String(item.model || '').trim().toLowerCase() === target);
  const credits = modelPriceService.calculateCharge(db, target, { resolution, quantity });
  if (!price || price.category !== 'image' || price.status !== 'enabled'
      || !Number.isSafeInteger(credits) || credits <= 0
      || !Number.isSafeInteger(price.resolution_prices?.[resolution]?.credits)
      || price.resolution_prices[resolution].credits !== credits) {
    throw imageGateError('MODEL_RESOLUTION_PRICE_REQUIRED', `${target} 的 ${resolution} 积分待管理员配置`);
  }
  return { capabilities, quantity, references, resolution };
}

function isVerifiedImageFallbackConfig(config) {
  const status = config?.verification_status;
  return status == null || status === '' || status === 'verified';
}

function isUsmercariImageConfig(config, model) {
  const provider = String(config?.provider || '').trim().toLowerCase();
  const protocol = String(config?.api_protocol || '').trim().toLowerCase()
    || inferProtocol(provider, model || getModelFromConfig(config));
  return protocol === 'usmercari_image';
}

function imageConfigError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function hasColumn(db, table, columnName) {
  return db.prepare(`PRAGMA table_info(${table})`).all()
    .some((column) => column.name === columnName);
}

function normalizeImageConfigId(configId) {
  if (typeof configId === 'number') {
    if (Number.isSafeInteger(configId) && configId > 0) return configId;
    throw imageConfigError('IMAGE_CONFIG_NOT_FOUND', '图片模型配置不存在');
  }
  if (typeof configId === 'string') {
    const trimmed = configId.trim();
    if (/^[0-9]+$/.test(trimmed)) {
      const numericId = Number(trimmed);
      if (Number.isSafeInteger(numericId) && numericId > 0) return numericId;
    }
  }
  throw imageConfigError('IMAGE_CONFIG_NOT_FOUND', '图片模型配置不存在');
}

function resolveExplicitImageConfigId(opts = {}) {
  const hasSnake = Object.prototype.hasOwnProperty.call(opts, 'config_id');
  const hasCamel = Object.prototype.hasOwnProperty.call(opts, 'configId');
  if (!hasSnake && !hasCamel) return null;
  if (!hasSnake) return normalizeImageConfigId(opts.configId);
  if (!hasCamel) return normalizeImageConfigId(opts.config_id);

  const snakeId = normalizeImageConfigId(opts.config_id);
  const camelId = normalizeImageConfigId(opts.configId);
  if (snakeId !== camelId) {
    throw imageConfigError('IMAGE_CONFIG_NOT_FOUND', '图片模型配置不存在');
  }
  return snakeId;
}

function getImageConfigById(db, configId, preferredModel) {
  const numericId = normalizeImageConfigId(configId);

  const config = aiConfigService.getConfig(db, numericId);
  if (!config || ![
    'image', 'storyboard_image', 'redraw_character', 'redraw_scene', 'redraw_prop',
  ].includes(config.service_type)) {
    throw imageConfigError('IMAGE_CONFIG_NOT_FOUND', '图片模型配置不存在');
  }
  if (!config.is_active) {
    throw imageConfigError('IMAGE_CONFIG_INACTIVE', '图片模型配置已停用');
  }

  if (hasColumn(db, 'ai_service_configs', 'verification_status')) {
    const row = db.prepare(
      'SELECT verification_status FROM ai_service_configs WHERE id = ? AND deleted_at IS NULL',
    ).get(numericId);
    if (row?.verification_status !== 'verified') {
      throw imageConfigError('IMAGE_CONFIG_UNVERIFIED', '图片模型配置未通过真实生成验证');
    }
  }

  if (preferredModel) {
    const selection = mediaModelSelection.parseQualifiedSelection(preferredModel);
    const wantedModel = String(selection?.upstreamModel || preferredModel).trim().toLowerCase();
    const models = [config.default_model, ...(Array.isArray(config.model)
      ? config.model
      : (config.model != null ? [config.model] : []))];
    const hasModel = models.some((model) => String(model).trim().toLowerCase() === wantedModel);
    if (!hasModel) {
      throw imageConfigError('IMAGE_CONFIG_MODEL_MISMATCH', '图片模型配置不包含请求模型');
    }
  }

  return config;
}

function getImageConfigCandidates(db, preferredModel, preferredProvider, imageServiceType, preferredConfigId) {
  const serviceType = imageServiceType || 'image';
  let configs = aiConfigService.listConfigs(db, serviceType);
  const redrawServiceTypes = new Set(['redraw_character', 'redraw_scene', 'redraw_prop']);
  const fallbackServiceTypes = serviceType === 'storyboard_image'
    ? ['image']
    : redrawServiceTypes.has(serviceType)
      ? ['storyboard_image', 'image']
      : [];
  for (const fallbackServiceType of fallbackServiceTypes) {
    const fallbackConfigs = aiConfigService.listConfigs(db, fallbackServiceType);
    const ids = new Set(configs.map((config) => String(config.id)));
    configs = [...configs, ...fallbackConfigs.filter((config) => !ids.has(String(config.id)))];
  }
  let active = configs.filter((c) => c.is_active);
  if (hasColumn(db, 'ai_service_configs', 'verification_status')) {
    const verifiedIds = new Set(db.prepare(
      "SELECT id FROM ai_service_configs WHERE deleted_at IS NULL AND verification_status = 'verified'",
    ).all().map((row) => String(row.id)));
    active = active.filter((config) => verifiedIds.has(String(config.id)));
  }
  active = active.filter((config) => hasVerifiedImageModel(config, preferredModel));
  if (preferredConfigId != null && String(preferredConfigId).trim()) {
    const selected = active.filter((config) => String(config.id) === String(preferredConfigId));
    if (selected.length > 0) active = selected;
  }
  if (preferredModel && usmercariImageClient.USMERCARI_IMAGE_MODELS[String(preferredModel || '').trim().toLowerCase()]) {
    active = active.filter((config) => isUsmercariImageConfig(config, preferredModel));
  }
  if (mediaModelSelection.parseQualifiedSelection(preferredModel)) {
    const selected = mediaModelSelection.resolveQualifiedConfig(active, preferredModel);
    return selected ? [selected] : [];
  }
  if (preferredProvider && String(preferredProvider).trim()) {
    const want = String(preferredProvider).trim().toLowerCase();
    const byProvider = active.filter((c) => (c.provider || '').toLowerCase() === want);
    if (byProvider.length > 0) {
      active = [
        ...byProvider,
        ...active.filter((c) => (c.provider || '').toLowerCase() !== want),
      ];
    }
  }
  if (preferredModel) {
    const wantedModel = String(preferredModel).trim().toLowerCase();
    const matching = active.filter((c) => {
      const models = Array.isArray(c.model) ? c.model : (c.model != null ? [c.model] : []);
      return models.some((model) => String(model).trim().toLowerCase() === wantedModel);
    });
    const isDefaultModel = matching.some((config) => config.is_default);
    active = isDefaultModel
      ? [...matching, ...active.filter((config) => !matching.includes(config))]
      : matching;
  }
  if (active.length < 2) return active;

  const hasPrices = Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'model_credit_prices'",
  ).get());
  if (!hasPrices) return active;
  const primaryModel = getModelFromConfig(active[0], preferredModel);
  const primaryPrice = db.prepare(
    "SELECT credits FROM model_credit_prices WHERE model = ? COLLATE NOCASE AND status = 'enabled'",
  ).get(primaryModel)?.credits;
  if (!Number.isSafeInteger(primaryPrice) || primaryPrice <= 0) return [active[0]];
  return [
    active[0],
    ...active.slice(1).filter((config) => {
      const model = getModelFromConfig(config, preferredModel);
      const price = db.prepare(
        "SELECT credits FROM model_credit_prices WHERE model = ? COLLATE NOCASE AND status = 'enabled'",
      ).get(model)?.credits;
      return price === primaryPrice;
    }),
  ];
}

function isAuditedReferenceImageAdapter(config, model, provider, protocol) {
  return (
    config.service_type === 'storyboard_image'
    && provider === 'aihubcc'
    && protocol === 'aihubcc'
    && model === 'gpt-image-2-3.5k'
  );
}

function getReferenceImageCapability(db, imageServiceType = 'storyboard_image') {
  let config = null;
  try {
    config = getDefaultImageConfig(db, null, null, imageServiceType);
  } catch (_) {
    return {
      available: false,
      reason: '图片模型配置尚未就绪',
    };
  }
  if (!config) {
    return {
      available: false,
      reason: '未配置已启用的参考图图片模型',
    };
  }
  const model = getModelFromConfig(config);
  const provider = String(config.provider || '').trim().toLowerCase();
  const protocol = String(config.api_protocol || '').trim().toLowerCase()
    || inferProtocol(provider, model);
  let settings = {};
  try {
    settings = typeof config.settings === 'string'
      ? JSON.parse(config.settings || '{}')
      : (config.settings || {});
  } catch (_) {}
  const strictReferenceAdapterAudited = isAuditedReferenceImageAdapter(
    config,
    model,
    provider,
    protocol,
  );
  const operations = [];
  if (settings.supports_outpaint === true && strictReferenceAdapterAudited) {
    operations.push('outpaint');
  }
  if (settings.supports_markup_retouch === true && strictReferenceAdapterAudited) {
    operations.push('markup_retouch');
  }
  if (settings.supports_upscale === true && strictReferenceAdapterAudited) {
    operations.push('upscale');
  }
  if (settings.supports_detail_enhance === true && strictReferenceAdapterAudited) {
    operations.push('detail_enhance');
  }
  const panoramaDeclared = settings.supports_panorama === true;
  const panoramaSceneDeclared = settings.supports_panorama_scene === true;
  const imageIdeationDeclared = settings.supports_image_ideation === true;
  const portraitTextureDeclared = settings.supports_portrait_texture === true;
  const portraitEmotionDeclared = settings.supports_portrait_emotion === true;
  const referenceVariationDeclarations = [
    ['angle_ideation', settings.supports_angle_ideation === true],
    ['character_views', settings.supports_character_views === true],
    ['narrative_grid', settings.supports_narrative_grid === true],
    ['frame_forward', settings.supports_frame_forward === true],
    ['frame_backward', settings.supports_frame_backward === true],
  ];
  const cinematicRelightDeclared = settings.supports_cinematic_relight === true;
  if (panoramaDeclared && strictReferenceAdapterAudited) operations.push('panorama');
  if (panoramaSceneDeclared && strictReferenceAdapterAudited) operations.push('panorama_scene');
  if (imageIdeationDeclared && strictReferenceAdapterAudited) operations.push('image_ideation');
  if (portraitTextureDeclared && strictReferenceAdapterAudited) operations.push('portrait_texture');
  if (portraitEmotionDeclared && strictReferenceAdapterAudited) operations.push('portrait_emotion');
  for (const [operation, declared] of referenceVariationDeclarations) {
    if (declared && strictReferenceAdapterAudited) operations.push(operation);
  }
  if (cinematicRelightDeclared && strictReferenceAdapterAudited) {
    operations.push('cinematic_relight');
  }
  if (operations.length === 0) {
    if (
      (
        settings.supports_outpaint === true
        || settings.supports_markup_retouch === true
        || settings.supports_upscale === true
        || settings.supports_detail_enhance === true
        || panoramaDeclared
        || panoramaSceneDeclared
        || imageIdeationDeclared
        || portraitTextureDeclared
        || portraitEmotionDeclared
        || referenceVariationDeclarations.some(([, declared]) => declared)
        || cinematicRelightDeclared
      )
      && !strictReferenceAdapterAudited
    ) {
      return {
        available: false,
        reason: `当前默认图片模型 ${model} 的参考图生成适配器尚未通过审计`,
      };
    }
    return {
      available: false,
      reason: `当前默认图片模型 ${model} 未显式声明图片编辑或参考图生成能力`,
    };
  }
  if (!strictReferenceAdapterAudited) {
    return {
      available: false,
      reason: `当前默认图片模型 ${model} 的图片编辑或参考图生成适配器尚未通过审计`,
    };
  }
  if (!String(config.base_url || '').trim() || !String(config.api_key || '').trim()) {
    return {
      available: false,
      reason: '参考图编辑供应商配置不完整',
    };
  }
  return {
    available: true,
    engine: 'provider-image-edit',
    provider: provider || protocol,
    protocol,
    model,
    operations,
  };
}

// 与 Go image_generation_service 一致：openai/chatfire 使用 "/images/generations"，base_url 通常已含 /v1
function buildImageUrl(config) {
  const base = (config.base_url || '').replace(/\/$/, '');
  let ep = config.endpoint || '/images/generations';
  if (!ep.startsWith('/')) ep = '/' + ep;
  return base + ep;
}

function getModelFromConfig(config, preferredModel) {
  if (config?.canvas_selected_model) return config.canvas_selected_model;
  const models = Array.isArray(config.model) ? config.model : (config.model != null ? [config.model] : []);
  if (preferredModel) {
    const wantedModel = String(preferredModel).trim().toLowerCase();
    const matchedModel = models.find((model) => String(model).trim().toLowerCase() === wantedModel);
    if (matchedModel) return matchedModel;
  }
  if (config.default_model && models.includes(config.default_model)) return config.default_model;
  return models[0] || 'dall-e-3';
}

function configuredImageReferenceLimit(config, model) {
  const provider = String(config?.provider || '').toLowerCase();
  const protocol = String(config?.api_protocol || '').toLowerCase();
  if (provider === 'token6688' || provider === 'tokengo' || protocol === 'token6688') {
    return token6688Client.IMAGE_REFERENCE_LIMITS[String(model || '').trim()] ?? 0;
  }
  if (requiresImageVerification(config)) {
    const target = String(model || '').trim().toLowerCase();
    const key = Object.keys(config?.verified_capabilities || {})
      .find((item) => String(item).trim().toLowerCase() === target);
    const limit = Number(key ? config.verified_capabilities[key]?.maxReferences : 0);
    return Number.isInteger(limit) && limit >= 0 ? limit : 0;
  }
  try {
    const settings = typeof config?.settings === 'string'
      ? JSON.parse(config.settings || '{}')
      : (config?.settings || {});
    const limit = Number(settings?.canvas_capabilities?.maxReferences);
    return Number.isInteger(limit) && limit >= 0 ? limit : 0;
  } catch (_) {
    return 0;
  }
}

function resolveImageModel(db, preferredModel, preferredProvider, imageServiceType = 'image') {
  const config = getDefaultImageConfig(db, preferredModel, preferredProvider, imageServiceType);
  if (!config) {
    const error = new Error('未配置可用的图片模型');
    error.code = 'IMAGE_MODEL_NOT_CONFIGURED';
    throw error;
  }
  return getModelFromConfig(config, preferredModel);
}

/** GPT Image 同步返回 base64；压缩 JPEG 与低质量档可缩短供应端同步处理时间。 */
function getOpenAIImageOutputOptions(model, requestedQuality) {
  if (!/^gpt-image-/i.test(String(model || ''))) return {};
  return {
    output_format: 'jpeg',
    output_compression: 85,
    ...(!requestedQuality ? { quality: 'low' } : {}),
  };
}

/** GPT Image 仅使用其支持的三档像素尺寸；保存后仍由本地流程适配回项目画幅。 */
function normalizeGptImageSize(size) {
  const match = String(size || '').trim().toLowerCase().replace(/\*/g, 'x').match(/^(\d+)x(\d+)$/);
  if (!match) return '1024x1024';
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width > height) return '1536x1024';
  if (height > width) return '1024x1536';
  return '1024x1024';
}

function imageMimeFromOutputFormat(format) {
  const normalized = String(format || 'png').toLowerCase();
  if (normalized === 'jpg' || normalized === 'jpeg') return 'image/jpeg';
  if (normalized === 'webp') return 'image/webp';
  return 'image/png';
}

function imageMimeFromBase64(base64, requestedFormat) {
  const bytes = Buffer.from(String(base64 || '').replace(/\s/g, ''), 'base64');
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return imageMimeFromOutputFormat(requestedFormat);
}

function formatGptImageUnknownResultError(error) {
  const detail = error?.message || String(error || '连接中断');
  return `图片生成连接中断，供应商可能已受理或扣费，但本平台未收到结果（结果未知）。为避免重复扣费，请先核对生成记录或供应商账单，不要连续重试。原始错误: ${detail}`;
}

const MAX_PROVIDER_IMAGE_BASE64_LENGTH = 32 * 1024 * 1024;

function validProviderImageBase64(value) {
  if (!value || value.length > MAX_PROVIDER_IMAGE_BASE64_LENGTH || value.length % 4 !== 0) return false;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

/** 将供应商产物收窄为可下载 HTTP(S) 或受支持的 Base64 图片 data URL。 */
function normalizeProviderImageOutput(value, options = {}) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const dataMatch = trimmed.match(/^data:image\/(png|jpeg|jpg|webp);base64,([\s\S]+)$/i);
  if (dataMatch) {
    const encoded = dataMatch[2].replace(/\s/g, '');
    if (!validProviderImageBase64(encoded)) return null;
    return `data:image/${dataMatch[1].toLowerCase()};base64,${encoded}`;
  }

  if (/^https?:\/\//i.test(trimmed) && !/\s/.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname) return trimmed;
    } catch (_) {}
  }

  if (!options.allowRawBase64) return null;
  const encoded = trimmed.replace(/\s/g, '');
  if (!validProviderImageBase64(encoded)) return null;
  const mimeType = /^(?:image\/)(?:png|jpeg|jpg|webp)$/i.test(String(options.mimeType || ''))
    ? String(options.mimeType).toLowerCase()
    : 'image/png';
  return `data:${mimeType};base64,${encoded}`;
}

/** 按固定优先级提取 OpenAI 兼容同步生图结果，不接触日志或计费状态。 */
function extractOpenAIImageResult(data, outputFormat) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const item = Array.isArray(data.data) ? data.data[0] : null;
  const itemUrl = normalizeProviderImageOutput(item?.url);
  if (itemUrl) return { image_url: itemUrl };
  const itemImageUrl = normalizeProviderImageOutput(item?.image_url);
  if (itemImageUrl) return { image_url: itemImageUrl };
  const itemBase64 = normalizeProviderImageOutput(item?.b64_json, {
    allowRawBase64: true,
    mimeType: imageMimeFromBase64(item?.b64_json, outputFormat),
  });
  if (itemBase64) {
    return { image_url: itemBase64 };
  }
  const topImageUrl = normalizeProviderImageOutput(data.image_url);
  if (topImageUrl) return { image_url: topImageUrl };
  const resultUrl = normalizeProviderImageOutput(data.result?.url);
  if (resultUrl) return { image_url: resultUrl };
  const firstImage = Array.isArray(data.images)
    ? normalizeProviderImageOutput(data.images[0], {
        allowRawBase64: true,
        mimeType: imageMimeFromBase64(data.images[0], 'png'),
      })
    : null;
  if (!firstImage) return null;
  return { image_url: firstImage };
}

const SAFE_IMAGE_RESPONSE_KEYS = new Set([
  'id', 'request_id', 'requestId', 'task_id', 'taskId', 'created', 'status',
  'data', 'images', 'image_url', 'result', 'usage', 'output', 'diagnostic',
]);
const SAFE_IMAGE_ITEM_KEYS = new Set(['id', 'url', 'image_url', 'b64_json', 'created', 'status']);

function safeResponseIdentifier(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).trim();
  if (
    !text
    || text.length > 128
    || /^(?:sk-|bearer(?:[\s_:.-]|$))/i.test(text)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)
  ) return undefined;
  return text;
}

function safeModelLabel(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text.length > 160 || /(?:https?:\/\/|data:|bearer\s|sk-|[?&](?:signature|token|key)=)/i.test(text)) {
    return undefined;
  }
  return text;
}

/** 供应商响应日志摘要：仅返回固定白名单元数据，不复制正文、URL、Base64 或密钥。 */
function summarizeImageResponse(data, raw, httpStatus, imageGenId, model) {
  const payload = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  const firstItem = Array.isArray(payload?.data) && payload.data[0] && typeof payload.data[0] === 'object'
    ? payload.data[0]
    : null;
  const summary = {
    response_bytes: Buffer.byteLength(typeof raw === 'string' || Buffer.isBuffer(raw) ? raw : '', 'utf8'),
    response_keys: payload ? Object.keys(payload).filter((key) => SAFE_IMAGE_RESPONSE_KEYS.has(key)) : [],
    first_item_keys: firstItem ? Object.keys(firstItem).filter((key) => SAFE_IMAGE_ITEM_KEYS.has(key)) : [],
  };
  const upstreamRequestId = safeResponseIdentifier(payload?.request_id ?? payload?.requestId ?? payload?.id);
  const upstreamTaskId = safeResponseIdentifier(payload?.task_id ?? payload?.taskId ?? payload?.result?.task_id ?? payload?.result?.taskId);
  if (upstreamRequestId !== undefined) summary.upstream_request_id = upstreamRequestId;
  if (upstreamTaskId !== undefined) summary.upstream_task_id = upstreamTaskId;
  if (Number.isInteger(Number(httpStatus))) summary.http_status = Number(httpStatus);
  if (typeof imageGenId === 'number' && Number.isSafeInteger(imageGenId)) summary.image_gen_id = imageGenId;
  else {
    const safeGenerationId = safeResponseIdentifier(imageGenId);
    if (safeGenerationId !== undefined) summary.image_gen_id = safeGenerationId;
  }
  const safeModel = safeModelLabel(model);
  if (safeModel !== undefined) summary.model = safeModel;
  return summary;
}

function openAIImageIndeterminateResult(reason) {
  return {
    indeterminate: true,
    error: `图片生成请求已成功返回，但${reason || '未收到可读取的图片产物'}，供应商结果未知。为避免重复扣费，请先核对供应商生成记录，不要连续重试。`,
  };
}

// 通义万象 size：格式 "宽*高"，总像素须在 589824(768*768)～1638400(1280*1280) 之间
const DASHSCOPE_MIN_PIXELS = 589824;
const DASHSCOPE_MAX_PIXELS = 1638400;

// 火山引擎 Doubao-Seedream-4.5 最低像素要求 3,686,400 (1920*1920)
// 需要自动将低分辨率请求放大到该标准，保持长宽比
const SEEDREAM_MIN_PIXELS = 3686400;

function fixSeedreamSize(size) {
  if (!size || typeof size !== 'string') return '1920x1920'; // 默认使用最低要求 1920x1920
  // 支持 1024x1024 或 1024*1024 格式，统一解析
  const s = size.trim().toLowerCase().replace(/\*/g, 'x');
  const match = s.match(/^(\d+)\s*x\s*(\d+)$/);
  if (!match) return '1920x1920';
  
  let w = parseInt(match[1], 10);
  let h = parseInt(match[2], 10);
  if (!w || !h) return '1920x1920';
  
  const pixels = w * h;
  if (pixels >= SEEDREAM_MIN_PIXELS) return `${w}x${h}`; // 已达标，直接用
  
  // 需要放大
  const scale = Math.sqrt(SEEDREAM_MIN_PIXELS / pixels);
  // 向上取整到 64 的倍数（通常 AI 模型对 64/32/16 对齐有偏好，这里取 64 较稳妥）
  w = Math.ceil((w * scale) / 64) * 64;
  h = Math.ceil((h * scale) / 64) * 64;
  
  // 二次检查是否因为取整导致略小于标准（虽然 ceil 应该不会，但为了保险）
  if (w * h < SEEDREAM_MIN_PIXELS) {
    w += 64;
    h += 64;
  }
  
  return `${w}x${h}`;
}

/** Agnes Image 2.x 官方常用尺寸（过大如 1440x2560 会导致上游 do_request_failed） */
const AGNES_IMAGE_SIZE_BY_RATIO = {
  '16:9': '1792x1024',
  '9:16': '1024x1792',
  '1:1': '1024x1024',
  '4:3': '1024x768',
  '3:4': '768x1024',
  '21:9': '1792x1024',
};

function isAgnesImageConfig(config, model) {
  const p = String(config?.provider || '').toLowerCase();
  const m = String(model || '').toLowerCase();
  const base = String(config?.base_url || '').toLowerCase();
  return p === 'agnes' || /agnes-image/.test(m) || /apihub\.agnes-ai\.com/.test(base);
}

/** 将项目内高分辨率 size 映射为 Agnes 支持的尺寸，保持宽高比类别 */
function fixAgnesImageSize(size) {
  if (!size || typeof size !== 'string') return AGNES_IMAGE_SIZE_BY_RATIO['4:3'];
  const s = size.trim().toLowerCase().replace(/\*/g, 'x');
  const match = s.match(/^(\d+)\s*x\s*(\d+)$/);
  if (!match) return AGNES_IMAGE_SIZE_BY_RATIO['4:3'];
  const w = parseInt(match[1], 10);
  const h = parseInt(match[2], 10);
  if (!w || !h) return AGNES_IMAGE_SIZE_BY_RATIO['4:3'];
  const mapped = AGNES_IMAGE_SIZE_BY_RATIO['16:9'];
  const ratio = w / h;
  const candidates = Object.entries(AGNES_IMAGE_SIZE_BY_RATIO).map(([label, sz]) => {
    const [rw, rh] = sz.split('x').map(Number);
    return { label, sz, r: rw / rh };
  });
  let best = mapped;
  let bestDiff = Infinity;
  for (const c of candidates) {
    const diff = Math.abs(Math.log(ratio) - Math.log(c.r));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = c.sz;
    }
  }
  return best;
}

function dashScopeSize(size) {
  if (!size || typeof size !== 'string') return '1280*1280';
  const s = String(size).trim().toLowerCase().replace(/x/g, '*');
  const match = s.match(/^(\d+)\s*\*\s*(\d+)$/);
  if (!match) return '1280*1280';
  let w = parseInt(match[1], 10);
  let h = parseInt(match[2], 10);
  if (!w || !h) return '1280*1280';
  let pixels = w * h;
  if (pixels <= DASHSCOPE_MAX_PIXELS && pixels >= DASHSCOPE_MIN_PIXELS) return `${w}*${h}`;
  if (pixels > DASHSCOPE_MAX_PIXELS) {
    const scale = Math.sqrt(DASHSCOPE_MAX_PIXELS / pixels);
    w = Math.max(16, Math.round((w * scale) / 16) * 16);
    h = Math.max(16, Math.round((h * scale) / 16) * 16);
    if (w * h > DASHSCOPE_MAX_PIXELS) {
      w = Math.min(w, 1280);
      h = Math.min(h, Math.floor(DASHSCOPE_MAX_PIXELS / w));
      h = Math.floor(h / 16) * 16;
    }
    return `${w}*${h}`;
  }
  const scale = Math.sqrt(DASHSCOPE_MIN_PIXELS / pixels);
  w = Math.max(384, Math.round((w * scale) / 16) * 16);
  h = Math.max(384, Math.round((h * scale) / 16) * 16);
  return `${w}*${h}`;
}

// 从 DashScope 返回的 output.choices 中取第一张图 URL（兼容 type 为 "image" 或 仅有 image 字段）
function parseDashScopeImageUrl(data) {
  const choices = data?.output?.choices;
  if (!Array.isArray(choices)) return null;
  for (const c of choices) {
    const content = c?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part) continue;
      if (part.image && (part.type === 'image' || !part.type)) return part.image;
    }
  }
  return null;
}

// Gemini 支持的宽高比标签 → 数值 w/h（与 API 一致）
const GEMINI_ASPECT_NUMERIC = [
  ['21:9', 21 / 9],
  ['16:9', 16 / 9],
  ['3:2', 3 / 2],
  ['4:3', 4 / 3],
  ['5:4', 5 / 4],
  ['1:1', 1],
  ['4:5', 4 / 5],
  ['3:4', 3 / 4],
  ['2:3', 2 / 3],
  ['9:16', 9 / 16],
];

/** 按像素尺寸选最接近的 Gemini aspectRatio（对数距离，避免 1440×2560 被误判为 4:5） */
function closestGeminiAspectRatioFromPixels(w, h) {
  if (!w || !h) return '1:1';
  const r = w / h;
  let best = '1:1';
  let bestD = Infinity;
  for (const [label, tr] of GEMINI_ASPECT_NUMERIC) {
    const d = Math.abs(Math.log(r) - Math.log(tr));
    if (d < bestD) {
      bestD = d;
      best = label;
    }
  }
  return best;
}

// Gemini 图片生成支持的比例：1:1 / 16:9 / 9:16 / 4:3 / 3:4 / 3:2 / 2:3 / 5:4 / 4:5 / 21:9
function geminiAspectRatio(size) {
  if (!size || typeof size !== 'string') return '16:9';
  const s = String(size).trim().toLowerCase().replace(/\s/g, '');
  const ratioSet = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '21:9']);
  if (ratioSet.has(s)) return s;
  const match = s.match(/^(\d+)[x*](\d+)$/);
  if (!match) return '1:1';
  const w = parseInt(match[1], 10);
  const h = parseInt(match[2], 10);
  return closestGeminiAspectRatioFromPixels(w, h);
}

function parseSizeWxHForGemini(size) {
  const match = String(size || '').trim().toLowerCase().replace(/\s/g, '').match(/^(\d+)[x*](\d+)$/);
  if (!match) return null;
  const w = parseInt(match[1], 10);
  const h = parseInt(match[2], 10);
  if (!w || !h) return null;
  return { w, h };
}

/**
 * Google 官方 REST：宽高比在 generationConfig.imageConfig.aspectRatio（不是顶层 aspectRatio）。
 * 顶层字段会被忽略 → 行为变为「匹配参考图尺寸」或近 1:1；参考图多为横屏四视图时成片易为横屏，
 * 再在本地 contain 到 9:16 就会出现上下黑边。
 * imageSize（1K/2K/4K）见官方文档，仅 gemini-3.x 图生模型支持；2.5 不传。
 */
function buildGeminiImageConfig(aspectRatio, modelName, size) {
  const imageConfig = { aspectRatio };
  const m = String(modelName || '').toLowerCase();
  const supportsImageSize =
    m.includes('gemini-3') || m.includes('3.1-flash-image') || m.includes('3-pro-image');
  if (supportsImageSize) {
    const px = parseSizeWxHForGemini(size);
    const longEdge = px ? Math.max(px.w, px.h) : 0;
    // 与项目里常见 1440/2560 档位对齐用 2K；仅小尺寸用 1K（避免默认 4K token 暴涨）
    imageConfig.imageSize = longEdge >= 1200 ? '2K' : '1K';
  }
  return imageConfig;
}

// nano-banana size 转 aspectRatio（1:1 / 16:9 / 9:16 / 4:3 / 3:4 / 3:2 / 2:3 / 5:4 / 4:5 / 21:9 / auto）
function nanoBananaAspectRatio(size) {
  if (!size || typeof size !== 'string') return 'auto';
  const s = String(size).trim().toLowerCase().replace(/\s/g, '');
  const ratioSet = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '21:9']);
  if (ratioSet.has(s)) return s;
  const match = s.match(/^(\d+)[x*](\d+)$/);
  if (!match) return 'auto';
  const w = parseInt(match[1], 10);
  const h = parseInt(match[2], 10);
  if (!w || !h) return 'auto';
  return closestGeminiAspectRatioFromPixels(w, h);
}

// 可灵 aspect_ratio：16:9 / 9:16 / 1:1 / 4:3 / 3:4 / 3:2 / 2:3
function klingImageAspectRatio(size) {
  if (!size) return '16:9';
  const s = String(size).trim().toLowerCase().replace(/\s/g, '');
  const ratioSet = new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3']);
  if (ratioSet.has(s)) return s;
  const match = s.match(/^(\d+)[x*](\d+)$/);
  if (!match) return '1:1';
  const w = parseInt(match[1], 10);
  const h = parseInt(match[2], 10);
  if (!w || !h) return '1:1';
  const r = w / h;
  if (r >= 1.6) return '16:9';
  if (r >= 1.2) return '4:3';
  if (r >= 0.9) return '1:1';
  if (r >= 0.7) return '3:4';
  return '9:16';
}

function buildKlingImageQueryUrl(baseUrl, endpoint, queryEndpoint, taskId) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  const ep = String(endpoint || '/v1/images/generations');
  const configured = String(queryEndpoint || '').trim();
  const queryPath = configured || `${ep.replace(/\/$/, '')}/{taskId}`;
  const normalizedPath = queryPath.startsWith('/') ? queryPath : '/' + queryPath;
  const encodedTaskId = encodeURIComponent(String(taskId));
  return base + normalizedPath
    .replace(/\{taskId\}/gi, encodedTaskId)
    .replace(/\{task_id\}/gi, encodedTaskId)
    .replace(/\{id\}/gi, encodedTaskId);
}

function parseKlingImagePollResult(data) {
  const status = data?.data?.task_status;
  if (status === 'succeed') {
    const imageUrl = data?.data?.task_result?.images?.[0]?.url;
    return imageUrl
      ? { state: 'completed', imageUrl }
      : { state: 'failed', error: '可灵未返回图片地址' };
  }
  if (status === 'failed') {
    return { state: 'failed', error: data?.data?.task_status_msg || '任务失败' };
  }
  return { state: status || 'processing' };
}

/**
 * 调用可灵（Kling AI）图片生成 API（异步任务轮询）
 * 支持模型：kling-image / kling-omni-image（以及其他 kling-* 模型）
 * 接口规范：POST /v1/images/generations → 轮询 GET /v1/images/generations/{taskId}
 * 认证：Authorization: Bearer {api_key}
 */
async function callKlingImageApi(config, log, opts) {
  const { prompt, model, size, image_gen_id, reference_image_urls, files_base_url, storage_local_path } = opts;
  const base = (config.base_url || 'https://api.klingai.com').replace(/\/$/, '');
  const apiKey = resolveKlingBearerToken(config);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + apiKey,
  };

  let ep = config.endpoint || '/v1/images/generations';
  if (!ep.startsWith('/')) ep = '/' + ep;
  const submitUrl = base + ep;

  const aspectRatio = klingImageAspectRatio(size);
  const m = model || 'kling-image';

  const rawRefs = Array.isArray(reference_image_urls) ? reference_image_urls.filter(Boolean) : [];
  const resolvedRefs = await compressResolvedImageRefsForJson(
    rawRefs.map((r) => resolveImageRef(r, files_base_url, storage_local_path)).filter(Boolean),
    { log },
  );

  const body = {
    model: m,
    prompt: prompt || '',
    aspect_ratio: aspectRatio,
    n: 1,
    callback_url: '',
  };

  if (resolvedRefs.length > 0) {
    // 可灵 image_reference 支持 subject（人物/主体）和 face（面部）类型
    body.image_reference = resolvedRefs.slice(0, 1).map((url) => ({ type: 'subject', url }));
    body.image_fidelity = 0.5;
  }

  const bodyForLog = { ...body };
  if (Array.isArray(bodyForLog.image_reference)) {
    bodyForLog.image_reference = bodyForLog.image_reference.map((r) =>
      r.url && r.url.startsWith('data:') ? { ...r, url: '(base64)' } : r
    );
  }
  log.info('[Kling图生] 发送请求', {
    url: submitUrl, model: m, image_gen_id,
    has_ref: resolvedRefs.length > 0,
    aspect_ratio: aspectRatio,
    body_preview: JSON.stringify(bodyForLog).slice(0, 300),
  });

  let submitRaw;
  let submitStatus;
  try {
    const out = await postJSONWithTimeout(submitUrl, headers, body, IMAGE_HTTP_TIMEOUT_MS);
    submitStatus = out.statusCode;
    submitRaw = out.raw;
  } catch (e) {
    log.error('[Kling图生] 网络错误', { image_gen_id, error: e.message });
    return { error: 'Kling 图片生成网络请求失败: ' + e.message };
  }

  if (submitStatus < 200 || submitStatus >= 300) {
    let errMsg = 'Kling 图片生成请求失败: ' + submitStatus;
    try {
      const errJson = JSON.parse(submitRaw);
      const msg = errJson.message || errJson.msg || (errJson.error && (errJson.error.message || errJson.error));
      if (msg) errMsg += ' - ' + String(msg).slice(0, 200);
    } catch (_) {
      if (submitRaw) errMsg += ' - ' + submitRaw.slice(0, 200);
    }
    log.error('[Kling图生] 请求失败', { status: submitStatus, body: submitRaw.slice(0, 500), image_gen_id });
    return { error: errMsg };
  }

  let submitData;
  try {
    submitData = JSON.parse(submitRaw);
  } catch (e) {
    return { error: 'Kling 返回格式异常: ' + submitRaw.slice(0, 200) };
  }

  if (submitData.code !== undefined && submitData.code !== 0) {
    return { error: `Kling 错误(${submitData.code}): ${submitData.message || '未知错误'}` };
  }

  // 部分场景可能同步返回图片（兜底）
  const directUrl = submitData?.data?.task_result?.images?.[0]?.url;
  if (directUrl) {
    log.info('[Kling图生] 同步返回图片', { image_gen_id });
    return { image_url: directUrl };
  }

  const taskId = submitData?.data?.task_id;
  if (!taskId) {
    log.warn('[Kling图生] 未返回 task_id', { image_gen_id, raw_preview: submitRaw.slice(0, 300) });
    return { error: 'Kling 未返回 task_id: ' + submitRaw.slice(0, 200) };
  }

  // 构建轮询 URL
  log.info('[Kling图生] 任务已提交，开始轮询', { image_gen_id, task_id: taskId });
  const maxAttempts = 60;
  const intervalMs = 4000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const queryUrl = buildKlingImageQueryUrl(base, ep, config.query_endpoint, taskId);
      const queryRes = await fetch(queryUrl, { method: 'GET', headers });
      if (!queryRes.ok) continue;
      const queryData = JSON.parse(await queryRes.text());
      const pollResult = parseKlingImagePollResult(queryData);
      log.info('[Kling图生] 轮询状态', { image_gen_id, task_id: taskId, attempt, status: pollResult.state });
      if (pollResult.state === 'completed') {
        if (pollResult.imageUrl) {
          log.info('[Kling图生] 生成完成', { image_gen_id, task_id: taskId });
          return { image_url: pollResult.imageUrl };
        }
        return { error: '可灵未返回图片地址' };
      }
      if (pollResult.state === 'failed') {
        const errMsg = pollResult.error || '任务失败';
        log.warn('[Kling图生] 任务失败', { image_gen_id, task_id: taskId, error: errMsg });
        return { error: '可灵生成失败: ' + errMsg };
      }
    } catch (e) {
      log.warn('[Kling图生] 轮询请求失败', { attempt, error: e.message, image_gen_id });
    }
  }
  return { error: '可灵图片生成超时' };
}

/**
 * 调用 NanoBanana 图片生成 API（异步任务轮询）
 * 模型 → 端点：
 *   nano-banana-2   → POST /api/v1/nanobanana/generate-2
 *   nano-banana-pro → POST /api/v1/nanobanana/generate-pro
 *   nano-banana     → POST /api/v1/nanobanana/generate（需 callBackUrl，用占位符）
 * 结果轮询：GET /api/v1/nanobanana/record-info?taskId=xxx
 */
async function callNanoBananaImageApi(config, log, opts) {
  const { prompt, model, size, image_gen_id, reference_image_urls, files_base_url, storage_local_path } = opts;
  const base = (config.base_url || 'https://api.nanobananaapi.ai').replace(/\/$/, '');
  const apiKey = config.api_key || '';
  const headers = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + apiKey,
  };
  // 解析参考图：本地路径 / localhost URL → base64，确保外部 API 可访问
  const rawRefs = Array.isArray(reference_image_urls) ? reference_image_urls.filter(Boolean) : [];
  const refs = rawRefs.map((r) => resolveImageRef(r, files_base_url, storage_local_path)).filter(Boolean);
  const aspectRatio = nanoBananaAspectRatio(size);
  const m = (model || 'nano-banana-2').toLowerCase();

  // 标准 nano-banana 原生端点；若 config.endpoint 与这些不同，视为代理模式，直接使用配置的端点
  const NATIVE_ENDPOINTS = new Set([
    '/api/v1/nanobanana/generate-2',
    '/api/v1/nanobanana/generate-pro',
    '/api/v1/nanobanana/generate',
  ]);
  const cfgEp = config.endpoint ? (config.endpoint.startsWith('/') ? config.endpoint : '/' + config.endpoint) : '';
  const isProxyMode = cfgEp && !NATIVE_ENDPOINTS.has(cfgEp);

  let submitUrl;
  let body;
  if (isProxyMode) {
    submitUrl = base + cfgEp;
    const isNativeBananaModel = m.startsWith('nano-banana');
    if (isNativeBananaModel) {
      // FAL 代理等：转发 nano-banana 模型，使用 camelCase 字段
      body = {
        prompt: prompt || '',
        imageUrls: refs,
        aspectRatio: aspectRatio === 'auto' ? '16:9' : aspectRatio,
        resolution: '1K',
      };
    } else {
      // 通用代理（如 dmiapi）：模型名直接透传，使用 snake_case 字段
      body = {
        model: model || '',
        prompt: prompt || '',
        aspect_ratio: aspectRatio === 'auto' ? '16:9' : (aspectRatio || ''),
        image_size: '1K',
        ...(refs.length > 0 ? { imageUrls: refs } : {}),
      };
    }
  } else if (m === 'nano-banana-2') {
    submitUrl = base + '/api/v1/nanobanana/generate-2';
    body = {
      prompt: prompt || '',
      imageUrls: refs,
      aspectRatio,
      resolution: '1K',
      outputFormat: 'jpg',
    };
  } else if (m === 'nano-banana-pro') {
    submitUrl = base + '/api/v1/nanobanana/generate-pro';
    body = {
      prompt: prompt || '',
      imageUrls: refs,
      aspectRatio: aspectRatio === 'auto' ? '16:9' : aspectRatio,
      resolution: '2K',
    };
  } else {
    // nano-banana 基础模型：callBackUrl 为必填，提供占位 URL（服务端轮询结果）
    submitUrl = base + '/api/v1/nanobanana/generate';
    body = {
      prompt: prompt || '',
      type: refs.length > 0 ? 'IMAGETOIAMGE' : 'TEXTTOIAMGE',
      imageUrls: refs,
      image_size: (aspectRatio === 'auto' ? '16:9' : aspectRatio),
      numImages: 1,
      callBackUrl: 'https://placeholder.no-op/callback',
    };
  }

  const bodyForLog = { ...body };
  if (Array.isArray(bodyForLog.imageUrls)) {
    bodyForLog.imageUrls = bodyForLog.imageUrls.map((u) => (u && u.startsWith('data:') ? '(base64)' : u));
  }
  log.info('NanoBanana Image API request', {
    url: submitUrl,
    model: m,
    image_gen_id,
    proxy_mode: isProxyMode,
    auth_header_prefix: (headers.Authorization || '').slice(0, 20) + '…',
    body_keys: Object.keys(body),
    body_preview: JSON.stringify(bodyForLog).slice(0, 300),
  });
  let submitRaw;
  let submitStatus;
  try {
    const out = await postJSONWithTimeout(submitUrl, headers, body, IMAGE_HTTP_TIMEOUT_MS);
    submitStatus = out.statusCode;
    submitRaw = out.raw;
  } catch (e) {
    log.error('NanoBanana submit network error', { image_gen_id, error: e.message });
    return { error: 'NanoBanana 图片生成网络请求失败: ' + e.message };
  }
  if (submitStatus < 200 || submitStatus >= 300) {
    let errMsg = 'NanoBanana 图片生成请求失败: ' + submitStatus;
    try {
      const errJson = JSON.parse(submitRaw);
      const msg = errJson.msg || errJson.message || (errJson.error && (errJson.error.message || errJson.error));
      if (msg) errMsg += ' - ' + String(msg).slice(0, 200);
    } catch (_) {
      if (submitRaw) errMsg += ' - ' + submitRaw.slice(0, 200);
    }
    log.error('NanoBanana submit failed', {
      status: submitStatus,
      body: submitRaw.slice(0, 500),
      image_gen_id,
      submit_url: submitUrl,
      auth_header_prefix: (headers.Authorization || '').slice(0, 20) + '…',
    });
    return { error: errMsg };
  }
  let submitData;
  try {
    submitData = JSON.parse(submitRaw);
  } catch (e) {
    return { error: 'NanoBanana 返回格式异常' };
  }

  // 兼容同步代理响应：部分代理直接返回图片 URL，无需轮询
  // 也兼容提交即完成的响应（state=succeeded + data.data.images[0].url）
  const sdTopImages = submitData?.images;
  const sd0 = Array.isArray(sdTopImages) ? sdTopImages[0] : null;
  const sdTopFirst = typeof sd0 === 'string' && sd0 && !/^https?:\/\//i.test(sd0) && !sdTopImages[0]?.url
    ? (sd0.startsWith('data:') ? sd0 : `data:image/png;base64,${sd0.replace(/\s/g, '')}`)
    : null;
  const directImageUrl = submitData?.images?.[0]?.url
    || sdTopFirst
    || submitData?.image?.url
    || submitData?.image_url
    || submitData?.data?.url
    || submitData?.url
    || (submitData?.data?.state === 'succeeded' ? submitData?.data?.data?.images?.[0]?.url : null);
  if (directImageUrl) {
    log.info('NanoBanana image (synchronous proxy response)', { image_gen_id });
    return { image_url: directImageUrl };
  }

  // task_id 兼容驼峰（taskId）和下划线（task_id）两种格式
  const taskId = submitData?.data?.taskId || submitData?.data?.task_id || submitData?.request_id || submitData?.taskId;
  if (!taskId) {
    const msg = submitData?.msg || submitData?.message || '未返回任务ID';
    log.warn('NanoBanana no taskId in response', { image_gen_id, raw_preview: submitRaw.slice(0, 300) });
    return { error: 'NanoBanana 提交失败: ' + String(msg).slice(0, 200) };
  }

  // 构建轮询 URL：优先用配置的 query_endpoint，否则用默认
  // 支持占位符 {taskId} / {taskid} / {task_id} / {id}（大小写不敏感）
  const DEFAULT_QUERY_EP = '/api/v1/nanobanana/record-info';
  const cfgQEp = config.query_endpoint
    ? (config.query_endpoint.startsWith('/') ? config.query_endpoint : '/' + config.query_endpoint)
    : '';
  const useQueryEp = cfgQEp && cfgQEp !== DEFAULT_QUERY_EP ? cfgQEp : DEFAULT_QUERY_EP;
  function buildQueryUrl(tid) {
    // 大小写不敏感替换所有常见占位符：{taskId} / {taskid} / {task_id} / {id}
    if (/\{(taskId|taskid|task_id|id)\}/i.test(useQueryEp)) {
      return base + useQueryEp
        .replace(/\{taskId\}/gi, encodeURIComponent(tid))
        .replace(/\{task_id\}/gi, encodeURIComponent(tid))
        .replace(/\{id\}/gi, encodeURIComponent(tid));
    }
    return base + useQueryEp + '?taskId=' + encodeURIComponent(tid);
  }

  const firstQueryUrl = buildQueryUrl(taskId);
  log.info('NanoBanana task submitted, polling…', {
    image_gen_id, task_id: taskId,
    query_ep: useQueryEp,
    first_query_url: firstQueryUrl,
    config_query_endpoint: config.query_endpoint || '(not set)',
  });
  const maxAttempts = 60;
  const intervalMs = 3000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const pollUrl = buildQueryUrl(taskId);
    try {
      const queryRes = await fetch(pollUrl, {
        method: 'GET',
        headers,
      });
      const queryRaw = await queryRes.text();
      if (!queryRes.ok) {
        log.warn('NanoBanana poll HTTP error', {
          image_gen_id, task_id: taskId, attempt,
          poll_url: pollUrl,
          status: queryRes.status,
          body_preview: queryRaw.slice(0, 300),
        });
        continue;
      }
      let queryData;
      try {
        queryData = JSON.parse(queryRaw);
      } catch (parseErr) {
        log.warn('NanoBanana poll JSON parse error', {
          image_gen_id, task_id: taskId, attempt,
          poll_url: pollUrl,
          raw_preview: queryRaw.slice(0, 300),
        });
        continue;
      }
      const successFlag = queryData?.data?.successFlag;
      const state = queryData?.data?.state;
      const status = queryData?.data?.status;
      log.info('NanoBanana poll status', {
        image_gen_id, task_id: taskId, attempt,
        code: queryData?.code, successFlag, state, status,
      });
      if (successFlag === 1 || state === 'succeeded' || status === '3') {
        const respImgs = queryData?.data?.response?.images;
        const fromSdWrapped = Array.isArray(respImgs) && typeof respImgs[0] === 'string' && respImgs[0].length > 0
          ? (respImgs[0].startsWith('data:') ? respImgs[0] : `data:image/png;base64,${respImgs[0].replace(/\s/g, '')}`)
          : null;
        const imageUrl = queryData?.data?.response?.resultImageUrl
          || queryData?.data?.response?.originImageUrl
          || queryData?.data?.data?.images?.[0]?.url
          || fromSdWrapped;
        if (imageUrl) {
          log.info('NanoBanana image completed', { image_gen_id, task_id: taskId, image_url: imageUrl.slice(0, 120) });
          return { image_url: imageUrl };
        }
        log.warn('NanoBanana succeeded but no image URL found', {
          image_gen_id, task_id: taskId,
          data_keys: queryData?.data ? Object.keys(queryData.data) : [],
          nested_data_keys: queryData?.data?.data ? Object.keys(queryData.data.data) : [],
          response_keys: queryData?.data?.response ? Object.keys(queryData.data.response) : [],
          raw_preview: queryRaw.slice(0, 500),
        });
        return { error: '未返回图片地址' };
      }
      if (successFlag === 2 || successFlag === 3 || state === 'failed') {
        const errMsg = queryData?.data?.errorMessage || queryData?.data?.msg || '任务失败';
        log.warn('NanoBanana task failed', { image_gen_id, task_id: taskId, successFlag, state, error_message: errMsg });
        return { error: 'NanoBanana 生成失败: ' + errMsg };
      }
    } catch (e) {
      log.warn('NanoBanana poll request failed', { attempt, error: e.message, image_gen_id, poll_url: pollUrl });
    }
  }
  return { error: 'NanoBanana 图片生成超时' };
}

// 通义千问 qwen-image 同步接口：仅支持单条 text，不支持参考图；parameters 仅 size/negative_prompt/prompt_extend/watermark
function isQwenImageProvider(config, model) {
  const p = (config.provider || '').toLowerCase();
  const m = (model || '').toLowerCase();
  return p === 'qwen_image' || /^qwen-image/.test(m);
}

// qwen-image 仅支持以下 size：1664*928(16:9), 1472*1104(4:3), 1328*1328(1:1), 1104*1472(3:4), 928*1664(9:16)
function qwenImageSize(size) {
  const allowed = ['1664*928', '1472*1104', '1328*1328', '1104*1472', '928*1664'];
  if (!size || typeof size !== 'string') return '1664*928';
  const s = String(size).trim().toLowerCase().replace(/x/g, '*');
  const match = s.match(/^(\d+)\s*\*\s*(\d+)$/);
  if (!match) return '1664*928';
  const w = parseInt(match[1], 10);
  const h = parseInt(match[2], 10);
  if (!w || !h) return '1664*928';
  const ratio = w / h;
  if (ratio >= 1.7) return '1664*928';   // 16:9
  if (ratio >= 1.2) return '1472*1104';   // 4:3
  if (ratio >= 0.85) return '1328*1328';  // 1:1
  if (ratio >= 0.65) return '1104*1472';  // 3:4
  return '928*1664';                      // 9:16
}

/**
 * 将参考图值解析为适合传给外部 API 的形式：
 * - 本地相对路径（如 "characters/ig_xxx.jpg"）→ 读文件转 base64 data URL
 * - localhost URL → 从 storageLocalPath 读文件转 base64 data URL
 * - 公网 URL（非 localhost）→ 直接原样返回
 *
 * 调用方应优先传 local_path 而非 image_url，
 * 以避免外部存储链接过期或第三方 API 无法访问的问题。
 */
function resolveImageRef(value, filesBaseUrl, storageLocalPath) {
  if (!value || !String(value).trim()) return null;
  const s = String(value).trim();
  if (s.startsWith('data:')) return s;
  const baseUrl = (filesBaseUrl || '').replace(/\/$/, '');
  // isLocalhost: 只要 URL 本身或配置的 base_url 含 localhost/127，都视为本地
  const isLocalhostUrl = /localhost|127\.0\.0\.1/i.test(s);
  const isLocalhostBase = baseUrl && /localhost|127\.0\.0\.1/i.test(baseUrl);
  const isLocalhost = isLocalhostUrl || isLocalhostBase;

  function toPublicUrl(v) {
    if (!v || !String(v).trim()) return null;
    const sv = String(v).trim();
    if (sv.startsWith('http://') || sv.startsWith('https://')) return sv;
    if (baseUrl) return baseUrl + '/' + sv.replace(/^\//, '');
    return sv;
  }

  let relPath = null;
  const isStaticPath = /^\/?static\//.test(s);
  const absoluteInput = (path.isAbsolute(s) || path.win32.isAbsolute(s)) && !isStaticPath;
  if (s.startsWith('http://') || s.startsWith('https://')) {
    if (!isLocalhost || !storageLocalPath) return s;
    // 从 URL 中提取 /static/ 之后的相对路径；或去掉 baseUrl 前缀
    const afterStatic = s.split('/static/')[1]
      || (baseUrl ? s.replace(baseUrl + '/', '').replace(baseUrl, '') : null)
      || s.replace(/^https?:\/\/[^/]+\//, '');
    if (afterStatic) relPath = afterStatic.replace(/^\//, '');
    else return s;
  } else if (storageLocalPath && !absoluteInput) {
    relPath = s.split(/[?#]/, 1)[0].replace(/^\/?static\//, '').replace(/^\/+/, '');
  }
  if (absoluteInput && !storageLocalPath) return null;
  if (!relPath && !absoluteInput) return toPublicUrl(s);
  let decodedRelPath;
  try {
    decodedRelPath = decodeURIComponent(absoluteInput ? s.split(/[?#]/, 1)[0] : relPath);
  } catch (_) {
    return toPublicUrl(s);
  }
  const storageRoot = path.resolve(storageLocalPath);
  const filePath = absoluteInput ? path.resolve(decodedRelPath) : path.resolve(storageRoot, decodedRelPath);
  if (filePath !== storageRoot && !filePath.startsWith(storageRoot + path.sep)) {
    return absoluteInput ? null : toPublicUrl(s);
  }
  try {
    const realStorageRoot = fs.realpathSync.native(storageRoot);
    const realFilePath = fs.realpathSync.native(filePath);
    const relative = path.relative(realStorageRoot, realFilePath);
    if (
      !relative
      || relative.startsWith('..')
      || path.isAbsolute(relative)
      || !fs.statSync(realFilePath).isFile()
    ) {
      return null;
    }
    const buf = fs.readFileSync(realFilePath);
    const ext = path.extname(realFilePath).toLowerCase();
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp' }[ext] || 'image/png';
    return 'data:' + mime + ';base64,' + buf.toString('base64');
  } catch (_) {
    return path.isAbsolute(s) ? null : toPublicUrl(s);
  }
}

function resolveUsmercariPublicImageRef(value, filesBaseUrl, storageLocalPath) {
  if (!value || !String(value).trim()) return null;
  const raw = String(value).trim();
  const base = String(filesBaseUrl || '').trim().replace(/\/+$/, '');
  let baseUrl;
  try {
    baseUrl = new URL(base);
    if (!usmercariImageClient.parseStorageBaseUrl(base)) return null;
  } catch (_) {
    return null;
  }
  if (/^https?:\/\//i.test(raw)) {
    return usmercariImageClient.isAllowedStoragePublicImageUrl(raw, base) ? raw : null;
  }

  let relative = raw.split(/[?#]/, 1)[0];
  if (path.isAbsolute(relative) && !/^[/\\]static[/\\]/i.test(relative)) {
    if (!storageLocalPath) return null;
    const storageRoot = path.resolve(storageLocalPath);
    const absolute = path.resolve(relative);
    const withinRoot = absolute !== storageRoot && absolute.startsWith(storageRoot + path.sep);
    if (!withinRoot) return null;
    relative = path.relative(storageRoot, absolute);
  }
  relative = relative.replace(/\\/g, '/').replace(/^\/+/, '');
  let decoded;
  try { decoded = decodeURIComponent(relative); } catch (_) { return null; }
  if (decoded.split('/').includes('..')) return null;
  const baseEndsWithStatic = /\/static\/?$/i.test(baseUrl.pathname);
  if (baseEndsWithStatic) relative = relative.replace(/^static\//i, '');
  const resolved = `${base}/${relative}`;
  return usmercariImageClient.isAllowedStoragePublicImageUrl(resolved, base) ? resolved : null;
}

// 通义万象：支持参考图（角色/场景），content 为 [text, image, image, ...]；本地调试时参考图可转 base64
// 通义千问 qwen-image：仅支持 content 中一个 text，用同步接口，parameters 不含 stream/enable_interleave
async function callDashScopeImageApi(config, log, opts) {
  const { prompt, model, size, image_gen_id, reference_image_urls, files_base_url, storage_local_path, negative_prompt } = opts;
  const base = (config.base_url || '').replace(/\/$/, '');
  const url = base + (config.endpoint || '/api/v1/services/aigc/multimodal-generation/generation');
  if (!url.includes('dashscope')) {
    return { error: '通义万象 base_url 需为 https://dashscope.aliyuncs.com' };
  }
  const isQwenImage = isQwenImageProvider(config, model);

  if (isQwenImage) {
    // 千问文生图：仅支持单条 text，长度不超过 800 字符；同步接口，无 stream/enable_interleave
    const text = (prompt || '').toString().trim().slice(0, 800);
    const body = {
      model: model || 'qwen-image-max',
      input: {
        messages: [{ role: 'user', content: [{ text }] }],
      },
      parameters: {
        prompt_extend: true,
        watermark: false,
        size: qwenImageSize(size),
      },
    };
    if (negative_prompt && String(negative_prompt).trim()) {
      body.parameters.negative_prompt = String(negative_prompt).trim().slice(0, 500);
    }
    log.info('Image API request (Qwen-Image sync)', { url: url.slice(0, 70), model: body.model, image_gen_id });
    const qwenHeaders = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (config.api_key || ''),
    };
    let raw;
    let httpStatus;
    try {
      const out = await postJSONWithTimeout(url, qwenHeaders, body, IMAGE_HTTP_TIMEOUT_MS);
      httpStatus = out.statusCode;
      raw = out.raw;
    } catch (e) {
      log.error('Qwen-Image network error', { image_gen_id, error: e.message });
      return { error: '图片生成网络请求失败: ' + e.message };
    }
    if (httpStatus < 200 || httpStatus >= 300) {
      let errMsg = '图片生成请求失败: ' + httpStatus;
      try {
        const errJson = JSON.parse(raw);
        if (errJson.message) errMsg += ' - ' + errJson.message;
        else if (errJson.code) errMsg += ' - ' + errJson.code;
      } catch (_) {
        if (raw && raw.length) errMsg += ' - ' + raw.slice(0, 200);
      }
      log.error('Qwen-Image create failed', { status: httpStatus, body: raw.slice(0, 300), image_gen_id });
      return { error: errMsg };
    }
    try {
      const data = JSON.parse(raw);
      if (data.code) {
        log.warn('Qwen-Image response error', { code: data.code, message: data.message, image_gen_id });
        return { error: data.message || data.code || '通义千问接口错误' };
      }
      const imageUrl = parseDashScopeImageUrl(data);
      if (imageUrl) {
        log.info('Qwen-Image image (sync)', { image_gen_id, has_image_url: true });
        return { image_url: imageUrl };
      }
      return { error: '未返回图片地址' };
    } catch (e) {
      log.warn('Qwen-Image parse error', { image_gen_id, error: e.message, raw_preview: raw.slice(0, 300) });
      return { error: '通义千问返回格式异常' };
    }
  }

  const refs = Array.isArray(reference_image_urls) ? reference_image_urls.filter(Boolean) : [];
  const content = [{ text: prompt || '' }];
  const resolvedRefs = [];
  for (const ref of refs.slice(0, 10)) {
    const img = resolveImageRef(ref, files_base_url, storage_local_path);
    if (img) {
      content.push({ image: img });
      resolvedRefs.push(img.startsWith('data:') ? '(base64)' : img);
    }
  }
  log.info('reference_image_urls 完整路径（imageClient 入参及解析后）', {
    image_gen_id,
    raw_reference_image_urls: reference_image_urls || [],
    resolved_for_api: resolvedRefs,
  });

  const hasRefs = content.length > 1;
  const stream = !hasRefs; // enable_interleave=false 时必须 stream=false
  const body = {
    model: model || 'wan2.6-image',
    input: {
      messages: [{ role: 'user', content }],
    },
    parameters: {
      prompt_extend: true,
      watermark: false,
      n: 1,
      enable_interleave: !hasRefs,
      size: dashScopeSize(size),
      stream,
      ...(negative_prompt ? { negative_prompt } : {}),
    },
  };
  const contentSummary = content.map((p) => (p.text != null ? 'text' : p.image && p.image.startsWith('data:') ? 'image(base64)' : 'image(url)'));
  log.info('Image API request (DashScope)', {
    url: url.slice(0, 70),
    model: body.model,
    image_gen_id,
    reference_count: refs.length,
    enable_interleave: body.parameters.enable_interleave,
    stream: body.parameters.stream,
    content_parts: contentSummary,
  });
  const headers = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + (config.api_key || ''),
  };
  if (stream) headers['X-DashScope-Sse'] = 'enable';
  let raw;
  let httpStatus;
  try {
    const out = await postJSONWithTimeout(url, headers, body, IMAGE_HTTP_TIMEOUT_MS);
    httpStatus = out.statusCode;
    raw = out.raw;
  } catch (e) {
    log.error('DashScope network error', { image_gen_id, error: e.message });
    return { error: '图片生成网络请求失败: ' + e.message };
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    let errMsg = '图片生成请求失败: ' + httpStatus;
    try {
      const errJson = JSON.parse(raw);
      if (errJson.message) errMsg += ' - ' + errJson.message;
      else if (errJson.code) errMsg += ' - ' + errJson.code;
    } catch (_) {
      if (raw && raw.length) errMsg += ' - ' + raw.slice(0, 200);
    }
    log.error('DashScope create failed', { status: httpStatus, body: raw.slice(0, 300), image_gen_id });
    return { error: errMsg };
  }

  if (!stream) {
    // 非流式：单次 JSON 响应
    try {
      const data = JSON.parse(raw);
      if (data.code) {
        log.warn('DashScope response error', { code: data.code, message: data.message, image_gen_id });
        return { error: data.message || data.code || '通义万象接口错误' };
      }
      const imageUrl = parseDashScopeImageUrl(data);
      if (imageUrl) {
        log.info('DashScope image (sync)', { image_gen_id, has_image_url: true });
        return { image_url: imageUrl };
      }
      log.warn('DashScope sync no image in response', {
        image_gen_id,
        output_keys: data.output ? Object.keys(data.output) : [],
        raw_preview: raw.slice(0, 500),
      });
      return { error: '未返回图片地址' };
    } catch (e) {
      log.warn('DashScope sync parse error', { image_gen_id, error: e.message, raw_preview: raw.slice(0, 300) });
      return { error: '通义万象返回格式异常' };
    }
  }

  // 流式响应：可能是纯 JSON 行，或 SSE 格式 "data: {...}\n"
  let lastImageUrl = null;
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  let firstChunkKeys = null;
  for (const line of lines) {
    let jsonStr = line;
    if (line.startsWith('data:')) {
      jsonStr = line.slice(5).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;
    }
    try {
      const data = JSON.parse(jsonStr);
      if (data.code) {
        log.warn('DashScope stream chunk error', { code: data.code, message: data.message, image_gen_id });
        return { error: data.message || data.code || '通义万象接口错误' };
      }
      if (firstChunkKeys == null && data.output) {
        const oc = data.output.choices?.[0];
        firstChunkKeys = {
          output_keys: Object.keys(data.output),
          choice_message_keys: oc?.message ? Object.keys(oc.message) : [],
          content_types: Array.isArray(oc?.message?.content) ? oc.message.content.map((p) => p && p.type) : [],
        };
      }
      const urlFromChunk = parseDashScopeImageUrl(data);
      if (urlFromChunk) lastImageUrl = urlFromChunk;
    } catch (_) {
      // 忽略非 JSON 行
    }
  }
  if (lastImageUrl) {
    log.info('DashScope image (stream)', { image_gen_id, has_image_url: true });
    return { image_url: lastImageUrl };
  }
  if (lines.length > 0) {
    try {
      const firstLine = lines[0].startsWith('data:') ? lines[0].slice(5).trim() : lines[0];
      const first = JSON.parse(firstLine);
      if (first.code) return { error: first.message || first.code || '通义万象接口错误' };
    } catch (_) {}
  }
  log.warn('DashScope stream no image in response', {
    image_gen_id,
    line_count: lines.length,
    first_chunk: firstChunkKeys,
    raw_preview: raw.slice(0, 400),
  });
  return { error: '未返回图片地址' };
}

// 图床上传：复用 uploadService 的共享实现
const { uploadToImageProxy } = require('./uploadService');

/**
 * 从 image_proxy_cache 表查询已缓存的图床 URL。
 * cache_key 规则：本地相对路径 或 data URL 的 sha256 前 16 字符。
 * 若缓存已过期（超过 config.image_proxy.expire_hours），自动删除并返回 null，触发重新上传。
 */
function getProxyCache(db, cacheKey) {
  try {
    const row = db.prepare('SELECT proxy_url, created_at FROM image_proxy_cache WHERE cache_key = ?').get(cacheKey);
    if (!row?.proxy_url) return null;

    const expireMs = getProxyExpireHours() * 3600 * 1000;
    const createdAt = new Date(row.created_at).getTime();
    if (isNaN(createdAt) || Date.now() - createdAt > expireMs) {
      // 过期或时间无效：删除旧记录，返回 null 触发重新上传
      deleteProxyCache(db, cacheKey);
      return null;
    }

    return row.proxy_url;
  } catch (_) { return null; }
}

function deleteProxyCache(db, cacheKey) {
  try { db.prepare('DELETE FROM image_proxy_cache WHERE cache_key = ?').run(cacheKey); } catch (_) {}
}

/** 探测图床 URL 是否仍可访问（远端拉取失败时视为失效） */
async function isProxyUrlAlive(url, timeoutMs = 8000) {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  const opts = { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' };
  try {
    let res = await fetch(url, opts);
    if (res.ok) return true;
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
    }
    return res.ok || res.status === 206;
  } catch (_) {
    return false;
  }
}

/**
 * 读取图床缓存并在使用前校验 URL 仍有效；404/超时等则删缓存并返回 null 以触发重新上传。
 */
async function getProxyCacheValidated(db, cacheKey, log, tag) {
  const url = getProxyCache(db, cacheKey);
  if (!url) return null;
  if (await isProxyUrlAlive(url)) return url;
  deleteProxyCache(db, cacheKey);
  log?.warn?.('[图床缓存] URL 已失效，将重新上传', { tag, cache_key: cacheKey, url_head: url.slice(0, 80) });
  return null;
}

/** 写入 image_proxy_cache 缓存记录 */
function setProxyCache(db, cacheKey, proxyUrl) {
  try {
    db.prepare(
      'INSERT OR REPLACE INTO image_proxy_cache (cache_key, proxy_url, created_at) VALUES (?, ?, ?)'
    ).run(cacheKey, proxyUrl, new Date().toISOString());
  } catch (_) {}
}

/** 根据 ref 字符串计算缓存 key：本地路径直接使用；data URL 取 buffer sha256 前 16 字节的 hex */
function buildCacheKey(ref, imageBuffer) {
  if (!ref.startsWith('data:')) return ref;
  return 'sha256:' + crypto.createHash('sha256').update(imageBuffer).digest('hex').slice(0, 32);
}

/**
 * 调用 Google Gemini 图片生成 API（generateContent 接口，返回 base64 inlineData）
 * 支持模型：gemini-2.5-flash-image / gemini-2.5-flash-image-preview /
 *          gemini-3.1-flash-image-preview / gemini-3-pro-image-preview 等
 * 参考图先查本地缓存表，未命中则上传到中转图床并缓存，再通过 fileData.fileUri 传给 Gemini。
 * 避免 inlineData base64 大 payload 触发 503 memory overload。
 */
async function callGeminiImageApi(db, config, log, opts) {
  const { prompt, model, size, image_gen_id, reference_image_urls, files_base_url, storage_local_path, system_prompt } = opts;
  const apiKey = config.api_key || '';
  const base = (config.base_url || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const modelName = model || 'gemini-2.5-flash-image';
  const aspectRatio = geminiAspectRatio(size);
  const geminiImageConfig = buildGeminiImageConfig(aspectRatio, modelName, size);
  const tStart = Date.now();
  const elapsed = () => `${Date.now() - tStart}ms`;

  log.info('[Gemini图生] ▶ 开始', {
    image_gen_id,
    model: modelName,
    imageConfig: geminiImageConfig,
    base_url: base.slice(0, 60),
    prompt_len: (prompt || '').length,
    raw_ref_count: Array.isArray(reference_image_urls) ? reference_image_urls.length : 0,
  });

  // 读取全局配置，判断参考图传输方式
  // image_proxy.use_for_gemini = false（默认）→ 直接 inlineData base64
  // image_proxy.use_for_gemini = true          → 上传图床后用 fileData.fileUri
  const globalCfg = (() => { try { return require('../config').loadConfig(); } catch (_) { return {}; } })();
  const useImageProxy = !!(globalCfg?.image_proxy?.use_for_gemini);
  log.info('[Gemini图生] 参考图传输方式', { image_gen_id, use_image_proxy: useImageProxy });

  const rawRefs = Array.isArray(reference_image_urls) ? reference_image_urls.filter(Boolean) : [];
  const MAX_GEMINI_REF_IMAGES = 4; // 场景 + 角色/道具等合计最多 4 张（由 imageService 组装顺序决定）

  // 解析 system_prompt 中的每张参考图标签（格式: "Image N: description..."）
  // Gemini 多模态的正确输入结构：[文字说明] → [图片] → [文字说明] → [图片] → [生成指令]
  // 即：每张参考图紧跟其说明文字，最后才是生成任务
  const refLabelMap = {}; // index(0-based) → label text
  if (system_prompt) {
    system_prompt.split('\n').forEach(line => {
      const m = line.match(/^Image\s+(\d+):\s*(.+)/i);
      if (m) refLabelMap[parseInt(m[1], 10) - 1] = m[2].trim(); // 转为 0-based index
    });
  }

  // 读取所有参考图（buffer + mimeType）
  const refImageParts = []; // { label, imagePart }
  const TOTAL_REF_LIMIT_BYTES = 10 * 1024 * 1024; // inlineData 模式总大小上限 10MB
  let totalRefSizeBytes = 0;
  for (let i = 0; i < rawRefs.slice(0, MAX_GEMINI_REF_IMAGES).length; i++) {
    const ref = rawRefs[i];
    log.info('[Gemini图生] 参考图 读取中', { image_gen_id, ref_index: i, ref: String(ref).slice(0, 80), elapsed: elapsed() });
    const tRead = Date.now();

    const resolved = resolveImageRef(ref, files_base_url, storage_local_path);
    if (!resolved) {
      log.warn('[Gemini图生] 参考图 无法解析，跳过', { image_gen_id, ref_index: i, ref: String(ref).slice(0, 80) });
      continue;
    }

    let imageBuffer, mimeType;
    if (resolved.startsWith('data:')) {
      const m = resolved.match(/^data:([\w/]+);base64,(.+)$/);
      if (!m) { log.warn('[Gemini图生] 参考图 data URL 格式异常，跳过', { image_gen_id, ref_index: i }); continue; }
      mimeType = m[1];
      imageBuffer = Buffer.from(m[2], 'base64');
    } else {
      try {
        const imgRes = await fetch(resolved, { method: 'GET' });
        if (!imgRes.ok) {
          log.warn('[Gemini图生] 参考图 HTTP 读取失败，跳过', { image_gen_id, ref_index: i, status: imgRes.status, url: resolved.slice(0, 80) });
          continue;
        }
        imageBuffer = Buffer.from(await imgRes.arrayBuffer());
        mimeType = (imgRes.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
      } catch (fetchErr) {
        log.warn('[Gemini图生] 参考图 读取异常，跳过', { image_gen_id, ref_index: i, err: fetchErr.message });
        continue;
      }
    }

    log.info('[Gemini图生] 参考图 读取完成', {
      image_gen_id, ref_index: i, mime: mimeType,
      size_kb: Math.round(imageBuffer.length / 1024),
      read_ms: Date.now() - tRead, elapsed: elapsed(),
    });

    // 超过 10MB 直接跳过（Gemini 硬限制）
    if (imageBuffer.length > 10 * 1024 * 1024) {
      log.warn('[Gemini图生] 参考图 超过10MB，跳过', { image_gen_id, ref_index: i, size_mb: (imageBuffer.length / 1024 / 1024).toFixed(1) });
      continue;
    }

    // ① 单张超过 2MB 时用 sharp 压缩到 2MB 以内
    if (imageBuffer.length > 2 * 1024 * 1024) {
      const compressed = await compressImageBuffer(imageBuffer, mimeType, 2048, log);
      imageBuffer = compressed.buffer;
      mimeType = compressed.mimeType;
    }

    // ② 总大小预算控制（inlineData 模式）：所有参考图合计不超过 10MB
    if (!useImageProxy) {
      const remaining = TOTAL_REF_LIMIT_BYTES - totalRefSizeBytes;
      if (imageBuffer.length > remaining) {
        const targetKB = Math.max(200, Math.floor(remaining / 1024));
        log.info('[Gemini图生] 参考图 总大小超预算，追加压缩', {
          image_gen_id, ref_index: i,
          current_kb: Math.round(imageBuffer.length / 1024),
          budget_kb: Math.round(remaining / 1024),
          target_kb: targetKB,
        });
        const compressed2 = await compressImageBuffer(imageBuffer, mimeType, targetKB, log);
        imageBuffer = compressed2.buffer;
        mimeType = compressed2.mimeType;
        if (imageBuffer.length > remaining) {
          log.warn('[Gemini图生] 参考图 追加压缩后仍超总预算，跳过', { image_gen_id, ref_index: i });
          continue;
        }
      }
      totalRefSizeBytes += imageBuffer.length;
    }

    let imagePart;
    if (useImageProxy) {
      const cacheKey = buildCacheKey(ref, imageBuffer);
      let fileUri = await getProxyCacheValidated(db, cacheKey, log, `gemini_ig${image_gen_id}_ref${i}`);
      if (fileUri) {
        log.info('[Gemini图生] 参考图 缓存命中（图床）', { image_gen_id, ref_index: i });
      } else {
        log.info('[Gemini图生] 参考图 缓存未命中，上传图床 →', { image_gen_id, ref_index: i, elapsed: elapsed() });
        fileUri = await uploadToImageProxy(imageBuffer, mimeType, log, image_gen_id);
        if (fileUri) {
          setProxyCache(db, cacheKey, fileUri);
        } else {
          log.warn('[Gemini图生] 参考图 上传图床失败，该参考图将跳过', { image_gen_id, ref_index: i, elapsed: elapsed() });
          continue;
        }
      }
      imagePart = { fileData: { fileUri, mimeType } };
    } else {
      imagePart = { inlineData: { mimeType, data: imageBuffer.toString('base64') } };
    }

    refImageParts.push({ label: refLabelMap[i] || null, imagePart });
    log.info('[Gemini图生] 参考图 已处理', { image_gen_id, ref_index: i, has_label: !!refLabelMap[i] });
  }

  // 构建 parts：正确的 Gemini 多模态输入顺序
  // [参考说明] → [参考图1] → [参考图2] → ... → [生成指令+主提示词]
  // 这与 Gemini 的 "文字描述紧接对应内容" 原则一致，避免模型混淆
  const parts = [];
  if (refImageParts.length > 0) {
    parts.push({ text: 'The following are visual reference images. Use them ONLY to maintain character appearance and scene environment consistency. Do NOT reproduce their layout or format.' });
    for (let i = 0; i < refImageParts.length; i++) {
      const { label, imagePart } = refImageParts[i];
      parts.push({ text: label ? `Reference ${i + 1}: ${label}` : `Reference ${i + 1}:` });
      parts.push(imagePart);
    }
    // 生成指令放在所有参考图之后，清晰分隔
    parts.push({ text: `Generate ONE single cinematic storyboard frame (do NOT create a grid or multi-panel layout):\n\n${prompt || ''}` });
  } else {
    // 无参考图：直接用 prompt
    parts.push({ text: prompt || '' });
  }

  log.info('[Gemini图生] 参考图处理完毕，准备请求 Gemini API', {
    image_gen_id, parts_count: parts.length, ref_parts: refImageParts.length, elapsed: elapsed(),
  });

  // 宽高比必须在 imageConfig 内（与 Google 官方 REST 一致）；顶层 aspectRatio 会被忽略。
  // 勿与 Imagen 的 imageGenerationConfig 混淆。
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      numberOfImages: 1,
      imageConfig: geminiImageConfig,
    },
  };

  const url = `${base}/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  log.info('[Gemini图生] → 发送请求', { image_gen_id, model: modelName, url: url.replace(/key=[^&]+/, 'key=***').slice(0, 120), elapsed: elapsed() });

  const tReq = Date.now();
  let geminiStatus;
  let raw;
  try {
    const out = await postJSONWithTimeout(
      url,
      { 'Content-Type': 'application/json' },
      body,
      IMAGE_HTTP_TIMEOUT_MS,
    );
    geminiStatus = out.statusCode;
    raw = out.raw;
  } catch (e) {
    log.error('[Gemini图生] ✗ 网络错误', { image_gen_id, error: e.message, total_elapsed: elapsed() });
    return { error: 'Gemini 图片生成网络请求失败: ' + e.message };
  }
  log.info('[Gemini图生] ← 收到响应', { image_gen_id, status: geminiStatus, req_ms: Date.now() - tReq, elapsed: elapsed() });

  if (geminiStatus < 200 || geminiStatus >= 300) {
    let errMsg = 'Gemini 图片生成请求失败: ' + geminiStatus;
    try {
      const errJson = JSON.parse(raw);
      const msg = errJson.error?.message || errJson.message;
      if (msg) errMsg += ' - ' + String(msg).slice(0, 200);
    } catch (_) {
      if (raw) errMsg += ' - ' + raw.slice(0, 200);
    }
    log.error('[Gemini图生] ✗ API错误', { image_gen_id, status: geminiStatus, body: raw.slice(0, 400), total_elapsed: elapsed() });
    return { error: errMsg };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    log.error('[Gemini图生] ✗ 响应 JSON 解析失败', { image_gen_id, raw_preview: raw.slice(0, 300), total_elapsed: elapsed() });
    return { error: 'Gemini 图片生成返回格式异常' };
  }

  // 从 candidates → content → parts 中找 inlineData（图片）
  const candidates = data?.candidates || [];
  for (const candidate of candidates) {
    for (const part of candidate?.content?.parts || []) {
      if (part.inlineData?.data) {
        const mimeType = part.inlineData.mimeType || 'image/png';
        const dataUrl = `data:${mimeType};base64,${part.inlineData.data}`;
        log.info('[Gemini图生] ✓ 成功', { image_gen_id, model: modelName, mime: mimeType, total_elapsed: elapsed() });
        return { image_url: dataUrl };
      }
    }
  }

  log.warn('[Gemini图生] ✗ 响应中无图片内容', { image_gen_id, candidates_count: candidates.length, raw_preview: raw.slice(0, 500), total_elapsed: elapsed() });
  return { error: 'Gemini 未返回图片内容，请检查模型名称或 API Key 权限' };
}

/**
 * 调用提供商图片生成 API（OpenAI /images/generations 风格 或 通义万象 multimodal-generation）
 * @param {object} db - database
 * @param {object} log - logger
 * @param {object} opts - { prompt, model?, size?, quality?, drama_id, preferred_provider?, character_id?, image_type?, image_gen_id, user_negative_prompt? }
 * @returns {Promise<{ image_url?: string, error?: string }>}
 */
async function submitImageWithConfig(db, log, config, opts, runtime = {}) {
  const {
    prompt,
    model: preferredModel,
    size,
    quality,
    resolution,
    image_gen_id,
    imageServiceType,
    reference_image_urls,
    files_base_url,
    storage_local_path,
    user_negative_prompt,
  } = opts;
  const model = getModelFromConfig(config, preferredModel);
  const provider = (config.provider || '').toLowerCase();
  const requestModel = provider === 'fumin_image'
    ? fuminImageClient.resolveFuminImageModel(model)
    : model;
  // api_protocol 显式指定接口规范，优先级高于 provider 推断；未设置时按 provider 自动判断
  const protocol = (config.api_protocol || '').toLowerCase() || inferProtocol(provider, model);
  if (usmercariImageClient.USMERCARI_IMAGE_MODELS[String(model || '').trim().toLowerCase()]
      && protocol !== 'usmercari_image') {
    throw imageGateError('MODEL_PROTOCOL_MISMATCH', `${model} 必须使用已验证的 USMercari 图片协议配置`);
  }
  const referenceCount = Array.isArray(reference_image_urls)
    ? reference_image_urls.filter(Boolean).length
    : 0;
  if (provider === 'fumin_image' && referenceCount > 0) {
    return {
      error: 'fumin GPT Image 当前不支持参考图（供应商文档未声明该能力），请改用已验证支持参考图的图片模型',
      route_meta: { phase: 'prepare', requestBodySent: false, explicitlyRejected: true },
    };
  }
  const referenceLimit = configuredImageReferenceLimit(config, model);
  if (referenceCount > referenceLimit) {
    return {
      error: referenceLimit === 0
        ? `${model} 当前不支持参考图`
        : `${model} 最多支持 ${referenceLimit} 个图片参考`,
    };
  }

  const effectivePrompt = prompt || '';

  log.info('[图生] callImageApi 路由', {
    image_gen_id,
    protocol,
    api_protocol_raw: config.api_protocol || '(empty→auto)',
    provider,
    model,
    size,
    imageServiceType,
    ref_count: Array.isArray(opts.reference_image_urls) ? opts.reference_image_urls.length : 0,
    ref_label_injected: false,
  });

  if (protocol === 'aihubcc' || isAihubccBaseUrl(config.base_url)) {
    const result = await callAihubccImageApi(config, log, {
      prompt: effectivePrompt,
      model,
      size,
      quality,
      image_gen_id,
      reference_image_urls: opts.reference_image_urls,
      files_base_url: opts.files_base_url,
      storage_local_path: opts.storage_local_path,
    });
    return result;
  }

  if (protocol === 'token6688') {
    return token6688Client.callImageApi(config, log, {
      prompt: effectivePrompt,
      model,
      size,
      quality,
      image_gen_id,
      reference_image_urls: opts.reference_image_urls,
      files_base_url: opts.files_base_url,
    });
  }

  if (protocol === 'djpsd_openapi' || protocol === 'djpsd_media') {
    return callDjpsdOpenApiImageApi(config, log, {
      prompt: effectivePrompt,
      model,
      size,
      image_gen_id,
      reference_image_urls: opts.reference_image_urls,
      files_base_url: opts.files_base_url,
      storage_local_path: opts.storage_local_path,
      poll_interval_ms: opts.poll_interval_ms,
      max_poll_attempts: opts.max_poll_attempts,
    });
  }

  const explicitNegativePrompt = user_negative_prompt ?? opts.negative_prompt;
  const userNegFragment = (explicitNegativePrompt && String(explicitNegativePrompt).trim()) || '';
  const mergedNegativePrompt = userNegFragment;

  if (protocol === 'dashscope') {
    return callDashScopeImageApi(config, log, {
      prompt: effectivePrompt, model, size, image_gen_id,
      reference_image_urls: opts.reference_image_urls,
      files_base_url: opts.files_base_url,
      storage_local_path: opts.storage_local_path,
      negative_prompt: mergedNegativePrompt,
    });
  }

  if (protocol === 'nano_banana') {
    return callNanoBananaImageApi(config, log, {
      prompt: effectivePrompt, model, size, image_gen_id,
      reference_image_urls: opts.reference_image_urls,
      files_base_url: opts.files_base_url,
      storage_local_path: opts.storage_local_path,
    });
  }

  if (protocol === 'kling') {
    return callKlingImageApi(config, log, {
      prompt: effectivePrompt, model, size, image_gen_id,
      reference_image_urls: opts.reference_image_urls,
      files_base_url: opts.files_base_url,
      storage_local_path: opts.storage_local_path,
    });
  }

  if (protocol === 'gemini') {
    return callGeminiImageApi(db, config, log, {
      prompt, model, size, image_gen_id,          // Gemini 用原始 prompt，不注入文字标签
      reference_image_urls: opts.reference_image_urls,
      files_base_url: opts.files_base_url,
      storage_local_path: opts.storage_local_path,
      system_prompt: opts.system_prompt,
    });
  }

  const url = buildImageUrl(config);
  const isVolc = protocol === 'volcengine';
  const isAgnes = isAgnesImageConfig(config, model);
  // doubao-seedream 系列模型（含通过自定义代理使用的场景）：使用 volcengine 图片 API 规范
  const isSeedream = isVolc || /seedream|doubao/i.test(model);
  // 解析参考图：本地路径/localhost URL → base64，公网 URL → 直接传
  const rawRefs = Array.isArray(reference_image_urls) ? reference_image_urls.filter(Boolean) : [];
  const resolvedRefs = await compressResolvedImageRefsForJson(
    rawRefs.map((r) => resolveImageRef(r, files_base_url, storage_local_path)).filter(Boolean),
    { log },
  );
  if (provider === 'fumin_image' && resolvedRefs.length > 0) {
    return {
      error: 'fumin GPT Image 当前不支持参考图（供应商文档未声明该能力），请改用已验证支持参考图的图片模型',
      route_meta: { phase: 'prepare', requestBodySent: false, explicitlyRejected: true },
    };
  }
  if (resolvedRefs.length > 0) {
    log.info('Image API request with reference images', {
      url: url.slice(0, 60), model, image_gen_id,
      ref_count: resolvedRefs.length,
      ref_types: resolvedRefs.map((r) => (r.startsWith('data:') ? 'base64' : 'url')),
    });
  }

  // doubao-seedream-4-5+ 要求最低 3686400 像素，不足时等比放大；Agnes 需映射到官方支持尺寸
  let effectiveSize = size;
  if (isSeedream && size) effectiveSize = fixSeedreamSize(size);
  else if (isAgnes && size) effectiveSize = fixAgnesImageSize(size);

  const isGptImage = protocol === 'openai' && !isAgnes && /^gpt-image-/i.test(String(requestModel || ''));
  const outputOptions = isGptImage
    ? getOpenAIImageOutputOptions(requestModel, quality)
    : {};
  if (isGptImage) effectiveSize = normalizeGptImageSize(effectiveSize);

  const body = {
    model: requestModel,
    prompt: effectivePrompt,
    // doubao-seedream API 不使用 n，其他 OpenAI 兼容接口保留
    ...(!isSeedream ? { n: 1 } : {}),
    ...(effectiveSize ? { size: effectiveSize } : {}),
    ...(quality ? { quality } : {}),
    ...outputOptions,
    // volcengine 原生或 doubao-seedream 模型均需关闭水印（默认为 true）
    ...((isVolc || isSeedream) ? { watermark: false } : {}),
    // 多张参考图时加 negative_prompt，防止模型把参考图拼成左右分割的合图
    // Doubao/Seedream 原生支持；通用 OpenAI-compat 接口大多也会接受该字段（不支持的会忽略）
    ...(mergedNegativePrompt ? { negative_prompt: mergedNegativePrompt } : {}),
    // 参考图字段：volcengine doubao-seedream API 规范使用 image（数组），见官方文档
    ...(resolvedRefs.length > 0 && !isAgnes ? { image: resolvedRefs } : {}),
    // Agnes Image 2.x：参考图放在 extra_body.image
    ...(isAgnes && resolvedRefs.length > 0 ? { extra_body: { image: resolvedRefs, response_format: 'url' } } : {}),
  };
  log.info('Image API request', {
    url: url.slice(0, 60),
    model,
    image_gen_id,
    has_ref_images: resolvedRefs.length > 0,
    size: effectiveSize,
    original_size: size !== effectiveSize ? size : undefined,
    is_agnes: isAgnes,
    output_format: outputOptions.output_format,
  });
  const openaiCompatHeaders = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + (config.api_key || ''),
  };
  let raw;
  let httpStatus;
  try {
    const out = await postJSONWithTimeout(url, openaiCompatHeaders, body, IMAGE_HTTP_TIMEOUT_MS);
    httpStatus = out.statusCode;
    raw = out.raw;
  } catch (e) {
    log.error('Image API network error', { image_gen_id, error: e.message, url: url.slice(0, 80) });
    return {
      error: isGptImage
        ? formatGptImageUnknownResultError(e)
        : e.message && e.message.includes('timeout')
          ? e.message
          : ('图片生成网络请求失败: ' + e.message),
      route_meta: {
        phase: 'submit',
        requestBodySent: true,
        transportCode: e?.cause?.code || e?.code,
      },
    };
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    log.error('Image API failed', {
      status: httpStatus,
      response_bytes: Buffer.byteLength(raw || '', 'utf8'),
    });
    let errMsg = '图片生成请求失败: ' + httpStatus;
    let errorPayload = null;
    try {
      errorPayload = JSON.parse(raw);
      const msg = errorPayload.error?.message || errorPayload.message || errorPayload.error;
      if (msg) errMsg += ' - ' + (typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 200));
    } catch (_) {
      if (raw && raw.length) errMsg += ' - ' + raw.slice(0, 200);
    }
    return { error: errMsg, route_meta: providerErrorMeta(errorPayload, httpStatus) };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    log.warn('Image API response parse error', summarizeImageResponse(null, raw, httpStatus, image_gen_id, model));
    if (protocol === 'openai') return {
      ...openAIImageIndeterminateResult('响应正文无法解析，未收到可读取的图片产物'),
      route_meta: { httpStatus, artifactReadable: false },
    };
    return { error: '图片生成返回格式异常' };
  }
  const imageResult = extractOpenAIImageResult(data, outputOptions.output_format);
  if (!imageResult) {
    const summary = summarizeImageResponse(data, raw, httpStatus, image_gen_id, model);
    if (protocol === 'openai') {
      log.warn('Image API result indeterminate', summary);
      return {
        ...openAIImageIndeterminateResult('响应中没有可读取的图片产物'),
        route_meta: providerErrorMeta(data, httpStatus, { artifactReadable: false }),
      };
    }
    log.warn('Image API no image URL in response', summary);
    return { error: '未返回图片地址' };
  }
  return imageResult;
}

function stripImageRouteMeta(result) {
  if (!result || typeof result !== 'object') return result;
  const { route_meta, provider_task_id, ...safe } = result;
  return safe;
}

function safeImageRouteFailure(classification, result) {
  const category = classification.category;
  if (category === 'policy_rejected') {
    return { error: '图片生成请求被内容安全策略拒绝，请调整提示词后重试。' };
  }
  if (category === 'validation_error') {
    return { error: '图片生成参数不受支持，请检查参考图数量、尺寸或其他生成参数。' };
  }
  if (['provider_unavailable', 'rate_limited', 'auth_unavailable', 'transport_not_sent'].includes(category)) {
    return { error: '图片生成服务暂时不可用，请稍后再试。' };
  }
  if (result?.indeterminate || ['artifact_unreadable', 'result_unknown', 'submission_unknown', 'forbidden_unknown'].includes(category)) {
    return {
      indeterminate: true,
      error: '图片生成结果未知，为避免重复提交或重复扣费，请先核对生成记录，不要连续重试。',
    };
  }
  return { error: '图片生成失败，请稍后再试。' };
}

function findLogicalImageRoute(db, logicalModelId, imageServiceType) {
  if (!logicalModelId || !hasColumn(db, 'ai_service_configs', 'logical_model_id')) return null;
  const serviceTypes = imageServiceType === 'storyboard_image'
    ? ['storyboard_image', 'image']
    : [imageServiceType || 'image'];
  for (const serviceType of serviceTypes) {
    const row = db.prepare(`SELECT id, service_type FROM ai_service_configs
      WHERE deleted_at IS NULL AND is_active = 1 AND service_type = ?
        AND logical_model_id = ? COLLATE NOCASE AND verification_status = 'verified'
      ORDER BY priority DESC, id ASC LIMIT 1`).get(serviceType, String(logicalModelId).trim());
    if (row) return row;
  }
  return null;
}

function updateImageRouteRequestState(db, requestId, state, now = new Date().toISOString()) {
  db.prepare('UPDATE generation_route_requests SET state = ?, updated_at = ? WHERE id = ?')
    .run(state, now, requestId);
}

async function callImageApi(db, log, opts, runtime = {}) {
  const preferredModel = String(opts.model || '').trim() || null;
  const preferredProvider = opts.preferred_provider ?? opts.preferredProvider;
  const preferredConfigId = opts.preferred_config_id ?? opts.preferredConfigId;
  const requestedCapabilities = {
    resolution: opts.resolution || opts.quality,
    aspectRatio: opts.aspect_ratio || opts.aspectRatio,
    referenceImageCount: Array.isArray(opts.reference_image_urls)
      ? opts.reference_image_urls.filter(Boolean).length
      : 0,
  };
  const submitSelectedImageConfig = async (config, selectedOpts) => {
    const model = getModelFromConfig(config, selectedOpts.model);
    const provider = String(config.provider || '').toLowerCase();
    const protocol = String(config.api_protocol || '').toLowerCase() || inferProtocol(provider, model);
    if (protocol === 'usmercari_image') {
      const rawReferences = Array.isArray(selectedOpts.reference_image_urls)
        ? selectedOpts.reference_image_urls.filter(Boolean)
        : [];
      const referenceLimit = configuredImageReferenceLimit(config, model);
      if (rawReferences.length > referenceLimit) {
        return {
          error: referenceLimit === 0
            ? `${model} 当前不支持参考图`
            : `${model} 最多支持 ${referenceLimit} 个图片参考`,
        };
      }
      log.info('[图生] callImageApi 路由', {
        image_gen_id: selectedOpts.image_gen_id,
        protocol,
        api_protocol_raw: config.api_protocol || '(empty→auto)',
        provider,
        model,
        size: selectedOpts.size,
        imageServiceType: selectedOpts.imageServiceType,
        ref_count: rawReferences.length,
        ref_label_injected: false,
      });
      const submit = assertUsmercariImageSubmitReady(db, config, model, {
        n: selectedOpts.n ?? 1,
        reference_image_urls: rawReferences,
        resolution: selectedOpts.resolution || '1k',
      }, runtime.evidenceRoots);
      const resolvedReferences = rawReferences
        .map((reference) => resolveUsmercariPublicImageRef(
          reference,
          selectedOpts.files_base_url,
          selectedOpts.storage_local_path,
        ))
        .filter(Boolean);
      if (resolvedReferences.length !== rawReferences.length) {
        return { error: 'USMercari 参考图无法组成公网 URL，请检查 STORAGE_BASE_URL 与素材路径' };
      }
      return usmercariImageClient.callUsmercariImageApi(config, log, {
        prompt: selectedOpts.prompt || '',
        model,
        n: submit.quantity,
        aspect_ratio: selectedOpts.aspect_ratio || '1:1',
        resolution: submit.resolution,
        image_gen_id: selectedOpts.image_gen_id,
        reference_image_urls: resolvedReferences,
        files_base_url: selectedOpts.files_base_url,
        storage_local_path: selectedOpts.storage_local_path,
        allowed_reference_base_url: selectedOpts.files_base_url,
      });
    }
    return submitImageWithConfig(db, log, config, selectedOpts, runtime);
  };
  const explicitConfigId = resolveExplicitImageConfigId(opts);
  let logicalModelId = preferredModel;
  let logicalRoute;
  let selected;
  if (explicitConfigId != null) {
    const config = getImageConfigById(db, explicitConfigId, preferredModel);
    if (providerRouteStability.resolveCanaryMode(undefined, log) !== 'enforce') {
      return stripImageRouteMeta(await submitSelectedImageConfig(config, opts));
    }
    logicalModelId = String(config.logical_model_id || '').trim();
    if (!logicalModelId) throw new Error('未配置与当前图片生成参数匹配的已验证模型');
    logicalRoute = { id: config.id, service_type: config.service_type };
    const explicitSelection = providerRouteStability.selectVerifiedCandidates(db, {
      serviceType: config.service_type,
      logicalModelId,
      primaryConfigId: config.id,
      capabilities: requestedCapabilities,
      canaryMode: 'enforce',
      log,
    });
    selected = {
      ...explicitSelection,
      candidates: explicitSelection.candidates.filter((candidate) => candidate.id === config.id),
    };
  } else {
    logicalRoute = findLogicalImageRoute(db, preferredModel, opts.imageServiceType);
  }

  if (!logicalRoute) {
    if (providerRouteStability.resolveCanaryMode(undefined, log) === 'enforce') {
      throw new Error('未配置与当前图片生成参数匹配的已验证模型');
    }
    const candidates = getImageConfigCandidates(
      db,
      preferredModel,
      preferredProvider,
      opts.imageServiceType,
      preferredConfigId,
    );
    if (candidates.length === 0) {
      const fallback = getDefaultImageConfig(
        db,
        preferredModel,
        preferredProvider,
        opts.imageServiceType,
        preferredConfigId,
      );
      if (fallback) candidates.push(fallback);
    }
    if (candidates.length === 0) {
      throw new Error('未配置图片模型，请在「AI 配置」中添加 image 类型且已启用的配置');
    }
    let lastResult = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const config = candidates[index];
      lastResult = await submitSelectedImageConfig(config, opts);
      if (lastResult?.image_url) return stripImageRouteMeta(lastResult);
      const classification = classifyProviderFailure(lastResult?.route_meta || {});
      if (!classification.mayFailover || index + 1 >= candidates.length) break;
      log.warn('Legacy image route switching after definitive non-acceptance', {
        image_gen_id: opts.image_gen_id,
        from_config_id: config.id,
        category: classification.category,
      });
    }
    return stripImageRouteMeta(lastResult);
  }

  selected ||= providerRouteStability.selectVerifiedCandidates(db, {
    serviceType: logicalRoute.service_type,
    logicalModelId,
    primaryConfigId: logicalRoute.id,
    capabilities: requestedCapabilities,
    log,
  });
  if (selected.candidates.length === 0) {
    throw new Error('未配置与当前图片生成参数匹配的已验证模型');
  }

  const routeId = crypto.randomUUID();
  const businessId = opts.image_gen_id == null ? routeId : String(opts.image_gen_id);
  const owner = String(opts.tenantId || opts.userId || 'local');
  const route = providerRouteStability.createOrGetRouteRequest(db, {
    id: routeId,
    idempotencyKey: `${owner}:image:${businessId}`,
    serviceType: logicalRoute.service_type,
    businessType: 'image_generation',
    businessId,
    tenantId: opts.tenantId,
    userId: opts.userId,
    logicalModelId,
    capabilities: requestedCapabilities,
    userPriceSnapshot: selected.userPriceSnapshot,
    candidateConfigIds: selected.candidates.map((candidate) => candidate.id),
    creditReservationId: opts.creditReservationId,
  });
  if (route.state !== 'created') {
    return safeImageRouteFailure({ category: 'result_unknown' }, { indeterminate: true });
  }

  let lastFailure = null;
  let pendingSwitch = null;
  for (let index = 0; index < selected.candidates.length; index += 1) {
    const config = selected.candidates[index];
    const upstreamModel = getModelFromConfig(config);
    const attempt = providerRouteStability.startAttempt(db, {
      requestId: route.id,
      configId: config.id,
      provider: config.provider || 'configured',
      upstreamModel,
    });
    if (!attempt) continue;
    if (pendingSwitch) {
      providerRouteStability.recordRouteSwitch(db, {
        requestId: route.id,
        tenantId: opts.tenantId,
        logicalModelId,
        configId: pendingSwitch.configId,
        targetConfigId: config.id,
        category: pendingSwitch.category,
      });
      pendingSwitch = null;
    }
    let result;
    try {
      result = await submitSelectedImageConfig(config, { ...opts, model: undefined });
    } catch (error) {
      result = {
        indeterminate: true,
        error: '图片生成结果未知，请勿重复提交。',
        route_meta: {
          phase: 'submit',
          requestBodySent: true,
          transportCode: error?.cause?.code || error?.code,
        },
      };
      log.error('Image route attempt ended without a structured result', {
        image_gen_id: opts.image_gen_id,
        config_id: config.id,
        error_code: error?.code || null,
      });
    }
    const routeMeta = result?.route_meta || {};
    if (routeMeta.providerTaskId) {
      providerRouteStability.recordAcceptedTask(db, {
        requestId: route.id,
        attemptNo: attempt.attempt_no,
        providerTaskId: routeMeta.providerTaskId,
      });
    }
    if (result?.image_url) {
      providerRouteStability.recordArtifactVerified(db, {
        requestId: route.id,
        attemptNo: attempt.attempt_no,
        configId: config.id,
      });
      if (opts.image_gen_id != null && hasColumn(db, 'image_generations', 'config_id')) {
        db.prepare('UPDATE image_generations SET config_id = ? WHERE id = ?')
          .run(config.id, opts.image_gen_id);
      }
      return stripImageRouteMeta(result);
    }

    const classification = classifyProviderFailure(routeMeta);
    const uncertainAttempt = ['submission_unknown', 'result_unknown', 'artifact_unreadable', 'forbidden_unknown']
      .includes(classification.category);
    providerRouteStability.finishAttempt(db, {
      requestId: route.id,
      attemptNo: attempt.attempt_no,
      state: uncertainAttempt ? classification.category : 'failed',
      httpStatus: routeMeta.httpStatus,
      errorCategory: classification.category,
    });
    providerRouteStability.recordFailureAndHealth(db, {
      requestId: route.id,
      tenantId: opts.tenantId,
      configId: config.id,
      logicalModelId,
      classification,
    });
    lastFailure = { classification, result };
    const hasNext = index + 1 < selected.candidates.length;
    if (!classification.mayFailover || !hasNext) {
      const requestState = ['submission_unknown', 'result_unknown', 'artifact_unreadable', 'forbidden_unknown']
        .includes(classification.category) ? 'needs_attention' : 'failed';
      updateImageRouteRequestState(db, route.id, requestState);
      return safeImageRouteFailure(classification, result);
    }
    pendingSwitch = { configId: config.id, category: classification.category };
    log.warn('Image route switching after definitive non-acceptance', {
      image_gen_id: opts.image_gen_id,
      logical_model_id: logicalModelId,
      from_config_id: config.id,
      category: classification.category,
    });
  }
  const finalCategory = lastFailure?.classification?.category || 'provider_unavailable';
  const uncertain = ['submission_unknown', 'result_unknown', 'artifact_unreadable', 'forbidden_unknown']
    .includes(finalCategory);
  updateImageRouteRequestState(db, route.id, uncertain ? 'needs_attention' : 'failed');
  return safeImageRouteFailure(lastFailure?.classification || { category: finalCategory }, lastFailure?.result);
}

async function callImageApiForConfigId(db, log, configId, opts = {}) {
  const explicitConfigId = normalizeImageConfigId(configId);
  const requestConfigId = resolveExplicitImageConfigId(opts);
  if (requestConfigId != null && requestConfigId !== explicitConfigId) {
    throw imageConfigError('IMAGE_CONFIG_NOT_FOUND', '图片模型配置不存在');
  }
  const preferredModel = String(opts.model || '').trim() || null;
  const config = getImageConfigById(db, explicitConfigId, preferredModel);
  return submitImageWithConfig(db, log, config, opts);
}

/**
 * 创建 image_generation 记录并异步调用 API，完成后更新记录与角色 image_url。
 * 与场景图一致：创建 task 并写入 task_id，便于前端轮询 /tasks/:task_id 获知完成或报错。
 */
function findActiveAssetImage(db, characterId, sceneId, options = {}, imageType = null) {
  const ownerClause = options.billingEnabled
    ? options.tenantId ? ' AND tenant_id = ?' : ' AND user_id = ?'
    : '';
  const ownerValue = options.billingEnabled
    ? [String(options.tenantId || options.userId || '')]
    : [];
  const typeClause = imageType ? ' AND image_type = ?' : '';
  const typeValue = imageType ? [String(imageType)] : [];
  if (characterId != null) {
    return db.prepare(
      "SELECT * FROM image_generations WHERE character_id = ? AND status IN ('pending', 'processing', 'needs_attention') AND deleted_at IS NULL" + ownerClause + typeClause + " ORDER BY created_at DESC, id DESC LIMIT 1"
    ).get(Number(characterId), ...ownerValue, ...typeValue) || null;
  }
  if (sceneId != null) {
    return db.prepare(
      "SELECT * FROM image_generations WHERE scene_id = ? AND status IN ('pending', 'processing', 'needs_attention') AND deleted_at IS NULL" + ownerClause + typeClause + " ORDER BY created_at DESC, id DESC LIMIT 1"
    ).get(Number(sceneId), ...ownerValue, ...typeValue) || null;
  }
  return null;
}

function settleImageCredit(db, log, imageGenId, outcome, message = '') {
  const row = typeof imageGenId === 'object'
    ? imageGenId
    : db.prepare('SELECT id, credit_reservation_id FROM image_generations WHERE id = ?').get(Number(imageGenId));
  if (!row?.credit_reservation_id) return null;
  try {
    return creditLedger.settleGeneration(db, row.credit_reservation_id, outcome, message);
  } catch (error) {
    log?.error('[资产图生] 积分结算失败，保留原预扣状态', { id: row.id, error: error.message });
    return null;
  }
}

function markAssetImageNeedsAttention(db, log, imageGenId, taskId, message, timestamp, options = {}) {
  const safeMessage = String(message || '图片生成结果未知，请勿重复提交，等待管理员核对').slice(0, 500);
  db.prepare('UPDATE image_generations SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?')
    .run('needs_attention', safeMessage, timestamp, imageGenId);
  taskService.updateTaskStatus(db, taskId, 'needs_attention', 90, safeMessage);
  try { db.prepare('UPDATE async_tasks SET error = ? WHERE id = ?').run(safeMessage, taskId); } catch (_) {}
  if (options.artifactUnreadable) {
    providerRouteStability.recordBusinessArtifactUnreadable(db, {
      businessType: 'image_generation',
      businessId: imageGenId,
      now: timestamp,
    });
  }
  settleImageCredit(db, log, imageGenId, 'failed', safeMessage);
}

async function verifyStrictLocalImageArtifact(storagePath, localPath) {
  if (!localPath) throw new Error('图片未生成本地文件');
  const storageRoot = path.resolve(storagePath);
  const absolutePath = path.resolve(storageRoot, localPath);
  const relative = path.relative(storageRoot, absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('图片本地文件路径越出存储目录');
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error('图片本地文件为空');
  const sharp = getSharp();
  if (!sharp) throw new Error('图片校验组件 sharp 不可用');
  const metadata = await sharp(fs.readFileSync(absolutePath)).metadata();
  if (!metadata.width || !metadata.height || !metadata.format) throw new Error('图片文件不可读取');
  const mimeByFormat = {
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    avif: 'image/avif',
  };
  return {
    fileSize: stat.size,
    width: metadata.width,
    height: metadata.height,
    mimeType: mimeByFormat[metadata.format] || `image/${metadata.format}`,
  };
}

function createStrictGeneratedAsset(db, row, persisted, artifact) {
  return assetService.create(db, null, {
    drama_id: row.drama_id ?? null,
    storyboard_id: row.storyboard_id ?? null,
    name: `生成图片 ${row.id}`,
    type: 'image',
    category: row.scene_id != null ? 'scene' : row.character_id != null ? 'character' : 'generation',
    url: persisted.url,
    local_path: persisted.local_path,
    file_size: artifact.fileSize,
    mime_type: artifact.mimeType,
    width: artifact.width,
    height: artifact.height,
    image_gen_id: row.id,
    metadata: {
      source: 'image_generation',
      model: row.model || null,
      resolution: row.resolution || null,
      quantity: row.quantity || 1,
    },
  });
}

function createAndGenerateImage(db, log, opts, runtime = {}) {
  const {
    drama_id,
    character_id,
    scene_id,
    image_type,
    prompt,
    model,
    size,
    resolution,
    n,
    quantity,
    quality,
    provider,
    user_negative_prompt,
    billingEnabled = false,
    userId,
    tenantId,
    schedule,
  } = opts;
  const imageType = String(image_type || '').trim() || null;
  const negRow = (user_negative_prompt && String(user_negative_prompt).trim()) || null;
  const now = new Date().toISOString();
  const dramaIdNum = Number(drama_id) || 0;
  const charIdNum = character_id != null ? Number(character_id) : null;
  const sceneIdNum = scene_id != null ? Number(scene_id) : null;
  let effectiveModel = String(model || '').trim() || null;
  if (!effectiveModel) {
    try {
      effectiveModel = resolveImageModel(db, null, null, 'image');
    } catch (error) {
      if (billingEnabled) throw error;
    }
  }

  let billedModel = null;
  let billedCredits = null;
  let billingRequest = null;
  let requestSnapshot = null;
  const requestedQuantity = Number(n ?? quantity ?? 1);
  try {
    const imageService = require('./imageService');
    billingRequest = imageService.resolveImageBillingRequest(db, {
      model: effectiveModel,
      provider,
      resolution,
      n: requestedQuantity,
    }, 'image', {
      requirePricing: billingEnabled === true,
      allowMissingModel: !billingEnabled,
      evidenceRoots: runtime.evidenceRoots,
    });
  } catch (error) {
    if (billingEnabled || ['MODEL_NOT_VERIFIED', 'MODEL_CREDENTIAL_MISSING', 'IMAGE_RESOLUTION_REQUIRED', 'IMAGE_RESOLUTION_NOT_VERIFIED', 'IMAGE_REFERENCE_NOT_VERIFIED', 'IMAGE_REFERENCE_LIMIT_EXCEEDED', 'INVALID_IMAGE_QUANTITY'].includes(error.code)) {
      throw error;
    }
  }
  if (billingRequest) {
    effectiveModel = billingRequest.model || effectiveModel;
    requestSnapshot = billingRequest.requestSnapshot || null;
  }
  const isStrictUsmercari = billingRequest?.protocol === 'usmercari_image'
    || requestSnapshot?.protocol === 'usmercari_image';
  if (billingEnabled) {
    if (!userId) {
      const error = new Error('请先登录');
      error.code = 'UNAUTHORIZED';
      throw error;
    }
    billedModel = billingRequest?.model;
    billedCredits = billingRequest?.credits;
    if (!billedModel || !Number.isSafeInteger(Number(billedCredits))) {
      const modelPriceService = require('./modelPriceService');
      billedModel = modelPriceService.canonicalModel(effectiveModel || '');
      billedCredits = modelPriceService.requirePrice(db, billedModel);
    }
  }
  const active = findActiveAssetImage(db, charIdNum, sceneIdNum, {
    billingEnabled,
    userId,
    tenantId,
  }, imageType);
  if (active) {
    if (billingEnabled) {
      auditEvent.record(db, {
        userId,
        tenantId,
        eventType: 'generation.image.reused',
        resourceType: 'image',
        resourceId: active.id,
        outcome: 'success',
        code: 'REUSED',
      });
    }
    return { ...rowToItem(active), reused: true };
  }

  let resourceId;
  if (charIdNum != null) resourceId = `character_${charIdNum}`;
  else if (sceneIdNum != null) resourceId = `scene_${sceneIdNum}`;
  else resourceId = String(dramaIdNum);
  const created = db.transaction(() => {
    const task = taskService.createTask(db, log, 'image_generation', resourceId);
    const taskId = task.id;
    if (billingEnabled && tenantId) {
      db.prepare('UPDATE async_tasks SET tenant_id = ?, user_id = ? WHERE id = ?')
        .run(String(tenantId), String(userId), taskId);
    }
    const billingColumns = billingEnabled ? ', tenant_id, user_id, credit_reservation_id' : '';
    const billingValues = billingEnabled ? ', ?, ?, NULL' : '';
    const sql = 'INSERT INTO image_generations (drama_id, character_id, scene_id, image_type, provider, prompt, negative_prompt, model, size, resolution, quantity, request_snapshot, quality, status, task_id, created_at, updated_at' + billingColumns + ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'pending\', ?, ?, ?' + billingValues + ')';
    const values = [dramaIdNum, charIdNum, sceneIdNum, imageType, billingRequest?.provider || provider || 'openai', prompt || '', negRow, effectiveModel, size || null, billingRequest?.resolution || null, billingRequest?.quantity || requestedQuantity || 1, requestSnapshot ? JSON.stringify(requestSnapshot) : null, quality || null, taskId, now, now];
    if (billingEnabled) values.push(tenantId ? String(tenantId) : null, String(userId));
    const info = db.prepare(sql).run(...values);
    const imageGenId = info.lastInsertRowid;
    if (billingEnabled) {
      const reservation = creditLedger.reserve(db, {
        tenantId,
        actorUserId: userId,
        userId,
        operationKey: 'image:' + imageGenId,
        amount: billedCredits,
        model: billedModel,
        resourceType: 'image',
        resourceId: String(imageGenId),
      });
      db.prepare('UPDATE image_generations SET credit_reservation_id = ? WHERE id = ?').run(reservation.id, imageGenId);
      db.prepare('UPDATE async_tasks SET credit_reservation_id = ?, model = ? WHERE id = ?')
        .run(reservation.id, billedModel, taskId);
      generationCost.record(db, {
        reservationId: reservation.id,
        model: billedModel,
        resolution: billingRequest?.resolution || null,
        quantity: billingRequest?.quantity || 1,
        usageSource: 'configured',
      });
      auditEvent.record(db, {
        userId,
        tenantId,
        eventType: 'generation.image.created',
        resourceType: 'image',
        resourceId: imageGenId,
        outcome: 'success',
        code: 'CREATED',
      });
    }
    return { imageGenId, taskId };
  })();
  const { imageGenId, taskId } = created;

  const scheduleTask = typeof schedule === 'function' ? schedule : (callback) => setImmediate(callback);
  scheduleTask(async () => {
    let providerArtifactReturned = false;
    try {
      db.prepare('UPDATE image_generations SET status = ? WHERE id = ?').run('processing', imageGenId);
      const result = await taskService.withTaskHeartbeat(
        db,
        taskId,
        '正在等待图片生成服务...',
        () => runWithGenerationLimit('image', () => callImageApi(db, log, {
          prompt,
          model: effectiveModel,
          preferred_provider: billingRequest?.provider || undefined,
          preferred_config_id: billingRequest?.configId || requestSnapshot?.config_id || undefined,
          size,
          resolution: billingRequest?.resolution || undefined,
          n: billingRequest?.quantity || 1,
          quality,
          drama_id: drama_id,
          character_id: character_id,
          image_type,
          image_gen_id: imageGenId,
          user_negative_prompt: user_negative_prompt || undefined,
          userId: userId || undefined,
          tenantId: tenantId || undefined,
          creditReservationId: db.prepare('SELECT credit_reservation_id FROM image_generations WHERE id = ?')
            .get(imageGenId)?.credit_reservation_id || undefined,
        }, runtime))
      );
      const now2 = new Date().toISOString();
      if (result.error) {
        const resultError = result.indeterminate ? `供应商最终状态未知：${result.error}` : result.error;
        if (result.indeterminate) {
          markAssetImageNeedsAttention(db, log, imageGenId, taskId, resultError, now2);
          return;
        }
        db.prepare(
          'UPDATE image_generations SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?'
        ).run('failed', resultError, now2, imageGenId);
        taskService.updateTaskError(db, taskId, resultError);
        settleImageCredit(db, log, imageGenId, 'failed', resultError);
        if (charIdNum != null) {
          try {
            db.prepare('UPDATE characters SET error_msg = ?, updated_at = ? WHERE id = ?').run(resultError, now2, charIdNum);
          } catch (_) {}
        }
        if (sceneIdNum != null) {
          try {
            db.prepare('UPDATE scenes SET error_msg = ?, updated_at = ? WHERE id = ?').run(resultError, now2, sceneIdNum);
          } catch (_) {}
        }
        log.error('Image generation failed', { image_gen_id: imageGenId, error: resultError });
        return;
      }
      providerArtifactReturned = Boolean(result.image_url);
      let localPath = null;
      const cfg = loadConfig();
      const storagePath = path.isAbsolute(cfg.storage?.local_path)
        ? cfg.storage.local_path
        : path.join(process.cwd(), cfg.storage?.local_path || './data/storage');
      const category = sceneIdNum != null ? 'scenes' : (charIdNum != null ? 'characters' : 'images');
      const projectSubdir = storageLayout.getProjectStorageSubdir(db, dramaIdNum);
      localPath = await uploadService.downloadImageToLocal(
        storagePath,
        result.image_url,
        category,
        log,
        'ig',
        projectSubdir
      );
      if (!localPath) {
        const msg = '图片本地保存失败：未生成本地文件；供应商结果未知，请勿重复提交，等待管理员核对';
        markAssetImageNeedsAttention(db, log, imageGenId, taskId, msg, now2, { artifactUnreadable: true });
        return;
      }
      if (isStrictUsmercari) {
        let artifact;
        try {
          artifact = await verifyStrictLocalImageArtifact(storagePath, localPath);
        } catch (saveErr) {
          const msg = `图片本地保存失败：${saveErr.message || saveErr}；供应商结果未知，请勿重复提交，等待管理员核对`;
          markAssetImageNeedsAttention(db, log, imageGenId, taskId, msg, now2, { artifactUnreadable: true });
          return;
        }
        const persistedUrl = '/static/' + String(localPath).replace(/^\/+/, '');
        const rowForAsset = db.prepare('SELECT * FROM image_generations WHERE id = ?').get(imageGenId);
        db.transaction(() => {
          db.prepare(
            'UPDATE image_generations SET status = ?, image_url = ?, local_path = ?, completed_at = ?, updated_at = ? WHERE id = ?'
          ).run('completed', persistedUrl, localPath, now2, now2, imageGenId);
          createStrictGeneratedAsset(db, { ...rowForAsset, id: imageGenId }, { url: persistedUrl, local_path: localPath }, artifact);
          taskService.updateTaskResult(db, taskId, { image_generation_id: imageGenId, image_url: persistedUrl, local_path: localPath, status: 'completed' });
          if (charIdNum != null) {
            db.prepare('UPDATE characters SET image_url = ?, local_path = ?, updated_at = ? WHERE id = ?')
              .run(persistedUrl, localPath, now2, charIdNum);
          }
          if (sceneIdNum != null) {
            if (imageType === 'scene_panorama') {
              db.prepare('UPDATE scenes SET panorama_image_url = ?, panorama_local_path = ?, updated_at = ? WHERE id = ?')
                .run(persistedUrl, localPath, now2, sceneIdNum);
            } else {
              db.prepare('UPDATE scenes SET image_url = ?, local_path = ?, updated_at = ? WHERE id = ?')
                .run(persistedUrl, localPath, now2, sceneIdNum);
            }
          }
        })();
        settleImageCredit(db, log, imageGenId, 'completed');
        log.info('Image generation completed', { image_gen_id: imageGenId, local_path: localPath });
        return;
      }
      // 兼容旧库无 completed_at：先试完整 UPDATE，失败则只更新必有列
      try {
        db.prepare(
          'UPDATE image_generations SET status = ?, image_url = ?, local_path = ?, error_msg = NULL, completed_at = ?, updated_at = ? WHERE id = ?'
        ).run('completed', result.image_url, localPath, now2, now2, imageGenId);
      } catch (e) {
        if ((e.message || '').includes('completed_at')) {
          db.prepare(
            'UPDATE image_generations SET status = ?, image_url = ?, local_path = ?, error_msg = NULL, updated_at = ? WHERE id = ?'
          ).run('completed', result.image_url, localPath, now2, imageGenId);
        } else {
          throw e;
        }
      }
      taskService.updateTaskResult(db, taskId, { image_generation_id: imageGenId, image_url: result.image_url, local_path: localPath, status: 'completed' });
      settleImageCredit(db, log, imageGenId, 'completed');
      if (charIdNum != null) {
        try {
          // 旧图追加到 extra_images，与上传逻辑保持一致
          const oldChar = db
            .prepare('SELECT local_path, image_url, extra_images, seedance2_asset FROM characters WHERE id = ?')
            .get(charIdNum);
          const oldPath = oldChar?.local_path || oldChar?.image_url || '';
          let extras = [];
          try { extras = oldChar?.extra_images ? JSON.parse(oldChar.extra_images) : []; } catch (_) {}
          if (!Array.isArray(extras)) extras = [];
          if (oldPath && !extras.includes(oldPath)) extras.push(oldPath);
          const extraJson = extras.length ? JSON.stringify(extras) : null;
          seedance2AssetGuards.markStaleOnCharacterMainImageDrift(db, log, { ...oldChar, id: charIdNum }, {
            image_url: result.image_url,
            local_path: localPath,
          });
          db.prepare('UPDATE characters SET image_url = ?, local_path = ?, extra_images = ?, error_msg = NULL, updated_at = ? WHERE id = ?').run(
            result.image_url,
            localPath,
            extraJson,
            now2,
            charIdNum
          );
        } catch (e) {
          if ((e.message || '').includes('local_path') || (e.message || '').includes('extra_images')) {
            db.prepare('UPDATE characters SET image_url = ?, error_msg = NULL, updated_at = ? WHERE id = ?').run(result.image_url, now2, charIdNum);
          } else {
            throw e;
          }
        }
        log.info('Character image updated', { character_id: charIdNum, image_url: result.image_url, local_path: localPath });
      }
      if (sceneIdNum != null) {
        try {
          if (imageType === 'scene_panorama') {
            db.prepare('UPDATE scenes SET panorama_image_url = ?, panorama_local_path = ?, updated_at = ? WHERE id = ?').run(
              result.image_url, localPath, now2, sceneIdNum
            );
          } else {
            // 旧图追加到 extra_images，与上传逻辑保持一致
            const oldScene = db.prepare('SELECT local_path, image_url, extra_images FROM scenes WHERE id = ?').get(sceneIdNum);
            const oldPath = oldScene?.local_path || oldScene?.image_url || '';
            let extras = [];
            try { extras = oldScene?.extra_images ? JSON.parse(oldScene.extra_images) : []; } catch (_) {}
            if (!Array.isArray(extras)) extras = [];
            if (oldPath && !extras.includes(oldPath)) extras.push(oldPath);
            const extraJson = extras.length ? JSON.stringify(extras) : null;
            db.prepare('UPDATE scenes SET image_url = ?, local_path = ?, extra_images = ?, error_msg = NULL, updated_at = ? WHERE id = ?').run(
              result.image_url, localPath, extraJson, now2, sceneIdNum
            );
          }
        } catch (e) {
          if ((e.message || '').includes('local_path') || (e.message || '').includes('extra_images')) {
            db.prepare('UPDATE scenes SET image_url = ?, error_msg = NULL, updated_at = ? WHERE id = ?').run(result.image_url, now2, sceneIdNum);
          } else {
            throw e;
          }
        }
        log.info('Scene image updated', { scene_id: sceneIdNum, image_url: result.image_url, local_path: localPath });
      }
      log.info('Image generation completed', { image_gen_id: imageGenId, local_path: localPath });
    } catch (err) {
      const now2 = new Date().toISOString();
      const errMsg = (err && err.message) ? String(err.message).slice(0, 500) : 'Unknown error';
      if (providerArtifactReturned) {
        const msg = `图片本地保存失败：${errMsg}；供应商结果未知，请勿重复提交，等待管理员核对`;
        markAssetImageNeedsAttention(db, log, imageGenId, taskId, msg, now2, { artifactUnreadable: true });
        return;
      }
      try {
        db.prepare(
          'UPDATE image_generations SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?'
        ).run('failed', errMsg, now2, imageGenId);
      } catch (e) {
        log.error('Image generation: failed to update image_generations', { image_gen_id: imageGenId, error: e.message });
      }
      try {
        taskService.updateTaskError(db, taskId, errMsg);
      } catch (e) {
        log.error('Image generation: failed to update task status', { task_id: taskId, error: e.message });
      }
      if (charIdNum != null) {
        try {
          db.prepare('UPDATE characters SET error_msg = ?, updated_at = ? WHERE id = ?').run(errMsg, now2, charIdNum);
        } catch (_) {}
      }
      if (sceneIdNum != null) {
        try {
          db.prepare('UPDATE scenes SET error_msg = ?, updated_at = ? WHERE id = ?').run(errMsg, now2, sceneIdNum);
        } catch (_) {}
      }
      settleImageCredit(db, log, imageGenId, 'failed', errMsg);
      log.error('Image generation error', { image_gen_id: imageGenId, task_id: taskId, error: err.message });
    }
  });

  const row = db.prepare('SELECT * FROM image_generations WHERE id = ?').get(imageGenId);
  return row ? rowToItem(row) : { id: imageGenId, task_id: taskId, status: 'pending', drama_id: dramaIdNum, character_id: charIdNum, scene_id: sceneIdNum, prompt, model, size, quality, created_at: now, updated_at: now };
}

function rowToItem(r) {
  return {
    id: r.id,
    storyboard_id: r.storyboard_id,
    drama_id: r.drama_id,
    character_id: r.character_id,
    provider: r.provider,
    prompt: r.prompt,
    model: r.model,
    size: r.size,
    quality: r.quality,
    image_url: r.image_url,
    local_path: r.local_path,
    image_type: r.image_type,
    status: r.status,
    task_id: r.task_id,
    error_msg: r.error_msg,
    created_at: r.created_at,
    updated_at: r.updated_at,
    completed_at: r.completed_at,
  };
}

/** 分镜参考图上限（与 callGeminiImageApi 的 MAX_GEMINI_REF_IMAGES、可灵单图参考等对齐） */
function getStoryboardReferenceLimits(config, modelName) {
  const provider = (config?.provider || '').toLowerCase();
  const protocol = (config?.api_protocol || '').toLowerCase() || inferProtocol(provider, modelName || config?.model);
  if (protocol === 'kling') {
    return { total: 1, maxCharacters: 1, maxObjects: 1 };
  }
  return { total: 4, maxCharacters: 3, maxObjects: 4 };
}

function countStoryboardRefsFromLabels(refLabels) {
  let characters = 0;
  let objects = 0;
  for (const lbl of refLabels || []) {
    if (/character appearance/i.test(lbl)) characters += 1;
    else if (/scene background|prop\/object/i.test(lbl)) objects += 1;
  }
  return { characters, objects };
}

function canAddStoryboardCharacterRef(refLabels, limits) {
  const { characters } = countStoryboardRefsFromLabels(refLabels);
  return refLabels.length < limits.total && characters < limits.maxCharacters;
}

function canAddStoryboardObjectRef(refLabels, limits) {
  const { objects } = countStoryboardRefsFromLabels(refLabels);
  return refLabels.length < limits.total && objects < limits.maxObjects;
}

/** 去重：同一本地路径或 URL（忽略 query）不重复加入参考图列表 */
function canonicalRefKey(ref) {
  if (ref == null || ref === '') return '';
  let s = String(ref).trim().replace(/\\/g, '/');
  if (s.startsWith('data:')) return s.slice(0, 120);
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return `${u.origin}${u.pathname}`.toLowerCase();
    } catch (_) {
      return s.split('?')[0].toLowerCase();
    }
  }
  try {
    return path.normalize(s).toLowerCase();
  } catch (_) {
    return s.toLowerCase();
  }
}

function refListHasCanonical(list, ref) {
  const key = canonicalRefKey(ref);
  if (!key) return false;
  return (list || []).some((item) => canonicalRefKey(item) === key);
}

const { runWithGenerationLimit } = require('./generationConcurrency');

module.exports = {
  getImageConfigCandidates,
  getImageConfigById,
  getDefaultImageConfig,
  resolveImageModel,
  getReferenceImageCapability,
  callAihubccImageApi,
  compressResolvedImageRefsForJson,
  buildDjpsdOpenApiImageBody,
  parseDjpsdOpenApiImagePollResponse,
  callDjpsdOpenApiImageApi,
  buildToken6688ImageBody: token6688Client.buildImageBody,
  callToken6688ImageApi: token6688Client.callImageApi,
  getOpenAIImageOutputOptions,
  normalizeGptImageSize,
  imageMimeFromOutputFormat,
  imageMimeFromBase64,
  formatGptImageUnknownResultError,
  MAX_PROVIDER_IMAGE_BASE64_LENGTH,
  normalizeProviderImageOutput,
  extractOpenAIImageResult,
  summarizeImageResponse,
  buildKlingImageQueryUrl,
  parseKlingImagePollResult,
  callImageApi: (...args) => runWithGenerationLimit('image', () => callImageApi(...args)),
  callImageApiForConfigId: (...args) => runWithGenerationLimit(
    'image',
    () => callImageApiForConfigId(...args),
  ),
  createAndGenerateImage,
  settleImageCredit,
  resolveAssetUserNegativeForApi,
  getStoryboardReferenceLimits,
  canAddStoryboardCharacterRef,
  canAddStoryboardObjectRef,
  refListHasCanonical,
  fixAgnesImageSize,
  isAgnesImageConfig,
  /** 图床 URL 缓存（image_proxy_cache），供 SD2 认证等复用 */
  getProxyCache,
  getProxyCacheValidated,
  deleteProxyCache,
  isProxyUrlAlive,
  setProxyCache,
};
