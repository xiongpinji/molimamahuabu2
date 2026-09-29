'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { buildRedrawFactoryPackage } = require('../src/services/redrawFactoryPackageAdapter');
const localization = require('../src/services/redrawFactoryLocalizationService');
const creditLedger = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const redrawRoutes = require('../src/routes/redraw');

const FACTS_HASH = 'b'.repeat(64);
const TENANT = 'personal:user-a';
const USER = 'user-a';
const MODEL = 'gpt-localize';

function factsV2() {
  return {
    schema_version: '2.0',
    v1_facts_hash: FACTS_HASH,
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
        text_regions: [{ id: 'txt1', kind: 'subtitle', source_text: '你谁啊', speaker_id: 'c1' }, { id: 'txt2', kind: 'sign', source_text: '小卖部' }],
        dialogue: [],
      },
      {
        id: 'shot-2', index: 2, start_ms: 4_000, end_ms: 8_000,
        composition: '林江在书桌前握着硬币', camera_movement: '缓推', opening_state: '他张开手',
        continuous_action: '他盯着硬币', ending_state: '他笑了',
        visible_character_ids: ['c1'],
        text_regions: [{ id: 'txt3', kind: 'subtitle', source_text: '世界杯就是我的起步资金' }],
        dialogue: [],
      },
    ],
    causal_chain: ['只有一枚硬币让缺钱变得具体。'],
    reversals: ['他意识到硬币就是全部家当。'],
    episode_hook: '他决定把世界杯当作起步资金。',
    locked_facts: ['林江只有一枚硬币。'],
  };
}

function modelOutput(overrides = {}) {
  return {
    characters: [
      { id: 'c1', name: 'Diego', appearance: '约17岁的墨西哥少年，偏瘦，浅棕色皮肤，黑色短卷发，墨西哥公立高中校服' },
      { id: 'c2', name: 'Mateo', appearance: '约17岁的墨西哥少年，壮实，古铜色皮肤，白色校服衬衫' },
    ],
    scenes: [
      { id: 's1', location: '街角小卖部门口', visual: '墨西哥城街角的彩色小卖部，西班牙语招牌' },
      { id: 's2', location: '卧室', visual: '墨西哥普通家庭卧室，木书桌与旧电脑' },
    ],
    props: [{ id: 'p1', name: '一枚比索硬币' }],
    lines: [
      { key: 'shot-1:txt1', text: '¿Y tú quién eres?' },
      { key: 'shot-2:txt3', text: 'El Mundial será mi capital inicial.' },
    ],
    screen_texts: [{ key: 'shot-1:txt2', text: 'Abarrotes' }],
    story: ['Diego在墨西哥城街角小卖部被同学嘲笑后，发现口袋里只剩一枚比索硬币。'],
    episode_hook: 'Diego决定把世界杯当作起步资金。',
    setting: '故事发生在墨西哥城，所有人物都是墨西哥人。',
    ...overrides,
  };
}

const TARGET = localization.describeTarget('es', 'MX');

test('adapter turns a full localization into target-country names, looks, places, dialogue and setting', () => {
  const output = localization.validateOutput(TARGET, localization.compactFacts(factsV2()), modelOutput());
  const pkg = buildRedrawFactoryPackage({
    sourceFacts: factsV2(),
    localization: { locale: 'es', market: 'MX', name_map: output.nameMap, text_map: output.textMap, glossary: {}, culture_map: output.cultureMap },
    analysisSettings: { free_style: { positive: '真人写实风格', negative: '' } },
  });
  assert.deepEqual(pkg.characters.map((c) => c.name), ['Diego', 'Mateo']);
  assert.match(pkg.characters[0].appearance, /墨西哥少年/);
  assert.match(pkg.characters[0].description, /Mateo 的朋友/, 'old ids and names become the new names');
  assert.equal(pkg.scenes[0].location, '街角小卖部门口');
  assert.match(pkg.scenes[0].prompt, /故事发生在墨西哥城，所有人物都是墨西哥人。 街角小卖部门口，白天。 墨西哥城街角/);
  assert.equal(pkg.props[0].name, '一枚比索硬币');
  assert.deepEqual(
    pkg.episodes[0].scenes.map((group) => group.location),
    ['街角小卖部门口', '卧室'],
    'storyboard groups show the localized place, not the source one',
  );
  const [first, second] = pkg.episodes[0].scenes.flatMap((group) => group.shots);
  assert.equal(first.dialogue, 'Diego：¿Y tú quién eres?');
  assert.match(first.description, /画面文字：「Abarrotes」/);
  assert.match(first.description, /Diego的近景/);
  assert.match(first.video_prompt, /故事发生在墨西哥城/);
  assert.match(first.video_prompt, /台词全部用西班牙语，墨西哥口音说出：Diego：¿Y tú quién eres\? 画面中不要出现字幕。$/);
  assert.match(first.image_prompt, /角色：Diego、Mateo。 画面中不要出现字幕。$/);
  assert.equal(second.dialogue, 'El Mundial será mi capital inicial.');
  assert.match(second.video_prompt, /说出：El Mundial será mi capital inicial\. 画面中不要出现字幕。$/);
  for (const field of [first.description, first.action, first.video_prompt, pkg.characters[0].description]) {
    assert.doesNotMatch(field, /林江|林哥/, field);
  }
});

