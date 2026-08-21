# DeepWL Grok 视频接口学习记录

> 学习日期：2026-07-17
> 学习范围：DeepWL Grok 视频文档的全部入口，以及当前 LocalMiniDrama 视频调用链的适配差异。
> 结论：本文件只记录接口研究，不包含 API Key，也不代表已经完成供应商实测。

## 1. 先区分两套服务契约

DeepWL 文档的默认中转地址是 `https://zx1.deepwl.net`，认证方式是 `Authorization: Bearer <API_KEY>`。它提供两套 Grok 视频契约：

| 契约 | 创建 | 查询 | 请求体 | 适合场景 |
| --- | --- | --- | --- | --- |
| OpenAI 兼容 | `POST /v1/videos` | `GET /v1/videos/{task_id}` | 主要是 `multipart/form-data` | 兼容已有 OpenAI 风格视频适配器 |
| 统一视频 | `POST /v1/video/create` | `GET /v1/video/query?id={id}` | JSON | 文生、首尾帧、多参考图统一编排 |

这不是 xAI 官方地址的别名。xAI 官方 REST 使用 `https://api.x.ai/v1/videos/generations`，异步返回 `request_id`，再轮询 `GET /v1/videos/{request_id}`；DeepWL 是另一层供应商/中转契约，必须通过配置显式选择协议。

## 2. 所有页面的接口矩阵

### 2.1 OpenAI 兼容创建：`generation.md`

- 地址：`POST https://zx1.deepwl.net/v1/videos`
- 认证：Bearer Token。
- 传输：`multipart/form-data`。
- 必填：`model`、`prompt`。
- 可选：`aspect_ratio`（`16:9`、`9:16`、`2:3`、`3:2`、`1:1`）、`seconds`、`size`（`720P`/`1080P`）、重复的 `input_reference` 文件字段。
- 模型：`grok-video-3`、`grok-video-3-pro`、`grok-video-3-max`。
- `pro` 固定 10 秒，`max` 固定 15 秒；不能把用户任意时长直接传给这两个模型。
- 响应是异步任务，至少要保存 `id`、`status`、`progress`、`created_at`；初始状态通常为 `queued`。

### 2.2 Grok Imagine Video：`grok-imagine-video.md`

- 同一地址：`POST /v1/videos`，但请求体是 JSON，模型固定为 `grok-imagine-video`。
- 必填：`prompt`。
- 可选：`seconds`（字符串，最小 1 秒）、`aspect_ratio`、`resolution`（`480P`/`720P`）。Prompt 最长 4096 字符。
- 单张参考图：`image` 为完整 `data:image/...;base64,...` 字符串。
- 多张参考图：`images` 为 data URI 数组；不能同时发送 `image` 与 `images`。
- 结果通过 `video_url` 返回，也可以使用 `GET /v1/videos/{id}/content` 代理下载。
- 比例比旧版更宽，除常用比例外还允许 `4:3`、`3:4`、`2:1`、`1:2`、`19.5:9`、`9:19.5`、`20:9`、`9:20` 及自定义数值比例。

### 2.3 Grok Imagine 1.5 Preview：`grok-imagine-1-5-preview.md`

- 地址、认证、JSON 结构、`image`/`images` 互斥规则、4096 字符限制、轮询方式均与 Imagine Video 相同。
- 模型固定为 `grok-imagine-video-1.5-preview`。
- 输出参数使用 `resolution`，不是 `size`。
- 不应按模型名中含有 `grok` 和 `video` 就误判为 `grok-video-3` 的 `images + size` 结构。

### 2.4 任务查询：`query.md`

- 地址：`GET /v1/videos/{task_id}`。
- 重点字段：`id`、`status`、`progress`、`completed_at`、`expires_at`、`seconds`、`size`、`error`、`video_url`。
- 完成结果 URL 的兼容顺序：`output.url` → `video_url` → `url` → `detail.url`。
- 如果直链无法下载，回退到 `GET /v1/videos/{task_id}/content`。
- `expires_at` 表示结果链接有时效，平台应在完成后尽快把视频落入自己的资产存储。

### 2.5 Remix：`remix.md` 与 `unified-remix.md`

OpenAI 兼容路径：`POST /v1/videos/{video_id}/remix`。JSON 必填 `model`、`prompt`、`size`、`aspect_ratio`，可选 `parent_post_id`。

