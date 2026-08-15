# 稳定性底座实施计划

> **执行要求：** 使用 `executing-plans` 逐任务执行。严格采用 TDD；每个任务完成后运行所列测试并单独提交。不要把后续画布、短剧工厂或剧本分析的未知缺陷混入本阶段。

**目标：** 为图片、视频、文本生成建立安全的同逻辑模型供应商池、可证明的有限容灾、未知态保护、计费闭环、管理员日志/告警和机器可读发布门禁。

**架构：** 以 `ai_service_configs` 作为供应商配置真源；新增逻辑模型映射与验证门禁；用一张请求表冻结业务身份、候选和价格，用尝试表记录每次供应商提交，用健康表和事件表提供熔断与管理员审计。图片、视频、文本继续使用各自现有协议适配器，只把候选选择、错误分类、尝试记录和安全切换集中到稳定性服务。未分类错误默认“不允许切换”。

**技术栈：** Node.js、Express、better-sqlite3、Vue 3、Element Plus、Node test runner、Playwright、GitHub Actions。

**命令约定：** 每个代码块都从仓库根目录开始执行；进入子目录的代码块在结束前返回仓库根目录，避免后续 `git add` 误用路径。

---

## 任务 1：把稳定性数据合同写入数据库

**文件：**

- 新建：`backend-node/migrations/59_provider_route_stability.sql`
- 修改：`backend-node/src/db/migrate.js`
- 新建：`backend-node/test/providerRouteSchema.test.js`

### 步骤 1：先写失败的数据库合同测试

测试创建临时数据库、执行迁移和 `ensureAllColumns`，断言：

- `ai_service_configs` 有 `logical_model_id`、`failover_enabled`、`verification_status`、`verified_at`、`verification_evidence`。
- `video_generations` 有 `config_id`。
- 存在 `generation_route_requests`、`generation_route_attempts`、`provider_route_health`、`provider_stability_events`。
- `generation_route_requests.idempotency_key` 唯一。
- `(request_id, attempt_no)` 唯一，不能重复记录同一次尝试。
- 状态、供应商任务号和事件时间索引存在，重启对账不做无界全表扫描。

运行：

```bash
cd backend-node
node --test --test-concurrency=1 test/providerRouteSchema.test.js
cd ..
```

期望：测试因迁移/列/表不存在而失败。

### 步骤 2：实现最小迁移

`59_provider_route_stability.sql` 只新增以下合同：

```sql
ALTER TABLE ai_service_configs ADD COLUMN logical_model_id TEXT;
ALTER TABLE ai_service_configs ADD COLUMN failover_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_service_configs ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE ai_service_configs ADD COLUMN verified_at TEXT;
ALTER TABLE ai_service_configs ADD COLUMN verification_evidence TEXT;
ALTER TABLE video_generations ADD COLUMN config_id INTEGER;

CREATE TABLE IF NOT EXISTS generation_route_requests (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  service_type TEXT NOT NULL,
  business_type TEXT NOT NULL,
  business_id TEXT,
  tenant_id TEXT,
  user_id TEXT,
  logical_model_id TEXT NOT NULL,
  capability_fingerprint TEXT NOT NULL,
  user_price_snapshot TEXT,
  candidate_config_ids TEXT NOT NULL,
  state TEXT NOT NULL,
  credit_reservation_id TEXT,
  final_config_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS generation_route_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  config_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  upstream_model TEXT NOT NULL,
  state TEXT NOT NULL,
  provider_task_id TEXT,
  http_status INTEGER,
  error_category TEXT,
  safe_error_summary TEXT,
  provider_cost_snapshot TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(request_id, attempt_no)
);

CREATE TABLE IF NOT EXISTS provider_route_health (
  config_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'healthy',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  open_until TEXT,
  half_open_claimed_at TEXT,
  last_error_category TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_stability_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  severity TEXT NOT NULL,
  event_type TEXT NOT NULL,
  request_id TEXT,
  tenant_id TEXT,
  user_ref TEXT,
  logical_model_id TEXT,
  config_id INTEGER,
  target_config_id INTEGER,
  task_state TEXT,
  credit_state TEXT,
  safe_details TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_generation_route_requests_state
  ON generation_route_requests(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_generation_route_attempts_provider_task
  ON generation_route_attempts(provider_task_id);
CREATE INDEX IF NOT EXISTS idx_provider_stability_events_created
  ON provider_stability_events(created_at);
```

