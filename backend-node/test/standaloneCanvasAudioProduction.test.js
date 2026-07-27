const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');

const createAudioRoutes = require('../src/routes/audio');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { createStaticOwnershipMiddleware } = require('../src/middleware/resourceOwnership');
const userAuth = require('../src/services/userAuthService');
const { isProbableMp3 } = require('../src/services/ttsService');
const validMp3Bytes = require('./fixtures/minimalMp3');

function listen(server) {
  return new Promise((resolve, reject) => {
    const running = server.listen(0, '127.0.0.1', () => resolve(running));
    running.once('error', reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function createResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function insertUser(db, id, email) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO platform_users
    (id, email, password_hash, password_salt, role, status, token_version, created_at, updated_at)
    VALUES (?, ?, 'hash', 'salt', 'user', 'active', 0, ?, ?)`).run(id, email, now, now);
}

function insertTenant(db, id, userId) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO tenants
    (id, name, slug, status, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?, ?)`).run(id, id, id, userId, now, now);
  db.prepare(`INSERT INTO tenant_members
    (tenant_id, user_id, role, status, created_at, updated_at)
    VALUES (?, ?, 'owner', 'active', ?, ?)`).run(id, userId, now, now);
}

function insertDrama(db, tenantId, userId, title) {
  const now = new Date().toISOString();
  return Number(db.prepare(`INSERT INTO dramas
    (tenant_id, user_id, title, style, status, metadata, created_at, updated_at)
    VALUES (?, ?, ?, 'realistic', 'draft', '{}', ?, ?)`)
    .run(tenantId, userId, title, now, now).lastInsertRowid);
}

function insertTtsConfig(db, baseUrl, model = 'tts-canvas', defaultModel = model) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, name, base_url, api_key, model, default_model,
     is_default, is_active, settings, created_at, updated_at)
    VALUES ('tts', 'openai', '画布 TTS', ?, 'test-key', ?, ?, 1, 1, '{}', ?, ?)`)
    .run(baseUrl, JSON.stringify([model]), defaultModel, now, now);
}

function setPriceAndBalance(db, tenantId, model, price, available) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO model_credit_prices
    (model, display_name, category, credits, status, updated_at)
    VALUES (?, ?, 'audio', ?, 'enabled', ?)`).run(model, model, price, now);
  db.prepare(`INSERT INTO tenant_credit_accounts
    (tenant_id, available, held, spent, updated_at)
    VALUES (?, ?, 0, 0, ?)`).run(tenantId, available, now);
}

function makeRequest(body, userId = 'user-a', tenantId = 'tenant-a') {
  return {
    body,
    user: { id: userId },
    tenant: { id: tenantId },
  };
}

function insertStoryboard(db, dramaId, dialogue, audioLocalPath = null) {
  const now = new Date().toISOString();
  const episodeId = Number(db.prepare(`INSERT INTO episodes
    (drama_id, episode_number, title, status, created_at, updated_at)
    VALUES (?, 1, '第 1 集', 'draft', ?, ?)`).run(dramaId, now, now).lastInsertRowid);
  return Number(db.prepare(`INSERT INTO storyboards
    (episode_id, storyboard_number, title, dialogue, audio_local_path, status, created_at, updated_at)
    VALUES (?, 1, '镜头 1', ?, ?, 'draft', ?, ?)`)
    .run(episodeId, dialogue, audioLocalPath, now, now).lastInsertRowid);
}

function listMp3Files(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => entry.endsWith('.mp3'));
}

test('MP3 校验要求完整 ID3v2 标签和至少一个完整 MPEG 音频帧', () => {
  assert.equal(isProbableMp3(validMp3Bytes), true);
  assert.equal(isProbableMp3(validMp3Bytes.subarray(45)), true);
  assert.equal(isProbableMp3(validMp3Bytes.subarray(0, 8)), false);
  assert.equal(isProbableMp3(Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00])), false);
  assert.equal(isProbableMp3(validMp3Bytes.subarray(45, 49)), false);
  assert.equal(isProbableMp3(validMp3Bytes.subarray(45, 188)), false);
  assert.equal(isProbableMp3(validMp3Bytes.subarray(45, 189)), true);
  assert.equal(isProbableMp3(Buffer.from('{"error":"not audio"}')), false);
  assert.equal(isProbableMp3(Buffer.from('<html>not audio</html>')), false);
  assert.equal(isProbableMp3(Buffer.from([0xff, 0xe8, 0x90, 0x00])), false);
});

