const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Database = require('better-sqlite3');
const sharp = require('sharp');

const createImageToolRoutes = require('../src/routes/imageTools');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const assetService = require('../src/services/assetService');
const aiConfigService = require('../src/services/aiConfigService');
const imageClient = require('../src/services/imageClient');
const imageToolService = require('../src/services/imageToolService');
const modelPriceService = require('../src/services/modelPriceService');
const storageLayout = require('../src/services/storageLayout');
const taskService = require('../src/services/taskService');
const userAuthService = require('../src/services/userAuthService');
const tenantService = require('../src/services/tenantService');

sharp.cache(false);

const TEST_MODEL_SHA256 = '9A72F871A95D3689B4F1DF8249FFC4280F47A54571A30E12CD5AA86A23B8A13A';
const TEST_AUDITED_MODEL_HASHES = Object.freeze({ u2netp: TEST_MODEL_SHA256 });
const TEST_NODE_COPY = path.join(os.tmpdir(), `molimama-image-tools-node-${process.pid}.exe`);
const TEST_UPSCALE_FILES = Object.freeze({
  runtime: {
    'vcomp140.dll': 'test release runtime',
  },
  models: {
    'realesrgan-x4plus.bin': 'test Real-ESRGAN model weights',
    'realesrgan-x4plus.param': 'test Real-ESRGAN model graph',
  },
});

function bufferSha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

function fileSha256(filePath) {
  return bufferSha256(fs.readFileSync(filePath));
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

const TEST_AUDITED_UPSCALE_FILES = Object.freeze({
  executable: fileSha256(process.execPath),
  runtime: Object.fromEntries(
    Object.entries(TEST_UPSCALE_FILES.runtime).map(([name, contents]) => [
      name,
      bufferSha256(contents),
    ]),
  ),
  models: Object.fromEntries(
    Object.entries(TEST_UPSCALE_FILES.models).map(([name, contents]) => [
      name,
      bufferSha256(contents),
    ]),
  ),
});

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

function fakeUpscaleTool(root, extraArgs = [], overrides = {}) {
  const packageRoot = path.join(root, 'realesrgan-package');
  const modelDir = path.join(packageRoot, 'models');
  fs.mkdirSync(modelDir, { recursive: true });
  const command = path.join(packageRoot, 'realesrgan-ncnn-vulkan.exe');
  if (!fs.existsSync(command)) {
    if (!fs.existsSync(TEST_NODE_COPY)) fs.copyFileSync(process.execPath, TEST_NODE_COPY);
    fs.linkSync(TEST_NODE_COPY, command);
  }
  for (const [name, contents] of Object.entries(TEST_UPSCALE_FILES.runtime)) {
    fs.writeFileSync(path.join(packageRoot, name), contents);
  }
  for (const [name, contents] of Object.entries(TEST_UPSCALE_FILES.models)) {
    fs.writeFileSync(path.join(modelDir, name), contents);
  }
  return {
    command,
    args: [path.join(__dirname, 'fixtures', 'fake-realesrgan.js'), ...extraArgs],
    engineVersion: '0.2.5.0',
    model: 'realesrgan-x4plus',
    packageRoot,
    modelDir,
    ...overrides,
  };
}

process.once('exit', () => fs.rmSync(TEST_NODE_COPY, { force: true }));

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
  assert.equal(operations.markup_retouch.available, true);
  assert.equal(operations.markup_retouch.providerAvailable, false);
  assert.deepEqual(operations.markup_retouch.modes, ['markup_only']);
  assert.equal(operations.smart_cutout.available, false);
  assert.match(operations.smart_cutout.reason, /许可证审计/);
  assert.equal(operations.selection_cutout.available, false);
  assert.match(operations.selection_cutout.reason, /许可证审计/);
  assert.equal(operations.upscale.available, false);
  assert.match(operations.upscale.reason, /许可证审计/);
  assert.equal(operations.director_stage.available, true);
  assert.equal(operations.director_stage.engine, 'director-stage');
  assert.equal(operations.director_stage.action, 'open');
  assert.equal(operations.lighting.available, true);
  assert.equal(operations.lighting.engine, 'director-stage');
  assert.equal(operations.lighting.action, 'open');
  assert.equal(operations.lighting.mode, 'lighting');
  assert.equal(operations.cinematic_relight.available, false);
  assert.match(operations.cinematic_relight.reason, /显式声明|电影光影/);
  assert.equal(operations.angle.available, true);
  assert.equal(operations.angle.engine, 'director-stage');
  assert.equal(operations.angle.action, 'open');
  assert.equal(operations.angle.mode, 'angle');
  assert.equal(operations.angle_ideation.available, false);
  assert.equal(operations.pose.available, true);
  assert.equal(operations.pose.engine, 'director-stage');
  assert.equal(operations.pose.action, 'open');
  assert.equal(operations.pose.mode, 'pose');
  assert.equal(operations.panorama.available, false);
  assert.match(operations.panorama.reason, /模型能力/);
  assert.equal(
    Object.keys(operations).some((key) => /verify|review|copyright|infringement/i.test(key)),
    false,
  );
});

test('全景能力必须分别显式声明且只开放已审计的 Seedream 参考图适配器', () => {
  const baseTool = {
    engine: 'provider-image-edit',
    provider: 'volcengine',
    protocol: 'volcengine',
    model: 'doubao-seedream-4-5',
    generate: async () => ({ image_url: '' }),
  };
  const panoramaHandlers = createImageToolRoutes(null, { error() {} }, {
    referenceImageTool: {
      ...baseTool,
      operations: ['panorama'],
    },
  });
  const panoramaRes = responseRecorder();
  panoramaHandlers.capabilities({}, panoramaRes);

  assert.deepEqual(panoramaRes.payload.data.operations.panorama, {
    available: true,
    engine: 'provider-image-edit',
    provider: 'volcengine',
    protocol: 'volcengine',
    model: 'doubao-seedream-4-5',
    projection: 'equirectangular',
    outputSize: '3840x1920',
  });
  assert.equal(panoramaRes.payload.data.operations.panorama_scene.available, false);

  const sceneHandlers = createImageToolRoutes(null, { error() {} }, {
    referenceImageTool: {
      ...baseTool,
      operations: ['panorama_scene'],
    },
  });
  const sceneRes = responseRecorder();
  sceneHandlers.capabilities({}, sceneRes);

  assert.equal(sceneRes.payload.data.operations.panorama.available, false);
  assert.equal(sceneRes.payload.data.operations.panorama_scene.available, true);
  assert.equal(
    sceneRes.payload.data.operations.panorama_scene.projection,
    'equirectangular',
  );
  assert.equal(sceneRes.payload.data.operations.panorama_scene.outputSize, '3840x1920');
});

test('扩图只在本地参考图供应商能力可用时开放', async () => {
  const referenceImageTool = {
    engine: 'provider-image-edit',
    provider: 'volcengine',
    protocol: 'volcengine',
    model: 'doubao-seedream-4-5',
    operations: ['outpaint', 'markup_retouch', 'cinematic_relight'],
    generate: async () => ({ image_url: '' }),
  };
  const localHandlers = createImageToolRoutes(null, { error() {} }, {
    referenceImageTool,
  });
  const localRes = responseRecorder();

  localHandlers.capabilities({}, localRes);

  assert.equal(localRes.payload.data.operations.outpaint.available, true);
  assert.equal(localRes.payload.data.operations.outpaint.engine, 'provider-image-edit');
  assert.equal(localRes.payload.data.operations.outpaint.provider, 'volcengine');
  assert.equal(localRes.payload.data.operations.outpaint.model, 'doubao-seedream-4-5');
  assert.deepEqual(
    localRes.payload.data.operations.outpaint.aspectRatios,
    ['16:9', '9:16', '1:1', '4:3', '3:4'],
  );
  assert.equal(localRes.payload.data.operations.markup_retouch.available, true);
  assert.equal(localRes.payload.data.operations.markup_retouch.engine, 'provider-image-edit');
  assert.equal(localRes.payload.data.operations.markup_retouch.maxStrokes, 16);
  assert.equal(localRes.payload.data.operations.markup_retouch.maxPointsPerStroke, 128);
  assert.equal(localRes.payload.data.operations.cinematic_relight.available, true);
  assert.equal(localRes.payload.data.operations.cinematic_relight.engine, 'provider-image-edit');
  assert.deepEqual(localRes.payload.data.operations.cinematic_relight.presets, [
    'cinematic',
    'golden_hour',
    'moonlight',
    'studio_soft',
    'high_contrast',
  ]);
  assert.deepEqual(localRes.payload.data.operations.cinematic_relight.intensityRange, [1, 5]);
  assert.equal(localRes.payload.data.operations.cinematic_relight.preservesDimensions, true);

  const outpaintOnlyHandlers = createImageToolRoutes(null, { error() {} }, {
    referenceImageTool: {
      ...referenceImageTool,
      operations: ['outpaint'],
    },
  });
  const outpaintOnlyRes = responseRecorder();
  outpaintOnlyHandlers.capabilities({}, outpaintOnlyRes);
  assert.equal(outpaintOnlyRes.payload.data.operations.outpaint.available, true);
  assert.equal(outpaintOnlyRes.payload.data.operations.markup_retouch.available, true);
  assert.equal(outpaintOnlyRes.payload.data.operations.markup_retouch.providerAvailable, false);
  assert.deepEqual(outpaintOnlyRes.payload.data.operations.markup_retouch.modes, ['markup_only']);

  const markupOnlyHandlers = createImageToolRoutes(null, { error() {} }, {
    referenceImageTool: {
      ...referenceImageTool,
      operations: ['markup_retouch'],
    },
  });
  const markupOnlyRes = responseRecorder();
  markupOnlyHandlers.capabilities({}, markupOnlyRes);
  assert.equal(markupOnlyRes.payload.data.operations.outpaint.available, false);
  assert.equal(markupOnlyRes.payload.data.operations.markup_retouch.available, true);

  const publicHandlers = createImageToolRoutes(null, { error() {} }, {
    publicPlatformEnabled: true,
    referenceImageTool,
  });
  const publicRes = responseRecorder();
  publicHandlers.capabilities({}, publicRes);
  assert.equal(publicRes.payload.data.operations.outpaint.available, false);
  assert.match(publicRes.payload.data.operations.outpaint.reason, /积分价格/);
  assert.equal(publicRes.payload.data.operations.markup_retouch.available, true);
  assert.equal(publicRes.payload.data.operations.markup_retouch.providerAvailable, false);
  assert.deepEqual(publicRes.payload.data.operations.markup_retouch.modes, ['markup_only']);
  assert.match(publicRes.payload.data.operations.markup_retouch.providerReason, /积分价格/);
  assert.equal(publicRes.payload.data.operations.cinematic_relight.available, false);
  assert.match(publicRes.payload.data.operations.cinematic_relight.reason, /积分价格/);
  assert.equal(publicRes.payload.data.operations.panorama.available, false);
  assert.match(publicRes.payload.data.operations.panorama.reason, /积分价格/);
  assert.equal(publicRes.payload.data.operations.panorama_scene.available, false);
  assert.match(publicRes.payload.data.operations.panorama_scene.reason, /积分价格/);
  for (const operation of [
    'image_ideation',
    'angle_ideation',
    'character_views',
    'narrative_grid',
    'frame_forward',
    'frame_backward',
  ]) {
    assert.equal(publicRes.payload.data.operations[operation].available, false, operation);
    assert.match(publicRes.payload.data.operations[operation].reason, /积分价格/, operation);
  }

  const publicCreateRes = responseRecorder();
  await publicHandlers.createOperation({
    body: {
      assetId: 1,
      operation: 'outpaint',
      parameters: { aspectRatio: '16:9', direction: 'auto' },
    },
  }, publicCreateRes);
  assert.equal(publicCreateRes.statusCode, 503);
  assert.equal(publicCreateRes.payload.error.code, 'IMAGE_TOOL_OPERATION_UNAVAILABLE');
});

test('公开平台配置模型价格后公布已审计的参考图能力', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  modelPriceService.set(db, 'gpt-image-2-3.5k', 7, { category: 'image' });
  const handlers = createImageToolRoutes(db, { error() {} }, {
    publicPlatformEnabled: true,
    referenceImageTool: {
      engine: 'provider-image-edit',
      provider: 'aihubcc',
      protocol: 'aihubcc',
      model: 'gpt-image-2-3.5k',
      operations: ['outpaint', 'upscale'],
      generate: async () => ({ image_url: '' }),
    },
  });
  const res = responseRecorder();

  handlers.capabilities({}, res);

  assert.equal(res.payload.data.operations.outpaint.available, true);
  assert.equal(res.payload.data.operations.upscale.available, true);
  assert.equal(res.payload.data.operations.detail_enhance.available, false);
});

