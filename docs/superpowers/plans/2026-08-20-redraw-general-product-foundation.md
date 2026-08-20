# 通用短剧一键转绘基础链路实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让任意短剧项目完成受控上传、通用事实分析、单目标市场本地化，并由 A/B 项目策略决定自动推进或降级审核。

**架构：** 保留现有 `redraw_projects → redraw_works → redraw_versions → redraw_shots` 数据链，新增项目执行策略和追加式状态事件。分析结果升级为通用事实合同 v2；旧 v1 事实继续只读兼容。A/B 模式共用同一编排器，通过纯函数策略服务返回 `advance`、`needs_review` 或 `blocked`。

**技术栈：** Node.js 20、Express、better-sqlite3、Vue 3、Element Plus、Node test runner、Playwright、FFmpeg/ffprobe。

**目标市场字段：** 现有 `redraw_projects.default_market` 是唯一目标国家，`redraw_projects.default_locale` 是唯一目标语言。创建项目后，本版本不得原地改写这两个字段；切换目标国家或目标语言必须创建新的本地化版本，保留旧版本证据。

---

## 交付边界

本计划完成后，项目必须能从产品入口走完：

`创建项目 → 上传源片 → 媒体探针 → 通用分析 v2 → A/B 决策 → 目标市场本地化 → 进入角色资产阶段`

本计划不调用真实视频生成供应商，不创建最终角色图片，不执行净景、逐镜视频生成或整集合并。这些工作分别由计划 2 和计划 3 接续。

## 文件结构

### 新建

- `backend-node/migrations/55_redraw_general_product_policy.sql`：项目执行策略与追加式工作流事件。
- `backend-node/src/services/redrawProjectPolicyService.js`：项目策略校验、快照和 CAS 更新。
- `backend-node/src/services/redrawWorkflowEventService.js`：追加状态事件并提供脱敏投影。
- `backend-node/src/services/redrawEpisodeFactsService.js`：通用事实合同 v2 的严格规范化与哈希。
- `backend-node/src/services/redrawAutomationPolicyService.js`：A/B 自动推进、降级和阻断决策。
- `backend-node/test/redrawProjectPolicy.test.js`：项目策略、预算与 CAS 测试。
- `backend-node/test/redrawEpisodeFacts.test.js`：通用分析 v2 合同测试。
- `backend-node/test/redrawAutomationPolicy.test.js`：A/B 策略矩阵测试。
- `frontweb/src/components/redraw/RedrawProjectOverview.vue`：模式、预算、版本和阻断项总览。
- `frontweb/test/redrawGeneralProject.test.js`：项目设置、八阶段投影和降级展示测试。
- `frontweb/e2e/fixtures/redraw-generic-project.js`：与样片无关的 3 镜通用验收夹具。

### 修改

- `backend-node/src/db/migrate.js`：旧库补列和事件表兜底。
- `backend-node/src/services/redrawAnalysisService.js`：按 `schema_version` 分发 v1/v2 规范化。
- `backend-node/src/services/redrawNativeSourceAnalysisService.js`：请求并校验 v2 事实，不再只依赖画面字幕猜对白。
- `backend-node/src/services/redrawOrchestrator.js`：写入 v2 事实、状态事件和自动化决策。
- `backend-node/src/services/localizationService.js`：物化 v2 角色、说话人、文字区域和时长合同。
- `backend-node/src/services/redrawLocalizationOrchestrator.js`：本地化完成后运行 A/B 决策。
- `backend-node/src/routes/redraw.js`：项目策略输入白名单、策略更新和工作流事件投影。
- `backend-node/src/routes/index.js`：注册项目策略更新路由。
- `backend-node/test/redrawMigration.test.js`：迁移和旧库兼容测试。
- `backend-node/test/redrawNativeSourceAnalysis.test.js`：v2 提示词与真实媒体分析测试。
- `backend-node/test/redrawLocalization.test.js`：v2 本地化、姓名和时长测试。
- `backend-node/test/redrawRoutes.test.js`：owner、白名单、CAS 和响应投影测试。
- `frontweb/src/api/redraw.js`：项目策略 API。
- `frontweb/src/views/RedrawProjectList.vue`：创建项目时收集目标市场、模式和预算。
- `frontweb/src/views/RedrawWorkspace.vue`：显示六个工作区和八阶段状态。
- `frontweb/src/components/redraw/RedrawSourceStep.vue`：展示项目策略和分析降级原因。
- `frontweb/src/utils/redrawWorkspaceState.js`：从服务端状态推导八阶段和 B→A 降级状态。
- `frontweb/test/redrawFoundation.test.js`：更新入口和阶段合同。
- `frontweb/e2e/redraw-backend-integration.spec.js`：增加通用 3 镜浏览器链路。

