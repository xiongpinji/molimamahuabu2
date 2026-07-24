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

test('依赖安全门禁覆盖三个 Node 子项目并在高危漏洞时失败', () => {
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
    assert.match(
      commands,
      new RegExp(`npm --prefix ${project} audit --omit=dev --audit-level=high`),
    );
  }
  assert.match(commands, /--registry=https:\/\/registry\.npmjs\.org/);
  assert.equal(
    commands.match(/--replace-registry-host=always/g)?.length,
    3,
    '三个干净安装步骤都必须覆盖锁文件中的历史镜像主机',
  );
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
