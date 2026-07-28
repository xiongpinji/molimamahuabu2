const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const sharp = require('sharp');

const createImageToolRoutes = require('../src/routes/imageTools');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const assetService = require('../src/services/assetService');
const taskService = require('../src/services/taskService');
const userAuthService = require('../src/services/userAuthService');
const tenantService = require('../src/services/tenantService');

sharp.cache(false);

const TEST_MODEL_SHA256 = '9A72F871A95D3689B4F1DF8249FFC4280F47A54571A30E12CD5AA86A23B8A13A';
const TEST_AUDITED_MODEL_HASHES = Object.freeze({ u2netp: TEST_MODEL_SHA256 });

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

function fakeSmartCutoutTool(root, extraArgs = [], overrides = {}) {
  const modelHome = path.join(root, 'models');
  fs.mkdirSync(modelHome, { recursive: true });
  fs.writeFileSync(path.join(modelHome, 'u2netp.onnx'), 'test model fixture');
  return {
    command: process.execPath,
    args: [path.join(__dirname, 'fixtures', 'fake-rembg.js'), ...extraArgs],
    engineVersion: '2.0.77',
    model: 'u2netp',
    modelHome,
    ...overrides,
  };
}

test('图片工具能力只公布真实可用处理器并明确未配置原因', () => {
  const handlers = createImageToolRoutes(null, { error() {} });
  const res = responseRecorder();

  handlers.capabilities({}, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.success, true);
  const operations = res.payload.data.operations;
  assert.equal(operations.crop.available, true);
  assert.equal(operations.crop.engine, 'sharp');
  assert.equal(operations.compress.available, true);
  assert.equal(operations.compress.engine, 'sharp');
  assert.equal(operations.mirror.available, true);
  assert.equal(operations.mirror.engine, 'sharp');
  assert.equal(operations.rotate.available, true);
  assert.equal(operations.rotate.engine, 'sharp');
  assert.equal(operations.grid_crop.available, true);
  assert.equal(operations.grid_crop.engine, 'sharp');
  assert.equal(operations.adjust.available, true);
  assert.equal(operations.lut.available, true);
  assert.deepEqual(operations.lut.presets, ['cinematic', 'warm', 'cool', 'mono']);
  assert.equal(operations.smart_cutout.available, false);
  assert.match(operations.smart_cutout.reason, /许可证审计/);
  assert.equal(operations.panorama.available, false);
  assert.match(operations.panorama.reason, /模型能力/);
  assert.equal(
    Object.keys(operations).some((key) => /verify|review|copyright|infringement/i.test(key)),
    false,
  );
});

test('配置真实 rembg 命令后才公布智能抠图能力', (t) => {
  const toolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-rembg-tool-'));
  t.after(() => fs.rmSync(toolRoot, { recursive: true, force: true }));
  const handlers = createImageToolRoutes(null, { error() {} }, {
    modelTools: {
      smart_cutout: fakeSmartCutoutTool(toolRoot),
    },
    auditedModelHashes: TEST_AUDITED_MODEL_HASHES,
  });
  const res = responseRecorder();

  handlers.capabilities({}, res);

  assert.equal(res.payload.data.operations.smart_cutout.available, true);
  assert.equal(res.payload.data.operations.smart_cutout.engine, 'rembg');
  assert.equal(res.payload.data.operations.smart_cutout.engineVersion, '2.0.77');
  assert.equal(res.payload.data.operations.smart_cutout.model, 'u2netp');
});

test('智能抠图能力探针拒绝目录、错误版本、缺失模型和错误模型哈希', (t) => {
  const toolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-rembg-probe-'));
  t.after(() => fs.rmSync(toolRoot, { recursive: true, force: true }));
  const cases = [
    fakeSmartCutoutTool(toolRoot, [], { command: toolRoot }),
    fakeSmartCutoutTool(toolRoot, [], { engineVersion: '9.9.9' }),
    {
      command: process.execPath,
      args: [path.join(__dirname, 'fixtures', 'fake-rembg.js')],
      engineVersion: '2.0.77',
      model: 'u2netp',
    },
    fakeSmartCutoutTool(toolRoot, [], {
      modelHome: path.join(toolRoot, 'wrong-hash-models'),
    }),
  ];
  fs.mkdirSync(cases.at(-1).modelHome, { recursive: true });
  fs.writeFileSync(path.join(cases.at(-1).modelHome, 'u2netp.onnx'), 'damaged model');

  for (const smartCutout of cases) {
    const handlers = createImageToolRoutes(null, { error() {} }, {
      modelTools: { smart_cutout: smartCutout },
      auditedModelHashes: TEST_AUDITED_MODEL_HASHES,
    });
    const res = responseRecorder();
    handlers.capabilities({}, res);
    assert.equal(res.payload.data.operations.smart_cutout.available, false);
  }
});

