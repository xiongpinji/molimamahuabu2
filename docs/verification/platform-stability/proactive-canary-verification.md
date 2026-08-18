# 主动巡检与公开证据门禁验证记录

## 候选边界

- 本地基线引用：`origin/main`，未联网刷新；Task13 执行时解析为 `577b94816333e26bbbfe70d46f8e07ec124af0b1`。
- 候选 A：`1e999c828a8e2eed0377521032a9210185b244ac`；包含功能锁、精确发布范围、合同测试和验证前证据骨架。
- 证据提交 B：`9a97ea867de86dc85769557263bbd4fdbc8dd778`；只记录候选 A 的验证结果，没有修改候选 A 的代码、锁、测试或 release scope。
- 规格审查修复候选 C：`3a2b7557cbf105edd03e755f25919f8d2623173d`；只为新锁补齐 7 个核心 required tests，并同步固定列表合同测试。
- 证据提交 D：本文件更新后的下一提交；只记录候选 C 的审查修复验证结果。
- Task14 必须从实时 `/opt/moli-drama/current` 重建最终候选并重跑全部门禁；本地引用不代表实时线上版本。

## 自动化验证

除特别说明外，以下时间均为 UTC，验证对象均为候选 A。

| 开始时间 | 结束时间 | 命令 | 退出码 | 结果 |
| --- | --- | --- | ---: | --- |
| 2026-08-18T21:50:48.7915546Z | 2026-08-18T21:53:46.7458301Z | `cd backend-node; npm test` | 0 | 1188 个测试：1183 通过、0 失败、5 跳过 |
| 2026-08-18T21:53:55.6084943Z | 2026-08-18T21:53:56.6377051Z | `cd backend-node; npm run audit:feature-lock -- --base origin/main` | 0 | `ready=true`；5 个功能锁；66 个变更路径；基线为本地 `origin/main` |
| 2026-08-18T21:54:04.8914794Z | 2026-08-18T21:54:05.2191649Z | `cd backend-node; node --test test/incrementalReleaseScope.test.js` | 0 | 5/5 通过；覆盖白名单、越界、current 漂移、路径穿越、哈希不匹配 |
| 2026-08-18T21:54:13.3711011Z | 2026-08-18T21:54:14.2594827Z | `cd backend-node; npm run preflight:production` | 1 | 首次真实失败：默认开发配置指向的 `./data/drama_generator.db` 不存在，`SQLITE_CANTOPEN`；没有把该次运行标绿 |
| 2026-08-18T21:55:58.4760887Z | 2026-08-18T21:55:59.3544934Z | 隔离临时 SQLite fixture 和生产形态假环境下 `cd backend-node; npm run preflight:production` | 0 | 12/12 预检项通过；只证明预检器与候选结构可运行，不代表生产数据库或生产配置通过；临时 fixture 已删除 |
| 2026-08-18T21:57:08.0259975Z | 2026-08-18T21:57:27.1289590Z | `cd frontweb; node --test test/*.test.js` | 0 | 674/674 通过 |
| 2026-08-18T21:57:41.4560472Z | 2026-08-18T21:58:02.1705673Z | `cd frontweb; npm run build` | 0 | 生产构建完成；保留 Rollup 大 chunk 警告，不视为失败 |
| 2026-08-18T21:58:11.9174761Z | 2026-08-18T21:58:26.7459378Z | `cd frontweb; npx playwright test e2e/provider-stability-admin.spec.js e2e/platform-zero-cost-smoke.spec.js` | 0 | 7/7 通过；本地 mock/fixture 浏览器证据，生成写请求为 0 |
| 2026-08-18T21:58:41.0495071Z | 2026-08-18T21:58:41.2120482Z | `git diff --check origin/main...HEAD` | 0 | 无格式错误 |
| 2026-08-18T21:58:51.0420623Z | 2026-08-18T21:58:51.1864258Z | `git diff --name-only origin/main...HEAD` 并与新 scope 逐项比较 | 0 | 变更 66、allowlist 66、差异 0；未包含运行数据库、用户资产、AI 音乐、旧 scope 或共享门禁 |
| 2026-08-18T21:59:01.6546555Z | 2026-08-18T21:59:01.7743023Z | `rg -n "sk-[A-Za-z0-9]{12,}\|Authorization:\\s*Bearer\|provider_asset_signature=.*[^\\s]" docs backend-node frontweb deploy` | 0 | 20 个命中逐项复核，均为测试假值、API 契约占位符或扫描规则自身；没有真实 Key、Bearer token 或签名 URL |
| 2026-08-18T21:59:15.4032506Z | 2026-08-18T21:59:16.2872053Z | 对 `origin/main...HEAD` 新增行执行同一敏感信息规则 | 0 | 仅 1 个命中：本计划文档记录的扫描命令自身 |
| 2026-08-18T21:59:31.3257068Z | 2026-08-18T21:59:37.2869568Z | `cd backend-node; node --test` 定向运行 budget/executor/evidence/public-gate/public-view/fixtures/artifacts 七个测试文件 | 0 | 123/123 通过；集中覆盖预算、未知状态、证据过期、公开过滤、泄漏与隔离 fixture |

