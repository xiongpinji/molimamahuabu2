'use strict';

/**
 * 隐患治理本批部署门禁：只跑与 A–E 直接相关的合同/冒烟。
 * 全量 npm test 中的外部模型门禁 fixture / Playwright 合同失败不在本门禁内。
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const tests = [
  'test/libraryOwnershipIsolation.test.js',
  'test/secretBoxAndCapabilities.test.js',
  'test/taskService.test.js',
  'test/textBilling.test.js',
  'test/productionPreflight.test.js',
  'test/canvasCreditReleaseContract.test.js',
  'test/projectOwnership.test.js',
  'test/imageUploadOwnership.test.js',
  'test/platformSharedAssetAcceptance.test.js',
  'test/platformSharedAuthAcceptance.test.js',
  'test/redrawLocalizationOrchestration.test.js',
];

function run(command, args, label) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    console.error(`FAIL ${label} exit=${result.status}`);
    process.exit(result.status || 1);
  }
}

run(process.execPath, ['--test', '--test-concurrency=1', ...tests], 'remediation contract tests');
run(process.execPath, ['tools/_predeploy_user_http_smoke.js'], 'user HTTP smoke');

console.log('\n{"gate":"risk-remediation-predeploy-v1","status":"pass"}');
