# 一键转绘阶段 2：本地化与资产审核实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把源片事实层转换为目标语言和地区的忠实本地化版本，生成角色、场景、物品、去人净景和角色音色，并以强制人工审核阻止未确认资产进入视频生成。

**架构：** 本地化服务只读取源片事实层并产出新版本，不拥有修改事实层的接口。资产服务按资产种类复用现有图片/音频生成能力，每次尝试写独立版本；审核服务根据分镜引用计算缺失清单，成为阶段 3 所有生成入口共用的后端门禁。

**技术栈：** Node.js、better-sqlite3、现有 AI 文本/图片/音频服务、Sharp、Vue 3、Element Plus、Node Test Runner、Playwright。

---

## 文件结构

- 创建：`backend-node/src/services/localizationService.js`：事实保护、术语、人名、文化映射、台词与时长校验。
- 创建：`backend-node/src/services/redrawAssetService.js`：角色/场景/物品版本、三视图、去人净景和生成状态。
- 创建：`backend-node/src/services/redrawVoiceService.js`：目标语言音色目录、真实 TTS 证据和角色音色快照。
- 创建：`backend-node/src/services/redrawReviewService.js`：审核状态和被引用资产缺失清单。
- 修改：`backend-node/src/services/redrawOrchestrator.js`：本地化、资产图片和 TTS 任务编排。
- 修改：`backend-node/src/routes/redraw.js`：版本、资产更新/生成/审核 API。
- 修改：`backend-node/src/routes/index.js`：挂载阶段 2 路由。
- 创建：`backend-node/test/redrawLocalization.test.js`：事实锁、语言、术语和时长测试。
- 创建：`backend-node/test/redrawAssets.test.js`：资产版本、去人、生成失败和所有权测试。
- 创建：`backend-node/test/redrawVoices.test.js`：音色证据、固定映射和时长测试。
- 创建：`backend-node/test/redrawReviewGate.test.js`：强制审核缺失清单测试。
- 创建：`frontweb/src/components/redraw/RedrawAssetStep.vue`：第二步总视图。
- 创建：`frontweb/src/components/redraw/RedrawAssetCard.vue`：统一资产卡片、版本、生成和审核。
- 创建：`frontweb/src/components/redraw/RedrawVoicePicker.vue`：音色选择、试听和能力阻塞。
- 创建：`frontweb/src/components/redraw/RedrawReviewGate.vue`：缺失清单和定位入口。
- 创建：`frontweb/src/utils/redrawAssetState.js`：资产显示、引用和门禁纯函数。
- 修改：`frontweb/src/api/redraw.js`：阶段 2 API。
- 修改：`frontweb/src/views/RedrawWorkspace.vue`：挂载第二步并恢复审核状态。
- 创建：`frontweb/test/redrawAssets.test.js`：资产 UI、积分合同和门禁测试。
- 修改：`frontweb/e2e/redraw-workspace.spec.js`：扩展第二步浏览器流程。

### 任务 1：实现事实保护与忠实本地化结构

**文件：**
- 创建：`backend-node/src/services/localizationService.js`
- 测试：`backend-node/test/redrawLocalization.test.js`

- [ ] **步骤 1：编写失败的事实保护测试**

```js
test('本地化不得改变人物关系、因果、反转和钩子', () => {
  const result = validateLocalizedFacts(sourceFacts, localizedWithChangedCausality);
  assert.equal(result.ok, false);
  assert.deepEqual(result.conflicts[0].path, 'causal_chain[0]');
});

test('允许地区化姓名货币和机构但保留锁定事实', () => {
  const result = validateLocalizedFacts(sourceFacts, faithfulLocalizedFacts);
  assert.equal(result.ok, true);
  assert.equal(result.value.name_map['小满'], 'Maya');
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd backend-node; node --test test/redrawLocalization.test.js`

预期：FAIL，提示找不到 `localizationService`。

- [ ] **步骤 3：实现本地化输入、输出和比较器**

导出：