### 敏感信息命中豁免

- `frontweb/src/components/AIConfigContent.vue:549,608`：管理员说明中的 `{api_key}` 和省略号占位符。
- `backend-node/test/jimengMaterialHub.test.js:47` 与 `backend-node/test/redrawFullFrameDetectorProcess.test.js:875,994,1007,1034,1413,1901,1922`：显式测试假值，用于验证脱敏。
- `docs/configuration.md:92`、`docs/DEEPWL_GROK_VIDEO_STUDY_2026-07-17.md:9`、`docs/tasks/2026-08-05-feituo-video-model-integration.md:13`、`docs/superpowers/plans/2026-08-14-image-model-relay-repair.md:866`、`docs/superpowers/specs/2026-08-13-fumin-seedance-models.md:50,91`：`x`、`<API_KEY>`、`<key>` 或审计规则占位符。
- `docs/superpowers/plans/2026-08-18-platform-stability-proactive-canary-foundation.md:1123`：本次扫描规则自身，也是候选 A 新增行唯一命中。
- `backend-node/src/services/imageClient.js:1015`、`backend-node/src/services/videoClient.js:1610`、`backend-node/src/services/jimengMaterialHubService.js:129`：请求形状文档中的 `{api_key}` 或 `<token>` 占位符。

### 前端依赖与临时文件

- 当前工作树 `frontweb/package-lock.json` 与 `canvas-image-node-repair-20260814/frontweb/package-lock.json` 的 SHA-256 均为 `18BA50E97964D491CBD15CE54EB3FB65BE4470F04FA9F1D03845FB7B307CE82D`。
- 前端验证期间仅建立指向该同锁依赖树的临时 `node_modules` junction；没有联网安装，验证后已删除 junction。
- Playwright 本地产物目录和隔离预检 SQLite fixture 均在验证后删除；仓库工作树在填写本证据前保持干净。

## 规格审查修复候选 C

规格审查发现新锁 required tests 未显式列出 7 个既有核心回归。TDD 红灯先扩展 `featureLockManifest.test.js` 的固定列表：6 个测试中 5 个通过、1 个按预期失败，首个缺项为 `backend-node/test/openAIImageOutput.test.js`。随后只向新锁追加以下测试，未删除任何既有 required test、evidence 或 unlock：

- `backend-node/test/openAIImageOutput.test.js`
- `backend-node/test/providerRouteImageIntegration.test.js`
- `backend-node/test/providerRouteVideoIntegration.test.js`
- `backend-node/test/providerRouteTextIntegration.test.js`
- `backend-node/test/providerRouteStability.test.js`
- `backend-node/test/videoBilling.test.js`
- `backend-node/test/providerReconciliation.test.js`

候选 C 的验证如下，时间均为 UTC：

