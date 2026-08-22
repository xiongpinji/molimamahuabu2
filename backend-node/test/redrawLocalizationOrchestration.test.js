const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const credits = require('../src/services/creditLedgerService');
const modelPrice = require('../src/services/modelPriceService');
const taskService = require('../src/services/taskService');
const {
  buildLocalizationInput,
} = require('../src/services/localizationService');
const {
  quoteLocalization,
  startLocalization,
  reconcileOrphanedTasks,
} = require('../src/services/redrawLocalizationOrchestrator');

function sourceFacts() {
  return {
    schema_version: '1.0',
    duration_ms: 10_000,
    characters: [
      { id: 'c1', source_name: '小满', relationships: [{ id: 'rel-1', from: 'c1', to: 'c2', type: 'sister' }] },
      { id: 'c2', source_name: '阿岚', relationships: [] },
    ],
    scenes: [{ id: 's1', location: '天台', time: '夜', source_ranges: [{ start_ms: 0, end_ms: 10_000 }] }],
    props: [{ id: 'p1', name: '旧手机', evidence_ranges: [{ start_ms: 1_200, end_ms: 1_800 }] }],
    shots: [
      {
        id: 'shot-1',
        start_ms: 0,
        end_ms: 5_000,
        dialogue: [{ speaker_id: 'c1', text: '别回头' }],
        opening_state: '小满站在天台边',
        continuous_action: '小满低头查看旧手机',
        ending_state: '屏幕亮起陌生消息',
      },
      {
        id: 'shot-2',
        start_ms: 5_000,
        end_ms: 10_000,
        dialogue: [],
        opening_state: '屏幕显示未来日期',
        continuous_action: '小满抬头环顾天台',
        ending_state: '小满转身离开',
      },
    ],
    causal_chain: [{ id: 'cause-1', from: 'message', to: 'departure', text: '消息促使小满离开' }],
    reversals: [{ id: 'reverse-1', text: '阿岚其实在楼下等待' }],
    locked_facts: [{ id: 'fact-1', text: '小满在天台收到旧手机消息' }],
    episode_hook: { id: 'hook-1', text: '消息来自未来' },
  };
}

function v2SourceFacts() {
  return {
    schema_version: '2.0',
    facts_hash: 'a'.repeat(64),
    locale: 'en-US',
    market: 'US',
    duration_ms: 8_000,
    characters: [
      { id: 'c1', source_name: '小满', relationships: [] },
      { id: 'c2', source_name: '阿岚', relationships: [] },
    ],
    shots: [
      {
        id: 'shot-1',
        start_ms: 0,
        end_ms: 4_000,
        composition: 'medium two shot',
        camera_movement: 'slow push',
        opening_state: '小满站在门口',
        continuous_action: '小满看向阿岚',
        ending_state: '阿岚低头',
        visible_character_ids: ['c1', 'c2'],
        text_regions: [],
        audio_contract: { ambience: 'quiet room' },
        dialogue: [{
          id: 'turn-1',
          speaker_id: 'c1',
          source_text: '别回头',
          start_ms: 500,
          end_ms: 2_500,
          emotion: 'urgent',
          overlap_group: null,
        }],
      },
      {
        id: 'shot-2',
        start_ms: 4_000,
        end_ms: 8_000,
        composition: 'insert phone',
        camera_movement: 'static',
        opening_state: '手机屏幕亮起',
        continuous_action: '屏幕显示来电',
        ending_state: '小满伸手',
        visible_character_ids: ['c1'],
        text_regions: [{
          id: 'screen-1',
          kind: 'phone_screen',
          source_text: '给妈妈打电话',
          polygon: [[0, 0], [1, 0], [1, 1], [0, 1]],
        }],
        audio_contract: { ambience: 'phone buzz' },
        dialogue: [],
      },
    ],
  };
}

function localizedResult(overrides = {}) {
  return {
    ...sourceFacts(),
    facts_hash: buildLocalizationInput(sourceFacts(), { locale: 'en-US' }).source_facts_hash,
    name_map: { 小满: 'Maya', 阿岚: 'Aran' },
    culture_map: { currency: 'USD' },
    glossary: { 旧手机: 'old phone' },
    dialogue: [{
      shot_id: 'shot-1',
      turns: [{ speaker_id: 'c1', localized_text: "Don't look back" }],
    }],
    ...overrides,
  };
}

function v2LocalizedResult(overrides = {}) {
  const facts = v2SourceFacts();
  return {
    facts_hash: facts.facts_hash,
    name_map: { c1: 'Mateo', c2: 'Diego' },
    culture_map: { honorifics: 'Use first names in casual dialogue' },
    glossary: { family_title: 'Mom' },
    dialogue: [{
      shot_id: 'shot-1',
      turns: [{ id: 'turn-1', target_text: 'Do not look back' }],
    }],
    text_map: { 'shot-2:screen-1': 'CALL MOM' },
    confidence: {
      names: 0.92,
      dialogue_semantics: 0.93,
      dialogue_timing: 0.94,
      culture: 0.91,
      screen_text: 0.9,
    },
    ...overrides,
  };
}

