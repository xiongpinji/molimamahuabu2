# 隐患治理部署前验证（2026-09-18）

## 部署裁决

| 门禁 | 状态 |
|------|------|
| **本批治理门禁** `npm run verify:risk-remediation-gate` | ✅ **pass**（合同 91 + 用户 HTTP 冒烟 18） |
| 前端全量 / 构建 | ✅ 980 pass；build ok |
| 后端全量 `npm test` | ❌ 仍有与本批无关的失败（外部模型门禁 fixture、Playwright 合同、个别 createApp 隔离问题等） |
| 受保护发布 VERIFY_ONLY | ❌ 未做 |
| 生产同构人工验收 | ❌ 未做 |

**生产 activate 仍为 NO-GO**，直到 VERIFY_ONLY + 人工清单完成。  
**本批代码合入候选的技术门禁已绿**，可进入「从实时 current 克隆候选、只覆盖审计文件」阶段（需你明确授权后再动生产机）。

## 本轮跟进已做

1. 安装缺失依赖 `ajv@8.17.1`
2. **积分冻结改为系统收口（不要求人工对账）**：无供应商任务号孤儿启动即失败退款；有任务号交给恢复/轮询，超时约 10 分钟自动退款
3. 固化门禁脚本：`npm run verify:risk-remediation-gate`（重跑仍 pass）
4. 用户视角 HTTP 冒烟 **18/18**

## 下一步（需授权）

1. 列出本批审计覆盖文件清单
2. SSH：从实时 `current` 克隆候选，只覆盖清单文件 + 前端 dist（若需要）
3. `audit:canvas-credit-contract -- --require-build`
4. `PROTECTED_RELEASE_VERIFY_ONLY=1` 共享激活器
5. 生产同构人工：登录 toast、画布积分卡片、跨租户拒绝、生成预扣、重启后自动退款/恢复
6. 正式 activate；**不要**开 `AI_CONFIG_ENCRYPT_AT_REST`

## 全量失败说明（不阻塞本批门禁）

全量曾报 ~134 fail，其中已修本批相关项；其余主要为：

- `sharedExternalModelReleaseGuard*` / `toapisWan3*`：本机缺生产证据树
- `webProductionDeploymentContract`：Playwright 合同文本
- `redrawAnalysis` createApp 用例：易连到非临时库（测试隔离问题，非治理逻辑回归）
