const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const storyboardService = require('../src/services/storyboardService');

const log = { info() {}, warn() {}, error() {} };

test('画布摄影控制可以保存结构化角度和灯光参数', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (title, created_at, updated_at) VALUES (?, ?, ?)').run('摄影参数测试', now, now);
  const dramaId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare('INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(dramaId, 1, '第1集', now, now);
  const episodeId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  const created = storyboardService.createStoryboard(db, log, {
    episode_id: episodeId,
    storyboard_number: 1,
    title: '林中镜头',
  });

  const saved = storyboardService.updateStoryboard(db, log, created.id, {
    angle_h: 'front_left',
    angle_v: 'high',
    angle_s: 'medium',
    lighting_style: 'golden_hour',
  });

  assert.equal(saved.angle_h, 'front_left');
  assert.equal(saved.angle_v, 'high');
  assert.equal(saved.angle_s, 'medium');
  assert.equal(saved.lighting_style, 'golden_hour');
  db.close();
});
