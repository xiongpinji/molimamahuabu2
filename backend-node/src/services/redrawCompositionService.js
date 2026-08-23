'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { loadConfig } = require('../config');
const { getFfmpegPath, getFfprobePath } = require('../utils/ffmpegPath');
const redrawGenerationService = require('./redrawGenerationService');
const redrawSubtitleService = require('./redrawSubtitleService');
const {
  buildEpisodeRelease,
  assertReleaseHash,
} = require('./redrawEpisodeReleaseService');

const VIDEO_TOLERANCE_MS = 250;
const VIDEO_TOLERANCE_RATIO = 0.03;
const FFMPEG_TIMEOUT_MIN_MS = 30_000;
const FFMPEG_TIMEOUT_MAX_MS = 1_800_000;
const PROBE_TIMEOUT_MS = 30_000;

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function now(ctx) {
  return ctx.clock ? ctx.clock() : new Date().toISOString();
}

function parseJson(value, fallback, label) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed == null ? fallback : parsed;
  } catch (_) {
    throw codedError('REDRAW_COMPOSITION_INVALID_JSON', `${label} JSON invalid`);
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function requestHash(input) {
  return sha256(stableStringify({
    version_id: Number(input.versionId),
    audio_mode: input.audioMode || 'replace',
    input_hash: input.inputHash || '',
  }));
}

function stripAbsolutePaths(value) {
  if (Array.isArray(value)) return value.map(stripAbsolutePaths);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== 'absolute_path')
      .map(([key, item]) => [key, stripAbsolutePaths(item)]));
  }
  return value;
}

function normalizeVersionId(versionId) {
  const id = Number(versionId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw codedError('REDRAW_COMPOSITION_VERSION_NOT_FOUND', 'versionId invalid');
  }
  return id;
}

function assertAudioMode(audioMode) {
  if ((audioMode || 'replace') !== 'replace') {
    throw codedError('REDRAW_COMPOSITION_AUDIO_MODE_INVALID', 'audioMode P0 only allows replace');
  }
}

function storageRoot(ctx) {
  const root = ctx.storageRoot || ctx.storage_root || ctx?.config?.storage?.local_path;
  if (root) return path.resolve(root);
  try {
    return path.resolve(loadConfig().storage.local_path);
  } catch (_) {
    return path.resolve(process.cwd(), 'storage');
  }
}

function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function relativeMediaPath(value) {
  const relative = String(value || '').replace(/^\/static\//, '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!relative || relative.includes('\0') || relative.split('/').includes('..') || path.isAbsolute(relative)) {
    throw codedError('REDRAW_COMPOSITION_PATH_INVALID', 'media path invalid');
  }
  return relative;
}

