const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const credits = require('../src/services/creditLedgerService');
const costs = require('../src/services/generationCostLedgerService');
const prices = require('../src/services/modelPriceService');
const aiConfig = require('../src/services/aiConfigService');
const routeCosts = require('../src/services/providerRouteCostService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {} };

function addRoute(db, serviceType, logicalModel, cost) {
  const config = aiConfig.createConfig(db, log, {
    service_type: serviceType,
    provider: `ledger-${serviceType}`,
    name: `${logicalModel} 线路`,
    base_url: `https://${serviceType}.invalid/v1`,
    api_key: 'test-key',
    model: [`${logicalModel}-upstream`],
    default_model: `${logicalModel}-upstream`,
    logical_model_id: logicalModel,
    is_active: true,
  });
  routeCosts.setRouteCost(db, config.id, cost);
  return config.id;
}

function reserveConfirmed(db, input) {
  const reservation = credits.reserve(db, {
    actorUserId: 'admin-1',
    userId: input.userId,
    operationKey: input.operationKey,
    model: input.model,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    amount: input.amount,
  });
  credits.confirm(db, reservation.id);
  return reservation;
}

test('经营台账按日汇总图片与文本推理模型的积分、成本和预计利润', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  credits.setAccountBalance(db, 'user-1', 100);
  prices.set(db, 'image-model', 10, {
    category: 'image',
    cost_unit: 'image',
    cost_micros_per_unit: 200000,
  });
  prices.set(db, 'reasoning-model', 5, {
    category: 'text',
    cost_unit: 'token',
    input_cost_micros_per_1k: 1000,
    output_cost_micros_per_1k: 3000,
  });
  const imageConfigId = addRoute(db, 'image', 'image-model', {
    cost_unit: 'image', micros_per_unit: 200000,
  });
  const textConfigId = addRoute(db, 'text', 'reasoning-model', {
    cost_unit: 'token', input_cost_micros_per_1k: 1000, output_cost_micros_per_1k: 3000,
  });

  const image = reserveConfirmed(db, {
    userId: 'user-1',
    operationKey: 'image:1',
    model: 'image-model',
    resourceType: 'image',
    resourceId: '1',
    amount: 10,
  });
  costs.record(db, {
    reservationId: image.id,
    model: 'image-model',
    configId: imageConfigId,
    count: 1,
    usageSource: 'provider',
  });

  const text = reserveConfirmed(db, {
    userId: 'user-1',
    operationKey: 'text:1',
    model: 'reasoning-model',
    resourceType: 'script',
    resourceId: '1',
    amount: 5,
  });
  costs.record(db, {
    reservationId: text.id,
    model: 'reasoning-model',
    configId: textConfigId,
    inputTokens: 1000,
    outputTokens: 2000,
    reasoningTokens: 800,
    usageSource: 'provider',
  });
  costs.updateSettings(db, 50000);

  const report = costs.report(db, 'day');
  assert.equal(report.summary.usage_count, 2);
  assert.equal(report.summary.credits_consumed, 15);
  assert.equal(report.summary.cost_micros, 207000);
  assert.equal(report.summary.estimated_revenue_micros, 750000);
  assert.equal(report.summary.estimated_profit_micros, 543000);
  const textRow = report.rows.find((row) => row.model === 'reasoning-model');
  assert.equal(textRow.input_tokens, 1000);
  assert.equal(textRow.output_tokens, 2000);
  assert.equal(textRow.reasoning_tokens, 800);
  assert.equal(textRow.uncosted_usage_count, 0);
});

test('经营台账拒绝未知统计周期', () => {
  const db = new Database(':memory:');
  assert.throws(
    () => costs.report(db, 'week'),
    (error) => error.code === 'INVALID_LEDGER_PERIOD',
  );
});

test('经营台账按视频分辨率分别记录和汇总成本', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  credits.setAccountBalance(db, 'user-1', 100);
  prices.set(db, 'resolution-video', 2, {
    category: 'video',
    cost_unit: 'second',
    resolution_prices: {
      '480p': { credits: 2, cost_micros_per_second: 50000 },
      '720p': { credits: 4, cost_micros_per_second: 120000 },
    },
  });
  const configId = addRoute(db, 'video', 'resolution-video', {
    cost_unit: 'second',
    micros_per_unit: 50_000,
    resolution_prices: {
      '480p': { micros_per_unit: 50_000 },
      '720p': { micros_per_unit: 120_000 },
    },
  });

  for (const [resolution, amount] of [['480p', 10], ['720p', 20]]) {
    const reservation = reserveConfirmed(db, {
      userId: 'user-1',
      operationKey: `video:${resolution}`,
      model: 'resolution-video',
      resourceType: 'video',
      resourceId: resolution,
      amount,
    });
    costs.record(db, {
      reservationId: reservation.id,
      model: 'resolution-video',
      configId,
      count: 1,
      duration: 5,
      resolution,
      usageSource: 'configured',
    });
  }

  const rows = costs.report(db, 'day').rows;
  assert.deepEqual(rows.map((row) => ({ resolution: row.resolution, cost_micros: row.cost_micros })), [
    { resolution: '480p', cost_micros: 250000 },
    { resolution: '720p', cost_micros: 600000 },
  ]);
});