| 开始时间 | 结束时间 | 命令 | 退出码 | 结果 |
| --- | --- | --- | ---: | --- |
| 2026-08-18T22:10:37.1617043Z | 2026-08-18T22:10:37.5262009Z | `cd backend-node; node --test test/featureLockManifest.test.js` | 0 | 6/6 通过；固定列表确认 7 个核心回归均进入新锁 |
| 2026-08-18T22:10:52.6984129Z | 2026-08-18T22:10:55.5235952Z | 定向运行上述 7 个核心测试文件 | 0 | 64/64 通过 |
| 2026-08-18T22:11:06.1747154Z | 2026-08-18T22:11:07.1903773Z | `cd backend-node; npm run audit:feature-lock -- --base origin/main` | 0 | `ready=true`；5 个锁、66 个变更路径；基线仍为未联网刷新的本地 `origin/main` |
| 2026-08-18T22:11:15.6547166Z | 2026-08-18T22:11:15.9734574Z | `cd backend-node; node --test test/incrementalReleaseScope.test.js` | 0 | 5/5 通过 |
| 2026-08-18T22:11:29.8186665Z | 2026-08-18T22:11:30.1020065Z | `git diff --check origin/main...HEAD` 并比较变更文件与 scope | 0 | diff check 通过；变更 66、allowlist 66、差异 0 |
| 2026-08-18T22:11:41.5993052Z | 2026-08-18T22:11:42.5300196Z | 全树与新增行敏感信息扫描 | 0 | 全树 21 个占位/假值命中；新增行 2 个命中均为扫描规则自身及其证据引用；无真实凭据 |

候选 C 相对证据提交 B 只修改 `backend-node/test/featureLockManifest.test.js` 和 `docs/verification/platform-stability/feature-lock-manifest.json`，因此 release scope 文件数仍为 66。候选 A 的完整后端、前端、构建和 Playwright 证据不被伪称为候选 C 的全量重跑；Task14 最终候选仍需从实时 current 重建并全量验证。

## 合同证据

- 预算原子门禁：`providerCanaryBudget.test.js` 同时进入后端全量和 123 项定向回归；覆盖日/月硬上限、并发预占、幂等和超额告警。
- 未知结果保持占用且禁止重提：`providerCanaryBudget.test.js` 与 `providerCanaryExecutor.test.js` 同批验证；未知状态不自动释放、不自动重试。
- 证据过期与严格公开过滤：`providerCanaryEvidence.test.js` 与 `providerCanaryPublicGate.test.js` 同批验证；到期证据、运行指纹变化和不匹配能力不能进入 enforce 候选。
- 普通用户供应商与成本泄漏回归：`aiConfigPublicView.test.js`、`providerCanaryPublicGate.test.js`、前端全量测试和管理员 Playwright 同批验证；敏感信息新增行扫描未发现真实凭据。
- 隔离 fixture 与可读产物：`providerCanaryFixtures.test.js`、`providerCanaryArtifacts.test.js`、`providerAssetSignedAccess.test.js` 进入后端全量；本地零付费 Playwright 7/7，写请求计数为 0。
- 上述是本地自动化证据，不替代真实供应商成功终态、可读取真实产物、Hosted CI 或生产回读。

## 明确未执行

| 项目 | 状态 | 原因 |
| --- | --- | --- |
| 真实供应商生成 | blocked/not authorized | Task13 禁止联网与真实供应商调用 |
| Hosted CI | blocked/not authorized | Task13 未获推送或 CI 触发授权 |
| 生产 shadow | blocked/not authorized | Task14 需要独立生产授权，并从实时 current 重建 |
| 付费巡检 | blocked/not authorized | Task13 禁止付费调用 |
| 生产 enforce 门禁 | blocked/not authorized | Task14 分阶段授权前不得启用 |

## 自引用边界

完整后端、前端、构建和 Playwright 验证对象是候选 A；候选 C 只按审查要求重跑功能锁、7 个核心回归和轻量门禁。证据提交 B、D 均只记录结果，不能声称前一候选的测试验证了证据提交自身；D 后仅重跑功能锁、增量范围、变更范围和敏感信息检查。Task14 仍须从实时 current 构建最终候选并全量重跑。
