'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const modelPriceService = require('../src/services/modelPriceService');
const providerRouteCostService = require('../src/services/providerRouteCostService');
const externalModelEvidenceService = require('../src/services/externalModelEvidenceService');
const auditEventService = require('../src/services/auditEventService');
const splitTool = require('../scripts/split-multi-model-provider-configs');

const script = path.resolve(__dirname, '../scripts/split-multi-model-provider-configs.js');
const EVIDENCE_CONTRACT = 'toapis-video-real-verification-v1';

function fixture(models = ['model-primary', 'model-secondary', 'model-third']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-split-models-'));
  const dbPath = path.join(dir, 'fixture.sqlite');
  const db = new Database(dbPath);
  runMigrationsAndEnsure(db);
  const now = '2026-08-20T00:00:00.000Z';
  const info = db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
     endpoint, query_endpoint, priority, is_default, is_active, settings, logical_model_id,
     failover_enabled, verification_status, verified_at, verification_evidence, created_at, updated_at)
    VALUES ('image', 'private-provider', 'openai', 'Private Multi Model',
      'https://private-relay.example/v1', 'test-secret-key', ?, 'model-primary',
      '/images/generations', '/images/tasks/{taskId}', 50, 1, 1, ?, 'logical-public-model',
      1, 'verified', ?, 'private-evidence', ?, ?)`)
    .run(JSON.stringify(models), JSON.stringify({ private_token: 'settings-secret', public_note: 'safe' }), now, now, now);
  db.close();
  return { dir, dbPath, configId: Number(info.lastInsertRowid) };
}

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
        evidence_contract: EVIDENCE_CONTRACT,
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
        evidence_contract: EVIDENCE_CONTRACT,
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

function evidenceFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-evidence-split-'));
  const dbPath = path.join(dir, 'fixture.sqlite');
  const db = new Database(dbPath);
  runMigrationsAndEnsure(db);
  db.exec(`ALTER TABLE ai_service_configs ADD COLUMN verification_checked_at TEXT;
    ALTER TABLE ai_service_configs ADD COLUMN verification_error TEXT;
    ALTER TABLE ai_service_configs ADD COLUMN verified_capabilities TEXT;`);
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
      1, 'verified', ?, 'safe-real-generation-summary', ?, 0, ?, ?)`).run(
    JSON.stringify(['seedance-2-fast', 'seedance-2-mini']),
    JSON.stringify(settings),
    now,
    JSON.stringify(capabilities),
    now,
    now,
  );
  for (const model of ['seedance-2-fast', 'seedance-2-mini']) {
    const fast = model.endsWith('fast');
    modelPriceService.set(db, model, fast ? 107 : 50, {
      category: 'video',
      status: 'enabled',
      billing_unit: 'second',
      cost_unit: 'second',
      resolution_prices: {
        '480p': { credits: fast ? 107 : 50, cost_micros_per_second: 1 },
        '720p': { credits: fast ? 214 : 100, cost_micros_per_second: 1 },
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

function cleanup(item) {
  fs.rmSync(item.dir, { recursive: true, force: true });
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
  });
}

function rows(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const result = db.prepare(`SELECT id, name, base_url, api_key, model, default_model,
      is_default, is_active, settings, logical_model_id, failover_enabled,
      verification_status, verified_at, verification_evidence, deleted_at
    FROM ai_service_configs ORDER BY id`).all();
  db.close();
  return result;
}

function fourTableSnapshot(db) {
  return {
    configs: db.prepare('SELECT * FROM ai_service_configs ORDER BY id').all(),
    costs: db.prepare('SELECT * FROM provider_route_costs ORDER BY config_id').all(),
    tiers: db.prepare(`SELECT * FROM provider_route_resolution_costs
      ORDER BY config_id, resolution`).all(),
    audit: db.prepare('SELECT * FROM audit_events ORDER BY rowid').all(),
  };
}

function evidenceBoundInput(db, item, binding = validBinding(item.configId)) {
  for (const model of binding.models) model.evidence_sha256 = item.evidenceSha256;
  return {
    input: {
      configId: item.configId,
      expectedFingerprint: splitTool.fingerprint(splitTool.readTarget(db, item.configId)),
      binding,
    },
    overrides: {
      readTrustedEvidence: (model) => externalModelEvidenceService.readTrustedEvidence(
        model,
        item.evidenceRoots,
      ),
    },
  };
}

function captureError(operation) {
  try {
    operation();
  } catch (error) {
    return error;
  }
  assert.fail('expected operation to throw');
}

test('无参数失败且 dry-run 只输出脱敏稳定计划、不写数据库', (t) => {
  const item = fixture();
  t.after(() => cleanup(item));
  const missing = run([]);
  assert.notEqual(missing.status, 0);

  const before = rows(item.dbPath);
  const result = run(['--db', item.dbPath, '--config-id', String(item.configId)]);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(plan).sort(), ['config_id', 'fingerprint', 'model_count', 'models']);
  assert.equal(plan.config_id, item.configId);
  assert.equal(plan.model_count, 3);
  assert.deepEqual(plan.models, ['model-primary', 'model-secondary', 'model-third']);
  assert.match(plan.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(rows(item.dbPath), before);
  const output = `${result.stdout}${result.stderr}`;
  for (const privateValue of [
    'test-secret-key', 'private-relay.example', 'settings-secret', 'private-evidence',
  ]) assert.equal(output.includes(privateValue), false, privateValue);

  const repeat = run(['--db', item.dbPath, '--config-id', String(item.configId)]);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(JSON.parse(repeat.stdout).fingerprint, plan.fingerprint);
});

test('--apply 缺少或使用过期指纹时不写数据库', (t) => {
  const item = fixture();
  t.after(() => cleanup(item));
  const before = rows(item.dbPath);
  const missing = run(['--db', item.dbPath, '--config-id', String(item.configId), '--apply']);
  assert.notEqual(missing.status, 0);
  assert.deepEqual(rows(item.dbPath), before);

  const stale = run([
    '--db', item.dbPath, '--config-id', String(item.configId), '--apply',
    '--expected-fingerprint', '0'.repeat(64),
  ]);
  assert.notEqual(stale.status, 0);
  assert.deepEqual(rows(item.dbPath), before);
});

test('应用后原配置只保留默认模型，克隆停用、未验证且没有逻辑模型绑定', (t) => {
  const item = fixture();
  t.after(() => cleanup(item));
  const dryRun = run(['--db', item.dbPath, '--config-id', String(item.configId)]);
  const fingerprint = JSON.parse(dryRun.stdout).fingerprint;
  const applied = run([
    '--db', item.dbPath, '--config-id', String(item.configId), '--apply',
    '--expected-fingerprint', fingerprint,
  ]);
  assert.equal(applied.status, 0, applied.stderr);
  const result = rows(item.dbPath);
  assert.equal(result.length, 3);
  assert.deepEqual(JSON.parse(result[0].model), ['model-primary']);
  assert.equal(result[0].default_model, 'model-primary');
  assert.equal(result[0].is_active, 1);
  assert.equal(result[0].logical_model_id, 'logical-public-model');

  for (const [index, model] of ['model-secondary', 'model-third'].entries()) {
    const clone = result[index + 1];
    assert.deepEqual(JSON.parse(clone.model), [model]);
    assert.equal(clone.default_model, model);
    assert.equal(clone.is_active, 0);
    assert.equal(clone.is_default, 0);
    assert.equal(clone.logical_model_id, null);
    assert.equal(clone.failover_enabled, 0);
    assert.equal(clone.verification_status, 'unverified');
    assert.equal(clone.verified_at, null);
    assert.equal(clone.verification_evidence, null);
    assert.equal(clone.deleted_at, null);
    assert.equal(clone.api_key, 'test-secret-key');
    assert.equal(clone.base_url, 'https://private-relay.example/v1');
    assert.equal(JSON.parse(clone.settings).private_token, 'settings-secret');
  }
  const output = `${applied.stdout}${applied.stderr}`;
  assert.equal(output.includes('test-secret-key'), false);
  assert.equal(output.includes('private-relay.example'), false);
});

test('插入失败时原配置缩窄和全部克隆都回滚', (t) => {
  const item = fixture(['model-primary', 'model-secondary', 'model-fail']);
  t.after(() => cleanup(item));
  const db = new Database(item.dbPath);
  db.exec(`CREATE TRIGGER reject_model_fail BEFORE INSERT ON ai_service_configs
    WHEN NEW.default_model = 'model-fail'
    BEGIN SELECT RAISE(ABORT, 'fixture rejected clone'); END`);
  db.close();
  const before = rows(item.dbPath);
  const dryRun = run(['--db', item.dbPath, '--config-id', String(item.configId)]);
  const failed = run([
    '--db', item.dbPath, '--config-id', String(item.configId), '--apply',
    '--expected-fingerprint', JSON.parse(dryRun.stdout).fingerprint,
  ]);
  assert.notEqual(failed.status, 0);
  assert.deepEqual(rows(item.dbPath), before);
  assert.equal(`${failed.stdout}${failed.stderr}`.includes('test-secret-key'), false);
});

test('重复执行不会创建更多克隆，也不会启用或公开拆出的模型', (t) => {
  const item = fixture();
  t.after(() => cleanup(item));
  const firstPlan = JSON.parse(run(['--db', item.dbPath, '--config-id', String(item.configId)]).stdout);
  assert.equal(run([
    '--db', item.dbPath, '--config-id', String(item.configId), '--apply',
    '--expected-fingerprint', firstPlan.fingerprint,
  ]).status, 0);
  const afterFirst = rows(item.dbPath);
  const secondPlan = JSON.parse(run(['--db', item.dbPath, '--config-id', String(item.configId)]).stdout);
  assert.equal(secondPlan.model_count, 1);
  assert.equal(run([
    '--db', item.dbPath, '--config-id', String(item.configId), '--apply',
    '--expected-fingerprint', secondPlan.fingerprint,
  ]).status, 0);
  assert.deepEqual(rows(item.dbPath), afterFirst);
  assert.equal(afterFirst.filter((row) => row.is_active === 1).length, 1);
  assert.equal(afterFirst.filter((row) => row.logical_model_id != null).length, 1);
});

test('证据绑定模式要求唯一参数组合并拒绝未知绑定字段', (t) => {
  const item = fixture();
  t.after(() => cleanup(item));
  const binding = validBinding(item.configId);
  const bindingPath = writeBinding(item, binding);
  const fingerprint = JSON.parse(run([
    '--db', item.dbPath, '--config-id', String(item.configId),
  ]).stdout).fingerprint;

  for (const args of [
    ['--db', item.dbPath, '--config-id', String(item.configId), '--apply-evidence-bound'],
    ['--db', item.dbPath, '--config-id', String(item.configId), '--apply',
      '--apply-evidence-bound', '--expected-fingerprint', fingerprint, '--binding-file', bindingPath],
    ['--db', item.dbPath, '--db', item.dbPath, '--config-id', String(item.configId)],
  ]) {
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert.equal(rows(item.dbPath).length, 1);
  }

  const unsafe = structuredClone(binding);
  unsafe.models[0].api_key = 'must-never-appear';
  const unsafePath = writeBinding(item, unsafe);
  assert.throws(() => splitTool.readBindingFile(unsafePath), { code: 'INVALID_BINDING' });
});

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
    readTrustedEvidence: (model) => externalModelEvidenceService.readTrustedEvidence(
      model,
      item.evidenceRoots,
    ),
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
    const cost = providerRouteCostService.getRouteCost(db, config.id);
    assert.equal(cost.cost_unit, 'second');
    assert.equal(
      cost.resolution_prices['720p'].micros_per_unit,
      model.endsWith('fast') ? 560000 : 200000,
    );
  }
  const audit = db.prepare(`SELECT user_id, event_type, resource_type, resource_id, outcome, code
    FROM audit_events WHERE event_type = 'provider.config.evidence_bound_split'`).get();
  assert.deepEqual(
    [audit.user_id, audit.resource_type, audit.resource_id, audit.outcome],
    ['system/cli', 'ai_service_config', String(item.configId), 'success'],
  );
  db.close();
});

