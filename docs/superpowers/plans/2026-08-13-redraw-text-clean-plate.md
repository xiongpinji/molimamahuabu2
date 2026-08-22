# 转绘字幕与屏幕文字清除实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在本地为第 4、8 镜建立区分字幕/屏幕文字的 text-clean plate 证据链，并阻止未经审核或类型不匹配的文字净景进入重绘引用。

**架构：** 新增独立 `redrawTextCleanPlateLocalCaseService`，不改变上一阶段人物 clean-plate 服务；它负责两镜清单、文字区域几何、路径/哈希/图像元数据和质量门禁。新增本地 CLI 生成 fixture、脱敏 manifest 与 contact sheet；现有 `generateCleanPlate` 仅扩展快照模式与文字类型字段，不新增数据库表或迁移。

**技术栈：** Node.js 20、`node:test`、`sharp`、`better-sqlite3`、SHA-256、现有 redraw asset service、PowerShell 本地运行。

---

## 文件清单

- 创建：`backend-node/src/services/redrawTextCleanPlateLocalCaseService.js`——两镜清单、区域几何、文件证据、质量门禁和脱敏 manifest。
- 创建：`backend-node/scripts/run-redraw-text-clean-plate-local-case.js`——fixture、manifest 读取、原子输出和两镜 contact sheet。
- 创建：`backend-node/test/redrawTextCleanPlateLocalCase.test.js`——service 与 CLI 的 TDD 测试。
- 修改：`backend-node/src/services/redrawAssetService.js:848-933`——增加 text-clean plate 快照模式与 `text_kind/text_regions` 白名单字段，默认人物流程不变。
- 修改：`backend-node/test/redrawAssets.test.js:340-465`——验证文字快照、类型绑定和失败时源场景保留。
- 修改：`backend-node/package.json:scripts`——增加 `verify:redraw-text-clean-plate-local`。
- 创建：`docs/superpowers/reports/2026-08-13-redraw-text-clean-plate-local-evidence.md`——脱敏本地验收报告。

不修改生产路由、前端模型目录、数据库迁移、供应商客户端、人物 clean-plate service 或已有报告。

### 任务 1：两镜文字清除 case policy 红灯测试

**文件：** 创建 `backend-node/test/redrawTextCleanPlateLocalCase.test.js`，被测 `backend-node/src/services/redrawTextCleanPlateLocalCaseService.js`。

- [ ] **步骤 1：建立 fixture 与成功断言**

使用 `sharp({ create: { width: 1280, height: 720, channels: 4, background: '#808080' } }).png()` 写入临时 `source.png`、`mask.png`、`text-clean.png`。构造两个唯一条目：第 4 镜 `text_kind='text_subtitle'`，第 8 镜 `text_kind='text_screen'`，各一个合法 polygon，`text_residual=false`。先导入尚不存在的 service，并断言：

```js
const result = await buildTextCleanPlateManifest({ root, entries, now: '2026-08-13T00:00:00.000Z' });
assert.deepEqual(result.shots.map((shot) => shot.shot_id), ['shot-4', 'shot-8']);
assert.equal(result.shots[0].mode, 'text_clean_plate');
assert.equal(result.shots[0].text_kind, 'text_subtitle');
assert.equal(result.shots[1].text_kind, 'text_screen');
assert.equal('ocr_text' in result.shots[0].text_regions[0], false);
assert.equal(result.shots.every((shot) => shot.review.status === 'pending'), true);
assert.equal(result.shots.every((shot) => shot.ready_for_reference === false), true);
assert.equal(JSON.stringify(result).includes(root), false);
```

- [ ] **步骤 2：覆盖 fail-closed 场景**

测试 helper 保持两镜数量不变量，避免假阳性；成功路径逐个比较 source/mask/text-clean 声明哈希与实际 SHA-256。加入：

