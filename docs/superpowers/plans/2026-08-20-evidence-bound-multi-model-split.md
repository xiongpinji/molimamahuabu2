# 逐模型证据绑定零中断拆分实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为现有多模型供应商配置增加一个默认关闭、证据绑定、原子回滚的拆分模式，使 ToAPIs FAST/MINI 能分别绑定逻辑模型、真实证据、能力和线路成本，同时保持 `shadow` 用户目录不丢模型且不自动付费巡检。

**架构：** 保留 `split-multi-model-provider-configs.js` 的 dry-run 和普通 `--apply` 语义，在同一 CLI 中增加独立的 `--apply-evidence-bound` 分支。新分支先用纯校验器核对绑定文件、用户积分价格、受保护真实证据和线路成本，再在一个 SQLite `IMMEDIATE` 事务内重新校验、缩窄源配置、创建已验证克隆、写逐线路成本、失效旧巡检证据并记录脱敏审计。所有公开路由、目录和巡检行为继续复用现有服务，不增加 HTTP 接口或生产自动化入口。

**技术栈：** Node.js 20、CommonJS、better-sqlite3、node:test、现有 `providerRouteCostService`、`externalModelEvidenceService`、`auditEventService`、主动巡检功能锁和增量发布白名单。

---

## 固定上下文与边界

- 工作树固定为 `C:\Users\canqu\Documents\茉莉妈妈2\worktrees\platform-stability-proactive-canary-plan-20260818`。
- 设计依据固定为 `docs/superpowers/specs/2026-08-20-evidence-bound-multi-model-split-design.md`。
- 首个生产目标是配置 16 的 `seedance-2-fast` 与 `seedance-2-mini`；本计划只实现和验证通用合同，不执行生产数据库写入。
- 现有普通 `--apply` 必须继续创建停用、未验证、无逻辑模型绑定的克隆。
- 新模式只接受受保护证据根中可重新读取并通过 SHA-256 校验的逐模型证据；数据库字段与绑定文件互相一致仍不足以单独放行。
- 新模式必须把 `verified_capabilities` 和 `settings.canvas_capabilities_by_model` 都缩窄到当前模型，防止目录、路由或调度器串用另一模型能力。
- 所有最终线路强制 `canary_paused=1`；不启用 `enforce`，不调用供应商，不产生费用，不修改生产数据，不触碰 AI 音乐。
- 成功标准是本地临时 SQLite 的同批 TDD、完整后端回归、前端无改动回归、功能锁和范围审计全部通过；只能报告“本地候选通过”。

## 文件结构

### 生产代码

- 修改 `backend-node/src/services/providerRouteCostService.js`：导出纯线路成本规范化函数，供写事务前和事务内复用同一校验。
- 修改 `backend-node/scripts/split-multi-model-provider-configs.js`：解析新 CLI 模式、读取严格绑定文件、执行双重资格校验和原子拆分；普通模式保持原状。

### 测试

- 修改 `backend-node/test/providerRouteCost.test.js`：锁定纯规范化接口与错误码。
- 修改 `backend-node/test/splitMultiModelProviderConfigs.test.js`：覆盖 CLI、证据资格、原子拆分、回滚、保密、目录、路由和巡检暂停。

### 锁、范围与证据

- 修改 `docs/verification/platform-stability/feature-lock-manifest.json`：把本规格、实现计划和只读生产绑定报告加入现有主动巡检锁的 evidence；不改验收文本和已批准 unlock。
- 修改 `backend-node/test/featureLockManifest.test.js`：锁定新增 evidence 路径必须存在。
- 修改 `deploy/release-scopes/platform-stability-proactive-canary.json`：只新增三份本轮文档路径；运行代码和测试路径已在现有白名单中。
- 修改 `backend-node/test/incrementalReleaseScope.test.js`：同步精确有序白名单并保留同数量偷换反例。
- 修改 `docs/verification/platform-stability/proactive-canary-verification.md`：记录本地红绿、完整回归和未授权边界，不写生产已生效。

---

### 任务 1：导出纯线路成本规范化合同

**文件：**

- 修改：`backend-node/src/services/providerRouteCostService.js:115-156,306-319`
- 测试：`backend-node/test/providerRouteCost.test.js`

- [ ] **步骤 1：编写失败的纯函数测试**

在 `providerRouteCost.test.js` 中加入：

```js
test('线路成本规范化可在写事务前复用且不访问数据库', () => {
  const normalized = routeCost.normalizeRouteCostInput(16, {
    currency: 'cny',
    cost_unit: 'second',
    micros_per_unit: 280000,
    resolution_prices: {
      '720P': { micros_per_unit: 560000 },
      '480p': { micros_per_unit: 280000 },
    },
  });
  assert.deepEqual(normalized, {
    schema_version: 1,
    config_id: 16,
    currency: 'CNY',
    cost_unit: 'second',
    micros_per_unit: 280000,
    input_cost_micros_per_1k: 0,
    output_cost_micros_per_1k: 0,
    resolution_prices: {
      '480p': { micros_per_unit: 280000 },
      '720p': { micros_per_unit: 560000 },
    },
  });
  assert.throws(() => routeCost.normalizeRouteCostInput(16, {
    currency: 'CNY',
    cost_unit: 'second',
    micros_per_unit: 0,
  }), { code: 'INVALID_PROVIDER_ROUTE_COST' });
});
```

- [ ] **步骤 2：运行测试并确认红灯原因**

运行：

```powershell
Set-Location backend-node
node --test --test-concurrency=1 test/providerRouteCost.test.js
```

预期：新增测试失败，错误明确为 `routeCost.normalizeRouteCostInput is not a function`；既有测试保持通过。

- [ ] **步骤 3：最小化导出既有规范化实现**

将现有 `normalizedPayload` 重命名为 `normalizeRouteCostInput`，并让 `setRouteCost` 调用同一个函数：

```js
function normalizeRouteCostInput(configId, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw costError('INVALID_PROVIDER_ROUTE_COST', 'cost payload must be an object');
  }
  const currency = String(input.currency || 'CNY').trim().toUpperCase();
  if (currency !== 'CNY') {
    throw costError('INVALID_PROVIDER_ROUTE_COST', 'currency must be CNY');
  }
  const costUnit = String(input.cost_unit ?? input.costUnit ?? '').trim().toLowerCase();
  if (!COST_UNITS.has(costUnit)) {
    throw costError('INVALID_PROVIDER_ROUTE_COST', 'cost_unit is unsupported');
  }
  const microsPerUnit = safeNonNegativeInteger(
    input.micros_per_unit ?? input.microsPerUnit,
    'micros_per_unit',
  );
  const inputCost = safeNonNegativeInteger(
    input.input_cost_micros_per_1k ?? input.inputCostMicrosPer1k,
    'input_cost_micros_per_1k',
  );
  const outputCost = safeNonNegativeInteger(
    input.output_cost_micros_per_1k ?? input.outputCostMicrosPer1k,
    'output_cost_micros_per_1k',
  );
  if (costUnit === 'token') {
    if (inputCost <= 0 && outputCost <= 0) {
      throw costError('INVALID_PROVIDER_ROUTE_COST', 'token cost must contain a positive rate');
    }
  } else if (microsPerUnit <= 0) {
    throw costError('INVALID_PROVIDER_ROUTE_COST', 'micros_per_unit must be positive');
  }
  return stableSnapshot({
    config_id: configId,
    currency,
    cost_unit: costUnit,
    micros_per_unit: microsPerUnit,
    input_cost_micros_per_1k: inputCost,
    output_cost_micros_per_1k: outputCost,
    resolution_prices: normalizeResolutionPrices(input.resolution_prices ?? input.resolutionPrices),
  });
}
```

