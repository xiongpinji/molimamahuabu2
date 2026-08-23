# 供应商任务不可变凭证与普通视频安全对账实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在普通生成链路中提交前固化供应商任务凭证，并允许管理员对证据完整的异步视频执行一次安全、幂等且不重提的状态对账。

**架构：** 继续以 `generation_route_requests` / `generation_route_attempts` 作为唯一路由事实源，为尝试增加配置指纹、查询协议和持久化对账租约。新建窄职责 `providerTaskReconciliationService` 负责门禁、claim、单次查询和 CAS 收口；视频产物下载与校验复用 `videoService` 的现有能力，但数据库终态、积分、成本和审计只在短事务中提交。积分状态只从既有用户/租户预扣表读取，不在路由表复制第二份结算状态。

**技术栈：** Node.js CommonJS、Express、better-sqlite3、Node `node:test`、现有供应商路由/视频客户端/积分账本/成本账本/审计服务。

---

## 文件结构与职责

**创建：**

- `backend-node/migrations/64_provider_task_receipt_reconciliation.sql`：新增凭证、claim、租约、检查时间、索引和数据库级不可变触发器。
- `backend-node/src/services/providerTaskReconciliationService.js`：普通异步视频的可对账门禁、原子 claim、一次查询、CAS 终态和安全 DTO。
- `backend-node/test/providerTaskReconciliation.test.js`：门禁、并发、结果分类、事务回滚、迟到响应、积分和敏感信息主测试。
- `backend-node/test/providerTaskAdminRoutes.test.js`：管理员 RBAC、空请求体和安全响应测试。
- `deploy/release-scopes/provider-task-receipt-reconciliation-20260822.json`：本轮精确增量发布白名单。
- `docs/verification/platform-stability/provider-task-receipt-reconciliation-20260822.md`：同候选验证证据。

**修改：**

- `backend-node/src/services/providerRouteStabilityService.js`：提交前生成并保存不可变凭证；安全绑定任务号。
- `backend-node/src/services/videoClient.js`：把实际解析的查询协议交给 `startAttempt`；保持现有单次查询入口。
- `backend-node/src/services/videoService.js`：拆出无数据库写入的产物暂存，以及事务内成功/失败应用函数。
- `backend-node/src/routes/providerStability.js`：添加普通请求对账 handler 和错误映射。
- `backend-node/src/routes/index.js`：在现有管理员/计费双权限下注册新端点。
- `backend-node/test/providerRouteSchema.test.js`：锁定迁移幂等、列、索引与不可变触发器。
- `backend-node/test/providerRouteStability.test.js`：锁定提交前凭证和任务号只写一次。
- `backend-node/test/providerRouteVideoIntegration.test.js`：锁定真实视频路由传入规范化查询协议且未知不重提。
- `backend-node/test/featureLockManifest.test.js`：锁定本轮受保护路径、影响测试、证据和批准解锁记录。
- `backend-node/test/incrementalReleaseScope.test.js`：锁定精确发布白名单并拒绝同数量偷换。
- `docs/verification/platform-stability/feature-lock-manifest.json`：增量更新受影响功能锁。

**明确不修改：**

- 图片、文本和视频供应商提交请求形状；
- `creditLedgerService` 的账本语义；
- 主动巡检 `provider_canary_*` 表和对账接口；
- 前端用户目录、画布 UI、AI 音乐、生产数据库和共享发布门禁。

### 任务 1：迁移与数据库级不可变凭证

**文件：**

- 创建：`backend-node/migrations/64_provider_task_receipt_reconciliation.sql`
- 修改：`backend-node/test/providerRouteSchema.test.js`

- [ ] **步骤 1：编写失败的迁移合同测试**

在 `providerRouteSchema.test.js` 增加以下断言：

```js
test('provider task receipt migration is idempotent and locks receipt identity', () => {
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    runMigrationsAndEnsure(db);
    const columns = columnNames(db, 'generation_route_attempts');
    for (const name of [
      'config_fingerprint', 'query_protocol', 'reconcile_claim_token',
      'reconcile_lease_until', 'reconcile_checked_at',
    ]) assert.equal(columns.has(name), true, `missing ${name}`);
    assert.equal(indexNames(db, 'generation_route_attempts')
      .has('idx_generation_route_attempts_reconcile'), true);

    const now = '2026-08-22T00:00:00.000Z';
    db.prepare(`INSERT INTO generation_route_requests
      (id, idempotency_key, service_type, business_type, logical_model_id,
       capability_fingerprint, candidate_config_ids, state, created_at, updated_at)
      VALUES ('receipt-route-1', 'receipt-idempotency-1', 'video', 'video_generation',
       'seedance-2.0-fast', '{}', '[1]', 'running', ?, ?)`).run(now, now);
    const fixture = db.prepare(`INSERT INTO generation_route_attempts
      (request_id, attempt_no, config_id, provider, upstream_model, state,
       config_fingerprint, query_protocol, started_at)
      VALUES ('receipt-route-1', 1, 1, 'toapis', 'seedance-2.0-fast',
       'submitting', ?, 'toapis_video', ?)`)
      .run('a'.repeat(64), now);
    const attemptId = Number(fixture.lastInsertRowid);
    assert.throws(() => db.prepare(`UPDATE generation_route_attempts
      SET config_fingerprint = ? WHERE id = ?`).run('b'.repeat(64), attemptId),
    /provider receipt identity is immutable/);
    db.prepare(`UPDATE generation_route_attempts SET provider_task_id = ? WHERE id = ?`)
      .run('provider-task-1', attemptId);
    assert.throws(() => db.prepare(`UPDATE generation_route_attempts
      SET provider_task_id = ? WHERE id = ?`).run('provider-task-2', attemptId),
    /provider task id is immutable/);
  } finally {
    db.close();
  }
});
```

