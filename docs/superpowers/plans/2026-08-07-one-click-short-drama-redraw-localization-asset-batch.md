# 一键短剧转绘真实本地化与资产批量生成实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将源片分析后的第二次确认改造成真实、可计费、可恢复的英文本地化任务，并在目标版本资产页提供服务端总价确认、幂等批量生成、逐项结算和失败项重试。

**架构：** 保留 `redraw_works.task_id` 作为源片分析证据，以隐藏的 `draft` 目标版本承载独立本地化任务；任务成功后才原子物化镜头和资产并推进到第 2 步。资产批次使用父批次记录聚合进度，每项资产继续使用现有生成任务和积分冻结记录；路由只接受目标参数、报价哈希和幂等键，模型、供应商和积分全部由服务端已验证能力解析。

**技术栈：** Node.js 20、Express、better-sqlite3、`node:test`、Vue 3、Element Plus、Vite、Playwright、现有 `aiClient` / `imageClient` / `ttsService` / 积分账本。

---

## 文件结构与职责

### 新建

- `backend-node/migrations/52_redraw_localization_asset_batches.sql`：本地化任务字段、幂等索引和资产批次表。
- `backend-node/src/services/redrawLocalizationOrchestrator.js`：本地化报价、冻结、任务派发、结果物化、结算和未知状态恢复。
- `backend-node/src/services/redrawAssetBatchService.js`：资产批量报价、原子冻结、父子任务、聚合进度和失败项重试。
- `backend-node/src/services/redrawProviderAdapters.js`：把已验证能力快照接到现有文本、图片和 TTS 客户端；不负责计费。
- `backend-node/test/redrawLocalizationOrchestration.test.js`：真实本地化编排合同测试。
- `backend-node/test/redrawAssetBatch.test.js`：资产批次、部分失败、退款和幂等测试。
- `backend-node/test/redrawProviderAdapters.test.js`：供应商适配器的配置选择、产物登记和能力阻断测试。

### 修改

- `backend-node/src/db/migrate.js`：旧数据库兜底补列和批次表创建。
- `backend-node/src/services/redrawCapabilityService.js`：六类完整能力和内部已验证能力解析器。
- `backend-node/src/services/localizationService.js`：拆分隐藏草稿创建与成功物化，补齐音色草稿和镜头引用。
- `backend-node/src/services/redrawAssetService.js`：支持批次预创建的尝试、统一失败结算、语音和净景产物字段。
- `backend-node/src/services/taskService.js`：启动恢复时保护供应商终态未知的本地化/资产任务，不误退款重提。
- `backend-node/src/routes/redraw.js`：本地化报价、收紧创建版本、批量资产接口和工作流投影。
- `backend-node/src/routes/index.js`：注册新接口并注入真实适配器。
- `backend-node/src/app.js`：在通用孤儿任务清理前执行转绘本地化/资产恢复。
- `backend-node/test/redrawMigration.test.js`：迁移和唯一索引断言。
- `backend-node/test/redrawCapabilities.test.js`：图像能力阻断和内部解析断言。
- `backend-node/test/redrawLocalization.test.js`：隐藏草稿、原子提升和音色草稿断言。
- `backend-node/test/redrawAssets.test.js`：批次尝试、语音/净景字段和统一失败结算断言。
- `backend-node/test/redrawRoutes.test.js`：接口防篡改、租户隔离、工作流投影和错误码。
- `frontweb/src/api/redraw.js`：本地化与资产批次 API。
- `frontweb/src/utils/redrawWorkspaceState.js`：分析确认、本地化报价和任务状态派生。
- `frontweb/src/utils/redrawAssetState.js`：批量报价、按钮门禁和部分失败状态派生。
- `frontweb/src/components/redraw/RedrawSourceStep.vue`：分析结果确认和本地化任务进度。
- `frontweb/src/components/redraw/RedrawAssetStep.vue`：总价确认、批次进度和失败项重试。
- `frontweb/test/redrawSourceRuntime.test.js`：本地化交互运行时测试。
- `frontweb/test/redrawFoundation.test.js`：API 与组件静态合同。
- `frontweb/test/redrawAssets.test.js`：资产批量 UI 合同。
- `frontweb/e2e/redraw-workspace.spec.js`：从分析确认到资产部分失败重试的浏览器闭环。
- `docs/superpowers/reports/2026-08-07-one-click-short-drama-redraw-phase-3-gate.md`：记录自动化与真实供应商证据边界。

## 任务 1：持久化本地化任务与资产批次

**文件：**

- 创建：`backend-node/migrations/52_redraw_localization_asset_batches.sql`
- 修改：`backend-node/src/db/migrate.js`
- 修改：`backend-node/test/redrawMigration.test.js`

- [ ] **步骤 1：编写失败的迁移测试**

在 `backend-node/test/redrawMigration.test.js` 增加：

```js
test('转绘本地化任务与资产批次迁移可重复执行并保留幂等唯一约束', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  runMigrationsAndEnsure(db);

  const versionColumns = new Set(
    db.prepare('PRAGMA table_info(redraw_versions)').all().map((row) => row.name),
  );
  assert.equal(versionColumns.has('localization_task_id'), true);
  assert.equal(versionColumns.has('localization_credit_reservation_id'), true);
  assert.equal(versionColumns.has('localization_input_hash'), true);
  assert.equal(versionColumns.has('localization_idempotency_key'), true);
  assert.equal(versionColumns.has('localization_model_snapshot_json'), true);

  const batchColumns = new Set(
    db.prepare('PRAGMA table_info(redraw_asset_batches)').all().map((row) => row.name),
  );
  for (const name of ['version_id', 'tenant_id', 'user_id', 'task_id', 'idempotency_key',
    'quote_snapshot_json', 'asset_ids_json', 'status', 'total_count', 'success_count',
    'failed_count', 'created_at', 'updated_at', 'completed_at']) {
    assert.equal(batchColumns.has(name), true, name);
  }

  const indexes = db.prepare("PRAGMA index_list('redraw_versions')").all();
  assert.equal(indexes.some((row) => row.name === 'uq_redraw_localization_idempotency'), true);
  db.close();
});
```

- [ ] **步骤 2：运行迁移测试并确认失败**

运行：

```powershell
cd backend-node
node --test test/redrawMigration.test.js
```

预期：FAIL，缺少 `localization_task_id` 或 `redraw_asset_batches`。

- [ ] **步骤 3：增加 SQL 迁移**

创建 `backend-node/migrations/52_redraw_localization_asset_batches.sql`：

```sql
ALTER TABLE redraw_versions ADD COLUMN localization_task_id TEXT;
ALTER TABLE redraw_versions ADD COLUMN localization_credit_reservation_id TEXT;
ALTER TABLE redraw_versions ADD COLUMN localization_input_hash TEXT;
ALTER TABLE redraw_versions ADD COLUMN localization_idempotency_key TEXT;
ALTER TABLE redraw_versions ADD COLUMN localization_model_snapshot_json TEXT NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX IF NOT EXISTS uq_redraw_localization_idempotency
  ON redraw_versions(tenant_id, user_id, work_id, localization_idempotency_key)
  WHERE localization_idempotency_key IS NOT NULL
    AND TRIM(localization_idempotency_key) <> ''
    AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS redraw_asset_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  quote_snapshot_json TEXT NOT NULL DEFAULT '{}',
  asset_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'partial_failed', 'failed', 'needs_attention')),
  total_count INTEGER NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  success_count INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  deleted_at TEXT,
  FOREIGN KEY(version_id) REFERENCES redraw_versions(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_redraw_asset_batch_idempotency
  ON redraw_asset_batches(tenant_id, user_id, version_id, idempotency_key)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_redraw_asset_batch_version
  ON redraw_asset_batches(version_id, status, updated_at DESC);
```