## 任务 1：固化项目执行策略和追加式状态事件

**文件：**

- 创建：`backend-node/migrations/55_redraw_general_product_policy.sql`
- 修改：`backend-node/src/db/migrate.js`
- 修改：`backend-node/test/redrawMigration.test.js`

- [ ] **步骤 1：编写迁移红灯测试**

在 `redrawMigration.test.js` 增加：

```js
test('通用转绘项目保存 A/B、预算、尝试上限和追加式事件', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const columns = db.prepare('PRAGMA table_info(redraw_projects)').all().map((row) => row.name);
  for (const name of [
    'execution_mode',
    'budget_limit_credits',
    'max_auto_attempts_per_shot',
    'policy_version',
    'automation_policy_json',
  ]) assert.ok(columns.includes(name), name);
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='redraw_workflow_events'").get().name,
    'redraw_workflow_events',
  );
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```bash
cd backend-node
node --test --test-concurrency=1 test/redrawMigration.test.js
```

预期：FAIL，缺少 `execution_mode` 或 `redraw_workflow_events`。

- [ ] **步骤 3：创建迁移并补旧库兜底**

迁移使用以下固定合同：

```sql
ALTER TABLE redraw_projects ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'safe'
  CHECK (execution_mode IN ('safe', 'auto'));
ALTER TABLE redraw_projects ADD COLUMN budget_limit_credits INTEGER
  CHECK (budget_limit_credits IS NULL OR budget_limit_credits > 0);
ALTER TABLE redraw_projects ADD COLUMN max_auto_attempts_per_shot INTEGER
  CHECK (max_auto_attempts_per_shot IS NULL OR max_auto_attempts_per_shot BETWEEN 1 AND 5);
ALTER TABLE redraw_projects ADD COLUMN policy_version INTEGER NOT NULL DEFAULT 1
  CHECK (policy_version > 0);
ALTER TABLE redraw_projects ADD COLUMN automation_policy_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE redraw_workflow_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  evidence_hash TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES redraw_projects(id)
);

CREATE INDEX idx_redraw_workflow_events_project
  ON redraw_workflow_events(tenant_id, user_id, project_id, id DESC);

CREATE TRIGGER redraw_workflow_events_immutable_update
BEFORE UPDATE ON redraw_workflow_events
BEGIN SELECT RAISE(ABORT, 'redraw workflow events are immutable'); END;

CREATE TRIGGER redraw_workflow_events_immutable_delete
BEFORE DELETE ON redraw_workflow_events
BEGIN SELECT RAISE(ABORT, 'redraw workflow events are immutable'); END;
```

在 `ensureRedrawCompatibility()` 中为 `redraw_projects` 补同名列，并以 `CREATE TABLE IF NOT EXISTS` 建立事件表和触发器。

- [ ] **步骤 4：验证新库、旧库和事件不可改写**

在测试中插入事件后执行 `UPDATE` 和 `DELETE`，两者均应抛出 `redraw workflow events are immutable`。

运行：

```bash
node --test --test-concurrency=1 test/redrawMigration.test.js
```

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add backend-node/migrations/55_redraw_general_product_policy.sql backend-node/src/db/migrate.js backend-node/test/redrawMigration.test.js
git commit -m "feat(转绘): 增加通用项目策略与状态事件"
```

## 任务 2：实现项目策略服务和严格 API

**文件：**

- 创建：`backend-node/src/services/redrawProjectPolicyService.js`
- 创建：`backend-node/src/services/redrawWorkflowEventService.js`
- 创建：`backend-node/test/redrawProjectPolicy.test.js`
- 修改：`backend-node/src/routes/redraw.js`
- 修改：`backend-node/src/routes/index.js`
- 修改：`backend-node/test/redrawRoutes.test.js`