```js
await assert.rejects(() => buildTextCleanPlateManifest({ root, entries: entries.slice(0, 1) }), { code: 'REDRAW_TEXT_CLEAN_PLATE_SHOTS_INVALID' });
await assert.rejects(() => buildTextCleanPlateManifest({ root, entries: replaceShot(entries, 0, 'shot-5') }), { code: 'REDRAW_TEXT_CLEAN_PLATE_SHOTS_INVALID' });
await assert.rejects(() => buildTextCleanPlateManifest({ root, entries: duplicateShot(entries) }), { code: 'REDRAW_TEXT_CLEAN_PLATE_SHOTS_INVALID' });
await assert.rejects(() => buildTextCleanPlateManifest({ root, entries: invalidRegion(entries, { kind: 'text_screen', points: [[-1, 0], [10, 0], [10, 10]] }) }), { code: 'REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID' });
await assert.rejects(() => buildTextCleanPlateManifest({ root, entries: pathEscape(entries) }), { code: 'REDRAW_TEXT_CLEAN_PLATE_PATH_INVALID' });
await assert.rejects(() => buildTextCleanPlateManifest({ root, entries: hashDrift(entries, 'mask') }), { code: 'REDRAW_TEXT_CLEAN_PLATE_HASH_MISMATCH' });
await assert.rejects(() => buildTextCleanPlateManifest({ root, entries: dimensionDrift(entries, 'clean_plate') }), { code: 'REDRAW_TEXT_CLEAN_PLATE_DIMENSIONS_INVALID' });
await assert.rejects(() => buildTextCleanPlateManifest({ root, entries: qualityFailure(entries, { mask_area_changed: false }) }), { code: 'REDRAW_TEXT_CLEAN_PLATE_QUALITY_FAILED' });
await assert.rejects(() => buildTextCleanPlateManifest({ root, entries: qualityFailure(entries, { non_mask_similarity: 0.969 }) }), { code: 'REDRAW_TEXT_CLEAN_PLATE_QUALITY_FAILED' });
await assert.rejects(() => buildTextCleanPlateManifest({ root, entries: qualityFailure(entries, { text_residual: true }) }), { code: 'REDRAW_TEXT_CLEAN_PLATE_QUALITY_FAILED' });
```

- [ ] **步骤 3：运行红灯并提交测试**

```powershell
Set-Location C:\Users\canqu\Documents\茉莉妈妈2\worktrees\redraw-r12-merge-20260809\backend-node
node --test --test-concurrency=1 test/redrawTextCleanPlateLocalCase.test.js
node --check test/redrawTextCleanPlateLocalCase.test.js
Set-Location ..
git add backend-node/test/redrawTextCleanPlateLocalCase.test.js
git commit -m "test(转绘): 增加文字净景两镜门禁红灯"
```

预期：目标测试因 service 不存在而 `MODULE_NOT_FOUND` 红灯。

### 任务 2：实现文字区域与 text-clean plate case service

**文件：** 创建 `backend-node/src/services/redrawTextCleanPlateLocalCaseService.js`；继续修改 `backend-node/test/redrawTextCleanPlateLocalCase.test.js`。

- [ ] **步骤 1：实现清单、区域和文件证据**

实现固定接口：

```js
const ALLOWED_TEXT_SHOT_IDS = Object.freeze(['shot-4', 'shot-8']);
const TEXT_KINDS = Object.freeze(['text_subtitle', 'text_screen']);
const NON_MASK_SIMILARITY_MIN = 0.97;

async function buildTextCleanPlateManifest({ root, entries, now = new Date().toISOString() }) {
  const normalized = validateTextEntries(entries);
  const shots = [];
  for (const entry of normalized) {
    const source = await readImageEvidence(root, entry.representative_frame, '源帧');
    const mask = await readImageEvidence(root, entry.mask_asset, '文字遮罩');
    const cleanPlate = await readImageEvidence(root, entry.clean_plate, '文字净景');
    assertImageContract(entry.shot_id, source, mask, cleanPlate);
    assertQuality(entry.quality, entry.shot_id);
    shots.push(sanitizeShot(entry, source, mask, cleanPlate));
  }
  return { schema_version: 'redraw-text-clean-plate-local-v1', generated_at: now, shots };
}
```