test('lines without a speaker take it from the on-screen dialogue of the shot, and the first solo shot of each speaker is marked for voice casting', () => {
  const facts = factsV2();
  facts.shots[1].dialogue = [{ id: 'd1', speaker_id: 'c1', source_text: '世界杯就是我的起步资金', start_ms: 4_100, end_ms: 5_000 }];
  // 镜头 1 里另有一句画外台词（别人喊他的名字），分析没有对应的画面内对白条目。
  facts.shots[0].text_regions.push({ id: 'txt5', kind: 'subtitle', source_text: '林江，你还装傻？' });
  facts.shots[0].dialogue = [{ id: 'd0', speaker_id: 'c1', source_text: '你谁啊', start_ms: 100, end_ms: 900 }];
  facts.shots.push({
    id: 'shot-3', index: 3, start_ms: 8_000, end_ms: 9_000, composition: '林哥的近景', camera_movement: '固定',
    opening_state: '', continuous_action: '', ending_state: '', visible_character_ids: ['c2'],
    text_regions: [{ id: 'txt4', kind: 'subtitle', source_text: '回家吃饭' }], dialogue: [],
  });
  const output = localization.validateOutput(TARGET, localization.compactFacts(facts), modelOutput({
    lines: [...modelOutput().lines, { key: 'shot-3:txt4', text: 'Vamos a comer.' }, { key: 'shot-1:txt5', text: 'Diego, ¿te haces el loco?' }],
  }));
  const pkg = buildRedrawFactoryPackage({
    sourceFacts: facts,
    localization: { locale: 'es', market: 'MX', name_map: output.nameMap, text_map: output.textMap, glossary: {}, culture_map: output.cultureMap },
    analysisSettings: { free_style: { positive: '真人写实风格', negative: '' } },
  });
  const [first, second, third] = pkg.episodes[0].scenes.flatMap((group) => group.shots);
  assert.equal(second.dialogue, 'Diego：El Mundial será mi capital inicial.', 'the on-screen dialogue turn names the speaker');
  assert.equal(third.dialogue, 'Vamos a comer.', 'an off-screen line with no dialogue turn stays unlabeled');
  assert.equal(first.dialogue, 'Diego：¿Y tú quién eres?\nDiego, ¿te haces el loco?', 'an off-screen line in the same shot is not given to the on-screen speaker');
  assert.equal(first.title, '镜头 1', 'a shot with an unlabeled line cannot cast a voice');
  assert.equal(second.title, '镜头 2 · Diego 定音');
  assert.equal(third.title, '镜头 3');
  assert.deepEqual(pkg.voice_casting, [{ character_id: 'c1', name: 'Diego', shot_number: 2 }]);
});

test('shot text drops burned-in subtitle descriptions so the video model does not draw subtitles', () => {
  const facts = factsV2();
  facts.shots[0].composition = 'tight close-up of c1 in a school uniform; burned-in subtitles remain at the lower part of the frame';
  facts.shots[0].continuous_action = 'c1 points and speaks toward someone off-camera, subtitles appear below. He steps back.';
  facts.shots[0].ending_state = '字幕消失，林江皱眉';
  const output = localization.validateOutput(TARGET, localization.compactFacts(facts), modelOutput());
  const pkg = buildRedrawFactoryPackage({
    sourceFacts: facts,
    localization: { locale: 'es', market: 'MX', name_map: output.nameMap, text_map: output.textMap, glossary: {}, culture_map: output.cultureMap },
    analysisSettings: { free_style: { positive: '真人写实风格', negative: '' } },
  });
  const [first] = pkg.episodes[0].scenes.flatMap((group) => group.shots);
  assert.match(first.description, /^tight close-up of Diego in a school uniform\. 画面文字/);
  assert.match(first.action, /Diego points and speaks toward someone off-camera\. He steps back\./);
  assert.equal(first.continuity.ending_state, 'Diego皱眉');
  const body = first.video_prompt.replace(/画面中不要出现字幕。/g, '');
  assert.doesNotMatch(body, /subtitle|字幕/i, first.video_prompt);
});

