const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const uploadModule = require('../src/routes/upload');

function captureResponse() {
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

function insertDrama(db, tenantId, userId, title) {
  const now = new Date().toISOString();
  return Number(db.prepare(
    `INSERT INTO dramas (tenant_id, user_id, title, status, created_at, updated_at)
     VALUES (?, ?, ?, 'draft', ?, ?)`,
  ).run(tenantId, userId, title, now, now).lastInsertRowid);
}

test('三维资源上传会落盘并注册项目资产记录', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-model-'));
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    const now = new Date().toISOString();
    const dramaId = db.prepare(
      `INSERT INTO dramas (title, status, created_at, updated_at) VALUES ('资产上传测试', 'draft', ?, ?)`,
    ).run(now, now).lastInsertRowid;
    const handlers = uploadModule.routes({
      storage: { local_path: tempRoot, base_url: 'http://localhost:5679/static' },
    }, { info() {}, warn() {}, error() {} }, db);
    const response = captureResponse();
    const file = {
      buffer: Buffer.from('glb-fixture'),
      originalname: 'hero.glb',
      mimetype: 'model/gltf-binary',
      size: 11,
    };

    handlers.uploadModel({ body: { drama_id: String(dramaId) }, file }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.data.asset_id > 0, true);
    assert.match(response.body.data.url, /\.glb$/);
    assert.equal(response.body.data.filename, 'hero.glb');
    assert.equal(fs.existsSync(path.join(tempRoot, response.body.data.local_path)), true);
    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(response.body.data.asset_id);
    assert.equal(asset.drama_id, dramaId);
    assert.equal(asset.type, 'model');
    assert.equal(asset.category, 'director');
    assert.equal(asset.local_path, response.body.data.local_path);
  } finally {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('素材库媒体上传必须绑定自有项目，并注册项目素材记录', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-media-'));
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    const ownDramaId = insertDrama(db, 'tenant-a', 'user-a', '自己的项目');
    const foreignDramaId = insertDrama(db, 'tenant-b', 'user-b', '其他项目');
    const handlers = uploadModule.routes({
      storage: { local_path: tempRoot, base_url: 'http://localhost:5679/static' },
    }, { info() {}, warn() {}, error() {} }, db);
    const file = {
      buffer: Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex'),
      originalname: 'clip.mp4',
      mimetype: 'video/mp4',
      size: 24,
    };

    const missingDrama = captureResponse();
    handlers.uploadMedia({ body: {}, file }, missingDrama);
    assert.equal(missingDrama.statusCode, 400);

    const foreign = captureResponse();
    handlers.uploadMedia({
      body: { drama_id: String(foreignDramaId) },
      user: { id: 'user-a' },
      tenant: { id: 'tenant-a' },
      file,
    }, foreign);
    assert.equal(foreign.statusCode, 404);

    const own = captureResponse();
    handlers.uploadMedia({
      body: { drama_id: String(ownDramaId) },
      user: { id: 'user-a' },
      tenant: { id: 'tenant-a' },
      file,
    }, own);

    assert.equal(own.statusCode, 201);
    assert.equal(own.body.success, true);
    assert.equal(own.body.data.type, 'video');
    assert.equal(own.body.data.id > 0, true);
    assert.match(own.body.data.url, /\.mp4$/);
    assert.equal(fs.existsSync(path.join(tempRoot, own.body.data.local_path)), true);
    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(own.body.data.id);
    assert.equal(asset.drama_id, ownDramaId);
    assert.equal(asset.type, 'video');
    assert.equal(asset.category, 'library');
    assert.equal(asset.local_path, own.body.data.local_path);
    assert.equal(asset.mime_type, 'video/mp4');
  } finally {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
