const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const aiConfig = require('../src/services/aiConfigService');
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
    image_type: asset.imageType ?? null,
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
  const task = db.prepare('SELECT credit_reservation_id, model FROM async_tasks WHERE id = ?').get(first.task_id);

  assert.equal(row.user_id, 'user-1');
  assert.equal(typeof row.credit_reservation_id, 'string');
  assert.equal(task.credit_reservation_id, row.credit_reservation_id);
  assert.equal(task.model, 'gpt-image-2');
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

test('场景全景图任务与场景主参考图任务独立去重', () => {
  const db = setup();
  prices.set(db, 'gpt-image-2', 18);

  const reference = createAssetImage(db, { sceneId: 9, imageType: 'scene_reference' });
  const panorama = createAssetImage(db, { sceneId: 9, imageType: 'scene_panorama' });
  const panoramaAgain = createAssetImage(db, { sceneId: 9, imageType: 'scene_panorama' });

  assert.notEqual(panorama.id, reference.id);
  assert.equal(panoramaAgain.id, panorama.id);
  assert.equal(panoramaAgain.reused, true);
});

test('人物、场景和全景图未显式传模型时统一使用已验证的默认图片模型', () => {
  const db = setup(200);
  if (!db.prepare('PRAGMA table_info(ai_service_configs)').all().some((column) => column.name === 'verification_status')) {
    db.exec('ALTER TABLE ai_service_configs ADD COLUMN verification_status TEXT');
  }
  const config = aiConfig.createConfig(db, log, {
    service_type: 'image',
    provider: 'openai',
    api_protocol: 'openai',
    name: '默认图片模型',
    base_url: 'https://example.invalid/v1',
    api_key: 'test-key',
    model: ['gpt-image-2-2k'],
    default_model: 'gpt-image-2-2k',
    is_default: true,
  });
  db.prepare("UPDATE ai_service_configs SET verification_status = 'verified' WHERE id = ?").run(config.id);
  prices.set(db, 'gpt-image-2-2k', 40, { category: 'image' });

  const createWithoutModel = (asset) => imageClient.createAndGenerateImage(db, log, {
    drama_id: 1,
    character_id: asset.characterId ?? null,
    scene_id: asset.sceneId ?? null,
    image_type: asset.imageType,
    prompt: 'test only',
    provider: 'openai',
    billingEnabled: true,
    userId: 'user-1',
    schedule() {},
  });

  const character = createWithoutModel({ characterId: 41, imageType: 'character_reference' });
  const scene = createWithoutModel({ sceneId: 51, imageType: 'scene_reference' });
  const panorama = createWithoutModel({ sceneId: 51, imageType: 'scene_panorama' });
  const ids = [character.id, scene.id, panorama.id];
  const rows = db.prepare(`SELECT ig.model, t.model AS task_model
    FROM image_generations ig
    JOIN async_tasks t ON t.id = ig.task_id
    WHERE ig.id IN (?, ?, ?)
    ORDER BY ig.id`).all(...ids);

  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.model), Array(3).fill('gpt-image-2-2k'));
  assert.deepEqual(rows.map((row) => row.task_model), Array(3).fill('gpt-image-2-2k'));
  assert.deepEqual(credits.getAccount(db, 'user-1'), {
    user_id: 'user-1',
    available: 80,
    held: 120,
    spent: 0,
  });
});
