# 主动巡检与公开证据门禁验证记录

## 候选边界

- 本地基线引用：`origin/main`，未联网刷新；Task13 执行时解析为 `577b94816333e26bbbfe70d46f8e07ec124af0b1`。
- 候选 A：`1e999c828a8e2eed0377521032a9210185b244ac`；包含功能锁、精确发布范围、合同测试和验证前证据骨架。
- 证据提交 B：`9a97ea867de86dc85769557263bbd4fdbc8dd778`；只记录候选 A 的验证结果，没有修改候选 A 的代码、锁、测试或 release scope。
- 规格审查修复候选 C：`3a2b7557cbf105edd03e755f25919f8d2623173d`；只为新锁补齐 7 个核心 required tests，并同步固定列表合同测试。
- 证据提交 D：`7815b6c2cca971dff354db9ec629fb92835a206d`；只记录候选 C 的审查修复验证结果。
- 质量审查门禁修复候选 E：`1b01462f92bd8c1dd0ea0156833ab71214514fe4`；严格拒绝无效显式基线，并把 release scope 锁为 67 项精确清单。
- 证据提交 F：本文件更新后的下一提交；只记录候选 E 的质量审查验证结果，不预填自身 SHA。
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

## 质量审查门禁修复候选 E

质量审查确认两个门禁缺陷：显式 `--base` 无效或无法读取基线清单时会静默退化为零变更 ready；原 scope 测试只校验数量和样例，无法拒绝同数量偷换。TDD 红灯先修改两个测试文件：15 个测试中 11 个通过、4 个按预期失败，分别对应缺少审计脚本保护路径、非法 ref 被放行、存在 ref 但基线清单不可读仍被放行、scope 缺少第 67 项。最小实现后 15/15 通过。

候选 E 只修改以下 5 个文件，没有改证据文档：

- `backend-node/scripts/verify-feature-lock-manifest.js`
- `backend-node/test/featureLockManifest.test.js`
- `backend-node/test/incrementalReleaseScope.test.js`
- `deploy/release-scopes/platform-stability-proactive-canary.json`
- `docs/verification/platform-stability/feature-lock-manifest.json`

审计脚本仅在调用方显式传入非空 `--base` 时先执行 `git rev-parse --verify`，并要求该 ref 的功能锁清单可解析；无显式 base 仍使用既有发现顺序。审计脚本自身加入新锁 protected paths 和 release scope。`incrementalReleaseScope.test.js` 对 67 项完整有序列表执行深比较，并以替换为运行数据库路径的同数量恶意清单证明数量相同也会被拒绝。

候选 E 的验证如下，时间均为 UTC：

| 开始时间 | 结束时间 | 命令 | 实际退出码 | 结果 |
| --- | --- | --- | ---: | --- |
| 2026-08-18T22:27:28.4600929Z | 2026-08-18T22:27:28.6607866Z | `cd backend-node; node scripts/verify-feature-lock-manifest.js --base refs/heads/feature-lock-base-does-not-exist` | 1 | 正确拒绝，错误码 `INVALID_BASE_REF`，没有 ready 输出 |
| 2026-08-18T22:27:37.8065414Z | 2026-08-18T22:27:38.0881396Z | `cd backend-node; node scripts/verify-feature-lock-manifest.js --base HEAD:backend-node/package.json` | 1 | ref 存在但清单不可读，正确拒绝为 `BASE_MANIFEST_UNAVAILABLE` |
| 2026-08-18T22:27:46.2774472Z | 2026-08-18T22:27:46.6978998Z | `cd backend-node; node scripts/verify-feature-lock-manifest.js --base origin/main` | 0 | `ready=true`；5 个锁、67 个变更路径；本地 `origin/main` 未联网刷新 |
| 2026-08-18T22:27:55.6585273Z | 2026-08-18T22:27:56.8267685Z | `cd backend-node; node --test test/featureLockManifest.test.js` | 0 | 9/9 通过；反例通过真实 CLI 子进程断言非零退出，不是 helper 模拟 |
| 2026-08-18T22:28:06.1218390Z | 2026-08-18T22:28:06.4519782Z | `cd backend-node; node --test test/incrementalReleaseScope.test.js` | 0 | 6/6 通过；包含精确 67 项和同数量偷换反例 |
| 2026-08-18T22:28:17.4435070Z | 2026-08-18T22:28:17.7501155Z | `git diff --check origin/main...HEAD` 并比较变更文件与 scope | 0 | diff check 通过；变更 67、allowlist 67、差异 0 |
| 2026-08-18T22:28:28.5355911Z | 2026-08-18T22:28:29.4943880Z | 全树与新增行敏感信息扫描 | 0 | 全树 21 个占位/假值命中；新增行 2 个命中均为扫描规则自身及其证据引用；无真实凭据 |
| 2026-08-18T22:29:03.3001994Z | 2026-08-18T22:29:03.6912522Z | `cd backend-node; node scripts/verify-feature-lock-manifest.js` | 0 | 无显式 base 保留既有默认语义，本次发现 `HEAD^` 并审计 5 个真实变更路径 |

