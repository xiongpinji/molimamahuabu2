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

test('价格列表明确视频按秒计费且其他模型按次计费', () => {
  const rows = prices.list(makeDb());
  assert.deepEqual(
    rows.map(({ model, billing_unit }) => ({ model, billing_unit })),
    [
      { model: 'GPT-5.5', billing_unit: 'request' },
      { model: 'gpt-image-2', billing_unit: 'request' },
      { model: 'seedance 2.0', billing_unit: 'second' },
    ],
  );
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

test('图片、视频和文本推理模型按各自单位计算 API 成本', () => {
  const db = makeDb();
  prices.set(db, 'image-model', 2, {
    category: 'image',
    cost_unit: 'image',
    cost_micros_per_unit: 120000,
  });
  prices.set(db, 'video-model', 9, {
    category: 'video',
    cost_unit: 'second',
    cost_micros_per_unit: 80000,
  });
  prices.set(db, 'reasoning-model', 3, {
    category: 'text',
    cost_unit: 'token',
    input_cost_micros_per_1k: 2000,
    output_cost_micros_per_1k: 4000,
  });

  assert.equal(prices.quoteCost(db, 'image-model', { quantity: 1 }).cost_micros, 120000);
  assert.equal(prices.quoteCost(db, 'video-model', { quantity: 5 }).cost_micros, 400000);
  assert.deepEqual(
    prices.quoteCost(db, 'reasoning-model', {
      inputTokens: 1500,
      outputTokens: 500,
      reasoningTokens: 300,
    }),
    {
      model: 'reasoning-model',
      cost_unit: 'token',
      quantity: 1,
      cost_micros: 5000,
      input_tokens: 1500,
      output_tokens: 500,
      reasoning_tokens: 300,
    },
  );
});

test('拒绝负数 API 成本', () => {
  const db = makeDb();
  assert.throws(
    () => prices.set(db, 'bad-model', 1, { cost_micros_per_unit: -1 }),
    (error) => error.code === 'INVALID_MODEL_PRICE',
  );
});

test('视频金额只接受 5 到 15 秒整数并按秒相乘', () => {
  const db = makeDb();
  prices.set(db, 'seedance 2.0', 3);
  prices.set(db, 'grok-imagine-video', 2, { category: 'video' });
  assert.equal(prices.calculateCharge(db, 'seedance 2.0', { duration: 8 }), 24);
  assert.equal(prices.calculateCharge(db, 'grok-imagine-video', { duration: 8 }), 16);
  assert.equal(prices.list(db).find((row) => row.model === 'grok-imagine-video')?.billing_unit, 'second');
  for (const duration of [null, 4, 16, 7.5]) {
    assert.throws(
      () => prices.calculateCharge(db, 'seedance 2.0', { duration }),
      (error) => error.code === 'INVALID_VIDEO_DURATION',
    );
  }
});

test('iCreat Seedance 2.0 Mini 和 Fast 接受官方支持的 4 秒并按秒计费', () => {
  const db = makeDb();
  for (const model of [
    'bytedance/seedance-2-0-mini',
    'bytedance/seedance-2-0-fast',
  ]) {
    prices.set(db, model, 60, { category: 'video', cost_unit: 'second' });
    assert.equal(prices.calculateCharge(db, model, { duration: 4 }), 240);
  }
});

test('图片模型按 1K/2K/4K 分别计算每张积分与人民币微元成本', () => {
  const db = makeDb();
  const gpt = prices.set(db, 'gpt-image-2-2-4k', 70, {
    category: 'image',
    cost_unit: 'image',
    resolution_prices: {
      '1K': { credits: 70, cost_micros_per_unit: 80000 },
      '2k': { credits: 87, cost_micros_per_unit: 100000 },
    },
  });
  const nano = prices.set(db, 'nano-banana-2', 70, {
    category: 'image',
    cost_unit: 'image',
    resolution_prices: {
      '1k': { credits: 70, cost_micros_per_unit: 80000 },
      '2k': { credits: 87, cost_micros_per_unit: 100000 },
      '4k': { credits: 105, cost_micros_per_unit: 120000 },
    },
  });

  assert.deepEqual(gpt.resolution_prices, {
    '1k': { credits: 70, cost_micros_per_unit: 80000 },
    '2k': { credits: 87, cost_micros_per_unit: 100000 },
  });
  assert.equal(prices.calculateCharge(db, gpt.model, { resolution: '1k', quantity: 2 }), 140);
  assert.equal(prices.calculateCharge(db, gpt.model, { resolution: '2K', quantity: 2 }), 174);
  assert.equal(prices.quoteCost(db, nano.model, { resolution: '4k', quantity: 3 }).cost_micros, 360000);
  assert.throws(
    () => prices.calculateCharge(db, gpt.model, { resolution: '4k', quantity: 1 }),
    (error) => error.code === 'MODEL_RESOLUTION_PRICE_REQUIRED',
  );
});

test('图片分辨率价格拒绝视频档位且有分档时必须明确选择已定价档位', () => {
  const db = makeDb();
  assert.throws(
    () => prices.set(db, 'bad-image', 70, {
      category: 'image',
      resolution_prices: { '1080p': { credits: 70, cost_micros_per_unit: 80000 } },
    }),
    (error) => error.code === 'INVALID_MODEL_PRICE' && /图片分辨率/.test(error.message),
  );
  prices.set(db, 'tiered-image', 70, {
    category: 'image',
    resolution_prices: { '1k': { credits: 70, cost_micros_per_unit: 80000 } },
  });
  assert.throws(
    () => prices.calculateCharge(db, 'tiered-image', { quantity: 1 }),
    (error) => error.code === 'MODEL_RESOLUTION_PRICE_REQUIRED',
  );
  assert.throws(
    () => prices.quoteCost(db, 'tiered-image', { resolution: '2k', quantity: 1 }),
    (error) => error.code === 'MODEL_RESOLUTION_PRICE_REQUIRED',
  );
});
