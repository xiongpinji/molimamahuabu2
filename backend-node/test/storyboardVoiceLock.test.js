const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const voiceLock = require('../src/services/storyboardVoiceLockService');
const { selectStoryboardCharacterVoiceRef } = require('../src/services/videoClient');

function createDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  return db;
}

test('分镜生成时保存角色音色快照，角色后续更换音频不影响旧分镜', () => {
  const db = createDb();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (title, created_at, updated_at) VALUES (?, ?, ?)').run('voice lock', now, now);
  const dramaId = db.prepare('SELECT last_insert_rowid() id').get().id;
  db.prepare('INSERT INTO episodes (drama_id, episode_number, created_at, updated_at) VALUES (?, 1, ?, ?)').run(dramaId, now, now);
  const episodeId = db.prepare('SELECT last_insert_rowid() id').get().id;
  const insertChar = db.prepare(
    'INSERT INTO characters (drama_id, name, seedance2_voice_asset, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  );
  insertChar.run(dramaId, '小狐狸', JSON.stringify({ status: 'active', url: 'https://cdn.example/fox-v1.mp3' }), now, now);
  const foxId = db.prepare('SELECT last_insert_rowid() id').get().id;
  insertChar.run(dramaId, '林岚', JSON.stringify({ status: 'active', url: 'https://cdn.example/linlan-v1.mp3' }), now, now);
  const linlanId = db.prepare('SELECT last_insert_rowid() id').get().id;
  db.prepare(
    'INSERT INTO storyboards (episode_id, storyboard_number, characters, dialogue, status, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?)'
  ).run(episodeId, JSON.stringify([foxId, linlanId]), '小狐狸：你好 / 林岚：你好', 'pending', now, now);
  const storyboardId = db.prepare('SELECT last_insert_rowid() id').get().id;

  const snapshot = voiceLock.refreshStoryboardVoiceSnapshot(db, storyboardId);
  assert.ok(snapshot);
  assert.deepEqual(voiceLock.parseVoiceSnapshot(snapshot).map((item) => item.id), [foxId, linlanId]);

  db.prepare('UPDATE characters SET seedance2_voice_asset = ? WHERE id = ?')
    .run(JSON.stringify({ status: 'active', url: 'https://cdn.example/fox-v2.mp3' }), foxId);
  assert.equal(
    selectStoryboardCharacterVoiceRef(db, dramaId, storyboardId),
    'https://cdn.example/fox-v1.mp3',
    '旧分镜应继续使用生成时锁定的音色'
  );
  db.close();
});

test('没有快照的旧分镜仍回退到当前角色音色', () => {
  const db = createDb();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (title, created_at, updated_at) VALUES (?, ?, ?)').run('legacy voice', now, now);
  const dramaId = db.prepare('SELECT last_insert_rowid() id').get().id;
  db.prepare('INSERT INTO episodes (drama_id, episode_number, created_at, updated_at) VALUES (?, 1, ?, ?)').run(dramaId, now, now);
  const episodeId = db.prepare('SELECT last_insert_rowid() id').get().id;
  db.prepare('INSERT INTO characters (drama_id, name, seedance2_voice_asset, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(dramaId, '小狐狸', JSON.stringify({ status: 'active', url: 'https://cdn.example/legacy.mp3' }), now, now);
  const characterId = db.prepare('SELECT last_insert_rowid() id').get().id;
  db.prepare('INSERT INTO storyboards (episode_id, storyboard_number, characters, dialogue, status, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?)')
    .run(episodeId, JSON.stringify([characterId]), '小狐狸：你好', 'pending', now, now);
  const storyboardId = db.prepare('SELECT last_insert_rowid() id').get().id;
  assert.equal(selectStoryboardCharacterVoiceRef(db, dramaId, storyboardId), 'https://cdn.example/legacy.mp3');
  db.close();
});

test('AI 分镜仅保存角色名称时也能锁定对应音色', () => {
  const db = createDb();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (title, created_at, updated_at) VALUES (?, ?, ?)').run('name-only voice', now, now);
  const dramaId = db.prepare('SELECT last_insert_rowid() id').get().id;
  db.prepare('INSERT INTO episodes (drama_id, episode_number, created_at, updated_at) VALUES (?, 1, ?, ?)').run(dramaId, now, now);
  const episodeId = db.prepare('SELECT last_insert_rowid() id').get().id;
  db.prepare('INSERT INTO characters (drama_id, name, seedance2_voice_asset, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(dramaId, '小狐狸', JSON.stringify({ status: 'active', url: 'https://cdn.example/fox-name.mp3' }), now, now);
  const storyboardId = db.prepare(
    'INSERT INTO storyboards (episode_id, storyboard_number, characters, dialogue, status, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?)'
  ).run(episodeId, JSON.stringify([{ name: '小狐狸' }]), '小狐狸：你好', 'pending', now, now).lastInsertRowid;

  const snapshot = voiceLock.refreshStoryboardVoiceSnapshot(db, storyboardId);
  assert.deepEqual(voiceLock.parseVoiceSnapshot(snapshot).map((item) => item.url), ['https://cdn.example/fox-name.mp3']);
  db.close();
});