test('扩图能力从默认参考图模型配置解析且不误开放纯文生图模型', (t) => {
  const log = { info() {}, error() {} };
  const supportedDb = new Database(':memory:');
  t.after(() => supportedDb.close());
  runMigrationsAndEnsure(supportedDb);
  aiConfigService.createConfig(supportedDb, log, {
    service_type: 'storyboard_image',
    provider: 'aihubcc',
    api_protocol: 'aihubcc',
    name: 'AIHubCC GPT Image 2 3.5K',
    base_url: 'https://aihubcc.cc/v1',
    api_key: 'test-key',
    model: ['gpt-image-2-3.5k'],
    default_model: 'gpt-image-2-3.5k',
    is_default: true,
    settings: JSON.stringify({
      supports_outpaint: true,
      supports_markup_retouch: true,
      supports_upscale: true,
      supports_detail_enhance: true,
      supports_cinematic_relight: true,
      supports_panorama: true,
      supports_panorama_scene: true,
      supports_image_ideation: true,
      supports_angle_ideation: true,
      supports_character_views: true,
      supports_narrative_grid: true,
      supports_frame_forward: true,
      supports_frame_backward: true,
    }),
  });
  const supportedHandlers = createImageToolRoutes(supportedDb, log);
  const supportedRes = responseRecorder();
  supportedHandlers.capabilities({}, supportedRes);
  assert.equal(supportedRes.payload.data.operations.outpaint.available, true);
  assert.equal(supportedRes.payload.data.operations.outpaint.protocol, 'aihubcc');
  assert.equal(supportedRes.payload.data.operations.markup_retouch.available, true);
  assert.equal(supportedRes.payload.data.operations.markup_retouch.protocol, 'aihubcc');
  assert.equal(supportedRes.payload.data.operations.upscale.available, true);
  assert.equal(supportedRes.payload.data.operations.upscale.engine, 'provider-image-edit');
  assert.deepEqual(supportedRes.payload.data.operations.upscale.scales, [2, 3, 4]);
  assert.equal(supportedRes.payload.data.operations.detail_enhance.available, true);
  assert.equal(supportedRes.payload.data.operations.detail_enhance.preservesDimensions, true);
  assert.equal(supportedRes.payload.data.operations.cinematic_relight.available, true);
  assert.equal(supportedRes.payload.data.operations.cinematic_relight.protocol, 'aihubcc');
  assert.equal(supportedRes.payload.data.operations.panorama.available, true);
  assert.equal(supportedRes.payload.data.operations.panorama_scene.available, true);
  assert.equal(supportedRes.payload.data.operations.image_ideation.available, true);
  assert.equal(supportedRes.payload.data.operations.image_ideation.protocol, 'aihubcc');
  assert.equal(supportedRes.payload.data.operations.portrait_texture.available, true);
  assert.equal(supportedRes.payload.data.operations.portrait_texture.protocol, 'aihubcc');
  assert.equal(supportedRes.payload.data.operations.portrait_emotion.available, true);
  assert.equal(supportedRes.payload.data.operations.portrait_emotion.protocol, 'aihubcc');
  for (const operation of [
    'angle_ideation',
    'character_views',
    'narrative_grid',
    'frame_forward',
    'frame_backward',
  ]) {
    assert.equal(supportedRes.payload.data.operations[operation].available, true, operation);
    assert.equal(supportedRes.payload.data.operations[operation].protocol, 'aihubcc', operation);
  }

  const undeclaredDb = new Database(':memory:');
  t.after(() => undeclaredDb.close());
  runMigrationsAndEnsure(undeclaredDb);
  aiConfigService.createConfig(undeclaredDb, log, {
    service_type: 'storyboard_image',
    provider: 'aihubcc',
    api_protocol: 'aihubcc',
    name: '未声明图片工具能力的 AIHubCC',
    base_url: 'https://aihubcc.cc/v1',
    api_key: 'test-key',
    model: ['gpt-image-2-3.5k'],
    default_model: 'gpt-image-2-3.5k',
    is_default: true,
  });
  const undeclaredHandlers = createImageToolRoutes(undeclaredDb, log);
  const undeclaredRes = responseRecorder();
  undeclaredHandlers.capabilities({}, undeclaredRes);
  assert.equal(undeclaredRes.payload.data.operations.outpaint.available, false);
  assert.match(undeclaredRes.payload.data.operations.outpaint.reason, /显式声明/);
  assert.equal(undeclaredRes.payload.data.operations.cinematic_relight.available, false);
  assert.match(undeclaredRes.payload.data.operations.cinematic_relight.reason, /显式声明/);
  assert.equal(undeclaredRes.payload.data.operations.panorama.available, false);
  assert.equal(undeclaredRes.payload.data.operations.panorama_scene.available, false);
  assert.equal(undeclaredRes.payload.data.operations.image_ideation.available, false);
  assert.equal(undeclaredRes.payload.data.operations.portrait_texture.available, false);
  assert.equal(undeclaredRes.payload.data.operations.portrait_emotion.available, false);
  for (const operation of [
    'angle_ideation',
    'character_views',
    'narrative_grid',
    'frame_forward',
    'frame_backward',
  ]) {
    assert.equal(undeclaredRes.payload.data.operations[operation].available, false, operation);
  }

  const unsupportedDb = new Database(':memory:');
  t.after(() => unsupportedDb.close());
  runMigrationsAndEnsure(unsupportedDb);
  aiConfigService.createConfig(unsupportedDb, log, {
    service_type: 'storyboard_image',
    provider: 'openai',
    api_protocol: 'openai',
    name: '纯文生图',
    base_url: 'https://example.invalid/v1',
    api_key: 'test-key',
    model: ['dall-e-3'],
    default_model: 'dall-e-3',
    is_default: true,
  });
  const unsupportedHandlers = createImageToolRoutes(unsupportedDb, log);
  const unsupportedRes = responseRecorder();
  unsupportedHandlers.capabilities({}, unsupportedRes);
  assert.equal(unsupportedRes.payload.data.operations.outpaint.available, false);
  assert.match(unsupportedRes.payload.data.operations.outpaint.reason, /扩图/);
  assert.equal(unsupportedRes.payload.data.operations.cinematic_relight.available, false);
  assert.match(unsupportedRes.payload.data.operations.cinematic_relight.reason, /电影光影|显式声明/);
  assert.equal(unsupportedRes.payload.data.operations.panorama.available, false);
  assert.equal(unsupportedRes.payload.data.operations.panorama_scene.available, false);
  assert.equal(unsupportedRes.payload.data.operations.image_ideation.available, false);
  assert.equal(unsupportedRes.payload.data.operations.portrait_texture.available, false);
  assert.equal(unsupportedRes.payload.data.operations.portrait_emotion.available, false);
  for (const operation of [
    'angle_ideation',
    'character_views',
    'narrative_grid',
    'frame_forward',
    'frame_backward',
  ]) {
    assert.equal(unsupportedRes.payload.data.operations[operation].available, false, operation);
  }

  for (const config of [
    {
      service_type: 'image',
      provider: 'volcengine',
      api_protocol: 'volcengine',
      model: 'doubao-seedream-4-5',
      name: '普通图片配置不可开放电影光影',
    },
    {
      service_type: 'storyboard_image',
      provider: 'volcengine',
      api_protocol: 'volcengine',
      model: 'private-doubao-compatible',
      name: '名称仿冒模型不可开放电影光影',
    },
    {
      service_type: 'storyboard_image',
      provider: 'proxy',
      api_protocol: 'volcengine',
      model: 'doubao-seedream-4-5',
      name: '未审计供应商不可开放电影光影',
    },
    {
      service_type: 'storyboard_image',
      provider: 'volcengine',
      api_protocol: 'volcengine',
      model: 'doubao-seedream-4-0',
      name: '未审计旧版模型不可开放图片节点能力',
    },
  ]) {
    const strictDb = new Database(':memory:');
    t.after(() => strictDb.close());
    runMigrationsAndEnsure(strictDb);
    aiConfigService.createConfig(strictDb, log, {
      service_type: config.service_type,
      provider: config.provider,
      api_protocol: config.api_protocol,
      name: config.name,
      base_url: 'https://example.invalid/api/v3',
      api_key: 'test-key',
      model: [config.model],
      default_model: config.model,
      is_default: true,
      settings: JSON.stringify({
        supports_outpaint: true,
        supports_markup_retouch: true,
        supports_upscale: true,
        supports_detail_enhance: true,
        supports_cinematic_relight: true,
        supports_panorama: true,
        supports_panorama_scene: true,
        supports_image_ideation: true,
        supports_angle_ideation: true,
        supports_character_views: true,
        supports_narrative_grid: true,
        supports_frame_forward: true,
        supports_frame_backward: true,
      }),
    });
    const strictHandlers = createImageToolRoutes(strictDb, log);
    const strictRes = responseRecorder();
    strictHandlers.capabilities({}, strictRes);
    assert.equal(strictRes.payload.data.operations.outpaint.available, false, config.name);
    assert.equal(strictRes.payload.data.operations.markup_retouch.available, true, config.name);
    assert.equal(
      strictRes.payload.data.operations.markup_retouch.providerAvailable,
      false,
      config.name,
    );
    assert.deepEqual(
      strictRes.payload.data.operations.markup_retouch.modes,
      ['markup_only'],
      config.name,
    );
    assert.equal(strictRes.payload.data.operations.upscale.available, false, config.name);
    assert.equal(strictRes.payload.data.operations.detail_enhance.available, false, config.name);
    assert.equal(
      strictRes.payload.data.operations.cinematic_relight.available,
      false,
      config.name,
    );
    assert.equal(strictRes.payload.data.operations.panorama.available, false, config.name);
    assert.equal(strictRes.payload.data.operations.panorama_scene.available, false, config.name);
    assert.equal(strictRes.payload.data.operations.image_ideation.available, false, config.name);
    assert.equal(strictRes.payload.data.operations.portrait_texture.available, false, config.name);
    assert.equal(strictRes.payload.data.operations.portrait_emotion.available, false, config.name);
    for (const operation of [
      'angle_ideation',
      'character_views',
      'narrative_grid',
      'frame_forward',
      'frame_backward',
    ]) {
      assert.equal(strictRes.payload.data.operations[operation].available, false, config.name);
    }
  }
});

test('图片节点能力会读取路由创建后保存的 AIHubCC 参考图配置', (t) => {
  const log = { info() {}, error() {} };
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  const handlers = createImageToolRoutes(db, log);

  const beforeRes = responseRecorder();
  handlers.capabilities({}, beforeRes);
  assert.equal(beforeRes.payload.data.operations.upscale.available, false);

  aiConfigService.createConfig(db, log, {
    service_type: 'storyboard_image',
    provider: 'aihubcc',
    api_protocol: 'aihubcc',
    name: 'AIHubCC GPT Image 2 3.5K',
    base_url: 'https://aihubcc.cc/v1',
    api_key: 'test-key',
    model: ['gpt-image-2-3.5k'],
    default_model: 'gpt-image-2-3.5k',
    is_default: true,
    settings: JSON.stringify({
      supports_outpaint: true,
      supports_markup_retouch: true,
      supports_upscale: true,
      supports_detail_enhance: true,
      supports_cinematic_relight: true,
      supports_panorama: true,
      supports_panorama_scene: true,
      supports_image_ideation: true,
      supports_angle_ideation: true,
      supports_character_views: true,
      supports_narrative_grid: true,
      supports_frame_forward: true,
      supports_frame_backward: true,
    }),
  });

  const afterRes = responseRecorder();
  handlers.capabilities({}, afterRes);
  assert.equal(afterRes.payload.data.operations.upscale.available, true);
  assert.equal(afterRes.payload.data.operations.upscale.provider, 'aihubcc');
  assert.equal(afterRes.payload.data.operations.upscale.protocol, 'aihubcc');
  assert.equal(afterRes.payload.data.operations.upscale.model, 'gpt-image-2-3.5k');
});

test('真实图片供应商请求把存储根内绝对参考图编码为 data URL', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-outpaint-ref-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const sourcePath = path.join(storageRoot, 'source.png');
  const markedPath = path.join(storageRoot, 'marked.png');
  await sharp({
    create: {
      width: 4,
      height: 4,
      channels: 3,
      background: '#3267d6',
    },
  }).png().toFile(sourcePath);
  await sharp({
    create: {
      width: 4,
      height: 4,
      channels: 3,
      background: '#ef4444',
    },
  }).png().toFile(markedPath);

  let requestBody = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: [{ b64_json: Buffer.from('provider-result').toString('base64') }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  aiConfigService.createConfig(db, { info() {} }, {
    service_type: 'storyboard_image',
    provider: 'volcengine',
    api_protocol: 'volcengine',
    name: '参考图请求体测试',
    base_url: `http://127.0.0.1:${server.address().port}`,
    endpoint: '/images/generations',
    api_key: 'test-key',
    model: ['doubao-seedream-4-5'],
    default_model: 'doubao-seedream-4-5',
    is_default: true,
    settings: JSON.stringify({ supports_outpaint: true }),
  });

  const result = await imageClient.callImageApi(db, {
    info() {},
    warn() {},
    error() {},
  }, {
    prompt: '扩图',
    model: 'doubao-seedream-4-5',
    preferred_provider: 'volcengine',
    size: '1536x864',
    imageServiceType: 'storyboard_image',
    reference_image_urls: [sourcePath, markedPath],
    storage_local_path: storageRoot,
  });

  assert.ok(result.image_url);
  assert.equal(Array.isArray(requestBody.image), true);
  assert.equal(requestBody.image.length, 2);
  assert.match(requestBody.image[0], /^data:image\/png;base64,/);
  assert.match(requestBody.image[1], /^data:image\/png;base64,/);
  assert.doesNotMatch(requestBody.image[0], /molimama-outpaint-ref|source\.png/i);
  assert.doesNotMatch(requestBody.image[1], /molimama-outpaint-ref|marked\.png/i);
});

test('真实图片供应商 HTTP 错误日志不记录上游响应正文', async (t) => {
  const privateMessage = 'private-provider-response-secret';
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: privateMessage } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  const logEntries = [];
  const log = {
    info(message, details) {
      logEntries.push({ level: 'info', message, details });
    },
    warn(message, details) {
      logEntries.push({ level: 'warn', message, details });
    },
    error(message, details) {
      logEntries.push({ level: 'error', message, details });
    },
  };
  aiConfigService.createConfig(db, log, {
    service_type: 'storyboard_image',
    provider: 'volcengine',
    api_protocol: 'volcengine',
    name: 'Seedream 错误日志脱敏',
    base_url: `http://127.0.0.1:${server.address().port}/api/v3`,
    api_key: 'local-test-key',
    model: ['doubao-seedream-4-5'],
    default_model: 'doubao-seedream-4-5',
    is_default: true,
  });

  const result = await imageClient.callImageApi(db, log, {
    prompt: '电影级光影校正',
    model: 'doubao-seedream-4-5',
    preferred_provider: 'volcengine',
    size: '1024x1024',
    imageServiceType: 'storyboard_image',
  });

  assert.match(result.error, /图片生成请求失败/);
  assert.doesNotMatch(JSON.stringify(logEntries), new RegExp(privateMessage));
  const failedEntry = logEntries.find((entry) => entry.message === 'Image API failed');
  assert.equal(failedEntry.details.status, 500);
  assert.ok(failedEntry.details.response_bytes > 0);
  assert.equal('body' in failedEntry.details, false);
});

