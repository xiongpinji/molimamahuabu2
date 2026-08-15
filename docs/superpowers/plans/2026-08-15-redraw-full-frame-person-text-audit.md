# 整集全帧人物与文字区域审核实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在本地对已锁定整集源片的全部帧建立人物与文字覆盖证据，经过 `analyze → 人工审核 → finalize` 两阶段后输出 reviewed、approval pending、ready false 的脱敏审核结果。

**架构：** Node.js 负责源媒体门禁、全帧清单、证据验证、原子目录发布和离线审核产物；隔离 Python worker 负责 YOLOX、ByteTrack、MediaPipe 和 PaddleOCR 本地候选检测。检测结果只形成 generated 草稿，独立 review decisions 绑定草稿规范哈希后，finalize 才能生成 reviewed 证据。

**技术栈：** Node.js 20、`node:test`、FFmpeg/FFprobe、Sharp、Python 3 隔离虚拟环境、YOLOX、ByteTrack、MediaPipe、PaddleOCR、JSON/JSONL、SHA-256。

---

## 文件结构

### 新增文件

- `backend-node/config/redraw-full-frame-model-sources.json`：固定允许的官方模型/代码来源和许可证证据入口。
- `backend-node/src/services/redrawFullFrameModelLockService.js`：模型锁 schema、规范化、哈希和本地模型文件复核。
- `backend-node/test/redrawFullFrameModelLock.test.js`：模型来源、锁文件、路径、哈希和脱敏错误测试。
- `backend-node/src/services/redrawFullFrameCoverageService.js`：generated 全帧证据的纯验证与规范化服务。
- `backend-node/test/redrawFullFrameCoverage.test.js`：连续帧、人物/文字轨迹、遮罩、路径和规范哈希测试。
- `workers/redraw-full-frame-auditor/pyproject.toml`：隔离 worker 包定义。
- `workers/redraw-full-frame-auditor/.gitignore`：排除该 worker 的虚拟环境、Python 字节码和模型缓存。
- `workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/__init__.py`：包入口。
- `workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/worker.py`：bootstrap、JSONL 检测和脱敏输出。
- `workers/redraw-full-frame-auditor/tests/test_worker.py`：使用 fake detector 的标准库单元测试。
- `backend-node/src/services/redrawFullFrameDetectorProcess.js`：受控启动 Python worker、解析 JSONL、超时和错误脱敏。
- `backend-node/test/redrawFullFrameDetectorProcess.test.js`：子进程协议、环境白名单、异常和路径脱敏测试。
- `backend-node/scripts/export-redraw-full-frame-audit-case.js`：从现有前端 fixture 机械导出脱敏 case JSON。
- `backend-node/scripts/run-redraw-full-frame-coverage-local.js`：`analyze` 和 `finalize` 固定 CLI、全帧抽取、产物生成与原子发布。
- `backend-node/test/redrawFullFrameCoverageLocal.test.js`：CLI、合成媒体、generated 草稿、联系表和原子性测试。
- `backend-node/src/services/redrawFullFrameReviewService.js`：review decisions schema、草稿哈希绑定和 reviewed manifest 构建。
- `backend-node/test/redrawFullFrameReview.test.js`：完整审核、缺失决定、未知引用、CAS 漂移和 approval 禁止测试。
- `backend-node/scripts/record-redraw-full-frame-review-local.js`：原子初始化、逐帧记录和查询本地审核决定。
- `docs/superpowers/reports/2026-08-15-redraw-full-frame-person-text-audit-local-evidence.md`：真实源片本地执行的脱敏证据报告。

### 修改文件

- `backend-node/package.json:28`：增加模型 bootstrap、case 导出和全帧审核本地命令。

不修改数据库、路由、生产配置、供应商客户端、计费代码和线上入口。

---

### 任务 1：固化官方来源与模型锁合同

**文件：**

- 创建：`backend-node/config/redraw-full-frame-model-sources.json`
- 创建：`backend-node/src/services/redrawFullFrameModelLockService.js`
- 创建：`backend-node/test/redrawFullFrameModelLock.test.js`

- [ ] **步骤 1：编写模型锁红灯测试**

在测试中使用临时模型文件，覆盖合法锁、反序组件稳定排序、文件 SHA-256 漂移、未知组件、未知字段、非官方来源、缺少许可证证据、绝对/穿越路径、符号链接逃逸，以及序列化错误不泄露临时根目录。

