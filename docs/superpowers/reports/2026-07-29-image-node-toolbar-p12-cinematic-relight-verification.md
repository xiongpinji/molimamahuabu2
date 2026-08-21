# 图片节点工具栏 P12：电影级光影校正验证报告

## 结论

- 状态：本地实现、验证和审计通过。
- 交付边界：仅在图片节点工具栏新增“电影级光影校正”，不改写源素材；生成结果作为新素材入库。
- 可用性边界：只有图片供应商配置显式声明 `supports_cinematic_relight=true` 时开放；未配置时继续显示“未接通”。
- 禁区：本阶段未增加核验、侵权检测、版权判断或相关入口。
- 发布边界：本报告只证明隔离工作树的本地能力，不代表已推送 PR 或同步线上服务器。

## 实现与隔离

- 工作树：`C:\Users\canqu\Documents\茉莉妈妈2\wt-image-node-toolbar`
- 分支：`codex/image-node-tool-suite`
- 隔离后端：`127.0.0.1:3033`
- 隔离前端：`127.0.0.1:5699`
- 隔离数据库：`C:\Users\canqu\AppData\Local\Temp\molimama-image-tools-e2e-20260728\drama.sqlite`
- 隔离素材目录：`C:\Users\canqu\AppData\Local\Temp\molimama-image-tools-e2e-20260728\storage`
- 原仓库既有改动 `frontweb/e2e/project-canvas-backend-integration.spec.js` 未触碰。

功能使用现有 Volcengine/Seedream 参考图供应商适配器，不新增一套模拟生产后端。输入包含一张当前素材参考图，输出必须满足图片格式、像素、宽高比和同尺寸约束；空文件、超限文件、尺寸异常和与源图哈希相同的结果均拒绝入库。

## 测试驱动证据

### 首轮红灯

1. 供应商 HTTP 500 返回正文包含 `private-provider-response-secret` 时，原日志把正文写入 `Image API failed.details.body`，脱敏测试失败。
2. `cinematic_relight` 失败参数经 `canvas_layout.free_nodes` 标准化后被丢弃，刷新恢复测试得到 `undefined`。

### 最小修复

1. HTTP 非 2xx 日志只记录 `status` 和 `response_bytes`，不记录供应商正文。
2. 只给 `cinematic_relight` 增加 `preset`、`intensity`、`description` 重试白名单；描述上限为 300 字符，超限时整组重试参数拒绝持久化。

### 绿灯结果

- `node --test test/imageTools.test.js`：31/31。
- `node --test test/standaloneCanvasFreeNodeGeneration.test.js`：9/9。
- `node --test test/imageNodeToolbar.test.js`：13/13。
- `node --check src/services/imageClient.js`：通过。
- `node --check src/services/imageToolService.js`：通过。

### 双轴复核补强

独立规格复核和代码标准复核发现并关闭了以下缺口：

1. HTTP 200 但 JSON 损坏或无图片时，移除 `raw_preview` / `data_preview`，仅保留响应字节数和结构字段。
2. 在转码和尺寸归一化前增加供应商下载产物与源文件的原始 SHA-256 比较，JPEG 原样回传也会被拒绝。
3. 电影光影能力单独收紧到 `storyboard_image + volcengine + doubao-seedream-4-5`；普通图片配置、仿冒模型名和未审计供应商均不能开放 P12，不改变既有扩图和标记修图的门禁。
4. `preset`、`intensity` 和 `description` 执行严格类型校验；描述只做首尾去空白后按原长度校验，不再通过折叠内部空白绕过 300 字符上限。

## 真实浏览器与后端回读

### 成功链

- 浏览器中的“电影级光影校正”按钮可见且可用。
- 参数：`golden_hour`、强度 `4/5`、补充要求“保留人物面部，增加窗外暖色轮廓光”。
- 供应商收到一次真实 HTTP `POST /api/v3/images/generations`：
  - 模型：`doubao-seedream-4-5`
  - 尺寸：`2880x1620`
  - 参考图：1 张 data URL
  - 水印：`false`
  - 包含负向提示词和人物、构图、透视、纹理、画风、尺寸保持约束
