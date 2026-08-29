const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');
const express = require('express');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { setupRouter } = require('../src/routes');
const { saveIdentityPack } = require('../src/services/redrawCharacterIdentityService');
const { canonicalManifestSha256 } = require('../src/services/redrawLocalTtsWorkerProcess');
const userAuthService = require('../src/services/userAuthService');

const NOW = '2026-08-28T00:00:00.000Z';
const MODEL_SHA = '1'.repeat(64);
const CALIBRATION_SHA = '2'.repeat(64);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function pcmWave(seed) {
  const samples = 16000;
  const dataSize = samples * 2;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples; index += 1) {
    bytes.writeInt16LE((index + seed) % 2 === 0 ? 900 + seed : -900 - seed, 44 + (index * 2));
  }
  return bytes;
}

function createOwnerRows(db, owner = {}) {
  const tenantId = owner.tenantId;
  const userId = owner.userId;
  const sourceFacts = owner.sourceFacts || {
    characters: [{ source_character_key: 'char-a', source_name: 'Anna' }],
  };
  const factsHash = owner.factsHash || 'b'.repeat(64);
  const projectId = Number(db.prepare(`INSERT INTO redraw_projects
    (tenant_id, user_id, title, default_locale, default_market, localization_level,
     status, policy_version, created_at, updated_at)
    VALUES (?, ?, 'Local route', 'en-US', 'US', 'faithful', 'active', 7, ?, ?)`)
    .run(tenantId, userId, NOW, NOW).lastInsertRowid);
  const workId = Number(db.prepare(`INSERT INTO redraw_works
    (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
     duration_ms, current_version, current_step, status, created_at, updated_at)
    VALUES (?, ?, ?, 'Episode', 1, ?, 12000, 1, 2, 'asset_review', ?, ?)`)
    .run(projectId, tenantId, userId, owner.sourceFingerprint || 'a'.repeat(64), NOW, NOW).lastInsertRowid);
  const versionId = Number(db.prepare(`INSERT INTO redraw_versions
    (work_id, tenant_id, user_id, version, locale, market, localization_level,
     source_facts_json, facts_hash, localization_task_id, status, created_at, updated_at)
    VALUES (?, ?, ?, 1, 'en-US', 'US', 'faithful', ?, ?, ?, 'asset_review', ?, ?)`)
    .run(workId, tenantId, userId, JSON.stringify(sourceFacts), factsHash,
      owner.localizationTaskId || null, NOW, NOW).lastInsertRowid);
  const voiceAssetId = Number(db.prepare(`INSERT INTO redraw_assets
    (version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     version_number, approval_status, status, created_at, updated_at)
    VALUES (?, ?, ?, 'voice', ?, 'Anna voice', 1, 'pending', 'draft', ?, ?)`)
    .run(versionId, tenantId, userId, JSON.stringify({
      source_ref: { source_character_key: 'char-a' },
    }), NOW, NOW).lastInsertRowid);
  return { projectId, workId, versionId, voiceAssetId };
}

function trustedRegistry() {
  return {
    assertReady(expected) {
      const locale = typeof expected === 'string' ? expected : expected?.locale;
      if (locale !== 'en-US') throw new Error('locale not ready');
      return {
        id: 'en-US@fixture',
        locale: 'en-US',
        model_manifest_sha256: MODEL_SHA,
        calibration_manifest_sha256: CALIBRATION_SHA,
      };
    },
    assertEvidenceTrusted(evidence) {
      return evidence;
    },
  };
}

