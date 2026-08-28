const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const defaultAssetService = require('./assetService');

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
const BILLING_ZERO = Object.freeze({ credits: 0, held: 0, charged: 0 });
const LOCAL_VOICE_CONTRACT_VERSION = 'local-offline-tts-v1';
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const MIN_AUDIO_DURATION_MS = 1000;
const MAX_AUDIO_DURATION_MS = 120000;
const MEDIA_PROBE_TIMEOUT_MS = 30000;
const MEDIA_PROBE_OUTPUT_BYTES = 64 * 1024;
const WORKER_RESULT_KEYS = [
  'source',
  'engine',
  'engine_version',
  'binary_sha256',
  'manifest_sha256',
  'target_locale',
  'output_path',
  'output_sha256',
  'profile',
  'completed_at',
];
const PROBE_RESULT_KEYS = [
  'format',
  'audio_streams',
  'decodable',
  'non_silent',
  'duration_ms',
  'size_bytes',
];

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
        projectId: Number(derived.scope.version.project_id),
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

function comparablePath(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function realpath(value) {
  return fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);
}

function inspectRealPath(targetPath, kind, code = 'REDRAW_LOCAL_TTS_OUTPUT_INVALID') {
  try {
    if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) throw new Error();
    const lstat = fs.lstatSync(targetPath);
    if (lstat.isSymbolicLink()) throw new Error();
    if (kind === 'file' ? !lstat.isFile() : !lstat.isDirectory()) throw new Error();
    const resolved = realpath(targetPath);
    if (!samePath(resolved, targetPath)) throw new Error();
    return {
      path: resolved,
      dev: lstat.dev,
      ino: lstat.ino,
      size: lstat.size,
    };
  } catch (_) {
    throw codedError(code);
  }
}

function sameIdentity(left, right) {
  return samePath(left.path, right.path) && left.dev === right.dev && left.ino === right.ino;
}

