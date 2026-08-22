const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const sharp = require('sharp');

const {
  validateGeneratedCoverageManifest,
  canonicalCoverageSha256,
} = require('./redrawFullFrameCoverageService');

const REVIEWER = 'codex-local-review';
const DECISIONS_SCHEMA = 'redraw-full-frame-review-decisions-v1';
const SUMMARY_SCHEMA = 'redraw-full-frame-review-summary-v1';
const HASH_RE = /^[a-f0-9]{64}$/;
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
const SAFE_VALUE_RE = /(https?:\/\/|file:\/\/|[A-Za-z]:\\|\/[A-Za-z0-9_.-]+\/|api[_-]?key\s*=|authorization\s*=|bearer\s+|token\s*=|secret\s*=)/i;
const FORBIDDEN_KEYS = new Set([
  'path',
  'local_path',
  'absolute_path',
  'url',
  'ocr_text',
  'text',
  'content',
  'prompt',
  'api_key',
  'authorization',
  'token',
  'secret',
  'approved',
  'ready',
  'ready_for_reference',
]);
const VISIBILITY = new Set(['visible', 'partial', 'occluded', 'back_view']);
const PERSON_KINDS = new Set(['story_role', 'background_extra']);
const PERSON_STRATEGIES = new Set(['fixed_actor', 'foreign_adult_extra']);
const TEXT_KINDS = new Set(['subtitle', 'screen', 'sign', 'ui', 'logo', 'watermark']);
const TEXT_TREATMENTS = new Set(['translate_subtitle', 'localize_screen', 'remove', 'generalize']);
const SHOTS_PER_SHEET = 9;
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

class ReviewError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RedrawFullFrameReviewError';
    this.code = code;
  }
}

function fail(code) {
  throw new ReviewError(code);
}

function sanitize(error, fallback) {
  if (error instanceof ReviewError) throw error;
  if (error && typeof error.code === 'string' && /^REDRAW_FULL_FRAME_/.test(error.code)) throw new ReviewError(error.code);
  throw new ReviewError(fallback);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
  }
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256Json(value) {
  return sha256(Buffer.from(stableJson(value)));
}

function assertObject(value, code = 'REDRAW_FULL_FRAME_REVIEW_INCOMPLETE') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
}

function assertExactKeys(value, keys, code = 'REDRAW_FULL_FRAME_REVIEW_INCOMPLETE') {
  assertObject(value, code);
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(code);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(code);
  }
}

function assertString(value, code = 'REDRAW_FULL_FRAME_REVIEW_INCOMPLETE') {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || SAFE_VALUE_RE.test(value)) fail(code);
  return value;
}

function assertSegment(value, code = 'REDRAW_FULL_FRAME_REVIEW_INCOMPLETE') {
  assertString(value, code);
  if (!SEGMENT_RE.test(value)) fail(code);
  return value;
}

function assertMaybeString(value, code = 'REDRAW_FULL_FRAME_REVIEW_INCOMPLETE') {
  if (value === null) return null;
  return assertString(value, code);
}

function assertHash(value, code = 'REDRAW_FULL_FRAME_REVIEW_INCOMPLETE') {
  assertString(value, code);
  if (!HASH_RE.test(value)) fail(code);
  return value;
}

function scanForbidden(value, code = 'REDRAW_FULL_FRAME_REVIEW_INCOMPLETE') {
  if (typeof value === 'string' && SAFE_VALUE_RE.test(value)) fail(code);
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) scanForbidden(item, code);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) fail(key === 'approved' || key === 'ready' || key === 'ready_for_reference' ? 'REDRAW_FULL_FRAME_APPROVAL_FORBIDDEN' : code);
    scanForbidden(nested, code);
  }
}

function assertFrameIndex(value, max, code = 'REDRAW_FULL_FRAME_REVIEW_INCOMPLETE') {
  if (!Number.isInteger(value) || value < 0 || value >= max) fail(code);
  return value;
}

function assertFinite(value, code = 'REDRAW_FULL_FRAME_MASK_INVALID') {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(code);
  return value;
}

function validateBBox(bbox, source) {
  assertExactKeys(bbox, ['x', 'y', 'width', 'height'], 'REDRAW_FULL_FRAME_MASK_INVALID');
  const x = assertFinite(bbox.x);
  const y = assertFinite(bbox.y);
  const width = assertFinite(bbox.width);
  const height = assertFinite(bbox.height);
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > source.width || y + height > source.height) fail('REDRAW_FULL_FRAME_MASK_INVALID');
  return { x, y, width, height };
}

function polygonArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    area += (points[index].x * next.y) - (next.x * points[index].y);
  }
  return Math.abs(area) / 2;
}

function validatePolygon(polygon, source) {
  if (!Array.isArray(polygon) || polygon.length < 3) fail('REDRAW_FULL_FRAME_MASK_INVALID');
  const points = polygon.map((point) => {
    assertExactKeys(point, ['x', 'y'], 'REDRAW_FULL_FRAME_MASK_INVALID');
    const x = assertFinite(point.x);
    const y = assertFinite(point.y);
    if (x < 0 || y < 0 || x > source.width || y > source.height) fail('REDRAW_FULL_FRAME_MASK_INVALID');
    return { x, y };
  });
  if (polygonArea(points) <= 0) fail('REDRAW_FULL_FRAME_MASK_INVALID');
  return points;
}