function assertDuplicateSourceModelsRejected(t, sourceModels) {
  const item = evidenceFixture();
  t.after(() => cleanup(item));
  const db = new Database(item.dbPath);
  db.prepare('UPDATE ai_service_configs SET model = ? WHERE id = ?').run(
    JSON.stringify(sourceModels),
    item.configId,
  );
  const binding = validBinding(item.configId);
  for (const model of binding.models) model.evidence_sha256 = item.evidenceSha256;
  const snapshot = () => ({
    configs: db.prepare('SELECT * FROM ai_service_configs ORDER BY id').all(),
    costs: db.prepare('SELECT * FROM provider_route_costs ORDER BY config_id').all(),
    tiers: db.prepare(`SELECT * FROM provider_route_resolution_costs
      ORDER BY config_id, resolution`).all(),
    audit: db.prepare('SELECT * FROM audit_events ORDER BY created_at, id').all(),
  });
  const before = snapshot();
  let error;
  try {
    splitTool.applyEvidenceBoundPlan(db, {
      configId: item.configId,
      expectedFingerprint: splitTool.fingerprint(splitTool.readTarget(db, item.configId)),
      binding,
    }, {
      readTrustedEvidence: (model) => externalModelEvidenceService.readTrustedEvidence(
        model,
        item.evidenceRoots,
      ),
    });
  } catch (caught) {
    error = caught;
  }
  assert.deepEqual(snapshot(), before);
  assert.equal(error?.code, 'INVALID_MODEL_CONFIGURATION');
  db.close();
}

