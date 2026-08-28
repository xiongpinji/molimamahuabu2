const crypto = require('node:crypto');

const CONTRACT_VERSION = 'redraw-supplemental-dialogue-approval-v1';
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_TARGET_TEXT_CHARACTERS = 500;
const MAX_TARGET_TEXT_BYTES = 2000;
const CREATE_INPUT_KEYS = new Set([
  'db',
  'tenantId',
  'userId',
  'versionId',
  'shotRowId',
  'voiceAssetId',
  'idempotencyKey',
  'targetText',
  'sourceTranslation',
  'expectedShotUpdatedAt',
  'expectedVoiceUpdatedAt',
  'now',
]);
const REVOKE_INPUT_KEYS = new Set([
  'db',
  'tenantId',
  'userId',
  'versionId',
  'approvalId',
  'idempotencyKey',
  'expectedUpdatedAt',
  'now',
]);

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function stableJson(value) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol'
    || typeof value === 'bigint' || (typeof value === 'number' && !Number.isFinite(value))) {
    throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY');
  }
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableHash(value) {
  return sha256(Buffer.from(stableJson(value), 'utf8'));
}

function parseObject(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch (_) {
    throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY');
  }
}

function parseArray(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch (_) {
    throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY');
  }
}

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function exactInput(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function owner(rawInput) {
  const tenantId = typeof rawInput.tenantId === 'string' ? rawInput.tenantId.trim() : '';
  const userId = typeof rawInput.userId === 'string' ? rawInput.userId.trim() : '';
  if (!tenantId || !userId || tenantId.includes('\0') || userId.includes('\0')) {
    throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_FOUND');
  }
  return { tenantId, userId };
}

function idempotencyHash(value) {
  if (typeof value !== 'string') throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_INPUT_INVALID');
  const key = value.trim();
  if (!key || key.length > 160 || key.includes('\0')) {
    throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_INPUT_INVALID');
  }
  return sha256(Buffer.from(key, 'utf8'));
}

function expectedTimestamp(value) {
  if (typeof value !== 'string' || !value || !Number.isFinite(Date.parse(value))) {
    throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_CAS_CONFLICT');
  }
  return value;
}

function currentTimestamp(now) {
  let value;
  try {
    value = typeof now === 'function' ? now() : new Date().toISOString();
  } catch (_) {
    throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY');
  }
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY');
  }
  return value;
}

function approvedText(value) {
  if (typeof value !== 'string') throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_INPUT_INVALID');
  const text = value.trim();
  if (!text
    || Array.from(text).length > MAX_TARGET_TEXT_CHARACTERS
    || Buffer.byteLength(text, 'utf8') > MAX_TARGET_TEXT_BYTES
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_INPUT_INVALID');
  }
  return text;
}

function sourceCharacterKey(value) {
  for (const candidate of [value?.source_character_key, value?.stable_id, value?.id]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate)) return String(candidate);
  }
  return '';
}