function validatePersonContract(kind, sourceCharacterKey, targetStrategy) {
  if (!PERSON_KINDS.has(kind) || !PERSON_STRATEGIES.has(targetStrategy)) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
  if (kind === 'story_role') {
    assertString(sourceCharacterKey);
    if (targetStrategy !== 'fixed_actor') fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
  } else {
    if (sourceCharacterKey !== null || targetStrategy !== 'foreign_adult_extra') fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
  }
}

function validateTextContract(kind, treatment, targetTextKey) {
  if (!TEXT_KINDS.has(kind) || !TEXT_TREATMENTS.has(treatment)) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
  if (kind === 'subtitle' && treatment !== 'translate_subtitle') fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
  if (['screen', 'sign'].includes(kind) && !['localize_screen', 'remove', 'generalize'].includes(treatment)) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
  if (['ui', 'logo', 'watermark'].includes(kind) && !['remove', 'generalize'].includes(treatment)) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
  if (['translate_subtitle', 'localize_screen'].includes(treatment)) assertString(targetTextKey);
  if (['remove', 'generalize'].includes(treatment) && targetTextKey !== null) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
}

function normalizeCorrection(correction, frameIndex, source) {
  scanForbidden(correction);
  assertObject(correction);
  switch (correction.action) {
    case 'add_person_region':
      assertExactKeys(correction, ['action', 'region_id', 'frame_index', 'track_key', 'bbox', 'visibility', 'kind', 'source_character_key', 'target_strategy']);
      if (correction.frame_index !== frameIndex) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
      if (!VISIBILITY.has(correction.visibility)) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
      validatePersonContract(correction.kind, correction.source_character_key, correction.target_strategy);
      return { ...correction, region_id: assertSegment(correction.region_id), track_key: assertString(correction.track_key), bbox: validateBBox(correction.bbox, source) };
    case 'remove_person_candidate':
      assertExactKeys(correction, ['action', 'region_id']);
      return { action: correction.action, region_id: assertString(correction.region_id) };
    case 'merge_person_tracks':
      assertExactKeys(correction, ['action', 'source_track_keys', 'target_track_key', 'kind', 'source_character_key', 'target_strategy']);
      if (!Array.isArray(correction.source_track_keys) || correction.source_track_keys.length < 2) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
      if (new Set(correction.source_track_keys).size !== correction.source_track_keys.length) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
      validatePersonContract(correction.kind, correction.source_character_key, correction.target_strategy);
      return { ...correction, source_track_keys: correction.source_track_keys.map((item) => assertString(item)), target_track_key: assertString(correction.target_track_key) };
    case 'split_person_track':
      assertExactKeys(correction, ['action', 'track_key', 'split_frame_index', 'new_track_key']);
      if (correction.split_frame_index !== frameIndex && correction.split_frame_index !== frameIndex - 1 && correction.split_frame_index !== frameIndex + 1) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
      return { action: correction.action, track_key: assertString(correction.track_key), split_frame_index: correction.split_frame_index, new_track_key: assertString(correction.new_track_key) };
    case 'add_text_region':
      assertExactKeys(correction, ['action', 'region_id', 'frame_index', 'region_key', 'polygon', 'kind', 'treatment', 'target_text_key']);
      if (correction.frame_index !== frameIndex) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
      validateTextContract(correction.kind, correction.treatment, correction.target_text_key);
      return { ...correction, region_id: assertSegment(correction.region_id), region_key: assertString(correction.region_key), polygon: validatePolygon(correction.polygon, source) };
    case 'remove_text_candidate':
      assertExactKeys(correction, ['action', 'region_id']);
      return { action: correction.action, region_id: assertString(correction.region_id) };
    case 'change_text_kind':
      assertExactKeys(correction, ['action', 'region_key', 'kind']);
      if (!TEXT_KINDS.has(correction.kind)) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
      return { action: correction.action, region_key: assertString(correction.region_key), kind: correction.kind };
    case 'change_text_treatment':
      assertExactKeys(correction, ['action', 'region_key', 'treatment', 'target_text_key']);
      if (!TEXT_TREATMENTS.has(correction.treatment)) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
      return { action: correction.action, region_key: assertString(correction.region_key), treatment: correction.treatment, target_text_key: assertMaybeString(correction.target_text_key) };
    default:
      fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
  }
}

function requiredFrames(manifest) {
  return manifest.frames.filter((frame) => Array.isArray(frame.review_point_reasons) && frame.review_point_reasons.length > 0);
}

