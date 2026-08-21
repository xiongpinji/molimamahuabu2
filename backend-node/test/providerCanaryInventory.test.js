'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const Database = require('better-sqlite3');

const NOW = '2026-08-18T00:00:00.000Z';
const BLOCKERS = [
  'missing_logical_model_id',
  'missing_user_price',
  'missing_cost',
  'cost_not_positive',
  'missing_capabilities',
  'missing_runtime_mapping',
  'legacy_connection_only_verification',
  'admin_paused',
];
const scriptPath = path.resolve(__dirname, '..', 'scripts', 'audit-provider-canary-readiness.js');
const schemaPath = path.resolve(
  __dirname,
  '..',
  '..',
  'docs',
  'verification',
  'platform-stability',
  'provider-canary-readiness.schema.json',
);
const packageJsonPath = path.resolve(__dirname, '..', 'package.json');
const baselinePath = path.resolve(
  __dirname,
  '..',
  '..',
  'docs',
  'verification',
  'platform-stability',
  'provider-canary-readiness.json',
);

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
      category TEXT NOT NULL,
      status TEXT NOT NULL,
      billing_unit TEXT NOT NULL,
      cost_unit TEXT NOT NULL,
      cost_micros_per_unit INTEGER,
      input_cost_micros_per_1k INTEGER,
      output_cost_micros_per_1k INTEGER,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE model_resolution_prices (
      model TEXT NOT NULL,
      resolution TEXT NOT NULL,
      credits INTEGER NOT NULL,
      cost_micros_per_second INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (model, resolution)
    );
    CREATE TABLE provider_route_costs (
      config_id INTEGER PRIMARY KEY,
      currency TEXT NOT NULL,
      cost_unit TEXT NOT NULL,
      micros_per_unit INTEGER NOT NULL,
      input_cost_micros_per_1k INTEGER NOT NULL,
      output_cost_micros_per_1k INTEGER NOT NULL,
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
    (id, service_type, provider, base_url, api_key, api_protocol, model, default_model, priority,
     is_active, settings, logical_model_id, verification_status, updated_at, deleted_at)
    VALUES (@id, @service_type, @provider, @base_url, @api_key, @api_protocol, @model, @default_model,
      @priority, @is_active, @settings, @logical_model_id, @verification_status,
      @updated_at, NULL)`);
  insertConfig.run({
    id: 11,
    service_type: 'image',
    provider: 'fixture-image-provider',
    base_url: 'https://relay.example.com/v1/images',
    api_key: 'sk-secret',
    api_protocol: 'openai',
    model: JSON.stringify(['private-image-upstream']),
    default_model: 'private-image-upstream',
    priority: 100,
    is_active: 1,
    settings: JSON.stringify({
      canvas_capabilities: { resolutions: ['1k'], supportsImageReference: true },
      Authorization: 'Bearer sk-secret',
      signed_url: 'https://relay.example.com/private?signature=task-secret',
    }),
    logical_model_id: 'image-ready',
    verification_status: 'verified',
    updated_at: NOW,
  });
  insertConfig.run({
    id: 12,
    service_type: 'video',
    provider: 'fixture-video-provider',
    base_url: 'https://video-fixture.invalid/v1',
    api_key: 'video-secret',
    api_protocol: 'openai',
    model: JSON.stringify(['private-video-upstream']),
    default_model: 'private-video-upstream',
    priority: 90,
    is_active: 1,
    settings: JSON.stringify({ canvas_capabilities: { durations: [5], aspectRatios: ['16:9'] } }),
    logical_model_id: 'video-zero-cost',
    verification_status: 'verified',
    updated_at: NOW,
  });
  insertConfig.run({
    id: 13,
    service_type: 'image',
    provider: 'fixture-legacy-provider',
    base_url: 'https://legacy-fixture.invalid/api',
    api_key: 'legacy-secret',
    api_protocol: 'openai',
    model: JSON.stringify(['legacy-private-upstream']),
    default_model: 'legacy-private-upstream',
    priority: 80,
    is_active: 1,
    settings: JSON.stringify({ canvas_capabilities: { resolutions: ['1k'] } }),
    logical_model_id: null,
    verification_status: 'pending',
    updated_at: NOW,
  });
  insertConfig.run({
    id: 14,
    service_type: 'video',
    provider: 'fixture-paused-provider',
    base_url: 'https://paused-fixture.invalid/v1',
    api_key: 'paused-secret',
    api_protocol: 'openai',
    model: JSON.stringify(['paused-private-upstream']),
    default_model: 'paused-private-upstream',
    priority: 70,
    is_active: 0,
    settings: JSON.stringify({ canvas_capabilities: { durations: [5] } }),
    logical_model_id: 'video-paused',
    verification_status: 'verified',
    updated_at: NOW,
  });

  const insertPrice = db.prepare(`INSERT INTO model_credit_prices
    (model, credits, category, status, billing_unit, cost_unit, cost_micros_per_unit,
     input_cost_micros_per_1k, output_cost_micros_per_1k, updated_at)
    VALUES (?, ?, ?, 'enabled', ?, ?, ?, 0, 0, ?)`);
  insertPrice.run('image-ready', 40, 'image', 'request', 'image', 46000, NOW);
  insertPrice.run('video-zero-cost', 50, 'video', 'second', 'second', 0, NOW);
  insertPrice.run('legacy-private-upstream', 30, 'image', 'request', 'image', 25000, NOW);
  insertPrice.run('video-paused', 25, 'video', 'second', 'second', 0, NOW);
  db.prepare(`INSERT INTO model_resolution_prices
    (model, resolution, credits, cost_micros_per_second, updated_at)
    VALUES ('video-paused', '720p', 25, 10000, ?)`)
    .run(NOW);
  const insertRouteCost = db.prepare(`INSERT INTO provider_route_costs
    (config_id, currency, cost_unit, micros_per_unit, input_cost_micros_per_1k,
     output_cost_micros_per_1k, updated_at)
    VALUES (?, 'CNY', ?, ?, 0, 0, ?)`);
  insertRouteCost.run(11, 'image', 46_000, NOW);
  insertRouteCost.run(12, 'second', 0, NOW);
  insertRouteCost.run(14, 'second', 0, NOW);
  db.prepare(`INSERT INTO provider_route_resolution_costs
    (config_id, resolution, micros_per_unit, updated_at) VALUES (14, '720p', 10000, ?)`)
    .run(NOW);
  return db;
}

function createLegacyPriceDb({ withNarrowPriceTable }) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE ai_service_configs (
    id INTEGER PRIMARY KEY,
    service_type TEXT NOT NULL,
    provider TEXT NOT NULL,
    base_url TEXT NOT NULL,
    model TEXT,
    default_model TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    settings TEXT,
    logical_model_id TEXT,
    verification_status TEXT,
    updated_at TEXT,
    deleted_at TEXT
  )`);
  db.prepare(`INSERT INTO ai_service_configs
    (id, service_type, provider, base_url, model, default_model, priority, is_active,
     settings, logical_model_id, verification_status, updated_at, deleted_at)
    VALUES (21, 'image', 'legacy-provider', 'https://legacy.invalid/v1', 'legacy-model',
      'legacy-model', 10, 1, ?, 'legacy-model', 'verified', ?, NULL)`)
    .run(JSON.stringify({ canvas_capabilities: { resolutions: ['1k'] } }), NOW);
  if (withNarrowPriceTable) {
    db.exec(`CREATE TABLE model_credit_prices (
      model TEXT PRIMARY KEY,
      credits INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    db.prepare(`INSERT INTO model_credit_prices (model, credits, updated_at)
      VALUES ('legacy-model', 10, ?)`).run(NOW);
  }
  return db;
}

function buildFixtureReport() {
  const inventory = require('../src/services/providerCanaryInventoryService');
  const db = createFixtureDb();
  try {
    return inventory.buildCanaryReadiness(db, {
      now: NOW,
      runtimeFingerprints: { image: 'image-runtime', video: 'video-runtime' },
    });
  } finally {
    db.close();
  }
}

function compileReadinessSchema() {
  const Ajv2020 = require('ajv/dist/2020');
  const addFormats = require('ajv-formats');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

function assertSchemaInvalid(validate, value, keyword) {
  assert.equal(validate(value), false);
  assert.equal(
    validate.errors.some((error) => error.keyword === keyword),
    true,
    JSON.stringify(validate.errors),
  );
}

test('buildCanaryReadiness classifies four route states without exposing provider secrets', () => {
  const inventory = require('../src/services/providerCanaryInventoryService');
  const db = createFixtureDb();
  const report = inventory.buildCanaryReadiness(db, {
    now: '2026-08-18T00:00:00.000Z',
    runtimeFingerprints: { image: 'image-runtime', video: 'video-runtime' },
  });
  db.close();

  assert.equal(report.schema_version, 1);
  assert.equal(report.summary.public_routes, 3);
  assert.equal(report.summary.ready_for_paid_canary, 1);
  assert.equal(report.routes.find((row) => row.logical_model_id === 'video-zero-cost').blockers.includes('cost_not_positive'), true);
  assert.equal(report.routes.some((row) => row.blockers.includes('missing_logical_model_id')), true);
  for (const secret of ['sk-secret', 'relay.example.com', '/v1/images', 'Authorization']) assert.equal(JSON.stringify(report).includes(secret), false);

  assert.equal(report.evidence_scope, 'local_fixture');
  assert.equal(report.evidence_source, 'deterministic_test_fixture');
  assert.equal(report.generated_at, NOW);
  assert.deepEqual(report.summary, {
    total_routes: 4,
    public_routes: 3,
    ready_for_paid_canary: 1,
    blocked_routes: 3,
  });
  const ready = report.routes.find((row) => row.logical_model_id === 'image-ready');
  assert.equal(ready.service_type, 'image');
  assert.equal(ready.user_price_status, 'configured');
  assert.equal(ready.cost_status, 'positive');
  assert.equal(ready.capabilities_declared, true);
  assert.equal(ready.priority, 100);
  assert.equal(ready.runtime_fingerprint, 'image-runtime');
  assert.deepEqual(ready.blockers, []);
  const paused = report.routes.find((row) => row.logical_model_id === 'video-paused');
  assert.equal(paused.cost_status, 'positive');
  assert.deepEqual(paused.blockers, ['admin_paused']);
  assert.equal(report.routes.find((row) => row.logical_model_id == null)
    .blockers.includes('legacy_connection_only_verification'), true);
  assert.equal(report.routes.every((row) => /^[a-f0-9]{16}$/.test(row.route_ref)), true);
  for (const forbiddenKey of [
    'id', 'config_id', 'provider', 'base_url', 'api_key', 'authorization',
    'task_id', 'signed_url', 'upstream_model',
  ]) {
    assert.equal(JSON.stringify(report).toLowerCase().includes(`\"${forbiddenKey}\"`), false);
  }
});