```js
test('模型锁只接受官方来源、真实文件哈希和完整许可证证据', async (t) => {
  const fixture = await createModelFixture(t)
  const result = await validateModelLock({
    cacheRoot: fixture.root,
    sourcePolicy: OFFICIAL_SOURCES,
    lock: fixture.lock,
  })
  assert.deepEqual(result.components.map((entry) => entry.component), [
    'face_detector', 'person_detector', 'text_detector', 'tracker',
  ])
  assert.match(result.canonical_sha256, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(result).includes(fixture.root), false)
})

test('模型字节漂移、来源或许可证不完整时 fail closed', async (t) => {
  const fixture = await createModelFixture(t)
  await fs.promises.appendFile(fixture.personModelPath, 'drift')
  await assert.rejects(
    validateModelLock({ cacheRoot: fixture.root, sourcePolicy: OFFICIAL_SOURCES, lock: fixture.lock }),
    { code: 'REDRAW_FULL_FRAME_MODEL_LOCK_INVALID' },
  )
})
```

- [ ] **步骤 2：运行测试确认红灯**

运行：

```powershell
Push-Location backend-node
node --test --test-concurrency=1 test/redrawFullFrameModelLock.test.js
Pop-Location
```

预期：FAIL，`Cannot find module '../src/services/redrawFullFrameModelLockService'`。

- [ ] **步骤 3：增加官方来源策略**

`redraw-full-frame-model-sources.json` 只允许以下项目，不写用户路径或已下载模型哈希：

```json
{
  "schema_version": "redraw-full-frame-model-sources-v1",
  "sources": [
    {
      "component": "person_detector",
      "project": "YOLOX",
      "repository": "Megvii-BaseDetection/YOLOX",
      "license_path": "LICENSE"
    },
    {
      "component": "tracker",
      "project": "ByteTrack",
      "repository": "FoundationVision/ByteTrack",
      "license_path": "LICENSE"
    },
    {
      "component": "face_detector",
      "project": "MediaPipe face detection",
      "repository": "google-ai-edge/mediapipe",
      "license_path": "LICENSE"
    },
    {
      "component": "text_detector",
      "project": "PaddleOCR",
      "repository": "PaddlePaddle/PaddleOCR",
      "license_path": "LICENSE"
    }
  ]
}
```

- [ ] **步骤 4：实现最小模型锁服务**

导出固定接口：

```js
async function validateModelLock({ cacheRoot, sourcePolicy, lock })
function canonicalizeModelLock(lock)
function canonicalSha256(value)

module.exports = {
  validateModelLock,
  canonicalizeModelLock,
  canonicalSha256,
}
```

实现要求：

- 顶层只允许 `schema_version`、`runtime`、`components`；
- 组件只允许 `component/project/repository/revision/artifact_name/artifact_path/artifact_sha256/license_name/license_evidence_path/license_evidence_sha256`；
- 组件集合必须精确等于 4 个允许组件；
- `revision`、artifact 和 license 字段必须为真实非空值，拒绝 `unknown`、`latest`、示例值和占位值；
- artifact/license 均使用同一文件描述符完成 `open → fstat → read → fstat → close`，重算 SHA-256；
- lexical path、realpath、符号链接和打开前后文件身份均不能逃逸 `cacheRoot`；
- 输出只包含相对 artifact 名、revision、license 名、哈希和规范哈希，不输出本地根目录或底层 cause。

- [ ] **步骤 5：运行模型锁测试并提交**

运行：

```powershell
Push-Location backend-node
node --test --test-concurrency=1 test/redrawFullFrameModelLock.test.js
node --check src/services/redrawFullFrameModelLockService.js
node --check test/redrawFullFrameModelLock.test.js
Pop-Location
git diff --check
```

预期：全部 PASS，`git diff --check` 无输出。

提交：

```powershell
git add backend-node/config/redraw-full-frame-model-sources.json backend-node/src/services/redrawFullFrameModelLockService.js backend-node/test/redrawFullFrameModelLock.test.js
git commit -m "feat(转绘): 固化全帧审核模型锁"
```

---

### 任务 2：实现 generated 全帧证据纯合同

**文件：**

- 创建：`backend-node/src/services/redrawFullFrameCoverageService.js`
- 创建：`backend-node/test/redrawFullFrameCoverage.test.js`

- [ ] **步骤 1：编写连续帧、轨迹和遮罩红灯测试**

测试 fixture 使用 64×96 PNG 和二值 mask，构造 6 帧、2 镜、剧情角色、背景群演、字幕、UI 和模糊文字候选。成功用例断言输入不变、帧连续、稳定排序、所有文件哈希重算、`status=generated`、`approval_status=pending`、`ready_for_reference=false`。

