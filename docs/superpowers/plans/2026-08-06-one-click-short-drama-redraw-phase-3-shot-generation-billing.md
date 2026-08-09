# 一键转绘阶段 3：分镜生成与计费实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 交付竞品级分镜管理和镜头生成：批次、10–15 秒段落、资产引用、动作连续性、单镜/批量任务、失败重试、报价冻结结算释放和幂等恢复。

**架构：** 分镜服务只操作已批准本地化版本的 `redraw_shots`，提交时生成不可变镜头快照。生成服务调用现有视频任务/供应商适配器，账单服务在同一 operation key 下复用 `creditLedgerService`，状态由后端任务与视频产物回读驱动。

**技术栈：** Node.js、better-sqlite3、现有 `videoService.js`、`taskService.js`、`creditLedgerService.js`、Vue 3、Element Plus、Node Test Runner、Playwright。

---

## 文件结构

- 创建：`backend-node/src/services/redrawShotService.js`：镜头归一化、引用解析、批次和版本快照。
- 创建：`backend-node/src/services/redrawBillingService.js`：镜头报价、冻结、结算、释放和幂等键。
- 创建：`backend-node/src/services/redrawGenerationService.js`：单镜/批量视频任务、供应商回读和失败恢复。
- 修改：`backend-node/src/services/redrawOrchestrator.js`：调用分镜和视频生成编排。
- 修改：`backend-node/src/routes/redraw.js`：分镜读取、更新、单镜/批量生成预检与提交。
- 创建：`backend-node/test/redrawShots.test.js`：分镜合同、引用和批次测试。
- 创建：`backend-node/test/redrawShotBilling.test.js`：报价、幂等、结算和释放测试。
- 创建：`backend-node/test/redrawGeneration.test.js`：任务回读、失败和重启恢复测试。
- 修改：`backend-node/test/redrawReviewGate.test.js`：阶段 3 门禁调用测试。
- 创建：`frontweb/src/components/redraw/RedrawShotStep.vue`：第三步工作台。
- 创建：`frontweb/src/components/redraw/RedrawShotEditor.vue`：提示词、台词、引用和时间码编辑器。
- 创建：`frontweb/src/components/redraw/RedrawBatchPanel.vue`：批次筛选和批量提交。
- 创建：`frontweb/src/components/redraw/RedrawShotPreview.vue`：原片/新片时间码对照。
- 创建：`frontweb/src/utils/redrawShotState.js`：引用解析、状态标签和报价汇总。
- 修改：`frontweb/src/api/redraw.js`：分镜和生成 API。
- 修改：`frontweb/src/views/RedrawWorkspace.vue`：挂载第三步并执行门禁。
- 创建：`frontweb/test/redrawShots.test.js`：第三步 UI 合同测试。
- 修改：`frontweb/e2e/redraw-workspace.spec.js`：扩展第三步浏览器流程。

### 任务 1：归一化分镜和资产引用

**文件：**
- 创建：`backend-node/src/services/redrawShotService.js`
- 测试：`backend-node/test/redrawShots.test.js`

- [x] **步骤 1：编写失败的分镜合同测试**

```js
test('分镜保留源时间码、开场动作和镜尾状态', () => {
  const shot = normalizeShot({ start_ms: 0, end_ms: 12000, opening_state: '门关着', continuous_action: '她推门', ending_state: '门打开', references: ['@Maya', '@旧仓库'] }, context);
  assert.equal(shot.duration_ms, 12000);
  assert.deepEqual(shot.references.map(x => x.kind), ['character', 'scene']);
});

test('未知 @ 引用被拒绝而不是静默当普通文本', () => {
  assert.throws(() => parseShotReferences('@不存在'), /未知资产/);
});
```

- [x] **步骤 2：运行测试确认失败**

运行：`cd backend-node; node --test test/redrawShots.test.js`

预期：FAIL，提示找不到镜头服务。

- [x] **步骤 3：实现镜头服务**

导出 `normalizeShot(input, context)`、`parseShotReferences(text, approvedAssets)`、`groupShotsIntoBatches(shots, 10_000, 15_000)`、`snapshotShots(db, versionId)`。镜头字段必须完整覆盖规格第 6.3 章；源台词与本地化台词分列保存；每个引用保存 `asset_id/version_number/approval_status`。