test('真实图片供应商成功响应解析失败或无图片时不记录上游正文', async (t) => {
  const malformedSecret = 'private-malformed-response-secret';
  const noImageSecret = 'private-no-image-response-secret';
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requestCount += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(requestCount === 1
        ? `not-json-${malformedSecret}`
        : JSON.stringify({ data: [], diagnostic: noImageSecret }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  const logEntries = [];
  const log = {
    info(message, details) {
      logEntries.push({ level: 'info', message, details });
    },
    warn(message, details) {
      logEntries.push({ level: 'warn', message, details });
    },
    error(message, details) {
      logEntries.push({ level: 'error', message, details });
    },
  };
  aiConfigService.createConfig(db, log, {
    service_type: 'storyboard_image',
    provider: 'volcengine',
    api_protocol: 'volcengine',
    name: 'Seedream 成功响应日志脱敏',
    base_url: `http://127.0.0.1:${server.address().port}/api/v3`,
    api_key: 'local-test-key',
    model: ['doubao-seedream-4-5'],
    default_model: 'doubao-seedream-4-5',
    is_default: true,
  });

  const request = {
    prompt: '电影级光影校正',
    model: 'doubao-seedream-4-5',
    preferred_provider: 'volcengine',
    size: '1024x1024',
    imageServiceType: 'storyboard_image',
  };
  const malformedResult = await imageClient.callImageApi(db, log, request);
  const noImageResult = await imageClient.callImageApi(db, log, request);

  assert.equal(malformedResult.error, '图片生成返回格式异常');
  assert.equal(noImageResult.error, '未返回图片地址');
  const serializedLogs = JSON.stringify(logEntries);
  assert.doesNotMatch(serializedLogs, new RegExp(malformedSecret));
  assert.doesNotMatch(serializedLogs, new RegExp(noImageSecret));
  const parseEntry = logEntries.find((entry) => entry.message === 'Image API response parse error');
  assert.ok(parseEntry.details.response_bytes > 0);
  assert.equal('raw_preview' in parseEntry.details, false);
  const noImageEntry = logEntries.find((entry) => entry.message === 'Image API no image URL in response');
  assert.ok(noImageEntry.details.response_bytes > 0);
  assert.deepEqual(noImageEntry.details.response_keys, ['data', 'diagnostic']);
  assert.equal('data_preview' in noImageEntry.details, false);
});

test('扩图下载在解码前执行大小限制', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-outpaint-limit-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const outputDir = path.join(storageRoot, 'derived');
  fs.mkdirSync(outputDir);

  await assert.rejects(
    imageToolService.saveOutpaintResult(
      `data:image/png;base64,${Buffer.alloc(2048).toString('base64')}`,
      outputDir,
      storageRoot,
      { maxBytes: 1024 },
    ),
    (error) => error.code === 'IMAGE_TOOL_PROCESSING_FAILED',
  );
  assert.equal(fs.readdirSync(outputDir).length, 0);
});

test('供应商产物下载的固定 DNS lookup 兼容 Node 单地址与 all 地址契约', async () => {
  const lookup = imageToolService.createPinnedLookup('203.0.113.10', 4);
  const single = await new Promise((resolve, reject) => {
    lookup('example.invalid', {}, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
  assert.deepEqual(single, { address: '203.0.113.10', family: 4 });

  const all = await new Promise((resolve, reject) => {
    lookup('example.invalid', { all: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });
  assert.deepEqual(all, [{ address: '203.0.113.10', family: 4 }]);
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
  assert.equal(res.payload.data.operations.selection_cutout.available, true);
  assert.equal(res.payload.data.operations.selection_cutout.engine, 'rembg');
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

test('固定二进制和模型哈希通过后才公布 Real-ESRGAN 高清能力', (t) => {
  const toolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-realesrgan-tool-'));
  t.after(() => fs.rmSync(toolRoot, { recursive: true, force: true }));
  const handlers = createImageToolRoutes(null, { error() {} }, {
    modelTools: {
      upscale: fakeUpscaleTool(toolRoot),
    },
    auditedUpscaleFiles: TEST_AUDITED_UPSCALE_FILES,
  });
  const res = responseRecorder();

  handlers.capabilities({}, res);

  assert.equal(res.payload.data.operations.upscale.available, true);
  assert.equal(res.payload.data.operations.upscale.engine, 'realesrgan-ncnn-vulkan');
  assert.equal(res.payload.data.operations.upscale.engineVersion, '0.2.5.0');
  assert.equal(res.payload.data.operations.upscale.model, 'realesrgan-x4plus');
  assert.deepEqual(res.payload.data.operations.upscale.scales, [2, 3, 4]);
  assert.equal(res.payload.data.operations.detail_enhance.available, true);
  assert.equal(
    res.payload.data.operations.detail_enhance.engine,
    'realesrgan-ncnn-vulkan+sharp',
  );
  assert.deepEqual(
    res.payload.data.operations.detail_enhance.presets,
    ['natural', 'balanced', 'strong'],
  );
  assert.equal(res.payload.data.operations.detail_enhance.preservesDimensions, true);
});

test('Real-ESRGAN 审计清单不包含不可再分发的调试运行库', () => {
  const serviceSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'imageToolService.js'),
    'utf8',
  );

  assert.doesNotMatch(serviceSource, /vcomp140d\.dll/i);
});

test('Real-ESRGAN 能力探针拒绝错误版本、缺失运行库和损坏模型', (t) => {
  const toolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-realesrgan-probe-'));
  t.after(() => fs.rmSync(toolRoot, { recursive: true, force: true }));
  const wrongVersion = fakeUpscaleTool(path.join(toolRoot, 'wrong-version'), [], {
    engineVersion: '9.9.9',
  });
  const missingRuntime = fakeUpscaleTool(path.join(toolRoot, 'missing-runtime'));
  fs.rmSync(path.join(missingRuntime.packageRoot, 'vcomp140.dll'));
  const damagedModel = fakeUpscaleTool(path.join(toolRoot, 'damaged-model'));
  fs.writeFileSync(path.join(damagedModel.modelDir, 'realesrgan-x4plus.bin'), 'damaged model');
  const relocatedExecutable = fakeUpscaleTool(path.join(toolRoot, 'relocated-executable'), [], {
    command: process.execPath,
  });

  for (const upscale of [wrongVersion, missingRuntime, damagedModel, relocatedExecutable]) {
    const handlers = createImageToolRoutes(null, { error() {} }, {
      modelTools: { upscale },
      auditedUpscaleFiles: TEST_AUDITED_UPSCALE_FILES,
    });
    const res = responseRecorder();
    handlers.capabilities({}, res);
    assert.equal(res.payload.data.operations.upscale.available, false);
  }
});

test('Real-ESRGAN 高清增强生成指定倍率派生素材并清洗失败错误', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-upscale-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, status, created_at, updated_at)
     VALUES ('高清增强测试', 'draft', ?, ?)`,
  ).run(now, now).lastInsertRowid;
  const sourcePath = path.join(storageRoot, 'source.png');
  await sharp({
    create: {
      width: 8,
      height: 6,
      channels: 3,
      background: '#5b8def',
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
      upscale: fakeUpscaleTool(storageRoot),
    },
    auditedUpscaleFiles: TEST_AUDITED_UPSCALE_FILES,
  });
  const successRes = responseRecorder();

  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-upscale',
      operation: 'upscale',
      parameters: { scale: 2 },
    },
  }, successRes);

  assert.equal(successRes.statusCode, 201, JSON.stringify(successRes.payload));
  const resultAsset = assetService.getById(db, successRes.payload.data.resultAssetId);
  const resultMetadata = await sharp(resultAsset.local_path).metadata();
  assert.equal(resultMetadata.width, 16);
  assert.equal(resultMetadata.height, 12);
  assert.equal(resultMetadata.format, 'png');
  assert.equal(resultAsset.metadata.operation, 'upscale');
  assert.equal(resultAsset.metadata.engine, 'realesrgan-ncnn-vulkan');
  assert.equal(resultAsset.metadata.engineVersion, '0.2.5.0');
  assert.deepEqual(resultAsset.metadata.parameters, {
    scale: 2,
    model: 'realesrgan-x4plus',
  });
  assert.equal(fs.existsSync(sourcePath), true);

  const invalidRes = responseRecorder();
  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-upscale-invalid',
      operation: 'upscale',
      parameters: { scale: 5 },
    },
  }, invalidRes);
  assert.equal(invalidRes.statusCode, 400);

  const failureHandlers = createImageToolRoutes(db, { info() {}, error() {} }, {
    cfg: { storage: { local_path: storageRoot } },
    modelTools: {
      upscale: fakeUpscaleTool(storageRoot, ['--fail']),
    },
    auditedUpscaleFiles: TEST_AUDITED_UPSCALE_FILES,
  });
  const failureRes = responseRecorder();
  await failureHandlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-upscale-failure',
      operation: 'upscale',
      parameters: { scale: 2 },
    },
  }, failureRes);
  assert.equal(failureRes.statusCode, 503);
  assert.equal(failureRes.payload.error.code, 'IMAGE_TOOL_PROCESSING_FAILED');
  assert.equal(failureRes.payload.error.message, '高清增强处理失败');
  assert.doesNotMatch(failureRes.payload.error.message, /fake Real-ESRGAN|molimama-upscale/i);
  const failedTask = db.prepare(
    "SELECT status, error FROM async_tasks WHERE type = 'image_tool_upscale' ORDER BY created_at DESC LIMIT 1",
  ).get();
  assert.equal(failedTask.status, 'failed');
  assert.equal(failedTask.error, '高清增强处理失败');
});

test('细节纹理增强复用 Real-ESRGAN 并保持源图尺寸', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-detail-enhance-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, status, created_at, updated_at)
     VALUES ('细节纹理增强测试', 'draft', ?, ?)`,
  ).run(now, now).lastInsertRowid;
  const sourcePath = path.join(storageRoot, 'source.png');
  await sharp({
    create: {
      width: 12,
      height: 8,
      channels: 3,
      background: '#6b7280',
    },
  }).png().toFile(sourcePath);
  const sourceBytes = fs.readFileSync(sourcePath);
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
      upscale: fakeUpscaleTool(storageRoot),
    },
    auditedUpscaleFiles: TEST_AUDITED_UPSCALE_FILES,
  });
  const successRes = responseRecorder();

  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-detail-enhance',
      operation: 'detail_enhance',
      parameters: { preset: 'balanced' },
    },
  }, successRes);

  assert.equal(successRes.statusCode, 201, JSON.stringify(successRes.payload));
  const resultAsset = assetService.getById(db, successRes.payload.data.resultAssetId);
  const resultMetadata = await sharp(resultAsset.local_path).metadata();
  assert.equal(resultMetadata.width, 12);
  assert.equal(resultMetadata.height, 8);
  assert.equal(resultMetadata.format, 'png');
  assert.equal(resultAsset.metadata.operation, 'detail_enhance');
  assert.equal(resultAsset.metadata.engine, 'realesrgan-ncnn-vulkan+sharp');
  assert.match(resultAsset.metadata.engineVersion, /^0\.2\.5\.0\+sharp-/);
  assert.deepEqual(resultAsset.metadata.parameters, {
    preset: 'balanced',
    scale: 2,
    model: 'realesrgan-x4plus',
    preserveDimensions: true,
  });
  assert.deepEqual(fs.readFileSync(sourcePath), sourceBytes);
  assert.equal(
    fs.readdirSync(path.dirname(resultAsset.local_path))
      .some((name) => name.includes('detail-enhance-upscale')),
    false,
  );

  const invalidRes = responseRecorder();
  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-detail-enhance-invalid',
      operation: 'detail_enhance',
      parameters: { preset: 'maximum' },
    },
  }, invalidRes);
  assert.equal(invalidRes.statusCode, 400);

  const failureHandlers = createImageToolRoutes(db, { info() {}, error() {} }, {
    cfg: { storage: { local_path: storageRoot } },
    modelTools: {
      upscale: fakeUpscaleTool(storageRoot, ['--fail']),
    },
    auditedUpscaleFiles: TEST_AUDITED_UPSCALE_FILES,
  });
  const failureRes = responseRecorder();
  await failureHandlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-detail-enhance-failure',
      operation: 'detail_enhance',
      parameters: { preset: 'natural' },
    },
  }, failureRes);
  assert.equal(failureRes.statusCode, 503);
  assert.equal(failureRes.payload.error.code, 'IMAGE_TOOL_PROCESSING_FAILED');
  assert.equal(failureRes.payload.error.message, '细节纹理增强处理失败');
  assert.doesNotMatch(
    failureRes.payload.error.message,
    /fake Real-ESRGAN|molimama-detail-enhance/i,
  );
  const failedTask = db.prepare(
    "SELECT status, error FROM async_tasks WHERE type = 'image_tool_detail_enhance' ORDER BY created_at DESC LIMIT 1",
  ).get();
  assert.equal(failedTask.status, 'failed');
  assert.equal(failedTask.error, '细节纹理增强处理失败');
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

  const selectionRes = responseRecorder();
  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-selection-cutout',
      operation: 'selection_cutout',
      parameters: { left: 2, top: 1, width: 4, height: 3 },
    },
  }, selectionRes);

  assert.equal(selectionRes.statusCode, 201, JSON.stringify(selectionRes.payload));
  const selectionAsset = assetService.getById(db, selectionRes.payload.data.resultAssetId);
  const selectionMetadata = await sharp(selectionAsset.local_path).metadata();
  assert.equal(selectionMetadata.width, 4);
  assert.equal(selectionMetadata.height, 3);
  assert.equal(selectionAsset.metadata.operation, 'selection_cutout');
  assert.deepEqual(selectionAsset.metadata.parameters, {
    model: 'u2netp',
    selectionMode: 'rectangle',
    left: 2,
    top: 1,
    width: 4,
    height: 3,
  });
  assert.equal(
    fs.readdirSync(path.dirname(selectionAsset.local_path))
      .some((name) => name.endsWith('-selection.png')),
    false
  );

  const brushSelectionRes = responseRecorder();
  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-selection-brush',
      operation: 'selection_cutout',
      parameters: {
        selectionMode: 'brush',
        brushStrokes: [{
          width: 0.2,
          points: [
            { x: 0.25, y: 0.2 },
            { x: 0.5, y: 0.5 },
            { x: 0.75, y: 0.8 },
          ],
        }],
      },
    },
  }, brushSelectionRes);

  assert.equal(brushSelectionRes.statusCode, 201, JSON.stringify(brushSelectionRes.payload));
  const brushAsset = assetService.getById(db, brushSelectionRes.payload.data.resultAssetId);
  assert.equal(brushAsset.metadata.parameters.selectionMode, 'brush');
  assert.equal(brushAsset.metadata.parameters.brushStrokes.length, 1);
  const brushMetadata = await sharp(brushAsset.local_path).metadata();
  assert.equal(brushMetadata.format, 'png');
  assert.equal(brushMetadata.hasAlpha, true);
  const alphaStats = await sharp(brushAsset.local_path).extractChannel('alpha').stats();
  assert.equal(alphaStats.channels[0].min, 0);
  assert.equal(alphaStats.channels[0].max, 255);

  const invalidSelectionRes = responseRecorder();
  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-selection-cutout-invalid',
      operation: 'selection_cutout',
      parameters: { left: 7, top: 5, width: 2, height: 2 },
    },
  }, invalidSelectionRes);
  assert.equal(invalidSelectionRes.statusCode, 400);
  assert.match(invalidSelectionRes.payload.error.message, /超出源图片/);
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
  const corruptSourcePath = path.join(storageRoot, 'corrupt-source.png');
  fs.writeFileSync(corruptSourcePath, 'not an image');
  const corruptSourceAsset = assetService.create(db, { info() {} }, {
    drama_id: dramaId,
    name: 'corrupt-source.png',
    type: 'image',
    category: 'canvas',
    url: '/static/corrupt-source.png',
    local_path: corruptSourcePath,
  });

  async function assertSecondRequestBusy(toolOverrides, tenantIds, requestOptions = {}) {
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
    const firstBody = {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-cutout-concurrency',
      operation: requestOptions.operation || 'smart_cutout',
      parameters: requestOptions.parameters || {},
    };
    const first = handlers.createOperation({
      tenant: { id: tenantIds[0] },
      body: firstBody,
    }, firstRes);
    await handlers.createOperation({
      tenant: { id: tenantIds[1] },
      body: {
        ...firstBody,
        assetId: requestOptions.secondAssetId || sourceAsset.id,
        sourceNodeId: 'image-node-cutout-concurrency-second',
      },
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
  await assertSecondRequestBusy(
    { maxConcurrency: 2, maxTenantConcurrency: 1 },
    ['tenant-a', 'tenant-a'],
    {
      operation: 'selection_cutout',
      parameters: { left: 0, top: 0, width: 4, height: 3 },
      secondAssetId: corruptSourceAsset.id,
    },
  );
});

test('框选抠图清洗损坏、超限源图和临时文件写入错误', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-selection-cutout-errors-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, status, created_at, updated_at)
     VALUES ('框选抠图错误清洗测试', 'draft', ?, ?)`,
  ).run(now, now).lastInsertRowid;
  const logEntries = [];
  const handlers = createImageToolRoutes(db, {
    info() {},
    error(message, details) {
      logEntries.push({ message, details });
    },
  }, {
    cfg: { storage: { local_path: storageRoot } },
    modelTools: {
      smart_cutout: fakeSmartCutoutTool(storageRoot),
    },
    auditedModelHashes: TEST_AUDITED_MODEL_HASHES,
  });

  const sources = [
    {
      name: 'corrupt-source.png',
      contents: 'not an image',
    },
    {
      name: 'oversized-source.svg',
      contents: '<svg xmlns="http://www.w3.org/2000/svg" width="10000" height="10000"></svg>',
    },
  ];
  for (const source of sources) {
    const sourcePath = path.join(storageRoot, source.name);
    fs.writeFileSync(sourcePath, source.contents);
    const sourceAsset = assetService.create(db, { info() {} }, {
      drama_id: dramaId,
      name: source.name,
      type: 'image',
      category: 'canvas',
      url: `/static/${source.name}`,
      local_path: sourcePath,
    });
    const res = responseRecorder();

    await handlers.createOperation({
      body: {
        assetId: sourceAsset.id,
        sourceNodeId: `image-node-${source.name}`,
        operation: 'selection_cutout',
        parameters: { left: 0, top: 0, width: 1, height: 1 },
      },
    }, res);

    assert.equal(res.statusCode, 503);
    assert.equal(res.payload.error.code, 'IMAGE_TOOL_PROCESSING_FAILED');
    assert.equal(res.payload.error.message, '框选抠图处理失败');
    assert.doesNotMatch(
      res.payload.error.message,
      /input|limit|pixel|svg|pngload|libvips|molimama-selection-cutout-errors/i,
    );
  }

  const validSourcePath = path.join(storageRoot, 'valid-source.png');
  await sharp({
    create: {
      width: 8,
      height: 6,
      channels: 4,
      background: '#ffffff',
    },
  }).png().toFile(validSourcePath);
  const validSourceAsset = assetService.create(db, { info() {} }, {
    drama_id: dramaId,
    name: 'valid-source.png',
    type: 'image',
    category: 'canvas',
    url: '/static/valid-source.png',
    local_path: validSourcePath,
  });
  const derivedPath = path.join(storageRoot, 'derived');
  fs.rmSync(derivedPath, { recursive: true, force: true });
  fs.writeFileSync(derivedPath, 'block derived directory creation');
  const writeFailureRes = responseRecorder();

  await handlers.createOperation({
    body: {
      assetId: validSourceAsset.id,
      sourceNodeId: 'image-node-selection-cutout-write-failure',
      operation: 'selection_cutout',
      parameters: { left: 0, top: 0, width: 4, height: 3 },
    },
  }, writeFailureRes);

  assert.equal(writeFailureRes.statusCode, 503);
  assert.equal(writeFailureRes.payload.error.code, 'IMAGE_TOOL_PROCESSING_FAILED');
  assert.equal(writeFailureRes.payload.error.message, '框选抠图处理失败');
  assert.doesNotMatch(
    writeFailureRes.payload.error.message,
    /EEXIST|derived|molimama-selection-cutout-errors/i,
  );
  const tasks = db.prepare('SELECT status, error FROM async_tasks ORDER BY created_at, id').all();
  assert.equal(tasks.length, 3);
  assert.equal(tasks.every((task) => task.status === 'failed'), true);
  assert.equal(tasks.every((task) => task.error === '框选抠图处理失败'), true);
  assert.equal(logEntries.length, 3);
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

test('扩图通过参考图供应商生成本地派生素材并保留原图', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-outpaint-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, status, created_at, updated_at)
     VALUES ('扩图测试', 'draft', ?, ?)`,
  ).run(now, now).lastInsertRowid;
  const sourcePath = path.join(storageRoot, 'source.png');
  await sharp({
    create: {
      width: 80,
      height: 80,
      channels: 3,
      background: '#5b8def',
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
  const generatedBuffer = await sharp({
    create: {
      width: 160,
      height: 90,
      channels: 3,
      background: '#f2c94c',
    },
  }).png().toBuffer();
  let generationRequest = null;
  const handlers = createImageToolRoutes(db, { info() {}, warn() {}, error() {} }, {
    cfg: { storage: { local_path: storageRoot } },
    referenceImageTool: {
      engine: 'provider-image-edit',
      provider: 'volcengine',
      protocol: 'volcengine',
      model: 'doubao-seedream-4-5',
      async generate(request) {
        generationRequest = request;
        return { image_url: `data:image/png;base64,${generatedBuffer.toString('base64')}` };
      },
    },
  });
  const res = responseRecorder();

  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-outpaint',
      operation: 'outpaint',
      parameters: {
        aspectRatio: '16:9',
        direction: 'right',
        top: 10,
        bottom: 20,
        left: 0,
        right: 60,
        prompt: '向右延伸室内窗景',
      },
    },
  }, res);

  assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
  assert.equal(res.payload.data.operation, 'outpaint');
  assert.equal(generationRequest.referenceImage, sourcePath);
  assert.equal(generationRequest.aspectRatio, '16:9');
  assert.match(generationRequest.prompt, /向右延伸/);
  assert.match(generationRequest.prompt, /上方 10%.*右侧 60%/);
  assert.match(generationRequest.prompt, /向右延伸室内窗景/);
  const resultAsset = assetService.getById(db, res.payload.data.resultAssetId);
  assert.ok(resultAsset);
  assert.notEqual(resultAsset.id, sourceAsset.id);
  assert.equal(resultAsset.metadata.operation, 'outpaint');
  assert.equal(resultAsset.metadata.engine, 'provider-image-edit');
  assert.equal(resultAsset.metadata.engineVersion, 'volcengine:doubao-seedream-4-5');
  assert.deepEqual(resultAsset.metadata.parameters, {
    aspectRatio: '16:9',
    direction: 'right',
    top: 10,
    bottom: 20,
    left: 0,
    right: 60,
    prompt: '向右延伸室内窗景',
  });
  assert.equal(fs.existsSync(sourcePath), true);
  assert.equal(fs.existsSync(resultAsset.local_path), true);
  const outputMetadata = await sharp(resultAsset.local_path).metadata();
  assert.equal(outputMetadata.width, 160);
  assert.equal(outputMetadata.height, 90);
  const task = taskService.getTask(db, res.payload.data.taskId);
  assert.equal(task.status, 'completed');
  assert.equal(JSON.parse(task.result).resultAssetId, resultAsset.id);

  const failedLogs = [];
  const failedLog = {
    info() {},
    warn(message, details) {
      failedLogs.push({ message, details });
    },
    error(message, details) {
      failedLogs.push({ message, details });
    },
  };
  const failedHandlers = createImageToolRoutes(db, failedLog, {
    cfg: { storage: { local_path: storageRoot } },
    referenceImageTool: {
      engine: 'provider-image-edit',
      provider: 'volcengine',
      protocol: 'volcengine',
      model: 'doubao-seedream-4-5',
      async generate() {
        return { error: 'upstream-secret-token' };
      },
    },
  });
  const failedRes = responseRecorder();
  await failedHandlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-outpaint-failure',
      operation: 'outpaint',
      parameters: { aspectRatio: '16:9', direction: 'auto' },
    },
  }, failedRes);
  assert.equal(failedRes.statusCode, 503);
  assert.equal(failedRes.payload.error.message, '扩图处理失败');
  assert.doesNotMatch(JSON.stringify(failedRes.payload), /upstream-secret-token/);
  const failedTaskId = db.prepare(
    "SELECT id FROM async_tasks WHERE type = 'image_tool_outpaint' AND status = 'failed' ORDER BY created_at DESC LIMIT 1",
  ).get().id;
  const failedTask = taskService.getTask(db, failedTaskId);
  assert.equal(failedTask.status, 'failed');
  assert.equal(failedTask.error, '扩图处理失败');
  assert.doesNotMatch(JSON.stringify(failedLogs), /upstream-secret-token/);

  const privateUrlHandlers = createImageToolRoutes(db, failedLog, {
    cfg: { storage: { local_path: storageRoot } },
    referenceImageTool: {
      engine: 'provider-image-edit',
      provider: 'volcengine',
      protocol: 'volcengine',
      model: 'doubao-seedream-4-5',
      async generate() {
        return { image_url: 'https://127.0.0.1/private-image.png?token=secret-query' };
      },
    },
  });
  const privateUrlRes = responseRecorder();
  await privateUrlHandlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-outpaint-ssrf',
      operation: 'outpaint',
      parameters: { aspectRatio: '16:9', direction: 'auto' },
    },
  }, privateUrlRes);
  assert.equal(privateUrlRes.statusCode, 503);
  assert.equal(privateUrlRes.payload.error.message, '扩图处理失败');
  assert.doesNotMatch(JSON.stringify(failedLogs), /secret-query|private-image/);

  const invalidOutputBuffers = [
    await sharp({
      create: {
        width: 160,
        height: 160,
        channels: 3,
        background: '#e05252',
      },
    }).png().toBuffer(),
    fs.readFileSync(sourcePath),
  ];
  for (const [index, invalidBuffer] of invalidOutputBuffers.entries()) {
    const invalidOutputHandlers = createImageToolRoutes(db, failedLog, {
      cfg: { storage: { local_path: storageRoot } },
      referenceImageTool: {
        engine: 'provider-image-edit',
        provider: 'volcengine',
        protocol: 'volcengine',
        model: 'doubao-seedream-4-5',
        async generate() {
          return {
            image_url: `data:image/png;base64,${invalidBuffer.toString('base64')}`,
          };
        },
      },
    });
    const invalidOutputRes = responseRecorder();
    await invalidOutputHandlers.createOperation({
      body: {
        assetId: sourceAsset.id,
        sourceNodeId: `image-node-outpaint-invalid-${index}`,
        operation: 'outpaint',
        parameters: { aspectRatio: '16:9', direction: 'auto' },
      },
    }, invalidOutputRes);
    assert.equal(invalidOutputRes.statusCode, 503);
    assert.equal(invalidOutputRes.payload.error.message, '扩图处理失败');
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM assets').get().total, 2);

  const junctionSourceDir = path.join(storageRoot, 'junction-case');
  const escapedOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-outpaint-escape-'));
  fs.mkdirSync(junctionSourceDir);
  const junctionSourcePath = path.join(junctionSourceDir, 'source.png');
  fs.copyFileSync(sourcePath, junctionSourcePath);
  const junctionDerivedDir = path.join(junctionSourceDir, 'derived');
  fs.symlinkSync(
    escapedOutputDir,
    junctionDerivedDir,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const junctionSourceAsset = assetService.create(db, { info() {} }, {
    drama_id: dramaId,
    name: 'junction-source.png',
    type: 'image',
    category: 'canvas',
    url: '/static/junction-case/source.png',
    local_path: junctionSourcePath,
  });
  const junctionHandlers = createImageToolRoutes(db, failedLog, {
    cfg: { storage: { local_path: storageRoot } },
    referenceImageTool: {
      engine: 'provider-image-edit',
      provider: 'volcengine',
      protocol: 'volcengine',
      model: 'doubao-seedream-4-5',
      async generate() {
        return { image_url: `data:image/png;base64,${generatedBuffer.toString('base64')}` };
      },
    },
  });
  const junctionRes = responseRecorder();
  await junctionHandlers.createOperation({
    body: {
      assetId: junctionSourceAsset.id,
      sourceNodeId: 'image-node-outpaint-junction',
      operation: 'outpaint',
      parameters: { aspectRatio: '16:9', direction: 'auto' },
    },
  }, junctionRes);
  assert.equal(junctionRes.statusCode, 400);
  assert.equal(fs.readdirSync(escapedOutputDir).length, 0);
  fs.rmSync(junctionDerivedDir, { force: true });
  fs.rmSync(escapedOutputDir, { recursive: true, force: true });
});

