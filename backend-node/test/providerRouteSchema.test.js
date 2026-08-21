const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function indexNames(db, table) {
  return new Set(db.prepare(`PRAGMA index_list(${table})`).all().map((row) => row.name));
}

function hasTable(db, table) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.[1] === 1;
}

function enableForeignKeys(db) {
  db.pragma('foreign_keys = ON');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
}

function insertProviderConfig(db, id, overrides = {}) {
  const config = {
    id,
    service_type: 'image',
    provider: `provider-${id}`,
    name: `Provider ${id}`,
    ...overrides,
  };
  return db.prepare(`INSERT INTO ai_service_configs (id, service_type, provider, name)
    VALUES (@id, @service_type, @provider, @name)`).run(config);
}

function insertCanaryRun(db, overrides = {}) {
  const run = {
    id: 'canary-run-1',
    idempotency_key: 'canary-idempotency-1',
    config_id: 1,
    logical_model_id: 'logical-image-1',
    service_type: 'image',
    capability_fingerprint: 'capability-1',
    config_fingerprint: 'config-1',
    cost_fingerprint: 'cost-1',
    runtime_fingerprint: 'runtime-1',
    provider_scope_key: 'provider-scope-1',
    state: 'reserved',
    reserved_cost_micros: 0,
    actual_cost_micros: null,
    currency: 'CNY',
    budget_day: '2026-08-18',
    budget_month: '2026-08',
    artifact_bytes: null,
    created_at: '2026-08-18T00:00:00.000Z',
    updated_at: '2026-08-18T00:00:00.000Z',
    ...overrides,
  };
  return db.prepare(`INSERT INTO provider_canary_runs
    (id, idempotency_key, config_id, logical_model_id, service_type,
     capability_fingerprint, config_fingerprint, cost_fingerprint,
     runtime_fingerprint, provider_scope_key, state, reserved_cost_micros,
     actual_cost_micros, currency, budget_day, budget_month, artifact_bytes,
     created_at, updated_at)
    VALUES (@id, @idempotency_key, @config_id, @logical_model_id, @service_type,
     @capability_fingerprint, @config_fingerprint, @cost_fingerprint,
     @runtime_fingerprint, @provider_scope_key, @state, @reserved_cost_micros,
     @actual_cost_micros, @currency, @budget_day, @budget_month, @artifact_bytes,
     @created_at, @updated_at)`).run(run);
}

function insertCanaryEvidence(db, overrides = {}) {
  const evidence = {
    config_id: 1,
    service_type: 'image',
    capability_fingerprint: 'capability-1',
    capability_json: JSON.stringify({ serviceType: 'image' }),
    state: 'never_verified',
    run_id: null,
    config_fingerprint: 'config-1',
    cost_fingerprint: 'cost-1',
    runtime_fingerprint: 'runtime-1',
    verified_at: null,
    expires_at: null,
    invalidated_at: null,
    invalidation_reason: null,
    created_at: '2026-08-18T00:00:00.000Z',
    updated_at: '2026-08-18T00:00:00.000Z',
    ...overrides,
  };
  return db.prepare(`INSERT INTO provider_canary_evidence
    (config_id, service_type, capability_fingerprint, capability_json, state, run_id,
     config_fingerprint, cost_fingerprint, runtime_fingerprint, verified_at,
     expires_at, invalidated_at, invalidation_reason, created_at, updated_at)
    VALUES (@config_id, @service_type, @capability_fingerprint, @capability_json, @state, @run_id,
     @config_fingerprint, @cost_fingerprint, @runtime_fingerprint, @verified_at,
     @expires_at, @invalidated_at, @invalidation_reason, @created_at, @updated_at)`).run(evidence);
}

function insertZeroCostCheck(db, overrides = {}) {
  const check = {
    config_id: 1,
    state: 'healthy',
    category: null,
    safe_summary: null,
    checked_at: '2026-08-18T00:00:00.000Z',
    updated_at: '2026-08-18T00:00:00.000Z',
    ...overrides,
  };
  return db.prepare(`INSERT INTO provider_zero_cost_checks
    (config_id, state, category, safe_summary, checked_at, updated_at)
    VALUES (@config_id, @state, @category, @safe_summary, @checked_at, @updated_at)`).run(check);
}

