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

## 真实模型门禁

状态：`blocked`

当前仍没有转绘版本绑定的本地化场景、去人净景、本地化物品和目标语言样音完整同链证据；角色三视图已有候选真实产物，但尚未写回当前转绘版本/审核链。已有历史 TTS 记录没有可读音频文件和目标语言绑定。浏览器用例使用路由 fixture，只证明 UI/API 合同和审核门禁状态转换，不证明供应商能力、真实生成或积分链路。

在获得目标 Key 和明确授权的测试素材后，必须分别完成角色三视图、本地化场景、去人净景、本地化物品和目标语言样音的真实生成，等待成功终态并验证结果文件可读取；记录不含密钥的配置 ID、模型、任务 ID、终态、资产 ID、分辨率/时长。任何失败或产物不可读均保持 `blocked`，不得把模型写入生产目录。