function routeFixture(t, registrationService = null, input = {}) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-local-voice-route-'));
  const verifierRoot = path.join(storageRoot, 'verifier');
  fs.mkdirSync(verifierRoot);
  const previous = {
    publicMode: process.env.PUBLIC_PLATFORM_MODE,
    jwtSecret: process.env.PLATFORM_JWT_SECRET,
  };
  process.env.PUBLIC_PLATFORM_MODE = 'true';
  process.env.PLATFORM_JWT_SECRET = 'redraw-local-voice-route-secret-at-least-32-bytes';
  t.after(() => {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
    if (previous.publicMode === undefined) delete process.env.PUBLIC_PLATFORM_MODE;
    else process.env.PUBLIC_PLATFORM_MODE = previous.publicMode;
    if (previous.jwtSecret === undefined) delete process.env.PLATFORM_JWT_SECRET;
    else process.env.PLATFORM_JWT_SECRET = previous.jwtSecret;
  });
  const user = userAuthService.register(db, {
    email: `redraw-local-voice-${crypto.randomUUID()}@example.test`,
    password: 'redraw-local-voice-route-password-123',
  });
  const tenantId = `personal:${user.id}`;
  const rows = createOwnerRows(db, {
    tenantId,
    userId: String(user.id),
    sourceFacts: input.sourceFacts,
    factsHash: input.factsHash,
    localizationTaskId: input.localizationTaskId,
  });
  const noLocalizationProvider = async () => {
    input.onProviderCall?.();
    return { status: 'failed' };
  };
  const noGenerationSupplier = async () => {
    input.onSupplierCall?.();
    return { status: 'failed' };
  };
  const registry = input.localeRegistry || trustedRegistry();
  const redrawOptions = {
    localeRegistry: registry,
    localeVerifier: input.localeVerifier || { verifyLocalVoice() { throw new Error('unused'); } },
    localTtsWorker: input.localTtsWorker || {
      assertReady() {}, assertEvidenceTrusted(value) { return value; }, synthesize() { throw new Error('unused'); },
    },
    localTtsManifest: input.localTtsManifest || { schema_version: 'test-only' },
    localVoiceMediaProbe: input.mediaProbe || { probeAudio() { throw new Error('unused'); } },
    localVoiceVerifierAllowedRoot: verifierRoot,
    localVoiceAudioStorageRoot: storageRoot,
    ...(registrationService ? { localVoiceRegistrationService: registrationService } : {}),
    ...input.redrawOptions,
  };
  const router = setupRouter({ storage: { local_path: storageRoot } }, db, input.log || {
    info() {}, warn() {}, error() {},
  }, {
    localizationProvider: noLocalizationProvider,
    assetGenerationProvider: noGenerationSupplier,
    dialogueProvider: noGenerationSupplier,
    localeRegistry: registry,
    localeVerifier: redrawOptions.localeVerifier,
    redrawOptions,
  });
  return {
    db,
    router,
    storageRoot,
    verifierRoot,
    token: userAuthService.issueToken(user, process.env.PLATFORM_JWT_SECRET, 0),
    tenantId,
    userId: String(user.id),
    ...rows,
  };
}

