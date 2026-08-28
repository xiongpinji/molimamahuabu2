const crypto = require('node:crypto');

const SHA256 = /^[a-f0-9]{64}$/;
const MANIFEST_KEYS = [
  'schema_version',
  'engine',
  'engine_version',
  'executable_path',
  'executable_sha256',
  'profiles',
  'manifest_sha256',
];
const PROFILE_KEYS = ['profile_key', 'locale', 'voice', 'pitch', 'rate', 'amplitude'];

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function stableJson(value) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol'
    || typeof value === 'bigint' || (typeof value === 'number' && !Number.isFinite(value))) {
    throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
  }
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseObject(value, code = 'REDRAW_LOCAL_TTS_NOT_READY') {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch (_) {
    throw codedError(code);
  }
}

function parseArray(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch (_) {
    throw codedError('REDRAW_LOCAL_TTS_APPROVED_TEXT_INSUFFICIENT');
  }
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function positiveId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function owner(rawInput) {
  const tenantId = String(rawInput.tenantId ?? rawInput.tenant_id ?? '').trim();
  const userId = String(rawInput.userId ?? rawInput.user_id ?? '').trim();
  if (!tenantId || !userId) throw codedError('REDRAW_LOCAL_TTS_OWNER_MISMATCH');
  return { tenantId, userId };
}

function sourceCharacterKey(value) {
  for (const candidate of [value?.source_character_key, value?.stable_id, value?.id]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate)) return String(candidate);
  }
  return '';
}

