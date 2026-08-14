# 图片节点参考图与模型路由修复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复图片节点连线参考图只显示“等待素材”、Fumin 4K 因模型大小写丢失而报“未配置图片模型”，并为线上模型目录与执行路由不一致建立可验证的修复边界。

**架构：** 图片引用在收集层保留 `kind: 'image'`，让现有编辑器按媒体类型渲染；图片计费只规范化价格查询键，不覆盖提交供应商时使用的模型标识。线上独有的 `cfg-{id}::model` 路由先形成回归证据，待其当前代码进入 Git 基线后以同一测试修复，禁止把线上复合文件整体覆盖回仓库。

**技术栈：** Vue 3、Node.js ESM 测试、Express、better-sqlite3、Node.js 内置测试运行器。

---

## 文件职责

- `frontweb/src/utils/freeCanvasGeneration.js`：生成下游节点可消费的媒体引用合同。
- `frontweb/src/components/dramaCanvas/HomeCanvasNode.vue`：按引用媒体类型展示图片、视频和音频预览。
- `frontweb/test/standaloneCanvasFreeNodeGeneration.test.js`：锁定图片引用必须保留 `kind`。
- `frontweb/test/standaloneCanvasFreeNodeRuntime.test.js`：锁定编辑器根据 `kind` 渲染真实缩略图。
- `backend-node/src/services/imageClient.js`：按不区分大小写的模型名查找配置，并恢复配置中保存的规范模型名。
- `backend-node/src/services/imageService.js`：分离“供应商生成模型标识”和“计费规范键”。
- `backend-node/test/fuminImage.test.js`：锁定 Fumin 4K 从计费到供应商路由的大小写合同。
- `docs/superpowers/reports/2026-08-14-canvas-image-node-repair-verification.md`：记录红灯、绿灯、全量测试、构建和未解决供应商状态。

### 任务 1：保留图片引用类型并渲染缩略图

**文件：**
- 修改：`frontweb/test/standaloneCanvasFreeNodeGeneration.test.js`
- 修改：`frontweb/test/standaloneCanvasFreeNodeRuntime.test.js`
- 修改：`frontweb/src/utils/freeCanvasGeneration.js`

- [x] **步骤 1：把期望引用改为包含图片类型**

```js
assert.deepEqual(collectDirectUpstreamImageReferences(nodes, edges, 'video'), [
  { kind: 'image', nodeId: 'image-ready', edgeId: 'manual:ready', title: '首帧', url: '/static/first.png', ready: true, slot: 'reference-image', enabled: true, order: 0, weight: 1 },
  { kind: 'image', nodeId: 'image-pending', edgeId: 'manual:pending', title: '尾帧', url: '', ready: false, slot: 'reference-image', enabled: true, order: 1, weight: 1 },
])
```

- [x] **步骤 2：增加编辑器真实图片分支合同**

```js
assert.match(nodeSource, /<img v-if="reference\.url && reference\.kind === 'image'"/)
assert.match(nodeSource, /<span v-else class="reference-placeholder">/)
```

- [x] **步骤 3：运行红灯测试**

运行：`cd frontweb && node --test test/standaloneCanvasFreeNodeGeneration.test.js test/standaloneCanvasFreeNodeRuntime.test.js`

预期：引用深比较失败，实际结果缺少 `kind: 'image'`。

- [x] **步骤 4：实施最小修复**

```js
export function collectDirectUpstreamImageReferences(nodes = [], edges = [], targetNodeId = '') {
  return collectDirectUpstreamMediaReferences(nodes, edges, targetNodeId)
    .filter((reference) => reference.kind === 'image')
}
```

- [x] **步骤 5：运行绿灯测试并提交**

运行：`cd frontweb && node --test test/standaloneCanvasFreeNodeGeneration.test.js test/standaloneCanvasFreeNodeRuntime.test.js`

预期：全部通过。

提交：`git commit -m "fix(画布): 恢复图片节点参考图预览"`

### 任务 2：保留 Fumin 4K 供应商模型标识

**文件：**
- 修改：`backend-node/test/fuminImage.test.js`
- 修改：`backend-node/src/services/imageClient.js`
- 修改：`backend-node/src/services/imageService.js`

