# 一键转绘阶段 1：基础、上传与源片分析实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 交付可用的转绘项目/作品入口、受控源片上传、已验证风格与语言能力目录、持久化源片分析任务以及四步工作台第一步。

**架构：** 一次迁移建立完整转绘领域表，阶段 1 仅开放项目、作品、目录和分析接口。上传服务负责内容校验与只读源资产，分析编排器通过能力目录选择已真实验证的视频理解配置，将结果写入不可变事实层和初始本地化版本。

**技术栈：** Express、better-sqlite3、multer、adm-zip、crypto、FFprobe、Vue 3、Element Plus、Node Test Runner、Playwright。

---

## 文件结构

- 创建：`backend-node/migrations/49_redraw_workflow.sql`：完整转绘表、索引、唯一约束和状态检查。
- 创建：`backend-node/src/services/redrawService.js`：项目、作品、版本、事实层和所有权查询。
- 创建：`backend-node/src/services/redrawUploadService.js`：MP4/MOV/ZIP 校验、指纹、解压和源资产创建。
- 创建：`backend-node/src/services/redrawCapabilityService.js`：风格、语言和生成能力的证据门禁。
- 创建：`backend-node/src/services/redrawAnalysisService.js`：分析输入/输出结构校验和事实层归一化。
- 创建：`backend-node/src/services/redrawOrchestrator.js`：分析任务的创建、执行、终态与恢复入口。
- 创建：`backend-node/src/routes/redraw.js`：阶段 1 API handlers。
- 修改：`backend-node/src/routes/index.js`：挂载转绘路由。
- 修改：`backend-node/src/services/taskService.js`：识别可恢复的转绘分析任务。
- 修改：`backend-node/src/db/migrate.js`：确保迁移后转绘表列存在。
- 创建：`backend-node/test/redrawMigration.test.js`：表、约束、租户隔离和不可变事实测试。
- 创建：`backend-node/test/redrawUpload.test.js`：文件头、ZIP 路径、时长和指纹测试。
- 创建：`backend-node/test/redrawCapabilities.test.js`：风格和语言证据门禁测试。
- 创建：`backend-node/test/redrawAnalysis.test.js`：分析任务、事实结构和恢复测试。
- 创建：`backend-node/test/redrawRoutes.test.js`：路由成功字段和所有权测试。
- 创建：`frontweb/src/api/redraw.js`：转绘 API 封装。
- 创建：`frontweb/src/views/RedrawProjectList.vue`：项目与作品列表。
- 创建：`frontweb/src/views/RedrawWorkspace.vue`：四步壳层和后端状态恢复。
- 创建：`frontweb/src/components/redraw/RedrawSourceStep.vue`：上传与第一步表单。
- 创建：`frontweb/src/components/redraw/StylePresetPicker.vue`：四类横向风格卡片和自由风格。
- 创建：`frontweb/src/utils/redrawWorkspaceState.js`：步骤和能力状态的纯函数。
- 修改：`frontweb/src/router/index.js`：新增 `/redraw` 和工作台路由。
- 修改：`frontweb/src/components/PlatformPrimaryNav.vue`：新增“一键转绘”入口。
- 创建：`frontweb/test/redrawFoundation.test.js`：路由、导航、卡片、积分和恢复合同。
- 创建：`frontweb/e2e/redraw-workspace.spec.js`：阶段 1 浏览器路径，后续阶段在同文件扩展。

### 任务 1：建立转绘数据模型

**文件：**
- 创建：`backend-node/migrations/49_redraw_workflow.sql`
- 修改：`backend-node/src/db/migrate.js`
- 测试：`backend-node/test/redrawMigration.test.js`

- [ ] **步骤 1：编写失败的迁移测试**

```js
test('转绘迁移建立版本化领域表和唯一约束', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const name of ['redraw_projects', 'redraw_style_presets', 'redraw_works', 'redraw_versions', 'redraw_assets', 'redraw_shots', 'redraw_exports']) {
    assert.ok(names.includes(name), name);
  }
  db.prepare("INSERT INTO redraw_style_presets (stable_key,name,category,sort_order,version,status,created_at,updated_at) VALUES ('live-default','默认风格','live_action',1,1,'draft',?,?)").run(now, now);
  assert.throws(() => db.prepare("INSERT INTO redraw_style_presets (stable_key,name,category,sort_order,version,status,created_at,updated_at) VALUES ('live-default','重复','live_action',2,1,'draft',?,?)").run(now, now), /UNIQUE/);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd backend-node; node --test test/redrawMigration.test.js`

