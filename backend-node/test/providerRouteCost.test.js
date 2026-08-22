'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const routeCost = require('../src/services/providerRouteCostService');

const NOW = '2026-08-20T00:00:00.000Z';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrationsAndEnsure(db);
  return db;
}

function insertConfig(db, id, overrides = {}) {
  const row = {
    id,
    service_type: 'image',
    provider: `relay-${id}`,
    name: `Route ${id}`,
    base_url: `https://relay-${id}.invalid/v1`,
    api_key: `test-key-${id}`,
    model: 'upstream-image-model',
    default_model: 'upstream-image-model',
    logical_model_id: 'shared-image-model',
    is_active: 1,
    ...overrides,
  };
  db.prepare(`INSERT INTO ai_service_configs
      (id, service_type, provider, name, base_url, api_key, model, default_model,
       logical_model_id, is_active)
    VALUES (@id, @service_type, @provider, @name, @base_url, @api_key, @model,
      @default_model, @logical_model_id, @is_active)`).run(row);
}

function insertEvidence(db, configId, state = 'failing') {
  db.prepare(`INSERT INTO provider_canary_evidence
      (config_id, service_type, capability_fingerprint, capability_json, state,
       config_fingerprint, cost_fingerprint, runtime_fingerprint, created_at, updated_at)
    VALUES (?, 'image', ?, ?, ?, 'config-fp', 'cost-fp', 'runtime-fp', ?, ?)`)
    .run(configId, `capability-${configId}`, JSON.stringify({ serviceType: 'image' }), state, NOW, NOW);
}

test('线路成本规范化可在写事务前复用且不访问数据库', () => {
  const normalized = routeCost.normalizeRouteCostInput(16, {
    currency: 'cny',
    cost_unit: 'second',
    micros_per_unit: 280000,
    resolution_prices: {
      '720P': { micros_per_unit: 560000 },
      '480p': { micros_per_unit: 280000 },
    },
  });
  assert.deepEqual(normalized, {
    schema_version: 1,
    config_id: 16,
    currency: 'CNY',
    cost_unit: 'second',
    micros_per_unit: 280000,
    input_cost_micros_per_1k: 0,
    output_cost_micros_per_1k: 0,
    resolution_prices: {
      '480p': { micros_per_unit: 280000 },
      '720p': { micros_per_unit: 560000 },
    },
  });
  assert.throws(() => routeCost.normalizeRouteCostInput(16, {
    currency: 'CNY',
    cost_unit: 'second',
    micros_per_unit: 0,
  }), { code: 'INVALID_PROVIDER_ROUTE_COST' });
});

test('same logical model keeps independent supplier cost per config id', () => {
  const db = makeDb();
  try {
    insertConfig(db, 25);
    insertConfig(db, 26);

    routeCost.setRouteCost(db, 25, {
      currency: 'CNY',
      cost_unit: 'image',
      micros_per_unit: 46_000,
    }, { now: NOW });
    routeCost.setRouteCost(db, 26, {
      currency: 'CNY',
      cost_unit: 'image',
      micros_per_unit: 100_000,
    }, { now: NOW });

    assert.equal(routeCost.quoteRouteCost(db, { configId: 25, count: 1 }).cost_micros, 46_000);
    assert.equal(routeCost.quoteRouteCost(db, { configId: 26, count: 1 }).cost_micros, 100_000);
    assert.equal(routeCost.getRouteCost(db, 25).config_id, 25);
    assert.equal(routeCost.getRouteCost(db, 26).config_id, 26);
  } finally {
    db.close();
  }
});