function readOwnedScope(db, input) {
  const row = db.prepare(`
    SELECT v.id AS version_id, v.work_id, v.version AS version_number,
           v.locale AS target_locale, v.market AS target_market,
           v.status AS version_status, v.source_facts_json, v.facts_hash,
           v.localization_task_id,
           w.current_version AS work_current_version,
           p.policy_version,
           s.id AS redraw_shot_id, s.shot_id, s.batch_index, s.shot_index,
           s.source_dialogue_json, s.localized_dialogue_json,
           s.updated_at AS shot_updated_at,
           a.id AS voice_redraw_asset_id, a.source_ref_json,
           a.updated_at AS voice_updated_at
    FROM redraw_versions v
    JOIN redraw_works w
      ON w.id = v.work_id
     AND w.tenant_id = v.tenant_id AND w.user_id = v.user_id
     AND w.deleted_at IS NULL
    JOIN redraw_projects p
      ON p.id = w.project_id
     AND p.tenant_id = v.tenant_id AND p.user_id = v.user_id
     AND p.deleted_at IS NULL
    JOIN redraw_shots s
      ON s.id = ? AND s.version_id = v.id
     AND s.tenant_id = v.tenant_id AND s.user_id = v.user_id
     AND s.deleted_at IS NULL
    JOIN redraw_assets a
      ON a.id = ? AND a.version_id = v.id
     AND a.tenant_id = v.tenant_id AND a.user_id = v.user_id
     AND a.kind = 'voice' AND a.deleted_at IS NULL
    WHERE v.id = ? AND v.tenant_id = ? AND v.user_id = ? AND v.deleted_at IS NULL
    LIMIT 1
  `).get(input.shotRowId, input.voiceAssetId, input.versionId, input.tenantId, input.userId);
  if (!row) throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_FOUND');
  if (row.version_status === 'draft'
    || Number(row.version_number) !== Number(row.work_current_version)
    || !String(row.shot_id || '').trim()
    || !String(row.target_locale || '').trim()
    || !SHA256.test(String(row.facts_hash || ''))
    || !Number.isSafeInteger(Number(row.policy_version))
    || Number(row.policy_version) <= 0) {
    throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY');
  }
  return row;
}

function readFactsBinding(scope) {
  const facts = parseObject(scope.source_facts_json);
  if (String(facts.facts_hash || '') !== String(scope.facts_hash)) {
    throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY');
  }
  const characters = Array.isArray(facts.characters)
    ? facts.characters
    : Array.isArray(facts.source_characters) ? facts.source_characters : null;
  const shots = Array.isArray(facts.shots) ? facts.shots : null;
  if (!characters?.length || !shots?.length) {
    throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY');
  }
  const sourceRef = parseObject(scope.source_ref_json);
  const characterKey = sourceCharacterKey(sourceRef.source_ref);
  const characterKeys = characters.map(sourceCharacterKey);
  if (!characterKey
    || characterKeys.some((key) => !key)
    || new Set(characterKeys).size !== characterKeys.length
    || !characterKeys.includes(characterKey)) {
    throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY');
  }
  const stableShotId = String(scope.shot_id).trim();
  const sourceShots = shots.filter((shot) => String(shot?.id ?? '').trim() === stableShotId);
  if (sourceShots.length !== 1 || !Array.isArray(sourceShots[0].visible_character_ids)) {
    throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY');
  }
  const visibleCharacterIds = sourceShots[0].visible_character_ids
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .sort((left, right) => left.localeCompare(right));
  if (visibleCharacterIds.some((key) => !key)
    || new Set(visibleCharacterIds).size !== visibleCharacterIds.length
    || !visibleCharacterIds.includes(characterKey)) {
    throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY');
  }
  return { characterKey, visibleCharacterIds };
}

function readLocalizationBinding(db, input, scope) {
  const taskId = String(scope.localization_task_id || '').trim();
  if (!taskId) throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY');
  const task = db.prepare(`
    SELECT id, status, result, resource_id, completed_at
    FROM async_tasks
    WHERE id = ? AND type = 'redraw_localization' AND status = 'completed'
      AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    LIMIT 1
  `).get(taskId, input.tenantId, input.userId);
  if (!task || String(task.resource_id || '') !== String(scope.work_id)) {
    throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY');
  }
  const result = parseObject(task.result);
  const decision = parseObject(result.localization_decision);
  if (result.status !== 'completed'
    || Number(result.work_id) !== Number(scope.work_id)
    || Number(result.version_id) !== Number(scope.version_id)
    || String(result.facts_hash || '') !== String(scope.facts_hash)
    || decision.action !== 'advance'
    || Number(decision.policy_version) !== Number(scope.policy_version)
    || String(decision.evidence_hash || '') !== String(scope.facts_hash)
    || (decision.version_id != null && Number(decision.version_id) !== Number(scope.version_id))) {
    throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY');
  }
  const completedAt = Date.parse(String(task.completed_at || ''));
  const shotUpdatedAt = Date.parse(String(scope.shot_updated_at || ''));
  if (!Number.isFinite(completedAt) || !Number.isFinite(shotUpdatedAt) || shotUpdatedAt > completedAt) {
    throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY');
  }
  return {
    taskId,
    decision,
    decisionSha256: stableHash(decision),
  };
}

