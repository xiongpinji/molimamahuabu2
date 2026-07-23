const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { getFfmpegPath, hasLocalFfmpeg } = require('../src/utils/ffmpegPath');
const directorExport = require('../src/services/directorExportService');
const taskService = require('../src/services/taskService');

describe('directorExportService', () => {
  it('normalizes timeline input and rejects invalid shapes', () => {
    assert.deepEqual(directorExport.normalizeTimeline('{"shots":[]}'), { shots: [] });
    assert.deepEqual(directorExport.summarizeTimeline({ sequence: { fps: 30, duration: 4 }, shots: [{}], tracks: [{ clips: [{}, {}] }] }), {
      fps: 30, duration: 4, shot_count: 1, track_count: 1, action_clip_count: 2,
    });
    assert.throws(() => directorExport.normalizeTimeline('[]'), /必须是对象/);
    assert.throws(() => directorExport.normalizeTimeline('{bad'), /合法 JSON/);
  });

  it('transcodes a browser WebM into a project MP4 task result', async (t) => {
    if (!hasLocalFfmpeg()) return t.skip('ffmpeg unavailable');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-director-'));
    const inputPath = path.join(tempRoot, 'input.webm');
    const generated = spawnSync(getFfmpegPath(), [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=161x91:r=12',
      '-t', '0.25', '-c:v', 'libvpx-vp9', '-an', '-y', inputPath,
    ], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr || generated.error?.message);

    const db = new Database(':memory:');
    runMigrationsAndEnsure(db);
    const now = new Date().toISOString();
    const dramaId = db.prepare(
      `INSERT INTO dramas (title, status, created_at, updated_at) VALUES ('导演台测试', 'draft', ?, ?)`
    ).run(now, now).lastInsertRowid;
    const task = directorExport.createDirectorExportTask({
      db,
      cfg: { storage: { local_path: tempRoot, base_url: 'http://localhost:5679/static' } },
      log: { info() {}, warn() {}, error() {} },
      dramaId,
      file: { buffer: fs.readFileSync(inputPath) },
      timeline: { sequence: { fps: 12, duration: 0.25 }, shots: [], tracks: [] },
    });
    let result;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      result = db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(task.id);
      if (result.status === 'completed' || result.status === 'failed') break;
    }
    assert.equal(result.status, 'completed', result.error || result.message);
    const taskResult = JSON.parse(result.result);
    assert.match(taskResult.url, /director_.*\.mp4$/);
    assert.equal(fs.existsSync(path.join(tempRoot, taskResult.local_path)), true);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM assets WHERE type = 'video' AND category = 'director'").get().count, 1);
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('normalizes odd browser canvas dimensions for H.264', () => {
    const args = directorExport.buildFfmpegArgs('input.webm', 'output.mp4');
    assert.deepEqual(args.slice(args.indexOf('-vf'), args.indexOf('-vf') + 2), [
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    ]);
  });

  it('terminates a stalled FFmpeg process and removes partial files', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-director-timeout-'));
    const inputPath = path.join(tempRoot, 'input.webm');
    const outputPath = path.join(tempRoot, 'partial.mp4');
    const metadataFilePath = path.join(tempRoot, 'partial.json');
    fs.writeFileSync(inputPath, 'input');
    fs.writeFileSync(outputPath, 'partial');
    fs.writeFileSync(metadataFilePath, '{}');
    const db = new Database(':memory:');
    runMigrationsAndEnsure(db);
    const task = taskService.createTask(db, { info() {}, warn() {}, error() {} }, 'director_export', '1');
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    let killedWith = '';
    let processClosed = false;
    child.kill = (signal) => {
      killedWith = signal;
      setTimeout(() => {
        processClosed = true;
        child.emit('close', null);
      }, 5);
      return true;
    };
    const unlinkSync = fs.unlinkSync;
    fs.unlinkSync = (filePath) => {
      if (!processClosed && [inputPath, outputPath, metadataFilePath].includes(filePath)) {
        const error = new Error('file is still in use');
        error.code = 'EPERM';
        throw error;
      }
      return unlinkSync(filePath);
    };

    try {
      directorExport.startFfmpegTask({
        db,
        cfg: { storage: { local_path: tempRoot } },
        log: { info() {}, warn() {}, error() {} },
        task,
        dramaId: 1,
        inputPath,
        outputPath,
        outputRelativePath: 'partial.mp4',
        metadataPath: 'partial.json',
        metadataFilePath,
        timeline: null,
        timelineSummary: {},
        spawnProcess: () => child,
        timeoutMs: 10,
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
    } finally {
      fs.unlinkSync = unlinkSync;
    }

    const failedTask = taskService.getTask(db, task.id);
    assert.equal(failedTask.status, 'failed');
    assert.match(failedTask.error, /视频转码超时/);
    assert.equal(killedWith, 'SIGKILL');
    assert.equal(fs.existsSync(inputPath), false);
    assert.equal(fs.existsSync(outputPath), false);
    assert.equal(fs.existsSync(metadataFilePath), false);
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});