```js
test('反序输入生成稳定的全帧人物文字草稿且不泄露根目录', async (t) => {
  const fixture = await createCoverageFixture(t)
  const result = await buildGeneratedCoverageManifest({
    evidenceRoot: fixture.root,
    source: fixture.source,
    shots: [...fixture.shots].reverse(),
    frames: [...fixture.frames].reverse(),
    personTracks: [...fixture.personTracks].reverse(),
    textTracks: [...fixture.textTracks].reverse(),
    modelLock: fixture.modelLock,
  })
  assert.deepEqual(result.frames.map((entry) => entry.frame_index), [0, 1, 2, 3, 4, 5])
  assert.equal(result.status, 'generated')
  assert.equal(result.approval_status, 'pending')
  assert.equal(result.ready_for_reference, false)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(escapeRegExp(fixture.root), 'i'))
})
```

分别增加失败用例：缺帧、重复帧、时间戳漂移、镜头空洞、人物候选未分类、剧情角色缺映射、背景群演错误绑定固定演员、文字 `unknown`、缺少处置、bbox/polygon 越界或零面积、mask 非二值/尺寸错误/hash 漂移、绝对路径/`..`/符号链接逃逸、候选和区域未知字段。

- [ ] **步骤 2：运行测试确认红灯**

运行：

```powershell
Push-Location backend-node
node --test --test-concurrency=1 test/redrawFullFrameCoverage.test.js
Pop-Location
```

预期：FAIL，`Cannot find module '../src/services/redrawFullFrameCoverageService'`。

- [ ] **步骤 3：实现纯合同服务**

导出：

```js
async function buildGeneratedCoverageManifest(input)
async function validateGeneratedCoverageManifest({ evidenceRoot, manifest })
function canonicalCoverageSha256(manifest)

module.exports = {
  buildGeneratedCoverageManifest,
  validateGeneratedCoverageManifest,
  canonicalCoverageSha256,
}
```

实现顺序固定为：

1. 精确顶层和嵌套白名单；
2. source、9 镜时间窗和模型锁绑定；
3. `frame_index=0..N-1` 与基于 time base 的时间戳验证；
4. 人物/文字候选闭环；
5. 轨迹排序、区间合并和每帧引用验证；
6. mask 受控路径、同一 fd 读取、Sharp 元数据、二值像素、尺寸、边界和 SHA-256；
7. 生成审核点并验证固定点/事件点原因；
8. 白名单投影后计算 `analysis_sha256`。

所有异常使用规格中的稳定 `REDRAW_FULL_FRAME_*` 错误码，不挂载原始 cause。

- [ ] **步骤 4：运行测试并提交**

```powershell
Push-Location backend-node
node --test --test-concurrency=1 test/redrawFullFrameCoverage.test.js test/redrawFullFrameModelLock.test.js
node --check src/services/redrawFullFrameCoverageService.js
node --check test/redrawFullFrameCoverage.test.js
Pop-Location
git diff --check
git add backend-node/src/services/redrawFullFrameCoverageService.js backend-node/test/redrawFullFrameCoverage.test.js
git commit -m "feat(转绘): 增加全帧人物文字证据合同"
```

预期：全部 PASS。

---

### 任务 3：实现隔离本地检测 worker 与模型 bootstrap

**文件：**

- 创建：`workers/redraw-full-frame-auditor/pyproject.toml`
- 创建：`workers/redraw-full-frame-auditor/.gitignore`
- 创建：`workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/__init__.py`
- 创建：`workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/worker.py`
- 创建：`workers/redraw-full-frame-auditor/tests/test_worker.py`
- 创建：`backend-node/src/services/redrawFullFrameDetectorProcess.js`
- 创建：`backend-node/test/redrawFullFrameDetectorProcess.test.js`
- 创建：`backend-node/scripts/fetch-redraw-full-frame-models-local.js`
- 修改：`backend-node/package.json:28`

执行本任务前，调用工作区依赖加载器取得其返回的 bundled Python 可执行文件，并把该值仅写入当前进程的 `REDRAW_AUDITOR_PYTHON` 环境变量。不得把实际绝对路径写入仓库文件、测试快照或日志。

- [ ] **步骤 1：编写 Python worker 红灯测试**

使用 `unittest` 和 fake detector，不要求真实模型：

```python
class WorkerContractTest(unittest.TestCase):
    def test_detect_frame_returns_only_sanitized_regions(self):
        result = detect_frame(
            {"frame_index": 4, "timestamp_ms": 133, "frame_path": "input.png"},
            detectors=FakeDetectors(),
        )
        self.assertEqual(result["frame_index"], 4)
        self.assertEqual(result["persons"][0]["kind"], "person_candidate")
        self.assertEqual(result["texts"][0]["kind"], "text_candidate")
        self.assertNotIn("frame_path", result)
        self.assertNotIn("ocr_text", json.dumps(result))
```

覆盖人物框/人脸框/文字多边形规范化、无 OCR 原文、非有限坐标拒绝、未知 detector 字段拒绝、模型未加载失败、同输入稳定输出。

- [ ] **步骤 2：编写 Node 子进程红灯测试**

用临时 fake worker 脚本验证：