在 `ensureAllColumns` 中为旧库补齐同样的 `ai_service_configs` 与 `video_generations` 列；新表仍由迁移创建，不复制第二份建表逻辑。

### 步骤 3：验证迁移幂等和约束

再次运行任务 1 测试，期望全绿；随后运行：

```bash
cd backend-node
npm test -- --test-name-pattern="schema|migration|AI config"
cd ..
```

若当前 Node 版本不支持把该参数透传给测试脚本，则直接运行相关测试文件，不修改测试脚本规避失败。

### 步骤 4：提交

```bash
git add backend-node/migrations/59_provider_route_stability.sql backend-node/src/db/migrate.js backend-node/test/providerRouteSchema.test.js
git commit -m "feat(稳定性): 建立供应商路由数据合同"
```

## 任务 2：实现保守错误分类器

**文件：**

- 新建：`backend-node/src/services/providerErrorClassifier.js`
- 新建：`backend-node/test/providerErrorClassification.test.js`

### 步骤 1：写分类矩阵红灯测试

逐项断言 `{ category, definitiveNotAccepted, affectsHealth, mayFailover }`：

- DNS/TLS/连接失败且适配器明确 `requestBodySent: false`：允许切换，影响健康。
- 明确 `NO_AVAILABLE_CHANNEL`、明确限流且无任务号：允许切换，影响健康。
- 通用 5xx 但没有“未受理”证据：`submission_unknown`，禁止切换。
- 400 内容安全、提示词策略、参数错误、能力不匹配：禁止切换，不影响健康。
- 明确 401 鉴权失败，或供应商结构化代码明确表示密钥/余额不可用且无任务号：允许切换并停用该配置；403 未能区分鉴权与内容策略时禁止切换。
- 已有 `providerTaskId`：无论 HTTP/网络错误都禁止切换。
- HTTP 2xx 无可读取产物：`artifact_unreadable`，禁止切换。
- 未知错误：默认 `submission_unknown`，禁止切换。

还要断言 `toSafeErrorSummary` 删除 API Key、Bearer、完整 URL 查询参数、Base64 和提示词全文。

### 步骤 2：确认红灯

```bash
cd backend-node
node --test --test-concurrency=1 test/providerErrorClassification.test.js
cd ..
```

期望：模块不存在或断言失败。

### 步骤 3：实现最小纯函数

导出：

```js
classifyProviderFailure(meta)
toSafeErrorSummary(value)
```

分类只读结构化字段：`phase`、`requestBodySent`、`providerTaskId`、`httpStatus`、`providerCode`、`explicitlyRejected`、`artifactReadable`。禁止依赖一条覆盖 400–504 的宽泛正则。文本匹配只能识别已列白名单供应商代码，未识别默认不安全。

### 步骤 4：绿灯与提交

```bash
cd backend-node
node --test --test-concurrency=1 test/providerErrorClassification.test.js
cd ..
git add backend-node/src/services/providerErrorClassifier.js backend-node/test/providerErrorClassification.test.js
git commit -m "feat(稳定性): 保守分类供应商提交结果"
```

## 任务 3：建立逻辑模型池、尝试日志与熔断服务

**文件：**

- 新建：`backend-node/src/services/providerRouteStabilityService.js`
- 新建：`backend-node/test/providerRouteStability.test.js`
- 修改：`backend-node/src/services/aiConfigService.js`
- 修改：`backend-node/test/aiConfigPublicView.test.js`
- 修改：`backend-node/test/canvasModelCatalogService.test.js`

### 步骤 1：写候选选择和隐私红灯测试

覆盖：

