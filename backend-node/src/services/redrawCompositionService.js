'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const { loadConfig } = require('../config');
const { getFfmpegPath } = require('../utils/ffmpegPath');
const redrawGenerationService = require('./redrawGenerationService');
const redrawSubtitleService = require('./redrawSubtitleService');
const { assembleApprovedExecutionUnits } = require('./redrawUnitAssemblyService');
const { prepareSourceVideo } = require('./redrawSourceVideoService');
const { getExecutionRun } = require('./redrawExecutionRunService');
const { defaultCompositionRunner, defaultProbeRunner, validateGeometryProbe,
  rationalEquals, sha256File } = require('./redrawMediaRuntimeInternal');
const {
  buildEpisodeRelease,
  assertReleaseHash,
} = require('./redrawEpisodeReleaseService');

const VIDEO_TOLERANCE_MS = 250;
const VIDEO_TOLERANCE_RATIO = 0.03;
const FFMPEG_TIMEOUT_MIN_MS = 30_000;
const FFMPEG_TIMEOUT_MAX_MS = 1_800_000;

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
  if (isUnitCompositionRequest(input)) return buildUnitCompositionPlan(ctx, input);
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
  if (isUnitCompositionRequest(input)) return createUnitComposition(ctx, input);
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

function ffmpegArgs(plan, outputs, expectedGeometry) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const input of plan.video_inputs) args.push('-i', input.absolute_path);
  for (const input of plan.audio_inputs) args.push('-i', input.absolute_path);
  if (!plan.audio_inputs.length) {
    args.push('-f', 'lavfi', '-t', String(plan.total_duration_ms / 1000), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  }
  const videoLabels = plan.video_inputs.map((input, index) => {
    const label = `v${index}`;
    const sar = `${expectedGeometry.sar.numerator}/${expectedGeometry.sar.denominator}`;
    return `[${index}:v]setpts=PTS-STARTPTS,scale=${plan.dimensions.width}:${plan.dimensions.height}:flags=lanczos,setsar=${sar}:max=65535,format=yuv420p[${label}]`;
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

async function inspectInputGeometry(ctx, plan) {
  const videos = plan.video_inputs;
  const timeline = plan.timeline;
  const releaseShots = plan.episode_release?.shots;
  if (!Array.isArray(videos) || !Array.isArray(timeline) || !Array.isArray(releaseShots)
    || !videos.length || videos.length !== timeline.length || videos.length !== releaseShots.length) {
    throw codedError('REDRAW_COMPOSITION_INPUT_DRIFT', 'composition input ordering changed');
  }
  let expected = null;
  for (let index = 0; index < videos.length; index += 1) {
    const video = videos[index];
    const timelineItem = timeline[index];
    const releaseShot = releaseShots[index];
    const expectedHash = String(video.hash || '').toLowerCase();
    const candidateHash = String(releaseShot?.candidate_sha256 || '').toLowerCase();
    if (Number(timelineItem?.video_generation_id) !== Number(video.id)
      || Number(releaseShot?.shot_id) !== Number(timelineItem?.shot_id)
      || !/^[a-f0-9]{64}$/.test(expectedHash) || candidateHash !== expectedHash) {
      throw codedError('REDRAW_COMPOSITION_INPUT_DRIFT', 'composition input identity or hash changed');
    }
    let beforeHash;
    let afterHash;
    try {
      beforeHash = await sha256File(video.absolute_path);
    } catch (_) {
      throw codedError('REDRAW_COMPOSITION_INPUT_DRIFT', 'composition input unreadable before geometry probe');
    }
    if (beforeHash !== expectedHash || beforeHash !== candidateHash) {
      throw codedError('REDRAW_COMPOSITION_INPUT_DRIFT', 'composition input changed before geometry probe');
    }
    let probe;
    try {
      probe = await defaultProbeRunner(video.absolute_path, { execFile: ctx.execFile });
    } catch (error) {
      if (error?.code === 'REDRAW_COMPOSITION_PROBE_TIMEOUT') throw error;
      throw codedError('REDRAW_COMPOSITION_INPUT_GEOMETRY_INVALID', 'composition input geometry unreadable', error);
    }
    try {
      afterHash = await sha256File(video.absolute_path);
    } catch (_) {
      throw codedError('REDRAW_COMPOSITION_INPUT_DRIFT', 'composition input unreadable after geometry probe');
    }
    if (afterHash !== beforeHash || afterHash !== expectedHash || afterHash !== candidateHash) {
      throw codedError('REDRAW_COMPOSITION_INPUT_DRIFT', 'composition input changed during geometry probe');
    }
    const geometry = validateGeometryProbe(probe, plan.dimensions, 'REDRAW_COMPOSITION_INPUT_GEOMETRY_INVALID');
    if (expected && (!rationalEquals(geometry.sar, expected.sar) || !rationalEquals(geometry.dar, expected.dar))) {
      throw codedError('REDRAW_COMPOSITION_INPUT_GEOMETRY_MISMATCH', 'composition input display geometry differs');
    }
    expected ||= geometry;
  }
  return expected;
}

function insertAsset(db, ctx, output, type, mimeType, metadata, durationSeconds, timestamp = now(ctx)) {
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
  if (existingManifest.schema_version === UNIT_COMPOSITION_SCHEMA) {
    return runUnitComposition(ctx, row, existingManifest);
  }
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
    const expectedGeometry = await inspectInputGeometry(ctx, plan);
    outputs = prepareOutputWorkspace(root, row.version_id, id);
    fs.writeFileSync(outputs.srt.absolute, plan.subtitles.srt, 'utf8');
    fs.writeFileSync(outputs.vtt.absolute, plan.subtitles.vtt, 'utf8');
    const args = ffmpegArgs(plan, outputs, expectedGeometry);
    const runner = ctx.compositionRunner || defaultCompositionRunner;
    await runner({
      bin: getFfmpegPath(),
      args,
      outputPath: outputs.mp4.absolute,
      plan,
      timeoutMs: ffmpegTimeoutMs(plan),
      execFile: ctx.execFile,
    });
    let outputHashBeforeProbe;
    try {
      outputHashBeforeProbe = await sha256File(outputs.mp4.absolute);
    } catch (_) {
      throw codedError('REDRAW_COMPOSITION_OUTPUT_INVALID', 'composition output unreadable before probe');
    }
    const probe = ctx.probeRunner
      ? await ctx.probeRunner(outputs.mp4.absolute)
      : await defaultProbeRunner(outputs.mp4.absolute, { execFile: ctx.execFile });
    let outputHashAfterProbe;
    try {
      outputHashAfterProbe = await sha256File(outputs.mp4.absolute);
    } catch (_) {
      throw codedError('REDRAW_COMPOSITION_OUTPUT_INVALID', 'composition output unreadable after probe');
    }
    if (outputHashAfterProbe !== outputHashBeforeProbe) {
      throw codedError('REDRAW_COMPOSITION_OUTPUT_INVALID', 'composition output changed during probe');
    }
    const actualMs = Math.round(Number(probe?.duration) * 1000);
    const tolerance = Math.max(VIDEO_TOLERANCE_MS, Math.round(plan.total_duration_ms * VIDEO_TOLERANCE_RATIO));
    let outputGeometry;
    try {
      outputGeometry = validateGeometryProbe(probe, plan.dimensions, 'REDRAW_COMPOSITION_OUTPUT_INVALID');
    } catch (error) {
      if (error?.code === 'REDRAW_COMPOSITION_OUTPUT_INVALID') throw error;
      throw codedError('REDRAW_COMPOSITION_OUTPUT_INVALID', 'composition output probe invalid', error);
    }
    if (!probe?.hasAudio || !Number.isFinite(actualMs) || Math.abs(actualMs - plan.total_duration_ms) > tolerance
      || !rationalEquals(outputGeometry.sar, expectedGeometry.sar)
      || !rationalEquals(outputGeometry.dar, expectedGeometry.dar)) {
      throw codedError('REDRAW_COMPOSITION_OUTPUT_INVALID', 'composition output probe invalid');
    }
    const completedAt = now(ctx);
    const outputHashes = {
      mp4: outputHashAfterProbe,
      srt: await sha256File(outputs.srt.absolute),
      vtt: await sha256File(outputs.vtt.absolute),
    };
    const currentPlan = await buildCompositionPlan(ctx, {
      versionId: row.version_id,
      audioMode: 'replace',
    });
    const currentRow = db.prepare(`
      SELECT status, release_hash, manifest_json FROM redraw_exports
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    `).get(id, String(ctx.tenantId), String(ctx.userId));
    const currentManifest = parseJson(currentRow?.manifest_json, {}, 'manifest_json');
    try {
      assertReleaseHash(currentManifest.episode_release, currentRow?.release_hash);
    } catch (error) {
      throw codedError('REDRAW_COMPOSITION_INPUT_DRIFT', 'stored episode release changed during composition', error);
    }
    const currentRequestHash = requestHash({
      versionId: row.version_id,
      audioMode: currentManifest.audio_mode || 'replace',
      inputHash: currentPlan.input_hash,
    });
    if (currentRow?.status !== 'processing'
      || String(currentRow.release_hash || '') !== String(row.release_hash || '')
      || currentManifest.episode_release?.release_hash !== existingManifest.episode_release?.release_hash
      || currentManifest?.plan?.input_hash !== existingManifest?.plan?.input_hash
      || currentManifest.request_hash !== existingManifest.request_hash
      || currentPlan.release_hash !== plan.release_hash
      || currentPlan.input_hash !== plan.input_hash
      || currentPlan.release_hash !== String(currentRow.release_hash || '')
      || currentRequestHash !== existingManifest.request_hash) {
      throw codedError('REDRAW_COMPOSITION_INPUT_DRIFT', 'composition inputs changed during composition');
    }
    let finalOutputHash;
    try {
      finalOutputHash = await sha256File(outputs.mp4.absolute);
    } catch (_) {
      throw codedError('REDRAW_COMPOSITION_OUTPUT_INVALID', 'composition output unreadable before publication');
    }
    if (finalOutputHash !== outputHashAfterProbe) {
      throw codedError('REDRAW_COMPOSITION_OUTPUT_INVALID', 'composition output changed before publication');
    }
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
      }, Number(probe.duration), completedAt);
      const srtAssetId = insertAsset(db, ctx, outputs.srt, 'subtitle', 'application/x-subrip', {
        ...baseMetadata,
        kind: 'subtitle_srt',
      }, null, completedAt);
      const vttAssetId = insertAsset(db, ctx, outputs.vtt, 'subtitle', 'text/vtt', {
        ...baseMetadata,
        kind: 'subtitle_vtt',
      }, null, completedAt);
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

const UNIT_COMPOSITION_SCHEMA = 'redraw-execution-unit-composition-v1';
const UNIT_PLAN_KEYS = ['schema_version', 'version_id', 'run_id', 'expected_plan_hash', 'expected_run_revision'];
const UNIT_REQUEST_KEYS = [...UNIT_PLAN_KEYS, 'idempotency_key'];

function isUnitCompositionRequest(input) {
  return UNIT_REQUEST_KEYS.some(key => Object.hasOwn(Object(input), key));
}

function unitRequest(input, creating = true) {
  const keys = creating ? UNIT_REQUEST_KEYS : UNIT_PLAN_KEYS;
  if (!input || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== keys.length || !keys.every(key => Object.hasOwn(input, key))
    || input.schema_version !== UNIT_COMPOSITION_SCHEMA
    || !Number.isSafeInteger(input.version_id) || input.version_id <= 0
    || !Number.isSafeInteger(input.run_id) || input.run_id <= 0
    || !Number.isSafeInteger(input.expected_run_revision) || input.expected_run_revision < 0
    || typeof input.expected_plan_hash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expected_plan_hash)
    || (creating && (typeof input.idempotency_key !== 'string' || !input.idempotency_key || input.idempotency_key.length > 200
      || input.idempotency_key.trim() !== input.idempotency_key || /[\x00-\x1f\x7f]/.test(input.idempotency_key)))) {
    throw codedError('REDRAW_COMPOSITION_INPUT_INVALID', 'unit composition request invalid');
  }
  return { schema_version: 'redraw-execution-unit-release-v1', version_id: input.version_id,
    run_id: input.run_id, expected_plan_hash: input.expected_plan_hash, expected_run_revision: input.expected_run_revision };
}

function ownedUnitVersion(ctx, versionId) {
  const row = ctx.db.prepare(`SELECT v.*, w.project_id, w.source_asset_id, w.source_fingerprint,
    w.duration_ms AS source_duration_ms FROM redraw_versions v
    JOIN redraw_works w ON w.id=v.work_id AND w.tenant_id=v.tenant_id AND w.user_id=v.user_id AND w.deleted_at IS NULL
    JOIN redraw_projects p ON p.id=w.project_id AND p.tenant_id=v.tenant_id AND p.user_id=v.user_id AND p.deleted_at IS NULL
    WHERE v.id=? AND v.tenant_id=? AND v.user_id=? AND v.deleted_at IS NULL`)
    .get(versionId, String(ctx.tenantId), String(ctx.userId));
  if (!row) throw codedError('REDRAW_COMPOSITION_VERSION_NOT_FOUND', 'version not found');
  return row;
}

function assertUnitRun(ctx, request) {
  const run = getExecutionRun(ctx, request.version_id, request.run_id);
  if (run.binding_status !== 'current' || run.status !== 'completed' || run.plan_hash !== request.expected_plan_hash
    || run.revision !== request.expected_run_revision || !run.units.length || run.units.some(unit => unit.status !== 'approved')) {
    throw codedError('REDRAW_COMPOSITION_INPUT_DRIFT', 'approved unit run changed');
  }
}

async function buildUnitCompositionPlan(ctx, input) {
  const request = unitRequest(input, false);
  const version = ownedUnitVersion(ctx, request.version_id);
  const release = await buildEpisodeRelease(ctx, request);
  assertReleaseHash(release, release.release_hash);
  if (stableStringify(ownedUnitVersion(ctx, version.id)) !== stableStringify(version)) {
    throw codedError('REDRAW_COMPOSITION_INPUT_DRIFT', 'version changed during composition planning');
  }
  assertUnitRun(ctx, request);
  return { schema_version: UNIT_COMPOSITION_SCHEMA, request, version_id: request.version_id, run_id: request.run_id,
    audio_mode: release.audio_mode, total_duration_ms: release.duration_ms, episode_release: release,
    release_hash: release.release_hash, input_hash: sha256(stableStringify({ request, release_hash: release.release_hash })) };
}

async function createUnitComposition(ctx, input) {
  const request = unitRequest(input);
  const version = ownedUnitVersion(ctx, request.version_id);
  const hash = sha256(stableStringify(request));
  const findExisting = () => {
    const existing = ctx.db.prepare(`SELECT * FROM redraw_exports WHERE version_id=? AND tenant_id=? AND user_id=?
      AND deleted_at IS NULL AND json_extract(manifest_json, '$.idempotency_key')=? ORDER BY id DESC LIMIT 1`)
      .get(version.id, String(ctx.tenantId), String(ctx.userId), input.idempotency_key);
    if (existing) {
      const stored = parseJson(existing.manifest_json, {}, 'manifest_json');
      if (stored.schema_version !== UNIT_COMPOSITION_SCHEMA || stored.request_hash !== hash) {
        throw codedError('REDRAW_COMPOSITION_IDEMPOTENCY_CONFLICT', 'idempotency key reused with different request');
      }
      return { ...existing, created: false };
    }
    const active = ctx.db.prepare(`SELECT id FROM redraw_exports WHERE version_id=? AND tenant_id=? AND user_id=?
      AND export_type='video' AND status IN ('pending','processing') AND deleted_at IS NULL LIMIT 1`)
      .get(version.id, String(ctx.tenantId), String(ctx.userId));
    if (active) throw codedError('REDRAW_COMPOSITION_ACTIVE_CONFLICT', 'active composition exists');
    return null;
  };
  const existing = findExisting();
  if (existing) return existing;
  const plan = await buildUnitCompositionPlan(ctx, { ...request, schema_version: UNIT_COMPOSITION_SCHEMA });
  const release = plan.episode_release;
  if (release.composition_readiness.status !== 'ready') {
    throw codedError('REDRAW_COMPOSITION_APPROVED_DUB_REQUIRED', 'approved dubbing is required before composition');
  }
  const manifest = { schema_version: UNIT_COMPOSITION_SCHEMA, idempotency_key: input.idempotency_key,
    request_hash: hash, request, episode_release: release };
  return runImmediate(ctx.db, () => {
    ctx.assertUnitCompositionAccess?.();
    if (stableStringify(ownedUnitVersion(ctx, version.id)) !== stableStringify(version)) {
      throw codedError('REDRAW_COMPOSITION_INPUT_DRIFT', 'version changed during composition creation');
    }
    assertUnitRun(ctx, request);
    const replay = findExisting();
    if (replay) return replay;
    const next = ctx.db.prepare(`SELECT COALESCE(MAX(version_number),0)+1 AS next FROM redraw_exports
      WHERE version_id=? AND export_type='video' AND deleted_at IS NULL`).get(version.id).next;
    const timestamp = now(ctx);
    const inserted = ctx.db.prepare(`INSERT INTO redraw_exports
      (version_id,tenant_id,user_id,export_type,version_number,manifest_json,release_hash,quality_summary_json,status,created_at,updated_at)
      VALUES (?,?,?,'video',?,?,?,?,'pending',?,?)`).run(version.id, String(ctx.tenantId), String(ctx.userId), next,
      JSON.stringify(manifest), release.release_hash, JSON.stringify(release.quality_summary), timestamp, timestamp);
    return { ...ctx.db.prepare('SELECT * FROM redraw_exports WHERE id=?').get(inserted.lastInsertRowid), created: true };
  });
}

// A retained descriptor, not a hash followed by an unprotected pathname reopen.
// The synchronous full-byte check is used after the last await and inside CAS.
function holdUnitFile(root, file, expectedHash, code, allowEmpty = false) {
  const reject = () => { throw codedError(code, 'composition file identity or bytes changed'); };
  const checkedStat = () => {
    if (!isInside(root, file) || file === root) reject();
    let current = path.parse(file).root;
    for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current, { bigint: true });
      if (stat.isSymbolicLink() || (current === file ? !stat.isFile() : !stat.isDirectory())) reject();
    }
    if (fs.realpathSync.native(file) !== file) reject();
    return fs.lstatSync(file, { bigint: true });
  };
  const same = (left, right) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => left[key] === right[key]);
  let fd;
  try {
    const before = checkedStat();
    if ((before.size === 0n && !allowEmpty) || before.size < 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) reject();
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const assertCurrent = () => {
      if (fd === undefined || !same(before, checkedStat()) || !same(before, fs.fstatSync(fd, { bigint: true }))) reject();
      const digest = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (position < Number(before.size)) {
        const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, Number(before.size) - position), position);
        if (!count) reject();
        digest.update(buffer.subarray(0, count)); position += count;
      }
      if (digest.digest('hex') !== expectedHash || !same(before, checkedStat())
        || !same(before, fs.fstatSync(fd, { bigint: true }))) reject();
    };
    assertCurrent();
    return { size: Number(before.size), sha256: expectedHash, assertCurrent,
      cleanup() { if (fd !== undefined) { fs.closeSync(fd); fd = undefined; } } };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (error.code === code) throw error;
    throw codedError(code, 'composition file unavailable');
  }
}