test('自由画布音频按项目目录保存、确认计费并可经授权静态地址回读', async (t) => {
  const provider = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.end(validMp3Bytes);
  });
  const providerServer = await listen(provider);
  t.after(() => close(providerServer));

  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-audio-success-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  insertUser(db, 'user-a', 'a@example.com');
  insertUser(db, 'user-b', 'b@example.com');
  insertTenant(db, 'tenant-a', 'user-a');
  insertTenant(db, 'tenant-b', 'user-b');
  const dramaId = insertDrama(db, 'tenant-a', 'user-a', '自由画布');
  insertTtsConfig(db, `http://127.0.0.1:${providerServer.address().port}`, 'tts-canvas');
  setPriceAndBalance(db, 'tenant-a', 'tts-canvas', 7, 20);

  const routes = createAudioRoutes(db, { info() {}, error() {} }, {
    storage: { local_path: storageRoot },
  }, { billingEnabled: true });
  const res = createResponse();
  await routes.extract(makeRequest({
    drama_id: dramaId,
    text: '小茉：欢迎回来',
    tts_model: 'tts-canvas',
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.model, 'tts-canvas');
  assert.match(res.body.data.local_path, new RegExp(`^projects/${String(dramaId).padStart(4, '0')}_\\d{8}_自由画布/audio/tts_`));
  assert.equal(res.body.data.url, `/static/${res.body.data.local_path}`);
  assert.deepEqual(fs.readFileSync(path.join(storageRoot, res.body.data.local_path)), validMp3Bytes);
  assert.deepEqual(
    db.prepare('SELECT available, held, spent FROM tenant_credit_accounts WHERE tenant_id = ?').get('tenant-a'),
    { available: 13, held: 0, spent: 7 },
  );
  assert.equal(
    db.prepare("SELECT status FROM tenant_usage_reservations WHERE tenant_id = 'tenant-a'").get().status,
    'confirmed',
  );
  assert.deepEqual(
    db.prepare("SELECT event_type FROM audit_events WHERE tenant_id = 'tenant-a' ORDER BY rowid").all()
      .map((row) => row.event_type),
    ['generation.audio.created', 'generation.audio.completed'],
  );

  const secret = 'static-test-secret-at-least-32-characters';
  const token = userAuth.issueToken({ id: 'user-a', email: 'a@example.com', role: 'user' }, secret);
  const staticApp = express();
  staticApp.use('/static', createStaticOwnershipMiddleware({
    db,
    enabled: true,
    secret,
  }), express.static(storageRoot));
  const staticServer = await listen(staticApp);
  t.after(() => close(staticServer));
  const audioResponse = await fetch(
    `http://127.0.0.1:${staticServer.address().port}${res.body.data.url}`,
    { headers: { authorization: `Bearer ${token}`, 'x-tenant-id': 'tenant-a' } },
  );
  assert.equal(audioResponse.status, 200);
  assert.deepEqual(Buffer.from(await audioResponse.arrayBuffer()), validMp3Bytes);

  const otherToken = userAuth.issueToken({ id: 'user-b', email: 'b@example.com', role: 'user' }, secret);
  const forbiddenResponse = await fetch(
    `http://127.0.0.1:${staticServer.address().port}${res.body.data.url}`,
    { headers: { authorization: `Bearer ${otherToken}`, 'x-tenant-id': 'tenant-b' } },
  );
  assert.equal(forbiddenResponse.status, 404);
});

test('未设置 default_model 时按实际首个模型调用并计费', async (t) => {
  let providerModel = null;
  const provider = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      providerModel = JSON.parse(Buffer.concat(chunks).toString()).model;
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(validMp3Bytes);
    });
  });
  const providerServer = await listen(provider);
  t.after(() => close(providerServer));

  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-audio-model-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  insertUser(db, 'user-a', 'a@example.com');
  insertTenant(db, 'tenant-a', 'user-a');
  const dramaId = insertDrama(db, 'tenant-a', 'user-a', '模型项目');
  insertTtsConfig(db, `http://127.0.0.1:${providerServer.address().port}`, 'tts-array-first', '');
  setPriceAndBalance(db, 'tenant-a', 'tts-array-first', 6, 20);

  const routes = createAudioRoutes(db, { info() {}, error() {} }, {
    storage: { local_path: storageRoot },
  }, { billingEnabled: true });
  const res = createResponse();
  await routes.extract(makeRequest({
    drama_id: dramaId,
    text: '使用模型数组首项',
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.model, 'tts-array-first');
  assert.equal(providerModel, 'tts-array-first');
  assert.equal(
    db.prepare("SELECT model FROM tenant_usage_reservations WHERE tenant_id = 'tenant-a'").get().model,
    'tts-array-first',
  );
});

