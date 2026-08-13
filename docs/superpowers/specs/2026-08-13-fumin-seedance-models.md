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

当前只开放已实测合同：5 秒、16:9、480P、最多 1 张图片参考。720P 曾尝试实测，但供应商因当前 Key 预扣费额度不足（约需 $7.89、可用约 $5.07）拒绝受理，因此未进入模型目录和请求能力。价格和 API 成本不在代码中硬编码，须由管理员在模型价格管理中分别配置两个别名；未配置价格时沿用现有门禁，禁止生成。额度充足后需重新分别实测 FAST/MINI 的 720P，再单独提交能力开放变更。

## 变更范围

- 新增 fumin 视频协议适配器和单元/路由测试
- 在后端连接测试中增加只读模型目录探针
- 在前端 AI 配置中增加 fumin provider、模型别名和端点预览
- 在画布模型能力目录中增加 fumin 两个别名的已验证能力
- 不修改既有供应商的模型名、Key、价格、默认配置或生产数据

## fumin GPT Image 2 图片模型

同一中转站新增两个已真实生成验证的图片模型。为避免与现有供应商同名模型串路由、串价格，本地使用独立别名，提交时再映射为上游原名：

- `fumin-gpt-image-2` → `gpt-image-2`
- `fumin-gpt-image-2-4K` → `gpt-image-2-4K`

真实验证时间：2026-08-13（Asia/Shanghai）。两个模型均使用目标图片 Key 各提交一次真实生成，请求规格为 1024×1024、`quality=low`、PNG；两次均成功返回可解码的 `b64_json`，落盘后 PNG 文件头可读：

- `gpt-image-2`：约 1.92 MB
- `gpt-image-2-4K`：约 1.97 MB

接口契约为 Base URL `https://fumin.ai/v1`、生成 `POST /images/generations`、认证 `Authorization: Bearer <key>`。后台“测试连接”仅执行只读 `GET /v1/models`，不提交付费任务。

图片价格和 API 成本不在代码中硬编码。管理员需要按 `fumin-gpt-image-2`、`fumin-gpt-image-2-4K` 两个本地别名分别配置；未配置价格时继续使用现有生成门禁。接入不修改任何既有图片供应商的模型、Key、价格和默认项。