function strictDescendant(rootPath, childPath) {
  const relative = path.relative(rootPath, childPath);
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function assertWaveMagic(bytes) {
  if (!Buffer.isBuffer(bytes)
    || bytes.length < 44
    || bytes.length > MAX_AUDIO_BYTES
    || bytes.subarray(0, 4).toString('ascii') !== 'RIFF'
    || bytes.subarray(8, 12).toString('ascii') !== 'WAVE'
    || bytes.readUInt32LE(4) !== bytes.length - 8) {
    throw codedError('REDRAW_LOCAL_TTS_OUTPUT_INVALID');
  }
}

function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function readVerifiedSourceFile(stagingIdentity, outputPath, reportedSha256) {
  const fileIdentity = inspectRealPath(outputPath, 'file');
  if (!strictDescendant(stagingIdentity.path, fileIdentity.path)
    || fileIdentity.size < 44
    || fileIdentity.size > MAX_AUDIO_BYTES
    || !SHA256.test(String(reportedSha256 || ''))) {
    throw codedError('REDRAW_LOCAL_TTS_OUTPUT_INVALID');
  }
  const bytes = fs.readFileSync(fileIdentity.path);
  assertWaveMagic(bytes);
  const audioSha256 = sha256(bytes);
  if (audioSha256 !== reportedSha256) throw codedError('REDRAW_LOCAL_TTS_OUTPUT_INVALID');
  return { bytes, identity: fileIdentity, audioSha256 };
}

function revalidateSourceFile(stagingIdentity, before, outputPath) {
  const stagingAfter = inspectRealPath(stagingIdentity.path, 'directory');
  if (!sameIdentity(stagingAfter, stagingIdentity)) throw codedError('REDRAW_LOCAL_TTS_OUTPUT_INVALID');
  const after = inspectRealPath(outputPath, 'file');
  if (!sameIdentity(after, before.identity)
    || after.size !== before.identity.size
    || sha256File(after.path) !== before.audioSha256) {
    throw codedError('REDRAW_LOCAL_TTS_OUTPUT_INVALID');
  }
}

function validateWorkerResult(result, claim, manifest, worker) {
  const keys = manifest.test_only === true ? [...WORKER_RESULT_KEYS, 'test_only'] : WORKER_RESULT_KEYS;
  if (!exactObject(result, keys)
    || result.source !== 'local_offline_tts'
    || result.engine !== manifest.engine
    || result.engine_version !== manifest.engine_version
    || result.binary_sha256 !== manifest.executable_sha256
    || result.manifest_sha256 !== claim.engineManifestSha256
    || result.target_locale !== claim.locale
    || !exactObject(result.profile, PROFILE_KEYS)
    || stableJson(result.profile) !== stableJson(claim.profile)
    || !Number.isFinite(Date.parse(String(result.completed_at || '')))
    || (manifest.test_only === true && result.test_only !== true)) {
    throw codedError('REDRAW_LOCAL_TTS_OUTPUT_INVALID');
  }
  const invocation = {
    source: result.source,
    engine: result.engine,
    engine_version: result.engine_version,
    binary_sha256: result.binary_sha256,
    manifest_sha256: result.manifest_sha256,
    profile: result.profile.profile_key,
    target_locale: result.target_locale,
    ...(manifest.test_only === true ? { test_only: true } : {}),
  };
  let trusted;
  try {
    trusted = worker.assertEvidenceTrusted(invocation);
  } catch (error) {
    if (error?.code === 'REDRAW_LOCAL_TTS_NOT_READY') throw error;
    throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
  }
  if (!trusted || stableJson(trusted.profile) !== stableJson(claim.profile)) {
    throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
  }
  return {
    engine: result.engine,
    engineVersion: result.engine_version,
    binarySha256: result.binary_sha256,
    manifestSha256: result.manifest_sha256,
    profile: result.profile.profile_key,
    testOnly: result.test_only === true,
  };
}

function validateProbeResult(probe, expectedSize) {
  if (!exactObject(probe, PROBE_RESULT_KEYS)
    || probe.format !== 'wav'
    || !Number.isInteger(probe.audio_streams)
    || probe.audio_streams < 1
    || probe.decodable !== true
    || probe.non_silent !== true
    || !Number.isFinite(probe.duration_ms)
    || probe.duration_ms < MIN_AUDIO_DURATION_MS
    || probe.duration_ms > MAX_AUDIO_DURATION_MS
    || !Number.isSafeInteger(probe.size_bytes)
    || probe.size_bytes !== expectedSize
    || probe.size_bytes < 44
    || probe.size_bytes > MAX_AUDIO_BYTES) {
    throw codedError('REDRAW_LOCAL_TTS_OUTPUT_INVALID');
  }
  return { durationMs: probe.duration_ms, sizeBytes: probe.size_bytes };
}

function validateLocaleEvidence(evidence, expected) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
    || evidence.requestId !== expected.requestId
    || evidence.source !== 'offline-worker'
    || evidence.audioSha256 !== expected.audioSha256
    || evidence.approvedTextSha256 !== expected.approvedTextSha256
    || evidence.localePack !== expected.pack.id
    || evidence.modelManifestSha256 !== expected.pack.model_manifest_sha256
    || evidence.calibrationManifestSha256 !== expected.pack.calibration_manifest_sha256
    || evidence.languageVerified !== true
    || evidence.detectedLocale !== expected.locale
    || stableJson(evidence.localTtsInvocation) !== stableJson(expected.invocation)
    || !SHA256.test(String(evidence.transcriptSha256 || ''))
    || !Number.isFinite(Date.parse(String(evidence.completedAt || '')))) {
    throw codedError('REDRAW_LOCAL_TTS_VERIFICATION_FAILED');
  }
  return evidence;
}

