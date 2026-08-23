# 主动稳定性控制面实现计划

> **面向实施代理：** 推荐使用 `subagent-driven-development` 按任务逐项实施并在每项后审查；若由单一代理连续执行，则使用 `executing-plans`。无论采用哪种方式，都必须遵守本文的测试先行、付费门禁和受保护发布边界。

**目标：** 在不改变现有用户积分合同、不暴露供应商信息、不让用户充当测试者的前提下，完成阶段 0 的供应商线路基线和阶段 1 的主动巡检、预算、证据生命周期、公开目录门禁及管理员控制面。

**架构：** 复用现有逻辑模型路由、供应商健康、错误分类、结果未知保护和管理员事件表；新增独立的巡检运行账本、能力证据、零成本检查和隔离产物。公开目录及用户请求只接受 48 小时内、能力覆盖、运行代码指纹一致且健康允许的线路。首次发布采用 `shadow`，付费巡检与严格公开门禁分别在独立授权后激活。

**技术栈：** Node.js、Express、better-sqlite3、Vue 3、Element Plus、Node test runner、Playwright、Vite、GitHub Actions、现有共享受保护发布门禁。

---

## 0. 实施边界与固定合同

- 设计依据：`docs/superpowers/specs/2026-08-18-platform-stability-proactive-canary-design.md`。
- 规划工作树：`C:\Users\canqu\Documents\茉莉妈妈2\worktrees\platform-stability-proactive-canary-plan-20260818`。
- 规划基线：`origin/main@577b9481`；设计提交：`69eab0aa`。
- 本计划只覆盖阶段 0 的供应商巡检基线和阶段 1 的主动稳定性控制面。画布、短剧工厂、剧本分析分别在本阶段独立发布并锁定后，各自创建实施计划，不在本 PR 中混改。
- 每日自动巡检成本硬上限为 `20_000_000` 微元人民币；每月为 `600_000_000` 微元人民币。环境变量只允许调低，不能调高。
- 真实证据最长有效 `48` 小时；配置、能力、成本或运行适配代码变化只使受影响证据失效。
- 图片、视频、文本巡检都只提交一次。取得任务号、请求发送结果不明、HTTP 成功但协议不可解析、产物不可读或轮询超时后，状态进入未知，禁止重试和自动切换。
- 巡检不创建普通用户、项目、画布、素材、图片生成或视频生成业务记录，不触碰用户积分账本。
- 用户端永远不返回供应商、域名、配置 ID、Key、内部成本、供应商任务号或内部错误；这些内容只进入管理员 RBAC 接口，且仍须脱敏。
- 本地实现和测试不授权真实供应商调用、生产写入、推送、PR、合入或部署。任何真实巡检激活需另行取得明确付费与生产授权。
- 现有 `canvas-credit-callout-v1`、未知任务积分冻结、同模型同能力容灾和 AI 音乐隔离合同必须保持不变。

## 1. 完成判据

阶段 0 + 1 只有同时满足以下项目才可报告完成：

1. 当前公开线路、能力、价格、成本和巡检准备度可由只读脚本生成脱敏机器清单。
2. 每个证据均绑定配置指纹、能力指纹、成本指纹和运行代码指纹，最长 48 小时后失效。
3. 预算预占在 SQLite 单写事务内原子完成；并发或重复运行不能突破日/月硬上限。
4. 图片、视频、文本指定配置巡检不经过容灾路由，不自动重提，成功终态必须有可读产物或非空文本摘要。
5. 巡检产物只进入 `_system/provider-canary` 隔离目录，不出现在任何用户资产和生成表。
6. 五分钟零成本检查不能刷新真实证据；无付费浏览器冒烟不会调用生成接口。
7. `enforce` 模式下，过期、未知、失败、预算阻断、成本缺失、能力不覆盖或代码指纹不一致的线路不能进入候选或公开目录。
8. 管理员可以看到线路、证据、预算、运行、未知和 P0-P3 事件；普通用户接口通过泄漏回归。
9. 后端全量测试、前端全量单测、生产构建、目标 Playwright、功能锁、增量发布和敏感信息审计全部通过。
10. 生产只能按 `shadow → 受控付费巡检 → enforce` 三个独立门禁推进；每一步都从当时实时线上版本制作候选并通过共享激活器。

---

## 任务 1：建立阶段 0 的脱敏线路与巡检准备度清单

**文件：**

- 新增：`backend-node/src/services/providerCanaryInventoryService.js`
- 新增：`backend-node/scripts/audit-provider-canary-readiness.js`
- 新增：`backend-node/test/providerCanaryInventory.test.js`
- 新增：`docs/verification/platform-stability/provider-canary-readiness.schema.json`
- 生成：`docs/verification/platform-stability/provider-canary-readiness.json`

### 步骤 1：先写失败测试

测试创建内存数据库，插入以下四类配置：

- 已公开、已定价、内部成本大于零且能力已声明的图片线路；
- 已公开但成本为零的视频线路；
- 已启用但没有 `logical_model_id` 的旧线路；
- 已停用线路。

核心断言必须完整包含：

```js
const report = inventory.buildCanaryReadiness(db, {
  now: '2026-08-18T00:00:00.000Z',
  runtimeFingerprints: { image: 'image-runtime', video: 'video-runtime' },
});

assert.equal(report.schema_version, 1);
assert.equal(report.summary.public_routes, 3);
assert.equal(report.summary.ready_for_paid_canary, 1);
assert.equal(report.routes.find((row) => row.logical_model_id === 'video-zero-cost').blockers
  .includes('cost_not_positive'), true);
assert.equal(report.routes.some((row) => row.blockers.includes('missing_logical_model_id')), true);
for (const secret of ['sk-secret', 'relay.example.com', '/v1/images', 'Authorization']) {
  assert.equal(JSON.stringify(report).includes(secret), false);
}
```

脚本测试使用临时 SQLite 文件和 `--out`，验证原子写入 JSON、重复运行输出稳定、非零阻断时退出码为 `2`，格式错误退出码为 `1`。

运行：

```powershell
cd backend-node
node --test test/providerCanaryInventory.test.js
```

预期：因服务和脚本不存在而失败。

### 步骤 2：实现只读清单服务和 CLI

`providerCanaryInventoryService.js` 导出：

```js
buildCanaryReadiness(db, options)
sanitizeRouteRef(config)
```

`sanitizeRouteRef` 只返回 `sha256(provider + "\n" + URL.origin + "\n" + config.id)` 的前 16 位；报告允许出现逻辑模型、服务类型、能力、价格状态、成本状态、优先级和阻断原因，不得出现配置 ID、供应商名、域名、Base URL、Key、任务号或签名 URL。

阻断枚举固定为：

```text
missing_logical_model_id
missing_user_price
missing_cost
cost_not_positive
missing_capabilities
legacy_connection_only_verification
admin_paused
```

CLI 参数固定为 `--database`、`--out`、`--allow-blocked`。生产只读运行命令为：

```bash
cd /opt/moli-drama/current/backend-node
node scripts/audit-provider-canary-readiness.js \
  --database /opt/moli-drama/shared/data/drama_generator.db \
  --out /opt/moli-drama/shared/release-evidence/provider-canary-readiness.json
```

