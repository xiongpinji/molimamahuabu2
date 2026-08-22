# 通用短剧角色与逐镜参考准备实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将已本地化项目转换为整集锁定的虚构成年角色资产，并为任意数量镜头生成可验证、可失效、可恢复的净景和逐镜参考包。

**架构：** 复用现有角色身份包、声音绑定、净景、文字净景、全帧覆盖和参考包服务；新增准备状态、依赖失效服务和版本级参考准备编排器。任何上游角色、声音、服装、文字或镜头变化，只把引用它的镜头标记为 `stale`，不删除旧候选。

**技术栈：** Node.js 20、Express、better-sqlite3、Sharp、Vue 3、Node test runner、FFmpeg/ffprobe。

---

## 前置条件

- 已完成 `2026-08-20-redraw-general-product-foundation.md`。
- 当前版本已具有 v2 事实、单目标市场本地化结果和项目 A/B 策略。
- 本计划只在本地使用假供应商或现有受控资产测试，不授权真实付费生成。

## 文件结构

### 新建

- `backend-node/migrations/56_redraw_preparation_state.sql`：逐镜准备状态、依赖哈希和失效字段。
- `backend-node/src/services/redrawCharacterPlanService.js`：角色姓名、身份、声音和服装的整集锁定门禁。
- `backend-node/src/services/redrawDependencyInvalidationService.js`：按依赖精确失效镜头。
- `backend-node/src/services/redrawPreparationGateService.js`：角色、净景、文字和参考包的版本级汇总。
- `backend-node/src/services/redrawReferencePreparationOrchestrator.js`：逐镜参考准备任务编排。
- `backend-node/test/redrawCharacterPlan.test.js`：角色整集锁定测试。
- `backend-node/test/redrawDependencyInvalidation.test.js`：精准失效和旧证据保留测试。
- `backend-node/test/redrawPreparationGate.test.js`：准备门禁测试。
- `backend-node/test/redrawReferencePreparationOrchestration.test.js`：逐镜编排和恢复测试。
- `frontweb/src/components/redraw/RedrawCharacterLibraryPanel.vue`：角色身份、声音和服装总览。
- `frontweb/src/components/redraw/RedrawShotPreparationPanel.vue`：逐镜净景、文字和参考包状态。
- `frontweb/test/redrawPreparationWorkspace.test.js`：角色库和逐镜准备工作台测试。

### 修改

- `backend-node/src/db/migrate.js`：旧库准备状态补列。
- `backend-node/src/services/redrawCharacterIdentityService.js`：将服装合同纳入身份包哈希与 ready 判定。
- `backend-node/src/services/redrawAssetService.js`：在资产完成或失效后写依赖哈希和准备状态。
- `backend-node/src/services/redrawReviewService.js`：生成门禁要求当前准备证据。
- `backend-node/src/services/redrawFullFrameCoverageService.js`：覆盖任意镜头数量。
- `backend-node/src/services/redrawFullFrameReviewService.js`：移除固定 9 镜/9 张审核表假设。
- `backend-node/src/services/redrawReferenceBundleService.js`：保存后写准备状态和依赖哈希。
- `backend-node/src/routes/redraw.js`：角色计划、准备状态和准备任务 API。
- `backend-node/src/routes/index.js`：注册准备路由。
- `backend-node/test/redrawMigration.test.js`：准备状态迁移测试。
- `backend-node/test/redrawCharacterIdentity.test.js`：服装证据和哈希测试。
- `backend-node/test/redrawAssets.test.js`：净景依赖与失效测试。
- `backend-node/test/redrawFullFrameCoverage.test.js`：任意镜头数量测试。
- `backend-node/test/redrawFullFrameReview.test.js`：非 9 镜审核测试。
- `backend-node/test/redrawReferenceBundle.test.js`：准备状态和失效测试。
- `backend-node/test/redrawRoutes.test.js`：owner、白名单、CAS 和任务响应测试。
- `frontweb/src/api/redraw.js`：角色计划与参考准备 API。
- `frontweb/src/views/RedrawWorkspace.vue`：接入角色资产库和逐镜工作台。
- `frontweb/src/components/redraw/RedrawAssetStep.vue`：嵌入角色库总览。
- `frontweb/src/components/redraw/RedrawShotStep.vue`：嵌入逐镜准备与失效状态。
- `frontweb/src/utils/redrawCharacterIdentity.js`：服装合同投影。
- `frontweb/src/utils/redrawShotState.js`：准备状态和风险筛选。

