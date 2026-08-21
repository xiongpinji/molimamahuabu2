const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const assetService = require('../src/services/assetService');
const taskService = require('../src/services/taskService');
const { getFfmpegPath, getFfprobePath } = require('../src/utils/ffmpegPath');
const routeIndexSource = fs.readFileSync(path.join(__dirname, '../src/routes/index.js'), 'utf8');

let createVideoToolRoutes = null;
let videoToolService = null;
try {
  createVideoToolRoutes = require('../src/routes/videoTools');
  videoToolService = require('../src/services/videoToolService');
} catch (_) {}

test('主路由实际注册视频工具能力与处理接口', () => {
  assert.match(routeIndexSource, /const videoToolRoutes = require\('\.\/videoTools'\)/);
  assert.match(routeIndexSource, /const videoTools = videoToolRoutes\(db, log,/);
  assert.match(routeIndexSource, /r\.get\('\/video-tools\/capabilities', videoTools\.capabilities\)/);
  assert.match(routeIndexSource, /r\.post\('\/video-tools\/operations', videoTools\.createOperation\)/);
  assert.match(routeIndexSource, /r\.get\('\/video-tools\/operations\/:taskId', videoTools\.getOperation\)/);
});

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
  assert.equal(probe(audio.local_path).streams.some((stream) => stream.codec_type === 'audio'), true);

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
