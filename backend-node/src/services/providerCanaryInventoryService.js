'use strict';

const crypto = require('node:crypto');

const BLOCKERS = [
  'missing_logical_model_id',
  'missing_user_price',
  'missing_cost',
  'cost_not_positive',
  'missing_capabilities',
  'missing_runtime_mapping',
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
  let origin = 'invalid-origin';
  try {
    const parsed = new URL(String(config.base_url || ''));
    if (parsed.origin !== 'null') origin = parsed.origin;
  } catch (_) {}
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
    price.micros_per_unit ?? price.cost_micros_per_unit,
    price.input_cost_micros_per_1k,
    price.output_cost_micros_per_1k,
    ...resolutionCosts,
  ];
  if (values.every((value) => value == null)) return 'missing';
  return values.some((value) => Number(value) > 0) ? 'positive' : 'not_positive';
}

function tableColumns(db, table) {
  const exists = db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = ?`).get(table);
  if (!exists) return null;
  return new Set(db.prepare(`PRAGMA table_info("${table}")`).all()
    .map((column) => column.name));
}

function projected(columns, name, fallback = 'NULL') {
  return columns.has(name) ? `"${name}"` : `${fallback} AS "${name}"`;
}

function readConfigs(db) {
  const columns = tableColumns(db, 'ai_service_configs');
  if (!columns) return [];
  const names = [
    'id', 'service_type', 'provider', 'base_url', 'api_protocol', 'model', 'default_model',
    'priority', 'is_active', 'settings', 'logical_model_id', 'verification_status',
    'updated_at',
  ];
  const fallbacks = { priority: '0', is_active: '0' };
  const where = columns.has('deleted_at') ? 'WHERE "deleted_at" IS NULL' : '';
  return db.prepare(`SELECT ${names.map((name) => projected(columns, name, fallbacks[name])).join(', ')}
    FROM ai_service_configs
    ${where}
    ORDER BY priority DESC, id ASC`).all();
}

function readPrices(db) {
  const columns = tableColumns(db, 'model_credit_prices');
  if (!columns) return [];
  const names = [
    'model', 'credits', 'status', 'cost_micros_per_unit',
    'input_cost_micros_per_1k', 'output_cost_micros_per_1k', 'updated_at',
  ];
  return db.prepare(`SELECT ${names.map((name) => projected(columns, name)).join(', ')}
    FROM model_credit_prices
    ORDER BY model COLLATE NOCASE`).all();
}

function readRouteCosts(db) {
  const columns = tableColumns(db, 'provider_route_costs');
  if (!columns) return [];
  const names = [
    'config_id', 'micros_per_unit', 'input_cost_micros_per_1k',
    'output_cost_micros_per_1k', 'updated_at',
  ];
  return db.prepare(`SELECT ${names.map((name) => projected(columns, name)).join(', ')}
    FROM provider_route_costs
    ORDER BY config_id`).all();
}

function readRouteResolutionCosts(db) {
  const columns = tableColumns(db, 'provider_route_resolution_costs');
  if (!columns) return [];
  const names = ['config_id', 'micros_per_unit', 'updated_at'];
  return db.prepare(`SELECT ${names.map((name) => projected(columns, name)).join(', ')}
    FROM provider_route_resolution_costs
    ORDER BY config_id, resolution COLLATE NOCASE`).all();
}

function buildCanaryReadiness(db, options = {}) {
  const configs = readConfigs(db);
  const prices = readPrices(db);
  const routeCosts = readRouteCosts(db);
  const routeResolutionCosts = readRouteResolutionCosts(db);
  const priceByModel = new Map(prices.map((price) => [String(price.model).toLowerCase(), price]));
  const routeCostByConfig = new Map(routeCosts.map((cost) => [cost.config_id, cost]));
  const resolutionCostsByConfig = new Map();
  for (const tier of routeResolutionCosts) {
    const costs = resolutionCostsByConfig.get(tier.config_id) || [];
    costs.push(tier.micros_per_unit);
    resolutionCostsByConfig.set(tier.config_id, costs);
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
    const routeCostStatus = costStatus(
      routeCostByConfig.get(config.id),
      resolutionCostsByConfig.get(config.id) || [],
    );
    const declared = capabilitiesDeclared(config);
    let runtimeFingerprint = null;
    if (typeof options.runtimeFingerprintResolver === 'function') {
      try {
        const resolved = options.runtimeFingerprintResolver(config);
        if (resolved?.ok !== false) {
          if (typeof resolved === 'string') runtimeFingerprint = resolved.trim() || null;
          else if (typeof resolved?.fingerprint === 'string') {
            runtimeFingerprint = resolved.fingerprint.trim() || null;
          }
        }
      } catch (_) {
        runtimeFingerprint = null;
      }
    } else if (Object.prototype.hasOwnProperty.call(runtimeFingerprints, config.service_type)) {
      const resolved = runtimeFingerprints[config.service_type];
      runtimeFingerprint = typeof resolved === 'string' ? resolved.trim() || null : null;
    }
    const checks = {
      missing_logical_model_id: !logicalModelId,
      missing_user_price: userPriceStatus !== 'configured',
      missing_cost: routeCostStatus === 'missing',
      cost_not_positive: routeCostStatus === 'not_positive',
      missing_capabilities: !declared,
      missing_runtime_mapping: !runtimeFingerprint,
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
      runtime_fingerprint: runtimeFingerprint,
      blockers: BLOCKERS.filter((blocker) => checks[blocker]),
    };
  });
  const timestamps = [...configs, ...prices, ...routeCosts, ...routeResolutionCosts]
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
