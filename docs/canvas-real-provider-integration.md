# 独立画布三模型真实接入

## 范围

- 页面仅限 `/canvas/local` 与 `/canvas/:id`。
- 文本节点：`gpt-5.6-sol`，使用 `POST /responses`。
- 图片节点：`gpt-image-2-2k`，使用同步 `POST /chat/completions`。
- 视频节点：`lingjing-video-v1`，使用素材上传、任务创建、轮询与结果下载。
- API Key 只能通过服务端环境变量注入，不进入前端、数据库迁移、日志、Git 或 PR。

## 环境变量

| 类型 | Base URL | API Key | Model |
| --- | --- | --- | --- |
| 文本 | `CANVAS_TEXT_BASE_URL` | `CANVAS_TEXT_API_KEY` | `CANVAS_TEXT_MODEL` |
| 图片 | `CANVAS_IMAGE_BASE_URL` | `CANVAS_IMAGE_API_KEY` | `CANVAS_IMAGE_MODEL` |
| 视频 | `CANVAS_VIDEO_BASE_URL` | `CANVAS_VIDEO_API_KEY` | `CANVAS_VIDEO_MODEL` |

## 验收

1. 模型目录只返回模型、能力和价格，不返回密钥。
2. 文本节点生成后正文写回节点，刷新后仍存在。
3. 图片节点返回真实图片并自动写入项目素材库。
4. 图片节点连接视频节点时，按连线顺序上传为 `reference_images`。
5. 视频任务展示运行进度；成功后写回视频、入库并可刷新恢复。
6. `402/403/429` 和供应商失败必须写回节点，不盲目重复提交。
7. 未配置环境变量时继续使用原有数据库 AI 配置，不改变短剧工厂行为。
