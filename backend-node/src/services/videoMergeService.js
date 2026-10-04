const path = require('path');
const fs = require('fs');
const { getFfmpegPath, getFfprobePath, hasLocalFfmpeg } = require('../utils/ffmpegPath');
const storageLayout = require('./storageLayout');

function list(db, query) {
  let sql = 'FROM video_merges WHERE deleted_at IS NULL';
  const params = [];
  if (query.episode_id) {
    sql += ' AND episode_id = ?';
    params.push(query.episode_id);
  }
  if (query.drama_id) {
    sql += ' AND drama_id = ?';
    params.push(query.drama_id);
  }
  const rows = db.prepare('SELECT * ' + sql + ' ORDER BY created_at DESC').all(...params);
  return rows.map(rowToItem);
}

function rowToItem(r) {
  return {
    id: r.id,
    episode_id: r.episode_id,
    drama_id: r.drama_id,
    title: r.title,
    provider: r.provider,
    status: r.status,
    merged_url: r.merged_url,
    duration: r.duration ?? undefined,
    task_id: r.task_id,
    error_msg: r.error_msg ?? undefined,
    created_at: r.created_at,
    completed_at: r.completed_at,
  };
}

function getById(db, id) {
  const r = db.prepare('SELECT * FROM video_merges WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  return r ? rowToItem(r) : null;
}

function create(db, log, req) {
  const now = new Date().toISOString();
  const taskService = require('./taskService');
  const episodeId = Number(req.episode_id) || 0;
  const active = db.prepare(
    `SELECT id, task_id FROM video_merges
     WHERE episode_id = ? AND status IN ('pending', 'processing') AND deleted_at IS NULL
     ORDER BY created_at DESC, id DESC LIMIT 1`
  ).get(episodeId);
  if (active) {
    return { merge_id: active.id, task_id: active.task_id, reused: true, ...getById(db, active.id) };
  }
  const task = taskService.createTask(db, log, 'video_merge', String(req.episode_id || ''));
  const mergeOptionsJson = (() => {
    const o = req.merge_options;
    if (o && typeof o === 'object') return JSON.stringify(o);
    return '{}';
  })();
  const info = db.prepare(
    `INSERT INTO video_merges (episode_id, drama_id, title, provider, model, status, scenes, merge_options, task_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
  ).run(
    episodeId,
    Number(req.drama_id) || 0,
    req.title ?? null,
    req.provider || 'ffmpeg',
    req.model ?? null,
    req.scenes ? JSON.stringify(req.scenes) : '[]',
    mergeOptionsJson,
    task.id,
    now
  );
  return { merge_id: info.lastInsertRowid, task_id: task.id, ...getById(db, info.lastInsertRowid) };
}

function failVideoMerge(db, taskService, mergeRow, mergeId, message) {
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE video_merges SET status = ?, error_msg = ?, completed_at = ? WHERE id = ?'
  ).run('failed', message, now, mergeId);
  if (mergeRow.task_id) taskService.updateTaskError(db, mergeRow.task_id, message);
  db.prepare(
    `UPDATE episodes SET status = ?, updated_at = ?
     WHERE id = ? AND status = 'processing'`
  ).run('failed', now, mergeRow.episode_id);
}

function deleteById(db, log, id) {
  const now = new Date().toISOString();
  const result = db.prepare('UPDATE video_merges SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, Number(id));
  return result.changes > 0;
}

/** 获取 storage 根目录（绝对路径） */
function getStorageRoot() {
  const loadConfig = require('../config').loadConfig;
  const cfg = loadConfig();
  const p = cfg.storage?.local_path || './data/storage';
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

/** 将 video_url 解析为本地文件路径，或下载到 temp 返回路径 */
async function resolveVideoToLocalPath(videoUrl, baseUrl, storageRoot, tempDir, index, log) {
  if (!videoUrl || typeof videoUrl !== 'string') return null;
  const u = videoUrl.trim();
  // 1) URL 以 baseUrl 开头（如 http://localhost:5679/static）-> 对应 storageRoot 下相对路径
  if (baseUrl && (u.startsWith(baseUrl) || u.startsWith(baseUrl.replace(/\/$/, '')))) {
    const base = baseUrl.replace(/\/$/, '');
    const rel = u.startsWith(base + '/') ? u.slice(base.length + 1) : u.slice(base.length).replace(/^\//, '');
    if (rel && !rel.startsWith('http')) {
      const localPath = path.join(storageRoot, rel.replace(/\//g, path.sep));
      if (fs.existsSync(localPath)) {
        log.info('Video merge: using local static file', { index, path: localPath });
        return localPath;
      }
    }
  }
  // 2) 已是本地绝对路径且存在
  if (path.isAbsolute(u) && fs.existsSync(u)) {
    log.info('Video merge: using absolute path', { index, path: u });
    return u;
  }
  // 3) 相对路径（相对 storageRoot）
  if (!u.startsWith('http://') && !u.startsWith('https://')) {
    const localPath = path.join(storageRoot, u.replace(/^\//, '').replace(/\//g, path.sep));
    if (fs.existsSync(localPath)) {
      log.info('Video merge: using relative path', { index, path: localPath });
      return localPath;
    }
  }
  // 4) 远程 URL：下载到 temp
  const ext = u.includes('.mp4') ? '.mp4' : u.includes('.webm') ? '.webm' : '.mp4';
  const destPath = path.join(tempDir, `dl_${Date.now()}_${index}${ext}`);
  try {
    const res = await fetch(u, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buf);
    log.info('Video merge: downloaded to temp', { index, dest: destPath });
    return destPath;
  } catch (e) {
    log.warn('Video merge: download failed', { index, url: u, error: e.message });
    return null;
  }
}

/**
 * 片段比分镜时长长时，按分镜时长重新编码裁剪（保留音轨），用于样片转绘对齐原片节奏。
 * 探测失败或片段本就不长于目标时长时原样返回，不影响合成。
 */
function trimClipToDuration(localPath, targetSeconds, tempDir, index, log) {
  if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) return localPath;
  const { spawnSync } = require('child_process');
  const probe = spawnSync(getFfprobePath(), [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', localPath,
  ], { encoding: 'utf8' });
  const actual = Number(String(probe.stdout || '').trim());
  if (!Number.isFinite(actual) || actual <= targetSeconds + 0.05) return localPath;
  const output = path.join(tempDir, `trim_${Date.now()}_${index}.mp4`);
  const result = spawnSync(getFfmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', localPath, '-t', targetSeconds.toFixed(3),
    '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', output,
  ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0 || !fs.existsSync(output)) {
    log.warn('Video merge: trim clip failed, using full clip', { index, stderr: result.stderr?.slice(-300) });
    return localPath;
  }
  return output;
}

/** 用 ffprobe 读取片段的画面与音轨参数；读不到时返回 null（该集按原方式直接拼接）。 */
function probeClipFormat(localPath) {
  const { spawnSync } = require('child_process');
  const probe = spawnSync(getFfprobePath(), [
    '-v', 'error', '-show_entries',
    'stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt,sample_rate,channels:format=duration',
    '-of', 'json', localPath,
  ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (probe.error || probe.status !== 0) return null;
  let parsed;
  try { parsed = JSON.parse(probe.stdout || '{}'); } catch (_) { return null; }
  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const width = Number(video?.width);
  const height = Number(video?.height);
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) return null;
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  return {
    width,
    height,
    fps: String(video.r_frame_rate || ''),
    videoCodec: String(video.codec_name || ''),
    pixFmt: String(video.pix_fmt || ''),
    duration: Number(parsed?.format?.duration) || 0,
    audio: audio
      ? { codec: String(audio.codec_name || ''), sampleRate: Number(audio.sample_rate) || 0, channels: Number(audio.channels) || 0 }
      : null,
  };
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  let best;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) { best = value; bestCount = count; }
  }
  return best;
}

/**
 * 同一集混用不同渠道的片段（如 KM 480×854 带音轨、ToAPIs 496×864 无音轨）时，ffmpeg concat 直接复制流会花屏、
 * 后面的声音整体提前。参数完全一致（或有片段读不到参数）时返回 null，照旧直接拼接；
 * 否则以出现最多的分辨率 / 帧率 / 音频参数为目标，把每段统一转码，无音轨的片段补一段静音。
 */
function planClipNormalization(formats) {
  if (!Array.isArray(formats) || formats.length < 2 || formats.some((format) => !format)) return null;
  const signature = (format) => [
    format.width, format.height, format.fps, format.videoCodec, format.pixFmt,
    format.audio ? `${format.audio.codec}/${format.audio.sampleRate}/${format.audio.channels}` : 'none',
  ].join('|');
  if (new Set(formats.map(signature)).size === 1) return null;
  return targetFormat(formats);
}

/** 出现最多的分辨率 / 帧率 / 音频参数（声道最多 2，尺寸取偶数）。 */
function targetFormat(formats) {
  const [width, height] = mostCommon(formats.map((format) => `${format.width}x${format.height}`)).split('x').map(Number);
  const fps = mostCommon(formats.map((format) => format.fps).filter((value) => /^\d+(?:\/\d+)?$/.test(value)
    && Number(value.split('/')[0]) > 0 && Number(value.split('/')[1] || 1) > 0)) || '24/1';
  const withAudio = formats.filter((format) => format.audio?.sampleRate > 0 && format.audio?.channels > 0);
  return {
    width: width % 2 ? width + 1 : width,
    height: height % 2 ? height + 1 : height,
    fps,
    sampleRate: withAudio.length ? mostCommon(withAudio.map((format) => format.audio.sampleRate)) : 44100,
    channels: withAudio.length ? Math.min(2, mostCommon(withAudio.map((format) => format.audio.channels))) : 2,
  };
}

const SMOOTH_TARGET_LUFS = -18;
const SMOOTH_MAX_GAIN_DB = 10;
const SMOOTH_SILENT_LUFS = -50;
const SMOOTH_FADE_SECONDS = 0.05;

/** EBU R128 综合响度（LUFS）。按门限略过静音和很轻的底噪，量的是人声、音效这些听得见的内容；读不到时返回 null。 */
function measureLoudness(localPath) {
  const { spawnSync } = require('child_process');
  const result = spawnSync(getFfmpegPath(), ['-hide_banner', '-nostats', '-i', localPath, '-vn', '-af', 'ebur128', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const match = String(result.stderr || '').match(/Integrated loudness:\s*I:\s*(-?[\d.]+) LUFS/);
  return match ? Number(match[1]) : null;
}

/**
 * 转绘项目平滑音频：各段响度拉到同一水平（-18 LUFS，最多 ±10 dB；无声的段不放大），首尾 0.05 秒淡入淡出去掉切点咔哒声，
 * 最后限幅防爆音。2026-10-03 #98 第 1 集 25 段响度从 -32.9 到 -13.3 LUFS 不等；按平均音量（含静音）统一会把
 * 安静镜头的底噪一起放大，切点处跳变反而更多，所以用按门限计算的响度。
 */
function smoothAudioFilter(localPath, duration) {
  const loudness = measureLoudness(localPath);
  const gain = loudness == null || loudness <= SMOOTH_SILENT_LUFS
    ? 0
    : Math.max(-SMOOTH_MAX_GAIN_DB, Math.min(SMOOTH_MAX_GAIN_DB, SMOOTH_TARGET_LUFS - loudness));
  const filters = [];
  if (Math.abs(gain) >= 0.5) filters.push(`volume=${gain.toFixed(1)}dB`);
  filters.push(`afade=t=in:st=0:d=${SMOOTH_FADE_SECONDS}`);
  if (duration > SMOOTH_FADE_SECONDS * 2) {
    filters.push(`afade=t=out:st=${(duration - SMOOTH_FADE_SECONDS).toFixed(3)}:d=${SMOOTH_FADE_SECONDS}`);
  }
  filters.push('alimiter=limit=0.95');
  return filters.join(',');
}

/**
 * 按 planClipNormalization 的目标统一每段：等比放大到盖满再居中裁切（不加黑边），无音轨补静音。失败时退回原片段。
 * options.smoothAudio（转绘项目）：即使各段参数一致也统一转码，并平滑音频。
 */
function normalizeClipsForConcat(localPaths, tempDir, log, options = {}) {
  const formats = localPaths.map((localPath) => probeClipFormat(localPath));
  const smoothAudio = options.smoothAudio === true && formats.length > 0 && formats.every(Boolean);
  const plan = planClipNormalization(formats) || (smoothAudio ? targetFormat(formats) : null);
  if (!plan) return { paths: localPaths, created: [], plan: null };
  const { spawnSync } = require('child_process');
  const created = [];
  const paths = [];
  const layout = plan.channels === 1 ? 'mono' : 'stereo';
  for (let i = 0; i < localPaths.length; i++) {
    const output = path.join(tempDir, `norm_${Date.now()}_${i}.mp4`);
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', localPaths[i]];
    if (!formats[i].audio) {
      args.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=${layout}:sample_rate=${plan.sampleRate}`);
    }
    if (smoothAudio && formats[i].audio) args.push('-af', smoothAudioFilter(localPaths[i], formats[i].duration));
    args.push(
      '-map', '0:v:0', '-map', formats[i].audio ? '0:a:0' : '1:a:0',
      '-vf', `scale=${plan.width}:${plan.height}:force_original_aspect_ratio=increase,crop=${plan.width}:${plan.height},setsar=1,fps=${plan.fps}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ar', String(plan.sampleRate), '-ac', String(plan.channels),
      '-video_track_timescale', '90000', '-shortest', output,
    );
    const result = spawnSync(getFfmpegPath(), args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (result.error || result.status !== 0 || !fs.existsSync(output)) {
      log.warn('Video merge: normalize clip failed, concatenating the original clips', { index: i, stderr: result.stderr?.slice(-300) });
      for (const file of [...created, output]) {
        try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
      }
      return { paths: localPaths, created: [], plan: null };
    }
    created.push(output);
    paths.push(output);
  }
  log.info('Video merge: clips normalized before concat', {
    clips: localPaths.length, width: plan.width, height: plan.height, fps: plan.fps,
    silent_clips: formats.filter((format) => !format.audio).length, smooth_audio: smoothAudio,
  });
  return { paths, created, plan };
}

/** 使用 ffmpeg concat 合并多个视频文件 */
function runFfmpegConcat(localPaths, outputPath, log) {
  const ffmpegBin = getFfmpegPath();
  const isWin = process.platform === 'win32';
  const listFile = path.join(path.dirname(outputPath), `concat_list_${Date.now()}.txt`);
  try {
    const lines = localPaths.map((p) => {
      const normalized = p.replace(/\\/g, '/');
      return `file '${normalized.replace(/'/g, "'\\''")}'`;
    });
    fs.writeFileSync(listFile, lines.join('\n'), 'utf8');
    const { spawnSync } = require('child_process');
    const args = [
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      '-y',
      outputPath,
    ];
    const result = spawnSync(ffmpegBin, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (result.error) {
      log.warn('Video merge: ffmpeg spawn error', { error: result.error.message });
      return false;
    }
    if (result.status !== 0) {
      log.warn('Video merge: ffmpeg failed', { stderr: result.stderr?.slice(-500) });
      return false;
    }
    return true;
  } finally {
    try { if (fs.existsSync(listFile)) fs.unlinkSync(listFile); } catch (_) {}
  }
}

