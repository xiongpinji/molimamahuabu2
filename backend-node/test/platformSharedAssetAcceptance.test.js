'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { setupRouter } = require('../src/routes');
const { createStaticOwnershipMiddleware } = require('../src/middleware/resourceOwnership');
const { signProviderAssetUrl } = require('../src/services/providerAssetUrlService');

const JWT_SECRET = 'shared-foundation-asset-secret-123456789';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const MP4 = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
const MP3 = Buffer.from('49443304000000000000', 'hex');
const log = { info() {}, warn() {}, error() {}, errorw() {} };

async function startServer(db, storageRoot) {
  const app = express();
  app.use(express.json());
  app.use('/static', createStaticOwnershipMiddleware({
    db,
    enabled: true,
    secret: JWT_SECRET,
    storageRoot,
  }), express.static(storageRoot));
  app.use('/api/v1', setupRouter({
    storage: { local_path: storageRoot, base_url: '' },
  }, db, log));
  const server = await new Promise((resolve) => {
    const running = app.listen(0, '127.0.0.1', () => resolve(running));
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}/api/v1${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  return { response, body: await response.json().catch(() => null) };
}

async function register(baseUrl, email) {
  const result = await jsonRequest(baseUrl, '/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'correct horse battery staple' }),
  });
  assert.equal(result.response.status, 201);
  return result.body.data;
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

function insertDrama(db, userId, title) {
  const tenant = db.prepare(`SELECT tenant_id FROM tenant_members
    WHERE user_id = ? AND status = 'active' ORDER BY created_at LIMIT 1`).get(userId);
  assert.ok(tenant?.tenant_id);
  const now = new Date().toISOString();
  return Number(db.prepare(`INSERT INTO dramas
      (tenant_id, user_id, title, status, created_at, updated_at)
    VALUES (?, ?, ?, 'draft', ?, ?)`)
    .run(tenant.tenant_id, userId, title, now, now).lastInsertRowid);
}

async function upload(baseUrl, token, dramaId, filename, type, content) {
  const form = new FormData();
  form.append('drama_id', String(dramaId));
  form.append('file', new Blob([content], { type }), filename);
  const response = await fetch(`${baseUrl}/api/v1/upload/media`, {
    method: 'POST',
    headers: bearer(token),
    body: form,
  });
  return { response, body: await response.json() };
}

test('素材上传、租户读取、签名下载、删除与数据库重开形成完整安全闭环', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-shared-assets-'));
  const storageRoot = path.join(tempRoot, 'storage');
  const dbPath = path.join(tempRoot, 'assets.db');
  fs.mkdirSync(storageRoot, { recursive: true });
  const previous = {
    PUBLIC_PLATFORM_MODE: process.env.PUBLIC_PLATFORM_MODE,
    PLATFORM_REGISTRATION_ENABLED: process.env.PLATFORM_REGISTRATION_ENABLED,
    PLATFORM_EMAIL_VERIFICATION_ENABLED: process.env.PLATFORM_EMAIL_VERIFICATION_ENABLED,
    PLATFORM_JWT_SECRET: process.env.PLATFORM_JWT_SECRET,
  };
  process.env.PUBLIC_PLATFORM_MODE = 'true';
  process.env.PLATFORM_REGISTRATION_ENABLED = 'true';
  process.env.PLATFORM_EMAIL_VERIFICATION_ENABLED = 'false';
  process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
  let db = new Database(dbPath);
  let server;

  try {
    runMigrationsAndEnsure(db);
    server = await startServer(db, storageRoot);
    const owner = await register(server.baseUrl, 'asset-owner@example.com');
    const outsider = await register(server.baseUrl, 'asset-outsider@example.com');
    const dramaId = insertDrama(db, owner.user.id, '素材验收项目');
    const foreignDramaId = insertDrama(db, outsider.user.id, '其他租户项目');

    const fixtures = [
      ['角色.png', 'image/png', PNG, 'image', '89504e470d0a1a0a'],
      ['镜头.mp4', 'video/mp4', MP4, 'video', '0000001866747970'],
      ['配音.mp3', 'audio/mpeg', MP3, 'audio', '49443304'],
    ];
    const uploaded = [];
    for (const [filename, mime, bytes, expectedType, magic] of fixtures) {
      const result = await upload(server.baseUrl, owner.token, dramaId, filename, mime, bytes);
      assert.equal(result.response.status, 201);
      assert.equal(result.body.data.type, expectedType);
      const file = path.join(storageRoot, result.body.data.local_path);
      assert.equal(fs.readFileSync(file).subarray(0, magic.length / 2).toString('hex'), magic);
      uploaded.push(result.body.data);
    }

    const list = await jsonRequest(server.baseUrl, `/assets?drama_id=${dramaId}`, {
      headers: bearer(owner.token),
    });
    assert.equal(list.response.status, 200);
    assert.equal(list.body.data.items.length, 3);
    assert.equal((await jsonRequest(server.baseUrl, `/assets?drama_id=${dramaId}`, {
      headers: bearer(outsider.token),
    })).response.status, 404);

    const imageUrl = `${server.baseUrl}/static/${uploaded[0].local_path}`;
    const imageRead = await fetch(imageUrl, { headers: bearer(owner.token) });
    assert.equal(imageRead.status, 200);
    assert.deepEqual(Buffer.from(await imageRead.arrayBuffer()), PNG);
    assert.equal((await fetch(imageUrl, { headers: bearer(outsider.token) })).status, 404);
    assert.equal((await fetch(imageUrl)).status, 401);

    const signed = signProviderAssetUrl(imageUrl, {
      filesBaseUrl: `${server.baseUrl}/static`,
      secret: JWT_SECRET,
      ttlSeconds: 60,
    });
    assert.equal((await fetch(signed)).status, 200);
    const tampered = new URL(signed);
    tampered.searchParams.set('provider_asset_signature', 'A'.repeat(43));
    assert.equal((await fetch(tampered)).status, 401);
    const expired = signProviderAssetUrl(imageUrl, {
      filesBaseUrl: `${server.baseUrl}/static`,
      secret: JWT_SECRET,
      now: Date.now() - 61_000,
      ttlSeconds: 60,
    });
    assert.equal((await fetch(expired)).status, 401);

    const duplicate = await jsonRequest(server.baseUrl, '/assets', {
      method: 'POST',
      headers: bearer(owner.token),
      body: JSON.stringify({
        drama_id: dramaId,
        name: '派生记录',
        type: 'image',
        url: uploaded[0].url,
        local_path: uploaded[0].local_path,
      }),
    });
    assert.equal(duplicate.response.status, 201);
    const deleted = await jsonRequest(server.baseUrl, `/assets/${uploaded[0].id}`, {
      method: 'DELETE',
      headers: bearer(owner.token),
    });
    assert.equal(deleted.response.status, 200);
    assert.equal(fs.existsSync(path.join(storageRoot, uploaded[0].local_path)), true);
    assert.equal((await jsonRequest(server.baseUrl, `/assets/${duplicate.body.data.id}`, {
      headers: bearer(owner.token),
    })).response.status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM assets WHERE drama_id = ? AND deleted_at IS NULL')
      .get(foreignDramaId).total, 0);

    await server.close();
    server = null;
    db.close();
    db = new Database(dbPath);
    server = await startServer(db, storageRoot);
    const restored = await jsonRequest(server.baseUrl, `/assets?drama_id=${dramaId}`, {
      headers: bearer(owner.token),
    });
    assert.equal(restored.response.status, 200);
    assert.equal(restored.body.data.items.length, 3);
    assert.equal((await fetch(`${server.baseUrl}/static/${uploaded[1].local_path}`, {
      headers: bearer(owner.token),
    })).status, 200);
  } finally {
    if (server) await server.close();
    if (db.open) db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('普通与签名静态路径均拒绝 Junction 或符号链接逃逸存储根', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-shared-asset-escape-'));
  const storageRoot = path.join(tempRoot, 'storage');
  const outsideRoot = path.join(tempRoot, 'outside');
  fs.mkdirSync(storageRoot, { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });
  fs.writeFileSync(path.join(outsideRoot, 'secret.png'), PNG);
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const previous = {
    PUBLIC_PLATFORM_MODE: process.env.PUBLIC_PLATFORM_MODE,
    PLATFORM_REGISTRATION_ENABLED: process.env.PLATFORM_REGISTRATION_ENABLED,
    PLATFORM_EMAIL_VERIFICATION_ENABLED: process.env.PLATFORM_EMAIL_VERIFICATION_ENABLED,
    PLATFORM_JWT_SECRET: process.env.PLATFORM_JWT_SECRET,
  };
  process.env.PUBLIC_PLATFORM_MODE = 'true';
  process.env.PLATFORM_REGISTRATION_ENABLED = 'true';
  process.env.PLATFORM_EMAIL_VERIFICATION_ENABLED = 'false';
  process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
  const server = await startServer(db, storageRoot);
  t.after(async () => {
    await server.close();
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const owner = await register(server.baseUrl, 'asset-link-owner@example.com');
  const dramaId = insertDrama(db, owner.user.id, '路径逃逸项目');
  const projectDir = path.join(storageRoot, `projects/${String(dramaId).padStart(4, '0')}_20260822_escape`);
  fs.mkdirSync(projectDir, { recursive: true });
  const linkPath = path.join(projectDir, 'linked');
  try {
    fs.symlinkSync(outsideRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    assert.fail(`当前平台无法创建逃逸测试链接: ${error.message}`);
  }
  assert.equal(fs.realpathSync(path.join(linkPath, 'secret.png')), path.join(outsideRoot, 'secret.png'));
  const escapedUrl = `${server.baseUrl}/static/${path.relative(storageRoot, linkPath)
    .replaceAll('\\', '/')}/secret.png`;

  assert.equal((await fetch(escapedUrl, { headers: bearer(owner.token) })).status, 404);
  const signed = signProviderAssetUrl(escapedUrl, {
    filesBaseUrl: `${server.baseUrl}/static`,
    secret: JWT_SECRET,
    ttlSeconds: 60,
  });
  assert.equal((await fetch(signed)).status, 404);
  for (const suffix of ['../outside/secret.png', '%2e%2e/outside/secret.png', 'C:%5Coutside%5Csecret.png']) {
    assert.notEqual((await fetch(`${server.baseUrl}/static/${suffix}`, {
      headers: bearer(owner.token),
      redirect: 'manual',
    })).status, 200);
  }
});