function createStagingRoot(allowedRoot, registrationId) {
  const allowedIdentity = inspectRealPath(allowedRoot, 'directory', 'REDRAW_LOCAL_TTS_NOT_READY');
  let stagingPath;
  try {
    stagingPath = fs.mkdtempSync(path.join(allowedIdentity.path, `redraw-local-voice-${registrationId}-`));
  } catch (_) {
    throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
  }
  const stagingIdentity = inspectRealPath(stagingPath, 'directory');
  if (!strictDescendant(allowedIdentity.path, stagingIdentity.path)) {
    throw codedError('REDRAW_LOCAL_TTS_OUTPUT_INVALID');
  }
  return { allowedIdentity, stagingIdentity };
}

function ensureContentDirectory(storageRoot) {
  const storageIdentity = inspectRealPath(storageRoot, 'directory', 'REDRAW_LOCAL_TTS_NOT_READY');
  const contentPath = path.join(storageIdentity.path, 'redraw-local-voices');
  let created = false;
  if (!fs.existsSync(contentPath)) {
    try {
      fs.mkdirSync(contentPath, { mode: 0o700 });
      created = true;
    } catch (_) {
      throw codedError('REDRAW_LOCAL_TTS_OUTPUT_INVALID');
    }
  }
  const contentIdentity = inspectRealPath(contentPath, 'directory');
  if (!strictDescendant(storageIdentity.path, contentIdentity.path)) {
    throw codedError('REDRAW_LOCAL_TTS_OUTPUT_INVALID');
  }
  return { contentIdentity, created };
}

function validateContentFile(targetPath, contentIdentity, audioSha256) {
  const target = inspectRealPath(targetPath, 'file');
  if (!strictDescendant(contentIdentity.path, target.path)
    || target.size < 44
    || target.size > MAX_AUDIO_BYTES
    || sha256File(target.path) !== audioSha256) {
    throw codedError('REDRAW_LOCAL_TTS_OUTPUT_INVALID');
  }
  return target;
}

function writeContentAddressedFile(storageRoot, bytes, audioSha256) {
  const { contentIdentity, created: directoryCreated } = ensureContentDirectory(storageRoot);
  const targetPath = path.join(contentIdentity.path, `${audioSha256}.wav`);
  const temporaryPath = path.join(contentIdentity.path, `.${audioSha256}.${crypto.randomUUID()}.tmp`);
  let descriptor;
  let published = false;
  if (fs.existsSync(targetPath)) {
    validateContentFile(targetPath, contentIdentity, audioSha256);
  } else {
    try {
      descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      validateContentFile(temporaryPath, contentIdentity, audioSha256);
      try {
        fs.linkSync(temporaryPath, targetPath);
        published = true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        validateContentFile(targetPath, contentIdentity, audioSha256);
      }
      validateContentFile(targetPath, contentIdentity, audioSha256);
    } catch (_) {
      throw codedError('REDRAW_LOCAL_TTS_OUTPUT_INVALID');
    } finally {
      if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch (_) {}
      try { fs.unlinkSync(temporaryPath); } catch (_) {}
    }
  }
  return {
    created: published,
    directoryCreated,
    targetPath,
    relativePath: `redraw-local-voices/${audioSha256}.wav`,
  };
}

function safeCleanupStaging(staging, allowed) {
  if (!staging || !allowed) return;
  try {
    const lstat = fs.lstatSync(staging.path);
    if (lstat.isSymbolicLink()) return;
    const current = inspectRealPath(staging.path, 'directory');
    if (!sameIdentity(current, staging) || !strictDescendant(allowed.path, current.path)) return;
    fs.rmSync(current.path, { recursive: true, force: true });
  } catch (_) {}
}

