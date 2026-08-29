# 一键转绘参考素材导入实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 补齐一键转绘真实产品入口，使角色身份图和已复核无声动作参考只能通过 owner-scoped multipart 路由进入受控存储、幂等登记、服务端绑定和九镜本地验收链路。

**架构：** 新增导入幂等表和 `redrawReferenceArtifactImportService`；导入接口只做媒体验证、内容寻址存储、资产登记和 pending 记录，不写 `reference_ready`。最终 `redraw_motion_reference-v1` 由服务端在当前身份、净景、coverage 齐全后生成，并复用 `redrawReferenceBundleService` 的同一套 face/text binding 规则。

**技术栈：** Node.js 20、Express、multer、better-sqlite3、sharp、ffprobe、Playwright、现有 redraw 服务与 SQLite 迁移体系。

---

## 文件结构

- 创建：`backend-node/migrations/66_redraw_reference_artifact_imports.sql`：导入幂等表、唯一键和索引。
- 创建：`backend-node/src/services/redrawReferenceArtifactImportService.js`：身份图导入、motion pending 导入、motion final binding。
- 修改：`backend-node/src/services/redrawReferenceBundleService.js`：提取并导出当前 face/text binding helper。
- 修改：`backend-node/src/services/redrawReferencePreparationOrchestrator.js`：两轮 A 模式中接入 motion final binding。
- 修改：`backend-node/src/services/redrawDependencyInvalidationService.js` 与 `backend-node/src/services/redrawPreparationGateService.js`：上游变化后旧 motion binding fail closed。
- 修改：`backend-node/src/routes/redraw.js`：新增两个认证后的 multipart 路由。
- 修改：`backend-node/src/routes/index.js`：在全局用户/租户中间件之后挂载两个 multipart 路由。
- 创建：`backend-node/test/redrawReferenceArtifactImport.test.js`：导入服务、路由、幂等、安全、零计费和状态机测试。
- 修改：`backend-node/test/redrawReferenceBundle.test.js`、`backend-node/test/redrawReferencePreparationOrchestration.test.js`、`backend-node/test/redrawRoutes.test.js`、`backend-node/test/redrawPreparationGate.test.js`：覆盖 helper、orchestrator、route 和 gate。
- 修改：`backend-node/test/featureLockManifest.test.js`、`backend-node/test/incrementalReleaseScope.test.js`：将迁移和新产品文件纳入发布范围锁。
- 修改：`frontweb/e2e/support/redraw-live-product-harness.mjs`、`frontweb/scripts/run-redraw-live-product.mjs`、`frontweb/e2e/redraw-live-launcher.spec.js`、`frontweb/e2e/redraw-full-product-live.spec.js`：真实 auth、真实素材、全局网络 guard 和九镜同链验收。
- 创建：`docs/superpowers/reports/2026-08-27-redraw-reference-artifact-import-local-evidence.md`：本地证据报告。

## 任务 1：数据库幂等与服务边界

**文件：**
- 创建：`backend-node/migrations/66_redraw_reference_artifact_imports.sql`
- 创建：`backend-node/src/services/redrawReferenceArtifactImportService.js`
- 创建：`backend-node/test/redrawReferenceArtifactImport.test.js`

- [ ] **步骤 1：写红灯测试**

在 `backend-node/test/redrawReferenceArtifactImport.test.js` 增加两个测试：

```js
test('reference artifact import migration creates scoped idempotency table', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  const columns = db.prepare("PRAGMA table_info(redraw_reference_artifact_imports)").all().map((row) => row.name);
  assert.deepEqual(columns, ['id', 'tenant_id', 'user_id', 'version_id', 'scope_type', 'scope_id', 'purpose', 'idempotency_hash', 'request_hash', 'file_sha256', 'stored_asset_id', 'status', 'error_code', 'created_at', 'updated_at']);
});

test('reference artifact import service exposes narrow public API', () => {
  const service = require('../src/services/redrawReferenceArtifactImportService');
  assert.deepEqual(Object.keys(service).sort(), ['bindReadyMotionReference', 'importCharacterReferenceArtifact', 'importMotionReferenceArtifact'].sort());
});
```

- [ ] **步骤 2：运行红灯**

运行：`cd backend-node && node --test --test-concurrency=1 test/redrawReferenceArtifactImport.test.js --test-name-pattern="migration creates|narrow public API"`

