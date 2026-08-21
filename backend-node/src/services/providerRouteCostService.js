'use strict';

const crypto = require('node:crypto');

const COST_UNITS = new Set(['request', 'image', 'second', 'token']);
const RESOLUTION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;

function costError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function positiveConfigId(value) {
  const configId = Number(value);
  if (!Number.isSafeInteger(configId) || configId <= 0) {
    throw costError('INVALID_PROVIDER_ROUTE_COST', 'configId must be a positive safe integer');
  }
  return configId;
}

function safeNonNegativeInteger(value, name, fallback = 0) {
  const candidate = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw costError('INVALID_PROVIDER_ROUTE_COST', `${name} must be a non-negative safe integer`);
  }
  return candidate;
}

function safePositiveInteger(value, name) {
  const candidate = Number(value);
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw costError('INVALID_PROVIDER_ROUTE_COST', `${name} must be a positive safe integer`);
  }
  return candidate;
}

function safeUsageInteger(value, name, fallback = 0) {
  const candidate = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw costError('INVALID_PROVIDER_ROUTE_USAGE', `${name} must be a non-negative safe integer`);
  }
  return candidate;
}

function normalizeResolution(value) {
  if (value == null || value === '') return null;
  const resolution = String(value).trim().toLowerCase();
  if (!RESOLUTION_PATTERN.test(resolution)) {
    throw costError('INVALID_PROVIDER_ROUTE_COST', 'resolution must be a safe non-empty identifier');
  }
  return resolution;
}

function normalizedNow(value) {
  const now = value == null ? new Date() : new Date(value);
  if (!Number.isFinite(now.getTime())) {
    throw costError('INVALID_PROVIDER_ROUTE_COST', 'now must be a valid timestamp');
  }
  return now.toISOString();
}

function stableSnapshot(snapshot) {
  return {
    schema_version: 1,
    config_id: snapshot.config_id,
    currency: snapshot.currency,
    cost_unit: snapshot.cost_unit,
    micros_per_unit: snapshot.micros_per_unit,
    input_cost_micros_per_1k: snapshot.input_cost_micros_per_1k,
    output_cost_micros_per_1k: snapshot.output_cost_micros_per_1k,
    resolution_prices: Object.fromEntries(
      Object.entries(snapshot.resolution_prices || {}).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

function fingerprintRouteCost(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(stableSnapshot(snapshot))).digest('hex');
}

function getRouteCost(db, configIdValue) {
  const configId = positiveConfigId(configIdValue);
  const row = db.prepare(`SELECT config_id, currency, cost_unit, micros_per_unit,
      input_cost_micros_per_1k, output_cost_micros_per_1k, updated_at
    FROM provider_route_costs WHERE config_id = ?`).get(configId);
  if (!row) return null;
  const resolutionPrices = Object.fromEntries(db.prepare(`SELECT resolution, micros_per_unit
      FROM provider_route_resolution_costs
      WHERE config_id = ? ORDER BY resolution COLLATE NOCASE`)
    .all(configId)
    .map((tier) => [tier.resolution.toLowerCase(), { micros_per_unit: tier.micros_per_unit }]));
  return { ...row, resolution_prices: resolutionPrices };
}

function normalizeResolutionPrices(value) {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw costError('INVALID_PROVIDER_ROUTE_COST', 'resolution_prices must be an object');
  }
  const result = {};
  for (const [key, rawTier] of Object.entries(value)) {
    const resolution = normalizeResolution(key);
    if (Object.prototype.hasOwnProperty.call(result, resolution)) {
      throw costError('INVALID_PROVIDER_ROUTE_COST', 'resolution_prices contain duplicate tiers');
    }
    const rawValue = rawTier && typeof rawTier === 'object'
      ? rawTier.micros_per_unit ?? rawTier.microsPerUnit
      : rawTier;
    result[resolution] = { micros_per_unit: safePositiveInteger(rawValue, 'tier micros_per_unit') };
  }
  return result;
}

function normalizedPayload(configId, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw costError('INVALID_PROVIDER_ROUTE_COST', 'cost payload must be an object');
  }
  const currency = String(input.currency || 'CNY').trim().toUpperCase();
  if (currency !== 'CNY') {
    throw costError('INVALID_PROVIDER_ROUTE_COST', 'currency must be CNY');
  }
  const costUnit = String(input.cost_unit ?? input.costUnit ?? '').trim().toLowerCase();
  if (!COST_UNITS.has(costUnit)) {
    throw costError('INVALID_PROVIDER_ROUTE_COST', 'cost_unit is unsupported');
  }
  const microsPerUnit = safeNonNegativeInteger(
    input.micros_per_unit ?? input.microsPerUnit,
    'micros_per_unit',
  );
  const inputCost = safeNonNegativeInteger(
    input.input_cost_micros_per_1k ?? input.inputCostMicrosPer1k,
    'input_cost_micros_per_1k',
  );
  const outputCost = safeNonNegativeInteger(
    input.output_cost_micros_per_1k ?? input.outputCostMicrosPer1k,
    'output_cost_micros_per_1k',
  );
  if (costUnit === 'token') {
    if (inputCost <= 0 && outputCost <= 0) {
      throw costError('INVALID_PROVIDER_ROUTE_COST', 'token cost must contain a positive rate');
    }
  } else if (microsPerUnit <= 0) {
    throw costError('INVALID_PROVIDER_ROUTE_COST', 'micros_per_unit must be positive');
  }
  return stableSnapshot({
    config_id: configId,
    currency,
    cost_unit: costUnit,
    micros_per_unit: microsPerUnit,
    input_cost_micros_per_1k: inputCost,
    output_cost_micros_per_1k: outputCost,
    resolution_prices: normalizeResolutionPrices(input.resolution_prices ?? input.resolutionPrices),
  });
}

