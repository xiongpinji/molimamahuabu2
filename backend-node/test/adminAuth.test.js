const test = require('node:test');
const assert = require('node:assert/strict');

const { createAdminAuthMiddleware } = require('../src/middleware/adminAuth');

function run(middleware, headers = {}, user = null) {
  const req = { get: (name) => headers[name.toLowerCase()], user };
  const result = { status: null, body: null, next: false };
  const res = {
    status(code) { result.status = code; return this; },
    json(body) { result.body = body; return this; },
  };
  middleware(req, res, () => { result.next = true; });
  return result;
}

test('本地模式不要求管理员令牌', () => {
  assert.equal(run(createAdminAuthMiddleware({ enabled: false }), undefined).next, true);
});

test('公开模式缺少管理员令牌配置时默认拒绝', () => {
  const result = run(createAdminAuthMiddleware({ enabled: true, token: '' }), undefined);
  assert.equal(result.status, 503);
  assert.equal(result.next, false);
});

test('公开模式允许已登录平台管理员直接访问管理接口', () => {
  const middleware = createAdminAuthMiddleware({ enabled: true, token: 'a'.repeat(32) });
  assert.equal(run(middleware, undefined).status, 401);
  assert.equal(run(middleware, { 'x-platform-admin-token': 'b'.repeat(32) }).status, 401);
  assert.equal(run(middleware, { authorization: `Bearer ${'a'.repeat(32)}` }).status, 401);
  assert.equal(run(middleware, { 'x-platform-admin-token': 'a'.repeat(32) }).status, 403);
  assert.equal(run(middleware, {}, { id: 'admin-1', role: 'admin' }).next, true);
  assert.equal(run(
    middleware,
    { 'x-platform-admin-token': 'a'.repeat(32) },
    { id: 'admin-1', role: 'admin' },
  ).next, true);
});

test('公开模式不会把普通登录用户提升为平台管理员', () => {
  const middleware = createAdminAuthMiddleware({ enabled: true, token: 'a'.repeat(32) });
  const result = run(middleware, {}, { id: 'user-1', role: 'user' });
  assert.equal(result.status, 403);
  assert.equal(result.next, false);
});

test('公开模式拒绝过短管理员令牌配置', () => {
  const result = run(createAdminAuthMiddleware({ enabled: true, token: 'short' }), { 'x-platform-admin-token': 'short' });
  assert.equal(result.status, 503);
});

test('首管理员引导只校验独立管理员令牌，不预先要求数据库管理员角色', () => {
  const middleware = createAdminAuthMiddleware({
    enabled: true,
    token: 'a'.repeat(32),
    requireRole: false,
  });
  const result = run(
    middleware,
    { 'x-platform-admin-token': 'a'.repeat(32) },
    { id: 'founder-1', role: 'user' },
  );
  assert.equal(result.next, true);
});