- 只传入 `PATH/SystemRoot/WINDIR/TEMP/TMP/PYTHONUTF8`；
- 不继承 Key、Authorization、供应商变量；
- JSONL 严格一帧一响应且 frame_index 对齐；
- 超时、非零退出、非法 JSON、重复/缺失响应和 stderr 路径均脱敏为 `REDRAW_FULL_FRAME_MODEL_UNAVAILABLE`。

- [ ] **步骤 3：运行红灯**

```powershell
& $env:REDRAW_AUDITOR_PYTHON -m unittest discover -s workers/redraw-full-frame-auditor/tests -v
Push-Location backend-node
node --test --test-concurrency=1 test/redrawFullFrameDetectorProcess.test.js
Pop-Location
```

预期：Python import 和 Node module 均因文件不存在失败。

- [ ] **步骤 4：实现 worker 纯协议**

`pyproject.toml` 只定义本地包和 Python 版本，不把会漂移的视觉依赖写成范围版本；bootstrap 将实际依赖安装到仓库外隔离环境并生成精确 runtime lock：

```toml
[build-system]
requires = ["setuptools==80.9.0"]
build-backend = "setuptools.build_meta"

[project]
name = "redraw-full-frame-auditor"
version = "0.1.0"
requires-python = ">=3.11,<3.12"

[tool.setuptools.packages.find]
where = ["src"]
```

`worker.py` 提供：

```python
def detect_frame(frame, detectors):
    persons = detectors.person.detect(frame["frame_path"])
    faces = detectors.face.detect(frame["frame_path"])
    texts = detectors.text.detect_regions(frame["frame_path"])
    tracked = detectors.tracker.update(frame["frame_index"], persons)
    return sanitize_result(frame["frame_index"], tracked, faces, texts)

def main(argv=None):
    args = parse_args(argv)
    if args.command == "bootstrap":
        return bootstrap_models(args)
    return run_jsonl(args)
```

真实适配器只启用 YOLOX `person` 类、ByteTrack 轨迹、MediaPipe 人脸框和 PaddleOCR text detection。PaddleOCR recognition 不初始化；worker 输出 schema 不存在 OCR 文本字段。

worker 根目录 `.gitignore` 固定为：

```gitignore
.venv/
models/
__pycache__/
*.py[cod]
```

- [ ] **步骤 5：实现模型 bootstrap**

`fetch-redraw-full-frame-models-local.js`：

- 读取任务 1 的官方来源策略；
- 在指定本地 cache root 建立随机 staging 和隔离 `.venv`；
- 从官方仓库/发行源解析实际 revision 和 artifact；
- 下载 license 与模型/代码文件，重算 SHA-256；
- 调用 worker `bootstrap` 执行兼容性探针；
- `pip freeze` 写入本地 runtime lock，并拒绝未固定版本行；
- 生成真实 `model-lock.json` 后调用 `validateModelLock`；
- 完整成功才原子发布 cache；失败只清理内部 staging；
- 不记录或打印用户源片路径。

package scripts 增加：

```json
"fetch:redraw-full-frame-models-local": "node scripts/fetch-redraw-full-frame-models-local.js"
```

- [ ] **步骤 6：实现 Node worker 进程适配器**

```js
async function detectFrames({ pythonPath, workerRoot, modelLockPath, frames, timeoutMs })
function safeWorkerEnv()

module.exports = { detectFrames, safeWorkerEnv }
```

输入 frame_path 只传给本地 worker；返回结果在进入 coverage service 前删除所有路径字段。

- [ ] **步骤 7：运行单元测试、fixture bootstrap 并提交**

```powershell
& $env:REDRAW_AUDITOR_PYTHON -m unittest discover -s workers/redraw-full-frame-auditor/tests -v
Push-Location backend-node
node --test --test-concurrency=1 test/redrawFullFrameDetectorProcess.test.js test/redrawFullFrameModelLock.test.js
node --check src/services/redrawFullFrameDetectorProcess.js
node --check scripts/fetch-redraw-full-frame-models-local.js
Pop-Location
git diff --check
git add workers/redraw-full-frame-auditor/.gitignore workers/redraw-full-frame-auditor/pyproject.toml workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/__init__.py workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/worker.py workers/redraw-full-frame-auditor/tests/test_worker.py backend-node/src/services/redrawFullFrameDetectorProcess.js backend-node/test/redrawFullFrameDetectorProcess.test.js backend-node/package.json
git add -f backend-node/scripts/fetch-redraw-full-frame-models-local.js
git commit -m "feat(转绘): 增加全帧本地检测工作器"
```

预期：fake detector 联合测试全部 PASS；此步骤不要求下载真实模型。

---

### 任务 4：实现 `analyze` 草稿与离线审核产物