该测试直接写入最小路由请求和 attempt，不依赖网络、生产配置或真实密钥。

- [ ] **步骤 2：运行测试并确认红灯**

运行：

```powershell
cd backend-node
node --test test/providerRouteSchema.test.js
```

预期：FAIL；缺少 5 个列、索引和触发器，而不是夹具或语法错误。

- [ ] **步骤 3：写入最小迁移**

`64_provider_task_receipt_reconciliation.sql` 使用以下完整结构：

```sql
ALTER TABLE generation_route_attempts ADD COLUMN config_fingerprint TEXT;
ALTER TABLE generation_route_attempts ADD COLUMN query_protocol TEXT;
ALTER TABLE generation_route_attempts ADD COLUMN reconcile_claim_token TEXT;
ALTER TABLE generation_route_attempts ADD COLUMN reconcile_lease_until TEXT;
ALTER TABLE generation_route_attempts ADD COLUMN reconcile_checked_at TEXT;

CREATE INDEX IF NOT EXISTS idx_generation_route_attempts_reconcile
  ON generation_route_attempts(request_id, state, reconcile_lease_until);

CREATE TRIGGER IF NOT EXISTS trg_generation_route_attempts_receipt_identity_immutable
BEFORE UPDATE OF config_id, provider, upstream_model, config_fingerprint, query_protocol
ON generation_route_attempts
WHEN OLD.config_id IS NOT NEW.config_id
  OR OLD.provider IS NOT NEW.provider
  OR OLD.upstream_model IS NOT NEW.upstream_model
  OR OLD.config_fingerprint IS NOT NEW.config_fingerprint
  OR OLD.query_protocol IS NOT NEW.query_protocol
BEGIN
  SELECT RAISE(ABORT, 'provider receipt identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_generation_route_attempts_provider_task_immutable
BEFORE UPDATE OF provider_task_id ON generation_route_attempts
WHEN OLD.provider_task_id IS NOT NULL
  AND OLD.provider_task_id IS NOT NEW.provider_task_id
BEGIN
  SELECT RAISE(ABORT, 'provider task id is immutable');
END;
```

不更新旧行；迁移执行器现有的重复列兼容逻辑继续负责第二次运行。

- [ ] **步骤 4：运行迁移测试确认绿灯**

运行：

```powershell
cd backend-node
node --test test/providerRouteSchema.test.js
```

预期：全部 PASS。

- [ ] **步骤 5：提交任务 1**

```powershell
git add backend-node/migrations/64_provider_task_receipt_reconciliation.sql backend-node/test/providerRouteSchema.test.js
git commit -m "feat(稳定性): 增加供应商任务不可变凭证"
```

### 任务 2：在供应商提交前持久化配置指纹与查询协议

**文件：**

- 修改：`backend-node/src/services/providerRouteStabilityService.js`
- 修改：`backend-node/src/services/videoClient.js`
- 修改：`backend-node/test/providerRouteStability.test.js`
- 修改：`backend-node/test/providerRouteVideoIntegration.test.js`

- [ ] **步骤 1：编写提交前凭证红灯测试**

在 `providerRouteStability.test.js` 增加：

```js
test('startAttempt persists a config-bound receipt before provider submission', () => {
  const db = createDb();
  const configId = addConfig(db, {
    service_type: 'video', provider: 'toapis', default_model: 'seedance-2.0-fast',
  });
  const route = stability.createOrGetRouteRequest(db, {
    id: 'receipt-route-1', idempotencyKey: 'receipt-idempotency-1',
    serviceType: 'video', businessType: 'video_generation',
    logicalModelId: 'logical-image', candidateConfigIds: [configId], now: NOW,
  });
  const attempt = stability.startAttempt(db, {
    requestId: route.id,
    configId,
    provider: 'toapis',
    upstreamModel: 'seedance-2.0-fast',
    queryProtocol: 'toapis_video',
    now: NOW,
  });
  assert.equal(attempt.query_protocol, 'toapis_video');
  assert.match(attempt.config_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(attempt.provider_task_id, null);
});

test('recordAcceptedTask only binds the same provider task id once', () => {
  const db = createDb();
  const configId = addConfig(db, { service_type: 'video', provider: 'toapis' });
  const route = stability.createOrGetRouteRequest(db, {
    id: 'accepted-route-1', idempotencyKey: 'accepted-idempotency-1',
    serviceType: 'video', businessType: 'video_generation',
    logicalModelId: 'logical-image', candidateConfigIds: [configId], now: NOW,
  });
  stability.startAttempt(db, {
    requestId: route.id, configId, provider: 'toapis',
    upstreamModel: 'seedance-2.0-fast', queryProtocol: 'toapis_video', now: NOW,
  });
  stability.recordAcceptedTask(db, {
    requestId: route.id,
    attemptNo: 1,
    providerTaskId: 'provider-task-1',
  });
  assert.doesNotThrow(() => stability.recordAcceptedTask(db, {
    requestId: route.id,
    attemptNo: 1,
    providerTaskId: 'provider-task-1',
  }));
  assert.throws(() => stability.recordAcceptedTask(db, {
    requestId: route.id,
    attemptNo: 1,
    providerTaskId: 'provider-task-2',
  }), { code: 'PROVIDER_TASK_RECEIPT_CONFLICT' });
});
```