## 任务 1：增加逐镜准备状态与依赖哈希

**文件：**

- 创建：`backend-node/migrations/56_redraw_preparation_state.sql`
- 修改：`backend-node/src/db/migrate.js`
- 修改：`backend-node/test/redrawMigration.test.js`

- [ ] **步骤 1：编写迁移红灯测试**

```js
test('逐镜保存准备状态、依赖哈希和失效原因', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const columns = db.prepare('PRAGMA table_info(redraw_shots)').all().map((row) => row.name);
  for (const name of [
    'preparation_state',
    'preparation_version',
    'preparation_evidence_hash',
    'preparation_snapshot_json',
    'stale_reason_code',
  ]) assert.ok(columns.includes(name), name);
});
```

- [ ] **步骤 2：运行红灯**

```bash
cd backend-node
node --test --test-concurrency=1 test/redrawMigration.test.js
```

预期：FAIL，准备列不存在。

- [ ] **步骤 3：实现迁移和旧库兜底**

```sql
ALTER TABLE redraw_shots ADD COLUMN preparation_state TEXT NOT NULL DEFAULT 'parsed'
  CHECK (preparation_state IN (
    'parsed', 'localized', 'identity_bound', 'clean_ready',
    'reference_ready', 'needs_review', 'needs_attention', 'failed', 'stale'
  ));
ALTER TABLE redraw_shots ADD COLUMN preparation_version INTEGER NOT NULL DEFAULT 1
  CHECK (preparation_version > 0);
ALTER TABLE redraw_shots ADD COLUMN preparation_evidence_hash TEXT;
ALTER TABLE redraw_shots ADD COLUMN preparation_snapshot_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE redraw_shots ADD COLUMN stale_reason_code TEXT;
```

`ensureRedrawCompatibility()` 使用相同默认值补列，不改写已有镜头。

- [ ] **步骤 4：验证迁移通过**

