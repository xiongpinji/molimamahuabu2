'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig } = require('../config');
const { assertCurrentApprovedCandidate } = require('./redrawCandidateReviewService');
const { buildSubtitles, buildSubtitlesForLocalizedShots } = require('./redrawSubtitleService');
const { getExecutionRun } = require('./redrawExecutionRunService');
const { getExecutionQueue } = require('./redrawExecutionQueueService');
const { prepareApprovedExecutionUnitMedia } = require('./redrawExecutionUnitReviewService');

const RELEASE_SCHEMA = 'redraw-episode-release-v1';
const UNIT_RELEASE_SCHEMA = 'redraw-execution-unit-release-v1';
const SHA256 = /^[a-f0-9]{64}$/;
const UNIT_RELEASE_KEYS = ['schema_version', 'project_id', 'work_id', 'version_id', 'locale', 'market',
  'run_id', 'run_revision', 'queue_id', 'plan_review_id', 'plan_hash', 'source_sha256',
  'blueprint_hash', 'localization_hash', 'duration_ms', 'audio_mode', 'units', 'subtitles',
  'composition_readiness', 'quality_summary', 'release_hash'];
const RELEASE_UNIT_KEYS = ['unit_id', 'ordinal', 'queue_unit_id', 'unit_hash', 'attempt_id', 'task_id',
  'output_asset_id', 'candidate_hash', 'candidate_sha256', 'candidate_bytes', 'review_hash',
  'production_pack_hash', 'prepared_materials_hash', 'output_contract_hash', 'timeline',
  'output_start_ms', 'output_end_ms', 'parent_shots', 'source_audio_present'];
const RELEASE_PARENT_KEYS = ['parent_shot_id', 'parent_contract_hash', 'parent_start_ms', 'parent_end_ms',
  'source_start_ms', 'source_end_ms', 'unit_start_ms', 'unit_end_ms'];

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
  if (release?.schema_version === UNIT_RELEASE_SCHEMA) return validateUnitReleaseManifest(release);
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

function unitReleaseCheck(valid, code = 'REDRAW_EPISODE_RELEASE_MANIFEST_INVALID') {
  if (!valid) throw releaseError(code, code);
}

function unitReleaseExact(value, keys) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

const unitReleasePositive = value => Number.isSafeInteger(value) && value > 0;
const unitReleaseNonnegative = value => Number.isSafeInteger(value) && value >= 0;
const unitReleaseText = value => typeof value === 'string' && value.trim().length > 0;
const unitReleaseSha = value => typeof value === 'string' && SHA256.test(value);

function unitCompositionReadiness(mode) {
  return mode === 'replace'
    ? { status: 'blocked', audio_requirement: 'approved_dub_required', reason_codes: ['APPROVED_DUB_REQUIRED'] }
    : { status: 'ready', audio_requirement: mode === 'native' ? 'native_candidate_tracks' : 'not_required', reason_codes: [] };
}

