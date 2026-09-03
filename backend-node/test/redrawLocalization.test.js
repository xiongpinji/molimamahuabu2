const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  buildLocalizationInput,
  episodeLocalizationHash,
  normalizeLocalizationResult,
  normalizeLocalizationResultV2,
  getLocalizationReview,
  lockLocalizationReview,
  saveGeneratedLocalizationReview,
  saveLocalizationReview,
  validateLocalizedFacts,
  createLocalizationDraft,
  materializeLocalizationDraft,
  createLocalizationVersion,
  validateLocalizedDialogue,
} = require('../src/services/localizationService');
const { evaluateGenerationGate } = require('../src/services/redrawReviewService');

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

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
        dialogue: [{
          speaker_id: 'c1',
          text: '别回头',
          start_ms: 500,
          end_ms: 2_500,
          emotion: 'urgent',
          overlap_group: null,
        }],
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

function v2SourceFacts(overrides = {}) {
  const facts = {
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
          overlap_group: 'og-1',
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
    ...overrides,
  };
  return facts;
}

function v2LocalizationResult(overrides = {}) {
  const source = v2SourceFacts();
  return {
    facts_hash: source.facts_hash,
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

function episodeBlueprintFacts() {
  return {
    schema_version: 'episode-blueprint-v1',
    blueprint_hash: 'b'.repeat(64),
    characters: [
      { id: 'character-lead', source_name: '小满' },
      { id: 'offscreen-dispatcher', source_name: '调度员' },
    ],
    shots: [{
      id: 'shot-1',
      dialogue: [
        {
          id: 'dialogue-1',
          speaker_id: 'character-lead',
          speaker_kind: 'character',
          source_text: '调度员，我回来了。',
          start_ms: 500,
          end_ms: 3_500,
          emotion: 'relieved',
        },
        {
          id: 'dialogue-2',
          speaker_id: 'offscreen-dispatcher',
          speaker_kind: 'off_screen',
          source_text: '先把订单送完。',
          start_ms: 3_600,
          end_ms: 6_000,
          emotion: 'firm',
        },
      ],
      text_regions: [{ id: 'text-1', source_text: '尾号八七' }],
    }],
  };
}

function episodeLocalizationProviderResult(overrides = {}) {
  return {
    blueprint_hash: 'b'.repeat(64),
    locale: 'en-US',
    market: 'US',
    name_map: {
      'character-lead': 'Mateo',
      'offscreen-dispatcher': 'Avery',
    },
    dialogue: [{
      shot_id: 'shot-1',
      turns: [
        { id: 'dialogue-1', speaker_id: 'character-lead', target_text: 'Avery, I am back.' },
        { id: 'dialogue-2', speaker_id: 'offscreen-dispatcher', target_text: 'Finish the delivery first.' },
      ],
    }],
    text_map: { 'shot-1:text-1': 'ORDER 87' },
    culture_map: [{ id: 'culture-1', source: '订单', target: 'delivery order', note: 'US courier wording' }],
    glossary: [{ source_term: '订单', target_term: 'delivery order', note: 'Keep consistent' }],
    locked_terms: ['ORDER 87'],
    ...overrides,
  };
}

function createEpisodeReviewDb() {
  const db = createDb();
  db.exec(`
    ALTER TABLE redraw_versions ADD COLUMN blueprint_hash TEXT;
    ALTER TABLE redraw_versions ADD COLUMN localization_hash TEXT;
    ALTER TABLE redraw_versions ADD COLUMN localization_review_json TEXT;
    CREATE TABLE redraw_episode_blueprints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      blueprint_json TEXT NOT NULL,
      blueprint_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.prepare('DELETE FROM redraw_shots').run();
  db.prepare('DELETE FROM redraw_versions').run();
  const blueprint = episodeBlueprintFacts();
  const now = '2026-09-03T00:00:00.000Z';
  const versionId = Number(db.prepare(`
    INSERT INTO redraw_versions
      (work_id, tenant_id, user_id, version, locale, market, localization_level,
       source_facts_json, facts_hash, blueprint_hash, status, created_at, updated_at)
    VALUES (1, 'tenant-a', 'user-a', 1, 'source', '', 'faithful', ?, ?, ?, 'needs_review', ?, ?)
  `).run(JSON.stringify({ schema_version: '2.0', facts_hash: 'a'.repeat(64) }), 'a'.repeat(64),
    blueprint.blueprint_hash, now, now).lastInsertRowid);
  db.prepare(`
    INSERT INTO redraw_episode_blueprints
      (work_id, tenant_id, user_id, revision, status, blueprint_json, blueprint_hash, updated_at)
    VALUES (1, 'tenant-a', 'user-a', 1, 'locked', ?, ?, ?)
  `).run(JSON.stringify(blueprint), blueprint.blueprint_hash, now);
  db.prepare("UPDATE redraw_works SET current_version = 1, current_step = 1, status = 'needs_review', updated_at = ? WHERE id = 1")
    .run(now);
  return { db, versionId, blueprint, now };
}

function acceptsEnglishTarget({ text, locale }) {
  return locale === 'en-US' && !/[\u3400-\u9fff]/u.test(text);
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
      text_map_json TEXT NOT NULL DEFAULT '{}',
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

function createV2Db() {
  const db = createDb();
  db.exec('ALTER TABLE redraw_shots ADD COLUMN draft_json TEXT NOT NULL DEFAULT \'{}\'');
  if (!hasColumn(db, 'redraw_versions', 'reference_bundle_required')) {
    db.exec('ALTER TABLE redraw_versions ADD COLUMN reference_bundle_required INTEGER NOT NULL DEFAULT 0');
  }
  db.prepare('DELETE FROM redraw_shots').run();
  db.prepare('DELETE FROM redraw_versions').run();
  db.prepare('UPDATE redraw_works SET current_version = 1, current_step = 1, status = ? WHERE id = 1')
    .run('fact_confirmed');
  const now = new Date().toISOString();
  const facts = v2SourceFacts();
  const sourceVersionId = Number(db.prepare(`
    INSERT INTO redraw_versions
      (work_id, tenant_id, user_id, version, locale, market, localization_level,
       source_facts_json, facts_hash, status, created_at, updated_at)
    VALUES (1, 'tenant-a', 'user-a', 1, 'source', '', 'faithful', ?, ?, 'asset_review', ?, ?)
  `).run(JSON.stringify(facts), facts.facts_hash, now, now).lastInsertRowid);
  const insertShot = db.prepare(`
    INSERT INTO redraw_shots
      (work_id, shot_id, version_id, tenant_id, user_id, batch_index, shot_index,
       start_ms, end_ms, duration_ms, source_dialogue_json, localized_dialogue_json,
       references_json, opening_state, continuous_action, ending_state, compiled_prompt_json,
       draft_json, created_at, updated_at)
    VALUES (1, ?, ?, 'tenant-a', 'user-a', 1, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?, '{}', '{}', ?, ?)
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

test('v2 本地化只改姓名文字对白并保留镜头事实', () => {
  const source = v2SourceFacts({ locale: undefined, market: undefined });
  const result = normalizeLocalizationResult(v2LocalizationResult(), source, { locale: 'en-US', market: 'US' });
  assert.deepEqual(Object.keys(result), [
    'facts_hash',
    'locale',
    'market',
    'name_map',
    'culture_map',
    'glossary',
    'dialogue',
    'text_map',
    'confidence',
  ]);
  assert.equal(result.facts_hash, source.facts_hash);
  assert.equal(result.locale, 'en-US');
  assert.equal(result.market, 'US');
  assert.equal(result.name_map.c1, 'Mateo');
  assert.equal(result.dialogue[0].turns[0].id, 'turn-1');
  assert.equal(result.dialogue[0].turns[0].speaker_id, 'c1');
  assert.equal(result.dialogue[0].turns[0].start_ms, source.shots[0].dialogue[0].start_ms);
  assert.equal(result.dialogue[0].turns[0].end_ms, source.shots[0].dialogue[0].end_ms);
  assert.equal(result.dialogue[0].turns[0].overlap_group, 'og-1');
  assert.deepEqual(result.dialogue[1].turns, []);
  assert.deepEqual(result.text_map, { 'shot-2:screen-1': 'CALL MOM' });
});

test('episode 本地化绑定锁定蓝图并规范化全剧姓名、对白和 OCR 哈希', () => {
  const blueprint = episodeBlueprintFacts();
  const localized = normalizeLocalizationResultV2(
    episodeLocalizationProviderResult(),
    blueprint,
    {
      locale: 'en-US',
      market: 'US',
      blueprintHash: blueprint.blueprint_hash,
      validateTargetText: acceptsEnglishTarget,
    },
  );

  assert.deepEqual(Object.keys(localized), [
    'schema_version',
    'blueprint_hash',
    'locale',
    'market',
    'character_name_map',
    'dialogue_map',
    'text_region_map',
    'cultural_adaptations',
    'glossary',
    'locked_terms',
    'review',
    'localization_hash',
  ]);
  assert.equal(localized.schema_version, 'episode-localization-v1');
  assert.equal(localized.blueprint_hash, blueprint.blueprint_hash);
  assert.deepEqual(localized.character_name_map, {
    'character-lead': 'Mateo',
    'offscreen-dispatcher': 'Avery',
  });
  assert.deepEqual(localized.dialogue_map.map((turn) => turn.source_dialogue_id), ['dialogue-1', 'dialogue-2']);
  assert.equal(localized.dialogue_map[0].source_text, '调度员，我回来了。');
  assert.equal(localized.dialogue_map[0].speaker_id, 'character-lead');
  assert.equal(localized.dialogue_map[0].emotion, 'relieved');
  assert.equal(localized.text_region_map[0].source_text, '尾号八七');
  assert.equal(localized.review.status, 'review');
  assert.equal(Object.values(localized.review.character_name_map).every((value) => value === false), true);
  assert.match(localized.localization_hash, /^[a-f0-9]{64}$/);

  const repeated = normalizeLocalizationResultV2(
    episodeLocalizationProviderResult(),
    blueprint,
    {
      locale: 'en-US', market: 'US', blueprintHash: blueprint.blueprint_hash,
      validateTargetText: acceptsEnglishTarget,
    },
  );
  repeated.review.reviewed_at = '2099-01-01T00:00:00.000Z';
  assert.equal(repeated.localization_hash, localized.localization_hash);
});

test('episode 本地化哈希绑定全部稳定审核状态且仅忽略明确审核时间字段', () => {
  const blueprint = episodeBlueprintFacts();
  const localized = normalizeLocalizationResultV2(
    episodeLocalizationProviderResult(), blueprint,
    {
      locale: 'en-US', market: 'US', blueprintHash: blueprint.blueprint_hash,
      validateTargetText: acceptsEnglishTarget,
    },
  );
  const baseHash = episodeLocalizationHash(localized);
  for (const mapName of [
    'character_name_map', 'dialogue_map', 'text_region_map',
    'cultural_adaptations', 'glossary', 'locked_terms',
  ]) {
    const changed = structuredClone(localized);
    const firstKey = Object.keys(changed.review[mapName])[0];
    changed.review[mapName][firstKey] = true;
    assert.notEqual(episodeLocalizationHash(changed), baseHash, mapName);
  }

  const locked = structuredClone(localized);
  locked.review.status = 'locked';
  assert.notEqual(episodeLocalizationHash(locked), baseHash);

  const auditTimes = structuredClone(localized);
  auditTimes.review.updated_at = '2026-09-03T00:00:01.000Z';
  auditTimes.review.reviewed_at = '2026-09-03T00:00:02.000Z';
  assert.equal(episodeLocalizationHash(auditTimes), baseHash);

  const stableReviewer = structuredClone(localized);
  stableReviewer.review.reviewed_by = 'reviewer-a';
  assert.notEqual(episodeLocalizationHash(stableReviewer), baseHash);
});

test('episode 本地化严格拒绝蓝图漂移、不完整映射、源姓名残留与目标语言失败', () => {
  const blueprint = episodeBlueprintFacts();
  const options = {
    locale: 'en-US',
    market: 'US',
    blueprintHash: blueprint.blueprint_hash,
    validateTargetText: acceptsEnglishTarget,
  };
  const cases = [
    ['blueprint option drift', episodeLocalizationProviderResult(), { ...options, blueprintHash: 'c'.repeat(64) }, 'BLUEPRINT_HASH_MISMATCH'],
    ['provider blueprint drift', episodeLocalizationProviderResult({ blueprint_hash: 'c'.repeat(64) }), options, 'BLUEPRINT_HASH_MISMATCH'],
    ['missing offscreen name', episodeLocalizationProviderResult({ name_map: { 'character-lead': 'Mateo' } }), options, 'LOCALIZATION_NAME_MAP_MISMATCH'],
    ['duplicate localized name', episodeLocalizationProviderResult({ name_map: { 'character-lead': 'Mateo', 'offscreen-dispatcher': ' mateo ' } }), options, 'LOCALIZATION_NAME_DUPLICATE'],
    ['source name reused', episodeLocalizationProviderResult({ name_map: { 'character-lead': '小满', 'offscreen-dispatcher': 'Avery' } }), options, 'LOCALIZATION_SOURCE_TEXT_REMAINS'],
    ['missing dialogue', episodeLocalizationProviderResult({ dialogue: [{ shot_id: 'shot-1', turns: [{ id: 'dialogue-1', target_text: 'I am back.' }] }] }), options, 'LOCALIZATION_DIALOGUE_INVALID'],
    ['speaker drift', episodeLocalizationProviderResult({ dialogue: [{ shot_id: 'shot-1', turns: [{ id: 'dialogue-1', speaker_id: 'offscreen-dispatcher', target_text: 'I am back.' }, { id: 'dialogue-2', speaker_id: 'offscreen-dispatcher', target_text: 'Finish it.' }] }] }), options, 'LOCALIZATION_DIALOGUE_INVALID'],
    ['source name remains in dialogue', episodeLocalizationProviderResult({ dialogue: [{ shot_id: 'shot-1', turns: [{ id: 'dialogue-1', target_text: '小满 is back.' }, { id: 'dialogue-2', target_text: 'Finish it.' }] }] }), options, 'LOCALIZATION_SOURCE_TEXT_REMAINS'],
    ['wrong target language', episodeLocalizationProviderResult({ dialogue: [{ shot_id: 'shot-1', turns: [{ id: 'dialogue-1', target_text: '我回来了。' }, { id: 'dialogue-2', target_text: 'Finish it.' }] }] }), options, 'LOCALIZATION_TARGET_LANGUAGE_MISMATCH'],
    ['missing OCR region', episodeLocalizationProviderResult({ text_map: {} }), options, 'LOCALIZATION_TEXT_REGION_MISMATCH'],
  ];

  for (const [name, result, caseOptions, code] of cases) {
    assert.throws(
      () => normalizeLocalizationResultV2(result, blueprint, caseOptions),
      (error) => error.code === code,
      name,
    );
  }

  const displayNameBlueprint = structuredClone(blueprint);
  displayNameBlueprint.characters[0] = { id: 'character-lead', display_name: '小满' };
  assert.throws(
    () => normalizeLocalizationResultV2(episodeLocalizationProviderResult({
      dialogue: [{ shot_id: 'shot-1', turns: [
        { id: 'dialogue-1', target_text: '小满 is back.' },
        { id: 'dialogue-2', target_text: 'Finish it.' },
      ] }],
    }), displayNameBlueprint, { ...options, validateTargetText: () => true }),
    (error) => error.code === 'LOCALIZATION_SOURCE_TEXT_REMAINS',
  );
});

test('episode 本地化审核以 JSON CAS 保存且锁定后原子推进 asset_review', () => {
  const fixture = createEpisodeReviewDb();
  const owner = { tenantId: 'tenant-a', userId: 'user-a' };
  try {
    const normalized = normalizeLocalizationResultV2(
      episodeLocalizationProviderResult(),
      fixture.blueprint,
      {
        locale: 'en-US', market: 'US', blueprintHash: fixture.blueprint.blueprint_hash,
        validateTargetText: acceptsEnglishTarget,
      },
    );
    const generated = saveGeneratedLocalizationReview(fixture.db, owner, fixture.versionId, normalized, {
      now: '2026-09-03T00:00:01.000Z',
    });
    assert.equal(generated.status, 'review');
    assert.equal(generated.version, 1);
    assert.equal(generated.localization.review.updated_at, '2026-09-03T00:00:01.000Z');
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM redraw_assets').get().count, 0);
    assert.equal(fixture.db.prepare('SELECT current_step FROM redraw_works WHERE id = 1').get().current_step, 1);

    const localeDrift = structuredClone(generated.localization);
    localeDrift.locale = 'fr-FR';
    localeDrift.market = 'CA';
    assert.throws(
      () => saveLocalizationReview(fixture.db, owner, fixture.versionId, {
        expectedUpdatedAt: generated.updated_at,
        localization: localeDrift,
        validateTargetText: () => true,
      }),
      (error) => error.code === 'LOCALIZATION_INPUT_INVALID',
    );

    const localization = structuredClone(generated.localization);
    localization.character_name_map['character-lead'] = 'Marcus';
    localization.dialogue_map[0].target_text = 'Avery, I have returned.';
    for (const key of Object.keys(localization.review)) {
      if (key === 'status' || key === 'updated_at') continue;
      for (const item of Object.keys(localization.review[key])) localization.review[key][item] = true;
    }
    const saved = saveLocalizationReview(fixture.db, owner, fixture.versionId, {
      expectedUpdatedAt: generated.updated_at,
      localization,
      validateTargetText: acceptsEnglishTarget,
      now: '2026-09-03T00:00:02.000Z',
    });
    assert.equal(saved.localization.character_name_map['character-lead'], 'Marcus');
    assert.notEqual(saved.localization_hash, generated.localization_hash);
    assert.throws(
      () => saveLocalizationReview(fixture.db, owner, fixture.versionId, {
        expectedUpdatedAt: generated.updated_at,
        localization,
        validateTargetText: acceptsEnglishTarget,
      }),
      (error) => error.code === 'LOCALIZATION_CAS_CONFLICT',
    );

    const locked = lockLocalizationReview(fixture.db, owner, fixture.versionId, {
      blueprintHash: fixture.blueprint.blueprint_hash,
      expectedLocalizationHash: saved.localization_hash,
      expectedUpdatedAt: saved.updated_at,
      validateTargetText: acceptsEnglishTarget,
      now: '2026-09-03T00:00:03.000Z',
    });
    assert.equal(locked.status, 'locked');
    assert.equal(locked.localization.review.status, 'locked');
    assert.notEqual(locked.localization_hash, saved.localization_hash);
    assert.equal(
      fixture.db.prepare('SELECT localization_hash FROM redraw_versions WHERE id = ?').get(fixture.versionId).localization_hash,
      locked.localization_hash,
    );
    assert.deepEqual(
      fixture.db.prepare('SELECT current_version, current_step, status FROM redraw_works WHERE id = 1').get(),
      { current_version: 1, current_step: 2, status: 'asset_review' },
    );
    assert.equal(fixture.db.prepare('SELECT status FROM redraw_versions WHERE id = ?').get(fixture.versionId).status, 'asset_review');
    assert.throws(
      () => saveLocalizationReview(fixture.db, owner, fixture.versionId, {
        expectedUpdatedAt: locked.updated_at,
        localization: locked.localization,
        validateTargetText: acceptsEnglishTarget,
      }),
      (error) => error.code === 'LOCALIZATION_LOCKED',
    );
  } finally {
    fixture.db.close();
  }
});

test('episode 本地化锁定缺少任一显式审核项时全量回滚', () => {
  const fixture = createEpisodeReviewDb();
  const owner = { tenantId: 'tenant-a', userId: 'user-a' };
  try {
    const normalized = normalizeLocalizationResultV2(
      episodeLocalizationProviderResult(), fixture.blueprint,
      {
        locale: 'en-US', market: 'US', blueprintHash: fixture.blueprint.blueprint_hash,
        validateTargetText: acceptsEnglishTarget,
      },
    );
    const generated = saveGeneratedLocalizationReview(fixture.db, owner, fixture.versionId, normalized, {
      now: '2026-09-03T00:00:01.000Z',
    });
    assert.throws(
      () => lockLocalizationReview(fixture.db, owner, fixture.versionId, {
        blueprintHash: fixture.blueprint.blueprint_hash,
        expectedLocalizationHash: generated.localization_hash,
        expectedUpdatedAt: generated.updated_at,
        validateTargetText: acceptsEnglishTarget,
      }),
      (error) => error.code === 'LOCALIZATION_REVIEW_REQUIRED',
    );
    assert.equal(getLocalizationReview(fixture.db, owner, fixture.versionId).status, 'review');
    assert.equal(fixture.db.prepare('SELECT current_step FROM redraw_works WHERE id = 1').get().current_step, 1);
  } finally {
    fixture.db.close();
  }
});

test('v2 本地化严格拒绝漂移、第二市场、未知字段、残留源文本和非法置信度', () => {
  const source = v2SourceFacts();
  const cases = [
    ['hash', { facts_hash: 'b'.repeat(64) }, 'LOCALIZATION_FACT_HASH_MISMATCH'],
    ['market', { market: 'MX' }, 'LOCALIZATION_MARKET_MISMATCH'],
    ['unknown', { prompt: 'explain how this was localized' }, 'LOCALIZATION_UNKNOWN_FIELD'],
    ['same dialogue', { dialogue: [{ shot_id: 'shot-1', turns: [{ id: 'turn-1', target_text: '别回头' }] }] }, 'LOCALIZATION_SOURCE_TEXT_REMAINS'],
    ['dialogue substring with punctuation', { dialogue: [{ shot_id: 'shot-1', turns: [{ id: 'turn-1', target_text: 'Please 别　回，头 now' }] }] }, 'LOCALIZATION_SOURCE_TEXT_REMAINS'],
    ['name remains', { dialogue: [{ shot_id: 'shot-1', turns: [{ id: 'turn-1', target_text: '小满, run now' }] }] }, 'LOCALIZATION_SOURCE_TEXT_REMAINS'],
    ['name object', { name_map: { c1: { target: 'Mateo' }, c2: 'Diego' } }, 'LOCALIZATION_NAME_INVALID'],
    ['name number', { name_map: { c1: 123, c2: 'Diego' } }, 'LOCALIZATION_NAME_INVALID'],
    ['duplicate name', { name_map: { c1: 'Mateo', c2: ' mateo ' } }, 'LOCALIZATION_NAME_DUPLICATE'],
    ['missing text', { text_map: {} }, 'LOCALIZATION_TEXT_REGION_MISMATCH'],
    ['text value object', { text_map: { 'shot-2:screen-1': { text: 'CALL MOM' } } }, 'LOCALIZATION_TEXT_REGION_MISMATCH'],
    ['ocr substring with punctuation', { text_map: { 'shot-2:screen-1': 'Please 给　妈妈，打 电话 now' } }, 'LOCALIZATION_SOURCE_TEXT_REMAINS'],
    ['dialogue row unknown', { dialogue: [{ shot_id: 'shot-1', provider_note: 'raw', turns: [{ id: 'turn-1', target_text: 'Run now' }] }] }, 'LOCALIZATION_UNKNOWN_FIELD'],
    ['dialogue turn unknown', { dialogue: [{ shot_id: 'shot-1', turns: [{ id: 'turn-1', target_text: 'Run now', style: 'extra' }] }] }, 'LOCALIZATION_UNKNOWN_FIELD'],
    ['culture currency allowed', { culture_map: { currency: 'USD' } }, null],
    ['culture target injection', { culture_map: { market: 'MX' } }, 'LOCALIZATION_CULTURE_MAP_INVALID'],
    ['culture target currency injection', { culture_map: { target_currency: 'MXN' } }, 'LOCALIZATION_CULTURE_MAP_INVALID'],
    ['culture target region injection', { culture_map: { target_region: 'LATAM' } }, 'LOCALIZATION_CULTURE_MAP_INVALID'],
    ['glossary target language injection', { glossary: { target_language: 'es-MX' } }, 'LOCALIZATION_GLOSSARY_INVALID'],
    ['glossary target country injection', { glossary: { target_country: 'MX' } }, 'LOCALIZATION_GLOSSARY_INVALID'],
    ['culture credential injection', { culture_map: { api_key: 'secret' } }, 'LOCALIZATION_UNKNOWN_FIELD'],
    ['glossary credential injection', { glossary: { access_key: 'secret' } }, 'LOCALIZATION_UNKNOWN_FIELD'],
    ['glossary nested value', { glossary: { family_title: { text: 'Mom' } } }, 'LOCALIZATION_GLOSSARY_INVALID'],
    ['extra turn', { dialogue: [{ shot_id: 'shot-1', turns: [{ id: 'turn-1', target_text: 'Run now' }, { id: 'turn-2', target_text: 'extra' }] }] }, 'LOCALIZATION_DIALOGUE_INVALID'],
    ['silent turn', { dialogue: [{ shot_id: 'shot-1', turns: [{ id: 'turn-1', target_text: 'Run now' }] }, { shot_id: 'shot-2', turns: [{ id: 'turn-x', target_text: 'noise' }] }] }, 'LOCALIZATION_DIALOGUE_INVALID'],
    ['confidence', { confidence: { ...v2LocalizationResult().confidence, names: Number.NaN } }, 'LOCALIZATION_INVALID_JSON'],
  ];
  for (const [name, patch, code] of cases) {
    if (!code) {
      assert.doesNotThrow(() => normalizeLocalizationResult(v2LocalizationResult(patch), source), name);
      continue;
    }
    assert.throws(
      () => normalizeLocalizationResult(v2LocalizationResult(patch), source),
      (error) => error.code === code,
      name,
    );
  }

  const inherited = Object.create({ locale: 'fr-FR' });
  Object.assign(inherited, v2LocalizationResult());
  assert.throws(
    () => normalizeLocalizationResult(inherited, source),
    (error) => error.code === 'LOCALIZATION_INVALID_JSON',
  );
});

test('v2 物化仅保存源片事实白名单并以 source_character_key 幂等绑定角色和声音草稿', () => {
  const db = createV2Db();
  const source = v2SourceFacts();
  const draft = createLocalizationDraft(db, { tenantId: 'tenant-a', userId: 'user-a' }, 1, {
    locale: 'en-US',
    market: 'US',
    localizationLevel: 'faithful',
    inputHash: source.facts_hash,
    idempotencyKey: 'confirm-v2-en-us',
    modelSnapshot: { provider: 'provider-a', model: 'model-a' },
  });
  const normalized = normalizeLocalizationResult(v2LocalizationResult(), source);
  const result = materializeLocalizationDraft(db, { tenantId: 'tenant-a', userId: 'user-a' }, draft.id, {
    workId: 1,
    locale: 'en-US',
    market: 'US',
    localizationLevel: 'faithful',
    sourceFacts: source,
    sourceFactsHash: source.facts_hash,
    ...normalized,
  });
  assert.equal(result.id, draft.id);
  if (hasColumn(db, 'redraw_versions', 'reference_bundle_required')) {
    assert.equal(db.prepare('SELECT reference_bundle_required FROM redraw_versions WHERE id = ?').get(draft.id).reference_bundle_required, 1);
  }
  const gate = evaluateGenerationGate(db, draft.id, { tenantId: 'tenant-a', userId: 'user-a' });
  assert.equal(gate.ok, false);
  assert.equal(gate.blocking[0].code, 'preparation_not_ready');

  const shots = db.prepare('SELECT * FROM redraw_shots WHERE version_id = ? ORDER BY shot_index').all(draft.id);
  assert.equal(shots.length, 2);
  const firstDraft = JSON.parse(shots[0].draft_json);
  assert.deepEqual(Object.keys(firstDraft).sort(), [
    'audio_contract',
    'camera_movement',
    'composition',
    'continuous_action',
    'ending_state',
    'opening_state',
    'text_regions',
    'visible_character_ids',
  ]);
  assert.equal(firstDraft.composition, source.shots[0].composition);
  assert.equal(firstDraft.opening_state, source.shots[0].opening_state);
  assert.equal(JSON.parse(shots[0].compiled_prompt_json).composition, source.shots[0].composition);
  const secondDraft = JSON.parse(shots[1].draft_json);
  const secondCompiled = JSON.parse(shots[1].compiled_prompt_json);
  assert.deepEqual(secondDraft.text_regions, [{
    ...source.shots[1].text_regions[0],
    target_text: 'CALL MOM',
  }]);
  assert.deepEqual(secondCompiled.text_regions, secondDraft.text_regions);
  assert.equal(secondDraft.text_regions[0].source_text, '给妈妈打电话');
  assert.equal(secondDraft.text_regions[0].kind, 'phone_screen');

  const row = db.prepare('SELECT text_map_json, source_facts_json, style_snapshot_json FROM redraw_versions WHERE id = ?').get(draft.id);
  assert.deepEqual(JSON.parse(row.text_map_json), { 'shot-2:screen-1': 'CALL MOM' });
  assert.equal(row.source_facts_json, JSON.stringify(source));
  assert.deepEqual(JSON.parse(row.style_snapshot_json), {});

  const assets = db.prepare('SELECT kind, source_ref_json, localized_name FROM redraw_assets WHERE version_id = ? ORDER BY id').all(draft.id);
  assert.equal(assets.length, 4);
  assert.deepEqual(assets.map((asset) => asset.kind), ['character', 'voice', 'character', 'voice']);
  assert.deepEqual(JSON.parse(assets[0].source_ref_json).source_ref, {
    kind: 'character',
    source_character_key: 'c1',
  });
  assert.deepEqual(JSON.parse(assets[1].source_ref_json).source_ref, {
    kind: 'voice',
    source_character_key: 'c1',
  });
  assert.equal(assets[0].localized_name, 'Mateo');
  assert.equal(assets[2].localized_name, 'Diego');

  const replay = materializeLocalizationDraft(db, { tenantId: 'tenant-a', userId: 'user-a' }, draft.id, {
    workId: 1,
    locale: 'en-US',
    market: 'US',
    localizationLevel: 'faithful',
    sourceFacts: source,
    sourceFactsHash: source.facts_hash,
    ...normalized,
  });
  assert.equal(replay.id, draft.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_assets WHERE version_id = ?').get(draft.id).count, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_shots WHERE version_id = ?').get(draft.id).count, 2);
  db.close();
});

test('v2 物化拒绝缺失 text_map 目标且不留下部分版本证据', () => {
  const db = createV2Db();
  const source = v2SourceFacts();
  const draft = createLocalizationDraft(db, { tenantId: 'tenant-a', userId: 'user-a' }, 1, {
    locale: 'en-US',
    market: 'US',
    localizationLevel: 'faithful',
    inputHash: source.facts_hash,
    idempotencyKey: 'confirm-v2-missing-text-map',
    modelSnapshot: { provider: 'provider-a', model: 'model-a' },
  });
  const normalized = normalizeLocalizationResult(v2LocalizationResult(), source);

  assert.throws(
    () => materializeLocalizationDraft(db, { tenantId: 'tenant-a', userId: 'user-a' }, draft.id, {
      workId: 1,
      locale: 'en-US',
      market: 'US',
      localizationLevel: 'faithful',
      sourceFacts: source,
      sourceFactsHash: source.facts_hash,
      ...normalized,
      text_map: {},
    }),
    (error) => error.code === 'LOCALIZATION_TEXT_REGION_MISMATCH',
  );
  assert.equal(db.prepare('SELECT status FROM redraw_versions WHERE id = ?').get(draft.id).status, 'draft');
  assert.deepEqual(JSON.parse(db.prepare('SELECT text_map_json FROM redraw_versions WHERE id = ?').get(draft.id).text_map_json), {});
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_shots WHERE version_id = ?').get(draft.id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_assets WHERE version_id = ?').get(draft.id).count, 0);
  db.close();
});

test('v1 物化保持旧版本 reference_bundle_required=0 兼容', () => {
  const db = createDb();
  if (!hasColumn(db, 'redraw_versions', 'reference_bundle_required')) {
    db.exec('ALTER TABLE redraw_versions ADD COLUMN reference_bundle_required INTEGER NOT NULL DEFAULT 0');
  }
  const result = createLocalizationVersion(db, { tenantId: 'tenant-a', userId: 'user-a' }, 1, localizationPayload());
  assert.equal(
    db.prepare('SELECT reference_bundle_required FROM redraw_versions WHERE id = ?').get(result.id).reference_bundle_required,
    0,
  );
  const gate = evaluateGenerationGate(db, result.id, { tenantId: 'tenant-a', userId: 'user-a' });
  assert.notEqual(gate.blocking[0]?.code, 'preparation_not_ready');
  db.close();
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
    {
      speaker_id: 'c1',
      source_text: '别回头',
      localized_text: "Don't look back",
      start_ms: 500,
      end_ms: 2_500,
      emotion: 'urgent',
      overlap_group: null,
      estimated_duration_ms: 900,
    },
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

test('物化本地化显式绑定源事实版本且兼容调用优先当前源版本', () => {
  for (const explicit of [true, false]) {
    const db = createDb();
    const nextFacts = {
      ...sourceFacts(),
      facts_hash: undefined,
      shots: [{
        id: 'shot-current',
        start_ms: 0,
        end_ms: 3_000,
        opening_state: 'current opening',
        continuous_action: 'current action',
        ending_state: 'current ending',
        dialogue: [{
          speaker_id: 'c1',
          source_text: '快走',
          start_ms: 300,
          end_ms: 1_500,
          emotion: 'urgent',
          overlap_group: null,
        }],
      }],
    };
    const nextHash = buildLocalizationInput(nextFacts, { locale: 'source' }).source_facts_hash;
    const now = new Date().toISOString();
    const sourceVersionId = Number(db.prepare(`
      INSERT INTO redraw_versions
        (work_id, tenant_id, user_id, version, locale, market, localization_level,
         source_facts_json, facts_hash, status, created_at, updated_at)
      VALUES (1, 'tenant-a', 'user-a', 2, 'source', '', 'faithful', ?, ?, 'asset_review', ?, ?)
    `).run(JSON.stringify(nextFacts), nextHash, now, now).lastInsertRowid);
    db.prepare(`
      INSERT INTO redraw_shots
        (work_id, shot_id, version_id, tenant_id, user_id, batch_index, shot_index,
         start_ms, end_ms, duration_ms, source_dialogue_json, localized_dialogue_json,
         references_json, opening_state, continuous_action, ending_state, created_at, updated_at)
      VALUES (1, 'shot-current', ?, 'tenant-a', 'user-a', 1, 1, 0, 3000, 3000, ?, '[]', '[]',
        'current opening', 'current action', 'current ending', ?, ?)
    `).run(sourceVersionId, JSON.stringify(nextFacts.shots[0].dialogue), now, now);
    db.prepare('UPDATE redraw_works SET current_version = 2 WHERE id = 1').run();

    const result = createLocalizationVersion(db, { tenantId: 'tenant-a', userId: 'user-a' }, 1, {
      ...localizationPayload({
        sourceFacts: nextFacts,
        sourceFactsHash: nextHash,
        dialogue: [{ shot_id: 'shot-current', turns: [{ speaker_id: 'c1', localized_text: 'Go now' }] }],
      }),
      ...(explicit ? { sourceVersionId } : {}),
    });

    const shot = db.prepare('SELECT shot_id, opening_state FROM redraw_shots WHERE version_id = ?').get(result.id);
    assert.deepEqual(shot, { shot_id: 'shot-current', opening_state: 'current opening' }, explicit ? 'explicit' : 'current fallback');
    db.close();
  }
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
    () => createLocalizationVersion(
      db,
      { tenantId: 'tenant-a', userId: 'user-a' },
      1,
      localizationPayload({ sourceFacts: facts }),
    ),
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

test('物化本地化对白时由服务端保留源片说话人和时间码', () => {
  const db = createDb();
  const result = createLocalizationVersion(
    db,
    { tenantId: 'tenant-a', userId: 'user-a' },
    1,
    localizationPayload(),
  );
  const shot = db.prepare('SELECT localized_dialogue_json FROM redraw_shots WHERE version_id = ? AND shot_index = 1')
    .get(result.id);
  const [turn] = JSON.parse(shot.localized_dialogue_json);
  assert.deepEqual(
    {
      speaker_id: turn.speaker_id,
      start_ms: turn.start_ms,
      end_ms: turn.end_ms,
      emotion: turn.emotion,
      estimated_duration_ms: turn.estimated_duration_ms,
    },
    {
      speaker_id: 'c1',
      start_ms: 500,
      end_ms: 2_500,
      emotion: 'urgent',
      estimated_duration_ms: 900,
    },
  );
  db.close();
});

test('物化本地化对白拒绝提供方改写说话人或时间码', () => {
  for (const turns of [
    [{ speaker_id: 'c2', localized_text: "Don't look back" }],
    [{ speaker_id: 'c1', localized_text: "Don't look back", start_ms: 700, end_ms: 2_500 }],
  ]) {
    const db = createDb();
    assert.throws(
      () => createLocalizationVersion(
        db,
        { tenantId: 'tenant-a', userId: 'user-a' },
        1,
        localizationPayload({ dialogue: [{ shot_id: 'shot-1', turns }] }),
      ),
      (error) => error.code === 'LOCALIZATION_DIALOGUE_INVALID',
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_versions').get().count, 1);
    db.close();
  }
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
