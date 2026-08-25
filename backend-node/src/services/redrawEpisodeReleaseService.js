'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig } = require('../config');
const { assertCurrentApprovedCandidate } = require('./redrawCandidateReviewService');
const { buildSubtitlesForLocalizedShots } = require('./redrawSubtitleService');

const RELEASE_SCHEMA = 'redraw-episode-release-v1';
const SHA256 = /^[a-f0-9]{64}$/;

function releaseError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function parseJson(value, fallback, label) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value ?? ''));
    return parsed == null ? fallback : parsed;
  } catch (_) {
    throw releaseError('REDRAW_EPISODE_RELEASE_INPUT_INVALID', `${label} JSON invalid`);
  }
}

function positiveVersionId(input) {
  const id = Number(input?.version_id ?? input?.versionId);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw releaseError('REDRAW_EPISODE_RELEASE_VERSION_NOT_FOUND', 'version not found');
  }
  return id;
}

function storageRoot(ctx) {
  const configured = ctx.storageRoot || ctx.storage_root || ctx?.config?.storage?.local_path;
  if (configured) return path.resolve(configured);
  try {
    return path.resolve(loadConfig().storage.local_path);
  } catch (_) {
    throw releaseError('REDRAW_EPISODE_RELEASE_STORAGE_NOT_CONFIGURED', 'storage root not configured');
  }
}

