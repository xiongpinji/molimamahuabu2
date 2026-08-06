# 一键转绘阶段 2 真实生成审计门禁记录

日期：2026-08-06
分支：`codex/short-drama-redraw-design`
提交：`d3eaee1`
范围：阶段 2 任务 1-7 的本地实现和自动化验收；未执行生产部署。

## 已验证

- 后端阶段 2 联合回归：`43/43` 通过，覆盖本地化资产、音色门禁、审核门禁和路由。
- 前端阶段 2 合同测试：`14/14` 通过，覆盖资产类型、审核状态、报价和门禁纯函数。
- Playwright：`frontweb/e2e/redraw-workspace.spec.js` `4/4` 通过，覆盖第二步逐项批准、门禁开放、退回后重新关闭，以及 390px 移动端无横向溢出。
- 前端生产构建：`npm run build` 通过，仅保留既有大 chunk 警告。
- `git diff HEAD^..HEAD --check` 通过，工作树干净。

## 已发现的隔离真实图片证据

- `artifacts/fafa-ai-phase2-real-review/950ae46381/image-review-wSEeqG/review.json` 记录了一次隔离 AIHubCC `gpt-image-2-3.5k` 成功任务：`run_id=3869808f-8240-4ef7-9fd9-b5636a64ccd4`、`task_id=4a4f51d9-d783-41c0-bbe2-f0185183cd63`、`route_id=config:1`、`database_readback=true`、`deployed=false`。
- 结果文件 `storage/creation-templates/ctr_cafe7c53.jpg` 为 345003 bytes，SHA-256 为 `32370613588F765D4344FB2F20094147A5E21CE3F6DB1D23E5640A32FBFA186D`，已实际读取确认，为商品多视图图像。
- 该证据只能作为通用图片供应商能力和物品多视图候选证据；没有转绘版本/资产 ID、角色/场景/去人净景语义绑定或 TTS 产物，因此不能单独解除任务 8 门禁。

## 线上模型匹配与新增只读核验

查询时间：`2026-08-06`；只读 release：`/opt/moli-drama/releases/canvas-model-duration-20260806T214500CST`。

生产 `ai_service_configs` 已存在可用于本阶段的匹配，且均为启用、`verification_status=verified`：

| 能力 | 配置 ID | 供应商 | 默认模型 |
| --- | ---: | --- | --- |
| 图片 | `2` | OpenAI | `gpt-image-2-2k` |
| 分镜图片 | `4` | AIHubCC | `gpt-image-2-3.5k` |
| 图片备用 | `6` | AIHubCC | `gpt-image-2-3.5k` |
| 图片 | `10` | OpenAI | `gpt-image-2` |
| 图片 | `11` | Token6688 | `token6688-gpt-image-2` |
| TTS | `8` | MiniMax | `speech-2.8-turbo` |

这证明“模型匹配”已经存在，不需要为了阶段 2 另建配置；但配置状态本身仍不替代转绘任务的同链产物证据。

线上确有角色三视图真实任务，且结果文件已读取：

- `async_tasks.id=e55f2a6d-3b63-45c9-ad0e-94edee880b63`，类型 `image_tool_character_views`，模型 `gpt-image-2-3.5k`，终态 `completed`，源资产 `624`，结果资产 `628`，项目 `drama_id=51`，结果为 `2048x1536 PNG / 3850770 bytes`，SHA-256 `7e679909878f78a4804784a509804e016d21c8365f187a1ef838ea8ba0d3c0b7`。
- `async_tasks.id=036fdb6e-2633-49be-970f-f1c496e107d1`，类型 `image_tool_character_views`，模型 `gpt-image-2-3.5k`，终态 `completed`，源资产 `636`，结果资产 `637`，项目 `drama_id=54`，结果为 `2048x1536 PNG / 2391683 bytes`，SHA-256 `98686e7a164e4dbb118d7bdc019e9e243ab16bc25dd791b0c3baffd90866956e`。

