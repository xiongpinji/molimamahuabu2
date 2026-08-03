const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const assetService = require('./assetService');
const storageLayout = require('./storageLayout');
const taskService = require('./taskService');
const { getFfmpegPath, getFfprobePath } = require('../utils/ffmpegPath');

const execFileAsync = promisify(execFile);
const MAX_CONCURRENT_OPERATIONS = 2;
const MAX_SOURCE_DURATION_SECONDS = 30 * 60;
const MAX_SOURCE_PIXELS = 7680 * 4320;
const FFPROBE_TIMEOUT_MS = 30 * 1000;
const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;
const FRAME_TIMEOUT_MS = 30 * 1000;
let activeOperationCount = 0;
const OPERATIONS = new Set([
  'crop',
  'upscale',
  'analyze',
  'remove_subtitles',
  'extract_audio',
  'mute',
  'edit',
]);

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function resolveStorageRoot(cfg) {
  const configured = cfg?.storage?.local_path;
  const resolved = path.resolve(configured || path.join(process.cwd(), 'data', 'storage'));
  try {
    return fs.realpathSync.native(resolved);
  } catch (_) {
    return resolved;
  }
}

function samePath(left, right) {
  const normalize = process.platform === 'win32'
    ? (value) => value.toLowerCase()
    : (value) => value;
  return normalize(path.resolve(left)) === normalize(path.resolve(right));
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function requireOwnedVideoAsset(db, assetId, requestedDramaId, context) {
  const asset = assetService.getById(db, assetId);
  if (!asset || asset.type !== 'video') fail('VIDEO_TOOL_ASSET_NOT_FOUND', '视频素材不存在');
  if (!context.publicPlatformEnabled) return asset;
  const dramaId = Number(requestedDramaId);
  if (!Number.isInteger(dramaId) || dramaId <= 0 || dramaId !== Number(asset.drama_id)) {
    fail('VIDEO_TOOL_ASSET_NOT_FOUND', '视频素材不存在');
  }
  const owned = context.tenantId
    ? db.prepare(`SELECT id FROM dramas
        WHERE id = ? AND deleted_at IS NULL
          AND (tenant_id = ? OR (tenant_id IS NULL AND user_id = ?))`)
      .get(asset.drama_id, context.tenantId, context.userId)
    : db.prepare('SELECT id FROM dramas WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
      .get(asset.drama_id, context.userId);
  if (!owned) fail('VIDEO_TOOL_ASSET_NOT_FOUND', '视频素材不存在');
  return asset;
}

function resolveSourcePath(asset, storageRoot, allowedRoot) {
  let localPath = asset.local_path;
  if (!localPath && String(asset.url || '').startsWith('/static/')) {
    try {
      localPath = decodeURIComponent(String(asset.url).slice('/static/'.length));
    } catch (_) {
      fail('VIDEO_TOOL_SOURCE_UNAVAILABLE', '源视频地址无效');
    }
  }
  if (!localPath) fail('VIDEO_TOOL_SOURCE_UNAVAILABLE', '源视频没有可处理的本地文件');
  const sourcePath = path.resolve(path.isAbsolute(localPath) ? localPath : path.join(storageRoot, localPath));
  if (!isInside(storageRoot, sourcePath)) {
    fail('VIDEO_TOOL_SOURCE_UNAVAILABLE', '源视频不在允许的素材目录中');
  }
  try {
    const realStorageRoot = fs.realpathSync.native(storageRoot);
    const realAllowedRoot = fs.realpathSync.native(allowedRoot);
    const realSourcePath = fs.realpathSync.native(sourcePath);
    if (!samePath(realStorageRoot, storageRoot)
      || !samePath(realAllowedRoot, allowedRoot)
      || (!samePath(realAllowedRoot, realStorageRoot) && !isInside(realStorageRoot, realAllowedRoot))
      || !isInside(realStorageRoot, realSourcePath)
      || (!samePath(realAllowedRoot, realSourcePath) && !isInside(realAllowedRoot, realSourcePath))
      || !fs.statSync(realSourcePath).isFile()) {
      fail('VIDEO_TOOL_SOURCE_UNAVAILABLE', '源视频不在当前项目的素材目录中');
    }
    return realSourcePath;
  } catch (error) {
    if (error.code === 'VIDEO_TOOL_SOURCE_UNAVAILABLE') throw error;
    fail('VIDEO_TOOL_SOURCE_UNAVAILABLE', '源视频文件不存在');
  }
}

function ensureDerivedDir(sourcePath, allowedRoot) {
  const sourceDir = path.dirname(sourcePath);
  const derivedDir = path.basename(sourceDir).toLowerCase() === 'derived'
    ? sourceDir
    : path.join(sourceDir, 'derived');
  fs.mkdirSync(derivedDir, { recursive: true });
  const realAllowedRoot = fs.realpathSync.native(allowedRoot);
  const realDerivedDir = fs.realpathSync.native(derivedDir);
  if (!samePath(realAllowedRoot, allowedRoot)
    || (!samePath(realAllowedRoot, realDerivedDir) && !isInside(realAllowedRoot, realDerivedDir))) {
    fail('VIDEO_TOOL_SOURCE_UNAVAILABLE', '派生素材目录不在当前项目中');
  }
  return realDerivedDir;
}

function requireNumber(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    fail('VIDEO_TOOL_INVALID_INPUT', `${name} 参数必须在 ${minimum} 到 ${maximum} 之间`);
  }
  return parsed;
}

function requireInteger(value, name, minimum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    fail('VIDEO_TOOL_INVALID_INPUT', `${name} 参数无效`);
  }
  return parsed;
}

