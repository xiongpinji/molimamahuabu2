'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');

const { setupRouter } = require('../src/routes');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const userAuth = require('../src/services/userAuthService');
const stability = require('../src/services/providerRouteStabilityService');
const evidenceService = require('../src/services/providerCanaryEvidenceService');

const JWT_SECRET = 'provider-canary-admin-jwt-secret-123456789';
const ADMIN_TOKEN = 'provider-canary-admin-token-123456789012';
const NOW = '2026-08-19T02:00:00.000Z';
const SHANGHAI_NOW = new Date(Date.now() + (8 * 60 * 60 * 1000)).toISOString();
const CURRENT_BUDGET_DAY = SHANGHAI_NOW.slice(0, 10);
const CURRENT_BUDGET_MONTH = CURRENT_BUDGET_DAY.slice(0, 7);

function plusMilliseconds(value, amount) {
  return new Date(new Date(value).getTime() + amount).toISOString();
}

function insertUser(db, id, role) {
  db.prepare(`INSERT INTO platform_users
    (id, email, password_hash, password_salt, role, platform_role, status)
    VALUES (?, ?, 'hash', 'salt', ?, ?, 'active')`)
    .run(id, `${id}@example.com`, role === 'admin' ? 'admin' : 'user', role);
}

function tokenFor(db, id, role) {
  return userAuth.issueToken(
    { id, email: `${id}@example.com`, role },
    JWT_SECRET,
    userAuth.getTokenVersion(db, id),
  );
}