test('证据绑定拆分拒绝大小写重复的源模型且四表零变化', (t) => {
  assertDuplicateSourceModelsRejected(t, [
    'seedance-2-fast', 'SEEDANCE-2-FAST', 'seedance-2-mini',
  ]);
});

test('证据绑定拆分拒绝完全重复的源模型且四表零变化', (t) => {
  assertDuplicateSourceModelsRejected(t, [
    'seedance-2-fast', 'seedance-2-fast', 'seedance-2-mini',
  ]);
});

const evidenceQualificationFailures = [
  {
    name: '缺少逐模型证据',
    code: 'MISSING_MODEL_EVIDENCE',
    mutate: (db, _binding, item) => db.prepare(
      'UPDATE ai_service_configs SET verified_capabilities = ? WHERE id = ?',
    ).run('{}', item.configId),
  },
  {
    name: '绑定证据摘要不匹配',
    code: 'EVIDENCE_MISMATCH',
    mutate: (_db, binding) => { binding.models[0].evidence_sha256 = 'b'.repeat(64); },
  },
  {
    name: '公开模型价格停用',
    code: 'MODEL_PRICE_NOT_CONFIGURED',
    mutate: (db) => db.prepare(
      "UPDATE model_credit_prices SET status = 'disabled' WHERE model = 'seedance-2-mini'",
    ).run(),
  },
  {
    name: '成本缺少能力分辨率档位',
    code: 'ROUTE_COST_CAPABILITY_MISMATCH',
    mutate: (_db, binding) => { delete binding.models[1].route_cost.resolution_prices['720p']; },
  },
  {
    name: '绑定模型集合漂移',
    code: 'BINDING_MODEL_SET_MISMATCH',
    mutate: (_db, binding) => { binding.models[1].model = 'seedance-2-extra'; },
  },
  {
    name: '受保护证据文件缺失',
    code: 'UNTRUSTED_MODEL_EVIDENCE',
    mutate: (_db, _binding, item) => fs.rmSync(path.join(
      item.evidenceRoots.root,
      'toapis-video-verification.json',
    )),
  },
  {
    name: '成本单价为零',
    code: 'INVALID_PROVIDER_ROUTE_COST',
    mutate: (_db, binding) => { binding.models[0].route_cost.micros_per_unit = 0; },
  },
  {
    name: '成本单价超过安全整数',
    code: 'INVALID_PROVIDER_ROUTE_COST',
    mutate: (_db, binding) => {
      binding.models[0].route_cost.micros_per_unit = Number.MAX_SAFE_INTEGER + 1;
    },
  },
  {
    name: '视频成本单位不是秒',
    code: 'ROUTE_COST_CAPABILITY_MISMATCH',
    mutate: (_db, binding) => { binding.models[0].route_cost.cost_unit = 'request'; },
  },
  {
    name: '来源配置已停用',
    code: 'SOURCE_NOT_ELIGIBLE',
    mutate: (db, _binding, item) => db.prepare(
      'UPDATE ai_service_configs SET is_active = 0 WHERE id = ?',
    ).run(item.configId),
  },
  {
    name: '公开逻辑模型集合漂移',
    code: 'PUBLIC_MODEL_SET_CHANGED',
    mutate: (_db, binding) => { binding.models[1].logical_model_id = 'renamed-mini'; },
  },
];

