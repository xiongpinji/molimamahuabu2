const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const imageClient = require('../src/services/imageClient');
const credits = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

function setup(available = 100) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  credits.setAccountBalance(db, 'user-1', available);
  return db;
}

function createAssetImage(db, asset = {}) {
  return imageClient.createAndGenerateImage(db, log, {
    drama_id: 1,
    character_id: asset.characterId ?? 4,
    scene_id: asset.sceneId ?? null,
    prompt: 'test only',
    model: 'gpt-image-2',
    provider: 'openai',
    billingEnabled: true,
    userId: asset.userId ?? 'user-1',
    schedule() {},
  });
}

test('公开计费模式缺少图片价格时不创建旧资产图片任务', () => {
  const db = setup();

  assert.throws(() => createAssetImage(db), (error) => error.code === 'MODEL_PRICE_NOT_CONFIGURED');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM image_generations').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM async_tasks').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage_reservations').get().count, 0);
});

test('旧资产图片任务预扣积分，复用处理中任务且写入审计事件', () => {
  const db = setup();
  prices.set(db, 'gpt-image-2', 18);

  const first = createAssetImage(db);
  const second = createAssetImage(db);
  const row = db.prepare('SELECT user_id, credit_reservation_id FROM image_generations WHERE id = ?').get(first.id);

  assert.equal(row.user_id, 'user-1');
  assert.equal(typeof row.credit_reservation_id, 'string');
  assert.equal(second.id, first.id);
  assert.equal(second.reused, true);
  assert.deepEqual(credits.getAccount(db, 'user-1'), { user_id: 'user-1', available: 82, held: 18, spent: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage_reservations').get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'generation.image.created'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'generation.image.reused'").get().count, 1);
});

test('旧资产图片结果未知时保留预扣积分', () => {
  const db = setup();
  prices.set(db, 'gpt-image-2', 18);

  const image = createAssetImage(db);
  imageClient.settleImageCredit(db, log, image.id, 'failed', '供应商最终状态未知，请勿重新提交');

  const row = db.prepare('SELECT credit_reservation_id FROM image_generations WHERE id = ?').get(image.id);
  assert.equal(credits.getReservation(db, row.credit_reservation_id).status, 'held');
});

test('旧资产图片明确失败时退回预扣积分', () => {
  const db = setup();
  prices.set(db, 'gpt-image-2', 18);

  const image = createAssetImage(db);
  imageClient.settleImageCredit(db, log, image.id, 'failed', '供应商明确拒绝请求');

  const row = db.prepare('SELECT credit_reservation_id FROM image_generations WHERE id = ?').get(image.id);
  assert.equal(credits.getReservation(db, row.credit_reservation_id).status, 'refunded');
});


test('公开计费模式不复用其他用户的处理中资产图任务', () => {
  const db = setup();
  credits.setAccountBalance(db, 'user-2', 100);
  prices.set(db, 'gpt-image-2', 18);

  const first = createAssetImage(db, { userId: 'user-1' });
  const second = createAssetImage(db, { userId: 'user-2' });

  assert.notEqual(second.id, first.id);
  assert.equal(second.reused, undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM image_generations').get().count, 2);
  assert.equal(credits.getAccount(db, 'user-1').held, 18);
  assert.equal(credits.getAccount(db, 'user-2').held, 18);
});