function isInside(root, child) {
  const relative = path.relative(root, child);
  return relative === '' || Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function readableFile(ctx, localPath, label) {
  const root = storageRoot(ctx);
  const relative = String(localPath || '').replace(/^\/static\//, '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!relative || relative.includes('\0') || relative.split('/').includes('..') || path.isAbsolute(relative)) {
    throw releaseError('REDRAW_EPISODE_RELEASE_INPUT_DRIFT', `${label} path invalid`);
  }
  const absolute = path.resolve(root, relative);
  try {
    const realRoot = fs.realpathSync.native(root);
    const realFile = fs.realpathSync.native(absolute);
    if (!isInside(realRoot, realFile)) throw new Error('outside storage');
    const stat = fs.statSync(realFile);
    if (!stat.isFile()) throw new Error('not file');
    fs.accessSync(realFile, fs.constants.R_OK);
    return realFile;
  } catch (_) {
    throw releaseError('REDRAW_EPISODE_RELEASE_INPUT_DRIFT', `${label} file unreadable`);
  }
}

function textOf(segment) {
  return String(segment?.target_text ?? segment?.localized_text ?? segment?.text ?? '').trim();
}

function rawTextOf(segment) {
  return String(segment?.target_text ?? segment?.localized_text ?? segment?.text ?? '');
}

function segmentIdOf(segment, index) {
  return String(segment?.segment_id ?? segment?.turn_id ?? segment?.id ?? index);
}

function matchesLocalizedTurn(shot, generated, localized, index) {
  const generatedStart = generated?.start_ms;
  const generatedEnd = generated?.end_ms;
  const localizedStart = localized?.start_ms;
  const localizedEnd = localized?.end_ms;
  return generated?.turn_index === index
    && Number.isSafeInteger(generatedStart)
    && Number.isSafeInteger(generatedEnd)
    && Number.isSafeInteger(localizedStart)
    && Number.isSafeInteger(localizedEnd)
    && generatedStart === localizedStart
    && generatedEnd === localizedEnd
    && generatedStart >= Number(shot.start_ms)
    && generatedEnd <= Number(shot.end_ms)
    && generatedEnd > generatedStart
    && String(generated?.speaker_id ?? '') === String(localized?.speaker_id ?? '')
    && String(generated?.text_hash ?? '') === sha256(rawTextOf(localized));
}

function validateTimeline(shots) {
  if (!shots.length) throw releaseError('REDRAW_EPISODE_RELEASE_SHOTS_EMPTY', 'version has no shots');
  let expectedStart = 0;
  for (const [index, shot] of shots.entries()) {
    if (Number(shot.shot_index) !== index + 1) {
      throw releaseError('REDRAW_EPISODE_RELEASE_ORDER_INVALID', 'shot order has a gap');
    }
    if (Number(shot.start_ms) !== expectedStart
      || Number(shot.end_ms) <= Number(shot.start_ms)
      || Number(shot.duration_ms) !== Number(shot.end_ms) - Number(shot.start_ms)) {
      throw releaseError('REDRAW_EPISODE_RELEASE_TIMELINE_INVALID', 'shot timeline has a gap or overlap');
    }
    expectedStart = Number(shot.end_ms);
  }
}

function approvedReview(ctx, shot) {
  if (!Number.isSafeInteger(Number(shot.approved_candidate_review_id))
    || Number(shot.approved_candidate_review_id) < 1
    || !['approved', 'included'].includes(String(shot.status))) {
    throw releaseError('REDRAW_EPISODE_RELEASE_CANDIDATE_NOT_APPROVED', 'current candidate not approved');
  }
  try {
    return assertCurrentApprovedCandidate(ctx, {
      shot_id: Number(shot.id),
      video_generation_id: Number(shot.video_generation_id),
    });
  } catch (error) {
    if (error?.code === 'REDRAW_CANDIDATE_NOT_APPROVED') {
      throw releaseError('REDRAW_EPISODE_RELEASE_INPUT_DRIFT', 'approved candidate or dependencies changed', error);
    }
    throw error;
  }
}

function ownedAudio(ctx, shot, segment, index) {
  const id = Number(segment?.audio_asset_id);
  const segmentId = segmentIdOf(segment, index);
  if (!Number.isSafeInteger(id) || id < 1
    || segment?.status !== 'completed' || segment?.reservation_status !== 'confirmed') {
    throw releaseError('REDRAW_EPISODE_RELEASE_AUDIO_CONTRACT_INVALID', 'dialogue audio is not completed and confirmed');
  }
  const asset = ctx.db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!asset || asset.type !== 'audio' || asset.category !== 'redraw_dialogue') {
    throw releaseError('REDRAW_EPISODE_RELEASE_AUDIO_CONTRACT_INVALID', 'dialogue audio asset invalid');
  }
  const metadata = parseJson(asset.metadata, {}, 'asset.metadata')?.redraw_dialogue;
  if (!metadata || String(metadata.tenant_id) !== String(ctx.tenantId)
    || String(metadata.user_id) !== String(ctx.userId)
    || Number(metadata.version_id) !== Number(shot.version_id)
    || String(metadata.segment_id) !== segmentId
    || String(metadata.reservation_id) !== String(segment.reservation_id)
    || String(metadata.idempotency_key) !== String(segment.idempotency_key)) {
    throw releaseError('REDRAW_EPISODE_RELEASE_AUDIO_CONTRACT_INVALID', 'dialogue audio owner binding invalid');
  }
  const reservation = ctx.db.prepare(`
    SELECT id FROM tenant_usage_reservations
    WHERE id = ? AND tenant_id = ? AND status = 'confirmed'
      AND resource_type = 'redraw_dialogue' AND resource_id = ?
  `).get(String(segment.reservation_id), String(ctx.tenantId), `${shot.version_id}:${segmentId}`);
  if (!reservation) throw releaseError('REDRAW_EPISODE_RELEASE_AUDIO_CONTRACT_INVALID', 'dialogue reservation invalid');
  const startMs = Number(segment.start_ms);
  const endMs = Number(segment.end_ms);
  const durationMs = Math.round(Number(asset.duration) * 1000);
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)
    || startMs < Number(shot.start_ms) || endMs > Number(shot.end_ms) || endMs <= startMs
    || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > endMs - startMs) {
    throw releaseError('REDRAW_EPISODE_RELEASE_AUDIO_CONTRACT_INVALID', 'dialogue audio timing invalid');
  }
  return {
    segment_id: segmentId,
    start_ms: startMs,
    end_ms: endMs,
    sha256: sha256File(readableFile(ctx, asset.local_path, 'audio')),
  };
}

