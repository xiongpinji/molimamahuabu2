const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const realAssetService = require('../src/services/assetService');
const { canonicalManifestSha256 } = require('../src/services/redrawLocalTtsWorkerProcess');

const NOW = '2026-08-28T00:00:00.000Z';
const FACTS_HASH = 'a'.repeat(64);
const MANIFEST_SHA = 'b'.repeat(64);

function stableJson(value) {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(',')}}`;
}

function legacyRegistrationRequestHash(
  fixture,
  input,
  approvedText = 'First approved line.\nSecond approved line.',
) {
  return crypto.createHash('sha256').update(Buffer.from(stableJson({
    tenant_id: fixture.tenantId,
    user_id: fixture.userId,
    version_id: fixture.versionId,
    voice_redraw_asset_id: fixture.voiceAssetId,
    source_character_key: 'char-a',
    target_locale: 'en-US',
    target_market: 'US',
    facts_hash: FACTS_HASH,
    policy_version: 7,
    approved_text_sha256: crypto.createHash('sha256').update(approvedText, 'utf8').digest('hex'),
    profile: manifest().profiles[0],
    engine_manifest_sha256: input.localTtsManifest.manifest_sha256,
    expected_updated_at: input.expectedUpdatedAt,
    runtime_context: input.context,
  }), 'utf8')).digest('hex');
}

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
    context: 'test',
    claimOnly: true,
    now: () => NOW,
    ...overrides,
  };
}

function createRegistrationDb(overrides = {}) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  return { db, fixture: insertRegistrationFixture(db, overrides) };
}

function createSupplementalRegistrationDb(overrides = {}) {
  const shots = overrides.shots || [
    {
      shotId: 'shot-late', batchIndex: 2, shotIndex: 1, startMs: 6000, endMs: 9000,
      dialogue: [], supplementalText: 'Late supplemental line.',
    },
    {
      shotId: 'shot-normal', batchIndex: 1, shotIndex: 1, startMs: 0, endMs: 3000,
      dialogue: [{ speaker_id: 'char-a', target_text: 'Normal approved line.' }],
    },
    {
      shotId: 'shot-early', batchIndex: 1, shotIndex: 2, startMs: 3000, endMs: 6000,
      dialogue: [], supplementalText: 'Welcome home, son.',
    },
  ];
  const sourceFacts = overrides.sourceFacts || {
    schema_version: '2.0',
    facts_hash: FACTS_HASH,
    characters: [
      { id: 'char-b', source_name: 'Ben' },
      { id: 'char-a', source_name: 'Anna' },
    ],
    shots: shots.map((shot) => ({
      id: shot.shotId,
      visible_character_ids: ['char-a'],
    })),
  };
  const { db, fixture } = createRegistrationDb({ ...overrides, shots, sourceFacts });
  const shotRows = new Map(db.prepare(`
    SELECT id, shot_id, updated_at
    FROM redraw_shots
    WHERE version_id = ? AND tenant_id = ? AND user_id = ?
  `).all(fixture.versionId, fixture.tenantId, fixture.userId).map((row) => [row.shot_id, row]));
  const {
    createSupplementalDialogueApproval,
  } = require('../src/services/redrawSupplementalDialogueApprovalService');
  const approvals = [];
  const requested = overrides.approvals || shots.filter((shot) => shot.supplementalText);
  for (const [index, approval] of requested.entries()) {
    const shot = shotRows.get(approval.shotId);
    const created = createSupplementalDialogueApproval({
      db,
      tenantId: fixture.tenantId,
      userId: fixture.userId,
      versionId: fixture.versionId,
      shotRowId: Number(shot.id),
      voiceAssetId: fixture.voiceAssetId,
      idempotencyKey: `supplemental-${index + 1}`,
      targetText: approval.supplementalText,
      sourceTranslation: false,
      expectedShotUpdatedAt: shot.updated_at,
      expectedVoiceUpdatedAt: NOW,
      now: () => NOW,
    });
    approvals.push(created.approval);
  }
  return { db, fixture, approvals, shotRows };
}

function expectCode(code) {
  return (error) => error?.code === code && error.message === code;
}

function pcmWave({ samples = 16000, sampleRate = 16000 } = {}) {
  const dataSize = samples * 2;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples; index += 1) {
    bytes.writeInt16LE(index % 2 === 0 ? 1000 : -1000, 44 + (index * 2));
  }
  return bytes;
}

function executionHarness(t, db, fixture, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-local-voice-complete-'));
  const verifierAllowedRoot = path.join(root, 'locale-verifier');
  const audioStorageRoot = path.join(root, 'storage');
  fs.mkdirSync(verifierAllowedRoot);
  fs.mkdirSync(audioStorageRoot);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const wave = overrides.wave || pcmWave();
  const calls = { worker: [], probe: [], verifier: [], asset: [] };
  const baseManifest = manifest({ test_only: true });
  const outputSha256 = crypto.createHash('sha256').update(wave).digest('hex');
  const localTtsWorker = overrides.localTtsWorker || {
    assertReady(locale) {
      assert.equal(locale, 'en-US');
    },
    assertEvidenceTrusted(evidence) {
      assert.deepEqual(Object.keys(evidence).sort(), [
        'binary_sha256', 'engine', 'engine_version', 'manifest_sha256', 'profile',
        'source', 'target_locale', 'test_only',
      ]);
      assert.equal(evidence.profile, 'voice-anna');
      return { profile: { ...baseManifest.profiles[0] } };
    },
    async synthesize(input) {
      calls.worker.push(input);
      const outputPath = path.join(input.outputRoot, 'voice.wav');
      fs.writeFileSync(outputPath, wave, { flag: 'wx' });
      return {
        source: 'local_offline_tts',
        engine: 'eSpeak NG',
        engine_version: baseManifest.engine_version,
        binary_sha256: baseManifest.executable_sha256,
        manifest_sha256: baseManifest.manifest_sha256,
        target_locale: input.locale,
        output_path: outputPath,
        output_sha256: outputSha256,
        profile: { ...baseManifest.profiles[0] },
        completed_at: '2026-08-28T00:00:01.000Z',
        test_only: true,
      };
    },
  };
  const mediaProbe = overrides.mediaProbe || {
    async probeAudio(input) {
      calls.probe.push(input);
      return {
        format: 'wav',
        audio_streams: 1,
        decodable: true,
        non_silent: true,
        duration_ms: 1000,
        size_bytes: fs.statSync(input.audioPath).size,
      };
    },
  };
  const localePack = {
    id: 'en-US@1',
    locale: 'en-US',
    model_manifest_sha256: '1'.repeat(64),
    calibration_manifest_sha256: '2'.repeat(64),
  };
  const localeRegistry = overrides.localeRegistry || {
    assertReady(locale) {
      assert.equal(locale, 'en-US');
      return { ...localePack };
    },
  };
  const localeEvidence = {
    requestId: '',
    source: 'offline-worker',
    audioSha256: outputSha256,
    approvedTextSha256: crypto.createHash('sha256')
      .update('First approved line.\nSecond approved line.', 'utf8').digest('hex'),
    localePack: localePack.id,
    languageVerified: true,
    detectedLocale: 'en-US',
    transcriptSha256: '3'.repeat(64),
    modelManifestSha256: localePack.model_manifest_sha256,
    calibrationManifestSha256: localePack.calibration_manifest_sha256,
    metrics: { character_error_rate: 0, critical_tokens_match: true, word_error_rate: 0 },
    localTtsInvocation: {
      engine: 'eSpeak NG',
      engineVersion: baseManifest.engine_version,
      binarySha256: baseManifest.executable_sha256,
      manifestSha256: baseManifest.manifest_sha256,
      profile: 'voice-anna',
    },
    completedAt: '2026-08-28T00:00:02.000Z',
  };
  const localeVerifier = overrides.localeVerifier || {
    async verifyLocalVoice(input) {
      calls.verifier.push(input);
      return { ...localeEvidence, requestId: input.requestId };
    },
  };
  const assetService = overrides.assetService || {
    create(targetDb, log, payload) {
      calls.asset.push(payload);
      return realAssetService.create(targetDb, log, payload);
    },
  };

  return {
    calls,
    outputSha256,
    verifierAllowedRoot,
    audioStorageRoot,
    input: registrationInput(db, fixture, {
      context: 'test',
      claimOnly: false,
      localTtsManifest: baseManifest,
      localTtsWorker,
      mediaProbe,
      localeRegistry,
      localeVerifier,
      localeVerifierAllowedRoot: verifierAllowedRoot,
      audioStorageRoot,
      assetService,
      log: { info() {}, warn() {}, error() {} },
      signal: overrides.signal,
    }),
  };
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
    'approved_dialogue_evidence_sha256',
    'supplemental_approval_ids_json',
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
  assert.match(claimed.registration.approved_dialogue_evidence_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(claimed.registration.supplemental_approval_ids_json), []);
  assert.equal(claimed.claim.approvedText, 'First approved line.\nSecond approved line.');
  assert.deepEqual(claimed.claim.supplementalApprovalIds, []);
  assert.deepEqual(claimed.claim.supplementalApprovals, []);
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

test('owner claim merges active supplemental approvals in stable shot order and binds hashed provenance', (t) => {
  const { db, fixture, approvals } = createSupplementalRegistrationDb();
  t.after(() => db.close());
  const { registerLocalProductionVoice } = require('../src/services/redrawLocalVoiceRegistrationService');

  const claimed = registerLocalProductionVoice(registrationInput(db, fixture));
  const approvalByText = new Map(approvals.map((approval) => [approval.target_text, approval]));
  const expectedIds = [
    approvalByText.get('Welcome home, son.').id,
    approvalByText.get('Late supplemental line.').id,
  ];

  assert.equal(
    claimed.claim.approvedText,
    'Normal approved line.\nWelcome home, son.\nLate supplemental line.',
  );
  assert.match(claimed.registration.approved_dialogue_evidence_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(claimed.registration.supplemental_approval_ids_json), expectedIds);
  assert.equal(claimed.claim.approvedDialogueEvidenceSha256,
    claimed.registration.approved_dialogue_evidence_sha256);
  assert.deepEqual(claimed.claim.supplementalApprovals.map((approval) => approval.approvalId), expectedIds);
  assert.ok(claimed.claim.supplementalApprovals.every((approval) => (
    approval.status === 'active'
      && /^[a-f0-9]{64}$/.test(approval.approvalEvidenceSha256)
      && /^[a-f0-9]{64}$/.test(approval.targetTextSha256)
  )));
  assert.equal(JSON.stringify(claimed.registration).includes('Welcome home, son.'), false);
});

test('supplemental approval absence, revocation and binding drift fail before local execution side effects', (t) => {
  const cases = [
    ['missing', (state) => state.db.prepare(
      'UPDATE redraw_supplemental_dialogue_approvals SET deleted_at = ? WHERE id = ?',
    ).run(NOW, state.approvals[0].id), 'REDRAW_LOCAL_TTS_APPROVED_TEXT_INSUFFICIENT'],
    ['revoked', (state) => {
      const { revokeSupplementalDialogueApproval } = require('../src/services/redrawSupplementalDialogueApprovalService');
      revokeSupplementalDialogueApproval({
        db: state.db,
        tenantId: state.fixture.tenantId,
        userId: state.fixture.userId,
        versionId: state.fixture.versionId,
        approvalId: state.approvals[0].id,
        idempotencyKey: 'revoke-before-registration',
        expectedUpdatedAt: state.approvals[0].updated_at,
        now: () => '2026-08-28T00:00:01.000Z',
      });
    }, 'REDRAW_LOCAL_TTS_APPROVED_TEXT_INSUFFICIENT'],
    ['target text', (state) => state.db.prepare(
      'UPDATE redraw_supplemental_dialogue_approvals SET target_text = ? WHERE id = ?',
    ).run('Tampered approved text.', state.approvals[0].id), 'REDRAW_LOCAL_TTS_NOT_READY'],
    ['target locale', (state) => state.db.prepare(
      'UPDATE redraw_supplemental_dialogue_approvals SET target_locale = ? WHERE id = ?',
    ).run('es-MX', state.approvals[0].id), 'REDRAW_LOCAL_TTS_NOT_READY'],
    ['context hash', (state) => state.db.prepare(
      'UPDATE redraw_supplemental_dialogue_approvals SET dialogue_context_sha256 = ? WHERE id = ?',
    ).run('d'.repeat(64), state.approvals[0].id), 'REDRAW_LOCAL_TTS_NOT_READY'],
    ['evidence hash', (state) => state.db.prepare(
      'UPDATE redraw_supplemental_dialogue_approvals SET approval_evidence_sha256 = ? WHERE id = ?',
    ).run('d'.repeat(64), state.approvals[0].id), 'REDRAW_LOCAL_TTS_NOT_READY'],
    ['facts hash', (state) => state.db.prepare(
      'UPDATE redraw_supplemental_dialogue_approvals SET facts_hash = ? WHERE id = ?',
    ).run('d'.repeat(64), state.approvals[0].id), 'REDRAW_LOCAL_TTS_NOT_READY'],
    ['policy version', (state) => state.db.prepare(
      'UPDATE redraw_supplemental_dialogue_approvals SET policy_version = 8 WHERE id = ?',
    ).run(state.approvals[0].id), 'REDRAW_LOCAL_TTS_NOT_READY'],
    ['decision hash', (state) => state.db.prepare(
      'UPDATE redraw_supplemental_dialogue_approvals SET localization_decision_sha256 = ? WHERE id = ?',
    ).run('d'.repeat(64), state.approvals[0].id), 'REDRAW_LOCAL_TTS_NOT_READY'],
    ['shot drift', (state) => state.db.prepare(
      'UPDATE redraw_shots SET updated_at = ? WHERE id = ?',
    ).run('2026-08-28T00:00:01.000Z', state.approvals[0].redraw_shot_id), 'REDRAW_LOCAL_TTS_NOT_READY'],
    ['voice drift', (state) => state.db.prepare(
      'UPDATE redraw_assets SET updated_at = ? WHERE id = ?',
    ).run('2026-08-28T00:00:01.000Z', state.fixture.voiceAssetId), 'REDRAW_LOCAL_TTS_NOT_READY'],
  ];
  const states = [];
  t.after(() => states.forEach((state) => state.db.close()));
  const { registerLocalProductionVoice } = require('../src/services/redrawLocalVoiceRegistrationService');

  for (const [name, mutate, code] of cases) {
    const state = createSupplementalRegistrationDb({
      shots: [{
        shotId: 'shot-rafael', batchIndex: 1, shotIndex: 1, startMs: 0, endMs: 3000,
        dialogue: [], supplementalText: 'Welcome home, son.',
      }],
    });
    states.push(state);
    mutate(state);
    const harness = executionHarness(t, state.db, state.fixture);
    if (name === 'voice drift') harness.input.expectedUpdatedAt = '2026-08-28T00:00:01.000Z';
    assert.throws(() => registerLocalProductionVoice(harness.input), expectCode(code), name);
    assert.deepEqual({
      worker: harness.calls.worker.length,
      probe: harness.calls.probe.length,
      verifier: harness.calls.verifier.length,
      asset: harness.calls.asset.length,
    }, { worker: 0, probe: 0, verifier: 0, asset: 0 }, name);
    assert.equal(state.db.prepare(
      'SELECT COUNT(*) AS count FROM redraw_local_voice_registrations',
    ).get().count, 0, name);
  }
});

test('supplemental approval audit changes conflict with the original registration idempotency key', (t) => {
  const state = createSupplementalRegistrationDb({
    shots: [{
      shotId: 'shot-rafael', batchIndex: 1, shotIndex: 1, startMs: 0, endMs: 3000,
      dialogue: [], supplementalText: 'Welcome home, son.',
    }],
  });
  t.after(() => state.db.close());
  const { registerLocalProductionVoice } = require('../src/services/redrawLocalVoiceRegistrationService');
  const base = registrationInput(state.db, state.fixture);
  const first = registerLocalProductionVoice(base);
  state.db.prepare(
    'UPDATE redraw_supplemental_dialogue_approvals SET updated_at = ? WHERE id = ?',
  ).run('2026-08-28T00:00:01.000Z', state.approvals[0].id);
  let workerCalls = 0;

  assert.throws(() => registerLocalProductionVoice({
    ...base,
    claimOnly: false,
    localTtsWorker: { synthesize() { workerCalls += 1; } },
  }), expectCode('REDRAW_LOCAL_TTS_IDEMPOTENCY_CONFLICT'));
  assert.equal(workerCalls, 0);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM redraw_local_voice_registrations').get().count, 1);
  assert.equal(first.registration.id, state.db.prepare('SELECT id FROM redraw_local_voice_registrations').get().id);
});

test('completed supplemental local evidence binds approval hashes without exposing approved text', async (t) => {
  const state = createSupplementalRegistrationDb({
    shots: [{
      shotId: 'shot-rafael', batchIndex: 1, shotIndex: 1, startMs: 0, endMs: 3000,
      dialogue: [], supplementalText: 'Welcome home, son.',
    }],
  });
  t.after(() => state.db.close());
  const harness = executionHarness(t, state.db, state.fixture);
  const originalVerify = harness.input.localeVerifier.verifyLocalVoice.bind(harness.input.localeVerifier);
  harness.input.localeVerifier.verifyLocalVoice = async (input) => ({
    ...await originalVerify(input),
    approvedTextSha256: crypto.createHash('sha256').update(input.approvedText, 'utf8').digest('hex'),
  });
  const { registerLocalProductionVoice } = require('../src/services/redrawLocalVoiceRegistrationService');

  const result = await registerLocalProductionVoice(harness.input);
  const registration = state.db.prepare(
    'SELECT * FROM redraw_local_voice_registrations WHERE id = ?',
  ).get(result.registration.id);
  const slot = state.db.prepare('SELECT source_ref_json FROM redraw_assets WHERE id = ?')
    .get(state.fixture.voiceAssetId);
  const evidence = JSON.parse(slot.source_ref_json).snapshot.voice_evidence;

  assert.equal(result.registration.status, 'completed');
  assert.match(registration.approved_dialogue_evidence_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(registration.supplemental_approval_ids_json), [state.approvals[0].id]);
  assert.equal(evidence.approved_dialogue_contract_version, 'redraw-approved-dialogue-evidence-v1');
  assert.equal(evidence.approved_dialogue_evidence_sha256,
    registration.approved_dialogue_evidence_sha256);
  assert.deepEqual(evidence.supplemental_dialogue_approval_ids, [state.approvals[0].id]);
  assert.deepEqual(evidence.supplemental_dialogue_approvals, [{
    approval_id: state.approvals[0].id,
    approval_evidence_sha256: state.approvals[0].approval_evidence_sha256,
    target_text_sha256: state.approvals[0].target_text_sha256,
  }]);
  assert.equal(evidence.source_translation, false);
  assert.equal(JSON.stringify(evidence).includes('Welcome home, son.'), false);
});

test('supplemental approval revocation during execution stops before media registration and completion', async (t) => {
  const state = createSupplementalRegistrationDb({
    shots: [{
      shotId: 'shot-rafael', batchIndex: 1, shotIndex: 1, startMs: 0, endMs: 3000,
      dialogue: [], supplementalText: 'Welcome home, son.',
    }],
  });
  t.after(() => state.db.close());
  const harness = executionHarness(t, state.db, state.fixture);
  const originalVerify = harness.input.localeVerifier.verifyLocalVoice.bind(harness.input.localeVerifier);
  harness.input.localeVerifier.verifyLocalVoice = async (input) => {
    const result = await originalVerify(input);
    const { revokeSupplementalDialogueApproval } = require('../src/services/redrawSupplementalDialogueApprovalService');
    revokeSupplementalDialogueApproval({
      db: state.db,
      tenantId: state.fixture.tenantId,
      userId: state.fixture.userId,
      versionId: state.fixture.versionId,
      approvalId: state.approvals[0].id,
      idempotencyKey: 'revoke-during-registration',
      expectedUpdatedAt: state.approvals[0].updated_at,
      now: () => '2026-08-28T00:00:03.000Z',
    });
    return {
      ...result,
      approvedTextSha256: crypto.createHash('sha256').update(input.approvedText, 'utf8').digest('hex'),
    };
  };
  const { registerLocalProductionVoice } = require('../src/services/redrawLocalVoiceRegistrationService');

  await assert.rejects(
    registerLocalProductionVoice(harness.input),
    expectCode('REDRAW_LOCAL_TTS_NOT_READY'),
  );
  assert.deepEqual({
    worker: harness.calls.worker.length,
    probe: harness.calls.probe.length,
    verifier: harness.calls.verifier.length,
    asset: harness.calls.asset.length,
  }, { worker: 1, probe: 1, verifier: 1, asset: 0 });
  const registration = state.db.prepare('SELECT * FROM redraw_local_voice_registrations').get();
  assert.equal(registration.status, 'failed');
  assert.equal(registration.error_code, 'REDRAW_LOCAL_TTS_NOT_READY');
  assert.equal(state.db.prepare('SELECT voice_asset_id FROM redraw_assets WHERE id = ?')
    .get(state.fixture.voiceAssetId).voice_asset_id, null);
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
      context: 'production',
      claimOnly: false,
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

test('legacy no-supplement registration replays its original request hash without execution side effects', (t) => {
  const { db, fixture } = createRegistrationDb();
  t.after(() => db.close());
  const input = registrationInput(db, fixture);
  const inserted = db.prepare(`
    INSERT INTO redraw_local_voice_registrations
      (tenant_id, user_id, version_id, voice_redraw_asset_id, source_character_key,
       idempotency_hash, request_hash, target_locale, target_market, approved_text_sha256,
       profile_key, engine_manifest_sha256, status, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, 'char-a', ?, ?, 'en-US', 'US', ?,
            'voice-anna', ?, 'completed', ?, ?, ?)
  `).run(
    fixture.tenantId,
    fixture.userId,
    fixture.versionId,
    fixture.voiceAssetId,
    crypto.createHash('sha256').update(input.idempotencyKey, 'utf8').digest('hex'),
    legacyRegistrationRequestHash(fixture, input),
    crypto.createHash('sha256').update('First approved line.\nSecond approved line.', 'utf8').digest('hex'),
    input.localTtsManifest.manifest_sha256,
    NOW,
    NOW,
    NOW,
  );
  let workerCalls = 0;
  const { registerLocalProductionVoice } = require('../src/services/redrawLocalVoiceRegistrationService');

  const replay = registerLocalProductionVoice({
    ...input,
    claimOnly: false,
    localTtsWorker: { synthesize() { workerCalls += 1; } },
  });

  assert.equal(replay.replayed, true);
  assert.equal(replay.registration.id, Number(inserted.lastInsertRowid));
  assert.equal(replay.registration.approved_dialogue_evidence_sha256, null);
  assert.deepEqual(JSON.parse(replay.registration.supplemental_approval_ids_json), []);
  assert.equal(workerCalls, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_local_voice_registrations').get().count, 1);
});

test('legacy replay compatibility never bypasses revoked supplemental approval history', (t) => {
  const state = createSupplementalRegistrationDb();
  t.after(() => state.db.close());
  const { revokeSupplementalDialogueApproval } = require('../src/services/redrawSupplementalDialogueApprovalService');
  state.approvals.forEach((approval, index) => revokeSupplementalDialogueApproval({
    db: state.db,
    tenantId: state.fixture.tenantId,
    userId: state.fixture.userId,
    versionId: state.fixture.versionId,
    approvalId: approval.id,
    idempotencyKey: `legacy-revoke-${index}`,
    expectedUpdatedAt: approval.updated_at,
    now: () => `2026-08-28T00:00:0${index + 1}.000Z`,
  }));
  const input = registrationInput(state.db, state.fixture);
  const approvedText = 'Normal approved line.';
  state.db.prepare(`
    INSERT INTO redraw_local_voice_registrations
      (tenant_id, user_id, version_id, voice_redraw_asset_id, source_character_key,
       idempotency_hash, request_hash, target_locale, target_market, approved_text_sha256,
       profile_key, engine_manifest_sha256, status, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, 'char-a', ?, ?, 'en-US', 'US', ?,
            'voice-anna', ?, 'completed', ?, ?, ?)
  `).run(
    state.fixture.tenantId,
    state.fixture.userId,
    state.fixture.versionId,
    state.fixture.voiceAssetId,
    crypto.createHash('sha256').update(input.idempotencyKey, 'utf8').digest('hex'),
    legacyRegistrationRequestHash(state.fixture, input, approvedText),
    crypto.createHash('sha256').update(approvedText, 'utf8').digest('hex'),
    input.localTtsManifest.manifest_sha256,
    NOW,
    NOW,
    NOW,
  );
  const { registerLocalProductionVoice } = require('../src/services/redrawLocalVoiceRegistrationService');

  assert.throws(
    () => registerLocalProductionVoice(input),
    expectCode('REDRAW_LOCAL_TTS_IDEMPOTENCY_CONFLICT'),
  );
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

test('missing execution dependencies fail closed without leaving a retryable processing claim', (t) => {
  const { db, fixture } = createRegistrationDb();
  t.after(() => db.close());
  const { registerLocalProductionVoice } = require('../src/services/redrawLocalVoiceRegistrationService');
  const input = registrationInput(db, fixture, { claimOnly: false });

  assert.throws(
    () => registerLocalProductionVoice(input),
    expectCode('REDRAW_LOCAL_TTS_NOT_READY'),
  );
  let registration = db.prepare('SELECT * FROM redraw_local_voice_registrations').get();
  assert.equal(registration.status, 'failed');
  assert.equal(registration.error_code, 'REDRAW_LOCAL_TTS_NOT_READY');
  assert.equal(registration.error_message, 'REDRAW_LOCAL_TTS_NOT_READY');

  const replay = registerLocalProductionVoice(input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.registration.status, 'failed');
  registration = db.prepare('SELECT * FROM redraw_local_voice_registrations').get();
  assert.equal(registration.status, 'failed');
});

test('synthesizes, verifies media and completes one local voice with zero billing', async (t) => {
  const { db, fixture } = createRegistrationDb();
  t.after(() => db.close());
  const harness = executionHarness(t, db, fixture);
  const beforeBilling = {
    usage: db.prepare('SELECT COUNT(*) AS count FROM usage_reservations').get().count,
    tenantUsage: db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count,
    ledger: db.prepare('SELECT COUNT(*) AS count FROM tenant_credit_ledger').get().count,
  };
  const { registerLocalProductionVoice } = require('../src/services/redrawLocalVoiceRegistrationService');

  const result = await registerLocalProductionVoice(harness.input);

  assert.deepEqual(result.billing, { credits: 0, held: 0, charged: 0 });
  assert.equal(result.registration.status, 'completed');
  assert.equal(harness.calls.worker.length, 1);
  assert.deepEqual(Object.keys(harness.calls.worker[0]).sort(), [
    'approvedText', 'locale', 'outputRoot', 'profileKey', 'requestId',
  ]);
  assert.equal(harness.calls.worker[0].approvedText, 'First approved line.\nSecond approved line.');
  assert.equal(harness.calls.worker[0].locale, 'en-US');
  assert.equal(harness.calls.worker[0].profileKey, 'voice-anna');
  const stagingRelative = path.relative(
    fs.realpathSync(harness.verifierAllowedRoot),
    path.resolve(harness.calls.worker[0].outputRoot),
  );
  assert.ok(stagingRelative && !stagingRelative.startsWith('..') && !path.isAbsolute(stagingRelative));

  assert.equal(harness.calls.probe.length, 1);
  assert.deepEqual(Object.keys(harness.calls.probe[0]).sort(), [
    'audioPath', 'maxOutputBytes', 'requestId', 'timeoutMs',
  ]);
  assert.equal(harness.calls.verifier.length, 1);
  assert.deepEqual(Object.keys(harness.calls.verifier[0]).sort(), [
    'approvedText', 'audioPath', 'audioSha256', 'localTtsInvocation', 'locale', 'requestId',
  ]);
  assert.equal(harness.calls.verifier[0].audioSha256, harness.outputSha256);
  assert.deepEqual(harness.calls.verifier[0].localTtsInvocation, {
    engine: 'eSpeak NG',
    engineVersion: '1.52.0',
    binarySha256: 'f'.repeat(64),
    manifestSha256: harness.input.localTtsManifest.manifest_sha256,
    profile: 'voice-anna',
  });

  assert.equal(harness.calls.asset.length, 1);
  const assetPayload = harness.calls.asset[0];
  assert.equal(assetPayload.drama_id, 1);
  assert.equal(assetPayload.type, 'audio');
  assert.equal(assetPayload.category, 'redraw-local-voice');
  assert.equal(assetPayload.local_path, `redraw-local-voices/${harness.outputSha256}.wav`);
  assert.equal(assetPayload.metadata.tenant_id, fixture.tenantId);
  assert.equal(assetPayload.metadata.user_id, fixture.userId);
  assert.equal(assetPayload.metadata.version_id, fixture.versionId);
  assert.equal(assetPayload.metadata.voice_redraw_asset_id, fixture.voiceAssetId);
  assert.equal(assetPayload.metadata.source, 'local_offline_tts');

  const registration = db.prepare('SELECT * FROM redraw_local_voice_registrations').get();
  const slot = db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(fixture.voiceAssetId);
  const storedAsset = db.prepare('SELECT * FROM assets WHERE id = ?').get(registration.audio_asset_id);
  const evidence = JSON.parse(slot.source_ref_json).snapshot.voice_evidence;
  assert.equal(registration.status, 'completed');
  assert.equal(registration.audio_sha256, harness.outputSha256);
  assert.match(registration.locale_evidence_sha256, /^[a-f0-9]{64}$/);
  assert.ok(registration.completed_at);
  assert.equal(slot.voice_asset_id, registration.audio_asset_id);
  assert.equal(slot.status, 'generated');
  assert.equal(slot.approval_status, 'pending');
  assert.equal(evidence.source, 'local_offline_tts');
  assert.equal(evidence.registration_id, registration.id);
  assert.equal(evidence.registration_status, 'completed');
  assert.equal(evidence.audio_asset_id, registration.audio_asset_id);
  assert.equal(evidence.audio_sha256, harness.outputSha256);
  assert.equal(evidence.approved_text_sha256, registration.approved_text_sha256);
  assert.equal(evidence.locale_pack, 'en-US@1');
  assert.equal(evidence.language_verified, true);
  assert.equal(evidence.detected_locale, 'en-US');
  assert.equal(evidence.approved_dialogue_contract_version, undefined);
  assert.equal(evidence.approved_dialogue_evidence_sha256, undefined);
  assert.equal(evidence.supplemental_dialogue_approval_ids, undefined);
  assert.equal(evidence.supplemental_dialogue_approvals, undefined);
  assert.equal(evidence.source_translation, undefined);
  assert.equal(evidence.real_generation_verified, undefined);
  assert.equal(storedAsset.local_path, `redraw-local-voices/${harness.outputSha256}.wav`);
  assert.equal(
    crypto.createHash('sha256').update(fs.readFileSync(path.join(harness.audioStorageRoot, storedAsset.local_path))).digest('hex'),
    harness.outputSha256,
  );
  assert.equal(fs.existsSync(harness.calls.worker[0].outputRoot), false);
  assert.deepEqual({
    usage: db.prepare('SELECT COUNT(*) AS count FROM usage_reservations').get().count,
    tenantUsage: db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count,
    ledger: db.prepare('SELECT COUNT(*) AS count FROM tenant_credit_ledger').get().count,
  }, beforeBilling);
});

test('media and worker evidence failures mark registration failed and clean only temporary output', async (t) => {
  const cases = [
    ['untrusted invocation', async (harness) => {
      harness.input.localTtsWorker.assertEvidenceTrusted = () => {
        const error = new Error('C:\\secret\\engine.exe approved words API_KEY=secret');
        error.code = 'REDRAW_LOCAL_TTS_NOT_READY';
        throw error;
      };
    }],
    ['path escape', async (harness) => {
      harness.input.localTtsWorker.synthesize = async (input) => {
        const outputPath = path.join(harness.verifierAllowedRoot, 'outside.wav');
        fs.writeFileSync(outputPath, pcmWave(), { flag: 'wx' });
        return {
          source: 'local_offline_tts', engine: 'eSpeak NG', engine_version: '1.52.0',
          binary_sha256: 'f'.repeat(64), manifest_sha256: harness.input.localTtsManifest.manifest_sha256,
          target_locale: 'en-US', output_path: outputPath,
          output_sha256: crypto.createHash('sha256').update(fs.readFileSync(outputPath)).digest('hex'),
          profile: { ...harness.input.localTtsManifest.profiles[0] },
          completed_at: '2026-08-28T00:00:01.000Z', test_only: true,
        };
      };
    }],
    ['bad wav magic', async (harness) => {
      harness.input.localTtsWorker.synthesize = async (input) => {
        const outputPath = path.join(input.outputRoot, 'bad.wav');
        const bytes = Buffer.from('not-wave');
        fs.writeFileSync(outputPath, bytes, { flag: 'wx' });
        return {
          source: 'local_offline_tts', engine: 'eSpeak NG', engine_version: '1.52.0',
          binary_sha256: 'f'.repeat(64), manifest_sha256: harness.input.localTtsManifest.manifest_sha256,
          target_locale: 'en-US', output_path: outputPath,
          output_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
          profile: { ...harness.input.localTtsManifest.profiles[0] },
          completed_at: '2026-08-28T00:00:01.000Z', test_only: true,
        };
      };
    }],
    ['sha drift', async (harness) => {
      const synthesize = harness.input.localTtsWorker.synthesize;
      harness.input.localTtsWorker.synthesize = async (input) => ({
        ...(await synthesize(input)), output_sha256: '0'.repeat(64),
      });
    }],
    ['missing audio stream', async (harness) => {
      harness.input.mediaProbe.probeAudio = async (input) => ({
        format: 'wav', audio_streams: 0, decodable: true, non_silent: true,
        duration_ms: 1000, size_bytes: fs.statSync(input.audioPath).size,
      });
    }],
    ['silent audio', async (harness) => {
      harness.input.mediaProbe.probeAudio = async (input) => ({
        format: 'wav', audio_streams: 1, decodable: true, non_silent: false,
        duration_ms: 1000, size_bytes: fs.statSync(input.audioPath).size,
      });
    }],
    ['duration out of range', async (harness) => {
      harness.input.mediaProbe.probeAudio = async (input) => ({
        format: 'wav', audio_streams: 1, decodable: true, non_silent: true,
        duration_ms: 0, size_bytes: fs.statSync(input.audioPath).size,
      });
    }],
    ['size drift', async (harness) => {
      harness.input.mediaProbe.probeAudio = async (input) => ({
        format: 'wav', audio_streams: 1, decodable: true, non_silent: true,
        duration_ms: 1000, size_bytes: fs.statSync(input.audioPath).size + 1,
      });
    }],
  ];

  const databases = [];
  t.after(() => databases.forEach((db) => db.close()));
  const { registerLocalProductionVoice } = require('../src/services/redrawLocalVoiceRegistrationService');
  for (const [name, mutate] of cases) {
    await t.test(name, async (subtest) => {
      const { db, fixture } = createRegistrationDb();
      databases.push(db);
      const harness = executionHarness(subtest, db, fixture);
      await mutate(harness);
      await assert.rejects(registerLocalProductionVoice(harness.input), (error) => (
        ['REDRAW_LOCAL_TTS_NOT_READY', 'REDRAW_LOCAL_TTS_OUTPUT_INVALID'].includes(error?.code)
        && error.message === error.code
      ));
      const registration = db.prepare('SELECT * FROM redraw_local_voice_registrations').get();
      assert.equal(registration.status, 'failed', name);
      assert.equal(registration.audio_asset_id, null, name);
      assert.ok(['REDRAW_LOCAL_TTS_NOT_READY', 'REDRAW_LOCAL_TTS_OUTPUT_INVALID'].includes(registration.error_code));
      assert.equal(registration.error_message, registration.error_code);
      assert.doesNotMatch(registration.error_message, /approved|secret|API_KEY|[A-Za-z]:\\/i);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 0, name);
      for (const call of harness.calls.worker) {
        assert.equal(fs.existsSync(call.outputRoot), false, name);
      }
    });
  }
});

test('reparse replacement of the private staging root is rejected without deleting its target', async (t) => {
  const { db, fixture } = createRegistrationDb();
  t.after(() => db.close());
  const harness = executionHarness(t, db, fixture);
  const outside = path.join(harness.verifierAllowedRoot, 'junction-target');
  fs.mkdirSync(outside);
  const outsideFile = path.join(outside, 'linked.wav');
  fs.writeFileSync(outsideFile, pcmWave(), { flag: 'wx' });
  harness.input.localTtsWorker.synthesize = async (input) => {
    fs.rmdirSync(input.outputRoot);
    fs.symlinkSync(outside, input.outputRoot, 'junction');
    const outputPath = path.join(input.outputRoot, 'linked.wav');
    return {
      source: 'local_offline_tts', engine: 'eSpeak NG', engine_version: '1.52.0',
      binary_sha256: 'f'.repeat(64), manifest_sha256: harness.input.localTtsManifest.manifest_sha256,
      target_locale: 'en-US', output_path: outputPath,
      output_sha256: crypto.createHash('sha256').update(fs.readFileSync(outsideFile)).digest('hex'),
      profile: { ...harness.input.localTtsManifest.profiles[0] },
      completed_at: '2026-08-28T00:00:01.000Z', test_only: true,
    };
  };
  const { registerLocalProductionVoice } = require('../src/services/redrawLocalVoiceRegistrationService');
  await assert.rejects(
    registerLocalProductionVoice(harness.input),
    expectCode('REDRAW_LOCAL_TTS_OUTPUT_INVALID'),
  );
  assert.equal(fs.existsSync(outsideFile), true);
  assert.equal(db.prepare('SELECT status FROM redraw_local_voice_registrations').get().status, 'failed');
});

test('worker result unknown becomes needs_attention and the same idempotency key never retries', async (t) => {
  const { db, fixture } = createRegistrationDb();
  t.after(() => db.close());
  let attempts = 0;
  const harness = executionHarness(t, db, fixture);
  harness.input.localTtsWorker.synthesize = async () => {
    attempts += 1;
    const error = new Error('C:\\private\\voice.wav command --key secret approved words');
    error.code = 'REDRAW_LOCAL_TTS_RESULT_UNKNOWN';
    throw error;
  };
  const { registerLocalProductionVoice } = require('../src/services/redrawLocalVoiceRegistrationService');
  await assert.rejects(
    registerLocalProductionVoice(harness.input),
    expectCode('REDRAW_LOCAL_TTS_RESULT_UNKNOWN'),
  );
  assert.equal(attempts, 1);
  let registration = db.prepare('SELECT * FROM redraw_local_voice_registrations').get();
  assert.equal(registration.status, 'needs_attention');
  assert.equal(registration.error_message, 'REDRAW_LOCAL_TTS_RESULT_UNKNOWN');
  const replay = await registerLocalProductionVoice(harness.input);
  assert.equal(replay.replayed, true);
  assert.equal(attempts, 1);
  registration = db.prepare('SELECT * FROM redraw_local_voice_registrations').get();
  assert.equal(registration.status, 'needs_attention');
});

test('locale verification fails before media registration', async (t) => {
  const { db, fixture } = createRegistrationDb();
  t.after(() => db.close());
  const harness = executionHarness(t, db, fixture);
  harness.input.localeVerifier.verifyLocalVoice = async () => {
    const error = new Error('C:\\private\\locale.sock approved words');
    error.code = 'REDRAW_LOCAL_TTS_VERIFICATION_FAILED';
    throw error;
  };
  const { registerLocalProductionVoice } = require('../src/services/redrawLocalVoiceRegistrationService');
  await assert.rejects(
    registerLocalProductionVoice(harness.input),
    expectCode('REDRAW_LOCAL_TTS_VERIFICATION_FAILED'),
  );
  const registration = db.prepare('SELECT * FROM redraw_local_voice_registrations').get();
  assert.equal(registration.status, 'failed');
  assert.equal(registration.audio_asset_id, null);
  assert.equal(harness.calls.asset.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 0);
});

test('completed media is retained and registration needs_attention when final voice slot CAS conflicts', async (t) => {
  const { db, fixture } = createRegistrationDb();
  t.after(() => db.close());
  const harness = executionHarness(t, db, fixture);
  const create = harness.input.assetService.create;
  harness.input.assetService.create = (targetDb, log, payload) => {
    const asset = create(targetDb, log, payload);
    targetDb.prepare('UPDATE redraw_assets SET updated_at = ? WHERE id = ?')
      .run('2026-08-28T00:00:09.000Z', fixture.voiceAssetId);
    return asset;
  };
  const { registerLocalProductionVoice } = require('../src/services/redrawLocalVoiceRegistrationService');
  await assert.rejects(
    registerLocalProductionVoice(harness.input),
    expectCode('REDRAW_LOCAL_TTS_CAS_CONFLICT'),
  );
  const registration = db.prepare('SELECT * FROM redraw_local_voice_registrations').get();
  const slot = db.prepare('SELECT voice_asset_id FROM redraw_assets WHERE id = ?').get(fixture.voiceAssetId);
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(registration.audio_asset_id);
  assert.equal(registration.status, 'needs_attention');
  assert.ok(registration.audio_asset_id > 0);
  assert.equal(registration.audio_sha256, harness.outputSha256);
  assert.equal(slot.voice_asset_id, null);
  assert.ok(asset);
  assert.equal(fs.existsSync(path.join(harness.audioStorageRoot, asset.local_path)), true);
});

test('asset registration uncertainty reconciles only trusted assets and preserves published content', async (t) => {
  const databases = [];
  t.after(() => databases.forEach((db) => db.close()));
  const { registerLocalProductionVoice } = require('../src/services/redrawLocalVoiceRegistrationService');

  await t.test('persisted asset is retained and referenced', async (subtest) => {
    const { db, fixture } = createRegistrationDb();
    databases.push(db);
    const harness = executionHarness(subtest, db, fixture);
    harness.input.assetService.create = (targetDb, log, payload) => {
      realAssetService.create(targetDb, log, payload);
      throw new Error('C:\\private\\assets.sqlite API_KEY=secret approved words');
    };
    await assert.rejects(
      registerLocalProductionVoice(harness.input),
      expectCode('REDRAW_LOCAL_TTS_RESULT_UNKNOWN'),
    );
    const registration = db.prepare('SELECT * FROM redraw_local_voice_registrations').get();
    const asset = db.prepare('SELECT * FROM assets').get();
    assert.equal(registration.status, 'needs_attention');
    assert.equal(registration.audio_asset_id, asset.id);
    assert.equal(registration.audio_sha256, harness.outputSha256);
    assert.equal(fs.existsSync(path.join(harness.audioStorageRoot, asset.local_path)), true);
    assert.equal(registration.error_message, 'REDRAW_LOCAL_TTS_RESULT_UNKNOWN');
  });

  await t.test('pre-insert failure leaves the immutable published content for safe reuse', async (subtest) => {
    const { db, fixture } = createRegistrationDb();
    databases.push(db);
    const harness = executionHarness(subtest, db, fixture);
    harness.input.assetService.create = () => {
      throw new Error('C:\\private\\assets.sqlite approved words');
    };
    await assert.rejects(
      registerLocalProductionVoice(harness.input),
      expectCode('REDRAW_LOCAL_TTS_RESULT_UNKNOWN'),
    );
    const registration = db.prepare('SELECT * FROM redraw_local_voice_registrations').get();
    assert.equal(registration.status, 'needs_attention');
    assert.equal(registration.audio_asset_id, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 0);
    assert.equal(fs.existsSync(path.join(
      harness.audioStorageRoot,
      'redraw-local-voices',
      `${harness.outputSha256}.wav`,
    )), true);
  });

  await t.test('an unverified adapter return is never written into the registration', async (subtest) => {
    const { db, fixture } = createRegistrationDb();
    databases.push(db);
    const harness = executionHarness(subtest, db, fixture);
    harness.input.assetService.create = () => ({
      id: 999,
      drama_id: 999,
      type: 'audio',
      category: 'redraw-local-voice',
      local_path: 'redraw-local-voices/wrong.wav',
      mime_type: 'audio/wav',
      metadata: {},
    });
    await assert.rejects(
      registerLocalProductionVoice(harness.input),
      expectCode('REDRAW_LOCAL_TTS_RESULT_UNKNOWN'),
    );
    const registration = db.prepare('SELECT * FROM redraw_local_voice_registrations').get();
    assert.equal(registration.status, 'needs_attention');
    assert.equal(registration.audio_asset_id, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 0);
  });

  await t.test('a shared content file is retained when another asset has already referenced it', async (subtest) => {
    const { db, fixture } = createRegistrationDb();
    databases.push(db);
    const harness = executionHarness(subtest, db, fixture);
    harness.input.assetService.create = (targetDb, log, payload) => {
      realAssetService.create(targetDb, log, {
        ...payload,
        metadata: { ...payload.metadata, registration_id: 999 },
      });
      throw new Error('asset result unknown');
    };
    await assert.rejects(
      registerLocalProductionVoice(harness.input),
      expectCode('REDRAW_LOCAL_TTS_RESULT_UNKNOWN'),
    );
    const registration = db.prepare('SELECT * FROM redraw_local_voice_registrations').get();
    const sharedAsset = db.prepare('SELECT * FROM assets').get();
    assert.equal(registration.status, 'needs_attention');
    assert.equal(registration.audio_asset_id, null);
    assert.ok(sharedAsset);
    assert.equal(fs.existsSync(path.join(harness.audioStorageRoot, sharedAsset.local_path)), true);
  });
});

test('existing content-addressed media is revalidated and never deleted on mismatch', async (t) => {
  const { db, fixture } = createRegistrationDb();
  t.after(() => db.close());
  const harness = executionHarness(t, db, fixture);
  const contentDir = path.join(harness.audioStorageRoot, 'redraw-local-voices');
  fs.mkdirSync(contentDir);
  const targetPath = path.join(contentDir, `${harness.outputSha256}.wav`);
  fs.writeFileSync(targetPath, Buffer.from('corrupt-existing'), { flag: 'wx' });
  const { registerLocalProductionVoice } = require('../src/services/redrawLocalVoiceRegistrationService');
  await assert.rejects(
    registerLocalProductionVoice(harness.input),
    expectCode('REDRAW_LOCAL_TTS_OUTPUT_INVALID'),
  );
  assert.deepEqual(fs.readFileSync(targetPath), Buffer.from('corrupt-existing'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 0);
  assert.equal(db.prepare('SELECT status FROM redraw_local_voice_registrations').get().status, 'failed');
});
