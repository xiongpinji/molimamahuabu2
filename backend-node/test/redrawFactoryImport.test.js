'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { buildRedrawFactoryPackage, isKeyProp } = require('../src/services/redrawFactoryPackageAdapter');
const { importRedrawWorkToFactory } = require('../src/services/redrawFactoryImportService');

const FACTS_HASH = 'a'.repeat(64);
const TENANT = 'personal:user-a';
const USER = 'user-a';

function sourceFacts() {
  return {
    schema_version: '2.0',
    facts_hash: FACTS_HASH,
    duration_ms: 8_000,
    story: ['Lin Jiang is mocked and then finds a coin.'],
    characters: [
      { id: 'c1', source_name: '林江', display_name: 'Lin Jiang', relationship: 'Protagonist', relationships: ['Friend of c2'] },
      { id: 'c2', source_name: '陈子昂', display_name: "Chen Zi'ang", relationship: 'Friend', relationships: [] },
    ],
    scenes: [
      { id: 's1', location: 'Street', time: 'Day', source_ranges: [{ start_ms: 0, end_ms: 4_000 }] },
      { id: 's2', location: 'Bedroom', time: 'Night', source_ranges: [{ start_ms: 4_000, end_ms: 8_000 }] },
    ],
    props: [
      { id: 'p1', name: 'Single coin held by Lin Jiang', evidence_ranges: [{ start_ms: 4_000, end_ms: 8_000 }] },
      { id: 'p2', name: 'Computer mouse', evidence_ranges: [{ start_ms: 4_000, end_ms: 8_000 }] },
      { id: 'p3', name: 'Drinking cups', evidence_ranges: [{ start_ms: 4_000, end_ms: 8_000 }] },
    ],
    shots: [
      {
        id: 'shot-1', index: 1, start_ms: 0, end_ms: 4_000,
        composition: 'Close-up of Lin Jiang in a school jacket.',
        camera_movement: 'Static.',
        opening_state: 'Lin Jiang looks up.', continuous_action: 'He speaks to Chen Zi\'ang.', ending_state: 'He frowns.',
        visible_character_ids: ['c1', 'c2'],
        text_regions: [{ id: 'txt1', kind: 'subtitle', source_text: '你谁啊' }],
        dialogue: [],
      },
      {
        id: 'shot-2', index: 2, start_ms: 4_000, end_ms: 8_000,
        composition: 'Lin Jiang at his desk holding a coin.',
        camera_movement: 'Slow push.',
        opening_state: 'He opens his hand.', continuous_action: 'He stares at the coin.', ending_state: 'He smiles.',
        visible_character_ids: ['c1'],
        text_regions: [],
        dialogue: [],
      },
    ],
    causal_chain: ['Finding only one coin makes the lack of capital concrete.'],
    reversals: [],
    episode_hook: 'He decides the World Cup will be his starting capital.',
    locked_facts: ['Lin Jiang holds one coin.'],
  };
}

function localization() {
  return {
    name_map: { c1: 'Ethan Brooks', c2: 'Noah Carter' },
    text_map: { 'shot-1:txt1': 'Who even are you?' },
    glossary: {},
    culture_map: {},
  };
}

const SETTINGS = {
  aspect_ratio: '9:16',
  free_style: { positive: 'photorealistic live-action short drama', negative: 'cartoon, watermark' },
};

