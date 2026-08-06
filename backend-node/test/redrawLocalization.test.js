const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  buildLocalizationInput,
  normalizeLocalizationResult,
  validateLocalizedFacts,
  createLocalizationVersion,
} = require('../src/services/localizationService');

function sourceFacts() {
  return {
    schema_version: '1.0',
    duration_ms: 10_000,
    characters: [
      { id: 'c1', source_name: '小满', relationships: [{ id: 'rel-1', from: 'c1', to: 'c2', type: 'sister' }] },
      { id: 'c2', source_name: '阿岚', relationships: [] },
    ],
    scenes: [{ id: 's1', location: '天台', time: '夜' }],
    props: [{ id: 'p1', name: '旧手机' }],
    shots: [{ id: 'shot-1', start_ms: 0, end_ms: 10_000 }],
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

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE redraw_works (
      id INTEGER PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      current_version INTEGER NOT NULL DEFAULT 0,
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
      facts_hash TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
  `);
  db.prepare('INSERT INTO redraw_works (id, tenant_id, user_id) VALUES (1, ?, ?)').run('tenant-a', 'user-a');
  return db;
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

test('创建本地化版本只追加版本并且不改写源事实', () => {
  const db = createDb();
  const facts = sourceFacts();
  const result = createLocalizationVersion(db, { tenantId: 'tenant-a', userId: 'user-a' }, 1, {
    locale: 'en-US',
    market: 'US',
    sourceFacts: facts,
    sourceFactsHash: buildLocalizationInput(facts, { locale: 'en-US' }).source_facts_hash,
    nameMap: { 小满: 'Maya' },
    cultureMap: { currency: 'USD' },
    glossary: { 旧手机: 'old phone' },
    styleSnapshot: { stable_key: 'style-1', version: 1 },
  });
  assert.equal(result.version, 1);
  assert.equal(db.prepare('SELECT current_version FROM redraw_works WHERE id = 1').get().current_version, 1);
  const row = db.prepare('SELECT * FROM redraw_versions WHERE id = ?').get(result.id);
  assert.equal(row.source_facts_json, JSON.stringify(facts));
  assert.deepEqual(JSON.parse(row.name_map_json), { 小满: 'Maya' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_versions').get().count, 1);
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
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_versions').get().count, 0);
  db.close();
});
