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

## 2026-08-30 无限额度正向用量复验

- 继续使用现有 ToAPIs FAST 配置凭据，仅提交 1 次 `wan3.0-video`：纯文本、2 秒、480P、16:9、`audio=false`；`post_count=1`，没有重试。
- 供应商任务 `tsk_vid_01M18AGA9YSCSHX96QE86B6AVS` 已到 `completed` / 100%。
- 结果文件可读取：MP4 / H.264，832×480，2.000 秒，889666 字节，无音轨；SHA-256 为 `fe089a2716a46eb988b49f764755e21f36a743941abe1bf1592b3c47dea2b668`。
- 抽帧人工检查符合“阳光照过空木桌、无文字、无标志”的提示词。
- 余额前后均为 `unlimited_quota=true`、`remain_balance=-1`，但累计用量形成可绑定的正向差值：`used_balance 1.2 -> 1.3`、`used_credits 240 -> 260`。
- 本轮未预设费用硬上限，因此不得冒充普通限额付费证据；正式门禁只能通过显式的 `unlimited_quota_positive_usage_v1` 分支据实记录正向用量差，普通计量证据仍必须保留预计成本和硬上限。
- 本轮只证明 `480P / 2 秒 / 16:9 / 静音 / 纯文本`。多图、首尾帧、参考视频、参考音频、同步音频、更高分辨率和其他时长继续关闭，直到分别取得真实生成与可读产物证据。
- 零供应商请求导入器只接受该私有 smoke、目标独立配置 ID、同一凭据指纹和可读 MP4，并使用 `source_config_id` / `target_config_id` 明确记录“借用已有 FAST Key 实测、绑定全新 Wan3 配置”的来源关系。
- 事后人民币成本换算采用仓库 Wan3 合同约定的 `1 USD = 7.00 CNY`，因此本轮 `0.1 USD` 记录为 `0.70 CNY`，但不追溯声明预算上限。
- 早期用来源配置 ID 生成的本地预览 evidence/manifest 不具备目标配置绑定，不得安装、不得作为生产证据。生产 `prepare` 创建独立 Wan3 配置并返回目标 ID 后，必须零 POST 重新导入并产生新的 evidence/manifest SHA，随后才允许进入 `finalize`。
- 正式证据、独立配置、用户积分价格、模型成本和线路成本必须在同一受保护事务中逐项校验；任一项缺失或漂移时保持 inactive/unverified。完成 PR、CI、受保护候选和单独授权激活前，线上用户端继续不可见。

## 2026-08-30 私人形象证据刷新与外部证据事务

- 按获批的人民币总硬上限 `¥1.70`，先完成余额 GET，再分别提交 FAST/MINI 各 1 次私人形象真实生成；共 2 次 POST、没有重试、没有结果未知任务。
- FAST：`seedance-2-fast`、480P、4 秒、静音，产物 MP4 可读取，SHA-256 为 `fffc69e602daa89920819de9477a12d18b1a940e34677093a05ee242c4c70b3e`，供应商成本 `¥0.965347`。
- MINI：`seedance-2-mini`、480P、4 秒、静音，产物 MP4 可读取，SHA-256 为 `12a6742b1334770fe2459b7c60165971ef194723d05397c4cede59b89c0e0b5f`，供应商成本 `¥0.153648`。
- 两次合计 `¥1.118995`，低于硬上限；脱敏私人形象 evidence SHA-256 为 `cbe5499e6e28ba0f5ad10c15c448deebc9275ea41178a014a0801329a1a8f99c`。
- 生产共享证据必须从当前完整 evidence 根构建：标准 ToAPIs、USMercari、灵境记录逐值保留，只允许刷新私人形象合同并新增与目标独立配置绑定的 Wan3 合同；未知合同、不安全路径、符号链接、字节数或 SHA 不匹配均失败关闭。
- 外部证据安装采用独立事务：部署锁、`current` CAS、已安装/候选 external verifier 精确哈希、事务前备份、同文件系统 `RENAME_EXCHANGE` 原子目录交换、最终 verify-only 和失败回滚。该事务禁止替换 activator、UI/序列 verifier，禁止切换 `current`、重启服务、写业务数据库或触碰 AI 音乐。
- 本阶段仍不开放 Wan3：不新增供应商请求，不写价格，不把模型设为 active/verified，也不切换生产版本。只有 PR、Hosted CI、新候选 verify-only 和生产事务全部通过后，才允许另行申请最终开放。

## 任务状态与积分结算合同

- 供应商明确拒绝，或已受理任务查询到明确 `failed` 终态：视频、异步任务和路由必须原子进入失败终态，并且同一积分预留只退款一次。
- 已受理但仍在处理、查询异常、结果状态未知或成品不可读：积分继续 `held`，不得退款、不得扣除、不得自动重试，避免重复生成或重复扣费。
- 提交结果未知且尚无供应商 `task_id`：必须保留稳定 `client_business_id`、精确请求 SHA-256、目标配置、请求是否已发出以及安全错误分类，供管理员人工对账；`client_business_id` 不得冒充供应商 `task_id`。
- 只有取得供应商成功终态且成品可读后才允许结算扣费；只有取得明确失败终态才允许退款。

## 验收标准

- Seedance 既有请求体和能力测试保持通过。
- Wan 3.0 使用自己的字段：`ratio`、`audio`、`reference_images`、`video_list`、`audio_with_roles`。
- 素材上限、时长、比例、分辨率和首尾帧互斥均有测试。
- 未完成真实生成，或缺少可信 evidence、价格、成本任一绑定时，公共模型目录必须失败关闭，用户端不可选择该模型。
- 每次真实提交必须包含稳定 `client_business_id`（或由 `video_gen_id` 派生），未知结果只进入人工对账，禁止自动重试。
- 进入适配器的参考素材必须已解析为公网 HTTPS URL；内部 `asset://` URI 禁止直接发送给供应商。
- 本平台产品层继续要求非空提示词；这是明确的本地产品约束，不宣称支持上游的“仅媒体、空提示词”宽松模式。
