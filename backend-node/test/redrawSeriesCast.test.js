'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const seriesCast = require('../src/services/redrawSeriesCastService');
const { buildPrompt } = require('../src/services/redrawNativeSourceAnalysisService');

const TENANT = 'personal:user-a';
const USER = 'user-a';

function factsV2(hash, characters) {
  return {
    schema_version: '2.0',
    v1_facts_hash: hash,
    duration_ms: 20_000,
    story: ['一集的剧情。'],
    characters,
    scenes: [{ id: 's1', location: '校门口', time: '白天', source_ranges: [{ start_ms: 0, end_ms: 20_000 }] }],
    props: [],
    shots: [{ id: 'shot-1', index: 1, start_ms: 0, end_ms: 20_000, visible_character_ids: characters.map((c) => c.id), text_regions: [], dialogue: [] }],
    causal_chain: [], reversals: [], episode_hook: '', locked_facts: [],
  };
}

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-series-cast-'));
  const now = Date.parse('2026-09-29T00:00:00Z');
  const project = (title) => Number(db.prepare(`INSERT INTO redraw_projects (tenant_id, user_id, title, default_locale, default_market,
    localization_level, status, created_at, updated_at) VALUES (?, ?, ?, 'es', '', 'faithful', 'draft', ?, ?)`)
    .run(TENANT, USER, title, new Date(now).toISOString(), new Date(now).toISOString()).lastInsertRowid);
  let seq = 0;
  // 建一个作品；characters 为 null 时不写分析结果（模拟还没分析完的一集）。
  const work = (projectId, characters) => {
    seq += 1;
    const at = new Date(now + seq * 60_000).toISOString();
    const hash = String(seq).repeat(64).slice(0, 64);
    const assetId = Number(db.prepare(`INSERT INTO assets (name, type, url, local_path, created_at, updated_at)
      VALUES ('ep.mp4', 'video', '/static/ep.mp4', ?, ?, ?)`).run(`redraw-sources/ep${seq}.mp4`, at, at).lastInsertRowid);
    const taskId = `task-${seq}`;
    const workId = Number(db.prepare(`INSERT INTO redraw_works (project_id, tenant_id, user_id, title, source_asset_id,
      source_fingerprint, duration_ms, current_version, current_step, status, task_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 20000, 1, 2, 'asset_review', ?, ?, ?)`)
      .run(projectId, TENANT, USER, `第 ${seq} 集`, assetId, hash, taskId, at, at).lastInsertRowid);
    if (!characters) return workId;
    const rel = `redraw-analysis/${taskId}/source-analysis.json`;
    fs.mkdirSync(path.dirname(path.join(storageRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(storageRoot, rel), JSON.stringify({ schema_version: '2.0', facts: { facts_hash: hash }, facts_v2: factsV2(hash, characters) }));
    const resultAssetId = Number(db.prepare(`INSERT INTO assets (name, type, category, local_path, metadata, created_at, updated_at)
      VALUES ('analysis', 'json', 'redraw_source_analysis', ?, ?, ?, ?)`)
      .run(rel, JSON.stringify({ tenant_id: TENANT, user_id: USER, work_id: workId }), at, at).lastInsertRowid);
    db.prepare(`INSERT INTO async_tasks (id, type, status, progress, resource_id, tenant_id, user_id, metadata, result, created_at, updated_at)
      VALUES (?, 'redraw_analysis', 'completed', 100, ?, ?, ?, '{}', ?, ?, ?)`)
      .run(taskId, String(workId), TENANT, USER, JSON.stringify({ status: 'completed', result_asset_id: resultAssetId, facts_hash: hash }), at, at);
    db.prepare(`INSERT INTO redraw_versions (work_id, tenant_id, user_id, version, locale, market, localization_level,
      source_facts_json, facts_hash, status, created_at, updated_at) VALUES (?, ?, ?, 1, 'source', '', 'faithful', ?, ?, 'asset_review', ?, ?)`)
      // 线上版从分析结果文件读 facts_v2，主分支从 source_facts_json 读；两处都写，两条线都能跑。
      .run(workId, TENANT, USER, JSON.stringify(factsV2(hash, characters)), hash, at, at);
    return workId;
  };
  const getWork = (id) => db.prepare('SELECT * FROM redraw_works WHERE id = ?').get(id);
  return { db, storageRoot, project, work, getWork, cleanup: () => { db.close(); fs.rmSync(storageRoot, { recursive: true, force: true }); } };
}

test('an episode is analysed with the cast of the earlier episodes of the same series', () => {
  const t = setup();
  try {
    const series = t.project('整部剧');
    const other = t.project('另一部剧');
    const ep1 = t.work(series, [
      { id: 'c1', source_name: '林江', display_name: 'Lin Jiang', appearance: '约17岁，偏瘦，蓝白校服' },
      { id: 'c2', source_name: '林哥', display_name: '林哥', appearance: '壮实' },
    ]);
    t.work(other, [{ id: 'c1', source_name: '别的剧主角', appearance: 'x' }]);
    const ep2 = t.work(series, [{ id: 'c1', source_name: '林江', appearance: '换了外套' }, { id: 'c3', source_name: '母亲', appearance: '四十多岁' }]);
    const ep3 = t.work(series, null);

    const first = seriesCast.seriesKnownCast(t.db, t.getWork(ep1), t.storageRoot);
    assert.deepEqual(first, { cast: [], episodes: [] }, 'the first episode has no earlier cast');

    const second = seriesCast.seriesKnownCast(t.db, t.getWork(ep2), t.storageRoot);
    assert.deepEqual(second.episodes, [ep1]);
    assert.deepEqual(second.cast.map((c) => c.name), ['林江', '林哥'], 'another series never leaks in');

    const third = seriesCast.seriesKnownCast(t.db, t.getWork(ep3), t.storageRoot);
    assert.deepEqual(third.episodes, [ep1, ep2]);
    assert.deepEqual(third.cast.map((c) => c.name), ['林江', '林哥', '母亲'], 'a name seen earlier keeps the first episode\'s wording');
    assert.equal(third.cast[0].appearance, '约17岁，偏瘦，蓝白校服');
  } finally {
    t.cleanup();
  }
});

test('an earlier episode without an analysis result is skipped', () => {
  const t = setup();
  try {
    const series = t.project('整部剧');
    t.work(series, null);
    const ep2 = t.work(series, [{ id: 'c1', source_name: '林江', appearance: 'a' }]);
    const ep3 = t.work(series, null);
    const result = seriesCast.seriesKnownCast(t.db, t.getWork(ep3), t.storageRoot);
    assert.deepEqual(result.episodes, [ep2]);
    assert.deepEqual(result.cast.map((c) => c.name), ['林江']);
  } finally {
    t.cleanup();
  }
});

test('known cast lists merge by name and the analysis prompt covers earlier episodes', () => {
  const merged = seriesCast.mergeKnownCast(
    [{ name: '林江', appearance: '第一集' }],
    [{ name: '林江', appearance: '本集分段' }, { name: '母亲', appearance: 'b' }, { name: '' }],
  );
  assert.deepEqual(merged, [{ name: '林江', appearance: '第一集' }, { name: '母亲', appearance: 'b' }]);
  const prompt = buildPrompt({ duration_ms: 20_000 }, { knownCast: merged });
  assert.match(prompt, /earlier episodes of the same series/);
  assert.match(prompt, /"林江"/);
  assert.doesNotMatch(buildPrompt({ duration_ms: 20_000 }, {}), /earlier episodes/);
});