test('the source-language import speaks the original lines without naming a language', () => {
  const pkg = buildRedrawFactoryPackage({ sourceFacts: factsV2(), analysisSettings: { free_style: { positive: '真人写实风格', negative: '' } } });
  const [first] = pkg.episodes[0].scenes.flatMap((group) => group.shots);
  assert.match(first.video_prompt, /台词：林江：你谁啊。 画面中不要出现字幕。$/);
});

test('localized looks, places and roles are used as written, without swapping ordinary words for names', () => {
  const facts = factsV2();
  facts.characters.push({ id: 'c3', source_name: '父亲', relationship: '主角的父亲', relationships: [], appearance: '中年男人' });
  facts.scenes[0].time = 'daytime';
  const compact = localization.compactFacts(facts);
  const output = localization.validateOutput(TARGET, compact, modelOutput({
    characters: [
      { id: 'c1', name: 'Diego', role: '被同学嘲笑的主角', appearance: '墨西哥少年，和父亲一样的浓眉' },
      { id: 'c2', name: 'Mateo', role: 'Diego 的同学', appearance: '墨西哥少年' },
      { id: 'c3', name: 'Papá', role: 'Diego 的父亲', appearance: '四十多岁的墨西哥工薪父亲' },
    ],
    scenes: [
      { id: 's1', location: '街角小卖部门口', time: '白天', visual: '墨西哥城街角' },
      { id: 's2', location: '卧室', time: '夜间', visual: '墨西哥家庭卧室' },
    ],
  }));
  const pkg = buildRedrawFactoryPackage({
    sourceFacts: facts,
    localization: { locale: 'es', market: 'MX', name_map: output.nameMap, text_map: output.textMap, glossary: {}, culture_map: output.cultureMap },
    analysisSettings: {},
  });
  const papa = pkg.characters.find((c) => c.character_id === 'c3');
  assert.equal(papa.appearance, '四十多岁的墨西哥工薪父亲', 'the word 父亲 stays a word');
  assert.equal(papa.role, 'Diego 的父亲');
  assert.equal(pkg.characters[0].appearance, '墨西哥少年，和父亲一样的浓眉');
  assert.equal(pkg.characters[0].description, '被同学嘲笑的主角');
  assert.equal(pkg.scenes[0].time, '白天');
  assert.match(pkg.scenes[0].prompt, /街角小卖部门口，白天/);
});

test('localization output must cover every character and line in the target language', () => {
  const compact = localization.compactFacts(factsV2());
  assert.throws(() => localization.validateOutput(TARGET, compact, modelOutput({
    characters: [{ id: 'c1', name: '林江', appearance: 'x' }, { id: 'c2', name: 'Mateo', appearance: 'y' }],
  })), /c1 缺少目标语言名字/);
  assert.throws(() => localization.validateOutput(TARGET, compact, modelOutput({ lines: [{ key: 'shot-1:txt1', text: '你谁啊' }] })), /台词/);
  assert.throws(() => localization.validateOutput(TARGET, compact, modelOutput({ setting: '' })), /国家设定/);
  const japanese = localization.describeTarget('ja', 'JP');
  const out = localization.validateOutput(japanese, compact, modelOutput({
    characters: [{ id: 'c1', name: '大翔', appearance: 'a' }, { id: 'c2', name: '蓮', appearance: 'b' }],
    lines: [{ key: 'shot-1:txt1', text: 'お前誰だよ' }, { key: 'shot-2:txt3', text: 'ワールドカップが元手だ' }],
  }));
  assert.equal(out.nameMap.c1, '大翔', 'kanji names are allowed for Japanese');
  assert.match(localization.buildPrompt(TARGET, compact).system, /Mexico/);
});