test('adapter maps redraw facts to a factory package with localized names, subtitles and key props only', () => {
  const facts = sourceFacts();
  assert.equal(isKeyProp(facts.props[0], facts), true, 'coin is in the causal chain');
  assert.equal(isKeyProp(facts.props[1], facts), false, 'mouse is decoration');
  assert.equal(isKeyProp(facts.props[2], facts), false, '"World Cup" must not match cups');

  const pkg = buildRedrawFactoryPackage({ sourceFacts: facts, localization: localization(), analysisSettings: SETTINGS, title: 'T' });
  assert.deepEqual(pkg.characters.map((c) => c.name), ['Ethan Brooks', 'Noah Carter']);
  assert.match(pkg.characters[0].description, /Friend of Noah Carter/);
  assert.equal(pkg.characters[0].negative_prompt, 'cartoon, watermark');
  assert.deepEqual(pkg.props.map((p) => p.prop_id), ['p1']);
  assert.deepEqual(pkg.episodes[0].scenes.map((s) => s.scene_id), ['s1', 's2']);
  const [first] = pkg.episodes[0].scenes[0].shots;
  assert.equal(first.dialogue, 'Who even are you?');
  assert.equal(first.duration, 4);
  assert.match(first.description, /Ethan Brooks/);
  assert.doesNotMatch(first.action, /Lin Jiang|Chen Zi'ang/);
  assert.match(first.video_prompt, /^photorealistic live-action short drama\. /);
  assert.deepEqual(pkg.episodes[0].scenes[1].shots[0].props, ['p1']);
});

test('adapter keeps source text when no localization exists and rejects non-v2 facts', () => {
  const pkg = buildRedrawFactoryPackage({ sourceFacts: sourceFacts(), analysisSettings: SETTINGS });
  assert.deepEqual(pkg.characters.map((c) => c.name), ['Lin Jiang', "Chen Zi'ang"]);
  assert.equal(pkg.episodes[0].scenes[0].shots[0].dialogue, '你谁啊');
  assert.throws(() => buildRedrawFactoryPackage({ sourceFacts: { schema_version: '1.0', shots: [] } }),
    (error) => error.code === 'REDRAW_FACTORY_FACTS_INVALID');
});

function createDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  return db;
}

function seedRedrawWork(db, { tenantId = TENANT, userId = USER } = {}) {
  const now = new Date().toISOString();
  const projectId = Number(db.prepare(`
    INSERT INTO redraw_projects (tenant_id, user_id, title, default_locale, default_market, localization_level,
      status, execution_mode, policy_version, created_at, updated_at)
    VALUES (?, ?, 'Sample remake', 'en-US', 'US', 'faithful', 'draft', 'safe', 1, ?, ?)
  `).run(tenantId, userId, now, now).lastInsertRowid);
  const taskId = `task-${projectId}`;
  const sourceAssetId = Number(db.prepare(`
    INSERT INTO assets (name, type, url, local_path, created_at, updated_at)
    VALUES ('sample.mp4', 'video', '/static/redraw-sources/sample.mp4', 'redraw-sources/sample.mp4', ?, ?)
  `).run(now, now).lastInsertRowid);
  const workId = Number(db.prepare(`
    INSERT INTO redraw_works (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms,
      current_version, current_step, status, task_id, created_at, updated_at)
    VALUES (?, ?, ?, 'sample.mp4', ?, ?, 20000, 1, 2, 'asset_review', ?, ?, ?)
  `).run(projectId, tenantId, userId, sourceAssetId, 'f'.repeat(64), taskId, now, now).lastInsertRowid);
  db.prepare(`
    INSERT INTO async_tasks (id, type, status, progress, resource_id, tenant_id, user_id, metadata, created_at, updated_at)
    VALUES (?, 'redraw_analysis', 'completed', 100, ?, ?, ?, ?, ?, ?)
  `).run(taskId, String(workId), tenantId, userId, JSON.stringify({ redraw_analysis: SETTINGS }), now, now);
  db.prepare(`
    INSERT INTO redraw_versions (work_id, tenant_id, user_id, version, locale, market, localization_level,
      source_facts_json, facts_hash, status, created_at, updated_at)
    VALUES (?, ?, ?, 1, 'source', '', 'faithful', ?, ?, 'asset_review', ?, ?)
  `).run(workId, tenantId, userId, JSON.stringify(sourceFacts()), FACTS_HASH, now, now);
  const loc = localization();
  db.prepare(`
    INSERT INTO redraw_versions (work_id, tenant_id, user_id, version, locale, market, localization_level,
      source_facts_json, facts_hash, name_map_json, text_map_json, glossary_json, culture_map_json, status, created_at, updated_at)
    VALUES (?, ?, ?, 2, 'en-US', 'US', 'faithful', ?, ?, ?, ?, '{}', '{}', 'asset_review', ?, ?)
  `).run(workId, tenantId, userId, JSON.stringify(sourceFacts()), FACTS_HASH,
    JSON.stringify(loc.name_map), JSON.stringify(loc.text_map), now, now);
  return workId;
}

