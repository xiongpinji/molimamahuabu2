# 导演台验证轮次 6：正式资产绑定与交付闭环

日期：2026-07-14

## 本轮目标

在上一轮已有的模型加载、动作编排和服务端 MP4 导出基础上，把正式项目的 GLB/VRM 上传、项目资产库复用、导演时间线保存/恢复连接成同一条可验收链路。

本轮假设：生产素材由平台运营方提供并确认版权或商业授权；第三方示例模型只允许作为技术夹具，不作为商用素材证明。

## 已实现

- 导演时间线的角色资源保留 `modelAssetId`，动作资源保留 `assetId`；同时继续保存可加载的 URL 和动作片段名。
- `normalizeDirectorTimeline` 兼容旧字段 `model_asset_id` / `asset_id`，刷新或重新加载布局时不会丢失项目资产绑定。
- 角色模型和动作文件上传成功后，使用服务端 `/upload/model` 返回的 `asset_id` 写入时间线。
- 从项目三维资产库应用模型或动作时，同时写入资产 URL 与资产记录 ID，后续可追溯到 `assets` 表。
- 服务端上传处理仍限制为自包含 `.glb` / `.vrm`，并在指定剧集下落盘到工程目录、注册 `model/director` 资产。

## 验证证据

- `frontweb/test/directorTimeline.test.js`：新增模型资产 ID、动作资产 ID 的标准化恢复断言；单测通过。
- `backend-node/test/directorAssetUpload.test.js`：使用隔离 SQLite 和临时存储，实际执行上传处理，验证 GLB 文件落盘、返回 `asset_id`、资产归属剧集且类型为 `model/director`；通过。
- `frontweb`：`node --test test/*.test.js`，30 passed。
- `frontweb`：`npm run build`，通过；仅保留既有大 chunk warning。
- `backend-node`：`node --test test/*.test.js`，140 passed。
- `frontweb/src/utils/directorTimeline.js`、`frontweb/src/api/upload.js`：`node --check` 通过；Vue 单文件组件由生产构建完成语法转换验证。
- `git diff --check`：通过。本轮未 stage、commit 或清理工作树中的无关改动。

## 交付边界

- 这轮完成的是“上传/资产库引用/导演时间线保存恢复/已有服务端 MP4 导出”的绑定闭环，不声称服务端具备无头 Three.js 场景渲染能力。
- MP4 导出仍复用上一轮的浏览器 WebM → FFmpeg MP4 任务链路；本轮未改变任务队列、计费或权限策略。
- 资产 ID 是时间线中的可选字段，旧项目只有 URL 时仍可加载；生产使用时应优先从项目资产库选择或上传已授权素材。

## 后续可选项

- 在新鲜浏览器会话中用平台授权的真实 GLB/VRM 完成一次上传、应用、刷新和 MP4 下载录像，并保存操作证据。
- 将导演导出任务迁移到持久化 worker/队列，补充重启恢复、失败重试和过期文件清理策略。