```js
function buildLocalizationInput(sourceFacts, { locale, market, styleSnapshot }) { /* 明确允许/禁止规则 */ }
function normalizeLocalizationResult(raw, sourceFacts) { /* 生成 glossary/name_map/culture_map/dialogue */ }
function validateLocalizedFacts(sourceFacts, localized) { /* 返回 { ok, conflicts, value } */ }
function createLocalizationVersion(db, owner, workId, input) { /* 只追加，不 UPDATE source_facts_json */ }
```

比较器使用源事实的稳定 ID 比较 `relationships`、`causal_chain`、`reversals`、`episode_hook` 和 `locked_facts`，不用自然语言字符串猜测。允许变化只写入 `name_map_json`、`culture_map_json`、`glossary_json` 和镜头 `localized_dialogue_json`。

- [ ] **步骤 4：运行事实测试验证通过**

运行：`cd backend-node; node --test test/redrawLocalization.test.js`

预期：PASS，冲突返回具体 path、source_value、localized_value。

- [ ] **步骤 5：提交本地化核心**

```powershell
git add backend-node/src/services/localizationService.js backend-node/test/redrawLocalization.test.js
git diff --cached --check
git commit -m "feat: 增加忠实本地化事实保护"
```

### 任务 2：实现目标语言台词改写和时长质检

**文件：**
- 修改：`backend-node/src/services/localizationService.js`
- 修改：`backend-node/test/redrawLocalization.test.js`

- [ ] **步骤 1：编写失败的台词质检测试**

```js
test('台词保留说话顺序并在可说时长内', () => {
  const check = validateLocalizedDialogue(sourceTurn, localizedTurn, { locale: 'es-419', maxSpeechRate: 1.12 });
  assert.equal(check.ok, true);
  assert.equal(check.turns.map(x => x.speaker_id).join(','), 'c1,c2,c1');
});

test('超速台词退回改写而不是改变视频速度', () => {
  const check = validateLocalizedDialogue(sourceTurn, tooLongTurn, { locale: 'en-US', maxSpeechRate: 1.12 });
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'dialogue_duration_exceeded');
});
```

- [ ] **步骤 2：运行目标测试确认失败**

运行：`cd backend-node; node --test --test-name-pattern="台词" test/redrawLocalization.test.js`

预期：FAIL，提示 `validateLocalizedDialogue is not a function`。

- [ ] **步骤 3：实现地区语言和时长规则**

语言目录包含规格中的 15 种语言和主要地区变体；每个对话 turn 保存 `speaker_id/source_text/localized_text/start_ms/end_ms/emotion/overlap_group`。先用目标语言估算器检查，再用真实 TTS 音频时长复核；超过阈值返回 `needs_rewrite`，禁止通过调整视频播放速度绕过。

- [ ] **步骤 4：运行本地化测试验证通过**

运行：`cd backend-node; node --test test/redrawLocalization.test.js`

预期：PASS，覆盖英语、西班牙语、阿拉伯语 RTL 和多人重叠对白。

- [ ] **步骤 5：提交台词质检**

```powershell
git add backend-node/src/services/localizationService.js backend-node/test/redrawLocalization.test.js
git diff --cached --check
git commit -m "feat: 增加外语台词改写与时长校验"
```

### 任务 3：实现角色、场景和物品资产版本

**文件：**
- 创建：`backend-node/src/services/redrawAssetService.js`
- 修改：`backend-node/src/services/redrawOrchestrator.js`
- 测试：`backend-node/test/redrawAssets.test.js`

- [ ] **步骤 1：编写失败的资产版本测试**

```js
test('资产重绘追加版本且不覆盖上一可用产物', async () => {
  const v1 = await generateAsset(ctx, characterAsset);
  const v2 = await generateAsset(ctx, { ...characterAsset, prompt: 'new prompt' });
  assert.equal(v2.version_number, 2);
  assert.equal(readAssetVersion(db, v1.id).asset_id, v1.asset_id);
});

test('图片不可读时任务失败并释放积分', async () => {
  await assert.rejects(() => finalizeAssetGeneration(ctx, unreadableProviderResult), /不可读取/);
  assert.equal(readReservation(db).status, 'refunded');
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd backend-node; node --test test/redrawAssets.test.js`

