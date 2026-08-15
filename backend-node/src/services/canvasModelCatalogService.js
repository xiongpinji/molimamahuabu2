const aiConfigService = require('./aiConfigService');
const canvasProviderConfigService = require('./canvasProviderConfigService');
const mediaModelSelection = require('./mediaModelSelectionService');
const modelPriceService = require('./modelPriceService');
const { IMAGE_REFERENCE_LIMITS } = require('./token6688Client');
const videoReferenceCapabilityService = require('./videoReferenceCapabilityService');
const { USMERCARI_MODELS } = require('./usmercariVideoClient');
const { FUMIN_MODELS } = require('./fuminVideoClient');
const toapisVideoClient = require('./toapisVideoClient');
const feituoVideoClient = require('./feituoVideoClient');
const lingjingVideoClient = require('./lingjingVideoClient');
const { hasTrustedEvidenceBinding } = require('./externalModelEvidenceService');

const KIND_BY_SERVICE = {
  text: 'text',
  image: 'image',
  storyboard_image: 'image',
  video: 'video',
  tts: 'audio',
};

const PRIVATE_CATALOG_FIELDS = new Set([
  'provider', 'baseurl', 'apikey', 'hostname', 'domain',
  'accesstoken', 'refreshtoken', 'sessiontoken', 'token', 'secret', 'secretkey',
]);
const PRIVATE_CATALOG_FRAGMENTS = ['token', 'secret', 'credential', 'password', 'accesskey'];

const STRICT_VERIFIED_PROTOCOLS = new Set(['usmercari_image', 'toapis_video', 'feituo_open', 'lingjing_open']);

