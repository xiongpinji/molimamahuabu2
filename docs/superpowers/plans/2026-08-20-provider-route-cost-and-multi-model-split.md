# 线路成本分离与多模型配置拆分实现计划

> **面向实施代理：** 使用 `executing-plans` 逐项实施；每个行为必须先取得因能力缺失而失败的测试，再做最小修复。交付前使用 `verification-before-completion` 运行同批新鲜验证。

**目标：** 将供应商线路成本从用户逻辑模型积分价格中彻底分离，使主动巡检和业务成本账本都按最终 `config_id` 的不可变成本快照计算；同时提供默认只读、显式 CAS 才能执行的多模型配置拆分工具。

**架构：** 用户积分仍由逻辑模型价格表决定；供应商成本新增独立的按线路表和分辨率表。巡检证据的成本指纹、巡检预算预占、图片/视频/文本成功后的运营成本均读取线路成本。多模型配置拆分只在本地脚本中实现，默认 dry-run；应用时缩窄原配置为默认模型，并创建停用、未验证的单模型克隆，避免未经实测的模型进入公开目录。

**技术栈：** Node.js、Express、better-sqlite3、Vue 3、Element Plus、Node test runner、Vite、现有主动巡检与功能锁门禁。

---

## 0. 固定边界与完成判据

- 工作树固定为 `C:\Users\canqu\Documents\茉莉妈妈2\worktrees\platform-stability-proactive-canary-plan-20260818`。
- 本阶段只做本地代码、迁移、脚本、测试和文档；不连接生产、不调用供应商、不扣费、不推送、不部署、不修改生产数据。
- 不修改 AI 音乐代码、进程、配置、数据或发布目录。
- 用户积分价格仍按 `logical_model_id` 计算，现有积分预占、冻结、退款和 `canvas-credit-callout-v1` 合同不变。
- 供应商线路成本只允许管理员读取和修改；公开目录及用户响应不得出现 `config_id`、供应商、域名、协议、成本或成本指纹。
- 图片、视频、文本只有在最终成功线路明确时才写运营成本；提交结果未知、处理中、失败或缺少最终线路时不得猜测供应商成本。
- 多模型拆分默认 dry-run；`--apply` 必须提供数据库文件、目标配置和 dry-run 输出的期望指纹。指纹不一致时必须在写事务前失败。
- 拆分不得删除原配置、不得输出 Key/Base URL；新增克隆必须 `is_active=0`、`verification_status='unverified'`、`logical_model_id=NULL`。
- 完成时后端全量、前端全量、构建、定向 TDD、功能锁、增量范围和敏感信息审计必须同批通过。

---

## 任务 1：建立按线路的供应商成本数据合同

**文件：**

- 新增：`backend-node/migrations/63_provider_route_costs.sql`
- 新增：`backend-node/src/services/providerRouteCostService.js`
- 新增：`backend-node/test/providerRouteCost.test.js`
- 修改：`backend-node/test/providerRouteSchema.test.js`

### 步骤 1：先写失败测试

覆盖以下合同：

- 同一逻辑模型的两个 `config_id` 可以保存不同成本；
- 支持 `request`、`image`、`second`、`token` 四种成本单位；
- 视频分辨率成本按 `(config_id, resolution)` 精确读取；
- 缺失、零值、负值、非安全整数、未知单位和未知配置全部 fail closed；
- `quote()` 返回用于账本的脱敏不可变快照和稳定指纹，不返回 Key、Base URL 或供应商任务信息；
- 成本变更只使该 `config_id` 的巡检证据失效；
- migration 63 连续执行两次仍成功。

运行并确认红灯：

```powershell
Set-Location backend-node
node --test test/providerRouteCost.test.js test/providerRouteSchema.test.js
```

### 步骤 2：最小实现

`provider_route_costs` 以 `config_id` 为主键，保存 `currency='CNY'`、`cost_unit`、`micros_per_unit`、文本输入/输出 token 微元成本和 `updated_at`。`provider_route_resolution_costs` 以 `(config_id, resolution)` 为主键，保存该档位的 `micros_per_unit`。服务提供：

- `getRouteCost(db, configId)`；
- `setRouteCost(db, configId, payload, actor)`；
- `quoteRouteCost(db, { configId, resolution, duration, count, inputTokens, outputTokens })`；
- `fingerprintRouteCost(snapshot)`；
- `routeCostCoversCapability(db, configId, capability)`。

所有写入使用现有 SQLite 事务；审计摘要只包含配置数字 ID、单位、币种和微元整数。

