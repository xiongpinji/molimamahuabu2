'use strict';

/**
 * 样片转绘：按每个工厂分镜的源时间码，从样片切出对应片段，登记为该分镜的参考视频资产。
 *
 * - 切片用异步 ffmpeg 写到系统临时目录，不阻塞事件循环，也不占用数据库写锁；
 *   写库事务里只把暂存文件复制到新项目的 projects/{drama}/videos/references 并插入 assets 行。
 * - 只读样片、只新增文件与 assets 行，不改动任何已有工厂数据。
 * - 模型对参考视频有最短时长要求，片段不足时以源时间码为中心向两侧补足（不超出样片范围）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { getFfmpegPath } = require('../utils/ffmpegPath');
const storageLayout = require('./storageLayout');

const MIN_REFERENCE_MS = 2_000;
const MAX_REFERENCE_MS = 15_000;
const CLIP_TIMEOUT_MS = 120_000;

function clipWindow(startMs, endMs, sourceDurationMs) {
  let start = Math.max(0, Number(startMs));
  let end = Math.min(Number(sourceDurationMs), Number(endMs));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  if (end - start > MAX_REFERENCE_MS) end = start + MAX_REFERENCE_MS;
  const missing = MIN_REFERENCE_MS - (end - start);
  if (missing > 0) {
    start = Math.max(0, start - missing / 2);
    end = Math.min(Number(sourceDurationMs), start + MIN_REFERENCE_MS);
    start = Math.max(0, end - MIN_REFERENCE_MS);
  }
  return { start_ms: Math.round(start), end_ms: Math.round(end) };
}

function unreadable() {
  return Object.assign(new Error('样片文件不可读取'), { code: 'REDRAW_REFERENCE_SOURCE_UNREADABLE' });
}

function resolveSource(storageRoot, sourceAsset) {
  const root = path.resolve(storageRoot || '');
  const sourceRel = String(sourceAsset?.local_path || '').trim();
  if (!storageRoot || !sourceRel || path.isAbsolute(sourceRel)) throw unreadable();
  const sourceAbs = path.resolve(root, sourceRel);
  if (!sourceAbs.startsWith(root + path.sep) || !fs.existsSync(sourceAbs)) throw unreadable();
  return sourceAbs;
}

function cutClip(ffmpegBin, sourceAbs, targetAbs, window) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', (window.start_ms / 1000).toFixed(3),
    '-i', sourceAbs,
    '-t', ((window.end_ms - window.start_ms) / 1000).toFixed(3),
    '-map', '0:v:0', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    targetAbs,
  ];
  return new Promise((resolve, reject) => {
    execFile(ffmpegBin, args, { timeout: CLIP_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error || !fs.existsSync(targetAbs) || fs.statSync(targetAbs).size === 0) {
        const detail = String(error?.message || stderr || '').split('\n')[0].slice(0, 200);
        reject(Object.assign(new Error(`分镜参考片段切分失败：${detail || 'ffmpeg 无输出'}`), { code: 'REDRAW_REFERENCE_CLIP_FAILED' }));
        return;
      }
      resolve();
    });
  });
}

/**
 * 逐个源镜头切片到 stagingDir（顺序执行，避免在轻量服务器上并发占满 CPU）。
 * @param {object} ctx { storageRoot, sourceAsset: {local_path}, sourceDurationMs, stagingDir }
 * @param {Array<{sourceShotId:string, startMs:number, endMs:number}>} shots
 * @returns {Promise<Map<string, {file:string, window:{start_ms:number,end_ms:number}}>>}
 */
async function stageReferenceClips(ctx, shots) {
  const sourceAbs = resolveSource(ctx.storageRoot, ctx.sourceAsset);
  const ffmpegBin = getFfmpegPath();
  fs.mkdirSync(ctx.stagingDir, { recursive: true });
  const staged = new Map();
  for (const [index, shot] of shots.entries()) {
    const key = String(shot.sourceShotId);
    if (staged.has(key)) continue;
    const window = clipWindow(shot.startMs, shot.endMs, ctx.sourceDurationMs);
    if (!window) continue;
    const file = path.join(ctx.stagingDir, `clip-${index + 1}.mp4`);
    await cutClip(ffmpegBin, sourceAbs, file, window);
    staged.set(key, { file, window });
  }
  return staged;
}

/**
 * 在写库事务内调用：把暂存片段复制到新项目目录，并登记为分镜参考视频资产。
 * @returns {{ created: Array, files: string[] }}
 */
function registerStagedReferenceClips(ctx, staged, storyboardSources) {
  const root = path.resolve(ctx.storageRoot);
  const relDir = `${storageLayout.getProjectStorageSubdir(ctx.db, ctx.dramaId)}/videos/references`;
  fs.mkdirSync(path.resolve(root, relDir), { recursive: true });
  const now = new Date().toISOString();
  const insertAsset = ctx.db.prepare(`
    INSERT INTO assets (drama_id, storyboard_id, name, type, category, url, local_path, file_size, mime_type,
      duration, metadata, created_at, updated_at)
    VALUES (?, ?, ?, 'video', 'storyboard_reference_video', ?, ?, ?, 'video/mp4', ?, ?, ?, ?)
  `);
  const created = [];
  const files = [];
  for (const shot of storyboardSources) {
    const clip = staged.get(String(shot.sourceShotId));
    if (!clip || !fs.existsSync(clip.file)) continue;
    const { window } = clip;
    const localPath = `${relDir}/sb${shot.storyboardId}_${window.start_ms}-${window.end_ms}.mp4`;
    const targetAbs = path.resolve(root, localPath);
    fs.copyFileSync(clip.file, targetAbs);
    files.push(targetAbs);
    const assetId = Number(insertAsset.run(
      ctx.dramaId,
      shot.storyboardId,
      `分镜${shot.storyboardNumber || shot.storyboardId} 样片参考`,
      `/static/${localPath}`,
      localPath,
      fs.statSync(targetAbs).size,
      Math.round((window.end_ms - window.start_ms) / 1000),
      JSON.stringify({
        source: 'redraw_sample_clip',
        source_shot_id: shot.sourceShotId || null,
        source_start_ms: Number(shot.startMs),
        source_end_ms: Number(shot.endMs),
        clip_start_ms: window.start_ms,
        clip_end_ms: window.end_ms,
      }),
      now,
      now,
    ).lastInsertRowid);
    created.push({ storyboard_id: shot.storyboardId, asset_id: assetId, url: `/static/${localPath}`, ...window });
  }
  return { created, files };
}

module.exports = {
  MIN_REFERENCE_MS,
  clipWindow,
  stageReferenceClips,
  registerStagedReferenceClips,
};