在 `providerRouteVideoIntegration.test.js` 的本地假供应商提交断言中，检查 HTTP handler 被调用前数据库已经存在 64 位指纹和 `query_protocol`，并检查提交结果未知时没有创建第二个 attempt。

- [ ] **步骤 2：运行聚焦测试并确认红灯**

```powershell
cd backend-node
node --test test/providerRouteStability.test.js test/providerRouteVideoIntegration.test.js
```

预期：FAIL；`startAttempt` 未写凭证且任务号覆盖未被服务层拒绝。

- [ ] **步骤 3：实现统一凭证构造与安全任务号绑定**

在 `providerRouteStabilityService.js` 增加并导出同一构造器：

```js
function buildAttemptReceipt(db, input) {
  const config = aiConfigService.getConfig(db, input.configId);
  if (!config) {
    const error = new Error('供应商配置不存在');
    error.code = 'PROVIDER_TASK_CONFIG_NOT_FOUND';
    throw error;
  }
  const queryProtocol = String(
    input.queryProtocol || config.api_protocol || config.provider || 'auto',
  ).trim().toLowerCase() || 'auto';
  const upstreamModel = String(input.upstreamModel || config.default_model || '').trim();
  const configFingerprint = evidenceService.configFingerprint({
    serviceType: input.serviceType || config.service_type,
    apiKey: String(config.api_key || ''),
    baseUrl: String(config.base_url || ''),
    protocol: queryProtocol,
    provider: String(config.provider || ''),
    upstreamModel,
    capabilities: capabilitiesForConfig({ ...config, default_model: upstreamModel }),
  });
  return { config, upstreamModel, queryProtocol, configFingerprint };
}
```

`startAttempt` 必须先读取路由的 `service_type`，调用 `buildAttemptReceipt`，再执行：

```js
db.prepare(`INSERT INTO generation_route_attempts
  (request_id, attempt_no, config_id, provider, upstream_model, state,
   config_fingerprint, query_protocol, started_at)
  VALUES (?, ?, ?, ?, ?, 'submitting', ?, ?, ?)`)
  .run(input.requestId, attemptNo, input.configId, input.provider,
    receipt.upstreamModel, receipt.configFingerprint, receipt.queryProtocol, now);
```

`recordAcceptedTask` 改为先读取当前值，只允许 `NULL -> taskId` 或相同 `taskId -> taskId`；冲突时抛出 `PROVIDER_TASK_RECEIPT_CONFLICT`，不得修改路由状态。

在 `videoClient.js` 的视频路线 `startAttempt` 调用增加：

```js
queryProtocol: resolveVideoProtocol(config),
```

图片和文本继续由 `buildAttemptReceipt` 从实际配置规范化协议，不改变其请求体。

- [ ] **步骤 4：运行提交前凭证与既有路由回归**

```powershell
cd backend-node
node --test test/providerRouteStability.test.js test/providerRouteVideoIntegration.test.js test/providerRouteImageIntegration.test.js test/providerRouteTextIntegration.test.js
```

预期：全部 PASS；图片、视频、文本请求形状和原 failover 行为保持不变。

- [ ] **步骤 5：提交任务 2**

```powershell
git add backend-node/src/services/providerRouteStabilityService.js backend-node/src/services/videoClient.js backend-node/test/providerRouteStability.test.js backend-node/test/providerRouteVideoIntegration.test.js
git commit -m "feat(稳定性): 提交前固化供应商线路凭证"
```

### 任务 3：拆出无数据库副作用的视频产物暂存

**文件：**

- 修改：`backend-node/src/services/videoService.js`
- 创建：`backend-node/test/providerTaskReconciliation.test.js`

- [ ] **步骤 1：编写产物暂存红灯测试**

在新测试中用临时 storage 和最小 MP4 fixture 验证：

测试文件先定义固定夹具合同，后续所有用例只通过该合同构造状态：

