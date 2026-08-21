#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const providerRouteCostService = require('../src/services/providerRouteCostService');
const externalModelEvidenceService = require('../src/services/externalModelEvidenceService');
const auditEventService = require('../src/services/auditEventService');

const BINDING_FILE_LIMIT = 64 * 1024;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function parseArgs(argv) {
  const result = { apply: false, apply_evidence_bound: false };
  const seen = new Set();
  const valueFlags = new Set([
    '--db', '--config-id', '--expected-fingerprint', '--binding-file',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (seen.has(name)) fail('INVALID_ARGUMENTS');
    seen.add(name);
    if (name === '--apply' || name === '--apply-evidence-bound') {
      result[name.slice(2).replaceAll('-', '_')] = true;
      continue;
    }
    if (!valueFlags.has(name)
        || index + 1 >= argv.length
        || String(argv[index + 1]).startsWith('--')) {
      fail('INVALID_ARGUMENTS');
    }
    result[name.slice(2).replaceAll('-', '_')] = argv[index + 1];
    index += 1;
  }
  const configId = Number(result.config_id);
  if (!result.db || !Number.isSafeInteger(configId) || configId <= 0) fail('INVALID_ARGUMENTS');
  if (!fs.existsSync(result.db) || !fs.statSync(result.db).isFile()) fail('DATABASE_NOT_FOUND');
  if (result.apply && result.apply_evidence_bound) fail('INVALID_ARGUMENTS');
  if ((result.apply || result.apply_evidence_bound)
      && !/^[a-f0-9]{64}$/i.test(String(result.expected_fingerprint || ''))) {
    fail('EXPECTED_FINGERPRINT_REQUIRED');
  }
  if (result.apply_evidence_bound && !result.binding_file) fail('BINDING_FILE_REQUIRED');
  if (!result.apply_evidence_bound && result.binding_file) fail('INVALID_ARGUMENTS');
  return { ...result, configId };
}

function exactKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_BINDING');
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('INVALID_BINDING');
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_BINDING');
}

function bindingText(value, maximum) {
  const text = String(value || '').trim();
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
    fail('INVALID_BINDING');
  }
  return text;
}

function readBindingFile(filePath) {
  let raw;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > BINDING_FILE_LIMIT) {
      fail('INVALID_BINDING');
    }
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    fail('INVALID_BINDING');
  }
  exactKeys(raw, ['schema_version', 'source_config_id', 'models']);
  if (raw.schema_version !== 1
      || !Number.isSafeInteger(raw.source_config_id)
      || raw.source_config_id <= 0
      || !Array.isArray(raw.models)
      || raw.models.length < 2) fail('INVALID_BINDING');
  const models = raw.models.map((item) => {
    exactKeys(item, [
      'model', 'logical_model_id', 'evidence_contract', 'evidence_sha256', 'route_cost',
    ]);
    exactKeys(item.route_cost, [
      'currency', 'cost_unit', 'micros_per_unit', 'resolution_prices',
    ]);
    plainObject(item.route_cost.resolution_prices);
    for (const tier of Object.values(item.route_cost.resolution_prices)) {
      exactKeys(tier, ['micros_per_unit']);
    }
    const evidenceSha256 = bindingText(item.evidence_sha256, 64).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(evidenceSha256)) fail('INVALID_BINDING');
    return {
      model: bindingText(item.model, 120),
      logical_model_id: bindingText(item.logical_model_id, 120),
      evidence_contract: bindingText(item.evidence_contract, 120),
      evidence_sha256: evidenceSha256,
      route_cost: item.route_cost,
    };
  });
  if (new Set(models.map((item) => item.model.toLowerCase())).size !== models.length) {
    fail('INVALID_BINDING');
  }
  return { schema_version: 1, source_config_id: raw.source_config_id, models };
}

function parseModelEntries(value) {
  let parsed;
  try {
    parsed = JSON.parse(value || '[]');
  } catch (_) {
    parsed = [value];
  }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.map((item) => String(item || '').trim()).filter(Boolean);
}

function normalizeModels(value) {
  return [...new Set(parseModelEntries(value))];
}

