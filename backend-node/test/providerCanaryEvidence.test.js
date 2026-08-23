'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const aiConfigService = require('../src/services/aiConfigService');
const evidenceService = require('../src/services/providerCanaryEvidenceService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const NOW = '2026-08-18T00:00:00.000Z';
const CAPABILITY = {
  generationType: 'video',
  resolution: '720P',
  aspectRatio: '16:9',
  duration: 15,
  count: 2,
  referenceImageCount: 9,
  referenceVideoCount: 3,
  referenceAudioCount: 3,
  requiresAudio: true,
  firstFrame: true,
  lastFrame: true,
  slotSemantics: ['first_frame', 'reference_1', 'last_frame'],
  modelFeatures: ['camera_control', 'lip_sync'],
  userPriceContract: { billingUnit: 'second', credits: 25 },
};

function createDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrationsAndEnsure(db);
  const insert = db.prepare(`INSERT INTO ai_service_configs
    (id, service_type, provider, name, base_url, api_key, api_protocol, model,
     logical_model_id, is_active)
    VALUES (?, 'video', ?, ?, 'https://provider.invalid/v1', ?, 'openai',
      'upstream-video', ?, 1)`);
  insert.run(7, 'private-provider-7', 'Provider 7', 'secret-7', 'logical-video');
  insert.run(8, 'private-provider-8', 'Provider 8', 'secret-8', 'logical-video');
  insert.run(9, 'private-provider-9', 'Provider 9', 'secret-9', 'other-model');
  return db;
}

function fingerprints(suffix = 'a') {
  return {
    configFingerprint: `cfg-${suffix}`,
    costFingerprint: `cost-${suffix}`,
    runtimeFingerprint: `runtime-${suffix}`,
  };
}

