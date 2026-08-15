const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const sharp = require('sharp');

const SCHEMA_VERSION = 'redraw-full-frame-coverage-v1';
const LOCK_SCHEMA_VERSION = 'redraw-full-frame-model-lock-v1';
const STATUS = 'generated';
const HASH_RE = /^[a-f0-9]{64}$/;
const COMPONENT_ORDER = Object.freeze(['face_detector', 'person_detector', 'text_detector', 'tracker']);
const REVIEW_REASON_ORDER = Object.freeze([
  'shot_start',
  'shot_end',
  'one_second',
  'shot_boundary',
  'person_track_start',
  'person_track_end',
  'text_track_start',
  'text_track_end',
  'visibility_change',
  'low_track_confidence',
  'mask_area_change',
  'detector_disagreement',
  'text_region_count_change',
]);
const REVIEW_REASON_SET = new Set(REVIEW_REASON_ORDER);
const SENSITIVE_KEYS = /^(url|ocr_text|text|content|prompt|key|token|authorization|approved)$/i;
const PLACEHOLDER_VALUES = new Set(['placeholder', 'unknown', 'todo', 'example']);

class CoverageError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RedrawFullFrameCoverageError';
    this.code = code;
  }
}

function fail(code) {
  throw new CoverageError(code);
}

function withCode(fn, code) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof CoverageError) throw error;
    fail(code);
  }
}

async function withCodeAsync(fn, code) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof CoverageError) throw error;
    fail(code);
  }
}

function assertPlainObject(value, code = 'REDRAW_FULL_FRAME_OUTPUT_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
}

function scanForbiddenKeys(value, code = 'REDRAW_FULL_FRAME_OUTPUT_INVALID') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) scanForbiddenKeys(item, code);
    return;
  }
  for (const key of Object.keys(value)) {
    if (SENSITIVE_KEYS.test(key)) fail(code);
    scanForbiddenKeys(value[key], code);
  }
}

function assertExactKeys(value, allowedKeys, code = 'REDRAW_FULL_FRAME_OUTPUT_INVALID') {
  assertPlainObject(value, code);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(code);
  }
  for (const key of allowedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(code);
  }
}

function assertAllowedKeys(value, allowedKeys, requiredKeys, code = 'REDRAW_FULL_FRAME_OUTPUT_INVALID') {
  assertPlainObject(value, code);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(code);
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(code);
  }
}

function requireString(value, code = 'REDRAW_FULL_FRAME_OUTPUT_INVALID') {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) fail(code);
  return value;
}

function requireHash(value, code = 'REDRAW_FULL_FRAME_OUTPUT_INVALID') {
  requireString(value, code);
  if (!HASH_RE.test(value)) fail(code);
  return value;
}

function requirePositiveInt(value, code = 'REDRAW_FULL_FRAME_OUTPUT_INVALID') {
  if (!Number.isInteger(value) || value <= 0) fail(code);
  return value;
}

function requireNonNegativeInt(value, code = 'REDRAW_FULL_FRAME_OUTPUT_INVALID') {
  if (!Number.isInteger(value) || value < 0) fail(code);
  return value;
}

function requireFiniteNumber(value, code = 'REDRAW_FULL_FRAME_MASK_INVALID') {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(code);
  return value;
}

function normalizeRegionIdList(value) {
  if (!Array.isArray(value)) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
  const seen = new Set();
  for (const item of value) {
    requireString(item);
    if (seen.has(item)) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
    seen.add(item);
  }
  return [...value].sort();
}

function stableJson(value) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
  }
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function normalizePathSeparators(value) {
  return value.replace(/\\/g, '/');
}

function isUnsafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) return true;
  if (value.includes('\0')) return true;
  if (value === '.' || value === '..') return true;
  if (/^[A-Za-z]:/.test(value)) return true;
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) return true;
  const normalized = normalizePathSeparators(value);
  return normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..');
}