- [x] **步骤 4：实现批次边界和并发快照**

自动分析生成的相邻镜头按 10–15 秒目标分批，用户手动调整后不强制重切；提交生成时复制 prompt、negative prompt、references、model、duration、resolution、count 和报价快照，编辑新版本不改变运行中的快照。

- [x] **步骤 5：运行测试并提交**

运行：`cd backend-node; node --test test/redrawShots.test.js`，预期 PASS。

```powershell
git add backend-node/src/services/redrawShotService.js backend-node/test/redrawShots.test.js
git diff --cached --check
git commit -m "feat: 增加转绘分镜与资产引用"
```

### 任务 2：实现报价和幂等计费服务

**文件：**
- 创建：`backend-node/src/services/redrawBillingService.js`
- 测试：`backend-node/test/redrawShotBilling.test.js`

- [x] **步骤 1：编写失败的计费测试**

```js
test('同一镜头和参数重复提交只产生一个冻结', () => {
  const first = quoteAndReserve(db, requestInput);
  const second = quoteAndReserve(db, requestInput);
  assert.equal(second.reservation_id, first.reservation_id);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM tenant_usage_reservations').get().count, 1);
});

test('失败释放、成功结算并返回三项余额字段', () => {
  const reservation = quoteAndReserve(db, requestInput);
  settle(db, reservation, 'failed', 'provider_failed');
  assert.deepEqual(readBilling(db, reservation.reservation_id), { held: 0, charged: 0, released: reservation.amount });
});
```

- [x] **步骤 2：运行测试确认失败**

运行：`cd backend-node; node --test test/redrawShotBilling.test.js`

预期：FAIL，提示找不到计费服务。

- [x] **步骤 3：实现报价快照和 operation key**

导出 `quoteShotGeneration(db, input)`、`quoteBatchGeneration(db, input)`、`reserveShotGeneration(db, input)`、`settleShotGeneration(db, reservationId, outcome, reason)`。报价输入包含模型、时长、清晰度、数量、locale、style snapshot 和 shot IDs；定价缺失返回 `pricing_unconfigured`，不创建 reservation。

operation key 使用：

```js
const operationKey = ['redraw-shot', tenantId, versionId, shotId, inputHash, attempt].join(':');
```

服务必须调用现有 `creditLedgerService.reserve/settleGeneration`，不自行更新余额表。

- [x] **步骤 4：运行计费测试和既有账本回归**

运行：`cd backend-node; node --test test/redrawShotBilling.test.js test/creditLedger.test.js test/videoBilling.test.js`

预期：PASS，既有 reservation 唯一键行为不变。

- [x] **步骤 5：提交计费服务**

```powershell
git add backend-node/src/services/redrawBillingService.js backend-node/test/redrawShotBilling.test.js
git diff --cached --check
git commit -m "feat: 增加转绘分镜幂等计费"
```

### 任务 3：实现单镜视频生成

**文件：**
- 创建：`backend-node/src/services/redrawGenerationService.js`
- 修改：`backend-node/src/services/redrawOrchestrator.js`
- 测试：`backend-node/test/redrawGeneration.test.js`

- [x] **步骤 1：编写失败的单镜任务测试**

```js
test('未通过资产门禁时不调用供应商', async () => {
  await assert.rejects(() => generateShot(ctx, { shot_id: 1, gate: { ok: false, missing: [{ kind: 'voice' }] } }), /资产审核/);
  assert.equal(provider.calls, 0);
  assert.equal(countReservations(db), 0);
});

test('成功必须验证视频文件并写回 shot', async () => {
  const result = await generateShot(ctx, approvedInput);
  assert.equal(result.status, 'completed');
  assert.ok(readShot(db).video_generation_id);
  assert.ok(readAsset(db, result.asset_id).readable);
});
```

- [x] **步骤 2：运行测试确认失败**

运行：`cd backend-node; node --test test/redrawGeneration.test.js`

预期：FAIL，提示找不到生成服务。

- [x] **步骤 3：实现单镜提交顺序**

`generateShot` 先读取 shot/version、调用 `evaluateGenerationGate`、生成 quote、reserve，再创建 `async_tasks(type='redraw_shot')` 与现有 video generation 记录。供应商输入使用编译后的 prompt、负面词、资产受控 URL、目标比例、时长、分辨率和数量 1。