这些记录是可复核的角色三视图能力证据，但属于既有画布/图片工具任务：结果没有写入当前转绘版本的角色资产表，也没有与本阶段的本地化版本、审核状态和目标语言绑定，因此只计入“角色三视图候选证据”。

线上还存在历史画布 TTS 资产 `assets.id=508/510/575`，元数据均为 MiniMax `speech-2.8-turbo`；但三条记录的 `task_id` 为空、`local_path` 和文件大小为空，文本为中文测试句，且 `storyboards.audio_local_path` / `narration_audio_local_path` 当前只读查询结果为 0 条。因此它们不能作为目标语言样音或转绘对白产物证据。

## 授权后的隔离真实生成

用户已明确授权使用现有匹配配置。所有调用均从生产数据库只读备份创建临时数据库和临时存储，未写入线上库；授权后回读确认线上 `assets.max(id)=651`、`image_generations.max(id)=422` 且最新线上任务未变化。

- 角色三视图：配置 `4` / AIHubCC `gpt-image-2-3.5k`；包装任务 `8639e160-d421-4e5e-8634-f8ee20afdb6d`，终态 `completed`，源资产 `624`，临时结果资产 `652`，`2048x1536 / 3452589 bytes`，SHA-256 `ac245464c73377695263e2f1232033c54c55f5109dca93a4b98111db62830aff`，文件可读。
- 本地化物品：配置 `11` / Token6688 `token6688-gpt-image-2`；包装任务 `730ca7fd-920a-4f05-a290-a07bd1dbf8dd`，终态 `completed`，源物品 `props.id=43`，临时结果资产 `652`，`2048x2048 / 674792 bytes`，SHA-256 `343153cec1809d99a20abff77af7ca9b352848041d9df4662cd7df971aaae735`，文件可读。
- 本地化场景：配置 `11` / Token6688 `token6688-gpt-image-2`；包装任务 `6f9eb374-1001-4160-ba9a-a5a462008f1d`，终态 `completed`，源场景 `625`，临时结果资产 `652`，`864x1152 / 540229 bytes`，SHA-256 `e20b53909a95feaad082da13ac8959e501bdeb78e76af55480b0c4de8243815a`，文件可读。源场景为 `1728x2304`，输出保持 `3:4` 画幅但分辨率降低，只计入候选证据。
- 去人净景：配置 `11` / Token6688 `token6688-gpt-image-2`；包装任务 `b3ba200b-64ce-44e4-8c1b-9000c659d968`，供应商终态 `completed`，临时结果资产 `654`，文件可读，`864x1152 / 450456 bytes`，SHA-256 `4b0348a37525677deff478cf6af4af1768279833fbd2d25eaed1c77c5d9235bb`。质量回读为 `mask_area_changed=true`、`non_mask_similarity=0.566`、输出尺寸与源尺寸不一致，因此 `quality_pass=false`，不得作为通过证据。
- 目标语言 TTS：配置 `8` / MiniMax `speech-2.8-turbo`；临时包装任务终态 `completed`，目标语言 `en-US`，文本为 `The key opens the hidden door before sunset.`，临时产物 `redraw-live/tts/tts_sbx_9c8bca99.mp3`，`2.988s / 49524 bytes`，SHA-256 `0f255b1d6c5d6e47506a4d3751e7ca17263d4236bf263ad828bea998d810433b`，MP3 校验通过。MiniMax 该调用为同步接口，没有单独的供应商任务 ID；报告中的任务 ID 是隔离包装任务。

## 真实模型门禁

状态：`blocked`

当前已有隔离真实角色三视图、本地化物品、本地化场景和目标语言 TTS 候选证据，但尚未写回当前转绘版本/审核链；去人净景质量门禁明确失败，且本阶段没有生产转绘版本资产 ID 绑定。浏览器用例使用路由 fixture，只证明 UI/API 合同和审核门禁状态转换，不证明供应商能力、真实生成或积分链路。

要解除阻塞，还需在当前转绘版本中完成这些产物的资产 ID/审核链绑定，并重新生成通过尺寸与非遮罩相似度门禁的去人净景；任何失败或产物不可读均保持 `blocked`，不得把模型写入生产目录。