在导出对象中加入 `normalizeRouteCostInput`，不导出其他内部校验器。

- [ ] **步骤 4：运行定向回归并确认绿灯**

运行：

```powershell
node --test --test-concurrency=1 test/providerRouteCost.test.js test/providerRouteAdminRoutes.test.js
node --check src/services/providerRouteCostService.js
git diff --check
```

预期：全部测试通过，语法和差异检查退出码均为 0。

- [ ] **步骤 5：提交本任务**

```powershell
git add backend-node/src/services/providerRouteCostService.js backend-node/test/providerRouteCost.test.js
git commit -m "refactor(稳定性): 复用线路成本纯校验"
```

---

### 任务 2：增加严格 CLI 模式和绑定文件解析

**文件：**

- 修改：`backend-node/scripts/split-multi-model-provider-configs.js:8-35,116-139`
- 测试：`backend-node/test/splitMultiModelProviderConfigs.test.js`

- [ ] **步骤 1：编写 CLI 参数和绑定格式红灯测试**

在测试文件顶部导入脚本模块，并增加写绑定文件助手：

```js
const splitTool = require('../scripts/split-multi-model-provider-configs');

function writeBinding(item, value) {
  const bindingPath = path.join(item.dir, 'binding.json');
  fs.writeFileSync(bindingPath, JSON.stringify(value));
  return bindingPath;
}

function validBinding(sourceConfigId) {
  return {
    schema_version: 1,
    source_config_id: sourceConfigId,
    models: [
      {
        model: 'seedance-2-fast',
        logical_model_id: 'seedance-2-fast',
        evidence_contract: 'toapis-video-real-verification-v1',
        evidence_sha256: 'a'.repeat(64),
        route_cost: {
          currency: 'CNY',
          cost_unit: 'second',
          micros_per_unit: 280000,
          resolution_prices: {
            '480p': { micros_per_unit: 280000 },
            '720p': { micros_per_unit: 560000 },
          },
        },
      },
      {
        model: 'seedance-2-mini',
        logical_model_id: 'seedance-2-mini',
        evidence_contract: 'toapis-video-real-verification-v1',
        evidence_sha256: 'a'.repeat(64),
        route_cost: {
          currency: 'CNY',
          cost_unit: 'second',
          micros_per_unit: 100000,
          resolution_prices: {
            '480p': { micros_per_unit: 100000 },
            '720p': { micros_per_unit: 200000 },
          },
        },
      },
    ],
  };
}
```

增加测试：

```js
test('证据绑定模式要求唯一参数组合并拒绝未知绑定字段', (t) => {
  const item = fixture();
  t.after(() => cleanup(item));
  const binding = validBinding(item.configId);
  const bindingPath = writeBinding(item, binding);
  const fingerprint = JSON.parse(run(['--db', item.dbPath, '--config-id', String(item.configId)]).stdout)
    .fingerprint;

  for (const args of [
    ['--db', item.dbPath, '--config-id', String(item.configId), '--apply-evidence-bound'],
    ['--db', item.dbPath, '--config-id', String(item.configId), '--apply',
      '--apply-evidence-bound', '--expected-fingerprint', fingerprint, '--binding-file', bindingPath],
    ['--db', item.dbPath, '--db', item.dbPath, '--config-id', String(item.configId)],
  ]) {
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert.deepEqual(rows(item.dbPath).length, 1);
  }

  const unsafe = structuredClone(binding);
  unsafe.models[0].api_key = 'must-never-appear';
  const unsafePath = writeBinding(item, unsafe);
  assert.throws(() => splitTool.readBindingFile(unsafePath), { code: 'INVALID_BINDING' });
});
```

- [ ] **步骤 2：运行测试并确认红灯原因**

运行：

```powershell
Set-Location backend-node
node --test --test-concurrency=1 test/splitMultiModelProviderConfigs.test.js
```

预期：新增测试因 `--apply-evidence-bound` 与 `readBindingFile` 尚未实现而失败；五个普通拆分测试仍通过。

- [ ] **步骤 3：替换参数解析并实现严格绑定读取**

把 `parseArgs` 替换为只接受固定参数、拒绝重复参数的实现：

```js
function parseArgs(argv) {
  const result = { apply: false, apply_evidence_bound: false };
  const seen = new Set();
  const valueFlags = new Set([
    '--db', '--config-id', '--expected-fingerprint', '--binding-file',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (seen.has(name)) fail('INVALID_ARGUMENTS');
    seen.add(name);
    if (name === '--apply' || name === '--apply-evidence-bound') {
      result[name.slice(2).replaceAll('-', '_')] = true;
      continue;
    }
    if (!valueFlags.has(name) || index + 1 >= argv.length || String(argv[index + 1]).startsWith('--')) {
      fail('INVALID_ARGUMENTS');
    }
    result[name.slice(2).replaceAll('-', '_')] = argv[index + 1];
    index += 1;
  }
  const configId = Number(result.config_id);
  if (!result.db || !Number.isSafeInteger(configId) || configId <= 0) fail('INVALID_ARGUMENTS');
  if (!fs.existsSync(result.db) || !fs.statSync(result.db).isFile()) fail('DATABASE_NOT_FOUND');
  if (result.apply && result.apply_evidence_bound) fail('INVALID_ARGUMENTS');
  if ((result.apply || result.apply_evidence_bound)
      && !/^[a-f0-9]{64}$/i.test(String(result.expected_fingerprint || ''))) {
    fail('EXPECTED_FINGERPRINT_REQUIRED');
  }
  if (result.apply_evidence_bound && !result.binding_file) fail('BINDING_FILE_REQUIRED');
  if (!result.apply_evidence_bound && result.binding_file) fail('INVALID_ARGUMENTS');
  return { ...result, configId };
}
```

加入严格对象键和字符串校验：