预期：FAIL，提示找不到资产服务。

- [ ] **步骤 3：实现资产生成合同**

`redrawAssetService` 导出 `listAssets/updateAsset/createAssetAttempt/finalizeAssetAttempt/listAssetVersions`。角色生成输出正面/侧面/背面三视图及一致性元数据；场景输出本地化场景；物品输出本地化物品和屏幕文字替换。每次生成使用风格、地区、资产提示词和参考图的不可变快照。

- [ ] **步骤 4：接入现有图片生成与计费**

编排器复用现有图片服务的真实任务和 `creditLedgerService.reserve/settleGeneration`，不复制供应商客户端。结果必须写入现有 `assets` 并能通过受控 URL读取，才把 `redraw_assets.status` 置为 `generated`。

- [ ] **步骤 5：运行资产测试验证通过并提交**

运行：`cd backend-node; node --test test/redrawAssets.test.js test/assetImageBilling.test.js`，预期 PASS。

```powershell
git add backend-node/src/services/redrawAssetService.js backend-node/src/services/redrawOrchestrator.js backend-node/test/redrawAssets.test.js
git diff --cached --check
git commit -m "feat: 增加转绘本地化资产版本"
```

### 任务 4：实现场景去人净景

**文件：**
- 修改：`backend-node/src/services/redrawAssetService.js`
- 修改：`backend-node/src/services/redrawOrchestrator.js`
- 修改：`backend-node/test/redrawAssets.test.js`

- [ ] **步骤 1：编写失败的去人测试**

```js
test('去人净景使用人物遮罩并保留源场景版本', async () => {
  const result = await generateCleanPlate(ctx, sceneAsset, { mask_asset_id: 'mask-1' });
  assert.ok(result.clean_plate_asset_id);
  assert.equal(result.source_asset_id, sceneAsset.source_asset_id);
  assert.equal(result.approval_status, 'needs_review');
});

test('没有可审计遮罩时不提交去人生成', async () => {
  await assert.rejects(() => generateCleanPlate(ctx, sceneAsset, {}), /人物遮罩/);
  assert.equal(provider.calls, 0);
});
```

- [ ] **步骤 2：运行目标测试确认失败**

运行：`cd backend-node; node --test --test-name-pattern="去人" test/redrawAssets.test.js`

预期：FAIL，提示 `generateCleanPlate is not a function`。

- [ ] **步骤 3：实现人物遮罩和净景版本**

从源场景代表帧生成或上传人物遮罩，保存 `mask_asset_id`、输入帧指纹、模型、提示词和任务 ID。调用已真实验证的修复/重绘能力生成 `clean_plate_asset_id`；不得用模糊、裁切或删除源图代替去人。源场景、本地化场景和净景三者独立可回读。

- [ ] **步骤 4：实现去人质量门禁**

自动检查输出尺寸、文件可读、遮罩区变化和非遮罩区结构相似度；通过后仍为 `needs_review`，用户人工确认建筑、家具、文字和关键道具没有被误删。失败只释放本次净景积分，不改变场景其他版本。

- [ ] **步骤 5：运行资产回归并提交**

运行：`cd backend-node; node --test test/redrawAssets.test.js test/assetImageBilling.test.js`，预期 PASS。

```powershell
git add backend-node/src/services/redrawAssetService.js backend-node/src/services/redrawOrchestrator.js backend-node/test/redrawAssets.test.js
git diff --cached --check
git commit -m "feat: 增加场景去人净景审核"
```

### 任务 5：实现目标语言音色目录和真实 TTS 门禁

**文件：**
- 创建：`backend-node/src/services/redrawVoiceService.js`
- 修改：`backend-node/src/services/redrawOrchestrator.js`
- 测试：`backend-node/test/redrawVoices.test.js`

