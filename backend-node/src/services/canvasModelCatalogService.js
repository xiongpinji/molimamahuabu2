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

function list(db, options = {}) {
  const prices = new Map(modelPriceService.list(db)
    .filter((row) => row.status === 'enabled')
    .map((row) => [String(row.model).toLowerCase(), row]));
  const seen = new Set();
  const configured = aiConfigService.listConfigs(db)
    .filter((config) => config.is_active !== false
      && KIND_BY_SERVICE[config.service_type]
      && (config.service_type !== 'video' || aiConfigService.isVerifiedConfig(config)))
    .flatMap((config) => parseModels(config.model, config.default_model).map((model) => {
      const kind = KIND_BY_SERVICE[config.service_type];
      const key = `${kind}:${model.toLowerCase()}`;
      if (seen.has(key)) return null;
      const price = prices.get(model.toLowerCase());
      if (kind === 'video' && (!Number.isSafeInteger(price?.credits) || price.credits <= 0)) return null;
      seen.add(key);
      return {
        kind,
        model,
        label: price?.display_name || model,
        provider: String(config.provider || '').toLowerCase(),
        default_voice_id: config.service_type === 'tts' ? String(config.voice_id || '').trim() : '',
        credits: price?.credits || null,
        billing_unit: price?.billing_unit || null,
        capabilities: safeCapabilities(config.settings),
      };
    }))
    .filter(Boolean);
  for (const item of canvasProviderConfigService.listSafe()) {
    if (item.kind === 'video') continue;
    const key = `${item.kind}:${item.model.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      configured.push(item);
    }
  }
  return options.requirePrice
    ? configured.filter((item) => Number.isSafeInteger(item.credits) && item.credits > 0)
    : configured;
}

module.exports = { list, parseModels, safeCapabilities };
