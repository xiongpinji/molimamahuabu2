const crypto = require('node:crypto');

const { readOwnedAuthorizationAsset } = require('./redrawAssetService');
const aiConfigService = require('./aiConfigService');
const {
  CONTRACT_VERSION: SUPPLEMENTAL_DIALOGUE_CONTRACT,
  publicSupplementalDialogueApproval,
} = require('./redrawSupplementalDialogueApprovalService');

let defaultEvidenceRegistry = null;

const PROVIDER_EVIDENCE_SOURCE = 'offline-worker';
const LOCAL_EVIDENCE_SOURCE = 'local_offline_tts';
const LOCAL_EVIDENCE_CONTRACT = 'local-offline-tts-v1';
const APPROVED_DIALOGUE_CONTRACT = 'redraw-approved-dialogue-evidence-v1';
const LOCAL_REQUIRED_KEYS = [
  'approved_text_sha256',
  'audio_asset_id',
  'audio_sha256',
  'binary_sha256',
  'calibration_manifest_sha256',
  'completed_at',
  'contract_version',
  'detected_locale',
  'duration_ms',
  'engine',
  'engine_version',
  'language_verified',
  'locale',
  'locale_pack',
  'manifest_sha256',
  'market',
  'metrics',
  'model_manifest_sha256',
  'profile',
  'registration_id',
  'registration_status',
  'source',
  'source_character_key',
  'tenant_id',
  'transcript_sha256',
  'user_id',
  'version_id',
  'voice_redraw_asset_id',
];
const LOCAL_DERIVED_KEYS = [
  'local_offline_verified',
  'provider_verified',
  'verification_source',
];
const LOCAL_SUPPLEMENTAL_KEYS = [
  'approved_dialogue_contract_version',
  'approved_dialogue_evidence_sha256',
  'source_translation',
  'supplemental_dialogue_approval_ids',
  'supplemental_dialogue_approvals',
];
const LOCAL_SUPPLEMENTAL_APPROVAL_KEYS = [
  'approval_evidence_sha256',
  'approval_id',
  'target_text_sha256',
];
const PROVIDER_FORBIDDEN_LOCAL_KEYS = [
  ...LOCAL_SUPPLEMENTAL_KEYS,
  'approved_text_sha256',
  'binary_sha256',
  'contract_version',
  'engine',
  'engine_version',
  'manifest_sha256',
  'profile',
  'registration_id',
  'registration_status',
  'source_character_key',
  'tenant_id',
  'test_only',
  'user_id',
  'version_id',
  'voice_redraw_asset_id',
];

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

function speakerKey(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
}