function deriveContext(db, input, options = {}) {
  const scope = readOwnedScope(db, input);
  if (options.assertCas !== false
    && (scope.shot_updated_at !== input.expectedShotUpdatedAt
      || scope.voice_updated_at !== input.expectedVoiceUpdatedAt)) {
    throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_CAS_CONFLICT');
  }
  const facts = readFactsBinding(scope);
  const localization = readLocalizationBinding(db, input, scope);
  const sourceDialogue = parseArray(scope.source_dialogue_json);
  const localizedDialogue = parseArray(scope.localized_dialogue_json);
  const ownerSha256 = stableHash({ tenant_id: input.tenantId, user_id: input.userId });
  const context = {
    contract_version: CONTRACT_VERSION,
    owner_sha256: ownerSha256,
    work_id: Number(scope.work_id),
    version_id: Number(scope.version_id),
    redraw_shot_id: Number(scope.redraw_shot_id),
    shot_id: String(scope.shot_id),
    batch_index: Number(scope.batch_index),
    shot_index: Number(scope.shot_index),
    voice_redraw_asset_id: Number(scope.voice_redraw_asset_id),
    source_character_key: facts.characterKey,
    visible_character_ids: facts.visibleCharacterIds,
    source_dialogue_sha256: stableHash(sourceDialogue),
    localized_dialogue_sha256: stableHash(localizedDialogue),
    localization_task_id: localization.taskId,
    localization_decision_sha256: localization.decisionSha256,
    facts_hash: String(scope.facts_hash),
    policy_version: Number(scope.policy_version),
    target_locale: String(scope.target_locale),
    target_market: String(scope.target_market || ''),
    shot_updated_at: String(scope.shot_updated_at),
    voice_updated_at: String(scope.voice_updated_at),
  };
  return {
    scope,
    characterKey: facts.characterKey,
    localization,
    ownerSha256,
    contextSha256: stableHash(context),
  };
}

function evidenceSha256(row) {
  return stableHash({
    contract_version: CONTRACT_VERSION,
    approval_id: Number(row.id),
    status: String(row.status),
    dialogue_context_sha256: String(row.dialogue_context_sha256),
    target_text_sha256: String(row.target_text_sha256),
    source_translation: false,
    approval_source: 'owner_http',
    approval_decision: 'approved',
    approved_by_sha256: stableHash({
      tenant_id: String(row.tenant_id),
      user_id: String(row.user_id),
      approved_by: String(row.approved_by),
    }),
    approved_at: String(row.approved_at),
  });
}