- [ ] **步骤 4：补充旧库兜底建表与补列**

在 `backend-node/src/db/migrate.js` 的 `redraw_versions` `ensureColumns` 数组加入五个字段，并在转绘表兜底区执行与迁移一致的 `CREATE TABLE/INDEX IF NOT EXISTS`。字段名和默认值必须与迁移完全一致，避免测试库与升级库发生漂移。

- [ ] **步骤 5：运行迁移测试并确认通过**

运行：

```powershell
cd backend-node
node --test test/redrawMigration.test.js
```

预期：PASS，且第二次迁移没有重复列异常。

- [ ] **步骤 6：提交**

```powershell
git add backend-node/migrations/52_redraw_localization_asset_batches.sql backend-node/src/db/migrate.js backend-node/test/redrawMigration.test.js
git commit -m "feat: 增加转绘本地化与资产批次持久化"
```

## 任务 2：收紧完整输出能力解析

**文件：**

- 修改：`backend-node/src/services/redrawCapabilityService.js`
- 修改：`backend-node/test/redrawCapabilities.test.js`

- [ ] **步骤 1：编写失败的六能力测试**

在 `backend-node/test/redrawCapabilities.test.js` 增加 `character_image` 和 `clean_plate_image` 证据，并增加：

```js
test('完整输出必须具备文本、字幕、角色图、净景图、TTS 和视频六类真实能力', () => {
  assert.equal(summarizeLocaleCapability({
    text: true,
    subtitles: true,
    character_image: true,
    clean_plate_image: true,
    tts: true,
    video: true,
  }), 'full_output');
  assert.equal(summarizeLocaleCapability({
    text: true,
    subtitles: true,
    character_image: false,
    clean_plate_image: true,
    tts: true,
    video: true,
  }), 'asset_pending');
});

test('内部能力解析只返回语言市场精确匹配且产物可读的证据', () => {
  const db = createDb();
  insertConfig(db, [{
    locale: 'en-US',
    market: 'US',
    status: 'verified',
    evidence: { text: validEvidence(31) },
  }]);
  const capability = resolveVerifiedLocaleCapability(db, {
    locale: 'en-US',
    market: 'US',
    capability: 'text',
    canReadArtifact: (id) => id === 31,
  });
  assert.equal(capability.provider, 'provider-a');
  assert.equal(capability.model, 'model-a');
  assert.equal(resolveVerifiedLocaleCapability(db, {
    locale: 'en-GB',
    market: 'GB',
    capability: 'text',
    canReadArtifact: () => true,
  }), null);
  db.close();
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```powershell
cd backend-node
node --test test/redrawCapabilities.test.js
```

预期：FAIL，`asset_pending` 或 `resolveVerifiedLocaleCapability` 尚不存在。

- [ ] **步骤 3：实现六能力摘要和内部解析器**

在 `backend-node/src/services/redrawCapabilityService.js` 使用统一常量：

```js
const REDRAW_OUTPUT_CAPABILITIES = [
  'text',
  'subtitles',
  'character_image',
  'clean_plate_image',
  'tts',
  'video',
];

