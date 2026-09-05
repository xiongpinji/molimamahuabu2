const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const root = path.resolve(__dirname, '..', '..');
const auditRunnerPath = path.join(root, 'backend-node', 'scripts', 'run-npm-production-audit.js');

function readWorkflow(name) {
  const workflowPath = path.join(root, '.github', 'workflows', name);
  assert.ok(fs.existsSync(workflowPath), `缺少工作流：${name}`);
  return yaml.load(fs.readFileSync(workflowPath, 'utf8'), { schema: yaml.JSON_SCHEMA });
}

test('生产依赖安全门禁覆盖网页端两个 Node 子项目', () => {
  const workflow = readWorkflow('dependency-security.yml');
  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.ok(Object.hasOwn(workflow.on, 'pull_request'));
  assert.deepEqual(workflow.on.push.branches, ['main']);

  const jobs = Object.values(workflow.jobs);
  assert.equal(jobs.length, 1);
  const steps = jobs[0].steps;
  const setupNode = steps.find((step) => step.uses === 'actions/setup-node@v4');
  assert.equal(setupNode.with['node-version'], '24');

  const commands = steps.map((step) => step.run || '').join('\n');
  for (const project of ['backend-node', 'frontweb']) {
    assert.match(commands, new RegExp(`npm --prefix ${project} ci --ignore-scripts`));
    assert.match(
      commands,
      new RegExp(`node backend-node/scripts/run-npm-production-audit\\.js ${project}`),
    );
    assert.doesNotMatch(commands, new RegExp(`npm --prefix ${project} audit`));
  }
  assert.doesNotMatch(commands, /\|\|\s*true/);
  assert.match(gitignore, /^!backend-node\/scripts\/run-npm-production-audit\.js$/m);
  assert.doesNotMatch(commands, /npm --prefix desktop/);
  assert.match(commands, /--registry=https:\/\/registry\.npmjs\.org/);
  const backendInstall = steps.find((step) => step.run?.startsWith('npm --prefix backend-node ci '));
  assert.match(backendInstall.run, /--replace-registry-host=always/);
  const frontendInstall = steps.find((step) => step.run?.startsWith('npm --prefix frontweb ci '));
  assert.doesNotMatch(
    frontendInstall.run,
    /--replace-registry-host=always/,
    '前端锁文件的 three 定制 tarball 不存在于 npm 官方仓库，必须保留完整锁定地址',
  );
});

test('生产依赖审计仅在明确网络故障后重试一次', () => {
  assert.ok(fs.existsSync(auditRunnerPath), '缺少生产依赖审计网络重试启动器');
  const { runProductionAudit } = require(auditRunnerPath);
  const calls = [];
  const results = [
    {
      status: 1,
      stdout: '',
      stderr: 'npm warn audit network timeout at: https://registry.npmjs.org/-/npm/v1/security/advisories/bulk\n',
    },
    { status: 0, stdout: 'found 0 vulnerabilities\n', stderr: '' },
  ];
  let output = '';

  const status = runProductionAudit('frontweb', {
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return results.shift();
    },
    write(chunk) {
      output += chunk;
    },
  });

  assert.equal(status, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.shell, false);
  if (process.platform === 'win32') {
    assert.equal(calls[0].command, process.env.ComSpec || 'cmd.exe');
    assert.deepEqual(calls[0].args.slice(0, 4), ['/d', '/s', '/c', 'npm']);
  } else {
    assert.equal(calls[0].command, 'npm');
  }
  assert.deepEqual(calls[0].args.slice(-6), [
    '--prefix',
    'frontweb',
    'audit',
    '--omit=dev',
    '--audit-level=high',
    '--registry=https://registry.npmjs.org',
  ]);
  assert.match(output, /network failure detected; retrying once/i);
});

test('生产依赖审计发现漏洞时立即保留失败且不重试', () => {
  assert.ok(fs.existsSync(auditRunnerPath), '缺少生产依赖审计网络重试启动器');
  const { runProductionAudit } = require(auditRunnerPath);
  let calls = 0;

  const status = runProductionAudit('backend-node', {
    spawn() {
      calls += 1;
      return {
        status: 1,
        stdout: '# npm audit report\n1 high severity vulnerability\n',
        stderr: '',
      };
    },
    write() {},
  });

  assert.equal(status, 1);
  assert.equal(calls, 1);
});

test('生产依赖审计同时出现漏洞和网络字样时仍立即失败', () => {
  assert.ok(fs.existsSync(auditRunnerPath), '缺少生产依赖审计网络重试启动器');
  const { runProductionAudit } = require(auditRunnerPath);
  let calls = 0;

  const status = runProductionAudit('backend-node', {
    spawn() {
      calls += 1;
      return {
        status: 1,
        stdout: '# npm audit report\n1 high severity vulnerability\n',
        stderr: 'npm error audit endpoint returned an error\n',
      };
    },
    write() {},
  });

  assert.equal(status, 1);
  assert.equal(calls, 1);
});

test('生产依赖审计第二次网络失败后停止并返回失败', () => {
  assert.ok(fs.existsSync(auditRunnerPath), '缺少生产依赖审计网络重试启动器');
  const { runProductionAudit } = require(auditRunnerPath);
  let calls = 0;

  const status = runProductionAudit('backend-node', {
    spawn() {
      calls += 1;
      return {
        status: 1,
        stdout: '',
        stderr: 'npm error code ETIMEDOUT\nnpm error audit endpoint returned an error\n',
      };
    },
    write() {},
  });

  assert.equal(status, 1);
  assert.equal(calls, 2);
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
    assert.match(workflowText, /node-version:\s*['"]24(?:\.\d+\.\d+)?['"]/);
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