async function withServer(router, run) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}/api/v1`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function post(baseUrl, fixture, body, overrides = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (overrides.auth !== false) headers.Authorization = `Bearer ${fixture.token}`;
  if (overrides.tenant !== false) headers['X-Tenant-Id'] = overrides.tenantId || fixture.tenantId;
  return fetch(
    `${baseUrl}/redraw/versions/${overrides.versionId || fixture.versionId}`
      + `/voices/${overrides.voiceAssetId || fixture.voiceAssetId}/local-production-registrations`,
    { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) },
  );
}

test('local production voice route is always registered and fails closed when dependencies are absent', async (t) => {
  const fixture = routeFixture(t, null, {
    redrawOptions: {
      localTtsWorker: null,
      localTtsManifest: null,
      localVoiceMediaProbe: null,
      localVoiceVerifierAllowedRoot: null,
    },
  });
  const registered = new Set(fixture.router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods)
      .map((method) => `${method.toUpperCase()} ${layer.route.path}`)));
  assert.equal(registered.has(
    'POST /redraw/versions/:versionId/voices/:voiceAssetId/local-production-registrations',
  ), true);
  await withServer(fixture.router, async (baseUrl) => {
    const response = await post(baseUrl, fixture, {
      idempotency_key: 'not-ready', expected_updated_at: NOW,
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'REDRAW_LOCAL_TTS_NOT_READY');
  });
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM redraw_local_voice_registrations').get().count, 0);
});

test('local production voice route authenticates and hides absent or foreign owner scope', async (t) => {
  let calls = 0;
  const fixture = routeFixture(t, { async registerLocalProductionVoice() { calls += 1; return {}; } });
  const otherUser = userAuthService.register(fixture.db, {
    email: `redraw-local-voice-foreign-${crypto.randomUUID()}@example.test`,
    password: 'redraw-local-voice-route-password-123',
  });
  const otherOwner = createOwnerRows(fixture.db, {
    tenantId: `personal:${otherUser.id}`,
    userId: String(otherUser.id),
  });
  const otherVersion = createOwnerRows(fixture.db, {
    tenantId: fixture.tenantId,
    userId: fixture.userId,
    sourceFingerprint: 'c'.repeat(64),
  });
  await withServer(fixture.router, async (baseUrl) => {
    const body = { idempotency_key: 'owner-check', expected_updated_at: NOW };
    const unauthorized = await post(baseUrl, fixture, body, { auth: false });
    assert.equal(unauthorized.status, 401);
    const missingTenant = await post(baseUrl, fixture, body, { tenant: false });
    assert.equal(missingTenant.status, 404);
    const foreignTenant = await post(baseUrl, fixture, body, { tenantId: 'missing-tenant' });
    assert.equal(foreignTenant.status, 404);
    const foreignVersion = await post(baseUrl, fixture, body, { versionId: 999999 });
    assert.equal(foreignVersion.status, 404);
    const foreignVoice = await post(baseUrl, fixture, body, { voiceAssetId: 999999 });
    assert.equal(foreignVoice.status, 404);
    const foreignUser = await post(baseUrl, fixture, body, {
      versionId: otherOwner.versionId,
      voiceAssetId: otherOwner.voiceAssetId,
    });
    assert.equal(foreignUser.status, 404);
    const crossVersionVoice = await post(baseUrl, fixture, body, {
      voiceAssetId: otherVersion.voiceAssetId,
    });
    assert.equal(crossVersionVoice.status, 404);
    const crossVersionSlot = await post(baseUrl, fixture, body, {
      versionId: otherVersion.versionId,
    });
    assert.equal(crossVersionSlot.status, 404);
    fixture.db.prepare("UPDATE redraw_assets SET kind = 'character' WHERE id = ?").run(fixture.voiceAssetId);
    const wrongKind = await post(baseUrl, fixture, body);
    assert.equal(wrongKind.status, 404);
  });
  assert.equal(calls, 0);
});

test('local production voice route accepts exact body only and never calls the service for client control', async (t) => {
  let calls = 0;
  const fixture = routeFixture(t, { async registerLocalProductionVoice() { calls += 1; return {}; } });
  const forbidden = [
    'locale', 'market', 'text', 'approved_text', 'profile', 'path', 'output_path',
    'hash', 'audio_sha256', 'asset', 'audio_asset_id', 'evidence', 'billing',
    'provider', 'command', 'constructor', 'prototype', 'unknown',
  ];
  await withServer(fixture.router, async (baseUrl) => {
    for (const field of forbidden) {
      const response = await post(baseUrl, fixture, {
        idempotency_key: `forbidden-${field}`,
        expected_updated_at: NOW,
        [field]: field === 'billing' ? { credits: 0 } : 'client-controlled',
      });
      assert.equal(response.status, 400, `${field}: ${await response.text()}`);
    }
    const polluted = await post(
      baseUrl,
      fixture,
      `{"idempotency_key":"polluted","expected_updated_at":"${NOW}","__proto__":{"admin":true}}`,
    );
    assert.equal(polluted.status, 400);
    for (const invalid of [null, [], {}, { idempotency_key: '', expected_updated_at: NOW }]) {
      const response = await post(baseUrl, fixture, invalid);
      assert.equal(response.status, 400);
    }
  });
  assert.equal(calls, 0);
});

test('local production voice route passes trusted exact input and returns only its public projection', async (t) => {
  const calls = [];
  let fixture;
  const service = {
    async registerLocalProductionVoice(input) {
      calls.push(input);
      const audioBytes = Buffer.from('public local voice');
      const audioSha = sha256(audioBytes);
      const localPath = `redraw-local-voices/${audioSha}.wav`;
      fs.mkdirSync(path.join(fixture.storageRoot, 'redraw-local-voices'), { recursive: true });
      fs.writeFileSync(path.join(fixture.storageRoot, localPath), audioBytes);
      const audioId = Number(fixture.db.prepare(`INSERT INTO assets
        (drama_id, name, type, category, url, local_path, file_size, mime_type, duration,
         metadata, created_at, updated_at)
        VALUES (?, 'voice.wav', 'audio', 'redraw-local-voice', '', ?, ?, 'audio/wav', 1,
          '{}', ?, ?)`)
        .run(fixture.projectId, localPath, audioBytes.length, NOW, NOW).lastInsertRowid);
      const registrationId = Number(fixture.db.prepare(`INSERT INTO redraw_local_voice_registrations
        (tenant_id, user_id, version_id, voice_redraw_asset_id, source_character_key,
         idempotency_hash, request_hash, target_locale, target_market, approved_text_sha256,
         profile_key, engine_manifest_sha256, status, audio_asset_id, audio_sha256,
         locale_evidence_sha256, created_at, updated_at, completed_at)
        VALUES (?, ?, ?, ?, 'char-a', ?, ?, 'en-US', 'US', ?, 'voice-a', ?, 'completed',
          ?, ?, ?, ?, ?, ?)`)
        .run(
          fixture.tenantId, fixture.userId, fixture.versionId, fixture.voiceAssetId,
          sha256('public-idempotency'), sha256('public-request'), '3'.repeat(64), '4'.repeat(64),
          audioId, audioSha, '5'.repeat(64), NOW, `${NOW}.001`, `${NOW}.002`,
        ).lastInsertRowid);
      fixture.db.prepare(`UPDATE redraw_assets
        SET voice_asset_id = ?, status = 'generated', approval_status = 'pending', updated_at = ?
        WHERE id = ?`).run(audioId, `${NOW}.001`, fixture.voiceAssetId);
      return {
        registration: {
          id: registrationId,
          status: 'completed',
          source_character_key: 'char-a',
          profile_key: 'voice-a',
          audio_asset_id: audioId,
          audio_sha256: audioSha,
          completed_at: `${NOW}.002`,
          approved_text: 'must not leak',
          output_path: 'C:\\private\\voice.wav',
        },
        billing: { credits: 0, held: 0, charged: 0 },
        raw_evidence: { command: 'espeak --secret' },
      };
    },
  };
  fixture = routeFixture(t, service);
  await withServer(fixture.router, async (baseUrl) => {
    const response = await post(baseUrl, fixture, {
      idempotency_key: 'public-idempotency', expected_updated_at: NOW,
    });
    const raw = await response.text();
    assert.equal(response.status, 200, raw);
    assert.equal(/approved text|private|command|raw_evidence|output_path/i.test(raw), false);
    const data = JSON.parse(raw).data;
    assert.deepEqual(Object.keys(data).sort(), [
      'audio', 'billing', 'cas', 'registration', 'status', 'version', 'voice',
    ]);
    assert.deepEqual(data.billing, { credits: 0, held: 0, charged: 0 });
    assert.equal(data.status, 'completed');
    assert.deepEqual(Object.keys(data.registration).sort(), [
      'completed_at', 'id', 'profile_key', 'source_character_key', 'status',
    ]);
    assert.deepEqual(Object.keys(data.version).sort(), ['id', 'locale', 'market']);
    assert.deepEqual(Object.keys(data.voice).sort(), [
      'approval_status', 'audio_asset_id', 'id', 'status', 'updated_at',
    ]);
    assert.deepEqual(Object.keys(data.audio).sort(), [
      'duration_ms', 'id', 'mime_type', 'sha256',
    ]);
    assert.deepEqual(data.cas, { expected_updated_at: NOW, updated_at: `${NOW}.001` });
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]).sort(), [
    'audioStorageRoot', 'db', 'expectedUpdatedAt', 'idempotencyKey', 'localeRegistry',
    'localeVerifier', 'localeVerifierAllowedRoot', 'localTtsManifest', 'localTtsWorker',
    'log', 'mediaProbe', 'minimumApprovedTextCharacters', 'tenantId', 'userId', 'versionId',
    'voiceAssetId',
  ].sort());
  assert.equal(calls[0].tenantId, fixture.tenantId);
  assert.equal(calls[0].userId, fixture.userId);
  assert.equal(calls[0].versionId, fixture.versionId);
  assert.equal(calls[0].voiceAssetId, fixture.voiceAssetId);
  assert.equal(calls[0].expectedUpdatedAt, NOW);
  assert.equal(calls[0].idempotencyKey, 'public-idempotency');
});

test('production voice listing projects the trusted evidence branch without mislabelling local audio', async (t) => {
  const fixture = routeFixture(t, { async registerLocalProductionVoice() { throw new Error('unused'); } }, {
    redrawOptions: { allowTestOnlyLocalEvidence: true },
  });
  const bytes = Buffer.from('local listing voice');
  const audioSha = sha256(bytes);
  const localPath = 'redraw-local-voices/listing.wav';
  fs.mkdirSync(path.join(fixture.storageRoot, 'redraw-local-voices'), { recursive: true });
  fs.writeFileSync(path.join(fixture.storageRoot, localPath), bytes);
  const audioId = Number(fixture.db.prepare(`INSERT INTO assets
    (drama_id, name, type, category, url, local_path, file_size, mime_type, duration,
     metadata, created_at, updated_at)
    VALUES (?, 'listing.wav', 'audio', 'redraw-local-voice', '', ?, ?, 'audio/wav', 1,
      '{}', ?, ?)`)
    .run(fixture.projectId, localPath, bytes.length, NOW, NOW).lastInsertRowid);
  const registrationId = Number(fixture.db.prepare(`INSERT INTO redraw_local_voice_registrations
    (tenant_id, user_id, version_id, voice_redraw_asset_id, source_character_key,
     idempotency_hash, request_hash, target_locale, target_market, approved_text_sha256,
     profile_key, engine_manifest_sha256, status, audio_asset_id, audio_sha256,
     locale_evidence_sha256, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, 'char-a', ?, ?, 'en-US', 'US', ?, 'voice-a', ?, 'completed',
      ?, ?, ?, ?, ?, ?)`)
    .run(
      fixture.tenantId, fixture.userId, fixture.versionId, fixture.voiceAssetId,
      sha256('listing-idempotency'), sha256('listing-request'), '3'.repeat(64), '4'.repeat(64),
      audioId, audioSha, '5'.repeat(64), NOW, NOW, NOW,
    ).lastInsertRowid);
  const evidence = {
    source: 'local_offline_tts',
    contract_version: 'local-offline-tts-v1',
    tenant_id: fixture.tenantId,
    user_id: fixture.userId,
    version_id: fixture.versionId,
    voice_redraw_asset_id: fixture.voiceAssetId,
    source_character_key: 'char-a',
    locale: 'en-US',
    market: 'US',
    profile: 'voice-a',
    engine: 'eSpeak NG',
    engine_version: '1.52.0',
    binary_sha256: '6'.repeat(64),
    manifest_sha256: '4'.repeat(64),
    audio_asset_id: audioId,
    audio_sha256: audioSha,
    duration_ms: 1000,
    approved_text_sha256: '3'.repeat(64),
    locale_pack: 'en-US@fixture',
    transcript_sha256: '7'.repeat(64),
    model_manifest_sha256: MODEL_SHA,
    calibration_manifest_sha256: CALIBRATION_SHA,
    metrics: { word_error_rate: 0, critical_tokens_match: true },
    language_verified: true,
    detected_locale: 'en-US',
    registration_id: registrationId,
    registration_status: 'completed',
    completed_at: NOW,
    test_only: true,
  };
  fixture.db.prepare(`UPDATE redraw_assets SET voice_asset_id = ?, status = 'generated',
    approval_status = 'approved', source_ref_json = ? WHERE id = ?`)
    .run(audioId, JSON.stringify({
      source_ref: { source_character_key: 'char-a' }, snapshot: { voice_evidence: evidence },
    }), fixture.voiceAssetId);
  await withServer(fixture.router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/redraw/versions/${fixture.versionId}/voices`, {
      headers: {
        Authorization: `Bearer ${fixture.token}`,
        'X-Tenant-Id': fixture.tenantId,
      },
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].verification_source, 'local_offline_tts');
    assert.equal(body.data[0].provider_verified, false);
    assert.equal(body.data[0].local_offline_verified, true);
  });
});

