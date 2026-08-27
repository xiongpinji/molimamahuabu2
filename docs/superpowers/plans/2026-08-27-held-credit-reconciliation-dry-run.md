# 冻结积分只读对账实现计划

> **面向 AI 代理的工作者：** 使用测试驱动开发逐项实现；结果未知一律保持冻结，不退款、不重试、不查询供应商。

**目标：** 对所有陈旧 `held` 预扣生成稳定、脱敏、可审计的 dry-run 分类报告，让管理员能区分明确失败候选、需要供应商人工核对、缺少终态证据以及运行中/已完成记录，同时保证报告过程零数据库写入。

**架构：** 在现有 `billingReconciliationService` 中增加不调用 `ensureSchema` 的只读扫描入口，并由独立报告服务把既有 `safety_status` 映射为四类操作建议。CLI 使用 SQLite 只读模式，输出证据计数和布尔标志，不输出供应商错误原文。现有退款入口保持不变。

**技术栈：** Node.js、better-sqlite3、node:test

---

## 固定安全边界

- `submission_unknown`、`result_unknown`、`needs_attention`、产物不可读、连接中断和存在供应商任务号但终态未确认的记录一律保持 `held`。
- dry-run 不调用 `ensureSchema`，不创建表/索引，不写审计事件，不调用退款函数。
- 不请求供应商，不自动重试，不修改任务状态。
- 缺表或列时必须显式失败，不能当成“无证据”或“可退款”。
- 任何真实退款必须另行授权，限定明确 reservation ID，部署锁内备份并使用幂等键；不属于本计划。

## 任务 1：先用失败测试冻结只读扫描合同

**文件：**
- 新建：`backend-node/test/billingReconciliationDryRun.test.js`
- 修改：`backend-node/src/services/billingReconciliationService.js`
- 新建：`backend-node/src/services/billingReconciliationDryRunService.js`

- [ ] 建立磁盘 SQLite fixture，包含个人/租户 held、明确失败、needs_attention、运行中、已完成、无证据和带 provider task ID 的失败记录。
- [ ] 首先调用尚不存在的 `listAnomaliesReadOnly` / `buildDryRunReport` 并运行，保留预期失败证据。
- [ ] 固定四类输出：`safe_refund_candidate`、`hold_for_provider_review`、`missing_terminal_evidence`、`completed_or_running_do_not_touch`。
- [ ] 断言未知状态和 provider task ID 记录永不进入 `safe_refund_candidate`。
- [ ] 断言报告前后数据库哈希不变，且不存在 `billing_reconciliation_events` 表。

## 任务 2：实现不建表的只读扫描入口

**文件：**
- 修改：`backend-node/src/services/billingReconciliationService.js`

- [ ] 把 cutoff、limit 和 evidence 分类复用到 `listAnomaliesReadOnly`。
- [ ] `listAnomalies` 继续调用 `ensureSchema`，保持后台现有行为兼容。
- [ ] `listAnomaliesReadOnly` 不调用任何 schema 或账本初始化函数。
- [ ] 缺关联业务表时保留当前显式异常行为。

## 任务 3：实现脱敏 dry-run 报告

**文件：**
- 新建：`backend-node/src/services/billingReconciliationDryRunService.js`

- [ ] 输出 reservation ID、范围、资源类型/ID、积分、模型、创建时间、`refundable`、`safety_status`、推荐分类。
- [ ] 证据只输出各表记录数量、状态集合、是否存在 provider task ID、provider route 状态集合；不输出 message/error 原文。
- [ ] `definite_failure` 才映射为 `safe_refund_candidate`；其余按固定四类映射。
- [ ] 输出总条数和积分合计，以及各分类的条数/积分小计。

## 任务 4：提供只读 CLI

**文件：**
- 新建：`backend-node/scripts/audit-held-credit-reconciliation.js`

- [ ] 接收 `--db`、`--older-than-minutes`、`--limit`、`--now` 和可选 `--output`。
- [ ] SQLite 使用 `{ readonly: true, fileMustExist: true }`；非法参数或 schema 漂移失败退出。
- [ ] 默认输出 JSON；指定文件时原子写入本地报告，不触碰数据库。
- [ ] CLI 测试确认数据库内容和 mtime 不变，输出不含测试错误原文。

## 任务 5：回归与交付门禁

- [ ] 运行 `node --test --test-concurrency=1 test/billingReconciliationDryRun.test.js test/billingReconciliation.test.js test/providerReconciliation.test.js`。
- [ ] 运行既定 115 项 provider/billing 目标回归。
- [ ] 用线上 SQLite 的只读副本生成报告并核对总数/积分；不在生产 SQLite 上创建任何对象。
- [ ] 交付仅含本地分支、测试结果和 dry-run 报告；退款、重试、供应商查询、推送、部署需后续单独授权。

## 2026-08-27 本地执行记录

- 已完成任务 1 至 4 的 TDD 实现；CLI 已加入 Git 显式纳入规则。
- dry-run 严格预检账本、生成记录、provider route 与 provider attempt 证据结构；缺表或缺任务号列失败关闭。
- 新增及联合回归 47/47 通过，既定 provider/billing 核心回归 115/115 通过。
- 本轮实时只读审计仍为 21 条 held、2885 积分；没有记录被自动升级为退款动作。
- 未退款、未重试、未查询供应商、未付费、未推送、未部署、未写生产数据库。
- 任务 5 中的生产只读副本正式报告及任何真实处理仍待单独授权。
