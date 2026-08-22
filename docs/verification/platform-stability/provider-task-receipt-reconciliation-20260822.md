# 供应商任务不可变凭证与安全对账验证证据

## 2026-08-23 全异步视频协议无产物分类刷新（当前）

- 本地基线仍为未 fetch 的 `origin/main` 快照 `f17f87472b48668e5854969f445c916826eb40ac`；本轮协议收口起点为 `b3353b53db6abdcc697f907607440c1a0d94c221`，锁候选 A 为 `ec81ed7a10c6567e5464e5b7d6937ad8a82aaef4`。候选 A 只更新三个实际触及锁的 fresh unlock/history、ToAPIs/Feituo 影响测试与锁测试；真实发布范围仍为 29 个唯一精确路径。
- Node.js `v24.17.0`、npm `11.13.0`，时区 `Asia/Shanghai`。本节结果全部在候选 A 上新鲜运行，不复用 `08114607` / `414c7bce` 或下方任何历史候选数字。
- 当前结论只适用于本地候选：所有单响应异步视频协议在严格单次查询中，完成但缺少可信 HTTP 产物统一归为 `artifact_unreadable`，安全对账保持积分 `held`；明确失败分支仍为 `provider_task_failed` 并退款。它不是 Hosted CI、真实供应商、账单或生产验收。

### 本轮 TDD

| 时间（UTC+08:00） | 命令 | exit | 统计 | 结论 |
| --- | --- | ---: | --- | --- |
| 2026-08-23 05:30:47–05:30:48 | `cd backend-node; node --test test/featureLockManifest.test.js test/incrementalReleaseScope.test.js` | 1 | 27 tests；26 pass；1 fail；0 skip | 原样门禁正确返回 `FEATURE_LOCKED`：`videoClient.js` 在上一候选后再次变化，safe failover、unknown billing、proactive canary 三锁缺少本轮 fresh unlock；scope 已保持 29 项深相等。 |
| 2026-08-23 05:32:58–05:32:59 | 同上，先增强全异步协议批准、完整历史与 ToAPIs/Feituo 影响测试合同 | 1 | 27 tests；25 pass；2 fail；0 skip | 预期红灯固定两个缺口：manifest 仍是旧批准且缺两项协议 required tests；有效基线审计仍被三锁拒绝。 |
| 2026-08-23 05:34:09–05:34:10 | 同上 | 0 | 27 tests；27 pass；0 fail；0 skip | 三个触及锁切换到本轮专属批准，并把 legacy DJPSD 批准追加进 `unlockHistory`；历史 evidence、route/admin 未触及锁与保护范围均保留。 |

### 候选 A 新鲜验证

| 时间（UTC+08:00） | 命令 | exit | 通过 / 失败 / skip | 结果 |
| --- | --- | ---: | --- | --- |
| 2026-08-23 05:34:44–05:34:46 | 锁/范围 2 文件测试 | 0 | 27 / 0 / 0 | fresh unlock、完整历史、required tests、29 路径深相等与同数量偷换反例全部通过。 |
| 2026-08-23 05:34:55–05:34:56 | `node scripts/verify-feature-lock-manifest.js --base origin/main` | 0 | 不适用 | `ready=true`；6 features；29 changed paths；6 个基线保护锁。 |
| 2026-08-23 05:35:07–05:35:32 | 下方 11 文件 Task 1–5 精确集 | 0 | 292 / 0 / 0 | 迁移、凭证、路由、对账、管理员、单次查询、积分与成本同批通过。 |
| 2026-08-23 05:35:41–05:36:05 | `providerTaskReconciliation.test.js` + `videoQueryTaskStatusOnce.test.js` focused 集 | 0 | 166 / 0 / 0 | 全协议 direct strict 分类与 reconcile held/refunded 分支同批通过。 |
| 2026-08-23 05:36:15–05:36:18 | `providerRouteVideoIntegration.test.js` 额外视频路由回归 | 0 | 8 / 0 / 0 | 视频路由不可读链接、重启恢复与对账邻接合同通过；该 8 项不冒充下行 27 项协议回归。 |
| 2026-08-23 05:36:55–05:36:58 | `toapisVideoIntegration.test.js` + `feituoVideoModels.test.js` 协议回归 | 0 | 27 / 0 / 0 | ToAPIs 和 Feituo 精确协议、能力、价格、提交前门禁及轮询合同通过。 |
| 2026-08-23 05:37:12–05:37:18 | `node --test test/providerRouteSchema.test.js`，迁移第 1 轮 | 0 | 21 / 0 / 0 | 幂等合同通过；隔离夹具日志计得 197 条 migration 64 执行记录。 |
| 2026-08-23 05:37:28–05:37:33 | 同上，迁移第 2 轮 | 0 | 21 / 0 / 0 | 第二轮仍通过，仍计得 197 条 migration 64 执行记录。 |
| 2026-08-23 05:37:47–05:54:41 | `cd backend-node; npm test` | 0 | 2850 / 0 / 10；共 2860 tests、36 suites | 完整串行后端回归结束；10 项 skip 按 runner 原样记录。npm 另输出 `better_sqlite3_binary_host_mirror` 项目配置将在下一主版本停止支持的警告，不把警告记作测试失败。 |
| 2026-08-23 05:55:16–05:55:21 | 6 个计划语法检查、`git diff --check origin/main...HEAD`、scope 深比较及禁区检查 | 0 | 6 个语法检查；29 / 29 paths | diff 无空白错误；scope 与实际排序路径逐项相等且均唯一；通配符、目录、数据库、uploads、storage、assets、AI 音乐与 shared release guard 命中 0。 |

