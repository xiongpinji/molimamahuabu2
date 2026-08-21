const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const aiClient = require('../src/services/aiClient');
const aiConfig = require('../src/services/aiConfigService');
const credits = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const sceneRoutes = require('../src/routes/scenes');
const sceneService = require('../src/services/sceneService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {} };

function setup({ withPrice = true } = {}) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, style, status, created_at, updated_at)
     VALUES ('测试项目', 'realistic', 'draft', ?, ?)`,
  ).run(now, now).lastInsertRowid;
  const scene = sceneService.createScene(db, log, dramaId, {
    location: '雨后庭院',
    time: '清晨',
    prompt: '青石板上有积水，藤蔓沿墙垂落。',
  });
  aiConfig.createConfig(db, log, {
    service_type: 'text',
    provider: 'openai',
    name: '测试文本模型',
    base_url: 'https://example.invalid/v1',
    api_key: 'test-key',
    model: ['GPT-5.5'],
    default_model: 'GPT-5.5',
    is_default: true,
  });
  credits.setTenantAccountBalance(db, 'tenant-a', 20);
  if (withPrice) prices.set(db, 'GPT-5.5', 5);
  return { db, sceneId: scene.id };
}

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

function request(sceneId) {
  return {
    params: { scene_id: sceneId },
    body: { model: 'GPT-5.5' },
    user: { id: 'user-1' },
    tenant: { id: 'tenant-a' },
  };
}

test('场景提示词按实际文本模型计费并在成功后确认积分', async (t) => {
  const { db, sceneId } = setup();
  const original = aiClient.generateText;
  t.after(() => { aiClient.generateText = original; db.close(); });
  aiClient.generateText = async () => '四格场景参考图提示词';
  const { res, result } = capture();

  await sceneRoutes(db, log, {}, { billingEnabled: true }).generatePrompt(request(sceneId), res);

  assert.equal(result.status, 200);
  const reservation = db.prepare(
    `SELECT * FROM tenant_usage_reservations
     WHERE resource_type = 'text' AND resource_id = ?`,
  ).get(String(sceneId));
  assert.equal(reservation.model, 'GPT-5.5');
  assert.equal(reservation.status, 'confirmed');
  assert.equal(credits.getTenantAccount(db, 'tenant-a').spent, 5);
});

test('场景提示词接口在实际模型未定价时返回服务未配置', async (t) => {
  const { db, sceneId } = setup({ withPrice: false });
  const original = aiClient.generateText;
  t.after(() => { aiClient.generateText = original; db.close(); });
  aiClient.generateText = async () => '不应调用';
  const { res, result } = capture();

  await sceneRoutes(db, log, {}, { billingEnabled: true }).generatePrompt(request(sceneId), res);

  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'MODEL_PRICE_NOT_CONFIGURED');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 0);
});

test('场景提示词供应商明确失败时退回预扣积分', async (t) => {
  const { db, sceneId } = setup();
  const original = aiClient.generateText;
  t.after(() => { aiClient.generateText = original; db.close(); });
  aiClient.generateText = async () => { throw new Error('供应商明确失败'); };
  const { res, result } = capture();

  await sceneRoutes(db, log, {}, { billingEnabled: true }).generatePrompt(request(sceneId), res);

  assert.equal(result.status, 400);
  const reservation = db.prepare(
    `SELECT * FROM tenant_usage_reservations
     WHERE resource_type = 'text' AND resource_id = ?`,
  ).get(String(sceneId));
  assert.equal(reservation.status, 'refunded');
  assert.deepEqual(credits.getTenantAccount(db, 'tenant-a'), {
    tenant_id: 'tenant-a', available: 20, held: 0, spent: 0,
  });
});
