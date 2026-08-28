# 一键转绘 owner-scoped 补充对白审批实现计划

日期：2026-08-28

依据：`docs/superpowers/specs/2026-08-28-redraw-supplemental-dialogue-approval-design.md`（书面规格已通过）

执行边界：仅本地实现、测试、审查和本地 Git commit；不调用真实供应商、不付费、不 push、不部署、不写生产数据库。

## 0. 成功标准与保护线

完成必须证明：

- Rafael 第 6 镜 `Welcome home, son.` 通过真实 owner-scoped HTTP 审批持久化；
- `source_translation=false`，source/localized dialogue 中 Rafael 新 turn 仍为 0；
- local voice registration 接口 body 仍只有 `idempotency_key + expected_updated_at`；
- active 审批可被登记消费，缺失/撤销/篡改/漂移时 Worker 调用数为 0；
- production voice 严格证据回查包含审批 IDs/hash；
- Task 8 通过真实 router 完成五角色链，不使用 DB proxy 或 SQL 写状态；
- provider/generation/paid/billing/production write 计数为 0；
- 15 个本地媒体不存在时保留明确 skip，不冒充完整媒体验收；
- 现有 3 个 dirty Task 8 文件和 1 个 fixture 只做本任务可追溯的增量修改。

禁止：

- 修改 localization 1:1、silent-shot、speaker/timing 或 unknown-field 合同；
- 向 `source_dialogue_json` / `localized_dialogue_json` 写补句；
- 让 registration body 接收 text/evidence；
- checkout/reset/整体覆盖或整体格式化现有 Task 8 WIP；
- 供应商、网络生成、付费、push、部署或生产写入。

## 任务 1：迁移与 owner-scoped 审批服务

**文件：**

- 创建：`backend-node/migrations/70_redraw_supplemental_dialogue_approvals.sql`
- 创建：`backend-node/src/services/redrawSupplementalDialogueApprovalService.js`
- 创建：`backend-node/test/redrawSupplementalDialogueApproval.test.js`
- 修改：`backend-node/test/redrawMigration.test.js`

### 1.1 RED

先写失败测试覆盖：

- 新表、CHECK、FK、幂等唯一索引和 active 语义唯一索引；
- registration 新增 `approved_dialogue_evidence_sha256` 与 `supplemental_approval_ids_json`；
- 合法 owner/current version/shot/voice/visible character 创建 active 审批；
- Rafael 第 6 镜文本 SHA、context SHA、evidence SHA 固定且可重算；
- 同幂等同摘要返回原记录，异摘要冲突；
- 同一镜头/语音槽第二条 active 审批冲突；
- tenant/user/version/shot/voice/visible character 任一错配拒绝；
- draft/非 current、localization 非 completed+advance、facts/policy/decision/CAS 漂移拒绝；
- `source_translation:true`、空文本、超限文本拒绝；
- active -> revoked、撤销重放、撤销 CAS/owner/幂等冲突；
- 撤销保留行、正文和审计，不允许 re-activate。

运行：

```powershell
Set-Location backend-node
node --test --test-concurrency=1 test/redrawMigration.test.js test/redrawSupplementalDialogueApproval.test.js
```

预期：新增测试因迁移/服务缺失 FAIL，并记录失败摘要。

### 1.2 GREEN

最小实现：

- 服务端从 version/shot/voice/source facts 派生 work、stable shot、character、locale、market；
- 用 `source_facts_json.shots[].id` 与 `visible_character_ids` 验证镜头角色；
- 规范化正文只做首尾 trim；正文不进入错误或日志；
- context/evidence/request hash 使用稳定 JSON；
- 创建与撤销均在事务内使用 CAS 和幂等保护；
- 导出创建、撤销和 public projection 的纯服务函数；
- 不修改 registration 或 voice trust 逻辑。

重复运行 1.1 命令，预期 PASS。

### 1.3 审查与提交

- 独立规格审查：字段、状态机、owner/CAS、哈希和隐私是否符合书面规格；
- 独立质量审查：SQL 注入、竞态、错误泄露、过度抽象、无关改动；
- 通过后仅提交任务 1 文件。

建议 commit：

```text
feat(redraw): persist scoped supplemental dialogue approval
```

## 任务 2：受保护审批 HTTP 接口

**文件：**