test('request image second and token units quote exact usage without duration inflation', () => {
  const db = makeDb();
  try {
    insertConfig(db, 1, { service_type: 'video' });
    insertConfig(db, 2);
    insertConfig(db, 3, { service_type: 'video' });
    insertConfig(db, 4, { service_type: 'text' });

    routeCost.setRouteCost(db, 1, { cost_unit: 'request', micros_per_unit: 2_800_000 }, { now: NOW });
    routeCost.setRouteCost(db, 2, { cost_unit: 'image', micros_per_unit: 46_000 }, { now: NOW });
    routeCost.setRouteCost(db, 3, { cost_unit: 'second', micros_per_unit: 80_000 }, { now: NOW });
    routeCost.setRouteCost(db, 4, {
      cost_unit: 'token',
      input_cost_micros_per_1k: 2_000,
      output_cost_micros_per_1k: 4_000,
    }, { now: NOW });

    const requestQuote = routeCost.quoteRouteCost(db, { configId: 1, duration: 15, count: 1 });
    assert.deepEqual(
      {
        config_id: requestQuote.config_id,
        cost_unit: requestQuote.cost_unit,
        quantity: requestQuote.quantity,
        cost_micros: requestQuote.cost_micros,
      },
      { config_id: 1, cost_unit: 'request', quantity: 1, cost_micros: 2_800_000 },
    );
    assert.equal(routeCost.quoteRouteCost(db, { configId: 2, count: 3 }).cost_micros, 138_000);
    assert.equal(routeCost.quoteRouteCost(db, { configId: 3, duration: 15, count: 2 }).cost_micros, 2_400_000);
    const tokenQuote = routeCost.quoteRouteCost(db, {
        configId: 4,
        inputTokens: 1_500,
        outputTokens: 500,
        reasoningTokens: 300,
      });
    assert.deepEqual(
      {
        config_id: tokenQuote.config_id,
        cost_unit: tokenQuote.cost_unit,
        quantity: tokenQuote.quantity,
        cost_micros: tokenQuote.cost_micros,
        input_tokens: tokenQuote.input_tokens,
        output_tokens: tokenQuote.output_tokens,
        reasoning_tokens: tokenQuote.reasoning_tokens,
      },
      {
        config_id: 4,
        cost_unit: 'token',
        quantity: 1,
        cost_micros: 5_000,
        input_tokens: 1_500,
        output_tokens: 500,
        reasoning_tokens: 300,
      },
    );
  } finally {
    db.close();
  }
});

test('resolution tiers are config scoped and missing requested tiers fail closed', () => {
  const db = makeDb();
  try {
    insertConfig(db, 7, { service_type: 'video' });
    routeCost.setRouteCost(db, 7, {
      cost_unit: 'second',
      micros_per_unit: 60_000,
      resolution_prices: {
        '480p': { micros_per_unit: 60_000 },
        '720P': { micros_per_unit: 90_000 },
      },
    }, { now: NOW });

    assert.equal(routeCost.quoteRouteCost(db, {
      configId: 7,
      resolution: '720p',
      duration: 5,
    }).cost_micros, 450_000);
    assert.equal(routeCost.routeCostCoversCapability(db, 7, {
      serviceType: 'video',
      resolution: '720P',
      duration: 15,
      count: 1,
    }), true);
    assert.equal(routeCost.routeCostCoversCapability(db, 7, {
      serviceType: 'video',
      resolution: '2K',
      duration: 15,
      count: 1,
    }), false);
    assert.throws(
      () => routeCost.quoteRouteCost(db, { configId: 7, resolution: '2k', duration: 5 }),
      (error) => error.code === 'PROVIDER_ROUTE_COST_TIER_MISSING',
    );
  } finally {
    db.close();
  }
});

