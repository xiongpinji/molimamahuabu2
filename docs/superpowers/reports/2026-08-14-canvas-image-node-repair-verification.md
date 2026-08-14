# 图片节点参考图与模型路由修复验证报告

## 结论

本地已完成并验证两项确定性代码修复：

1. 图片节点连线作为参考图时保留 `kind: 'image'`，编辑器可以进入真实图片缩略图分支，不再只显示“等待素材”。
2. Fumin 4K 图片模型在计费规范化后仍保留供应商配置中的 `fumin-gpt-image-2-4K` 标识，不再因小写 `k` 导致配置匹配失败。

本报告不宣称线上所有图片模型已经可用。线上独有的 `cfg-{id}::model` 选择路由尚未进入当前 Git 基线，且多个供应商错误属于上游可用性问题。当前分支只完成本地修复、测试和构建，没有推送、创建 PR、调用付费生成或修改生产环境。

## 修复内容

### 参考图预览

- 根因：`collectDirectUpstreamImageReferences` 在过滤图片引用后又删除了 `kind` 字段，而 `HomeCanvasNode.vue` 仅在 `reference.kind === 'image'` 时渲染 `<img>`。
- 修复：图片引用继续保留 `kind: 'image'`。
- 回归覆盖：普通自由图片节点、项目图片素材节点和编辑器真实缩略图分支。

### Fumin 4K 路由

- 根因：计费模型规范化把 `fumin-gpt-image-2-4K` 转成小写并写入 `image_generations.model`；后续供应商配置匹配区分大小写，导致“未配置图片模型”。
- 修复：供应商生成模型和计费模型分离；生成记录保留配置模型原始大小写，价格查询仍使用规范化键；配置模型匹配改为不区分大小写并恢复配置中的规范模型名。
- 回归覆盖：内存数据库中创建 4K 任务后保存大写 `K`，小写选择也能解析到 `fumin_image` 配置。

## 失败任务恢复合同

现有代码已具备以下恢复链：

`loadForDrama → rebuildGraph → resumePendingFreeCanvasTasks → resumeFreeCanvasNodeTask → pollFreeCanvasTask`

恢复轮询遇到后端失败终态时，会写回：

```js
{
  status: 'failed',
  generationActive: false,
  taskId,
  error: errorMessage,
}
```

本次增加源码合同测试锁定该链路，没有新增重复状态机。浏览器刷新后的真实线上状态恢复仍需在安全部署后验收。

## 线上只读审计边界

2026-08-14 的生产只读审计确认了多类不同错误，不能用一个本地别名修复伪装为全部恢复：

| 模型/选择 | 线上表现 | 当前判断 |
| --- | --- | --- |
| `gpt-image-2-2k` | `502 / fetch failed` | 供应商或网络链路错误，未做付费重试 |
| `gpt-image-2` | `403 / no active subscription` | 供应商账户状态错误 |
| `cfg-6::gpt-image-2-3.5k` | `503 / no available channel` | 供应商通道错误 |
| `cfg-4::gpt-image-2-3.5k` | “未配置图片模型” | 线上 `cfg-*` 精确配置选择跨服务类型解析缺口 |
| `fumin-gpt-image-2`（带参考图） | `504 / timeout` | 上游超时；无参考图同模型曾完成，不能据此证明参考图链路可用 |
| `fumin-gpt-image-2-4K` | “未配置图片模型” | 本分支已修复大小写路由根因，待安全发布后验证 |

失败图片任务的积分预留均有对应退款，未发现残留冻结积分；成功任务正常结算。参考源文件、数据库连线和 URL 在只读检查时存在且可读，前端缩略图缺失的确定性根因是引用类型字段被删除。

## `cfg-*` 合入阻断项

生产当前版本包含尚未进入 `origin/main` 的 `cfg-{id}::model` 复合选择逻辑；当前 Git 基线没有对应的 `mediaModelSelectionService.js`，不能在本分支安全复现完整路由。另一个工作树 `wt-canvas-full-function-qa` 正在未提交地修改 `imageClient.js`、`canvasModelCatalogService.js`、`DramaCanvas.vue` 等重叠文件。

因此本次没有复制线上复合文件，也没有复制其他工作树的未提交文件。后续合入或部署前必须先解决该代码来源与冲突，并为“精确配置 ID 跨 `image` / `storyboard_image` 解析”补充可执行回归测试。

## 验证证据

### TDD 红灯与绿灯

- 参考图测试红灯：深比较显示实际引用缺少 `kind: 'image'`；修复后目标测试 39/39 通过。
- Fumin 4K 测试红灯：实际保存 `fumin-gpt-image-2-4k`，期望 `fumin-gpt-image-2-4K`；修复后 6/6 通过。
- 全量前端首次运行发现项目素材断言仍采用旧合同；补充 `kind: 'image'` 后全量归零。

### 全量验证

- 前端：`node --test test/*.test.js`，637 通过、0 失败。
- 后端：`node --test --test-concurrency=1 test/*.test.js`，753 通过、1 个仓库既有跳过、0 失败。
- 前端生产构建：`npm run build` 成功；仅报告既有的 Rollup 大包体警告。
- 格式审计：`git diff --check` 通过。

以上测试均为本地测试、内存数据库或本地 HTTP 服务，没有向供应商提交真实生成。

## 发布前必须满足

1. 推送分支、创建 PR、等待 CI 并合入最新 `main`。
2. 解决或明确排除 `wt-canvas-full-function-qa` 的重叠改动，重新做冲突扫描。
3. 从实时 `/opt/moli-drama/current` 克隆候选，只覆盖审计允许的改动文件；不得整体覆盖线上复合版本。
4. 使用部署锁、CAS、备份、活动任务、健康检查和共享保护门禁激活候选，并确认 AI 音乐服务完全隔离。
5. 部署后用已登录浏览器验证参考图缩略图、4K 路由、失败状态刷新恢复；供应商模型可用性需另行取得单次付费验证授权。
