const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiConfigService = require('../src/services/aiConfigService');
const canvasModelCatalogService = require('../src/services/canvasModelCatalogService');
const imageClient = require('../src/services/imageClient');
const modelPriceService = require('../src/services/modelPriceService');
const videoClient = require('../src/services/videoClient');
const aiConfigRoutes = require('../src/routes/aiConfig');

const log = { info() {}, error() {}, errorw() {} };

function createVerifiedConfig(db, values) {
  const config = aiConfigService.createConfig(db, log, values);
  aiConfigService.setVerificationResult(db, config.id, 'verified');
  return config;
}

function capture() {
  let payload;
  return {
    res: {
      status() { return this; },
      json(body) { payload = body; return this; },
    },
    payload: () => payload,
  };
}

function assertPublicRouteIdentityHidden(value, privateValues = []) {
  const serialized = JSON.stringify(value);
  for (const field of ['"config_id"', '"provider"', '"upstream_model"', '"base_url"', '"api_key"']) {
    assert.equal(serialized.includes(field), false, field);
  }
  for (const privateValue of ['cfg-', ...privateValues]) {
    assert.equal(serialized.includes(privateValue), false, privateValue);
  }
}

test('不同图片供应商的同名上游模型使用独立逻辑模型并精确路由', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const first = createVerifiedConfig(db, {
    service_type: 'image', provider: 'provider-a', name: '供应商 A',
    base_url: 'https://a.example/v1', api_key: 'secret-a',
    model: ['shared-image'], default_model: 'shared-image',
    logical_model_id: 'catalog-image-alpha',
  });
  const second = createVerifiedConfig(db, {
    service_type: 'image', provider: 'provider-b', name: '供应商 B',
    base_url: 'https://b.example/v1', api_key: 'secret-b',
    model: ['shared-image'], default_model: 'shared-image',
    logical_model_id: 'catalog-image-beta',
  });
  createVerifiedConfig(db, {
    service_type: 'image', provider: 'provider-c', name: '未定价供应商',
    base_url: 'https://c.example/v1', api_key: 'secret-c',
    model: ['unpriced-image'], default_model: 'unpriced-image',
  });

  const firstSelection = 'catalog-image-alpha';
  const secondSelection = 'catalog-image-beta';
  modelPriceService.set(db, firstSelection, 31, { category: 'image', displayName: '图片模式甲' });
  modelPriceService.set(db, secondSelection, 42, { category: 'image', displayName: '图片模式乙' });

  const catalog = canvasModelCatalogService.list(db).filter((item) => item.kind === 'image');
  assert.deepEqual(catalog.map((item) => item.model).sort(), [firstSelection, secondSelection].sort());
  assert.equal(catalog.find((item) => item.model === firstSelection).label, '图片模式甲');
  assert.equal(catalog.find((item) => item.model === secondSelection).label, '图片模式乙');

  const firstConfig = imageClient.getDefaultImageConfig(db, firstSelection, null, 'image');
  const secondConfig = imageClient.getDefaultImageConfig(db, secondSelection, null, 'image');
  assert.equal(firstConfig.id, first.id);
  assert.equal(firstConfig.default_model, 'shared-image');
  assert.equal(secondConfig.id, second.id);
  assert.equal(secondConfig.default_model, 'shared-image');

  const result = capture();
  aiConfigRoutes(db, log, {}).listPublicImageModels({}, result.res);
  assert.deepEqual(result.payload().data.sort(), [firstSelection, secondSelection].sort());
  assertPublicRouteIdentityHidden([catalog, result.payload()], [
    'provider-a', 'provider-b', '供应商 A', '供应商 B', 'a.example', 'b.example',
    'secret-a', 'secret-b', 'shared-image',
  ]);
});

test('不同视频供应商的同名上游模型使用独立逻辑模型并精确路由', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const first = createVerifiedConfig(db, {
    service_type: 'video', provider: 'provider-a', name: '视频供应商 A',
    base_url: 'https://a.example/v1', api_key: 'secret-a',
    model: ['shared-video'], default_model: 'shared-video',
    logical_model_id: 'catalog-video-alpha',
  });
  const second = createVerifiedConfig(db, {
    service_type: 'video', provider: 'provider-b', name: '视频供应商 B',
    base_url: 'https://b.example/v1', api_key: 'secret-b',
    model: ['shared-video'], default_model: 'shared-video',
    logical_model_id: 'catalog-video-beta',
  });
  const firstSelection = 'catalog-video-alpha';
  const secondSelection = 'catalog-video-beta';
  modelPriceService.set(db, firstSelection, 11, { category: 'video' });
  modelPriceService.set(db, secondSelection, 22, { category: 'video' });

  const catalog = canvasModelCatalogService.list(db).filter((item) => item.kind === 'video');
  assert.deepEqual(catalog.map((item) => item.model).sort(), [firstSelection, secondSelection].sort());
  assert.equal(videoClient.getDefaultVideoConfig(db, firstSelection).id, first.id);
  assert.equal(videoClient.getDefaultVideoConfig(db, secondSelection).id, second.id);

  const result = capture();
  aiConfigRoutes(db, log, {}).listPublicVideoModels({}, result.res);
  assert.deepEqual(result.payload().data.sort(), [firstSelection, secondSelection].sort());
  assertPublicRouteIdentityHidden([catalog, result.payload()], [
    'provider-a', 'provider-b', 'a.example', 'b.example', 'secret-a', 'secret-b', 'shared-video',
  ]);
});