function normalizeReviewDecisions({ generatedManifest, decisions }) {
  try {
    scanForbidden(decisions);
    assertExactKeys(decisions, ['schema_version', 'analysis_sha256', 'reviewer', 'review_points']);
    if (decisions.schema_version !== DECISIONS_SCHEMA || decisions.reviewer !== REVIEWER) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
    if (assertHash(decisions.analysis_sha256) !== generatedManifest.analysis_sha256) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
    if (!Array.isArray(decisions.review_points)) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
    const required = requiredFrames(generatedManifest);
    if (decisions.review_points.length !== required.length) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
    const requiredByFrame = new Map(required.map((frame) => [frame.frame_index, frame]));
    const seen = new Set();
    const points = [];
    for (const point of decisions.review_points) {
      assertExactKeys(point, ['frame_index', 'reasons', 'decision', 'corrections']);
      const frameIndex = assertFrameIndex(point.frame_index, generatedManifest.source.frame_count);
      const frame = requiredByFrame.get(frameIndex);
      if (!frame || seen.has(frameIndex)) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
      seen.add(frameIndex);
      if (JSON.stringify(point.reasons) !== JSON.stringify(frame.review_point_reasons)) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
      if (!['accepted', 'corrected'].includes(point.decision)) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
      if (!Array.isArray(point.corrections)) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
      if (point.decision === 'accepted' && point.corrections.length !== 0) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
      if (point.decision === 'corrected' && point.corrections.length === 0) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
      points.push({
        frame_index: frameIndex,
        reasons: [...point.reasons],
        decision: point.decision,
        corrections: point.corrections.map((correction) => normalizeCorrection(correction, frameIndex, generatedManifest.source)),
      });
    }
    points.sort((left, right) => left.frame_index - right.frame_index);
    if (JSON.stringify(points.map((point) => point.frame_index)) !== JSON.stringify(required.map((frame) => frame.frame_index))) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
    return { schema_version: DECISIONS_SCHEMA, analysis_sha256: decisions.analysis_sha256, reviewer: REVIEWER, review_points: points };
  } catch (error) {
    sanitize(error, 'REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
  }
}

function rangesFromFrames(indexes) {
  const sorted = [...new Set(indexes)].sort((a, b) => a - b);
  const ranges = [];
  for (const index of sorted) {
    const last = ranges.at(-1);
    if (last && index === last.end_frame + 1) last.end_frame = index;
    else ranges.push({ start_frame: index, end_frame: index });
  }
  return ranges;
}

function rebuild(manifest) {
  const framePerson = new Map(manifest.frames.map((frame) => [frame.frame_index, []]));
  const frameText = new Map(manifest.frames.map((frame) => [frame.frame_index, []]));
  manifest.person_tracks = manifest.person_tracks
    .map((track) => {
      track.regions.sort((a, b) => a.frame_index - b.frame_index || a.region_id.localeCompare(b.region_id));
      track.frame_ranges = rangesFromFrames(track.regions.map((region) => region.frame_index));
      track.visibility = rangesFromFrames(track.regions.map((region) => region.frame_index)).map((range) => ({ ...range, state: track.regions.find((region) => region.frame_index >= range.start_frame && region.frame_index <= range.end_frame)._visibility || 'visible' }));
      for (const region of track.regions) {
        delete region._visibility;
        framePerson.get(region.frame_index).push(region.region_id);
      }
      return track;
    })
    .filter((track) => track.regions.length > 0)
    .sort((a, b) => a.track_key.localeCompare(b.track_key));
  manifest.text_tracks = manifest.text_tracks
    .map((track) => {
      track.regions.sort((a, b) => a.frame_index - b.frame_index || a.region_id.localeCompare(b.region_id));
      track.frame_ranges = rangesFromFrames(track.regions.map((region) => region.frame_index));
      for (const region of track.regions) frameText.get(region.frame_index).push(region.region_id);
      return track;
    })
    .filter((track) => track.regions.length > 0)
    .sort((a, b) => a.region_key.localeCompare(b.region_key));
  for (const frame of manifest.frames) {
    frame.person_region_ids = framePerson.get(frame.frame_index).sort();
    frame.text_region_ids = frameText.get(frame.frame_index).sort();
  }
}

function indexes(manifest) {
  const personTracks = new Map(manifest.person_tracks.map((track) => [track.track_key, track]));
  const textTracks = new Map(manifest.text_tracks.map((track) => [track.region_key, track]));
  const personRegions = new Map();
  const textRegions = new Map();
  for (const track of manifest.person_tracks) for (const region of track.regions) personRegions.set(region.region_id, { track, region });
  for (const track of manifest.text_tracks) for (const region of track.regions) textRegions.set(region.region_id, { track, region });
  return { personTracks, textTracks, personRegions, textRegions };
}

function applyCorrections({ generatedManifest, normalizedDecisions }) {
  try {
    const manifest = clone(generatedManifest);
    let pendingMasks = [];
    const actionCounts = {};
    const affected = new Set();
    const affectedIds = new Set();
    for (const point of normalizedDecisions.review_points) {
      for (const correction of point.corrections) {
        actionCounts[correction.action] = (actionCounts[correction.action] || 0) + 1;
        affected.add(point.frame_index);
        const idx = indexes(manifest);
        if (correction.action === 'add_person_region') {
          if (idx.personRegions.has(correction.region_id)) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
          let track = idx.personTracks.get(correction.track_key);
          if (!track) {
            track = { track_key: correction.track_key, kind: correction.kind, source_character_key: correction.source_character_key, target_strategy: correction.target_strategy, frame_ranges: [], visibility: [], regions: [], review_status: 'pending', reviewer: null };
            manifest.person_tracks.push(track);
          }
          if (track.kind !== correction.kind || track.source_character_key !== correction.source_character_key || track.target_strategy !== correction.target_strategy) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
          track.regions.push({ region_id: correction.region_id, frame_index: correction.frame_index, bbox: correction.bbox, mask: { path: `masks/review/person/${correction.region_id}.png`, sha256: '0'.repeat(64), width: manifest.source.width, height: manifest.source.height, mime_type: 'image/png' }, association_confidence: 1, detector_disagreement: false, _visibility: correction.visibility });
          pendingMasks.push({ type: 'person', region_id: correction.region_id, relative_path: `masks/review/person/${correction.region_id}.png`, bbox: correction.bbox });
          affectedIds.add(correction.region_id);
        } else if (correction.action === 'remove_person_candidate') {
          const found = idx.personRegions.get(correction.region_id);
          if (!found || found.region.frame_index !== point.frame_index) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
          found.track.regions = found.track.regions.filter((region) => region.region_id !== correction.region_id);
          pendingMasks = pendingMasks.filter((mask) => mask.region_id !== correction.region_id);
          affectedIds.add(correction.region_id);
        } else if (correction.action === 'merge_person_tracks') {
          const sources = correction.source_track_keys.map((key) => idx.personTracks.get(key));
          if (sources.some((track) => !track)) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
          let target = idx.personTracks.get(correction.target_track_key);
          if (target && !correction.source_track_keys.includes(correction.target_track_key)) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
          if (!target) {
            target = { track_key: correction.target_track_key, kind: correction.kind, source_character_key: correction.source_character_key, target_strategy: correction.target_strategy, frame_ranges: [], visibility: [], regions: [], review_status: 'pending', reviewer: null };
            manifest.person_tracks.push(target);
          }
          target.kind = correction.kind;
          target.source_character_key = correction.source_character_key;
          target.target_strategy = correction.target_strategy;
          for (const source of sources) {
            if (source === target) continue;
            target.regions.push(...source.regions);
            source.regions = [];
          }
          affectedIds.add(correction.target_track_key);
        } else if (correction.action === 'split_person_track') {
          const track = idx.personTracks.get(correction.track_key);
          if (!track || idx.personTracks.has(correction.new_track_key)) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
          const late = track.regions.filter((region) => region.frame_index >= correction.split_frame_index);
          const early = track.regions.filter((region) => region.frame_index < correction.split_frame_index);
          if (early.length === 0 || late.length === 0) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
          track.regions = early;
          manifest.person_tracks.push({ ...clone(track), track_key: correction.new_track_key, regions: late });
          affectedIds.add(correction.new_track_key);
        } else if (correction.action === 'add_text_region') {
          if (idx.textRegions.has(correction.region_id)) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
          let track = idx.textTracks.get(correction.region_key);
          if (!track) {
            track = { region_key: correction.region_key, kind: correction.kind, treatment: correction.treatment, target_text_key: correction.target_text_key, frame_ranges: [], regions: [], review_status: 'pending', reviewer: null };
            manifest.text_tracks.push(track);
          }
          track.kind = correction.kind;
          track.treatment = correction.treatment;
          track.target_text_key = correction.target_text_key;
          track.regions.push({ region_id: correction.region_id, frame_index: correction.frame_index, polygon: correction.polygon, mask: { path: `masks/review/text/${correction.region_id}.png`, sha256: '0'.repeat(64), width: manifest.source.width, height: manifest.source.height, mime_type: 'image/png' } });
          pendingMasks.push({ type: 'text', region_id: correction.region_id, relative_path: `masks/review/text/${correction.region_id}.png`, polygon: correction.polygon });
          affectedIds.add(correction.region_id);
        } else if (correction.action === 'remove_text_candidate') {
          const found = idx.textRegions.get(correction.region_id);
          if (!found || found.region.frame_index !== point.frame_index) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
          found.track.regions = found.track.regions.filter((region) => region.region_id !== correction.region_id);
          pendingMasks = pendingMasks.filter((mask) => mask.region_id !== correction.region_id);
          affectedIds.add(correction.region_id);
        } else if (correction.action === 'change_text_kind') {
          const track = idx.textTracks.get(correction.region_key);
          if (!track) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
          validateTextContract(correction.kind, track.treatment, track.target_text_key);
          track.kind = correction.kind;
          affectedIds.add(correction.region_key);
        } else if (correction.action === 'change_text_treatment') {
          const track = idx.textTracks.get(correction.region_key);
          if (!track) fail('REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
          validateTextContract(track.kind, correction.treatment, correction.target_text_key);
          track.treatment = correction.treatment;
          track.target_text_key = correction.target_text_key;
          affectedIds.add(correction.region_key);
        }
        rebuild(manifest);
      }
    }
    rebuild(manifest);
    return { manifest, pending_masks: pendingMasks, summary: { action_counts: actionCounts, affected_frame_indices: [...affected].sort((a, b) => a - b), affected_ids: [...affectedIds].sort() } };
  } catch (error) {
    sanitize(error, 'REDRAW_FULL_FRAME_REVIEW_INCOMPLETE');
  }
}

function safePathArg(value, code = 'REDRAW_FULL_FRAME_OUTPUT_INVALID') {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || /^(https?|file):\/\//i.test(value) || /(api[_-]?key|authorization|bearer|client[_-]?secret|secret|token)\s*=/i.test(value)) fail(code);
  return path.resolve(value);
}

function insideOrSame(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

async function assertLocalDir(root) {
  const stat = await fsp.lstat(root).catch(() => fail('REDRAW_FULL_FRAME_OUTPUT_INVALID'));
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
  return fsp.realpath(root);
}

function safeJoin(root, relativePath, code = 'REDRAW_FULL_FRAME_OUTPUT_INVALID') {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.includes('\0') || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) || path.posix.isAbsolute(relativePath)) fail(code);
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) fail(code);
  const target = path.resolve(root, normalized);
  if (!insideOrSame(root, target)) fail(code);
  return target;
}

