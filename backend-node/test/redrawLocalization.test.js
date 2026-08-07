const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  buildLocalizationInput,
  normalizeLocalizationResult,
  validateLocalizedFacts,
  createLocalizationDraft,
  materializeLocalizationDraft,
  createLocalizationVersion,
  validateLocalizedDialogue,
} = require('../src/services/localizationService');

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

function localizedFacts(overrides = {}) {
  return {
    ...sourceFacts(),
    ...overrides,
    name_map: { 小满: 'Maya', 阿岚: 'Aran' },
    culture_map: { currency: 'USD' },
    glossary: { 旧手机: 'old phone' },
  };
}

function createDb(options = {}) {
  const db = new Database(':memory:', options);
  db.exec(`
    CREATE TABLE redraw_works (
      id INTEGER PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      current_version INTEGER NOT NULL DEFAULT 0,
      current_step INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'fact_confirmed',
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
      style_snapshot_json TEXT NOT NULL DEFAULT '{}',
      capability_snapshot_json TEXT NOT NULL DEFAULT '{}',
      localization_input_hash TEXT,
      localization_idempotency_key TEXT,
      localization_model_snapshot_json TEXT NOT NULL DEFAULT '{}',
      facts_hash TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
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
      asset_id INTEGER,
      voice_asset_id INTEGER,
      clean_plate_asset_id INTEGER,
      mask_asset_id INTEGER,
      generation_task_id TEXT,
      version_number INTEGER NOT NULL DEFAULT 1,
      approval_status TEXT NOT NULL DEFAULT 'pending',
      approved_by TEXT,
      approved_at TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      error_code TEXT,
      error_message TEXT,
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
      video_generation_id INTEGER,
      audio_asset_id INTEGER,
      subtitle_asset_id INTEGER,
      status TEXT NOT NULL DEFAULT 'draft',
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE UNIQUE INDEX uq_redraw_shot_order ON redraw_shots(version_id, batch_index, shot_index);
  `);
  const now = new Date().toISOString();
  const facts = sourceFacts();
  const sourceFactsHash = buildLocalizationInput(facts, { locale: 'source' }).source_facts_hash;
  db.prepare('INSERT INTO redraw_works (id, tenant_id, user_id, current_version, current_step, status, updated_at) VALUES (1, ?, ?, 1, 1, ?, ?)')
    .run('tenant-a', 'user-a', 'fact_confirmed', now);
  const sourceVersionId = Number(db.prepare(`
    INSERT INTO redraw_versions
      (work_id, tenant_id, user_id, version, locale, market, localization_level,
       source_facts_json, facts_hash, status, created_at, updated_at)
    VALUES (1, 'tenant-a', 'user-a', 1, 'source', '', 'faithful', ?, ?, 'asset_review', ?, ?)
  `).run(JSON.stringify(facts), sourceFactsHash, now, now).lastInsertRowid);
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
  return db;
}

function localizationPayload(overrides = {}) {
  const facts = sourceFacts();
  return {
    locale: 'en-US',
    market: 'US',
    sourceFacts: facts,
    sourceFactsHash: buildLocalizationInput(facts, { locale: 'en-US' }).source_facts_hash,
    nameMap: { 小满: 'Maya' },
    cultureMap: { currency: 'USD' },
    glossary: { 旧手机: 'old phone' },
    styleSnapshot: { stable_key: 'style-1', version: 1 },
    dialogue: [{
      shot_id: 'shot-1',
      turns: [{ speaker_id: 'c1', localized_text: "Don't look back" }],
    }],
    ...overrides,
  };
}

test('本地化不得改变人物关系、因果、反转和钩子', () => {
  const changed = localizedFacts({
    causal_chain: [{ id: 'cause-1', from: 'message', to: 'departure', text: '阿岚促使小满离开' }],
  });
  const result = validateLocalizedFacts(sourceFacts(), changed);
  assert.equal(result.ok, false);
  assert.equal(result.conflicts[0].path, 'causal_chain[0]');
  assert.equal(result.conflicts[0].source_value.text, '消息促使小满离开');
  assert.equal(result.conflicts[0].localized_value.text, '阿岚促使小满离开');
});

