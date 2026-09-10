'use strict';

const { createHash } = require('node:crypto');
const { stableStringify } = require('./redrawEpisodeFactsService');
const { assertBlueprintLockable } = require('./redrawEpisodeBlueprintService');
const localizationService = require('./localizationService');
const { resolveBlueprintDialogueSources } = require('./redrawSourceDialogueService');
const { validateGenerationEvidence, validateNativeDialogueAudioEvidence } = require('./redrawCapabilityService');
const { hasTrustedEvidenceBinding } = require('./externalModelEvidenceService');
const { FUMIN_MODELS, FUMIN_VIDEO_LIMITS } = require('./fuminVideoClient');
const { TOAPIS_VIDEO_MODELS } = require('./toapisVideoClient');
const { FEITUO_MODELS } = require('./feituoVideoClient');
const { buildExecutionPlan } = require('./redrawExecutionPlanService');

const hash = (value) => createHash('sha256').update(stableStringify(value)).digest('hex');
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
function parse(value, fallback = {}) {
  try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; } catch { return fallback; }
}

// Do not reuse the catalog/config loaders: some read credentials or write availability events.
function planningRows(db, selectedId) {
  const statement = db.prepare(`SELECT id, service_type, provider, api_protocol, model, default_model,
    updated_at, verification_status, verified_capabilities,
    CASE WHEN json_valid(settings) THEN COALESCE(json_extract(settings, '$.redraw_locale_capabilities'),
      json_extract(settings, '$.redrawLocaleCapabilities'), '[]') ELSE '[]' END AS locale_capabilities,
    CASE WHEN json_valid(settings) THEN json_extract(settings, '$.real_generation_verified_models')
      ELSE NULL END AS real_generation_verified_models
    FROM ai_service_configs WHERE is_active = 1 AND deleted_at IS NULL
      AND COALESCE(canary_paused, 0) = 0${selectedId === undefined ? '' : ' AND id = ?'} ORDER BY id ASC`);
  return selectedId === undefined ? statement.all() : statement.all(selectedId);
}

function entries(row, target) {
  const values = parse(row.locale_capabilities, []);
  return Array.isArray(values) ? values.filter((entry) => object(entry) && entry.status === 'verified'
    && entry.locale === target.locale && entry.market === target.market) : [];
}

function configured(row, model) {
  const models = parse(row.model, row.model);
  return typeof model === 'string' && (row.default_model === model
    || (Array.isArray(models) ? models.includes(model) : models === model));
}

function evidenceFor(entry, kind) {
  return parse(entry.evidence?.[kind] || entry[`${kind}_evidence_json`] || entry[`${kind}_evidence`]);
}

function boundEvidence(row, evidence, canReadArtifact) {
  return validateGenerationEvidence(evidence, canReadArtifact)
    && evidence.config_id === row.id && evidence.config_updated_at === row.updated_at
    && evidence.provider === row.provider && configured(row, evidence.model);
}

function adapter(row, model) {
  if (row.api_protocol === 'fumin_video' && ['fumin', 'fumin_video'].includes(row.provider)
    && FUMIN_MODELS[model]) return {
    durations: Array.from({ length: FUMIN_VIDEO_LIMITS.maxDuration - FUMIN_VIDEO_LIMITS.minDuration + 1 },
      (_, index) => index + FUMIN_VIDEO_LIMITS.minDuration), resolutions: ['480p'], aspectRatios: ['16:9', '9:16'],
    maxReferences: FUMIN_VIDEO_LIMITS.maxImageReferences,
    maxVideoReferences: FUMIN_VIDEO_LIMITS.maxVideoReferences, maxAudioReferences: FUMIN_VIDEO_LIMITS.maxAudioReferences,
    supportsAudio: true,
  };
  if (row.api_protocol === 'toapis_video' && row.provider === 'toapis') return TOAPIS_VIDEO_MODELS[model];
  if (row.api_protocol === 'feituo_open' && row.provider === 'feituo' && model.startsWith('xuan-')) {
    const spec = FEITUO_MODELS[model];
    return spec && { ...spec, aspectRatios: spec.ratios, maxReferences: spec.maxImages,
      maxVideoReferences: spec.maxVideos, maxAudioReferences: spec.maxAudio };
  }
  return null;
}