test('无逻辑模型的重复图片线路仅内部 qualified 选择可精确路由且不公开', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const first = createVerifiedConfig(db, {
    service_type: 'image', provider: 'legacy-image-a', name: '旧图片线路 A',
    base_url: 'https://legacy-image-a.example/v1', api_key: 'legacy-image-secret-a',
    model: ['legacy-shared-image'], default_model: 'legacy-shared-image',
  });
  const second = createVerifiedConfig(db, {
    service_type: 'image', provider: 'legacy-image-b', name: '旧图片线路 B',
    base_url: 'https://legacy-image-b.example/v1', api_key: 'legacy-image-secret-b',
    model: ['legacy-shared-image'], default_model: 'legacy-shared-image',
  });
  modelPriceService.set(db, 'legacy-shared-image', 35, { category: 'image' });

  const firstSelection = `cfg-${first.id}::legacy-shared-image`;
  const secondSelection = `cfg-${second.id}::legacy-shared-image`;
  modelPriceService.set(db, firstSelection, 36, { category: 'image' });
  modelPriceService.set(db, secondSelection, 37, { category: 'image' });
  const firstConfig = imageClient.getDefaultImageConfig(db, firstSelection, null, 'image');
  const secondConfig = imageClient.getDefaultImageConfig(db, secondSelection, null, 'image');
  assert.equal(firstConfig.id, first.id);
  assert.equal(firstConfig.canvas_selected_model, 'legacy-shared-image');
  assert.equal(firstConfig.canvas_selection_model, firstSelection);
  assert.equal(secondConfig.id, second.id);
  assert.equal(secondConfig.canvas_selected_model, 'legacy-shared-image');
  assert.equal(secondConfig.canvas_selection_model, secondSelection);

  const catalog = canvasModelCatalogService.list(db).filter((item) => item.kind === 'image');
  assert.deepEqual(catalog, []);
  const result = capture();
  aiConfigRoutes(db, log, {}).listPublicImageModels({}, result.res);
  assert.deepEqual(result.payload().data, []);
  assertPublicRouteIdentityHidden([catalog, result.payload()], [
    'legacy-image-a', 'legacy-image-b', 'legacy-image-a.example', 'legacy-image-b.example',
    'legacy-image-secret-a', 'legacy-image-secret-b',
  ]);
});

test('无逻辑模型的重复视频线路仅内部 qualified 选择可精确路由且不公开', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const first = createVerifiedConfig(db, {
    service_type: 'video', provider: 'legacy-video-a', name: '旧视频线路 A',
    base_url: 'https://legacy-video-a.example/v1', api_key: 'legacy-video-secret-a',
    model: ['legacy-shared-video'], default_model: 'legacy-shared-video',
  });
  const second = createVerifiedConfig(db, {
    service_type: 'video', provider: 'legacy-video-b', name: '旧视频线路 B',
    base_url: 'https://legacy-video-b.example/v1', api_key: 'legacy-video-secret-b',
    model: ['legacy-shared-video'], default_model: 'legacy-shared-video',
  });
  modelPriceService.set(db, 'legacy-shared-video', 8, { category: 'video' });

  const firstSelection = `cfg-${first.id}::legacy-shared-video`;
  const secondSelection = `cfg-${second.id}::legacy-shared-video`;
  modelPriceService.set(db, firstSelection, 9, { category: 'video' });
  modelPriceService.set(db, secondSelection, 10, { category: 'video' });
  const firstConfig = videoClient.getDefaultVideoConfig(db, firstSelection);
  const secondConfig = videoClient.getDefaultVideoConfig(db, secondSelection);
  assert.equal(firstConfig.id, first.id);
  assert.equal(firstConfig.canvas_selected_model, 'legacy-shared-video');
  assert.equal(firstConfig.canvas_selection_model, firstSelection);
  assert.equal(secondConfig.id, second.id);
  assert.equal(secondConfig.canvas_selected_model, 'legacy-shared-video');
  assert.equal(secondConfig.canvas_selection_model, secondSelection);

  const catalog = canvasModelCatalogService.list(db).filter((item) => item.kind === 'video');
  assert.deepEqual(catalog, []);
  const result = capture();
  aiConfigRoutes(db, log, {}).listPublicVideoModels({}, result.res);
  assert.deepEqual(result.payload().data, []);
  assertPublicRouteIdentityHidden([catalog, result.payload()], [
    'legacy-video-a', 'legacy-video-b', 'legacy-video-a.example', 'legacy-video-b.example',
    'legacy-video-secret-a', 'legacy-video-secret-b',
  ]);
});

test('分镜图片节点可精确选择通用图片配置中的模型', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  createVerifiedConfig(db, {
    service_type: 'storyboard_image', provider: 'legacy-storyboard', name: '原分镜供应商',
    base_url: 'https://storyboard.example/v1', api_key: 'secret-storyboard',
    model: ['legacy-storyboard-image'], default_model: 'legacy-storyboard-image',
  });
  const sharedImage = createVerifiedConfig(db, {
    service_type: 'image', provider: 'provider-image', name: '新图片供应商',
    base_url: 'https://image.example/v1', api_key: 'secret-image',
    model: ['new-shared-image'], default_model: 'new-shared-image',
  });

  const selected = imageClient.getDefaultImageConfig(
    db,
    'new-shared-image',
    null,
    'storyboard_image',
  );
  assert.equal(selected.id, sharedImage.id);
});
