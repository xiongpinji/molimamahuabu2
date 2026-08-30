# 画布图片节点 `@` 引用参考图修复

## 目标

修复画布模式中图片节点提示词无法通过 `@` 选择已连接图片素材的问题，使图片节点与视频节点复用同一套参考图候选、引用插入和连线语义。

## 根因证据

- 图片节点已经通过 `collectDirectUpstreamImageReferences` 收集直接上游图片，并在生成请求中提交参考图。
- `freeCanvasReferenceCandidates` 已能为任意目标节点构造 `@图片N` 候选。
- `HomeCanvasNode.vue` 的候选计算、`@` 输入解析和弹层显示却分别硬编码为仅允许 `video` 节点，导致图片节点无法进入该交互链路。

## 修改边界

- 只调整 `HomeCanvasNode.vue` 中 `@` 参考图交互对节点类型的限制。
- 不修改生成请求结构、模型能力、素材库接口、连线合同、视频节点行为、积分合同或后端。
- 不部署生产环境，不调用外部生成模型，不写生产数据。

## 验收标准

1. 图片节点输入 `@` 时显示已连接且可用的图片候选。
2. 选择候选后插入既有 `@图片N` 令牌，并保持既有参考连线。
3. 视频节点原有 `@` 引用行为不变。
4. 文本、音频节点仍不启用参考图 `@` 菜单。
5. 针对性单元测试、相关前端测试与前端构建通过，受保护积分卡片合同不受影响。

## 验证记录

- TDD 红灯：`node --test test/standaloneCanvasFreeNodeRuntime.test.js`，新增用例按预期失败，20 通过、1 失败。
- TDD 绿灯：同一命令修复后 21/21 通过。
- 参考图相关回归：`node --test test/standaloneCanvasFreeNodeRuntime.test.js test/standaloneCanvasFreeNodeGeneration.test.js test/homeCanvasNodeReferencePreview.test.js test/project-asset-node-interaction.test.js`，72/72 通过。
- 浏览器交互验收：`npx playwright test e2e/home-canvas.spec.js --grep "图片节点提示词可通过 @ 选择已连接图片素材作为参考" --workers=1`，1/1 通过；本地后端未启动产生无关的只读 API 代理告警，未影响该本地画布用例。
- 完整前端单元测试：`node --test test/*.test.js`，957/957 通过。
- 前端生产构建：`npm run build`，成功，构建产物包含既有大分块体积警告，无构建错误。
- 受保护积分合同：`npm --prefix backend-node run audit:canvas-credit-contract -- --require-build`，返回 `ready: true`、`contract: canvas-credit-callout-v1`，源码与构建合同均通过。
- 未执行外部模型生成、生产数据写入或生产部署。