test('import creates a new factory drama with episode, characters, scenes, key props and storyboards', () => {
  const db = createDb();
  try {
    const existingFactory = Number(db.prepare(`
      INSERT INTO dramas (tenant_id, user_id, title, style, metadata, status, created_at, updated_at)
      VALUES (?, ?, 'Existing factory project', 'realistic', '{"project_type":"factory"}', 'draft', 'x', 'x')
    `).run(TENANT, USER).lastInsertRowid);
    const workId = seedRedrawWork(db);

    const result = importRedrawWorkToFactory(db, null, { workId, tenantId: TENANT, userId: USER });
    assert.equal(result.created, true);
    assert.deepEqual(result.counts, { characters: 2, scenes: 2, props: 1, episodes: 1, storyboards: 2, reference_clips: 0 });
    assert.notEqual(result.drama_id, existingFactory);

    const drama = db.prepare('SELECT * FROM dramas WHERE id = ?').get(result.drama_id);
    const metadata = JSON.parse(drama.metadata);
    assert.equal(metadata.project_type, 'factory');
    assert.equal(metadata.aspect_ratio, '9:16');
    assert.equal(metadata.redraw_import.source_work_id, workId);
    assert.equal(metadata.script_analysis_import, undefined);
    assert.equal(drama.tenant_id, TENANT);

    const episode = db.prepare('SELECT * FROM episodes WHERE drama_id = ?').get(result.drama_id);
    assert.match(episode.script_content, /Who even are you\?/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM episode_characters WHERE episode_id = ?').get(episode.id).n, 2);
    const storyboards = db.prepare('SELECT * FROM storyboards WHERE episode_id = ? ORDER BY storyboard_number').all(episode.id);
    assert.equal(storyboards.length, 2);
    assert.equal(storyboards[0].dialogue, 'Who even are you?');
    assert.ok(storyboards[0].video_prompt);
    assert.equal(JSON.parse(storyboards[0].characters).length, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM storyboard_props WHERE storyboard_id = ?').get(storyboards[1].id).n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scenes WHERE drama_id = ? AND episode_id = ?').get(result.drama_id, episode.id).n, 2);

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM characters WHERE drama_id = ?').get(existingFactory).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE drama_id = ?').get(existingFactory).n, 0);
  } finally {
    db.close();
  }
});

test('import is idempotent per work version and isolated by tenant and user', () => {
  const db = createDb();
  try {
    const workId = seedRedrawWork(db);
    const first = importRedrawWorkToFactory(db, null, { workId, tenantId: TENANT, userId: USER });
    const second = importRedrawWorkToFactory(db, null, { workId, tenantId: TENANT, userId: USER });
    assert.equal(second.created, false);
    assert.equal(second.drama_id, first.drama_id);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dramas WHERE json_extract(metadata, '$.redraw_import.source_work_id') = ?").get(workId).n, 1);

    assert.throws(() => importRedrawWorkToFactory(db, null, { workId, tenantId: 'personal:user-b', userId: 'user-b' }),
      (error) => error.code === 'REDRAW_WORK_NOT_FOUND');
  } finally {
    db.close();
  }
});

test('import requires a completed analysis and rolls back on failure', () => {
  const db = createDb();
  try {
    const workId = seedRedrawWork(db);
    db.prepare("UPDATE async_tasks SET status = 'processing' WHERE type = 'redraw_analysis'").run();
    const before = db.prepare('SELECT COUNT(*) AS n FROM dramas').get().n;
    assert.throws(() => importRedrawWorkToFactory(db, null, { workId, tenantId: TENANT, userId: USER }),
      (error) => error.code === 'REDRAW_FACTORY_ANALYSIS_REQUIRED');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dramas').get().n, before);
  } finally {
    db.close();
  }
});