正式提交到仓库的 `provider-canary-readiness.json` 从经过脱敏审查的生产只读结果复制；不得提交数据库、Host、Key 或任务号。

### 步骤 3：运行测试和格式审计

```powershell
cd backend-node
node --test test/providerCanaryInventory.test.js
node scripts/audit-provider-canary-readiness.js --help
git diff --check
```

预期：测试通过；CLI 输出固定参数说明并以 0 退出；`git diff --check` 无输出。

### 步骤 4：提交

```powershell
git add backend-node/src/services/providerCanaryInventoryService.js backend-node/scripts/audit-provider-canary-readiness.js backend-node/test/providerCanaryInventory.test.js docs/verification/platform-stability/provider-canary-readiness.schema.json docs/verification/platform-stability/provider-canary-readiness.json
git commit -m "feat(稳定性): 建立巡检准备度基线"
```

---

## 任务 1B：建立三个板块的机器可读入口与功能基线

**文件：**

- 新增：`docs/verification/platform-stability/platform-feature-inventory.schema.json`
- 新增：`docs/verification/platform-stability/platform-feature-inventory.json`
- 新增：`backend-node/scripts/verify-platform-feature-inventory.js`
- 新增：`backend-node/test/platformFeatureInventory.test.js`

### 步骤 1：先写清单合同失败测试

Schema 对每个功能项要求以下非空字段：

```json
{
  "feature_id": "canvas.node.image.generate",
  "module": "canvas",
  "entry_route": "/canvas/:id",
  "control_label": "生成",
  "action_kind": "generation",
  "required_role": "user",
  "writes_state": true,
  "may_charge": true,
  "acceptance_chain": ["browser", "api", "task", "provider", "artifact", "writeback", "billing"],
  "source_paths": ["frontweb/src/views/DramaCanvas.vue"],
  "test_paths": ["frontweb/e2e/project-canvas-backend-integration.spec.js"],
  "baseline_state": "unverified"
}
```

固定模块为 `shared`、`canvas`、`short_drama_factory`、`script_analysis`。`feature_id` 全局唯一；入口、按钮、菜单、弹窗操作、API、刷新恢复、预览、下载、积分和跨板块投影都必须有独立项。`baseline_state` 只允许 `unverified|verified|blocked`，阶段 0 全部真实写为 `unverified` 或有当前阻断证据的 `blocked`，不能预填通过。

测试还必须验证三个业务模块均有入口项、共享权限/积分/资产项均存在、所有 `source_paths` 和 `test_paths` 指向实际文件、没有未完成或待定标记。

### 步骤 2：只读生成真实基线

实施者按以下顺序工作，不产生付费请求或业务写入：

1. 从 `frontweb/src/router/index.js`、顶部导航、三个板块入口组件和 `backend-node/src/routes/index.js` 枚举可达入口与 API；
2. 在本地 fixture 或生产只读登录会话逐页展开菜单、页签、弹窗和设置，记录每个可见控制；
3. 把每个控制关联到真实前端、后端和现有测试文件；
4. 运行校验器，缺少链路或文件的项标记 `blocked` 并写明确 `block_reason`；
5. 不在阶段 0 点击生成、保存、删除、充值、发布或其他写操作。

校验器只验证清单结构和文件存在性，不把静态文件存在冒充功能通过。三个模块的真实验收状态在阶段 2、3、4 各自计划中更新。

### 步骤 3：验证并提交

```powershell
cd backend-node
node --test test/platformFeatureInventory.test.js
node scripts/verify-platform-feature-inventory.js
git diff --check
cd ..
git add docs/verification/platform-stability/platform-feature-inventory.schema.json docs/verification/platform-stability/platform-feature-inventory.json backend-node/scripts/verify-platform-feature-inventory.js backend-node/test/platformFeatureInventory.test.js
git commit -m "docs(稳定性): 建立三板块功能基线"
```

预期：清单结构、路径和覆盖合同通过；所有功能仍保持真实 `unverified/blocked`，没有提前宣称验收。

---

## 任务 2：新增巡检运行、能力证据与零成本检查数据库合同

**文件：**

- 新增：`backend-node/migrations/60_provider_canary_guard.sql`
- 修改：`backend-node/test/providerRouteSchema.test.js`

### 步骤 1：先扩展失败测试

在 `providerRouteSchema.test.js` 新增测试，连续执行两次迁移后验证：

```js
for (const table of [
  'provider_canary_runs',
  'provider_canary_evidence',
  'provider_zero_cost_checks',
]) {
  assert.equal(hasTable(db, table), true);
}
assert.equal(columnNames(db, 'ai_service_configs').has('canary_paused'), true);
assert.equal(indexNames(db, 'provider_canary_runs').has('idx_provider_canary_runs_budget_day'), true);
assert.equal(indexNames(db, 'provider_canary_evidence').has('idx_provider_canary_evidence_expiry'), true);
```

再验证 `idempotency_key` 唯一、证据 `(config_id, capability_fingerprint)` 唯一、负成本和非法状态被 `CHECK` 拒绝。

运行：

```powershell
cd backend-node
node --test test/providerRouteSchema.test.js
```

预期：缺表和缺列失败。

### 步骤 2：实现迁移

迁移新增：