本轮三个关键测试集的精确命令为：

```powershell
node --test test/providerRouteSchema.test.js test/providerRouteStability.test.js test/providerRouteVideoIntegration.test.js test/providerTaskReconciliation.test.js test/providerTaskAdminRoutes.test.js test/videoQueryTaskStatusOnce.test.js test/videoBilling.test.js test/generationRouteCostLedger.test.js test/creditLedger.test.js test/providerReconciliation.test.js test/providerCanaryAdminRoutes.test.js
node --test test/providerTaskReconciliation.test.js test/videoQueryTaskStatusOnce.test.js
node --test test/toapisVideoIntegration.test.js test/feituoVideoModels.test.js
```

### 本轮断言、接口面与秘密扫描

- `backend-node/test/videoQueryTaskStatusOnce.test.js:73` 起覆盖 28 个单响应异步协议完成但无可信产物的 strict 分类；同文件各场景通过请求夹具断言只查询一次，并另行锁定显式失败与普通轮询兼容行为。这是本地 direct contract，不是真实供应商查询。
- `backend-node/test/providerTaskReconciliation.test.js:1160` 起覆盖支持协议的安全对账：第 1253 行断言查询数为 1，第 1256–1257 行断言安全 DTO 和数据库预扣均为 `held`；显式失败在第 1284 行断言查询数为 1，第 1287–1288 行断言两者均为 `refunded`。既有成功合同第 733 行断言查询数为 1，第 745 行断言预扣为 `confirmed`。
- 2026-08-23 05:57:37 的接口面扫描确认对账服务只有 1 个 `queryVideoTaskStatusOnce` 绑定（第 366 行），提交入口 `callVideoApi` / `submitVideo` / `createVideo` / `generateVideo` 匹配为 0。submit count 0 是本地静态接口面证据，不是真实供应商请求记录。
- 2026-08-23 05:56:58–05:56:59 对 `origin/main...HEAD` 新增行的脱敏扫描为 2 个规则命中、1 个唯一位置：`backend-node/test/providerTaskAdminRoutes.test.js:348` 的同一本地安全哨兵分别匹配 `bearer-token` 与 `authorization-value`；值只记录为 `[REDACTED]`。OpenAI 风格 token 与 URL userinfo 命中 0。
- 2026-08-23 05:57:45 的 `git status --short` 只有既存 `?? data/`。未读取、检查、清理、暂存或提交其内部内容，因此不宣称工作树 clean。
- 本轮未执行 fetch、真实供应商查询/提交、付费调用、SSH、生产迁移或写入、push、PR、Hosted CI、部署、共享 release guard 激活或 `enforce`。
- 本地 fixture、临时 SQLite 和 loopback HTTP 只证明代码合同；它们不构成第三方供应商、真实账单或生产接受证据。

## 2026-08-23 旧版 DJPSD 严格完成无产物刷新（历史保留）