test('the localized plot must exist and must not keep any old name, including the analysed pinyin name', () => {
  const facts = factsV2();
  facts.characters[0].display_name = 'Lin Jiang';
  const compact = localization.compactFacts(facts);
  assert.equal(compact.characters[0].display_name, 'Lin Jiang');
  assert.equal(compact.episode_hook, '他决定把世界杯当作起步资金。');
  assert.throws(() => localization.validateOutput(TARGET, compact, modelOutput({ story: [] })), /剧情梗概/);
  assert.throws(
    () => localization.validateOutput(TARGET, compact, modelOutput({ story: ['同学们在小卖部门口认出了 Lin Jiang。'] })),
    /原片人名「Lin Jiang」/,
  );
  assert.throws(
    () => localization.validateOutput(TARGET, compact, modelOutput({ story: ['林江被嘲笑。'] })),
    /原片人名「林江」/,
  );
  const out = localization.validateOutput(TARGET, compact, modelOutput({ episode_hook: '林江决定……' }));
  assert.deepEqual(out.cultureMap.story, ['Diego在墨西哥城街角小卖部被同学嘲笑后，发现口袋里只剩一枚比索硬币。']);
  assert.equal(out.cultureMap.episode_hook, undefined, 'a hook that keeps an old name is dropped');
});

test('role and group labels become capitalized names; scripts without letter case are left as they are', () => {
  const compact = localization.compactFacts(factsV2());
  const out = localization.validateOutput(TARGET, compact, modelOutput({
    characters: [{ id: 'c1', name: 'mamá', appearance: 'a' }, { id: 'c2', name: 'compañeros', appearance: 'b' }],
  }));
  assert.deepEqual([out.nameMap.c1, out.nameMap.c2], ['Mamá', 'Compañeros']);
  const japanese = localization.validateOutput(localization.describeTarget('ja', 'JP'), compact, modelOutput({
    characters: [{ id: 'c1', name: 'お母さん', appearance: 'a' }, { id: 'c2', name: '蓮', appearance: 'b' }],
    lines: [{ key: 'shot-1:txt1', text: 'お前誰だよ' }, { key: 'shot-2:txt3', text: 'ワールドカップが元手だ' }],
  }));
  assert.deepEqual([japanese.nameMap.c1, japanese.nameMap.c2], ['お母さん', '蓮']);
  const { system } = localization.buildPrompt(TARGET, compact);
  assert.match(system, /capitalize them the way a name is written/);
  assert.match(system, /never a word-by-word translation of the source wording/);
});