test('智能抠图通过配置的 rembg 命令生成透明 PNG 派生素材', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-image-tools-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, status, created_at, updated_at)
     VALUES ('智能抠图测试', 'draft', ?, ?)`,
  ).run(now, now).lastInsertRowid;
  const sourcePath = path.join(storageRoot, 'source.jpg');
  await sharp({
    create: {
      width: 8,
      height: 6,
      channels: 3,
      background: '#ffffff',
    },
  }).jpeg().toFile(sourcePath);
  const sourceAsset = assetService.create(db, { info() {} }, {
    drama_id: dramaId,
    name: 'source.jpg',
    type: 'image',
    category: 'canvas',
    url: '/static/source.jpg',
    local_path: sourcePath,
  });
  const handlers = createImageToolRoutes(db, { info() {}, error() {} }, {
    cfg: { storage: { local_path: storageRoot } },
    modelTools: {
      smart_cutout: fakeSmartCutoutTool(storageRoot),
    },
    auditedModelHashes: TEST_AUDITED_MODEL_HASHES,
  });
  const res = responseRecorder();

  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-cutout',
      operation: 'smart_cutout',
      parameters: {},
    },
  }, res);

  assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
  const resultAsset = assetService.getById(db, res.payload.data.resultAssetId);
  assert.equal(resultAsset.mime_type, 'image/png');
  assert.equal(resultAsset.metadata.engine, 'rembg');
  assert.equal(resultAsset.metadata.engineVersion, '2.0.77');
  assert.deepEqual(resultAsset.metadata.parameters, { model: 'u2netp' });
  const resultMetadata = await sharp(resultAsset.local_path).metadata();
  assert.equal(resultMetadata.format, 'png');
  assert.equal(resultMetadata.hasAlpha, true);
  assert.equal(fs.existsSync(sourcePath), true);
});

test('智能抠图限制同租户和全局并发并返回 429', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-image-tools-limit-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, status, created_at, updated_at)
     VALUES ('智能抠图并发测试', 'draft', ?, ?)`,
  ).run(now, now).lastInsertRowid;
  const sourcePath = path.join(storageRoot, 'source.png');
  await sharp({
    create: {
      width: 8,
      height: 6,
      channels: 4,
      background: '#ffffff',
    },
  }).png().toFile(sourcePath);
  const sourceAsset = assetService.create(db, { info() {} }, {
    drama_id: dramaId,
    name: 'source.png',
    type: 'image',
    category: 'canvas',
    url: '/static/source.png',
    local_path: sourcePath,
  });

  async function assertSecondRequestBusy(toolOverrides, tenantIds) {
    const handlers = createImageToolRoutes(db, { info() {}, error() {} }, {
      cfg: { storage: { local_path: storageRoot } },
      modelTools: {
        smart_cutout: fakeSmartCutoutTool(
          storageRoot,
          ['--delay-ms=250'],
          toolOverrides,
        ),
      },
      auditedModelHashes: TEST_AUDITED_MODEL_HASHES,
    });
    const firstRes = responseRecorder();
    const secondRes = responseRecorder();
    const body = {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-cutout-concurrency',
      operation: 'smart_cutout',
      parameters: {},
    };
    const first = handlers.createOperation({
      tenant: { id: tenantIds[0] },
      body,
    }, firstRes);
    await handlers.createOperation({
      tenant: { id: tenantIds[1] },
      body,
    }, secondRes);
    await first;

    assert.equal(firstRes.statusCode, 201);
    assert.equal(secondRes.statusCode, 429);
    assert.equal(secondRes.payload.error.code, 'IMAGE_TOOL_BUSY');
  }

  await assertSecondRequestBusy(
    { maxConcurrency: 2, maxTenantConcurrency: 1 },
    ['tenant-a', 'tenant-a'],
  );
  await assertSecondRequestBusy(
    { maxConcurrency: 1, maxTenantConcurrency: 2 },
    ['tenant-a', 'tenant-b'],
  );
});