async function assertNoLinkAncestors(root, target) {
  const relative = path.relative(root, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
  let current = root;
  const parts = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = path.join(current, parts[index]);
    const stat = await fsp.lstat(current).catch(() => null);
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
  }
}

async function snapshotTree(root) {
  const rootReal = await assertLocalDir(root);
  const entries = [{ path: '', type: 'dir' }];
  async function walk(dir) {
    for (const name of (await fsp.readdir(dir)).sort()) {
      const abs = path.join(dir, name);
      const stat = await fsp.lstat(abs);
      if (stat.isSymbolicLink()) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
      const rel = path.relative(rootReal, abs).replace(/\\/g, '/');
      if (stat.isDirectory()) {
        entries.push({ path: rel, type: 'dir' });
        await walk(abs);
      } else if (stat.isFile()) entries.push({ path: rel, type: 'file', size: Number(stat.size), sha256: sha256(await fsp.readFile(abs)) });
      else fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
    }
  }
  await walk(rootReal);
  return { rootReal, entries };
}

async function copyTree(src, dst) {
  const snap = await snapshotTree(src);
  for (const entry of snap.entries.filter((item) => item.type === 'dir' && item.path)) {
    await fsp.mkdir(safeJoin(dst, entry.path), { recursive: true });
  }
  for (const entry of snap.entries) {
    if (entry.type !== 'file') continue;
    const from = path.join(snap.rootReal, entry.path);
    const to = safeJoin(dst, entry.path);
    const bytes = await fsp.readFile(from);
    if (sha256(bytes) !== entry.sha256) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.writeFile(to, bytes, { flag: 'wx' });
  }
  return snap;
}

