const aiConfigService = require('./aiConfigService');
const canvasProviderConfigService = require('./canvasProviderConfigService');
const mediaModelSelection = require('./mediaModelSelectionService');
const modelPriceService = require('./modelPriceService');
const providerRouteStabilityService = require('./providerRouteStabilityService');
const { IMAGE_REFERENCE_LIMITS } = require('./token6688Client');
const videoReferenceCapabilityService = require('./videoReferenceCapabilityService');
const { USMERCARI_MODELS } = require('./usmercariVideoClient');
const { FUMIN_MODELS } = require('./fuminVideoClient');
const toapisVideoClient = require('./toapisVideoClient');
const toapisWan3VideoClient = require('./toapisWan3VideoClient');
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

const PRIVATE_CATALOG_FRAGMENTS = Object.freeze([
  'provider', 'protocol', 'config', 'upstream', 'relay', 'evidence', 'cost',
  'credential', 'secret', 'token', 'password', 'accesskey', 'apikey',
  'baseurl', 'hostname', 'domain', 'endpoint',
]);

const STRICT_VERIFIED_PROTOCOLS = new Set(['usmercari_image', 'toapis_video', 'toapis_wan3_video', 'feituo_open', 'lingjing_open']);

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
  const normalized = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
  return normalized === 'base'
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
  if (values.includes('toapis_wan3_video')) return 'toapis_wan3_video';
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
  if (protocol !== 'feituo_open'
      && !hasTrustedEvidenceBinding(target, capabilities, evidenceRoots, config)) return false;
  const { evidence_contract: _evidenceContract, evidence_sha256: _evidenceSha256, ...publicCapabilitySource } = capabilities;
  const feituoOfficial = protocol === 'feituo_open'
    ? feituoVideoClient.FEITUO_MODELS[target]
    : null;
  const lingjingOfficial = protocol === 'lingjing_open' && target === lingjingVideoClient.PUBLIC_MODEL
    ? lingjingVideoClient.LINGJING_VIDEO_SPEC
    : null;
  const wan3Official = protocol === 'toapis_wan3_video' && target === toapisWan3VideoClient.TOAPIS_WAN3_MODEL
    ? toapisWan3VideoClient.TOAPIS_WAN3_SPEC
    : null;
  if (protocol === 'feituo_open' && (!target.startsWith('xuan-') || !feituoOfficial)) return false;
  const allowedResolutions = protocol === 'usmercari_image'
    ? modelPriceService.IMAGE_RESOLUTIONS
    : protocol === 'feituo_open'
      ? feituoOfficial.resolutions
      : protocol === 'toapis_video'
        ? (toapisVideoClient.TOAPIS_VIDEO_MODELS[target]?.resolutions || [])
      : protocol === 'toapis_wan3_video'
        ? (wan3Official?.resolutions || [])
      : protocol === 'lingjing_open'
        ? []
      : modelPriceService.VIDEO_RESOLUTIONS;
  const resolutions = Array.isArray(capabilities.resolutions)
    ? [...new Set(capabilities.resolutions
      .map((item) => String(item || '').trim().toLowerCase())
      .filter((resolution) => allowedResolutions.includes(resolution)))]
    : [];
  let publicCapabilities = { ...publicCapabilitySource, resolutions };
  if (protocol === 'toapis_video' || protocol === 'toapis_wan3_video'
      || protocol === 'feituo_open' || protocol === 'lingjing_open') {
    const official = protocol === 'toapis_video'
      ? toapisVideoClient.TOAPIS_VIDEO_MODELS[target]
      : protocol === 'toapis_wan3_video' ? wan3Official
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
  if (protocol === 'toapis_wan3_video') {
    const aspectRatios = Array.isArray(capabilities.aspectRatios) && wan3Official
      ? wan3Official.aspectRatios.filter((ratio) => capabilities.aspectRatios.includes(ratio))
      : [];
    const audioValues = Array.isArray(capabilities.audio_values)
      ? capabilities.audio_values.filter((value) => value === false || value === true)
      : [];
    publicCapabilities = {
      ...publicCapabilities,
      aspectRatios,
      audio_values: audioValues,
      supportsAudio: wan3Official?.supportsAudio === true
        && capabilities.supportsAudio === true
        && audioValues.includes(true),
    };
    if (!wan3Official || !aspectRatios.length || !audioValues.length) return false;
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
    const tier = price.resolution_prices?.[resolution];
    return Number.isSafeInteger(tier?.credits) && tier.credits > 0
      && (protocol !== 'toapis_wan3_video'
        || (Number.isSafeInteger(tier.cost_micros_per_second) && tier.cost_micros_per_second > 0));
  });
  return allPriced && (protocol !== 'toapis_wan3_video'
    || (price.category === 'video' && price.billing_unit === 'second' && price.cost_unit === 'second'))
    ? publicCapabilities
    : false;
}