test('the plot and episode hook must be written in Chinese; a plot in the target language is asked for again, then fails and refunds', async () => {
  const compact = localization.compactFacts(factsV2());
  const spanish = 'En la entrada del pequeño comercio, Diego enfrenta a otro estudiante y lo señala.';
  assert.throws(() => localization.validateOutput(TARGET, compact, modelOutput({ story: [spanish] })), /剧情梗概没有用简体中文写/);
  const mixed = localization.validateOutput(TARGET, compact, modelOutput({
    story: ['Diego和Mateo在墨西哥城的中学小卖部门口起了争执，Compañeros围过来看热闹。'],
    episode_hook: 'Diego decide que el Mundial será su capital inicial.',
  }));
  assert.equal(mixed.cultureMap.story.length, 1, 'Chinese text with target-language names is accepted');
  assert.equal(mixed.cultureMap.episode_hook, undefined, 'a hook in the target language is dropped');
  assert.match(localization.buildPrompt(TARGET, compact).system, /written in Simplified Chinese \(not in Spanish/);

  const calls = [];
  const { db, storageRoot, call, settle } = setup(async (_db, _log, _type, user) => {
    calls.push(user);
    return JSON.stringify(calls.length === 1 ? modelOutput({ story: [spanish] }) : { story: [spanish] });
  });
  try {
    await call({ action: 'start', localization: { locale: 'es', market: 'MX' }, expected_credits: 10 });
    await settle();
    assert.equal(calls.length, 2, 'a Spanish plot is asked for once more');
    assert.equal(JSON.parse(calls[1]).need_story, true);
    const status = await call({ action: 'status', localization: { locale: 'es', market: 'MX' } });
    assert.equal(status.body.data.status, 'failed');
    assert.match(status.body.data.error, /剧情梗概没有用简体中文写/);
    assert.deepEqual([creditLedger.getTenantAccount(db, TENANT).available, creditLedger.getTenantAccount(db, TENANT).held], [1000, 0]);
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('a plot that keeps an old name or talks about subtitles is asked for once more without charging again', async () => {
  const calls = [];
  const { db, storageRoot, call, settle } = setup(async (_db, _log, _type, user, system) => {
    calls.push({ user, system });
    if (calls.length === 1) return JSON.stringify(modelOutput({ story: ['字幕显示林江只剩一枚硬币。'] }));
    return JSON.stringify({ story: ['Diego发现自己只剩一枚比索硬币。'], episode_hook: 'Diego决定把世界杯当作起步资金。' });
  });
  try {
    await call({ action: 'start', localization: { locale: 'es', market: 'MX' }, expected_credits: 10 });
    await settle();
    assert.equal(calls.length, 2);
    const repair = JSON.parse(calls[1].user);
    assert.equal(repair.need_story, true);
    assert.deepEqual(repair.all_characters.map((c) => c.id), ['c1', 'c2']);
    assert.equal((await call({ action: 'status', localization: { locale: 'es', market: 'MX' } })).body.data.status, 'ready');
    assert.equal(creditLedger.getTenantAccount(db, TENANT).spent, 10, 'the repair call is not charged');
    const imported = await call({ action: 'import', localization: { locale: 'es', market: 'MX' } });
    const episode = db.prepare('SELECT script_content FROM episodes WHERE drama_id = ?').get(imported.body.data.drama_id);
    assert.match(episode.script_content, /^Diego发现自己只剩一枚比索硬币。/);
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('a localization made before the plot was localized is not ready and can be generated again', async () => {
  const { db, storageRoot, workId, call, settle } = setup(async () => JSON.stringify(modelOutput()));
  try {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO redraw_versions (work_id, tenant_id, user_id, version, locale, market, localization_level,
      name_map_json, text_map_json, glossary_json, culture_map_json, localization_model_snapshot_json, facts_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, 2, 'es', 'MX', 'full', '{}', '{}', '{}', '{}', ?, ?, 'asset_review', ?, ?)`)
      .run(workId, TENANT, USER, JSON.stringify({ kind: localization.KIND, model: MODEL, target: 'es-MX' }), FACTS_HASH, now, now);
    const status = await call({ action: 'status', localization: { locale: 'es', market: 'MX' } });
    assert.deepEqual([status.body.data.status, status.body.data.credits], ['none', 10]);
    await call({ action: 'start', localization: { locale: 'es', market: 'MX' }, expected_credits: 10 });
    await settle();
    const ready = await call({ action: 'status', localization: { locale: 'es', market: 'MX' } });
    assert.equal(ready.body.data.status, 'ready');
    const snapshot = JSON.parse(db.prepare('SELECT localization_model_snapshot_json FROM redraw_versions WHERE id = ?').get(ready.body.data.version_id).localization_model_snapshot_json);
    assert.equal(snapshot.schema, 4);
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

function createDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  return db;
}

function seedCapability(db, { locale = 'es', market = '' } = {}) {
  db.prepare(`INSERT INTO ai_service_configs (service_type, model, default_model, settings, is_active, is_default, priority)
    VALUES ('text', ?, ?, ?, 1, 1, 10)`).run(MODEL, MODEL, JSON.stringify({
    redraw_locale_capabilities: [{
      status: 'verified', locale, market,
      evidence: { text: { provider: 'verified-provider', model: MODEL, task_id: 't', terminal_status: 'completed', artifact_id: 'cap-artifact' } },
    }],
  }));
  prices.set(db, MODEL, 10);
}

function seedWork(db, storageRoot) {
  const now = new Date().toISOString();
  const projectId = Number(db.prepare(`INSERT INTO redraw_projects (tenant_id, user_id, title, default_locale, default_market,
    localization_level, status, created_at, updated_at) VALUES (?, ?, '样片', 'es', '', 'faithful', 'draft', ?, ?)`)
    .run(TENANT, USER, now, now).lastInsertRowid);
  const taskId = `task-${projectId}`;
  const sourceAssetId = Number(db.prepare(`INSERT INTO assets (name, type, url, local_path, created_at, updated_at)
    VALUES ('sample.mp4', 'video', '/static/s.mp4', 'redraw-sources/s.mp4', ?, ?)`).run(now, now).lastInsertRowid);
  const workId = Number(db.prepare(`INSERT INTO redraw_works (project_id, tenant_id, user_id, title, source_asset_id,
    source_fingerprint, duration_ms, current_version, current_step, status, task_id, created_at, updated_at)
    VALUES (?, ?, ?, 'sample.mp4', ?, ?, 20000, 1, 2, 'asset_review', ?, ?, ?)`)
    .run(projectId, TENANT, USER, sourceAssetId, 'f'.repeat(64), taskId, now, now).lastInsertRowid);
  const rel = `redraw-analysis/${taskId}/source-analysis.json`;
  fs.mkdirSync(path.dirname(path.join(storageRoot, rel)), { recursive: true });
  fs.writeFileSync(path.join(storageRoot, rel), JSON.stringify({ schema_version: '2.0', facts: { facts_hash: FACTS_HASH }, facts_v2: factsV2() }));
  const resultAssetId = Number(db.prepare(`INSERT INTO assets (name, type, category, local_path, metadata, created_at, updated_at)
    VALUES ('analysis', 'json', 'redraw_source_analysis', ?, ?, ?, ?)`)
    .run(rel, JSON.stringify({ tenant_id: TENANT, user_id: USER, work_id: workId }), now, now).lastInsertRowid);
  db.prepare(`INSERT INTO async_tasks (id, type, status, progress, resource_id, tenant_id, user_id, metadata, result, created_at, updated_at)
    VALUES (?, 'redraw_analysis', 'completed', 100, ?, ?, ?, ?, ?, ?, ?)`)
    .run(taskId, String(workId), TENANT, USER, JSON.stringify({ redraw_analysis: { locale: 'es', market: '', free_style: { positive: '真人写实', negative: '' } } }),
      JSON.stringify({ status: 'completed', result_asset_id: resultAssetId, facts_hash: FACTS_HASH }), now, now);
  db.prepare(`INSERT INTO redraw_versions (work_id, tenant_id, user_id, version, locale, market, localization_level,
    source_facts_json, facts_hash, status, created_at, updated_at) VALUES (?, ?, ?, 1, 'source', '', 'faithful', ?, ?, 'asset_review', ?, ?)`)
    // main 分支把 v2 源片事实直接存在 source 版本里。
    .run(workId, TENANT, USER, JSON.stringify(factsV2()), FACTS_HASH, now, now);
  return workId;
}

function captureResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function setup(generate) {
  const db = createDb();
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-factory-l10n-'));
  seedCapability(db);
  creditLedger.setTenantAccountBalance(db, TENANT, 1000);
  const workId = seedWork(db, storageRoot);
  let pending = null;
  const handlers = redrawRoutes(db, { error() {}, info() {}, warn() {} }, {
    cfg: { storage: { local_path: storageRoot } },
    canReadArtifact: (id) => id === 'cap-artifact' || Number.isFinite(Number(id)),
    factoryLocalizationSchedule: (job) => { pending = Promise.resolve().then(job); return pending; },
    factoryLocalizationGenerateText: generate,
  });
  const call = async (body) => {
    const res = captureResponse();
    await handlers.importToFactory({ params: { id: String(workId) }, tenant: { id: TENANT }, user: { id: USER }, body }, res);
    return res;
  };
  return { db, storageRoot, workId, call, settle: () => pending };
}

test('route lists targets, quotes, charges once, imports a Mexican Spanish project and keeps the source import', async () => {
  let prompt = null;
  const { db, storageRoot, call, settle } = setup(async (_db, _log, _type, user, system) => {
    prompt = { user, system };
    return JSON.stringify(modelOutput());
  });
  try {
    const targets = await call({ action: 'targets' });
    assert.equal(targets.statusCode, 200);
    const mx = targets.body.data.targets.find((item) => item.key === 'es-MX');
    assert.equal(mx.label, '西班牙语（墨西哥）');
    assert.ok(targets.body.data.targets.some((item) => item.key === 'es-ES'), 'language-level capability offers several countries');

    const status = await call({ action: 'status', localization: { locale: 'es', market: 'MX' } });
    assert.deepEqual([status.body.data.status, status.body.data.credits], ['none', 10]);

    const wrongPrice = await call({ action: 'start', localization: { locale: 'es', market: 'MX' }, expected_credits: 5 });
    assert.equal(wrongPrice.statusCode, 409);
    assert.equal(creditLedger.getTenantAccount(db, TENANT).held, 0);

    const importTooEarly = await call({ action: 'import', localization: { locale: 'es', market: 'MX' } });
    assert.equal(importTooEarly.statusCode, 409);

    const started = await call({ action: 'start', localization: { locale: 'es', market: 'MX' }, expected_credits: 10 });
    assert.equal(started.statusCode, 202);
    assert.equal(started.body.data.status, 'localizing');
    await settle();
    assert.match(prompt.system, /Mexico/);
    assert.match(prompt.user, /你谁啊/);

    const ready = await call({ action: 'status', localization: { locale: 'es', market: 'MX' } });
    assert.equal(ready.body.data.status, 'ready');
    assert.deepEqual([creditLedger.getTenantAccount(db, TENANT).spent, creditLedger.getTenantAccount(db, TENANT).held], [10, 0]);
    const again = await call({ action: 'start', localization: { locale: 'es', market: 'MX' }, expected_credits: 10 });
    assert.equal(again.body.data.status, 'ready', 'a finished localization is not charged again');
    assert.equal(creditLedger.getTenantAccount(db, TENANT).spent, 10);

    const imported = await call({ action: 'import', localization: { locale: 'es', market: 'MX' } });
    assert.equal(imported.statusCode, 200);
    const dramaId = imported.body.data.drama_id;
    const names = db.prepare('SELECT name FROM characters WHERE drama_id = ? ORDER BY id').all(dramaId).map((row) => row.name);
    assert.deepEqual(names, ['Diego', 'Mateo']);
    const storyboards = db.prepare(`SELECT s.dialogue, s.video_prompt FROM storyboards s JOIN episodes e ON e.id = s.episode_id
      WHERE e.drama_id = ? ORDER BY s.storyboard_number`).all(dramaId);
    assert.equal(storyboards[0].dialogue, 'Diego：¿Y tú quién eres?');
    assert.match(storyboards[0].video_prompt, /墨西哥/);
    assert.match(storyboards[0].video_prompt, /台词全部用西班牙语，墨西哥口音说出：Diego：¿Y tú quién eres\?/);
    const metadata = JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id = ?').get(dramaId).metadata);
    assert.deepEqual([metadata.redraw_import.locale, metadata.redraw_import.market], ['es', 'MX']);
    assert.equal(metadata.video_use_storyboard_reference_video, false, 'source clips carry the original actors and subtitles');
    assert.equal(metadata.redraw_import.full_localization_package, 6);
    assert.match(metadata.redraw_import.import_key, /:package:6$/);
    assert.equal(metadata.voice_auto_bind, true, 'redraw imports turn on first-dialogue voice reuse');
    assert.deepEqual(metadata.redraw_import.voice_casting, [{ character_id: 'c1', name: 'Diego', shot_number: 1 }]);
    const episode = db.prepare('SELECT script_content, description FROM episodes WHERE drama_id = ?').get(dramaId);
    assert.match(episode.script_content, /^Diego在墨西哥城街角小卖部被同学嘲笑/, 'the episode script opens with the localized plot');
    assert.doesNotMatch(episode.script_content, /林江|林哥/);
    assert.equal(episode.description, 'Diego决定把世界杯当作起步资金。');

    const plain = await call({});
    assert.equal(plain.statusCode, 200);
    assert.notEqual(plain.body.data.drama_id, dramaId, 'the source-language import stays a separate project');
    const plainMetadata = JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id = ?').get(plain.body.data.drama_id).metadata);
    assert.equal(plainMetadata.video_use_storyboard_reference_video, true, 'the plain redraw import keeps the source clip reference');
    assert.doesNotMatch(plainMetadata.redraw_import.import_key, /:package:/);
    const plainNames = db.prepare('SELECT name FROM characters WHERE drama_id = ? ORDER BY id').all(plain.body.data.drama_id).map((row) => row.name);
    assert.deepEqual(plainNames, ['林江', '林哥']);
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('a localization that is not in the target language fails and refunds', async () => {
  const { db, storageRoot, call, settle } = setup(async () => JSON.stringify(modelOutput({
    characters: [{ id: 'c1', name: '林江', appearance: 'x' }, { id: 'c2', name: 'Mateo', appearance: 'y' }],
  })));
  try {
    await call({ action: 'start', localization: { locale: 'es', market: 'MX' }, expected_credits: 10 });
    await settle();
    const status = await call({ action: 'status', localization: { locale: 'es', market: 'MX' } });
    assert.equal(status.body.data.status, 'failed');
    assert.match(status.body.data.error, /c1 缺少目标语言名字/);
    assert.deepEqual([creditLedger.getTenantAccount(db, TENANT).available, creditLedger.getTenantAccount(db, TENANT).held], [1000, 0]);
    const unsupported = await call({ action: 'status', localization: { locale: 'fr', market: 'FR' } });
    assert.equal(unsupported.statusCode, 400);
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('items the model leaves out are asked for once more without charging again', async () => {
  const calls = [];
  const { db, storageRoot, call, settle } = setup(async (_db, _log, _type, user, system) => {
    calls.push({ user, system });
    if (calls.length === 1) {
      return JSON.stringify(modelOutput({ characters: [modelOutput().characters[0]], lines: [modelOutput().lines[0]] }));
    }
    return JSON.stringify({ characters: [modelOutput().characters[1]], lines: [modelOutput().lines[1]] });
  });
  try {
    await call({ action: 'start', localization: { locale: 'es', market: 'MX' }, expected_credits: 10 });
    await settle();
    assert.equal(calls.length, 2);
    assert.match(calls[1].system, /left out or broke the items below/);
    assert.deepEqual(JSON.parse(calls[1].user).characters.map((c) => c.id), ['c2']);
    assert.deepEqual(JSON.parse(calls[1].user).subtitles.map((s) => s.key), ['shot-2:txt3']);
    const status = await call({ action: 'status', localization: { locale: 'es', market: 'MX' } });
    assert.equal(status.body.data.status, 'ready');
    assert.equal(creditLedger.getTenantAccount(db, TENANT).spent, 10, 'the repair call is not charged');
    const imported = await call({ action: 'import', localization: { locale: 'es', market: 'MX' } });
    const names = db.prepare('SELECT name FROM characters WHERE drama_id = ? ORDER BY id').all(imported.body.data.drama_id).map((row) => row.name);
    assert.deepEqual(names, ['Diego', 'Mateo']);
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('a running localization is reported by status and a second click does not start or charge again', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { db, storageRoot, call, settle } = setup(async () => {
    await gate;
    return JSON.stringify(modelOutput());
  });
  try {
    const started = await call({ action: 'start', localization: { locale: 'es', market: 'MX' }, expected_credits: 10 });
    const inFlight = await call({ action: 'status', localization: { locale: 'es', market: 'MX' } });
    assert.equal(inFlight.body.data.status, 'localizing');
    assert.equal(inFlight.body.data.task_id, started.body.data.task_id);
    const duplicate = await call({ action: 'start', localization: { locale: 'es', market: 'MX' }, expected_credits: 10 });
    assert.equal(duplicate.body.data.task_id, started.body.data.task_id);
    assert.equal(creditLedger.getTenantAccount(db, TENANT).held, 10);
    release();
    await settle();
    assert.equal((await call({ action: 'status', localization: { locale: 'es', market: 'MX' } })).body.data.status, 'ready');
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('English words or unknown person names in scenes and props are asked for once more; quoted signs and character names are fine', async () => {
  const calls = [];
  const { db, storageRoot, call, settle } = setup(async (_db, _log, _type, user, system) => {
    calls.push({ user: JSON.parse(user), system });
    if (calls.length === 1) {
      return JSON.stringify(modelOutput({
        scenes: [
          { id: 's1', location: '街角小卖部门口', visual: '墨西哥城街角的彩色小卖部，招牌写着“Abarrotes Doña Lupe”，Diego常在门口停留' },
          { id: 's2', location: '卧室', visual: '墨西哥普通家庭卧室 surrounded by 旧书架' },
        ],
        props: [{ id: 'p1', name: 'Rogelio手中的一枚比索硬币' }],
      }));
    }
    return JSON.stringify({
      scenes: [{ id: 's2', location: '卧室', visual: '墨西哥普通家庭卧室，四周是旧书架' }],
      props: [{ id: 'p1', name: 'Diego手中的一枚比索硬币' }],
    });
  });
  try {
    await call({ action: 'start', localization: { locale: 'es', market: 'MX' }, expected_credits: 10 });
    await settle();
    assert.equal(calls.length, 2);
    assert.match(calls[0].system, /put any sign or on-screen wording inside quotation marks/);
    assert.deepEqual(calls[1].user.scenes.map((scene) => scene.id), ['s2'], 'a quoted sign and a character name are not flagged');
    assert.deepEqual(calls[1].user.props.map((prop) => prop.id), ['p1']);
    assert.deepEqual(calls[1].user.character_names.map((item) => item.name), ['Diego', 'Mateo']);
    assert.match(calls[1].system, /contained English words or names of people who are not characters/);
    const status = await call({ action: 'status', localization: { locale: 'es', market: 'MX' } });
    assert.equal(status.body.data.status, 'ready');
    assert.equal(creditLedger.getTenantAccount(db, TENANT).spent, 10, 'the repair call is not charged');
    const culture = JSON.parse(db.prepare('SELECT culture_map_json FROM redraw_versions WHERE id = ?').get(status.body.data.version_id).culture_map_json);
    assert.equal(culture.scenes.s2.visual, '墨西哥普通家庭卧室，四周是旧书架');
    assert.equal(culture.scenes.s1.visual, '墨西哥城街角的彩色小卖部，招牌写着“Abarrotes Doña Lupe”，Diego常在门口停留');
    assert.equal(culture.props.p1.name, 'Diego手中的一枚比索硬币');
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});
