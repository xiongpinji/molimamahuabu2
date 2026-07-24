# AIHubCC 图片与视频模型接入

本项目已将飞书文档中的 AIHubCC 协议接入现有服务端模型路由，前端只保存配置，不直接调用供应商。

## 配置

在「AI 配置」中新增图片、分镜图片或视频配置，供应商选择 `AIHubCC`，Base URL 默认：

```text
https://aihubcc.cc/v1
```

API Key 只保存在服务端配置中。接口以 AIHubCC 客户文档 `2026-07-24` 版本为准，运行时按模型自动分流：

| 能力 | 接口 | 结果 |
| --- | --- | --- |
| GPT/价格页图片 | `POST /images/generations` | `data[0].url`、`b64_json`，高分辨率任务会转异步轮询 |
| Flow Gemini/Imagen 图片 | `POST /chat/completions` | 从 `choices[0].message.content` 的 Markdown 图片中取 URL |
| Omni、Seedance、Grok、Flow Veo | `POST /videos` | `GET /videos/{taskId}` 轮询，必要时读取 `/content` |
| Veo-Clean | `POST /videos` multipart | `input_video` 文件，最大 20MB，按普通视频任务轮询 |

## 支持范围

- 图片：`gpt-image-2`、`gpt-image-2-1k` 同步生成；`gpt-image-2-2k`、`gpt-image-2-3.5k` 使用提交任务后轮询的异步流程。价格页已经没有 `gpt-image-2-4k`，因此预设中已移除。
- Flow 图片：内置 Gemini 3.1 Flash、Gemini 3.0 Pro、Imagen 4 的常用横屏、竖屏、方形和 2K 模型。其他文档模型仍可在「模型列表」中手动填写。
- 图片参考图：最多传入 6 张，服务端会把本地素材转换为可访问地址或 data URL，不把密钥暴露给浏览器。
- 视频：`omni-fast*` 使用 `seconds`，Seedance 2.0 与 Grok 使用兼容字段；Flow Veo 的时长、分辨率和画幅由模型名决定，服务端不会再发送冲突的 `duration` 或 `aspect_ratio`。
- Flow 首尾帧：使用 `first_image_url`、`last_image_url`；Flow R2V 使用 `images`，最多 3 张。
- `veo-clean` 是去水印后处理，不放入普通视频生成预设；服务端链路已支持以 `video_url`/本地输入构造 multipart 任务。
- 任务完成但响应没有直链时，服务端会继续请求 `/videos/{taskId}/content`。

Flow 模型需要 AIHubCC 令牌位于 `gemini-flow-1` 分组；Omni 文档使用 `gemini-高速` 分组。分组权限属于供应商账户配置，项目不会也不能自动修改。

## 验证

```powershell
cd backend-node
node --test test/aihubccClient.test.js test/aihubccImage.test.js test/aihubccVideo.test.js

cd ../frontweb
node --test test/aihubccModelCatalog.test.js
```

AIHubCC 异步轮询默认间隔 5 秒，测试可用 `AIHUBCC_POLL_INTERVAL_MS=0`，生产不要关闭轮询间隔。