function validateUnitReleaseManifest(release) {
  unitReleaseCheck(unitReleaseExact(release, UNIT_RELEASE_KEYS)
    && release.schema_version === UNIT_RELEASE_SCHEMA
    && ['project_id', 'work_id', 'version_id', 'run_id', 'queue_id', 'plan_review_id', 'duration_ms']
      .every(key => unitReleasePositive(release[key]))
    && unitReleaseNonnegative(release.run_revision) && unitReleaseText(release.locale)
    && typeof release.market === 'string'
    && ['plan_hash', 'source_sha256', 'blueprint_hash', 'localization_hash', 'release_hash']
      .every(key => unitReleaseSha(release[key]))
    && ['native', 'replace', 'not_required'].includes(release.audio_mode)
    && Array.isArray(release.units) && release.units.length > 0);
  const ids = new Set(), attempts = new Set(), assets = new Set(), tasks = new Set(), queueUnits = new Set();
  let sourceEnd = 0, outputEnd = 0;
  for (const [ordinal, unit] of release.units.entries()) {
    unitReleaseCheck(unitReleaseExact(unit, RELEASE_UNIT_KEYS)
      && unitReleaseText(unit.unit_id) && !ids.has(unit.unit_id) && unit.ordinal === ordinal
      && ['queue_unit_id', 'attempt_id', 'output_asset_id', 'candidate_bytes'].every(key => unitReleasePositive(unit[key]))
      && unitReleaseText(unit.task_id) && !attempts.has(unit.attempt_id) && !assets.has(unit.output_asset_id)
      && !tasks.has(unit.task_id) && !queueUnits.has(unit.queue_unit_id)
      && ['unit_hash', 'candidate_hash', 'candidate_sha256', 'review_hash', 'production_pack_hash',
        'prepared_materials_hash', 'output_contract_hash'].every(key => unitReleaseSha(unit[key]))
      && typeof unit.source_audio_present === 'boolean'
      && (release.audio_mode !== 'native' || unit.source_audio_present));
    ids.add(unit.unit_id); attempts.add(unit.attempt_id); assets.add(unit.output_asset_id);
    tasks.add(unit.task_id); queueUnits.add(unit.queue_unit_id);
    const timeline = unit.timeline;
    unitReleaseCheck(unitReleaseExact(timeline, ['source_start_ms', 'source_end_ms', 'retained_duration_ms',
      'generated_duration_ms', 'padding_ms'])
      && Object.values(timeline).every(unitReleaseNonnegative)
      && timeline.source_start_ms === sourceEnd && timeline.source_end_ms > sourceEnd
      && timeline.retained_duration_ms === timeline.source_end_ms - timeline.source_start_ms
      && timeline.generated_duration_ms >= timeline.retained_duration_ms
      && timeline.padding_ms === timeline.generated_duration_ms - timeline.retained_duration_ms
      && unit.output_start_ms === outputEnd && unitReleasePositive(unit.output_end_ms)
      && unit.output_end_ms === outputEnd + timeline.retained_duration_ms
      && Array.isArray(unit.parent_shots) && unit.parent_shots.length > 0);
    let parentEnd = sourceEnd;
    const parentIds = new Set();
    for (const parent of unit.parent_shots) {
      unitReleaseCheck(unitReleaseExact(parent, RELEASE_PARENT_KEYS)
        && unitReleaseText(parent.parent_shot_id) && !parentIds.has(parent.parent_shot_id)
        && unitReleaseSha(parent.parent_contract_hash)
        && RELEASE_PARENT_KEYS.slice(2).every(key => unitReleaseNonnegative(parent[key]))
        && parent.parent_start_ms <= parent.source_start_ms && parent.parent_end_ms >= parent.source_end_ms
        && parent.parent_end_ms <= release.duration_ms && parent.source_start_ms === parentEnd
        && parent.source_end_ms > parentEnd && parent.source_end_ms <= timeline.source_end_ms
        && parent.unit_start_ms === parent.source_start_ms - timeline.source_start_ms
        && parent.unit_end_ms === parent.source_end_ms - timeline.source_start_ms);
      parentIds.add(parent.parent_shot_id); parentEnd = parent.source_end_ms;
    }
    unitReleaseCheck(parentEnd === timeline.source_end_ms);
    sourceEnd = timeline.source_end_ms; outputEnd = unit.output_end_ms;
  }
  unitReleaseCheck(sourceEnd === release.duration_ms && outputEnd === release.duration_ms);
  const subtitles = release.subtitles;
  unitReleaseCheck(unitReleaseExact(subtitles, ['locale', 'direction', 'cues', 'srt', 'vtt', 'sha256', 'timing_basis'])
    && subtitles.locale === release.locale && unitReleaseSha(subtitles.sha256)
    && subtitles.timing_basis === 'execution_plan_not_verified_audio_alignment' && Array.isArray(subtitles.cues));
  const dialogueIds = new Set();
  for (const cue of subtitles.cues) {
    unitReleaseCheck(unitReleaseExact(cue, ['segment_id', 'start_ms', 'end_ms', 'text', 'lines'])
      && unitReleaseText(cue.segment_id) && !dialogueIds.has(cue.segment_id)
      && unitReleaseText(cue.text) && unitReleaseNonnegative(cue.start_ms) && unitReleasePositive(cue.end_ms)
      && cue.end_ms > cue.start_ms && Array.isArray(cue.lines)
      && release.units.some(unit => cue.start_ms >= unit.output_start_ms && cue.end_ms <= unit.output_end_ms));
    dialogueIds.add(cue.segment_id);
  }
  const rebuilt = buildSubtitles(subtitles.cues, { locale: release.locale });
  const subtitleContent = { locale: rebuilt.locale, direction: rebuilt.direction,
    cues: rebuilt.cues, srt: rebuilt.srt, vtt: rebuilt.vtt };
  const { sha256: subtitleDigest, timing_basis: _basis, ...storedSubtitles } = subtitles;
  unitReleaseCheck(rebuilt.status === 'ready' && stableJson(subtitleContent) === stableJson(storedSubtitles)
    && sha256(stableJson(subtitleContent)) === subtitleDigest
    && unitReleaseExact(release.composition_readiness, ['status', 'audio_requirement', 'reason_codes'])
    && stableJson(release.composition_readiness) === stableJson(unitCompositionReadiness(release.audio_mode))
    && unitReleaseExact(release.quality_summary, ['decision', 'approved_unit_count', 'human_review_count',
      'final_media_review', 'dialogue_alignment'])
    && release.quality_summary.decision === 'approved_inputs'
    && release.quality_summary.approved_unit_count === release.units.length
    && release.quality_summary.human_review_count === release.units.length
    && release.quality_summary.final_media_review === 'pending'
    && release.quality_summary.dialogue_alignment === 'not_verified');
}