test('允许地区化姓名、货币和机构但保留锁定事实', () => {
  const result = validateLocalizedFacts(sourceFacts(), localizedFacts());
  assert.equal(result.ok, true);
  assert.equal(result.value.name_map['小满'], 'Maya');
});

test('本地化输入和结果保留事实哈希、地区和风格快照', () => {
  const input = buildLocalizationInput(sourceFacts(), {
    locale: 'en-US',
    market: 'US',
    styleSnapshot: { stable_key: 'redraw-live-action-style-001', version: 1 },
  });
  assert.equal(input.locale, 'en-US');
  assert.equal(input.market, 'US');
  assert.equal(input.style_snapshot.stable_key, 'redraw-live-action-style-001');
  assert.equal(input.source_facts.schema_version, '1.0');
  assert.match(input.source_facts_hash, /^[a-f0-9]{64}$/);

  const normalized = normalizeLocalizationResult({
    ...localizedFacts(),
    facts_hash: input.source_facts_hash,
    dialogue: [],
  }, sourceFacts());
  assert.equal(normalized.facts_hash, input.source_facts_hash);
  assert.deepEqual(normalized.name_map, { 小满: 'Maya', 阿岚: 'Aran' });
  assert.deepEqual(normalized.dialogue, []);
});

test('本地化结果事实哈希不匹配时拒绝写入', () => {
  assert.throws(
    () => normalizeLocalizationResult({ ...localizedFacts(), facts_hash: 'stale-hash' }, sourceFacts()),
    (error) => error.code === 'LOCALIZATION_FACT_HASH_MISMATCH',
  );
});