```js
const BINDING_FILE_LIMIT = 64 * 1024;

function exactKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_BINDING');
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('INVALID_BINDING');
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_BINDING');
}

function bindingText(value, maximum) {
  const text = String(value || '').trim();
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) fail('INVALID_BINDING');
  return text;
}

function readBindingFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > BINDING_FILE_LIMIT) fail('INVALID_BINDING');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    fail('INVALID_BINDING');
  }
  exactKeys(raw, ['schema_version', 'source_config_id', 'models']);
  if (raw.schema_version !== 1
      || !Number.isSafeInteger(raw.source_config_id)
      || raw.source_config_id <= 0
      || !Array.isArray(raw.models)
      || raw.models.length < 2) fail('INVALID_BINDING');
  const models = raw.models.map((item) => {
    exactKeys(item, [
      'model', 'logical_model_id', 'evidence_contract', 'evidence_sha256', 'route_cost',
    ]);
    exactKeys(item.route_cost, [
      'currency', 'cost_unit', 'micros_per_unit', 'resolution_prices',
    ]);
    plainObject(item.route_cost.resolution_prices);
    for (const tier of Object.values(item.route_cost.resolution_prices)) {
      exactKeys(tier, ['micros_per_unit']);
    }
    const evidenceSha256 = bindingText(item.evidence_sha256, 64).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(evidenceSha256)) fail('INVALID_BINDING');
    return {
      model: bindingText(item.model, 120),
      logical_model_id: bindingText(item.logical_model_id, 120),
      evidence_contract: bindingText(item.evidence_contract, 120),
      evidence_sha256: evidenceSha256,
      route_cost: item.route_cost,
    };
  });
  if (new Set(models.map((item) => item.model.toLowerCase())).size !== models.length) {
    fail('INVALID_BINDING');
  }
  return { schema_version: 1, source_config_id: raw.source_config_id, models };
}
```

`plainObject(item.route_cost.resolution_prices)` 只确认分辨率档位集合为普通对象；分辨率键和值的合法性统一交给任务 1 导出的 `normalizeRouteCostInput`，避免复制成本规则。

- [ ] **步骤 4：接入 `main` 的独立分支并导出测试接口**

`main` 只在新模式中读取绑定文件：

```js
const result = options.apply_evidence_bound
  ? applyEvidenceBoundPlan(db, {
    configId: options.configId,
    expectedFingerprint: String(options.expected_fingerprint).toLowerCase(),
    binding: readBindingFile(options.binding_file),
  })
  : options.apply
    ? applyPlan(db, options.configId, String(options.expected_fingerprint).toLowerCase())
    : publicPlan(target);
```

把 `readBindingFile` 加入 `module.exports`。此步骤先引用任务 3 将实现的 `applyEvidenceBoundPlan`，因此只运行参数测试，不提交一个无法加载的中间状态；任务 2 与任务 3 在同一实现批次完成后再提交。

---

### 任务 3：实现资格校验和原子证据绑定拆分

**文件：**

- 修改：`backend-node/scripts/split-multi-model-provider-configs.js`
- 测试：`backend-node/test/splitMultiModelProviderConfigs.test.js`

- [ ] **步骤 1：建立 ToAPIs 双模型临时数据库夹具**

新增 `evidenceFixture`，复用 `runMigrationsAndEnsure`，并使用现有价格服务写启用正积分价格：

```js
const crypto = require('node:crypto');
const modelPrice = require('../src/services/modelPriceService');
const routeCost = require('../src/services/providerRouteCostService');

const EVIDENCE_CONTRACT = 'toapis-video-real-verification-v1';

function evidenceFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-evidence-split-'));
  const dbPath = path.join(dir, 'fixture.sqlite');
  const db = new Database(dbPath);
  runMigrationsAndEnsure(db);
  const now = '2026-08-20T00:00:00.000Z';
  const evidence = JSON.stringify({
    contract_version: EVIDENCE_CONTRACT,
    results: [
      { artifact: { output_file: 'fast.mp4' } },
      { artifact: { output_file: 'mini.mp4' } },
    ],
  });
  const evidenceSha256 = crypto.createHash('sha256').update(evidence).digest('hex');
  const capabilities = Object.fromEntries(['seedance-2-fast', 'seedance-2-mini'].map((model) => [
    model,
    {
      evidence_contract: EVIDENCE_CONTRACT,
      evidence_sha256: evidenceSha256,
      resolutions: ['480p', '720p'],
      aspectRatios: ['16:9'],
      durations: [5, 10, 15],
      maxReferences: 9,
      maxVideoReferences: 3,
      maxAudioReferences: 3,
      supportsAudio: true,
    },
  ]));
  const settings = {
    canvas_capabilities_by_model: {
      'seedance-2-fast': capabilities['seedance-2-fast'],
      'seedance-2-mini': capabilities['seedance-2-mini'],
    },
  };
  const info = db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
     endpoint, query_endpoint, priority, is_default, is_active, settings, logical_model_id,
     failover_enabled, verification_status, verified_at, verification_evidence,
     verified_capabilities, canary_paused, created_at, updated_at)
    VALUES ('video', 'toapis', 'toapis_video', 'ToAPIs Seedance',
      'https://fixture.invalid/v1', 'fixture-key', ?, 'seedance-2-fast',
      '/videos/generations', '/videos/generations/{taskId}', 100, 1, 1, ?, NULL,
      1, 'verified', ?, 'safe-real-generation-summary', ?, 0, ?, ?)`)
    .run(
      JSON.stringify(['seedance-2-fast', 'seedance-2-mini']),
      JSON.stringify(settings),
      now,
      JSON.stringify(capabilities),
      now,
      now,
    );
  for (const model of ['seedance-2-fast', 'seedance-2-mini']) {
    modelPrice.set(db, model, model.endsWith('fast') ? 107 : 50, {
      category: 'video',
      status: 'enabled',
      billing_unit: 'second',
      cost_unit: 'second',
      resolution_prices: {
        '480p': { credits: model.endsWith('fast') ? 107 : 50, cost_micros_per_second: 1 },
        '720p': { credits: model.endsWith('fast') ? 214 : 100, cost_micros_per_second: 1 },
      },
    });
  }
  const allowedRoot = path.join(dir, 'release-evidence');
  const evidenceRoot = path.join(allowedRoot, 'external-models-v1');
  fs.mkdirSync(path.join(evidenceRoot, 'public', 'toapis'), { recursive: true });
  fs.writeFileSync(path.join(evidenceRoot, 'toapis-video-verification.json'), evidence);
  fs.writeFileSync(path.join(evidenceRoot, 'public', 'toapis', 'fast.mp4'), 'fast');
  fs.writeFileSync(path.join(evidenceRoot, 'public', 'toapis', 'mini.mp4'), 'mini');
  fs.writeFileSync(path.join(evidenceRoot, 'manifest.json'), JSON.stringify({
    contract_version: 'external-model-release-evidence-manifest-v1',
    evidence: {
      [EVIDENCE_CONTRACT]: {
        file: 'toapis-video-verification.json',
        sha256: evidenceSha256,
      },
    },
  }));
  db.close();
  return {
    dir,
    dbPath,
    configId: Number(info.lastInsertRowid),
    evidenceSha256,
    evidenceRoots: { root: evidenceRoot, allowedRoot },
  };
}
```

- [ ] **步骤 2：编写正向原子拆分红灯测试**

导入将由脚本导出的核心函数和受保护证据读取器：

```js
const externalEvidence = require('../src/services/externalModelEvidenceService');

