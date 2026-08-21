const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const {
  loadDefaultInventory,
  validateInventory,
} = require('../scripts/verify-platform-feature-inventory');

const repoRoot = path.resolve(__dirname, '..', '..');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function errorCodes(result) {
  return new Set(result.errors.map((error) => error.code));
}

function featureMap(inventory) {
  return new Map(inventory.features.map((feature) => [feature.feature_id, feature]));
}

test('checked-in feature inventory satisfies its structural and coverage contract', () => {
  const { inventory, schema } = loadDefaultInventory();
  const result = validateInventory(inventory, { repoRoot, schema });

  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test('public API operation families remain independently traceable', () => {
  const { inventory } = loadDefaultInventory();
  const byId = featureMap(inventory);
  const requiredIds = [
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
    'script_analysis.api.skill_preset',
    'script_analysis.api.project',
    'script_analysis.api.version',
    'script_analysis.api.revision',
    'script_analysis.api.review',
    'script_analysis.api.run',
    'script_analysis.api.factory_import',
  ];

  for (const featureId of requiredIds) {
    assert.ok(byId.has(featureId), `missing operation family: ${featureId}`);
    assert.equal(byId.get(featureId).action_kind, 'api', featureId);
  }

  for (const featureId of ['script_analysis.canvas.projection', 'script_analysis.factory.projection']) {
    assert.ok(byId.has(featureId), featureId);
    assert.equal(byId.get(featureId).action_kind, 'projection', featureId);
  }

  for (const groupedId of [
    'shared.api.billing_account_catalog',
    'shared.api.billing_orders_recharge',
    'short_drama_factory.api.drama_project_episode',
    'short_drama_factory.api.import_export',
    'script_analysis.api.version_revision',
  ]) {
    assert.equal(byId.has(groupedId), false, groupedId);
  }
});

test('verifier rejects removal of a required operation family', () => {
  const { inventory, schema } = loadDefaultInventory();
  const missingFamily = clone(inventory);
  missingFamily.features = missingFamily.features.filter(
    (feature) => feature.feature_id !== 'shared.api.auth_session',
  );

  const result = validateInventory(missingFamily, { repoRoot, schema });

  assert.equal(result.valid, false);
  assert.ok(errorCodes(result).has('missing_required_feature'));
});

test('required feature descriptors reject module and action-kind drift', () => {
  const { inventory, schema } = loadDefaultInventory();
  const drifted = clone(inventory);
  const authSession = drifted.features.find(
    (feature) => feature.feature_id === 'shared.api.auth_session',
  );
  authSession.module = 'canvas';
  authSession.action_kind = 'entry';

  const result = validateInventory(drifted, { repoRoot, schema });

  assert.equal(result.valid, false);
  assert.ok(errorCodes(result).has('required_feature_contract'));
  assert.ok(errorCodes(result).has('feature_module_mismatch'));
  assert.ok(errorCodes(result).has('api_action_kind_mismatch'));
});

test('API features reject umbrella coverage labels and ids', () => {
  const { inventory, schema } = loadDefaultInventory();
  const umbrellaPattern = /公开\s*API|全部|统一|综合|public_routes/i;

  for (const feature of inventory.features.filter((item) => item.action_kind === 'api')) {
    assert.doesNotMatch(feature.feature_id, umbrellaPattern, feature.feature_id);
    assert.doesNotMatch(feature.control_label, umbrellaPattern, feature.feature_id);
  }

  const generic = clone(inventory);
  const apiFeature = generic.features.find((feature) => feature.action_kind === 'api');
  apiFeature.control_label = '综合公开 API';
  const result = validateInventory(generic, { repoRoot, schema });
  assert.equal(result.valid, false);
  assert.ok(errorCodes(result).has('generic_api_coverage'));
});

test('script analysis run inventory records backend credit reservation and settlement', () => {
  const { inventory } = loadDefaultInventory();
  const byId = featureMap(inventory);

  for (const featureId of ['script_analysis.run', 'script_analysis.api.run']) {
    const feature = byId.get(featureId);
    assert.ok(feature, featureId);
    assert.equal(feature.may_charge, true, featureId);
    assert.ok(feature.acceptance_chain.includes('billing'), featureId);
  }

  const visibility = byId.get('script_analysis.billing.visibility');
  assert.equal(visibility.baseline_state, 'blocked');
  assert.match(visibility.block_reason, /后端.*计费/);
  assert.match(visibility.block_reason, /前端.*预计扣费/);
});

test('canvas image toolbar operation groups remain independently traceable', () => {
  const { inventory } = loadDefaultInventory();
  const byId = featureMap(inventory);
  const requiredIds = [
    'canvas.image_tool.character_portrait',
    'canvas.image_tool.composition_narrative',
    'canvas.image_tool.quality',
    'canvas.image_tool.geometry',
    'canvas.image_tool.edit',
    'canvas.image_tool.matting',
  ];

  for (const featureId of requiredIds) assert.ok(byId.has(featureId), featureId);
});

test('short drama factory keeps resource and generation families split', () => {
  const { inventory } = loadDefaultInventory();
  const byId = featureMap(inventory);
  const requiredIds = [
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
  ];
  const forbiddenGroupedIds = [
    'short_drama_factory.resource.crud',
    'short_drama_factory.resource.asset_library',
    'short_drama_factory.reference.assets',
    'short_drama_factory.image.generation',
    'short_drama_factory.video.generation',
  ];

  for (const featureId of requiredIds) assert.ok(byId.has(featureId), featureId);
  for (const featureId of forbiddenGroupedIds) assert.equal(byId.has(featureId), false, featureId);
});

test('schema rejects additional properties and fixed-enum violations', () => {
  const { inventory, schema } = loadDefaultInventory();

  const unexpectedTopLevel = clone(inventory);
  unexpectedTopLevel.unexpected = true;
  assert.equal(validateInventory(unexpectedTopLevel, { repoRoot, schema }).valid, false);

  const unexpectedFeatureProperty = clone(inventory);
  unexpectedFeatureProperty.features[0].unexpected = true;
  assert.equal(validateInventory(unexpectedFeatureProperty, { repoRoot, schema }).valid, false);

  const illegalModule = clone(inventory);
  illegalModule.features[0].module = 'other';
  const illegalModuleResult = validateInventory(illegalModule, { repoRoot, schema });
  assert.equal(illegalModuleResult.valid, false);
  assert.ok(errorCodes(illegalModuleResult).has('schema'));

  const illegalBaseline = clone(inventory);
  illegalBaseline.features[0].baseline_state = 'accepted';
  assert.equal(validateInventory(illegalBaseline, { repoRoot, schema }).valid, false);

  const nonDeterministicTimestamp = clone(inventory);
  nonDeterministicTimestamp.generated_at = '2026-08-19T00:00:00+08:00';
  assert.equal(validateInventory(nonDeterministicTimestamp, { repoRoot, schema }).valid, false);
});

test('duplicate feature_id is rejected', () => {
  const { inventory, schema } = loadDefaultInventory();
  const duplicate = clone(inventory);
  duplicate.features.push(clone(duplicate.features[0]));

  const result = validateInventory(duplicate, { repoRoot, schema });

  assert.equal(result.valid, false);
  assert.ok(errorCodes(result).has('duplicate_feature_id'));
});

test('verified baseline state is rejected for source-inventory phase', () => {
  const { inventory, schema } = loadDefaultInventory();
  const verified = clone(inventory);
  verified.features[0].baseline_state = 'verified';

  const result = validateInventory(verified, { repoRoot, schema });

  assert.equal(result.valid, false);
  assert.ok(errorCodes(result).has('verified_forbidden'));
});

test('each business module must retain an independent entry feature', () => {
  const { inventory, schema } = loadDefaultInventory();

  for (const moduleName of ['canvas', 'short_drama_factory', 'script_analysis']) {
    const missingEntry = clone(inventory);
    missingEntry.features = missingEntry.features.filter(
      (feature) => feature.module !== moduleName || feature.action_kind !== 'entry',
    );

    const result = validateInventory(missingEntry, { repoRoot, schema });
    assert.equal(result.valid, false, moduleName);
    assert.ok(errorCodes(result).has('missing_required_coverage'), moduleName);
  }
});

test('shared permission, billing, and asset categories are mandatory', () => {
  const { inventory, schema } = loadDefaultInventory();

  for (const actionKind of ['permission', 'billing', 'asset_library']) {
    const missingCategory = clone(inventory);
    missingCategory.features = missingCategory.features.filter(
      (feature) => feature.module !== 'shared' || feature.action_kind !== actionKind,
    );

    const result = validateInventory(missingCategory, { repoRoot, schema });
    assert.equal(result.valid, false, actionKind);
    assert.ok(errorCodes(result).has('missing_required_coverage'), actionKind);
  }
});

test('source and test paths must resolve to repository files', () => {
  const { inventory, schema } = loadDefaultInventory();

  const missingSource = clone(inventory);
  missingSource.features[0].source_paths = ['frontweb/src/does-not-exist.vue'];
  const missingSourceResult = validateInventory(missingSource, { repoRoot, schema });
  assert.equal(missingSourceResult.valid, false);
  assert.ok(errorCodes(missingSourceResult).has('missing_path'));

  const missingTest = clone(inventory);
  missingTest.features[0].test_paths = ['backend-node/test/does-not-exist.test.js'];
  const missingTestResult = validateInventory(missingTest, { repoRoot, schema });
  assert.equal(missingTestResult.valid, false);
  assert.ok(errorCodes(missingTestResult).has('missing_path'));

  const missingStartingPath = clone(inventory);
  missingStartingPath.source_inventory.starting_paths[0] = 'frontweb/src/does-not-exist-entry.vue';
  const missingStartingPathResult = validateInventory(missingStartingPath, { repoRoot, schema });
  assert.equal(missingStartingPathResult.valid, false);
  assert.ok(errorCodes(missingStartingPathResult).has('missing_path'));
});

test('inventory structure test cannot be used as feature acceptance evidence', () => {
  const { inventory, schema } = loadDefaultInventory();
  const selfReferenced = clone(inventory);
  selfReferenced.features[0].test_paths = ['backend-node/test/platformFeatureInventory.test.js'];

  const result = validateInventory(selfReferenced, { repoRoot, schema });

  assert.equal(result.valid, false);
  assert.ok(errorCodes(result).has('inventory_test_not_feature_evidence'));
});

test('ordinary scripts cannot be used as feature test evidence', () => {
  const { inventory, schema } = loadDefaultInventory();
  const scriptReferenced = clone(inventory);
  scriptReferenced.features[0].test_paths = [
    'backend-node/scripts/verify-platform-feature-inventory.js',
  ];

  const result = validateInventory(scriptReferenced, { repoRoot, schema });

  assert.equal(result.valid, false);
  assert.ok(errorCodes(result).has('invalid_test_evidence_path'));
});

test('other inventory-only tests cannot be used as feature acceptance evidence', () => {
  const { inventory, schema } = loadDefaultInventory();
  const inventoryTestReferenced = clone(inventory);
  inventoryTestReferenced.features[0].test_paths = [
    'backend-node/test/providerCanaryInventory.test.js',
  ];

  const result = validateInventory(inventoryTestReferenced, { repoRoot, schema });

  assert.equal(result.valid, false);
  assert.ok(errorCodes(result).has('inventory_test_not_feature_evidence'));
});

test('blocked feature requires a concrete block_reason', () => {
  const { inventory, schema } = loadDefaultInventory();
  const blockedWithoutReason = clone(inventory);
  blockedWithoutReason.features[0].baseline_state = 'blocked';
  delete blockedWithoutReason.features[0].block_reason;

  const result = validateInventory(blockedWithoutReason, { repoRoot, schema });

  assert.equal(result.valid, false);
  assert.ok(errorCodes(result).has('schema'));
  assert.ok(errorCodes(result).has('blocked_without_reason'));
});

test('TODO, TBD, 待定, and placeholder markers are rejected', () => {
  const { inventory, schema } = loadDefaultInventory();

  for (const marker of ['TODO', 'TBD', '待定', 'placeholder']) {
    const marked = clone(inventory);
    marked.features[0].control_label = marker;

    const result = validateInventory(marked, { repoRoot, schema });
    assert.equal(result.valid, false, marker);
    assert.ok(errorCodes(result).has('placeholder_marker'), marker);
  }
});

test('CLI validates the checked-in inventory from backend-node', () => {
  const cli = spawnSync(process.execPath, ['scripts/verify-platform-feature-inventory.js'], {
    cwd: path.join(repoRoot, 'backend-node'),
    encoding: 'utf8',
  });

  assert.equal(cli.status, 0, `${cli.stdout}\n${cli.stderr}`);
  assert.match(cli.stdout, /feature inventory valid/i);
});
