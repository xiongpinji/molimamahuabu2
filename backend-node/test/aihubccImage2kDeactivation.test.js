'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const scriptPath = path.resolve(__dirname, '..', 'scripts', 'deactivate-aihubcc-gpt-image-2-2k.js');
const {
  inspectAihubccGptImage2k,
  deactivateAihubccGptImage2k,
  assertDatabaseSnapshotStable,
} = require(scriptPath);

const TARGET_MODEL = 'gpt-image-2-2k';
const NOW = '2026-08-14T12:34:56.000Z';

function createSchema(db) {
  db.exec(`
    CREATE TABLE ai_service_configs (
      id INTEGER PRIMARY KEY,
      service_type TEXT NOT NULL,
      provider TEXT,
      name TEXT,
      base_url TEXT,
      api_key TEXT,
      model TEXT,
      default_model TEXT,
      is_default INTEGER NOT NULL,
      is_active INTEGER NOT NULL,
      verification_status TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE model_credit_prices (
      model TEXT PRIMARY KEY,
      credits INTEGER NOT NULL,
      category TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE image_generations (id INTEGER PRIMARY KEY, status TEXT);
    CREATE TABLE usage_reservations (id INTEGER PRIMARY KEY, status TEXT);
    CREATE TABLE tenant_credit_ledger (id INTEGER PRIMARY KEY, event_type TEXT);
    CREATE TABLE mutation_audit (table_name TEXT NOT NULL, row_key TEXT NOT NULL);
    CREATE TRIGGER audit_ai_service_configs_update
      AFTER UPDATE ON ai_service_configs
      BEGIN
        INSERT INTO mutation_audit(table_name, row_key)
        VALUES ('ai_service_configs', CAST(OLD.id AS TEXT));
      END;
    CREATE TRIGGER audit_model_credit_prices_update
      AFTER UPDATE ON model_credit_prices
      BEGIN
        INSERT INTO mutation_audit(table_name, row_key)
        VALUES ('model_credit_prices', OLD.model);
      END;
    CREATE TRIGGER protect_image_generations_update
      BEFORE UPDATE ON image_generations BEGIN SELECT RAISE(ABORT, 'history must not change'); END;
    CREATE TRIGGER protect_usage_reservations_update
      BEFORE UPDATE ON usage_reservations BEGIN SELECT RAISE(ABORT, 'ledger must not change'); END;
    CREATE TRIGGER protect_tenant_credit_ledger_update
      BEFORE UPDATE ON tenant_credit_ledger BEGIN SELECT RAISE(ABORT, 'ledger must not change'); END;
  `);
}

function seedFixture(db) {
  const insertConfig = db.prepare(`INSERT INTO ai_service_configs
    (id, service_type, provider, name, base_url, api_key, model, default_model,
     is_default, is_active, verification_status, created_at, updated_at, deleted_at)
    VALUES (@id, @service_type, @provider, @name, @base_url, @api_key, @model, @default_model,
      @is_default, @is_active, @verification_status, @created_at, @updated_at, @deleted_at)`);
  insertConfig.run({
    id: 2,
    service_type: 'image',
    provider: 'openai',
    name: 'AIHubCC 2K',
    base_url: 'https://aihubcc.cc/v1',
    api_key: 'fixture-secret-never-output',
    model: JSON.stringify([TARGET_MODEL]),
    default_model: TARGET_MODEL,
    is_default: 1,
    is_active: 1,
    verification_status: 'verified',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    deleted_at: null,
  });
  insertConfig.run({
    id: 4,
    service_type: 'image',
    provider: 'openai',
    name: 'AIHubCC other image',
    base_url: 'https://aihubcc.cc/v1',
    api_key: 'fixture-other-secret',
    model: JSON.stringify(['gpt-image-2']),
    default_model: 'gpt-image-2',
    is_default: 0,
    is_active: 1,
    verification_status: 'verified',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    deleted_at: null,
  });
  insertConfig.run({
    id: 11,
    service_type: 'image',
    provider: 'openai',
    name: 'Token6688 image',
    base_url: 'https://token6688.example/v1',
    api_key: 'fixture-token-secret',
    model: JSON.stringify(['gpt-image-2-4k']),
    default_model: 'gpt-image-2-4k',
    is_default: 0,
    is_active: 1,
    verification_status: 'verified',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    deleted_at: null,
  });
  const insertPrice = db.prepare(`INSERT INTO model_credit_prices
    (model, credits, category, status, updated_at) VALUES (?, ?, 'image', ?, ?)`);
  insertPrice.run(TARGET_MODEL, 40, 'enabled', '2026-08-01T00:00:00.000Z');
  insertPrice.run('gpt-image-2', 40, 'enabled', '2026-08-01T00:00:00.000Z');
  insertPrice.run('gpt-image-2-4k', 60, 'enabled', '2026-08-01T00:00:00.000Z');
  db.prepare('INSERT INTO image_generations(id, status) VALUES (?, ?)').run(536, 'pending');
  db.prepare('INSERT INTO image_generations(id, status) VALUES (?, ?)').run(540, 'pending');
  db.prepare('INSERT INTO image_generations(id, status) VALUES (?, ?)').run(541, 'pending');
  db.prepare('INSERT INTO usage_reservations(id, status) VALUES (?, ?)').run(536, 'held');
  db.prepare('INSERT INTO tenant_credit_ledger(id, event_type) VALUES (?, ?)').run(541, 'reserve');
}