test('证据绑定拆分原子生成两个启用已验证且巡检暂停的单模型线路', (t) => {
  const item = evidenceFixture();
  t.after(() => cleanup(item));
  const db = new Database(item.dbPath);
  const target = splitTool.readTarget(db, item.configId);
  const binding = validBinding(item.configId);
  for (const model of binding.models) model.evidence_sha256 = item.evidenceSha256;
  const result = splitTool.applyEvidenceBoundPlan(db, {
    configId: item.configId,
    expectedFingerprint: splitTool.fingerprint(target),
    binding,
  }, {
    readTrustedEvidence: (model) => externalEvidence.readTrustedEvidence(model, item.evidenceRoots),
  });
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.routes.map((route) => route.model).sort(), [
    'seedance-2-fast', 'seedance-2-mini',
  ]);
  const configs = db.prepare(`SELECT id, model, default_model, logical_model_id, is_active,
      is_default, verification_status, verified_capabilities, settings, canary_paused
    FROM ai_service_configs WHERE deleted_at IS NULL ORDER BY id`).all();
  assert.equal(configs.length, 2);
  for (const config of configs) {
    const model = JSON.parse(config.model)[0];
    assert.equal(config.default_model, model);
    assert.equal(config.logical_model_id, model);
    assert.equal(config.is_active, 1);
    assert.equal(config.verification_status, 'verified');
    assert.equal(config.canary_paused, 1);
    assert.deepEqual(Object.keys(JSON.parse(config.verified_capabilities)), [model]);
    assert.deepEqual(
      Object.keys(JSON.parse(config.settings).canvas_capabilities_by_model),
      [model],
    );
    const cost = routeCost.getRouteCost(db, config.id);
    assert.equal(cost.cost_unit, 'second');
    assert.equal(cost.resolution_prices['720p'].micros_per_unit,
      model.endsWith('fast') ? 560000 : 200000);
  }
  const audit = db.prepare(`SELECT user_id, event_type, resource_type, resource_id, outcome, code
    FROM audit_events WHERE event_type = 'provider.config.evidence_bound_split'`).get();
  assert.deepEqual(
    [audit.user_id, audit.resource_type, audit.resource_id, audit.outcome],
    ['system/cli', 'ai_service_config', String(item.configId), 'success'],
  );
  db.close();
});
```

- [ ] **步骤 3：运行测试并确认红灯原因**

运行：

```powershell
node --test --test-concurrency=1 test/splitMultiModelProviderConfigs.test.js
```

预期：新增测试失败，原因是 `applyEvidenceBoundPlan` 尚未导出；普通拆分合同仍通过。

- [ ] **步骤 4：加入核心依赖和只读资格校验**

在脚本顶部增加：

```js
const routeCostService = require('../src/services/providerRouteCostService');
const externalEvidenceService = require('../src/services/externalModelEvidenceService');
const auditEventService = require('../src/services/auditEventService');
```

实现以下纯助手，所有比较均大小写不敏感但保存绑定文件中的规范模型名：

```js
function parseObject(value, code) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(code);
    return parsed;
  } catch (_) {
    fail(code);
  }
}

function valueForModel(object, model) {
  const key = Object.keys(object).find((candidate) => candidate.toLowerCase() === model.toLowerCase());
  return key ? object[key] : null;
}

function lowerSet(values) {
  return [...new Set(values.map((value) => String(value).trim().toLowerCase()))].sort();
}

function sameSet(left, right) {
  return JSON.stringify(lowerSet(left)) === JSON.stringify(lowerSet(right));
}

function filteredSettings(value, model) {
  const settings = parseObject(value || '{}', 'INVALID_MODEL_CONFIGURATION');
  const perModel = settings.canvas_capabilities_by_model;
  if (perModel == null) return JSON.stringify(settings);
  const entries = parseObject(perModel, 'INVALID_MODEL_CONFIGURATION');
  const capability = valueForModel(entries, model);
  if (!capability || typeof capability !== 'object' || Array.isArray(capability)) {
    fail('MISSING_MODEL_CAPABILITY');
  }
  return JSON.stringify({
    ...settings,
    canvas_capabilities_by_model: { [model]: capability },
  });
}

function sameConnection(left, right) {
  return ['service_type', 'provider', 'api_protocol', 'base_url', 'api_key', 'endpoint', 'query_endpoint']
    .every((field) => String(left[field] || '').trim() === String(right[field] || '').trim());
}

function assertNoRouteConflict(db, source, model) {
  const rows = db.prepare(`SELECT id, service_type, provider, api_protocol, base_url, api_key,
      endpoint, query_endpoint, model FROM ai_service_configs
    WHERE deleted_at IS NULL AND id <> ?`).all(source.id);
  if (rows.some((row) => sameConnection(source, row)
      && normalizeModels(row.model).some((value) => value.toLowerCase() === model.toLowerCase()))) {
    fail('DUPLICATE_PROVIDER_ROUTE');
  }
}

