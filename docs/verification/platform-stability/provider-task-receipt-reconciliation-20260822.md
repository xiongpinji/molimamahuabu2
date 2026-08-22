# 供应商任务不可变凭证与安全对账验证证据

## 2026-08-23 无产物质量修复刷新（当前）

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
