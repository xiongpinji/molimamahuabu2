'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');

const { setupRouter } = require('../src/routes');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiConfigService = require('../src/services/aiConfigService');
const creditLedgerService = require('../src/services/creditLedgerService');
const generationCostLedgerService = require('../src/services/generationCostLedgerService');
const providerRouteStabilityService = require('../src/services/providerRouteStabilityService');
const providerTaskReconciliation = require('../src/services/providerTaskReconciliationService');
const userAuth = require('../src/services/userAuthService');
const { PERMISSIONS, ROLE_PERMISSIONS } = require('../src/middleware/platformRbac');

const JWT_SECRET = 'provider-task-admin-jwt-secret-123456789';
const ADMIN_TOKEN = 'provider-task-admin-token-123456789012';
const NOW = '2026-08-22T00:00:00.000Z';
const REQUEST_ID = 'fixture-route-1';
const VIDEO_ID = 7001;
const TASK_ID = 'fixture-task-1';
const PROVIDER_TASK_ID = 'provider-task-secret-123';
const STORAGE_DIR = 'provider-task-admin-route-storage';

function recordingLog() {
  const entries = [];
  return {
    entries,
    info(message, details) { entries.push({ level: 'info', message, details }); },
    warn(message, details) { entries.push({ level: 'warn', message, details }); },
    error(message, details) { entries.push({ level: 'error', message, details }); },
  };
}

function insertUser(db, id, platformRole) {
  db.prepare(`INSERT INTO platform_users
    (id, email, password_hash, password_salt, role, platform_role, status)
    VALUES (?, ?, 'hash', 'salt', ?, ?, 'active')`)
    .run(id, `${id}@example.com`, platformRole === 'admin' ? 'admin' : 'user', platformRole);
}

function tokenFor(db, id, role) {
  return userAuth.issueToken(
    { id, email: `${id}@example.com`, role },
    JWT_SECRET,
    userAuth.getTokenVersion(db, id),
  );
}

