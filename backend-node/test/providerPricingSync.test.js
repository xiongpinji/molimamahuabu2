const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const pricingSync = require('../src/services/providerPricingSyncService');
const generationCost = require('../src/services/generationCostLedgerService');
const routeCost = require('../src/services/providerRouteCostService');
const modelPrice = require('../src/services/modelPriceService');
const billingRoutes = require('../src/routes/billing');

const NOW = '2026-09-02T00:00:00.000Z';

function pricingRow(overrides = {}) {
  return {
    model_name: 'seedance-2.0-fast',
    quota_type: 2,
    billing_unit: 'conditional',
    model_price: 0.4,
    conditional_prices: [
      { conditions: { resolution: '480p', 'video-reference': 'none' }, price: 0.2, unit: 'second' },
      { conditions: { resolution: '480p', 'video-reference': 'with' }, price: 0.2, unit: 'second' },
      { conditions: { resolution: '720p', 'video-reference': 'none' }, price: 0.4, unit: 'second' },
      { conditions: { resolution: '720p', 'video-reference': 'with' }, price: 0.4, unit: 'second' },
    ],
    ...overrides,
  };
}

function insertConfig(db, id = 29) {
  db.prepare(`INSERT INTO ai_service_configs
      (id, service_type, provider, api_protocol, name, base_url, api_key, model,
       default_model, is_active, deleted_at)
    VALUES (?, 'video', 'newapi', 'newapi_video', 'NewAPI',
      'https://newapi.example/v1', 'secret', ?, ?, 1, NULL)`)
    .run(id, JSON.stringify(['seedance-2.0-fast']), 'seedance-2.0-fast');
}

function insertMultiModelConfig(db, id = 30) {
  db.prepare(`INSERT INTO ai_service_configs
      (id, service_type, provider, api_protocol, name, base_url, api_key, model,
       default_model, is_active, deleted_at)
    VALUES (?, 'video', 'newapi', 'newapi_video', 'NewAPI Multi',
      'https://newapi.example/v1', 'secret', ?, ?, 1, NULL)`)
    .run(id, JSON.stringify(['seedance-2.0-fast', 'unsupported-ratio']), 'seedance-2.0-fast');
}

test('解析 NewAPI 报价为按秒人民币成本并保留原始美元快照', () => {
  const parsed = pricingSync.parsePricingRow(pricingRow(), { usdCnyRate: 7.2 });
  assert.deepEqual(parsed, {
    model: 'seedance-2.0-fast',
    source_currency: 'USD',
    cost_source: 'relay_auto',
    cost_unit: 'second',
    currency: 'CNY',
    micros_per_unit: 2_880_000,
    resolution_prices: {
      '480p': { micros_per_unit: 1_440_000 },
      '720p': { micros_per_unit: 2_880_000 },
    },
    source_exchange_rate: 7.2,
    source_price: pricingRow(),
  });
});

test('人民币展示的 NewAPI 报价不重复乘美元汇率', () => {
  const parsed = pricingSync.parsePricingRow(pricingRow(), {
    sourceCurrency: 'CNY',
    usdCnyRate: 7.2,
  });
  assert.equal(parsed.source_currency, 'CNY');
  assert.equal(parsed.source_exchange_rate, 1);
  assert.equal(parsed.micros_per_unit, 400_000);
  assert.deepEqual(parsed.resolution_prices, {
    '480p': { micros_per_unit: 200_000 },
    '720p': { micros_per_unit: 400_000 },
  });
});

test('条件报价按分辨率取最高档，避免台账低估成本', () => {
  const parsed = pricingSync.parsePricingRow(pricingRow({
    conditional_prices: [
      { conditions: { resolution: '720p', 'video-reference': 'none' }, price: 0.4, unit: 'second' },
      { conditions: { resolution: '720p', 'video-reference': 'with' }, price: 0.65, unit: 'second' },
    ],
  }), { usdCnyRate: 7.2 });
  assert.equal(parsed.resolution_prices['720p'].micros_per_unit, 4_680_000);
  assert.equal(parsed.micros_per_unit, 4_680_000);
});

test('倍率计费报价不自动换算为人民币成本', () => {
  const parsed = pricingSync.parsePricingRow({
    model_name: 'gpt-5.6-sol',
    quota_type: 0,
    model_ratio: 2,
    completion_ratio: 1,
    model_price: 0,
  }, { usdCnyRate: 7.2 });
  assert.equal(parsed, null);
});