function reconcileRegisteredAsset(rawInput, registration, content, audioSha256, projectId) {
  if (!content || !audioSha256) return null;
  try {
    const rows = rawInput.db.prepare(`
      SELECT *
      FROM assets
      WHERE local_path = ? AND type = 'audio' AND deleted_at IS NULL
      ORDER BY id DESC
    `).all(content.relativePath);
    for (const row of rows) {
      const metadata = parseObject(row.metadata, 'REDRAW_LOCAL_TTS_RESULT_UNKNOWN');
      if (metadata.source === 'local_offline_tts'
        && String(metadata.tenant_id || '') === String(rawInput.tenantId)
        && String(metadata.user_id || '') === String(rawInput.userId)
        && Number(metadata.version_id) === Number(rawInput.versionId)
        && Number(metadata.voice_redraw_asset_id) === Number(rawInput.voiceAssetId)
        && Number(metadata.registration_id) === Number(registration.id)
        && metadata.audio_sha256 === audioSha256
        && row.type === 'audio'
        && row.category === 'redraw-local-voice'
        && row.mime_type === 'audio/wav'
        && Number(row.drama_id) === Number(projectId)) {
        return row;
      }
    }
    return null;
  } catch (_) {
    throw codedError('REDRAW_LOCAL_TTS_RESULT_UNKNOWN');
  }
}

function nextUpdatedAt(expectedUpdatedAt, now) {
  const candidate = String(now());
  const expectedMillis = Date.parse(expectedUpdatedAt);
  const candidateMillis = Date.parse(candidate);
  if (!Number.isFinite(candidateMillis)) throw codedError('REDRAW_LOCAL_TTS_RESULT_UNKNOWN');
  if (candidateMillis > expectedMillis) return candidate;
  return new Date(expectedMillis + 1).toISOString();
}

function finalEvidence(rawInput, claim, registration, asset, media, invocation, localeEvidence, completedAt) {
  return {
    source: 'local_offline_tts',
    contract_version: LOCAL_VOICE_CONTRACT_VERSION,
    tenant_id: rawInput.tenantId,
    user_id: rawInput.userId,
    version_id: Number(rawInput.versionId),
    voice_redraw_asset_id: Number(rawInput.voiceAssetId),
    source_character_key: registration.source_character_key,
    locale: registration.target_locale,
    market: registration.target_market,
    profile: registration.profile_key,
    engine: invocation.engine,
    engine_version: invocation.engineVersion,
    binary_sha256: invocation.binarySha256,
    manifest_sha256: invocation.manifestSha256,
    audio_asset_id: Number(asset.id),
    audio_sha256: localeEvidence.audioSha256,
    duration_ms: media.durationMs,
    approved_text_sha256: registration.approved_text_sha256,
    locale_pack: localeEvidence.localePack,
    transcript_sha256: localeEvidence.transcriptSha256,
    model_manifest_sha256: localeEvidence.modelManifestSha256,
    calibration_manifest_sha256: localeEvidence.calibrationManifestSha256,
    metrics: structuredClone(localeEvidence.metrics),
    language_verified: true,
    detected_locale: localeEvidence.detectedLocale,
    registration_id: Number(registration.id),
    registration_status: 'completed',
    completed_at: completedAt,
    ...(invocation.testOnly ? { test_only: true } : {}),
  };
}