- 修改：`backend-node/src/routes/redraw.js`
- 创建：`backend-node/test/redrawSupplementalDialogueRoutes.test.js`
- 必要时最小修改：`backend-node/src/routes/index.js`

### 2.1 RED

测试真实 router、auth 和 tenant header：

- 创建请求 exact 5 keys；
- 撤销请求 exact 2 keys；
- 未登录 401，跨 owner/version/shot/voice/approval 404；
- unknown field、危险/非法文本、`source_translation:true` 为 400/422；
- CAS、幂等和 active 冲突为稳定 409；
- 创建/创建重放响应 exact keys；
- 撤销/撤销重放响应 exact keys；
- 所有响应和错误不含 `target_text`、绝对路径、命令、raw evidence；
- `/local-production-registrations` exact body 回归不变。

运行：

```powershell
Set-Location backend-node
node --test --test-concurrency=1 test/redrawSupplementalDialogueRoutes.test.js test/redrawLocalVoiceRoutes.test.js test/redrawRoutes.test.js
```

### 2.2 GREEN

- 增加创建/撤销 exact-body parser、ready check、public projection 和稳定错误映射；
- 路由只传 owner、路径 ID、CAS、幂等键和正文给审批服务；
- 不在 route 读取或写 registration/voice 状态；
- 不记录请求正文。

### 2.3 审查与提交

双审查通过后提交任务 2 文件。

建议 commit：

```text
feat(redraw): expose supplemental dialogue approval routes
```

## 任务 3：registration 合并审批证据

**文件：**

- 修改：`backend-node/src/services/redrawLocalVoiceRegistrationService.js`
- 修改：`backend-node/test/redrawLocalVoiceRegistration.test.js`

### 3.1 RED

- 普通本地化对白无补句路径保持通过；
- Rafael 没有 source/localized turn 时，active 审批可提供 approved text；
- 登记 request hash 包含 approved-dialogue evidence SHA、审批 IDs/status/hash/CAS；
- registration 行保存 evidence SHA 和有序审批 IDs；
- completed local evidence 只含审批 IDs/hash，不含正文；
- 审批缺失、revoked、正文 SHA 篡改、context/evidence/facts/policy/decision/shot/voice 漂移均拒绝；
- 上述拒绝的 local TTS Worker、locale verifier、媒体注册调用数为 0；
- 同一登记幂等键在审批变化后冲突，不执行重放 Worker；
- registration HTTP body 仍不能覆盖正文。

运行：

```powershell
Set-Location backend-node
node --test --test-concurrency=1 test/redrawLocalVoiceRegistration.test.js test/redrawLocalVoiceRoutes.test.js
```

### 3.2 GREEN

- 将 `readApprovedDialogueEvidence()` 拆成最小可审计的普通对白读取与 active supplement 读取；
- 以 `batch_index, shot_index, redraw_shot_id, approval_id` 确定顺序合成；
- 每次读取重算 context/evidence SHA；
- claim 和 finalization 前都复核审批状态，防止 Worker 执行期间撤销后仍完成；
- request hash、registration 列和 `local_offline_tts` evidence 同步绑定；
- 不修改 localization service。

### 3.3 审查与提交

双审查通过后提交任务 3 文件。

建议 commit：

```text
feat(redraw): bind local voice registration to dialogue approvals
```

## 任务 4：production voice 严格信任复核

**文件：**

- 修改：`backend-node/src/services/redrawVoiceService.js`
- 修改：`backend-node/test/redrawVoices.test.js`
- 修改：`backend-node/test/redrawVoiceAssetIntegration.test.js`
- 必要时修改：`backend-node/test/redrawVoices.routes.test.js`

### 4.1 RED

- 新 supplement local evidence exact keys 正向通过；
- 缺字段、多字段、正文键、篡改 SHA/ID/source_translation 拒绝；
- `assertCompletedLocalRegistration()` 回查 registration 列及 active approvals；
- approval 撤销/删除/跨 owner/正文或 evidence SHA 漂移后，list/assign/batch validation fail closed；
- `publicEvidence()` 不投影正文；
- `sameVoice()` / `sameEvidence()` 比较 approved-dialogue evidence SHA 和审批 IDs；
- 无补句的既有 local v1 证据仍通过；
- provider exact keys、forbidden local keys 和真实供应商证据分支不回归。