function isInsideOrSame(rootReal, targetReal) {
  const relative = path.relative(rootReal, targetReal);
  return relative === '' || (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertRegularFile(stat, code) {
  if (!stat.isFile()) fail(code);
}

async function secureReadFile({ rootReal, relativePath, code }) {
  if (isUnsafeRelativePath(relativePath)) fail(code);
  const normalized = normalizePathSeparators(relativePath);
  const target = path.resolve(rootReal, normalized);
  if (!isInsideOrSame(rootReal, target)) fail(code);

  const realBefore = await withCodeAsync(() => fsp.realpath(target), code);
  if (!isInsideOrSame(rootReal, realBefore)) fail(code);
  const statExpected = await withCodeAsync(() => fsp.stat(realBefore, { bigint: true }), code);
  assertRegularFile(statExpected, code);

  let handle;
  try {
    handle = await withCodeAsync(() => fsp.open(realBefore, 'r'), code);
    const statBefore = await handle.stat({ bigint: true });
    assertRegularFile(statBefore, code);
    if (!sameIdentity(statExpected, statBefore)) fail(code);
    const bytes = await handle.readFile();
    const statAfter = await handle.stat({ bigint: true });
    assertRegularFile(statAfter, code);
    const realAfter = await withCodeAsync(() => fsp.realpath(realBefore), code);
    if (realAfter !== realBefore) fail(code);
    const statPathAfter = await withCodeAsync(() => fsp.stat(realAfter, { bigint: true }), code);
    assertRegularFile(statPathAfter, code);
    if (!sameIdentity(statBefore, statAfter) || !sameIdentity(statBefore, statPathAfter)) fail(code);
    return { bytes, normalized };
  } catch (error) {
    if (error instanceof CoverageError) throw error;
    fail(code);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function getRootReal(evidenceRoot) {
  if (typeof evidenceRoot !== 'string' || evidenceRoot.length === 0) fail('REDRAW_FULL_FRAME_SOURCE_MISMATCH');
  const rootReal = await withCodeAsync(() => fsp.realpath(evidenceRoot), 'REDRAW_FULL_FRAME_SOURCE_MISMATCH');
  const stat = await withCodeAsync(() => fsp.stat(rootReal), 'REDRAW_FULL_FRAME_SOURCE_MISMATCH');
  if (!stat.isDirectory()) fail('REDRAW_FULL_FRAME_SOURCE_MISMATCH');
  return rootReal;
}

function validateSource(source) {
  return withCode(() => {
    assertExactKeys(source, ['sha256', 'duration_ms', 'width', 'height', 'frame_count', 'time_base'], 'REDRAW_FULL_FRAME_SOURCE_MISMATCH');
    assertExactKeys(source.time_base, ['numerator', 'denominator'], 'REDRAW_FULL_FRAME_SOURCE_MISMATCH');
    return {
      sha256: requireHash(source.sha256, 'REDRAW_FULL_FRAME_SOURCE_MISMATCH'),
      duration_ms: requirePositiveInt(source.duration_ms, 'REDRAW_FULL_FRAME_SOURCE_MISMATCH'),
      width: requirePositiveInt(source.width, 'REDRAW_FULL_FRAME_SOURCE_MISMATCH'),
      height: requirePositiveInt(source.height, 'REDRAW_FULL_FRAME_SOURCE_MISMATCH'),
      frame_count: requirePositiveInt(source.frame_count, 'REDRAW_FULL_FRAME_SOURCE_MISMATCH'),
      time_base: {
        numerator: requirePositiveInt(source.time_base.numerator, 'REDRAW_FULL_FRAME_SOURCE_MISMATCH'),
        denominator: requirePositiveInt(source.time_base.denominator, 'REDRAW_FULL_FRAME_SOURCE_MISMATCH'),
      },
    };
  }, 'REDRAW_FULL_FRAME_SOURCE_MISMATCH');
}

function parseShotNumber(shotId) {
  const match = /^shot-([1-9]\d*)$/.exec(shotId);
  if (!match) fail('REDRAW_FULL_FRAME_FRAME_GAP');
  return Number(match[1]);
}

function validateShots(shots, source) {
  if (!Array.isArray(shots) || shots.length === 0) fail('REDRAW_FULL_FRAME_FRAME_GAP');
  const sorted = shots.map((shot) => {
    assertExactKeys(shot, ['shot_id', 'start_ms', 'end_ms'], 'REDRAW_FULL_FRAME_FRAME_GAP');
    const number = parseShotNumber(shot.shot_id);
    const start = requireNonNegativeInt(shot.start_ms, 'REDRAW_FULL_FRAME_FRAME_GAP');
    const end = requirePositiveInt(shot.end_ms, 'REDRAW_FULL_FRAME_FRAME_GAP');
    if (end <= start) fail('REDRAW_FULL_FRAME_FRAME_GAP');
    return { shot_id: shot.shot_id, start_ms: start, end_ms: end, number };
  }).sort((left, right) => left.number - right.number);

  for (let index = 0; index < sorted.length; index += 1) {
    if (index > 0 && sorted[index].number === sorted[index - 1].number) fail('REDRAW_FULL_FRAME_FRAME_GAP');
    if (index === 0 && sorted[index].start_ms !== 0) fail('REDRAW_FULL_FRAME_FRAME_GAP');
    if (index > 0 && sorted[index].start_ms !== sorted[index - 1].end_ms) fail('REDRAW_FULL_FRAME_FRAME_GAP');
  }
  if (sorted[sorted.length - 1].end_ms !== source.duration_ms) fail('REDRAW_FULL_FRAME_FRAME_GAP');
  return sorted.map(({ shot_id, start_ms, end_ms }) => ({ shot_id, start_ms, end_ms }));
}

function expectedTimestampMs(frame, source) {
  const numerator = BigInt(frame.timestamp_ticks) * BigInt(source.time_base.numerator) * 1000n;
  const denominator = BigInt(source.time_base.denominator);
  return Number((numerator + (denominator / 2n)) / denominator);
}

async function validateFrame(frame, source, shotById, rootReal) {
  assertExactKeys(frame, [
    'frame_index',
    'timestamp_ticks',
    'timestamp_ms',
    'shot_id',
    'path',
    'sha256',
    'width',
    'height',
    'person_region_ids',
    'text_region_ids',
    'review_point_reasons',
    'review_status',
  ], 'REDRAW_FULL_FRAME_OUTPUT_INVALID');
  const frameIndex = requireNonNegativeInt(frame.frame_index, 'REDRAW_FULL_FRAME_FRAME_GAP');
  const timestampTicks = requireNonNegativeInt(frame.timestamp_ticks, 'REDRAW_FULL_FRAME_FRAME_GAP');
  const timestampMs = requireNonNegativeInt(frame.timestamp_ms, 'REDRAW_FULL_FRAME_FRAME_GAP');
  if (timestampMs !== expectedTimestampMs({ timestamp_ticks: timestampTicks }, source)) fail('REDRAW_FULL_FRAME_FRAME_GAP');
  if (timestampMs >= source.duration_ms) fail('REDRAW_FULL_FRAME_FRAME_GAP');
  const shot = shotById.get(frame.shot_id);
  if (!shot || timestampMs < shot.start_ms || timestampMs >= shot.end_ms) fail('REDRAW_FULL_FRAME_FRAME_GAP');
  if (frame.width !== source.width || frame.height !== source.height) fail('REDRAW_FULL_FRAME_SOURCE_MISMATCH');
  requireHash(frame.sha256, 'REDRAW_FULL_FRAME_SOURCE_MISMATCH');
  const personRegionIds = normalizeRegionIdList(frame.person_region_ids);
  const textRegionIds = normalizeRegionIdList(frame.text_region_ids);
  if (!Array.isArray(frame.review_point_reasons)) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
  for (const reason of frame.review_point_reasons) {
    if (!REVIEW_REASON_SET.has(reason)) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
  }
  if (!['pending', 'not_required'].includes(frame.review_status)) fail('REDRAW_FULL_FRAME_APPROVAL_FORBIDDEN');

  const read = await secureReadFile({ rootReal, relativePath: frame.path, code: 'REDRAW_FULL_FRAME_SOURCE_MISMATCH' });
  if (sha256(read.bytes) !== frame.sha256) fail('REDRAW_FULL_FRAME_SOURCE_MISMATCH');
  const metadata = await withCodeAsync(() => sharp(read.bytes).metadata(), 'REDRAW_FULL_FRAME_SOURCE_MISMATCH');
  if (metadata.format !== 'png' || metadata.width !== source.width || metadata.height !== source.height) fail('REDRAW_FULL_FRAME_SOURCE_MISMATCH');
  return {
    frame_index: frameIndex,
    timestamp_ticks: timestampTicks,
    timestamp_ms: timestampMs,
    shot_id: frame.shot_id,
    path: read.normalized,
    sha256: frame.sha256,
    width: frame.width,
    height: frame.height,
    person_region_ids: personRegionIds,
    text_region_ids: textRegionIds,
    review_point_reasons: [...new Set(frame.review_point_reasons)].sort((a, b) => REVIEW_REASON_ORDER.indexOf(a) - REVIEW_REASON_ORDER.indexOf(b)),
    review_status: frame.review_status,
  };
}

async function validateFrames(frames, source, shots, rootReal) {
  if (!Array.isArray(frames) || frames.length !== source.frame_count) fail('REDRAW_FULL_FRAME_FRAME_GAP');
  const shotById = new Map(shots.map((shot) => [shot.shot_id, shot]));
  const normalized = [];
  const seen = new Set();
  for (const frame of frames) {
    const item = await validateFrame(frame, source, shotById, rootReal);
    if (seen.has(item.frame_index)) fail('REDRAW_FULL_FRAME_FRAME_GAP');
    seen.add(item.frame_index);
    normalized.push(item);
  }
  normalized.sort((left, right) => left.frame_index - right.frame_index);
  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index].frame_index !== index) fail('REDRAW_FULL_FRAME_FRAME_GAP');
    if (index > 0 && normalized[index].timestamp_ms <= normalized[index - 1].timestamp_ms) fail('REDRAW_FULL_FRAME_FRAME_GAP');
  }
  for (const shot of shots) {
    if (!normalized.some((frame) => frame.shot_id === shot.shot_id)) fail('REDRAW_FULL_FRAME_FRAME_GAP');
  }
  return normalized;
}

function validateBBox(bbox, source) {
  assertExactKeys(bbox, ['x', 'y', 'width', 'height'], 'REDRAW_FULL_FRAME_MASK_INVALID');
  const x = requireFiniteNumber(bbox.x);
  const y = requireFiniteNumber(bbox.y);
  const width = requireFiniteNumber(bbox.width);
  const height = requireFiniteNumber(bbox.height);
  if (width <= 0 || height <= 0 || x < 0 || y < 0 || x + width > source.width || y + height > source.height) {
    fail('REDRAW_FULL_FRAME_MASK_INVALID');
  }
  return { x, y, width, height };
}

function polygonArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += (current.x * next.y) - (next.x * current.y);
  }
  return Math.abs(area) / 2;
}

