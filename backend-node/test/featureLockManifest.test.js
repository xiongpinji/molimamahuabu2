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


const EXECUTION_PREVIEW_UNLOCK = {
  "reason": "2026-09-05 通用一键转绘版本级动态执行计划只读预览；零任务零冻结，不读 Key、不调用供应商、不付费、不提交推送、不部署",
  "approvedBy": "product-owner 2026-09-05 开始下一项",
  "impactTests": [
    "backend-node/test/redrawExecutionPlan.test.js",
    "backend-node/test/redrawExecutionPlanPreview.test.js",
    "backend-node/test/redrawRoutes.test.js",
    "backend-node/test/redrawSourceDialogueGuards.test.js",
    "backend-node/test/redrawLocalization.test.js",
    "backend-node/test/featureLockManifest.test.js"
  ]
};
const EXECUTION_PREVIEW_FEATURE_IDS = [
  "stability.admin-provider-observability",
  "stability.proactive-canary-and-public-evidence",
  "redraw.coverage-registration-http-route",
  "redraw.product-media-http-chain",
  "redraw.episode-blueprint-first"
];

// Historical assertions still run against the exact previous manifest. First verify the
// new authorization, then its entire unchanged predecessor (including all protected rules).
function readPreExecutionPreviewManifest() {
  const manifest = readPreExecutionReviewManifest();
  for (const id of EXECUTION_PREVIEW_FEATURE_IDS) {
    const feature = manifest.features.find((entry) => entry.featureId === id);
    assert.ok(feature, id);
    assert.deepEqual(feature.unlock, EXECUTION_PREVIEW_UNLOCK);
    assert.ok(feature.unlockHistory.length > 0, id);
    feature.unlock = feature.unlockHistory.pop();
  }
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    '6d5795b7aa59d6f2c2f7bca9ef3637547fde51a16490599733e8c78c43f74649',
    'Preview authorization must preserve the entire pre-stage manifest');
  return manifest;
}

test('只读执行预览五项触及授权精确追加且既有门禁整体不变', () => {
  readPreExecutionPreviewManifest();
});

const EXECUTION_REVIEW_UNLOCK = {
  "reason": "2026-09-05 通用一键转绘页面计划审核与版本绑定保存；仅本地不可变快照与回归，零生成零冻结，不读 Key、不调用供应商、不付费、不提交推送、不部署",
  "approvedBy": "product-owner 2026-09-05 开始下一项",
  "impactTests": [
    "backend-node/test/redrawExecutionPlanReview.test.js",
    "backend-node/test/redrawExecutionPlanPreview.test.js",
    "backend-node/test/redrawRoutes.test.js",
    "backend-node/test/featureLockManifest.test.js",
    "frontweb/test/redrawExecutionPlanReview.test.js",
    "frontweb/e2e/redraw-workspace.spec.js"
  ]
};
function readPreExecutionReviewManifest() {
  const manifest = readPreExecutionQueueManifest();
  for (const id of EXECUTION_PREVIEW_FEATURE_IDS) {
    const feature = manifest.features.find((entry) => entry.featureId === id);
    assert.deepEqual(feature.unlock, EXECUTION_REVIEW_UNLOCK);
    assert.ok(feature.unlockHistory.length > 0, id);
    feature.unlock = feature.unlockHistory.pop();
  }
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    '36d45f66c8750427d0bc8b574213458f7c292d5d0fb13965e53cc7d30db79ee0', 'Review authorization must preserve the entire pre-stage manifest');
  return manifest;
}
test('计划审核保存授权精确追加且既有门禁整体不变', () => { readPreExecutionReviewManifest(); });


const EXECUTION_QUEUE_UNLOCK = {
  "reason": "2026-09-05 通用一键转绘待就绪执行队列登记与恢复读取；仅本地队列，零调度零生成零冻结，不读 Key、不调用供应商、不付费、不提交推送、不部署",
  "approvedBy": "product-owner 2026-09-05 规划好剩余任务设立目标 开始推进",
  "impactTests": [
    "backend-node/test/redrawExecutionQueue.test.js",
    "backend-node/test/redrawExecutionPlanReview.test.js",
    "backend-node/test/redrawRoutes.test.js",
    "backend-node/test/featureLockManifest.test.js",
    "frontweb/test/redrawExecutionQueue.test.js",
    "frontweb/e2e/redraw-workspace.spec.js"
  ]
};
function readPreExecutionQueueManifest() {
  const manifest = readPreSpeakerCorrectionManifest();
  for (const id of EXECUTION_PREVIEW_FEATURE_IDS) {
    const feature = manifest.features.find((entry) => entry.featureId === id);
    assert.deepEqual(feature.unlock, EXECUTION_QUEUE_UNLOCK);
    assert.ok(feature.unlockHistory.length > 0, id);
    feature.unlock = feature.unlockHistory.pop();
  }
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    '8dc40a359b796a93de61a7f0282c4c93920870c2decf35390201f78a56c7ec81', 'Queue authorization must preserve the entire pre-stage manifest');
  return manifest;
}

test('待就绪队列登记授权精确追加且全部历史门禁不变', () => { readPreExecutionQueueManifest(); });

const SPEAKER_CORRECTION_UNLOCK = {
  reason: '2026-09-05 通用一键转绘逐句角色归属纠错与安全保存；仅本地草稿及原声证据回归，零生成零冻结，不读 Key、不调用供应商、不付费、不提交推送、不部署',
  approvedBy: 'product-owner 2026-09-05 规划好剩余任务设立目标 开始推进',
  impactTests: [
    'backend-node/test/redrawSpeakerCorrection.test.js',
    'backend-node/test/redrawBlueprintWorkflow.test.js',
    'backend-node/test/redrawSourceDialogue.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'frontweb/test/redrawSpeakerCorrection.test.js',
    'frontweb/e2e/redraw-workspace.spec.js',
  ],
};
function readPreSpeakerCorrectionManifest() {
  const manifest = readPreDialogueCorrectionManifest();
  const feature = manifest.features.find((entry) => entry.featureId === 'redraw.episode-blueprint-first');
  assert.deepEqual(feature.unlock, SPEAKER_CORRECTION_UNLOCK);
  assert.ok(feature.unlockHistory.length > 0);
  feature.unlock = feature.unlockHistory.pop();
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    'd650f7733e23c1598a388ca2ef9ede67a4b9046af97b4ab2bb605667f08b0515',
    'Speaker correction authorization must preserve the entire pre-stage manifest');
  return manifest;
}
test('逐句角色纠错仅追加蓝图功能授权且全部历史门禁不变', () => { readPreSpeakerCorrectionManifest(); });

const DIALOGUE_CORRECTION_UNLOCK = {
  reason: '2026-09-05 通用一键转绘对白文本与完整时间人工修订，严格保留原 ASR 证据；仅本地草稿与下游回归，零生成零冻结，不读 Key、不调用供应商、不付费、不提交推送、不部署',
  approvedBy: 'product-owner 2026-09-05 规划好剩余任务设立目标 开始推进',
  impactTests: [
    'backend-node/test/redrawDialogueCorrection.test.js',
    'backend-node/test/redrawSourceDialogue.test.js',
    'backend-node/test/redrawSourceDialogueGuards.test.js',
    'backend-node/test/redrawBlueprintWorkflow.test.js',
    'backend-node/test/redrawLocalization.test.js',
    'backend-node/test/redrawExecutionPlanPreview.test.js',
    'backend-node/test/redrawRoutes.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
const DIALOGUE_CORRECTION_FEATURE_IDS = [
  'redraw.coverage-registration-http-route',
  'redraw.product-media-http-chain',
  'redraw.episode-blueprint-first',
];
function readPreDialogueCorrectionManifest() {
  const manifest = readPreSourceVideoManifest();
  for (const id of DIALOGUE_CORRECTION_FEATURE_IDS) {
    const feature = manifest.features.find((entry) => entry.featureId === id);
    assert.ok(feature, id);
    assert.deepEqual(feature.unlock, DIALOGUE_CORRECTION_UNLOCK);
    assert.ok(feature.unlockHistory.length > 0, id);
    feature.unlock = feature.unlockHistory.pop();
  }
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    '481c54768dbfce521e7ca30e45c0427828161cdc30bfe5de3f9ac922221089f9',
    'Dialogue correction authorization must preserve the entire pre-stage manifest');
  return manifest;
}
test('对白原文和完整时间修订仅追加三项触及授权且全部历史门禁不变', () => { readPreDialogueCorrectionManifest(); });

const SOURCE_VIDEO_UNLOCK = {
  reason: '2026-09-05 通用一键转绘母本鉴权回放连接；仅本地 owner 与源哈希绑定只读媒体及回归，零业务写入零生成零冻结，不读 Key、不调用供应商、不付费、不提交推送、不部署',
  approvedBy: 'product-owner 2026-09-05 规划好剩余任务设立目标 开始推进',
  impactTests: [
    'backend-node/test/redrawSourceVideo.test.js',
    'backend-node/test/redrawRoutes.test.js',
    'backend-node/test/redrawSourceAudioEvidence.test.js',
    'backend-node/test/redrawDialogueCorrection.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
function readPreSourceVideoManifest() {
  const manifest = readPreDialogueUiManifest();
  for (const id of EXECUTION_PREVIEW_FEATURE_IDS) {
    const feature = manifest.features.find((entry) => entry.featureId === id);
    assert.ok(feature, id);
    assert.deepEqual(feature.unlock, SOURCE_VIDEO_UNLOCK);
    assert.ok(feature.unlockHistory.length > 0, id);
    feature.unlock = feature.unlockHistory.pop();
  }
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    '48d58abadc3575ac230c208cefd406e3d43aabe5bbe25ed86f9ec8a8af59aaf9',
    'Source video authorization must preserve the entire pre-stage manifest');
  return manifest;
}
test('母本鉴权回放仅追加五项触及授权且全部历史门禁不变', () => { readPreSourceVideoManifest(); });

const DIALOGUE_UI_UNLOCK = {
  reason: '2026-09-05 通用一键转绘页面鉴权母本回放与逐句文本及完整时间纠错；仅本地草稿和回归，保留原始识别，零生成零冻结，不读 Key、不调用供应商、不付费、不提交推送、不部署',
  approvedBy: 'product-owner 2026-09-05 规划好剩余任务设立目标 开始推进',
  impactTests: [
    'backend-node/test/redrawSourceVideo.test.js',
    'backend-node/test/redrawDialogueCorrection.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'frontweb/test/redrawDialogueCorrection.test.js',
    'frontweb/test/redrawDialogueSourceReview.test.js',
    'frontweb/test/redrawSpeakerCorrection.test.js',
    'frontweb/e2e/redraw-workspace.spec.js',
  ],
};
function readPreDialogueUiManifest() {
  const manifest = readPreVisualFactManifest();
  const feature = manifest.features.find((entry) => entry.featureId === 'redraw.episode-blueprint-first');
  assert.deepEqual(feature.unlock, DIALOGUE_UI_UNLOCK);
  assert.ok(feature.unlockHistory.length > 0);
  feature.unlock = feature.unlockHistory.pop();
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    '247837359551f5316035e0ceec5633acca53b6783ba2e04b1382558e05f34f50',
    'Dialogue UI authorization must preserve the entire pre-stage manifest');
  return manifest;
}
test('对白编辑与鉴权回放页面只追加蓝图功能授权且全部历史门禁不变', () => { readPreDialogueUiManifest(); });

const VISUAL_FACT_UNLOCK = {
  reason: '2026-09-05 通用一键转绘镜头可见事实、场景与道具草稿编辑；仅本地保存及重新审核，保留原始素材与识别证据，零生成零冻结，不读 Key、不调用供应商、不付费、不提交推送、不部署',
  approvedBy: 'product-owner 2026-09-05 规划好剩余任务设立目标 开始推进',
  impactTests: [
    'backend-node/test/redrawVisualFactCorrection.test.js',
    'backend-node/test/redrawBlueprintWorkflow.test.js',
    'backend-node/test/redrawDialogueCorrection.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'frontweb/test/redrawVisualFactCorrection.test.js',
    'frontweb/test/redrawDialogueCorrection.test.js',
    'frontweb/test/redrawSpeakerCorrection.test.js',
    'frontweb/e2e/redraw-workspace.spec.js',
  ],
};
function readPreVisualFactManifest() {
  const manifest = readPreBoundaryManifest();
  const feature = manifest.features.find((entry) => entry.featureId === 'redraw.episode-blueprint-first');
  assert.deepEqual(feature.unlock, VISUAL_FACT_UNLOCK);
  assert.ok(feature.unlockHistory.length > 0);
  feature.unlock = feature.unlockHistory.pop();
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    'ecd4a087041813f14fc5e60301759d4ed3845475b3220b2fdc2e9b41443f2810',
    'Visual fact authorization must preserve the entire pre-stage manifest');
  return manifest;
}
test('可见事实编辑授权仅追加蓝图功能且全部历史门禁不变', () => { readPreVisualFactManifest(); });

const BOUNDARY_UNLOCK = {
  reason: '2026-09-06 通用一键转绘人工切镜来源标记及受影响对白保存锁定复核；仅本地 TDD，保留原始证据与旧稿兼容，零生成零冻结，不读 Key、不调用供应商、不付费、不提交推送、不部署',
  approvedBy: 'product-owner 2026-09-05 规划好剩余任务设立目标 开始推进',
  impactTests: [
    'backend-node/test/redrawBoundaryCorrection.test.js',
    'backend-node/test/redrawBlueprintWorkflow.test.js',
    'backend-node/test/redrawSourceDialogue.test.js',
    'backend-node/test/redrawSourceDialogueGuards.test.js',
    'backend-node/test/redrawDialogueCorrection.test.js',
    'backend-node/test/redrawVisualFactCorrection.test.js',
    'backend-node/test/redrawLocalization.test.js',
    'backend-node/test/redrawExecutionPlanPreview.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
function readPreBoundaryManifest() {
  const manifest = readPreBoundaryUiManifest();
  const feature = manifest.features.find((entry) => entry.featureId === 'redraw.episode-blueprint-first');
  assert.deepEqual(feature.unlock, BOUNDARY_UNLOCK);
  assert.ok(feature.unlockHistory.length > 0);
  feature.unlock = feature.unlockHistory.pop();
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    '484f5b23226f0ad61a9426655710bd0ec488d1cacddf6f5aa8279c8aad48290e',
    'Boundary authorization must preserve the entire pre-stage manifest');
  return manifest;
}
test('人工切镜授权仅追加蓝图功能且全部历史门禁不变', () => { readPreBoundaryManifest(); });

const BOUNDARY_UI_UNLOCK = {
  reason: '2026-09-06 通用一键转绘相邻切点与整句归属原子页面编辑及真实保存联测；仅本地 TDD 与重新审核，保留原始证据，零生成零冻结，不读 Key、不调用供应商、不付费、不提交推送、不部署',
  approvedBy: 'product-owner 2026-09-05 规划好剩余任务设立目标 开始推进',
  impactTests: [
    'backend-node/test/redrawBoundaryCorrection.test.js',
    'backend-node/test/redrawBlueprintWorkflow.test.js',
    'backend-node/test/redrawSourceDialogueGuards.test.js',
    'backend-node/test/redrawLocalization.test.js',
    'backend-node/test/redrawExecutionPlanPreview.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'frontweb/test/redrawBoundaryCorrection.test.js',
    'frontweb/test/redrawDialogueCorrection.test.js',
    'frontweb/test/redrawSpeakerCorrection.test.js',
    'frontweb/test/redrawVisualFactCorrection.test.js',
    'frontweb/e2e/redraw-workspace.spec.js',
  ],
};
function readPreBoundaryUiManifest() {
  const manifest = readPreIdentityUploadManifest();
  const feature = manifest.features.find((entry) => entry.featureId === 'redraw.episode-blueprint-first');
  assert.deepEqual(feature.unlock, BOUNDARY_UI_UNLOCK);
  assert.ok(feature.unlockHistory.length > 0);
  feature.unlock = feature.unlockHistory.pop();
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    'c6c187d2449ebf41850461b1b868471fb4bb86bdb861e10f29407ea847becc8a',
    'Boundary UI authorization must preserve the entire pre-stage manifest');
  return manifest;
}
test('原子切镜页面仅追加蓝图功能授权且全部历史门禁不变', () => { readPreBoundaryUiManifest(); });

const IDENTITY_UPLOAD_UNLOCK = {
  reason: '2026-09-06 通用一键转绘普通角色身份图上传与只读刷新重审；仅本地 TDD，复用 owner/CAS/媒体导入合同，零生成零冻结，不读 Key、不调用供应商、不付费、不提交推送、不部署',
  approvedBy: 'product-owner 2026-09-05 规划好剩余任务设立目标 开始推进',
  impactTests: [
    'backend-node/test/redrawReferenceArtifactImport.test.js',
    'backend-node/test/redrawRoutes.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'frontweb/test/redrawIdentityUpload.test.js',
    'frontweb/test/redrawCharacterIdentity.test.js',
    'frontweb/test/redrawPreparationWorkspace.test.js',
    'frontweb/e2e/redraw-workspace.spec.js',
  ],
};
function readPreIdentityUploadManifest() {
  const manifest = readPreSourceAudioUnknownManifest();
  const feature = manifest.features.find((entry) => entry.featureId === 'redraw.episode-blueprint-first');
  assert.deepEqual(feature.unlock, IDENTITY_UPLOAD_UNLOCK);
  assert.ok(feature.unlockHistory.length > 0);
  feature.unlock = feature.unlockHistory.pop();
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    '17de8648f5ff5a3ee04472a3655dbcdc905b44428d192aaf8c6eb14b43b356b0',
    'Identity upload authorization must preserve the entire pre-stage manifest');
  return manifest;
}
test('普通身份图上传仅追加蓝图入口授权且全部历史门禁不变', () => { readPreIdentityUploadManifest(); });

