const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const videoService = require('../src/services/videoService');

test('同一分镜存在处理中视频时复用现有任务', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE video_generations (
    id INTEGER PRIMARY KEY,
    storyboard_id INTEGER,
    status TEXT,
    deleted_at TEXT,
    created_at TEXT
  )`);
  db.prepare('INSERT INTO video_generations (id, storyboard_id, status, created_at) VALUES (?, ?, ?, ?)')
    .run(11, 19, 'processing', '2026-07-13T00:00:00.000Z');

  assert.equal(videoService.findActiveForStoryboard(db, 19).id, 11);
});

test('已完成或失败的视频不阻止重新生成', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE video_generations (
    id INTEGER PRIMARY KEY,
    storyboard_id INTEGER,
    status TEXT,
    deleted_at TEXT,
    created_at TEXT
  )`);
  const insert = db.prepare('INSERT INTO video_generations (id, storyboard_id, status, created_at) VALUES (?, ?, ?, ?)');
  insert.run(1, 19, 'completed', '2026-07-13T00:00:00.000Z');
  insert.run(2, 19, 'failed', '2026-07-13T00:01:00.000Z');

  assert.equal(videoService.findActiveForStoryboard(db, 19), null);
});

test('视频记录向前端暴露供应商任务编号和生成参数', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE video_generations (
    id INTEGER PRIMARY KEY, storyboard_id INTEGER, drama_id INTEGER, provider TEXT,
    prompt TEXT, model TEXT, image_gen_id INTEGER, image_url TEXT, video_url TEXT,
    local_path TEXT, status TEXT, task_id TEXT, provider_task_id TEXT, duration INTEGER,
    aspect_ratio TEXT, resolution TEXT, error_msg TEXT, created_at TEXT, updated_at TEXT,
    completed_at TEXT, deleted_at TEXT
  )`);
  db.prepare(`INSERT INTO video_generations
    (id, storyboard_id, status, provider_task_id, duration, aspect_ratio, resolution, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(7, 19, 'processing', '83047', 5, '9:16', '720p', '2026-07-13T00:00:00.000Z');

  const item = videoService.getById(db, 7);
  assert.equal(item.provider_task_id, '83047');
  assert.equal(item.duration, 5);
  assert.equal(item.aspect_ratio, '9:16');
  assert.equal(item.resolution, '720p');
});

test('远程视频成功但未保存本地时返回明确警告', () => {
  assert.match(videoService.localVideoDeliveryWarning(null), /可在线播放/);
  assert.equal(videoService.localVideoDeliveryWarning('videos/ok.mp4'), '');
});