- `setupReconciliationFixture(t, overrides = {})`：内存 SQLite 运行全部迁移；创建一部 drama、episode、storyboard；创建一个 `video` 配置（`provider=toapis`、`api_protocol=toapis_video`、短测试 Key、固定模型）；为 `user-reconcile` 建立余额并预扣；创建一条 video generation 和 async task，并把二者状态设为 `needs_attention`；创建路由请求与一次含 64 位配置指纹、固定协议及任务号的 accepted attempt；创建临时 storage 并在 `t.after` 中关闭数据库和只删除该临时目录。返回 `{ db, log, config, video, task, route, attempt, reservation, storagePath }`。
- `fixtureVideoFetch()`：只返回一次 `200`，`arrayBuffer()` 返回 `require('./fixtures/media').MINIMAL_MP4`；不发网络请求。
- `databaseSnapshot(db)`：以稳定排序返回 `video_generations`、`async_tasks`、`generation_route_requests`、`generation_route_attempts`、用户/租户预扣、成本、稳定性事件和审计事件的 JSON 值；不得包含临时文件系统状态。
- `getReservation/getVideo/getRoute/countSafeEvents/countAuditEvents`：都按上述夹具主键执行单行或 `COUNT(*)` 查询，不接受任意 SQL。

测试夹具中的 Key 只能使用短字符串 `test-key`，URL 只能使用 `.example`；不得读取生产环境变量。

```js
test('prepareReconciledVideoArtifact validates and stages a readable video without database writes', async (t) => {
  const state = setupReconciliationFixture(t);
  const before = databaseSnapshot(state.db);
  const prepared = await videoService.prepareReconciledVideoArtifact(
    state.db,
    state.log,
    state.video,
    'https://artifact.example/video.mp4',
    state.config,
    { storagePath: state.storagePath, fetchImpl: fixtureVideoFetch },
  );
  assert.match(prepared.localPath, /^projects\/[^/]+\/videos\/vg_/);
  assert.equal(fs.statSync(path.join(state.storagePath, prepared.localPath)).size > 0, true);
  assert.deepEqual(databaseSnapshot(state.db), before);
  videoService.discardReconciledVideoArtifact(prepared);
  assert.equal(fs.existsSync(path.join(state.storagePath, prepared.localPath)), false);
});
```

再加入 HTTP 非 2xx、伪 MP4、文件写入失败三项反例，均不得改变数据库。

- [ ] **步骤 2：运行测试并确认红灯**

```powershell
cd backend-node
node --test --test-name-pattern="prepareReconciledVideoArtifact" test/providerTaskReconciliation.test.js
```

预期：FAIL；两个导出不存在。

- [ ] **步骤 3：在现有视频服务中增加窄包装函数**

实现并导出：

```js
async function prepareReconciledVideoArtifact(db, log, row, artifactUrl, providerConfig, options = {}) {
  const storagePath = options.storagePath || resolveStoragePath(require('../config').loadConfig());
  const projectSubdir = storageLayout.getProjectStorageSubdir(db, row.drama_id);
  const fetchOptions = {
    ...videoClient.getVideoArtifactFetchOptions(providerConfig, artifactUrl),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  };
  const downloaded = await downloadVideoToLocal(
    storagePath, artifactUrl, row.id, log, projectSubdir, fetchOptions,
  );
  if (!downloaded.localPath) {
    const error = new Error('视频产物不可读取');
    error.code = 'PROVIDER_TASK_ARTIFACT_UNREADABLE';
    throw error;
  }
  maybeNormalizeVideoAfterDownload(storagePath, downloaded.localPath, row, row.id, log);
  return {
    storagePath,
    localPath: downloaded.localPath,
    videoUrl: artifactUrl,
    boundaryFrames: extractVideoBoundaryFrames(storagePath, downloaded.localPath, row.id, log),
  };
}

function discardReconciledVideoArtifact(prepared) {
  const storagePath = prepared?.storagePath;
  if (!storagePath) return;
  for (const value of [
    prepared?.localPath,
    prepared?.boundaryFrames?.output_first_frame_url,
    prepared?.boundaryFrames?.output_last_frame_url,
  ]) {
    const relative = String(value || '').replace(/^\/static\//, '');
    if (!relative) continue;
    const absolute = path.resolve(storagePath, relative);
    const root = path.resolve(storagePath);
    if (absolute !== root && absolute.startsWith(`${root}${path.sep}`)) fs.rmSync(absolute, { force: true });
  }
}
```

同时把 `downloadVideoToLocal` 中网络调用改为：

```js
const fetchImpl = fetchOptions.fetchImpl || fetch;
const { fetchImpl: _fetchImpl, ...requestOptions } = fetchOptions;
const res = await fetchImpl(videoUrl, { method: 'GET', ...requestOptions });
```

该改动只增加依赖注入，不改变生产默认 `fetch`。

- [ ] **步骤 4：运行产物与现有视频完成回归**

```powershell
cd backend-node
node --test test/providerTaskReconciliation.test.js test/videoArtifactAuth.test.js test/videoBilling.test.js test/providerRouteVideoIntegration.test.js
```

预期：全部 PASS。

- [ ] **步骤 5：提交任务 3**

```powershell
git add backend-node/src/services/videoService.js backend-node/test/providerTaskReconciliation.test.js
git commit -m "refactor(视频): 拆出对账产物暂存边界"
```

### 任务 4：实现一次查询、持久 claim 和原子终态收口

**文件：**

