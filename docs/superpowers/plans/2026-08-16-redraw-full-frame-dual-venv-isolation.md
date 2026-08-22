# 全帧审核双 venv 进程隔离实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把全帧审核主 worker 与 PaddleOCR 文字 worker 拆到两套受模型锁 v2 约束的本地 Python venv，同时保持外层审核协议不变。

**架构：** Node 获取器在一个 staging 内顺序构建 `runtime/main/.venv` 与 `runtime/text/.venv`，分别冻结并写入哈希绑定的运行时证据。Node 只启动主解释器；主 worker 校验 v2 锁后，从锁内受控相对路径解析文字解释器并启动现有常驻文字子进程。四组件、人工审核和 finalize schema 不变，任一失败都阻止整个缓存发布。

**技术栈：** Node.js 20、`node:test`、Python 3.11/3.12 标准库、`unittest`、JSONL、SHA-256、原子文件写入、Windows venv、YOLOX、ByteTrack、MediaPipe、PaddlePaddle、PaddleOCR。

---

## 文件职责

- 修改：`backend-node/src/services/redrawFullFrameModelLockService.js`：模型锁 v2 canonicalization、双运行时文件/路径/哈希校验。
- 修改：`backend-node/test/redrawFullFrameModelLock.test.js`：v2 双运行时成功与 fail-closed 矩阵。
- 修改：`backend-node/scripts/fetch-redraw-full-frame-models-local.js`：双依赖策略、双 venv 编排、双 freeze、v2 锁和主解释器 bootstrap。
- 修改：`backend-node/test/redrawFullFrameDetectorProcess.test.js`：获取器红绿测试、阶段脱敏、原子失败和无真实网络/安装证明。
- 修改：`workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/worker.py`：Python v2 锁校验、当前主解释器绑定、文字解释器安全解析。
- 修改：`workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/text_worker.py`：文字进程绑定 v2 text runtime。
- 修改：`workers/redraw-full-frame-auditor/tests/test_worker.py`：双运行时锁、解释器路径与主/文字隔离测试。
- 修改：`workers/redraw-full-frame-auditor/tests/test_text_worker.py`：文字 worker 当前解释器和 text runtime 测试。
- 修改：`backend-node/src/services/redrawFullFrameCoverageService.js`：coverage 证据只接受 v2 `runtimes`。
- 修改：`backend-node/test/redrawFullFrameCoverage.test.js`：coverage v2 canonical hash 和字段门禁。
- 修改：`backend-node/test/redrawFullFrameCoverageLocal.test.js`：本地 runner 的 v2 夹具。
- 修改：`backend-node/test/redrawFullFrameReview.test.js`：review/finalize 的 v2 夹具。
- 创建：`docs/superpowers/reports/2026-08-16-redraw-full-frame-dual-venv-local-verification.md`：仅记录本地测试、审查与未执行真实下载的边界。

所有任务都不得修改前端、供应商适配器、数据库、部署脚本或生产配置；不得执行 pip install、真实 venv 创建、网络 fetch、真实模型 bootstrap 或源片审核。

### 任务 1：实现 Node 模型锁 v2 双运行时合同

**文件：**

- 修改：`backend-node/src/services/redrawFullFrameModelLockService.js`
- 修改：`backend-node/test/redrawFullFrameModelLock.test.js`

- [ ] **步骤 1：把成功夹具迁移为 v2，并写双运行时红灯**

在测试夹具中创建两个普通解释器文件和两个 freeze 文件，锁结构固定为：

```js
const runtimes = Object.fromEntries(['main', 'text'].map((name) => {
  const interpreterPath = `runtime/${name}/.venv/Scripts/python.exe`;
  const freezePath = `runtime/${name}/pip-freeze.txt`;
  writeCacheFile(cacheRoot, interpreterPath, Buffer.from(`${name}:python\n`));
  const freezeBytes = Buffer.from(name === 'main'
    ? 'mediapipe==0.10.14\nprotobuf==4.25.9\n'
    : 'paddleocr==2.8.1\npaddlepaddle==2.6.2\nprotobuf==3.20.2\n');
  return [name, {
    python_version: 'Python 3.11.9',
    interpreter_path: interpreterPath,
    pip_freeze_path: freezePath,
    pip_freeze_sha256: writeCacheFile(cacheRoot, freezePath, freezeBytes),
  }];
}));

lock: {
  schema_version: 'redraw-full-frame-model-lock-v2',
  runtimes,
  components,
}
```