### 步骤 3：运行绿灯并提交本任务

```powershell
node --test test/providerRouteCost.test.js test/providerRouteSchema.test.js
node --check src/services/providerRouteCostService.js
git diff --check
git add backend-node/migrations/63_provider_route_costs.sql backend-node/src/services/providerRouteCostService.js backend-node/test/providerRouteCost.test.js backend-node/test/providerRouteSchema.test.js
git commit -m "feat(成本): 分离供应商线路成本"
```

---

## 任务 2：让主动巡检只信任线路成本

**文件：**

- 修改：`backend-node/src/services/providerCanaryInventoryService.js`
- 修改：`backend-node/src/services/providerCanaryExecutor.js`
- 修改：`backend-node/src/services/providerCanarySchedulerService.js`
- 修改：`backend-node/src/services/providerRouteStabilityService.js`
- 修改：`backend-node/test/providerCanaryInventory.test.js`
- 修改：`backend-node/test/providerCanaryExecutor.test.js`
- 修改：`backend-node/test/providerCanaryScheduler.test.js`
- 修改：`backend-node/test/providerCanaryPublicGate.test.js`

### 步骤 1：先写失败测试

构造两个共享同一 `logical_model_id` 但线路成本分别为 46,000 和 100,000 微元的配置，断言：

- inventory 分别显示各自成本准备度；
- executor 对指定 `config_id` 预占各自成本；
- scheduler 的 `cost_hash` 随该线路成本变化，只使该线路证据失效；
- public enforce 同时要求逻辑模型用户价格有效和候选线路成本有效；
- 缺少/为零/缺分辨率档位的线路不进入候选，但不影响另一条完整线路；
- public DTO 不泄漏线路成本、配置或供应商身份。

运行并确认红灯：

```powershell
node --test test/providerCanaryInventory.test.js test/providerCanaryExecutor.test.js test/providerCanaryScheduler.test.js test/providerCanaryPublicGate.test.js
```

### 步骤 2：最小实现

- inventory 将“用户价格是否有效”和“线路成本是否有效”拆为两个独立 blocker；
- executor 只用当前巡检 `config_id` 调用 `quoteRouteCost`；
- scheduler 的成本快照与成本指纹只基于该线路成本；
- route gate 保留逻辑模型正积分检查，并追加精确线路成本覆盖检查；
- 不改变 off/shadow/enforce 语义，不改变一次提交、未知不重试和内部 ForConfigId 隔离入口。

### 步骤 3：验证并提交本任务

```powershell
node --test test/providerCanaryInventory.test.js test/providerCanaryExecutor.test.js test/providerCanaryScheduler.test.js test/providerCanaryPublicGate.test.js test/providerCanaryEvidence.test.js test/providerRuntimeFingerprint.test.js
node --check src/services/providerCanaryInventoryService.js
node --check src/services/providerCanaryExecutor.js
node --check src/services/providerCanarySchedulerService.js
node --check src/services/providerRouteStabilityService.js
git diff --check
git add backend-node/src/services/providerCanaryInventoryService.js backend-node/src/services/providerCanaryExecutor.js backend-node/src/services/providerCanarySchedulerService.js backend-node/src/services/providerRouteStabilityService.js backend-node/test/providerCanaryInventory.test.js backend-node/test/providerCanaryExecutor.test.js backend-node/test/providerCanaryScheduler.test.js backend-node/test/providerCanaryPublicGate.test.js
git commit -m "fix(稳定性): 巡检按线路成本执行"
```

---

## 任务 3：按最终实际线路结算运营成本

**文件：**

- 修改：`backend-node/src/services/generationCostLedgerService.js`
- 修改：`backend-node/src/services/generationUsageContext.js`
- 修改：`backend-node/src/services/aiClient.js`
- 修改：`backend-node/src/services/imageService.js`
- 修改：`backend-node/src/services/videoService.js`
- 修改：`backend-node/src/services/text-generation-billing-service.js`
- 修改：`backend-node/test/generationCostLedger.test.js`
- 新增：`backend-node/test/generationRouteCostLedger.test.js`
- 修改：`backend-node/test/imageBilling.test.js`
- 修改：`backend-node/test/videoBilling.test.js`
- 修改：`backend-node/test/text-generation-billing.test.js`

### 步骤 1：先写失败测试

覆盖图片、视频、文本三条链路：