test('route cost validation rejects absent configs unsafe values and unusable zero cost', () => {
  const db = makeDb();
  try {
    insertConfig(db, 9);
    const invalidPayloads = [
      { cost_unit: 'unknown', micros_per_unit: 1 },
      { cost_unit: 'image', micros_per_unit: 0 },
      { cost_unit: 'image', micros_per_unit: -1 },
      { cost_unit: 'image', micros_per_unit: Number.MAX_SAFE_INTEGER + 1 },
      { cost_unit: 'token', input_cost_micros_per_1k: 0, output_cost_micros_per_1k: 0 },
      { cost_unit: 'second', micros_per_unit: 1, resolution_prices: { '720p': { micros_per_unit: 0 } } },
    ];
    for (const payload of invalidPayloads) {
      assert.throws(
        () => routeCost.setRouteCost(db, 9, payload, { now: NOW }),
        (error) => error.code === 'INVALID_PROVIDER_ROUTE_COST',
      );
    }
    assert.throws(
      () => routeCost.setRouteCost(db, 999, { cost_unit: 'image', micros_per_unit: 1 }, { now: NOW }),
      (error) => error.code === 'PROVIDER_ROUTE_NOT_FOUND',
    );
    assert.throws(
      () => routeCost.quoteRouteCost(db, { configId: 9, count: 1 }),
      (error) => error.code === 'PROVIDER_ROUTE_COST_NOT_CONFIGURED',
    );
  } finally {
    db.close();
  }
});

test('cost snapshots and fingerprints are stable and contain no connection identity', () => {
  const db = makeDb();
  try {
    insertConfig(db, 12);
    routeCost.setRouteCost(db, 12, {
      cost_unit: 'image',
      micros_per_unit: 46_000,
    }, { now: NOW });
    const first = routeCost.quoteRouteCost(db, { configId: 12, count: 2 });
    const second = routeCost.quoteRouteCost(db, { configId: 12, count: 2 });

    assert.equal(first.cost_fingerprint, second.cost_fingerprint);
    assert.match(first.cost_fingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(first.cost_snapshot, {
      schema_version: 1,
      config_id: 12,
      currency: 'CNY',
      cost_unit: 'image',
      micros_per_unit: 46_000,
      input_cost_micros_per_1k: 0,
      output_cost_micros_per_1k: 0,
      resolution_prices: {},
    });
    const serialized = JSON.stringify(first);
    for (const forbidden of ['test-key-12', 'relay-12.invalid', 'relay-12', 'upstream-image-model']) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally {
    db.close();
  }
});

test('changing one route cost invalidates only evidence for that config', () => {
  const db = makeDb();
  try {
    insertConfig(db, 20);
    insertConfig(db, 21);
    routeCost.setRouteCost(db, 20, { cost_unit: 'image', micros_per_unit: 40_000 }, { now: NOW });
    routeCost.setRouteCost(db, 21, { cost_unit: 'image', micros_per_unit: 60_000 }, { now: NOW });
    insertEvidence(db, 20);
    insertEvidence(db, 21);

    routeCost.setRouteCost(db, 20, { cost_unit: 'image', micros_per_unit: 41_000 }, {
      now: '2026-08-20T01:00:00.000Z',
    });

    const rows = db.prepare(`SELECT config_id, state, invalidation_reason
      FROM provider_canary_evidence ORDER BY config_id`).all();
    assert.deepEqual(rows, [
      { config_id: 20, state: 'stale', invalidation_reason: 'cost_changed' },
      { config_id: 21, state: 'failing', invalidation_reason: null },
    ]);
  } finally {
    db.close();
  }
});

test('configuring a previously missing route cost invalidates pre-existing evidence', () => {
  const db = makeDb();
  try {
    insertConfig(db, 30);
    insertConfig(db, 31);
    insertEvidence(db, 30);
    insertEvidence(db, 31);

    routeCost.setRouteCost(db, 30, { cost_unit: 'image', micros_per_unit: 45_000 }, { now: NOW });

    const rows = db.prepare(`SELECT config_id, state, invalidation_reason
      FROM provider_canary_evidence ORDER BY config_id`).all();
    assert.deepEqual(rows, [
      { config_id: 30, state: 'stale', invalidation_reason: 'cost_changed' },
      { config_id: 31, state: 'failing', invalidation_reason: null },
    ]);
  } finally {
    db.close();
  }
});