test('标记修图提交原图与临时标记图并生成同尺寸派生素材', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-markup-retouch-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, status, created_at, updated_at)
     VALUES ('标记修图测试', 'draft', ?, ?)`,
  ).run(now, now).lastInsertRowid;
  const sourcePath = path.join(storageRoot, 'source.png');
  await sharp({
    create: {
      width: 100,
      height: 80,
      channels: 3,
      background: '#3468d4',
    },
  }).png().toFile(sourcePath);
  const sourceHash = fileSha256(sourcePath);
  const sourceAsset = assetService.create(db, { info() {} }, {
    drama_id: dramaId,
    name: 'source.png',
    type: 'image',
    category: 'canvas',
    url: '/static/source.png',
    local_path: sourcePath,
  });
  const generatedBuffer = await sharp({
    create: {
      width: 125,
      height: 100,
      channels: 3,
      background: '#e6b84f',
    },
  }).png().toBuffer();
  let generationRequest = null;
  let generationCalls = 0;
  let markedReferenceHash = '';
  const handlers = createImageToolRoutes(db, { info() {}, warn() {}, error() {} }, {
    cfg: { storage: { local_path: storageRoot } },
    referenceImageTool: {
      engine: 'provider-image-edit',
      provider: 'volcengine',
      protocol: 'volcengine',
      model: 'doubao-seedream-4-5',
      operations: ['markup_retouch'],
      async generate(request) {
        generationCalls += 1;
        generationRequest = request;
        assert.equal(request.referenceImages.length, 2);
        assert.equal(request.referenceImages[0], sourcePath);
        assert.equal(fs.existsSync(request.referenceImages[1]), true);
        markedReferenceHash = fileSha256(request.referenceImages[1]);
        return { image_url: `data:image/png;base64,${generatedBuffer.toString('base64')}` };
      },
    },
  });
  const res = responseRecorder();

  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-markup-retouch',
      operation: 'markup_retouch',
      parameters: {
        instruction: '把标记区域改为暖黄色，其他内容保持不变',
        strokes: [{
          color: '#ef4444',
          width: 0.02,
          points: [
            { x: 0.2, y: 0.2 },
            { x: 0.45, y: 0.3 },
            { x: 0.6, y: 0.5 },
          ],
        }],
      },
    },
  }, res);

  assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
  assert.equal(res.payload.data.operation, 'markup_retouch');
  assert.match(generationRequest.prompt, /把标记区域改为暖黄色/);
  assert.match(generationRequest.prompt, /只修改图二标记覆盖的区域/);
  assert.match(generationRequest.prompt, /移除全部彩色标记/);
  assert.notEqual(markedReferenceHash, sourceHash);
  assert.equal(fs.existsSync(generationRequest.referenceImages[1]), false);
  assert.equal(fileSha256(sourcePath), sourceHash);

  const resultAsset = assetService.getById(db, res.payload.data.resultAssetId);
  assert.ok(resultAsset);
  assert.notEqual(resultAsset.id, sourceAsset.id);
  assert.equal(resultAsset.metadata.operation, 'markup_retouch');
  assert.equal(resultAsset.metadata.engine, 'provider-image-edit');
  assert.equal(resultAsset.metadata.engineVersion, 'volcengine:doubao-seedream-4-5');
  assert.deepEqual(resultAsset.metadata.parameters, {
    mode: 'retouch',
    instruction: '把标记区域改为暖黄色，其他内容保持不变',
    strokeCount: 1,
    pointCount: 3,
    preserveDimensions: true,
  });
  const outputMetadata = await sharp(resultAsset.local_path).metadata();
  assert.equal(outputMetadata.format, 'png');
  assert.equal(outputMetadata.width, 100);
  assert.equal(outputMetadata.height, 80);
  assert.equal(taskService.getTask(db, res.payload.data.taskId).status, 'completed');

  const markupOnlyRes = responseRecorder();
  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-markup-only',
      operation: 'markup_retouch',
      parameters: {
        mode: 'markup_only',
        strokes: [{
          kind: 'text',
          label: '重点',
          color: '#3b82f6',
          width: 0.02,
          points: [{ x: 0.2, y: 0.3 }, { x: 0.2, y: 0.3 }],
        }],
      },
    },
  }, markupOnlyRes);
  assert.equal(markupOnlyRes.statusCode, 201, JSON.stringify(markupOnlyRes.payload));
  assert.equal(generationCalls, 1);
  const markupOnlyAsset = assetService.getById(db, markupOnlyRes.payload.data.resultAssetId);
  assert.equal(markupOnlyAsset.metadata.parameters.mode, 'markup_only');
  assert.equal(markupOnlyAsset.metadata.engine, 'sharp');
  assert.match(markupOnlyAsset.metadata.engineVersion, /^sharp-/);
  assert.notEqual(fileSha256(markupOnlyAsset.local_path), sourceHash);
  assert.equal((await sharp(markupOnlyAsset.local_path).metadata()).format, 'png');

  const localOnlyHandlers = createImageToolRoutes(db, { info() {}, warn() {}, error() {} }, {
    cfg: { storage: { local_path: storageRoot } },
  });
  const localOnlyRes = responseRecorder();
  await localOnlyHandlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-markup-only-without-provider',
      operation: 'markup_retouch',
      parameters: {
        mode: 'markup_only',
        strokes: [{
          kind: 'rectangle',
          color: '#22c55e',
          width: 0.02,
          points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.6 }],
        }],
      },
    },
  }, localOnlyRes);
  assert.equal(localOnlyRes.statusCode, 201, JSON.stringify(localOnlyRes.payload));
  const localOnlyAsset = assetService.getById(db, localOnlyRes.payload.data.resultAssetId);
  assert.equal(localOnlyAsset.metadata.engine, 'sharp');
  assert.equal(localOnlyAsset.metadata.parameters.mode, 'markup_only');

  const unconfiguredRetouchRes = responseRecorder();
  await localOnlyHandlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-retouch-without-provider',
      operation: 'markup_retouch',
      parameters: {
        instruction: '修改矩形区域',
        strokes: [{
          kind: 'rectangle',
          color: '#22c55e',
          width: 0.02,
          points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.6 }],
        }],
      },
    },
  }, unconfiguredRetouchRes);
  assert.equal(unconfiguredRetouchRes.statusCode, 503);
  assert.equal(unconfiguredRetouchRes.payload.error.code, 'IMAGE_TOOL_OPERATION_UNAVAILABLE');

  const invalidRes = responseRecorder();
  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-markup-invalid',
      operation: 'markup_retouch',
      parameters: {
        instruction: '',
        strokes: [],
      },
    },
  }, invalidRes);
  assert.equal(invalidRes.statusCode, 400);
  assert.equal(invalidRes.payload.error.code, 'BAD_REQUEST');

  const failedLogs = [];
  const failedHandlers = createImageToolRoutes(db, {
    info() {},
    warn(message, details) {
      failedLogs.push({ message, details });
    },
    error(message, details) {
      failedLogs.push({ message, details });
    },
  }, {
    cfg: { storage: { local_path: storageRoot } },
    referenceImageTool: {
      engine: 'provider-image-edit',
      provider: 'volcengine',
      protocol: 'volcengine',
      model: 'doubao-seedream-4-5',
      operations: ['markup_retouch'],
      async generate() {
        return { error: 'private-upstream-secret' };
      },
    },
  });
  const failedRes = responseRecorder();
  await failedHandlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-markup-failure',
      operation: 'markup_retouch',
      parameters: {
        instruction: '删除标记区域的物体',
        strokes: [{
          color: '#ef4444',
          width: 0.02,
          points: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.3 }],
        }],
      },
    },
  }, failedRes);
  assert.equal(failedRes.statusCode, 503);
  assert.equal(failedRes.payload.error.message, '标记修图处理失败');
  assert.doesNotMatch(JSON.stringify(failedRes.payload), /private-upstream-secret/);
  assert.doesNotMatch(JSON.stringify(failedLogs), /private-upstream-secret/);
  const failedTask = db.prepare(
    "SELECT status, error FROM async_tasks WHERE type = 'image_tool_markup_retouch' ORDER BY rowid DESC LIMIT 1",
  ).get();
  assert.equal(failedTask.status, 'failed');
  assert.equal(failedTask.error, '标记修图处理失败');
  const derivedDir = path.join(storageRoot, 'derived');
  const remainingFiles = fs.existsSync(derivedDir)
    ? fs.readdirSync(derivedDir).filter((name) => /markup-reference|provider-download/i.test(name))
    : [];
  assert.deepEqual(remainingFiles, []);

  const corruptSourcePath = path.join(storageRoot, 'corrupt-markup-source.png');
  fs.writeFileSync(corruptSourcePath, 'not an image');
  const corruptSourceAsset = assetService.create(db, { info() {} }, {
    drama_id: dramaId,
    name: 'corrupt-markup-source.png',
    type: 'image',
    category: 'canvas',
    url: '/static/corrupt-markup-source.png',
    local_path: corruptSourcePath,
  });
  const corruptRes = responseRecorder();
  await failedHandlers.createOperation({
    body: {
      assetId: corruptSourceAsset.id,
      sourceNodeId: 'image-node-markup-corrupt-source',
      operation: 'markup_retouch',
      parameters: {
        instruction: '删除标记区域的物体',
        strokes: [{
          color: '#ef4444',
          width: 0.02,
          points: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.3 }],
        }],
      },
    },
  }, corruptRes);
  assert.equal(corruptRes.statusCode, 400);
  assert.equal(corruptRes.payload.error.code, 'BAD_REQUEST');
  assert.equal(corruptRes.payload.error.message, '仅支持 PNG、JPEG 和 WebP 图片');
  const corruptTask = db.prepare(
    "SELECT status, error FROM async_tasks WHERE type = 'image_tool_markup_retouch' ORDER BY rowid DESC LIMIT 1",
  ).get();
  assert.equal(corruptTask.status, 'failed');
  assert.equal(corruptTask.error, '仅支持 PNG、JPEG 和 WebP 图片');
  const exposedFailureText = JSON.stringify({
    response: corruptRes.payload,
    logs: failedLogs,
    task: corruptTask,
  });
  assert.doesNotMatch(exposedFailureText, /sharp|corrupt-markup-source|not an image|Input file/i);
  const remainingAfterCorruptSource = fs.existsSync(derivedDir)
    ? fs.readdirSync(derivedDir).filter((name) => /markup-reference|provider-download/i.test(name))
    : [];
  assert.deepEqual(remainingAfterCorruptSource, []);
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

test('公开模式拒绝用本项目素材行别名读取其他项目的物理文件', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-image-tools-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  const owner = userAuthService.register(db, {
    email: 'path-owner@example.com',
    password: 'correct horse battery staple',
  });
  const attacker = userAuthService.register(db, {
    email: 'path-attacker@example.com',
    password: 'correct horse battery staple',
  });
  const ownerTenant = tenantService.createTenant(db, owner.id, {
    name: '物理文件所属团队',
    slug: 'path-owner',
  });
  const attackerTenant = tenantService.createTenant(db, attacker.id, {
    name: '伪造路径团队',
    slug: 'path-attacker',
  });
  const now = new Date().toISOString();
  const createDrama = db.prepare(
    `INSERT INTO dramas (tenant_id, user_id, title, status, created_at, updated_at)
     VALUES (?, ?, ?, 'draft', ?, ?)`,
  );
  const ownerDramaId = createDrama.run(
    ownerTenant.id,
    owner.id,
    '物理文件所属项目',
    now,
    now,
  ).lastInsertRowid;
  const attackerDramaId = createDrama.run(
    attackerTenant.id,
    attacker.id,
    '伪造素材所属项目',
    now,
    now,
  ).lastInsertRowid;
  const ownerDir = path.join(
    storageRoot,
    storageLayout.getProjectStorageSubdir(db, ownerDramaId),
    'uploads',
  );
  const attackerDir = path.join(
    storageRoot,
    storageLayout.getProjectStorageSubdir(db, attackerDramaId),
    'uploads',
  );
  fs.mkdirSync(ownerDir, { recursive: true });
  fs.mkdirSync(attackerDir, { recursive: true });
  const ownerPath = path.join(ownerDir, 'private.png');
  await sharp({
    create: {
      width: 4,
      height: 3,
      channels: 4,
      background: '#ff0000',
    },
  }).png().toFile(ownerPath);
  const aliasedAsset = assetService.create(db, { info() {} }, {
    drama_id: attackerDramaId,
    name: 'aliased-private.png',
    type: 'image',
    category: 'canvas',
    url: '/static/aliased-private.png',
    local_path: path.relative(storageRoot, ownerPath),
    mime_type: 'image/png',
    width: 4,
    height: 3,
  });
  const handlers = createImageToolRoutes(db, { info() {}, error() {} }, {
    cfg: { storage: { local_path: storageRoot } },
    publicPlatformEnabled: true,
  });
  const res = responseRecorder();

  await handlers.createOperation({
    user: { id: attacker.id },
    tenant: { id: attackerTenant.id },
    body: {
      assetId: aliasedAsset.id,
      operation: 'crop',
      parameters: { left: 0, top: 0, width: 1, height: 1 },
    },
  }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.success, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM async_tasks').get().total, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM assets').get().total, 1);
  assert.equal(fs.existsSync(path.join(ownerDir, 'derived')), false);

  const attackerPath = path.join(attackerDir, 'owned.png');
  fs.copyFileSync(ownerPath, attackerPath);
  const ownedAsset = assetService.create(db, { info() {} }, {
    drama_id: attackerDramaId,
    name: 'owned.png',
    type: 'image',
    category: 'canvas',
    url: '/static/owned.png',
    local_path: path.relative(storageRoot, attackerPath),
    mime_type: 'image/png',
    width: 4,
    height: 3,
  });
  const ownedRes = responseRecorder();

  await handlers.createOperation({
    user: { id: attacker.id },
    tenant: { id: attackerTenant.id },
    body: {
      assetId: ownedAsset.id,
      operation: 'crop',
      parameters: { left: 0, top: 0, width: 1, height: 1 },
    },
  }, ownedRes);

  assert.equal(ownedRes.statusCode, 201, JSON.stringify(ownedRes.payload));
  const derivedAsset = assetService.getById(db, ownedRes.payload.data.resultAssetId);
  assert.equal(isPathInside(attackerDir, derivedAsset.local_path), true);
  assert.equal(isPathInside(ownerDir, derivedAsset.local_path), false);

  const ownerProjectRoot = path.dirname(ownerDir);
  const attackerProjectRoot = path.dirname(attackerDir);
  fs.rmSync(attackerProjectRoot, { recursive: true, force: true });
  fs.symlinkSync(
    ownerProjectRoot,
    attackerProjectRoot,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const junctionAsset = assetService.create(db, { info() {} }, {
    drama_id: attackerDramaId,
    name: 'junction-private.png',
    type: 'image',
    category: 'canvas',
    url: '/static/junction-private.png',
    local_path: path.relative(storageRoot, path.join(attackerDir, 'private.png')),
    mime_type: 'image/png',
    width: 4,
    height: 3,
  });
  const taskCountBeforeJunctionAttack = db.prepare(
    'SELECT COUNT(*) AS total FROM async_tasks',
  ).get().total;
  const junctionRes = responseRecorder();

  await handlers.createOperation({
    user: { id: attacker.id },
    tenant: { id: attackerTenant.id },
    body: {
      assetId: junctionAsset.id,
      operation: 'crop',
      parameters: { left: 0, top: 0, width: 1, height: 1 },
    },
  }, junctionRes);

  assert.equal(junctionRes.statusCode, 400);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS total FROM async_tasks').get().total,
    taskCountBeforeJunctionAttack,
  );
  assert.equal(fs.existsSync(path.join(ownerDir, 'derived')), false);
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

test('宫格裁剪兼容只有项目静态 URL 的历史图片素材', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-image-tools-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const owner = userAuthService.register(db, {
    email: 'legacy-static-asset@example.com',
    password: 'correct horse battery staple',
  });
  const tenant = tenantService.createTenant(db, owner.id, {
    name: '历史素材团队',
    slug: 'legacy-static-asset',
  });
  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (tenant_id, user_id, title, status, created_at, updated_at)
     VALUES (?, ?, '历史静态素材', 'draft', ?, ?)`,
  ).run(tenant.id, owner.id, now, now).lastInsertRowid;
  const relativeSourcePath = path.join(
    storageLayout.getProjectStorageSubdir(db, dramaId),
    'images',
    'legacy-grid.png',
  );
  const sourcePath = path.join(storageRoot, relativeSourcePath);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
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
    name: 'legacy-grid.png',
    type: 'image',
    category: 'canvas',
    url: `/static/${relativeSourcePath.replace(/\\/g, '/')}`,
    local_path: null,
  });
  const handlers = createImageToolRoutes(db, { info() {}, error() {} }, {
    cfg: { storage: { local_path: storageRoot } },
    publicPlatformEnabled: true,
  });
  const res = responseRecorder();

  await handlers.createOperation({
    user: { id: owner.id },
    tenant: { id: tenant.id },
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'legacy-grid-node',
      operation: 'grid_crop',
      parameters: { rows: 2, columns: 2, selectedCells: ['0:0'] },
    },
  }, res);

  assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
  assert.equal(res.payload.data.resultAssets.length, 1);
  assert.equal(fs.existsSync(assetService.getById(
    db,
    res.payload.data.resultAssetId,
  ).local_path), true);
});

