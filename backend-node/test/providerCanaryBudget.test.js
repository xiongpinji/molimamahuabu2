'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const budgetService = require('../src/services/providerCanaryBudgetService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const NOW = '2026-08-18T00:00:00.000Z';

function insertConfig(db, id = 1) {
  db.prepare(`INSERT INTO ai_service_configs (id, service_type, provider, name)
    VALUES (?, 'video', ?, ?)`).run(id, `private-provider-${id}`, `Provider ${id}`);
}

function createDb(filename = ':memory:') {
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  runMigrationsAndEnsure(db);
  insertConfig(db, 1);
  insertConfig(db, 2);
  return db;
}

function reserveInput(overrides = {}) {
  const defaults = {
    id: 'run-1',
    idempotencyKey: 'key-1',
    route: {
      configId: 1,
      logicalModelId: 'logical-video',
      serviceType: 'video',
      capabilityFingerprint: 'capability-a',
      configFingerprint: 'config-a',
      costFingerprint: 'cost-a',
      runtimeFingerprint: 'runtime-a',
      providerScopeKey: 'scope-a',
    },
    reservedCostMicros: 1_000_000,
    currency: 'CNY',
    now: NOW,
  };
  const { route, ...rest } = overrides;
  return {
    ...defaults,
    ...rest,
    route: { ...defaults.route, ...(route || {}) },
  };
}

function reserveRun(db, overrides = {}) {
  return budgetService.reserve(db, reserveInput(overrides));
}