test('sanitizeRouteRef is the first 16 hex characters of the required route identity hash', () => {
  const inventory = require('../src/services/providerCanaryInventoryService');
  const config = {
    id: 41,
    provider: 'private-provider',
    base_url: 'https://relay.example.com/v1/images?token=sk-secret',
  };
  const expected = crypto.createHash('sha256')
    .update('private-provider\nhttps://relay.example.com\n41')
    .digest('hex')
    .slice(0, 16);
  assert.equal(inventory.sanitizeRouteRef(config), expected);
  assert.equal(inventory.sanitizeRouteRef(config).includes('relay'), false);
});

test('readiness requires cost for the exact config even when its logical model has priced siblings', () => {
  const inventory = require('../src/services/providerCanaryInventoryService');
  const db = createFixtureDb();
  try {
    db.prepare(`INSERT INTO ai_service_configs
      (id, service_type, provider, base_url, api_key, api_protocol, model, default_model,
       priority, is_active, settings, logical_model_id, verification_status, updated_at, deleted_at)
      VALUES (15, 'image', 'second-image-provider', 'https://second.invalid/v1', 'test-key',
        'openai', '["second-upstream"]', 'second-upstream', 60, 1, ?, 'image-ready',
        'verified', ?, NULL)`)
      .run(JSON.stringify({ canvas_capabilities: { resolutions: ['1k'] } }), NOW);
    const report = inventory.buildCanaryReadiness(db, {
      now: NOW,
      runtimeFingerprints: { image: 'image-runtime', video: 'video-runtime' },
    });
    const missing = report.routes.find((row) => row.route_ref
      === inventory.sanitizeRouteRef({
        id: 15,
        provider: 'second-image-provider',
        base_url: 'https://second.invalid/v1',
      }));
    assert.equal(missing.user_price_status, 'configured');
    assert.equal(missing.cost_status, 'missing');
    assert.equal(missing.blockers.includes('missing_cost'), true);
  } finally {
    db.close();
  }
});