test('自动同步不覆盖手工成本，但会更新已有自动成本', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    runMigrationsAndEnsure(db);
    insertConfig(db);
    const first = pricingSync.saveRelayCost(db, 29, 'seedance-2.0-fast', pricingRow(), {
      usdCnyRate: 7.2,
      sourceUrl: 'https://newapi.example/api/pricing',
      fetchedAt: NOW,
    });
    assert.equal(first.action, 'inserted');
    assert.equal(first.cost.micros_per_unit, 2_880_000);

    const second = pricingSync.saveRelayCost(db, 29, 'seedance-2.0-fast', pricingRow({
      model_price: 0.5,
      conditional_prices: [
        { conditions: { resolution: '480p' }, price: 0.25, unit: 'second' },
        { conditions: { resolution: '720p' }, price: 0.5, unit: 'second' },
      ],
    }), {
      usdCnyRate: 7.2,
      sourceUrl: 'https://newapi.example/api/pricing',
      fetchedAt: NOW,
    });
    assert.equal(second.action, 'updated');
    assert.equal(second.cost.micros_per_unit, 3_600_000);

    const unchanged = pricingSync.saveRelayCost(db, 29, 'seedance-2.0-fast', pricingRow({
      model_price: 0.5,
      conditional_prices: [
        { conditions: { resolution: '480p' }, price: 0.25, unit: 'second' },
        { conditions: { resolution: '720p' }, price: 0.5, unit: 'second' },
      ],
    }), {
      usdCnyRate: 7.2,
      sourceUrl: 'https://newapi.example/api/pricing',
      fetchedAt: '2026-09-02T01:00:00.000Z',
    });
    assert.equal(unchanged.action, 'unchanged');
    assert.equal(unchanged.cost.source_fetched_at, '2026-09-02T01:00:00.000Z');

    pricingSync.setManualCost(db, 29, 'seedance-2.0-fast', {
      cost_unit: 'second',
      micros_per_unit: 9_000_000,
      resolution_prices: { '720p': { micros_per_unit: 9_000_000 } },
    }, { now: NOW });
    const third = pricingSync.saveRelayCost(db, 29, 'seedance-2.0-fast', pricingRow({ model_price: 0.6 }), {
      usdCnyRate: 7.2,
      sourceUrl: 'https://newapi.example/api/pricing',
      fetchedAt: NOW,
    });
    assert.equal(third.action, 'skipped_manual');
    assert.equal(third.cost.micros_per_unit, 9_000_000);
  } finally {
    db.close();
  }
});

test('美元汇率保存在经营台账设置中并可供同步读取', () => {
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    generationCost.updateSettings(db, { credit_value_micros: 50_000, usd_cny_rate_micros: 7_236_000 });
    assert.deepEqual(generationCost.getSettings(db), {
      credit_value_micros: 50_000,
      usd_cny_rate_micros: 7_236_000,
      updated_at: generationCost.getSettings(db).updated_at,
    });
    assert.equal(pricingSync.readUsdCnyRate(db), 7.236);
  } finally {
    db.close();
  }
});

test('同步配置时按中转站地址抓取并逐模型保存报价', async () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    runMigrationsAndEnsure(db);
    insertMultiModelConfig(db);
    const calls = [];
    const result = await pricingSync.syncProviderConfig(db, 30, {
      usdCnyRate: 7.2,
      fetchedAt: NOW,
      fetchImpl: async (url) => {
        calls.push(url);
        return {
          ok: true,
          async json() {
            return { success: true, data: [pricingRow(), {
              model_name: 'unsupported-ratio',
              quota_type: 0,
              model_ratio: 2,
            }] };
          },
        };
      },
    });
    assert.deepEqual(calls, [
      'https://newapi.example/api/status',
      'https://newapi.example/api/pricing',
    ]);
    assert.equal(result.saved, 1);
    assert.equal(result.skipped, 1);
    assert.equal(pricingSync.getCost(db, 30, 'seedance-2.0-fast').source_url,
      'https://newapi.example/api/pricing');
  } finally {
    db.close();
  }
});

test('同步人民币展示的中转站时先识别币种并保存真实人民币成本', async () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    runMigrationsAndEnsure(db);
    insertConfig(db, 36);
    const calls = [];
    const result = await pricingSync.syncProviderConfig(db, 36, {
      usdCnyRate: 7.2,
      fetchedAt: NOW,
      fetchImpl: async (url) => {
        calls.push(url);
        if (url === 'https://newapi.example/api/status') {
          return {
            ok: true,
            async json() {
              return { success: true, data: {
                display_in_currency: true,
                quota_display_type: 'CNY',
                usd_exchange_rate: 1,
              } };
            },
          };
        }
        return {
          ok: true,
          async json() { return { success: true, data: [pricingRow()] }; },
        };
      },
    });
    assert.deepEqual(calls, [
      'https://newapi.example/api/status',
      'https://newapi.example/api/pricing',
    ]);
    assert.equal(result.saved, 1);
    const cost = pricingSync.getCost(db, 36, 'seedance-2.0-fast');
    assert.equal(cost.source_currency, 'CNY');
    assert.equal(cost.source_exchange_rate, 1);
    assert.equal(cost.resolution_prices['480p'].micros_per_unit, 200_000);
  } finally {
    db.close();
  }
});