test('宫格裁剪仅返回选中派生素材并保留首图兼容字段', async (t) => {
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
      width: 8,
      height: 8,
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
      parameters: {
        rows: 2,
        columns: 2,
        spacing: 2,
        selectedCells: ['0:1', '1:0'],
        duplicateCells: ['0:1'],
      },
    },
  }, res);

  assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
  assert.equal(res.payload.data.resultAssets.length, 3);
  assert.equal(res.payload.data.resultAssetId, res.payload.data.resultAssets[0].id);
  assert.equal(res.payload.data.resultUrl, res.payload.data.resultAssets[0].url);
  for (const item of res.payload.data.resultAssets) {
    assert.equal(['0:1', '1:0'].includes(`${item.row}:${item.column}`), true);
    const resultAsset = assetService.getById(db, item.id);
    assert.equal(resultAsset.metadata.operation, 'grid_crop');
    assert.equal(resultAsset.metadata.parameters.spacing, 2);
    const metadata = await sharp(resultAsset.local_path).metadata();
    assert.equal(metadata.width, 2);
    assert.equal(metadata.height, 2);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM assets').get().total, 4);
  assert.equal(fs.existsSync(sourcePath), true);
});

test('图片调整保存完整参数并通过 CPU 生成差异素材', async (t) => {
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
        exposure: 0.4,
        brightness: 1.2,
        vibrance: 1.1,
        saturation: 0.8,
        contrast: 1.1,
        highlights: 0.2,
        shadows: -0.1,
        whites: 0.15,
        blacks: -0.2,
        temperature: 0.4,
        tint: -0.2,
        hue: 12,
        sharpness: 0.3,
        clarity: 0.2,
        grain: 0.1,
        blur: 0,
        vignette: 0.25,
        softLight: 0.1,
        glow: 0.2,
        curves: {
          rgb: [[0, 0], [0.5, 0.6], [1, 1]],
          red: [[0, 0], [1, 1]],
          green: [[0, 0], [1, 1]],
          blue: [[0, 0], [1, 1]],
        },
      },
    },
  }, res);

  assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
  const resultAsset = assetService.getById(db, res.payload.data.resultAssetId);
  assert.deepEqual(resultAsset.metadata.parameters, {
    exposure: 0.4,
    brightness: 1.2,
    vibrance: 1.1,
    saturation: 0.8,
    contrast: 1.1,
    highlights: 0.2,
    shadows: -0.1,
    whites: 0.15,
    blacks: -0.2,
    temperature: 0.4,
    tint: -0.2,
    hue: 12,
    sharpness: 0.3,
    clarity: 0.2,
    grain: 0.1,
    blur: 0,
    vignette: 0.25,
    softLight: 0.1,
    glow: 0.2,
    curves: {
      rgb: [[0, 0], [0.5, 0.6], [1, 1]],
      red: [[0, 0], [1, 1]],
      green: [[0, 0], [1, 1]],
      blue: [[0, 0], [1, 1]],
    },
  });
  assert.notEqual(
    fs.readFileSync(resultAsset.local_path).toString('base64'),
    fs.readFileSync(sourcePath).toString('base64'),
  );

  const invalidCurveRes = responseRecorder();
  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-invalid-curve',
      operation: 'adjust',
      parameters: {
        curves: {
          rgb: [[0.1, 0], [0.9, 1]],
        },
      },
    },
  }, invalidCurveRes);
  assert.equal(invalidCurveRes.statusCode, 400);
  assert.match(invalidCurveRes.payload.error.message, /curves\.rgb/);

  const presetLutRes = responseRecorder();
  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-preset-lut',
      operation: 'lut',
      parameters: {
        preset: 'teal_orange',
        intensity: 0.7,
        manual: { exposure: 0.1, contrast: 1.1, saturation: 1.05, temperature: -0.1 },
      },
    },
  }, presetLutRes);
  assert.equal(presetLutRes.statusCode, 201, JSON.stringify(presetLutRes.payload));
  assert.deepEqual(
    assetService.getById(db, presetLutRes.payload.data.resultAssetId).metadata.parameters.manual,
    { exposure: 0.1, contrast: 1.1, saturation: 1.05, temperature: -0.1 },
  );

  const customRes = responseRecorder();
  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-custom-lut',
      operation: 'lut',
      parameters: {
        preset: 'custom',
        intensity: 1,
        customLut: {
          name: 'invert-2.cube',
          size: 2,
          values: [
            [1, 1, 1], [0, 1, 1],
            [1, 0, 1], [0, 0, 1],
            [1, 1, 0], [0, 1, 0],
            [1, 0, 0], [0, 0, 0],
          ],
        },
      },
    },
  }, customRes);
  assert.equal(customRes.statusCode, 201, JSON.stringify(customRes.payload));
  const customAsset = assetService.getById(db, customRes.payload.data.resultAssetId);
  assert.deepEqual(customAsset.metadata.parameters, {
    preset: 'custom',
    intensity: 1,
    manual: { exposure: 0, contrast: 1, saturation: 1, temperature: 0 },
    customLut: { name: 'invert-2.cube', size: 2 },
  });
  const customPixel = await sharp(customAsset.local_path).raw().toBuffer();
  assert.ok(customPixel[0] > 140);
  assert.ok(customPixel[1] > 100);
  assert.ok(customPixel[2] < 100);
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
      parameters: { preset: 'cinematic', intensity: 0.65 },
    },
  }, res);

  assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
  const resultAsset = assetService.getById(db, res.payload.data.resultAssetId);
  assert.deepEqual(resultAsset.metadata.parameters, {
    preset: 'cinematic',
    intensity: 0.65,
    manual: { exposure: 0, contrast: 1, saturation: 1, temperature: 0 },
  });
  assert.notEqual(
    fs.readFileSync(resultAsset.local_path).toString('base64'),
    fs.readFileSync(sourcePath).toString('base64'),
  );
});