新增断言：结果只含 `runtimes.main`、`runtimes.text` 的相对证据；canonical hash 为 64 位小写 SHA-256；输入对象不被修改；序列化结果不含缓存根绝对路径。

- [ ] **步骤 2：运行模型锁测试确认红灯**

运行：

```powershell
Set-Location backend-node
node --test --test-concurrency=1 test/redrawFullFrameModelLock.test.js
```

预期：FAIL；旧实现因只接受 v1 `runtime` 而拒绝 v2 `runtimes`。

- [ ] **步骤 3：实现最小 v2 canonicalization 和安全文件证据**

用精确键替换旧运行时透传：

```js
const LOCK_SCHEMA = 'redraw-full-frame-model-lock-v2';
const TOP_LEVEL_KEYS = Object.freeze(['schema_version', 'runtimes', 'components']);
const RUNTIME_NAMES = Object.freeze(['main', 'text']);
const RUNTIME_KEYS = Object.freeze([
  'python_version',
  'interpreter_path',
  'pip_freeze_path',
  'pip_freeze_sha256',
]);

function canonicalizeRuntime(name, runtime) {
  assertExactKeys(runtime, RUNTIME_KEYS);
  return {
    python_version: requireConcreteString(runtime.python_version),
    interpreter_path: requireRuntimePath(name, runtime.interpreter_path, 'python'),
    pip_freeze_path: requireRuntimePath(name, runtime.pip_freeze_path, 'pip-freeze.txt'),
    pip_freeze_sha256: requireHash(runtime.pip_freeze_sha256),
  };
}
```

`canonicalizeModelLock()` 必须精确校验 `runtimes` 只有 `main`、`text`；`validateModelLock()` 必须用现有 fd 身份复核读取两个 freeze、验证哈希，并用同等 root/realpath/普通文件/打开前后身份合同验证两个解释器。两个解释器的最终 realpath 必须不同。

- [ ] **步骤 4：补齐 fail-closed 对抗矩阵**

逐项测试：

对 `main`、`text` 的 `interpreter_path` 和 `pip_freeze_path` 分别建立独立子测试，输入绝对路径、`C:relative`、`..`、目录、root 外 symlink 和 realpath 漂移，全部断言拒绝。两个 runtime 还要分别覆盖 freeze 内容漂移、声明 hash 漂移、缺文件和未知字段。

另测 v1、缺少任一 runtime、额外 runtime、两个解释器指向同一文件、组件 hash 漂移全部返回 `REDRAW_FULL_FRAME_MODEL_LOCK_INVALID`，且 error/message/JSON 不含绝对路径或底层原因。

- [ ] **步骤 5：运行绿灯与静态检查**

运行：

```powershell
Set-Location backend-node
node --test --test-concurrency=1 test/redrawFullFrameModelLock.test.js
node --check src/services/redrawFullFrameModelLockService.js
node --check test/redrawFullFrameModelLock.test.js
git diff --check
```

预期：全部 exit 0，目标测试 0 fail。

- [ ] **步骤 6：提交任务 1**

```powershell
git add -- backend-node/src/services/redrawFullFrameModelLockService.js backend-node/test/redrawFullFrameModelLock.test.js
git commit -m "feat(转绘): 升级全帧双运行时模型锁"
```

### 任务 2：把本地获取器拆为双 venv 编排

**文件：**

- 修改：`backend-node/scripts/fetch-redraw-full-frame-models-local.js`
- 修改：`backend-node/test/redrawFullFrameDetectorProcess.test.js`

- [ ] **步骤 1：编写双 venv 编排红灯测试**

在现有注入 runner 基础上记录事件，并断言固定顺序：