- 创建：`backend-node/src/services/providerTaskReconciliationService.js`
- 修改：`backend-node/src/services/videoService.js`
- 修改：`backend-node/test/providerTaskReconciliation.test.js`

- [ ] **步骤 1：编写对账状态机红灯测试**

在 `providerTaskReconciliation.test.js` 增加以下合同：

```js
test('reconcileRequest performs one query and confirms readable success atomically', async (t) => {
  const state = setupReconciliationFixture(t);
  let queryCount = 0;
  const result = await reconciliation.reconcileRequest(state.db, state.log, state.route.id, {
    now: NOW,
    storagePath: state.storagePath,
    queryTaskStatusOnce: async () => {
      queryCount += 1;
      return { state: 'succeeded', artifactUrl: 'https://artifact.example/video.mp4' };
    },
    fetchImpl: fixtureVideoFetch,
  });
  assert.equal(queryCount, 1);
  assert.deepEqual(result, {
    request_id: state.route.id,
    task_state: 'completed',
    error_category: null,
    reconciled: true,
    reconcilable: false,
    credit_state: 'confirmed',
    checked_at: NOW,
  });
  assert.equal(getReservation(state.db).status, 'confirmed');
  assert.equal(getVideo(state.db).status, 'completed');
  assert.equal(getRoute(state.db).state, 'succeeded');
  assert.equal(countSafeEvents(state.db), 1);
  assert.equal(countAuditEvents(state.db), 1);
});
```

同文件还必须逐项先红：

- 缺任务号、缺配置指纹、图片服务、非 `needs_attention`、业务记录缺失、积分非 held：查询计数 0；
- 当前 Key、Base URL、协议、供应商、模型或能力改变：查询计数 0；
- 两个数据库连接并发触发：查询计数 1；
- 未过期 120 秒 lease 和 60 秒 debounce：查询计数 0；
- 明确失败：退款一次，重复请求 0 查询/0 新事件；
- processing、timeout、401、403、404、408、429、5xx、非 JSON、重定向、成功无直链、产物不可读：保持 held；
- 任一终态写入被触发器阻断：路由、媒体、任务、积分、成本、事件和审计全部回滚；
- 旧 claim 迟到：CAS 失败、清理暂存产物、不得覆盖新状态。

- [ ] **步骤 2：运行主测试并确认红灯**

```powershell
cd backend-node
node --test test/providerTaskReconciliation.test.js
```

预期：FAIL；新服务缺失，对账合同尚未实现。

- [ ] **步骤 3：实现可对账门禁与 claim**

新服务使用固定常量并只返回安全 DTO：

```js
const RECONCILE_LEASE_MS = 120_000;
const RECONCILE_DEBOUNCE_MS = 60_000;

function safeResult(db, requestId) {
  const row = loadReconciliationState(db, requestId);
  return {
    request_id: row.request_id,
    task_state: row.video_status,
    error_category: row.error_category || null,
    reconciled: ['succeeded', 'failed'].includes(row.route_state),
    reconcilable: row.reconcilable === true,
    credit_state: row.credit_state || null,
    checked_at: row.reconcile_checked_at || null,
  };
}
```

`claimForReconciliation` 在 `db.transaction(...).immediate()` 内：

1. 查询最新 attempt、video、async task 和权威预扣；
2. 校验服务类型、`needs_attention`、任务号、配置 ID、指纹、协议和 held；
3. 读取当前配置，调用 `buildAttemptReceipt` 重新计算指纹；
4. 使用 `videoClient.resolveVideoProtocol(config)` 比较固定协议；
5. 以 `WHERE reconcile_claim_token IS NULL OR reconcile_lease_until <= now` 原子写入随机 token 和 lease；
6. 返回内部 claim，不把任务号、配置或指纹放入公开 DTO。

- [ ] **步骤 4：实现单次查询与三类结果收口**

核心流程固定为：

```js
async function reconcileRequest(db, log, requestId, options = {}) {
  const claim = claimForReconciliation(db, requestId, options);
  if (!claim.acquired) return safeResult(db, requestId);

  const query = options.queryTaskStatusOnce || videoClient.queryVideoTaskStatusOnce;
  const outcome = await query(db, safeLogger(log), claim.providerTaskId, claim.config, {
    fetchImpl: options.queryFetchImpl,
  });

  let prepared = null;
  if (outcome.state === 'succeeded') {
    try {
      prepared = await videoService.prepareReconciledVideoArtifact(
        db, safeLogger(log), claim.video, outcome.artifactUrl, claim.config, options,
      );
    } catch (_) {
      return finishUnknown(db, claim, 'artifact_unreadable', options.now);
    }
  }

  try {
    return finishWithCas(db, claim, outcome, prepared, options.now);
  } catch (error) {
    if (prepared) videoService.discardReconciledVideoArtifact(prepared);
    throw error;
  }
}
```

`finishWithCas` 必须在一个 immediate transaction 内先用 claim token、请求 ID、attempt no 和任务号做 CAS，然后：

