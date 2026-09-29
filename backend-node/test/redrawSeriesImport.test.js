'use strict';

// 整部剧转绘（R72）：同一转绘项目的第 2 集按第 1 集锁定老角色的名字与形象，新角色不能和前几集重名；
// 导入时可追加为第 1 集工厂项目的第 2 集，老角色的图与音色沿用，已有的集和角色不被改动。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const creditLedger = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const storageLayout = require('../src/services/storageLayout');
const redrawRoutes = require('../src/routes/redraw');

const TENANT = 'personal:user-a';
const USER = 'user-a';
const MODEL = 'gpt-localize';
const MX = { locale: 'es', market: 'MX' };
const HASH1 = '1'.repeat(64);
const HASH2 = '2'.repeat(64);

function episodeOneFacts() {
  return {
    schema_version: '2.0',
    v1_facts_hash: HASH1,
    duration_ms: 8_000,
    story: ['林江被嘲笑后发现口袋里只有一枚硬币。'],
    characters: [
      { id: 'c1', source_name: '林江', relationship: '主角', relationships: ['c2 的朋友'], appearance: '约17岁，偏瘦，黑色短发，蓝白校服' },
      { id: 'c2', source_name: '林哥', relationship: '同学', relationships: [], appearance: '约17岁，壮实，白色校服' },
    ],
    scenes: [
      { id: 's1', location: '店铺门口', time: '白天', visual: '中文招牌的临街店铺', source_ranges: [{ start_ms: 0, end_ms: 4_000 }] },
      { id: 's2', location: '卧室', time: '夜间', visual: '书桌和旧电脑', source_ranges: [{ start_ms: 4_000, end_ms: 8_000 }] },
    ],
    props: [{ id: 'p1', name: '一枚硬币', evidence_ranges: [{ start_ms: 4_000, end_ms: 8_000 }] }],
    shots: [
      {
        id: 'shot-1', index: 1, start_ms: 0, end_ms: 4_000,
        composition: '林江的近景', camera_movement: '固定', opening_state: '林江抬头',
        continuous_action: '林江对林哥说话', ending_state: '林江皱眉',
        visible_character_ids: ['c1', 'c2'],
        text_regions: [{ id: 'txt1', kind: 'subtitle', source_text: '你谁啊', speaker_id: 'c1' }],
        dialogue: [],
      },
      {
        id: 'shot-2', index: 2, start_ms: 4_000, end_ms: 8_000,
        composition: '林哥在卧室里握着硬币', camera_movement: '缓推', opening_state: '他张开手',
        continuous_action: '他盯着硬币', ending_state: '他笑了',
        visible_character_ids: ['c2'],
        text_regions: [{ id: 'txt3', kind: 'subtitle', source_text: '这就是全部家当', speaker_id: 'c2' }],
        dialogue: [],
      },
    ],
    causal_chain: ['只有一枚硬币让缺钱变得具体。'],
    reversals: ['他意识到硬币就是全部家当。'],
    episode_hook: '他决定把世界杯当作起步资金。',
    locked_facts: ['林江只有一枚硬币。'],
  };
}

function episodeTwoFacts() {
  return {
    schema_version: '2.0',
    v1_facts_hash: HASH2,
    duration_ms: 8_000,
    story: ['林江在卧室里下定决心，第二天王老师在教室点名。'],
    characters: [
      { id: 'c1', source_name: '林江', relationship: '主角', relationships: [], appearance: '约17岁，偏瘦，黑色短发，蓝白校服' },
      { id: 'c2', source_name: '王老师', relationship: '班主任', relationships: [], appearance: '约45岁，戴眼镜，灰色西装' },
    ],
    scenes: [
      { id: 's1', location: '卧室', time: '夜间', visual: '书桌和旧电脑', source_ranges: [{ start_ms: 0, end_ms: 4_000 }] },
      { id: 's2', location: '教室', time: '白天', visual: '黑板和课桌', source_ranges: [{ start_ms: 4_000, end_ms: 8_000 }] },
    ],
    props: [{ id: 'p1', name: '一枚硬币', evidence_ranges: [{ start_ms: 0, end_ms: 4_000 }] }],
    shots: [
      {
        id: 'shot-1', index: 1, start_ms: 0, end_ms: 4_000,
        composition: '林江坐在书桌前', camera_movement: '固定', opening_state: '林江握拳',
        continuous_action: '林江自言自语', ending_state: '林江点头',
        visible_character_ids: ['c1'],
        text_regions: [{ id: 'txt1', kind: 'subtitle', source_text: '我绝不放弃', speaker_id: 'c1' }],
        dialogue: [],
      },
      {
        id: 'shot-2', index: 2, start_ms: 4_000, end_ms: 8_000,
        composition: '王老师站在讲台前', camera_movement: '缓推', opening_state: '王老师翻开点名册',
        continuous_action: '王老师点名', ending_state: '教室安静',
        visible_character_ids: ['c2'],
        text_regions: [{ id: 'txt2', kind: 'subtitle', source_text: '上课了', speaker_id: 'c2' }],
        dialogue: [],
      },
    ],
    causal_chain: ['那枚硬币让他下定决心第二天准时上课。'],
    reversals: ['老师点到他的名字。'],
    episode_hook: '王老师宣布了一个意外消息。',
    locked_facts: ['林江准时到校。'],
  };
}

