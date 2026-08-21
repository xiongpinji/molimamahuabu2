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

function requiredEvidenceKinds(feature) {
  return new Set([
    'contract',
    ...(Array.isArray(feature.acceptance_chain) ? feature.acceptance_chain : []),
    'ci',
    'production',
    'lock',
  ]);
}

function validateEvidencePaths(evidence, repoRoot, featureId, addError) {
  for (const item of evidence) {
    if (!item || typeof item.path !== 'string') continue;
    if (path.isAbsolute(item.path)) {
      addError('missing_evidence_path', { feature_id: featureId });
      continue;
    }

    const resolvedPath = path.resolve(repoRoot, item.path);
    const relativePath = path.relative(repoRoot, resolvedPath);
    if (
      relativePath === '..'
      || relativePath.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativePath)
    ) {
      addError('missing_evidence_path', { feature_id: featureId });
      continue;
    }

    try {
      if (!fs.statSync(resolvedPath).isFile()) {
        addError('missing_evidence_path', { feature_id: featureId });
        continue;
      }
      fs.accessSync(resolvedPath, fs.constants.R_OK);
    } catch {
      addError('missing_evidence_path', { feature_id: featureId });
    }
  }
}

function validateAcceptance(acceptance, options = {}) {
  const schema = options.schema || readJson(SCHEMA_PATH);
  const inventory = options.inventory || readJson(INVENTORY_PATH);
  const inventorySha256 = options.inventorySha256 || sha256(INVENTORY_PATH);
  const repoRoot = options.repoRoot || REPO_ROOT;
  const errors = [];
  const errorCodes = new Set();
  const addError = (code, details = {}) => {
    if (errorCodes.has(code)) return;
    errorCodes.add(code);
    errors.push({ code, ...details });
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

  const featuresById = new Map(features.map((feature) => [feature.feature_id, feature]));
  const knownFeatureIds = new Set(featuresById.keys());
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

    const featureId = decision.feature_id;
    const evidence = Array.isArray(decision.evidence) ? decision.evidence : [];
    validateEvidencePaths(evidence, repoRoot, featureId, addError);

    if (
      (decision.status === 'blocked' || decision.status === 'not_applicable')
      && (typeof decision.reason !== 'string' || decision.reason.length === 0)
    ) {
      addError('schema');
    }

    if (decision.status === 'not_applicable') {
      const hasApproval = typeof decision.approved_by === 'string'
        && decision.approved_by.length > 0;
      const hasProductDecision = evidence.some(
        (item) => item && item.kind === 'lock' && item.result === 'pass',
      );
      if (!hasApproval || !hasProductDecision) {
        addError('missing_approval', { feature_id: featureId });
      }
    }

    if (decision.status !== 'locked_pass' && decision.status !== 'locked_fixed') {
      continue;
    }

    if (decision.status === 'locked_fixed') {
      const hasDefectId = typeof decision.defect_id === 'string'
        && decision.defect_id.length > 0;
      const hasFixCommit = /^[a-f0-9]{40}$/.test(decision.fix_commit || '');
      if (!hasDefectId || !hasFixCommit) {
        addError('missing_fix_metadata', { feature_id: featureId });
      }
    } else if (decision.defect_id !== undefined || decision.fix_commit !== undefined) {
      addError('schema');
    }

    const candidateCommit = decision.candidate_commit;
    if (
      !/^[a-f0-9]{40}$/.test(candidateCommit || '')
      || evidence.some((item) => (
        !item
        || !/^[a-f0-9]{40}$/.test(item.candidate_commit || '')
        || item.candidate_commit !== candidateCommit
      ))
    ) {
      addError('candidate_mismatch', { feature_id: featureId });
    }

    if (evidence.some((item) => !item || item.result !== 'pass')) {
      addError('non_passing_evidence', { feature_id: featureId });
    }

    const presentKinds = new Set(evidence.map((item) => item && item.kind));
    const missingKind = [...requiredEvidenceKinds(featuresById.get(featureId))]
      .find((kind) => !presentKinds.has(kind));
    if (missingKind) {
      addError('missing_evidence', {
        feature_id: featureId,
        kind: missingKind,
      });
    }
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
  requiredEvidenceKinds,
  validateAcceptance,
};