```js
assert.deepEqual(events, [
  'fetch:face_detector', 'fetch:person_detector', 'fetch:text_detector', 'fetch:tracker',
  'create_venv:main', 'install_runtime:main', 'freeze:main', 'python_version:main',
  'create_venv:text', 'install_runtime:text', 'freeze:text', 'python_version:text',
  'bootstrap:main', 'validate', 'publish',
]);
assert.equal(lock.schema_version, 'redraw-full-frame-model-lock-v2');
assert.deepEqual(Object.keys(lock.runtimes).sort(), ['main', 'text']);
assert.equal(result.runtime_locks.main, 'runtime/main/pip-freeze.txt');
assert.equal(result.runtime_locks.text, 'runtime/text/pip-freeze.txt');
```

测试中的 `createVenv`、`installRuntime`、`pipFreeze`、`pythonVersion`、`bootstrapWorker`、`fetchComponent` 全部使用注入 fake，不执行真实命令或网络。

- [ ] **步骤 2：运行获取器测试确认红灯**

运行：

```powershell
Set-Location backend-node
node --test --test-concurrency=1 --test-name-pattern="dual venv|双 venv|runtime v2" test/redrawFullFrameDetectorProcess.test.js
```

预期：FAIL；旧实现只创建 `.venv` 并返回单个 `runtime_lock`。

- [ ] **步骤 3：拆分不可变依赖策略**

把现有单数组拆成两个精确直接依赖集合。主运行时固定为：

```js
const MAIN_RUNTIME_PACKAGE_SPECS = Object.freeze([
  ['setuptools==80.9.0'], ['wheel==0.43.0'], ['numpy==1.26.4'],
  ['protobuf==4.25.9'], ['Pillow==11.3.0'], ['six==1.17.0'],
  ['absl-py==2.5.0'], ['attrs==26.1.0'], ['flatbuffers==25.12.19'],
  ['matplotlib==3.11.1'], ['sounddevice==0.5.5'],
  ['opencv-python-headless==4.10.0.84'], ['torch==2.3.1'],
  ['torchvision==0.18.1'], ['yolox==0.3.0', true],
  ['pycocotools==2.0.11'], ['loguru==0.7.2'], ['tabulate==0.9.0'],
  ['thop==0.1.1.post2209072238'], ['lap==0.5.13'], ['Cython==3.2.9'],
  ['cython-bbox==0.1.5'], ['mediapipe==0.10.14', true],
].map(([requirement, noDeps = false]) => Object.freeze({ requirement, ...(noDeps ? { noDeps: true } : {}) })));
```

文字运行时固定为：

```js
const TEXT_RUNTIME_PACKAGE_SPECS = Object.freeze([
  ['setuptools==80.9.0'], ['wheel==0.43.0'], ['numpy==1.26.4'],
  ['protobuf==3.20.2'], ['Pillow==11.3.0'], ['six==1.17.0'],
  ['scipy==1.17.1'], ['imageio==2.37.4'], ['tifffile==2026.3.3'],
  ['scikit-image==0.26.0'], ['Shapely==2.1.2'], ['pyclipper==1.4.0'],
  ['lmdb==2.3.0'], ['tqdm==4.68.1'], ['requests==2.33.0'],
  ['httpx==0.27.0'], ['decorator==5.3.1'], ['astor==0.8.1'],
  ['opt-einsum==3.3.0'], ['opencv-python-headless==4.10.0.84'],
  ['imgaug==0.4.0', true], ['paddlepaddle==2.6.2', true],
  ['beautifulsoup4==4.15.0'], ['fire==0.7.1'], ['lxml==6.1.1'],
  ['python-docx==1.2.0'], ['PyYAML==6.0.3'], ['RapidFuzz==3.14.5'],
  ['soupsieve==2.9.2'], ['termcolor==3.3.0'], ['paddleocr==2.8.1', true],
].map(([requirement, noDeps = false]) => Object.freeze({ requirement, ...(noDeps ? { noDeps: true } : {}) })));
```

传递依赖也按运行时精确分组；同一 canonical package 可以合法出现在两个独立 map：

