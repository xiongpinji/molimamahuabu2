const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { setupRouter } = require('../src/routes');
const uploadModule = require('../src/routes/upload');
const recharge = require('../src/services/alipay-recharge-service');

const VALID_WEBP = Buffer.from('524946460400000057454250', 'hex');

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

function multipartRequest(file) {
  const boundary = 'recharge-package-upload-test';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.originalname}"\r\n`
      + `Content-Type: ${file.mimetype}\r\n\r\n`,
    ),
    file.buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const req = Readable.from(body);
  req.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'content-length': String(body.length),
  };
  req.method = 'POST';
  req.url = '/';
  return req;
}

function invokeMiddleware(middleware, req) {
  return new Promise((resolve, reject) => {
    const result = captureResponse();
    const originalJson = result.json;
    result.json = function json(body) {
      originalJson.call(this, body);
      resolve(result);
      return this;
    };
    middleware(req, result, (err) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
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

test('套餐广告图上传二次校验 MIME 与内容签名且拒绝 GIF', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-recharge-package-'));
  try {
    const handlers = uploadModule.routes({
      storage: { local_path: tempRoot, base_url: '' },
    }, { info() {}, warn() {}, error() {} });
    assert.equal(typeof handlers.uploadRechargePackageImage, 'function');

    const gifResponse = captureResponse();
    handlers.uploadRechargePackageImage({
      file: {
        buffer: Buffer.from('GIF89a', 'ascii'),
        originalname: 'promotion.gif',
        mimetype: 'image/gif',
        size: 6,
      },
    }, gifResponse);
    assert.equal(gifResponse.statusCode, 400);
    assert.equal(fs.existsSync(path.join(tempRoot, 'uploads', 'recharge-packages')), false);

    const forgedResponse = captureResponse();
    handlers.uploadRechargePackageImage({
      file: {
        buffer: Buffer.from('<html>not an image</html>'),
        originalname: 'promotion.webp',
        mimetype: 'image/webp',
        size: 25,
      },
    }, forgedResponse);
    assert.equal(forgedResponse.statusCode, 400);
    assert.equal(fs.existsSync(path.join(tempRoot, 'uploads', 'recharge-packages')), false);

    const mismatchedResponse = captureResponse();
    handlers.uploadRechargePackageImage({
      file: {
        buffer: Buffer.from('89504e470d0a1a0a', 'hex'),
        originalname: 'promotion.webp',
        mimetype: 'image/webp',
        size: 8,
      },
    }, mismatchedResponse);
    assert.equal(mismatchedResponse.statusCode, 400);
    assert.equal(fs.existsSync(path.join(tempRoot, 'uploads', 'recharge-packages')), false);

    const missingResponse = captureResponse();
    handlers.uploadRechargePackageImage({}, missingResponse);
    assert.equal(missingResponse.statusCode, 400);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('套餐广告图扩展名由 MIME 映射且不继承原文件名', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-recharge-extension-'));
  try {
    const handlers = uploadModule.routes({
      storage: { local_path: tempRoot, base_url: '' },
    }, { info() {}, warn() {}, error() {} });
    const response = captureResponse();

    handlers.uploadRechargePackageImage({
      file: {
        buffer: VALID_WEBP,
        originalname: 'promotion.html',
        mimetype: 'image/webp',
        size: VALID_WEBP.length,
      },
    }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.match(
      response.body.data.url,
      /^\/static\/uploads\/recharge-packages\/[^/]+\.webp$/,
    );
    assert.match(response.body.data.local_path, /\.webp$/);
    assert.doesNotMatch(response.body.data.local_path, /\.html$/);
    assert.equal(
      fs.existsSync(path.join(tempRoot, response.body.data.local_path)),
      true,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('套餐广告图忽略 HTTP base_url 返回同源路径并可创建和更新套餐', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-recharge-url-'));
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    const handlers = uploadModule.routes({
      storage: { local_path: tempRoot, base_url: 'http://localhost:5679/static' },
    }, { info() {}, warn() {}, error() {} }, db);
    const file = {
      buffer: VALID_WEBP,
      originalname: 'promotion.webp',
      mimetype: 'image/webp',
      size: VALID_WEBP.length,
    };

    const genericResponse = captureResponse();
    handlers.uploadImage({ file, body: {} }, genericResponse);
    assert.match(genericResponse.body.data.url, /^http:\/\/localhost:5679\/static\/uploads\//);

    const packageResponse = captureResponse();
    handlers.uploadRechargePackageImage({ file }, packageResponse);
    assert.equal(packageResponse.statusCode, 200);
    assert.match(packageResponse.body.data.url, /^\/static\/uploads\/recharge-packages\/[^/]+\.webp$/);
    assert.equal(packageResponse.body.data.path, packageResponse.body.data.local_path);
    assert.equal(packageResponse.body.data.url, `/static/${packageResponse.body.data.local_path.replace(/\\/g, '/')}`);

    const created = recharge.createPackage(db, {
      name: '上传广告图套餐',
      amountYuan: '10.00',
      dailyBonusCredits: 0,
      imageUrl: packageResponse.body.data.url,
      adTitle: '上传广告图',
      status: 'active',
    });
    assert.equal(created.image_url, packageResponse.body.data.url);

    const updated = recharge.updatePackage(db, created.id, {
      name: '上传广告图套餐更新',
      amountYuan: '20.00',
      dailyBonusCredits: 200,
      imageUrl: packageResponse.body.data.url,
      adTitle: '上传广告图更新',
      status: 'active',
    });
    assert.equal(updated.image_url, packageResponse.body.data.url);
  } finally {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('套餐广告图 Multer 将 GIF 映射为 400、超出 16MB 映射为 413', async () => {
  const handlers = uploadModule.routes({}, { info() {}, warn() {}, error() {} });
  assert.equal(typeof handlers.multerRechargePackageImageSingle, 'function');

  const gifResult = await invokeMiddleware(
    handlers.multerRechargePackageImageSingle,
    multipartRequest({
      buffer: Buffer.from('GIF89a', 'ascii'),
      originalname: 'promotion.gif',
      mimetype: 'image/gif',
    }),
  );
  assert.equal(gifResult.statusCode, 400);
  assert.equal(gifResult.body.error.message, '套餐广告图只支持 jpg、png、webp');

  const oversizedResult = await invokeMiddleware(
    handlers.multerRechargePackageImageSingle,
    multipartRequest({
      buffer: Buffer.alloc((16 * 1024 * 1024) + 1),
      originalname: 'promotion.webp',
      mimetype: 'image/webp',
    }),
  );
  assert.equal(oversizedResult.statusCode, 413);
  assert.equal(oversizedResult.body.error.code, 'FILE_TOO_LARGE');
  assert.match(oversizedResult.body.error.message, /16MB/);
});

test('未授权套餐广告图 multipart 请求在 Multer 写盘前被拒绝且无文件残留', async () => {
  const previous = {
    mode: process.env.PUBLIC_PLATFORM_MODE,
    jwt: process.env.PLATFORM_JWT_SECRET,
    admin: process.env.PLATFORM_ADMIN_TOKEN,
  };
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-recharge-auth-'));
  const db = new Database(':memory:');
  let server;
  try {
    process.env.PUBLIC_PLATFORM_MODE = 'true';
    process.env.PLATFORM_JWT_SECRET = 'recharge-upload-jwt-secret-value-123456';
    process.env.PLATFORM_ADMIN_TOKEN = 'recharge-upload-admin-token-value-123456';
    runMigrationsAndEnsure(db);

    const app = express();
    app.use('/api/v1', setupRouter({
      storage: { local_path: tempRoot, base_url: '' },
    }, db, { info() {}, warn() {}, error() {} }));
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });

    const form = new FormData();
    form.append('file', new Blob([VALID_WEBP], { type: 'image/webp' }), 'unauthorized.webp');
    const result = await fetch(
      `http://127.0.0.1:${server.address().port}/api/v1/billing/admin/recharge-packages/image`,
      { method: 'POST', body: form },
    );

    assert.equal(result.status, 401);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (previous.mode === undefined) delete process.env.PUBLIC_PLATFORM_MODE;
    else process.env.PUBLIC_PLATFORM_MODE = previous.mode;
    if (previous.jwt === undefined) delete process.env.PLATFORM_JWT_SECRET;
    else process.env.PLATFORM_JWT_SECRET = previous.jwt;
    if (previous.admin === undefined) delete process.env.PLATFORM_ADMIN_TOKEN;
    else process.env.PLATFORM_ADMIN_TOKEN = previous.admin;
  }
});