**文件：**

- 创建：`backend-node/scripts/export-redraw-full-frame-audit-case.js`
- 创建：`backend-node/scripts/run-redraw-full-frame-coverage-local.js`
- 创建：`backend-node/test/redrawFullFrameCoverageLocal.test.js`
- 修改：`backend-node/package.json:28`

- [ ] **步骤 1：编写 CLI 与 generated 草稿红灯测试**

测试必须覆盖：

- `analyze` 精确参数、`--help`、未知/重复/缺失参数；
- 从前端 fixture 导出的 case 只含源指纹、9 镜时间轴、剧情角色 ID、文字类型和目标处置，不含中文 OCR 原文；
- FFmpeg 合成视频全部帧连续进入 manifest；
- 注入 fake detector 后生成 source/person/text 叠加、9 镜联系表和离线 HTML；
- manifest 固定 `status=generated`、`approval_status=pending`、`ready_for_reference=false`；
- 中途抽帧/检测/Sharp/写文件失败无最终目录；
- 非空输出目录字节不变；
- manifest、HTML 和 stdout 不含源片绝对路径或 Key。

```js
test('analyze 原子发布 generated 草稿和可打开联系表', async (t) => {
  const fixture = await createAnalyzeFixture(t)
  const result = await runAnalyze(fixture.options, { detectFrames: fixture.detectFrames })
  assert.equal(result.manifest.status, 'generated')
  assert.equal(result.manifest.frames.length, result.probe.frame_count)
  assert.equal(result.manifest.approval_status, 'pending')
  assert.equal(result.manifest.ready_for_reference, false)
  assert.equal(result.contact_sheets.length, 9)
  for (const file of result.contact_sheets) await assertReadableImage(file)
})
```

- [ ] **步骤 2：运行测试确认红灯**

```powershell
Push-Location backend-node
node --test --test-concurrency=1 test/redrawFullFrameCoverageLocal.test.js
Pop-Location
```

预期：FAIL，runner 模块不存在。

- [ ] **步骤 3：实现 case 导出器**

使用动态 `import()` 读取 `frontweb/e2e/fixtures/redraw-latin-american-case.js`，只投影：

```js
{
  case_id,
  source,
  target,
  cast: cast.map(({ id, role, age_min }) => ({ id, role, age_min })),
  shots: shots.map(({ id, start_ms, end_ms, speaking_character_ids, text_regions }) => ({
    id, start_ms, end_ms, speaking_character_ids,
    text_regions: text_regions.map(({ region_key, kind, time_ranges }) => ({
      region_key,
      kind,
      time_ranges,
      treatment: kind === 'text_subtitle' ? 'translate_subtitle' : 'localize_screen',
    })),
  })),
}
```

输出只允许写入不存在的本地 JSON 文件，使用临时文件 + rename。

- [ ] **步骤 4：实现 `analyze` runner**

实现顺序：

1. 解析并白名单化 CLI；
2. 复核 source/case/model lock；
3. 创建同父级随机 staging；
4. FFprobe 使用 `-count_frames` 获取实际读帧数与 time base；
5. FFmpeg 抽取全部 PNG 帧；
6. 逐帧重算哈希并构造连续清单；
7. 受控调用 detector process；
8. 将人物框和文字多边形转为保守二值审核 mask；
9. 调用 `buildGeneratedCoverageManifest`；
10. 生成每镜 JPEG 联系表、离线 HTML 和 review-decisions 模板；
11. 完整复核后原子发布 analysis 目录。

导出 `parseArgs`、`runAnalyze`、`runCli` 供测试注入；CLI 本身不暴露依赖注入参数。

- [ ] **步骤 5：添加 package 命令、运行联合测试并提交**

package scripts 增加：

```json
"export:redraw-full-frame-audit-case": "node scripts/export-redraw-full-frame-audit-case.js",
"verify:redraw-full-frame-coverage-local": "node scripts/run-redraw-full-frame-coverage-local.js"
```

运行：

```powershell
Push-Location backend-node
node --test --test-concurrency=1 test/redrawFullFrameCoverageLocal.test.js test/redrawFullFrameCoverage.test.js test/redrawFullFrameDetectorProcess.test.js test/redrawFullFrameModelLock.test.js
node --check scripts/export-redraw-full-frame-audit-case.js
node --check scripts/run-redraw-full-frame-coverage-local.js
Pop-Location
git diff --check
git add backend-node/test/redrawFullFrameCoverageLocal.test.js backend-node/package.json
git add -f backend-node/scripts/export-redraw-full-frame-audit-case.js backend-node/scripts/run-redraw-full-frame-coverage-local.js
git commit -m "feat(转绘): 增加全帧审核草稿运行器"
```

---

### 任务 5：实现 review decisions 与 `finalize`