function episodeOneOutput() {
  return {
    characters: [
      { id: 'c1', name: 'Diego', appearance: '约17岁的墨西哥少年，偏瘦，浅棕色皮肤，黑色短卷发，墨西哥公立高中校服', role: '主角' },
      { id: 'c2', name: 'Mateo', appearance: '约17岁的墨西哥少年，壮实，古铜色皮肤，白色校服衬衫', role: '同学' },
    ],
    scenes: [
      { id: 's1', location: '街角小卖部门口', visual: '墨西哥城街角的彩色小卖部，西班牙语招牌' },
      { id: 's2', location: '卧室', visual: '墨西哥普通家庭卧室，木书桌与旧电脑' },
    ],
    props: [{ id: 'p1', name: '一枚比索硬币' }],
    lines: [
      { key: 'shot-1:txt1', text: '¿Y tú quién eres?' },
      { key: 'shot-2:txt3', text: 'Esto es todo lo que tengo.' },
    ],
    screen_texts: [],
    story: ['Diego在墨西哥城街角小卖部被Mateo嘲笑后，发现口袋里只剩一枚比索硬币。'],
    episode_hook: 'Diego决定把世界杯当作起步资金。',
    setting: '故事发生在墨西哥城，所有人物都是墨西哥人。',
  };
}

function episodeTwoOutput({ c1 = 'Diego', c2 = 'Señor Ruiz' } = {}) {
  return {
    characters: [
      { id: 'c1', name: c1, appearance: '模型重新写的形象，应被第 1 集锁定的形象覆盖' },
      { id: 'c2', name: c2, appearance: '约45岁的墨西哥男教师，戴眼镜，灰色西装', role: '班主任' },
    ],
    scenes: [
      { id: 's1', location: '卧室', visual: '墨西哥普通家庭卧室，木书桌与旧电脑' },
      { id: 's2', location: '教室', visual: '墨西哥公立高中教室' },
    ],
    props: [{ id: 'p1', name: '一枚比索硬币' }],
    lines: [
      { key: 'shot-1:txt1', text: `Nunca me rendiré, soy ${c1}.` },
      { key: 'shot-2:txt2', text: 'Empieza la clase.' },
    ],
    screen_texts: [],
    story: [`${c1}在墨西哥城的卧室里下定决心，第二天${c2}在教室点名。`],
    episode_hook: `${c2}宣布了一个意外消息。`,
    setting: '故事发生在墨西哥城，所有人物都是墨西哥人。',
  };
}

function captureResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-series-import-'));
  db.prepare(`INSERT INTO ai_service_configs (service_type, model, default_model, settings, is_active, is_default, priority)
    VALUES ('text', ?, ?, ?, 1, 1, 10)`).run(MODEL, MODEL, JSON.stringify({
    redraw_locale_capabilities: [{
      status: 'verified', locale: 'es', market: '',
      evidence: { text: { provider: 'verified-provider', model: MODEL, task_id: 't', terminal_status: 'completed', artifact_id: 'cap-artifact' } },
    }],
  }));
  prices.set(db, MODEL, 10);
  creditLedger.setTenantAccountBalance(db, TENANT, 1000);
  const replies = [];
  const prompts = [];
  let pending = Promise.resolve();
  const handlers = redrawRoutes(db, { error() {}, info() {}, warn() {} }, {
    cfg: { storage: { local_path: storageRoot } },
    canReadArtifact: (id) => id === 'cap-artifact' || Number.isFinite(Number(id)),
    factoryLocalizationSchedule: (job) => { pending = Promise.resolve().then(job); return pending; },
    factoryLocalizationGenerateText: async (_db, _log, _type, user, system) => {
      prompts.push({ user: JSON.parse(user), system });
      const next = replies.shift();
      if (!next) throw new Error('unexpected model call');
      return JSON.stringify(next);
    },
  });
  const now = new Date().toISOString();
  const project = () => Number(db.prepare(`INSERT INTO redraw_projects (tenant_id, user_id, title, default_locale, default_market,
    localization_level, status, created_at, updated_at) VALUES (?, ?, '整部剧', 'es', '', 'faithful', 'draft', ?, ?)`)
    .run(TENANT, USER, now, now).lastInsertRowid);
  const projectId = project();
  const call = async (workId, body, { userId = USER, tenantId = TENANT } = {}) => {
    const res = captureResponse();
    await handlers.importToFactory({ params: { id: String(workId) }, tenant: { id: tenantId }, user: { id: userId }, body }, res);
    return res;
  };
  return { db, storageRoot, replies, prompts, projectId, project, call, settle: () => pending };
}

// 一集样片 = 同一转绘项目里的一个作品；分析结果文件与 source 版本里都放 facts_v2（线上版读文件，主分支读版本）。
function seedEpisode(t, facts, createdAt, projectId = t.projectId) {
  const { db, storageRoot } = t;
  const hash = facts.v1_facts_hash;
  const sourceAssetId = Number(db.prepare(`INSERT INTO assets (name, type, url, local_path, created_at, updated_at)
    VALUES ('sample.mp4', 'video', '/static/s.mp4', 'redraw-sources/s.mp4', ?, ?)`).run(createdAt, createdAt).lastInsertRowid);
  const workId = Number(db.prepare(`INSERT INTO redraw_works (project_id, tenant_id, user_id, title, source_asset_id,
    source_fingerprint, duration_ms, current_version, current_step, status, created_at, updated_at)
    VALUES (?, ?, ?, 'sample.mp4', ?, ?, 20000, 1, 2, 'asset_review', ?, ?)`)
    .run(projectId, TENANT, USER, sourceAssetId, `${hash.slice(0, 40)}${String(sourceAssetId).padStart(24, '0')}`, createdAt, createdAt).lastInsertRowid);
  const taskId = `task-series-${workId}`;
  db.prepare('UPDATE redraw_works SET task_id = ? WHERE id = ?').run(taskId, workId);
  const rel = `redraw-analysis/${taskId}/source-analysis.json`;
  fs.mkdirSync(path.dirname(path.join(storageRoot, rel)), { recursive: true });
  fs.writeFileSync(path.join(storageRoot, rel), JSON.stringify({ schema_version: '2.0', facts: { facts_hash: hash }, facts_v2: facts }));
  const resultAssetId = Number(db.prepare(`INSERT INTO assets (name, type, category, local_path, metadata, created_at, updated_at)
    VALUES ('analysis', 'json', 'redraw_source_analysis', ?, ?, ?, ?)`)
    .run(rel, JSON.stringify({ tenant_id: TENANT, user_id: USER, work_id: workId }), createdAt, createdAt).lastInsertRowid);
  db.prepare(`INSERT INTO async_tasks (id, type, status, progress, resource_id, tenant_id, user_id, metadata, result, created_at, updated_at)
    VALUES (?, 'redraw_analysis', 'completed', 100, ?, ?, ?, ?, ?, ?, ?)`)
    .run(taskId, String(workId), TENANT, USER, JSON.stringify({ redraw_analysis: { locale: 'es', market: '', free_style: { positive: '真人写实', negative: '' } } }),
      JSON.stringify({ status: 'completed', result_asset_id: resultAssetId, facts_hash: hash }), createdAt, createdAt);
  db.prepare(`INSERT INTO redraw_versions (work_id, tenant_id, user_id, version, locale, market, localization_level,
    source_facts_json, facts_hash, status, created_at, updated_at) VALUES (?, ?, ?, 1, 'source', '', 'faithful', ?, ?, 'asset_review', ?, ?)`)
    .run(workId, TENANT, USER, JSON.stringify(facts), hash, createdAt, createdAt);
  return workId;
}