test('provider stability migration creates the routing schema and remains idempotent', () => {
  const db = new Database(':memory:');
  try {
    enableForeignKeys(db);
    runMigrationsAndEnsure(db);
    runMigrationsAndEnsure(db);

    const configColumns = columnNames(db, 'ai_service_configs');
    for (const name of [
      'logical_model_id',
      'failover_enabled',
      'verification_status',
      'verified_at',
      'verification_evidence',
      'canary_paused',
    ]) {
      assert.equal(configColumns.has(name), true, `missing ai_service_configs.${name}`);
    }
    assert.equal(columnNames(db, 'video_generations').has('config_id'), true);

    for (const table of [
      'generation_route_requests',
      'generation_route_attempts',
      'provider_route_health',
      'provider_stability_events',
      'provider_canary_runs',
      'provider_canary_evidence',
      'provider_zero_cost_checks',
      'provider_route_costs',
      'provider_route_resolution_costs',
    ]) {
      assert.equal(hasTable(db, table), true, `missing table ${table}`);
    }
    for (const name of [
      'config_id',
      'currency',
      'cost_unit',
      'micros_per_unit',
      'input_cost_micros_per_1k',
      'output_cost_micros_per_1k',
      'updated_at',
    ]) {
      assert.equal(columnNames(db, 'provider_route_costs').has(name), true,
        `missing provider_route_costs.${name}`);
    }
    for (const name of ['config_id', 'resolution', 'micros_per_unit', 'updated_at']) {
      assert.equal(columnNames(db, 'provider_route_resolution_costs').has(name), true,
        `missing provider_route_resolution_costs.${name}`);
    }
    const capabilityJsonColumn = db.prepare('PRAGMA table_info(provider_canary_evidence)').all()
      .find((column) => column.name === 'capability_json');
    assert.equal(capabilityJsonColumn.type, 'TEXT');
    assert.equal(capabilityJsonColumn.notnull, 1);

    assert.equal(
      indexNames(db, 'generation_route_requests').has('idx_generation_route_requests_state'),
      true,
    );
    assert.equal(
      indexNames(db, 'generation_route_attempts').has('idx_generation_route_attempts_provider_task'),
      true,
    );
    assert.equal(
      indexNames(db, 'provider_stability_events').has('idx_provider_stability_events_created'),
      true,
    );
    for (const name of [
      'idx_provider_canary_runs_budget_day',
      'idx_provider_canary_runs_budget_month',
      'idx_provider_canary_runs_config_state',
    ]) {
      assert.equal(indexNames(db, 'provider_canary_runs').has(name), true, `missing index ${name}`);
    }
    for (const name of [
      'idx_provider_canary_evidence_expiry',
      'idx_provider_canary_evidence_state',
    ]) {
      assert.equal(indexNames(db, 'provider_canary_evidence').has(name), true, `missing index ${name}`);
    }
    assert.equal(
      indexNames(db, 'provider_route_resolution_costs').has('idx_provider_route_resolution_costs_config'),
      true,
    );
  } finally {
    db.close();
  }
});