test('local production voice route maps stable service errors and redacts unknown failures', async (t) => {
  const logEntries = [];
  const service = {
    async registerLocalProductionVoice(input) {
      const code = input.idempotencyKey;
      if (code === 'UNKNOWN') {
        throw Object.assign(
          new Error('C:\\private\\voice.wav Authorization: Bearer secret SQL SELECT'),
          { code: 'C:\\private\\error-code API_KEY=secret' },
        );
      }
      throw Object.assign(new Error('private provider details'), { code });
    },
  };
  const fixture = routeFixture(t, service, {
    log: { info() {}, warn() {}, error(entry) { logEntries.push(entry); } },
  });
  const mappings = [
    ['REDRAW_LOCAL_TTS_NOT_READY', 503],
    ['REDRAW_LOCAL_TTS_OWNER_MISMATCH', 404],
    ['REDRAW_LOCAL_TTS_APPROVED_TEXT_INSUFFICIENT', 422],
    ['REDRAW_LOCAL_TTS_IDEMPOTENCY_CONFLICT', 409],
    ['REDRAW_LOCAL_TTS_OUTPUT_INVALID', 422],
    ['REDRAW_LOCAL_TTS_VERIFICATION_FAILED', 422],
    ['REDRAW_LOCAL_TTS_RESULT_UNKNOWN', 409],
    ['REDRAW_LOCAL_TTS_CAS_CONFLICT', 409],
    ['UNKNOWN', 500],
  ];
  await withServer(fixture.router, async (baseUrl) => {
    for (const [code, status] of mappings) {
      const response = await post(baseUrl, fixture, {
        idempotency_key: code, expected_updated_at: NOW,
      });
      const raw = await response.text();
      assert.equal(response.status, status, `${code}: ${raw}`);
      assert.equal(/private|Authorization|Bearer|secret|SELECT/i.test(raw), false);
      assert.equal(JSON.parse(raw).error.code, status === 500 ? 'INTERNAL_ERROR' : code);
    }
  });
  assert.equal(/private|API_KEY|secret/i.test(JSON.stringify(logEntries)), false);
});