- [ ] **步骤 1：编写项目策略红灯测试**

```js
test('auto 项目必须同时提供预算和自动尝试上限', () => {
  assert.throws(
    () => normalizeProjectPolicy({ execution_mode: 'auto', budget_limit_credits: 100 }),
    (error) => error.code === 'REDRAW_PROJECT_POLICY_INCOMPLETE',
  );
  assert.deepEqual(normalizeProjectPolicy({
    execution_mode: 'auto',
    budget_limit_credits: 100,
    max_auto_attempts_per_shot: 2,
  }), {
    execution_mode: 'auto',
    budget_limit_credits: 100,
    max_auto_attempts_per_shot: 2,
  });
});
```

再覆盖：未知字段、负预算、超过 5 次、`safe` 模式可不填预算、跨 owner 404、缺 `expected_updated_at`、CAS 409、客户端注入 `spent_credits`/`reservation_id` 被拒绝；并证明项目策略更新不能改写代表目标国家的 `default_market` 或代表目标语言的 `default_locale`。

- [ ] **步骤 2：运行红灯**

```bash
cd backend-node
node --test --test-concurrency=1 test/redrawProjectPolicy.test.js test/redrawRoutes.test.js
```

预期：FAIL，模块和策略更新路由不存在。

- [ ] **步骤 3：实现纯策略规范化与 CAS 更新**

`redrawProjectPolicyService.js` 只导出：

```js
module.exports = {
  normalizeProjectPolicy,
  projectPolicySnapshot,
  updateProjectPolicy,
};
```

`updateProjectPolicy` 使用 owner + `updated_at` 条件更新，并把 `policy_version` 加 1。响应只返回：

```js
{
  execution_mode,
  budget_limit_credits,
  max_auto_attempts_per_shot,
  policy_version,
  updated_at,
}
```

`redrawWorkflowEventService.js` 只接受固定 `resource_type`、安全 `reason_code` 和已计算的 `evidence_hash`，拒绝路径、URL、Key、Authorization 和原始供应商正文。

- [ ] **步骤 4：注册严格路由**

新增：

```text
PUT /redraw/projects/:id/policy
GET /redraw/projects/:id/events
```

`PUT` 请求白名单：

```js
[
  'execution_mode',
  'budget_limit_credits',
  'max_auto_attempts_per_shot',
  'expected_updated_at',
]
```

`GET events` 只返回当前 owner 的脱敏事件，不返回 `metadata_json` 中的内部路径。

- [ ] **步骤 5：运行测试验证通过**

```bash
node --test --test-concurrency=1 test/redrawProjectPolicy.test.js test/redrawRoutes.test.js
node --check src/services/redrawProjectPolicyService.js src/services/redrawWorkflowEventService.js src/routes/redraw.js
```

预期：PASS。

- [ ] **步骤 6：提交**

```bash
git add backend-node/src/services/redrawProjectPolicyService.js backend-node/src/services/redrawWorkflowEventService.js backend-node/src/routes/redraw.js backend-node/src/routes/index.js backend-node/test/redrawProjectPolicy.test.js backend-node/test/redrawRoutes.test.js
git commit -m "feat(转绘): 接通项目模式预算与状态事件"
```

## 任务 3：建立通用短剧事实合同 v2

**文件：**

- 创建：`backend-node/src/services/redrawEpisodeFactsService.js`
- 创建：`backend-node/test/redrawEpisodeFacts.test.js`
- 修改：`backend-node/src/services/redrawAnalysisService.js`
- 修改：`backend-node/src/services/redrawNativeSourceAnalysisService.js`
- 修改：`backend-node/test/redrawNativeSourceAnalysis.test.js`

- [ ] **步骤 1：编写 v2 合同红灯测试**

夹具必须至少包含 3 镜、2 个角色、1 个静默镜头和 1 个屏幕文字区域，且不得使用当前样片的 9 镜数据。

