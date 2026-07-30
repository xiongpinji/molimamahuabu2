const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const Database = require('better-sqlite3');

test('尾帧提取使用制作页当前选中的视频并写入下一分镜首帧', async (t) => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-tail-frame-'));
  t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }));

  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY,
      episode_id INTEGER NOT NULL,
      storyboard_number INTEGER NOT NULL,
      first_frame_image_id INTEGER,
      image_url TEXT,
      local_path TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE video_generations (
      id INTEGER PRIMARY KEY,
      storyboard_id INTEGER NOT NULL,
      local_path TEXT,
      video_url TEXT,
      status TEXT,
      created_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE image_generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drama_id INTEGER,
      episode_id INTEGER,
      storyboard_id INTEGER,
      prompt TEXT,
      provider TEXT,
      model TEXT,
      status TEXT,
      image_url TEXT,
      local_path TEXT,
      width INTEGER,
      height INTEGER,
      created_at TEXT,
      updated_at TEXT,
      completed_at TEXT
    );
  `);
  db.prepare('INSERT INTO storyboards (id, episode_id, storyboard_number) VALUES (?, ?, ?)').run(1, 7, 1);
  db.prepare('INSERT INTO storyboards (id, episode_id, storyboard_number) VALUES (?, ?, ?)').run(2, 7, 2);

  const videosDir = path.join(storageDir, 'media', 'videos');
  fs.mkdirSync(videosDir, { recursive: true });
  fs.writeFileSync(path.join(videosDir, 'selected.mp4'), 'selected');
  fs.writeFileSync(path.join(videosDir, 'latest.mp4'), 'latest');
  db.prepare(`
    INSERT INTO video_generations (id, storyboard_id, local_path, status, created_at)
    VALUES (?, ?, ?, 'completed', ?)
  `).run(101, 1, 'media/videos/selected.mp4', '2026-07-30T00:00:00.000Z');
  db.prepare(`
    INSERT INTO video_generations (id, storyboard_id, local_path, status, created_at)
    VALUES (?, ?, ?, 'completed', ?)
  `).run(102, 1, 'media/videos/latest.mp4', '2026-07-30T01:00:00.000Z');

  const ffmpegPath = require('../src/utils/ffmpegPath');
  const originalHasLocalFfmpeg = ffmpegPath.hasLocalFfmpeg;
  const originalGetFfmpegPath = ffmpegPath.getFfmpegPath;
  const originalSpawnSync = childProcess.spawnSync;
  let extractedFrom = '';
  ffmpegPath.hasLocalFfmpeg = () => true;
  ffmpegPath.getFfmpegPath = () => 'ffmpeg';
  childProcess.spawnSync = (_command, args) => {
    if (args.includes('-show_entries')) return { status: 0, stdout: '1280x720' };
    extractedFrom = args[args.indexOf('-i') + 1];
    fs.writeFileSync(args.at(-1), 'frame');
    return { status: 0, stderr: '' };
  };
  t.after(() => {
    ffmpegPath.hasLocalFfmpeg = originalHasLocalFfmpeg;
    ffmpegPath.getFfmpegPath = originalGetFfmpegPath;
    childProcess.spawnSync = originalSpawnSync;
  });

  const servicePath = require.resolve('../src/services/tailFrameLinkService');
  delete require.cache[servicePath];
  const service = require(servicePath)(
    db,
    { storage: { local_path: storageDir } },
    { info() {}, error() {} },
  );
  const result = { status: 200, body: null };
  const req = { params: { id: '1' }, body: { drama_id: 9, video_id: 101 } };
  const res = {
    status(code) {
      result.status = code;
      return this;
    },
    json(body) {
      result.body = body;
      return this;
    },
  };

  await service.linkTailFrame(req, res);

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(extractedFrom, path.join(storageDir, 'media', 'videos', 'selected.mp4'));
  const nextStoryboard = db.prepare('SELECT first_frame_image_id, local_path FROM storyboards WHERE id = 2').get();
  assert.equal(nextStoryboard.first_frame_image_id, result.body.new_first_frame_image_id);
  assert.equal(nextStoryboard.local_path, result.body.local_path);
});