`validateTextEntries` 要求恰好两镜、固定排序、`text_kind` 属于白名单，且所有 region 的 kind 与条目一致。polygon 至少 3 个点、坐标有限、在 `[0,width]×[0,height]` 内且面积大于 0；不保存 `ocr_text` 或原字幕内容。`readImageEvidence` 拒绝绝对路径、`..`、root 外 realpath 和符号链接逃逸，使用 `sharp.metadata()` 读取格式/尺寸并重算 SHA-256；输出只含相对路径、sha256、width、height、mime_type、bytes。

- [ ] **步骤 2：实现质量、审核与脱敏输出**

```js
function assertQuality(quality = {}, shotId) {
  if (quality.mask_area_changed !== true
    || Number(quality.non_mask_similarity) < NON_MASK_SIMILARITY_MIN
    || quality.text_residual !== false) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_QUALITY_FAILED', `${shotId} 文字净景质量未通过`);
  }
}

function sanitizeShot(entry, source, mask, cleanPlate) {
  return {
    shot_id: entry.shot_id,
    mode: 'text_clean_plate',
    text_kind: entry.text_kind,
    source,
    text_mask: mask,
    text_clean_plate: cleanPlate,
    text_regions: entry.text_regions.map(({ kind, shape, points, source: regionSource }) => ({ kind, shape, points, source: regionSource })),
    quality: { mask_area_changed: entry.quality.mask_area_changed, non_mask_similarity: Number(entry.quality.non_mask_similarity), text_residual: entry.quality.text_residual },
    review: { status: entry.review?.status === 'approved' ? 'approved' : 'pending' },
    ready_for_reference: entry.review?.status === 'approved',
  };
}
```

失败只抛稳定错误，不写 manifest、不改源文件；`approved` 只影响投影 ready 标志，不能绕过质量和文件门禁。

- [ ] **步骤 3：运行绿灯并提交 service**

```powershell
node --test --test-concurrency=1 test/redrawTextCleanPlateLocalCase.test.js
node --check src/services/redrawTextCleanPlateLocalCaseService.js
Set-Location ..
git diff --check
git add backend-node/src/services/redrawTextCleanPlateLocalCaseService.js backend-node/test/redrawTextCleanPlateLocalCase.test.js
git commit -m "feat(转绘): 增加文字净景本地证据策略"
```

预期：目标测试全部通过，结果不含临时根目录、绝对路径、OCR 原文、Key 或 Authorization。

### 任务 3：实现两镜本地 CLI 和 contact sheet

**文件：** 创建 `backend-node/scripts/run-redraw-text-clean-plate-local-case.js`；修改 `backend-node/test/redrawTextCleanPlateLocalCase.test.js`、`backend-node/package.json:scripts`。

- [ ] **步骤 1：先补 CLI 红灯测试**

通过 `main(argv, streams)` 断言 fixture 成功、`REDRAW_TEXT_CLEAN_PLATE_LOCAL_OK`、manifest 与 contact sheet 存在；未知参数、缺两镜、输出路径为普通文件分别返回 `REDRAW_TEXT_CLEAN_PLATE_LOCAL_CLI_INVALID`、service 镜头错误码、`REDRAW_TEXT_CLEAN_PLATE_LOCAL_OUTPUT_INVALID`，且失败不留下 manifest。

- [ ] **步骤 2：实现 fixture、原子 manifest 和 contact sheet**

CLI 仅支持 `--fixture`、`--manifest <path>`、`--output-dir <path>`、`--help`。fixture 在临时 root 生成第 4 镜字幕和第 8 镜屏幕文字的 source/mask/text-clean PNG，质量固定为 `mask_area_changed=true`、`non_mask_similarity=0.98`、`text_residual=false`、review pending。默认输出目录为 `path.join(os.tmpdir(), 'redraw-text-clean-plate-two-shots')`；manifest 输入路径相对自身目录解析；contact sheet 每镜一行、三列、每格 320×180，总尺寸 960×360；图像不含绝对路径或 OCR 原文。临时 root 在 finally 删除，用户 outputDir 不删除。

