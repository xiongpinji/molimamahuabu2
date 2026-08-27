# ToAPIs FAST/MINI 独立 Key 付费验证修复

## 问题

FAST 与 MINI 使用不同供应商 Key。旧付费验证器虽然从数据库读取两个配置，但提交与轮询仍可能被全局 `TOAPIS_API_KEY` 覆盖，导致余额预检与实际请求使用不同账号。

## 固定合同

- FAST/MINI 配置 ID、模型和 Key 必须分别绑定，两个 Key 不得相同。
- 本轮涉及的所有模型必须在首个付费 POST 前完成各自余额 GET。
- 余额、提交、轮询和结算必须使用同一模型绑定 Key。
- 显式请求 Key 优先于全局环境变量；普通线上调用未传显式 Key 时保持原有解析行为。
- Key 仅驻留内存，状态和证据只保存 SHA-256 配置指纹。
- 任一提交结果未知立即停止，不自动重试。

## 本地证据

- `toapisVideoClient.test.js`：显式 Key 在 POST/GET 中均不受错误全局 Key 覆盖。
- `toapisVideoVerification.test.js`：双配置、双余额预检、按模型提交/轮询/结算。
- `sharedExternalModelReleaseGuard.test.js`：拒绝全局 Key 回退、共用 Key、缺失余额预检及显式 Key 旁路。
- feature-lock audit：本次路径未命中既有功能锁 `protectedPaths`，不修改锁定验收标准或历史证据。

真实 8 次生成、共享 verifier/evidence 事务升级、候选 verify-only、激活和线上零付费回归必须在合并后按生产门禁单独留证；本文不把本地测试等同于生产验收。