- 用户积分预占继续使用逻辑模型积分价格；
- 容灾后成功时只按最终落库的 `config_id` 线路成本写账；
- 固定请求成本不会乘视频时长；按秒成本会乘实际时长；
- 文本按最终线路的 input/output token 成本和实际 token 数结算；
- 失败、提交结果未知、处理中、没有最终 `config_id` 时供应商成本为零且来源标记为 unavailable/unknown，不猜测成本；
- 成本记录保存脱敏快照、来源和 `config_id`，但管理员 DTO 之外不暴露；
- 重复完成回调保持幂等，不重复写成本。

运行并确认红灯：

```powershell
node --test test/generationCostLedger.test.js test/generationRouteCostLedger.test.js test/imageBilling.test.js test/videoBilling.test.js test/text-generation-billing.test.js
```

### 步骤 2：最小实现

- migration 63 为 `generation_cost_records` 增加 `config_id`、`cost_snapshot_json`、`cost_source`；
- `generationCostLedgerService.record` 接受最终 `configId` 和实际用量，调用线路成本报价并保存快照；
- 删除图片/视频创建阶段按逻辑模型猜成本的写入，改为成功终态且最终配置已持久化后写入；
- `generationUsageContext` 增加内部线路捕获，`aiClient` 在文本最终成功配置处记录 `config_id`；
- 文本结算只在成功并有最终线路时写线路成本；未知/失败只保持安全的不可用来源。

### 步骤 3：验证并提交本任务

```powershell
node --test test/generationCostLedger.test.js test/generationRouteCostLedger.test.js test/imageBilling.test.js test/videoBilling.test.js test/text-generation-billing.test.js test/imageConfigRouting.test.js test/providerRouteVideoIntegration.test.js test/providerRouteTextIntegration.test.js
node --check src/services/generationCostLedgerService.js
node --check src/services/generationUsageContext.js
node --check src/services/aiClient.js
node --check src/services/imageService.js
node --check src/services/videoService.js
node --check src/services/text-generation-billing-service.js
git diff --check
git add backend-node/src/services/generationCostLedgerService.js backend-node/src/services/generationUsageContext.js backend-node/src/services/aiClient.js backend-node/src/services/imageService.js backend-node/src/services/videoService.js backend-node/src/services/text-generation-billing-service.js backend-node/test/generationCostLedger.test.js backend-node/test/generationRouteCostLedger.test.js backend-node/test/imageBilling.test.js backend-node/test/videoBilling.test.js backend-node/test/text-generation-billing.test.js backend-node/migrations/63_provider_route_costs.sql
git commit -m "fix(成本): 按最终供应商线路结算"
```

---

## 任务 4：增加管理员线路成本配置并保持公开端脱敏

**文件：**

- 修改：`backend-node/src/routes/providerStability.js`
- 修改：`backend-node/src/services/providerRouteStabilityService.js`
- 修改：`backend-node/test/providerRouteAdminRoutes.test.js`
- 修改：`backend-node/test/providerCanaryAdminRoutes.test.js`
- 修改：`backend-node/test/canvasModelCatalog.test.js`
- 修改：`frontweb/src/components/ProviderStabilityPanel.vue`
- 新增：`frontweb/test/providerRouteCostAdmin.test.js`

### 步骤 1：先写失败测试

- 管理员可读取和更新单个配置的线路成本及分辨率档位；
- 普通用户为 403，未登录为 401；
- 非法单位、零/负/溢出成本和不存在配置返回通用 400/404；
- 更新与管理员审计、该线路证据失效同事务；失败整体回滚；
- 管理面板按配置显示成本单位和微元/人民币输入，不混入用户积分价格；
- canvas/public billing DTO 递归扫描无成本、配置、供应商和证据字段。

运行并确认红灯：

```powershell
Set-Location backend-node
node --test test/providerRouteAdminRoutes.test.js test/providerCanaryAdminRoutes.test.js test/canvasModelCatalog.test.js
Set-Location ..\frontweb
node --test test/providerRouteCostAdmin.test.js
```

### 步骤 2：最小实现

- 在管理员 provider stability 路由增加 `GET /configs/:configId/cost` 与 `PUT /configs/:configId/cost`；
- 路由复用现有管理员认证和审计，不新增公开接口；
- 面板将用户积分价格与供应商线路成本分区展示；
- 所有公开 DTO 继续使用现有递归脱敏，新增成本相关敏感键回归。

### 步骤 3：验证并提交本任务