- 候选必须同 `logical_model_id`、同 `service_type`、启用、`verification_status='verified'`、有价格、能力指纹匹配。
- 只有备用配置 `failover_enabled=1` 才能进入备用列表。
- 用户价格不同、能力不同、未验证、熔断、管理员停用的配置被排除。
- 顺序固定为管理员优先级，再健康状态；不随机、不动态按成本竞价。
- 开路阈值从配置读取，默认 `failure_threshold=3`、`cooldown_seconds=300`；同一配置只允许一个 half-open claim。
- 同一 `idempotency_key` 重复创建返回原请求，不产生第二个 attempt。
- 事件与尝试摘要不含密钥、签名 URL、Base64、提示词全文。
- `aiConfigService` 的管理员视图返回逻辑模型/验证/容灾字段；公共目录继续不返回 provider、base_url、config_id、成本和稳定性内部字段。

### 步骤 2：确认红灯

```bash
cd backend-node
node --test --test-concurrency=1 test/providerRouteStability.test.js test/aiConfigPublicView.test.js test/canvasModelCatalogService.test.js
cd ..
```

### 步骤 3：实现服务最小 API

导出：

```js
createOrGetRouteRequest(db, input)
selectVerifiedCandidates(db, input)
startAttempt(db, input)
finishAttempt(db, input)
recordAcceptedTask(db, input)
recordArtifactVerified(db, input)
recordFailureAndHealth(db, input)
claimHalfOpen(db, configId, now)
listAdminRoutes(db, filters)
listAdminEvents(db, filters)
resetHealth(db, configId, actor)
```

`capability_fingerprint` 使用排序后的稳定 JSON，只包含生成类型、分辨率、比例、时长、参考图/视频/音频数量、语音能力等路由必要字段，不包含素材 URL 和提示词。

`aiConfigService.createConfig/updateConfig/rowToConfig/toPublicConfig` 写入管理员字段并在公共对象中删除它们；不改变现有 API Key 脱敏。

新增 `verifyConfigFromGenerationEvidence(db, input)`：只能用本系统已有的成功生成记录验证配置。服务端必须核对该记录的 `config_id`、成功终态、可读取产物/有效文本结果和结算证据；不能接受管理员直接提交 `verification_status='verified'`。

### 步骤 4：绿灯与提交

```bash
cd backend-node
node --test --test-concurrency=1 test/providerRouteStability.test.js test/aiConfigPublicView.test.js test/canvasModelCatalogService.test.js
cd ..
git add backend-node/src/services/providerRouteStabilityService.js backend-node/src/services/aiConfigService.js backend-node/test/providerRouteStability.test.js backend-node/test/aiConfigPublicView.test.js backend-node/test/canvasModelCatalogService.test.js
git commit -m "feat(稳定性): 建立已验证同模型供应商池"
```

## 任务 4：替换图片节点的宽泛递归切换

**文件：**

- 修改：`backend-node/src/services/imageClient.js`
- 修改：`backend-node/test/imageAssetModelFailover.test.js`
- 修改：`backend-node/test/imageConfigRouting.test.js`
- 修改：`backend-node/test/openAIImageOutput.test.js`
- 新建：`backend-node/test/providerRouteImageIntegration.test.js`

### 步骤 1：写当前缺陷的红灯测试

复现当前 `callImageApi` 把 AIHubCC/OpenAI 兼容的 400、401、403、413、422、通用 5xx 统一切换的问题。断言：

- 内容安全 400 不切换。
- 参数/参考图超限 400/413/422 不切换。
- 明确 401 且无任务号时允许停用失败配置并切换；无法区分内容策略的 403 不切换。
- 已返回任务号或响应解析未知不切换，任务标 `submission_unknown/result_unknown`。
- 明确无通道或明确限流、无任务号且适配器声明未受理时切到下一已验证同逻辑模型配置。
- 第一个供应商明确未受理、第二个返回可读取图片时只扣一次积分，最终 `config_id` 指向第二个配置。
- 所有备用失败时记录每次尝试，错误提示对用户不暴露中转站。
- 用户提示词原样提交；不自动拼接参考图布局说明，不自动添加负面提示词，参考素材只通过协议字段传递。

### 步骤 2：确认红灯

```bash
cd backend-node
node --test --test-concurrency=1 test/providerRouteImageIntegration.test.js test/imageAssetModelFailover.test.js test/imageConfigRouting.test.js test/openAIImageOutput.test.js
cd ..
```

