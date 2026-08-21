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

test('保存模型展示名称和公开备注时去掉首尾空格', () => {
  const db = makeDb();
  const saved = prices.set(db, 'video-model', 7, {
    category: 'video',
    display_name: '  极速视频  ',
    public_note: '  支持 480P，适合快速预览。  ',
  });

  assert.equal(saved.display_name, '极速视频');
  assert.equal(saved.public_note, '支持 480P，适合快速预览。');
  const listed = prices.list(db).find((row) => row.model === 'video-model');
  assert.equal(listed.display_name, '极速视频');
  assert.equal(listed.public_note, '支持 480P，适合快速预览。');
});

test('公开备注最多允许 500 个字符', () => {
  const db = makeDb();
  assert.throws(
    () => prices.set(db, 'video-model', 7, { public_note: '注'.repeat(501) }),
    (error) => error.code === 'INVALID_MODEL_PRICE',
  );
  const saved = prices.set(db, 'video-model', 7, { public_note: '注'.repeat(500) });
  assert.equal(saved.public_note.length, 500);
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

test('按条计费的视频模型不会再乘视频时长且供应商成本只记录一次', () => {
  const db = makeDb();
  const saved = prices.set(db, 'sdas-my-seedance-2.0-fast-upscaled-1080p', 860, {
    display_name: 'Seedance 2.0 Fast 480P 超分 1080P',
    category: 'video',
    billing_unit: 'request',
    cost_unit: 'request',
    cost_micros_per_unit: 2800000,
  });

  assert.equal(saved.billing_unit, 'request');
  assert.equal(prices.calculateCharge(db, saved.model, { duration: 15 }), 860);
  assert.deepEqual(prices.quoteCost(db, saved.model, { quantity: 15 }), {
    model: 'sdas-my-seedance-2.0-fast-upscaled-1080p',
    cost_unit: 'request',
    quantity: 1,
    cost_micros: 2800000,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
  });
});

test('模型计费列表返回所属中转站标识且不泄露密钥', () => {
  const db = makeDb();
  db.exec(`CREATE TABLE ai_service_configs (
    id INTEGER PRIMARY KEY,
    service_type TEXT NOT NULL,
    provider TEXT,
    name TEXT,
    base_url TEXT,
    api_key TEXT,
    model TEXT,
    default_model TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    deleted_at TEXT
  )`);
  db.prepare(`INSERT INTO ai_service_configs
    (id, service_type, provider, name, base_url, api_key, model, default_model, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      1, 'video', 'usmercari', 'USMercari 三模型视频', 'https://chat-ai.mercarimx.com/v1', 'secret-a',
      JSON.stringify(['MiniMax H3', 'seedance-2.0-fast']), 'MiniMax H3', 1,
      2, 'image', 'other-provider', '其他图片站', 'https://images.example/v1', 'secret-b',
      JSON.stringify(['gpt-image-2']), 'gpt-image-2', 1,
    );

  const rows = prices.list(db);
  const minimax = rows.find((row) => row.model.toLowerCase() === 'minimax h3');
  const image = rows.find((row) => row.model.toLowerCase() === 'gpt-image-2');
  assert.equal(minimax.provider, 'usmercari');
  assert.equal(minimax.provider_name, 'USMercari 三模型视频');
  assert.equal(minimax.provider_base_url, 'https://chat-ai.mercarimx.com/v1');
  assert.equal(image.provider, 'other-provider');
  assert.equal(JSON.stringify(rows).includes('secret-a'), false);
  assert.equal(JSON.stringify(rows).includes('secret-b'), false);
});

test('视频按次计费时分辨率积分档位仍按一次收取，供应商成本保持按秒', () => {
  const db = makeDb();
  prices.set(db, 'request-resolution-video', 2, {
    category: 'video',
    billing_unit: 'request',
    cost_unit: 'second',
    resolution_prices: {
      '480p': { credits: 2, cost_micros_per_second: 50000 },
      '720p': { credits: 5, cost_micros_per_second: 120000 },
    },
  });

  assert.equal(prices.calculateCharge(db, 'request-resolution-video', {
    duration: 15,
    resolution: '480p',
  }), 2);
  assert.equal(prices.calculateCharge(db, 'request-resolution-video', {
    duration: 5,
    resolution: '720p',
  }), 5);
  assert.deepEqual(prices.quoteCost(db, 'request-resolution-video', {
    quantity: 15,
    resolution: '720p',
  }), {
    model: 'request-resolution-video',
    cost_unit: 'second',
    quantity: 15,
    cost_micros: 1800000,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    resolution: '720p',
  });
});

test('视频模型按 480P 和 720P 分别计算积分与每秒成本', () => {
  const db = makeDb();
  const saved = prices.set(db, 'resolution-video', 2, {
    category: 'video',
    cost_unit: 'second',
    cost_micros_per_unit: 80000,
    resolution_prices: {
      '480p': { credits: 2, cost_micros_per_second: 50000 },
      '720p': { credits: 5, cost_micros_per_second: 140000 },
    },
  });

  assert.deepEqual(saved.resolution_prices, {
    '480p': { credits: 2, cost_micros_per_second: 50000 },
    '720p': { credits: 5, cost_micros_per_second: 140000 },
  });
  assert.equal(prices.calculateCharge(db, 'resolution-video', { duration: 8, resolution: '480P' }), 16);
  assert.equal(prices.calculateCharge(db, 'resolution-video', { duration: 8, resolution: '720p' }), 40);
  assert.equal(prices.quoteCost(db, 'resolution-video', { quantity: 8, resolution: '480p' }).cost_micros, 400000);
  assert.equal(prices.quoteCost(db, 'resolution-video', { quantity: 8, resolution: '720P' }).cost_micros, 1120000);
  assert.deepEqual(prices.list(db).find((row) => row.model === 'resolution-video').resolution_prices, saved.resolution_prices);
});

test('未配置分辨率档位的视频模型继续使用原有按秒积分与成本', () => {
  const db = makeDb();
  prices.set(db, 'legacy-video', 3, {
    category: 'video',
    cost_unit: 'second',
    cost_micros_per_unit: 90000,
  });

  assert.equal(prices.calculateCharge(db, 'legacy-video', { duration: 6, resolution: '720p' }), 18);
  assert.equal(prices.quoteCost(db, 'legacy-video', { quantity: 6, resolution: '720p' }).cost_micros, 540000);
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

test('公开价格目录只返回用户价格字段且管理端仍保留完整成本', () => {
  const db = makeDb();
  db.exec(`CREATE TABLE ai_service_configs (
    id INTEGER PRIMARY KEY,
    service_type TEXT,
    provider TEXT,
    api_protocol TEXT,
    model TEXT,
    default_model TEXT,
    is_active INTEGER DEFAULT 1,
    verification_status TEXT,
    deleted_at TEXT
  )`);
  db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, api_protocol, model, default_model, is_active, verification_status, deleted_at)
    VALUES ('video', 'fixture', 'openai', ?, 'public-video', 1, 'verified', NULL)`)
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