function readTarget(db, configId) {
  const row = db.prepare('SELECT * FROM ai_service_configs WHERE id = ? AND deleted_at IS NULL').get(configId);
  if (!row) fail('CONFIG_NOT_FOUND');
  const models = normalizeModels(row.model);
  const defaultModel = String(row.default_model || '').trim();
  if (!models.length || !defaultModel || !models.includes(defaultModel)) fail('INVALID_MODEL_CONFIGURATION');
  return { row, models, defaultModel };
}

function fingerprint(target) {
  const snapshot = { ...target.row, model: target.models, default_model: target.defaultModel };
  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function publicPlan(target) {
  return {
    config_id: target.row.id,
    model_count: target.models.length,
    models: target.models,
    fingerprint: fingerprint(target),
  };
}

function parseObject(value, code) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(code);
    return parsed;
  } catch (_) {
    fail(code);
  }
}

function valueForModel(object, model) {
  const key = Object.keys(object).find(
    (candidate) => candidate.toLowerCase() === model.toLowerCase(),
  );
  return key ? object[key] : null;
}

function lowerSet(values) {
  return [...new Set(values.map((value) => String(value).trim().toLowerCase()))].sort();
}

function sameSet(left, right) {
  return JSON.stringify(lowerSet(left)) === JSON.stringify(lowerSet(right));
}

function filteredSettings(value, model, verifiedCapability) {
  const settings = parseObject(value || '{}', 'INVALID_MODEL_CONFIGURATION');
  return JSON.stringify({
    ...settings,
    canvas_capabilities_by_model: { [model]: verifiedCapability },
  });
}

function sameConnection(left, right) {
  return [
    'service_type', 'provider', 'api_protocol', 'base_url', 'api_key', 'endpoint', 'query_endpoint',
  ].every((field) => String(left[field] || '').trim() === String(right[field] || '').trim());
}

function assertNoRouteConflict(db, source, model) {
  const rows = db.prepare(`SELECT id, service_type, provider, api_protocol, base_url, api_key,
      endpoint, query_endpoint, model FROM ai_service_configs
    WHERE deleted_at IS NULL AND id <> ?`).all(source.id);
  if (rows.some((row) => sameConnection(source, row)
      && normalizeModels(row.model).some(
        (value) => value.toLowerCase() === model.toLowerCase(),
      ))) fail('DUPLICATE_PROVIDER_ROUTE');
}

function requireEnabledUserPrice(db, logicalModelId) {
  const row = db.prepare(`SELECT credits, status FROM model_credit_prices
    WHERE model = ? COLLATE NOCASE`).get(logicalModelId);
  if (!row || row.status !== 'enabled'
      || !Number.isSafeInteger(row.credits)
      || row.credits <= 0) fail('MODEL_PRICE_NOT_CONFIGURED');
  return row.credits;
}

