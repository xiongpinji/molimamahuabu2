'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const config = require('../config');
const { getFfprobePath } = require('../utils/ffmpegPath');
const taskService = require('./taskService');
const videoService = require('./videoService');
const videoClient = require('./videoClient');
const assetService = require('./assetService');
const redrawBillingService = require('./redrawBillingService');
const redrawGenerationPolicyService = require('./redrawGenerationPolicyService');
const redrawCandidateReviewService = require('./redrawCandidateReviewService');
const redrawReviewService = require('./redrawReviewService');
const redrawCapabilityService = require('./redrawCapabilityService');
const redrawSourceConditioningService = require('./redrawSourceConditioningService');
const redrawReferenceBundleService = require('./redrawReferenceBundleService');
const { compileNativeDialoguePrompt } = require('./redrawNativeDialoguePromptService');
const redrawNativeAudioService = require('./redrawNativeAudioService');
const { normalizeVideoProviderResult } = require('./redrawProviderAdapters');
const { FEITUO_MODELS, buildFeituoVideoBody } = require('./feituoVideoClient');
const { TOAPIS_VIDEO_MODELS, validateToapisVideoOptions } = require('./toapisVideoClient');
const { buildFuminVideoBody } = require('./fuminVideoClient');
const { runWithGenerationLimit } = require('./generationConcurrency');

const execFileAsync = promisify(execFile);
const INTERRUPTED_MESSAGE = '供应商状态未知/服务重启，请勿重新提交';
const DEFAULT_GENERATION_CONCURRENCY = 3;
const DEFAULT_RECOVERY_WAIT_MS = 60 * 60 * 1000;
const DEFAULT_RECOVERY_POLL_MS = 1000;
const ICREAT_MINI_MODEL = 'bytedance/seedance-2-0-mini';
const FUMIN_MINI_MODEL = 'fumin-seedance-2.0-mini';
const HEX_64 = /^[0-9a-f]{64}$/;
const CLIENT_GENERATION_CONTROL_FIELDS = [
  'model',
  'locale',
  'prompt',
  'generate_audio',
  'generateAudio',
  'ai_service_config_id',
  'aiServiceConfigId',
  'config_id',
  'configId',
  'provider',
  'credit_amount',
  'creditAmount',
  'credits',
  'price',
  'reservation_id',
  'reservationId',
  'spent_credits',
  'spentCredits',
  'held_credits',
  'heldCredits',
  'quote_credits',
  'quoteCredits',
  'attempt',
  'execution_mode',
  'executionMode',
  'budget_limit_credits',
  'budgetLimitCredits',
  'budget',
  'max_auto_attempts_per_shot',
  'maxAutoAttemptsPerShot',
  'max_attempts',
  'maxAttempts',
  'completed_attempts',
  'completedAttempts',
  'prior_state',
  'priorState',
  'prior_held_reservation',
  'priorHeldReservation',
  'reservation',
  'idempotency_key',
  'idempotencyKey',
  'idempotency',
];
const CLIENT_REFERENCE_BUNDLE_CONTROL_FIELDS = [
  'reference_bundle',
  'referenceBundle',
  'face_tracks',
  'faceTracks',
  'text_regions',
  'textRegions',
  'motion_reference',
  'motionReference',
  'reference_urls',
  'referenceUrls',
  'reference_hash',
  'referenceHash',
  'reference_path',
  'referencePath',
  'reference_url',
  'referenceUrl',
  'reviewer_status',
  'reviewerStatus',
];

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function strictJson(value, label) {
  if (value == null || value === '') return {};
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (_) {}
  throw codedError('REDRAW_INVALID_JSON', `${label} JSON 无效`);
}

function strictJsonArray(value, label) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    if (Array.isArray(parsed)) return parsed;
  } catch (_) {}
  throw codedError('REDRAW_INVALID_JSON', `${label} JSON 无效`);
}

function now(ctx) {
  return ctx.clock ? ctx.clock() : new Date().toISOString();
}

function monotonicTimestamp(base, candidate) {
  const baseMs = Date.parse(base || '');
  const candidateMs = Date.parse(candidate || '');
  if (!Number.isFinite(baseMs) || !Number.isFinite(candidateMs) || candidateMs > baseMs) {
    return candidate;
  }
  return new Date(baseMs + 1).toISOString();
}

function sha256File(absPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(absPath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

function sha256FileSync(absPath) {
  const fd = fs.openSync(absPath, 'r');
  try {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function normalizeDuration(value, options = {}) {
  const duration = Number(value);
  const minimum = options.allowFourSeconds === true ? 4 : 5;
  if (!Number.isSafeInteger(duration) || duration < minimum || duration > 15) {
    throw codedError('INVALID_VIDEO_DURATION', `视频时长必须是 ${minimum} 到 15 秒之间的整数`);
  }
  return duration;
}

function durationFromShotMs(shot, options = {}) {
  const derived = Math.ceil(Number(shot?.duration_ms || 0) / 1000);
  if (!Number.isSafeInteger(derived) || derived <= 0) return 5;
  return Math.max(options.allowFourSeconds === true ? 4 : 5, Math.min(15, derived));
}

function normalizeResolution(value) {
  if (value == null || value === '') return null;
  return String(value).trim().toLowerCase();
}

function normalizeAspectRatio(value) {
  if (value == null || value === '') return null;
  return String(value).trim();
}

function evidenceForLocaleCapability(entry) {
  if (entry?.evidence && typeof entry.evidence === 'object') return entry.evidence.video;
  return entry?.video_evidence_json || entry?.video_evidence;
}

function listVerifiedGenerationCapabilities(db, version, canReadArtifact = () => false) {
  const locale = String(version?.locale || version?.version_locale || '').trim();
  const market = String(version?.market || '').trim();
  if (!locale) return [];
  const rows = db.prepare(`
    SELECT id, provider, api_protocol, model, default_model, settings, updated_at
    FROM ai_service_configs
    WHERE COALESCE(is_active, 1) = 1
      AND deleted_at IS NULL
    ORDER BY id ASC
  `).all();
  const capabilities = [];
  for (const row of rows) {
    let settings;
    try {
      settings = strictJson(row.settings, 'ai_service_configs.settings');
    } catch (_) {
      continue;
    }
    const entries = settings.redraw_locale_capabilities || settings.redrawLocaleCapabilities || [];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      if (entry.status !== 'verified') continue;
      if (String(entry.locale || '').trim() !== locale) continue;
      if (String(entry.market || '').trim() !== market) continue;
      const evidence = evidenceForLocaleCapability(entry);
      if (!redrawCapabilityService.validateGenerationEvidence(evidence, canReadArtifact)) continue;
      let parsed;
      try {
        parsed = strictJson(evidence, 'redraw_locale_capabilities.video_evidence');
      } catch (_) {
        continue;
      }
      const model = String(parsed.model || '').trim();
      const evidenceProvider = String(parsed.provider || '').trim().toLowerCase();
      const rowProvider = String(row.provider || '').trim().toLowerCase();
      if (Number(parsed.config_id) !== Number(row.id)
        || String(parsed.config_updated_at || '') !== String(row.updated_at || '')
        || !evidenceProvider || evidenceProvider !== rowProvider) {
        continue;
      }
      const exactConfig = model ? videoClient.getDefaultVideoConfig(db, model, row.id) : null;
      if (exactConfig && String(exactConfig.provider || '').trim().toLowerCase() === evidenceProvider) {
        capabilities.push({
          config_id: row.id,
          config_updated_at: row.updated_at,
          provider: String(exactConfig.provider || '').trim(),
          protocol: videoClient.resolveVideoProtocol(exactConfig, model),
          model,
        });
      }
    }
  }
  return capabilities;
}

function isIcreatMiniCapability(capability) {
  return String(capability?.protocol || '').trim().toLowerCase() === 'icreat_task'
    && String(capability?.model || '').trim().toLowerCase() === ICREAT_MINI_MODEL;
}

function isFuminMiniCapability(capability) {
  const provider = String(capability?.provider || '').trim().toLowerCase();
  return ['fumin', 'fumin_video'].includes(provider)
    && String(capability?.protocol || '').trim().toLowerCase() === 'fumin_video'
    && String(capability?.model || '').trim().toLowerCase() === FUMIN_MINI_MODEL;
}

function supportsVideoConditioning(capability, options = {}) {
  const model = String(capability?.model || '').trim();
  return isIcreatMiniCapability(capability)
    || (options.allowFuminMini === true && isFuminMiniCapability(capability))
    || (String(capability?.protocol || '').trim().toLowerCase() === 'feituo_open'
      && Number(FEITUO_MODELS[model]?.maxVideos || 0) > 0);
}

function resolveVerifiedGenerationCapability(db, version, canReadArtifact = () => false, options = {}) {
  const capabilities = listVerifiedGenerationCapabilities(db, version, canReadArtifact);
  if (options.requireSourceConditioning === true) {
    return capabilities.find((capability) => supportsVideoConditioning(capability, options)) || capabilities[0] || null;
  }
  return capabilities[0] || null;
}

function resolveVerifiedGenerationModel(db, version, canReadArtifact = () => false) {
  return resolveVerifiedGenerationCapability(db, version, canReadArtifact)?.model || null;
}

function assertVideoConditioningCapability(capability, options = {}) {
  const model = String(capability?.model || '').trim();
  const protocol = String(capability?.protocol || '').trim().toLowerCase();
  const spec = FEITUO_MODELS[model];
  const icreatMini = isIcreatMiniCapability(capability);
  const fuminMini = options.allowFuminMini === true && isFuminMiniCapability(capability);
  const declaredMaxVideos = Number(capability?.max_videos ?? capability?.maxVideos ?? spec?.maxVideos ?? 0);
  const maxVideos = icreatMini
    ? 3
    : fuminMini
      ? 3
      : options.allowDeclaredLimit
        ? declaredMaxVideos
        : Number(spec?.maxVideos || 0);
  if (!icreatMini && !fuminMini && (protocol !== 'feituo_open' || maxVideos <= 0 || (!options.allowDeclaredLimit && !spec))) {
    throw codedError('REDRAW_VIDEO_CONDITIONING_UNSUPPORTED', '当前已验证视频模型不支持源片视频 conditioning', {
      config_id: capability?.config_id ?? null,
      model: model || null,
      protocol: protocol || null,
    });
  }
  return { ...capability, model, protocol, max_videos: maxVideos };
}

function selectShot(db, ctx, shotInput) {
  const shotKey = shotInput.shot_id ?? shotInput.shotId;
  if (shotKey == null || String(shotKey).trim() === '') {
    throw codedError('REDRAW_SHOT_NOT_FOUND', '转绘镜头不存在');
  }
  const rows = db.prepare(`
    SELECT s.*, v.work_id, v.style_snapshot_json, v.reference_bundle_required,
           v.locale AS version_locale,
           v.market AS version_market,
           v.status AS version_status, v.deleted_at AS version_deleted_at,
           w.source_asset_id, w.source_fingerprint, w.duration_ms AS source_duration_ms
    FROM redraw_shots s
    JOIN redraw_versions v ON v.id = s.version_id
    JOIN redraw_works w ON w.id = v.work_id
    WHERE s.deleted_at IS NULL
      AND v.deleted_at IS NULL
      AND w.deleted_at IS NULL
      AND s.tenant_id = ?
      AND s.user_id = ?
      AND w.tenant_id = s.tenant_id
      AND w.user_id = s.user_id
      AND (CAST(s.id AS TEXT) = ? OR s.shot_id = ?)
    ORDER BY s.id ASC
    LIMIT 1
  `).all(String(ctx.tenantId), String(ctx.userId), String(shotKey), String(shotKey));
  const shot = rows[0] || null;
  if (!shot) throw codedError('REDRAW_SHOT_NOT_FOUND', '转绘镜头不存在或无权访问');
  return shot;
}

function normalizeVersionId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw codedError('REDRAW_VERSION_NOT_FOUND', '转绘版本不存在');
  }
  return id;
}

function normalizeBatchShotIds(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length === 0) {
    throw codedError('REDRAW_BATCH_SHOT_INVALID', 'shot_ids 必须是非空数组');
  }
  const ids = [];
  const seen = new Set();
  for (const raw of value) {
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw codedError('REDRAW_BATCH_SHOT_INVALID', '批量镜头不存在、跨版本或无权访问');
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function ensureGateOpen(db, ctx, versionId) {
  const gate = redrawReviewService.evaluateGenerationGate(db, versionId, {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
  }, {
    preparationContext: redrawReviewService.trustedPreparationContext(ctx.preparationContext || ctx),
  });
  if (!gate.ok) {
    throw codedError('REDRAW_ASSET_REVIEW_REQUIRED', '转绘资产审核未通过，不能生成单镜视频', {
      missing: gate.missing || [],
    });
  }
  return gate;
}

function buildGenerationInput(shot, input, parsed, verifiedModel) {
  const compiled = parsed.compiled;
  const draft = parsed.draft;
  const promptBase = String(compiled.text || compiled.prompt || shot.prompt || '').trim();
  const negative = String(
    input.negative_prompt ?? input.negativePrompt ?? compiled.negative_prompt ?? compiled.negativePrompt ?? shot.negative_prompt ?? '',
  ).trim();
  const prompt = negative ? `${promptBase}\n\nNegative prompt: ${negative}` : promptBase;
  const model = String(verifiedModel || '').trim();
  if (!model) {
    throw codedError('REDRAW_NO_VERIFIED_VIDEO_MODEL', '当前语言市场没有已验证可读的视频生成能力');
  }
  const duration = normalizeDuration(input.duration ?? draft.duration ?? compiled.duration ?? durationFromShotMs(shot));
  const resolution = normalizeResolution(input.resolution ?? draft.resolution ?? compiled.resolution ?? '720p');
  const aspectRatio = normalizeAspectRatio(input.aspect_ratio ?? input.aspectRatio ?? draft.aspect_ratio ?? draft.aspectRatio
    ?? compiled.aspect_ratio ?? compiled.aspectRatio ?? '16:9');
  return {
    prompt,
    model,
    duration,
    resolution,
    aspect_ratio: aspectRatio,
    count: 1,
    locale: input.locale || draft.locale || shot.version_locale || null,
    attempt: 1,
  };
}

function rejectClientGenerationControl(input) {
  for (const field of CLIENT_GENERATION_CONTROL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input || {}, field)) {
      throw codedError('REDRAW_GENERATION_INPUT_INVALID', '转绘分镜生成的模型、语言、提示词、音频和积分只能由服务端决定');
    }
  }
  for (const field of CLIENT_REFERENCE_BUNDLE_CONTROL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input || {}, field)) {
      throw codedError('REDRAW_GENERATION_INPUT_INVALID', '转绘参考包只能由服务端审核结果决定');
    }
  }
}

