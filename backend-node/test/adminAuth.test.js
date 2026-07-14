const test = require('node:test');
const assert = require('node:assert/strict');

const { createAdminAuthMiddleware } = require('../src/middleware/adminAuth');

function run(middleware, headers = {}) {
  const req = { get: (name) => headers[name.toLowerCase()] };
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

test('公开模式拒绝缺失或错误令牌并只接受独立管理员请求头', () => {
  const middleware = createAdminAuthMiddleware({ enabled: true, token: 'a'.repeat(32) });
  assert.equal(run(middleware, undefined).status, 401);
  assert.equal(run(middleware, { 'x-platform-admin-token': 'b'.repeat(32) }).status, 401);
  assert.equal(run(middleware, { authorization: `Bearer ${'a'.repeat(32)}` }).status, 401);
  assert.equal(run(middleware, { 'x-platform-admin-token': 'a'.repeat(32) }).next, true);
});

test('公开模式拒绝过短管理员令牌配置', () => {
  const result = run(createAdminAuthMiddleware({ enabled: true, token: 'short' }), { 'x-platform-admin-token': 'short' });
  assert.equal(result.status, 503);
});