function insertRun(db, overrides = {}) {
  const capability = overrides.capability || CAPABILITY;
  const serviceType = overrides.serviceType || 'video';
  const values = {
    id: 'canary-run-1',
    idempotency_key: 'canary-key-1',
    config_id: 7,
    logical_model_id: 'logical-video',
    service_type: serviceType,
    capability_fingerprint: evidenceService.capabilityFingerprint(serviceType, capability),
    config_fingerprint: 'cfg-a',
    cost_fingerprint: 'cost-a',
    runtime_fingerprint: 'runtime-a',
    provider_scope_key: 'scope-a',
    state: 'succeeded',
    reserved_cost_micros: 100,
    actual_cost_micros: 100,
    currency: 'CNY',
    budget_day: '2026-08-18',
    budget_month: '2026-08',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
  delete values.capability;
  delete values.serviceType;
  db.prepare(`INSERT INTO provider_canary_runs
    (id, idempotency_key, config_id, logical_model_id, service_type,
     capability_fingerprint, config_fingerprint, cost_fingerprint,
     runtime_fingerprint, provider_scope_key, state, reserved_cost_micros,
     actual_cost_micros, currency, budget_day, budget_month, created_at, updated_at)
    VALUES (@id, @idempotency_key, @config_id, @logical_model_id, @service_type,
     @capability_fingerprint, @config_fingerprint, @cost_fingerprint,
     @runtime_fingerprint, @provider_scope_key, @state, @reserved_cost_micros,
     @actual_cost_micros, @currency, @budget_day, @budget_month, @created_at, @updated_at)`)
    .run(values);
  return values;
}

function recordSuccess(db, overrides = {}) {
  return evidenceService.recordSuccess(db, {
    configId: 7,
    serviceType: 'video',
    capability: CAPABILITY,
    runId: 'canary-run-1',
    ...fingerprints(),
    now: NOW,
    ...overrides,
  });
}

test('capability fingerprints are key-stable and reject invalid scalar types', () => {
  const reordered = {
    userPriceContract: { credits: 25, billingUnit: 'second' },
    modelFeatures: ['lip_sync', 'camera_control'],
    slotSemantics: ['first_frame', 'reference_1', 'last_frame'],
    lastFrame: true,
    firstFrame: true,
    requiresAudio: true,
    referenceAudioCount: 3,
    referenceVideoCount: 3,
    referenceImageCount: 9,
    count: 2,
    duration: 15,
    aspectRatio: '16:9',
    resolution: ' 720p ',
    generationType: ' VIDEO ',
  };
  assert.equal(
    evidenceService.capabilityFingerprint(' VIDEO ', CAPABILITY),
    evidenceService.capabilityFingerprint('video', reordered),
  );
  assert.match(evidenceService.capabilityFingerprint('video', CAPABILITY), /^[a-f0-9]{64}$/);
  assert.throws(() => evidenceService.normalizeCapability('video', { duration: -1 }), /duration/);
  assert.throws(() => evidenceService.normalizeCapability('video', { count: Number.NaN }), /count/);
  assert.throws(() => evidenceService.normalizeCapability('video', { requiresAudio: 'yes' }), /requiresAudio/);
  assert.throws(() => evidenceService.normalizeCapability('video', { requiresAudio: null }), /requiresAudio/);
  assert.throws(() => evidenceService.normalizeCapability('video', { duration: null }), /duration/);
  assert.throws(() => evidenceService.normalizeCapability('video', { referenceImageCount: 1.5 }), /referenceImageCount/);
});

test('capability coverage uses exact contracts and capacity counts', () => {
  const exactRequest = { ...CAPABILITY, count: 1, referenceImageCount: 2, referenceVideoCount: 1, referenceAudioCount: 1 };
  assert.equal(evidenceService.capabilityCovers(CAPABILITY, exactRequest), true);
  for (let referenceImageCount = 0; referenceImageCount <= 9; referenceImageCount += 1) {
    assert.equal(evidenceService.covers(CAPABILITY, { ...exactRequest, referenceImageCount }), true);
  }
  assert.equal(evidenceService.covers(CAPABILITY, { ...exactRequest, referenceImageCount: 10 }), false);
  assert.equal(evidenceService.covers(CAPABILITY, { ...exactRequest, resolution: '480p' }), false);
  assert.equal(evidenceService.covers(CAPABILITY, { ...exactRequest, aspectRatio: '9:16' }), false);
  assert.equal(evidenceService.covers(CAPABILITY, { ...exactRequest, duration: 10 }), false);
  assert.equal(evidenceService.covers(CAPABILITY, { ...exactRequest, requiresAudio: false }), false);
  assert.equal(evidenceService.covers(CAPABILITY, { ...exactRequest, firstFrame: false }), false);
  assert.equal(evidenceService.covers(CAPABILITY, { ...exactRequest, slotSemantics: ['reference_1', 'first_frame', 'last_frame'] }), false);
  assert.equal(evidenceService.covers(CAPABILITY, { ...exactRequest, modelFeatures: ['camera_control'] }), false);
  assert.equal(evidenceService.covers(CAPABILITY, { ...exactRequest, userPriceContract: { billingUnit: 'second', credits: 30 } }), false);
});

test('config, cost, and provider scope fingerprints are stable, sensitive, and irreversible', () => {
  const config = {
    serviceType: 'video',
    apiKey: 'sk-private',
    baseUrl: 'https://relay.example.com/v1',
    protocol: 'openai',
    upstreamModel: 'video-v1',
    capabilities: { durations: [10, 5], resolutions: ['720p', '480p'] },
  };
  const reordered = {
    capabilities: { resolutions: ['480p', '720p', '720p'], durations: [5, 10] },
    upstreamModel: 'video-v1', protocol: 'OPENAI',
    baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-private', serviceType: 'VIDEO',
  };
  const hash = evidenceService.configFingerprint(config);
  assert.equal(hash, evidenceService.configFingerprint(reordered));
  for (const [field, value] of [
    ['apiKey', 'sk-other'], ['baseUrl', 'https://other.example.com/v1'],
    ['protocol', 'responses'], ['upstreamModel', 'video-v2'],
    ['capabilities', { durations: [5], resolutions: ['720p'] }],
  ]) assert.notEqual(hash, evidenceService.configFingerprint({ ...config, [field]: value }));
  assert.equal(hash.includes('sk-private'), false);

  const costA = evidenceService.costFingerprint(
    { model: 'video-v1', credits: 25, cost_micros_per_unit: 4000 },
    [{ resolution: '1080p', cost_micros_per_second: 2 }, { resolution: '720p', cost_micros_per_second: 1 }],
  );
  const costB = evidenceService.costFingerprint(
    { cost_micros_per_unit: 4000, credits: 25, model: 'video-v1' },
    [{ cost_micros_per_second: 1, resolution: '720p' }, { cost_micros_per_second: 2, resolution: '1080p' }],
  );
  assert.equal(costA, costB);

  const scope = evidenceService.providerScopeKey({
    provider: 'relay', baseUrl: 'not a url', apiKey: 'scope-secret', accountId: 'account-a',
  });
  assert.match(scope, /^[a-f0-9]{64}$/);
  assert.equal(scope.includes('relay'), false);
  assert.notEqual(scope, evidenceService.providerScopeKey({
    provider: 'relay', baseUrl: 'not a url', apiKey: 'scope-other', accountId: 'account-a',
  }));
});

test('recordSuccess requires the matching succeeded run and stores a safe canonical capability snapshot', () => {
  const db = createDb();
  try {
    insertRun(db, { state: 'reserved' });
    assert.throws(() => recordSuccess(db), /succeeded/);
    db.prepare("UPDATE provider_canary_runs SET state = 'succeeded'").run();
    const result = recordSuccess(db, {
      capability: { ...CAPABILITY, apiKey: 'must-not-store', prompt: 'must-not-store' },
      maxAgeMs: evidenceService.MAX_EVIDENCE_AGE_MS * 2,
    });
    assert.equal(result.state, 'fresh');
    assert.equal(result.expires_at, '2026-08-20T00:00:00.000Z');
    assert.deepEqual(result.capability, evidenceService.normalizeCapability('video', CAPABILITY));
    assert.equal(evidenceService.covers(result, {
      ...CAPABILITY,
      count: 1,
      referenceImageCount: 2,
      referenceVideoCount: 1,
      referenceAudioCount: 1,
    }), true);
    const stored = db.prepare('SELECT capability_json FROM provider_canary_evidence').get().capability_json;
    assert.deepEqual(JSON.parse(stored), result.capability);
    assert.equal(stored.includes('must-not-store'), false);

    assert.throws(() => recordSuccess(db, { capability: { ...CAPABILITY, duration: 16 } }), /matching succeeded/);
    assert.throws(() => recordSuccess(db, {
      capability: { ...CAPABILITY, userPriceContract: { credits: 25, apiKey: 'unsafe' } },
    }), /unsafe field/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM provider_canary_evidence').get().count, 1);
  } finally {
    db.close();
  }
});

test('evidence age options and environment values can shorten but never extend the 48 hour limit', (t) => {
  const previous = process.env.PROVIDER_CANARY_MAX_EVIDENCE_AGE_MS;
  t.after(() => {
    if (previous === undefined) delete process.env.PROVIDER_CANARY_MAX_EVIDENCE_AGE_MS;
    else process.env.PROVIDER_CANARY_MAX_EVIDENCE_AGE_MS = previous;
  });
  const db = createDb();
  try {
    insertRun(db);
    assert.equal(recordSuccess(db, { maxAgeMs: 60 * 60 * 1000 }).expires_at, '2026-08-18T01:00:00.000Z');
    assert.equal(recordSuccess(db, { maxAgeMs: -1 }).expires_at, '2026-08-20T00:00:00.000Z');
    process.env.PROVIDER_CANARY_MAX_EVIDENCE_AGE_MS = String(2 * 60 * 60 * 1000);
    assert.equal(recordSuccess(db).expires_at, '2026-08-18T02:00:00.000Z');
    process.env.PROVIDER_CANARY_MAX_EVIDENCE_AGE_MS = String(evidenceService.MAX_EVIDENCE_AGE_MS * 3);
    assert.equal(recordSuccess(db).expires_at, '2026-08-20T00:00:00.000Z');
  } finally {
    db.close();
  }
});

test('fresh evidence expires at the exact boundary and any fingerprint mismatch makes it stale', () => {
  const db = createDb();
  try {
    insertRun(db);
    const row = recordSuccess(db);
    const context = { now: '2026-08-19T23:59:59.999Z', ...fingerprints() };
    assert.equal(evidenceService.effectiveEvidenceState(row, context), 'fresh');
    assert.equal(evidenceService.effectiveEvidenceState(row, { ...context, now: row.expires_at }), 'stale');
    for (const [key, value] of [
      ['configFingerprint', 'cfg-other'],
      ['costFingerprint', 'cost-other'],
      ['runtimeFingerprint', 'runtime-other'],
    ]) assert.equal(evidenceService.effectiveEvidenceState(row, { ...context, [key]: value }), 'stale');
    assert.equal(evidenceService.effectiveEvidenceState(row, { ...context, canaryPaused: true }), 'disabled');
  } finally {
    db.close();
  }
});

test('a zero-cost health update cannot refresh evidence timestamps or recover unknown evidence', () => {
  const db = createDb();
  try {
    insertRun(db);
    recordSuccess(db);
    const before = db.prepare('SELECT verified_at, expires_at FROM provider_canary_evidence').get();
    db.prepare(`INSERT INTO provider_zero_cost_checks
      (config_id, state, checked_at, updated_at) VALUES (7, 'healthy', ?, ?)`).run(
      '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z',
    );
    assert.deepEqual(db.prepare('SELECT verified_at, expires_at FROM provider_canary_evidence').get(), before);
    const unknown = { ...db.prepare('SELECT * FROM provider_canary_evidence').get(), state: 'submission_unknown' };
    assert.equal(evidenceService.effectiveEvidenceState(unknown, {
      now: '2026-08-19T00:00:00.000Z', healthState: 'healthy', ...fingerprints(),
    }), 'submission_unknown');
  } finally {
    db.close();
  }
});

test('a success upsert updates only its target config and capability identity', () => {
  const db = createDb();
  try {
    insertRun(db);
    const otherCapability = { ...CAPABILITY, resolution: '1080p' };
    const otherFingerprint = evidenceService.capabilityFingerprint('video', otherCapability);
    db.prepare(`INSERT INTO provider_canary_evidence
      (config_id, service_type, capability_fingerprint, capability_json, state,
       config_fingerprint, cost_fingerprint, runtime_fingerprint, created_at, updated_at)
      VALUES (8, 'video', ?, ?, 'stale', 'other-cfg', 'other-cost', 'other-runtime', ?, ?)`)
      .run(otherFingerprint, JSON.stringify(evidenceService.normalizeCapability('video', otherCapability)), NOW, NOW);
    const before = JSON.stringify(db.prepare('SELECT * FROM provider_canary_evidence WHERE config_id = 8').get());
    recordSuccess(db);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM provider_canary_evidence WHERE config_id = 8').get()), before);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM provider_canary_evidence').get().count, 2);
  } finally {
    db.close();
  }
});