function audioHash(ctx, shot, localized) {
  const draft = parseJson(shot.draft_json, {}, 'draft_json');
  const generated = draft?.dialogue_generation?.segments || [];
  if (!Array.isArray(generated)) {
    throw releaseError('REDRAW_EPISODE_RELEASE_AUDIO_CONTRACT_INVALID', 'dialogue audio segments invalid');
  }
  if (!localized.length) {
    if (generated.length) throw releaseError('REDRAW_EPISODE_RELEASE_AUDIO_CONTRACT_INVALID', 'silent shot contains dialogue audio');
    return sha256(stableJson({ dialogue_mode: 'silent', segments: [] }));
  }
  if (localized.length !== generated.length
    || generated.some((segment, index) => !matchesLocalizedTurn(shot, segment, localized[index], index))) {
    throw releaseError('REDRAW_EPISODE_RELEASE_AUDIO_CONTRACT_INVALID', 'dialogue audio does not match current localized dialogue');
  }
  const records = generated.map((segment, index) => ownedAudio(ctx, shot, segment, index));
  return sha256(stableJson({ dialogue_mode: 'dialogue', segments: records }));
}

function subtitleHash(shot, localized, locale) {
  let subtitles;
  try {
    subtitles = buildSubtitlesForLocalizedShots([{ ...shot, localized_dialogue_json: localized }], { locale });
  } catch (error) {
    throw releaseError('REDRAW_EPISODE_RELEASE_SUBTITLE_INVALID', 'localized subtitles are outside shot bounds', error);
  }
  if (subtitles.status !== 'ready') {
    throw releaseError('REDRAW_EPISODE_RELEASE_SUBTITLE_INVALID', 'localized subtitles need rewrite');
  }
  return sha256(stableJson({ cues: subtitles.cues, srt: subtitles.srt, vtt: subtitles.vtt }));
}

function calculateReleaseHash(release) {
  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    throw releaseError('REDRAW_EPISODE_RELEASE_MANIFEST_INVALID', 'release manifest invalid');
  }
  const { release_hash: _ignored, ...unsigned } = release;
  return sha256(stableJson(unsigned));
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw releaseError('REDRAW_EPISODE_RELEASE_MANIFEST_INVALID', `${label} shape invalid`);
  }
}

function validateReleaseManifest(release) {
  assertExactKeys(release, [
    'schema_version', 'project_id', 'work_id', 'version_id', 'locale', 'market',
    'shots', 'quality_summary', 'release_hash',
  ], 'release');
  if (release.schema_version !== RELEASE_SCHEMA || !Array.isArray(release.shots) || !release.shots.length) {
    throw releaseError('REDRAW_EPISODE_RELEASE_MANIFEST_INVALID', 'release contract invalid');
  }
  for (const shot of release.shots) {
    assertExactKeys(shot, [
      'shot_id', 'shot_index', 'start_ms', 'end_ms', 'candidate_review_id',
      'candidate_sha256', 'audio_sha256', 'subtitle_sha256', 'dependency_hash',
    ], 'release.shots[]');
    if (![shot.candidate_sha256, shot.audio_sha256, shot.subtitle_sha256, shot.dependency_hash]
      .every((digest) => SHA256.test(String(digest || '').toLowerCase()))) {
      throw releaseError('REDRAW_EPISODE_RELEASE_MANIFEST_INVALID', 'release shot hash invalid');
    }
  }
  assertExactKeys(release.quality_summary, [
    'decision', 'approved_shot_count', 'automatic_review_count', 'human_review_count',
  ], 'release.quality_summary');
  const automatic = Number(release.quality_summary.automatic_review_count);
  const human = Number(release.quality_summary.human_review_count);
  if (release.quality_summary.decision !== 'approved'
    || Number(release.quality_summary.approved_shot_count) !== release.shots.length
    || !Number.isSafeInteger(automatic) || automatic < 0
    || !Number.isSafeInteger(human) || human < 0
    || automatic + human !== release.shots.length) {
    throw releaseError('REDRAW_EPISODE_RELEASE_MANIFEST_INVALID', 'release quality summary invalid');
  }
}