候选 E 的范围扩展只有审计脚本这一条已实际修改文件；没有新增运行数据、用户资产、AI 音乐、旧 scope、共享门禁或无关前端路径。

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

完整后端、前端、构建和 Playwright 验证对象是候选 A；候选 C 只按规格审查要求重跑功能锁、7 个核心回归和轻量门禁；候选 E 只按质量审查要求重跑显式/默认基线 CLI、两个门禁测试和轻量范围审计。证据提交 B、D、F 均只记录结果，不能声称前一候选的测试验证了证据提交自身；F 后仅重跑功能锁、增量范围、变更范围和敏感信息检查。Task14 仍须从实时 current 构建最终候选并全量重跑。

## 线路成本分离与多模型配置拆分本地候选

本节记录 2026-08-20 获批的本地 TDD 实现，代码候选为 `9b32150ab77d57c2b2e4bb54856784f5bc37423b`。本轮没有 SSH、供应商请求、付费生成、生产数据库写入、推送或部署；因此以下证据只证明本地合同与回归通过，不代表线上已经生效。

### 实现结果

- 供应商线路成本按 `config_id` 独立保存，图片按次、视频按秒及分辨率档、文本按 Token 分开配置；用户积分价格仍由原有公开计价表负责，两套价格不会互相覆盖。
- 主动巡检预算、成本指纹和证据均读取目标线路成本；缺失或为零的线路成本继续阻断，不使用同模型其他线路的成本代替。
- 正常生成在最终实际采用线路后写入不可变成本快照；提交结果未知时保留预占并把成本来源标为 unknown，不伪造成功成本、不自动重试。
- 管理端新增线路成本读取和保存接口及界面；公开目录继续递归移除供应商、线路、成本、凭据和巡检证据字段。
- 多模型拆分 CLI 默认 dry-run；apply 必须携带 dry-run 指纹并在单一 SQLite 事务内执行。原配置收窄到默认模型，克隆配置默认停用、未验证、未绑定公开逻辑模型；密钥只在数据库事务内继承，不出现在输出中。

### TDD 与同批验证

| 验证 | 结果 |
| --- | --- |
| 线路成本、巡检、最终线路成本账本、公开目录定向后端测试 | 45 项通过，0 失败 |
| 管理端线路成本后端合同 | 红灯确认端点缺失后，8/8 通过 |
| 管理端线路成本前端合同 | 红灯确认界面/API 缺失后，与既有合同合并 5/5 通过 |
| 多模型拆分 CLI | 红灯确认模块缺失后，5/5 通过；覆盖 dry-run、CAS、事务回滚、幂等和安全输出 |
| 后端全量 `npm test` | 1218 项：1213 通过、0 失败、5 跳过；退出码 0 |
| 前端全量 `node --test test/*.test.js` | 676/676 通过；退出码 0 |
| 前端生产构建 `npm run build` | 1859 个模块构建完成；退出码 0；仅保留既有大 chunk 警告 |
| 功能锁与增量范围合同 | 15/15 通过；`verify-feature-lock-manifest.js --base origin/main` 返回 `ready=true` |
| 生产 JS 语法检查 | 本轮 14 个生产/脚本 JS 文件全部通过 `node --check` |
| 增量白名单 | TDD 审计先发现实际 85 项、白名单 84 项，精确补入 `videoBilling.test.js` 后为 85/85，missing/extra 均为 0 |
| 差异格式 | `git diff --check origin/main...HEAD` 退出码 0 |
| 新增行敏感形状扫描 | API Key 与 Bearer 命中均为 0；2 个签名 URL 形状均为既有扫描规则自身，没有真实签名值 |

