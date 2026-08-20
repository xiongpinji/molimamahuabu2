'use strict';

const HARD_DAILY_BUDGET_MICROS = 20_000_000;
const HARD_MONTHLY_BUDGET_MICROS = 600_000_000;
const SHANGHAI_OFFSET_MILLIS = 8 * 60 * 60 * 1000;
const UNKNOWN_STATES = new Set([
  'submission_unknown',
  'result_unknown',
  'artifact_unreadable',
]);
const ACTIVE_STATES = new Set(['reserved', 'submitting', 'accepted', 'verifying']);

function serviceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function invalidInput(message) {
  return serviceError('PROVIDER_CANARY_INVALID_INPUT', message);
}

function requireString(value, name, maxLength = 512) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw invalidInput(`${name} must be a non-empty safe string`);
  }
  return value;
}

function requirePositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidInput(`${name} must be a positive safe integer`);
  }
  return value;
}

function requireNonNegativeSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidInput(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function requireIsoTime(value) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw invalidInput('now must be a canonical UTC ISO timestamp');
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw invalidInput('now must be a valid UTC ISO timestamp');
  }
  return date;
}

function budgetBuckets(now) {
  const date = requireIsoTime(now);
  const shanghai = new Date(date.getTime() + SHANGHAI_OFFSET_MILLIS);
  if (!Number.isFinite(shanghai.getTime())) {
    throw invalidInput('now is outside the supported range');
  }
  const budgetDay = shanghai.toISOString().slice(0, 10);
  return { budgetDay, budgetMonth: budgetDay.slice(0, 7) };
}

function parseCnyMicros(value, hardLimit) {
  if (value === undefined || value === null || value === '') return hardLimit;
  if (typeof value !== 'string' || value.length > 64) return 0;
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) return 0;
  const fractional = (match[2] || '').padEnd(6, '0');
  const micros = (BigInt(match[1]) * 1_000_000n) + BigInt(fractional || '0');
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) return 0;
  const hard = BigInt(hardLimit);
  return Number(micros > hard ? hard : micros);
}

function resolveBudgetLimits(env = {}) {
  const source = env && typeof env === 'object' ? env : {};
  return {
    hardDailyLimitMicros: HARD_DAILY_BUDGET_MICROS,
    hardMonthlyLimitMicros: HARD_MONTHLY_BUDGET_MICROS,
    effectiveDailyLimitMicros: parseCnyMicros(
      source.PROVIDER_CANARY_DAILY_BUDGET_CNY,
      HARD_DAILY_BUDGET_MICROS,
    ),
    effectiveMonthlyLimitMicros: parseCnyMicros(
      source.PROVIDER_CANARY_MONTHLY_BUDGET_CNY,
      HARD_MONTHLY_BUDGET_MICROS,
    ),
  };
}

function requireCategory(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) {
    throw invalidInput('category must be a safe identifier');
  }
  return value;
}

function getRun(db, runId) {
  const row = db.prepare('SELECT * FROM provider_canary_runs WHERE id = ?').get(runId);
  if (!row) {
    throw serviceError('PROVIDER_CANARY_RUN_NOT_FOUND', 'provider canary run not found');
  }
  return row;
}

function invalidTransition() {
  return serviceError(
    'PROVIDER_CANARY_INVALID_STATE_TRANSITION',
    'invalid provider canary run state transition',
  );
}

function runImmediate(db, work) {
  if (db.inTransaction) return work();
  return db.transaction(work).immediate();
}

function normalizeReserveInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidInput('input must be an object');
  }
  if (!input.route || typeof input.route !== 'object' || Array.isArray(input.route)) {
    throw invalidInput('route must be an object');
  }
  const route = input.route;
  const { budgetDay, budgetMonth } = budgetBuckets(input.now);
  if (input.currency !== 'CNY') {
    throw invalidInput('currency must be CNY');
  }
  return {
    id: requireString(input.id, 'id', 255),
    idempotency_key: requireString(input.idempotencyKey, 'idempotencyKey', 255),
    config_id: requirePositiveSafeInteger(route.configId, 'route.configId'),
    logical_model_id: requireString(route.logicalModelId, 'route.logicalModelId'),
    service_type: requireString(route.serviceType, 'route.serviceType'),
    capability_fingerprint: requireString(
      route.capabilityFingerprint,
      'route.capabilityFingerprint',
    ),
    config_fingerprint: requireString(route.configFingerprint, 'route.configFingerprint'),
    cost_fingerprint: requireString(route.costFingerprint, 'route.costFingerprint'),
    runtime_fingerprint: requireString(route.runtimeFingerprint, 'route.runtimeFingerprint'),
    provider_scope_key: requireString(route.providerScopeKey, 'route.providerScopeKey'),
    reserved_cost_micros: requirePositiveSafeInteger(
      input.reservedCostMicros,
      'reservedCostMicros',
    ),
    currency: input.currency,
    budget_day: budgetDay,
    budget_month: budgetMonth,
    created_at: input.now,
    updated_at: input.now,
  };
}

function usageFor(db, column, bucket) {
  return db.prepare(`SELECT COALESCE(SUM(
      CASE
        WHEN state = 'budget_blocked' THEN COALESCE(actual_cost_micros, 0)
        WHEN state IN ('succeeded', 'failed')
          THEN COALESCE(actual_cost_micros, reserved_cost_micros)
        ELSE reserved_cost_micros
      END
    ), 0) AS used
    FROM provider_canary_runs
    WHERE ${column} = ?`).get(bucket).used;
}

function reservationMatches(row, values) {
  return [
    'id',
    'config_id',
    'logical_model_id',
    'service_type',
    'capability_fingerprint',
    'config_fingerprint',
    'cost_fingerprint',
    'runtime_fingerprint',
    'provider_scope_key',
    'reserved_cost_micros',
    'currency',
    'budget_day',
    'budget_month',
  ].every((field) => row[field] === values[field]);
}

function reserve(db, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidInput('input must be an object');
  }
  const idempotencyKey = requireString(input.idempotencyKey, 'idempotencyKey', 255);
  const transaction = db.transaction(() => {
    const existing = db.prepare(
      'SELECT * FROM provider_canary_runs WHERE idempotency_key = ?',
    ).get(idempotencyKey);
    const values = normalizeReserveInput(input);
    if (existing) {
      if (!reservationMatches(existing, values)) {
        throw serviceError(
          'PROVIDER_CANARY_IDEMPOTENCY_CONFLICT',
          'provider canary idempotency key conflicts with an existing reservation',
        );
      }
      return existing;
    }
    const limits = resolveBudgetLimits(process.env);
    const dailyUsed = usageFor(db, 'budget_day', values.budget_day);
    if (dailyUsed + values.reserved_cost_micros > limits.effectiveDailyLimitMicros) {
      throw serviceError(
        'PROVIDER_CANARY_DAILY_BUDGET_EXCEEDED',
        'provider canary daily budget exceeded',
      );
    }
    const monthlyUsed = usageFor(db, 'budget_month', values.budget_month);
    if (monthlyUsed + values.reserved_cost_micros > limits.effectiveMonthlyLimitMicros) {
      throw serviceError(
        'PROVIDER_CANARY_MONTHLY_BUDGET_EXCEEDED',
        'provider canary monthly budget exceeded',
      );
    }

    db.prepare(`INSERT INTO provider_canary_runs
      (id, idempotency_key, config_id, logical_model_id, service_type,
       capability_fingerprint, config_fingerprint, cost_fingerprint,
       runtime_fingerprint, provider_scope_key, state, reserved_cost_micros,
       currency, budget_day, budget_month, created_at, updated_at)
      VALUES (@id, @idempotency_key, @config_id, @logical_model_id, @service_type,
       @capability_fingerprint, @config_fingerprint, @cost_fingerprint,
       @runtime_fingerprint, @provider_scope_key, 'reserved', @reserved_cost_micros,
       @currency, @budget_day, @budget_month, @created_at, @updated_at)`)
      .run(values);
    return getRun(db, values.id);
  });
  return transaction.immediate();
}

