const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const aiConfig = require('../src/services/aiConfigService');
const credits = require('../src/services/creditLedgerService');
const imageClient = require('../src/services/imageClient');
const prices = require('../src/services/modelPriceService');
const propImages = require('../src/services/propImageGenerationService');
const taskService = require('../src/services/taskService');
const uploadService = require('../src/services/uploadService');
const { createResourceOwnershipMiddleware } = require('../src/middleware/resourceOwnership');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

function setup({ withPrice = true } = {}) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const dramaId = Number(db.prepare(
    `INSERT INTO dramas
      (tenant_id, user_id, title, style, status, metadata, created_at, updated_at)
     VALUES ('tenant-a', 'user-1', '道具图测试', 'realistic', 'draft', '{}', ?, ?)`,
  ).run(now, now).lastInsertRowid);
  const propId = Number(db.prepare(
    `INSERT INTO props (drama_id, name, prompt, created_at, updated_at)
     VALUES (?, '旧式手机', '一部磨损的黑色旧式手机', ?, ?)`,
  ).run(dramaId, now, now).lastInsertRowid);
  const config = aiConfig.createConfig(db, log, {
    service_type: 'image',
    provider: 'openai',
    name: '测试图片模型',
    base_url: 'https://example.invalid/v1',
    api_key: 'test-key',
    model: ['gpt-image-2'],
    default_model: 'gpt-image-2',
    is_default: true,
  });
  db.prepare("UPDATE ai_service_configs SET verification_status = 'verified' WHERE id = ?")
    .run(config.id);
  credits.setTenantAccountBalance(db, 'tenant-a', 20);
  if (withPrice) prices.set(db, 'gpt-image-2', 5);
  return { db, dramaId, propId };
}

function billingOptions(extra = {}) {
  return {
    model: 'gpt-image-2',
    billingEnabled: true,
    tenantId: 'tenant-a',
    userId: 'user-1',
    schedule() {},
    ...extra,
  };
}

test('道具生图缺少价格时不创建无计费任务', (t) => {
  const { db, propId } = setup({ withPrice: false });
  t.after(() => db.close());

  assert.throws(
    () => propImages.generatePropImage(db, log, propId, billingOptions()),
    (error) => error.code === 'MODEL_PRICE_NOT_CONFIGURED',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM async_tasks').get().count, 0);
});

test('道具生图任务创建时原子写入语义资源、租户归属和积分预扣', (t) => {
  const { db, propId } = setup();
  t.after(() => db.close());

  const taskId = propImages.generatePropImage(db, log, propId, billingOptions());
  const task = taskService.getTask(db, taskId);

  assert.equal(task.resource_id, `prop_${propId}`);
  assert.equal(task.tenant_id, 'tenant-a');
  assert.equal(task.user_id, 'user-1');
  assert.equal(task.model, 'gpt-image-2');
  assert.equal(typeof task.credit_reservation_id, 'string');
  assert.equal(credits.getReservation(db, task.credit_reservation_id).status, 'held');

  const middleware = createResourceOwnershipMiddleware({ db, enabled: true });
  let nextCalled = false;
  middleware({
    path: `/tasks/${taskId}`,
    body: {},
    query: {},
    user: { id: 'user-1' },
    tenant: { id: 'tenant-a' },
  }, {
    status() { return this; },
    json() { return this; },
  }, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('道具生图未显式传模型时按默认图片配置计费', (t) => {
  const { db, propId } = setup();
  t.after(() => db.close());

  const taskId = propImages.generatePropImage(db, log, propId, billingOptions({ model: undefined }));
  const task = taskService.getTask(db, taskId);

  assert.equal(task.model, 'gpt-image-2');
  assert.equal(credits.getReservation(db, task.credit_reservation_id).model, 'gpt-image-2');
});

test('道具生图供应商明确失败时写回任务并退还预扣积分', async (t) => {
  const { db, propId } = setup();
  const originalCall = imageClient.callImageApi;
  imageClient.callImageApi = async () => ({ error: '供应商明确拒绝请求' });
  t.after(() => {
    imageClient.callImageApi = originalCall;
    db.close();
  });
  const taskId = propImages.generatePropImage(db, log, propId, billingOptions());
  const reservationId = taskService.getTask(db, taskId).credit_reservation_id;

  await propImages.processPropImageGeneration(db, log, taskId, propId, billingOptions());

  const task = taskService.getTask(db, taskId);
  assert.equal(task.status, 'failed');
  assert.equal(task.error, '供应商明确拒绝请求');
  assert.equal(credits.getReservation(db, reservationId).status, 'refunded');
});

test('道具生图成功后确认预扣积分并保存图片', async (t) => {
  const { db, propId } = setup();
  const originalCall = imageClient.callImageApi;
  const originalDownload = uploadService.downloadImageToLocal;
  imageClient.callImageApi = async (_db, _log, options) => {
    assert.match(options.prompt, /四个视角/);
    return { image_url: 'https://cdn.example/prop.jpg' };
  };
  uploadService.downloadImageToLocal = async () => 'projects/1/props/prop.jpg';
  t.after(() => {
    imageClient.callImageApi = originalCall;
    uploadService.downloadImageToLocal = originalDownload;
    db.close();
  });
  const options = billingOptions({ useQuadGrid: true });
  const taskId = propImages.generatePropImage(db, log, propId, options);
  const reservationId = taskService.getTask(db, taskId).credit_reservation_id;

  await propImages.processPropImageGeneration(db, log, taskId, propId, options);

  assert.equal(taskService.getTask(db, taskId).status, 'completed');
  assert.equal(credits.getReservation(db, reservationId).status, 'confirmed');
  assert.equal(
    db.prepare('SELECT local_path FROM props WHERE id = ?').get(propId).local_path,
    'projects/1/props/prop.jpg',
  );
});