function assertReleaseHash(release, expectedHash) {
  validateReleaseManifest(release);
  const embedded = String(release?.release_hash || '').toLowerCase();
  const expected = String(expectedHash || embedded).toLowerCase();
  const actual = calculateReleaseHash(release);
  if (!SHA256.test(embedded) || !SHA256.test(expected) || embedded !== expected || actual !== expected) {
    throw releaseError('REDRAW_EPISODE_RELEASE_HASH_MISMATCH', 'release hash mismatch');
  }
  return actual;
}

async function buildEpisodeRelease(ctx, input = {}) {
  if (!ctx?.db) throw releaseError('REDRAW_EPISODE_RELEASE_CONTEXT_INVALID', 'database required');
  const versionId = positiveVersionId(input);
  const version = ctx.db.prepare(`
    SELECT v.*, w.id AS owned_work_id, w.project_id
    FROM redraw_versions v
    JOIN redraw_works w ON w.id = v.work_id AND w.deleted_at IS NULL
    JOIN redraw_projects p ON p.id = w.project_id AND p.deleted_at IS NULL
    WHERE v.id = ? AND v.tenant_id = ? AND v.user_id = ? AND v.deleted_at IS NULL
      AND w.tenant_id = ? AND w.user_id = ?
      AND p.tenant_id = ? AND p.user_id = ?
  `).get(
    versionId, String(ctx.tenantId), String(ctx.userId),
    String(ctx.tenantId), String(ctx.userId), String(ctx.tenantId), String(ctx.userId),
  );
  if (!version) throw releaseError('REDRAW_EPISODE_RELEASE_VERSION_NOT_FOUND', 'version not found');
  const shots = ctx.db.prepare(`
    SELECT * FROM redraw_shots
    WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    ORDER BY batch_index, shot_index, id
  `).all(versionId, String(ctx.tenantId), String(ctx.userId));
  validateTimeline(shots);

  const releaseShots = [];
  const reviewSources = { automatic: 0, human: 0 };
  for (const shot of shots) {
    const review = approvedReview(ctx, shot);
    reviewSources[review.decision_source] += 1;
    const localized = parseJson(shot.localized_dialogue_json, [], 'localized_dialogue_json');
    if (!Array.isArray(localized) || localized.some((segment) => !textOf(segment))) {
      throw releaseError('REDRAW_EPISODE_RELEASE_SUBTITLE_INVALID', 'localized dialogue invalid');
    }
    releaseShots.push({
      shot_id: Number(shot.id),
      shot_index: Number(shot.shot_index),
      start_ms: Number(shot.start_ms),
      end_ms: Number(shot.end_ms),
      candidate_review_id: Number(review.id),
      candidate_sha256: review.candidate_sha256,
      audio_sha256: audioHash(ctx, shot, localized),
      subtitle_sha256: subtitleHash(shot, localized, version.locale),
      dependency_hash: review.dependency_hash,
    });
  }
  const unsigned = {
    schema_version: RELEASE_SCHEMA,
    project_id: Number(version.project_id),
    work_id: Number(version.owned_work_id),
    version_id: versionId,
    locale: String(version.locale),
    market: String(version.market || ''),
    shots: releaseShots,
    quality_summary: {
      decision: 'approved',
      approved_shot_count: releaseShots.length,
      automatic_review_count: reviewSources.automatic,
      human_review_count: reviewSources.human,
    },
  };
  return { ...unsigned, release_hash: sha256(stableJson(unsigned)) };
}

module.exports = {
  buildEpisodeRelease,
  calculateReleaseHash,
  assertReleaseHash,
  validateReleaseManifest,
};