function ownedUnitReleaseVersion(ctx, versionId) {
  const version = ctx.db.prepare(`SELECT v.*, w.project_id, w.source_asset_id, w.source_fingerprint,
    w.duration_ms AS source_duration_ms FROM redraw_versions v
    JOIN redraw_works w ON w.id=v.work_id AND w.tenant_id=v.tenant_id AND w.user_id=v.user_id AND w.deleted_at IS NULL
    JOIN redraw_projects p ON p.id=w.project_id AND p.tenant_id=v.tenant_id AND p.user_id=v.user_id AND p.deleted_at IS NULL
    WHERE v.id=? AND v.tenant_id=? AND v.user_id=? AND v.deleted_at IS NULL`)
    .get(versionId, ctx.tenantId, ctx.userId);
  if (!version) throw releaseError('REDRAW_EPISODE_RELEASE_VERSION_NOT_FOUND', 'version not found');
  return version;
}

async function buildUnitEpisodeRelease(ctx, input) {
  const invalid = 'REDRAW_EPISODE_RELEASE_INPUT_INVALID';
  const drift = 'REDRAW_EPISODE_RELEASE_INPUT_DRIFT';
  unitReleaseCheck(unitReleaseExact(input, ['schema_version', 'version_id', 'run_id', 'expected_plan_hash', 'expected_run_revision'])
    && input.schema_version === UNIT_RELEASE_SCHEMA && unitReleasePositive(input.version_id)
    && unitReleasePositive(input.run_id) && unitReleaseSha(input.expected_plan_hash)
    && unitReleaseNonnegative(input.expected_run_revision)
    && unitReleaseText(ctx.tenantId) && unitReleaseText(ctx.userId)
    && path.isAbsolute(String(ctx.storageRoot || '')), invalid);
  const version = ownedUnitReleaseVersion(ctx, input.version_id);
  const run = getExecutionRun(ctx, input.version_id, input.run_id);
  unitReleaseCheck(run.binding_status === 'current' && run.status === 'completed'
    && run.plan_hash === input.expected_plan_hash && run.revision === input.expected_run_revision
    && run.units.length > 0 && run.units.every(unit => unit.status === 'approved'), drift);
  const queue = getExecutionQueue(ctx, version.id);
  const plan = queue.saved_review?.plan;
  unitReleaseCheck(queue.queue?.id === run.queue_id && queue.saved_review?.id === run.review_id
    && queue.saved_review.status === 'current' && plan?.plan_hash === run.plan_hash
    && plan.bindings.source_sha256 === version.source_fingerprint
    && String(plan.bindings.source_asset_id) === String(version.source_asset_id)
    && plan.bindings.locale === version.locale && plan.bindings.market === version.market, drift);
  const sourceAsset = ctx.db.prepare('SELECT * FROM assets WHERE id=? AND deleted_at IS NULL').get(version.source_asset_id);
  unitReleaseCheck(sourceAsset && unitReleaseText(sourceAsset.local_path), drift);
  const candidates = ctx.db.prepare(`SELECT qu.unit_id, a.candidate_hash FROM redraw_execution_unit_attempts a
    JOIN redraw_execution_queue_units qu ON qu.id=a.queue_unit_id WHERE a.run_id=? ORDER BY qu.ordinal`).all(run.id);
  unitReleaseCheck(candidates.length === run.units.length
    && candidates.every((row, index) => row.unit_id === run.units[index].id && unitReleaseSha(row.candidate_hash)), drift);
  const snapshots = [];
  let primaryError;
  try {
    for (const candidate of candidates) snapshots.push(await prepareApprovedExecutionUnitMedia(ctx,
      version.id, run.id, candidate.unit_id, candidate.candidate_hash));
    const units = [], dialogueSegments = [], dialogueIds = new Set();
    let outputStart = 0;
    for (const [ordinal, snapshot] of snapshots.entries()) {
      const binding = snapshot.bindings;
      unitReleaseCheck(snapshot.ordinal === ordinal && snapshot.run_revision === run.revision
        && snapshot.audio_mode === plan.capability.audio_mode && binding.run_id === run.id
        && binding.tenant_id === ctx.tenantId && binding.user_id === ctx.userId && binding.work_id === version.work_id
        && binding.version_id === version.id && binding.project_id === version.project_id
        && binding.queue_id === run.queue_id && binding.review_id === run.review_id
        && binding.plan_hash === run.plan_hash && binding.unit_id === run.units[ordinal].id
        && binding.unit_hash === run.units[ordinal].unit_hash && snapshot.sha256 === snapshot.candidate.sha256
        && snapshot.size === snapshot.candidate.bytes, drift);
      const digest = crypto.createHash('sha256');
      let bytes = 0;
      for await (const chunk of snapshot.createReadStream()) { digest.update(chunk); bytes += chunk.length; }
      unitReleaseCheck(bytes === snapshot.size && digest.digest('hex') === snapshot.sha256, drift);
      for (const dialogue of snapshot.dialogues) {
        unitReleaseCheck(unitReleaseText(dialogue.id) && !dialogueIds.has(dialogue.id)
          && unitReleaseText(dialogue.target_text) && unitReleaseNonnegative(dialogue.unit_start_ms)
          && unitReleasePositive(dialogue.unit_end_ms) && dialogue.unit_end_ms > dialogue.unit_start_ms
          && dialogue.unit_end_ms <= snapshot.timeline.retained_duration_ms, 'REDRAW_EPISODE_RELEASE_SUBTITLE_INVALID');
        dialogueIds.add(dialogue.id);
        dialogueSegments.push({ segment_id: dialogue.id, start_ms: outputStart + dialogue.unit_start_ms,
          end_ms: outputStart + dialogue.unit_end_ms, text: dialogue.target_text });
      }
      units.push({ unit_id: binding.unit_id, ordinal, queue_unit_id: binding.queue_unit_id,
        unit_hash: binding.unit_hash, attempt_id: binding.attempt_id, task_id: binding.task_id,
        output_asset_id: binding.output_asset_id, candidate_hash: snapshot.candidate.hash,
        candidate_sha256: snapshot.sha256, candidate_bytes: snapshot.size, review_hash: snapshot.review_hash,
        production_pack_hash: binding.production_pack_hash, prepared_materials_hash: binding.prepared_materials_hash,
        output_contract_hash: binding.output_contract_hash, timeline: structuredClone(snapshot.timeline),
        output_start_ms: outputStart, output_end_ms: outputStart + snapshot.timeline.retained_duration_ms,
        parent_shots: snapshot.parent_shots.map(parent => Object.fromEntries(RELEASE_PARENT_KEYS.map(key => [key, parent[key]]))),
        source_audio_present: snapshot.candidate.audio_codec !== null });
      outputStart += snapshot.timeline.retained_duration_ms;
    }
    unitReleaseCheck(outputStart === version.source_duration_ms, drift);
    const subtitleResult = buildSubtitles(dialogueSegments, { locale: version.locale });
    unitReleaseCheck(subtitleResult.status === 'ready', 'REDRAW_EPISODE_RELEASE_SUBTITLE_INVALID');
    const subtitles = { locale: subtitleResult.locale, direction: subtitleResult.direction,
      cues: subtitleResult.cues, srt: subtitleResult.srt, vtt: subtitleResult.vtt };
    const unsigned = { schema_version: UNIT_RELEASE_SCHEMA, project_id: version.project_id, work_id: version.work_id,
      version_id: version.id, locale: version.locale, market: version.market, run_id: run.id, run_revision: run.revision,
      queue_id: run.queue_id, plan_review_id: run.review_id, plan_hash: run.plan_hash,
      source_sha256: plan.bindings.source_sha256, blueprint_hash: plan.bindings.blueprint_hash,
      localization_hash: plan.bindings.localization_hash, duration_ms: outputStart, audio_mode: plan.capability.audio_mode,
      units, subtitles: { ...subtitles, sha256: sha256(stableJson(subtitles)),
        timing_basis: 'execution_plan_not_verified_audio_alignment' },
      composition_readiness: unitCompositionReadiness(plan.capability.audio_mode),
      quality_summary: { decision: 'approved_inputs', approved_unit_count: units.length, human_review_count: units.length,
        final_media_review: 'pending', dialogue_alignment: 'not_verified' } };
    const release = { ...unsigned, release_hash: sha256(stableJson(unsigned)) };
    validateUnitReleaseManifest(release);
    // No awaits after this boundary. Earlier unit bytes and approvals are rechecked
    // together with the current source/owner/locale after the last input stream.
    return ctx.db.transaction(() => {
      unitReleaseCheck(stableJson(ownedUnitReleaseVersion(ctx, version.id)) === stableJson(version), drift);
      unitReleaseCheck(stableJson(getExecutionRun(ctx, version.id, run.id)) === stableJson(run), drift);
      unitReleaseCheck(stableJson(getExecutionQueue(ctx, version.id)) === stableJson(queue), drift);
      unitReleaseCheck(stableJson(ctx.db.prepare('SELECT * FROM assets WHERE id=? AND deleted_at IS NULL').get(version.source_asset_id))
        === stableJson(sourceAsset) && sha256File(readableFile(ctx, sourceAsset.local_path, 'source')) === plan.bindings.source_sha256, drift);
      for (const snapshot of snapshots) snapshot.assertCurrentBinding();
      return release;
    }).deferred();
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError;
    for (const snapshot of snapshots) {
      try { snapshot.cleanup(); } catch (error) { cleanupError ??= error; }
    }
    if (!primaryError && cleanupError) throw cleanupError;
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
  if (input?.schema_version === UNIT_RELEASE_SCHEMA || ['run_id', 'expected_run_revision'].some(key => key in Object(input))) {
    return buildUnitEpisodeRelease(ctx, input);
  }
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