预期：FAIL，提示 `no such table: redraw_projects`。

- [ ] **步骤 3：编写迁移**

在 `49_redraw_workflow.sql` 中按规格第 9 章建立七张表；所有业务表包含 `tenant_id`、`user_id`、时间戳和软删除字段（导出表除 `deleted_at` 可省略）。增加以下关键约束：

```sql
CREATE UNIQUE INDEX uq_redraw_style_version ON redraw_style_presets(stable_key, version);
CREATE UNIQUE INDEX uq_redraw_work_source ON redraw_works(tenant_id, source_fingerprint) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_redraw_version_number ON redraw_versions(work_id, version);
CREATE UNIQUE INDEX uq_redraw_shot_order ON redraw_shots(version_id, batch_index, shot_index);
CREATE INDEX idx_redraw_work_owner ON redraw_works(tenant_id, user_id, updated_at DESC);
```

`redraw_versions` 额外保存 `style_snapshot_json`、`capability_snapshot_json`、`facts_hash`；`redraw_assets` 保存 `clean_plate_asset_id`；`redraw_exports` 保存 `version_number` 和 `manifest_json`。

- [ ] **步骤 4：实现迁移兜底并验证通过**

在 `migrate.js` 的 `runMigrationsAndEnsure` 末尾使用现有 `ensureColumns` 模式补齐上述兼容列。运行：`cd backend-node; node --test test/redrawMigration.test.js`，预期 PASS。

- [ ] **步骤 5：提交数据模型**

```powershell
git add backend-node/migrations/49_redraw_workflow.sql backend-node/src/db/migrate.js backend-node/test/redrawMigration.test.js
git diff --cached --check
git commit -m "feat: 建立一键转绘数据模型"
```

### 任务 2：实现受控源片上传和去重

**文件：**
- 创建：`backend-node/src/services/redrawUploadService.js`
- 创建：`backend-node/src/services/redrawService.js`
- 测试：`backend-node/test/redrawUpload.test.js`

- [ ] **步骤 1：编写失败的上传安全测试**

```js
test('拒绝扩展名伪装和 ZIP 路径穿越', async () => {
  await assert.rejects(() => validateSourceFile({ originalname: 'fake.mp4', buffer: Buffer.from('text') }), /文件头/);
  assert.throws(() => safeZipEntry('../escape.mp4'), /路径/);
  assert.throws(() => safeZipEntry('C:\\escape.mp4'), /路径/);
});

test('相同内容在同租户复用作品', () => {
  const first = createWorkFromSource(db, owner, projectId, source);
  const second = createWorkFromSource(db, owner, projectId, source);
  assert.equal(second.reused, true);
  assert.equal(second.work.id, first.work.id);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd backend-node; node --test test/redrawUpload.test.js`

预期：FAIL，提示找不到 `redrawUploadService`。

- [ ] **步骤 3：实现文件校验和指纹**

导出并使用以下明确接口：

```js
async function validateSourceFile(file, limits, probeVideo) { /* 返回 { kind, duration_ms, width, height, sha256 } */ }
function safeZipEntry(entryName) { /* 只接受相对路径且扩展名为 mp4/mov */ }
async function expandSourceUpload(file, limits, probeVideo) { /* 单文件返回 1 项，ZIP 最多 20 项 */ }
function createWorkFromSource(db, owner, projectId, sourceAsset) { /* 同租户指纹幂等 */ }
```

校验顺序固定为文件大小、ZIP 条目数/总展开大小、路径、扩展名、魔数/MIME、FFprobe 时长和分辨率。单片 15 秒至 60 分钟；ZIP 单片 15 至 180 秒且最多 20 个。源文件写入现有资产存储后只返回受控 asset URL，不暴露绝对路径。

- [ ] **步骤 4：运行上传测试验证通过**

运行：`cd backend-node; node --test test/redrawUpload.test.js`

