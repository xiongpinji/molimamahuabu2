# 安全边界修复说明（2026-07-24）

## 范围

本轮只处理以下两个高风险边界：

1. TTS 调用不得把 API Key 明文写入控制台或应用日志。
2. 租户成员移除遵循 `owner > admin > member`：
   - `admin` 只能移除 `member`；
   - `admin` 不能移除 `admin` 或 `owner`；
   - `owner` 可以管理成员，但不能移除租户最后一个活跃 `owner`。

## 验收标准

- OpenAI 兼容 TTS 请求仍携带正确的 Authorization 请求头并成功保存音频。
- TTS 合成期间产生的控制台日志和应用日志均不包含 API Key。
- 静态测试仅检查 TTS 服务中“日志调用直接引用 API Key”的风险，不因正常请求头使用 API Key 而误报。
- `admin` 移除 `member` 成功。
- `admin` 移除 `admin` 或 `owner` 被拒绝，且目标成员关系保持不变。
- 最后一个活跃 `owner` 不能被移除。
- 目标测试、全量后端测试和 `git diff --check` 全部通过。

## 非目标

- 不修改租户角色授予、角色变更或前端按钮显示逻辑。
- 不改变现有无权访问时使用 `TENANT_NOT_FOUND` 隐藏租户信息的策略。
- 不重构 TTS 提供商实现或租户服务的其他逻辑。