预期：FAIL，表或服务文件不存在。

- [ ] **步骤 3：最小实现**

创建迁移，字段固定为规格中的 15 列；唯一键固定为 `(tenant_id, user_id, version_id, scope_type, scope_id, purpose, idempotency_hash)`。创建服务文件并只导出 `importCharacterReferenceArtifact`、`importMotionReferenceArtifact`、`bindReadyMotionReference`，默认抛规格错误码。

- [ ] **步骤 4：运行绿灯**

运行：`cd backend-node && node --test --test-concurrency=1 test/redrawReferenceArtifactImport.test.js --test-name-pattern="migration creates|narrow public API"`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add backend-node/migrations/66_redraw_reference_artifact_imports.sql backend-node/src/services/redrawReferenceArtifactImportService.js backend-node/test/redrawReferenceArtifactImport.test.js
git commit -m "test: define redraw reference artifact import boundary"
```

## 任务 2：身份图与 wardrobe 导入

**文件：**
- 修改：`backend-node/src/services/redrawReferenceArtifactImportService.js`
- 修改：`backend-node/test/redrawReferenceArtifactImport.test.js`

- [ ] **步骤 1：写红灯测试**

覆盖：

- `identity import stores image asset and binds current character`
- `wardrobe import stores image asset without changing identity approval`
- `identity import replays same idempotency key and rejects changed replay`
- `identity import rejects stale expected_updated_at, cross-owner asset, forbidden fields and MIME mismatch`

关键断言：`reserved_credits=0`、`held_credits=0`、`charged_credits=0`，响应不含绝对路径，`identity` 会把当前角色置为 `status='generated'`、`approval_status='pending'`。

- [ ] **步骤 2：运行红灯**

运行：`cd backend-node && node --test --test-concurrency=1 test/redrawReferenceArtifactImport.test.js --test-name-pattern="identity import|wardrobe import"`

预期：FAIL，服务仍抛 `REDRAW_REFERENCE_ARTIFACT_INPUT_INVALID`。

- [ ] **步骤 3：实现身份导入**

实现 `importCharacterReferenceArtifact(ctx, input)`：

- ctx 必须包含 `db`、`tenantId`、`userId`、`versionId`、`storageRoot`。
- 输入只允许 `assetId`、`purpose`、`expectedUpdatedAt`、`idempotencyKey`、`file`。
- owner 查询必须匹配当前 `tenant_id/user_id/version_id/kind='character'/deleted_at IS NULL`。
- 图片用声明 MIME、扩展名、magic bytes 和 `sharp().metadata()` 同时验证，最大 20 MiB。
- 服务端计算 SHA-256，原子写入 `redraw-reference-artifacts/<sha256>.<ext>`，登记 `assets`。
- 幂等 replay 同 request/file 返回 200 语义结果；同 key 不同 request/file 返回 `REDRAW_REFERENCE_ARTIFACT_IDEMPOTENCY_CONFLICT`。

- [ ] **步骤 4：运行绿灯**

运行：`cd backend-node && node --test --test-concurrency=1 test/redrawReferenceArtifactImport.test.js --test-name-pattern="identity import|wardrobe import"`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add backend-node/src/services/redrawReferenceArtifactImportService.js backend-node/test/redrawReferenceArtifactImport.test.js
git commit -m "feat: import redraw character reference artifacts"
```

## 任务 3：motion pending 导入

**文件：**
- 修改：`backend-node/src/services/redrawReferenceArtifactImportService.js`
- 修改：`backend-node/test/redrawReferenceArtifactImport.test.js`

- [ ] **步骤 1：写红灯测试**

覆盖：

- `motion import stores reviewed silent candidate without making shot reference_ready`
- `motion import rejects audio stream, duration mismatch and missing review assertion`
- `motion import rejects cross-owner shot, stale expected_updated_at and idempotency conflict`

关键断言：motion 导入只写 `assets.metadata.redraw_motion_import`，不得写 `redraw_motion_reference`、`reference_bundle_hash` 或 `preparation_state='reference_ready'`。

- [ ] **步骤 2：运行红灯**

运行：`cd backend-node && node --test --test-concurrency=1 test/redrawReferenceArtifactImport.test.js --test-name-pattern="motion import"`

预期：FAIL，motion 路径未实现。

- [ ] **步骤 3：实现 motion pending**

实现 `importMotionReferenceArtifact(ctx, input)`：

