# 整集转绘隔离多视频模型回退实现计划

> 设计依据：`docs/superpowers/specs/2026-09-05-redraw-isolated-video-model-fallback-design.md`

**目标：** 在 PR #217 中实现四条本地隔离视频线路的首单元竞选与单一获胜模型整集生成，硬性保证缺 Key 零提交、明确失败才回退、未知全局停止和整轮最多 31 次生成提交。

**架构：** 保留通用整集运行器和 Fumin 媒体/语言验收链，新增固定路由注册表、多供应商适配器和父级调度器。每条路由使用独立子状态，父 manifest 原子记录尝试、获胜者、哈希和停止原因。

---

## 任务 1：用红灯测试锁定路由注册表

**文件：**

- 新增：`frontweb/scripts/episodeVideoRouteRegistry.test.mjs`
- 新增：`frontweb/scripts/episodeVideoRouteRegistry.mjs`

1. 先写测试，断言固定顺序和精确模型 ID，且每条都只允许 480p、9:16、5 秒。
2. 断言 Fumin/ToAPIs 三条要求显式输出音频，飞拓标记为需要产物证明音轨的实验线路。
3. 运行测试确认模块缺失红灯，再用最小不可变对象实现并转绿。

## 任务 2：参数化 Fumin 模型并保存失败类别

**文件：**

- 修改：`frontweb/scripts/fuminEpisodeProviderAdapter.mjs`
- 修改：`frontweb/scripts/fuminEpisodeProviderAdapter.test.mjs`
- 修改：`frontweb/scripts/run-redraw-episode-blueprint-live.mjs`
- 修改：`frontweb/scripts/run-redraw-episode-blueprint-live.test.mjs`

1. 先增加红灯测试：显式注入 Fumin Fast 时请求模型为 `seedance-2.0-fast`，不注入时仍为 Mini。
2. 补充未知语义：生成 POST 的超时/5xx/非 JSON 和任务查询异常必须标记未知；只有返回的失败终态标记为明确供应商失败。
3. 通用运行器在任务证据中增加脱敏 `failure_class` 和 `error_reason`，保留既有 `status/error_code` 兼容性。

## 任务 3：修正 ToAPIs 轮询终态元数据

**文件：**

- 修改：`backend-node/src/services/toapisVideoClient.js`
- 修改：`backend-node/test/toapisVideoClient.test.js`

1. 先写失败终态与查询失败的区分测试。
2. 让 200 响应中的真实失败终态返回 `terminalFailure=true`；查询网络、非 JSON 或非 2xx 返回 `queryFailed=true`。
3. 不修改 URL、模型、请求体和生产配置。

## 任务 4：实现四线路统一适配器

**文件：**

- 新增：`frontweb/scripts/episodeVideoProviderAdapter.mjs`
- 新增：`frontweb/scripts/episodeVideoProviderAdapter.test.mjs`

1. 先用伪 fetch 为 Fumin Fast、ToAPIs Fast、ToAPIs Wan3、飞拓 Seedance 2.5 分别写请求体、终态、未知和脱敏错误测试。
2. 复用 Fumin 的参考上传与媒体/双 ASR/裁剪/合成方法；生成和轮询只委托给对应的既有后端客户端。
3. 对每个生成 POST 在发送前调用父调度器提供的唯一计数钩子；钩子失败时保持 0 POST。

## 任务 5：实现父级隔离调度器

**文件：**

- 新增：`frontweb/scripts/run-redraw-video-model-fallback-live.mjs`
- 新增：`frontweb/scripts/run-redraw-video-model-fallback-live.test.mjs`

1. 先写调度器红灯测试：缺 Key 零提交跳过、明确失败切换、未知全局停止、产物验收失败全局停止、首个通过者独占后续单元。
2. 断言父 manifest 绑定精确 HEAD、包/计划哈希、路由子状态和全局尝试清单，且现有非空目录拒绝复用。
3. 在调度器中固定门禁单元 `shot-01.part-01`、四路顺序和全局 31 次硬上限。
4. 获胜后执行同一子运行器的 `sequence`、`assemble`、`verify`，成功时写入整集产物哈希。

## 任务 6：完成 28 单元零供应商端到端测试

**文件：**

- 修改：`frontweb/scripts/run-redraw-video-model-fallback-live.test.mjs`

1. 使用伪上传、伪生成、伪轮询和本地小媒体夹具，验证前三条明确失败、第四条生成 28 单元时总提交数精确为 31。
2. 验证获胜者是唯一出现在 28 个已验收任务中的路由，最终整集产物可读且哈希与父 manifest 相等。
3. 再覆盖首条直接通过时只有 28 次提交，中途失败不跨模型续跑。

## 任务 7：登记功能锁与发布范围

**文件：**

- 修改：`docs/verification/platform-stability/feature-lock-manifest.json`
- 修改：`backend-node/test/featureLockManifest.test.js`
- 修改：`deploy/release-scopes/redraw-episode-blueprint-first-redraw-20260903.json`
- 修改：`backend-node/test/incrementalReleaseScope.test.js`
- 新增：`docs/verification/redraw/isolated-video-model-fallback-verification.md`

1. 在 `redraw.episode-blueprint-first` 中新增本轮精确路径和 required tests，保留所有历史 unlock，记录本次产品主授权。
2. 以最小增量方式扩展发布范围，不带入无关文件。
3. 验证文档记录设计、本地测试、精确 HEAD 和后续 CI/真实验收占位状态，不写入伪造的通过结果。

## 任务 8：本地总回归、审计、提交与推送

1. 运行新增测试和 Fumin/整集受影响回归。
2. 运行对应后端供应商客户端测试、功能锁、增量范围校验和前端生产构建。
3. 运行 `git diff --check`，复核无 Key、无生产数据库路径、无线上模型配置改动。
4. 提交实现，推送到 PR #217 的远端分支；不合并。

## 任务 9：Hosted CI 和真实整集执行

1. 读取 PR #217 远端头，确认与本地新 HEAD 完全一致。
2. 等待该精确 HEAD 的 Hosted CI 4/4 全绿；失败则只诊断/修复/重新推送，不进入付费阶段。
3. 在全新本地隔离目录运行一次调度器；缺 Key 线路零提交跳过，不手工改写顺序或状态。
4. 任一未知、产物验收失败或后续单元失败都立即停止，不重试。
5. 完成时交付整集 MP4、SHA-256、路由/单元清单、音轨/英文对白/角色/时长证据和脱敏计费状态；不部署、不合并。

