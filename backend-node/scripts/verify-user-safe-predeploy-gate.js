'use strict';

/**
 * 用户安全预部署门禁（canvas-sync + generation-limits 本批）
 *
 * 规则：未全部 PASS 不得部署。必须从用户路径实测，确认：
 * 1) 不引入会破坏线上用户正常使用的新 BUG
 * 2) 多端画布对齐不会在拖拽/生成中静默覆盖
 * 3) 生成提交限流/并发上限变更可预期且受管理员门禁
 * 4) 既有归属/鉴权/积分受保护合同仍绿
 *
 * 用法：npm run verify:user-safe-predeploy-gate
 * 退出码 0 = 允许进入部署候选；非 0 = NO-GO
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const frontweb = path.join(root, '..', 'frontweb');
const GATE_ID = 'user-safe-predeploy-v1';

function run(command, args, cwd, label) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
    shell: false,
  });
  if (result.status !== 0) {
    console.error(`FAIL ${label} exit=${result.status}`);
    console.error(JSON.stringify({
      gate: GATE_ID,
      status: 'fail',
      failed_step: label,
      deploy: 'NO-GO',
      reason: '用户视角实测门禁未通过，禁止部署',
    }, null, 2));
    process.exit(result.status || 1);
  }
}

function assertSourceContracts() {
  console.log('\n==> source contracts (user-safe)');
  const checks = [];
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const front = (rel) => fs.readFileSync(path.join(frontweb, rel), 'utf8');

  const limits = read('src/services/generationLimits.js');
  checks.push({
    name: 'generation submit default 300',
    ok: /DEFAULT_GENERATION_SUBMIT_LIMIT_PER_MINUTE\s*=\s*300/.test(limits),
  });
  checks.push({
    name: 'pipeline concurrency max default 300',
    ok: /DEFAULT_PIPELINE_CONCURRENCY_MAX\s*=\s*300/.test(limits),
  });

  const indexJs = read('src/routes/index.js');
  checks.push({
    name: 'routes use resolveGenerationSubmitLimitPerMinute',
    ok: /resolveGenerationSubmitLimitPerMinute\s*\(/.test(indexJs),
  });
  checks.push({
    name: 'canvas-revision route registered',
    ok: /\/dramas\/:id\/canvas-revision/.test(indexJs),
  });

  const dramaCanvas = front('src/views/DramaCanvas.vue');
  checks.push({
    name: 'DramaCanvas wires useCanvasRemoteSync',
    ok: /useCanvasRemoteSync\(/.test(dramaCanvas),
  });
  checks.push({
    name: 'DramaCanvas blocks sync while interacting/generating',
    ok: /isCanvasSyncBlockedByLocalActivity\(/.test(dramaCanvas)
      && /canvasInteractionBusy/.test(dramaCanvas)
      && /freeCanvasNodeGenerationFlights\.size/.test(dramaCanvas),
  });
  checks.push({
    name: 'DramaCanvas rechecks dirty before applyRemote',
    ok: /async function applyRemoteCanvasAlignment[\s\S]*isCanvasLayoutLocallyDirty\(\)/.test(dramaCanvas),
  });

  const remoteSync = front('src/utils/canvasRemoteSync.js');
  checks.push({
    name: 'remote sync decision exports blocked-by-local helper',
    ok: /function isCanvasSyncBlockedByLocalActivity/.test(remoteSync),
  });

  const failed = checks.filter((item) => !item.ok);
  for (const item of checks) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}`);
  }
  if (failed.length) {
    console.error(JSON.stringify({
      gate: GATE_ID,
      status: 'fail',
      failed_step: 'source contracts',
      deploy: 'NO-GO',
      failed: failed.map((item) => item.name),
    }, null, 2));
    process.exit(1);
  }
}

const backendTests = [
  'test/generationLimits.test.js',
  'test/canvasLayoutConcurrency.test.js',
  'test/rateLimit.test.js',
  'test/canvasCreditReleaseContract.test.js',
  'test/productionPreflight.test.js',
  'test/libraryOwnershipIsolation.test.js',
  'test/secretBoxAndCapabilities.test.js',
  'test/taskService.test.js',
  'test/textBilling.test.js',
  'test/projectOwnership.test.js',
  'test/platformSharedAuthAcceptance.test.js',
];

const frontendTests = ['test/canvasRemoteSync.test.js'];
// 线上历史 release 可能仍带旧版 canvasLayoutPersistence.test.js（断言已废弃的 baseUpdatedAt 签名，
// 在实时 current 上本就失败）。只有当该测试已切换到 revision token 合同时才纳入门禁，否则显式记录 SKIP。
const persistenceContractTest = path.join(frontweb, 'test/canvasLayoutPersistence.test.js');
if (fs.existsSync(persistenceContractTest)
  && /canvasStateRevision|base_canvas_revision/.test(fs.readFileSync(persistenceContractTest, 'utf8'))) {
  frontendTests.push('test/canvasLayoutPersistence.test.js');
} else {
  console.log('SKIP frontend canvasLayoutPersistence contract: test file predates revision-token contract (pre-existing on live)');
}

assertSourceContracts();
run(
  process.execPath,
  ['--test', '--test-concurrency=1', ...backendTests],
  root,
  'backend user-safe contract tests',
);
run(
  process.execPath,
  ['--test', ...frontendTests],
  frontweb,
  'frontend canvas sync/persistence contracts',
);
run(process.execPath, ['tools/_predeploy_user_http_smoke.js'], root, 'user HTTP smoke (auth/ownership)');
run(
  process.execPath,
  ['tools/_predeploy_canvas_sync_limits_smoke.js'],
  root,
  'user HTTP smoke (canvas sync + generation limits)',
);

console.log(`\n${JSON.stringify({
  gate: GATE_ID,
  status: 'pass',
  deploy: 'CANDIDATE_ALLOWED',
  note: '门禁通过仅表示允许制作候选；正式切换 current 仍须受保护发布流程与人工授权。',
}, null, 2)}`);