test('生成成本台账按配置内的具体模型引用自动同步成本', async () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    runMigrationsAndEnsure(db);
    insertMultiModelConfig(db, 31);
    await pricingSync.syncProviderConfig(db, 31, {
      usdCnyRate: 7.2,
      fetchedAt: NOW,
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return { success: true, data: [pricingRow()] };
        },
      }),
    });
    const quote = routeCost.quoteRouteCost(db, {
      configId: 31,
      model: 'seedance-2.0-fast',
      resolution: '720p',
      duration: 5,
    });
    assert.equal(quote.cost_micros, 14_400_000);
    assert.equal(quote.cost_source, 'provider_route');
  } finally {
    db.close();
  }
});

test('现有配置级手工成本优先于自动同步成本', async () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    runMigrationsAndEnsure(db);
    insertMultiModelConfig(db, 34);
    routeCost.setRouteCost(db, 34, {
      cost_unit: 'second',
      micros_per_unit: 9_000_000,
      resolution_prices: { '720p': { micros_per_unit: 9_000_000 } },
    });
    await pricingSync.syncProviderConfig(db, 34, {
      usdCnyRate: 7.2,
      fetchedAt: NOW,
      fetchImpl: async () => ({
        ok: true,
        async json() { return { success: true, data: [pricingRow()] }; },
      }),
    });
    const quote = routeCost.quoteRouteCost(db, {
      configId: 34,
      model: 'seedance-2.0-fast',
      resolution: '720p',
      duration: 1,
    });
    assert.equal(quote.cost_micros, 9_000_000);
  } finally {
    db.close();
  }
});

test('配置级线路成本优先于模型级手工或自动成本', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    runMigrationsAndEnsure(db);
    insertMultiModelConfig(db, 35);
    pricingSync.setManualCost(db, 35, 'seedance-2.0-fast', {
      cost_unit: 'second',
      micros_per_unit: 12_000_000,
    }, { now: NOW });
    routeCost.setRouteCost(db, 35, {
      cost_unit: 'second',
      micros_per_unit: 9_000_000,
    }, { now: NOW });
    const quote = routeCost.quoteRouteCost(db, {
      configId: 35,
      model: 'seedance-2.0-fast',
      duration: 1,
    });
    assert.equal(quote.cost_micros, 9_000_000);
  } finally {
    db.close();
  }
});

test('管理员模型目录返回每个中转站模型的同步成本来源', async () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    runMigrationsAndEnsure(db);
    insertMultiModelConfig(db, 32);
    await pricingSync.syncProviderConfig(db, 32, {
      usdCnyRate: 7.2,
      fetchedAt: NOW,
      fetchImpl: async () => ({
        ok: true,
        async json() { return { success: true, data: [pricingRow()] }; },
      }),
    });
    const item = modelPrice.list(db).find((row) => row.model === 'cfg-32::seedance-2.0-fast');
    assert.equal(item.providers[0].config_id, 32);
    assert.equal(item.providers[0].upstream_model, 'seedance-2.0-fast');
    assert.equal(item.provider_costs[0].micros_per_unit, 2_880_000);
    assert.equal(item.provider_costs[0].source_currency, 'USD');
  } finally {
    db.close();
  }
});

test('NewAPI 图片配置保持原模型计费身份且不继承视频限定前缀', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    runMigrationsAndEnsure(db);
    db.prepare(`INSERT INTO ai_service_configs
        (id, service_type, provider, api_protocol, name, base_url, api_key, model,
         default_model, is_active, deleted_at)
      VALUES (36, 'storyboard_image', 'newapi', 'openai', 'NewAPI Image',
        'https://newapi-image.example/v1', 'secret', ?, ?, 1, NULL)`)
      .run(JSON.stringify(['image-model']), 'image-model');

    const rows = modelPrice.list(db);
    const item = rows.find((row) => row.model === 'image-model');
    assert.equal(item.providers[0].config_id, 36);
    assert.equal(rows.some((row) => row.model === 'cfg-36::image-model'), false);
  } finally {
    db.close();
  }
});

test('管理员同步接口使用已保存汇率并返回逐配置结果', async () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    runMigrationsAndEnsure(db);
    insertMultiModelConfig(db, 33);
    generationCost.updateSettings(db, { usd_cny_rate_micros: 7_200_000 });
    const handlers = billingRoutes(db, { warn() {}, error() {} }, {
      providerPricingSync: {
        async syncAllProviderPricing(_db, options) {
          assert.equal(options.usdCnyRate, 7.2);
          return [{ saved: 1 }];
        },
      },
    });
    const response = {
      status() { return this; },
      json(payload) { this.payload = payload; },
    };
    await handlers.syncProviderPricing({
    }, response);
    assert.equal(response.payload.success, true);
    assert.equal(response.payload.data.rate, 7.2);
    assert.equal(response.payload.data.results[0].saved, 1);
  } finally {
    db.close();
  }
});