function createDb(options = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE async_tasks (
      id TEXT PRIMARY KEY,
      type TEXT,
      status TEXT,
      progress INTEGER DEFAULT 0,
      message TEXT,
      error TEXT,
      result TEXT,
      resource_id TEXT,
      tenant_id TEXT,
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
      id INTEGER PRIMARY KEY,
      project_id INTEGER,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      current_version INTEGER NOT NULL DEFAULT 0,
      current_step INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'fact_confirmed' CHECK (status IN ('draft', 'fact_confirmed', 'analyzing', 'asset_review', 'ready_to_generate', 'generating', 'composing', 'completed', 'failed', 'needs_attention', 'needs_review', 'blocked')),
      task_id TEXT,
      updated_at TEXT
    );
    CREATE TABLE redraw_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      tenant_id TEXT,
      user_id TEXT,
      version INTEGER NOT NULL,
      locale TEXT NOT NULL,
      market TEXT NOT NULL DEFAULT '',
      localization_level TEXT NOT NULL DEFAULT 'faithful',
      source_facts_json TEXT,
      glossary_json TEXT NOT NULL DEFAULT '{}',
      name_map_json TEXT NOT NULL DEFAULT '{}',
      culture_map_json TEXT NOT NULL DEFAULT '{}',
      text_map_json TEXT NOT NULL DEFAULT '{}',
      style_snapshot_json TEXT NOT NULL DEFAULT '{}',
      capability_snapshot_json TEXT NOT NULL DEFAULT '{}',
      localization_task_id TEXT,
      localization_credit_reservation_id TEXT,
      localization_input_hash TEXT,
      localization_idempotency_key TEXT,
      localization_model_snapshot_json TEXT NOT NULL DEFAULT '{}',
      facts_hash TEXT,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'analyzing', 'asset_review', 'ready_to_generate', 'generating', 'composing', 'completed', 'failed', 'needs_attention', 'needs_review', 'blocked')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE redraw_projects (
      id INTEGER PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      execution_mode TEXT DEFAULT 'safe',
      budget_limit_credits INTEGER,
      automation_policy_json TEXT,
      policy_version INTEGER DEFAULT 1,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE redraw_workflow_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      project_id INTEGER NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      evidence_hash TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX uq_redraw_version_number ON redraw_versions(work_id, version);
    CREATE UNIQUE INDEX uq_redraw_version_localization_key
      ON redraw_versions(work_id, tenant_id, user_id, localization_idempotency_key)
      WHERE deleted_at IS NULL AND localization_idempotency_key IS NOT NULL;
    CREATE TABLE redraw_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version_id INTEGER NOT NULL,
      tenant_id TEXT,
      user_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('character', 'scene', 'prop', 'voice')),
      source_ref_json TEXT NOT NULL DEFAULT '{}',
      localized_name TEXT NOT NULL DEFAULT '',
      localized_description TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL DEFAULT '',
      version_number INTEGER NOT NULL DEFAULT 1,
      approval_status TEXT NOT NULL DEFAULT 'pending',
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE redraw_shots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER,
      shot_id TEXT,
      version_id INTEGER NOT NULL,
      tenant_id TEXT,
      user_id TEXT,
      batch_index INTEGER NOT NULL,
      shot_index INTEGER NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      source_dialogue_json TEXT NOT NULL DEFAULT '[]',
      localized_dialogue_json TEXT NOT NULL DEFAULT '[]',
      references_json TEXT NOT NULL DEFAULT '[]',
      opening_state TEXT NOT NULL DEFAULT '',
      continuous_action TEXT NOT NULL DEFAULT '',
      ending_state TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL DEFAULT '',
      negative_prompt TEXT NOT NULL DEFAULT '',
      compiled_prompt_json TEXT NOT NULL DEFAULT '{}',
      draft_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE UNIQUE INDEX uq_redraw_shot_order ON redraw_shots(version_id, batch_index, shot_index);
    CREATE TABLE ai_service_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_type TEXT,
      model TEXT,
      default_model TEXT,
      settings TEXT,
      is_active INTEGER DEFAULT 1,
      is_default INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 0,
      deleted_at TEXT
    );
  `);
  credits.ensureSchema(db);
  modelPrice.ensureSchema(db);
  credits.setTenantAccountBalance(db, 'tenant-a', options.balance ?? 100);
  if (options.price !== false) {
    modelPrice.set(db, 'gpt-localize', 7, { category: 'text' });
  }
  if (options.capability !== false) {
    db.prepare(`
      INSERT INTO ai_service_configs (service_type, model, default_model, settings, is_active, is_default, priority)
      VALUES ('text', 'gpt-localize', 'gpt-localize', ?, 1, 1, 10)
    `).run(JSON.stringify({
      redraw_locale_capabilities: [{
        status: 'verified',
        locale: 'en-US',
        market: 'US',
        evidence: {
          text: {
            provider: 'verified-provider',
            model: 'gpt-localize',
            task_id: 'capability-task',
            terminal_status: 'completed',
            artifact_id: 'capability-artifact',
          },
        },
      }],
    }));
  }
  const now = new Date().toISOString();
  const facts = options.sourceFacts || sourceFacts();
  const factsHash = facts.schema_version === '2.0'
    ? facts.facts_hash
    : buildLocalizationInput(facts, { locale: 'source' }).source_facts_hash;
  db.prepare(`
    INSERT INTO redraw_projects
      (id, tenant_id, user_id, execution_mode, budget_limit_credits, automation_policy_json, policy_version, updated_at)
    VALUES (1, 'tenant-a', 'user-a', ?, ?, ?, 1, ?)
  `).run(options.executionMode || 'auto', options.budgetLimit ?? 30, JSON.stringify(options.automationPolicy || {}), now);
  db.prepare('INSERT INTO redraw_works (id, project_id, tenant_id, user_id, current_version, current_step, status, task_id, updated_at) VALUES (1, 1, ?, ?, 1, 1, ?, ?, ?)')
    .run('tenant-a', 'user-a', 'fact_confirmed', 'task-analysis', now);
  const sourceVersionId = Number(db.prepare(`
    INSERT INTO redraw_versions
      (work_id, tenant_id, user_id, version, locale, market, localization_level,
       source_facts_json, facts_hash, style_snapshot_json, status, created_at, updated_at)
    VALUES (1, 'tenant-a', 'user-a', 1, 'source', '', 'faithful', ?, ?, ?, 'asset_review', ?, ?)
  `).run(JSON.stringify(facts), factsHash, JSON.stringify({ tone: 'thriller' }), now, now).lastInsertRowid);
  const insertShot = db.prepare(`
    INSERT INTO redraw_shots
      (work_id, shot_id, version_id, tenant_id, user_id, batch_index, shot_index,
       start_ms, end_ms, duration_ms, source_dialogue_json, localized_dialogue_json,
       references_json, opening_state, continuous_action, ending_state, created_at, updated_at)
    VALUES (1, ?, ?, 'tenant-a', 'user-a', 1, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?, ?, ?)
  `);
  facts.shots.forEach((shot, index) => insertShot.run(
    shot.id,
    sourceVersionId,
    index + 1,
    shot.start_ms,
    shot.end_ms,
    shot.end_ms - shot.start_ms,
    JSON.stringify(shot.dialogue),
    shot.opening_state,
    shot.continuous_action,
    shot.ending_state,
    now,
    now,
  ));
  setAnalysisDecision(db, {
    action: 'advance',
    effective_mode: 'auto',
    reason_codes: [],
    policy_version: 1,
    evidence_hash: factsHash,
    effective_analysis_state: 'asset_review',
  }, sourceVersionId);
  return db;
}

function setAnalysisDecision(db, decision, versionId = 1) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO async_tasks
      (id, type, status, progress, message, result, resource_id, tenant_id, user_id, created_at, updated_at, completed_at)
    VALUES ('task-analysis', 'redraw_analysis', 'completed', 100, '分析完成', ?, '1', 'tenant-a', 'user-a', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET result = excluded.result, updated_at = excluded.updated_at
  `).run(JSON.stringify({
    status: 'completed',
    work_id: 1,
    version_id: versionId,
    facts_hash: decision.evidence_hash,
    automation_decision: decision,
  }), now, now, now);
}