function languageFromLocale(locale) {
  const language = String(locale || '').trim().split('-')[0].toLowerCase();
  return /^[a-z]{2,8}$/.test(language) ? language : '';
}

function nativeCapabilityForVersion(db, version, canReadArtifact) {
  const language = languageFromLocale(version?.locale || version?.version_locale);
  if (!language) return null;
  return redrawCapabilityService.resolveVerifiedLocaleCapability(db, {
    capability: 'native_dialogue_audio',
    locale: language,
    market: '',
    canReadArtifact,
  });
}

function assertReadyNativePack(ctx, language) {
  const registry = ctx.localeVerifier;
  if (!registry || typeof registry.assertReady !== 'function') {
    throw codedError('REDRAW_LOCALE_VERIFIER_NOT_READY', '语言验证 Worker 未就绪');
  }
  return registry.assertReady({ language, scope: 'language' });
}

function assertNativeAudioCapability(capability, options = {}) {
  if (!capability) {
    throw codedError('REDRAW_NO_VERIFIED_NATIVE_AUDIO', '当前语言没有已验证的原生对白声画能力');
  }
  const model = String(capability.model || '').trim().toLowerCase();
  const protocol = String(capability.protocol || '').trim().toLowerCase();
  const spec = protocol === 'toapis_video' ? TOAPIS_VIDEO_MODELS[model] : null;
  if (capability.supportsAudio === false
    || (!isIcreatMiniCapability({ protocol, model })
      && !(options.allowFuminMini === true && isFuminMiniCapability(capability))
      && spec?.supportsAudio !== true)) {
    throw codedError('REDRAW_NATIVE_AUDIO_UNSUPPORTED', '当前已验证视频模型不支持同步音频');
  }
  return {
    config_id: Number(capability.carrier_config_id ?? capability.config_id),
    config_updated_at: String((capability.carrier_updated_at ?? capability.config_updated_at) || ''),
    provider: String((capability.carrier_provider ?? capability.provider) || '').trim(),
    protocol,
    model,
  };
}

function buildNativeDialogues(shot) {
  const rows = strictJsonArray(shot.localized_dialogue_json, 'localized_dialogue_json');
  return rows.map((item) => ({
    speaker_id: String((item.speaker_id ?? item.speakerId ?? item.speaker) || '').trim(),
    start_ms: Number(item.start_ms ?? item.startMs),
    end_ms: Number(item.end_ms ?? item.endMs),
    text: String((item.text ?? item.localized_text ?? item.line) || '').trim(),
  }));
}

function hasNativeDialogueRows(shot) {
  return strictJsonArray(shot.localized_dialogue_json, 'localized_dialogue_json').length > 0;
}

function buildNativeGeneration(shot, parsed, nativeCapability, pack) {
  const selected = assertNativeAudioCapability(nativeCapability);
  const compiled = parsed.compiled;
  const allowFourSeconds = isIcreatMiniCapability(selected);
  const duration = normalizeDuration(
    compiled.duration ?? parsed.draft.duration ?? durationFromShotMs(shot, { allowFourSeconds }),
    { allowFourSeconds },
  );
  const resolution = normalizeResolution(compiled.resolution ?? parsed.draft.resolution ?? '720p');
  const aspectRatio = normalizeAspectRatio(compiled.aspect_ratio ?? compiled.aspectRatio
    ?? parsed.draft.aspect_ratio ?? parsed.draft.aspectRatio ?? '16:9');
  const promptBundle = compileNativeDialoguePrompt({
    shot: { id: shot.id, start_ms: Number(shot.start_ms), end_ms: Number(shot.end_ms) },
    basePrompt: String(compiled.text || compiled.prompt || shot.prompt || '').trim(),
    language: pack.language,
    promptLanguageLabel: pack.prompt_language_label,
    localePack: pack,
    modelPin: {
      config_id: selected.config_id,
      config_updated_at: selected.config_updated_at,
      model: selected.model,
    },
    dialogues: buildNativeDialogues(shot),
  });
  return {
    ...promptBundle,
    prompt: promptBundle.prompt,
    model: selected.model,
    duration,
    resolution,
    aspect_ratio: aspectRatio,
    count: 1,
    locale: pack.language,
    attempt: 1,
    provider: selected.provider,
    protocol: selected.protocol,
    aiServiceConfigId: selected.config_id,
    aiServiceConfigUpdatedAt: selected.config_updated_at,
    localePack: pack.id,
    generateAudio: true,
    nativeDialogue: true,
  };
}

function canonicalIdentityBindings(value) {
  const bindings = Array.isArray(value) ? value : [];
  return bindings.map((binding) => ({
    ...(binding?.track_key ? { track_key: String(binding.track_key || '').trim() } : {}),
    ...(binding?.reference_image_asset_id ? { reference_image_asset_id: Number(binding.reference_image_asset_id) } : {}),
    ...(binding?.redraw_asset_id ? { redraw_asset_id: Number(binding.redraw_asset_id) } : {}),
    source_character_key: String(binding?.source_character_key || '').trim(),
    ...(binding?.target_character_name ? { target_character_name: String(binding.target_character_name || '').trim() } : {}),
    target_actor_label: String(binding?.target_actor_label || '').trim(),
    identity_pack_sha256: String(binding?.identity_pack_sha256 || '').trim(),
  })).sort((left, right) => (
    Number(left.redraw_asset_id || 0) - Number(right.redraw_asset_id || 0)
    || String(left.track_key || '').localeCompare(String(right.track_key || ''))
    || Number(left.reference_image_asset_id || 0) - Number(right.reference_image_asset_id || 0)
    || left.source_character_key.localeCompare(right.source_character_key)
    || String(left.target_character_name || '').localeCompare(String(right.target_character_name || ''))
    || left.target_actor_label.localeCompare(right.target_actor_label)
    || left.identity_pack_sha256.localeCompare(right.identity_pack_sha256)
  ));
}

function buildRequestSnapshot(generation, sourceConditioning, referenceImageUrls, identityBindings, referenceBundleSnapshot = null) {
  return {
    prompt: generation.prompt,
    model: generation.model,
    duration: generation.duration,
    aspect_ratio: generation.aspect_ratio,
    resolution: generation.resolution,
    reference_image_urls: referenceImageUrls,
    reference_video_urls: [sourceConditioning.referenceVideoUrl],
    identity_bindings: canonicalIdentityBindings(identityBindings),
    generate_audio: generation.generateAudio === true,
    ...(generation.targetLocale ? { target_locale: generation.targetLocale } : {}),
    ai_service_config_id: generation.aiServiceConfigId,
    config_updated_at: generation.aiServiceConfigUpdatedAt,
    locale: generation.locale,
    ...(generation.localePack ? { locale_pack: generation.localePack } : {}),
    ...(generation.prompt_hash ? { prompt_hash: generation.prompt_hash } : {}),
    ...(generation.dialogue_snapshot_hash ? { dialogue_snapshot_hash: generation.dialogue_snapshot_hash } : {}),
    ...(referenceBundleSnapshot ? { reference_bundle: referenceBundleSnapshot } : {}),
  };
}

function sameRequestSnapshot(storedSnapshot, expectedSnapshot) {
  if (!expectedSnapshot) return true;
  const stored = storedSnapshot && typeof storedSnapshot === 'object' ? storedSnapshot : {};
  for (const key of [
    'generate_audio',
    'target_locale',
    'prompt_hash',
    'dialogue_snapshot_hash',
    'ai_service_config_id',
    'config_updated_at',
    'locale_pack',
  ]) {
    if (Object.prototype.hasOwnProperty.call(expectedSnapshot, key)
      && stored[key] !== expectedSnapshot[key]) {
      return false;
    }
  }
  if (Object.prototype.hasOwnProperty.call(expectedSnapshot, 'identity_bindings')) {
    const storedIdentityBindings = Object.prototype.hasOwnProperty.call(stored, 'identity_bindings')
      ? stored.identity_bindings
      : [];
    if (!Array.isArray(storedIdentityBindings)
      || JSON.stringify(canonicalIdentityBindings(storedIdentityBindings))
        !== JSON.stringify(canonicalIdentityBindings(expectedSnapshot.identity_bindings))) {
      return false;
    }
  }
  if (Object.prototype.hasOwnProperty.call(expectedSnapshot, 'reference_bundle')) {
    const expectedBundle = expectedSnapshot.reference_bundle || {};
    const storedBundle = stored.reference_bundle || {};
    const keys = [
      'schema_version',
      'reference_bundle_hash',
      'coverage_sha256',
      'source_sha256',
      'motion_sha256',
      'dialogue_kind',
      'speech_required',
      'source_dialogue_sha256',
      'dialogue_script_sha256',
      'character_name_map_sha256',
      'localization_binding_sha256',
    ];
    if (JSON.stringify(Object.keys(storedBundle).sort()) !== JSON.stringify([...keys].sort())
      || JSON.stringify(Object.keys(expectedBundle).sort()) !== JSON.stringify([...keys].sort())) {
      return false;
    }
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(storedBundle, key)
        || !Object.prototype.hasOwnProperty.call(expectedBundle, key)
        || storedBundle[key] !== expectedBundle[key]) return false;
    }
  }
  return true;
}

function staleReferenceBundle() {
  throw codedError('REDRAW_REFERENCE_BUNDLE_STALE', '当前参考包已变化，请刷新后重试');
}

function referenceBundleCreateState(db, ctx, shot, requestSnapshot, expectedState = null) {
  const row = db.prepare(`
    SELECT id, tenant_id, user_id, version_id, status, video_generation_id, updated_at,
           preparation_state, preparation_version, preparation_snapshot_json,
           preparation_evidence_hash, reference_bundle_json, reference_bundle_hash,
           reference_bundle_updated_at
    FROM redraw_shots
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND version_id = ? AND deleted_at IS NULL
  `).get(Number(shot.id), String(ctx.tenantId), String(ctx.userId), Number(shot.version_id));
  if (!row) staleReferenceBundle();

  let bundle;
  let preparationSnapshot;
  try {
    bundle = strictJson(row.reference_bundle_json, 'reference_bundle_json');
    preparationSnapshot = strictJson(row.preparation_snapshot_json, 'preparation_snapshot_json');
  } catch (_) {
    staleReferenceBundle();
  }
  const currentBundleHash = redrawReferenceBundleService.canonicalBundleHash(bundle);
  const referenceBundleSnapshot = {
    schema_version: bundle.schema_version,
    reference_bundle_hash: row.reference_bundle_hash,
    coverage_sha256: bundle.coverage_sha256,
    source_sha256: bundle.source?.sha256,
    motion_sha256: bundle.motion_reference?.sha256,
    dialogue_kind: bundle.dialogue?.kind,
    speech_required: bundle.dialogue?.speech_required,
    source_dialogue_sha256: bundle.dialogue?.source_dialogue_sha256,
    dialogue_script_sha256: bundle.dialogue?.script_sha256,
    character_name_map_sha256: bundle.dialogue?.character_name_map_sha256,
    localization_binding_sha256: bundle.dialogue?.localization_binding_sha256,
  };
  const identityBindings = Array.isArray(bundle.face_tracks) ? bundle.face_tracks.map((face) => ({
    track_key: face.track_key,
    source_character_key: face.source_character_key,
    target_character_name: face.identity?.target_character_name,
    target_actor_label: face.identity?.target_actor_label,
    reference_image_asset_id: face.identity?.artifact?.asset_id,
    redraw_asset_id: face.identity_redraw_asset_id,
    identity_pack_sha256: face.identity_pack_sha256,
  })) : [];
  const currentRequestSnapshot = {
    identity_bindings: identityBindings,
    reference_bundle: referenceBundleSnapshot,
  };
  const expectedRequestSnapshot = {
    identity_bindings: requestSnapshot?.identity_bindings,
    reference_bundle: requestSnapshot?.reference_bundle,
  };
  if (currentBundleHash !== String(row.reference_bundle_hash || '')
    || !sameRequestSnapshot(currentRequestSnapshot, expectedRequestSnapshot)
    || String(row.updated_at || '') !== String(shot.updated_at || '')
    || String(row.reference_bundle_updated_at || '') !== String(shot.reference_bundle_updated_at || '')
    || Number(row.preparation_version) !== Number(shot.preparation_version)
    || String(row.preparation_state || '') !== 'reference_ready'
    || String(row.status || '') !== String(shot.status || '')
    || Number(row.video_generation_id || 0) !== Number(shot.video_generation_id || 0)
    || preparationSnapshot.schema_version !== 'redraw-reference-preparation-v2'
    || preparationSnapshot.status !== 'completed'
    || Number(preparationSnapshot.version_id) !== Number(row.version_id)
    || Number(preparationSnapshot.shot_id) !== Number(row.id)
    || Number(preparationSnapshot.preparation_version) !== Number(row.preparation_version)
    || preparationSnapshot.reference_bundle_hash !== row.reference_bundle_hash
    || !HEX_64.test(String(preparationSnapshot.shot_character_plan_hash || ''))
    || !HEX_64.test(String(row.preparation_evidence_hash || ''))) {
    staleReferenceBundle();
  }
  const state = {
    status: String(row.status || ''),
    video_generation_id: row.video_generation_id == null ? null : Number(row.video_generation_id),
    updated_at: String(row.updated_at || ''),
    preparation_state: String(row.preparation_state || ''),
    preparation_version: Number(row.preparation_version),
    preparation_snapshot_json: String(row.preparation_snapshot_json || ''),
    preparation_evidence_hash: String(row.preparation_evidence_hash || ''),
    reference_bundle_hash: String(row.reference_bundle_hash || ''),
    reference_bundle_updated_at: String(row.reference_bundle_updated_at || ''),
  };
  if (expectedState && JSON.stringify(state) !== JSON.stringify(expectedState)) staleReferenceBundle();
  return state;
}

function normalizeReferencePointer(value, fallbackKind = null) {
  const kind = String(value.kind || value.type || value.asset_kind || fallbackKind || '').trim();
  let rawId = value.redraw_asset_id ?? value.redrawAssetId ?? value.asset_id ?? value.assetId;
  let inferredKind = kind;
  for (const candidate of ['character', 'scene', 'prop', 'voice']) {
    const candidateId = value[`${candidate}_asset_id`] ?? value[`${candidate}AssetId`];
    if (rawId == null && candidateId != null) {
      rawId = candidateId;
      inferredKind = candidate;
    }
  }
  if (rawId == null && value.clean_plate_asset_id != null) {
    rawId = value.clean_plate_asset_id;
    inferredKind = 'scene';
  }
  const id = Number(rawId);
  if (!['character', 'scene', 'prop', 'voice'].includes(inferredKind)
    || !Number.isInteger(id) || id <= 0) return null;
  return { kind: inferredKind, id };
}