test('智能抠图处理失败时写回失败任务且不残留派生素材', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-image-tools-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, status, created_at, updated_at)
     VALUES ('智能抠图失败测试', 'draft', ?, ?)`,
  ).run(now, now).lastInsertRowid;
  const sourcePath = path.join(storageRoot, 'source.png');
  await sharp({
    create: {
      width: 8,
      height: 6,
      channels: 4,
      background: '#ffffff',
    },
  }).png().toFile(sourcePath);
  const sourceAsset = assetService.create(db, { info() {} }, {
    drama_id: dramaId,
    name: 'source.png',
    type: 'image',
    category: 'canvas',
    url: '/static/source.png',
    local_path: sourcePath,
  });
  const handlers = createImageToolRoutes(db, { info() {}, error() {} }, {
    cfg: { storage: { local_path: storageRoot } },
    modelTools: {
      smart_cutout: fakeSmartCutoutTool(storageRoot, ['--fail']),
    },
    auditedModelHashes: TEST_AUDITED_MODEL_HASHES,
  });
  const res = responseRecorder();

  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-cutout-failure',
      operation: 'smart_cutout',
      parameters: {},
    },
  }, res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.error.code, 'IMAGE_TOOL_PROCESSING_FAILED');
  assert.doesNotMatch(res.payload.error.message, /fake rembg processing failure/);
  assert.equal(fs.existsSync(sourcePath), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM assets').get().total, 1);
  const tasks = db.prepare('SELECT * FROM async_tasks').all();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'failed');
  assert.match(tasks[0].error, /智能抠图处理失败/);
  assert.doesNotMatch(tasks[0].error, /fake rembg processing failure/);
  const derivedDir = path.join(storageRoot, 'derived');
  assert.equal(
    fs.existsSync(derivedDir) ? fs.readdirSync(derivedDir).length : 0,
    0,
  );

  const invalidHandlers = createImageToolRoutes(db, { info() {}, error() {} }, {
    cfg: { storage: { local_path: storageRoot } },
    modelTools: {
      smart_cutout: fakeSmartCutoutTool(storageRoot, ['--invalid']),
    },
    auditedModelHashes: TEST_AUDITED_MODEL_HASHES,
  });
  const invalidRes = responseRecorder();

  await invalidHandlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-cutout-invalid-output',
      operation: 'smart_cutout',
      parameters: {},
    },
  }, invalidRes);

  assert.equal(invalidRes.statusCode, 503);
  assert.equal(invalidRes.payload.error.code, 'IMAGE_TOOL_PROCESSING_FAILED');
  assert.match(invalidRes.payload.error.message, /产物校验失败/);
  assert.doesNotMatch(invalidRes.payload.error.message, /derived|input buffer/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM assets').get().total, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM async_tasks').get().total, 2);
  assert.equal(fs.existsSync(derivedDir) ? fs.readdirSync(derivedDir).length : 0, 0);

  const truncatedHandlers = createImageToolRoutes(db, { info() {}, error() {} }, {
    cfg: { storage: { local_path: storageRoot } },
    modelTools: {
      smart_cutout: fakeSmartCutoutTool(storageRoot, ['--truncated']),
    },
    auditedModelHashes: TEST_AUDITED_MODEL_HASHES,
  });
  const truncatedRes = responseRecorder();

  await truncatedHandlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-cutout-truncated-output',
      operation: 'smart_cutout',
      parameters: {},
    },
  }, truncatedRes);

  assert.equal(truncatedRes.statusCode, 503);
  assert.equal(truncatedRes.payload.error.code, 'IMAGE_TOOL_PROCESSING_FAILED');
  assert.match(truncatedRes.payload.error.message, /产物校验失败/);
  assert.doesNotMatch(truncatedRes.payload.error.message, /derived|pngload/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM assets').get().total, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM async_tasks').get().total, 3);
  assert.equal(fs.existsSync(derivedDir) ? fs.readdirSync(derivedDir).length : 0, 0);

  const oversizedHandlers = createImageToolRoutes(db, { info() {}, error() {} }, {
    cfg: { storage: { local_path: storageRoot } },
    modelTools: {
      smart_cutout: fakeSmartCutoutTool(storageRoot, ['--oversized']),
    },
    auditedModelHashes: TEST_AUDITED_MODEL_HASHES,
  });
  const oversizedRes = responseRecorder();

  await oversizedHandlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-cutout-oversized-output',
      operation: 'smart_cutout',
      parameters: {},
    },
  }, oversizedRes);

  assert.equal(oversizedRes.statusCode, 503);
  assert.equal(oversizedRes.payload.error.code, 'IMAGE_TOOL_PROCESSING_FAILED');
  assert.match(oversizedRes.payload.error.message, /产物校验失败/);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM assets').get().total, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM async_tasks').get().total, 4);
  assert.equal(fs.existsSync(derivedDir) ? fs.readdirSync(derivedDir).length : 0, 0);
});

test('裁剪操作生成可回读的派生资产且不覆盖原图', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-image-tools-'));
  t.after(() => fs.rmSync(storageRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, status, created_at, updated_at)
     VALUES ('图片工具测试', 'draft', ?, ?)`,
  ).run(now, now).lastInsertRowid;
  const sourcePath = path.join(storageRoot, 'source.png');
  await sharp({
    create: {
      width: 4,
      height: 3,
      channels: 4,
      background: '#ff0000',
    },
  }).png().toFile(sourcePath);
  const sourceAsset = assetService.create(db, { info() {} }, {
    drama_id: dramaId,
    name: 'source.png',
    type: 'image',
    category: 'canvas',
    url: '/static/source.png',
    local_path: sourcePath,
    mime_type: 'image/png',
    width: 4,
    height: 3,
  });
  const handlers = createImageToolRoutes(db, { info() {}, error() {} }, {
    cfg: { storage: { local_path: storageRoot } },
  });
  const res = responseRecorder();

  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-1',
      operation: 'crop',
      parameters: { left: 1, top: 0, width: 2, height: 3 },
    },
  }, res);

  assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
  assert.equal(res.payload.success, true);
  assert.notEqual(res.payload.data.resultAssetId, sourceAsset.id);
  assert.equal(fs.existsSync(sourcePath), true);
  const resultAsset = assetService.getById(db, res.payload.data.resultAssetId);
  assert.ok(resultAsset);
  assert.equal(resultAsset.metadata.sourceAssetId, sourceAsset.id);
  assert.equal(resultAsset.metadata.operation, 'crop');
  assert.equal(fs.existsSync(resultAsset.local_path), true);
  const resultMetadata = await sharp(resultAsset.local_path).metadata();
  assert.equal(resultMetadata.width, 2);
  assert.equal(resultMetadata.height, 3);
  const task = taskService.getTask(db, res.payload.data.taskId);
  assert.equal(task.status, 'completed');
  assert.equal(task.resource_id, 'image-node-1');
  assert.equal(JSON.parse(task.result).resultAssetId, resultAsset.id);

  const taskRes = responseRecorder();
  await handlers.getOperation({
    params: { taskId: task.id },
  }, taskRes);
  assert.equal(taskRes.statusCode, 200);
  assert.equal(taskRes.payload.data.id, task.id);
  assert.equal(taskRes.payload.data.status, 'completed');
});