function insertCanaryFixture(db) {
  const configId = Number(db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, name, base_url, api_key, model, default_model,
     api_protocol, query_endpoint, priority, is_active, logical_model_id,
     failover_enabled, verification_status, created_at, updated_at)
    VALUES ('video', 'secret-provider', '供应商绝密线路',
      'https://user:password@secret-provider.example:9443/v1?token=hidden',
      'canary-key-never-return', '["upstream-secret-model"]', 'upstream-secret-model',
      'toapis_video', '/secret/tasks/{taskId}', 50, 1, 'logical-video', 1,
      'verified', ?, ?)`)
    .run(NOW, NOW).lastInsertRowid);
  const capability = evidenceService.normalizeCapability('video', {
    resolution: '720p',
    aspectRatio: '16:9',
    duration: 15,
    referenceImageCount: 2,
    referenceVideoCount: 1,
    referenceAudioCount: 1,
    requiresAudio: true,
    count: 1,
  });
  const capabilityJson = JSON.stringify(capability);
  const capabilityFingerprint = evidenceService.capabilityFingerprint('video', capability);
  db.prepare(`INSERT INTO provider_canary_runs
    (id, idempotency_key, config_id, logical_model_id, service_type,
     capability_fingerprint, config_fingerprint, cost_fingerprint,
     runtime_fingerprint, provider_scope_key, state, reserved_cost_micros,
     currency, budget_day, budget_month, provider_task_id, error_category,
     safe_error_summary, created_at, submitted_at, finished_at, updated_at)
    VALUES ('run-unknown', 'idem-unknown', ?, 'logical-video', 'video', ?,
      'cfg-secret-hash', 'cost-secret-hash', 'runtime-secret-hash',
      'scope-secret-hash', 'result_unknown', 500000, 'CNY', ?, ?,
      'provider-task-secret-123', 'result_unknown',
      'raw prompt https://signed.example/result?token=hidden Authorization Bearer secret',
      ?, ?, ?, ?)`)
    .run(
      configId,
      capabilityFingerprint,
      CURRENT_BUDGET_DAY,
      CURRENT_BUDGET_MONTH,
      NOW,
      NOW,
      NOW,
      NOW,
    );
  db.prepare(`INSERT INTO provider_canary_evidence
    (config_id, service_type, capability_fingerprint, capability_json, state,
     run_id, config_fingerprint, cost_fingerprint, runtime_fingerprint,
     invalidated_at, invalidation_reason, created_at, updated_at)
    VALUES (?, 'video', ?, ?, 'submission_unknown', 'run-unknown',
      'cfg-secret-hash', 'cost-secret-hash', 'runtime-secret-hash', ?,
      'result_unknown', ?, ?)`)
    .run(configId, capabilityFingerprint, capabilityJson, NOW, NOW, NOW);
  db.prepare(`INSERT INTO provider_zero_cost_checks
    (config_id, state, category, safe_summary, checked_at, updated_at)
    VALUES (?, 'degraded', 'provider_read_only_failed',
      'category=provider_read_only_failed', ?, ?)`)
    .run(configId, NOW, NOW);
  return { configId, capability, capabilityFingerprint };
}

function cloneCanaryRun(db, id, state, updatedAt, logicalModelId = 'logical-video') {
  db.prepare(`INSERT INTO provider_canary_runs
    (id, idempotency_key, config_id, logical_model_id, service_type,
     capability_fingerprint, config_fingerprint, cost_fingerprint,
     runtime_fingerprint, provider_scope_key, state, reserved_cost_micros,
     actual_cost_micros, currency, budget_day, budget_month, provider_task_id,
     error_category, safe_error_summary, created_at, submitted_at, finished_at, updated_at)
    SELECT ?, ?, config_id, ?, service_type, capability_fingerprint,
      config_fingerprint, cost_fingerprint, runtime_fingerprint, provider_scope_key,
      ?, reserved_cost_micros, actual_cost_micros, currency, budget_day, budget_month,
      provider_task_id, error_category, safe_error_summary, ?, submitted_at, finished_at, ?
    FROM provider_canary_runs WHERE id = 'run-unknown'`)
    .run(id, `idem-${id}`, logicalModelId, state, updatedAt, updatedAt);
}

function reconciliationSnapshot(db) {
  return {
    run: db.prepare(`SELECT state, actual_cost_micros, artifact_path, error_category,
      reconcile_claim_token, reconcile_lease_until, reconcile_checked_at, updated_at
      FROM provider_canary_runs WHERE id = 'run-unknown'`).get(),
    evidence: db.prepare(`SELECT state, verified_at, expires_at, updated_at
      FROM provider_canary_evidence WHERE run_id = 'run-unknown'`).get(),
    eventCount: db.prepare('SELECT COUNT(*) AS count FROM provider_stability_events').get().count,
    auditCount: db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count,
  };
}

async function request(baseUrl, endpoint, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const result = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await result.text();
  return { status: result.status, body: text ? JSON.parse(text) : null };
}

async function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  insertUser(db, 'plain-user', 'user');
  insertUser(db, 'stability-admin', 'admin');
  const fixture = insertCanaryFixture(db);
  const previous = {
    PUBLIC_PLATFORM_MODE: process.env.PUBLIC_PLATFORM_MODE,
    PLATFORM_JWT_SECRET: process.env.PLATFORM_JWT_SECRET,
    PLATFORM_ADMIN_TOKEN: process.env.PLATFORM_ADMIN_TOKEN,
    PROVIDER_CANARY_MODE: process.env.PROVIDER_CANARY_MODE,
  };
  process.env.PUBLIC_PLATFORM_MODE = 'true';
  process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
  process.env.PLATFORM_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.PROVIDER_CANARY_MODE = 'shadow';
  const app = express();
  app.use(express.json());
  app.use('/api/v1', setupRouter({}, db, { info() {}, warn() {}, error() {} }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return {
    db,
    ...fixture,
    baseUrl: `http://127.0.0.1:${server.address().port}/api/v1`,
    plainToken: tokenFor(db, 'plain-user', 'user'),
    adminToken: tokenFor(db, 'stability-admin', 'admin'),
    async close() {
      await new Promise((resolve) => server.close(resolve));
      db.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

test('巡检 summary 与 runs 强制管理员 RBAC', async (t) => {
  const context = await setup();
  t.after(() => context.close());
  for (const endpoint of [
    '/admin/provider-stability/canary/summary',
    '/admin/provider-stability/canary/runs',
  ]) {
    assert.equal((await request(context.baseUrl, endpoint)).status, 401);
    assert.equal((await request(context.baseUrl, endpoint, { token: context.plainToken })).status, 403);
    assert.equal((await request(context.baseUrl, endpoint, { token: context.adminToken })).status, 200);
  }
});

test('summary 返回巡检状态和预算未知占用且不泄漏供应商身份与密钥', async (t) => {
  const context = await setup();
  t.after(() => context.close());
  const result = await request(
    context.baseUrl,
    '/admin/provider-stability/canary/summary',
    { token: context.adminToken },
  );
  assert.equal(result.status, 200);
  const budget = result.body.data.budget;
  for (const key of [
    'daily_limit_micros', 'monthly_limit_micros', 'daily_used_micros',
    'monthly_used_micros', 'daily_remaining_micros', 'monthly_remaining_micros',
    'daily_unknown_micros', 'monthly_unknown_micros',
  ]) assert.equal(Number.isSafeInteger(budget[key]), true, key);
  assert.equal(budget.daily_unknown_micros, 500000);
  assert.equal(budget.monthly_unknown_micros, 500000);
  const route = result.body.data.routes[0];
  for (const key of [
    'canary_paused', 'public_state', 'would_be_hidden', 'latest_zero_cost_check',
    'latest_real_success_at', 'evidence_expires_at', 'evidence_state',
    'budget_block_reason',
  ]) assert.equal(Object.hasOwn(route, key), true, key);
  assert.equal(route.latest_zero_cost_check.category, 'provider_read_only_failed');
  const serialized = JSON.stringify(result.body);
  for (const secret of [
    'secret-provider', '供应商绝密线路', 'canary-key-never-return', 'password',
    'secret-provider.example', 'provider-task-secret-123', 'signed.example',
    'upstream-secret-model',
  ]) assert.equal(serialized.includes(secret), false, secret);
});

test('runs 只返回安全运行字段、可对账标记与可消费分页结构', async (t) => {
  const context = await setup();
  t.after(() => context.close());
  const result = await request(
    context.baseUrl,
    '/admin/provider-stability/canary/runs',
    { token: context.adminToken },
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.data.items.length, 1);
  assert.deepEqual(result.body.data.pagination, {
    limit: 50,
    has_more: false,
    next_cursor: null,
  });
  const run = result.body.data.items[0];
  assert.equal(run.id, 'run-unknown');
  assert.equal(run.logical_model_id, 'logical-video');
  assert.match(run.route_name, /^线路-[a-f0-9]{8}$/);
  assert.deepEqual(run.capability, context.capability);
  assert.equal(run.state, 'result_unknown');
  assert.equal(run.error_category, 'result_unknown');
  assert.equal(run.reconcilable, true);
  assert.deepEqual(run.cost, {
    reserved_micros: 500000,
    actual_micros: null,
    currency: 'CNY',
  });
  assert.deepEqual(Object.keys(run).sort(), [
    'capability', 'cost', 'error_category', 'id', 'logical_model_id',
    'reconcilable', 'route_name', 'service_type', 'state', 'times',
  ]);
  const serialized = JSON.stringify(result.body);
  for (const secret of [
    'provider_task_id', 'provider-task-secret-123', 'safe_error_summary',
    'signed.example', 'secret-provider', 'config_id', 'artifact_path',
  ]) assert.equal(serialized.includes(secret), false, secret);
});

test('runs 使用快照和 updated_at/id 元组稳定分页，历史 unknown 均可到达', async (t) => {
  const context = await setup();
  t.after(() => context.close());
  cloneCanaryRun(context.db, 'run-b', 'submission_unknown', '2026-08-19T01:59:00.000Z');
  cloneCanaryRun(context.db, 'run-a', 'artifact_unreadable', '2026-08-19T01:59:00.000Z');
  cloneCanaryRun(context.db, 'run-old', 'result_unknown', '2026-08-19T01:58:00.000Z');

  const first = await request(
    context.baseUrl,
    '/admin/provider-stability/canary/runs?limit=2',
    { token: context.adminToken },
  );
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.data.items.map((run) => run.id), ['run-unknown', 'run-b']);
  assert.equal(first.body.data.pagination.has_more, true);
  assert.match(first.body.data.pagination.next_cursor, /^[A-Za-z0-9_-]{1,512}$/);

  cloneCanaryRun(context.db, 'run-after-snapshot', 'result_unknown', '2099-01-01T00:00:00.000Z');
  const second = await request(
    context.baseUrl,
    `/admin/provider-stability/canary/runs?limit=2&before=${encodeURIComponent(first.body.data.pagination.next_cursor)}`,
    { token: context.adminToken },
  );
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.data.items.map((run) => run.id), ['run-a', 'run-old']);
  assert.equal(second.body.data.pagination.has_more, false);
  assert.equal(second.body.data.pagination.next_cursor, null);
  assert.equal(JSON.stringify(second.body).includes('run-after-snapshot'), false);
});