test('公开计费模式拒绝无价格、余额不足和跨租户项目', async (t) => {
  let providerCalls = 0;
  const provider = http.createServer((_req, res) => {
    providerCalls += 1;
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.end(Buffer.from('should-not-run'));
  });
  const providerServer = await listen(provider);
  t.after(() => close(providerServer));

  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-audio-reject-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  insertUser(db, 'user-a', 'a@example.com');
  insertUser(db, 'user-b', 'b@example.com');
  insertTenant(db, 'tenant-a', 'user-a');
  insertTenant(db, 'tenant-b', 'user-b');
  const dramaId = insertDrama(db, 'tenant-a', 'user-a', 'A 项目');
  insertTtsConfig(db, `http://127.0.0.1:${providerServer.address().port}`, 'tts-canvas');
  const routes = createAudioRoutes(db, { info() {}, error() {} }, {
    storage: { local_path: storageRoot },
  }, { billingEnabled: true });

  const missingPrice = createResponse();
  await routes.extract(makeRequest({
    drama_id: dramaId,
    text: '无价格',
    tts_model: 'tts-canvas',
  }), missingPrice);
  assert.equal(missingPrice.statusCode, 503);
  assert.equal(missingPrice.body.error.code, 'MODEL_PRICE_NOT_CONFIGURED');

  setPriceAndBalance(db, 'tenant-a', 'tts-canvas', 7, 3);
  const insufficient = createResponse();
  await routes.extract(makeRequest({
    drama_id: dramaId,
    text: '余额不足',
    tts_model: 'tts-canvas',
  }), insufficient);
  assert.equal(insufficient.statusCode, 402);
  assert.equal(insufficient.body.error.code, 'INSUFFICIENT_CREDITS');

  const crossTenant = createResponse();
  await routes.extract(makeRequest({
    drama_id: dramaId,
    text: '越权请求',
    tts_model: 'tts-canvas',
  }, 'user-b', 'tenant-b'), crossTenant);
  assert.equal(crossTenant.statusCode, 404);
  assert.equal(crossTenant.body.error.code, 'NOT_FOUND');
  assert.equal(providerCalls, 0);
});

test('公开模式拒绝当前项目之外的 storyboard 且不读取或回写', async (t) => {
  let providerCalls = 0;
  const provider = http.createServer((_req, res) => {
    providerCalls += 1;
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.end(Buffer.from('should-not-run'));
  });
  const providerServer = await listen(provider);
  t.after(() => close(providerServer));

  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-audio-storyboard-owner-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  insertUser(db, 'user-a', 'a@example.com');
  insertUser(db, 'user-b', 'b@example.com');
  insertTenant(db, 'tenant-a', 'user-a');
  insertTenant(db, 'tenant-b', 'user-b');
  const ownDramaId = insertDrama(db, 'tenant-a', 'user-a', 'A 项目');
  const foreignDramaId = insertDrama(db, 'tenant-b', 'user-b', 'B 项目');
  const foreignStoryboardId = insertStoryboard(
    db,
    foreignDramaId,
    'B 项目的秘密对白',
    'projects/original/audio/unchanged.mp3',
  );
  insertTtsConfig(db, `http://127.0.0.1:${providerServer.address().port}`, 'tts-canvas');
  setPriceAndBalance(db, 'tenant-a', 'tts-canvas', 7, 20);
  const routes = createAudioRoutes(db, { info() {}, error() {} }, {
    storage: { local_path: storageRoot },
  }, { billingEnabled: true });

  const before = db.prepare(
    'SELECT dialogue, audio_local_path, audio_model, updated_at FROM storyboards WHERE id = ?',
  ).get(foreignStoryboardId);
  const res = createResponse();
  await routes.extract(makeRequest({
    drama_id: ownDramaId,
    storyboard_id: foreignStoryboardId,
  }), res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error.code, 'NOT_FOUND');
  assert.equal(providerCalls, 0);
  assert.deepEqual(
    db.prepare('SELECT dialogue, audio_local_path, audio_model, updated_at FROM storyboards WHERE id = ?')
      .get(foreignStoryboardId),
    before,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE tenant_id = 'tenant-a'").get().count,
    0,
  );
});

test('TTS 供应商返回空音频时不落盘、不扣费并退款', async (t) => {
  const provider = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.end();
  });
  const providerServer = await listen(provider);
  t.after(() => close(providerServer));

  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-audio-empty-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  insertUser(db, 'user-a', 'a@example.com');
  insertTenant(db, 'tenant-a', 'user-a');
  const dramaId = insertDrama(db, 'tenant-a', 'user-a', '空音频项目');
  insertTtsConfig(db, `http://127.0.0.1:${providerServer.address().port}`, 'tts-canvas');
  setPriceAndBalance(db, 'tenant-a', 'tts-canvas', 7, 20);
  const routes = createAudioRoutes(db, { info() {}, error() {} }, {
    storage: { local_path: storageRoot },
  }, { billingEnabled: true });

  const res = createResponse();
  await routes.extract(makeRequest({
    drama_id: dramaId,
    text: '供应商返回空音频',
    tts_model: 'tts-canvas',
  }), res);

  assert.equal(res.statusCode, 500);
  assert.equal(listMp3Files(storageRoot).length, 0);
  assert.deepEqual(
    db.prepare('SELECT available, held, spent FROM tenant_credit_accounts WHERE tenant_id = ?').get('tenant-a'),
    { available: 20, held: 0, spent: 0 },
  );
  assert.equal(
    db.prepare("SELECT status FROM tenant_usage_reservations WHERE tenant_id = 'tenant-a'").get().status,
    'refunded',
  );
});