test('invalid route URLs use one deterministic sentinel without aborting or leaking input', () => {
  const inventory = require('../src/services/providerCanaryInventoryService');
  const expected = crypto.createHash('sha256')
    .update('legacy-provider\ninvalid-origin\n21')
    .digest('hex')
    .slice(0, 16);
  for (const invalidUrl of ['', '/v1/images', 'not a url']) {
    const db = createLegacyPriceDb({ withNarrowPriceTable: false });
    try {
      db.prepare('UPDATE ai_service_configs SET base_url = ?').run(invalidUrl);
      const report = inventory.buildCanaryReadiness(db, { now: NOW });
      assert.equal(report.routes[0].route_ref, expected);
      if (invalidUrl) assert.equal(JSON.stringify(report).includes(invalidUrl), false);
    } finally {
      db.close();
    }
  }
});

test('missing price tables become blockers instead of aborting the inventory', () => {
  const inventory = require('../src/services/providerCanaryInventoryService');
  const db = createLegacyPriceDb({ withNarrowPriceTable: false });
  try {
    const report = inventory.buildCanaryReadiness(db, { now: NOW });
    assert.equal(report.summary.public_routes, 1);
    assert.equal(report.summary.ready_for_paid_canary, 0);
    assert.equal(report.routes[0].user_price_status, 'missing');
    assert.equal(report.routes[0].cost_status, 'missing');
    assert.deepEqual(report.routes[0].blockers, ['missing_user_price', 'missing_cost', 'missing_runtime_mapping']);
  } finally {
    db.close();
  }
});

