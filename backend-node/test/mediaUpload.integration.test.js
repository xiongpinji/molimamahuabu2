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
    const accepted = await upload(server.url, {
      dramaId: ownDramaId,
      filename: 'role-reference.png',
      type: 'image/png',
      content: Buffer.from('not-a-real-png-but-valid-upload-fixture'),
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

    const anonymous = await upload(server.url, {
      dramaId: ownDramaId,
      filename: '匿名.png',
      type: 'image/png',
      content: Buffer.from('anonymous'),
      anonymous: true,
    });
    assert.equal(anonymous.status, 401);

    const foreign = await upload(server.url, {
      dramaId: foreignDramaId,
      filename: '越权.png',
      type: 'image/png',
      content: Buffer.from('foreign'),
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
      1,
    );
  } finally {
    await server.close();
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
