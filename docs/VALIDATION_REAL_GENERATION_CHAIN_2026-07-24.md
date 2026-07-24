# 真实生成链路验证（2026-07-24）

## 结论

在不调用外部收费接口、不使用生产凭据的前提下，已用本地 HTTP 兼容供应商、临时 SQLite 和临时存储验证以下后端链路：

1. 分镜图片提交、异步任务轮询、图片记录回读和本地文件落盘；
2. 分镜视频提交、首尾帧上传、角色声线提示词传递、视频记录/分镜回写和本地文件落盘；
3. 图片/视频明确失败写回，失败任务不阻止创建新的重试任务；
4. 已持久化 `provider_task_id` 的视频在服务重启后只恢复轮询，不重复提交；
5. 指定 TTS 模型和文本传入本地兼容供应商，并把音频路径和实际模型写回分镜。

本轮发现并修复一个恢复状态缺口：启动清理曾先把可恢复的视频异步任务标为失败，随后才恢复供应商轮询。现在带有效 `provider_task_id` 且仍为 `processing` 的视频任务会跳过孤儿任务失败清理，由视频恢复流程继续轮询。

## 配置与安全边界

- `configs/config.yaml` 只声明本地存储和默认 provider 名称；实际模型、协议、端点和凭据来自 `ai_service_configs`。
- 对当前 `data/drama_generator.db` 做了只读、去密钥审计：
  - 图片：3 条启用的 `openai/openai`、`gpt-image-2` 配置；默认行为由标记为默认的 DeepWL 配置与同协议同模型池共同承担。
  - 分镜图片：没有独立 `storyboard_image` 行；当前实现会回退到启用的 `image` 配置。
  - 视频：DeepWL Grok 与 iCreat Seedance 配置启用，iCreat 为当前默认；DJPSD 配置存在但已停用。
  - TTS：当前库没有启用的 `tts` 配置，因此生产 TTS 链在补齐配置前不可用。
- 仓库根目录和 `backend-node` 未发现 `.env` / `.env.local`；本轮没有从环境变量注入生产凭据。
- 图片回归使用临时 `storyboard_image/openai` 配置和本地 `/v1/images/generations`。
- 视频回归使用临时 `video/deepwl_grok_unified` 配置和本地 `/v1/video/create`。
- TTS 回归使用临时 `tts/openai` 配置和本地 HTTP 音频响应。
- 恢复回归使用临时 `video/djpsd` 配置；供应商轮询结果与下载响应在进程内受控，验证恢复编排和状态持久化。
- 所有测试密钥均为 `test-only` / `integration-secret`，未读取、打印或使用生产密钥。
- 未调用任何公网生成接口，未消耗图片、视频或语音额度。

## 同链证据

| 能力 | 证据 | 结果 |
|---|---|---|
| 图片真实协议链 | `storyboardImageGeneration.integration.test.js` 启动本地 OpenAI 兼容服务，经 `POST /api/v1/images` 创建任务，轮询 `/tasks/:id`，回读 `/images/:id`，校验模型、授权头、提示词、`/static/` URL 和真实本地文件 | 通过 |
| 视频真实协议链 | `storyboardVideoGeneration.integration.test.js` 启动本地 DeepWL 兼容服务，经 `POST /api/v1/videos` 提交，上传首尾帧，回读任务/视频/分镜，下载视频工件 | 通过 |
| 首尾帧传递 | 同一视频集成测试校验两次参考图上传及供应商请求中的两张图片；`storyboardVideoModel.test.js` 校验失败后仍保留 `first_frame_url` / `last_frame_url` | 通过 |
| 音色提示词传递 | 视频集成测试和 `storyboardVideoModel.test.js` 校验供应商请求提示词包含 `VOICE CONTINUITY` 与角色 `voice_style`；`canvasAudioModelSelection.test.js` 校验选择的 TTS 模型和文本进入本地供应商请求 | 通过 |
| 失败写回 | `storyboardImageFailure.test.js` 校验图片记录、异步任务、分镜错误一致；`storyboardVideoModel.test.js` 校验视频记录和异步任务错误一致 | 通过 |
| 失败后重试 | 图片/视频 duplicate guard 与模型测试校验失败终态不占用活动任务，后续创建新任务且保留模型/首尾帧参数 | 通过 |
| 重启恢复 | 新增 `videoRecovery.test.js`：已有 `provider_task_id` 的 `processing` 视频只调用轮询一次，供应商提交次数为 0，最终写回视频 URL、本地工件和完成任务结果 | 通过 |
| 未知状态防重提 | `djpsdVideo.test.js` 校验轮询到期返回 `indeterminate`，并保留供应商任务编号和“请勿重复提交”语义 | 通过 |

## 最小修复

- `backend-node/src/services/taskService.js`
  - `failOrphanedAsyncTasksOnStartup` 在清理孤儿任务前查询可恢复的 `video_generations`。
  - 仅跳过满足以下全部条件的任务：视频任务、生成记录仍为 `processing`、`provider_task_id` 非空、记录未删除。
  - 缺少供应商任务编号的视频和其他异步任务仍按原规则失败写回。
- `backend-node/test/taskService.test.js`
  - 新增回归：可恢复视频任务在启动清理后仍保持 `processing`。
- `backend-node/test/videoRecovery.test.js`
  - 新增恢复闭环：只轮询、不重提、状态完成、结果和工件可读。

未修改现有 dirty 的 `imageService.js`、`imageClient.js`、`videoService.js`、`videoClient.js`、`ttsService.js`、配置/UI/画布/导演台文件。

## 验证结果

```text
node --test test/storyboardImageGeneration.integration.test.js
  test/storyboardVideoGeneration.integration.test.js
  test/storyboardVideoModel.test.js
  test/storyboardImageFailure.test.js
  test/videoDuplicateGuard.test.js
  test/videoRecovery.test.js
  test/taskService.test.js
  test/storyboardVoicePrompt.test.js
  test/seedance2VoiceConsistency.test.js
  test/canvasAudioModelSelection.test.js

35 passed, 0 failed
```

```text
node --test test/djpsdVideo.test.js test/djpsdConnection.test.js

7 passed, 0 failed
```

```text
cd frontweb
npm run build

1760 modules transformed; build passed
```

## 明确未验证项

- 未用真实付费图片/视频/TTS 凭据验证生产供应商鉴权、额度、计费和限流。
- 当前生产数据库没有启用的 TTS 配置；本地 TTS 协议链已通过，但当前实例不能据此声明“生产 TTS 可用”。
- 未向真实供应商提交生成任务，因此未验证真实模型输出质量、真实视频编码和真实声线一致性。
- 重启恢复测试验证了真实数据库状态、恢复调度、结果写回和本地工件，但供应商轮询响应为受控替身；DJPSD 请求/响应解析由独立无成本测试覆盖。
- 未做生产部署或生产数据库写入。