function quoteInput(overrides = {}) {
  return {
    tenantId: 'tenant-a',
    userId: 'user-a',
    workId: 1,
    locale: 'en-US',
    market: 'US',
    localizationLevel: 'faithful',
    canReadArtifact: (artifactId) => artifactId === 'capability-artifact',
    ...overrides,
  };
}

function providerReturning(result) {
  const calls = [];
  const provider = async (input) => {
    calls.push(input);
    return {
      provider_task_id: 'provider-task-1',
      result,
    };
  };
  provider.calls = calls;
  return provider;
}

async function startWithQuote(db, overrides = {}, deps = {}) {
  const quote = quoteLocalization(db, quoteInput(overrides));
  return startLocalization(db, { info() {}, warn() {}, error() {} }, {
    ...quoteInput(overrides),
    idempotencyKey: overrides.idempotencyKey || 'idem-1',
    quoteHash: quote.quote_hash,
  }, {
    schedule: (job) => job(),
    ...deps,
  });
}

test('quotes only when verified text capability and model price are available', () => {
  const db = createDb();
  const quote = quoteLocalization(db, quoteInput());
  assert.equal(quote.priced, true);
  assert.equal(quote.credits, 7);
  assert.equal(quote.model, 'gpt-localize');
  assert.match(quote.input_hash, /^[a-f0-9]{64}$/);
  assert.match(quote.quote_hash, /^[a-f0-9]{64}$/);
  assert.equal(quote.snapshot.capability.provider, 'verified-provider');
  assert.equal(quote.snapshot.input.style_snapshot.tone, 'thriller');
  db.close();
});

test('quote fails closed before capability and pricing when analysis decision did not advance', () => {
  for (const decision of [
    {
      action: 'needs_review',
      effective_mode: 'safe',
      reason_codes: ['speaker_mapping_low_confidence'],
      policy_version: 1,
      evidence_hash: buildLocalizationInput(sourceFacts(), { locale: 'source' }).source_facts_hash,
      effective_analysis_state: 'analysis_review',
    },
    {
      action: 'blocked',
      effective_mode: 'safe',
      reason_codes: ['project_policy_missing'],
      policy_version: 1,
      evidence_hash: buildLocalizationInput(sourceFacts(), { locale: 'source' }).source_facts_hash,
      effective_analysis_state: 'blocked',
    },
  ]) {
    const db = createDb({ capability: false, price: false });
    setAnalysisDecision(db, decision);
    const quote = quoteLocalization(db, quoteInput());
    assert.equal(quote.priced, false);
    assert.equal(quote.code, 'REDRAW_LOCALIZATION_ANALYSIS_NOT_ADVANCED');
    assert.deepEqual(quote.automation_decision, decision);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM async_tasks WHERE type = 'redraw_localization'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE resource_type = 'redraw_localization'").get().count, 0);
    db.close();
  }
});