- 本地基线仍为未 fetch 的 `origin/main` 快照 `f17f87472b48668e5854969f445c916826eb40ac`；本轮质量修复起点为 `d5b29c2b066f46819774a8a36512aef54561f785`，锁候选 A 为 `081146075657b0ce5f4b40e90fae43711c3fdd9e`。候选 A 只追加 fresh unlock/history 及其测试；发布范围仍与真实差异保持同一 29 个路径。
- Node.js `v24.17.0`、npm `11.13.0`，时区 `Asia/Shanghai`。本节全部结果均在候选 A 上重新运行，不复用 `7041397a` / `9d797388` 或下方历史数字。
- 当前结论仅为本地候选：旧版 DJPSD 严格单次查询把 `success` / `succeeded` / `completed` 且无视频的结果归为 `artifact_unreadable`，对账保持积分 `held`；明确失败仍退款。它不是 Hosted CI、真实供应商、账单或生产验收。

### 本轮 TDD

| 时间（UTC+08:00） | 命令 | exit | 统计 | 结论 |
| --- | --- | ---: | --- | --- |
| 2026-08-23 04:47:49–04:47:50 | `cd backend-node; node --test test/featureLockManifest.test.js test/incrementalReleaseScope.test.js` | 1 | 27 tests；26 pass；1 fail；0 skip | 原样门禁正确返回 `FEATURE_LOCKED`：`videoClient.js` 在上次 A 后再次变化，safe failover、unknown billing、proactive canary 三锁缺少本轮 fresh unlock；scope 已正确保持 29 项。 |
| 2026-08-23 04:49:18–04:49:19 | 同上，先增强 legacy DJPSD 批准与完整历史合同 | 1 | 27 tests；25 pass；2 fail；0 skip | 预期红灯固定两个缺口：新批准及上一质量批准的历史记录尚未写入；有效基线审计仍被三锁拒绝。 |
| 2026-08-23 04:50:20–04:50:22 | 同上 | 0 | 27 tests；27 pass；0 fail；0 skip | 三个实际触及锁使用 legacy DJPSD 专属 fresh unlock，上一轮批准追加进 `unlockHistory`；route/admin 未触及锁与全部历史 evidence 保持不变。 |

### 候选 A 新鲜验证

| 时间（UTC+08:00） | 命令 | exit | 通过 / 失败 / skip | 结果 |
| --- | --- | ---: | --- | --- |
| 2026-08-23 04:51:35–04:51:37 | 锁/范围 2 文件测试及 `node scripts/verify-feature-lock-manifest.js --base origin/main` | 0 | 27 / 0 / 0 | `ready=true`；6 features；29 changed paths；6 个基线保护锁。 |
| 2026-08-23 04:51:47–04:52:09 | 下方列出的 11 文件 Task 1–5 精确供应商集 | 0 | 236 / 0 / 0 | 旧版 DJPSD 三种完成状态、显式失败、普通轮询兼容及对账分支均通过。 |
| 2026-08-23 04:52:20–04:52:43 | 下方 7 文件相邻集并显式加入 `videoQueryTaskStatusOnce.test.js`、`providerTaskReconciliation.test.js` | 0 | 191 / 0 / 0 | 图片、文本、视频邻接回归及 legacy DJPSD direct/reconcile 同批通过。 |
| 2026-08-23 04:53:04–04:53:09 | `node --test test/providerRouteSchema.test.js`，迁移第 1 轮 | 0 | 21 / 0 / 0 | 幂等合同通过；隔离夹具日志含 197 条 migration 64 执行记录。 |
| 2026-08-23 04:53:09–04:53:15 | 同上，迁移第 2 轮 | 0 | 21 / 0 / 0 | 第二轮仍通过，仍为 197 条 migration 64 执行记录。 |
| 2026-08-23 04:53:35–05:08:37 | `cd backend-node; npm test` | 0 | 2794 / 0 / 10；共 2804 tests、36 suites | 完整串行后端回归结束；10 项 skip 按 runner 原样记录。npm 另输出一条 `better_sqlite3_binary_host_mirror` 项目配置将在下一主版本停止支持的警告，不把警告记作测试失败。 |
| 2026-08-23 05:09:06–05:09:08 | 6 个计划语法检查、`git diff --check origin/main...HEAD`、scope 深比较及禁区检查 | 0 | 6 个语法检查；29 / 29 paths | diff 无空白错误；scope 与实际排序路径逐项相等；通配符、目录、数据库、uploads、storage、assets、AI 音乐与 shared release guard 命中 0。 |

