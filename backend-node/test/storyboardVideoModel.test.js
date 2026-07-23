const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const storyboardService = require('../src/services/storyboardService');

const log = { info() {}, warn() {}, error() {} };

test('分镜视频模型覆盖可以保存、恢复，并在重新读取时保留', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (title, created_at, updated_at) VALUES (?, ?, ?)').run('测试剧', now, now);
  const dramaId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare('INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(dramaId, 1, '第1集', now, now);
  const episodeId = db.prepare('SELECT last_insert_rowid() AS id').get().id;

  const created = storyboardService.createStoryboard(db, log, {
    episode_id: episodeId,
    storyboard_number: 1,
    title: '首镜',
  });
  assert.equal(created.video_model, null);

  const saved = storyboardService.updateStoryboard(db, log, created.id, { video_model: 'grok-video-3' });
  assert.equal(saved.video_model, 'grok-video-3');
  assert.equal(storyboardService.getStoryboardById(db, created.id).video_model, 'grok-video-3');

  const restored = storyboardService.updateStoryboard(db, log, created.id, { video_model: null });
  assert.equal(restored.video_model, null);
  assert.equal(storyboardService.getStoryboardById(db, created.id).video_model, null);
  db.close();
});