test('公开模式拒绝处理其他租户的图片素材', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-image-tools-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  const owner = userAuthService.register(db, {
    email: 'owner@example.com',
    password: 'correct horse battery staple',
  });
  const outsider = userAuthService.register(db, {
    email: 'outsider@example.com',
    password: 'correct horse battery staple',
  });
  const ownerTenant = tenantService.createTenant(db, owner.id, {
    name: '素材所属团队',
    slug: 'asset-owner',
  });
  const outsiderTenant = tenantService.createTenant(db, outsider.id, {
    name: '访问方团队',
    slug: 'asset-outsider',
  });
  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (tenant_id, user_id, title, status, created_at, updated_at)
     VALUES (?, ?, '其他租户项目', 'draft', ?, ?)`,
  ).run(ownerTenant.id, owner.id, now, now).lastInsertRowid;
  const sourceAsset = assetService.create(db, { info() {} }, {
    drama_id: dramaId,
    name: 'private.png',
    type: 'image',
    url: '/static/private.png',
    local_path: path.join(storageRoot, 'private.png'),
  });
  const handlers = createImageToolRoutes(db, { info() {}, error() {} }, {
    cfg: { storage: { local_path: storageRoot } },
    publicPlatformEnabled: true,
  });
  const res = responseRecorder();

  await handlers.createOperation({
    user: { id: outsider.id },
    tenant: { id: outsiderTenant.id },
    body: {
      assetId: sourceAsset.id,
      operation: 'crop',
      parameters: { left: 0, top: 0, width: 1, height: 1 },
    },
  }, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.payload.success, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM async_tasks').get().total, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM assets').get().total, 1);
});

test('公开模式任务回读拒绝匿名请求和其他租户', async (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  const task = taskService.createTask(
    db,
    { info() {} },
    'image_tool_crop',
    'private-image-node',
  );
  db.prepare('UPDATE async_tasks SET tenant_id = ?, user_id = ? WHERE id = ?')
    .run('tenant-owner', 'user-owner', task.id);
  const handlers = createImageToolRoutes(db, { info() {}, error() {} }, {
    publicPlatformEnabled: true,
  });

  const anonymousRes = responseRecorder();
  await handlers.getOperation({
    params: { taskId: task.id },
  }, anonymousRes);
  assert.equal(anonymousRes.statusCode, 404);

  const outsiderRes = responseRecorder();
  await handlers.getOperation({
    params: { taskId: task.id },
    tenant: { id: 'tenant-outsider' },
    user: { id: 'user-outsider' },
  }, outsiderRes);
  assert.equal(outsiderRes.statusCode, 404);

  const ownerRes = responseRecorder();
  await handlers.getOperation({
    params: { taskId: task.id },
    tenant: { id: 'tenant-owner' },
    user: { id: 'user-owner' },
  }, ownerRes);
  assert.equal(ownerRes.statusCode, 200);
  assert.equal(ownerRes.payload.data.id, task.id);
});

test('无效裁剪写入失败任务且不产生派生文件', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-image-tools-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, status, created_at, updated_at)
     VALUES ('无效裁剪测试', 'draft', ?, ?)`,
  ).run(now, now).lastInsertRowid;
  const sourcePath = path.join(storageRoot, 'source.png');
  await sharp({
    create: {
      width: 4,
      height: 3,
      channels: 4,
      background: '#0000ff',
    },
  }).png().toFile(sourcePath);
  const sourceAsset = assetService.create(db, { info() {} }, {
    drama_id: dramaId,
    name: 'source.png',
    type: 'image',
    category: 'canvas',
    url: '/static/source.png',
    local_path: sourcePath,
  });
  const handlers = createImageToolRoutes(db, { info() {}, error() {} }, {
    cfg: { storage: { local_path: storageRoot } },
  });
  const res = responseRecorder();

  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-1',
      operation: 'crop',
      parameters: { left: 3, top: 0, width: 2, height: 3 },
    },
  }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.success, false);
  assert.equal(fs.existsSync(sourcePath), true);
  assert.equal(fs.existsSync(path.join(storageRoot, 'derived')), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM assets').get().total, 1);
  const tasks = db.prepare('SELECT * FROM async_tasks').all();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'failed');
  assert.match(tasks[0].error, /超出源图片/);
});