Task 1–5 精确集沿用计划的 11 文件命令；相邻集在原 7 文件基础上显式加入本轮 direct/reconcile 两文件：

```powershell
node --test test/providerRouteSchema.test.js test/providerRouteStability.test.js test/providerRouteVideoIntegration.test.js test/providerTaskReconciliation.test.js test/providerTaskAdminRoutes.test.js test/videoQueryTaskStatusOnce.test.js test/videoBilling.test.js test/generationRouteCostLedger.test.js test/creditLedger.test.js test/providerReconciliation.test.js test/providerCanaryAdminRoutes.test.js
node --test test/providerRouteImageIntegration.test.js test/providerRouteTextIntegration.test.js test/imageBilling.test.js test/openAIImageOutput.test.js test/text-generation-billing.test.js test/toapisVideoIntegration.test.js test/feituoVideoModels.test.js test/videoQueryTaskStatusOnce.test.js test/providerTaskReconciliation.test.js
```

### 本轮断言、接口面与秘密扫描

- `backend-node/test/videoQueryTaskStatusOnce.test.js:73–117` 分别锁定旧版 DJPSD 三种完成但无视频的状态与两种显式失败，所有分支均断言网络请求数为 1；`:119` 起锁定普通轮询仍保留旧错误行为。
- `backend-node/test/providerTaskReconciliation.test.js:1158–1250` 覆盖 DJPSD legacy/OpenAPI 与 Token6688：无产物时第 1209 行断言查询数为 1，第 1212–1219 行断言 `held` 且退款流水为 0；显式失败时第 1240 行断言查询数为 1，第 1243–1250 行断言 `refunded` 且退款流水为 1。
- 同文件第 731、743 行的既有成功对账合同仍在本轮精确集和全量中通过，分别断言查询数为 1、预扣为 `confirmed`。
- 2026-08-23 05:09:47 的接口面扫描确认对账服务只有 1 个 `queryVideoTaskStatusOnce` 绑定（第 366 行），提交入口 `callVideoApi` / `submitVideo` / `createVideo` / `generateVideo` 匹配为 0。submit count 0 是本地静态接口面证据，不是一次真实供应商请求记录。
- 2026-08-23 05:09:27–05:09:28 对 `origin/main...HEAD` 新增行的脱敏扫描仍为 2 个规则命中、1 个唯一位置：`backend-node/test/providerTaskAdminRoutes.test.js:348` 的同一本地安全哨兵分别匹配 `bearer-token` 与 `authorization-value`；值只记录为 `[REDACTED]`。OpenAI 风格 token 与 URL userinfo 命中 0。
- 写本节前 `git status --short` 只有既存 `?? data/`。未检查或清理其内部内容，未暂存或提交，因此不宣称工作树 clean。
- 本轮未执行 fetch、真实供应商查询/提交、付费调用、SSH、生产迁移或写入、push、PR、Hosted CI、部署、共享 release guard 激活或 `enforce`。

## 历史无产物质量修复刷新（保留）

- 本地基线仍为未 fetch 的 `origin/main` 快照 `f17f87472b48668e5854969f445c916826eb40ac`；质量修复起点为 `b1610f116ab7d4bae373facca639c4867119bc8d`，锁与范围候选 A 为 `7041397ae7d06f60285dc3e72e378a2c04bdaeef`。
- Node.js `v24.17.0`、npm `11.13.0`，时区 `Asia/Shanghai`。本节所有结果均在候选 A 上重新运行，不复用下方历史候选数字。
- 当前结论仅为本地候选：无产物的 DJPSD OpenAPI / Token6688 单次查询进入 `artifact_unreadable` 并保持积分 `held`；明确供应商失败仍退款。它不是 Hosted CI、真实供应商、账单或生产验收。

### 刷新 TDD

| 时间（UTC+08:00） | 命令 | exit | 统计 | 结论 |
| --- | --- | ---: | --- | --- |
| 2026-08-23 04:03:10–04:03:11 | `cd backend-node; node --test test/featureLockManifest.test.js test/incrementalReleaseScope.test.js` | 1 | 27 tests；26 pass；1 fail；0 skip | 原样门禁正确返回 `FEATURE_LOCKED`：质量提交在上次 unlock 后再次触碰 `videoClient.js`，safe failover、unknown billing、proactive canary 三个锁缺少 fresh unlock。旧 scope 测试仍错误放行 28 项。 |
| 2026-08-23 04:04:43–04:04:45 | 同上，先增强锁和真实 diff 合同 | 1 | 27 tests；24 pass；3 fail；0 skip | 预期红灯固定三个缺口：新 unlock/历史链缺失、有效基线审计被锁拒绝、scope 缺少 `videoQueryTaskStatusOnce.test.js`。 |
| 2026-08-23 04:06:37–04:06:39 | 同上 | 0 | 27 tests；27 pass；0 fail；0 skip | 三个锁使用本次批准记录并追加上一批准到历史；safe failover required tests 补入单次查询测试；scope 与真实 29 路径逐项深相等。 |