- [x] **步骤 1：增加计费后路由回归测试**

```js
const created = imageService.create(db, log, {
  drama_id: 1,
  model: 'fumin-gpt-image-2-4K',
  prompt: '电影感人物肖像',
}, {
  billingEnabled: true,
  userId: 'user-1',
  schedule() {},
})
const row = db.prepare('SELECT model FROM image_generations WHERE id = ?').get(created.id)
assert.equal(row.model, 'fumin-gpt-image-2-4K')
assert.equal(imageClient.getDefaultImageConfig(db, 'fumin-gpt-image-2-4k', null, 'image')?.provider, 'fumin_image')
```

- [x] **步骤 2：运行红灯测试**

运行：`cd backend-node && node --test test/fuminImage.test.js`

预期：数据库保存值为小写 `fumin-gpt-image-2-4k`，或小写选择无法匹配 Fumin 配置。

- [x] **步骤 3：最小化修复配置匹配和生成模型持久化**

```js
const wantedModel = String(preferredModel).trim().toLowerCase()
const matching = active.filter((config) => configuredModels(config)
  .some((model) => String(model).trim().toLowerCase() === wantedModel))
```

生成记录保存配置中的 `generationModel`，计费仍使用 `canonicalModel(generationModel)` 得到价格键。

- [x] **步骤 4：运行绿灯测试并提交**

运行：`cd backend-node && node --test test/fuminImage.test.js`

预期：全部通过，测试仅访问本地内存数据库和本地 HTTP 服务器。

提交：`git commit -m "fix(图片): 保留 Fumin 4K 模型路由标识"`

### 任务 3：核对失败任务恢复与线上 cfg 路由差异

**文件：**
- 检查：`frontweb/src/views/DramaCanvas.vue`
- 检查：`backend-node/src/services/imageClient.js`
- 创建：`docs/superpowers/reports/2026-08-14-canvas-image-node-repair-verification.md`

- [ ] **步骤 1：验证现有失败任务恢复链**

检查 `resumePendingFreeCanvasTasks → resumeFreeCanvasNodeTask → pollFreeCanvasTask`，确认后端 `failed` 会执行：

```js
await patchFreeCanvasNodeData(node.id, {
  status: 'failed',
  generationActive: false,
  taskId,
  error: errorMessage,
})
```

若源码合同已存在，不为截图发生在任务终态之前而新增重复状态机；在报告中记录“现有代码具备恢复逻辑，需浏览器刷新验收”。

- [ ] **步骤 2：记录 Git main 与线上复合源码差异**

线上 `cfg-{id}::model` 逻辑尚未完整进入 `origin/main`，且另一个工作树正在修改相同文件。报告必须记录线上失败样本 `cfg-4::gpt-image-2-3.5k → 未配置图片模型`，并把“将精确配置 ID 跨 `image/storyboard_image` 解析”列为合入前阻断项；禁止从其他工作树复制未提交文件。

- [ ] **步骤 3：检查供应商错误的代码边界**

记录以下错误不可由本地别名修复伪装为成功：AIHubCC `502`、Rehdasu `403`、AIHubCC 3.5K `503`、Fumin 带参考图 `504`。未获得单次付费验证授权前不提交真实生成。

### 任务 4：全量本地验证和交付停点

**文件：**
- 创建：`docs/superpowers/reports/2026-08-14-canvas-image-node-repair-verification.md`

- [ ] **步骤 1：运行前端全量测试**

运行：`cd frontweb && node --test test/*.test.js`

预期：零失败。

- [ ] **步骤 2：运行后端全量测试**

运行：`cd backend-node && node --test --test-concurrency=1 test/*.test.js`

预期：零失败，允许仓库既有明确跳过项。

- [ ] **步骤 3：运行生产前端构建**

运行：`cd frontweb && npm run build`

预期：构建成功。

- [ ] **步骤 4：审计改动范围**

运行：`git status --short && git diff --check && git diff origin/main...HEAD --name-only`

预期：只包含本计划列出的源码、测试和文档。

- [ ] **步骤 5：交付本地结果并停止**

汇报通过项、阻断项、提交 SHA 和精确文件清单。不推送、不创建 PR、不部署，等待用户下达下一条发布指令。