function createDb(filename = ':memory:') {
  const db = new Database(filename);
  createSchema(db);
  seedFixture(db);
  return db;
}

function tableSnapshot(db) {
  return {
    configs: db.prepare('SELECT * FROM ai_service_configs ORDER BY id').all(),
    prices: db.prepare('SELECT * FROM model_credit_prices ORDER BY model COLLATE NOCASE').all(),
    images: db.prepare('SELECT * FROM image_generations ORDER BY id').all(),
    reservations: db.prepare('SELECT * FROM usage_reservations ORDER BY id').all(),
    ledger: db.prepare('SELECT * FROM tenant_credit_ledger ORDER BY id').all(),
    audit: db.prepare('SELECT * FROM mutation_audit ORDER BY rowid').all(),
  };
}

function assertPreconditionFailure(db) {
  const before = tableSnapshot(db);
  assert.throws(
    () => deactivateAihubccGptImage2k(db, NOW),
    (error) => {
      assert.equal(error.code, 'DEACTIVATION_PRECONDITION_FAILED');
      const serialized = JSON.stringify(error.details || {});
      assert.doesNotMatch(serialized, /fixture-secret|api_key|\/v1|\?/i);
      assert.deepEqual(
        Object.keys(error.details || {}).every((key) => [
          'config_id', 'model', 'hostname', 'config_changes', 'price_changes',
        ].includes(key)),
        true,
      );
      return true;
    },
  );
  assert.deepEqual(tableSnapshot(db), before);
}

function runCli(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: path.dirname(scriptPath),
    encoding: 'utf8',
    env: process.env,
  });
}

function directorySnapshot(directory) {
  return Object.fromEntries(fs.readdirSync(directory).sort().map((name) => {
    const filePath = path.join(directory, name);
    const stats = fs.statSync(filePath);
    return [name, {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      hash: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
    }];
  }));
}

function snapshotTempDirectories() {
  return fs.readdirSync(os.tmpdir())
    .filter((name) => name.startsWith('moli-aihubcc-dry-run-'))
    .sort();
}

function createWalSnapshotFixture(root) {
  const liveDirectory = path.join(root, 'live');
  const sourceDirectory = path.join(root, 'source');
  fs.mkdirSync(liveDirectory);
  fs.mkdirSync(sourceDirectory);
  const livePath = path.join(liveDirectory, 'live.db');
  const liveDb = new Database(livePath);
  liveDb.pragma('journal_mode = WAL');
  liveDb.pragma('wal_autocheckpoint = 0');
  createSchema(liveDb);
  seedFixture(liveDb);
  assert.equal(fs.existsSync(`${livePath}-wal`), true);
  assert.equal(fs.existsSync(`${livePath}-shm`), true);

  const sourcePath = path.join(sourceDirectory, 'fixture.db');
  fs.copyFileSync(livePath, sourcePath);
  fs.copyFileSync(`${livePath}-wal`, `${sourcePath}-wal`);
  liveDb.close();
  assert.equal(fs.existsSync(`${sourcePath}-shm`), false);
  return { sourceDirectory, sourcePath };
}

test('inspect returns only the exact safe AIHubCC 2K target identity without writing', () => {
  const db = createDb();
  try {
    const before = tableSnapshot(db);
    assert.deepEqual(inspectAihubccGptImage2k(db), {
      config_id: 2,
      model: TARGET_MODEL,
      hostname: 'aihubcc.cc',
    });
    assert.deepEqual(tableSnapshot(db), before);
  } finally {
    db.close();
  }
});