for (const scenario of [
  {
    name: 'JSON',
    contentType: 'application/json',
    payload: Buffer.from(JSON.stringify({ error: 'provider returned JSON with HTTP 200' })),
  },
  {
    name: '垃圾字节',
    contentType: 'application/octet-stream',
    payload: Buffer.from([0x01, 0x02, 0x03, 0x04]),
  },
  {
    name: '截断 MP3',
    contentType: 'audio/mpeg',
    payload: validMp3Bytes.subarray(0, 100),
  },
]) {
  test(`TTS 供应商 HTTP 200 返回非空${scenario.name}时失败、退款并记录审计`, async (t) => {
    const provider = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': scenario.contentType });
      res.end(scenario.payload);
    });
    const providerServer = await listen(provider);
    t.after(() => close(providerServer));

    const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-audio-invalid-'));
    t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
    const db = new Database(':memory:');
    t.after(() => db.close());
    runMigrationsAndEnsure(db);
    insertUser(db, 'user-a', 'a@example.com');
    insertTenant(db, 'tenant-a', 'user-a');
    const dramaId = insertDrama(db, 'tenant-a', 'user-a', `无效${scenario.name}项目`);
    insertTtsConfig(db, `http://127.0.0.1:${providerServer.address().port}`, 'tts-canvas');
    setPriceAndBalance(db, 'tenant-a', 'tts-canvas', 7, 20);
    const routes = createAudioRoutes(db, { info() {}, error() {} }, {
      storage: { local_path: storageRoot },
    }, { billingEnabled: true });

    const res = createResponse();
    await routes.extract(makeRequest({
      drama_id: dramaId,
      text: `供应商返回非音频${scenario.name}`,
      tts_model: 'tts-canvas',
    }), res);

    assert.equal(res.statusCode, 500);
    assert.equal(listMp3Files(storageRoot).length, 0);
    assert.deepEqual(
      db.prepare('SELECT available, held, spent FROM tenant_credit_accounts WHERE tenant_id = ?').get('tenant-a'),
      { available: 20, held: 0, spent: 0 },
    );
    assert.equal(
      db.prepare("SELECT status FROM tenant_usage_reservations WHERE tenant_id = 'tenant-a'").get().status,
      'refunded',
    );
    assert.deepEqual(
      db.prepare("SELECT event_type, outcome FROM audit_events WHERE tenant_id = 'tenant-a' ORDER BY rowid").all(),
      [
        { event_type: 'generation.audio.created', outcome: 'success' },
        { event_type: 'generation.audio.failed', outcome: 'failed' },
      ],
    );
  });
}

test('TTS 供应商失败后退款并记录失败审计', async (t) => {
  const provider = http.createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'provider failed' } }));
  });
  const providerServer = await listen(provider);
  t.after(() => close(providerServer));

  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-audio-refund-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  insertUser(db, 'user-a', 'a@example.com');
  insertTenant(db, 'tenant-a', 'user-a');
  const dramaId = insertDrama(db, 'tenant-a', 'user-a', '退款项目');
  insertTtsConfig(db, `http://127.0.0.1:${providerServer.address().port}`, 'tts-canvas');
  setPriceAndBalance(db, 'tenant-a', 'tts-canvas', 7, 20);
  const routes = createAudioRoutes(db, { info() {}, error() {} }, {
    storage: { local_path: storageRoot },
  }, { billingEnabled: true });

  const res = createResponse();
  await routes.extract(makeRequest({
    drama_id: dramaId,
    text: '触发供应商失败',
    tts_model: 'tts-canvas',
  }), res);

  assert.equal(res.statusCode, 500);
  assert.deepEqual(
    db.prepare('SELECT available, held, spent FROM tenant_credit_accounts WHERE tenant_id = ?').get('tenant-a'),
    { available: 20, held: 0, spent: 0 },
  );
  assert.equal(
    db.prepare("SELECT status FROM tenant_usage_reservations WHERE tenant_id = 'tenant-a'").get().status,
    'refunded',
  );
  assert.deepEqual(
    db.prepare("SELECT event_type, outcome FROM audit_events WHERE tenant_id = 'tenant-a' ORDER BY rowid").all(),
    [
      { event_type: 'generation.audio.created', outcome: 'success' },
      { event_type: 'generation.audio.failed', outcome: 'failed' },
    ],
  );
});