for (const scenario of evidenceQualificationFailures) {
  test(`证据绑定资格失败：${scenario.name}时四表零变化`, (t) => {
    const item = evidenceFixture();
    t.after(() => cleanup(item));
    const db = new Database(item.dbPath);
    const binding = validBinding(item.configId);
    for (const model of binding.models) model.evidence_sha256 = item.evidenceSha256;
    scenario.mutate(db, binding, item);
    const target = splitTool.readTarget(db, item.configId);
    const before = fourTableSnapshot(db);
    const error = captureError(() => splitTool.applyEvidenceBoundPlan(db, {
      configId: item.configId,
      expectedFingerprint: splitTool.fingerprint(target),
      binding,
    }, {
      readTrustedEvidence: (model) => externalModelEvidenceService.readTrustedEvidence(
        model,
        item.evidenceRoots,
      ),
    }));
    assert.equal(error.code, scenario.code);
    assert.deepEqual(fourTableSnapshot(db), before);
    db.close();
  });
}

test('证据绑定拆分拒绝已存在的相同供应商模型线路且四表零变化', (t) => {
  const item = evidenceFixture();
  t.after(() => cleanup(item));
  const db = new Database(item.dbPath);
  db.prepare(`INSERT INTO ai_service_configs
      (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
       endpoint, query_endpoint, priority, is_default, is_active, settings, logical_model_id,
       failover_enabled, verification_status, verified_at, verification_evidence,
       verified_capabilities, canary_paused, created_at, updated_at)
    SELECT service_type, provider, api_protocol, name || ' duplicate', base_url, api_key,
      ?, ?, endpoint, query_endpoint, priority + 1, 0, 1, settings, NULL,
      0, verification_status, verified_at, verification_evidence,
      verified_capabilities, canary_paused, created_at, updated_at
    FROM ai_service_configs WHERE id = ?`).run(
    JSON.stringify(['seedance-2-mini']),
    'seedance-2-mini',
    item.configId,
  );
  const { input, overrides } = evidenceBoundInput(db, item);
  const before = fourTableSnapshot(db);
  const error = captureError(() => splitTool.applyEvidenceBoundPlan(db, input, overrides));
  assert.equal(error.code, 'DUPLICATE_PROVIDER_ROUTE');
  assert.deepEqual(fourTableSnapshot(db), before);
  db.close();
});

