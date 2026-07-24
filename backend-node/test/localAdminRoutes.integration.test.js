const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');

const { setupRouter } = require('../src/routes');
const userAuth = require('../src/services/userAuthService');

async function startLocalAdminApp(t) {
  const previousMode = process.env.PUBLIC_PLATFORM_MODE;
  process.env.PUBLIC_PLATFORM_MODE = '0';
  const db = new Database(':memory:');
  db.exec('CREATE TABLE prompt_overrides (key TEXT PRIMARY KEY, content TEXT, updated_at TEXT)');
  userAuth.ensureSchema(db);
  const user = userAuth.register(db, {
    email: 'local-admin@example.com',
    password: 'correct horse battery staple',
  });
  const app = express();
  app.use(express.json());
  app.use('/api/v1', setupRouter({}, db, { error() {}, warn() {}, info() {} }));
  const server = await new Promise((resolve) => {
    const running = app.listen(0, '127.0.0.1', () => resolve(running));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => {
    db.close();
    if (previousMode === undefined) delete process.env.PUBLIC_PLATFORM_MODE;
    else process.env.PUBLIC_PLATFORM_MODE = previousMode;
  });
  return {
    db,
    user,
    baseUrl: `http://127.0.0.1:${server.address().port}/api/v1`,
  };
}

test('本地单用户模式无需登录即可读取平台账号', async (t) => {
  const { baseUrl } = await startLocalAdminApp(t);
  const response = await fetch(`${baseUrl}/platform-admin/users`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data[0].email, 'local-admin@example.com');
});

test('本地单用户模式管理写操作使用系统操作人且不会崩溃', async (t) => {
  const { baseUrl, db, user } = await startLocalAdminApp(t);
  const roleResponse = await fetch(`${baseUrl}/platform-admin/users/${user.id}/role`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'support' }),
  });
  assert.equal(roleResponse.status, 200);

  const redeemResponse = await fetch(`${baseUrl}/billing/admin/redeem-codes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: '本地测试码', credits: 10 }),
  });
  const redeemBody = await redeemResponse.json();
  assert.equal(redeemResponse.status, 201);
  assert.equal(redeemBody.success, true);
  assert.equal(
    db.prepare('SELECT created_by FROM redeem_codes WHERE id = ?').get(redeemBody.data.id).created_by,
    'platform-admin',
  );
  assert.equal(
    db.prepare("SELECT user_id FROM audit_events WHERE event_type = 'platform.user.role_changed'").get().user_id,
    null,
  );
});