test('压缩操作使用 Sharp 生成指定格式的派生资产', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-image-tools-'));
  t.after(() => fs.rmSync(storageRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, status, created_at, updated_at)
     VALUES ('压缩测试', 'draft', ?, ?)`,
  ).run(now, now).lastInsertRowid;
  const sourcePath = path.join(storageRoot, 'source.png');
  await sharp({
    create: {
      width: 16,
      height: 12,
      channels: 4,
      background: '#00ff00',
    },
  }).png().toFile(sourcePath);
  const sourceAsset = assetService.create(db, { info() {} }, {
    drama_id: dramaId,
    name: 'source.png',
    type: 'image',
    category: 'canvas',
    url: '/static/source.png',
    local_path: sourcePath,
  });
  const handlers = createImageToolRoutes(db, { info() {}, error() {} }, {
    cfg: { storage: { local_path: storageRoot } },
  });
  const res = responseRecorder();

  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-compress',
      operation: 'compress',
      parameters: { format: 'webp', quality: 40 },
    },
  }, res);

  assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
  const resultAsset = assetService.getById(db, res.payload.data.resultAssetId);
  assert.equal(resultAsset.mime_type, 'image/webp');
  assert.equal(path.extname(resultAsset.local_path), '.webp');
  assert.deepEqual(resultAsset.metadata.parameters, { format: 'webp', quality: 40 });
  const resultMetadata = await sharp(resultAsset.local_path).metadata();
  assert.equal(resultMetadata.format, 'webp');
  assert.equal(resultMetadata.width, 16);
  assert.equal(resultMetadata.height, 12);
  assert.equal(fs.existsSync(sourcePath), true);

  const chainedRes = responseRecorder();
  await handlers.createOperation({
    body: {
      assetId: resultAsset.id,
      sourceNodeId: 'image-node-compress-chain',
      operation: 'mirror',
      parameters: { direction: 'horizontal' },
    },
  }, chainedRes);
  assert.equal(chainedRes.statusCode, 201, JSON.stringify(chainedRes.payload));
  const chainedAsset = assetService.getById(db, chainedRes.payload.data.resultAssetId);
  const derivedSegments = path.relative(storageRoot, chainedAsset.local_path)
    .split(path.sep)
    .filter((segment) => segment === 'derived');
  assert.equal(derivedSegments.length, 1);
  assert.equal((chainedAsset.url.match(/\/derived\//g) || []).length, 1);
});

test('镜像操作按指定方向翻转像素且保留原图', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-image-tools-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, status, created_at, updated_at)
     VALUES ('镜像测试', 'draft', ?, ?)`,
  ).run(now, now).lastInsertRowid;
  const sourcePath = path.join(storageRoot, 'source.png');
  await sharp(Buffer.from([
    255, 0, 0, 255,
    0, 0, 255, 255,
  ]), { raw: { width: 2, height: 1, channels: 4 } }).png().toFile(sourcePath);
  const sourceAsset = assetService.create(db, { info() {} }, {
    drama_id: dramaId,
    name: 'source.png',
    type: 'image',
    category: 'canvas',
    url: '/static/source.png',
    local_path: sourcePath,
  });
  const handlers = createImageToolRoutes(db, { info() {}, error() {} }, {
    cfg: { storage: { local_path: storageRoot } },
  });
  const res = responseRecorder();

  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-mirror',
      operation: 'mirror',
      parameters: { direction: 'horizontal' },
    },
  }, res);

  assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
  const resultAsset = assetService.getById(db, res.payload.data.resultAssetId);
  const { data, info } = await sharp(resultAsset.local_path).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 2);
  assert.deepEqual(Array.from(data.subarray(0, 4)), [0, 0, 255, 255]);
  assert.deepEqual(Array.from(data.subarray(4, 8)), [255, 0, 0, 255]);
  assert.deepEqual(resultAsset.metadata.parameters, { direction: 'horizontal' });
  assert.equal(fs.existsSync(sourcePath), true);

  const rotateRes = responseRecorder();
  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-rotate',
      operation: 'rotate',
      parameters: { angle: 90 },
    },
  }, rotateRes);
  assert.equal(rotateRes.statusCode, 201, JSON.stringify(rotateRes.payload));
  const rotatedAsset = assetService.getById(db, rotateRes.payload.data.resultAssetId);
  const rotatedMetadata = await sharp(rotatedAsset.local_path).metadata();
  assert.equal(rotatedMetadata.width, 1);
  assert.equal(rotatedMetadata.height, 2);
  assert.deepEqual(rotatedAsset.metadata.parameters, { angle: 90 });
});