async function localize(t, workId) {
  const started = await t.call(workId, { action: 'start', localization: MX, expected_credits: 10 });
  assert.equal(started.statusCode, 202, JSON.stringify(started.body));
  await t.settle();
  return t.call(workId, { action: 'status', localization: MX });
}

function metadataOf(db, dramaId) {
  return JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id = ?').get(dramaId).metadata);
}

function cleanup(t) {
  t.db.close();
  fs.rmSync(t.storageRoot, { recursive: true, force: true });
}

async function importFirstEpisode(t) {
  const ep1 = seedEpisode(t, episodeOneFacts(), '2026-09-29T01:00:00.000Z');
  t.replies.push(episodeOneOutput());
  const ready = await localize(t, ep1);
  assert.equal(ready.body.data.status, 'ready');
  assert.equal(ready.body.data.series_lock, undefined, 'the first episode locks nobody');
  const imported = await t.call(ep1, { action: 'import', localization: MX });
  assert.equal(imported.statusCode, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.data.created, true);
  return { ep1, dramaId: imported.body.data.drama_id };
}

test('第 2 集沿用第 1 集的角色、新角色不重名，追加为同一工厂项目的第 2 集，老角色的图与音色、同一地点的场景图都沿用', async () => {
  const t = setup();
  try {
    const { dramaId } = await importFirstEpisode(t);
    const series = metadataOf(t.db, dramaId).redraw_series;
    assert.equal(series.project_id, t.projectId);
    assert.deepEqual([series.locale, series.market], ['es', 'MX']);
    assert.deepEqual(Object.keys(series.characters).sort(), ['林哥', '林江']);
    assert.equal(series.episodes.length, 1);
    const before = t.db.prepare('SELECT id, name, appearance, updated_at FROM characters WHERE drama_id = ? ORDER BY id').all(dramaId);
    const diego = before.find((row) => row.name === 'Diego');
    // 工厂里第 1 集已生成：Diego 已定音，卧室已出图。
    t.db.prepare('UPDATE characters SET seedance2_voice_asset = ? WHERE id = ?')
      .run(JSON.stringify({ status: 'active', url: '/static/voices/diego.mp3' }), diego.id);
    t.db.prepare("UPDATE scenes SET image_url = '/static/p/bedroom.png', local_path = 'p/bedroom.png', status = 'generated' WHERE drama_id = ? AND location = '卧室'")
      .run(dramaId);

    const ep2 = seedEpisode(t, episodeTwoFacts(), '2026-09-29T02:00:00.000Z');
    const status = await t.call(ep2, { action: 'status', localization: MX });
    assert.deepEqual(status.body.data.series_targets.map(({ drama_id, episodes, this_work_episode }) => ({ drama_id, episodes, this_work_episode })),
      [{ drama_id: dramaId, episodes: 1, this_work_episode: null }]);

    // 模型把林江叫成了 Carlos（被锁定改回 Diego，台词和梗概里的 Carlos 也换回），新老师用了第 1 集的名字 Mateo（补问一次改名）。
    t.replies.push(episodeTwoOutput({ c1: 'Carlos', c2: 'Mateo' }), {
      characters: [{ id: 'c2', name: 'Señor Ruiz', appearance: '约45岁的墨西哥男教师，戴眼镜，灰色西装', role: '班主任' }],
    });
    const ready = await localize(t, ep2);
    assert.equal(ready.body.data.status, 'ready', JSON.stringify(ready.body.data));
    assert.deepEqual(ready.body.data.series_lock, { characters: ['Diego'] });
    const [, firstAsk, repairAsk] = t.prompts;
    assert.match(firstAsk.system, /locked_characters/);
    assert.match(firstAsk.system, /names_in_use/);
    assert.deepEqual(firstAsk.user.locked_characters.map(({ id, name }) => ({ id, name })), [{ id: 'c1', name: 'Diego' }]);
    assert.match(firstAsk.user.locked_characters[0].appearance, /墨西哥少年/);
    assert.deepEqual([...firstAsk.user.names_in_use].sort(), ['Diego', 'Mateo']);
    assert.deepEqual(repairAsk.user.characters.map((c) => c.id), ['c2']);
    assert.deepEqual([...repairAsk.user.names_in_use].sort(), ['Diego', 'Mateo']);
    assert.deepEqual([creditLedger.getTenantAccount(t.db, TENANT).spent, creditLedger.getTenantAccount(t.db, TENANT).held], [20, 0]);

    const appended = await t.call(ep2, { action: 'import', localization: MX, target_drama_id: dramaId });
    assert.equal(appended.statusCode, 200, JSON.stringify(appended.body));
    const data = appended.body.data;
    assert.deepEqual([data.appended, data.created, data.drama_id, data.episode_number], [true, false, dramaId, 2]);
    assert.deepEqual(data.reused_character_names, ['Diego']);
    assert.deepEqual(data.new_character_names, ['Señor Ruiz']);
    assert.deepEqual(data.voice_casting, [{ character_id: 'c2', name: 'Señor Ruiz', shot_number: 2 }], 'Diego already has a voice');
    assert.equal(data.counts.reused_scene_images, 1);
    assert.equal(data.counts.reused_props, 1);

    const after = t.db.prepare('SELECT id, name, appearance, updated_at FROM characters WHERE drama_id = ? ORDER BY id').all(dramaId);
    assert.deepEqual(after.slice(0, before.length), before, 'existing characters are not touched');
    assert.deepEqual(after.map((row) => row.name), ['Diego', 'Mateo', 'Señor Ruiz']);
    const episodes = t.db.prepare('SELECT id, episode_number, title FROM episodes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY episode_number').all(dramaId);
    assert.deepEqual(episodes.map((row) => [row.episode_number, row.title]).slice(1), [[2, '第 2 集']]);
    assert.equal(t.db.prepare('SELECT total_episodes FROM dramas WHERE id = ?').get(dramaId).total_episodes, 2);
    const ep2Id = episodes[1].id;
    const linked = t.db.prepare('SELECT character_id FROM episode_characters WHERE episode_id = ? ORDER BY character_id').all(ep2Id)
      .map((row) => row.character_id);
    assert.deepEqual(linked, [diego.id, after[2].id]);
    const scenes = t.db.prepare('SELECT location, time, local_path, status FROM scenes WHERE episode_id = ? ORDER BY id').all(ep2Id);
    assert.deepEqual(scenes, [
      { location: '卧室', time: '夜间', local_path: 'p/bedroom.png', status: 'generated' },
      { location: '教室', time: '白天', local_path: null, status: 'draft' },
    ]);
    const boards = t.db.prepare('SELECT dialogue, voice_snapshot FROM storyboards WHERE episode_id = ? ORDER BY storyboard_number').all(ep2Id);
    assert.equal(boards[0].dialogue, 'Diego：Nunca me rendiré, soy Diego.');
    assert.equal(JSON.parse(boards[0].voice_snapshot).characters[0].url, '/static/voices/diego.mp3');
    assert.equal(boards[1].voice_snapshot, null);
    const script = t.db.prepare('SELECT script_content FROM episodes WHERE id = ?').get(ep2Id).script_content;
    assert.match(script, /^Diego在墨西哥城的卧室里下定决心，第二天Señor Ruiz在教室点名。/);
    assert.doesNotMatch(script, /Carlos|林江|王老师/);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM storyboards WHERE episode_id = ?').get(episodes[0].id).n, 2, 'episode 1 keeps its shots');

    const recorded = metadataOf(t.db, dramaId).redraw_series;
    assert.deepEqual(Object.keys(recorded.characters).sort(), ['林哥', '林江', '王老师']);
    assert.equal(recorded.characters['林江'].character_id, diego.id);
    assert.deepEqual(recorded.episodes.map((item) => item.episode_number), [1, 2]);

    const again = await t.call(ep2, { action: 'import', localization: MX, target_drama_id: dramaId });
    assert.deepEqual([again.body.data.appended, again.body.data.episode_number], [false, 2], 'the same episode is not appended twice');
    const listed = await t.call(ep2, { action: 'status', localization: MX });
    assert.equal(listed.body.data.series_targets[0].this_work_episode, 2);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE drama_id = ? AND deleted_at IS NULL').get(dramaId).n, 2);
  } finally {
    cleanup(t);
  }
});

