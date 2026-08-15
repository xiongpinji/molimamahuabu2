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

test('provider stability migration creates the routing schema and remains idempotent', () => {
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    runMigrationsAndEnsure(db);

    const configColumns = columnNames(db, 'ai_service_configs');
    for (const name of [
      'logical_model_id',
      'failover_enabled',
      'verification_status',
      'verified_at',
      'verification_evidence',
    ]) {
      assert.equal(configColumns.has(name), true, `missing ai_service_configs.${name}`);
    }
    assert.equal(columnNames(db, 'video_generations').has('config_id'), true);

    for (const table of [
      'generation_route_requests',
      'generation_route_attempts',
      'provider_route_health',
      'provider_stability_events',
    ]) {
      assert.equal(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.[1],
        1,
        `missing table ${table}`,
      );
    }

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