- 源素材：ID `20`。
- 结果素材：ID `21`，PNG，`2880x1620`。
- 源素材验证前后 SHA-256 均为 `7ce3d1320b6e0819b034f27a94f08871e5e9ae95c5bdc5cdb2ae8136f28b1c28`。
- 结果 SHA-256 为 `4d3570cde6557d5d3021a80587d501523ec342c3d46ef9fdcad857aa1ba30be2`。
- 异步任务 `12cf8ef2-1531-4930-9cac-e840198991a1` 状态为 `completed`、进度 `100`。
- 刷新后结果图和“电影级光影校正 / 已完成”历史均可恢复。

### 失败、刷新与重试链

- 供应商返回 HTTP 500 时，界面只显示“电影级光影校正处理失败”，不暴露上游正文。
- 失败后仍保留素材 ID `21` 的结果 URL，处理历史未伪造成功记录。
- 持久化重试参数：
  - `preset=moonlight`
  - `intensity=5`
  - `description=失败后必须保留这一组重试参数`
- 页面刷新后“重试”按钮可见且可用。
- 第一次重试的供应商输出与源图相同，被同哈希安全门正确拒绝。
- 换用内容不同但尺寸相同的隔离输出后再次重试成功：
  - 新素材：ID `22`
  - PNG，`2880x1620`
  - 源素材 ID `21` 重试前后 SHA-256 均为 `4d3570cde6557d5d3021a80587d501523ec342c3d46ef9fdcad857aa1ba30be2`
  - 新素材 SHA-256 为 `2af5567d84d2e478d289cfb610892318aedddf8b517489179289a7b636f253df`
  - 元数据完整记录 `cinematic_relight`、月夜预设、强度、补充要求、供应商和源素材 ID
  - 异步任务 `e4cbdca5-338a-4a30-8b2e-4769a61020a6` 状态为 `completed`、进度 `100`
  - 处理历史由 12 条增至 13 条
  - 成功后失败信息和重试参数被清空
- 再次刷新后新结果和历史可恢复，浏览器控制台只有 Vite 连接调试信息，无 error 或 warning。

### 复核修复后的再验证

- 在严格供应商门禁下，隔离 `storyboard_image / volcengine / doubao-seedream-4-5` 配置仍正常开放按钮。
- 参数：`studio_soft`、强度 `4/5`、补充要求“复核后实链，保持人物与构图不变”。
- 新素材：ID `23`，PNG，`2880x1620`。
- 源素材 ID `22` 的 SHA-256 在处理前后均为 `2af5567d84d2e478d289cfb610892318aedddf8b517489179289a7b636f253df`。
- 异步任务 `4cf3bbca-9a38-4f39-b87d-a9208c2224a1` 状态为 `completed`、进度 `100`。
- 供应商请求仍包含 1 张参考图、同尺寸请求和补充要求；处理历史增至 14 条，浏览器无 error 或 warning。

## 全量回归与审计

- 后端正式测试集合 `test/*.test.js`：462/462。
- 前端全量测试：339/339。
- 前端 `npm run build`：成功。
- 后端 `npm audit --registry=https://registry.npmjs.org --audit-level=high`：0 个漏洞。
- 前端 `npm audit --registry=https://registry.npmjs.org --audit-level=high`：0 个漏洞。
- `git diff --check`：通过。
- 变更生产文件禁区扫描 `核验|侵权|版权|copyright|infringement`：无匹配。

构建仅保留仓库原有的大分块提示，不影响本次构建成功结论。

## 待发布事项

- 双轴复核提出的阻断问题已修复并重新通过目标测试、浏览器实链和全量门禁。
- 未执行 push、PR 或线上服务器同步。
- PR 和线上同步必须等图片节点非核验功能全部完成并再次执行总审计后再进行。