- [ ] **步骤 3：注册 npm 命令、运行绿灯并提交**

在 `backend-node/package.json` 增加：

```json
"verify:redraw-text-clean-plate-local": "node scripts/run-redraw-text-clean-plate-local-case.js --fixture"
```

```powershell
node --test --test-concurrency=1 test/redrawTextCleanPlateLocalCase.test.js
node scripts/run-redraw-text-clean-plate-local-case.js --fixture --output-dir $env:TEMP\redraw-text-clean-plate-two-shots
npm run verify:redraw-text-clean-plate-local
node --check scripts/run-redraw-text-clean-plate-local-case.js
Set-Location ..
git diff --check
git add -f backend-node/scripts/run-redraw-text-clean-plate-local-case.js
git add backend-node/test/redrawTextCleanPlateLocalCase.test.js backend-node/package.json
git commit -m "feat(转绘): 增加文字净景本地运行器"
```

预期：manifest 含 shot-4/shot-8、两种 `text_kind`、pending/ready=false，contact sheet 可由 sharp 读取为 960×360 JPEG。

### 任务 4：接通现有资产服务的文字快照模式

**文件：** 修改 `backend-node/src/services/redrawAssetService.js:848-933`、`backend-node/test/redrawAssets.test.js:340-465`。

- [ ] **步骤 1：先补 text-clean plate 快照红灯测试**

新增 `generateCleanPlate` 调用并断言：

```js
const result = await generateCleanPlate(ctxWithProvider, sceneAsset, {
  mask_asset_id: 432,
  mode: 'text_clean_plate',
  textKind: 'text_subtitle',
  textRegions: [{ kind: 'text_subtitle', shape: 'polygon', points: [[0, 620], [1280, 620], [1280, 720], [0, 720]], source: 'manual_fixture' }],
});
const snapshot = JSON.parse(result.source_ref_json).snapshot;
assert.equal(snapshot.mode, 'text_clean_plate');
assert.equal(snapshot.text_kind, 'text_subtitle');
assert.equal(snapshot.text_regions[0].kind, 'text_subtitle');
```

加入 `text_screen` 用例，以及未知 kind、region 类型混入、`ocr_text`/绝对路径字段拒绝断言；先运行测试确认当前实现红灯。

- [ ] **步骤 2：实现最小快照白名单与绑定**

在 `generateCleanPlate` 开始处解析并校验：

```js
const mode = String(options.mode || 'clean_plate');
const textKind = mode === 'text_clean_plate' ? String(options.textKind || options.text_kind || '') : null;
if (mode === 'text_clean_plate' && !['text_subtitle', 'text_screen'].includes(textKind)) {
  throw codedError('REDRAW_TEXT_CLEAN_PLATE_KIND_INVALID', '文字净景类型无效');
}
const textRegions = mode === 'text_clean_plate'
  ? sanitizeAndValidateTextRegions(options.textRegions || options.text_regions, textKind, sceneAsset.width, sceneAsset.height)
  : null;
```

`sanitizeAndValidateTextRegions(regions, textKind, width, height)` 必须要求非空数组；每个元素只能包含 `kind`、`shape`、`points`、`source`，拒绝 `ocr_text`、path、url 和未知字段；验证 kind 与 `textKind` 一致、polygon 至少 3 个有限坐标且在边界内，返回只含这四个字段的深拷贝。

将 `snapshot.mode`、`text_kind`、脱敏 `text_regions` 写入现有 `source_ref_json.snapshot`；默认人物流程输出保持兼容，禁止把 `ocr_text`、path、url、provider key 写入快照。

- [ ] **步骤 3：运行联合测试并提交资产服务改动**