```js
const MAIN_RUNTIME_TRANSITIVE_SPECS = new Map([
  ['cffi', '2.1.1'], ['colorama', '0.4.6'], ['contourpy', '1.3.3'],
  ['cycler', '0.12.1'], ['filelock', '3.32.3'], ['fonttools', '4.63.0'],
  ['fsspec', '2026.7.0'], ['intel-openmp', '2021.4.0'], ['jinja2', '3.1.6'],
  ['kiwisolver', '1.5.0'], ['markupsafe', '3.0.3'], ['mkl', '2021.4.0'],
  ['mpmath', '1.3.0'], ['networkx', '3.6.1'], ['packaging', '26.3'],
  ['pycparser', '3.0'], ['pyparsing', '3.3.2'],
  ['python-dateutil', '2.9.0.post0'], ['sympy', '1.14.0'],
  ['tbb', '2021.13.1'], ['typing-extensions', '4.16.0'],
  ['win32-setctime', '1.2.0'],
]);
const TEXT_RUNTIME_TRANSITIVE_SPECS = new Map([
  ['anyio', '4.14.2'], ['certifi', '2026.7.22'],
  ['charset-normalizer', '3.5.1'], ['h11', '0.16.0'], ['httpcore', '1.0.9'],
  ['idna', '3.18'], ['lazy-loader', '0.5'], ['networkx', '3.6.1'],
  ['packaging', '26.3'], ['sniffio', '1.3.1'],
  ['typing-extensions', '4.16.0'], ['urllib3', '2.7.0'],
]);
const RUNTIME_POLICIES = Object.freeze({
  main: Object.freeze({ direct: MAIN_RUNTIME_PACKAGE_SPECS, transitive: MAIN_RUNTIME_TRANSITIVE_SPECS }),
  text: Object.freeze({ direct: TEXT_RUNTIME_PACKAGE_SPECS, transitive: TEXT_RUNTIME_TRANSITIVE_SPECS }),
});
```

测试必须直接断言：main 有且仅有 `protobuf==4.25.9`，text 有且仅有 `protobuf==3.20.2`；main 无 paddle 包；text 无 torch/torchvision/yolox/mediapipe；每个环境分别拒绝 unknown、duplicate、错误版本和跨环境包。保留现有 PEP 503 canonical name、`--no-deps` 和 Windows-only transitive 门禁。

- [ ] **步骤 4：实现带 runtimeName 的最小运行时函数**

函数实现保持现有 runner 与环境净化逻辑，只增加受信任运行时名称：

```js
function runtimePolicy(runtimeName) {
  const policy = RUNTIME_POLICIES[runtimeName];
  if (!policy) throw sanitizedError(error(MODEL_ERROR), 'unknown');
  return policy;
}

function venvPython(staging, runtimeName) {
  runtimePolicy(runtimeName);
  return process.platform === 'win32'
    ? path.join(staging, 'runtime', runtimeName, '.venv', 'Scripts', 'python.exe')
    : path.join(staging, 'runtime', runtimeName, '.venv', 'bin', 'python');
}

async function createVenv(staging, runtimeName, deps = {}) {
  runtimePolicy(runtimeName);
  const runner = deps.spawnProcess || spawnProcess;
  try {
    await runner(runtimePython(deps), ['-m', 'venv', `runtime/${runtimeName}/.venv`], {
      cwd: staging,
      env: sanitizeEnv(deps.env),
    });
  } catch (err) {
    throw sanitizedError(err, `create_venv:${runtimeName}`);
  }
}

async function installRuntime(staging, runtimeName, deps = {}) {
  const runner = deps.spawnProcess || spawnProcess;
  for (const spec of runtimePolicy(runtimeName).direct) {
    const args = ['-m', 'pip', '--isolated', 'install', '--disable-pip-version-check', '--no-input', '--index-url', PYPI_INDEX_URL];
    if (spec.noDeps) args.push('--no-deps');
    args.push(spec.requirement);
    try {
      await runner(venvPython(staging, runtimeName), args, { cwd: staging, env: sanitizeEnv(deps.env) });
    } catch (err) {
      throw sanitizedError(err, `install:${runtimeName}:${splitRequirement(spec.requirement).name}`);
    }
  }
}

async function pipFreeze(staging, runtimeName, deps = {}) {
  const runner = deps.spawnProcess || spawnProcess;
  try {
    const output = await runner(venvPython(staging, runtimeName), ['-m', 'pip', 'freeze'], {
      cwd: staging,
      env: sanitizeEnv(deps.env),
    });
    return assertPinnedFreeze(String(output).split(/\r?\n/), runtimeName, deps.platform);
  } catch (err) {
    throw sanitizedError(err, `freeze:${runtimeName}`);
  }
}

async function pythonVersion(staging, runtimeName, deps = {}) {
  const runner = deps.spawnProcess || spawnProcess;
  try {
    return String(await runner(venvPython(staging, runtimeName), ['--version'], {
      cwd: staging,
      env: sanitizeEnv(deps.env),
    })).trim();
  } catch (err) {
    throw sanitizedError(err, `python_version:${runtimeName}`);
  }
}
```