async function fiveRoleFixture(t) {
  const characters = Array.from({ length: 5 }, (_, index) => ({
    key: `char-${index + 1}`,
    name: ['Alice Carter', 'Brian Miller', 'Claire Davis', 'Daniel Evans', 'Emma Foster'][index],
    profile: `voice-${index + 1}`,
  }));
  const profiles = characters.map((character, index) => ({
    profile_key: character.profile,
    locale: 'en-US',
    voice: 'en-us',
    pitch: 35 + index,
    rate: 165 + index,
    amplitude: 95 + index,
  }));
  const manifestBase = {
    schema_version: 'local-tts-manifest-v1',
    engine: 'eSpeak NG',
    engine_version: '1.52.0',
    executable_path: path.resolve('fixtures/espeak-ng'),
    executable_sha256: '8'.repeat(64),
    profiles,
    test_only: true,
  };
  const manifest = { ...manifestBase, manifest_sha256: canonicalManifestSha256(manifestBase) };
  const counters = {
    localSyntheses: 0,
    localeVerifications: 0,
    supplierCalls: 0,
    providerCalls: 0,
  };
  const registry = trustedRegistry();
  const worker = {
    assertReady(locale) { assert.equal(locale, 'en-US'); },
    assertEvidenceTrusted(evidence) {
      const profile = profiles.find((item) => item.profile_key === evidence.profile);
      if (!profile || evidence.source !== 'local_offline_tts'
        || evidence.manifest_sha256 !== manifest.manifest_sha256
        || evidence.test_only !== true) throw new Error('untrusted local invocation');
      return { profile: { ...profile } };
    },
    async synthesize(input) {
      counters.localSyntheses += 1;
      const profile = profiles.find((item) => item.profile_key === input.profileKey);
      assert.ok(profile);
      const bytes = pcmWave(profiles.indexOf(profile) + 1);
      const outputPath = path.join(input.outputRoot, `${profile.profile_key}.wav`);
      fs.writeFileSync(outputPath, bytes, { flag: 'wx' });
      return {
        source: 'local_offline_tts',
        engine: manifest.engine,
        engine_version: manifest.engine_version,
        binary_sha256: manifest.executable_sha256,
        manifest_sha256: manifest.manifest_sha256,
        target_locale: input.locale,
        output_path: outputPath,
        output_sha256: sha256(bytes),
        profile: { ...profile },
        completed_at: '2026-08-28T00:00:01.000Z',
        test_only: true,
      };
    },
  };
  const mediaProbe = {
    async probeAudio(input) {
      const size = fs.statSync(input.audioPath).size;
      return {
        format: 'wav', audio_streams: 1, decodable: true, non_silent: true,
        duration_ms: 1000, size_bytes: size,
      };
    },
  };
  const localeVerifier = {
    async verifyLocalVoice(input) {
      counters.localeVerifications += 1;
      return {
        requestId: input.requestId,
        source: 'offline-worker',
        audioSha256: input.audioSha256,
        approvedTextSha256: sha256(input.approvedText),
        localePack: 'en-US@fixture',
        languageVerified: true,
        detectedLocale: 'en-US',
        transcriptSha256: sha256(`transcript:${input.approvedText}`),
        modelManifestSha256: MODEL_SHA,
        calibrationManifestSha256: CALIBRATION_SHA,
        metrics: { word_error_rate: 0, character_error_rate: 0, critical_tokens_match: true },
        localTtsInvocation: { ...input.localTtsInvocation },
        completedAt: '2026-08-28T00:00:02.000Z',
      };
    },
  };
  const fixture = routeFixture(t, null, {
    localeRegistry: registry,
    localeVerifier,
    localTtsWorker: worker,
    localTtsManifest: manifest,
    mediaProbe,
    onProviderCall() { counters.providerCalls += 1; },
    onSupplierCall() { counters.supplierCalls += 1; },
    sourceFacts: {
      schema_version: '2.0',
      characters: characters.map((character) => ({
        source_character_key: character.key,
        source_name: character.name,
      })),
      shots: [],
    },
    factsHash: '9'.repeat(64),
    localizationTaskId: 'local-five-role-task',
    redrawOptions: {
      localVoiceRegistrationContext: 'test',
      localVoiceMinimumApprovedTextCharacters: 10,
      allowTestOnlyLocalEvidence: true,
    },
  });
  fixture.db.prepare(`INSERT INTO dramas
    (id, title, tenant_id, user_id, created_at, updated_at)
    VALUES (?, 'Local voice owner', ?, ?, ?, ?)`)
    .run(fixture.projectId, fixture.tenantId, fixture.userId, NOW, NOW);
  const factsHash = '9'.repeat(64);
  fixture.db.prepare(`INSERT INTO async_tasks
    (id, type, status, progress, result, resource_id, tenant_id, user_id,
     created_at, updated_at, completed_at)
    VALUES ('local-five-role-task', 'redraw_localization', 'completed', 100, ?, ?, ?, ?, ?, ?, ?)`)
    .run(JSON.stringify({
      status: 'completed',
      work_id: fixture.workId,
      version_id: fixture.versionId,
      facts_hash: factsHash,
      localization_decision: {
        action: 'advance', policy_version: 7, evidence_hash: factsHash, version_id: fixture.versionId,
      },
    }), String(fixture.workId), fixture.tenantId, fixture.userId, NOW, NOW, NOW);
  const insertShot = fixture.db.prepare(`INSERT INTO redraw_shots
    (work_id, shot_id, version_id, tenant_id, user_id, batch_index, shot_index,
     start_ms, end_ms, duration_ms, source_dialogue_json, localized_dialogue_json,
     references_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 2000, '[]', ?, '[]', 'draft', ?, ?)`);
  const voiceIds = [fixture.voiceAssetId];
  const characterIds = [];
  for (const [index, character] of characters.entries()) {
    insertShot.run(
      String(fixture.workId), `shot-${index + 1}`, fixture.versionId, fixture.tenantId,
      fixture.userId, index + 1, index * 2000, (index + 1) * 2000,
      JSON.stringify([{ speaker_id: character.key, target_text: `${character.name} approved dialogue.` }]),
      NOW, NOW,
    );
    let voiceId = fixture.voiceAssetId;
    if (index === 0) {
      fixture.db.prepare('UPDATE redraw_assets SET source_ref_json = ?, localized_name = ? WHERE id = ?')
        .run(JSON.stringify({ source_ref: { source_character_key: character.key } }),
          `${character.name} voice`, voiceId);
    } else {
      voiceId = Number(fixture.db.prepare(`INSERT INTO redraw_assets
        (version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
         version_number, approval_status, status, created_at, updated_at)
        VALUES (?, ?, ?, 'voice', ?, ?, 1, 'pending', 'draft', ?, ?)`)
        .run(fixture.versionId, fixture.tenantId, fixture.userId,
          JSON.stringify({ source_ref: { source_character_key: character.key } }),
          `${character.name} voice`, NOW, NOW).lastInsertRowid);
      voiceIds.push(voiceId);
    }
    const identityBytes = Buffer.from(`identity-${character.key}`);
    const wardrobeBytes = Buffer.from(`wardrobe-${character.key}`);
    const identityPath = `identity/${character.key}.png`;
    const wardrobePath = `identity/${character.key}-wardrobe.png`;
    fs.mkdirSync(path.join(fixture.storageRoot, 'identity'), { recursive: true });
    fs.writeFileSync(path.join(fixture.storageRoot, identityPath), identityBytes);
    fs.writeFileSync(path.join(fixture.storageRoot, wardrobePath), wardrobeBytes);
    const identityId = Number(fixture.db.prepare(`INSERT INTO assets
      (drama_id, name, type, category, url, local_path, file_size, mime_type, width, height,
       metadata, created_at, updated_at)
      VALUES (?, ?, 'image', 'redraw', '', ?, ?, 'image/png', 640, 960, '{}', ?, ?)`)
      .run(fixture.projectId, `${character.key}.png`, identityPath, identityBytes.length, NOW, NOW)
      .lastInsertRowid);
    const wardrobeId = Number(fixture.db.prepare(`INSERT INTO assets
      (drama_id, name, type, category, url, local_path, file_size, mime_type, width, height,
       metadata, created_at, updated_at)
      VALUES (?, ?, 'image', 'redraw', '', ?, ?, 'image/png', 640, 960, '{}', ?, ?)`)
      .run(fixture.projectId, `${character.key}-wardrobe.png`, wardrobePath, wardrobeBytes.length, NOW, NOW)
      .lastInsertRowid);
    const characterId = Number(fixture.db.prepare(`INSERT INTO redraw_assets
      (version_id, tenant_id, user_id, kind, source_ref_json, localized_name, asset_id,
       version_number, approval_status, status, created_at, updated_at)
      VALUES (?, ?, ?, 'character', ?, ?, ?, 1, 'pending', 'generated', ?, ?)`)
      .run(fixture.versionId, fixture.tenantId, fixture.userId,
        JSON.stringify({ source_ref: { source_character_key: character.key } }),
        character.name, identityId, NOW, NOW).lastInsertRowid);
    saveIdentityPack({
      db: fixture.db,
      tenantId: fixture.tenantId,
      userId: fixture.userId,
      versionId: fixture.versionId,
      storageRoot: fixture.storageRoot,
      assetReader: { canRead: () => true, owns: () => true },
      now: () => NOW,
    }, characterId, {
      expected_updated_at: NOW,
      target_actor_label: character.name,
      confirmed_views: ['front', 'profile', 'full_body'],
      live_action_human_confirmed: true,
      adult_status: 'verified_18_plus',
      identity_consistency_confirmed: true,
      persona_origin: 'fictional_ai_generated',
      target_country: 'US',
      wardrobe_reference_asset_id: wardrobeId,
      wardrobe_consistency_confirmed: true,
    });
    characterIds.push(characterId);
  }
  return { ...fixture, characters, voiceIds, characterIds, counters };
}