### 跨会话与发布边界

本地 `origin/main` 与本分支的树比较还包含以下 2 个只存在于较新主线、并非本任务修改的文件：

- `backend-node/scripts/fetch-redraw-full-frame-models-local.js`
- `backend-node/test/redrawFullFrameDetectorProcess.test.js`

它们没有被错误加入本任务 85 项发布白名单，也没有被本任务修改或删除。这一差异证明当前分支不能直接整体覆盖生产。任何后续发布仍必须按项目硬约束读取实时 `/opt/moli-drama/current`，从实时版本构建候选，只叠加本任务白名单内实际改动，再重跑共享门禁、全量测试、构建、健康和 AI 音乐隔离检查。

## 2026-08-20 逐模型证据绑定拆分本地 TDD

本节只记录 2026-08-21（Asia/Shanghai）在本地工作树
`C:\Users\canqu\Documents\茉莉妈妈2\worktrees\platform-stability-proactive-canary-plan-20260818`
对逐模型证据绑定拆分候选执行的新鲜验证，不复用前述候选计数。

### 功能锁与范围 TDD

| 开始时间 | 结束时间 | 命令 | 退出码 | tests / pass / fail / skip | 真实结果 |
| --- | --- | --- | ---: | --- | --- |
| 2026-08-21T01:06:40.8728110+08:00 | 2026-08-21T01:06:42.3457856+08:00 | `cd backend-node; node --test --test-concurrency=1 test/featureLockManifest.test.js test/incrementalReleaseScope.test.js` | 1 | 15 / 13 / 2 / 0 | 预期红灯；主动巡检锁首个缺项为 `provider-readiness-binding-candidate-20260820.md`，scope 深比较明确缺少本轮三份证据路径。 |
| 2026-08-21T01:07:13.0412235+08:00 | 2026-08-21T01:07:14.5388334+08:00 | 同一锁与范围定向命令 | 0 | 15 / 15 / 0 / 0 | 只追加三份 evidence 并按字典序同步 scope 后转绿。 |
| 2026-08-21T01:07:14.5459467+08:00 | 2026-08-21T01:07:14.9537007+08:00 | `cd backend-node; node scripts/verify-feature-lock-manifest.js --base origin/main` | 1 | 不适用 | 首次真实 CLI 审计返回 `FEATURE_LOCKED`；相对本地 `origin/main`，既有受保护路径 `split-multi-model-provider-configs.js` 与 `providerRouteCostService.js` 已变更，但原 unlock 与基线相同，不是 fresh unlock。 |
| 2026-08-21T01:11:11.8384233+08:00 | 2026-08-21T01:11:13.1109869+08:00 | `cd backend-node; node --test --test-concurrency=1 test/featureLockManifest.test.js` | 1 | 9 / 8 / 1 / 0 | fresh unlock 合同红灯；精确显示旧 reason、approvedBy 和缺少的三项跨服务 impact tests。 |
| 2026-08-21T01:11:37.3700569+08:00 | 2026-08-21T01:11:38.8533312+08:00 | 锁与范围定向命令 | 0 | 15 / 15 / 0 / 0 | proactive 锁使用 scope-specific fresh unlock 后转绿；其余四个锁的既有 unlock 保持不变。 |
| 2026-08-21T01:11:38.8615236+08:00 | 2026-08-21T01:11:39.2754651+08:00 | `cd backend-node; node scripts/verify-feature-lock-manifest.js --base origin/main` | 0 | 不适用 | `ready=true`，5 个锁、11 个变更路径、5 个基线保护锁。 |

原书面计划同时要求“不修改 unlock”和 `verify-feature-lock-manifest --base origin/main` 必须 ready；当前审计器只接受与基线 JSON 不同的有效 fresh unlock，新增 evidence 本身不能解锁，二者构成真实冲突。首次 `FEATURE_LOCKED` 后没有绕过门禁；经任务控制者依据产品负责人已经批准的书面规格与本地 TDD 执行授权，才把 proactive 锁更新为 `2026-08-20 逐模型证据绑定拆分本地 TDD 授权`，保留原 6 项 impact tests 并追加 canvas catalog、public gate、video route integration 三项真实跨服务回归。