test('start fails closed before draft, reservation, task, and provider when analysis decision is missing or stale', () => {
  for (const setup of [
    (db) => db.prepare('UPDATE async_tasks SET result = NULL WHERE id = ?').run('task-analysis'),
    (db) => setAnalysisDecision(db, {
      action: 'advance',
      effective_mode: 'auto',
      reason_codes: [],
      policy_version: 1,
      evidence_hash: 'stale-facts-hash',
      effective_analysis_state: 'asset_review',
    }),
    (db) => setAnalysisDecision(db, {
      action: 'needs_review',
      effective_mode: 'safe',
      reason_codes: ['safe_mode_requires_review'],
      policy_version: 1,
      evidence_hash: buildLocalizationInput(sourceFacts(), { locale: 'source' }).source_facts_hash,
      effective_analysis_state: 'analysis_review',
    }),
  ]) {
    const db = createDb();
    setup(db);
    const provider = providerReturning(localizedResult());
    assert.throws(
      () => startLocalization(db, { info() {}, warn() {}, error() {} }, {
        ...quoteInput(),
        idempotencyKey: 'idem-analysis-gate',
        quoteHash: 'client-quote',
      }, { provider, schedule: (job) => job() }),
      (error) => error.code === 'REDRAW_LOCALIZATION_ANALYSIS_NOT_ADVANCED',
    );
    assert.equal(provider.calls.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_versions').get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM async_tasks WHERE type = 'redraw_localization'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE resource_type = 'redraw_localization'").get().count, 0);
    db.close();
  }
});

test('quote and start fail closed when current project policy version drifted after analysis advance', () => {
  const db = createDb({ capability: false, price: false });
  db.prepare("UPDATE redraw_projects SET policy_version = 2, execution_mode = 'safe' WHERE id = 1").run();
  const provider = providerReturning(localizedResult());

  const quote = quoteLocalization(db, quoteInput());
  assert.equal(quote.priced, false);
  assert.equal(quote.code, 'REDRAW_LOCALIZATION_ANALYSIS_NOT_ADVANCED');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM async_tasks WHERE type = 'redraw_localization'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE resource_type = 'redraw_localization'").get().count, 0);

  assert.throws(
    () => startLocalization(db, { info() {}, warn() {}, error() {} }, {
      ...quoteInput(),
      idempotencyKey: 'idem-policy-drift',
      quoteHash: 'stale-quote',
    }, { provider, schedule: (job) => job() }),
    (error) => error.code === 'REDRAW_LOCALIZATION_ANALYSIS_NOT_ADVANCED',
  );
  assert.equal(provider.calls.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_versions').get().count, 1);
  db.close();
});

test('old advance decision from another source version cannot unlock current localization', () => {
  const db = createDb({ capability: false, price: false });
  const facts = sourceFacts();
  const nextFacts = {
    ...facts,
    episode_hook: { id: 'hook-2', text: 'new hook' },
  };
  const nextHash = buildLocalizationInput(nextFacts, { locale: 'source' }).source_facts_hash;
  const nextVersionId = Number(db.prepare(`
    INSERT INTO redraw_versions
      (work_id, tenant_id, user_id, version, locale, market, localization_level,
       source_facts_json, facts_hash, status, created_at, updated_at)
    VALUES (1, 'tenant-a', 'user-a', 2, 'source', '', 'faithful', ?, ?, 'asset_review', ?, ?)
  `).run(JSON.stringify(nextFacts), nextHash, new Date().toISOString(), new Date().toISOString()).lastInsertRowid);
  db.prepare('UPDATE redraw_works SET current_version = 2 WHERE id = 1').run();
  setAnalysisDecision(db, {
    action: 'advance',
    effective_mode: 'auto',
    reason_codes: [],
    policy_version: 1,
    evidence_hash: nextHash,
    effective_analysis_state: 'asset_review',
  }, 1);

  const quote = quoteLocalization(db, quoteInput());
  assert.equal(quote.priced, false);
  assert.equal(quote.code, 'REDRAW_LOCALIZATION_ANALYSIS_NOT_ADVANCED');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM async_tasks WHERE type = 'redraw_localization'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE resource_type = 'redraw_localization'").get().count, 0);
  assert.equal(nextVersionId > 1, true);
  db.close();
});

test('quote returns unpriced codes for unavailable capability and price', () => {
  const noCapability = createDb({ capability: false });
  assert.deepEqual(
    quoteLocalization(noCapability, quoteInput()),
    { priced: false, code: 'REDRAW_LOCALIZATION_CAPABILITY_UNVERIFIED' },
  );
  noCapability.close();

  const noPrice = createDb({ price: false });
  const quote = quoteLocalization(noPrice, quoteInput());
  assert.equal(quote.priced, false);
  assert.equal(quote.code, 'pricing_unconfigured');
  noPrice.close();
});

test('starts localization, writes provider task id, materializes draft, completes task, and confirms reservation', async () => {
  const db = createDb();
  const provider = providerReturning(localizedResult());
  const started = await startWithQuote(db, {}, { provider });
  await started.completion;

  const task = taskService.getTask(db, started.task_id);
  assert.equal(task.status, 'completed');
  assert.equal(task.provider_task_id, 'provider-task-1');
  assert.equal(task.credit_reservation_id, started.reservation_id);
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].taskId, started.task_id);
  assert.equal(provider.calls[0].model, 'gpt-localize');
  assert.equal(provider.calls[0].locale, 'en-US');
  assert.equal(provider.calls[0].market, 'US');

  const work = db.prepare('SELECT current_step, current_version, status FROM redraw_works WHERE id = 1').get();
  assert.deepEqual(work, { current_step: 2, current_version: 2, status: 'asset_review' });
  assert.equal(credits.getReservation(db, started.reservation_id).status, 'confirmed');
  const draft = db.prepare('SELECT * FROM redraw_versions WHERE id = ?').get(started.draft_version_id);
  assert.equal(draft.status, 'asset_review');
  assert.equal(draft.localization_task_id, started.task_id);
  assert.equal(draft.localization_credit_reservation_id, started.reservation_id);
  db.close();
});