function resolveReadableContained(root, localPath, label) {
  const relative = relativeMediaPath(localPath);
  const abs = path.resolve(root, relative);
  if (!isInside(root, abs)) {
    throw codedError('REDRAW_COMPOSITION_PATH_INVALID', `${label} path escapes storage`);
  }
  try {
    const realRoot = fs.realpathSync.native(root);
    fs.accessSync(abs, fs.constants.R_OK);
    const realAbs = fs.realpathSync.native(abs);
    if (!isInside(realRoot, realAbs)) {
      throw codedError('REDRAW_COMPOSITION_PATH_INVALID', `${label} realpath escapes storage`);
    }
    const stat = fs.statSync(realAbs);
    if (!stat.isFile()) {
      throw codedError('REDRAW_COMPOSITION_PATH_UNREADABLE', `${label} is not a regular file`);
    }
    return { relative, absolute: abs, real: realAbs };
  } catch (error) {
    if (error.code && String(error.code).startsWith('REDRAW_COMPOSITION_')) throw error;
    throw codedError('REDRAW_COMPOSITION_PATH_UNREADABLE', `${label} file unreadable`);
  }
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function ownerMatches(row, ctx, columns, label) {
  if (columns.has('tenant_id') && (row.tenant_id == null || String(row.tenant_id) !== String(ctx.tenantId))) {
    throw codedError('REDRAW_COMPOSITION_OWNER_MISMATCH', `${label} tenant mismatch`);
  }
  if (columns.has('user_id') && (row.user_id == null || String(row.user_id) !== String(ctx.userId))) {
    throw codedError('REDRAW_COMPOSITION_OWNER_MISMATCH', `${label} user mismatch`);
  }
}

async function verifyVideo(ctx, root, shot, videoRow, expectedSize) {
  if (!videoRow || videoRow.status !== 'completed' || videoRow.deleted_at) {
    throw codedError('REDRAW_COMPOSITION_VIDEO_INVALID', 'video generation not completed');
  }
  ownerMatches(videoRow, ctx, tableColumns(ctx.db, 'video_generations'), 'video_generation');
  const file = resolveReadableContained(root, videoRow.local_path, 'video');
  const verifier = ctx.artifactVerifier || redrawGenerationService.verifyVideoArtifact;
  const probe = await verifier(ctx, videoRow.id, {});
  const actualMs = Math.round(Number(probe?.duration) * 1000);
  const declaredMs = Number(shot.duration_ms);
  const tolerance = Math.max(VIDEO_TOLERANCE_MS, Math.round(declaredMs * VIDEO_TOLERANCE_RATIO));
  if (!Number.isFinite(actualMs) || actualMs <= 0 || Math.abs(actualMs - declaredMs) > tolerance) {
    throw codedError('REDRAW_COMPOSITION_VIDEO_DURATION_MISMATCH', 'video duration mismatch');
  }
  const width = Number(probe?.width);
  const height = Number(probe?.height);
  if (!(width > 0 && height > 0)) {
    throw codedError('REDRAW_COMPOSITION_VIDEO_INVALID', 'video dimensions invalid');
  }
  if (expectedSize && (expectedSize.width !== width || expectedSize.height !== height)) {
    throw codedError('REDRAW_COMPOSITION_VIDEO_DIMENSION_MISMATCH', 'video dimensions differ');
  }
  return {
    id: videoRow.id,
    relative_path: file.relative,
    absolute_path: file.absolute,
    duration_ms: actualMs,
    width,
    height,
    hash: await sha256File(file.real),
  };
}

function validateTimeline(shots) {
  if (!shots.length) throw codedError('REDRAW_COMPOSITION_SHOTS_EMPTY', 'no approved shots');
  let expectedStart = 0;
  return shots.map((shot) => {
    if (!['approved', 'included'].includes(shot.status)
      || !shot.video_generation_id || !shot.approved_candidate_review_id) {
      throw codedError('REDRAW_COMPOSITION_SHOT_INCOMPLETE', 'version has unapproved shot');
    }
    if (Number(shot.start_ms) !== expectedStart) {
      throw codedError('REDRAW_COMPOSITION_TIMELINE_INVALID', 'timeline has gap or overlap');
    }
    if (Number(shot.end_ms) <= Number(shot.start_ms) || Number(shot.duration_ms) !== Number(shot.end_ms) - Number(shot.start_ms)) {
      throw codedError('REDRAW_COMPOSITION_TIMELINE_INVALID', 'shot duration invalid');
    }
    expectedStart = Number(shot.end_ms);
    return {
      shot_id: shot.id,
      batch_index: shot.batch_index,
      shot_index: shot.shot_index,
      start_ms: Number(shot.start_ms),
      end_ms: Number(shot.end_ms),
      duration_ms: Number(shot.duration_ms),
      video_generation_id: shot.video_generation_id,
    };
  });
}

async function validateAudioSegment(ctx, root, shot, segment) {
  if (segment?.status !== 'completed' || segment?.reservation_status !== 'confirmed') {
    throw codedError('REDRAW_COMPOSITION_AUDIO_INVALID', 'dialogue audio not completed and confirmed');
  }
  const assetId = Number(segment.audio_asset_id);
  if (!Number.isSafeInteger(assetId) || assetId <= 0) {
    throw codedError('REDRAW_COMPOSITION_AUDIO_INVALID', 'dialogue audio asset missing');
  }
  const asset = ctx.db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(assetId);
  if (!asset || asset.type !== 'audio' || asset.category !== 'redraw_dialogue') {
    throw codedError('REDRAW_COMPOSITION_AUDIO_INVALID', 'dialogue audio asset invalid');
  }
  const metadata = parseJson(asset.metadata, {}, 'asset.metadata')?.redraw_dialogue;
  const segmentId = String(segment.segment_id ?? segment.id ?? '');
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
    || String(metadata.tenant_id) !== String(ctx.tenantId)
    || String(metadata.user_id) !== String(ctx.userId)
    || Number(metadata.version_id) !== Number(shot.version_id)
    || String(metadata.segment_id) !== segmentId
    || String(metadata.reservation_id) !== String(segment.reservation_id)
    || String(metadata.idempotency_key) !== String(segment.idempotency_key)) {
    throw codedError('REDRAW_COMPOSITION_AUDIO_OWNER_MISMATCH', 'dialogue audio metadata mismatch');
  }
  const reservation = ctx.db.prepare(`
    SELECT * FROM tenant_usage_reservations
    WHERE id = ? AND tenant_id = ? AND status = 'confirmed'
      AND resource_type = 'redraw_dialogue' AND resource_id = ?
    LIMIT 1
  `).get(String(segment.reservation_id), String(ctx.tenantId), `${shot.version_id}:${segmentId}`);
  if (!reservation) {
    throw codedError('REDRAW_COMPOSITION_AUDIO_RESERVATION_INVALID', 'dialogue reservation is not confirmed for segment');
  }
  const startMs = Number(segment.start_ms);
  const endMs = Number(segment.end_ms);
  const durationMs = Math.round(Number(asset.duration) * 1000);
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs <= startMs
    || startMs < Number(shot.start_ms) || endMs > Number(shot.end_ms)
    || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > (endMs - startMs)) {
    throw codedError('REDRAW_COMPOSITION_AUDIO_DURATION_INVALID', 'dialogue audio duration invalid');
  }
  const file = resolveReadableContained(root, asset.local_path, 'audio');
  return {
    segment_id: segmentId,
    asset_id: asset.id,
    relative_path: file.relative,
    absolute_path: file.absolute,
    start_ms: startMs,
    end_ms: endMs,
    duration_ms: durationMs,
    reservation_id: segment.reservation_id,
    idempotency_key: segment.idempotency_key,
    hash: await sha256File(file.real),
  };
}