test('unknown outcomes preserve exact run states, unify evidence state, and emit only safe event details', () => {
  const db = createDb();
  try {
    insertRun(db, { state: 'verifying' });
    for (const state of ['submission_unknown', 'result_unknown', 'artifact_unreadable']) {
      evidenceService.recordUnknown(db, {
        configId: 7,
        serviceType: 'video',
        capability: CAPABILITY,
        runId: 'canary-run-1',
        state,
        now: NOW,
        provider: 'must-not-store-provider',
        baseUrl: 'https://secret.example.com/task/123',
        apiKey: 'must-not-store-key',
        taskUrl: 'https://secret.example.com/task/123?signature=secret',
      });
      assert.equal(db.prepare('SELECT state FROM provider_canary_runs').get().state, state);
      assert.equal(db.prepare('SELECT state FROM provider_canary_evidence').get().state, 'submission_unknown');
    }
    evidenceService.recordUnknown(db, {
      configId: 7,
      serviceType: 'video',
      capability: CAPABILITY,
      runId: 'canary-run-1',
      state: 'artifact_unreadable',
      now: NOW,
    });
    const events = db.prepare('SELECT * FROM provider_stability_events ORDER BY id').all();
    assert.deepEqual(events.map((event) => event.task_state), [
      'submission_unknown', 'result_unknown', 'artifact_unreadable',
    ]);
    const serialized = JSON.stringify(events);
    for (const secret of ['must-not-store-provider', 'secret.example.com', 'must-not-store-key', 'signature=secret']) {
      assert.equal(serialized.includes(secret), false);
    }
    assert.throws(() => evidenceService.recordUnknown(db, {
      configId: 7, serviceType: 'video', capability: CAPABILITY,
      runId: 'canary-run-1', state: 'unknown', now: NOW,
    }), /state/);
  } finally {
    db.close();
  }
});

