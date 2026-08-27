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
const completeAcceptanceManifestPath = path.join(
  repoRoot,
  'deploy',
  'release-scopes',
  'platform-complete-acceptance-framework.json',
);
const sharedFoundationManifestPath = path.join(
  repoRoot,
  'deploy',
  'release-scopes',
  'platform-complete-acceptance-shared-foundation.json',
);
const needsAttentionClosureManifestPath = path.join(
  repoRoot,
  'deploy',
  'release-scopes',
  'provider-needs-attention-state-closure-20260822.json',
);
const videoAudioCreditManifestPath = path.join(
  repoRoot,
  'deploy',
  'release-scopes',
  'video-audio-credit-reconciliation-20260822.json',
);
const providerTaskReceiptManifestPath = path.join(
  repoRoot,
  'deploy',
  'release-scopes',
  'provider-task-receipt-reconciliation-20260822.json',
);
const providerTaskLiveCompatManifestPath = path.join(
  repoRoot,
  'deploy',
  'release-scopes',
  'provider-task-receipt-live-compat-20260823.json',
);
const canvasTextCapabilityHotfixManifestPath = path.join(
  repoRoot,
  'deploy',
  'release-scopes',
  'canvas-text-capability-hotfix-20260824.json',
);
const redrawCoverageRegistrationManifestPath = path.join(
  repoRoot,
  'deploy',
  'release-scopes',
  'redraw-coverage-registration-task-b-20260827.json',
);
const redrawCoverageHttpRouteManifestPath = path.join(
  repoRoot,
  'deploy',
  'release-scopes',
  'redraw-coverage-http-route-task-c-20260827.json',
);
const redrawCoverageHttpProviderGateManifestPath = path.join(
  repoRoot,
  'deploy',
  'release-scopes',
  'redraw-coverage-http-provider-gate-task-c-p2-20260828.json',
);
const CANVAS_TEXT_CAPABILITY_HOTFIX_ALLOWED_PATHS = [
  'backend-node/src/services/providerCanaryEvidenceService.js',
  'backend-node/test/featureLockManifest.test.js',
  'backend-node/test/incrementalReleaseScope.test.js',
  'backend-node/test/providerCanaryPublicGate.test.js',
  'backend-node/test/providerRouteStability.test.js',
  'backend-node/test/providerRouteTextIntegration.test.js',
  'deploy/release-scopes/canvas-text-capability-hotfix-20260824.json',
  'docs/verification/platform-stability/canvas-text-capability-hotfix-20260824.md',
  'docs/verification/platform-stability/feature-lock-manifest.json',
];
const PROVIDER_TASK_LIVE_COMPAT_RUNTIME_REPAIR_PATHS = [
  'backend-node/src/db/migrate.js',
  'backend-node/src/services/videoClient.js',
  'backend-node/src/services/videoService.js',
];
const PROVIDER_TASK_LIVE_COMPAT_ALLOWED_PATHS = [
  'backend-node/scripts/apply-provider-task-live-compat.js',
  ...PROVIDER_TASK_LIVE_COMPAT_RUNTIME_REPAIR_PATHS,
  'backend-node/test/featureLockManifest.test.js',
  'backend-node/test/incrementalReleaseScope.test.js',
  'backend-node/test/providerTaskLiveCompatibility.test.js',
  'deploy/release-scopes/provider-task-receipt-live-compat-20260823.json',
  'docs/verification/platform-stability/feature-lock-manifest.json',
  'docs/verification/platform-stability/provider-task-receipt-live-compat-20260823.md',
];
const PROVIDER_TASK_RECEIPT_ALLOWED_PATHS = [
  'backend-node/migrations/64_provider_task_receipt_reconciliation.sql',
  'backend-node/src/app.js',
  'backend-node/src/routes/index.js',
  'backend-node/src/routes/providerStability.js',
  'backend-node/src/services/creditLedgerService.js',
  'backend-node/src/services/providerRouteStabilityService.js',
  'backend-node/src/services/providerTaskReconciliationService.js',
  'backend-node/src/services/videoClient.js',
  'backend-node/src/services/videoService.js',
  'backend-node/test/creditLedger.test.js',
  'backend-node/test/featureLockManifest.test.js',
  'backend-node/test/imageAssetModelFailover.test.js',
  'backend-node/test/incrementalReleaseScope.test.js',
  'backend-node/test/providerReconciliation.test.js',
  'backend-node/test/providerRouteImageIntegration.test.js',
  'backend-node/test/providerRouteSchema.test.js',
  'backend-node/test/providerRouteStability.test.js',
  'backend-node/test/providerRouteTextIntegration.test.js',
  'backend-node/test/providerRouteVideoIntegration.test.js',
  'backend-node/test/providerTaskAdminRoutes.test.js',
  'backend-node/test/providerTaskReconciliation.test.js',
  'backend-node/test/storyboardImageFailure.test.js',
  'backend-node/test/taskService.test.js',
  'backend-node/test/videoQueryTaskStatusOnce.test.js',
  'deploy/release-scopes/provider-task-receipt-reconciliation-20260822.json',
  'docs/superpowers/plans/2026-08-22-provider-task-receipt-reconciliation.md',
  'docs/superpowers/specs/2026-08-22-provider-task-receipt-reconciliation-design.md',
  'docs/verification/platform-stability/feature-lock-manifest.json',
  'docs/verification/platform-stability/provider-task-receipt-reconciliation-20260822.md',
];
const COMPLETE_ACCEPTANCE_ALLOWED_PATHS = [
  'backend-node/package.json',
  'backend-node/scripts/verify-platform-feature-acceptance.js',
  'backend-node/test/featureLockManifest.test.js',
  'backend-node/test/incrementalReleaseScope.test.js',
  'backend-node/test/platformFeatureAcceptance.test.js',
  'deploy/release-scopes/platform-complete-acceptance-framework.json',
  'docs/superpowers/plans/2026-08-21-platform-complete-acceptance-framework.md',
  'docs/superpowers/specs/2026-08-21-platform-complete-acceptance-lock-design.md',
  'docs/verification/platform-stability/feature-lock-manifest.json',
  'docs/verification/platform-stability/platform-complete-acceptance-framework-verification.md',
  'docs/verification/platform-stability/platform-feature-acceptance.json',
  'docs/verification/platform-stability/platform-feature-acceptance.schema.json',
];
const PROACTIVE_CANARY_ALLOWED_PATHS = [
  '.github/workflows/platform-zero-cost-smoke.yml',
  'backend-node/migrations/60_provider_canary_guard.sql',
  'backend-node/migrations/61_provider_canary_reconcile_claim.sql',
  'backend-node/migrations/62_provider_canary_admin_pagination.sql',
  'backend-node/migrations/63_provider_route_costs.sql',
  'backend-node/migrations/67_model_credit_price_free.sql',
  'backend-node/package-lock.json',
  'backend-node/package.json',
  'backend-node/scripts/audit-provider-canary-readiness.js',
  'backend-node/scripts/split-multi-model-provider-configs.js',
  'backend-node/scripts/verify-feature-lock-manifest.js',
  'backend-node/scripts/verify-platform-feature-inventory.js',
  'backend-node/src/app.js',
  'backend-node/src/db/migrate.js',
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
  'backend-node/src/services/redrawLocalizationOrchestrator.js',
  'backend-node/src/services/redrawOrchestrator.js',
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
  'backend-node/test/providerCanaryAudioArtifact.test.js',
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
  'backend-node/test/redrawAnalysis.test.js',
  'backend-node/test/redrawLocalizationOrchestration.test.js',
  'backend-node/test/splitMultiModelProviderConfigs.test.js',
  'backend-node/test/text-generation-billing.test.js',
  'backend-node/test/videoBilling.test.js',
  'backend-node/test/videoQueryTaskStatusOnce.test.js',
  'deploy/release-scopes/platform-stability-proactive-canary.json',
  'docs/superpowers/plans/2026-08-18-platform-stability-proactive-canary-foundation.md',
  'docs/superpowers/plans/2026-08-20-evidence-bound-multi-model-split.md',
  'docs/superpowers/plans/2026-08-20-provider-route-cost-and-multi-model-split.md',
  'docs/superpowers/plans/2026-08-23-provider-readiness-tts-canary.md',
  'docs/superpowers/specs/2026-08-18-platform-stability-proactive-canary-design.md',
  'docs/superpowers/specs/2026-08-20-evidence-bound-multi-model-split-design.md',
  'docs/verification/platform-stability/feature-lock-manifest.json',
  'docs/verification/platform-stability/platform-feature-inventory.json',
  'docs/verification/platform-stability/platform-feature-inventory.schema.json',
  'docs/verification/platform-stability/proactive-canary-verification.md',
  'docs/verification/platform-stability/provider-canary-readiness.json',
  'docs/verification/platform-stability/provider-canary-readiness.schema.json',
  'docs/verification/platform-stability/provider-readiness-binding-candidate-20260820.md',
  'docs/verification/platform-stability/provider-readiness-repair-manifest-20260823.md',
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
const SHARED_FOUNDATION_ALLOWED_PATHS = [
  '.github/workflows/frontend-e2e.yml',
  'backend-node/src/middleware/resourceOwnership.js',
  'backend-node/src/routes/auth.js',
  'backend-node/src/routes/billing.js',
  'backend-node/src/routes/index.js',
  'backend-node/src/services/creditLedgerService.js',
  'backend-node/src/services/subscriptionBillingService.js',
  'backend-node/src/services/userAuthService.js',
  'backend-node/test/featureLockManifest.test.js',
  'backend-node/test/incrementalReleaseScope.test.js',
  'backend-node/test/platformSharedAssetAcceptance.test.js',
  'backend-node/test/platformSharedAuthAcceptance.test.js',
  'backend-node/test/platformSharedBillingAcceptance.test.js',
  'backend-node/test/platformSharedCatalogAcceptance.test.js',
  'backend-node/test/platformSharedFoundationInventory.test.js',
  'backend-node/test/subscriptionBillingRoutes.test.js',
  'deploy/release-scopes/platform-complete-acceptance-shared-foundation.json',
  'docs/superpowers/plans/2026-08-22-platform-complete-acceptance-shared-foundation.md',
  'docs/verification/platform-stability/feature-lock-manifest.json',
  'docs/verification/platform-stability/platform-shared-foundation-verification.md',
  'frontweb/e2e/platform-shared-foundation-backend-integration.spec.js',
  'frontweb/package.json',
];
const NEEDS_ATTENTION_CLOSURE_ALLOWED_PATHS = [
  'backend-node/src/services/propImageGenerationService.js',
  'backend-node/src/services/providerReconciliationService.js',
  'backend-node/test/featureLockManifest.test.js',
  'backend-node/test/incrementalReleaseScope.test.js',
  'backend-node/test/prop-image-billing.test.js',
  'backend-node/test/providerReconciliation.test.js',
  'backend-node/test/taskService.test.js',
  'deploy/release-scopes/provider-needs-attention-state-closure-20260822.json',
  'docs/verification/platform-stability/feature-lock-manifest.json',
  'docs/verification/platform-stability/provider-needs-attention-state-closure-20260822.md',
];
const VIDEO_AUDIO_CREDIT_ALLOWED_PATHS = [
  'backend-node/src/services/providerReconciliationService.js',
  'backend-node/test/featureLockManifest.test.js',
  'backend-node/test/incrementalReleaseScope.test.js',
  'backend-node/test/providerReconciliation.test.js',
  'deploy/release-scopes/video-audio-credit-reconciliation-20260822.json',
  'docs/verification/platform-stability/feature-lock-manifest.json',
  'docs/verification/platform-stability/video-audio-credit-reconciliation-20260822.md',
  'frontweb/src/components/dramaCanvas/HomeCanvasNode.vue',
  'frontweb/src/utils/freeCanvasGeneration.js',
  'frontweb/src/views/DramaCanvas.vue',
  'frontweb/test/standaloneCanvasFreeNodeGeneration.test.js',
  'frontweb/test/toapisVideoCanvasContract.test.js',
];
const REDRAW_COVERAGE_REGISTRATION_ALLOWED_PATHS = [
  'backend-node/migrations/68_redraw_coverage_registrations.sql',
  'backend-node/src/services/redrawCoverageRegistrationService.js',
  'backend-node/test/redrawCoverageRegistration.test.js',
  'backend-node/test/featureLockManifest.test.js',
  'backend-node/test/incrementalReleaseScope.test.js',
  'deploy/release-scopes/redraw-coverage-registration-task-b-20260827.json',
  'docs/superpowers/plans/2026-08-27-redraw-product-media-registration.md',
  'docs/superpowers/specs/2026-08-27-redraw-product-media-registration-addendum.md',
  'docs/verification/platform-stability/feature-lock-manifest.json',
];
const REDRAW_COVERAGE_HTTP_ROUTE_ALLOWED_PATHS = [
  'backend-node/src/routes/index.js',
  'backend-node/src/routes/redraw.js',
  'backend-node/test/featureLockManifest.test.js',
  'backend-node/test/incrementalReleaseScope.test.js',
  'backend-node/test/redrawRoutes.test.js',
  'deploy/release-scopes/redraw-coverage-http-route-task-c-20260827.json',
  'docs/superpowers/plans/2026-08-27-redraw-product-media-registration.md',
  'docs/superpowers/specs/2026-08-27-redraw-product-media-registration-addendum.md',
  'docs/verification/platform-stability/feature-lock-manifest.json',
];
const REDRAW_COVERAGE_HTTP_PROVIDER_GATE_ALLOWED_PATHS = [
  'backend-node/src/routes/index.js',
  'backend-node/test/featureLockManifest.test.js',
  'backend-node/test/incrementalReleaseScope.test.js',
  'backend-node/test/redrawRoutes.test.js',
  'deploy/release-scopes/redraw-coverage-http-provider-gate-task-c-p2-20260828.json',
  'docs/verification/platform-stability/feature-lock-manifest.json',
];

function assertExactProactiveCanaryScope(allowedPaths) {
  assert.deepEqual(allowedPaths, PROACTIVE_CANARY_ALLOWED_PATHS);
}

function assertExactCompleteAcceptanceScope(allowedPaths) {
  assert.deepEqual(allowedPaths, COMPLETE_ACCEPTANCE_ALLOWED_PATHS);
}

function assertExactSharedFoundationScope(allowedPaths) {
  assert.deepEqual(allowedPaths, SHARED_FOUNDATION_ALLOWED_PATHS);
}

function assertExactNeedsAttentionClosureScope(allowedPaths) {
  assert.deepEqual(allowedPaths, NEEDS_ATTENTION_CLOSURE_ALLOWED_PATHS);
}

function assertExactVideoAudioCreditScope(allowedPaths) {
  assert.deepEqual(allowedPaths, VIDEO_AUDIO_CREDIT_ALLOWED_PATHS);
}

function assertExactProviderTaskReceiptScope(allowedPaths) {
  assert.deepEqual(allowedPaths, PROVIDER_TASK_RECEIPT_ALLOWED_PATHS);
}

function assertExactCanvasTextCapabilityHotfixScope(allowedPaths) {
  assert.deepEqual(allowedPaths, CANVAS_TEXT_CAPABILITY_HOTFIX_ALLOWED_PATHS);
}

function assertExactRedrawCoverageRegistrationScope(allowedPaths) {
  assert.deepEqual(allowedPaths, REDRAW_COVERAGE_REGISTRATION_ALLOWED_PATHS);
}

function assertExactRedrawCoverageHttpRouteScope(allowedPaths) {
  assert.deepEqual(allowedPaths, REDRAW_COVERAGE_HTTP_ROUTE_ALLOWED_PATHS);
}

function assertExactRedrawCoverageHttpProviderGateScope(allowedPaths) {
  assert.deepEqual(allowedPaths, REDRAW_COVERAGE_HTTP_PROVIDER_GATE_ALLOWED_PATHS);
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
    'backend-node/test/providerCanaryAudioArtifact.test.js',
    'docs/superpowers/plans/2026-08-23-provider-readiness-tts-canary.md',
    'docs/verification/platform-stability/provider-readiness-repair-manifest-20260823.md',
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

test('画布文本能力兼容修复发布范围是精确 9 文件白名单', () => {
  const { manifest, allowedPaths } = loadManifest(canvasTextCapabilityHotfixManifestPath);
  assert.equal(manifest.release, 'canvas-text-capability-hotfix-20260824');
  assertExactCanvasTextCapabilityHotfixScope(allowedPaths);
  assert.equal(allowedPaths.every((entry) => !entry.includes('*') && !entry.endsWith('/')), true);

  for (const forbidden of [
    'backend-node/data',
    'backend-node/uploads',
    'storage',
    'assets',
    'ai-music',
    'moli-music',
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

test('画布文本能力兼容修复发布范围拒绝同数量偷换任一文件', () => {
  const swapped = [...CANVAS_TEXT_CAPABILITY_HOTFIX_ALLOWED_PATHS];
  const index = swapped.indexOf('backend-node/src/services/providerCanaryEvidenceService.js');
  swapped[index] = 'backend-node/data/drama_generator.db';
  assert.equal(swapped.length, CANVAS_TEXT_CAPABILITY_HOTFIX_ALLOWED_PATHS.length);
  assert.throws(
    () => assertExactCanvasTextCapabilityHotfixScope(swapped),
    { name: 'AssertionError' },
  );
});

test('Coverage 产品登记 Task B 发布范围是精确 9 文件白名单', () => {
  const { manifest, allowedPaths } = loadManifest(redrawCoverageRegistrationManifestPath);
  assert.equal(manifest.release, 'redraw-coverage-registration-task-b-20260827');
  assertExactRedrawCoverageRegistrationScope(allowedPaths);
  assert.equal(allowedPaths.every((entry) => !entry.includes('*') && !entry.endsWith('/')), true);

  for (const forbidden of [
    'backend-node/data',
    'backend-node/uploads',
    'storage',
    'assets',
    'ai-music',
    'moli-music',
    'backend-node/src/routes/redraw.js',
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

test('Coverage 产品登记 Task B 发布范围拒绝同数量偷换任一文件', () => {
  const swapped = [...REDRAW_COVERAGE_REGISTRATION_ALLOWED_PATHS];
  const index = swapped.indexOf('backend-node/src/services/redrawCoverageRegistrationService.js');
  swapped[index] = 'backend-node/src/routes/redraw.js';
  assert.equal(swapped.length, REDRAW_COVERAGE_REGISTRATION_ALLOWED_PATHS.length);
  assert.throws(
    () => assertExactRedrawCoverageRegistrationScope(swapped),
    { name: 'AssertionError' },
  );
});

test('Coverage HTTP 入口 Task C 发布范围是精确 9 文件白名单', () => {
  const { manifest, allowedPaths } = loadManifest(redrawCoverageHttpRouteManifestPath);
  assert.equal(manifest.release, 'redraw-coverage-http-route-task-c-20260827');
  assertExactRedrawCoverageHttpRouteScope(allowedPaths);
  assert.equal(allowedPaths.every((entry) => !entry.includes('*') && !entry.endsWith('/')), true);

  for (const forbidden of [
    'backend-node/data',
    'backend-node/uploads',
    'backend-node/src/services/redrawCoverageRegistrationService.js',
    'storage',
    'assets',
    'ai-music',
    'moli-music',
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

test('Coverage HTTP 入口 Task C 发布范围拒绝同数量偷换任一文件', () => {
  const swapped = [...REDRAW_COVERAGE_HTTP_ROUTE_ALLOWED_PATHS];
  const index = swapped.indexOf('backend-node/src/routes/redraw.js');
  swapped[index] = 'backend-node/src/services/redrawCoverageRegistrationService.js';
  assert.equal(swapped.length, REDRAW_COVERAGE_HTTP_ROUTE_ALLOWED_PATHS.length);
  assert.throws(
    () => assertExactRedrawCoverageHttpRouteScope(swapped),
    { name: 'AssertionError' },
  );
});

test('Coverage HTTP provider 门禁 Task C P2 发布范围是精确 6 文件白名单', () => {
  const { manifest, allowedPaths } = loadManifest(redrawCoverageHttpProviderGateManifestPath);
  assert.equal(manifest.release, 'redraw-coverage-http-provider-gate-task-c-p2-20260828');
  assertExactRedrawCoverageHttpProviderGateScope(allowedPaths);
  assert.equal(allowedPaths.every((entry) => !entry.includes('*') && !entry.endsWith('/')), true);

  for (const forbidden of [
    'backend-node/data',
    'backend-node/uploads',
    'backend-node/src/routes/redraw.js',
    'backend-node/src/services/redrawCoverageRegistrationService.js',
    'storage',
    'assets',
    'ai-music',
    'moli-music',
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

test('Coverage HTTP provider 门禁 Task C P2 发布范围拒绝同数量偷换', () => {
  const swapped = [...REDRAW_COVERAGE_HTTP_PROVIDER_GATE_ALLOWED_PATHS];
  const index = swapped.indexOf('backend-node/src/routes/index.js');
  swapped[index] = 'backend-node/src/services/redrawCoverageRegistrationService.js';
  assert.equal(swapped.length, REDRAW_COVERAGE_HTTP_PROVIDER_GATE_ALLOWED_PATHS.length);
  assert.throws(
    () => assertExactRedrawCoverageHttpProviderGateScope(swapped),
    { name: 'AssertionError' },
  );
});

test('完整验收框架发布范围是精确 12 文件白名单且排除生产数据与业务源文件', () => {
  const { manifest, allowedPaths } = loadManifest(completeAcceptanceManifestPath);
  assert.equal(manifest.release, 'platform-complete-acceptance-framework');
  assertExactCompleteAcceptanceScope(allowedPaths);
  assert.equal(allowedPaths.every((entry) => !entry.includes('*') && !entry.endsWith('/')), true);

  for (const forbidden of [
    'backend-node/data',
    'backend-node/uploads',
    'backend-node/src',
    'frontweb/src',
    'storage',
    'assets',
    'ai-music',
    'moli-music',
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

test('完整验收框架发布范围拒绝同数量偷换任一文件', () => {
  const swapped = [...COMPLETE_ACCEPTANCE_ALLOWED_PATHS];
  const index = swapped.indexOf('backend-node/scripts/verify-platform-feature-acceptance.js');
  swapped[index] = 'backend-node/data/drama_generator.db';
  assert.equal(swapped.length, COMPLETE_ACCEPTANCE_ALLOWED_PATHS.length);
  assert.throws(
    () => assertExactCompleteAcceptanceScope(swapped),
    { name: 'AssertionError' },
  );
});

test('公共运行底座发布范围是精确 22 文件白名单且排除运行数据与受保护服务', () => {
  const { manifest, allowedPaths } = loadManifest(sharedFoundationManifestPath);
  assert.equal(manifest.release, 'platform-complete-acceptance-shared-foundation');
  assertExactSharedFoundationScope(allowedPaths);
  assert.equal(allowedPaths.every((entry) => !entry.includes('*') && !entry.endsWith('/')), true);

  for (const forbidden of [
    'backend-node/data',
    'backend-node/uploads',
    'storage',
    'assets',
    'ai-music',
    'moli-music',
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

test('公共运行底座发布范围拒绝同数量偷换任一文件', () => {
  const swapped = [...SHARED_FOUNDATION_ALLOWED_PATHS];
  const index = swapped.indexOf('backend-node/src/services/userAuthService.js');
  swapped[index] = 'backend-node/data/drama_generator.db';
  assert.equal(swapped.length, SHARED_FOUNDATION_ALLOWED_PATHS.length);
  assert.throws(
    () => assertExactSharedFoundationScope(swapped),
    { name: 'AssertionError' },
  );
});

test('结果未知状态收口发布范围是精确 10 文件白名单', () => {
  const { manifest, allowedPaths } = loadManifest(needsAttentionClosureManifestPath);
  assert.equal(manifest.release, 'provider-needs-attention-state-closure-20260822');
  assertExactNeedsAttentionClosureScope(allowedPaths);
  assert.equal(allowedPaths.every((entry) => !entry.includes('*') && !entry.endsWith('/')), true);

  for (const forbidden of [
    'backend-node/data',
    'backend-node/uploads',
    'storage',
    'assets',
    'ai-music',
    'moli-music',
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

test('结果未知状态收口发布范围拒绝同数量偷换任一文件', () => {
  const swapped = [...NEEDS_ATTENTION_CLOSURE_ALLOWED_PATHS];
  const index = swapped.indexOf('backend-node/src/services/providerReconciliationService.js');
  swapped[index] = 'backend-node/data/drama_generator.db';
  assert.equal(swapped.length, NEEDS_ATTENTION_CLOSURE_ALLOWED_PATHS.length);
  assert.throws(
    () => assertExactNeedsAttentionClosureScope(swapped),
    { name: 'AssertionError' },
  );
});

test('视频音频与冻结积分收口发布范围是精确 12 文件白名单', () => {
  const { manifest, allowedPaths } = loadManifest(videoAudioCreditManifestPath);
  assert.equal(manifest.release, 'video-audio-credit-reconciliation-20260822');
  assertExactVideoAudioCreditScope(allowedPaths);
  assert.equal(allowedPaths.every((entry) => !entry.includes('*') && !entry.endsWith('/')), true);

  for (const forbidden of [
    'backend-node/data',
    'backend-node/uploads',
    'storage',
    'assets',
    'ai-music',
    'moli-music',
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

test('视频音频与冻结积分收口发布范围拒绝同数量偷换任一文件', () => {
  const swapped = [...VIDEO_AUDIO_CREDIT_ALLOWED_PATHS];
  const index = swapped.indexOf('backend-node/src/services/providerReconciliationService.js');
  swapped[index] = 'backend-node/data/drama_generator.db';
  assert.equal(swapped.length, VIDEO_AUDIO_CREDIT_ALLOWED_PATHS.length);
  assert.throws(
    () => assertExactVideoAudioCreditScope(swapped),
    { name: 'AssertionError' },
  );
});

test('供应商任务不可变凭证历史发布范围固定为精确 29 个路径', () => {
  const { manifest, allowedPaths } = loadManifest(providerTaskReceiptManifestPath);
  assert.equal(manifest.release, 'provider-task-receipt-reconciliation-20260822');
  assertExactProviderTaskReceiptScope(allowedPaths);
  assert.equal(allowedPaths.every((entry) => !entry.includes('*') && !entry.endsWith('/')), true);

  for (const forbidden of [
    'backend-node/data',
    'backend-node/uploads',
    'storage',
    'assets',
    'ai-music',
    'moli-music',
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

test('供应商任务不可变凭证发布范围拒绝同数量偷换任一文件', () => {
  const swapped = [...PROVIDER_TASK_RECEIPT_ALLOWED_PATHS];
  const index = swapped.indexOf('backend-node/src/services/providerTaskReconciliationService.js');
  swapped[index] = 'backend-node/data/drama_generator.db';
  assert.equal(swapped.length, PROVIDER_TASK_RECEIPT_ALLOWED_PATHS.length);
  assert.throws(
    () => assertExactProviderTaskReceiptScope(swapped),
    { name: 'AssertionError' },
  );
});

test('供应商任务线上兼容补丁使用独立十文件范围并显式声明三处运行时修复', () => {
  const { manifest, allowedPaths } = loadManifest(providerTaskLiveCompatManifestPath);
  assert.equal(manifest.release, 'provider-task-receipt-live-compat-20260823');
  assert.deepEqual(allowedPaths, PROVIDER_TASK_LIVE_COMPAT_ALLOWED_PATHS);
  assert.deepEqual(manifest.runtimeRepairPaths, PROVIDER_TASK_LIVE_COMPAT_RUNTIME_REPAIR_PATHS);
  assert.equal(allowedPaths.every((entry) => !entry.includes('*') && !entry.endsWith('/')), true);
  assert.equal(manifest.runtimeRepairPaths.every((entry) => allowedPaths.includes(entry)), true);
  for (const forbidden of [
    'backend-node/data',
    'backend-node/uploads',
    'storage',
    'assets',
    'ai-music',
    'moli-music',
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

test('供应商任务线上兼容补丁范围拒绝同数量偷换运行时文件', () => {
  const swapped = [...PROVIDER_TASK_LIVE_COMPAT_ALLOWED_PATHS];
  swapped[swapped.indexOf('backend-node/src/db/migrate.js')] = 'backend-node/data/drama_generator.db';
  assert.equal(swapped.length, PROVIDER_TASK_LIVE_COMPAT_ALLOWED_PATHS.length);
  assert.notDeepEqual(swapped, PROVIDER_TASK_LIVE_COMPAT_ALLOWED_PATHS);
});