test('证据绑定拆分拒绝过期指纹且四表零变化', (t) => {
  const item = evidenceFixture();
  t.after(() => cleanup(item));
  const db = new Database(item.dbPath);
  const binding = validBinding(item.configId);
  for (const model of binding.models) model.evidence_sha256 = item.evidenceSha256;
  const staleFingerprint = splitTool.fingerprint(splitTool.readTarget(db, item.configId));
  db.prepare('UPDATE ai_service_configs SET priority = priority + 1 WHERE id = ?')
    .run(item.configId);
  const before = fourTableSnapshot(db);
  const error = captureError(() => splitTool.applyEvidenceBoundPlan(db, {
    configId: item.configId,
    expectedFingerprint: staleFingerprint,
    binding,
  }, {
    readTrustedEvidence: (model) => externalModelEvidenceService.readTrustedEvidence(
      model,
      item.evidenceRoots,
    ),
  }));
  assert.equal(error.code, 'STALE_FINGERPRINT');
  assert.deepEqual(fourTableSnapshot(db), before);
  db.close();
});

test('证据绑定拆分重复执行返回固定幂等错误且不新增克隆、成本或审计', (t) => {
  const item = evidenceFixture();
  t.after(() => cleanup(item));
  const db = new Database(item.dbPath);
  const { input, overrides } = evidenceBoundInput(db, item);
  splitTool.applyEvidenceBoundPlan(db, input, overrides);
  const before = fourTableSnapshot(db);
  const current = splitTool.readTarget(db, item.configId);
  const error = captureError(() => splitTool.applyEvidenceBoundPlan(db, {
    ...input,
    expectedFingerprint: splitTool.fingerprint(current),
  }, overrides));
  assert.equal(error.code, 'ALREADY_EVIDENCE_BOUND_SPLIT');
  assert.deepEqual(fourTableSnapshot(db), before);
  db.close();
});