test('failure, budget block, targeted invalidation, and covering lookup preserve state boundaries', () => {
  const db = createDb();
  try {
    insertRun(db);
    recordSuccess(db);
    const covered = evidenceService.listFreshCoveringEvidence(db, {
      configId: 7,
      logicalModelId: 'logical-video',
      serviceType: 'video',
      capability: { ...CAPABILITY, count: 1, referenceImageCount: 2 },
      now: '2026-08-19T00:00:00.000Z',
      ...fingerprints(),
    });
    assert.equal(covered.length, 1);
    assert.equal(covered[0].capability.referenceImageCount, 9);

    evidenceService.invalidateConfig(db, 7, 'config_changed', '2026-08-19T00:00:00.000Z');
    assert.deepEqual(
      db.prepare('SELECT state, invalidation_reason FROM provider_canary_evidence WHERE config_id = 7').get(),
      { state: 'stale', invalidation_reason: 'config_changed' },
    );
    assert.throws(() => evidenceService.invalidateConfig(db, 7, 'https://secret.invalid', NOW), /reason/);

    db.prepare("UPDATE provider_canary_runs SET state = 'verifying'").run();
    evidenceService.recordFailure(db, {
      configId: 7, serviceType: 'video', capability: CAPABILITY, runId: 'canary-run-1', now: NOW,
    });
    assert.equal(db.prepare('SELECT state FROM provider_canary_evidence WHERE config_id = 7').get().state, 'failing');
    evidenceService.recordBudgetBlocked(db, {
      configId: 7, serviceType: 'video', capability: CAPABILITY, runId: 'canary-run-1', now: NOW,
    });
    assert.equal(db.prepare('SELECT state FROM provider_canary_evidence WHERE config_id = 7').get().state, 'budget_blocked');

    insertRun(db, {
      id: 'canary-run-other-model', idempotency_key: 'canary-key-other-model',
      config_id: 9, logical_model_id: 'other-model',
    });
    evidenceService.recordSuccess(db, {
      configId: 9, serviceType: 'video', capability: CAPABILITY,
      runId: 'canary-run-other-model', ...fingerprints(), now: NOW,
    });
    evidenceService.invalidateLogicalModel(db, 'logical-video', 'logical_model_changed', NOW);
    assert.equal(db.prepare('SELECT state FROM provider_canary_evidence WHERE config_id = 9').get().state, 'fresh');
  } finally {
    db.close();
  }
});