```js
test('v2 事实连续覆盖整集并绑定人物、说话人、文字和环境声', () => {
  const facts = normalizeEpisodeFactsV2(genericThreeShotFacts());
  assert.equal(facts.schema_version, '2.0');
  assert.deepEqual(facts.shots.map((shot) => shot.index), [1, 2, 3]);
  assert.equal(facts.shots[2].audio_contract.dialogue_mode, 'silent');
  assert.equal(facts.shots[0].dialogue[0].speaker_id, 'c1');
  assert.match(facts.facts_hash, /^[a-f0-9]{64}$/);
});
```

失败矩阵必须包含：时间轴 gap/overlap、未知角色、说话人不在镜头、对白越界、重复 `turn_id`、非法 polygon、文字区域越界、静默镜头含对白、缺少动作/构图/镜头运动、未知字段和非有限置信度。

- [ ] **步骤 2：运行测试确认失败**

```bash
cd backend-node
node --test --test-concurrency=1 test/redrawEpisodeFacts.test.js
```

预期：FAIL，`redrawEpisodeFactsService` 不存在。

- [ ] **步骤 3：实现 v2 规范化器**

顶层固定字段：

```js
const TOP_LEVEL_FIELDS = [
  'schema_version', 'duration_ms', 'story', 'characters',
  'scenes', 'props', 'shots', 'causal_chain', 'locked_facts',
  'reversals', 'episode_hook',
];
```

镜头固定输出：

```js
{
  id,
  index,
  start_ms,
  end_ms,
  composition,
  camera_movement,
  opening_state,
  continuous_action,
  ending_state,
  visible_character_ids,
  dialogue,
  text_regions,
  audio_contract: {
    dialogue_mode: 'spoken' | 'silent',
    ambient_audio: 'preserve_or_rebuild',
  },
  confidence: {
    character_mapping,
    speaker_mapping,
    text_regions,
    shot_boundary,
  },
}
```

所有数组稳定排序后计算 `facts_hash`。服务不得保留 OCR 原文以外的模型解释、路径、URL 或提示词。

- [ ] **步骤 4：让 v1/v2 分发保持兼容**

`redrawAnalysisService.normalizeSourceFacts(raw)` 使用：

```js
if (raw?.schema_version === '2.0') return normalizeEpisodeFactsV2(raw);
return normalizeSourceFactsV1(raw);
```

旧测试必须保持通过。

- [ ] **步骤 5：升级真实媒体分析提示词和校验**

`redrawNativeSourceAnalysisService.buildPrompt()` 请求 v2 精确 JSON。对白事实必须来自音频转写或可见字幕证据；若当前分析器没有音频转写证据，则相应置信度必须不足并触发 A，不能猜测说话人。

输出资产的 `metadata.schema_version` 固定为 `2.0`，同时保留 `provider_task_id`、`facts_hash` 和媒体探针摘要。

- [ ] **步骤 6：运行联合测试**

```bash
node --test --test-concurrency=1 test/redrawEpisodeFacts.test.js test/redrawAnalysis.test.js test/redrawNativeSourceAnalysis.test.js
node --check src/services/redrawEpisodeFactsService.js src/services/redrawAnalysisService.js src/services/redrawNativeSourceAnalysisService.js
```

预期：PASS。

- [ ] **步骤 7：提交**

```bash
git add backend-node/src/services/redrawEpisodeFactsService.js backend-node/src/services/redrawAnalysisService.js backend-node/src/services/redrawNativeSourceAnalysisService.js backend-node/test/redrawEpisodeFacts.test.js backend-node/test/redrawNativeSourceAnalysis.test.js
git commit -m "feat(转绘): 固化通用短剧事实合同"
```

## 任务 4：实现 A/B 自动推进和降级策略

**文件：**

- 创建：`backend-node/src/services/redrawAutomationPolicyService.js`
- 创建：`backend-node/test/redrawAutomationPolicy.test.js`
- 修改：`backend-node/src/services/redrawOrchestrator.js`
- 修改：`backend-node/test/redrawAnalysis.test.js`

- [ ] **步骤 1：编写策略矩阵红灯测试**