**文件：**

- 创建：`backend-node/src/services/redrawFullFrameReviewService.js`
- 创建：`backend-node/test/redrawFullFrameReview.test.js`
- 创建：`backend-node/scripts/record-redraw-full-frame-review-local.js`
- 修改：`backend-node/scripts/run-redraw-full-frame-coverage-local.js`
- 修改：`backend-node/test/redrawFullFrameCoverageLocal.test.js`
- 修改：`backend-node/package.json:28`

- [ ] **步骤 1：编写审核决定服务红灯测试**

审核决定固定 schema：

```js
{
  schema_version: 'redraw-full-frame-review-decisions-v1',
  analysis_sha256: generated.analysis_sha256,
  reviewer: 'codex-local-review',
  review_points: generated.review.required_points.map((point) => ({
    frame_index: point.frame_index,
    decision: 'accepted',
    corrections: [],
  })),
}
```

允许 correction action 仅为：

- `add_person_region`；
- `remove_person_candidate`；
- `merge_person_tracks`；
- `split_person_track`；
- `add_text_region`；
- `remove_text_candidate`；
- `change_text_kind`；
- `change_text_treatment`。

测试成功路径和以下失败：草稿哈希漂移、遗漏审核点、重复审核点、未知 frame/track/region、未知 action、修正后 unresolved 非 0、输入 `approved`/`ready`、reviewer 空值、绝对路径/OCR/Key 字段、finalize 后草稿目录字节变化。

- [ ] **步骤 2：运行服务红灯**

```powershell
Push-Location backend-node
node --test --test-concurrency=1 test/redrawFullFrameReview.test.js
Pop-Location
```

预期：FAIL，review service 模块不存在。

- [ ] **步骤 3：实现审核决定服务**

导出：

```js
async function finalizeReviewedCoverage({ analysisRoot, decisions, outputRoot })
function normalizeReviewDecisions({ generatedManifest, decisions })
function applyCorrections({ generatedManifest, normalizedDecisions })

module.exports = {
  finalizeReviewedCoverage,
  normalizeReviewDecisions,
  applyCorrections,
}
```

`finalizeReviewedCoverage` 必须：

- 从 analysisRoot 重读 generated manifest 和全部引用文件；
- 重算 `analysis_sha256` 并与 decisions 绑定；
- 应用白名单 corrections 后重新运行完整 coverage validator；
- 要求全部 required review points 恰好一次 accepted/corrected；
- 要求 person/text unresolved 均为 0；
- 输出 reviewed manifest、修正摘要和新的联系表；
- 固定 `approval_status=pending`、`ready_for_reference=false`；
- 不修改 analysisRoot。

- [ ] **步骤 4：编写并实现 CLI finalize 红绿测试**

先在 `redrawFullFrameCoverageLocal.test.js` 增加 `finalize` 红灯：合法决定成功、缺失决定失败、analysis 漂移失败、两个输出目录独立、草稿所有文件哈希 finalize 前后不变、目标非空不覆盖、中途失败无 reviewed manifest。

实现 `parseFinalizeArgs` 和 `runFinalize`，只接受：

```text
finalize --analysis-dir --review-decisions --output-dir
```

拒绝 `--source`、`--case`、`--model-lock`、`--approved` 和未知参数。

- [ ] **步骤 5：实现审核决定 recorder**

`record-redraw-full-frame-review-local.js` 只支持：

```text
init --analysis-dir --output
decide --decisions --frame-index --decision accepted|corrected [--correction-json]
show-pending --decisions
```

要求：

- `init` 从 generated manifest 的 required review points 生成全部 `pending` 决定并绑定 `analysis_sha256`；
- `decide` 只修改一个已存在 frame_index，使用临时文件 + rename 原子写；
- `accepted` 禁止 correction，`corrected` 至少需要一个白名单 correction；
- correction JSON 拒绝路径、OCR、Key、URL、approved 和未知字段；
- `show-pending` 只输出剩余 frame_index 与原因，不输出源帧路径；
- decisions 文件不存在、hash 漂移或目标为符号链接时 fail closed。

package scripts 增加：

```json
"review:redraw-full-frame-coverage-local": "node scripts/record-redraw-full-frame-review-local.js"
```

- [ ] **步骤 6：运行联合测试并提交**

```powershell
Push-Location backend-node
node --test --test-concurrency=1 test/redrawFullFrameReview.test.js test/redrawFullFrameCoverageLocal.test.js test/redrawFullFrameCoverage.test.js test/redrawFullFrameDetectorProcess.test.js test/redrawFullFrameModelLock.test.js
node --check src/services/redrawFullFrameReviewService.js
node --check scripts/run-redraw-full-frame-coverage-local.js
node --check scripts/record-redraw-full-frame-review-local.js
Pop-Location
git diff --check
git add backend-node/src/services/redrawFullFrameReviewService.js backend-node/test/redrawFullFrameReview.test.js backend-node/scripts/run-redraw-full-frame-coverage-local.js backend-node/test/redrawFullFrameCoverageLocal.test.js backend-node/package.json
git add -f backend-node/scripts/record-redraw-full-frame-review-local.js
git commit -m "feat(转绘): 完成全帧审核证据定稿"
```