function requireEnabledUserPrice(db, logicalModelId) {
  const row = db.prepare(`SELECT credits, status FROM model_credit_prices
    WHERE model = ? COLLATE NOCASE`).get(logicalModelId);
  if (!row || row.status !== 'enabled' || !Number.isSafeInteger(row.credits) || row.credits <= 0) {
    fail('MODEL_PRICE_NOT_CONFIGURED');
  }
  return row.credits;
}
```

实现只读双重使用的资格校验：

```js
function validateEvidenceBoundPlan(db, input, overrides = {}) {
  const readTrustedEvidence = overrides.readTrustedEvidence
    || externalEvidenceService.readTrustedEvidence;
  const target = readTarget(db, input.configId);
  const source = target.row;
  if (target.models.length <= 1) fail('ALREADY_EVIDENCE_BOUND_SPLIT');
  if (source.is_active !== 1 || source.verification_status !== 'verified') {
    fail('SOURCE_NOT_ELIGIBLE');
  }
  if (fingerprint(target) !== String(input.expectedFingerprint || '').toLowerCase()) {
    fail('STALE_FINGERPRINT');
  }
  if (input.binding.source_config_id !== input.configId) fail('BINDING_SOURCE_MISMATCH');
  if (!sameSet(target.models, input.binding.models.map((item) => item.model))) {
    fail('BINDING_MODEL_SET_MISMATCH');
  }
  const beforePublicModels = source.logical_model_id
    ? [source.logical_model_id]
    : target.models;
  const afterPublicModels = input.binding.models.map((item) => item.logical_model_id);
  if (!sameSet(beforePublicModels, afterPublicModels)) fail('PUBLIC_MODEL_SET_CHANGED');
  const verifiedCapabilities = parseObject(source.verified_capabilities, 'MISSING_MODEL_EVIDENCE');
  const bindings = input.binding.models.map((binding) => {
    const capability = valueForModel(verifiedCapabilities, binding.model);
    if (!capability || typeof capability !== 'object' || Array.isArray(capability)) {
      fail('MISSING_MODEL_EVIDENCE');
    }
    if (String(capability.evidence_contract || '') !== binding.evidence_contract
        || String(capability.evidence_sha256 || '').toLowerCase() !== binding.evidence_sha256) {
      fail('EVIDENCE_MISMATCH');
    }
    const trusted = readTrustedEvidence(binding.model);
    if (!trusted
        || trusted.contract !== binding.evidence_contract
        || trusted.sha256 !== binding.evidence_sha256) fail('UNTRUSTED_MODEL_EVIDENCE');
    requireEnabledUserPrice(db, binding.logical_model_id);
    const cost = routeCostService.normalizeRouteCostInput(source.id, binding.route_cost);
    if (source.service_type === 'video' && cost.cost_unit !== 'second') {
      fail('ROUTE_COST_CAPABILITY_MISMATCH');
    }
    const resolutions = Array.isArray(capability.resolutions)
      ? lowerSet(capability.resolutions)
      : [];
    if (resolutions.some((resolution) => !cost.resolution_prices[resolution])) {
      fail('ROUTE_COST_CAPABILITY_MISMATCH');
    }
    assertNoRouteConflict(db, source, binding.model);
    return {
      ...binding,
      capability,
      settings: filteredSettings(source.settings, binding.model),
      normalized_cost: cost,
    };
  });
  const defaultBinding = bindings.find(
    (binding) => binding.model.toLowerCase() === target.defaultModel.toLowerCase(),
  );
  if (!defaultBinding) fail('INVALID_MODEL_CONFIGURATION');
  return { target, bindings, defaultBinding };
}
```

- [ ] **步骤 5：实现共享插入器和证据绑定克隆**

把现有 `cloneRow` 的动态 INSERT 提取为 `insertClone`；普通 `cloneRow` 的字段值保持完全不变：

```js
function insertClone(db, clone) {
  const columns = db.prepare('PRAGMA table_info(ai_service_configs)').all()
    .map((column) => column.name)
    .filter((name) => name !== 'id');
  const selected = columns.filter((column) => Object.prototype.hasOwnProperty.call(clone, column));
  const info = db.prepare(`INSERT INTO ai_service_configs (${selected.join(', ')})
    VALUES (${selected.map(() => '?').join(', ')})`).run(...selected.map((column) => clone[column]));
  return Number(info.lastInsertRowid);
}

function cloneEvidenceBoundRow(db, source, binding, now) {
  return insertClone(db, {
    ...source,
    model: JSON.stringify([binding.model]),
    default_model: binding.model,
    name: `${String(source.name || '供应商线路')} · ${binding.model}`,
    is_default: 0,
    is_active: 1,
    logical_model_id: binding.logical_model_id,
    failover_enabled: 0,
    verification_status: 'verified',
    verification_error: null,
    verified_capabilities: JSON.stringify({ [binding.model]: binding.capability }),
    settings: binding.settings,
    canary_paused: 1,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  });
}
```

- [ ] **步骤 6：实现单事务写入和安全结果**

实现核心函数，依赖覆写只供本地单元测试注入，CLI 不暴露开关：

```js
function applyEvidenceBoundPlan(db, input, overrides = {}) {
  const setRouteCost = overrides.setRouteCost || routeCostService.setRouteCost;
  const recordAudit = overrides.recordAudit || auditEventService.record;
  validateEvidenceBoundPlan(db, input, overrides);
  return db.transaction(() => {
    const plan = validateEvidenceBoundPlan(db, input, overrides);
    const now = new Date().toISOString();
    const routeIds = new Map([[plan.defaultBinding.model.toLowerCase(), input.configId]]);
    db.prepare(`UPDATE ai_service_configs SET
        model = ?, default_model = ?, logical_model_id = ?, settings = ?,
        verified_capabilities = ?, canary_paused = 1, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL`).run(
      JSON.stringify([plan.defaultBinding.model]),
      plan.defaultBinding.model,
      plan.defaultBinding.logical_model_id,
      plan.defaultBinding.settings,
      JSON.stringify({ [plan.defaultBinding.model]: plan.defaultBinding.capability }),
      now,
      input.configId,
    );
    for (const binding of plan.bindings) {
      if (binding.model.toLowerCase() === plan.defaultBinding.model.toLowerCase()) continue;
      routeIds.set(binding.model.toLowerCase(), cloneEvidenceBoundRow(db, plan.target.row, binding, now));
    }
    const routes = plan.bindings.map((binding) => {
      const configId = routeIds.get(binding.model.toLowerCase());
      const savedCost = setRouteCost(db, configId, binding.route_cost, { now });
      for (const resolution of Object.keys(binding.normalized_cost.resolution_prices)) {
        if (!routeCostService.routeCostCoversCapability(db, configId, {
          resolution,
          duration: 1,
          count: 1,
        })) fail('ROUTE_COST_CAPABILITY_MISMATCH');
      }
      return {
        config_id: configId,
        model: binding.model,
        logical_model_id: binding.logical_model_id,
        cost_fingerprint: routeCostService.fingerprintRouteCost(savedCost),
      };
    });
    recordAudit(db, {
      eventType: 'provider.config.evidence_bound_split',
      userId: 'system/cli',
      resourceType: 'ai_service_config',
      resourceId: String(input.configId),
      outcome: 'success',
      code: routes.map((route) => `${route.config_id}:${route.model}`).join(','),
    });
    return {
      status: 'applied',
      source_config_id: input.configId,
      source_fingerprint: input.expectedFingerprint,
      routes,
    };
  }).immediate();
}
```

在 `module.exports` 中加入 `applyEvidenceBoundPlan`、`readBindingFile` 和 `validateEvidenceBoundPlan`。不要导出连接比较、克隆或审计内部函数。

- [ ] **步骤 7：运行正向测试并提交任务 2 与任务 3**

运行：

```powershell
node --test --test-concurrency=1 test/providerRouteCost.test.js test/splitMultiModelProviderConfigs.test.js
node --check scripts/split-multi-model-provider-configs.js
git diff --check
```

预期：新模式正向测试通过，普通拆分五项全部保持通过。

提交：

```powershell
git add backend-node/scripts/split-multi-model-provider-configs.js backend-node/test/splitMultiModelProviderConfigs.test.js
git commit -m "feat(稳定性): 原子拆分逐模型证据线路"
```

---

### 任务 4：锁定失败、回滚、幂等和保密行为

**文件：**

- 修改：`backend-node/test/splitMultiModelProviderConfigs.test.js`
- 修改：`backend-node/scripts/split-multi-model-provider-configs.js`

- [ ] **步骤 1：增加资格失败矩阵红灯**

加入表驱动测试，每个用例在调用前保存四张表快照，失败后逐表深比较：

```js
const qualificationCases = [
  {
    name: '空逐模型能力',
    code: 'MISSING_MODEL_EVIDENCE',
    mutate({ db }) {
      db.prepare("UPDATE ai_service_configs SET verified_capabilities = '{}'").run();
    },
  },
  {
    name: '证据哈希不一致',
    code: 'EVIDENCE_MISMATCH',
    mutate({ binding }) {
      binding.models[0].evidence_sha256 = 'b'.repeat(64);
    },
  },
  {
    name: '用户积分价格停用',
    code: 'MODEL_PRICE_NOT_CONFIGURED',
    mutate({ db }) {
      db.prepare("UPDATE model_credit_prices SET status = 'disabled' WHERE model = 'seedance-2-mini'").run();
    },
  },
  {
    name: '720p 成本档位缺失',
    code: 'ROUTE_COST_CAPABILITY_MISMATCH',
    mutate({ binding }) {
      delete binding.models[1].route_cost.resolution_prices['720p'];
    },
  },
  {
    name: '模型集合漂移',
    code: 'BINDING_MODEL_SET_MISMATCH',
    mutate({ binding }) {
      binding.models[1].model = 'seedance-2-extra';
    },
  },
  {
    name: '受保护证据文件缺失',
    code: 'UNTRUSTED_MODEL_EVIDENCE',
    mutate({ item }) {
      fs.unlinkSync(path.join(item.evidenceRoots.root, 'toapis-video-verification.json'));
    },
  },
  {
    name: '线路成本为零',
    code: 'INVALID_PROVIDER_ROUTE_COST',
    mutate({ binding }) {
      binding.models[0].route_cost.micros_per_unit = 0;
    },
  },
  {
    name: '线路成本超出安全整数',
    code: 'INVALID_PROVIDER_ROUTE_COST',
    mutate({ binding }) {
      binding.models[0].route_cost.micros_per_unit = Number.MAX_SAFE_INTEGER + 1;
    },
  },
  {
    name: '视频线路成本单位不是 second',
    code: 'ROUTE_COST_CAPABILITY_MISMATCH',
    mutate({ binding }) {
      binding.models[0].route_cost.cost_unit = 'request';
    },
  },
  {
    name: '源配置已停用',
    code: 'SOURCE_NOT_ELIGIBLE',
    mutate({ db }) {
      db.prepare('UPDATE ai_service_configs SET is_active = 0').run();
    },
  },
  {
    name: '公开逻辑模型集合变化',
    code: 'PUBLIC_MODEL_SET_CHANGED',
    mutate({ binding }) {
      binding.models[1].logical_model_id = 'renamed-mini';
    },
  },
];