test('soft deletion invalidates only the deleted route and fresh lookup excludes it', () => {
  const db = createDb();
  try {
    insertRun(db);
    recordSuccess(db);
    insertRun(db, {
      id: 'canary-run-2',
      idempotency_key: 'canary-key-2',
      config_id: 8,
    });
    recordSuccess(db, { configId: 8, runId: 'canary-run-2' });
    db.prepare("UPDATE ai_service_configs SET verification_status = 'verified', is_active = 1 WHERE id = 7").run();

    const logs = [];
    assert.equal(aiConfigService.deleteConfig(db, { info: (...args) => logs.push(args) }, 7), true);
    const deleted = db.prepare('SELECT deleted_at, verification_status, is_active FROM ai_service_configs WHERE id = 7').get();
    const invalidated = db.prepare(`SELECT state, invalidation_reason, updated_at
      FROM provider_canary_evidence WHERE config_id = 7`).get();
    assert.equal(deleted.deleted_at, invalidated.updated_at);
    assert.equal(deleted.verification_status, 'verified');
    assert.equal(deleted.is_active, 1);
    assert.deepEqual(
      { state: invalidated.state, invalidation_reason: invalidated.invalidation_reason },
      { state: 'stale', invalidation_reason: 'admin_invalidated' },
    );

    const lookup = (configId) => evidenceService.listFreshCoveringEvidence(db, {
      configId,
      logicalModelId: 'logical-video',
      serviceType: 'video',
      capability: CAPABILITY,
      now: '2026-08-19T00:00:00.000Z',
      ...fingerprints(),
    });
    assert.equal(lookup(7).length, 0);
    assert.equal(lookup(8).length, 1);
    assert.equal(db.prepare('SELECT state FROM provider_canary_evidence WHERE config_id = 8').get().state, 'fresh');
    assert.equal(aiConfigService.deleteConfig(db, { info() {} }, 7), false);
    assert.equal(aiConfigService.deleteConfig(db, { info() {} }, 999), false);
    assert.equal(logs.length, 1);
  } finally {
    db.close();
  }
});

