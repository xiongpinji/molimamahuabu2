# 转绘四镜人物去人净景实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在本地为第 1、6、7、8 镜建立可重复、无供应商调用的 clean-plate 证据链，并阻止未经审核的净景进入重绘参考。

**架构：** 保留现有 `redrawAssetService.generateCleanPlate` 作为资产生成与数据库门禁；新增一个纯本地 case service，负责四镜清单、路径/哈希/尺寸/质量校验和脱敏 manifest；新增 CLI 负责读取本地文件、生成四镜对照图和 JSON manifest。CLI 不创建 provider、不读取 Key、不发网络请求。

**技术栈：** Node.js 20、`node:test`、`better-sqlite3`、现有迁移、`sharp`（图片元数据与对照图）、SHA-256、PowerShell 本地运行。

---

## 文件清单

- 创建：`backend-node/src/services/redrawCleanPlateLocalCaseService.js`——四镜清单策略、受控路径解析、SHA-256/图片元数据读取、质量门禁和脱敏 manifest。
- 创建：`backend-node/scripts/run-redraw-clean-plate-local-case.js`——CLI 参数解析、fixture 生成、调用 case service、写出 JSON manifest 与 contact sheet；只允许本地文件。
- 创建：`backend-node/test/redrawCleanPlateLocalCase.test.js`——case service 与 CLI 的红灯/绿灯测试。
- 修改：`backend-node/test/redrawAssets.test.js`——验证现有 `generateCleanPlate` 在本阶段所需的快照字段、源场景保留和审核状态。
- 修改：`backend-node/package.json`——增加 `verify:redraw-clean-plate-local`，固定为 fixture dry-run。
- 创建：`docs/superpowers/reports/2026-08-13-redraw-clean-plate-four-shots-local-evidence.md`——记录四镜本地运行结果与证据边界，不保存绝对路径或密钥。

不修改生产路由、前端模型目录、数据库迁移或供应商客户端。

### 任务 1：先写四镜 case policy 的失败测试

**文件：**
- 创建：`backend-node/test/redrawCleanPlateLocalCase.test.js`
- 被测：`backend-node/src/services/redrawCleanPlateLocalCaseService.js`

- [ ] **步骤 1：添加可重复 fixture 与失败断言**

在测试中用 `sharp({ create: { width: 1280, height: 720, channels: 4, background: '#808080' } }).png()` 写入临时 `source.png`、`mask.png`、`clean.png`；每个 shot 使用独立目录，manifest 只保存相对路径。先导入尚不存在的 `buildLocalCleanPlateManifest`，并加入以下断言：

```js
const result = await buildLocalCleanPlateManifest({ root, entries, now: '2026-08-13T00:00:00.000Z' });
assert.deepEqual(result.shots.map((shot) => shot.shot_id), ['shot-1', 'shot-6', 'shot-7', 'shot-8']);
assert.match(result.shots[0].source.sha256, /^[a-f0-9]{64}$/);
assert.equal(JSON.stringify(result).includes(root), false);
```

- [ ] **步骤 2：覆盖所有 fail-closed 输入**

为同一测试文件加入独立 `assert.rejects` 用例：

```js
await assert.rejects(() => buildLocalCleanPlateManifest({ root, entries: entries.slice(0, 3) }), { code: 'REDRAW_CLEAN_PLATE_SHOTS_INVALID' });
await assert.rejects(() => buildLocalCleanPlateManifest({ root, entries: duplicateShotEntries }), { code: 'REDRAW_CLEAN_PLATE_SHOTS_INVALID' });
await assert.rejects(() => buildLocalCleanPlateManifest({ root, entries: escapePathEntries }), { code: 'REDRAW_CLEAN_PLATE_PATH_INVALID' });
await assert.rejects(() => buildLocalCleanPlateManifest({ root, entries: wrongHashEntries }), { code: 'REDRAW_CLEAN_PLATE_HASH_MISMATCH' });
await assert.rejects(() => buildLocalCleanPlateManifest({ root, entries: wrongSizeEntries }), { code: 'REDRAW_CLEAN_PLATE_DIMENSIONS_INVALID' });
await assert.rejects(() => buildLocalCleanPlateManifest({ root, entries: lowQualityEntries }), { code: 'REDRAW_CLEAN_PLATE_QUALITY_FAILED' });
```

