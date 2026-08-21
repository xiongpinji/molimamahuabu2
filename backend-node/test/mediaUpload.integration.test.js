const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const uploadRoutes = require('../src/routes/upload');

const log = { info() {}, warn() {}, error() {} };
const MINIMAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const MINIMAL_MP4 = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
const MINIMAL_M4A = Buffer.from('00000018667479704d344120000000004d3441206d703432', 'hex');

function insertDrama(db, { tenantId, userId, title }) {
  const now = new Date().toISOString();
  return db.prepare(
    `INSERT INTO dramas (tenant_id, user_id, title, status, created_at, updated_at)
     VALUES (?, ?, ?, 'draft', ?, ?)`,
  ).run(tenantId, userId, title, now, now).lastInsertRowid;
}

async function startUploadServer(handlers) {
  const app = express();
  app.post(
    '/upload/media',
    (req, _res, next) => {
      if (req.headers['x-test-anonymous'] !== '1') {
        req.user = { id: 'user-a' };
        req.tenant = { id: 'tenant-a', role: 'owner' };
      }
      next();
    },
    handlers.multerMediaSingle,
    handlers.uploadMedia,
  );
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/upload/media`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function upload(url, { dramaId, filename, type, content, anonymous = false }) {
  const form = new FormData();
  if (dramaId != null) form.append('drama_id', String(dramaId));
  form.append('file', new Blob([content], { type }), filename);
  const response = await fetch(url, {
    method: 'POST',
    body: form,
    headers: anonymous ? { 'x-test-anonymous': '1' } : undefined,
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    return entry.isDirectory() ? listFiles(absolute) : [absolute];
  }).sort();
}

test('素材签名识别覆盖上传白名单并拒绝声明不一致', () => {
  const fixtures = [
    ['png', 'image/png', 'a.png', MINIMAL_PNG],
    ['jpeg', 'image/jpeg', 'a.jpg', Buffer.from('ffd8ffe000104a46494600', 'hex')],
    ['gif', 'image/gif', 'a.gif', Buffer.from('GIF89a', 'ascii')],
    ['webp', 'image/webp', 'a.webp', Buffer.from('524946460c0000005745425056503820', 'hex')],
    ['mp4', 'video/mp4', 'a.mp4', MINIMAL_MP4],
    ['mov', 'video/quicktime', 'a.mov', Buffer.from('0000001466747970717420200000000071742020', 'hex')],
    ['m4a', 'audio/mp4', 'a.m4a', MINIMAL_M4A],
    ['webm', 'video/webm', 'a.webm', Buffer.from('1a45dfa39f4286810142f781014282847765626d', 'hex')],
    ['wav', 'audio/wav', 'a.wav', Buffer.from('524946462400000057415645666d7420', 'hex')],
    ['mp3', 'audio/mpeg', 'a.mp3', Buffer.from('49443304000000000000', 'hex')],
    ['ogg', 'audio/ogg', 'a.ogg', Buffer.from('4f67675300020000000000000000', 'hex')],
    ['flac', 'audio/flac', 'a.flac', Buffer.from('664c614300000022', 'hex')],
    ['aac', 'audio/aac', 'a.aac', Buffer.from('fff15080001ffc', 'hex')],
  ];

  for (const [family, mimeType, filename, buffer] of fixtures) {
    assert.equal(uploadRoutes.identifyMediaUpload(buffer, mimeType, filename).family, family);
  }
  assert.equal(uploadRoutes.identifyMediaUpload(Buffer.from('not-an-image'), 'image/png', 'evil.html'), null);
  assert.equal(uploadRoutes.identifyMediaUpload(MINIMAL_PNG, 'image/jpeg', 'a.jpg'), null);
  assert.equal(uploadRoutes.identifyMediaUpload(MINIMAL_PNG, 'image/png', 'a.html'), null);
});

test('通用素材上传校验租户归属、白名单并创建项目资产记录', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-media-upload-'));
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const ownDramaId = insertDrama(db, {
    tenantId: 'tenant-a',
    userId: 'user-a',
    title: '本租户项目',
  });
  const foreignDramaId = insertDrama(db, {
    tenantId: 'tenant-b',
    userId: 'user-b',
    title: '其他租户项目',
  });
  const handlers = uploadRoutes.routes({
    storage: { local_path: tempRoot, base_url: '' },
  }, log, db, { publicPlatformEnabled: true });
  const server = await startUploadServer(handlers);

  try {
    const disguised = await upload(server.url, {
      dramaId: ownDramaId,
      filename: 'evil.html',
      type: 'image/png',
      content: Buffer.from('<script>alert(1)</script>'),
    });
    assert.equal(disguised.status, 400);
    assert.equal(listFiles(tempRoot).length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM assets').get().total, 0);

    const accepted = await upload(server.url, {
      dramaId: ownDramaId,
      filename: 'role-reference.png',
      type: 'image/png',
      content: MINIMAL_PNG,
    });
    assert.equal(accepted.status, 201);
    assert.equal(accepted.body.success, true);
    assert.equal(accepted.body.data.drama_id, ownDramaId);
    assert.equal(accepted.body.data.type, 'image');
    assert.equal(accepted.body.data.name, 'role-reference.png');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS total FROM assets WHERE drama_id = ?').get(ownDramaId).total,
      1,
    );
    assert.equal(
      fs.existsSync(path.join(tempRoot, accepted.body.data.local_path)),
      true,
    );

    const acceptedVideo = await upload(server.url, {
      dramaId: ownDramaId,
      filename: 'scene.mp4',
      type: 'video/mp4',
      content: MINIMAL_MP4,
    });
    assert.equal(acceptedVideo.status, 201);
    assert.equal(acceptedVideo.body.data.type, 'video');
    assert.match(acceptedVideo.body.data.local_path, /\.mp4$/);

    const acceptedAudio = await upload(server.url, {
      dramaId: ownDramaId,
      filename: 'voice.m4a',
      type: 'audio/mp4',
      content: MINIMAL_M4A,
    });
    assert.equal(acceptedAudio.status, 201);
    assert.equal(acceptedAudio.body.data.type, 'audio');
    assert.match(acceptedAudio.body.data.local_path, /\.m4a$/);

    const anonymous = await upload(server.url, {
      dramaId: ownDramaId,
      filename: '匿名.png',
      type: 'image/png',
      content: MINIMAL_PNG,
      anonymous: true,
    });
    assert.equal(anonymous.status, 401);

    const foreign = await upload(server.url, {
      dramaId: foreignDramaId,
      filename: '越权.png',
      type: 'image/png',
      content: MINIMAL_PNG,
    });
    assert.equal(foreign.status, 404);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS total FROM assets WHERE drama_id = ?').get(foreignDramaId).total,
      0,
    );

    const rejected = await upload(server.url, {
      dramaId: ownDramaId,
      filename: '脚本.txt',
      type: 'text/plain',
      content: Buffer.from('not media'),
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.success, false);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS total FROM assets WHERE drama_id = ?').get(ownDramaId).total,
      3,
    );
  } finally {
    await server.close();
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('资产记录创建失败时删除本次落盘文件且不留下资产记录', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-media-rollback-'));
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const dramaId = insertDrama(db, {
    tenantId: 'tenant-a',
    userId: 'user-a',
    title: '回滚测试项目',
  });
  db.exec(`
    CREATE TRIGGER fail_media_asset_insert
    BEFORE INSERT ON assets
    BEGIN
      SELECT RAISE(FAIL, 'forced asset insert failure');
    END;
  `);
  const handlers = uploadRoutes.routes({
    storage: { local_path: tempRoot, base_url: '' },
  }, log, db, { publicPlatformEnabled: true });
  const server = await startUploadServer(handlers);

  try {
    const result = await upload(server.url, {
      dramaId,
      filename: 'rollback.png',
      type: 'image/png',
      content: MINIMAL_PNG,
    });
    assert.equal(result.status, 500);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM assets').get().total, 0);
    assert.deepEqual(listFiles(tempRoot), []);
  } finally {
    await server.close();
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