test('v2 localization auto advances only when all confidence thresholds pass and records safe decision', async () => {
  const db = createDb({
    sourceFacts: v2SourceFacts(),
    automationPolicy: {
      localization_thresholds: {
        names: 0.9,
        dialogue_semantics: 0.9,
        dialogue_timing: 0.9,
        culture: 0.9,
        screen_text: 0.9,
      },
    },
  });
  const started = await startWithQuote(db, { idempotencyKey: 'idem-v2-auto' }, {
    provider: providerReturning(v2LocalizedResult()),
  });
  await started.completion;

  const task = taskService.getTask(db, started.task_id);
  const result = JSON.parse(task.result);
  assert.equal(task.status, 'completed');
  assert.equal(result.localization_decision.action, 'advance');
  assert.equal(result.localization_decision.effective_mode, 'auto');
  assert.equal(result.localization_decision.evidence_hash, v2SourceFacts().facts_hash);
  assert.deepEqual(db.prepare('SELECT current_step, status FROM redraw_works WHERE id = 1').get(), {
    current_step: 2,
    status: 'asset_review',
  });
  const version = db.prepare('SELECT text_map_json FROM redraw_versions WHERE id = ?').get(started.draft_version_id);
  assert.deepEqual(JSON.parse(version.text_map_json), { 'shot-2:screen-1': 'CALL MOM' });
  const shot = db.prepare("SELECT draft_json, compiled_prompt_json FROM redraw_shots WHERE version_id = ? AND shot_id = 'shot-2'")
    .get(started.draft_version_id);
  assert.equal(JSON.parse(shot.draft_json).text_regions[0].target_text, 'CALL MOM');
  assert.equal(JSON.parse(shot.compiled_prompt_json).text_regions[0].target_text, 'CALL MOM');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM async_tasks WHERE type = 'redraw_asset_batch'").get().count, 0);
  assert.deepEqual(db.prepare('SELECT reason_code, to_state FROM redraw_workflow_events').get(), {
    reason_code: 'localization_completed',
    to_state: 'asset_review',
  });
  db.close();
});

test('v2 localization safe or low confidence stops at needs_review without asset generation task', async () => {
  for (const item of [
    {
      name: 'safe',
      db: createDb({
        sourceFacts: v2SourceFacts(),
        executionMode: 'safe',
        automationPolicy: {
          localization_thresholds: {
            names: 0.9,
            dialogue_semantics: 0.9,
            dialogue_timing: 0.9,
            culture: 0.9,
            screen_text: 0.9,
          },
        },
      }),
      result: v2LocalizedResult(),
      reason: 'safe_mode_requires_review',
    },
    {
      name: 'low confidence',
      db: createDb({
        sourceFacts: v2SourceFacts(),
        automationPolicy: {
          localization_thresholds: {
            names: 0.9,
            dialogue_semantics: 0.9,
            dialogue_timing: 0.9,
            culture: 0.9,
            screen_text: 0.9,
          },
        },
      }),
      result: v2LocalizedResult({ confidence: { ...v2LocalizedResult().confidence, screen_text: 0.5 } }),
      reason: 'localization_confidence_below_threshold',
    },
  ]) {
    const started = await startWithQuote(item.db, { idempotencyKey: `idem-v2-${item.name}` }, {
      provider: providerReturning(item.result),
    });
    await started.completion;

    const task = taskService.getTask(item.db, started.task_id);
    const result = JSON.parse(task.result);
    assert.equal(result.localization_decision.action, 'needs_review', item.name);
    assert.equal(result.localization_decision.effective_mode, 'safe', item.name);
    assert.deepEqual(result.localization_decision.reason_codes, [item.reason], item.name);
    assert.deepEqual(item.db.prepare('SELECT current_step, status FROM redraw_works WHERE id = 1').get(), {
      current_step: 1,
      status: 'needs_review',
    }, item.name);
    assert.equal(item.db.prepare('SELECT status FROM redraw_versions WHERE id = ?').get(started.draft_version_id).status, 'needs_review', item.name);
    assert.equal(item.db.prepare("SELECT COUNT(*) AS count FROM async_tasks WHERE type = 'redraw_asset_batch'").get().count, 0, item.name);
    assert.deepEqual(item.db.prepare('SELECT reason_code, to_state FROM redraw_workflow_events ORDER BY id DESC LIMIT 1').get(), {
      reason_code: 'localization_completed',
      to_state: 'needs_review',
    }, item.name);
    item.db.close();
  }
});

test('v2 localization blocks when thresholds are missing or policy and budget drift before auto advance', async () => {
  for (const item of [
    {
      name: 'missing thresholds',
      db: createDb({ sourceFacts: v2SourceFacts(), automationPolicy: {} }),
      mutate: null,
      reason: 'localization_thresholds_missing',
    },
    {
      name: 'policy drift',
      db: createDb({
        sourceFacts: v2SourceFacts(),
        automationPolicy: {
          localization_thresholds: {
            names: 0.9,
            dialogue_semantics: 0.9,
            dialogue_timing: 0.9,
            culture: 0.9,
            screen_text: 0.9,
          },
        },
      }),
      mutate: (db) => db.prepare('UPDATE redraw_projects SET policy_version = 2 WHERE id = 1').run(),
      reason: 'localization_policy_drift',
    },
    {
      name: 'budget drift',
      db: createDb({
        sourceFacts: v2SourceFacts(),
        automationPolicy: {
          localization_thresholds: {
            names: 0.9,
            dialogue_semantics: 0.9,
            dialogue_timing: 0.9,
            culture: 0.9,
            screen_text: 0.9,
          },
        },
      }),
      mutate: (db) => db.prepare('UPDATE redraw_projects SET budget_limit_credits = 5 WHERE id = 1').run(),
      reason: 'localization_budget_drift',
    },
  ]) {
    let mutated = false;
    const provider = providerReturning(v2LocalizedResult());
    const started = await startWithQuote(item.db, { idempotencyKey: `idem-v2-block-${item.name}` }, {
      provider: async (input) => {
        if (item.mutate && !mutated) {
          mutated = true;
          item.mutate(item.db);
        }
        return provider(input);
      },
    });
    await started.completion;

    const task = taskService.getTask(item.db, started.task_id);
    const result = JSON.parse(task.result);
    assert.equal(result.localization_decision.action, 'blocked', item.name);
    assert.equal(result.localization_decision.effective_mode, 'safe', item.name);
    assert.deepEqual(result.localization_decision.reason_codes, [item.reason], item.name);
    assert.deepEqual(item.db.prepare('SELECT current_step, status FROM redraw_works WHERE id = 1').get(), {
      current_step: 1,
      status: 'blocked',
    }, item.name);
    assert.equal(item.db.prepare('SELECT status FROM redraw_versions WHERE id = ?').get(started.draft_version_id).status, 'blocked', item.name);
    assert.equal(item.db.prepare("SELECT COUNT(*) AS count FROM async_tasks WHERE type = 'redraw_asset_batch'").get().count, 0, item.name);
    assert.deepEqual(item.db.prepare('SELECT reason_code, to_state FROM redraw_workflow_events ORDER BY id DESC LIMIT 1').get(), {
      reason_code: 'localization_completed',
      to_state: 'blocked',
    }, item.name);
    item.db.close();
  }
});