function verifiedConfigIds(db) {
  const hasVerificationStatus = db.prepare('PRAGMA table_info(ai_service_configs)')
    .all()
    .some((column) => column.name === 'verification_status');
  if (!hasVerificationStatus) return null;
  return new Set(db.prepare(`SELECT id FROM ai_service_configs
    WHERE deleted_at IS NULL AND verification_status = 'verified'`).all().map((row) => row.id));
}

function uniqueSorted(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ''))]
    .sort((left, right) => (typeof left === 'number' && typeof right === 'number'
      ? left - right
      : String(left).localeCompare(String(right), 'en')));
}

function evidenceCapabilityEnvelope(rows) {
  const capabilities = rows.map((row) => row.capability).filter(Boolean);
  const maximum = (field) => capabilities.reduce((value, capability) => (
    Math.max(value, Number(capability[field]) || 0)
  ), 0);
  const maxImageReferences = maximum('referenceImageCount');
  const maxVideoReferences = maximum('referenceVideoCount');
  const maxAudioReferences = maximum('referenceAudioCount');
  return publicCapabilityValue({
    resolutions: uniqueSorted(capabilities.map((capability) => capability.resolution)),
    aspectRatios: uniqueSorted(capabilities.map((capability) => capability.aspectRatio)),
    durations: uniqueSorted(capabilities.map((capability) => capability.duration).filter(Boolean)),
    maxReferences: maxImageReferences,
    maxImageReferences,
    maxVideoReferences,
    maxAudioReferences,
    supportsImageReference: maxImageReferences > 0,
    supportsVideoReference: maxVideoReferences > 0,
    supportsAudioReference: maxAudioReferences > 0,
    supportsAudio: capabilities.some((capability) => capability.requiresAudio === true),
    supportsFirstFrame: capabilities.some((capability) => capability.firstFrame === true),
    supportsLastFrame: capabilities.some((capability) => capability.lastFrame === true),
  });
}

function recordPublicUnavailableTransition(db, logicalModelId, configIds, now) {
  if (!logicalModelId || !configIds.length) return false;
  const placeholders = configIds.map(() => '?').join(',');
  return db.transaction(() => {
    const history = db.prepare(`SELECT MAX(verified_at) AS last_verified_at
      FROM provider_canary_evidence
      WHERE config_id IN (${placeholders}) AND verified_at IS NOT NULL`).get(...configIds);
    if (!history?.last_verified_at) return false;
    const previous = db.prepare(`SELECT MAX(created_at) AS last_event_at
      FROM provider_stability_events
      WHERE event_type = 'provider_canary_public_unavailable'
        AND logical_model_id = ? COLLATE NOCASE`).get(logicalModelId);
    if (previous?.last_event_at && previous.last_event_at >= history.last_verified_at) return false;
    db.prepare(`INSERT INTO provider_stability_events
      (severity, event_type, logical_model_id, safe_details, created_at)
      VALUES ('error', 'provider_canary_public_unavailable', ?, ?, ?)`)
      .run(logicalModelId, JSON.stringify({ category: 'fresh_evidence_unavailable' }), now);
    return true;
  }).immediate();
}

function enforceFreshEvidenceCatalog(db, items, configsByKey, now) {
  const result = [];
  for (const item of items) {
    const key = `${item.kind}:${item.model.toLowerCase()}`;
    const configs = configsByKey.get(key) || [];
    const evidence = providerRouteStabilityService.listFreshCandidateEvidence(db, configs, now);
    if (!evidence.length) {
      const logicalModelId = configs
        .map((config) => String(config.logical_model_id || '').trim())
        .find(Boolean);
      recordPublicUnavailableTransition(db, logicalModelId, configs.map((config) => config.id), now);
      continue;
    }
    const capabilities = evidenceCapabilityEnvelope(evidence);
    const resolutions = new Set(capabilities.resolutions || []);
    result.push({
      ...item,
      resolution_prices: Object.fromEntries(Object.entries(item.resolution_prices || {})
        .filter(([resolution]) => resolutions.has(String(resolution).toLowerCase()))),
      capabilities,
    });
  }
  return result;
}