统一路径：`POST /v1/video/remix`。字段相同，但使用 `task_id` 放在 JSON 中。返回新任务 ID，后续仍要轮询。

### 2.6 Extend：`extend.md` 与 `unified-extend.md`

OpenAI 兼容路径：`POST /v1/videos/{video_id}/extend`。必填 `model`、`prompt`，可选 `images`、`size`、`aspect_ratio`、`start_time`、`upscale`。

统一路径：`POST /v1/video/extend`。任务 ID 通过 JSON 的 `task_id` 传递。`start_time` 表示从源视频第几秒开始延展。

### 2.7 Extensions：`extensions.md` 与 `unified-extensions.md`

- 路径统一为 `POST /v1/videos/extensions`。
- 必填：`model`、`prompt`、`video`、`start_time`。
- `video.url` 必须填写原始任务 ID（例如 `grok:...`），不能填写可播放 HTTP URL。
- `duration` 可选，默认 10 秒，支持 6/10/15 秒。
- 与 Extend 的区别：Extend 把任务 ID 放在 URL；Extensions 把源任务放进 `video.url`，更适合编排或批处理。

### 2.8 统一视频创建/查询：`unified-generation.md` 与 `unified-query.md`

创建：`POST /v1/video/create`，JSON 请求。

- `model`、`prompt`、`images`、`aspect_ratio`、`size` 是统一入口的核心字段。
- 文生视频使用 `images: []`。
- 首尾帧按顺序传两张图：`[first, last]`。
- 多参考图最多 6 张，提示词中用 `@img1`、`@img2` 等引用。
- `duration` 默认 10 秒，支持 6/10/15 秒。
- `images` 可以是公网 URL 或 data URI。
- 响应可能同时包含 `id`、`task_id`；必须保存实际返回的两个标识，并把真正用于查询的值作为 `provider_task_id`。

查询：`GET /v1/video/query?id={id}`。

- `id` 是查询参数，必须 URL encode，尤其是包含 `:` 的 `grok:...` ID。
- 重点字段：`status`、`progress`、`video_url`、`ratio`、`model`、`thumbnail_url`。
- `status` 常见值：`processing`、`completed`、`failed`、`unknown`。
- `completed` 时 `video_url` 可能仍为空，必须进入明确的错误/重试/人工核对分支，而不能标记为成功。

## 3. 素材上传与引用

DeepWL 的 `PUT /v1/file/upload` 不是直接上传文件，而是先签发预签名 PUT 地址，再上传文件本体，最后拿 `download_url` 给下游任务。默认签名有效期 900 秒，允许 60–3600 秒。

因此当前平台的安全链路应是：

1. 浏览器把本地图片/视频传给本平台后端。
2. 后端按需调用 DeepWL 预签名上传并上传素材。
3. 后端把 `download_url` 或 data URI 转成供应商所需的 `image/images/input_reference`。
4. 后端保存自己的资产副本，避免供应商临时 URL 过期。

API Key 不能放在前端，也不能把 DeepWL 的预签名 URL 当作永久资产 URL。

## 4. 与当前 LocalMiniDrama 的差异审计

当前 `backend-node/src/services/videoClient.js` 已有 `xai` 协议分支，但它的默认实现更接近 xAI 官方：

- 默认创建路径是 `/v1/videos/generations`。
- 默认查询路径是 `/v1/videos/{taskId}`。
- Imagine 请求体使用了 `image: { url }` / `reference_images` 形态。
- 通过模型名同时包含 `grok` 和 `video` 来切到 `images + size` 分支。

这与 DeepWL 文档存在四个直接差异：

1. DeepWL OpenAI 兼容 `grok-video-*` 创建是 multipart `/v1/videos`，不是 `/v1/videos/generations`。
2. DeepWL Imagine/Imagine 1.5 是 JSON `/v1/videos`，其 `image` 是 data URI 字符串，不能复用 `image: { url }`。
3. DeepWL 统一入口使用 `/v1/video/create` 与 `/v1/video/query?id=...`，当前 xAI 默认查询器没有统一查询分支。
4. `grok-imagine-video-1.5-preview` 不能按 `grok-video-3` 的模型名规则发送 `images + size`。

因此，当前代码“有 xAI 支持”不等于“已经支持 DeepWL Grok 全部接口”。本轮不修改代码，先保留这个适配边界。

## 5. 推荐的最小接入策略

### 第一阶段：只接统一 JSON 主链路

