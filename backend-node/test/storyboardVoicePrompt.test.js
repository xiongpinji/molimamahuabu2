const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const voicePrompt = require('../src/services/storyboardVoicePromptService');
const episodeStoryboardService = require('../src/services/episodeStoryboardService');
const storyboardService = require('../src/services/storyboardService');
const videoService = require('../src/services/videoService');
const { callVideoApi } = require('../src/services/videoClient');

function createDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  return db;
}

test('分镜生成保存路径会在入库后固化角色声线提示词', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/services/episodeStoryboardService.js'),
    'utf8'
  );

  assert.match(source, /function\s+saveStoryboards\(/);
  assert.match(source, /function\s+insertOneStoryboard\(/);
  assert.match(source, /ensureStoryboardVoicePrompt\(db,\s*newId\)/);
  assert.match(source, /ensureStoryboardVoicePrompt\(db,\s*id\)/);
  assert.match(source, /ensureStoryboardVoicePrompt\(db,\s*row\.id\)|ensureStoryboardVoicePrompt\(db,\s*r\.id\)/);
});

test('为不支持参考音频的分镜生成固定角色声音锚点', () => {
  const db = createDb();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (title, created_at, updated_at) VALUES (?, ?, ?)').run('voice prompt', now, now);
  const dramaId = db.prepare('SELECT last_insert_rowid() id').get().id;
  db.prepare('INSERT INTO episodes (drama_id, episode_number, created_at, updated_at) VALUES (?, 1, ?, ?)').run(dramaId, now, now);
  const episodeId = db.prepare('SELECT last_insert_rowid() id').get().id;
  const insertCharacter = db.prepare(
    'INSERT INTO characters (drama_id, name, voice_style, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  );
  insertCharacter.run(dramaId, '小狐狸', 'bright youthful voice, clear diction', now, now);
  const foxId = db.prepare('SELECT last_insert_rowid() id').get().id;
  insertCharacter.run(dramaId, '林岚', null, now, now);
  const linlanId = db.prepare('SELECT last_insert_rowid() id').get().id;
  const storyboardId = db.prepare(
    'INSERT INTO storyboards (episode_id, storyboard_number, characters, dialogue, status, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?)'
  ).run(episodeId, JSON.stringify([foxId, linlanId]), '小狐狸：别怕。\n林岚：我在这里。', 'pending', now, now).lastInsertRowid;

  const prompt = voicePrompt.appendVoiceAnchors({
    db,
    dramaId,
    storyboardId,
    model: 'veo-3.1-generate-preview',
    protocol: 'veo3',
    prompt: 'A close two-shot. 小狐狸："别怕。" 林岚："我在这里。"',
  });
  assert.match(prompt, /VOICE CONTINUITY/);
  assert.match(prompt, /bright youthful voice, clear diction/);
  assert.match(prompt, /林岚: /);
  assert.equal(
    voicePrompt.appendVoiceAnchors({ db, dramaId, storyboardId, model: 'veo-2.0-generate-001', protocol: 'veo3', prompt: '小狐狸："别怕。"' }),
    '小狐狸："别怕。"',
    'Veo 2 无原生音频，应保持静音模型原始提示'
  );
  db.close();
});

test('没有声线描述时按角色 ID 生成可重复的描述', () => {
  const db = createDb();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (title, created_at, updated_at) VALUES (?, ?, ?)').run('stable profile', now, now);
  const dramaId = db.prepare('SELECT last_insert_rowid() id').get().id;
  db.prepare('INSERT INTO episodes (drama_id, episode_number, created_at, updated_at) VALUES (?, 1, ?, ?)').run(dramaId, now, now);
  const episodeId = db.prepare('SELECT last_insert_rowid() id').get().id;
  db.prepare('INSERT INTO characters (drama_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(dramaId, '角色A', now, now);
  const characterId = db.prepare('SELECT last_insert_rowid() id').get().id;
  const storyboardId = db.prepare(
    'INSERT INTO storyboards (episode_id, storyboard_number, characters, dialogue, status, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?)'
  ).run(episodeId, JSON.stringify([characterId]), '角色A：继续走。', 'pending', now, now).lastInsertRowid;
  const args = { db, dramaId, storyboardId, protocol: 'deepwl_grok', model: 'grok-video-3', prompt: '角色A："继续走。"' };
  const first = voicePrompt.appendVoiceAnchors(args);
  const second = voicePrompt.appendVoiceAnchors(args);
  assert.equal(first, second);
  db.close();
});

test('缺省角色声线会写回角色库并跨分镜复用', () => {
  const db = createDb();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (title, created_at, updated_at) VALUES (?, ?, ?)').run('voice style persistence', now, now);
  const dramaId = db.prepare('SELECT last_insert_rowid() id').get().id;
  db.prepare('INSERT INTO episodes (drama_id, episode_number, created_at, updated_at) VALUES (?, 1, ?, ?)').run(dramaId, now, now);
  const episodeId = db.prepare('SELECT last_insert_rowid() id').get().id;
  db.prepare('INSERT INTO characters (drama_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(dramaId, '小狐狸', now, now);
  const characterId = db.prepare('SELECT last_insert_rowid() id').get().id;
  const insertStoryboard = db.prepare(
    'INSERT INTO storyboards (episode_id, storyboard_number, characters, dialogue, video_prompt, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const firstId = insertStoryboard.run(
    episodeId,
    1,
    JSON.stringify([characterId]),
    '小狐狸：我听见风声。',
    '场景：林间。动作：小狐狸停步倾听。',
    'pending',
    now,
    now
  ).lastInsertRowid;
  const secondId = insertStoryboard.run(
    episodeId,
    2,
    JSON.stringify([characterId]),
    '小狐狸：继续向前。',
    '场景：溪边。动作：小狐狸越过石头。',
    'pending',
    now,
    now
  ).lastInsertRowid;

  const first = voicePrompt.ensureStoryboardVoicePrompt(db, firstId);
  const persisted = db.prepare('SELECT voice_style FROM characters WHERE id = ?').get(characterId).voice_style;
  const second = voicePrompt.ensureStoryboardVoicePrompt(db, secondId);

  assert.ok(persisted);
  assert.match(first, new RegExp(persisted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(second, new RegExp(persisted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(db.prepare('SELECT voice_style FROM characters WHERE id = ?').get(characterId).voice_style, persisted);
  db.close();
});

test('部分角色有音频快照时仍为分镜全部角色生成文字声线', () => {
  const db = createDb();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (title, created_at, updated_at) VALUES (?, ?, ?)').run('partial snapshot', now, now);
  const dramaId = db.prepare('SELECT last_insert_rowid() id').get().id;
  db.prepare('INSERT INTO episodes (drama_id, episode_number, created_at, updated_at) VALUES (?, 1, ?, ?)').run(dramaId, now, now);
  const episodeId = db.prepare('SELECT last_insert_rowid() id').get().id;
  const insertCharacter = db.prepare(
    'INSERT INTO characters (drama_id, name, seedance2_voice_asset, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  );
  insertCharacter.run(dramaId, '小狐狸', JSON.stringify({ status: 'active', url: 'https://cdn.example/fox.mp3' }), now, now);
  const foxId = db.prepare('SELECT last_insert_rowid() id').get().id;
  insertCharacter.run(dramaId, '林岚', null, now, now);
  const linlanId = db.prepare('SELECT last_insert_rowid() id').get().id;
  const storyboardId = db.prepare(
    'INSERT INTO storyboards (episode_id, storyboard_number, characters, dialogue, voice_snapshot, status, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)'
  ).run(
    episodeId,
    JSON.stringify([foxId, linlanId]),
    '小狐狸：别怕。\n林岚：我在这里。',
    JSON.stringify({ version: 1, characters: [{ id: foxId, name: '小狐狸', url: 'https://cdn.example/fox.mp3' }] }),
    'pending',
    now,
    now
  ).lastInsertRowid;
  const prompt = voicePrompt.appendVoiceAnchors({
    db,
    dramaId,
    storyboardId,
    protocol: 'veo3',
    model: 'veo-3.1-generate-preview',
    prompt: 'A two-shot. 小狐狸："别怕。" 林岚："我在这里。"',
  });
  assert.match(prompt, /小狐狸:/);
  assert.match(prompt, /林岚:/);
  db.close();
});

test('生成后的分镜 video_prompt 自动挂载固定角色声线，且重复刷新不会重复追加', () => {
  const db = createDb();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (title, created_at, updated_at) VALUES (?, ?, ?)').run('persisted voice prompt', now, now);
  const dramaId = db.prepare('SELECT last_insert_rowid() id').get().id;
  db.prepare('INSERT INTO episodes (drama_id, episode_number, created_at, updated_at) VALUES (?, 1, ?, ?)').run(dramaId, now, now);
  const episodeId = db.prepare('SELECT last_insert_rowid() id').get().id;
  const insertCharacter = db.prepare(
    'INSERT INTO characters (drama_id, name, voice_style, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  );
  insertCharacter.run(dramaId, '小狐狸', 'bright youthful voice, clear diction', now, now);
  const foxId = db.prepare('SELECT last_insert_rowid() id').get().id;
  insertCharacter.run(dramaId, '林岚', 'warm low voice, calm pace', now, now);
  const linlanId = db.prepare('SELECT last_insert_rowid() id').get().id;
  const firstId = db.prepare(
    'INSERT INTO storyboards (episode_id, storyboard_number, characters, dialogue, video_prompt, status, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)'
  ).run(
    episodeId,
    JSON.stringify([foxId]),
    '小狐狸：别怕。',
    '场景：森林。动作：小狐狸抬头。',
    'pending',
    now,
    now
  ).lastInsertRowid;
  const secondId = db.prepare(
    'INSERT INTO storyboards (episode_id, storyboard_number, characters, dialogue, video_prompt, status, created_at, updated_at) VALUES (?, 2, ?, ?, ?, ?, ?, ?)'
  ).run(
    episodeId,
    JSON.stringify([foxId, linlanId]),
    '小狐狸：我找到路了。\n林岚：跟紧我。',
    '场景：林间小路。动作：两人向前走。',
    'pending',
    now,
    now
  ).lastInsertRowid;

  const { ensureStoryboardVoicePrompt } = voicePrompt;
  const first = ensureStoryboardVoicePrompt(db, firstId);
  const second = ensureStoryboardVoicePrompt(db, secondId);
  const firstAgain = ensureStoryboardVoicePrompt(db, firstId);

  assert.match(first, /VOICE CONTINUITY/);
  assert.match(first, /bright youthful voice, clear diction/);
  assert.doesNotMatch(first, /warm low voice, calm pace/);
  assert.match(second, /bright youthful voice, clear diction/);
  assert.match(second, /warm low voice, calm pace/);
  assert.equal(firstAgain, first);
  assert.equal((first.match(/VOICE CONTINUITY/g) || []).length, 1);
  assert.equal((second.match(/VOICE CONTINUITY/g) || []).length, 1);

  const legacyId = db.prepare(
    'INSERT INTO storyboards (episode_id, storyboard_number, characters, dialogue, video_prompt, status, created_at, updated_at) VALUES (?, 3, ?, ?, ?, ?, ?, ?)'
  ).run(
    episodeId,
    JSON.stringify([foxId]),
    '小狐狸：继续前进。',
    '场景：溪边。动作：小狐狸向前走。',
    'pending',
    now,
    now
  ).lastInsertRowid;
  const listed = episodeStoryboardService.getStoryboardsForEpisode(db, episodeId);
  assert.match(listed.find((item) => item.id === legacyId).video_prompt, /bright youthful voice, clear diction/);

  const created = storyboardService.createStoryboard(db, { info() {} }, {
    episode_id: episodeId,
    storyboard_number: 4,
    characters: [foxId],
    dialogue: '小狐狸：我们走。',
    video_prompt: '场景：林间。动作：小狐狸转身。',
  });
  assert.deepEqual(created.characters, [foxId]);
  assert.match(created.video_prompt, /bright youthful voice, clear diction/);
  db.close();
});

test('对白中出现但未写入角色引用的角色也会补齐声线', () => {
  const db = createDb();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (title, created_at, updated_at) VALUES (?, ?, ?)').run('dialogue role fallback', now, now);
  const dramaId = db.prepare('SELECT last_insert_rowid() id').get().id;
  db.prepare('INSERT INTO episodes (drama_id, episode_number, created_at, updated_at) VALUES (?, 1, ?, ?)').run(dramaId, now, now);
  const episodeId = db.prepare('SELECT last_insert_rowid() id').get().id;
  const insertCharacter = db.prepare(
    'INSERT INTO characters (drama_id, name, voice_style, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  );
  insertCharacter.run(dramaId, '小狐狸', 'bright youthful voice', now, now);
  const foxId = db.prepare('SELECT last_insert_rowid() id').get().id;
  insertCharacter.run(dramaId, '林岚', 'warm low voice', now, now);
  const linlanId = db.prepare('SELECT last_insert_rowid() id').get().id;
  const storyboardId = db.prepare(
    'INSERT INTO storyboards (episode_id, storyboard_number, characters, dialogue, video_prompt, status, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)'
  ).run(
    episodeId,
    JSON.stringify([foxId]),
    '小狐狸：我先走。\n林岚：我跟上。',
    '场景：林间。动作：两人并肩前行。',
    'pending',
    now,
    now
  ).lastInsertRowid;

  const prompt = voicePrompt.ensureStoryboardVoicePrompt(db, storyboardId);
  assert.match(prompt, /bright youthful voice/);
  assert.match(prompt, /warm low voice/);
  assert.equal((prompt.match(/VOICE CONTINUITY/g) || []).length, 1);
  db.close();
});

test('生产视频入口把非克隆模型的角色声线锚点传给供应商', async () => {
  const db = createDb();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (title, created_at, updated_at) VALUES (?, ?, ?)').run('video route', now, now);
  const dramaId = db.prepare('SELECT last_insert_rowid() id').get().id;
  db.prepare('INSERT INTO episodes (drama_id, episode_number, created_at, updated_at) VALUES (?, 1, ?, ?)').run(dramaId, now, now);
  const episodeId = db.prepare('SELECT last_insert_rowid() id').get().id;
  db.prepare('INSERT INTO characters (drama_id, name, voice_style, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(dramaId, '小狐狸', 'bright youthful voice', now, now);
  const characterId = db.prepare('SELECT last_insert_rowid() id').get().id;
  const storyboardId = db.prepare(
    'INSERT INTO storyboards (episode_id, storyboard_number, characters, dialogue, status, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?)'
  ).run(episodeId, JSON.stringify([characterId]), '小狐狸：你好。', 'pending', now, now).lastInsertRowid;
  db.prepare(
    `INSERT INTO ai_service_configs
      (service_type, provider, name, base_url, api_key, model, default_model, endpoint, query_endpoint, is_active, is_default, priority, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 0, ?, ?)`
  ).run(
    'video', 'deepwl', 'DeepWL test', 'https://zx1.deepwl.net', 'secret',
    JSON.stringify(['grok-video-3']), 'grok-video-3', '/v1/video/create', '', now, now,
  );
  db.prepare('UPDATE ai_service_configs SET api_protocol = ? WHERE service_type = ?').run('deepwl_grok_unified', 'video');
  const originalFetch = global.fetch;
  let body;
  global.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'voice-prompt-route' }) };
  };
  try {
    const result = await callVideoApi(db, { info() {}, warn() {}, error() {} }, {
      model: 'grok-video-3',
      prompt: 'A close-up. 小狐狸："你好。"',
      drama_id: dramaId,
      storyboard_id: storyboardId,
    });
    assert.equal(result.task_id, 'voice-prompt-route');
    assert.match(body.prompt, /VOICE CONTINUITY/);
    assert.match(body.prompt, /bright youthful voice/);
  } finally {
    global.fetch = originalFetch;
    db.close();
  }
});

test('创建视频任务时保留模型首尾帧参考图，并把前端传入提示词补齐角色声线', () => {
  const db = createDb();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (title, created_at, updated_at) VALUES (?, ?, ?)').run('video create prompt', now, now);
  const dramaId = db.prepare('SELECT last_insert_rowid() id').get().id;
  db.prepare('INSERT INTO episodes (drama_id, episode_number, created_at, updated_at) VALUES (?, 1, ?, ?)').run(dramaId, now, now);
  const episodeId = db.prepare('SELECT last_insert_rowid() id').get().id;
  db.prepare('INSERT INTO characters (drama_id, name, voice_style, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(dramaId, '小狐狸', 'bright youthful voice, clear diction', now, now);
  const foxId = db.prepare('SELECT last_insert_rowid() id').get().id;
  const storyboardId = db.prepare(
    'INSERT INTO storyboards (episode_id, storyboard_number, characters, dialogue, video_prompt, status, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)'
  ).run(
    episodeId,
    JSON.stringify([foxId]),
    '小狐狸：继续走。',
    '默认分镜提示词',
    'pending',
    now,
    now
  ).lastInsertRowid;

  const created = videoService.create(db, { info() {}, warn() {}, error() {} }, {
    drama_id: dramaId,
    storyboard_id: storyboardId,
    prompt: '前端节点生成的提示词。小狐狸："继续走。"',
    model: 'grok-video-3',
    first_frame_url: 'https://cdn.example/first.png',
    last_frame_url: 'https://cdn.example/last.png',
    reference_image_urls: ['https://cdn.example/role.png', 'https://cdn.example/scene.png'],
    aspect_ratio: '16:9',
    resolution: '720p',
    duration: 5,
  }, { schedule() {} });

  const row = db.prepare('SELECT * FROM video_generations WHERE id = ?').get(created.id);
  assert.equal(row.model, 'grok-video-3');
  assert.equal(row.first_frame_url, 'https://cdn.example/first.png');
  assert.equal(row.last_frame_url, 'https://cdn.example/last.png');
  assert.deepEqual(JSON.parse(row.reference_image_urls), ['https://cdn.example/role.png', 'https://cdn.example/scene.png']);
  assert.match(row.prompt, /前端节点生成的提示词/);
  assert.match(row.prompt, /VOICE CONTINUITY/);
  assert.match(row.prompt, /bright youthful voice, clear diction/);
  db.close();
});
