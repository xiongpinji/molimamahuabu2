# PR #193 图片结果未知安全收口 CI 验证（2026-08-25）

## 范围与批准

- 用户于 2026-08-25 明确批准按最小方案修复 PR #193 Hosted CI。
- 本轮功能锁范围仅包括本分支实际触及的 4 个 shared 稳定性锁：供应商路由合同、安全切换、未知状态计费对账、主动巡检与公开证据。
- 保留各锁原有 `acceptance`、`protectedPaths`、`requiredTests`、`evidence` 和 `unlockHistory`；原当前批准只追加进历史，不删除、不覆盖。
- 本文件只记录本地与 Hosted CI 候选验证，不代表生产已部署、生产功能已验收或供应商真实生成成功。

## 失败证据

- 基线命令：`cd backend-node && node scripts/verify-feature-lock-manifest.js --base origin/main`。
- 基线结果：退出码非零，`ready=false`，错误为 `FEATURE_LOCKED`。
- 精确触发范围：
  - `stability.provider-route-contract`：`providerRouteStabilityService.js`
  - `stability.safe-provider-failover`：`imageClient.js`、`imageService.js`
  - `stability.unknown-state-billing-reconciliation`：`providerRouteStabilityService.js`
  - `stability.proactive-canary-and-public-evidence`：上述 3 个运行时服务文件
- Hosted CI 后端初次运行共 3093 项：3039 通过、5 失败、49 跳过。除功能锁外的 4 项兼容失败由同一 PR 的独立 TDD 修复处理，本文件不将其描述为已通过。

## 本轮锁定合同

- 本次批准：`product-owner 2026-08-25 pr-193-ci-fix-approved`。
- 影响测试固定为 DJPSD 提交前能力拒绝、图片默认线路 503 不重提、图片工具响应脱敏、未知结果防重复、路由图片集成、Token6688 以及功能锁自身测试。
- 只刷新上述 4 个锁；管理员可观测性锁与平台完整验收框架锁保持原样。

## 验证状态

- `node --test backend-node/test/featureLockManifest.test.js`：13 项通过、0 失败。
- `node --test backend-node/test/featureLockManifest.test.js backend-node/test/incrementalReleaseScope.test.js`：33 项通过、0 失败；现有范围合同未受破坏。
- `node backend-node/scripts/verify-feature-lock-manifest.js --base origin/main`：退出码 0，`ready=true`，6 个功能锁，35 个实际变更路径，6 个基线保护锁。
- PR #193 兼容修复与模型 UI 门禁定向集合：132 项通过、0 失败；模型 UI 门禁的源码 mutation 已兼容 Windows CRLF，并先断言真实合同确实被替换，避免假绿或假红。
- `feature-lock-manifest.json` 已通过 JSON 解析；未新增发布范围文件，本轮 CI 修复不制作或激活生产候选。
- PR 合入仍以所有 Hosted CI 检查转绿为前提；本证据不授权部署、生产写入、付费调用或 AI 音乐变更。
