const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const prices = require('../src/services/modelPriceService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

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

test('只有显式 free 模式可以配置 0 积分并在读写和成本快照中保留模式', () => {
  const db = makeDb();

  assert.throws(() => prices.set(db, 'free-local-model', 0, { category: 'text' }), (error) => error.code === 'INVALID_MODEL_PRICE');
  assert.throws(() => prices.set(db, 'invalid-free-model', 1, { category: 'text', pricingMode: 'free' }), (error) => error.code === 'INVALID_MODEL_PRICE');

  const paid = prices.set(db, 'paid-local-model', 2, { category: 'text' });
  assert.equal(paid.pricing_mode, 'paid');

  const free = prices.set(db, 'free-local-model', 0, { category: 'text', pricingMode: 'free' });
  assert.equal(free.pricing_mode, 'free');
  assert.equal(free.credits, 0);
  assert.equal(prices.requirePrice(db, 'free-local-model'), 0);
  assert.equal(prices.calculateCharge(db, 'free-local-model'), 0);
  assert.equal(prices.list(db).find((row) => row.model === 'free-local-model').pricing_mode, 'free');
  assert.equal(prices.quoteCost(db, 'free-local-model').pricing_mode, 'free');

  assert.throws(
    () => db.prepare(`INSERT INTO model_credit_prices (model, credits, pricing_mode, updated_at)
      VALUES ('bad-paid-zero', 0, 'paid', datetime('now'))`).run(),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => db.prepare(`INSERT INTO model_credit_prices (model, credits, pricing_mode, updated_at)
      VALUES ('bad-free-positive', 1, 'free', datetime('now'))`).run(),
    /CHECK constraint failed/,
  );
});

test('迁移 67 保留既有价格为 paid 并允许正式 free 0 积分', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE model_credit_prices (
      model TEXT PRIMARY KEY,
      credits INTEGER NOT NULL CHECK (credits > 0),
      updated_at TEXT NOT NULL
    );
    INSERT INTO model_credit_prices (model, credits, updated_at)
    VALUES ('legacy-paid', 9, '2026-08-27T00:00:00.000Z');
  `);

  runMigrationsAndEnsure(db);

  const legacy = db.prepare('SELECT model, credits, pricing_mode FROM model_credit_prices WHERE model = ?').get('legacy-paid');
  assert.deepEqual(legacy, { model: 'legacy-paid', credits: 9, pricing_mode: 'paid' });
  db.prepare(`INSERT INTO model_credit_prices (model, credits, pricing_mode, updated_at)
    VALUES ('migrated-free', 0, 'free', datetime('now'))`).run();
  assert.throws(
    () => db.prepare(`INSERT INTO model_credit_prices (model, credits, pricing_mode, updated_at)
      VALUES ('migrated-paid-zero', 0, 'paid', datetime('now'))`).run(),
    /CHECK constraint failed/,
  );
});

test('迁移 67 重跑不会删除未来扩展列和值', () => {
  const db = new Database(':memory:');

  runMigrationsAndEnsure(db);
  db.exec("ALTER TABLE model_credit_prices ADD COLUMN future_extension TEXT NOT NULL DEFAULT ''");
  db.prepare(`INSERT INTO model_credit_prices (model, credits, pricing_mode, future_extension, updated_at)
    VALUES ('future-paid', 12, 'paid', 'keep-me', '2026-08-27T00:00:00.000Z')`).run();

  runMigrationsAndEnsure(db);

  const columns = db.prepare('PRAGMA table_info(model_credit_prices)').all().map((column) => column.name);
  assert.equal(columns.includes('future_extension'), true);
  assert.deepEqual(
    db.prepare('SELECT model, credits, pricing_mode, future_extension FROM model_credit_prices WHERE model = ?').get('future-paid'),
    { model: 'future-paid', credits: 12, pricing_mode: 'paid', future_extension: 'keep-me' },
  );
  assert.throws(
    () => db.prepare(`INSERT INTO model_credit_prices (model, credits, pricing_mode, future_extension, updated_at)
      VALUES ('future-bad-paid-zero', 0, 'paid', 'blocked', datetime('now'))`).run(),
    /CHECK constraint failed/,
  );
});

test('迁移 67 在分语句部分执行后可安全重跑且保留原表数据', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE model_credit_prices (
      model TEXT PRIMARY KEY,
      credits INTEGER NOT NULL CHECK (credits > 0),
      pricing_mode TEXT NOT NULL DEFAULT 'paid',
      display_name TEXT,
      public_note TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'other',
      status TEXT NOT NULL DEFAULT 'enabled',
      billing_unit TEXT NOT NULL DEFAULT '',
      cost_unit TEXT NOT NULL DEFAULT 'request',
      cost_micros_per_unit INTEGER NOT NULL DEFAULT 0,
      input_cost_micros_per_1k INTEGER NOT NULL DEFAULT 0,
      output_cost_micros_per_1k INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    INSERT INTO model_credit_prices (model, credits, pricing_mode, updated_at)
    VALUES ('legacy-paid', 9, 'paid', '2026-08-27T00:00:00.000Z');
    CREATE TABLE __model_credit_prices_free_rebuild (
      model TEXT PRIMARY KEY,
      credits INTEGER NOT NULL CHECK (
        (pricing_mode = 'paid' AND credits > 0)
        OR (pricing_mode = 'free' AND credits = 0)
      ),
      pricing_mode TEXT NOT NULL DEFAULT 'paid' CHECK (pricing_mode IN ('paid', 'free')),
      display_name TEXT,
      public_note TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'other',
      status TEXT NOT NULL DEFAULT 'enabled',
      billing_unit TEXT NOT NULL DEFAULT '',
      cost_unit TEXT NOT NULL DEFAULT 'request',
      cost_micros_per_unit INTEGER NOT NULL DEFAULT 0,
      input_cost_micros_per_1k INTEGER NOT NULL DEFAULT 0,
      output_cost_micros_per_1k INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    INSERT INTO __model_credit_prices_free_rebuild (
      model, credits, pricing_mode, display_name, public_note, category, status,
      billing_unit, cost_unit, cost_micros_per_unit, input_cost_micros_per_1k,
      output_cost_micros_per_1k, updated_at
    )
    SELECT
      model, credits, pricing_mode, display_name, public_note, category, status,
      billing_unit, cost_unit, cost_micros_per_unit, input_cost_micros_per_1k,
      output_cost_micros_per_1k, updated_at
    FROM model_credit_prices;
  `);

  assert.doesNotThrow(() => runMigrationsAndEnsure(db));
  assert.deepEqual(
    db.prepare('SELECT model, credits, pricing_mode FROM model_credit_prices WHERE model = ?').get('legacy-paid'),
    { model: 'legacy-paid', credits: 9, pricing_mode: 'paid' },
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = '__model_credit_prices_free_rebuild'").get().count,
    0,
  );
  db.prepare(`INSERT INTO model_credit_prices (model, credits, pricing_mode, updated_at)
    VALUES ('migrated-free', 0, 'free', datetime('now'))`).run();
});

