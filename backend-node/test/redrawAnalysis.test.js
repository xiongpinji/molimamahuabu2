const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const creditLedger = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const taskService = require('../src/services/taskService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { normalizeSourceFacts } = require('../src/services/redrawAnalysisService');
const redraw = require('../src/services/redrawOrchestrator');

const log = { info() {}, warn() {}, error() {} };

function listen(server) {
  return new Promise((resolve, reject) => {
    const httpServer = server.listen(0, '127.0.0.1', () => resolve(httpServer));
    httpServer.once('error', reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitFor(predicate, timeoutMs = 500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

function validFacts() {
  return {
    duration_ms: 10_000,
    characters: [{ id: 'c1', source_name: '阿岚', relationships: ['c2:朋友'] }],
    scenes: [{ id: 's1', location: '天台', time: '夜', source_ranges: [{ start_ms: 0, end_ms: 5000 }] }],
    props: [{ id: 'p1', name: '旧手机', evidence_ranges: [{ start_ms: 1200, end_ms: 1800 }] }],
    shots: [
      {
        id: 'sh1',
        start_ms: 0,
        end_ms: 5000,
        dialogue: [{ speaker_id: 'c1', text: '别回头' }],
        screen_text: '三年前',
        opening_state: '阿岚站在门边',
        continuous_action: '阿岚推门进入',
        ending_state: '门完全打开',
      },
      {
        id: 'sh2',
        start_ms: 5000,
        end_ms: 10_000,
        dialogue: [],
        screen_text: '',
        opening_state: '手机亮起',
        continuous_action: '屏幕弹出消息',
        ending_state: '阿岚拿起手机',
      },
    ],
    causal_chain: ['手机消息促使阿岚离开'],
    locked_facts: ['阿岚在天台收到旧手机消息'],
    reversals: ['朋友其实在楼下等待'],
    episode_hook: '阿岚发现消息来自未来',
  };
}

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ai_service_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_type TEXT,
      provider TEXT,
      name TEXT,
      base_url TEXT,
      api_key TEXT,
      model TEXT,
      default_model TEXT,
      query_endpoint TEXT,
      is_active INTEGER,
      is_default INTEGER,
      priority INTEGER,
      settings TEXT,
      deleted_at TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE async_tasks (
      id TEXT PRIMARY KEY,
      type TEXT,
      status TEXT,
      progress INTEGER DEFAULT 0,
      message TEXT,
      error TEXT,
      result TEXT,
      resource_id TEXT,
      user_id TEXT,
      model TEXT,
      credit_reservation_id TEXT,
      provider_task_id TEXT,
      metadata TEXT,
      created_at TEXT,
      updated_at TEXT,
      completed_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE redraw_works (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      source_asset_id TEXT,
      status TEXT,
      current_step INTEGER,
      task_id TEXT,
      provider_task_id TEXT,
      credit_reservation_id TEXT,
      error_msg TEXT,
      updated_at TEXT
    );
    CREATE TABLE redraw_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id TEXT NOT NULL,
      source_facts_json TEXT,
      facts_hash TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE redraw_shots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id TEXT NOT NULL,
      version_id INTEGER,
      shot_id TEXT,
      start_ms INTEGER,
      end_ms INTEGER,
      draft_json TEXT,
      status TEXT,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE(work_id, shot_id)
    );
    CREATE TABLE assets (
      id TEXT PRIMARY KEY,
      local_path TEXT,
      url TEXT,
      deleted_at TEXT
    );
  `);
  creditLedger.ensureSchema(db);
  prices.ensureSchema(db);
  creditLedger.setAccountBalance(db, 'user-1', 100);
  return db;
}

function addVerifiedConfig(db) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, base_url, api_key, model, default_model,
       is_active, is_default, priority, settings, created_at, updated_at)
    VALUES ('video_understanding', 'local-fake', '视频理解', 'http://127.0.0.1:9', 'test',
      'GPT-5.5', 'GPT-5.5', 1, 1, 0, ?, ?, ?)
  `).run(JSON.stringify({
    real_generation_verified: true,
    evidence: {
      provider_task_id: 'verified-task',
      result_asset_id: 'verified-result',
      result_asset_readable: true,
      completed_at: now,
    },
  }), now, now);
}

function addVerifiedConfigWithQuery(db, baseUrl, queryEndpoint = '/query/{taskId}') {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, base_url, api_key, model, default_model, query_endpoint,
       is_active, is_default, priority, settings, created_at, updated_at)
    VALUES ('video_understanding', 'local-fake', '视频理解', ?, 'resume-secret',
      'GPT-5.5', 'GPT-5.5', ?, 1, 1, 0, ?, ?, ?)
  `).run(baseUrl, queryEndpoint, JSON.stringify({
    real_generation_verified: true,
    evidence: {
      provider_task_id: 'verified-task',
      result_asset_id: 'verified-result',
      result_asset_readable: true,
      completed_at: now,
    },
  }), now, now);
}

function addWorkAndAssets(db) {
  db.prepare('INSERT INTO assets (id, local_path) VALUES (?, ?)').run('asset-source', 'uploads/source.mp4');
  db.prepare('INSERT INTO assets (id, local_path) VALUES (?, ?)').run('asset-result', 'uploads/result.json');
  db.prepare('INSERT INTO redraw_works (id, user_id, source_asset_id, status, current_step) VALUES (?, ?, ?, ?, ?)')
    .run('work-1', 'user-1', 'asset-source', 'draft', 1);
}

function addStrictMigratedRedrawFixture(db) {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO assets (id, local_path, created_at, updated_at) VALUES (101, 'uploads/source.mp4', ?, ?)")
    .run(now, now);
  db.prepare(`
    INSERT INTO redraw_projects (id, tenant_id, user_id, title, status, created_at, updated_at)
    VALUES (1, 'tenant-1', 'user-1', '严格 schema 项目', 'draft', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO redraw_works
      (id, project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms,
       status, current_step, created_at, updated_at)
    VALUES (1, 1, 'tenant-1', 'user-1', '严格 schema 作品', 101, 'strict-fingerprint', 15000,
      'draft', 1, ?, ?)
  `).run(now, now);
  creditLedger.setAccountBalance(db, 'user-1', 100);
  prices.set(db, 'GPT-5.5', 6);
}

async function startWork(db, providerTaskId = 'provider-1') {
  addWorkAndAssets(db);
  prices.set(db, 'GPT-5.5', 6);
  return redraw.startAnalysis(db, log, { workId: 'work-1', userId: 'user-1' }, {
    provider: { startAnalysis: async () => ({ provider_task_id: providerTaskId }) },
  });
}

test('normalizeSourceFacts returns schema 1.0 and stable hash', () => {
  const first = normalizeSourceFacts(validFacts());
  const second = normalizeSourceFacts({ ...validFacts(), schema_version: 'ignored' });
  assert.equal(first.schema_version, '1.0');
  assert.equal(first.duration_ms, 10_000);
  assert.equal(first.facts_hash, second.facts_hash);
  assert.equal(first.shots[0].dialogue[0].speaker_id, 'c1');
});

test('normalizeSourceFacts rejects incomplete facts, missing speaker and invalid timecodes', () => {
  assert.throws(() => normalizeSourceFacts({ ...validFacts(), locked_facts: [] }), /locked_facts/);
  assert.throws(() => {
    const raw = validFacts();
    delete raw.shots[0].dialogue[0].speaker_id;
    normalizeSourceFacts(raw);
  }, /speaker_id/);
  assert.throws(() => {
    const raw = validFacts();
    raw.shots[1].start_ms = 4000;
    normalizeSourceFacts(raw);
  }, /overlap|重叠/);
  assert.throws(() => {
    const raw = validFacts();
    raw.scenes[0].source_ranges[0].end_ms = 11_000;
    normalizeSourceFacts(raw);
  }, /duration|越界/);
  assert.throws(() => {
    const raw = validFacts();
    raw.scenes[0].source_ranges = [
      { start_ms: 3000, end_ms: 4000 },
      { start_ms: 2000, end_ms: 2500 },
    ];
    normalizeSourceFacts(raw);
  }, /单调|重叠/);
  assert.throws(() => {
    const raw = validFacts();
    raw.props[0].evidence_ranges = [
      { start_ms: 1200, end_ms: 1800 },
      { start_ms: 1700, end_ms: 1900 },
    ];
    normalizeSourceFacts(raw);
  }, /单调|重叠/);
});

test('startAnalysis fails before reserve when capability is not verified or price is missing', async () => {
  const db = createDb();
  addWorkAndAssets(db);

  await assert.rejects(
    () => redraw.startAnalysis(db, log, { workId: 'work-1', userId: 'user-1' }, { provider: {} }),
    (error) => error.code === 'VIDEO_UNDERSTANDING_NOT_VERIFIED'
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_reservations').get().n, 0);

  addVerifiedConfig(db);
  await assert.rejects(
    () => redraw.startAnalysis(db, log, { workId: 'work-1', userId: 'user-1' }, { provider: {} }),
    (error) => error.code === 'MODEL_PRICE_NOT_CONFIGURED'
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_reservations').get().n, 0);
});

test('runAnalyzeTask writes facts and draft shots once, then confirms credits', async () => {
  const db = createDb();
  addVerifiedConfig(db);
  addWorkAndAssets(db);
  prices.set(db, 'GPT-5.5', 6);
  const started = await redraw.startAnalysis(db, log, { workId: 'work-1', userId: 'user-1' }, {
    provider: { startAnalysis: async () => ({ provider_task_id: 'provider-1' }) },
  });

  await redraw.runAnalyzeTask(db, log, started.task_id, {
    provider: { pollAnalysisTask: async () => ({ status: 'completed', result_asset_id: 'asset-result', facts: validFacts() }) },
    assetReader: { canRead: (asset) => Boolean(asset?.local_path) },
  });
  await redraw.runAnalyzeTask(db, log, started.task_id, {
    provider: { pollAnalysisTask: async () => ({ status: 'completed', result_asset_id: 'asset-result', facts: validFacts() }) },
    assetReader: { canRead: (asset) => Boolean(asset?.local_path) },
  });

  const work = db.prepare('SELECT * FROM redraw_works WHERE id = ?').get('work-1');
  assert.equal(work.status, 'asset_review');
  assert.equal(work.current_step, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM redraw_versions WHERE work_id = ? AND facts_hash IS NOT NULL').get('work-1').n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM redraw_shots WHERE work_id = ?').get('work-1').n, 2);
  assert.equal(creditLedger.getAccount(db, 'user-1').spent, 6);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE event_type = 'confirm'").get().n, 1);
});

test('runAnalyzeTask rejects unreadable assets before confirmation', async () => {
  const db = createDb();
  addVerifiedConfig(db);
  addWorkAndAssets(db);
  db.prepare('DELETE FROM assets WHERE id = ?').run('asset-result');
  prices.set(db, 'GPT-5.5', 6);
  const started = await redraw.startAnalysis(db, log, { workId: 'work-1', userId: 'user-1' }, {
    provider: { startAnalysis: async () => ({ provider_task_id: 'provider-unreadable' }) },
  });

  const result = await redraw.runAnalyzeTask(db, log, started.task_id, {
    provider: { pollAnalysisTask: async () => ({ status: 'completed', result_asset_id: 'asset-result', facts: validFacts() }) },
  });

  assert.equal(result.status, 'failed');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM redraw_versions WHERE work_id = ?').get('work-1').n, 0);
  assert.equal(creditLedger.getAccount(db, 'user-1').spent, 0);
});

test('startAnalysis uses analyzing status with real migrated redraw schema', async () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  addVerifiedConfig(db);
  addStrictMigratedRedrawFixture(db);
  creditLedger.setTenantAccountBalance(db, 'tenant-1', 100);

  const started = await redraw.startAnalysis(db, log, { workId: 1, userId: 'user-1' }, {
    provider: { startAnalysis: async () => ({ provider_task_id: 'provider-strict' }) },
  });

  assert.equal(taskService.getTask(db, started.task_id).status, 'processing');
  assert.equal(db.prepare('SELECT status FROM redraw_works WHERE id = ?').get(1).status, 'analyzing');
  assert.equal(db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(started.reservation_id).status, 'held');
});

test('startAnalysis writes requested redraw settings into async task metadata', async () => {
  const db = createDb();
  addVerifiedConfig(db);
  addWorkAndAssets(db);
  prices.set(db, 'GPT-5.5', 6);

  const started = await redraw.startAnalysis(db, log, {
    workId: 'work-1',
    userId: 'user-1',
    analysisSettings: {
      locale: 'ja-JP',
      market: 'JP',
      aspect_ratio: '9:16',
      free_style: {
        positive: 'warm light',
        negative: 'blur',
        reference: { filename: 'style.png', id: 'asset-style' },
      },
    },
  }, {
    provider: { startAnalysis: async ({ analysisSettings }) => {
      assert.equal(analysisSettings.locale, 'ja-JP');
      return { provider_task_id: 'provider-metadata' };
    } },
  });

  const task = db.prepare('SELECT metadata FROM async_tasks WHERE id = ?').get(started.task_id);
  assert.deepEqual(JSON.parse(task.metadata), {
    redraw_analysis: {
      locale: 'ja-JP',
      market: 'JP',
      aspect_ratio: '9:16',
      free_style: {
        positive: 'warm light',
        negative: 'blur',
        reference: { filename: 'style.png', id: 'asset-style' },
      },
    },
  });
});

test('startAnalysis charges tenant ledger and returns held billing without changing personal account', async () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  addVerifiedConfig(db);
  addStrictMigratedRedrawFixture(db);
  creditLedger.setTenantAccountBalance(db, 'tenant-1', 100);
  const personalBefore = creditLedger.getAccount(db, 'user-1');

  const started = await redraw.startAnalysis(db, log, {
    workId: 1,
    userId: 'user-1',
    tenantId: 'tenant-1',
  }, {
    provider: { startAnalysis: async () => ({ provider_task_id: 'provider-tenant-ledger' }) },
  });

  assert.deepEqual(started.billing, { charged: 0, held: 6, released: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_reservations').get().n, 0);
  assert.deepEqual(creditLedger.getAccount(db, 'user-1'), personalBefore);
  const reservation = db.prepare('SELECT * FROM tenant_usage_reservations WHERE id = ?').get(started.reservation_id);
  assert.equal(reservation.tenant_id, 'tenant-1');
  assert.equal(reservation.actor_user_id, 'user-1');
  assert.equal(reservation.amount, 6);
  assert.equal(reservation.status, 'held');
  const ledger = db.prepare('SELECT * FROM tenant_credit_ledger WHERE reservation_id = ? AND event_type = ?')
    .get(started.reservation_id, 'reserve');
  assert.equal(ledger.tenant_id, 'tenant-1');
  assert.equal(ledger.actor_user_id, 'user-1');
  assert.equal(ledger.available_delta, -6);
  assert.equal(ledger.held_delta, 6);
  assert.deepEqual(creditLedger.getTenantAccount(db, 'tenant-1'), {
    tenant_id: 'tenant-1',
    available: 94,
    held: 6,
    spent: 0,
  });
});

test('startAnalysis refunds and fails task/work when provider start throws', async () => {
  const db = createDb();
  addVerifiedConfig(db);
  addWorkAndAssets(db);
  prices.set(db, 'GPT-5.5', 6);

  await assert.rejects(
    () => redraw.startAnalysis(db, log, { workId: 'work-1', userId: 'user-1' }, {
      provider: { startAnalysis: async () => { throw new Error('provider offline'); } },
    }),
    /provider offline/
  );

  const task = db.prepare("SELECT * FROM async_tasks WHERE type = 'redraw_analysis'").get();
  assert.equal(task.status, 'failed');
  assert.equal(db.prepare('SELECT status FROM redraw_works WHERE id = ?').get('work-1').status, 'failed');
  assert.equal(db.prepare('SELECT status FROM usage_reservations WHERE id = ?').get(task.credit_reservation_id).status, 'refunded');
  assert.equal(creditLedger.getAccount(db, 'user-1').available, 100);
});

test('startAnalysis rejects empty provider task id after reserving and refunds', async () => {
  const db = createDb();
  addVerifiedConfig(db);
  addWorkAndAssets(db);
  prices.set(db, 'GPT-5.5', 6);

  await assert.rejects(
    () => redraw.startAnalysis(db, log, { workId: 'work-1', userId: 'user-1' }, {
      provider: { startAnalysis: async () => ({}) },
    }),
    /缺少厂商任务 ID/
  );

  const task = db.prepare("SELECT * FROM async_tasks WHERE type = 'redraw_analysis'").get();
  assert.equal(task.status, 'failed');
  assert.equal(db.prepare('SELECT status FROM redraw_works WHERE id = ?').get('work-1').status, 'failed');
  assert.equal(db.prepare('SELECT status FROM usage_reservations WHERE id = ?').get(task.credit_reservation_id).status, 'refunded');
});

test('default startup asset reader requires readable local files and does not trust url strings', async () => {
  const db = createDb();
  addVerifiedConfig(db);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-assets-'));
  try {
    addWorkAndAssets(db);
    db.prepare('UPDATE assets SET local_path = ? WHERE id = ?').run('missing/source.mp4', 'asset-source');
    prices.set(db, 'GPT-5.5', 6);
    const started = await redraw.startAnalysis(db, log, { workId: 'work-1', userId: 'user-1' }, {
      provider: { startAnalysis: async () => ({ provider_task_id: 'provider-unreadable-local' }) },
    });

    const failed = await redraw.runAnalyzeTask(db, log, started.task_id, {
      provider: { pollAnalysisTask: async () => ({ status: 'completed', result_asset_id: 'asset-result', facts: validFacts() }) },
      assetReader: redraw.createAssetReader({ storageRoot: tempRoot }),
    });
    assert.equal(failed.status, 'failed');

    db.prepare('DELETE FROM assets').run();
    db.prepare('INSERT INTO assets (id, local_path) VALUES (?, ?)').run('asset-source-2', path.join(tempRoot, 'source.mp4'));
    fs.writeFileSync(path.join(tempRoot, 'source.mp4'), 'source');
    db.prepare('INSERT INTO assets (id, url) VALUES (?, ?)').run('asset-result-2', 'https://cdn.example/result.json');
    db.prepare('INSERT INTO redraw_works (id, user_id, source_asset_id, status, current_step) VALUES (?, ?, ?, ?, ?)')
      .run('work-url', 'user-1', 'asset-source-2', 'draft', 1);
    const startedUrl = await redraw.startAnalysis(db, log, { workId: 'work-url', userId: 'user-1' }, {
      provider: { startAnalysis: async () => ({ provider_task_id: 'provider-url' }) },
    });
    const urlFailed = await redraw.runAnalyzeTask(db, log, startedUrl.task_id, {
      provider: { pollAnalysisTask: async () => ({ status: 'completed', result_asset_id: 'asset-result-2', facts: validFacts() }) },
      assetReader: redraw.createAssetReader({ storageRoot: tempRoot }),
    });
    assert.equal(urlFailed.status, 'failed');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('startup asset reader rejects absolute paths, traversal and symlink escapes', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-safe-assets-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-outside-assets-'));
  try {
    fs.mkdirSync(path.join(tempRoot, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'uploads', 'source.mp4'), 'source');
    fs.writeFileSync(path.join(outsideRoot, 'outside.mp4'), 'outside');
    const reader = redraw.createAssetReader({ storageRoot: tempRoot });

    assert.equal(reader.canRead({ local_path: 'uploads/source.mp4' }), true);
    assert.equal(reader.canRead({ local_path: path.join(tempRoot, 'uploads', 'source.mp4') }), false);
    assert.equal(reader.canRead({ local_path: path.join('..', path.basename(outsideRoot), 'outside.mp4') }), false);

    const linkPath = path.join(tempRoot, 'uploads', 'linked-outside.mp4');
    try {
      fs.symlinkSync(path.join(outsideRoot, 'outside.mp4'), linkPath);
      assert.equal(reader.canRead({ local_path: 'uploads/linked-outside.mp4' }), false);
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(outsideRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('runAnalyzeTask detects facts_hash conflicts without mixing shots or settling again', async () => {
  const db = createDb();
  addVerifiedConfig(db);
  addWorkAndAssets(db);
  prices.set(db, 'GPT-5.5', 6);
  const started = await redraw.startAnalysis(db, log, { workId: 'work-1', userId: 'user-1' }, {
    provider: { startAnalysis: async () => ({ provider_task_id: 'provider-conflict' }) },
  });
  await redraw.runAnalyzeTask(db, log, started.task_id, {
    provider: { pollAnalysisTask: async () => ({ status: 'completed', result_asset_id: 'asset-result', facts: validFacts() }) },
    assetReader: { canRead: (asset) => Boolean(asset?.local_path) },
  });
  const changedFacts = validFacts();
  changedFacts.locked_facts = ['阿岚在天台收到另一条消息'];

  const conflict = await redraw.runAnalyzeTask(db, log, started.task_id, {
    provider: { pollAnalysisTask: async () => ({ status: 'completed', result_asset_id: 'asset-result', facts: changedFacts }) },
    assetReader: { canRead: (asset) => Boolean(asset?.local_path) },
  });

  assert.equal(conflict.status, 'needs_attention');
  assert.equal(db.prepare('SELECT status FROM redraw_works WHERE id = ?').get('work-1').status, 'needs_attention');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM redraw_versions WHERE work_id = ?').get('work-1').n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM redraw_shots WHERE work_id = ?').get('work-1').n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE event_type = 'confirm'").get().n, 1);
});

test('runAnalyzeTask refunds explicit failure and keeps source asset id', async () => {
  const db = createDb();
  addVerifiedConfig(db);
  addWorkAndAssets(db);
  prices.set(db, 'GPT-5.5', 6);
  const started = await redraw.startAnalysis(db, log, { workId: 'work-1', userId: 'user-1' }, {
    provider: { startAnalysis: async () => ({ provider_task_id: 'provider-failed' }) },
  });

  await redraw.runAnalyzeTask(db, log, started.task_id, {
    provider: { pollAnalysisTask: async () => ({ status: 'failed', error: '供应商拒绝分析' }) },
  });

  const work = db.prepare('SELECT status, source_asset_id FROM redraw_works WHERE id = ?').get('work-1');
  assert.equal(work.status, 'failed');
  assert.equal(work.source_asset_id, 'asset-source');
  assert.equal(creditLedger.getAccount(db, 'user-1').available, 100);
});

test('runAnalyzeTask keeps credits held and marks needs_attention for unknown status', async () => {
  const db = createDb();
  addVerifiedConfig(db);
  addWorkAndAssets(db);
  prices.set(db, 'GPT-5.5', 6);
  const started = await redraw.startAnalysis(db, log, { workId: 'work-1', userId: 'user-1' }, {
    provider: { startAnalysis: async () => ({ provider_task_id: 'provider-unknown' }) },
  });

  await redraw.runAnalyzeTask(db, log, started.task_id, {
    provider: { pollAnalysisTask: async () => ({ status: 'mystery' }) },
  });

  assert.equal(db.prepare('SELECT status FROM redraw_works WHERE id = ?').get('work-1').status, 'needs_attention');
  assert.equal(taskService.getTask(db, started.task_id).status, 'needs_attention');
  assert.equal(creditLedger.getAccount(db, 'user-1').held, 6);
});

test('resumeRedrawTasks polls provider-backed processing tasks and fails tasks without provider id', async () => {
  const db = createDb();
  addVerifiedConfig(db);
  addWorkAndAssets(db);
  prices.set(db, 'GPT-5.5', 6);
  const resumable = await redraw.startAnalysis(db, log, { workId: 'work-1', userId: 'user-1' }, {
    provider: { startAnalysis: async () => ({ provider_task_id: 'provider-resume' }) },
  });
  db.prepare('INSERT INTO redraw_works (id, user_id, source_asset_id, status, current_step) VALUES (?, ?, ?, ?, ?)')
    .run('work-2', 'user-1', 'asset-source', 'draft', 1);
  const interrupted = await redraw.startAnalysis(db, log, { workId: 'work-2', userId: 'user-1' }, {
    provider: { startAnalysis: async () => ({ provider_task_id: 'provider-lost' }) },
  });
  db.prepare('UPDATE async_tasks SET provider_task_id = NULL WHERE id = ?').run(interrupted.task_id);
  db.prepare('UPDATE redraw_works SET provider_task_id = NULL WHERE id = ?').run('work-2');

  let polled = 0;
  await redraw.resumeRedrawTasks(db, log, {
    provider: {
      pollAnalysisTask: async () => {
        polled += 1;
        return { status: 'processing' };
      },
    },
  });

  assert.equal(polled, 1);
  assert.equal(taskService.getTask(db, resumable.task_id).status, 'processing');
  assert.equal(taskService.getTask(db, interrupted.task_id).status, 'failed');
  assert.equal(db.prepare('SELECT status FROM redraw_works WHERE id = ?').get('work-2').status, 'failed');
  assert.equal(creditLedger.getAccount(db, 'user-1').available, 94);
  assert.equal(db.prepare("SELECT status FROM usage_reservations WHERE resource_id = 'work-2'").get().status, 'refunded');
});

test('startup resume without a configured queryer marks provider-backed task needs_attention', async () => {
  const db = createDb();
  addVerifiedConfig(db);
  const started = await startWork(db, 'provider-no-queryer');

  const result = await redraw.resumeRedrawTasks(db, log, redraw.createStartupResumeOptions(db, log, { storageRoot: process.cwd() }));

  assert.equal(result.resumed, 1);
  assert.equal(taskService.getTask(db, started.task_id).status, 'needs_attention');
  assert.equal(db.prepare('SELECT status FROM redraw_works WHERE id = ?').get('work-1').status, 'needs_attention');
  assert.equal(creditLedger.getAccount(db, 'user-1').held, 6);
});

test('startup resume marks provider-backed task needs_attention when query endpoint is unreachable', async () => {
  const db = createDb();
  const server = await listen(http.createServer((_, res) => res.end('unused')));
  const port = server.address().port;
  await close(server);
  addVerifiedConfigWithQuery(db, `http://127.0.0.1:${port}`);
  const started = await startWork(db, 'provider-unreachable');

  const result = await redraw.resumeRedrawTasks(db, log, redraw.createStartupResumeOptions(db, log, { storageRoot: process.cwd() }));

  assert.equal(result.resumed, 1);
  assert.equal(taskService.getTask(db, started.task_id).status, 'needs_attention');
  assert.match(taskService.getTask(db, started.task_id).error, /源片分析恢复查询不可用/);
  assert.equal(db.prepare('SELECT status FROM redraw_works WHERE id = ?').get('work-1').status, 'needs_attention');
  assert.equal(db.prepare('SELECT status FROM usage_reservations WHERE id = ?').get(started.reservation_id).status, 'held');
  assert.equal(creditLedger.getAccount(db, 'user-1').held, 6);
  assert.equal(creditLedger.getAccount(db, 'user-1').spent, 0);
});

test('startup resume marks provider-backed task needs_attention when query response is invalid JSON', async () => {
  const db = createDb();
  let server;
  server = await listen(http.createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{invalid-json');
  }));
  try {
    addVerifiedConfigWithQuery(db, `http://127.0.0.1:${server.address().port}`);
    const started = await startWork(db, 'provider-bad-json');

    const result = await redraw.resumeRedrawTasks(db, log, redraw.createStartupResumeOptions(db, log, { storageRoot: process.cwd() }));

    assert.equal(result.resumed, 1);
    assert.equal(taskService.getTask(db, started.task_id).status, 'needs_attention');
    assert.match(taskService.getTask(db, started.task_id).error, /源片分析恢复查询不可用/);
    assert.equal(db.prepare('SELECT status FROM redraw_works WHERE id = ?').get('work-1').status, 'needs_attention');
    assert.equal(db.prepare('SELECT status FROM usage_reservations WHERE id = ?').get(started.reservation_id).status, 'held');
    assert.equal(creditLedger.getAccount(db, 'user-1').held, 6);
    assert.equal(creditLedger.getAccount(db, 'user-1').spent, 0);
  } finally {
    await close(server);
  }
});

test('startup resume times out slow query and keeps credits held', async () => {
  const previousTimeout = process.env.REDRAW_RESUME_QUERY_TIMEOUT_MS;
  process.env.REDRAW_RESUME_QUERY_TIMEOUT_MS = '25';
  const db = createDb();
  let server;
  server = await listen(http.createServer((_, res) => {
    setTimeout(() => {
      if (!res.destroyed) res.end(JSON.stringify({ status: 'processing' }));
    }, 250);
  }));
  try {
    addVerifiedConfigWithQuery(db, `http://127.0.0.1:${server.address().port}`);
    const started = await startWork(db, 'provider-timeout');
    const startedAt = Date.now();

    const result = await redraw.resumeRedrawTasks(db, log, redraw.createStartupResumeOptions(db, log, { storageRoot: process.cwd() }));

    assert.equal(result.resumed, 1);
    assert.ok(Date.now() - startedAt < 200);
    assert.equal(taskService.getTask(db, started.task_id).status, 'needs_attention');
    assert.equal(db.prepare('SELECT status FROM redraw_works WHERE id = ?').get('work-1').status, 'needs_attention');
    assert.equal(db.prepare('SELECT status FROM usage_reservations WHERE id = ?').get(started.reservation_id).status, 'held');
  } finally {
    if (previousTimeout === undefined) delete process.env.REDRAW_RESUME_QUERY_TIMEOUT_MS;
    else process.env.REDRAW_RESUME_QUERY_TIMEOUT_MS = previousTimeout;
    await close(server);
  }
});

test('startup resume uses configured HTTP query endpoint to complete provider task', async () => {
  const db = createDb();
  let authorization = '';
  let server;
  server = await listen(http.createServer((req, res) => {
    authorization = req.headers.authorization || '';
    assert.equal(req.url, '/query/provider-http');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      status: 'completed',
      result_asset_id: 'asset-result',
      facts: validFacts(),
    }));
  }));
  try {
    addVerifiedConfigWithQuery(db, `http://127.0.0.1:${server.address().port}`);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-http-assets-'));
    try {
      fs.mkdirSync(path.join(tempRoot, 'uploads'), { recursive: true });
      fs.writeFileSync(path.join(tempRoot, 'uploads', 'source.mp4'), 'source');
      fs.writeFileSync(path.join(tempRoot, 'uploads', 'result.json'), 'result');
      addWorkAndAssets(db);
      prices.set(db, 'GPT-5.5', 6);
      const started = await redraw.startAnalysis(db, log, { workId: 'work-1', userId: 'user-1' }, {
        provider: { startAnalysis: async () => ({ provider_task_id: 'provider-http' }) },
      });

      await redraw.resumeRedrawTasks(db, log, redraw.createStartupResumeOptions(db, log, { storageRoot: tempRoot }));

      assert.equal(authorization, 'Bearer resume-secret');
      assert.equal(taskService.getTask(db, started.task_id).status, 'completed');
      assert.equal(db.prepare('SELECT status FROM redraw_works WHERE id = ?').get('work-1').status, 'asset_review');
      assert.equal(creditLedger.getAccount(db, 'user-1').spent, 6);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  } finally {
    await close(server);
  }
});