function validatePolygon(polygon, source) {
  if (!Array.isArray(polygon) || polygon.length < 3) fail('REDRAW_FULL_FRAME_MASK_INVALID');
  const points = polygon.map((point) => {
    assertExactKeys(point, ['x', 'y'], 'REDRAW_FULL_FRAME_MASK_INVALID');
    const x = requireFiniteNumber(point.x);
    const y = requireFiniteNumber(point.y);
    if (x < 0 || y < 0 || x > source.width || y > source.height) fail('REDRAW_FULL_FRAME_MASK_INVALID');
    return { x, y };
  });
  if (polygonArea(points) <= 0) fail('REDRAW_FULL_FRAME_MASK_INVALID');
  return points;
}

async function validateMask(mask, source, rootReal) {
  assertExactKeys(mask, ['path', 'sha256', 'width', 'height', 'mime_type'], 'REDRAW_FULL_FRAME_MASK_INVALID');
  if (mask.mime_type !== 'image/png') fail('REDRAW_FULL_FRAME_MASK_INVALID');
  if (mask.width !== source.width || mask.height !== source.height) fail('REDRAW_FULL_FRAME_MASK_INVALID');
  requireHash(mask.sha256, 'REDRAW_FULL_FRAME_MASK_INVALID');
  const read = await secureReadFile({ rootReal, relativePath: mask.path, code: 'REDRAW_FULL_FRAME_MASK_INVALID' });
  if (sha256(read.bytes) !== mask.sha256) fail('REDRAW_FULL_FRAME_MASK_INVALID');
  const image = sharp(read.bytes);
  const metadata = await withCodeAsync(() => image.metadata(), 'REDRAW_FULL_FRAME_MASK_INVALID');
  if (metadata.format !== 'png' || metadata.width !== source.width || metadata.height !== source.height || metadata.channels !== 1) {
    fail('REDRAW_FULL_FRAME_MASK_INVALID');
  }
  const raw = await withCodeAsync(() => image.raw().toBuffer(), 'REDRAW_FULL_FRAME_MASK_INVALID');
  let nonZero = false;
  for (const value of raw) {
    if (value !== 0 && value !== 255) fail('REDRAW_FULL_FRAME_MASK_INVALID');
    if (value === 255) nonZero = true;
  }
  if (!nonZero) fail('REDRAW_FULL_FRAME_MASK_INVALID');
  return {
    path: read.normalized,
    sha256: mask.sha256,
    width: mask.width,
    height: mask.height,
    mime_type: 'image/png',
  };
}