function validateEvidenceBoundPlan(db, input, overrides = {}) {
  const readTrustedEvidence = overrides.readTrustedEvidence
    || externalModelEvidenceService.readTrustedEvidence;
  const target = readTarget(db, input.configId);
  const sourceModelEntries = parseModelEntries(target.row.model);
  if (new Set(sourceModelEntries.map((model) => model.toLowerCase())).size
      !== sourceModelEntries.length) {
    fail('INVALID_MODEL_CONFIGURATION');
  }
  const source = target.row;
  if (target.models.length <= 1) fail('ALREADY_EVIDENCE_BOUND_SPLIT');
  if (source.is_active !== 1 || source.verification_status !== 'verified') {
    fail('SOURCE_NOT_ELIGIBLE');
  }
  if (fingerprint(target) !== String(input.expectedFingerprint || '').toLowerCase()) {
    fail('STALE_FINGERPRINT');
  }
  if (input.binding.source_config_id !== input.configId) fail('BINDING_SOURCE_MISMATCH');
  if (!sameSet(target.models, input.binding.models.map((item) => item.model))) {
    fail('BINDING_MODEL_SET_MISMATCH');
  }
  const beforePublicModels = source.logical_model_id
    ? [source.logical_model_id]
    : target.models;
  const afterPublicModels = input.binding.models.map((item) => item.logical_model_id);
  if (!sameSet(beforePublicModels, afterPublicModels)) fail('PUBLIC_MODEL_SET_CHANGED');
  const verifiedCapabilities = parseObject(
    source.verified_capabilities,
    'MISSING_MODEL_EVIDENCE',
  );
  const bindings = input.binding.models.map((binding) => {
    const capability = valueForModel(verifiedCapabilities, binding.model);
    if (!capability || typeof capability !== 'object' || Array.isArray(capability)) {
      fail('MISSING_MODEL_EVIDENCE');
    }
    if (String(capability.evidence_contract || '') !== binding.evidence_contract
        || String(capability.evidence_sha256 || '').toLowerCase() !== binding.evidence_sha256) {
      fail('EVIDENCE_MISMATCH');
    }
    const trusted = readTrustedEvidence(binding.model);
    if (!trusted
        || trusted.contract !== binding.evidence_contract
        || trusted.sha256 !== binding.evidence_sha256) fail('UNTRUSTED_MODEL_EVIDENCE');
    requireEnabledUserPrice(db, binding.logical_model_id);
    const cost = providerRouteCostService.normalizeRouteCostInput(source.id, binding.route_cost);
    if (source.service_type === 'video' && cost.cost_unit !== 'second') {
      fail('ROUTE_COST_CAPABILITY_MISMATCH');
    }
    const resolutions = Array.isArray(capability.resolutions)
      ? lowerSet(capability.resolutions)
      : [];
    if (resolutions.some((resolution) => !cost.resolution_prices[resolution])) {
      fail('ROUTE_COST_CAPABILITY_MISMATCH');
    }
    assertNoRouteConflict(db, source, binding.model);
    return {
      ...binding,
      capability,
      settings: filteredSettings(source.settings, binding.model, capability),
      normalized_cost: cost,
    };
  });
  const defaultBinding = bindings.find(
    (binding) => binding.model.toLowerCase() === target.defaultModel.toLowerCase(),
  );
  if (!defaultBinding) fail('INVALID_MODEL_CONFIGURATION');
  return { target, bindings, defaultBinding };
}

function insertClone(db, clone) {
  const columns = db.prepare('PRAGMA table_info(ai_service_configs)').all()
    .map((column) => column.name)
    .filter((name) => name !== 'id');
  const selected = columns.filter((column) => Object.prototype.hasOwnProperty.call(clone, column));
  const info = db.prepare(`INSERT INTO ai_service_configs (${selected.join(', ')})
    VALUES (${selected.map(() => '?').join(', ')})`).run(
    ...selected.map((column) => clone[column]),
  );
  return Number(info.lastInsertRowid);
}

function cloneRow(db, source, model, now) {
  const clone = { ...source };
  clone.model = JSON.stringify([model]);
  clone.default_model = model;
  clone.name = `${String(source.name || '供应商线路')} · ${model}`;
  clone.is_default = 0;
  clone.is_active = 0;
  clone.logical_model_id = null;
  clone.failover_enabled = 0;
  clone.verification_status = 'unverified';
  clone.verified_at = null;
  clone.verification_evidence = null;
  clone.verification_checked_at = null;
  clone.verification_error = null;
  clone.verified_capabilities = '{}';
  clone.created_at = now;
  clone.updated_at = now;
  clone.deleted_at = null;
  insertClone(db, clone);
}

function cloneEvidenceBoundRow(db, source, binding, now) {
  return insertClone(db, {
    ...source,
    model: JSON.stringify([binding.model]),
    default_model: binding.model,
    name: `${String(source.name || '供应商线路')} · ${binding.model}`,
    is_default: 0,
    is_active: 1,
    logical_model_id: binding.logical_model_id,
    failover_enabled: 0,
    verification_status: 'verified',
    verification_error: null,
    verified_capabilities: JSON.stringify({ [binding.model]: binding.capability }),
    settings: binding.settings,
    canary_paused: 1,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  });
}