test('apply atomically changes only config #2 and the target price', () => {
  const db = createDb();
  try {
    const before = tableSnapshot(db);
    const result = deactivateAihubccGptImage2k(db, NOW);

    assert.deepEqual(result, {
      config_id: 2,
      model: TARGET_MODEL,
      hostname: 'aihubcc.cc',
      config_changes: 1,
      price_changes: 1,
    });
    assert.deepEqual(
      db.prepare(`SELECT is_active, is_default, verification_status, updated_at
        FROM ai_service_configs WHERE id = 2`).get(),
      { is_active: 0, is_default: 0, verification_status: 'failed', updated_at: NOW },
    );
    assert.deepEqual(
      db.prepare('SELECT status, updated_at FROM model_credit_prices WHERE model = ?').get(TARGET_MODEL),
      { status: 'disabled', updated_at: NOW },
    );
    assert.deepEqual(
      db.prepare('SELECT * FROM ai_service_configs WHERE id IN (4, 11) ORDER BY id').all(),
      before.configs.filter((row) => row.id === 4 || row.id === 11),
    );
    assert.deepEqual(
      db.prepare('SELECT * FROM model_credit_prices WHERE model <> ? ORDER BY model COLLATE NOCASE').all(TARGET_MODEL),
      before.prices.filter((row) => row.model !== TARGET_MODEL),
    );
    assert.deepEqual(db.prepare('SELECT * FROM image_generations ORDER BY id').all(), before.images);
    assert.deepEqual(db.prepare('SELECT * FROM usage_reservations ORDER BY id').all(), before.reservations);
    assert.deepEqual(db.prepare('SELECT * FROM tenant_credit_ledger ORDER BY id').all(), before.ledger);
    assert.deepEqual(db.prepare('SELECT * FROM mutation_audit ORDER BY rowid').all(), [
      { table_name: 'ai_service_configs', row_key: '2' },
      { table_name: 'model_credit_prices', row_key: TARGET_MODEL },
    ]);
  } finally {
    db.close();
  }
});

test('every critical old-value drift fails without changing any table', () => {
  const cases = [
    ['missing config', (db) => db.prepare('DELETE FROM ai_service_configs WHERE id = 2').run()],
    ['deleted config', (db) => db.prepare("UPDATE ai_service_configs SET deleted_at = '2026-08-14' WHERE id = 2").run()],
    ['service type', (db) => db.prepare("UPDATE ai_service_configs SET service_type = 'text' WHERE id = 2").run()],
    ['hostname', (db) => db.prepare("UPDATE ai_service_configs SET base_url = 'https://evil.example/v1?api_key=fixture-secret' WHERE id = 2").run()],
    ['malformed URL', (db) => db.prepare("UPDATE ai_service_configs SET base_url = 'not a URL?fixture-secret' WHERE id = 2").run()],
    ['model', (db) => db.prepare("UPDATE ai_service_configs SET model = '[\"gpt-image-2\"]' WHERE id = 2").run()],
    ['active', (db) => db.prepare('UPDATE ai_service_configs SET is_active = 0 WHERE id = 2').run()],
    ['default', (db) => db.prepare('UPDATE ai_service_configs SET is_default = 0 WHERE id = 2').run()],
    ['verified', (db) => db.prepare("UPDATE ai_service_configs SET verification_status = 'failed' WHERE id = 2").run()],
    ['missing price', (db) => db.prepare('DELETE FROM model_credit_prices WHERE model = ?').run(TARGET_MODEL)],
    ['price status', (db) => db.prepare("UPDATE model_credit_prices SET status = 'disabled' WHERE model = ?").run(TARGET_MODEL)],
  ];

  for (const [name, drift] of cases) {
    const db = createDb();
    try {
      drift(db);
      db.prepare('DELETE FROM mutation_audit').run();
      assert.doesNotThrow(() => assertPreconditionFailure(db), name);
    } finally {
      db.close();
    }
  }
});

test('conditional update count drift rolls back both target rows', () => {
  for (const target of ['config', 'price']) {
    const db = createDb();
    try {
      if (target === 'config') {
        db.exec(`CREATE TRIGGER suppress_target_config_update
          BEFORE UPDATE ON ai_service_configs WHEN OLD.id = 2
          BEGIN SELECT RAISE(IGNORE); END;`);
      } else {
        db.exec(`CREATE TRIGGER suppress_target_price_update
          BEFORE UPDATE ON model_credit_prices WHEN OLD.model = '${TARGET_MODEL}' COLLATE NOCASE
          BEGIN SELECT RAISE(IGNORE); END;`);
      }
      assertPreconditionFailure(db);
    } finally {
      db.close();
    }
  }
});

test('script source excludes historical generations and credit-ledger operations', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');
  assert.doesNotMatch(source, /image_generations|usage_reservations|tenant_credit_ledger/);
  assert.doesNotMatch(source, /\b(?:536|540|541)\b/);
});