test('宫格裁剪返回全部派生素材并保留首图兼容字段', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-image-tools-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, status, created_at, updated_at)
     VALUES ('宫格裁剪测试', 'draft', ?, ?)`,
  ).run(now, now).lastInsertRowid;
  const sourcePath = path.join(storageRoot, 'source.png');
  await sharp({
    create: {
      width: 4,
      height: 4,
      channels: 4,
      background: '#ffffff',
    },
  }).png().toFile(sourcePath);
  const sourceAsset = assetService.create(db, { info() {} }, {
    drama_id: dramaId,
    name: 'source.png',
    type: 'image',
    category: 'canvas',
    url: '/static/source.png',
    local_path: sourcePath,
  });
  const handlers = createImageToolRoutes(db, { info() {}, error() {} }, {
    cfg: { storage: { local_path: storageRoot } },
  });
  const res = responseRecorder();

  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-grid',
      operation: 'grid_crop',
      parameters: { rows: 2, columns: 2 },
    },
  }, res);

  assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
  assert.equal(res.payload.data.resultAssets.length, 4);
  assert.equal(res.payload.data.resultAssetId, res.payload.data.resultAssets[0].id);
  assert.equal(res.payload.data.resultUrl, res.payload.data.resultAssets[0].url);
  for (const item of res.payload.data.resultAssets) {
    const resultAsset = assetService.getById(db, item.id);
    assert.equal(resultAsset.metadata.operation, 'grid_crop');
    const metadata = await sharp(resultAsset.local_path).metadata();
    assert.equal(metadata.width, 2);
    assert.equal(metadata.height, 2);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM assets').get().total, 5);
  assert.equal(fs.existsSync(sourcePath), true);
});

test('图片调整保存亮度饱和度对比度参数并生成新素材', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-image-tools-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, status, created_at, updated_at)
     VALUES ('图片调整测试', 'draft', ?, ?)`,
  ).run(now, now).lastInsertRowid;
  const sourcePath = path.join(storageRoot, 'source.png');
  await sharp({
    create: {
      width: 3,
      height: 2,
      channels: 4,
      background: { r: 80, g: 120, b: 180, alpha: 1 },
    },
  }).png().toFile(sourcePath);
  const sourceAsset = assetService.create(db, { info() {} }, {
    drama_id: dramaId,
    name: 'source.png',
    type: 'image',
    category: 'canvas',
    url: '/static/source.png',
    local_path: sourcePath,
  });
  const handlers = createImageToolRoutes(db, { info() {}, error() {} }, {
    cfg: { storage: { local_path: storageRoot } },
  });
  const res = responseRecorder();

  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-adjust',
      operation: 'adjust',
      parameters: {
        brightness: 1.2,
        saturation: 0.8,
        contrast: 1.1,
        temperature: 0.4,
      },
    },
  }, res);

  assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
  const resultAsset = assetService.getById(db, res.payload.data.resultAssetId);
  assert.deepEqual(resultAsset.metadata.parameters, {
    brightness: 1.2,
    saturation: 0.8,
    contrast: 1.1,
    temperature: 0.4,
  });
  assert.notEqual(
    fs.readFileSync(resultAsset.local_path).toString('base64'),
    fs.readFileSync(sourcePath).toString('base64'),
  );
});