function applyPlan(db, configId, expectedFingerprint) {
  const before = readTarget(db, configId);
  if (fingerprint(before) !== expectedFingerprint.toLowerCase()) fail('STALE_FINGERPRINT');
  if (before.models.length <= 1) return publicPlan(before);

  return db.transaction(() => {
    const current = readTarget(db, configId);
    if (fingerprint(current) !== expectedFingerprint.toLowerCase()) fail('STALE_FINGERPRINT');
    const now = new Date().toISOString();
    db.prepare(`UPDATE ai_service_configs SET model = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL`).run(JSON.stringify([current.defaultModel]), now, configId);
    for (const model of current.models) {
      if (model === current.defaultModel) continue;
      cloneRow(db, current.row, model, now);
    }
    return publicPlan(readTarget(db, configId));
  }).immediate();
}

function applyEvidenceBoundPlan(db, input, overrides = {}) {
  const setRouteCost = overrides.setRouteCost || providerRouteCostService.setRouteCost;
  const recordAudit = overrides.recordAudit || auditEventService.record;
  validateEvidenceBoundPlan(db, input, overrides);
  return db.transaction(() => {
    const plan = validateEvidenceBoundPlan(db, input, overrides);
    const now = new Date().toISOString();
    const routeIds = new Map([[plan.defaultBinding.model.toLowerCase(), input.configId]]);
    db.prepare(`UPDATE ai_service_configs SET
        model = ?, default_model = ?, logical_model_id = ?, settings = ?,
        verified_capabilities = ?, canary_paused = 1, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL`).run(
      JSON.stringify([plan.defaultBinding.model]),
      plan.defaultBinding.model,
      plan.defaultBinding.logical_model_id,
      plan.defaultBinding.settings,
      JSON.stringify({ [plan.defaultBinding.model]: plan.defaultBinding.capability }),
      now,
      input.configId,
    );
    for (const binding of plan.bindings) {
      if (binding.model.toLowerCase() === plan.defaultBinding.model.toLowerCase()) continue;
      routeIds.set(
        binding.model.toLowerCase(),
        cloneEvidenceBoundRow(db, plan.target.row, binding, now),
      );
    }
    const routes = plan.bindings.map((binding) => {
      const configId = routeIds.get(binding.model.toLowerCase());
      const savedCost = setRouteCost(db, configId, binding.route_cost, { now });
      for (const resolution of Object.keys(binding.normalized_cost.resolution_prices)) {
        if (!providerRouteCostService.routeCostCoversCapability(db, configId, {
          resolution,
          duration: 1,
          count: 1,
        })) fail('ROUTE_COST_CAPABILITY_MISMATCH');
      }
      return {
        config_id: configId,
        model: binding.model,
        logical_model_id: binding.logical_model_id,
        cost_fingerprint: providerRouteCostService.fingerprintRouteCost(savedCost),
      };
    });
    recordAudit(db, {
      eventType: 'provider.config.evidence_bound_split',
      userId: 'system/cli',
      resourceType: 'ai_service_config',
      resourceId: String(input.configId),
      outcome: 'success',
      code: routes.map((route) => `${route.config_id}:${route.model}`).join(','),
    });
    return {
      status: 'applied',
      source_config_id: input.configId,
      source_fingerprint: input.expectedFingerprint,
      routes,
    };
  }).immediate();
}

function main(argv = process.argv.slice(2)) {
  let db;
  try {
    const options = parseArgs(argv);
    db = new Database(options.db);
    const target = readTarget(db, options.configId);
    const result = options.apply_evidence_bound
      ? applyEvidenceBoundPlan(db, {
        configId: options.configId,
        expectedFingerprint: String(options.expected_fingerprint).toLowerCase(),
        binding: readBindingFile(options.binding_file),
      })
      : options.apply
        ? applyPlan(db, options.configId, String(options.expected_fingerprint).toLowerCase())
        : publicPlan(target);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.code || 'SPLIT_FAILED'}\n`);
    process.exitCode = 1;
  } finally {
    if (db) db.close();
  }
}

if (require.main === module) main();

module.exports = {
  applyEvidenceBoundPlan,
  applyPlan,
  fingerprint,
  main,
  normalizeModels,
  parseArgs,
  publicPlan,
  readBindingFile,
  readTarget,
  validateEvidenceBoundPlan,
};