创建命令的 cwd 为 staging，目标参数为 `runtime/<name>/.venv`；install/freeze/version 只使用该 runtime 的解释器。失败阶段由受信任 `runtimeName` 与对应 canonical package 生成，例如 `create_venv:text`、`install:text:paddleocr`、`freeze:main`。

- [ ] **步骤 5：实现 v2 锁写入和主解释器 bootstrap**

`runFetchModels()` 先完成 main，再完成 text；分别原子写 freeze，构造：

```js
function runtimeEvidence(runtimeName, pythonVersionValue, freeze) {
  runtimePolicy(runtimeName);
  const freezeBytes = Buffer.from(`${freeze.join('\n')}\n`);
  return {
    python_version: pythonVersionValue,
    interpreter_path: process.platform === 'win32'
      ? `runtime/${runtimeName}/.venv/Scripts/python.exe`
      : `runtime/${runtimeName}/.venv/bin/python`,
    pip_freeze_path: `runtime/${runtimeName}/pip-freeze.txt`,
    pip_freeze_sha256: sha256(freezeBytes),
  };
}

const lock = {
  schema_version: 'redraw-full-frame-model-lock-v2',
  runtimes: {
    main: runtimeEvidence('main', mainVersion, mainFreeze),
    text: runtimeEvidence('text', textVersion, textFreeze),
  },
  components,
};
await deps.bootstrapWorker(staging, path.join(staging, 'model-lock.json'), 'main');
```

`bootstrapWorker()` 必须调用 `venvPython(staging, 'main')`。任一第二环境失败也必须保留用户空目标原状、删除本次随机 staging、无 model-lock 发布、无自动重试。

- [ ] **步骤 6：补齐 CLI 脱敏和无真实执行测试**

对 `create_venv:main/text`、`install:main/text:<pkg>`、`freeze:main/text`、`python_version:main/text`、runtime lock 写入、bootstrap、validate、publish 各测稳定阶段。raw Error 即使伪造合法阶段也只能回退到当前可信阶段；stdout/stderr 不得包含输出目录、命令、URL、Key、Authorization、proxy 或底层 message。

源码/测试再断言本地单测路径只调用注入依赖；本任务验证命令不得执行 `npm run fetch:*`、真实脚本 CLI 或 `pip`。

- [ ] **步骤 7：运行绿灯与提交任务 2**

```powershell
Set-Location backend-node
node --test --test-concurrency=1 test/redrawFullFrameDetectorProcess.test.js test/redrawFullFrameModelLock.test.js
node --check scripts/fetch-redraw-full-frame-models-local.js
node --check test/redrawFullFrameDetectorProcess.test.js
git diff --check
git add -- scripts/fetch-redraw-full-frame-models-local.js test/redrawFullFrameDetectorProcess.test.js
git commit -m "feat(转绘): 拆分全帧双 venv 获取器"
```

预期：全部 exit 0，目标测试 0 fail。

### 任务 3：让 Python worker 从 v2 锁选择文字解释器