### 候选 A 新鲜验证

| 时间（UTC+08:00） | 命令 | exit | 通过 / 失败 / skip | 结果 |
| --- | --- | ---: | --- | --- |
| 2026-08-23 04:07:34–04:07:36 | 锁/范围 2 文件测试及 `node scripts/verify-feature-lock-manifest.js --base origin/main` | 0 | 27 / 0 / 0 | `ready=true`；6 features；29 changed paths；6 个基线保护锁。 |
| 2026-08-23 04:07:50–04:08:14 | 下方历史记录所列同一 11 文件 Task 1–5 精确供应商集 | 0 | 224 / 0 / 0 | 新增 DJPSD OpenAPI / Token6688 无产物、非视频产物、显式失败和旧轮询兼容分支均通过。 |
| 2026-08-23 04:08:29–04:08:34 | 下方历史记录所列同一 7 文件相邻供应商集 | 0 | 81 / 0 / 0 | 图片、文本与视频邻接回归通过。 |
| 2026-08-23 04:08:46–04:08:53 | `node --test test/providerRouteSchema.test.js`，迁移第 1 轮 | 0 | 21 / 0 / 0 | 幂等测试通过；隔离夹具日志含 197 条迁移 64 执行记录。 |
| 2026-08-23 04:08:53–04:08:58 | 同上，迁移第 2 轮 | 0 | 21 / 0 / 0 | 第二轮仍通过，仍为 197 条迁移 64 执行记录。 |
| 2026-08-23 04:09:12–04:25:43 | `cd backend-node; npm test` | 0 | 2782 / 0 / 10；共 2792 tests、36 suites | 完整串行后端回归结束；10 项 skip 按 runner 原样记录，未计作通过。 |
| 2026-08-23 04:26:17–04:26:19 | 6 个计划语法检查、`git diff --check origin/main...HEAD`、scope 深比较、禁区与脱敏秘密扫描 | 0 | 6 个语法检查；29 / 29 paths | diff 无空白错误；scope 与实际有序路径逐项相等；通配符、目录、数据库、uploads、storage、assets、AI 音乐与 shared release guard 命中 0。 |

### 刷新断言与秘密扫描

- `backend-node/test/videoQueryTaskStatusOnce.test.js:73–126` 锁定三种无有效视频结果均只查询一次并返回 `artifact_unreadable`；第 128 行起锁定显式失败仍为 `provider_task_failed`；第 160 行起锁定普通轮询兼容旧错误行为。
- `backend-node/test/providerTaskReconciliation.test.js:1158–1228` 对 DJPSD OpenAPI / Token6688 分别断言查询计数为 1：无产物时安全分类与数据库预扣均保持 `held`，显式失败时二者均为 `refunded`。
- 2026-08-23 04:26:48–04:26:49 的接口面扫描再次确认对账服务有 1 个 `queryVideoTaskStatusOnce` 入口（第 366 行），提交入口匹配为 0；这是本地接口面证据，不是真实供应商提交计数。
- 脱敏扫描仍为 2 个规则命中、1 个唯一位置：`backend-node/test/providerTaskAdminRoutes.test.js:348` 的同一本地安全哨兵分别匹配 `bearer-token` 与 `authorization-value`；值只记录为 `[REDACTED]`。OpenAI 风格 token 与 URL userinfo 命中 0。
- 写本节前 `git status --short` 只有既存 `?? data/`。未检查或清理其内部内容，未暂存或提交，因此不宣称工作树 clean。
- 本轮未执行 fetch、真实供应商查询/提交、付费调用、SSH、生产迁移或写入、push、PR、Hosted CI、部署、共享 release guard 激活或 `enforce`。

## 历史首次候选记录（保留）