const USMERCARI_VIDEO_CAPABILITIES = Object.freeze({
  aspectRatios: Object.freeze(['16:9']),
  supportsFirstFrame: true,
  supportsLastFrame: true,
  supportsImageReference: true,
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
  if (['fumin', 'fumin_video'].includes(normalizedProvider)) {
    if (!Object.prototype.hasOwnProperty.call(FUMIN_MODELS, String(model))) return {};
    return { ...FUMIN_VIDEO_CAPABILITIES };
  }
  if (!['usmercari', 'usmercari_media'].includes(normalizedProvider)) return {};
  const spec = USMERCARI_MODELS[String(model)];
  if (!spec) return {};
  return {
    ...USMERCARI_VIDEO_CAPABILITIES,
    maxReferences: spec.maxImages,
    maxImageReferences: spec.maxImages,
    maxVideoReferences: spec.maxVideos,
    maxAudioReferences: spec.maxAudio,
    supportsVideoReference: spec.maxVideos > 0,
    durations: spec.durations,
    resolutions: spec.resolutions,
  };
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

function isPrivateCatalogField(key) {
  const normalized = key.replace(/[_-]/g, '').toLowerCase();
  return PRIVATE_CATALOG_FIELDS.has(normalized)
    || PRIVATE_CATALOG_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function publicCapabilityValue(value) {
  if (Array.isArray(value)) return value.map(publicCapabilityValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !isPrivateCatalogField(key))
    .map(([key, item]) => [key, publicCapabilityValue(item)]));
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
  const token6688 = provider === 'token6688' || provider === 'tokengo' || protocol === 'token6688';
  const feituo = provider === 'feituo' || protocol === 'feituo_open';
  if (!token6688 && !feituo) return true;
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
  const resolvedModel = typeof config === 'string' && !model ? config : model;
  const resolvedConfig = typeof config === 'string' && !model ? {} : config;
  try {
    const parsed = typeof settings === 'string' ? JSON.parse(settings) : settings;
    const base = parsed?.canvas_capabilities;
    const perModel = parsed?.canvas_capabilities_by_model?.[resolvedModel];
    const baseValue = base && typeof base === 'object' && !Array.isArray(base) ? base : {};
    const value = perModel && typeof perModel === 'object' && !Array.isArray(perModel)
      ? { ...baseValue, ...perModel }
      : baseValue;
    if (Object.keys(value).length) return publicCapabilityValue(value);
    const provider = String(resolvedConfig.provider || '').toLowerCase();
    return publicCapabilityValue((provider === 'token6688' || provider === 'tokengo')
      ? (TOKEN6688_IMAGE_CAPABILITIES[resolvedModel] || {})
      : {});
  } catch (_) {
    const provider = String(resolvedConfig.provider || '').toLowerCase();
    return publicCapabilityValue((provider === 'token6688' || provider === 'tokengo')
      ? (TOKEN6688_IMAGE_CAPABILITIES[resolvedModel] || {})
      : {});
  }
}

function legacySafeCapabilities(settings, model) {
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

function strictVerifiedProtocol(config) {
  const values = [config.api_protocol, config.provider]
    .map((value) => String(value || '').trim().toLowerCase());
  if (values.includes('usmercari_image')) return 'usmercari_image';
  if (values.some((value) => value === 'toapis' || value === 'toapis_video')) return 'toapis_video';
  if (values.some((value) => value === 'feituo' || value === 'feituo_open')) return 'feituo_open';
  if (values.some((value) => value === 'lingjing' || value === 'lingjing_open')) return 'lingjing_open';
  return null;
}

function verifiedModelCapabilities(config, model, price, evidenceRoots) {
  const protocol = strictVerifiedProtocol(config);
  if (!STRICT_VERIFIED_PROTOCOLS.has(protocol)) return null;
  if (config.verification_status !== 'verified' || !aiConfigService.hasConnectionCredential(config)) return false;
  const target = String(model || '').trim().toLowerCase();
  const capabilityKey = Object.keys(config.verified_capabilities || {})
    .find((item) => String(item).trim().toLowerCase() === target);
  const capabilities = capabilityKey ? config.verified_capabilities[capabilityKey] : null;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return false;
  if (protocol !== 'feituo_open' && !hasTrustedEvidenceBinding(target, capabilities, evidenceRoots)) return false;
  const { evidence_contract: _evidenceContract, evidence_sha256: _evidenceSha256, ...publicCapabilitySource } = capabilities;
  const feituoOfficial = protocol === 'feituo_open'
    ? feituoVideoClient.FEITUO_MODELS[target]
    : null;
  const lingjingOfficial = protocol === 'lingjing_open' && target === lingjingVideoClient.PUBLIC_MODEL
    ? lingjingVideoClient.LINGJING_VIDEO_SPEC
    : null;
  if (protocol === 'feituo_open' && (!target.startsWith('xuan-') || !feituoOfficial)) return false;
  const allowedResolutions = protocol === 'usmercari_image'
    ? modelPriceService.IMAGE_RESOLUTIONS
    : protocol === 'feituo_open'
      ? feituoOfficial.resolutions
      : protocol === 'lingjing_open'
        ? []
      : modelPriceService.VIDEO_RESOLUTIONS;
  const resolutions = Array.isArray(capabilities.resolutions)
    ? [...new Set(capabilities.resolutions
      .map((item) => String(item || '').trim().toLowerCase())
      .filter((resolution) => allowedResolutions.includes(resolution)))]
    : [];
  let publicCapabilities = { ...publicCapabilitySource, resolutions };
  if (protocol === 'toapis_video' || protocol === 'feituo_open' || protocol === 'lingjing_open') {
    const official = protocol === 'toapis_video'
      ? toapisVideoClient.TOAPIS_VIDEO_MODELS[target]
      : protocol === 'feituo_open' ? feituoOfficial : lingjingOfficial;
    const verifiedDurations = new Set(Array.isArray(capabilities.durations)
      ? capabilities.durations.map(Number).filter(Number.isSafeInteger)
      : []);
    const durations = official
      ? official.durations.filter((duration) => verifiedDurations.has(duration))
      : [];
    if (!durations.length) return false;
    publicCapabilities = { ...publicCapabilities, durations };
  }
  if (protocol === 'lingjing_open') {
    const ratios = Array.isArray(capabilities.aspectRatios)
      ? lingjingOfficial.aspectRatios.filter((ratio) => capabilities.aspectRatios.includes(ratio))
      : [];
    const maxReferences = Number(capabilities.maxReferences);
    if (!lingjingOfficial
        || resolutions.length !== 0
        || ratios.length !== lingjingOfficial.aspectRatios.length
        || capabilities.supportsImageReference !== true
        || capabilities.supportsFirstFrame !== false
        || capabilities.supportsLastFrame !== false
        || capabilities.supportsVideoReference !== false
        || capabilities.supportsAudioReference !== false
        || capabilities.supportsAudio !== false
        || !Number.isSafeInteger(maxReferences)
        || maxReferences < 0
        || maxReferences > lingjingVideoClient.MAX_IMAGE_REFERENCES) return false;
    return price.category === 'video'
      && price.billing_unit === 'second'
      && price.cost_unit === 'second'
      && Number.isSafeInteger(price.credits)
      && price.credits > 0
      && Number.isSafeInteger(price.cost_micros_per_unit)
      && price.cost_micros_per_unit > 0
      ? { ...publicCapabilities, aspectRatios: ratios, resolutions: [] }
      : false;
  }
  if ((protocol === 'usmercari_image' && capabilities.supportsTextToImage !== true)
      || !resolutions.length || !price) return false;
  if (protocol === 'feituo_open' && feituoOfficial.resolutions.length === 1) {
    return price.category === 'video'
      && price.billing_unit === 'request'
      && Number.isSafeInteger(price.credits)
      && price.credits > 0
      ? publicCapabilities
      : false;
  }
  const allPriced = resolutions.every((resolution) => {
    const credits = price.resolution_prices?.[resolution]?.credits;
    return Number.isSafeInteger(credits) && credits > 0;
  });
  return allPriced ? publicCapabilities : false;
}

function verifiedConfigIds(db) {
  const hasVerificationStatus = db.prepare('PRAGMA table_info(ai_service_configs)')
    .all()
    .some((column) => column.name === 'verification_status');
  if (!hasVerificationStatus) return null;
  return new Set(db.prepare(`SELECT id FROM ai_service_configs
    WHERE deleted_at IS NULL AND verification_status = 'verified'`).all().map((row) => row.id));
}

function list(db, options = {}) {
  const prices = new Map(modelPriceService.list(db)
    .filter((row) => row.status === 'enabled')
    .map((row) => [String(row.model).toLowerCase(), row]));
  const verifiedIds = verifiedConfigIds(db);
  const configs = aiConfigService.listConfigs(db);
  const eligibleConfigs = configs.filter((config) => config.is_active !== false
    && KIND_BY_SERVICE[config.service_type]
    && (!verifiedIds || verifiedIds.has(config.id)));
  const configuredModelEntries = eligibleConfigs
    .flatMap((config) => orderedModels(config).map((model) => ({
      config,
      model,
      key: `${KIND_BY_SERVICE[config.service_type]}:${model.toLowerCase()}`,
    })));
  const strictKeys = new Set([
    `video:${lingjingVideoClient.PUBLIC_MODEL}`,
    ...configuredModelEntries
    .filter(({ config }) => strictVerifiedProtocol(config))
    .map(({ key }) => key),
  ]);

  const mediaCandidates = mediaModelSelection.listEntries(eligibleConfigs)
    .filter((entry) => {
      const upstreamKey = `${entry.kind}:${entry.upstreamModel.toLowerCase()}`;
      return !strictKeys.has(upstreamKey) || !!strictVerifiedProtocol(entry.config);
    });
  const mediaCounts = new Map();
  for (const entry of mediaCandidates) {
    const upstreamKey = `${entry.kind}:${entry.upstreamModel.toLowerCase()}`;
    mediaCounts.set(upstreamKey, (mediaCounts.get(upstreamKey) || 0) + 1);
  }
  const mediaEntries = mediaCandidates.map((entry) => {
    const upstreamKey = `${entry.kind}:${entry.upstreamModel.toLowerCase()}`;
    const logicalModel = String(entry.config.logical_model_id || '').trim();
    const model = logicalModel || (mediaCounts.get(upstreamKey) > 1
      ? `cfg-${entry.config.id}::${entry.upstreamModel}`
      : entry.upstreamModel);
    return { ...entry, model };
  });
  const nonMediaEntries = eligibleConfigs
    .filter((config) => !mediaModelSelection.KIND_BY_SERVICE[config.service_type])
    .flatMap((config) => orderedModels(config).map((upstreamModel) => ({
      config,
      kind: KIND_BY_SERVICE[config.service_type],
      model: String(config.logical_model_id || '').trim() || upstreamModel,
      upstreamModel,
    })));
  const seen = new Set();
  const configured = [...mediaEntries, ...nonMediaEntries]
    .filter((entry) => entry.kind
      && (!verifiedIds || aiConfigService.isVerifiedConfig(entry.config))
      && isRealGenerationVerified(entry.config, entry.upstreamModel))
    .map((entry) => {
      const { config, kind, model, upstreamModel } = entry;
      const logicalModel = String(config.logical_model_id || '').trim();
      const key = `${kind}:${model.toLowerCase()}`;
      if (seen.has(key)) return null;
      const price = prices.get(model.toLowerCase());
      if (!Number.isSafeInteger(price?.credits) || price.credits <= 0) return null;
      const verifiedCapabilities = verifiedModelCapabilities(config, upstreamModel, price, options.evidenceRoots);
      if (verifiedCapabilities === false) return null;
      const resolutionPrices = verifiedCapabilities
        ? Object.fromEntries(verifiedCapabilities.resolutions
          .map((resolution) => [resolution, price.resolution_prices[resolution]])
          .filter(([, tier]) => tier))
        : price?.resolution_prices || {};
      seen.add(key);
      return {
        kind,
        model,
        ...(logicalModel ? {} : { upstream_model: upstreamModel }),
        label: price?.display_name || model,
        public_note: price?.public_note || null,
        ...(kind === 'image' ? {} : {
          provider: String(config.provider || '').toLowerCase(),
          protocol: config.api_protocol || config.provider || '',
        }),
        ...(logicalModel ? {} : { config_id: config.id }),
        default_voice_id: config.service_type === 'tts' ? String(config.voice_id || '').trim() : '',
        credits: price?.credits || null,
        billing_unit: price?.billing_unit || null,
        resolution_prices: resolutionPrices,
        verification_status: config.verification_status || 'pending',
        capabilities: publicCapabilityValue(verifiedCapabilities || (kind === 'video'
          ? {
            ...videoReferenceCapabilityService.resolve(config, upstreamModel),
            ...providerCapabilities(config.provider, upstreamModel),
          }
          : safeCapabilities(config.settings, config, upstreamModel))),
      };
    })
    .filter(Boolean);
  if (verifiedIds === null) {
    for (const item of canvasProviderConfigService.listSafe()) {
      const key = `${item.kind}:${item.model.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        configured.push(item);
      }
    }
  }
  return configured;
}

module.exports = { list, parseModels, safeCapabilities, providerCapabilities };