```bash
node --test --test-concurrency=1 test/redrawMigration.test.js
```

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add backend-node/migrations/56_redraw_preparation_state.sql backend-node/src/db/migrate.js backend-node/test/redrawMigration.test.js
git commit -m "feat(转绘): 增加逐镜准备与失效状态"
```

## 任务 2：把身份、声音和服装锁成整集角色计划

**文件：**

- 创建：`backend-node/src/services/redrawCharacterPlanService.js`
- 创建：`backend-node/test/redrawCharacterPlan.test.js`
- 修改：`backend-node/src/services/redrawCharacterIdentityService.js`
- 修改：`backend-node/test/redrawCharacterIdentity.test.js`

- [ ] **步骤 1：编写角色计划红灯测试**

```js
test('角色计划要求每个源人物唯一绑定成年虚构演员、声音和服装', () => {
  const result = buildCharacterPlan(ctx, versionId);
  assert.equal(result.ready, true);
  assert.deepEqual(result.characters.map((item) => item.source_character_key), ['c1', 'c2']);
  assert.equal(result.characters.every((item) => item.adult_status === 'adult'), true);
  assert.equal(result.characters.every((item) => item.voice.ready), true);
  assert.equal(result.characters.every((item) => item.wardrobe.ready), true);
});
```

失败矩阵：漏角色、重复 `source_character_key`、重复目标姓名、同一身份包绑定两个源人物、未成年/不明年龄、非虚构 AI、声音未审批、声音语言不符、服装缺引用、服装哈希漂移、跨 owner 资产。

- [ ] **步骤 2：运行红灯**

```bash
node --test --test-concurrency=1 test/redrawCharacterPlan.test.js test/redrawCharacterIdentity.test.js
```

预期：FAIL，角色计划服务和服装合同不存在。

- [ ] **步骤 3：扩展身份包服装合同**

身份包新增服务端规范字段：

```js
wardrobe: {
  label: '整集主服装',
  reference_asset_id: 123,
  reference_sha256: '64-hex',
  consistency_confirmed: true,
}
```

`reference_sha256` 由服务端读取资产后计算，客户端不得提交。服装资产必须属于同 owner、可读、为图片且不指向存储根外。

完整身份包哈希必须包含 `wardrobe`。缺少服装时允许保存草稿，但 `ready=false`。

- [ ] **步骤 4：实现角色计划汇总**

`redrawCharacterPlanService.js` 只导出：

```js
module.exports = {
  buildCharacterPlan,
  assertCharacterPlanReady,
};
```

输出使用白名单：

```js
{
  version_id,
  ready,
  missing,
  characters: [{
    source_character_key,
    target_name,
    identity_pack_sha256,
    adult_status,
    voice: { asset_id, language, sha256, ready },
    wardrobe: { label, asset_id, sha256, ready },
  }],
  plan_hash,
}
```

不得返回本地路径、源片人脸 URL、Key 或内部 `source_ref_json`。

- [ ] **步骤 5：运行测试**

```bash
node --test --test-concurrency=1 test/redrawCharacterPlan.test.js test/redrawCharacterIdentity.test.js test/redrawAssets.test.js
node --check src/services/redrawCharacterPlanService.js src/services/redrawCharacterIdentityService.js
```

预期：PASS。

- [ ] **步骤 6：提交**

```bash
git add backend-node/src/services/redrawCharacterPlanService.js backend-node/src/services/redrawCharacterIdentityService.js backend-node/test/redrawCharacterPlan.test.js backend-node/test/redrawCharacterIdentity.test.js
git commit -m "feat(转绘): 锁定整集角色身份声音与服装"
```

## 任务 3：实现精准依赖失效并保留旧证据

**文件：**

- 创建：`backend-node/src/services/redrawDependencyInvalidationService.js`
- 创建：`backend-node/test/redrawDependencyInvalidation.test.js`
- 修改：`backend-node/src/services/redrawAssetService.js`
- 修改：`backend-node/src/services/redrawCharacterIdentityService.js`
- 修改：`backend-node/src/services/redrawReferenceBundleService.js`

- [ ] **步骤 1：编写失效传播红灯测试**

```js
test('换角色只失效引用该角色的镜头并保留旧候选', () => {
  const beforeVideoId = shot1.video_generation_id;
  const result = invalidateCharacterDependents(ctx, {
    version_id: versionId,
    source_character_key: 'c1',
    reason_code: 'character_identity_changed',
  });
  assert.deepEqual(result.invalidated_shot_ids, [shot1.id]);
  assert.equal(readShot(shot1.id).preparation_state, 'stale');
  assert.equal(readShot(shot2.id).preparation_state, 'reference_ready');
  assert.equal(readVideo(beforeVideoId).id, beforeVideoId);
});
```

再覆盖：声音、服装、文字区域、镜头时间变化；无关镜头保持不变；旧 `video_generations`、资产和审核事件不删除；CAS 失败零部分写入。

- [ ] **步骤 2：运行红灯**

```bash
node --test --test-concurrency=1 test/redrawDependencyInvalidation.test.js
```

预期：FAIL，失效服务不存在。

- [ ] **步骤 3：实现事务性失效服务**

服务导出：

```js
module.exports = {
  invalidateCharacterDependents,
  invalidateDialogueDependents,
  invalidateTextDependents,
  invalidateShotTimingDependents,
};
```

每次失效在一个 `BEGIN IMMEDIATE` 事务内：

1. 读取当前 owner/version；
2. 精确解析 `references_json` 和参考包绑定；
3. 将受影响镜头设为 `stale`，递增 `preparation_version`；
4. 清空当前 `reference_bundle_hash` 和当前候选指针；
5. 保留旧参考包 JSON、视频行和资产，通过 workflow event 记录旧哈希；
6. 返回稳定排序的镜头 ID。

- [ ] **步骤 4：在上游变更后调用失效服务**

身份包、声音或服装成功保存后才触发失效。保存失败、owner/CAS 冲突或文件漂移时不得触发。

- [ ] **步骤 5：运行联合测试**

```bash
node --test --test-concurrency=1 test/redrawDependencyInvalidation.test.js test/redrawCharacterIdentity.test.js test/redrawAssets.test.js test/redrawReferenceBundle.test.js
```

预期：PASS。

- [ ] **步骤 6：提交**

```bash
git add backend-node/src/services/redrawDependencyInvalidationService.js backend-node/src/services/redrawAssetService.js backend-node/src/services/redrawCharacterIdentityService.js backend-node/src/services/redrawReferenceBundleService.js backend-node/test/redrawDependencyInvalidation.test.js
git commit -m "feat(转绘): 增加逐镜依赖精准失效"
```

## 任务 4：移除全帧审核固定 9 镜假设

**文件：**

- 修改：`backend-node/src/services/redrawFullFrameCoverageService.js`
- 修改：`backend-node/src/services/redrawFullFrameReviewService.js`
- 修改：`backend-node/test/redrawFullFrameCoverage.test.js`
- 修改：`backend-node/test/redrawFullFrameReview.test.js`

- [ ] **步骤 1：把现有固定 9 镜测试改成通用红灯**

新增 3 镜和 12 镜夹具：

```js
for (const count of [3, 12]) {
  await t.test(`${count} 镜覆盖可完成审核`, async () => {
    const generated = await buildGeneratedCoverageManifest(makeCoverageFixture(count));
    const reviewed = await finalizeReviewedCoverage(makeReviewInput(generated));
    assert.equal(reviewed.manifest.shots.length, count);
    assert.equal(reviewed.manifest.review.status, 'approved');
  });
}
```

镜头为空、审核表数量与镜头不一致、缺任一镜头覆盖仍必须失败。

- [ ] **步骤 2：运行红灯**

```bash
node --test --test-concurrency=1 test/redrawFullFrameCoverage.test.js test/redrawFullFrameReview.test.js
```

预期：FAIL，现有服务要求恰好 9 张审核表或 9 镜。

- [ ] **步骤 3：用输入镜头数量派生审核表数量**

删除数值 9 的业务判断。审核表数量必须由 `generatedManifest.shots.length` 和分页器计算：

```js
const expectedSheetCount = Math.ceil(generatedManifest.shots.length / shotsPerSheet);
```

`shotsPerSheet` 是服务内部固定布局常量，不接受客户端配置。镜头 ID 必须与分析事实集合完全相等。

- [ ] **步骤 4：运行测试和静态扫描**

```bash
node --test --test-concurrency=1 test/redrawFullFrameCoverage.test.js test/redrawFullFrameReview.test.js
rg -n "exactly 9|=== 9|length !== 9|固定 9" src/services/redrawFullFrameCoverageService.js src/services/redrawFullFrameReviewService.js
```

预期：测试 PASS；扫描无业务数量命中。

- [ ] **步骤 5：提交**

```bash
git add backend-node/src/services/redrawFullFrameCoverageService.js backend-node/src/services/redrawFullFrameReviewService.js backend-node/test/redrawFullFrameCoverage.test.js backend-node/test/redrawFullFrameReview.test.js
git commit -m "fix(转绘): 支持任意镜头数量的全帧审核"
```

## 任务 5：实现角色、净景和参考包准备门禁

**文件：**

- 创建：`backend-node/src/services/redrawPreparationGateService.js`
- 创建：`backend-node/test/redrawPreparationGate.test.js`
- 修改：`backend-node/src/services/redrawReviewService.js`
- 修改：`backend-node/test/redrawReviewGate.test.js`

- [ ] **步骤 1：编写准备门禁红灯测试**

```js
test('版本只有在角色和每镜参考包均为当前证据时 ready', async () => {
  const gate = await evaluatePreparationGate(ctx, versionId);
  assert.deepEqual(gate, {
    ok: true,
    version_id: versionId,
    character_plan_hash: characterPlan.plan_hash,
    ready_shot_ids: [shot1.id, shot2.id, shot3.id],
    missing: [],
  });
});
```

失败矩阵：角色计划未锁、任一镜头 `stale`、缺人脸覆盖、缺文字净化、参考包哈希漂移、版本不匹配、owner 不匹配、旧候选存在但新准备未通过。

- [ ] **步骤 2：运行红灯**

```bash
node --test --test-concurrency=1 test/redrawPreparationGate.test.js test/redrawReviewGate.test.js
```

预期：FAIL，准备门禁服务不存在。

- [ ] **步骤 3：实现汇总门禁**

服务输出只包含 ID、状态、哈希和稳定原因码：

```js
{
  ok,
  version_id,
  character_plan_hash,
  ready_shot_ids,
  missing: [{ resource_type, resource_id, reason_code, anchor }],
}
```

`redrawReviewService.evaluateGenerationGate()` 先调用准备门禁，再执行现有资产审批检查。任何 `stale` 镜头在费用冻结前失败。

- [ ] **步骤 4：运行联合测试**

```bash
node --test --test-concurrency=1 test/redrawPreparationGate.test.js test/redrawReviewGate.test.js test/redrawReferenceBundle.test.js
```

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add backend-node/src/services/redrawPreparationGateService.js backend-node/src/services/redrawReviewService.js backend-node/test/redrawPreparationGate.test.js backend-node/test/redrawReviewGate.test.js
git commit -m "feat(转绘): 固化整集参考准备门禁"
```

