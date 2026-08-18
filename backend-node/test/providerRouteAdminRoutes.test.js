const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');

const { setupRouter } = require('../src/routes');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const userAuth = require('../src/services/userAuthService');
const evidenceService = require('../src/services/providerCanaryEvidenceService');

const JWT_SECRET = 'provider-stability-jwt-secret-value-123456';
const ADMIN_TOKEN = 'provider-stability-admin-token-value-123456';

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

async function request(baseUrl, endpoint, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
  }
  return { status: response.status, body: parsed };
}

async function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  insertUser(db, 'plain-user', 'user');
  insertUser(db, 'stability-admin', 'admin');
  const now = '2026-08-15T00:00:00.000Z';
  const configId = Number(db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, name, base_url, api_key, model, default_model, priority,
     is_active, logical_model_id, failover_enabled, verification_status, created_at, updated_at)
    VALUES ('image', 'secret-relay', '主图片中转',
      'https://user:password@relay.example.com:8443/v1/images?token=hidden',
      'sk-never-return-this', ?, 'upstream-image', 50, 1, 'logical-image', 1,
      'unverified', ?, ?)`)
    .run(JSON.stringify(['upstream-image']), now, now).lastInsertRowid);
  db.prepare(`INSERT INTO provider_route_health
    (config_id, state, consecutive_failures, last_error_category, updated_at)
    VALUES (?, 'degraded', 2, 'provider_unavailable', ?)`)
    .run(configId, now);
  db.prepare(`INSERT INTO provider_stability_events
    (severity, event_type, logical_model_id, config_id, task_state, credit_state,
     safe_details, created_at)
    VALUES ('critical', 'provider_failure', 'logical-image', ?, 'failed', 'held',
      '{"category":"provider_unavailable","debug":"prompt text https://signed.example/result?token=hidden sk-secret"}', ?)`)
    .run(configId, now);
  db.prepare(`INSERT INTO provider_stability_events
    (severity, event_type, logical_model_id, config_id, target_config_id,
     safe_details, created_at)
    VALUES ('warning', 'route_switched', 'logical-image', ?, ?,
      '{"category":"provider_unavailable","state":"switching"}', ?)`)
    .run(configId, configId, '2026-08-14T23:59:00.000Z');
  db.prepare(`INSERT INTO provider_stability_events
    (severity, event_type, logical_model_id, config_id, safe_details, created_at)
    VALUES ('error', 'logical_model_unavailable', 'logical-image', ?, '{}', ?),
           ('info', 'provider_recovered', 'logical-image', ?, '{}', ?),
           ('P1', 'legacy_provider_alert', 'logical-image', ?, '{}', ?)`)
    .run(
      configId,
      '2026-08-14T23:58:00.000Z',
      configId,
      '2026-08-14T23:57:00.000Z',
      configId,
      '2026-08-14T23:56:00.000Z',
    );

  const previous = {
    PUBLIC_PLATFORM_MODE: process.env.PUBLIC_PLATFORM_MODE,
    PLATFORM_JWT_SECRET: process.env.PLATFORM_JWT_SECRET,
    PLATFORM_ADMIN_TOKEN: process.env.PLATFORM_ADMIN_TOKEN,
  };
  process.env.PUBLIC_PLATFORM_MODE = 'true';
  process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
  process.env.PLATFORM_ADMIN_TOKEN = ADMIN_TOKEN;
  const app = express();
  app.use(express.json());
  app.use('/api/v1', setupRouter({}, db, { info() {}, warn() {}, error() {} }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return {
    db,
    configId,
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

test('供应商稳定性接口仅管理员和财务管理权限可访问', async (t) => {
  const context = await setup();
  t.after(() => context.close());
  for (const endpoint of [
    '/admin/provider-stability/routes',
    '/admin/provider-stability/events',
    '/admin/provider-stability/canary/summary',
    '/admin/provider-stability/canary/runs',
  ]) {
    assert.equal((await request(context.baseUrl, endpoint)).status, 401);
    assert.equal((await request(context.baseUrl, endpoint, { token: context.plainToken })).status, 403);
    assert.equal((await request(context.baseUrl, endpoint, { token: context.adminToken })).status, 200);
  }
});

test('管理员列表只返回安全中转关联、健康和任务积分摘要', async (t) => {
  const context = await setup();
  t.after(() => context.close());
  const routes = await request(context.baseUrl, '/admin/provider-stability/routes', {
    token: context.adminToken,
  });
  assert.equal(routes.status, 200);
  assert.equal(routes.body.data.configs[0].logical_model_id, 'logical-image');
  assert.equal(routes.body.data.configs[0].relay_host, 'relay.example.com');
  assert.equal(routes.body.data.configs[0].health.state, 'degraded');
  assert.equal(routes.body.data.configs[0].last_switch_at, '2026-08-14T23:59:00.000Z');
  const serialized = JSON.stringify(routes.body);
  for (const secret of [
    'sk-never-return-this', 'password', 'token=hidden', ':8443', '/v1/images',
  ]) assert.equal(serialized.includes(secret), false);

  const events = await request(context.baseUrl, '/admin/provider-stability/events', {
    token: context.adminToken,
  });
  assert.equal(events.status, 200);
  assert.equal(events.body.data[0].event_type, 'provider_failure');
  assert.deepEqual(events.body.data.map((event) => event.alert_level), [
    'P0', 'P2', 'P1', 'P3', 'P1',
  ]);
  assert.deepEqual(events.body.data.map((event) => event.severity), [
    'critical', 'warning', 'error', 'info', 'error',
  ]);
  assert.equal(JSON.stringify(events.body).includes('sk-never-return-this'), false);
  assert.equal(JSON.stringify(events.body).includes('signed.example'), false);
  assert.equal(JSON.stringify(events.body).includes('prompt text'), false);
});

test('线路 PATCH 保留原四字段并增量支持 canary_paused，恢复巡检不激活线路或伪造 fresh', async (t) => {
  const context = await setup();
  t.after(() => context.close());
  const capability = evidenceService.normalizeCapability('image', { count: 1 });
  const capabilityFingerprint = evidenceService.capabilityFingerprint('image', capability);
  context.db.prepare(`INSERT INTO provider_canary_runs
    (id, idempotency_key, config_id, logical_model_id, service_type,
     capability_fingerprint, config_fingerprint, cost_fingerprint,
     runtime_fingerprint, provider_scope_key, state, reserved_cost_micros,
     actual_cost_micros, currency, budget_day, budget_month, created_at,
     finished_at, updated_at)
    VALUES ('pause-run', 'pause-idem', ?, 'logical-image', 'image', ?,
      'cfg-hash', 'cost-hash', 'runtime-hash', 'scope-hash', 'succeeded',
      1, 1, 'CNY', '2026-08-15', '2026-08', ?, ?, ?)`)
    .run(context.configId, capabilityFingerprint,
      '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z');
  context.db.prepare(`INSERT INTO provider_canary_evidence
    (config_id, service_type, capability_fingerprint, capability_json, state,
     run_id, config_fingerprint, cost_fingerprint, runtime_fingerprint,
     verified_at, expires_at, created_at, updated_at)
    VALUES (?, 'image', ?, ?, 'fresh', 'pause-run', 'cfg-hash', 'cost-hash',
      'runtime-hash', ?, '2026-08-17T00:00:00.000Z', ?, ?)`)
    .run(context.configId, capabilityFingerprint, JSON.stringify(capability),
      '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z');
  const rejected = await request(
    context.baseUrl,
    `/admin/provider-stability/routes/${context.configId}`,
    {
      method: 'PATCH',
      token: context.adminToken,
      body: { verification_status: 'verified', base_url: 'https://evil.example/v1' },
    },
  );
  assert.equal(rejected.status, 400);
  assert.equal((await request(
    context.baseUrl,
    `/admin/provider-stability/routes/${context.configId}`,
    { method: 'PATCH', body: { canary_paused: true } },
  )).status, 401);
  assert.equal((await request(
    context.baseUrl,
    `/admin/provider-stability/routes/${context.configId}`,
    { method: 'PATCH', token: context.plainToken, body: { canary_paused: true } },
  )).status, 403);

  const paused = await request(
    context.baseUrl,
    `/admin/provider-stability/routes/${context.configId}`,
    {
      method: 'PATCH',
      token: context.adminToken,
      body: {
        logical_model_id: 'logical-image-v2',
        failover_enabled: false,
        priority: 25,
        admin_paused: true,
        canary_paused: true,
      },
    },
  );
  assert.equal(paused.status, 200);
  assert.equal(paused.body.data.logical_model_id, 'logical-image-v2');
  assert.equal(paused.body.data.failover_enabled, false);
  assert.equal(paused.body.data.priority, 25);
  assert.equal(paused.body.data.admin_paused, true);
  assert.equal(paused.body.data.canary_paused, true);
  const resumed = await request(
    context.baseUrl,
    `/admin/provider-stability/routes/${context.configId}`,
    { method: 'PATCH', token: context.adminToken, body: { canary_paused: false } },
  );
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.data.admin_paused, true);
  assert.equal(resumed.body.data.canary_paused, false);
  const stored = context.db.prepare(`SELECT base_url, verification_status, is_active, canary_paused,
      logical_model_id, failover_enabled, priority
    FROM ai_service_configs WHERE id = ?`).get(context.configId);
  assert.match(stored.base_url, /relay\.example\.com/);
  assert.equal(stored.verification_status, 'unverified');
  assert.equal(stored.is_active, 0);
  assert.equal(stored.canary_paused, 0);
  assert.equal(stored.logical_model_id, 'logical-image-v2');
  assert.equal(stored.failover_enabled, 0);
  assert.equal(stored.priority, 25);
  assert.equal(context.db.prepare(`SELECT state FROM provider_canary_evidence
    WHERE run_id = 'pause-run'`).get().state, 'never_verified');
  const auditTypes = context.db.prepare(`SELECT event_type FROM audit_events
    WHERE user_id = ? ORDER BY created_at`).all('stability-admin').map((row) => row.event_type);
  assert.deepEqual(auditTypes, [
    'provider.route.updated',
    'provider.route.updated',
  ]);
});

test('线路 PATCH 与管理员审计处于同一事务，审计失败时配置不落盘', async (t) => {
  const context = await setup();
  t.after(() => context.close());
  context.db.exec(`CREATE TRIGGER reject_provider_route_audit
    BEFORE INSERT ON audit_events
    WHEN NEW.event_type = 'provider.route.updated'
    BEGIN
      SELECT RAISE(ABORT, 'audit blocked');
    END`);
  const before = context.db.prepare(`SELECT priority, logical_model_id, is_active, canary_paused
    FROM ai_service_configs WHERE id = ?`).get(context.configId);
  const result = await request(
    context.baseUrl,
    `/admin/provider-stability/routes/${context.configId}`,
    {
      method: 'PATCH',
      token: context.adminToken,
      body: { priority: 9, logical_model_id: 'must-rollback', canary_paused: true },
    },
  );
  assert.equal(result.status, 500);
  assert.deepEqual(
    context.db.prepare(`SELECT priority, logical_model_id, is_active, canary_paused
      FROM ai_service_configs WHERE id = ?`).get(context.configId),
    before,
  );
});

test('健康重置和真实生成验证均写管理员审计且验证不接受客户端自证', async (t) => {
  const context = await setup();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-provider-admin-'));
  t.after(async () => {
    await context.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const artifact = path.join(tempDir, 'result.png');
  fs.writeFileSync(artifact, Buffer.from('verified-image-artifact'));
  const generationId = Number(context.db.prepare(`INSERT INTO image_generations
    (config_id, status, local_path, created_at, updated_at)
    VALUES (?, 'completed', ?, ?, ?)`)
    .run(context.configId, artifact, '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z')
    .lastInsertRowid);

  const reset = await request(
    context.baseUrl,
    `/admin/provider-stability/routes/${context.configId}/reset-health`,
    { method: 'POST', token: context.adminToken },
  );
  assert.equal(reset.status, 200);
  assert.equal(reset.body.data.state, 'healthy');

  const verified = await request(
    context.baseUrl,
    `/admin/provider-stability/routes/${context.configId}/verify-from-generation`,
    {
      method: 'POST',
      token: context.adminToken,
      body: { generation_id: generationId, verification_status: 'verified' },
    },
  );
  assert.equal(verified.status, 400);
  const valid = await request(
    context.baseUrl,
    `/admin/provider-stability/routes/${context.configId}/verify-from-generation`,
    { method: 'POST', token: context.adminToken, body: { generation_id: generationId } },
  );
  assert.equal(valid.status, 200);
  assert.equal(valid.body.data.verification_status, 'verified');
  const auditTypes = context.db.prepare(`SELECT event_type FROM audit_events
    WHERE user_id = ? ORDER BY created_at`).all('stability-admin').map((row) => row.event_type);
  assert.equal(auditTypes.includes('provider.health.reset'), true);
  assert.equal(auditTypes.includes('provider.config.verified'), true);
});
