const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { canonicalManifestSha256 } = require('../src/services/redrawLocalTtsWorkerProcess');

const NOW = '2026-08-28T00:00:00.000Z';
const FACTS_HASH = 'a'.repeat(64);
const MANIFEST_SHA = 'b'.repeat(64);

function manifest(overrides = {}) {
  const requestedSha = overrides.manifest_sha256;
  const value = {
    schema_version: 'local-tts-manifest-v1',
    engine: 'eSpeak NG',
    engine_version: '1.52.0',
    executable_path: require('node:path').resolve('fixtures/espeak-ng'),
    executable_sha256: 'f'.repeat(64),
    profiles: [
      { profile_key: 'voice-anna', locale: 'en-US', voice: 'en-us', pitch: 42, rate: 170, amplitude: 100 },
      { profile_key: 'voice-ben', locale: 'en-US', voice: 'en-us', pitch: 55, rate: 185, amplitude: 95 },
    ],
    ...overrides,
  };
  delete value.manifest_sha256;
  value.manifest_sha256 = requestedSha || canonicalManifestSha256(value);
  return value;
}

function insertRegistrationFixture(db, overrides = {}) {
  const tenantId = overrides.tenantId || 'tenant-a';
  const userId = overrides.userId || 'user-a';
  const sourceFacts = overrides.sourceFacts || {
    schema_version: '2.0',
    facts_hash: FACTS_HASH,
    characters: [
      { id: 'char-b', source_name: 'Ben' },
      { id: 'char-a', source_name: 'Anna' },
    ],
    shots: [],
  };
  db.prepare(`
    INSERT INTO redraw_projects
      (id, tenant_id, user_id, title, default_locale, default_market, localization_level,
       status, policy_version, created_at, updated_at)
    VALUES (1, ?, ?, 'Local voices', 'en-US', 'US', 'faithful', 'active', 7, ?, ?)
  `).run(tenantId, userId, NOW, NOW);
  db.prepare(`
    INSERT INTO redraw_works
      (id, project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
       duration_ms, current_version, current_step, status, created_at, updated_at)
    VALUES (1, 1, ?, ?, 'Episode', 1, ?, 12000, ?, 2, 'asset_review', ?, ?)
  `).run(tenantId, userId, 'c'.repeat(64), overrides.workCurrentVersion || 1, NOW, NOW);
  const taskId = overrides.localizationTaskId || 'localization-task-1';
  const versionId = Number(db.prepare(`
    INSERT INTO redraw_versions
      (work_id, tenant_id, user_id, version, locale, market, localization_level,
       source_facts_json, facts_hash, localization_task_id, status, created_at, updated_at)
    VALUES (1, ?, ?, 1, 'en-US', 'US', 'faithful', ?, ?, ?, ?, ?, ?)
  `).run(
    tenantId,
    userId,
    JSON.stringify(sourceFacts),
    FACTS_HASH,
    taskId,
    overrides.versionStatus || 'asset_review',
    NOW,
    NOW,
  ).lastInsertRowid);
  const voiceAssetId = Number(db.prepare(`
    INSERT INTO redraw_assets
      (version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
       localized_description, prompt, version_number, approval_status, status, created_at, updated_at,
       deleted_at)
    VALUES (?, ?, ?, ?, ?, 'Anna', '', '', 1, 'pending', 'draft', ?, ?, ?)
  `).run(
    versionId,
    overrides.voiceTenantId || tenantId,
    overrides.voiceUserId || userId,
    overrides.voiceKind || 'voice',
    JSON.stringify({ source_ref: { kind: 'voice', source_character_key: overrides.sourceCharacterKey || 'char-a' } }),
    NOW,
    overrides.voiceUpdatedAt || NOW,
    overrides.voiceDeletedAt || null,
  ).lastInsertRowid);
  const insertShot = db.prepare(`
    INSERT INTO redraw_shots
      (work_id, shot_id, version_id, tenant_id, user_id, batch_index, shot_index,
       start_ms, end_ms, duration_ms, source_dialogue_json, localized_dialogue_json,
       references_json, opening_state, continuous_action, ending_state, prompt,
       negative_prompt, compiled_prompt_json, status, created_at, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 3000, '[]', ?, '[]', '', '', '', '', '', '{}', 'draft', ?, ?)
  `);
  const shots = overrides.shots || [
    {
      shotId: 'shot-2', batchIndex: 2, shotIndex: 1, startMs: 3000, endMs: 6000,
      dialogue: [{ speaker_id: 'char-a', target_text: 'Second approved line.' }],
    },
    {
      shotId: 'shot-1', batchIndex: 1, shotIndex: 2, startMs: 0, endMs: 3000,
      dialogue: [
        { speaker_id: 'char-b', target_text: 'Other speaker.' },
        { speaker_id: 'char-a', target_text: 'First approved line.', localized_text: 'Ignored fallback.' },
      ],
    },
  ];
  for (const shot of shots) {
    insertShot.run(
      shot.shotId,
      versionId,
      tenantId,
      userId,
      shot.batchIndex,
      shot.shotIndex,
      shot.startMs,
      shot.endMs,
      typeof shot.dialogue === 'string' ? shot.dialogue : JSON.stringify(shot.dialogue),
      NOW,
      NOW,
    );
  }
  const decision = {
    action: 'advance',
    effective_mode: 'auto',
    reason_codes: [],
    policy_version: 7,
    evidence_hash: FACTS_HASH,
    ...(overrides.decision || {}),
  };
  const result = {
    status: 'completed',
    work_id: 1,
    version_id: versionId,
    facts_hash: FACTS_HASH,
    localization_decision: decision,
    ...(overrides.taskResult || {}),
  };
  db.prepare(`
    INSERT INTO async_tasks
      (id, type, status, progress, result, resource_id, tenant_id, user_id,
       created_at, updated_at, completed_at, deleted_at)
    VALUES (?, 'redraw_localization', ?, 100, ?, '1', ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    overrides.taskStatus || 'completed',
    JSON.stringify(result),
    overrides.taskTenantId || tenantId,
    overrides.taskUserId || userId,
    NOW,
    NOW,
    NOW,
    overrides.taskDeletedAt || null,
  );
  return { tenantId, userId, versionId, voiceAssetId };
}

function registrationInput(db, fixture, overrides = {}) {
  return {
    db,
    tenantId: fixture.tenantId,
    userId: fixture.userId,
    versionId: fixture.versionId,
    voiceAssetId: fixture.voiceAssetId,
    idempotencyKey: 'claim-char-a',
    expectedUpdatedAt: NOW,
    localTtsManifest: manifest(),
    minimumApprovedTextCharacters: 10,
    now: () => NOW,
    ...overrides,
  };
}

function createRegistrationDb(overrides = {}) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  return { db, fixture: insertRegistrationFixture(db, overrides) };
}

function expectCode(code) {
  return (error) => error?.code === code && error.message === code;
}

function columnNames(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name);
}

test('local voice registration migration creates the exact scoped contract idempotently', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  runMigrationsAndEnsure(db);

  const table = db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'redraw_local_voice_registrations'
  `).get();
  assert.ok(table?.sql, 'redraw_local_voice_registrations table should exist');

  assert.deepEqual(columnNames(db, 'redraw_local_voice_registrations'), [
    'id',
    'tenant_id',
    'user_id',
    'version_id',
    'voice_redraw_asset_id',
    'source_character_key',
    'idempotency_hash',
    'request_hash',
    'target_locale',
    'target_market',
    'approved_text_sha256',
    'profile_key',
    'engine_manifest_sha256',
    'status',
    'audio_asset_id',
    'audio_sha256',
    'locale_evidence_sha256',
    'error_code',
    'error_message',
    'created_at',
    'updated_at',
    'completed_at',
    'deleted_at',
  ]);

  assert.match(
    table.sql,
    /status\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*status\s+IN\s*\(\s*'processing'\s*,\s*'completed'\s*,\s*'needs_attention'\s*,\s*'failed'\s*\)\s*\)/i,
  );

  const foreignKeys = db.prepare('PRAGMA foreign_key_list(redraw_local_voice_registrations)').all()
    .map((row) => [row.from, row.table, row.to])
    .sort((left, right) => left[0].localeCompare(right[0]));
  assert.deepEqual(foreignKeys, [
    ['version_id', 'redraw_versions', 'id'],
    ['voice_redraw_asset_id', 'redraw_assets', 'id'],
  ]);

  const indexes = db.prepare('PRAGMA index_list(redraw_local_voice_registrations)').all();
  const idempotencyIndex = indexes.find((row) => row.name === 'uq_redraw_local_voice_registration_idempotency');
  assert.equal(idempotencyIndex?.unique, 1);
  assert.equal(idempotencyIndex?.partial, 1);
  assert.deepEqual(
    db.prepare('PRAGMA index_info(uq_redraw_local_voice_registration_idempotency)').all().map((row) => row.name),
    ['tenant_id', 'user_id', 'version_id', 'voice_redraw_asset_id', 'idempotency_hash'],
  );
  const indexSql = db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'index'
      AND name = 'uq_redraw_local_voice_registration_idempotency'
  `).get().sql;
  assert.match(indexSql, /WHERE\s+deleted_at\s+IS\s+NULL/i);
});

test('local voice registration service exposes one narrow command', () => {
  const service = require('../src/services/redrawLocalVoiceRegistrationService');
  assert.deepEqual(Object.keys(service), ['registerLocalProductionVoice']);
});

test('owner claim derives approved dialogue in shot order and assigns a stable profile without side effects', (t) => {
  const { db, fixture } = createRegistrationDb();
  t.after(() => db.close());
  const { registerLocalProductionVoice } = require('../src/services/redrawLocalVoiceRegistrationService');
  const slotBefore = db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(fixture.voiceAssetId);
  const countsBefore = {
    media: db.prepare('SELECT COUNT(*) AS count FROM assets').get().count,
    reservations: db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count,
    ledger: db.prepare('SELECT COUNT(*) AS count FROM tenant_credit_ledger').get().count,
  };

  const claimed = registerLocalProductionVoice(registrationInput(db, fixture));

  assert.equal(claimed.replayed, false);
  assert.equal(claimed.registration.status, 'processing');
  assert.equal(claimed.registration.source_character_key, 'char-a');
  assert.equal(claimed.registration.profile_key, 'voice-anna');
  assert.equal(claimed.registration.approved_text_sha256,
    crypto.createHash('sha256').update('First approved line.\nSecond approved line.').digest('hex'));
  assert.equal(claimed.claim.approvedText, 'First approved line.\nSecond approved line.');
  assert.deepEqual(claimed.claim.profile, manifest().profiles[0]);
  assert.match(claimed.registration.idempotency_hash, /^[a-f0-9]{64}$/);
  assert.match(claimed.registration.request_hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(fixture.voiceAssetId), slotBefore);
  assert.deepEqual({
    media: db.prepare('SELECT COUNT(*) AS count FROM assets').get().count,
    reservations: db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count,
    ledger: db.prepare('SELECT COUNT(*) AS count FROM tenant_credit_ledger').get().count,
  }, countsBefore);
});

test('owner and localization decision failures close before a registration claim', (t) => {
  const cases = [
    ['wrong owner', {}, (input) => ({ ...input, tenantId: 'tenant-other' }), 'REDRAW_LOCAL_TTS_OWNER_MISMATCH'],
    ['wrong kind', { voiceKind: 'character' }, null, 'REDRAW_LOCAL_TTS_OWNER_MISMATCH'],
    ['deleted slot', { voiceDeletedAt: NOW }, null, 'REDRAW_LOCAL_TTS_OWNER_MISMATCH'],
    ['draft version', { versionStatus: 'draft' }, null, 'REDRAW_LOCAL_TTS_NOT_READY'],
    ['noncurrent version', { workCurrentVersion: 2 }, null, 'REDRAW_LOCAL_TTS_NOT_READY'],
    ['task owner drift', { taskUserId: 'user-other' }, null, 'REDRAW_LOCAL_TTS_NOT_READY'],
    ['task incomplete', { taskStatus: 'processing' }, null, 'REDRAW_LOCAL_TTS_NOT_READY'],
    ['task work drift', { taskResult: { work_id: 99 } }, null, 'REDRAW_LOCAL_TTS_NOT_READY'],
    ['decision action drift', { decision: { action: 'needs_review' } }, null, 'REDRAW_LOCAL_TTS_NOT_READY'],
    ['decision version drift', { taskResult: { version_id: 99 } }, null, 'REDRAW_LOCAL_TTS_NOT_READY'],
    ['decision facts drift', { taskResult: { facts_hash: 'd'.repeat(64) } }, null, 'REDRAW_LOCAL_TTS_NOT_READY'],
    ['decision evidence drift', { decision: { evidence_hash: 'd'.repeat(64) } }, null, 'REDRAW_LOCAL_TTS_NOT_READY'],
    ['decision policy drift', { decision: { policy_version: 8 } }, null, 'REDRAW_LOCAL_TTS_NOT_READY'],
  ];
  const databases = [];
  t.after(() => databases.forEach((db) => db.close()));
  const { registerLocalProductionVoice } = require('../src/services/redrawLocalVoiceRegistrationService');
  for (const [name, fixtureOverrides, inputPatch, code] of cases) {
    const { db, fixture } = createRegistrationDb(fixtureOverrides);
    databases.push(db);
    const input = registrationInput(db, fixture);
    assert.throws(() => registerLocalProductionVoice(inputPatch ? inputPatch(input) : input), expectCode(code), name);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_local_voice_registrations').get().count, 0, name);
  }
});

test('approved dialogue requires exact speaker text and never invents or falls back after invalid evidence', (t) => {
  const cases = [
    ['speaker mismatch', [{ shotId: 's1', batchIndex: 1, shotIndex: 1, startMs: 0, endMs: 3000,
      dialogue: [{ speaker_id: 'char-b', target_text: 'A sufficiently long line.' }] }]],
    ['blank target wins over fallback', [{ shotId: 's1', batchIndex: 1, shotIndex: 1, startMs: 0, endMs: 3000,
      dialogue: [{ speaker_id: 'char-a', target_text: '   ', localized_text: 'Must not be used.' }] }]],
    ['malformed dialogue', [{ shotId: 's1', batchIndex: 1, shotIndex: 1, startMs: 0, endMs: 3000,
      dialogue: '{not-json' }]],
    ['insufficient approved text', [{ shotId: 's1', batchIndex: 1, shotIndex: 1, startMs: 0, endMs: 3000,
      dialogue: [{ speaker_id: 'char-a', localized_text: 'Short' }] }]],
  ];
  const databases = [];
  t.after(() => databases.forEach((db) => db.close()));
  const { registerLocalProductionVoice } = require('../src/services/redrawLocalVoiceRegistrationService');
  for (const [name, shots] of cases) {
    const { db, fixture } = createRegistrationDb({ shots });
    databases.push(db);
    assert.throws(
      () => registerLocalProductionVoice(registrationInput(db, fixture)),
      expectCode('REDRAW_LOCAL_TTS_APPROVED_TEXT_INSUFFICIENT'),
      name,
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_local_voice_registrations').get().count, 0, name);
  }
});

test('approved dialogue rejects rows changed after the completed localization decision', (t) => {
  const { db, fixture } = createRegistrationDb();
  t.after(() => db.close());
  const { registerLocalProductionVoice } = require('../src/services/redrawLocalVoiceRegistrationService');
  db.prepare(`
    UPDATE redraw_shots
    SET localized_dialogue_json = ?, updated_at = '2026-08-28T00:00:01.000Z'
    WHERE version_id = ? AND batch_index = 1
  `).run(JSON.stringify([{ speaker_id: 'char-a', target_text: 'Changed after approval.' }]), fixture.versionId);

  assert.throws(
    () => registerLocalProductionVoice(registrationInput(db, fixture)),
    expectCode('REDRAW_LOCAL_TTS_NOT_READY'),
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_local_voice_registrations').get().count, 0);
});

test('stable profile assignment sorts every character key and fails closed when locale profiles are insufficient', (t) => {
  const databases = [];
  t.after(() => databases.forEach((db) => db.close()));
  const { registerLocalProductionVoice } = require('../src/services/redrawLocalVoiceRegistrationService');
  const first = createRegistrationDb();
  databases.push(first.db);
  const charB = first.db.prepare(`
    INSERT INTO redraw_assets
      (version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
       localized_description, prompt, version_number, approval_status, status, created_at, updated_at)
    VALUES (?, ?, ?, 'voice', ?, 'Ben', '', '', 1, 'pending', 'draft', ?, ?)
  `).run(
    first.fixture.versionId,
    first.fixture.tenantId,
    first.fixture.userId,
    JSON.stringify({ source_ref: { kind: 'voice', source_character_key: 'char-b' } }),
    NOW,
    NOW,
  );
  const claimedB = registerLocalProductionVoice(registrationInput(first.db, {
    ...first.fixture,
    voiceAssetId: Number(charB.lastInsertRowid),
  }, { idempotencyKey: 'claim-char-b' }));
  assert.equal(claimedB.registration.profile_key, 'voice-ben');

  const second = createRegistrationDb();
  databases.push(second.db);
  assert.throws(() => registerLocalProductionVoice(registrationInput(second.db, second.fixture, {
    localTtsManifest: manifest({ profiles: [manifest().profiles[0]] }),
  })), expectCode('REDRAW_LOCAL_TTS_NOT_READY'));
  assert.equal(second.db.prepare('SELECT COUNT(*) AS count FROM redraw_local_voice_registrations').get().count, 0);
});

test('stable profile claim rejects malformed engine manifests and execution profiles', (t) => {
  const cases = [
    ['schema version', (value) => ({ ...value, schema_version: 'other' })],
    ['engine', (value) => ({ ...value, engine: 'other' })],
    ['engine version', (value) => ({ ...value, engine_version: '' })],
    ['manifest sha', (value) => ({ ...value, manifest_sha256: MANIFEST_SHA })],
    ['missing voice', (value) => ({ ...value, profiles: value.profiles.map((profile, index) => (
      index === 0 ? { ...profile, voice: undefined } : profile
    )) })],
    ['pitch range', (value) => ({ ...value, profiles: value.profiles.map((profile, index) => (
      index === 0 ? { ...profile, pitch: 100 } : profile
    )) })],
    ['rate range', (value) => ({ ...value, profiles: value.profiles.map((profile, index) => (
      index === 0 ? { ...profile, rate: 0 } : profile
    )) })],
    ['amplitude range', (value) => ({ ...value, profiles: value.profiles.map((profile, index) => (
      index === 0 ? { ...profile, amplitude: 201 } : profile
    )) })],
    ['duplicate profile', (value) => ({ ...value, profiles: value.profiles.map((profile) => ({
      ...profile, profile_key: 'same-profile',
    })) })],
    ['cross-locale duplicate profile', (value) => ({
      ...value,
      profiles: [...value.profiles, { ...value.profiles[0], locale: 'es-ES' }],
    })],
  ];
  const databases = [];
  t.after(() => databases.forEach((db) => db.close()));
  const { registerLocalProductionVoice } = require('../src/services/redrawLocalVoiceRegistrationService');
  for (const [name, mutate] of cases) {
    const { db, fixture } = createRegistrationDb();
    databases.push(db);
    const changed = mutate(manifest());
    if (name !== 'manifest sha') {
      delete changed.manifest_sha256;
      changed.manifest_sha256 = canonicalManifestSha256(changed);
    }
    assert.throws(
      () => registerLocalProductionVoice(registrationInput(db, fixture, { localTtsManifest: changed })),
      expectCode('REDRAW_LOCAL_TTS_NOT_READY'),
      name,
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_local_voice_registrations').get().count, 0, name);
  }
});

test('stable profile claim rejects a test-only manifest in production context', (t) => {
  const { db, fixture } = createRegistrationDb();
  t.after(() => db.close());
  const { registerLocalProductionVoice } = require('../src/services/redrawLocalVoiceRegistrationService');
  assert.throws(
    () => registerLocalProductionVoice(registrationInput(db, fixture, {
      localTtsManifest: manifest({ test_only: true }),
    })),
    expectCode('REDRAW_LOCAL_TTS_NOT_READY'),
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_local_voice_registrations').get().count, 0);
});

test('stable profile claim permits an explicitly isolated test-only manifest only in test context', (t) => {
  const { db, fixture } = createRegistrationDb();
  t.after(() => db.close());
  const { registerLocalProductionVoice } = require('../src/services/redrawLocalVoiceRegistrationService');
  const testManifest = manifest({ test_only: true });
  const claimed = registerLocalProductionVoice(registrationInput(db, fixture, {
    context: 'test',
    localTtsManifest: testManifest,
  }));
  assert.equal(claimed.registration.engine_manifest_sha256, testManifest.manifest_sha256);
  assert.equal(claimed.registration.status, 'processing');
});

test('idempotency replays the same claim and rejects changed request evidence without starting a worker', (t) => {
  const { db, fixture } = createRegistrationDb();
  t.after(() => db.close());
  const { registerLocalProductionVoice } = require('../src/services/redrawLocalVoiceRegistrationService');
  let workerCalls = 0;
  const base = registrationInput(db, fixture, {
    localTtsWorker: { synthesize() { workerCalls += 1; } },
  });
  const first = registerLocalProductionVoice(base);
  const replay = registerLocalProductionVoice(base);
  assert.equal(replay.replayed, true);
  assert.equal(replay.registration.id, first.registration.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_local_voice_registrations').get().count, 1);
  assert.equal(workerCalls, 0);

  db.prepare('UPDATE redraw_assets SET updated_at = ? WHERE id = ?')
    .run('2026-08-28T00:00:02.000Z', fixture.voiceAssetId);
  const replayAfterSlotCompletion = registerLocalProductionVoice(base);
  assert.equal(replayAfterSlotCompletion.replayed, true);
  assert.equal(replayAfterSlotCompletion.registration.id, first.registration.id);
  assert.equal(workerCalls, 0);

  assert.throws(() => registerLocalProductionVoice({
    ...base,
    localTtsManifest: manifest({ engine_version: '1.52.1' }),
  }), expectCode('REDRAW_LOCAL_TTS_IDEMPOTENCY_CONFLICT'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_local_voice_registrations').get().count, 1);
  assert.equal(workerCalls, 0);
});

test('claim rejects a stale voice slot CAS before creating any process or registration', (t) => {
  const { db, fixture } = createRegistrationDb();
  t.after(() => db.close());
  const { registerLocalProductionVoice } = require('../src/services/redrawLocalVoiceRegistrationService');
  let workerCalls = 0;
  assert.throws(() => registerLocalProductionVoice(registrationInput(db, fixture, {
    expectedUpdatedAt: '2026-08-27T00:00:00.000Z',
    localTtsWorker: { synthesize() { workerCalls += 1; } },
  })), expectCode('REDRAW_LOCAL_TTS_CAS_CONFLICT'));
  assert.equal(workerCalls, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_local_voice_registrations').get().count, 0);
});

test('claim redacts unexpected database diagnostics', () => {
  const { registerLocalProductionVoice } = require('../src/services/redrawLocalVoiceRegistrationService');
  assert.throws(() => registerLocalProductionVoice({
    ...registrationInput({ prepare() { throw new Error('C:\\private\\voice.wav API_KEY=secret approved words'); } }, {
      tenantId: 'tenant-a', userId: 'user-a', versionId: 1, voiceAssetId: 1,
    }),
  }), expectCode('REDRAW_LOCAL_TTS_NOT_READY'));
});