- owner 查询必须匹配当前 shot、version、source work、source asset 和 source fingerprint。
- `expected_updated_at` 必须匹配 shot，但成功导入不更新 `redraw_shots.updated_at`。
- `full_frame_reviewed/source_identity_obscured/source_text_obscured/motion_preserved` 必须全为 `true`。
- ffprobe 验证 MP4/H.264、音频流数量 0、宽高正整数、时长与 shot 边界误差不超过 100 ms，最大 200 MiB。
- 服务端计算 SHA-256，原子写入 `redraw-conditioning/<sha256>.mp4`，登记 `assets.metadata.redraw_motion_import`。
- 错误响应不包含 ffprobe stderr、SQL、绝对路径、Authorization 或 provider 响应。

- [ ] **步骤 4：运行绿灯**

运行：`cd backend-node && node --test --test-concurrency=1 test/redrawReferenceArtifactImport.test.js --test-name-pattern="motion import"`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add backend-node/src/services/redrawReferenceArtifactImportService.js backend-node/test/redrawReferenceArtifactImport.test.js
git commit -m "feat: import reviewed redraw motion references"
```

## 任务 4：服务端 binding helper 与两轮 A 模式

**文件：**
- 修改：`backend-node/src/services/redrawReferenceBundleService.js`
- 修改：`backend-node/src/services/redrawReferenceArtifactImportService.js`
- 修改：`backend-node/src/services/redrawReferencePreparationOrchestrator.js`
- 修改：`backend-node/test/redrawReferenceBundle.test.js`
- 修改：`backend-node/test/redrawReferencePreparationOrchestration.test.js`
- 修改：`backend-node/test/redrawReferenceArtifactImport.test.js`

- [ ] **步骤 1：写红灯测试**

覆盖：

- `current coverage bindings are shared by bundle and motion reference binding`
- `motion binding is not ready until current identity, reviewed coverage and clean result exist`
- `reference preparation binds pending motion then writes reference_ready through bundle service`

- [ ] **步骤 2：运行红灯**

运行：`cd backend-node && node --test --test-concurrency=1 test/redrawReferenceBundle.test.js test/redrawReferenceArtifactImport.test.js test/redrawReferencePreparationOrchestration.test.js --test-name-pattern="current coverage bindings|motion binding|reference preparation binds"`

预期：FAIL，helper 未导出或 orchestrator 未接入。

- [ ] **步骤 3：实现 helper 和 orchestrator 接入**

在 `redrawReferenceBundleService.js` 导出 `buildCurrentReferenceBindings(ctx, { shot_id, clean_results })`，返回当前 source、clip、face/text bindings、coverage review 和 canonical coverage hashes；`buildTrustedReferenceBundleInput` 和 `bindReadyMotionReference` 必须复用该 helper。`redrawReferencePreparationOrchestrator` 在 bundle input 前将本轮已完成或复用的 `clean_results` 传入 motion binder，尝试把 pending motion import 升级为 `redraw_motion_reference-v1`；binding 未就绪时保留 `needs_attention`，不得改为 `failed` 或 ready。

- [ ] **步骤 4：运行绿灯**

运行：`cd backend-node && node --test --test-concurrency=1 test/redrawReferenceBundle.test.js test/redrawReferenceArtifactImport.test.js test/redrawReferencePreparationOrchestration.test.js --test-name-pattern="current coverage bindings|motion binding|reference preparation binds"`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add backend-node/src/services/redrawReferenceBundleService.js backend-node/src/services/redrawReferenceArtifactImportService.js backend-node/src/services/redrawReferencePreparationOrchestrator.js backend-node/test/redrawReferenceBundle.test.js backend-node/test/redrawReferenceArtifactImport.test.js backend-node/test/redrawReferencePreparationOrchestration.test.js
git commit -m "feat: bind reviewed motion references during preparation"
```

## 任务 5：依赖失效、gate 和 HTTP routes

**文件：**
- 修改：`backend-node/src/services/redrawDependencyInvalidationService.js`
- 修改：`backend-node/src/services/redrawPreparationGateService.js`
- 修改：`backend-node/src/routes/redraw.js`
- 修改：`backend-node/src/routes/index.js`
- 修改：`backend-node/test/redrawPreparationGate.test.js`
- 修改：`backend-node/test/redrawRoutes.test.js`

- [ ] **步骤 1：写红灯测试**