test('runs 严格校验 limit、state、logical_model_id、before 和未知查询字段', async (t) => {
  const context = await setup();
  t.after(() => context.close());
  const invalidQueries = [
    'limit=0',
    'limit=201',
    'limit=1.5',
    'state=not-a-canary-state',
    `logical_model_id=${'a'.repeat(201)}`,
    'before=not_base64url!',
    'unexpected=1',
  ];
  for (const query of invalidQueries) {
    const result = await request(
      context.baseUrl,
      `/admin/provider-stability/canary/runs?${query}`,
      { token: context.adminToken },
    );
    assert.equal(result.status, 400, query);
  }
});

test('reconcile 拒绝客户端状态或产物字段且不触发查询', async (t) => {
  const context = await setup();
  t.after(() => context.close());
  let calls = 0;
  const original = stability.reconcileCanaryRun;
  stability.reconcileCanaryRun = async () => { calls += 1; return { state: 'succeeded' }; };
  t.after(() => { stability.reconcileCanaryRun = original; });
  const result = await request(
    context.baseUrl,
    '/admin/provider-stability/canary/runs/run-unknown/reconcile',
    {
      method: 'POST',
      token: context.adminToken,
      body: { state: 'succeeded', artifact_url: 'https://attacker.example/video.mp4' },
    },
  );
  assert.equal(result.status, 400);
  assert.equal(calls, 0);
});