**文件：**

- 修改：`workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/worker.py`
- 修改：`workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/text_worker.py`
- 修改：`workers/redraw-full-frame-auditor/tests/test_worker.py`
- 修改：`workers/redraw-full-frame-auditor/tests/test_text_worker.py`

- [ ] **步骤 1：迁移 Python 锁夹具并写解释器选择红灯**

`write_model_lock()` 创建 v2 `runtimes`、两个解释器普通文件和两个 freeze 文件。新增：

```python
def text_process_factory(**kwargs):
    self.assertEqual(pathlib.Path(kwargs["python_path"]), text_python.resolve())
    self.assertEqual(pathlib.Path(kwargs["model_lock_path"]), lock_path.resolve())
    return FakeTextDetector()
```

同时断言默认文字工厂不再使用 `sys.executable`；主解释器与 text 解释器同文件、v1、路径逃逸、freeze hash 漂移均在加载任何 detector 前失败。

- [ ] **步骤 2：运行 Python 目标测试确认红灯**

运行：

```powershell
& $env:REDRAW_AUDITOR_PYTHON -m unittest `
  workers/redraw-full-frame-auditor/tests/test_worker.py `
  workers/redraw-full-frame-auditor/tests/test_text_worker.py -v
```

预期：FAIL；旧 `_validate_model_lock()` 只接受 v1，且 `_default_text_process_factory()` 使用 `sys.executable`。

- [ ] **步骤 3：实现 Python v2 运行时校验**

固定常量与返回结构：

```python
LOCK_SCHEMA = "redraw-full-frame-model-lock-v2"
RUNTIME_NAMES = ("main", "text")
RUNTIME_KEYS = (
    "python_version", "interpreter_path", "pip_freeze_path", "pip_freeze_sha256",
)
```

`_validate_model_lock(model_lock_path)` 的返回值必须是 `(canonical_lock, components, runtimes)`。`runtimes[name]` 只允许在进程内附加 `interpreter_abs_path`，不得写回 JSON、stdout、stderr 或报告。

解释器和 freeze 使用 `_safe_join`、realpath root 边界、普通文件、打开前后身份与 SHA-256 复核；两个解释器 realpath 必须不同。任何底层异常转换为无 cause/context 的稳定 `ProtocolError`。

- [ ] **步骤 4：绑定 main 与 text 当前解释器**

主加载流程在 detector 工厂前验证当前解释器与 `runtimes.main.interpreter_abs_path` 为同一文件。文字工厂改为：

```python
def _default_text_process_factory(model_lock_path, python_path):
    return TextSubprocessAdapter(
        python_path=python_path,
        text_worker_path=_text_worker_path(),
        model_lock_path=model_lock_path,
    )
```

`_load_real_detectors()` 只把已验证的 text path 传入 factory。`text_worker.load_detector()` 再次校验锁、确认当前解释器等于 text runtime 后，只绑定 `text_detector`；不得把 runtime 绝对路径写入响应或错误。

- [ ] **步骤 5：补齐 TOCTOU、脱敏和既有协议回归**

逐项测试解释器/freeze：绝对路径、`..`、缺失、目录、root 外 symlink/junction、打开前后 identity/realpath 漂移、hash 漂移。测试 current interpreter 不匹配时错误阶段保持现有可信 `load`/`load:text:*` 分层，error JSON 不含缓存根、解释器路径、model-lock 路径或 cause。

现有 text JSONL 握手、请求 ID、OCR 原文拒绝、超时、关闭和 safe-stage 测试必须不减少。

- [ ] **步骤 6：运行绿灯与提交任务 3**

```powershell
& $env:REDRAW_AUDITOR_PYTHON -m unittest discover `
  -s workers/redraw-full-frame-auditor/tests -p "test_*.py" -v
& $env:REDRAW_AUDITOR_PYTHON -m py_compile `
  workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/worker.py `
  workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/text_worker.py
git diff --check
git add -- `
  workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/worker.py `
  workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/text_worker.py `
  workers/redraw-full-frame-auditor/tests/test_worker.py `
  workers/redraw-full-frame-auditor/tests/test_text_worker.py