function insertProviderTaskFixture(db, log, options = {}) {
  db.prepare(`INSERT INTO dramas
    (id, title, style, status, metadata, created_at, updated_at)
    VALUES (1, '对账剧', 'realistic', 'draft', NULL, ?, ?)`)
    .run(NOW, NOW);
  db.prepare(`INSERT INTO episodes
    (id, drama_id, episode_number, title, created_at, updated_at)
    VALUES (1, 1, 1, '第一集', ?, ?)`)
    .run(NOW, NOW);
  db.prepare(`INSERT INTO storyboards
    (id, episode_id, storyboard_number, title, created_at, updated_at)
    VALUES (1, 1, 1, '第一镜', ?, ?)`)
    .run(NOW, NOW);

  const createdConfig = aiConfigService.createConfig(db, log, {
    service_type: 'video',
    provider: 'toapis',
    api_protocol: 'toapis_video',
    name: '管理端对账测试线路',
    base_url: 'https://private-provider.example/v1',
    api_key: 'provider-api-key-never-return',
    model: ['seedance-2-fast'],
    default_model: 'seedance-2-fast',
    logical_model_id: 'logical-video',
    settings: { canvas_capabilities: { durations: [5], resolutions: ['480p'] } },
  });
  const config = aiConfigService.getConfig(db, createdConfig.id);

  db.prepare(`INSERT INTO async_tasks
    (id, type, status, progress, message, resource_id, user_id, model, provider_task_id,
     created_at, updated_at)
    VALUES (?, 'video_generation', 'needs_attention', 90, '等待人工对账', ?,
      'fixture-owner', 'logical-video', ?, ?, ?)`)
    .run(TASK_ID, String(VIDEO_ID), PROVIDER_TASK_ID, NOW, NOW);
  db.prepare(`INSERT INTO video_generations
    (id, drama_id, storyboard_id, provider, prompt, model, duration, aspect_ratio, resolution,
     status, task_id, provider_task_id, config_id, user_id, created_at, updated_at)
    VALUES (?, 1, 1, 'toapis', 'private fixture prompt', 'seedance-2-fast', 5, '16:9', '480p',
      'needs_attention', ?, ?, ?, 'fixture-owner', ?, ?)`)
    .run(VIDEO_ID, TASK_ID, PROVIDER_TASK_ID, config.id, NOW, NOW);

  creditLedgerService.setAccountBalance(db, 'fixture-owner', 100);
  const reservation = creditLedgerService.reserve(db, {
    operationKey: 'provider-task-admin-fixture',
    userId: 'fixture-owner',
    model: 'logical-video',
    resourceType: 'video',
    resourceId: String(VIDEO_ID),
    amount: 5,
  });
  db.prepare('UPDATE video_generations SET credit_reservation_id = ? WHERE id = ?')
    .run(reservation.id, VIDEO_ID);
  db.prepare('UPDATE async_tasks SET credit_reservation_id = ? WHERE id = ?')
    .run(reservation.id, TASK_ID);

  db.prepare(`INSERT INTO generation_route_requests
    (id, idempotency_key, service_type, business_type, business_id, user_id,
     logical_model_id, capability_fingerprint, candidate_config_ids, state,
     credit_reservation_id, final_config_id, created_at, updated_at)
    VALUES (?, 'provider-task-admin-fixture', 'video', 'video_generation', ?, 'fixture-owner',
      'logical-video', ?, ?, 'needs_attention', ?, ?, ?, ?)`)
    .run(
      REQUEST_ID,
      String(VIDEO_ID),
      'b'.repeat(64),
      JSON.stringify([config.id]),
      reservation.id,
      config.id,
      NOW,
      NOW,
    );
  const receipt = providerRouteStabilityService.buildAttemptReceipt(db, {
    configId: config.id,
    serviceType: 'video',
    upstreamModel: 'seedance-2-fast',
    queryProtocol: 'toapis_video',
  });
  db.prepare(`INSERT INTO generation_route_attempts
    (request_id, attempt_no, config_id, provider, upstream_model, state,
     config_fingerprint, query_protocol, started_at, finished_at)
    VALUES (?, 1, ?, 'toapis', 'seedance-2-fast', 'needs_attention', ?, 'toapis_video', ?, ?)`)
    .run(
      REQUEST_ID,
      config.id,
      options.configFingerprint === undefined ? receipt.configFingerprint : options.configFingerprint,
      NOW,
      NOW,
    );
  if (options.bindProviderTask !== false) {
    db.prepare(`UPDATE generation_route_attempts SET provider_task_id = ?
      WHERE request_id = ? AND attempt_no = 1`)
      .run(PROVIDER_TASK_ID, REQUEST_ID);
  }
  return { config, reservation };
}