## 任务 6：编排逐镜净景与参考包准备

**文件：**

- 创建：`backend-node/src/services/redrawReferencePreparationOrchestrator.js`
- 创建：`backend-node/test/redrawReferencePreparationOrchestration.test.js`
- 修改：`backend-node/src/services/redrawAssetService.js`
- 修改：`backend-node/src/services/redrawReferenceBundleService.js`

- [ ] **步骤 1：编写编排红灯测试**

```js
test('auto 只准备缺失镜头并在证据完整后保存参考包', async () => {
  const result = await prepareVersionReferences(ctx, {
    version_id: versionId,
    idempotency_key: 'prep-v1',
  }, fakeDeps);
  assert.deepEqual(result.prepared_shot_ids, [shot2.id, shot3.id]);
  assert.deepEqual(result.reused_shot_ids, [shot1.id]);
  assert.equal(fakeDeps.cleanCalls.length, 2);
  assert.equal(fakeDeps.bundleCalls.length, 2);
});
```

覆盖：A 模式等待确认、B 低置信度降级、净景明确失败、净景结果不明进入 `needs_attention`、部分成功恢复、幂等重放、并发 CAS、上游版本改变中止且不保存包。

- [ ] **步骤 2：运行红灯**

```bash
node --test --test-concurrency=1 test/redrawReferencePreparationOrchestration.test.js
```

