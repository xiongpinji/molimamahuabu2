#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA_PATH = path.join(
  REPO_ROOT,
  'docs',
  'verification',
  'platform-stability',
  'platform-feature-inventory.schema.json',
);
const INVENTORY_PATH = path.join(
  REPO_ROOT,
  'docs',
  'verification',
  'platform-stability',
  'platform-feature-inventory.json',
);

const REQUIRED_COVERAGE = Object.freeze({
  shared: ['permission', 'billing', 'asset_library', 'api'],
  canvas: [
    'entry',
    'navigation',
    'menu',
    'modal',
    'create',
    'edit',
    'connection',
    'viewport',
    'reference',
    'generation',
    'workflow',
    'status',
    'refresh',
    'preview',
    'download',
    'billing',
    'asset_library',
    'projection',
    'api',
  ],
  short_drama_factory: [
    'entry',
    'navigation',
    'tab',
    'menu',
    'modal',
    'selection',
    'create',
    'edit',
    'reference',
    'generation',
    'workflow',
    'status',
    'refresh',
    'preview',
    'download',
    'billing',
    'asset_library',
    'composition',
    'projection',
    'api',
  ],
  script_analysis: [
    'entry',
    'navigation',
    'tab',
    'modal',
    'create',
    'upload',
    'generation',
    'status',
    'refresh',
    'preview',
    'download',
    'billing',
    'edit',
    'save',
    'review',
    'projection',
    'api',
  ],
});

const REQUIRED_FEATURE_IDS = Object.freeze([
  'shared.api.auth_session',
  'shared.api.tenant_member',
  'shared.api.platform_account_admin',
  'shared.api.billing_account',
  'shared.api.billing_catalog',
  'shared.api.billing_redeem',
  'shared.api.billing_orders',
  'shared.api.billing_recharge',
  'shared.api.billing_admin_pricing',
  'shared.api.billing_reconciliation',
  'shared.api.asset_library',
  'canvas.api.layout',
  'canvas.api.asset',
  'canvas.api.text_generation',
  'canvas.api.image_generation',
  'canvas.api.video_generation',
  'canvas.api.audio_generation',
  'canvas.api.image_tool',
  'canvas.api.video_tool',
  'canvas.api.task_status_result',
  'canvas.image_tool.character_portrait',
  'canvas.image_tool.composition_narrative',
  'canvas.image_tool.quality',
  'canvas.image_tool.geometry',
  'canvas.image_tool.edit',
  'canvas.image_tool.matting',
  'short_drama_factory.api.drama',
  'short_drama_factory.api.project',
  'short_drama_factory.api.episode',
  'short_drama_factory.api.import',
  'short_drama_factory.api.export',
  'short_drama_factory.api.character',
  'short_drama_factory.api.scene',
  'short_drama_factory.api.prop',
  'short_drama_factory.api.storyboard',
  'short_drama_factory.api.image_media',
  'short_drama_factory.api.video_media',
  'short_drama_factory.api.audio_media',
  'short_drama_factory.api.generation_task',
  'short_drama_factory.character.crud',
  'short_drama_factory.scene.crud',
  'short_drama_factory.prop.crud',
  'short_drama_factory.storyboard.crud',
  'short_drama_factory.character.asset_library',
  'short_drama_factory.scene.asset_library',
  'short_drama_factory.prop.asset_library',
  'short_drama_factory.character.reference',
  'short_drama_factory.scene.reference',
  'short_drama_factory.prop.reference',
  'short_drama_factory.storyboard.reference',
  'short_drama_factory.character.image_generation',
  'short_drama_factory.scene.image_generation',
  'short_drama_factory.prop.image_generation',
  'short_drama_factory.storyboard.image_generation',
  'short_drama_factory.storyboard.video_generation',
  'short_drama_factory.storyboard.batch_video_generation',
  'script_analysis.api.skill_preset',
  'script_analysis.api.project',
  'script_analysis.api.version',
  'script_analysis.api.revision',
  'script_analysis.api.review',
  'script_analysis.api.run',
  'script_analysis.api.factory_import',
  'script_analysis.canvas.projection',
  'script_analysis.factory.projection',
]);

const PLACEHOLDER_PATTERN = /\b(?:TODO|TBD|placeholder)\b|待定/i;
const GENERIC_API_PATTERN = /公开\s*API|全部|统一|综合|public_routes/i;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadDefaultInventory() {
  return {
    inventory: readJson(INVENTORY_PATH),
    schema: readJson(SCHEMA_PATH),
  };
}

function isRepositoryFile(repoRoot, relativePath) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) return false;
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) return false;
  try {
    return fs.statSync(resolvedPath).isFile();
  } catch (_) {
    return false;
  }
}

