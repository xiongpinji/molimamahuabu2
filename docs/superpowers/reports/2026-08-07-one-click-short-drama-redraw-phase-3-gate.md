# 一键转绘阶段 3 门禁记录

日期：2026-08-07 19:14:20 +08:00

工作树：`C:\Users\canqu\Documents\茉莉妈妈2\worktrees\baseline-canvas-video-first-last-20260806`

分支：`codex/short-drama-redraw-design`

基线 HEAD：`7060393d155297a1617ccfcf3ade698417ad36b5`

范围：Task11 本地 Playwright fixture 合同闭环；未发起真实 provider、付费调用或生产部署。

## 门禁结论

状态：`blocked`

`productComplete=false`

本次只证明本地实现、fake-provider/fixture 合同、前端恢复逻辑和 SQLite 账本相关自动化仍可运行。没有付费授权、目标 Key、AGENTS 要求的已验证模型、真实可读产物、供应商账本或最终成片，因此不得声称“1:1 产品完成”，不得写入生产模型目录，不得发布生产。

## 本次新增浏览器合同

- analysis task `completed` 且 `workflow_phase=analysis_review` 时仍停在 Step1，并显示服务端本地化报价 9 积分。
- 点击“确认英文 1:1 本地化”会二次请求 `/redraw/works/710/localization-quote`，再用服务端 `quote_hash` 创建 `/redraw/works/710/versions`。
- 本地化 `localizing` 显示独立 `task-localization-812` 和 33% 进度；页面 reload 后可从 GET work 恢复。
- create version 响应只用于提交本地化任务；localizing 期间 GET work 公开状态保持 `version_id=null/current_version=0/current_step=1`，promotion 前未请求 `/redraw/versions/812/assets` 或 `/generation-gate`，hidden draft version 未泄漏到资产审核。
- 后续 GET work 返回 `current_step=2/version_id=812/workflow_phase=asset_review` 后，页面经轮询自动进入 Step2。
- 主闭环初始资产使用独立 `materializedDraftAssets`：全部为 `status=draft`，且无 `asset_id/clean_plate_asset_id/voice_asset_id` 等生成产物；首轮 batch quote items 精确覆盖 draft ids `1201/1202/1203`。
- Step2 显示资产批量总价 18；首次批量创建后轮询 GET work/listAssets，恢复 `partial_failed` 的 2 成功 / 1 失败 / 3 总数。
- partial_failed 后才把成功项转为 `generated` 并写入 fixture artifact id，失败项 `1202` 保持 `failed` 且无成功产物；retry completed 后才把 `1202` 转为 `generated` 并写入 `clean_plate_asset_id=2202`。
- “一键重试失败项”在 subset quote hash 变化时要求再次确认；最终 `/assets/batches` 请求的 `asset_ids` 只含失败资产 `1202`，不含成功项 `1201/1203`。
- retry quote items 也只覆盖 `1202`，create body 只包含 `1202`。
- 重试成功后资产可批准；全部批准后 gate 推进 `current_step=3`，`03 批量转绘` 开放。
- create version 与两次 asset batch 请求正文断言只含允许字段；不含 `model/provider/credits/credit_amount/dialogue/localized_dialogue/characters/maps`。
- Desktop 1440 和 390px 关键页面继续执行无横向滚动检查；所有 Playwright 用例沿用 `pageerror` 和 console error 归零门禁。

## 自动化证据