function stableCharacterKeys(version) {
  const facts = parseObject(version.source_facts_json);
  if (String(facts.facts_hash || version.facts_hash || '') !== String(version.facts_hash || '')) {
    throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
  }
  const characters = Array.isArray(facts.characters)
    ? facts.characters
    : Array.isArray(facts.source_characters) ? facts.source_characters : null;
  if (!characters?.length) throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
  const keys = characters.map(sourceCharacterKey);
  if (keys.some((key) => !key) || new Set(keys).size !== keys.length) {
    throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
  }
  return keys.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function readOwnedScope(db, input) {
  const row = db.prepare(`
    SELECT v.*, w.project_id, w.current_version AS work_current_version, p.policy_version,
           a.id AS voice_redraw_asset_id, a.source_ref_json AS voice_source_ref_json,
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
    JOIN redraw_assets a
      ON a.id = ? AND a.version_id = v.id
     AND a.tenant_id = v.tenant_id AND a.user_id = v.user_id
     AND a.kind = 'voice' AND a.deleted_at IS NULL
    WHERE v.id = ? AND v.tenant_id = ? AND v.user_id = ? AND v.deleted_at IS NULL
    LIMIT 1
  `).get(input.voiceAssetId, input.versionId, input.tenantId, input.userId);
  if (!row) throw codedError('REDRAW_LOCAL_TTS_OWNER_MISMATCH');
  if (String(row.status || '') === 'draft'
    || Number(row.version) !== Number(row.work_current_version)) {
    throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
  }
  if (!SHA256.test(String(row.facts_hash || '')) || !String(row.locale || '').trim()) {
    throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
  }
  const sourceRef = parseObject(row.voice_source_ref_json);
  const characterKey = sourceCharacterKey(sourceRef.source_ref);
  const characterKeys = stableCharacterKeys(row);
  if (!characterKey || !characterKeys.includes(characterKey)) {
    throw codedError('REDRAW_LOCAL_TTS_OWNER_MISMATCH');
  }
  return { version: row, characterKey, characterKeys };
}

function readApprovedDialogueEvidence(db, input, scope) {
  const taskId = String(scope.version.localization_task_id || '').trim();
  if (!taskId) throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
  const task = db.prepare(`
    SELECT *
    FROM async_tasks
    WHERE id = ? AND type = 'redraw_localization' AND status = 'completed'
      AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    LIMIT 1
  `).get(taskId, input.tenantId, input.userId);
  if (!task || String(task.resource_id || '') !== String(scope.version.work_id)) {
    throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
  }
  const result = parseObject(task.result);
  const decision = parseObject(result.localization_decision);
  const factsHash = String(scope.version.facts_hash);
  if (result.status !== 'completed'
    || Number(result.work_id) !== Number(scope.version.work_id)
    || Number(result.version_id) !== Number(scope.version.id)
    || String(result.facts_hash || '') !== factsHash
    || decision.action !== 'advance'
    || Number(decision.policy_version) !== Number(scope.version.policy_version)
    || String(decision.evidence_hash || '') !== factsHash
    || (decision.version_id != null && Number(decision.version_id) !== Number(scope.version.id))) {
    throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
  }
  const rows = db.prepare(`
    SELECT id, batch_index, shot_index, localized_dialogue_json, updated_at
    FROM redraw_shots
    WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    ORDER BY batch_index ASC, shot_index ASC, id ASC
  `).all(Number(scope.version.id), input.tenantId, input.userId);
  if (!rows.length) throw codedError('REDRAW_LOCAL_TTS_APPROVED_TEXT_INSUFFICIENT');
  const completedAt = Date.parse(String(task.completed_at || ''));
  if (!Number.isFinite(completedAt)
    || rows.some((row) => !Number.isFinite(Date.parse(String(row.updated_at || '')))
      || Date.parse(String(row.updated_at)) > completedAt)) {
    throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
  }
  const approved = [];
  for (const row of rows) {
    for (const turn of parseArray(row.localized_dialogue_json)) {
      if (!turn || typeof turn !== 'object' || Array.isArray(turn)) {
        throw codedError('REDRAW_LOCAL_TTS_APPROVED_TEXT_INSUFFICIENT');
      }
      if (String(turn.speaker_id ?? '') !== scope.characterKey) continue;
      const rawText = turn.target_text ?? turn.localized_text;
      if (typeof rawText !== 'string' || !rawText.trim()) {
        throw codedError('REDRAW_LOCAL_TTS_APPROVED_TEXT_INSUFFICIENT');
      }
      approved.push(rawText.trim());
    }
  }
  const approvedText = approved.join('\n');
  const minimum = input.minimumApprovedTextCharacters;
  const nonWhitespaceCharacters = Array.from(approvedText.replace(/\s/gu, '')).length;
  if (!Number.isSafeInteger(minimum) || minimum <= 0 || nonWhitespaceCharacters < minimum) {
    throw codedError('REDRAW_LOCAL_TTS_APPROVED_TEXT_INSUFFICIENT');
  }
  return {
    approvedText,
    approvedTextSha256: sha256(Buffer.from(approvedText, 'utf8')),
    factsHash,
    policyVersion: Number(scope.version.policy_version),
  };
}

function canonicalManifestSha256(manifest) {
  const { manifest_sha256: _manifestSha256, ...hashable } = manifest;
  return sha256(Buffer.from(stableJson(hashable), 'utf8'));
}

function validateProfile(profile) {
  if (!exactObject(profile, PROFILE_KEYS)
    || typeof profile.profile_key !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(profile.profile_key)
    || typeof profile.locale !== 'string'
    || !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(profile.locale)
    || typeof profile.voice !== 'string'
    || !/^[A-Za-z][A-Za-z0-9_+.-]{0,63}$/.test(profile.voice)
    || !Number.isInteger(profile.pitch) || profile.pitch < 0 || profile.pitch > 99
    || !Number.isInteger(profile.rate) || profile.rate < 80 || profile.rate > 450
    || !Number.isInteger(profile.amplitude) || profile.amplitude < 0 || profile.amplitude > 200) {
    throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
  }
}

function validateManifest(value, context) {
  const manifest = parseObject(value);
  const keys = manifest.test_only === true ? [...MANIFEST_KEYS, 'test_only'] : MANIFEST_KEYS;
  if (!exactObject(manifest, keys)
    || (manifest.test_only === true && context !== 'test')
    || manifest.schema_version !== 'local-tts-manifest-v1'
    || manifest.engine !== 'eSpeak NG'
    || typeof manifest.engine_version !== 'string'
    || !/^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/.test(manifest.engine_version)
    || typeof manifest.executable_path !== 'string'
    || !require('node:path').isAbsolute(manifest.executable_path)
    || !SHA256.test(String(manifest.executable_sha256 || ''))
    || !SHA256.test(String(manifest.manifest_sha256 || ''))
    || canonicalManifestSha256(manifest) !== manifest.manifest_sha256
    || !Array.isArray(manifest.profiles)
    || manifest.profiles.length === 0
    || manifest.profiles.length > 128) {
    throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
  }
  manifest.profiles.forEach(validateProfile);
  const profileKeys = manifest.profiles.map((profile) => profile.profile_key);
  if (new Set(profileKeys).size !== profileKeys.length) {
    throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
  }
  return manifest;
}

function assignStableProfile(input, scope) {
  const manifest = validateManifest(input.localTtsManifest, input.context);
  const manifestSha256 = String(manifest.manifest_sha256 || '');
  if (!SHA256.test(manifestSha256) || !Array.isArray(manifest.profiles)) {
    throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
  }
  const locale = String(scope.version.locale);
  const profiles = manifest.profiles.filter((profile) => profile?.locale === locale);
  const profileKeys = profiles.map((profile) => String(profile?.profile_key || '').trim());
  if (profiles.length < scope.characterKeys.length
    || profileKeys.some((key) => !key)
    || new Set(profileKeys).size !== profileKeys.length) {
    throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
  }
  const characterIndex = scope.characterKeys.indexOf(scope.characterKey);
  const profile = profiles[characterIndex];
  if (!profile || !profileKeys[characterIndex]) throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
  return {
    profile: structuredClone(profile),
    profileKey: profileKeys[characterIndex],
    manifestSha256,
  };
}

function claimStateFingerprint(db, input) {
  const state = db.prepare(`
    SELECT v.id AS version_id, v.version, v.status AS version_status,
           v.locale, v.market, v.facts_hash, v.source_facts_json, v.localization_task_id,
           w.id AS work_id, w.current_version, p.policy_version,
           a.id AS voice_redraw_asset_id, a.kind, a.source_ref_json, a.updated_at AS voice_updated_at,
           t.id AS task_id, t.type AS task_type, t.status AS task_status,
           t.result AS task_result, t.resource_id AS task_resource_id,
           t.completed_at AS task_completed_at
    FROM redraw_versions v
    JOIN redraw_works w
      ON w.id = v.work_id AND w.tenant_id = v.tenant_id AND w.user_id = v.user_id
     AND w.deleted_at IS NULL
    JOIN redraw_projects p
      ON p.id = w.project_id AND p.tenant_id = v.tenant_id AND p.user_id = v.user_id
     AND p.deleted_at IS NULL
    JOIN redraw_assets a
      ON a.id = ? AND a.version_id = v.id AND a.tenant_id = v.tenant_id AND a.user_id = v.user_id
     AND a.kind = 'voice' AND a.deleted_at IS NULL
    LEFT JOIN async_tasks t
      ON t.id = v.localization_task_id AND t.tenant_id = v.tenant_id AND t.user_id = v.user_id
     AND t.deleted_at IS NULL
    WHERE v.id = ? AND v.tenant_id = ? AND v.user_id = ? AND v.deleted_at IS NULL
    LIMIT 1
  `).get(input.voiceAssetId, input.versionId, input.tenantId, input.userId);
  if (!state) throw codedError('REDRAW_LOCAL_TTS_OWNER_MISMATCH');
  const shots = db.prepare(`
    SELECT id, batch_index, shot_index, localized_dialogue_json, updated_at
    FROM redraw_shots
    WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    ORDER BY batch_index ASC, shot_index ASC, id ASC
  `).all(input.versionId, input.tenantId, input.userId);
  return sha256(Buffer.from(stableJson({ state, shots }), 'utf8'));
}

function requestHash(input, derived) {
  return sha256(Buffer.from(stableJson({
    tenant_id: input.tenantId,
    user_id: input.userId,
    version_id: input.versionId,
    voice_redraw_asset_id: input.voiceAssetId,
    source_character_key: derived.scope.characterKey,
    target_locale: String(derived.scope.version.locale),
    target_market: String(derived.scope.version.market || ''),
    facts_hash: derived.dialogue.factsHash,
    policy_version: derived.dialogue.policyVersion,
    approved_text_sha256: derived.dialogue.approvedTextSha256,
    profile: derived.profile.profile,
    engine_manifest_sha256: derived.profile.manifestSha256,
    expected_updated_at: input.expectedUpdatedAt,
    runtime_context: input.context,
  }), 'utf8'));
}

function replayRegistration(existing, requestHash) {
  if (existing.request_hash !== requestHash) {
    throw codedError('REDRAW_LOCAL_TTS_IDEMPOTENCY_CONFLICT');
  }
  return { registration: existing, replayed: true, claim: null };
}

function claimRegistration(db, input, derived, expectedStateFingerprint) {
  const currentRequestHash = requestHash(input, derived);
  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT *
      FROM redraw_local_voice_registrations
      WHERE tenant_id = ? AND user_id = ? AND version_id = ?
        AND voice_redraw_asset_id = ? AND idempotency_hash = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(input.tenantId, input.userId, input.versionId, input.voiceAssetId, input.idempotencyHash);
    if (existing) return replayRegistration(existing, currentRequestHash);
    const currentSlot = db.prepare(`
      SELECT updated_at
      FROM redraw_assets
      WHERE id = ? AND version_id = ? AND tenant_id = ? AND user_id = ?
        AND kind = 'voice' AND deleted_at IS NULL
    `).get(input.voiceAssetId, input.versionId, input.tenantId, input.userId);
    if (!currentSlot || String(currentSlot.updated_at || '') !== input.expectedUpdatedAt) {
      throw codedError('REDRAW_LOCAL_TTS_CAS_CONFLICT');
    }
    if (claimStateFingerprint(db, input) !== expectedStateFingerprint) {
      throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
    }
    const now = String(input.now());
    if (!now || !Number.isFinite(Date.parse(now))) throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
    const inserted = db.prepare(`
      INSERT INTO redraw_local_voice_registrations
        (tenant_id, user_id, version_id, voice_redraw_asset_id, source_character_key,
         idempotency_hash, request_hash, target_locale, target_market, approved_text_sha256,
         profile_key, engine_manifest_sha256, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?)
    `).run(
      input.tenantId,
      input.userId,
      input.versionId,
      input.voiceAssetId,
      derived.scope.characterKey,
      input.idempotencyHash,
      currentRequestHash,
      String(derived.scope.version.locale),
      String(derived.scope.version.market || ''),
      derived.dialogue.approvedTextSha256,
      derived.profile.profileKey,
      derived.profile.manifestSha256,
      now,
      now,
    );
    const registration = db.prepare('SELECT * FROM redraw_local_voice_registrations WHERE id = ?')
      .get(Number(inserted.lastInsertRowid));
    return {
      registration,
      replayed: false,
      claim: {
        requestId: `redraw-local-voice-${registration.id}`,
        approvedText: derived.dialogue.approvedText,
        approvedTextSha256: derived.dialogue.approvedTextSha256,
        locale: registration.target_locale,
        market: registration.target_market,
        profile: derived.profile.profile,
        engineManifestSha256: registration.engine_manifest_sha256,
        expectedUpdatedAt: input.expectedUpdatedAt,
      },
    };
  }).immediate();
}

