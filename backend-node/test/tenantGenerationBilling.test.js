const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const imageClient = require('../src/services/imageClient');
const imageService = require('../src/services/imageService');
const videoService = require('../src/services/videoService');
const credits = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  credits.setTenantAccountBalance(db, 'tenant-a', 100);
  credits.setTenantAccountBalance(db, 'tenant-b', 100);
  credits.setAccountBalance(db, 'user-1', 7);
  prices.set(db, 'gpt-image-2', 18);
  prices.set(db, 'seedance 2.0', 12);
  return db;
}

function options(tenantId) {
  return {
    billingEnabled: true,
    tenantId,
    userId: 'user-1',
    schedule() {},
  };
}

test('图片、资产图和视频任务按租户隔离去重并只预扣租户余额', () => {
  const db = setup();

  const imageA = imageService.create(db, log, {
    drama_id: 1,
    storyboard_id: 10,
    frame_type: 'storyboard_first',
    model: 'gpt-image-2',
    prompt: 'tenant image',
  }, options('tenant-a'));
  const imageB = imageService.create(db, log, {
    drama_id: 1,
    storyboard_id: 10,
    frame_type: 'storyboard_first',
    model: 'gpt-image-2',
    prompt: 'tenant image',
  }, options('tenant-b'));

  const assetA = imageClient.createAndGenerateImage(db, log, {
    drama_id: 1,
    character_id: 5,
    model: 'gpt-image-2',
    prompt: 'tenant asset',
    ...options('tenant-a'),
  });
  const assetB = imageClient.createAndGenerateImage(db, log, {
    drama_id: 1,
    character_id: 5,
    model: 'gpt-image-2',
    prompt: 'tenant asset',
    ...options('tenant-b'),
  });

  const videoA = videoService.create(db, log, {
    drama_id: 1,
    storyboard_id: 20,
    model: 'seedance 2.0',
    prompt: 'tenant video',
    duration: 5,
  }, options('tenant-a'));
  const videoB = videoService.create(db, log, {
    drama_id: 1,
    storyboard_id: 20,
    model: 'seedance 2.0',
    prompt: 'tenant video',
    duration: 5,
  }, options('tenant-b'));

  assert.notEqual(imageA.id, imageB.id);
  assert.notEqual(assetA.id, assetB.id);
  assert.notEqual(videoA.id, videoB.id);
  assert.deepEqual(
    db.prepare('SELECT tenant_id FROM image_generations ORDER BY id').all().map((row) => row.tenant_id),
    ['tenant-a', 'tenant-b', 'tenant-a', 'tenant-b'],
  );
  assert.deepEqual(
    db.prepare('SELECT tenant_id FROM video_generations ORDER BY id').all().map((row) => row.tenant_id),
    ['tenant-a', 'tenant-b'],
  );
  assert.deepEqual(credits.getTenantAccount(db, 'tenant-a'), {
    tenant_id: 'tenant-a', available: 4, held: 96, spent: 0,
  });
  assert.deepEqual(credits.getTenantAccount(db, 'tenant-b'), {
    tenant_id: 'tenant-b', available: 4, held: 96, spent: 0,
  });
  assert.deepEqual(credits.getAccount(db, 'user-1'), {
    user_id: 'user-1', available: 7, held: 0, spent: 0,
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 6);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage_reservations').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE tenant_id IS NOT NULL').get().count, 6);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM async_tasks WHERE tenant_id IS NOT NULL').get().count, 6);

  db.close();
});
