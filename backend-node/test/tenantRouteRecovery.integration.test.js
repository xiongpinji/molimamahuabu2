const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');

const { setupRouter } = require('../src/routes');
const tenantService = require('../src/services/tenantService');
const userAuth = require('../src/services/userAuthService');

test('失效租户请求头不阻断用户读取自己的租户列表', async (t) => {
  const previousMode = process.env.PUBLIC_PLATFORM_MODE;
  const previousSecret = process.env.PLATFORM_JWT_SECRET;
  const secret = 'tenant-recovery-secret-value-123456';
  process.env.PUBLIC_PLATFORM_MODE = 'true';
  process.env.PLATFORM_JWT_SECRET = secret;

  const db = new Database(':memory:');
  t.after(() => {
    db.close();
    if (previousMode === undefined) delete process.env.PUBLIC_PLATFORM_MODE;
    else process.env.PUBLIC_PLATFORM_MODE = previousMode;
    if (previousSecret === undefined) delete process.env.PLATFORM_JWT_SECRET;
    else process.env.PLATFORM_JWT_SECRET = previousSecret;
  });

  db.exec('CREATE TABLE prompt_overrides (key TEXT PRIMARY KEY, content TEXT, updated_at TEXT)');
  userAuth.ensureSchema(db);
  tenantService.ensureSchema(db);
  db.prepare(`INSERT INTO platform_users
    (id, email, password_hash, password_salt, status)
    VALUES ('user-1', 'owner@example.com', 'hash', 'salt', 'active')`).run();
  const tenant = tenantService.createTenant(db, 'user-1', {
    name: '制作团队',
    slug: 'studio-team',
  });

  const app = express();
  app.use(express.json());
  app.use('/api/v1', setupRouter({}, db, { error() {}, warn() {}, info() {} }));
  const server = await new Promise((resolve) => {
    const running = app.listen(0, '127.0.0.1', () => resolve(running));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const token = userAuth.issueToken(
    { id: 'user-1', email: 'owner@example.com', role: 'user' },
    secret,
  );
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/tenants`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Tenant-Id': 'tenant-no-longer-accessible',
    },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data[0].id, tenant.id);
});
