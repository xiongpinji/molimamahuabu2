const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const aiClient = require('../src/services/aiClient');
const aiConfig = require('../src/services/aiConfigService');
const backgroundExtraction = require('../src/services/backgroundExtractionService');
const credits = require('../src/services/creditLedgerService');
const imageRoutes = require('../src/routes/images');
const prices = require('../src/services/modelPriceService');
const taskService = require('../src/services/taskService');
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
  const episodeId = db.prepare(
    `INSERT INTO episodes
      (drama_id, episode_number, title, script_content, created_at, updated_at)
     VALUES (?, 1, '第一集', '母女在雨后的庭院相遇。', ?, ?)`,
  ).run(dramaId, now, now).lastInsertRowid;
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
  return { db, episodeId };
}

async function waitForTask(db, taskId) {
  for (let i = 0; i < 50; i += 1) {
    const task = taskService.getTask(db, taskId);
    if (task && ['completed', 'failed'].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`任务未在预期时间内结束: ${taskId}`);
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

test('场景提取按实际文本模型预扣并在成功后结算租户积分', async (t) => {
  const { db, episodeId } = setup();
  const original = aiClient.generateText;
  t.after(() => { aiClient.generateText = original; db.close(); });
  aiClient.generateText = async () => '[]';

  const taskId = backgroundExtraction.extractBackgroundsForEpisode(
    db,
    {},
    log,
    episodeId,
    'GPT-5.5',
    '',
    'zh',
    { billingEnabled: true, tenantId: 'tenant-a', userId: 'user-1' },
  );

  const created = taskService.getTask(db, taskId);
  assert.equal(created.tenant_id, 'tenant-a');
  assert.equal(created.model, 'GPT-5.5');
  assert.equal(typeof created.credit_reservation_id, 'string');
  assert.equal(credits.getTenantAccount(db, 'tenant-a').held, 5);

  assert.equal((await waitForTask(db, taskId)).status, 'completed');
  assert.equal(credits.getReservation(db, created.credit_reservation_id).status, 'confirmed');
  assert.equal(credits.getTenantAccount(db, 'tenant-a').spent, 5);
});

test('场景提取在模型未定价时拒绝生成并写回失败任务', (t) => {
  const { db, episodeId } = setup({ withPrice: false });
  const original = aiClient.generateText;
  t.after(() => { aiClient.generateText = original; db.close(); });
  aiClient.generateText = async () => '[]';

  assert.throws(
    () => backgroundExtraction.extractBackgroundsForEpisode(
      db,
      {},
      log,
      episodeId,
      'GPT-5.5',
      '',
      'zh',
      { billingEnabled: true, tenantId: 'tenant-a', userId: 'user-1' },
    ),
    (error) => error.code === 'MODEL_PRICE_NOT_CONFIGURED',
  );
  const task = db.prepare(
    `SELECT status, error FROM async_tasks
     WHERE type = 'background_extraction' ORDER BY rowid DESC LIMIT 1`,
  ).get();
  assert.equal(task.status, 'failed');
  assert.match(task.error, /尚未配置积分价格/);
});

test('场景提取接口把模型未定价映射为服务未配置', (t) => {
  const { db, episodeId } = setup({ withPrice: false });
  t.after(() => db.close());
  const handlers = imageRoutes(db, {}, log, { billingEnabled: true });
  const { res, result } = capture();

  handlers.episodeBackgroundsExtract({
    params: { episode_id: episodeId },
    body: { model: 'GPT-5.5' },
    user: { id: 'user-1' },
    tenant: { id: 'tenant-a' },
  }, res);

  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'MODEL_PRICE_NOT_CONFIGURED');
});

test('场景提取供应商明确失败时退回预扣积分', async (t) => {
  const { db, episodeId } = setup();
  const original = aiClient.generateText;
  t.after(() => { aiClient.generateText = original; db.close(); });
  aiClient.generateText = async () => { throw new Error('供应商明确失败'); };

  const taskId = backgroundExtraction.extractBackgroundsForEpisode(
    db,
    {},
    log,
    episodeId,
    'GPT-5.5',
    '',
    'zh',
    { billingEnabled: true, tenantId: 'tenant-a', userId: 'user-1' },
  );
  const reservationId = taskService.getTask(db, taskId).credit_reservation_id;

  assert.equal((await waitForTask(db, taskId)).status, 'failed');
  assert.equal(credits.getReservation(db, reservationId).status, 'refunded');
  assert.deepEqual(credits.getTenantAccount(db, 'tenant-a'), {
    tenant_id: 'tenant-a', available: 20, held: 0, spent: 0,
  });
});
