'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiConfigService = require('../src/services/aiConfigService');
const evidenceService = require('../src/services/providerCanaryEvidenceService');
const modelPriceService = require('../src/services/modelPriceService');

const NOW = '2026-08-18T00:00:00.000Z';
const COST_FINGERPRINT = 'cost-v1';
const RUNTIME_FINGERPRINT = 'runtime-v1';
const CAPABILITIES = [
  { resolution: '480p', aspectRatio: '16:9', duration: 5, referenceImageCount: 0 },
  { resolution: '720p', aspectRatio: '16:9', duration: 10, referenceImageCount: 2 },
];

function createDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  return db;
}

function addConfig(db, values) {
  const settings = JSON.stringify({
    canvas_capabilities: {
      resolutions: ['480p', '720p'],
      aspectRatios: ['16:9'],
      durations: [5, 10],
      maxReferences: 2,
    },
    note: 'display-only note',
  });
  return Number(db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
     endpoint, query_endpoint, priority, is_default, is_active, settings, logical_model_id,
     failover_enabled, verification_status, created_at, updated_at)
    VALUES ('video', @provider, 'openai', @name, @base_url, @api_key, @model, @default_model,
      '/videos', '/videos/{taskId}', @priority, 0, 1, @settings, @logical_model_id,
      1, 'verified', @now, @now)`)
    .run({ settings, now: NOW, ...values }).lastInsertRowid);
}

function addFreshEvidence(db, configId, logicalModelId, capability, suffix) {
  const capabilityFingerprint = evidenceService.capabilityFingerprint('video', capability);
  const runId = `run-${configId}-${suffix}`;
  const configFingerprint = `config-${configId}`;
  db.prepare(`INSERT INTO provider_canary_runs
    (id, idempotency_key, config_id, logical_model_id, service_type, capability_fingerprint,
     config_fingerprint, cost_fingerprint, runtime_fingerprint, provider_scope_key, state,
     reserved_cost_micros, actual_cost_micros, currency, budget_day, budget_month,
     created_at, finished_at, updated_at)
    VALUES (?, ?, ?, ?, 'video', ?, ?, ?, ?, ?, 'succeeded', 1, 1, 'CNY',
      '2026-08-18', '2026-08', ?, ?, ?)`)
    .run(
      runId, `idem-${runId}`, configId, logicalModelId, capabilityFingerprint,
      configFingerprint, COST_FINGERPRINT, RUNTIME_FINGERPRINT, `scope-${configId}`,
      NOW, NOW, NOW,
    );
  return evidenceService.recordSuccess(db, {
    configId,
    serviceType: 'video',
    capability,
    runId,
    configFingerprint,
    costFingerprint: COST_FINGERPRINT,
    runtimeFingerprint: RUNTIME_FINGERPRINT,
    now: NOW,
  });
}

function fixture() {
  const db = createDb();
  const configs = {
    a1: addConfig(db, {
      provider: 'relay-a1', name: 'A route 1', base_url: 'https://a1.example/v1',
      api_key: 'secret-a1', model: JSON.stringify(['upstream-a1']), default_model: 'upstream-a1',
      priority: 100, logical_model_id: 'logical-a',
    }),
    a2: addConfig(db, {
      provider: 'relay-a2', name: 'A route 2', base_url: 'https://a2.example/v1',
      api_key: 'secret-a2', model: JSON.stringify(['upstream-a2']), default_model: 'upstream-a2',
      priority: 90, logical_model_id: 'Logical-A',
    }),
    b1: addConfig(db, {
      provider: 'relay-b1', name: 'B route 1', base_url: 'https://b1.example/v1',
      api_key: 'secret-b1', model: JSON.stringify(['upstream-b1']), default_model: 'upstream-b1',
      priority: 80, logical_model_id: 'logical-b',
    }),
    b2: addConfig(db, {
      provider: 'relay-b2', name: 'B route 2', base_url: 'https://b2.example/v1',
      api_key: 'secret-b2', model: JSON.stringify(['upstream-b2']), default_model: 'upstream-b2',
      priority: 70, logical_model_id: 'logical-b',
    }),
  };
  modelPriceService.set(db, 'logical-a', 4, {
    category: 'video',
    status: 'enabled',
    cost_unit: 'second',
    cost_micros_per_unit: 1000,
    resolution_prices: {
      '480p': { credits: 4, cost_micros_per_second: 1000 },
      '720p': { credits: 8, cost_micros_per_second: 2000 },
    },
  });
  modelPriceService.set(db, 'logical-b', 5, {
    category: 'video', status: 'enabled', cost_unit: 'second', cost_micros_per_unit: 1500,
  });
  for (const [name, configId] of Object.entries(configs)) {
    const logicalModelId = aiConfigService.getConfig(db, configId).logical_model_id;
    CAPABILITIES.forEach((capability, index) => {
      addFreshEvidence(db, configId, logicalModelId, capability, index + 1);
    });
  }
  return { db, configs };
}

function evidenceStates(db, configId) {
  return db.prepare(`SELECT state FROM provider_canary_evidence
    WHERE config_id = ? ORDER BY capability_fingerprint`).all(configId).map((row) => row.state);
}

function expectOnlyConfigStale(db, configs, target) {
  for (const [name, configId] of Object.entries(configs)) {
    assert.deepEqual(
      evidenceStates(db, configId),
      [name === target ? 'stale' : 'fresh', name === target ? 'stale' : 'fresh'],
      name,
    );
  }
}

function resetFresh(db) {
  db.prepare(`UPDATE provider_canary_evidence
    SET state = 'fresh', invalidated_at = NULL, invalidation_reason = NULL`).run();
}

test('连接、上游模型、能力和路由字段只精准失效目标线路，展示字段不失效', () => {
  const { db, configs } = fixture();
  const logMessages = [];
  const log = { info(message, fields) { logMessages.push(JSON.stringify({ message, fields })); } };
  try {
    const mutations = [
      { api_key: 'secret-a1-next' },
      { base_url: 'https://a1-next.example/v1' },
      { api_protocol: 'responses' },
      { model: ['upstream-a1-next'] },
      { default_model: 'upstream-a1-next' },
      {
        settings: JSON.stringify({
          canvas_capabilities: {
            resolutions: ['480p', '720p'], aspectRatios: ['16:9'], durations: [5, 10], maxReferences: 1,
          },
          note: 'display-only note',
        }),
      },
      { priority: 101 },
    ];
    for (const mutation of mutations) {
      resetFresh(db);
      try {
        aiConfigService.updateConfig(db, log, configs.a1, mutation);
      } catch (error) {
        error.message = `${JSON.stringify(mutation)}: ${error.message}`;
        throw error;
      }
      expectOnlyConfigStale(db, configs, 'a1');
    }

    resetFresh(db);
    aiConfigService.updateConfig(db, log, configs.a1, { name: 'Display name only' });
    assert.deepEqual(evidenceStates(db, configs.a1), ['fresh', 'fresh']);
    const current = aiConfigService.getConfig(db, configs.a1);
    const settings = JSON.parse(current.settings);
    settings.note = 'changed display note';
    aiConfigService.updateConfig(db, log, configs.a1, { settings: JSON.stringify(settings) });
    assert.deepEqual(evidenceStates(db, configs.a1), ['fresh', 'fresh']);

    settings.canvas_capabilities.resolutions.reverse();
    settings.canvas_capabilities.aspectRatios.reverse();
    settings.canvas_capabilities.durations.reverse();
    aiConfigService.updateConfig(db, log, configs.a1, { settings: JSON.stringify(settings) });
    assert.deepEqual(evidenceStates(db, configs.a1), ['fresh', 'fresh']);

    assert.equal(logMessages.some((line) => line.includes('secret-a1-next')), false);
  } finally {
    db.close();
  }
});

test('逻辑模型价格、分辨率成本和价格状态实质变化失效全部同模型线路', () => {
  const { db, configs } = fixture();
  try {
    const assertLogicalAInvalidated = () => {
      assert.deepEqual(evidenceStates(db, configs.a1), ['stale', 'stale']);
      assert.deepEqual(evidenceStates(db, configs.a2), ['stale', 'stale']);
      assert.deepEqual(evidenceStates(db, configs.b1), ['fresh', 'fresh']);
      assert.deepEqual(evidenceStates(db, configs.b2), ['fresh', 'fresh']);
    };

    modelPriceService.set(db, 'logical-a', 6, {});
    assertLogicalAInvalidated();

    resetFresh(db);
    modelPriceService.set(db, 'logical-a', 6, {
      resolution_prices: {
        '480p': { credits: 6, cost_micros_per_second: 1100 },
        '720p': { credits: 8, cost_micros_per_second: 2100 },
      },
    });
    assertLogicalAInvalidated();

    resetFresh(db);
    modelPriceService.set(db, 'logical-a', 6, { status: 'disabled' });
    assertLogicalAInvalidated();

    resetFresh(db);
    modelPriceService.set(db, 'logical-a', 6, { display_name: 'Display only' });
    assert.deepEqual(evidenceStates(db, configs.a1), ['fresh', 'fresh']);
    assert.deepEqual(evidenceStates(db, configs.a2), ['fresh', 'fresh']);
  } finally {
    db.close();
  }
});

test('相同成本快照重放不失效证据', () => {
  const { db, configs } = fixture();
  try {
    modelPriceService.set(db, 'logical-a', 4, {
      category: 'video',
      status: 'enabled',
      cost_unit: 'second',
      cost_micros_per_unit: 1000,
      resolution_prices: {
        '720P': { credits: 8, cost_micros_per_second: 2000 },
        '480P': { credits: 4, cost_micros_per_second: 1000 },
      },
    });
    assert.deepEqual(evidenceStates(db, configs.a1), ['fresh', 'fresh']);
    assert.deepEqual(evidenceStates(db, configs.a2), ['fresh', 'fresh']);
  } finally {
    db.close();
  }
});

test('管理员暂停立即 disabled，恢复只能 never_verified 而不能恢复 fresh', () => {
  const { db, configs } = fixture();
  try {
    const paused = aiConfigService.updateConfig(db, { info() {} }, configs.a1, { canary_paused: true });
    assert.equal(paused.canary_paused, true);
    assert.deepEqual(evidenceStates(db, configs.a1), ['disabled', 'disabled']);

    const resumed = aiConfigService.updateConfig(db, { info() {} }, configs.a1, { canary_paused: false });
    assert.equal(resumed.canary_paused, false);
    assert.deepEqual(evidenceStates(db, configs.a1), ['never_verified', 'never_verified']);
    assert.deepEqual(evidenceStates(db, configs.a2), ['fresh', 'fresh']);
  } finally {
    db.close();
  }
});

test('运行代码指纹变化在数据库未改时动态判为 stale', () => {
  const { db, configs } = fixture();
  try {
    const row = db.prepare(`SELECT * FROM provider_canary_evidence
      WHERE config_id = ? LIMIT 1`).get(configs.a1);
    assert.equal(evidenceService.effectiveEvidenceState(row, {
      now: '2026-08-18T01:00:00.000Z',
      configFingerprint: `config-${configs.a1}`,
      costFingerprint: COST_FINGERPRINT,
      runtimeFingerprint: RUNTIME_FINGERPRINT,
    }), 'fresh');
    assert.equal(evidenceService.effectiveEvidenceState(row, {
      now: '2026-08-18T01:00:00.000Z',
      configFingerprint: `config-${configs.a1}`,
      costFingerprint: COST_FINGERPRINT,
      runtimeFingerprint: 'runtime-v2',
    }), 'stale');
    assert.equal(db.prepare(`SELECT state FROM provider_canary_evidence
      WHERE config_id = ? LIMIT 1`).get(configs.a1).state, 'fresh');
  } finally {
    db.close();
  }
});

test('旧 verification_status=verified 不能替代新的 fresh 可读产物证据', () => {
  const db = createDb();
  try {
    const configId = addConfig(db, {
      provider: 'legacy-relay', name: 'Legacy verified', base_url: 'https://legacy.example/v1',
      api_key: 'legacy-secret', model: JSON.stringify(['legacy-upstream']),
      default_model: 'legacy-upstream', priority: 1, logical_model_id: 'legacy-logical',
    });
    assert.equal(aiConfigService.getConfig(db, configId).verification_status, 'verified');
    assert.deepEqual(evidenceService.listFreshCoveringEvidence(db, {
      serviceType: 'video',
      logicalModelId: 'legacy-logical',
      capability: CAPABILITIES[0],
      now: '2026-08-18T01:00:00.000Z',
      fingerprints: {
        [configId]: {
          configFingerprint: `config-${configId}`,
          costFingerprint: COST_FINGERPRINT,
          runtimeFingerprint: RUNTIME_FINGERPRINT,
        },
      },
    }), []);
  } finally {
    db.close();
  }
});

test('旧库缺少巡检迁移表时安全跳过，但普通失效错误回滚配置和价格', () => {
  const legacy = new Database(':memory:');
  legacy.exec(`CREATE TABLE ai_service_configs (
    id INTEGER PRIMARY KEY, service_type TEXT, provider TEXT, api_protocol TEXT, name TEXT,
    base_url TEXT, api_key TEXT, model TEXT, default_model TEXT, endpoint TEXT, query_endpoint TEXT,
    priority INTEGER, is_default INTEGER, is_active INTEGER, settings TEXT, logical_model_id TEXT,
    failover_enabled INTEGER, verification_status TEXT, verification_checked_at TEXT,
    verified_at TEXT, verification_error TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT
  )`);
  legacy.prepare(`INSERT INTO ai_service_configs VALUES
    (1, 'image', 'relay', 'openai', 'Legacy', 'https://legacy.example/v1', 'secret', ?,
     'upstream', '', '', 1, 0, 1, '{}', 'logical-legacy', 1, 'verified', NULL, ?, NULL, ?, ?, NULL)`)
    .run(JSON.stringify(['upstream']), NOW, NOW, NOW);
  assert.equal(aiConfigService.updateConfig(legacy, { info() {} }, 1, { priority: 2 }).priority, 2);
  assert.equal(modelPriceService.set(legacy, 'logical-legacy', 9).credits, 9);
  legacy.close();

  const broken = createDb();
  try {
    const configId = addConfig(broken, {
      provider: 'broken-relay', name: 'Broken', base_url: 'https://broken.example/v1',
      api_key: 'broken-secret', model: JSON.stringify(['broken-upstream']),
      default_model: 'broken-upstream', priority: 1, logical_model_id: 'broken-logical',
    });
    modelPriceService.set(broken, 'broken-logical', 3, { category: 'video' });
    broken.exec(`CREATE TRIGGER reject_canary_invalidation
      BEFORE UPDATE ON provider_canary_evidence BEGIN SELECT RAISE(ABORT, 'canary write rejected'); END;`);
    addFreshEvidence(broken, configId, 'broken-logical', CAPABILITIES[0], 'broken');

    assert.throws(
      () => aiConfigService.updateConfig(broken, { info() {} }, configId, { priority: 2 }),
      /canary write rejected/,
    );
    assert.equal(aiConfigService.getConfig(broken, configId).priority, 1);
    assert.throws(
      () => modelPriceService.set(broken, 'broken-logical', 4),
      /canary write rejected/,
    );
    assert.equal(modelPriceService.requirePrice(broken, 'broken-logical'), 3);
  } finally {
    broken.close();
  }
});
