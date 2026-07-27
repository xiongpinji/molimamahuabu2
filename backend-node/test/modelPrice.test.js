const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const prices = require('../src/services/modelPriceService');

function makeDb() {
  const db = new Database(':memory:');
  prices.ensureSchema(db);
  return db;
}

test('初始列出兼容模型且价格均未配置', () => {
  const rows = prices.list(makeDb());
  assert.deepEqual(rows.map((row) => row.model), ['GPT-5.5', 'gpt-image-2', 'seedance 2.0']);
  assert.equal(rows.every((row) => row.credits === null), true);
});

test('保存并读取整数积分价格', () => {
  const db = makeDb();
  prices.set(db, 'gpt-image-2', 18);
  assert.equal(prices.requirePrice(db, 'gpt-image-2'), 18);
});

test('拒绝零值和小数价格', () => {
  const db = makeDb();
  assert.throws(() => prices.set(db, 'gpt-image-2', 0), (error) => error.code === 'INVALID_MODEL_PRICE');
  assert.throws(() => prices.set(db, 'gpt-image-2', 1.5), (error) => error.code === 'INVALID_MODEL_PRICE');
});

test('价格缺失时默认拒绝而不是猜测价格', () => {
  const db = makeDb();
  assert.throws(
    () => prices.requirePrice(db, 'seedance 2.0'),
    (error) => error.code === 'MODEL_PRICE_NOT_CONFIGURED'
  );
});

test('模型名匹配忽略首尾空格和大小写但返回规范名称', () => {
  const db = makeDb();
  const saved = prices.set(db, '  gpt-5.5 ', 6);
  assert.equal(saved.model, 'GPT-5.5');
  assert.equal(prices.requirePrice(db, 'GPT-5.5'), 6);
});

test('管理员可新增实际模型并独立配置类型与价格', () => {
  const db = makeDb();
  const saved = prices.set(db, 'GROK-IMAGINE-VIDEO', 42, {
    displayName: 'Grok Imagine Video',
    category: 'video',
    status: 'enabled',
  });
  assert.deepEqual(
    {
      model: saved.model,
      display_name: saved.display_name,
      category: saved.category,
      credits: saved.credits,
      status: saved.status,
    },
    {
      model: 'grok-imagine-video',
      display_name: 'Grok Imagine Video',
      category: 'video',
      credits: 42,
      status: 'enabled',
    },
  );
  assert.equal(prices.requirePrice(db, 'grok-imagine-video'), 42);
});

test('停用模型即使已有价格也禁止生成', () => {
  const db = makeDb();
  prices.set(db, 'grok-imagine-video', 42, { category: 'video', status: 'disabled' });
  assert.throws(
    () => prices.requirePrice(db, 'grok-imagine-video'),
    (error) => error.code === 'MODEL_DISABLED',
  );
});

test('自动列出 AI 配置中的每个实际模型并标记未定价状态', () => {
  const db = makeDb();
  db.exec(`CREATE TABLE ai_service_configs (
    id INTEGER PRIMARY KEY,
    service_type TEXT NOT NULL,
    model TEXT,
    default_model TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    deleted_at TEXT
  )`);
  const insert = db.prepare(`INSERT INTO ai_service_configs
    (id, service_type, model, default_model, is_active, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  insert.run(1, 'image', JSON.stringify(['gpt-image-2', 'gemini-image-pro']), null, 1, null);
  insert.run(2, 'video', JSON.stringify(['grok-video-3']), 'grok-video-3-pro', 1, null);
  insert.run(3, 'tts', JSON.stringify(['speech-02-hd']), null, 0, null);
  insert.run(4, 'video', JSON.stringify(['deleted-video-model']), null, 1, '2026-07-26T00:00:00Z');

  prices.set(db, 'grok-video-3', 35, {
    displayName: 'Grok Video 3',
    category: 'video',
  });

  const rows = prices.list(db);
  const byModel = new Map(rows.map((row) => [row.model.toLowerCase(), row]));

  assert.deepEqual(
    {
      model: byModel.get('gemini-image-pro')?.model,
      category: byModel.get('gemini-image-pro')?.category,
      credits: byModel.get('gemini-image-pro')?.credits,
      status: byModel.get('gemini-image-pro')?.status,
    },
    {
      model: 'gemini-image-pro',
      category: 'image',
      credits: null,
      status: 'unconfigured',
    },
  );
  assert.equal(byModel.get('grok-video-3')?.credits, 35);
  assert.equal(byModel.get('grok-video-3-pro')?.category, 'video');
  assert.equal(byModel.get('speech-02-hd')?.category, 'audio');
  assert.equal(byModel.has('deleted-video-model'), false);
});
