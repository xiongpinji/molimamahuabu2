# 画布文本能力指纹兼容修复（2026-08-24）

## 生产只读证据

- 实时发布：`provider-connection-verification-pr189-20260824-4ecde7f5-r2`。
- 服务状态：`active`，`NRestarts=0`。
- 失败日志：`canvas text generation {"error":"config must include capabilities"}`。
- `gpt-5.6-sol` 的两条已验证文本配置均未声明画布能力元数据；主线路健康状态仍为 `healthy`。
- 失败路由停留在 `created` 且没有供应商尝试，证明请求未发送到上游。
- 对应 10 积分预扣状态为 `refunded`，未遗留冻结或实际扣费。

## 根因与修复边界

供应商尝试凭证要求配置指纹包含能力合同，但历史文本配置没有图片/视频类能力元数据。创建凭证时因此抛错，早于上游请求。

修复仅允许 `text` 配置在未声明能力元数据时使用空能力合同生成统一指纹。尝试凭证和 canary `shadow/enforce` 共用这一指纹语义；图片和视频配置仍保持缺少能力合同即拒绝，其他配置身份字段也继续严格校验。

## 本地验证

- 红灯：生产同形文本配置稳定复现 `config must include capabilities`。
- 反向红灯：确认初版兼容逻辑会错误放宽非文本线路后，增加拒绝回归并收紧实现。
- 绿灯：
  - `providerRouteStability.test.js`
  - `providerRouteTextIntegration.test.js`
  - `providerCanaryPublicGate.test.js`
  - `canvas-text-generation.test.js`
  - `text-generation-billing.test.js`
  - `providerCanaryEvidence.test.js`
- 结果：83 个测试通过，0 失败。
- CI 门禁修复：主动巡检锁保留原 `PR #184` 批准为历史记录，并使用本次范围专属批准；独立发布范围固定为 9 个精确文件，禁止通配、运行数据、上传目录、AI 音乐与共享发布门禁。
- `featureLockManifest.test.js` 与 `incrementalReleaseScope.test.js`：33 个测试通过，0 失败。
- `verify-feature-lock-manifest.js --base origin/main`：`ready=true`，6 个锁，8 个变更路径，6 个基线保护锁。

## 发布状态

本文件记录的是 PR 候选证据。修复尚未合并或部署；线上在受保护发布完成前仍可能复现该错误。
