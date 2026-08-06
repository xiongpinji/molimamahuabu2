const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
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

test('静态媒体支持 HttpOnly 会话 Cookie，并只允许当前用户生成的独立素材', () => {
  const { db } = setup();
  const token = auth.issueToken({ id: 'user-1', email: 'one@example.com', role: 'user' }, SECRET);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO tenants (id, name, slug, status, created_by, created_at, updated_at)
    VALUES ('team-1', 'Team', 'team-1', 'active', 'user-1', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tenant_members (tenant_id, user_id, role, status, created_at, updated_at)
    VALUES ('team-1', 'user-1', 'member', 'active', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO image_generations
    (provider, prompt, status, local_path, user_id, tenant_id, created_at, updated_at)
    VALUES ('test', 'owned', 'completed', 'library/images/owned.jpg', 'user-1', NULL, ?, ?)`)
    .run(now, now);
  db.prepare(`INSERT INTO video_generations
    (provider, prompt, status, local_path, user_id, tenant_id, created_at, updated_at)
    VALUES ('test', 'team', 'completed', 'library/videos/team.mp4', NULL, 'team-1', ?, ?)`)
    .run(now, now);
  db.prepare(`INSERT INTO image_generations
    (provider, prompt, status, local_path, user_id, tenant_id, created_at, updated_at)
    VALUES ('test', 'other', 'completed', 'library/images/other.jpg', 'user-2', NULL, ?, ?)`)
    .run(now, now);

  const middleware = createStaticOwnershipMiddleware({ db, enabled: true, secret: SECRET });
  const ownedRes = response();
  let called = false;
  middleware({
    path: '/library/images/owned.jpg',
    query: {},
    get(name) {
      if (name === 'authorization') return '';
      if (name === 'cookie') return `other=value; moli_media_session=${encodeURIComponent(token)}`;
      return '';
    },
  }, ownedRes, () => { called = true; });
  assert.equal(called, true);

  const teamRes = response();
  let teamCalled = false;
  middleware({
    path: '/library/videos/team.mp4',
    query: {},
    get(name) {
      return name === 'cookie' ? `moli_media_session=${encodeURIComponent(token)}` : '';
    },
  }, teamRes, () => { teamCalled = true; });
  assert.equal(teamCalled, true);

  const otherRes = response();
  middleware({
    path: '/library/images/other.jpg',
    query: {},
    get(name) {
      return name === 'cookie' ? `moli_media_session=${encodeURIComponent(token)}` : '';
    },
  }, otherRes, () => {});
  assert.equal(otherRes.statusCode, 404);
});

test('公开模式登录后只放行受控目录内的套餐广告图', async () => {
  const { db } = setup();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-recharge-static-'));
  const packageDir = path.join(tempRoot, 'uploads', 'recharge-packages');
  const adjacentDir = path.join(tempRoot, 'uploads', 'other');
  let server;
  try {
    fs.mkdirSync(packageDir, { recursive: true });
    fs.mkdirSync(adjacentDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'valid.webp'), Buffer.from('524946460400000057454250', 'hex'));
    fs.writeFileSync(path.join(packageDir, 'blocked.gif'), Buffer.from('GIF89a', 'ascii'));
    fs.writeFileSync(path.join(packageDir, 'blocked.html'), '<html>blocked</html>');
    fs.writeFileSync(path.join(adjacentDir, 'valid.webp'), Buffer.from('524946460400000057454250', 'hex'));

    const app = express();
    app.use('/static', createStaticOwnershipMiddleware({ db, enabled: true, secret: SECRET }), express.static(tempRoot));
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const token = auth.issueToken({ id: 'user-1', email: 'one@example.com', role: 'user' }, SECRET);
    const authorized = { headers: { authorization: `Bearer ${token}` } };

    const malformedPath = response();
    let malformedPathAllowed = false;
    createStaticOwnershipMiddleware({ db, enabled: true, secret: SECRET })({
      path: '//uploads/recharge-packages/valid.webp',
      get(name) { return name === 'authorization' ? `Bearer ${token}` : ''; },
    }, malformedPath, () => { malformedPathAllowed = true; });
    assert.equal(malformedPathAllowed, false);
    assert.equal(malformedPath.statusCode, 404);

    const allowed = await fetch(`${baseUrl}/static/uploads/recharge-packages/valid.webp`, authorized);
    assert.equal(allowed.status, 200);
    assert.deepEqual(Buffer.from(await allowed.arrayBuffer()), Buffer.from('524946460400000057454250', 'hex'));

    assert.equal((await fetch(`${baseUrl}/static/uploads/recharge-packages/valid.webp`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/static/uploads/other/valid.webp`, authorized)).status, 404);
    assert.equal((await fetch(`${baseUrl}/static/uploads/recharge-packages/%252e%252e%252fother%252fvalid.webp`, authorized)).status, 404);
    assert.equal((await fetch(`${baseUrl}/static/uploads/recharge-packages/blocked.gif`, authorized)).status, 404);
    assert.equal((await fetch(`${baseUrl}/static/uploads/recharge-packages/blocked.html`, authorized)).status, 404);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
