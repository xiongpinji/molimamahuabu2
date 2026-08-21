'use strict';

// 本地别名避免与其他供应商的同名 GPT Image 配置串路由；请求时映射回 fumin 上游模型名。
const FUMIN_IMAGE_MODELS = Object.freeze({
  'fumin-gpt-image-2': 'gpt-image-2',
  'fumin-gpt-image-2-4K': 'gpt-image-2-4K',
});

function resolveFuminImageModel(model) {
  const value = String(model || '').trim();
  const exact = FUMIN_IMAGE_MODELS[value];
  if (exact) return exact;
  const normalized = Object.keys(FUMIN_IMAGE_MODELS).find((key) => key.toLowerCase() === value.toLowerCase());
  return normalized ? FUMIN_IMAGE_MODELS[normalized] : value;
}

function validateFuminImageModels({ provider, serviceType, model }) {
  if (String(provider || '').toLowerCase() !== 'fumin_image'
    || !['image', 'storyboard_image'].includes(String(serviceType || '').toLowerCase())) return;
  const models = Array.isArray(model) ? model : model == null ? [] : [model];
  const allowed = new Set(Object.keys(FUMIN_IMAGE_MODELS).map((item) => item.toLowerCase()));
  const invalid = models
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((item) => !allowed.has(item.toLowerCase()));
  if (invalid.length) {
    const error = new Error(`fumin 图片模型未经真实生成验证，禁止配置: ${invalid.join(', ')}`);
    error.code = 'INVALID_FUMIN_IMAGE_MODEL';
    throw error;
  }
}

function normalizeFuminImageBaseUrl(value) {
  const base = String(value || 'https://fumin.ai/v1').trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  return `${base}/v1`;
}

module.exports = {
  FUMIN_IMAGE_MODELS,
  resolveFuminImageModel,
  normalizeFuminImageBaseUrl,
  validateFuminImageModels,
};