test('LUT 调色使用可审计的内置矩阵并记录预设名', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-image-tools-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, status, created_at, updated_at)
     VALUES ('LUT 测试', 'draft', ?, ?)`,
  ).run(now, now).lastInsertRowid;
  const sourcePath = path.join(storageRoot, 'source.png');
  await sharp({
    create: {
      width: 3,
      height: 2,
      channels: 4,
      background: { r: 100, g: 140, b: 200, alpha: 1 },
    },
  }).png().toFile(sourcePath);
  const sourceAsset = assetService.create(db, { info() {} }, {
    drama_id: dramaId,
    name: 'source.png',
    type: 'image',
    category: 'canvas',
    url: '/static/source.png',
    local_path: sourcePath,
  });
  const handlers = createImageToolRoutes(db, { info() {}, error() {} }, {
    cfg: { storage: { local_path: storageRoot } },
  });
  const res = responseRecorder();

  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-lut',
      operation: 'lut',
      parameters: { preset: 'cinematic' },
    },
  }, res);

  assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
  const resultAsset = assetService.getById(db, res.payload.data.resultAssetId);
  assert.deepEqual(resultAsset.metadata.parameters, { preset: 'cinematic' });
  assert.notEqual(
    fs.readFileSync(resultAsset.local_path).toString('base64'),
    fs.readFileSync(sourcePath).toString('base64'),
  );
});
