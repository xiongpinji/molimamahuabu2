const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { getFfmpegPath, hasLocalFfmpeg } = require('../utils/ffmpegPath');
const assetService = require('./assetService');
const storageLayout = require('./storageLayout');
const taskService = require('./taskService');

const MAX_TIMELINE_BYTES = 2 * 1024 * 1024;
const DEFAULT_FFMPEG_TIMEOUT_MS = 15 * 60 * 1000;

function storageRootFromConfig(cfg) {
  const raw = cfg?.storage?.local_path || './data/storage';
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

function publicUrlFromRelative(cfg, relativePath) {
  const baseUrl = String(cfg?.storage?.base_url || '').replace(/\/$/, '');
  return baseUrl ? `${baseUrl}/${relativePath}` : `/static/${relativePath}`;
}

function normalizeTimeline(value) {
  if (value == null || value === '') return null;
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (_) {
      throw new Error('timeline 必须是合法 JSON');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('timeline 必须是对象');
  }
  const serialized = JSON.stringify(parsed);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_TIMELINE_BYTES) {
    throw new Error('timeline 不能超过 2MB');
  }
  return parsed;
}

function summarizeTimeline(timeline) {
  const sequence = timeline?.sequence || {};
  const shots = Array.isArray(timeline?.shots) ? timeline.shots : [];
  const tracks = Array.isArray(timeline?.tracks) ? timeline.tracks : [];
  return {
    fps: Number(sequence.fps) || 24,
    duration: Math.max(0, Number(sequence.duration) || 0),
    shot_count: shots.length,
    track_count: tracks.length,
    action_clip_count: tracks.reduce((count, track) => count + (Array.isArray(track?.clips) ? track.clips.length : 0), 0),
  };
}

function buildFfmpegArgs(inputPath, outputPath) {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    '-y',
    outputPath,
  ];
}

function setTaskUser(db, taskId, userId) {
  if (!userId) return;
  try {
    db.prepare('UPDATE async_tasks SET user_id = ? WHERE id = ?').run(String(userId), taskId);
  } catch (error) {
    // 旧数据库可能还没有 user_id；本地单用户模式无需写入。
    if (!String(error.message || '').includes('user_id')) throw error;
  }
}

function startFfmpegTask({
  db, cfg, log, task, dramaId, inputPath, outputPath, outputRelativePath,
  metadataPath, metadataFilePath, timeline, timelineSummary, spawnProcess = spawn,
  timeoutMs = DEFAULT_FFMPEG_TIMEOUT_MS,
}) {
  taskService.updateTaskStatus(db, task.id, 'processing', 5, '正在转码 MP4');
  const child = spawnProcess(getFfmpegPath(), buildFfmpegArgs(inputPath, outputPath), {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let settled = false;
  let stderr = '';
  const removeFile = (filePath) => {
    if (!filePath) return;
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
  };
  const removeFailedFiles = () => {
    removeFile(inputPath);
    removeFile(outputPath);
    removeFile(metadataFilePath);
  };
  const failTask = (message) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    removeFailedFiles();
    taskService.updateTaskError(db, task.id, message);
  };
  const timeout = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
    failTask(`视频转码超时（${Math.ceil(timeoutMs / 60000)} 分钟）`);
  }, timeoutMs);
  timeout.unref?.();
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  child.on('error', (error) => {
    failTask(`FFmpeg 启动失败：${error.message}`);
  });
  child.on('close', (code) => {
    if (settled) {
      removeFailedFiles();
      return;
    }
    settled = true;
    clearTimeout(timeout);
    removeFile(inputPath);
    if (code !== 0 || !fs.existsSync(outputPath)) {
      removeFailedFiles();
      const detail = stderr.trim().split(/\r?\n/).pop() || `退出码 ${code}`;
      taskService.updateTaskError(db, task.id, `视频转码失败：${detail}`);
      return;
    }
    const outputStat = fs.statSync(outputPath);
    try {
      const asset = assetService.create(db, log, {
        drama_id: dramaId,
        name: `导演台导出 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        type: 'video',
        category: 'director',
        url: publicUrlFromRelative(cfg, outputRelativePath),
        local_path: outputRelativePath,
        file_size: outputStat.size,
        mime_type: 'video/mp4',
      });
      taskService.updateTaskResult(db, task.id, {
        format: 'mp4',
        url: publicUrlFromRelative(cfg, outputRelativePath),
        local_path: outputRelativePath,
        metadata_path: metadataPath,
        timeline,
        timeline_summary: timelineSummary,
        asset_id: asset?.id || null,
      });
    } catch (error) {
      taskService.updateTaskError(db, task.id, `导出结果入库失败：${error.message}`);
    }
  });
}

function createDirectorExportTask({ db, cfg, log, dramaId, file, timeline, userId }) {
  if (!file?.buffer?.length) throw new Error('请选择 WebM 视频文件');
  if (!hasLocalFfmpeg()) {
    const error = new Error('服务器未安装 FFmpeg，无法导出 MP4');
    error.code = 'FFMPEG_UNAVAILABLE';
    throw error;
  }
  const normalizedTimeline = normalizeTimeline(timeline);
  const timelineSummary = summarizeTimeline(normalizedTimeline || {});
  const numericDramaId = Number(dramaId);
  if (!Number.isInteger(numericDramaId) || numericDramaId <= 0) throw new Error('drama_id 无效');

  const task = taskService.createTask(db, log, 'director_export', String(numericDramaId));
  setTaskUser(db, task.id, userId);
  const storageRoot = storageRootFromConfig(cfg);
  const projectSubdir = storageLayout.getProjectStorageSubdir(db, numericDramaId);
  const exportDir = path.join(storageRoot, projectSubdir, 'videos', 'director');
  fs.mkdirSync(exportDir, { recursive: true });
  const basename = `director_${Date.now()}_${task.id.slice(0, 8)}`;
  const inputPath = path.join(os.tmpdir(), `${basename}.webm`);
  const outputPath = path.join(exportDir, `${basename}.mp4`);
  const metadataPath = path.join(exportDir, `${basename}.json`);
  const outputRelativePath = path.relative(storageRoot, outputPath).replace(/\\/g, '/');
  const metadataRelativePath = path.relative(storageRoot, metadataPath).replace(/\\/g, '/');
  try {
    fs.writeFileSync(inputPath, file.buffer);
    fs.writeFileSync(metadataPath, JSON.stringify({ drama_id: numericDramaId, task_id: task.id, timeline: normalizedTimeline, timeline_summary: timelineSummary }, null, 2), 'utf8');
  } catch (error) {
    try { if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath); } catch (_) {}
    taskService.updateTaskError(db, task.id, `导出文件写入失败：${error.message}`);
    throw error;
  }
  setImmediate(() => startFfmpegTask({
    db,
    cfg,
    log,
    task,
    dramaId: numericDramaId,
    inputPath,
    outputPath,
    outputRelativePath,
    metadataPath: metadataRelativePath,
    metadataFilePath: metadataPath,
    timeline: normalizedTimeline,
    timelineSummary,
  }));
  return taskService.getTask(db, task.id) || task;
}

module.exports = {
  MAX_TIMELINE_BYTES,
  storageRootFromConfig,
  publicUrlFromRelative,
  normalizeTimeline,
  summarizeTimeline,
  buildFfmpegArgs,
  startFfmpegTask,
  createDirectorExportTask,
  DEFAULT_FFMPEG_TIMEOUT_MS,
};