for (const itemCase of qualificationCases) {
  test(`证据绑定拆分拒绝${itemCase.name}且数据库零变化`, (t) => {
    const item = evidenceFixture();
    t.after(() => cleanup(item));
    const db = new Database(item.dbPath);
    const binding = validBinding(item.configId);
    for (const model of binding.models) model.evidence_sha256 = item.evidenceSha256;
    itemCase.mutate({ db, binding, item });
    const target = splitTool.readTarget(db, item.configId);
    const before = {
      configs: db.prepare('SELECT * FROM ai_service_configs ORDER BY id').all(),
      costs: db.prepare('SELECT * FROM provider_route_costs ORDER BY config_id').all(),
      tiers: db.prepare('SELECT * FROM provider_route_resolution_costs ORDER BY config_id, resolution').all(),
      audit: db.prepare('SELECT * FROM audit_events ORDER BY created_at, id').all(),
    };
    assert.throws(() => splitTool.applyEvidenceBoundPlan(db, {
      configId: item.configId,
      expectedFingerprint: splitTool.fingerprint(target),
      binding,
    }, {
      readTrustedEvidence: (model) => externalEvidence.readTrustedEvidence(model, item.evidenceRoots),
    }), { code: itemCase.code });
    assert.deepEqual(db.prepare('SELECT * FROM ai_service_configs ORDER BY id').all(), before.configs);
    assert.deepEqual(db.prepare('SELECT * FROM provider_route_costs ORDER BY config_id').all(), before.costs);
    assert.deepEqual(db.prepare(`SELECT * FROM provider_route_resolution_costs
      ORDER BY config_id, resolution`).all(), before.tiers);
    assert.deepEqual(db.prepare('SELECT * FROM audit_events ORDER BY created_at, id').all(), before.audit);
    db.close();
  });
}
```

另加三个独立用例：同连接同模型冲突返回 `DUPLICATE_PROVIDER_ROUTE`；过期指纹返回 `STALE_FINGERPRINT`；成功后再次以新指纹执行返回 `ALREADY_EVIDENCE_BOUND_SPLIT` 且不新增克隆。

- [ ] **步骤 2：增加事务内部故障注入红灯**

用现有依赖注入点分别让第二次成本写和审计写抛错：

```js
test('成本或审计失败时源配置、克隆、成本和审计全部回滚', (t) => {
  for (const failure of ['cost', 'audit']) {
    const item = evidenceFixture();
    t.after(() => cleanup(item));
    const db = new Database(item.dbPath);
    const binding = validBinding(item.configId);
    for (const model of binding.models) model.evidence_sha256 = item.evidenceSha256;
    const target = splitTool.readTarget(db, item.configId);
    const before = db.prepare('SELECT * FROM ai_service_configs ORDER BY id').all();
    let costCalls = 0;
    assert.throws(() => splitTool.applyEvidenceBoundPlan(db, {
      configId: item.configId,
      expectedFingerprint: splitTool.fingerprint(target),
      binding,
    }, {
      readTrustedEvidence: (model) => externalEvidence.readTrustedEvidence(model, item.evidenceRoots),
      setRouteCost(targetDb, configId, cost, options) {
        costCalls += 1;
        if (failure === 'cost' && costCalls === 2) {
          const error = new Error('fixture route cost failure');
          error.code = 'FIXTURE_COST_FAILURE';
          throw error;
        }
        return routeCost.setRouteCost(targetDb, configId, cost, options);
      },
      recordAudit(targetDb, audit) {
        if (failure === 'audit') {
          const error = new Error('fixture audit failure');
          error.code = 'FIXTURE_AUDIT_FAILURE';
          throw error;
        }
        return require('../src/services/auditEventService').record(targetDb, audit);
      },
    }));
    assert.deepEqual(db.prepare('SELECT * FROM ai_service_configs ORDER BY id').all(), before);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM provider_route_costs').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 0);
    db.close();
  }
});
```

- [ ] **步骤 3：增加 CLI 保密红灯**

构造包含 `fixture-key`、`fixture.invalid`、`safe-real-generation-summary` 的失败数据库，并验证 stdout/stderr 只出现固定错误码：

```js
test('证据绑定 CLI 失败输出不泄露连接、证据或绑定原文', (t) => {
  const item = evidenceFixture();
  t.after(() => cleanup(item));
  const db = new Database(item.dbPath);
  const fingerprint = splitTool.fingerprint(splitTool.readTarget(db, item.configId));
  db.close();
  const binding = validBinding(item.configId);
  binding.models[0].evidence_sha256 = 'b'.repeat(64);
  binding.models[1].evidence_sha256 = 'b'.repeat(64);
  const bindingPath = writeBinding(item, binding);
  const result = run([
    '--db', item.dbPath,
    '--config-id', String(item.configId),
    '--apply-evidence-bound',
    '--expected-fingerprint', fingerprint,
    '--binding-file', bindingPath,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UNTRUSTED_MODEL_EVIDENCE|EVIDENCE_MISMATCH/);
  const output = `${result.stdout}${result.stderr}`;
  for (const forbidden of [
    'fixture-key', 'fixture.invalid', 'safe-real-generation-summary', 'seedance-2-mini":',
  ]) assert.equal(output.includes(forbidden), false, forbidden);
});
```

- [ ] **步骤 4：运行红灯并做最小修复**

运行：

```powershell
node --test --test-concurrency=1 test/splitMultiModelProviderConfigs.test.js
```

逐项修复时只允许：补固定错误码、把遗漏校验放入 `validateEvidenceBoundPlan`、把遗漏写操作移回已有 `IMMEDIATE` 事务。不得吞掉异常、不得打印 `error.message`、不得为通过测试绕过受保护证据读取。

- [ ] **步骤 5：验证并提交加固**

运行：

```powershell
node --test --test-concurrency=1 test/providerRouteCost.test.js test/splitMultiModelProviderConfigs.test.js
node --check scripts/split-multi-model-provider-configs.js
git diff --check
```

提交：

```powershell
git add backend-node/scripts/split-multi-model-provider-configs.js backend-node/test/splitMultiModelProviderConfigs.test.js
git commit -m "fix(稳定性): 加固证据拆分回滚与保密"
```

---

### 任务 5：验证 shadow 目录、候选路由和巡检暂停不回退

**文件：**

- 修改：`backend-node/test/splitMultiModelProviderConfigs.test.js`
- 只读回归：`backend-node/src/services/canvasModelCatalogService.js`
- 只读回归：`backend-node/src/services/providerRouteStabilityService.js`
- 只读回归：`backend-node/src/services/providerCanarySchedulerService.js`

- [ ] **步骤 1：编写跨服务集成红灯**

加入：

```js
const canvasCatalog = require('../src/services/canvasModelCatalogService');
const routeStability = require('../src/services/providerRouteStabilityService');
const scheduler = require('../src/services/providerCanarySchedulerService');
const aiConfigService = require('../src/services/aiConfigService');

test('拆分前后 shadow 目录模型集合一致且 FAST/MINI 只走各自线路', async (t) => {
  const item = evidenceFixture();
  t.after(() => cleanup(item));
  const db = new Database(item.dbPath);
  const before = canvasCatalog.list(db, {
    canaryMode: 'shadow',
    evidenceRoots: item.evidenceRoots,
  }).filter((entry) => entry.model.startsWith('seedance-2-'))
    .map((entry) => entry.model).sort();
  assert.deepEqual(before, ['seedance-2-fast', 'seedance-2-mini']);

  const binding = validBinding(item.configId);
  for (const model of binding.models) model.evidence_sha256 = item.evidenceSha256;
  splitTool.applyEvidenceBoundPlan(db, {
    configId: item.configId,
    expectedFingerprint: splitTool.fingerprint(splitTool.readTarget(db, item.configId)),
    binding,
  }, {
    readTrustedEvidence: (model) => externalEvidence.readTrustedEvidence(model, item.evidenceRoots),
  });

  const after = canvasCatalog.list(db, {
    canaryMode: 'shadow',
    evidenceRoots: item.evidenceRoots,
  }).filter((entry) => entry.model.startsWith('seedance-2-'))
    .map((entry) => entry.model).sort();
  assert.deepEqual(after, before);

  const configs = aiConfigService.listConfigs(db, 'video')
    .filter((config) => config.logical_model_id?.startsWith('seedance-2-'));
  assert.equal(configs.length, 2);
  for (const model of ['seedance-2-fast', 'seedance-2-mini']) {
    const selected = routeStability.selectVerifiedCandidates(db, {
      logicalModelId: model,
      serviceType: 'video',
      capabilities: {
        resolution: '480p',
        duration: 5,
        referenceImageCount: 9,
        referenceVideoCount: 3,
        referenceAudioCount: 3,
      },
      canaryMode: 'shadow',
    });
    assert.equal(selected.candidates.length, 1);
    assert.equal(selected.candidates[0].default_model, model);
    assert.equal(selected.candidates[0].would_be_hidden, true);
  }

  let executorCalls = 0;
  const paidResult = await scheduler.runOnePaidCanary(db, {}, {
    paidEnabled: true,
    now: '2026-08-20T00:05:00.000Z',
    dueProfiles: configs.map((config) => ({
      config: { ...config, canary_paused: true },
      capability: scheduler.enumerateCapabilityProfiles(config)[0],
      blockedReason: 'canary_paused',
    })),
    executor: { async executeCanaryRun() { executorCalls += 1; } },
  });
  assert.equal(paidResult.state, 'blocked');
  assert.equal(executorCalls, 0);
  db.close();
});
```

- [ ] **步骤 2：运行集成测试并定位任何真实回退**

运行：

```powershell
node --test --test-concurrency=1 `
  test/splitMultiModelProviderConfigs.test.js `
  test/canvasModelCatalogService.test.js `
  test/providerCanaryPublicGate.test.js `
  test/providerCanaryScheduler.test.js `
  test/providerRouteVideoIntegration.test.js
```

预期：新增集成测试通过；若失败，只修 `split-multi-model-provider-configs.js` 产生的数据形状，不修改目录、路由或调度器既有门禁。

- [ ] **步骤 3：锁定普通拆分零回退**

再次运行原测试中的普通 `--apply` 用例，并确认：

```js
assert.equal(afterFirst.filter((row) => row.is_active === 1).length, 1);
assert.equal(afterFirst.filter((row) => row.logical_model_id != null).length, 1);
```

不得为了新模式修改这两个断言。

- [ ] **步骤 4：提交跨服务验收测试**

```powershell
git add backend-node/test/splitMultiModelProviderConfigs.test.js backend-node/scripts/split-multi-model-provider-configs.js
git commit -m "test(稳定性): 锁定证据拆分运行时合同"
```

---

### 任务 6：更新功能锁、增量范围和本地证据

**文件：**

- 修改：`docs/verification/platform-stability/feature-lock-manifest.json`
- 修改：`backend-node/test/featureLockManifest.test.js`
- 修改：`deploy/release-scopes/platform-stability-proactive-canary.json`
- 修改：`backend-node/test/incrementalReleaseScope.test.js`
- 修改：`docs/verification/platform-stability/proactive-canary-verification.md`

- [ ] **步骤 1：先写功能锁和范围红灯**

在 `featureLockManifest.test.js` 定义并断言三份证据：

```js
const EVIDENCE_BOUND_SPLIT_EVIDENCE = [
  'docs/verification/platform-stability/provider-readiness-binding-candidate-20260820.md',
  'docs/superpowers/specs/2026-08-20-evidence-bound-multi-model-split-design.md',
  'docs/superpowers/plans/2026-08-20-evidence-bound-multi-model-split.md',
];
```

在主动巡检锁测试中加入：

```js
for (const evidencePath of EVIDENCE_BOUND_SPLIT_EVIDENCE) {
  assert.ok(feature.evidence.includes(evidencePath), `功能锁缺少证据: ${evidencePath}`);
}
```

在 `incrementalReleaseScope.test.js` 的 `PROACTIVE_CANARY_ALLOWED_PATHS` 中按字典序加入同三条路径，并在 required 数组中显式断言它们存在。

运行：

```powershell
Set-Location backend-node
node --test --test-concurrency=1 test/featureLockManifest.test.js test/incrementalReleaseScope.test.js
```

预期：功能锁因 evidence 尚未加入而失败，范围测试因 JSON 白名单尚未同步而失败。

- [ ] **步骤 2：最小更新清单**

只做以下数据变更：

1. 在 `stability.proactive-canary-and-public-evidence.evidence` 末尾追加三份文档路径。
2. 不修改该锁的 acceptance、status、protectedPaths、requiredTests、历史 evidence 和 unlock。
3. 在 `platform-stability-proactive-canary.json.allowedPaths` 中按字典序追加同三份文档路径。
4. 不加入数据库、资产、AI 音乐、共享 release guard、临时产物或通配符。

- [ ] **步骤 3：运行功能锁和精确范围绿灯**

```powershell
node --test --test-concurrency=1 test/featureLockManifest.test.js test/incrementalReleaseScope.test.js
node scripts/verify-feature-lock-manifest.js --base origin/main
```

预期：测试和 CLI 审计均退出 0；CLI 输出 `ready`，changed paths 全在已有锁或新增 evidence 范围内。

- [ ] **步骤 4：执行本次完整本地验证**

后端：

```powershell
Set-Location C:\Users\canqu\Documents\茉莉妈妈2\worktrees\platform-stability-proactive-canary-plan-20260818\backend-node
node --test --test-concurrency=1 `
  test/providerRouteCost.test.js `
  test/splitMultiModelProviderConfigs.test.js `
  test/canvasModelCatalogService.test.js `
  test/providerCanaryPublicGate.test.js `
  test/providerCanaryScheduler.test.js `
  test/providerRouteVideoIntegration.test.js `
  test/featureLockManifest.test.js `
  test/incrementalReleaseScope.test.js
npm test
node --check scripts/split-multi-model-provider-configs.js
node --check src/services/providerRouteCostService.js
```

前端无改动回归：

```powershell
Set-Location ..\frontweb
node --test test/*.test.js
npm run build
npx --no-install playwright test e2e/provider-stability-admin.spec.js e2e/platform-zero-cost-smoke.spec.js
```

若当前工作树没有 `frontweb/node_modules`，只可从 `package-lock.json` SHA-256 完全相同的既有依赖树建立临时 junction；记录来源和哈希，验证后只删除 junction 本身，不联网安装、不删除源依赖树。

仓库审计：

```powershell
Set-Location ..
git diff --check
git status --short
git diff --name-only origin/main...HEAD
```

另对 `origin/main...HEAD` 执行 credential-shaped secret 扫描，至少覆盖 `sk-`、`Bearer`、`api_key` 后接长令牌、URL userinfo；测试固定假值和扫描规则自身必须逐条人工解释，任何无法解释的命中都阻断提交。

- [ ] **步骤 5：记录新鲜证据**

在 `proactive-canary-verification.md` 追加一节“2026-08-20 逐模型证据绑定拆分本地 TDD”，逐条写入刚才实际命令、起止时间、退出码和测试计数。文档必须明确写出：

- 使用临时 SQLite 和受保护证据 fixture；
- 没有访问生产、供应商或付费接口；
- 没有启用 `enforce`；
- 没有修改生产数据库或 AI 音乐；
- 生产指纹、生产绑定文件、数据库备份、部署锁和逐线路付费授权仍是后续独立门禁；
- 本地绿灯不等于线上稳定或所有模型已恢复。

所有提交 SHA 和计数只能使用本轮命令的真实输出，不预填、不复用旧候选证据。

- [ ] **步骤 6：提交锁和证据**

```powershell
git add `
  docs/verification/platform-stability/feature-lock-manifest.json `
  backend-node/test/featureLockManifest.test.js `
  deploy/release-scopes/platform-stability-proactive-canary.json `
  backend-node/test/incrementalReleaseScope.test.js `
  docs/verification/platform-stability/proactive-canary-verification.md
git commit -m "docs(稳定性): 锁定证据拆分本地验证"
```

- [ ] **步骤 7：提交后完成门禁复跑**

```powershell
Set-Location backend-node
node --test --test-concurrency=1 test/featureLockManifest.test.js test/incrementalReleaseScope.test.js
node scripts/verify-feature-lock-manifest.js --base origin/main
Set-Location ..
git diff --check origin/main...HEAD
git status --short
```

预期：所有命令退出 0，工作树为空。若任一命令失败，保持本地分支未推送、未部署并报告精确失败项。

---

## 最终验收矩阵

| 合同 | 必须证据 |
| --- | --- |
| 普通拆分不回退 | 原五项 `splitMultiModelProviderConfigs` 普通模式测试继续通过 |
| 逐模型真实证据 | DB 能力、绑定文件、受保护 evidence manifest 与实际文件 SHA 四者一致 |
| 零中断目录 | `shadow` 拆分前后 FAST/MINI 公共模型集合相同 |
| 单模型线路 | 每个最终配置只有一个 model、一个 logical model、一个能力映射和一份成本 |
| 原子安全 | 克隆、成本、证据失效或审计故障时全部表回滚 |
| 不自动付费 | 两条最终线路 `canary_paused=1`，调度器 executor 调用为 0 |
| 保密 | stdout/stderr/audit 不含 Key、Base URL、Endpoint、证据原文或绑定原文 |
| 发布边界 | 无 SSH、生产写、供应商调用、付费、enforce、AI 音乐或整体覆盖 |

## 生产后续门禁（不在本计划执行范围）

本地候选完成后，仍需新的明确授权才能：

1. SSH 读取实时 `/opt/moli-drama/current` 和共享数据库；
2. 审计其他会话冲突并从实时 current 构建只覆盖改动文件的候选；
3. 备份共享 SQLite、取得部署锁、重新生成脱敏 dry-run 和实时配置指纹；
4. 生成不含 Key/Base URL 的生产绑定文件并人工复核逐模型证据与成本；
5. 使用 `activate-protected-release.sh` 切换 shadow 候选；
6. 单独授权生产数据库 `--apply-evidence-bound`；
7. 单独授权每条线路的付费巡检及成本硬上限；
8. 任何结果未知立即停止且不重试；readiness 100% 和再次批准前不得启用 `enforce`。
