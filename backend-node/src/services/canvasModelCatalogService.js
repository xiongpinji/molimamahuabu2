const aiConfigService = require('./aiConfigService');
const modelPriceService = require('./modelPriceService');
const videoReferenceCapabilityService = require('./videoReferenceCapabilityService');

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

function orderedModels(config) {
  const candidates = [String(config.default_model || '').trim(), ...parseModels(config.model)]
    .filter(Boolean);
  const seen = new Set();
  return candidates.filter((model) => {
    const key = model.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
      && aiConfigService.isVerifiedConfig(config))
    .flatMap((config) => orderedModels(config).map((model) => {
      const kind = KIND_BY_SERVICE[config.service_type];
      const key = `${kind}:${model.toLowerCase()}`;
      if (seen.has(key)) return null;
      const price = prices.get(model.toLowerCase());
      if (!Number.isSafeInteger(price?.credits) || price.credits <= 0) return null;
      seen.add(key);
      return {
        kind,
        model,
        label: price?.display_name || model,
        provider: String(config.provider || '').toLowerCase(),
        default_voice_id: config.service_type === 'tts' ? String(config.voice_id || '').trim() : '',
        credits: price?.credits || null,
        billing_unit: price?.billing_unit || null,
        capabilities: kind === 'video'
          ? videoReferenceCapabilityService.resolve(config, model)
          : safeCapabilities(config.settings),
      };
    }))
    .filter(Boolean);
  return options.requirePrice
    ? configured.filter((item) => Number.isSafeInteger(item.credits) && item.credits > 0)
    : configured;
}

module.exports = { list, parseModels, safeCapabilities };
