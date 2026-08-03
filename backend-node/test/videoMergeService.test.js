const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const videoMergeService = require('../src/services/videoMergeService');
const taskService = require('../src/services/taskService');
const dramaService = require('../src/services/dramaService');

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE async_tasks (
      id TEXT PRIMARY KEY,
      type TEXT,
      status TEXT,
      progress INTEGER DEFAULT 0,
      message TEXT,
      error TEXT,
      result TEXT,
      resource_id TEXT,
      created_at TEXT,
      updated_at TEXT,
      completed_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE video_merges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id INTEGER,
      drama_id INTEGER,
      title TEXT,
      provider TEXT,
      model TEXT,
      status TEXT,
      scenes TEXT,
      merge_options TEXT,
      task_id TEXT,
      merged_url TEXT,
      duration INTEGER,
      error_msg TEXT,
      created_at TEXT,
      completed_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY,
      drama_id INTEGER,
      episode_number INTEGER,
      status TEXT,
      video_url TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE dramas (
      id INTEGER PRIMARY KEY,
      title TEXT,
      deleted_at TEXT
    );
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY,
      episode_id INTEGER,
      storyboard_number INTEGER,
      duration INTEGER,
      video_url TEXT,
      local_path TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE video_generations (
      id INTEGER PRIMARY KEY,
      storyboard_id INTEGER,
      status TEXT,
      video_url TEXT,
      local_path TEXT,
      created_at TEXT,
      updated_at TEXT,
      completed_at TEXT,
      deleted_at TEXT
    );
  `);
  db.prepare('INSERT INTO dramas (id, title) VALUES (?, ?)').run(45, '测试短剧');
  db.prepare('INSERT INTO episodes (id, drama_id, episode_number, status) VALUES (?, ?, ?, ?)')
    .run(28, 45, 1, 'processing');
  return db;
}

const log = {
  info() {},
  warn() {},
  error() {},
};

describe('videoMergeService production safety', () => {
  it('reuses an active merge for the same episode instead of creating duplicate work', () => {
    const db = createTestDb();
    const request = {
      episode_id: 28,
      drama_id: 45,
      scenes: [{ scene_id: 1, video_url: 'missing-1.mp4', duration: 5 }],
    };

    const first = videoMergeService.create(db, log, request);
    const second = videoMergeService.create(db, log, request);

    assert.equal(second.reused, true);
    assert.equal(second.merge_id, first.merge_id);
    assert.equal(second.task_id, first.task_id);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_merges').get().count, 1);
  });

  it('marks merge, task and episode failed when source clips cannot all be read', async () => {
    const db = createTestDb();
    const created = videoMergeService.create(db, log, {
      episode_id: 28,
      drama_id: 45,
      scenes: [
        { scene_id: 1, video_url: 'missing-1.mp4', duration: 5 },
        { scene_id: 2, video_url: 'missing-2.mp4', duration: 5 },
      ],
    });

    await videoMergeService.processVideoMerge(db, log, created.merge_id, 'http://localhost:5679/static');

    const merge = videoMergeService.getById(db, created.merge_id);
    const task = taskService.getTask(db, created.task_id);
    const episode = db.prepare('SELECT status, video_url FROM episodes WHERE id = ?').get(28);
    assert.equal(merge.status, 'failed');
    assert.match(merge.error_msg, /视频片段.*读取|视频片段.*不完整/);
    assert.equal(task.status, 'failed');
    assert.equal(episode.status, 'failed');
    assert.equal(episode.video_url, null);
  });

  it('refuses to finalize an episode when any storyboard is missing a video', () => {
    const db = createTestDb();
    db.prepare('UPDATE episodes SET status = ? WHERE id = ?').run('draft', 28);
    const insert = db.prepare(
      `INSERT INTO storyboards
       (id, episode_id, storyboard_number, duration, video_url, updated_at)
       VALUES (?, 28, ?, 5, ?, ?)`
    );
    insert.run(101, 1, '/static/videos/shot-1.mp4', '2026-08-03T00:00:00.000Z');
    insert.run(102, 2, null, '2026-08-03T00:00:00.000Z');

    const originalSetImmediate = global.setImmediate;
    let scheduled = false;
    global.setImmediate = () => { scheduled = true; };
    try {
      const result = dramaService.finalizeEpisode(db, log, 28, 'http://localhost:5679/static');

      assert.equal(result.task_id, null);
      assert.equal(result.scenes_count, 1);
      assert.equal(result.missing_storyboards_count, 1);
      assert.match(result.message, /缺少视频/);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_merges').get().count, 0);
      assert.equal(db.prepare('SELECT status FROM episodes WHERE id = 28').get().status, 'draft');
      assert.equal(scheduled, false);
    } finally {
      global.setImmediate = originalSetImmediate;
    }
  });

  it('does not schedule the same active episode merge twice', () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO storyboards
       (id, episode_id, storyboard_number, duration, video_url, updated_at)
       VALUES (101, 28, 1, 5, '/static/videos/shot-1.mp4', ?)`
    ).run('2026-08-03T00:00:00.000Z');
    const active = videoMergeService.create(db, log, {
      episode_id: 28,
      drama_id: 45,
      scenes: [{ scene_id: 101, video_url: '/static/videos/shot-1.mp4', duration: 5 }],
    });

    const originalSetImmediate = global.setImmediate;
    let scheduled = false;
    global.setImmediate = () => { scheduled = true; };
    try {
      const result = dramaService.finalizeEpisode(db, log, 28, 'http://localhost:5679/static');

      assert.equal(result.reused, true);
      assert.equal(result.merge_id, active.merge_id);
      assert.equal(result.task_id, active.task_id);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_merges').get().count, 1);
      assert.equal(scheduled, false);
    } finally {
      global.setImmediate = originalSetImmediate;
    }
  });
});
