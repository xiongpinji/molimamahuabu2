'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const canvasCatalog = require('../src/services/canvasModelCatalogService');
const modelPrice = require('../src/services/modelPriceService');
const routeCost = require('../src/services/providerRouteCostService');

function insertRoute(db, id, overrides = {}) {
  const row = {
    id,
    service_type: 'video',
    provider: `private-relay-${id}`,
    api_protocol: 'private_video',
    name: `Private Route ${id}`,
    base_url: `https://relay-${id}.example/v1`,
    api_key: `fixture-credential-${id}`,
    model: JSON.stringify([`upstream-${id}`]),
    default_model: `upstream-${id}`,
    logical_model_id: 'shared-catalog-video',
    priority: 100 - id,
    is_active: 1,
    verification_status: 'verified',
    settings: JSON.stringify({
      canvas_capabilities: {
        resolutions: ['480p', '720p'],
        durations: [5, 10],
        aspectRatios: ['16:9'],
        provider: 'nested-private-provider',
        relay_url: 'https://nested-private.example/v1',
      },
    }),
    ...overrides,
  };
  db.prepare(`INSERT INTO ai_service_configs
      (id, service_type, provider, api_protocol, name, base_url, api_key, model,
       default_model, logical_model_id, priority, is_active, verification_status, settings)
    VALUES (@id, @service_type, @provider, @api_protocol, @name, @base_url, @api_key, @model,
      @default_model, @logical_model_id, @priority, @is_active, @verification_status, @settings)`)
    .run(row);
}

function insertEvidence(db, configId) {
  db.prepare(`INSERT INTO provider_canary_evidence
      (config_id, service_type, capability_fingerprint, capability_json, state,
       config_fingerprint, cost_fingerprint, runtime_fingerprint, created_at, updated_at)
    VALUES (?, 'video', ?, ?, 'failing', 'config-fp', 'cost-fp', 'runtime-fp', ?, ?)`)
    .run(
      configId,
      `capability-${configId}`,
      JSON.stringify({ serviceType: 'video', resolution: '480p', duration: 5 }),
      '2026-08-22T00:00:00.000Z',
      '2026-08-22T00:00:00.000Z',
    );
}

test('用户目录合并同逻辑模型并隐藏供应商、配置、证据与内部成本', () => {
  const previousMode = process.env.PROVIDER_CANARY_MODE;
  process.env.PROVIDER_CANARY_MODE = 'shadow';
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    insertRoute(db, 9101, { priority: 100 });
    insertRoute(db, 9102, { priority: 90 });
    insertRoute(db, 9103, {
      logical_model_id: 'shared-unpriced-video',
      default_model: 'unpriced-upstream',
      model: JSON.stringify(['unpriced-upstream']),
    });
    insertRoute(db, 9104, {
      logical_model_id: 'shared-disabled-video',
      is_active: 0,
    });
    modelPrice.set(db, 'shared-catalog-video', 40, {
      category: 'video',
      billing_unit: 'second',
      resolution_prices: {
        '480p': { credits: 40, cost_micros_per_second: 51_000 },
        '720p': { credits: 70, cost_micros_per_second: 89_000 },
      },
    });
    routeCost.setRouteCost(db, 9101, {
      cost_unit: 'second',
      micros_per_unit: 52_000,
      resolution_prices: {
        '480p': { micros_per_unit: 52_000 },
        '720p': { micros_per_unit: 91_000 },
      },
    });
    routeCost.setRouteCost(db, 9102, {
      cost_unit: 'second',
      micros_per_unit: 63_000,
      resolution_prices: {
        '480p': { micros_per_unit: 63_000 },
        '720p': { micros_per_unit: 108_000 },
      },
    });

    const items = canvasCatalog.list(db).filter((item) => item.model.startsWith('shared-'));
    assert.deepEqual(items.map((item) => item.model), ['shared-catalog-video']);
    assert.deepEqual(items[0].resolution_prices, {
      '480p': { credits: 40 },
      '720p': { credits: 70 },
    });
    assert.deepEqual(items[0].capabilities.aspectRatios, ['16:9']);
    assert.deepEqual(items[0].capabilities.durations, [5, 10]);
    assert.deepEqual(items[0].capabilities.resolutions, ['480p', '720p']);
    assert.equal(items[0].capabilities.supportsImageReference, true);

    const serialized = JSON.stringify(items);
    for (const forbidden of [
      'private-relay', 'private_video', 'fixture-credential', 'relay-9101.example',
      'nested-private', 'upstream-9101', 'config_id', 'cost_micros', 'evidence',
    ]) assert.equal(serialized.includes(forbidden), false, forbidden);

    const publicPrice = modelPrice.listPublic(db)
      .find((item) => item.model === 'shared-catalog-video');
    assert.ok(publicPrice);
    assert.equal(JSON.stringify(publicPrice).includes('cost_micros'), false);
    assert.equal(modelPrice.calculateCharge(db, 'shared-catalog-video', {
      resolution: '720p', duration: 5,
    }), 350);

    assert.equal(routeCost.quoteRouteCost(db, {
      configId: 9101, resolution: '720p', duration: 5,
    }).cost_micros, 455_000);
    assert.equal(routeCost.quoteRouteCost(db, {
      configId: 9102, resolution: '720p', duration: 5,
    }).cost_micros, 540_000);
  } finally {
    db.close();
    if (previousMode === undefined) delete process.env.PROVIDER_CANARY_MODE;
    else process.env.PROVIDER_CANARY_MODE = previousMode;
  }
});

test('线路成本变化只使对应线路的巡检证据失效', () => {
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    insertRoute(db, 9201);
    insertRoute(db, 9202);
    routeCost.setRouteCost(db, 9201, { cost_unit: 'second', micros_per_unit: 50_000 });
    routeCost.setRouteCost(db, 9202, { cost_unit: 'second', micros_per_unit: 60_000 });
    insertEvidence(db, 9201);
    insertEvidence(db, 9202);

    routeCost.setRouteCost(db, 9201, { cost_unit: 'second', micros_per_unit: 51_000 });

    assert.deepEqual(
      db.prepare(`SELECT config_id, state, invalidation_reason
        FROM provider_canary_evidence WHERE config_id IN (9201, 9202) ORDER BY config_id`).all(),
      [
        { config_id: 9201, state: 'stale', invalidation_reason: 'cost_changed' },
        { config_id: 9202, state: 'failing', invalidation_reason: null },
      ],
    );
  } finally {
    db.close();
  }
});