test('reconcile 端点未登录 401、普通用户 403、管理员 200', async (t) => {
  const context = await setup();
  t.after(() => context.close());
  const original = stability.reconcileCanaryRun;
  stability.reconcileCanaryRun = async () => ({
    id: 'run-unknown',
    state: 'result_unknown',
    reconciled: false,
    error_category: 'result_unknown',
    reconcilable: true,
  });
  t.after(() => { stability.reconcileCanaryRun = original; });
  const endpoint = '/admin/provider-stability/canary/runs/run-unknown/reconcile';
  assert.equal((await request(context.baseUrl, endpoint, { method: 'POST' })).status, 401);
  assert.equal((await request(context.baseUrl, endpoint, {
    method: 'POST', token: context.plainToken,
  })).status, 403);
  assert.equal((await request(context.baseUrl, endpoint, {
    method: 'POST', token: context.adminToken,
  })).status, 200);
});

test('reconcile 对仍未知任务只查询一次、不重提并保持冻结占用', async () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  insertUser(db, 'stability-admin', 'admin');
  insertCanaryFixture(db);
  let queryCalls = 0;
  let submitCalls = 0;
  const result = await stability.reconcileCanaryRun(db, { info() {}, warn() {}, error() {} }, 'run-unknown', {
    actorId: 'stability-admin',
    now: NOW,
    async queryTaskOnce(input) {
      queryCalls += 1;
      assert.equal(input.taskId, 'provider-task-secret-123');
      assert.equal(Object.hasOwn(input, 'submit'), false);
      return { state: 'unknown' };
    },
    async submit() { submitCalls += 1; },
  });
  assert.equal(result.state, 'result_unknown');
  assert.equal(result.reconciled, false);
  assert.equal(queryCalls, 1);
  assert.equal(submitCalls, 0);
  const stored = db.prepare(`SELECT state, actual_cost_micros, provider_task_id
    FROM provider_canary_runs WHERE id = 'run-unknown'`).get();
  assert.deepEqual(stored, {
    state: 'result_unknown',
    actual_cost_micros: null,
    provider_task_id: 'provider-task-secret-123',
  });
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM audit_events
    WHERE event_type = 'provider.canary.reconciled' AND outcome = 'unknown'`).get().count, 1);
  db.close();
});

test('reconcile 只有明确成功且产物可读才原子恢复 fresh', async () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  insertUser(db, 'stability-admin', 'admin');
  insertCanaryFixture(db);
  let materializeCalls = 0;
  const result = await stability.reconcileCanaryRun(db, { info() {}, warn() {}, error() {} }, 'run-unknown', {
    actorId: 'stability-admin',
    now: NOW,
    storageRoot: 'unused-by-injected-materializer',
    async queryTaskOnce() {
      return { state: 'succeeded', artifactUrl: 'https://signed.example/video.mp4' };
    },
    async materializeVideo(url, options) {
      materializeCalls += 1;
      assert.equal(url, 'https://signed.example/video.mp4');
      assert.equal(options.runId, 'run-unknown');
      return {
        relative_path: '_system/provider-canary/runs/run-unknown/video.mp4',
        sha256: 'a'.repeat(64),
        bytes: 24,
      };
    },
  });
  assert.equal(result.state, 'succeeded');
  assert.equal(result.reconciled, true);
  assert.equal(materializeCalls, 1);
  assert.deepEqual(db.prepare(`SELECT state, actual_cost_micros, artifact_path,
    provider_task_id FROM provider_canary_runs WHERE id = 'run-unknown'`).get(), {
    state: 'succeeded',
    actual_cost_micros: 500000,
    artifact_path: '_system/provider-canary/runs/run-unknown/video.mp4',
    provider_task_id: 'provider-task-secret-123',
  });
  assert.equal(db.prepare(`SELECT state FROM provider_canary_evidence
    WHERE run_id = 'run-unknown'`).get().state, 'fresh');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM provider_stability_events
    WHERE event_type = 'provider_canary_reconciled_success'`).get().count, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM audit_events
    WHERE event_type = 'provider.canary.reconciled' AND outcome = 'success'`).get().count, 1);
  db.close();
});

test('reconcile 上游成功但产物不可读时保持未知占用且绝不写 fresh', async () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  insertUser(db, 'stability-admin', 'admin');
  insertCanaryFixture(db);
  const result = await stability.reconcileCanaryRun(db, { info() {}, warn() {}, error() {} }, 'run-unknown', {
    actorId: 'stability-admin',
    now: NOW,
    async queryTaskOnce() {
      return { state: 'succeeded', artifactUrl: 'https://signed.example/unreadable.mp4' };
    },
    async materializeVideo() { throw new Error('download interrupted with signed URL'); },
  });
  assert.equal(result.state, 'artifact_unreadable');
  assert.equal(result.reconciled, false);
  assert.deepEqual(db.prepare(`SELECT state, actual_cost_micros, artifact_path
    FROM provider_canary_runs WHERE id = 'run-unknown'`).get(), {
    state: 'artifact_unreadable',
    actual_cost_micros: null,
    artifact_path: null,
  });
  assert.equal(db.prepare(`SELECT state FROM provider_canary_evidence
    WHERE run_id = 'run-unknown'`).get().state, 'submission_unknown');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM audit_events
    WHERE event_type = 'provider.canary.reconciled' AND outcome = 'unknown'`).get().count, 1);
  db.close();
});