- `succeeded`：调用 `videoService.applyReconciledVideoSuccess`，更新 attempt/request，确认积分、记录 route cost、写一次 `provider_task_reconciled` 和一次 `generation.video.reconciled` 审计；
- `failed` 且 category 为 `provider_task_failed`：调用 `applyReconciledVideoFailure`，退款并写一次事件/审计；
- 其他结果：保持 video/task/request 为 `needs_attention`、积分 held，只写安全 category、checked_at，释放 claim；
- 任何写入异常整体回滚；终态重复调用直接返回 `safeResult`。

`applyReconciledVideoSuccess` / `applyReconciledVideoFailure` 必须复用现有 `taskService`、`creditLedger`、`generationCost` 和 `auditEvent`，不捕获并吞掉账本异常。

- [ ] **步骤 5：运行状态机与相关账本回归**

```powershell
cd backend-node
node --test test/providerTaskReconciliation.test.js test/videoQueryTaskStatusOnce.test.js test/videoBilling.test.js test/generationRouteCostLedger.test.js test/creditLedger.test.js test/providerReconciliation.test.js
```

预期：全部 PASS；测试中的 provider submit stub 调用次数恒为 0。

- [ ] **步骤 6：提交任务 4**

```powershell
git add backend-node/src/services/providerTaskReconciliationService.js backend-node/src/services/videoService.js backend-node/test/providerTaskReconciliation.test.js
git commit -m "feat(稳定性): 安全对账普通异步视频任务"
```

### 任务 5：管理员对账接口与安全响应

**文件：**

- 修改：`backend-node/src/routes/providerStability.js`
- 修改：`backend-node/src/routes/index.js`
- 创建：`backend-node/test/providerTaskAdminRoutes.test.js`

- [ ] **步骤 1：编写 RBAC 与 DTO 红灯测试**

使用本地 Express 和内存 SQLite：

测试文件必须显式定义以下两个 helper：

```js
async function request(baseUrl, endpoint, { method = 'POST', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
```

`setupAdminRouteFixture(t)` 使用内存 SQLite 运行迁移，创建普通用户和同时具有管理员/计费权限的用户，调用 `setupRouter` 挂载 `/api/v1`，通过 `server.listen(0, '127.0.0.1')` 启动本地服务，并在 `t.after` 中关闭 server/database；它复用对账主测试相同的证据完整 `needs_attention` 视频数据，返回 `{ baseUrl, endpoint, userToken, adminToken }`，其中 endpoint 使用固定夹具请求 ID `fixture-route-1` 拼成 `/api/v1/admin/provider-stability/requests/fixture-route-1/reconcile`。Token 只使用本地固定测试 secret 签发。

```js
test('provider task reconcile route requires admin billing permission and empty body', async (t) => {
  const state = await setupAdminRouteFixture(t);
  assert.equal((await request(state.baseUrl, state.endpoint)).status, 401);
  assert.equal((await request(state.baseUrl, state.endpoint, { token: state.userToken })).status, 403);
  assert.equal((await request(state.baseUrl, state.endpoint, {
    method: 'POST', token: state.adminToken, body: { provider_task_id: 'forbidden' },
  })).status, 400);
  const response = await request(state.baseUrl, state.endpoint, {
    method: 'POST', token: state.adminToken, body: {},
  });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body.data).sort(), [
    'checked_at', 'credit_state', 'error_category', 'reconcilable',
    'reconciled', 'request_id', 'task_state',
  ]);
  assert.doesNotMatch(JSON.stringify(response.body),
    /provider_task|config_fingerprint|api[_-]?key|authorization|https?:\/\//i);
});
```

另加无效 request ID、记录不存在、证据不完整 409、服务异常 500 只返回通用文案四项。

- [ ] **步骤 2：运行路由测试确认红灯**

```powershell
cd backend-node
node --test test/providerTaskAdminRoutes.test.js
```

预期：FAIL；端点未注册。

- [ ] **步骤 3：添加 handler 与路由**

在 `providerStability.js` 引入新服务并加入：

```js
async reconcileProviderTask(req, res) {
  if (Object.keys(req.body || {}).length > 0) {
    return response.badRequest(res, '普通任务对账不接受客户端状态、任务号或配置字段');
  }
  try {
    const result = await providerTaskReconciliation.reconcileRequest(
      db, log, req.params.requestId, {
        actorId: req.user?.id,
        storagePath: options.storageRoot,
        ...options.providerTaskReconciliation,
      },
    );
    return response.success(res, result);
  } catch (error) {
    if (error.code === 'PROVIDER_TASK_REQUEST_INVALID') {
      return response.badRequest(res, '普通生成请求 ID 无效');
    }
    if (error.code === 'PROVIDER_TASK_REQUEST_NOT_FOUND') {
      return response.notFound(res, '普通生成请求不存在');
    }
    if (error.code === 'PROVIDER_TASK_NOT_RECONCILABLE') {
      return response.error(res, 409, error.code, '该普通生成请求当前不可对账');
    }
    log.error('provider task reconciliation failed', {
      request_id: req.params.requestId,
      code: error.code || 'UNKNOWN',
    });
    return response.internalError(res, '普通生成任务对账失败');
  }
}
```

在 `routes/index.js` 的既有管理员稳定性路由组加入：

