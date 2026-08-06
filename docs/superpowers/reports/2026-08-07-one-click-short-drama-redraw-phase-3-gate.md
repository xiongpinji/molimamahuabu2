# 一键转绘阶段 3 分镜生成与计费门禁记录

日期：2026-08-07

分支：`codex/short-drama-redraw-design`

代码提交：`1603d7a4`、`542e3252`、`a51cb45e`、`a69bd5c4`、`3991a396`、`859b46c1`、`02018249`、`b742ceb5`

范围：阶段 3 任务 1–6、阶段 2 到阶段 3 的结构同链修复和本地自动化验收；未发起新的付费模型调用，未执行生产部署。

## 门禁结论

状态：`blocked`

`productComplete=false`

阶段 3 任务 1–6 的代码、计费合同和浏览器交互已经完成；任务 7 的真实视频生成、同请求幂等、失败注入和重启恢复没有执行。当前仍缺少真实本地化编排入口、真实资产报价/供应商接入、当前转绘版本绑定的已审批资产链，以及通过可读产物验证的目标视频模型同链证据，因此不得声称已经实现可生产的“1:1 完全替换出片”。

## 已完成能力

- 分镜保留源时间码、源/英文对白分列、开场状态、连续动作、镜尾状态和结构化资产引用。
- 单镜与批量生成统一使用当前版本快照，支持失败重试、processing 幂等、有限并发和重启后的原任务回读。
- 视频模型只从服务端 verified locale capability 解析；客户端不能改变模型、attempt、积分、产物或内部任务字段。
- 分镜报价、冻结、成功结算、明确失败释放和未知状态 held/needs_attention 均由后端账本驱动。
- 资产生成首次认领已物化草稿，只接受同租户、同用户、同版本的 `redraw_assets.id`，零分镜和未审批引用均 fail closed。
- 资产 GET 报价与 POST 生成共用服务端报价器；POST 会重新报价。客户端模型/积分/reservation 注入返回 `400 REDRAW_ASSET_CLIENT_CONTROL_FORBIDDEN`；未定价或价格异常返回 `409 pricing_unconfigured`，provider 与 reservation 均为 0。
- 前端覆盖批次、筛选、结构化 `@角色/@场景/@物品`、单镜/批量提交、失败重试、原片/新片对照、后端轮询恢复和醒目积分合同 `canvas-credit-callout-v1`。

## 自动化证据

- 完整后端：`866 tests / 865 pass / 0 fail / 1 skip`。
- 转绘相关前端 Node 合同：`16/16` 通过。
- 前端生产构建：`npm run build` 通过；只有既有 chunk 大小警告。
- Chromium：`frontweb/e2e/redraw-workspace.spec.js` `11/11` 通过，覆盖桌面端、390px 移动端、未定价、无模型、资产门禁、单镜、批量、失败重试、轮询停止和控制台错误断言。
- 独立规格审查：阶段 3 任务 6 最终 `APPROVED`。
- 独立代码审查：`02018249` 与 `b742ceb5` 均 `APPROVED`，0 个遗留问题。
- `git diff --check` 通过。

## 非转绘基线失败

完整前端 Node 套件为 `595 tests / 585 pass / 10 fail`。10 个失败全部位于：

- `frontweb/test/canvasInteractionEntrypoints.test.js`
- `frontweb/test/standaloneCanvasFreeNodeRuntime.test.js`
- `frontweb/test/standaloneCanvasNodeEditorParity.test.js`

这些测试和对应 `frontweb/src/views/DramaCanvas.vue` 从阶段 3 基线 `c8c46c21` 到当前代码提交没有 diff；本任务未修改这些画布模块，因此不在本阶段顺带修复。

## 视觉验收边界

功能性浏览器验收有效，但像素级视觉验收阻塞。仓库缺少 `reference.png`、视觉规格、视觉规格复审、设计系统响应式规格和合规报告；详见 `07_validation/visual_acceptance/blocked-report.md`。在提供这些输入前，不声明与竞品界面视觉 1:1。

## 阶段 4 / 真实任务前置条件

1. 完成真实文本本地化编排：verified `text_localization`、异步任务、服务端报价、reservation、供应商 task ID、重启恢复、失败释放和目标对白时长质检。
2. 在应用总路由接入真实 `assetQuoteProvider/assetGenerationProvider`，并用当前版本完成角色、场景、物品、净景和英文音色的可读产物及逐项审批。
3. 重新生成通过尺寸与非遮罩相似度门禁的去人净景。
4. 只在存在与 locale/market 匹配且可读产物验证的 verified 视频能力时，由用户明确授权一次新的付费真实分镜生成。
5. 对同一真实请求执行重复提交、失败注入、未知状态和后端重启恢复审计，确认 provider task、reservation、shot、video asset 和账本一致。

任一条件缺失时保持 `blocked`，不把模型写入转绘目录，不执行生产发布。