async function writeAtomic(filePath, bytesOrText) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.tmp-${path.basename(filePath)}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  await fsp.writeFile(temp, bytesOrText, { flag: 'wx' });
  await fsp.rename(temp, filePath);
}

async function writeAtomicInside(root, baseRelative, fileRelative, bytesOrText) {
  const rootReal = await fsp.realpath(root);
  const base = safeJoin(rootReal, baseRelative);
  await fsp.mkdir(base, { recursive: true });
  const target = safeJoin(base, fileRelative);
  await assertNoLinkAncestors(rootReal, target);
  await writeAtomic(target, bytesOrText);
  const stat = await fsp.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
  const real = await fsp.realpath(target);
  if (!insideOrSame(base, real)) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
}

async function writeJson(filePath, value) {
  await writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function fillBox(pixels, width, box) {
  const x0 = Math.round(box.x);
  const y0 = Math.round(box.y);
  const x1 = Math.round(box.x + box.width);
  const y1 = Math.round(box.y + box.height);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) pixels[(y * width) + x] = 255;
  }
}

function fillPolygon(pixels, width, polygon) {
  const xs = polygon.map((point) => point.x);
  const ys = polygon.map((point) => point.y);
  fillBox(pixels, width, { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
}

async function writePendingMasks(staging, manifest, pendingMasks) {
  const byPath = new Map(pendingMasks.map((mask) => [mask.relative_path, mask]));
  for (const track of manifest.person_tracks) {
    for (const region of track.regions) {
      const pending = byPath.get(region.mask.path);
      if (!pending) continue;
      const pixels = Buffer.alloc(manifest.source.width * manifest.source.height, 0);
      fillBox(pixels, manifest.source.width, pending.bbox);
      const bytes = await sharp(pixels, { raw: { width: manifest.source.width, height: manifest.source.height, channels: 1 } }).toColourspace('b-w').png().toBuffer();
      await writeAtomicInside(staging, 'masks/review/person', `${pending.region_id}.png`, bytes);
      region.mask.sha256 = sha256(bytes);
    }
  }
  for (const track of manifest.text_tracks) {
    for (const region of track.regions) {
      const pending = byPath.get(region.mask.path);
      if (!pending) continue;
      const pixels = Buffer.alloc(manifest.source.width * manifest.source.height, 0);
      fillPolygon(pixels, manifest.source.width, pending.polygon);
      const bytes = await sharp(pixels, { raw: { width: manifest.source.width, height: manifest.source.height, channels: 1 } }).toColourspace('b-w').png().toBuffer();
      await writeAtomicInside(staging, 'masks/review/text', `${pending.region_id}.png`, bytes);
      region.mask.sha256 = sha256(bytes);
    }
  }
}

async function maskArea(staging, relativePath) {
  const raw = await sharp(path.join(staging, relativePath)).raw().toBuffer();
  let area = 0;
  for (const value of raw) if (value === 255) area += 1;
  return area;
}

async function recomputeGeneratedReviewFields(staging, manifest) {
  for (const track of manifest.person_tracks) {
    for (const region of track.regions) region._mask_area = await maskArea(staging, region.mask.path);
  }
  for (const track of manifest.text_tracks) {
    for (const region of track.regions) region._mask_area = await maskArea(staging, region.mask.path);
  }
  const byFrame = new Map(manifest.frames.map((frame) => [frame.frame_index, new Set()]));
  const add = (frameIndex, reason) => {
    const reasons = byFrame.get(frameIndex);
    if (reasons) reasons.add(reason);
  };
  const framesByShot = new Map();
  for (const frame of manifest.frames) {
    if (!framesByShot.has(frame.shot_id)) framesByShot.set(frame.shot_id, []);
    framesByShot.get(frame.shot_id).push(frame);
  }
  for (const shot of manifest.shots) {
    const shotFrames = (framesByShot.get(shot.shot_id) || []).sort((a, b) => a.frame_index - b.frame_index);
    if (shotFrames.length === 0) continue;
    add(shotFrames[0].frame_index, 'shot_start');
    add(shotFrames.at(-1).frame_index, 'shot_end');
    if (shotFrames[0].timestamp_ms === shot.start_ms && shot.start_ms !== 0) add(shotFrames[0].frame_index, 'shot_boundary');
    for (let marker = shot.start_ms; marker < shot.end_ms; marker += 1000) {
      const frame = shotFrames.find((item) => item.timestamp_ms >= marker);
      if (frame) add(frame.frame_index, 'one_second');
    }
  }
  for (let index = 1; index < manifest.frames.length; index += 1) {
    if (manifest.frames[index].shot_id !== manifest.frames[index - 1].shot_id) {
      add(manifest.frames[index - 1].frame_index, 'shot_boundary');
      add(manifest.frames[index].frame_index, 'shot_boundary');
    }
    if (manifest.frames[index].text_region_ids.length !== manifest.frames[index - 1].text_region_ids.length) {
      add(manifest.frames[index].frame_index, 'text_region_count_change');
    }
  }
  for (const track of manifest.person_tracks) {
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
  for (const track of manifest.text_tracks) {
    for (const range of track.frame_ranges) {
      add(range.start_frame, 'text_track_start');
      add(range.end_frame, 'text_track_end');
    }
  }
  for (const track of [...manifest.person_tracks, ...manifest.text_tracks]) {
    const regions = [...track.regions].sort((a, b) => a.frame_index - b.frame_index || a.region_id.localeCompare(b.region_id));
    for (let index = 1; index < regions.length; index += 1) {
      const previous = regions[index - 1];
      const current = regions[index];
      if (current.frame_index !== previous.frame_index + 1) continue;
      const denominator = Math.max(previous._mask_area, current._mask_area);
      if (denominator > 0 && Math.abs(current._mask_area - previous._mask_area) / denominator >= 0.25) add(current.frame_index, 'mask_area_change');
    }
  }
  for (const frame of manifest.frames) {
    frame.review_point_reasons = [...byFrame.get(frame.frame_index)].sort((a, b) => REVIEW_REASON_ORDER.indexOf(a) - REVIEW_REASON_ORDER.indexOf(b));
    frame.review_status = frame.review_point_reasons.length > 0 ? 'pending' : 'not_required';
  }
  manifest.review = {
    status: 'pending',
    required_review_point_count: manifest.frames.filter((frame) => frame.review_point_reasons.length > 0).length,
    reviewed_point_count: 0,
    reviewer: null,
  };
  for (const track of manifest.person_tracks) for (const region of track.regions) delete region._mask_area;
  for (const track of manifest.text_tracks) for (const region of track.regions) delete region._mask_area;
  manifest.analysis_sha256 = canonicalCoverageSha256(manifest);
}

async function makeOverlay({ framePath, outputPath, boxes = [], polygons = [], color }) {
  const input = sharp(framePath);
  const metadata = await input.metadata();
  const svg = `<svg width="${metadata.width}" height="${metadata.height}" xmlns="http://www.w3.org/2000/svg">${boxes.map((box) => `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="none" stroke="${color}" stroke-width="2"/>`).join('')}${polygons.map((polygon) => `<polygon points="${polygon.map((point) => `${point.x},${point.y}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2"/>`).join('')}</svg>`;
  await writeAtomic(outputPath, await input.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 86 }).toBuffer());
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function expectedSheetCountForShots(shots) {
  if (!Array.isArray(shots) || shots.length === 0) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
  return Math.ceil(shots.length / SHOTS_PER_SHEET);
}

function contactSheetPath(sheetIndex) {
  return `reviewed-contact-sheets/sheet-${String(sheetIndex + 1).padStart(3, '0')}.jpg`;
}

async function writeReviewedArtifacts(staging, manifest) {
  const expectedSheetCount = expectedSheetCountForShots(manifest.shots);
  const personByFrame = new Map(manifest.frames.map((frame) => [frame.frame_index, []]));
  const textByFrame = new Map(manifest.frames.map((frame) => [frame.frame_index, []]));
  for (const track of manifest.person_tracks) for (const region of track.regions) personByFrame.get(region.frame_index).push(region);
  for (const track of manifest.text_tracks) for (const region of track.regions) textByFrame.get(region.frame_index).push(region);
  for (const frame of manifest.frames) {
    const suffix = `frame-${String(frame.frame_index).padStart(6, '0')}.jpg`;
    await makeOverlay({ framePath: path.join(staging, frame.path), outputPath: path.join(staging, 'reviewed-overlays', 'person', suffix), boxes: personByFrame.get(frame.frame_index).map((item) => item.bbox), color: '#00ff66' });
    await makeOverlay({ framePath: path.join(staging, frame.path), outputPath: path.join(staging, 'reviewed-overlays', 'text', suffix), polygons: textByFrame.get(frame.frame_index).map((item) => item.polygon), color: '#ffcc00' });
  }
  const sheets = [];
  for (let sheetIndex = 0; sheetIndex < expectedSheetCount; sheetIndex += 1) {
    const rows = [];
    for (const shot of manifest.shots.slice(sheetIndex * SHOTS_PER_SHEET, (sheetIndex + 1) * SHOTS_PER_SHEET)) {
      const shotFrames = manifest.frames.filter((frame) => frame.shot_id === shot.shot_id);
      if (shotFrames.length === 0) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
      const selected = shotFrames.filter((frame) => frame.review_point_reasons.length > 0);
      for (const frame of (selected.length ? selected : [shotFrames[0]])) {
        const resize = { fit: 'contain', background: '#111111' };
        const suffix = `frame-${String(frame.frame_index).padStart(6, '0')}.jpg`;
        rows.push({
          source: await sharp(path.join(staging, frame.path)).resize(320, 180, resize).jpeg().toBuffer(),
          person: await sharp(path.join(staging, 'reviewed-overlays', 'person', suffix)).resize(320, 180, resize).jpeg().toBuffer(),
          text: await sharp(path.join(staging, 'reviewed-overlays', 'text', suffix)).resize(320, 180, resize).jpeg().toBuffer(),
        });
      }
    }
    const composite = [];
    rows.forEach((row, index) => {
      composite.push({ input: row.source, left: 0, top: index * 180 });
      composite.push({ input: row.person, left: 320, top: index * 180 });
      composite.push({ input: row.text, left: 640, top: index * 180 });
    });
    const relative = contactSheetPath(sheetIndex);
    const bytes = await sharp({ create: { width: 960, height: rows.length * 180, channels: 3, background: '#111111' } }).composite(composite).jpeg({ quality: 88 }).toBuffer();
    await writeAtomic(path.join(staging, relative), bytes);
    sheets.push(relative);
  }
  if (sheets.length !== expectedSheetCount) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
  const html = [
    '<!doctype html><html><head><meta charset="utf-8"><title>Redraw Full Frame Reviewed</title></head><body>',
    '<h1>Redraw Full Frame Reviewed</h1>',
    ...manifest.shots.map((shot, index) => `<section><h2>${htmlEscape(shot.shot_id)}</h2><a href="../${htmlEscape(contactSheetPath(Math.floor(index / SHOTS_PER_SHEET)))}">contact sheet</a><ul>${manifest.frames.filter((frame) => frame.shot_id === shot.shot_id && frame.review_point_reasons.length > 0).map((frame) => `<li>frame_index ${frame.frame_index}; reasons ${frame.review_point_reasons.map(htmlEscape).join(', ')}</li>`).join('')}</ul></section>`),
    '</body></html>',
  ].join('');
  await writeAtomic(path.join(staging, 'reviewed-review', 'index.html'), html);
  return sheets;
}

function toReviewedManifest(generated) {
  const reviewed = clone(generated);
  reviewed.status = 'reviewed';
  for (const frame of reviewed.frames) frame.review_status = frame.review_point_reasons.length > 0 ? 'reviewed' : 'not_required';
  for (const track of reviewed.person_tracks) {
    track.review_status = 'reviewed';
    track.reviewer = REVIEWER;
  }
  for (const track of reviewed.text_tracks) {
    track.review_status = 'reviewed';
    track.reviewer = REVIEWER;
  }
  reviewed.review = {
    status: 'reviewed',
    reviewed: true,
    required_review_point_count: reviewed.frames.filter((frame) => frame.review_point_reasons.length > 0).length,
    reviewed_point_count: reviewed.frames.filter((frame) => frame.review_point_reasons.length > 0).length,
    reviewer: REVIEWER,
  };
  reviewed.approval_status = 'pending';
  reviewed.ready_for_reference = false;
  reviewed.analysis_sha256 = canonicalCoverageSha256(reviewed);
  return reviewed;
}

async function validateReviewedCoverageManifest({ evidenceRoot, manifest }) {
  try {
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
    ], 'REDRAW_FULL_FRAME_OUTPUT_INVALID');
    if (manifest.schema_version !== 'redraw-full-frame-coverage-v1' || manifest.status !== 'reviewed') fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
    expectedSheetCountForShots(manifest.shots);
    assertExactKeys(manifest.review, ['status', 'reviewed', 'required_review_point_count', 'reviewed_point_count', 'reviewer'], 'REDRAW_FULL_FRAME_OUTPUT_INVALID');
    if (manifest.review.status !== 'reviewed' || manifest.review.reviewed !== true || manifest.review.reviewer !== REVIEWER) fail('REDRAW_FULL_FRAME_APPROVAL_FORBIDDEN');
    if (manifest.review.required_review_point_count !== manifest.review.reviewed_point_count) fail('REDRAW_FULL_FRAME_APPROVAL_FORBIDDEN');
    if (manifest.approval_status !== 'pending' || manifest.ready_for_reference !== false) fail('REDRAW_FULL_FRAME_APPROVAL_FORBIDDEN');
    for (const frame of manifest.frames) {
      if (frame.review_status !== (frame.review_point_reasons.length > 0 ? 'reviewed' : 'not_required')) fail('REDRAW_FULL_FRAME_APPROVAL_FORBIDDEN');
    }
    for (const track of [...manifest.person_tracks, ...manifest.text_tracks]) {
      if (track.review_status !== 'reviewed' || track.reviewer !== REVIEWER) fail('REDRAW_FULL_FRAME_APPROVAL_FORBIDDEN');
    }
    if (canonicalCoverageSha256(manifest) !== manifest.analysis_sha256) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
    const generatedLike = clone(manifest);
    generatedLike.status = 'generated';
    for (const frame of generatedLike.frames) frame.review_status = frame.review_point_reasons.length > 0 ? 'pending' : 'not_required';
    for (const track of generatedLike.person_tracks) {
      track.review_status = 'pending';
      track.reviewer = null;
    }
    for (const track of generatedLike.text_tracks) {
      track.review_status = 'pending';
      track.reviewer = null;
    }
    generatedLike.review = {
      status: 'pending',
      required_review_point_count: manifest.review.required_review_point_count,
      reviewed_point_count: 0,
      reviewer: null,
    };
    generatedLike.analysis_sha256 = canonicalCoverageSha256(generatedLike);
    await validateGeneratedCoverageManifest({ evidenceRoot, manifest: generatedLike });
    return clone(manifest);
  } catch (error) {
    sanitize(error, 'REDRAW_FULL_FRAME_OUTPUT_INVALID');
  }
}

