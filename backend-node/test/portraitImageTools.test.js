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

async function createFixture(t) {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-portrait-tools-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, status, created_at, updated_at)
     VALUES ('人像工具测试', 'draft', ?, ?)`,
  ).run(now, now).lastInsertRowid;
  const sourcePath = path.join(storageRoot, 'portrait.png');
  await sharp({
    create: {
      width: 120,
      height: 80,
      channels: 3,
      background: '#6b7ca5',
    },
  }).png().toFile(sourcePath);
  const sourceAsset = assetService.create(db, { info() {} }, {
    drama_id: dramaId,
    name: 'portrait.png',
    type: 'image',
    category: 'canvas',
    url: '/static/portrait.png',
    local_path: sourcePath,
  });
  const resultBuffer = await sharp({
    create: {
      width: 240,
      height: 160,
      channels: 3,
      background: '#d69b79',
    },
  }).png().toBuffer();
  return { db, storageRoot, sourcePath, sourceAsset, resultBuffer };
}

test('人像能力只在参考图处理器显式支持时开放', () => {
  const handlers = createImageToolRoutes(null, { error() {} }, {
    referenceImageTool: {
      engine: 'provider-image-edit',
      provider: 'aihubcc',
      protocol: 'aihubcc',
      model: 'gpt-image-2-3.5k',
      operations: ['portrait_texture', 'portrait_emotion'],
      async generate() {
        return { image_url: '' };
      },
    },
  });
  const res = responseRecorder();
  handlers.capabilities({}, res);

  assert.equal(res.payload.data.operations.portrait_texture.available, true);
  assert.deepEqual(res.payload.data.operations.portrait_texture.presets, [
    'natural',
    'clean',
    'cinematic',
  ]);
  assert.equal(res.payload.data.operations.portrait_emotion.available, true);
  assert.equal(res.payload.data.operations.portrait_emotion.emotions.length, 25);
})

test('人像调节通过真实参考图模型生成同尺寸派生素材且不覆盖原图', async (t) => {
  const fixture = await createFixture(t);
  let generationRequest = null;
  const handlers = createImageToolRoutes(
    fixture.db,
    { info() {}, warn() {}, error() {} },
    {
      cfg: { storage: { local_path: fixture.storageRoot } },
      referenceImageTool: {
        engine: 'provider-image-edit',
        provider: 'aihubcc',
        protocol: 'aihubcc',
        model: 'gpt-image-2-3.5k',
        operations: ['portrait_texture'],
        async generate(request) {
          generationRequest = request;
          return {
            image_url: `data:image/png;base64,${fixture.resultBuffer.toString('base64')}`,
          };
        },
      },
    },
  );
  const res = responseRecorder();

  await handlers.createOperation({
    body: {
      assetId: fixture.sourceAsset.id,
      sourceNodeId: 'portrait-source',
      operation: 'portrait_texture',
      parameters: {
        preset: 'natural',
        intensity: 3,
        description: '保留自然雀斑',
      },
    },
  }, res);

  assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
  assert.equal(generationRequest.referenceImage, fixture.sourcePath);
  assert.equal(generationRequest.size, '120x80');
  assert.match(generationRequest.prompt, /真实皮肤纹理/);
  assert.match(generationRequest.prompt, /保留自然雀斑/);
  const resultAsset = assetService.getById(fixture.db, res.payload.data.resultAssetId);
  const metadata = await sharp(resultAsset.local_path).metadata();
  assert.equal(metadata.width, 120);
  assert.equal(metadata.height, 80);
  assert.equal(resultAsset.metadata.operation, 'portrait_texture');
  assert.equal(resultAsset.metadata.parameters.preset, 'natural');
  assert.notEqual(resultAsset.id, fixture.sourceAsset.id);
  assert.equal(fs.existsSync(fixture.sourcePath), true);
})

test('情绪调节把完整原图和真实脸部裁片同时提交并清理临时文件', async (t) => {
  const fixture = await createFixture(t);
  let generationRequest = null;
  let faceMetadata = null;
  const handlers = createImageToolRoutes(
    fixture.db,
    { info() {}, warn() {}, error() {} },
    {
      cfg: { storage: { local_path: fixture.storageRoot } },
      referenceImageTool: {
        engine: 'provider-image-edit',
        provider: 'aihubcc',
        protocol: 'aihubcc',
        model: 'gpt-image-2-3.5k',
        operations: ['portrait_emotion'],
        async generate(request) {
          generationRequest = request;
          faceMetadata = await sharp(request.referenceImages[1]).metadata();
          return {
            image_url: `data:image/png;base64,${fixture.resultBuffer.toString('base64')}`,
          };
        },
      },
    },
  );
  const res = responseRecorder();

  await handlers.createOperation({
    body: {
      assetId: fixture.sourceAsset.id,
      sourceNodeId: 'emotion-source',
      operation: 'portrait_emotion',
      parameters: {
        emotion: '浅然莞尔',
        intensity: 4,
        faceRegion: { x: 0.25, y: 0.2, width: 0.5, height: 0.5 },
      },
    },
  }, res);

  assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
  assert.equal(faceMetadata.width, 60);
  assert.equal(faceMetadata.height, 40);
  assert.equal(generationRequest.referenceImages[0], fixture.sourcePath);
  assert.match(generationRequest.prompt, /浅然莞尔/);
  assert.match(generationRequest.prompt, /嘴角/);
  assert.match(generationRequest.prompt, /眼角|眼神/);
  assert.match(generationRequest.prompt, /强度 4\/5：明显/);
  assert.match(generationRequest.prompt, /必须产生相对原图可辨识的表情变化/);
  assert.match(generationRequest.systemPrompt, /visibly change the selected facial expression/);
  assert.match(generationRequest.systemPrompt, /Image 2/);
  assert.equal(fs.existsSync(generationRequest.referenceImages[1]), false);
  const resultAsset = assetService.getById(fixture.db, res.payload.data.resultAssetId);
  assert.equal(resultAsset.metadata.parameters.emotion, '浅然莞尔');
  assert.deepEqual(resultAsset.metadata.parameters.faceRegion, {
    x: 0.25,
    y: 0.2,
    width: 0.5,
    height: 0.5,
  });
})

test('情绪调节拒绝未定义情绪和越界人脸框', async (t) => {
  const fixture = await createFixture(t);
  const handlers = createImageToolRoutes(
    fixture.db,
    { info() {}, warn() {}, error() {} },
    {
      cfg: { storage: { local_path: fixture.storageRoot } },
      referenceImageTool: {
        engine: 'provider-image-edit',
        provider: 'aihubcc',
        protocol: 'aihubcc',
        model: 'gpt-image-2-3.5k',
        operations: ['portrait_emotion'],
        async generate() {
          throw new Error('不应调用供应商');
        },
      },
    },
  );

  for (const parameters of [
    { emotion: '不存在的情绪', intensity: 3 },
    {
      emotion: '浅然莞尔',
      intensity: 3,
      faceRegion: { x: 0.8, y: 0.8, width: 0.4, height: 0.4 },
    },
  ]) {
    const res = responseRecorder();
    await handlers.createOperation({
      body: {
        assetId: fixture.sourceAsset.id,
        operation: 'portrait_emotion',
        parameters,
      },
    }, res);
    assert.equal(res.statusCode, 400);
  }
})