function insertHistoricalRun(db, overrides = {}) {
  const values = {
    id: 'historical-run',
    idempotency_key: 'historical-key',
    config_id: 1,
    logical_model_id: 'logical-video',
    service_type: 'video',
    capability_fingerprint: 'capability-history',
    config_fingerprint: 'config-history',
    cost_fingerprint: 'cost-history',
    runtime_fingerprint: 'runtime-history',
    provider_scope_key: 'scope-history',
    state: 'reserved',
    reserved_cost_micros: 1,
    actual_cost_micros: null,
    currency: 'CNY',
    budget_day: '2026-08-17',
    budget_month: '2026-08',
    created_at: '2026-08-17T00:00:00.000Z',
    updated_at: '2026-08-17T00:00:00.000Z',
    ...overrides,
  };
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
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

function acceptRun(db, overrides = {}) {
  const input = reserveInput(overrides);
  budgetService.reserve(db, input);
  budgetService.markSubmitting(db, input.id, '2026-08-18T00:00:01.000Z');
  budgetService.markAccepted(db, input.id, `task-${input.id}`, '2026-08-18T00:00:02.000Z');
  return input;
}

test('daily hard limit allows 19.50 CNY plus 0.50 CNY and rejects the next micro', () => {
  const db = createDb();
  try {
    reserveRun(db, { id: 'daily-1', idempotencyKey: 'daily-key-1', reservedCostMicros: 19_500_000 });
    reserveRun(db, { id: 'daily-2', idempotencyKey: 'daily-key-2', reservedCostMicros: 500_000 });
    expectCode(
      () => reserveRun(db, { id: 'daily-3', idempotencyKey: 'daily-key-3', reservedCostMicros: 1 }),
      'PROVIDER_CANARY_DAILY_BUDGET_EXCEEDED',
    );
    const summary = budgetService.getBudgetSummary(db, NOW);
    assert.equal(summary.dailyUsedMicros, 20_000_000);
    assert.equal(summary.dailyRemainingMicros, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM provider_canary_runs').get().count, 2);
  } finally {
    db.close();
  }
});

test('monthly hard limit allows its exact boundary and rejects the next micro', () => {
  const db = createDb();
  try {
    insertHistoricalRun(db, { reserved_cost_micros: 580_000_000 });
    reserveRun(db, { id: 'month-1', idempotencyKey: 'month-key-1', reservedCostMicros: 19_500_000 });
    reserveRun(db, { id: 'month-2', idempotencyKey: 'month-key-2', reservedCostMicros: 500_000 });
    expectCode(
      () => reserveRun(db, { id: 'month-3', idempotencyKey: 'month-key-3', reservedCostMicros: 1 }),
      'PROVIDER_CANARY_DAILY_BUDGET_EXCEEDED',
    );
    assert.equal(budgetService.getBudgetSummary(db, NOW).monthlyUsedMicros, 600_000_000);
  } finally {
    db.close();
  }
});

test('monthly-only exhaustion uses the monthly error code', () => {
  const db = createDb();
  try {
    insertHistoricalRun(db, { reserved_cost_micros: 599_500_000 });
    reserveRun(db, { id: 'month-only-1', idempotencyKey: 'month-only-key-1', reservedCostMicros: 500_000 });
    expectCode(
      () => reserveRun(db, { id: 'month-only-2', idempotencyKey: 'month-only-key-2', reservedCostMicros: 1 }),
      'PROVIDER_CANARY_MONTHLY_BUDGET_EXCEEDED',
    );
  } finally {
    db.close();
  }
});

test('two file-backed connections observe committed reservations without overspending', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-canary-budget-'));
  const filename = path.join(directory, 'budget.sqlite');
  const first = createDb(filename);
  const second = new Database(filename);
  try {
    second.pragma('foreign_keys = ON');
    first.pragma('busy_timeout = 1000');
    second.pragma('busy_timeout = 1000');
    reserveRun(first, { id: 'connection-1', idempotencyKey: 'connection-key-1', reservedCostMicros: 19_500_000 });
    reserveRun(second, { id: 'connection-2', idempotencyKey: 'connection-key-2', reservedCostMicros: 500_000 });
    expectCode(
      () => reserveRun(second, { id: 'connection-3', idempotencyKey: 'connection-key-3', reservedCostMicros: 1 }),
      'PROVIDER_CANARY_DAILY_BUDGET_EXCEEDED',
    );
    assert.equal(second.prepare('SELECT COUNT(*) AS count FROM provider_canary_runs').get().count, 2);
  } finally {
    second.close();
    first.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('claimForExecution grants one owner after two connections both observed reserved', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-canary-claim-'));
  const filename = path.join(directory, 'claim.sqlite');
  const first = createDb(filename);
  const second = new Database(filename);
  try {
    second.pragma('foreign_keys = ON');
    first.pragma('busy_timeout = 1000');
    second.pragma('busy_timeout = 1000');
    reserveRun(first);
    assert.equal(first.prepare("SELECT state FROM provider_canary_runs WHERE id = 'run-1'").get().state, 'reserved');
    assert.equal(second.prepare("SELECT state FROM provider_canary_runs WHERE id = 'run-1'").get().state, 'reserved');

    let submitOwners = 0;
    const claimed = budgetService.claimForExecution(
      first, 'run-1', '2026-08-18T00:00:01.000Z',
    );
    if (claimed.executionOwner) submitOwners += 1;
    expectCode(
      () => budgetService.claimForExecution(second, 'run-1', '2026-08-18T00:00:02.000Z'),
      'PROVIDER_CANARY_EXECUTION_NOT_CLAIMED',
    );

    assert.equal(claimed.executionOwner, true);
    assert.equal(claimed.run.state, 'submitting');
    assert.equal(submitOwners, 1);
    assert.equal(second.prepare("SELECT state FROM provider_canary_runs WHERE id = 'run-1'").get().state, 'submitting');
  } finally {
    second.close();
    first.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('claimForExecution checks unresolved provider scope blockers in the same transaction', () => {
  const db = createDb();
  try {
    insertHistoricalRun(db, {
      id: 'unknown-scope-run',
      idempotency_key: 'unknown-scope-key',
      provider_scope_key: 'scope-a',
      state: 'submission_unknown',
    });
    reserveRun(db);

    expectCode(
      () => budgetService.claimForExecution(db, 'run-1', '2026-08-18T00:00:01.000Z'),
      'PROVIDER_CANARY_SCOPE_BLOCKED',
    );
    assert.equal(db.prepare("SELECT state FROM provider_canary_runs WHERE id = 'run-1'").get().state, 'reserved');
  } finally {
    db.close();
  }
});

test('idempotency replay requires every immutable reservation field to match', () => {
  const db = createDb();
  try {
    const original = reserveRun(db);
    assert.deepEqual(reserveRun(db), original);
    const conflicts = [
      { id: 'different-id' },
      { route: { configId: 2 } },
      { route: { logicalModelId: 'different-model' } },
      { route: { serviceType: 'image' } },
      { route: { capabilityFingerprint: 'different-capability' } },
      { route: { configFingerprint: 'different-config' } },
      { route: { costFingerprint: 'different-cost' } },
      { route: { runtimeFingerprint: 'different-runtime' } },
      { route: { providerScopeKey: 'different-scope' } },
      { reservedCostMicros: 2_000_000 },
      { now: '2026-08-18T16:00:00.000Z' },
    ];
    for (const override of conflicts) {
      expectCode(
        () => reserveRun(db, override),
        'PROVIDER_CANARY_IDEMPOTENCY_CONFLICT',
      );
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM provider_canary_runs').get().count, 1);
    assert.equal(budgetService.getBudgetSummary(db, NOW).dailyUsedMicros, 1_000_000);
  } finally {
    db.close();
  }
});

test('reserve validates time, positive safe cost, currency, route, and foreign key input', () => {
  const db = createDb();
  try {
    for (const [suffix, override] of [
      ['bad-time', { now: '2026-08-18' }],
      ['zero', { reservedCostMicros: 0 }],
      ['negative', { reservedCostMicros: -1 }],
      ['fraction', { reservedCostMicros: 1.5 }],
      ['unsafe', { reservedCostMicros: Number.MAX_SAFE_INTEGER + 1 }],
      ['currency', { currency: 'USD' }],
      ['route', { route: { runtimeFingerprint: '' } }],
      ['config-id', { route: { configId: 0 } }],
    ]) {
      expectCode(
        () => reserveRun(db, { id: `invalid-${suffix}`, idempotencyKey: `invalid-key-${suffix}`, ...override }),
        'PROVIDER_CANARY_INVALID_INPUT',
      );
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM provider_canary_runs').get().count, 0);
  } finally {
    db.close();
  }
});

test('submitting and accepted transitions are strict, validated, idempotent, and timestamped', () => {
  const db = createDb();
  try {
    reserveRun(db);
    expectCode(() => budgetService.markAccepted(db, 'run-1', 'task-1', NOW), 'PROVIDER_CANARY_INVALID_STATE_TRANSITION');
    expectCode(() => budgetService.markSubmitting(db, '', NOW), 'PROVIDER_CANARY_INVALID_INPUT');
    expectCode(() => budgetService.markSubmitting(db, 'missing', NOW), 'PROVIDER_CANARY_RUN_NOT_FOUND');
    expectCode(() => budgetService.markSubmitting(db, 'run-1', 'not-a-time'), 'PROVIDER_CANARY_INVALID_INPUT');

    const submitting = budgetService.markSubmitting(db, 'run-1', '2026-08-18T00:00:01.000Z');
    assert.equal(submitting.state, 'submitting');
    assert.equal(submitting.submitted_at, '2026-08-18T00:00:01.000Z');
    assert.deepEqual(budgetService.markSubmitting(db, 'run-1', '2026-08-18T00:00:09.000Z'), submitting);
    expectCode(() => budgetService.markAccepted(db, 'run-1', '', NOW), 'PROVIDER_CANARY_INVALID_INPUT');

    const accepted = budgetService.markAccepted(db, 'run-1', 'task-1', '2026-08-18T00:00:02.000Z');
    assert.equal(accepted.state, 'accepted');
    assert.equal(accepted.provider_task_id, 'task-1');
    assert.deepEqual(budgetService.markAccepted(db, 'run-1', 'task-1', '2026-08-18T00:00:09.000Z'), accepted);
    expectCode(
      () => budgetService.markAccepted(db, 'run-1', 'different-task', '2026-08-18T00:00:10.000Z'),
      'PROVIDER_CANARY_INVALID_STATE_TRANSITION',
    );
    expectCode(() => budgetService.markSubmitting(db, 'run-1', NOW), 'PROVIDER_CANARY_INVALID_STATE_TRANSITION');
  } finally {
    db.close();
  }
});

test('submitting, accepted, and unknown transitions use immediate transactions', () => {
  const db = createDb();
  try {
    reserveRun(db);
    const originalTransaction = db.transaction.bind(db);
    let immediateCalls = 0;
    db.transaction = (fn) => {
      const transaction = originalTransaction(fn);
      const wrapper = (...args) => transaction(...args);
      wrapper.immediate = (...args) => {
        immediateCalls += 1;
        return transaction.immediate(...args);
      };
      return wrapper;
    };
    budgetService.markSubmitting(db, 'run-1', '2026-08-18T00:00:01.000Z');
    budgetService.markAccepted(db, 'run-1', 'provider-task-original', '2026-08-18T00:00:02.000Z');
    budgetService.settleUnknown(
      db, 'run-1', 'result_unknown', 'result_timeout', null, '2026-08-18T00:00:03.000Z',
    );
    assert.equal(immediateCalls, 3);
  } finally {
    db.close();
  }
});

test('state replay rejects stored task or category fields absent from the request', () => {
  const db = createDb();
  try {
    reserveRun(db, { id: 'submitting-replay', idempotencyKey: 'submitting-replay-key' });
    budgetService.markSubmitting(db, 'submitting-replay', '2026-08-18T00:00:01.000Z');
    db.prepare(`UPDATE provider_canary_runs SET provider_task_id = 'unexpected-task'
      WHERE id = 'submitting-replay'`).run();
    expectCode(
      () => budgetService.markSubmitting(db, 'submitting-replay', '2026-08-18T00:00:09.000Z'),
      'PROVIDER_CANARY_INVALID_STATE_TRANSITION',
    );

    reserveRun(db, { id: 'accepted-replay', idempotencyKey: 'accepted-replay-key' });
    budgetService.markSubmitting(db, 'accepted-replay', '2026-08-18T00:00:01.000Z');
    budgetService.markAccepted(
      db, 'accepted-replay', 'provider-task-original', '2026-08-18T00:00:02.000Z',
    );
    db.prepare(`UPDATE provider_canary_runs SET error_category = 'unexpected_category'
      WHERE id = 'accepted-replay'`).run();
    expectCode(
      () => budgetService.markAccepted(
        db, 'accepted-replay', 'provider-task-original', '2026-08-18T00:00:09.000Z',
      ),
      'PROVIDER_CANARY_INVALID_STATE_TRANSITION',
    );
  } finally {
    db.close();
  }
});

test('two connections cannot overwrite accepted task or unknown terminal identity', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-canary-state-'));
  const filename = path.join(directory, 'state.sqlite');
  const first = createDb(filename);
  const second = new Database(filename);
  try {
    second.pragma('foreign_keys = ON');
    first.pragma('busy_timeout = 1000');
    second.pragma('busy_timeout = 1000');
    reserveRun(first);
    const submitting = budgetService.markSubmitting(first, 'run-1', '2026-08-18T00:00:01.000Z');
    assert.deepEqual(
      budgetService.markSubmitting(second, 'run-1', '2026-08-18T00:00:09.000Z'),
      submitting,
    );
    const accepted = budgetService.markAccepted(
      first, 'run-1', 'provider-task-original', '2026-08-18T00:00:02.000Z',
    );
    expectCode(
      () => budgetService.markAccepted(
        second, 'run-1', 'provider-task-different', '2026-08-18T00:00:03.000Z',
      ),
      'PROVIDER_CANARY_INVALID_STATE_TRANSITION',
    );
    assert.deepEqual(
      budgetService.markAccepted(
        second, 'run-1', 'provider-task-original', '2026-08-18T00:00:09.000Z',
      ),
      accepted,
    );

    const unknown = budgetService.settleUnknown(
      first, 'run-1', 'result_unknown', 'result_timeout', null,
      '2026-08-18T00:00:04.000Z',
    );
    expectCode(
      () => budgetService.settleUnknown(
        second, 'run-1', 'result_unknown', 'different_category', null,
        '2026-08-18T00:00:05.000Z',
      ),
      'PROVIDER_CANARY_INVALID_STATE_TRANSITION',
    );
    expectCode(
      () => budgetService.settleUnknown(
        second, 'run-1', 'artifact_unreadable', 'result_timeout', null,
        '2026-08-18T00:00:05.000Z',
      ),
      'PROVIDER_CANARY_INVALID_STATE_TRANSITION',
    );
    assert.deepEqual(second.prepare(`SELECT state, provider_task_id, error_category,
      actual_cost_micros, finished_at FROM provider_canary_runs WHERE id = 'run-1'`).get(), {
      state: unknown.state,
      provider_task_id: 'provider-task-original',
      error_category: 'result_timeout',
      actual_cost_micros: null,
      finished_at: '2026-08-18T00:00:04.000Z',
    });
  } finally {
    second.close();
    first.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('success records bounded actual cost and only required artifact metadata', () => {
  const db = createDb();
  try {
    acceptRun(db, { reservedCostMicros: 1_000_000 });
    const artifact = { path: '/safe/canary/result.mp4', sha256: 'a'.repeat(64), bytes: 123 };
    expectCode(
      () => budgetService.settleSuccess(db, 'run-1', -1, artifact, '2026-08-18T00:00:03.000Z'),
      'PROVIDER_CANARY_INVALID_INPUT',
    );
    expectCode(
      () => budgetService.settleSuccess(db, 'run-1', 900_000, { ...artifact, url: 'https://secret.invalid' }, '2026-08-18T00:00:03.000Z'),
      'PROVIDER_CANARY_INVALID_INPUT',
    );
    const succeeded = budgetService.settleSuccess(
      db, 'run-1', 750_000, artifact, '2026-08-18T00:00:03.000Z',
    );
    assert.deepEqual(
      {
        state: succeeded.state,
        actual: succeeded.actual_cost_micros,
        path: succeeded.artifact_path,
        sha: succeeded.artifact_sha256,
        bytes: succeeded.artifact_bytes,
        finished: succeeded.finished_at,
      },
      {
        state: 'succeeded',
        actual: 750_000,
        path: artifact.path,
        sha: artifact.sha256,
        bytes: artifact.bytes,
        finished: '2026-08-18T00:00:03.000Z',
      },
    );
    assert.equal(budgetService.getBudgetSummary(db, NOW).dailyUsedMicros, 750_000);
    assert.deepEqual(
      budgetService.settleSuccess(db, 'run-1', 750_000, artifact, '2026-08-18T00:00:09.000Z'),
      succeeded,
    );
    expectCode(
      () => budgetService.settleDefinitiveFailure(db, 'run-1', 0, 'late_failure', NOW),
      'PROVIDER_CANARY_INVALID_STATE_TRANSITION',
    );
  } finally {
    db.close();
  }
});

test('definitive pre-submit failure with zero actual cost releases reservation', () => {
  const db = createDb();
  try {
    reserveRun(db, { reservedCostMicros: 2_000_000 });
    const failed = budgetService.settleDefinitiveFailure(
      db, 'run-1', 0, 'request_validation', '2026-08-18T00:00:01.000Z',
    );
    assert.equal(failed.state, 'failed');
    assert.equal(failed.actual_cost_micros, 0);
    assert.equal(failed.error_category, 'request_validation');
    assert.equal(failed.finished_at, '2026-08-18T00:00:01.000Z');
    assert.equal(budgetService.getBudgetSummary(db, NOW).dailyUsedMicros, 0);
    assert.deepEqual(
      budgetService.settleDefinitiveFailure(db, 'run-1', 0, 'request_validation', '2026-08-18T00:00:09.000Z'),
      failed,
    );
    expectCode(
      () => budgetService.settleDefinitiveFailure(db, 'run-1', 0, 'unsafe category with spaces', NOW),
      'PROVIDER_CANARY_INVALID_INPUT',
    );
  } finally {
    db.close();
  }
});

test('cost overrun persists a safe error event and keeps the full reservation', () => {
  const db = createDb();
  try {
    acceptRun(db, { reservedCostMicros: 1_000_000 });
    const artifact = { path: '/safe/result.mp4', sha256: 'b'.repeat(64), bytes: 10 };
    expectCode(
      () => budgetService.settleSuccess(db, 'run-1', 1_000_001, artifact, '2026-08-18T00:00:03.000Z'),
      'PROVIDER_CANARY_COST_OVERRUN',
    );
    expectCode(
      () => budgetService.settleSuccess(db, 'run-1', 1_000_001, artifact, '2026-08-18T00:00:04.000Z'),
      'PROVIDER_CANARY_COST_OVERRUN',
    );
    expectCode(
      () => budgetService.settleDefinitiveFailure(
        db, 'run-1', 1_000_002, 'provider_failure', '2026-08-18T00:00:05.000Z',
      ),
      'PROVIDER_CANARY_COST_OVERRUN',
    );
    const run = db.prepare('SELECT * FROM provider_canary_runs WHERE id = ?').get('run-1');
    assert.equal(run.state, 'accepted');
    assert.equal(run.actual_cost_micros, null);
    assert.equal(budgetService.getBudgetSummary(db, NOW).dailyUsedMicros, 1_000_000);

    const event = db.prepare(`SELECT severity, event_type, request_id, logical_model_id, config_id,
      safe_details FROM provider_stability_events`).get();
    assert.equal(event.severity, 'error');
    assert.equal(event.event_type, 'provider_canary_cost_overrun');
    assert.equal(event.request_id, 'run-1');
    assert.equal(event.logical_model_id, 'logical-video');
    assert.equal(event.config_id, 1);
    assert.deepEqual(JSON.parse(event.safe_details), {
      runId: 'run-1',
      logicalModelId: 'logical-video',
      reservedCostMicros: 1_000_000,
      actualCostMicros: 1_000_001,
    });
    assert.doesNotMatch(event.safe_details, /provider|api[_-]?key|https?:|task-run-1/i);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM provider_stability_events
      WHERE request_id = 'run-1' AND event_type = 'provider_canary_cost_overrun'`).get().count, 1);
  } finally {
    db.close();
  }
});

test('definitive failure also protects against cost overrun', () => {
  const db = createDb();
  try {
    reserveRun(db, { reservedCostMicros: 5 });
    expectCode(
      () => budgetService.settleDefinitiveFailure(db, 'run-1', 6, 'provider_failure', NOW),
      'PROVIDER_CANARY_COST_OVERRUN',
    );
    assert.deepEqual(
      db.prepare('SELECT state, actual_cost_micros FROM provider_canary_runs WHERE id = ?').get('run-1'),
      { state: 'reserved', actual_cost_micros: null },
    );
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM provider_stability_events
      WHERE event_type = 'provider_canary_cost_overrun' AND severity = 'error'`).get().count, 1);
  } finally {
    db.close();
  }
});

test('all unknown terminal states preserve full reservation and forbid terminal tunneling', () => {
  const db = createDb();
  try {
    const cases = [
      ['submission_unknown', null],
      ['result_unknown', 'provider-task-result'],
      ['artifact_unreadable', 'provider-task-artifact'],
    ];
    for (const [index, [state, providerTaskId]] of cases.entries()) {
      const id = `unknown-${index}`;
      const input = reserveInput({ id, idempotencyKey: `unknown-key-${index}`, reservedCostMicros: 1_000_000 });
      budgetService.reserve(db, input);
      budgetService.markSubmitting(db, id, '2026-08-18T00:00:01.000Z');
      if (providerTaskId) {
        budgetService.markAccepted(db, id, providerTaskId, '2026-08-18T00:00:02.000Z');
      }
      const unknown = budgetService.settleUnknown(
        db, id, state, `${state}_category`, providerTaskId, '2026-08-18T00:00:03.000Z',
      );
      assert.equal(unknown.state, state);
      assert.equal(unknown.error_category, `${state}_category`);
      assert.equal(unknown.provider_task_id, providerTaskId);
      assert.equal(unknown.actual_cost_micros, null);
      assert.deepEqual(
        budgetService.settleUnknown(
          db, id, state, `${state}_category`, providerTaskId, '2026-08-18T00:00:09.000Z',
        ),
        unknown,
      );
      expectCode(
        () => budgetService.settleSuccess(
          db, id, 1, { path: '/safe/result', sha256: 'c'.repeat(64), bytes: 1 }, NOW,
        ),
        'PROVIDER_CANARY_INVALID_STATE_TRANSITION',
      );
      expectCode(
        () => budgetService.settleDefinitiveFailure(db, id, 0, 'late_failure', NOW),
        'PROVIDER_CANARY_INVALID_STATE_TRANSITION',
      );
    }
    assert.equal(budgetService.getBudgetSummary(db, NOW).dailyUsedMicros, 3_000_000);
    expectCode(
      () => budgetService.settleUnknown(db, 'unknown-0', 'unknown', 'bad_state', null, NOW),
      'PROVIDER_CANARY_INVALID_INPUT',
    );
  } finally {
    db.close();
  }
});

test('result and artifact unknown states preserve the accepted task id for empty input', () => {
  const db = createDb();
  try {
    for (const [index, [state, emptyTaskId]] of [
      ['result_unknown', null],
      ['artifact_unreadable', ''],
    ].entries()) {
      const id = `accepted-unknown-${index}`;
      reserveRun(db, { id, idempotencyKey: `accepted-unknown-key-${index}` });
      budgetService.markSubmitting(db, id, '2026-08-18T00:00:01.000Z');
      budgetService.markAccepted(db, id, 'provider-task-original', '2026-08-18T00:00:02.000Z');
      const unknown = budgetService.settleUnknown(
        db, id, state, `${state}_category`, emptyTaskId, '2026-08-18T00:00:03.000Z',
      );
      assert.equal(unknown.provider_task_id, 'provider-task-original');
      assert.equal(unknown.actual_cost_micros, null);
      assert.equal(
        budgetService.settleUnknown(
          db, id, state, `${state}_category`, '', '2026-08-18T00:00:09.000Z',
        ).provider_task_id,
        'provider-task-original',
      );
    }
    assert.equal(budgetService.getBudgetSummary(db, NOW).dailyUsedMicros, 2_000_000);
  } finally {
    db.close();
  }
});

test('result and artifact unknown states reject mismatched or missing accepted task ids', () => {
  const db = createDb();
  try {
    for (const [index, state] of ['result_unknown', 'artifact_unreadable'].entries()) {
      const mismatchId = `task-mismatch-${index}`;
      reserveRun(db, { id: mismatchId, idempotencyKey: `task-mismatch-key-${index}` });
      budgetService.markSubmitting(db, mismatchId, '2026-08-18T00:00:01.000Z');
      budgetService.markAccepted(
        db, mismatchId, 'provider-task-original', '2026-08-18T00:00:02.000Z',
      );
      expectCode(
        () => budgetService.settleUnknown(
          db, mismatchId, state, `${state}_category`, 'provider-task-different',
          '2026-08-18T00:00:03.000Z',
        ),
        'PROVIDER_CANARY_TASK_ID_MISMATCH',
      );
      assert.deepEqual(
        db.prepare(`SELECT state, provider_task_id, actual_cost_micros
          FROM provider_canary_runs WHERE id = ?`).get(mismatchId),
        { state: 'accepted', provider_task_id: 'provider-task-original', actual_cost_micros: null },
      );

      const missingId = `task-missing-${index}`;
      reserveRun(db, { id: missingId, idempotencyKey: `task-missing-key-${index}` });
      budgetService.markSubmitting(db, missingId, '2026-08-18T00:00:01.000Z');
      db.prepare(`UPDATE provider_canary_runs
        SET state = 'accepted', provider_task_id = NULL WHERE id = ?`).run(missingId);
      expectCode(
        () => budgetService.settleUnknown(
          db, missingId, state, `${state}_category`, null, '2026-08-18T00:00:03.000Z',
        ),
        'PROVIDER_CANARY_TASK_ID_REQUIRED',
      );
    }
  } finally {
    db.close();
  }
});

test('submission unknown never clears or replaces an existing database task id', () => {
  const db = createDb();
  try {
    reserveRun(db, { id: 'submission-preserve', idempotencyKey: 'submission-preserve-key' });
    budgetService.markSubmitting(db, 'submission-preserve', '2026-08-18T00:00:01.000Z');
    db.prepare(`UPDATE provider_canary_runs SET provider_task_id = 'provider-task-original'
      WHERE id = 'submission-preserve'`).run();
    const unknown = budgetService.settleUnknown(
      db, 'submission-preserve', 'submission_unknown', 'submission_timeout', null,
      '2026-08-18T00:00:02.000Z',
    );
    assert.equal(unknown.provider_task_id, 'provider-task-original');
    assert.equal(unknown.actual_cost_micros, null);

    reserveRun(db, { id: 'submission-mismatch', idempotencyKey: 'submission-mismatch-key' });
    budgetService.markSubmitting(db, 'submission-mismatch', '2026-08-18T00:00:01.000Z');
    db.prepare(`UPDATE provider_canary_runs SET provider_task_id = 'provider-task-original'
      WHERE id = 'submission-mismatch'`).run();
    expectCode(
      () => budgetService.settleUnknown(
        db, 'submission-mismatch', 'submission_unknown', 'submission_timeout',
        'provider-task-different', '2026-08-18T00:00:02.000Z',
      ),
      'PROVIDER_CANARY_TASK_ID_MISMATCH',
    );
    assert.equal(
      db.prepare(`SELECT provider_task_id FROM provider_canary_runs
        WHERE id = 'submission-mismatch'`).get().provider_task_id,
      'provider-task-original',
    );
  } finally {
    db.close();
  }
});

test('budget usage is state-aware and fails safe for abnormal terminal rows', () => {
  const db = createDb();
  try {
    const rows = [
      ['reserved', 5, 1],
      ['submitting', 6, 2],
      ['accepted', 7, 3],
      ['verifying', 8, 4],
      ['submission_unknown', 9, 1],
      ['result_unknown', 10, 1],
      ['artifact_unreadable', 11, 1],
      ['succeeded', 100, 12],
      ['failed', 100, 13],
      ['succeeded', 14, null],
      ['failed', 15, null],
      ['budget_blocked', 200, null],
      ['budget_blocked', 200, 16],
    ];
    rows.forEach(([state, reserved, actual], index) => insertHistoricalRun(db, {
      id: `usage-run-${index}`,
      idempotency_key: `usage-key-${index}`,
      capability_fingerprint: `usage-capability-${index}`,
      state,
      reserved_cost_micros: reserved,
      actual_cost_micros: actual,
      budget_day: '2026-08-18',
      created_at: NOW,
      updated_at: NOW,
    }));
    const summary = budgetService.getBudgetSummary(db, NOW);
    assert.equal(summary.dailyUsedMicros, 126);
    assert.equal(summary.monthlyUsedMicros, 126);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM provider_canary_runs
      WHERE state = 'budget_blocked' AND actual_cost_micros IS NULL`).get().count, 1);
  } finally {
    db.close();
  }
});

test('reserve checks state-aware settled usage instead of stale reservation amounts', () => {
  const db = createDb();
  try {
    insertHistoricalRun(db, {
      state: 'succeeded',
      reserved_cost_micros: 20_000_000,
      actual_cost_micros: 0,
      budget_day: '2026-08-18',
    });
    reserveRun(db, { reservedCostMicros: 20_000_000 });
    expectCode(
      () => reserveRun(db, { id: 'state-aware-next', idempotencyKey: 'state-aware-next-key', reservedCostMicros: 1 }),
      'PROVIDER_CANARY_DAILY_BUDGET_EXCEEDED',
    );
  } finally {
    db.close();
  }
});

test('Asia/Shanghai buckets cross UTC 16:00 and summaries leave old unknown runs unchanged', () => {
  const db = createDb();
  try {
    reserveRun(db, {
      id: 'july-run', idempotencyKey: 'july-key', reservedCostMicros: 1_000_000,
      now: '2026-07-31T15:59:59.999Z',
    });
    budgetService.markSubmitting(db, 'july-run', '2026-07-31T15:59:59.999Z');
    budgetService.settleUnknown(
      db, 'july-run', 'submission_unknown', 'submission_timeout', null, '2026-07-31T15:59:59.999Z',
    );
    reserveRun(db, {
      id: 'august-run', idempotencyKey: 'august-key', reservedCostMicros: 2_000_000,
      now: '2026-07-31T16:00:00.000Z',
    });

    assert.deepEqual(
      db.prepare('SELECT id, budget_day, budget_month FROM provider_canary_runs ORDER BY id').all(),
      [
        { id: 'august-run', budget_day: '2026-08-01', budget_month: '2026-08' },
        { id: 'july-run', budget_day: '2026-07-31', budget_month: '2026-07' },
      ],
    );
    const july = budgetService.getBudgetSummary(db, '2026-07-31T15:59:59.999Z');
    const august = budgetService.getBudgetSummary(db, '2026-07-31T16:00:00.000Z');
    assert.deepEqual([july.budgetDay, july.budgetMonth, july.dailyUsedMicros, july.monthlyUsedMicros],
      ['2026-07-31', '2026-07', 1_000_000, 1_000_000]);
    assert.deepEqual([august.budgetDay, august.budgetMonth, august.dailyUsedMicros, august.monthlyUsedMicros],
      ['2026-08-01', '2026-08', 2_000_000, 2_000_000]);
    assert.deepEqual(
      db.prepare(`SELECT state, actual_cost_micros, finished_at
        FROM provider_canary_runs WHERE id = 'july-run'`).get(),
      { state: 'submission_unknown', actual_cost_micros: null, finished_at: '2026-07-31T15:59:59.999Z' },
    );
    expectCode(() => budgetService.getBudgetSummary(db, 'invalid'), 'PROVIDER_CANARY_INVALID_INPUT');
  } finally {
    db.close();
  }
});

test('environment limits clamp upward values, accept exact decimals, and fail closed malformed values', () => {
  const hard = budgetService.resolveBudgetLimits({
    PROVIDER_CANARY_DAILY_BUDGET_CNY: '21',
    PROVIDER_CANARY_MONTHLY_BUDGET_CNY: '601',
  });
  assert.deepEqual(hard, {
    hardDailyLimitMicros: 20_000_000,
    hardMonthlyLimitMicros: 600_000_000,
    effectiveDailyLimitMicros: 20_000_000,
    effectiveMonthlyLimitMicros: 600_000_000,
  });
  assert.deepEqual(
    budgetService.resolveBudgetLimits({
      PROVIDER_CANARY_DAILY_BUDGET_CNY: '1.234567',
      PROVIDER_CANARY_MONTHLY_BUDGET_CNY: '20.000001',
    }),
    {
      hardDailyLimitMicros: 20_000_000,
      hardMonthlyLimitMicros: 600_000_000,
      effectiveDailyLimitMicros: 1_234_567,
      effectiveMonthlyLimitMicros: 20_000_001,
    },
  );
  assert.equal(
    budgetService.resolveBudgetLimits({ PROVIDER_CANARY_DAILY_BUDGET_CNY: '0' }).effectiveDailyLimitMicros,
    0,
  );
  for (const env of [
    {},
    null,
    { PROVIDER_CANARY_DAILY_BUDGET_CNY: null },
    { PROVIDER_CANARY_DAILY_BUDGET_CNY: '' },
  ]) {
    assert.equal(budgetService.resolveBudgetLimits(env).effectiveDailyLimitMicros, 20_000_000);
  }
  for (const value of [
    'NaN', '-1', '1.0000001', '1e1', ' ', '+1',
    '9007199254740992', '9'.repeat(100),
  ]) {
    assert.equal(
      budgetService.resolveBudgetLimits({ PROVIDER_CANARY_DAILY_BUDGET_CNY: value }).effectiveDailyLimitMicros,
      0,
      value,
    );
  }
});

test('malformed explicit environment budget is visible in summary and closes reserve', () => {
  const previous = process.env.PROVIDER_CANARY_DAILY_BUDGET_CNY;
  const db = createDb();
  try {
    process.env.PROVIDER_CANARY_DAILY_BUDGET_CNY = 'NaN';
    const summary = budgetService.getBudgetSummary(db, NOW);
    assert.equal(summary.hardDailyLimitMicros, 20_000_000);
    assert.equal(summary.effectiveDailyLimitMicros, 0);
    assert.equal(summary.dailyRemainingMicros, 0);
    expectCode(() => reserveRun(db), 'PROVIDER_CANARY_DAILY_BUDGET_EXCEEDED');
  } finally {
    if (previous === undefined) delete process.env.PROVIDER_CANARY_DAILY_BUDGET_CNY;
    else process.env.PROVIDER_CANARY_DAILY_BUDGET_CNY = previous;
    db.close();
  }
});

test('budget writes are isolated from user ledgers and business generation records', () => {
  const db = createDb();
  try {
    const protectedTables = [
      'credit_ledger',
      'tenant_credit_ledger',
      'image_generations',
      'video_generations',
      'async_tasks',
      'generation_route_requests',
      'generation_route_attempts',
    ];
    const before = Object.fromEntries(protectedTables.map((table) => [
      table,
      db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
    ]));
    reserveRun(db);
    budgetService.settleDefinitiveFailure(db, 'run-1', 0, 'pre_submit_failure', NOW);
    const after = Object.fromEntries(protectedTables.map((table) => [
      table,
      db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
    ]));
    assert.deepEqual(after, before);
  } finally {
    db.close();
  }
});

test('exported hard limits are integer CNY micros', () => {
  assert.equal(budgetService.HARD_DAILY_BUDGET_MICROS, 20_000_000);
  assert.equal(budgetService.HARD_MONTHLY_BUDGET_MICROS, 600_000_000);
  assert.equal(Number.isSafeInteger(budgetService.HARD_DAILY_BUDGET_MICROS), true);
  assert.equal(Number.isSafeInteger(budgetService.HARD_MONTHLY_BUDGET_MICROS), true);
});
