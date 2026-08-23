const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiConfigRoutes = require('../src/routes/aiConfig');
const aiConfigService = require('../src/services/aiConfigService');
const catalog = require('../src/services/canvasModelCatalogService');
const prices = require('../src/services/modelPriceService');

const log = { info() {}, error() {} };

function verificationColumn(db) {
  return db.prepare('PRAGMA table_info(ai_service_configs)').all()
    .find((column) => column.name === 'verification_status');
}

test('runMigrationsAndEnsure creates verification status with a safe default', () => {
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);

    const columns = new Map(db.prepare('PRAGMA table_info(ai_service_configs)').all()
      .map((column) => [column.name, column]));
    const statusColumn = columns.get('verification_status');
    assert.ok(statusColumn);
    assert.equal(statusColumn.notnull, 1);
    assert.equal(String(statusColumn.dflt_value).replaceAll("'", ''), 'unverified');
    for (const name of ['verification_checked_at', 'verified_at', 'verification_error']) {
      assert.ok(columns.has(name), name);
    }
    db.prepare(`INSERT INTO ai_service_configs (service_type, model, is_active)
      VALUES ('video', 'new-unverified-video', 1)`).run();
    assert.equal(
      db.prepare('SELECT verification_status FROM ai_service_configs').get().verification_status,
      'unverified',
    );
  } finally {
    db.close();
  }
});

test('runMigrationsAndEnsure adds public model notes to legacy price tables', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE model_credit_prices (
      model TEXT PRIMARY KEY,
      credits INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    db.prepare(`INSERT INTO model_credit_prices (model, credits, updated_at)
      VALUES ('legacy-model', 1, '2026-08-07T00:00:00.000Z')`).run();

    runMigrationsAndEnsure(db);

    const column = db.prepare('PRAGMA table_info(model_credit_prices)').all()
      .find((item) => item.name === 'public_note');
    assert.ok(column);
    assert.equal(column.notnull, 1);
    assert.equal(String(column.dflt_value).replaceAll("'", ''), '');
    assert.equal(
      db.prepare('SELECT public_note FROM model_credit_prices WHERE model = ?').get('legacy-model').public_note,
      '',
    );
  } finally {
    db.close();
  }
});

test('saved connection checks are the only path that verifies configs and redact failures', async () => {
  const db = new Database(':memory:');
  const originalFetch = global.fetch;
  try {
    runMigrationsAndEnsure(db);
    const config = aiConfigService.createConfig(db, log, {
      service_type: 'image',
      provider: 'aihubcc',
      api_protocol: 'aihubcc',
      name: '待验证图片供应商',
      base_url: 'https://provider.example/v1',
      api_key: 'supplier-secret',
      model: ['verified-image'],
      default_model: 'verified-image',
    });
    assert.equal(config.verification_status, 'unverified');
    assert.equal(typeof aiConfigService.setVerificationResult, 'function');

    global.fetch = async () => ({ ok: false, status: 404, text: async () => '' });
    let result;
    const handlers = aiConfigRoutes(db, log, {});
    await handlers.testConnection({ body: { config_id: config.id } }, {
      status(code) { result = { status: code }; return this; },
      json(body) { result = { ...result, body }; return this; },
    });
    assert.equal(result.status, 200);
    assert.doesNotMatch(JSON.stringify(result.body), /supplier-secret/);
    assert.equal(aiConfigService.getConfig(db, config.id).verification_status, 'verified');

    aiConfigService.updateConfig(db, log, config.id, { priority: 10 });
    assert.equal(aiConfigService.getConfig(db, config.id).verification_status, 'verified');
    aiConfigService.updateConfig(db, log, config.id, { base_url: 'https://changed.example/v1' });
    const changed = aiConfigService.getConfig(db, config.id);
    assert.equal(changed.verification_status, 'unverified');
    assert.equal(changed.verification_checked_at, null);
    assert.equal(changed.verified_at, null);

    global.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: { message: 'invalid supplier-secret' } }),
    });
    await handlers.testConnection({ body: { config_id: config.id } }, {
      status(code) { result = { status: code }; return this; },
      json(body) { result = { ...result, body }; return this; },
    });
    const failed = aiConfigService.getConfig(db, config.id);
    assert.equal(result.status, 400);
    assert.equal(failed.verification_status, 'failed');
    assert.match(failed.verification_checked_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(failed.verified_at, null);
    assert.match(failed.verification_error, /\[REDACTED\]/);
    assert.doesNotMatch(failed.verification_error, /supplier-secret/);
    assert.doesNotMatch(JSON.stringify(result.body), /supplier-secret/);
  } finally {
    global.fetch = originalFetch;
    db.close();
  }
});

test('runMigrationsAndEnsure upgrades legacy configs without publishing them as verified', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE ai_service_configs (
      id INTEGER PRIMARY KEY,
      service_type TEXT,
      model TEXT,
      is_active INTEGER DEFAULT 1
    )`);
    db.prepare(`INSERT INTO ai_service_configs (service_type, model, is_active)
      VALUES ('video', 'legacy-unverified-video', 1)`).run();

    runMigrationsAndEnsure(db);

    const column = verificationColumn(db);
    assert.ok(column);
    assert.equal(
      db.prepare('SELECT verification_status FROM ai_service_configs').get().verification_status,
      'unverified',
    );
    prices.set(db, 'legacy-unverified-video', 10, { category: 'video' });
    assert.equal(catalog.list(db).some((row) => row.model === 'legacy-unverified-video'), false);

    db.prepare("UPDATE ai_service_configs SET verification_status = 'verified'").run();
    runMigrationsAndEnsure(db);
    assert.equal(
      db.prepare('SELECT verification_status FROM ai_service_configs').get().verification_status,
      'verified',
    );
    assert.equal(catalog.list(db).some((row) => row.model === 'legacy-unverified-video'), true);
  } finally {
    db.close();
  }
});