test('v2 localization finalize failure rolls back materialization and does not confirm reservation', async () => {
  const db = createDb({
    sourceFacts: v2SourceFacts(),
    automationPolicy: {
      localization_thresholds: {
        names: 0.9,
        dialogue_semantics: 0.9,
        dialogue_timing: 0.9,
        culture: 0.9,
        screen_text: 0.9,
      },
    },
  });
  db.exec(`
    CREATE TRIGGER fail_localization_completed
    BEFORE INSERT ON redraw_workflow_events
    WHEN NEW.reason_code = 'localization_completed'
    BEGIN
      SELECT RAISE(ABORT, 'forced localization finalize failure');
    END;
  `);

  const started = await startWithQuote(db, { idempotencyKey: 'idem-v2-finalize-fail' }, {
    provider: providerReturning(v2LocalizedResult()),
  });
  await assert.rejects(started.completion, /forced localization finalize failure/);

  assert.equal(taskService.getTask(db, started.task_id).status, 'failed');
  assert.equal(credits.getReservation(db, started.reservation_id).status, 'refunded');
  assert.equal(db.prepare('SELECT status FROM redraw_versions WHERE id = ?').get(started.draft_version_id).status, 'draft');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_shots WHERE version_id = ?').get(started.draft_version_id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_assets WHERE version_id = ?').get(started.draft_version_id).count, 0);
  assert.deepEqual(db.prepare('SELECT current_version, current_step, status FROM redraw_works WHERE id = 1').get(), {
    current_version: 1,
    current_step: 1,
    status: 'fact_confirmed',
  });
  db.close();
});

test('default scheduler returns awaitable tracked completion and clears in-flight on success', async () => {
  const db = createDb();
  const quote = quoteLocalization(db, quoteInput());
  const started = startLocalization(db, { info() {}, warn() {}, error() {} }, {
    ...quoteInput(),
    idempotencyKey: 'idem-default-schedule',
    quoteHash: quote.quote_hash,
  }, { provider: providerReturning(localizedResult()) });

  assert.equal(typeof started.completion?.then, 'function');
  assert.equal(taskService.getInFlightTaskCount(), 1);
  await started.completion;
  assert.equal(taskService.getTask(db, started.task_id).status, 'completed');
  assert.equal(taskService.getInFlightTaskCount(), 0);
  db.close();
});

test('default scheduler returns awaitable rejection and clears in-flight on failure', async () => {
  const db = createDb();
  const quote = quoteLocalization(db, quoteInput());
  const provider = async () => {
    const error = new Error('provider rejected');
    error.code = 'PROVIDER_FAILED';
    throw error;
  };
  const started = startLocalization(db, { info() {}, warn() {}, error() {} }, {
    ...quoteInput(),
    idempotencyKey: 'idem-default-failure',
    quoteHash: quote.quote_hash,
  }, { provider });

  assert.equal(typeof started.completion?.then, 'function');
  assert.equal(taskService.getInFlightTaskCount(), 1);
  await assert.rejects(started.completion, (error) => error.code === 'PROVIDER_FAILED');
  assert.equal(taskService.getTask(db, started.task_id).status, 'failed');
  assert.equal(taskService.getInFlightTaskCount(), 0);
  db.close();
});

test('deterministic provider failure fails task, refunds reservation, and keeps hidden draft', async () => {
  const db = createDb();
  const provider = async () => {
    const error = new Error('provider rejected');
    error.code = 'PROVIDER_FAILED';
    throw error;
  };
  const started = await startWithQuote(db, { idempotencyKey: 'idem-fail' }, { provider });
  await assert.rejects(started.completion, (error) => error.code === 'PROVIDER_FAILED');

  assert.equal(taskService.getTask(db, started.task_id).status, 'failed');
  assert.equal(credits.getReservation(db, started.reservation_id).status, 'refunded');
  assert.equal(db.prepare('SELECT current_step FROM redraw_works WHERE id = 1').get().current_step, 1);
  assert.equal(db.prepare('SELECT status FROM redraw_versions WHERE id = ?').get(started.draft_version_id).status, 'draft');
  db.close();
});

test('local normalize or materialize timeout after provider result is deterministic failure and refund', async () => {
  const db = createDb();
  const provider = providerReturning(localizedResult({
    causal_chain: [{ id: 'cause-1', from: 'message', to: 'departure', text: 'LOCAL TIMEOUT while validating' }],
  }));
  const started = await startWithQuote(db, { idempotencyKey: 'idem-local-timeout' }, { provider });
  await assert.rejects(started.completion, (error) => error.code === 'LOCALIZATION_FACT_CONFLICT');
  assert.equal(taskService.getTask(db, started.task_id).status, 'failed');
  assert.equal(credits.getReservation(db, started.reservation_id).status, 'refunded');
  db.close();
});

