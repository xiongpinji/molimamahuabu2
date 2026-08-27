# 供应商 Canary 元数据修复规划实现计划

> **面向 AI 代理的工作者：** 使用测试驱动开发逐项实现；本计划只生成只读修复建议，不写生产数据库、不启用模型、不触发供应商请求。

**目标：** 把当前供应商 canary 阻断项转换为可复核、可 CAS 校验的修复清单，明确区分可补元数据、需要拆分多模型配置和缺少价格/成本/能力证据的情况，杜绝猜测性修复。

**架构：** 新建纯只读规划服务，复用 `providerCanaryInventoryService` 的 blocker 结果，并单独读取配置的模型数量及更新时间。规划结果只包含内部配置 ID、脱敏 route ref、阻断项、操作分类与当前指纹；不会生成逻辑模型 ID、价格、成本或能力值。CLI 仅打开只读 SQLite 并输出 JSON。

**技术栈：** Node.js、better-sqlite3、node:test

---

## 固定安全边界

- 不修改 `ai_service_configs`、`model_credit_prices`、`provider_route_costs` 或任何生产表。
- 不复制同类供应商成本，不根据名称猜测逻辑模型 ID。
- 单条配置包含多个非空模型时标记 `split_config_required`，不得推荐单一逻辑模型 ID。
- 输出不得包含 API Key、完整中转站 URL、请求头或供应商原始错误正文。
- 未来应用阶段必须重新读取实时 current、在部署锁内备份数据库，并按 `config_id + expected_fingerprint` 做 CAS；不在本计划内执行。

## 任务 1：修复现有图片 failover 测试的环境污染断言

**文件：**
- 修改：`backend-node/test/providerRouteImageIntegration.test.js`

- [ ] 删除“默认存储目录必须不存在”的脆弱断言。
- [ ] 改为断言本次生成记录的 `local_path` 位于测试临时 `storageRoot` 且文件存在。
- [ ] 如需锁定默认目录未被本次测试写入，执行前后比较目录条目，不删除任何既有 ignored 文件。
- [ ] 单独运行该用例，确认由红转绿。

## 任务 2：先用失败测试冻结修复规划合同

**文件：**
- 新建：`backend-node/test/providerCanaryRemediationPlan.test.js`
- 新建：`backend-node/src/services/providerCanaryRemediationPlanService.js`

- [ ] 建立最小 SQLite fixture，覆盖单模型缺逻辑映射、多模型配置、缺成本、缺能力、缺运行时映射和已暂停配置。
- [ ] 首先断言不存在的 `buildRemediationPlan` 合同并运行，保留预期失败证据。
- [ ] 固定操作分类：`manual_mapping_required`、`split_config_required`、`user_price_required`、`cost_evidence_required`、`capability_evidence_required`、`runtime_mapping_required`、`generation_evidence_required`。
- [ ] 断言多模型配置只给出 `split_config_required`，不会生成建议逻辑模型或成本值。
- [ ] 断言输出含 `expected_updated_at` 与稳定 `expected_fingerprint`，且不含 key、完整 URL 或 settings 原文。

## 任务 3：实现最小只读规划服务

**文件：**
- 新建：`backend-node/src/services/providerCanaryRemediationPlanService.js`

- [ ] 调用现有 `buildCanaryReadiness` 获取 blocker，不改其既有公开 schema。
- [ ] 只读取规划所需列：`id`、`service_type`、`model`、`default_model`、`is_active`、`updated_at` 及用于 CAS 的非敏感映射字段。
- [ ] 默认只规划启用且有 blocker 的配置；暂停配置不进入可应用清单。
- [ ] 对配置当前值和 blocker 计算稳定 SHA-256 指纹，供未来 CAS 使用。
- [ ] 汇总各操作分类数量，不产生任何 SQL 更新语句。

## 任务 4：提供只读 CLI

**文件：**
- 新建：`backend-node/scripts/plan-provider-canary-remediation.js`

- [ ] 接收 `--db` 和可选 `--output`；SQLite 使用 `{ readonly: true, fileMustExist: true }`。
- [ ] 默认打印 JSON；指定输出时使用同目录临时文件加 rename 原子落盘。
- [ ] 非法参数、缺表或 schema 漂移必须失败退出，不能降级为空报告。
- [ ] 增加 CLI 测试，断言数据库哈希/mtime 与表内容不变。

## 任务 5：回归与交付门禁

- [ ] 运行 `node --test --test-concurrency=1 test/providerCanaryRemediationPlan.test.js test/providerCanaryInventory.test.js`。
- [ ] 运行图片 failover 单测及既定 115 项 provider/billing 目标回归。
- [ ] 在本地副本上运行 CLI 并人工检查不含密钥与完整 URL。
- [ ] 交付仅含本地分支、测试结果和只读报告；推送、PR、生产候选、数据库修改及付费 canary 均需后续单独授权。

## 2026-08-27 本地执行记录

- 已完成任务 1 至 4 的 TDD 实现；CLI 已加入 Git 显式纳入规则。
- 新增测试先红后绿；Canary 规划与既有 Inventory 联合回归通过。
- 规划器按脱敏 `route_ref` 配对配置，反序测试通过；不再依赖数组顺序。
- 既定 provider/billing 核心回归 115/115 通过。
- 未推送、未创建 PR、未部署、未写生产数据库、未启用模型、未发起供应商或付费请求。
- 任务 5 中的生产只读副本报告与后续应用阶段仍待单独授权。
