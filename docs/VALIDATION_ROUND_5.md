# 导演台验证轮次 5：服务端视频导出

日期：2026-07-14

## 本轮目标

把浏览器端导演台录制的 WebM 交给服务端转成可下载的 MP4，并保留镜头序列、角色轨道、动作片段的导出元数据。

## 已实现

- `POST /api/v1/dramas/:id/director/export`：上传 WebM/MP4，创建 `director_export` 异步任务。
- `GET /api/v1/tasks/:task_id`：复用现有任务状态接口，返回 pending/processing/completed/failed。
- FFmpeg 使用 `libx264 + yuv420p + faststart` 输出 MP4；服务端无 FFmpeg 时明确返回 503。
- 输出写入当前工程的 `projects/.../videos/director/`，完成后登记为 `video/director` 资产。
- 时间线 JSON 写入旁车文件，并在任务结果中返回 `timeline_summary`（镜头数、角色轨道数、动作片段数、帧率、时长）。
- 导演台增加“服务端导出 MP4”按钮，自动轮询任务并触发下载。

## 验证证据

- `backend-node`: `node --test test/*.test.js`：139 passed。
- `backend-node/test/directorExport.test.js`：使用本机 FFmpeg 生成短 WebM，实际转码为 MP4，并验证任务、文件和视频资产入库。
- `frontweb`: `node --test test/*.test.js`：30 passed。
- `frontweb`: `npm run build`：通过；仅保留既有大 chunk warning。
- 浏览器 `http://localhost:3013/film/3/canvas`：打开 3D 导演台后可见“服务端导出 MP4”。
- `git diff --check`、新增后端文件语法检查：通过。

## 本轮新增：真实 GLB 与动作片段隔离验收

- 创建临时隔离项目 `dramaId=4`（标题“导演台真实素材验收-临时”），未写入正式项目 `dramaId=3`；验证结束后删除该临时项目。
- 角色模型使用 three.js 官方示例 `RobotExpressive.glb`，同一 GLB 作为外部 `Walking`、`Running` 动作资源，仅用于技术链路验证，不作为商用素材授权证明。
- 浏览器打开 3D 导演台后，实际恢复 2 个镜头、3 个动作片段、6 秒序列、24 FPS，并显示角色模型 URL 与“动作资源已加载”状态；页面存在导演台预览 canvas，未出现错误或警告日志。
- 播放验证：时间线滑块从 `1.2s` 推进至 `2.2609s`（约 750ms），同时播放按钮切换为“暂停”；随后成功停止播放，证明时间线驱动循环实际运行。
- 刷新恢复验证：刷新后镜头、动作片段、模型 URL 和动作资源加载状态仍存在，说明 `director_timeline` 已从画布布局持久化恢复。
- 资产边界：上述远程示例 URL 只证明加载/播放/恢复链路；生产环境必须替换为已完成版权或商业授权审计的用户素材，并通过资产库上传后复用。

## 边界与下一步

- 当前服务端负责转码和元数据持久化，3D 场景仍由浏览器导演台渲染；尚未声称服务端具备无头 Three.js 渲染能力。
- 当前轮未把第三方示例 GLB/VRM 写入用户工程；下一轮用用户提供或已完成授权审计的素材做资产库上传、复用和导出验收。
- 任务执行仍是进程内 FFmpeg；重启会按既有任务策略标记中断，后续再接持久队列/worker 和清理策略。