- 本地基线：`f17f87472b48668e5854969f445c916826eb40ac`，即本机已有的 `origin/main` 快照。本轮禁止并且没有执行 fetch，因此它不是远端最新状态证明。
- 候选 A：`f857db53273e524e9cfc3ccd16bb16e02d9bd4fc`。
- Node.js：`v24.17.0`；npm：`11.13.0`；时区：`Asia/Shanghai`（下表均为北京时间，UTC+08:00）。
- 候选 A 的本地功能锁、精确发布范围、计划供应商回归、邻接回归、后端全量、迁移重复、语法、diff 和脱敏秘密扫描均得到 exit 0 证据。该结论只适用于本地候选 A，不是 Hosted CI、真实供应商或生产验收。
- 本文件因功能锁校验器要求 evidence 路径在候选中存在，以不含未来断言的最小骨架进入候选 A；下列结果是在 A SHA 上运行后追加，不能反向声称 A 已验证本证据正文。

### TDD 红灯与绿灯

| 时间 | 命令 | exit | 统计 | 结论 |
| --- | --- | ---: | --- | --- |
| 2026-08-23 03:05:03–03:05:05 | `cd backend-node; node --test test/featureLockManifest.test.js test/incrementalReleaseScope.test.js` | 1 | 27 tests；25 pass；2 fail；0 skip | 预期红灯：5 个实际触及锁仍使用旧批准记录；新的 28 文件发布 scope 尚不存在。失败来自需求缺失，不是语法或装配错误。 |
| 2026-08-23 03:09:24–03:09:25 | 同上 | 0 | 27 tests；27 pass；0 fail；0 skip | 新 unlock、保护路径、required tests、evidence 与精确 scope 已写入。 |
| 2026-08-23 03:10:30–03:10:31 | 同上 | 1 | 27 tests；26 pass；1 fail；0 skip | 第二个预期红灯：当前清单尚未保留上一条 unlock 的 `unlockHistory`。 |
| 2026-08-23 03:11:24–03:11:26 | 同上 | 0 | 27 tests；27 pass；0 fail；0 skip | 5 个受影响锁保留原 evidence 前缀和上一条 unlock；未触及锁的现有批准记录未变。 |

### 候选 A 同批验证

| 时间 | 命令 | exit | 通过 / 失败 / skip | 结果 |
| --- | --- | ---: | --- | --- |
| 2026-08-23 03:12:55–03:12:57 | `cd backend-node; node --test test/featureLockManifest.test.js test/incrementalReleaseScope.test.js` | 0 | 27 / 0 / 0 | 锁与范围合同通过。 |
| 2026-08-23 03:12:55–03:12:57 | `cd backend-node; node scripts/verify-feature-lock-manifest.js --base origin/main` | 0 | 不适用 | `ready=true`；6 features；28 changed paths；6 个基线保护锁。 |
| 2026-08-23 03:13:08–03:13:31 | 计划步骤 1 的 11 文件供应商测试集 | 0 | 213 / 0 / 0 | 迁移、凭证、视频路由、对账、管理员、单次查询、积分与成本回归通过。 |
| 2026-08-23 03:13:44–03:13:49 | 计划步骤 2 的 7 文件图片、文本与视频邻接测试集 | 0 | 81 / 0 / 0 | 邻接供应商回归通过。 |
| 2026-08-23 03:14:03–03:31:59 | `cd backend-node; npm test` | 0 | 2771 / 0 / 10；共 2781 tests、36 suites | 完整串行后端回归完成；10 项 skip 按 runner 原样记录，未计作通过。 |
| 2026-08-23 03:32:46–03:32:52 | `node --test test/providerRouteSchema.test.js`，迁移复跑第 1 轮 | 0 | 21 / 0 / 0 | 迁移合同通过；隔离夹具日志出现 197 条迁移 64 执行记录；幂等合同位于该测试文件第 245 行。 |
| 2026-08-23 03:32:52–03:32:59 | 同上，迁移复跑第 2 轮 | 0 | 21 / 0 / 0 | 第二轮结果相同，仍为 197 条迁移 64 执行记录，无重复列或触发器失败。 |
| 2026-08-23 03:33:23–03:33:24 | 计划列出的 6 个 `node --check` | 0 | 6 / 0 / 0 | 新服务、线路服务、视频客户端/服务及两份 route 文件语法通过。 |
| 2026-08-23 03:33:23–03:33:24 | `git diff --check origin/main...HEAD` | 0 | 不适用 | 无空白错误。 |
| 2026-08-23 03:33:23–03:33:24 | `origin/main...HEAD` 路径与 scope 有序 JSON 深比较 | 0 | 28 / 0 / 0 | 两侧均为 28 个唯一精确路径，逐项相等；通配符、目录项、数据库、uploads、storage、assets、AI 音乐及 shared release guard 命中 0。 |
| 2026-08-23 03:33:42–03:33:43 | 对 `origin/main...HEAD` 新增行执行脱敏 secret scan | 0 | 2 个规则命中；1 个唯一位置 | 见下节；没有输出或记录命中值。 |