async function request(baseUrl, endpoint, { method = 'POST', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function setupAdminRouteFixture(t, options = {}) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  generationCostLedgerService.ensureSchema(db);
  const log = recordingLog();
  insertUser(db, 'fixture-owner', 'user');
  insertUser(db, 'plain-user', 'user');
  insertUser(db, 'billingless-operator', 'ops');
  insertUser(db, 'stability-admin', 'admin');
  const fixture = insertProviderTaskFixture(db, log, options);
  const previous = {
    PUBLIC_PLATFORM_MODE: process.env.PUBLIC_PLATFORM_MODE,
    PLATFORM_JWT_SECRET: process.env.PLATFORM_JWT_SECRET,
    PLATFORM_ADMIN_TOKEN: process.env.PLATFORM_ADMIN_TOKEN,
  };
  process.env.PUBLIC_PLATFORM_MODE = 'true';
  process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
  process.env.PLATFORM_ADMIN_TOKEN = ADMIN_TOKEN;

  const queryStats = { count: 0 };
  const queryTaskStatusOnce = async (...args) => {
    queryStats.count += 1;
    if (options.queryTaskStatusOnce) return options.queryTaskStatusOnce(...args);
    return { state: 'processing' };
  };
  const providerTaskOptions = {
    now: options.reconcileNow || NOW,
    queryTaskStatusOnce,
    ...(options.providerTaskReconciliation || {}),
  };
  const storagePath = path.resolve(process.cwd(), STORAGE_DIR);
  const app = express();
  app.use(express.json());
  app.use('/api/v1', setupRouter(
    { storage: { local_path: STORAGE_DIR } },
    db,
    log,
    { providerTaskReconciliation: providerTaskOptions },
  ));
  app.use((_req, res) => res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: '测试路由不存在' },
  }));
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return {
    db,
    log,
    ...fixture,
    queryStats,
    storagePath,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    endpoint: `/api/v1/admin/provider-stability/requests/${REQUEST_ID}/reconcile`,
    userToken: tokenFor(db, 'plain-user', 'user'),
    billinglessAdminToken: tokenFor(db, 'billingless-operator', 'ops'),
    adminToken: tokenFor(db, 'stability-admin', 'admin'),
  };
}

function assertSafeData(data) {
  assert.deepEqual(Object.keys(data).sort(), [
    'checked_at',
    'credit_state',
    'error_category',
    'reconcilable',
    'reconciled',
    'request_id',
    'task_state',
  ]);
  assert.doesNotMatch(
    JSON.stringify(data),
    /provider[_-]?task|config_fingerprint|api[_-]?key|authorization|https?:\/\/|raw[_ -]?response|claim[_ -]?token|lease|reservation[_ -]?scope|private-provider/i,
  );
}

test('provider task reconcile route is registered with both admin and billing middleware', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/index.js'), 'utf8');
  const route = source.split(/\r?\n/).find((line) => (
    line.includes("r.post('/admin/provider-stability/requests/:requestId/reconcile'")
  ));
  assert.ok(route, 'provider task reconcile route missing');
  assert.match(route, /requireAdmin/);
  assert.match(route, /requireBillingManager/);
  assert.equal(ROLE_PERMISSIONS.admin.includes(PERMISSIONS.BILLING_MANAGE), true);
  assert.equal(ROLE_PERMISSIONS.ops.includes(PERMISSIONS.BILLING_MANAGE), false);
});

test('provider task reconcile route requires admin billing permission and empty body', async (t) => {
  const state = await setupAdminRouteFixture(t);
  assert.equal((await request(state.baseUrl, state.endpoint)).status, 401);
  assert.equal((await request(state.baseUrl, state.endpoint, { token: state.userToken })).status, 403);
  assert.equal((await request(state.baseUrl, state.endpoint, {
    token: state.billinglessAdminToken,
  })).status, 403);

  const withoutBody = await request(state.baseUrl, state.endpoint, { token: state.adminToken });
  assert.equal(withoutBody.status, 200);
  assertSafeData(withoutBody.body.data);
  const emptyBody = await request(state.baseUrl, state.endpoint, {
    token: state.adminToken,
    body: {},
  });
  assert.equal(emptyBody.status, 200);
  assertSafeData(emptyBody.body.data);
  assert.equal(state.queryStats.count, 1);
});

