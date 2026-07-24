const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const root = path.resolve(__dirname, '..', '..');

function readWorkflow(name) {
  const workflowPath = path.join(root, '.github', 'workflows', name);
  assert.ok(fs.existsSync(workflowPath), `缺少工作流：${name}`);
  return yaml.load(fs.readFileSync(workflowPath, 'utf8'), { schema: yaml.JSON_SCHEMA });
}

test('依赖安全门禁覆盖三个 Node 子项目并审计桌面完整构建链', () => {
  const workflow = readWorkflow('dependency-security.yml');
  assert.ok(Object.hasOwn(workflow.on, 'pull_request'));
  assert.deepEqual(workflow.on.push.branches, ['main']);

  const jobs = Object.values(workflow.jobs);
  assert.equal(jobs.length, 1);
  const steps = jobs[0].steps;
  const setupNode = steps.find((step) => step.uses === 'actions/setup-node@v4');
  assert.equal(setupNode.with['node-version'], '24');

  const commands = steps.map((step) => step.run || '').join('\n');
  for (const project of ['backend-node', 'frontweb', 'desktop']) {
    assert.match(commands, new RegExp(`npm --prefix ${project} ci --ignore-scripts`));
  }
  for (const project of ['backend-node', 'frontweb']) {
    assert.match(
      commands,
      new RegExp(`npm --prefix ${project} audit --omit=dev --audit-level=high`),
    );
  }
  assert.match(commands, /npm --prefix desktop audit --audit-level=low/);
  assert.doesNotMatch(commands, /npm --prefix desktop audit --omit=dev/);
  assert.match(commands, /--registry=https:\/\/registry\.npmjs\.org/);
  for (const project of ['backend-node', 'desktop']) {
    const step = steps.find((item) => item.run?.startsWith(`npm --prefix ${project} ci `));
    assert.match(step.run, /--replace-registry-host=always/);
  }
  const frontendInstall = steps.find((step) => step.run?.startsWith('npm --prefix frontweb ci '));
  assert.doesNotMatch(
    frontendInstall.run,
    /--replace-registry-host=always/,
    '前端锁文件的 three 定制 tarball 不存在于 npm 官方仓库，必须保留完整锁定地址',
  );
});

test('桌面运行时和构建器使用已修复漏洞的最低版本', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'),
  );
  assert.match(packageJson.devDependencies.electron, /^\^43\./);
  assert.match(packageJson.devDependencies['electron-builder'], /^\^26\./);
  assert.match(packageJson.dependencies['better-sqlite3'], /^\^13\./);
});

test('桌面安装器与便携版使用不同产物名称', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'),
  );
  assert.ok(packageJson.build.nsis.artifactName);
  assert.ok(packageJson.build.portable?.artifactName);
  assert.notEqual(packageJson.build.nsis.artifactName, packageJson.build.portable.artifactName);
  assert.match(packageJson.build.nsis.artifactName, /Setup/);
  assert.match(packageJson.build.portable.artifactName, /Portable/);
});

test('现有 Node 工作流统一使用 Node.js 24 且发布流程不绕过 TLS', () => {
  for (const name of ['backend-node-tests.yml', 'frontend-e2e.yml', 'release.yml']) {
    const workflowText = fs.readFileSync(path.join(root, '.github', 'workflows', name), 'utf8');
    assert.doesNotMatch(workflowText, /node-version:\s*['"]22['"]/);
    assert.match(workflowText, /node-version:\s*['"]24['"]/);
    assert.doesNotMatch(workflowText, /NODE_TLS_REJECT_UNAUTHORIZED/);
  }
});

test('后端与桌面 npm 安装保持 TLS 证书校验', () => {
  for (const project of ['backend-node', 'desktop']) {
    const npmrc = fs.readFileSync(path.join(root, project, '.npmrc'), 'utf8');
    assert.match(npmrc, /^strict-ssl=true$/m);
    assert.doesNotMatch(npmrc, /^strict-ssl=false$/m);
  }
});
