# ToAPIs 虚拟人像接入实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 平台 AI 生成人物图在 ToAPIs Fast/Mini 视频提交前自动转换为可信的虚拟人像 `asset://` 素材。

**架构：** 新增独立 ToAPIs 虚拟人像客户端和 SQLite 缓存表；`videoService` 只记录经过项目所有权验证的 AI 图片来源，`videoClient` 在最终供应商提交前解析或创建虚拟人像素材并替换 URL。任意用户输入的 `asset://` 继续被拒绝。

**技术栈：** Node.js、Express 服务层、better-sqlite3、Node test runner、Vue 3 回归构建。

---

### 任务 1：虚拟人像官方 API 客户端和缓存

**文件：**
- 创建：`backend-node/src/services/toapisPrivateAvatarService.js`
- 创建：`backend-node/migrations/54_toapis_private_avatar_assets.sql`
- 创建：`backend-node/test/toapisPrivateAvatarService.test.js`

- [ ] **步骤 1：编写失败测试**

覆盖建组、创建图片素材、查询 `processing/active/failed`、缓存复用、非法响应和脱敏错误。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test --test-concurrency=1 test/toapisPrivateAvatarService.test.js`

预期：FAIL，模块尚不存在。

- [ ] **步骤 3：编写最少实现**

实现固定官方路径、Bearer 鉴权、响应解析、缓存读写和有限状态轮询；不打印 Key 或原始素材 URL。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test --test-concurrency=1 test/toapisPrivateAvatarService.test.js`

预期：全部 PASS。

### 任务 2：可信 `asset://` 请求合同

**文件：**
- 修改：`backend-node/src/services/toapisVideoClient.js`
- 修改：`backend-node/test/toapisVideoClient.test.js`

- [ ] **步骤 1：编写失败测试**

证明任意 `asset://` 仍被拒绝；只有出现在服务端 `trusted_asset_urls` 中的严格 `asset://pa_...` 才能用于首帧、尾帧和参考图。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test --test-concurrency=1 test/toapisVideoClient.test.js`

预期：可信素材用例因现有 HTTPS 限制而 FAIL。

- [ ] **步骤 3：编写最少实现**

在 URL 验证器中增加显式可信集合；不改变公网 HTTPS、私网和凭据 URL 的现有检查。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test --test-concurrency=1 test/toapisVideoClient.test.js`

预期：全部 PASS。

### 任务 3：平台 AI 图片来源绑定和自动转换

**文件：**
- 修改：`backend-node/src/services/videoService.js`
- 修改：`backend-node/src/services/videoClient.js`
- 修改：`backend-node/test/videoGenerationRequestSnapshot.test.js`
- 修改：`backend-node/test/toapisVideoIntegration.test.js`

- [ ] **步骤 1：编写失败测试**

覆盖平台 AI 生成人物图自动转换、普通上传图片不转换、伪造内部绑定被忽略、缓存命中不重复建组、首尾帧角色顺序保持。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test --test-concurrency=1 test/videoGenerationRequestSnapshot.test.js test/toapisVideoIntegration.test.js`

预期：自动转换用例 FAIL。

- [ ] **步骤 3：编写最少实现**

由 `assertToapisReferencesAllowed()` 返回受信任来源描述，写入内部快照；最终提交时调用虚拟人像服务并只替换匹配 URL。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test --test-concurrency=1 test/videoGenerationRequestSnapshot.test.js test/toapisVideoIntegration.test.js`

预期：全部 PASS。

### 任务 4：回归、构建和真实验收门禁

**文件：**
- 修改：`docs/TOAPIS_VIDEO_MODELS_VERIFICATION_20260807.md`

- [ ] **步骤 1：运行后端相关回归**

运行：`node --test --test-concurrency=1 test/toapis*.test.js test/videoGenerationRequestSnapshot.test.js test/videoBilling.test.js test/videoRecovery.test.js`

- [ ] **步骤 2：运行完整后端测试**

运行：`npm test`

- [ ] **步骤 3：运行完整前端测试与构建**

运行：`node --test test/*.test.js`，随后运行 `npm run build`。

- [ ] **步骤 4：真实最低成本验证**

在得到明确费用确认后，使用同一张平台 AI 人物图分别提交 Fast 480P/4 秒和 Mini 480P/4 秒。必须记录虚拟素材 `active`、视频任务 ID、成品 SHA256/媒体信息、生成耗时与实际费用；任一失败不自动重试。

- [ ] **步骤 5：发布前检查**

确认工作树无其他会话冲突，从实时 `/opt/moli-drama/current` 克隆候选，保留 `canvas-credit-callout-v1`，通过共享审计器和受保护激活脚本后才允许切换。
