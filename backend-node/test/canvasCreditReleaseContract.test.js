const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repositoryRoot = path.resolve(__dirname, '..', '..');

function loadAuditor() {
  return require('../src/services/canvasCreditReleaseContract');
}

function createReleaseFixture({ source, script, style }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-credit-contract-'));
  for (const relativePath of [
    'frontweb/src/api/ai.js',
    'frontweb/src/views/FilmList.vue',
    'frontweb/src/views/FreeCreate.vue',
    'frontweb/src/views/DramaCanvas.vue',
    'frontweb/src/views/HomeCanvas.vue',
    'frontweb/src/views/FilmCreate.vue',
    'frontweb/src/components/dramaCanvas/CanvasGenerationOptions.vue',
    'frontweb/src/components/dramaCanvas/CanvasStoryboardPanel.vue',
    'frontweb/src/utils/canvasModelCapabilities.js',
    'frontweb/src/utils/freeCanvasGeneration.js',
    'frontweb/src/utils/videoGenerationRequest.js',
  ]) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, relativePath), target);
  }
  const componentPath = path.join(root, 'frontweb', 'src', 'components', 'dramaCanvas');
  const assetPath = path.join(root, 'frontweb', 'dist', 'assets');
  fs.mkdirSync(componentPath, { recursive: true });
  fs.mkdirSync(assetPath, { recursive: true });
  fs.writeFileSync(path.join(componentPath, 'HomeCanvasNode.vue'), source, 'utf8');
  fs.writeFileSync(path.join(assetPath, 'canvas.js'), script, 'utf8');
  fs.writeFileSync(path.join(assetPath, 'canvas.css'), style, 'utf8');
  return root;
}

const protectedSource = `
  <span v-if="canGenerate" class="billing-cost canvas-credit-callout-v1" aria-live="polite">
    <template v-if="estimatedCredits">本次预计扣除 <strong>{{ estimatedCredits }}</strong> 积分</template>
    <template v-else>积分待管理员配置</template>
  </span>
  <style>
  .billing-cost { border: 1px solid #ffb15c; background: #7c4014; font-weight: 800; }
  .billing-cost strong { font-weight: 900; }
  </style>
  <!-- supportsImageReference supportsVideoReference supportsAudioReference supportsFirstFrame referenceMediaAccept -->
`;

const protectedScript = [
  'const label="本次预计扣除";const empty="积分待管理员配置";const className="billing-cost canvas-credit-callout-v1";',
  'const catalog="/canvas/model-catalog";const capability="capability";const mode="reference_mode";',
  'const gates="supportsImageReference supportsVideoReference supportsAudioReference supportsFirstFrame";',
  'const models="gpt-image-2-2-4k nano-banana-2 minimax h3 seedance-2.0-fast seedance-2.0-mini seedance-2-fast seedance-2-mini xuan-video-v1-6e7b4763634e6206 xuan-seedance-2.5 sdas-my-seedance-2.0-fast-upscaled-1080p lingjing-video-v1";',
].join('');
const protectedStyle = '.billing-cost{background:#7c4014;border:1px solid #ffb15c;font-weight:800}.billing-cost strong{font-weight:900}';

test('当前仓库源码满足画布积分卡片受保护合同', () => {
  const { auditCanvasCreditReleaseContract } = loadAuditor();
  const report = auditCanvasCreditReleaseContract({ releaseRoot: repositoryRoot });
  assert.equal(report.sourceValidated, true);
  assert.equal(report.buildValidated, false);
});

