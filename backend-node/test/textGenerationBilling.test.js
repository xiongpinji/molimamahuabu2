const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const aiConfig = require('../src/services/aiConfigService');
const credits = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const textBilling = require('../src/services/textGenerationBillingService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {} };

function setup({ withPrice = true, status = 'enabled' } = {}) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
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
  if (withPrice) prices.set(db, 'GPT-5.5', 5, { status });
  return db;
}

test('文本生成计费上下文按实际模型预扣并确认租户积分', (t) => {
  const db = setup();
  t.after(() => db.close());

  const billing = textBilling.begin(db, {
    enabled: true,
    tenantId: 'tenant-a',
    userId: 'user-1',
    sceneKey: 'image_polish',
    requestedModel: 'GPT-5.5',
    resourceType: 'storyboard_prompt',
    resourceId: '12',
    operation: 'storyboard_universal_prompt',
  });

  assert.equal(billing.model, 'GPT-5.5');
  assert.equal(credits.getTenantAccount(db, 'tenant-a').held, 5);
  const settled = textBilling.settle(db, log, billing, 'completed');
  assert.equal(settled.status, 'confirmed');
  assert.equal(credits.getTenantAccount(db, 'tenant-a').spent, 5);
});

test('文本生成计费上下文拒绝未定价和已停用模型', (t) => {
  const missingDb = setup({ withPrice: false });
  const disabledDb = setup({ status: 'disabled' });
  t.after(() => { missingDb.close(); disabledDb.close(); });

  assert.throws(
    () => textBilling.begin(missingDb, {
      enabled: true,
      tenantId: 'tenant-a',
      userId: 'user-1',
      requestedModel: 'GPT-5.5',
      resourceType: 'storyboard_prompt',
      resourceId: '12',
      operation: 'storyboard_universal_prompt',
    }),
    (error) => error.code === 'MODEL_PRICE_NOT_CONFIGURED',
  );
  assert.throws(
    () => textBilling.begin(disabledDb, {
      enabled: true,
      tenantId: 'tenant-a',
      userId: 'user-1',
      requestedModel: 'GPT-5.5',
      resourceType: 'storyboard_prompt',
      resourceId: '12',
      operation: 'storyboard_universal_prompt',
    }),
    (error) => error.code === 'MODEL_DISABLED',
  );
});

test('文本生成明确失败时退回预扣积分', (t) => {
  const db = setup();
  t.after(() => db.close());
  const billing = textBilling.begin(db, {
    enabled: true,
    tenantId: 'tenant-a',
    userId: 'user-1',
    requestedModel: 'GPT-5.5',
    resourceType: 'vision_description',
    resourceId: 'asset-1',
    operation: 'vision_description',
  });

  const settled = textBilling.settle(db, log, billing, 'failed', '供应商明确失败');

  assert.equal(settled.status, 'refunded');
  assert.deepEqual(credits.getTenantAccount(db, 'tenant-a'), {
    tenant_id: 'tenant-a', available: 20, held: 0, spent: 0,
  });
});

test('关闭公开计费时只解析请求模型且不创建预扣', (t) => {
  const db = setup({ withPrice: false });
  t.after(() => db.close());

  const billing = textBilling.begin(db, {
    enabled: false,
    requestedModel: 'GPT-5.5',
    resourceType: 'storyboard_prompt',
    resourceId: '12',
    operation: 'storyboard_universal_prompt',
  });

  assert.equal(billing.model, 'GPT-5.5');
  assert.equal(billing.reservationId, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 0);
});