test('provider stability schema rejects duplicate idempotency keys and attempt numbers', () => {
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    const request = {
      id: 'route-request-1',
      idempotency_key: 'idempotency-1',
      service_type: 'image',
      business_type: 'image_generation',
      logical_model_id: 'logical-image-1',
      capability_fingerprint: '{}',
      candidate_config_ids: '[1,2]',
      state: 'created',
      created_at: '2026-08-15T00:00:00.000Z',
      updated_at: '2026-08-15T00:00:00.000Z',
    };
    const insertRequest = db.prepare(`INSERT INTO generation_route_requests
      (id, idempotency_key, service_type, business_type, logical_model_id,
       capability_fingerprint, candidate_config_ids, state, created_at, updated_at)
      VALUES (@id, @idempotency_key, @service_type, @business_type, @logical_model_id,
       @capability_fingerprint, @candidate_config_ids, @state, @created_at, @updated_at)`);
    insertRequest.run(request);
    assert.throws(
      () => insertRequest.run({ ...request, id: 'route-request-2' }),
      /UNIQUE constraint failed: generation_route_requests\.idempotency_key/,
    );

    const attempt = {
      request_id: request.id,
      attempt_no: 1,
      config_id: 1,
      provider: 'relay-a',
      upstream_model: 'image-model',
      state: 'submitting',
      started_at: request.created_at,
    };
    const insertAttempt = db.prepare(`INSERT INTO generation_route_attempts
      (request_id, attempt_no, config_id, provider, upstream_model, state, started_at)
      VALUES (@request_id, @attempt_no, @config_id, @provider, @upstream_model, @state, @started_at)`);
    insertAttempt.run(attempt);
    assert.throws(
      () => insertAttempt.run(attempt),
      /UNIQUE constraint failed: generation_route_attempts\.request_id, generation_route_attempts\.attempt_no/,
    );
  } finally {
    db.close();
  }
});

test('canary migration preserves existing provider configs and defaults pause to zero', () => {
  const db = new Database(':memory:');
  try {
    enableForeignKeys(db);
    db.exec(`CREATE TABLE ai_service_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_type TEXT NOT NULL,
      provider TEXT DEFAULT '',
      name TEXT DEFAULT '',
      base_url TEXT DEFAULT '',
      api_key TEXT,
      model TEXT,
      default_model TEXT,
      endpoint TEXT,
      query_endpoint TEXT,
      priority INTEGER DEFAULT 0,
      is_default INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      settings TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    )`);
    db.prepare(`INSERT INTO ai_service_configs
      (id, service_type, provider, name, base_url, model, is_active)
      VALUES (77, 'image', 'existing-provider', 'Existing route', 'https://provider.invalid', 'image-v1', 1)`).run();

    runMigrationsAndEnsure(db);

    const column = db.prepare('PRAGMA table_info(ai_service_configs)').all()
      .find((item) => item.name === 'canary_paused');
    assert.equal(column.notnull, 1);
    assert.equal(column.dflt_value, '0');
    assert.deepEqual(
      db.prepare(`SELECT id, service_type, provider, name, base_url, model, is_active, canary_paused
        FROM ai_service_configs WHERE id = 77`).get(),
      {
        id: 77,
        service_type: 'image',
        provider: 'existing-provider',
        name: 'Existing route',
        base_url: 'https://provider.invalid',
        model: 'image-v1',
        is_active: 1,
        canary_paused: 0,
      },
    );
    assert.deepEqual(
      db.prepare(`SELECT name, type FROM sqlite_master
        WHERE name LIKE 'provider_canary_%' AND type NOT IN ('table', 'index')`).all(),
      [],
    );
    assert.throws(
      () => db.prepare('UPDATE ai_service_configs SET canary_paused = 7 WHERE id = 77').run(),
      /CHECK constraint failed/,
    );
  } finally {
    db.close();
  }
});

test('canary schema rejects duplicate run and evidence identities', () => {
  const db = new Database(':memory:');
  try {
    enableForeignKeys(db);
    runMigrationsAndEnsure(db);
    insertProviderConfig(db, 1);
    insertCanaryRun(db);
    assert.throws(
      () => insertCanaryRun(db, { id: 'canary-run-2' }),
      /UNIQUE constraint failed: provider_canary_runs\.idempotency_key/,
    );

    insertCanaryEvidence(db);
    assert.throws(
      () => insertCanaryEvidence(db, { state: 'stale' }),
      /UNIQUE constraint failed: provider_canary_evidence\.config_id, provider_canary_evidence\.capability_fingerprint/,
    );
  } finally {
    db.close();
  }
});

