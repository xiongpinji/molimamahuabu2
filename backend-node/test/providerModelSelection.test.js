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

test('不同图片供应商的同名模型生成独立选择标识并精确路由', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const first = createVerifiedConfig(db, {
    service_type: 'image', provider: 'provider-a', name: '供应商 A',
    base_url: 'https://a.example/v1', api_key: 'secret-a',
    model: ['shared-image'], default_model: 'shared-image',
  });
  const second = createVerifiedConfig(db, {
    service_type: 'image', provider: 'provider-b', name: '供应商 B',
    base_url: 'https://b.example/v1', api_key: 'secret-b',
    model: ['shared-image'], default_model: 'shared-image',
  });
  createVerifiedConfig(db, {
    service_type: 'image', provider: 'provider-c', name: '未定价供应商',
    base_url: 'https://c.example/v1', api_key: 'secret-c',
    model: ['unpriced-image'], default_model: 'unpriced-image',
  });

  const firstSelection = `cfg-${first.id}::shared-image`;
  const secondSelection = `cfg-${second.id}::shared-image`;
  modelPriceService.set(db, firstSelection, 31, { category: 'image', displayName: '供应商 A 图片' });
  modelPriceService.set(db, secondSelection, 42, { category: 'image', displayName: '供应商 B 图片' });

  const catalog = canvasModelCatalogService.list(db).filter((item) => item.kind === 'image');
  assert.deepEqual(catalog.map((item) => item.model).sort(), [firstSelection, secondSelection].sort());
  assert.equal(catalog.find((item) => item.model === firstSelection).label, '供应商 A 图片');
  assert.equal(catalog.find((item) => item.model === secondSelection).label, '供应商 B 图片');

  const firstConfig = imageClient.getDefaultImageConfig(db, firstSelection, null, 'image');
  const secondConfig = imageClient.getDefaultImageConfig(db, secondSelection, null, 'image');
  assert.equal(firstConfig.id, first.id);
  assert.equal(firstConfig.canvas_selected_model, 'shared-image');
  assert.equal(secondConfig.id, second.id);
  assert.equal(secondConfig.canvas_selected_model, 'shared-image');

  const result = capture();
  aiConfigRoutes(db, log, {}).listPublicImageModels({}, result.res);
  assert.deepEqual(result.payload().data.sort(), [firstSelection, secondSelection].sort());
});

test('不同视频供应商的同名模型生成独立选择标识并精确路由', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const first = createVerifiedConfig(db, {
    service_type: 'video', provider: 'provider-a', name: '视频供应商 A',
    base_url: 'https://a.example/v1', api_key: 'secret-a',
    model: ['shared-video'], default_model: 'shared-video',
  });
  const second = createVerifiedConfig(db, {
    service_type: 'video', provider: 'provider-b', name: '视频供应商 B',
    base_url: 'https://b.example/v1', api_key: 'secret-b',
    model: ['shared-video'], default_model: 'shared-video',
  });
  const firstSelection = `cfg-${first.id}::shared-video`;
  const secondSelection = `cfg-${second.id}::shared-video`;
  modelPriceService.set(db, firstSelection, 11, { category: 'video' });
  modelPriceService.set(db, secondSelection, 22, { category: 'video' });

  const catalog = canvasModelCatalogService.list(db).filter((item) => item.kind === 'video');
  assert.deepEqual(catalog.map((item) => item.model).sort(), [firstSelection, secondSelection].sort());
  assert.equal(videoClient.getDefaultVideoConfig(db, firstSelection).id, first.id);
  assert.equal(videoClient.getDefaultVideoConfig(db, secondSelection).id, second.id);
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
