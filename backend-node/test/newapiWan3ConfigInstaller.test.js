'use strict';

const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const test = require('node:test');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const canvasModelCatalogService = require('../src/services/canvasModelCatalogService');
const modelPriceService = require('../src/services/modelPriceService');
const providerPricingSyncService = require('../src/services/providerPricingSyncService');
const {
  CAPABILITIES,
  EXPECTED_MODELS,
  PRICES,
  applyConfiguration,
} = require('../../deploy/apply-newapi-wan3-config');

const UPDATED_AT = '2026-09-03T06:10:00.000Z';

function fixture() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  modelPriceService.ensureSchema(db);
  const capabilities = Object.fromEntries(EXPECTED_MODELS.map((model) => [model, {
    validated: true,
    resolutions: [PRICES[model].resolution],
  }]));
  const evidence = {
    contract: 'real-generation-readable-artifact-v1',
    provider: 'newapi',
    base_url: 'https://newapi.megabyai.cc',
    verified_at: UPDATED_AT,
    models: Object.fromEntries(EXPECTED_MODELS.map((model) => [model, {
      task_id: `verified-${model}`,
      status: 'completed',
      sha256: 'b'.repeat(64),
    }])),
  };
  db.prepare(`INSERT INTO ai_service_configs
      (id, service_type, provider, api_protocol, name, base_url, api_key, model,
       default_model, is_active, verification_status, verified_capabilities,
       verification_evidence, verified_at, created_at, updated_at)
    VALUES (29, 'video', 'newapi', 'newapi_video', 'NewAPI megabyai（6模型，已实测）',
      'https://newapi.megabyai.cc', 'production-secret', ?, 'seedance-2.0-mini', 1,
      'verified', ?, ?, ?, ?, ?)`)
    .run(JSON.stringify(EXPECTED_MODELS), JSON.stringify(capabilities), JSON.stringify(evidence),
      UPDATED_AT, UPDATED_AT, UPDATED_AT);
  db.prepare(`INSERT INTO ai_service_configs
      (id, service_type, provider, api_protocol, name, base_url, api_key, model,
       default_model, is_active, verification_status, verified_capabilities,
       verification_evidence, verified_at, created_at, updated_at)
    VALUES (15, 'video', 'usmercari', 'usmercari_media', '另一中转站',
      'https://other.example', 'other-secret', ?, 'seedance-2.0-mini', 1,
      'verified', '{}', '{}', ?, ?, ?)`)
    .run(JSON.stringify(['seedance-2.0-fast', 'seedance-2.0-mini']), UPDATED_AT, UPDATED_AT, UPDATED_AT);

  for (const model of EXPECTED_MODELS) {
    const definition = PRICES[model];
    providerPricingSyncService.saveRelayCost(db, 29, model, {
      model_name: model,
      quota_type: 1,
      billing_unit: 'second',
      resolution_prices: { [definition.resolution]: definition.cost / 1_000_000 },
      resolution_price_units: { [definition.resolution]: 'second' },
    }, {
      sourceCurrency: 'CNY',
      sourceUrl: 'https://newapi.megabyai.cc/api/pricing',
      fetchedAt: UPDATED_AT,
    });
  }
  return db;
}

test('六个 NewAPI 模型按实测组合定价并把同名模型固定到配置 29', (t) => {
  const db = fixture();
  t.after(() => db.close());

  const receipt = applyConfiguration(db, {
    expectedUpdatedAt: UPDATED_AT,
    now: '2026-09-03T07:00:00.000Z',
  });
  const row = db.prepare(`SELECT name, api_key, model, verified_capabilities,
      verification_evidence, verified_at FROM ai_service_configs WHERE id = 29`).get();
  assert.equal(row.api_key, 'production-secret');
  assert.deepEqual(JSON.parse(row.model), EXPECTED_MODELS);
  assert.equal(row.name, 'NewAPI megabyai（6模型，已实测）');
  assert.deepEqual(JSON.parse(row.verified_capabilities), CAPABILITIES);
  assert.equal(JSON.parse(row.verification_evidence).models['seedance-2.0'].task_id, 'verified-seedance-2.0');
  assert.equal(row.verified_at, UPDATED_AT);

  const expectedBillingIds = {
    'seedance-2.0-fast': 'cfg-29::seedance-2.0-fast',
    'seedance-2.0-mini': 'cfg-29::seedance-2.0-mini',
  };
  for (const model of EXPECTED_MODELS) {
    const definition = PRICES[model];
    const billingModel = expectedBillingIds[model] || model;
    const price = modelPriceService.list(db).find((item) => item.model === billingModel);
    assert.equal(price.credits, definition.credits, model);
    assert.equal(price.status, 'enabled', model);
    assert.equal(price.billing_unit, 'second', model);
    assert.equal(price.cost_micros_per_unit, definition.cost, model);
    assert.deepEqual(price.resolution_prices, {
      [definition.resolution]: {
        credits: definition.credits,
        cost_micros_per_second: definition.cost,
      },
    }, model);
  }

  const catalog = canvasModelCatalogService.list(db)
    .filter((item) => item.protocol === 'newapi_video');
  assert.deepEqual(catalog.map((item) => item.model).sort(), EXPECTED_MODELS
    .map((model) => expectedBillingIds[model] || model).sort());
  assert.deepEqual(catalog.find((item) => item.model.includes('minimax_h3')).capabilities, CAPABILITIES.minimax_h3_image_audio_to_video_v2);
  assert.equal(JSON.stringify(receipt).includes('production-secret'), false);
  assert.equal(receipt.contract, 'newapi-six-model-public-remediation-v1');
});

test('六模型配置修复遇到过期 updated_at 时零写入', (t) => {
  const db = fixture();
  t.after(() => db.close());
  const pricesBefore = JSON.stringify(modelPriceService.list(db));
  assert.throws(() => applyConfiguration(db, {
    expectedUpdatedAt: '2026-09-02T00:00:00.000Z',
    now: '2026-09-03T07:00:00.000Z',
  }), /已变化/);
  assert.equal(db.prepare('SELECT updated_at FROM ai_service_configs WHERE id = 29').get().updated_at, UPDATED_AT);
  assert.equal(JSON.stringify(modelPriceService.list(db)), pricesBefore);
});

test('六模型配置修复遇到非自动或错误中转站成本时零写入', (t) => {
  const db = fixture();
  t.after(() => db.close());
  providerPricingSyncService.setManualCost(db, 29, 'seedance-2.0', {
    currency: 'CNY',
    cost_unit: 'second',
    micros_per_unit: 999_000,
    resolution_prices: { '480p': { micros_per_unit: 999_000 } },
  });
  const pricesBefore = JSON.stringify(modelPriceService.list(db));
  assert.throws(() => applyConfiguration(db, {
    expectedUpdatedAt: UPDATED_AT,
    now: '2026-09-03T07:00:00.000Z',
  }), /自动中转站成本未匹配/);
  assert.equal(db.prepare('SELECT updated_at FROM ai_service_configs WHERE id = 29').get().updated_at, UPDATED_AT);
  assert.equal(JSON.stringify(modelPriceService.list(db)), pricesBefore);
});
