const aiConfigService = require('./aiConfigService');
const modelPriceService = require('./modelPriceService');
const canvasProviderConfigService = require('./canvasProviderConfigService');

const KIND_BY_SERVICE = {
  text: 'text',
  image: 'image',
  storyboard_image: 'image',
  video: 'video',
  tts: 'audio',
};

function parseModels(value, fallback) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parseModels(parsed);
    } catch (_) {}
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return fallback ? [String(fallback).trim()].filter(Boolean) : [];
}

function safeCapabilities(settings) {
  try {
    const parsed = typeof settings === 'string' ? JSON.parse(settings) : settings;
    const value = parsed?.canvas_capabilities;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_) {
    return {};
  }
}

function list(db) {
  const prices = new Map(modelPriceService.list(db)
    .filter((row) => row.status === 'enabled')
    .map((row) => [String(row.model).toLowerCase(), row]));
  const seen = new Set();
  const configured = aiConfigService.listConfigs(db)
    .filter((config) => config.is_active !== false && KIND_BY_SERVICE[config.service_type])
    .flatMap((config) => parseModels(config.model, config.default_model).map((model) => {
      const key = `${KIND_BY_SERVICE[config.service_type]}:${model.toLowerCase()}`;
      if (seen.has(key)) return null;
      seen.add(key);
      const price = prices.get(model.toLowerCase());
      return {
        kind: KIND_BY_SERVICE[config.service_type],
        model,
        label: price?.display_name || model,
        credits: price?.credits || null,
        capabilities: safeCapabilities(config.settings),
      };
    }))
    .filter(Boolean);
  for (const item of canvasProviderConfigService.listSafe()) {
    const key = `${item.kind}:${item.model.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      configured.push(item);
    }
  }
  return configured;
}

module.exports = { list, parseModels, safeCapabilities };