- [ ] **步骤 3：运行红灯测试**

运行：

```powershell
cd C:\Users\canqu\Documents\茉莉妈妈2\worktrees\redraw-r12-merge-20260809\backend-node
node --test --test-concurrency=1 test/redrawCleanPlateLocalCase.test.js
```

预期：FAIL，错误为 `Cannot find module '../src/services/redrawCleanPlateLocalCaseService'` 或导出函数缺失；此时不修改生产代码。

- [ ] **步骤 4：Commit 测试红灯快照**

```powershell
git add backend-node/test/redrawCleanPlateLocalCase.test.js
git commit -m "test(转绘): 增加四镜净景本地门禁红灯"
```

### 任务 2：实现 case service 的最小策略

**文件：**
- 创建：`backend-node/src/services/redrawCleanPlateLocalCaseService.js`
- 测试：`backend-node/test/redrawCleanPlateLocalCase.test.js`

- [ ] **步骤 1：实现受控路径和文件证据函数**

实现以下固定接口，不引入全局配置或网络依赖：

```js
const ALLOWED_SHOT_IDS = Object.freeze(['shot-1', 'shot-6', 'shot-7', 'shot-8']);
const NON_MASK_SIMILARITY_MIN = 0.97;

async function buildLocalCleanPlateManifest({ root, entries, now = new Date().toISOString() }) {
  const normalized = validateEntries(entries);
  const shots = [];
  for (const entry of normalized) {
    const source = await readImageEvidence(root, entry.representative_frame.path, entry.representative_frame.sha256);
    const mask = await readImageEvidence(root, entry.mask.path, entry.mask.sha256);
    const cleanPlate = await readImageEvidence(root, entry.clean_plate.path, entry.clean_plate.sha256);
    assertSameDimensions(source, mask, cleanPlate);
    assertQuality(entry.quality);
    shots.push({ shot_id: entry.shot_id, source, mask, clean_plate: cleanPlate, quality: entry.quality, review: entry.review });
  }
  return { schema_version: 'redraw-clean-plate-local-v1', generated_at: now, shots };
}
```

`readImageEvidence` 必须拒绝绝对路径、`..`、根目录外 realpath 和符号链接逃逸；输出只保留相对路径、sha256、width、height、mime_type、bytes。`validateEntries` 必须要求四个且仅四个允许镜头、不可重复，并要求每项 `review.status` 为 `approved` 才能设置 `ready_for_reference=true`。

- [ ] **步骤 2：实现质量与脱敏规则**

```js
function assertQuality(quality = {}) {
  if (quality.mask_area_changed !== true || Number(quality.non_mask_similarity) < NON_MASK_SIMILARITY_MIN) {
    throw codedError('REDRAW_CLEAN_PLATE_QUALITY_FAILED', '四镜净景质量未达到 0.97 门禁');
  }
}

function sanitizeShot(shot) {
  return {
    shot_id: shot.shot_id,
    source: sanitizeFile(shot.source),
    mask: sanitizeFile(shot.mask),
    clean_plate: sanitizeFile(shot.clean_plate),
    quality: { ...shot.quality },
    review: { status: shot.review.status },
    ready_for_reference: shot.review.status === 'approved',
  };
}
```

异常必须带稳定错误码；失败不得写出部分 manifest。源文件只读，clean plate 作为独立文件，不覆盖源场景。

- [ ] **步骤 3：运行绿灯并提交 service**

运行：

```powershell
node --test --test-concurrency=1 test/redrawCleanPlateLocalCase.test.js
```

