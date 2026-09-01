# PR #217 一键转绘真实生成审核上下文一致性验证

## 范围与边界

- 范围：修复单镜真实生成入口与公开 `generation-gate` 对准备门禁使用不同可信资产读取上下文的问题。
- 边界：仅本地代码、测试和隔离验收数据诊断；不读取供应商 Key，不调用供应商，不付费，不写生产数据库，不推送，不合并，不部署。
- 既有付费验收状态与锁保持原样，不复用、不重试。

## 故障与根因证据

- 修复前，单镜产品生成入口返回 HTTP 409、`REDRAW_ASSET_REVIEW_REQUIRED`，供应商提交数保持为 0。
- 对同一隔离数据库、同一镜头做只读 A/B：真实生成上下文得到 45 项缺失；公开门禁上下文得到 `ok=true` 且 `missing=[]`。
- 差异收敛到路由装配：公开门禁向准备门禁传入 `assetReader.canRead/owns`，真实生成入口此前仅传 `storageRoot/canReadArtifact`。没有 `drama_id` 的已登记参考资产因缺少 `assetReader.owns` 被错误判为不可信。

## TDD 与实现

- 红测：新增路由测试，断言真实生成服务收到与公开门禁一致的 `preparationContext`；修复前因该字段为 `undefined` 按预期失败。
- 实现：路由内部新增唯一 `generationPreparationContext()`，真实生成与公开门禁共同复用；未改变审核规则、资产所有权规则、计费或供应商提交行为。
- 绿测：新增路由测试通过；路由测试 144/144，通过；生成测试 122 通过、1 跳过、0 失败；准备/审核/reference bundle 127/127，通过。相关测试合计 393 通过、1 跳过、0 失败。

## 完整回归状态

- 第一次完整后端回归：3823 项，3813 通过、9 跳过、1 失败。
- 唯一失败为功能锁要求本次 `backend-node/src/routes/redraw.js` 修改登记新鲜批准；不存在其他代码或行为回归失败。
- 本地 `HEAD^` 审计只覆盖最后一笔 5 文件提交，未覆盖 GitHub 合并引用相对 `main` 的整段 PR 差异，因此没有发现三项共享稳定性锁的当前批准仍指向“失败终态释放重复提交锁”。
- 功能锁与增量范围测试：62/62 通过。
- 独立功能锁真实差异审计：`ready=true`，`baseRef=HEAD^`，15 个变更路径，10 项受保护功能。
- 最终完整后端回归：3823 项，3814 通过、9 跳过、0 失败，退出码 0，耗时 1717648.3041 ms。

## Hosted CI 功能锁收口

- GitHub 合并引用相对最新 `origin/main` 的真实差异为 23 个文件；`stability.safe-provider-failover`、`stability.unknown-state-billing-reconciliation` 和 `stability.proactive-canary-and-public-evidence` 均实际触及 Fumin 运行时路径。
- 红测先将这三项锁的期望固定为：当前批准是 `pr-217-fumin-product-api-one-shot-acceptance`，`canvas-failed-generation-resubmit` 保留在批准历史；修复前 19 项功能锁测试中 4 项按预期失败。
- 实现只交换这三项锁中上述两份既有批准的当前位置和历史位置，并同步断言；未新增批准、未扩大授权、未修改运行时代码。
- 绿测：功能锁测试 19/19 通过；显式执行 `verify-feature-lock-manifest.js --base origin/main` 返回 `ready=true`、`changedPaths=23`、`protectedFeaturesFromBase=10`。
- 修复后定向回归：415 项，414 通过、1 跳过、0 失败；前端生产构建完成 1915 个模块，退出码 0。
- 修复后完整后端回归：3823 项，3814 通过、9 跳过、0 失败，退出码 0，耗时 1869159.474 ms。
- 本阶段不读取供应商 Key、不调用供应商、不付费、不写生产数据库、不合并、不部署。