function invalidateEvidence(db, configId, now) {
  try {
    require('./providerCanaryEvidenceService').invalidateConfig(db, configId, 'cost_changed', now);
  } catch (error) {
    if (error?.code !== 'SQLITE_ERROR'
        || !/no such table:\s*provider_canary_evidence\b/i.test(String(error.message || ''))) {
      throw error;
    }
  }
}

function setRouteCost(db, configIdValue, input, options = {}) {
  const configId = positiveConfigId(configIdValue);
  const config = db.prepare(`SELECT id FROM ai_service_configs
    WHERE id = ? AND deleted_at IS NULL`).get(configId);
  if (!config) throw costError('PROVIDER_ROUTE_NOT_FOUND', 'provider route does not exist');
  const snapshot = normalizedPayload(configId, input);
  const now = normalizedNow(options.now);
  let saved;
  const apply = () => {
    const previous = getRouteCost(db, configId);
    db.prepare(`INSERT INTO provider_route_costs
        (config_id, currency, cost_unit, micros_per_unit, input_cost_micros_per_1k,
         output_cost_micros_per_1k, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(config_id) DO UPDATE SET
        currency = excluded.currency,
        cost_unit = excluded.cost_unit,
        micros_per_unit = excluded.micros_per_unit,
        input_cost_micros_per_1k = excluded.input_cost_micros_per_1k,
        output_cost_micros_per_1k = excluded.output_cost_micros_per_1k,
        updated_at = excluded.updated_at`)
      .run(
        configId,
        snapshot.currency,
        snapshot.cost_unit,
        snapshot.micros_per_unit,
        snapshot.input_cost_micros_per_1k,
        snapshot.output_cost_micros_per_1k,
        now,
      );
    db.prepare('DELETE FROM provider_route_resolution_costs WHERE config_id = ?').run(configId);
    const insertTier = db.prepare(`INSERT INTO provider_route_resolution_costs
      (config_id, resolution, micros_per_unit, updated_at) VALUES (?, ?, ?, ?)`);
    for (const [resolution, tier] of Object.entries(snapshot.resolution_prices)) {
      insertTier.run(configId, resolution, tier.micros_per_unit, now);
    }
    saved = getRouteCost(db, configId);
    if (!previous || fingerprintRouteCost(previous) !== fingerprintRouteCost(saved)) {
      invalidateEvidence(db, configId, now);
    }
  };
  if (db.inTransaction) apply();
  else db.transaction(apply)();
  return saved;
}