function performRegistrationClaim(rawInput) {
  if (!rawInput.db || typeof rawInput.db.prepare !== 'function') {
    throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
  }
  const owned = owner(rawInput);
  const versionId = positiveId(rawInput.versionId ?? rawInput.version_id);
  const voiceAssetId = positiveId(rawInput.voiceAssetId ?? rawInput.voice_asset_id);
  if (!versionId || !voiceAssetId) throw codedError('REDRAW_LOCAL_TTS_OWNER_MISMATCH');
  const idempotencyKey = String(rawInput.idempotencyKey ?? rawInput.idempotency_key ?? '').trim();
  if (!idempotencyKey || idempotencyKey.length > 160 || idempotencyKey.includes('\0')) {
    throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
  }
  const expectedUpdatedAt = String(rawInput.expectedUpdatedAt ?? rawInput.expected_updated_at ?? '');
  if (!expectedUpdatedAt || !Number.isFinite(Date.parse(expectedUpdatedAt))) {
    throw codedError('REDRAW_LOCAL_TTS_CAS_CONFLICT');
  }
  const context = rawInput.context === undefined ? 'production' : String(rawInput.context);
  if (context !== 'production' && context !== 'test') {
    throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
  }
  const input = {
    ...owned,
    db: rawInput.db,
    versionId,
    voiceAssetId,
    idempotencyHash: sha256(Buffer.from(idempotencyKey, 'utf8')),
    expectedUpdatedAt,
    context,
    localTtsManifest: rawInput.localTtsManifest,
    minimumApprovedTextCharacters: rawInput.minimumApprovedTextCharacters,
    now: typeof rawInput.now === 'function' ? rawInput.now : () => new Date().toISOString(),
  };
  const initialStateFingerprint = claimStateFingerprint(input.db, input);
  const scope = readOwnedScope(input.db, input);
  const dialogue = readApprovedDialogueEvidence(input.db, input, scope);
  const profile = assignStableProfile(input, scope);
  if (claimStateFingerprint(input.db, input) !== initialStateFingerprint) {
    throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
  }
  return claimRegistration(input.db, input, { scope, dialogue, profile }, initialStateFingerprint);
}

function registerLocalProductionVoice(rawInput = {}) {
  try {
    return performRegistrationClaim(rawInput);
  } catch (error) {
    if (String(error?.code || '').startsWith('REDRAW_LOCAL_TTS_')
      && error.message === error.code) {
      throw error;
    }
    throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
  }
}

module.exports = {
  registerLocalProductionVoice,
};