test('import copies generated redraw character images into the factory project folder', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const db = createDb();
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-factory-'));
  try {
    const workId = seedRedrawWork(db);
    const version = db.prepare("SELECT id FROM redraw_versions WHERE work_id = ? AND locale = 'en-US'").get(workId);
    fs.mkdirSync(path.join(storageRoot, 'redraw-assets', `v${version.id}`), { recursive: true });
    fs.writeFileSync(path.join(storageRoot, 'redraw-assets', `v${version.id}`, 'c1.jpg'), 'jpg');
    const now = new Date().toISOString();
    const assetId = Number(db.prepare(`
      INSERT INTO assets (name, type, url, local_path, created_at, updated_at)
      VALUES ('c1', 'image', 'https://example.test/c1.jpg', ?, ?, ?)
    `).run(`redraw-assets/v${version.id}/c1.jpg`, now, now).lastInsertRowid);
    db.prepare(`
      INSERT INTO redraw_assets (version_id, tenant_id, user_id, kind, source_ref_json, localized_name, asset_id,
        status, approval_status, created_at, updated_at)
      VALUES (?, ?, ?, 'character', ?, 'Ethan Brooks', ?, 'generated', 'pending', ?, ?)
    `).run(version.id, TENANT, USER, JSON.stringify({ source_ref: { kind: 'character', source_character_key: 'c1' } }), assetId, now, now);

    const result = importRedrawWorkToFactory(db, null, { workId, tenantId: TENANT, userId: USER, storageRoot });
    const character = db.prepare("SELECT image_url, local_path FROM characters WHERE drama_id = ? AND name = 'Ethan Brooks'").get(result.drama_id);
    assert.match(character.local_path, new RegExp(`^projects/0*${result.drama_id}_.+/characters/redraw_c1_c1\.jpg$`));
    assert.equal(character.image_url, `/static/${character.local_path}`);
    assert.equal(fs.readFileSync(path.join(storageRoot, character.local_path), 'utf8'), 'jpg');
    assert.ok(fs.existsSync(path.join(storageRoot, 'redraw-assets', `v${version.id}`, 'c1.jpg')), 'source image kept');
    const other = db.prepare("SELECT image_url, local_path FROM characters WHERE drama_id = ? AND name = 'Noah Carter'").get(result.drama_id);
    assert.equal(other.local_path, null);
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('reference clip window pads short shots to the minimum and stays inside the sample', () => {
  const { clipWindow, MIN_REFERENCE_MS } = require('../src/services/redrawStoryboardReferenceClipService');
  assert.deepEqual(clipWindow(10_000, 11_000, 60_000), { start_ms: 9_500, end_ms: 9_500 + MIN_REFERENCE_MS });
  assert.deepEqual(clipWindow(0, 500, 60_000), { start_ms: 0, end_ms: MIN_REFERENCE_MS });
  assert.deepEqual(clipWindow(59_500, 60_000, 60_000), { start_ms: 60_000 - MIN_REFERENCE_MS, end_ms: 60_000 });
  assert.deepEqual(clipWindow(1_000, 5_000, 60_000), { start_ms: 1_000, end_ms: 5_000 });
  assert.equal(clipWindow(5_000, 5_000, 60_000), null);
});

test('import cuts one sample reference clip per storyboard, owned by the new project, exposed on storyboards', { skip: !require('../src/utils/ffmpegPath').hasLocalFfmpeg() }, () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const { getFfmpegPath } = require('../src/utils/ffmpegPath');
  const dramaService = require('../src/services/dramaService');
  const db = createDb();
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-factory-clip-'));
  try {
    const workId = seedRedrawWork(db);
    const work = db.prepare('SELECT source_asset_id FROM redraw_works WHERE id = ?').get(workId);
    const sourceRel = db.prepare('SELECT local_path FROM assets WHERE id = ?').get(work.source_asset_id).local_path;
    fs.mkdirSync(path.dirname(path.join(storageRoot, sourceRel)), { recursive: true });
    const made = spawnSync(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x284:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '20', '-shortest', path.join(storageRoot, sourceRel)]);
    assert.equal(made.status, 0);

    const result = importRedrawWorkToFactory(db, null, { workId, tenantId: TENANT, userId: USER, storageRoot });
    assert.equal(result.counts.reference_clips, 2);
    const clips = db.prepare("SELECT storyboard_id, local_path, drama_id, type, metadata FROM assets WHERE category = 'storyboard_reference_video' ORDER BY id").all();
    assert.equal(clips.length, 2);
    for (const clip of clips) {
      assert.equal(clip.drama_id, result.drama_id);
      assert.equal(clip.type, 'video');
      assert.match(clip.local_path, new RegExp(`^projects/0*${result.drama_id}_.+/videos/references/`));
      assert.ok(fs.statSync(path.join(storageRoot, clip.local_path)).size > 0);
    }
    assert.equal(JSON.parse(clips[0].metadata).source_shot_id, 'shot-1');

    const drama = dramaService.getDrama(db, result.drama_id, '', USER, TENANT);
    const storyboards = drama.episodes[0].storyboards;
    assert.equal(storyboards[0].creation_mode, 'universal');
    assert.equal(storyboards[0].reference_video_urls.length, 1);
    assert.match(storyboards[0].reference_video_urls[0], /^\/static\/projects\/.+\/videos\/references\/sb\d+_/);
    const metadata = JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id = ?').get(result.drama_id).metadata);
    assert.equal(metadata.video_native_audio, true);
    assert.equal(metadata.video_use_storyboard_reference_video, true);
    assert.equal(metadata.merge_trim_to_storyboard_duration, true);
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('ordinary factory storyboards expose an empty reference video list', () => {
  const dramaService = require('../src/services/dramaService');
  const db = createDb();
  try {
    const now = new Date().toISOString();
    const dramaId = Number(db.prepare(`INSERT INTO dramas (tenant_id, user_id, title, style, status, created_at, updated_at)
      VALUES (?, ?, 'Plain', 'realistic', 'draft', ?, ?)`).run(TENANT, USER, now, now).lastInsertRowid);
    const episodeId = Number(db.prepare(`INSERT INTO episodes (drama_id, episode_number, title, status, created_at, updated_at)
      VALUES (?, 1, 'E1', 'draft', ?, ?)`).run(dramaId, now, now).lastInsertRowid);
    db.prepare(`INSERT INTO storyboards (episode_id, storyboard_number, title, duration, status, created_at, updated_at)
      VALUES (?, 1, 'S1', 5, 'draft', ?, ?)`).run(episodeId, now, now);
    const drama = dramaService.getDrama(db, dramaId, '', USER, TENANT);
    assert.deepEqual(drama.episodes[0].storyboards[0].reference_video_urls, []);
    assert.equal(drama.episodes[0].storyboards[0].creation_mode, 'classic');
  } finally {
    db.close();
  }
});

test('merge trim shortens clips longer than the storyboard duration and keeps audio', { skip: !require('../src/utils/ffmpegPath').hasLocalFfmpeg() }, () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const { getFfmpegPath, getFfprobePath } = require('../src/utils/ffmpegPath');
  const { trimClipToDuration } = require('../src/services/videoMergeService');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-trim-'));
  try {
    const input = path.join(dir, 'in.mp4');
    assert.equal(spawnSync(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x284:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '4', '-shortest', input]).status, 0);
    const log = { warn() {} };
    const trimmed = trimClipToDuration(input, 3, dir, 0, log);
    assert.notEqual(trimmed, input);
    const probe = spawnSync(getFfprobePath(), ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', trimmed], { encoding: 'utf8' });
    const info = JSON.parse(probe.stdout);
    assert.ok(Math.abs(Number(info.format.duration) - 3) < 0.25);
    assert.ok(info.streams.some((stream) => stream.codec_type === 'audio'));
    assert.equal(trimClipToDuration(input, 5, dir, 1, log), input, 'shorter clip is kept as is');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