- [ ] **步骤 1：编写失败的音色证据测试**

```js
test('未完成真实 TTS 的音色不进入生产目录', () => {
  assert.deepEqual(listProductionVoices(db, { locale: 'fr-FR' }, canReadAudio), []);
});

test('角色在同一本地化版本固定音色快照', () => {
  const selected = assignVoice(db, assetId, verifiedVoice);
  assert.equal(assignVoice(db, assetId, anotherVoice).conflict, true);
  assert.equal(selected.snapshot.voice_id, verifiedVoice.id);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd backend-node; node --test test/redrawVoices.test.js`

预期：FAIL，提示找不到音色服务。

- [ ] **步骤 3：实现音色验证和映射**

音色证据至少含 `locale/market/provider/model/voice_id/task_id/terminal_status/audio_asset_id/duration_ms`；验证音频文件可读且语言匹配后才返回生产目录。声音克隆额外要求 `authorization_asset_id`，缺少授权时接口不返回该能力。

- [ ] **步骤 4：接入真实 TTS 时长复核**

生成每个角色的审核样音；样音成功只证明该音色可用，不自动批准角色。台词批量 TTS 前再次按当前版本快照检查语言、说话人、时长和授权。

- [ ] **步骤 5：运行音色测试并提交**

运行：`cd backend-node; node --test test/redrawVoices.test.js test/canvas-audio-voice-options.test.js`，预期 PASS。

```powershell
git add backend-node/src/services/redrawVoiceService.js backend-node/src/services/redrawOrchestrator.js backend-node/test/redrawVoices.test.js
git diff --cached --check
git commit -m "feat: 增加转绘外语音色门禁"
```

### 任务 6：实现强制资产审核门禁和阶段 2 API

**文件：**
- 创建：`backend-node/src/services/redrawReviewService.js`
- 修改：`backend-node/src/routes/redraw.js`
- 修改：`backend-node/src/routes/index.js`
- 测试：`backend-node/test/redrawReviewGate.test.js`
- 修改：`backend-node/test/redrawRoutes.test.js`

- [x] **步骤 1：编写失败的门禁测试**

```js
test('返回每个未审批引用及直接定位信息', () => {
  const gate = evaluateGenerationGate(db, versionId);
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.missing[0], { kind: 'voice', asset_id: 12, shot_ids: [3], anchor: 'asset-12-voice' });
});

test('退回已引用净景会重新关闭视频生成门禁', () => {
  reviewAsset(db, sceneId, { action: 'reject', version_number: 2 });
  assert.equal(evaluateGenerationGate(db, versionId).ok, false);
});
```

- [x] **步骤 2：运行测试确认失败**

运行：`cd backend-node; node --test test/redrawReviewGate.test.js`

预期：FAIL，提示找不到审核服务。

- [x] **步骤 3：实现审核事务和路由**

`reviewAsset` 使用 `expected_updated_at` 做乐观锁，只允许 `approved/rejected`；审批写 `approved_by/approved_at/version_number`。新增版本、修改提示词、替换音色或重绘都会重置当前版本审核。开放规格中的版本创建、资产更新、资产生成、资产审核路由，并保持统一成功字段。

- [x] **步骤 4：运行后端阶段 2 回归**

运行：`cd backend-node; node --test test/redrawLocalization.test.js test/redrawAssets.test.js test/redrawVoices.test.js test/redrawReviewGate.test.js test/redrawRoutes.test.js`

预期：全部 PASS。

- [x] **步骤 5：提交审核门禁和 API**

```powershell
git add backend-node/src/services/redrawReviewService.js backend-node/src/routes/redraw.js backend-node/src/routes/index.js backend-node/test/redrawReviewGate.test.js backend-node/test/redrawRoutes.test.js
git diff --cached --check
git commit -m "feat: 强制审核转绘引用资产"
```

### 任务 7：实现资产详情 UI 和浏览器验收