test('迁移 67 旧分语句已删除原表时 modelPrice ensure 可从临时表恢复数据', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE __model_credit_prices_free_rebuild (
      model TEXT PRIMARY KEY,
      credits INTEGER NOT NULL CHECK (
        (pricing_mode = 'paid' AND credits > 0)
        OR (pricing_mode = 'free' AND credits = 0)
      ),
      pricing_mode TEXT NOT NULL DEFAULT 'paid' CHECK (pricing_mode IN ('paid', 'free')),
      display_name TEXT,
      public_note TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'other',
      status TEXT NOT NULL DEFAULT 'enabled',
      billing_unit TEXT NOT NULL DEFAULT '',
      cost_unit TEXT NOT NULL DEFAULT 'request',
      cost_micros_per_unit INTEGER NOT NULL DEFAULT 0,
      input_cost_micros_per_1k INTEGER NOT NULL DEFAULT 0,
      output_cost_micros_per_1k INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    INSERT INTO __model_credit_prices_free_rebuild (model, credits, pricing_mode, updated_at)
    VALUES ('legacy-after-drop', 11, 'paid', '2026-08-27T00:00:00.000Z');
  `);

  assert.doesNotThrow(() => runMigrationsAndEnsure(db));
  prices.ensureSchema(db);

  assert.deepEqual(
    db.prepare('SELECT model, credits, pricing_mode FROM model_credit_prices WHERE model = ?').get('legacy-after-drop'),
    { model: 'legacy-after-drop', credits: 11, pricing_mode: 'paid' },
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = '__model_credit_prices_free_rebuild'").get().count,
    0,
  );
  assert.throws(
    () => db.prepare(`INSERT INTO model_credit_prices (model, credits, pricing_mode, updated_at)
      VALUES ('bad-paid-zero-after-restore', 0, 'paid', datetime('now'))`).run(),
    /CHECK constraint failed/,
  );
});

test('free 模式拒绝分辨率阶梯并在 paid 转 free 时清理旧阶梯', () => {
  const db = makeDb();

  assert.throws(
    () => prices.set(db, 'free-video-model', 0, {
      category: 'video',
      pricingMode: 'free',
      resolution_prices: { '480p': { credits: 4 } },
    }),
    (error) => error.code === 'INVALID_MODEL_PRICE',
  );

  prices.set(db, 'tiered-video', 5, {
    category: 'video',
    resolution_prices: { '480p': { credits: 4 } },
  });
  assert.deepEqual(Object.keys(prices.list(db).find((row) => row.model === 'tiered-video').resolution_prices), ['480p']);

  const free = prices.set(db, 'tiered-video', 0, { category: 'video', pricingMode: 'free' });

  assert.equal(free.pricing_mode, 'free');
  assert.deepEqual(free.resolution_prices, {});
  assert.deepEqual(prices.list(db).find((row) => row.model === 'tiered-video').resolution_prices, {});
  assert.equal(prices.calculateCharge(db, 'tiered-video', { resolution: '720p', duration: 5 }), 0);

  prices.set(db, 'tiered-image', 7, {
    category: 'image',
    resolution_prices: { '1k': { credits: 7 } },
  });
  prices.set(db, 'tiered-image', 0, { category: 'text', pricingMode: 'free' });
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM model_image_resolution_prices WHERE model = ?').get('tiered-image').count,
    0,
  );
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
      pricing_mode: 'paid',
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

test('视频分档存在时必须明确选择已定价分辨率且不回退基础价格', () => {
  const db = makeDb();
  prices.set(db, 'tiered-video', 3, {
    category: 'video',
    cost_unit: 'second',
    cost_micros_per_unit: 90000,
    resolution_prices: {
      '480p': { credits: 3, cost_micros_per_second: 90000 },
      '720p': { credits: 5, cost_micros_per_second: 140000 },
    },
  });

  for (const resolution of [undefined, '1080p']) {
    assert.throws(
      () => prices.calculateCharge(db, 'tiered-video', { duration: 5, resolution }),
      (error) => error.code === 'MODEL_RESOLUTION_PRICE_REQUIRED',
    );
    assert.throws(
      () => prices.quoteCost(db, 'tiered-video', { quantity: 5, resolution }),
      (error) => error.code === 'MODEL_RESOLUTION_PRICE_REQUIRED',
    );
  }
});

test('调用方可显式允许 ToAPIs 4 秒而旧模型仍保持 5 到 15 秒', () => {
  const db = makeDb();
  prices.set(db, 'seedance-2-fast', 511, {
    category: 'video',
    resolution_prices: {
      '480p': { credits: 511, cost_micros_per_second: 584000 },
      '720p': { credits: 511, cost_micros_per_second: 584000 },
    },
  });
  prices.set(db, 'legacy-video', 3, { category: 'video' });

  assert.equal(prices.calculateCharge(db, 'seedance-2-fast', {
    duration: 4,
    resolution: '480p',
    allowedDurations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  }), 2044);
  assert.throws(
    () => prices.calculateCharge(db, 'legacy-video', { duration: 4 }),
    (error) => error.code === 'INVALID_VIDEO_DURATION' && /5 到 15 秒/.test(error.message),
  );
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
  assert.throws(
    () => prices.quoteCost(db, 'tiered-image', { resolution: '1k', quantity: 1.5 }),
    (error) => error.code === 'INVALID_MODEL_PRICE',
  );
});

test('公开价格目录只返回用户价格字段且管理端仍保留完整成本', () => {
  const db = makeDb();
  db.exec(`CREATE TABLE ai_service_configs (
    id INTEGER PRIMARY KEY,
    service_type TEXT,
    model TEXT,
    default_model TEXT,
    is_active INTEGER DEFAULT 1,
    deleted_at TEXT
  )`);
  db.prepare(`INSERT INTO ai_service_configs
    (service_type, model, default_model, is_active, deleted_at)
    VALUES ('video', ?, 'public-video', 1, NULL)`)
    .run(JSON.stringify(['public-video']));
  prices.set(db, 'public-video', 3, {
    display_name: '公开视频模型',
    category: 'video',
    billing_unit: 'second',
    cost_unit: 'second',
    cost_micros_per_unit: 91000,
    input_cost_micros_per_1k: 1200,
    output_cost_micros_per_1k: 3400,
    resolution_prices: {
      '480p': { credits: 3, cost_micros_per_second: 51000 },
      '720p': { credits: 6, cost_micros_per_second: 121000 },
    },
  });

  const publicItem = prices.listPublic(db).find((row) => row.model === 'public-video');
  assert.deepEqual(publicItem, {
    model: 'public-video',
    display_name: '公开视频模型',
    public_note: '',
    category: 'video',
    credits: 3,
    pricing_mode: 'paid',
    status: 'enabled',
    billing_unit: 'second',
    resolution_prices: {
      '480p': { credits: 3 },
      '720p': { credits: 6 },
    },
  });
  assert.equal(/cost/i.test(JSON.stringify(publicItem)), false);

  const adminItem = prices.list(db).find((row) => row.model === 'public-video');
  assert.equal(adminItem.cost_unit, 'second');
  assert.equal(adminItem.cost_micros_per_unit, 91000);
  assert.equal(adminItem.input_cost_micros_per_1k, 1200);
  assert.equal(adminItem.output_cost_micros_per_1k, 3400);
  assert.equal(adminItem.resolution_prices['720p'].cost_micros_per_second, 121000);
});