function completeRegistrationTransaction(rawInput, claim, registration, asset, evidence, evidenceSha256, audioSha256) {
  const db = rawInput.db;
  const updatedAt = nextUpdatedAt(claim.expectedUpdatedAt, rawInput.now || (() => new Date().toISOString()));
  return db.transaction(() => {
    const slot = db.prepare(`
      SELECT source_ref_json, updated_at, voice_asset_id
      FROM redraw_assets
      WHERE id = ? AND version_id = ? AND tenant_id = ? AND user_id = ?
        AND kind = 'voice' AND deleted_at IS NULL
    `).get(rawInput.voiceAssetId, rawInput.versionId, rawInput.tenantId, rawInput.userId);
    if (!slot || String(slot.updated_at || '') !== claim.expectedUpdatedAt || slot.voice_asset_id != null) {
      throw codedError('REDRAW_LOCAL_TTS_CAS_CONFLICT');
    }
    const payload = parseObject(slot.source_ref_json, 'REDRAW_LOCAL_TTS_RESULT_UNKNOWN');
    const snapshot = payload.snapshot && typeof payload.snapshot === 'object' && !Array.isArray(payload.snapshot)
      ? payload.snapshot : {};
    const completedAt = evidence.completed_at;
    const updated = db.prepare(`
      UPDATE redraw_assets
      SET voice_asset_id = ?, source_ref_json = ?, status = 'generated', approval_status = 'pending',
          approved_by = NULL, approved_at = NULL, error_code = NULL, error_message = NULL, updated_at = ?
      WHERE id = ? AND version_id = ? AND tenant_id = ? AND user_id = ?
        AND kind = 'voice' AND voice_asset_id IS NULL AND updated_at = ? AND deleted_at IS NULL
    `).run(
      Number(asset.id),
      JSON.stringify({ ...payload, snapshot: { ...snapshot, voice_evidence: evidence } }),
      updatedAt,
      rawInput.voiceAssetId,
      rawInput.versionId,
      rawInput.tenantId,
      rawInput.userId,
      claim.expectedUpdatedAt,
    );
    if (updated.changes !== 1) throw codedError('REDRAW_LOCAL_TTS_CAS_CONFLICT');
    const registrationUpdate = db.prepare(`
      UPDATE redraw_local_voice_registrations
      SET status = 'completed', audio_asset_id = ?, audio_sha256 = ?, locale_evidence_sha256 = ?,
          error_code = NULL, error_message = NULL, updated_at = ?, completed_at = ?
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'processing' AND deleted_at IS NULL
    `).run(
      Number(asset.id),
      audioSha256,
      evidenceSha256,
      updatedAt,
      completedAt,
      Number(registration.id),
      rawInput.tenantId,
      rawInput.userId,
    );
    if (registrationUpdate.changes !== 1) throw codedError('REDRAW_LOCAL_TTS_RESULT_UNKNOWN');
    return db.prepare('SELECT * FROM redraw_local_voice_registrations WHERE id = ?').get(Number(registration.id));
  }).immediate();
}

function markRegistration(rawInput, registration, status, code, asset, audioSha256) {
  const now = String((rawInput.now || (() => new Date().toISOString()))());
  try {
    const updated = rawInput.db.prepare(`
      UPDATE redraw_local_voice_registrations
      SET status = ?, audio_asset_id = ?, audio_sha256 = ?, error_code = ?, error_message = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'processing' AND deleted_at IS NULL
    `).run(
      status,
      asset?.id ? Number(asset.id) : null,
      audioSha256 || null,
      code,
      code,
      now,
      Number(registration.id),
      rawInput.tenantId,
      rawInput.userId,
    );
    if (updated.changes !== 1) throw codedError('REDRAW_LOCAL_TTS_RESULT_UNKNOWN');
  } catch (_) {
    throw codedError('REDRAW_LOCAL_TTS_RESULT_UNKNOWN');
  }
}

function executionDependencies(rawInput) {
  const worker = rawInput.localTtsWorker;
  const verifier = rawInput.localeVerifier;
  const registry = rawInput.localeRegistry;
  const probe = rawInput.mediaProbe;
  const assetService = rawInput.assetService || defaultAssetService;
  if (!worker || typeof worker.synthesize !== 'function' || typeof worker.assertReady !== 'function'
    || typeof worker.assertEvidenceTrusted !== 'function'
    || !verifier || typeof verifier.verifyLocalVoice !== 'function'
    || !registry || typeof registry.assertReady !== 'function'
    || !probe || typeof probe.probeAudio !== 'function'
    || !assetService || typeof assetService.create !== 'function'
    || typeof rawInput.localeVerifierAllowedRoot !== 'string'
    || typeof rawInput.audioStorageRoot !== 'string') {
    return null;
  }
  return { worker, verifier, registry, probe, assetService };
}