运行：

```powershell
Set-Location backend-node
node --test --test-concurrency=1 test/redrawVoices.test.js test/redrawVoiceAssetIntegration.test.js test/redrawVoices.routes.test.js
```

### 4.2 GREEN

只更新书面规格点名的严格白名单、normalize、complete check、registration/approval 回查、public projection 和 equality；不重构其他 voice provider 逻辑。

### 4.3 审查与提交

双审查通过后提交任务 4 文件。

建议 commit：

```text
feat(redraw): revalidate supplemental dialogue voice evidence
```

## 任务 5：恢复 Task 8 五角色真实 HTTP 链

**文件：**

- 修改既有 WIP：`frontweb/e2e/fixtures/redraw-local-english-voice-fixtures.js`
- 修改既有 WIP：`frontweb/e2e/redraw-live-launcher.spec.js`
- 修改既有 WIP：`frontweb/e2e/support/redraw-live-product-harness.mjs`
- 修改既有 WIP：`frontweb/scripts/run-redraw-live-product.mjs`

### 5.1 保护 dirty 基线

- 记录四文件 status、stat、diff check；
- 确认没有 DB query proxy；
- 不使用 checkout/reset/restore/整体覆盖；
- 只删除旧 fixture 伪证据字段，不删除原有用户 WIP。

### 5.2 RED

新增/调整 Playwright 断言：

- fixture 仅保留 Rafael 请求输入，不自称持久证据；
- 真实 HTTP 创建 1 条 approval，响应 exact keys 且不含正文；
- source/localized dialogue Rafael turn 均为 0；
- 五次 registration、review、bind、character review、character-plan 走真实 route；
- Rafael registration evidence 引用审批 ID/hash；
- 只读 SQL 审计 1 approval、5 registrations 和零 billing/provider 计数；
- 禁止 SQL 写/DB proxy 状态捷径；
- 15 媒体缺失仍显式 skip。

运行：

```powershell
Set-Location frontweb
npx playwright test e2e/redraw-live-launcher.spec.js --workers=1
```

### 5.3 GREEN

- harness 在 registration 前调用新审批 route；
- summary 增加 `supplemental_dialogue_approvals=1`；
- 保留已有网络守卫和所有零外部调用计数；
- 测试语音 fixture 仍明确是 test-only Microsoft Zira 文件，不冒充真实 eSpeak NG。

### 5.4 审查与提交

- 独立核对四文件相对 Task 8 基线的增量，防止丢失既有改动；
- 双审查通过后提交四文件。

建议 commit：

```text
test(redraw): approve fifth local voice through http
```

## 任务 6：完整回归与证据报告

**文件：**

- 创建：`docs/superpowers/reports/2026-08-28-redraw-supplemental-dialogue-approval-local-evidence.md`

### 6.1 回归

后端：

```powershell
Set-Location backend-node
node --test --test-concurrency=1 `
  test/redrawMigration.test.js `
  test/redrawSupplementalDialogueApproval.test.js `
  test/redrawSupplementalDialogueRoutes.test.js `
  test/redrawLocalVoiceRegistration.test.js `
  test/redrawLocalVoiceRoutes.test.js `
  test/redrawVoices.test.js `
  test/redrawVoices.routes.test.js `
  test/redrawVoiceAssetIntegration.test.js `
  test/redrawCharacterPlan.test.js `
  test/redrawReviewGate.test.js
```

前端：

```powershell
Set-Location frontweb
npx playwright test e2e/redraw-live-launcher.spec.js --workers=1
```

现有 Worker 回归沿用此前确定的本机隔离命令；Python 3.11 site `.pth` GBK 问题存在时，使用已审计的 `python -S` 测试隔离，不把宿主环境错误误报为产品通过。

### 6.2 最终审计

- `git diff --check`；
- status/diff/stat 与每个本地 commit 范围；
- 无密钥、绝对本地路径、音频正文或对白正文泄露；
- 无外部调用、付费、生产写入、push、部署；
- 独立规格审查和代码质量审查；
- 报告明确区分代码/测试 Worker 通过、真实 eSpeak NG 未验收、15 媒体显式 skip（如仍缺失）。

完成后仅报告可复核证据，不宣称项目整体 GA 或生产交付完成。