function validateInventory(inventory, { repoRoot = REPO_ROOT, schema } = {}) {
  const errors = [];
  const effectiveSchema = schema || readJson(SCHEMA_PATH);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validateSchema = ajv.compile(effectiveSchema);

  if (!validateSchema(inventory)) {
    for (const detail of validateSchema.errors || []) {
      errors.push({
        code: 'schema',
        message: `${detail.instancePath || '/'} ${detail.message}`,
      });
    }
  }

  const features = Array.isArray(inventory?.features) ? inventory.features : [];
  const startingPaths = Array.isArray(inventory?.source_inventory?.starting_paths)
    ? inventory.source_inventory.starting_paths
    : [];
  for (const relativePath of startingPaths) {
    if (!isRepositoryFile(repoRoot, relativePath)) {
      errors.push({
        code: 'missing_path',
        message: `source_inventory starting_paths: ${relativePath}`,
      });
    }
  }

  const seenIds = new Set();
  for (const feature of features) {
    const featureId = feature?.feature_id;
    if (typeof featureId === 'string') {
      if (seenIds.has(featureId)) {
        errors.push({ code: 'duplicate_feature_id', message: `duplicate feature_id: ${featureId}` });
      }
      seenIds.add(featureId);
    }

    if (feature?.baseline_state === 'verified') {
      errors.push({
        code: 'verified_forbidden',
        message: `${featureId || '<unknown>'} cannot be verified in source-inventory phase`,
      });
    }
    if (
      feature?.action_kind === 'api'
      && (GENERIC_API_PATTERN.test(String(featureId || ''))
        || GENERIC_API_PATTERN.test(String(feature?.control_label || '')))
    ) {
      errors.push({
        code: 'generic_api_coverage',
        message: `${featureId || '<unknown>'} uses an umbrella API label or id`,
      });
    }
    if (feature?.baseline_state === 'blocked' && !String(feature?.block_reason || '').trim()) {
      errors.push({
        code: 'blocked_without_reason',
        message: `${featureId || '<unknown>'} is blocked without block_reason`,
      });
    }

    for (const field of ['source_paths', 'test_paths']) {
      const paths = Array.isArray(feature?.[field]) ? feature[field] : [];
      for (const relativePath of paths) {
        if (field === 'test_paths' && relativePath === 'backend-node/test/platformFeatureInventory.test.js') {
          errors.push({
            code: 'inventory_test_not_feature_evidence',
            message: `${featureId || '<unknown>'} cannot use inventory structure test as feature evidence`,
          });
        }
        if (!isRepositoryFile(repoRoot, relativePath)) {
          errors.push({
            code: 'missing_path',
            message: `${featureId || '<unknown>'} ${field}: ${relativePath}`,
          });
        }
      }
    }
  }

  for (const [moduleName, requiredKinds] of Object.entries(REQUIRED_COVERAGE)) {
    for (const actionKind of requiredKinds) {
      const found = features.some(
        (feature) => feature?.module === moduleName && feature?.action_kind === actionKind,
      );
      if (!found) {
        errors.push({
          code: 'missing_required_coverage',
          message: `${moduleName} requires action_kind=${actionKind}`,
        });
      }
    }
  }

  for (const featureId of REQUIRED_FEATURE_IDS) {
    if (!seenIds.has(featureId)) {
      errors.push({
        code: 'missing_required_feature',
        message: `required feature_id is missing: ${featureId}`,
      });
    }
  }

  const inventoryText = JSON.stringify(inventory);
  if (PLACEHOLDER_PATTERN.test(inventoryText)) {
    errors.push({
      code: 'placeholder_marker',
      message: 'inventory contains TODO/TBD/待定/placeholder marker',
    });
  }

  return { valid: errors.length === 0, errors };
}

function summarize(inventory) {
  const modules = {};
  let blocked = 0;
  for (const feature of inventory.features || []) {
    modules[feature.module] = (modules[feature.module] || 0) + 1;
    if (feature.baseline_state === 'blocked') blocked += 1;
  }
  return { total: inventory.features?.length || 0, blocked, modules };
}

function main() {
  try {
    const { inventory, schema } = loadDefaultInventory();
    const result = validateInventory(inventory, { repoRoot: REPO_ROOT, schema });
    if (!result.valid) {
      for (const error of result.errors) console.error(`[${error.code}] ${error.message}`);
      process.exitCode = 1;
      return;
    }
    const summary = summarize(inventory);
    console.log(`feature inventory valid: ${summary.total} features, ${summary.blocked} blocked`);
    console.log(JSON.stringify(summary.modules));
  } catch (error) {
    console.error(`feature inventory validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  INVENTORY_PATH,
  REPO_ROOT,
  REQUIRED_COVERAGE,
  REQUIRED_FEATURE_IDS,
  SCHEMA_PATH,
  loadDefaultInventory,
  summarize,
  validateInventory,
};