```js
test('auto 任一必需置信度不足时降级 safe，不产生付费动作', () => {
  const decision = evaluateAutomationDecision({
    execution_mode: 'auto',
    gates: { media: true, timeline: true, facts: true },
    confidence: { character_mapping: 0.99, speaker_mapping: 0.71, text_regions: 0.98, shot_boundary: 0.99 },
    thresholds: { character_mapping: 0.95, speaker_mapping: 0.90, text_regions: 0.95, shot_boundary: 0.95 },
  });
  assert.deepEqual(decision, {
    action: 'needs_review',
    effective_mode: 'safe',
    reason_codes: ['speaker_mapping_low_confidence'],
  });
});
```

覆盖：A 永远等待确认、B 全通过自动推进、缺阈值阻断、缺置信度降级、确定性 gate 失败阻断、预算未配置阻断、reason code 稳定排序。

- [ ] **步骤 2：运行红灯**

```bash
node --test --test-concurrency=1 test/redrawAutomationPolicy.test.js
```

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现无副作用纯函数**

只导出：

```js
module.exports = {
  evaluateAutomationDecision,
  requiredAnalysisConfidenceKeys: Object.freeze([
    'character_mapping',
    'speaker_mapping',
    'text_regions',
    'shot_boundary',
  ]),
};
```

阈值来自 `automation_policy_json` 的版本快照。缺阈值不得使用代码默认值自动放行。

- [ ] **步骤 4：接入分析收口**

`redrawOrchestrator.finalizeCompletedAnalysis()` 在写入事实后：

1. 读取当前 owner 项目策略；
2. 评估分析 gate；
3. 追加 `analysis_completed` 事件；
4. `advance` 时进入本地化报价阶段；
5. `needs_review` 时保持 `analysis_review`；
6. `blocked` 时写稳定错误码，不创建本地化任务或费用预留。

- [ ] **步骤 5：验证分析不会因低置信度触发付费本地化**

运行：

```bash
node --test --test-concurrency=1 test/redrawAutomationPolicy.test.js test/redrawAnalysis.test.js test/redrawLocalizationOrchestration.test.js
```

预期：PASS，低置信度场景的本地化 task 和 reservation 数量均为 0。

- [ ] **步骤 6：提交**

```bash
git add backend-node/src/services/redrawAutomationPolicyService.js backend-node/src/services/redrawOrchestrator.js backend-node/test/redrawAutomationPolicy.test.js backend-node/test/redrawAnalysis.test.js
git commit -m "feat(转绘): 增加自动模式降级策略"
```

## 任务 5：物化 v2 本地化结果并锁定单一目标市场

**文件：**

- 修改：`backend-node/src/services/localizationService.js`
- 修改：`backend-node/src/services/redrawLocalizationOrchestrator.js`
- 修改：`backend-node/test/redrawLocalization.test.js`
- 修改：`backend-node/test/redrawLocalizationOrchestration.test.js`

- [ ] **步骤 1：编写 v2 本地化红灯测试**

```js
test('v2 本地化只改姓名文字对白并保留镜头事实', () => {
  const result = normalizeLocalizationResult({
    facts_hash: source.facts_hash,
    name_map: { c1: 'Mateo', c2: 'Diego' },
    culture_map: { currency: 'USD' },
    dialogue: localizedTurns,
    text_map: { 'shot-2:screen-1': 'CALL MOM' },
  }, source);
  assert.equal(result.name_map.c1, 'Mateo');
  assert.equal(result.dialogue[0].turns[0].speaker_id, 'c1');
  assert.equal(result.dialogue[0].turns[0].start_ms, source.shots[0].dialogue[0].start_ms);
});
```

失败矩阵：第二目标市场注入、漏角色姓名、重复目标姓名、改说话人、改时间码、静默镜头加对白、源语言残留、屏幕文字缺映射、译文超可说时长、事实哈希漂移。

- [ ] **步骤 2：运行红灯**

```bash
node --test --test-concurrency=1 test/redrawLocalization.test.js test/redrawLocalizationOrchestration.test.js
```

预期：FAIL，v2 `text_map`、角色键和静默合同未被完整校验。

- [ ] **步骤 3：扩展本地化规范化**

规范输出固定为：

```js
{
  facts_hash,
  locale,
  market,
  name_map,
  culture_map,
  glossary,
  dialogue,
  text_map,
  confidence: {
    names,
    dialogue_semantics,
    dialogue_timing,
    culture,
    screen_text,
  },
}
```

