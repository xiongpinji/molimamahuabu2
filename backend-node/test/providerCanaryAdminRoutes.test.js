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

test('runs 只返回安全运行字段和可对账标记', async (t) => {
  const context = await setup();
  t.after(() => context.close());
  const result = await request(
    context.baseUrl,
    '/admin/provider-stability/canary/runs',
    { token: context.adminToken },
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.data.length, 1);
  const run = result.body.data[0];
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