async function collectAudio(ctx, root, shots) {
  const audio = [];
  for (const shot of shots) {
    const draft = parseJson(shot.draft_json, {}, 'draft_json');
    const segments = draft?.dialogue_generation?.segments || [];
    if (!Array.isArray(segments)) {
      throw codedError('REDRAW_COMPOSITION_AUDIO_INVALID', 'dialogue segments invalid');
    }
    for (const segment of segments) {
      audio.push(await validateAudioSegment(ctx, root, shot, segment));
    }
  }
  return audio.sort((a, b) => a.start_ms - b.start_ms || a.asset_id - b.asset_id);
}

async function buildCompositionPlan(ctx, input) {
  const db = ctx.db;
  const versionId = normalizeVersionId(input.versionId);
  assertAudioMode(input.audioMode || 'replace');
  const version = db.prepare(`
    SELECT * FROM redraw_versions
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    LIMIT 1
  `).get(versionId, String(ctx.tenantId), String(ctx.userId));
  if (!version) throw codedError('REDRAW_COMPOSITION_VERSION_NOT_FOUND', 'version not found');

  let episodeRelease;
  try {
    episodeRelease = await buildEpisodeRelease(ctx, { version_id: versionId });
    assertReleaseHash(episodeRelease, episodeRelease.release_hash);
  } catch (error) {
    if (error?.code === 'REDRAW_EPISODE_RELEASE_CANDIDATE_NOT_APPROVED') {
      throw codedError('REDRAW_COMPOSITION_SHOT_INCOMPLETE', 'version has unapproved shot', error);
    }
    if (['REDRAW_EPISODE_RELEASE_ORDER_INVALID', 'REDRAW_EPISODE_RELEASE_TIMELINE_INVALID'].includes(error?.code)) {
      throw codedError('REDRAW_COMPOSITION_TIMELINE_INVALID', 'shot timeline invalid', error);
    }
    throw codedError('REDRAW_COMPOSITION_INPUT_DRIFT', 'episode release inputs are not current', error);
  }

  const shots = db.prepare(`
    SELECT * FROM redraw_shots
    WHERE version_id = ? AND tenant_id = ? AND user_id = ?
      AND deleted_at IS NULL
    ORDER BY batch_index ASC, shot_index ASC, id ASC
  `).all(versionId, String(ctx.tenantId), String(ctx.userId));
  const timeline = validateTimeline(shots);
  const root = storageRoot(ctx);
  const videoInputs = [];
  let expectedSize = null;
  for (const shot of shots) {
    const video = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(shot.video_generation_id);
    const verified = await verifyVideo(ctx, root, shot, video, expectedSize);
    expectedSize ||= { width: verified.width, height: verified.height };
    videoInputs.push(verified);
  }
  const audioInputs = await collectAudio(ctx, root, shots);
  const subtitles = redrawSubtitleService.buildSubtitlesForLocalizedShots(shots, { locale: version.locale || 'en-US' });
  if (subtitles.status !== 'ready') {
    throw codedError('REDRAW_COMPOSITION_SUBTITLE_NEEDS_REWRITE', 'subtitle needs rewrite', subtitles.errors);
  }
  const totalDurationMs = timeline[timeline.length - 1].end_ms;
  return {
    version_id: versionId,
    tenant_id: String(ctx.tenantId),
    user_id: String(ctx.userId),
    locale: version.locale,
    market: version.market,
    audio_mode: 'replace',
    total_duration_ms: totalDurationMs,
    dimensions: expectedSize,
    timeline,
    video_inputs: videoInputs,
    audio_inputs: audioInputs,
    subtitles,
    episode_release: episodeRelease,
    release_hash: episodeRelease.release_hash,
    input_hash: sha256(stableStringify({
      release_hash: episodeRelease.release_hash,
      timeline,
      videos: videoInputs.map(({ id, relative_path, duration_ms, width, height, hash }) => ({ id, relative_path, duration_ms, width, height, hash })),
      audio: audioInputs.map(({ asset_id, relative_path, start_ms, end_ms, duration_ms, hash }) => ({ asset_id, relative_path, start_ms, end_ms, duration_ms, hash })),
      subtitles: subtitles.cues,
    })),
  };
}