test('local materialize timeout after structured provider result is failed and refunded', async () => {
  const db = createDb();
  db.exec(`
    CREATE TRIGGER fail_local_materialize_timeout
    BEFORE INSERT ON redraw_assets
    BEGIN
      SELECT RAISE(ABORT, 'LOCAL TIMEOUT while materializing draft');
    END;
  `);
  const provider = providerReturning(localizedResult());
  const started = await startWithQuote(db, { idempotencyKey: 'idem-materialize-timeout' }, { provider });
  await assert.rejects(started.completion, /LOCAL TIMEOUT while materializing draft/);
  assert.equal(taskService.getTask(db, started.task_id).status, 'failed');
  assert.equal(credits.getReservation(db, started.reservation_id).status, 'refunded');
  db.close();
});

test('provider unknown error carrying task id persists provider task and keeps reservation held', async () => {
  const db = createDb();
  const provider = async () => {
    const error = new Error('provider accepted but final status unknown');
    error.code = 'PROVIDER_STATUS_UNKNOWN';
    error.unknown = true;
    error.provider_task_id = 'provider-unknown-42';
    throw error;
  };
  const started = await startWithQuote(db, { idempotencyKey: 'idem-unknown-task-id' }, { provider });
  await assert.rejects(started.completion, (error) => error.code === 'PROVIDER_STATUS_UNKNOWN');
  const task = taskService.getTask(db, started.task_id);
  assert.equal(task.status, 'needs_attention');
  assert.equal(task.provider_task_id, 'provider-unknown-42');
  assert.equal(credits.getReservation(db, started.reservation_id).status, 'held');
  db.close();
});