test('reconcile 明确失败原子结算失败并保持证据不可公开', async () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  insertUser(db, 'stability-admin', 'admin');
  insertCanaryFixture(db);
  const result = await stability.reconcileCanaryRun(db, { info() {}, warn() {}, error() {} }, 'run-unknown', {
    actorId: 'stability-admin',
    now: NOW,
    async queryTaskOnce() { return { state: 'failed', category: 'provider_rejected' }; },
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.reconciled, true);
  assert.deepEqual(db.prepare(`SELECT state, actual_cost_micros, error_category
    FROM provider_canary_runs WHERE id = 'run-unknown'`).get(), {
    state: 'failed',
    actual_cost_micros: 500000,
    error_category: 'provider_rejected',
  });
  assert.equal(db.prepare(`SELECT state FROM provider_canary_evidence
    WHERE run_id = 'run-unknown'`).get().state, 'failing');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM provider_stability_events
    WHERE event_type = 'provider_canary_reconciled_failure'`).get().count, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM audit_events
    WHERE event_type = 'provider.canary.reconciled' AND outcome = 'failed'`).get().count, 1);
  db.close();
});

test('巡检迁移提供持久对账 claim、lease 和去抖时间', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  runMigrationsAndEnsure(db);
  const columns = new Set(db.prepare('PRAGMA table_info(provider_canary_runs)').all()
    .map((column) => column.name));
  for (const column of [
    'reconcile_claim_token', 'reconcile_lease_until', 'reconcile_checked_at',
  ]) assert.equal(columns.has(column), true, column);
  const indexes = new Set(db.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'provider_canary_runs'`).all()
    .map((index) => index.name));
  for (const index of [
    'idx_provider_canary_runs_admin_page',
    'idx_provider_canary_runs_admin_state_page',
    'idx_provider_canary_runs_admin_model_page',
  ]) assert.equal(indexes.has(index), true, index);
  db.close();
});

test('reconcile 查询故障保持 unknown 并只写安全分类，不泄露原始错误', async () => {
  for (const category of [
    'validation_error',
    'auth_unavailable',
    'forbidden_unknown',
    'rate_limited',
    'provider_unavailable',
    'query_request_limit',
    'query_protocol_error',
  ]) {
    const db = new Database(':memory:');
    runMigrationsAndEnsure(db);
    insertUser(db, 'stability-admin', 'admin');
    insertCanaryFixture(db);
    const raw = 'Authorization Bearer secret https://provider.example/task?signature=hidden';
    const result = await stability.reconcileCanaryRun(db, null, 'run-unknown', {
      actorId: 'stability-admin',
      now: NOW,
      async queryTaskOnce() { return { state: 'query_failed', category, raw }; },
    });
    assert.equal(result.state, 'result_unknown', category);
    assert.equal(result.reconciled, false, category);
    assert.equal(result.error_category, category, category);
    const stored = db.prepare(`SELECT state, error_category, safe_error_summary
      FROM provider_canary_runs WHERE id = 'run-unknown'`).get();
    assert.deepEqual(stored, {
      state: 'result_unknown',
      error_category: category,
      safe_error_summary: `category=${category}`,
    });
    const event = db.prepare(`SELECT severity, safe_details FROM provider_stability_events
      WHERE event_type = 'provider_canary_reconcile_unknown'`).get();
    assert.equal(event.severity, 'warning');
    assert.equal(JSON.parse(event.safe_details).category, category);
    const auditRow = db.prepare(`SELECT code FROM audit_events
      WHERE event_type = 'provider.canary.reconciled'`).get();
    assert.match(auditRow.code, new RegExp(category));
    const serialized = JSON.stringify({ result, stored, event, auditRow });
    assert.equal(serialized.includes(raw), false);
    assert.equal(serialized.includes('provider.example'), false);
    db.close();
  }
});

test('reconcile 仅协议分类异常保持 unknown，显式任务失败仍是唯一 failed 入口', async () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  insertUser(db, 'stability-admin', 'admin');
  insertCanaryFixture(db);
  const error = new Error('raw provider parser detail must not leak');
  error.code = 'PROVIDER_QUERY_PROTOCOL_ERROR';
  const result = await stability.reconcileCanaryRun(db, null, 'run-unknown', {
    actorId: 'stability-admin',
    now: NOW,
    async queryTaskOnce() { throw error; },
  });
  assert.equal(result.state, 'result_unknown');
  assert.equal(result.error_category, 'query_protocol_error');
  assert.equal(JSON.stringify(result).includes('parser detail'), false);
  db.close();
});

test('reconcile 成功终态重复调用返回同一安全 DTO 且零副作用', async () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  insertUser(db, 'stability-admin', 'admin');
  insertCanaryFixture(db);
  db.prepare(`UPDATE provider_canary_runs SET state = 'succeeded',
    actual_cost_micros = reserved_cost_micros,
    artifact_path = '_system/provider-canary/runs/run-unknown/video.mp4',
    artifact_sha256 = ?, artifact_bytes = 24, error_category = NULL,
    safe_error_summary = NULL, finished_at = ?, updated_at = ?
    WHERE id = 'run-unknown'`).run('a'.repeat(64), NOW, NOW);
  const before = reconciliationSnapshot(db);
  let queryCalls = 0;
  const options = {
    actorId: 'stability-admin',
    now: plusMilliseconds(NOW, 10_000),
    async queryTaskOnce() { queryCalls += 1; throw new Error('must not query'); },
  };
  const first = await stability.reconcileCanaryRun(db, null, 'run-unknown', options);
  const second = await stability.reconcileCanaryRun(db, null, 'run-unknown', options);
  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    id: 'run-unknown', state: 'succeeded', reconciled: true,
    error_category: null, reconcilable: false,
  });
  assert.equal(queryCalls, 0);
  assert.deepEqual(reconciliationSnapshot(db), before);
  db.close();
});

test('reconcile 失败终态重复调用返回同一安全 DTO 且零副作用', async () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  insertUser(db, 'stability-admin', 'admin');
  insertCanaryFixture(db);
  db.prepare(`UPDATE provider_canary_runs SET state = 'failed',
    actual_cost_micros = reserved_cost_micros, error_category = 'provider_rejected',
    safe_error_summary = 'category=provider_rejected', finished_at = ?, updated_at = ?
    WHERE id = 'run-unknown'`).run(NOW, NOW);
  const before = reconciliationSnapshot(db);
  let queryCalls = 0;
  const options = {
    actorId: 'stability-admin',
    now: plusMilliseconds(NOW, 10_000),
    async queryTaskOnce() { queryCalls += 1; throw new Error('must not query'); },
  };
  const first = await stability.reconcileCanaryRun(db, null, 'run-unknown', options);
  const second = await stability.reconcileCanaryRun(db, null, 'run-unknown', options);
  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    id: 'run-unknown', state: 'failed', reconciled: true,
    error_category: 'provider_rejected', reconcilable: false,
  });
  assert.equal(queryCalls, 0);
  assert.deepEqual(reconciliationSnapshot(db), before);
  db.close();
});

test('reconcile 未知态并发点击只查询一次且第二次返回 200 语义安全 DTO', async () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  insertUser(db, 'stability-admin', 'admin');
  insertCanaryFixture(db);
  let queryCalls = 0;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  let releaseQuery;
  const gate = new Promise((resolve) => { releaseQuery = resolve; });
  const options = {
    actorId: 'stability-admin',
    now: NOW,
    async queryTaskOnce() {
      queryCalls += 1;
      signalStarted();
      await gate;
      return { state: 'unknown' };
    },
  };
  const firstPromise = stability.reconcileCanaryRun(db, null, 'run-unknown', options);
  await started;
  const secondPromise = stability.reconcileCanaryRun(db, null, 'run-unknown', options);
  await new Promise((resolve) => setImmediate(resolve));
  releaseQuery();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(queryCalls, 1);
  assert.equal(first.state, 'result_unknown');
  assert.equal(second.state, 'result_unknown');
  assert.equal(first.reconciled, false);
  assert.equal(second.reconciled, false);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM audit_events
    WHERE event_type = 'provider.canary.reconciled'`).get().count, 1);
  db.close();
});