async function verifyOutput(staging, sheets) {
  const reviewed = JSON.parse(await fsp.readFile(path.join(staging, 'redraw-full-frame-reviewed-manifest.json'), 'utf8'));
  await validateReviewedCoverageManifest({ evidenceRoot: staging, manifest: reviewed });
  if (!Array.isArray(sheets) || sheets.length !== expectedSheetCountForShots(reviewed.shots)) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
  const sheetDir = path.join(staging, 'reviewed-contact-sheets');
  const actualSheets = (await fsp.readdir(sheetDir)).map((name) => `reviewed-contact-sheets/${name}`).sort();
  if (stableJson(actualSheets) !== stableJson([...sheets].sort())) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
  const required = [
    'redraw-full-frame-reviewed-manifest.json',
    'review-correction-summary.json',
    'review-decisions.json',
    'reviewed-review/index.html',
    ...sheets,
  ];
  for (const rel of required) {
    const bytes = await fsp.readFile(path.join(staging, rel));
    if (rel.endsWith('.jpg')) {
      const meta = await sharp(bytes).metadata();
      if (meta.format !== 'jpeg') fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
    }
  }
  const serialized = JSON.stringify(required.filter((rel) => !rel.endsWith('.jpg')).map((rel) => fs.readFileSync(path.join(staging, rel), 'utf8')));
  if (/https?:\/\/|file:\/\/|[A-Za-z]:\\|api[_-]?key\s*[:=]|authorization\s*[:=]|client_secret\s*[:=]|bearer\s+|token\s*[:=]|secret\s*[:=]|ocr_text|approved":true/i.test(serialized)) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
}

async function publish(staging, outputRoot) {
  if (fs.existsSync(outputRoot)) {
    const stat = await fsp.lstat(outputRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
    const entries = await fsp.readdir(outputRoot);
    if (entries.length !== 0) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
    await fsp.rmdir(outputRoot);
  }
  await fsp.rename(staging, outputRoot);
}

async function finalizeReviewedCoverage({ analysisRoot, decisions, outputRoot }) {
  const outputAbs = safePathArg(outputRoot);
  let staging;
  let published = false;
  try {
    const analysisAbs = safePathArg(analysisRoot);
    const analysisReal = await assertLocalDir(analysisAbs);
    const outputParent = path.dirname(outputAbs);
    const outputParentReal = await assertLocalDir(outputParent);
    const outputResolved = path.join(outputParentReal, path.basename(outputAbs));
    if (insideOrSame(analysisReal, outputResolved) || insideOrSame(outputResolved, analysisReal)) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
    if (fs.existsSync(outputResolved)) {
      const stat = await fsp.lstat(outputResolved);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await fsp.readdir(outputResolved)).length !== 0) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
    }
    const before = await snapshotTree(analysisReal);
    const rawManifest = JSON.parse(await fsp.readFile(path.join(analysisReal, 'redraw-full-frame-coverage-manifest.json'), 'utf8'));
    const generated = await validateGeneratedCoverageManifest({ evidenceRoot: analysisReal, manifest: rawManifest });
    const normalizedDecisions = normalizeReviewDecisions({ generatedManifest: generated, decisions });
    const corrected = applyCorrections({ generatedManifest: generated, normalizedDecisions });
    staging = path.join(outputParentReal, `.redraw-full-frame-reviewed-staging-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
    await fsp.mkdir(staging, { recursive: false });
    await copyTree(analysisReal, staging);
    await writePendingMasks(staging, corrected.manifest, corrected.pending_masks);
    const correctedGenerated = corrected.manifest;
    await recomputeGeneratedReviewFields(staging, correctedGenerated);
    await validateGeneratedCoverageManifest({ evidenceRoot: staging, manifest: correctedGenerated });
    const reviewed = toReviewedManifest(correctedGenerated);
    await writeJson(path.join(staging, 'redraw-full-frame-reviewed-manifest.json'), reviewed);
    const summary = {
      schema_version: SUMMARY_SCHEMA,
      source_analysis_sha256: generated.analysis_sha256,
      corrected_generated_sha256: correctedGenerated.analysis_sha256,
      reviewed_analysis_sha256: reviewed.analysis_sha256,
      decisions_sha256: sha256Json(normalizedDecisions),
      reviewer: REVIEWER,
      action_counts: corrected.summary.action_counts,
      affected_frame_indices: corrected.summary.affected_frame_indices,
    };
    await writeJson(path.join(staging, 'review-correction-summary.json'), summary);
    await writeJson(path.join(staging, 'review-decisions.json'), normalizedDecisions);
    const sheets = await writeReviewedArtifacts(staging, reviewed);
    await verifyOutput(staging, sheets);
    const after = await snapshotTree(analysisReal);
    if (stableJson(before.entries) !== stableJson(after.entries)) fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
    await publish(staging, outputResolved);
    published = true;
    const afterPublish = await snapshotTree(analysisReal);
    if (stableJson(before.entries) !== stableJson(afterPublish.entries)) {
      await fsp.rm(outputResolved, { recursive: true, force: true }).catch(() => {});
      published = false;
      fail('REDRAW_FULL_FRAME_OUTPUT_INVALID');
    }
    return {
      reviewed_manifest: reviewed,
      summary,
      contact_sheets: sheets,
      files: {
        manifest: 'redraw-full-frame-reviewed-manifest.json',
        summary: 'review-correction-summary.json',
        decisions: 'review-decisions.json',
        review: 'reviewed-review/index.html',
      },
    };
  } catch (error) {
    sanitize(error, 'REDRAW_FULL_FRAME_OUTPUT_INVALID');
  } finally {
    if (!published && staging) await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  finalizeReviewedCoverage,
  normalizeReviewDecisions,
  applyCorrections,
  validateReviewedCoverageManifest,
  REVIEWER,
  DECISIONS_SCHEMA,
};