说话人、时间码、重叠组和静默合同完全来自源事实；供应商不能改写。

- [ ] **步骤 4：物化镜头和资产**

`materializeLocalizationDraft()` 将 v2 的 `composition`、`camera_movement`、`visible_character_ids`、`text_regions` 和 `audio_contract` 写入 `draft_json`/`compiled_prompt_json`，同时继续写现有 `source_dialogue_json` 和 `localized_dialogue_json`。

每个源角色只创建一个 `character` 和一个 `voice` 草稿资产；`source_ref_json` 使用 `source_character_key`，不得使用姓名作为稳定键。

- [ ] **步骤 5：本地化完成后运行 A/B 决策**

本地化置信度不足时：任务本身可以 `completed`，但版本状态为 `needs_review`，项目有效模式显示 `safe`，不启动资产生成。

- [ ] **步骤 6：运行联合测试**

```bash
node --test --test-concurrency=1 test/redrawLocalization.test.js test/redrawLocalizationOrchestration.test.js test/redrawRoutes.test.js
```

预期：PASS。

- [ ] **步骤 7：提交**

```bash
git add backend-node/src/services/localizationService.js backend-node/src/services/redrawLocalizationOrchestrator.js backend-node/test/redrawLocalization.test.js backend-node/test/redrawLocalizationOrchestration.test.js backend-node/test/redrawRoutes.test.js
git commit -m "feat(转绘): 物化通用本地化事实"
```

## 任务 6：把项目模式和八阶段状态接入工作台

**文件：**

- 创建：`frontweb/src/components/redraw/RedrawProjectOverview.vue`
- 创建：`frontweb/test/redrawGeneralProject.test.js`
- 修改：`frontweb/src/api/redraw.js`
- 修改：`frontweb/src/views/RedrawProjectList.vue`
- 修改：`frontweb/src/views/RedrawWorkspace.vue`
- 修改：`frontweb/src/components/redraw/RedrawSourceStep.vue`
- 修改：`frontweb/src/utils/redrawWorkspaceState.js`
- 修改：`frontweb/test/redrawFoundation.test.js`

- [ ] **步骤 1：编写前端红灯测试**

```js
test('项目创建必须提交单一市场、A/B、预算和自动尝试上限', () => {
  assert.match(listSource, /execution_mode/);
  assert.match(listSource, /budget_limit_credits/);
  assert.match(listSource, /max_auto_attempts_per_shot/);
  assert.match(listSource, /default_locale/);
  assert.match(listSource, /default_market/);
});

test('工作台显示六个工作区和八阶段状态且不使用本地缓存越权', () => {
  for (const label of ['项目设置', '分析本地化', '角色资产库', '逐镜工作台', '生成与 QA', '合并与导出']) {
    assert.match(workspaceSource, new RegExp(label));
  }
  assert.match(stateSource, /resolveEightStageState/);
  assert.doesNotMatch(stateSource, /localStorage|sessionStorage/);
});
```

- [ ] **步骤 2：运行红灯**

```bash
node --test frontweb/test/redrawGeneralProject.test.js frontweb/test/redrawFoundation.test.js
```

预期：FAIL，项目策略字段和八阶段投影不存在。

- [ ] **步骤 3：接入 API 和创建表单**

`redrawAPI` 新增：

```js
updateProjectPolicy(projectId, body) {
  return request.put(`/redraw/projects/${projectId}/policy`, body)
},
listProjectEvents(projectId) {
  return request.get(`/redraw/projects/${projectId}/events`)
},
```

创建项目时，`auto` 必须同时填写预算与尝试上限；`safe` 可以不填。前端不发送已用积分、模型、供应商或 reservation。

- [ ] **步骤 4：实现服务端状态投影 UI**

`resolveEightStageState(work)` 只根据服务端 `workflow_phase`、版本和事件投影：

```js
[
  'project_input',
  'source_analysis',
  'localization',
  'character_assets',
  'reference_preparation',
  'generation',
  'shot_quality',
  'episode_export',
]
```

`RedrawProjectOverview` 显示原始模式、有效模式、预算上限、已用/预留积分、版本、待审核和 `needs_attention` 数量。

