'use strict';

const crypto = require('node:crypto');
const {
  buildCanaryReadiness,
  sanitizeRouteRef,
} = require('./providerCanaryInventoryService');

const REMEDIATION_ACTIONS = Object.freeze([
  'manual_mapping_required',
  'split_config_required',
  'user_price_required',
  'cost_evidence_required',
  'capability_evidence_required',
  'runtime_mapping_required',
  'generation_evidence_required',
]);

const REQUIRED_SCHEMA = Object.freeze({
  ai_service_configs: Object.freeze([
    'id',
    'service_type',
    'provider',
    'base_url',
    'api_protocol',
    'model',
    'default_model',
    'priority',
    'is_active',
    'settings',
    'logical_model_id',
    'verification_status',
    'updated_at',
    'deleted_at',
  ]),
  model_credit_prices: Object.freeze([
    'model',
    'credits',
    'status',
    'cost_micros_per_unit',
    'input_cost_micros_per_1k',
    'output_cost_micros_per_1k',
    'updated_at',
  ]),
  provider_route_costs: Object.freeze([
    'config_id',
    'micros_per_unit',
    'input_cost_micros_per_1k',
    'output_cost_micros_per_1k',
    'updated_at',
  ]),
  provider_route_resolution_costs: Object.freeze([
    'config_id',
    'resolution',
    'micros_per_unit',
    'updated_at',
  ]),
});

const ACTION_BY_BLOCKER = Object.freeze({
  missing_logical_model_id: 'manual_mapping_required',
  missing_user_price: 'user_price_required',
  missing_cost: 'cost_evidence_required',
  cost_not_positive: 'cost_evidence_required',
  missing_capabilities: 'capability_evidence_required',
  missing_runtime_mapping: 'runtime_mapping_required',
  legacy_connection_only_verification: 'generation_evidence_required',
});

function schemaMismatch() {
  const error = new Error('REMEDIATION_SCHEMA_MISMATCH');
  error.code = 'REMEDIATION_SCHEMA_MISMATCH';
  return error;
}

function tableColumns(db, table) {
  const exists = db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = ?`).get(table);
  if (!exists) return null;
  return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((column) => column.name));
}

function assertRequiredSchema(db) {
  for (const [table, requiredColumns] of Object.entries(REQUIRED_SCHEMA)) {
    const columns = tableColumns(db, table);
    if (!columns || requiredColumns.some((column) => !columns.has(column))) throw schemaMismatch();
  }
}

function readPlanningConfigs(db) {
  return db.prepare(`SELECT id, service_type, provider, base_url, model, default_model,
      priority, is_active,
      logical_model_id, verification_status, updated_at
    FROM ai_service_configs
    WHERE deleted_at IS NULL
    ORDER BY priority DESC, id ASC`).all();
}

function parseModelValues(value) {
  if (value == null || String(value).trim() === '') return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'string') return [parsed];
  } catch (_) {}
  return [value];
}

function distinctModels(config) {
  const values = [
    ...parseModelValues(config.model),
    config.default_model,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  return [...new Set(values)].sort();
}

function actionsFor(route, modelCount) {
  if (modelCount > 1) return ['split_config_required'];
  const actions = [];
  for (const blocker of route.blockers) {
    if (blocker === 'admin_paused') continue;
    const action = ACTION_BY_BLOCKER[blocker];
    if (!action) throw schemaMismatch();
    if (!actions.includes(action)) actions.push(action);
  }
  return REMEDIATION_ACTIONS.filter((action) => actions.includes(action));
}

function expectedFingerprint(config, route, models) {
  return crypto.createHash('sha256').update(JSON.stringify({
    config_id: config.id,
    route_ref: route.route_ref,
    service_type: String(config.service_type || '').trim().toLowerCase(),
    models,
    is_active: config.is_active,
    logical_model_id: String(config.logical_model_id || '').trim() || null,
    verification_status: String(config.verification_status || '').trim() || null,
    updated_at: String(config.updated_at || '').trim() || null,
    blockers: route.blockers,
  })).digest('hex');
}

function buildRemediationPlan(db, options = {}) {
  assertRequiredSchema(db);
  const readinessBuilder = options.readinessBuilder || buildCanaryReadiness;
  const readiness = readinessBuilder(db, options);
  const configs = readPlanningConfigs(db);
  if (readiness.routes.length !== configs.length) throw schemaMismatch();
  const routesByRef = new Map();
  for (const route of readiness.routes) {
    if (!route?.route_ref || routesByRef.has(route.route_ref)) throw schemaMismatch();
    routesByRef.set(route.route_ref, route);
  }

  const actionCounts = Object.fromEntries(REMEDIATION_ACTIONS.map((action) => [action, 0]));
  let excludedPausedConfigs = 0;
  const plans = [];

  configs.forEach((config) => {
    const route = routesByRef.get(sanitizeRouteRef(config));
    const serviceType = String(config.service_type || '').trim().toLowerCase();
    if (!route || route.service_type !== serviceType) throw schemaMismatch();
    if (config.is_active !== 1) {
      if (route.blockers.length > 0) excludedPausedConfigs += 1;
      return;
    }
    if (route.blockers.length === 0) return;

    const models = distinctModels(config);
    const actions = actionsFor(route, models.length);
    if (actions.length === 0) throw schemaMismatch();
    actions.forEach((action) => { actionCounts[action] += 1; });
    plans.push({
      config_id: config.id,
      route_ref: route.route_ref,
      service_type: serviceType,
      blockers: [...route.blockers],
      actions,
      model_count: models.length,
      expected_updated_at: String(config.updated_at || '').trim() || null,
      expected_fingerprint: expectedFingerprint(config, route, models),
    });
  });

  return {
    schema_version: 1,
    generated_at: readiness.generated_at,
    summary: {
      planned_configs: plans.length,
      excluded_paused_configs: excludedPausedConfigs,
      action_counts: actionCounts,
    },
    plans,
  };
}

module.exports = {
  REMEDIATION_ACTIONS,
  buildRemediationPlan,
};
