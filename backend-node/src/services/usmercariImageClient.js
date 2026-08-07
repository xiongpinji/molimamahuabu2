const {
  resolveUsmercariApiKey,
} = require('./usmercariVideoClient');
const net = require('net');

const USMERCARI_IMAGE_ORIGIN = 'https://chat-ai.mercarimx.com';

const USMERCARI_IMAGE_MODELS = Object.freeze({
  'gpt-image-2-2-4k': Object.freeze({ resolutions: Object.freeze(['1k', '2k']), maxReferences: 6 }),
  'nano-banana-2': Object.freeze({ resolutions: Object.freeze(['1k', '2k', '4k']), maxReferences: 6 }),
});

function normalizeUsmercariImageBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || USMERCARI_IMAGE_ORIGIN).trim());
  } catch (_) {
    throw new Error(`USMercari 图片接口必须使用官方 HTTPS 地址 ${USMERCARI_IMAGE_ORIGIN}`);
  }
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  if (parsed.origin !== USMERCARI_IMAGE_ORIGIN
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || !['/', '/v1'].includes(pathname)) {
    throw new Error(`USMercari 图片接口必须使用官方 HTTPS 地址 ${USMERCARI_IMAGE_ORIGIN}`);
  }
  return USMERCARI_IMAGE_ORIGIN;
}

function normalizeResolution(value) {
  return String(value || '1k').trim().toLowerCase();
}