function intersect(values, allowed) {
  return Array.isArray(values) && Array.isArray(allowed)
    ? [...new Set(values.filter((value) => allowed.includes(value)))].sort((a, b) => typeof a === 'number' ? a - b : a.localeCompare(b))
    : [];
}

function nativeAudioCapability(videoRow, model, target, canReadArtifact, evidenceHash) {
  const language = target.locale.split('-')[0].toLowerCase();
  for (const entry of entries(videoRow, { locale: language, market: '' })) {
    const native = evidenceFor(entry, 'native_dialogue_audio');
    if ((!evidenceHash || hash(native) === evidenceHash) && native.model === model
      && validateNativeDialogueAudioEvidence(native, canReadArtifact, videoRow, entry)) {
      return { mode: 'native', language, locale_verified: false, evidence_hash: hash(native) };
    }
  }
  return null;
}

function replaceAudioCapability(row, target, canReadArtifact, evidenceHash) {
  if (!['tts', 'audio'].includes(row.service_type) || row.verification_status !== 'verified') return null;
  for (const entry of entries(row, target)) {
    const evidence = evidenceFor(entry, 'tts');
    if ((!evidenceHash || hash(evidence) === evidenceHash) && boundEvidence(row, evidence, canReadArtifact)) return {
      capability: { mode: 'replace', locale_verified: Boolean(target.market),
        config_id: row.id, config_updated_at: row.updated_at, evidence_hash: hash(evidence) },
      identity: { config_id: row.id, config_updated_at: row.updated_at, provider: evidence.provider,
        model: evidence.model, service_type: row.service_type },
    };
  }
  return null;
}

function audioCapability(rows, videoRow, model, target, canReadArtifact, spoken) {
  if (!spoken) return { mode: 'not_required', locale_verified: false };
  const native = nativeAudioCapability(videoRow, model, target, canReadArtifact);
  if (native) return native;
  for (const row of rows) {
    const audio = replaceAudioCapability(row, target, canReadArtifact);
    if (audio) return audio.capability;
  }
  return null;
}

function planningCapability(ctx, row, evidence, target, resolveAudio, block) {
  if (!boundEvidence(row, evidence, ctx.canReadArtifact)) return null;
  const model = evidence.model;
  if (row.api_protocol === 'toapis_wan3_video') { block('CREDENTIAL_BINDING_NOT_CHECKED'); return null; }
  const spec = adapter(row, model);
  if (!spec) { block('ADAPTER_PLANNING_CAPABILITY_UNAVAILABLE'); return null; }
  if (row.api_protocol === 'feituo_open') {
    const verifiedModels = parse(row.real_generation_verified_models, []);
    if (!Array.isArray(verifiedModels) || !verifiedModels.includes(model)) {
      block('CAPABILITY_PARAMETERS_UNVERIFIED'); return null;
    }
  }
  const caps = parse(row.verified_capabilities)[model];
  if (!object(caps)) { block('CAPABILITY_PARAMETERS_UNVERIFIED'); return null; }
  if (!hasTrustedEvidenceBinding(model, caps, ctx.externalModelEvidenceRoots, row)) {
    block('EXTERNAL_CAPABILITY_EVIDENCE_UNTRUSTED'); return null;
  }
  const durations = intersect(caps.durations, spec.durations).filter((value) => Number.isSafeInteger(value) && value > 0);
  const resolutions = intersect(caps.resolutions, spec.resolutions);
  const ratios = intersect(caps.aspectRatios, spec.aspectRatios);
  const max = { image: caps.maxImageReferences ?? caps.maxReferences,
    video: caps.maxVideoReferences, audio: caps.maxAudioReferences };
  if (!durations.length || !resolutions.length || !ratios.length
    || Object.values(max).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    block('CAPABILITY_PARAMETERS_UNVERIFIED'); return null;
  }
  const audio = resolveAudio(model);
  if (!audio || (audio.mode === 'native' && (caps.supportsAudio !== true || spec.supportsAudio !== true))) {
    block('AUDIO_CAPABILITY_UNAVAILABLE'); return null;
  }
  const capability = { config_id: row.id, config_updated_at: row.updated_at, provider: row.provider,
    protocol: row.api_protocol, model, durations_ms: durations.map((value) => value * 1000), resolutions,
    aspect_ratios: ratios, max_references: {
      image: caps.supportsImageReference === true ? Math.min(max.image, spec.maxReferences) : 0,
      video: caps.supportsVideoReference === true ? Math.min(max.video, spec.maxVideoReferences) : 0,
      audio: caps.supportsAudioReference === true ? Math.min(max.audio, spec.maxAudioReferences) : 0,
    }, audio_mode: audio.mode, audio_verification: audio,
    locale: target.locale, market: target.market, credential_readiness: 'not_checked',
    evidence_hash: hash({ video: evidence, parameters: caps }), adapter_hash: hash(spec) };
  capability.capability_hash = hash(capability);
  return capability;
}

