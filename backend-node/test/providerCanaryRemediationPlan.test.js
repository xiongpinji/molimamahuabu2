'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const Database = require('better-sqlite3');

const NOW = '2026-08-27T00:00:00.000Z';
const scriptPath = path.resolve(__dirname, '..', 'scripts', 'plan-provider-canary-remediation.js');
const ACTIONS = [
  'manual_mapping_required',
  'split_config_required',
  'user_price_required',
  'cost_evidence_required',
  'capability_evidence_required',
  'runtime_mapping_required',
  'generation_evidence_required',
];

function createFixtureDb(filename = ':memory:') {
  const db = new Database(filename);
  db.exec(`
    CREATE TABLE ai_service_configs (
      id INTEGER PRIMARY KEY,
      service_type TEXT NOT NULL,
      provider TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT,
      api_protocol TEXT,
      model TEXT,
      default_model TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      settings TEXT,
      logical_model_id TEXT,
      verification_status TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE model_credit_prices (
      model TEXT PRIMARY KEY,
      credits INTEGER NOT NULL,
      status TEXT NOT NULL,
      cost_micros_per_unit INTEGER,
      input_cost_micros_per_1k INTEGER,
      output_cost_micros_per_1k INTEGER,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE provider_route_costs (
      config_id INTEGER PRIMARY KEY,
      micros_per_unit INTEGER,
      input_cost_micros_per_1k INTEGER,
      output_cost_micros_per_1k INTEGER,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE provider_route_resolution_costs (
      config_id INTEGER NOT NULL,
      resolution TEXT NOT NULL,
      micros_per_unit INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (config_id, resolution)
    );
  `);

  const insertConfig = db.prepare(`INSERT INTO ai_service_configs
    (id, service_type, provider, base_url, api_key, api_protocol, model, default_model,
     priority, is_active, settings, logical_model_id, verification_status, updated_at, deleted_at)
    VALUES (@id, @service_type, @provider, @base_url, @api_key, 'openai', @model,
      @default_model, @priority, @is_active, @settings, @logical_model_id,
      @verification_status, @updated_at, NULL)`);

  const configs = [
    {
      id: 1,
      service_type: 'image',
      provider: 'fixture-single',
      base_url: 'https://single.secret.example/v1',
      api_key: 'sk-single-secret',
      model: JSON.stringify(['upstream-single-private']),
      default_model: 'upstream-single-private',
      priority: 100,
      is_active: 1,
      settings: JSON.stringify({ canvas_capabilities: { resolutions: ['1k'] }, token: 'settings-secret' }),
      logical_model_id: null,
      verification_status: 'verified',
      updated_at: NOW,
    },
    {
      id: 2,
      service_type: 'image',
      provider: 'fixture-multi',
      base_url: 'https://multi.secret.example/v1',
      api_key: 'sk-multi-secret',
      model: JSON.stringify(['upstream-multi-a-private', 'upstream-multi-b-private']),
      default_model: 'upstream-multi-a-private',
      priority: 90,
      is_active: 1,
      settings: JSON.stringify({ canvas_capabilities: { resolutions: ['1k'] } }),
      logical_model_id: null,
      verification_status: 'verified',
      updated_at: NOW,
    },
    {
      id: 3,
      service_type: 'image',
      provider: 'fixture-cost',
      base_url: 'https://cost.secret.example/v1',
      api_key: 'sk-cost-secret',
      model: 'upstream-cost-private',
      default_model: 'upstream-cost-private',
      priority: 80,
      is_active: 1,
      settings: JSON.stringify({ canvas_capabilities: { resolutions: ['2k'] } }),
      logical_model_id: 'logical-cost',
      verification_status: 'verified',
      updated_at: NOW,
    },
    {
      id: 4,
      service_type: 'video',
      provider: 'fixture-capability',
      base_url: 'https://capability.secret.example/v1',
      api_key: 'sk-capability-secret',
      model: 'upstream-capability-private',
      default_model: 'upstream-capability-private',
      priority: 70,
      is_active: 1,
      settings: JSON.stringify({ signed_url: 'https://private.example/task?signature=secret' }),
      logical_model_id: 'logical-capability',
      verification_status: 'verified',
      updated_at: NOW,
    },
    {
      id: 5,
      service_type: 'unmapped',
      provider: 'fixture-runtime',
      base_url: 'https://runtime.secret.example/v1',
      api_key: 'sk-runtime-secret',
      model: 'upstream-runtime-private',
      default_model: 'upstream-runtime-private',
      priority: 60,
      is_active: 1,
      settings: JSON.stringify({ canvas_capabilities: { mode: 'fixture' } }),
      logical_model_id: 'logical-runtime',
      verification_status: 'verified',
      updated_at: NOW,
    },
    {
      id: 6,
      service_type: 'text',
      provider: 'fixture-price',
      base_url: 'https://price.secret.example/v1',
      api_key: 'sk-price-secret',
      model: 'upstream-price-private',
      default_model: 'upstream-price-private',
      priority: 50,
      is_active: 1,
      settings: JSON.stringify({ canvas_capabilities: { mode: 'text' } }),
      logical_model_id: 'logical-price',
      verification_status: 'verified',
      updated_at: NOW,
    },
    {
      id: 7,
      service_type: 'tts',
      provider: 'fixture-evidence',
      base_url: 'https://evidence.secret.example/v1',
      api_key: 'sk-evidence-secret',
      model: 'upstream-evidence-private',
      default_model: 'upstream-evidence-private',
      priority: 40,
      is_active: 1,
      settings: JSON.stringify({ canvas_capabilities: { voices: ['fixture'] } }),
      logical_model_id: 'logical-evidence',
      verification_status: 'pending',
      updated_at: NOW,
    },
    {
      id: 8,
      service_type: 'image',
      provider: 'fixture-paused',
      base_url: 'https://paused.secret.example/v1',
      api_key: 'sk-paused-secret',
      model: 'upstream-paused-private',
      default_model: 'upstream-paused-private',
      priority: 30,
      is_active: 0,
      settings: JSON.stringify({ canvas_capabilities: { resolutions: ['1k'] } }),
      logical_model_id: 'logical-paused',
      verification_status: 'verified',
      updated_at: NOW,
    },
    {
      id: 9,
      service_type: 'image',
      provider: 'fixture-ready',
      base_url: 'https://ready.secret.example/v1',
      api_key: 'sk-ready-secret',
      model: 'upstream-ready-private',
      default_model: 'upstream-ready-private',
      priority: 20,
      is_active: 1,
      settings: JSON.stringify({ canvas_capabilities: { resolutions: ['1k'] } }),
      logical_model_id: 'logical-ready',
      verification_status: 'verified',
      updated_at: NOW,
    },
  ];
  for (const config of configs) insertConfig.run(config);

  const insertPrice = db.prepare(`INSERT INTO model_credit_prices
    (model, credits, status, cost_micros_per_unit, input_cost_micros_per_1k,
     output_cost_micros_per_1k, updated_at)
    VALUES (?, 10, 'enabled', NULL, NULL, NULL, ?)`);
  for (const model of [
    'upstream-single-private',
    'upstream-multi-a-private',
    'logical-cost',
    'logical-capability',
    'logical-runtime',
    'logical-evidence',
    'logical-paused',
    'logical-ready',
  ]) insertPrice.run(model, NOW);

  const insertCost = db.prepare(`INSERT INTO provider_route_costs
    (config_id, micros_per_unit, input_cost_micros_per_1k, output_cost_micros_per_1k, updated_at)
    VALUES (?, 1000, NULL, NULL, ?)`);
  for (const configId of [1, 2, 4, 5, 6, 7, 8, 9]) insertCost.run(configId, NOW);
  return db;
}