test('legacy narrow price tables treat absent status and cost columns as no evidence', () => {
  const inventory = require('../src/services/providerCanaryInventoryService');
  const db = createLegacyPriceDb({ withNarrowPriceTable: true });
  try {
    const report = inventory.buildCanaryReadiness(db, { now: NOW });
    assert.equal(report.routes[0].user_price_status, 'missing');
    assert.equal(report.routes[0].cost_status, 'missing');
    assert.deepEqual(report.routes[0].blockers, ['missing_user_price', 'missing_cost', 'missing_runtime_mapping']);
  } finally {
    db.close();
  }
});

test('runtime resolver receives protocol/provider/settings and missing mappings block only their route', () => {
  const inventory = require('../src/services/providerCanaryInventoryService');
  const db = createFixtureDb();
  const seen = [];
  try {
    const report = inventory.buildCanaryReadiness(db, {
      now: NOW,
      runtimeFingerprintResolver(config) {
        seen.push({
          id: config.id,
          api_protocol: config.api_protocol,
          provider: config.provider,
          settings: config.settings,
        });
        return config.id === 11
          ? { ok: true, fingerprint: 'resolved-image-runtime' }
          : { ok: false, code: 'missing_runtime_mapping', fingerprint: null };
      },
    });
    assert.equal(seen.length, 4);
    assert.equal(seen[0].api_protocol, 'openai');
    assert.equal(seen[0].provider, 'fixture-image-provider');
    assert.match(seen[0].settings, /canvas_capabilities/);
    assert.equal(report.routes[0].runtime_fingerprint, 'resolved-image-runtime');
    assert.equal(report.routes[0].blockers.includes('missing_runtime_mapping'), false);
    for (const route of report.routes.slice(1)) {
      assert.equal(route.runtime_fingerprint, null);
      assert.equal(route.blockers.includes('missing_runtime_mapping'), true);
    }
  } finally {
    db.close();
  }
});

