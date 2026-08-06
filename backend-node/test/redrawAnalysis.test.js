const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const creditLedger = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const taskService = require('../src/services/taskService');
const { normalizeSourceFacts } = require('../src/services/redrawAnalysisService');
const redraw = require('../src/services/redrawOrchestrator');

const log = { info() {}, warn() {}, error() {} };

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

function addWorkAndAssets(db) {
  db.prepare('INSERT INTO assets (id, local_path) VALUES (?, ?)').run('asset-source', 'uploads/source.mp4');
  db.prepare('INSERT INTO assets (id, local_path) VALUES (?, ?)').run('asset-result', 'uploads/result.json');
  db.prepare('INSERT INTO redraw_works (id, user_id, source_asset_id, status, current_step) VALUES (?, ?, ?, ?, ?)')
    .run('work-1', 'user-1', 'asset-source', 'draft', 1);
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
    provider: { startAnalysis: async () => ({}) },
  });

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
});
