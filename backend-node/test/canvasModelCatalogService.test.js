const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiConfigService = require('../src/services/aiConfigService');
const aiConfigRoutes = require('../src/routes/aiConfig');
const modelPriceService = require('../src/services/modelPriceService');
const { list, parseModels, safeCapabilities } = require('../src/services/canvasModelCatalogService');

const log = { info() {}, error() {}, errorw() {} };

test('canvas model catalog parses model lists without exposing config secrets', () => {
  assert.deepEqual(parseModels('["v1","v2"]'), ['v1', 'v2']);
  assert.deepEqual(parseModels('v1,v2'), ['v1', 'v2']);
  assert.deepEqual(safeCapabilities(JSON.stringify({
    api_key: 'secret',
    canvas_capabilities: { durations: [5, 10] },
  })), { durations: [5, 10] });
});

test('画布目录自动公开配置内全部已验证且已定价模型并使用管理员前端名称', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const verified = aiConfigService.createConfig(db, log, {
    service_type: 'image',
    provider: 'openai',
    name: '图片供应商',
    base_url: 'https://image.example/v1',
    api_key: 'secret',
    model: ['image-one', 'image-two', 'image-unpriced'],
    default_model: 'image-two',
    is_active: true,
  });
  aiConfigService.setVerificationResult(db, verified.id, 'verified');
  aiConfigService.createConfig(db, log, {
    service_type: 'image',
    provider: 'openai',
    name: '未验证图片供应商',
    base_url: 'https://unverified.example/v1',
    api_key: 'secret',
    model: ['image-unverified'],
    default_model: 'image-unverified',
    is_active: true,
  });
  modelPriceService.set(db, 'image-one', 18, {
    category: 'image',
    displayName: '写实图片 Pro',
  });
  modelPriceService.set(db, 'image-two', 26, {
    category: 'image',
    displayName: '角色一致性 Max',
  });
  modelPriceService.set(db, 'image-unverified', 30, { category: 'image' });

  assert.deepEqual(
    list(db).filter((item) => item.kind === 'image').map((item) => ({
      model: item.model,
      label: item.label,
      credits: item.credits,
    })),
    [
      { model: 'image-two', label: '角色一致性 Max', credits: 26 },
      { model: 'image-one', label: '写实图片 Pro', credits: 18 },
    ],
  );
});

test('Token6688 画布目录按模型公开图片参考上限和 Seedance 9/3/9 能力', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const imageConfig = aiConfigService.createConfig(db, log, {
    service_type: 'image',
    provider: 'token6688',
    api_protocol: 'token6688',
    name: 'Token6688 图片',
    base_url: 'https://qd.token6688.com',
    api_key: 'secret',
    model: ['doubao-seedream-5-0', 'token6688-gpt-image-2', 'gemini-3-pro-image'],
    default_model: 'token6688-gpt-image-2',
    settings: JSON.stringify({
      real_generation_verified_models: ['doubao-seedream-5-0', 'token6688-gpt-image-2', 'gemini-3-pro-image'],
    }),
  });
  const existingGptImageConfig = aiConfigService.createConfig(db, log, {
    service_type: 'image',
    provider: 'openai',
    api_protocol: 'openai',
    name: '现有 GPT Image 2 供应商',
    base_url: 'https://image.example/v1',
    api_key: 'secret',
    model: ['gpt-image-2'],
    default_model: 'gpt-image-2',
  });
  const videoConfig = aiConfigService.createConfig(db, log, {
    service_type: 'video',
    provider: 'token6688',
    api_protocol: 'token6688',
    name: 'Token6688 视频',
    base_url: 'https://qd.token6688.com',
    api_key: 'secret',
    model: ['seedance-2-0-special-mini-720p', 'seedance-2-0-special-fast-720p', 'seedance-2-0-special-full-720p'],
    default_model: 'seedance-2-0-special-mini-720p',
    settings: JSON.stringify({
      real_generation_verified_models: ['seedance-2-0-special-mini-720p', 'seedance-2-0-special-fast-720p', 'seedance-2-0-special-full-720p'],
    }),
  });
  const connectionOnlyConfig = aiConfigService.createConfig(db, log, {
    service_type: 'image',
    provider: 'token6688',
    api_protocol: 'token6688',
    name: '仅连接验证配置',
    base_url: 'https://qd.token6688.com',
    api_key: 'secret',
    model: ['token6688-unverified-image'],
    default_model: 'token6688-unverified-image',
  });
  aiConfigService.setVerificationResult(db, imageConfig.id, 'verified');
  aiConfigService.setVerificationResult(db, existingGptImageConfig.id, 'verified');
  aiConfigService.setVerificationResult(db, videoConfig.id, 'verified');
  aiConfigService.setVerificationResult(db, connectionOnlyConfig.id, 'verified');
  for (const [model, category, credits] of [
    ['doubao-seedream-5-0', 'image', 60],
    ['gpt-image-2', 'image', 40],
    ['token6688-gpt-image-2', 'image', 60],
    ['gemini-3-pro-image', 'image', 60],
    ['seedance-2-0-special-mini-720p', 'video', 650],
    ['seedance-2-0-special-fast-720p', 'video', 960],
    ['seedance-2-0-special-full-720p', 'video', 2120],
    ['token6688-unverified-image', 'image', 1],
  ]) modelPriceService.set(db, model, credits, { category });

  const entries = list(db);
  assert.equal(entries.filter((item) => ['gpt-image-2', 'token6688-gpt-image-2'].includes(item.model)).length, 2);
  assert.equal(entries.some((item) => item.model === 'token6688-unverified-image'), false);
  assert.equal(entries.find((item) => item.model === 'doubao-seedream-5-0').capabilities.maxReferences, 3);
  assert.equal(entries.find((item) => item.model === 'token6688-gpt-image-2').capabilities.maxReferences, 9);
  assert.equal(entries.find((item) => item.model === 'gemini-3-pro-image').capabilities.maxReferences, 3);
  assert.deepEqual(
    entries
      .filter((item) => ['doubao-seedream-5-0', 'token6688-gpt-image-2', 'gemini-3-pro-image'].includes(item.model))
      .map((item) => item.credits),
    [60, 60, 60],
  );
  assert.equal(entries.some((item) => item.model === 'seedance-2-0-special-mini-720p'), true);
  const video = entries.find((item) => item.model === 'seedance-2-0-special-fast-720p');
  assert.deepEqual(video.capabilities.referenceTypes, ['image', 'video', 'audio']);
  assert.equal(video.capabilities.maxImageReferences, 9);
  assert.equal(video.capabilities.maxVideoReferences, 3);
  assert.equal(video.capabilities.maxAudioReferences, 9);
  assert.deepEqual(video.capabilities.durations, [15]);
  assert.deepEqual(video.capabilities.resolutions, ['720p']);

  const publicPrices = modelPriceService.listPublic(db);
  assert.equal(publicPrices.some((item) => item.model === 'token6688-unverified-image'), false);
  assert.equal(publicPrices.some((item) => item.model === 'seedance-2-0-special-mini-720p'), true);
  assert.equal(publicPrices.some((item) => item.model === 'seedance-2-0-special-fast-720p'), true);

  let imageRoutePayload;
  aiConfigRoutes(db, log, {}).listPublicImageModels({}, {
    status() { return this; },
    json(payload) { imageRoutePayload = payload; return this; },
  });
  assert.equal(imageRoutePayload.data.includes('token6688-unverified-image'), false);
  assert.equal(imageRoutePayload.data.includes('token6688-gpt-image-2'), true);
});
