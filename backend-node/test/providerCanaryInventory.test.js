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
  `);
  const insertConfig = db.prepare(`INSERT INTO ai_service_configs
    (id, service_type, provider, base_url, api_key, model, default_model, priority,
     is_active, settings, logical_model_id, verification_status, updated_at, deleted_at)
    VALUES (@id, @service_type, @provider, @base_url, @api_key, @model, @default_model,
      @priority, @is_active, @settings, @logical_model_id, @verification_status,
      @updated_at, NULL)`);
  insertConfig.run({
    id: 11,
    service_type: 'image',
    provider: 'fixture-image-provider',
    base_url: 'https://relay.example.com/v1/images',
    api_key: 'sk-secret',
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
