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

const USMERCARI_VIDEO_CAPABILITIES = Object.freeze({
  durations: Object.freeze([5]),
  aspectRatios: Object.freeze(['16:9']),
  maxReferences: 4,
  maxVideoReferences: 1,
  maxAudioReferences: 1,
  supportsFirstFrame: true,
  supportsLastFrame: true,
  supportsImageReference: true,
  supportsVideoReference: true,
  supportsAudioReference: true,
  supportsAudio: true,
});

const FUMIN_VIDEO_CAPABILITIES = Object.freeze({
  durations: Object.freeze([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
  aspectRatios: Object.freeze(['16:9']),
  resolutions: Object.freeze(['480p']),
  maxReferences: 9,
  maxVideoReferences: 3,
  maxAudioReferences: 3,
  supportsImageReference: true,
  supportsVideoReference: true,
  supportsAudioReference: true,
  supportsAudio: true,
});

function providerCapabilities(provider, model) {
  if (['fumin', 'fumin_video'].includes(String(provider || '').toLowerCase())
    && ['fumin-seedance-2.0-fast', 'fumin-seedance-2.0-mini'].includes(String(model))) {
    return { ...FUMIN_VIDEO_CAPABILITIES };
  }
  if (!['usmercari', 'usmercari_media'].includes(String(provider || '').toLowerCase())) return {};
  if (!['MiniMax H3', 'seedance-2.0-fast', 'seedance-2.0-mini'].includes(String(model))) return {};
  const resolutions = String(model) === 'MiniMax H3' ? ['480p'] : ['480p', '720p'];
  return { ...USMERCARI_VIDEO_CAPABILITIES, resolutions };
}

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

function safeCapabilities(settings, model) {
  try {
    const parsed = typeof settings === 'string' ? JSON.parse(settings) : settings;
    const value = parsed?.canvas_capabilities;
    const base = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const perModel = model && parsed?.canvas_capabilities_by_model?.[model];
    return perModel && typeof perModel === 'object' && !Array.isArray(perModel)
      ? { ...base, ...perModel }
      : base;
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
        billing_unit: price?.billing_unit || null,
        resolution_prices: price?.resolution_prices || {},
        capabilities: {
          ...providerCapabilities(config.provider, model),
          ...safeCapabilities(config.settings, model),
        },
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

module.exports = { list, parseModels, safeCapabilities, providerCapabilities };