function markSubmitting(db, runId, now) {
  const id = requireString(runId, 'runId', 255);
  requireIsoTime(now);
  const transaction = db.transaction(() => {
    const row = getRun(db, id);
    if (row.state === 'submitting'
      && row.provider_task_id === null
      && row.error_category === null) return row;
    if (row.state !== 'reserved') throw invalidTransition();
    const result = db.prepare(`UPDATE provider_canary_runs
      SET state = 'submitting', submitted_at = ?, updated_at = ?
      WHERE id = ? AND state = 'reserved'`).run(now, now, id);
    if (result.changes !== 1) {
      const current = getRun(db, id);
      if (current.state === 'submitting'
        && current.provider_task_id === null
        && current.error_category === null) return current;
      throw invalidTransition();
    }
    return getRun(db, id);
  });
  return transaction.immediate();
}

function claimForExecution(db, runId, now) {
  const id = requireString(runId, 'runId', 255);
  requireIsoTime(now);
  return runImmediate(db, () => {
    const row = getRun(db, id);
    if (row.state !== 'reserved') {
      throw serviceError(
        'PROVIDER_CANARY_EXECUTION_NOT_CLAIMED',
        'provider canary execution was not claimed',
      );
    }
    const blocked = db.prepare(`SELECT id FROM provider_canary_runs
      WHERE provider_scope_key = ? AND id <> ?
        AND state IN ('submission_unknown', 'result_unknown', 'artifact_unreadable')
      ORDER BY created_at, id LIMIT 1`).get(row.provider_scope_key, id);
    if (blocked) {
      throw serviceError(
        'PROVIDER_CANARY_SCOPE_BLOCKED',
        'provider scope has an unresolved canary result',
      );
    }
    const result = db.prepare(`UPDATE provider_canary_runs
      SET state = 'submitting', submitted_at = ?, updated_at = ?
      WHERE id = ? AND state = 'reserved'`).run(now, now, id);
    if (result.changes !== 1) {
      throw serviceError(
        'PROVIDER_CANARY_EXECUTION_NOT_CLAIMED',
        'provider canary execution was not claimed',
      );
    }
    return { executionOwner: true, run: getRun(db, id) };
  });
}

function markAccepted(db, runId, providerTaskId, now) {
  const id = requireString(runId, 'runId', 255);
  const taskId = requireString(providerTaskId, 'providerTaskId', 512);
  requireIsoTime(now);
  const transaction = db.transaction(() => {
    const row = getRun(db, id);
    if (row.state === 'accepted'
      && row.provider_task_id === taskId
      && row.error_category === null) return row;
    if (row.state !== 'submitting') throw invalidTransition();
    const result = db.prepare(`UPDATE provider_canary_runs
      SET state = 'accepted', provider_task_id = ?, updated_at = ?
      WHERE id = ? AND state = 'submitting'`).run(taskId, now, id);
    if (result.changes !== 1) {
      const current = getRun(db, id);
      if (current.state === 'accepted'
        && current.provider_task_id === taskId
        && current.error_category === null) return current;
      throw invalidTransition();
    }
    return getRun(db, id);
  });
  return transaction.immediate();
}

function normalizeArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw invalidInput('artifact must contain path, sha256, and bytes');
  }
  const keys = Object.keys(artifact).sort();
  if (keys.length !== 3 || keys[0] !== 'bytes' || keys[1] !== 'path' || keys[2] !== 'sha256') {
    throw invalidInput('artifact accepts only path, sha256, and bytes');
  }
  const sha256 = requireString(artifact.sha256, 'artifact.sha256', 64);
  if (!/^[a-fA-F0-9]{64}$/.test(sha256)) {
    throw invalidInput('artifact.sha256 must be a SHA-256 hex digest');
  }
  return {
    path: requireString(artifact.path, 'artifact.path', 4096),
    sha256: sha256.toLowerCase(),
    bytes: requireNonNegativeSafeInteger(artifact.bytes, 'artifact.bytes'),
  };
}

function recordOverrunEvent(db, row, actualCostMicros, now) {
  const existing = db.prepare(`SELECT 1 FROM provider_stability_events
    WHERE request_id = ? AND event_type = 'provider_canary_cost_overrun'`).get(row.id);
  if (existing) return;
  const safeDetails = JSON.stringify({
    runId: row.id,
    logicalModelId: row.logical_model_id,
    reservedCostMicros: row.reserved_cost_micros,
    actualCostMicros,
  });
  db.prepare(`INSERT INTO provider_stability_events
    (severity, event_type, request_id, logical_model_id, config_id, task_state,
     safe_details, created_at)
    VALUES ('error', 'provider_canary_cost_overrun', ?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.logical_model_id, row.config_id, row.state, safeDetails, now);
}

function runSettlement(db, runId, actualCostMicros, now, settle) {
  const result = runImmediate(db, () => {
    const row = getRun(db, runId);
    const idempotent = settle.idempotent(row);
    if (idempotent) return { row };
    if (!ACTIVE_STATES.has(row.state) || !settle.allowedStates.has(row.state)) {
      throw invalidTransition();
    }
    if (actualCostMicros > row.reserved_cost_micros) {
      recordOverrunEvent(db, row, actualCostMicros, now);
      return { overrun: true };
    }
    settle.update(row);
    return { row: getRun(db, runId) };
  });
  if (result.overrun) {
    throw serviceError(
      'PROVIDER_CANARY_COST_OVERRUN',
      'provider canary actual cost exceeded its reservation',
    );
  }
  return result.row;
}

function settleSuccess(db, runId, actualCostMicros, artifact, now) {
  const id = requireString(runId, 'runId', 255);
  const actual = requireNonNegativeSafeInteger(actualCostMicros, 'actualCostMicros');
  const normalizedArtifact = normalizeArtifact(artifact);
  requireIsoTime(now);
  return runSettlement(db, id, actual, now, {
    allowedStates: new Set(['accepted', 'verifying']),
    idempotent(row) {
      if (row.state !== 'succeeded') return false;
      if (row.actual_cost_micros === actual
        && row.artifact_path === normalizedArtifact.path
        && row.artifact_sha256 === normalizedArtifact.sha256
        && row.artifact_bytes === normalizedArtifact.bytes) {
        return true;
      }
      throw invalidTransition();
    },
    update() {
      db.prepare(`UPDATE provider_canary_runs
        SET state = 'succeeded', actual_cost_micros = ?, artifact_path = ?,
          artifact_sha256 = ?, artifact_bytes = ?, finished_at = ?, updated_at = ?
        WHERE id = ?`)
        .run(
          actual,
          normalizedArtifact.path,
          normalizedArtifact.sha256,
          normalizedArtifact.bytes,
          now,
          now,
          id,
        );
    },
  });
}

function settleDefinitiveFailure(db, runId, actualCostMicros, category, now) {
  const id = requireString(runId, 'runId', 255);
  const actual = requireNonNegativeSafeInteger(actualCostMicros, 'actualCostMicros');
  const safeCategory = requireCategory(category);
  requireIsoTime(now);
  return runSettlement(db, id, actual, now, {
    allowedStates: ACTIVE_STATES,
    idempotent(row) {
      if (row.state !== 'failed') return false;
      if (row.actual_cost_micros === actual && row.error_category === safeCategory) return true;
      throw invalidTransition();
    },
    update() {
      db.prepare(`UPDATE provider_canary_runs
        SET state = 'failed', actual_cost_micros = ?, error_category = ?,
          finished_at = ?, updated_at = ?
        WHERE id = ?`).run(actual, safeCategory, now, now, id);
    },
  });
}

function optionalTaskId(value) {
  if (value === null || value === undefined || value === '') return null;
  return requireString(value, 'providerTaskId', 512);
}

function taskIdForUnknown(row, state, requestedTaskId) {
  const storedTaskId = typeof row.provider_task_id === 'string'
    && row.provider_task_id.trim().length > 0
    ? row.provider_task_id
    : null;
  if (state !== 'submission_unknown' && storedTaskId === null) {
    throw serviceError(
      'PROVIDER_CANARY_TASK_ID_REQUIRED',
      'accepted provider canary run requires a provider task id',
    );
  }
  if (storedTaskId !== null) {
    if (requestedTaskId !== null && requestedTaskId !== storedTaskId) {
      throw serviceError(
        'PROVIDER_CANARY_TASK_ID_MISMATCH',
        'provider canary task id does not match the stored task id',
      );
    }
    return storedTaskId;
  }
  return requestedTaskId;
}

function settleUnknown(db, runId, state, category, providerTaskId, now) {
  const id = requireString(runId, 'runId', 255);
  if (!UNKNOWN_STATES.has(state)) {
    throw invalidInput('state must be a supported unknown terminal state');
  }
  const safeCategory = requireCategory(category);
  const requestedTaskId = optionalTaskId(providerTaskId);
  requireIsoTime(now);
  return runImmediate(db, () => {
    const row = getRun(db, id);
    if (row.state === state) {
      const replayTaskId = taskIdForUnknown(row, state, requestedTaskId);
      if (row.error_category === safeCategory && row.provider_task_id === replayTaskId) return row;
      throw invalidTransition();
    }
    const allowedOrigins = state === 'submission_unknown'
      ? new Set(['submitting'])
      : new Set(['accepted', 'verifying']);
    if (!allowedOrigins.has(row.state)) throw invalidTransition();
    const taskId = taskIdForUnknown(row, state, requestedTaskId);
    const result = db.prepare(`UPDATE provider_canary_runs
      SET state = ?, error_category = ?, provider_task_id = ?,
        finished_at = ?, updated_at = ?
      WHERE id = ? AND state = ?`)
      .run(state, safeCategory, taskId, now, now, id, row.state);
    if (result.changes !== 1) {
      const current = getRun(db, id);
      if (current.state === state) {
        const replayTaskId = taskIdForUnknown(current, state, requestedTaskId);
        if (current.error_category === safeCategory
          && current.provider_task_id === replayTaskId) return current;
      }
      throw invalidTransition();
    }
    return getRun(db, id);
  });
}

function getBudgetSummary(db, now) {
  const { budgetDay, budgetMonth } = budgetBuckets(now);
  const limits = resolveBudgetLimits(process.env);
  const dailyUsedMicros = usageFor(db, 'budget_day', budgetDay);
  const monthlyUsedMicros = usageFor(db, 'budget_month', budgetMonth);
  return {
    budgetDay,
    budgetMonth,
    ...limits,
    dailyUsedMicros,
    monthlyUsedMicros,
    dailyRemainingMicros: Math.max(0, limits.effectiveDailyLimitMicros - dailyUsedMicros),
    monthlyRemainingMicros: Math.max(0, limits.effectiveMonthlyLimitMicros - monthlyUsedMicros),
  };
}

module.exports = {
  HARD_DAILY_BUDGET_MICROS,
  HARD_MONTHLY_BUDGET_MICROS,
  reserve,
  markSubmitting,
  claimForExecution,
  markAccepted,
  settleSuccess,
  settleDefinitiveFailure,
  settleUnknown,
  getBudgetSummary,
  resolveBudgetLimits,
};
