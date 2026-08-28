const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const Database = require('better-sqlite3');
const express = require('express');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { setupRouter } = require('../src/routes');
const approvalService = require('../src/services/redrawSupplementalDialogueApprovalService');
const userAuthService = require('../src/services/userAuthService');

const NOW = '2026-08-28T00:00:00.000Z';
const APPROVED_TEXT = 'Welcome home, son.';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function insertApprovalScope(db, owner, suffix) {
  const factsHash = sha256(`facts:${suffix}`);
  const stableShotId = `shot-${suffix}`;
  const characterKey = `rafael-${suffix}`;
  const taskId = `localization-${suffix}`;
  const projectId = Number(db.prepare(`INSERT INTO redraw_projects
    (tenant_id, user_id, title, default_locale, default_market, localization_level,
     status, policy_version, created_at, updated_at)
    VALUES (?, ?, ?, 'en-US', 'US', 'faithful', 'active', 7, ?, ?)`).run(
    owner.tenantId, owner.userId, `Project ${suffix}`, NOW, NOW,
  ).lastInsertRowid);
  const workId = Number(db.prepare(`INSERT INTO redraw_works
    (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
     duration_ms, current_version, current_step, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, 12000, 1, 2, 'asset_review', ?, ?)`).run(
    projectId, owner.tenantId, owner.userId, `Work ${suffix}`, sha256(`source:${suffix}`), NOW, NOW,
  ).lastInsertRowid);
  const sourceFacts = {
    schema_version: '2.0',
    facts_hash: factsHash,
    characters: [{ id: characterKey, source_name: 'Rafael' }],
    shots: [{ id: stableShotId, visible_character_ids: [characterKey], dialogue: [] }],
  };
  const versionId = Number(db.prepare(`INSERT INTO redraw_versions
    (work_id, tenant_id, user_id, version, locale, market, localization_level,
     source_facts_json, facts_hash, localization_task_id, status, created_at, updated_at)
    VALUES (?, ?, ?, 1, 'en-US', 'US', 'faithful', ?, ?, ?, 'asset_review', ?, ?)`).run(
    workId, owner.tenantId, owner.userId, JSON.stringify(sourceFacts), factsHash, taskId, NOW, NOW,
  ).lastInsertRowid);
  const shotRowId = Number(db.prepare(`INSERT INTO redraw_shots
    (work_id, shot_id, version_id, tenant_id, user_id, batch_index, shot_index,
     start_ms, end_ms, duration_ms, source_dialogue_json, localized_dialogue_json,
     references_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, 6, 0, 4000, 4000, '[]', '[]', '[]', 'draft', ?, ?)`).run(
    workId, stableShotId, versionId, owner.tenantId, owner.userId, NOW, NOW,
  ).lastInsertRowid);
  const voiceAssetId = Number(db.prepare(`INSERT INTO redraw_assets
    (version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     version_number, approval_status, status, created_at, updated_at)
    VALUES (?, ?, ?, 'voice', ?, 'Rafael voice', 1, 'pending', 'draft', ?, ?)`).run(
    versionId,
    owner.tenantId,
    owner.userId,
    JSON.stringify({ source_ref: { kind: 'voice', source_character_key: characterKey } }),
    NOW,
    NOW,
  ).lastInsertRowid);
  db.prepare(`INSERT INTO async_tasks
    (id, type, status, progress, result, resource_id, tenant_id, user_id,
     created_at, updated_at, completed_at)
    VALUES (?, 'redraw_localization', 'completed', 100, ?, ?, ?, ?, ?, ?, ?)`).run(
    taskId,
    JSON.stringify({
      status: 'completed',
      work_id: workId,
      version_id: versionId,
      facts_hash: factsHash,
      localization_decision: {
        action: 'advance', policy_version: 7, evidence_hash: factsHash, version_id: versionId,
      },
    }),
    String(workId),
    owner.tenantId,
    owner.userId,
    NOW,
    NOW,
    NOW,
  );
  return { workId, versionId, shotRowId, voiceAssetId };
}