function runImmediate(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

async function createComposition(ctx, input) {
  const versionId = normalizeVersionId(input.versionId);
  const key = String(input.idempotencyKey || '').trim();
  if (!key) throw codedError('REDRAW_COMPOSITION_IDEMPOTENCY_REQUIRED', 'idempotencyKey required');
  const plan = await buildCompositionPlan(ctx, { versionId, audioMode: input.audioMode || 'replace' });
  const hash = requestHash({ versionId, audioMode: input.audioMode || 'replace', inputHash: plan.input_hash });
  const createdAt = now(ctx);
  const manifest = {
    idempotency_key: key,
    request_hash: hash,
    audio_mode: 'replace',
    episode_release: plan.episode_release,
    plan: stripAbsolutePaths(plan),
  };
  return runImmediate(ctx.db, () => {
    const existing = ctx.db.prepare(`
      SELECT * FROM redraw_exports
      WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
        AND json_extract(manifest_json, '$.idempotency_key') = ?
      ORDER BY id DESC LIMIT 1
    `).get(versionId, String(ctx.tenantId), String(ctx.userId), key);
    if (existing) {
      const existingManifest = parseJson(existing.manifest_json, {}, 'manifest_json');
      if (existingManifest.request_hash !== hash) {
        throw codedError('REDRAW_COMPOSITION_IDEMPOTENCY_CONFLICT', 'idempotency key reused with different request');
      }
      return { ...existing, created: false };
    }
    const active = ctx.db.prepare(`
      SELECT id FROM redraw_exports
      WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND export_type = 'video'
        AND status IN ('pending', 'processing') AND deleted_at IS NULL
      LIMIT 1
    `).get(versionId, String(ctx.tenantId), String(ctx.userId));
    if (active) throw codedError('REDRAW_COMPOSITION_ACTIVE_CONFLICT', 'active composition exists');
    const versionNumber = Number(ctx.db.prepare(`
      SELECT COALESCE(MAX(version_number), 0) + 1 AS next
      FROM redraw_exports
      WHERE version_id = ? AND export_type = 'video' AND deleted_at IS NULL
    `).get(versionId).next);
    const info = ctx.db.prepare(`
      INSERT INTO redraw_exports
        (version_id, tenant_id, user_id, export_type, version_number, manifest_json,
         release_hash, quality_summary_json, status, created_at, updated_at)
      VALUES (?, ?, ?, 'video', ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      versionId,
      String(ctx.tenantId),
      String(ctx.userId),
      versionNumber,
      JSON.stringify(manifest),
      plan.release_hash,
      JSON.stringify(plan.episode_release.quality_summary),
      createdAt,
      createdAt,
    );
    return { ...ctx.db.prepare('SELECT * FROM redraw_exports WHERE id = ?').get(info.lastInsertRowid), created: true };
  });
}

function assertPlainDirectory(dir, realParent = null) {
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      fs.mkdirSync(dir);
      stat = fs.lstatSync(dir);
    } else {
      throw error;
    }
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw codedError('REDRAW_COMPOSITION_OUTPUT_PATH_UNSAFE', 'composition output directory is not a plain directory');
  }
  const real = fs.realpathSync.native(dir);
  if (realParent && !isInside(realParent, real)) {
    throw codedError('REDRAW_COMPOSITION_OUTPUT_PATH_UNSAFE', 'composition output directory escapes base');
  }
  return real;
}

function prepareOutputWorkspace(root, versionId, exportId) {
  const realRoot = assertPlainDirectory(root);
  const redrawDir = path.join(root, 'redraw');
  const realRedraw = assertPlainDirectory(redrawDir, realRoot);
  const versionDir = path.join(redrawDir, `version-${versionId}`);
  const realVersion = assertPlainDirectory(versionDir, realRedraw);
  const exportsDir = path.join(versionDir, 'exports');
  const realExports = assertPlainDirectory(exportsDir, realVersion);
  const workspaceAbs = fs.mkdtempSync(path.join(exportsDir, `export-${exportId}-`));
  const workspaceStat = fs.lstatSync(workspaceAbs);
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
    throw codedError('REDRAW_COMPOSITION_OUTPUT_PATH_UNSAFE', 'composition output workspace unsafe');
  }
  const realWorkspace = fs.realpathSync.native(workspaceAbs);
  if (!isInside(realExports, realWorkspace)) {
    throw codedError('REDRAW_COMPOSITION_OUTPUT_PATH_UNSAFE', 'composition output workspace escapes base');
  }
  const dir = path.relative(root, workspaceAbs).replace(/\\/g, '/');
  return {
    workspace: { absolute: workspaceAbs, real: realWorkspace, baseReal: realExports },
    mp4: { relative: `${dir}/composition.mp4`, absolute: path.join(root, dir, 'composition.mp4') },
    srt: { relative: `${dir}/composition.srt`, absolute: path.join(root, dir, 'composition.srt') },
    vtt: { relative: `${dir}/composition.vtt`, absolute: path.join(root, dir, 'composition.vtt') },
  };
}

function ffmpegArgs(plan, outputs) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const input of plan.video_inputs) args.push('-i', input.absolute_path);
  for (const input of plan.audio_inputs) args.push('-i', input.absolute_path);
  if (!plan.audio_inputs.length) {
    args.push('-f', 'lavfi', '-t', String(plan.total_duration_ms / 1000), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  }
  const videoLabels = plan.video_inputs.map((input, index) => {
    const label = `v${index}`;
    return `[${index}:v]setpts=PTS-STARTPTS,scale=${plan.dimensions.width}:${plan.dimensions.height}:flags=lanczos,setsar=1,format=yuv420p[${label}]`;
  });
  const concatInputs = plan.video_inputs.map((_input, index) => `[v${index}]`).join('');
  const audioOffset = plan.video_inputs.length;
  const audioLabels = plan.audio_inputs.map((input, index) => {
    const label = `a${index}`;
    return `[${audioOffset + index}:a]adelay=${input.start_ms}|${input.start_ms}[${label}]`;
  });
  const mixed = plan.audio_inputs.length
    ? `${plan.audio_inputs.map((_input, index) => `[a${index}]`).join('')}amix=inputs=${plan.audio_inputs.length}:normalize=0,apad,atrim=0:${plan.total_duration_ms / 1000}[aout]`
    : `[${audioOffset}:a]atrim=0:${plan.total_duration_ms / 1000}[aout]`;
  args.push(
    '-filter_complex',
    [...videoLabels, `${concatInputs}concat=n=${plan.video_inputs.length}:v=1:a=0[vcat]`, ...audioLabels, mixed].join(';'),
    '-map',
    '[vcat]',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    '-t',
    String(plan.total_duration_ms / 1000),
    outputs.mp4.absolute,
  );
  return args;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function ffmpegTimeoutMs(plan) {
  const durationMs = Number(plan?.total_duration_ms) || 0;
  return clamp(Math.ceil(durationMs * 10 + 30_000), FFMPEG_TIMEOUT_MIN_MS, FFMPEG_TIMEOUT_MAX_MS);
}

function isExecTimeout(error) {
  return error?.code === 'ETIMEDOUT' || error?.killed === true || /timed out/i.test(String(error?.message || ''));
}

function execFileWithTimeout(execFileImpl, bin, args, options, timeoutCode) {
  return new Promise((resolve, reject) => {
    execFileImpl(bin, args, options, (error, stdout, stderr) => {
      if (error) {
        if (isExecTimeout(error)) {
          reject(codedError(timeoutCode, timeoutCode === 'REDRAW_COMPOSITION_TIMEOUT'
            ? 'ffmpeg composition timed out'
            : 'ffprobe timed out'));
          return;
        }
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function defaultCompositionRunner(job) {
  await execFileWithTimeout(job.execFile || execFile, job.bin, job.args, {
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    timeout: job.timeoutMs,
    killSignal: 'SIGKILL',
  }, 'REDRAW_COMPOSITION_TIMEOUT');
}

async function defaultProbeRunner(filePath, options = {}) {
  const { stdout } = await execFileWithTimeout(options.execFile || execFile, getFfprobePath(), [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,width,height',
    '-of', 'json',
    filePath,
  ], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    timeout: PROBE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  }, 'REDRAW_COMPOSITION_PROBE_TIMEOUT');
  const parsed = JSON.parse(stdout);
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  return {
    duration: Number(parsed.format?.duration),
    width: Number(video?.width),
    height: Number(video?.height),
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
  };
}

function insertAsset(db, ctx, output, type, mimeType, metadata, durationSeconds) {
  const timestamp = now(ctx);
  return db.prepare(`
    INSERT INTO assets
      (name, type, category, local_path, mime_type, duration, metadata, created_at, updated_at)
    VALUES (?, ?, 'redraw_composition', ?, ?, ?, ?, ?, ?)
  `).run(
    path.basename(output.relative),
    type,
    output.relative,
    mimeType,
    durationSeconds,
    JSON.stringify(metadata),
    timestamp,
    timestamp,
  ).lastInsertRowid;
}

function assertTreeHasNoLinks(dir) {
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink()) throw codedError('REDRAW_COMPOSITION_OUTPUT_PATH_UNSAFE', 'cleanup path contains link');
  if (!stat.isDirectory()) return;
  for (const name of fs.readdirSync(dir)) {
    assertTreeHasNoLinks(path.join(dir, name));
  }
}

function cleanupWorkspace(outputs) {
  if (!outputs?.workspace?.absolute) return;
  try {
    const stat = fs.lstatSync(outputs.workspace.absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const realWorkspace = fs.realpathSync.native(outputs.workspace.absolute);
    if (realWorkspace !== outputs.workspace.real || !isInside(outputs.workspace.baseReal, realWorkspace)) return;
    assertTreeHasNoLinks(outputs.workspace.absolute);
    fs.rmSync(outputs.workspace.absolute, { recursive: true, force: true });
  } catch (_) {}
}

async function runComposition(ctx, exportId) {
  const db = ctx.db;
  const id = Number(exportId);
  const row = db.prepare(`
    SELECT * FROM redraw_exports
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(id, String(ctx.tenantId), String(ctx.userId));
  if (!row) throw codedError('REDRAW_COMPOSITION_EXPORT_NOT_FOUND', 'export not found');
  if (row.status === 'completed') return row;
  if (row.status !== 'pending') {
    throw codedError('REDRAW_COMPOSITION_EXPORT_STATE_INVALID', 'export is not runnable');
  }
  const existingManifest = parseJson(row.manifest_json, {}, 'manifest_json');
  try {
    assertReleaseHash(existingManifest.episode_release, row.release_hash);
  } catch (error) {
    throw codedError('REDRAW_COMPOSITION_INPUT_DRIFT', 'stored episode release hash invalid', error);
  }
  const plan = await buildCompositionPlan(ctx, {
    versionId: row.version_id,
    audioMode: 'replace',
  });
  const expectedHash = requestHash({
    versionId: row.version_id,
    audioMode: existingManifest.audio_mode || 'replace',
    inputHash: plan.input_hash,
  });
  if (existingManifest?.plan?.input_hash !== plan.input_hash
    || existingManifest.request_hash !== expectedHash
    || existingManifest.episode_release?.release_hash !== plan.release_hash
    || String(row.release_hash || '') !== plan.release_hash) {
    throw codedError('REDRAW_COMPOSITION_INPUT_DRIFT', 'composition inputs changed after create');
  }
  runImmediate(db, () => {
    const info = db.prepare(`
      UPDATE redraw_exports
      SET status = 'processing', updated_at = ?
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'pending' AND deleted_at IS NULL
    `).run(now(ctx), id, String(ctx.tenantId), String(ctx.userId));
    if (info.changes !== 1) {
      throw codedError('REDRAW_COMPOSITION_EXPORT_STATE_INVALID', 'export is not runnable');
    }
  });
  const root = storageRoot(ctx);
  let outputs = null;
  try {
    outputs = prepareOutputWorkspace(root, row.version_id, id);
    fs.writeFileSync(outputs.srt.absolute, plan.subtitles.srt, 'utf8');
    fs.writeFileSync(outputs.vtt.absolute, plan.subtitles.vtt, 'utf8');
    const args = ffmpegArgs(plan, outputs);
    const runner = ctx.compositionRunner || defaultCompositionRunner;
    await runner({
      bin: getFfmpegPath(),
      args,
      outputPath: outputs.mp4.absolute,
      plan,
      timeoutMs: ffmpegTimeoutMs(plan),
      execFile: ctx.execFile,
    });
    const probe = ctx.probeRunner
      ? await ctx.probeRunner(outputs.mp4.absolute)
      : await defaultProbeRunner(outputs.mp4.absolute, { execFile: ctx.execFile });
    const actualMs = Math.round(Number(probe?.duration) * 1000);
    const tolerance = Math.max(VIDEO_TOLERANCE_MS, Math.round(plan.total_duration_ms * VIDEO_TOLERANCE_RATIO));
    if (!probe?.hasVideo || !probe?.hasAudio || !Number.isFinite(actualMs) || Math.abs(actualMs - plan.total_duration_ms) > tolerance
      || Number(probe.width) !== Number(plan.dimensions.width) || Number(probe.height) !== Number(plan.dimensions.height)) {
      throw codedError('REDRAW_COMPOSITION_OUTPUT_INVALID', 'composition output probe invalid');
    }
    const completedAt = now(ctx);
    const outputHashes = {
      mp4: await sha256File(outputs.mp4.absolute),
      srt: await sha256File(outputs.srt.absolute),
      vtt: await sha256File(outputs.vtt.absolute),
    };
    return runImmediate(db, () => {
      const baseMetadata = {
        tenant_id: String(ctx.tenantId),
        user_id: String(ctx.userId),
        version_id: Number(row.version_id),
        export_id: id,
      };
      const mp4AssetId = insertAsset(db, ctx, outputs.mp4, 'video', 'video/mp4', {
        ...baseMetadata,
        kind: 'composition_video',
        probe,
      }, Number(probe.duration));
      const srtAssetId = insertAsset(db, ctx, outputs.srt, 'subtitle', 'application/x-subrip', {
        ...baseMetadata,
        kind: 'subtitle_srt',
      }, null);
      const vttAssetId = insertAsset(db, ctx, outputs.vtt, 'subtitle', 'text/vtt', {
        ...baseMetadata,
        kind: 'subtitle_vtt',
      }, null);
      const manifest = {
        idempotency_key: existingManifest.idempotency_key,
        request_hash: existingManifest.request_hash,
        audio_mode: 'replace',
        episode_release: plan.episode_release,
        inputs: {
          shot_ids: plan.timeline.map((item) => item.shot_id),
          video_generation_ids: plan.video_inputs.map((item) => item.id),
          audio_asset_ids: plan.audio_inputs.map((item) => item.asset_id),
          input_hash: plan.input_hash,
          timeline: plan.timeline,
        },
        outputs: {
          mp4_path: outputs.mp4.relative,
          srt_path: outputs.srt.relative,
          vtt_path: outputs.vtt.relative,
          mp4_asset_id: mp4AssetId,
          srt_asset_id: srtAssetId,
          vtt_asset_id: vttAssetId,
          hash: outputHashes.mp4,
          hashes: outputHashes,
          probe,
        },
      };
      const update = db.prepare(`
        UPDATE redraw_exports
        SET status = 'completed', asset_id = ?, subtitle_asset_id = ?,
            manifest_json = ?, release_hash = ?, quality_summary_json = ?,
            updated_at = ?, error_code = NULL, error_message = NULL
        WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'processing'
      `).run(
        mp4AssetId,
        srtAssetId,
        JSON.stringify(manifest),
        plan.release_hash,
        JSON.stringify(plan.episode_release.quality_summary),
        completedAt,
        id,
        String(ctx.tenantId),
        String(ctx.userId),
      );
      if (update.changes !== 1) {
        throw codedError('REDRAW_COMPOSITION_EXPORT_STATE_INVALID', 'export completion CAS failed');
      }
      for (const shot of plan.episode_release.shots) {
        const included = db.prepare(`
          UPDATE redraw_shots
          SET status = 'included', updated_at = ?
          WHERE id = ? AND version_id = ? AND tenant_id = ? AND user_id = ?
            AND approved_candidate_review_id = ? AND status IN ('approved', 'included') AND deleted_at IS NULL
        `).run(
          completedAt,
          shot.shot_id,
          row.version_id,
          String(ctx.tenantId),
          String(ctx.userId),
          shot.candidate_review_id,
        );
        if (included.changes !== 1) {
          throw codedError('REDRAW_COMPOSITION_INPUT_DRIFT', 'approved candidate changed during composition');
        }
      }
      db.prepare(`UPDATE redraw_versions SET status = 'completed', updated_at = ?
        WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL`)
        .run(completedAt, row.version_id, String(ctx.tenantId), String(ctx.userId));
      db.prepare(`UPDATE redraw_works SET status = 'completed', current_step = 4, updated_at = ?
        WHERE id = (SELECT work_id FROM redraw_versions WHERE id = ?)
          AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL`)
        .run(completedAt, row.version_id, String(ctx.tenantId), String(ctx.userId));
      return db.prepare(`
        SELECT * FROM redraw_exports
        WHERE id = ? AND tenant_id = ? AND user_id = ?
      `).get(id, String(ctx.tenantId), String(ctx.userId));
    });
  } catch (error) {
    cleanupWorkspace(outputs);
    runImmediate(db, () => {
      db.prepare(`
        UPDATE redraw_exports
        SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'processing'
      `).run(error.code || 'REDRAW_COMPOSITION_FAILED', error.message, now(ctx), id, String(ctx.tenantId), String(ctx.userId));
    });
    throw error;
  }
}

function recoverInterruptedCompositions(db) {
  const info = db.prepare(`
    UPDATE redraw_exports
    SET status = 'needs_attention',
        error_code = 'REDRAW_COMPOSITION_INTERRUPTED',
        error_message = 'composition interrupted during processing',
        updated_at = ?
    WHERE status = 'processing' AND deleted_at IS NULL
  `).run(new Date().toISOString());
  return info.changes;
}

module.exports = {
  buildCompositionPlan,
  createComposition,
  runComposition,
  recoverInterruptedCompositions,
};