function list(db, options = {}) {
  const prices = new Map(modelPriceService.list(db)
    .filter((row) => row.status === 'enabled')
    .map((row) => [String(row.model).toLowerCase(), row]));
  const verifiedIds = verifiedConfigIds(db);
  const configs = aiConfigService.listConfigs(db);
  const activeConfigs = configs.filter((config) => config.is_active !== false
    && KIND_BY_SERVICE[config.service_type]);
  const eligibleConfigs = activeConfigs.filter((config) =>
    !verifiedIds || verifiedIds.has(config.id));
  const configuredModelEntries = eligibleConfigs
    .flatMap((config) => orderedModels(config).map((model) => ({
      config,
      model,
      key: `${KIND_BY_SERVICE[config.service_type]}:${model.toLowerCase()}`,
    })));
  const strictKeys = new Set([
    `video:${lingjingVideoClient.PUBLIC_MODEL}`,
    ...activeConfigs
    .flatMap((config) => orderedModels(config).map((model) => ({
      config,
      key: `${KIND_BY_SERVICE[config.service_type]}:${model.toLowerCase()}`,
    })))
    .filter(({ config }) => strictVerifiedProtocol(config))
    .map(({ key }) => key),
  ]);

  const mediaCandidates = mediaModelSelection.listEntries(eligibleConfigs)
    .filter((entry) => {
      if (entry.duplicated
          && !String(entry.config.logical_model_id || '').trim()
          && !strictVerifiedProtocol(entry.config)) return false;
      const upstreamKey = `${entry.kind}:${entry.upstreamModel.toLowerCase()}`;
      return !strictKeys.has(upstreamKey) || !!strictVerifiedProtocol(entry.config);
    });
  const mediaCandidateCounts = new Map();
  for (const entry of mediaCandidates) {
    const key = `${entry.kind}:${entry.upstreamModel.toLowerCase()}`;
    mediaCandidateCounts.set(key, (mediaCandidateCounts.get(key) || 0) + 1);
  }
  const mediaEntries = mediaCandidates.map((entry) => {
    const logicalModel = String(entry.config.logical_model_id || '').trim();
    const upstreamKey = `${entry.kind}:${entry.upstreamModel.toLowerCase()}`;
    const model = logicalModel || (mediaCandidateCounts.get(upstreamKey) > 1
        && prices.has(entry.model.toLowerCase())
      ? entry.model
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
  const allEntries = [...mediaEntries, ...nonMediaEntries];
  const configsByKey = new Map();
  for (const entry of allEntries) {
    const key = `${entry.kind}:${entry.model.toLowerCase()}`;
    if (!configsByKey.has(key)) configsByKey.set(key, []);
    if (!configsByKey.get(key).some((config) => config.id === entry.config.id)) {
      configsByKey.get(key).push(entry.config);
    }
  }
  const configuredCandidates = allEntries
    .filter((entry) => entry.kind
      && (!verifiedIds || aiConfigService.isVerifiedConfig(entry.config))
      && isRealGenerationVerified(entry.config, entry.upstreamModel))
    .map((entry) => {
      const { config, kind, model, upstreamModel } = entry;
      const logicalModel = String(config.logical_model_id || '').trim();
      const key = `${kind}:${model.toLowerCase()}`;
      const price = prices.get(model.toLowerCase());
      if (!Number.isSafeInteger(price?.credits) || price.credits <= 0) return null;
      const verifiedCapabilities = verifiedModelCapabilities(config, upstreamModel, price, options.evidenceRoots);
      if (verifiedCapabilities === false) return null;
      const resolutionPrices = verifiedCapabilities
        ? Object.fromEntries(verifiedCapabilities.resolutions
          .map((resolution) => [resolution, price.resolution_prices[resolution]])
          .filter(([, tier]) => tier))
        : price?.resolution_prices || {};
      const item = {
        kind,
        model,
        label: price?.display_name || model,
        public_note: price?.public_note || null,
        default_voice_id: config.service_type === 'tts' ? String(config.voice_id || '').trim() : '',
        credits: price?.credits || null,
        billing_unit: price?.billing_unit || null,
        resolution_prices: Object.fromEntries(Object.entries(resolutionPrices)
          .map(([resolution, tier]) => [resolution, { credits: tier.credits }])),
        verification_status: config.verification_status || 'pending',
        capabilities: publicCapabilityValue(verifiedCapabilities || (kind === 'video'
          ? {
            ...videoReferenceCapabilityService.resolve(config, upstreamModel),
            ...providerCapabilities(config.provider, upstreamModel),
          }
          : safeCapabilities(config.settings, config, upstreamModel))),
      };
      return {
        key,
        logical: Boolean(logicalModel),
        item,
      };
    })
    .filter(Boolean);
  const selected = new Map();
  for (const candidate of configuredCandidates) {
    const current = selected.get(candidate.key);
    if (!current || (!current.logical && candidate.logical)) selected.set(candidate.key, candidate);
  }
  let configured = [...selected.values()].map((candidate) => candidate.item);
  const seen = new Set(selected.keys());
  if (verifiedIds === null) {
    for (const item of canvasProviderConfigService.listSafe()) {
      const key = `${item.kind}:${item.model.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        configured.push(item);
      }
    }
  }
  if (verifiedIds !== null
      && providerRouteStabilityService.resolveCanaryMode(options.canaryMode, options.log) === 'enforce') {
    configured = enforceFreshEvidenceCatalog(
      db,
      configured,
      configsByKey,
      options.now || new Date().toISOString(),
    );
  }
  return configured;
}

module.exports = { list, parseModels, safeCapabilities, providerCapabilities };