function errorCodeForStage(error, stage) {
  const code = String(error?.code || '');
  if (['REDRAW_LOCAL_TTS_NOT_READY', 'REDRAW_LOCAL_TTS_OUTPUT_INVALID',
    'REDRAW_LOCAL_TTS_VERIFICATION_FAILED', 'REDRAW_LOCAL_TTS_RESULT_UNKNOWN',
    'REDRAW_LOCAL_TTS_CAS_CONFLICT'].includes(code)) return code;
  if (code === 'REDRAW_LOCALE_VERIFIER_TIMEOUT' || code === 'REDRAW_LOCALE_VERIFIER_ABORTED'
    || code === 'REDRAW_LOCALE_VERIFIER_CONNECTION_FAILED') {
    return 'REDRAW_LOCAL_TTS_RESULT_UNKNOWN';
  }
  if (stage === 'worker' || stage === 'asset' || stage === 'finalize') {
    return 'REDRAW_LOCAL_TTS_RESULT_UNKNOWN';
  }
  if (stage === 'verifier') return 'REDRAW_LOCAL_TTS_VERIFICATION_FAILED';
  return 'REDRAW_LOCAL_TTS_OUTPUT_INVALID';
}

async function executeRegistration(rawInput, claimed, deps) {
  const registration = claimed.registration;
  const claim = claimed.claim;
  let staging = null;
  let allowed = null;
  let content = null;
  let asset = null;
  let audioSha256 = null;
  let stage = 'worker';
  try {
    deps.worker.assertReady(claim.locale);
    const pack = deps.registry.assertReady(claim.locale);
    if (!pack || pack.locale !== claim.locale || !String(pack.id || '').trim()
      || !SHA256.test(String(pack.model_manifest_sha256 || ''))
      || !SHA256.test(String(pack.calibration_manifest_sha256 || ''))) {
      throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
    }
    ({ allowedIdentity: allowed, stagingIdentity: staging } = createStagingRoot(
      rawInput.localeVerifierAllowedRoot,
      registration.id,
    ));
    const workerInput = {
      requestId: claim.requestId,
      approvedText: claim.approvedText,
      locale: claim.locale,
      profileKey: claim.profile.profile_key,
      outputRoot: staging.path,
      ...(rawInput.signal !== undefined ? { signal: rawInput.signal } : {}),
    };
    const workerResult = await deps.worker.synthesize(workerInput);
    const invocation = validateWorkerResult(workerResult, claim, rawInput.localTtsManifest, deps.worker);
    const source = readVerifiedSourceFile(staging, workerResult.output_path, workerResult.output_sha256);
    audioSha256 = source.audioSha256;

    stage = 'media';
    const probe = await deps.probe.probeAudio({
      requestId: claim.requestId,
      audioPath: source.identity.path,
      timeoutMs: MEDIA_PROBE_TIMEOUT_MS,
      maxOutputBytes: MEDIA_PROBE_OUTPUT_BYTES,
      ...(rawInput.signal !== undefined ? { signal: rawInput.signal } : {}),
    });
    const media = validateProbeResult(probe, source.identity.size);
    revalidateSourceFile(staging, source, workerResult.output_path);

    stage = 'verifier';
    const verifierInput = {
      requestId: claim.requestId,
      audioPath: source.identity.path,
      audioSha256,
      approvedText: claim.approvedText,
      locale: claim.locale,
      localTtsInvocation: {
        engine: invocation.engine,
        engineVersion: invocation.engineVersion,
        binarySha256: invocation.binarySha256,
        manifestSha256: invocation.manifestSha256,
        profile: invocation.profile,
      },
      ...(rawInput.signal !== undefined ? { signal: rawInput.signal } : {}),
    };
    const localeEvidence = validateLocaleEvidence(
      await deps.verifier.verifyLocalVoice(verifierInput),
      {
        requestId: claim.requestId,
        audioSha256,
        approvedTextSha256: claim.approvedTextSha256,
        locale: claim.locale,
        invocation: verifierInput.localTtsInvocation,
        pack,
      },
    );
    revalidateSourceFile(staging, source, workerResult.output_path);

    stage = 'media';
    content = writeContentAddressedFile(rawInput.audioStorageRoot, source.bytes, audioSha256);
    stage = 'asset';
    const assetPayload = {
      drama_id: claim.projectId,
      name: `local-voice-${registration.id}`,
      type: 'audio',
      category: 'redraw-local-voice',
      url: content.relativePath,
      local_path: content.relativePath,
      file_size: media.sizeBytes,
      mime_type: 'audio/wav',
      duration: media.durationMs / 1000,
      metadata: {
        source: 'local_offline_tts',
        tenant_id: rawInput.tenantId,
        user_id: rawInput.userId,
        version_id: Number(rawInput.versionId),
        voice_redraw_asset_id: Number(rawInput.voiceAssetId),
        registration_id: Number(registration.id),
        audio_sha256: audioSha256,
      },
    };
    const createdAsset = deps.assetService.create(rawInput.db, rawInput.log, assetPayload);
    const reconciledAsset = reconcileRegisteredAsset(
      rawInput,
      registration,
      content,
      audioSha256,
      claim.projectId,
    );
    if (!createdAsset || !positiveId(createdAsset.id)
      || !reconciledAsset
      || Number(createdAsset.id) !== Number(reconciledAsset.id)
      || createdAsset.type !== assetPayload.type
      || createdAsset.category !== assetPayload.category
      || createdAsset.local_path !== assetPayload.local_path
      || createdAsset.mime_type !== assetPayload.mime_type
      || Number(createdAsset.drama_id) !== Number(assetPayload.drama_id)) {
      throw codedError('REDRAW_LOCAL_TTS_RESULT_UNKNOWN');
    }
    asset = reconciledAsset;

    stage = 'finalize';
    const completedAt = String(localeEvidence.completedAt);
    const evidence = finalEvidence(
      rawInput,
      claim,
      registration,
      asset,
      media,
      invocation,
      localeEvidence,
      completedAt,
    );
    const evidenceSha256 = sha256(Buffer.from(stableJson(localeEvidence), 'utf8'));
    const completed = completeRegistrationTransaction(
      rawInput,
      claim,
      registration,
      asset,
      evidence,
      evidenceSha256,
      audioSha256,
    );
    return { registration: completed, replayed: false, claim: null, billing: { ...BILLING_ZERO } };
  } catch (error) {
    const code = errorCodeForStage(error, stage);
    const needsAttention = code === 'REDRAW_LOCAL_TTS_RESULT_UNKNOWN'
      || code === 'REDRAW_LOCAL_TTS_CAS_CONFLICT';
    if (!asset && stage === 'asset') {
      asset = reconcileRegisteredAsset(rawInput, registration, content, audioSha256, claim.projectId);
    }
    markRegistration(rawInput, registration, needsAttention ? 'needs_attention' : 'failed', code, asset, audioSha256);
    throw codedError(code);
  } finally {
    safeCleanupStaging(staging, allowed);
  }
}

function registerLocalProductionVoice(rawInput = {}) {
  try {
    const claimed = performRegistrationClaim(rawInput);
    const deps = executionDependencies(rawInput);
    if (!claimed.claim) return { ...claimed, billing: { ...BILLING_ZERO } };
    if (rawInput.context === 'test' && rawInput.claimOnly === true) {
      return { ...claimed, billing: { ...BILLING_ZERO } };
    }
    if (!deps) {
      markRegistration(
        rawInput,
        claimed.registration,
        'failed',
        'REDRAW_LOCAL_TTS_NOT_READY',
        null,
        null,
      );
      throw codedError('REDRAW_LOCAL_TTS_NOT_READY');
    }
    return executeRegistration(rawInput, claimed, deps).catch((error) => {
      if (String(error?.code || '').startsWith('REDRAW_LOCAL_TTS_') && error.message === error.code) {
        throw error;
      }
      throw codedError('REDRAW_LOCAL_TTS_RESULT_UNKNOWN');
    });
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
