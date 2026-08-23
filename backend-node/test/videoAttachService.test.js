const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const videoService = require('../src/services/videoService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {} };

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const dramaId = db.prepare(`
    INSERT INTO dramas (title, created_at, updated_at)
    VALUES ('素材库复用测试', ?, ?)
  `).run(now, now).lastInsertRowid;
  const episodeId = db.prepare(`
    INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at)
    VALUES (?, 1, '第1集', ?, ?)
  `).run(dramaId, now, now).lastInsertRowid;
  const storyboardId = db.prepare(`
    INSERT INTO storyboards (episode_id, storyboard_number, title, created_at, updated_at)
    VALUES (?, 1, '镜头1', ?, ?)
  `).run(episodeId, now, now).lastInsertRowid;
  return { db, dramaId, storyboardId };
}

test('素材库视频复用为 completed 成片并同步分镜 video_url', () => {
  const { db, dramaId, storyboardId } = setup();

  const item = videoService.attach(db, log, {
    drama_id: dramaId,
    storyboard_id: storyboardId,
    video_url: 'https://example.com/library.mp4',
    local_path: 'projects/demo/library.mp4',
    duration: 5,
  });

  assert.equal(item.storyboard_id, storyboardId);
  assert.equal(item.drama_id, dramaId);
  assert.equal(item.provider, 'library');
  assert.equal(item.model, 'library-reuse');
  assert.equal(item.status, 'completed');
  assert.equal(item.video_url, 'https://example.com/library.mp4');
  assert.equal(item.local_path, 'projects/demo/library.mp4');
  assert.equal(item.duration, 5);
  assert.equal(
    db.prepare('SELECT video_url FROM storyboards WHERE id = ?').get(storyboardId).video_url,
    'https://example.com/library.mp4'
  );
});

test('素材库视频复用校验必填参数', () => {
  const { db, storyboardId } = setup();

  assert.throws(() => videoService.attach(db, log, {}), /storyboard_id 必填/);
  assert.throws(
    () => videoService.attach(db, log, { storyboard_id: 9999, video_url: 'https://example.com/a.mp4' }),
    /分镜不存在/
  );
  assert.throws(
    () => videoService.attach(db, log, { storyboard_id: storyboardId }),
    /至少提供/
  );
});