```powershell
Set-Location C:\Users\canqu\Documents\茉莉妈妈2\worktrees\redraw-r12-merge-20260809\backend-node
node --test --test-concurrency=1 test/redrawAssets.test.js test/redrawTextCleanPlateLocalCase.test.js test/redrawGeneration.test.js
node --check src/services/redrawAssetService.js
Set-Location ..
git diff --check
git add backend-node/src/services/redrawAssetService.js backend-node/test/redrawAssets.test.js
git commit -m "feat(转绘): 固化文字净景资产快照"
```

预期：目标测试全通过；人物 clean plate 不回归；text-clean plate 失败仍保留源场景、`clean_plate_asset_id` 为空、`approval_status='pending'`。

### 任务 5：运行两镜验收并写报告

**文件：** 创建 `docs/superpowers/reports/2026-08-13-redraw-text-clean-plate-local-evidence.md`；不提交 `$env:TEMP\redraw-text-clean-plate-two-shots\*` 运行产物。

- [ ] **步骤 1：执行 fixture 与目标测试**

```powershell
Set-Location C:\Users\canqu\Documents\茉莉妈妈2\worktrees\redraw-r12-merge-20260809\backend-node
node scripts/run-redraw-text-clean-plate-local-case.js --fixture --output-dir $env:TEMP\redraw-text-clean-plate-two-shots
node --test --test-concurrency=1 test/redrawAssets.test.js test/redrawTextCleanPlateLocalCase.test.js test/redrawGeneration.test.js
```

预期：fixture exit 0、输出 `REDRAW_TEXT_CLEAN_PLATE_LOCAL_OK`；manifest 含 shot-4/shot-8、两种文字类型、source/text-mask/text-clean 可读、review pending、ready=false；联合测试记录原始 pass/fail/skipped 统计。

- [ ] **步骤 2：编写脱敏报告**

报告记录分支、生成前证据提交短 SHA、实际 `backend-node` cwd、命令、两镜逐项 `source → text_mask → text_clean_plate → review → reference_gate` 状态、manifest/contact sheet 文件名、测试统计和 local-only 声明；明确“静态两镜文字清除本地合同通过”与“不代表整段视频已完成文字清除”。禁止绝对路径、OCR 原文、Authorization、API Key、真实付费金额。

- [ ] **步骤 3：最终审计并提交报告**

```powershell
Set-Location C:\Users\canqu\Documents\茉莉妈妈2\worktrees\redraw-r12-merge-20260809
git diff --check
git status --short --branch
git add docs/superpowers/reports/2026-08-13-redraw-text-clean-plate-local-evidence.md
git commit -m "test(转绘): 记录两镜文字净景本地验收证据"
```

预期：工作树只保留任务前 `.superpowers/`、`frontweb/output/` 和三个 `__pycache__` 未跟踪项；无 SSH、部署、生产 DB、activate、供应商或付费调用。

## 规格覆盖自检

- 字幕与屏幕文字分型：任务 1、2、3、4 的 `text_kind` 与 region 一致性覆盖。
- 第 4/8 镜固定范围：任务 1 service policy 和任务 3 fixture 覆盖。
- 区域几何、路径、哈希、尺寸/MIME：任务 1–2 覆盖。
- 质量 `mask_area_changed`、0.97 相似度、`text_residual=false`：任务 1–2 覆盖。
- 资产快照模式、源场景保留、审核/引用门禁：任务 4 覆盖。
- manifest、contact sheet、脱敏和报告边界：任务 3、5 覆盖。
- 跨帧跟踪、视频级 inpainting、音频与身份包均明确不在范围：任务 5 报告声明覆盖。

## 交付方式

计划文件保存后，执行阶段有两种方式：

1. **子代理驱动（推荐）**：每个任务分派一个新子代理，任务间进行规格与质量审查。
2. **内联执行**：在当前会话使用 `executing-plans` 按任务执行并设置检查点。