覆盖：

- `generation gate rejects motion binding after identity coverage source or shot boundary changes`
- `reference artifact route requires auth before multipart parsing side effects`
- `character reference artifact route maps service result`
- `motion reference route maps service result`
- `reference artifact routes redact absolute paths and authorization`

- [ ] **步骤 2：运行红灯**

运行：`cd backend-node && node --test --test-concurrency=1 test/redrawPreparationGate.test.js test/redrawRoutes.test.js --test-name-pattern="motion binding|reference artifact route|motion reference route"`

预期：FAIL，route 不存在或 gate 未拒绝 stale binding。

- [ ] **步骤 3：实现 gate 和 routes**

实现：

- 身份、wardrobe、coverage、clean result、source fingerprint、shot boundary 或文件 SHA 变化后，旧 motion binding 不能被 current path 选中。
- 新增 `POST /api/v1/redraw/assets/:id/reference-artifact` 和 `POST /api/v1/redraw/shots/:id/motion-reference`。
- `routes/index.js` 必须在现有 `r.use(requireUser)` 和租户上下文之后挂载；multer 只能作为这两个 route 的第二层中间件，确保认证/租户失败时不创建临时文件。
- 只允许规格字段和 `file`；读取 `Idempotency-Key`；错误响应脱敏。

- [ ] **步骤 4：运行绿灯**