function validateStoredApproval(db, row) {
  if (!db || typeof db.prepare !== 'function'
    || !row || typeof row !== 'object' || Array.isArray(row)
    || row.contract_version !== CONTRACT_VERSION
    || row.approval_source !== 'owner_http'
    || row.approval_decision !== 'approved'
    || Number(row.source_translation) !== 0
    || !['active', 'revoked'].includes(row.status)
    || String(row.approved_by || '') !== String(row.user_id || '')
    || !SHA256.test(String(row.target_text_sha256 || ''))
    || !SHA256.test(String(row.localization_decision_sha256 || ''))
    || !SHA256.test(String(row.facts_hash || ''))
    || !SHA256.test(String(row.dialogue_context_sha256 || ''))
    || !SHA256.test(String(row.approval_evidence_sha256 || ''))
    || !SHA256.test(String(row.idempotency_hash || ''))
    || !SHA256.test(String(row.request_hash || ''))
    || !Number.isFinite(Date.parse(String(row.approved_at || '')))
    || !Number.isFinite(Date.parse(String(row.updated_at || '')))
    || row.deleted_at != null) {
    throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY');
  }
  let canonicalText;
  try {
    canonicalText = approvedText(row.target_text);
  } catch (_) {
    throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY');
  }
  if (canonicalText !== row.target_text
    || sha256(Buffer.from(canonicalText, 'utf8')) !== row.target_text_sha256) {
    throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY');
  }
  const derived = deriveContext(db, {
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    versionId: Number(row.version_id),
    shotRowId: Number(row.redraw_shot_id),
    voiceAssetId: Number(row.voice_redraw_asset_id),
  }, { assertCas: false });
  if (Number(row.work_id) !== Number(derived.scope.work_id)
    || String(row.shot_id) !== String(derived.scope.shot_id)
    || String(row.source_character_key) !== derived.characterKey
    || String(row.target_locale) !== String(derived.scope.target_locale)
    || String(row.target_market || '') !== String(derived.scope.target_market || '')
    || String(row.localization_task_id) !== derived.localization.taskId
    || String(row.localization_decision_sha256) !== derived.localization.decisionSha256
    || String(row.facts_hash) !== String(derived.scope.facts_hash)
    || Number(row.policy_version) !== Number(derived.scope.policy_version)
    || String(row.dialogue_context_sha256) !== derived.contextSha256
    || String(row.approval_evidence_sha256) !== evidenceSha256(row)) {
    throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY');
  }
  if (row.status === 'active') {
    if (row.revocation_idempotency_hash != null
      || row.revocation_request_hash != null
      || row.revoked_by != null
      || row.revoked_at != null) {
      throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY');
    }
  } else if (!SHA256.test(String(row.revocation_idempotency_hash || ''))
    || !SHA256.test(String(row.revocation_request_hash || ''))
    || String(row.revoked_by || '') !== String(row.user_id)
    || !Number.isFinite(Date.parse(String(row.revoked_at || '')))) {
    throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY');
  }
  return derived;
}

