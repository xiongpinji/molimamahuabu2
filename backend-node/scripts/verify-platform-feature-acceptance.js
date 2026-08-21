const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ACCEPTANCE_PATH = path.join(
  REPO_ROOT,
  'docs',
  'verification',
  'platform-stability',
  'platform-feature-acceptance.json',
);
const SCHEMA_PATH = path.join(
  REPO_ROOT,
  'docs',
  'verification',
  'platform-stability',
  'platform-feature-acceptance.schema.json',
);
const INVENTORY_PATH = path.join(
  REPO_ROOT,
  'docs',
  'verification',
  'platform-stability',
  'platform-feature-inventory.json',
);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function loadDefaultAcceptance() {
  return {
    acceptance: readJson(ACCEPTANCE_PATH),
    schema: readJson(SCHEMA_PATH),
    inventory: readJson(INVENTORY_PATH),
    inventorySha256: sha256(INVENTORY_PATH),
    repoRoot: REPO_ROOT,
  };
}

function validateAcceptance(acceptance, options = {}) {
  const schema = options.schema || readJson(SCHEMA_PATH);
  const inventory = options.inventory || readJson(INVENTORY_PATH);
  const inventorySha256 = options.inventorySha256 || sha256(INVENTORY_PATH);
  const errors = [];
  const errorCodes = new Set();
  const addError = (code) => {
    if (errorCodes.has(code)) return;
    errorCodes.add(code);
    errors.push({ code });
  };

  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  if (!ajv.compile(schema)(acceptance)) addError('schema');

  const features = Array.isArray(inventory.features) ? inventory.features : [];
  const sourceInventory = acceptance && acceptance.source_inventory;
  if (
    !sourceInventory
    || sourceInventory.sha256 !== inventorySha256
    || sourceInventory.feature_count !== features.length
  ) {
    addError('source_inventory_mismatch');
  }

  const knownFeatureIds = new Set(features.map((feature) => feature.feature_id));
  const decisions = acceptance && Array.isArray(acceptance.decisions)
    ? acceptance.decisions
    : [];
  const decisionsByFeature = new Map();

  for (const decision of decisions) {
    const featureId = decision && decision.feature_id;
    if (!knownFeatureIds.has(featureId)) addError('unknown_feature');
    if (decisionsByFeature.has(featureId)) {
      addError('duplicate_feature');
      continue;
    }
    if (knownFeatureIds.has(featureId)) decisionsByFeature.set(featureId, decision);
  }

  const summary = {
    total: features.length,
    unverified: features.length - decisionsByFeature.size,
    blocked: 0,
    locked_pass: 0,
    locked_fixed: 0,
    not_applicable: 0,
  };

  for (const decision of decisionsByFeature.values()) {
    if (Object.hasOwn(summary, decision.status)) summary[decision.status] += 1;
  }

  const valid = errors.length === 0;
  return {
    valid,
    complete: valid && summary.unverified === 0 && summary.blocked === 0,
    errors,
    summary,
  };
}

module.exports = {
  loadDefaultAcceptance,
  validateAcceptance,
};
