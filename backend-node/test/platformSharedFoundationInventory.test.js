'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const inventory = JSON.parse(fs.readFileSync(path.join(
  repoRoot,
  'docs',
  'verification',
  'platform-stability',
  'platform-feature-inventory.json',
), 'utf8'));
const acceptance = JSON.parse(fs.readFileSync(path.join(
  repoRoot,
  'docs',
  'verification',
  'platform-stability',
  'platform-feature-acceptance.json',
), 'utf8'));

const SHARED_FEATURE_IDS = [
  'shared.auth.route_permission',
  'shared.admin.permission_boundary',
  'shared.navigation.primary_modules',
  'shared.billing.credit_account',
  'shared.billing.generation_catalog',
  'shared.assets.library_api',
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
];

const STAGE_FILES = [
  'backend-node/test/platformSharedAuthAcceptance.test.js',
  'backend-node/test/platformSharedCatalogAcceptance.test.js',
  'backend-node/test/platformSharedAssetAcceptance.test.js',
  'backend-node/test/platformSharedBillingAcceptance.test.js',
  'frontweb/e2e/platform-shared-foundation-backend-integration.spec.js',
  'docs/verification/platform-stability/platform-shared-foundation-verification.md',
  'deploy/release-scopes/platform-complete-acceptance-shared-foundation.json',
];

test('公共运行底座精确对应来源清单中的 17 项 shared 功能', () => {
  const shared = inventory.features.filter(({ module }) => module === 'shared');
  assert.deepEqual(shared.map(({ feature_id }) => feature_id), SHARED_FEATURE_IDS);

  for (const feature of shared) {
    assert.equal(feature.baseline_state, 'unverified');
    assert.equal(feature.acceptance_chain.length > 0, true);
    for (const sourcePath of feature.source_paths) {
      assert.equal(fs.existsSync(path.join(repoRoot, sourcePath)), true, `缺少来源文件: ${sourcePath}`);
    }
    for (const testPath of feature.test_paths) {
      assert.equal(fs.existsSync(path.join(repoRoot, testPath)), true, `缺少来源测试: ${testPath}`);
    }
  }
});

test('阶段开始时 shared 功能未被历史证据提前锁定且既有阻断保持原样', () => {
  const decisions = new Map(acceptance.decisions.map((decision) => [decision.feature_id, decision]));
  for (const featureId of SHARED_FEATURE_IDS) {
    assert.equal(decisions.has(featureId), false, `shared 功能不得提前存在锁定决策: ${featureId}`);
  }
  assert.equal(acceptance.decisions.length, 16);
  assert.equal(acceptance.decisions.every(({ status }) => status === 'blocked'), true);
});

test('公共底座验收阶段具备完整测试、证据和精确发布范围', () => {
  for (const relativePath of STAGE_FILES) {
    assert.equal(fs.existsSync(path.join(repoRoot, relativePath)), true, `阶段文件尚未建立: ${relativePath}`);
  }
});
