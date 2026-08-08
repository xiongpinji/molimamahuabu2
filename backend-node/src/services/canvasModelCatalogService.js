const aiConfigService = require('./aiConfigService');
const modelPriceService = require('./modelPriceService');
const { IMAGE_REFERENCE_LIMITS } = require('./token6688Client');
const videoReferenceCapabilityService = require('./videoReferenceCapabilityService');
const { USMERCARI_VIDEO_DURATIONS } = require('./usmercariVideoClient');

const KIND_BY_SERVICE = {
  text: 'text',
  image: 'image',
  storyboard_image: 'image',
  video: 'video',
  tts: 'audio',
};

// 供应商确认的分模型媒体上限；与 usmercariVideoClient.USMERCARI_MODELS 保持一致
const USMERCARI_VIDEO_CAPABILITIES = Object.freeze({
  durations: USMERCARI_VIDEO_DURATIONS,
  aspectRatios: Object.freeze(['16:9']),
  supportsFirstFrame: true,
  supportsLastFrame: true,
  supportsImageReference: true,
  supportsAudioReference: true,
  supportsAudio: true,
});

const USMERCARI_MODEL_MEDIA_LIMITS = Object.freeze({
  'MiniMax H3': Object.freeze({
    maxReferences: 5, maxVideoReferences: 0, maxAudioReferences: 3,
    supportsVideoReference: false, resolutions: Object.freeze(['480p']),
  }),
  'seedance-2.0-fast': Object.freeze({
    maxReferences: 9, maxVideoReferences: 3, maxAudioReferences: 3,
    supportsVideoReference: true, resolutions: Object.freeze(['480p', '720p']),
  }),
  'seedance-2.0-mini': Object.freeze({
    maxReferences: 9, maxVideoReferences: 3, maxAudioReferences: 3,
    supportsVideoReference: true, resolutions: Object.freeze(['480p', '720p']),
  }),
});

function providerCapabilities(provider, model) {
  const normalizedProvider = String(provider || '').toLowerCase();
  if (['token6688', 'tokengo'].includes(normalizedProvider)) {
    const maxReferences = IMAGE_REFERENCE_LIMITS[String(model)];
    if (maxReferences) {
      return { referenceTypes: ['image'], maxReferences, maxImageReferences: maxReferences };
    }
    return videoReferenceCapabilityService.knownCapabilities({
      provider: normalizedProvider,
      api_protocol: 'token6688',
    }, model);
  }
  if (!['usmercari', 'usmercari_media'].includes(normalizedProvider)) return {};
  const limits = USMERCARI_MODEL_MEDIA_LIMITS[String(model)];
  if (!limits) return {};
  return { ...USMERCARI_VIDEO_CAPABILITIES, ...limits };
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
  const hasVerificationStatus = db.prepare('PRAGMA table_info(ai_service_configs)').all()
    .some((column) => column.name === 'verification_status');
  const publicPrices = new Map(modelPriceService.listPublic(db)
    .filter((row) => row.status === 'enabled')
    .map((row) => [String(row.model).toLowerCase(), row]));
  const seen = new Set();
  const configured = aiConfigService.listConfigs(db)
    .filter((config) => (
      config.is_active !== false
      && KIND_BY_SERVICE[config.service_type]
      && (!hasVerificationStatus || config.verification_status === 'verified')
    ))
    .flatMap((config) => parseModels(config.model, config.default_model).map((model) => {
      const kind = KIND_BY_SERVICE[config.service_type];
      const price = publicPrices.get(model.toLowerCase());
      if (!price || String(price.category).toLowerCase() !== kind) return null;
      const key = `${kind}:${model.toLowerCase()}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        kind,
        model,
        label: price.display_name || model,
        note: price.public_note || '',
        provider: config.provider || '',
        default_voice_id: config.voice_id || null,
        credits: price.credits,
        billing_unit: price.billing_unit || null,
        resolution_prices: price.resolution_prices || {},
        capabilities: {
          ...providerCapabilities(config.provider, model),
          ...safeCapabilities(config.settings, model),
        },
      };
    }))
    .filter(Boolean);
  return configured;
}

module.exports = { list, parseModels, safeCapabilities, providerCapabilities };
