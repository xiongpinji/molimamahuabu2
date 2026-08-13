'use strict';

// 本地别名避免与其他供应商的同名 GPT Image 配置串路由；请求时映射回 fumin 上游模型名。
const FUMIN_IMAGE_MODELS = Object.freeze({
  'fumin-gpt-image-2': 'gpt-image-2',
  'fumin-gpt-image-2-4K': 'gpt-image-2-4K',
});

function resolveFuminImageModel(model) {
  const value = String(model || '').trim();
  return FUMIN_IMAGE_MODELS[value] || value;
}

function normalizeFuminImageBaseUrl(value) {
  const base = String(value || 'https://fumin.ai/v1').trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  return `${base}/v1`;
}

module.exports = {
  FUMIN_IMAGE_MODELS,
  resolveFuminImageModel,
  normalizeFuminImageBaseUrl,
};