新增一个 DeepWL 专用 provider adapter，默认只实现：

- `POST /v1/video/create`
- `GET /v1/video/query?id=...`
- 完成后落本平台资产
- `processing/completed/failed/unknown` 状态归一化

映射关系：

| 导演台输入 | DeepWL 统一字段 |
| --- | --- |
| 纯文生视频 | `images: []` |
| 首帧生视频 | `images: [first]`，模型允许时使用 |
| 首尾帧 | `images: [first, last]` |
| 角色/场景/道具参考 | `images` 最多 6 张 + Prompt 中的 `@imgN` |
| 导演台时长 | `duration`，先限制为 6/10/15 |
| 画幅 | `aspect_ratio` |
| 清晰度 | `size` 或按 Imagine 模型使用 `resolution` |

首选模型建议：

- 需要灵活秒数、单图/多图 JSON：`grok-imagine-video`。
- 需要统一 6/10/15 秒和 `size` 规则：`grok-video-3`。
- `grok-video-3-pro/max` 暂不作为默认值，等真实 Key 验证固定 10/15 秒后再开放。

### 第二阶段：补齐编辑接口

在创建/查询稳定后再接 Remix、Extend、Extensions，并把源任务 ID、切点、转场意图保存在导演台镜头实体中。编辑接口必须复用同一套任务归一化与资产落盘逻辑。

### 第三阶段：兼容 OpenAI multipart

只有在需要 `grok-video-3-pro/max` 或既有 OpenAI 风格调用方时，再实现 `/v1/videos` multipart adapter。不要为同一请求同时拼接统一 JSON 和 multipart 两套字段。

## 6. 实测前的验收清单

- [ ] 后端配置保存 DeepWL `base_url`、`api_key`、`api_protocol`，前端不出现 Key。
- [ ] 无参考图、单首帧、首尾帧、多参考图四种请求体快照测试。
- [ ] `id` 与 `task_id` 二选一/同时返回时都能恢复任务。
- [ ] 统一查询对 `grok:` ID 做 URL encode。
- [ ] `unknown` 不自动重复提交，提示人工核对供应商任务。
- [ ] 完成后直链过期前下载到本地资产，并保存 `expires_at`。
- [ ] 供应商失败、超时、结果缺 URL、401、429、5xx 均能归一化到平台任务状态。
- [ ] 使用真实 Key 做一次最短时长、低分辨率的沙盒生成，再验证首尾帧和 Extensions。

## 7. 官方文档入口

- [DeepWL 认证方式](https://doc.deepwl.cn/zh/account/authentication)
- [DeepWL 视频模型支持矩阵](https://doc.deepwl.cn/zh/videos/model-matrix)
- [DeepWL Grok 视频概览](https://doc.deepwl.cn/zh/videos/grok/overview)
- [DeepWL Grok 视频生成（OpenAI 格式）](https://doc.deepwl.cn/zh/videos/grok/generation)
- [DeepWL Grok Imagine Video](https://doc.deepwl.cn/zh/videos/grok/grok-imagine-video)
- [DeepWL Grok Imagine 1.5 Preview](https://doc.deepwl.cn/zh/videos/grok/grok-imagine-1-5-preview)
- [DeepWL 统一创建视频](https://doc.deepwl.cn/zh/videos/grok/unified-generation)
- [DeepWL Grok 任务查询](https://doc.deepwl.cn/zh/videos/grok/query)
- [DeepWL 统一任务查询](https://doc.deepwl.cn/zh/videos/grok/unified-query)
- [DeepWL Remix](https://doc.deepwl.cn/zh/videos/grok/remix)
- [DeepWL 统一 Remix](https://doc.deepwl.cn/zh/videos/grok/unified-remix)
- [DeepWL Extend](https://doc.deepwl.cn/zh/videos/grok/extend)
- [DeepWL 统一 Extend](https://doc.deepwl.cn/zh/videos/grok/unified-extend)
- [DeepWL Extensions](https://doc.deepwl.cn/zh/videos/grok/extensions)
- [DeepWL 统一 Extensions](https://doc.deepwl.cn/zh/videos/grok/unified-extensions)
- [DeepWL 文件上传](https://doc.deepwl.cn/zh/uploads/image-upload)
- [xAI 官方视频 REST API](https://docs.x.ai/developers/rest-api-reference/inference/videos)
- [xAI 官方视频生成说明](https://docs.x.ai/developers/model-capabilities/video/generation)