test('fresh lookup rejects legacy deleted configs even if active and verified residue remains', () => {
  const db = createDb();
  try {
    insertRun(db);
    recordSuccess(db);
    db.prepare(`UPDATE ai_service_configs
      SET deleted_at = ?, verification_status = 'verified', is_active = 1
      WHERE id = 7`).run('2026-08-18T01:00:00.000Z');
    assert.equal(db.prepare('SELECT state FROM provider_canary_evidence WHERE config_id = 7').get().state, 'fresh');
    assert.equal(evidenceService.listFreshCoveringEvidence(db, {
      configId: 7,
      logicalModelId: 'logical-video',
      serviceType: 'video',
      capability: CAPABILITY,
      now: '2026-08-19T00:00:00.000Z',
      ...fingerprints(),
    }).length, 0);
  } finally {
    db.close();
  }
});

test('ordinary evidence invalidation failures roll back soft deletion', () => {
  const db = createDb();
  try {
    insertRun(db);
    recordSuccess(db);
    db.exec(`CREATE TRIGGER reject_delete_invalidation
      BEFORE UPDATE ON provider_canary_evidence
      BEGIN
        SELECT RAISE(ABORT, 'delete invalidation rejected');
      END`);
    assert.throws(
      () => aiConfigService.deleteConfig(db, { info() {} }, 7),
      /delete invalidation rejected/,
    );
    assert.equal(db.prepare('SELECT deleted_at FROM ai_service_configs WHERE id = 7').get().deleted_at, null);
    assert.deepEqual(
      db.prepare('SELECT state, invalidation_reason FROM provider_canary_evidence WHERE config_id = 7').get(),
      { state: 'fresh', invalidation_reason: null },
    );
  } finally {
    db.close();
  }
});

test('legacy databases without the canary evidence table retain idempotent deletion semantics', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE ai_service_configs (
      id INTEGER PRIMARY KEY,
      deleted_at TEXT
    )`);
    db.prepare('INSERT INTO ai_service_configs (id, deleted_at) VALUES (1, NULL)').run();
    assert.equal(aiConfigService.deleteConfig(db, { info() {} }, 1), true);
    assert.equal(aiConfigService.deleteConfig(db, { info() {} }, 1), false);
    assert.equal(aiConfigService.deleteConfig(db, { info() {} }, 999), false);
  } finally {
    db.close();
  }
});