function validateVideoMetadata(metadata) {
  const width = Number(metadata?.width);
  const height = Number(metadata?.height);
  const duration = Number(metadata?.duration);
  if (!Number.isFinite(width) || width <= 0
    || !Number.isFinite(height) || height <= 0
    || !Number.isFinite(duration) || duration <= 0) {
    fail('VIDEO_TOOL_UNSUPPORTED_VIDEO', '源视频元数据无效');
  }
  if (duration > MAX_SOURCE_DURATION_SECONDS || width * height > MAX_SOURCE_PIXELS) {
    fail('VIDEO_TOOL_LIMIT_EXCEEDED', '视频超过 30 分钟或 8K 画面处理上限');
  }
  return metadata;
}

function even(value, minimum = 0) {
  const rounded = Math.round(Number(value));
  return Math.max(minimum, rounded - (rounded % 2));
}

function normalizeRegion(parameters, metadata) {
  const x = requireInteger(parameters.x, 'x', 0);
  const y = requireInteger(parameters.y, 'y', 0);
  const width = requireInteger(parameters.width, 'width', 2);
  const height = requireInteger(parameters.height, 'height', 2);
  if (x + width > metadata.width || y + height > metadata.height) {
    fail('VIDEO_TOOL_INVALID_INPUT', '选区超出源视频画面');
  }
  return { x: even(x), y: even(y), width: even(width, 2), height: even(height, 2) };
}

function atempoFilters(speed) {
  const filters = [];
  let value = speed;
  while (value > 2) {
    filters.push('atempo=2');
    value /= 2;
  }
  while (value < 0.5) {
    filters.push('atempo=0.5');
    value /= 0.5;
  }
  filters.push(`atempo=${Number(value.toFixed(4))}`);
  return filters;
}

