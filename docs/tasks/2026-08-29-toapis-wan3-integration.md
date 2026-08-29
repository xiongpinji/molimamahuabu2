# ToAPIs Wan 3.0 接入任务

## 目标

在不改变现有 ToAPIs Seedance FAST/MINI、积分、退款、SLA、AI 音乐和生产数据的前提下，接入 `wan3.0-video`。

## 已确认合同

官方来源：

- `https://docs.toapis.com/docs/cn/api-reference/videos/wan3.0/generation`
- `https://docs.toapis.com/docs/cn/api-reference/tasks/video-status`
- `https://docs.toapis.com/docs/cn/api-reference/account/token-balance`

- 官方入口：`https://toapis.xyz`
- 提交：`POST /v1/videos/generations`
- 查询：`GET /v1/videos/generations/{task_id}`
- 时长：2–30 秒整数
- 清晰度：480p、720p、1080p
- 比例：16:9、9:16、1:1、4:3、3:4、adaptive
- 参考图最多 10 张、参考视频最多 5 个、参考音频最多 5 个
- 参考视频总时长最多 15 秒、参考音频总时长最多 15 秒；缺少逐项时长元数据时本平台失败关闭，不提交上游
- 首尾帧模式与多模态参考模式互斥
- 官方合同默认生成音频，可显式关闭
- 官方合同默认清晰度 1080p、默认比例 adaptive；为防止意外付费，调用方仍必须显式指定 2–30 秒时长
- ToAPIs 未公开 Wan 3.0 报价接口；真实验证采用最低参数档 `2 秒 + 480p + audio=false`，并在提交前要求人工确认人民币预计成本和硬上限

## 分阶段边界

1. 使用独立 `toapisWan3VideoClient` 完成后端适配和合同测试；旧 FAST/MINI 客户端及其付费证据面保持不变。
2. 已使用目标 Key 完成一次真实生成并确认成功终态、结果文件可读取；本地管理端预设、能力标识和计费门禁只开放本次实测覆盖的 `480P / 2 秒 / 静音`。
3. 官方合同中的其他分辨率、时长、音频和参考素材能力继续保持关闭，必须分别取得真实生成与可读产物证据后才能开放。
4. 当前仅完成本地实现与验证；生产模型目录仍须绑定通过 external verifier 的脱敏证据、管理员价格和成本，并经过 PR、CI、受保护增量候选及单独授权激活。

## 2026-08-29 真实生成记录

- 使用现有 ToAPIs FAST 配置凭据完成提交前余额预检；响应为无限额度账户（`unlimited_quota=true`、`remain_balance=-1`）。
- 仅提交 1 次 `wan3.0-video`：纯文本、2 秒、480P、16:9、`audio=false`；`post_count=1`。
- 供应商任务：`tsk_vid_01M150FMESA327X6X138D2VSQJ`，已到 `completed` / 100%。
- 结果文件可读取：MP4 / H.264，832×480，2.000 秒，656147 字节，无音轨。
- 结果 SHA-256：`eab4b63757f699eb346c42104e408006c426d8d27efca779b4c0fa7f2a8625e5`。
- 抽帧人工检查符合“阳光移动经过空工作台、无文字、无标志”的提示词。
- 无限额度账户没有形成可绑定本任务的正向扣费差值，因此当前只证明真实生成能力与结果可读性，不把本轮记录冒充完整公开计费证据；未重复提交。
- 本地实现已经具备管理端预设和严格能力合同；在完整脱敏 evidence、价格和成本绑定通过 external verifier 且受保护候选获准激活前，生产用户端继续不可见，不写生产配置。

## 验收标准

- Seedance 既有请求体和能力测试保持通过。
- Wan 3.0 使用自己的字段：`ratio`、`audio`、`reference_images`、`video_list`、`audio_with_roles`。
- 素材上限、时长、比例、分辨率和首尾帧互斥均有测试。
- 未完成真实生成，或缺少可信 evidence、价格、成本任一绑定时，公共模型目录必须失败关闭，用户端不可选择该模型。
- 每次真实提交必须包含稳定 `client_business_id`（或由 `video_gen_id` 派生），未知结果只进入人工对账，禁止自动重试。
- 进入适配器的参考素材必须已解析为公网 HTTPS URL；内部 `asset://` URI 禁止直接发送给供应商。
- 本平台产品层继续要求非空提示词；这是明确的本地产品约束，不宣称支持上游的“仅媒体、空提示词”宽松模式。