运行：`cd backend-node && node --test --test-concurrency=1 test/redrawPreparationGate.test.js test/redrawRoutes.test.js --test-name-pattern="motion binding|reference artifact route|motion reference route"`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add backend-node/src/services/redrawDependencyInvalidationService.js backend-node/src/services/redrawPreparationGateService.js backend-node/src/routes/redraw.js backend-node/src/routes/index.js backend-node/test/redrawPreparationGate.test.js backend-node/test/redrawRoutes.test.js
git commit -m "feat: add redraw reference import routes and stale gates"
```

## 任务 6：launcher 真 auth、真素材、全局网络 guard

**文件：**
- 修改：`frontweb/e2e/support/redraw-live-product-harness.mjs`
- 修改：`frontweb/scripts/run-redraw-live-product.mjs`
- 修改：`frontweb/e2e/redraw-live-launcher.spec.js`
- 修改：`frontweb/e2e/redraw-full-product-live.spec.js`

- [ ] **步骤 1：写红灯测试**

覆盖：

- `launcher uses real auth token and product routes for source identity and motion imports`
- `launcher fails when any required source identity or motion file is missing`
- `launcher global guard blocks non-loopback fetch generation submit and dangerous ai-config before handlers`
- `launcher redacted summary excludes token absolute paths and provider keys`

- [ ] **步骤 2：运行红灯**

运行：`cd frontweb && npx playwright test e2e/redraw-live-launcher.spec.js --workers=1`

预期：FAIL，现有 harness 仍含 `req.user =`、测试源片字节或直接写 `reference_ready`。

- [ ] **步骤 3：修正 launcher**

实现：

- `run-redraw-live-product.mjs` 读取并哈希真实源片、5 张身份图和 9 段动作参考，缺一项立即非零退出。
- 短期测试 JWT 只通过当前进程为子 Playwright 设置 `REDRAW_LIVE_PRODUCT_AUTH_TOKEN`；不写磁盘、stdout、报告或模板。
- harness 删除 `req.user`/`req.tenant` 注入，源片、身份图、motion 全部走真实 HTTP route。
- 删除直接更新 `redraw_shots.preparation_state='reference_ready'` 的测试捷径。
- 全局 guard 对非 loopback 请求、generation submit 和危险 ai-config 测试路由在 handler 前阻断并计数。

- [ ] **步骤 4：运行绿灯**

运行：`cd frontweb && npx playwright test e2e/redraw-live-launcher.spec.js --workers=1`

预期：PASS，输出不含 token、Authorization、Bearer、供应商 key 或本机绝对路径。

- [ ] **步骤 5：Commit**

```bash
git add frontweb/e2e/support/redraw-live-product-harness.mjs frontweb/scripts/run-redraw-live-product.mjs frontweb/e2e/redraw-live-launcher.spec.js frontweb/e2e/redraw-full-product-live.spec.js
git commit -m "test: route redraw live launcher through product imports"
```

## 任务 7：定向回归、完整回归与证据报告

**文件：**
- 创建：`docs/superpowers/reports/2026-08-27-redraw-reference-artifact-import-local-evidence.md`
- 修改：前述所有实现和测试文件

- [ ] **步骤 1：后端专项回归**

运行：

```bash
cd backend-node
node --test --test-concurrency=1 test/redrawReferenceArtifactImport.test.js
node --test --test-concurrency=1 test/redrawReferenceBundle.test.js test/redrawReferencePreparationOrchestration.test.js test/redrawPreparationGate.test.js test/redrawRoutes.test.js
node --test --test-concurrency=1 test/featureLockManifest.test.js test/incrementalReleaseScope.test.js
```

预期：PASS。

- [ ] **步骤 2：前端 launcher 和九镜同链**

运行：

```bash
cd frontweb
npx playwright test e2e/redraw-live-launcher.spec.js --workers=1
node scripts/run-redraw-live-product.mjs
```

预期：PASS；`run-redraw-live-product.mjs` 报告中 `reference_ready=9`、`generation_submits=0`、`external_fetches=0`、`reserved_credits=0`、`held_credits=0`、`charged_credits=0`。

- [ ] **步骤 3：完整回归**

运行：

```bash
cd backend-node
npm test
cd ../frontweb
npm run build
```

预期：PASS。

- [ ] **步骤 4：静态审查**

运行：

```bash
rg -n "req\\.user\\s*=|req\\.tenant\\s*=|preparation_state\\s*=\\s*'reference_ready'|Authorization|Bearer|FUMIN|[A-Za-z]:\\\\" frontweb/e2e/support/redraw-live-product-harness.mjs frontweb/scripts/run-redraw-live-product.mjs docs/superpowers/reports/2026-08-27-redraw-reference-artifact-import-local-evidence.md
```

预期：无 auth 注入、无直接业务状态写入、无 token、无 key、无本机绝对路径；业务字段名出现在断言或脱敏报告中可以保留。

- [ ] **步骤 5：写证据报告并 Commit**

报告必须记录：当前 HEAD、变更文件、四组测试命令、九镜摘要、零计费摘要、静态审查结果、未执行的生产/供应商/付费动作。

```bash
git add docs/superpowers/reports/2026-08-27-redraw-reference-artifact-import-local-evidence.md backend-node frontweb
git commit -m "feat: add redraw reference artifact import product chain"
```

## 验收标准

- 导入接口均为 owner-scoped、认证后 multipart、服务端媒体验证、内容寻址存储、幂等、零计费、零供应商调用、零外部上传。
- 身份图导入只更新当前角色资产；身份批准仍走现有 review。
- motion 导入只形成 pending import；不能直接产生 `redraw_motion_reference`、`reference_bundle_hash` 或 `reference_ready`。
- 服务端在当前身份、reviewed coverage 和净景齐全后生成 `redraw_motion_reference-v1`，并与 reference bundle 复用同一 binding helper。
- 任一上游身份、coverage、净景、source fingerprint、shot boundary 或文件 SHA 变化后旧 motion binding fail closed。
- launcher 使用真实 auth、真实源片、真实身份图、真实 motion 文件、真实 HTTP route、真实 SQLite 和真实 storage 文件。
- 本地九镜同链通过且无业务状态直写、无外部请求、无供应商调用、无积分预留/冻结/扣费。
- Hosted CI 当前 HEAD 通过后，才可进入 PR 合并评估；本计划不授权合并、不部署、不付费、不写生产数据库。

## 风险与停机规则

- ffprobe 或 sharp 缺依赖时停止，记录缺失路径；不得降级为只看扩展名或 MIME。
- launcher 无法取得真实测试 JWT 时停止；不得恢复中间件注入用户。
- 九镜真实素材缺失时 launcher 必须非零退出；不得用合成字节代替。
- 导入接口出现结果未知的文件写入或 DB 事务错误时记录 failed/error_code 并清理本次新建未引用文件；不得自动重试。
- 任何测试若需要 Fumin Key、真实供应商、外部上传或扣费，说明测试设计偏离本计划并停止。

## 执行交接

计划已保存到 `docs/superpowers/plans/2026-08-27-redraw-reference-artifact-import.md`。建议按任务 1-7 顺序执行，每个任务先红灯、再实现、再绿灯、再 commit。本计划的下一步不是生产操作；执行者不得合并、部署、读取供应商 Key、付费或写生产数据库。