- [ ] **步骤 5：运行前端测试和构建**

```bash
node --test frontweb/test/redrawGeneralProject.test.js frontweb/test/redrawFoundation.test.js frontweb/test/redrawSourceRuntime.test.js
npm --prefix frontweb run build
```

预期：测试 PASS，构建成功。

- [ ] **步骤 6：提交**

```bash
git add frontweb/src/api/redraw.js frontweb/src/views/RedrawProjectList.vue frontweb/src/views/RedrawWorkspace.vue frontweb/src/components/redraw/RedrawProjectOverview.vue frontweb/src/components/redraw/RedrawSourceStep.vue frontweb/src/utils/redrawWorkspaceState.js frontweb/test/redrawGeneralProject.test.js frontweb/test/redrawFoundation.test.js
git commit -m "feat(转绘): 在工作台接入通用项目策略"
```

## 任务 7：完成不依赖样片的基础链路验收

**文件：**

- 创建：`frontweb/e2e/fixtures/redraw-generic-project.js`
- 修改：`frontweb/e2e/redraw-backend-integration.spec.js`
- 修改：`backend-node/test/redrawRoutes.test.js`

- [ ] **步骤 1：创建通用 3 镜夹具**

夹具必须使用与当前样片不同的时长、角色和台词：

```js
export const genericRedrawProject = {
  duration_ms: 12000,
  target: { locale: 'es-ES', market: 'ES' },
  characters: [
    { id: 'c1', source_name: '角色甲' },
    { id: 'c2', source_name: '角色乙' },
  ],
  shots: [
    { id: 'generic-1', index: 1, start_ms: 0, end_ms: 4000 },
    { id: 'generic-2', index: 2, start_ms: 4000, end_ms: 8000 },
    { id: 'generic-3', index: 3, start_ms: 8000, end_ms: 12000 },
  ],
};
```

- [ ] **步骤 2：编写浏览器链路测试**

测试从 `/redraw` 创建 `auto` 项目，上传 12 秒夹具，等待分析和本地化，断言：

- 项目只显示 `es-ES / ES`；
- 分析产生 3 镜而不是 9 镜；
- 低说话人置信度时显示“已自动降级 A”；
- 零资产生成请求、零视频生成请求；
- 页面刷新后状态来自后端，不依赖浏览器缓存。

- [ ] **步骤 3：运行基础链路联合验证**

```bash
cd backend-node
node --test --test-concurrency=1 test/redrawMigration.test.js test/redrawProjectPolicy.test.js test/redrawEpisodeFacts.test.js test/redrawAutomationPolicy.test.js test/redrawAnalysis.test.js test/redrawNativeSourceAnalysis.test.js test/redrawLocalization.test.js test/redrawLocalizationOrchestration.test.js test/redrawRoutes.test.js
cd ..
node --test frontweb/test/redrawGeneralProject.test.js frontweb/test/redrawFoundation.test.js frontweb/test/redrawSourceRuntime.test.js
npm --prefix frontweb run build
npm --prefix frontweb run test:e2e -- redraw-backend-integration.spec.js
```

预期：全部 PASS；浏览器链路没有真实供应商调用和积分扣费。

- [ ] **步骤 4：检查提交范围**

```bash
git diff --check
git status --short
```

预期：只包含本计划列出的文件；既有 `.superpowers/`、`frontweb/output/` 和 `__pycache__/` 保持未跟踪且未提交。

- [ ] **步骤 5：提交验收夹具**

```bash
git add frontweb/e2e/fixtures/redraw-generic-project.js frontweb/e2e/redraw-backend-integration.spec.js backend-node/test/redrawRoutes.test.js
git commit -m "test(转绘): 增加通用项目前链验收"
```

## 计划 1 完成标准

- 项目策略、预算和尝试上限由服务端保存并通过 CAS 更新。
- A、B 使用同一状态链；B 置信度不足自动降级 A。
- v2 事实覆盖完整时间轴、人物、说话人、文字、动作和环境声合同。
- 本地化只改变允许字段，保留镜头和说话人事实，译文适配原时长。
- 通用 3 镜夹具可以完成上传、分析和本地化，不依赖当前样片。
- 未触发角色图片、净景或视频供应商调用。