```js
r.post('/admin/provider-stability/requests/:requestId/reconcile',
  requireAdmin, requireBillingManager, providerStability.reconcileProviderTask);
```

不注册任何用户端路由，不接受客户端 task/config/provider 字段。

- [ ] **步骤 4：运行管理员与既有稳定性路由回归**

```powershell
cd backend-node
node --test test/providerTaskAdminRoutes.test.js test/providerRouteAdminRoutes.test.js test/providerCanaryAdminRoutes.test.js
```

预期：全部 PASS。

- [ ] **步骤 5：提交任务 5**

```powershell
git add backend-node/src/routes/providerStability.js backend-node/src/routes/index.js backend-node/test/providerTaskAdminRoutes.test.js
git commit -m "feat(管理端): 增加普通视频任务安全对账"
```

### 任务 6：安全审计与全量回归

**文件：**

- 修改：仅在本轮新增测试发现真实合同缺口时修改任务 1—5 已列文件；不得扩大到前端、主动巡检或 AI 音乐。

- [ ] **步骤 1：运行精确功能集**

```powershell
cd backend-node
node --test test/providerRouteSchema.test.js test/providerRouteStability.test.js test/providerRouteVideoIntegration.test.js test/providerTaskReconciliation.test.js test/providerTaskAdminRoutes.test.js test/videoQueryTaskStatusOnce.test.js test/videoBilling.test.js test/generationRouteCostLedger.test.js test/creditLedger.test.js test/providerReconciliation.test.js test/providerCanaryAdminRoutes.test.js
```

预期：全部 PASS，0 fail。

- [ ] **步骤 2：运行供应商路线与图片/文本不回归集**

```powershell
cd backend-node
node --test test/providerRouteImageIntegration.test.js test/providerRouteTextIntegration.test.js test/imageBilling.test.js test/openAIImageOutput.test.js test/text-generation-billing.test.js test/toapisVideoIntegration.test.js test/feituoVideoModels.test.js
```

预期：全部 PASS，证明凭证改动没有改变提交协议、自动切换边界或计费。

- [ ] **步骤 3：运行后端全量测试**

```powershell
cd backend-node
npm test
```

预期：退出码 0；所有非显式 skip 测试通过。

- [ ] **步骤 4：执行语法、差异和秘密扫描**

```powershell
node --check backend-node/src/services/providerTaskReconciliationService.js
node --check backend-node/src/services/providerRouteStabilityService.js
node --check backend-node/src/services/videoClient.js
node --check backend-node/src/services/videoService.js
node --check backend-node/src/routes/providerStability.js
node --check backend-node/src/routes/index.js
git diff --check HEAD^
git diff HEAD^ -- . | rg -n "sk-[A-Za-z0-9]{16,}|Bearer [A-Za-z0-9._-]{12,}|Authorization.{0,40}[A-Za-z0-9._-]{16,}"
```

预期：语法与 diff 退出码 0；秘密扫描无真实凭据命中。若只命中测试规则本身，必须在验证文档逐条解释文件与行号。

- [ ] **步骤 5：提交仅由回归暴露的最小修复**

若步骤 1—4 没有产生修改，不创建空提交；若产生修改：

```powershell
git status --short
# 逐项核对上一步输出后，只对任务 1—5 已列且本轮真实修改的路径执行 git add -p
git commit -m "fix(稳定性): 收口供应商任务对账回归"
```

### 任务 7：功能锁、精确发布范围与同批证据

**文件：**

- 修改：`docs/verification/platform-stability/feature-lock-manifest.json`
- 修改：`backend-node/test/featureLockManifest.test.js`
- 创建：`deploy/release-scopes/provider-task-receipt-reconciliation-20260822.json`
- 修改：`backend-node/test/incrementalReleaseScope.test.js`
- 创建：`docs/verification/platform-stability/provider-task-receipt-reconciliation-20260822.md`

- [ ] **步骤 1：先写功能锁与精确范围红灯**

在 `featureLockManifest.test.js` 固定批准记录：

```js
const PROVIDER_TASK_RECEIPT_UNLOCK = {
  reason: '2026-08-22 供应商任务不可变凭证与安全对账规格获批',
  approvedBy: 'product-owner 2026-08-22 provider-task-receipt-reconciliation',
  impactTests: [
    'backend-node/test/providerRouteSchema.test.js',
    'backend-node/test/providerRouteStability.test.js',
    'backend-node/test/providerRouteVideoIntegration.test.js',
    'backend-node/test/providerTaskReconciliation.test.js',
    'backend-node/test/providerTaskAdminRoutes.test.js',
    'backend-node/test/videoQueryTaskStatusOnce.test.js',
    'backend-node/test/videoBilling.test.js',
    'backend-node/test/generationRouteCostLedger.test.js',
    'backend-node/test/creditLedger.test.js',
    'backend-node/test/providerReconciliation.test.js',
  ],
};
```

断言受影响的 route contract、safe failover、unknown billing、admin observability、proactive canary 五个锁都具有本次新鲜 unlock；新增服务、迁移、两份新测试和验证文档进入相应 `protectedPaths` / `requiredTests` / `evidence`，历史证据数组不得删除。