预期：该文件全部 PASS，且序列化结果不包含临时根目录、Windows 绝对路径或 Key 字段。

```powershell
git add backend-node/src/services/redrawCleanPlateLocalCaseService.js backend-node/test/redrawCleanPlateLocalCase.test.js
git commit -m "feat(转绘): 增加四镜净景本地证据策略"
```

### 任务 3：实现本地 CLI 和对照图输出

**文件：**
- 创建：`backend-node/scripts/run-redraw-clean-plate-local-case.js`
- 测试：`backend-node/test/redrawCleanPlateLocalCase.test.js`

- [ ] **步骤 1：先补 CLI 红灯测试**

通过 `main(argv, streams)` 调用 CLI，断言 fixture dry-run 不加载 `https` 模块、不读取环境 Key，并写出两个文件：

```js
const exitCode = await main(['--fixture', '--output-dir', outputDir], { stdout, stderr });
assert.equal(exitCode, 0);
assert.ok(fs.existsSync(path.join(outputDir, 'redraw-clean-plate-local-manifest.json')));
assert.ok(fs.existsSync(path.join(outputDir, 'redraw-clean-plate-contact-sheet.jpg')));
```

同时断言未知参数、缺少四镜和输出目录不可写分别返回非零码及稳定错误码。

- [ ] **步骤 2：实现 CLI fixture 与输出**

CLI 只支持 `--fixture`、`--manifest <path>`、`--output-dir <path>`、`--help`。`--fixture` 在临时受控目录生成四镜源/遮罩/净景 PNG 和固定质量元数据；`--manifest` 路径相对其自身目录解析。调用 `buildLocalCleanPlateManifest` 后原子写入脱敏 JSON。

对照图使用已安装的 `sharp`，每镜按 source/mask/clean_plate 横向排列，统一缩放到 320×180；不在图上写入本机路径。所有临时文件在进程结束后删除，用户指定的输出目录不删除。

- [ ] **步骤 3：注册本地 fixture 命令、运行 CLI 绿灯并提交**

在 `backend-node/package.json` 的 `scripts` 中加入：

```json
"verify:redraw-clean-plate-local": "node scripts/run-redraw-clean-plate-local-case.js --fixture"
```

fixture 模式的默认输出目录固定为 `path.join(os.tmpdir(), 'redraw-clean-plate-four-shots')`，因此 npm 命令不会在仓库内生成媒体或报告。

运行：

```powershell
node --test --test-concurrency=1 test/redrawCleanPlateLocalCase.test.js
node scripts/run-redraw-clean-plate-local-case.js --fixture --output-dir $env:TEMP\redraw-clean-plate-four-shots
```

预期：测试 PASS；CLI 输出 `REDRAW_CLEAN_PLATE_LOCAL_OK`，manifest 含 4 个镜头且 contact sheet 可被 `sharp(...).metadata()` 读取。

```powershell
git add backend-node/scripts/run-redraw-clean-plate-local-case.js backend-node/test/redrawCleanPlateLocalCase.test.js backend-node/package.json
git commit -m "feat(转绘): 增加四镜净景本地运行器"
```

### 任务 4：把现有资产服务证据接入本地验收测试

**文件：**
- 修改：`backend-node/test/redrawAssets.test.js`

- [ ] **步骤 1：补充生成快照断言并先运行红灯**

在现有“去人净景使用人物遮罩并保留源场景版本”测试中增加：

```js
const snapshot = JSON.parse(result.source_ref_json).snapshot;
assert.equal(snapshot.mode, 'clean_plate');
assert.equal(snapshot.source_asset_id, 401);
assert.equal(snapshot.mask_asset_id, 402);
assert.equal(snapshot.input_frame_fingerprint, 'frame-1');
assert.equal(snapshot.model, 'redraw-clean-plate');
assert.equal(result.approval_status, 'pending');
```

增加失败后源资产路径仍为 `scene.png`、`clean_plate_asset_id` 为空、引用门禁不开放的断言；先运行该测试确认现有实现是否满足合同。

