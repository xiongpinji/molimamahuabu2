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

test('checked-in feature inventory satisfies its structural and coverage contract', () => {
  const { inventory, schema } = loadDefaultInventory();
  const result = validateInventory(inventory, { repoRoot, schema });

  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
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
