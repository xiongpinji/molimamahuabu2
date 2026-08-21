const { readOwnedAuthorizationAsset } = require('./redrawAssetService');
const aiConfigService = require('./aiConfigService');

let defaultEvidenceRegistry = null;

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value || '');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function evidenceFromPayload(value) {
  const payload = parseJson(value, {});
  const snapshot = payload.snapshot && typeof payload.snapshot === 'object' ? payload.snapshot : {};
  return snapshot.voice_evidence || payload.voice_evidence || snapshot.evidence || payload.evidence || {};
}

function normalizeEvidence(input = {}) {
  const source = input.evidence && typeof input.evidence === 'object' ? input.evidence : input;
  return {
    source: String(source.source || ''),
    locale: String(source.locale || ''),
    market: String(source.market || ''),
    locale_pack: String(source.locale_pack || source.localePack || ''),
    audio_sha256: String(source.audio_sha256 || source.audioSha256 || ''),
    transcript_sha256: source.transcript_sha256 == null && source.transcriptSha256 == null
      ? null
      : String(source.transcript_sha256 ?? source.transcriptSha256),
    model_manifest_sha256: String(source.model_manifest_sha256 || source.modelManifestSha256 || ''),
    calibration_manifest_sha256: String(
      source.calibration_manifest_sha256 || source.calibrationManifestSha256 || '',
    ),
    asr_model_revision: String(source.asr_model_revision || source.asrModelRevision || source.asr_revision || ''),
    accent_model_revision: String(
      source.accent_model_revision || source.accentModelRevision || source.accent_revision || '',
    ),
    metrics: source.metrics && typeof source.metrics === 'object' && !Array.isArray(source.metrics)
      ? source.metrics
      : {},
    completed_at: String(source.completed_at || source.completedAt || ''),
    provider: String(source.provider || ''),
    model: String(source.model || ''),
    ai_service_config_id: Number(source.ai_service_config_id ?? source.aiServiceConfigId),
    config_updated_at: String(source.config_updated_at ?? source.configUpdatedAt ?? ''),
    voice_id: String(source.voice_id || source.voiceId || ''),
    task_id: String(source.task_id || source.taskId || ''),
    terminal_status: String(source.terminal_status || source.terminalStatus || '').toLowerCase(),
    audio_asset_id: Number(source.audio_asset_id ?? source.audioAssetId),
    duration_ms: Number(source.duration_ms ?? source.durationMs),
    real_generation_verified: source.real_generation_verified === true,
    language_verified: source.language_verified === true,
    detected_locale: source.detected_locale ? String(source.detected_locale) : null,
    is_cloned: source.is_cloned === true || source.cloned === true || source.voice_type === 'clone',
    authorization_asset_id: source.authorization_asset_id ?? source.authorizationAssetId ?? null,
  };
}

function isCompleted(status) {
  return ['completed', 'complete', 'succeeded', 'success', 'done'].includes(status);
}

