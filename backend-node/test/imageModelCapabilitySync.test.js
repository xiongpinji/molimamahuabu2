'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const {
  inspectImageModelCapabilities,
  syncImageModelCapabilities,
} = require('../scripts/sync-image-model-capabilities');

const TARGETS = [
  [4, 'storyboard_image', 'aihubcc', ['gpt-image-2']],
  [11, 'image', 'token6688', ['token6688-gpt-image-2', 'gemini-3-pro-image']],
  [21, 'image', 'fumin_image', ['fumin-gpt-image-2', 'fumin-gpt-image-2-4K']],
  [24, 'image', 'aihubcc', ['gpt-image-2']],
  [25, 'image', 'fumin_image', ['fumin-gpt-image-2']],
  [26, 'image', 'token6688', ['token6688-gpt-image-2']],
];

const scriptPath = path.resolve(__dirname, '..', 'scripts', 'sync-image-model-capabilities.js');

function createDb(filename = ':memory:') {
  const db = new Database(filename);
  db.exec(`CREATE TABLE ai_service_configs (
    id INTEGER PRIMARY KEY,
    service_type TEXT NOT NULL,
    provider TEXT NOT NULL,
    api_key TEXT,
    model TEXT NOT NULL,
    is_active INTEGER NOT NULL,
    verification_status TEXT,
    settings TEXT,
    verified_capabilities TEXT,
    updated_at TEXT,
    deleted_at TEXT
  );`);
  const insert = db.prepare(`INSERT INTO ai_service_configs
    (id, service_type, provider, api_key, model, is_active, verification_status,
     settings, verified_capabilities, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, 1, 'verified', ?, '{}', 'old', NULL)`);
  for (const [id, serviceType, provider, models] of TARGETS) {
    insert.run(id, serviceType, provider, `secret-${id}`, JSON.stringify(models), JSON.stringify({ keep_me: id }));
  }
  insert.run(99, 'image', 'unrelated', 'secret-99', '["other-image"]', '{"keep_me":99}');
  return db;
}

test('dry-run lists the exact six capability targets without exposing credentials or writing', () => {
  const db = createDb();
  const before = db.prepare('SELECT * FROM ai_service_configs ORDER BY id').all();
  const result = inspectImageModelCapabilities(db);
  assert.deepEqual(result.map(({ id, provider, models }) => ({ id, provider, models })), TARGETS.map(
    ([id, , provider, models]) => ({ id, provider, models }),
  ));
  assert.doesNotMatch(JSON.stringify(result), /secret-|api_key/i);
  assert.deepEqual(db.prepare('SELECT * FROM ai_service_configs ORDER BY id').all(), before);
  db.close();
});

test('apply atomically publishes truthful capability ranges and preserves unrelated settings', () => {
  const db = createDb();
  const unrelatedBefore = db.prepare('SELECT * FROM ai_service_configs WHERE id = 99').get();
  const result = syncImageModelCapabilities(db, '2026-08-16T12:00:00.000Z');
  assert.equal(result.changes, 6);

  const aihub = JSON.parse(db.prepare('SELECT settings FROM ai_service_configs WHERE id = 24').get().settings);
  assert.equal(aihub.keep_me, 24);
  assert.deepEqual(aihub.canvas_capabilities, {
    supportsTextToImage: true,
    supportsImageReference: true,
    maxReferences: 20,
    maxImageReferences: 20,
    resolutions: ['1K', '2K'],
    aspectRatios: ['16:9', '9:16', '1:1'],
    quantities: [1],
  });
  const aihubVerified = JSON.parse(db.prepare('SELECT verified_capabilities FROM ai_service_configs WHERE id = 24').get().verified_capabilities);
  assert.equal(aihubVerified['gpt-image-2'].reference_count_verified, 20);

  const fumin = JSON.parse(db.prepare('SELECT settings FROM ai_service_configs WHERE id = 21').get().settings);
  assert.equal(fumin.keep_me, 21);
  assert.equal(fumin.canvas_capabilities.supportsImageReference, false);
  assert.equal(fumin.canvas_capabilities.maxReferences, 0);
  assert.deepEqual(fumin.canvas_capabilities_by_model['fumin-gpt-image-2-4K'].resolutions, ['4K']);

  const token = JSON.parse(db.prepare('SELECT settings FROM ai_service_configs WHERE id = 11').get().settings);
  assert.equal(token.keep_me, 11);
  assert.equal(token.canvas_capabilities_by_model['token6688-gpt-image-2'].maxReferences, 9);
  assert.equal(token.canvas_capabilities_by_model['gemini-3-pro-image'].maxReferences, 3);
  assert.deepEqual(db.prepare('SELECT * FROM ai_service_configs WHERE id = 99').get(), unrelatedBefore);
  assert.equal(syncImageModelCapabilities(db, '2026-08-16T12:01:00.000Z').changes, 0);
  db.close();
});

test('any target identity drift aborts before all writes', () => {
  const db = createDb();
  db.prepare("UPDATE ai_service_configs SET provider = 'unexpected' WHERE id = 25").run();
  const before = db.prepare('SELECT * FROM ai_service_configs ORDER BY id').all();
  assert.throws(
    () => syncImageModelCapabilities(db),
    (error) => error.code === 'IMAGE_CAPABILITY_PRECONDITION_FAILED',
  );
  assert.deepEqual(db.prepare('SELECT * FROM ai_service_configs ORDER BY id').all(), before);
  db.close();
});

test('CLI is dry-run by default and requires explicit apply for the six-row update', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-image-capability-sync-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'fixture.db');
  createDb(databasePath).close();

  const dryRun = spawnSync(process.execPath, [scriptPath, '--database', databasePath], { encoding: 'utf8' });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(JSON.parse(dryRun.stdout).dry_run, true);
  const beforeApply = new Database(databasePath, { readonly: true });
  assert.equal(JSON.parse(beforeApply.prepare('SELECT settings FROM ai_service_configs WHERE id = 24').get().settings).canvas_capabilities, undefined);
  beforeApply.close();

  const apply = spawnSync(process.execPath, [scriptPath, '--database', databasePath, '--apply'], { encoding: 'utf8' });
  assert.equal(apply.status, 0, apply.stderr);
  assert.deepEqual(JSON.parse(apply.stdout), {
    ok: true,
    dry_run: false,
    changes: 6,
    config_ids: [4, 11, 21, 24, 25, 26],
  });
  const afterApply = new Database(databasePath, { readonly: true });
  assert.equal(JSON.parse(afterApply.prepare('SELECT settings FROM ai_service_configs WHERE id = 24').get().settings).canvas_capabilities.maxReferences, 20);
  afterApply.close();
});
