const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const aiConfig = require('../src/services/aiConfigService');
const imageClient = require('../src/services/imageClient');
const prices = require('../src/services/modelPriceService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

function setupDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  if (!db.prepare('PRAGMA table_info(ai_service_configs)').all().some((column) => column.name === 'verification_status')) {
    db.exec('ALTER TABLE ai_service_configs ADD COLUMN verification_status TEXT');
  }
  return db;
}

function addConfig(db, values) {
  const model = values.model || `${values.serviceType}-model`;
  const config = aiConfig.createConfig(db, log, {
    service_type: values.serviceType,
    provider: values.provider || 'openai',
    api_protocol: 'openai',
    name: values.name || model,
    base_url: 'https://provider.example/v1',
    api_key: 'test-key',
    model: [model],
    default_model: model,
    endpoint: '/images/generations',
    priority: values.priority || 50,
    is_default: Boolean(values.isDefault),
  });
  db.prepare(`
    UPDATE ai_service_configs
    SET is_active = ?, verification_status = ?
    WHERE id = ?
  `).run(values.active === false ? 0 : 1, values.verified === false ? 'failed' : 'verified', config.id);
  return config.id;
}

test('redraw image service types reuse verified production image config without weakening unknown service types', (t) => {
  const db = setupDb();
  t.after(() => db.close());
  const imageId = addConfig(db, {
    serviceType: 'image',
    model: 'gpt-image-2-2k',
    priority: 90,
    isDefault: true,
  });
  addConfig(db, {
    serviceType: 'image',
    model: 'disabled-image',
    priority: 100,
    active: false,
  });
  addConfig(db, {
    serviceType: 'image',
    model: 'unverified-image',
    priority: 95,
    verified: false,
  });

  for (const serviceType of ['redraw_character', 'redraw_scene', 'redraw_prop']) {
    const candidates = imageClient.getImageConfigCandidates(db, null, null, serviceType);
    assert.deepEqual(candidates.map((config) => config.id), [imageId]);
    assert.equal(candidates[0].service_type, 'image');
    assert.deepEqual(candidates[0].model, ['gpt-image-2-2k']);
  }

  assert.deepEqual(imageClient.getImageConfigCandidates(db, null, null, 'redraw_unknown'), []);
});

test('redraw image service types prefer dedicated config then storyboard_image then image with id dedupe', (t) => {
  const db = setupDb();
  t.after(() => db.close());
  const imageId = addConfig(db, {
    serviceType: 'image',
    model: 'base-image',
    priority: 90,
    isDefault: true,
  });
  const storyboardId = addConfig(db, {
    serviceType: 'storyboard_image',
    model: 'storyboard-image',
    priority: 80,
  });
  const dedicatedId = addConfig(db, {
    serviceType: 'redraw_scene',
    model: 'redraw-scene-image',
    priority: 70,
  });
  prices.set(db, 'redraw-scene-image', 40, { category: 'image' });
  prices.set(db, 'storyboard-image', 40, { category: 'image' });
  prices.set(db, 'base-image', 40, { category: 'image' });

  assert.deepEqual(
    imageClient.getImageConfigCandidates(db, null, null, 'redraw_scene')
      .map((config) => [config.id, config.service_type]),
    [
      [dedicatedId, 'redraw_scene'],
      [storyboardId, 'storyboard_image'],
      [imageId, 'image'],
    ],
  );

  assert.deepEqual(
    imageClient.getImageConfigCandidates(db, null, null, 'redraw_character')
      .map((config) => [config.id, config.service_type]),
    [
      [storyboardId, 'storyboard_image'],
      [imageId, 'image'],
    ],
  );
});