```sql
ALTER TABLE ai_service_configs ADD COLUMN canary_paused INTEGER NOT NULL DEFAULT 0;

CREATE TABLE provider_canary_runs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  config_id INTEGER NOT NULL,
  logical_model_id TEXT NOT NULL,
  service_type TEXT NOT NULL,
  capability_fingerprint TEXT NOT NULL,
  config_fingerprint TEXT NOT NULL,
  cost_fingerprint TEXT NOT NULL,
  runtime_fingerprint TEXT NOT NULL,
  provider_scope_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'reserved','submitting','accepted','verifying','succeeded','failed',
    'submission_unknown','result_unknown','artifact_unreadable','budget_blocked'
  )),
  reserved_cost_micros INTEGER NOT NULL CHECK (reserved_cost_micros >= 0),
  actual_cost_micros INTEGER CHECK (actual_cost_micros >= 0),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  budget_day TEXT NOT NULL,
  budget_month TEXT NOT NULL,
  provider_task_id TEXT,
  artifact_path TEXT,
  artifact_sha256 TEXT,
  artifact_bytes INTEGER,
  error_category TEXT,
  safe_error_summary TEXT,
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE provider_canary_evidence (
  config_id INTEGER NOT NULL,
  service_type TEXT NOT NULL,
  capability_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'never_verified','fresh','stale','failing','submission_unknown',
    'budget_blocked','disabled'
  )),
  run_id TEXT,
  config_fingerprint TEXT NOT NULL,
  cost_fingerprint TEXT NOT NULL,
  runtime_fingerprint TEXT NOT NULL,
  verified_at TEXT,
  expires_at TEXT,
  invalidated_at TEXT,
  invalidation_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (config_id, capability_fingerprint)
);

CREATE TABLE provider_zero_cost_checks (
  config_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('healthy','degraded','failed','disabled')),
  category TEXT,
  safe_summary TEXT,
  checked_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

同时建立日/月预算、线路状态和证据过期索引。迁移只加表、列和索引，不改现有业务数据。

### 步骤 3：验证迁移

```powershell
cd backend-node
node --test test/providerRouteSchema.test.js
node --check src/db/migrate.js
git diff --check
```

预期：全部通过。

### 步骤 4：提交

```powershell
git add backend-node/migrations/60_provider_canary_guard.sql backend-node/test/providerRouteSchema.test.js
git commit -m "feat(稳定性): 新增主动巡检数据合同"
```

---

## 任务 3：实现能力指纹、覆盖关系与证据生命周期

**文件：**

- 新增：`backend-node/src/services/providerCanaryEvidenceService.js`
- 新增：`backend-node/src/services/providerRuntimeFingerprintService.js`
- 新增：`backend-node/test/providerCanaryEvidence.test.js`
- 新增：`backend-node/test/providerRuntimeFingerprint.test.js`

### 步骤 1：写能力与生命周期失败测试

测试覆盖：

- 对象键顺序不同产生同一指纹；
- 分辨率、比例、时长和同步音频必须匹配；
- 已验证 9 张图可以覆盖 0 到 9 张请求，但不能覆盖 10 张；
- 证据满足 `now < expires_at` 才为新鲜，到达 48 小时整立即过期；
- 零成本检查不能更新 `verified_at` 或 `expires_at`；
- 配置、成本或运行代码指纹任一不一致均不可用；
- 未知状态不能被健康重置恢复；
- 新成功证据只更新目标配置和目标能力指纹。

核心测试：

```js
const evidence = service.recordSuccess(db, {
  configId: 7,
  serviceType: 'video',
  capability: {
    resolution: '720p', aspectRatio: '16:9', duration: 15,
    referenceImageCount: 9, referenceVideoCount: 3,
    referenceAudioCount: 3, requiresAudio: true,
  },
  runId: 'canary-run-1',
  configFingerprint: 'cfg-a',
  costFingerprint: 'cost-a',
  runtimeFingerprint: 'runtime-a',
  now: '2026-08-18T00:00:00.000Z',
});
assert.equal(evidence.expires_at, '2026-08-20T00:00:00.000Z');
assert.equal(service.covers(evidence, {
  resolution: '720p', aspectRatio: '16:9', duration: 15,
  referenceImageCount: 2, referenceVideoCount: 1,
  referenceAudioCount: 1, requiresAudio: true,
}), true);
assert.equal(service.covers(evidence, { resolution: '480p', duration: 15 }), false);
```

运行：

```powershell
cd backend-node
node --test test/providerCanaryEvidence.test.js test/providerRuntimeFingerprint.test.js
```

预期：模块不存在失败。

### 步骤 2：实现稳定指纹和证据状态机

`providerCanaryEvidenceService.js` 导出：

```js
normalizeCapability(serviceType, capability)
capabilityFingerprint(serviceType, capability)
capabilityCovers(evidenceCapability, requestedCapability)
configFingerprint(config)
costFingerprint(priceRow, resolutionPrices)
providerScopeKey(config)
recordSuccess(db, input)
recordFailure(db, input)
recordUnknown(db, input)
recordBudgetBlocked(db, input)
invalidateConfig(db, configId, reason, now)
invalidateLogicalModel(db, logicalModelId, reason, now)
listFreshCoveringEvidence(db, input)
effectiveEvidenceState(row, context)
```

`recordUnknown` 保留运行表中的精确 `submission_unknown|result_unknown|artifact_unreadable`，证据表按已批准生命周期统一写 `submission_unknown`，并把精确分类放在管理员安全事件中；不能向证据表写 CHECK 枚举之外的状态。

所有指纹使用稳定 JSON 后计算 SHA-256。配置指纹必须在内存中包含 Key、Base URL、协议、上游模型和能力配置，但数据库只保存哈希；日志不记录输入。证据有效期使用固定常量 `MAX_EVIDENCE_AGE_MS = 48 * 60 * 60 * 1000`，环境变量只能缩短。

`providerRuntimeFingerprintService.js` 为 `text`、`image`、`video` 建立显式运行文件映射；活动配置的协议若没有映射，准备度审计返回 `missing_runtime_mapping`。指纹包含公共客户端、错误分类器及对应供应商适配器内容哈希，不包含文件绝对路径。

### 步骤 3：运行定向测试

```powershell
cd backend-node
node --test test/providerCanaryEvidence.test.js test/providerRuntimeFingerprint.test.js
node --check src/services/providerCanaryEvidenceService.js
node --check src/services/providerRuntimeFingerprintService.js
```

预期：全部通过。

### 步骤 4：提交

```powershell
git add backend-node/src/services/providerCanaryEvidenceService.js backend-node/src/services/providerRuntimeFingerprintService.js backend-node/test/providerCanaryEvidence.test.js backend-node/test/providerRuntimeFingerprint.test.js
git commit -m "feat(稳定性): 实现能力证据生命周期"
```

---

## 任务 4：实现人民币日/月预算原子预占和未知占用

**文件：**

- 新增：`backend-node/src/services/providerCanaryBudgetService.js`
- 新增：`backend-node/test/providerCanaryBudget.test.js`

### 步骤 1：先写预算失败测试

覆盖：

- `19.50 + 0.50` 元允许，下一分拒绝；
- 月预算同理；
- 两个不同连接按顺序竞争，第二个看到第一个已提交预占；
- 相同幂等键只返回原运行，不重复预占；
- 明确发送前失败结算为 0；
- 成功按实际成本结算，但实际成本不得超过预占；超过时进入 P1 审计而不是静默突破；
- `submission_unknown`、`result_unknown`、`artifact_unreadable` 保留全额预占；
- 跨日/月不会释放旧未知占用记录，但新周期计算只使用对应周期；
- 环境变量请求 21 元/601 元时仍被截到硬上限。

核心断言：

```js
const first = budget.reserve(db, {
  id: 'run-a', idempotencyKey: 'route-a:profile-a:2026-08-18',
  reservedCostMicros: 19_500_000, now: '2026-08-18T00:00:00.000Z',
  route: fixtureRoute,
});
assert.equal(first.state, 'reserved');
budget.reserve(db, {
  id: 'run-b', idempotencyKey: 'route-b:profile-b:2026-08-18',
  reservedCostMicros: 500_000, now: '2026-08-18T00:01:00.000Z',
  route: fixtureRouteB,
});
assert.throws(() => budget.reserve(db, {
  id: 'run-c', idempotencyKey: 'route-c:profile-c:2026-08-18',
  reservedCostMicros: 1, now: '2026-08-18T00:02:00.000Z', route: fixtureRouteC,
}), { code: 'PROVIDER_CANARY_DAILY_BUDGET_EXCEEDED' });
```

### 步骤 2：实现原子预算

`reserve` 使用 `db.transaction(fn).immediate()`；在同一事务中检查幂等键、汇总当日/当月有效占用并插入 `reserved` 运行。有效占用为 `COALESCE(actual_cost_micros, reserved_cost_micros)`；未知记录保持 `actual_cost_micros = NULL`。

`budget_day` 与 `budget_month` 固定按 `Asia/Shanghai` 计算，不依赖服务器本地时区；测试覆盖北京时间 00:00 和月初边界。

导出：

```js
reserve(db, input)
markSubmitting(db, runId, now)
markAccepted(db, runId, providerTaskId, now)
settleSuccess(db, runId, actualCostMicros, artifact, now)
settleDefinitiveFailure(db, runId, actualCostMicros, category, now)
settleUnknown(db, runId, state, category, providerTaskId, now)
getBudgetSummary(db, now)
resolveBudgetLimits(env)
```

成本为零、币种不明、不能计算最大文本 token 成本或视频缺少分辨率成本时，调用方不得进入 `reserve`，而是记录 `budget_blocked` 证据和 P3 事件。

### 步骤 3：验证

```powershell
cd backend-node
node --test test/providerCanaryBudget.test.js
node --check src/services/providerCanaryBudgetService.js
```

### 步骤 4：提交

```powershell
git add backend-node/src/services/providerCanaryBudgetService.js backend-node/test/providerCanaryBudget.test.js
git commit -m "feat(稳定性): 增加巡检预算原子门禁"
```

---

## 任务 5：建立隔离巡检素材和可读取产物验证

**文件：**

- 新增：`backend-node/src/services/providerCanaryFixtureService.js`
- 新增：`backend-node/src/services/providerCanaryArtifactService.js`
- 修改：`backend-node/src/middleware/resourceOwnership.js`
- 新增：`backend-node/test/providerCanaryFixtures.test.js`
- 新增：`backend-node/test/providerCanaryArtifacts.test.js`
- 新增：`backend-node/test/providerAssetSignedAccess.test.js`

### 步骤 1：先写素材与访问失败测试

测试必须证明：

- 素材只写入 `${storageRoot}/_system/provider-canary/fixtures`；
- 图片、视频、音频数量按请求生成且文件名稳定，不创建 `assets`、`image_generations`、`video_generations` 行；
- 有效 `provider_asset_expires` 和 `provider_asset_signature` 可无用户 Cookie 读取；
- 过期、篡改路径或签名的请求返回 401/404；
- 日志不包含签名参数；
- 产物下载只接受绝对 `http/https` 或受支持的 `data:image`；
- 图片校验 PNG/JPEG/WebP 魔数，视频校验 ISO BMFF/WebM 魔数，文本要求去空白后非空；
- HTML、SVG、空文件、超限文件、重定向到非 HTTP(S)、文件协议和响应中断均失败；
- 临时文件失败后删除，成功使用原子重命名和 `0600` 权限。

### 步骤 2：实现固定巡检素材

`providerCanaryFixtureService.js` 导出：

```js
ensureFixtureSet(options)
buildReferenceInputs(options)
```

图片使用 `sharp` 生成无人物、无版权文本的纯色几何图；视频和 WAV 音频使用现有 ffmpeg 二进制生成 1 秒固定素材。需要引用素材的能力若运行环境缺少 ffmpeg，线路进入 `budget_blocked`，不得退化为无参考图测试。

`buildReferenceInputs` 根据能力指纹返回恰好对应数量的不同签名 URL；不得重复同一 URL 伪装多参考能力。签名 TTL 不超过 2 小时。

### 步骤 3：实现隔离产物验证

`providerCanaryArtifactService.js` 导出：

```js
materializeImage(result, options)
materializeVideo(url, options)
verifyText(text)
artifactSummary(path)
```

隔离目录固定为 `${storageRoot}/_system/provider-canary/runs/${runId}`。数据库只保存相对路径、SHA-256 和字节数，不保存完整远端 URL、Base64 或提示词。

`resourceOwnership.js` 在普通用户鉴权前调用现有 `verifyProviderAssetRequest`；只允许签名覆盖的精确 `/static/` 路径和未过期请求，不改变其他静态资源所有权规则。

### 步骤 4：验证

```powershell
cd backend-node
node --test test/providerCanaryFixtures.test.js test/providerCanaryArtifacts.test.js test/providerAssetSignedAccess.test.js test/fuminVideo.test.js test/toapisVideoIntegration.test.js
node --check src/services/providerCanaryFixtureService.js
node --check src/services/providerCanaryArtifactService.js
```

### 步骤 5：提交

```powershell
git add backend-node/src/services/providerCanaryFixtureService.js backend-node/src/services/providerCanaryArtifactService.js backend-node/src/middleware/resourceOwnership.js backend-node/test/providerCanaryFixtures.test.js backend-node/test/providerCanaryArtifacts.test.js backend-node/test/providerAssetSignedAccess.test.js
git commit -m "feat(稳定性): 隔离巡检素材与产物"
```

---

## 任务 6：实现图片、视频、文本指定线路单次巡检执行器

**文件：**

- 修改：`backend-node/src/services/aiClient.js`
- 新增：`backend-node/src/services/providerCanaryExecutor.js`
- 新增：`backend-node/test/providerCanaryTextConfig.test.js`
- 新增：`backend-node/test/providerCanaryExecutor.test.js`

### 步骤 1：先写指定配置文本失败测试

配置 A 和 B 分别指向两个本地 HTTP 测试服务。新增 `generateTextForConfigId` 测试：A 明确失败、B 健康时，调用 A 只能访问 A 一次且 B 的请求计数保持 0；配置不存在、停用或服务类型不是文本均本地拒绝。

```js
await assert.rejects(
  () => aiClient.generateTextForConfigId(db, log, configAId, 'canary', 'reply ok', {
    max_tokens: 16,
  }),
  /HTTP 503/,
);
assert.equal(serverARequests.length, 1);
assert.equal(serverBRequests.length, 0);
```

### 步骤 2：实现无容灾文本入口

`aiClient.js` 新增并导出：

```js
async function generateTextForConfigId(db, log, configId, userPrompt, systemPrompt, options = {}) {
  const config = aiConfigService.getConfig(db, configId);
  if (!config || !config.is_active || config.service_type !== 'text') {
    throw new Error('指定的文本模型配置不存在、已停用或类型不匹配');
  }
  return generateTextSingleConfig(db, log, 'text', userPrompt, systemPrompt, {
    ...options,
    _routeConfig: config,
    _safeRoute: true,
  });
}
```

保留现有并发限制包装；不得公开 `_routeConfig` 给 HTTP 客户端。

### 步骤 3：写执行器失败测试

通过依赖注入模拟三类客户端，断言：

- `callImageApi`、`callVideoApi` 都收到唯一 `config_id`；
- 视频返回任务号后只轮询，不重新提交；
- 轮询超时、HTTP 2xx 无可解析产物、下载中断分别进入 `result_unknown` 或 `artifact_unreadable`；
- 明确 4xx 未受理进入 `failed`；
- 一次运行的 submit 计数始终为 1；
- 成功后写证据和隔离产物，失败/未知不写 fresh 证据；
- 数据库所有用户表和积分表行数前后相同；
- 供应商原始错误、URL、Key、提示词不进入 `safe_error_summary`。

### 步骤 4：实现执行器

`providerCanaryExecutor.js` 导出：

```js
buildCanaryRequest(db, config, capability, fixtures)
estimateCanaryCost(db, config, capability)
executeCanaryRun(db, log, run, options)
```

执行顺序固定为：

1. 校验运行仍为 `reserved` 且同供应商没有未解决未知记录；
2. 更新 `submitting`；
3. 仅调用指定配置；
4. 若取得任务号，更新 `accepted` 后只轮询；
5. 得到远端结果后进入 `verifying` 并落入隔离目录；
6. 可读产物或非空文本通过后结算成功并写 fresh 证据；
7. 明确未受理结算失败；
8. 其他不确定结果保留预算占用、写未知证据和管理员事件，并停止同 `provider_scope_key` 后续付费巡检。

巡检提示词使用固定无人物安全内容，例如“生成一个蓝色圆形位于白色背景中央”；文本只要求返回固定短词。提示词常量不包含用户数据且不写数据库。

### 步骤 5：验证

```powershell
cd backend-node
node --test test/providerCanaryTextConfig.test.js test/providerCanaryExecutor.test.js test/openAIImageOutput.test.js test/providerRouteImageIntegration.test.js test/providerRouteVideoIntegration.test.js test/providerRouteTextIntegration.test.js
node --check src/services/aiClient.js
node --check src/services/providerCanaryExecutor.js
```

### 步骤 6：提交

```powershell
git add backend-node/src/services/aiClient.js backend-node/src/services/providerCanaryExecutor.js backend-node/test/providerCanaryTextConfig.test.js backend-node/test/providerCanaryExecutor.test.js
git commit -m "feat(稳定性): 增加指定线路单次巡检"
```

---

## 任务 7：实现五分钟零成本检查和 48 小时轮转调度

**文件：**

- 新增：`backend-node/src/services/providerCanarySchedulerService.js`
- 修改：`backend-node/src/app.js`
- 新增：`backend-node/test/providerCanaryScheduler.test.js`
- 新增：`backend-node/test/appBackgroundServices.test.js`

### 步骤 1：写调度失败测试

使用假时钟、假定时器和注入执行器验证：

- 默认 `off` 不启动；
- `shadow` 每 5 分钟执行 DB、存储、任务/积分对账和供应商只读检查，但不付费、不隐藏目录；
- `PROVIDER_CANARY_PAID_ENABLED=false` 时绝不调用执行器；
- 付费启用后每个 tick 最多启动一个运行，全局并发为 1；
- 排序为过期最早、用户影响、优先级、最低成本；
- 同供应商存在未知运行时该供应商所有配置跳过；
- 预算不足、成本缺失和巡检暂停产生 P3 事件，不提交；
- 过期线路写 stale，但零成本健康不会刷新 fresh；
- `stopBackgroundServices` 清理调度器和现有对账器。

### 步骤 2：实现模式与定时器

模式合同：

```text
PROVIDER_CANARY_MODE=off|shadow|enforce
PROVIDER_CANARY_PAID_ENABLED=false|true
```

默认 `off`；非法值回退 `off` 并写错误日志。`shadow` 计算并展示 `would_be_hidden`，但不影响用户目录；`enforce` 才实际过滤。

`providerCanarySchedulerService.js` 导出：

```js
runZeroCostSweep(db, log, options)
enumerateCapabilityProfiles(config)
selectDueProfiles(db, options)
runOnePaidCanary(db, log, options)
startProviderCanaryScheduler(db, log, options)
stopProviderCanaryScheduler()
```

能力档案对分辨率、比例、时长和同步音频做确定性组合；参考图/视频/音频使用声明上限。证据覆盖关系允许已验证上限覆盖较小引用数，但不允许跨分辨率、比例、时长或音频模式推断。

零成本检查固定覆盖应用健康 URL、数据库 `SELECT 1`/quick check、存储目录可写与剩余空间、活动/未知/对账任务增长、积分预占一致性、逻辑模型与价格/成本/能力映射、供应商 DNS/TLS/鉴权/只读接口。不得调用生成端点、不得调用 `recordSuccess`。事件按 `event_type + logical_model_id + config_id + category` 在一个检查窗口内去重。

### 步骤 3：接入应用生命周期

`app.js` 在迁移和孤儿任务处理后启动调度器，与现有对账器共用 `stopBackgroundServices`：

```js
providerCanary.startProviderCanaryScheduler(db, log, {
  mode: process.env.PROVIDER_CANARY_MODE,
  paidEnabled: process.env.PROVIDER_CANARY_PAID_ENABLED,
  intervalMs: 300_000,
  storageRoot,
});
```

当前 `storageRoot` 解析位于后台服务启动之后；实施时只把现有同一段绝对路径解析前移到迁移完成后，并让调度器和 `/static` 挂载复用同一变量，不复制第二套路径规则。

调度 timer 必须 `unref()`；测试或进程停止可完全清理。

### 步骤 4：验证

```powershell
cd backend-node
node --test test/providerCanaryScheduler.test.js test/appBackgroundServices.test.js test/providerReconciliation.test.js
node --check src/services/providerCanarySchedulerService.js
node --check src/app.js
```

### 步骤 5：提交

```powershell
git add backend-node/src/services/providerCanarySchedulerService.js backend-node/src/app.js backend-node/test/providerCanaryScheduler.test.js backend-node/test/appBackgroundServices.test.js
git commit -m "feat(稳定性): 调度主动巡检与零成本检查"
```

---

## 任务 8：使配置、成本和运行代码变化精准失效

**文件：**

- 修改：`backend-node/src/services/aiConfigService.js`
- 修改：`backend-node/src/services/modelPriceService.js`
- 修改：`backend-node/test/aiConfigPublicView.test.js`
- 新增：`backend-node/test/providerCanaryInvalidation.test.js`

### 步骤 1：先写精准失效失败测试

建立两个逻辑模型、四条线路和多项能力证据，验证：

- A 的 Key、Base URL、协议、模型、能力、优先级对应能力变化只失效 A；
- 仅改名称或备注不失效；
- A 逻辑模型的成本、分辨率成本或价格状态改变，失效 A 的全部线路，不影响 B；
- `admin_paused=true` 立即置 disabled；恢复只变为 `never_verified`，不能直接 fresh；
- 运行代码指纹变化即使未改数据库，也使对应服务证据有效态为 stale；
- 老 `verification_status='verified'` 不能替代新的可读产物证据。

### 步骤 2：实现失效钩子

`aiConfigService.updateConfig` 在现有 `connectivityChanged` 基础上比较能力与路由字段；事务成功后调用 `invalidateConfig`。管理员恢复只清暂停，不写 fresh。

`modelPriceService.set` 保存前后做稳定成本快照比较；有实质变化时调用 `invalidateLogicalModel`。为避免循环依赖，使用函数内部惰性 `require('./providerCanaryEvidenceService')`，且无迁移表时安全跳过，兼容旧数据库升级过程。

### 步骤 3：验证

```powershell
cd backend-node
node --test test/providerCanaryInvalidation.test.js test/aiConfigPublicView.test.js test/providerRouteStability.test.js test/modelPrice.test.js test/videoBilling.test.js
node --check src/services/aiConfigService.js
node --check src/services/modelPriceService.js
```

### 步骤 4：提交

```powershell
git add backend-node/src/services/aiConfigService.js backend-node/src/services/modelPriceService.js backend-node/test/aiConfigPublicView.test.js backend-node/test/providerCanaryInvalidation.test.js
git commit -m "fix(稳定性): 精准失效受影响线路证据"
```

---

## 任务 9：把新鲜能力证据接入容灾候选和用户模型目录

**文件：**

- 修改：`backend-node/src/services/providerRouteStabilityService.js`
- 修改：`backend-node/src/services/canvasModelCatalogService.js`
- 修改：`backend-node/test/providerRouteStability.test.js`
- 修改：`backend-node/test/canvasModelCatalogService.test.js`
- 修改：`backend-node/test/aiConfigPublicView.test.js`
- 新增：`backend-node/test/providerCanaryPublicGate.test.js`

### 步骤 1：先写公开门禁失败测试

同一逻辑模型创建：fresh 主线、fresh 同能力备线、stale 高优先级线、未知线、能力不足线和健康熔断线。验证：

```js
const selected = stability.selectVerifiedCandidates(db, {
  serviceType: 'video',
  logicalModelId: 'seedance-logical',
  capabilities: {
    resolution: '720p', aspectRatio: '16:9', duration: 15,
    referenceImageCount: 2, referenceVideoCount: 1,
    referenceAudioCount: 1, requiresAudio: true,
  },
  canaryMode: 'enforce',
  now: '2026-08-18T00:00:00.000Z',
});
assert.deepEqual(selected.candidates.map((row) => row.name), ['fresh-primary', 'fresh-backup']);
```

另验证：

- `shadow` 保持现有候选，但为管理员附加 `would_be_hidden`，用户响应不附加；
- 全部线路不满足时逻辑模型从公开目录消失并写 P1；
- 公开 capability 只保留 fresh 证据覆盖的分辨率、比例、时长和引用上限；
- 公共目录序列化不含 `provider`、`relay_host`、`base_url`、`config_id`、`cost`、`evidence_run_id`。

### 步骤 2：实现候选证据门禁

`selectVerifiedCandidates` 保留现有价格、逻辑模型、健康、半开和能力匹配，再在 `enforce` 中调用 `listFreshCoveringEvidence`。不能用旧 `verified_at` 兜底。

调用方未显式传入 `canaryMode` 时，候选服务和目录服务必须统一读取经过校验的 `PROVIDER_CANARY_MODE`；不能因为现有图片、视频或文本调用方没有新增参数而绕过严格门禁。

`canvasModelCatalogService.list` 按 fresh 证据并集生成安全能力包络：引用上限取能够覆盖的最大值；分辨率、比例、时长只取真实证据出现值。没有任何公开线路的逻辑模型不返回。

事件仅在状态从可公开变为全部不可公开时写一次 P1，避免每次目录请求重复写事件。

### 步骤 3：验证

```powershell
cd backend-node
node --test test/providerCanaryPublicGate.test.js test/providerRouteStability.test.js test/canvasModelCatalogService.test.js test/aiConfigPublicView.test.js test/providerRouteImageIntegration.test.js test/providerRouteVideoIntegration.test.js test/providerRouteTextIntegration.test.js
```

### 步骤 4：提交

```powershell
git add backend-node/src/services/providerRouteStabilityService.js backend-node/src/services/canvasModelCatalogService.js backend-node/test/providerRouteStability.test.js backend-node/test/canvasModelCatalogService.test.js backend-node/test/aiConfigPublicView.test.js backend-node/test/providerCanaryPublicGate.test.js
git commit -m "feat(稳定性): 用新鲜证据保护用户目录"
```

---

## 任务 10：扩展管理员巡检、预算、运行与对账 API

**文件：**

- 修改：`backend-node/src/services/providerRouteStabilityService.js`
- 修改：`backend-node/src/routes/providerStability.js`
- 修改：`backend-node/src/routes/index.js`
- 修改：`backend-node/test/providerRouteAdminRoutes.test.js`
- 新增：`backend-node/test/providerCanaryAdminRoutes.test.js`

### 步骤 1：先写 RBAC 与脱敏失败测试

新增端点：

```text
GET  /api/v1/admin/provider-stability/canary/summary
GET  /api/v1/admin/provider-stability/canary/runs
POST /api/v1/admin/provider-stability/canary/runs/:runId/reconcile
PATCH /api/v1/admin/provider-stability/routes/:configId
```

验证未登录 401、普通用户 403、管理员 200；返回预算、证据、检查状态、运行状态和安全错误，但不含 Key、完整 Base URL、签名 URL、原提示词、完整供应商响应或 Authorization。

`reconcile` 不接受客户端提交成功状态或产物 URL：有任何 body 字段都返回 400；它只能根据已保存任务号调用一次只读查询。仍未知时保持未知且不重提；明确成功且产物可读才恢复 fresh。

### 步骤 2：实现管理员安全 DTO

线路摘要新增：

```text
canary_paused
public_state
would_be_hidden
latest_zero_cost_check
latest_real_success_at
evidence_expires_at
evidence_state
budget_block_reason
```

预算摘要新增当日/月上限、已占用、剩余和未知占用。运行列表只返回内部运行 ID、逻辑模型、脱敏线路名、能力、状态、成本、时间、错误分类和是否可对账。

PATCH 允许 `canary_paused`，但管理员恢复只能等待新巡检，不得直接改证据为 fresh。所有修改和对账写 `audit_events`。

### 步骤 3：告警等级

在现有事件服务中固定：

- P0：跨模型核心中断、重复扣费、跨租户、数据库/存储不可用；
- P1：单逻辑模型全部线路不可用、未知增长、核心链路中断；
- P2：单线路熔断、切换成功、证据失败；
- P3：即将过期、预算接近上限、成本缺失、自动恢复。

数据库继续使用现有 `critical/error/warning/info` 严重度，管理员 DTO 新增确定性的 `alert_level` 映射为 P0-P3；不在同一列混存两套枚举。

项目当前没有可复用的企业微信发送实现，因此本任务只复用管理员事件表，不新建第二套外部通知系统。若执行阶段发现线上已有独立企业微信通道，只通过其既有接口转发 P0/P1，不在本 PR 新增凭证或 Webhook。

### 步骤 4：验证

```powershell
cd backend-node
node --test test/providerRouteAdminRoutes.test.js test/providerCanaryAdminRoutes.test.js test/aiConfigPublicView.test.js
```

### 步骤 5：提交

```powershell
git add backend-node/src/services/providerRouteStabilityService.js backend-node/src/routes/providerStability.js backend-node/src/routes/index.js backend-node/test/providerRouteAdminRoutes.test.js backend-node/test/providerCanaryAdminRoutes.test.js
git commit -m "feat(管理端): 展示巡检证据与预算"
```

---

## 任务 11：扩展管理员稳定性面板

**文件：**

- 修改：`frontweb/src/api/providerStability.js`
- 修改：`frontweb/src/components/ProviderStabilityPanel.vue`
- 修改：`frontweb/test/providerStabilityAdmin.test.js`
- 修改：`frontweb/e2e/provider-stability-admin.spec.js`

### 步骤 1：先写前端失败测试

静态合同测试要求出现：

```text
用户目录状态
最近零成本检查
最近真实成功
证据过期时间
今日巡检预算
本月巡检预算
结果未知
对账
巡检暂停
P0
P1
P2
P3
```

并继续拒绝 `api_key`、完整 `base_url`、签名 URL、提示词全文、Authorization 和用户生成页挂载稳定性面板。

Playwright 使用本地 mock API 验证：预算卡、过期标签、未知运行置顶、对账按钮、暂停确认、错误 toast 和窄屏可滚动；普通用户路由不可进入管理页。

### 步骤 2：实现 UI

`providerStabilityAPI` 新增 `getCanarySummary`、`listCanaryRuns`、`reconcileCanaryRun`。面板保持供应商和中转关联仅管理员可见，新增：

- 日/月预算卡；
- 线路公开状态和证据倒计时；
- 零成本检查状态；
- 未知运行列表与只读对账按钮；
- 独立巡检暂停开关；
- P0-P3 标签与安全摘要。

不在普通画布、短剧工厂或剧本分析页面增加供应商字段。

### 步骤 3：验证

```powershell
cd frontweb
node --test test/providerStabilityAdmin.test.js
npx playwright test e2e/provider-stability-admin.spec.js
npm run build
```

### 步骤 4：提交

```powershell
git add frontweb/src/api/providerStability.js frontweb/src/components/ProviderStabilityPanel.vue frontweb/test/providerStabilityAdmin.test.js frontweb/e2e/provider-stability-admin.spec.js
git commit -m "feat(管理端): 完善稳定性巡检面板"
```

---

## 任务 12：建立每五分钟无付费生产浏览器冒烟

**文件：**

- 新增：`frontweb/e2e/platform-zero-cost-smoke.spec.js`
- 新增：`frontweb/scripts/run-platform-zero-cost-smoke.mjs`
- 新增：`.github/workflows/platform-zero-cost-smoke.yml`
- 新增：`frontweb/test/platformZeroCostSmokeContract.test.js`

### 步骤 1：先写“绝不生成”合同测试

合同测试读取脚本和 workflow，要求：

- cron 为 `*/5 * * * *`；
- workflow 有 `concurrency` 且不允许重叠运行；
- 脚本只访问首页、登录、画布、短剧工厂、剧本分析和公开模型目录；
- 监听所有请求，任何命中图片、视频、文本生成、充值或付费端点的非 GET 请求立即失败；
- 不包含供应商 Key、生产密码或硬编码 Cookie；凭证只来自 GitHub Encrypted Secrets。

### 步骤 2：实现浏览器冒烟

Playwright 用专用零余额监控用户登录，依次验证：

- 首页和顶栏可见；
- 画布入口可打开并加载模型目录；
- 短剧工厂入口可打开到首屏；
- 剧本分析入口可打开到首屏；
- 页面无 500、白屏、未捕获异常；
- 全程没有生成 POST、积分预占或资产写入。

运行脚本要求 `PLATFORM_SMOKE_BASE_URL`、`PLATFORM_SMOKE_EMAIL`、`PLATFORM_SMOKE_PASSWORD`；缺失时明确失败，不使用默认生产账号。workflow 只保存脱敏截图和 Playwright trace，保留 7 天。

### 步骤 3：本地验证

```powershell
cd frontweb
node --test test/platformZeroCostSmokeContract.test.js
$env:PLATFORM_SMOKE_BASE_URL='http://127.0.0.1:4173'
$env:PLATFORM_SMOKE_EMAIL='monitor@example.test'
$env:PLATFORM_SMOKE_PASSWORD='local-test-only'
node scripts/run-platform-zero-cost-smoke.mjs --local-fixture
```

预期：合同测试通过；本地 fixture 冒烟通过且生成请求计数为 0。不得在本地规划阶段访问生产。

### 步骤 4：提交

```powershell
git add frontweb/e2e/platform-zero-cost-smoke.spec.js frontweb/scripts/run-platform-zero-cost-smoke.mjs frontweb/test/platformZeroCostSmokeContract.test.js .github/workflows/platform-zero-cost-smoke.yml
git commit -m "test(稳定性): 增加无付费生产冒烟"
```

---

## 任务 13：更新功能锁、发布范围和同批次验证证据

**文件：**

- 修改：`docs/verification/platform-stability/feature-lock-manifest.json`
- 新增：`docs/verification/platform-stability/proactive-canary-verification.md`
- 新增：`deploy/release-scopes/platform-stability-proactive-canary.json`
- 修改：`backend-node/test/featureLockManifest.test.js`
- 修改：`backend-node/test/incrementalReleaseScope.test.js`

### 步骤 1：先更新锁测试

新增锁 `stability.proactive-canary-and-public-evidence`，验收项固定为：

```text
公开线路只有匹配的新鲜真实证据才能进入严格候选
巡检预算日月原子受限且未知结果保留占用
巡检不污染用户资产、生成记录和积分
管理员可见线路证据预算，普通用户不泄露供应商与成本
```

将本计划触及的现有锁写入本次经过产品负责人批准的 `unlock`，原因固定为“2026-08-18 主动巡检书面规格获批，实施阶段 0+1”；不得删除历史 evidence。新锁的 protected paths 和 required tests 必须覆盖任务 2 到 12 的所有核心文件。

### 步骤 2：建立精确发布 allowlist

`platform-stability-proactive-canary.json` 只允许本计划实际修改/新增的文件；不包含数据库文件、用户资产目录、AI 音乐、无关前端、旧 release scope 或共享门禁文件。

### 步骤 3：运行完整验证

后端：

```powershell
cd backend-node
npm test
npm run audit:feature-lock -- --base origin/main
node --test test/incrementalReleaseScope.test.js
npm run preflight:production
```

前端：

```powershell
cd frontweb
node --test test/*.test.js
npm run build
npx playwright test e2e/provider-stability-admin.spec.js e2e/platform-zero-cost-smoke.spec.js
```

安全与变更范围：

```powershell
git diff --check origin/main...HEAD
git diff --name-only origin/main...HEAD
rg -n "sk-[A-Za-z0-9]{12,}|Authorization:\s*Bearer|provider_asset_signature=.*[^\s]" docs backend-node frontweb deploy
```

预期：所有测试、构建和审计退出码为 0；敏感信息扫描只允许测试中的显式假值，逐项记录豁免位置；改动文件全部在新 allowlist 内。

### 步骤 4：填写同一候选证据

`proactive-canary-verification.md` 记录：

- 基线提交、候选提交和测试时间；
- 每条命令、退出码和测试数；
- 预算、未知、证据过期、公开过滤和泄漏回归；
- 本地 fixture 浏览器证据；
- 明确标记未执行的真实供应商、Hosted CI、生产 shadow、付费巡检和 enforce 门禁。

未执行项必须标为 `blocked/not authorized`，不能写“通过”。

### 步骤 5：提交

```powershell
git add docs/verification/platform-stability/feature-lock-manifest.json docs/verification/platform-stability/proactive-canary-verification.md deploy/release-scopes/platform-stability-proactive-canary.json backend-node/test/featureLockManifest.test.js backend-node/test/incrementalReleaseScope.test.js
git commit -m "test(稳定性): 锁定主动巡检合同"
```

---

## 任务 14：受保护的三步生产启用

本任务不在获得独立生产授权前执行。三个步骤不可合并，每一步都要重新读取线上、部署锁和其他会话状态。

### 步骤 A：shadow 发布，不付费、不隐藏

1. SSH 只读获取实时 `/opt/moli-drama/current`、`deploy.lock`、活动任务、服务状态、磁盘、数据库 quick check 和 AI 音乐 PID。
2. 从实时 current 克隆候选，不从本地工作树覆盖；只复制 `platform-stability-proactive-canary.json` allowlist 文件。
3. 备份 `/opt/moli-drama/shared/data/drama_generator.db` 并验证 SHA-256 和 quick check。
4. 候选安装依赖、迁移副本、构建、全量测试、功能锁、增量范围和无敏感信息审计。
   增量范围审计必须使用真实父版本、候选、清单和 current CAS 参数：

   ```bash
   node CANDIDATE/backend-node/scripts/verify-incremental-release-scope.js \
     --parent EXPECTED_CURRENT \
     --candidate CANDIDATE \
     --manifest CANDIDATE/deploy/release-scopes/platform-stability-proactive-canary.json \
     --expected-current EXPECTED_CURRENT \
     --current-link /opt/moli-drama/current
   ```

5. 生产配置只启用：

   ```text
   PROVIDER_CANARY_MODE=shadow
   PROVIDER_CANARY_PAID_ENABLED=false
   ```

6. 只使用：

   ```bash
   sudo /opt/moli-drama/shared/release-guard/activate-protected-release.sh CANDIDATE EXPECTED_CURRENT
   ```

7. 回读健康、日志、管理员 shadow 状态、公开模型目录不变、五分钟零成本检查、AI 音乐 PID 不变。

任一失败立即通过受保护流程回滚，不在故障线上继续覆盖。

### 步骤 B：受控付费巡检

只有在用户再次明确批准生产付费激活后：

1. 先回读预算为 0、没有未知运行、没有 P0/P1、内部成本全部为正且人民币明确。
2. 设置 `PROVIDER_CANARY_PAID_ENABLED=true`，硬上限仍为每日 20 元、每月 600 元。
3. 调度器每次只提交一个；每个运行提交一次。
4. 任一 `submission_unknown`、`result_unknown` 或 `artifact_unreadable` 立即停止同供应商后续付费巡检，不自动重试。
5. 每次成功核对终态、隔离产物可读、SHA-256、实际/保守成本和证据过期时间。
6. 所有当前拟公开能力取得新鲜证据前，不进入 enforce。

### 步骤 C：严格公开门禁

只有以下条件全部满足后，另行授权设置 `PROVIDER_CANARY_MODE=enforce`：

- 公开清单准备度 100%；
- 每个公开主备线路和能力档案有 48 小时内 fresh 证据；
- 无 P0/P1、未知运行、不可读产物、成本缺失或预算超限；
- 管理端和普通用户泄漏回归通过；
- 画布、短剧工厂、剧本分析无付费冒烟通过；
- 活动任务、数据库、磁盘、日志和 AI 音乐隔离通过。

严格门禁激活后，过期能力按合同自动隐藏；不回退到未验证线路、不同模型或更弱能力。若模型被隐藏，只向用户显示通用“当前模型暂不可用”，管理员端保留精确线路原因。

### 步骤 D：生产证据与下一阶段入口

同一生产候选、同一批次保留：

- current release、候选 release、数据库备份、门禁输出；
- shadow、付费巡检和 enforce 时间线；
- 每条公开能力的 fresh 证据摘要；
- 预算使用、未知任务为零、P0/P1 为零；
- 管理端、用户目录和无付费浏览器截图；
- AI 音乐 PID 与健康未变。

全部通过后才创建阶段 2《画布一次性验收与锁定实现计划》。不得直接把本计划扩展为画布修复。

---

## 15. 规格覆盖矩阵

| 已批准规格 | 实施任务 | 主要证据 |
| --- | --- | --- |
| 当前公开线路、能力、价格、成本与锁基线 | 任务 1、1B | 两份机器清单及校验测试 |
| 五分钟零成本检查且不刷新真实证据 | 任务 3、7、12 | 证据生命周期、调度和无付费浏览器测试 |
| 新线路、配置/成本/代码变化和 48 小时轮转 | 任务 3、7、8 | 指纹、精准失效、到期调度测试 |
| 日 20 元/月 600 元原子预算 | 任务 4 | SQLite immediate 事务、边界和未知占用测试 |
| 巡检账户、资产和用户积分隔离 | 任务 5、6 | 隔离路径、用户表行数、积分不变测试 |
| 单次提交、未知停止、不自动重试 | 任务 4、6、7 | submit 次数、未知状态和供应商范围阻断测试 |
| 同模型同能力、fresh 且健康才可切换 | 任务 3、9 | 能力覆盖、候选池和集成回归 |
| 过期/失败/未知/预算阻断自动隐藏 | 任务 3、9 | enforce 公开门禁测试 |
| 管理员看线路/证据/预算，用户不泄漏 | 任务 9、10、11 | RBAC、安全 DTO、前后端泄漏测试 |
| P0-P3、去重、恢复和审计 | 任务 7、10、11 | 事件与管理员面板测试 |
| 三板块按固定顺序一次性验收 | 任务 1B、任务 14D | 阶段 0 基线；阶段 2-4 各自计划入口 |
| 同一候选证据、功能锁和受保护发布 | 任务 13、14 | 全量门禁、allowlist、CAS 激活和生产回读 |

阶段 2-5 的真实逐功能验证没有被本计划判定为通过；矩阵只证明本计划为其建立基线和先决控制面。

---

## 16. 计划自检清单

- [ ] 每项规格要求都有对应任务和测试；阶段 2-5 明确拆分，没有混入本 PR。
- [ ] 没有使用连接测试、模型列表或旧验证状态冒充真实能力证据。
- [ ] 预算、证据、运行、未知和隔离资产的数据类型在迁移、服务、API 和 UI 中一致。
- [ ] `shadow`、付费激活和 `enforce` 是三个独立授权门禁。
- [ ] 所有运行客户端按 `config_id` 直达，不经过容灾，也没有自动重试。
- [ ] 公开目录和用户错误不存在供应商、配置、域名、成本或内部任务字段。
- [ ] 功能锁和 allowlist 覆盖每个实际改动文件，没有允许宽目录。
- [ ] 计划中没有生产 Key、密码、Cookie、Host、签名 URL 或用户提示词。
- [ ] 发布从实时 current 制作、CAS 激活、可回滚并隔离 AI 音乐。
- [ ] 未获得付费/生产授权前，所有真实供应商和生产步骤保持未执行。
