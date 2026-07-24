const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const createAuthRoutes = require('../src/routes/auth');

function responseCapture() {
  const result = {};
  return {
    result,
    res: {
      status(code) { result.status = code; return this; },
      json(body) { result.body = body; return this; },
    },
  };
}

function makeDb() {
  return new Database(':memory:');
}

test('未明确开放注册时拒绝创建用户', () => {
  const handlers = createAuthRoutes(makeDb(), { registrationEnabled: false, jwtSecret: 's'.repeat(32) });
  const { res, result } = responseCapture();
  handlers.register({ body: { email: 'user@example.com', password: 'correct horse battery staple' } }, res);
  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, 'REGISTRATION_DISABLED');
});

test('注册新用户并创建个人租户及零余额租户积分账户', () => {
  const db = makeDb();
  const handlers = createAuthRoutes(db, { registrationEnabled: true, jwtSecret: 's'.repeat(32) });
  const { res, result } = responseCapture();
  handlers.register({ body: { email: 'user@example.com', password: 'correct horse battery staple' } }, res);
  assert.equal(result.status, 201);
  assert.equal(result.body.data.user.email, 'user@example.com');
  assert.equal(typeof result.body.data.token, 'string');
  assert.deepEqual(db.prepare('SELECT available, held, spent FROM credit_accounts').get(), { available: 0, held: 0, spent: 0 });
  const tenant = db.prepare('SELECT id FROM tenants WHERE created_by = ?').get(result.body.data.user.id);
  assert.equal(tenant.id, `personal:${result.body.data.user.id}`);
  assert.deepEqual(
    db.prepare('SELECT role, status FROM tenant_members WHERE tenant_id = ? AND user_id = ?')
      .get(tenant.id, result.body.data.user.id),
    { role: 'owner', status: 'active' },
  );
  assert.deepEqual(
    db.prepare('SELECT available, held, spent FROM tenant_credit_accounts WHERE tenant_id = ?').get(tenant.id),
    { available: 0, held: 0, spent: 0 },
  );
  const event = db.prepare("SELECT event_type, tenant_id FROM audit_events WHERE user_id = ?").get(result.body.data.user.id);
  assert.deepEqual(event, { event_type: 'auth.register.success', tenant_id: tenant.id });
});

test('登录密钥未安全配置时不创建半成品账户', () => {
  const db = makeDb();
  const handlers = createAuthRoutes(db, { registrationEnabled: true, jwtSecret: 'short' });
  const { res, result } = responseCapture();
  handlers.register({ body: { email: 'user@example.com', password: 'correct horse battery staple' } }, res);
  assert.equal(result.status, 503);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM platform_users').get().count, 0);
});

test('登录失败不泄露邮箱是否存在', () => {
  const db = makeDb();
  const handlers = createAuthRoutes(db, { registrationEnabled: true, jwtSecret: 's'.repeat(32) });
  const { res, result } = responseCapture();
  handlers.login({ body: { email: 'missing@example.com', password: 'wrong password' } }, res);
  assert.equal(result.status, 401);
  assert.equal(result.body.error.code, 'INVALID_CREDENTIALS');
  assert.equal(db.prepare('SELECT event_type, user_id, outcome FROM audit_events').get().event_type, 'auth.login.failed');
  assert.equal(db.prepare('SELECT event_type, user_id, outcome FROM audit_events').get().user_id, null);
});

test('登录成功记录用户编号但不记录邮箱和密码', () => {
  const db = makeDb();
  const handlers = createAuthRoutes(db, { registrationEnabled: true, jwtSecret: 's'.repeat(32) });
  const registerCapture = responseCapture();
  handlers.register({ body: { email: 'user@example.com', password: 'correct horse battery staple' } }, registerCapture.res);
  const loginCapture = responseCapture();
  handlers.login({ body: { email: 'user@example.com', password: 'correct horse battery staple' } }, loginCapture.res);
  const event = db.prepare("SELECT * FROM audit_events WHERE event_type = 'auth.login.success'").get();
  assert.equal(event.user_id, loginCapture.result.body.data.user.id);
  assert.equal(event.tenant_id, `personal:${loginCapture.result.body.data.user.id}`);
  assert.equal('email' in event, false);
  assert.equal('password' in event, false);
});

test('当前用户接口只返回令牌中的公开身份', () => {
  const handlers = createAuthRoutes(makeDb(), { registrationEnabled: false, jwtSecret: 's'.repeat(32) });
  const { res, result } = responseCapture();
  handlers.me({ user: { id: 'u1', email: 'user@example.com', role: 'user' } }, res);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data, { id: 'u1', email: 'user@example.com', role: 'user' });
});
