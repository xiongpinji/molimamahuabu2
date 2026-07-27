const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');

const { setupRouter } = require('../src/routes');

test('首管理员必须同时通过登录、配置邮箱和独立管理员令牌完成引导', async (t) => {
  const previous = {
    mode: process.env.PUBLIC_PLATFORM_MODE,
    registration: process.env.PLATFORM_REGISTRATION_ENABLED,
    verification: process.env.PLATFORM_EMAIL_VERIFICATION_ENABLED,
    jwt: process.env.PLATFORM_JWT_SECRET,
    admin: process.env.PLATFORM_ADMIN_TOKEN,
    bootstrap: process.env.PLATFORM_BOOTSTRAP_ADMIN_EMAIL,
  };
  const jwtSecret = 'bootstrap-jwt-secret-value-123456789';
  const adminToken = 'bootstrap-admin-token-value-12345678';
  process.env.PUBLIC_PLATFORM_MODE = 'true';
  process.env.PLATFORM_REGISTRATION_ENABLED = 'true';
  process.env.PLATFORM_EMAIL_VERIFICATION_ENABLED = 'false';
  process.env.PLATFORM_JWT_SECRET = jwtSecret;
  process.env.PLATFORM_ADMIN_TOKEN = adminToken;
  process.env.PLATFORM_BOOTSTRAP_ADMIN_EMAIL = 'founder@example.com';

  const db = new Database(':memory:');
  db.exec('CREATE TABLE prompt_overrides (key TEXT PRIMARY KEY, content TEXT, updated_at TEXT)');
  const app = express();
  app.use(express.json());
  app.use('/api/v1', setupRouter({}, db, { error() {}, warn() {}, info() {} }));
  const server = await new Promise((resolve) => {
    const running = app.listen(0, '127.0.0.1', () => resolve(running));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => {
    db.close();
    for (const [key, value] of Object.entries(previous)) {
      const envName = {
        mode: 'PUBLIC_PLATFORM_MODE',
        registration: 'PLATFORM_REGISTRATION_ENABLED',
        verification: 'PLATFORM_EMAIL_VERIFICATION_ENABLED',
        jwt: 'PLATFORM_JWT_SECRET',
        admin: 'PLATFORM_ADMIN_TOKEN',
        bootstrap: 'PLATFORM_BOOTSTRAP_ADMIN_EMAIL',
      }[key];
      if (value === undefined) delete process.env[envName];
      else process.env[envName] = value;
    }
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;

  const registerResponse = await fetch(`${baseUrl}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'founder@example.com',
      password: 'correct horse battery staple',
    }),
  });
  const registered = await registerResponse.json();
  assert.equal(registerResponse.status, 201);
  assert.equal(registered.data.user.role, 'user');

  const unauthorized = await fetch(`${baseUrl}/auth/bootstrap-admin`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${registered.data.token}` },
  });
  assert.equal(unauthorized.status, 401);

  const bootstrapResponse = await fetch(`${baseUrl}/auth/bootstrap-admin`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${registered.data.token}`,
      'X-Platform-Admin-Token': adminToken,
    },
  });
  const bootstrapped = await bootstrapResponse.json();
  assert.equal(bootstrapResponse.status, 200);
  assert.equal(bootstrapped.data.user.role, 'admin');
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM platform_users WHERE platform_role = 'admin'").get().count,
    1,
  );
});
