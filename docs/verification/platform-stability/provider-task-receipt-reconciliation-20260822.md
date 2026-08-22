# 供应商任务不可变凭证与安全对账验证证据

## 结论与边界

- 本地基线：`f17f87472b48668e5854969f445c916826eb40ac`，即本机已有的 `origin/main` 快照。本轮禁止并且没有执行 fetch，因此它不是远端最新状态证明。
- 候选 A：`f857db53273e524e9cfc3ccd16bb16e02d9bd4fc`。
- Node.js：`v24.17.0`；npm：`11.13.0`；时区：`Asia/Shanghai`（下表均为北京时间，UTC+08:00）。
- 候选 A 的本地功能锁、精确发布范围、计划供应商回归、邻接回归、后端全量、迁移重复、语法、diff 和脱敏秘密扫描均得到 exit 0 证据。该结论只适用于本地候选 A，不是 Hosted CI、真实供应商或生产验收。
- 本文件因功能锁校验器要求 evidence 路径在候选中存在，以不含未来断言的最小骨架进入候选 A；下列结果是在 A SHA 上运行后追加，不能反向声称 A 已验证本证据正文。

## TDD 红灯与绿灯

| 时间 | 命令 | exit | 统计 | 结论 |
| --- | --- | ---: | --- | --- |
| 2026-08-23 03:05:03–03:05:05 | `cd backend-node; node --test test/featureLockManifest.test.js test/incrementalReleaseScope.test.js` | 1 | 27 tests；25 pass；2 fail；0 skip | 预期红灯：5 个实际触及锁仍使用旧批准记录；新的 28 文件发布 scope 尚不存在。失败来自需求缺失，不是语法或装配错误。 |
| 2026-08-23 03:09:24–03:09:25 | 同上 | 0 | 27 tests；27 pass；0 fail；0 skip | 新 unlock、保护路径、required tests、evidence 与精确 scope 已写入。 |
| 2026-08-23 03:10:30–03:10:31 | 同上 | 1 | 27 tests；26 pass；1 fail；0 skip | 第二个预期红灯：当前清单尚未保留上一条 unlock 的 `unlockHistory`。 |
| 2026-08-23 03:11:24–03:11:26 | 同上 | 0 | 27 tests；27 pass；0 fail；0 skip | 5 个受影响锁保留原 evidence 前缀和上一条 unlock；未触及锁的现有批准记录未变。 |

## 候选 A 同批验证

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

## 查询、提交与积分断言来源

- 可对账成功：`backend-node/test/providerTaskReconciliation.test.js:706` 的测试在第 727 行断言 `queryCount === 1`，并在第 739 行断言用户预扣为 `confirmed`。
- 静态门禁：同文件第 845 行开始覆盖缺失/漂移凭证等阻断；辅助断言第 133–148 行要求查询计数为 0。并发门禁从第 1048 行开始，第 1083 行要求两个数据库连接之间总查询计数为 1。
- 明确供应商失败：同文件第 1117–1141 行要求查询一次，安全 DTO 与数据库预扣均为 `refunded`。
- 处理中、查询故障、不安全成功和不可读产物：同文件第 1154–1196 行要求每次至多查询一次且结果与数据库预扣保持 `held`。
- 提交调用：2026-08-23 03:34:57 对 `providerTaskReconciliationService.js` 的提交入口静态扫描为 0 个 `callVideoApi` / `submitVideo` / `createVideo` / `generateVideo` 引用；查询入口恰有 1 个，位于第 366 行。对账测试只注入 `queryTaskStatusOnce`，因此这里的 submit count 0 是对账路径的接口面证据，不是一次真实供应商提交计数，也不把邻接路由测试中的本地 HTTP fixture 表述为供应商验收。
- 独立积分合同：`backend-node/test/creditLedger.test.js:174`、`:188`、`:201` 分别锁定确认、退款和结果未知保持冻结；这些断言均包含在候选 A 的 213 项计划供应商测试集和后端全量中。

## 脱敏秘密扫描解释

扫描规则覆盖 OpenAI 风格 token、Bearer 值、Authorization 值和 URL userinfo。结果只有一个唯一位置：

| 文件与行 | 分类 | 掩码 | 解释 |
| --- | --- | --- | --- |
| `backend-node/test/providerTaskAdminRoutes.test.js:348` | `bearer-token`、`authorization-value` | `[REDACTED]` | 同一条本地测试安全哨兵被两类正则重复命中；所属测试为“provider task reconcile route returns generic 500 and logs no upstream secrets”，用于证明上游敏感文本不会进入响应或日志。不是配置、环境变量或真实凭据。 |

OpenAI 风格 token 与 URL userinfo 命中均为 0。文档不保存任何匹配原值。

## 工作树与未执行边界

- 候选 A 验证完成、写本文前，`git status --short` 只有既存 `?? data/`。该目录与任务开始时状态相同，未纳入暂存或提交，也未执行读取、清理或恢复；因此不宣称工作树 clean。
- 未执行真实供应商查询、真实供应商提交、付费调用、SSH、生产迁移、生产数据库或文件写入、推送、PR、Hosted CI、部署、共享 release guard 激活或 `enforce`。
- 本地 fixture、内存/临时 SQLite、loopback HTTP 和自动化测试只证明本地代码合同；它们不是第三方供应商、账单或生产接受证据。