**文件：**
- 创建：`frontweb/src/components/redraw/RedrawAssetStep.vue`
- 创建：`frontweb/src/components/redraw/RedrawAssetCard.vue`
- 创建：`frontweb/src/components/redraw/RedrawVoicePicker.vue`
- 创建：`frontweb/src/components/redraw/RedrawReviewGate.vue`
- 创建：`frontweb/src/utils/redrawAssetState.js`
- 修改：`frontweb/src/api/redraw.js`
- 修改：`frontweb/src/views/RedrawWorkspace.vue`
- 创建：`frontweb/test/redrawAssets.test.js`
- 修改：`frontweb/e2e/redraw-workspace.spec.js`

- [x] **步骤 1：编写失败的 UI 合同测试**

断言角色三视图、源/本地化场景、去人净景、物品文字、版本切换、音色试听、审核按钮、缺失清单、预计扣分和未定价禁用均存在；断言 UI 不会仅在前端把资产标记 approved。

- [x] **步骤 2：运行测试确认失败**

运行：`cd frontweb; node --test test/redrawAssets.test.js`

预期：FAIL，提示组件不存在。

- [x] **步骤 3：实现第二步资产视图**

资产类型使用 tabs；卡片不嵌套卡片，固定媒体比例和操作栏高度。场景卡提供“原场景 / 本地化 / 去人净景”分段切换，去人按钮使用人物移除图标并有 tooltip。所有生成动作先取服务端报价，显示加粗积分文案。

- [x] **步骤 4：实现审核缺失定位**

`RedrawReviewGate` 只渲染后端返回的 `missing`，点击条目滚动并聚焦对应 `anchor`。全部 approved 后后端返回 `current_step: 3`，前端才开放第三步；刷新重新读取。

- [x] **步骤 5：扩展浏览器测试**

覆盖生成角色版本、场景去人失败/重试、选择外语音色、逐项批准、退回后门禁重新关闭、刷新恢复版本。夹具路径只验证交互；真实 TTS/图片证据另行记录。

- [x] **步骤 6：运行前端回归和构建**

运行：`cd frontweb; node --test test/redrawFoundation.test.js test/redrawAssets.test.js; npm run build; npx playwright test e2e/redraw-workspace.spec.js --project=chromium`

预期：全部 PASS，桌面和移动无重叠、溢出或布局位移。

- [x] **步骤 7：提交阶段 2 UI**

```powershell
git add frontweb/src/components/redraw/RedrawAssetStep.vue frontweb/src/components/redraw/RedrawAssetCard.vue frontweb/src/components/redraw/RedrawVoicePicker.vue frontweb/src/components/redraw/RedrawReviewGate.vue frontweb/src/utils/redrawAssetState.js frontweb/src/api/redraw.js frontweb/src/views/RedrawWorkspace.vue frontweb/test/redrawAssets.test.js frontweb/e2e/redraw-workspace.spec.js
git diff --cached --check
git commit -m "feat: 交付转绘资产详情与审核"
```

### 任务 8：阶段 2 真实生成审计

- [ ] **步骤 1：验证每种使用中的能力**

使用目标 Key 分别真实生成一张角色三视图、一张本地化场景、一张去人净景、一张本地化物品和一个目标语言样音；等待成功终态并验证产物可读取。记录配置 ID、模型、任务 ID、终态、资产 ID、分辨率/时长，不记录密钥。

- [ ] **步骤 2：验证忠实本地化**

对同一真实源片逐项核对人物关系、因果、关键证据、反转和集尾钩子未改变；检查目标语言自然度、地区口语、姓名、货币和机构映射；检查台词在镜头可说时长内。

- [ ] **步骤 3：验证强制门禁**

保留一个被引用音色为未审批，调用单镜和批量生成预检，预期均返回结构化缺失项、供应商调用数不变、积分账本无新增冻结；批准后才允许进入阶段 3。

- [ ] **步骤 4：运行最终阶段 2 回归**

运行：`git diff --check`，并重跑本计划任务 6、7 的全部命令。预期无失败。真实能力任一失败时将对应目录状态保持非 `verified`，不得声称阶段产品完成。
