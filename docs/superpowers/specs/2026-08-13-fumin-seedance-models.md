# fumin Seedance 2.0 FAST / MINI 接入规格

## 目标

在不覆盖已有供应商模型、配置或价格记录的前提下，新增 fumin 中转站的两个已实测视频模型：

- 前端/画布独立别名：`fumin-seedance-2.0-fast`
- 前端/画布独立别名：`fumin-seedance-2.0-mini`
- 实际提交给 fumin 的上游模型名：`seedance-2.0-fast`、`seedance-2.0-mini`

FAST 与 MINI 必须分别建立两条视频配置，每条只填写一个模型和对应 Key；禁止在一条配置中同时填写两个别名，以免一个 Key 被误用于另一个模型。

使用独立别名是为了避免画布模型目录按 `kind:model` 去重时，与既有 USMercari、iCreat 等同名模型发生串路由。

## 已完成的真实验证

验证时间：2026-08-13（Asia/Shanghai）

测试条件（两个模型一致）：

- 真人肖像：公开 HTTP(S) 图片 URL；未上传项目私有素材
- 比例：16:9
- 分辨率：480P
- 请求时长：5 秒
- 每个模型各一次真实任务提交；不做自动重试

FAST：

- 使用 FAST Key
- 任务进入队列并最终 `succeeded`
- 视频下载成功
- MP4 可读取；`ffprobe` 解析格式为 `mov,mp4,m4a,3gp,3g2,mj2`
- 实际时长约 5.088 秒，文件大小约 785 KB

MINI：

- 使用 MINI Key
- 任务进入队列并最终 `succeeded`
- 视频下载成功
- MP4 可读取；`ffprobe` 解析格式为 `mov,mp4,m4a,3gp,3g2,mj2`
- 实际时长约 5.088 秒，文件大小约 1.69 MB

此前使用带 `fumin-` 前缀的上游模型名时供应商返回 `503 model_not_found`；本接入保留前缀作为本地别名，提交时映射到上述已成功验证的裸模型名。

## 接口契约

- Base URL：`https://fumin.ai`
- 创建：`POST /api/v3/contents/generations/tasks`
- 查询：`GET /api/v3/contents/generations/tasks/{taskId}`
- 认证：`Authorization: Bearer <key>`
- 成功结果：`content.video_url`
- 连接测试：只读 `GET /v1/models`，禁止提交生成任务

## 能力边界

本次按业务提供的模型合同录入两项模型能力：

- 时长：5–15 秒（整数）
- 比例：16:9
- 分辨率：480P（本次没有扩大既有已验证分辨率范围）
- 参考图：最多 9 张
- 视频参考：最多 3 个
- 音频参考：最多 3 个

适配器在提交前对上述数量和时长做硬校验，超限直接返回错误，不静默截断、不预扣积分、不调用供应商。已完成的真实证据仍只覆盖 5 秒、480P、单张图片参考；5–15 秒及视频/音频参考属于本次按业务要求录入的声明能力，不能在任务文档中伪装成已实测证据。fumin 文档明确给出 `content` 多模态数组及 `text`、`image_url` 结构，本适配器按同一内容数组约定发送 `video_url`、`audio_url` 参考项；若供应商对具体媒体类型返回参数错误，应保留失败终态并按真实结果收窄能力。

价格和 API 成本不在代码中硬编码，须由管理员在模型价格管理中分别配置两个别名；未配置价格时沿用现有门禁，禁止生成。

## 变更范围

- 新增 fumin 视频协议适配器和单元/路由测试
- 在后端连接测试中增加只读模型目录探针
- 在前端 AI 配置中增加 fumin provider、模型别名和端点预览
- 在画布模型能力目录中增加 fumin 两个别名的声明能力；模型身份仍受真实生成验证门禁保护
- 不修改既有供应商的模型名、Key、价格、默认配置或生产数据

## fumin GPT Image 2 图片模型

同一中转站新增两个已真实生成验证的图片模型。为避免与现有供应商同名模型串路由、串价格，本地使用独立别名，提交时再映射为上游原名：

- `fumin-gpt-image-2` → `gpt-image-2`
- `fumin-gpt-image-2-4K` → `gpt-image-2-4K`

真实验证时间：2026-08-13（Asia/Shanghai）。两个模型均使用目标图片 Key 各提交一次真实生成，请求规格为 1024×1024、`quality=low`、PNG；两次均成功返回可解码的 `b64_json`，落盘后 PNG 文件头可读：

- `gpt-image-2`：约 1.92 MB
- `gpt-image-2-4K`：约 1.97 MB

接口契约为 Base URL `https://fumin.ai/v1`、生成 `POST /images/generations`、认证 `Authorization: Bearer <key>`。后台“测试连接”仅执行只读 `GET /v1/models`，不提交付费任务。

价格沿用线上当前启用的同类模型，并通过只插入缺失项的迁移写入，已有管理员调整不会被覆盖：

- `fumin-seedance-2.0-fast`：107 积分/秒，API 成本 ¥0.28/秒（对应已启用 `seedance-2-fast`）
- `fumin-seedance-2.0-mini`：50 积分/秒，API 成本 ¥0.10/秒（对应已启用 `seedance-2-mini`）
- `fumin-gpt-image-2`：40 积分/次，API 成本 ¥0.046/次（对应已启用 `gpt-image-2`）
- `fumin-gpt-image-2-4K`：70 积分/次，API 成本 ¥0.08/次（对应已启用的 GPT Image 4K 档）

以上是价格初始值，不把供应商 Key 写入迁移或代码；未配置/被停用时继续受现有生成门禁保护。接入不修改任何既有图片供应商的模型、Key、价格和默认项。