计划步骤 1 的精确命令为：

```text
node --test test/providerRouteSchema.test.js test/providerRouteStability.test.js test/providerRouteVideoIntegration.test.js test/providerTaskReconciliation.test.js test/providerTaskAdminRoutes.test.js test/videoQueryTaskStatusOnce.test.js test/videoBilling.test.js test/generationRouteCostLedger.test.js test/creditLedger.test.js test/providerReconciliation.test.js test/providerCanaryAdminRoutes.test.js
```

计划步骤 2 的精确命令为：

```text
node --test test/providerRouteImageIntegration.test.js test/providerRouteTextIntegration.test.js test/imageBilling.test.js test/openAIImageOutput.test.js test/text-generation-billing.test.js test/toapisVideoIntegration.test.js test/feituoVideoModels.test.js
```

### 查询、提交与积分断言来源

- 可对账成功：`backend-node/test/providerTaskReconciliation.test.js:706` 的测试在第 727 行断言 `queryCount === 1`，并在第 739 行断言用户预扣为 `confirmed`。
- 静态门禁：同文件第 845 行开始覆盖缺失/漂移凭证等阻断；辅助断言第 133–148 行要求查询计数为 0。并发门禁从第 1048 行开始，第 1083 行要求两个数据库连接之间总查询计数为 1。
- 明确供应商失败：同文件第 1117–1141 行要求查询一次，安全 DTO 与数据库预扣均为 `refunded`。
- 处理中、查询故障、不安全成功和不可读产物：同文件第 1154–1196 行要求每次至多查询一次且结果与数据库预扣保持 `held`。
- 提交调用：2026-08-23 03:34:57 对 `providerTaskReconciliationService.js` 的提交入口静态扫描为 0 个 `callVideoApi` / `submitVideo` / `createVideo` / `generateVideo` 引用；查询入口恰有 1 个，位于第 366 行。对账测试只注入 `queryTaskStatusOnce`，因此这里的 submit count 0 是对账路径的接口面证据，不是一次真实供应商提交计数，也不把邻接路由测试中的本地 HTTP fixture 表述为供应商验收。
- 独立积分合同：`backend-node/test/creditLedger.test.js:174`、`:188`、`:201` 分别锁定确认、退款和结果未知保持冻结；这些断言均包含在候选 A 的 213 项计划供应商测试集和后端全量中。

### 脱敏秘密扫描解释

扫描规则覆盖 OpenAI 风格 token、Bearer 值、Authorization 值和 URL userinfo。结果只有一个唯一位置：

| 文件与行 | 分类 | 掩码 | 解释 |
| --- | --- | --- | --- |
| `backend-node/test/providerTaskAdminRoutes.test.js:348` | `bearer-token`、`authorization-value` | `[REDACTED]` | 同一条本地测试安全哨兵被两类正则重复命中；所属测试为“provider task reconcile route returns generic 500 and logs no upstream secrets”，用于证明上游敏感文本不会进入响应或日志。不是配置、环境变量或真实凭据。 |

OpenAI 风格 token 与 URL userinfo 命中均为 0。文档不保存任何匹配原值。

### 工作树与未执行边界

- 候选 A 验证完成、写本文前，`git status --short` 只有既存 `?? data/`。该目录与任务开始时状态相同，未纳入暂存或提交，也未执行读取、清理或恢复；因此不宣称工作树 clean。
- 未执行真实供应商查询、真实供应商提交、付费调用、SSH、生产迁移、生产数据库或文件写入、推送、PR、Hosted CI、部署、共享 release guard 激活或 `enforce`。
- 本地 fixture、内存/临时 SQLite、loopback HTTP 和自动化测试只证明本地代码合同；它们不是第三方供应商、账单或生产接受证据。