本轮数据变更只在 `stability.proactive-canary-and-public-evidence.evidence` 末尾追加三份证据，并更新该 feature 的 fresh unlock；没有减少 acceptance、status、protectedPaths、requiredTests 或历史 evidence，也没有修改其他 feature。发布 scope 只按字典序加入同三份文档，未加入数据库、资产、AI 音乐、shared release guard、临时产物、目录项或通配符。

### 完整本地验证

| 开始时间 | 结束时间 | 命令 | 退出码 | tests / pass / fail / skip | 真实结果 |
| --- | --- | --- | ---: | --- | --- |
| 2026-08-21T01:13:40.7742362+08:00 | 2026-08-21T01:14:31.7660437+08:00 | `cd backend-node; node --test --test-concurrency=1 test/providerRouteCost.test.js test/splitMultiModelProviderConfigs.test.js test/canvasModelCatalogService.test.js test/providerCanaryPublicGate.test.js test/providerCanaryScheduler.test.js test/providerRouteVideoIntegration.test.js test/featureLockManifest.test.js test/incrementalReleaseScope.test.js` | 0 | 143 / 143 / 0 / 0 | 指定后端跨服务回归全部通过。 |
| 2026-08-21T01:14:47.2541775+08:00 | 2026-08-21T01:18:56.3040176+08:00 | `cd backend-node; npm test` | 0 | 1244 / 1239 / 0 / 5 | 后端全量通过；26 suites，5 项按既有条件跳过。 |
| 2026-08-21T01:19:18.7487716+08:00 | 2026-08-21T01:19:18.9050856+08:00 | `cd backend-node; node --check scripts/split-multi-model-provider-configs.js` | 0 | 不适用 | 语法检查通过。 |
| 2026-08-21T01:19:18.9115933+08:00 | 2026-08-21T01:19:19.0272031+08:00 | `cd backend-node; node --check src/services/providerRouteCostService.js` | 0 | 不适用 | 语法检查通过。 |
| 2026-08-21T01:19:56.7713818+08:00 | 2026-08-21T01:20:43.7174310+08:00 | `cd frontweb; node --test test/*.test.js` | 0 | 677 / 677 / 0 / 0 | 前端全量测试通过。 |
| 2026-08-21T01:20:55.5646999+08:00 | 2026-08-21T01:21:23.0729103+08:00 | `cd frontweb; npm run build` | 0 | 不适用 | Vite 6.4.3 完成 1859 个模块，25.14 秒；仅有大于 500 kB 的既有 chunk 警告。 |
| 2026-08-21T01:21:33.6251624+08:00 | 2026-08-21T01:21:53.6378554+08:00 | `cd frontweb; npx --no-install playwright test e2e/provider-stability-admin.spec.js e2e/platform-zero-cost-smoke.spec.js` | 0 | 7 / 7 / 0 / 0 | 两个 worker、7 项通过；零成本 smoke 的生成写请求计数为 0。仅出现 `NO_COLOR` 被 `FORCE_COLOR` 忽略的运行器警告。 |

后端测试使用测试创建并清理的临时 SQLite；证据绑定测试只读取受保护证据 fixture，不读取生产 evidence roots。前端工作树原先没有 `node_modules`，没有运行 `npm install` 或任何联网安装：

- 工作树 `frontweb/package-lock.json` SHA-256：`18BA50E97964D491CBD15CE54EB3FB65BE4470F04FA9F1D03845FB7B307CE82D`。
- 离线依赖来源：`C:\Users\canqu\Documents\茉莉妈妈2\worktrees\fumin-seedance-20260813\frontweb\node_modules`。
- 来源工作树 `frontweb/package-lock.json` SHA-256：`18BA50E97964D491CBD15CE54EB3FB65BE4470F04FA9F1D03845FB7B307CE82D`；两份锁完全相同。
- 验证时只创建指向上述绝对来源的临时 `node_modules` junction。删除前再次确认 `LinkType=Junction`、Target 精确等于上述来源；只删除 junction 本身，删除后来源仍存在。
- 本轮创建的 `frontweb/test-results` 和 `frontweb/platform-smoke-artifacts` 均在确认绝对路径位于本工作树且不是 reparse point 后清理。`frontweb/dist` 创建时间早于本轮，作为既有 ignored 构建目录保留，没有把它纳入 Task6 提交。