function requireRouteCost(db, configId) {
  const row = getRouteCost(db, configId);
  if (!row) throw costError('PROVIDER_ROUTE_COST_NOT_CONFIGURED', 'provider route cost is not configured');
  return row;
}

function selectedRate(row, resolution) {
  const tiers = row.resolution_prices || {};
  const tierNames = Object.keys(tiers);
  if (!resolution) return row.micros_per_unit;
  const tier = tiers[resolution];
  if (!tier && tierNames.length > 0) {
    throw costError('PROVIDER_ROUTE_COST_TIER_MISSING', 'provider route cost tier is not configured');
  }
  return tier?.micros_per_unit ?? row.micros_per_unit;
}

function quoteRouteCost(db, usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    throw costError('INVALID_PROVIDER_ROUTE_USAGE', 'usage must be an object');
  }
  const configId = positiveConfigId(usage.configId ?? usage.config_id);
  const row = requireRouteCost(db, configId);
  const resolution = normalizeResolution(usage.resolution);
  const count = safeUsageInteger(usage.count ?? usage.quantity, 'count', 1);
  if (count <= 0) throw costError('INVALID_PROVIDER_ROUTE_USAGE', 'count must be positive');
  const inputTokens = safeUsageInteger(usage.inputTokens ?? usage.input_tokens, 'inputTokens');
  const outputTokens = safeUsageInteger(usage.outputTokens ?? usage.output_tokens, 'outputTokens');
  const reasoningTokens = safeUsageInteger(usage.reasoningTokens ?? usage.reasoning_tokens, 'reasoningTokens');
  let quantity;
  let costMicros;
  if (row.cost_unit === 'request') {
    quantity = 1;
    costMicros = selectedRate(row, resolution);
  } else if (row.cost_unit === 'image') {
    quantity = count;
    costMicros = Math.ceil(quantity * selectedRate(row, resolution));
  } else if (row.cost_unit === 'second') {
    const duration = safeUsageInteger(usage.duration, 'duration');
    if (duration <= 0) throw costError('INVALID_PROVIDER_ROUTE_USAGE', 'duration must be positive');
    quantity = duration * count;
    if (!Number.isSafeInteger(quantity)) {
      throw costError('INVALID_PROVIDER_ROUTE_USAGE', 'quantity exceeds safe integer range');
    }
    costMicros = Math.ceil(quantity * selectedRate(row, resolution));
  } else {
    quantity = 1;
    costMicros = Math.ceil((
      inputTokens * row.input_cost_micros_per_1k
      + outputTokens * row.output_cost_micros_per_1k
    ) / 1000);
  }
  if (!Number.isSafeInteger(costMicros) || costMicros < 0) {
    throw costError('INVALID_PROVIDER_ROUTE_USAGE', 'calculated cost exceeds safe integer range');
  }
  const costSnapshot = stableSnapshot(row);
  return {
    config_id: configId,
    currency: row.currency,
    cost_unit: row.cost_unit,
    quantity,
    cost_micros: costMicros,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: reasoningTokens,
    ...(resolution ? { resolution } : {}),
    cost_source: 'provider_route',
    cost_snapshot: costSnapshot,
    cost_fingerprint: fingerprintRouteCost(costSnapshot),
  };
}

function routeCostCoversCapability(db, configIdValue, capability = {}) {
  try {
    const row = requireRouteCost(db, positiveConfigId(configIdValue));
    const resolution = normalizeResolution(capability.resolution);
    if (resolution && Object.keys(row.resolution_prices || {}).length > 0
        && !row.resolution_prices[resolution]) return false;
    if (row.cost_unit === 'token') {
      return row.input_cost_micros_per_1k > 0 || row.output_cost_micros_per_1k > 0;
    }
    if (selectedRate(row, resolution) <= 0) return false;
    const count = safeUsageInteger(capability.count, 'count', 1);
    if (count <= 0) return false;
    if (row.cost_unit === 'second') {
      return safeUsageInteger(capability.duration, 'duration') > 0;
    }
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  COST_UNITS,
  fingerprintRouteCost,
  getRouteCost,
  quoteRouteCost,
  routeCostCoversCapability,
  setRouteCost,
};