test('checked-in schema covers the report structure and fixed blocker enum', () => {
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    'schema_version', 'evidence_scope', 'evidence_source', 'generated_at', 'summary', 'routes',
  ]);
  assert.deepEqual(schema.properties.routes.items.properties.blockers.items.enum, BLOCKERS);
  assert.equal(schema.properties.routes.items.additionalProperties, false);
  assert.equal(schema.properties.summary.additionalProperties, false);
});

test('JSON Schema validators are exact direct development dependencies', () => {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  assert.equal(packageJson.devDependencies?.ajv, '8.17.1');
  assert.equal(packageJson.devDependencies?.['ajv-formats'], '3.0.1');
});

test('Ajv 2020 validates both generated and checked-in readiness reports', () => {
  const validate = compileReadinessSchema();
  const generated = buildFixtureReport();
  assert.equal(validate(generated), true, JSON.stringify(validate.errors));
  const checkedIn = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  assert.equal(validate(checkedIn), true, JSON.stringify(validate.errors));
});

test('JSON Schema rejects additional route properties', () => {
  const validate = compileReadinessSchema();
  const report = structuredClone(buildFixtureReport());
  report.routes[0].provider = 'must-not-be-accepted';
  assertSchemaInvalid(validate, report, 'additionalProperties');
});

test('JSON Schema rejects blocker values outside the fixed enum', () => {
  const validate = compileReadinessSchema();
  const report = structuredClone(buildFixtureReport());
  report.routes[0].blockers = ['unknown_blocker'];
  assertSchemaInvalid(validate, report, 'enum');
});

test('JSON Schema rejects malformed route references', () => {
  const validate = compileReadinessSchema();
  const report = structuredClone(buildFixtureReport());
  report.routes[0].route_ref = 'not-a-route-hash';
  assertSchemaInvalid(validate, report, 'pattern');
});

test('JSON Schema rejects invalid generated_at date-time values', () => {
  const validate = compileReadinessSchema();
  const report = structuredClone(buildFixtureReport());
  report.generated_at = 'not-a-date';
  assertSchemaInvalid(validate, report, 'format');
});

test('checked-in readiness baseline is generated from the deterministic local fixture', () => {
  const checkedIn = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  assert.deepEqual(checkedIn, buildFixtureReport());
  assert.equal(checkedIn.evidence_scope, 'local_fixture');
  assert.equal(checkedIn.evidence_source, 'deterministic_test_fixture');
});

test('CLI atomically replaces JSON, stays byte-stable, and returns 2 for blockers', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-canary-inventory-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'fixture.sqlite');
  const outputPath = path.join(directory, 'readiness.json');
  const db = createFixtureDb(databasePath);
  db.close();
  fs.writeFileSync(outputPath, '{"old":true}\n');

  const args = [scriptPath, '--database', databasePath, '--out', outputPath];
  const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(first.status, 2, first.stderr);
  const firstBytes = fs.readFileSync(outputPath);
  assert.equal(JSON.parse(firstBytes).summary.ready_for_paid_canary, 1);
  assert.deepEqual(
    fs.readdirSync(directory).filter((name) => name.startsWith('readiness.json.tmp-')),
    [],
  );

  const second = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(second.status, 2, second.stderr);
  assert.equal(fs.readFileSync(outputPath).equals(firstBytes), true);

  const allowed = spawnSync(process.execPath, [...args, '--allow-blocked'], { encoding: 'utf8' });
  assert.equal(allowed.status, 0, allowed.stderr);
});

test('CLI returns 1 for malformed arguments and 0 for help', () => {
  const malformed = spawnSync(process.execPath, [scriptPath, '--database'], { encoding: 'utf8' });
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /INVALID_ARGUMENTS/);

  const help = spawnSync(process.execPath, [scriptPath, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--database/);
  assert.match(help.stdout, /--out/);
  assert.match(help.stdout, /--allow-blocked/);
});