预期：FAIL，编排器不存在。

- [ ] **步骤 3：实现逐镜编排器**

导出固定接口：

```js
module.exports = {
  quoteVersionPreparation,
  startVersionPreparation,
  prepareVersionReferences,
  reconcileInterruptedPreparations,
};
```

执行顺序：

1. 校验 owner、版本、项目策略和角色计划哈希；
2. 读取已审核全帧覆盖；
3. 为缺失人物/文字净化创建现有资产任务；
4. 等待确定终态；
5. 使用现有 `saveReferenceBundle()` 生成当前包；
6. 写 `reference_ready` 和 `preparation_evidence_hash`；
7. 追加 workflow event；
8. 单镜失败不回滚其他已完成镜头。

供应商状态未知时保持原 reservation 和候选，不创建新任务。

- [ ] **步骤 4：运行测试**

```bash
node --test --test-concurrency=1 test/redrawReferencePreparationOrchestration.test.js test/redrawAssets.test.js test/redrawReferenceBundle.test.js test/redrawPreparationGate.test.js
node --check src/services/redrawReferencePreparationOrchestrator.js
```

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add backend-node/src/services/redrawReferencePreparationOrchestrator.js backend-node/src/services/redrawAssetService.js backend-node/src/services/redrawReferenceBundleService.js backend-node/test/redrawReferencePreparationOrchestration.test.js
git commit -m "feat(转绘): 编排逐镜净景与参考包"
```

## 任务 7：接通准备 API 与角色/逐镜工作台

**文件：**

- 创建：`frontweb/src/components/redraw/RedrawCharacterLibraryPanel.vue`
- 创建：`frontweb/src/components/redraw/RedrawShotPreparationPanel.vue`
- 创建：`frontweb/test/redrawPreparationWorkspace.test.js`
- 修改：`backend-node/src/routes/redraw.js`
- 修改：`backend-node/src/routes/index.js`
- 修改：`backend-node/test/redrawRoutes.test.js`
- 修改：`frontweb/src/api/redraw.js`
- 修改：`frontweb/src/views/RedrawWorkspace.vue`
- 修改：`frontweb/src/components/redraw/RedrawAssetStep.vue`
- 修改：`frontweb/src/components/redraw/RedrawShotStep.vue`
- 修改：`frontweb/src/utils/redrawCharacterIdentity.js`
- 修改：`frontweb/src/utils/redrawShotState.js`

- [ ] **步骤 1：编写路由和前端红灯测试**

新增路由合同：

```text
GET  /redraw/versions/:id/character-plan
GET  /redraw/versions/:id/preparation-gate
POST /redraw/versions/:id/reference-preparation-quote
POST /redraw/versions/:id/reference-preparations
```

前端断言角色卡显示姓名、身份、声音、服装四项；镜头卡显示人物覆盖、文字覆盖、净景、参考包、失效原因和返工范围。

- [ ] **步骤 2：运行红灯**

```bash
cd backend-node
node --test --test-concurrency=1 test/redrawRoutes.test.js
cd ..
node --test frontweb/test/redrawPreparationWorkspace.test.js frontweb/test/redrawCharacterIdentity.test.js frontweb/test/redrawShots.test.js
```

预期：FAIL，新 API 和组件不存在。

- [ ] **步骤 3：实现严格 API**

准备执行请求只允许：

```js
['quote_hash', 'idempotency_key', 'shot_ids']
```

拒绝客户端提交 model、provider、price、reservation、reference bundle hash、路径和 URL。`shot_ids` 必须属于当前 owner/version。

- [ ] **步骤 4：实现工作台交互**

- A 模式逐项确认后启用准备按钮；
- B 模式显示自动推进与降级原因；
- `stale` 镜头显示上游变更来源和“只返工此镜头”；
- `needs_attention` 不显示重试按钮，只显示人工核对入口；
- 所有预计积分来自服务端报价。

- [ ] **步骤 5：运行联合测试和构建**

```bash
cd backend-node
node --test --test-concurrency=1 test/redrawRoutes.test.js test/redrawCharacterPlan.test.js test/redrawPreparationGate.test.js test/redrawReferencePreparationOrchestration.test.js
cd ..
node --test frontweb/test/redrawPreparationWorkspace.test.js frontweb/test/redrawCharacterIdentity.test.js frontweb/test/redrawShots.test.js
npm --prefix frontweb run build
```

预期：PASS。

- [ ] **步骤 6：提交**

```bash
git add backend-node/src/routes/redraw.js backend-node/src/routes/index.js backend-node/test/redrawRoutes.test.js frontweb/src/api/redraw.js frontweb/src/views/RedrawWorkspace.vue frontweb/src/components/redraw/RedrawCharacterLibraryPanel.vue frontweb/src/components/redraw/RedrawShotPreparationPanel.vue frontweb/src/components/redraw/RedrawAssetStep.vue frontweb/src/components/redraw/RedrawShotStep.vue frontweb/src/utils/redrawCharacterIdentity.js frontweb/src/utils/redrawShotState.js frontweb/test/redrawPreparationWorkspace.test.js
git commit -m "feat(转绘): 接通角色与逐镜参考工作台"
```

## 任务 8：完成任意镜头数量的本地参考准备验收

**文件：**

- 修改：`frontweb/e2e/fixtures/redraw-generic-project.js`
- 修改：`frontweb/e2e/redraw-backend-integration.spec.js`
- 修改：`backend-node/test/redrawReferenceBundleLocalCase.test.js`

- [ ] **步骤 1：扩展 3 镜夹具**

为角色 `c1/c2` 创建独立身份、声音和服装测试资产；为 3 镜生成 PNG 代表帧、人物遮罩、文字遮罩和净景，全部使用临时目录和真实 SHA-256。

- [ ] **步骤 2：执行本地编排验收**

断言：

- 2 个角色计划均 ready；
- 3 镜均形成当前参考包；
- 3 镜的 `preparation_state=reference_ready`；
- 修改 `c1` 身份后只失效引用 `c1` 的镜头；
- 重新准备后全部恢复；
- manifest 和 API 响应无绝对路径、URL、Key 和 Authorization；
- 没有视频生成请求。

- [ ] **步骤 3：运行计划 2 联合验证**

```bash
cd backend-node
node --test --test-concurrency=1 test/redrawMigration.test.js test/redrawCharacterPlan.test.js test/redrawCharacterIdentity.test.js test/redrawDependencyInvalidation.test.js test/redrawFullFrameCoverage.test.js test/redrawFullFrameReview.test.js test/redrawAssets.test.js test/redrawReferenceBundle.test.js test/redrawPreparationGate.test.js test/redrawReferencePreparationOrchestration.test.js test/redrawRoutes.test.js
cd ..
node --test frontweb/test/redrawPreparationWorkspace.test.js frontweb/test/redrawCharacterIdentity.test.js frontweb/test/redrawShots.test.js
npm --prefix frontweb run build
npm --prefix frontweb run test:e2e -- redraw-backend-integration.spec.js
git diff --check
```

预期：全部 PASS；无真实供应商调用。

- [ ] **步骤 4：提交验收更新**

```bash
git add frontweb/e2e/fixtures/redraw-generic-project.js frontweb/e2e/redraw-backend-integration.spec.js backend-node/test/redrawReferenceBundleLocalCase.test.js
git commit -m "test(转绘): 验收通用逐镜参考准备链路"
```

## 计划 2 完成标准

- 每个源人物唯一绑定目标姓名、成年虚构身份、声音和服装。
- 全帧覆盖和审核支持任意镜头数量，不含固定 9 镜逻辑。
- 每镜拥有当前净景、文字净化、动作、构图、身份和对白参考包。
- 上游变化只失效受影响镜头，旧候选和旧证据保留。
- A 模式等待确认，B 模式只在证据完整时自动推进。
- 通用 3 镜夹具达到 `reference_ready`，没有调用视频供应商。