function isHexSha256(value) {
  return /^[0-9a-f]{64}$/.test(String(value || ''));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isVerifiedEvidence(evidence) {
  return Boolean(
    evidence.source === 'offline-worker'
    && evidence.locale
    && evidence.market
    && evidence.locale_pack
    && isHexSha256(evidence.audio_sha256)
    && isHexSha256(evidence.transcript_sha256)
    && isHexSha256(evidence.model_manifest_sha256)
    && isHexSha256(evidence.calibration_manifest_sha256)
    && evidence.asr_model_revision
    && evidence.accent_model_revision
    && evidence.metrics
    && typeof evidence.metrics === 'object'
    && Object.keys(evidence.metrics).length > 0
    && evidence.completed_at
    && evidence.provider
    && evidence.model
    && Number.isSafeInteger(evidence.ai_service_config_id)
    && evidence.ai_service_config_id > 0
    && evidence.config_updated_at
    && evidence.voice_id
    && evidence.task_id
    && isCompleted(evidence.terminal_status)
    && Number.isInteger(evidence.audio_asset_id)
    && evidence.audio_asset_id > 0
    && Number.isFinite(evidence.duration_ms)
    && evidence.duration_ms > 0
    && evidence.real_generation_verified
    && evidence.language_verified
    && evidence.detected_locale === evidence.locale
  );
}

function evidenceRegistry(options = {}) {
  return options.localeRegistry || options.locale_registry
    || options.evidenceRegistry || options.evidence_registry
    || options.registry || defaultEvidenceRegistry;
}

function assertEvidenceTrusted(options, evidence) {
  const registry = evidenceRegistry(options);
  if (!registry || typeof registry.assertEvidenceTrusted !== 'function') {
    throw codedError('REDRAW_LOCALE_VERIFIER_NOT_READY', '语言验证 Worker 未就绪');
  }
  registry.assertEvidenceTrusted(evidence);
  return true;
}

function isTrustedEvidence(options, evidence) {
  try {
    return isVerifiedEvidence(evidence) && assertEvidenceTrusted(options, evidence);
  } catch (_) {
    return false;
  }
}

function hasExactActiveTtsConfig(db, evidence) {
  const config = aiConfigService.getConfig(db, evidence.ai_service_config_id);
  const models = Array.isArray(config?.model) ? config.model.map(String) : [];
  return Boolean(config
    && config.service_type === 'tts'
    && config.is_active
    && String(config.provider || '') === evidence.provider
    && (String(config.default_model || '') === evidence.model || models.includes(evidence.model))
    && String(config.updated_at || '') === evidence.config_updated_at);
}

function hasCloneAuthorization(evidence) {
  return !evidence.is_cloned || Boolean(evidence.authorization_asset_id);
}

function isAudioAsset(asset) {
  return Boolean(asset
    && asset.type === 'audio'
    && String(asset.mime_type || '').toLowerCase().startsWith('audio/'));
}

function hasReadableOwnedCloneAuthorization(db, evidence, owner, canReadAsset) {
  if (!evidence.is_cloned) return true;
  if (!hasCloneAuthorization(evidence) || typeof canReadAsset !== 'function') return false;
  const authorizationAsset = readOwnedAuthorizationAsset(db, {
    assetId: evidence.authorization_asset_id,
    versionId: owner.versionId,
    tenantId: owner.tenantId,
    userId: owner.userId,
  });
  return Boolean(authorizationAsset && canReadAsset(authorizationAsset) === true);
}

function assertLocaleVerifierReady(options, locale) {
  const verifier = options?.localeVerifier || options?.locale_verifier;
  if (!verifier || typeof verifier.assertReady !== 'function') {
    throw codedError('REDRAW_LOCALE_VERIFIER_NOT_READY', '语言验证 Worker 未就绪');
  }
  try {
    const pack = verifier.assertReady(locale);
    const normalized = pack && typeof pack === 'object' ? {
      locale_pack: String(pack.id || pack.locale_pack || ''),
      model_manifest_sha256: String(pack.model_manifest_sha256 || ''),
      calibration_manifest_sha256: String(pack.calibration_manifest_sha256 || ''),
    } : null;
    if (!normalized?.locale_pack || !normalized.model_manifest_sha256 || !normalized.calibration_manifest_sha256) {
      throw codedError('REDRAW_LOCALE_VERIFIER_NOT_READY', '语言验证 Worker 未就绪');
    }
    return normalized;
  } catch (error) {
    throw codedError('REDRAW_LOCALE_VERIFIER_NOT_READY', error.message || '语言验证 Worker 未就绪');
  }
}

function listProductionVoices(db, filters = {}, canReadAudio) {
  if (!db) throw codedError('REDRAW_VOICE_DB_REQUIRED', '缺少数据库');
  if (typeof canReadAudio !== 'function') return [];
  const tenantId = filters.tenantId ?? filters.tenant_id;
  const userId = filters.userId ?? filters.user_id;
  if (!tenantId || !userId) return [];
  const rows = db.prepare(`
    SELECT * FROM redraw_assets
    WHERE kind = 'voice' AND status = 'generated'
      AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    ORDER BY id ASC
  `).all(String(tenantId), String(userId));
  const result = [];
  for (const row of rows) {
    if (filters.versionId != null && Number(row.version_id) !== Number(filters.versionId)) continue;
    const payload = parseJson(row.source_ref_json);
    const evidence = normalizeEvidence(evidenceFromPayload(payload));
    if (!isTrustedEvidence(filters, evidence) || !hasCloneAuthorization(evidence)) continue;
    if (!hasExactActiveTtsConfig(db, evidence)) continue;
    if (Number(row.voice_asset_id) !== evidence.audio_asset_id || evidence.audio_asset_id <= 0) continue;
    if (filters.locale && evidence.locale !== String(filters.locale)) continue;
    if (filters.market && evidence.market !== String(filters.market)) continue;
    if (!hasReadableOwnedCloneAuthorization(db, evidence, {
      tenantId: String(row.tenant_id),
      userId: String(row.user_id),
      versionId: Number(row.version_id),
    }, canReadAudio)) continue;
    const asset = db.prepare(`
      SELECT * FROM assets
      WHERE id = ? AND type = 'audio' AND deleted_at IS NULL
    `).get(evidence.audio_asset_id);
    if (!isAudioAsset(asset) || canReadAudio(asset) !== true) continue;
    result.push({
      id: row.id,
      ...evidence,
      audio_asset: asset,
      audio_readable: true,
    });
  }
  return result;
}

function sameVoice(left, right) {
  return left.voice_id === right.voice_id
    && left.provider === right.provider
    && left.model === right.model
    && Number(left.ai_service_config_id) === Number(right.ai_service_config_id)
    && left.config_updated_at === right.config_updated_at
    && left.locale === right.locale
    && left.market === right.market
    && Number(left.audio_asset_id) === Number(right.audio_asset_id);
}

function sameEvidence(left, right) {
  return sameVoice(left, right)
    && left.source === right.source
    && left.locale_pack === right.locale_pack
    && left.audio_sha256 === right.audio_sha256
    && left.transcript_sha256 === right.transcript_sha256
    && left.model_manifest_sha256 === right.model_manifest_sha256
    && left.calibration_manifest_sha256 === right.calibration_manifest_sha256
    && left.asr_model_revision === right.asr_model_revision
    && left.accent_model_revision === right.accent_model_revision
    && stableJson(left.metrics) === stableJson(right.metrics)
    && left.completed_at === right.completed_at
    && left.task_id === right.task_id
    && left.terminal_status === right.terminal_status
    && Number(left.duration_ms) === Number(right.duration_ms)
    && left.real_generation_verified === right.real_generation_verified
    && left.language_verified === right.language_verified
    && left.detected_locale === right.detected_locale
    && left.is_cloned === right.is_cloned
    && Number(left.authorization_asset_id || 0) === Number(right.authorization_asset_id || 0);
}

function assignmentOwner(options = {}) {
  const tenantId = String(options.tenantId ?? options.tenant_id ?? '').trim();
  const userId = String(options.userId ?? options.user_id ?? '').trim();
  const versionId = Number(options.versionId ?? options.version_id);
  const voiceAssetId = Number(options.voiceAssetId ?? options.voice_asset_id);
  if (!tenantId || !userId || !Number.isSafeInteger(versionId) || versionId <= 0
    || !Number.isSafeInteger(voiceAssetId) || voiceAssetId <= 0) {
    throw codedError('REDRAW_VOICE_OWNER_REQUIRED', '音色绑定缺少租户、用户、版本或音色资产范围');
  }
  return { tenantId, userId, versionId, voiceAssetId };
}

function nextUpdatedAt(previous, clock) {
  const timestamp = typeof clock === 'function' ? String(clock()) : new Date().toISOString();
  if (timestamp !== previous) return timestamp;
  return new Date(new Date(previous).getTime() + 1).toISOString();
}

function assignVoice(db, assetId, verifiedVoice, options = {}) {
  if (!db) throw codedError('REDRAW_VOICE_DB_REQUIRED', '缺少数据库');
  const owner = assignmentOwner(options);
  const canReadAsset = options.canReadAsset || options.can_read_asset;
  const rawExpectedUpdatedAt = options.expectedUpdatedAt ?? options.expected_updated_at;
  const expectedUpdatedAt = rawExpectedUpdatedAt == null ? null : String(rawExpectedUpdatedAt);
  const requestedEvidence = normalizeEvidence(verifiedVoice);
  const row = db.prepare(`
    SELECT * FROM redraw_assets
    WHERE id = ? AND version_id = ? AND tenant_id = ? AND user_id = ?
      AND kind = 'character' AND deleted_at IS NULL
  `).get(Number(assetId), owner.versionId, owner.tenantId, owner.userId);
  if (!row) throw codedError('REDRAW_CHARACTER_ASSET_NOT_FOUND', '角色资产不存在');
  const guardUpdatedAt = expectedUpdatedAt === null ? String(row.updated_at || '') : expectedUpdatedAt;
  if (expectedUpdatedAt !== null && String(row.updated_at || '') !== expectedUpdatedAt) {
    throw codedError('REDRAW_VOICE_BIND_CONFLICT', '角色资产已被更新，请刷新后重试');
  }
  const version = db.prepare(`
    SELECT locale, market FROM redraw_versions
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(owner.versionId, owner.tenantId, owner.userId);
  if (!version) throw codedError('REDRAW_VERSION_NOT_FOUND', '本地化版本不存在');
  const voiceRow = db.prepare(`
    SELECT * FROM redraw_assets
    WHERE id = ? AND version_id = ? AND tenant_id = ? AND user_id = ?
      AND kind = 'voice' AND status = 'generated' AND deleted_at IS NULL
  `).get(owner.voiceAssetId, owner.versionId, owner.tenantId, owner.userId);
  if (!voiceRow) throw codedError('REDRAW_VOICE_ASSET_NOT_FOUND', '音色资产不存在');
  const evidence = normalizeEvidence(evidenceFromPayload(voiceRow.source_ref_json));
  if (!isTrustedEvidence(options, evidence) || !isTrustedEvidence(options, requestedEvidence)
    || !sameEvidence(evidence, requestedEvidence)
    || Number(voiceRow.voice_asset_id) !== evidence.audio_asset_id) {
    throw codedError('REDRAW_VOICE_NOT_VERIFIED', '音色缺少真实 TTS 或语言验证证据');
  }
  if (!hasExactActiveTtsConfig(db, evidence)) {
    throw codedError('REDRAW_VOICE_CONFIG_INVALID', '音色绑定的 TTS 配置已变更或停用');
  }
  if (!hasReadableOwnedCloneAuthorization(db, evidence, owner, canReadAsset)) {
    throw codedError('REDRAW_VOICE_AUTHORIZATION_REQUIRED', '克隆音色缺少当前用户可读的授权资产');
  }
  if (String(version.locale) !== evidence.locale || (version.market && String(version.market) !== evidence.market)) {
    throw codedError('REDRAW_VOICE_LOCALE_MISMATCH', '音色语言或地区与本地化版本不匹配');
  }
  const audioAsset = db.prepare(`
    SELECT * FROM assets WHERE id = ? AND type = 'audio' AND deleted_at IS NULL
  `).get(evidence.audio_asset_id);
  if (!isAudioAsset(audioAsset) || typeof canReadAsset !== 'function' || canReadAsset(audioAsset) !== true) {
    throw codedError('REDRAW_VOICE_AUDIO_NOT_FOUND', '音色样音资产不存在或不可读取');
  }

  const payload = parseJson(row.source_ref_json);
  const snapshotRoot = payload.snapshot && typeof payload.snapshot === 'object' ? payload.snapshot : {};
  const current = snapshotRoot.voice_snapshot ? normalizeEvidence(snapshotRoot.voice_snapshot) : null;
  if (current) {
    const conflict = !sameEvidence(current, evidence);
    if (!conflict) {
      const guarded = db.prepare(`
        UPDATE redraw_assets SET updated_at = updated_at
        WHERE id = ? AND version_id = ? AND tenant_id = ? AND user_id = ?
          AND kind = 'character' AND deleted_at IS NULL AND updated_at = ?
      `).run(Number(row.id), owner.versionId, owner.tenantId, owner.userId, guardUpdatedAt);
      if (guarded.changes !== 1) {
        throw codedError('REDRAW_VOICE_BIND_CONFLICT', '角色资产已被更新，请刷新后重试');
      }
    }
    return {
      conflict,
      snapshot: snapshotRoot.voice_snapshot,
      asset_id: Number(row.id),
    };
  }
  const snapshot = {
    locale: evidence.locale,
    market: evidence.market,
    source: evidence.source,
    locale_pack: evidence.locale_pack,
    audio_sha256: evidence.audio_sha256,
    transcript_sha256: evidence.transcript_sha256,
    model_manifest_sha256: evidence.model_manifest_sha256,
    calibration_manifest_sha256: evidence.calibration_manifest_sha256,
    asr_model_revision: evidence.asr_model_revision,
    accent_model_revision: evidence.accent_model_revision,
    metrics: evidence.metrics,
    completed_at: evidence.completed_at,
    provider: evidence.provider,
    model: evidence.model,
    ai_service_config_id: evidence.ai_service_config_id,
    config_updated_at: evidence.config_updated_at,
    voice_id: evidence.voice_id,
    task_id: evidence.task_id,
    terminal_status: evidence.terminal_status,
    audio_asset_id: evidence.audio_asset_id,
    duration_ms: evidence.duration_ms,
    real_generation_verified: true,
    language_verified: true,
    detected_locale: evidence.detected_locale,
    is_cloned: evidence.is_cloned,
    authorization_asset_id: evidence.authorization_asset_id,
  };
  const nextPayload = {
    ...payload,
    snapshot: {
      ...snapshotRoot,
      voice_snapshot: snapshot,
    },
  };
  const updatedAt = nextUpdatedAt(guardUpdatedAt, options.clock);
  const updated = db.prepare(`
    UPDATE redraw_assets
    SET voice_asset_id = ?, source_ref_json = ?, approval_status = 'pending', updated_at = ?
    WHERE id = ? AND version_id = ? AND tenant_id = ? AND user_id = ?
      AND kind = 'character' AND deleted_at IS NULL AND updated_at = ?
  `).run(
    evidence.audio_asset_id,
    JSON.stringify(nextPayload),
    updatedAt,
    Number(row.id),
    owner.versionId,
    owner.tenantId,
    owner.userId,
    guardUpdatedAt,
  );
  if (updated.changes !== 1) {
    throw codedError('REDRAW_VOICE_BIND_CONFLICT', '角色资产已被更新，请刷新后重试');
  }
  return { conflict: false, snapshot, asset_id: Number(row.id) };
}

function validateTtsBatch(db, versionId, turns = [], options = {}) {
  if (!db) throw codedError('REDRAW_VOICE_DB_REQUIRED', '缺少数据库');
  const tenantId = String(options.tenantId ?? options.tenant_id ?? '').trim();
  const userId = String(options.userId ?? options.user_id ?? '').trim();
  const artifactReader = options.canReadArtifact || options.can_read_artifact;
  const canReadAsset = typeof options.assetReader?.canRead === 'function'
    ? (asset) => options.assetReader.canRead(asset)
    : options.canReadAsset || options.can_read_asset || options.canReadAudioAsset || options.can_read_audio_asset
      || (typeof artifactReader === 'function' ? (asset) => artifactReader(asset?.id) : null);
  const version = db.prepare(`
    SELECT id, tenant_id, user_id, locale, market FROM redraw_versions
    WHERE id = ? AND deleted_at IS NULL
      AND (? = '' OR tenant_id = ?) AND (? = '' OR user_id = ?)
  `).get(Number(versionId), tenantId, tenantId, userId, userId);
  if (!version) throw codedError('REDRAW_VERSION_NOT_FOUND', '本地化版本不存在');
  const owner = {
    tenantId: String(version.tenant_id),
    userId: String(version.user_id),
    versionId: Number(version.id),
  };
  const characters = db.prepare(`
    SELECT * FROM redraw_assets
    WHERE version_id = ? AND tenant_id = ? AND user_id = ?
      AND kind = 'character' AND deleted_at IS NULL
    ORDER BY id ASC
  `).all(Number(version.id), owner.tenantId, owner.userId);
  const bySpeaker = new Map();
  for (const character of characters) {
    const payload = parseJson(character.source_ref_json);
    const speakerId = payload.source_ref?.character_id ?? payload.source_ref?.id;
    const voiceSnapshot = payload.snapshot?.voice_snapshot;
    if (speakerId != null && voiceSnapshot) {
      bySpeaker.set(String(speakerId), { character, snapshot: voiceSnapshot });
    }
  }

  const issues = [];
  const requests = [];
  let verifierPack = null;
  if (Object.prototype.hasOwnProperty.call(options, 'localeVerifier')
    || Object.prototype.hasOwnProperty.call(options, 'locale_verifier')) {
    try {
      verifierPack = assertLocaleVerifierReady(options, version.locale);
    } catch (error) {
      issues.push({
        turn_index: null,
        speaker_id: null,
        reason: 'locale_verifier_not_ready',
        code: error.code || 'REDRAW_LOCALE_VERIFIER_NOT_READY',
        message: error.message || '语言验证 Worker 未就绪',
      });
    }
  }
  for (const [index, turn] of turns.entries()) {
    const speakerId = String(turn?.speaker_id || '');
    const assigned = bySpeaker.get(speakerId);
    if (!assigned) {
      issues.push({ turn_index: index, speaker_id: speakerId, reason: 'speaker_voice_missing' });
      continue;
    }
    const evidence = normalizeEvidence(assigned.snapshot);
    if (!isTrustedEvidence(options, evidence)) {
      issues.push({ turn_index: index, speaker_id: speakerId, reason: 'voice_not_verified' });
      continue;
    }
    if (evidence.locale !== String(version.locale)
      || (version.market && evidence.market !== String(version.market))) {
      issues.push({ turn_index: index, speaker_id: speakerId, reason: 'voice_locale_mismatch' });
      continue;
    }
    if (!hasExactActiveTtsConfig(db, evidence)) {
      issues.push({ turn_index: index, speaker_id: speakerId, reason: 'voice_tts_config_invalid' });
      continue;
    }
    if (!hasReadableOwnedCloneAuthorization(db, evidence, owner, canReadAsset)) {
      issues.push({ turn_index: index, speaker_id: speakerId, reason: 'voice_authorization_missing' });
      continue;
    }
    const audioAsset = db.prepare(`
      SELECT * FROM assets WHERE id = ? AND type = 'audio' AND deleted_at IS NULL
    `).get(evidence.audio_asset_id);
    if (!isAudioAsset(audioAsset) || typeof canReadAsset !== 'function' || canReadAsset(audioAsset) !== true) {
      issues.push({ turn_index: index, speaker_id: speakerId, reason: 'voice_audio_missing' });
      continue;
    }
    const availableMs = Number(turn?.end_ms) - Number(turn?.start_ms);
    const durationMs = Number(turn?.audio_duration_ms ?? turn?.estimated_duration_ms);
    if (!Number.isFinite(availableMs) || availableMs <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) {
      issues.push({ turn_index: index, speaker_id: speakerId, reason: 'dialogue_duration_invalid' });
      continue;
    }
    if (durationMs > availableMs) {
      issues.push({
        turn_index: index,
        speaker_id: speakerId,
        reason: 'dialogue_duration_exceeded',
        duration_ms: durationMs,
        available_ms: availableMs,
      });
      continue;
    }
    requests.push({
      turn_index: index,
      speaker_id: speakerId,
      character_asset_id: Number(assigned.character.id),
      voice_id: evidence.voice_id,
      model: evidence.model,
      provider: evidence.provider,
      text: String(turn?.localized_text || turn?.text || ''),
      start_ms: Number(turn.start_ms),
      end_ms: Number(turn.end_ms),
      expected_duration_ms: durationMs,
      voice_snapshot: assigned.snapshot,
      locale_pack: verifierPack?.locale_pack || evidence.locale_pack,
      model_manifest_sha256: verifierPack?.model_manifest_sha256 || evidence.model_manifest_sha256,
      calibration_manifest_sha256: verifierPack?.calibration_manifest_sha256 || evidence.calibration_manifest_sha256,
    });
  }
  return {
    ok: issues.length === 0,
    status: issues.length === 0 ? 'ready' : 'needs_rewrite',
    issues,
    requests: issues.length === 0 ? requests : [],
  };
}

module.exports = {
  assignVoice,
  evidenceFromPayload,
  listProductionVoices,
  setDefaultEvidenceRegistry(registry) {
    defaultEvidenceRegistry = registry || null;
  },
  validateTtsBatch,
};