async function runUnitComposition(ctx, row, stored) {
  const db = ctx.db;
  runImmediate(db, () => {
    const claimed = db.prepare(`UPDATE redraw_exports SET status='processing',updated_at=?
      WHERE id=? AND tenant_id=? AND user_id=? AND status='pending' AND deleted_at IS NULL
        AND manifest_json=? AND release_hash=?`).run(now(ctx), row.id, String(ctx.tenantId), String(ctx.userId), row.manifest_json, row.release_hash);
    if (claimed.changes !== 1) throw codedError('REDRAW_COMPOSITION_EXPORT_STATE_INVALID', 'export is not runnable');
  });
  let outputs, assembly, sourceSnapshot, sourceFile;
  const outputFiles = [];
  let published = false;
  try {
    let request, plan, release;
    try {
      request = unitRequest({ ...stored.request, schema_version: UNIT_COMPOSITION_SCHEMA, idempotency_key: stored.idempotency_key });
      if (request.version_id !== row.version_id || stored.request.schema_version !== 'redraw-execution-unit-release-v1'
        || stableStringify(request) !== stableStringify(stored.request) || stored.request_hash !== sha256(stableStringify(request))) {
        throw codedError('REDRAW_COMPOSITION_INPUT_DRIFT', 'stored unit request changed');
      }
      assertReleaseHash(stored.episode_release, row.release_hash);
      plan = await buildUnitCompositionPlan(ctx, { ...request, schema_version: UNIT_COMPOSITION_SCHEMA });
      release = plan.episode_release;
      assertReleaseHash(release, row.release_hash);
    } catch (error) {
      throw codedError('REDRAW_COMPOSITION_INPUT_DRIFT', 'unit release is not current', error);
    }
    if (release.composition_readiness.status !== 'ready') {
      throw codedError('REDRAW_COMPOSITION_APPROVED_DUB_REQUIRED', 'approved dubbing is required before composition');
    }
    const version = ownedUnitVersion(ctx, row.version_id);
    const asset = db.prepare('SELECT * FROM assets WHERE id=? AND deleted_at IS NULL').get(version.source_asset_id);
    const root = storageRoot(ctx);
    sourceSnapshot = await prepareSourceVideo(ctx, { workId: version.work_id, tenantId: ctx.tenantId, userId: ctx.userId,
      expectedSourceAssetId: version.source_asset_id, expectedSourceSha256: release.source_sha256 });
    sourceFile = holdUnitFile(root, path.resolve(root, asset.local_path), release.source_sha256, 'REDRAW_COMPOSITION_INPUT_DRIFT');
    const assertSource = () => {
      if (stableStringify(ownedUnitVersion(ctx, row.version_id)) !== stableStringify(version)
        || stableStringify(db.prepare('SELECT * FROM assets WHERE id=? AND deleted_at IS NULL').get(asset.id)) !== stableStringify(asset)) {
        throw codedError('REDRAW_COMPOSITION_INPUT_DRIFT', 'source or version binding changed');
      }
      sourceFile.assertCurrent();
    };
    assertSource();
    assembly = await assembleApprovedExecutionUnits(ctx, { version_id: request.version_id, run_id: request.run_id,
      expected_plan_hash: request.expected_plan_hash, expected_run_revision: request.expected_run_revision });
    const media = assembly.manifest;
    if (media.audio.mode !== release.audio_mode || media.units.length !== release.units.length
      || media.units.some((unit, index) => {
        const expected = release.units[index];
        return unit.unit_id !== expected.unit_id || unit.ordinal !== expected.ordinal || unit.review_hash !== expected.review_hash
          || unit.candidate_sha256 !== expected.candidate_sha256 || unit.candidate_bytes !== expected.candidate_bytes
          || Object.entries(expected.timeline).some(([key, value]) => unit[key] !== value);
      })) throw codedError('REDRAW_COMPOSITION_INPUT_DRIFT', 'assembled units differ from approved release');
    assertSource();
    outputs = prepareOutputWorkspace(root, row.version_id, row.id);
    outputs.report = { relative: `${path.posix.dirname(outputs.mp4.relative)}/composition-report.json`,
      absolute: path.join(outputs.workspace.absolute, 'composition-report.json') };
    await pipeline(assembly.files.video.createReadStream(), fs.createWriteStream(outputs.mp4.absolute, { flags: 'wx', mode: 0o600 }));
    fs.writeFileSync(outputs.srt.absolute, release.subtitles.srt, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(outputs.vtt.absolute, release.subtitles.vtt, { flag: 'wx', mode: 0o600 });
    const hashes = { mp4: media.output.sha256, srt: sha256(release.subtitles.srt), vtt: sha256(release.subtitles.vtt) };
    for (const kind of ['mp4', 'srt', 'vtt']) {
      const emptySrt = kind === 'srt' && release.subtitles.cues.length === 0 && release.subtitles.srt === '';
      outputFiles.push(holdUnitFile(root, outputs[kind].absolute, hashes[kind], 'REDRAW_COMPOSITION_OUTPUT_INVALID', emptySrt));
    }
    const inputHash = plan.input_hash;
    const report = { schema_version: 'redraw-execution-unit-composition-report-v1', export_id: row.id,
      version_id: row.version_id, run_id: request.run_id, release_hash: release.release_hash, input_hash: inputHash,
      final_media_review: 'pending', dialogue_alignment: 'not_verified', audio: media.audio,
      media: media.output,
      units: release.units.map(unit => ({ unit_id: unit.unit_id, ordinal: unit.ordinal, timeline: unit.timeline,
        output_start_ms: unit.output_start_ms, output_end_ms: unit.output_end_ms })),
      outputs: Object.fromEntries(['mp4', 'srt', 'vtt'].map((kind, index) => [kind,
        { sha256: hashes[kind], bytes: outputFiles[index].size }])) };
    const reportBytes = JSON.stringify(report);
    fs.writeFileSync(outputs.report.absolute, reportBytes, { flag: 'wx', mode: 0o600 });
    hashes.report = sha256(reportBytes);
    outputFiles.push(holdUnitFile(root, outputs.report.absolute, hashes.report, 'REDRAW_COMPOSITION_OUTPUT_INVALID'));
    sourceSnapshot.assertCurrentBinding();
    await sourceSnapshot.cleanup();
    sourceSnapshot = null;
    // No awaits from this point through COMMIT: source FD, all four output FDs,
    // and the existing Assembly approval/ledger assertions cover publication.
    const assertInputs = () => {
      assertSource();
      assembly.assertCurrentBindingSync();
      outputFiles.forEach(file => file.assertCurrent());
    };
    const completed = runImmediate(db, () => {
      assertInputs();
      const timestamp = now(ctx);
      const metadata = { tenant_id: String(ctx.tenantId), user_id: String(ctx.userId), version_id: row.version_id, export_id: row.id };
      const kinds = { mp4: ['video', 'video/mp4', 'composition_video'], srt: ['subtitle', 'application/x-subrip', 'subtitle_srt'],
        vtt: ['subtitle', 'text/vtt', 'subtitle_vtt'], report: ['json', 'application/json', 'composition_report'] };
      const registered = { hashes };
      const assetRows = [];
      for (const [kind, [type, mime, assetKind]] of Object.entries(kinds)) {
        registered[`${kind}_path`] = outputs[kind].relative;
        registered[`${kind}_asset_id`] = Number(insertAsset(db, ctx, outputs[kind], type, mime,
          { ...metadata, kind: assetKind }, kind === 'mp4' ? media.output.duration_ms / 1000 : null, timestamp));
        const registeredAsset = db.prepare('SELECT * FROM assets WHERE id=?').get(registered[`${kind}_asset_id`]);
        if (!registeredAsset || registeredAsset.type !== type || registeredAsset.category !== 'redraw_composition'
          || registeredAsset.mime_type !== mime || registeredAsset.local_path !== outputs[kind].relative
          || registeredAsset.deleted_at !== null || registeredAsset.metadata !== JSON.stringify({ ...metadata, kind: assetKind })) {
          throw codedError('REDRAW_COMPOSITION_OUTPUT_INVALID', 'export asset registration changed');
        }
        assetRows.push(registeredAsset);
      }
      const manifest = { ...stored, episode_release: release,
        inputs: { release_hash: release.release_hash, run_id: request.run_id, plan_hash: request.expected_plan_hash, input_hash: inputHash },
        outputs: registered };
      const updated = db.prepare(`UPDATE redraw_exports SET status='completed',asset_id=?,subtitle_asset_id=?,
        manifest_json=?,quality_summary_json=?,updated_at=?,error_code=NULL,error_message=NULL
        WHERE id=? AND tenant_id=? AND user_id=? AND status='processing' AND deleted_at IS NULL
          AND manifest_json=? AND release_hash=?`).run(registered.mp4_asset_id, registered.srt_asset_id, JSON.stringify(manifest),
        JSON.stringify(release.quality_summary), timestamp, row.id, String(ctx.tenantId), String(ctx.userId), row.manifest_json, row.release_hash);
      if (updated.changes !== 1) throw codedError('REDRAW_COMPOSITION_EXPORT_STATE_INVALID', 'export completion CAS failed');
      assertInputs();
      for (const assetRow of assetRows) {
        if (stableStringify(db.prepare('SELECT * FROM assets WHERE id=?').get(assetRow.id)) !== stableStringify(assetRow)) {
          throw codedError('REDRAW_COMPOSITION_OUTPUT_INVALID', 'export asset changed during publication');
        }
      }
      const result = db.prepare('SELECT * FROM redraw_exports WHERE id=?').get(row.id);
      if (result.status !== 'completed' || result.manifest_json !== JSON.stringify(manifest) || result.release_hash !== release.release_hash
        || result.tenant_id !== String(ctx.tenantId) || result.user_id !== String(ctx.userId) || result.version_id !== row.version_id
        || result.deleted_at !== null || result.asset_id !== registered.mp4_asset_id || result.subtitle_asset_id !== registered.srt_asset_id) {
        throw codedError('REDRAW_COMPOSITION_INPUT_DRIFT', 'export changed during publication');
      }
      return result;
    });
    published = true;
    return completed;
  } catch (error) {
    runImmediate(db, () => {
      db.prepare(`UPDATE redraw_exports SET status='failed',error_code=?,error_message=?,updated_at=?
        WHERE id=? AND tenant_id=? AND user_id=? AND status='processing' AND deleted_at IS NULL`)
        .run(error.code || 'REDRAW_COMPOSITION_FAILED', 'unit composition failed; explicit recovery required', now(ctx),
          row.id, String(ctx.tenantId), String(ctx.userId));
    });
    throw error;
  } finally {
    outputFiles.forEach(file => file.cleanup());
    sourceFile?.cleanup();
    assembly?.cleanup();
    if (!published) cleanupWorkspace(outputs);
    if (sourceSnapshot) await sourceSnapshot.cleanup();
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