git commit -m "feat(转绘): 绑定全帧双运行时解释器"
```

预期：Python worker 全套 0 fail，静态检查 exit 0。

### 任务 4：迁移 coverage、review 与本地证据到模型锁 v2

**文件：**

- 修改：`backend-node/src/services/redrawFullFrameCoverageService.js`
- 修改：`backend-node/test/redrawFullFrameCoverage.test.js`
- 修改：`backend-node/test/redrawFullFrameCoverageLocal.test.js`
- 修改：`backend-node/test/redrawFullFrameReview.test.js`

- [ ] **步骤 1：把三组夹具迁移为 v2 并确认红灯**

所有锁夹具用一致的最小证据：

```js
const runtimes = {
  main: {
    python_version: 'Python 3.11.9',
    interpreter_path: 'runtime/main/.venv/Scripts/python.exe',
    pip_freeze_path: 'runtime/main/pip-freeze.txt',
    pip_freeze_sha256: '1'.repeat(64),
  },
  text: {
    python_version: 'Python 3.11.9',
    interpreter_path: 'runtime/text/.venv/Scripts/python.exe',
    pip_freeze_path: 'runtime/text/pip-freeze.txt',
    pip_freeze_sha256: '2'.repeat(64),
  },
};
```

运行：

```powershell
Set-Location backend-node
node --test --test-concurrency=1 `
  test/redrawFullFrameCoverage.test.js `
  test/redrawFullFrameCoverageLocal.test.js `
  test/redrawFullFrameReview.test.js
```

预期：FAIL；旧 coverage validator 仍固定 v1 `runtime`。

- [ ] **步骤 2：最小迁移 coverage canonical contract**

把 `LOCK_SCHEMA_VERSION` 固定为 v2；模型锁精确键改为 `schema_version/runtimes/components/canonical_sha256`。`runtimes` 只允许 `main/text`，每项只允许与任务 1 相同的四字段；路径规范化、字符串/hash 校验复用当前 helper。canonical hash 必须包含 runtimes，不能继续接受任意 `runtime` 对象。

- [ ] **步骤 3：补齐证据门禁测试**

测试：v1、额外 runtime、缺 runtime、未知 runtime 字段、解释器绝对路径、freeze `..`、freeze hash 漂移导致 canonical hash 不符，均返回现有稳定模型锁错误且不写部分 manifest。成功时 `manifest.models.model_lock_sha256` 与 v2 canonical hash 一致，review/finalize 业务字段不变。

- [ ] **步骤 4：运行绿灯与提交任务 4**

```powershell
Set-Location backend-node
node --test --test-concurrency=1 `
  test/redrawFullFrameCoverage.test.js `
  test/redrawFullFrameCoverageLocal.test.js `
  test/redrawFullFrameReview.test.js
node --check src/services/redrawFullFrameCoverageService.js
git diff --check
git add -- `
  src/services/redrawFullFrameCoverageService.js `
  test/redrawFullFrameCoverage.test.js `
  test/redrawFullFrameCoverageLocal.test.js `
  test/redrawFullFrameReview.test.js
git commit -m "fix(转绘): 对齐全帧双运行时证据"
```

预期：三组测试 0 fail，静态检查 exit 0。

### 任务 5：联合一致性、完整本地回归与验证报告

**文件：**

- 按失败归属最小修改：任务 1—4 已列出的测试文件
- 创建：`docs/superpowers/reports/2026-08-16-redraw-full-frame-dual-venv-local-verification.md`

- [ ] **步骤 1：增加 Node/Python 合同一致性测试**

用现有本地 Python 探针读取 `worker.py` 导出的固定 schema/runtime names，断言与 Node 获取器一致：

```js
assert.equal(probe.lock_schema, 'redraw-full-frame-model-lock-v2');
assert.deepEqual(probe.runtime_names, ['main', 'text']);
assert.deepEqual(probe.runtime_keys, [
  'python_version', 'interpreter_path', 'pip_freeze_path', 'pip_freeze_sha256',
]);
```

探针只运行仓库代码，不创建 venv、不安装依赖、不访问网络。另断言主/text freeze 策略分别包含正确 protobuf 且互斥 native 组件。

- [ ] **步骤 2：运行完整本地联合回归**

```powershell
Set-Location backend-node
node --test --test-concurrency=1 `
  test/redrawFullFrameModelLock.test.js `
  test/redrawFullFrameDetectorProcess.test.js `
  test/redrawFullFrameCoverage.test.js `
  test/redrawFullFrameCoverageLocal.test.js `
  test/redrawFullFrameReview.test.js

Set-Location ..
& $env:REDRAW_AUDITOR_PYTHON -m unittest discover `
  -s workers/redraw-full-frame-auditor/tests -p "test_*.py" -v