- [ ] **步骤 2：只在失败时做最小修复**

若断言失败，仅修改 `backend-node/src/services/redrawAssetService.js` 中对应快照或失败结算逻辑；不得改迁移、路由或供应商适配器。修复必须保持失败时源场景不变、资产状态为 `failed`、本地 fixture 不扣费。

- [ ] **步骤 3：运行目标联合测试并提交**

```powershell
node --test --test-concurrency=1 test/redrawAssets.test.js test/redrawCleanPlateLocalCase.test.js test/redrawGeneration.test.js
node --check src/services/redrawAssetService.js scripts/run-redraw-clean-plate-local-case.js
git diff --check
```

预期：目标测试全部 PASS；若 `redrawGeneration.test.js` 中已有不相关失败，单独记录其原始错误，不扩大本次修复范围。

```powershell
git add backend-node/test/redrawAssets.test.js backend-node/src/services/redrawAssetService.js
git commit -m "test(转绘): 固化净景快照与源场景保留证据"
```

### 任务 5：运行本地四镜验收并写报告

**文件：**
- 创建：`docs/superpowers/reports/2026-08-13-redraw-clean-plate-four-shots-local-evidence.md`
- 不提交：`$env:TEMP\redraw-clean-plate-four-shots\*` 运行产物

- [ ] **步骤 1：执行 fixture dry-run**

```powershell
cd C:\Users\canqu\Documents\茉莉妈妈2\worktrees\redraw-r12-merge-20260809\backend-node
node scripts/run-redraw-clean-plate-local-case.js --fixture --output-dir $env:TEMP\redraw-clean-plate-four-shots
```

预期：退出码 0；manifest 中四镜均有 source/mask/clean_plate 的相对路径、SHA-256、尺寸、mime 和 `ready_for_reference=false`（fixture 审核状态为 pending）。

- [ ] **步骤 2：编写脱敏证据报告**

报告固定记录：分支/HEAD、运行命令、四镜逐项状态、失败场景测试数量、manifest/contact sheet 文件名、未调用供应商/未读 Key/未部署声明；禁止写入绝对路径、Authorization、API Key 和真实付费金额。明确结论为“静态四镜 clean plate 本地合同通过”，不写“整段视频已完成去人”。

- [ ] **步骤 3：最终审计并提交报告**

```powershell
node --test --test-concurrency=1 test/redrawAssets.test.js test/redrawCleanPlateLocalCase.test.js test/redrawGeneration.test.js
git diff --check
git status --short --branch
git add ..\docs\superpowers\reports\2026-08-13-redraw-clean-plate-four-shots-local-evidence.md
git commit -m "test(转绘): 记录四镜净景本地验收证据"
```

预期：工作树只保留任务前的 `.superpowers/`、`frontweb/output/` 和三个 `__pycache__` 未跟踪项；没有 SSH、部署、生产 DB 写入、activate 或付费调用。

## 规格覆盖自检

- 人物去除而非文字清除：背景与非目标范围已在任务 5 报告中明确。
- 四镜范围 1/6/7/8：任务 1 的固定 `ALLOWED_SHOT_IDS` 和任务 3 的 fixture dry-run 覆盖。
- 源帧/遮罩/clean plate 指纹、尺寸和路径安全：任务 1–2 覆盖。
- 质量阈值 0.97、人工审核和 fail-closed 引用：任务 2、4 覆盖。
- 源场景保留、失败结算和无供应商调用：任务 4、5 覆盖。
- JSON manifest、contact sheet 和脱敏报告：任务 3、5 覆盖。
- 未新增数据库表、生产路由或模型目录：文件清单与每项提交范围已锁定。

## 交付方式

计划文件保存后，执行阶段有两种方式：

1. **子代理驱动（推荐）**：每个任务分派一个新子代理，任务间进行测试与审查。
2. **内联执行**：在当前会话使用 `executing-plans`，按任务批次执行并设置检查点。