test('provider task reconcile route rejects every client-controlled field before reconciliation', async (t) => {
  const state = await setupAdminRouteFixture(t);
  let reconciliationCount = 0;
  const original = providerTaskReconciliation.reconcileRequest;
  providerTaskReconciliation.reconcileRequest = async (...args) => {
    reconciliationCount += 1;
    return original(...args);
  };
  t.after(() => { providerTaskReconciliation.reconcileRequest = original; });

  const arrayBody = await request(state.baseUrl, state.endpoint, {
    token: state.adminToken,
    body: [],
  });
  assert.equal(arrayBody.status, 400, 'array body');
  for (const field of [
    'provider_task_id', 'config', 'provider', 'upstream', 'status', 'task', 'unexpected',
  ]) {
    const result = await request(state.baseUrl, state.endpoint, {
      token: state.adminToken,
      body: { [field]: 'forbidden' },
    });
    assert.equal(result.status, 400, field);
    assert.equal(result.body.error.message, '普通任务对账不接受客户端状态、任务号或配置字段');
  }
  assert.equal(reconciliationCount, 0);
  assert.equal(state.queryStats.count, 0);
  assert.deepEqual(dbClaimState(state.db), {
    reconcile_claim_token: null,
    reconcile_lease_until: null,
    reconcile_checked_at: null,
  });
});

function dbClaimState(db) {
  return db.prepare(`SELECT reconcile_claim_token, reconcile_lease_until, reconcile_checked_at
    FROM generation_route_attempts WHERE request_id = ?`).get(REQUEST_ID);
}

test('provider task reconcile route maps invalid, missing, and incomplete evidence safely', async (t) => {
  const state = await setupAdminRouteFixture(t, { configFingerprint: null });
  const invalid = await request(
    state.baseUrl,
    '/api/v1/admin/provider-stability/requests/bad%20id/reconcile',
    { token: state.adminToken },
  );
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.message, '普通生成请求 ID 无效');

  const missing = await request(
    state.baseUrl,
    '/api/v1/admin/provider-stability/requests/missing-route/reconcile',
    { token: state.adminToken },
  );
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.message, '普通生成请求不存在');

  const incomplete = await request(state.baseUrl, state.endpoint, { token: state.adminToken });
  assert.equal(incomplete.status, 409);
  assert.equal(incomplete.body.error.code, 'PROVIDER_TASK_NOT_RECONCILABLE');
  assert.equal(incomplete.body.error.message, '该普通生成请求当前不可对账');
  assert.equal(state.queryStats.count, 0);
});

test('provider task reconcile route returns generic 500 and logs no upstream secrets', async (t) => {
  const state = await setupAdminRouteFixture(t);
  const original = providerTaskReconciliation.reconcileRequest;
  const injected = new Error(
    `query ${PROVIDER_TASK_ID} https://private-provider.example/v1 Authorization Bearer provider-api-key-never-return`,
  );
  injected.code = 'UPSTREAM_QUERY_FAILED';
  providerTaskReconciliation.reconcileRequest = async () => { throw injected; };
  t.after(() => { providerTaskReconciliation.reconcileRequest = original; });

  const result = await request(state.baseUrl, state.endpoint, { token: state.adminToken });
  assert.equal(result.status, 500);
  assert.equal(result.body.error.code, 'INTERNAL_ERROR');
  assert.equal(result.body.error.message, '普通生成任务对账失败');
  const serialized = JSON.stringify({ response: result.body, logs: state.log.entries });
  assert.doesNotMatch(
    serialized,
    /provider-task-secret-123|private-provider\.example|provider-api-key-never-return|Authorization|Bearer/i,
  );
});

test('provider task reconcile route forwards only server-owned reconciliation options', async (t) => {
  const state = await setupAdminRouteFixture(t, {
    providerTaskReconciliation: { internalMarker: 'fixture-internal-option' },
  });
  const original = providerTaskReconciliation.reconcileRequest;
  let captured = null;
  providerTaskReconciliation.reconcileRequest = async (...args) => {
    captured = args;
    return {
      request_id: REQUEST_ID,
      task_state: 'needs_attention',
      error_category: 'result_unknown',
      reconciled: false,
      reconcilable: true,
      credit_state: 'held',
      checked_at: null,
    };
  };
  t.after(() => { providerTaskReconciliation.reconcileRequest = original; });

  const result = await request(state.baseUrl, state.endpoint, {
    token: state.adminToken,
    body: {},
  });
  assert.equal(result.status, 200);
  assert.equal(captured[0], state.db);
  assert.equal(captured[1], state.log);
  assert.equal(captured[2], REQUEST_ID);
  assert.equal(captured[3].actorId, 'stability-admin');
  assert.equal(captured[3].storagePath, state.storagePath);
  assert.equal(captured[3].internalMarker, 'fixture-internal-option');
  assertSafeData(result.body.data);
});

