const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const aiClient = require('../src/services/aiClient');
const aiConfig = require('../src/services/aiConfigService');
const characterGeneration = require('../src/services/characterGenerationService');
const characterLibrary = require('../src/services/characterLibraryService');
const credits = require('../src/services/creditLedgerService');
const dramaService = require('../src/services/dramaService');
const novelImport = require('../src/services/novelImportService');
const prices = require('../src/services/modelPriceService');
const storyGeneration = require('../src/services/storyGenerationService');
const textBilling = require('../src/services/text-generation-billing-service');
const usageContext = require('../src/services/generationUsageContext');
const routeCosts = require('../src/services/providerRouteCostService');
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

function setupTextEntrypoint({ withPrice = true, balance = 30 } = {}) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, style, status, created_at, updated_at)
     VALUES ('测试项目', 'realistic', 'draft', ?, ?)`,
  ).run(now, now).lastInsertRowid;
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
  credits.setTenantAccountBalance(db, 'tenant-a', balance);
  if (withPrice) prices.set(db, 'GPT-5.5', 5);
  return { db, dramaId };
}

async function waitForTask(db, taskId) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const task = db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(taskId);
    if (task && ['completed', 'failed'].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待任务 ${taskId} 超时`);
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

test('文本成功按最终线路和实际 token 用量记录成本', (t) => {
  const db = setup();
  t.after(() => db.close());
  const config = aiConfig.listConfigs(db).find((row) => row.service_type === 'text');
  routeCosts.setRouteCost(db, config.id, {
    cost_unit: 'token', input_cost_micros_per_1k: 1_000,
    output_cost_micros_per_1k: 3_000,
  });
  const billing = textBilling.begin(db, {
    enabled: true, tenantId: 'tenant-a', userId: 'user-1', requestedModel: 'GPT-5.5',
    resourceType: 'canvas_text', resourceId: 'node-cost', operation: 'canvas_text',
  });
  usageContext.captureRoute(config.id);
  usageContext.capture({ prompt_tokens: 1_000, completion_tokens: 2_000 });

  textBilling.settle(db, log, billing, 'completed');

  assert.deepEqual(
    db.prepare(`SELECT config_id, cost_micros, input_tokens, output_tokens, cost_source
      FROM generation_cost_records WHERE reservation_id = ?`).get(billing.reservationId),
    {
      config_id: config.id, cost_micros: 7_000, input_tokens: 1_000,
      output_tokens: 2_000, cost_source: 'provider_route',
    },
  );
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

test('文本生成结果未知时保留预扣等待人工核对', (t) => {
  const db = setup();
  t.after(() => db.close());
  const billing = textBilling.begin(db, {
    enabled: true,
    tenantId: 'tenant-a',
    userId: 'user-1',
    requestedModel: 'GPT-5.5',
    resourceType: 'canvas_text',
    resourceId: 'node-unknown',
    operation: 'canvas_text',
  });

  const settled = textBilling.settle(db, log, billing, 'needs_attention');

  assert.equal(settled.status, 'held');
  assert.deepEqual(credits.getTenantAccount(db, 'tenant-a'), {
    tenant_id: 'tenant-a', available: 15, held: 5, spent: 0,
  });
  assert.equal(
    db.prepare('SELECT cost_source FROM generation_cost_records WHERE reservation_id = ?')
      .get(billing.reservationId).cost_source,
    'unknown',
  );
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

test('公开角色生成按实际文本模型计费且不触发未计费后台补充调用', async (t) => {
  const { db, dramaId } = setupTextEntrypoint();
  const originalGenerate = aiClient.generateText;
  const originalPrompt = characterLibrary.generateCharacterPromptOnly;
  let aiCalls = 0;
  let promptCalls = 0;
  t.after(() => {
    aiClient.generateText = originalGenerate;
    characterLibrary.generateCharacterPromptOnly = originalPrompt;
    db.close();
  });
  aiClient.generateText = async (_db, _log, _type, _prompt, _system, options) => {
    aiCalls += 1;
    assert.equal(options.model, 'GPT-5.5');
    return JSON.stringify([{
      name: '小茉',
      appearance: '黑色长发，粉色外套',
    }]);
  };
  characterLibrary.generateCharacterPromptOnly = async () => {
    promptCalls += 1;
    return { ok: true };
  };

  const taskId = characterGeneration.generateCharacters(
    db,
    {},
    log,
    { drama_id: dramaId, model: 'GPT-5.5' },
    { billingEnabled: true, tenantId: 'tenant-a', userId: 'user-1' },
  );
  const task = await waitForTask(db, taskId);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(task.status, 'completed');
  assert.equal(task.model, 'GPT-5.5');
  assert.ok(task.credit_reservation_id);
  assert.equal(credits.getReservation(db, task.credit_reservation_id).status, 'confirmed');
  assert.equal(credits.getTenantAccount(db, 'tenant-a').spent, 5);
  assert.equal(aiCalls, 1);
  assert.equal(promptCalls, 0);
});

test('公开角色生成在模型未定价时不创建任务也不调用供应商', (t) => {
  const { db, dramaId } = setupTextEntrypoint({ withPrice: false });
  const originalGenerate = aiClient.generateText;
  let calls = 0;
  t.after(() => {
    aiClient.generateText = originalGenerate;
    db.close();
  });
  aiClient.generateText = async () => {
    calls += 1;
    return '[]';
  };

  assert.throws(
    () => characterGeneration.generateCharacters(
      db,
      {},
      log,
      { drama_id: dramaId, model: 'GPT-5.5' },
      { billingEnabled: true, tenantId: 'tenant-a', userId: 'user-1' },
    ),
    (error) => error.code === 'MODEL_PRICE_NOT_CONFIGURED',
  );
  assert.equal(calls, 0);
  assert.equal(db.prepare(
    "SELECT COUNT(*) AS count FROM async_tasks WHERE type = 'character_generation'",
  ).get().count, 0);
});

test('公开剧本生成未指定模型时使用后台默认模型并按同一模型计费', async (t) => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const originalGenerate = aiClient.generateText;
  t.after(() => {
    aiClient.generateText = originalGenerate;
    db.close();
  });
  aiConfig.createConfig(db, log, {
    service_type: 'text',
    provider: 'openai',
    name: '后台默认文本模型',
    base_url: 'https://example.invalid/v1',
    api_key: 'test-key',
    model: ['gpt-5.6-sol'],
    default_model: 'gpt-5.6-sol',
    is_default: true,
  });
  prices.set(db, 'gpt-5.6-sol', 6);
  credits.setTenantAccountBalance(db, 'tenant-a', 20);
  const drama = dramaService.createDrama(db, log, {
    tenant_id: 'tenant-a',
    user_id: 'user-1',
    title: '默认模型验收项目',
  });
  aiClient.generateText = async (_db, _log, _type, _prompt, _system, options) => {
    assert.equal(options.model, 'gpt-5.6-sol');
    return JSON.stringify([{ episode: 1, title: '雨夜重逢', content: '母亲在旧站台找到了孩子。' }]);
  };

  const taskId = storyGeneration.startStoryGeneration(
    db,
    log,
    { drama_id: drama.id, premise: '雨夜车站重逢' },
    { billingEnabled: true, tenantId: 'tenant-a', userId: 'user-1' },
  );
  const task = await waitForTask(db, taskId);

  assert.equal(task.status, 'completed');
  assert.equal(task.model, 'gpt-5.6-sol');
  assert.equal(credits.getReservation(db, task.credit_reservation_id).model, 'gpt-5.6-sol');
  assert.equal(credits.getReservation(db, task.credit_reservation_id).status, 'confirmed');
  assert.equal(credits.getTenantAccount(db, 'tenant-a').spent, 6);
});

test('小说导入按每个实际改写章节分别计费', async (t) => {
  const { db } = setupTextEntrypoint();
  const originalGenerate = aiClient.generateText;
  let calls = 0;
  t.after(() => {
    aiClient.generateText = originalGenerate;
    db.close();
  });
  aiClient.generateText = async (_db, _log, _type, _prompt, _system, options) => {
    calls += 1;
    assert.equal(options.model, 'GPT-5.5');
    return `第${calls}章改写结果`;
  };

  const result = await novelImport.importNovel(db, log, {
    text: `第一章 开始\n${'甲'.repeat(30)}\n第二章 继续\n${'乙'.repeat(30)}`,
    title: '测试小说',
    maxChapters: 2,
    aiSummarize: true,
    model: 'GPT-5.5',
    billingEnabled: true,
    tenantId: 'tenant-a',
    userId: 'user-1',
  });

  assert.equal(result.chapters.length, 2);
  assert.equal(calls, 2);
  const reservations = db.prepare(
    "SELECT * FROM tenant_usage_reservations WHERE resource_type = 'novel_chapter' ORDER BY created_at",
  ).all();
  assert.equal(reservations.length, 2);
  assert.ok(reservations.every((item) => item.status === 'confirmed' && item.model === 'GPT-5.5'));
  assert.equal(credits.getTenantAccount(db, 'tenant-a').spent, 10);
});

test('公开小说改写失败时退款并向上抛错而不是伪装成功', async (t) => {
  const { db } = setupTextEntrypoint();
  const originalGenerate = aiClient.generateText;
  t.after(() => {
    aiClient.generateText = originalGenerate;
    db.close();
  });
  aiClient.generateText = async () => {
    throw new Error('供应商明确失败');
  };

  await assert.rejects(
    novelImport.importNovel(db, log, {
      text: '第一章 开始\n' + '甲'.repeat(30),
      title: '测试小说',
      maxChapters: 1,
      aiSummarize: true,
      model: 'GPT-5.5',
      billingEnabled: true,
      tenantId: 'tenant-a',
      userId: 'user-1',
    }),
    /供应商明确失败/,
  );
  const reservation = db.prepare(
    "SELECT * FROM tenant_usage_reservations WHERE resource_type = 'novel_chapter'",
  ).get();
  assert.equal(reservation.status, 'refunded');
  assert.equal(credits.getTenantAccount(db, 'tenant-a').available, 30);
});
