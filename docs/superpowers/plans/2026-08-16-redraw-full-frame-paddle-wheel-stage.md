# 全帧审核 PaddlePaddle 下载与安装分阶段实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（\`- [ ]\`）语法来跟踪进度。

**目标：** 只把文字运行时的 \`paddlepaddle==2.6.2\` 拆成受控 wheel 下载和本地安装两阶段，以稳定可信阶段区分下载失败与安装失败。

**架构：** 获取器继续顺序构建双 venv。命中 text runtime 的精确 PaddlePaddle spec 时，先用 text venv pip 下载唯一 wheel 到随机 staging 内部目录，校验证据后用 \`--no-index --no-deps\` 本地安装；其他依赖路径保持不变。任一步失败仍清理整个随机 staging，不发布部分缓存。

**技术栈：** Node.js 20、\`node:test\`、\`fs/promises\`、pip 数组 argv、Windows venv、realpath/lstat/文件身份复核、稳定错误阶段、Git。

---

## 文件职责

- 修改：\`backend-node/scripts/fetch-redraw-full-frame-models-local.js:223-238,647-664,723-807\`：固定下载阶段、Paddle wheel helper、证据复核和 installRuntime 分支。
- 修改：\`backend-node/test/redrawFullFrameDetectorProcess.test.js:1131-1305\`：两阶段 argv、可信阶段和 wheel 证据红绿测试。
- 修改：\`backend-node/test/redrawFullFrameDetectorProcess.test.js:820-943\`：runFetchModels 原子失败和 staging 清理回归。
- 创建：\`docs/superpowers/reports/2026-08-16-redraw-full-frame-paddle-wheel-stage-local-verification.md\`：只记录本地 fake-runner 证据与未执行真实操作边界。

不得修改 Python worker、模型锁 schema、依赖版本、其他包安装策略、前端、供应商、数据库或部署文件。

## 固定内部合同

实现只新增以下内部常量和函数，不增加 CLI 参数或环境变量：

\`\`\`js
const PADDLE_WHEEL_RUNTIME = 'text';
const PADDLE_WHEEL_REQUIREMENT = 'paddlepaddle==2.6.2';
const PADDLE_WHEEL_RELATIVE_DIR = 'runtime/text/.wheel-stage/paddlepaddle';
const PADDLE_WHEEL_NAME = /^paddlepaddle-2\.6\.2-[^-\\/]+-[^-\\/]+-[^-\\/]+\.whl$/i;

function isPaddleWheelSpec(runtimeName, spec) {
  return runtimeName === PADDLE_WHEEL_RUNTIME
    && spec.requirement === PADDLE_WHEEL_REQUIREMENT
    && spec.noDeps === true;
}

async function installPinnedPaddleWheel(staging, python, deps = {}) {}
async function readPaddleWheelEvidence(staging, wheelDir) {}
async function revalidatePaddleWheelEvidence(evidence) {}
\`\`\`

\`installPinnedPaddleWheel()\` 成功返回 \`undefined\`；失败只抛稳定脱敏错误。三个函数只供当前模块和目标测试使用，不写入生产配置。

### 任务 1：建立 PaddlePaddle 两阶段 happy path 与可信阶段

**文件：**

- 修改：\`backend-node/test/redrawFullFrameDetectorProcess.test.js:1131-1305\`
- 修改：\`backend-node/scripts/fetch-redraw-full-frame-models-local.js:223-238,647-664\`

- [ ] **步骤 1：添加 happy path 红灯测试**

在目标测试中新增：

\`\`\`js
test('PaddlePaddle downloads one wheel before local no-index install', async (t) => {
  const staging = tempDir(t, 'redraw-paddle-wheel-stage-');
  fs.mkdirSync(path.join(staging, 'runtime', 'text', '.venv'), { recursive: true });
  const calls = [];
  const deps = {
    env: {
      REDRAW_AUDITOR_PYTHON: 'python-fixture',
      PATH: 'path-value',
      OPENAI_API_KEY: 'must-not-pass',
    },
    spawnProcess: async (command, args, options) => {
      calls.push({ command, args: args.slice(), cwd: options.cwd, env: options.env });
      if (args.includes('download')) {
        const relativeDir = args[args.indexOf('--dest') + 1];
        fs.writeFileSync(
          path.join(staging, relativeDir, 'paddlepaddle-2.6.2-cp312-cp312-win_amd64.whl'),
          'fixture-wheel',
        );
      }
      return '';
    },
  };

  await installRuntime(staging, [], 'text', deps);

  const download = calls.find((call) => call.args.includes('download'));
  const localInstall = calls.find((call) => (
    call.args.includes('install') && call.args.includes('--no-index')
  ));
  assert(download);
  assert(localInstall);
  assert.equal(download.command, venvPython(staging, 'text'));
  assert.equal(localInstall.command, venvPython(staging, 'text'));
  assert.equal(download.cwd, staging);
  assert.equal(localInstall.cwd, staging);
  assert.deepEqual(download.args, [
    '-m', 'pip', '--isolated', 'download',
    '--disable-pip-version-check', '--no-input',
    '--index-url', 'https://pypi.org/simple',
    '--no-deps', '--only-binary=:all:',
    '--dest', 'runtime/text/.wheel-stage/paddlepaddle',
    'paddlepaddle==2.6.2',
  ]);
  assert(localInstall.args.includes('--no-index'));
  assert(localInstall.args.includes('--no-deps'));
  assert(!localInstall.args.includes('--index-url'));
  assert.equal(
    localInstall.args.at(-1),
    'runtime/text/.wheel-stage/paddlepaddle/paddlepaddle-2.6.2-cp312-cp312-win_amd64.whl',
  );
  assert.equal(path.isAbsolute(localInstall.args.at(-1)), false);
  assert.equal(download.env.PYTHONUTF8, '1');
  assert(!Object.hasOwn(download.env, 'OPENAI_API_KEY'));
  assert(calls.indexOf(download) < calls.indexOf(localInstall));
  assert.equal(fs.existsSync(path.join(staging, 'runtime', 'text', '.wheel-stage')), false);
});
\`\`\`

- [ ] **步骤 2：运行 happy path 测试确认红灯**

运行：

\`\`\`powershell
Set-Location backend-node
node --test --test-concurrency=1 --test-name-pattern="PaddlePaddle downloads one wheel" test/redrawFullFrameDetectorProcess.test.js
\`\`\`

预期：FAIL；旧实现没有 download 调用，\`download\` 为 \`undefined\`。

- [ ] **步骤 3：添加下载和安装阶段红灯测试**

\`\`\`js
test('PaddlePaddle download and local install failures keep distinct trusted stages', async (t) => {
  const makeStaging = (name) => {
    const root = tempDir(t, name);
    fs.mkdirSync(path.join(root, 'runtime', 'text', '.venv'), { recursive: true });
    return root;
  };
  const sensitive = new Error('private path Authorization Bearer secret');
  sensitive.stage = 'download:text:paddlepaddle';

  await assert.rejects(
    installRuntime(makeStaging('redraw-paddle-download-fail-'), [], 'text', {
      spawnProcess: async (_command, args) => {
        if (args.includes('download')) throw sensitive;
        return '';
      },
    }),
    (error) => assertStableFetchError(error, 'download:text:paddlepaddle'),
  );

  const installRoot = makeStaging('redraw-paddle-install-fail-');
  await assert.rejects(
    installRuntime(installRoot, [], 'text', {
      spawnProcess: async (_command, args) => {
        if (args.includes('download')) {
          const relativeDir = args[args.indexOf('--dest') + 1];
          fs.writeFileSync(
            path.join(installRoot, relativeDir, 'paddlepaddle-2.6.2-cp312-cp312-win_amd64.whl'),
            'fixture-wheel',
          );
        }
        if (args.includes('--no-index')) throw sensitive;
        return '';
      },
    }),
    (error) => assertStableFetchError(error, 'install:text:paddlepaddle'),
  );
});
\`\`\`

运行同一 \`--test-name-pattern="PaddlePaddle"\` 命令。预期：FAIL；旧实现不存在可信 download 阶段和本地 no-index 安装。

- [ ] **步骤 4：实现最小两阶段 helper**

在获取器中：

\`\`\`js
async function installPinnedPaddleWheel(staging, python, deps = {}) {
  const runner = deps.spawnProcess || spawnProcess;
  const relativeDir = PADDLE_WHEEL_RELATIVE_DIR;
  const wheelDir = path.join(staging, relativeDir);
  let wheelName;
  try {
    await fsp.mkdir(path.dirname(wheelDir), { recursive: false });
    await fsp.mkdir(wheelDir, { recursive: false });
    await runner(python, [
      '-m', 'pip', '--isolated', 'download',
      '--disable-pip-version-check', '--no-input',
      '--index-url', PYPI_INDEX_URL,
      '--no-deps', '--only-binary=:all:',
      '--dest', relativeDir,
      PADDLE_WHEEL_REQUIREMENT,
    ], { cwd: staging, env: sanitizeEnv(deps.env) });
    const entries = await fsp.readdir(wheelDir, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0].isFile() || !PADDLE_WHEEL_NAME.test(entries[0].name)) {
      throw error(MODEL_ERROR);
    }
    wheelName = entries[0].name;
  } catch (err) {
    throw sanitizedError(err, 'download:text:paddlepaddle');
  }

  try {
    await runner(python, [
      '-m', 'pip', '--isolated', 'install',
      '--disable-pip-version-check', '--no-input',
      '--no-index', '--no-deps',
      path.posix.join(relativeDir, wheelName),
    ], { cwd: staging, env: sanitizeEnv(deps.env) });
    await fsp.unlink(path.join(wheelDir, wheelName));
    await fsp.rmdir(wheelDir);
    await fsp.rmdir(path.dirname(wheelDir));
  } catch (err) {
    throw sanitizedError(err, 'install:text:paddlepaddle');
  }
}
\`\`\`

\`normalizeStage()\` 增加唯一精确分支：

\`\`\`js
if (stage === 'download:text:paddlepaddle') return stage;
\`\`\`

\`installRuntime()\` 在普通 install argv 构造前增加：

\`\`\`js
if (isPaddleWheelSpec(runtimeName, spec)) {
  await installPinnedPaddleWheel(staging, python, deps);
  continue;
}
\`\`\`

- [ ] **步骤 5：运行目标测试确认绿灯**

运行：

\`\`\`powershell
node --test --test-concurrency=1 --test-name-pattern="PaddlePaddle" test/redrawFullFrameDetectorProcess.test.js
node --check scripts/fetch-redraw-full-frame-models-local.js
node --check test/redrawFullFrameDetectorProcess.test.js
git diff --check
\`\`\`

预期：新增测试全部 PASS、0 fail；无真实 pip 或网络进程。

- [ ] **步骤 6：提交任务 1**

\`\`\`powershell
git add -- scripts/fetch-redraw-full-frame-models-local.js test/redrawFullFrameDetectorProcess.test.js
git commit -m "feat(转绘): 拆分 Paddle wheel 下载与安装"
\`\`\`

### 任务 2：加固 wheel 路径、身份和漂移证据

**文件：**

- 修改：\`backend-node/test/redrawFullFrameDetectorProcess.test.js\`
- 修改：\`backend-node/scripts/fetch-redraw-full-frame-models-local.js\`

- [ ] **步骤 1：添加 wheel 证据矩阵红灯**

建立 table-driven 测试，fake download 分别产生：

\`\`\`js
const invalidWheelCases = [
  ['empty', () => {}],
  ['extra file', (dir) => {
    fs.writeFileSync(path.join(dir, VALID_PADDLE_WHEEL), 'wheel');
    fs.writeFileSync(path.join(dir, 'extra.whl'), 'extra');
  }],
  ['wrong package', (dir) => fs.writeFileSync(
    path.join(dir, 'notpaddle-2.6.2-cp312-cp312-win_amd64.whl'), 'wheel',
  )],
  ['wrong version', (dir) => fs.writeFileSync(
    path.join(dir, 'paddlepaddle-3.0.0-cp312-cp312-win_amd64.whl'), 'wheel',
  )],
  ['archive', (dir) => fs.writeFileSync(
    path.join(dir, 'paddlepaddle-2.6.2.tar.gz'), 'archive',
  )],
  ['directory', (dir) => fs.mkdirSync(
    path.join(dir, VALID_PADDLE_WHEEL),
  )],
];
\`\`\`

每项调用 \`installRuntime(..., 'text', fakeDeps)\`，断言：

\`\`\`js
(error) => assertStableFetchError(error, 'download:text:paddlepaddle')
\`\`\`

并断言 local install 调用数为 0、错误 JSON 不含 staging root 或 fixture 文件名。

- [ ] **步骤 2：运行证据矩阵确认红灯**

运行：

\`\`\`powershell
node --test --test-concurrency=1 --test-name-pattern="wheel evidence" test/redrawFullFrameDetectorProcess.test.js
\`\`\`

预期：至少 directory case 或错误阶段断言 FAIL；任务 1 的最小实现尚未完成 lstat/realpath/身份合同。

- [ ] **步骤 3：添加 symlink 和读时漂移红灯**

新增独立测试：

- wheel 文件 symlink 指向下载目录外普通文件；Windows 创建失败仅该子测试以明确 EPERM skip；
- 用目录 junction 替换 package 下载目录并指向 staging 外；创建失败仅该子测试以明确 EPERM skip；
- patch \`fsp.realpath\`，第二次读取目标 wheel 时返回目录外路径；
- fake local install 返回前重写 wheel 内容，保持文件名不变。

另让 download 和 local install 的 raw Error 分别伪造合法的对方阶段并携带 Authorization、Key 和绝对路径，断言当前 trusted fallback stage 不被覆盖。全部用例要求拒绝、local install 或后续清理不能发布成功、序列化错误不含绝对路径或敏感内容。

- [ ] **步骤 4：实现受控证据读取与复核**

新增：

\`\`\`js
function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameResolvedPath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

async function readPaddleWheelEvidence(staging, wheelDir) {
  const expectedRelativeDir = PADDLE_WHEEL_RELATIVE_DIR.split('/').join(path.sep);
  if (path.relative(staging, wheelDir) !== expectedRelativeDir) throw error(MODEL_ERROR);
  const stagingReal = await fsp.realpath(staging);
  const wheelDirStat = await fsp.lstat(wheelDir, { bigint: true });
  if (!wheelDirStat.isDirectory() || wheelDirStat.isSymbolicLink()) throw error(MODEL_ERROR);
  const realDir = await fsp.realpath(wheelDir);
  if (!sameResolvedPath(realDir, path.join(stagingReal, expectedRelativeDir))) {
    throw error(MODEL_ERROR);
  }
  const entries = await fsp.readdir(wheelDir, { withFileTypes: true });
  if (entries.length !== 1) throw error(MODEL_ERROR);
  const entry = entries[0];
  if (!entry.isFile() || entry.isSymbolicLink() || !PADDLE_WHEEL_NAME.test(entry.name)) {
    throw error(MODEL_ERROR);
  }
  const absPath = path.join(wheelDir, entry.name);
  const pathStat = await fsp.lstat(absPath, { bigint: true });
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw error(MODEL_ERROR);
  const realPath = await fsp.realpath(absPath);
  if (!sameResolvedPath(path.dirname(realPath), realDir)) throw error(MODEL_ERROR);
  const relativePath = path.relative(staging, absPath).split(path.sep).join('/');
  if (relativePath !== `${PADDLE_WHEEL_RELATIVE_DIR}/${entry.name}`) {
    throw error(MODEL_ERROR);
  }
  return {
    relativePath,
    absPath,
    realDir,
    realPath,
    pathStat,
  };
}

async function revalidatePaddleWheelEvidence(evidence) {
  const current = await fsp.lstat(evidence.absPath, { bigint: true });
  const currentReal = await fsp.realpath(evidence.absPath);
  if (!current.isFile()
    || current.isSymbolicLink()
    || !sameResolvedPath(currentReal, evidence.realPath)
    || !sameFileIdentity(current, evidence.pathStat)) {
    throw error(MODEL_ERROR);
  }
}
\`\`\`

用 \`let evidence\` 替换任务 1 的 \`wheelName\`。下载 runner 返回后，在同一个 download try 块内调用 \`evidence = await readPaddleWheelEvidence(staging, wheelDir)\`，保证所有下载输出证据不合格都被该 catch 映射为 download 阶段。本地安装命令只使用 \`evidence.relativePath\`；安装成功后在 install try 块内调用 \`revalidatePaddleWheelEvidence(evidence)\`，再按 \`unlink evidence.absPath -> rmdir package dir -> rmdir .wheel-stage\` 的固定顺序清理，不得对该内部目录使用递归删除。安装开始后的漂移和清理失败归入 install 阶段，外层 \`runFetchModels\` 仍负责失败时只递归清理本次随机 staging。

- [ ] **步骤 5：运行目标与完整 detector 测试**

\`\`\`powershell
node --test --test-concurrency=1 --test-name-pattern="PaddlePaddle|wheel evidence|wheel drift" test/redrawFullFrameDetectorProcess.test.js
node --test --test-concurrency=1 test/redrawFullFrameDetectorProcess.test.js
node --check scripts/fetch-redraw-full-frame-models-local.js
git diff --check
\`\`\`

预期：目标测试 0 fail；完整 detector 测试 0 fail。只有明确 Windows symlink 权限用例可以 skip。

- [ ] **步骤 6：提交任务 2**

\`\`\`powershell
git add -- scripts/fetch-redraw-full-frame-models-local.js test/redrawFullFrameDetectorProcess.test.js
git commit -m "fix(转绘): 加固 Paddle wheel 证据门禁"
\`\`\`

### 任务 3：固化 runFetchModels 原子失败与无真实执行边界

**文件：**

- 修改：\`backend-node/test/redrawFullFrameDetectorProcess.test.js:820-943\`

- [ ] **步骤 1：添加下载失败的全编排回归测试**

用真实 \`installRuntime\` 加 fake runner 的 wrapper 注入：

\`\`\`js
test('runFetchModels removes staging when Paddle wheel download fails', async (t) => {
  const parent = tempDir(t, 'redraw-paddle-run-fetch-');
  const outputDir = path.join(parent, 'cache');
  const processDeps = {
    env: { REDRAW_AUDITOR_PYTHON: 'python-fixture', PATH: 'path-value' },
    spawnProcess: async (_command, args) => {
      if (args.includes('download')) throw new Error('private download failure');
      return '';
    },
  };
  const deps = {
    ...buildSuccessfulFetchDeps('paddle-download'),
    createVenv: async (staging, runtimeName) => {
      fs.mkdirSync(path.join(staging, 'runtime', runtimeName, '.venv'), { recursive: true });
    },
    installRuntime: (staging, components, runtimeName) => (
      installRuntime(staging, components, runtimeName, processDeps)
    ),
  };

  await assert.rejects(
    runFetchModels({ outputDir }, deps),
    (error) => assertStableFetchError(error, 'download:text:paddlepaddle'),
  );
  assert.equal(fs.existsSync(outputDir), false);
  assert.equal(fs.existsSync(path.join(outputDir, 'model-lock.json')), false);
  assert.deepEqual(
    fs.readdirSync(parent).filter((name) => name.startsWith('.redraw-full-frame-staging-')),
    [],
  );
});
\`\`\`

- [ ] **步骤 2：运行完整编排回归**

\`\`\`powershell
node --test --test-concurrency=1 --test-name-pattern="removes staging when Paddle" test/redrawFullFrameDetectorProcess.test.js
\`\`\`

预期：PASS。任务 1—2 已建立 trusted download stage；本步骤只证明该阶段能穿过 \`runFetchModels\`，并且失败时最终目录、模型锁和随机 staging 均不存在，不为制造红灯而修改生产代码。

- [ ] **步骤 3：补齐其他包调用不变断言**

更新现有 \`default runtime helpers use safe argv...\` 测试：

- 断言总 spec 数仍为 main 23、text 31；
- 除 PaddlePaddle 外的 53 个 spec 仍以原 requirement 作为最后参数；
- 只有一个 download 调用；
- 只有 PaddlePaddle 的 install 使用 \`--no-index\` 和 wheel 相对路径；
- 既有五个 no-deps package 集不变；
- 所有命令仍使用数组 argv、安全环境、\`shell:false\` 的现有 runner 合同。

- [ ] **步骤 4：运行联合回归**

\`\`\`powershell
node --test --test-concurrency=1 test/redrawFullFrameModelLock.test.js test/redrawFullFrameDetectorProcess.test.js test/redrawFullFrameCoverage.test.js test/redrawFullFrameCoverageLocal.test.js test/redrawFullFrameReview.test.js
node --check scripts/fetch-redraw-full-frame-models-local.js
node --check test/redrawFullFrameDetectorProcess.test.js
git diff --check
\`\`\`

预期：0 fail；仅既有 Windows symlink/junction EPERM 用例允许明确 skip。命令不得设置 \`REDRAW_AUDITOR_PYTHON\`，避免把无关 review 测试置于外部解释器沙箱。随后先调用桌面工作区依赖加载器取得 bundled Python 的绝对路径，只把返回值赋给当前 PowerShell 进程的 \`REDRAW_AUDITOR_PYTHON\`，不得打印或写入文件；再运行 detector 合同探针并要求 0 skip：

\`\`\`powershell
if (-not $env:REDRAW_AUDITOR_PYTHON) { throw 'REDRAW_AUDITOR_PYTHON_REQUIRED' }
node --test --test-concurrency=1 test/redrawFullFrameDetectorProcess.test.js
Remove-Item Env:REDRAW_AUDITOR_PYTHON
\`\`\`

实际解释器绝对路径只写入当前进程环境，不写计划输出、测试快照、报告或提交。

- [ ] **步骤 5：提交任务 3**

\`\`\`powershell
git add -- test/redrawFullFrameDetectorProcess.test.js
git commit -m "test(转绘): 固化 Paddle wheel 原子失败证据"
\`\`\`

若步骤 2—4 未产生新的测试文件差异，不创建空提交。

### 任务 4：脱敏报告、规格审查和质量审查

**文件：**

- 创建：\`docs/superpowers/reports/2026-08-16-redraw-full-frame-paddle-wheel-stage-local-verification.md\`
- 只读：本计划列出的 source、test、design 和 commits

- [ ] **步骤 1：编写本地验证报告**

报告必须填写具体的实现 HEAD、红灯命令及失败原因、目标与联合测试的 tests/pass/fail/skip 实数、静态检查退出码、download/install 两个稳定阶段证据、最终目录/模型锁/staging 的原子清理结果、脱敏扫描结果和真实执行边界。不得保留空字段、模板值或待补数字。

明确声明没有真实网络、pip、venv、模型 bootstrap、四组件 smoke、Key、供应商、数据库、SSH、部署或 push；不得包含绝对路径、wheel 文件名、URL、Authorization、底层 stderr 或缓存位置。

- [ ] **步骤 2：运行报告与提交前检查**

\`\`\`powershell
rg -n -i "[A-Za-z]:\\\\Users\\\\|https?://|Authorization:|Bearer " docs/superpowers/reports/2026-08-16-redraw-full-frame-paddle-wheel-stage-local-verification.md
git diff --check
\`\`\`

预期：敏感/占位扫描无命中，\`git diff --check\` exit 0。

- [ ] **步骤 3：提交报告**

\`\`\`powershell
git add -- docs/superpowers/reports/2026-08-16-redraw-full-frame-paddle-wheel-stage-local-verification.md
git commit -m "docs(转绘): 记录 Paddle wheel 分阶段验证"
\`\`\`

- [ ] **步骤 4：执行规格审查**

逐项对照：

- \`docs/superpowers/specs/2026-08-16-redraw-full-frame-paddle-wheel-stage-design.md\`
- 任务 1—3 的提交差异
- 红绿测试输出
- 本地验证报告

Critical/Important/Medium 任一未解决均返回对应任务最小修复；修复后重新运行完整目标和联合测试。

- [ ] **步骤 5：执行代码质量审查**

重点核对：

- 下载目录 lexical/realpath 边界；
- symlink/junction 和读时身份漂移；
- trusted stage 不能被 raw error 伪造；
- local install 不含网络索引；
- wheel 临时目录成功和失败都不进入最终缓存；
- 其他 53 个 spec 行为不变；
- 测试没有真实 pip、网络或假阳性。

- [ ] **步骤 6：提交后新鲜复验**

\`\`\`powershell
Set-Location backend-node
node --test --test-concurrency=1 test/redrawFullFrameDetectorProcess.test.js
node --test --test-concurrency=1 test/redrawFullFrameModelLock.test.js test/redrawFullFrameDetectorProcess.test.js test/redrawFullFrameCoverage.test.js test/redrawFullFrameCoverageLocal.test.js test/redrawFullFrameReview.test.js
node --check scripts/fetch-redraw-full-frame-models-local.js
node --check test/redrawFullFrameDetectorProcess.test.js
Set-Location ..
git diff --check
git status --short --branch
\`\`\`

预期：所有命令 exit 0；tracked clean，仅保留任务前既有五类未跟踪目录。

## 完成边界

只有任务 1—4 全部完成、两阶段审查无未解决项、提交后新鲜复验 0 fail，才能报告“PaddlePaddle 下载与安装分阶段本地实现完成”。

不得报告 PaddlePaddle 已真实下载或安装、官方缓存成功、四组件 smoke 成功、整集审核恢复或可以部署。任何新真实 fetch 仍需用户另行明确授权一次且仅一次，失败不得自动重试。