在 `incrementalReleaseScope.test.js` 加入精确常量与同数量偷换反例，白名单必须与从本分支基线到候选的实际变更文件逐项相等。

- [ ] **步骤 2：运行门禁测试确认红灯**

```powershell
cd backend-node
node --test test/featureLockManifest.test.js test/incrementalReleaseScope.test.js
```

预期：FAIL；缺少新 unlock、保护路径、影响测试、证据和发布清单。

- [ ] **步骤 3：写入精确发布清单**

`provider-task-receipt-reconciliation-20260822.json` 的 `allowedPaths` 只包含本计划实际变更文件，至少覆盖：

```json
{
  "schemaVersion": 1,
  "release": "provider-task-receipt-reconciliation-20260822",
  "allowedPaths": [
    "backend-node/migrations/64_provider_task_receipt_reconciliation.sql",
    "backend-node/src/routes/index.js",
    "backend-node/src/routes/providerStability.js",
    "backend-node/src/services/providerRouteStabilityService.js",
    "backend-node/src/services/providerTaskReconciliationService.js",
    "backend-node/src/services/videoClient.js",
    "backend-node/src/services/videoService.js",
    "backend-node/test/featureLockManifest.test.js",
    "backend-node/test/incrementalReleaseScope.test.js",
    "backend-node/test/providerRouteSchema.test.js",
    "backend-node/test/providerRouteStability.test.js",
    "backend-node/test/providerRouteVideoIntegration.test.js",
    "backend-node/test/providerTaskAdminRoutes.test.js",
    "backend-node/test/providerTaskReconciliation.test.js",
    "deploy/release-scopes/provider-task-receipt-reconciliation-20260822.json",
    "docs/superpowers/plans/2026-08-22-provider-task-receipt-reconciliation.md",
    "docs/superpowers/specs/2026-08-22-provider-task-receipt-reconciliation-design.md",
    "docs/verification/platform-stability/feature-lock-manifest.json",
    "docs/verification/platform-stability/provider-task-receipt-reconciliation-20260822.md"
  ]
}
```

若任务 6 的真实修复增减了文件，先更新此精确数组和对应深比较测试；禁止通配符、目录项、数据库、storage、assets、AI 音乐和共享 release guard。

- [ ] **步骤 4：更新锁并记录同候选验证证据**

验证文档必须记录：

- 候选 SHA 与基线 SHA；
- 每条命令、北京时间、退出码、通过/失败/skip 数；
- 红灯为何是预期功能缺失；
- 迁移重复运行结果；
- 网络查询计数、提交调用计数、积分 held/confirmed/refunded 断言；
- 敏感信息扫描每个命中的解释；
- 未执行真实供应商查询、付费、SSH、生产写入、推送、PR、部署和 enforce。

不得把本地 fixture、mock 或单元测试写成真实供应商或生产验收。

- [ ] **步骤 5：运行最终门禁与全量同候选验证**

```powershell
cd backend-node
node --test test/featureLockManifest.test.js test/incrementalReleaseScope.test.js
node scripts/verify-feature-lock-manifest.js --base origin/main
npm test
cd ..
git diff --check origin/main...HEAD
git status --short
```

预期：锁与范围测试全部 PASS；功能锁审计 `ready=true`；后端全量退出码 0；diff 无空白错误；提交前只有验证文档允许的暂存改动。

- [ ] **步骤 6：提交代码与证据的可验证边界**

先提交功能锁与范围：

```powershell
git add docs/verification/platform-stability/feature-lock-manifest.json backend-node/test/featureLockManifest.test.js deploy/release-scopes/provider-task-receipt-reconciliation-20260822.json backend-node/test/incrementalReleaseScope.test.js
git commit -m "test(稳定性): 锁定供应商任务安全对账"
```

在该候选 SHA 上重跑步骤 5，把真实输出写入验证文档，再单独提交证据：

```powershell
git add docs/verification/platform-stability/provider-task-receipt-reconciliation-20260822.md
git commit -m "docs(稳定性): 记录供应商任务对账验证证据"
```

证据提交后再次运行功能锁、精确范围、`git diff --check origin/main...HEAD` 和 `git status --short`；工作树必须干净。

## 完成判定

只有以下条件同时满足才可报告“本地实现完成”：

1. 新任务从第一次 attempt 开始具有不可变配置指纹与查询协议；
2. 任务号只允许空值写入一次，冲突写入被数据库和服务层同时拒绝；
3. 只有证据完整的普通异步视频可执行一次状态查询；
4. 成功必须伴随可读本地产物与原子积分确认；明确任务失败才退款；其余保持 held；
5. 并发、重启租约、去抖、迟到响应和写入失败测试全部通过；
6. 管理员接口满足 RBAC、空体和安全 DTO；普通用户无新增接口；
7. 后端全量、功能锁、精确发布范围、语法、diff 和秘密扫描全部通过；
8. 验证文档明确标注未执行的生产、真实供应商、付费、推送和部署门禁。

本地完成不等于 Hosted CI、真实供应商验证、生产迁移或线上稳定验收；这些动作仍需独立授权和受保护发布流程。
