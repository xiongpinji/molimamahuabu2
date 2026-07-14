const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { createResourceOwnershipMiddleware, createStaticOwnershipMiddleware } = require('../src/middleware/resourceOwnership');
const auth = require('../src/services/userAuthService');

const SECRET = 'x'.repeat(32);

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO platform_users (id, email, password_hash, password_salt) VALUES (?, ?, ?, ?)')
    .run('user-1', 'one@example.com', 'hash', 'salt');
  db.prepare('INSERT INTO platform_users (id, email, password_hash, password_salt) VALUES (?, ?, ?, ?)')
    .run('user-2', 'two@example.com', 'hash', 'salt');
  const own = db.prepare(`INSERT INTO dramas (user_id, title, status, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?)`).run('user-1', 'Own', now, now).lastInsertRowid;
  const other = db.prepare(`INSERT INTO dramas (user_id, title, status, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?)`).run('user-2', 'Other', now, now).lastInsertRowid;
  const legacy = db.prepare(`INSERT INTO dramas (user_id, title, status, created_at, updated_at) VALUES (NULL, ?, 'draft', ?, ?)`).run('Legacy', now, now).lastInsertRowid;
  const episode = db.prepare(`INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at) VALUES (?, 1, 'E1', ?, ?)`).run(own, now, now).lastInsertRowid;
  db.prepare(`INSERT INTO async_tasks (id, type, status, resource_id, created_at, updated_at) VALUES ('task-own', 'storyboard_generation', 'pending', ?, ?, ?)`)
    .run(String(episode), now, now);
  return { db, own, other, legacy, episode };
}

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
    end() { this.ended = true; return this; },
  };
}

test('公开模式按工程归属隔离剧本及子资源', () => {
  const { db, own, other, legacy, episode } = setup();
  const middleware = createResourceOwnershipMiddleware({ db, enabled: true });
  const ok = response();
  let called = false;
  middleware({ path: `/dramas/${own}`, user: { id: 'user-1' }, body: {}, query: {} }, ok, () => { called = true; });
  assert.equal(called, true);
  const denied = response();
  middleware({ path: `/dramas/${other}`, user: { id: 'user-1' }, body: {}, query: {} }, denied, () => {});
  assert.equal(denied.statusCode, 404);
  const deniedLegacy = response();
  middleware({ path: `/dramas/${legacy}`, user: { id: 'user-1' }, body: {}, query: {} }, deniedLegacy, () => {});
  assert.equal(deniedLegacy.statusCode, 404);
  const child = response();
  middleware({ path: `/episodes/${episode}/storyboards`, user: { id: 'user-1' }, body: {}, query: {} }, child, () => { called = true; });
  assert.equal(child.statusCode, 200);
  const task = response();
  middleware({ path: '/tasks/task-own', user: { id: 'user-1' }, body: {}, query: {} }, task, () => { called = true; });
  assert.equal(task.statusCode, 200);
});

test('静态工程文件要求登录并校验工程归属', () => {
  const { db, own, other } = setup();
  const middleware = createStaticOwnershipMiddleware({ db, enabled: true, secret: SECRET });
  const token = auth.issueToken({ id: 'user-1', email: 'one@example.com', role: 'user' }, SECRET);
  const ownRes = response();
  let called = false;
  middleware({ path: `/projects/${String(own).padStart(4, '0')}_20260714_Own/characters/a.jpg`, get(name) { return name === 'authorization' ? `Bearer ${token}` : ''; } }, ownRes, () => { called = true; });
  assert.equal(called, true);
  const otherRes = response();
  middleware({ path: `/projects/${String(other).padStart(4, '0')}_20260714_Other/characters/a.jpg`, get() { return `Bearer ${token}`; } }, otherRes, () => {});
  assert.equal(otherRes.statusCode, 404);
  const libraryRes = response();
  middleware({ path: '/library/characters/a.jpg', get() { return `Bearer ${token}`; } }, libraryRes, () => {});
  assert.equal(libraryRes.statusCode, 404);
});