- 首红：`cd frontweb; $env:PLAYWRIGHT_REUSE_SERVER='0'; npx playwright test e2e/redraw-workspace.spec.js` 首次有效运行 `10 passed / 2 failed`。新增场景失败于未返回“本地化报价 9 积分”；既有 Step2 因 fixture 扩为 3 项资产后旧断言仍按 2 项失败。
- 回修首红：`cd frontweb; $env:PLAYWRIGHT_REUSE_SERVER='0'; npx playwright test e2e/redraw-workspace.spec.js -g "本地化确认后资产批次部分失败只重试失败项并开放第三步"` 失败于新增断言 `Expected: true / Received: false`，捕获当前主闭环初始资产不是 draft。
- 回修定向单测：同 `-g` 命令，`1 passed`，耗时约 18.9 秒。
- 定向 Playwright：`cd frontweb; $env:PLAYWRIGHT_REUSE_SERVER='0'; npx playwright test e2e/redraw-workspace.spec.js`，`12 passed`，耗时约 1.0 分钟。
- 后端全量：`cd backend-node; npm test`。第一次 180 秒超时且无统计；延长后 exit 0，`962 tests / 961 pass / 0 fail / 1 skipped / 0 todo`，`duration_ms 197193.3268`。skip 名称：`verifyVideoArtifact 使用 realpath 阻止指向根外的 symlink 但允许根内 symlink`，原因 `symlink unavailable: EPERM`。
- 前端 Node 全量：`cd frontweb; node --test test/*.test.js`，exit 1，`615 tests / 605 pass / 10 fail / 0 skipped / 0 todo`，`duration_ms 27545.574`。
- 前端构建：`cd frontweb; npm run build` exit 0，Vite `built in 28.73s`，仅有大 chunk 警告。
- 语法检查：`node --check frontweb\e2e\redraw-workspace.spec.js` exit 0。
- Diff 检查：`git diff --check` exit 0；仅提示 `frontweb/e2e/redraw-workspace.spec.js` 下次 Git 触碰时 LF 会替换为 CRLF。

## 前端既有失败比较

本次前端 Node 全量仍为 10 个失败，失败文件只限既有画布基线范围：

- `frontweb/test/canvasInteractionEntrypoints.test.js`
- `frontweb/test/standaloneCanvasFreeNodeRuntime.test.js`
- `frontweb/test/standaloneCanvasNodeEditorParity.test.js`

当前失败断言：

- 画布保留 LibTV 式导航、框选和拖拽历史入口
- 节点拖拽停止后立即刷新布局缓存并同步视口
- 右键空白画布提供 LibTV 式添加节点入口并使用点击位置
- 右键节点支持追加下游分镜并自动创建手动连线
- 右键节点支持在现有下游连线中插入分镜并重连
- 右键分镜节点支持克隆到旁边
- 画布保存使用串行队列并在执行时构造最新布局
- 四类节点编辑器暴露 LibTV 核心参数且不隐藏在假配置按钮后
- 选中节点可从主体按住左键拖动且编辑器尺寸收紧
- 图片视频节点使用大画幅预览，运行中明确显示生成状态且画布支持高倍缩放

本任务只修改转绘 Playwright fixture/用例和本报告；未修改上述画布实现或 Node 测试文件，因此这些失败按既有基线记录，不作为 Task11 新失败。

## 证据分级

- `passed`：本地实现与 Playwright fake-provider/fixture 合同，覆盖本地化确认、hidden draft 未泄漏、materialized draft 资产批量生成、部分失败、只重试失败项、审核开放 Step3、请求体禁止客户端控制字段、桌面/移动无横向滚动和 console/pageerror 归零。
- `passed`：恢复逻辑，本地化 reload 恢复、轮询 GET work 推进 Step2、资产批次轮询 GET work/listAssets 恢复 partial_failed/completed。
- `passed`：SQLite 账本相关后端自动化随 `backend-node npm test` 全量通过，后端全量 `962 / 961 pass / 0 fail / 1 skipped`。
- `blocked`：真实文本本地化。缺少付费授权、目标 Key、已验证目标模型、真实供应商任务和可读本地化产物。
- `blocked`：角色图、净景、道具和 TTS。fixture 只证明前端合同，不证明真实供应商生成、尺寸/质量/时长或可读文件。
- `blocked`：供应商账本。没有真实 reservation、provider task、扣费/退款流水与供应商侧账单核对。
- `blocked`：最终成片。没有真实镜头视频、播放、下载、归档或审计产物。
- `not_released`：未执行 `/opt/moli-drama` 生产候选、共享门禁或生产切换。

## Task12 前置条件

进入真实供应商 Task12 前必须同时具备：

1. 用户明确付费授权。
2. 目标 Key 与隔离租户。
3. AGENTS 要求的已验证模型，且每个模型已用目标 Key 完成真实生成。
4. 真实文本本地化、角色图、净景、道具、TTS 和视频供应商任务 ID。
5. 可读产物、尺寸、时长、hash、播放/下载证据。
6. SQLite 账本 reservation、charged/released、供应商账单和失败退款审计。
7. 不含密钥的任务文档证据链。