function buildFfmpegPlan(operation, parameters = {}, metadata = {}) {
  const videoFilters = [];
  const audioFilters = [];
  let outputType = 'video';
  let extension = '.mp4';
  let mimeType = 'video/mp4';
  let copyAudio = true;

  if (operation === 'crop') {
    const region = normalizeRegion(parameters, metadata);
    videoFilters.push(`crop=${region.width}:${region.height}:${region.x}:${region.y}`);
  } else if (operation === 'upscale') {
    const targets = { '1080p': [1920, 1080], '2k': [2560, 1440], '4k': [3840, 2160] };
    const resolution = String(parameters.resolution || '1080p').toLowerCase();
    const target = targets[resolution];
    if (!target) fail('VIDEO_TOOL_INVALID_INPUT', '高清分辨率无效');
    const [landscapeWidth, landscapeHeight] = target;
    const portrait = Number(metadata.height) > Number(metadata.width);
    const width = portrait ? landscapeHeight : landscapeWidth;
    const height = portrait ? landscapeWidth : landscapeHeight;
    videoFilters.push(
      `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
      'unsharp=5:5:0.6:5:5:0',
    );
    if (parameters.interpolate) videoFilters.push('minterpolate=fps=60');
    const slowMotion = requireNumber(parameters.slowMotion ?? 1, 'slowMotion', 1, 4);
    if (slowMotion !== 1) {
      videoFilters.push(`setpts=${slowMotion}*PTS`);
      if (metadata.hasAudio) audioFilters.push(...atempoFilters(1 / slowMotion));
    }
  } else if (operation === 'remove_subtitles') {
    const region = normalizeRegion(parameters, metadata);
    videoFilters.push(`delogo=x=${region.x}:y=${region.y}:w=${region.width}:h=${region.height}`);
  } else if (operation === 'extract_audio') {
    outputType = 'audio';
    extension = '.m4a';
    mimeType = 'audio/mp4';
  } else if (operation === 'mute') {
    copyAudio = false;
  } else if (operation === 'edit') {
    const transforms = {
      'mirror-horizontal': 'hflip',
      'mirror-vertical': 'vflip',
      'rotate-clockwise': 'transpose=1',
      'rotate-counterclockwise': 'transpose=2',
      'rotate-180': 'hflip,vflip',
    };
    const transform = String(parameters.transform || 'none');
    if (transform !== 'none') {
      if (!transforms[transform]) fail('VIDEO_TOOL_INVALID_INPUT', '画面变换参数无效');
      videoFilters.push(transforms[transform]);
    }
    const brightness = requireNumber(parameters.brightness ?? 0, 'brightness', -1, 1);
    const contrast = requireNumber(parameters.contrast ?? 1, 'contrast', 0, 2);
    const saturation = requireNumber(parameters.saturation ?? 1, 'saturation', 0, 3);
    if (brightness !== 0 || contrast !== 1 || saturation !== 1) {
      videoFilters.push(`eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}`);
    }
    const speed = requireNumber(parameters.speed ?? 1, 'speed', 0.25, 4);
    if (speed !== 1) {
      videoFilters.push(`setpts=${Number((1 / speed).toFixed(4))}*PTS`);
      if (metadata.hasAudio) audioFilters.push(...atempoFilters(speed));
    }
    if (!videoFilters.length) fail('VIDEO_TOOL_INVALID_INPUT', '请至少选择一项画面编辑参数');
  }

  return {
    outputType,
    extension,
    mimeType,
    videoFilter: videoFilters.join(','),
    audioFilter: audioFilters.join(','),
    copyAudio,
  };
}

async function probeVideo(sourcePath) {
  try {
    const { stdout } = await execFileAsync(getFfprobePath(), [
      '-v', 'error', '-show_streams', '-show_format', '-of', 'json', sourcePath,
    ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: FFPROBE_TIMEOUT_MS });
    const payload = JSON.parse(stdout);
    const video = payload.streams?.find((stream) => stream.codec_type === 'video');
    if (!video) fail('VIDEO_TOOL_UNSUPPORTED_VIDEO', '源素材没有可处理的视频轨道');
    const rate = String(video.avg_frame_rate || video.r_frame_rate || '0/1').split('/').map(Number);
    return validateVideoMetadata({
      width: Number(video.width),
      height: Number(video.height),
      duration: Number(payload.format?.duration || video.duration || 0),
      hasAudio: payload.streams?.some((stream) => stream.codec_type === 'audio') || false,
      fps: rate[1] ? rate[0] / rate[1] : 0,
    });
  } catch (error) {
    if (error.code?.startsWith('VIDEO_TOOL_')) throw error;
    fail('VIDEO_TOOL_UNSUPPORTED_VIDEO', '无法读取源视频信息');
  }
}

async function runFfmpeg(sourcePath, outputPath, plan) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath];
  if (plan.outputType === 'audio') {
    args.push('-vn', '-c:a', 'aac', '-b:a', '192k');
  } else {
    if (plan.videoFilter) args.push('-vf', plan.videoFilter);
    if (plan.audioFilter) args.push('-af', plan.audioFilter);
    args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p');
    if (!plan.copyAudio) args.push('-an');
    else args.push('-c:a', 'aac', '-b:a', '192k');
    args.push('-movflags', '+faststart');
  }
  args.push(outputPath);
  try {
    await execFileAsync(getFfmpegPath(), args, {
      maxBuffer: 8 * 1024 * 1024,
      timeout: FFMPEG_TIMEOUT_MS,
    });
  } catch (error) {
    throw Object.assign(new Error('视频处理器执行失败'), {
      code: 'VIDEO_TOOL_PROCESSING_FAILED',
      cause: error,
    });
  }
}

function resultUrl(storageRoot, resultPath) {
  return `/static/${path.relative(storageRoot, resultPath).split(path.sep).join('/')}`;
}

function createDerivedAsset(db, log, options) {
  const { asset, request, operation, task, outputPath, outputType, mimeType, metadata, storageRoot } = options;
  const stat = fs.statSync(outputPath);
  return assetService.create(db, log, {
    drama_id: asset.drama_id,
    storyboard_id: asset.storyboard_id,
    name: `${path.parse(asset.name || 'video').name}-${operation}${path.extname(outputPath)}`,
    type: outputType,
    category: 'video-tool',
    url: resultUrl(storageRoot, outputPath),
    local_path: outputPath,
    file_size: stat.size,
    mime_type: mimeType,
    width: outputType === 'video' ? metadata.width : null,
    height: outputType === 'video' ? metadata.height : null,
    duration: metadata.duration || null,
    metadata: {
      sourceAssetId: asset.id,
      sourceNodeId: request.sourceNodeId || null,
      operation,
      parameters: request.parameters || {},
      engine: 'ffmpeg',
      taskId: task.id,
      createdAt: new Date().toISOString(),
    },
  });
}

function parseSceneTimes(stderr, duration, maxShots) {
  const detected = [];
  const expression = /pts_time:([0-9]+(?:\.[0-9]+)?)/g;
  let match;
  while ((match = expression.exec(stderr)) !== null) detected.push(Number(match[1]));
  const boundaries = [0, ...detected.filter((value) => value > 0.08 && value < duration - 0.08), duration]
    .sort((a, b) => a - b)
    .filter((value, index, values) => index === 0 || value - values[index - 1] >= 0.08);
  if (boundaries[boundaries.length - 1] !== duration) boundaries.push(duration);
  const limited = boundaries.slice(0, Math.max(2, maxShots + 1));
  if (limited[limited.length - 1] !== duration) limited[limited.length - 1] = duration;
  return limited;
}

async function analyzeVideo(db, log, options) {
  const {
    sourcePath,
    outputDir,
    asset,
    request,
    task,
    metadata,
    storageRoot,
    outputPaths,
    createdAssetIds,
  } = options;
  const threshold = requireNumber(request.parameters?.sceneThreshold ?? 0.35, 'sceneThreshold', 0.01, 1);
  const maxShots = requireInteger(request.parameters?.maxShots ?? 24, 'maxShots', 1);
  let stderr = '';
  try {
    const output = await execFileAsync(getFfmpegPath(), [
      '-hide_banner', '-i', sourcePath,
      '-filter:v', `select='gt(scene,${threshold})',showinfo`,
      '-an', '-f', 'null', '-',
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: FFMPEG_TIMEOUT_MS });
    stderr = output.stderr || '';
  } catch (error) {
    stderr = error.stderr || '';
    if (!stderr.includes('pts_time') && !stderr.includes('frame=')) {
      throw Object.assign(new Error('视频场景解析失败'), { code: 'VIDEO_TOOL_PROCESSING_FAILED' });
    }
  }
  const boundaries = parseSceneTimes(stderr, metadata.duration, Math.min(maxShots, 120));
  const shots = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startTime = boundaries[index];
    const endTime = boundaries[index + 1];
    if (endTime <= startTime) continue;
    const framePath = path.join(outputDir, `${Date.now()}-${randomUUID()}.jpg`);
    outputPaths.push(framePath);
    const midpoint = Math.min(metadata.duration, startTime + ((endTime - startTime) / 2));
    try {
      await execFileAsync(getFfmpegPath(), [
        '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(midpoint), '-i', sourcePath,
        '-frames:v', '1', '-q:v', '2', framePath,
      ], { maxBuffer: 4 * 1024 * 1024, timeout: FRAME_TIMEOUT_MS });
    } catch (_) {
      throw Object.assign(new Error('关键帧提取失败'), { code: 'VIDEO_TOOL_PROCESSING_FAILED' });
    }
    const frame = assetService.create(db, log, {
      drama_id: asset.drama_id,
      storyboard_id: asset.storyboard_id,
      name: `${path.parse(asset.name || 'video').name}-镜头${index + 1}.jpg`,
      type: 'image',
      category: 'video-analysis',
      url: resultUrl(storageRoot, framePath),
      local_path: framePath,
      file_size: fs.statSync(framePath).size,
      mime_type: 'image/jpeg',
      metadata: {
        sourceAssetId: asset.id,
        sourceNodeId: request.sourceNodeId || null,
        operation: 'analyze',
        taskId: task.id,
        shotIndex: index + 1,
        timestamp: midpoint,
        engine: 'ffprobe+ffmpeg',
      },
    });
    createdAssetIds.push(frame.id);
    shots.push({
      index: index + 1,
      startTime: Number(startTime.toFixed(3)),
      endTime: Number(endTime.toFixed(3)),
      duration: Number((endTime - startTime).toFixed(3)),
      keyframeAssetId: frame.id,
      keyframeUrl: frame.url,
    });
  }
  return {
    taskId: task.id,
    status: 'success',
    sourceAssetId: asset.id,
    operation: 'analyze',
    resultType: 'video_story',
    story: { ...metadata, sceneThreshold: threshold, shots },
  };
}

async function createOperation(db, log, request, context = {}) {
  const operation = String(request.operation || '').trim();
  if (!OPERATIONS.has(operation)) {
    fail('VIDEO_TOOL_OPERATION_UNAVAILABLE', '该视频工具尚未接通真实处理器');
  }
  const asset = requireOwnedVideoAsset(db, request.assetId, request.dramaId, context);
  const storageRoot = resolveStorageRoot(context.cfg);
  const allowedRoot = context.publicPlatformEnabled
    ? path.join(storageRoot, storageLayout.getProjectStorageSubdir(db, asset.drama_id))
    : storageRoot;
  const sourcePath = resolveSourcePath(asset, storageRoot, allowedRoot);
  if (activeOperationCount >= MAX_CONCURRENT_OPERATIONS) {
    fail('VIDEO_TOOL_BUSY', '视频处理任务繁忙，请稍后重试');
  }
  activeOperationCount += 1;
  let task = null;
  const outputPaths = [];
  const createdAssetIds = [];
  try {
    task = taskService.createTask(db, log, `video_tool_${operation}`, String(request.sourceNodeId || asset.id));
    if (context.tenantId || context.userId) {
      db.prepare('UPDATE async_tasks SET tenant_id = ?, user_id = ? WHERE id = ?')
        .run(context.tenantId || null, context.userId || null, task.id);
    }
    taskService.updateTaskStatus(db, task.id, 'processing', 10, '正在处理视频');
    context.onTaskCreated?.(task);

    const metadata = await probeVideo(sourcePath);
    const outputDir = ensureDerivedDir(sourcePath, allowedRoot);
    if (operation === 'analyze') {
      const result = await analyzeVideo(db, log, {
        sourcePath,
        outputDir,
        asset,
        request,
        task,
        metadata,
        storageRoot,
        outputPaths,
        createdAssetIds,
      });
      taskService.updateTaskResult(db, task.id, result);
      return result;
    }

    const plan = buildFfmpegPlan(operation, request.parameters || {}, metadata);
    if (plan.outputType === 'audio' && !metadata.hasAudio) {
      fail('VIDEO_TOOL_INVALID_INPUT', '源视频没有可分离的音频轨道');
    }
    const outputPath = path.join(outputDir, `${Date.now()}-${randomUUID()}${plan.extension}`);
    outputPaths.push(outputPath);
    await runFfmpeg(sourcePath, outputPath, plan);
    const outputMetadata = plan.outputType === 'video'
      ? await probeVideo(outputPath)
      : { width: null, height: null, duration: metadata.duration };
    let result;
    db.transaction(() => {
      const resultAsset = createDerivedAsset(db, log, {
        asset,
        request,
        operation,
        task,
        outputPath,
        outputType: plan.outputType,
        mimeType: plan.mimeType,
        metadata: outputMetadata,
        storageRoot,
      });
      result = {
        taskId: task.id,
        status: 'success',
        sourceAssetId: asset.id,
        resultAssetId: resultAsset.id,
        resultUrl: resultAsset.url,
        resultType: resultAsset.type,
        width: outputMetadata.width,
        height: outputMetadata.height,
        duration: outputMetadata.duration,
        operation,
      };
      taskService.updateTaskResult(db, task.id, result);
    })();
    return result;
  } catch (error) {
    const cleanupErrors = [];
    if (createdAssetIds.length) {
      try {
        db.transaction(() => {
          const removeAsset = db.prepare('DELETE FROM assets WHERE id = ?');
          for (const assetId of createdAssetIds) removeAsset.run(assetId);
        })();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    for (const outputPath of outputPaths) {
      try {
        if (fs.existsSync(outputPath)) fs.rmSync(outputPath, { force: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    const exposed = error.code?.startsWith('VIDEO_TOOL_')
      ? error
      : Object.assign(new Error('视频处理失败'), { code: 'VIDEO_TOOL_PROCESSING_FAILED' });
    if (task) taskService.updateTaskError(db, task.id, exposed.message);
    if (cleanupErrors.length) {
      log.warn?.('video tool cleanup failed', {
        operation,
        task_id: task?.id,
        errors: cleanupErrors.map((cleanupError) => cleanupError.message),
      });
    }
    log.error('video tool processing failed', { operation, task_id: task?.id, error: error.message });
    throw exposed;
  } finally {
    activeOperationCount -= 1;
  }
}

function getOperation(db, taskId, context = {}) {
  const task = taskService.getTask(db, taskId);
  if (!task || !String(task.type || '').startsWith('video_tool_')) return null;
  if (!context.publicPlatformEnabled) return task;
  if (context.tenantId) {
    return String(task.tenant_id || '') === String(context.tenantId) ? task : null;
  }
  return context.userId && String(task.user_id || '') === String(context.userId) ? task : null;
}

module.exports = {
  buildFfmpegPlan,
  createOperation,
  getOperation,
  validateVideoMetadata,
};
