const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const aiConfig = require('../src/services/aiConfigService');
const costs = require('../src/services/generationCostLedgerService');
const routeCosts = require('../src/services/providerRouteCostService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {} };

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  return db;
}

function addRoute(db, input) {
  const config = aiConfig.createConfig(db, log, {
    service_type: input.serviceType,
    provider: input.provider,
    name: input.name,
    base_url: `https://${input.provider}.invalid/v1`,
    api_key: 'test-key',
    model: [input.upstreamModel],
    default_model: input.upstreamModel,
    logical_model_id: input.logicalModel,
    is_active: true,
  });
  routeCosts.setRouteCost(db, config.id, input.cost);
  return config;
}

test('同一逻辑模型按最终 config_id 分别记录固定请求与按秒线路成本', (t) => {
  const db = setup();
  t.after(() => db.close());
  const fixed = addRoute(db, {
    serviceType: 'video', provider: 'route-fixed', name: '固定请求线路',
    upstreamModel: 'upstream-fixed', logicalModel: 'shared-video',
    cost: { cost_unit: 'request', micros_per_unit: 46_000 },
  });
  const perSecond = addRoute(db, {
    serviceType: 'video', provider: 'route-second', name: '按秒线路',
    upstreamModel: 'upstream-second', logicalModel: 'shared-video',
    cost: { cost_unit: 'second', micros_per_unit: 100_000 },
  });

  const fixedRow = costs.record(db, {
    reservationId: 'fixed', model: 'shared-video', configId: fixed.id,
    count: 1, duration: 15, usageSource: 'provider',
  });
  const secondRow = costs.record(db, {
    reservationId: 'second', model: 'shared-video', configId: perSecond.id,
    count: 1, duration: 15, usageSource: 'provider',
  });

  assert.equal(fixedRow.cost_micros, 46_000);
  assert.equal(secondRow.cost_micros, 1_500_000);
  assert.equal(fixedRow.config_id, fixed.id);
  assert.equal(secondRow.config_id, perSecond.id);
  assert.equal(fixedRow.cost_source, 'provider_route');
  assert.deepEqual(JSON.parse(fixedRow.cost_snapshot_json), {
    schema_version: 1,
    config_id: fixed.id,
    currency: 'CNY',
    cost_unit: 'request',
    micros_per_unit: 46_000,
    input_cost_micros_per_1k: 0,
    output_cost_micros_per_1k: 0,
    resolution_prices: {},
  });
  assert.doesNotMatch(fixedRow.cost_snapshot_json, /provider|base_url|api_key|upstream/i);
});

test('文本成本按最终线路 token 费率和实际用量结算且重复回调幂等', (t) => {
  const db = setup();
  t.after(() => db.close());
  const route = addRoute(db, {
    serviceType: 'text', provider: 'route-text', name: '文本线路',
    upstreamModel: 'text-upstream', logicalModel: 'shared-text',
    cost: {
      cost_unit: 'token', input_cost_micros_per_1k: 1_000,
      output_cost_micros_per_1k: 3_000,
    },
  });
  const input = {
    reservationId: 'text', model: 'shared-text', configId: route.id,
    inputTokens: 1_000, outputTokens: 2_000, reasoningTokens: 800,
    usageSource: 'provider',
  };

  const first = costs.record(db, input);
  const second = costs.record(db, input);

  assert.equal(first.cost_micros, 7_000);
  assert.equal(second.cost_micros, 7_000);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM generation_cost_records WHERE reservation_id = 'text'").get().count, 1);
});

test('已结算的线路成本快照不被后续改价或重复回调改写', (t) => {
  const db = setup();
  t.after(() => db.close());
  const route = addRoute(db, {
    serviceType: 'image', provider: 'route-snapshot', name: '快照线路',
    upstreamModel: 'image-upstream', logicalModel: 'shared-image',
    cost: { cost_unit: 'request', micros_per_unit: 46_000 },
  });

  const first = costs.record(db, {
    reservationId: 'snapshot', model: 'shared-image', configId: route.id,
    count: 1, usageSource: 'provider',
  });
  routeCosts.setRouteCost(db, route.id, { cost_unit: 'request', micros_per_unit: 99_000 });
  const repeated = costs.record(db, {
    reservationId: 'snapshot', model: 'shared-image', configId: route.id,
    count: 1, usageSource: 'provider',
  });

  assert.equal(first.cost_micros, 46_000);
  assert.equal(repeated.cost_micros, 46_000);
  assert.equal(JSON.parse(repeated.cost_snapshot_json).micros_per_unit, 46_000);
});

test('未确定线路、明确失败与结果未知均不猜供应商成本', (t) => {
  const db = setup();
  t.after(() => db.close());

  const unavailable = costs.record(db, {
    reservationId: 'unavailable', model: 'shared-image', usageSource: 'unavailable',
  });
  const unknown = costs.record(db, {
    reservationId: 'unknown', model: 'shared-image', usageSource: 'unknown',
  });

  assert.deepEqual(
    [unavailable, unknown].map((row) => ({
      config_id: row.config_id,
      cost_micros: row.cost_micros,
      cost_source: row.cost_source,
      cost_snapshot_json: row.cost_snapshot_json,
    })),
    [
      { config_id: null, cost_micros: 0, cost_source: 'unavailable', cost_snapshot_json: null },
      { config_id: null, cost_micros: 0, cost_source: 'unknown', cost_snapshot_json: null },
    ],
  );
});
