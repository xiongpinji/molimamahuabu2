'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { setupRouter } = require('../src/routes');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const userAuth = require('../src/services/userAuthService');

const JWT_SECRET = 'shared-foundation-auth-secret-123456789';
const ADMIN_TOKEN = 'shared-foundation-admin-token-123456789';

async function listen(db) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', setupRouter({}, db, { error() {}, warn() {}, info() {} }));
  const server = await new Promise((resolve) => {
    const running = app.listen(0, '127.0.0.1', () => resolve(running));
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}/api/v1`,
  };
}

async function startPublicApp(t) {
  const previous = {
    PUBLIC_PLATFORM_MODE: process.env.PUBLIC_PLATFORM_MODE,
    PLATFORM_REGISTRATION_ENABLED: process.env.PLATFORM_REGISTRATION_ENABLED,
    PLATFORM_EMAIL_VERIFICATION_ENABLED: process.env.PLATFORM_EMAIL_VERIFICATION_ENABLED,
    PLATFORM_JWT_SECRET: process.env.PLATFORM_JWT_SECRET,
    PLATFORM_ADMIN_TOKEN: process.env.PLATFORM_ADMIN_TOKEN,
  };
  process.env.PUBLIC_PLATFORM_MODE = 'true';
  process.env.PLATFORM_REGISTRATION_ENABLED = 'true';
  process.env.PLATFORM_EMAIL_VERIFICATION_ENABLED = 'false';
  process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
  process.env.PLATFORM_ADMIN_TOKEN = ADMIN_TOKEN;

  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const { server, baseUrl } = await listen(db);

  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(resolve));
  });
  t.after(() => {
    db.close();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  return {
    db,
    baseUrl,
  };
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  return { response, body: await response.json() };
}

async function register(baseUrl, email) {
  const result = await request(baseUrl, '/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'correct horse battery staple' }),
  });
  assert.equal(result.response.status, 201);
  return result.body.data;
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

test('公开平台登出后当前 Bearer 令牌立即失效', async (t) => {
  const { baseUrl } = await startPublicApp(t);
  const registered = await register(baseUrl, 'logout@example.com');
  const headers = bearer(registered.token);

  assert.equal((await fetch(`${baseUrl}/auth/me`, { headers })).status, 200);
  assert.equal((await fetch(`${baseUrl}/auth/logout`, { method: 'POST', headers })).status, 200);

  const afterLogout = await fetch(`${baseUrl}/auth/me`, { headers });
  const body = await afterLogout.json();
  assert.equal(afterLogout.status, 401);
  assert.equal(body.error.code, 'UNAUTHORIZED');
});

test('匿名、普通用户、租户成员和平台管理员保持真实 HTTP 权限边界', async (t) => {
  const { baseUrl, db } = await startPublicApp(t);
  const owner = await register(baseUrl, 'owner@example.com');
  const member = await register(baseUrl, 'member@example.com');
  const outsider = await register(baseUrl, 'outsider@example.com');
  const admin = await register(baseUrl, 'admin@example.com');
  db.prepare("UPDATE platform_users SET role = 'admin', platform_role = 'admin' WHERE id = ?")
    .run(admin.user.id);
  const loggedAdmin = await request(baseUrl, '/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email: 'admin@example.com',
      password: 'correct horse battery staple',
    }),
  });
  assert.equal(loggedAdmin.response.status, 200);

  const anonymous = await request(baseUrl, '/auth/me');
  assert.equal(anonymous.response.status, 401);
  assert.equal(anonymous.body.error.code, 'UNAUTHORIZED');

  const tenant = await request(baseUrl, '/tenants', {
    method: 'POST',
    headers: bearer(owner.token),
    body: JSON.stringify({ name: '验收工作区', slug: 'acceptance-team' }),
  });
  assert.equal(tenant.response.status, 201);
  const tenantId = tenant.body.data.id;

  const added = await request(baseUrl, `/tenants/${tenantId}/members`, {
    method: 'POST',
    headers: bearer(owner.token),
    body: JSON.stringify({ email: member.user.email, role: 'member' }),
  });
  assert.equal(added.response.status, 201);

  for (const account of [member, outsider]) {
    const denied = await request(baseUrl, `/tenants/${tenantId}/members`, {
      headers: bearer(account.token),
    });
    assert.equal(denied.response.status, 404);
    assert.equal(denied.body.error.code, 'NOT_FOUND');
  }

  const ordinaryAdminApi = await request(baseUrl, '/platform-admin/users', {
    headers: bearer(member.token),
  });
  assert.equal(ordinaryAdminApi.response.status, 403);
  assert.equal(ordinaryAdminApi.body.error.code, 'PLATFORM_PERMISSION_DENIED');

  const forced = await request(baseUrl, `/platform-admin/users/${member.user.id}/force-logout`, {
    method: 'POST',
    headers: bearer(loggedAdmin.body.data.token),
  });
  assert.equal(forced.response.status, 200);
  assert.equal((await request(baseUrl, '/auth/me', { headers: bearer(member.token) })).response.status, 401);

  const exposed = JSON.stringify(forced.body);
  assert.doesNotMatch(exposed, /password_hash|password_salt|verification_secret|jwt_secret/i);
});

test('并发降级不能移除租户最后一个 owner', async (t) => {
  const { baseUrl, db } = await startPublicApp(t);
  const ownerA = await register(baseUrl, 'owner-a@example.com');
  const ownerB = await register(baseUrl, 'owner-b@example.com');
  const tenant = await request(baseUrl, '/tenants', {
    method: 'POST',
    headers: bearer(ownerA.token),
    body: JSON.stringify({ name: '双所有者工作区', slug: 'two-owner-team' }),
  });
  const tenantId = tenant.body.data.id;
  const added = await request(baseUrl, `/tenants/${tenantId}/members`, {
    method: 'POST',
    headers: bearer(ownerA.token),
    body: JSON.stringify({ email: ownerB.user.email, role: 'owner' }),
  });
  assert.equal(added.response.status, 201);

  const results = await Promise.all([
    request(baseUrl, `/tenants/${tenantId}/members/${ownerB.user.id}/role`, {
      method: 'PATCH',
      headers: bearer(ownerA.token),
      body: JSON.stringify({ role: 'member' }),
    }),
    request(baseUrl, `/tenants/${tenantId}/members/${ownerA.user.id}/role`, {
      method: 'PATCH',
      headers: bearer(ownerB.token),
      body: JSON.stringify({ role: 'member' }),
    }),
  ]);
  assert.equal(results.filter(({ response }) => response.status === 200).length, 1);
  assert.equal(results.filter(({ response }) => [404, 409].includes(response.status)).length, 1);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM tenant_members WHERE tenant_id = ? AND role = 'owner' AND status = 'active'")
      .get(tenantId).count,
    1,
  );
});

test('重启数据库连接后会话与租户成员状态保持且不重复', async (t) => {
  const previous = {
    PUBLIC_PLATFORM_MODE: process.env.PUBLIC_PLATFORM_MODE,
    PLATFORM_REGISTRATION_ENABLED: process.env.PLATFORM_REGISTRATION_ENABLED,
    PLATFORM_EMAIL_VERIFICATION_ENABLED: process.env.PLATFORM_EMAIL_VERIFICATION_ENABLED,
    PLATFORM_JWT_SECRET: process.env.PLATFORM_JWT_SECRET,
  };
  process.env.PUBLIC_PLATFORM_MODE = 'true';
  process.env.PLATFORM_REGISTRATION_ENABLED = 'true';
  process.env.PLATFORM_EMAIL_VERIFICATION_ENABLED = 'false';
  process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-shared-auth-'));
  const filename = path.join(root, 'acceptance.sqlite');
  let db;
  let running;
  t.after(async () => {
    if (running?.server?.listening) {
      running.server.closeAllConnections?.();
      await new Promise((resolve) => running.server.close(resolve));
    }
    if (db?.open) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  db = new Database(filename);
  runMigrationsAndEnsure(db);
  running = await listen(db);
  const registered = await register(running.baseUrl, 'persistent@example.com');
  const created = await request(running.baseUrl, '/tenants', {
    method: 'POST',
    headers: bearer(registered.token),
    body: JSON.stringify({ name: '持久工作区', slug: 'persistent-team' }),
  });
  assert.equal(created.response.status, 201);
  await new Promise((resolve) => running.server.close(resolve));
  db.close();

  db = new Database(filename);
  runMigrationsAndEnsure(db);
  running = await listen(db);

  assert.equal((await request(running.baseUrl, '/auth/me', {
    headers: bearer(registered.token),
  })).response.status, 200);
  const tenants = await request(running.baseUrl, '/tenants', {
    headers: bearer(registered.token),
  });
  assert.equal(tenants.response.status, 200);
  assert.equal(tenants.body.data.filter((item) => item.id === created.body.data.id).length, 1);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM tenant_members WHERE tenant_id = ? AND user_id = ?')
      .get(created.body.data.id, registered.user.id).count,
    1,
  );
});