### 步骤 3：精准重构路由边界

在 `callImageApi`：

- 删除 `safeSubmissionFailure` 的宽泛 HTTP 正则和递归 `_attemptedImageConfigKeys` 路由。
- 从 `providerRouteStabilityService.selectVerifiedCandidates` 冻结候选。
- 每个协议适配器只在拥有结构化证据时返回 `route_meta`；未标注默认未知且不可切换。
- 每次调用写 attempt；`providerTaskId`、2xx 无产物、解析失败和产物不可读立即停止切换。
- 只有分类器 `mayFailover=true` 才进入下一候选。
- 对外返回前删除 `route_meta`，普通用户仍只看到安全中文状态。
- 删除 `effectivePrompt` 的自动参考图标签注入；`prompt` 和 `user_negative_prompt` 只使用用户或现有业务记录明确提供的值。

既有 `normalizeProviderImageOutput` 和 `extractOpenAIImageResult` 继续作为产物白名单；不放宽 URL/data URL/Base64 安全检查。

### 步骤 4：绿灯、计费回归与提交

```bash
cd backend-node
node --test --test-concurrency=1 test/providerRouteImageIntegration.test.js test/imageAssetModelFailover.test.js test/imageConfigRouting.test.js test/openAIImageOutput.test.js test/imageBilling.test.js
cd ..
git add backend-node/src/services/imageClient.js backend-node/test/providerRouteImageIntegration.test.js backend-node/test/imageAssetModelFailover.test.js backend-node/test/imageConfigRouting.test.js backend-node/test/openAIImageOutput.test.js
git commit -m "fix(图片): 仅在明确未受理时切换供应商"
```

## 任务 5：视频提交接入同一安全路由

**文件：**

- 修改：`backend-node/src/services/videoClient.js`
- 修改：`backend-node/src/services/videoService.js`
- 修改：`backend-node/test/videoBilling.test.js`
- 新建：`backend-node/test/providerRouteVideoIntegration.test.js`

### 步骤 1：写视频提交状态红灯测试

覆盖：

- 明确未受理才换供应商。
- 获得 `provider_task_id` 后轮询超时、重启或链接未就绪绝不重新提交。
- 第二供应商成功时 `video_generations.config_id`、attempt、实际成本和积分只结算一次。
- `finalizeSuccessfulVideo` 只在视频可下载、可读取基础元数据并绑定业务记录后成功。
- 服务重启后恢复同一个供应商任务号。

### 步骤 2：确认红灯

```bash
cd backend-node
node --test --test-concurrency=1 test/providerRouteVideoIntegration.test.js test/videoBilling.test.js
cd ..
```

### 步骤 3：实现提交/轮询分离

把 `callVideoApi` 的“选择配置”与“按指定配置提交”拆开，但保留各供应商适配器：

```js
submitVideoWithConfig(db, log, config, opts)
callVideoApi(db, log, opts)
pollVideoTask(db, log, generation)
```

`callVideoApi` 只负责候选提交；一旦得到 `provider_task_id` 即固定 `config_id` 并退出路由循环。`pollVideoTask` 和 `resumeProcessingVideoGenerations` 只能读取该配置/任务号，禁止重新进入候选选择。

### 步骤 4：绿灯与提交

```bash
cd backend-node
node --test --test-concurrency=1 test/providerRouteVideoIntegration.test.js test/videoBilling.test.js
cd ..
git add backend-node/src/services/videoClient.js backend-node/src/services/videoService.js backend-node/test/providerRouteVideoIntegration.test.js backend-node/test/videoBilling.test.js
git commit -m "feat(视频): 固定已受理任务并安全容灾"
```

## 任务 6：文本生成接入安全路由且保护流式输出

**文件：**

- 修改：`backend-node/src/services/aiClient.js`
- 修改：`backend-node/src/services/text-generation-billing-service.js`
- 修改：`backend-node/test/text-generation-billing.test.js`
- 新建：`backend-node/test/providerRouteTextIntegration.test.js`

### 步骤 1：写文本红灯测试

覆盖：