test('snapshot stability guard rejects main or sidecar drift with safe details', () => {
  const stable = {
    main: { exists: true, size: 4096, mtimeMs: 1, ctimeMs: 1, ino: 1 },
    wal: { exists: true, size: 8192, mtimeMs: 2, ctimeMs: 2, ino: 2 },
    shm: { exists: false },
  };
  assert.doesNotThrow(() => assertDatabaseSnapshotStable(stable, structuredClone(stable)));
  for (const [part, field, value] of [
    ['main', 'size', 4097],
    ['wal', 'mtimeMs', 3],
    ['shm', 'exists', true],
  ]) {
    const changed = structuredClone(stable);
    changed[part][field] = value;
    assert.throws(
      () => assertDatabaseSnapshotStable(stable, changed),
      (error) => {
        assert.equal(error.code, 'DEACTIVATION_PRECONDITION_FAILED');
        assert.deepEqual(Object.keys(error.details).sort(), ['config_id', 'hostname', 'model']);
        assert.doesNotMatch(JSON.stringify(error), /\\|\/opt\/|api_key|fixture-secret/i);
        return true;
      },
    );
  }
});

test('WAL dry-run inspects a private snapshot without creating or changing source sidecars', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-aihubcc-wal-source-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const { sourceDirectory, sourcePath } = createWalSnapshotFixture(tempDir);
  const sourceBefore = directorySnapshot(sourceDirectory);
  const tempBefore = snapshotTempDirectories();

  const result = runCli(['--database', sourcePath]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    dry_run: true,
    config_id: 2,
    model: TARGET_MODEL,
    hostname: 'aihubcc.cc',
  });
  assert.deepEqual(directorySnapshot(sourceDirectory), sourceBefore);
  assert.deepEqual(snapshotTempDirectories(), tempBefore);
});

test('CLI defaults to byte-stable read-only dry-run and requires explicit apply to write', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-aihubcc-deactivation-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const dryRunPath = path.join(tempDir, 'dry-run.db');
  const db = createDb(dryRunPath);
  db.close();
  const beforeBytes = fs.readFileSync(dryRunPath);

  const dryRun = runCli(['--database', dryRunPath]);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(dryRun.stderr, '');
  assert.deepEqual(JSON.parse(dryRun.stdout), {
    ok: true,
    dry_run: true,
    config_id: 2,
    model: TARGET_MODEL,
    hostname: 'aihubcc.cc',
  });
  assert.deepEqual(fs.readFileSync(dryRunPath), beforeBytes);
  const afterDryRunDb = new Database(dryRunPath, { readonly: true });
  assert.equal(afterDryRunDb.prepare('SELECT is_active FROM ai_service_configs WHERE id = 2').get().is_active, 1);
  assert.equal(afterDryRunDb.prepare('SELECT status FROM model_credit_prices WHERE model = ?').get(TARGET_MODEL).status, 'enabled');
  afterDryRunDb.close();

  const applyPath = path.join(tempDir, 'apply.db');
  const applyDb = createDb(applyPath);
  applyDb.close();
  const apply = runCli(['--database', applyPath, '--apply']);
  assert.equal(apply.status, 0, apply.stderr);
  assert.equal(apply.stderr, '');
  assert.deepEqual(JSON.parse(apply.stdout), {
    ok: true,
    dry_run: false,
    config_id: 2,
    model: TARGET_MODEL,
    hostname: 'aihubcc.cc',
    config_changes: 1,
    price_changes: 1,
  });
  const afterApplyDb = new Database(applyPath, { readonly: true });
  assert.equal(afterApplyDb.prepare('SELECT is_active FROM ai_service_configs WHERE id = 2').get().is_active, 0);
  assert.equal(afterApplyDb.prepare('SELECT status FROM model_credit_prices WHERE model = ?').get(TARGET_MODEL).status, 'disabled');
  afterApplyDb.close();
});

test('CLI fails safely for missing database, malformed arguments, and duplicate apply', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-aihubcc-cli-invalid-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const databasePath = path.join(tempDir, 'fixture.db');
  const db = createDb(databasePath);
  db.close();
  const beforeBytes = fs.readFileSync(databasePath);
  const missingPath = path.join(tempDir, 'missing.db');
  const cases = [
    [],
    ['--database'],
    ['--database', missingPath],
    ['--unknown'],
    ['--database', databasePath, '--apply', '--apply'],
    ['--database', databasePath, '--database', databasePath],
  ];

  for (const args of cases) {
    const result = runCli(args);
    assert.notEqual(result.status, 0, args.join(' '));
    assert.equal(result.stdout, '');
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.ok, false);
    assert.match(failure.error.code, /^(INVALID_ARGUMENTS|DATABASE_UNAVAILABLE)$/);
    assert.doesNotMatch(result.stderr, /fixture-secret|api_key/i);
  }
  assert.deepEqual(fs.readFileSync(databasePath), beforeBytes);
});

test('requiring the CLI module has no command-line side effects', () => {
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(scriptPath)}); process.stdout.write('required')`], {
    encoding: 'utf8',
    env: process.env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'required');
  assert.equal(result.stderr, '');
});