test('创建本地化版本原子物化目标分镜与同版本资产引用且不改写源事实', () => {
  const db = createDb();
  const facts = sourceFacts();
  const result = createLocalizationVersion(db, { tenantId: 'tenant-a', userId: 'user-a' }, 1, localizationPayload());
  assert.equal(result.version, 2);
  assert.equal(db.prepare('SELECT current_version FROM redraw_works WHERE id = 1').get().current_version, 2);
  const row = db.prepare('SELECT * FROM redraw_versions WHERE id = ?').get(result.id);
  assert.equal(row.source_facts_json, JSON.stringify(facts));
  assert.deepEqual(JSON.parse(row.name_map_json), { 小满: 'Maya' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_versions').get().count, 2);

  const assets = db.prepare('SELECT * FROM redraw_assets WHERE version_id = ? ORDER BY id').all(result.id);
  assert.equal(assets.length, 6);
  assert.deepEqual(assets.map((asset) => asset.kind), ['character', 'voice', 'character', 'voice', 'scene', 'prop']);
  assert.equal(assets.every((asset) => asset.status === 'draft' && asset.approval_status === 'pending'), true);
  assert.deepEqual(JSON.parse(assets[0].source_ref_json).source_ref, {
    kind: 'character',
    id: 'c1',
    stable_id: 'c1',
  });
  assert.equal(assets[0].localized_name, 'Maya');
  assert.equal(assets[5].localized_name, 'old phone');

  const targetShots = db.prepare('SELECT * FROM redraw_shots WHERE version_id = ? ORDER BY shot_index').all(result.id);
  assert.equal(targetShots.length, 2);
  assert.equal(targetShots[0].source_dialogue_json, JSON.stringify(facts.shots[0].dialogue));
  assert.deepEqual(JSON.parse(targetShots[0].localized_dialogue_json), [
    { speaker_id: 'c1', localized_text: "Don't look back" },
  ]);
  assert.equal(targetShots[0].opening_state, facts.shots[0].opening_state);
  assert.equal(targetShots[0].continuous_action, facts.shots[0].continuous_action);
  assert.equal(targetShots[0].ending_state, facts.shots[0].ending_state);

  const assetByStableId = new Map(assets.map((asset) => {
    const sourceRef = JSON.parse(asset.source_ref_json).source_ref;
    return [`${sourceRef.kind}:${sourceRef.stable_id}`, asset];
  }));
  const firstReferences = JSON.parse(targetShots[0].references_json);
  assert.deepEqual(firstReferences.map((reference) => reference.kind), ['character', 'voice', 'scene', 'prop']);
  assert.equal(firstReferences.every((reference) => Number.isInteger(reference.asset_id)), true);
  assert.deepEqual(firstReferences.map((reference) => reference.asset_id), [
    assetByStableId.get('character:c1').id,
    assetByStableId.get('voice:c1').id,
    assetByStableId.get('scene:s1').id,
    assetByStableId.get('prop:p1').id,
  ]);
  assert.deepEqual(JSON.parse(targetShots[1].references_json), [{
    kind: 'scene',
    asset_id: assetByStableId.get('scene:s1').id,
    anchor: 'scene:s1',
  }]);
  assert.equal(firstReferences.some((reference) => reference.asset_id === assetByStableId.get('character:c2').id), false);

  const sourceShots = db.prepare('SELECT * FROM redraw_shots WHERE version_id != ? ORDER BY shot_index').all(result.id);
  assert.equal(sourceShots[0].localized_dialogue_json, '[]');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_assets WHERE version_id != ?').get(result.id).count, 0);
  db.close();
});

test('第二次确认只创建隐藏草稿且不推进作品步骤', () => {
  const db = createDb();
  const draft = createLocalizationDraft(db, { tenantId: 'tenant-a', userId: 'user-a' }, 1, {
    locale: 'en-US',
    market: 'US',
    localizationLevel: 'faithful',
    inputHash: 'a'.repeat(64),
    idempotencyKey: 'confirm-en-us-1',
    modelSnapshot: { provider: 'provider-a', model: 'model-a' },
  });
  assert.equal(draft.status, 'draft');
  assert.equal(db.prepare('SELECT current_version FROM redraw_works WHERE id = 1').get().current_version, 1);
  assert.equal(db.prepare('SELECT current_step FROM redraw_works WHERE id = 1').get().current_step, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_shots WHERE version_id = ?').get(draft.id).count, 0);

  const retried = createLocalizationDraft(db, { tenantId: 'tenant-a', userId: 'user-a' }, 1, {
    locale: 'en-US',
    market: 'US',
    localizationLevel: 'faithful',
    inputHash: 'a'.repeat(64),
    idempotencyKey: 'confirm-en-us-1',
    modelSnapshot: { provider: 'provider-a', model: 'model-a' },
  });
  assert.equal(retried.id, draft.id);
  db.close();
});

test('创建本地化草稿使用 immediate 事务并为不同幂等键分配不同版本', () => {
  const sqlTrace = [];
  const db = createDb({ verbose: (sql) => sqlTrace.push(sql) });
  const first = createLocalizationDraft(db, { tenantId: 'tenant-a', userId: 'user-a' }, 1, {
    locale: 'en-US',
    market: 'US',
    localizationLevel: 'faithful',
    inputHash: 'd'.repeat(64),
    idempotencyKey: 'confirm-en-us-4',
    modelSnapshot: { provider: 'provider-a', model: 'model-a' },
  });
  const second = createLocalizationDraft(db, { tenantId: 'tenant-a', userId: 'user-a' }, 1, {
    locale: 'en-US',
    market: 'US',
    localizationLevel: 'faithful',
    inputHash: 'e'.repeat(64),
    idempotencyKey: 'confirm-en-us-5',
    modelSnapshot: { provider: 'provider-a', model: 'model-a' },
  });
  assert.equal(sqlTrace.some((sql) => /^BEGIN IMMEDIATE\b/i.test(sql)), true);
  assert.deepEqual([first.version, second.version], [2, 3]);
  db.close();
});

test('物化草稿在全部分镜、四类资产和引用写入成功后推进作品', () => {
  const db = createDb();
  const draft = createLocalizationDraft(db, { tenantId: 'tenant-a', userId: 'user-a' }, 1, {
    locale: 'en-US',
    market: 'US',
    localizationLevel: 'faithful',
    inputHash: 'b'.repeat(64),
    idempotencyKey: 'confirm-en-us-2',
    modelSnapshot: { provider: 'provider-a', model: 'model-a' },
  });
  const result = materializeLocalizationDraft(db, { tenantId: 'tenant-a', userId: 'user-a' }, draft.id, {
    ...localizationPayload(),
    workId: 1,
  });

  assert.equal(result.id, draft.id);
  assert.equal(result.version, 2);
  const work = db.prepare('SELECT current_version, current_step, status FROM redraw_works WHERE id = 1').get();
  assert.deepEqual(work, { current_version: 2, current_step: 2, status: 'asset_review' });
  assert.equal(db.prepare('SELECT status FROM redraw_versions WHERE id = ?').get(draft.id).status, 'asset_review');
  assert.deepEqual(
    db.prepare('SELECT kind, COUNT(*) AS count FROM redraw_assets WHERE version_id = ? GROUP BY kind ORDER BY kind').all(draft.id),
    [
      { kind: 'character', count: 2 },
      { kind: 'prop', count: 1 },
      { kind: 'scene', count: 1 },
      { kind: 'voice', count: 2 },
    ],
  );
  const firstShot = db.prepare('SELECT references_json FROM redraw_shots WHERE version_id = ? AND shot_index = 1').get(draft.id);
  assert.deepEqual(JSON.parse(firstShot.references_json).map((reference) => reference.kind), ['character', 'voice', 'scene', 'prop']);
  db.close();
});

test('物化草稿失败时回滚且草稿保持隐藏', () => {
  const db = createDb();
  const draft = createLocalizationDraft(db, { tenantId: 'tenant-a', userId: 'user-a' }, 1, {
    locale: 'en-US',
    market: 'US',
    localizationLevel: 'faithful',
    inputHash: 'c'.repeat(64),
    idempotencyKey: 'confirm-en-us-3',
    modelSnapshot: { provider: 'provider-a', model: 'model-a' },
  });
  db.exec(`
    CREATE TRIGGER fail_localized_shot
    BEFORE INSERT ON redraw_shots
    WHEN NEW.version_id = ${draft.id}
    BEGIN
      SELECT RAISE(ABORT, 'forced shot failure');
    END;
  `);

  assert.throws(
    () => materializeLocalizationDraft(db, { tenantId: 'tenant-a', userId: 'user-a' }, draft.id, {
      ...localizationPayload(),
      workId: 1,
    }),
    /forced shot failure/,
  );
  assert.equal(db.prepare('SELECT status FROM redraw_versions WHERE id = ?').get(draft.id).status, 'draft');
  assert.equal(db.prepare('SELECT current_version FROM redraw_works WHERE id = 1').get().current_version, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_shots WHERE version_id = ?').get(draft.id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_assets WHERE version_id = ?').get(draft.id).count, 0);
  db.close();
});

test('兼容物化固定 Date.now 时连续两次仍创建不同版本', () => {
  const db = createDb();
  const originalNow = Date.now;
  Date.now = () => 1234567890;
  try {
    const first = createLocalizationVersion(db, { tenantId: 'tenant-a', userId: 'user-a' }, 1, localizationPayload());
    const second = createLocalizationVersion(db, { tenantId: 'tenant-a', userId: 'user-a' }, 1, localizationPayload());
    assert.deepEqual([first.version, second.version], [2, 3]);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_versions WHERE work_id = 1').get().count, 3);
  } finally {
    Date.now = originalNow;
    db.close();
  }
});

test('物化任一步失败时回滚版本、分镜、资产并保持当前版本指针', () => {
  const db = createDb();
  const facts = sourceFacts();
  db.exec(`
    CREATE TRIGGER fail_localized_prop
    BEFORE INSERT ON redraw_assets
    WHEN NEW.kind = 'prop'
    BEGIN
      SELECT RAISE(ABORT, 'forced asset failure');
    END;
  `);

  assert.throws(
    () => createLocalizationVersion(db, { tenantId: 'tenant-a', userId: 'user-a' }, 1, {
      locale: 'en-US',
      sourceFacts: facts,
      sourceFactsHash: buildLocalizationInput(facts, { locale: 'en-US' }).source_facts_hash,
    }),
    /forced asset failure/,
  );
  assert.equal(db.prepare('SELECT current_version FROM redraw_works WHERE id = 1').get().current_version, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_versions').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_shots').get().count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_assets').get().count, 0);
  db.close();
});

test('创建本地化版本拒绝与源事实不匹配的哈希', () => {
  const db = createDb();
  assert.throws(
    () => createLocalizationVersion(db, { tenantId: 'tenant-a', userId: 'user-a' }, 1, {
      locale: 'en-US',
      sourceFacts: sourceFacts(),
      sourceFactsHash: 'stale-hash',
    }),
    (error) => error.code === 'LOCALIZATION_FACT_HASH_MISMATCH',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_versions').get().count, 1);
  assert.equal(db.prepare('SELECT current_version FROM redraw_works WHERE id = 1').get().current_version, 1);
  db.close();
});

function sourceDialogue() {
  return {
    turns: [
      { speaker_id: 'c1', source_text: '别回头', start_ms: 0, end_ms: 2_000, emotion: 'urgent', overlap_group: null },
      { speaker_id: 'c2', source_text: '我知道', start_ms: 2_000, end_ms: 4_000, emotion: 'calm', overlap_group: null },
      { speaker_id: 'c1', source_text: '快走', start_ms: 4_000, end_ms: 6_000, emotion: 'urgent', overlap_group: 'overlap-1' },
    ],
  };
}

test('台词保留说话顺序并在可说时长内', () => {
  const check = validateLocalizedDialogue(sourceDialogue(), {
    turns: [
      { speaker_id: 'c1', localized_text: "Don't look back", start_ms: 0, end_ms: 2_000, emotion: 'urgent', overlap_group: null },
      { speaker_id: 'c2', localized_text: 'I know', start_ms: 2_000, end_ms: 4_000, emotion: 'calm', overlap_group: null },
      { speaker_id: 'c1', localized_text: 'Go now', start_ms: 4_000, end_ms: 6_000, emotion: 'urgent', overlap_group: 'overlap-1' },
    ],
  }, { locale: 'es-419', maxSpeechRate: 1.12 });
  assert.equal(check.ok, true);
  assert.equal(check.turns.map((turn) => turn.speaker_id).join(','), 'c1,c2,c1');
  assert.equal(check.turns[2].overlap_group, 'overlap-1');
});

test('超速台词退回改写而不是改变视频速度', () => {
  const check = validateLocalizedDialogue(sourceDialogue(), {
    turns: [
      { speaker_id: 'c1', localized_text: 'This line is much too long to fit inside the available shot duration', start_ms: 0, end_ms: 2_000, emotion: 'urgent', overlap_group: null },
      { speaker_id: 'c2', localized_text: 'I know', start_ms: 2_000, end_ms: 4_000, emotion: 'calm', overlap_group: null },
      { speaker_id: 'c1', localized_text: 'Go now', start_ms: 4_000, end_ms: 6_000, emotion: 'urgent', overlap_group: 'overlap-1' },
    ],
  }, { locale: 'en-US', maxSpeechRate: 1.12 });
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'dialogue_duration_exceeded');
  assert.equal(check.status, 'needs_rewrite');
});

test('阿拉伯语台词保留重叠组并标记 RTL', () => {
  const check = validateLocalizedDialogue(sourceDialogue(), {
    turns: [
      { speaker_id: 'c1', localized_text: 'لا تلتفت', start_ms: 0, end_ms: 2_000, emotion: 'urgent', overlap_group: null },
      { speaker_id: 'c2', localized_text: 'أعرف', start_ms: 2_000, end_ms: 4_000, emotion: 'calm', overlap_group: null },
      { speaker_id: 'c1', localized_text: 'اذهب الآن', start_ms: 4_000, end_ms: 6_000, emotion: 'urgent', overlap_group: 'overlap-1' },
    ],
  }, { locale: 'ar', maxSpeechRate: 1.12 });
  assert.equal(check.ok, true);
  assert.equal(check.direction, 'rtl');
  assert.equal(check.turns[2].overlap_group, 'overlap-1');
});

test('台词情绪改变时退回语义复核', () => {
  const turns = sourceDialogue().turns.map((turn) => ({
    speaker_id: turn.speaker_id,
    localized_text: turn.source_text,
    start_ms: turn.start_ms,
    end_ms: turn.end_ms,
    emotion: turn.emotion,
    overlap_group: turn.overlap_group,
  }));
  turns[0].emotion = 'calm';
  const check = validateLocalizedDialogue(sourceDialogue(), { turns }, { locale: 'en-US' });
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'dialogue_emotion_mismatch');
});