---

### 任务 6：真实源片本地审核、联合回归与脱敏报告

**文件：**

- 创建：`docs/superpowers/reports/2026-08-15-redraw-full-frame-person-text-audit-local-evidence.md`

本任务允许执行已批准的开源模型下载和真实源片本地读取，但仍禁止源片上传、供应商调用、付费、数据库写入、SSH、部署和 push。

- [ ] **步骤 1：提交前门禁**

从仓库根运行：

```powershell
git status --short
git rev-parse HEAD
(Get-FileHash -Algorithm SHA256 $env:REDRAW_FULL_FRAME_SOURCE).Hash.ToLowerInvariant()
```

`REDRAW_FULL_FRAME_SOURCE` 由执行环境从已授权本地源片设置，不能在命令日志、计划或报告中展开。预期 SHA-256 必须与 fixture 的 `24eb1d8ba3ff11e6aa3e547b7ac400f6b177dcf541d1af36354d3e46cc05e9ae` 相同；否则停止。

- [ ] **步骤 2：获取并锁定开源本地模型**

创建仓库外本地缓存目录并运行：

```powershell
$env:REDRAW_FULL_FRAME_MODEL_CACHE = Join-Path ([IO.Path]::GetTempPath()) ('redraw-full-frame-models-' + [guid]::NewGuid())
npm --prefix backend-node run fetch:redraw-full-frame-models-local -- --output-dir $env:REDRAW_FULL_FRAME_MODEL_CACHE
```

成功后必须：

- `model-lock.json` 通过任务 1 validator；
- 4 个组件 revision、artifact SHA-256 和 license SHA-256 均为真实值；
- Python runtime lock 每个依赖均固定版本；
- 运行一次单帧 person/face/text/tracker 真实 smoke，不能 skip；
- 下载日志不含源片路径或任何 Key。

未知许可证、官方来源不可读、模型加载失败或哈希漂移时停止，不换非官方镜像。

- [ ] **步骤 3：导出脱敏 case 并执行 analyze**

```powershell
$env:REDRAW_FULL_FRAME_RUN_ROOT = Join-Path ([IO.Path]::GetTempPath()) ('redraw-full-frame-run-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $env:REDRAW_FULL_FRAME_RUN_ROOT | Out-Null
$env:REDRAW_FULL_FRAME_CASE = Join-Path $env:REDRAW_FULL_FRAME_RUN_ROOT 'case.json'
$env:REDRAW_FULL_FRAME_ANALYSIS = Join-Path $env:REDRAW_FULL_FRAME_RUN_ROOT 'analysis'
node backend-node/scripts/export-redraw-full-frame-audit-case.js --output $env:REDRAW_FULL_FRAME_CASE
node backend-node/scripts/run-redraw-full-frame-coverage-local.js analyze --source $env:REDRAW_FULL_FRAME_SOURCE --case $env:REDRAW_FULL_FRAME_CASE --model-lock (Join-Path $env:REDRAW_FULL_FRAME_MODEL_CACHE 'model-lock.json') --output-dir $env:REDRAW_FULL_FRAME_ANALYSIS
```

预期：`REDRAW_FULL_FRAME_ANALYZE_OK`，generated manifest、9 镜联系表、离线 HTML 和 review decisions 模板均存在；实际帧数由 FFprobe 输出，不以计划估算值替代。

- [ ] **步骤 4：人工审核全部固定点和事件点**

先初始化独立 decisions 文件：

```powershell
$env:REDRAW_FULL_FRAME_DECISIONS = Join-Path $env:REDRAW_FULL_FRAME_RUN_ROOT 'review-decisions.json'
node backend-node/scripts/record-redraw-full-frame-review-local.js init --analysis-dir $env:REDRAW_FULL_FRAME_ANALYSIS --output $env:REDRAW_FULL_FRAME_DECISIONS
node backend-node/scripts/record-redraw-full-frame-review-local.js show-pending --decisions $env:REDRAW_FULL_FRAME_DECISIONS
```

逐一打开 9 张联系表和离线 HTML：

- 核对每镜首尾和每 1 秒固定点；
- 核对所有人物/文字出现消失、遮挡、轨迹切换和面积突变点；
- 将漏检、误检、合并、拆分和类型/处置修正写入本地 `review-decisions.json`；
- 不把 OCR 原文、人物姓名猜测或绝对路径写入 decisions；
- decisions reviewer 固定为 `codex-local-review`；
- 未能确定的区域保持 unresolved 并停止 finalize，不得猜测填平。