/**
 * 异步处理视频合成：必须由 ffmpeg 生成完整成片；任一片段不可用或合成失败都明确失败。
 */
async function processVideoMerge(db, log, mergeId, baseUrl) {
  const r = db.prepare('SELECT * FROM video_merges WHERE id = ? AND deleted_at IS NULL').get(mergeId);
  if (!r) return;
  const taskId = r.task_id;
  const episodeId = r.episode_id;
  let scenes = [];
  try {
    scenes = JSON.parse(r.scenes || '[]');
  } catch (_) {
    log.warn('video merge parse scenes failed', { merge_id: mergeId });
  }
  const now = new Date().toISOString();
  db.prepare('UPDATE video_merges SET status = ? WHERE id = ?').run('processing', mergeId);
  const taskService = require('./taskService');
  if (scenes.length === 0) {
    failVideoMerge(db, taskService, r, mergeId, '无有效视频片段');
    return;
  }
  const first = scenes[0];
  if (!first || !first.video_url) {
    failVideoMerge(db, taskService, r, mergeId, '首段无视频地址');
    return;
  }

  const totalDuration = scenes.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
  const storageRoot = getStorageRoot();
  const tempDir = path.join(require('os').tmpdir(), 'drama-video-merge');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const localPaths = [];
  const toCleanup = [];
  const cleanupDownloadedFiles = () => {
    for (const p of toCleanup) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
    }
  };
  for (let i = 0; i < scenes.length; i++) {
    const p = await resolveVideoToLocalPath(
      scenes[i].video_url,
      baseUrl,
      storageRoot,
      tempDir,
      i,
      log
    );
    if (p) {
      localPaths.push(p);
      if (p.startsWith(tempDir)) toCleanup.push(p);
    }
  }

  const ffmpegAvailable = hasLocalFfmpeg();
  log.info('Video merge: ffmpeg check', {
    merge_id: mergeId,
    has_ffmpeg: ffmpegAvailable,
    ffmpeg_path: getFfmpegPath(),
    local_video_count: localPaths.length,
    cwd: process.cwd(),
  });

  if (localPaths.length !== scenes.length) {
    cleanupDownloadedFiles();
    failVideoMerge(
      db,
      taskService,
      r,
      mergeId,
      `视频片段读取不完整（${localPaths.length}/${scenes.length}）`
    );
    return;
  }
  if (!ffmpegAvailable) {
    cleanupDownloadedFiles();
    failVideoMerge(db, taskService, r, mergeId, '服务器 FFmpeg 不可用，无法合成整集视频');
    return;
  }
  if (localPaths.length > 100) {
    cleanupDownloadedFiles();
    failVideoMerge(db, taskService, r, mergeId, '视频片段超过 100 段，无法安全合成');
    return;
  }

  let mergedRelativePath = null;
  let earlyMergeOpts = {};
  try { earlyMergeOpts = JSON.parse(r.merge_options || '{}') || {}; } catch (_) { earlyMergeOpts = {}; }
  if (earlyMergeOpts.trim_to_storyboard_duration === true) {
    for (let i = 0; i < localPaths.length; i++) {
      const trimmed = trimClipToDuration(localPaths[i], Number(scenes[i]?.duration), tempDir, i, log);
      if (trimmed && trimmed !== localPaths[i]) {
        localPaths[i] = trimmed;
        toCleanup.push(trimmed);
      }
    }
  }
  if (localPaths.length > 1 || earlyMergeOpts.smooth_audio === true) {
    const normalized = normalizeClipsForConcat(localPaths, tempDir, log, { smoothAudio: earlyMergeOpts.smooth_audio === true });
    toCleanup.push(...normalized.created);
    localPaths.splice(0, localPaths.length, ...normalized.paths);
  }
  if (localPaths.length > 0) {
    const projectSubdir = storageLayout.getProjectStorageSubdir(db, r.drama_id);
    const sub = projectSubdir && String(projectSubdir).trim();
    const mergedDir = sub
      ? path.join(storageRoot, sub, 'videos', 'merged')
      : path.join(storageRoot, 'videos', 'merged');
    if (!fs.existsSync(mergedDir)) fs.mkdirSync(mergedDir, { recursive: true });
    const outputFileName = `merged_${Date.now()}.mp4`;
    const outputPath = path.join(mergedDir, outputFileName);
    const ok = runFfmpegConcat(localPaths, outputPath, log);
    if (ok && fs.existsSync(outputPath)) {
      mergedRelativePath = sub
        ? path.join(sub, 'videos', 'merged', outputFileName).replace(/\\/g, '/')
        : path.join('videos', 'merged', outputFileName).replace(/\\/g, '/');
      log.info('Video merge completed (ffmpeg)', { merge_id: mergeId, episode_id: episodeId, output: mergedRelativePath });
    }
  }
  if (!mergedRelativePath) {
    cleanupDownloadedFiles();
    failVideoMerge(db, taskService, r, mergeId, 'FFmpeg 合成失败，未生成整集视频');
    return;
  }

  let mergeOpts = {};
  try {
    mergeOpts = JSON.parse(r.merge_options || '{}');
  } catch (_) {
    mergeOpts = {};
  }
  const postNeed =
    !!mergeOpts.burn_narration_subtitles
    || !!mergeOpts.burn_dialogue_audio
    || !!(mergeOpts.watermark_text && String(mergeOpts.watermark_text).trim());
  if (mergedRelativePath && ffmpegAvailable && postNeed) {
    const mergedAbsPath = path.join(storageRoot, mergedRelativePath.replace(/\//g, path.sep));
    if (fs.existsSync(mergedAbsPath)) {
      const mergedPP = require('./mergedEpisodePostProcess');
      const post = await mergedPP.runMergedEpisodePostProcess(db, log, {
        mergedAbsPath,
        storageRoot,
        scenes,
        episodeId,
        mergeOpts,
      });
      if (post.ok && post.relativePath) {
        mergedRelativePath = post.relativePath;
        log.info('Video merge: merged episode post-process', { merge_id: mergeId, out: mergedRelativePath });
      } else if (post.error && post.error !== 'NO_POST_OPTS') {
        log.warn('Video merge: post-process skipped', { merge_id: mergeId, err: post.error });
      }
    }
  }

  cleanupDownloadedFiles();

  const finalMergedUrl = mergedRelativePath;
  db.prepare(
    'UPDATE video_merges SET status = ?, merged_url = ?, duration = ?, completed_at = ?, error_msg = ? WHERE id = ?'
  ).run('completed', finalMergedUrl, Math.round(totalDuration) || null, now, null, mergeId);
  db.prepare('UPDATE episodes SET video_url = ?, status = ?, updated_at = ? WHERE id = ?').run(finalMergedUrl, 'completed', now, episodeId);
  if (taskId) {
    taskService.updateTaskResult(db, taskId, { merge_id: mergeId, video_url: finalMergedUrl, duration: Math.round(totalDuration) });
  }
}

module.exports = {
  list,
  getById,
  create,
  deleteById,
  processVideoMerge,
  trimClipToDuration,
  probeClipFormat,
  planClipNormalization,
  targetFormat,
  smoothAudioFilter,
  normalizeClipsForConcat,
  runFfmpegConcat,
};