function createSupplementalDialogueApproval(rawInput) {
  if (!exactInput(rawInput, CREATE_INPUT_KEYS)
    || !rawInput.db || typeof rawInput.db.prepare !== 'function'
    || rawInput.sourceTranslation !== false) {
    throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_INPUT_INVALID');
  }
  const owned = owner(rawInput);
  const versionId = positiveId(rawInput.versionId);
  const shotRowId = positiveId(rawInput.shotRowId);
  const voiceAssetId = positiveId(rawInput.voiceAssetId);
  if (!versionId || !shotRowId || !voiceAssetId) {
    throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_FOUND');
  }
  const input = {
    ...owned,
    versionId,
    shotRowId,
    voiceAssetId,
    idempotencyHash: idempotencyHash(rawInput.idempotencyKey),
    targetText: approvedText(rawInput.targetText),
    expectedShotUpdatedAt: expectedTimestamp(rawInput.expectedShotUpdatedAt),
    expectedVoiceUpdatedAt: expectedTimestamp(rawInput.expectedVoiceUpdatedAt),
  };
  const targetTextSha256 = sha256(Buffer.from(input.targetText, 'utf8'));

  return rawInput.db.transaction(() => {
    const derived = deriveContext(rawInput.db, input);
    const requestHash = stableHash({
      contract_version: CONTRACT_VERSION,
      owner_sha256: derived.ownerSha256,
      work_id: Number(derived.scope.work_id),
      version_id: versionId,
      redraw_shot_id: shotRowId,
      shot_id: String(derived.scope.shot_id),
      voice_redraw_asset_id: voiceAssetId,
      source_character_key: derived.characterKey,
      target_locale: String(derived.scope.target_locale),
      target_market: String(derived.scope.target_market || ''),
      target_text_sha256: targetTextSha256,
      source_translation: false,
      dialogue_context_sha256: derived.contextSha256,
      expected_shot_updated_at: input.expectedShotUpdatedAt,
      expected_voice_updated_at: input.expectedVoiceUpdatedAt,
      idempotency_hash: input.idempotencyHash,
    });
    const existing = rawInput.db.prepare(`
      SELECT * FROM redraw_supplemental_dialogue_approvals
      WHERE tenant_id = ? AND user_id = ? AND version_id = ?
        AND idempotency_hash = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(input.tenantId, input.userId, versionId, input.idempotencyHash);
    if (existing) {
      validateStoredApproval(rawInput.db, existing);
      if (existing.request_hash !== requestHash) {
        throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_IDEMPOTENCY_CONFLICT');
      }
      return { approval: existing, idempotentReplay: true };
    }
    const active = rawInput.db.prepare(`
      SELECT id FROM redraw_supplemental_dialogue_approvals
      WHERE tenant_id = ? AND user_id = ? AND version_id = ?
        AND redraw_shot_id = ? AND voice_redraw_asset_id = ? AND source_character_key = ?
        AND status = 'active' AND deleted_at IS NULL
      LIMIT 1
    `).get(
      input.tenantId,
      input.userId,
      versionId,
      shotRowId,
      voiceAssetId,
      derived.characterKey,
    );
    if (active) throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_ACTIVE_CONFLICT');
    const now = currentTimestamp(rawInput.now);
    const inserted = rawInput.db.prepare(`
      INSERT INTO redraw_supplemental_dialogue_approvals
        (contract_version, tenant_id, user_id, work_id, version_id, redraw_shot_id,
         shot_id, voice_redraw_asset_id, source_character_key, target_locale, target_market,
         target_text, target_text_sha256, source_translation, localization_task_id,
         localization_decision_sha256, facts_hash, policy_version, dialogue_context_sha256,
         approval_evidence_sha256, idempotency_hash, request_hash, approval_source,
         approval_decision, status, approved_by, approved_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?,
              'owner_http', 'approved', 'active', ?, ?, ?, ?)
    `).run(
      CONTRACT_VERSION,
      input.tenantId,
      input.userId,
      Number(derived.scope.work_id),
      versionId,
      shotRowId,
      String(derived.scope.shot_id),
      voiceAssetId,
      derived.characterKey,
      String(derived.scope.target_locale),
      String(derived.scope.target_market || ''),
      input.targetText,
      targetTextSha256,
      derived.localization.taskId,
      derived.localization.decisionSha256,
      String(derived.scope.facts_hash),
      Number(derived.scope.policy_version),
      derived.contextSha256,
      '0'.repeat(64),
      input.idempotencyHash,
      requestHash,
      input.userId,
      now,
      now,
      now,
    );
    const approvalId = Number(inserted.lastInsertRowid);
    const row = rawInput.db.prepare('SELECT * FROM redraw_supplemental_dialogue_approvals WHERE id = ?')
      .get(approvalId);
    const approvalEvidenceSha256 = evidenceSha256(row);
    rawInput.db.prepare(`
      UPDATE redraw_supplemental_dialogue_approvals
      SET approval_evidence_sha256 = ?
      WHERE id = ? AND status = 'active' AND approval_evidence_sha256 = ?
    `).run(approvalEvidenceSha256, approvalId, '0'.repeat(64));
    const approval = rawInput.db.prepare('SELECT * FROM redraw_supplemental_dialogue_approvals WHERE id = ?')
      .get(approvalId);
    validateStoredApproval(rawInput.db, approval);
    return {
      approval,
      idempotentReplay: false,
    };
  }).immediate();
}

function revokeSupplementalDialogueApproval(rawInput) {
  if (!exactInput(rawInput, REVOKE_INPUT_KEYS)
    || !rawInput.db || typeof rawInput.db.prepare !== 'function') {
    throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_INPUT_INVALID');
  }
  const owned = owner(rawInput);
  const versionId = positiveId(rawInput.versionId);
  const approvalId = positiveId(rawInput.approvalId);
  if (!versionId || !approvalId) throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_FOUND');
  const expectedUpdatedAt = expectedTimestamp(rawInput.expectedUpdatedAt);
  const revocationIdempotencyHash = idempotencyHash(rawInput.idempotencyKey);
  const ownerSha256 = stableHash({ tenant_id: owned.tenantId, user_id: owned.userId });
  const revocationRequestHash = stableHash({
    contract_version: CONTRACT_VERSION,
    owner_sha256: ownerSha256,
    version_id: versionId,
    approval_id: approvalId,
    expected_updated_at: expectedUpdatedAt,
    idempotency_hash: revocationIdempotencyHash,
  });

  return rawInput.db.transaction(() => {
    const row = rawInput.db.prepare(`
      SELECT * FROM redraw_supplemental_dialogue_approvals
      WHERE id = ? AND version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(approvalId, versionId, owned.tenantId, owned.userId);
    if (!row) throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_FOUND');
    validateStoredApproval(rawInput.db, row);
    if (row.status === 'revoked') {
      if (row.revocation_idempotency_hash !== revocationIdempotencyHash
        || row.revocation_request_hash !== revocationRequestHash) {
        throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_IDEMPOTENCY_CONFLICT');
      }
      return { approval: row, idempotentReplay: true };
    }
    if (row.status !== 'active') throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY');
    if (row.updated_at !== expectedUpdatedAt) {
      throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_CAS_CONFLICT');
    }
    const now = currentTimestamp(rawInput.now);
    const revokedEvidence = evidenceSha256({
      ...row,
      status: 'revoked',
      revocation_idempotency_hash: revocationIdempotencyHash,
      revocation_request_hash: revocationRequestHash,
      revoked_by: owned.userId,
      revoked_at: now,
      updated_at: now,
    });
    const update = rawInput.db.prepare(`
      UPDATE redraw_supplemental_dialogue_approvals
      SET status = 'revoked', approval_evidence_sha256 = ?,
          revocation_idempotency_hash = ?, revocation_request_hash = ?,
          revoked_by = ?, revoked_at = ?, updated_at = ?
      WHERE id = ? AND version_id = ? AND tenant_id = ? AND user_id = ?
        AND status = 'active' AND updated_at = ? AND deleted_at IS NULL
    `).run(
      revokedEvidence,
      revocationIdempotencyHash,
      revocationRequestHash,
      owned.userId,
      now,
      now,
      approvalId,
      versionId,
      owned.tenantId,
      owned.userId,
      expectedUpdatedAt,
    );
    if (update.changes !== 1) throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_CAS_CONFLICT');
    const approval = rawInput.db.prepare('SELECT * FROM redraw_supplemental_dialogue_approvals WHERE id = ?')
      .get(approvalId);
    validateStoredApproval(rawInput.db, approval);
    return {
      approval,
      idempotentReplay: false,
    };
  }).immediate();
}

function publicSupplementalDialogueApproval(db, result) {
  const row = result?.approval;
  validateStoredApproval(db, row);
  if (row.status === 'active') {
    return {
      approval_id: Number(row.id),
      contract_version: CONTRACT_VERSION,
      version_id: Number(row.version_id),
      redraw_shot_id: Number(row.redraw_shot_id),
      voice_redraw_asset_id: Number(row.voice_redraw_asset_id),
      status: 'active',
      source_translation: false,
      target_text_sha256: row.target_text_sha256,
      approval_evidence_sha256: row.approval_evidence_sha256,
      approved_at: row.approved_at,
      updated_at: row.updated_at,
      idempotent_replay: result.idempotentReplay === true,
    };
  }
  if (row.status === 'revoked') {
    return {
      approval_id: Number(row.id),
      contract_version: CONTRACT_VERSION,
      version_id: Number(row.version_id),
      status: 'revoked',
      target_text_sha256: row.target_text_sha256,
      approval_evidence_sha256: row.approval_evidence_sha256,
      revoked_at: row.revoked_at,
      updated_at: row.updated_at,
      idempotent_replay: result.idempotentReplay === true,
    };
  }
  throw codedError('REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY');
}

module.exports = {
  CONTRACT_VERSION,
  MAX_TARGET_TEXT_BYTES,
  MAX_TARGET_TEXT_CHARACTERS,
  createSupplementalDialogueApproval,
  publicSupplementalDialogueApproval,
  revokeSupplementalDialogueApproval,
};