### 锁、范围与凭据形状审计

| 开始时间 | 结束时间 | 审计 | 退出码 | 结果 |
| --- | --- | --- | ---: | --- |
| 2026-08-21T01:25:09.1317780+08:00 | 2026-08-21T01:25:09.5166017+08:00 | `git diff --check`、`git status --short`、`git diff --name-only origin/main...HEAD` | 0 | 差异格式通过；当时仅 4 个 Task6 数据/测试文件未提交，HEAD 范围为 7 个既有实现/测试/规格证据文件。 |
| 2026-08-21T01:25:42.7760895+08:00 | 2026-08-21T01:25:43.2546301+08:00 | 对 `origin/main...HEAD` 新增行执行脱敏 credential-shaped 扫描 | 0 | 2 个命中，均在计划文档第 1287 行：`sk-` 与 `Bearer` 是扫描规则自身；`api_key` 后长令牌与 URL userinfo 为 0。未输出候选值，无无法解释命中。 |
| 2026-08-21T01:26:11.9328035+08:00 | 2026-08-21T01:26:12.3866176+08:00 | 对包含未提交 Task6 变更的 `origin/main` 工作树差异执行同一脱敏扫描 | 0 | 仍只有同一行的 2 个规则自身命中；Task6 新增行没有凭据形状。 |

scope 当前 88 条且保持字典序；写本文前的 11 条工作树差异全部在 scope 中，missing 0，数据库/上传/存储/资产/AI 音乐/release guard/通配符等禁区命中 0。2026-08-21T01:28:54.4651979+08:00 至 01:28:55.1977451+08:00 的最终提交前审计再次确认 `git diff --check` 为 0、Task6 修改精确等于五文件白名单、包含本文后的 `origin/main` 工作树差异为 12 条且 scope missing 仍为 0；其他四个 feature 完全未变，proactive 锁除 evidence 后缀与 fresh unlock 外的受保护字段和历史 evidence 前缀均未变。2026-08-21T01:29:12.7291716+08:00 至 01:29:13.2382064+08:00 的最终工作树脱敏扫描共 4 个命中，分别是计划与本节各 2 个规则自引用；长令牌和 URL userinfo 仍为 0，无无法解释命中。主提交 `5bff4d30847469a4bb6fb90d8d09cceb4f630c16` 完成后已执行而非计划执行以下门禁：2026-08-21T01:30:19.9495225+08:00 至 01:30:21.4998567+08:00，功能锁与增量范围定向命令 exit 0，15/15 通过；01:30:21.5079677+08:00 至 01:30:21.9200678+08:00，`node scripts/verify-feature-lock-manifest.js --base origin/main` exit 0，`ready=true`、5 个锁、12 个变更路径；01:30:36.4924297+08:00 至 01:30:36.7975108+08:00，`git diff --check origin/main...HEAD` exit 0，累计变更 12 条，`git status --short` 输出 0 条；01:30:54.0730806+08:00 至 01:30:54.6125455+08:00，提交后脱敏扫描 exit 0，4 个命中仍全部为计划/本文的规则自引用，无无法解释命中。上述命令均已单独捕获精确起止时间和退出结果。

### 明确边界与后续门禁

- 本轮没有访问生产、供应商或付费接口，没有 SSH、推送、部署、真实生成或真实供应商查单。
- 没有启用 `enforce`，没有修改生产数据库、用户资产、积分或 AI 音乐；临时 SQLite 和受保护证据 fixture 仅用于本地测试。
- 生产实时指纹、生产绑定文件、数据库备份、部署锁、从实时 `/opt/moli-drama/current` 构建候选、共享发布门禁和逐线路付费授权仍是后续独立门禁。
- 本地绿灯不等于线上稳定，不证明所有模型已恢复，也不授权把未完成真实生成、成功终态和可读产物验证的模型开放到生产目录。
