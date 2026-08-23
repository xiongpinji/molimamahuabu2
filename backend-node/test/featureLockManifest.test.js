'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const manifestPath = path.join(
  repoRoot,
  'docs',
  'verification',
  'platform-stability',
  'feature-lock-manifest.json',
);
const {
  loadAndVerifyCurrentManifest,
  verifyFeatureLock,
} = require('../scripts/verify-feature-lock-manifest');

const PROACTIVE_CANARY_FEATURE_ID = 'stability.proactive-canary-and-public-evidence';
const ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID = 'stability.admin-provider-observability';
const COMPLETE_ACCEPTANCE_FRAMEWORK_ID = 'stability.platform-complete-acceptance-framework';
const UNKNOWN_STATE_RECONCILIATION_FEATURE_ID = 'stability.unknown-state-billing-reconciliation';
const PROVIDER_ROUTE_CONTRACT_FEATURE_ID = 'stability.provider-route-contract';
const SAFE_PROVIDER_FAILOVER_FEATURE_ID = 'stability.safe-provider-failover';
const PROVIDER_TASK_LIVE_COMPAT_EVIDENCE =
  'docs/verification/platform-stability/provider-task-receipt-live-compat-20260823.md';
const PROVIDER_TASK_LIVE_COMPAT_UNLOCK = {
  reason: '2026-08-23 供应商任务实时候选三处兼容修复获批',
  approvedBy: 'product-owner 2026-08-23 provider-task-live-candidate-compatibility',
  impactTests: [
    'backend-node/test/providerTaskLiveCompatibility.test.js',
    'backend-node/test/providerRouteSchema.test.js',
    'backend-node/test/providerRouteVideoIntegration.test.js',
    'backend-node/test/providerTaskReconciliation.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
const PROVIDER_READINESS_TTS_EVIDENCE = [
  'docs/superpowers/plans/2026-08-23-provider-readiness-tts-canary.md',
  'docs/verification/platform-stability/provider-readiness-repair-manifest-20260823.md',
];
const PROVIDER_READINESS_TTS_REQUIRED_TESTS = [
  'backend-node/test/providerCanaryAudioArtifact.test.js',
  'backend-node/test/providerCanaryExecutor.test.js',
  'backend-node/test/providerCanaryInventory.test.js',
  'backend-node/test/providerCanaryScheduler.test.js',
  'backend-node/test/providerRuntimeFingerprint.test.js',
];
const PROVIDER_READINESS_TTS_UNLOCK = {
  reason: '2026-08-23 TTS 主动巡检闭环与功能锁修复获批',
  approvedBy: 'product-owner 2026-08-23 provider-readiness-tts-canary-ci-lock',
  impactTests: [
    ...PROVIDER_READINESS_TTS_REQUIRED_TESTS,
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const PROVIDER_TTS_CHARACTER_COST_UNLOCK = {
  reason: '2026-08-23 TTS 主动巡检按字符成本获批',
  approvedBy: 'product-owner 2026-08-23 provider-tts-character-cost',
  impactTests: [
    'backend-node/test/providerCanaryExecutor.test.js',
    'backend-node/test/providerRouteCost.test.js',
    'backend-node/test/providerRouteSchema.test.js',
    'frontweb/test/providerRouteCostAdmin.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const PLATFORM_ZERO_COST_SMOKE_READ_AUTH_UNLOCK = {
  reason: '2026-08-23 平台零成本巡检复用已认证目录响应并修正只读分类获批',
  approvedBy: 'product-owner 2026-08-23 platform-zero-cost-smoke-read-auth',
  impactTests: [
    'frontweb/test/platformZeroCostSmokeContract.test.js',
    'frontweb/e2e/platform-zero-cost-smoke.spec.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const PLATFORM_ZERO_COST_SMOKE_FIXTURE_GUARD_UNLOCK = {
  reason: '2026-08-23 平台零成本巡检生产模式 fixture 写入误报修复获批',
  approvedBy: 'product-owner 2026-08-23 platform-zero-cost-smoke-fixture-guard',
  impactTests: [
    'frontweb/test/platformZeroCostSmokeContract.test.js',
    'frontweb/e2e/platform-zero-cost-smoke.spec.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const PROVIDER_ROUTE_TTS_CHARACTER_COST_UNLOCK = {
  reason: '2026-08-23 TTS 线路按字符成本与旧库约束升级获批',
  approvedBy: 'product-owner 2026-08-23 provider-tts-character-cost',
  impactTests: [
    'backend-node/test/providerRouteCost.test.js',
    'backend-node/test/providerRouteSchema.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
const ADMIN_PROVIDER_TTS_CHARACTER_COST_UNLOCK = {
  reason: '2026-08-23 管理员 TTS 按字符线路成本配置获批',
  approvedBy: 'product-owner 2026-08-23 provider-tts-character-cost',
  impactTests: [
    'frontweb/test/providerRouteCostAdmin.test.js',
    'backend-node/test/providerRouteCost.test.js',
    'backend-node/test/providerRouteSchema.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const PROVIDER_TASK_RECEIPT_EVIDENCE = [
  'docs/superpowers/specs/2026-08-22-provider-task-receipt-reconciliation-design.md',
  'docs/superpowers/plans/2026-08-22-provider-task-receipt-reconciliation.md',
  'docs/verification/platform-stability/provider-task-receipt-reconciliation-20260822.md',
];
const PROVIDER_TASK_RECEIPT_UNLOCK = {
  reason: '2026-08-22 供应商任务不可变凭证与安全对账规格获批',
  approvedBy: 'product-owner 2026-08-22 provider-task-receipt-reconciliation',
  impactTests: [
    'backend-node/test/providerRouteSchema.test.js',
    'backend-node/test/providerRouteStability.test.js',
    'backend-node/test/providerRouteVideoIntegration.test.js',
    'backend-node/test/providerTaskReconciliation.test.js',
    'backend-node/test/providerTaskAdminRoutes.test.js',
    'backend-node/test/videoQueryTaskStatusOnce.test.js',
    'backend-node/test/videoBilling.test.js',
    'backend-node/test/generationRouteCostLedger.test.js',
    'backend-node/test/creditLedger.test.js',
    'backend-node/test/providerReconciliation.test.js',
    'backend-node/test/imageAssetModelFailover.test.js',
    'backend-node/test/providerRouteImageIntegration.test.js',
    'backend-node/test/providerRouteTextIntegration.test.js',
    'backend-node/test/storyboardImageFailure.test.js',
    'backend-node/test/taskService.test.js',
  ],
};
const PROVIDER_TASK_ARTIFACT_QUALITY_UNLOCK = {
  reason: '2026-08-23 无产物视频任务冻结积分质量修复获批',
  approvedBy: 'product-owner 2026-08-23 provider-task-artifact-unreadable',
  impactTests: [
    'backend-node/test/videoQueryTaskStatusOnce.test.js',
    'backend-node/test/providerTaskReconciliation.test.js',
    'backend-node/test/providerRouteVideoIntegration.test.js',
    'backend-node/test/videoBilling.test.js',
    'backend-node/test/creditLedger.test.js',
    'backend-node/test/providerReconciliation.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const LEGACY_DJPSD_STRICT_ARTIFACT_UNLOCK = {
  reason: '2026-08-23 旧版 DJPSD 严格完成无产物安全收口获批',
  approvedBy: 'product-owner 2026-08-23 legacy-djpsd-strict-completed-artifact-unreadable',
  impactTests: [
    'backend-node/test/videoQueryTaskStatusOnce.test.js',
    'backend-node/test/providerTaskReconciliation.test.js',
    'backend-node/test/providerRouteVideoIntegration.test.js',
    'backend-node/test/videoBilling.test.js',
    'backend-node/test/creditLedger.test.js',
    'backend-node/test/providerReconciliation.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const ASYNC_VIDEO_PROTOCOL_ARTIFACT_UNLOCK = {
  reason: '2026-08-23 全异步视频协议无产物分类统一收口获批',
  approvedBy: 'product-owner 2026-08-23 async-video-protocol-artifact-unreadable',
  impactTests: [
    'backend-node/test/videoQueryTaskStatusOnce.test.js',
    'backend-node/test/providerTaskReconciliation.test.js',
    'backend-node/test/providerRouteVideoIntegration.test.js',
    'backend-node/test/toapisVideoIntegration.test.js',
    'backend-node/test/feituoVideoModels.test.js',
    'backend-node/test/videoBilling.test.js',
    'backend-node/test/creditLedger.test.js',
    'backend-node/test/providerReconciliation.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const PROVIDER_TASK_STATUS_DECISION_UNLOCK = {
  reason: '2026-08-23 供应商任务按状态判定结构安全收口获批',
  approvedBy: 'product-owner 2026-08-23 provider-task-status-decision-structure',
  impactTests: [
    'backend-node/test/videoQueryTaskStatusOnce.test.js',
    'backend-node/test/providerTaskReconciliation.test.js',
    'backend-node/test/providerRouteVideoIntegration.test.js',
    'backend-node/test/toapisVideoIntegration.test.js',
    'backend-node/test/feituoVideoModels.test.js',
    'backend-node/test/videoBilling.test.js',
    'backend-node/test/creditLedger.test.js',
    'backend-node/test/providerReconciliation.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const PROVIDER_TASK_ARTIFACT_QUALITY_FEATURE_IDS = new Set([
  SAFE_PROVIDER_FAILOVER_FEATURE_ID,
  UNKNOWN_STATE_RECONCILIATION_FEATURE_ID,
  PROACTIVE_CANARY_FEATURE_ID,
]);
const PROVIDER_TASK_LIVE_COMPAT_FEATURE_IDS = new Set([
  PROVIDER_ROUTE_CONTRACT_FEATURE_ID,
  SAFE_PROVIDER_FAILOVER_FEATURE_ID,
  UNKNOWN_STATE_RECONCILIATION_FEATURE_ID,
  PROACTIVE_CANARY_FEATURE_ID,
]);
const PR177_ROOT_ONLY_REASON = '2026-08-22 PR #177 root-only Hosted CI 隔离补充修复获批';
const PR177_ROOT_ONLY_APPROVED_BY = 'product-owner 2026-08-22 pr-177-root-only-isolation-closure';
const PR177_PROVIDER_ROUTE_UNLOCK = {
  reason: PR177_ROOT_ONLY_REASON,
  approvedBy: PR177_ROOT_ONLY_APPROVED_BY,
  impactTests: [
    'backend-node/test/providerCanaryInvalidation.test.js',
    'backend-node/test/providerCanaryPublicGate.test.js',
    'backend-node/test/providerCanaryAdminRoutes.test.js',
    'backend-node/test/providerRouteStability.test.js',
    'backend-node/test/providerRouteCost.test.js',
    'backend-node/test/generationRouteCostLedger.test.js',
  ],
};
const PR177_VIDEO_REFERENCE_UNLOCK = {
  reason: '2026-08-22 PR #177 主线同步视频参考证据修复获批',
  approvedBy: 'product-owner 2026-08-22 pr-177-main-sync-closure',
  impactTests: [
    'backend-node/test/providerRouteVideoIntegration.test.js',
    'backend-node/test/toapisVideoClient.test.js',
    'backend-node/test/videoBilling.test.js',
    'frontweb/e2e/home-canvas.spec.js',
  ],
};
const PR177_UNKNOWN_STATE_UNLOCK = {
  reason: PR177_ROOT_ONLY_REASON,
  approvedBy: PR177_ROOT_ONLY_APPROVED_BY,
  impactTests: [
    'backend-node/test/providerReconciliation.test.js',
    'backend-node/test/billingReconciliation.test.js',
    'backend-node/test/taskService.test.js',
    'backend-node/test/providerRouteImageIntegration.test.js',
    'backend-node/test/providerRouteVideoIntegration.test.js',
    'backend-node/test/prop-image-billing.test.js',
    'backend-node/test/propImageErrorState.test.js',
    'backend-node/test/creditLedger.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const PR177_SHARED_FOUNDATION_UNLOCK = {
  reason: PR177_ROOT_ONLY_REASON,
  approvedBy: PR177_ROOT_ONLY_APPROVED_BY,
  impactTests: [
    'backend-node/test/platformSharedAssetAcceptance.test.js',
    'backend-node/test/platformSharedAuthAcceptance.test.js',
    'backend-node/test/platformSharedBillingAcceptance.test.js',
    'backend-node/test/platformSharedCatalogAcceptance.test.js',
    'backend-node/test/platformSharedFoundationInventory.test.js',
    'backend-node/test/subscriptionBillingRoutes.test.js',
    'frontweb/e2e/platform-shared-foundation-backend-integration.spec.js',
  ],
};
const PR177_PLATFORM_ACCEPTANCE_UNLOCK = {
  reason: PR177_ROOT_ONLY_REASON,
  approvedBy: PR177_ROOT_ONLY_APPROVED_BY,
  impactTests: [
    'backend-node/test/platformFeatureAcceptance.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
const PR177_UNLOCK_BY_FEATURE = {
  [PROVIDER_ROUTE_CONTRACT_FEATURE_ID]: PR177_PROVIDER_ROUTE_UNLOCK,
  [SAFE_PROVIDER_FAILOVER_FEATURE_ID]: PR177_VIDEO_REFERENCE_UNLOCK,
  [UNKNOWN_STATE_RECONCILIATION_FEATURE_ID]: PR177_UNKNOWN_STATE_UNLOCK,
  [ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID]: PR177_SHARED_FOUNDATION_UNLOCK,
  [PROACTIVE_CANARY_FEATURE_ID]: PR177_SHARED_FOUNDATION_UNLOCK,
};
const PR184_MAIN_MERGE_UNLOCK = {
  reason: '2026-08-23 PR #184 合入最新 main 并收口 17 项冲突获批',
  approvedBy: 'product-owner 2026-08-23 pr-184-main-merge-conflict-resolution',
  impactTests: [
    'backend-node/test/providerCanaryAudioArtifact.test.js',
    'backend-node/test/providerCanaryExecutor.test.js',
    'backend-node/test/providerCanaryInventory.test.js',
    'backend-node/test/providerCanaryScheduler.test.js',
    'backend-node/test/providerRouteCost.test.js',
    'backend-node/test/providerRouteSchema.test.js',
    'backend-node/test/providerRuntimeFingerprint.test.js',
    'backend-node/test/providerTaskLiveCompatibility.test.js',
    'frontweb/test/platformZeroCostSmokeContract.test.js',
    'frontweb/test/providerRouteCostAdmin.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const PRE_PR184_CURRENT_UNLOCK_BY_FEATURE = {
  [PROVIDER_ROUTE_CONTRACT_FEATURE_ID]: PROVIDER_ROUTE_TTS_CHARACTER_COST_UNLOCK,
  [SAFE_PROVIDER_FAILOVER_FEATURE_ID]: PROVIDER_TASK_LIVE_COMPAT_UNLOCK,
  [UNKNOWN_STATE_RECONCILIATION_FEATURE_ID]: PROVIDER_TASK_LIVE_COMPAT_UNLOCK,
  [ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID]: ADMIN_PROVIDER_TTS_CHARACTER_COST_UNLOCK,
  [PROACTIVE_CANARY_FEATURE_ID]: PLATFORM_ZERO_COST_SMOKE_FIXTURE_GUARD_UNLOCK,
};
const COMPLETE_ACCEPTANCE_ACCEPTANCE = [
  '来源功能清单与验收决策账本通过 SHA 和 feature_id 一致性绑定',
  '未登记功能保持 unverified，阻断功能不能伪装为通过',
  '锁定功能必须覆盖适用证据链、Hosted CI、生产回读和功能锁证据',
];
const COMPLETE_ACCEPTANCE_PROTECTED_PATHS = [
  'backend-node/scripts/verify-platform-feature-acceptance.js',
  'docs/verification/platform-stability/platform-feature-inventory.json',
  'docs/verification/platform-stability/platform-feature-inventory.schema.json',
  'docs/verification/platform-stability/platform-feature-acceptance.json',
  'docs/verification/platform-stability/platform-feature-acceptance.schema.json',
];
const COMPLETE_ACCEPTANCE_REQUIRED_TESTS = [
  'backend-node/test/platformFeatureInventory.test.js',
  'backend-node/test/platformFeatureAcceptance.test.js',
  'backend-node/test/featureLockManifest.test.js',
];
const COMPLETE_ACCEPTANCE_EVIDENCE = [
  'docs/superpowers/specs/2026-08-21-platform-complete-acceptance-lock-design.md',
  'docs/superpowers/plans/2026-08-21-platform-complete-acceptance-framework.md',
  'docs/verification/platform-stability/platform-complete-acceptance-framework-verification.md',
];
const COMPLETE_ACCEPTANCE_UNLOCK = {
  reason: '2026-08-22 修复 Hosted CI 跨平台验收清单哈希',
  approvedBy: 'product-owner 开始处理下一步确认',
  impactTests: [
    'backend-node/test/platformFeatureAcceptance.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
const PROACTIVE_CANARY_ACCEPTANCE = [
  '公开线路只有匹配的新鲜真实证据才能进入严格候选',
  '巡检预算日月原子受限且未知结果保留占用',
  '巡检不污染用户资产、生成记录和积分',
  '管理员可见线路证据预算，普通用户不泄露供应商与成本',
];
const PROACTIVE_CANARY_EVIDENCE = [
  'docs/superpowers/specs/2026-08-18-platform-stability-proactive-canary-design.md',
  'docs/superpowers/plans/2026-08-18-platform-stability-proactive-canary-foundation.md',
  'docs/verification/platform-stability/provider-canary-readiness.json',
  'docs/verification/platform-stability/platform-feature-inventory.json',
  'docs/verification/platform-stability/proactive-canary-verification.md',
  'docs/verification/platform-stability/route-mapping-and-disk-operations-20260819.md',
  'docs/superpowers/plans/2026-08-20-provider-route-cost-and-multi-model-split.md',
  'docs/verification/platform-stability/provider-readiness-binding-candidate-20260820.md',
  'docs/superpowers/specs/2026-08-20-evidence-bound-multi-model-split-design.md',
  'docs/superpowers/plans/2026-08-20-evidence-bound-multi-model-split.md',
];
const SHARED_FOUNDATION_UNLOCK = {
  reason: '2026-08-22 公共运行底座阶段 1 书面计划获批',
  approvedBy: 'product-owner 2026-08-22 platform-shared-foundation',
  impactTests: [
    'backend-node/test/platformSharedAssetAcceptance.test.js',
    'backend-node/test/platformSharedAuthAcceptance.test.js',
    'backend-node/test/platformSharedBillingAcceptance.test.js',
    'backend-node/test/platformSharedCatalogAcceptance.test.js',
    'backend-node/test/platformSharedFoundationInventory.test.js',
    'backend-node/test/subscriptionBillingRoutes.test.js',
    'frontweb/e2e/platform-shared-foundation-backend-integration.spec.js',
  ],
};
const UNKNOWN_STATE_RECONCILIATION_UNLOCK = {
  reason: '2026-08-22 道具生图结果未知冻结积分收口本地授权',
  approvedBy: 'product-owner 2026-08-22 prop-image-held-reconciliation',
  impactTests: [
    'backend-node/test/providerReconciliation.test.js',
    'backend-node/test/billingReconciliation.test.js',
    'backend-node/test/prop-image-billing.test.js',
    'backend-node/test/propImageErrorState.test.js',
    'backend-node/test/creditLedger.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const PROVIDER_ROUTE_CLOSURE_UNLOCK = {
  reason: '2026-08-21 PR #171 供应商路由与发布门禁收口授权',
  approvedBy: 'product-owner 2026-08-21 pr-171-provider-route-closure',
  impactTests: [
    'backend-node/test/providerCanaryInvalidation.test.js',
    'backend-node/test/providerCanaryPublicGate.test.js',
    'backend-node/test/providerCanaryAdminRoutes.test.js',
    'backend-node/test/providerRouteStability.test.js',
    'backend-node/test/providerRouteCost.test.js',
    'backend-node/test/generationRouteCostLedger.test.js',
  ],
};
const SAFE_PROVIDER_FAILOVER_UNLOCK = {
  reason: '2026-08-21 PR #171 供应商路由与发布门禁收口授权',
  approvedBy: 'product-owner 2026-08-21 pr-171-provider-route-closure',
  impactTests: [
    'backend-node/test/providerCanaryExecutor.test.js',
    'backend-node/test/providerCanaryTextConfig.test.js',
    'backend-node/test/providerCanaryFixtures.test.js',
    'backend-node/test/providerCanaryArtifacts.test.js',
    'backend-node/test/imageBilling.test.js',
    'backend-node/test/text-generation-billing.test.js',
    'backend-node/test/videoBilling.test.js',
  ],
};
const HISTORICAL_UNLOCK_BY_FEATURE = {
  [PROVIDER_ROUTE_CONTRACT_FEATURE_ID]: PROVIDER_ROUTE_CLOSURE_UNLOCK,
  [SAFE_PROVIDER_FAILOVER_FEATURE_ID]: SAFE_PROVIDER_FAILOVER_UNLOCK,
  [UNKNOWN_STATE_RECONCILIATION_FEATURE_ID]: UNKNOWN_STATE_RECONCILIATION_UNLOCK,
  [ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID]: SHARED_FOUNDATION_UNLOCK,
  [PROACTIVE_CANARY_FEATURE_ID]: SHARED_FOUNDATION_UNLOCK,
};
const HISTORICAL_EVIDENCE_BY_FEATURE = {
  [PROVIDER_ROUTE_CONTRACT_FEATURE_ID]: [
    'docs/superpowers/specs/2026-08-15-platform-stability-one-pass-lock-design.md',
    'docs/superpowers/plans/2026-08-15-platform-stability-foundation.md',
    'docs/verification/platform-stability/foundation-verification.md',
    'docs/verification/platform-stability/provider-reconciliation-grace-20260816.md',
    'docs/tasks/2026-08-16-provider-failover-protection-phase.md',
    'docs/superpowers/plans/2026-08-20-provider-route-cost-and-multi-model-split.md',
  ],
  [SAFE_PROVIDER_FAILOVER_FEATURE_ID]: [
    'docs/superpowers/specs/2026-08-15-platform-stability-one-pass-lock-design.md',
    'docs/superpowers/plans/2026-08-15-platform-stability-foundation.md',
    'docs/verification/platform-stability/foundation-verification.md',
    'docs/verification/platform-stability/image-legacy-failover-compatibility.md',
    'docs/verification/platform-stability/provider-reconciliation-grace-20260816.md',
    'docs/tasks/2026-08-16-provider-failover-protection-phase.md',
    'docs/tasks/2026-08-16-image-node-gpt-image-reference-repair.md',
    'docs/superpowers/plans/2026-08-20-provider-route-cost-and-multi-model-split.md',
  ],
  [UNKNOWN_STATE_RECONCILIATION_FEATURE_ID]: [
    'docs/superpowers/specs/2026-08-15-platform-stability-one-pass-lock-design.md',
    'docs/superpowers/plans/2026-08-15-platform-stability-foundation.md',
    'docs/verification/platform-stability/foundation-verification.md',
    'docs/verification/platform-stability/provider-reconciliation-grace-20260816.md',
    'docs/verification/platform-stability/provider-needs-attention-state-closure-20260822.md',
    'docs/verification/platform-stability/video-audio-credit-reconciliation-20260822.md',
    'docs/superpowers/plans/2026-08-20-provider-route-cost-and-multi-model-split.md',
  ],
  [ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID]: [
    'docs/superpowers/specs/2026-08-15-platform-stability-one-pass-lock-design.md',
    'docs/superpowers/plans/2026-08-15-platform-stability-foundation.md',
    'docs/verification/platform-stability/foundation-verification.md',
    'docs/superpowers/plans/2026-08-20-provider-route-cost-and-multi-model-split.md',
  ],
  [PROACTIVE_CANARY_FEATURE_ID]: PROACTIVE_CANARY_EVIDENCE,
};
const PROACTIVE_CANARY_CORE_PATHS = [
  'backend-node/migrations/60_provider_canary_guard.sql',
  'backend-node/migrations/61_provider_canary_reconcile_claim.sql',
  'backend-node/migrations/62_provider_canary_admin_pagination.sql',
  'backend-node/migrations/63_provider_route_costs.sql',
  'backend-node/scripts/split-multi-model-provider-configs.js',
  'backend-node/scripts/verify-feature-lock-manifest.js',
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
  'backend-node/src/services/providerCanarySchedulerService.js',
  'backend-node/src/services/providerRouteCostService.js',
  'backend-node/src/services/providerRouteStabilityService.js',
  'backend-node/src/services/providerRuntimeFingerprintService.js',
  'backend-node/src/services/text-generation-billing-service.js',
  'backend-node/src/services/videoClient.js',
  'backend-node/src/services/videoService.js',
  '.github/workflows/platform-zero-cost-smoke.yml',
  'frontweb/scripts/run-platform-zero-cost-smoke.mjs',
  'frontweb/src/api/providerStability.js',
  'frontweb/src/components/ProviderStabilityPanel.vue',
];
const PROACTIVE_CANARY_REQUIRED_TESTS = [
  'backend-node/test/aiConfigPublicView.test.js',
  'backend-node/test/appBackgroundServices.test.js',
  'backend-node/test/canvasModelCatalogService.test.js',
  'backend-node/test/generationCostLedger.test.js',
  'backend-node/test/generationRouteCostLedger.test.js',
  'backend-node/test/imageBilling.test.js',
  'backend-node/test/modelPrice.test.js',
  'backend-node/test/openAIImageOutput.test.js',
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
  'backend-node/test/providerReconciliation.test.js',
  'backend-node/test/providerRouteAdminRoutes.test.js',
  'backend-node/test/providerRouteCost.test.js',
  'backend-node/test/providerRouteImageIntegration.test.js',
  'backend-node/test/providerRouteSchema.test.js',
  'backend-node/test/providerRouteStability.test.js',
  'backend-node/test/providerRouteTextIntegration.test.js',
  'backend-node/test/providerRouteVideoIntegration.test.js',
  'backend-node/test/providerRuntimeFingerprint.test.js',
  'backend-node/test/splitMultiModelProviderConfigs.test.js',
  'backend-node/test/text-generation-billing.test.js',
  'backend-node/test/videoBilling.test.js',
  'backend-node/test/videoQueryTaskStatusOnce.test.js',
  'frontweb/e2e/platform-zero-cost-smoke.spec.js',
  'frontweb/e2e/provider-stability-admin.spec.js',
  'frontweb/test/platformZeroCostSmokeContract.test.js',
  'frontweb/test/providerRouteCostAdmin.test.js',
  'frontweb/test/providerStabilityAdmin.test.js',
];
const PROVIDER_TASK_LOCK_REQUIREMENTS = {
  [PROVIDER_ROUTE_CONTRACT_FEATURE_ID]: {
    protectedPaths: [
      'backend-node/migrations/64_provider_task_receipt_reconciliation.sql',
      'backend-node/src/services/providerRouteStabilityService.js',
      'backend-node/src/services/providerTaskReconciliationService.js',
    ],
    requiredTests: [
      'backend-node/test/providerRouteSchema.test.js',
      'backend-node/test/providerRouteStability.test.js',
      'backend-node/test/providerRouteImageIntegration.test.js',
      'backend-node/test/providerRouteTextIntegration.test.js',
      'backend-node/test/providerRouteVideoIntegration.test.js',
      'backend-node/test/providerTaskReconciliation.test.js',
    ],
  },
  [SAFE_PROVIDER_FAILOVER_FEATURE_ID]: {
    protectedPaths: [
      'backend-node/src/services/providerTaskReconciliationService.js',
      'backend-node/src/services/videoClient.js',
      'backend-node/src/services/videoService.js',
    ],
    requiredTests: [
      'backend-node/test/feituoVideoModels.test.js',
      'backend-node/test/imageAssetModelFailover.test.js',
      'backend-node/test/providerRouteImageIntegration.test.js',
      'backend-node/test/providerRouteTextIntegration.test.js',
      'backend-node/test/providerRouteVideoIntegration.test.js',
      'backend-node/test/providerTaskReconciliation.test.js',
      'backend-node/test/storyboardImageFailure.test.js',
      'backend-node/test/toapisVideoIntegration.test.js',
      'backend-node/test/videoQueryTaskStatusOnce.test.js',
    ],
  },
  [UNKNOWN_STATE_RECONCILIATION_FEATURE_ID]: {
    protectedPaths: [
      'backend-node/migrations/64_provider_task_receipt_reconciliation.sql',
      'backend-node/src/app.js',
      'backend-node/src/services/creditLedgerService.js',
      'backend-node/src/services/providerRouteStabilityService.js',
      'backend-node/src/services/providerTaskReconciliationService.js',
      'backend-node/src/services/taskService.js',
      'backend-node/src/services/videoClient.js',
      'backend-node/src/services/videoService.js',
    ],
    requiredTests: [
      'backend-node/test/creditLedger.test.js',
      'backend-node/test/providerReconciliation.test.js',
      'backend-node/test/providerTaskReconciliation.test.js',
      'backend-node/test/taskService.test.js',
      'backend-node/test/videoBilling.test.js',
      'backend-node/test/videoQueryTaskStatusOnce.test.js',
    ],
  },
  [ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID]: {
    protectedPaths: [
      'backend-node/src/routes/index.js',
      'backend-node/src/routes/providerStability.js',
      'backend-node/src/services/providerTaskReconciliationService.js',
    ],
    requiredTests: [
      'backend-node/test/providerTaskAdminRoutes.test.js',
      'backend-node/test/providerTaskReconciliation.test.js',
      'frontweb/test/providerRouteCostAdmin.test.js',
    ],
  },
  [PROACTIVE_CANARY_FEATURE_ID]: {
    protectedPaths: [
      'backend-node/migrations/64_provider_task_receipt_reconciliation.sql',
      'backend-node/src/app.js',
      'backend-node/src/routes/index.js',
      'backend-node/src/routes/providerStability.js',
      'backend-node/src/services/creditLedgerService.js',
      'backend-node/src/services/providerRouteStabilityService.js',
      'backend-node/src/services/providerTaskReconciliationService.js',
      'backend-node/src/services/videoClient.js',
      'backend-node/src/services/videoService.js',
    ],
    requiredTests: [
      'backend-node/test/creditLedger.test.js',
      'backend-node/test/feituoVideoModels.test.js',
      'backend-node/test/imageAssetModelFailover.test.js',
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
      'backend-node/test/toapisVideoIntegration.test.js',
      'backend-node/test/videoQueryTaskStatusOnce.test.js',
    ],
  },
};

test('共享稳定性锁定清单引用的保护路径、测试和证据全部存在', () => {
  const report = loadAndVerifyCurrentManifest({ repoRoot, manifestPath, baseManifest: null, changedPaths: [] });
  assert.equal(report.ready, true);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.features > 0, true);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.features.every((feature) => feature.module === 'shared'), true);
  assert.equal(manifest.features.some((feature) => /canvas|factory|script-analysis/.test(feature.featureId)), false);
  assert.equal(
    manifest.features.every((feature) => ['locked_pass', 'locked_fixed'].includes(feature.status)),
    true,
  );
});

test('平台完整验收框架锁定为 shared locked_pass 且不提前锁定业务功能', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const feature = manifest.features.find(({ featureId }) => featureId === COMPLETE_ACCEPTANCE_FRAMEWORK_ID);
  assert.ok(feature, `缺少功能锁 ${COMPLETE_ACCEPTANCE_FRAMEWORK_ID}`);
  assert.equal(feature.module, 'shared');
  assert.equal(feature.status, 'locked_pass');
  assert.deepEqual(feature.acceptance, COMPLETE_ACCEPTANCE_ACCEPTANCE);
  assert.deepEqual(feature.protectedPaths, COMPLETE_ACCEPTANCE_PROTECTED_PATHS);
  assert.deepEqual(feature.requiredTests, COMPLETE_ACCEPTANCE_REQUIRED_TESTS);
  assert.deepEqual(feature.evidence, COMPLETE_ACCEPTANCE_EVIDENCE);
  assert.equal(feature.fixCommit, null);
  assert.deepEqual(feature.unlockHistory, [COMPLETE_ACCEPTANCE_UNLOCK]);
  assert.deepEqual(feature.unlock, PR177_PLATFORM_ACCEPTANCE_UNLOCK);
  assert.equal(manifest.features.some((featureLock) => /canvas|factory|script-analysis/.test(featureLock.featureId)), false);
});

test('主动巡检锁固定验收文本并覆盖任务 2 到 12 的核心文件与测试', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const feature = manifest.features.find(({ featureId }) => featureId === PROACTIVE_CANARY_FEATURE_ID);
  assert.ok(feature, `缺少功能锁 ${PROACTIVE_CANARY_FEATURE_ID}`);
  assert.deepEqual(feature.acceptance, PROACTIVE_CANARY_ACCEPTANCE);
  for (const protectedPath of PROACTIVE_CANARY_CORE_PATHS) {
    assert.ok(feature.protectedPaths.includes(protectedPath), `功能锁缺少保护路径: ${protectedPath}`);
  }
  for (const testPath of PROACTIVE_CANARY_REQUIRED_TESTS) {
    assert.ok(feature.requiredTests.includes(testPath), `功能锁缺少影响测试: ${testPath}`);
  }
  assert.deepEqual(feature.evidence.slice(0, PROACTIVE_CANARY_EVIDENCE.length), PROACTIVE_CANARY_EVIDENCE);
});

test('PR #184 主线合并刷新功能锁并保留零成本巡检批准历史与证据', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const feature = manifest.features.find(({ featureId }) => featureId === PROACTIVE_CANARY_FEATURE_ID);
  assert.ok(feature, `缺少功能锁 ${PROACTIVE_CANARY_FEATURE_ID}`);
  assert.deepEqual(feature.unlock, PR184_MAIN_MERGE_UNLOCK);
  assert.deepEqual(feature.unlockHistory.at(-1), PLATFORM_ZERO_COST_SMOKE_FIXTURE_GUARD_UNLOCK);
  assert.deepEqual(feature.unlockHistory.at(-2), PLATFORM_ZERO_COST_SMOKE_READ_AUTH_UNLOCK);
  assert.deepEqual(feature.unlockHistory.at(-3), PROVIDER_TTS_CHARACTER_COST_UNLOCK);
  assert.deepEqual(feature.unlockHistory.at(-4), PROVIDER_READINESS_TTS_UNLOCK);
  assert.deepEqual(feature.evidence.slice(-PROVIDER_READINESS_TTS_EVIDENCE.length), PROVIDER_READINESS_TTS_EVIDENCE);
  for (const testPath of PROVIDER_READINESS_TTS_REQUIRED_TESTS) {
    assert.ok(feature.requiredTests.includes(testPath), `TTS 功能锁缺少影响测试: ${testPath}`);
  }
});

test('供应商任务凭证与四轮无产物质量修复使用分阶段新鲜批准并保留完整历史', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const [featureId, requirements] of Object.entries(PROVIDER_TASK_LOCK_REQUIREMENTS)) {
    const feature = manifest.features.find((entry) => entry.featureId === featureId);
    assert.ok(feature, `缺少功能锁 ${featureId}`);
    const qualityFixTouched = PROVIDER_TASK_ARTIFACT_QUALITY_FEATURE_IDS.has(featureId);
    const liveCompatTouched = PROVIDER_TASK_LIVE_COMPAT_FEATURE_IDS.has(featureId);
    const previousUnlock = qualityFixTouched
      ? PROVIDER_TASK_STATUS_DECISION_UNLOCK
      : PROVIDER_TASK_RECEIPT_UNLOCK;
    assert.deepEqual(feature.unlock, PR184_MAIN_MERGE_UNLOCK);
    assert.deepEqual(feature.unlockHistory, [
      HISTORICAL_UNLOCK_BY_FEATURE[featureId],
      ...(qualityFixTouched ? [PROVIDER_TASK_RECEIPT_UNLOCK] : []),
      ...(qualityFixTouched ? [PR177_UNLOCK_BY_FEATURE[featureId]] : []),
      ...(qualityFixTouched ? [PROVIDER_TASK_ARTIFACT_QUALITY_UNLOCK] : []),
      ...(qualityFixTouched ? [LEGACY_DJPSD_STRICT_ARTIFACT_UNLOCK] : []),
      ...(qualityFixTouched ? [ASYNC_VIDEO_PROTOCOL_ARTIFACT_UNLOCK] : []),
      ...(liveCompatTouched ? [previousUnlock] : []),
      ...(featureId === PROVIDER_ROUTE_CONTRACT_FEATURE_ID ? [PR177_PROVIDER_ROUTE_UNLOCK] : []),
      ...([PROVIDER_ROUTE_CONTRACT_FEATURE_ID, PROACTIVE_CANARY_FEATURE_ID].includes(featureId)
        ? [PROVIDER_TASK_LIVE_COMPAT_UNLOCK]
        : []),
      ...(featureId === PROACTIVE_CANARY_FEATURE_ID
        ? [
          PROVIDER_READINESS_TTS_UNLOCK,
          PROVIDER_TTS_CHARACTER_COST_UNLOCK,
          PLATFORM_ZERO_COST_SMOKE_READ_AUTH_UNLOCK,
        ]
        : []),
      ...(featureId === ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID
        ? [PROVIDER_TASK_RECEIPT_UNLOCK, PR177_SHARED_FOUNDATION_UNLOCK]
        : []),
      PRE_PR184_CURRENT_UNLOCK_BY_FEATURE[featureId],
    ]);
    assert.deepEqual(
      feature.evidence.slice(0, HISTORICAL_EVIDENCE_BY_FEATURE[featureId].length),
      HISTORICAL_EVIDENCE_BY_FEATURE[featureId],
    );
    for (const protectedPath of requirements.protectedPaths) {
      assert.ok(feature.protectedPaths.includes(protectedPath), `${featureId} 缺少保护路径: ${protectedPath}`);
    }
    for (const testPath of requirements.requiredTests) {
      assert.ok(feature.requiredTests.includes(testPath), `${featureId} 缺少影响测试: ${testPath}`);
    }
    for (const evidencePath of PROVIDER_TASK_RECEIPT_EVIDENCE) {
      assert.ok(feature.evidence.includes(evidencePath), `${featureId} 缺少证据: ${evidencePath}`);
    }
    if ([PROACTIVE_CANARY_FEATURE_ID, ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID].includes(featureId)) {
      assert.deepEqual(
        feature.evidence.slice(-PROVIDER_READINESS_TTS_EVIDENCE.length),
        PROVIDER_READINESS_TTS_EVIDENCE,
      );
    } else if (liveCompatTouched) {
      assert.equal(feature.evidence.at(-1), PROVIDER_TASK_LIVE_COMPAT_EVIDENCE);
    } else {
      assert.deepEqual(
        feature.evidence.slice(-PROVIDER_TASK_RECEIPT_EVIDENCE.length),
        PROVIDER_TASK_RECEIPT_EVIDENCE,
      );
    }
  }
  const appLocks = manifest.features
    .filter((feature) => feature.protectedPaths.includes('backend-node/src/app.js'))
    .map((feature) => feature.featureId)
    .sort();
  assert.deepEqual(appLocks, [PROACTIVE_CANARY_FEATURE_ID, UNKNOWN_STATE_RECONCILIATION_FEATURE_ID].sort());
  for (const featureId of appLocks) {
    const feature = manifest.features.find((entry) => entry.featureId === featureId);
    assert.deepEqual(feature.unlock, PR184_MAIN_MERGE_UNLOCK);
  }
});

test('未触及锁保留当前批准记录且所有锁保留历史证据', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.features.length >= 5, true);
  for (const feature of manifest.features) {
    if (!Object.hasOwn(PROVIDER_TASK_LOCK_REQUIREMENTS, feature.featureId)) {
      assert.deepEqual(feature.unlock, PR177_PLATFORM_ACCEPTANCE_UNLOCK);
    }
    assert.equal(feature.evidence.length > 0, true);
  }
  const unknownState = manifest.features.find(
    ({ featureId }) => featureId === UNKNOWN_STATE_RECONCILIATION_FEATURE_ID,
  );
  assert.ok(unknownState.evidence.includes(
    'docs/verification/platform-stability/provider-needs-attention-state-closure-20260822.md',
  ));
  assert.ok(unknownState.evidence.includes(
    'docs/verification/platform-stability/video-audio-credit-reconciliation-20260822.md',
  ));
});

test('实时候选兼容修复刷新四个运行时功能锁并登记补丁测试与证据', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const featureId of [
    PROVIDER_ROUTE_CONTRACT_FEATURE_ID,
    SAFE_PROVIDER_FAILOVER_FEATURE_ID,
    UNKNOWN_STATE_RECONCILIATION_FEATURE_ID,
    PROACTIVE_CANARY_FEATURE_ID,
  ]) {
    const feature = manifest.features.find((entry) => entry.featureId === featureId);
    assert.ok(feature, `缺少功能锁 ${featureId}`);
    assert.deepEqual(feature.unlock, PR184_MAIN_MERGE_UNLOCK);
    assert.deepEqual(feature.unlockHistory.at(-1), PRE_PR184_CURRENT_UNLOCK_BY_FEATURE[featureId]);
    assert.ok(feature.unlockHistory.some((entry) => (
      entry.reason === PROVIDER_TASK_STATUS_DECISION_UNLOCK.reason
        || entry.reason === PROVIDER_TASK_RECEIPT_UNLOCK.reason
    )), `${featureId} 缺少上一阶段批准历史`);
    assert.ok(feature.requiredTests.includes('backend-node/test/providerTaskLiveCompatibility.test.js'));
    assert.equal(
      feature.evidence.at(-1),
      featureId === PROACTIVE_CANARY_FEATURE_ID
        ? PROVIDER_READINESS_TTS_EVIDENCE.at(-1)
        : PROVIDER_TASK_LIVE_COMPAT_EVIDENCE,
    );
  }
});

test('显式 --base 拒绝不存在的 Git 引用且不能静默按零变更放行', () => {
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'backend-node', 'scripts', 'verify-feature-lock-manifest.js'),
    '--base',
    'refs/heads/feature-lock-base-does-not-exist',
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /INVALID_BASE_REF/);
  assert.doesNotMatch(result.stdout, /"ready":true/);
});

test('显式 --base 存在但基线清单不可读时拒绝放行', () => {
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'backend-node', 'scripts', 'verify-feature-lock-manifest.js'),
    '--base',
    'HEAD:backend-node/package.json',
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BASE_MANIFEST_UNAVAILABLE/);
  assert.doesNotMatch(result.stdout, /"ready":true/);
});

test('显式 --base 有效且包含基线清单时执行真实差异审计', () => {
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'backend-node', 'scripts', 'verify-feature-lock-manifest.js'),
    '--base',
    'HEAD^',
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, true);
  assert.equal(report.baseRef, 'HEAD^');
  assert.equal(report.changedPaths > 0, true);
  assert.equal(report.protectedFeaturesFromBase > 0, true);
});

test('锁定保护路径发生变化时必须提供原因、批准者和影响测试', () => {
  const protectedPath = 'backend-node/src/services/imageService.js';
  const baseManifest = {
    schemaVersion: 1,
    baselineCommit: '8f9a66cd708d5db96fbee573a2f4aa7de182a6fe',
    features: [{
      featureId: 'stability.safe-provider-failover',
      module: 'shared',
      status: 'locked_fixed',
      acceptance: ['明确未受理才切换'],
      protectedPaths: [protectedPath],
      requiredTests: ['backend-node/test/providerRouteImageIntegration.test.js'],
      evidence: ['docs/superpowers/plans/2026-08-15-platform-stability-foundation.md'],
      fixCommit: null,
      unlock: null,
    }],
  };
  assert.throws(
    () => verifyFeatureLock({ repoRoot, currentManifest: baseManifest, baseManifest, changedPaths: [protectedPath] }),
    (error) => error.code === 'FEATURE_LOCKED',
  );
  const approved = structuredClone(baseManifest);
  approved.features[0].unlock = {
    reason: '修复已复现的回归',
    approvedBy: 'product-owner',
    impactTests: ['backend-node/test/providerRouteImageIntegration.test.js'],
  };
  assert.equal(
    verifyFeatureLock({ repoRoot, currentManifest: approved, baseManifest, changedPaths: [protectedPath] }).ready,
    true,
  );
  assert.throws(
    () => verifyFeatureLock({ repoRoot, currentManifest: approved, baseManifest: approved, changedPaths: [protectedPath] }),
    (error) => error.code === 'FEATURE_LOCKED',
  );
});

test('清单拒绝非法状态、缺失路径和空验收标准', () => {
  const invalid = {
    schemaVersion: 1,
    baselineCommit: '8f9a66cd708d5db96fbee573a2f4aa7de182a6fe',
    features: [{
      featureId: 'stability.invalid',
      module: 'shared',
      status: 'done',
      acceptance: [],
      protectedPaths: ['backend-node/src/services/not-found.js'],
      requiredTests: ['backend-node/test/not-found.test.js'],
      evidence: ['docs/not-found.md'],
      fixCommit: null,
      unlock: null,
    }],
  };
  assert.throws(
    () => verifyFeatureLock({ repoRoot, currentManifest: invalid, baseManifest: null, changedPaths: [] }),
    (error) => error.code === 'INVALID_FEATURE_LOCK_MANIFEST',
  );
});

test('CI 在后端全量测试后运行功能锁审计且发布范围无目录通配', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/backend-node-tests.yml'), 'utf8');
  assert.match(workflow, /Run backend tests[\s\S]*npm test[\s\S]*Audit feature locks[\s\S]*npm run audit:feature-lock/);
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'backend-node/package.json'), 'utf8'));
  assert.equal(pkg.scripts['audit:feature-lock'], 'node scripts/verify-feature-lock-manifest.js');
  const releaseScope = JSON.parse(fs.readFileSync(
    path.join(repoRoot, 'deploy/release-scopes/platform-stability-foundation.json'),
    'utf8',
  ));
  assert.equal(releaseScope.schemaVersion, 1);
  assert.equal(releaseScope.allowedPaths.length > 0, true);
  assert.equal(releaseScope.allowedPaths.every((entry) => !entry.includes('*') && !entry.endsWith('/')), true);
});