```powershell
Set-Location ..\backend-node
node --test test/providerRouteAdminRoutes.test.js test/providerCanaryAdminRoutes.test.js test/canvasModelCatalog.test.js
Set-Location ..\frontweb
node --test test/providerRouteCostAdmin.test.js
npm run build
Set-Location ..
git diff --check
git add backend-node/src/routes/providerStability.js backend-node/src/services/providerRouteStabilityService.js backend-node/test/providerRouteAdminRoutes.test.js backend-node/test/providerCanaryAdminRoutes.test.js backend-node/test/canvasModelCatalog.test.js frontweb/src/components/ProviderStabilityPanel.vue frontweb/test/providerRouteCostAdmin.test.js
git commit -m "feat(管理端): 配置供应商线路成本"
```

---

## 任务 5：实现默认只读的多模型配置拆分工具

**文件：**

- 新增：`backend-node/scripts/split-multi-model-provider-configs.js`
- 新增：`backend-node/test/splitMultiModelProviderConfigs.test.js`

### 步骤 1：先写失败测试

测试隔离 SQLite fixture：

- 无参数和 dry-run 均不写数据库；
- 输出只包含目标配置 ID、模型数量、模型名和稳定指纹，不包含 Key/Base URL；
- `--apply` 缺期望指纹或指纹过期时在事务前失败；
- 应用后原配置只保留原默认模型，其他模型各创建一个停用、未验证、无逻辑模型绑定的克隆；
- Key/Base URL 只在数据库内继承，不出现在 stdout/stderr；
- 任一插入失败时全部回滚；重复应用不会继续生成克隆；
- 不删除原配置，不启用新配置，不将新模型放入公开目录。

运行并确认红灯：

```powershell
Set-Location backend-node
node --test test/splitMultiModelProviderConfigs.test.js
```

### 步骤 2：最小实现

CLI 参数固定为：

```text
--db <sqlite-file> --config-id <integer> [--apply --expected-fingerprint <sha256>]
```

读取配置后规范化 `model` 与 `models`；dry-run 输出 JSON 脱敏计划。应用时使用 `BEGIN IMMEDIATE`，再次计算同一指纹，通过 CAS 后缩窄原配置并插入克隆。克隆继承连接凭据但强制停用、未验证、无逻辑模型绑定；脚本永不打印连接字段。

### 步骤 3：验证并提交本任务

```powershell
node --test test/splitMultiModelProviderConfigs.test.js
node --check scripts/split-multi-model-provider-configs.js
git diff --check
git add backend-node/scripts/split-multi-model-provider-configs.js backend-node/test/splitMultiModelProviderConfigs.test.js
git commit -m "feat(管理端): 安全拆分多模型线路"
```

---

## 任务 6：更新功能锁、范围清单和本地证据

**文件：**

- 修改：`docs/verification/platform-stability/feature-lock-manifest.json`
- 修改：`backend-node/test/featureLockManifest.test.js`
- 修改：`deploy/incremental-release-scope.json`
- 修改：`backend-node/test/incrementalReleaseScope.test.js`
- 修改：`docs/verification/platform-stability/proactive-canary-verification.md`

### 步骤 1：先写失败测试

- 将本计划新增的迁移、线路成本服务、成本账本回归和拆分工具加入主动巡检功能锁；
- 增量范围必须与 `origin/main...HEAD` 实际文件集合深比较，不能只比数量；
- approved unlock 原因固定记录本次“2026-08-20 线路成本分离与多模型配置拆分本地 TDD 授权”；
- 证据文档只记录本地验证，不写生产已生效、真实供应商已通过或已部署。

运行功能锁测试，确认新增文件在更新 manifest/scope 前被拒绝。

### 步骤 2：更新锁和证据

锁只追加必要 protected paths/required tests；保留全部历史 evidence 与 unlock。范围清单以最终真实改动文件生成并人工核对，不包含运行数据库、测试产物、`node_modules`、AI 音乐或无关文件。

### 步骤 3：最终同批验证

```powershell
Set-Location backend-node
npm test
node scripts/audit-feature-locks.js --base origin/main
node --test test/incrementalReleaseScope.test.js
Set-Location ..\frontweb
node --test test/*.test.js
npm run build
Set-Location ..
git diff --check
git status --short
```

另外执行：

- 对所有本次生产 JavaScript 文件运行 `node --check`；
- 对最终 diff 做 credential-shaped secret 扫描；
- 确认临时 `frontweb/node_modules` junction 已删除且目标依赖目录仍存在；
- 确认没有网络生成、付费、SSH、生产数据库、部署、推送或 PR 操作；
- 使用 `finishing-a-development-branch` 检查本地分支交付状态，但保持未推送、未部署。

最终只可报告“本地候选通过”或列出精确失败项，不得将本地绿灯表述为线上已生效。