function routeFixture(t, overrides = {}) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const previous = {
    publicMode: process.env.PUBLIC_PLATFORM_MODE,
    jwtSecret: process.env.PLATFORM_JWT_SECRET,
  };
  process.env.PUBLIC_PLATFORM_MODE = 'true';
  process.env.PLATFORM_JWT_SECRET = 'supplemental-dialogue-route-secret-at-least-32-bytes';
  t.after(() => {
    db.close();
    if (previous.publicMode === undefined) delete process.env.PUBLIC_PLATFORM_MODE;
    else process.env.PUBLIC_PLATFORM_MODE = previous.publicMode;
    if (previous.jwtSecret === undefined) delete process.env.PLATFORM_JWT_SECRET;
    else process.env.PLATFORM_JWT_SECRET = previous.jwtSecret;
  });
  const user = userAuthService.register(db, {
    email: `supplemental-${crypto.randomUUID()}@example.test`,
    password: 'supplemental-dialogue-route-password-123',
  });
  const tenantId = `personal:${user.id}`;
  const userId = String(user.id);
  const scope = insertApprovalScope(db, { tenantId, userId }, `owner-${user.id}`);
  const logEntries = [];
  const log = overrides.log || {
    info() {}, warn() {}, error(entry) { logEntries.push(entry); },
  };
  const service = overrides.service || approvalService;
  const router = setupRouter({ storage: { local_path: './data/storage' } }, db, log, {
    localizationProvider: async () => ({ status: 'failed' }),
    assetGenerationProvider: async () => ({ status: 'failed' }),
    dialogueProvider: async () => ({ status: 'failed' }),
    redrawOptions: {
      supplementalDialogueApprovalService: service,
      supplementalDialogueNow: () => NOW,
    },
  });
  return {
    db,
    router,
    logEntries,
    tenantId,
    userId,
    token: userAuthService.issueToken(user, process.env.PLATFORM_JWT_SECRET, 0),
    ...scope,
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
    await run(`http://127.0.0.1:${server.address().port}/api/v1`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function headers(fixture, overrides = {}) {
  const value = { 'Content-Type': 'application/json' };
  if (overrides.auth !== false) value.Authorization = `Bearer ${overrides.token || fixture.token}`;
  if (overrides.tenant !== false) value['X-Tenant-Id'] = overrides.tenantId || fixture.tenantId;
  return value;
}

function createUrl(baseUrl, fixture, overrides = {}) {
  return `${baseUrl}/redraw/versions/${overrides.versionId || fixture.versionId}`
    + `/shots/${overrides.shotRowId || fixture.shotRowId}`
    + `/voices/${overrides.voiceAssetId || fixture.voiceAssetId}`
    + '/supplemental-dialogue-approvals';
}

function createBody(overrides = {}) {
  return {
    idempotency_key: 'approve-rafael-shot-6',
    target_text: APPROVED_TEXT,
    source_translation: false,
    expected_shot_updated_at: NOW,
    expected_voice_updated_at: NOW,
    ...overrides,
  };
}

function postCreate(baseUrl, fixture, body = createBody(), overrides = {}) {
  return fetch(createUrl(baseUrl, fixture, overrides), {
    method: 'POST',
    headers: headers(fixture, overrides),
    body: JSON.stringify(body),
  });
}

function postRevoke(baseUrl, fixture, approvalId, body, overrides = {}) {
  const versionId = overrides.versionId || fixture.versionId;
  return fetch(
    `${baseUrl}/redraw/versions/${versionId}/supplemental-dialogue-approvals/${approvalId}/revoke`,
    { method: 'POST', headers: headers(fixture, overrides), body: JSON.stringify(body) },
  );
}

function assertPrivatePayload(raw) {
  assert.equal(raw.includes(APPROVED_TEXT), false);
  assert.equal(/target_text(?:"|\s|:)/i.test(raw), false);
  assert.equal(/(?:[a-zA-Z]:[\\/]|file:\/\/|Authorization|Bearer secret|SELECT \*)/i.test(raw), false);
  assert.equal(/dialogue_context_sha256|localization_decision|raw_evidence/i.test(raw), false);
}

test('supplemental dialogue routes are registered without changing local registration route', (t) => {
  const fixture = routeFixture(t);
  const registered = new Set(fixture.router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods)
      .map((method) => `${method.toUpperCase()} ${layer.route.path}`)));
  assert.equal(registered.has(
    'POST /redraw/versions/:versionId/shots/:shotRowId/voices/:voiceAssetId/supplemental-dialogue-approvals',
  ), true);
  assert.equal(registered.has(
    'POST /redraw/versions/:versionId/supplemental-dialogue-approvals/:approvalId/revoke',
  ), true);
  assert.equal(registered.has(
    'POST /redraw/versions/:versionId/voices/:voiceAssetId/local-production-registrations',
  ), true);
});

test('create authenticates, scopes every path resource to the owner, and keeps registration body exact', async (t) => {
  const fixture = routeFixture(t);
  await withServer(fixture.router, async (baseUrl) => {
    const unauthorized = await postCreate(baseUrl, fixture, createBody(), { auth: false });
    assert.equal(unauthorized.status, 401);
    const cases = [
      { tenant: false },
      { tenantId: 'personal:missing' },
      { versionId: 999999 },
      { shotRowId: 999999 },
      { voiceAssetId: 999999 },
    ];
    for (const item of cases) {
      const result = await postCreate(baseUrl, fixture, createBody(), item);
      const raw = await result.text();
      assert.equal(result.status, 404, raw);
      assert.equal(['NOT_FOUND', 'REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_FOUND'].includes(
        JSON.parse(raw).error.code,
      ), true);
      assertPrivatePayload(raw);
    }
    const registration = await fetch(
      `${baseUrl}/redraw/versions/${fixture.versionId}/voices/${fixture.voiceAssetId}`
        + '/local-production-registrations',
      {
        method: 'POST',
        headers: headers(fixture),
        body: JSON.stringify({
          idempotency_key: 'registration-must-not-accept-text',
          expected_updated_at: NOW,
          target_text: APPROVED_TEXT,
        }),
      },
    );
    assert.equal(registration.status, 400);
    assert.equal((await registration.json()).error.code, 'REDRAW_LOCAL_TTS_CLIENT_CONTROL_FORBIDDEN');
  });
  assert.equal(fixture.db.prepare(
    'SELECT COUNT(*) AS count FROM redraw_supplemental_dialogue_approvals',
  ).get().count, 0);
});

test('create accepts only exact five keys and rejects invalid private text without logging it', async (t) => {
  const fixture = routeFixture(t);
  const cases = [
    { body: { ...createBody(), extra: 'forbidden' } },
    { body: createBody({ source_translation: true }) },
    { body: createBody({ target_text: '   ' }) },
    { body: createBody({ target_text: `C:\\private\\voice.wav\0${APPROVED_TEXT}` }) },
    { body: createBody({ expected_shot_updated_at: 'not-a-time' }) },
  ];
  await withServer(fixture.router, async (baseUrl) => {
    for (const item of cases) {
      const response = await postCreate(baseUrl, fixture, item.body);
      const raw = await response.text();
      assert.equal([400, 422].includes(response.status), true, raw);
      assert.equal(JSON.parse(raw).error.code, 'REDRAW_SUPPLEMENTAL_DIALOGUE_INPUT_INVALID');
      assertPrivatePayload(raw);
    }
  });
  assertPrivatePayload(JSON.stringify(fixture.logEntries));
  assert.equal(fixture.db.prepare(
    'SELECT COUNT(*) AS count FROM redraw_supplemental_dialogue_approvals',
  ).get().count, 0);
});

test('create and replay return the exact public keys while conflicts stay stable and private', async (t) => {
  const fixture = routeFixture(t);
  const expectedKeys = [
    'approval_evidence_sha256', 'approval_id', 'approved_at', 'contract_version',
    'idempotent_replay', 'redraw_shot_id', 'source_translation', 'status',
    'target_text_sha256', 'updated_at', 'version_id', 'voice_redraw_asset_id',
  ];
  await withServer(fixture.router, async (baseUrl) => {
    const created = await postCreate(baseUrl, fixture);
    const createdRaw = await created.text();
    assert.equal(created.status, 200, createdRaw);
    assertPrivatePayload(createdRaw);
    const createdBody = JSON.parse(createdRaw);
    assert.deepEqual(Object.keys(createdBody.data).sort(), expectedKeys);
    assert.equal(createdBody.data.idempotent_replay, false);
    assert.equal(createdBody.data.status, 'active');
    assert.equal(createdBody.data.source_translation, false);
    assert.match(createdBody.data.target_text_sha256, /^[a-f0-9]{64}$/);
    assert.match(createdBody.data.approval_evidence_sha256, /^[a-f0-9]{64}$/);

    const replay = await postCreate(baseUrl, fixture);
    const replayRaw = await replay.text();
    assert.equal(replay.status, 200, replayRaw);
    assertPrivatePayload(replayRaw);
    const replayBody = JSON.parse(replayRaw);
    assert.deepEqual(Object.keys(replayBody.data).sort(), expectedKeys);
    assert.equal(replayBody.data.approval_id, createdBody.data.approval_id);
    assert.equal(replayBody.data.idempotent_replay, true);

    const idempotencyConflict = await postCreate(baseUrl, fixture, createBody({
      target_text: 'A different private line.',
    }));
    assert.equal(idempotencyConflict.status, 409);
    assert.equal((await idempotencyConflict.json()).error.code,
      'REDRAW_SUPPLEMENTAL_DIALOGUE_IDEMPOTENCY_CONFLICT');

    const activeConflict = await postCreate(baseUrl, fixture, createBody({
      idempotency_key: 'another-active-approval',
    }));
    assert.equal(activeConflict.status, 409);
    assert.equal((await activeConflict.json()).error.code,
      'REDRAW_SUPPLEMENTAL_DIALOGUE_ACTIVE_CONFLICT');
  });
  const stored = fixture.db.prepare(
    'SELECT target_text, source_translation, status FROM redraw_supplemental_dialogue_approvals',
  ).get();
  assert.deepEqual(stored, { target_text: APPROVED_TEXT, source_translation: 0, status: 'active' });
});

test('create maps stale CAS and not-ready state without invoking unsafe error projection', async (t) => {
  const fixture = routeFixture(t);
  await withServer(fixture.router, async (baseUrl) => {
    const stale = await postCreate(baseUrl, fixture, createBody({
      expected_voice_updated_at: '2026-08-27T00:00:00.000Z',
    }));
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, 'REDRAW_SUPPLEMENTAL_DIALOGUE_CAS_CONFLICT');

    fixture.db.prepare("UPDATE async_tasks SET result = json_set(result, '$.localization_decision.action', 'hold')")
      .run();
    const notReady = await postCreate(baseUrl, fixture, createBody({ idempotency_key: 'not-ready' }));
    const raw = await notReady.text();
    assert.equal(notReady.status, 422, raw);
    assert.equal(JSON.parse(raw).error.code, 'REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY');
    assertPrivatePayload(raw);
  });
});

test('revoke accepts exact two keys, supports replay, and returns the exact revoked projection', async (t) => {
  const fixture = routeFixture(t);
  const expectedKeys = [
    'approval_evidence_sha256', 'approval_id', 'contract_version', 'idempotent_replay',
    'revoked_at', 'status', 'target_text_sha256', 'updated_at', 'version_id',
  ];
  await withServer(fixture.router, async (baseUrl) => {
    const created = await (await postCreate(baseUrl, fixture)).json();
    const revokeBody = {
      idempotency_key: 'revoke-rafael-shot-6',
      expected_updated_at: created.data.updated_at,
    };
    const revoked = await postRevoke(baseUrl, fixture, created.data.approval_id, revokeBody);
    const revokedRaw = await revoked.text();
    assert.equal(revoked.status, 200, revokedRaw);
    assertPrivatePayload(revokedRaw);
    const revokedBody = JSON.parse(revokedRaw);
    assert.deepEqual(Object.keys(revokedBody.data).sort(), expectedKeys);
    assert.equal(revokedBody.data.status, 'revoked');
    assert.equal(revokedBody.data.idempotent_replay, false);

    const replay = await postRevoke(baseUrl, fixture, created.data.approval_id, revokeBody);
    const replayRaw = await replay.text();
    assert.equal(replay.status, 200, replayRaw);
    assertPrivatePayload(replayRaw);
    const replayBody = JSON.parse(replayRaw);
    assert.deepEqual(Object.keys(replayBody.data).sort(), expectedKeys);
    assert.equal(replayBody.data.idempotent_replay, true);

    const secondRevoke = await postRevoke(baseUrl, fixture, created.data.approval_id, {
      ...revokeBody, idempotency_key: 'different-revoke-key',
    });
    assert.equal(secondRevoke.status, 409);
    assert.equal((await secondRevoke.json()).error.code,
      'REDRAW_SUPPLEMENTAL_DIALOGUE_IDEMPOTENCY_CONFLICT');
  });
});

test('revoke hides foreign approvals and rejects invalid body or stale CAS', async (t) => {
  const fixture = routeFixture(t);
  const foreignUser = userAuthService.register(fixture.db, {
    email: `supplemental-foreign-${crypto.randomUUID()}@example.test`,
    password: 'supplemental-dialogue-route-password-123',
  });
  const foreignOwner = { tenantId: `personal:${foreignUser.id}`, userId: String(foreignUser.id) };
  const foreign = insertApprovalScope(fixture.db, foreignOwner, `foreign-${foreignUser.id}`);
  const foreignCreated = approvalService.createSupplementalDialogueApproval({
    db: fixture.db,
    tenantId: foreignOwner.tenantId,
    userId: foreignOwner.userId,
    versionId: foreign.versionId,
    shotRowId: foreign.shotRowId,
    voiceAssetId: foreign.voiceAssetId,
    idempotencyKey: 'foreign-approval',
    targetText: APPROVED_TEXT,
    sourceTranslation: false,
    expectedShotUpdatedAt: NOW,
    expectedVoiceUpdatedAt: NOW,
    now: () => NOW,
  });
  await withServer(fixture.router, async (baseUrl) => {
    const unauthorized = await postRevoke(baseUrl, fixture, foreignCreated.approval.id, {
      idempotency_key: 'foreign-revoke', expected_updated_at: NOW,
    }, { auth: false, versionId: foreign.versionId });
    assert.equal(unauthorized.status, 401);

    const hidden = await postRevoke(baseUrl, fixture, foreignCreated.approval.id, {
      idempotency_key: 'foreign-revoke', expected_updated_at: NOW,
    }, { versionId: foreign.versionId });
    assert.equal(hidden.status, 404);
    assert.equal((await hidden.json()).error.code, 'REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_FOUND');

    const created = await (await postCreate(baseUrl, fixture)).json();
    const invalid = await postRevoke(baseUrl, fixture, created.data.approval_id, {
      idempotency_key: 'invalid-revoke', expected_updated_at: NOW, target_text: APPROVED_TEXT,
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'REDRAW_SUPPLEMENTAL_DIALOGUE_INPUT_INVALID');

    const stale = await postRevoke(baseUrl, fixture, created.data.approval_id, {
      idempotency_key: 'stale-revoke', expected_updated_at: '2026-08-27T00:00:00.000Z',
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, 'REDRAW_SUPPLEMENTAL_DIALOGUE_CAS_CONFLICT');
  });
});

test('unknown service failures expose and log only stable context', async (t) => {
  const service = {
    ...approvalService,
    createSupplementalDialogueApproval() {
      throw Object.assign(
        new Error(`C:\\private\\voice.wav ${APPROVED_TEXT} Authorization: Bearer secret SELECT *`),
        { code: 'RAW_EVIDENCE_PRIVATE' },
      );
    },
  };
  const fixture = routeFixture(t, { service });
  await withServer(fixture.router, async (baseUrl) => {
    const result = await postCreate(baseUrl, fixture);
    const raw = await result.text();
    assert.equal(result.status, 500, raw);
    assert.equal(JSON.parse(raw).error.code, 'INTERNAL_ERROR');
    assertPrivatePayload(raw);
  });
  assertPrivatePayload(JSON.stringify(fixture.logEntries));
});
