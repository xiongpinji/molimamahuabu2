const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { execFileSync } = childProcess;
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const assetService = require('../src/services/assetService');
const storageLayout = require('../src/services/storageLayout');
const taskService = require('../src/services/taskService');
const { getFfmpegPath, getFfprobePath } = require('../src/utils/ffmpegPath');

let createVideoToolRoutes = null;
let videoToolService = null;
try {
  createVideoToolRoutes = require('../src/routes/videoTools');
  videoToolService = require('../src/services/videoToolService');
} catch (_) {}

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

function setup(t) {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-video-tools-'));
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, status, created_at, updated_at)
     VALUES ('视频工具测试', 'draft', ?, ?)`,
  ).run(now, now).lastInsertRowid;
  t.after(() => {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });
  return { db, storageRoot, dramaId };
}

function createVideoFixture(root, name = 'source.mp4') {
  const outputPath = path.join(root, name);
  execFileSync(getFfmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24:duration=1.2',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100:duration=1.2',
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    outputPath,
  ]);
  return outputPath;
}

function createSceneFixture(root) {
  const outputPath = path.join(root, 'scenes.mp4');
  execFileSync(getFfmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:size=160x90:rate=24:duration=0.7',
    '-f', 'lavfi', '-i', 'color=c=blue:size=160x90:rate=24:duration=0.7',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1.4',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-map', '2:a:0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    outputPath,
  ]);
  return outputPath;
}

function createAsset(db, dramaId, localPath, name = 'source.mp4') {
  return assetService.create(db, { info() {} }, {
    drama_id: dramaId,
    name,
    type: 'video',
    category: 'canvas',
    url: `/static/${name}`,
    local_path: localPath,
    mime_type: 'video/mp4',
  });
}

function probe(filePath) {
  return JSON.parse(execFileSync(getFfprobePath(), [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath,
  ], { encoding: 'utf8' }));
}

const log = { info() {}, warn() {}, error() {} };

test('视频工具路由只公布真实 FFmpeg 与 ffprobe 能力', () => {
  assert.ok(createVideoToolRoutes, '应提供 videoTools 路由');
  const handlers = createVideoToolRoutes(null, log);
  const res = responseRecorder();

  handlers.capabilities({}, res);

  assert.equal(res.statusCode, 200);
  const operations = res.payload.data.operations;
  assert.deepEqual(Object.keys(operations), [
    'crop',
    'upscale',
    'analyze',
    'remove_subtitles',
    'extract_audio',
    'mute',
    'edit',
  ]);
  assert.equal(operations.crop.engine, 'ffmpeg');
  assert.equal(operations.analyze.engine, 'ffprobe+ffmpeg');
  assert.equal(operations.remove_subtitles.mode, 'selected-region');
  assert.equal(operations.remove_subtitles.filterVerified, true);
  assert.equal(operations.upscale.interpolateAvailable, true);
  assert.equal(operations.crop.encoderVerified, true);
});

test('视频工具能力会随当前 FFmpeg 与 ffprobe 状态更新', (t) => {
  const originalFfmpegPath = process.env.FFMPEG_PATH;
  const originalFfprobePath = process.env.FFPROBE_PATH;
  const realFfmpegPath = getFfmpegPath();
  const realFfprobePath = getFfprobePath();
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-video-capabilities-'));
  const fakeFfmpegPath = path.join(fakeBinDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const fakeFfprobePath = path.join(fakeBinDir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  fs.writeFileSync(fakeFfmpegPath, 'not executable');
  fs.writeFileSync(fakeFfprobePath, 'not executable');
  t.after(() => {
    if (originalFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = originalFfmpegPath;
    if (originalFfprobePath === undefined) delete process.env.FFPROBE_PATH;
    else process.env.FFPROBE_PATH = originalFfprobePath;
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  });

  process.env.FFMPEG_PATH = realFfmpegPath;
  process.env.FFPROBE_PATH = realFfprobePath;
  const availableResponse = responseRecorder();
  createVideoToolRoutes(null, log).capabilities({}, availableResponse);
  assert.equal(availableResponse.payload.data.operations.crop.available, true);

  process.env.FFMPEG_PATH = fakeFfmpegPath;
  process.env.FFPROBE_PATH = fakeFfprobePath;
  const unavailableResponse = responseRecorder();
  createVideoToolRoutes(null, log).capabilities({}, unavailableResponse);
  assert.equal(unavailableResponse.payload.data.operations.crop.available, false);
  assert.equal(unavailableResponse.payload.data.operations.analyze.available, false);
});

test('裁剪创建新视频素材并保留源文件', async (t) => {
  assert.ok(videoToolService, '应提供 videoToolService');
  const { db, storageRoot, dramaId } = setup(t);
  const sourcePath = createVideoFixture(storageRoot);
  const source = createAsset(db, dramaId, sourcePath);

  const result = await videoToolService.createOperation(db, log, {
    assetId: source.id,
    sourceNodeId: 'video-node-1',
    operation: 'crop',
    parameters: { x: 20, y: 10, width: 100, height: 60 },
  }, { cfg: { storage: { local_path: storageRoot } } });

  const output = assetService.getById(db, result.resultAssetId);
  const metadata = probe(output.local_path);
  const video = metadata.streams.find((stream) => stream.codec_type === 'video');
  assert.equal(video.width, 100);
  assert.equal(video.height, 60);
  assert.equal(result.width, 100);
  assert.equal(result.height, 60);
  assert.ok(result.duration > 1);
  assert.equal(fs.existsSync(sourcePath), true);
  assert.equal(taskService.getTask(db, result.taskId).status, 'completed');
});

test('音频分离产生真实音频，移除音频产生无音轨视频', async (t) => {
  assert.ok(videoToolService, '应提供 videoToolService');
  const { db, storageRoot, dramaId } = setup(t);
  const sourcePath = createVideoFixture(storageRoot);
  const source = createAsset(db, dramaId, sourcePath);

  const audioResult = await videoToolService.createOperation(db, log, {
    assetId: source.id,
    sourceNodeId: 'video-node-audio',
    operation: 'extract_audio',
    parameters: {},
  }, { cfg: { storage: { local_path: storageRoot } } });
  const audio = assetService.getById(db, audioResult.resultAssetId);
  assert.equal(audio.type, 'audio');
  const audioMetadata = probe(audio.local_path);
  assert.equal(audioMetadata.streams.some((stream) => stream.codec_type === 'audio'), true);
  assert.equal(audioMetadata.streams.some((stream) => stream.codec_type === 'video'), false);
  assert.ok(audioResult.duration > 0);

  const mutedResult = await videoToolService.createOperation(db, log, {
    assetId: source.id,
    sourceNodeId: 'video-node-muted',
    operation: 'mute',
    parameters: {},
  }, { cfg: { storage: { local_path: storageRoot } } });
  const muted = assetService.getById(db, mutedResult.resultAssetId);
  const mutedStreams = probe(muted.local_path).streams;
  assert.equal(mutedStreams.some((stream) => stream.codec_type === 'video'), true);
  assert.equal(mutedStreams.some((stream) => stream.codec_type === 'audio'), false);
});

test('音频分离输出含视频流时任务失败且不会创建音频素材', async (t) => {
  const { db, storageRoot, dramaId } = setup(t);
  const sourcePath = createVideoFixture(storageRoot);
  const source = createAsset(db, dramaId, sourcePath);
  const originalExecFile = childProcess.execFile;
  t.mock.method(childProcess, 'execFile', (file, args, options, callback) => {
    if (args.includes('-vn')) {
      fs.copyFileSync(sourcePath, args.at(-1));
      callback(null, '', '');
      return { kill() {} };
    }
    return originalExecFile(file, args, options, callback);
  });

  await assert.rejects(videoToolService.createOperation(db, log, {
    assetId: source.id,
    sourceNodeId: 'video-node-invalid-audio-output',
    operation: 'extract_audio',
    parameters: {},
  }, { cfg: { storage: { local_path: storageRoot } } }), (error) => (
    error.code === 'VIDEO_TOOL_PROCESSING_FAILED'
  ));

  const task = db.prepare("SELECT * FROM async_tasks WHERE type = 'video_tool_extract_audio' ORDER BY id DESC LIMIT 1").get();
  assert.equal(task.status, 'failed');
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM assets WHERE category = 'video-tool' AND type = 'audio'").get().total, 0);
  const derivedDir = path.join(storageRoot, 'derived');
  const leftovers = fs.existsSync(derivedDir)
    ? fs.readdirSync(derivedDir).filter((name) => name.endsWith('.m4a'))
    : [];
  assert.deepEqual(leftovers, []);
});

test('视频解析返回真实场景时间轴和可打开关键帧素材', async (t) => {
  assert.ok(videoToolService, '应提供 videoToolService');
  const { db, storageRoot, dramaId } = setup(t);
  const sourcePath = createSceneFixture(storageRoot);
  const source = createAsset(db, dramaId, sourcePath, 'scenes.mp4');

  const result = await videoToolService.createOperation(db, log, {
    assetId: source.id,
    sourceNodeId: 'video-node-story',
    operation: 'analyze',
    parameters: { sceneThreshold: 0.1, maxShots: 8 },
  }, { cfg: { storage: { local_path: storageRoot } } });

  assert.equal(result.resultType, 'video_story');
  assert.ok(result.story.duration > 1);
  assert.ok(result.story.shots.length >= 2, JSON.stringify(result.story));
  for (const shot of result.story.shots) {
    assert.ok(shot.endTime > shot.startTime);
    const frame = assetService.getById(db, shot.keyframeAssetId);
    assert.equal(frame.type, 'image');
    assert.equal(fs.existsSync(frame.local_path), true);
  }
});

test('视频解析命令失败即使 stderr 含帧信息也会失败并回滚', async (t) => {
  const { db, storageRoot, dramaId } = setup(t);
  const sourcePath = createSceneFixture(storageRoot);
  const source = createAsset(db, dramaId, sourcePath, 'failed-scenes.mp4');
  const originalExecFile = childProcess.execFile;
  t.mock.method(childProcess, 'execFile', (file, args, options, callback) => {
    if (args.some((arg) => String(arg).includes('showinfo'))) {
      const error = new Error('模拟视频解析命令失败');
      error.code = 1;
      callback(error, '', 'frame=   12 pts_time:0.42');
      return { kill() {} };
    }
    return originalExecFile(file, args, options, callback);
  });

  await assert.rejects(videoToolService.createOperation(db, log, {
    assetId: source.id,
    sourceNodeId: 'video-node-analyze-command-failure',
    operation: 'analyze',
    parameters: { sceneThreshold: 0.1, maxShots: 8 },
  }, { cfg: { storage: { local_path: storageRoot } } }), (error) => (
    error.code === 'VIDEO_TOOL_PROCESSING_FAILED'
  ));

  const task = db.prepare("SELECT * FROM async_tasks WHERE type = 'video_tool_analyze' ORDER BY id DESC LIMIT 1").get();
  assert.equal(task.status, 'failed');
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM assets WHERE category = 'video-analysis'").get().total, 0);
  const derivedDir = path.join(storageRoot, 'derived');
  const leftovers = fs.existsSync(derivedDir)
    ? fs.readdirSync(derivedDir).filter((name) => name.endsWith('.jpg'))
    : [];
  assert.deepEqual(leftovers, []);
});

test('视频解析中途失败会清理已创建的关键帧文件和素材记录', async (t) => {
  assert.ok(videoToolService, '应提供 videoToolService');
  const { db, storageRoot, dramaId } = setup(t);
  const sourcePath = createSceneFixture(storageRoot);
  const source = createAsset(db, dramaId, sourcePath, 'scenes.mp4');
  const originalCreate = assetService.create;
  let keyframeCreates = 0;
  assetService.create = (...args) => {
    if (args[2]?.category === 'video-analysis' && ++keyframeCreates === 2) {
      throw new Error('模拟第二张关键帧入库失败');
    }
    return originalCreate(...args);
  };
  t.after(() => { assetService.create = originalCreate; });

  await assert.rejects(videoToolService.createOperation(db, log, {
    assetId: source.id,
    sourceNodeId: 'video-node-cleanup',
    operation: 'analyze',
    parameters: { sceneThreshold: 0.1, maxShots: 8 },
  }, { cfg: { storage: { local_path: storageRoot } } }));

  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM assets WHERE category = 'video-analysis'").get().total, 0);
  const derivedDir = path.join(storageRoot, 'derived');
  const leftovers = fs.existsSync(derivedDir)
    ? fs.readdirSync(derivedDir).filter((name) => name.endsWith('.jpg'))
    : [];
  assert.deepEqual(leftovers, []);
});

test('半成品清理失败也会保留原始错误并把任务写为失败', async (t) => {
  const { db, storageRoot, dramaId } = setup(t);
  const sourcePath = createVideoFixture(storageRoot);
  const source = createAsset(db, dramaId, sourcePath);
  const originalCreate = assetService.create;
  const originalRemove = fs.rmSync;
  assetService.create = (...args) => {
    if (args[2]?.category === 'video-tool') throw new Error('模拟素材入库失败');
    return originalCreate(...args);
  };
  let cleanupFailed = false;
  fs.rmSync = (target, options) => {
    if (!cleanupFailed && String(target).includes(`${path.sep}derived${path.sep}`)) {
      cleanupFailed = true;
      throw new Error('模拟半成品清理失败');
    }
    return originalRemove(target, options);
  };
  t.after(() => {
    assetService.create = originalCreate;
    fs.rmSync = originalRemove;
  });

  await assert.rejects(videoToolService.createOperation(db, log, {
    assetId: source.id,
    sourceNodeId: 'video-node-cleanup-error',
    operation: 'crop',
    parameters: { x: 0, y: 0, width: 100, height: 60 },
  }, { cfg: { storage: { local_path: storageRoot } } }), (error) => (
    error.code === 'VIDEO_TOOL_PROCESSING_FAILED' && error.message === '视频处理失败'
  ));

  const task = db.prepare("SELECT * FROM async_tasks WHERE type = 'video_tool_crop' ORDER BY id DESC LIMIT 1").get();
  assert.equal(task.status, 'failed');
  assert.equal(cleanupFailed, true);
});

test('视频元数据资源上限拒绝超长或超大画面输入', () => {
  assert.equal(typeof videoToolService.validateVideoMetadata, 'function');
  assert.throws(
    () => videoToolService.validateVideoMetadata({ width: 1920, height: 1080, duration: 1801 }),
    (error) => error.code === 'VIDEO_TOOL_LIMIT_EXCEEDED',
  );
  assert.throws(
    () => videoToolService.validateVideoMetadata({ width: 8000, height: 8000, duration: 60 }),
    (error) => error.code === 'VIDEO_TOOL_LIMIT_EXCEEDED',
  );
});

test('同时超过两个视频处理任务时返回繁忙且不影响已接收任务', async (t) => {
  const { db, storageRoot, dramaId } = setup(t);
  const sourcePath = createVideoFixture(storageRoot);
  const source = createAsset(db, dramaId, sourcePath);
  const request = (sourceNodeId) => videoToolService.createOperation(db, log, {
    assetId: source.id,
    sourceNodeId,
    operation: 'upscale',
    parameters: { resolution: '1080p', interpolate: false, slowMotion: 1 },
  }, { cfg: { storage: { local_path: storageRoot } } });

  const first = request('concurrent-1');
  const second = request('concurrent-2');
  await assert.rejects(request('concurrent-3'), (error) => error.code === 'VIDEO_TOOL_BUSY');
  const completed = await Promise.all([first, second]);
  assert.equal(completed.every((result) => result.status === 'success'), true);
});

test('视频处理计划覆盖高清、字幕选区和画面编辑的真实滤镜', () => {
  assert.ok(videoToolService, '应提供 videoToolService');
  const metadata = { width: 160, height: 90, duration: 1.2, hasAudio: true, fps: 24 };

  const upscale = videoToolService.buildFfmpegPlan('upscale', {
    resolution: '2k', interpolate: true, slowMotion: 2,
  }, metadata);
  assert.match(upscale.videoFilter, /scale=2560:1440/);
  assert.match(upscale.videoFilter, /force_original_aspect_ratio=decrease/);
  assert.match(upscale.videoFilter, /pad=2560:1440/);
  assert.match(upscale.videoFilter, /minterpolate=fps=60/);
  assert.match(upscale.videoFilter, /setpts=2\*PTS/);

  const subtitles = videoToolService.buildFfmpegPlan('remove_subtitles', {
    x: 8, y: 64, width: 144, height: 20,
  }, metadata);
  assert.match(subtitles.videoFilter, /delogo=x=8:y=64:w=144:h=20/);

  const fullFrameCrop = videoToolService.buildFfmpegPlan('crop', {
    x: 0, y: 0, width: 160, height: 90,
  }, metadata);
  assert.equal(fullFrameCrop.videoFilter, 'crop=160:90:0:0');

  const edit = videoToolService.buildFfmpegPlan('edit', {
    transform: 'mirror-horizontal', brightness: 0.1, contrast: 1.2, saturation: 0.8,
  }, metadata);
  assert.match(edit.videoFilter, /hflip/);
  assert.match(edit.videoFilter, /eq=brightness=0.1:contrast=1.2:saturation=0.8/);
});

test('视频工具拒绝处理素材目录外的伪造路径', async (t) => {
  assert.ok(videoToolService, '应提供 videoToolService');
  const { db, storageRoot, dramaId } = setup(t);
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-video-outside-'));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
  const outsidePath = createVideoFixture(outsideRoot, 'outside.mp4');
  const source = createAsset(db, dramaId, outsidePath, 'outside.mp4');

  await assert.rejects(
    videoToolService.createOperation(db, log, {
      assetId: source.id,
      operation: 'crop',
      parameters: { x: 0, y: 0, width: 100, height: 60 },
    }, { cfg: { storage: { local_path: storageRoot } } }),
    (error) => error.code === 'VIDEO_TOOL_SOURCE_UNAVAILABLE',
  );
});

test('公共平台只处理当前项目素材并把任务绑定到租户与用户', async (t) => {
  const { db, storageRoot, dramaId } = setup(t);
  db.prepare('UPDATE dramas SET tenant_id = ?, user_id = ? WHERE id = ?')
    .run(101, 202, dramaId);
  const projectRoot = path.join(storageRoot, storageLayout.getProjectStorageSubdir(db, dramaId));
  fs.mkdirSync(projectRoot, { recursive: true });
  const sourcePath = createVideoFixture(projectRoot, 'owned.mp4');
  const source = createAsset(db, dramaId, sourcePath, 'owned.mp4');
  const context = {
    cfg: { storage: { local_path: storageRoot } },
    publicPlatformEnabled: true,
    tenantId: 101,
    userId: 202,
  };

  const result = await videoToolService.createOperation(db, log, {
    dramaId,
    assetId: source.id,
    sourceNodeId: 'owned-video-node',
    operation: 'crop',
    parameters: { x: 0, y: 0, width: 100, height: 60 },
  }, context);
  const task = taskService.getTask(db, result.taskId);
  assert.equal(Number(task.tenant_id), 101);
  assert.equal(Number(task.user_id), 202);

  await assert.rejects(videoToolService.createOperation(db, log, {
    dramaId: dramaId + 1,
    assetId: source.id,
    sourceNodeId: 'wrong-project-video-node',
    operation: 'crop',
    parameters: { x: 0, y: 0, width: 100, height: 60 },
  }, context), (error) => error.code === 'VIDEO_TOOL_ASSET_NOT_FOUND');
});