- 非流式：明确未受理且无任何内容才允许同逻辑模型切换。
- 流式：收到第一个 token 后任何断线均 `result_unknown`，不切换、不再次生成。
- 当前“流式传输异常改成非流式重提”的路径在可能已输出/已受理时被禁止。
- 内容安全、参数错误及无法明确证明未受理的鉴权错误不切换；结构化 401 且无任务号时遵循统一分类器。
- 同一 `idempotency_key` 重放不二次冻结/扣除积分。
- 普通用户错误不含供应商、URL、配置 ID。

### 步骤 2：确认红灯

```bash
cd backend-node
node --test --test-concurrency=1 test/providerRouteTextIntegration.test.js test/text-generation-billing.test.js
cd ..
```

### 步骤 3：实现文本提交边界

`generateText`、`generateTextWithVision` 使用冻结候选和 attempt；`streamGenerateText` 增加 `receivedProviderContent` 标志。只有标志为 false 且分类器证明未受理时才能切换。未知态调用计费服务的 held 分支，不退款也不扣款。

### 步骤 4：绿灯与提交

```bash
cd backend-node
node --test --test-concurrency=1 test/providerRouteTextIntegration.test.js test/text-generation-billing.test.js
cd ..
git add backend-node/src/services/aiClient.js backend-node/src/services/text-generation-billing-service.js backend-node/test/providerRouteTextIntegration.test.js backend-node/test/text-generation-billing.test.js
git commit -m "feat(文本): 防止流式未知请求重复提交"
```

## 任务 7：服务器重启与对账保护未知任务

**文件：**

- 修改：`backend-node/src/services/taskService.js`
- 修改：`backend-node/src/services/billingReconciliationService.js`
- 新建：`backend-node/src/services/providerReconciliationService.js`
- 修改：`backend-node/src/app.js`
- 修改：`backend-node/test/taskService.test.js`
- 修改：`backend-node/test/billingReconciliation.test.js`
- 新建：`backend-node/test/providerReconciliation.test.js`

### 步骤 1：写重启红灯测试

覆盖：

- 重启时带供应商任务号的视频继续原任务轮询。
- 已进入 submitting 但无明确失败证据的图片/文本转 `needs_attention`，积分 `held_for_review`。
- 明确失败且没有供应商任务的请求才退款。
- `artifact_unreadable` 保持冻结并产生 P1/P2 事件，不重新提交。
- 定时对账重复执行幂等，不二次扣款/退款/事件风暴。

### 步骤 2：确认红灯

```bash
cd backend-node
node --test --test-concurrency=1 test/taskService.test.js test/billingReconciliation.test.js test/providerReconciliation.test.js
cd ..
```

### 步骤 3：替换“启动即失败退款”

修改 `failOrphanedAsyncTasksOnStartup`：查询 `generation_route_requests/attempts` 后分类；未知提交保持 held，并写 `needs_attention`。保留现有可恢复视频和剧本分析恢复逻辑。

新增 `providerReconciliationService`：

```js
reconcileProviderRequests(db, log, now)
startProviderReconciliation(db, log, { intervalMs })
stopProviderReconciliation()
```

定时器必须 `.unref()`；测试和服务器关闭能显式 stop；一次只处理有索引约束的有限批次，不能扫描并重提业务请求。

### 步骤 4：绿灯与提交

```bash
cd backend-node
node --test --test-concurrency=1 test/taskService.test.js test/billingReconciliation.test.js test/providerReconciliation.test.js
cd ..
git add backend-node/src/services/taskService.js backend-node/src/services/billingReconciliationService.js backend-node/src/services/providerReconciliationService.js backend-node/src/app.js backend-node/test/taskService.test.js backend-node/test/billingReconciliation.test.js backend-node/test/providerReconciliation.test.js
git commit -m "fix(计费): 重启后保留未知任务冻结状态"
```

## 任务 8：管理员日志、告警和中转关联，仅管理员可见

**文件：**

- 新建：`backend-node/src/routes/providerStability.js`
- 修改：`backend-node/src/routes/index.js`
- 新建：`backend-node/test/providerRouteAdminRoutes.test.js`
- 新建：`frontweb/src/api/providerStability.js`
- 新建：`frontweb/src/components/ProviderStabilityPanel.vue`
- 修改：`frontweb/src/components/AIConfigContent.vue`
- 新建：`frontweb/test/providerStabilityAdmin.test.js`
- 修改：`frontweb/test/aiConfigRelayAssociation.test.js`

