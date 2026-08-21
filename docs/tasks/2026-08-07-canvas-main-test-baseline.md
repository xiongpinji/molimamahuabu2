# 主线画布测试基线修复任务

## 背景

支付宝自主充值分支同步 `origin/main` 后，`frontweb` 全量 Node 测试稳定出现 10 个画布契约失败。失败对应的画布源码与测试文件和 `origin/main` 完全一致，因此先在独立分支修复主线基线，再继续充值分支评审。

## 工作范围

- `frontweb/test/canvasInteractionEntrypoints.test.js` 的 6 个失败。
- `frontweb/test/standaloneCanvasFreeNodeRuntime.test.js` 的 1 个失败。
- `frontweb/test/standaloneCanvasNodeEditorParity.test.js` 的 3 个失败。
- 仅修改根因直接涉及的画布实现或契约测试，不顺带重构相邻代码。

## 已确认红灯

1. 画布保留 LibTV 式导航、框选和拖拽历史入口。
2. 节点拖拽停止后立即刷新布局缓存并同步视口。
3. 右键空白画布提供 LibTV 式添加节点入口并使用点击位置。
4. 右键节点支持追加下游分镜并自动创建手动连线。
5. 右键节点支持在现有下游连线中插入分镜并重连。
6. 右键分镜节点支持克隆到旁边。
7. 画布保存使用串行队列并在执行时构造最新布局。
8. 四类节点编辑器暴露 LibTV 核心参数且不隐藏在假配置按钮后。
9. 选中节点可从主体按住左键拖动且编辑器尺寸收紧。
10. 图片视频节点使用大画幅预览，运行中明确显示生成状态且画布支持高倍缩放。

## 成功标准

- 三个目标测试文件全部通过，0 个失败。
- `frontweb` 全量 Node 测试全部通过，0 个失败。
- `npm run build` 通过。
- GitHub Actions 对应的 `npm run test:e2e:canvas` 通过。
- 修改范围经过 diff 审计，无支付宝、计费、生产部署或其他无关代码变化。
- 修复提交独立推送并创建 Pull Request；不直接合并、部署或执行真实支付。

## 证据记录

- 基线提交：`d7424872`（`origin/main`）。
- 充值分支发现时的全量基线：623 项，613 通过、10 失败；其中多出的 40 项为充值测试。
- 独立主线 worktree 的目标红灯：三个目标文件共 54 项，44 通过、10 失败。

## 根因结论

- 10 个失败不是 10 个运行时能力缺失，而是三份源码字符串契约测试仍断言旧实现形态。
- 当前主线已明确采用偏好驱动滚轮行为、连接来源透传、本地预览清洗、虚拟化刷新、`视频运镜` 文案和固定面板等比适配；回退源码会破坏后续能力。
- 最小修复复用提交 `7c013ff8`，在本分支形成 `0bc376d7`，仅调整三份目标测试的断言，不修改 `frontweb/src` 或 E2E。
- 默认 Playwright 端口 `3013` 被旧 worktree 服务占用且允许复用，曾产生视频参考模式的假失败；有效验收必须使用独立端口并设置 `PLAYWRIGHT_REUSE_SERVER=0`。

## 验证结果

- 红灯：三个目标文件共 54 项，44 通过、10 失败。
- 绿灯：三个目标文件共 54 项，54 通过、0 失败。
- 前端全量 Node 测试：583 项，583 通过、0 失败。
- 生产构建：通过；仅保留既有大 chunk 警告。
- 官方 Canvas E2E：独立端口、本地平台模式、单 worker，49 通过、1 项真实 AIHubCC 外部调用按设计跳过、0 失败。

有效 E2E 命令：

```powershell
$env:PLAYWRIGHT_BASE_URL = 'http://127.0.0.1:61614'
$env:PLAYWRIGHT_REUSE_SERVER = '0'
$env:VITE_PUBLIC_PLATFORM_MODE = '0'
npm run test:e2e:canvas -- --workers=1
```