function planningCapabilities(ctx, target, spoken) {
  const rows = planningRows(ctx.db); const valid = []; const blockers = [];
  for (const row of rows) {
    if (row.service_type !== 'video' || row.verification_status !== 'verified') continue;
    for (const entry of entries(row, target)) {
      const evidence = evidenceFor(entry, 'video');
      const block = (code) => blockers.push({ code, config_id: row.id });
      const capability = planningCapability(ctx, row, evidence, target,
        (model) => audioCapability(rows, row, model, target, ctx.canReadArtifact, spoken), block);
      if (capability) valid.push(capability);
    }
  }
  return { valid, blockers: blockers.length ? blockers : [{ code: 'VIDEO_CAPABILITY_UNAVAILABLE' }] };
}

// Internal selected-plan consumer. This never enumerates candidates or reads connections.
function inspectSelectedCapabilityMetadata(ctx, selected) {
  if (!object(selected) || !sha(selected.capability_hash) || !Number.isSafeInteger(selected.config_id)
    || selected.config_id <= 0 || typeof selected.locale !== 'string' || !selected.locale
    || typeof selected.market !== 'string' || !object(selected.audio_verification)) fail('SELECTED_CAPABILITY_INVALID');
  const { capability_hash: selectedHash, ...body } = selected;
  if (hash(body) !== selectedHash) fail('SELECTED_CAPABILITY_INVALID');
  if (selected.protocol === 'toapis_wan3_video') fail('CREDENTIAL_BINDING_NOT_CHECKED');
  const row = planningRows(ctx.db, selected.config_id)[0];
  if (!row || row.service_type !== 'video' || row.verification_status !== 'verified') fail('SELECTED_CAPABILITY_STALE');
  // The actual submitter preserves a requested model only when it is in config.model.
  const models = parse(row.model, row.model);
  if (!(Array.isArray(models) ? models : [models]).includes(selected.model)) fail('SELECTED_CAPABILITY_STALE');
  const target = { locale: selected.locale, market: selected.market };
  let audio; let audioIdentity = null;
  if (selected.audio_mode === 'not_required') audio = { mode: 'not_required', locale_verified: false };
  else if (selected.audio_mode === 'native') {
    audio = nativeAudioCapability(row, selected.model, target, ctx.canReadArtifact, selected.audio_verification.evidence_hash);
  } else if (selected.audio_mode === 'replace') {
    const id = selected.audio_verification.config_id;
    if (!Number.isSafeInteger(id) || id <= 0) fail('SELECTED_CAPABILITY_INVALID');
    const audioRow = planningRows(ctx.db, id)[0];
    const recovered = audioRow && replaceAudioCapability(audioRow, target, ctx.canReadArtifact, selected.audio_verification.evidence_hash);
    audio = recovered?.capability; audioIdentity = recovered?.identity;
  } else fail('SELECTED_CAPABILITY_INVALID');
  if (!audio) fail('SELECTED_CAPABILITY_STALE');
  for (const entry of entries(row, target)) {
    const evidence = evidenceFor(entry, 'video');
    if (evidence.model !== selected.model) continue;
    const capability = planningCapability(ctx, row, evidence, target, () => audio, () => {});
    if (capability?.capability_hash === selectedHash) return { capability, audio_identity: audioIdentity };
  }
  fail('SELECTED_CAPABILITY_STALE');
}

