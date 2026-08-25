const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const imageService = require('../src/services/imageService');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE image_generations (
    id INTEGER PRIMARY KEY,
    storyboard_id INTEGER,
    frame_type TEXT,
    status TEXT,
    created_at TEXT,
    deleted_at TEXT
  )`);
  return db;
}

test('同一分镜同一帧类型存在处理中图片时复用', () => {
  const db = createDb();
  db.prepare('INSERT INTO image_generations (id, storyboard_id, frame_type, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(21, 19, 'storyboard_first', 'processing', '2026-07-13T00:00:00.000Z');

  assert.equal(imageService.findActiveForTarget(db, 19, 'storyboard_first').id, 21);
  db.close();
});

test('同一分镜同一帧类型存在结果未知图片时阻止重复提交', () => {
  const db = createDb();
  db.prepare('INSERT INTO image_generations (id, storyboard_id, frame_type, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(23, 19, 'storyboard_first', 'needs_attention', '2026-07-13T00:02:00.000Z');

  assert.equal(imageService.findActiveForTarget(db, 19, 'storyboard_first').id, 23);
  db.close();
});

test('同一分镜首帧任务不阻止尾帧生成', () => {
  const db = createDb();
  db.prepare('INSERT INTO image_generations (id, storyboard_id, frame_type, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(21, 19, 'storyboard_first', 'pending', '2026-07-13T00:00:00.000Z');

  assert.equal(imageService.findActiveForTarget(db, 19, 'storyboard_last'), null);
  db.close();
});

test('已完成或失败的图片任务不阻止重新生成', () => {
  const db = createDb();
  const insert = db.prepare('INSERT INTO image_generations (id, storyboard_id, frame_type, status, created_at) VALUES (?, ?, ?, ?, ?)');
  insert.run(21, 19, 'storyboard_first', 'completed', '2026-07-13T00:00:00.000Z');
  insert.run(22, 19, 'storyboard_first', 'failed', '2026-07-13T00:01:00.000Z');

  assert.equal(imageService.findActiveForTarget(db, 19, 'storyboard_first'), null);
  db.close();
});