test('新角色补问后仍用前几集的名字：本集转绘失败并退回积分', async () => {
  const t = setup();
  try {
    await importFirstEpisode(t);
    const ep2 = seedEpisode(t, episodeTwoFacts(), '2026-09-29T02:00:00.000Z');
    t.replies.push(episodeTwoOutput({ c2: 'Mateo' }), {
      characters: [{ id: 'c2', name: 'mateo', appearance: '约45岁的墨西哥男教师' }],
    });
    const failed = await localize(t, ep2);
    assert.equal(failed.body.data.status, 'failed');
    assert.match(failed.body.data.error, /「Mateo」已被本剧前几集的其他角色使用/);
    assert.deepEqual([creditLedger.getTenantAccount(t.db, TENANT).spent, creditLedger.getTenantAccount(t.db, TENANT).held], [10, 0]);
  } finally {
    cleanup(t);
  }
});

test('R72 之前导入的第 1 集项目也能追加；错误目标、重名、已按旧版本导入都拒绝且不写入；删掉的那集可以重新追加', async () => {
  const t = setup();
  try {
    const { dramaId } = await importFirstEpisode(t);
    // 模拟 R72 之前的导入：没有全剧档案。
    const legacy = metadataOf(t.db, dramaId);
    delete legacy.redraw_series;
    t.db.prepare('UPDATE dramas SET metadata = ? WHERE id = ?').run(JSON.stringify(legacy), dramaId);

    const ep2 = seedEpisode(t, episodeTwoFacts(), '2026-09-29T02:00:00.000Z');
    t.replies.push(episodeTwoOutput());
    const ready = await localize(t, ep2);
    assert.equal(ready.body.data.status, 'ready');
    assert.deepEqual(ready.body.data.series_targets.map((item) => item.drama_id), [dramaId]);

    const now = new Date().toISOString();
    const otherSeries = Number(t.db.prepare(`INSERT INTO dramas (title, metadata, user_id, tenant_id, created_at, updated_at)
      VALUES ('别的剧', ?, ?, ?, ?, ?)`).run(JSON.stringify({ redraw_series: { project_id: t.project(), locale: 'es', market: 'MX', characters: {}, episodes: [] } }),
      USER, TENANT, now, now).lastInsertRowid);
    const otherMarket = Number(t.db.prepare(`INSERT INTO dramas (title, metadata, user_id, tenant_id, created_at, updated_at)
      VALUES ('西班牙版', ?, ?, ?, ?, ?)`).run(JSON.stringify({ redraw_series: { project_id: t.projectId, locale: 'es', market: 'ES', characters: {}, episodes: [] } }),
      USER, TENANT, now, now).lastInsertRowid);
    const someoneElse = Number(t.db.prepare(`INSERT INTO dramas (title, metadata, user_id, tenant_id, created_at, updated_at)
      VALUES ('别人的剧', ?, 'user-b', 'personal:user-b', ?, ?)`).run(JSON.stringify({ redraw_series: { project_id: t.projectId, locale: 'es', market: 'MX', characters: {}, episodes: [] } }),
      now, now).lastInsertRowid);
    for (const target of [otherSeries, otherMarket, someoneElse]) {
      const rejected = await t.call(ep2, { action: 'import', localization: MX, target_drama_id: target });
      assert.equal(rejected.statusCode, 409);
      assert.equal(rejected.body.error.code, 'REDRAW_SERIES_TARGET_INVALID');
    }
    const invalid = await t.call(ep2, { action: 'import', localization: MX, target_drama_id: 'abc' });
    assert.equal(invalid.statusCode, 400);

    // 工厂里有人手动建了同名角色：不能把新老师并进去。
    const clash = Number(t.db.prepare(`INSERT INTO characters (drama_id, name, created_at, updated_at) VALUES (?, 'Señor Ruiz', ?, ?)`)
      .run(dramaId, now, now).lastInsertRowid);
    const conflict = await t.call(ep2, { action: 'import', localization: MX, target_drama_id: dramaId });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.body.error.code, 'REDRAW_SERIES_NAME_CONFLICT');
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE drama_id = ?').get(dramaId).n, 1, 'nothing written');
    assert.equal(metadataOf(t.db, dramaId).redraw_series, undefined);
    t.db.prepare('UPDATE characters SET deleted_at = ? WHERE id = ?').run(now, clash);

    const appended = await t.call(ep2, { action: 'import', localization: MX, target_drama_id: dramaId });
    assert.equal(appended.statusCode, 200, JSON.stringify(appended.body));
    assert.deepEqual([appended.body.data.episode_number, appended.body.data.reused_character_names], [2, ['Diego']]);
    const recorded = metadataOf(t.db, dramaId).redraw_series;
    assert.deepEqual(recorded.episodes.map((item) => [item.episode_number, item.work_id]).map(([n]) => n), [1, 2]);
    assert.deepEqual(Object.keys(recorded.characters).sort(), ['林哥', '林江', '王老师']);

    // 那一集在工厂里被删掉后可以重新追加，档案里只留新的一条。
    t.db.prepare('UPDATE episodes SET deleted_at = ? WHERE drama_id = ? AND episode_number = 2').run(now, dramaId);
    const reappended = await t.call(ep2, { action: 'import', localization: MX, target_drama_id: dramaId });
    assert.deepEqual([reappended.body.data.appended, reappended.body.data.episode_number], [true, 2]);
    assert.deepEqual(reappended.body.data.new_character_names, [], 'the teacher from the deleted episode is reused');
    assert.equal(metadataOf(t.db, dramaId).redraw_series.episodes.filter((item) => item.work_id === ep2).length, 1);

    // 本集又有了新的完全转绘版本：已在项目里的那集不重复追加。
    const version = t.db.prepare('SELECT * FROM redraw_versions WHERE id = ?').get(reappended.body.data.import_key.match(/version:(\d+)/)[1]);
    const columns = Object.keys(version).filter((key) => !['id', 'version'].includes(key));
    t.db.prepare(`INSERT INTO redraw_versions (${columns.join(', ')}, version) VALUES (${columns.map(() => '?').join(', ')}, 99)`)
      .run(...columns.map((key) => version[key]));
    const stale = await t.call(ep2, { action: 'import', localization: MX, target_drama_id: dramaId });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.body.error.code, 'REDRAW_SERIES_EPISODE_EXISTS');
  } finally {
    cleanup(t);
  }
});