function summarizeLocaleCapability(capability) {
  if (REDRAW_OUTPUT_CAPABILITIES.every((name) => capability[name] === true)) return 'full_output';
  if (capability.text && capability.subtitles && capability.tts && capability.video
    && (!capability.character_image || !capability.clean_plate_image)) return 'asset_pending';
  if (capability.text && capability.subtitles && !capability.tts && capability.video) return 'subtitle_only';
  if (capability.text && capability.subtitles && !capability.tts) return 'voice_pending';
  return 'blocking';
}
```

实现并导出精确解析器：

```js
function resolveVerifiedLocaleCapability(db, input = {}) {
  const capabilityName = String(input.capability || '').trim();
  if (!REDRAW_OUTPUT_CAPABILITIES.includes(capabilityName)) return null;
  const locale = String(input.locale || '').trim();
  const market = String(input.market || '').trim();
  if (!locale || typeof input.canReadArtifact !== 'function') return null;

  const rows = db.prepare(`
    SELECT settings FROM ai_service_configs
    WHERE COALESCE(is_active, 1) = 1 AND deleted_at IS NULL
    ORDER BY is_default DESC, priority DESC, id ASC
  `).all();
  for (const row of rows) {
    for (const entry of collectLocaleEntries(row.settings)) {
      if (entry.status !== 'verified') continue;
      if (String(entry.locale || '').trim() !== locale) continue;
      if (String(entry.market || '').trim() !== market) continue;
      const evidence = parseJson(evidenceForCapability(entry, capabilityName), null);
      if (!evidence || !validateGenerationEvidence(evidence, input.canReadArtifact)) continue;
      return { provider: String(evidence.provider), model: String(evidence.model), evidence };
    }
  }
  return null;
}
```

`listLocaleCapabilities` 必须遍历 `REDRAW_OUTPUT_CAPABILITIES` 并把所有缺失项放入 `blocking`。

- [ ] **步骤 4：运行能力测试确认通过**

运行：

```powershell
cd backend-node
node --test test/redrawCapabilities.test.js
```

预期：PASS；缺少任一图像能力时不再返回 `full_output`。

- [ ] **步骤 5：提交**

```powershell
git add backend-node/src/services/redrawCapabilityService.js backend-node/test/redrawCapabilities.test.js
git commit -m "feat: 收紧转绘完整输出能力门禁"
```

## 任务 3：拆分隐藏本地化草稿与原子物化

**文件：**

- 修改：`backend-node/src/services/localizationService.js`
- 修改：`backend-node/test/redrawLocalization.test.js`

- [ ] **步骤 1：编写失败的隐藏草稿测试**

扩展 `createDb()` 的版本字段后增加：

```js
test('第二次确认只创建隐藏草稿且不推进作品步骤', () => {
  const db = createDb();
  const draft = createLocalizationDraft(db, { tenantId: 'tenant-a', userId: 'user-a' }, 1, {
    locale: 'en-US',
    market: 'US',
    localizationLevel: 'faithful',
    inputHash: 'a'.repeat(64),
    idempotencyKey: 'confirm-en-us-1',
    modelSnapshot: { provider: 'provider-a', model: 'model-a' },
  });
  assert.equal(draft.status, 'draft');
  assert.equal(db.prepare('SELECT current_version FROM redraw_works WHERE id = 1').get().current_version, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_shots WHERE version_id = ?').get(draft.id).count, 0);
  assert.equal(createLocalizationDraft(db, { tenantId: 'tenant-a', userId: 'user-a' }, 1, {
    locale: 'en-US',
    market: 'US',
    localizationLevel: 'faithful',
    inputHash: 'a'.repeat(64),
    idempotencyKey: 'confirm-en-us-1',
    modelSnapshot: { provider: 'provider-a', model: 'model-a' },
  }).id, draft.id);
  db.close();
});
```

增加成功提升测试，断言 `materializeLocalizationDraft` 只在全部镜头、四类资产和引用写入成功后更新 `current_version=2/current_step=2/status=asset_review`；触发器制造插入失败时，草稿仍不可见且当前版本保持 1。

- [ ] **步骤 2：运行测试确认失败**

运行：

```powershell
cd backend-node
node --test test/redrawLocalization.test.js
```

预期：FAIL，两个新函数尚不存在。

- [ ] **步骤 3：实现隐藏草稿创建**

在 `backend-node/src/services/localizationService.js` 新增并导出：

```js
function createLocalizationDraft(db, owner, workId, input = {}) {
  const { tenantId, userId } = normalizeOwner(owner);
  const locale = assertLocale(input.locale);
  const idempotencyKey = String(input.idempotencyKey || input.idempotency_key || '').trim();
  if (!tenantId || !userId || !idempotencyKey) {
    throw Object.assign(new Error('本地化草稿缺少所有权或幂等键'), {
      code: 'LOCALIZATION_DRAFT_INVALID',
    });
  }
  const existing = db.prepare(`
    SELECT * FROM redraw_versions
    WHERE work_id = ? AND tenant_id = ? AND user_id = ?
      AND localization_idempotency_key = ? AND deleted_at IS NULL
    LIMIT 1
  `).get(Number(workId), String(tenantId), String(userId), idempotencyKey);
  if (existing) return existing;

  const work = db.prepare(`
    SELECT * FROM redraw_works
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(Number(workId), String(tenantId), String(userId));
  if (!work) throw Object.assign(new Error('转绘作品不存在'), { code: 'LOCALIZATION_WORK_NOT_FOUND' });
  const nextVersion = Number(db.prepare(
    'SELECT COALESCE(MAX(version), 0) AS value FROM redraw_versions WHERE work_id = ?',
  ).get(Number(workId)).value) + 1;
  const now = new Date().toISOString();
  const id = Number(db.prepare(`
    INSERT INTO redraw_versions
      (work_id, tenant_id, user_id, version, locale, market, localization_level,
       localization_input_hash, localization_idempotency_key,
       localization_model_snapshot_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
  `).run(
    Number(workId), String(tenantId), String(userId), nextVersion, locale,
    String(input.market || ''), String(input.localizationLevel || 'faithful'),
    String(input.inputHash || ''), idempotencyKey,
    JSON.stringify(input.modelSnapshot || {}), now, now,
  ).lastInsertRowid);
  return db.prepare('SELECT * FROM redraw_versions WHERE id = ?').get(id);
}
```

- [ ] **步骤 4：让现有物化函数接受指定草稿 ID**

保留 `createLocalizationVersion` 的既有事实、镜头和资产写入主体，只替换其“新建目标版本”分支。新增：

```js
function findOwnedDraftVersion(db, owner, draftVersionId, workId) {
  const { tenantId, userId } = normalizeOwner(owner);
  const row = db.prepare(`
    SELECT * FROM redraw_versions
    WHERE id = ? AND work_id = ? AND tenant_id = ? AND user_id = ?
      AND status = 'draft' AND deleted_at IS NULL
    LIMIT 1
  `).get(Number(draftVersionId), Number(workId), String(tenantId), String(userId));
  if (!row) {
    throw Object.assign(new Error('本地化草稿不存在'), {
      code: 'LOCALIZATION_DRAFT_NOT_FOUND',
    });
  }
  return row;
}

function materializeLocalizationDraft(db, owner, draftVersionId, input) {
  return createLocalizationVersion(db, owner, input.workId || input.work_id, {
    ...input,
    draftVersionId: Number(draftVersionId),
  });
}
```

在 `createLocalizationVersion` 的现有事务中，把 `nextVersion + INSERT redraw_versions` 替换为：

```js
const draft = input.draftVersionId
  ? findOwnedDraftVersion(db, owner, input.draftVersionId, workId)
  : createLocalizationDraft(db, owner, workId, {
      locale,
      market: input.market,
      localizationLevel: input.localizationLevel || input.localization_level,
      inputHash: expectedFactsHash,
      idempotencyKey: `compat-${workId}-${expectedFactsHash}-${Date.now()}`,
      modelSnapshot: input.modelSnapshot || {},
    });
const versionId = Number(draft.id);
const nextVersion = Number(draft.version);
```

事务结束前使用条件更新提升草稿，防止并发重复物化：

```js
const promoted = db.prepare(`UPDATE redraw_versions
  SET source_facts_json = ?, glossary_json = ?, name_map_json = ?, culture_map_json = ?,
      style_snapshot_json = ?, facts_hash = ?, status = 'asset_review', updated_at = ?
  WHERE id = ? AND status = 'draft'`)
  .run(
    sourceVersion.source_facts_json,
    JSON.stringify(input.glossary || input.glossaryMap || {}),
    JSON.stringify(input.nameMap || input.name_map || {}),
    JSON.stringify(input.cultureMap || input.culture_map || {}),
    JSON.stringify(input.styleSnapshot || input.style_snapshot || {}),
    persistedFactsHash,
    now,
    versionId,
  );
if (promoted.changes !== 1) {
  throw Object.assign(new Error('本地化草稿已被处理'), { code: 'LOCALIZATION_DRAFT_CONFLICT' });
}
db.prepare(`UPDATE redraw_works
  SET current_version = ?, current_step = 2, status = 'asset_review', updated_at = ?
  WHERE id = ? AND tenant_id = ? AND user_id = ?`)
  .run(nextVersion, now, Number(workId), String(tenantId), String(userId));
```

现有物化循环继续负责事实哈希、镜头时间轴和引用校验。资产循环除 character、scene、prop 外，为每个角色创建一条 `voice` 草稿，`source_ref_json.source_ref` 使用 `{ kind: 'voice', id: characterId, stable_id: characterId }`；处理镜头说话人时同时加入 character 和 voice 引用，使审核门禁要求两者都有可读取且已批准的产物。

兼容包装只供现有单元测试使用，生产路由必须提供 `draftVersionId`，不得再次走兼容分支。

- [ ] **步骤 5：运行本地化测试确认通过**

运行：

```powershell
cd backend-node
node --test test/redrawLocalization.test.js test/redrawReviewGate.test.js
```

预期：PASS；目标版本成功前不推进，新增 voice 引用使未批准音色继续阻断门禁。

- [ ] **步骤 6：提交**

```powershell
git add backend-node/src/services/localizationService.js backend-node/test/redrawLocalization.test.js
git commit -m "refactor: 拆分本地化草稿与原子物化"
```

## 任务 4：实现真实本地化报价、任务和结算

**文件：**

- 创建：`backend-node/src/services/redrawLocalizationOrchestrator.js`
- 创建：`backend-node/test/redrawLocalizationOrchestration.test.js`
- 修改：`backend-node/src/services/taskService.js`

- [ ] **步骤 1：编写失败的本地化编排测试**

在新测试中使用内存数据库、已验证 `text` 能力、模型价格和可注入 provider，覆盖：

```js
test('本地化成功后结算并原子提升目标版本', async () => {
  const state = setupVerifiedLocalization();
  const provider = async ({ input, model }) => ({
    provider_task_id: 'provider-localize-1',
    result: localizedResult(input.source_facts_hash),
    model,
  });
  const started = await startLocalization(state.db, state.log, {
    workId: state.workId,
    tenantId: 'tenant-a',
    userId: 'user-a',
    locale: 'en-US',
    market: 'US',
    localizationLevel: 'faithful',
    quoteHash: quoteLocalization(state.db, state.context).quote_hash,
    idempotencyKey: 'localize-success-1',
  }, { ...state.context, provider, schedule: (job) => job() });
  await started.completion;
  const task = state.db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(started.task_id);
  assert.equal(task.status, 'completed');
  assert.equal(task.provider_task_id, 'provider-localize-1');
  assert.equal(state.db.prepare('SELECT current_step FROM redraw_works WHERE id = ?').get(state.workId).current_step, 2);
  assert.equal(readReservation(state.db, started.reservation_id).status, 'confirmed');
  state.db.close();
});

test('本地化失败全额释放且不提升隐藏草稿', async () => {
  const state = setupVerifiedLocalization();
  const provider = async () => { throw Object.assign(new Error('provider failed'), { code: 'PROVIDER_FAILED' }); };
  const quote = quoteLocalization(state.db, state.context);
  const started = await startLocalization(state.db, state.log, {
    workId: state.workId,
    tenantId: 'tenant-a',
    userId: 'user-a',
    locale: 'en-US',
    market: 'US',
    localizationLevel: 'faithful',
    quoteHash: quote.quote_hash,
    idempotencyKey: 'localize-failed-1',
  }, { ...state.context, provider, schedule: (job) => job() });
  await assert.rejects(started.completion, /provider failed/);
  assert.equal(readReservation(state.db, started.reservation_id).status, 'refunded');
  assert.equal(state.db.prepare('SELECT current_step FROM redraw_works WHERE id = ?').get(state.workId).current_step, 1);
  state.db.close();
});
```

另加报价变化、余额不足、幂等重放、结构校验失败和未知供应商终态保持 `held` 的测试。

- [ ] **步骤 2：运行测试确认失败**

运行：

```powershell
cd backend-node
node --test test/redrawLocalizationOrchestration.test.js
```

预期：FAIL，新服务不存在。

- [ ] **步骤 3：实现稳定报价**

在新服务先实现稳定序列化和快照构造。它们只读取最早的源事实版本，不能把隐藏目标草稿当源版本：

```js
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  return value;
}

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function buildLocalizationSnapshot(db, input, capability) {
  const source = db.prepare(`
    SELECT source_facts_json, facts_hash, style_snapshot_json
    FROM redraw_versions
    WHERE work_id = ? AND tenant_id = ? AND user_id = ?
      AND source_facts_json IS NOT NULL AND deleted_at IS NULL
    ORDER BY version ASC, id ASC
    LIMIT 1
  `).get(Number(input.workId), String(input.tenantId), String(input.userId));
  if (!source) {
    throw Object.assign(new Error('源片事实尚未确认'), {
      code: 'REDRAW_LOCALIZATION_SOURCE_REQUIRED',
    });
  }
  const localizationInput = localizationService.buildLocalizationInput(
    JSON.parse(source.source_facts_json),
    {
      locale: input.locale,
      market: input.market,
      localizationLevel: input.localizationLevel,
      styleSnapshot: JSON.parse(source.style_snapshot_json || '{}'),
    },
  );
  return {
    input: localizationInput,
    capability: {
      provider: capability.provider,
      model: capability.model,
      evidence: capability.evidence,
    },
  };
}
```

然后实现 `quoteLocalization`。输入哈希由已持久化源事实、目标语言、市场、本地化级别、模型和能力证据组成，金额必须来自 `modelPriceService.requirePrice`：

```js
function quoteLocalization(db, input = {}) {
  const capability = redrawCapabilityService.resolveVerifiedLocaleCapability(db, {
    locale: input.locale,
    market: input.market,
    capability: 'text',
    canReadArtifact: input.canReadArtifact,
  });
  if (!capability) return { priced: false, code: 'REDRAW_LOCALIZATION_CAPABILITY_UNVERIFIED' };
  let credits;
  try {
    credits = modelPriceService.requirePrice(db, capability.model);
  } catch (error) {
    if (error.code === 'MODEL_PRICE_NOT_CONFIGURED') {
      return { priced: false, code: 'pricing_unconfigured' };
    }
    throw error;
  }
  const snapshot = buildLocalizationSnapshot(db, input, capability);
  return {
    priced: true,
    credits,
    model: capability.model,
    input_hash: stableHash(snapshot.input),
    quote_hash: stableHash({ snapshot, credits }),
    snapshot,
  };
}
```

- [ ] **步骤 4：实现原子冻结和幂等任务创建**

`startLocalization` 在一个数据库事务中完成重新报价、哈希比较、隐藏草稿、账本冻结、`redraw_localization` 任务和任务字段关联。账本操作键固定为：

```js
const operationKey = [
  'redraw-localization',
  tenantId,
  userId,
  workId,
  quote.input_hash,
  idempotencyKey,
].join(':');
```

相同幂等键先查询隐藏版本并返回已有任务；`quote_hash` 不匹配抛出 `REDRAW_LOCALIZATION_QUOTE_CHANGED`，并把新报价放入错误详情。

- [ ] **步骤 5：实现异步执行、物化和结算**

provider 接口固定为：

```js
async function localizationProviderCall(provider, payload) {
  const result = await provider({
    taskId: payload.taskId,
    model: payload.model,
    locale: payload.locale,
    market: payload.market,
    input: payload.input,
  });
  if (!result || !result.result) {
    throw Object.assign(new Error('本地化供应商未返回结构化结果'), {
      code: 'REDRAW_LOCALIZATION_EMPTY_RESULT',
    });
  }
  return result;
}
```

执行顺序必须是：任务置 `processing` → 调用 provider → 写入 `provider_task_id` → `normalizeLocalizationResult` → `materializeLocalizationDraft` → 任务成功 → 积分确认。确定失败时任务失败并退款；调用已经发出但没有确定终态时写 `needs_attention`，保留冻结并禁止自动重提。

- [ ] **步骤 6：保护启动恢复中的未知任务**

在 `taskService.failOrphanedAsyncTasksOnStartup` 之前排除 `redraw_localization` 和 `redraw_asset_batch`。新编排器导出 `reconcileOrphanedTasks`：存在供应商任务 ID 时标记 `needs_attention` 且保留冻结；确定未派发时标记失败并退款。不得把未知任务直接当失败退款。

- [ ] **步骤 7：运行本地化编排测试确认通过**

运行：

```powershell
cd backend-node
node --test test/redrawLocalizationOrchestration.test.js test/redrawLocalization.test.js
```

预期：PASS，失败退款、未知状态保留冻结、幂等重放不产生第二笔账。

- [ ] **步骤 8：提交**

```powershell
git add backend-node/src/services/redrawLocalizationOrchestrator.js backend-node/src/services/taskService.js backend-node/test/redrawLocalizationOrchestration.test.js
git commit -m "feat: 实现真实转绘本地化编排"
```

## 任务 5：收紧本地化接口并投影独立工作流状态

**文件：**

- 修改：`backend-node/src/routes/redraw.js`
- 修改：`backend-node/src/routes/index.js`
- 修改：`backend-node/test/redrawRoutes.test.js`

- [ ] **步骤 1：编写失败的路由合同测试**

增加以下断言：

```js
test('创建目标版本拒绝客户端本地化内容、模型和积分', async () => {
  const state = setupAnalyzedWork();
  let calls = 0;
  const handlers = redrawRoutes(state.db, state.log, routeDeps({
    localizationOrchestrator: {
      startLocalization: async () => { calls += 1; return { task_id: 'should-not-run' }; },
    },
  }));
  for (const body of [
    { locale: 'en-US', dialogue: [{ shot_id: 'shot-1', turns: [] }] },
    { locale: 'en-US', model: 'client-model' },
    { locale: 'en-US', credit_amount: 1 },
  ]) {
    const res = captureResponse();
    await handlers.createVersion(request({ id: state.workId, body }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'REDRAW_LOCALIZATION_CLIENT_CONTROL_FORBIDDEN');
  }
  assert.equal(calls, 0);
  state.db.close();
});
```

再覆盖：本地化报价 409、提交返回 202、租户隔离、工作详情同时返回 `analysis_task/localization_task/asset_batch/workflow_phase`，以及分析成功但未本地化时 `current_step=1/workflow_phase=analysis_review`。

- [ ] **步骤 2：运行路由测试确认失败**

运行：

```powershell
cd backend-node
node --test test/redrawRoutes.test.js
```

预期：FAIL，报价 handler 和独立工作流字段不存在。

- [ ] **步骤 3：增加本地化报价 handler**

在 `redraw.js` 增加 `localizationQuote`，只读取 `locale/market/localization_level`，调用编排器报价。能力或价格缺失返回 `409`，不创建任务、不冻结积分。

- [ ] **步骤 4：替换同步 createVersion**

客户端控制字段使用固定集合：

```js
const LOCALIZATION_CLIENT_CONTROL_FIELDS = new Set([
  'dialogue',
  'localized_dialogue',
  'name_map',
  'culture_map',
  'glossary',
  'source_facts',
  'model',
  'provider',
  'credit_amount',
  'credits',
  'reservation_id',
]);
```

`createVersion` 只传递白名单参数给 `startLocalization`，成功返回：

```js
return response.accepted(res, {
  task_id: result.task_id,
  version_id: result.version_id,
  status: result.status,
  current_step: 1,
  billing: billingPayload(result.billing),
});
```

- [ ] **步骤 5：扩展 getWork 工作流投影**

增加独立任务查询，不覆盖分析字段。工作流派生规则集中到纯函数：

```js
function workflowPhase(work, analysisTask, localizationTask, assetBatch) {
  if (Number(work.current_step) >= 3) return 'video_generation';
  if (assetBatch && ['pending', 'processing'].includes(assetBatch.status)) return 'asset_generating';
  if (Number(work.current_step) === 2) return 'asset_review';
  if (localizationTask && ['pending', 'processing'].includes(localizationTask.status)) return 'localizing';
  if (localizationTask?.status === 'needs_attention') return 'localization_needs_attention';
  if (analysisTask?.status === 'completed') return 'analysis_review';
  if (analysisTask && ['pending', 'processing'].includes(analysisTask.status)) return 'analyzing';
  return 'source';
}
```

普通版本列表和 `version_id` 只返回已提升目标版本，隐藏 `draft` 不得成为当前版本。

- [ ] **步骤 6：注册接口**

在 `backend-node/src/routes/index.js` 增加：

```js
r.post('/redraw/works/:id/localization-quote', redraw.localizationQuote);
r.post('/redraw/works/:id/versions', redraw.createVersion);
```

保留原版本路径，不增加兼容的客户端直写入口。

- [ ] **步骤 7：运行路由测试确认通过**

运行：

```powershell
cd backend-node
node --test test/redrawRoutes.test.js test/redrawAnalysis.test.js
```

预期：PASS；分析完成不再提前进入第 2 步。

- [ ] **步骤 8：提交**

```powershell
git add backend-node/src/routes/redraw.js backend-node/src/routes/index.js backend-node/test/redrawRoutes.test.js
git commit -m "feat: 增加转绘本地化确认接口"
```

## 任务 6：实现资产批量报价、冻结与部分失败

**文件：**

- 创建：`backend-node/src/services/redrawAssetBatchService.js`
- 创建：`backend-node/test/redrawAssetBatch.test.js`
- 修改：`backend-node/src/services/redrawAssetService.js`
- 修改：`backend-node/test/redrawAssets.test.js`

- [ ] **步骤 1：编写失败的批量报价测试**

在新测试中创建包含 character、scene、prop、voice 草稿的目标版本，断言服务端分别选择 `character_image`、`clean_plate_image` 和 `tts`：

```js
test('资产批量报价只包含草稿和失败项并生成稳定报价哈希', () => {
  const state = setupBatchState();
  const quote = quoteAssetBatch(state.db, {
    versionId: state.versionId,
    tenantId: 'tenant-a',
    userId: 'user-a',
    canReadArtifact: state.canReadArtifact,
  });
  assert.equal(quote.priced, true);
  assert.equal(quote.items.length, 4);
  assert.deepEqual(quote.items.map((item) => item.capability), [
    'character_image',
    'clean_plate_image',
    'clean_plate_image',
    'tts',
  ]);
  assert.equal(quote.total_credits, quote.items.reduce((sum, item) => sum + item.credits, 0));
  assert.match(quote.quote_hash, /^[a-f0-9]{64}$/);
  state.db.close();
});
```

- [ ] **步骤 2：编写失败的原子冻结和部分失败测试**

```js
test('批次先冻结全部单项，部分失败只退款失败项且重试不重复成功项', async () => {
  const state = setupBatchState();
  const quote = quoteAssetBatch(state.db, state.context);
  const failedAssetId = quote.items.find((item) => item.kind === 'scene').asset_id;
  const provider = async ({ asset }) => {
    if (asset.id === failedAssetId) throw new Error('scene provider failed');
    return state.readableProviderResult(asset);
  };
  const started = startAssetBatch(state.db, state.log, {
    ...state.context,
    quoteHash: quote.quote_hash,
    idempotencyKey: 'batch-partial-1',
  }, { provider, schedule: (job) => job() });
  await started.completion;
  const batch = getAssetBatch(state.db, started.batch_id, state.context);
  assert.equal(batch.status, 'partial_failed');
  assert.equal(batch.success_count, 3);
  assert.equal(batch.failed_count, 1);
  assert.equal(reservationsByStatus(state.db, 'confirmed'), 3);
  assert.equal(reservationsByStatus(state.db, 'refunded'), 1);

  const retryQuote = quoteAssetBatch(state.db, { ...state.context, assetIds: [failedAssetId] });
  assert.equal(retryQuote.items.length, 1);
  state.db.close();
});
```

另加余额不足整批不派发、某项未定价整批不派发、幂等重放和跨租户资产 ID 拒绝测试。

- [ ] **步骤 3：运行批次测试确认失败**

运行：

```powershell
cd backend-node
node --test test/redrawAssetBatch.test.js
```

预期：FAIL，新服务不存在。

- [ ] **步骤 4：抽取资产尝试失败结算**

在 `redrawAssetService.js` 新增并导出：

```js
function failAssetAttempt(ctx, attemptId, error) {
  const { db, tenantId, userId } = assertContext(ctx);
  const attempt = db.prepare(`
    SELECT * FROM redraw_assets
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(Number(attemptId), tenantId, userId);
  if (!attempt) throw codedError('REDRAW_ASSET_NOT_FOUND', '转绘资产尝试不存在');
  const code = String(error?.code || 'REDRAW_ASSET_GENERATION_FAILED');
  const message = String(error?.message || error || '资产生成失败');
  db.prepare(`UPDATE redraw_assets
    SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?
    WHERE id = ?`).run(code, message, new Date().toISOString(), attempt.id);
  if (attempt.credit_reservation_id) {
    creditLedger.settleGeneration(db, attempt.credit_reservation_id, 'failed', message);
  }
  return rowToAsset(db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(attempt.id));
}
```

`generateAsset` 和 `generateCleanPlate` 的 catch 分支改为调用此函数。`finalizeAssetAttempt` 对 `voice` 写 `voice_asset_id`，对 `scene` 且 provider 返回 `clean_plate=true` 时写 `clean_plate_asset_id` 和 `status=needs_attention`；其他类型写 `asset_id/status=generated`。

- [ ] **步骤 5：实现批次报价**

`quoteAssetBatch` 必须：验证版本所有权；只选当前版本 `draft/failed` 且没有可读取成功产物的资产；按类型解析能力；用 `modelPriceService.requirePrice` 计算每项金额；把资产版本号和提示词哈希写入快照。任一项能力或价格缺失时返回 `priced=false` 和逐项阻断，不能只报价可用子集。

- [ ] **步骤 6：实现原子冻结和父子任务**

在一个外层 `db.transaction` 中：重新报价并校验哈希；按批次幂等键查询或创建 `redraw_asset_batches`；创建父 `redraw_asset_batch` 任务；为每项创建 `redraw_asset` 子任务；调用现有 `createAssetAttempt` 冻结积分并认领草稿。任何一步抛错时整个事务回滚，因此 provider 调用数必须保持 0。

- [ ] **步骤 7：实现受控并发与聚合终态**

事务提交后才派发 provider。每项成功调用 `finalizeAssetAttempt` 和 `updateTaskResult`，失败调用 `failAssetAttempt` 和 `updateTaskError`。全部 settled 后使用固定聚合函数：

```js
function batchStatus(successCount, failedCount, totalCount) {
  if (successCount === totalCount) return 'completed';
  if (successCount > 0 && failedCount > 0) return 'partial_failed';
  if (failedCount === totalCount) return 'failed';
  return 'processing';
}
```

并发上限使用 `options.concurrency || 3`，不得一次启动无限供应商调用。

- [ ] **步骤 8：运行资产服务与批次测试确认通过**

运行：

```powershell
cd backend-node
node --test test/redrawAssets.test.js test/redrawAssetBatch.test.js
```

预期：PASS；部分失败账本为 3 笔 confirmed、1 笔 refunded，重试报价只有失败项。

- [ ] **步骤 9：提交**

```powershell
git add backend-node/src/services/redrawAssetBatchService.js backend-node/src/services/redrawAssetService.js backend-node/test/redrawAssetBatch.test.js backend-node/test/redrawAssets.test.js
git commit -m "feat: 实现转绘资产批量生成与逐项结算"
```

## 任务 7：接入现有文本、图片和 TTS 真实适配器

**文件：**

- 创建：`backend-node/src/services/redrawProviderAdapters.js`
- 创建：`backend-node/test/redrawProviderAdapters.test.js`
- 修改：`backend-node/src/routes/index.js`
- 修改：`backend-node/src/app.js`

- [ ] **步骤 1：编写失败的适配器测试**

测试全部注入本地 fake client，不发网络请求：

```js
test('本地化适配器固定使用能力快照模型并要求结构化 JSON', async () => {
  const calls = [];
  const adapters = createRedrawProviderAdapters({
    db: createDb(),
    log: testLog,
    cfg: testConfig,
    aiClient: {
      generateText: async (...args) => {
        calls.push(args);
        return JSON.stringify({ facts_hash: 'facts-hash', dialogue: [] });
      },
    },
  });
  const result = await adapters.localize({
    taskId: 'task-localize-1',
    model: 'verified-text-model',
    locale: 'en-US',
    market: 'US',
    input: { source_facts_hash: 'facts-hash', source_facts: { shots: [] } },
  });
  assert.equal(calls[0][5].model, 'verified-text-model');
  assert.equal(calls[0][5].json_mode, true);
  assert.equal(result.result.facts_hash, 'facts-hash');
});
```

图片测试断言 `imageClient.callImageApi` 返回后下载本地文件并登记 `assets`；TTS 测试断言 `ttsService.synthesize` 使用能力快照模型、登记 `audio/mpeg` 素材并返回可读取资产 ID。未验证能力不在适配器内自动回退。

- [ ] **步骤 2：运行适配器测试确认失败**

运行：

```powershell
cd backend-node
node --test test/redrawProviderAdapters.test.js
```

预期：FAIL，适配器工厂不存在。

- [ ] **步骤 3：实现本地化适配器**

使用固定系统提示词要求只返回 JSON，并把能力解析器给出的模型显式传给 `aiClient.generateText`：

```js
const LOCALIZATION_SYSTEM_PROMPT = [
  'You localize short-drama facts into the requested locale.',
  'Return one JSON object only.',
  'Preserve shot IDs, order, timing, speakers, causal chain, reversals, locked facts, and episode hook.',
  'Only names, cultural mappings, glossary, and dialogue wording may change.',
].join(' ');

async function localize(input) {
  const raw = await deps.aiClient.generateText(
    deps.db,
    deps.log,
    'text',
    JSON.stringify(input.input),
    LOCALIZATION_SYSTEM_PROMPT,
    { model: input.model, json_mode: true, temperature: 0.2, min_max_tokens: 4096 },
  );
  return {
    provider_task_id: null,
    result: JSON.parse(raw),
    model: input.model,
  };
}
```

同步文本协议没有可查询的供应商任务 ID 时必须返回 `null`，不能用内部任务 ID伪造供应商证据。进程中断后由未知状态门禁处理。

- [ ] **步骤 4：实现图片与语音适配器**

图片调用 `imageClient.callImageApi`，随后使用 `uploadService.downloadImageToLocal` 下载到 `redraw-assets/<versionId>` 并用 `assetService.create` 登记。语音调用 `ttsService.synthesize`，再登记 `type=audio/category=redraw_voice`。两者返回统一合同：

```js
return {
  status: 'completed',
  asset_id: Number(asset.id),
  readable: true,
  provider_task_id: providerTaskId || null,
  clean_plate: input.asset.kind === 'scene',
  metadata: input.asset.kind === 'voice'
    ? { locale: input.locale, voice_id: input.voiceId }
    : {},
};
```

适配器不调用积分账本；所有计费只由本地化编排器或资产批次服务负责。

- [ ] **步骤 5：注入路由并接入启动恢复**

在 `routes/index.js` 创建一次适配器并传入：

```js
const providerAdapters = createRedrawProviderAdapters({ db, log, cfg });
const redraw = redrawRoutes(db, log, {
  cfg,
  localizationProvider: providerAdapters.localize,
  assetGenerationProvider: providerAdapters.generateAsset,
});
```

在 `app.js` 中，源片分析恢复完成后、通用孤儿任务清理前依次执行本地化和资产批次恢复。恢复函数只查询状态，不重新提交未知供应商任务。

- [ ] **步骤 6：运行适配器和启动测试确认通过**

运行：

```powershell
cd backend-node
node --test test/redrawProviderAdapters.test.js test/redrawLocalizationOrchestration.test.js test/redrawAssetBatch.test.js
```

预期：PASS；测试输出没有外部 HTTP 请求。

- [ ] **步骤 7：提交**

```powershell
git add backend-node/src/services/redrawProviderAdapters.js backend-node/src/routes/index.js backend-node/src/app.js backend-node/test/redrawProviderAdapters.test.js
git commit -m "feat: 接入转绘文本图片与语音适配器"
```

## 任务 8：注册资产批量接口并禁止客户端控制

**文件：**

- 修改：`backend-node/src/routes/redraw.js`
- 修改：`backend-node/src/routes/index.js`
- 修改：`backend-node/test/redrawRoutes.test.js`

- [ ] **步骤 1：编写失败的批量接口测试**

增加批量报价、创建批次、幂等重放、租户隔离和客户端控制字段拒绝测试。客户端控制字段包括 `model/provider/credits/credit_amount/reservation_id/asset_results`；任一出现都返回 `REDRAW_ASSET_CLIENT_CONTROL_FORBIDDEN`，且 provider 调用数为 0。

- [ ] **步骤 2：运行路由测试确认失败**

运行：

```powershell
cd backend-node
node --test test/redrawRoutes.test.js
```

预期：FAIL，批量 handlers 尚未注册。

- [ ] **步骤 3：实现批量报价 handler**

`assetBatchQuote` 只接受可选 `asset_ids`，先验证目标版本属于当前租户用户，再调用 `quoteAssetBatch`。`priced=false` 返回 `409` 和逐项阻断；成功返回总价、明细和报价哈希。

- [ ] **步骤 4：实现创建批次 handler**

`createAssetBatch` 只接受：

```js
const input = {
  versionId: Number(version.id),
  tenantId: currentOwner.tenantId,
  userId: currentOwner.userId,
  assetIds: Array.isArray(req.body?.asset_ids) ? req.body.asset_ids.map(Number) : null,
  quoteHash: String(req.body?.quote_hash || ''),
  idempotencyKey: String(req.body?.idempotency_key || ''),
};
```

成功返回 `202`，包含 `batch_id/task_id/status/billing/current_step=2`。报价变化返回 `409 REDRAW_ASSET_QUOTE_CHANGED`；余额不足返回 `402 INSUFFICIENT_CREDITS`。

- [ ] **步骤 5：注册路径**

```js
r.post('/redraw/versions/:id/assets/batch-quote', redraw.assetBatchQuote);
r.post('/redraw/versions/:id/assets/batches', redraw.createAssetBatch);
```

- [ ] **步骤 6：运行路由测试确认通过**

运行：

```powershell
cd backend-node
node --test test/redrawRoutes.test.js test/redrawAssetBatch.test.js
```

预期：PASS，跨租户访问均为 404，客户端金额和模型不会进入服务层。

- [ ] **步骤 7：提交**

```powershell
git add backend-node/src/routes/redraw.js backend-node/src/routes/index.js backend-node/test/redrawRoutes.test.js
git commit -m "feat: 开放转绘资产批量报价与生成接口"
```

## 任务 9：实现分析确认与真实本地化前端

**文件：**

- 修改：`frontweb/src/api/redraw.js`
- 修改：`frontweb/src/utils/redrawWorkspaceState.js`
- 修改：`frontweb/src/components/redraw/RedrawSourceStep.vue`
- 修改：`frontweb/test/redrawSourceRuntime.test.js`
- 修改：`frontweb/test/redrawFoundation.test.js`

- [ ] **步骤 1：编写失败的状态函数测试**

在 `frontweb/test/redrawSourceRuntime.test.js` 增加：

```js
test('分析完成后停留确认态且本地化任务独立恢复', () => {
  assert.equal(redrawWorkflowPhase({
    current_step: 1,
    workflow_phase: 'analysis_review',
    analysis_task: { status: 'completed' },
  }), 'analysis_review');
  assert.equal(canConfirmLocalization({
    workflow_phase: 'analysis_review',
    localization_quote: { priced: true, credits: 9, quote_hash: 'quote-9' },
  }), true);
  assert.deepEqual(localizationTaskState({
    localization_task: { id: 'loc-1', status: 'processing', progress: 35 },
  }), { task_id: 'loc-1', status: 'processing', progress: 35, message: '' });
});
```

- [ ] **步骤 2：运行前端测试确认失败**

运行：

```powershell
cd frontweb
node --test test/redrawSourceRuntime.test.js test/redrawFoundation.test.js
```

预期：FAIL，新状态函数和 API 不存在。

- [ ] **步骤 3：增加 API 方法**

```js
quoteLocalization(workId, body) {
  return request.post(`/redraw/works/${workId}/localization-quote`, body)
},
createVersion(workId, body) {
  return request.post(`/redraw/works/${workId}/versions`, body)
},
```

- [ ] **步骤 4：实现纯状态函数**

在 `redrawWorkspaceState.js` 导出 `redrawWorkflowPhase`、`localizationQuoteCredits`、`canConfirmLocalization`、`localizationTaskState` 和：

```js
export function buildLocalizationPayload({ locale, market, localizationLevel, quoteHash, idempotencyKey }) {
  return {
    locale: String(locale || '').trim(),
    market: String(market || '').trim(),
    localization_level: String(localizationLevel || 'faithful'),
    quote_hash: String(quoteHash || ''),
    idempotency_key: String(idempotencyKey || ''),
  }
}
```

不得加入 `model`、`credits`、台词或映射字段。

- [ ] **步骤 5：改造源片步骤 UI**

`RedrawSourceStep.vue` 增加三个互斥区域：

- `analysis_review`：展示服务端分析摘要、本地化报价和“确认英文 1:1 本地化”。
- `localizing`：展示独立本地化任务 ID、进度和“请勿重复提交”。
- `localization_needs_attention/failed`：展示服务端错误；只有确定失败且已退款才允许生成新幂等键重试。

确认按钮调用前先重新请求报价；若 `quote_hash` 变化，更新界面并提示用户再次确认，不自动提交旧价格。幂等键用 `crypto.randomUUID()` 生成并在任务完成或明确失败前保存在组件状态中。

- [ ] **步骤 6：修正轮询终止条件**

当前 `current_step > 1` 不能再作为分析任务唯一终止条件。轮询依据 `workflow_phase` 和独立任务终态；本地化成功刷新到 `current_step=2` 后，由工作区路由自动进入资产页。

- [ ] **步骤 7：运行前端测试和构建**

运行：

```powershell
cd frontweb
node --test test/redrawSourceRuntime.test.js test/redrawFoundation.test.js
npm run build
```

预期：测试 PASS，构建 PASS；仅允许现有 chunk size 警告。

- [ ] **步骤 8：提交**

```powershell
git add frontweb/src/api/redraw.js frontweb/src/utils/redrawWorkspaceState.js frontweb/src/components/redraw/RedrawSourceStep.vue frontweb/test/redrawSourceRuntime.test.js frontweb/test/redrawFoundation.test.js
git commit -m "feat: 增加转绘分析确认与本地化进度"
```

## 任务 10：实现资产总价确认、批次进度与失败重试前端

**文件：**

- 修改：`frontweb/src/api/redraw.js`
- 修改：`frontweb/src/utils/redrawAssetState.js`
- 修改：`frontweb/src/components/redraw/RedrawAssetStep.vue`
- 修改：`frontweb/test/redrawAssets.test.js`

- [ ] **步骤 1：编写失败的资产批次状态测试**

增加：

```js
test('资产批量按钮要求完整服务端报价且部分失败只重试失败项', async () => {
  const state = await import('../src/utils/redrawAssetState.js');
  assert.equal(state.canStartAssetBatch({ priced: true, total_credits: 18, blocking: [] }, null), true);
  assert.equal(state.canStartAssetBatch({ priced: false, total_credits: null, blocking: ['tts'] }, null), false);
  assert.deepEqual(state.failedAssetIds({
    items: [
      { asset_id: 1, status: 'generated' },
      { asset_id: 2, status: 'failed' },
      { asset_id: 3, status: 'failed' },
    ],
  }), [2, 3]);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```powershell
cd frontweb
node --test test/redrawAssets.test.js
```

预期：FAIL，新函数和 API 不存在。

- [ ] **步骤 3：增加批量 API**

```js
quoteAssetBatch(versionId, body = {}) {
  return request.post(`/redraw/versions/${versionId}/assets/batch-quote`, body)
},
createAssetBatch(versionId, body) {
  return request.post(`/redraw/versions/${versionId}/assets/batches`, body)
},
```

- [ ] **步骤 4：实现资产批次状态函数**

导出 `assetBatchCredits`、`canStartAssetBatch`、`failedAssetIds`、`assetBatchProgress`。总价必须是正整数；存在任一阻断、正在处理的批次或空资产列表时按钮禁用。

- [ ] **步骤 5：改造资产页**

`RedrawAssetStep.vue` 在资产网格上方增加：

- 总价区域，使用受保护合同类名 `canvas-credit-callout-v1`；未定价显示“积分待管理员配置”。
- “一键批量生成全部资产”按钮。
- 报价变化二次确认。
- 批次进度条和成功/失败计数。
- `partial_failed` 时显示“一键重试失败项”，请求体只传 `failedAssetIds`。

单项生成按钮保留，用于用户编辑某个提示词后的独立重生成。批量请求不得发送模型、积分或供应商字段。

- [ ] **步骤 6：运行前端测试和构建**

运行：

```powershell
cd frontweb
node --test test/redrawAssets.test.js test/redrawSourceRuntime.test.js test/redrawFoundation.test.js
npm run build
```

预期：测试 PASS，构建 PASS。

- [ ] **步骤 7：提交**

```powershell
git add frontweb/src/api/redraw.js frontweb/src/utils/redrawAssetState.js frontweb/src/components/redraw/RedrawAssetStep.vue frontweb/test/redrawAssets.test.js
git commit -m "feat: 增加转绘资产批量报价与失败重试"
```

## 任务 11：浏览器闭环、全量回归与证据分级

**文件：**

- 修改：`frontweb/e2e/redraw-workspace.spec.js`
- 修改：`docs/superpowers/reports/2026-08-07-one-click-short-drama-redraw-phase-3-gate.md`

- [ ] **步骤 1：扩展 Playwright fixture 路由**

在 `frontweb/e2e/redraw-workspace.spec.js` 增加 fixture 状态：

```js
const localizationQuote = {
  priced: true,
  credits: 9,
  model: 'verified-text-model',
  input_hash: 'f'.repeat(64),
  quote_hash: 'e'.repeat(64),
};

const assetBatchQuote = {
  priced: true,
  total_credits: 18,
  quote_hash: 'd'.repeat(64),
  blocking: [],
  items: redrawAssets.map((asset) => ({
    asset_id: asset.id,
    kind: asset.kind,
    model: asset.kind === 'voice' ? 'verified-tts' : 'verified-image',
    credits: 6,
  })),
};
```

fixture 必须处理本地化报价、创建版本、批量报价和创建批次，并记录请求体供防客户端控制断言。

- [ ] **步骤 2：编写浏览器失败用例**

增加场景：分析完成仍停在第 1 步 → 显示 9 积分 → 第二次确认 → 本地化处理中刷新恢复 → 成功进入第 2 步 → 显示批量总价 → 批次部分失败 → 只重试失败项 → 资产审核完成后第 3 步开放。

请求断言必须确认创建版本和资产批次正文不含 `model`、`provider`、`credits`、`credit_amount` 和客户端生成台词。

- [ ] **步骤 3：运行定向 Playwright**

运行：

```powershell
cd frontweb
$env:PLAYWRIGHT_REUSE_SERVER='0'
npx playwright test e2e/redraw-workspace.spec.js
```

预期：全部 PASS，浏览器 console 没有未处理错误，桌面和 390px 移动端无横向滚动。

- [ ] **步骤 4：运行后端全量回归**

运行：

```powershell
cd backend-node
npm test
```

预期：全部既有测试和新增测试 PASS；若存在预先存在的 skip，记录数量和名称，不把 skip 称为通过。

- [ ] **步骤 5：运行前端全量测试与构建**

运行：

```powershell
cd frontweb
node --test test/*.test.js
npm run build
```

预期：新增转绘测试全部 PASS。若既有画布静态测试仍失败，必须与实施前基线按文件和断言逐项比较，不能笼统归因。

- [ ] **步骤 6：更新门禁报告**

在门禁报告写明：

- 自动化后端、前端、构建和 Playwright 的同次运行命令、通过数、失败数和时间。
- 本次未调用付费供应商时，真实本地化、图片、TTS、账本和最终成片仍标记 `blocked`。
- 模拟 provider 只证明合同和恢复逻辑，不证明真实供应商可用。
- 没有目标 Key、明确付费调用授权和可读取真实产物时，`productComplete=false`。

- [ ] **步骤 7：提交自动化与报告**

```powershell
git add frontweb/e2e/redraw-workspace.spec.js docs/superpowers/reports/2026-08-07-one-click-short-drama-redraw-phase-3-gate.md
git commit -m "test: 覆盖转绘本地化与资产批次闭环"
```

## 任务 12：真实供应商与最终产品验收门禁

**文件：**

- 修改：`docs/superpowers/reports/2026-08-07-one-click-short-drama-redraw-phase-3-gate.md`

- [ ] **步骤 1：执行授权检查**

只有同时满足以下条件才继续真实调用：用户明确授权付费调用；目标环境存在目标 Key；目标模型已经有符合 AGENTS.md 的真实生成验证记录；本次调用不会写生产业务数据。任一不满足时停止本任务，报告 `blocked`，不把自动化结果升级为真实验收。

- [ ] **步骤 2：执行同次真实本地化与资产生成**

使用一个隔离测试租户完成：源片分析结果确认 → 英文剧本本地化 → 人物图 → 场景空镜 → 道具图 → 英文语音。记录不含密钥的内部任务 ID、真实供应商任务 ID、成功终态、资产 ID、文件可读性、尺寸或音频时长、模型和积分记录。

- [ ] **步骤 3：执行浏览器最终闭环**

从真实上传页面完成第二次确认、资产总价确认、资产审核、视频生成、成片播放与下载。必须证明最终英文台词和镜头时间轴来自同一目标版本；只打开历史成片或供应商后台不算闭环。

- [ ] **步骤 4：写入最终证据结论**

只有真实供应商和浏览器闭环同时通过，才把报告改为 `productComplete=true`。若供应商完成但文件不可读、账本未结算、资产未审核、视频不可播放或下载失败，保持 `blocked/partial` 并精确记录断点。

- [ ] **步骤 5：提交验收报告**

```powershell
git add docs/superpowers/reports/2026-08-07-one-click-short-drama-redraw-phase-3-gate.md
git commit -m "docs: 记录转绘真实供应商验收证据"
```

## 计划完成判定

实施任务 1–11 完成且自动化回归通过，只能称为“本地实现和非付费合同闭环完成”。任务 12 必须在获得明确授权后单独执行；其真实产物、计费和浏览器证据齐全之前，不得称为“1:1 完全替换产品完成”，也不得发布生产。
