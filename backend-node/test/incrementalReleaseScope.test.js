'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  loadManifest,
  verifyIncrementalReleaseScope,
} = require('../scripts/verify-incremental-release-scope');

const repoRoot = path.resolve(__dirname, '..', '..');
const proactiveCanaryManifestPath = path.join(
  repoRoot,
  'deploy',
  'release-scopes',
  'platform-stability-proactive-canary.json',
);
const PROACTIVE_CANARY_ALLOWED_PATHS = [
  '.github/workflows/platform-zero-cost-smoke.yml',
  'backend-node/migrations/60_provider_canary_guard.sql',
  'backend-node/migrations/61_provider_canary_reconcile_claim.sql',
  'backend-node/migrations/62_provider_canary_admin_pagination.sql',
  'backend-node/migrations/63_provider_route_costs.sql',
  'backend-node/package-lock.json',
  'backend-node/package.json',
  'backend-node/scripts/audit-provider-canary-readiness.js',
  'backend-node/scripts/split-multi-model-provider-configs.js',
  'backend-node/scripts/verify-feature-lock-manifest.js',
  'backend-node/scripts/verify-platform-feature-inventory.js',
  'backend-node/src/app.js',
  'backend-node/src/middleware/resourceOwnership.js',
  'backend-node/src/routes/index.js',
  'backend-node/src/routes/providerStability.js',
  'backend-node/src/services/aiClient.js',
  'backend-node/src/services/aiConfigService.js',
  'backend-node/src/services/canvasModelCatalogService.js',
  'backend-node/src/services/generationCostLedgerService.js',
  'backend-node/src/services/generationUsageContext.js',
  'backend-node/src/services/imageClient.js',
  'backend-node/src/services/imageService.js',
  'backend-node/src/services/modelPriceService.js',
  'backend-node/src/services/providerCanaryArtifactService.js',
  'backend-node/src/services/providerCanaryBudgetService.js',
  'backend-node/src/services/providerCanaryEvidenceService.js',
  'backend-node/src/services/providerCanaryExecutor.js',
  'backend-node/src/services/providerCanaryFixtureService.js',
  'backend-node/src/services/providerCanaryInventoryService.js',
  'backend-node/src/services/providerCanarySchedulerService.js',
  'backend-node/src/services/providerRouteCostService.js',
  'backend-node/src/services/providerRouteStabilityService.js',
  'backend-node/src/services/providerRuntimeFingerprintService.js',
  'backend-node/src/services/text-generation-billing-service.js',
  'backend-node/src/services/videoClient.js',
  'backend-node/src/services/videoService.js',
  'backend-node/test/aiConfigPublicView.test.js',
  'backend-node/test/appBackgroundServices.test.js',
  'backend-node/test/canvasModelCatalogService.test.js',
  'backend-node/test/featureLockManifest.test.js',
  'backend-node/test/generationCostLedger.test.js',
  'backend-node/test/generationRouteCostLedger.test.js',
  'backend-node/test/imageBilling.test.js',
  'backend-node/test/incrementalReleaseScope.test.js',
  'backend-node/test/modelPrice.test.js',
  'backend-node/test/platformFeatureInventory.test.js',
  'backend-node/test/providerAssetSignedAccess.test.js',
  'backend-node/test/providerCanaryAdminRoutes.test.js',
  'backend-node/test/providerCanaryArtifacts.test.js',
  'backend-node/test/providerCanaryBudget.test.js',
  'backend-node/test/providerCanaryEvidence.test.js',
  'backend-node/test/providerCanaryExecutor.test.js',
  'backend-node/test/providerCanaryFixtures.test.js',
  'backend-node/test/providerCanaryInvalidation.test.js',
  'backend-node/test/providerCanaryInventory.test.js',
  'backend-node/test/providerCanaryPublicGate.test.js',
  'backend-node/test/providerCanaryScheduler.test.js',
  'backend-node/test/providerCanaryTextConfig.test.js',
  'backend-node/test/providerRouteAdminRoutes.test.js',
  'backend-node/test/providerRouteCost.test.js',
  'backend-node/test/providerRouteSchema.test.js',
  'backend-node/test/providerRuntimeFingerprint.test.js',
  'backend-node/test/splitMultiModelProviderConfigs.test.js',
  'backend-node/test/text-generation-billing.test.js',
  'backend-node/test/videoBilling.test.js',
  'backend-node/test/videoQueryTaskStatusOnce.test.js',
  'deploy/release-scopes/platform-stability-proactive-canary.json',
  'docs/superpowers/plans/2026-08-18-platform-stability-proactive-canary-foundation.md',
  'docs/superpowers/plans/2026-08-20-evidence-bound-multi-model-split.md',
  'docs/superpowers/plans/2026-08-20-provider-route-cost-and-multi-model-split.md',
  'docs/superpowers/specs/2026-08-18-platform-stability-proactive-canary-design.md',
  'docs/superpowers/specs/2026-08-20-evidence-bound-multi-model-split-design.md',
  'docs/verification/platform-stability/feature-lock-manifest.json',
  'docs/verification/platform-stability/platform-feature-inventory.json',
  'docs/verification/platform-stability/platform-feature-inventory.schema.json',
  'docs/verification/platform-stability/proactive-canary-verification.md',
  'docs/verification/platform-stability/provider-canary-readiness.json',
  'docs/verification/platform-stability/provider-canary-readiness.schema.json',
  'docs/verification/platform-stability/provider-readiness-binding-candidate-20260820.md',
  'docs/verification/platform-stability/route-mapping-and-disk-operations-20260819.md',
  'frontweb/e2e/platform-zero-cost-smoke.spec.js',
  'frontweb/e2e/provider-stability-admin.spec.js',
  'frontweb/scripts/run-platform-zero-cost-smoke.mjs',
  'frontweb/src/api/providerStability.js',
  'frontweb/src/components/ProviderStabilityPanel.vue',
  'frontweb/test/platformZeroCostSmokeContract.test.js',
  'frontweb/test/providerRouteCostAdmin.test.js',
  'frontweb/test/providerStabilityAdmin.test.js',
];