test('provider task reconcile route returns Task4 safe DTO for processing results', async (t) => {
  const state = await setupAdminRouteFixture(t);
  const result = await request(state.baseUrl, state.endpoint, { token: state.adminToken });
  assert.equal(result.status, 200);
  assertSafeData(result.body.data);
  assert.equal(result.body.data.task_state, 'needs_attention');
  assert.equal(result.body.data.credit_state, 'held');
  assert.equal(result.body.data.reconciled, false);
  assert.equal(state.queryStats.count, 1);
});

test('provider task reconcile route returns Task4 safe DTO while lease is live', async (t) => {
  const state = await setupAdminRouteFixture(t);
  state.db.prepare(`UPDATE generation_route_attempts
    SET reconcile_claim_token = 'live-claim', reconcile_lease_until = ?
    WHERE request_id = ?`)
    .run(new Date(Date.parse(NOW) + 120_000).toISOString(), REQUEST_ID);
  const result = await request(state.baseUrl, state.endpoint, { token: state.adminToken });
  assert.equal(result.status, 200);
  assertSafeData(result.body.data);
  assert.equal(result.body.data.reconcilable, false);
  assert.equal(state.queryStats.count, 0);
});

test('provider task reconcile route returns Task4 safe DTO during debounce', async (t) => {
  const state = await setupAdminRouteFixture(t, {
    reconcileNow: new Date(Date.parse(NOW) + 30_000).toISOString(),
  });
  state.db.prepare(`UPDATE generation_route_attempts SET reconcile_checked_at = ?
    WHERE request_id = ?`).run(NOW, REQUEST_ID);
  const result = await request(state.baseUrl, state.endpoint, { token: state.adminToken });
  assert.equal(result.status, 200);
  assertSafeData(result.body.data);
  assert.equal(result.body.data.reconcilable, false);
  assert.equal(result.body.data.checked_at, NOW);
  assert.equal(state.queryStats.count, 0);
});

test('provider task reconcile route returns identical safe DTO for repeated terminal requests', async (t) => {
  const state = await setupAdminRouteFixture(t);
  state.db.transaction(() => {
    state.db.prepare(`UPDATE generation_route_requests SET state = 'succeeded', updated_at = ?
      WHERE id = ?`).run(NOW, REQUEST_ID);
    state.db.prepare(`UPDATE generation_route_attempts SET state = 'succeeded',
      reconcile_checked_at = ?, finished_at = ? WHERE request_id = ?`).run(NOW, NOW, REQUEST_ID);
    state.db.prepare(`UPDATE video_generations SET status = 'completed', updated_at = ?
      WHERE id = ?`).run(NOW, VIDEO_ID);
    state.db.prepare(`UPDATE async_tasks SET status = 'completed', progress = 100, updated_at = ?
      WHERE id = ?`).run(NOW, TASK_ID);
    state.db.prepare(`UPDATE usage_reservations SET status = 'confirmed', updated_at = ?
      WHERE id = ?`).run(NOW, state.reservation.id);
  }).immediate();

  const first = await request(state.baseUrl, state.endpoint, { token: state.adminToken });
  const second = await request(state.baseUrl, state.endpoint, { token: state.adminToken, body: {} });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assertSafeData(first.body.data);
  assert.deepEqual(first.body.data, second.body.data);
  assert.equal(first.body.data.reconciled, true);
  assert.equal(first.body.data.reconcilable, false);
  assert.equal(first.body.data.credit_state, 'confirmed');
  assert.equal(state.queryStats.count, 0);
});
