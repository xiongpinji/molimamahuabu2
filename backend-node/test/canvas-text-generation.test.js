const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const aiClient = require('../src/services/aiClient');
const aiConfig = require('../src/services/aiConfigService');
const canvasText = require('../src/services/canvas-text-generation-service');
const credits = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {} };

test('独立画布文本节点调用真实文本模型并返回生成内容', async (t) => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  aiConfig.createConfig(db, log, {
    service_type: 'text',
    provider: 'openai',
    name: '画布文本模型',
    base_url: 'https://example.invalid/v1',
    api_key: 'test-key',
    model: ['GPT-5.5'],
    default_model: 'GPT-5.5',
    is_default: true,
  });
  const original = aiClient.generateText;
  t.after(() => {
    aiClient.generateText = original;
    db.close();
  });
  aiClient.generateText = async (_db, _log, serviceType, prompt, systemPrompt, options) => {
    assert.equal(serviceType, 'text');
    assert.equal(prompt, '写一段雨夜车站的开场旁白');
    assert.match(systemPrompt, /独立画布文本节点/);
    assert.equal(options.model, 'GPT-5.5');
    return '雨幕落下，最后一班列车驶入站台。';
  };

  const result = await canvasText.generate(db, log, {
    dramaId: 7,
    prompt: '写一段雨夜车站的开场旁白',
    model: 'GPT-5.5',
    billingEnabled: false,
  });

  assert.deepEqual(result, {
    content: '雨幕落下，最后一班列车驶入站台。',
    model: 'GPT-5.5',
  });
});

test('独立画布文本节点拒绝空提示词', async () => {
  const db = new Database(':memory:');
  try {
    await assert.rejects(
      canvasText.generate(db, log, { dramaId: 7, prompt: '   ', billingEnabled: false }),
      /请输入文本生成要求/,
    );
  } finally {
    db.close();
  }
});

test('首页文字生成无需项目并按统一模型价格结算', async (t) => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  aiConfig.createConfig(db, log, {
    service_type: 'text',
    provider: 'openai',
    name: '首页文字模型',
    base_url: 'https://example.invalid/v1',
    api_key: 'test-key',
    model: ['home-text-model'],
    default_model: 'home-text-model',
    is_default: true,
  });
  credits.setAccountBalance(db, 'user-home', 20);
  prices.set(db, 'home-text-model', 5, { category: 'text' });
  const original = aiClient.generateText;
  t.after(() => {
    aiClient.generateText = original;
    db.close();
  });
  aiClient.generateText = async () => '雨幕落下，城市亮起第一盏灯。';

  const result = await canvasText.generate(db, log, {
    prompt: '写一段雨夜开场',
    model: 'home-text-model',
    requestId: 'home-request-1',
    billingEnabled: true,
    userId: 'user-home',
  });

  assert.equal(result.content, '雨幕落下，城市亮起第一盏灯。');
  assert.equal(credits.getAccount(db, 'user-home').spent, 5);
  const reservation = db.prepare('SELECT * FROM usage_reservations').get();
  assert.equal(reservation.resource_type, 'standalone_text');
  assert.equal(reservation.resource_id, 'home-request-1');
  assert.equal(reservation.status, 'confirmed');
});

test('画布文本结果未知时关联供应商路由并保持租户积分冻结', async (t) => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  aiConfig.createConfig(db, log, {
    service_type: 'text',
    provider: 'openai',
    name: '画布文本未知态模型',
    base_url: 'https://example.invalid/v1',
    api_key: 'test-key',
    model: ['canvas-text-model'],
    default_model: 'canvas-text-model',
    is_default: true,
  });
  credits.setTenantAccountBalance(db, 'tenant-canvas', 20);
  prices.set(db, 'canvas-text-model', 5, { category: 'text' });
  const original = aiClient.generateText;
  t.after(() => {
    aiClient.generateText = original;
    db.close();
  });
  let routeOptions = null;
  aiClient.generateText = async (_db, _log, _type, _prompt, _system, options) => {
    routeOptions = options;
    const error = new Error('文本生成结果未知，请勿连续重试');
    error.code = 'TEXT_RESULT_UNKNOWN';
    throw error;
  };

  await assert.rejects(
    canvasText.generate(db, log, {
      dramaId: 7,
      prompt: '写一段雨夜开场',
      model: 'canvas-text-model',
      billingEnabled: true,
      tenantId: 'tenant-canvas',
      userId: 'user-canvas',
    }),
    (error) => error.code === 'TEXT_RESULT_UNKNOWN',
  );

  const reservation = db.prepare('SELECT * FROM tenant_usage_reservations').get();
  assert.equal(reservation.status, 'held');
  assert.deepEqual(credits.getTenantAccount(db, 'tenant-canvas'), {
    tenant_id: 'tenant-canvas', available: 15, held: 5, spent: 0,
  });
  assert.equal(routeOptions.tenantId, 'tenant-canvas');
  assert.equal(routeOptions.userId, 'user-canvas');
  assert.equal(routeOptions.creditReservationId, reservation.id);
  assert.equal(routeOptions.idempotency_key, reservation.id);
});