test('canary runs reject invalid costs, currency, and budget bucket formats', () => {
  const db = new Database(':memory:');
  try {
    enableForeignKeys(db);
    runMigrationsAndEnsure(db);
    insertProviderConfig(db, 1);
    for (const [suffix, overrides] of [
      ['reserved-cost', { reserved_cost_micros: -1 }],
      ['actual-cost', { actual_cost_micros: -1 }],
      ['artifact-bytes', { artifact_bytes: -1 }],
      ['currency', { currency: 'USD' }],
      ['budget-day', { budget_day: 'not-a-date' }],
      ['budget-day-digits', { budget_day: '202A-08-18' }],
      ['budget-month', { budget_month: 'not-a-month' }],
      ['budget-month-digits', { budget_month: '2026-AA' }],
    ]) {
      assert.throws(
        () => insertCanaryRun(db, {
          id: `canary-run-${suffix}`,
          idempotency_key: `canary-idempotency-${suffix}`,
          ...overrides,
        }),
        /CHECK constraint failed/,
      );
    }
    insertCanaryRun(db, {
      id: 'canary-run-valid-boundaries',
      idempotency_key: 'canary-idempotency-valid-boundaries',
      actual_cost_micros: 0,
      artifact_bytes: 0,
      budget_day: '2026-08-19',
      budget_month: '2026-08',
    });
  } finally {
    db.close();
  }
});

test('canary tables accept every legal state and reject illegal states', () => {
  const db = new Database(':memory:');
  try {
    enableForeignKeys(db);
    runMigrationsAndEnsure(db);
    insertProviderConfig(db, 1);

    const runStates = [
      'reserved',
      'submitting',
      'accepted',
      'verifying',
      'succeeded',
      'failed',
      'submission_unknown',
      'result_unknown',
      'artifact_unreadable',
      'budget_blocked',
    ];
    runStates.forEach((state, index) => insertCanaryRun(db, {
      id: `canary-state-run-${index}`,
      idempotency_key: `canary-state-idempotency-${index}`,
      state,
    }));
    assert.throws(
      () => insertCanaryRun(db, {
        id: 'canary-state-run-invalid',
        idempotency_key: 'canary-state-idempotency-invalid',
        state: 'unknown',
      }),
      /CHECK constraint failed/,
    );

    const evidenceStates = [
      'never_verified',
      'fresh',
      'stale',
      'failing',
      'submission_unknown',
      'budget_blocked',
      'disabled',
    ];
    evidenceStates.forEach((state, index) => {
      const configId = index + 20;
      const capabilityFingerprint = `evidence-capability-${index}`;
      insertProviderConfig(db, configId);
      const overrides = {
        config_id: configId,
        capability_fingerprint: capabilityFingerprint,
        state,
      };
      if (state === 'fresh') {
        const runId = `fresh-evidence-run-${index}`;
        insertCanaryRun(db, {
          id: runId,
          idempotency_key: `fresh-evidence-idempotency-${index}`,
          config_id: configId,
          capability_fingerprint: capabilityFingerprint,
          state: 'succeeded',
        });
        Object.assign(overrides, {
          run_id: runId,
          verified_at: '2026-08-18T00:00:00.000Z',
          expires_at: '2026-08-19T00:00:00.000Z',
        });
      }
      insertCanaryEvidence(db, overrides);
    });
    insertProviderConfig(db, 100);
    assert.throws(
      () => insertCanaryEvidence(db, {
        config_id: 100,
        capability_fingerprint: 'evidence-capability-invalid',
        state: 'unknown',
      }),
      /CHECK constraint failed/,
    );

    const zeroCostStates = ['healthy', 'degraded', 'failed', 'disabled'];
    zeroCostStates.forEach((state, index) => {
      const configId = index + 40;
      insertProviderConfig(db, configId);
      insertZeroCostCheck(db, { config_id: configId, state });
    });
    assert.throws(
      () => insertZeroCostCheck(db, { config_id: 100, state: 'unknown' }),
      /CHECK constraint failed/,
    );
  } finally {
    db.close();
  }
});