```

预期：全部 exit 0；fail 0。Windows symlink/junction 若因 EPERM 跳过，只能保留已有显式 skip，并在报告中精确记录。

- [ ] **步骤 3：运行静态、差异和敏感项扫描**

```powershell
node --check backend-node/scripts/fetch-redraw-full-frame-models-local.js
node --check backend-node/src/services/redrawFullFrameModelLockService.js
node --check backend-node/src/services/redrawFullFrameCoverageService.js
& $env:REDRAW_AUDITOR_PYTHON -m py_compile `
  workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/worker.py `
  workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/text_worker.py `
  workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/text_subprocess.py
git diff --check
rg -n "KMP_DUPLICATE_LIB_OK|Authorization|Bearer|api[_-]?key|secret[_-]?key" `
  backend-node/scripts/fetch-redraw-full-frame-models-local.js `
  workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor
```

预期：语法与 diff 检查 exit 0；敏感扫描不得发现环境透传、硬编码凭据或 KMP workaround。测试中的对抗字符串可存在，但报告不得复制其值。

- [ ] **步骤 4：编写脱敏本地验证报告**

报告必须包含：

- HEAD 与任务提交列表；
- Node/Python 测试总数、pass/fail/skip；
- v2 schema、双 freeze、解释器相对路径和 protobuf 分离的静态证据；
- 原子失败和脱敏测试结果；
- 明确声明没有运行真实 fetch、pip install、venv 创建、模型 bootstrap、Key 读取、源片上传、供应商调用或部署；
- 明确声明本地绿灯不等于官方模型缓存和四组件 smoke 成功；
- 下一步仍需新的单次真实下载授权。

报告不得包含用户目录、缓存绝对路径、Key、Authorization、模型 URL、源片路径或底层 stderr。

- [ ] **步骤 5：提交报告**

```powershell
git add -- docs/superpowers/reports/2026-08-16-redraw-full-frame-dual-venv-local-verification.md
git commit -m "docs(转绘): 记录双 venv 本地验证证据"
```

### 任务 6：两阶段审查与完成关卡

**文件：**

- 只读审查任务 1—5 的提交、规格、计划和报告
- 发现问题时只把具体 findings 返回对应任务所有者

- [ ] **步骤 1：逐任务规格审查**

对每个实现提交核对：修改文件范围、红灯证据、规格章节、无真实下载边界、测试命令和提交后 clean status。任何遗漏判 NOT PASS，并回到对应任务最小修复；修复后重新完整审查。

- [ ] **步骤 2：逐任务代码质量审查**

规格 PASS 后检查：路径逃逸/TOCTOU、canonical hash、输入不变性、原子 staging、错误脱敏、伪造 stage、进程生命周期、测试假阳性、无关修改。Critical/Important/Medium 任一未解决不得进入完成状态。

- [ ] **步骤 3：提交后新鲜复验**

从最终 HEAD 重跑任务 5 的完整 Node/Python/静态命令，验证 tracked clean，且 status 只保留任务前既有五类未跟踪目录。

- [ ] **步骤 4：交付边界**

只在全部本地测试与两阶段审查通过后报告“本地双 venv 实现完成”。不得报告官方模型可用、四组件 smoke 成功、整集审核完成或可部署。真实下载必须等待用户新的明确一次性授权。