function mergeRanges(ranges, code) {
  if (!Array.isArray(ranges) || ranges.length === 0) fail(code);
  const sorted = ranges.map((range) => {
    assertExactKeys(range, ['start_frame', 'end_frame'], code);
    const start = requireNonNegativeInt(range.start_frame, code);
    const end = requireNonNegativeInt(range.end_frame, code);
    if (end < start) fail(code);
    return { start_frame: start, end_frame: end };
  }).sort((left, right) => left.start_frame - right.start_frame || left.end_frame - right.end_frame);

  const merged = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.start_frame <= previous.end_frame + 1) {
      previous.end_frame = Math.max(previous.end_frame, range.end_frame);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function rangesFromFrames(frameIndexes) {
  const sorted = [...new Set(frameIndexes)].sort((left, right) => left - right);
  const ranges = [];
  for (const frameIndex of sorted) {
    const previous = ranges[ranges.length - 1];
    if (previous && frameIndex === previous.end_frame + 1) {
      previous.end_frame = frameIndex;
    } else {
      ranges.push({ start_frame: frameIndex, end_frame: frameIndex });
    }
  }
  return ranges;
}

function rangesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertRangesInBounds(ranges, source, code) {
  for (const range of ranges) {
    if (range.end_frame >= source.frame_count) fail(code);
  }
}

function validateVisibility(visibility, ranges, source) {
  if (!Array.isArray(visibility) || visibility.length === 0) fail('REDRAW_FULL_FRAME_PERSON_UNRESOLVED');
  const states = new Set(['visible', 'partial', 'back_view', 'occluded']);
  const normalized = visibility.map((item) => {
    assertExactKeys(item, ['start_frame', 'end_frame', 'state'], 'REDRAW_FULL_FRAME_PERSON_UNRESOLVED');
    const start = requireNonNegativeInt(item.start_frame, 'REDRAW_FULL_FRAME_PERSON_UNRESOLVED');
    const end = requireNonNegativeInt(item.end_frame, 'REDRAW_FULL_FRAME_PERSON_UNRESOLVED');
    if (end < start || end >= source.frame_count || !states.has(item.state)) fail('REDRAW_FULL_FRAME_PERSON_UNRESOLVED');
    return { start_frame: start, end_frame: end, state: item.state };
  }).sort((left, right) => left.start_frame - right.start_frame || left.end_frame - right.end_frame);

  const coverage = [];
  for (const item of normalized) {
    const previous = coverage[coverage.length - 1];
    if (previous && item.start_frame <= previous.end_frame) fail('REDRAW_FULL_FRAME_PERSON_UNRESOLVED');
    coverage.push({ start_frame: item.start_frame, end_frame: item.end_frame });
  }
  if (!rangesEqual(mergeRanges(coverage, 'REDRAW_FULL_FRAME_PERSON_UNRESOLVED'), ranges)) fail('REDRAW_FULL_FRAME_PERSON_UNRESOLVED');
  return normalized;
}

async function validatePersonTracks(personTracks, source, rootReal) {
  if (!Array.isArray(personTracks)) fail('REDRAW_FULL_FRAME_PERSON_UNRESOLVED');
  const regionOwners = new Map();
  const normalized = [];
  for (const track of personTracks) {
    assertExactKeys(track, [
      'track_key',
      'kind',
      'source_character_key',
      'target_strategy',
      'frame_ranges',
      'visibility',
      'regions',
      'review_status',
      'reviewer',
    ], 'REDRAW_FULL_FRAME_OUTPUT_INVALID');
    const trackKey = requireString(track.track_key, 'REDRAW_FULL_FRAME_PERSON_UNRESOLVED');
    if (track.kind === 'story_role') {
      requireString(track.source_character_key, 'REDRAW_FULL_FRAME_PERSON_UNRESOLVED');
      if (track.target_strategy !== 'fixed_actor') fail('REDRAW_FULL_FRAME_PERSON_UNRESOLVED');
    } else if (track.kind === 'background_extra') {
      if (track.source_character_key !== null || track.target_strategy !== 'foreign_adult_extra') fail('REDRAW_FULL_FRAME_PERSON_UNRESOLVED');
    } else {
      fail('REDRAW_FULL_FRAME_PERSON_UNRESOLVED');
    }
    if (track.review_status !== 'pending' || track.reviewer !== null) fail('REDRAW_FULL_FRAME_APPROVAL_FORBIDDEN');
    if (!Array.isArray(track.regions) || track.regions.length === 0) fail('REDRAW_FULL_FRAME_PERSON_UNRESOLVED');

    const regions = [];
    for (const region of track.regions) {
      assertExactKeys(region, [
        'region_id',
        'frame_index',
        'bbox',
        'mask',
        'association_confidence',
        'detector_disagreement',
      ], 'REDRAW_FULL_FRAME_OUTPUT_INVALID');
      const regionId = requireString(region.region_id, 'REDRAW_FULL_FRAME_PERSON_UNRESOLVED');
      if (regionOwners.has(regionId)) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
      regionOwners.set(regionId, trackKey);
      const frameIndex = requireNonNegativeInt(region.frame_index, 'REDRAW_FULL_FRAME_PERSON_UNRESOLVED');
      if (frameIndex >= source.frame_count) fail('REDRAW_FULL_FRAME_PERSON_UNRESOLVED');
      const associationConfidence = requireFiniteNumber(region.association_confidence);
      if (associationConfidence < 0 || associationConfidence > 1) fail('REDRAW_FULL_FRAME_PERSON_UNRESOLVED');
      if (typeof region.detector_disagreement !== 'boolean') fail('REDRAW_FULL_FRAME_PERSON_UNRESOLVED');
      regions.push({
        region_id: regionId,
        frame_index: frameIndex,
        bbox: validateBBox(region.bbox, source),
        mask: await validateMask(region.mask, source, rootReal),
        association_confidence: associationConfidence,
        detector_disagreement: region.detector_disagreement,
      });
    }
    regions.sort((left, right) => left.frame_index - right.frame_index || left.region_id.localeCompare(right.region_id));
    const frameRanges = mergeRanges(track.frame_ranges, 'REDRAW_FULL_FRAME_PERSON_UNRESOLVED');
    assertRangesInBounds(frameRanges, source, 'REDRAW_FULL_FRAME_PERSON_UNRESOLVED');
    if (!rangesEqual(frameRanges, rangesFromFrames(regions.map((region) => region.frame_index)))) fail('REDRAW_FULL_FRAME_PERSON_UNRESOLVED');
    normalized.push({
      track_key: trackKey,
      kind: track.kind,
      source_character_key: track.source_character_key,
      target_strategy: track.target_strategy,
      frame_ranges: frameRanges,
      visibility: validateVisibility(track.visibility, frameRanges, source),
      regions,
      review_status: 'pending',
      reviewer: null,
    });
  }
  normalized.sort((left, right) => left.track_key.localeCompare(right.track_key));
  return { tracks: normalized, regionOwners };
}

function validateTargetTextKey(value) {
  requireString(value, 'REDRAW_FULL_FRAME_TEXT_UNRESOLVED');
  if (PLACEHOLDER_VALUES.has(value.toLowerCase())) fail('REDRAW_FULL_FRAME_TEXT_UNRESOLVED');
  return value;
}

async function validateTextTracks(textTracks, source, rootReal, existingRegionOwners) {
  if (!Array.isArray(textTracks)) fail('REDRAW_FULL_FRAME_TEXT_UNRESOLVED');
  const regionOwners = new Map(existingRegionOwners);
  const normalized = [];
  const kinds = new Set(['subtitle', 'screen', 'sign', 'ui', 'logo', 'watermark']);
  const treatments = new Set(['translate_subtitle', 'localize_screen', 'remove', 'generalize']);
  for (const track of textTracks) {
    assertExactKeys(track, [
      'region_key',
      'kind',
      'treatment',
      'target_text_key',
      'frame_ranges',
      'regions',
      'review_status',
      'reviewer',
    ], 'REDRAW_FULL_FRAME_OUTPUT_INVALID');
    const regionKey = requireString(track.region_key, 'REDRAW_FULL_FRAME_TEXT_UNRESOLVED');
    if (!kinds.has(track.kind) || !treatments.has(track.treatment)) fail('REDRAW_FULL_FRAME_TEXT_UNRESOLVED');
    if (track.kind === 'subtitle' && track.treatment !== 'translate_subtitle') fail('REDRAW_FULL_FRAME_TEXT_UNRESOLVED');
    if (['screen', 'sign'].includes(track.kind) && !['localize_screen', 'remove', 'generalize'].includes(track.treatment)) {
      fail('REDRAW_FULL_FRAME_TEXT_UNRESOLVED');
    }
    if (['ui', 'logo', 'watermark'].includes(track.kind) && !['remove', 'generalize'].includes(track.treatment)) {
      fail('REDRAW_FULL_FRAME_TEXT_UNRESOLVED');
    }
    if (['translate_subtitle', 'localize_screen'].includes(track.treatment)) validateTargetTextKey(track.target_text_key);
    if (['remove', 'generalize'].includes(track.treatment) && track.target_text_key !== null) fail('REDRAW_FULL_FRAME_TEXT_UNRESOLVED');
    if (track.review_status !== 'pending' || track.reviewer !== null) fail('REDRAW_FULL_FRAME_APPROVAL_FORBIDDEN');
    if (!Array.isArray(track.regions) || track.regions.length === 0) fail('REDRAW_FULL_FRAME_TEXT_UNRESOLVED');

    const regions = [];
    for (const region of track.regions) {
      assertExactKeys(region, ['region_id', 'frame_index', 'polygon', 'mask'], 'REDRAW_FULL_FRAME_OUTPUT_INVALID');
      const regionId = requireString(region.region_id, 'REDRAW_FULL_FRAME_TEXT_UNRESOLVED');
      if (regionOwners.has(regionId)) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
      regionOwners.set(regionId, regionKey);
      const frameIndex = requireNonNegativeInt(region.frame_index, 'REDRAW_FULL_FRAME_TEXT_UNRESOLVED');
      if (frameIndex >= source.frame_count) fail('REDRAW_FULL_FRAME_TEXT_UNRESOLVED');
      regions.push({
        region_id: regionId,
        frame_index: frameIndex,
        polygon: validatePolygon(region.polygon, source),
        mask: await validateMask(region.mask, source, rootReal),
      });
    }
    regions.sort((left, right) => left.frame_index - right.frame_index || left.region_id.localeCompare(right.region_id));
    const frameRanges = mergeRanges(track.frame_ranges, 'REDRAW_FULL_FRAME_TEXT_UNRESOLVED');
    assertRangesInBounds(frameRanges, source, 'REDRAW_FULL_FRAME_TEXT_UNRESOLVED');
    if (!rangesEqual(frameRanges, rangesFromFrames(regions.map((region) => region.frame_index)))) fail('REDRAW_FULL_FRAME_TEXT_UNRESOLVED');
    normalized.push({
      region_key: regionKey,
      kind: track.kind,
      treatment: track.treatment,
      target_text_key: track.target_text_key,
      frame_ranges: frameRanges,
      regions,
      review_status: 'pending',
      reviewer: null,
    });
  }
  normalized.sort((left, right) => left.region_key.localeCompare(right.region_key));
  return { tracks: normalized, regionOwners };
}

function validateModelLock(modelLock, { requireCanonicalInput = false } = {}) {
  if (requireCanonicalInput) {
    assertExactKeys(modelLock, ['schema_version', 'runtime', 'components', 'canonical_sha256'], 'REDRAW_FULL_FRAME_MODEL_LOCK_INVALID');
    assertPlainObject(modelLock.runtime, 'REDRAW_FULL_FRAME_MODEL_LOCK_INVALID');
  } else {
    assertAllowedKeys(modelLock, ['schema_version', 'runtime', 'components', 'canonical_sha256'], ['schema_version', 'components', 'canonical_sha256'], 'REDRAW_FULL_FRAME_MODEL_LOCK_INVALID');
  }
  if (modelLock.schema_version !== LOCK_SCHEMA_VERSION) fail('REDRAW_FULL_FRAME_MODEL_LOCK_INVALID');
  const modelLockSha256 = requireHash(modelLock.canonical_sha256, 'REDRAW_FULL_FRAME_MODEL_LOCK_INVALID');
  if (!Array.isArray(modelLock.components) || modelLock.components.length !== COMPONENT_ORDER.length) fail('REDRAW_FULL_FRAME_MODEL_LOCK_INVALID');
  const byComponent = new Map();
  for (const component of modelLock.components) {
    const componentKeys = [
      'component',
      'project',
      'repository',
      'revision',
      'artifact_name',
      'artifact_path',
      'artifact_sha256',
      'license_name',
      'license_evidence_path',
      'license_evidence_sha256',
    ];
    if (requireCanonicalInput) {
      assertExactKeys(component, componentKeys, 'REDRAW_FULL_FRAME_MODEL_LOCK_INVALID');
    } else {
      assertAllowedKeys(component, componentKeys, ['component', 'project', 'repository', 'revision', 'artifact_sha256', 'license_evidence_sha256'], 'REDRAW_FULL_FRAME_MODEL_LOCK_INVALID');
    }
    if (!COMPONENT_ORDER.includes(component.component) || byComponent.has(component.component)) fail('REDRAW_FULL_FRAME_MODEL_LOCK_INVALID');
    byComponent.set(component.component, {
      component: component.component,
      project: requireString(component.project, 'REDRAW_FULL_FRAME_MODEL_LOCK_INVALID'),
      repository: requireString(component.repository, 'REDRAW_FULL_FRAME_MODEL_LOCK_INVALID'),
      revision: requireString(component.revision, 'REDRAW_FULL_FRAME_MODEL_LOCK_INVALID'),
      artifact_sha256: requireHash(component.artifact_sha256, 'REDRAW_FULL_FRAME_MODEL_LOCK_INVALID'),
      license_evidence_sha256: requireHash(component.license_evidence_sha256, 'REDRAW_FULL_FRAME_MODEL_LOCK_INVALID'),
    });
  }
  return {
    model_lock_sha256: modelLockSha256,
    components: COMPONENT_ORDER.map((component) => {
      const found = byComponent.get(component);
      if (!found) fail('REDRAW_FULL_FRAME_MODEL_LOCK_INVALID');
      return found;
    }),
  };
}

function collectReviewReasons(frames, shots, personTracks, textTracks) {
  const byFrame = new Map(frames.map((frame) => [frame.frame_index, new Set(frame.review_point_reasons)]));
  const add = (frameIndex, reason) => {
    const set = byFrame.get(frameIndex);
    if (set) set.add(reason);
  };
  const framesByShot = new Map();
  for (const frame of frames) {
    if (!framesByShot.has(frame.shot_id)) framesByShot.set(frame.shot_id, []);
    framesByShot.get(frame.shot_id).push(frame);
  }

  for (const shot of shots) {
    const shotFrames = framesByShot.get(shot.shot_id) || [];
    if (shotFrames.length === 0) continue;
    add(shotFrames[0].frame_index, 'shot_start');
    add(shotFrames[shotFrames.length - 1].frame_index, 'shot_end');
    if (shotFrames[0].timestamp_ms === shot.start_ms && shot.start_ms !== 0) add(shotFrames[0].frame_index, 'shot_boundary');
    let marker = shot.start_ms;
    while (marker < shot.end_ms) {
      const frame = shotFrames.find((item) => item.timestamp_ms >= marker);
      if (frame) add(frame.frame_index, 'one_second');
      marker += 1000;
    }
  }
  for (let index = 1; index < frames.length; index += 1) {
    if (frames[index].shot_id !== frames[index - 1].shot_id) {
      add(frames[index - 1].frame_index, 'shot_boundary');
      add(frames[index].frame_index, 'shot_boundary');
    }
    if (frames[index].text_region_ids.length !== frames[index - 1].text_region_ids.length) {
      add(frames[index].frame_index, 'text_region_count_change');
    }
  }

  for (const track of personTracks) {
    for (const range of track.frame_ranges) {
      add(range.start_frame, 'person_track_start');
      add(range.end_frame, 'person_track_end');
    }
    for (let index = 1; index < track.visibility.length; index += 1) add(track.visibility[index].start_frame, 'visibility_change');
    for (const region of track.regions) {
      if (region.association_confidence < 0.5) add(region.frame_index, 'low_track_confidence');
      if (region.detector_disagreement) add(region.frame_index, 'detector_disagreement');
    }
  }
  for (const track of textTracks) {
    for (const range of track.frame_ranges) {
      add(range.start_frame, 'text_track_start');
      add(range.end_frame, 'text_track_end');
    }
  }
  return byFrame;
}

function assertFrameRegionClosure(frames, personTracks, textTracks) {
  const personByFrame = new Map(frames.map((frame) => [frame.frame_index, []]));
  const textByFrame = new Map(frames.map((frame) => [frame.frame_index, []]));
  for (const track of personTracks) {
    for (const region of track.regions) personByFrame.get(region.frame_index).push(region.region_id);
  }
  for (const track of textTracks) {
    for (const region of track.regions) textByFrame.get(region.frame_index).push(region.region_id);
  }
  for (const frame of frames) {
    const expectedPerson = personByFrame.get(frame.frame_index).sort();
    const expectedText = textByFrame.get(frame.frame_index).sort();
    if (JSON.stringify(frame.person_region_ids) !== JSON.stringify(expectedPerson)) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
    if (JSON.stringify(frame.text_region_ids) !== JSON.stringify(expectedText)) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
  }
}

function finalManifest({ source, models, shots, frames, personTracks, textTracks }) {
  const reviewReasons = collectReviewReasons(frames, shots, personTracks, textTracks);
  const finalFrames = frames.map((frame) => {
    const reasons = [...reviewReasons.get(frame.frame_index)].sort((a, b) => REVIEW_REASON_ORDER.indexOf(a) - REVIEW_REASON_ORDER.indexOf(b));
    return {
      ...frame,
      review_point_reasons: reasons,
      review_status: reasons.length > 0 ? 'pending' : 'not_required',
    };
  });
  const requiredReviewPointCount = finalFrames.filter((frame) => frame.review_point_reasons.length > 0).length;
  const manifest = {
    schema_version: SCHEMA_VERSION,
    status: STATUS,
    source,
    models,
    shots,
    frames: finalFrames,
    person_tracks: personTracks,
    text_tracks: textTracks,
    review: {
      status: 'pending',
      required_review_point_count: requiredReviewPointCount,
      reviewed_point_count: 0,
      reviewer: null,
    },
    unresolved_person_count: 0,
    unresolved_text_region_count: 0,
    approval_status: 'pending',
    ready_for_reference: false,
    analysis_sha256: null,
  };
  manifest.analysis_sha256 = canonicalCoverageSha256(manifest);
  return manifest;
}

async function normalizeBuild(input) {
  scanForbiddenKeys(input);
  assertExactKeys(input, ['evidenceRoot', 'source', 'shots', 'frames', 'personTracks', 'textTracks', 'modelLock']);
  const rootReal = await getRootReal(input.evidenceRoot);
  const source = validateSource(input.source);
  const shots = validateShots(input.shots, source);
  const frames = await validateFrames(input.frames, source, shots, rootReal);
  const person = await validatePersonTracks(input.personTracks, source, rootReal);
  const text = await validateTextTracks(input.textTracks, source, rootReal, person.regionOwners);
  assertFrameRegionClosure(frames, person.tracks, text.tracks);
  return finalManifest({
    source,
    models: validateModelLock(input.modelLock, { requireCanonicalInput: true }),
    shots,
    frames,
    personTracks: person.tracks,
    textTracks: text.tracks,
  });
}

function validateFixedManifestFields(manifest) {
  if (manifest.schema_version !== SCHEMA_VERSION || manifest.status !== STATUS) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
  if (manifest.unresolved_person_count !== 0 || manifest.unresolved_text_region_count !== 0) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
  if (manifest.approval_status !== 'pending') fail('REDRAW_FULL_FRAME_APPROVAL_FORBIDDEN');
  if (manifest.ready_for_reference !== false) fail('REDRAW_FULL_FRAME_APPROVAL_FORBIDDEN');
  requireHash(manifest.analysis_sha256, 'REDRAW_FULL_FRAME_OUTPUT_INVALID');
  assertExactKeys(manifest.review, ['status', 'required_review_point_count', 'reviewed_point_count', 'reviewer']);
  if (manifest.review.status !== 'pending' || manifest.review.reviewed_point_count !== 0 || manifest.review.reviewer !== null) {
    fail('REDRAW_FULL_FRAME_APPROVAL_FORBIDDEN');
  }
}

async function normalizeValidate({ evidenceRoot, manifest }) {
  scanForbiddenKeys(manifest);
  assertExactKeys(manifest, [
    'schema_version',
    'status',
    'source',
    'models',
    'shots',
    'frames',
    'person_tracks',
    'text_tracks',
    'review',
    'unresolved_person_count',
    'unresolved_text_region_count',
    'approval_status',
    'ready_for_reference',
    'analysis_sha256',
  ]);
  validateFixedManifestFields(manifest);
  const rootReal = await getRootReal(evidenceRoot);
  const source = validateSource(manifest.source);
  const shots = validateShots(manifest.shots, source);
  const frames = await validateFrames(manifest.frames, source, shots, rootReal);
  assertExactKeys(manifest.models, ['model_lock_sha256', 'components']);
  const models = validateModelLock({
    schema_version: LOCK_SCHEMA_VERSION,
    components: manifest.models.components,
    canonical_sha256: manifest.models.model_lock_sha256,
  });
  const person = await validatePersonTracks(manifest.person_tracks, source, rootReal);
  const text = await validateTextTracks(manifest.text_tracks, source, rootReal, person.regionOwners);
  assertFrameRegionClosure(frames, person.tracks, text.tracks);
  const normalized = finalManifest({
    source,
    models,
    shots,
    frames,
    personTracks: person.tracks,
    textTracks: text.tracks,
  });
  if (normalized.analysis_sha256 !== manifest.analysis_sha256) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
  if (normalized.review.required_review_point_count !== manifest.review.required_review_point_count) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
  return normalized;
}

function canonicalProjection(manifest) {
  assertPlainObject(manifest);
  const projection = {};
  for (const key of [
    'schema_version',
    'status',
    'source',
    'models',
    'shots',
    'frames',
    'person_tracks',
    'text_tracks',
    'review',
    'unresolved_person_count',
    'unresolved_text_region_count',
    'approval_status',
    'ready_for_reference',
  ]) {
    if (Object.prototype.hasOwnProperty.call(manifest, key)) projection[key] = manifest[key];
  }
  if (Array.isArray(projection.shots)) {
    projection.shots = [...projection.shots].sort((left, right) => parseShotNumber(left.shot_id) - parseShotNumber(right.shot_id));
  }
  if (Array.isArray(projection.frames)) {
    projection.frames = [...projection.frames].sort((left, right) => left.frame_index - right.frame_index).map((frame) => ({
      ...frame,
      person_region_ids: Array.isArray(frame.person_region_ids) ? [...frame.person_region_ids].sort() : frame.person_region_ids,
      text_region_ids: Array.isArray(frame.text_region_ids) ? [...frame.text_region_ids].sort() : frame.text_region_ids,
      review_point_reasons: Array.isArray(frame.review_point_reasons)
        ? [...new Set(frame.review_point_reasons)].sort((a, b) => REVIEW_REASON_ORDER.indexOf(a) - REVIEW_REASON_ORDER.indexOf(b))
        : frame.review_point_reasons,
    }));
  }
  if (projection.models && Array.isArray(projection.models.components)) {
    projection.models = {
      ...projection.models,
      components: [...projection.models.components].sort((left, right) => COMPONENT_ORDER.indexOf(left.component) - COMPONENT_ORDER.indexOf(right.component)),
    };
  }
  if (Array.isArray(projection.person_tracks)) {
    projection.person_tracks = [...projection.person_tracks].sort((left, right) => left.track_key.localeCompare(right.track_key)).map((track) => ({
      ...track,
      frame_ranges: Array.isArray(track.frame_ranges) ? mergeRanges(track.frame_ranges, 'REDRAW_FULL_FRAME_OUTPUT_INVALID') : track.frame_ranges,
      visibility: Array.isArray(track.visibility) ? [...track.visibility].sort((left, right) => left.start_frame - right.start_frame || left.end_frame - right.end_frame) : track.visibility,
      regions: Array.isArray(track.regions) ? [...track.regions].sort((left, right) => left.frame_index - right.frame_index || left.region_id.localeCompare(right.region_id)) : track.regions,
    }));
  }
  if (Array.isArray(projection.text_tracks)) {
    projection.text_tracks = [...projection.text_tracks].sort((left, right) => left.region_key.localeCompare(right.region_key)).map((track) => ({
      ...track,
      frame_ranges: Array.isArray(track.frame_ranges) ? mergeRanges(track.frame_ranges, 'REDRAW_FULL_FRAME_OUTPUT_INVALID') : track.frame_ranges,
      regions: Array.isArray(track.regions) ? [...track.regions].sort((left, right) => left.frame_index - right.frame_index || left.region_id.localeCompare(right.region_id)) : track.regions,
    }));
  }
  return projection;
}

function canonicalCoverageSha256(manifest) {
  return sha256(Buffer.from(stableJson(canonicalProjection(manifest))));
}

async function buildGeneratedCoverageManifest(input) {
  try {
    return await normalizeBuild(input);
  } catch (error) {
    if (error instanceof CoverageError) throw error;
    fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
  }
}

async function validateGeneratedCoverageManifest({ evidenceRoot, manifest }) {
  try {
    return await normalizeValidate({ evidenceRoot, manifest });
  } catch (error) {
    if (error instanceof CoverageError) throw error;
    fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
  }
}

module.exports = {
  buildGeneratedCoverageManifest,
  validateGeneratedCoverageManifest,
  canonicalCoverageSha256,
};