test('电影级光影校正通过参考图供应商生成同尺寸派生素材并保留原图', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-cinematic-relight-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, status, created_at, updated_at)
     VALUES ('电影级光影校正测试', 'draft', ?, ?)`,
  ).run(now, now).lastInsertRowid;
  const sourcePath = path.join(storageRoot, 'source.png');
  await sharp({
    create: {
      width: 96,
      height: 64,
      channels: 3,
      background: '#3468d4',
    },
  }).png().toFile(sourcePath);
  const sourceHash = fileSha256(sourcePath);
  const sourceAsset = assetService.create(db, { info() {} }, {
    drama_id: dramaId,
    name: 'source.png',
    type: 'image',
    category: 'canvas',
    url: '/static/source.png',
    local_path: sourcePath,
  });
  const generatedBuffer = await sharp({
    create: {
      width: 120,
      height: 80,
      channels: 3,
      background: '#e6b84f',
    },
  }).png().toBuffer();
  let generationRequest = null;
  const referenceImageTool = {
    engine: 'provider-image-edit',
    provider: 'volcengine',
    protocol: 'volcengine',
    model: 'doubao-seedream-4-5',
    operations: ['cinematic_relight'],
    async generate(request) {
      generationRequest = request;
      return { image_url: `data:image/png;base64,${generatedBuffer.toString('base64')}` };
    },
  };
  const handlers = createImageToolRoutes(db, { info() {}, warn() {}, error() {} }, {
    cfg: { storage: { local_path: storageRoot } },
    referenceImageTool,
  });
  const res = responseRecorder();

  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-cinematic-relight',
      operation: 'cinematic_relight',
      parameters: {
        preset: 'golden_hour',
        intensity: 4,
        description: '保留人物面部，增加窗外暖色轮廓光',
      },
    },
  }, res);

  assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
  assert.equal(res.payload.data.operation, 'cinematic_relight');
  assert.equal(generationRequest.referenceImage, sourcePath);
  assert.equal(generationRequest.size, '96x64');
  assert.match(generationRequest.prompt, /黄金时刻/);
  assert.match(generationRequest.prompt, /强度 4\/5/);
  assert.match(generationRequest.prompt, /增加窗外暖色轮廓光/);
  assert.match(generationRequest.systemPrompt, /source image/i);
  assert.equal(fileSha256(sourcePath), sourceHash);

  const resultAsset = assetService.getById(db, res.payload.data.resultAssetId);
  assert.ok(resultAsset);
  assert.notEqual(resultAsset.id, sourceAsset.id);
  assert.equal(resultAsset.metadata.operation, 'cinematic_relight');
  assert.equal(resultAsset.metadata.engine, 'provider-image-edit');
  assert.equal(resultAsset.metadata.engineVersion, 'volcengine:doubao-seedream-4-5');
  assert.deepEqual(resultAsset.metadata.parameters, {
    preset: 'golden_hour',
    intensity: 4,
    description: '保留人物面部，增加窗外暖色轮廓光',
    preserveDimensions: true,
  });
  const outputMetadata = await sharp(resultAsset.local_path).metadata();
  assert.equal(outputMetadata.format, 'png');
  assert.equal(outputMetadata.width, 96);
  assert.equal(outputMetadata.height, 64);
  assert.notEqual(fileSha256(resultAsset.local_path), sourceHash);
  assert.equal(taskService.getTask(db, res.payload.data.taskId).status, 'completed');

  for (const parameters of [
    { preset: 'unknown', intensity: 3, description: '' },
    { preset: 'cinematic', intensity: 0, description: '' },
    { preset: 'cinematic', intensity: 2.5, description: '' },
    { preset: 'cinematic', intensity: '3', description: '' },
    { preset: 'cinematic', intensity: true, description: '' },
    { preset: ['cinematic'], intensity: 3, description: '' },
    { preset: 'cinematic', intensity: 3, description: 123 },
    { preset: 'cinematic', intensity: 3, description: 'x'.repeat(301) },
    { preset: 'cinematic', intensity: 3, description: `${'x'.repeat(290)}${' '.repeat(20)}y` },
  ]) {
    const invalidRes = responseRecorder();
    await handlers.createOperation({
      body: {
        assetId: sourceAsset.id,
        sourceNodeId: 'image-node-cinematic-relight-invalid',
        operation: 'cinematic_relight',
        parameters,
      },
    }, invalidRes);
    assert.equal(invalidRes.statusCode, 400);
    assert.equal(invalidRes.payload.error.code, 'BAD_REQUEST');
  }

  const failedLogs = [];
  const failedHandlers = createImageToolRoutes(db, {
    info() {},
    warn(message, details) {
      failedLogs.push({ message, details });
    },
    error(message, details) {
      failedLogs.push({ message, details });
    },
  }, {
    cfg: { storage: { local_path: storageRoot } },
    referenceImageTool: {
      ...referenceImageTool,
      async generate() {
        return { error: 'private-upstream-secret' };
      },
    },
  });
  const failedRes = responseRecorder();
  await failedHandlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-cinematic-relight-failure',
      operation: 'cinematic_relight',
      parameters: { preset: 'cinematic', intensity: 3, description: '' },
    },
  }, failedRes);
  assert.equal(failedRes.statusCode, 503);
  assert.equal(failedRes.payload.error.message, '电影级光影校正处理失败');
  assert.doesNotMatch(JSON.stringify(failedRes.payload), /private-upstream-secret/);
  assert.doesNotMatch(JSON.stringify(failedLogs), /private-upstream-secret/);

  const unchangedHandlers = createImageToolRoutes(db, {
    info() {}, warn() {}, error() {},
  }, {
    cfg: { storage: { local_path: storageRoot } },
    referenceImageTool: {
      ...referenceImageTool,
      async generate() {
        return {
          image_url: `data:image/png;base64,${fs.readFileSync(sourcePath).toString('base64')}`,
        };
      },
    },
  });
  const unchangedRes = responseRecorder();
  await unchangedHandlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-cinematic-relight-unchanged',
      operation: 'cinematic_relight',
      parameters: { preset: 'studio_soft', intensity: 2, description: '' },
    },
  }, unchangedRes);
  assert.equal(unchangedRes.statusCode, 503);
  assert.equal(unchangedRes.payload.error.message, '电影级光影校正处理失败');

  const jpegSourcePath = path.join(storageRoot, 'source.jpg');
  await sharp({
    create: {
      width: 96,
      height: 64,
      channels: 3,
      background: '#7e5d36',
    },
  }).jpeg({ quality: 90 }).toFile(jpegSourcePath);
  const jpegSourceAsset = assetService.create(db, { info() {} }, {
    drama_id: dramaId,
    name: 'source.jpg',
    type: 'image',
    category: 'canvas',
    url: '/static/source.jpg',
    local_path: jpegSourcePath,
  });
  const unchangedJpegHandlers = createImageToolRoutes(db, {
    info() {}, warn() {}, error() {},
  }, {
    cfg: { storage: { local_path: storageRoot } },
    referenceImageTool: {
      ...referenceImageTool,
      async generate() {
        return {
          image_url: `data:image/jpeg;base64,${fs.readFileSync(jpegSourcePath).toString('base64')}`,
        };
      },
    },
  });
  const unchangedJpegRes = responseRecorder();
  await unchangedJpegHandlers.createOperation({
    body: {
      assetId: jpegSourceAsset.id,
      sourceNodeId: 'image-node-cinematic-relight-unchanged-jpeg',
      operation: 'cinematic_relight',
      parameters: { preset: 'moonlight', intensity: 3, description: '' },
    },
  }, unchangedJpegRes);
  assert.equal(unchangedJpegRes.statusCode, 503);
  assert.equal(unchangedJpegRes.payload.error.message, '电影级光影校正处理失败');

  const derivedDir = path.join(storageRoot, 'derived');
  const temporaryFiles = fs.existsSync(derivedDir)
    ? fs.readdirSync(derivedDir).filter((name) => /relight-provider-download/i.test(name))
    : [];
  assert.deepEqual(temporaryFiles, []);
});

test('AIHubCC gpt-image-2-3.5k 配置开放全部已审计图片节点能力', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  const log = { info() {}, error() {} };
  aiConfigService.createConfig(db, log, {
    service_type: 'storyboard_image',
    provider: 'aihubcc',
    api_protocol: 'aihubcc',
    name: 'AIHubCC 图片节点',
    base_url: 'https://aihubcc.cc/v1',
    api_key: 'test-key',
    model: ['gpt-image-2-3.5k'],
    default_model: 'gpt-image-2-3.5k',
    is_default: true,
    settings: JSON.stringify({
      supports_outpaint: true,
      supports_markup_retouch: true,
      supports_upscale: true,
      supports_detail_enhance: true,
      supports_cinematic_relight: true,
      supports_panorama: true,
      supports_panorama_scene: true,
      supports_image_ideation: true,
      supports_angle_ideation: true,
      supports_character_views: true,
      supports_narrative_grid: true,
      supports_frame_forward: true,
      supports_frame_backward: true,
    }),
  });
  const handlers = createImageToolRoutes(db, log);
  const res = responseRecorder();
  handlers.capabilities({}, res);
  for (const operation of [
    'outpaint',
    'markup_retouch',
    'upscale',
    'detail_enhance',
    'cinematic_relight',
    'panorama',
    'panorama_scene',
    'image_ideation',
    'angle_ideation',
    'character_views',
    'narrative_grid',
    'frame_forward',
    'frame_backward',
  ]) {
    assert.equal(res.payload.data.operations[operation].available, true, operation);
    assert.equal(res.payload.data.operations[operation].protocol, 'aihubcc', operation);
    assert.equal(res.payload.data.operations[operation].model, 'gpt-image-2-3.5k', operation);
  }
});

test('无 GPU 环境通过 Seedream 参考图供应商完成高清与细节增强', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-provider-enhance-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, status, created_at, updated_at)
     VALUES ('远程增强测试', 'draft', ?, ?)`,
  ).run(now, now).lastInsertRowid;
  const sourcePath = path.join(storageRoot, 'source.png');
  await sharp({
    create: {
      width: 32,
      height: 24,
      channels: 3,
      background: '#305ea8',
    },
  }).png().toFile(sourcePath);
  const sourceHash = fileSha256(sourcePath);
  const sourceAsset = assetService.create(db, { info() {} }, {
    drama_id: dramaId,
    name: 'source.png',
    type: 'image',
    category: 'canvas',
    url: '/static/source.png',
    local_path: sourcePath,
  });
  const generatedBuffer = await sharp({
    create: {
      width: 80,
      height: 60,
      channels: 3,
      background: '#d6a43a',
    },
  }).png().toBuffer();
  const requests = [];
  const handlers = createImageToolRoutes(db, { info() {}, warn() {}, error() {} }, {
    cfg: { storage: { local_path: storageRoot } },
    referenceImageTool: {
      engine: 'provider-image-edit',
      provider: 'volcengine',
      protocol: 'volcengine',
      model: 'doubao-seedream-4-5-251128',
      operations: ['upscale', 'detail_enhance'],
      async generate(request) {
        requests.push(request);
        return { image_url: `data:image/png;base64,${generatedBuffer.toString('base64')}` };
      },
    },
  });

  const upscaleRes = responseRecorder();
  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-provider-upscale',
      operation: 'upscale',
      parameters: { scale: 2 },
    },
  }, upscaleRes);
  assert.equal(upscaleRes.statusCode, 201, JSON.stringify(upscaleRes.payload));
  assert.equal(requests[0].referenceImage, sourcePath);
  assert.equal(requests[0].size, '64x48');
  assert.match(requests[0].prompt, /高清增强/);
  const upscaleAsset = assetService.getById(db, upscaleRes.payload.data.resultAssetId);
  const upscaleMetadata = await sharp(upscaleAsset.local_path).metadata();
  assert.equal(upscaleMetadata.width, 64);
  assert.equal(upscaleMetadata.height, 48);
  assert.equal(upscaleAsset.metadata.engine, 'provider-image-edit');
  assert.equal(upscaleAsset.metadata.parameters.scale, 2);

  const detailRes = responseRecorder();
  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-provider-detail',
      operation: 'detail_enhance',
      parameters: { preset: 'strong' },
    },
  }, detailRes);
  assert.equal(detailRes.statusCode, 201, JSON.stringify(detailRes.payload));
  assert.equal(requests[1].size, '32x24');
  assert.match(requests[1].prompt, /细节纹理增强/);
  assert.match(requests[1].prompt, /强烈/);
  const detailAsset = assetService.getById(db, detailRes.payload.data.resultAssetId);
  const detailMetadata = await sharp(detailAsset.local_path).metadata();
  assert.equal(detailMetadata.width, 32);
  assert.equal(detailMetadata.height, 24);
  assert.equal(detailAsset.metadata.parameters.preset, 'strong');
  assert.equal(detailAsset.metadata.parameters.preserveDimensions, true);
  assert.equal(fileSha256(sourcePath), sourceHash);

  const invalidRes = responseRecorder();
  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      operation: 'upscale',
      parameters: { scale: 5 },
    },
  }, invalidRes);
  assert.equal(invalidRes.statusCode, 400);

  const failureLogs = [];
  const failedHandlers = createImageToolRoutes(db, {
    info() {},
    warn(message, details) {
      failureLogs.push({ message, details });
    },
    error(message, details) {
      failureLogs.push({ message, details });
    },
  }, {
    cfg: { storage: { local_path: storageRoot } },
    referenceImageTool: {
      engine: 'provider-image-edit',
      provider: 'volcengine',
      protocol: 'volcengine',
      model: 'doubao-seedream-4-5-251128',
      operations: ['upscale'],
      async generate() {
        return { error: 'private-provider-enhance-secret' };
      },
    },
  });
  const failedRes = responseRecorder();
  await failedHandlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      operation: 'upscale',
      parameters: { scale: 2 },
    },
  }, failedRes);
  assert.equal(failedRes.statusCode, 503);
  assert.equal(failedRes.payload.error.message, '高清增强处理失败');
  assert.doesNotMatch(JSON.stringify(failedRes.payload), /private-provider-enhance-secret/);
  assert.doesNotMatch(JSON.stringify(failureLogs), /private-provider-enhance-secret/);
});