test('reconcile 未知态 60 秒内去抖，60 秒后只允许一次新查询', async () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  insertUser(db, 'stability-admin', 'admin');
  insertCanaryFixture(db);
  let queryCalls = 0;
  const queryTaskOnce = async () => { queryCalls += 1; return { state: 'unknown' }; };
  await stability.reconcileCanaryRun(db, null, 'run-unknown', {
    actorId: 'stability-admin', now: NOW, queryTaskOnce,
  });
  const withinWindow = await stability.reconcileCanaryRun(db, null, 'run-unknown', {
    actorId: 'stability-admin', now: plusMilliseconds(NOW, 59_999), queryTaskOnce,
  });
  assert.equal(withinWindow.reconcilable, false);
  await stability.reconcileCanaryRun(db, null, 'run-unknown', {
    actorId: 'stability-admin', now: plusMilliseconds(NOW, 60_001), queryTaskOnce,
  });
  assert.equal(queryCalls, 2);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM audit_events
    WHERE event_type = 'provider.canary.reconciled'`).get().count, 2);
  db.close();
});

test('reconcile 未过期 lease 不查询，lease 过期后可恢复一次', async () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  insertUser(db, 'stability-admin', 'admin');
  insertCanaryFixture(db);
  db.prepare(`UPDATE provider_canary_runs SET reconcile_claim_token = 'orphan-claim',
    reconcile_lease_until = ? WHERE id = 'run-unknown'`)
    .run(plusMilliseconds(NOW, 120_000));
  let queryCalls = 0;
  const queryTaskOnce = async () => { queryCalls += 1; return { state: 'unknown' }; };
  const leased = await stability.reconcileCanaryRun(db, null, 'run-unknown', {
    actorId: 'stability-admin', now: plusMilliseconds(NOW, 119_999), queryTaskOnce,
  });
  assert.equal(leased.reconcilable, false);
  await stability.reconcileCanaryRun(db, null, 'run-unknown', {
    actorId: 'stability-admin', now: plusMilliseconds(NOW, 120_001), queryTaskOnce,
  });
  assert.equal(queryCalls, 1);
  db.close();
});

test('reconcile lease 过期后的新结果胜出，旧请求迟到不得覆盖或重复审计', async () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  insertUser(db, 'stability-admin', 'admin');
  insertCanaryFixture(db);
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  let materializeCalls = 0;
  const firstPromise = stability.reconcileCanaryRun(db, null, 'run-unknown', {
    actorId: 'stability-admin',
    now: NOW,
    async queryTaskOnce() {
      firstStarted();
      await firstGate;
      return { state: 'succeeded', artifactUrl: 'https://cdn.invalid/late.mp4' };
    },
    async materializeVideo() {
      materializeCalls += 1;
      return {
        relative_path: '_system/provider-canary/runs/run-unknown/video.mp4',
        sha256: 'b'.repeat(64),
        bytes: 12,
      };
    },
  });
  await started;
  const newer = await stability.reconcileCanaryRun(db, null, 'run-unknown', {
    actorId: 'stability-admin',
    now: plusMilliseconds(NOW, 120_001),
    async queryTaskOnce() { return { state: 'failed', category: 'provider_rejected' }; },
  });
  releaseFirst();
  const older = await firstPromise;
  assert.equal(newer.state, 'failed');
  assert.deepEqual(older, newer);
  assert.equal(materializeCalls, 0);
  assert.equal(db.prepare(`SELECT state FROM provider_canary_runs
    WHERE id = 'run-unknown'`).get().state, 'failed');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM audit_events
    WHERE event_type = 'provider.canary.reconciled'`).get().count, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM provider_stability_events
    WHERE event_type LIKE 'provider_canary_reconcile%'`).get().count, 1);
  db.close();
});