function assertExactProactiveCanaryScope(allowedPaths) {
  assert.deepEqual(allowedPaths, PROACTIVE_CANARY_ALLOWED_PATHS);
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'incremental-release-scope-'));
  const parentRoot = path.join(root, 'parent');
  const candidateRoot = path.join(root, 'candidate');
  fs.mkdirSync(path.join(parentRoot, 'backend-node', 'src'), { recursive: true });
  fs.mkdirSync(path.join(candidateRoot, 'backend-node', 'src'), { recursive: true });
  fs.writeFileSync(path.join(parentRoot, 'backend-node', 'src', 'allowed.js'), 'old\n');
  fs.writeFileSync(path.join(candidateRoot, 'backend-node', 'src', 'allowed.js'), 'new\n');
  const manifestPath = path.join(root, 'scope.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    release: 'test-release',
    allowedPaths: ['backend-node/src/allowed.js'],
  }));
  return { root, parentRoot, candidateRoot, manifestPath };
}

test('增量门禁允许白名单内改动并校验 current 未漂移', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const report = verifyIncrementalReleaseScope({
    ...fixture,
    expectedCurrent: fixture.parentRoot,
    currentLink: fixture.parentRoot,
  });

  assert.equal(report.ready, true);
  assert.deepEqual(report.changedPaths, ['backend-node/src/allowed.js']);
});

test('增量门禁拒绝白名单外改动', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixture.candidateRoot, 'backend-node', 'src', 'pollution.js'), 'pollution\n');

  assert.throws(
    () => verifyIncrementalReleaseScope(fixture),
    (error) => error.code === 'SCOPE_VIOLATION'
      && error.details.unexpectedPaths.includes('backend-node/src/pollution.js'),
  );
});

test('增量门禁拒绝 current 漂移', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  assert.throws(
    () => verifyIncrementalReleaseScope({
      ...fixture,
      expectedCurrent: fixture.parentRoot,
      currentLink: fixture.candidateRoot,
    }),
    (error) => error.code === 'CURRENT_CHANGED',
  );
});

test('增量门禁拒绝路径穿越和清单哈希不匹配', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  fs.writeFileSync(fixture.manifestPath, JSON.stringify({
    schemaVersion: 1,
    allowedPaths: ['../outside.js'],
  }));
  assert.throws(() => loadManifest(fixture.manifestPath), { code: 'INVALID_MANIFEST' });
  assert.throws(
    () => loadManifest(fixture.manifestPath, '0'.repeat(64)),
    { code: 'MANIFEST_SHA256_MISMATCH' },
  );
});

test('主动巡检发布范围是精确文件白名单且排除运行数据与受保护服务', () => {
  const { manifest, allowedPaths } = loadManifest(proactiveCanaryManifestPath);
  assert.equal(manifest.release, 'platform-stability-proactive-canary');
  assertExactProactiveCanaryScope(allowedPaths);
  assert.equal(allowedPaths.every((entry) => !entry.includes('*') && !entry.endsWith('/')), true);

  for (const required of [
    'backend-node/migrations/60_provider_canary_guard.sql',
    'backend-node/migrations/63_provider_route_costs.sql',
    'backend-node/scripts/split-multi-model-provider-configs.js',
    'backend-node/src/services/providerRouteCostService.js',
    'backend-node/test/splitMultiModelProviderConfigs.test.js',
    'docs/superpowers/plans/2026-08-20-evidence-bound-multi-model-split.md',
    'docs/superpowers/plans/2026-08-20-provider-route-cost-and-multi-model-split.md',
    'docs/superpowers/specs/2026-08-20-evidence-bound-multi-model-split-design.md',
    'docs/verification/platform-stability/provider-readiness-binding-candidate-20260820.md',
    'frontweb/test/providerRouteCostAdmin.test.js',
    'backend-node/src/services/providerCanarySchedulerService.js',
    'backend-node/test/providerCanaryPublicGate.test.js',
    'docs/verification/platform-stability/proactive-canary-verification.md',
    'frontweb/e2e/platform-zero-cost-smoke.spec.js',
    'frontweb/src/components/ProviderStabilityPanel.vue',
    'deploy/release-scopes/platform-stability-proactive-canary.json',
  ]) {
    assert.ok(allowedPaths.includes(required), `发布范围缺少计划文件: ${required}`);
  }

  for (const forbidden of [
    'backend-node/data',
    'backend-node/uploads',
    'storage',
    'assets',
    'ai-music',
    'deploy/release-scopes/platform-stability-foundation.json',
    'deploy/install-protected-release-guard.sh',
    'shared/release-guard',
  ]) {
    assert.equal(
      allowedPaths.some((entry) => entry === forbidden || entry.startsWith(`${forbidden}/`)),
      false,
      `发布范围不得包含: ${forbidden}`,
    );
  }
});

test('主动巡检发布范围拒绝同数量偷换任一文件', () => {
  const swapped = [...PROACTIVE_CANARY_ALLOWED_PATHS];
  const index = swapped.indexOf('backend-node/src/services/providerCanaryBudgetService.js');
  swapped[index] = 'backend-node/data/drama_generator.db';
  assert.equal(swapped.length, PROACTIVE_CANARY_ALLOWED_PATHS.length);
  assert.throws(
    () => assertExactProactiveCanaryScope(swapped),
    { name: 'AssertionError' },
  );
});