test('five local voices traverse real HTTP registration review assignment rereview and reach 5/5 character-plan', async (t) => {
  const fixture = await fiveRoleFixture(t);
  const billingBefore = {
    usage: fixture.db.prepare('SELECT COUNT(*) AS count FROM usage_reservations').get().count,
    tenantUsage: fixture.db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count,
    ledger: fixture.db.prepare('SELECT COUNT(*) AS count FROM tenant_credit_ledger').get().count,
  };
  await withServer(fixture.router, async (baseUrl) => {
    const stale = await post(baseUrl, fixture, {
      idempotency_key: 'five-role-stale-cas',
      expected_updated_at: '2026-08-27T00:00:00.000Z',
    }, { voiceAssetId: fixture.voiceIds[0] });
    const staleBody = await stale.json();
    assert.equal(stale.status, 409, JSON.stringify(staleBody));
    assert.equal(staleBody.error.code, 'REDRAW_LOCAL_TTS_CAS_CONFLICT');
    assert.equal(fixture.counters.localSyntheses, 0);

    for (const [index, voiceAssetId] of fixture.voiceIds.entries()) {
      const registered = await post(baseUrl, fixture, {
        idempotency_key: `five-role-${index + 1}`,
        expected_updated_at: NOW,
      }, { voiceAssetId });
      const registrationBody = await registered.json();
      assert.equal(registered.status, 200, JSON.stringify(registrationBody));
      assert.equal(registrationBody.data.status, 'completed');
      assert.deepEqual(registrationBody.data.billing, { credits: 0, held: 0, charged: 0 });

      const voiceReview = await fetch(`${baseUrl}/redraw/assets/${voiceAssetId}/review`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          'X-Tenant-Id': fixture.tenantId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'approved', expected_updated_at: registrationBody.data.voice.updated_at,
        }),
      });
      assert.equal(voiceReview.status, 200, await voiceReview.text());

      const characterId = fixture.characterIds[index];
      const characterBefore = fixture.db.prepare('SELECT updated_at FROM redraw_assets WHERE id = ?')
        .get(characterId);
      const assigned = await fetch(`${baseUrl}/redraw/assets/${characterId}/voice`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          'X-Tenant-Id': fixture.tenantId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ voice_asset_id: voiceAssetId, expected_updated_at: characterBefore.updated_at }),
      });
      const assignedBody = await assigned.json();
      assert.equal(assigned.status, 200, JSON.stringify(assignedBody));
      assert.equal(assignedBody.data.voice_snapshot.verification_source, 'local_offline_tts');
      assert.equal(assignedBody.data.voice_snapshot.provider_verified, false);
      assert.equal(assignedBody.data.voice_snapshot.local_offline_verified, true);

      const characterReview = await fetch(`${baseUrl}/redraw/assets/${characterId}/review`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          'X-Tenant-Id': fixture.tenantId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'approved', expected_updated_at: assignedBody.data.asset.updated_at,
        }),
      });
      assert.equal(characterReview.status, 200, await characterReview.text());
    }
    const planResponse = await fetch(`${baseUrl}/redraw/versions/${fixture.versionId}/character-plan`, {
      headers: {
        Authorization: `Bearer ${fixture.token}`,
        'X-Tenant-Id': fixture.tenantId,
      },
    });
    const plan = await planResponse.json();
    assert.equal(planResponse.status, 200, JSON.stringify(plan));
    assert.equal(plan.data.ready, true, JSON.stringify(plan.data.missing));
    assert.equal(plan.data.characters.length, 5);
    assert.equal(plan.data.characters.filter((item) => item.voice.ready).length, 5);
  });
  assert.deepEqual({
    syntheses: fixture.counters.localSyntheses,
    verifications: fixture.counters.localeVerifications,
    supplier: fixture.counters.supplierCalls,
    provider: fixture.counters.providerCalls,
  }, { syntheses: 5, verifications: 5, supplier: 0, provider: 0 });
  assert.deepEqual(new Set(fixture.db.prepare(
    'SELECT profile_key FROM redraw_local_voice_registrations WHERE status = \'completed\'',
  ).all().map((row) => row.profile_key)).size, 5);
  assert.deepEqual({
    usage: fixture.db.prepare('SELECT COUNT(*) AS count FROM usage_reservations').get().count,
    tenantUsage: fixture.db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count,
    ledger: fixture.db.prepare('SELECT COUNT(*) AS count FROM tenant_credit_ledger').get().count,
  }, billingBefore);
});