test('runMigrationsAndEnsure creates redraw analysis schema and async provider task id', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);

  const asyncColumns = db.prepare('PRAGMA table_info(async_tasks)').all().map((row) => row.name);
  assert.ok(asyncColumns.includes('provider_task_id'));
  for (const table of ['redraw_works', 'redraw_versions', 'redraw_shots']) {
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).name, table);
  }
  const workColumns = db.prepare('PRAGMA table_info(redraw_works)').all().map((row) => row.name);
  assert.ok(workColumns.includes('source_asset_id'));
  assert.ok(workColumns.includes('provider_task_id'));
  assert.ok(workColumns.includes('credit_reservation_id'));
});

test('createApp resumes redraw analysis tasks after orphan cleanup', async () => {
  const previousCwd = process.cwd();
  const previousWebDist = process.env.WEB_DIST_PATH;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-redraw-startup-'));
  const configRoot = path.join(tempRoot, 'configs');
  const databasePath = path.join(tempRoot, 'drama.sqlite').replace(/\\/g, '/');
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, 'config.yaml'),
    [
      'app:',
      '  name: LocalMiniDrama redraw startup test',
      '  version: test',
      'server:',
      '  host: 127.0.0.1',
      '  port: 0',
      'database:',
      '  type: sqlite',
      `  path: ${databasePath}`,
      'storage:',
      '  type: local',
      `  local_path: ${path.join(tempRoot, 'storage').replace(/\\/g, '/')}`,
      '  base_url: http://127.0.0.1:0/static',
      'vendor_lock:',
      '  enabled: false',
    ].join('\n'),
    'utf8'
  );

  const db = new Database(databasePath);
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO assets (id, local_path, created_at, updated_at) VALUES (101, 'uploads/source.mp4', ?, ?)")
    .run(now, now);
  db.prepare("INSERT INTO assets (id, local_path, created_at, updated_at) VALUES (102, 'uploads/result.json', ?, ?)")
    .run(now, now);
  db.prepare(`
    INSERT INTO redraw_projects (id, tenant_id, user_id, title, status, created_at, updated_at)
    VALUES (1, 'tenant-1', 'user-1', '启动恢复项目', 'draft', ?, ?)
  `).run(now, now);
  creditLedger.ensureSchema(db);
  creditLedger.setAccountBalance(db, 'user-1', 100);
  const held = creditLedger.reserve(db, {
    userId: 'user-1',
    operationKey: 'redraw-startup',
    amount: 6,
    model: 'GPT-5.5',
    resourceType: 'redraw_analysis',
    resourceId: '1',
  });
  db.prepare(`
    INSERT INTO async_tasks
      (id, type, status, progress, message, resource_id, user_id, model, credit_reservation_id, provider_task_id, created_at, updated_at)
    VALUES ('task-startup', 'redraw_analysis', 'processing', 90, '', '1', 'user-1', 'GPT-5.5', ?, 'provider-startup', ?, ?)
  `).run(held.id, now, now);
  db.prepare(`
    INSERT INTO redraw_works
      (id, project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms,
       status, current_step, task_id, provider_task_id, credit_reservation_id, created_at, updated_at)
    VALUES (1, 1, 'tenant-1', 'user-1', '启动恢复作品', 101, 'startup-fingerprint', 15000,
      'analyzing', 1, 'task-startup', 'provider-startup', ?, ?, ?)
  `).run(held.id, now, now);
  db.close();

  const orchestrator = require('../src/services/redrawOrchestrator');
  const originalCreateStartupResumeOptions = orchestrator.createStartupResumeOptions;
  orchestrator.createStartupResumeOptions = () => ({
    provider: {
      pollAnalysisTask: async () => ({ status: 'completed', result_asset_id: 102, facts: validFacts() }),
    },
    assetReader: { canRead: (asset) => Boolean(asset?.local_path || asset?.url) },
  });

  let created;
  try {
    process.chdir(tempRoot);
    process.env.WEB_DIST_PATH = path.join(tempRoot, 'missing-web-dist');
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/app')];
    const { createApp } = require('../src/app');
    created = createApp();
    await waitFor(() => {
      const row = created.db.prepare('SELECT status FROM usage_reservations WHERE id = ?').get(held.id);
      return row?.status === 'confirmed';
    }, 1000);

    assert.equal(created.db.prepare('SELECT status FROM redraw_works WHERE id = ?').get(1).status, 'asset_review');
    assert.equal(taskService.getTask(created.db, 'task-startup').status, 'completed');
    assert.equal(created.db.prepare('SELECT status FROM usage_reservations WHERE id = ?').get(held.id).status, 'confirmed');
    assert.equal(creditLedger.getAccount(created.db, 'user-1').spent, 6);
  } finally {
    try {
      require('../src/db').closeDb();
    } catch (_) {
      if (created?.db?.open) created.db.close();
    }
    orchestrator.createStartupResumeOptions = originalCreateStartupResumeOptions;
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/app')];
    process.chdir(previousCwd);
    if (previousWebDist === undefined) delete process.env.WEB_DIST_PATH;
    else process.env.WEB_DIST_PATH = previousWebDist;
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('createApp wires redraw resume before orphan cleanup', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  assert.ok(
    appSource.indexOf('resumeRedrawTasks') < appSource.indexOf('failOrphanedAsyncTasksOnStartup'),
    'redraw resume must run before generic orphan cleanup'
  );
});
