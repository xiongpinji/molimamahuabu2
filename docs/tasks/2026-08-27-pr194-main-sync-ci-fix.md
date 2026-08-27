# PR #194 合入最新 main 与 Hosted CI 修复

## 授权

- 授权时间：2026-08-27
- 授权原文：`批准按上述方案修复并推送 PR #194。`
- 允许范围：将最新 `main` 合入 PR #194，解决功能锁冲突，完成本地回归后推送并运行 Hosted CI。
- 禁止范围：不合并 PR、不部署、不调用真实供应商、不付费、不写生产数据库。

## 变更边界

1. 保留 PR #193 图片结果未知安全收口授权历史。
2. 保留 PR #195 跨版本静态资源兼容授权历史。
3. 仅为 PR #194 实际触及的 `stability.provider-route-contract` 与
   `stability.proactive-canary-and-public-evidence` 登记本次新鲜授权。
4. 依赖安全修复直接继承最新 `main` 中的 `urllib@4.9.1`，不重复引入依赖覆盖。

## 验证要求

- 功能锁清单定向测试与相对 `origin/main` 的真实差异门禁通过。
- `npm audit --omit=dev --audit-level=high` 通过。
- 后端与前端完整测试、前端生产构建通过。
- 推送后当前 HEAD 的 Hosted CI 全部通过。