test('追加的集复制新角色图时不覆盖项目里已有的同名文件', async () => {
  const t = setup();
  try {
    const { dramaId } = await importFirstEpisode(t);
    const ep2 = seedEpisode(t, episodeTwoFacts(), '2026-09-29T02:00:00.000Z');
    t.replies.push(episodeTwoOutput());
    const ready = await localize(t, ep2);
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(t.storageRoot, 'redraw-assets'), { recursive: true });
    fs.writeFileSync(path.join(t.storageRoot, 'redraw-assets/teacher.png'), 'new teacher');
    const assetId = Number(t.db.prepare(`INSERT INTO assets (name, type, url, local_path, created_at, updated_at)
      VALUES ('teacher.png', 'image', '/static/redraw-assets/teacher.png', 'redraw-assets/teacher.png', ?, ?)`).run(now, now).lastInsertRowid);
    t.db.prepare(`INSERT INTO redraw_assets (version_id, tenant_id, user_id, kind, source_ref_json, localized_name, localized_description,
      prompt, asset_id, version_number, approval_status, status, created_at, updated_at)
      VALUES (?, ?, ?, 'character', ?, 'Señor Ruiz', '', '', ?, 1, 'approved', 'generated', ?, ?)`)
      .run(ready.body.data.version_id, TENANT, USER, JSON.stringify({ source_ref: { source_character_key: 'c2' } }), assetId, now, now);
    const dir = `${storageLayout.getProjectStorageSubdir(t.db, dramaId)}/characters`;
    fs.mkdirSync(path.join(t.storageRoot, dir), { recursive: true });
    fs.writeFileSync(path.join(t.storageRoot, dir, 'redraw_ep2_c2_teacher.png'), 'someone else');

    const appended = await t.call(ep2, { action: 'import', localization: MX, target_drama_id: dramaId });
    assert.equal(appended.statusCode, 200, JSON.stringify(appended.body));
    const teacher = t.db.prepare("SELECT local_path FROM characters WHERE drama_id = ? AND name = 'Señor Ruiz'").get(dramaId);
    assert.equal(teacher.local_path, `${dir}/redraw_ep2_c2_2_teacher.png`);
    assert.equal(fs.readFileSync(path.join(t.storageRoot, teacher.local_path), 'utf8'), 'new teacher');
    assert.equal(fs.readFileSync(path.join(t.storageRoot, dir, 'redraw_ep2_c2_teacher.png'), 'utf8'), 'someone else');
  } finally {
    cleanup(t);
  }
});