function runtimeFingerprints() {
  return { image: 'image-runtime', video: 'video-runtime', text: 'text-runtime', tts: 'tts-runtime' };
}

function fileSha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

test('buildRemediationPlan classifies active blocked routes without proposing guessed values', () => {
  const { buildRemediationPlan } = require('../src/services/providerCanaryRemediationPlanService');
  const db = createFixtureDb();
  const report = buildRemediationPlan(db, { now: NOW, runtimeFingerprints: runtimeFingerprints() });
  db.close();

  assert.equal(report.schema_version, 1);
  assert.equal(report.generated_at, NOW);
  assert.deepEqual(report.summary, {
    planned_configs: 7,
    excluded_paused_configs: 1,
    action_counts: {
      manual_mapping_required: 1,
      split_config_required: 1,
      user_price_required: 1,
      cost_evidence_required: 1,
      capability_evidence_required: 1,
      runtime_mapping_required: 1,
      generation_evidence_required: 1,
    },
  });
  assert.deepEqual(report.plans.map((plan) => plan.config_id), [1, 2, 3, 4, 5, 6, 7]);

  const expectedById = new Map([
    [1, ['manual_mapping_required']],
    [2, ['split_config_required']],
    [3, ['cost_evidence_required']],
    [4, ['capability_evidence_required']],
    [5, ['runtime_mapping_required']],
    [6, ['user_price_required']],
    [7, ['generation_evidence_required']],
  ]);
  for (const plan of report.plans) {
    assert.deepEqual(plan.actions, expectedById.get(plan.config_id));
    assert.match(plan.route_ref, /^[a-f0-9]{16}$/);
    assert.match(plan.expected_fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(plan.expected_updated_at, NOW);
    assert.equal(typeof plan.service_type, 'string');
  }
  assert.equal(report.plans.find((plan) => plan.config_id === 2).model_count, 2);
  assert.equal(report.plans.some((plan) => plan.config_id === 8), false);
  assert.equal(report.plans.some((plan) => plan.config_id === 9), false);

  const serialized = JSON.stringify(report);
  for (const forbidden of [
    'sk-single-secret',
    'secret.example',
    'upstream-multi-a-private',
    'settings-secret',
    'signed_url',
    'suggested_logical_model_id',
    'suggested_cost',
    'UPDATE ai_service_configs',
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test('buildRemediationPlan fingerprints are stable and change when CAS inputs change', () => {
  const { buildRemediationPlan } = require('../src/services/providerCanaryRemediationPlanService');
  const db = createFixtureDb();
  const options = { now: NOW, runtimeFingerprints: runtimeFingerprints() };
  const first = buildRemediationPlan(db, options);
  const second = buildRemediationPlan(db, options);
  assert.deepEqual(second, first);

  const before = first.plans.find((plan) => plan.config_id === 1).expected_fingerprint;
  db.prepare(`UPDATE ai_service_configs SET updated_at = ? WHERE id = 1`)
    .run('2026-08-27T00:00:01.000Z');
  const after = buildRemediationPlan(db, options)
    .plans.find((plan) => plan.config_id === 1).expected_fingerprint;
  db.close();
  assert.notEqual(after, before);
});

test('buildRemediationPlan pairs configs by route ref even when readiness order changes', () => {
  const inventory = require('../src/services/providerCanaryInventoryService');
  const { buildRemediationPlan } = require('../src/services/providerCanaryRemediationPlanService');
  const db = createFixtureDb();
  const options = { now: NOW, runtimeFingerprints: runtimeFingerprints() };
  const readiness = inventory.buildCanaryReadiness(db, options);
  let builderCalls = 0;
  const report = buildRemediationPlan(db, {
    ...options,
    readinessBuilder() {
      builderCalls += 1;
      return { ...readiness, routes: [...readiness.routes].reverse() };
    },
  });
  db.close();

  assert.equal(builderCalls, 1);
  assert.deepEqual(
    report.plans.map((plan) => [plan.config_id, plan.actions]),
    [
      [1, ['manual_mapping_required']],
      [2, ['split_config_required']],
      [3, ['cost_evidence_required']],
      [4, ['capability_evidence_required']],
      [5, ['runtime_mapping_required']],
      [6, ['user_price_required']],
      [7, ['generation_evidence_required']],
    ],
  );
});

test('buildRemediationPlan fails closed when required schema is missing', () => {
  const { buildRemediationPlan } = require('../src/services/providerCanaryRemediationPlanService');
  const db = new Database(':memory:');
  assert.throws(() => buildRemediationPlan(db), /REMEDIATION_SCHEMA_MISMATCH/);
  db.close();
});

test('CLI reads SQLite without changing bytes, mtime, or table contents', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-canary-remediation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'fixture.sqlite');
  const outputPath = path.join(directory, 'plan.json');
  const db = createFixtureDb(databasePath);
  const beforeRows = db.prepare('SELECT * FROM ai_service_configs ORDER BY id').all();
  db.close();
  const beforeHash = fileSha256(databasePath);
  const beforeMtime = fs.statSync(databasePath).mtimeMs;

  const result = spawnSync(process.execPath, [scriptPath, '--db', databasePath, '--output', outputPath], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fileSha256(databasePath), beforeHash);
  assert.equal(fs.statSync(databasePath).mtimeMs, beforeMtime);

  const readonlyDb = new Database(databasePath, { readonly: true, fileMustExist: true });
  const afterRows = readonlyDb.prepare('SELECT * FROM ai_service_configs ORDER BY id').all();
  readonlyDb.close();
  assert.deepEqual(afterRows, beforeRows);
  assert.deepEqual(
    fs.readdirSync(directory).filter((name) => name.startsWith('plan.json.tmp-')),
    [],
  );

  const report = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(report.summary.planned_configs, 7);
  const serialized = JSON.stringify(report);
  for (const forbidden of ['sk-single-secret', 'secret.example', 'settings-secret', 'signed_url']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('CLI prints JSON by default and fails for invalid arguments or schema drift', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-canary-remediation-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'fixture.sqlite');
  const db = createFixtureDb(databasePath);
  db.close();

  const printed = spawnSync(process.execPath, [scriptPath, '--db', databasePath], { encoding: 'utf8' });
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(JSON.parse(printed.stdout).summary.planned_configs, 7);

  const invalid = spawnSync(process.execPath, [scriptPath, '--db'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /INVALID_ARGUMENTS/);

  const driftedPath = path.join(directory, 'drifted.sqlite');
  const driftedDb = new Database(driftedPath);
  driftedDb.exec('CREATE TABLE ai_service_configs (id INTEGER PRIMARY KEY)');
  driftedDb.close();
  const drifted = spawnSync(process.execPath, [scriptPath, '--db', driftedPath], { encoding: 'utf8' });
  assert.equal(drifted.status, 1);
  assert.match(drifted.stderr, /PLAN_FAILED/);
  assert.equal(drifted.stdout, '');
});

test('action taxonomy stays fixed and contains no automatic mutation action', () => {
  const { REMEDIATION_ACTIONS } = require('../src/services/providerCanaryRemediationPlanService');
  assert.deepEqual(REMEDIATION_ACTIONS, ACTIONS);
  assert.equal(REMEDIATION_ACTIONS.some((action) => /apply|update|enable|unpause/i.test(action)), false);
});