function envelope(value) {
  const result = { ...value, executable: false, reference_readiness: 'not_checked',
    source_media_readiness: 'not_checked',
    parameter_evidence_scope: 'approved_envelope_not_exhaustive_tuples',
    reference_semantics: 'logical_requirements_not_assets',
    execution_blockers: ['PREVIEW_ONLY', 'SOURCE_MEDIA_NOT_RECHECKED', 'REFERENCE_ASSETS_NOT_VERIFIED',
      'CREDENTIAL_READINESS_NOT_CHECKED', 'DYNAMIC_EXECUTOR_NOT_CONNECTED',
      ...(value.capability?.audio_mode === 'native' && value.bindings?.market
        ? ['TARGET_REGION_AUDIO_NOT_VERIFIED'] : [])],
  };
  result.units = result.units.map(({ required_references, ...unit }) => ({ ...unit,
    reference_requirements: required_references.map(({ sha256, ...requirement }) => ({
      ...requirement, requirement_hash: sha256,
    })),
  }));
  delete result.plan_hash;
  result.plan_hash = hash(result);
  return result;
}

function previewVersionExecutionPlan(ctx, versionId) {
  let bindings = { version_id: Number(versionId) }; let capability = null;
  const blocked = (reasons) => envelope({ schema_version: 'redraw-execution-plan-preview-v1', status: 'blocked',
    bindings, capability, units: [], blocking_reasons: reasons });
  try {
    if (!Number.isSafeInteger(Number(versionId)) || Number(versionId) <= 0 || !ctx.tenantId || !ctx.userId) {
      fail('REDRAW_VERSION_NOT_FOUND');
    }
    const version = ctx.db.prepare(`SELECT v.* FROM redraw_versions v JOIN redraw_works w ON w.id = v.work_id
      AND w.tenant_id = v.tenant_id AND w.user_id = v.user_id WHERE v.id = ? AND v.tenant_id = ?
      AND v.user_id = ? AND v.deleted_at IS NULL AND w.deleted_at IS NULL`).get(versionId, ctx.tenantId, ctx.userId);
    if (!version) fail('REDRAW_VERSION_NOT_FOUND');
    const work = ctx.db.prepare(`SELECT id, source_asset_id, source_fingerprint, duration_ms FROM redraw_works
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL`)
      .get(version.work_id, ctx.tenantId, ctx.userId);
    const review = localizationService.getLocalizationReview(ctx.db, ctx, versionId);
    const row = ctx.db.prepare(`SELECT blueprint_json, blueprint_hash, revision, status FROM redraw_episode_blueprints
      WHERE work_id = ? AND tenant_id = ? AND user_id = ? AND revision = ? ORDER BY id DESC LIMIT 1`)
      .get(work.id, ctx.tenantId, ctx.userId, version.version);
    const blueprint = parse(row?.blueprint_json); const localization = review.localization;
    try { assertBlueprintLockable(blueprint); } catch { fail('BLUEPRINT_HASH_MISMATCH'); }
    if (row.status !== 'locked'
      || row.blueprint_hash !== blueprint.blueprint_hash || version.blueprint_hash !== blueprint.blueprint_hash) fail('BLUEPRINT_HASH_MISMATCH');
    if (String(blueprint.source.asset_id) !== String(work.source_asset_id)
      || blueprint.source.sha256 !== work.source_fingerprint || blueprint.source.duration_ms !== work.duration_ms) fail('SOURCE_BINDING_MISMATCH');
    if (!sha(version.localization_hash) || localization.localization_hash !== version.localization_hash
      || localizationService.episodeLocalizationHash(localization) !== version.localization_hash
      || localization.blueprint_hash !== blueprint.blueprint_hash) fail('LOCALIZATION_HASH_MISMATCH');
    localizationService.assertSafeLocalizationReviewValue(localization);
    if (!['review', 'locked'].includes(localization.review?.status) || !localization.locale || !localization.market) fail('LOCALIZATION_REVIEW_INVALID');
    const sources = resolveBlueprintDialogueSources(ctx, { workId: work.id, blueprint });
    bindings = { tenant_id: ctx.tenantId, user_id: ctx.userId, work_id: work.id, version_id: version.id,
      source_asset_id: work.source_asset_id, source_sha256: work.source_fingerprint,
      blueprint_revision: row.revision, blueprint_hash: row.blueprint_hash,
      localization_hash: version.localization_hash, localization_review_status: localization.review.status,
      localization_updated_at: review.updated_at, version_updated_at: version.updated_at,
      locale: localization.locale, market: localization.market, source_dialogue_hash: hash(sources) };
    if (sources.some((item) => item.status !== 'resolved')) return blocked([{ code: 'SOURCE_DIALOGUE_UNRESOLVED' }]);
    if (!Array.isArray(localization.dialogue_map) || localization.dialogue_map.length !== sources.length) fail('LOCALIZATION_DIALOGUE_COVERAGE_INVALID');
    const mapping = new Map(localization.dialogue_map.map((item) => [item.source_dialogue_id, item]));
    if (mapping.size !== sources.length) fail('LOCALIZATION_DIALOGUE_COVERAGE_INVALID');
    const dialogues = sources.map((item) => {
      const target = mapping.get(item.dialogue_id);
      if (!target || target.shot_id !== item.shot_id || typeof target.target_text !== 'string' || !target.target_text.trim()) fail('LOCALIZATION_DIALOGUE_COVERAGE_INVALID');
      return { id: item.dialogue_id, start_ms: item.source_start_ms, end_ms: item.source_end_ms,
        source_text: item.source_text, target_text: target.target_text,
        evidence_ref: item.evidence_ref, evidence_sha256: item.evidence_sha256,
        estimated_duration_ms: target.estimated_duration_ms };
    });
    // Logical requirements allow preview before localization lock/asset preparation. These are NOT asset hashes.
    const characters = new Map(blueprint.characters.map((item) => [item.id, item]));
    const parentShots = blueprint.shots.map((shot) => ({ id: shot.id, start_ms: shot.start_ms, end_ms: shot.end_ms,
      contract_hash: hash({ shot, localization_hash: version.localization_hash }),
      required_references: [...shot.visible_character_ids.map((id) => ({ id: `identity-${id}`, kind: 'image',
        sha256: hash({ character: characters.get(id), target_name: localization.character_name_map?.[id] || '' }) })),
      { id: `motion-${shot.id}`, kind: 'video', sha256: hash({ source: blueprint.source, start_ms: shot.start_ms, end_ms: shot.end_ms }) }] }));
    bindings.reference_requirements_hash = hash(parentShots.map((shot) => shot.required_references));
    const candidates = planningCapabilities(ctx, localization, dialogues.length > 0);
    if (!candidates.valid.length) return blocked(candidates.blockers);
    let firstBlocked;
    for (const candidate of candidates.valid) {
      capability = candidate;
      const planned = buildExecutionPlan({ duration_ms: work.duration_ms, parent_shots: parentShots,
        dialogues, capability, bindings: { ...bindings, capability_hash: capability.capability_hash } });
      if (planned.status === 'ready') return envelope(planned);
      firstBlocked ??= planned;
    }
    return envelope(firstBlocked);
  } catch (error) {
    const known = new Set(['REDRAW_VERSION_NOT_FOUND', 'BLUEPRINT_NOT_LOCKED', 'BLUEPRINT_HASH_MISMATCH',
      'LOCALIZATION_NOT_FOUND', 'LOCALIZATION_HASH_MISMATCH', 'SOURCE_BINDING_MISMATCH',
      'LOCALIZATION_INPUT_INVALID', 'LOCALIZATION_REVIEW_INVALID', 'LOCALIZATION_DIALOGUE_COVERAGE_INVALID']);
    return blocked([{ code: known.has(error.code) ? error.code : 'EXECUTION_PLAN_PREVIEW_INVALID' }]);
  }
}

module.exports = { previewVersionExecutionPlan, inspectSelectedCapabilityMetadata };
