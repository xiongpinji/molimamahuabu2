const aiConfigService = require('./aiConfigService');
const mediaModelSelection = require('./mediaModelSelectionService');
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

const TOKEN6688_IMAGE_CAPABILITIES = Object.freeze({
  'doubao-seedream-5-0': {
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'],
    resolutions: ['2K'], quantities: [1], maxReferences: 3,
  },
  'gpt-image-2': {
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
    resolutions: ['1K', '2K', '4K'], quantities: [1], maxReferences: 9,
  },
  'token6688-gpt-image-2': {
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
    resolutions: ['1K', '2K', '4K'], quantities: [1], maxReferences: 9,
  },
  'gemini-3-pro-image': {
    aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
    resolutions: ['1K', '2K', '4K'], quantities: [1], maxReferences: 3,
  },
});

function isRealGenerationVerified(config, model) {
  const provider = String(config.provider || '').toLowerCase();
  const protocol = String(config.api_protocol || '').toLowerCase();
  if (provider !== 'token6688' && provider !== 'tokengo' && protocol !== 'token6688') return true;
  try {
    const settings = typeof config.settings === 'string' ? JSON.parse(config.settings) : config.settings;
    const verified = Array.isArray(settings?.real_generation_verified_models)
      ? settings.real_generation_verified_models
      : [];
    const target = String(model || '').trim().toLowerCase();
    return verified.some((item) => String(item || '').trim().toLowerCase() === target);
  } catch (_) {
    return false;
  }
}

function safeCapabilities(settings, config = {}, model = '') {
  try {
    const parsed = typeof settings === 'string' ? JSON.parse(settings) : settings;
    const perModel = parsed?.canvas_capabilities_by_model?.[model];
    const value = perModel || parsed?.canvas_capabilities;
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    const provider = String(config.provider || '').toLowerCase();
    return (provider === 'token6688' || provider === 'tokengo')
      ? (TOKEN6688_IMAGE_CAPABILITIES[model] || {})
      : {};
  } catch (_) {
    const provider = String(config.provider || '').toLowerCase();
    return (provider === 'token6688' || provider === 'tokengo')
      ? (TOKEN6688_IMAGE_CAPABILITIES[model] || {})
      : {};
  }
}

function isUsmercariImageConfig(config) {
  return KIND_BY_SERVICE[config.service_type] === 'image'
    && (String(config.provider || '').toLowerCase() === 'usmercari_image'
      || String(config.api_protocol || '').toLowerCase() === 'usmercari_image');
}

function verifiedImageCapabilities(config, model, price) {
  if (!isUsmercariImageConfig(config)) return null;
  if (config.verification_status !== 'verified' || !aiConfigService.hasConnectionCredential(config)) return false;
  const target = String(model || '').trim().toLowerCase();
  const capabilityKey = Object.keys(config.verified_capabilities || {})
    .find((item) => String(item).trim().toLowerCase() === target);
  const capabilities = capabilityKey ? config.verified_capabilities[capabilityKey] : null;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return false;
  const resolutions = Array.isArray(capabilities.resolutions)
    ? [...new Set(capabilities.resolutions.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))]
    : [];
  if (!capabilities.supportsTextToImage || !resolutions.length || !price) return false;
  const allPriced = resolutions.every((resolution) => {
    const credits = price.resolution_prices?.[resolution]?.credits;
    return Number.isSafeInteger(credits) && credits > 0;
  });
  return allPriced ? { ...capabilities, resolutions } : false;
}

function list(db, options = {}) {
  const prices = new Map(modelPriceService.list(db)
    .filter((row) => row.status === 'enabled')
    .map((row) => [String(row.model).toLowerCase(), row]));
  const seen = new Set();
  const configs = aiConfigService.listConfigs(db);
  const mediaEntries = mediaModelSelection.listEntries(configs);
  const nonMediaEntries = configs
    .filter((config) => !mediaModelSelection.KIND_BY_SERVICE[config.service_type])
    .flatMap((config) => orderedModels(config).map((model) => ({
      config,
      kind: KIND_BY_SERVICE[config.service_type],
      model,
      upstreamModel: model,
    })));
  const configured = [...mediaEntries, ...nonMediaEntries]
    .filter((entry) => entry.config.is_active !== false
      && entry.kind
      && aiConfigService.isVerifiedConfig(entry.config)
      && isRealGenerationVerified(entry.config, entry.upstreamModel))
    .map((entry) => {
      const { config, kind, model, upstreamModel } = entry;
      const key = `${kind}:${model.toLowerCase()}`;
      if (seen.has(key)) return null;
      const price = prices.get(model.toLowerCase());
      if (!Number.isSafeInteger(price?.credits) || price.credits <= 0) return null;
      const verifiedCapabilities = verifiedImageCapabilities(config, upstreamModel, price);
      if (verifiedCapabilities === false) return null;
      const resolutionPrices = verifiedCapabilities
        ? Object.fromEntries(verifiedCapabilities.resolutions.map((resolution) => [
          resolution,
          price.resolution_prices[resolution],
        ]))
        : price?.resolution_prices || {};
      seen.add(key);
      return {
        kind,
        model,
        upstream_model: upstreamModel,
        label: price?.display_name || model,
        public_note: price?.public_note || null,
        provider: String(config.provider || '').toLowerCase(),
        config_id: config.id,
        default_voice_id: config.service_type === 'tts' ? String(config.voice_id || '').trim() : '',
        credits: price?.credits || null,
        billing_unit: price?.billing_unit || null,
        resolution_prices: resolutionPrices,
        verification_status: config.verification_status || 'pending',
        protocol: config.api_protocol || config.provider || '',
        capabilities: kind === 'video'
          ? videoReferenceCapabilityService.resolve(config, upstreamModel)
          : (verifiedCapabilities || safeCapabilities(config.settings, config, upstreamModel)),
      };
    })
    .filter(Boolean);
  return options.requirePrice
    ? configured.filter((item) => Number.isSafeInteger(item.credits) && item.credits > 0)
    : configured;
}

module.exports = { list, parseModels, safeCapabilities, isRealGenerationVerified };
