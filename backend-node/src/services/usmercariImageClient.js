const {
  normalizeUsmercariBaseUrl,
  resolveUsmercariApiKey,
  uploadUsmercariMedia,
} = require('./usmercariVideoClient');

const VERIFIED_RESOLUTIONS = Object.freeze(['1k', '2k', '4k']);
const VERIFIED_IMAGE_SPEC = Object.freeze({
  resolutions: VERIFIED_RESOLUTIONS,
  maxReferences: 6,
});
const USMERCARI_IMAGE_MODELS = Object.freeze({
  'gpt-image-2-2-4k': VERIFIED_IMAGE_SPEC,
  'nano-banana-2': VERIFIED_IMAGE_SPEC,
});

function normalizeResolution(value) {
  return String(value || '1k').trim().toLowerCase();
}

function normalizeReferences(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
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
  if (!Number.isSafeInteger(n) || n < 1 || n > 4) {
    throw new Error('USMercari 图片数量必须是 1 到 4 之间的整数');
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
  if (message) return String(message).slice(0, 300);
  if (/^\s*</.test(String(raw || ''))) return '供应商返回了非 JSON 错误页';
  return String(raw || fallback).slice(0, 300);
}

function absoluteImageUrl(value, baseUrl) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try { return new URL(raw, `${normalizeUsmercariBaseUrl(baseUrl)}/`).toString(); } catch (_) { return ''; }
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
  const baseUrl = normalizeUsmercariBaseUrl(config?.base_url || 'https://chat-ai.mercarimx.com');

  let checked;
  try {
    checked = validateUsmercariImageOptions(opts);
  } catch (error) {
    return { error: error.message };
  }

  let imageIds = [];
  try {
    for (const reference of checked.references) {
      imageIds.push(await uploadUsmercariMedia({ ...config, base_url: baseUrl }, 'image', reference, {
        storage_local_path: opts.storage_local_path,
      }));
    }
  } catch (error) {
    return { error: error.message };
  }

  const body = {
    ...buildUsmercariImageBody(opts),
    ...(imageIds.length ? { image_ids: imageIds } : {}),
  };
  const endpoint = imageIds.length ? '/v1/images/edits' : '/v1/images/generations';
  const url = `${baseUrl}${endpoint}`;
  log?.info?.('[USMercari 图片] 创建任务', {
    image_gen_id: opts.image_gen_id,
    model: body.model,
    resolution: body.resolution,
    aspect_ratio: body.aspect_ratio,
    quantity: body.n,
    reference_count: imageIds.length,
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
  return parseUsmercariImagePayload(payload, config?.base_url);
}

module.exports = {
  USMERCARI_IMAGE_MODELS,
  normalizeResolution,
  validateUsmercariImageOptions,
  buildUsmercariImageBody,
  parseUsmercariImagePayload,
  callUsmercariImageApi,
};