- [x] **步骤 4：实现成功/失败终态**

成功条件同时要求供应商成功终态、视频文件可读、FFprobe 时长与分辨率可读；写回 `video_generation_id`、asset 引用和 `status='completed'` 后结算。明确失败释放，结果不完整或状态未知写 `needs_attention` 并保持账单 held。

- [x] **步骤 5：运行单镜测试并提交**

运行：`cd backend-node; node --test test/redrawGeneration.test.js test/videoRecovery.test.js`，预期 PASS。

```powershell
git add backend-node/src/services/redrawGenerationService.js backend-node/src/services/redrawOrchestrator.js backend-node/test/redrawGeneration.test.js
git diff --cached --check
git commit -m "feat: 增加转绘单镜视频生成"
```

### 任务 4：实现批量生成、重试和恢复

**文件：**
- 修改：`backend-node/src/services/redrawGenerationService.js`
- 修改：`backend-node/src/services/redrawBillingService.js`
- 修改：`backend-node/src/services/taskService.js`
- 测试：`backend-node/test/redrawGeneration.test.js`

- [x] **步骤 1：编写失败的批量与重试测试**

```js
test('批量只提交通过门禁且未完成的镜头', async () => {
  const result = await generateBatch(ctx, { version_id: 7, shot_ids: [1, 2, 3] });
  assert.deepEqual(provider.submittedShotIds, [1, 3]);
  assert.equal(result.billing.held, sumQuote([1, 3]));
});

test('重试失败镜头创建新 attempt 但不重复结算旧任务', async () => {
  const retry = await retryShot(ctx, 2);
  assert.equal(retry.attempt, 2);
  assert.equal(countConfirmedForShot(db, 2), 0);
});
```

- [x] **步骤 2：运行测试确认失败**

运行：`cd backend-node; node --test --test-name-pattern="批量|重试" test/redrawGeneration.test.js`

预期：FAIL，提示批量函数不存在。

- [x] **步骤 3：实现批量快照和并发上限**

批量提交在事务内锁定版本快照，筛选 `status NOT IN ('completed','processing')`，逐镜预检门禁和报价；按现有任务能力设置有限并发，不在循环内绕过账本。返回每镜 `shot_id/task_id/status/billing`。

- [x] **步骤 4：实现恢复扫描**

服务启动扫描 `redraw_shot` 的供应商任务 ID；成功回读并验证文件后完成，明确失败释放，未知状态写 `needs_attention`。同一 task ID 不再次调用 provider；retry 只对 failed 镜头递增 attempt 并生成新 operation key。

- [x] **步骤 5：运行恢复/计费回归并提交**

运行：`cd backend-node; node --test test/redrawGeneration.test.js test/redrawShotBilling.test.js test/taskService.test.js`，预期 PASS。

```powershell
git add backend-node/src/services/redrawGenerationService.js backend-node/src/services/redrawBillingService.js backend-node/src/services/taskService.js backend-node/test/redrawGeneration.test.js
git diff --cached --check
git commit -m "feat: 增加转绘批量生成与任务恢复"
```

### 任务 5：实现第三步 API

**文件：**
- 修改：`backend-node/src/routes/redraw.js`
- 修改：`backend-node/test/redrawRoutes.test.js`

- [x] **步骤 1：编写失败的 API 测试**

覆盖 `GET /redraw/works/:id` 返回 shots/batches、`PUT /redraw/shots/:id` 乐观锁、`POST /redraw/shots/:id/generate`、`POST /redraw/works/:id/generate-batch`。断言未审批返回 409/结构化 missing，积分不足返回 402，重复 operation 返回原 task。

- [x] **步骤 2：运行测试确认失败**

运行：`cd backend-node; node --test test/redrawRoutes.test.js`

预期：FAIL，提示路由 handler 不存在。

- [x] **步骤 3：实现路由**

更新接口要求 `updated_at` 或 `version`；生成接口统一调用 service，不在 route 中创建供应商任务或操作余额。所有响应使用总索引中的成功结构和错误字段 `code/message/details`。

- [x] **步骤 4：运行后端回归并提交**

运行：`cd backend-node; node --test test/redrawRoutes.test.js test/redrawReviewGate.test.js`，预期 PASS。