### 步骤 1：写 RBAC 与隐私红灯测试

后端断言以下接口只有 `requireAdmin + requireBillingManager` 可访问：

- `GET /admin/provider-stability/routes`
- `GET /admin/provider-stability/events`
- `PATCH /admin/provider-stability/routes/:configId`
- `POST /admin/provider-stability/routes/:configId/reset-health`
- `POST /admin/provider-stability/routes/:configId/verify-from-generation`

非管理员为 401/403。普通模型目录、画布模型目录和用户生成响应均不包含 provider/base_url/config_id/relay/成本/内部错误。

前端断言 AI 配置页出现“稳定性”页签，显示逻辑模型、关联中转站、健康、熔断、最近切换、任务/积分状态；普通用户路由不引用该面板。

### 步骤 2：确认红灯

```bash
cd backend-node
node --test --test-concurrency=1 test/providerRouteAdminRoutes.test.js test/aiConfigPublicView.test.js test/canvasModelCatalogService.test.js
cd ../frontweb
node --test test/providerStabilityAdmin.test.js test/aiConfigRelayAssociation.test.js
cd ..
```

### 步骤 3：实现最小管理面

`providerStability.js` 只调用稳定性服务，不返回 API Key。PATCH 只允许修改 `logical_model_id`、`failover_enabled`、优先级和管理员暂停；不能在这里把未验证配置标成 verified。`verify-from-generation` 只接受生成记录 ID，并调用 `verifyConfigFromGenerationEvidence` 在服务端核验真实成功记录。重置健康和验证操作都必须写管理员审计事件。

`ProviderStabilityPanel.vue` 复用现有 AI 配置页面，不创建新的普通用户入口。P0/P1 置顶，P2/P3 在事件列表；显示安全摘要，不显示提示词全文或签名 URL。

### 步骤 4：绿灯与提交

```bash
cd backend-node
node --test --test-concurrency=1 test/providerRouteAdminRoutes.test.js test/aiConfigPublicView.test.js test/canvasModelCatalogService.test.js
cd ../frontweb
node --test test/providerStabilityAdmin.test.js test/aiConfigRelayAssociation.test.js
cd ..
git add backend-node/src/routes/providerStability.js backend-node/src/routes/index.js backend-node/test/providerRouteAdminRoutes.test.js frontweb/src/api/providerStability.js frontweb/src/components/ProviderStabilityPanel.vue frontweb/src/components/AIConfigContent.vue frontweb/test/providerStabilityAdmin.test.js frontweb/test/aiConfigRelayAssociation.test.js
git commit -m "feat(管理端): 展示供应商稳定性与切换日志"
```

## 任务 9：建立一次性锁定清单与 CI/发布门禁

**文件：**

- 新建：`docs/verification/platform-stability/feature-lock-manifest.json`
- 新建：`docs/verification/platform-stability/README.md`
- 新建：`backend-node/scripts/verify-feature-lock-manifest.js`
- 新建：`backend-node/test/featureLockManifest.test.js`
- 修改：`backend-node/package.json`
- 修改：`.github/workflows/backend-node-tests.yml`
- 新建：`deploy/release-scopes/platform-stability-foundation.json`

### 步骤 1：写门禁红灯测试

manifest schema 固定为：

```json
{
  "schemaVersion": 1,
  "baselineCommit": "8f9a66cd",
  "features": [
    {
      "featureId": "stability.safe-provider-failover",
      "module": "shared",
      "status": "locked_fixed",
      "acceptance": [],
      "protectedPaths": [],
      "requiredTests": [],
      "evidence": [],
      "fixCommit": null,
      "unlock": null
    }
  ]
}
```

测试断言：状态枚举、证据文件存在、测试文件存在、保护路径存在；已锁定保护路径变更时若 `unlock` 不含原因/批准/影响测试则审计退出非 0。阶段 1 只登记共享稳定性功能，不能提前把三个未验收板块标绿。