每审核一个 frame_index，使用 recorder 写入 `accepted`；需要修正时使用 `corrected --correction-json`，correction 内容必须采用任务 5 的白名单 action。每批审核后运行 `show-pending`，直到输出稳定的 `pending_count=0`。

- [ ] **步骤 5：执行 finalize 并复核草稿不变**

先记录 analysis 目录所有文件的相对路径和 SHA-256 清单，再运行：

```powershell
$env:REDRAW_FULL_FRAME_REVIEWED = Join-Path $env:REDRAW_FULL_FRAME_RUN_ROOT 'reviewed'
node backend-node/scripts/run-redraw-full-frame-coverage-local.js finalize --analysis-dir $env:REDRAW_FULL_FRAME_ANALYSIS --review-decisions $env:REDRAW_FULL_FRAME_DECISIONS --output-dir $env:REDRAW_FULL_FRAME_REVIEWED
```

预期：`REDRAW_FULL_FRAME_FINALIZE_OK`。再次计算 analysis 清单并逐项比较，必须完全相同。reviewed manifest 必须为：

```json
{
  "reviewed": true,
  "approval_status": "pending",
  "ready_for_reference": false
}
```

- [ ] **步骤 6：运行同轮联合回归**

```powershell
$env:REQUIRE_LOCAL_FFMPEG = '1'
Push-Location backend-node
node --test --test-concurrency=1 test/redrawFullFrameModelLock.test.js test/redrawFullFrameDetectorProcess.test.js test/redrawFullFrameCoverage.test.js test/redrawFullFrameReview.test.js test/redrawFullFrameCoverageLocal.test.js test/redrawReferenceBundle.test.js test/redrawRoutes.test.js test/redrawGeneration.test.js test/redrawFullEpisodeReferenceLocal.test.js
Pop-Location
node --test frontweb/test/redrawLatinAmericanCase.test.js frontweb/test/redrawShots.test.js frontweb/test/redrawAssets.test.js frontweb/test/redrawFoundation.test.js
npm --prefix frontweb run build
git diff --check
```

预期：0 fail；真实 FFmpeg 和真实本地模型 smoke 均不允许 skip。前端 build 可以保留现有 chunk-size warning，但必须 exit 0。

- [ ] **步骤 7：写脱敏报告**

报告只记录：

- 代码 HEAD、源 SHA-256 和脱敏媒体摘要；
- 实际帧数、9 镜连续覆盖结果；
- 每镜人物轨迹数、背景群演轨迹数、文字区域数、审核点数和人工修正数；
- person/text unresolved 均为 0；
- analysis/reviewed manifest、9 镜联系表和离线 HTML 的文件名与 SHA-256；
- analysis 在 finalize 前后字节不变；
- 测试、build、语法和 diff-check 计数；
- reviewed/pending/ready=false；
- 未上传源片、未调用供应商、未付费、未部署声明；
- 明确不代表净景、演员替换、英文字幕重绘或整集视频已经完成。

报告不得包含源片路径、模型缓存路径、联系表图片、OCR 原文、Key、Authorization 或供应商 URL。

- [ ] **步骤 8：提交报告并做最终审查**

```powershell
git add docs/superpowers/reports/2026-08-15-redraw-full-frame-person-text-audit-local-evidence.md
git commit -m "docs(转绘): 记录全帧人物文字审核证据"
git diff HEAD^ HEAD --check
git status --short
```

要求：提交只包含报告；工作树只保留任务开始前已有的 `.superpowers/`、`frontweb/output/` 和 3 个 `__pycache__/` 未跟踪目录。随后对全部实现提交执行一次独立最终代码审查，Critical/Important 必须为 0。

---

## 完成标准

只有同时满足以下条件，才能宣布本计划完成：

1. 6 个任务分别完成 TDD 红灯、绿灯、规格审查和代码质量审查；
2. 模型来源、revision、artifact/license SHA-256 和隔离 runtime 已真实锁定；
3. 真实源片全部帧进入 generated 草稿；
4. 全部固定点和事件点已人工审核，person/text unresolved 均为 0；
5. finalize 绑定同一 `analysis_sha256`，且不修改草稿目录；
6. 9 镜联系表与离线 HTML 可打开；
7. reviewed manifest 固定 pending/ready=false；
8. 后端联合测试、前端测试、真实 FFmpeg、本地模型 smoke、build 和 diff-check 同轮通过；
9. 脱敏报告无源图、原文字、绝对路径、Key 或供应商 URL；
10. 未进行供应商调用、付费、数据库写入、SSH、部署或 push。