function parseReferenceValue(value, fallbackKind = null, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) parseReferenceValue(item, fallbackKind, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  const normalized = normalizeReferencePointer(value, fallbackKind);
  if (normalized) out.push(normalized);
  for (const key of ['references', 'assets', 'asset_references', 'assetReferences']) {
    if (value[key] != null) parseReferenceValue(value[key], fallbackKind, out);
  }
  return out;
}

function assetUrl(row) {
  if (!row) return null;
  const url = String(row.url || '').trim();
  if (/^https?:\/\//i.test(url)) return url;
  const localPath = String(row.local_path || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!localPath || localPath.includes('..')) return null;
  return `/static/${localPath}`;
}

function collectReferenceImageUrls(db, shot, parsed) {
  const refs = [];
  parseReferenceValue(parsed.references, null, refs);
  parseReferenceValue(parsed.draft.references || parsed.draft.assets || parsed.draft.asset_references, null, refs);
  const urls = [];
  const seen = new Set();
  for (const ref of refs) {
    if (ref.kind === 'voice') continue;
    const row = db.prepare(`
      SELECT * FROM redraw_assets
      WHERE id = ? AND version_id = ? AND tenant_id = ? AND user_id = ?
        AND kind = ? AND deleted_at IS NULL AND approval_status = 'approved'
      LIMIT 1
    `).get(ref.id, shot.version_id, shot.tenant_id, shot.user_id, ref.kind);
    if (!row) continue;
    const sourceId = ref.kind === 'scene' ? (row.clean_plate_asset_id || row.asset_id) : row.asset_id;
    if (!sourceId) continue;
    const asset = db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(Number(sourceId));
    const url = assetUrl(asset);
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

function collectIdentityBindings(parsed) {
  const bindings = [];
  const seen = new Set();
  function collect(value) {
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const normalized = normalizeReferencePointer(value);
    if (normalized?.kind === 'character') {
      const key = `${normalized.kind}:${normalized.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        bindings.push({
          redraw_asset_id: normalized.id,
          source_character_key: String(value.source_character_key || '').trim(),
          target_actor_label: String(value.target_actor_label || '').trim(),
          identity_pack_sha256: String(value.identity_pack_sha256 || '').trim(),
        });
      }
    }
    for (const key of ['references', 'assets', 'asset_references', 'assetReferences']) {
      if (value[key] != null) collect(value[key]);
    }
  }
  collect(parsed.references);
  collect(parsed.draft.references || parsed.draft.assets || parsed.draft.asset_references);
  return canonicalIdentityBindings(bindings);
}

function preflightVideoGeneration(generation, sourceConditioning, referenceImageUrls) {
  if (generation.protocol === 'toapis_video') {
    try {
      validateToapisVideoOptions({
        model: generation.model,
        prompt: generation.prompt,
        duration: generation.duration,
        aspect_ratio: generation.aspect_ratio,
        resolution: generation.resolution,
        reference_urls: referenceImageUrls,
        reference_video_urls: [sourceConditioning.referenceVideoUrl],
        generate_audio: generation.generateAudio === true,
      });
    } catch (error) {
      throw codedError('REDRAW_GENERATION_INPUT_INVALID', error.message);
    }
    return;
  }
  if (generation.protocol === 'icreat_task') {
    try {
      videoClient.buildIcreatVideoBody({
        model: generation.model,
        prompt: generation.prompt,
        duration: generation.duration,
        aspect_ratio: generation.aspect_ratio,
        resolution: generation.resolution,
        reference_urls: referenceImageUrls,
        reference_video_urls: [sourceConditioning.referenceVideoUrl],
        generate_audio: generation.generateAudio === true,
      });
    } catch (error) {
      throw codedError('REDRAW_GENERATION_INPUT_INVALID', error.message);
    }
    return;
  }
  if (generation.protocol === 'fumin_video') {
    try {
      buildFuminVideoBody({
        model: generation.model,
        prompt: generation.prompt,
        duration: generation.duration,
        aspect_ratio: generation.aspect_ratio,
        resolution: generation.resolution,
        reference_urls: referenceImageUrls,
        reference_video_urls: [sourceConditioning.referenceVideoUrl],
        generate_audio: generation.generateAudio === true,
      });
    } catch (error) {
      throw codedError('REDRAW_GENERATION_INPUT_INVALID', error.message);
    }
    return;
  }
  if (!FEITUO_MODELS[generation.model]) return;
  try {
    buildFeituoVideoBody({
      model: generation.model,
      prompt: generation.prompt,
      duration: generation.duration,
      aspect_ratio: generation.aspect_ratio,
      reference_urls: referenceImageUrls,
      reference_video_urls: [sourceConditioning.referenceVideoUrl],
    });
  } catch (error) {
    throw codedError('REDRAW_GENERATION_INPUT_INVALID', error.message);
  }
}

function parseShotPayload(shot) {
  return {
    references: strictJsonArray(shot.references_json, 'references_json'),
    compiled: strictJson(shot.compiled_prompt_json, 'compiled_prompt_json'),
    draft: strictJson(shot.draft_json, 'draft_json'),
    styleSnapshot: strictJson(shot.style_snapshot_json, 'style_snapshot_json'),
  };
}

function findReusable(db, shot, attempt, expectedGeneration = null) {
  if (!shot.video_generation_id) return null;
  const video = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(shot.video_generation_id));
  if (!video || !['processing', 'completed', 'needs_attention'].includes(String(video.status))) return null;
  if (expectedGeneration && (
    String(video.model || '') !== String(expectedGeneration.model || '')
    || Number(video.duration) !== Number(expectedGeneration.duration)
    || String(video.resolution || '') !== String(expectedGeneration.resolution || '')
    || String(video.aspect_ratio || '') !== String(expectedGeneration.aspect_ratio || '')
    || String(video.prompt || '') !== String(expectedGeneration.prompt || '')
  )) return null;
  if (expectedGeneration?.sourceConditioning) {
    let storedConditioning;
    try {
      storedConditioning = strictJson(video.source_conditioning_json, 'source_conditioning_json');
    } catch (_) {
      return null;
    }
    if (!sameConditioning(storedConditioning, expectedGeneration.sourceConditioning)) return null;
  }
  if (expectedGeneration?.requestSnapshot) {
    let storedSnapshot;
    try {
      storedSnapshot = strictJson(video.request_snapshot, 'request_snapshot');
    } catch (_) {
      return null;
    }
    if (!sameRequestSnapshot(storedSnapshot, expectedGeneration.requestSnapshot)) return null;
  }
  const draft = strictJson(shot.draft_json, 'draft_json');
  if (Number(draft.generation?.attempt ?? draft.attempt ?? 1) !== Number(attempt)) return null;
  const task = video.task_id
    ? db.prepare('SELECT * FROM async_tasks WHERE id = ? AND deleted_at IS NULL').get(video.task_id)
    : null;
  return {
    status: video.status,
    reused: true,
    task_id: task?.id || video.task_id || null,
    video_generation_id: video.id,
    reservation_id: draft.generation?.reservation_id || null,
  };
}

function generationBillingInput(ctx, shot, generation, styleSnapshot, sourceConditioning, attempt) {
  return {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    actorUserId: ctx.userId,
    versionId: shot.version_id,
    shotId: String(shot.id),
    model: generation.model,
    duration: generation.duration,
    resolution: generation.resolution,
    count: 1,
    locale: generation.locale,
    styleSnapshot,
    sourceConditioning: sourceConditioning.billingSnapshot,
    attempt,
  };
}

function throwGenerationPolicyDecision(decision) {
  if (decision.action === 'needs_review') {
    throw codedError('REDRAW_GENERATION_NEEDS_REVIEW', '项目生成策略要求转为安全审核模式', decision);
  }
  if (decision.action === 'blocked') {
    throw codedError('REDRAW_GENERATION_POLICY_BLOCKED', '项目生成策略阻止本次提交', decision);
  }
}

function evaluateShotGenerationPolicy(db, ctx, shot, generation, styleSnapshot, sourceConditioning) {
  const snapshot = redrawGenerationPolicyService.projectBudgetSnapshot(db, {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    versionId: shot.version_id,
    shotId: shot.id,
  });
  const currentAttempt = Math.max(snapshot.completed_attempts, 1);
  const reusable = findReusable(db, shot, currentAttempt, generation);
  const proposedAttempt = snapshot.completed_attempts + 1;
  const quote = redrawBillingService.quoteShotGeneration(db, generationBillingInput(
    ctx,
    shot,
    generation,
    styleSnapshot,
    sourceConditioning,
    proposedAttempt,
  ));
  if (!quote.success) {
    throw codedError('REDRAW_SHOT_PRICING_UNCONFIGURED', quote.message || '单镜视频模型未配置价格');
  }
  const decision = redrawGenerationPolicyService.evaluateGenerationPolicy({
    ...snapshot,
    quote_credits: quote.amount,
    exact_reusable: Boolean(reusable),
  });
  throwGenerationPolicyDecision(decision);
  return { decision, reusable, snapshot, quote };
}

function mergeDraft(draft, patch) {
  return JSON.stringify({
    ...draft,
    generation: {
      ...(draft.generation || {}),
      ...patch.generation,
    },
    ...(patch.new_video_ref ? { new_video_ref: patch.new_video_ref } : {}),
    ...(patch.native_audio_validation ? { native_audio_validation: patch.native_audio_validation } : {}),
  });
}

const CLIENT_VIDEO_CONDITIONING_FIELDS = [
  'reference_video_urls',
  'referenceVideoUrls',
  'source_video_url',
  'sourceVideoUrl',
  'source_video_ref',
  'sourceVideoRef',
];

function rejectClientVideoConditioning(input) {
  for (const field of CLIENT_VIDEO_CONDITIONING_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input || {}, field) && input[field] != null) {
      throw codedError('REDRAW_CLIENT_VIDEO_CONDITIONING_FORBIDDEN', '源片视频 conditioning 只能由服务端根据 work 和 shot 边界生成');
    }
  }
}

function conditioningIdentity(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    source_asset_id: Number(value.source_asset_id),
    source_fingerprint: String(value.source_fingerprint || ''),
    start_ms: Number(value.start_ms),
    end_ms: Number(value.end_ms),
    segment_sha256: String(value.segment_sha256 || ''),
    audio_mode: String(value.audio_mode || 'preserve'),
  };
}

function sameConditioning(left, right) {
  return JSON.stringify(conditioningIdentity(left)) === JSON.stringify(conditioningIdentity(right));
}

async function prepareServerSourceConditioning(ctx, shot, generation) {
  const prepare = typeof ctx.prepareSourceConditioning === 'function'
    ? ctx.prepareSourceConditioning
    : redrawSourceConditioningService.prepareSourceConditioning;
  const result = await prepare({
    ...(ctx.sourceConditioningOptions || {}),
    db: ctx.db,
    shot,
    sourceAssetId: shot.source_asset_id,
    sourceFingerprint: shot.source_fingerprint,
    startMs: shot.start_ms,
    endMs: shot.end_ms,
    audioMode: generation?.generateAudio === true && isIcreatMiniCapability(generation)
      ? 'strip'
      : 'preserve',
    storageRoot: ctx.storageRoot,
    storageBaseUrl: ctx.storageBaseUrl,
    signingSecret: ctx.providerAssetSecret,
    nowMs: ctx.clock ? Date.parse(ctx.clock()) : undefined,
  });
  if (!result || typeof result.referenceVideoUrl !== 'string'
    || !result.billingSnapshot || !result.auditSnapshot) {
    throw codedError('REDRAW_SOURCE_CONDITIONING_INVALID', '源片 conditioning 服务未返回完整的签名 URL 和校验快照');
  }
  return result;
}

async function prepareReferenceBundleGeneration(ctx, shot) {
  const projection = await redrawReferenceBundleService.projectReferenceBundleForGeneration({
    ...ctx,
    versionId: Number(shot.version_id),
  }, Number(shot.id));
  const snapshot = projection.referenceBundleSnapshot || {};
  const sourceConditioning = {
    referenceVideoUrl: projection.referenceVideoUrl,
    billingSnapshot: {
      mode: 'redraw_reference_bundle',
      source_asset_id: Number(shot.source_asset_id),
      source_fingerprint: String(shot.source_fingerprint || ''),
      start_ms: Number(shot.start_ms),
      end_ms: Number(shot.end_ms),
      segment_sha256: String(snapshot.motion_sha256 || ''),
      audio_mode: 'strip',
      coverage_sha256: String(snapshot.coverage_sha256 || ''),
    },
    auditSnapshot: {
      schema_version: 'redraw-reference-bundle-generation-v1',
      mode: 'redraw_reference_bundle',
      shot_id: Number(shot.id),
      source_asset_id: Number(shot.source_asset_id),
      source_fingerprint: String(shot.source_fingerprint || ''),
      start_ms: Number(shot.start_ms),
      end_ms: Number(shot.end_ms),
      segment_sha256: String(snapshot.motion_sha256 || ''),
      audio_mode: 'strip',
      coverage_sha256: String(snapshot.coverage_sha256 || ''),
      reference_bundle: snapshot,
    },
  };
  return {
    sourceConditioning,
    prompt: String(projection.prompt || ''),
    targetLocale: String(projection.targetLocale || ''),
    generateAudio: projection.generateAudio === true,
    referenceImageUrls: projection.referenceImageUrls || [],
    identityBindings: projection.identityBindings || [],
    referenceBundleSnapshot: snapshot,
  };
}

async function generateShot(ctx, input = {}) {
  const { db } = ctx;
  if (!db || !ctx.tenantId || !ctx.userId) throw codedError('REDRAW_CONTEXT_INVALID', '缺少转绘生成上下文');
  rejectClientGenerationControl(input);
  rejectClientVideoConditioning(input);
  const shot = selectShot(db, ctx, input);
  const parsed = parseShotPayload(shot);
  ensureGateOpen(db, ctx, shot.version_id);
  const versionIdentity = {
    locale: shot.version_locale,
    market: shot.version_market,
  };
  const requiresReferenceBundle = Number(shot.reference_bundle_required || 0) === 1;
  const requiresNativeDialogue = !requiresReferenceBundle && hasNativeDialogueRows(shot);
  const nativeCapability = nativeCapabilityForVersion(db, versionIdentity, ctx.canReadArtifact);
  const language = languageFromLocale(shot.version_locale);
  const nativePack = requiresNativeDialogue ? assertReadyNativePack(ctx, language) : null;
  let generation;
  let selectedCapability;
  if (requiresNativeDialogue) {
    const override = nativeCapability && typeof ctx.resolveVideoConditioningCapability === 'function'
      ? ctx.resolveVideoConditioningCapability(db, nativeCapability?.model, nativeCapability)
      : nativeCapability;
    generation = buildNativeGeneration(shot, parsed, override, nativePack);
    selectedCapability = {
      config_id: generation.aiServiceConfigId,
      config_updated_at: generation.aiServiceConfigUpdatedAt,
      provider: generation.provider,
      protocol: generation.protocol,
      model: generation.model,
    };
  } else {
    const hasCapabilityOverride = typeof ctx.resolveVideoConditioningCapability === 'function';
    const verifiedCapability = resolveVerifiedGenerationCapability(db, versionIdentity, ctx.canReadArtifact, {
      requireSourceConditioning: !hasCapabilityOverride,
      allowFuminMini: requiresReferenceBundle,
    });
    generation = buildGenerationInput(shot, input, parsed, verifiedCapability?.model);
    const conditioningCapability = hasCapabilityOverride
      ? ctx.resolveVideoConditioningCapability(db, generation.model, verifiedCapability)
      : verifiedCapability;
    selectedCapability = assertVideoConditioningCapability(conditioningCapability, {
      allowDeclaredLimit: hasCapabilityOverride,
      allowFuminMini: requiresReferenceBundle,
    });
    generation.provider = selectedCapability.provider || null;
    generation.protocol = selectedCapability.protocol || null;
    generation.aiServiceConfigId = Number(selectedCapability.config_id) || null;
    generation.aiServiceConfigUpdatedAt = String(selectedCapability.config_updated_at || '');
  }
  if (requiresReferenceBundle) {
    assertNativeAudioCapability(selectedCapability, { allowFuminMini: true });
  }
  let referenceBundleProjection = null;
  const sourceConditioning = requiresReferenceBundle
    ? (referenceBundleProjection = await prepareReferenceBundleGeneration(ctx, shot)).sourceConditioning
    : await prepareServerSourceConditioning(ctx, shot, generation);
  generation.sourceConditioning = sourceConditioning.billingSnapshot;
  if (requiresReferenceBundle) {
    generation.prompt = referenceBundleProjection.prompt;
    generation.locale = referenceBundleProjection.targetLocale || 'en-US';
    generation.targetLocale = referenceBundleProjection.targetLocale || 'en-US';
    generation.generateAudio = referenceBundleProjection.generateAudio === true;
  }
  const referenceImageUrls = requiresReferenceBundle
    ? referenceBundleProjection.referenceImageUrls
    : collectReferenceImageUrls(db, shot, parsed);
  const identityBindings = requiresReferenceBundle
    ? referenceBundleProjection.identityBindings
    : collectIdentityBindings(parsed);
  preflightVideoGeneration(generation, sourceConditioning, referenceImageUrls);
  const requestSnapshot = buildRequestSnapshot(
    generation,
    sourceConditioning,
    referenceImageUrls,
    identityBindings,
    referenceBundleProjection?.referenceBundleSnapshot || null,
  );
  generation.requestSnapshot = requestSnapshot;
  const styleSnapshot = ctx.batchStyleSnapshot ?? parsed.styleSnapshot;
  const initialPolicy = evaluateShotGenerationPolicy(
    db,
    ctx,
    shot,
    generation,
    styleSnapshot,
    sourceConditioning,
  );
  if (initialPolicy.decision.action === 'reuse') {
    return enrichGenerationResult(db, {
      ...initialPolicy.reusable,
      attempt: initialPolicy.decision.attempt,
    });
  }
  generation.attempt = initialPolicy.decision.attempt;
  if (shot.video_generation_id) {
    const existing = db.prepare('SELECT status FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(shot.video_generation_id));
    if (existing?.status === 'failed' && ctx.retryFailedShot !== true) {
      throw codedError('REDRAW_SHOT_RETRY_REQUIRED', '该镜头上次生成失败，请使用重试流程');
    }
    if (existing && existing.status !== 'failed') {
      throw codedError('REDRAW_SHOT_CONFLICT', '镜头已有不同参数的生成任务，请刷新后重试');
    }
  }
  if (typeof ctx.beforeCreateTransaction === 'function') {
    await ctx.beforeCreateTransaction({ shot, generation });
  }
  if (requiresReferenceBundle) {
    const currentProjection = await prepareReferenceBundleGeneration(ctx, shot);
    if (JSON.stringify(currentProjection.referenceBundleSnapshot)
      !== JSON.stringify(referenceBundleProjection.referenceBundleSnapshot)) {
      throw codedError('REDRAW_SHOT_CONFLICT', '当前参考包绑定已变更，请刷新后重试');
    }
  }
  const referenceBundleCreateExpected = requiresReferenceBundle
    ? referenceBundleCreateState(db, ctx, shot, requestSnapshot)
    : null;
  if (requiresReferenceBundle && typeof ctx.beforeReferenceBundleCreateTransaction === 'function') {
    const hookResult = ctx.beforeReferenceBundleCreateTransaction({ shot, generation });
    if (hookResult && typeof hookResult.then === 'function') {
      throw codedError('REDRAW_CONTEXT_INVALID', '参考包创建事务钩子必须同步执行');
    }
  }
  let created;
  try {
    const createTransaction = db.transaction(() => {
      if (requiresReferenceBundle) {
        referenceBundleCreateState(db, ctx, shot, requestSnapshot, referenceBundleCreateExpected);
      }
      ensureGateOpen(db, ctx, shot.version_id);
      const freshShot = selectShot(db, ctx, { shotId: shot.id });
      const transactionPolicy = evaluateShotGenerationPolicy(
        db,
        ctx,
        freshShot,
        generation,
        styleSnapshot,
        sourceConditioning,
      );
      if (transactionPolicy.decision.action === 'reuse') {
        return {
          ...transactionPolicy.reusable,
          attempt: transactionPolicy.decision.attempt,
        };
      }
      generation.attempt = transactionPolicy.decision.attempt;
      const reservation = redrawBillingService.reserveShotGeneration(db, generationBillingInput(
        ctx,
        shot,
        generation,
        styleSnapshot,
        sourceConditioning,
        generation.attempt,
      ));
      if (!reservation.success) {
        throw codedError('REDRAW_SHOT_PRICING_UNCONFIGURED', reservation.message || '单镜视频模型未配置价格');
      }
      const task = taskService.createTask(db, ctx.log || logNoop, 'redraw_shot', String(shot.id));
      const timestamp = now(ctx);
      const metadata = {
        redraw_shot: {
          reservation_id: reservation.reservation_id,
          operation_key: reservation.operation_key,
          billing: reservation.billing,
          quote: reservation.quote,
          version_id: shot.version_id,
          shot_id: shot.id,
          attempt: generation.attempt,
        },
      };
      db.prepare(`
        UPDATE async_tasks
        SET status = 'processing', progress = 1, message = ?, tenant_id = ?, user_id = ?,
            model = ?, metadata = ?, updated_at = ?
        WHERE id = ?
      `).run('单镜视频生成已开始', String(ctx.tenantId), String(ctx.userId), generation.model, JSON.stringify(metadata), timestamp, task.id);
      const videoId = db.prepare(`INSERT INTO video_generations
        (provider, ai_service_config_id, prompt, model, duration, aspect_ratio, resolution, reference_image_urls,
         reference_video_urls, source_conditioning_json, generate_audio, request_snapshot, status, task_id, tenant_id, user_id,
         credit_reservation_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, NULL, ?, ?)`)
        .run(
          generation.provider,
          generation.aiServiceConfigId,
          generation.prompt,
          generation.model,
          generation.duration,
          generation.aspect_ratio,
          generation.resolution,
          JSON.stringify(referenceImageUrls),
          JSON.stringify([sourceConditioning.referenceVideoUrl]),
          JSON.stringify({
            ...sourceConditioning.auditSnapshot,
            video_capability: {
              config_id: generation.aiServiceConfigId,
              config_updated_at: generation.aiServiceConfigUpdatedAt,
              provider: generation.provider,
              protocol: generation.protocol,
              model: generation.model,
            },
          }),
          generation.generateAudio === true ? 1 : 0,
          JSON.stringify(requestSnapshot),
          task.id,
          String(ctx.tenantId),
          String(ctx.userId),
          timestamp,
          timestamp,
        ).lastInsertRowid;
      const changed = db.prepare(`
        UPDATE redraw_shots
        SET video_generation_id = ?, status = 'processing', error_code = NULL, error_message = NULL,
            draft_json = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND user_id = ? AND version_id = ?
          AND status = ? AND video_generation_id IS ? AND updated_at IS ? AND deleted_at IS NULL
      `).run(videoId, mergeDraft(parsed.draft, {
        generation: {
          task_id: task.id,
          video_generation_id: videoId,
          reservation_id: reservation.reservation_id,
          operation_key: reservation.operation_key,
          model: generation.model,
          duration: generation.duration,
          resolution: generation.resolution,
          aspect_ratio: generation.aspect_ratio,
          source_conditioning: sourceConditioning.billingSnapshot,
          generate_audio: generation.generateAudio === true,
          locale_pack: generation.localePack,
          prompt_hash: generation.prompt_hash,
          dialogue_snapshot_hash: generation.dialogue_snapshot_hash,
          ai_service_config_id: generation.aiServiceConfigId,
          config_updated_at: generation.aiServiceConfigUpdatedAt,
          count: 1,
          attempt: generation.attempt,
        },
      }), timestamp, shot.id, String(ctx.tenantId), String(ctx.userId), shot.version_id,
      shot.status, shot.video_generation_id, shot.updated_at);
      if (changed.changes !== 1) {
        throw codedError('REDRAW_SHOT_CREATE_CONFLICT', '转绘镜头生成状态已变化');
      }
      setVersionGenerationStep(db, ctx, shot.version_id, timestamp);
      return {
        status: 'processing',
        task_id: task.id,
        video_generation_id: videoId,
        reservation_id: reservation.reservation_id,
      };
    });
    created = createTransaction.immediate();
  } catch (error) {
    if (error.code !== 'REDRAW_SHOT_CREATE_CONFLICT') throw error;
    const fresh = selectShot(db, ctx, input);
    const freshReusable = findReusable(db, fresh, generation.attempt, generation);
    if (freshReusable) {
      return enrichGenerationResult(db, { ...freshReusable, attempt: generation.attempt });
    }
    throw codedError('REDRAW_SHOT_CONFLICT', '转绘镜头生成状态已变化，请刷新后重试');
  }

  if (created.reused) return enrichGenerationResult(db, created);

  const enrich = (result) => enrichGenerationResult(db, {
    ...result,
    reservation_id: created.reservation_id,
    attempt: generation.attempt,
  });
  if (ctx.awaitCompletion === true) return enrich(await runShotGeneration(ctx, created.task_id));
  const schedule = ctx.schedule || ((callback) => setImmediate(callback));
  schedule(() => runShotGeneration(ctx, created.task_id).catch((error) => {
    try {
      updateNeedsAttention(db, created.task_id, shot.id, error.message, now(ctx), created.video_generation_id);
    } catch (stateError) {
      ctx.log?.error?.('redraw shot background state update failed', {
        task_id: created.task_id,
        error: stateError.message,
      });
    }
    ctx.log?.error?.('redraw shot background generation failed', { task_id: created.task_id, error: error.message });
    return { status: 'needs_attention', error: error.message };
  }));
  return enrich({ ...created, attempt: generation.attempt });
}

const logNoop = { info() {}, warn() {}, error() {} };

function taskMetadata(task) {
  return strictJson(task.metadata, 'async_tasks.metadata').redraw_shot || {};
}

function billingForReservationRow(row) {
  if (!row) return { held: 0, charged: 0, released: 0 };
  if (row.status === 'confirmed') return { held: 0, charged: row.amount, released: 0 };
  if (row.status === 'refunded') return { held: 0, charged: 0, released: row.amount };
  return { held: row.amount, charged: 0, released: 0 };
}

function enrichGenerationResult(db, result) {
  const reservationId = result?.reservation_id;
  const reservation = reservationId
    ? db.prepare('SELECT id, status, amount FROM tenant_usage_reservations WHERE id = ?').get(reservationId)
    : null;
  return {
    ...result,
    billing: billingForReservationRow(reservation),
  };
}

function setVersionGenerationStep(db, ctx, versionId, timestamp) {
  db.prepare(`
    UPDATE redraw_versions
    SET status = 'generating', updated_at = ?
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).run(timestamp, Number(versionId), String(ctx.tenantId), String(ctx.userId));
  db.prepare(`
    UPDATE redraw_works
    SET status = 'generating', current_step = 3, updated_at = ?
    WHERE id = (
      SELECT work_id FROM redraw_versions
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    )
      AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).run(
    timestamp,
    Number(versionId),
    String(ctx.tenantId),
    String(ctx.userId),
    String(ctx.tenantId),
    String(ctx.userId),
  );
}

function advanceVersionIfAllShotsCompleted(db, ctx, versionId, timestamp) {
  const gate = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE
        WHEN s.video_generation_id IS NOT NULL
          AND s.approved_candidate_review_id IS NOT NULL
          AND s.status IN ('approved', 'included', 'completed')
          AND EXISTS (
            SELECT 1
            FROM redraw_candidate_reviews r
            WHERE r.id = s.approved_candidate_review_id
              AND r.tenant_id = s.tenant_id
              AND r.user_id = s.user_id
              AND r.shot_id = s.id
              AND r.video_generation_id = s.video_generation_id
              AND r.decision = 'approved'
          )
        THEN 0 ELSE 1
      END) AS incomplete
    FROM redraw_shots s
    WHERE s.version_id = ? AND s.tenant_id = ? AND s.user_id = ? AND s.deleted_at IS NULL
  `).get(Number(versionId), String(ctx.tenantId), String(ctx.userId));
  if (!gate || Number(gate.total) < 1 || Number(gate.incomplete || 0) !== 0) return false;
  db.prepare(`
    UPDATE redraw_versions
    SET status = 'composing', updated_at = ?
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).run(timestamp, Number(versionId), String(ctx.tenantId), String(ctx.userId));
  db.prepare(`
    UPDATE redraw_works
    SET status = 'composing', current_step = 4, updated_at = ?
    WHERE id = (
      SELECT work_id FROM redraw_versions
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    )
      AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).run(
    timestamp,
    Number(versionId),
    String(ctx.tenantId),
    String(ctx.userId),
    String(ctx.tenantId),
    String(ctx.userId),
  );
  return true;
}

function ownerMatches(row, ctx) {
  return String(row?.tenant_id || '') === String(ctx.tenantId || '')
    && String(row?.user_id || '') === String(ctx.userId || '');
}

function getTask(db, taskId, ctx = null) {
  const task = db.prepare('SELECT * FROM async_tasks WHERE id = ? AND deleted_at IS NULL').get(String(taskId));
  if (!task || task.type !== 'redraw_shot') throw codedError('REDRAW_SHOT_TASK_NOT_FOUND', '单镜视频任务不存在');
  if (ctx && !ownerMatches(task, ctx)) throw codedError('REDRAW_SHOT_NOT_FOUND', '单镜视频任务不存在或无权访问');
  return task;
}

function getVideoForTask(db, task, ctx = null) {
  const ownerClause = ctx ? ' AND tenant_id = ? AND user_id = ?' : '';
  const ownerParams = ctx ? [String(ctx.tenantId), String(ctx.userId)] : [];
  const row = db.prepare(`SELECT * FROM video_generations
    WHERE task_id = ? AND deleted_at IS NULL${ownerClause}
    ORDER BY id DESC LIMIT 1`).get(task.id, ...ownerParams);
  if (!row) throw codedError('REDRAW_VIDEO_NOT_FOUND', '单镜视频记录不存在');
  return row;
}

function getShotForTask(db, task, ctx = null) {
  const ownerClause = ctx ? ' AND s.tenant_id = ? AND s.user_id = ? AND v.tenant_id = ? AND v.user_id = ?' : '';
  const ownerParams = ctx ? [String(ctx.tenantId), String(ctx.userId), String(ctx.tenantId), String(ctx.userId)] : [];
  const shot = db.prepare(`
    SELECT s.*
    FROM redraw_shots s
    JOIN redraw_versions v ON v.id = s.version_id AND v.deleted_at IS NULL
    WHERE s.id = ? AND s.deleted_at IS NULL${ownerClause}
    LIMIT 1
  `).get(Number(task.resource_id), ...ownerParams);
  if (!shot) throw codedError('REDRAW_SHOT_NOT_FOUND', '转绘镜头不存在');
  return shot;
}

function classifyVideoOutcome(row, verification) {
  const normalized = normalizeVideoProviderResult(row);
  if (normalized.status === 'completed_candidate') {
    if (row.local_path && verification?.duration > 0 && verification?.width > 0 && verification?.height > 0) {
      return { status: 'completed' };
    }
    return { status: 'needs_attention', error: '供应商候选视频成片尚未通过本地文件验证，请人工确认后处理' };
  }
  if (normalized.status === 'failed_terminal') {
    return { status: 'failed', error: '供应商明确返回生成失败' };
  }
  if (normalized.status === 'result_unavailable') {
    return { status: 'needs_attention', error: '供应商候选结果不可读取，请人工确认后处理' };
  }
  return { status: 'needs_attention', error: '供应商状态未知或仍可能处理中，请勿重新提交' };
}

function updateNeedsAttention(db, taskId, shotId, message, timestamp, videoGenerationId = null) {
  const safeMessage = String(message || '').slice(0, 500);
  db.transaction(() => {
    db.prepare(`
      UPDATE redraw_shots
      SET status = 'needs_attention', error_code = 'REDRAW_VIDEO_NEEDS_ATTENTION',
          error_message = ?, updated_at = ?
      WHERE id = ?
    `).run(safeMessage, timestamp, shotId);
    db.prepare(`
      UPDATE async_tasks
      SET status = 'needs_attention', progress = 90, message = ?, error = ?,
          result = NULL, completed_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(safeMessage, safeMessage, timestamp, taskId);
    if (videoGenerationId != null) {
      db.prepare(`
        UPDATE video_generations
        SET status = 'needs_attention', error_msg = ?, updated_at = ?
        WHERE id = ? AND task_id = ?
      `).run(safeMessage, timestamp, Number(videoGenerationId), taskId);
    } else {
      db.prepare(`
        UPDATE video_generations
        SET status = 'needs_attention', error_msg = ?, updated_at = ?
        WHERE task_id = ? AND deleted_at IS NULL
      `).run(safeMessage, timestamp, taskId);
    }
    const shot = db.prepare(`
      SELECT version_id, tenant_id, user_id
      FROM redraw_shots
      WHERE id = ? AND deleted_at IS NULL
    `).get(shotId);
    if (shot?.version_id && shot?.tenant_id && shot?.user_id) {
      setVersionGenerationStep(db, {
        tenantId: shot.tenant_id,
        userId: shot.user_id,
      }, shot.version_id, timestamp);
    }
  })();
}

function terminalTaskResult(task, video, shot) {
  const taskStatus = String(task?.status || '');
  const videoStatus = String(video?.status || '');
  const shotStatus = String(shot?.status || '');
  const approvedShot = ['approved', 'included', 'completed'].includes(shotStatus);
  if (taskStatus === 'completed' && videoStatus === 'completed' && approvedShot) {
    const result = strictJson(task.result, 'async_tasks.result');
    const draft = strictJson(shot.draft_json, 'draft_json');
    const ref = draft.new_video_ref || {};
    return {
      status: 'completed',
      task_id: task.id,
      video_generation_id: video.id,
      asset_id: result.asset_id || ref.asset_id || null,
      new_video_ref: ref,
    };
  }
  if (taskStatus === 'needs_attention' && videoStatus === 'completed'
    && ['needs_review', 'needs_attention'].includes(shotStatus)) {
    return {
      status: 'needs_attention',
      error: task.error || task.message || shot.error_message || null,
      task_id: task.id,
      video_generation_id: video.id,
    };
  }
  if (taskStatus === 'failed' && videoStatus === 'failed' && shotStatus === 'failed') {
    return {
      status: 'failed',
      error: task.error || task.message || video.error_msg || shot.error_message || null,
      task_id: task.id,
      video_generation_id: video.id,
    };
  }
  const terminalStatuses = new Set(['completed', 'failed', 'needs_attention', 'approved', 'included', 'needs_review']);
  if (![taskStatus, videoStatus, shotStatus].some((status) => terminalStatuses.has(status))) return null;
  if (shotStatus === 'candidate_ready' && taskStatus === 'processing' && videoStatus === 'completed') return null;
  return { status: 'needs_attention', error: '单镜视频本地终态不一致，请人工确认后处理', degrade: true };
}

function terminalStatus(row) {
  const status = String(row?.status || '');
  return ['completed', 'failed', 'needs_attention', 'approved', 'included', 'needs_review'].includes(status)
    ? status
    : null;
}

function needsNativeAudioValidation(row, _shot) {
  if (Number(row?.generate_audio) !== 1) return false;
  const snapshot = strictJson(row.request_snapshot, 'video_generations.request_snapshot');
  return snapshot.generate_audio === true && !!(snapshot.locale_pack && snapshot.dialogue_snapshot_hash);
}

function isNativeAudioDownloadFailure(row, message) {
  return String(row?.error_msg || message || '').includes(videoService.NATIVE_AUDIO_DOWNLOAD_FAILURE_CODE);
}

function nativeAudioDownloadFailureError(row, message) {
  const clean = String(row?.error_msg || message || '原生对白视频下载失败，请人工确认后处理')
    .replace(new RegExp(`^${videoService.NATIVE_AUDIO_DOWNLOAD_FAILURE_CODE}:\\s*`), '')
    .slice(0, 500);
  const error = new Error(clean);
  error.code = videoService.NATIVE_AUDIO_DOWNLOAD_FAILURE_CODE;
  return error;
}

function compactNativeAudioEvidence(evidence) {
  return {
    contract: evidence.contract,
    artifact_sha256: evidence.artifact_sha256,
    audio_stream: evidence.audio_stream,
    video_duration_ms: evidence.video_duration_ms,
    silence: evidence.silence,
    verification: evidence.verification,
    validation_hash: evidence.validation_hash,
  };
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function nativeAudioCandidate(row, evidence = null) {
  const snapshot = strictJson(row.request_snapshot, 'video_generations.request_snapshot');
  return {
    video_generation_id: row.id,
    provider: String(row.provider || ''),
    model: String(row.model || ''),
    config_id: Number(row.ai_service_config_id) || null,
    config_updated_at: String(snapshot.config_updated_at || ''),
    provider_task_id_sha256: sha256Text(row.provider_task_id || ''),
    ...(evidence?.artifact_sha256 ? { artifact_sha256: evidence.artifact_sha256 } : {}),
    artifact_locator_sha256: sha256Text(`${row.video_url || ''}\n${row.local_path || ''}`),
  };
}

function nativeAudioValidationInput(ctx, row, shot, draft) {
  const generation = draft.generation || {};
  const snapshot = strictJson(row.request_snapshot, 'video_generations.request_snapshot');
  const language = languageFromLocale(snapshot.locale || generation.locale || shot.version_locale)
    || languageFromLocale(generation.locale_pack);
  const pack = assertReadyNativePack(ctx, language);
  return {
    storageRoot: ctx.storageRoot,
    videoPath: row.local_path,
    approvedText: buildNativeDialogues(shot).map((line) => line.text).join('\n'),
    expectedLanguage: pack.language,
    localePack: pack,
    expectedDurationMs: Number(row.duration) > 0 ? Number(row.duration) * 1000 : undefined,
    localeVerifier: ctx.localeVerifier,
    videoInvocation: {
      provider: String(row.provider || ''),
      model: String(row.model || ''),
      aiServiceConfigId: Number(row.ai_service_config_id),
      configUpdatedAt: String(snapshot.config_updated_at || generation.config_updated_at || ''),
      providerTaskId: String(row.provider_task_id || ''),
      artifactSha256: null,
    },
  };
}

async function validateShotNativeAudio(ctx, row, shot) {
  const draft = strictJson(shot.draft_json, 'draft_json');
  const validator = ctx.nativeAudioValidator || redrawNativeAudioService.validateNativeAudio;
  const evidence = await validator(nativeAudioValidationInput(ctx, row, shot, draft));
  return {
    ...compactNativeAudioEvidence(evidence),
    status: 'verified',
    human_review: { status: 'pending' },
  };
}

function nativeAudioFailureAudit(row, error, stage, humanReviewStatus, evidence = null) {
  const safeMessage = String(error?.message || error || '原生对白音轨验证失败').slice(0, 500);
  return {
    ...(evidence ? compactNativeAudioEvidence(evidence) : {}),
    status: evidence ? 'verified' : 'failed',
    failure_stage: stage,
    error_code: error?.code || 'REDRAW_NATIVE_AUDIO_VALIDATION_FAILED',
    error_message: safeMessage,
    candidate: nativeAudioCandidate(row, evidence),
    human_review: { status: humanReviewStatus },
  };
}

function nativeAudioAuditFromShotOrTask(shot, task) {
  const draft = strictJson(shot.draft_json, 'draft_json');
  if (draft.native_audio_validation) return { draft, audit: draft.native_audio_validation };
  const taskResult = strictJson(task.result, 'async_tasks.result');
  return { draft, audit: taskResult.native_audio_validation || null };
}

function reviewConflict(message = '原生音轨审核证据已变化，请刷新后重试') {
  throw codedError('REDRAW_NATIVE_AUDIO_REVIEW_CONFLICT', message);
}

function reviewUnavailable(message = '当前原生音轨候选不可人工批准') {
  throw codedError('REDRAW_NATIVE_AUDIO_REVIEW_UNAVAILABLE', message);
}

function sameNativeAudioReview(review, input, reviewerId) {
  if (!review || review.status !== input.decision) return false;
  if (String(review.reviewer_id || '') !== String(reviewerId || '')) return false;
  if (input.decision === 'approved') {
    return review.speaker_order === 'passed'
      && review.lip_sync === 'passed'
      && review.extra_dialogue === 'passed';
  }
  return String(review.reason || '') === String(input.reason || '');
}

function manualOverrideForAudit(audit) {
  const verification = audit?.verification || {};
  if (verification.language_verified !== true) return true;
  if (Object.prototype.hasOwnProperty.call(verification, 'dialogue_similarity')
    && Number(verification.dialogue_similarity) < 0.8) return true;
  return false;
}

function candidateReviewSha256(ctx, db, shotId, videoId, fallback) {
  if (typeof ctx.candidateHasher !== 'function') return fallback;
  return ctx.candidateHasher({
    ctx,
    shot: db.prepare('SELECT * FROM redraw_shots WHERE id = ?').get(shotId),
    video: db.prepare('SELECT * FROM video_generations WHERE id = ?').get(videoId),
  });
}

async function reviewNativeAudio(ctx, input = {}) {
  const { db } = ctx;
  if (!db || !ctx.tenantId || !ctx.userId) throw codedError('REDRAW_CONTEXT_INVALID', '缺少转绘生成上下文');
  const shot = selectShot(db, ctx, { shotId: input.shotId ?? input.shot_id });
  const video = shot.video_generation_id
    ? db.prepare(`SELECT * FROM video_generations
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
      LIMIT 1`).get(Number(shot.video_generation_id), String(ctx.tenantId), String(ctx.userId))
    : null;
  if (!video) throw codedError('REDRAW_VIDEO_NOT_FOUND', '单镜视频记录不存在');
  const task = video.task_id ? getTask(db, video.task_id, ctx) : null;
  if (!task || String(task.resource_id) !== String(shot.id)) {
    throw codedError('REDRAW_SHOT_TASK_NOT_FOUND', '单镜视频任务不存在');
  }
  const { draft, audit } = nativeAudioAuditFromShotOrTask(shot, task);
  const validationHash = String(input.validation_hash || input.validationHash || '').trim().toLowerCase();
  if (!audit || String(audit.validation_hash || '').toLowerCase() !== validationHash) {
    reviewConflict();
  }
  const decision = String(input.decision || '').trim();
  const existingReview = audit.human_review || {};
  if (['approved', 'rejected'].includes(String(existingReview.status || ''))
    && sameNativeAudioReview(existingReview, { ...input, decision }, ctx.userId)) {
    const ref = draft.new_video_ref || {};
    if (decision === 'approved' && !['approved', 'included', 'completed'].includes(String(shot.status))) {
      if (!ref.asset_id || String(video.status) !== 'completed') {
        reviewUnavailable('当前原生音轨候选不可人工批准');
      }
      const retryExpectedUpdatedAt = String(input.expected_updated_at || input.expectedUpdatedAt || '');
      if (retryExpectedUpdatedAt !== String(shot.updated_at || '')) {
        reviewConflict('分镜已被其他操作更新，请刷新后重试');
      }
      try {
        const candidateReview = await redrawCandidateReviewService.reviewCandidate(ctx, {
          shot_id: shot.id,
          video_generation_id: video.id,
          decision_source: 'human',
          decision: 'approved',
          expected_updated_at: retryExpectedUpdatedAt,
          candidate_sha256: candidateReviewSha256(
            ctx,
            db,
            shot.id,
            video.id,
            String(audit.candidate?.artifact_sha256 || ''),
          ),
          reason_codes: ['native_audio_human_approved'],
        });
        return enrichGenerationResult(db, {
          status: 'completed',
          task_id: task.id,
          video_generation_id: video.id,
          asset_id: ref.asset_id,
          candidate_review_id: candidateReview.id,
          reservation_id: taskMetadata(task).reservation_id || null,
        });
      } catch (error) {
        updateCandidateNeedsAttention(db, task.id, shot.id, error.message, monotonicTimestamp(shot.updated_at, now(ctx)));
        throw error;
      }
    }
    return enrichGenerationResult(db, {
      status: ['approved', 'included', 'completed'].includes(String(shot.status)) ? 'completed' : shot.status,
      task_id: task.id,
      video_generation_id: video.id,
      asset_id: ref.asset_id || null,
      reservation_id: taskMetadata(task).reservation_id || null,
    });
  }
  if (String(input.expected_updated_at || input.expectedUpdatedAt || '') !== String(shot.updated_at || '')) {
    reviewConflict('分镜已被其他操作更新，请刷新后重试');
  }
  if (['approved', 'rejected'].includes(String(existingReview.status || ''))) {
    reviewConflict('原生音轨已按不同决定审核，请刷新后重试');
  }
  const expectedUpdatedAt = String(input.expected_updated_at || input.expectedUpdatedAt || '');
  if (decision === 'rejected') {
    const timestamp = monotonicTimestamp(shot.updated_at, now(ctx));
    const review = {
      status: 'rejected',
      reviewer_id: String(ctx.userId),
      reason: String(input.reason || '').trim().slice(0, 500),
      reviewed_at: timestamp,
    };
    db.transaction(() => {
      const changed = db.prepare(`
        UPDATE redraw_shots
        SET status = 'needs_review',
            error_code = 'REDRAW_NATIVE_AUDIO_REJECTED',
            error_message = ?,
            draft_json = ?,
            updated_at = ?
        WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'needs_attention'
          AND video_generation_id = ? AND updated_at IS ? AND deleted_at IS NULL
          AND draft_json IS ?
      `).run(
        review.reason,
        mergeDraft(draft, { generation: {}, native_audio_validation: { ...audit, human_review: review } }),
        timestamp,
        shot.id,
        String(ctx.tenantId),
        String(ctx.userId),
        video.id,
        expectedUpdatedAt,
        shot.draft_json,
      );
      if (changed.changes !== 1) reviewConflict('分镜已被其他操作更新，请刷新后重试');
      db.prepare(`
        UPDATE async_tasks
        SET status = 'needs_attention', progress = 90, message = ?, error = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND user_id = ?
      `).run(review.reason, review.reason, timestamp, task.id, String(ctx.tenantId), String(ctx.userId));
      db.prepare(`
        UPDATE video_generations
        SET status = 'completed', error_msg = NULL, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND user_id = ?
      `).run(timestamp, video.id, String(ctx.tenantId), String(ctx.userId));
    })();
    return enrichGenerationResult(db, {
      status: 'needs_attention',
      task_id: task.id,
      video_generation_id: video.id,
      reservation_id: taskMetadata(task).reservation_id || null,
    });
  }
  if (decision !== 'approved') throw codedError('REDRAW_NATIVE_AUDIO_REVIEW_INVALID', '原生音轨审核决定无效');
  if (String(existingReview.status || '') !== 'available') {
    reviewUnavailable('当前原生音轨候选不可人工批准');
  }
  if (String(video.status || '') !== 'needs_attention') {
    reviewUnavailable('当前原生音轨候选状态不可人工批准');
  }
  if (!audit.audio_stream || !audit.candidate || !audit.candidate.artifact_sha256) {
    reviewUnavailable('原生音轨候选缺少可批准的音轨证据');
  }
  const verifier = ctx.artifactVerifier || verifyVideoArtifact;
  let verification;
  try {
    verification = await verifier(ctx, video.id, {
      allowedStatuses: ['needs_attention'],
      requireAudio: true,
      expectedSha256: audit.candidate.artifact_sha256,
    });
  } catch (error) {
    if (error.code === 'REDRAW_VIDEO_ARTIFACT_INVALID') {
      reviewUnavailable(error.message || '当前原生音轨候选不可人工批准');
    }
    throw error;
  }
  const timestamp = monotonicTimestamp(shot.updated_at, now(ctx));
  const importer = ctx.assetImporter || ((database, logger, videoGenerationId) => (
    assetService.importFromVideo(database, logger, videoGenerationId)
  ));
  const staged = db.transaction(() => {
    const fresh = db.prepare(`
      SELECT s.*, t.status AS task_status, v.status AS video_status
      FROM redraw_shots s
      JOIN video_generations v ON v.id = s.video_generation_id
        AND v.tenant_id = s.tenant_id AND v.user_id = s.user_id AND v.deleted_at IS NULL
      JOIN async_tasks t ON t.id = v.task_id
        AND t.tenant_id = s.tenant_id AND t.user_id = s.user_id AND t.deleted_at IS NULL
      WHERE s.id = ? AND s.tenant_id = ? AND s.user_id = ? AND s.deleted_at IS NULL
      LIMIT 1
    `).get(shot.id, String(ctx.tenantId), String(ctx.userId));
    if (!fresh || Number(fresh.video_generation_id) !== Number(video.id) || String(fresh.updated_at || '') !== expectedUpdatedAt) {
      reviewConflict('分镜已被其他操作更新，请刷新后重试');
    }
    const freshDraft = strictJson(fresh.draft_json, 'draft_json');
    const freshAudit = freshDraft.native_audio_validation || {};
    if (String(freshAudit.validation_hash || '').toLowerCase() !== validationHash
      || String(freshAudit.candidate?.artifact_sha256 || '').toLowerCase() !== String(audit.candidate.artifact_sha256 || '').toLowerCase()) {
      reviewConflict();
    }
    const claimed = db.prepare(`
      UPDATE redraw_shots
      SET status = 'pending', error_code = 'REDRAW_NATIVE_AUDIO_REVIEW_FINALIZING', updated_at = ?
      WHERE id = ? AND tenant_id = ? AND user_id = ?
        AND status = 'needs_attention' AND video_generation_id = ?
        AND updated_at IS ? AND deleted_at IS NULL
    `).run(timestamp, shot.id, String(ctx.tenantId), String(ctx.userId), video.id, expectedUpdatedAt);
    if (claimed.changes !== 1) reviewConflict('原生音轨审核正在由其他操作处理，请刷新后重试');
    let actualSha256;
    let realAbsPath;
    try {
      const relativePath = String(video.local_path || '').replace(/^\/static\//, '').replace(/\\/g, '/');
      const realStorageRoot = fs.realpathSync.native(resolveStorageRoot(ctx));
      realAbsPath = fs.realpathSync.native(path.resolve(realStorageRoot, relativePath));
      if (!isInside(realStorageRoot, realAbsPath)) reviewUnavailable('视频成片路径越界');
      actualSha256 = sha256FileSync(realAbsPath);
    } catch (error) {
      if (error.code && String(error.code).startsWith('REDRAW_')) throw error;
      reviewUnavailable('视频成片文件不可读取');
    }
    if (actualSha256 !== String(freshAudit.candidate.artifact_sha256 || '').toLowerCase()) {
      reviewUnavailable('视频成片哈希与审核候选不一致');
    }
    const imported = importer(db, ctx.log || logNoop, video.id);
    if (imported && typeof imported.then === 'function') {
      throw codedError('REDRAW_VIDEO_ASSET_IMPORT_INVALID', '视频成片素材入库必须同步完成');
    }
    if (!imported?.id) {
      throw codedError('REDRAW_VIDEO_ASSET_IMPORT_FAILED', '视频成片素材入库失败，请人工确认后处理');
    }
    const review = {
      status: 'approved',
      reviewer_id: String(ctx.userId),
      speaker_order: 'passed',
      lip_sync: 'passed',
      extra_dialogue: 'passed',
      manual_override: manualOverrideForAudit(audit),
      reviewed_at: timestamp,
    };
    const newVideoRef = {
      asset_id: imported.id,
      video_generation_id: video.id,
      video_url: video.video_url || null,
      local_path: video.local_path,
      probe: verification,
    };
    const approvedAudit = { ...freshAudit, human_review: review };
    db.prepare(`
      UPDATE video_generations
      SET status = 'completed', error_msg = NULL, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND user_id = ?
    `).run(timestamp, video.id, String(ctx.tenantId), String(ctx.userId));
    db.prepare(`
      UPDATE redraw_shots
      SET status = 'candidate_ready', approved_candidate_review_id = NULL,
          error_code = NULL, error_message = NULL,
          draft_json = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND user_id = ?
    `).run(
      mergeDraft(draft, {
        generation: { candidate_at: timestamp },
        native_audio_validation: approvedAudit,
        new_video_ref: newVideoRef,
      }),
      timestamp,
      shot.id,
      String(ctx.tenantId),
      String(ctx.userId),
    );
    return { actualSha256, imported, timestamp };
  }).immediate();
  try {
    const candidateReview = await redrawCandidateReviewService.reviewCandidate(ctx, {
      shot_id: shot.id,
      video_generation_id: video.id,
      decision_source: 'human',
      decision: 'approved',
      expected_updated_at: staged.timestamp,
      candidate_sha256: candidateReviewSha256(ctx, db, shot.id, video.id, staged.actualSha256),
      reason_codes: ['native_audio_human_approved'],
    });
    return enrichGenerationResult(db, {
      status: 'completed',
      task_id: task.id,
      video_generation_id: video.id,
      asset_id: staged.imported.id,
      candidate_review_id: candidateReview.id,
      reservation_id: taskMetadata(task).reservation_id || null,
    });
  } catch (error) {
    const attentionAt = monotonicTimestamp(staged.timestamp, now(ctx));
    updateCandidateNeedsAttention(db, task.id, shot.id, error.message, attentionAt);
    throw error;
  }
}

function markNativeAudioNeedsAttention(db, task, shot, row, error, timestamp, options = {}) {
  const safeMessage = String(error?.message || error || '原生对白音轨验证失败').slice(0, 500);
  const audit = options.audit || nativeAudioFailureAudit(
    row,
    error,
    options.stage || 'native_audio_validation',
    options.humanReviewStatus || 'unavailable',
    options.evidence || null,
  );
  const draft = strictJson(shot.draft_json, 'draft_json');
  try {
    db.transaction(() => {
      db.prepare(`
        UPDATE redraw_shots
        SET status = 'needs_attention',
            error_code = 'REDRAW_NATIVE_AUDIO_VALIDATION_FAILED',
            error_message = ?,
            draft_json = ?,
            updated_at = ?
        WHERE id = ?
      `).run(safeMessage, mergeDraft(draft, {
        generation: {},
        native_audio_validation: audit,
      }), timestamp, shot.id);
      db.prepare(`
        UPDATE async_tasks
        SET status = 'needs_attention', progress = 90, message = ?, error = ?,
            result = NULL, completed_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(safeMessage, safeMessage, timestamp, task.id);
      db.prepare(`
        UPDATE video_generations
        SET status = 'needs_attention', error_msg = ?, updated_at = ?
        WHERE id = ? AND task_id = ?
      `).run(safeMessage, timestamp, row.id, task.id);
      setVersionGenerationStep(db, {
        tenantId: shot.tenant_id,
        userId: shot.user_id,
      }, shot.version_id, timestamp);
    })();
    return;
  } catch (persistError) {
    db.transaction(() => {
      db.prepare(`
        UPDATE redraw_shots
        SET status = 'needs_attention',
            error_code = 'REDRAW_NATIVE_AUDIO_VALIDATION_FAILED',
            error_message = ?,
            updated_at = ?
        WHERE id = ?
      `).run(safeMessage, timestamp, shot.id);
      db.prepare(`
        UPDATE async_tasks
        SET status = 'needs_attention', progress = 90, message = ?, error = ?,
            result = ?, completed_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(safeMessage, safeMessage, JSON.stringify({ native_audio_validation: audit }), timestamp, task.id);
      db.prepare(`
        UPDATE video_generations
        SET status = 'needs_attention', error_msg = ?, updated_at = ?
        WHERE id = ? AND task_id = ?
      `).run(safeMessage, timestamp, row.id, task.id);
      setVersionGenerationStep(db, {
        tenantId: shot.tenant_id,
        userId: shot.user_id,
      }, shot.version_id, timestamp);
    })();
  }
}

async function runShotGeneration(ctx, taskId) {
  const { db } = ctx;
  const ownerCtx = ctx.tenantId && ctx.userId ? ctx : null;
  const task = getTask(db, taskId, ownerCtx);
  const metadata = taskMetadata(task);
  const video = getVideoForTask(db, task, ownerCtx);
  const shot = getShotForTask(db, task, ownerCtx);
  const terminal = terminalTaskResult(task, video, shot);
  const recoveredRemoteTerminal = ctx.recoverExistingProvider === true
    && !terminalStatus(shot)
    && ['completed', 'failed'].includes(String(video.status))
    && String(task.status) === String(video.status);
  if (terminal && !recoveredRemoteTerminal) {
    if (terminal.degrade) {
      const timestamp = now(ctx);
      updateNeedsAttention(db, task.id, shot.id, terminal.error, timestamp, video.id);
      return { status: 'needs_attention', error: terminal.error, task_id: task.id, video_generation_id: video.id };
    }
    return terminal;
  }
  if (ctx.recoverExistingProvider === true && !String(video.provider_task_id || '').trim()) {
    const timestamp = now(ctx);
    updateNeedsAttention(db, task.id, shot.id, INTERRUPTED_MESSAGE, timestamp, video.id);
    return { status: 'needs_attention', error: INTERRUPTED_MESSAGE, task_id: task.id, video_generation_id: video.id };
  }
  const processor = ctx.recoverExistingProvider === true
    ? (ctx.videoRecoveryProcessor || waitForRecoveredVideo)
    : (ctx.videoProcessor || ((database, logger, videoGenerationId) => (
      videoService.processVideoGeneration(database, logger, videoGenerationId, {
        storageLocalPath: ctx.storageRoot,
        storageBaseUrl: ctx.storageBaseUrl,
        providerAssetSigningSecret: ctx.providerAssetSecret,
        providerAssetStorageBaseUrl: ctx.storageBaseUrl,
        providerAssetTtlSeconds: ctx.providerAssetTtlSeconds,
        providerAssetNowMs: ctx.providerAssetNowMs,
        evidenceRoots: ctx.evidenceRoots,
      })
    )));
  if (!recoveredRemoteTerminal) await processor(db, ctx.log || logNoop, video.id);
  const row = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(video.id);
  let verification = null;
  let imported = null;
  if (row?.status === 'completed' && row.local_path) {
    try {
      const verifier = ctx.artifactVerifier || verifyVideoArtifact;
      verification = await verifier(ctx, row.id, {});
    } catch (error) {
      const timestamp = now(ctx);
      if (needsNativeAudioValidation(row, shot)) {
        markNativeAudioNeedsAttention(db, task, shot, row, error, timestamp, {
          stage: 'artifact_verification',
          humanReviewStatus: 'unavailable',
        });
      } else {
        updateNeedsAttention(db, task.id, shot.id, error.message, timestamp, row.id);
      }
      return { status: 'needs_attention', error: error.message, task_id: task.id, video_generation_id: row.id };
    }
  }
  const outcome = classifyVideoOutcome(row, verification);
  const timestamp = now(ctx);
  if (outcome.status === 'completed') {
    let nativeAudioValidation = null;
    if (needsNativeAudioValidation(row, shot)) {
      try {
        nativeAudioValidation = await validateShotNativeAudio(ctx, row, shot);
      } catch (error) {
        markNativeAudioNeedsAttention(db, task, shot, row, error, timestamp, {
          stage: 'native_audio_validation',
          humanReviewStatus: 'available',
        });
        return { status: 'needs_attention', error: error.message, task_id: task.id, video_generation_id: row.id };
      }
    }
    const importer = ctx.assetImporter || ((database, logger, videoGenerationId) => (
      assetService.importFromVideo(database, logger, videoGenerationId)
    ));
    let finalizationStage = 'candidate_asset_register';
    try {
      db.transaction(() => {
        const claimed = db.prepare(`
          UPDATE redraw_shots
          SET status = 'pending', error_code = 'REDRAW_CANDIDATE_REVIEWING', updated_at = ?
          WHERE id = ? AND status = 'processing' AND video_generation_id = ?
        `).run(timestamp, shot.id, row.id);
        if (claimed.changes !== 1) {
          const freshTask = getTask(db, task.id, ownerCtx);
          const freshVideo = getVideoForTask(db, freshTask, ownerCtx);
          const freshShot = getShotForTask(db, freshTask, ownerCtx);
          const concurrentResult = terminalTaskResult(freshTask, freshVideo, freshShot);
          if (concurrentResult && !concurrentResult.degrade) return concurrentResult;
          throw codedError('REDRAW_VIDEO_FINALIZATION_CONFLICT', '单镜视频正在由其他任务收口，请勿重复导入');
        }
        const draft = strictJson(shot.draft_json, 'draft_json');
        if (nativeAudioValidation) {
          finalizationStage = 'native_audio_evidence_write';
          db.prepare(`
            UPDATE redraw_shots
            SET draft_json = ?, updated_at = ?
            WHERE id = ?
          `).run(mergeDraft(draft, {
            generation: {},
            native_audio_validation: nativeAudioValidation,
          }), timestamp, shot.id);
        }
        const updatedDraft = nativeAudioValidation
          ? strictJson(db.prepare('SELECT draft_json FROM redraw_shots WHERE id = ?').get(shot.id).draft_json, 'draft_json')
          : draft;
        finalizationStage = 'asset_register';
        imported = importer(db, ctx.log || logNoop, row.id);
        if (imported && typeof imported.then === 'function') {
          throw codedError('REDRAW_VIDEO_ASSET_IMPORT_INVALID', '视频成片素材入库必须同步完成');
        }
        if (!imported?.id) {
          throw codedError('REDRAW_VIDEO_ASSET_IMPORT_FAILED', '视频成片素材入库失败，请人工确认后处理');
        }
        const newVideoRef = {
          asset_id: imported.id,
          video_generation_id: row.id,
          video_url: row.video_url || null,
          local_path: row.local_path,
          probe: verification,
        };
        db.prepare(`
          UPDATE video_generations
          SET error_msg = NULL, updated_at = ?
          WHERE id = ? AND task_id = ?
        `).run(timestamp, row.id, task.id);
        db.prepare(`
          UPDATE redraw_shots
          SET status = 'candidate_ready', video_generation_id = ?, error_code = 'REDRAW_CANDIDATE_REVIEWING',
              error_message = NULL,
              draft_json = ?, updated_at = ?
          WHERE id = ?
        `).run(row.id, mergeDraft(updatedDraft, {
          generation: { candidate_at: timestamp },
          new_video_ref: newVideoRef,
        }), timestamp, shot.id);
      })();
    } catch (error) {
      if (error.code === 'REDRAW_VIDEO_FINALIZATION_CONFLICT') {
        const concurrent = await waitForConcurrentFinalization(db, task, ownerCtx);
        if (concurrent) return concurrent;
      }
      if (nativeAudioValidation) {
        markNativeAudioNeedsAttention(db, task, shot, row, error, timestamp, {
          stage: finalizationStage,
          humanReviewStatus: 'available',
          evidence: nativeAudioValidation,
        });
      } else {
        updateNeedsAttention(db, task.id, shot.id, error.message, timestamp, row.id);
      }
      return { status: 'needs_attention', error: error.message, task_id: task.id, video_generation_id: row.id };
    }

    let review;
    finalizationStage = nativeAudioValidation ? 'settlement' : 'candidate_quality_review';
    try {
      review = await redrawCandidateReviewService.reviewCandidate({
        ...ctx,
        tenantId: ctx.tenantId || shot.tenant_id,
        userId: ctx.userId || shot.user_id,
      }, {
        shot_id: shot.id,
        video_generation_id: row.id,
        decision_source: 'automatic',
      });
    } catch (error) {
      const attentionAt = monotonicTimestamp(timestamp, now(ctx));
      if (nativeAudioValidation) {
        markNativeAudioNeedsAttention(db, task, shot, row, error, attentionAt, {
          stage: finalizationStage,
          humanReviewStatus: 'available',
          evidence: nativeAudioValidation,
        });
      } else {
        updateCandidateNeedsAttention(db, task.id, shot.id, error.message, attentionAt);
      }
      return {
        status: 'needs_attention',
        error: error.message,
        task_id: task.id,
        video_generation_id: row.id,
        asset_id: imported.id,
      };
    }
    if (review.decision !== 'approved') {
      return {
        status: 'needs_attention',
        error: review.decision === 'rejected'
          ? '逐镜候选质量未通过，等待人工处理'
          : '逐镜候选等待人工审核',
        task_id: task.id,
        video_generation_id: row.id,
        asset_id: imported.id,
        candidate_review_id: review.id,
      };
    }

    return {
      status: 'completed',
      task_id: task.id,
      video_generation_id: row.id,
      asset_id: imported.id,
      candidate_review_id: review.id,
    };
  }
  if (outcome.status === 'failed') {
    try {
      db.transaction(() => {
        db.prepare(`
          UPDATE video_generations
          SET status = 'failed', error_msg = ?, updated_at = ?
          WHERE id = ? AND task_id = ?
        `).run(outcome.error, timestamp, row.id, task.id);
        db.prepare(`
          UPDATE redraw_shots
          SET status = 'failed', error_code = 'REDRAW_VIDEO_FAILED',
              error_message = ?, updated_at = ?
          WHERE id = ?
        `).run(String(outcome.error || '').slice(0, 500), timestamp, shot.id);
        setVersionGenerationStep(db, {
          tenantId: shot.tenant_id,
          userId: shot.user_id,
        }, shot.version_id, timestamp);
        taskService.updateTaskError(db, task.id, outcome.error || '单镜视频生成失败');
        redrawBillingService.settleShotGeneration(db, metadata.reservation_id, 'failed', outcome.error || '单镜视频生成失败');
      })();
      return { status: 'failed', error: outcome.error, task_id: task.id, video_generation_id: row.id };
    } catch (error) {
      updateNeedsAttention(db, task.id, shot.id, error.message, timestamp, row.id);
      return { status: 'needs_attention', error: error.message, task_id: task.id, video_generation_id: row.id };
    }
  }
  if (needsNativeAudioValidation(row, shot) && isNativeAudioDownloadFailure(row, outcome.error)) {
    const error = nativeAudioDownloadFailureError(row, outcome.error);
    markNativeAudioNeedsAttention(db, task, shot, row, error, timestamp, {
      stage: 'download',
      humanReviewStatus: 'unavailable',
    });
    return { status: 'needs_attention', error: error.message, task_id: task.id, video_generation_id: row.id };
  }
  updateNeedsAttention(db, task.id, shot.id, outcome.error, timestamp, row.id);
  return { status: 'needs_attention', error: outcome.error, task_id: task.id, video_generation_id: row.id };
}

async function waitForRecoveredVideo(db, _log, videoGenerationId, options = {}) {
  const maxWaitMs = Number(options.recoveryMaxWaitMs || DEFAULT_RECOVERY_WAIT_MS);
  const pollMs = Number(options.recoveryPollMs || DEFAULT_RECOVERY_POLL_MS);
  const deadline = Date.now() + (Number.isFinite(maxWaitMs) && maxWaitMs > 0 ? maxWaitMs : DEFAULT_RECOVERY_WAIT_MS);
  while (Date.now() < deadline) {
    const row = db.prepare('SELECT status FROM video_generations WHERE id = ? AND deleted_at IS NULL')
      .get(Number(videoGenerationId));
    if (!row || row.status !== 'processing') return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, Number.isFinite(pollMs) && pollMs > 0 ? pollMs : DEFAULT_RECOVERY_POLL_MS);
      timer.unref?.();
    });
  }
}

async function runBounded(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function consume() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  const limit = Math.min(items.length, Math.max(1, concurrency));
  await Promise.all(Array.from({ length: limit }, () => consume()));
  return results;
}

function failBatchShotSafely(ctx, shot, error) {
  const { db } = ctx;
  const current = db.prepare('SELECT status, video_generation_id FROM redraw_shots WHERE id = ?').get(shot.id);
  const video = current?.video_generation_id
    ? db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(current.video_generation_id))
    : null;
  const task = video?.task_id
    ? db.prepare('SELECT * FROM async_tasks WHERE id = ? AND deleted_at IS NULL').get(video.task_id)
    : null;
  let reservationId = null;
  try {
    reservationId = task ? taskMetadata(task).reservation_id : null;
  } catch (_) {}
  if (task && video && ['pending', 'processing'].includes(String(task.status))) {
    updateNeedsAttention(db, task.id, shot.id, error.message, now(ctx), video.id);
  }
  const actualStatus = db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shot.id)?.status || 'failed';
  return enrichGenerationResult(db, {
    shot_id: shot.id,
    task_id: task?.id || null,
    video_generation_id: video?.id || null,
    reservation_id: reservationId,
    status: actualStatus,
    error_code: error.code || 'REDRAW_BATCH_SHOT_FAILED',
    error: error.message,
  });
}

function scheduleBatchDrain(ctx, jobs, concurrency) {
  if (!jobs.length) return;
  const configured = Number(process.env.GENERATION_REDRAW_VIDEO_CONCURRENCY || DEFAULT_GENERATION_CONCURRENCY);
  const productionLimit = Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, 8)
    : DEFAULT_GENERATION_CONCURRENCY;
  const requestedLimit = Number.isSafeInteger(concurrency) && concurrency > 0
    ? Math.min(concurrency, productionLimit)
    : productionLimit;
  const queueEnv = {
    ...process.env,
    GENERATION_REDRAW_VIDEO_CONCURRENCY: String(requestedLimit),
  };
  const drain = () => Promise.all(jobs.map((job) => (
    runWithGenerationLimit('redraw_video', job, queueEnv).catch((error) => {
      if (error.code === 'GENERATION_QUEUE_FULL' && job.redraw) {
        updateNeedsAttention(
          ctx.db,
          job.redraw.task_id,
          job.redraw.shot_id,
          '转绘视频生成队列已满，请人工确认后重试',
          now(ctx),
          job.redraw.video_generation_id,
        );
      }
      ctx.log?.error?.('redraw batch background generation failed', { error: error.message });
      return null;
    })
  )));
  if (ctx.batchScheduler) {
    ctx.batchScheduler(drain);
    return;
  }
  const immediate = setImmediate(() => {
    drain().catch((error) => {
      ctx.log?.error?.('redraw batch drain failed', { error: error.message });
    });
  });
  immediate.unref?.();
}

async function generateBatch(ctx, input = {}) {
  const { db } = ctx;
  if (!db || !ctx.tenantId || !ctx.userId) throw codedError('REDRAW_CONTEXT_INVALID', '缺少转绘生成上下文');
  rejectClientVideoConditioning(input);
  if (Object.prototype.hasOwnProperty.call(input, 'shot_id')
    || Object.prototype.hasOwnProperty.call(input, 'shotId')) {
    throw codedError('REDRAW_BATCH_INPUT_INVALID', '批量生成不接受单镜 shot_id 或 shotId');
  }
  const versionId = normalizeVersionId(input.version_id ?? input.versionId);
  const explicitIds = normalizeBatchShotIds(input.shot_ids ?? input.shotIds);
  const preflight = db.transaction(() => {
    const version = db.prepare(`
      SELECT * FROM redraw_versions
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(versionId, String(ctx.tenantId), String(ctx.userId));
    if (!version) throw codedError('REDRAW_VERSION_NOT_FOUND', '转绘版本不存在或无权访问');
    const batchStyleSnapshot = strictJson(version.style_snapshot_json, 'redraw_versions.style_snapshot_json');
    ensureGateOpen(db, ctx, versionId);

    let rows;
    if (explicitIds) {
      const placeholders = explicitIds.map(() => '?').join(',');
      rows = db.prepare(`
        SELECT * FROM redraw_shots
        WHERE id IN (${placeholders}) AND version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
      `).all(...explicitIds, versionId, String(ctx.tenantId), String(ctx.userId));
      if (rows.length !== explicitIds.length) {
        throw codedError('REDRAW_BATCH_SHOT_INVALID', '批量镜头不存在、跨版本或无权访问');
      }
      const byId = new Map(rows.map((row) => [Number(row.id), row]));
      rows = explicitIds.map((id) => byId.get(id));
    } else {
      rows = db.prepare(`
        SELECT * FROM redraw_shots
        WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
        ORDER BY batch_index ASC, shot_index ASC, id ASC
      `).all(versionId, String(ctx.tenantId), String(ctx.userId));
    }
    return { batchStyleSnapshot, rows };
  })();
  const { batchStyleSnapshot, rows } = preflight;

  const candidates = rows.filter((row) => !['completed', 'processing'].includes(String(row.status)));
  const skipped = rows.filter((row) => ['completed', 'processing'].includes(String(row.status)))
    .map((row) => ({ shot_id: row.id, status: row.status }));
  const rawConcurrency = Number(ctx.generationConcurrency ?? DEFAULT_GENERATION_CONCURRENCY);
  const concurrency = Number.isSafeInteger(rawConcurrency) && rawConcurrency > 0
    ? Math.min(rawConcurrency, 8)
    : DEFAULT_GENERATION_CONCURRENCY;
  const jobs = [];
  const results = [];
  for (const shot of candidates) {
    try {
      const jobStart = jobs.length;
      const generationContext = {
        ...ctx,
        awaitCompletion: false,
        batchStyleSnapshot,
        schedule: (callback) => jobs.push(callback),
      };
      const shotInput = {
        ...input,
        shot_id: undefined,
        shotId: undefined,
        shot_ids: undefined,
        shotIds: undefined,
        version_id: undefined,
        versionId: undefined,
      };
      shotInput.shotId = shot.id;
      const result = shot.status === 'failed'
        ? await retryShot(generationContext, shotInput)
        : await generateShot(generationContext, shotInput);
      if (jobs[jobStart]) {
        jobs[jobStart].redraw = {
          shot_id: shot.id,
          task_id: result.task_id,
          video_generation_id: result.video_generation_id,
        };
      }
      results.push({ shot_id: shot.id, ...result });
    } catch (error) {
      results.push(failBatchShotSafely(ctx, shot, error));
    }
  }
  scheduleBatchDrain(ctx, jobs, concurrency);
  return { version_id: versionId, results, skipped };
}

function markRetryUncertain(db, shot, task, video, message, timestamp) {
  if (task && video) {
    updateNeedsAttention(db, task.id, shot.id, message, timestamp, video.id);
    return;
  }
  db.transaction(() => {
    db.prepare(`
      UPDATE redraw_shots
      SET status = 'needs_attention', error_code = 'REDRAW_VIDEO_NEEDS_ATTENTION', error_message = ?, updated_at = ?
      WHERE id = ?
    `).run(message, timestamp, shot.id);
    setVersionGenerationStep(db, {
      tenantId: shot.tenant_id,
      userId: shot.user_id,
    }, shot.version_id, timestamp);
  })();
}

async function retryShot(ctx, input = {}) {
  const { db } = ctx;
  if (!db || !ctx.tenantId || !ctx.userId) throw codedError('REDRAW_CONTEXT_INVALID', '缺少转绘生成上下文');
  const shot = selectShot(db, ctx, input);
  if (shot.status !== 'failed') {
    throw codedError('REDRAW_SHOT_RETRY_REQUIRED', '仅明确失败的镜头可以重试');
  }
  const video = shot.video_generation_id
    ? db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(shot.video_generation_id))
    : null;
  const task = video?.task_id
    ? db.prepare('SELECT * FROM async_tasks WHERE id = ? AND deleted_at IS NULL').get(video.task_id)
    : null;
  let metadata = null;
  let reservation = null;
  try {
    metadata = task ? taskMetadata(task) : null;
    reservation = metadata?.reservation_id
      ? db.prepare('SELECT * FROM tenant_usage_reservations WHERE id = ?').get(metadata.reservation_id)
      : null;
  } catch (_) {}
  const oldTerminalClear = video?.status === 'failed'
    && task?.status === 'failed'
    && reservation?.status === 'refunded'
    && String(task?.resource_id || '') === String(shot.id)
    && String(reservation?.tenant_id || '') === String(ctx.tenantId)
    && reservation?.resource_type === 'redraw_shot'
    && String(reservation?.resource_id || '') === String(shot.id)
    && ownerMatches(video, ctx)
    && ownerMatches(task, ctx);
  if (!oldTerminalClear) {
    const message = '旧生成任务终态不明确，请人工确认后处理，禁止重复提交';
    markRetryUncertain(db, shot, task, video, message, now(ctx));
    throw codedError('REDRAW_RETRY_UNCERTAIN', message);
  }
  return generateShot({ ...ctx, retryFailedShot: true }, { ...input, shotId: shot.id });
}

function updateCandidateNeedsAttention(db, taskId, shotId, message, timestamp) {
  const safeMessage = String(message || '逐镜候选质量验证异常，请人工确认后处理').slice(0, 500);
  db.transaction(() => {
    db.prepare(`
      UPDATE redraw_shots
      SET status = 'needs_attention', approved_candidate_review_id = NULL,
          error_code = 'REDRAW_CANDIDATE_REVIEW_FAILED', error_message = ?, updated_at = ?
      WHERE id = ?
    `).run(safeMessage, timestamp, shotId);
    db.prepare(`
      UPDATE async_tasks
      SET status = 'needs_attention', progress = 90, message = ?, error = ?,
          completed_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(safeMessage, safeMessage, timestamp, taskId);
    const shot = db.prepare(`
      SELECT version_id, tenant_id, user_id
      FROM redraw_shots
      WHERE id = ? AND deleted_at IS NULL
    `).get(shotId);
    if (shot?.version_id && shot?.tenant_id && shot?.user_id) {
      setVersionGenerationStep(db, {
        tenantId: shot.tenant_id,
        userId: shot.user_id,
      }, shot.version_id, timestamp);
    }
  })();
}

async function waitForConcurrentFinalization(db, task, ownerCtx) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    const freshTask = getTask(db, task.id, ownerCtx);
    const freshVideo = getVideoForTask(db, freshTask, ownerCtx);
    const freshShot = getShotForTask(db, freshTask, ownerCtx);
    const terminal = terminalTaskResult(freshTask, freshVideo, freshShot);
    if (terminal && !terminal.degrade) return terminal;
  }
  return null;
}

async function recoverInterruptedShotGenerations(ctx) {
  const { db } = ctx;
  if (!db) throw codedError('REDRAW_CONTEXT_INVALID', '缺少转绘生成上下文');
  const ownerClause = ctx.tenantId && ctx.userId ? ' AND t.tenant_id = ? AND t.user_id = ?' : '';
  const ownerParams = ctx.tenantId && ctx.userId ? [String(ctx.tenantId), String(ctx.userId)] : [];
  const rows = db.prepare(`
    SELECT t.id AS task_id
    FROM async_tasks t
    JOIN video_generations v ON v.task_id = t.id AND v.deleted_at IS NULL
    JOIN redraw_shots s ON s.video_generation_id = v.id AND s.deleted_at IS NULL
    WHERE t.type = 'redraw_shot' AND t.deleted_at IS NULL
      AND v.tenant_id = t.tenant_id AND v.user_id = t.user_id
      AND s.tenant_id = t.tenant_id AND s.user_id = t.user_id
      AND s.status = 'processing'
      AND (
        (t.status IN ('pending', 'processing') AND v.status = 'processing')
        OR (t.status = 'completed' AND v.status = 'completed')
        OR (t.status = 'failed' AND v.status = 'failed')
      )
      AND v.provider_task_id IS NOT NULL AND TRIM(v.provider_task_id) != ''${ownerClause}
    ORDER BY t.created_at ASC, t.id ASC
  `).all(...ownerParams);
  const rawConcurrency = Number(ctx.generationConcurrency ?? DEFAULT_GENERATION_CONCURRENCY);
  const concurrency = Number.isSafeInteger(rawConcurrency) && rawConcurrency > 0
    ? Math.min(rawConcurrency, 8)
    : DEFAULT_GENERATION_CONCURRENCY;
  return runBounded(rows, concurrency, async (row) => runShotGeneration({
    ...ctx,
    recoverExistingProvider: true,
    videoRecoveryProcessor: ctx.videoRecoveryProcessor
      ? ((database, logger, videoId) => ctx.videoRecoveryProcessor(database, logger, videoId))
      : ((database, logger, videoId) => waitForRecoveredVideo(database, logger, videoId, ctx)),
  }, row.task_id));
}

function markInterruptedShotGenerationsNeedsAttention(db, log, options = {}) {
  const timestamp = new Date().toISOString();
  let rows;
  try {
    rows = db.prepare(`
      SELECT t.id AS task_id, t.progress AS task_progress,
             s.id AS shot_id, s.version_id, s.tenant_id, s.user_id,
             v.id AS video_id, v.provider_task_id
      FROM async_tasks t
      JOIN redraw_shots s
        ON CAST(s.id AS TEXT) = CAST(t.resource_id AS TEXT)
        AND s.deleted_at IS NULL
        AND s.tenant_id = t.tenant_id
        AND s.user_id = t.user_id
      JOIN video_generations v
        ON v.task_id = t.id
        AND v.deleted_at IS NULL
        AND v.tenant_id = t.tenant_id
        AND v.user_id = t.user_id
        AND v.id = s.video_generation_id
      WHERE t.type = 'redraw_shot' AND t.deleted_at IS NULL
        AND (
          t.status IN ('pending', 'processing')
          OR (s.status = 'processing' AND t.status = 'completed' AND v.status = 'completed')
          OR (s.status = 'processing' AND t.status = 'failed' AND v.status = 'failed')
        )
    `).all();
  } catch (error) {
    if (!/no such (table|column)/i.test(String(error.message || ''))) throw error;
    log?.warn?.('Skip redraw shot startup recovery for legacy schema', { error: error.message });
    return 0;
  }
  if (!rows.length) return 0;
  const interrupted = rows.filter((row) => !String(row.provider_task_id || '').trim());
  const recoverable = rows.filter((row) => String(row.provider_task_id || '').trim());
  db.transaction(() => {
    for (const row of interrupted) {
      db.prepare(`
        UPDATE async_tasks
        SET status = 'needs_attention',
            progress = CASE WHEN COALESCE(progress, 0) > 90 THEN progress ELSE 90 END,
            message = ?, error = ?, result = NULL, completed_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(INTERRUPTED_MESSAGE, INTERRUPTED_MESSAGE, timestamp, row.task_id);
      db.prepare(`
        UPDATE redraw_shots
        SET status = 'needs_attention', error_code = 'REDRAW_VIDEO_NEEDS_ATTENTION',
            error_message = ?, updated_at = ?
        WHERE id = ?
      `).run(INTERRUPTED_MESSAGE, timestamp, row.shot_id);
      db.prepare(`
        UPDATE video_generations
        SET status = 'needs_attention', error_msg = ?, updated_at = ?
        WHERE id = ?
      `).run(INTERRUPTED_MESSAGE, timestamp, row.video_id);
      setVersionGenerationStep(db, {
        tenantId: row.tenant_id,
        userId: row.user_id,
      }, row.version_id, timestamp);
    }
  })();
  if (interrupted.length) {
    log?.warn?.('Interrupted redraw shot generations marked needs_attention', { count: interrupted.length });
  }
  if (recoverable.length) {
    const schedule = options.schedule || ((callback) => setImmediate(callback));
    schedule(() => recoverInterruptedShotGenerations({
      db,
      log,
      ...(options.recoveryContext || {}),
    }).catch((error) => {
      log?.error?.('Recover redraw shot generations failed', { error: error.message });
    }));
    log?.info?.('Recoverable redraw shot generations scheduled', { count: recoverable.length });
  }
  return interrupted.length;
}

function isInside(parent, child) {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  const relative = path.relative(resolvedParent, resolvedChild);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveStorageRoot(ctx) {
  if (ctx.storageRoot) return path.resolve(ctx.storageRoot);
  const cfg = config.loadConfig();
  const storagePath = cfg.storage?.local_path || './data/storage';
  return path.isAbsolute(storagePath) ? storagePath : path.join(process.cwd(), storagePath);
}

async function defaultProbe(absPath, options = {}) {
  const { stdout } = await execFileAsync(getFfprobePath(), [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,width,height,channels,sample_rate:format=duration',
    '-of', 'json',
    absPath,
  ], {
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    killSignal: 'SIGKILL',
    windowsHide: true,
  });
  const parsed = JSON.parse(stdout);
  const videoStream = parsed.streams?.find((stream) => stream.codec_type === 'video') || {};
  const audioStream = parsed.streams?.find((stream) => stream.codec_type === 'audio') || null;
  const result = {
    duration: Number(parsed.format?.duration),
    width: Number(videoStream.width),
    height: Number(videoStream.height),
  };
  if (options.requireAudio) {
    result.hasAudio = !!audioStream && (
      Number(audioStream.channels) > 0
      || Number(audioStream.sample_rate) > 0
      || Number(audioStream.duration) > 0
    );
  }
  return result;
}

async function verifyVideoArtifact(ctx, videoGenerationId, options = {}) {
  const row = ctx.db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(videoGenerationId));
  const allowedStatuses = Array.isArray(options.allowedStatuses) && options.allowedStatuses.length
    ? new Set(options.allowedStatuses.map((status) => String(status)))
    : new Set(['completed']);
  if (!row || !allowedStatuses.has(String(row.status || '')) || !row.local_path) {
    throw codedError('REDRAW_VIDEO_ARTIFACT_INVALID', '视频成片记录不完整');
  }
  const storageRoot = resolveStorageRoot(ctx);
  const relativePath = String(row.local_path).replace(/^\/static\//, '').replace(/\\/g, '/');
  const absPath = path.resolve(storageRoot, relativePath);
  if (!isInside(storageRoot, absPath)) {
    throw codedError('REDRAW_VIDEO_ARTIFACT_INVALID', '视频成片路径越界');
  }
  let realStorageRoot;
  let realAbsPath;
  try {
    realStorageRoot = fs.realpathSync.native(storageRoot);
    fs.accessSync(absPath, fs.constants.R_OK);
    realAbsPath = fs.realpathSync.native(absPath);
  } catch (_) {
    throw codedError('REDRAW_VIDEO_ARTIFACT_INVALID', '视频成片文件不可读取');
  }
  if (!isInside(realStorageRoot, realAbsPath)) {
    throw codedError('REDRAW_VIDEO_ARTIFACT_INVALID', '视频成片路径越界');
  }
  const expectedSha256 = String(options.expectedSha256 || options.expected_sha256 || '').trim().toLowerCase();
  if (expectedSha256) {
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
      throw codedError('REDRAW_VIDEO_ARTIFACT_INVALID', '视频成片哈希证据无效');
    }
    let actualSha256;
    try {
      actualSha256 = await sha256File(realAbsPath);
    } catch (_) {
      throw codedError('REDRAW_VIDEO_ARTIFACT_INVALID', '视频成片文件不可读取');
    }
    if (actualSha256 !== expectedSha256) {
      throw codedError('REDRAW_VIDEO_ARTIFACT_INVALID', '视频成片哈希与审核候选不一致');
    }
  }
  const probe = ctx.probeRunner ? await ctx.probeRunner(absPath, row, options) : await defaultProbe(absPath, options);
  if (!(probe?.duration > 0 && probe?.width > 0 && probe?.height > 0)) {
    throw codedError('REDRAW_VIDEO_ARTIFACT_INVALID', '视频成片元数据无效');
  }
  if (options.requireAudio && probe.hasAudio !== true) {
    throw codedError('REDRAW_VIDEO_ARTIFACT_INVALID', '视频成片缺少可验证音轨');
  }
  return { duration: probe.duration, width: probe.width, height: probe.height };
}

module.exports = {
  generateShot,
  generateBatch,
  retryShot,
  recoverInterruptedShotGenerations,
  runShotGeneration,
  markInterruptedShotGenerationsNeedsAttention,
  verifyVideoArtifact,
  reviewNativeAudio,
  classifyVideoOutcome,
  resolveVerifiedGenerationModel,
  resolveVerifiedGenerationCapability,
  assertVideoConditioningCapability,
};