const SOURCE_AUDIO_UNKNOWN_UNLOCK = {
  reason: '2026-09-06 通用一键转绘源音频结果未知状态连接修复；仅本地隔离数据库 TDD，未知保持待核对及预留，明确失败释放，重复点击零新增分析；不读 Key、不调用供应商、不付费、不提交推送、不部署',
  approvedBy: 'product-owner 2026-09-05 规划好剩余任务设立目标 开始推进',
  impactTests: [
    'backend-node/test/redrawWindowedProductAnalysis.test.js',
    'backend-node/test/redrawSourceAudioEvidence.test.js',
    'backend-node/test/redrawNativeSourceAnalysis.test.js',
    'backend-node/test/redrawRoutes.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
function readPreSourceAudioUnknownManifest() {
  const manifest = readPreMotionDraftManifest();
  for (const id of ['stability.proactive-canary-and-public-evidence', 'redraw.episode-blueprint-first']) {
    const feature = manifest.features.find((entry) => entry.featureId === id);
    assert.ok(feature, id);
    assert.deepEqual(feature.unlock, SOURCE_AUDIO_UNKNOWN_UNLOCK);
    assert.ok(feature.unlockHistory.length > 0, id);
    feature.unlock = feature.unlockHistory.pop();
  }
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    'db16f79b63ae570ec63f70677f11a026b9806781c12a3e99f95b92321a7e2ea2',
    'Source audio unknown authorization must preserve the entire pre-stage manifest');
  return manifest;
}
test('音频未知状态连接仅追加两项授权且全部历史门禁不变', () => { readPreSourceAudioUnknownManifest(); });

const MOTION_DRAFT_UNLOCK = {
  reason: '2026-09-06 通用一键转绘动作草片鉴权裁片与预览连接；仅本地 owner/镜头/源哈希绑定、静音草片和 TDD，零业务写入零审核零生成；不读 Key、不调用供应商、不付费、不提交推送、不部署',
  approvedBy: 'product-owner 2026-09-05 规划好剩余任务设立目标 开始推进',
  impactTests: [
    'backend-node/test/redrawMotionDraft.test.js',
    'backend-node/test/redrawSourceVideo.test.js',
    'backend-node/test/redrawSourceConditioning.test.js',
    'backend-node/test/redrawRoutes.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
function readPreMotionDraftManifest() {
  const manifest = readPreMotionCandidateManifest();
  for (const id of ['stability.admin-provider-observability', 'stability.proactive-canary-and-public-evidence',
    'redraw.coverage-registration-http-route', 'redraw.product-media-http-chain', 'redraw.episode-blueprint-first']) {
    const feature = manifest.features.find((entry) => entry.featureId === id);
    assert.ok(feature, id);
    assert.deepEqual(feature.unlock, MOTION_DRAFT_UNLOCK);
    assert.ok(feature.unlockHistory.length > 0, id);
    feature.unlock = feature.unlockHistory.pop();
  }
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    '63fac57104ace0acf9c1177f25c9655310fe0a0fbba923b8317bbd3f055d4ca5',
    'Motion draft authorization must preserve the entire pre-stage manifest');
  return manifest;
}
test('动作草片仅追加五项本地授权且全部历史门禁不变', () => { readPreMotionDraftManifest(); });

const MOTION_CANDIDATE_UNLOCK = {
  reason: '2026-09-06 通用一键转绘当前动作候选恢复与鉴权媒体读取；仅本地 owner/CAS/导入 SHA 绑定和 TDD，零业务写入零审核零生成；不读 Key、不调用供应商、不付费、不提交推送、不部署',
  approvedBy: 'product-owner 2026-09-05 规划好剩余任务设立目标 开始推进',
  impactTests: [
    'backend-node/test/redrawMotionCandidate.test.js',
    'backend-node/test/redrawReferenceArtifactImport.test.js',
    'backend-node/test/redrawMotionDraft.test.js',
    'backend-node/test/redrawRoutes.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
function readPreMotionCandidateManifest() {
  const manifest = readPreMotionUploadManifest();
  for (const id of ['stability.admin-provider-observability', 'stability.proactive-canary-and-public-evidence',
    'redraw.coverage-registration-http-route', 'redraw.product-media-http-chain', 'redraw.episode-blueprint-first']) {
    const feature = manifest.features.find((entry) => entry.featureId === id);
    assert.ok(feature, id);
    assert.deepEqual(feature.unlock, MOTION_CANDIDATE_UNLOCK);
    assert.ok(feature.unlockHistory.length > 0, id);
    feature.unlock = feature.unlockHistory.pop();
  }
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    '2fa3290667afbf7f104fe28d6bf7eccddbb363309f37cafc008892778666a50c',
    'Motion candidate authorization must preserve the entire pre-stage manifest');
  return manifest;
}
test('动作候选恢复仅追加五项本地授权且全部历史门禁不变', () => { readPreMotionCandidateManifest(); });

const MOTION_UPLOAD_UNLOCK = {
  reason: '2026-09-06 通用一键转绘普通用户动作素材预览上传与刷新防重；仅本地页面、鉴权 Blob、确认及未知状态冻结和 TDD，不读 Key、不调用供应商、不付费、不提交推送、不部署',
  approvedBy: 'product-owner 2026-09-05 规划好剩余任务设立目标 开始推进',
  impactTests: [
    'frontweb/test/redrawMotionReferenceApi.test.js',
    'frontweb/test/redrawMotionReferenceUpload.test.js',
    'frontweb/e2e/redraw-workspace.spec.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
function readPreMotionUploadManifest() {
  const manifest = readPreMotionPreparationBindingManifest();
  const feature = manifest.features.find((entry) => entry.featureId === 'redraw.episode-blueprint-first');
  assert.deepEqual(feature.unlock, MOTION_UPLOAD_UNLOCK);
  assert.ok(feature.unlockHistory.length > 0);
  feature.unlock = feature.unlockHistory.pop();
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    '27ba0d9dd145978de35c23b6264bd7c7d76272ea39e005ccc09b0910fd5652b0',
    'Motion ordinary upload authorization must preserve the entire pre-stage manifest');
  return manifest;
}
test('普通动作素材页面仅追加蓝图功能授权且全部历史门禁不变', () => { readPreMotionUploadManifest(); });

const MOTION_PREPARATION_BINDING_UNLOCK = {
  reason: '2026-09-06 通用一键转绘已确认动作候选真实参考包绑定与旧 ready 复用修复；仅本地隔离数据库和真实媒体 TDD，复用净景零供应商及零新增预留；不读 Key、不付费、不提交推送、不部署、不写生产',
  approvedBy: 'product-owner 2026-09-05 规划好剩余任务设立目标 开始推进',
  impactTests: [
    'backend-node/test/redrawReferencePreparationOrchestration.test.js',
    'backend-node/test/redrawMotionCandidate.test.js',
    'backend-node/test/redrawReferenceArtifactImport.test.js',
    'backend-node/test/redrawReferenceBundle.test.js',
    'backend-node/test/redrawPreparationGate.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
function readPreMotionPreparationBindingManifest() {
  const manifest = readPreMotionCoverageManifest();
  const feature = manifest.features.find((entry) => entry.featureId === 'redraw.product-media-http-chain');
  assert.deepEqual(feature.unlock, MOTION_PREPARATION_BINDING_UNLOCK);
  assert.ok(feature.unlockHistory.length > 0);
  feature.unlock = feature.unlockHistory.pop();
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    '39015bcaa464cb34ce86159327b9750d3f7976c3448791b9d4c3071ae4541cae',
    'Motion preparation binding authorization must preserve the entire pre-stage manifest');
  return manifest;
}
test('已确认动作候选绑定仅追加产品媒体授权且全部历史门禁不变', () => { readPreMotionPreparationBindingManifest(); });

const MOTION_COVERAGE_UNLOCK = {
  reason: '2026-09-06 通用一键转绘 G1.1 当前镜头已批准覆盖的可信逐帧输入；仅本地 owner/CAS/源与区域哈希只读校验和 TDD，不处理像素、不自动审核、不读 Key、不调用供应商、不付费、不提交推送、不部署、不写生产',
  approvedBy: 'product-owner 2026-09-06 规划好剩余6项-工作 全量推进',
  impactTests: [
    'backend-node/test/redrawMotionCoverage.test.js',
    'backend-node/test/redrawReferenceBundle.test.js',
    'backend-node/test/redrawCoverageRegistration.test.js',
    'backend-node/test/redrawMotionDraft.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
function readPreMotionCoverageManifest() {
  const manifest = readPreMotionProcessingManifest();
  const feature = manifest.features.find((entry) => entry.featureId === 'redraw.product-media-http-chain');
  assert.deepEqual(feature.unlock, MOTION_COVERAGE_UNLOCK);
  assert.ok(feature.unlockHistory.length > 0);
  feature.unlock = feature.unlockHistory.pop();
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    'd1365a36629cfb3e1c4f525daeeaab5938a2c97cba7655ba6b3e5be8b479e0e1',
    'Motion coverage authorization must preserve the entire pre-stage manifest');
  return manifest;
}
test('逐帧动作覆盖只追加本次产品媒体授权且全部历史门禁不变', () => { readPreMotionCoverageManifest(); });

const MOTION_PROCESSING_UNLOCK = {
  reason: '2026-09-06 通用一键转绘 G1.3a 本地动作处理响应及可选报告导入与准备绑定；仅本地 owner/CAS/真实媒体 TDD，保留人工确认及旧手工候选；不读 Key、不调用供应商、不付费、不提交推送、不部署、不写生产/shared',
  approvedBy: 'product-owner 2026-09-06 规划好剩余6项-工作 全量推进',
  impactTests: [
    'backend-node/test/redrawMotionProcessing.test.js',
    'backend-node/test/redrawMotionObscuration.test.js',
    'backend-node/test/redrawMotionCandidate.test.js',
    'backend-node/test/redrawReferenceArtifactImport.test.js',
    'backend-node/test/redrawReferencePreparationOrchestration.test.js',
    'backend-node/test/redrawRoutes.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
function readPreMotionProcessingManifest() {
  const manifest = readPreMotionProcessingPageManifest();
  for (const id of ['stability.admin-provider-observability', 'stability.proactive-canary-and-public-evidence',
    'redraw.coverage-registration-http-route', 'redraw.product-media-http-chain', 'redraw.episode-blueprint-first']) {
    const feature = manifest.features.find((entry) => entry.featureId === id);
    assert.deepEqual(feature.unlock, MOTION_PROCESSING_UNLOCK);
    assert.ok(feature.unlockHistory.length > 0);
    feature.unlock = feature.unlockHistory.pop();
  }
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    'be0cf030f2efcaca8ed05b3a2bf299ad7613c6c2a10128d602ecda1a08ab7e01',
    'Motion processing authorization must preserve the entire pre-stage manifest');
  return manifest;
}
test('处理视频及报告只追加五项本地授权且全部历史门禁不变', () => { readPreMotionProcessingManifest(); });

const MOTION_PROCESSING_PAGE_UNLOCK = {
  reason: '2026-09-06 通用一键转绘 G1.3b 普通页面本地动作处理、预览、四项人工确认与可选报告导入；保留手工上传、防重及未知冻结；不读 Key、不调用供应商、不付费、不提交推送、不部署、不写生产/shared',
  approvedBy: 'product-owner 2026-09-06 规划好剩余6项-工作 全量推进',
  impactTests: [
    'frontweb/test/redrawMotionReferenceApi.test.js',
    'frontweb/test/redrawMotionReferenceUpload.test.js',
    'frontweb/e2e/redraw-backend-integration.spec.js',
    'backend-node/test/redrawMotionProcessing.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
function readPreMotionProcessingPageManifest() {
  const manifest = readPreUnitReferenceMaterialsManifest();
  const feature = manifest.features.find(entry => entry.featureId === 'redraw.episode-blueprint-first');
  assert.deepEqual(feature.unlock, MOTION_PROCESSING_PAGE_UNLOCK);
  assert.ok(feature.unlockHistory.length > 0);
  feature.unlock = feature.unlockHistory.pop();
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    'e2c5832e64bd08f2579ba97324c6571917ce9950e115444c15716367368a0723',
    'Motion page authorization must preserve the entire pre-stage manifest');
  return manifest;
}
test('动作处理页面只追加单项本地授权且全部历史门禁不变', () => { readPreMotionProcessingPageManifest(); });

const UNIT_REFERENCE_MATERIALS_UNLOCK = {
  reason: '2026-09-07 通用一键转绘 G4.0b 当前执行单元只读审批父材料检查；复用覆盖、身份、服装、去字及当前动作验证，不依赖旧父对白包；仅隔离本地真实媒体 TDD，不衍生、不登记、不生成、不计费、不读 Key、不联网、不提交推送、不部署、不写生产/shared',
  approvedBy: 'product-owner 2026-09-06 规划好剩余6项-工作 全量推进；2026-09-07 继续',
  impactTests: [
    'backend-node/test/redrawUnitReference.test.js',
    'backend-node/test/redrawUnitProductionPack.test.js',
    'backend-node/test/redrawReferenceBundle.test.js',
    'backend-node/test/redrawMotionReference.test.js',
    'backend-node/test/redrawMotionCandidate.test.js',
    'backend-node/test/redrawExecutionQueue.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
function readPreUnitReferenceMaterialsManifest() {
  const manifest = readPreUnitMaterialsEntryManifest();
  const feature = manifest.features.find(entry => entry.featureId === 'redraw.product-media-http-chain');
  assert.deepEqual(feature.unlock, UNIT_REFERENCE_MATERIALS_UNLOCK);
  assert.ok(feature.unlockHistory.length > 0);
  feature.unlock = feature.unlockHistory.pop();
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    'e8a729c62e71343f089a49dbac68c089d0f6c56d532dc48b8d00d8f984604a32',
    'Unit materials authorization must preserve the entire pre-stage manifest');
  return manifest;
}
test('执行单元只读父材料只追加精确单项授权且全部历史门禁不变', () => { readPreUnitReferenceMaterialsManifest(); });

const UNIT_MATERIALS_ENTRY_UNLOCK = {
  reason: '2026-09-07 通用一键转绘 G4.0e 普通页面单元素材 GET 检查与显式本地 prepare、API/UI 绑定；仅隔离本地真实媒体 TDD，不读真实 Key、不联网、不调用供应商、不付费、不生成、不提交推送、不运行 CI、不部署、不写生产/shared',
  approvedBy: 'product-owner 2026-09-06 规划好剩余6项-工作 全量推进；2026-09-07 继续',
  impactTests: [
    'backend-node/test/redrawUnitReferenceRoutes.test.js',
    'backend-node/test/redrawSourceVideo.test.js',
    'backend-node/test/redrawPreparedUnitReference.test.js',
    'backend-node/test/redrawUnitReferenceDerivation.test.js',
    'backend-node/test/redrawExecutionQueue.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'frontweb/test/redrawUnitReferenceMaterials.test.js',
    'frontweb/test/redrawExecutionPlanReview.test.js',
    'frontweb/test/redrawExecutionQueue.test.js',
    'frontweb/e2e/redraw-unit-reference-materials.spec.js',
  ],
};
function readPreUnitMaterialsEntryManifest() {
  const manifest = readPreUnitTaskBindingManifest();
  for (const id of EXECUTION_PREVIEW_FEATURE_IDS) {
    const feature = manifest.features.find(entry => entry.featureId === id);
    assert.deepEqual(feature.unlock, UNIT_MATERIALS_ENTRY_UNLOCK);
    assert.ok(feature.unlockHistory.length > 0, id);
    feature.unlock = feature.unlockHistory.pop();
  }
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    '086f8c09873419fe5a92cb2fdaa92f27ce57f9a93355e691f1d48ecdff4f120b',
    'Unit materials entry authorization must preserve the entire pre-stage manifest');
  return manifest;
}
test('普通单元素材入口精确追加五项授权且完整恢复全部前置门禁', () => { readPreUnitMaterialsEntryManifest(); });

const UNIT_TASK_BINDING_UNLOCK = {
  reason: '2026-09-07 通用一键转绘 G4.3 同单元任务与积分预留原子绑定及旧启动/超时结算隔离；仅合成账户与隔离本地数据库 TDD，未知保持待核对，保留普通生成原合同；不读真实 Key、不联网、不调用供应商、不付费、不提交推送、不运行 CI、不部署、不写生产/shared',
  approvedBy: 'product-owner 2026-09-06 规划好剩余6项-工作 全量推进；2026-09-07 继续',
  impactTests: [
    'backend-node/test/redrawExecutionTaskBinding.test.js',
    'backend-node/test/redrawExecutionRun.test.js',
    'backend-node/test/redrawExecutionClaim.test.js',
    'backend-node/test/taskService.test.js',
    'backend-node/test/providerReconciliation.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
function readPreUnitTaskBindingManifest() {
  const manifest = readPreG6IdentityReviewHttpManifest();
  const feature = manifest.features.find(entry => entry.featureId === 'stability.unknown-state-billing-reconciliation');
  assert.ok(feature);
  assert.deepEqual(feature.unlock, UNIT_TASK_BINDING_UNLOCK);
  assert.ok(feature.unlockHistory.length > 0);
  feature.unlock = feature.unlockHistory.pop();
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    '31ab78c8c58142d855026394c6daf968705836b7db9585426799811beee4ea10',
    'Unit task binding authorization must preserve the entire pre-stage manifest');
  return manifest;
}

test('单元任务结算保护仅追加本轮本地记录且完整恢复全部历史功能锁', () => { readPreUnitTaskBindingManifest(); });

const G6_IDENTITY_REVIEW_HTTP_UNLOCK = {
  reason: '2026-09-08 通用一键转绘 G6 身份审批前置条件精确映射 HTTP 409；仅隔离本地 SQLite/图片及真实 HTTP TDD，不读 Key、不联网、不调用供应商、不付费、不提交推送、不运行 CI、不部署、不写生产/shared',
  approvedBy: 'product-owner 2026-09-06 规划好剩余6项-工作 全量推进；2026-09-08 继续',
  impactTests: [
    'backend-node/test/redrawRoutes.test.js',
    'backend-node/test/redrawReferenceArtifactImport.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
function readPreG6IdentityReviewHttpManifest() {
  const manifest = readPreG3WorkspaceMutationManifest();
  for (const id of [
    'redraw.coverage-registration-http-route',
    'redraw.product-media-http-chain',
    'redraw.episode-blueprint-first',
  ]) {
    const feature = manifest.features.find(entry => entry.featureId === id);
    assert.ok(feature, id);
    assert.deepEqual(feature.unlock, G6_IDENTITY_REVIEW_HTTP_UNLOCK);
    assert.ok(feature.unlockHistory.length > 0, id);
    feature.unlock = feature.unlockHistory.pop();
  }
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    'e67a86434acaca7e3979db1aa2d586ab158f410693b11661ccfcb97d6fdb4824',
    'G6 identity review HTTP authorization must preserve the entire pre-stage manifest');
  return manifest;
}
test('G6 身份审批 HTTP 仅追加精确三项授权且完整恢复全部历史功能锁', () => { readPreG6IdentityReviewHttpManifest(); });

const G3_WORKSPACE_MUTATION_UNLOCK = {
  reason: '2026-09-08 通用一键转绘 G3 上传、分析与本地化确认的页面访问隔离；仅真实 Vue 本地 TDD，保留既有读取防护，不读 Key、不联网、不调用供应商、不付费、不提交推送、不运行 CI、不部署、不写生产/shared',
  approvedBy: 'product-owner 2026-09-06 规划好剩余6项-工作 全量推进；2026-09-08 继续',
  impactTests: [
    'frontweb/test/redrawWorkspaceRuntime.test.js',
    'frontweb/test/redrawSourceRuntime.test.js',
    'frontweb/test/redrawExecutionRunParent.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
function readPreG3WorkspaceMutationManifest() {
  const manifest = readPreG3ProjectWorksManifest();
  const feature = manifest.features.find(entry => entry.featureId === 'redraw.episode-blueprint-first');
  assert.ok(feature);
  assert.deepEqual(feature.unlock, G3_WORKSPACE_MUTATION_UNLOCK);
  assert.ok(feature.unlockHistory.length > 0);
  feature.unlock = feature.unlockHistory.pop();
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    '8bd4745d9267890c3f56f4178c72489d5baa854dd0e51868355ed7d0e391a099',
    'G3 workspace mutation authorization must preserve the entire pre-stage manifest');
  return manifest;
}
test('G3 页面访问隔离仅追加精确一项授权且完整恢复全部历史功能锁', () => { readPreG3WorkspaceMutationManifest(); });

const G3_PROJECT_WORKS_UNLOCK = {
  "reason": "2026-09-08 通用一键转绘 G3 项目多作品只读列表与显式选择、新建入口及路由访问隔离；仅本地 SQLite/Vue TDD，保留纯 owner 变化的 pending/unknown 实例，不读 Key、不联网、不调用供应商、不付费、不提交推送、不运行 CI、不部署、不写生产/shared",
  "approvedBy": "product-owner 2026-09-06 规划好剩余6项-工作 全量推进；2026-09-08 继续",
  "impactTests": [
    "backend-node/test/redrawProjectWorks.test.js",
    "backend-node/test/redrawRoutes.test.js",
    "frontweb/test/redrawProjectWorksRuntime.test.js",
    "frontweb/test/redrawWorkspaceRuntime.test.js",
    "frontweb/test/redrawSourceRuntime.test.js",
    "frontweb/test/redrawExecutionRunParent.test.js",
    "backend-node/test/featureLockManifest.test.js"
  ]
};
function readPreG3ProjectWorksManifest() {
  const manifest = readPreG55UnitExportHttpManifest();
  for (const id of [
    'stability.admin-provider-observability',
    'stability.proactive-canary-and-public-evidence',
    'redraw.coverage-registration-http-route',
    'redraw.product-media-http-chain',
    'redraw.episode-blueprint-first',
  ]) {
    const feature = manifest.features.find(entry => entry.featureId === id);
    assert.ok(feature, id);
    assert.deepEqual(feature.unlock, G3_PROJECT_WORKS_UNLOCK);
    assert.ok(feature.unlockHistory.length > 0, id);
    feature.unlock = feature.unlockHistory.pop();
  }
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    '4379ca92bfee3b8b7457844fcdd3b24dceba5431767def7542950de28d451c5d',
    'G3 project works authorization must preserve the entire pre-stage manifest');
  return manifest;
}

test('G3 多作品入口仅追加精确五项授权且完整恢复全部历史功能锁', () => { readPreG3ProjectWorksManifest(); });

const G55_UNIT_EXPORT_HTTP_UNLOCK = {
  reason: '2026-09-09 通用一键转绘 G5.5a 执行单元导出只读 list/get/download GET 接线及真实 JWT/owner 校验、四文件 FD 下载；保留 v1，不改 POST、模型或生产；仅本地 synthetic SQLite/loopback/已安装 FFmpeg TDD，零供应商、零付费，不读真实 Key、不提交推送、不运行 CI、不部署、不写生产/shared 或 Git',
  approvedBy: 'product-owner 2026-09-06 规划好剩余6项-工作 全量推进；2026-09-09 继续',
  impactTests: [
    'backend-node/test/redrawExecutionUnitExportHttp.test.js',
    'backend-node/test/redrawExport.test.js',
    'backend-node/test/redrawCompositionRoutes.test.js',
    'backend-node/test/redrawExecutionUnitCandidateMedia.test.js',
    'backend-node/test/redrawProjectWorks.test.js',
    'backend-node/test/redrawRoutes.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
function readPreG55UnitExportHttpManifest() {
  const manifest = readPreG55bUnitCompositionHttpManifest();
  for (const id of [
    'stability.admin-provider-observability',
    'stability.proactive-canary-and-public-evidence',
    'redraw.coverage-registration-http-route',
    'redraw.product-media-http-chain',
    'redraw.episode-blueprint-first',
  ]) {
    const feature = manifest.features.find(entry => entry.featureId === id);
    assert.ok(feature, id);
    assert.deepEqual(feature.unlock, G55_UNIT_EXPORT_HTTP_UNLOCK);
    assert.ok(feature.unlockHistory.length > 0, id);
    feature.unlock = feature.unlockHistory.pop();
  }
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    '89c020468ce4ca3a4a497e0c4df1c44e868ab8e85e9da7e864fd7d21761180db',
    'G5.5a unit export HTTP authorization must preserve the entire pre-stage manifest');
  return manifest;
}

test('G5.5a 单元导出只读 HTTP 仅追加精确五项授权且完整恢复全部历史功能锁', () => { readPreG55UnitExportHttpManifest(); });

const G55B_UNIT_COMPOSITION_HTTP_UNLOCK = {
  reason: '2026-09-09 通用一键转绘 G5.5b 仅在 backend-node/src/routes/redraw.js 与 index.js 接通既有 POST /redraw/versions/:id/compose 的 unit 五键 HTTP 到六键 service、已鉴权 URL version 与 canReadArtifact、真实本地 scheduler、membership 拒绝零重建、错误映射与幂等防重；三个既有 Composition/Dispatch/Derivation fixture 仅 test-only owner 参数贯通；保留旧 v1/release/readiness/UI，不改模型；仅本地 synthetic SQLite/loopback/已安装 FFmpeg TDD，零供应商、零付费，不读真实 Key、不提交推送、不运行 CI、不部署、不写生产/shared 或 Git',
  approvedBy: 'product-owner 2026-09-06 规划好剩余6项-工作 全量推进；2026-09-09 继续',
  impactTests: [
    'backend-node/test/redrawExecutionUnitCompositionHttp.test.js',
    'backend-node/test/redrawExecutionUnitComposition.test.js',
    'backend-node/test/redrawExecutionUnitDispatch.test.js',
    'backend-node/test/redrawUnitReferenceDerivation.test.js',
    'backend-node/test/redrawCompositionRoutes.test.js',
    'backend-node/test/redrawComposition.test.js',
    'backend-node/test/redrawExecutionUnitExportHttp.test.js',
    'backend-node/test/redrawExport.test.js',
    'backend-node/test/redrawRoutes.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
function readPreG55bUnitCompositionHttpManifest() {
  const manifest = readPreG55cUnitExportIdentityHttpManifest();
  for (const id of [
    'stability.admin-provider-observability',
    'stability.proactive-canary-and-public-evidence',
    'redraw.coverage-registration-http-route',
    'redraw.product-media-http-chain',
    'redraw.episode-blueprint-first',
  ]) {
    const feature = manifest.features.find(entry => entry.featureId === id);
    assert.ok(feature, id);
    assert.deepEqual(feature.unlock, G55B_UNIT_COMPOSITION_HTTP_UNLOCK);
    assert.ok(feature.unlockHistory.length > 0, id);
    feature.unlock = feature.unlockHistory.pop();
  }
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    'aff93e10efe9f1f810791f5b901c13daebe8ca8c1fad86d044711f5dffd3b7b7',
    'G5.5b unit composition HTTP authorization must preserve the entire pre-stage manifest');
  return manifest;
}

test('G5.5b 单元合成 POST 仅追加精确五项授权且完整恢复 G5.5a 及全部历史功能锁', () => { readPreG55bUnitCompositionHttpManifest(); });

const G55C_UNIT_EXPORT_IDENTITY_HTTP_UNLOCK = {
  reason: '2026-09-09 通用一键转绘 G5.5c 仅在 backend-node/src/routes/redraw.js 的 executionUnitExportSummary 为合法 video/unit 导出追加 idempotency_key_sha256 只读投影；严格核验原 release 五键类型边界、request_hash、行版本与无损 UTF-8 幂等键，非法为 null，旧 v1 不新增字段；仅真实 JWT/隔离 SQLite/loopback 的 DTO 查询合同 TDD，不改 index、四个合成服务、schema、鉴权、模型、UI 或生产供应商，不冒称合成下载或页面恢复通过；零供应商、零付费，不读真实 Key、不提交推送、不运行 CI、不部署、不写生产/shared 或 Git',
  approvedBy: 'product-owner 2026-09-06 规划好剩余6项-工作 全量推进；2026-09-09 继续',
  impactTests: [
    'backend-node/test/redrawExecutionUnitExportIdentityHttp.test.js',
    'backend-node/test/redrawExecutionUnitExportHttp.test.js',
    'backend-node/test/redrawExport.test.js',
    'backend-node/test/redrawCompositionRoutes.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
const G55C_UNIT_EXPORT_IDENTITY_HTTP_FEATURE_IDS = [
  'redraw.coverage-registration-http-route',
  'redraw.product-media-http-chain',
  'redraw.episode-blueprint-first',
];
function readPreG55cUnitExportIdentityHttpManifest() {
  const currentManifest = readPreG56UnitDeliveryContextManifest();
  const manifest = structuredClone(currentManifest);
  for (const id of G55C_UNIT_EXPORT_IDENTITY_HTTP_FEATURE_IDS) {
    const feature = manifest.features.find(entry => entry.featureId === id);
    assert.ok(feature, id);
    assert.deepEqual(feature.unlock, G55C_UNIT_EXPORT_IDENTITY_HTTP_UNLOCK);
    assert.ok(feature.unlockHistory.length > 0, id);
    feature.unlock = feature.unlockHistory.pop();
  }
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    'd6ffd25e480e9b398b672cf2fa6f2dd5f01b73247e49e9dfe86c524e562f15f8',
    'G5.5c unit export identity HTTP authorization must preserve the entire pre-stage manifest');
  const changedPaths = ['backend-node/src/routes/redraw.js'];
  assert.throws(
    () => verifyFeatureLock({ repoRoot, currentManifest: manifest, baseManifest: manifest, changedPaths }),
    (error) => {
      assert.equal(error.code, 'FEATURE_LOCKED');
      assert.deepEqual(error.details, G55C_UNIT_EXPORT_IDENTITY_HTTP_FEATURE_IDS.map(featureId => ({
        featureId,
        touched: changedPaths,
      })));
      return true;
    },
  );
  assert.equal(verifyFeatureLock({ repoRoot, currentManifest, baseManifest: manifest, changedPaths }).ready, true);
  return manifest;
}

test('G5.5c 单元导出身份只读投影仅追加实际命中三项授权且完整恢复 G5.5b 及全部历史功能锁', () => { readPreG55cUnitExportIdentityHttpManifest(); });

const G56_UNIT_DELIVERY_CONTEXT_UNLOCK = {
  reason: '2026-09-09 通用一键转绘 G5.6 首片仅七个前端运行时文件的所选 unit run 至第四步只读 GET 核验与 owner/work/version/访问/策略 epoch 隔离；路由 query 仅定位 intent，允许 current_step=1 进入独立 unit 只读第四步但不写 current_step、不放宽旧 shot 生成步骤；unit 模式不初始化旧 readiness/TTS/compose/下载，后继合成提交、未知恢复和文件验收未实现；仅本地真实 Vue renderer TDD，不改 API、后端、全局 store、模型或媒体组件，不冒称浏览器或产品完成；零供应商、零付费，不读真实 Key、不联网、不提交推送、不运行 CI、不部署、不写生产/shared 或 Git',
  approvedBy: 'product-owner 2026-09-06 规划好剩余6项-工作 全量推进；2026-09-09 继续',
  impactTests: [
    'frontweb/test/redrawUnitDeliveryContext.test.js',
    'frontweb/test/redrawSourceRuntime.test.js',
    'frontweb/test/redrawExecutionRunParent.test.js',
    'frontweb/test/redrawExecutionRunPanel.test.js',
    'frontweb/test/redrawExecutionRunLifecycle.test.js',
    'frontweb/test/redrawExecutionRunCandidate.test.js',
    'frontweb/test/redrawExecutionRunDefaultTenant.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
function readPreG56UnitDeliveryContextManifest() {
  const currentManifest = readPreG6EmptyArrayGetBodyManifest();
  const manifest = structuredClone(currentManifest);
  const feature = manifest.features.find(entry => entry.featureId === 'redraw.episode-blueprint-first');
  assert.ok(feature);
  assert.deepEqual(feature.unlock, G56_UNIT_DELIVERY_CONTEXT_UNLOCK);
  assert.ok(feature.unlockHistory.length > 0);
  feature.unlock = feature.unlockHistory.pop();
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    'c3c348ef116a7a143537b220f23ca55c71bd50211576d12e9f1e141cbbf234ef',
    'G5.6 unit delivery context authorization must preserve the entire pre-stage manifest');
  const changedPaths = [
    'frontweb/src/components/redraw/RedrawExecutionRunPanel.vue',
    'frontweb/src/components/redraw/RedrawExecutionPlanReviewPanel.vue',
    'frontweb/src/components/redraw/RedrawLocalizationReviewPanel.vue',
    'frontweb/src/components/redraw/RedrawSourceStep.vue',
    'frontweb/src/views/RedrawWorkspace.vue',
    'frontweb/src/components/redraw/RedrawEditStep.vue',
    'frontweb/src/components/redraw/RedrawEpisodeReleasePanel.vue',
  ];
  assert.throws(
    () => verifyFeatureLock({ repoRoot, currentManifest: manifest, baseManifest: manifest, changedPaths }),
    (error) => {
      assert.equal(error.code, 'FEATURE_LOCKED');
      assert.deepEqual(error.details, [{
        featureId: 'redraw.episode-blueprint-first',
        touched: [
          'frontweb/src/components/redraw/RedrawLocalizationReviewPanel.vue',
          'frontweb/src/components/redraw/RedrawSourceStep.vue',
          'frontweb/src/views/RedrawWorkspace.vue',
        ],
      }]);
      return true;
    },
  );
  assert.equal(verifyFeatureLock({ repoRoot, currentManifest, baseManifest: manifest, changedPaths }).ready, true);
  return manifest;
}

test('G5.6 所选单元运行至第四步只读核验仅追加实际命中一项三路径授权且完整恢复 G5.5c 及全部历史功能锁', () => { readPreG56UnitDeliveryContextManifest(); });

const G6_EMPTY_ARRAY_GET_BODY_UNLOCK = {
  reason: '2026-09-09 通用一键转绘 G6.HTTP_EMPTY_ARRAY_GET_BODY 仅在 backend-node/src/routes/redraw.js 的 executionRunRequest 局部拒绝 GET 数组 body；低层真实 HTTP 空数组返回安全 JSON 400 且零 DML/transport，保留无 body 与空对象 GET、既有 JWT/tenant/owner 鉴权顺序；不改全局 parser、服务、POST、导出、UI、模型或其他 API 合同；仅本地 synthetic SQLite/loopback/已安装 FFmpeg TDD，零供应商、零付费，不读真实 Key、不提交推送、不运行 CI、不部署、不写生产/shared 或 Git',
  approvedBy: 'product-owner 2026-09-06 规划好剩余6项-工作 全量推进；2026-09-09 继续',
  impactTests: [
    'backend-node/test/redrawExecutionRunEmptyArrayBodyHttp.test.js',
    'backend-node/test/redrawExecutionRunRoutes.test.js',
    'backend-node/test/redrawExecutionUnitCandidateMedia.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
const G6_EMPTY_ARRAY_GET_BODY_FEATURE_IDS = [
  'redraw.coverage-registration-http-route',
  'redraw.product-media-http-chain',
  'redraw.episode-blueprint-first',
];
function readPreG6EmptyArrayGetBodyManifest() {
  const currentManifest = readPreG6ComposePermissionDuringAwaitManifest();
  const manifest = structuredClone(currentManifest);
  for (const id of G6_EMPTY_ARRAY_GET_BODY_FEATURE_IDS) {
    const feature = manifest.features.find(entry => entry.featureId === id);
    assert.ok(feature, id);
    assert.deepEqual(feature.unlock, G6_EMPTY_ARRAY_GET_BODY_UNLOCK);
    assert.ok(feature.unlockHistory.length > 0, id);
    feature.unlock = feature.unlockHistory.pop();
  }
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    '8ef287e9c118fe2626e07e41eacdfdda89707d619c30badc5cfc0d89f9d607c2',
    'G6 empty-array GET body authorization must preserve the entire pre-stage manifest');
  const changedPaths = ['backend-node/src/routes/redraw.js'];
  assert.throws(
    () => verifyFeatureLock({ repoRoot, currentManifest: manifest, baseManifest: manifest, changedPaths }),
    (error) => {
      assert.equal(error.code, 'FEATURE_LOCKED');
      assert.deepEqual(error.details, G6_EMPTY_ARRAY_GET_BODY_FEATURE_IDS.map(featureId => ({
        featureId,
        touched: changedPaths,
      })));
      return true;
    },
  );
  assert.equal(verifyFeatureLock({ repoRoot, currentManifest, baseManifest: manifest, changedPaths }).ready, true);
  return manifest;
}

test('G6 空数组 GET body 局部拒绝仅追加实际命中三项授权且完整恢复 G5.6 及全部历史功能锁', () => { readPreG6EmptyArrayGetBodyManifest(); });

const G6_COMPOSE_PERMISSION_DURING_AWAIT_UNLOCK = {
  reason: '2026-09-09 通用一键转绘 G6.COMPOSE_PERMISSION_DURING_AWAIT 仅在 backend-node/src/routes/index.js 的 unit compose POST 保存同步只读 JWT、active user/token_version、active membership/tenant 复核闭包，经 backend-node/src/routes/redraw.js 的 unit ctx 传入 backend-node/src/services/redrawCompositionService.js，在既有创建事务 BEGIN 后、replay/INSERT 前复核；精确映射 UNAUTHORIZED 为 401，成员或租户撤权保持 REDRAW_VERSION_NOT_FOUND 404，拒绝必须零新增 export/assets/调度/provider；保留原 request_hash、幂等、GET、旧 v1 与服务无 HTTP ctx 调用，不改 schema/UI/模型/全局鉴权；仅本地 synthetic SQLite/loopback/已安装 FFmpeg TDD，零供应商、零付费，不读真实 Key、不提交推送、不运行 CI、不部署、不写生产/shared 或 Git',
  approvedBy: 'product-owner 2026-09-06 规划好剩余6项-工作 全量推进；2026-09-09 继续',
  impactTests: [
    'backend-node/test/redrawExecutionUnitCompositionHttp.test.js',
    'backend-node/test/redrawExecutionUnitComposition.test.js',
    'backend-node/test/redrawComposition.test.js',
    'backend-node/test/redrawCompositionRoutes.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
const G6_COMPOSE_PERMISSION_DURING_AWAIT_FEATURE_IDS = [
  'stability.admin-provider-observability',
  'stability.proactive-canary-and-public-evidence',
  'redraw.coverage-registration-http-route',
  'redraw.product-media-http-chain',
  'redraw.episode-blueprint-first',
];
function readPreG6ComposePermissionDuringAwaitManifest() {
  const currentManifest = readPreG6EntryPresentationManifest();
  const manifest = structuredClone(currentManifest);
  for (const id of G6_COMPOSE_PERMISSION_DURING_AWAIT_FEATURE_IDS) {
    const feature = manifest.features.find(entry => entry.featureId === id);
    assert.ok(feature, id);
    assert.deepEqual(feature.unlock, G6_COMPOSE_PERMISSION_DURING_AWAIT_UNLOCK);
    assert.ok(feature.unlockHistory.length > 0, id);
    feature.unlock = feature.unlockHistory.pop();
  }
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    'f3f8b9834c9480a0f207c5d7df3d850dbdedf59c4fa79982b73e6314bced606d',
    'G6 compose permission during await authorization must preserve the entire pre-stage manifest');
  const changedPaths = [
    'backend-node/src/routes/index.js',
    'backend-node/src/routes/redraw.js',
    'backend-node/src/services/redrawCompositionService.js',
  ];
  assert.throws(
    () => verifyFeatureLock({ repoRoot, currentManifest: manifest, baseManifest: manifest, changedPaths }),
    (error) => {
      assert.equal(error.code, 'FEATURE_LOCKED');
      assert.deepEqual(error.details, G6_COMPOSE_PERMISSION_DURING_AWAIT_FEATURE_IDS.map((featureId, index) => ({
        featureId,
        touched: index < 2 ? changedPaths.slice(0, 1) : changedPaths.slice(0, 2),
      })));
      return true;
    },
  );
  assert.equal(verifyFeatureLock({ repoRoot, currentManifest, baseManifest: manifest, changedPaths }).ready, true);
  return manifest;
}

test('G6 合成 await 期间撤权复核仅追加实际命中五项授权且完整恢复空数组 GET 及全部历史功能锁', () => { readPreG6ComposePermissionDuringAwaitManifest(); });

const G6_ENTRY_PRESENTATION_UNLOCK = {
  "reason": "2026-09-09 通用一键转绘 G6.ENTRY_PRESENTATION 修复实际普通登录浏览器发现的局部展示回归：仅四个转绘 SFC 的新建弹窗直接标签主题色、源片/语言两列与比例满行、两处状态标签配色、空预算显示未设置且真实 0 保持；不改 API/DB/预算策略、全局主题、权限或模型；仅本地 TDD、编译和新合成素材浏览器复验，零供应商/付费，不读 Key、不提交推送、不运行 CI、不部署、不写生产/shared",
  "approvedBy": "product-owner 2026-09-06 规划好剩余6项-工作 全量推进；2026-09-09 继续",
  "impactTests": [
    "frontweb/test/redrawEntryPresentation.test.js",
    "frontweb/test/redrawProjectWorksRuntime.test.js",
    "frontweb/test/redrawSourceRuntime.test.js",
    "frontweb/test/redrawExecutionRunParent.test.js",
    "backend-node/test/featureLockManifest.test.js"
  ]
};
function readPreG6EntryPresentationManifest() {
  const currentManifest = readPreG3NoAudioSourceManifest();
  const manifest = structuredClone(currentManifest);
  const feature = manifest.features.find(entry => entry.featureId === 'redraw.episode-blueprint-first');
  assert.deepEqual(feature.unlock, G6_ENTRY_PRESENTATION_UNLOCK);
  assert.ok(feature.unlockHistory.length > 0);
  feature.unlock = feature.unlockHistory.pop();
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    '5670a2937809f876e93179e43d2b8fd1346038c97e21ddd621d60faf39c0753a',
    'G6 entry presentation authorization must preserve the entire pre-stage manifest');
  const changedPaths = [
    'frontweb/src/components/redraw/RedrawSourceStep.vue',
    'frontweb/src/views/RedrawWorkspace.vue',
    'frontweb/src/views/RedrawProjectList.vue',
    'frontweb/src/components/redraw/RedrawProjectOverview.vue',
  ];
  assert.throws(
    () => verifyFeatureLock({ repoRoot, currentManifest: manifest, baseManifest: manifest, changedPaths }),
    error => {
      assert.equal(error.code, 'FEATURE_LOCKED');
      assert.deepEqual(error.details, [{
        featureId: 'redraw.episode-blueprint-first', touched: changedPaths.slice(0, 2),
      }]);
      return true;
    },
  );
  assert.equal(verifyFeatureLock({ repoRoot, currentManifest, baseManifest: manifest, changedPaths }).ready, true);
  return manifest;
}

test('G6 入口局部展示修复仅追加蓝图一项授权并完整保留合成撤权及全部历史门禁', () => { readPreG6EntryPresentationManifest(); });

const G3_NO_AUDIO_SOURCE_UNLOCK = {
  reason: '2026-09-09 通用一键转绘 G3.NO_AUDIO_SOURCE 修复真实双作品默认分析 HTTP 无音轨分支 500：仅蓝图来源音频三字段精确全 null 时保留无音轨语义，部分缺失或非法值继续拒绝；无轨只允许 silent 与空对白，字幕文字保留为文字区域，不伪造音轨或识别；保留有轨校验、哈希和审核门禁。仅本地 TDD 与新合成素材隔离 HTTP 回归，不改模型、Worker、源快照或阈值；零供应商/付费，不读 Key，不提交推送、不运行 CI、不部署、不写生产/shared',
  approvedBy: 'product-owner 2026-09-06 规划好剩余6项-工作 全量推进；2026-09-09 继续',
  impactTests: [
    'backend-node/test/redrawEpisodeBlueprint.test.js',
    'backend-node/test/redrawEvidenceFusion.test.js',
    'backend-node/test/redrawMultiInputProductAnalysisHttp.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
function readPreG3NoAudioSourceManifest() {
  const currentManifest = readPreG2RawSourceEvidenceManifest();
  const manifest = structuredClone(currentManifest);
  const feature = manifest.features.find(entry => entry.featureId === 'redraw.episode-blueprint-first');
  assert.deepEqual(feature.unlock, G3_NO_AUDIO_SOURCE_UNLOCK);
  assert.ok(feature.unlockHistory.length > 0);
  feature.unlock = feature.unlockHistory.pop();
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    'd17a6218b938d2af7259d38753df9b5e36c3965581b35efaaabffd0f46e2718d',
    'G3 no-audio authorization must preserve the entire pre-stage manifest');
  const changedPaths = ['backend-node/src/services/redrawEpisodeBlueprintService.js'];
  assert.throws(
    () => verifyFeatureLock({ repoRoot, currentManifest: manifest, baseManifest: manifest, changedPaths }),
    error => {
      assert.equal(error.code, 'FEATURE_LOCKED');
      assert.deepEqual(error.details, [{ featureId: 'redraw.episode-blueprint-first', touched: changedPaths }]);
      return true;
    },
  );
  assert.equal(verifyFeatureLock({ repoRoot, currentManifest, baseManifest: manifest, changedPaths }).ready, true);
  return manifest;
}

test('G3 无音轨来源修复仅追加蓝图一项授权且完整保留入口展示和全部历史门禁', () => { readPreG3NoAudioSourceManifest(); });


const G2_RAW_SOURCE_EVIDENCE_UNLOCK = {
  "reason": "2026-09-09 通用一键转绘 G2.RAW_SOURCE_EVIDENCE 仅在语言 Worker 客户端本地 preserveSourceEvidence 严格为 true 时返回已通过既有校验的原 result 值 rawSourceEvidence，完整保留秒级时间、原文本和声明 SHA；默认 DTO、单窗 v1、四字段 wire 请求、路径/大小/hash 校验及未知不重试保持，不修改 Worker、模型、阈值或其他消费者；仅合成字节与任务自有 named pipe 本地 TDD，不读 Key、不联网、不调用供应商、不付费、不提交推送、不运行 CI、不部署、不写生产/shared",
  "approvedBy": "product-owner 2026-09-06 规划好剩余6项-工作 全量推进；2026-09-09 采用，冲突时人工确认",
  "impactTests": [
    "backend-node/test/redrawLocaleVerifierClient.test.js",
    "backend-node/test/featureLockManifest.test.js"
  ]
};
function readPreG2RawSourceEvidenceManifest() {
  const currentManifest = readPreG2PcmWindowsManifest();
  const manifest = structuredClone(currentManifest);
  const feature = manifest.features.find(entry => entry.featureId === 'redraw.episode-blueprint-first');
  assert.deepEqual(feature.unlock, G2_RAW_SOURCE_EVIDENCE_UNLOCK);
  assert.ok(feature.unlockHistory.length > 0);
  feature.unlock = feature.unlockHistory.pop();
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    'a0a78b08751836f04e7d72d0305cb99a9a577da2358dd14fd31492bd1f2e5e63',
    'G2 raw source evidence authorization must preserve the entire pre-stage manifest');
  const changedPaths = ['backend-node/src/services/redrawLocaleVerifierClient.js'];
  assert.throws(
    () => verifyFeatureLock({ repoRoot, currentManifest: manifest, baseManifest: manifest, changedPaths }),
    error => {
      assert.equal(error.code, 'FEATURE_LOCKED');
      assert.deepEqual(error.details, [{ featureId: 'redraw.episode-blueprint-first', touched: changedPaths }]);
      return true;
    },
  );
  assert.equal(verifyFeatureLock({ repoRoot, currentManifest, baseManifest: manifest, changedPaths }).ready, true);
  return manifest;
}

test('G2 原回执本地保留仅追加蓝图一项授权并完整保留 G3 无轨及全部历史门禁', () => { readPreG2RawSourceEvidenceManifest(); });

const G2_PCM_WINDOWS_UNLOCK = {
  "reason": "2026-09-09 通用一键转绘 G2.PCM_WINDOWS：仅本地完成 SourceAudio 有界 PCM 分窗与严格 v2 聚合生产者，25 分钟提交窗加 30 秒重叠，每窗保持 64 MiB 限制且仅调用一次；保存全轨/各窗 SHA 和原回执，完整保留识别段、物理来源与逻辑提交归属分离，歧义保留非成功诊断等待人工确认，未知立即停止不重试；全窗与源 CAS 验证后一次登记，原单窗 v1 与无轨保持。不改 Worker、模型、限制或其他消费者，人工审核接线后继实施；仅既有合成媒体/隔离 SQLite/固定本地 FFmpeg/显式 Worker double TDD，不读 Key、不联网、不调用供应商、不付费、不提交推送、不运行 CI、不部署、不写生产/shared",
  "approvedBy": "product-owner 2026-09-06 规划好剩余6项-工作 全量推进；2026-09-09 采用，冲突时人工确认",
  "impactTests": [
    "backend-node/test/redrawSourceAudioWindows.test.js",
    "backend-node/test/redrawSourceAudioWindowAggregation.test.js",
    "backend-node/test/redrawSourceAudioEvidence.test.js",
    "backend-node/test/featureLockManifest.test.js"
  ]
};
function readPreG2PcmWindowsManifest() {
  const currentManifest = readPreG2TaskBindingManifest();
  const manifest = structuredClone(currentManifest);
  const feature = manifest.features.find(entry => entry.featureId === 'redraw.episode-blueprint-first');
  assert.deepEqual(feature.unlock, G2_PCM_WINDOWS_UNLOCK);
  assert.ok(feature.unlockHistory.length > 0);
  feature.unlock = feature.unlockHistory.pop();
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    'ad2ae268cfff16143ef967b1f5768e13bcc0803599a7538e108ed80f3b6a6c8d',
    'G2 PCM windows authorization must preserve the entire pre-stage manifest');
  const changedPaths = ['backend-node/src/services/redrawSourceAudioEvidenceService.js'];
  assert.throws(
    () => verifyFeatureLock({ repoRoot, currentManifest: manifest, baseManifest: manifest, changedPaths }),
    error => {
      assert.equal(error.code, 'FEATURE_LOCKED');
      assert.deepEqual(error.details, [{ featureId: 'redraw.episode-blueprint-first', touched: changedPaths }]);
      return true;
    },
  );
  assert.equal(verifyFeatureLock({ repoRoot, currentManifest, baseManifest: manifest, changedPaths }).ready, true);
  return manifest;
}

test('G2 PCM 分窗只追加生产者授权且保留原回执及全部历史功能门禁', () => { readPreG2PcmWindowsManifest(); });

const G2_TASK_BINDING_UNLOCK = {
  "reason": "2026-09-09 通用一键转绘 G2.TASK_BINDING：仅沿服务器真实 async_task 为 Orchestrator、SourceAudio、Native 接入取消/替换及 owner/源绑定复核；异步返回、后续窗口与最终写入事务内拒绝迟到成功，保留已合法登记资产和已有回执；失效不落旧失败/unknown 收口，不覆盖新作品或误结算 reservation，取消 held 不自动退款/扣款。保留单窗 v1、无轨、内部 UUID、模型及现行有效任务计费，不新增 schema/取消平台/供应商合同；仅隔离 SQLite 和合成底层 doubles 本地 TDD，不读 Key、不联网、不调用供应商、不付费、不提交推送、不运行 CI、不部署、不写生产/shared",
  "approvedBy": "product-owner 2026-09-06 规划好剩余6项-工作 全量推进；2026-09-09 采用，冲突时人工确认",
  "impactTests": [
    "backend-node/test/redrawAnalysisTaskBinding.test.js",
    "backend-node/test/redrawAnalysis.test.js",
    "backend-node/test/redrawNativeSourceAnalysis.test.js",
    "backend-node/test/redrawSourceAudioEvidence.test.js",
    "backend-node/test/redrawSourceAudioWindows.test.js",
    "backend-node/test/featureLockManifest.test.js"
  ]
};
const G2_TASK_BINDING_FEATURE_IDS = ['stability.proactive-canary-and-public-evidence', 'redraw.episode-blueprint-first'];
function readPreG2TaskBindingManifest() {
  const currentManifest = readPreG2SeamCandidateManifest();
  const manifest = structuredClone(currentManifest);
  for (const id of G2_TASK_BINDING_FEATURE_IDS) {
    const feature = manifest.features.find(entry => entry.featureId === id);
    assert.deepEqual(feature.unlock, G2_TASK_BINDING_UNLOCK);
    assert.ok(feature.unlockHistory.length > 0, id);
    feature.unlock = feature.unlockHistory.pop();
  }
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    'ec25d9c38487609ea1b4465bb6bf4a29a975045b5278d5bcfd422e02e13a31f2',
    'G2 task binding authorization must preserve the entire pre-stage manifest');
  const changedPaths = [
    'backend-node/src/services/redrawOrchestrator.js',
    'backend-node/src/services/redrawSourceAudioEvidenceService.js',
    'backend-node/src/services/redrawNativeSourceAnalysisService.js',
  ];
  assert.throws(
    () => verifyFeatureLock({ repoRoot, currentManifest: manifest, baseManifest: manifest, changedPaths }),
    error => {
      assert.equal(error.code, 'FEATURE_LOCKED');
      assert.deepEqual(error.details, G2_TASK_BINDING_FEATURE_IDS.map(featureId => ({
        featureId,
        touched: changedPaths.filter(file => manifest.features.find(entry => entry.featureId === featureId).protectedPaths.includes(file)).sort(),
      })));
      return true;
    },
  );
  assert.equal(verifyFeatureLock({ repoRoot, currentManifest, baseManifest: manifest, changedPaths }).ready, true);
  return manifest;
}

test('G2 真实分析任务绑定仅追加两项授权且完整保留 PCM 分窗及全部历史门禁', () => { readPreG2TaskBindingManifest(); });



const G2_SEAM_CANDIDATE_UNLOCK = {
  "reason": "2026-09-09 通用一键转绘 G2.SEAM_CANDIDATE：仅将 SourceAudio 完整原窗接缝/语言冲突作为非成功候选绑定源快照与真实 async task，事务内当前任务复核后保存 async_tasks.result，保留 held、原回执与全段原文/时标；不创建成功资产/蓝图，不裁句，不重做 ASR 或结算，普通失败和未知语义不变。人审/继续接线后继实施；仅隔离 SQLite 与合成 PCM/底层 Worker double 本地 TDD，不读 Key、不联网、不调用供应商、不付费、不提交推送、不运行 CI、不部署、不写生产/shared",
  "approvedBy": "product-owner 2026-09-06 规划好剩余6项-工作 全量推进；2026-09-09 采用，冲突时人工确认",
  "impactTests": [
    "backend-node/test/redrawSourceAudioSeamCandidate.test.js",
    "backend-node/test/redrawAnalysisTaskBinding.test.js",
    "backend-node/test/redrawSourceAudioWindowAggregation.test.js",
    "backend-node/test/redrawSourceAudioEvidence.test.js",
    "backend-node/test/featureLockManifest.test.js"
  ]
};
function readPreG2SeamCandidateManifest() {
  const currentManifest = readPreG2V2ReviewManifest();
  const manifest = structuredClone(currentManifest);
  for (const id of G2_TASK_BINDING_FEATURE_IDS) {
    const feature = manifest.features.find(entry => entry.featureId === id);
    assert.deepEqual(feature.unlock, G2_SEAM_CANDIDATE_UNLOCK);
    assert.ok(feature.unlockHistory.length > 0, id);
    feature.unlock = feature.unlockHistory.pop();
  }
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    '18097be490a3dd90747a5571e7f32ada01bfad2e0870007ee46cdcc4ba73aa43',
    'G2 seam candidate authorization must preserve the entire pre-stage manifest');
  const changedPaths = [
    'backend-node/src/services/redrawOrchestrator.js',
    'backend-node/src/services/redrawSourceAudioEvidenceService.js',
  ];
  assert.throws(
    () => verifyFeatureLock({ repoRoot, currentManifest: manifest, baseManifest: manifest, changedPaths }),
    error => {
      assert.equal(error.code, 'FEATURE_LOCKED');
      assert.deepEqual(error.details, G2_TASK_BINDING_FEATURE_IDS.map(featureId => ({
        featureId,
        touched: changedPaths.filter(file => manifest.features.find(entry => entry.featureId === featureId).protectedPaths.includes(file)).sort(),
      })));
      return true;
    },
  );
  assert.equal(verifyFeatureLock({ repoRoot, currentManifest, baseManifest: manifest, changedPaths }).ready, true);
  return manifest;
}

test('G2 接缝待审候选仅追加两项授权且完整保留任务绑定及全部历史门禁', () => { readPreG2SeamCandidateManifest(); });


const G2_V2_REVIEW_UNLOCK = {
  "reason": "2026-09-09 通用一键转绘 G2.V2_REVIEW：仅接通经过完整重建及 owner/source/文件 SHA 校验的长音频 v2 到 AnalysisWindow、Fusion、Blueprint、Workflow 草稿创建保存与 SourceDialogue；按实际聚合资产引用传服务端精度上下文，保留原始全段与窗口人物，不全局放宽 v1/视觉整数，不新增模型或客户端权限；Orchestrator 传既有 storageRoot。v2 暂限草稿审核，未验证下游锁定/物化前明确拒绝；接缝候选人审和显式继续仍后继实施。仅本地合成与隔离 SQLite TDD，不读 Key/默认库配置、不联网安装、不真实 Worker/供应商/付费、不 commit/push/CI、不生产/shared/部署",
  "approvedBy": "product-owner 2026-09-06 规划好剩余6项-工作 全量推进；2026-09-09 采用，冲突时人工确认",
  "impactTests": [
    "backend-node/test/redrawSourceAudioV2Review.test.js",
    "backend-node/test/redrawSourceDialogue.test.js",
    "backend-node/test/redrawEvidenceFusion.test.js",
    "backend-node/test/redrawAnalysisWindows.test.js",
    "backend-node/test/redrawEpisodeBlueprint.test.js",
    "backend-node/test/redrawDialogueCorrection.test.js",
    "backend-node/test/redrawAnalysisTaskBinding.test.js",
    "backend-node/test/redrawSourceAudioWindowAggregation.test.js",
    "backend-node/test/featureLockManifest.test.js"
  ]
};
function readPreG2V2ReviewManifest() {
  const currentManifest = readPreG2V2ReviewUiManifest();
  const manifest = structuredClone(currentManifest);
  for (const id of G2_TASK_BINDING_FEATURE_IDS) {
    const feature = manifest.features.find(entry => entry.featureId === id);
    assert.deepEqual(feature.unlock, G2_V2_REVIEW_UNLOCK);
    assert.ok(feature.unlockHistory.length > 0, id);
    feature.unlock = feature.unlockHistory.pop();
  }
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    'a570686c865c761c45203defd70bbc4f479e2ceec5380fcc8130d48db0ca23d9',
    'G2 v2 review authorization must preserve the entire pre-stage manifest');
  const changedPaths = [
    "backend-node/src/services/redrawSourceAudioEvidenceService.js",
    "backend-node/src/services/redrawAnalysisWindowService.js",
    "backend-node/src/services/redrawEvidenceFusionService.js",
    "backend-node/src/services/redrawEpisodeBlueprintService.js",
    "backend-node/src/services/redrawSourceDialogueService.js",
    "backend-node/src/services/redrawBlueprintWorkflowService.js",
    "backend-node/src/services/redrawOrchestrator.js"
];
  assert.throws(
    () => verifyFeatureLock({ repoRoot, currentManifest: manifest, baseManifest: manifest, changedPaths }),
    error => {
      assert.equal(error.code, 'FEATURE_LOCKED');
      assert.deepEqual(error.details, G2_TASK_BINDING_FEATURE_IDS.map(featureId => ({
        featureId,
        touched: changedPaths.filter(file => manifest.features.find(entry => entry.featureId === featureId).protectedPaths.includes(file)).sort(),
      })));
      return true;
    },
  );
  assert.equal(verifyFeatureLock({ repoRoot, currentManifest, baseManifest: manifest, changedPaths }).ready, true);
  return manifest;
}

test('G2 v2 草稿审核消费仅追加授权且完整保留接缝候选及历史门禁', () => { readPreG2V2ReviewManifest(); });

const G2_SEAM_READ_UNLOCK = {
  "reason": "2026-09-09 通用一键转绘 G2.SEAM_READ：仅从当前 owner/work/task/source 的持久接缝候选独立重建原始窗口和冲突原因，核对候选摘要及源文件 SHA，在 await 后复核当前任务、素材、reservation 与时间快照，提供一个严格只读 GET 的完整段候选和后继 CAS 令牌；不自动裁句、不改原文或精度、不把普通 unknown 当可审核、不写库/续跑/重识别/扣退。复用既有 SourceAudio 校验、仅新增对应路由，不改模型或线上合同。仅本地合成 SQLite/文件 TDD，禁止 Key/默认库配置/真实 Worker/供应商/付费/联网安装/commit/push/CI/生产/shared/部署",
  "approvedBy": "product-owner 2026-09-06 规划好剩余6项-工作 全量推进；2026-09-09 采用，冲突时人工确认",
  "impactTests": [
    "backend-node/test/redrawSourceAudioSeamReviewRead.test.js",
    "backend-node/test/redrawSourceAudioSeamCandidate.test.js",
    "backend-node/test/redrawSourceAudioV2Review.test.js",
    "backend-node/test/redrawAnalysisTaskBinding.test.js",
    "backend-node/test/redrawSourceAudioWindowAggregation.test.js",
    "backend-node/test/featureLockManifest.test.js"
  ]
};
function readPreG2SeamReadManifest() {
  const currentManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const manifest = structuredClone(currentManifest);
  const affected = ["stability.admin-provider-observability","stability.proactive-canary-and-public-evidence","redraw.coverage-registration-http-route","redraw.product-media-http-chain","redraw.episode-blueprint-first"];
  for (const id of affected) {
    const feature = manifest.features.find(entry => entry.featureId === id);
    assert.deepEqual(feature.unlock, G2_SEAM_READ_UNLOCK);
    assert.ok(feature.unlockHistory.length > 0, id);
    feature.unlock = feature.unlockHistory.pop();
  }
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    'bd036f56ba6e3a02f167dfb088a14fdad35197c0f135816ac7cf8ff7e7be2d99', 'G2 seam read must preserve the entire pre-stage manifest');
  const changedPaths = [
  "backend-node/src/services/redrawSourceAudioEvidenceService.js",
  "backend-node/src/routes/redraw.js",
  "backend-node/src/routes/index.js",
  "backend-node/test/featureLockManifest.test.js"
];
  assert.throws(
    () => verifyFeatureLock({ repoRoot, currentManifest: manifest, baseManifest: manifest, changedPaths }),
    error => {
      assert.equal(error.code, 'FEATURE_LOCKED');
      assert.deepEqual(error.details, affected.map(featureId => ({
        featureId,
        touched: changedPaths.filter(file => manifest.features.find(entry => entry.featureId === featureId).protectedPaths.includes(file)).sort(),
      })));
      return true;
    },
  );
  assert.equal(verifyFeatureLock({ repoRoot, currentManifest, baseManifest: manifest, changedPaths }).ready, true);
  return manifest;
}

test('G2 持久接缝只读入口仅追加授权且保留全部历史保护', () => { readPreG2SeamReadManifest(); });

const G2_V2_REVIEW_UI_UNLOCK = {
  "reason": "2026-09-09 通用一键转绘 G2.V2_REVIEW_UI：仅在既有审核页从唯一已保存对白及 resolved DTO、源身份和 manifest 绑定识别长音频 v2，保留完整原句与亚毫秒端点，允许修订、恢复和显式窗口人物映射后保存；旧 v1 三位秒数与镜头整数切点不变。允许人审保存但保留 v2 lock/Facts 暂时阻断，不伪称当前草稿已服务端重验；接缝人审和原任务继续仍后继实施。仅本地合成 Vue 组件 TDD/隔离回归，不读 Key/默认库配置、不联网安装、不真实 Worker/供应商/付费、不 commit/push/CI、不生产/shared/部署",
  "approvedBy": "product-owner 2026-09-06 规划好剩余6项-工作 全量推进；2026-09-09 采用，冲突时人工确认",
  "impactTests": [
    "frontweb/test/redrawAudioV2ReviewRuntime.test.js",
    "frontweb/test/redrawDialogueSourceReview.test.js",
    "frontweb/test/redrawDialogueCorrection.test.js",
    "frontweb/test/redrawSpeakerCorrection.test.js",
    "frontweb/test/redrawBoundaryCorrection.test.js",
    "backend-node/test/redrawSourceAudioV2Review.test.js",
    "backend-node/test/redrawDialogueCorrection.test.js",
    "backend-node/test/redrawBoundaryCorrection.test.js",
    "backend-node/test/redrawSpeakerCorrection.test.js",
    "backend-node/test/featureLockManifest.test.js"
  ]
};
function readPreG2V2ReviewUiManifest() {
  const currentManifest = readPreG2SeamReadManifest();
  const manifest = structuredClone(currentManifest);
  const affected = ['redraw.episode-blueprint-first'];
  for (const id of affected) {
    const feature = manifest.features.find(entry => entry.featureId === id);
    assert.deepEqual(feature.unlock, G2_V2_REVIEW_UI_UNLOCK);
    assert.ok(feature.unlockHistory.length > 0, id);
    feature.unlock = feature.unlockHistory.pop();
  }
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    '3908b3efb5e1a7a7680cb93ebf43dbe643960498a018cd9f4d09a48f61b96b57', 'G2 v2 UI must preserve the entire pre-stage manifest');
  const changedPaths = [
    'frontweb/src/utils/redrawBlueprintReviewState.js',
    'frontweb/src/components/redraw/RedrawBlueprintReviewPanel.vue',
    'backend-node/test/featureLockManifest.test.js',
  ];
  assert.throws(
    () => verifyFeatureLock({ repoRoot, currentManifest: manifest, baseManifest: manifest, changedPaths }),
    error => {
      assert.equal(error.code, 'FEATURE_LOCKED');
      assert.deepEqual(error.details, affected.map(featureId => ({
        featureId,
        touched: changedPaths.filter(file => manifest.features.find(entry => entry.featureId === featureId).protectedPaths.includes(file)).sort(),
      })));
      return true;
    },
  );
  assert.equal(verifyFeatureLock({ repoRoot, currentManifest, baseManifest: manifest, changedPaths }).ready, true);
  return manifest;
}
test('G2 v2 审核页仅追加本片授权且保留全部历史保护', () => { readPreG2V2ReviewUiManifest(); });

const PROACTIVE_CANARY_FEATURE_ID = 'stability.proactive-canary-and-public-evidence';
const ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID = 'stability.admin-provider-observability';
const COMPLETE_ACCEPTANCE_FRAMEWORK_ID = 'stability.platform-complete-acceptance-framework';
const REDRAW_COVERAGE_REGISTRATION_FEATURE_ID = 'redraw.coverage-registration-service';
const REDRAW_COVERAGE_HTTP_ROUTE_FEATURE_ID = 'redraw.coverage-registration-http-route';
const REDRAW_CLEAN_PLATE_MEDIA_FEATURE_ID = 'redraw.clean-plate-local-media-registration';
const REDRAW_PRODUCT_MEDIA_HTTP_CHAIN_FEATURE_ID = 'redraw.product-media-http-chain';
const REDRAW_EPISODE_BLUEPRINT_FIRST_FEATURE_ID = 'redraw.episode-blueprint-first';
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
const PR189_CONNECTION_ONLY_VERIFICATION_UNLOCK = {
  reason: '2026-08-24 连接测试仅验证连通性安全修复获批',
  approvedBy: 'product-owner 2026-08-24 pr-189-ci-fix',
  impactTests: [
    'backend-node/test/migrateAiConfigVerification.test.js',
    'backend-node/test/videoProviderVerification.test.js',
    'backend-node/test/aiConfigPublicView.test.js',
    'backend-node/test/providerRouteAdminRoutes.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
const CANVAS_TEXT_CAPABILITY_HOTFIX_EVIDENCE =
  'docs/verification/platform-stability/canvas-text-capability-hotfix-20260824.md';
const CANVAS_TEXT_CAPABILITY_HOTFIX_UNLOCK = {
  reason: '2026-08-24 画布文本线路空能力指纹兼容修复获批',
  approvedBy: 'product-owner 2026-08-24 canvas-text-capability-hotfix',
  impactTests: [
    'backend-node/test/providerCanaryPublicGate.test.js',
    'backend-node/test/providerRouteStability.test.js',
    'backend-node/test/providerRouteTextIntegration.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const PR193_IMAGE_UNKNOWN_CLOSURE_EVIDENCE =
  'docs/verification/platform-stability/pr193-image-unknown-closure-ci-20260825.md';
const PR193_IMAGE_UNKNOWN_CLOSURE_UNLOCK = {
  reason: '2026-08-25 PR #193 图片结果未知安全收口与旧线路兼容 CI 修复获批',
  approvedBy: 'product-owner 2026-08-25 pr-193-ci-fix-approved',
  impactTests: [
    'backend-node/test/djpsdOpenApiImage.test.js',
    'backend-node/test/imageDuplicateGuard.test.js',
    'backend-node/test/imageProviderConfigFailover.test.js',
    'backend-node/test/imageTools.test.js',
    'backend-node/test/providerRouteImageIntegration.test.js',
    'backend-node/test/token6688Image.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
const REDRAW_GENERAL_GENERATION_DELIVERY_UNLOCK = {
  reason: '2026-08-24 通用短剧生成与整集交付计划任务 1-8 获批',
  approvedBy: 'product-owner 2026-08-24 redraw-general-generation-delivery-tasks-1-8',
  impactTests: [
    'backend-node/test/redrawMigration.test.js',
    'backend-node/test/redrawRoutes.test.js',
    'backend-node/test/redrawCandidateReview.test.js',
    'backend-node/test/redrawEpisodeRelease.test.js',
    'frontweb/e2e/redraw-full-product.spec.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
const TOAPIS_BACKUP_DOMAIN_MIGRATION_UNLOCK = {
  reason: '2026-08-27 ToAPIs 官方备用域名迁移获批',
  approvedBy: 'product-owner 2026-08-27 toapis-backup-domain-migration',
  impactTests: [
    'backend-node/test/toapisVideoClient.test.js',
    'backend-node/test/toapisPrivateAvatarService.test.js',
    'backend-node/test/toapisVideoReleaseContract.test.js',
    'backend-node/test/sharedExternalModelReleaseGuard.test.js',
    'frontweb/test/toapisVideoProviderConfig.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const REDRAW_GENERAL_GENERATION_FEATURE_IDS = new Set([
  PROVIDER_ROUTE_CONTRACT_FEATURE_ID,
  ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID,
  PROACTIVE_CANARY_FEATURE_ID,
]);
const PR195_STATIC_ASSET_COMPAT_EVIDENCE =
  'docs/tasks/2026-08-26-static-asset-cross-release-compat.md';
const PR195_STATIC_ASSET_COMPAT_UNLOCK = {
  reason: '2026-08-26 PR #195 跨版本静态资源兼容修复获批',
  approvedBy: 'product-owner 2026-08-26 pr-195-static-asset-cross-release-compat',
  impactTests: [
    'backend-node/test/frontendStaticHosting.test.js',
    'backend-node/test/webProductionDeploymentContract.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const PR194_MAIN_SYNC_EVIDENCE =
  'docs/tasks/2026-08-27-pr194-main-sync-ci-fix.md';
const PR194_MAIN_SYNC_UNLOCK = {
  reason: '2026-08-27 PR #194 合入最新 main 与 Hosted CI 修复获批',
  approvedBy: 'product-owner 2026-08-27 pr-194-main-sync-ci-fix-approved',
  impactTests: [
    'backend-node/test/providerRouteSchema.test.js',
    'backend-node/test/providerCanaryPublicGate.test.js',
    'backend-node/test/redrawMigration.test.js',
    'backend-node/test/redrawRoutes.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const PR208_MAIN_SYNC_UNLOCK = {
  reason: '2026-08-29 PR #208 合入最新 main 与三处功能锁冲突收口获批',
  approvedBy: 'product-owner 2026-08-29 pr-208-main-sync-conflict-resolution',
  impactTests: [
    'backend-node/test/providerRouteStability.test.js',
    'backend-node/test/toapisPrivateAvatarService.test.js',
    'backend-node/test/toapisPrivateAvatarVerification.test.js',
    'backend-node/test/toapisVideoClient.test.js',
    'backend-node/test/toapisVideoIntegration.test.js',
    'backend-node/test/toapisVideoReleaseContract.test.js',
    'backend-node/test/sharedExternalModelReleaseGuard.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
    'frontweb/test/toapisVideoProviderConfig.test.js',
  ],
};
const PR208_MAIN_SYNC_FEATURE_IDS = new Set([
  PROVIDER_ROUTE_CONTRACT_FEATURE_ID,
  SAFE_PROVIDER_FAILOVER_FEATURE_ID,
  UNKNOWN_STATE_RECONCILIATION_FEATURE_ID,
  ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID,
  PROACTIVE_CANARY_FEATURE_ID,
]);
const REDRAW_PRODUCT_MEDIA_REGISTRATION_SPEC =
  'docs/superpowers/specs/2026-08-27-redraw-product-media-registration-addendum.md';
const REDRAW_PRODUCT_MEDIA_REGISTRATION_PLAN =
  'docs/superpowers/plans/2026-08-27-redraw-product-media-registration.md';
const REDRAW_COVERAGE_REGISTRATION_PROTECTED_PATHS = [
  'backend-node/migrations/68_redraw_coverage_registrations.sql',
  'backend-node/src/services/redrawCoverageRegistrationService.js',
];
const REDRAW_COVERAGE_REGISTRATION_REQUIRED_TESTS = [
  'backend-node/test/redrawCoverageRegistration.test.js',
  'backend-node/test/featureLockManifest.test.js',
  'backend-node/test/incrementalReleaseScope.test.js',
];
const REDRAW_COVERAGE_REGISTRATION_TASK_B_UNLOCK = {
  reason: '2026-08-27 一键转绘 coverage 产品登记服务 Task B 获批',
  approvedBy: 'product-owner 2026-08-27 redraw-product-media-registration-task-b',
  impactTests: [
    'backend-node/test/redrawCoverageRegistration.test.js',
    'backend-node/test/redrawFullFrameReview.test.js',
    'backend-node/test/redrawReferenceBundle.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const REDRAW_COVERAGE_HTTP_ROUTE_PROTECTED_PATHS = [
  'backend-node/src/routes/index.js',
  'backend-node/src/routes/redraw.js',
];
const REDRAW_COVERAGE_HTTP_ROUTE_REQUIRED_TESTS = [
  'backend-node/test/redrawRoutes.test.js',
  'backend-node/test/featureLockManifest.test.js',
  'backend-node/test/incrementalReleaseScope.test.js',
];
const REDRAW_COVERAGE_HTTP_ROUTE_TASK_C_INITIAL_UNLOCK = {
  reason: '2026-08-27 一键转绘 coverage 版本级 HTTP 入口 Task C 获批',
  approvedBy: 'product-owner 2026-08-27 redraw-product-media-registration-task-c',
  impactTests: [
    'backend-node/test/redrawRoutes.test.js',
    'backend-node/test/redrawCoverageRegistration.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const REDRAW_COVERAGE_HTTP_ROUTE_TASK_C_UNLOCK = {
  reason: '2026-08-28 coverage 版本级入口显式 provider 装配门禁 P2 修复获批',
  approvedBy: 'product-owner 2026-08-28 redraw-coverage-http-provider-gate-task-c-p2',
  impactTests: [
    'backend-node/test/redrawRoutes.test.js',
    'backend-node/test/redrawCoverageRegistration.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const REDRAW_CLEAN_PLATE_MEDIA_PROTECTED_PATHS = [
  'backend-node/src/services/redrawAssetService.js',
  'backend-node/src/services/redrawProviderAdapters.js',
];
const REDRAW_CLEAN_PLATE_MEDIA_REQUIRED_TESTS = [
  'backend-node/test/redrawAssets.test.js',
  'backend-node/test/redrawProviderAdapters.test.js',
  'backend-node/test/redrawReferencePreparationOrchestration.test.js',
  'backend-node/test/featureLockManifest.test.js',
  'backend-node/test/incrementalReleaseScope.test.js',
];
const REDRAW_CLEAN_PLATE_MEDIA_TASK_D_INITIAL_UNLOCK = {
  reason: '2026-08-28 一键转绘 clean provider 本地媒体登记 Task D 获批',
  approvedBy: 'product-owner 2026-08-28 redraw-product-media-registration-task-d',
  impactTests: [
    'backend-node/test/redrawAssets.test.js',
    'backend-node/test/redrawReferencePreparationOrchestration.test.js',
    'backend-node/test/redrawReferenceBundle.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const REDRAW_CLEAN_PLATE_MEDIA_TASK_D_P1_UNLOCK = {
  reason: '2026-08-28 clean provider 本地媒体双字段污染 P1 修复获批',
  approvedBy: 'product-owner 2026-08-28 redraw-clean-local-media-dual-field-p1-fix',
  impactTests: [
    'backend-node/test/redrawAssets.test.js',
    'backend-node/test/redrawReferencePreparationOrchestration.test.js',
    'backend-node/test/redrawReferenceBundle.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const REDRAW_CLEAN_PLATE_MEDIA_TASK_D_P2_UNLOCK = {
  reason: '2026-08-28 clean provider 默认 adapter 与 legacy 双字段 P2 修复获批',
  approvedBy: 'product-owner 2026-08-28 redraw-clean-adapter-legacy-fields-task-d-p2',
  impactTests: [
    'backend-node/test/redrawAssets.test.js',
    'backend-node/test/redrawProviderAdapters.test.js',
    'backend-node/test/redrawReferencePreparationOrchestration.test.js',
    'backend-node/test/redrawReferenceBundle.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const REDRAW_PRODUCT_MEDIA_HTTP_CHAIN_PROTECTED_PATHS = [
  'backend-node/src/routes/index.js',
  'backend-node/src/routes/redraw.js',
  'backend-node/src/services/redrawAssetService.js',
  'backend-node/src/services/redrawCoverageRegistrationService.js',
  'backend-node/src/services/redrawReferenceBundleService.js',
  'backend-node/src/services/redrawReferencePreparationOrchestrator.js',
];
const REDRAW_PRODUCT_MEDIA_HTTP_CHAIN_REQUIRED_TESTS = [
  'backend-node/test/redrawProductMediaChain.test.js',
  'backend-node/test/redrawRoutes.test.js',
  'backend-node/test/redrawCoverageRegistration.test.js',
  'backend-node/test/redrawAssets.test.js',
  'backend-node/test/redrawReferencePreparationOrchestration.test.js',
  'backend-node/test/redrawReferenceBundle.test.js',
  'backend-node/test/featureLockManifest.test.js',
  'backend-node/test/incrementalReleaseScope.test.js',
];
const REDRAW_EPISODE_BLUEPRINT_FIRST_PROTECTED_PATHS = [
  'backend-node/migrations/72_redraw_episode_blueprints.sql',
  'backend-node/src/db/migrate.js',
  'backend-node/src/routes/index.js',
  'backend-node/src/routes/redraw.js',
  'backend-node/src/services/localizationService.js',
  'backend-node/src/services/redrawBlueprintWorkflowService.js',
  'backend-node/src/services/redrawEpisodeBlueprintService.js',
  'backend-node/src/services/redrawEpisodeFactsService.js',
  'backend-node/src/services/redrawEvidenceFusionService.js',
  'backend-node/src/services/redrawGenerationService.js',
  'backend-node/src/services/redrawLocaleVerifierClient.js',
  'backend-node/src/services/redrawLocalizationOrchestrator.js',
  'backend-node/src/services/redrawNativeSourceAnalysisService.js',
  'backend-node/src/services/redrawOrchestrator.js',
  'backend-node/src/services/redrawShotProductionPackService.js',
  'backend-node/src/services/redrawSourceAudioEvidenceService.js',
  'frontweb/package.json',
  'frontweb/scripts/episodeVideoProviderAdapter.mjs',
  'frontweb/scripts/episodeVideoRouteRegistry.mjs',
  'frontweb/scripts/fuminEpisodeExecutionPlan.mjs',
  'frontweb/scripts/fuminEpisodeMediaPipeline.mjs',
  'frontweb/scripts/fuminEpisodeProviderAdapter.mjs',
  'frontweb/scripts/fuminExecutionMotion.mjs',
  'frontweb/scripts/fuminFullEpisodeDerivedState.mjs',
  'frontweb/scripts/run-redraw-episode-blueprint-live.mjs',
  'frontweb/scripts/run-redraw-fumin-full-episode-live.mjs',
  'frontweb/scripts/run-redraw-video-model-fallback-live.mjs',
  'frontweb/src/api/redraw.js',
  'frontweb/src/components/redraw/RedrawBlueprintReviewPanel.vue',
  'frontweb/src/components/redraw/RedrawLocalizationReviewPanel.vue',
  'frontweb/src/components/redraw/RedrawSourceStep.vue',
  'frontweb/src/utils/redrawBlueprintReviewState.js',
  'frontweb/src/utils/redrawWorkspaceState.js',
  'frontweb/src/views/RedrawWorkspace.vue',
  'workers/redraw-locale-verifier/src/redraw_locale_worker/engines.py',
  'workers/redraw-locale-verifier/src/redraw_locale_worker/server.py',
  'workers/redraw-locale-verifier/src/redraw_locale_worker/source_evidence.py',
];
const REDRAW_EPISODE_BLUEPRINT_FIRST_REQUIRED_TESTS = [
  'backend-node/test/featureLockManifest.test.js',
  'backend-node/test/incrementalReleaseScope.test.js',
  'backend-node/test/redrawAnalysis.test.js',
  'backend-node/test/redrawBlueprintWorkflow.test.js',
  'backend-node/test/redrawEpisodeBlueprint.test.js',
  'backend-node/test/redrawEpisodeFacts.test.js',
  'backend-node/test/redrawEvidenceFusion.test.js',
  'backend-node/test/redrawGeneration.test.js',
  'backend-node/test/redrawLocaleVerifierClient.test.js',
  'backend-node/test/redrawLocalization.test.js',
  'backend-node/test/redrawLocalizationOrchestration.test.js',
  'backend-node/test/redrawMigration.test.js',
  'backend-node/test/redrawNativeSourceAnalysis.test.js',
  'backend-node/test/redrawRoutes.test.js',
  'backend-node/test/redrawShotProductionPack.test.js',
  'backend-node/test/redrawSourceAudioEvidence.test.js',
  'frontweb/e2e/redraw-backend-integration.spec.js',
  'frontweb/e2e/redraw-workspace.spec.js',
  'frontweb/scripts/episodeVideoProviderAdapter.test.mjs',
  'frontweb/scripts/episodeVideoRouteRegistry.test.mjs',
  'frontweb/scripts/fuminEpisodeExecutionPlan.test.mjs',
  'frontweb/scripts/fuminEpisodeMediaPipeline.test.mjs',
  'frontweb/scripts/fuminEpisodeProviderAdapter.test.mjs',
  'frontweb/scripts/fuminExecutionMotion.test.mjs',
  'frontweb/scripts/fuminFullEpisodeDerivedState.test.mjs',
  'frontweb/scripts/run-redraw-episode-blueprint-live.test.mjs',
  'frontweb/scripts/run-redraw-fumin-full-episode-live.test.mjs',
  'frontweb/scripts/run-redraw-video-model-fallback-live.test.mjs',
  'frontweb/src/utils/redrawBlueprintReviewState.test.mjs',
  'frontweb/test/redrawSourceRuntime.test.js',
  'workers/redraw-locale-verifier/tests/test_server.py',
  'workers/redraw-locale-verifier/tests/test_source_evidence.py',
];
const REDRAW_EPISODE_BLUEPRINT_FIRST_EVIDENCE = [
  'docs/superpowers/specs/2026-09-03-episode-blueprint-first-redraw-design.md',
  'docs/superpowers/plans/2026-09-03-episode-blueprint-first-redraw.md',
  'docs/superpowers/specs/2026-09-04-fumin-fixed-five-second-full-episode-generation-design.md',
  'docs/superpowers/plans/2026-09-04-fumin-fixed-five-second-full-episode-generation.md',
  'docs/verification/redraw/fumin-fixed-five-second-full-episode-verification.md',
  'docs/superpowers/specs/2026-09-05-redraw-isolated-video-model-fallback-design.md',
  'docs/superpowers/plans/2026-09-05-redraw-isolated-video-model-fallback.md',
  'docs/verification/redraw/isolated-video-model-fallback-verification.md',
  'docs/superpowers/plans/2026-09-05-toapis-cn-domain-migration.md',
];
const REDRAW_PRODUCT_MEDIA_HTTP_CHAIN_TASK_E_UNLOCK = {
  reason: '2026-08-28 一键转绘真实产品 HTTP 媒体同链回归 Task E 获批',
  approvedBy: 'product-owner 2026-08-28 redraw-product-media-registration-task-e',
  impactTests: REDRAW_PRODUCT_MEDIA_HTTP_CHAIN_REQUIRED_TESTS,
};
const NEWAPI_SHARED_ROUTE_REGISTRATION_UNLOCK = {
  reason: '2026-09-03 NewAPI 中转站成本同步管理路由注册获批',
  approvedBy: 'product-owner 2026-09-03 newapi-config-scoped-capability-binding',
  impactTests: [
    'backend-node/test/providerPricingSync.test.js',
    'backend-node/test/modelPrice.test.js',
    'backend-node/test/redrawRoutes.test.js',
    'backend-node/test/redrawProductMediaChain.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const REDRAW_PRODUCT_MEDIA_REGISTRATION_TASK_A_UNLOCK = {
  reason: '2026-08-27 一键转绘产品媒体登记 Task A 免费模型计费语义获批',
  approvedBy: 'product-owner 2026-08-27 redraw-product-media-registration-task-a',
  impactTests: [
    'backend-node/test/modelPrice.test.js',
    'backend-node/test/redrawAnalysis.test.js',
    'backend-node/test/redrawLocalizationOrchestration.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const FREE_BILLING_REVIEW_FIX_UNLOCK = {
  reason: '2026-08-27 5eee94d8 免费模型迁移原子性与分辨率阶梯修复获批',
  approvedBy: 'product-owner 2026-08-27 free-billing-migration-tier-review-fix-5eee94d8',
  impactTests: [
    'backend-node/test/modelPrice.test.js',
    'backend-node/test/redrawMigration.test.js',
    'backend-node/test/redrawAnalysis.test.js',
    'backend-node/test/redrawLocalizationOrchestration.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const MIGRATION67_IDEMPOTENT_REPLAY_UNLOCK = {
  reason: '2026-08-27 迁移 67 幂等重放与免费模型合同兜底修复获批',
  approvedBy: 'product-owner 2026-08-27 migration67-idempotent-replay-free-contract-fix',
  impactTests: [
    'backend-node/test/modelPrice.test.js',
    'backend-node/test/redrawMigration.test.js',
    'backend-node/test/redrawAnalysis.test.js',
    'backend-node/test/redrawLocalizationOrchestration.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const MIGRATION67_SHARED_HELPER_UNLOCK = {
  reason: '2026-08-27 67851c95 迁移 67 共享保列重建 helper 修复获批',
  approvedBy: 'product-owner 2026-08-27 migration67-shared-column-preserving-helper-fix-67851c95',
  impactTests: [
    'backend-node/test/modelPrice.test.js',
    'backend-node/test/redrawMigration.test.js',
    'backend-node/test/redrawAnalysis.test.js',
    'backend-node/test/redrawLocalizationOrchestration.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const REDRAW_PRODUCT_MEDIA_REGISTRATION_TASK_A_UNLOCK_BY_FEATURE = {
  [PROVIDER_ROUTE_CONTRACT_FEATURE_ID]: {
    ...REDRAW_PRODUCT_MEDIA_REGISTRATION_TASK_A_UNLOCK,
    impactTests: [
      'backend-node/test/modelPrice.test.js',
      'backend-node/test/redrawMigration.test.js',
      'backend-node/test/redrawAnalysis.test.js',
      'backend-node/test/redrawLocalizationOrchestration.test.js',
      'backend-node/test/featureLockManifest.test.js',
      'backend-node/test/incrementalReleaseScope.test.js',
    ],
  },
  [PROACTIVE_CANARY_FEATURE_ID]: REDRAW_PRODUCT_MEDIA_REGISTRATION_TASK_A_UNLOCK,
};
const CURRENT_UNLOCK_BY_FEATURE = {
  [PROVIDER_ROUTE_CONTRACT_FEATURE_ID]: MIGRATION67_SHARED_HELPER_UNLOCK,
  [PROACTIVE_CANARY_FEATURE_ID]: MIGRATION67_SHARED_HELPER_UNLOCK,
};
const REDRAW_COVERAGE_HTTP_ROUTE_TASK_C_FEATURE_IDS = new Set([
  ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID,
  PROACTIVE_CANARY_FEATURE_ID,
]);
const PR197_HELD_CREDIT_AUDIT_EVIDENCE =
  'docs/superpowers/plans/2026-08-27-held-credit-reconciliation-dry-run.md';
const PR197_PROVIDER_CANARY_REMEDIATION_EVIDENCE =
  'docs/superpowers/plans/2026-08-27-provider-canary-metadata-remediation-plan.md';
const PR197_HELD_CREDIT_AUDIT_UNLOCK = {
  reason: '2026-08-27 PR #197 冻结积分只读审计获批',
  approvedBy: 'product-owner 2026-08-27 pr-197-provider-metadata-held-reconciliation-readonly-audit',
  impactTests: [
    'backend-node/test/providerReconciliation.test.js',
    'backend-node/test/billingReconciliation.test.js',
    'backend-node/test/billingReconciliationDryRun.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const PR197_PROVIDER_CANARY_REMEDIATION_UNLOCK = {
  reason: '2026-08-27 PR #197 供应商 Canary 元数据只读修复规划获批',
  approvedBy: 'product-owner 2026-08-27 pr-197-provider-metadata-held-reconciliation-readonly-audit',
  impactTests: [
    'backend-node/test/providerCanaryInventory.test.js',
    'backend-node/test/providerCanaryRemediationPlan.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const TOAPIS_SUBMISSION_RECOVERY_UNLOCK = {
  reason: '2026-08-27 ToAPIs Seedance 未知提交恢复句柄获批',
  approvedBy: 'product-owner 2026-08-27 toapis-submission-recovery',
  impactTests: [
    'backend-node/test/toapisVideoClient.test.js',
    'backend-node/test/toapisVideoIntegration.test.js',
    'backend-node/test/providerRouteStability.test.js',
    'backend-node/test/providerRouteVideoIntegration.test.js',
    'backend-node/test/providerTaskReconciliation.test.js',
    'backend-node/test/providerReconciliation.test.js',
    'backend-node/test/videoBilling.test.js',
    'backend-node/test/videoGenerationRequestSnapshot.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const TOAPIS_SUBMISSION_RECOVERY_FEATURE_IDS = new Set([
  PROVIDER_ROUTE_CONTRACT_FEATURE_ID,
  SAFE_PROVIDER_FAILOVER_FEATURE_ID,
  UNKNOWN_STATE_RECONCILIATION_FEATURE_ID,
  PROACTIVE_CANARY_FEATURE_ID,
]);
const WAN3_INTEGRATION_UNLOCK = {
  reason: '2026-08-29 ToAPIs Wan 3.0 独立接入与未知提交保护获批',
  approvedBy: 'product-owner 2026-08-29 toapis-wan3-local-gate-refresh-approved',
  impactTests: [
    'backend-node/test/toapisWan3VideoClient.test.js',
    'backend-node/test/toapisWan3VideoRuntime.test.js',
    'backend-node/test/videoServiceWan3.test.js',
    'backend-node/test/toapisWan3AiConfig.test.js',
    'backend-node/test/toapisWan3Verification.test.js',
    'backend-node/test/toapisWan3SharedExternalModelReleaseGuard.test.js',
    'backend-node/test/toapisWan3Catalog.test.js',
    'backend-node/test/providerRuntimeFingerprint.test.js',
    'backend-node/test/externalModelEvidenceBinding.test.js',
    'backend-node/test/toapisVideoIntegration.test.js',
    'backend-node/test/sharedReleaseGuardRotation.test.js',
    'frontweb/test/aiConfigProviderPresets.test.js',
    'frontweb/test/videoDurationOptions.test.js',
    'frontweb/test/videoGenerationRequest.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const PR211_CI_LOCK_REFRESH_UNLOCK = {
  reason: '2026-08-30 PR #211 Hosted CI 功能锁批准链刷新获批',
  approvedBy: 'product-owner 2026-08-30 pr-211-ci-fix-approved',
  impactTests: WAN3_INTEGRATION_UNLOCK.impactTests,
};
const WAN3_FULL_CAPABILITY_UNLOCK = {
  reason: '2026-08-31 Wan 3.0 完整能力合同原位升级获批',
  approvedBy: 'product-owner 2026-08-31 wan3-full-capability-contract-approved',
  impactTests: [
    'backend-node/test/billingPublicCatalog.test.js',
    'backend-node/test/canvasModelCatalogService.test.js',
    'backend-node/test/modelPriceMigration.test.js',
    'backend-node/test/toapisWan3ConfigInstaller.test.js',
    'backend-node/test/toapisWan3Catalog.test.js',
    'frontweb/test/aiConfigProviderPresets.test.js',
    'frontweb/test/billingDisplay.test.js',
    'frontweb/test/imageResolutionPricingContract.test.js',
    'frontweb/test/toapisVideoCanvasContract.test.js',
    'frontweb/test/videoGenerationRequest.test.js',
    'frontweb/test/videoResolutionPricingContract.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const WAN3_PROVIDER_ASSET_SIGNING_UNLOCK = {
  reason: '2026-08-31 Wan3 参考素材供应商下载签名修复获批',
  approvedBy: 'product-owner 2026-08-31 wan3-provider-asset-download-repair',
  impactTests: [
    'backend-node/test/providerAssetUrl.test.js',
    'backend-node/test/providerAssetSignedAccess.test.js',
    'backend-node/test/toapisWan3VideoClient.test.js',
    'backend-node/test/videoServiceWan3.test.js',
    'backend-node/test/videoGenerationRequestSnapshot.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const PR217_FUMIN_PRODUCT_API_ACCEPTANCE_UNLOCK = {
  reason: '2026-09-01 PR #217 Fumin 产品 API 单镜验收前置修复获批',
  approvedBy: 'product-owner 2026-09-01 pr-217-fumin-product-api-one-shot-acceptance',
  impactTests: [
    'backend-node/test/fuminVideoClient.test.js',
    'backend-node/test/fuminReferenceAssetService.test.js',
    'backend-node/test/videoGenerationRequestSnapshot.test.js',
    'backend-node/test/redrawGeneration.test.js',
    'backend-node/test/redrawProviderAdapters.test.js',
    'backend-node/test/videoBilling.test.js',
    'backend-node/test/videoQueryTaskStatusOnce.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const REDRAW_COMPLETE_LOCAL_MAIN_MERGE_UNLOCK = {
  reason: '2026-09-04 一键转绘完整主线本地合入最新 main 获批',
  approvedBy: 'product-owner 2026-09-04 redraw-complete-local-main-merge',
  impactTests: [
    'backend-node/test/fuminVideoClient.test.js',
    'backend-node/test/fuminReferenceAssetService.test.js',
    'backend-node/test/videoGenerationRequestSnapshot.test.js',
    'backend-node/test/redrawGeneration.test.js',
    'backend-node/test/videoBilling.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const PR217_REDRAW_GENERATION_REVIEW_CONTEXT_EVIDENCE =
  'docs/verification/platform-stability/pr217-redraw-generation-review-context-20260901.md';
const PR217_REDRAW_GENERATION_REVIEW_CONTEXT_UNLOCK = {
  reason: '2026-09-01 一键转绘真实生成审核上下文一致性修复获批',
  approvedBy: 'product-owner 2026-09-01 continue-next-step-redraw-generation-review-context',
  impactTests: [
    'backend-node/test/redrawRoutes.test.js',
    'backend-node/test/redrawGeneration.test.js',
    'backend-node/test/redrawPreparationGate.test.js',
    'backend-node/test/redrawReviewGate.test.js',
    'backend-node/test/redrawReferenceBundle.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const REDRAW_EPISODE_BLUEPRINT_FIRST_UNLOCK = {
  reason: '2026-09-03 母本蓝图优先一键转绘任务 1-9 获批',
  approvedBy: 'product-owner 2026-09-03 episode-blueprint-first-redraw',
  impactTests: [
    'backend-node/test/redrawEpisodeBlueprint.test.js',
    'backend-node/test/redrawSourceAudioEvidence.test.js',
    'backend-node/test/redrawEvidenceFusion.test.js',
    'backend-node/test/redrawBlueprintWorkflow.test.js',
    'backend-node/test/redrawLocalization.test.js',
    'backend-node/test/redrawShotProductionPack.test.js',
    'backend-node/test/redrawGeneration.test.js',
    'backend-node/test/redrawRoutes.test.js',
    'frontweb/e2e/redraw-workspace.spec.js',
    'frontweb/e2e/redraw-backend-integration.spec.js',
    'frontweb/scripts/run-redraw-episode-blueprint-live.test.mjs',
    'workers/redraw-locale-verifier/tests/test_source_evidence.py',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const REDRAW_EPISODE_BLUEPRINT_HARDENING_UNLOCK = {
  reason: '2026-09-04 母本蓝图整集验收安全与源分镜物化收口获批',
  approvedBy: 'product-owner 2026-09-04 episode-blueprint-first-delivery-hardening',
  impactTests: [
    'backend-node/test/redrawBlueprintWorkflow.test.js',
    'frontweb/scripts/run-redraw-episode-blueprint-live.test.mjs',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
const REDRAW_EPISODE_CULTURAL_ADAPTATION_UNLOCK = {
  reason: '2026-09-04 整集零提交预检文化适配修复获批',
  approvedBy: 'product-owner 2026-09-04 full-episode-zero-submit-cultural-adaptation',
  impactTests: [
    'backend-node/test/redrawShotProductionPack.test.js',
    'backend-node/test/redrawLocalization.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
const FUMIN_FIXED_FIVE_SECOND_FULL_EPISODE_UNLOCK = {
  reason: '2026-09-04 Fumin 固定五秒整集执行方案 A 书面规格获批',
  approvedBy: 'product-owner 2026-09-04 fumin-fixed-five-second-full-episode-option-a',
  impactTests: [
    'frontweb/scripts/fuminEpisodeExecutionPlan.test.mjs',
    'frontweb/scripts/fuminExecutionMotion.test.mjs',
    'frontweb/scripts/fuminEpisodeMediaPipeline.test.mjs',
    'frontweb/scripts/run-redraw-episode-blueprint-live.test.mjs',
    'frontweb/scripts/fuminEpisodeProviderAdapter.test.mjs',
    'frontweb/scripts/run-redraw-fumin-full-episode-live.test.mjs',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const FUMIN_R5_TOP_LEVEL_IDENTITY_REFERENCE_UNLOCK = {
  reason: '2026-09-04 R5 零提交预检顶层身份引用兼容修复',
  approvedBy: 'product-owner 2026-09-04 fumin-fixed-five-second-full-episode-option-a',
  impactTests: [
    'frontweb/scripts/fuminEpisodeExecutionPlan.test.mjs',
    'frontweb/scripts/run-redraw-fumin-full-episode-live.test.mjs',
    'backend-node/test/redrawShotProductionPack.test.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
const FUMIN_VERIFIED_UPSTREAM_SUBMISSION_CONTRACT_UNLOCK = {
  reason: '2026-09-04 Fumin 已验证上游提交合同与未知结果收口获批',
  approvedBy: 'product-owner 2026-09-04 fumin-fixed-five-second-full-episode-option-a',
  impactTests: [
    'frontweb/scripts/fuminEpisodeProviderAdapter.test.mjs',
    'frontweb/scripts/run-redraw-episode-blueprint-live.test.mjs',
    'frontweb/scripts/run-redraw-fumin-full-episode-live.test.mjs',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
const REDRAW_EPISODE_BLUEPRINT_FIRST_TOUCHED_FEATURE_IDS = new Set([
  PROVIDER_ROUTE_CONTRACT_FEATURE_ID,
  ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID,
  PROACTIVE_CANARY_FEATURE_ID,
  REDRAW_COVERAGE_HTTP_ROUTE_FEATURE_ID,
  REDRAW_PRODUCT_MEDIA_HTTP_CHAIN_FEATURE_ID,
]);
const PRE_REDRAW_EPISODE_BLUEPRINT_FIRST_UNLOCK_BY_FEATURE = {
  [PROVIDER_ROUTE_CONTRACT_FEATURE_ID]: WAN3_FULL_CAPABILITY_UNLOCK,
  [ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID]: PR217_FUMIN_PRODUCT_API_ACCEPTANCE_UNLOCK,
  [PROACTIVE_CANARY_FEATURE_ID]: PR217_FUMIN_PRODUCT_API_ACCEPTANCE_UNLOCK,
  [REDRAW_COVERAGE_HTTP_ROUTE_FEATURE_ID]: PR217_REDRAW_GENERATION_REVIEW_CONTEXT_UNLOCK,
  [REDRAW_PRODUCT_MEDIA_HTTP_CHAIN_FEATURE_ID]: PR217_REDRAW_GENERATION_REVIEW_CONTEXT_UNLOCK,
};
const FAILED_GENERATION_RESUBMIT_UNLOCK = {
  reason: '2026-09-01 视频失败终态释放画布重复提交锁获批',
  approvedBy: 'product-owner 2026-09-01 canvas-failed-generation-resubmit',
  impactTests: [
    'backend-node/test/providerReconciliation.test.js',
    'backend-node/test/videoBilling.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const NEWAPI_SIX_MODEL_REMEDIATION_UNLOCK = {
  reason: '2026-09-03 NewAPI 六模型首页、短剧工厂与计费分组修复获批',
  approvedBy: 'product-owner 2026-09-03 newapi-six-model-public-remediation',
  impactTests: [
    'backend-node/test/canvasModelCatalogService.test.js',
    'backend-node/test/modelPrice.test.js',
    'backend-node/test/newapiVideo.test.js',
    'backend-node/test/newapiWan3ConfigInstaller.test.js',
    'backend-node/test/providerModelSelection.test.js',
    'backend-node/test/providerPricingSync.test.js',
    'backend-node/test/videoBilling.test.js',
    'backend-node/test/modelUiProtectionGate.test.js',
    'frontweb/test/billing-model-groups.test.js',
    'frontweb/test/filmListCanvasEntry.test.js',
    'frontweb/test/homeQuickGeneration.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const CANVAS_BILLING_LOGIN_UNLOCK = {
  reason: '2026-09-02 画布充值入口与登录限流修复获批',
  approvedBy: 'product-owner 2026-09-02 canvas-billing-login-rate-limit',
  impactTests: [
    'backend-node/test/authRateLimitProxy.test.js',
    'frontweb/test/canvasBillingAndLogin.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const NEWAPI_SIX_MODEL_PRODUCTION_COPY_UNLOCK = {
  ...NEWAPI_SIX_MODEL_REMEDIATION_UNLOCK,
  reason: '2026-09-03 NewAPI 六模型生产副本复验补丁获批',
  approvedBy: 'product-owner 2026-09-03 newapi-six-model-production-copy-remediation',
};
const NEWAPI_CONFIG_SCOPED_CAPABILITY_UNLOCK = {
  ...NEWAPI_SIX_MODEL_REMEDIATION_UNLOCK,
  reason: '2026-09-03 NewAPI 配置级能力隔离与六模型路由固定获批',
  approvedBy: 'product-owner 2026-09-03 newapi-config-scoped-capability-binding',
  impactTests: [
    ...NEWAPI_SIX_MODEL_REMEDIATION_UNLOCK.impactTests.slice(0, -2),
    'backend-node/test/sharedExternalModelReleaseGuard.test.js',
    'frontweb/test/aiConfigProviderPresets.test.js',
    ...NEWAPI_SIX_MODEL_REMEDIATION_UNLOCK.impactTests.slice(-2),
  ],
};
const NEWAPI_READONLY_PREFLIGHT_UNLOCK = {
  reason: '2026-09-03 NewAPI 计费只读生产预检兼容修复获批',
  approvedBy: 'product-owner 2026-09-03 newapi-readonly-preflight-compat',
  impactTests: [
    'backend-node/test/modelPrice.test.js',
    'backend-node/test/productionPreflight.test.js',
    'backend-node/test/providerPricingSync.test.js',
    'backend-node/test/modelUiProtectionGate.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const TOAPIS_CN_DOMAIN_MIGRATION_UNLOCK = {
  reason: '2026-09-05 ToAPIs 官方域名迁移至 .cn 获批',
  approvedBy: 'product-owner 2026-09-05 toapis-cn-domain-migration',
  impactTests: [
    'backend-node/test/aiConfigService.test.js',
    'backend-node/test/externalModelEvidenceBinding.test.js',
    'backend-node/test/sharedExternalModelReleaseGuard.test.js',
    'backend-node/test/toapisVideoClient.test.js',
    'backend-node/test/toapisVideoVerification.test.js',
    'backend-node/test/toapisWan3Verification.test.js',
    'frontweb/test/aiConfigProviderPresets.test.js',
    'frontweb/test/toapisVideoProviderConfig.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const TOAPIS_CN_DOMAIN_MIGRATION_EVIDENCE =
  'docs/superpowers/plans/2026-09-05-toapis-cn-domain-migration.md';
const NEWAPI_CONFIG_SCOPED_CAPABILITY_FEATURE_IDS = new Set([
  SAFE_PROVIDER_FAILOVER_FEATURE_ID,
  UNKNOWN_STATE_RECONCILIATION_FEATURE_ID,
  ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID,
  PROACTIVE_CANARY_FEATURE_ID,
]);
const NEWAPI_READONLY_PREFLIGHT_FEATURE_IDS = new Set([
  UNKNOWN_STATE_RECONCILIATION_FEATURE_ID,
  PROACTIVE_CANARY_FEATURE_ID,
]);
const REDRAW_COMPLETE_LOCAL_MAIN_MERGE_FEATURE_IDS = new Set([
  SAFE_PROVIDER_FAILOVER_FEATURE_ID,
  UNKNOWN_STATE_RECONCILIATION_FEATURE_ID,
]);
const MERGED_CURRENT_UNLOCK_BY_FEATURE = {
  [PROVIDER_ROUTE_CONTRACT_FEATURE_ID]: REDRAW_EPISODE_BLUEPRINT_FIRST_UNLOCK,
  [SAFE_PROVIDER_FAILOVER_FEATURE_ID]: REDRAW_COMPLETE_LOCAL_MAIN_MERGE_UNLOCK,
  [UNKNOWN_STATE_RECONCILIATION_FEATURE_ID]: REDRAW_COMPLETE_LOCAL_MAIN_MERGE_UNLOCK,
  [ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID]: TOAPIS_CN_DOMAIN_MIGRATION_UNLOCK,
  [PROACTIVE_CANARY_FEATURE_ID]: REDRAW_EPISODE_BLUEPRINT_FIRST_UNLOCK,
};
const MERGED_UNLOCK_HISTORY_TAIL_BY_FEATURE = {
  [PROVIDER_ROUTE_CONTRACT_FEATURE_ID]: [
    WAN3_FULL_CAPABILITY_UNLOCK,
    NEWAPI_SIX_MODEL_REMEDIATION_UNLOCK,
    NEWAPI_SIX_MODEL_PRODUCTION_COPY_UNLOCK,
  ],
  [SAFE_PROVIDER_FAILOVER_FEATURE_ID]: [
    FAILED_GENERATION_RESUBMIT_UNLOCK,
    PR217_FUMIN_PRODUCT_API_ACCEPTANCE_UNLOCK,
    NEWAPI_SIX_MODEL_REMEDIATION_UNLOCK,
    NEWAPI_SIX_MODEL_PRODUCTION_COPY_UNLOCK,
    NEWAPI_CONFIG_SCOPED_CAPABILITY_UNLOCK,
  ],
  [UNKNOWN_STATE_RECONCILIATION_FEATURE_ID]: [
    FAILED_GENERATION_RESUBMIT_UNLOCK,
    PR217_FUMIN_PRODUCT_API_ACCEPTANCE_UNLOCK,
    CANVAS_BILLING_LOGIN_UNLOCK,
    NEWAPI_SIX_MODEL_REMEDIATION_UNLOCK,
    NEWAPI_SIX_MODEL_PRODUCTION_COPY_UNLOCK,
    NEWAPI_CONFIG_SCOPED_CAPABILITY_UNLOCK,
    NEWAPI_READONLY_PREFLIGHT_UNLOCK,
  ],
  [ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID]: [
    WAN3_FULL_CAPABILITY_UNLOCK,
    PR217_FUMIN_PRODUCT_API_ACCEPTANCE_UNLOCK,
    NEWAPI_SIX_MODEL_REMEDIATION_UNLOCK,
    NEWAPI_SIX_MODEL_PRODUCTION_COPY_UNLOCK,
    NEWAPI_CONFIG_SCOPED_CAPABILITY_UNLOCK,
    REDRAW_EPISODE_BLUEPRINT_FIRST_UNLOCK,
  ],
  [PROACTIVE_CANARY_FEATURE_ID]: [
    FAILED_GENERATION_RESUBMIT_UNLOCK,
    PR217_FUMIN_PRODUCT_API_ACCEPTANCE_UNLOCK,
    CANVAS_BILLING_LOGIN_UNLOCK,
    NEWAPI_SIX_MODEL_REMEDIATION_UNLOCK,
    NEWAPI_SIX_MODEL_PRODUCTION_COPY_UNLOCK,
    NEWAPI_CONFIG_SCOPED_CAPABILITY_UNLOCK,
    NEWAPI_READONLY_PREFLIGHT_UNLOCK,
  ],
};
const FUMIN_RESULT_URL_PARSER_UNLOCK = {
  reason: '2026-09-04 Fumin 完成任务结果地址兼容修复获批',
  approvedBy: 'product-owner 2026-09-04 pr217-fumin-result-url-parser-fix',
  impactTests: [
    'frontweb/scripts/fuminEpisodeProviderAdapter.test.mjs',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
const FUMIN_DIALOGUE_PRESERVING_NORMALIZATION_UNLOCK = {
  reason: '2026-09-04 Fumin 对白保留裁剪修复获批',
  approvedBy: 'product-owner 2026-09-04 pr217-fumin-dialogue-preserving-normalization',
  impactTests: [
    'frontweb/scripts/fuminEpisodeMediaPipeline.test.mjs',
    'frontweb/scripts/fuminEpisodeProviderAdapter.test.mjs',
    'frontweb/scripts/run-redraw-episode-blueprint-live.test.mjs',
    'frontweb/scripts/run-redraw-fumin-full-episode-live.test.mjs',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
const REDRAW_ISOLATED_VIDEO_MODEL_FALLBACK_UNLOCK = {
  reason: '2026-09-05 整集转绘隔离多视频模型回退与最多 31 次提交获批',
  approvedBy: 'product-owner 2026-09-05 pr217-isolated-video-model-fallback',
  impactTests: [
    'frontweb/scripts/episodeVideoProviderAdapter.test.mjs',
    'frontweb/scripts/episodeVideoRouteRegistry.test.mjs',
    'frontweb/scripts/fuminEpisodeProviderAdapter.test.mjs',
    'frontweb/scripts/run-redraw-episode-blueprint-live.test.mjs',
    'frontweb/scripts/run-redraw-video-model-fallback-live.test.mjs',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const REDRAW_TOAPIS_CN_DOMAIN_SYNC_UNLOCK = {
  reason: '2026-09-05 按用户确认的 .cn 入口同步 PR #217 整集隔离适配器',
  approvedBy: 'product-owner 2026-09-05 pr217-toapis-cn-domain-sync',
  impactTests: [
    'frontweb/scripts/episodeVideoProviderAdapter.test.mjs',
    'frontweb/scripts/run-redraw-video-model-fallback-live.test.mjs',
    'backend-node/test/toapisVideoClient.test.js',
    'backend-node/test/toapisWan3VideoClient.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const REDRAW_LOCAL_REVIEW_MEDIA_SAFETY_UNLOCK = {
  reason: '2026-09-05 执行主线计划任务 1-3 的本地首镜审核防重、CLI 脱敏与实际 SAR/DAR 校验修复；固定样片仅为回归，不扩展真实调用或上线授权',
  approvedBy: 'product-owner 2026-09-05 开始推进1-3项；主线是一键转绘功能完整开发',
  impactTests: [
    'frontweb/scripts/run-redraw-video-model-fallback-live.test.mjs',
    'frontweb/scripts/run-redraw-episode-blueprint-live.test.mjs',
    'frontweb/scripts/fuminEpisodeMediaPipeline.test.mjs',
    'frontweb/scripts/fuminEpisodeProviderAdapter.test.mjs',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
const REDRAW_GENERIC_SOURCE_INPUT_UNLOCK = {
  reason: '2026-09-05 通用一键转绘主线目标语言保留与源音轨无语音证据本地修复；不改模型、不调用供应商、不付费、不推送、不部署',
  approvedBy: 'product-owner 2026-09-05 开始推进主线剩余任务',
  impactTests: [
    'frontweb/test/redrawGeneralProject.test.js',
    'frontweb/test/redrawSourceRuntime.test.js',
    'frontweb/e2e/redraw-workspace.spec.js',
    'backend-node/test/redrawLocaleVerifierClient.test.js',
    'backend-node/test/redrawSourceAudioEvidence.test.js',
    'backend-node/test/redrawEvidenceFusion.test.js',
    'workers/redraw-locale-verifier/tests/test_source_evidence.py',
    'workers/redraw-locale-verifier/tests/test_server.py',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
const REDRAW_CROSS_SHOT_SOURCE_UNLOCK = {
  reason: '2026-09-05 通用一键转绘主线完整源对白证据、跨镜回放及本地化和生成前校验；不改模型、不调用供应商、不付费、不推送、不部署',
  approvedBy: 'product-owner 2026-09-05 开始进行下一项',
  impactTests: [
    'backend-node/test/redrawSourceDialogue.test.js',
    'backend-node/test/redrawRoutes.test.js',
    'backend-node/test/redrawLocalization.test.js',
    'backend-node/test/redrawLocalizationOrchestration.test.js',
    'backend-node/test/redrawShotProductionPack.test.js',
    'backend-node/test/redrawDialogue.test.js',
    'backend-node/test/redrawDialogueOrchestrator.test.js',
    'backend-node/test/redrawGeneration.test.js',
    'frontweb/test/redrawDialogueSourceReview.test.js',
    'frontweb/e2e/redraw-workspace.spec.js',
    'backend-node/test/featureLockManifest.test.js',
  ],
};
const REDRAW_WINDOWED_ANALYSIS_UNLOCK = {
  reason: '2026-09-05 通用一键转绘长输入分窗分析与默认产品链本地回归；不改模型、不调用供应商、不付费、不推送、不部署',
  approvedBy: 'product-owner 2026-09-05 开始推进下一项',
  impactTests: [
    'backend-node/test/redrawAnalysisWindows.test.js',
    'backend-node/test/redrawNativeSourceAnalysis.test.js',
    'backend-node/test/redrawWindowedProductAnalysis.test.js',
    'backend-node/test/redrawAnalysis.test.js',
    'backend-node/test/redrawEvidenceFusion.test.js',
    'backend-node/test/redrawBlueprintWorkflow.test.js',
    'backend-node/test/redrawRoutes.test.js',
    'backend-node/test/redrawSourceDialogue.test.js',
    'backend-node/test/redrawSourceDialogueGuards.test.js',
    'backend-node/test/featureLockManifest.test.js'
  ]
};
const REDRAW_CROSS_SHOT_SOURCE_TOUCHED_FEATURE_IDS = new Set([
  PROACTIVE_CANARY_FEATURE_ID,
  REDRAW_CLEAN_PLATE_MEDIA_FEATURE_ID,
  REDRAW_COVERAGE_HTTP_ROUTE_FEATURE_ID,
  REDRAW_PRODUCT_MEDIA_HTTP_CHAIN_FEATURE_ID,
]);
const PRE_MERGED_BLUEPRINT_UNLOCK_BY_FEATURE = {
  [PROVIDER_ROUTE_CONTRACT_FEATURE_ID]: NEWAPI_SIX_MODEL_PRODUCTION_COPY_UNLOCK,
  [ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID]: NEWAPI_CONFIG_SCOPED_CAPABILITY_UNLOCK,
  [PROACTIVE_CANARY_FEATURE_ID]: NEWAPI_READONLY_PREFLIGHT_UNLOCK,
  [REDRAW_COVERAGE_HTTP_ROUTE_FEATURE_ID]: NEWAPI_SHARED_ROUTE_REGISTRATION_UNLOCK,
  [REDRAW_PRODUCT_MEDIA_HTTP_CHAIN_FEATURE_ID]: NEWAPI_SHARED_ROUTE_REGISTRATION_UNLOCK,
};
const WAN3_FULL_CAPABILITY_FEATURE_IDS = new Set([
  PROVIDER_ROUTE_CONTRACT_FEATURE_ID,
  ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID,
  PROACTIVE_CANARY_FEATURE_ID,
]);
const GENERATION_CREDIT_TIMEOUT_EVIDENCE =
  'docs/tasks/2026-08-30-generation-credit-timeout.md';
const GENERATION_CREDIT_TIMEOUT_UNLOCK = {
  reason: '2026-08-30 生成冻结积分满 30 分钟自动失败返还获批',
  approvedBy: 'product-owner 2026-08-30 generation-credit-30-minute-auto-refund',
  impactTests: [
    'backend-node/test/providerReconciliation.test.js',
    'backend-node/test/billingReconciliation.test.js',
    'backend-node/test/billingReconciliationDryRun.test.js',
    'backend-node/test/creditLedger.test.js',
    'backend-node/test/providerTaskReconciliation.test.js',
    'backend-node/test/taskService.test.js',
    'backend-node/test/appBackgroundServices.test.js',
    'backend-node/test/providerSubmissionUnknownRecovery.test.js',
    'backend-node/test/videoServiceWan3.test.js',
    'backend-node/test/featureLockManifest.test.js',
    'backend-node/test/incrementalReleaseScope.test.js',
  ],
};
const WAN3_PROVIDER_ASSET_SIGNING_FEATURE_IDS = new Set([
  SAFE_PROVIDER_FAILOVER_FEATURE_ID,
  UNKNOWN_STATE_RECONCILIATION_FEATURE_ID,
  PROACTIVE_CANARY_FEATURE_ID,
]);
const FAILED_GENERATION_RESUBMIT_FEATURE_IDS = new Set(WAN3_PROVIDER_ASSET_SIGNING_FEATURE_IDS);
const CANVAS_BILLING_LOGIN_FEATURE_IDS = new Set([
  UNKNOWN_STATE_RECONCILIATION_FEATURE_ID,
  PROACTIVE_CANARY_FEATURE_ID,
]);
const PRE_NEWAPI_SIX_MODEL_UNLOCK_BY_FEATURE = {
  [PROVIDER_ROUTE_CONTRACT_FEATURE_ID]: WAN3_FULL_CAPABILITY_UNLOCK,
  [SAFE_PROVIDER_FAILOVER_FEATURE_ID]: PR217_FUMIN_PRODUCT_API_ACCEPTANCE_UNLOCK,
  [UNKNOWN_STATE_RECONCILIATION_FEATURE_ID]: CANVAS_BILLING_LOGIN_UNLOCK,
  [ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID]: PR217_FUMIN_PRODUCT_API_ACCEPTANCE_UNLOCK,
  [PROACTIVE_CANARY_FEATURE_ID]: CANVAS_BILLING_LOGIN_UNLOCK,
};
const PRE_MERGED_NEWAPI_HISTORY_TAIL_BY_FEATURE = {
  [PROVIDER_ROUTE_CONTRACT_FEATURE_ID]: PR211_CI_LOCK_REFRESH_UNLOCK,
  [SAFE_PROVIDER_FAILOVER_FEATURE_ID]: FAILED_GENERATION_RESUBMIT_UNLOCK,
  [UNKNOWN_STATE_RECONCILIATION_FEATURE_ID]: PR217_FUMIN_PRODUCT_API_ACCEPTANCE_UNLOCK,
  [ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID]: WAN3_FULL_CAPABILITY_UNLOCK,
  [PROACTIVE_CANARY_FEATURE_ID]: PR217_FUMIN_PRODUCT_API_ACCEPTANCE_UNLOCK,
};
const PRE_WAN3_PROVIDER_ASSET_SIGNING_UNLOCK_BY_FEATURE = {
  [SAFE_PROVIDER_FAILOVER_FEATURE_ID]: PR211_CI_LOCK_REFRESH_UNLOCK,
  [UNKNOWN_STATE_RECONCILIATION_FEATURE_ID]: GENERATION_CREDIT_TIMEOUT_UNLOCK,
  [PROACTIVE_CANARY_FEATURE_ID]: WAN3_FULL_CAPABILITY_UNLOCK,
};
const PR217_FUMIN_PRODUCT_API_ACCEPTANCE_FEATURE_IDS = new Set([
  SAFE_PROVIDER_FAILOVER_FEATURE_ID,
  UNKNOWN_STATE_RECONCILIATION_FEATURE_ID,
  ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID,
  PROACTIVE_CANARY_FEATURE_ID,
  REDRAW_COVERAGE_HTTP_ROUTE_FEATURE_ID,
  REDRAW_PRODUCT_MEDIA_HTTP_CHAIN_FEATURE_ID,
]);
const PRE_PR217_FUMIN_PRODUCT_API_ACCEPTANCE_UNLOCK_BY_FEATURE = {
  [SAFE_PROVIDER_FAILOVER_FEATURE_ID]: WAN3_PROVIDER_ASSET_SIGNING_UNLOCK,
  [UNKNOWN_STATE_RECONCILIATION_FEATURE_ID]: WAN3_PROVIDER_ASSET_SIGNING_UNLOCK,
  [ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID]: WAN3_FULL_CAPABILITY_UNLOCK,
  [PROACTIVE_CANARY_FEATURE_ID]: WAN3_PROVIDER_ASSET_SIGNING_UNLOCK,
  [REDRAW_COVERAGE_HTTP_ROUTE_FEATURE_ID]: REDRAW_COVERAGE_HTTP_ROUTE_TASK_C_UNLOCK,
  [REDRAW_PRODUCT_MEDIA_HTTP_CHAIN_FEATURE_ID]: REDRAW_PRODUCT_MEDIA_HTTP_CHAIN_TASK_E_UNLOCK,
};
const WAN3_INTEGRATION_FEATURE_IDS = new Set(TOAPIS_SUBMISSION_RECOVERY_FEATURE_IDS);
WAN3_INTEGRATION_FEATURE_IDS.add(ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID);
const PRE_TOAPIS_CURRENT_UNLOCK_BY_FEATURE = {
  [PROVIDER_ROUTE_CONTRACT_FEATURE_ID]: PR194_MAIN_SYNC_UNLOCK,
  [SAFE_PROVIDER_FAILOVER_FEATURE_ID]: PR193_IMAGE_UNKNOWN_CLOSURE_UNLOCK,
  [UNKNOWN_STATE_RECONCILIATION_FEATURE_ID]: PR197_HELD_CREDIT_AUDIT_UNLOCK,
  [PROACTIVE_CANARY_FEATURE_ID]: PR194_MAIN_SYNC_UNLOCK,
};
const PRE_WAN3_CURRENT_UNLOCK_BY_FEATURE = {
  [PROVIDER_ROUTE_CONTRACT_FEATURE_ID]: PR208_MAIN_SYNC_UNLOCK,
  [SAFE_PROVIDER_FAILOVER_FEATURE_ID]: PR208_MAIN_SYNC_UNLOCK,
  [UNKNOWN_STATE_RECONCILIATION_FEATURE_ID]: PR208_MAIN_SYNC_UNLOCK,
  [PROACTIVE_CANARY_FEATURE_ID]: PR208_MAIN_SYNC_UNLOCK,
  [ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID]: PR208_MAIN_SYNC_UNLOCK,
};
const PR194_MAIN_SYNC_FEATURE_IDS = new Set([
  PROVIDER_ROUTE_CONTRACT_FEATURE_ID,
  PROACTIVE_CANARY_FEATURE_ID,
]);
const REDRAW_PRODUCT_MEDIA_REGISTRATION_TASK_A_FEATURE_IDS = new Set([
  PROVIDER_ROUTE_CONTRACT_FEATURE_ID,
  PROACTIVE_CANARY_FEATURE_ID,
]);
const PR193_TOUCHED_FEATURE_IDS = new Set([
  PROVIDER_ROUTE_CONTRACT_FEATURE_ID,
  SAFE_PROVIDER_FAILOVER_FEATURE_ID,
  UNKNOWN_STATE_RECONCILIATION_FEATURE_ID,
  PROACTIVE_CANARY_FEATURE_ID,
]);
const PR195_TOUCHED_FEATURE_IDS = new Set([
  UNKNOWN_STATE_RECONCILIATION_FEATURE_ID,
  PROACTIVE_CANARY_FEATURE_ID,
]);
const PR197_TOUCHED_FEATURE_IDS = new Set([
  UNKNOWN_STATE_RECONCILIATION_FEATURE_ID,
  PROACTIVE_CANARY_FEATURE_ID,
]);
const PR197_UNLOCK_BY_FEATURE = {
  [UNKNOWN_STATE_RECONCILIATION_FEATURE_ID]: PR197_HELD_CREDIT_AUDIT_UNLOCK,
  [PROACTIVE_CANARY_FEATURE_ID]: PR197_PROVIDER_CANARY_REMEDIATION_UNLOCK,
};
const PR197_EVIDENCE_BY_FEATURE = {
  [UNKNOWN_STATE_RECONCILIATION_FEATURE_ID]: PR197_HELD_CREDIT_AUDIT_EVIDENCE,
  [PROACTIVE_CANARY_FEATURE_ID]: PR197_PROVIDER_CANARY_REMEDIATION_EVIDENCE,
};
const PRE_PR193_CURRENT_UNLOCK_BY_FEATURE = {
  [PROVIDER_ROUTE_CONTRACT_FEATURE_ID]: PR184_MAIN_MERGE_UNLOCK,
  [SAFE_PROVIDER_FAILOVER_FEATURE_ID]: PR184_MAIN_MERGE_UNLOCK,
  [UNKNOWN_STATE_RECONCILIATION_FEATURE_ID]: PR184_MAIN_MERGE_UNLOCK,
  [PROACTIVE_CANARY_FEATURE_ID]: CANVAS_TEXT_CAPABILITY_HOTFIX_UNLOCK,
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
  'backend-node/migrations/67_model_credit_price_free.sql',
  'backend-node/scripts/plan-provider-canary-remediation.js',
  'backend-node/scripts/split-multi-model-provider-configs.js',
  'backend-node/scripts/verify-feature-lock-manifest.js',
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
  'backend-node/src/services/providerCanaryRemediationPlanService.js',
  'backend-node/src/services/providerCanarySchedulerService.js',
  'backend-node/src/services/providerRouteCostService.js',
  'backend-node/src/services/providerRouteStabilityService.js',
  'backend-node/src/services/providerRuntimeFingerprintService.js',
  'backend-node/src/services/redrawLocalizationOrchestrator.js',
  'backend-node/src/services/redrawOrchestrator.js',
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
  'backend-node/test/providerCanaryRemediationPlan.test.js',
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
  'backend-node/test/redrawAnalysis.test.js',
  'backend-node/test/redrawLocalizationOrchestration.test.js',
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
      'backend-node/scripts/audit-held-credit-reconciliation.js',
      'backend-node/src/app.js',
      'backend-node/src/services/billingReconciliationDryRunService.js',
      'backend-node/src/services/creditLedgerService.js',
      'backend-node/src/services/providerRouteStabilityService.js',
      'backend-node/src/services/providerTaskReconciliationService.js',
      'backend-node/src/services/taskService.js',
      'backend-node/src/services/videoClient.js',
      'backend-node/src/services/videoService.js',
    ],
    requiredTests: [
      'backend-node/test/billingReconciliationDryRun.test.js',
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
      'backend-node/scripts/plan-provider-canary-remediation.js',
      'backend-node/src/app.js',
      'backend-node/src/routes/index.js',
      'backend-node/src/routes/providerStability.js',
      'backend-node/src/services/creditLedgerService.js',
      'backend-node/src/services/providerCanaryRemediationPlanService.js',
      'backend-node/src/services/providerRouteStabilityService.js',
      'backend-node/src/services/providerTaskReconciliationService.js',
      'backend-node/src/services/videoClient.js',
      'backend-node/src/services/videoService.js',
    ],
    requiredTests: [
      'backend-node/test/creditLedger.test.js',
      'backend-node/test/feituoVideoModels.test.js',
      'backend-node/test/imageAssetModelFailover.test.js',
      'backend-node/test/providerCanaryRemediationPlan.test.js',
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
  const manifest = readPreExecutionPreviewManifest();
  assert.equal(manifest.features.every((feature) => feature.module === 'shared'), true);
  assert.equal(manifest.features.some((feature) => /canvas|factory|script-analysis/.test(feature.featureId)), false);
  assert.equal(
    manifest.features.every((feature) => ['locked_pass', 'locked_fixed'].includes(feature.status)),
    true,
  );
});

test('平台完整验收框架锁定为 shared locked_pass 且不提前锁定业务功能', () => {
  const manifest = readPreExecutionPreviewManifest();
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
  const manifest = readPreExecutionPreviewManifest();
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

test('母本蓝图任务刷新主动巡检锁并保留 PR #217、计费与 NewAPI 历史', () => {
  const manifest = readPreExecutionPreviewManifest();
  const feature = manifest.features.find(({ featureId }) => featureId === PROACTIVE_CANARY_FEATURE_ID);
  assert.ok(feature, `缺少功能锁 ${PROACTIVE_CANARY_FEATURE_ID}`);
  assert.deepEqual(feature.unlock, REDRAW_WINDOWED_ANALYSIS_UNLOCK);
  assert.deepEqual(
    feature.unlockHistory.slice(-MERGED_UNLOCK_HISTORY_TAIL_BY_FEATURE[PROACTIVE_CANARY_FEATURE_ID].length - 2),
    [...MERGED_UNLOCK_HISTORY_TAIL_BY_FEATURE[PROACTIVE_CANARY_FEATURE_ID], REDRAW_EPISODE_BLUEPRINT_FIRST_UNLOCK, REDRAW_CROSS_SHOT_SOURCE_UNLOCK],
  );
  assert.ok(feature.unlockHistory.some((entry) => (
    entry.approvedBy === WAN3_PROVIDER_ASSET_SIGNING_UNLOCK.approvedBy
  )));
  assert.equal(feature.evidence.at(-1), REDRAW_PRODUCT_MEDIA_REGISTRATION_PLAN);
  assert.equal(feature.evidence.at(-2), REDRAW_PRODUCT_MEDIA_REGISTRATION_SPEC);
  assert.equal(feature.evidence.at(-3), PR194_MAIN_SYNC_EVIDENCE);
  assert.equal(feature.evidence.at(-4), PR197_PROVIDER_CANARY_REMEDIATION_EVIDENCE);
  assert.equal(feature.evidence.at(-5), PR195_STATIC_ASSET_COMPAT_EVIDENCE);
  assert.equal(feature.evidence.at(-6), PR193_IMAGE_UNKNOWN_CLOSURE_EVIDENCE);
  assert.equal(feature.evidence.at(-7), CANVAS_TEXT_CAPABILITY_HOTFIX_EVIDENCE);
  assert.deepEqual(
    feature.evidence.slice(
      -(PROVIDER_READINESS_TTS_EVIDENCE.length + 7),
      -7,
    ),
    PROVIDER_READINESS_TTS_EVIDENCE,
  );
  for (const testPath of PROVIDER_READINESS_TTS_REQUIRED_TESTS) {
    assert.ok(feature.requiredTests.includes(testPath), `TTS 功能锁缺少影响测试: ${testPath}`);
  }
});

test('Coverage 产品登记服务 Task B 使用独立功能锁覆盖服务和迁移', () => {
  const manifest = readPreExecutionPreviewManifest();
  const feature = manifest.features.find(({ featureId }) => featureId === REDRAW_COVERAGE_REGISTRATION_FEATURE_ID);
  assert.ok(feature, `缺少功能锁 ${REDRAW_COVERAGE_REGISTRATION_FEATURE_ID}`);
  assert.deepEqual(feature.protectedPaths, REDRAW_COVERAGE_REGISTRATION_PROTECTED_PATHS);
  assert.deepEqual(feature.requiredTests, REDRAW_COVERAGE_REGISTRATION_REQUIRED_TESTS);
  assert.deepEqual(feature.evidence, [
    REDRAW_PRODUCT_MEDIA_REGISTRATION_SPEC,
    REDRAW_PRODUCT_MEDIA_REGISTRATION_PLAN,
  ]);
  assert.deepEqual(feature.unlock, REDRAW_COVERAGE_REGISTRATION_TASK_B_UNLOCK);
  assert.notDeepEqual(feature.unlock, PR177_PLATFORM_ACCEPTANCE_UNLOCK);
});

test('Coverage 版本级 HTTP 入口保留生成审核上下文并使用母本蓝图新鲜批准', () => {
  const manifest = readPreExecutionPreviewManifest();
  const feature = manifest.features.find(({ featureId }) => featureId === REDRAW_COVERAGE_HTTP_ROUTE_FEATURE_ID);
  assert.ok(feature, `缺少功能锁 ${REDRAW_COVERAGE_HTTP_ROUTE_FEATURE_ID}`);
  assert.deepEqual(feature.protectedPaths, REDRAW_COVERAGE_HTTP_ROUTE_PROTECTED_PATHS);
  assert.deepEqual(feature.requiredTests, REDRAW_COVERAGE_HTTP_ROUTE_REQUIRED_TESTS);
  assert.deepEqual(feature.evidence, [
    REDRAW_PRODUCT_MEDIA_REGISTRATION_SPEC,
    REDRAW_PRODUCT_MEDIA_REGISTRATION_PLAN,
    PR217_REDRAW_GENERATION_REVIEW_CONTEXT_EVIDENCE,
  ]);
  assert.deepEqual(feature.unlock, REDRAW_CROSS_SHOT_SOURCE_UNLOCK);
  assert.deepEqual(feature.unlockHistory, [
    REDRAW_COVERAGE_HTTP_ROUTE_TASK_C_INITIAL_UNLOCK,
    REDRAW_COVERAGE_HTTP_ROUTE_TASK_C_UNLOCK,
    PR217_FUMIN_PRODUCT_API_ACCEPTANCE_UNLOCK,
    PR217_REDRAW_GENERATION_REVIEW_CONTEXT_UNLOCK,
    NEWAPI_SHARED_ROUTE_REGISTRATION_UNLOCK,
    REDRAW_EPISODE_BLUEPRINT_FIRST_UNLOCK,
  ]);
  assert.notDeepEqual(feature.unlock, REDRAW_COVERAGE_REGISTRATION_TASK_B_UNLOCK);
  assert.notDeepEqual(feature.unlock, PR177_PLATFORM_ACCEPTANCE_UNLOCK);
});

test('Clean provider 本地媒体登记 Task D 使用独立功能锁和新鲜批准', () => {
  const manifest = readPreExecutionPreviewManifest();
  const feature = manifest.features.find(({ featureId }) => featureId === REDRAW_CLEAN_PLATE_MEDIA_FEATURE_ID);
  assert.ok(feature, `缺少功能锁 ${REDRAW_CLEAN_PLATE_MEDIA_FEATURE_ID}`);
  assert.deepEqual(feature.protectedPaths, REDRAW_CLEAN_PLATE_MEDIA_PROTECTED_PATHS);
  assert.deepEqual(feature.requiredTests, REDRAW_CLEAN_PLATE_MEDIA_REQUIRED_TESTS);
  assert.deepEqual(feature.evidence, [
    REDRAW_PRODUCT_MEDIA_REGISTRATION_SPEC,
    REDRAW_PRODUCT_MEDIA_REGISTRATION_PLAN,
  ]);
  assert.deepEqual(feature.unlock, REDRAW_CROSS_SHOT_SOURCE_UNLOCK);
  assert.deepEqual(feature.unlockHistory, [
    REDRAW_CLEAN_PLATE_MEDIA_TASK_D_INITIAL_UNLOCK,
    REDRAW_CLEAN_PLATE_MEDIA_TASK_D_P1_UNLOCK,
    REDRAW_CLEAN_PLATE_MEDIA_TASK_D_P2_UNLOCK,
  ]);
  assert.notDeepEqual(feature.unlock, REDRAW_COVERAGE_REGISTRATION_TASK_B_UNLOCK);
  assert.notDeepEqual(feature.unlock, REDRAW_COVERAGE_HTTP_ROUTE_TASK_C_UNLOCK);
  assert.notDeepEqual(feature.unlock, PR177_PLATFORM_ACCEPTANCE_UNLOCK);
});

test('真实产品 HTTP 媒体同链保留生成审核上下文并使用母本蓝图新鲜批准', () => {
  const manifest = readPreExecutionPreviewManifest();
  const feature = manifest.features.find(({ featureId }) => featureId === REDRAW_PRODUCT_MEDIA_HTTP_CHAIN_FEATURE_ID);
  assert.ok(feature, `缺少功能锁 ${REDRAW_PRODUCT_MEDIA_HTTP_CHAIN_FEATURE_ID}`);
  assert.deepEqual(feature.protectedPaths, REDRAW_PRODUCT_MEDIA_HTTP_CHAIN_PROTECTED_PATHS);
  assert.deepEqual(feature.requiredTests, REDRAW_PRODUCT_MEDIA_HTTP_CHAIN_REQUIRED_TESTS);
  assert.deepEqual(feature.evidence, [
    REDRAW_PRODUCT_MEDIA_REGISTRATION_SPEC,
    REDRAW_PRODUCT_MEDIA_REGISTRATION_PLAN,
    PR217_REDRAW_GENERATION_REVIEW_CONTEXT_EVIDENCE,
  ]);
  assert.deepEqual(feature.unlock, REDRAW_CROSS_SHOT_SOURCE_UNLOCK);
  assert.deepEqual(feature.unlockHistory, [
    REDRAW_PRODUCT_MEDIA_HTTP_CHAIN_TASK_E_UNLOCK,
    PR217_FUMIN_PRODUCT_API_ACCEPTANCE_UNLOCK,
    PR217_REDRAW_GENERATION_REVIEW_CONTEXT_UNLOCK,
    NEWAPI_SHARED_ROUTE_REGISTRATION_UNLOCK,
    REDRAW_EPISODE_BLUEPRINT_FIRST_UNLOCK,
  ]);
  assert.notDeepEqual(feature.unlock, REDRAW_COVERAGE_REGISTRATION_TASK_B_UNLOCK);
  assert.notDeepEqual(feature.unlock, REDRAW_COVERAGE_HTTP_ROUTE_TASK_C_UNLOCK);
  assert.notDeepEqual(feature.unlock, REDRAW_CLEAN_PLATE_MEDIA_TASK_D_P2_UNLOCK);
  assert.notDeepEqual(feature.unlock, PR177_PLATFORM_ACCEPTANCE_UNLOCK);
});

test('母本蓝图优先一键转绘登记本地审核媒体修复并完整保留批准历史', () => {
  const manifest = readPreExecutionPreviewManifest();
  const feature = manifest.features.find(
    ({ featureId }) => featureId === REDRAW_EPISODE_BLUEPRINT_FIRST_FEATURE_ID,
  );
  assert.ok(feature, `缺少功能锁 ${REDRAW_EPISODE_BLUEPRINT_FIRST_FEATURE_ID}`);
  assert.equal(feature.module, 'shared');
  assert.equal(feature.status, 'locked_pass');
  assert.deepEqual(feature.protectedPaths, REDRAW_EPISODE_BLUEPRINT_FIRST_PROTECTED_PATHS);
  assert.deepEqual(feature.requiredTests, REDRAW_EPISODE_BLUEPRINT_FIRST_REQUIRED_TESTS);
  assert.deepEqual(feature.evidence, REDRAW_EPISODE_BLUEPRINT_FIRST_EVIDENCE);
  assert.equal(feature.fixCommit, null);
  assert.deepEqual(feature.unlock, REDRAW_WINDOWED_ANALYSIS_UNLOCK);
  assert.deepEqual(feature.unlockHistory, [
    REDRAW_EPISODE_BLUEPRINT_HARDENING_UNLOCK,
    REDRAW_EPISODE_CULTURAL_ADAPTATION_UNLOCK,
    FUMIN_FIXED_FIVE_SECOND_FULL_EPISODE_UNLOCK,
    FUMIN_R5_TOP_LEVEL_IDENTITY_REFERENCE_UNLOCK,
    FUMIN_VERIFIED_UPSTREAM_SUBMISSION_CONTRACT_UNLOCK,
    FUMIN_RESULT_URL_PARSER_UNLOCK,
    FUMIN_DIALOGUE_PRESERVING_NORMALIZATION_UNLOCK,
    REDRAW_ISOLATED_VIDEO_MODEL_FALLBACK_UNLOCK,
    REDRAW_TOAPIS_CN_DOMAIN_SYNC_UNLOCK,
    REDRAW_LOCAL_REVIEW_MEDIA_SAFETY_UNLOCK,
    REDRAW_GENERIC_SOURCE_INPUT_UNLOCK,
    REDRAW_CROSS_SHOT_SOURCE_UNLOCK,
  ]);
});

test('母本蓝图任务为实际触及的五个既有功能锁登记新鲜批准', () => {
  const manifest = readPreExecutionPreviewManifest();
  for (const featureId of REDRAW_EPISODE_BLUEPRINT_FIRST_TOUCHED_FEATURE_IDS) {
    const feature = manifest.features.find((entry) => entry.featureId === featureId);
    assert.ok(feature, `缺少功能锁 ${featureId}`);
    assert.deepEqual(
      feature.unlock,
      featureId === ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID
        ? TOAPIS_CN_DOMAIN_MIGRATION_UNLOCK
        : featureId === PROACTIVE_CANARY_FEATURE_ID ? REDRAW_WINDOWED_ANALYSIS_UNLOCK
        : REDRAW_CROSS_SHOT_SOURCE_TOUCHED_FEATURE_IDS.has(featureId)
          ? REDRAW_CROSS_SHOT_SOURCE_UNLOCK : REDRAW_EPISODE_BLUEPRINT_FIRST_UNLOCK,
    );
    assert.deepEqual(
      feature.unlockHistory.at(-1),
      featureId === PROACTIVE_CANARY_FEATURE_ID ? REDRAW_CROSS_SHOT_SOURCE_UNLOCK
        : featureId === ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID || REDRAW_CROSS_SHOT_SOURCE_TOUCHED_FEATURE_IDS.has(featureId)
        ? REDRAW_EPISODE_BLUEPRINT_FIRST_UNLOCK
        : PRE_MERGED_BLUEPRINT_UNLOCK_BY_FEATURE[featureId],
    );
  }
});

test('ToAPIs 未知提交恢复批准在后续转绘更新后仍保留于四个锁', () => {
  const manifest = readPreExecutionPreviewManifest();
  for (const featureId of TOAPIS_SUBMISSION_RECOVERY_FEATURE_IDS) {
    const feature = manifest.features.find((entry) => entry.featureId === featureId);
    assert.ok(feature, `缺少功能锁 ${featureId}`);
    assert.ok(
      [...feature.unlockHistory, feature.unlock].some((entry) => (
        entry.reason === TOAPIS_SUBMISSION_RECOVERY_UNLOCK.reason
          && entry.approvedBy === TOAPIS_SUBMISSION_RECOVERY_UNLOCK.approvedBy
      )),
      `${featureId} 缺少 ToAPIs 未知提交恢复批准`,
    );
    assert.equal(
      feature.evidence.includes('docs/superpowers/plans/2026-08-27-toapis-submission-recovery.md'),
      false,
    );
  }
});

test('供应商任务凭证与四轮无产物质量修复使用分阶段新鲜批准并保留完整历史', () => {
  const manifest = readPreExecutionPreviewManifest();
  for (const [featureId, requirements] of Object.entries(PROVIDER_TASK_LOCK_REQUIREMENTS)) {
    const feature = manifest.features.find((entry) => entry.featureId === featureId);
    assert.ok(feature, `缺少功能锁 ${featureId}`);
    const qualityFixTouched = PROVIDER_TASK_ARTIFACT_QUALITY_FEATURE_IDS.has(featureId);
    const liveCompatTouched = PROVIDER_TASK_LIVE_COMPAT_FEATURE_IDS.has(featureId);
    const previousUnlock = qualityFixTouched
      ? PROVIDER_TASK_STATUS_DECISION_UNLOCK
      : PROVIDER_TASK_RECEIPT_UNLOCK;
    const providerAssetSigningTouched = WAN3_PROVIDER_ASSET_SIGNING_FEATURE_IDS.has(featureId);
    const failedGenerationResubmitTouched = FAILED_GENERATION_RESUBMIT_FEATURE_IDS.has(featureId);
    assert.deepEqual(feature.unlock, featureId === PROACTIVE_CANARY_FEATURE_ID ? REDRAW_WINDOWED_ANALYSIS_UNLOCK
      : REDRAW_CROSS_SHOT_SOURCE_TOUCHED_FEATURE_IDS.has(featureId)
      ? REDRAW_CROSS_SHOT_SOURCE_UNLOCK : MERGED_CURRENT_UNLOCK_BY_FEATURE[featureId]);
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
      ...(featureId === ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID ? [PR184_MAIN_MERGE_UNLOCK] : []),
      ...(featureId === PROACTIVE_CANARY_FEATURE_ID ? [PR184_MAIN_MERGE_UNLOCK] : []),
      ...(PR193_TOUCHED_FEATURE_IDS.has(featureId)
        ? [PRE_PR193_CURRENT_UNLOCK_BY_FEATURE[featureId]]
        : []),
      ...(featureId === ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID
        ? [PR189_CONNECTION_ONLY_VERIFICATION_UNLOCK]
        : []),
      ...(PR193_TOUCHED_FEATURE_IDS.has(featureId)
        && REDRAW_GENERAL_GENERATION_FEATURE_IDS.has(featureId)
        ? [REDRAW_GENERAL_GENERATION_DELIVERY_UNLOCK]
        : []),
      ...(PR195_TOUCHED_FEATURE_IDS.has(featureId)
        ? [PR193_IMAGE_UNKNOWN_CLOSURE_UNLOCK]
        : []),
      ...(PR197_TOUCHED_FEATURE_IDS.has(featureId)
        ? [PR195_STATIC_ASSET_COMPAT_UNLOCK]
        : []),
      ...(PR194_MAIN_SYNC_FEATURE_IDS.has(featureId)
        ? [featureId === PROACTIVE_CANARY_FEATURE_ID
          ? PR197_PROVIDER_CANARY_REMEDIATION_UNLOCK
          : PR193_IMAGE_UNKNOWN_CLOSURE_UNLOCK]
        : []),
      ...(featureId === PROVIDER_ROUTE_CONTRACT_FEATURE_ID
        ? [
          PR194_MAIN_SYNC_UNLOCK,
          TOAPIS_SUBMISSION_RECOVERY_UNLOCK,
          REDRAW_PRODUCT_MEDIA_REGISTRATION_TASK_A_UNLOCK_BY_FEATURE[PROVIDER_ROUTE_CONTRACT_FEATURE_ID],
          MIGRATION67_IDEMPOTENT_REPLAY_UNLOCK,
        ]
        : []),
      ...(featureId === PROACTIVE_CANARY_FEATURE_ID
        ? [
          PR194_MAIN_SYNC_UNLOCK,
          TOAPIS_SUBMISSION_RECOVERY_UNLOCK,
          REDRAW_PRODUCT_MEDIA_REGISTRATION_TASK_A_UNLOCK,
          FREE_BILLING_REVIEW_FIX_UNLOCK,
          MIGRATION67_IDEMPOTENT_REPLAY_UNLOCK,
        ]
        : []),
      ...(REDRAW_COVERAGE_HTTP_ROUTE_TASK_C_FEATURE_IDS.has(featureId)
        ? [
          featureId === PROACTIVE_CANARY_FEATURE_ID
            ? MIGRATION67_SHARED_HELPER_UNLOCK
            : REDRAW_GENERAL_GENERATION_DELIVERY_UNLOCK,
          ...(featureId === ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID
            ? [TOAPIS_BACKUP_DOMAIN_MIGRATION_UNLOCK]
            : []),
          REDRAW_COVERAGE_HTTP_ROUTE_TASK_C_INITIAL_UNLOCK,
        ]
        : []),
      ...([SAFE_PROVIDER_FAILOVER_FEATURE_ID, UNKNOWN_STATE_RECONCILIATION_FEATURE_ID].includes(featureId)
        ? [PRE_TOAPIS_CURRENT_UNLOCK_BY_FEATURE[featureId]]
        : []),
      ...(PR208_MAIN_SYNC_FEATURE_IDS.has(featureId)
        ? [featureId === PROVIDER_ROUTE_CONTRACT_FEATURE_ID
          ? CURRENT_UNLOCK_BY_FEATURE[featureId]
          : [SAFE_PROVIDER_FAILOVER_FEATURE_ID, UNKNOWN_STATE_RECONCILIATION_FEATURE_ID].includes(featureId)
            ? TOAPIS_SUBMISSION_RECOVERY_UNLOCK
            : REDRAW_COVERAGE_HTTP_ROUTE_TASK_C_UNLOCK]
        : []),
      ...(WAN3_INTEGRATION_FEATURE_IDS.has(featureId)
        ? [PRE_WAN3_CURRENT_UNLOCK_BY_FEATURE[featureId]]
        : []),
      ...(WAN3_INTEGRATION_FEATURE_IDS.has(featureId)
        ? [WAN3_INTEGRATION_UNLOCK]
        : []),
      ...(WAN3_FULL_CAPABILITY_FEATURE_IDS.has(featureId)
        ? [PR211_CI_LOCK_REFRESH_UNLOCK]
        : []),
      ...(featureId === UNKNOWN_STATE_RECONCILIATION_FEATURE_ID
        ? [PR211_CI_LOCK_REFRESH_UNLOCK]
        : []),
      ...(providerAssetSigningTouched
        ? [PRE_WAN3_PROVIDER_ASSET_SIGNING_UNLOCK_BY_FEATURE[featureId]]
        : []),
      ...(failedGenerationResubmitTouched
        ? [WAN3_PROVIDER_ASSET_SIGNING_UNLOCK]
        : []),
      ...MERGED_UNLOCK_HISTORY_TAIL_BY_FEATURE[featureId],
      ...(featureId === PROACTIVE_CANARY_FEATURE_ID ? [REDRAW_EPISODE_BLUEPRINT_FIRST_UNLOCK, REDRAW_CROSS_SHOT_SOURCE_UNLOCK] : []),
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
        feature.evidence.slice(
          featureId === PROACTIVE_CANARY_FEATURE_ID
            ? -(PROVIDER_READINESS_TTS_EVIDENCE.length + 7)
            : -(PROVIDER_READINESS_TTS_EVIDENCE.length + 1),
          featureId === PROACTIVE_CANARY_FEATURE_ID ? -7 : -1,
        ),
        PROVIDER_READINESS_TTS_EVIDENCE,
      );
      if (featureId === PROACTIVE_CANARY_FEATURE_ID) {
        assert.equal(feature.evidence.at(-1), REDRAW_PRODUCT_MEDIA_REGISTRATION_PLAN);
        assert.equal(feature.evidence.at(-2), REDRAW_PRODUCT_MEDIA_REGISTRATION_SPEC);
        assert.equal(feature.evidence.at(-3), PR194_MAIN_SYNC_EVIDENCE);
        assert.equal(feature.evidence.at(-4), PR197_PROVIDER_CANARY_REMEDIATION_EVIDENCE);
        assert.equal(feature.evidence.at(-5), PR195_STATIC_ASSET_COMPAT_EVIDENCE);
        assert.equal(feature.evidence.at(-6), PR193_IMAGE_UNKNOWN_CLOSURE_EVIDENCE);
        assert.equal(feature.evidence.at(-7), CANVAS_TEXT_CAPABILITY_HOTFIX_EVIDENCE);
      } else {
        assert.equal(feature.evidence.at(-1), TOAPIS_CN_DOMAIN_MIGRATION_EVIDENCE);
      }
    } else if (liveCompatTouched) {
      if (REDRAW_PRODUCT_MEDIA_REGISTRATION_TASK_A_FEATURE_IDS.has(featureId)) {
        assert.equal(feature.evidence.at(-1), REDRAW_PRODUCT_MEDIA_REGISTRATION_PLAN);
        assert.equal(feature.evidence.at(-2), REDRAW_PRODUCT_MEDIA_REGISTRATION_SPEC);
        assert.equal(feature.evidence.at(-3), PR194_MAIN_SYNC_EVIDENCE);
        assert.equal(feature.evidence.at(-4), PR193_IMAGE_UNKNOWN_CLOSURE_EVIDENCE);
        assert.equal(feature.evidence.at(-5), PROVIDER_TASK_LIVE_COMPAT_EVIDENCE);
      } else if (PR194_MAIN_SYNC_FEATURE_IDS.has(featureId)) {
        assert.equal(feature.evidence.at(-1), PR194_MAIN_SYNC_EVIDENCE);
        assert.equal(feature.evidence.at(-2), PR193_IMAGE_UNKNOWN_CLOSURE_EVIDENCE);
        assert.equal(feature.evidence.at(-3), PROVIDER_TASK_LIVE_COMPAT_EVIDENCE);
      } else if (PR197_TOUCHED_FEATURE_IDS.has(featureId)) {
        const offset = featureId === UNKNOWN_STATE_RECONCILIATION_FEATURE_ID ? 1 : 0;
        assert.equal(feature.evidence.at(-1 - offset), PR197_EVIDENCE_BY_FEATURE[featureId]);
        assert.equal(feature.evidence.at(-2 - offset), PR195_STATIC_ASSET_COMPAT_EVIDENCE);
        assert.equal(feature.evidence.at(-3 - offset), PR193_IMAGE_UNKNOWN_CLOSURE_EVIDENCE);
        assert.equal(feature.evidence.at(-4 - offset), PROVIDER_TASK_LIVE_COMPAT_EVIDENCE);
      } else if (PR195_TOUCHED_FEATURE_IDS.has(featureId)) {
        assert.equal(feature.evidence.at(-1), PR195_STATIC_ASSET_COMPAT_EVIDENCE);
        assert.equal(feature.evidence.at(-2), PR193_IMAGE_UNKNOWN_CLOSURE_EVIDENCE);
        assert.equal(feature.evidence.at(-3), PROVIDER_TASK_LIVE_COMPAT_EVIDENCE);
      } else {
        assert.equal(feature.evidence.at(-1), PR193_IMAGE_UNKNOWN_CLOSURE_EVIDENCE);
        assert.equal(feature.evidence.at(-2), PROVIDER_TASK_LIVE_COMPAT_EVIDENCE);
      }
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
    assert.deepEqual(feature.unlock, featureId === PROACTIVE_CANARY_FEATURE_ID ? REDRAW_WINDOWED_ANALYSIS_UNLOCK
      : REDRAW_CROSS_SHOT_SOURCE_TOUCHED_FEATURE_IDS.has(featureId)
      ? REDRAW_CROSS_SHOT_SOURCE_UNLOCK : MERGED_CURRENT_UNLOCK_BY_FEATURE[featureId]);
    const expectedHistoryTail = [...MERGED_UNLOCK_HISTORY_TAIL_BY_FEATURE[featureId],
      ...(featureId === PROACTIVE_CANARY_FEATURE_ID ? [REDRAW_EPISODE_BLUEPRINT_FIRST_UNLOCK, REDRAW_CROSS_SHOT_SOURCE_UNLOCK] : [])];
    assert.deepEqual(
      feature.unlockHistory.slice(-expectedHistoryTail.length),
      expectedHistoryTail,
    );
  }
});

test('ToAPIs .cn 域名迁移刷新管理员预设锁并保留 PR #217、Wan3 与 NewAPI 历史', () => {
  const manifest = readPreExecutionPreviewManifest();
  const feature = manifest.features.find(
    ({ featureId }) => featureId === ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID,
  );
  assert.ok(feature, `缺少功能锁 ${ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID}`);
  assert.deepEqual(feature.unlock, TOAPIS_CN_DOMAIN_MIGRATION_UNLOCK);
  assert.deepEqual(
    feature.unlockHistory.slice(-MERGED_UNLOCK_HISTORY_TAIL_BY_FEATURE[ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID].length),
    MERGED_UNLOCK_HISTORY_TAIL_BY_FEATURE[ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID],
  );
  assert.equal(feature.evidence.at(-1), TOAPIS_CN_DOMAIN_MIGRATION_EVIDENCE);
});

test('未触及锁保留当前批准记录且所有锁保留历史证据', () => {
  const manifest = readPreExecutionPreviewManifest();
  assert.equal(manifest.features.length >= 5, true);
  for (const feature of manifest.features) {
    if (feature.featureId === ADMIN_PROVIDER_OBSERVABILITY_FEATURE_ID) {
      assert.deepEqual(feature.unlock, TOAPIS_CN_DOMAIN_MIGRATION_UNLOCK);
    } else if (feature.featureId === PROACTIVE_CANARY_FEATURE_ID) {
      assert.deepEqual(feature.unlock, REDRAW_WINDOWED_ANALYSIS_UNLOCK);
    } else if (REDRAW_EPISODE_BLUEPRINT_FIRST_TOUCHED_FEATURE_IDS.has(feature.featureId)) {
      assert.deepEqual(feature.unlock, REDRAW_CROSS_SHOT_SOURCE_TOUCHED_FEATURE_IDS.has(feature.featureId)
        ? REDRAW_CROSS_SHOT_SOURCE_UNLOCK : REDRAW_EPISODE_BLUEPRINT_FIRST_UNLOCK);
    } else if (feature.featureId === REDRAW_COVERAGE_REGISTRATION_FEATURE_ID) {
      assert.deepEqual(feature.unlock, REDRAW_COVERAGE_REGISTRATION_TASK_B_UNLOCK);
    } else if (feature.featureId === REDRAW_COVERAGE_HTTP_ROUTE_FEATURE_ID) {
      assert.deepEqual(feature.unlock, MERGED_CURRENT_UNLOCK_BY_FEATURE[feature.featureId]);
    } else if (feature.featureId === REDRAW_CLEAN_PLATE_MEDIA_FEATURE_ID) {
      assert.deepEqual(feature.unlock, REDRAW_CROSS_SHOT_SOURCE_UNLOCK);
    } else if (feature.featureId === REDRAW_PRODUCT_MEDIA_HTTP_CHAIN_FEATURE_ID) {
      assert.deepEqual(feature.unlock, MERGED_CURRENT_UNLOCK_BY_FEATURE[feature.featureId]);
    } else if (feature.featureId === REDRAW_EPISODE_BLUEPRINT_FIRST_FEATURE_ID) {
      assert.deepEqual(feature.unlock, REDRAW_WINDOWED_ANALYSIS_UNLOCK);
    } else if (!Object.hasOwn(PROVIDER_TASK_LOCK_REQUIREMENTS, feature.featureId)) {
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
  assert.equal(unknownState.evidence.at(-1), GENERATION_CREDIT_TIMEOUT_EVIDENCE);
  assert.deepEqual(unknownState.unlock, REDRAW_COMPLETE_LOCAL_MAIN_MERGE_UNLOCK);
  assert.deepEqual(unknownState.unlockHistory.at(-1), NEWAPI_READONLY_PREFLIGHT_UNLOCK);
  assert.deepEqual(unknownState.unlockHistory.at(-2), NEWAPI_CONFIG_SCOPED_CAPABILITY_UNLOCK);
  assert.deepEqual(unknownState.unlockHistory.at(-3), NEWAPI_SIX_MODEL_PRODUCTION_COPY_UNLOCK);
  assert.deepEqual(unknownState.unlockHistory.at(-4), NEWAPI_SIX_MODEL_REMEDIATION_UNLOCK);
  assert.deepEqual(unknownState.unlockHistory.at(-5), CANVAS_BILLING_LOGIN_UNLOCK);
  assert.deepEqual(unknownState.unlockHistory.at(-6), PR217_FUMIN_PRODUCT_API_ACCEPTANCE_UNLOCK);
  assert.deepEqual(unknownState.unlockHistory.at(-7), FAILED_GENERATION_RESUBMIT_UNLOCK);
  assert.deepEqual(unknownState.unlockHistory.at(-8), WAN3_PROVIDER_ASSET_SIGNING_UNLOCK);
  assert.deepEqual(unknownState.unlockHistory.at(-9), GENERATION_CREDIT_TIMEOUT_UNLOCK);
});

test('PR #217 Fumin 保留失败视频重试与 Wan3 历史并仅刷新实际触及的运行时功能锁', () => {
  const manifest = readPreExecutionPreviewManifest();
  for (const featureId of [
    PROVIDER_ROUTE_CONTRACT_FEATURE_ID,
    SAFE_PROVIDER_FAILOVER_FEATURE_ID,
    UNKNOWN_STATE_RECONCILIATION_FEATURE_ID,
    PROACTIVE_CANARY_FEATURE_ID,
  ]) {
    const feature = manifest.features.find((entry) => entry.featureId === featureId);
    assert.ok(feature, `缺少功能锁 ${featureId}`);
    const signingChanged = WAN3_PROVIDER_ASSET_SIGNING_FEATURE_IDS.has(featureId);
    const failedGenerationResubmitChanged = FAILED_GENERATION_RESUBMIT_FEATURE_IDS.has(featureId);
    const timeoutChanged = featureId === UNKNOWN_STATE_RECONCILIATION_FEATURE_ID;
    const blueprintFirstTouched = REDRAW_EPISODE_BLUEPRINT_FIRST_TOUCHED_FEATURE_IDS.has(featureId);
    const priorTaskUnlock = PRE_NEWAPI_SIX_MODEL_UNLOCK_BY_FEATURE[featureId];
    const priorTaskHistoryTail = PRE_MERGED_NEWAPI_HISTORY_TAIL_BY_FEATURE[featureId];
    assert.deepEqual(priorTaskUnlock, PRE_NEWAPI_SIX_MODEL_UNLOCK_BY_FEATURE[featureId]);
    const scopedCapabilityChanged = NEWAPI_CONFIG_SCOPED_CAPABILITY_FEATURE_IDS.has(featureId);
    const readonlyPreflightChanged = NEWAPI_READONLY_PREFLIGHT_FEATURE_IDS.has(featureId);
    const localMainMergeChanged = REDRAW_COMPLETE_LOCAL_MAIN_MERGE_FEATURE_IDS.has(featureId);
    assert.deepEqual(
      feature.unlock,
      featureId === PROACTIVE_CANARY_FEATURE_ID ? REDRAW_WINDOWED_ANALYSIS_UNLOCK
      : REDRAW_CROSS_SHOT_SOURCE_TOUCHED_FEATURE_IDS.has(featureId)
        ? REDRAW_CROSS_SHOT_SOURCE_UNLOCK
        : localMainMergeChanged
        ? REDRAW_COMPLETE_LOCAL_MAIN_MERGE_UNLOCK
        : blueprintFirstTouched
        ? REDRAW_EPISODE_BLUEPRINT_FIRST_UNLOCK
        : readonlyPreflightChanged
        ? NEWAPI_READONLY_PREFLIGHT_UNLOCK
        : scopedCapabilityChanged
        ? NEWAPI_CONFIG_SCOPED_CAPABILITY_UNLOCK
        : NEWAPI_SIX_MODEL_PRODUCTION_COPY_UNLOCK,
    );
    const newApiHistory = readonlyPreflightChanged
      ? [NEWAPI_CONFIG_SCOPED_CAPABILITY_UNLOCK, NEWAPI_SIX_MODEL_PRODUCTION_COPY_UNLOCK, NEWAPI_SIX_MODEL_REMEDIATION_UNLOCK]
      : scopedCapabilityChanged
        ? [NEWAPI_SIX_MODEL_PRODUCTION_COPY_UNLOCK, NEWAPI_SIX_MODEL_REMEDIATION_UNLOCK]
        : [NEWAPI_SIX_MODEL_REMEDIATION_UNLOCK];
    const preLocalMainMergeCurrent = readonlyPreflightChanged
      ? NEWAPI_READONLY_PREFLIGHT_UNLOCK
      : scopedCapabilityChanged
        ? NEWAPI_CONFIG_SCOPED_CAPABILITY_UNLOCK
        : NEWAPI_SIX_MODEL_PRODUCTION_COPY_UNLOCK;
    const latestHistory = localMainMergeChanged
      ? [preLocalMainMergeCurrent, ...newApiHistory]
      : blueprintFirstTouched
      ? [
        readonlyPreflightChanged
          ? NEWAPI_READONLY_PREFLIGHT_UNLOCK
          : scopedCapabilityChanged
            ? NEWAPI_CONFIG_SCOPED_CAPABILITY_UNLOCK
            : NEWAPI_SIX_MODEL_PRODUCTION_COPY_UNLOCK,
        ...newApiHistory,
      ]
      : newApiHistory;
    if (REDRAW_CROSS_SHOT_SOURCE_TOUCHED_FEATURE_IDS.has(featureId)) latestHistory.unshift(REDRAW_EPISODE_BLUEPRINT_FIRST_UNLOCK);
    if (featureId === PROACTIVE_CANARY_FEATURE_ID) latestHistory.unshift(REDRAW_CROSS_SHOT_SOURCE_UNLOCK);
    for (const [index, unlock] of latestHistory.entries()) {
      assert.deepEqual(feature.unlockHistory.at(-(index + 1)), unlock);
    }
    assert.deepEqual(feature.unlockHistory.at(-(latestHistory.length + 1)), priorTaskUnlock);
    assert.deepEqual(feature.unlockHistory.at(-(latestHistory.length + 2)), priorTaskHistoryTail);
    assert.ok(
      [...feature.unlockHistory, feature.unlock].some((entry) => (
        entry.reason === TOAPIS_SUBMISSION_RECOVERY_UNLOCK.reason
          && entry.approvedBy === TOAPIS_SUBMISSION_RECOVERY_UNLOCK.approvedBy
      )),
      `${featureId} 缺少 ToAPIs 未知提交恢复批准`,
    );
    assert.ok(feature.unlockHistory.some((entry) => (
      entry.reason === PROVIDER_TASK_STATUS_DECISION_UNLOCK.reason
        || entry.reason === PROVIDER_TASK_RECEIPT_UNLOCK.reason
    )), `${featureId} 缺少上一阶段批准历史`);
    assert.ok(feature.requiredTests.includes('backend-node/test/providerTaskLiveCompatibility.test.js'));
    const expectedEvidence = timeoutChanged
      ? GENERATION_CREDIT_TIMEOUT_EVIDENCE
      : PR194_MAIN_SYNC_FEATURE_IDS.has(featureId)
        ? REDRAW_PRODUCT_MEDIA_REGISTRATION_TASK_A_FEATURE_IDS.has(featureId)
        ? REDRAW_PRODUCT_MEDIA_REGISTRATION_PLAN
        : PR194_MAIN_SYNC_EVIDENCE
      : PR197_TOUCHED_FEATURE_IDS.has(featureId)
        ? PR197_EVIDENCE_BY_FEATURE[featureId]
        : PR195_TOUCHED_FEATURE_IDS.has(featureId)
          ? PR195_STATIC_ASSET_COMPAT_EVIDENCE
          : PR193_IMAGE_UNKNOWN_CLOSURE_EVIDENCE;
    assert.equal(feature.evidence.at(-1), expectedEvidence);
    if (PR194_MAIN_SYNC_FEATURE_IDS.has(featureId)) {
      if (REDRAW_PRODUCT_MEDIA_REGISTRATION_TASK_A_FEATURE_IDS.has(featureId)) {
        assert.equal(feature.evidence.at(-2), REDRAW_PRODUCT_MEDIA_REGISTRATION_SPEC);
        assert.equal(feature.evidence.at(-3), PR194_MAIN_SYNC_EVIDENCE);
        if (featureId === PROACTIVE_CANARY_FEATURE_ID) {
          assert.equal(feature.evidence.at(-4), PR197_PROVIDER_CANARY_REMEDIATION_EVIDENCE);
          assert.equal(feature.evidence.at(-5), PR195_STATIC_ASSET_COMPAT_EVIDENCE);
          assert.equal(feature.evidence.at(-6), PR193_IMAGE_UNKNOWN_CLOSURE_EVIDENCE);
        } else {
          assert.equal(feature.evidence.at(-4), PR193_IMAGE_UNKNOWN_CLOSURE_EVIDENCE);
        }
      } else {
        assert.equal(feature.evidence.at(-2), PR193_IMAGE_UNKNOWN_CLOSURE_EVIDENCE);
      }
    } else if (PR197_TOUCHED_FEATURE_IDS.has(featureId)) {
      const offset = timeoutChanged ? 1 : 0;
      assert.equal(feature.evidence.at(-2 - offset), PR195_STATIC_ASSET_COMPAT_EVIDENCE);
      assert.equal(feature.evidence.at(-3 - offset), PR193_IMAGE_UNKNOWN_CLOSURE_EVIDENCE);
    } else if (PR195_TOUCHED_FEATURE_IDS.has(featureId)) {
      assert.equal(feature.evidence.at(-2), PR193_IMAGE_UNKNOWN_CLOSURE_EVIDENCE);
    }
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
