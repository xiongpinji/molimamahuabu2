'use strict';

const crypto = require('node:crypto');

const BLOCKERS = [
  'missing_logical_model_id',
  'missing_user_price',
  'missing_cost',
  'cost_not_positive',
  'missing_capabilities',
  'legacy_connection_only_verification',
  'admin_paused',
];

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function parseModels(value) {
  if (value == null || value === '') return [];
  try {
    const parsed = JSON.parse(value);
    return (Array.isArray(parsed) ? parsed : [parsed])
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  } catch (_) {
    return [String(value).trim()].filter(Boolean);
  }
}

function nonEmptyObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length > 0;
}

function capabilitiesDeclared(config) {
  const settings = parseObject(config.settings);
  return nonEmptyObject(settings.canvas_capabilities)
    || nonEmptyObject(settings.canvas_capabilities_by_model);
}

function sanitizeRouteRef(config) {
  const origin = new URL(String(config.base_url || '')).origin;
  return crypto.createHash('sha256')
    .update(`${String(config.provider || '')}\n${origin}\n${String(config.id)}`)
    .digest('hex')
    .slice(0, 16);
}

function routeModel(config) {
  return String(config.logical_model_id || '').trim()
    || String(config.default_model || '').trim()
    || parseModels(config.model)[0]
    || '';
}

function costStatus(price, resolutionCosts) {
  if (!price) return 'missing';
  const values = [
    price.cost_micros_per_unit,
    price.input_cost_micros_per_1k,
    price.output_cost_micros_per_1k,
    ...resolutionCosts,
  ];
  if (values.every((value) => value == null)) return 'missing';
  return values.some((value) => Number(value) > 0) ? 'positive' : 'not_positive';
}

function buildCanaryReadiness(db, options = {}) {
  const configs = db.prepare(`SELECT id, service_type, provider, base_url, model, default_model,
      priority, is_active, settings, logical_model_id, verification_status,
      updated_at
    FROM ai_service_configs
    WHERE deleted_at IS NULL
    ORDER BY priority DESC, id ASC`).all();
  const prices = db.prepare(`SELECT model, credits, status, cost_micros_per_unit,
      input_cost_micros_per_1k, output_cost_micros_per_1k, updated_at
    FROM model_credit_prices
    ORDER BY model COLLATE NOCASE`).all();
  const hasResolutionPrices = db.prepare(`SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = 'model_resolution_prices'`).get();
  const resolutionPrices = hasResolutionPrices
    ? db.prepare(`SELECT model, cost_micros_per_second, updated_at
      FROM model_resolution_prices
      ORDER BY model COLLATE NOCASE, resolution`).all()
    : [];
  const priceByModel = new Map(prices.map((price) => [String(price.model).toLowerCase(), price]));
  const resolutionCostsByModel = new Map();
  for (const tier of resolutionPrices) {
    const key = String(tier.model).toLowerCase();
    const costs = resolutionCostsByModel.get(key) || [];
    costs.push(tier.cost_micros_per_second);
    resolutionCostsByModel.set(key, costs);
  }
  const runtimeFingerprints = options.runtimeFingerprints || {};

  const routes = configs.map((config) => {
    const logicalModelId = String(config.logical_model_id || '').trim() || null;
    const modelKey = routeModel(config).toLowerCase();
    const price = priceByModel.get(modelKey) || null;
    const userPriceStatus = price
      && price.status === 'enabled'
      && Number.isSafeInteger(price.credits)
      && price.credits > 0
      ? 'configured'
      : 'missing';
    const routeCostStatus = costStatus(price, resolutionCostsByModel.get(modelKey) || []);
    const declared = capabilitiesDeclared(config);
    const checks = {
      missing_logical_model_id: !logicalModelId,
      missing_user_price: userPriceStatus !== 'configured',
      missing_cost: routeCostStatus === 'missing',
      cost_not_positive: routeCostStatus === 'not_positive',
      missing_capabilities: !declared,
      legacy_connection_only_verification: config.verification_status !== 'verified',
      admin_paused: config.is_active !== 1,
    };
    return {
      route_ref: sanitizeRouteRef(config),
      logical_model_id: logicalModelId,
      service_type: String(config.service_type || '').trim().toLowerCase(),
      capabilities_declared: declared,
      user_price_status: userPriceStatus,
      cost_status: routeCostStatus,
      priority: Number.isSafeInteger(config.priority) ? config.priority : 0,
      runtime_fingerprint: runtimeFingerprints[config.service_type] || null,
      blockers: BLOCKERS.filter((blocker) => checks[blocker]),
    };
  });
  const timestamps = [...configs, ...prices, ...resolutionPrices]
    .map((row) => String(row.updated_at || '').trim())
    .filter(Boolean)
    .sort();

  return {
    schema_version: 1,
    evidence_scope: 'local_fixture',
    evidence_source: 'deterministic_test_fixture',
    generated_at: options.now || timestamps.at(-1) || null,
    summary: {
      total_routes: routes.length,
      public_routes: configs.filter((config) => config.is_active === 1).length,
      ready_for_paid_canary: routes.filter((route) => route.blockers.length === 0).length,
      blocked_routes: routes.filter((route) => route.blockers.length > 0).length,
    },
    routes,
  };
}

module.exports = {
  BLOCKERS,
  buildCanaryReadiness,
  sanitizeRouteRef,
};