test('720全景通过参考图供应商生成固定 2:1 等距柱状新素材', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-panorama-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, status, created_at, updated_at)
     VALUES ('720全景测试', 'draft', ?, ?)`,
  ).run(now, now).lastInsertRowid;
  const sourcePath = path.join(storageRoot, 'source.png');
  await sharp({
    create: {
      width: 96,
      height: 64,
      channels: 3,
      background: '#35668a',
    },
  }).png().toFile(sourcePath);
  const sourceHash = fileSha256(sourcePath);
  const sourceAsset = assetService.create(db, { info() {} }, {
    drama_id: dramaId,
    name: 'source.png',
    type: 'image',
    category: 'canvas',
    url: '/static/source.png',
    local_path: sourcePath,
  });
  const panoramaBuffer = await sharp({
    create: {
      width: 384,
      height: 192,
      channels: 3,
      background: '#d79b55',
    },
  }).png().toBuffer();
  let generationRequest = null;
  const referenceImageTool = {
    engine: 'provider-image-edit',
    provider: 'volcengine',
    protocol: 'volcengine',
    model: 'doubao-seedream-4-5',
    operations: ['panorama'],
    async generate(request) {
      generationRequest = request;
      return { image_url: `data:image/png;base64,${panoramaBuffer.toString('base64')}` };
    },
  };
  const handlers = createImageToolRoutes(db, { info() {}, warn() {}, error() {} }, {
    cfg: { storage: { local_path: storageRoot } },
    referenceImageTool,
  });
  const res = responseRecorder();

  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-panorama',
      operation: 'panorama',
      parameters: { description: '保持山谷中央的木屋' },
    },
  }, res);

  assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
  assert.equal(res.payload.data.operation, 'panorama');
  assert.equal(generationRequest.referenceImage, sourcePath);
  assert.equal(generationRequest.size, '3840x1920');
  assert.match(generationRequest.prompt, /360/);
  assert.match(generationRequest.prompt, /等距柱状/);
  assert.match(generationRequest.prompt, /左右边缘必须无缝/);
  assert.match(generationRequest.prompt, /保持山谷中央的木屋/);
  assert.equal(fileSha256(sourcePath), sourceHash);

  const resultAsset = assetService.getById(db, res.payload.data.resultAssetId);
  assert.ok(resultAsset);
  assert.notEqual(resultAsset.id, sourceAsset.id);
  assert.equal(resultAsset.metadata.operation, 'panorama');
  assert.equal(resultAsset.metadata.engine, 'provider-image-edit');
  assert.equal(resultAsset.metadata.engineVersion, 'volcengine:doubao-seedream-4-5');
  assert.deepEqual(resultAsset.metadata.parameters, {
    description: '保持山谷中央的木屋',
    projection: 'equirectangular',
    outputSize: '3840x1920',
  });
  const outputMetadata = await sharp(resultAsset.local_path).metadata();
  assert.equal(outputMetadata.format, 'png');
  assert.equal(outputMetadata.width, 3840);
  assert.equal(outputMetadata.height, 1920);
  assert.notEqual(fileSha256(resultAsset.local_path), sourceHash);
  assert.equal(taskService.getTask(db, res.payload.data.taskId).status, 'completed');

  let sceneRequest = null;
  const sceneHandlers = createImageToolRoutes(db, { info() {}, warn() {}, error() {} }, {
    cfg: { storage: { local_path: storageRoot } },
    referenceImageTool: {
      ...referenceImageTool,
      operations: ['panorama_scene'],
      async generate(request) {
        sceneRequest = request;
        return { image_url: `data:image/png;base64,${panoramaBuffer.toString('base64')}` };
      },
    },
  });
  const sceneRes = responseRecorder();
  await sceneHandlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-panorama-scene',
      operation: 'panorama_scene',
      parameters: { description: '扩展为夜间森林营地' },
    },
  }, sceneRes);
  assert.equal(sceneRes.statusCode, 201, JSON.stringify(sceneRes.payload));
  assert.equal(sceneRes.payload.data.operation, 'panorama_scene');
  assert.match(sceneRequest.prompt, /完整 360° 环境/);
  assert.match(sceneRequest.prompt, /扩展为夜间森林营地/);
  const sceneAsset = assetService.getById(db, sceneRes.payload.data.resultAssetId);
  assert.equal(sceneAsset.metadata.operation, 'panorama_scene');
  assert.equal(sceneAsset.metadata.parameters.projection, 'equirectangular');

  for (const description of [123, ['场景'], 'x'.repeat(301)]) {
    const invalidRes = responseRecorder();
    await handlers.createOperation({
      body: {
        assetId: sourceAsset.id,
        sourceNodeId: 'image-node-panorama-invalid',
        operation: 'panorama',
        parameters: { description },
      },
    }, invalidRes);
    assert.equal(invalidRes.statusCode, 400);
    assert.equal(invalidRes.payload.error.code, 'BAD_REQUEST');
  }

  const failedLogs = [];
  const failedHandlers = createImageToolRoutes(db, {
    info() {},
    warn(message, details) {
      failedLogs.push({ message, details });
    },
    error(message, details) {
      failedLogs.push({ message, details });
    },
  }, {
    cfg: { storage: { local_path: storageRoot } },
    referenceImageTool: {
      ...referenceImageTool,
      async generate() {
        return { error: 'private-panorama-upstream-secret' };
      },
    },
  });
  const failedRes = responseRecorder();
  await failedHandlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-panorama-failure',
      operation: 'panorama',
      parameters: { description: '' },
    },
  }, failedRes);
  assert.equal(failedRes.statusCode, 503);
  assert.equal(failedRes.payload.error.message, '720全景处理失败');
  assert.doesNotMatch(JSON.stringify(failedRes.payload), /private-panorama-upstream-secret/);
  assert.doesNotMatch(JSON.stringify(failedLogs), /private-panorama-upstream-secret/);

  const wrongRatioBuffer = await sharp({
    create: {
      width: 300,
      height: 200,
      channels: 3,
      background: '#657f42',
    },
  }).png().toBuffer();
  const normalizedHandlers = createImageToolRoutes(db, { info() {}, warn() {}, error() {} }, {
    cfg: { storage: { local_path: storageRoot } },
    referenceImageTool: {
      ...referenceImageTool,
      async generate() {
        return { image_url: `data:image/png;base64,${wrongRatioBuffer.toString('base64')}` };
      },
    },
  });
  const normalizedRes = responseRecorder();
  await normalizedHandlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-panorama-normalized',
      operation: 'panorama',
      parameters: { description: '' },
    },
  }, normalizedRes);
  assert.equal(normalizedRes.statusCode, 201, JSON.stringify(normalizedRes.payload));
  const normalizedAsset = assetService.getById(db, normalizedRes.payload.data.resultAssetId);
  const normalizedMetadata = await sharp(normalizedAsset.local_path).metadata();
  assert.equal(normalizedMetadata.width, 3840);
  assert.equal(normalizedMetadata.height, 1920);

  const rejectedHandlers = createImageToolRoutes(db, { info() {}, warn() {}, error() {} }, {
    cfg: { storage: { local_path: storageRoot } },
    referenceImageTool: {
      ...referenceImageTool,
      async generate() {
        return {
          image_url: `data:image/png;base64,${fs.readFileSync(sourcePath).toString('base64')}`,
        };
      },
    },
  });
  const rejectedRes = responseRecorder();
  await rejectedHandlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-panorama-rejected',
      operation: 'panorama',
      parameters: { description: '' },
    },
  }, rejectedRes);
  assert.equal(rejectedRes.statusCode, 503);
  assert.equal(rejectedRes.payload.error.message, '720全景处理失败');

  const derivedDir = path.join(storageRoot, 'derived');
  const temporaryFiles = fs.existsSync(derivedDir)
    ? fs.readdirSync(derivedDir).filter((name) => /panorama-provider-download/i.test(name))
    : [];
  assert.deepEqual(temporaryFiles, []);
});

test('画面联想通过参考图供应商生成同尺寸派生素材并保留原图', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-image-ideation-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, status, created_at, updated_at)
     VALUES ('画面联想测试', 'draft', ?, ?)`,
  ).run(now, now).lastInsertRowid;
  const sourcePath = path.join(storageRoot, 'source.png');
  await sharp({
    create: {
      width: 96,
      height: 64,
      channels: 3,
      background: '#294f72',
    },
  }).png().toFile(sourcePath);
  const sourceHash = fileSha256(sourcePath);
  const sourceAsset = assetService.create(db, { info() {} }, {
    drama_id: dramaId,
    name: 'source.png',
    type: 'image',
    category: 'canvas',
    url: '/static/source.png',
    local_path: sourcePath,
  });
  const generatedBuffer = await sharp({
    create: {
      width: 192,
      height: 128,
      channels: 3,
      background: '#c07a45',
    },
  }).png().toBuffer();
  let generationRequest = null;
  const referenceImageTool = {
    engine: 'provider-image-edit',
    provider: 'volcengine',
    protocol: 'volcengine',
    model: 'doubao-seedream-4-5',
    operations: ['image_ideation'],
    async generate(request) {
      generationRequest = request;
      return { image_url: `data:image/png;base64,${generatedBuffer.toString('base64')}` };
    },
  };
  const handlers = createImageToolRoutes(db, { info() {}, warn() {}, error() {} }, {
    cfg: { storage: { local_path: storageRoot } },
    referenceImageTool,
  });
  const res = responseRecorder();

  await handlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-image-ideation',
      operation: 'image_ideation',
      parameters: { description: '联想为雨后黄昏，但保留中央人物' },
    },
  }, res);

  assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
  assert.equal(res.payload.data.operation, 'image_ideation');
  assert.equal(generationRequest.referenceImage, sourcePath);
  assert.equal(generationRequest.size, '96x64');
  assert.match(generationRequest.prompt, /画面联想/);
  assert.match(generationRequest.prompt, /雨后黄昏/);
  assert.equal(fileSha256(sourcePath), sourceHash);

  const resultAsset = assetService.getById(db, res.payload.data.resultAssetId);
  assert.ok(resultAsset);
  assert.notEqual(resultAsset.id, sourceAsset.id);
  assert.equal(resultAsset.metadata.operation, 'image_ideation');
  assert.equal(resultAsset.metadata.engine, 'provider-image-edit');
  assert.deepEqual(resultAsset.metadata.parameters, {
    description: '联想为雨后黄昏，但保留中央人物',
    outputSize: '96x64',
  });
  const outputMetadata = await sharp(resultAsset.local_path).metadata();
  assert.equal(outputMetadata.format, 'png');
  assert.equal(outputMetadata.width, 96);
  assert.equal(outputMetadata.height, 64);
  assert.notEqual(fileSha256(resultAsset.local_path), sourceHash);
  assert.equal(taskService.getTask(db, res.payload.data.taskId).status, 'completed');

  for (const variation of [
    {
      operation: 'angle_ideation',
      requestSize: '96x64',
      width: 96,
      height: 64,
      prompt: /新机位/,
    },
    {
      operation: 'character_views',
      requestSize: '2048x1536',
      width: 2048,
      height: 1536,
      prompt: /正面、侧面、背面和 3\/4 视角/,
    },
    {
      operation: 'narrative_grid',
      requestSize: '3072x3072',
      width: 3072,
      height: 3072,
      prompt: /3×3 多机位叙事九宫格/,
    },
    {
      operation: 'frame_forward',
      requestSize: '96x64',
      width: 96,
      height: 64,
      prompt: /3 秒后/,
    },
    {
      operation: 'frame_backward',
      requestSize: '96x64',
      width: 96,
      height: 64,
      prompt: /5 秒前/,
    },
  ]) {
    const variationBuffer = await sharp({
      create: {
        width: variation.width,
        height: variation.height,
        channels: 3,
        background: '#8d5cb6',
      },
    }).png().toBuffer();
    let variationRequest = null;
    const variationHandlers = createImageToolRoutes(db, { info() {}, warn() {}, error() {} }, {
      cfg: { storage: { local_path: storageRoot } },
      referenceImageTool: {
        ...referenceImageTool,
        operations: [variation.operation],
        async generate(request) {
          variationRequest = request;
          return { image_url: `data:image/png;base64,${variationBuffer.toString('base64')}` };
        },
      },
    });
    const variationRes = responseRecorder();
    await variationHandlers.createOperation({
      body: {
        assetId: sourceAsset.id,
        sourceNodeId: `image-node-${variation.operation}`,
        operation: variation.operation,
        parameters: { description: '保持角色服装和场景连续性' },
      },
    }, variationRes);
    assert.equal(variationRes.statusCode, 201, JSON.stringify(variationRes.payload));
    assert.equal(variationRequest.size, variation.requestSize);
    assert.match(variationRequest.prompt, variation.prompt);
    const variationAsset = assetService.getById(db, variationRes.payload.data.resultAssetId);
    const variationMetadata = await sharp(variationAsset.local_path).metadata();
    assert.equal(variationMetadata.width, variation.width);
    assert.equal(variationMetadata.height, variation.height);
    assert.equal(variationAsset.metadata.operation, variation.operation);
    assert.equal(variationAsset.metadata.parameters.outputSize, variation.requestSize);
    assert.equal(fileSha256(sourcePath), sourceHash);
  }

  for (const description of [123, ['画面'], 'x'.repeat(301)]) {
    const invalidRes = responseRecorder();
    await handlers.createOperation({
      body: {
        assetId: sourceAsset.id,
        sourceNodeId: 'image-node-image-ideation-invalid',
        operation: 'image_ideation',
        parameters: { description },
      },
    }, invalidRes);
    assert.equal(invalidRes.statusCode, 400);
    assert.equal(invalidRes.payload.error.code, 'BAD_REQUEST');
  }

  const failureLogs = [];
  const failedHandlers = createImageToolRoutes(db, {
    info() {},
    warn(message, details) {
      failureLogs.push({ message, details });
    },
    error(message, details) {
      failureLogs.push({ message, details });
    },
  }, {
    cfg: { storage: { local_path: storageRoot } },
    referenceImageTool: {
      ...referenceImageTool,
      async generate() {
        return { error: 'private-reference-variation-secret' };
      },
    },
  });
  const failedRes = responseRecorder();
  await failedHandlers.createOperation({
    body: {
      assetId: sourceAsset.id,
      sourceNodeId: 'image-node-image-ideation-failed',
      operation: 'image_ideation',
      parameters: { description: '' },
    },
  }, failedRes);
  assert.equal(failedRes.statusCode, 503);
  assert.equal(failedRes.payload.error.message, '画面联想失败');
  assert.doesNotMatch(JSON.stringify(failedRes.payload), /private-reference-variation-secret/);
  assert.doesNotMatch(JSON.stringify(failureLogs), /private-reference-variation-secret/);

  const wrongRatioBuffer = await sharp({
    create: {
      width: 100,
      height: 100,
      channels: 3,
      background: '#407c56',
    },
  }).png().toBuffer();
  for (const imageUrl of [
    `data:image/png;base64,${wrongRatioBuffer.toString('base64')}`,
    `data:image/png;base64,${fs.readFileSync(sourcePath).toString('base64')}`,
  ]) {
    const rejectedHandlers = createImageToolRoutes(db, { info() {}, warn() {}, error() {} }, {
      cfg: { storage: { local_path: storageRoot } },
      referenceImageTool: {
        ...referenceImageTool,
        async generate() {
          return { image_url: imageUrl };
        },
      },
    });
    const rejectedRes = responseRecorder();
    await rejectedHandlers.createOperation({
      body: {
        assetId: sourceAsset.id,
        sourceNodeId: 'image-node-image-ideation-rejected',
        operation: 'image_ideation',
        parameters: { description: '' },
      },
    }, rejectedRes);
    assert.equal(rejectedRes.statusCode, 503);
    assert.equal(rejectedRes.payload.error.message, '画面联想失败');
  }

  const derivedDir = path.join(storageRoot, 'derived');
  const temporaryFiles = fs.existsSync(derivedDir)
    ? fs.readdirSync(derivedDir).filter((name) => /ideation-provider-download/i.test(name))
    : [];
  assert.deepEqual(temporaryFiles, []);
});
