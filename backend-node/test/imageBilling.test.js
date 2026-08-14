const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const imageService = require('../src/services/imageService');
const credits = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const taskService = require('../src/services/taskService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const imageRoutes = require('../src/routes/images');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

function setup(available = 100) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  credits.setAccountBalance(db, 'user-1', available);
  return db;
}

function create(db) {
  return imageService.create(db, log, {
    drama_id: 1,
    storyboard_id: 19,
    frame_type: 'storyboard_first',
    model: 'gpt-image-2',
    prompt: 'test only',
  }, {
    billingEnabled: true,
    userId: 'user-1',
    schedule() {},
  });
}

test('公开计费模式价格缺失时不创建图片任务', () => {
  const db = setup();
  assert.throws(() => create(db), (error) => error.code === 'MODEL_PRICE_NOT_CONFIGURED');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM image_generations').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM async_tasks').get().count, 0);
});

test('余额不足时图片记录、异步任务和预扣全部回滚', () => {
  const db = setup(5);
  prices.set(db, 'gpt-image-2', 18);
  assert.throws(() => create(db), (error) => error.code === 'INSUFFICIENT_CREDITS');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM image_generations').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM async_tasks').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage_reservations').get().count, 0);
});

test('图片任务创建与积分预扣在同一事务并关联用户', () => {
  const db = setup(100);
  prices.set(db, 'gpt-image-2', 18);
  const image = create(db);
  const row = db.prepare('SELECT user_id, credit_reservation_id FROM image_generations WHERE id = ?').get(image.id);
  const task = db.prepare('SELECT credit_reservation_id, model FROM async_tasks WHERE id = ?').get(image.task_id);
  assert.equal(row.user_id, 'user-1');
  assert.equal(typeof row.credit_reservation_id, 'string');
  assert.equal(task.credit_reservation_id, row.credit_reservation_id);
  assert.equal(task.model, 'gpt-image-2');
  assert.deepEqual(credits.getAccount(db, 'user-1'), { user_id: 'user-1', available: 82, held: 18, spent: 0 });
  const event = db.prepare("SELECT * FROM audit_events WHERE event_type = 'generation.image.created'").get();
  assert.equal(event.user_id, 'user-1');
  assert.equal(event.resource_type, 'image');
  assert.equal(event.resource_id, String(image.id));
});

test('服务重启清理图片任务时能通过任务关联退回预扣积分', () => {
  const db = setup(100);
  prices.set(db, 'gpt-image-2', 18);
  const image = create(db);
  const row = db.prepare('SELECT credit_reservation_id FROM image_generations WHERE id = ?').get(image.id);

  const count = taskService.failOrphanedAsyncTasksOnStartup(db, log);

  assert.equal(count, 1);
  assert.equal(credits.getReservation(db, row.credit_reservation_id).status, 'refunded');
  assert.equal(db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(image.task_id).status, 'failed');
  assert.equal(db.prepare('SELECT status FROM image_generations WHERE id = ?').get(image.id).status, 'failed');
});

test('重复图片提交复用原任务且不重复预扣', () => {
  const db = setup(100);
  prices.set(db, 'gpt-image-2', 18);
  const first = create(db);
  const second = create(db);
  assert.equal(second.id, first.id);
  assert.equal(second.reused, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage_reservations').get().count, 1);
  assert.equal(credits.getAccount(db, 'user-1').available, 82);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'generation.image.created'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'generation.image.reused'").get().count, 1);
});

function capture() {
  const result = {};
  return {
    result,
    res: {
      status(code) { result.status = code; return this; },
      json(body) { result.body = body; return this; },
    },
  };
}

test('图片接口把缺价返回为服务未配置而不是服务器内部错误', () => {
  const db = setup(100);
  const handlers = imageRoutes(db, {}, log, { billingEnabled: true, schedule() {} });
  const { res, result } = capture();
  handlers.create({ user: { id: 'user-1' }, body: { drama_id: 1, storyboard_id: 19, model: 'gpt-image-2' } }, res);
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'MODEL_PRICE_NOT_CONFIGURED');
});

test('图片接口把余额不足返回为需要充值', () => {
  const db = setup(5);
  prices.set(db, 'gpt-image-2', 18);
  const handlers = imageRoutes(db, {}, log, { billingEnabled: true, schedule() {} });
  const { res, result } = capture();
  handlers.create({ user: { id: 'user-1' }, body: { drama_id: 1, storyboard_id: 19, model: 'gpt-image-2' } }, res);
  assert.equal(result.status, 402);
  assert.equal(result.body.error.code, 'INSUFFICIENT_CREDITS');
});

test('图片成功后确认预扣积分', () => {
  const db = setup(100);
  prices.set(db, 'gpt-image-2', 18);
  const image = create(db);
  const row = db.prepare('SELECT credit_reservation_id FROM image_generations WHERE id = ?').get(image.id);
  imageService.settleImageCredit(db, log, row, 'completed');
  assert.equal(credits.getReservation(db, row.credit_reservation_id).status, 'confirmed');
});

test('图片明确失败后退回预扣积分', () => {
  const db = setup(100);
  prices.set(db, 'gpt-image-2', 18);
  const image = create(db);
  const row = db.prepare('SELECT credit_reservation_id FROM image_generations WHERE id = ?').get(image.id);
  imageService.settleImageCredit(db, log, row, 'failed', '供应商明确拒绝请求');
  assert.equal(credits.getReservation(db, row.credit_reservation_id).status, 'refunded');
  assert.deepEqual(credits.getAccount(db, 'user-1'), { user_id: 'user-1', available: 100, held: 0, spent: 0 });
});

test('同步 2xx 无可读产物的结果未知错误经过图片结算后保持冻结', () => {
  const db = setup(100);
  prices.set(db, 'gpt-image-2', 18);
  const image = create(db);
  const row = db.prepare('SELECT credit_reservation_id FROM image_generations WHERE id = ?').get(image.id);
  imageService.settleImageCredit(db, log, row, 'failed', '图片生成响应成功但没有可读取产物，供应商结果未知；请核对供应商记录，不要连续重试');
  assert.equal(credits.getReservation(db, row.credit_reservation_id).status, 'held');
  assert.deepEqual(credits.getAccount(db, 'user-1'), { user_id: 'user-1', available: 82, held: 18, spent: 0 });
});
