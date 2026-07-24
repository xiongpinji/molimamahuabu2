const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const auth = require('../src/services/userAuthService');
const { createUserAuthMiddleware } = require('../src/middleware/userAuth');

function makeDb() {
  const db = new Database(':memory:');
  auth.ensureSchema(db);
  return db;
}

function runMiddleware(middleware, authorization) {
  const req = { get: () => authorization };
  const result = { status: null, body: null, next: false };
  const res = {
    status(code) { result.status = code; return this; },
    json(body) { result.body = body; return this; },
  };
  middleware(req, res, () => { result.next = true; });
  return { req, result };
}

test('注册时规范化邮箱并且绝不返回密码摘要', () => {
  const db = makeDb();
  const user = auth.register(db, { email: '  USER@Example.COM ', password: 'correct horse battery staple' });
  assert.equal(user.email, 'user@example.com');
  assert.equal('password_hash' in user, false);
  assert.equal('password_salt' in user, false);
});

test('重复邮箱注册被拒绝', () => {
  const db = makeDb();
  auth.register(db, { email: 'user@example.com', password: 'correct horse battery staple' });
  assert.throws(
    () => auth.register(db, { email: 'USER@example.com', password: 'another correct password' }),
    (error) => error.code === 'EMAIL_EXISTS'
  );
});

test('正确密码可登录且错误密码返回统一错误', () => {
  const db = makeDb();
  auth.register(db, { email: 'user@example.com', password: 'correct horse battery staple' });
  assert.equal(auth.authenticate(db, 'user@example.com', 'correct horse battery staple').email, 'user@example.com');
  assert.throws(
    () => auth.authenticate(db, 'user@example.com', 'wrong password'),
    (error) => error.code === 'INVALID_CREDENTIALS'
  );
});

test('令牌中只保存必要身份且可校验', () => {
  const user = { id: 'user-1', email: 'user@example.com', role: 'user' };
  const token = auth.issueToken(user, 's'.repeat(32));
  const claims = auth.verifyToken(token, 's'.repeat(32));
  assert.deepEqual({ id: claims.id, email: claims.email, role: claims.role }, user);
  assert.equal(claims.password_hash, undefined);
});

test('公开模式用户中间件默认拒绝缺失密钥、缺失令牌和无效令牌', () => {
  assert.equal(runMiddleware(createUserAuthMiddleware({ enabled: false }), undefined).result.next, true);
  assert.equal(runMiddleware(createUserAuthMiddleware({ enabled: true, secret: '' }), undefined).result.status, 503);
  const middleware = createUserAuthMiddleware({ enabled: true, secret: 's'.repeat(32) });
  assert.equal(runMiddleware(middleware, undefined).result.status, 401);
  assert.equal(runMiddleware(middleware, 'Bearer invalid').result.status, 401);
});

test('公开模式接受有效令牌并写入 req.user', () => {
  const secret = 's'.repeat(32);
  const token = auth.issueToken({ id: 'user-1', email: 'user@example.com', role: 'user' }, secret);
  const { req, result } = runMiddleware(createUserAuthMiddleware({ enabled: true, secret }), `Bearer ${token}`);
  assert.equal(result.next, true);
  assert.equal(req.user.id, 'user-1');
});

test('管理员停用账号后既有令牌立即失效', () => {
  const secret = 's'.repeat(32);
  const db = makeDb();
  const user = auth.register(db, {
    email: 'disabled@example.com',
    password: 'correct horse battery staple',
  });
  const token = auth.issueToken(user, secret);
  db.prepare("UPDATE platform_users SET status = 'disabled' WHERE id = ?").run(user.id);
  const { result } = runMiddleware(
    createUserAuthMiddleware({ enabled: true, secret, db }),
    `Bearer ${token}`,
  );
  assert.equal(result.status, 401);
  assert.equal(result.next, false);
});
