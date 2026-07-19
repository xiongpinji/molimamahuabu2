const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const voicePrompt = require('../src/services/storyboardVoicePromptService');
const { callVideoApi } = require('../src/services/videoClient');

function createDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  return db;
}

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