预期：PASS，且测试临时目录在 `afterEach` 清理。

- [ ] **步骤 5：提交上传服务**

```powershell
git add backend-node/src/services/redrawUploadService.js backend-node/src/services/redrawService.js backend-node/test/redrawUpload.test.js
git diff --cached --check
git commit -m "feat: 增加转绘源片安全上传"
```

### 任务 3：实现风格与语言能力证据目录

**文件：**
- 创建：`backend-node/src/services/redrawCapabilityService.js`
- 测试：`backend-node/test/redrawCapabilities.test.js`

- [ ] **步骤 1：编写失败的证据门禁测试**

```js
test('普通目录只返回证据产物可读的 verified 风格', () => {
  seedPreset(db, { stable_key: 'verified', status: 'verified', verification_evidence_json: JSON.stringify(validEvidence) });
  seedPreset(db, { stable_key: 'draft', status: 'draft', verification_evidence_json: '{}' });
  assert.deepEqual(listPublicStylePresets(db, canReadArtifact).map(x => x.stable_key), ['verified']);
});

test('语言状态由文本配音字幕视频四项证据汇总', () => {
  assert.equal(summarizeLocaleCapability({ text: true, subtitles: true, tts: false, video: true }), 'subtitle_only');
  assert.equal(summarizeLocaleCapability({ text: true, subtitles: true, tts: true, video: true }), 'full_output');
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd backend-node; node --test test/redrawCapabilities.test.js`

预期：FAIL，提示找不到能力服务。

- [ ] **步骤 3：实现目录和 37 个真人风格种子**

能力服务导出：

```js
function validateGenerationEvidence(evidence, canReadArtifact) {
  return Boolean(evidence?.provider && evidence?.model && evidence?.task_id && evidence?.terminal_status === 'completed' && canReadArtifact(evidence.artifact_id));
}
function listPublicStylePresets(db, canReadArtifact) { /* category/sort_order 顺序 */ }
function listLocaleCapabilities(db, canReadArtifact) { /* 返回 locale、market、status、blocking */ }
```

迁移种子只插入规格中的 37 个真人风格为 `draft`，不附造假证据，因此普通目录初始不返回它们。二维、三维预设同样必须经后台真实生成验收后才改为 `verified`。自由风格作为表单模式返回，不伪装成已验证预设。

- [ ] **步骤 4：运行能力测试验证通过**

运行：`cd backend-node; node --test test/redrawCapabilities.test.js`

预期：PASS，断言 draft/disabled/不可读证据均不可见。

- [ ] **步骤 5：提交能力目录**

```powershell
git add backend-node/migrations/49_redraw_workflow.sql backend-node/src/services/redrawCapabilityService.js backend-node/test/redrawCapabilities.test.js
git diff --cached --check
git commit -m "feat: 增加转绘风格与语言门禁"
```

### 任务 4：实现源片分析与不可变事实层

**文件：**
- 创建：`backend-node/src/services/redrawAnalysisService.js`
- 创建：`backend-node/src/services/redrawOrchestrator.js`
- 修改：`backend-node/src/services/taskService.js`
- 测试：`backend-node/test/redrawAnalysis.test.js`

- [ ] **步骤 1：编写失败的分析合同测试**

```js
test('分析结果必须含时间码、说话人、事实和钩子', () => {
  assert.throws(() => normalizeSourceFacts({ shots: [{ start_ms: 1000, end_ms: 500 }] }), /时间码/);
  const facts = normalizeSourceFacts(validAnalysis);
  assert.equal(facts.shots[0].dialogue[0].speaker_id, 'character-1');
  assert.ok(facts.locked_facts.includes('证据在保险柜'));
});

test('分析失败释放冻结积分且保留源片', async () => {
  await runAnalyzeTask(ctxWithProviderFailure);
  assert.equal(readReservation(db).status, 'refunded');
  assert.ok(readWork(db).source_asset_id);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd backend-node; node --test test/redrawAnalysis.test.js`

预期：FAIL，提示找不到分析服务。

- [ ] **步骤 3：实现分析结构和编排**

`normalizeSourceFacts` 返回：