test('fresh canary evidence requires a matching run and an increasing verification window', () => {
  const db = new Database(':memory:');
  try {
    enableForeignKeys(db);
    runMigrationsAndEnsure(db);
    insertProviderConfig(db, 1);
    insertCanaryRun(db, { state: 'succeeded' });

    const validFresh = {
      state: 'fresh',
      run_id: 'canary-run-1',
      verified_at: '2026-08-18T00:00:00.000Z',
      expires_at: '2026-08-19T00:00:00.000Z',
    };
    for (const overrides of [
      { ...validFresh, run_id: null },
      { ...validFresh, verified_at: null },
      { ...validFresh, expires_at: null },
      { ...validFresh, expires_at: validFresh.verified_at },
      { ...validFresh, expires_at: '2026-08-17T00:00:00.000Z' },
    ]) {
      assert.throws(() => insertCanaryEvidence(db, overrides), /CHECK constraint failed/);
    }

    insertCanaryEvidence(db, validFresh);
    assert.throws(
      () => db.prepare(`UPDATE provider_canary_evidence
        SET expires_at = verified_at WHERE config_id = 1 AND capability_fingerprint = 'capability-1'`).run(),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => db.prepare(`UPDATE provider_canary_evidence
        SET run_id = NULL WHERE config_id = 1 AND capability_fingerprint = 'capability-1'`).run(),
      /CHECK constraint failed/,
    );

    insertCanaryEvidence(db, {
      config_id: 1,
      capability_fingerprint: 'capability-without-verification',
      state: 'stale',
    });
  } finally {
    db.close();
  }
});

test('canary foreign keys reject orphans and cascade only canary records', () => {
  const db = new Database(':memory:');
  try {
    enableForeignKeys(db);
    runMigrationsAndEnsure(db);

    assert.throws(
      () => insertCanaryRun(db, { config_id: 999 }),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => insertCanaryEvidence(db, { config_id: 999 }),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => insertZeroCostCheck(db, { config_id: 999 }),
      /FOREIGN KEY constraint failed/,
    );

    insertProviderConfig(db, 1, { provider: 'deletable-provider', name: 'Deletable provider' });
    insertProviderConfig(db, 2, { provider: 'preserved-provider', name: 'Preserved provider' });
    const freshEvidence = {
      state: 'fresh',
      run_id: 'canary-run-1',
      verified_at: '2026-08-18T00:00:00.000Z',
      expires_at: '2026-08-19T00:00:00.000Z',
    };
    assert.throws(
      () => insertCanaryEvidence(db, freshEvidence),
      /FOREIGN KEY constraint failed/,
    );

    insertCanaryRun(db, { state: 'succeeded' });
    assert.throws(
      () => insertCanaryEvidence(db, { ...freshEvidence, config_id: 2 }),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => insertCanaryEvidence(db, {
        ...freshEvidence,
        capability_fingerprint: 'different-capability',
      }),
      /FOREIGN KEY constraint failed/,
    );

    insertCanaryEvidence(db, freshEvidence);
    insertZeroCostCheck(db);
    db.prepare(`INSERT INTO generation_route_requests
      (id, idempotency_key, service_type, business_type, logical_model_id,
       capability_fingerprint, candidate_config_ids, state, final_config_id, created_at, updated_at)
      VALUES ('preserved-route', 'preserved-route-key', 'image', 'image_generation',
       'logical-image-1', 'capability-1', '[1]', 'succeeded', 1,
       '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z')`).run();

    db.prepare('DELETE FROM ai_service_configs WHERE id = 1').run();
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM provider_canary_runs WHERE config_id = 1').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM provider_canary_evidence WHERE config_id = 1').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM provider_zero_cost_checks WHERE config_id = 1').get().count, 0);
    assert.deepEqual(
      db.prepare('SELECT provider, name FROM ai_service_configs WHERE id = 2').get(),
      { provider: 'preserved-provider', name: 'Preserved provider' },
    );
    assert.deepEqual(
      db.prepare(`SELECT state, final_config_id FROM generation_route_requests
        WHERE id = 'preserved-route'`).get(),
      { state: 'succeeded', final_config_id: 1 },
    );
  } finally {
    db.close();
  }
});