```powershell
git add backend-node/src/routes/redraw.js backend-node/test/redrawRoutes.test.js
git diff --cached --check
git commit -m "feat: 暴露转绘分镜生成接口"
```

### 任务 6：实现第三步 UI

**文件：**
- 创建：`frontweb/src/components/redraw/RedrawShotStep.vue`
- 创建：`frontweb/src/components/redraw/RedrawShotEditor.vue`
- 创建：`frontweb/src/components/redraw/RedrawBatchPanel.vue`
- 创建：`frontweb/src/components/redraw/RedrawShotPreview.vue`
- 创建：`frontweb/src/utils/redrawShotState.js`
- 修改：`frontweb/src/api/redraw.js`
- 修改：`frontweb/src/views/RedrawWorkspace.vue`
- 创建：`frontweb/test/redrawShots.test.js`
- 修改：`frontweb/e2e/redraw-workspace.spec.js`

- [x] **步骤 1：编写失败的 UI 测试**

断言页面包含批次、源视频缩略图、原片/新片切换、10–15 秒分镜、`@角色/@场景/@物品` 自动提示、开场/连续动作/镜尾字段、模型/时长/清晰度/数量、逐镜积分和批量总价。

- [x] **步骤 2：运行测试确认失败**

运行：`cd frontweb; node --test test/redrawShots.test.js`

预期：FAIL，提示组件不存在。

- [x] **步骤 3：实现编辑器和引用提示**

编辑器把引用保存为结构化对象，不依赖显示文本；输入 `@` 时从当前版本 approved 资产中过滤，保存前显示引用版本。时间码使用数值输入和稳定宽高，错误镜头保持独立重试按钮。

- [x] **步骤 4：实现批次面板和计费展示**

批量面板显示未完成/失败/已完成筛选和总报价明细；未定价或资产门禁失败时按钮禁用并显示原因。所有按钮使用现有图标库，生成按钮旁显示醒目预计扣分。

- [x] **步骤 5：实现对照预览和刷新恢复**

按相同时间码切换原视频/新视频；任务轮询只读取后端状态，成功前不假设产物 URL，刷新从 `getWork` 恢复当前批次和 selected shot。

- [x] **步骤 6：运行前端测试、构建和 E2E**

运行：`cd frontweb; node --test test/redrawShots.test.js test/redrawAssets.test.js; npm run build; npx playwright test e2e/redraw-workspace.spec.js --project=chromium`

预期：全部 PASS，无布局重叠、无未处理控制台错误。

- [x] **步骤 7：提交第三步 UI**

```powershell
git add frontweb/src/components/redraw/RedrawShotStep.vue frontweb/src/components/redraw/RedrawShotEditor.vue frontweb/src/components/redraw/RedrawBatchPanel.vue frontweb/src/components/redraw/RedrawShotPreview.vue frontweb/src/utils/redrawShotState.js frontweb/src/api/redraw.js frontweb/src/views/RedrawWorkspace.vue frontweb/test/redrawShots.test.js frontweb/e2e/redraw-workspace.spec.js
git diff --cached --check
git commit -m "feat: 交付转绘分镜管理与批量生成"
```

### 任务 7：阶段 3 真实生成和计费审计

> 当前状态：`blocked`。真实本地化编排、应用级资产报价/供应商接入、当前版本已审批资产链和 verified 视频同链证据尚不完整；本轮未获授权发起新的付费模型调用，因此以下步骤保持未完成。

- [ ] **步骤 1：使用已审批资产提交一个真实分镜**

选用已通过阶段 2 证据的语言、风格、视频模型和音色；完成一镜真实生成，等待成功终态，验证视频可读、时长和分辨率正确。

- [ ] **步骤 2：执行幂等和失败注入**

重复相同请求，预期 provider task 数和 reservation 数均不增加；注入供应商失败，预期该镜释放积分、其他镜头不变；注入未知状态，预期 `needs_attention` 且 held 不自动释放。

- [ ] **步骤 3：执行重启恢复**

在 provider 任务处理中重启 backend，预期回读原 task ID 并继续轮询，不重复提交；成功后资产可回读、shot 终态和账本一致。

- [ ] **步骤 4：运行阶段回归并审计**

重跑本计划任务 5-6 的命令、`git diff --check` 和 `npm test` 相关测试。任何真实视频模型未成功时，不把该模型标为 `verified`，阶段产品状态保持阻塞。
