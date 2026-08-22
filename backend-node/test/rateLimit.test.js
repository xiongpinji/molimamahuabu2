const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { createRateLimitMiddleware } = require('../src/middleware/rateLimit');

function call(middleware, req = {}) {
  const result = { next: false };
  const res = {
    headers: {},
    set(name, value) { this.headers[name] = String(value); return this; },
    status(code) { result.status = code; return this; },
    json(body) { result.body = body; return this; },
  };
  middleware({ ip: '127.0.0.1', ...req }, res, () => { result.next = true; });
  return { ...result, headers: res.headers };
}

test('本地模式不启用限流', () => {
  const db = new Database(':memory:');
  const middleware = createRateLimitMiddleware(db, { enabled: false, scope: 'login', limit: 1, windowMs: 1000 });
  assert.equal(call(middleware).next, true);
  assert.equal(call(middleware).next, true);
});

test('同一身份超过窗口额度返回 429 和重试秒数', () => {
  const db = new Database(':memory:');
  let now = 1000;
  const middleware = createRateLimitMiddleware(db, { enabled: true, scope: 'generation', limit: 2, windowMs: 60000, now: () => now });
  const req = { user: { id: 'user-1' } };
  assert.equal(call(middleware, req).next, true);
  assert.equal(call(middleware, req).next, true);
  const blocked = call(middleware, req);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, 'RATE_LIMITED');
  assert.equal(blocked.headers['Retry-After'], '60');
});

test('新窗口恢复且不同用户独立计数', () => {
  const db = new Database(':memory:');
  let now = 1000;
  const middleware = createRateLimitMiddleware(db, { enabled: true, scope: 'generation', limit: 1, windowMs: 1000, now: () => now });
  assert.equal(call(middleware, { user: { id: 'user-1' } }).next, true);
  assert.equal(call(middleware, { user: { id: 'user-2' } }).next, true);
  now = 2001;
  assert.equal(call(middleware, { user: { id: 'user-1' } }).next, true);
});
