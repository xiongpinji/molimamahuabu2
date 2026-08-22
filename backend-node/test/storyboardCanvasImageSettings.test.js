const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const storyboardService = require('../src/services/storyboardService');

const log = { info() {}, warn() {}, error() {} };

test('画布分镜图设置可以保存并在重新读取时恢复', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (title, created_at, updated_at) VALUES (?, ?, ?)').run('画布设置测试', now, now);
  const dramaId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare('INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(dramaId, 1, '第1集', now, now);
  const episodeId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  const created = storyboardService.createStoryboard(db, log, {
    episode_id: episodeId,
    storyboard_number: 1,
    title: '画布镜头',
  });

  assert.equal(created.image_model, null);
  assert.equal(created.grid_frame_type, 'single');

  const saved = storyboardService.updateStoryboard(db, log, created.id, {
    image_model: 'lib-image-pro',
    grid_frame_type: 'nine_grid',
  });
  assert.equal(saved.image_model, 'lib-image-pro');
  assert.equal(saved.grid_frame_type, 'nine_grid');

  const restored = storyboardService.getStoryboardById(db, created.id);
  assert.equal(restored.image_model, 'lib-image-pro');
  assert.equal(restored.grid_frame_type, 'nine_grid');
  db.close();
});