function normalizeReferences(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function normalizedHostname(url) {
  return String(url.hostname || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
}

function isPrivateIpv4(host) {
  const parts = host.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a === 0;
}

function isUnsafeStorageHost(hostname) {
  const host = String(hostname || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (net.isIP(host) === 4) return isPrivateIpv4(host);
  if (net.isIP(host) === 6) {
    if (host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIpv4(mapped[1]);
  }
  return false;
}

function parseStorageBaseUrl(baseUrl) {
  try {
    const parsed = new URL(String(baseUrl || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password || isUnsafeStorageHost(normalizedHostname(parsed))) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function isAllowedStoragePublicImageUrl(value, allowedBaseUrl) {
  const base = parseStorageBaseUrl(allowedBaseUrl);
  if (!base) return false;
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch (_) {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  if (url.username || url.password) return false;
  if (isUnsafeStorageHost(normalizedHostname(url))) return false;
  if (url.origin !== base.origin) return false;
  const basePath = base.pathname.replace(/\/+$/, '') || '/';
  const targetPath = url.pathname;
  return basePath === '/'
    ? targetPath.startsWith('/')
    : targetPath === basePath || targetPath.startsWith(`${basePath}/`);
}

function validateUsmercariImageOptions(opts = {}) {
  const model = String(opts.model || '').trim();
  const spec = USMERCARI_IMAGE_MODELS[model];
  if (!spec) throw new Error(`USMercari 图片模型 ${model || '(empty)'} 未经真实生成验证，禁止提交`);

  const prompt = String(opts.prompt || '').trim();
  if (!prompt) throw new Error('USMercari 图片提示词不能为空');

  const resolution = normalizeResolution(opts.resolution);
  if (!spec.resolutions.includes(resolution)) {
    throw new Error(`USMercari 图片模型 ${model} 不支持 ${resolution}；只开放 ${spec.resolutions.join('、')}`);
  }

  const n = Number(opts.n ?? 1);
  if (!Number.isSafeInteger(n) || n !== 1) {
    throw new Error('USMercari 图片数量目前仅开放已实测的 1 张');
  }

  const aspectRatio = String(opts.aspect_ratio || '1:1').trim().replace('：', ':');
  if (!/^\d{1,2}:\d{1,2}$/.test(aspectRatio)) {
    throw new Error('USMercari 图片比例格式必须为 W:H');
  }

  const references = normalizeReferences(opts.reference_image_urls);
  if (references.length > spec.maxReferences) {
    throw new Error(`USMercari 图片模型 ${model} 最多支持 ${spec.maxReferences} 张参考图`);
  }
  return { model, spec, prompt, resolution, n, aspectRatio, references };
}

function buildUsmercariImageBody(opts = {}) {
  const checked = validateUsmercariImageOptions(opts);
  return {
    model: checked.model,
    prompt: checked.prompt,
    n: checked.n,
    aspect_ratio: checked.aspectRatio,
    resolution: checked.resolution,
  };
}

function parseJson(raw) {
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function providerMessage(payload, raw, fallback) {
  const message = payload?.detail || payload?.message || payload?.error;
  if (message) {
    if (typeof message === 'string') return message.slice(0, 300);
    try { return JSON.stringify(message).slice(0, 300); } catch (_) { return '供应商返回了结构化错误'; }
  }
  if (/^\s*</.test(String(raw || ''))) return '供应商返回了非 JSON 错误页';
  return String(raw || fallback).slice(0, 300);
}

function absoluteImageUrl(value, baseUrl) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try { return new URL(raw, `${normalizeUsmercariImageBaseUrl(baseUrl)}/`).toString(); } catch (_) { return ''; }
}

function parseUsmercariImagePayload(payload, baseUrl) {
  const imageUrls = (Array.isArray(payload?.data) ? payload.data : [])
    .map((item) => absoluteImageUrl(item?.url, baseUrl))
    .filter(Boolean);
  if (!imageUrls.length) return { error: 'USMercari 图片生成成功但未返回图片地址' };
  return {
    image_url: imageUrls[0],
    image_urls: imageUrls,
    provider: {
      credits_used: payload?.provider?.credits_used ?? null,
      model_id: payload?.provider?.model_id ?? null,
    },
  };
}

async function callUsmercariImageApi(config, log, opts = {}) {
  const apiKey = resolveUsmercariApiKey(config);
  if (!apiKey) return { error: 'USMercari API Key 未配置' };
  let baseUrl;
  try {
    baseUrl = normalizeUsmercariImageBaseUrl(config?.base_url);
  } catch (error) {
    return { error: error.message };
  }

  let checked;
  try {
    checked = validateUsmercariImageOptions(opts);
  } catch (error) {
    return { error: error.message };
  }

  const allowedBaseUrl = opts.allowed_reference_base_url || opts.files_base_url || '';
  const publicReferences = checked.references.filter((reference) => (
    isAllowedStoragePublicImageUrl(reference, allowedBaseUrl)
  ));
  if (publicReferences.length !== checked.references.length) {
    return { error: 'USMercari 参考图必须是配置 STORAGE_BASE_URL 下的站内静态资源公网 URL' };
  }

  const body = {
    ...buildUsmercariImageBody(opts),
    ...(publicReferences.length === 1 ? { image_url: publicReferences[0] } : {}),
    ...(publicReferences.length > 1 ? { image_urls: publicReferences } : {}),
  };
  const url = `${baseUrl}/v1/images/generations`;
  log?.info?.('[USMercari 图片] 创建任务', {
    image_gen_id: opts.image_gen_id,
    model: body.model,
    resolution: body.resolution,
    aspect_ratio: body.aspect_ratio,
    quantity: body.n,
    reference_count: publicReferences.length,
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
      error: `USMercari 图片创建请求连接中断，供应商可能已受理或扣费但本平台未取得结果；为避免重复扣费，不得自动重试。原始错误: ${error.message}`,
    };
  }

  const raw = await response.text();
  const payload = parseJson(raw);
  if (!response.ok) {
    return {
      error: `USMercari 图片生成失败 (${response.status}): ${providerMessage(payload, raw, `HTTP ${response.status}`)}`,
    };
  }
  if (!payload) return { error: 'USMercari 图片生成返回了非 JSON 响应' };
  return parseUsmercariImagePayload(payload, baseUrl);
}

module.exports = {
  USMERCARI_IMAGE_ORIGIN,
  USMERCARI_IMAGE_MODELS,
  normalizeUsmercariImageBaseUrl,
  normalizeResolution,
  validateUsmercariImageOptions,
  buildUsmercariImageBody,
  parseUsmercariImagePayload,
  isAllowedStoragePublicImageUrl,
  parseStorageBaseUrl,
  callUsmercariImageApi,
};
