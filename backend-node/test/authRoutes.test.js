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
      cookie(name, value, options) {
        result.cookie = { name, value, options };
        return this;
      },
      clearCookie(name, options) {
        result.clearedCookie = { name, options };
        return this;
      },
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

test('登录写入仅供浏览器媒体请求使用的安全会话 Cookie，退出时清除', () => {
  const db = makeDb();
  const secret = 's'.repeat(32);
  const handlers = createAuthRoutes(db, {
    registrationEnabled: true,
    jwtSecret: secret,
    secureCookies: true,
  });
  const registerCapture = responseCapture();
  handlers.register({
    body: { email: 'user@example.com', password: 'correct horse battery staple' },
  }, registerCapture.res);

  assert.equal(registerCapture.result.cookie.name, 'moli_media_session');
  assert.equal(registerCapture.result.cookie.value, registerCapture.result.body.data.token);
  assert.deepEqual(registerCapture.result.cookie.options, {
    httpOnly: true,
    sameSite: 'strict',
    secure: true,
    path: '/',
    maxAge: 2 * 60 * 60 * 1000,
  });

  const logoutCapture = responseCapture();
  handlers.logout({}, logoutCapture.res);
  assert.equal(logoutCapture.result.status, 200);
  assert.equal(logoutCapture.result.clearedCookie.name, 'moli_media_session');
  assert.deepEqual(logoutCapture.result.clearedCookie.options, {
    httpOnly: true,
    sameSite: 'strict',
    secure: true,
    path: '/',
  });
});

test('当前用户接口只返回令牌中的公开身份', () => {
  const handlers = createAuthRoutes(makeDb(), { registrationEnabled: false, jwtSecret: 's'.repeat(32) });
  const { res, result } = responseCapture();
  handlers.me({ user: { id: 'u1', email: 'user@example.com', role: 'user' } }, res);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data, { id: 'u1', email: 'user@example.com', role: 'user' });
});

test('邮箱验证码注册后创建账户且验证码不能重复使用', async () => {
  const db = makeDb();
  const sent = [];
  const handlers = createAuthRoutes(db, {
    registrationEnabled: true,
    emailVerificationEnabled: true,
    jwtSecret: 's'.repeat(32),
    verificationSecret: 'v'.repeat(32),
    generateVerificationCode: () => '123456',
    mailer: {
      isConfigured: () => true,
      sendVerificationCode: async (message) => sent.push(message),
    },
  });

  const codeCapture = responseCapture();
  await handlers.requestRegistrationCode(
    { body: { email: 'user@example.com' } },
    codeCapture.res,
  );
  assert.equal(codeCapture.result.status, 200);
  assert.equal(sent[0].to, 'user@example.com');
  assert.equal(sent[0].purpose, 'register');
  assert.equal(sent[0].code, '123456');

  const registerCapture = responseCapture();
  handlers.register({
    body: {
      email: 'user@example.com',
      password: 'correct horse battery staple',
      verification_code: '123456',
    },
  }, registerCapture.res);
  assert.equal(registerCapture.result.status, 201);

  const replayCapture = responseCapture();
  handlers.register({
    body: {
      email: 'another@example.com',
      password: 'correct horse battery staple',
      verification_code: '123456',
    },
  }, replayCapture.res);
  assert.equal(replayCapture.result.status, 400);
  assert.equal(replayCapture.result.body.error.code, 'VERIFICATION_INVALID');
});

test('注册验证码接口不暴露邮箱是否已注册', async () => {
  const db = makeDb();
  require('../src/services/userAuthService').register(db, {
    email: 'user@example.com',
    password: 'correct horse battery staple',
  });
  const sent = [];
  const handlers = createAuthRoutes(db, {
    registrationEnabled: true,
    emailVerificationEnabled: true,
    verificationSecret: 'v'.repeat(32),
    generateVerificationCode: () => '123456',
    mailer: {
      isConfigured: () => true,
      sendVerificationCode: async (message) => sent.push(message),
    },
  });

  const existingCapture = responseCapture();
  await handlers.requestRegistrationCode(
    { body: { email: 'user@example.com' } },
    existingCapture.res,
  );

  assert.equal(existingCapture.result.status, 200);
  assert.deepEqual(existingCapture.result.body.data, {
    message: '如该邮箱可用于注册，验证码将发送至邮箱',
  });
  assert.equal(sent.length, 0);
});

test('找回密码验证码可重置密码并使旧令牌立即失效', async () => {
  const db = makeDb();
  const secret = 's'.repeat(32);
  const user = require('../src/services/userAuthService').register(db, {
    email: 'user@example.com',
    password: 'correct horse battery staple',
  });
  const oldToken = require('../src/services/userAuthService').issueToken(user, secret, 0);
  const sent = [];
  const handlers = createAuthRoutes(db, {
    registrationEnabled: true,
    emailVerificationEnabled: true,
    jwtSecret: secret,
    verificationSecret: 'v'.repeat(32),
    generateVerificationCode: () => '654321',
    mailer: {
      isConfigured: () => true,
      sendVerificationCode: async (message) => sent.push(message),
    },
  });

  const codeCapture = responseCapture();
  await handlers.requestPasswordResetCode(
    { body: { email: 'user@example.com' } },
    codeCapture.res,
  );
  assert.equal(codeCapture.result.status, 200);
  assert.equal(sent[0].purpose, 'password_reset');

  const resetCapture = responseCapture();
  handlers.resetPassword({
    body: {
      email: 'user@example.com',
      verification_code: '654321',
      new_password: 'a new correct horse battery staple',
    },
  }, resetCapture.res);
  assert.equal(resetCapture.result.status, 200);

  const userAuth = require('../src/services/userAuthService');
  assert.equal(
    userAuth.authenticate(db, 'user@example.com', 'a new correct horse battery staple').id,
    user.id,
  );
  assert.throws(
    () => userAuth.authenticate(db, 'user@example.com', 'correct horse battery staple'),
    (error) => error.code === 'INVALID_CREDENTIALS',
  );
  const claims = userAuth.verifyToken(oldToken, secret);
  assert.notEqual(userAuth.getTokenVersion(db, claims.id), claims.tokenVersion);
});

test('已登录用户可用当前密码修改密码并使旧令牌失效', () => {
  const db = makeDb();
  const secret = 's'.repeat(32);
  const userAuth = require('../src/services/userAuthService');
  const user = userAuth.register(db, {
    email: 'user@example.com',
    password: 'correct horse battery staple',
  });
  const oldToken = userAuth.issueToken(user, secret, 0);
  const handlers = createAuthRoutes(db, {
    registrationEnabled: true,
    jwtSecret: secret,
  });
  const changeCapture = responseCapture();
  handlers.changePassword({
    user,
    body: {
      current_password: 'correct horse battery staple',
      new_password: 'a new correct horse battery staple',
    },
  }, changeCapture.res);

  assert.equal(changeCapture.result.status, 200);
  assert.equal(
    userAuth.authenticate(db, user.email, 'a new correct horse battery staple').id,
    user.id,
  );
  const claims = userAuth.verifyToken(oldToken, secret);
  assert.notEqual(userAuth.getTokenVersion(db, claims.id), claims.tokenVersion);
});