```js
{
  schema_version: '1.0',
  duration_ms,
  characters: [{ id, source_name, relationships }],
  scenes: [{ id, location, time, source_ranges }],
  props: [{ id, name, evidence_ranges }],
  shots: [{ id, start_ms, end_ms, dialogue, screen_text, opening_state, continuous_action, ending_state }],
  causal_chain: [],
  locked_facts: [],
  reversals: [],
  episode_hook: '',
}
```

`startAnalysis` 先读取 `video_understanding` 已验证能力、生成服务器报价、冻结积分，再创建 `async_tasks(type='redraw_analysis')`。供应商成功后必须验证结果结构并能回读源片/结果资产，事务写入 `redraw_versions.source_facts_json`、`facts_hash`、shots 草稿和 `work.status='asset_review'`，再结算。任何确定失败释放积分；未知状态写 `needs_attention`。

- [ ] **步骤 4：实现重启恢复**

在 `taskService.failOrphanedAsyncTasksOnStartup` 中排除具备 `provider_task_id` 的 `redraw_analysis`，由 `resumeRedrawTasks` 回读供应商；没有供应商 ID 的 processing 任务标记 failed 并释放积分。运行：`cd backend-node; node --test test/redrawAnalysis.test.js test/taskService.test.js`，预期 PASS。

- [ ] **步骤 5：提交分析编排**

```powershell
git add backend-node/src/services/redrawAnalysisService.js backend-node/src/services/redrawOrchestrator.js backend-node/src/services/taskService.js backend-node/test/redrawAnalysis.test.js
git diff --cached --check
git commit -m "feat: 增加转绘源片事实分析"
```

### 任务 5：实现阶段 1 API

**文件：**
- 创建：`backend-node/src/routes/redraw.js`
- 修改：`backend-node/src/routes/index.js`
- 测试：`backend-node/test/redrawRoutes.test.js`

- [ ] **步骤 1：编写失败的路由测试**

覆盖项目列表/创建、项目详情、作品上传、作品状态、风格目录、语言目录和分析提交；逐个断言跨租户 404、重复上传 `reused: true`、异步响应包含 `task_id` 与 billing 字段。

```js
assert.deepEqual(Object.keys(response.body.data.billing).sort(), ['charged', 'held', 'released']);
assert.equal(response.body.data.current_step, 1);
assert.equal(otherTenant.statusCode, 404);
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd backend-node; node --test test/redrawRoutes.test.js`

预期：FAIL，提示找不到 `../src/routes/redraw`。

- [ ] **步骤 3：实现 handlers 并挂载**

`redrawRoutes(db, log)` 导出 `listProjects`、`createProject`、`getProject`、`createWorks`、`getWork`、`listStylePresets`、`listLocales`、`analyzeWork`。在 `routes/index.js` 挂载规格第 10 章对应的阶段 1 路径；复用全局鉴权，所有查询必须同时过滤 `tenant_id`、`user_id`、`deleted_at IS NULL`。

- [ ] **步骤 4：运行路由回归**

运行：`cd backend-node; node --test test/redrawRoutes.test.js test/scriptAnalysisRoutes.test.js`

预期：PASS，剧本分析既有路由不回归。

- [ ] **步骤 5：提交阶段 1 API**

```powershell
git add backend-node/src/routes/redraw.js backend-node/src/routes/index.js backend-node/test/redrawRoutes.test.js
git diff --cached --check
git commit -m "feat: 暴露一键转绘基础接口"
```

### 任务 6：实现入口、列表和第一步 UI

**文件：**
- 创建：`frontweb/src/api/redraw.js`
- 创建：`frontweb/src/views/RedrawProjectList.vue`
- 创建：`frontweb/src/views/RedrawWorkspace.vue`
- 创建：`frontweb/src/components/redraw/RedrawSourceStep.vue`
- 创建：`frontweb/src/components/redraw/StylePresetPicker.vue`
- 创建：`frontweb/src/utils/redrawWorkspaceState.js`
- 修改：`frontweb/src/router/index.js`
- 修改：`frontweb/src/components/PlatformPrimaryNav.vue`
- 测试：`frontweb/test/redrawFoundation.test.js`

- [ ] **步骤 1：编写失败的前端合同测试**

