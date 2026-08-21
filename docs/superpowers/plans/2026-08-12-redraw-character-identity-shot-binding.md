# 转绘角色真人身份包与逐镜绑定实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在本地转绘工作台中建立服务端可信的角色真人身份包、逐镜演员绑定和 fail-closed 生成门禁。

**架构：** 复用 `redraw_assets.source_ref_json` 保存身份包，复用 `redraw_shots.references_json` 保存绑定摘要，不增加数据库表。后端从本地可读图片计算证据，前端只提交人工确认项；生成门禁和请求快照只信服务端生成的身份包哈希。

**技术栈：** Node.js CommonJS、better-sqlite3、Express、Vue 3、Element Plus、Node test runner、Playwright。

---

## 文件结构

- 创建 `backend-node/src/services/redrawCharacterIdentityService.js`：身份包校验、图片证据计算、CAS 保存和绑定摘要。
- 创建 `backend-node/test/redrawCharacterIdentity.test.js`：身份包服务的 TDD 合同。
- 修改 `backend-node/src/services/redrawAssetService.js`：向资产 API 投影身份包。
- 修改 `backend-node/src/services/redrawReviewService.js`：审批与生成门禁消费身份包和镜头绑定。
- 修改 `backend-node/src/services/redrawShotService.js`：镜头引用固化身份包摘要。
- 修改 `backend-node/src/services/redrawGenerationService.js`：请求快照记录身份绑定。
- 修改 `backend-node/src/routes/redraw.js`、`backend-node/src/routes/index.js`、`backend-node/test/redrawRoutes.test.js`：增加 owner-scoped 身份包保存入口。
- 创建 `frontweb/src/utils/redrawCharacterIdentity.js`、`frontweb/test/redrawCharacterIdentity.test.js`：前端状态和安全 payload。
- 修改 `frontweb/src/api/redraw.js`、`frontweb/src/components/redraw/RedrawAssetCard.vue`、`RedrawAssetStep.vue`、`RedrawShotEditor.vue`：身份包确认与逐镜映射 UI。
- 修改 `frontweb/e2e/redraw-workspace.spec.js`：浏览器验证真人预览、身份包阻塞和映射展示。
- 创建 `docs/tasks/2026-08-12-redraw-character-identity-shot-binding.md`：记录本地执行证据和边界。

### 任务 1：身份包服务与资产投影

- [ ] 在 `backend-node/test/redrawCharacterIdentity.test.js` 先写失败测试：完整确认生成 `ready=true` 和稳定 `pack_sha256`；缺正面/侧面/全身、真人确认、18+ 确认或一致性确认时 `ready=false`；客户端哈希和角色键被忽略；跨租户、CAS 冲突、非图片、不可读或越界路径失败。
- [ ] 运行 `node --test --test-concurrency=1 test/redrawCharacterIdentity.test.js`，确认因模块不存在失败。
- [ ] 在 `redrawCharacterIdentityService.js` 实现 `readIdentityPack`、`identityPackStatus`、`saveIdentityPack`、`identityBindingForAsset`，只接受 `front/profile/full_body` 视图，使用规范 JSON 计算 SHA-256。
- [ ] 修改 `redrawAssetService.rowToAsset` 投影 `identity_pack`、`identity_pack_status`，不暴露绝对路径。
- [ ] 重跑任务测试并提交 `feat: 增加转绘角色真人身份包合同`。

### 任务 2：审批、逐镜绑定和生成门禁

- [ ] 先扩展 `redrawReviewGate.test.js`、`redrawShots.test.js` 和 `redrawGeneration.test.js`：不完整身份包不能批准；角色镜头缺包、缺绑定或哈希漂移时门禁关闭；当前绑定时开放；请求快照包含绑定摘要。
- [ ] 运行三组测试并确认新增断言因行为缺失失败。
- [ ] 修改 `redrawReviewService` 在角色批准和门禁中调用身份包服务；修改 `redrawShotService.normalizeAsset` 固化服务端绑定；修改更新镜头路由给 approvedAssets 注入当前身份包；修改生成请求快照写入 `identity_bindings`。
- [ ] 重跑三组测试，确认所有相邻资产、场景、道具和旧非角色合同不回归。
- [ ] 提交 `feat: 增加逐镜演员身份绑定门禁`。

### 任务 3：owner-scoped 身份包 API

- [ ] 在 `redrawRoutes.test.js` 先写失败测试：`PUT /redraw/assets/:id/identity-pack` 只接受目标演员、视图和人工确认字段；服务端计算证据；跨 owner 返回 404；CAS 冲突返回 409；客户端控制字段返回 400。
- [ ] 运行 `node --test --test-concurrency=1 test/redrawRoutes.test.js`，确认新 handler/路由缺失导致失败。
- [ ] 在 `routes/redraw.js` 实现 handler，在 `routes/index.js` 注册路由；对输入使用字段白名单并把 owner、storageRoot 和 reviewer 注入服务。
- [ ] 重跑路由测试并提交 `feat: 接通转绘角色身份包接口`。

### 任务 4：前端身份包确认与映射展示

- [ ] 在 `frontweb/test/redrawCharacterIdentity.test.js` 先写失败测试：状态文案、必需视图、保存 payload、批准禁用、映射标签和哈希短码。
- [ ] 运行 `node --test test/redrawCharacterIdentity.test.js`，确认模块不存在失败。
- [ ] 实现 `redrawCharacterIdentity.js`，并在 API 增加 `saveCharacterIdentityPack`。
- [ ] 修改角色卡片：删除无证据的固定“三视图”文案，增加目标演员、三项视图和三项人工确认，保存后刷新；不完整时禁用批准。
- [ ] 修改资产步骤接线；修改分镜编辑器显示“原片角色 → 目标演员”和身份包哈希短码。
- [ ] 重跑前端目标测试并提交 `feat: 展示角色身份包与逐镜映射`。

### 任务 5：本地浏览器验证和回归

- [ ] 先扩展 `redraw-workspace.spec.js`，让现有真人概念图保持 `ready=false`，断言角色卡显示具体缺项且生成门禁关闭；再提供测试专用完整身份包响应，断言逐镜标签展示角色映射和哈希。
- [ ] 运行该 Playwright 用例并确认新增断言先失败。
- [ ] 完成最少 UI 调整让浏览器用例通过；不生成新视频、不调用真实供应商。
- [ ] 运行后端身份/审核/镜头/生成/路由目标测试、前端相关测试、前端全量测试、`npm run build`、Playwright 目标用例、`git diff --check`。
- [ ] 把命令、计数、浏览器证据和“现有概念图仍不是生产身份包”的边界写入 `docs/tasks/2026-08-12-redraw-character-identity-shot-binding.md`。
- [ ] 提交 `test: 验证转绘角色身份绑定本地闭环`，不推送、不部署。

## 执行边界

- 只修改当前 linked worktree `redraw-r12-merge-20260809`。
- 保留任务前未跟踪的 `.superpowers/`、`frontweb/output/` 和 Python `__pycache__`。
- 不读取供应商 Key，不启动公网隧道，不进行付费 POST，不写生产数据库，不 SSH，不制作生产候选，不 activate，不推送。