function firstSpeakerKey(...candidates) {
  for (const candidate of candidates) {
    const key = speakerKey(candidate);
    if (key) return key;
  }
  return null;
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
    contract_version: String(source.contract_version || ''),
    tenant_id: String(source.tenant_id || ''),
    user_id: String(source.user_id || ''),
    version_id: Number(source.version_id),
    voice_redraw_asset_id: Number(source.voice_redraw_asset_id),
    source_character_key: String(source.source_character_key || ''),
    profile: String(source.profile || ''),
    engine: String(source.engine || ''),
    engine_version: String(source.engine_version || ''),
    binary_sha256: String(source.binary_sha256 || ''),
    manifest_sha256: String(source.manifest_sha256 || ''),
    approved_text_sha256: String(source.approved_text_sha256 || ''),
    registration_id: Number(source.registration_id),
    registration_status: String(source.registration_status || ''),
    approved_dialogue_contract_version: source.approved_dialogue_contract_version == null
      ? null
      : String(source.approved_dialogue_contract_version),
    approved_dialogue_evidence_sha256: source.approved_dialogue_evidence_sha256 == null
      ? null
      : String(source.approved_dialogue_evidence_sha256),
    supplemental_dialogue_approval_ids: Array.isArray(source.supplemental_dialogue_approval_ids)
      ? source.supplemental_dialogue_approval_ids.map(Number)
      : null,
    supplemental_dialogue_approvals: Array.isArray(source.supplemental_dialogue_approvals)
      ? source.supplemental_dialogue_approvals.map((approval) => ({
        approval_id: Number(approval?.approval_id),
        approval_evidence_sha256: String(approval?.approval_evidence_sha256 || ''),
        target_text_sha256: String(approval?.target_text_sha256 || ''),
      }))
      : null,
    source_translation: source.source_translation,
    test_only: source.test_only === true,
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

function isVerifiedProviderEvidence(evidence) {
  return Boolean(
    evidence.source === PROVIDER_EVIDENCE_SOURCE
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

function stableHash(value) {
  return crypto.createHash('sha256').update(Buffer.from(stableJson(value), 'utf8')).digest('hex');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactLocalKeys(rawEvidence) {
  if (!isPlainObject(rawEvidence)) return false;
  const allowed = [...LOCAL_REQUIRED_KEYS];
  const hasSupplemental = LOCAL_SUPPLEMENTAL_KEYS.some((key) => Object.hasOwn(rawEvidence, key));
  if (hasSupplemental) allowed.push(...LOCAL_SUPPLEMENTAL_KEYS);
  const hasDerived = LOCAL_DERIVED_KEYS.some((key) => Object.hasOwn(rawEvidence, key));
  if (hasDerived) allowed.push(...LOCAL_DERIVED_KEYS);
  if (Object.hasOwn(rawEvidence, 'test_only')) allowed.push('test_only');
  const actual = Object.keys(rawEvidence).sort();
  const expected = allowed.sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isCompleteSupplementalEvidence(rawEvidence, evidence) {
  const hasSupplemental = LOCAL_SUPPLEMENTAL_KEYS.some((key) => Object.hasOwn(rawEvidence, key));
  if (!hasSupplemental) return true;
  if (!LOCAL_SUPPLEMENTAL_KEYS.every((key) => Object.hasOwn(rawEvidence, key))
    || evidence.approved_dialogue_contract_version !== APPROVED_DIALOGUE_CONTRACT
    || !isHexSha256(evidence.approved_dialogue_evidence_sha256)
    || rawEvidence.source_translation !== false
    || !Array.isArray(rawEvidence.supplemental_dialogue_approval_ids)
    || !Array.isArray(rawEvidence.supplemental_dialogue_approvals)
    || !Array.isArray(evidence.supplemental_dialogue_approval_ids)
    || !Array.isArray(evidence.supplemental_dialogue_approvals)
    || evidence.supplemental_dialogue_approval_ids.length === 0
    || evidence.supplemental_dialogue_approval_ids.length
      !== evidence.supplemental_dialogue_approvals.length) {
    return false;
  }
  const ids = evidence.supplemental_dialogue_approval_ids;
  if (rawEvidence.supplemental_dialogue_approval_ids
    .some((id) => !Number.isSafeInteger(id) || id <= 0)
    || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
    || new Set(ids).size !== ids.length) {
    return false;
  }
  return rawEvidence.supplemental_dialogue_approvals.every((approval, index) => {
    if (!isPlainObject(approval)) return false;
    const actual = Object.keys(approval).sort();
    const expected = [...LOCAL_SUPPLEMENTAL_APPROVAL_KEYS].sort();
    const normalized = evidence.supplemental_dialogue_approvals[index];
    return actual.length === expected.length
      && actual.every((key, keyIndex) => key === expected[keyIndex])
      && Number.isSafeInteger(approval.approval_id)
      && approval.approval_id > 0
      && normalized.approval_id === ids[index]
      && isHexSha256(normalized.approval_evidence_sha256)
      && isHexSha256(normalized.target_text_sha256);
  });
}

function isCompleteLocalEvidence(rawEvidence, evidence, options = {}) {
  const hasDerived = LOCAL_DERIVED_KEYS.some((key) => Object.hasOwn(rawEvidence, key));
  return Boolean(
    hasExactLocalKeys(rawEvidence)
    && isCompleteSupplementalEvidence(rawEvidence, evidence)
    && evidence.source === LOCAL_EVIDENCE_SOURCE
    && evidence.contract_version === LOCAL_EVIDENCE_CONTRACT
    && evidence.tenant_id
    && evidence.user_id
    && Number.isSafeInteger(evidence.version_id)
    && evidence.version_id > 0
    && Number.isSafeInteger(evidence.voice_redraw_asset_id)
    && evidence.voice_redraw_asset_id > 0
    && evidence.source_character_key
    && evidence.locale
    && evidence.market
    && evidence.profile
    && evidence.engine === 'eSpeak NG'
    && evidence.engine_version
    && isHexSha256(evidence.binary_sha256)
    && isHexSha256(evidence.manifest_sha256)
    && Number.isSafeInteger(evidence.audio_asset_id)
    && evidence.audio_asset_id > 0
    && isHexSha256(evidence.audio_sha256)
    && Number.isFinite(evidence.duration_ms)
    && evidence.duration_ms > 0
    && isHexSha256(evidence.approved_text_sha256)
    && evidence.locale_pack
    && isHexSha256(evidence.transcript_sha256)
    && isHexSha256(evidence.model_manifest_sha256)
    && isHexSha256(evidence.calibration_manifest_sha256)
    && isPlainObject(evidence.metrics)
    && Object.keys(evidence.metrics).length > 0
    && evidence.language_verified
    && evidence.detected_locale === evidence.locale
    && Number.isSafeInteger(evidence.registration_id)
    && evidence.registration_id > 0
    && evidence.registration_status === 'completed'
    && Number.isFinite(Date.parse(evidence.completed_at))
    && (!evidence.test_only || options.allowTestOnlyLocalEvidence === true)
    && (!hasDerived
      || (rawEvidence.verification_source === LOCAL_EVIDENCE_SOURCE
        && rawEvidence.provider_verified === false
        && rawEvidence.local_offline_verified === true))
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

function assertLocalLocaleEvidenceTrusted(options, evidence) {
  const registry = evidenceRegistry(options);
  if (!registry || typeof registry.assertReady !== 'function') {
    throw codedError('REDRAW_LOCALE_VERIFIER_NOT_READY', '语言验证 Worker 未就绪');
  }
  let pack;
  try {
    pack = registry.assertReady({
      packId: evidence.locale_pack,
      locale: evidence.locale,
      model_manifest_sha256: evidence.model_manifest_sha256,
      calibration_manifest_sha256: evidence.calibration_manifest_sha256,
    });
  } catch (_) {
    throw codedError('REDRAW_LOCALE_VERIFIER_NOT_READY', '语言验证 Worker 未就绪');
  }
  if (!pack
    || String(pack.id || pack.locale_pack || '') !== evidence.locale_pack
    || String(pack.locale || '') !== evidence.locale
    || String(pack.model_manifest_sha256 || '') !== evidence.model_manifest_sha256
    || String(pack.calibration_manifest_sha256 || '') !== evidence.calibration_manifest_sha256) {
    throw codedError('REDRAW_LOCALE_VERIFIER_NOT_READY', '语言验证 Worker 未就绪');
  }
}

function parseSupplementalApprovalIds(value) {
  try {
    const ids = JSON.parse(value);
    if (!Array.isArray(ids)
      || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
      || new Set(ids).size !== ids.length) {
      return null;
    }
    return ids;
  } catch (_) {
    return null;
  }
}

function readCurrentSupplementalApprovals(db, evidence) {
  const rows = db.prepare(`
    SELECT a.*
    FROM redraw_supplemental_dialogue_approvals a
    JOIN redraw_shots s
      ON s.id = a.redraw_shot_id AND s.version_id = a.version_id
     AND s.tenant_id = a.tenant_id AND s.user_id = a.user_id
     AND s.deleted_at IS NULL
    WHERE a.tenant_id = ? AND a.user_id = ? AND a.version_id = ?
      AND a.voice_redraw_asset_id = ? AND a.source_character_key = ?
      AND a.status = 'active' AND a.deleted_at IS NULL
    ORDER BY s.batch_index ASC, s.shot_index ASC, s.id ASC, a.id ASC
  `).all(
    evidence.tenant_id,
    evidence.user_id,
    evidence.version_id,
    evidence.voice_redraw_asset_id,
    evidence.source_character_key,
  );
  for (const row of rows) {
    try {
      const projection = publicSupplementalDialogueApproval(db, {
        approval: row,
        idempotentReplay: false,
      });
      if (projection.contract_version !== SUPPLEMENTAL_DIALOGUE_CONTRACT
        || projection.status !== 'active'
        || projection.source_translation !== false) {
        throw new Error('invalid supplemental approval projection');
      }
    } catch (_) {
      throw codedError('REDRAW_VOICE_NOT_VERIFIED', '音色缺少完整本地离线验证证据');
    }
  }
  return rows;
}

function recomputeApprovedDialogueEvidenceSha256(db, evidence, approvalRows) {
  const scope = db.prepare(`
    SELECT v.id, v.work_id, v.localization_task_id, v.facts_hash, v.locale, v.market,
           p.policy_version
    FROM redraw_versions v
    JOIN redraw_works w
      ON w.id = v.work_id AND w.tenant_id = v.tenant_id AND w.user_id = v.user_id
     AND w.deleted_at IS NULL
    JOIN redraw_projects p
      ON p.id = w.project_id AND p.tenant_id = v.tenant_id AND p.user_id = v.user_id
     AND p.deleted_at IS NULL
    WHERE v.id = ? AND v.tenant_id = ? AND v.user_id = ? AND v.deleted_at IS NULL
    LIMIT 1
  `).get(evidence.version_id, evidence.tenant_id, evidence.user_id);
  if (!scope
    || String(scope.locale || '') !== evidence.locale
    || String(scope.market || '') !== evidence.market) {
    throw codedError('REDRAW_VOICE_NOT_VERIFIED', '音色缺少完整本地离线验证证据');
  }
  const taskId = String(scope.localization_task_id || '');
  const task = db.prepare(`
    SELECT id, result, resource_id, completed_at
    FROM async_tasks
    WHERE id = ? AND type = 'redraw_localization' AND status = 'completed'
      AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    LIMIT 1
  `).get(taskId, evidence.tenant_id, evidence.user_id);
  const result = parseJson(task?.result, {});
  const decision = parseJson(result.localization_decision, {});
  if (!task
    || String(task.resource_id || '') !== String(scope.work_id)
    || result.status !== 'completed'
    || Number(result.work_id) !== Number(scope.work_id)
    || Number(result.version_id) !== Number(scope.id)
    || String(result.facts_hash || '') !== String(scope.facts_hash || '')
    || decision.action !== 'advance'
    || Number(decision.policy_version) !== Number(scope.policy_version)
    || String(decision.evidence_hash || '') !== String(scope.facts_hash || '')
    || (decision.version_id != null && Number(decision.version_id) !== Number(scope.id))) {
    throw codedError('REDRAW_VOICE_NOT_VERIFIED', '音色缺少完整本地离线验证证据');
  }
  const shots = db.prepare(`
    SELECT id, shot_id, batch_index, shot_index, localized_dialogue_json, updated_at
    FROM redraw_shots
    WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    ORDER BY batch_index ASC, shot_index ASC, id ASC
  `).all(evidence.version_id, evidence.tenant_id, evidence.user_id);
  const completedAt = Date.parse(String(task.completed_at || ''));
  if (!shots.length
    || !Number.isFinite(completedAt)
    || shots.some((shot) => !Number.isFinite(Date.parse(String(shot.updated_at || '')))
      || Date.parse(String(shot.updated_at)) > completedAt)) {
    throw codedError('REDRAW_VOICE_NOT_VERIFIED', '音色缺少完整本地离线验证证据');
  }
  const approved = [];
  for (const shot of shots) {
    const turns = parseJson(shot.localized_dialogue_json, null);
    if (!Array.isArray(turns)) {
      throw codedError('REDRAW_VOICE_NOT_VERIFIED', '音色缺少完整本地离线验证证据');
    }
    for (const [turnIndex, turn] of turns.entries()) {
      if (!isPlainObject(turn)) {
        throw codedError('REDRAW_VOICE_NOT_VERIFIED', '音色缺少完整本地离线验证证据');
      }
      if (String(turn.speaker_id ?? '') !== evidence.source_character_key) continue;
      const rawText = turn.target_text ?? turn.localized_text;
      if (typeof rawText !== 'string' || !rawText.trim()) {
        throw codedError('REDRAW_VOICE_NOT_VERIFIED', '音色缺少完整本地离线验证证据');
      }
      const text = rawText.trim();
      approved.push({
        batchIndex: Number(shot.batch_index),
        shotIndex: Number(shot.shot_index),
        redrawShotId: Number(shot.id),
        approvalId: 0,
        turnIndex,
        text,
        evidence: {
          source: 'localized_dialogue',
          redraw_shot_id: Number(shot.id),
          shot_id: String(shot.shot_id),
          batch_index: Number(shot.batch_index),
          shot_index: Number(shot.shot_index),
          turn_index: turnIndex,
          source_character_key: evidence.source_character_key,
          target_text_sha256: crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'),
        },
      });
    }
  }
  const shotsById = new Map(shots.map((shot) => [Number(shot.id), shot]));
  for (const row of approvalRows) {
    const shot = shotsById.get(Number(row.redraw_shot_id));
    if (!shot) throw codedError('REDRAW_VOICE_NOT_VERIFIED', '音色缺少完整本地离线验证证据');
    approved.push({
      batchIndex: Number(shot.batch_index),
      shotIndex: Number(shot.shot_index),
      redrawShotId: Number(shot.id),
      approvalId: Number(row.id),
      turnIndex: 0,
      text: String(row.target_text),
      evidence: {
        source: 'supplemental_owner_approval',
        redraw_shot_id: Number(shot.id),
        shot_id: String(shot.shot_id),
        batch_index: Number(shot.batch_index),
        shot_index: Number(shot.shot_index),
        source_character_key: evidence.source_character_key,
        approval_id: Number(row.id),
        approval_evidence_sha256: String(row.approval_evidence_sha256),
        target_text_sha256: String(row.target_text_sha256),
      },
    });
  }
  approved.sort((left, right) => (
    left.batchIndex - right.batchIndex
    || left.shotIndex - right.shotIndex
    || left.redrawShotId - right.redrawShotId
    || left.approvalId - right.approvalId
    || left.turnIndex - right.turnIndex
  ));
  const approvedTextSha256 = crypto.createHash('sha256')
    .update(Buffer.from(approved.map((entry) => entry.text).join('\n'), 'utf8'))
    .digest('hex');
  if (approvedTextSha256 !== evidence.approved_text_sha256) {
    throw codedError('REDRAW_VOICE_NOT_VERIFIED', '音色缺少完整本地离线验证证据');
  }
  return stableHash({
    contract_version: APPROVED_DIALOGUE_CONTRACT,
    localization_task_id: taskId,
    localization_decision_sha256: stableHash(decision),
    facts_hash: String(scope.facts_hash),
    policy_version: Number(scope.policy_version),
    target_locale: evidence.locale,
    target_market: evidence.market,
    source_character_key: evidence.source_character_key,
    approved_text_sha256: approvedTextSha256,
    ordered_dialogue_evidence: approved.map((entry) => entry.evidence),
    supplemental_approvals: approvalRows.map((row) => ({
      approval_id: Number(row.id),
      status: 'active',
      approval_evidence_sha256: String(row.approval_evidence_sha256),
      target_text_sha256: String(row.target_text_sha256),
      approved_at: String(row.approved_at),
      updated_at: String(row.updated_at),
      source_translation: false,
    })),
  });
}

function assertCompletedLocalRegistration(db, evidence, owner, voiceAssetId) {
  if (!owner
    || evidence.tenant_id !== String(owner.tenantId)
    || evidence.user_id !== String(owner.userId)
    || evidence.version_id !== Number(owner.versionId)
    || evidence.voice_redraw_asset_id !== Number(voiceAssetId || evidence.voice_redraw_asset_id)) {
    throw codedError('REDRAW_VOICE_NOT_VERIFIED', '音色缺少完整本地离线验证证据');
  }
  const registration = db.prepare(`
    SELECT * FROM redraw_local_voice_registrations
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND version_id = ?
      AND voice_redraw_asset_id = ? AND status = 'completed' AND deleted_at IS NULL
  `).get(
    evidence.registration_id,
    evidence.tenant_id,
    evidence.user_id,
    evidence.version_id,
    evidence.voice_redraw_asset_id,
  );
  if (!registration
    || registration.source_character_key !== evidence.source_character_key
    || registration.target_locale !== evidence.locale
    || registration.target_market !== evidence.market
    || registration.approved_text_sha256 !== evidence.approved_text_sha256
    || registration.profile_key !== evidence.profile
    || registration.engine_manifest_sha256 !== evidence.manifest_sha256
    || Number(registration.audio_asset_id) !== evidence.audio_asset_id
    || registration.audio_sha256 !== evidence.audio_sha256
    || !isHexSha256(registration.locale_evidence_sha256)
    || String(registration.completed_at || '') !== evidence.completed_at) {
    throw codedError('REDRAW_VOICE_NOT_VERIFIED', '音色缺少完整本地离线验证证据');
  }
  const storedApprovalIds = parseSupplementalApprovalIds(registration.supplemental_approval_ids_json);
  const evidenceApprovalIds = evidence.supplemental_dialogue_approval_ids;
  if (evidenceApprovalIds === null) {
    const approvalRows = readCurrentSupplementalApprovals(db, evidence);
    const storedDialogueEvidenceSha256 = registration.approved_dialogue_evidence_sha256;
    if (stableJson(storedApprovalIds) !== stableJson([])
      || approvalRows.length > 0
      || (storedDialogueEvidenceSha256 != null
        && (!isHexSha256(storedDialogueEvidenceSha256)
          || recomputeApprovedDialogueEvidenceSha256(db, evidence, [])
            !== storedDialogueEvidenceSha256))) {
      throw codedError('REDRAW_VOICE_NOT_VERIFIED', '音色缺少完整本地离线验证证据');
    }
  } else {
    if (registration.approved_dialogue_evidence_sha256
        !== evidence.approved_dialogue_evidence_sha256
      || stableJson(storedApprovalIds) !== stableJson(evidenceApprovalIds)) {
      throw codedError('REDRAW_VOICE_NOT_VERIFIED', '音色缺少完整本地离线验证证据');
    }
    const approvalRows = readCurrentSupplementalApprovals(db, evidence);
    if (stableJson(approvalRows.map((row) => Number(row.id))) !== stableJson(evidenceApprovalIds)
      || approvalRows.some((row, index) => (
        String(row.approval_evidence_sha256)
          !== evidence.supplemental_dialogue_approvals[index].approval_evidence_sha256
        || String(row.target_text_sha256)
          !== evidence.supplemental_dialogue_approvals[index].target_text_sha256
      ))
      || recomputeApprovedDialogueEvidenceSha256(db, evidence, approvalRows)
        !== evidence.approved_dialogue_evidence_sha256) {
      throw codedError('REDRAW_VOICE_NOT_VERIFIED', '音色缺少完整本地离线验证证据');
    }
  }
  const voice = db.prepare(`
    SELECT voice_asset_id FROM redraw_assets
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND version_id = ?
      AND kind = 'voice' AND status = 'generated' AND deleted_at IS NULL
  `).get(
    evidence.voice_redraw_asset_id,
    evidence.tenant_id,
    evidence.user_id,
    evidence.version_id,
  );
  if (!voice || Number(voice.voice_asset_id) !== evidence.audio_asset_id) {
    throw codedError('REDRAW_VOICE_NOT_VERIFIED', '音色缺少完整本地离线验证证据');
  }
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

function assertTrustedEvidenceBranch(db, options, rawEvidence, scope = {}) {
  const evidence = normalizeEvidence(rawEvidence);
  if (evidence.source === PROVIDER_EVIDENCE_SOURCE) {
    const hasDerived = LOCAL_DERIVED_KEYS.some((key) => Object.hasOwn(rawEvidence, key));
    if (!isPlainObject(rawEvidence)
      || PROVIDER_FORBIDDEN_LOCAL_KEYS.some((key) => Object.hasOwn(rawEvidence, key))
      || (hasDerived
        && (rawEvidence.verification_source !== 'provider'
          || rawEvidence.provider_verified !== true
          || rawEvidence.local_offline_verified !== false))
      || !isVerifiedProviderEvidence(evidence)) {
      throw codedError('REDRAW_VOICE_NOT_VERIFIED', '音色缺少真实 TTS 或语言验证证据');
    }
    try {
      assertEvidenceTrusted(options, evidence);
    } catch (_) {
      throw codedError('REDRAW_VOICE_NOT_VERIFIED', '音色缺少真实 TTS 或语言验证证据');
    }
    if (!hasExactActiveTtsConfig(db, evidence)) {
      throw codedError('REDRAW_VOICE_CONFIG_INVALID', '音色绑定的 TTS 配置已变更或停用');
    }
    if (!hasReadableOwnedCloneAuthorization(db, evidence, scope.owner, scope.canReadAsset)) {
      throw codedError('REDRAW_VOICE_AUTHORIZATION_REQUIRED', '克隆音色缺少当前用户可读的授权资产');
    }
    return {
      evidence,
      verificationSource: 'provider',
      providerVerified: true,
      localOfflineVerified: false,
    };
  }
  if (evidence.source === LOCAL_EVIDENCE_SOURCE) {
    if (!isCompleteLocalEvidence(rawEvidence, evidence, options)) {
      throw codedError('REDRAW_VOICE_NOT_VERIFIED', '音色缺少完整本地离线验证证据');
    }
    try {
      assertLocalLocaleEvidenceTrusted(options, evidence);
    } catch (_) {
      throw codedError('REDRAW_VOICE_NOT_VERIFIED', '音色缺少完整本地离线验证证据');
    }
    assertCompletedLocalRegistration(db, evidence, scope.owner, scope.voiceAssetId);
    return {
      evidence,
      verificationSource: LOCAL_EVIDENCE_SOURCE,
      providerVerified: false,
      localOfflineVerified: true,
    };
  }
  throw codedError('REDRAW_VOICE_NOT_VERIFIED', '音色缺少真实 TTS 或语言验证证据');
}

function publicEvidence(branch) {
  const evidence = branch.evidence;
  const common = {
    source: evidence.source,
    locale: evidence.locale,
    market: evidence.market,
    locale_pack: evidence.locale_pack,
    audio_sha256: evidence.audio_sha256,
    transcript_sha256: evidence.transcript_sha256,
    model_manifest_sha256: evidence.model_manifest_sha256,
    calibration_manifest_sha256: evidence.calibration_manifest_sha256,
    metrics: evidence.metrics,
    completed_at: evidence.completed_at,
    audio_asset_id: evidence.audio_asset_id,
    duration_ms: evidence.duration_ms,
    language_verified: evidence.language_verified,
    detected_locale: evidence.detected_locale,
    verification_source: branch.verificationSource,
    provider_verified: branch.providerVerified,
    local_offline_verified: branch.localOfflineVerified,
  };
  if (branch.providerVerified) {
    return {
      ...common,
      asr_model_revision: evidence.asr_model_revision,
      accent_model_revision: evidence.accent_model_revision,
      provider: evidence.provider,
      model: evidence.model,
      ai_service_config_id: evidence.ai_service_config_id,
      config_updated_at: evidence.config_updated_at,
      voice_id: evidence.voice_id,
      task_id: evidence.task_id,
      terminal_status: evidence.terminal_status,
      real_generation_verified: true,
      is_cloned: evidence.is_cloned,
      authorization_asset_id: evidence.authorization_asset_id,
    };
  }
  return {
    ...common,
    contract_version: evidence.contract_version,
    tenant_id: evidence.tenant_id,
    user_id: evidence.user_id,
    version_id: evidence.version_id,
    voice_redraw_asset_id: evidence.voice_redraw_asset_id,
    source_character_key: evidence.source_character_key,
    profile: evidence.profile,
    engine: evidence.engine,
    engine_version: evidence.engine_version,
    binary_sha256: evidence.binary_sha256,
    manifest_sha256: evidence.manifest_sha256,
    approved_text_sha256: evidence.approved_text_sha256,
    registration_id: evidence.registration_id,
    registration_status: evidence.registration_status,
    ...(Array.isArray(evidence.supplemental_dialogue_approval_ids) ? {
      approved_dialogue_contract_version: evidence.approved_dialogue_contract_version,
      approved_dialogue_evidence_sha256: evidence.approved_dialogue_evidence_sha256,
      supplemental_dialogue_approval_ids: [...evidence.supplemental_dialogue_approval_ids],
      supplemental_dialogue_approvals: evidence.supplemental_dialogue_approvals
        .map((approval) => ({ ...approval })),
      source_translation: false,
    } : {}),
    ...(evidence.test_only ? { test_only: true } : {}),
  };
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
    const rawEvidence = evidenceFromPayload(payload);
    let branch;
    try {
      branch = assertTrustedEvidenceBranch(db, filters, rawEvidence, {
        owner: {
          tenantId: String(row.tenant_id),
          userId: String(row.user_id),
          versionId: Number(row.version_id),
        },
        voiceAssetId: Number(row.id),
        canReadAsset: canReadAudio,
      });
    } catch (_) {
      continue;
    }
    const evidence = branch.evidence;
    if (Number(row.voice_asset_id) !== evidence.audio_asset_id || evidence.audio_asset_id <= 0) continue;
    if (filters.locale && evidence.locale !== String(filters.locale)) continue;
    if (filters.market && evidence.market !== String(filters.market)) continue;
    const asset = db.prepare(`
      SELECT * FROM assets
      WHERE id = ? AND type = 'audio' AND deleted_at IS NULL
    `).get(evidence.audio_asset_id);
    if (!isAudioAsset(asset) || canReadAudio(asset) !== true) continue;
    result.push({
      id: row.id,
      ...publicEvidence(branch),
      voice_id: branch.providerVerified ? branch.evidence.voice_id : branch.evidence.profile,
      audio_asset: asset,
      audio_readable: true,
    });
  }
  return result;
}

function sameVoice(left, right) {
  if (left.source !== right.source) return false;
  if (left.source === LOCAL_EVIDENCE_SOURCE) {
    return left.registration_id === right.registration_id
      && left.voice_redraw_asset_id === right.voice_redraw_asset_id
      && left.source_character_key === right.source_character_key
      && left.profile === right.profile
      && left.engine === right.engine
      && left.engine_version === right.engine_version
      && left.binary_sha256 === right.binary_sha256
      && left.manifest_sha256 === right.manifest_sha256
      && left.approved_dialogue_evidence_sha256 === right.approved_dialogue_evidence_sha256
      && stableJson(left.supplemental_dialogue_approval_ids)
        === stableJson(right.supplemental_dialogue_approval_ids)
      && left.locale === right.locale
      && left.market === right.market
      && left.audio_asset_id === right.audio_asset_id;
  }
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
  if (!sameVoice(left, right)
    || left.locale_pack !== right.locale_pack
    || left.audio_sha256 !== right.audio_sha256
    || left.transcript_sha256 !== right.transcript_sha256
    || left.model_manifest_sha256 !== right.model_manifest_sha256
    || left.calibration_manifest_sha256 !== right.calibration_manifest_sha256
    || stableJson(left.metrics) !== stableJson(right.metrics)
    || left.completed_at !== right.completed_at
    || Number(left.duration_ms) !== Number(right.duration_ms)
    || left.language_verified !== right.language_verified
    || left.detected_locale !== right.detected_locale) {
    return false;
  }
  if (left.source === LOCAL_EVIDENCE_SOURCE) {
    return left.contract_version === right.contract_version
      && left.tenant_id === right.tenant_id
      && left.user_id === right.user_id
      && left.version_id === right.version_id
      && left.approved_text_sha256 === right.approved_text_sha256
      && left.approved_dialogue_contract_version === right.approved_dialogue_contract_version
      && stableJson(left.supplemental_dialogue_approvals)
        === stableJson(right.supplemental_dialogue_approvals)
      && left.source_translation === right.source_translation
      && left.registration_status === right.registration_status
      && left.test_only === right.test_only;
  }
  return left.source === PROVIDER_EVIDENCE_SOURCE
    && left.locale_pack === right.locale_pack
    && left.asr_model_revision === right.asr_model_revision
    && left.accent_model_revision === right.accent_model_revision
    && left.task_id === right.task_id
    && left.terminal_status === right.terminal_status
    && left.real_generation_verified === right.real_generation_verified
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
  const rawRequestedEvidence = verifiedVoice?.evidence && typeof verifiedVoice.evidence === 'object'
    ? verifiedVoice.evidence : verifiedVoice;
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
  const rawEvidence = evidenceFromPayload(voiceRow.source_ref_json);
  const evidenceBranch = assertTrustedEvidenceBranch(db, options, rawEvidence, {
    owner,
    voiceAssetId: owner.voiceAssetId,
    canReadAsset,
  });
  const requestedBranch = assertTrustedEvidenceBranch(db, options, rawRequestedEvidence, {
    owner,
    voiceAssetId: owner.voiceAssetId,
    canReadAsset,
  });
  const evidence = evidenceBranch.evidence;
  const requestedEvidence = requestedBranch.evidence;
  if (!sameEvidence(evidence, requestedEvidence)
    || Number(voiceRow.voice_asset_id) !== evidence.audio_asset_id) {
    throw codedError('REDRAW_VOICE_NOT_VERIFIED', '音色缺少真实 TTS 或语言验证证据');
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
  const rawCurrent = snapshotRoot.voice_snapshot;
  if (rawCurrent) {
    const current = assertTrustedEvidenceBranch(db, options, rawCurrent, {
      owner,
      voiceAssetId: rawCurrent.voice_redraw_asset_id || owner.voiceAssetId,
      canReadAsset,
    }).evidence;
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
  const snapshot = publicEvidence(evidenceBranch);
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
    const sourceRef = payload.source_ref && typeof payload.source_ref === 'object' ? payload.source_ref : {};
    const speakerId = firstSpeakerKey(
      sourceRef.source_character_key,
      sourceRef.character_id,
      sourceRef.id,
    );
    const voiceSnapshot = payload.snapshot?.voice_snapshot;
    if (speakerId && voiceSnapshot) {
      bySpeaker.set(speakerId, { character, snapshot: voiceSnapshot });
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
    const speakerId = speakerKey(turn?.speaker_id) || '';
    const assigned = bySpeaker.get(speakerId);
    if (!assigned) {
      issues.push({ turn_index: index, speaker_id: speakerId, reason: 'speaker_voice_missing' });
      continue;
    }
    let branch;
    try {
      branch = assertTrustedEvidenceBranch(db, options, assigned.snapshot, {
        owner,
        voiceAssetId: assigned.snapshot.voice_redraw_asset_id,
        canReadAsset,
      });
    } catch (error) {
      const reason = error.code === 'REDRAW_VOICE_CONFIG_INVALID' ? 'voice_tts_config_invalid'
        : error.code === 'REDRAW_VOICE_AUTHORIZATION_REQUIRED' ? 'voice_authorization_missing'
          : 'voice_not_verified';
      issues.push({ turn_index: index, speaker_id: speakerId, reason });
      continue;
    }
    const evidence = branch.evidence;
    if (evidence.locale !== String(version.locale)
      || (version.market && evidence.market !== String(version.market))) {
      issues.push({ turn_index: index, speaker_id: speakerId, reason: 'voice_locale_mismatch' });
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
      voice_id: branch.providerVerified ? evidence.voice_id : evidence.profile,
      model: branch.providerVerified ? evidence.model : evidence.engine,
      provider: branch.providerVerified ? evidence.provider : LOCAL_EVIDENCE_SOURCE,
      verification_source: branch.verificationSource,
      provider_verified: branch.providerVerified,
      local_offline_verified: branch.localOfflineVerified,
      ...(branch.localOfflineVerified ? { profile: evidence.profile } : {}),
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