test('审计器拒绝退回旧 billing-note 灰字的源码', (t) => {
  const { auditCanvasCreditReleaseContract } = loadAuditor();
  const root = createReleaseFixture({
    source: '<span class="billing-note">{{ estimatedCredits }} 积分</span>',
    script: protectedScript,
    style: protectedStyle,
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => auditCanvasCreditReleaseContract({ releaseRoot: root }),
    /缺少醒目积分卡片|billing-cost/,
  );
});

test('审计器拒绝积分卡缺少受保护合同 class', (t) => {
  const { auditCanvasCreditReleaseContract } = loadAuditor();
  const root = createReleaseFixture({
    source: protectedSource.replace(' canvas-credit-callout-v1', ''),
    script: protectedScript,
    style: protectedStyle,
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => auditCanvasCreditReleaseContract({ releaseRoot: root }),
    /canvas-credit-callout-v1/,
  );
});

test('生产构建缺少受保护合同 class 时拒绝发布', (t) => {
  const { auditCanvasCreditReleaseContract } = loadAuditor();
  const root = createReleaseFixture({
    source: protectedSource,
    script: protectedScript.replace(' canvas-credit-callout-v1', ''),
    style: protectedStyle,
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => auditCanvasCreditReleaseContract({ releaseRoot: root, requireBuild: true }),
    /canvas-credit-callout-v1/,
  );
});

test('生产构建缺少醒目样式时即使源码正确也被拒绝', (t) => {
  const { auditCanvasCreditReleaseContract } = loadAuditor();
  const root = createReleaseFixture({
    source: protectedSource,
    script: protectedScript,
    style: '.billing-cost{color:#71717a}.unrelated{background:#fff;border:1px solid;font-weight:800}.unrelated strong{font-weight:900}',
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => auditCanvasCreditReleaseContract({ releaseRoot: root, requireBuild: true }),
    /生产构建缺少醒目积分样式/,
  );
});

test('源码和生产构建同时保留合同才通过发布审计', (t) => {
  const { auditCanvasCreditReleaseContract } = loadAuditor();
  const root = createReleaseFixture({
    source: protectedSource,
    script: protectedScript,
    style: protectedStyle,
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const report = auditCanvasCreditReleaseContract({ releaseRoot: root, requireBuild: true });
  assert.deepEqual(report, {
    contract: 'canvas-credit-callout-v1',
    sourceValidated: true,
    modelCatalogSourceValidated: true,
    buildValidated: true,
    modelCatalogBuildValidated: true,
  });
});

test('CLI 拒绝缺少目录值的 --root 参数', () => {
  const cli = path.join(repositoryRoot, 'backend-node', 'scripts', 'audit-canvas-credit-contract.js');
  const result = spawnSync(process.execPath, [cli, '--root'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--root 缺少目录参数/);
});

function toBashPath(value) {
  if (process.platform !== 'win32') return value;
  return value.replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`).replaceAll('\\', '/');
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

test('共享安装器安装同一审计器，并动态接受好候选、拒绝降级候选', (t) => {
  const good = createReleaseFixture({
    source: protectedSource,
    script: protectedScript,
    style: protectedStyle,
  });
  const bad = createReleaseFixture({
    source: protectedSource,
    script: protectedScript,
    style: '.billing-cost{color:#71717a}',
  });
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-credit-shared-'));
  const sourceService = path.join(repositoryRoot, 'backend-node', 'src', 'services', 'canvasCreditReleaseContract.js');
  const sourceActivator = path.join(repositoryRoot, 'deploy', 'activate-protected-release.sh');
  const installer = path.join(repositoryRoot, 'deploy', 'install-protected-release-guard.sh');

  for (const root of [good, bad]) {
    const serviceDirectory = path.join(root, 'backend-node', 'src', 'services');
    const deployDirectory = path.join(root, 'deploy');
    fs.mkdirSync(serviceDirectory, { recursive: true });
    fs.mkdirSync(deployDirectory, { recursive: true });
    fs.copyFileSync(sourceService, path.join(serviceDirectory, 'canvasCreditReleaseContract.js'));
    fs.copyFileSync(sourceActivator, path.join(deployDirectory, 'activate-protected-release.sh'));
  }
  t.after(() => {
    fs.rmSync(good, { recursive: true, force: true });
    fs.rmSync(bad, { recursive: true, force: true });
    fs.rmSync(shared, { recursive: true, force: true });
  });

  const [bashInstaller, bashGood, bashShared] = [installer, good, shared].map(toBashPath);
  const installResult = spawnSync(
    'bash',
    [
      '-lc',
      `export PROTECTED_RELEASE_GUARD_BOOTSTRAP=1; exec ${[bashInstaller, bashGood, bashShared].map(shellQuote).join(' ')}`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(installResult.status, 0, installResult.stderr);
  const sharedVerifier = path.join(shared, 'verify-protected-release.js');
  const accepted = spawnSync(process.execPath, [sharedVerifier, good, '--require-build'], { encoding: 'utf8' });
  const rejected = spawnSync(process.execPath, [sharedVerifier, bad, '--require-build'], { encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /"ready":true/);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /生产构建缺少醒目积分样式/);

  const trustedVerifier = fs.readFileSync(sharedVerifier, 'utf8');
  fs.writeFileSync(
    path.join(bad, 'backend-node', 'src', 'services', 'canvasCreditReleaseContract.js'),
    "console.log('{\"ready\":true,\"contract\":\"lax\"}');\n",
  );
  const replaceResult = spawnSync(
    'bash',
    ['-lc', `exec ${[bashInstaller, toBashPath(bad), bashShared].map(shellQuote).join(' ')}`],
    { encoding: 'utf8' },
  );
  assert.notEqual(replaceResult.status, 0, '候选 release 不得替换已安装的共享门禁');
  assert.equal(fs.readFileSync(sharedVerifier, 'utf8'), trustedVerifier);
});

test('生产预检、CI 和共享发布脚本都强制执行同一合同', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'backend-node', 'package.json'), 'utf8'));
  const workflow = fs.readFileSync(path.join(repositoryRoot, '.github', 'workflows', 'dependency-security.yml'), 'utf8');
  const deployScript = fs.readFileSync(path.join(repositoryRoot, 'deploy', 'activate-protected-release.sh'), 'utf8');
  const installScript = fs.readFileSync(path.join(repositoryRoot, 'deploy', 'install-protected-release-guard.sh'), 'utf8');
  const repositoryAgents = fs.readFileSync(path.join(repositoryRoot, 'AGENTS.md'), 'utf8');

  assert.match(packageJson.scripts['preflight:production'], /audit:canvas-credit-contract -- --require-build/);
  assert.equal(packageJson.scripts['audit:canvas-credit-contract'], 'node scripts/audit-canvas-credit-contract.js');
  assert.match(workflow, /npm --prefix backend-node run audit:canvas-credit-contract/);
  assert.match(deployScript, /flock/);
  assert.match(deployScript, /verify-protected-release\.js/);
  assert.match(deployScript, /EXPECTED_CURRENT/);
  assert.match(deployScript, /readlink -f "\$CURRENT_LINK"/);
  assert.match(deployScript, /node "\$SHARED_VERIFIER" "\$CANDIDATE" --require-build/);
  assert.ok(deployScript.indexOf('verify-protected-release.js') < deployScript.indexOf('ln -sfn'));
  assert.match(installScript, /canvasCreditReleaseContract\.js/);
  assert.match(installScript, /--require-build/);
  assert.match(installScript, /PROTECTED_RELEASE_GUARD_BOOTSTRAP/);
  assert.match(installScript, /candidate releases cannot replace the installed shared guard/);
  assert.match(repositoryAgents, /画布积分卡片受保护合同/);
  assert.match(repositoryAgents, /activate-protected-release\.sh/);
  assert.match(repositoryAgents, /禁止直接.*current/);
});