### 步骤 2：确认红灯并实现

```bash
cd backend-node
node --test --test-concurrency=1 test/featureLockManifest.test.js
cd ..
```

在 `package.json` 增加：

```json
"audit:feature-lock": "node scripts/verify-feature-lock-manifest.js"
```

在 backend workflow 的全量测试后运行 `npm run audit:feature-lock`。release scope 只列本阶段实际修改文件，不能用目录通配覆盖业务板块。

### 步骤 3：绿灯与提交

```bash
cd backend-node
npm run audit:feature-lock
node --test --test-concurrency=1 test/featureLockManifest.test.js
cd ..
git add docs/verification/platform-stability backend-node/scripts/verify-feature-lock-manifest.js backend-node/test/featureLockManifest.test.js backend-node/package.json .github/workflows/backend-node-tests.yml deploy/release-scopes/platform-stability-foundation.json
git commit -m "chore(门禁): 锁定稳定性底座合同"
```

## 任务 10：全量无付费验证与阶段交付审计

**文件：**

- 修改：`docs/verification/platform-stability/feature-lock-manifest.json`（只补实际提交与证据）
- 新建：`docs/verification/platform-stability/foundation-verification.md`

### 步骤 1：运行后端全量

```bash
cd backend-node
npm test
npm run audit:feature-lock
node --test --test-concurrency=1 test/incrementalReleaseScope.test.js
cd ..
```

期望：后端全量 0 fail；锁定清单审计和增量范围审计器合同测试退出码 0。真实候选目录的增量范围审计只在生产候选从实时 `current` 克隆后执行，并必须传入解析后的 `--parent`、`--candidate`、`--manifest` 和清单 SHA；本地阶段不得伪造生产目录。

### 步骤 2：运行前端全量和构建

```bash
cd frontweb
node --test test/*.test.js
npm run build
cd ..
```

期望：前端全量 0 fail；Vite production build 退出码 0。

### 步骤 3：运行无付费浏览器回归

按仓库现有 Playwright 启动方式运行 AI 配置管理员与普通用户模型目录相关套件；至少覆盖管理员面板、普通用户不暴露中转、图片/视频/文本模拟 failover 和 unknown 状态。任何真实供应商开关保持关闭。

```bash
cd frontweb
npx playwright test e2e/project-canvas-ci.spec.js e2e/image-node-toolbar-backend-integration.spec.js
cd ..
```

如实现时已有更精确的稳定性 E2E 文件，将其加入命令；不得删除现有套件换取绿灯。

### 步骤 4：代码与范围审计

```bash
git diff --check origin/main...HEAD
git status --short
git diff --name-only origin/main...HEAD
```

逐文件核对：每行修改能追溯到设计；没有密钥、供应商签名 URL、真实提示词或产物 Base64；没有画布/工厂/分析的顺带重构。

### 步骤 5：写证据并提交

`foundation-verification.md` 记录命令、日期、提交、通过数、跳过项、无付费开关、阻塞和证据路径。更新 manifest 的 `fixCommit/evidence` 为实际值。

```bash
git add docs/verification/platform-stability/feature-lock-manifest.json docs/verification/platform-stability/foundation-verification.md
git commit -m "test(稳定性): 固化底座验收证据"
```

### 步骤 6：停止在本地交付边界

汇报：分支、提交列表、全量测试、构建、浏览器、审计、未付费、未推送、未部署。推送/PR、真实供应商验证和生产发布需分别确认；不能因本计划已完成自动执行。

## 阶段 1 完成标准

- 明确未受理的同逻辑模型故障（包括结构化 401 且无任务号）可安全切换；内容/参数/未知/已受理不切换。
- 图片、视频、文本都有提交级 attempt 和最终配置证据。
- 产物不可读取不记成功、不扣积分、不自动重提。
- 重启和对账不会把未知任务误退款或重新提交。
- 管理员看到关联、健康、事件和计费状态；普通用户看不到供应商内部信息。
- 全量后端、前端、生产构建、无付费浏览器、锁定门禁和发布范围审计全绿。
- 阶段 1 没有改动三个业务板块的未知缺陷，也没有调用付费模型或生产写入。