test('成本或审计失败时源配置、克隆、成本和审计全部回滚', async (t) => {
  for (const failure of [
    { stage: 'cost', code: 'FIXTURE_COST_FAILURE' },
    { stage: 'audit', code: 'FIXTURE_AUDIT_FAILURE' },
  ]) {
    await t.test(failure.stage, (subtest) => {
      const item = evidenceFixture();
      subtest.after(() => cleanup(item));
      const db = new Database(item.dbPath);
      const { input, overrides } = evidenceBoundInput(db, item);
      const before = fourTableSnapshot(db);
      let costCalls = 0;
      const error = captureError(() => splitTool.applyEvidenceBoundPlan(db, input, {
        ...overrides,
        setRouteCost: (...args) => {
          costCalls += 1;
          if (failure.stage === 'cost' && costCalls === 2) {
            const injected = new Error(failure.code);
            injected.code = failure.code;
            throw injected;
          }
          return providerRouteCostService.setRouteCost(...args);
        },
        recordAudit: (...args) => {
          if (failure.stage === 'audit') {
            const injected = new Error(failure.code);
            injected.code = failure.code;
            throw injected;
          }
          return auditEventService.record(...args);
        },
      }));
      assert.equal(error.code, failure.code);
      assert.deepEqual(fourTableSnapshot(db), before);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM provider_route_costs').get().count, 0);
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM provider_route_resolution_costs').get().count,
        0,
      );
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 0);
      db.close();
    });
  }
});

test('CLI 证据绑定资格失败只输出固定错误码且不泄露配置或绑定内容', (t) => {
  const item = evidenceFixture();
  t.after(() => cleanup(item));
  const db = new Database(item.dbPath);
  const fingerprint = splitTool.fingerprint(splitTool.readTarget(db, item.configId));
  db.close();
  const binding = validBinding(item.configId);
  for (const model of binding.models) model.evidence_sha256 = 'b'.repeat(64);
  const bindingPath = writeBinding(item, binding);
  const result = run([
    '--db', item.dbPath,
    '--config-id', String(item.configId),
    '--apply-evidence-bound',
    '--expected-fingerprint', fingerprint,
    '--binding-file', bindingPath,
  ]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^(?:UNTRUSTED_MODEL_EVIDENCE|EVIDENCE_MISMATCH)\r?\n$/);
  const output = `${result.stdout}${result.stderr}`;
  for (const privateValue of [
    'fixture-key',
    'fixture.invalid',
    'safe-real-generation-summary',
    'seedance-2-mini":',
  ]) assert.equal(output.includes(privateValue), false, privateValue);
});