test('quote hash changes are rejected with the fresh quote and no side effects', () => {
  const db = createDb();
  const oldQuote = quoteLocalization(db, quoteInput());
  modelPrice.set(db, 'gpt-localize', 9, { category: 'text' });
  assert.throws(
    () => startLocalization(db, { info() {}, warn() {}, error() {} }, {
      ...quoteInput(),
      idempotencyKey: 'idem-drift',
      quoteHash: oldQuote.quote_hash,
    }, { provider: providerReturning(localizedResult()), schedule: (job) => job() }),
    (error) => {
      assert.equal(error.code, 'REDRAW_LOCALIZATION_QUOTE_CHANGED');
      assert.equal(error.quote.credits, 9);
      return true;
    },
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM async_tasks WHERE type = 'redraw_localization'").get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 0);
  db.close();
});

test('insufficient balance blocks before draft, task, reservation, and provider call', () => {
  const db = createDb({ balance: 3 });
  const quote = quoteLocalization(db, quoteInput());
  const provider = providerReturning(localizedResult());
  assert.throws(
    () => startLocalization(db, { info() {}, warn() {}, error() {} }, {
      ...quoteInput(),
      idempotencyKey: 'idem-insufficient',
      quoteHash: quote.quote_hash,
    }, { provider, schedule: (job) => job() }),
    (error) => error.code === 'INSUFFICIENT_CREDITS',
  );
  assert.equal(provider.calls.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_versions').get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM async_tasks WHERE type = 'redraw_localization'").get().count, 0);
  db.close();
});

test('same idempotency key replays existing task without another draft, reservation, schedule, or provider call', async () => {
  const db = createDb();
  const provider = providerReturning(localizedResult());
  const first = await startWithQuote(db, { idempotencyKey: 'idem-replay' }, { provider });
  await first.completion;
  let scheduled = 0;
  const second = await startWithQuote(db, { idempotencyKey: 'idem-replay' }, {
    provider,
    schedule: (job) => {
      scheduled += 1;
      return job();
    },
  });

  assert.equal(second.task_id, first.task_id);
  assert.equal(second.reservation_id, first.reservation_id);
  assert.equal(second.draft_version_id, first.draft_version_id);
  assert.equal(second.completion, null);
  assert.equal(provider.calls.length, 1);
  assert.equal(scheduled, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_versions').get().count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 1);
  db.close();
});

test('same idempotency key replays without current capability, price, readable evidence, schedule, or provider call', async () => {
  const db = createDb();
  const provider = providerReturning(localizedResult());
  const first = await startWithQuote(db, { idempotencyKey: 'idem-offline-replay' }, { provider });
  await first.completion;

  db.prepare('DELETE FROM ai_service_configs').run();
  db.prepare('DELETE FROM model_credit_prices').run();
  let scheduled = 0;
  const replay = startLocalization(db, { info() {}, warn() {}, error() {} }, {
    ...quoteInput({ canReadArtifact: () => false }),
    idempotencyKey: 'idem-offline-replay',
    quoteHash: 'stale-client-quote',
  }, {
    provider,
    schedule: (job) => {
      scheduled += 1;
      return job();
    },
  });

  assert.equal(replay.task_id, first.task_id);
  assert.equal(replay.reservation_id, first.reservation_id);
  assert.equal(replay.draft_version_id, first.draft_version_id);
  assert.equal(replay.completion, null);
  assert.equal(provider.calls.length, 1);
  assert.equal(scheduled, 0);
  db.close();
});

test('same idempotency key with changed input is rejected while a new key may start', async () => {
  const db = createDb();
  const provider = providerReturning(localizedResult());
  const first = await startWithQuote(db, { idempotencyKey: 'idem-input' }, { provider });
  await first.completion;

  assert.throws(
    () => startLocalization(db, { info() {}, warn() {}, error() {} }, {
      ...quoteInput({ localizationLevel: 'adapted' }),
      idempotencyKey: 'idem-input',
      quoteHash: quoteLocalization(db, quoteInput({ localizationLevel: 'adapted' })).quote_hash,
    }, { provider, schedule: (job) => job() }),
    (error) => error.code === 'REDRAW_LOCALIZATION_IDEMPOTENCY_CONFLICT',
  );

  const second = await startWithQuote(db, { idempotencyKey: 'idem-input-2', localizationLevel: 'adapted' }, { provider });
  await second.completion;
  assert.notEqual(second.task_id, first.task_id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 2);
  db.close();
});

test('local result validation failure refunds because provider completed with unusable structure', async () => {
  const db = createDb();
  const provider = providerReturning(localizedResult({
    causal_chain: [{ id: 'cause-1', from: 'message', to: 'departure', text: 'changed locked fact' }],
  }));
  const started = await startWithQuote(db, { idempotencyKey: 'idem-invalid' }, { provider });
  await assert.rejects(started.completion, (error) => error.code === 'LOCALIZATION_FACT_CONFLICT');
  assert.equal(taskService.getTask(db, started.task_id).status, 'failed');
  assert.equal(credits.getReservation(db, started.reservation_id).status, 'refunded');
  assert.equal(db.prepare('SELECT current_step FROM redraw_works WHERE id = 1').get().current_step, 1);
  db.close();
});

test('provider dispatch with unknown terminal state marks needs_attention and keeps held reservation', async () => {
  const db = createDb();
  const provider = async () => {
    const error = new Error('provider timeout, final status unknown');
    error.code = 'PROVIDER_TIMEOUT_UNKNOWN';
    error.unknown = true;
    throw error;
  };
  const started = await startWithQuote(db, { idempotencyKey: 'idem-unknown' }, { provider });
  await assert.rejects(started.completion, (error) => error.code === 'PROVIDER_TIMEOUT_UNKNOWN');
  assert.equal(taskService.getTask(db, started.task_id).status, 'needs_attention');
  assert.equal(credits.getReservation(db, started.reservation_id).status, 'held');
  db.close();
});

test('empty provider result is a deterministic failure and refund', async () => {
  const db = createDb();
  const provider = async () => ({ provider_task_id: 'provider-task-empty' });
  const started = await startWithQuote(db, { idempotencyKey: 'idem-empty' }, { provider });
  await assert.rejects(started.completion, (error) => error.code === 'REDRAW_LOCALIZATION_EMPTY_RESULT');
  assert.equal(taskService.getTask(db, started.task_id).status, 'failed');
  assert.equal(credits.getReservation(db, started.reservation_id).status, 'refunded');
  db.close();
});

test('startup cleanup delegates localization reconcile while keeping generic cleanup exclusion', async () => {
  const db = createDb();
  const withProvider = await startWithQuote(db, { idempotencyKey: 'idem-startup-provider' }, {
    provider: async () => ({ provider_task_id: 'provider-startup', result: localizedResult() }),
    schedule: () => null,
  });
  db.prepare("UPDATE async_tasks SET provider_task_id = 'provider-startup', status = 'processing' WHERE id = ?")
    .run(withProvider.task_id);
  const noProvider = await startWithQuote(db, { idempotencyKey: 'idem-startup-none' }, {
    provider: providerReturning(localizedResult()),
    schedule: () => null,
  });
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO async_tasks (id, type, status, progress, message, resource_id, created_at, updated_at)
    VALUES ('task-asset-batch-startup', 'redraw_asset_batch', 'processing', 10, '', '1', ?, ?)
  `).run(now, now);

  assert.equal(taskService.failOrphanedAsyncTasksOnStartup(db, { info() {}, warn() {} }), 0);
  assert.equal(taskService.getTask(db, withProvider.task_id).status, 'needs_attention');
  assert.equal(credits.getReservation(db, withProvider.reservation_id).status, 'held');
  assert.equal(taskService.getTask(db, noProvider.task_id).status, 'failed');
  assert.equal(credits.getReservation(db, noProvider.reservation_id).status, 'refunded');
  assert.equal(taskService.getTask(db, 'task-asset-batch-startup').status, 'processing');
  db.close();
});

test('startup generic orphan cleanup excludes redraw localization and asset batch task types', () => {
  const db = createDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO async_tasks (id, type, status, progress, message, resource_id, created_at, updated_at)
    VALUES ('task-localization', 'redraw_localization', 'processing', 10, '', '1', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO async_tasks (id, type, status, progress, message, resource_id, created_at, updated_at)
    VALUES ('task-asset-batch', 'redraw_asset_batch', 'processing', 10, '', '1', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO async_tasks (id, type, status, progress, message, resource_id, created_at, updated_at)
    VALUES ('task-other', 'background_extraction', 'processing', 10, '', '1', ?, ?)
  `).run(now, now);

  assert.equal(taskService.failOrphanedAsyncTasksOnStartup(db, { info() {}, warn() {} }), 1);
  assert.equal(taskService.getTask(db, 'task-localization').status, 'failed');
  assert.equal(taskService.getTask(db, 'task-asset-batch').status, 'processing');
  assert.equal(taskService.getTask(db, 'task-other').status, 'failed');
  db.close();
});

test('reconcile orphaned localization tasks keeps dispatched provider work held and refunds definitely undispatched work', async () => {
  const db = createDb();
  const withProvider = await startWithQuote(db, { idempotencyKey: 'idem-orphan-provider' }, {
    provider: async () => ({ provider_task_id: 'provider-orphan', result: localizedResult() }),
    schedule: () => null,
  });
  db.prepare("UPDATE async_tasks SET provider_task_id = 'provider-orphan', status = 'processing' WHERE id = ?")
    .run(withProvider.task_id);
  const noProvider = await startWithQuote(db, { idempotencyKey: 'idem-orphan-none' }, {
    provider: providerReturning(localizedResult()),
    schedule: () => null,
  });

  const result = reconcileOrphanedTasks(db, { info() {}, warn() {} });
  assert.deepEqual(result, { needs_attention: 1, failed: 1 });
  assert.equal(taskService.getTask(db, withProvider.task_id).status, 'needs_attention');
  assert.equal(credits.getReservation(db, withProvider.reservation_id).status, 'held');
  assert.equal(taskService.getTask(db, noProvider.task_id).status, 'failed');
  assert.equal(credits.getReservation(db, noProvider.reservation_id).status, 'refunded');
  db.close();
});