```js
assert.match(routerSource, /path:\s*'\/redraw'/);
assert.match(navSource, />\s*一键转绘\s*</);
assert.match(styleSource, /二维动漫风/);
assert.match(styleSource, /三维动漫风/);
assert.match(styleSource, /真人写实风格/);
assert.match(styleSource, /自由风格/);
assert.match(sourceStep, /本次预计扣除/);
assert.match(sourceStep, /积分待管理员配置/);
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd frontweb; node --test test/redrawFoundation.test.js`

预期：FAIL，提示 `RedrawProjectList.vue` 不存在。

- [ ] **步骤 3：实现 API、路由与状态恢复**

`redraw.js` 使用 `@/utils/request`，导出 `listProjects/createProject/getProject/createWorks/getWork/listStylePresets/listLocales/analyzeWork`。工作台在 route query 和后端 `current_step` 中取较小的允许步骤，不能仅凭前端缓存越过门禁。

- [ ] **步骤 4：实现风格卡片和表单**

四类使用分段控件；预设轨道使用固定 `156px` 卡宽、`104px` 图高、`gap: 12px`、`overflow-x: auto`，支持滚轮转横向、触摸、键盘左右键和每类 scrollLeft 恢复。自由风格显示正向、负向和参考图；选择普通预设后隐藏自由表单。所有长名称允许两行，卡片尺寸不变。

- [ ] **步骤 5：实现报价与提交门禁**

只有后端返回有效报价才启用“开始分析并进入资产详情”；按钮上方使用现有 `canvas-credit-callout-v1` 相同的醒目加粗合同。提交后显示真实 `task_id/status/progress`，刷新时调用 `getWork` 恢复。

- [ ] **步骤 6：运行前端测试与构建**

运行：`cd frontweb; node --test test/redrawFoundation.test.js test/filmListCanvasEntry.test.js; npm run build`

预期：全部 PASS，构建成功，无 Vue 模板警告。

- [ ] **步骤 7：提交阶段 1 UI**

```powershell
git add frontweb/src/api/redraw.js frontweb/src/views/RedrawProjectList.vue frontweb/src/views/RedrawWorkspace.vue frontweb/src/components/redraw/RedrawSourceStep.vue frontweb/src/components/redraw/StylePresetPicker.vue frontweb/src/utils/redrawWorkspaceState.js frontweb/src/router/index.js frontweb/src/components/PlatformPrimaryNav.vue frontweb/test/redrawFoundation.test.js
git diff --cached --check
git commit -m "feat: 增加一键转绘第一步工作台"
```

### 任务 7：阶段 1 浏览器验收和审计

**文件：**
- 创建：`frontweb/e2e/redraw-workspace.spec.js`

- [ ] **步骤 1：编写浏览器测试**

用 Playwright 路由夹具验证全局入口、项目创建、MP4 上传、四类风格浏览、自由风格互斥、目标语言/地区、积分未配置禁用、提交后刷新恢复。禁止把夹具结果作为真实模型验收。

- [ ] **步骤 2：运行阶段 1 E2E**

运行：`cd frontweb; npx playwright test e2e/redraw-workspace.spec.js --project=chromium`

预期：PASS；桌面 1440×900 和移动 390×844 下无文字溢出、重叠或横向页面滚动。

- [ ] **步骤 3：运行阶段 1 总回归**

```powershell
cd backend-node
node --test test/redrawMigration.test.js test/redrawUpload.test.js test/redrawCapabilities.test.js test/redrawAnalysis.test.js test/redrawRoutes.test.js test/taskService.test.js
cd ..\frontweb
node --test test/redrawFoundation.test.js test/filmListCanvasEntry.test.js
npm run build
git diff --check
```

预期：全部 PASS，`git diff --check` 无输出。

- [ ] **步骤 4：记录真实分析门禁证据**

在不含密钥的验收记录中写入视频理解配置 ID、模型、任务 ID、成功终态、事实层版本、可回读时间码和结果资产可读性。没有目标 Key 或真实模型失败时，阶段状态写 `blocked`，不得把夹具测试标记为产品完成。

- [ ] **步骤 5：提交阶段 1 验收测试**

```powershell
git add frontweb/e2e/redraw-workspace.spec.js
git diff --cached --check
git commit -m "test: 覆盖一键转绘输入与分析流程"
```
