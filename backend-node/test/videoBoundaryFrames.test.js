const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const videoService = require('../src/services/videoService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

test('视频完成后提取首帧和尾帧并返回可访问地址', () => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-video-frames-'));
  const localPath = path.join('videos', 'sample.mp4');
  const videoPath = path.join(storagePath, localPath);
  fs.mkdirSync(path.dirname(videoPath), { recursive: true });
  fs.writeFileSync(videoPath, 'video');

  const commands = [];
  const result = videoService.extractVideoBoundaryFrames(
    storagePath,
    localPath,
    42,
    { warn() {}, info() {} },
    {
      ffmpegPath: 'ffmpeg',
      hasFfmpeg: true,
      run(command, args) {
        commands.push({ command, args });
        fs.writeFileSync(args.at(-1), 'frame');
        return { status: 0, stderr: '' };
      },
    }
  );

  assert.equal(result.output_first_frame_url, '/static/videos/vg_42_first.jpg');
  assert.equal(result.output_last_frame_url, '/static/videos/vg_42_last.jpg');
  assert.equal(commands.length, 2);
  assert.ok(commands[0].args.includes('-frames:v'));
  assert.deepEqual(
    commands[1].args.slice(0, -1),
    ['-y', '-sseof', '-1', '-i', videoPath, '-map', '0:v:0', '-update', '1', '-q:v', '2']
  );
});

test('本地无 ffmpeg 时首尾帧提取保持可选且不影响视频完成', () => {
  const result = videoService.extractVideoBoundaryFrames(
    'C:\\storage',
    'videos\\sample.mp4',
    42,
    { warn() {}, info() {} },
    { hasFfmpeg: false }
  );

  assert.deepEqual(result, {
    output_first_frame_url: null,
    output_last_frame_url: null,
  });
});

test('历史视频仅有本地成片时可按需补抽并持久化首尾帧', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-video-frame-fallback-'));
  const localPath = path.join('videos', 'legacy.mp4');
  const videoPath = path.join(storagePath, localPath);
  fs.mkdirSync(path.dirname(videoPath), { recursive: true });
  fs.writeFileSync(videoPath, 'video');
  const now = new Date().toISOString();
  const inserted = db.prepare(`
    INSERT INTO video_generations
      (drama_id, model, status, video_url, local_path, user_id, tenant_id, created_at, updated_at)
    VALUES (?, ?, 'completed', ?, ?, ?, ?, ?, ?)
  `).run(1, 'lingjing-video-v1', 'https://provider.example/legacy.mp4', localPath, 'user-1', 'tenant-a', now, now);

  const item = videoService.ensureBoundaryFrames(
    db,
    { warn() {}, info() {} },
    { video_generation_id: Number(inserted.lastInsertRowid) },
    {
      billingEnabled: true,
      userId: 'user-1',
      tenantId: 'tenant-a',
      storagePath,
      extractionOptions: {
        hasFfmpeg: true,
        run(_command, args) {
          fs.writeFileSync(args.at(-1), 'frame');
          return { status: 0, stderr: '' };
        },
      },
    }
  );

  assert.equal(item.output_first_frame_url, `/static/videos/vg_${inserted.lastInsertRowid}_first.jpg`);
  assert.equal(item.output_last_frame_url, `/static/videos/vg_${inserted.lastInsertRowid}_last.jpg`);
  const persisted = db.prepare(
    'SELECT output_first_frame_url, output_last_frame_url FROM video_generations WHERE id = ?'
  ).get(inserted.lastInsertRowid);
  assert.equal(persisted.output_first_frame_url, item.output_first_frame_url);
  assert.equal(persisted.output_last_frame_url, item.output_last_frame_url);
});

test('按需补抽尾帧不能读取其他租户的视频记录', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const inserted = db.prepare(`
    INSERT INTO video_generations
      (drama_id, model, status, video_url, local_path, user_id, tenant_id, created_at, updated_at)
    VALUES (?, ?, 'completed', ?, ?, ?, ?, ?, ?)
  `).run(
    1,
    'lingjing-video-v1',
    'https://provider.example/private.mp4',
    path.join('videos', 'private.mp4'),
    'user-1',
    'tenant-a',
    now,
    now
  );

  assert.throws(
    () => videoService.ensureBoundaryFrames(
      db,
      { warn() {}, info() {} },
      { video_generation_id: Number(inserted.lastInsertRowid) },
      {
        billingEnabled: true,
        userId: 'user-2',
        tenantId: 'tenant-b',
      }
    ),
    (error) => error?.code === 'VIDEO_NOT_FOUND'
  );
});
