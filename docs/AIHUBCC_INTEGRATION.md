# AIHubCC 图片与视频模型接入

本项目已将飞书文档中的 AIHubCC 协议接入现有服务端模型路由，前端只保存配置，不直接调用供应商。

## 配置

在「AI 配置」中新增图片、分镜图片或视频配置，供应商选择 `AIHubCC`，Base URL 默认：

```text
https://aihubcc.cc/v1
```

API Key 只保存在服务端配置中。图片配置默认提交 `/images/generations`；视频配置提交 `/videos`，轮询 `/videos/{taskId}`。

## 支持范围

- 图片：`gpt-image-2`、`gpt-image-2-1k` 同步生成；`gpt-image-2-2k`、`gpt-image-2-3.5k`、`gpt-image-2-4k` 使用提交任务后轮询的异步流程。
- 图片参考图：最多传入 6 张，服务端会把本地素材转换为可访问地址或 data URL，不把密钥暴露给浏览器。
- 视频：`omni-fast*` 使用 `seconds`，Seedance 2.0 系列使用 `duration`；保留 `aspect_ratio`、首帧、尾帧和参考图字段。
- 任务完成但响应没有直链时，服务端会继续请求 `/videos/{taskId}/content`。

## 验证

```powershell
node --test backend-node/test/aihubccClient.test.js backend-node/test/aihubccImage.test.js
```

AIHubCC 异步轮询默认间隔 5 秒，测试可用 `AIHUBCC_POLL_INTERVAL_MS=0`，生产不要关闭轮询间隔。
