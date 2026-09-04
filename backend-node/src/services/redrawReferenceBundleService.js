const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { canonicalCoverageSha256 } = require('./redrawFullFrameCoverageService');
const { validateReviewedCoverageManifest } = require('./redrawFullFrameReviewService');
const { verifyMotionReference } = require('./redrawMotionReferenceService');

const REFERENCE_BUNDLE_SCHEMA_VERSION = 'redraw-reference-bundle-v2';
const LOCALIZATION_BINDING_CONTRACT = 'redraw-localization-binding-v1';
const INPUT_CODE = 'REDRAW_REFERENCE_BUNDLE_INPUT_INVALID';
const NOT_FOUND_CODE = 'REDRAW_REFERENCE_BUNDLE_NOT_FOUND';
const CONFLICT_CODE = 'REDRAW_REFERENCE_BUNDLE_CONFLICT';
const FACE_CODE = 'REDRAW_REFERENCE_BUNDLE_FACE_COVERAGE_REQUIRED';
const IDENTITY_CODE = 'REDRAW_REFERENCE_BUNDLE_IDENTITY_PACK_REQUIRED';
const TEXT_CODE = 'REDRAW_REFERENCE_BUNDLE_TEXT_COVERAGE_REQUIRED';
const DIALOGUE_CODE = 'REDRAW_REFERENCE_BUNDLE_DIALOGUE_REQUIRED';
const MOTION_CODE = 'REDRAW_REFERENCE_BUNDLE_MOTION_REFERENCE_STALE';
const LIMIT_CODE = 'REDRAW_REFERENCE_BUNDLE_REFERENCE_LIMIT_EXCEEDED';
const PROJECTION_CODE = 'REDRAW_REFERENCE_BUNDLE_PROJECTION_FAILED';
const COVERAGE_EVIDENCE_CODE = 'REDRAW_REFERENCE_BUNDLE_COVERAGE_EVIDENCE_REQUIRED';
const HEX_64 = /^[0-9a-f]{64}$/;
const INPUT_FIELDS = new Set([
  'shot_id',
  'expected_updated_at',
  'motion_reference_asset_id',
  'face_tracks',
  'text_regions',
  'coverage_review',
]);
const REQUIRED_VIEWS = new Set(['front', 'profile', 'full_body']);
const SILENCE_TOKENS = new Set([
  'silence',
  '[silence]',
  '(silence)',
  'silent',
  'no dialogue',
  '[no dialogue]',
]);

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function fail(code) {
  throw codedError(code, '参考包门禁失败');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalBundleHash(bundle) {
  return sha256(stableJson(bundle));
}

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value || '');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function parseDialogueArray(value) {
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(value);
    if (!Array.isArray(parsed)) fail(DIALOGUE_CODE);
    return parsed;
  } catch (error) {
    if (error?.code === DIALOGUE_CODE) throw error;
    fail(DIALOGUE_CODE);
  }
}

function normalizeLocale(value) {
  const locale = String(value || '').trim();
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(locale)) fail(DIALOGUE_CODE);
  return locale;
}

function normalizeMarket(value, code = DIALOGUE_CODE) {
  const market = String(value || '').trim();
  if (!/^[A-Z]{2}$/.test(market)) fail(code);
  return market;
}

function assertPlainObject(value, code = INPUT_CODE) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
}

function normalizeContext(ctx = {}) {
  if (!ctx.db || typeof ctx.db.prepare !== 'function') fail(INPUT_CODE);
  const tenantId = String(ctx.tenantId ?? ctx.tenant_id ?? '').trim();
  const userId = String(ctx.userId ?? ctx.user_id ?? '').trim();
  const versionId = Number(ctx.versionId ?? ctx.version_id);
  const storageRoot = String(ctx.storageRoot ?? ctx.storage_root ?? '').trim();
  if (!tenantId || !userId || !Number.isSafeInteger(versionId) || versionId <= 0 || !path.isAbsolute(storageRoot)) {
    fail(INPUT_CODE);
  }
  return { ...ctx, db: ctx.db, tenantId, userId, versionId, storageRoot };
}

function timestamp(ctx, previous) {
  const supplied = typeof ctx.now === 'function' ? ctx.now() : ctx.now;
  let next = new Date(supplied || Date.now());
  if (!Number.isFinite(next.getTime())) next = new Date();
  const oldTime = new Date(previous || 0).getTime();
  if (Number.isFinite(oldTime) && next.getTime() <= oldTime) next = new Date(oldTime + 1);
  return next.toISOString();
}

function comparable(value) {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function inside(root, candidate) {
  const rel = path.relative(comparable(root), comparable(candidate));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function resolveLocal(storageRoot, localPath, code) {
  const value = String(localPath || '').trim();
  const portable = value.replace(/\\/g, '/');
  if (!value || path.posix.isAbsolute(portable) || path.win32.isAbsolute(value) || portable.split('/').includes('..')) fail(code);
  let rootReal;
  let real;
  try {
    rootReal = fs.realpathSync(storageRoot);
    real = fs.realpathSync(path.resolve(rootReal, value));
  } catch (_) {
    fail(code);
  }
  if (!inside(rootReal, real)) fail(code);
  return real;
}

function sameFileStat(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sha256File(storageRoot, asset, code) {
  const filePath = resolveLocal(storageRoot, asset?.local_path, code);
  let fd = null;
  try {
    const realBefore = fs.realpathSync(filePath);
    const before = fs.statSync(realBefore);
    if (!before.isFile()) fail(code);
    fd = fs.openSync(realBefore, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const fdBefore = fs.fstatSync(fd);
    if (!fdBefore.isFile() || !sameFileStat(before, fdBefore)) fail(code);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
    const fdAfter = fs.fstatSync(fd);
    const realAfter = fs.realpathSync(filePath);
    const after = fs.statSync(realAfter);
    if (comparable(realBefore) !== comparable(realAfter) || !sameFileStat(fdBefore, fdAfter) || !sameFileStat(fdAfter, after)) {
      fail(code);
    }
    return hash.digest('hex');
  } catch (error) {
    if (error?.code?.startsWith?.('REDRAW_REFERENCE_BUNDLE_')) throw error;
    fail(code);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        // ignore close errors after fail-closed validation has already completed
      }
    }
  }
}

function coverageScope(ctx) {
  const row = ctx.db.prepare(`
    SELECT v.id, v.facts_hash, w.source_fingerprint, w.duration_ms
    FROM redraw_versions v
    JOIN redraw_works w
      ON w.id = v.work_id AND w.tenant_id = v.tenant_id AND w.user_id = v.user_id
      AND w.deleted_at IS NULL
    WHERE v.id = ? AND v.tenant_id = ? AND v.user_id = ? AND v.deleted_at IS NULL
  `).get(ctx.versionId, ctx.tenantId, ctx.userId);
  if (!row || !HEX_64.test(String(row.facts_hash || '')) || !HEX_64.test(String(row.source_fingerprint || ''))) {
    fail(COVERAGE_EVIDENCE_CODE);
  }
  return row;
}

function coverageEvidenceRow(ctx, scope) {
  const rows = ctx.db.prepare(`
    SELECT ra.*, a.local_path AS artifact_local_path, a.type AS artifact_type,
           a.mime_type AS artifact_mime_type, a.metadata AS artifact_metadata
    FROM redraw_assets ra
    JOIN assets a ON a.id = ra.asset_id AND a.deleted_at IS NULL
    WHERE ra.version_id = ? AND ra.tenant_id = ? AND ra.user_id = ?
      AND ra.kind = 'scene' AND ra.status = 'generated' AND ra.approval_status = 'approved'
      AND ra.asset_id IS NOT NULL AND ra.deleted_at IS NULL
    ORDER BY ra.version_number DESC, ra.id DESC
  `).all(ctx.versionId, ctx.tenantId, ctx.userId);
  for (const row of rows) {
    const payload = parseJson(row.source_ref_json, {});
    const snapshot = payload.snapshot;
    if (payload.source_ref?.stable_id !== 'full-frame-reviewed-coverage'
      || !snapshot || snapshot.mode !== 'full_frame_reviewed_coverage') continue;
    if (Number(snapshot.version_id) !== ctx.versionId
      || snapshot.facts_hash !== scope.facts_hash
      || snapshot.source_fingerprint !== scope.source_fingerprint
      || !HEX_64.test(String(snapshot.analysis_sha256 || ''))
      || !row.approved_by || !row.approved_at) fail(COVERAGE_EVIDENCE_CODE);
    return { row, snapshot };
  }
  fail(COVERAGE_EVIDENCE_CODE);
}

function readCoverageManifest(ctx, evidence) {
  const asset = {
    local_path: evidence.row.artifact_local_path,
  };
  const portable = String(asset.local_path || '').replace(/\\/g, '/');
  if (evidence.row.artifact_type !== 'document'
    || evidence.row.artifact_mime_type !== 'application/json'
    || path.posix.basename(portable) !== 'redraw-full-frame-reviewed-manifest.json') {
    fail(COVERAGE_EVIDENCE_CODE);
  }
  const metadata = parseJson(evidence.row.artifact_metadata, {});
  const digest = sha256File(ctx.storageRoot, asset, COVERAGE_EVIDENCE_CODE);
  if (!HEX_64.test(String(metadata.sha256 || '')) || digest !== metadata.sha256) fail(COVERAGE_EVIDENCE_CODE);
  const filePath = resolveLocal(ctx.storageRoot, asset.local_path, COVERAGE_EVIDENCE_CODE);
  let bytes;
  let manifest;
  try {
    bytes = fs.readFileSync(filePath);
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch (_) {
    fail(COVERAGE_EVIDENCE_CODE);
  }
  if (sha256(bytes) !== digest || sha256File(ctx.storageRoot, asset, COVERAGE_EVIDENCE_CODE) !== digest) {
    fail(COVERAGE_EVIDENCE_CODE);
  }
  return { manifest, evidenceRoot: path.dirname(filePath), baseRelative: path.posix.dirname(portable) };
}

function shotRows(ctx) {
  return ctx.db.prepare(`
    SELECT * FROM redraw_shots
    WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    ORDER BY batch_index ASC, shot_index ASC, id ASC
  `).all(ctx.versionId, ctx.tenantId, ctx.userId);
}

function assertCoverageMatchesVersion(scope, rows, manifest, evidence) {
  if (manifest.analysis_sha256 !== evidence.snapshot.analysis_sha256
    || manifest.source?.sha256 !== scope.source_fingerprint
    || Number(manifest.source?.duration_ms) !== Number(scope.duration_ms)) fail(COVERAGE_EVIDENCE_CODE);
  const expected = rows.map((row) => ({
    shot_id: String(row.shot_id || ''), start_ms: Number(row.start_ms), end_ms: Number(row.end_ms),
  }));
  const actual = Array.isArray(manifest.shots)
    ? manifest.shots.map((shot) => ({
        shot_id: String(shot.shot_id || ''), start_ms: Number(shot.start_ms), end_ms: Number(shot.end_ms),
      }))
    : [];
  if (stableJson(actual) !== stableJson(expected)) fail(COVERAGE_EVIDENCE_CODE);
}

function trackFrames(manifest, shot, track) {
  const ranges = Array.isArray(track.frame_ranges) ? track.frame_ranges : [];
  return manifest.frames.filter((frame) => frame.shot_id === shot.shot_id
    && ranges.some((range) => frame.frame_index >= range.start_frame && frame.frame_index <= range.end_frame));
}

function trackTimeRanges(manifest, shot, track) {
  const frames = trackFrames(manifest, shot, track).sort((left, right) => left.frame_index - right.frame_index);
  if (frames.length === 0) return [];
  const indexes = new Map(manifest.frames.map((frame) => [frame.frame_index, frame]));
  const ranges = [];
  for (const raw of track.frame_ranges) {
    const matched = frames.filter((frame) => frame.frame_index >= raw.start_frame && frame.frame_index <= raw.end_frame);
    if (matched.length === 0) continue;
    const start = Math.max(Number(shot.start_ms), Number(matched[0].timestamp_ms));
    const last = matched[matched.length - 1];
    const next = indexes.get(Number(last.frame_index) + 1);
    const end = Math.min(Number(shot.end_ms), next?.shot_id === shot.shot_id ? Number(next.timestamp_ms) : Number(shot.end_ms));
    if (start < end) ranges.push([start - Number(shot.start_ms), end - Number(shot.start_ms)]);
  }
  ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

function evidenceAsset(ctx, baseRelative, relativePath, expectedSha) {
  const target = path.posix.join(baseRelative, String(relativePath || '').replace(/\\/g, '/'));
  const matches = ctx.db.prepare(`
    SELECT * FROM assets WHERE category = 'redraw' AND type = 'image' AND deleted_at IS NULL
  `).all().filter((asset) => String(asset.local_path || '').replace(/\\/g, '/') === target);
  if (matches.length !== 1) fail(COVERAGE_EVIDENCE_CODE);
  const asset = matches[0];
  const metadata = parseJson(asset.metadata, {});
  if (metadata.sha256 !== expectedSha
    || sha256File(ctx.storageRoot, asset, COVERAGE_EVIDENCE_CODE) !== expectedSha) fail(COVERAGE_EVIDENCE_CODE);
  return Number(asset.id);
}

function textKind(value) {
  if (value === 'subtitle') return 'text_subtitle';
  if (['screen', 'ui', 'watermark'].includes(value)) return 'text_screen';
  fail(COVERAGE_EVIDENCE_CODE);
}

function cleanRequirement(ctx, evidence, manifest, shot, track, kind) {
  const frames = trackFrames(manifest, shot, track);
  const frameIndexes = new Set(frames.map((frame) => Number(frame.frame_index)));
  const region = track.regions.find((item) => frameIndexes.has(Number(item.frame_index)));
  const frame = region && manifest.frames.find((item) => Number(item.frame_index) === Number(region.frame_index));
  if (!region || !frame) fail(COVERAGE_EVIDENCE_CODE);
  const sceneAssetId = evidenceAsset(ctx, evidence.baseRelative, frame.path, frame.sha256);
  const maskAssetId = evidenceAsset(ctx, evidence.baseRelative, region.mask?.path, region.mask?.sha256);
  const sceneAsset = {
    source_asset_id: sceneAssetId,
    source_fingerprint: frame.sha256,
    width: frame.width,
    height: frame.height,
    shot_id: shot.shot_id,
    source_ref: {
      stable_id: String(kind === 'person_clean' ? track.track_key : track.region_key),
      kind: kind === 'person_clean' ? 'person_clean' : textKind(track.kind),
      analysis_sha256: manifest.analysis_sha256,
      frame_index: Number(frame.frame_index),
    },
  };
  if (kind === 'person_clean') {
    return {
      kind,
      key: String(track.track_key),
      scene_asset: sceneAsset,
      options: { mask_asset_id: maskAssetId, input_frame_fingerprint: frame.sha256 },
    };
  }
  const normalizedKind = textKind(track.kind);
  return {
    kind,
    key: String(track.region_key),
    scene_asset: sceneAsset,
    options: {
      mask_asset_id: maskAssetId,
      input_frame_fingerprint: frame.sha256,
      text_kind: normalizedKind,
      text_regions: [{ kind: normalizedKind, shape: 'polygon', points: region.polygon, source: 'ocr_region' }],
    },
  };
}

function coverageRequirementKeys(manifest, shot) {
  if (!Array.isArray(manifest.person_tracks) || !Array.isArray(manifest.text_tracks)) fail(COVERAGE_EVIDENCE_CODE);
  return [
    ...manifest.person_tracks
      .filter((track) => trackTimeRanges(manifest, shot, track).length > 0)
      .map((track) => `person_clean:${String(track.track_key || '')}`),
    ...manifest.text_tracks
      .filter((track) => trackTimeRanges(manifest, shot, track).length > 0)
      .map((track) => `text_clean:${String(track.region_key || '')}`),
  ].sort();
}

function buildCoverageBinding(scope, rows, indexed, manifest) {
  if (manifest.schema_version !== 'redraw-full-frame-coverage-v1'
    || manifest.status !== 'reviewed'
    || manifest.review?.status !== 'reviewed'
    || manifest.review?.reviewed !== true
    || manifest.review?.required_review_point_count !== manifest.review?.reviewed_point_count
    || manifest.approval_status !== 'pending'
    || manifest.ready_for_reference !== false
    || canonicalCoverageSha256(manifest) !== manifest.analysis_sha256) fail(COVERAGE_EVIDENCE_CODE);
  assertCoverageMatchesVersion(scope, rows, manifest, indexed);
  const shots = rows.map((shot) => {
    const keys = coverageRequirementKeys(manifest, shot);
    if (keys.some((key) => !/^(person_clean|text_clean):[A-Za-z0-9._:-]{1,160}$/.test(key))
      || new Set(keys).size !== keys.length) fail(COVERAGE_EVIDENCE_CODE);
    return {
      shot_id: Number(shot.id),
      requirement_keys: keys,
      requirement_hash: sha256(stableJson(keys)),
    };
  });
  return {
    schema_version: 'redraw-coverage-preparation-binding-v1',
    version_id: Number(scope.id),
    analysis_sha256: manifest.analysis_sha256,
    approved_by: String(indexed.row.approved_by || ''),
    approved_at: String(indexed.row.approved_at || ''),
    facts_hash: scope.facts_hash,
    source_fingerprint: scope.source_fingerprint,
    shots,
  };
}

function loadReviewedReferenceCoverageBinding(rawCtx) {
  const ctx = normalizeContext(rawCtx);
  const scope = coverageScope(ctx);
  const rows = shotRows(ctx);
  const indexed = coverageEvidenceRow(ctx, scope);
  const evidence = { ...indexed, ...readCoverageManifest(ctx, indexed) };
  return buildCoverageBinding(scope, rows, evidence, evidence.manifest);
}

async function loadReviewedReferenceCoverage(rawCtx) {
  const ctx = normalizeContext(rawCtx);
  const scope = coverageScope(ctx);
  const rows = shotRows(ctx);
  const indexed = coverageEvidenceRow(ctx, scope);
  const evidence = { ...indexed, ...readCoverageManifest(ctx, indexed) };
  let manifest;
  try {
    manifest = await validateReviewedCoverageManifest({ evidenceRoot: evidence.evidenceRoot, manifest: evidence.manifest });
  } catch (_) {
    fail(COVERAGE_EVIDENCE_CODE);
  }
  assertCoverageMatchesVersion(scope, rows, manifest, evidence);
  const coverageBinding = buildCoverageBinding(scope, rows, evidence, manifest);
  const descriptors = rows.map((shot) => {
    const persons = manifest.person_tracks.filter((track) => trackTimeRanges(manifest, shot, track).length > 0);
    const texts = manifest.text_tracks.filter((track) => trackTimeRanges(manifest, shot, track).length > 0);
    return {
      shot_id: Number(shot.id),
      source_shot_id: String(shot.shot_id),
      requirements: [
        ...persons.map((track) => cleanRequirement(ctx, evidence, manifest, shot, track, 'person_clean')),
        ...texts.map((track) => cleanRequirement(ctx, evidence, manifest, shot, track, 'text_clean')),
      ],
      bundle_evidence: {
        face_tracks: persons.filter((track) => track.kind === 'story_role').map((track) => ({
          track_key: track.track_key,
          source_character_key: track.source_character_key,
          time_ranges: trackTimeRanges(manifest, shot, track),
        })),
        text_regions: texts.map((track) => ({
          region_key: track.region_key,
          kind: textKind(track.kind),
          time_ranges: trackTimeRanges(manifest, shot, track),
        })),
        approved_by: indexed.row.approved_by,
        approved_at: indexed.row.approved_at,
        analysis_sha256: manifest.analysis_sha256,
      },
    };
  });
  return { status: 'approved', shots: descriptors, coverage_binding: coverageBinding };
}

function sourceKey(row) {
  const payload = parseJson(row?.source_ref_json, {});
  return String(payload.source_ref?.source_character_key || payload.source_ref?.stable_id || '').trim();
}

function currentIdentityAsset(ctx, key) {
  const matches = ctx.db.prepare(`
    SELECT * FROM redraw_assets
    WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND kind = 'character'
      AND status = 'generated' AND approval_status = 'approved' AND deleted_at IS NULL
    ORDER BY version_number DESC, id DESC
  `).all(ctx.versionId, ctx.tenantId, ctx.userId).filter((row) => sourceKey(row) === key);
  if (matches.length === 0) fail(IDENTITY_CODE);
  return Number(matches[0].id);
}

function motionAssetMatchesCurrentBindings(ctx, asset, bindings) {
  if (!asset || asset.type !== 'video' || asset.category !== 'redraw' || asset.deleted_at !== null) {
    return false;
  }
  const expected = {
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    version_id: ctx.versionId,
    shot_id: bindings.shot_id,
    source_asset_id: bindings.source.asset_id,
    source_fingerprint: bindings.source.fingerprint,
    clip_start_ms: bindings.clip.start_ms,
    clip_end_ms: bindings.clip.end_ms,
    face_coverage_sha256: bindings.face_coverage_sha256,
    text_coverage_sha256: bindings.text_coverage_sha256,
    coverage_binding_sha256: bindings.coverage_binding_sha256,
    identity_binding_sha256: bindings.identity_binding_sha256,
    clean_binding_sha256: bindings.clean_binding_sha256,
  };
  const metadata = parseJson(asset.metadata, {});
  const motion = metadata.redraw_motion_reference;
  if (!motion
    || !Object.entries(expected).every(([key, value]) => motion[key] === value)
    || !HEX_64.test(String(motion.file_sha256 || ''))
    || metadata.sha256 !== motion.file_sha256) return false;
  try {
    return sha256File(ctx.storageRoot, asset, MOTION_CODE) === motion.file_sha256;
  } catch (_) {
    return false;
  }
}

function currentMotionAsset(ctx, bindings) {
  const matches = ctx.db.prepare(`
    SELECT * FROM assets WHERE type = 'video' AND category = 'redraw' AND deleted_at IS NULL ORDER BY id DESC
  `).all().filter((asset) => motionAssetMatchesCurrentBindings(ctx, asset, bindings));
  if (matches.length !== 1) fail(MOTION_CODE);
  return Number(matches[0].id);
}

function assertMotionAssetCurrent(ctx, assetId, bindings) {
  const asset = ctx.db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(assetId);
  if (!motionAssetMatchesCurrentBindings(ctx, asset, bindings)) fail(MOTION_CODE);
}

async function buildCurrentReferenceBindings(rawCtx, input = {}) {
  assertPlainObject(input);
  if (Object.keys(input).some((key) => !['shot_id', 'clean_results'].includes(key))) fail(INPUT_CODE);
  const ctx = normalizeContext(rawCtx);
  const shotId = Number(input.shot_id);
  if (!Number.isSafeInteger(shotId) || shotId <= 0 || !Array.isArray(input.clean_results)) fail(INPUT_CODE);
  const shot = getRows(ctx, shotId).shot;
  const timeline = normalizeShotTimeline(shot);
  const coverage = await loadReviewedReferenceCoverage(ctx);
  const descriptor = coverage.shots.find((item) => Number(item.shot_id) === shotId);
  if (!descriptor) fail(COVERAGE_EVIDENCE_CODE);
  const cleanByKey = new Map(input.clean_results
    .filter((item) => item?.status === 'completed')
    .map((item) => [`${item.kind}:${item.key}`, Number(item.redraw_asset_id)]));
  const faces = descriptor.bundle_evidence.face_tracks.map((track) => ({
    ...track,
    identity_redraw_asset_id: currentIdentityAsset(ctx, track.source_character_key),
  })).sort((left, right) => left.track_key.localeCompare(right.track_key));
  const texts = descriptor.bundle_evidence.text_regions.map((region) => {
    const assetId = cleanByKey.get(`text_clean:${region.region_key}`);
    if (!Number.isSafeInteger(assetId) || assetId <= 0) fail(TEXT_CODE);
    return { ...region, text_clean_redraw_asset_id: assetId };
  }).sort((left, right) => left.region_key.localeCompare(right.region_key));
  assertFaceOneToOne(faces);
  const nameMap = normalizeNameMap(parseJson(shot.name_map_json, {}));
  const identities = verifyIdentities(ctx, shot, faces, nameMap);
  const cleanPlates = verifyTexts({ ...ctx, sourceFingerprint: shot.source_fingerprint }, texts);
  const coverageBinding = coverage.coverage_binding.shots.find((entry) => Number(entry.shot_id) === shotId);
  if (!coverageBinding) fail(COVERAGE_EVIDENCE_CODE);
  const coverageReview = {
    status: 'approved',
    recognizable_face_count: faces.length,
    mapped_face_count: faces.length,
    unresolved_face_count: 0,
    recognizable_text_region_count: texts.length,
    mapped_text_region_count: texts.length,
    unresolved_text_region_count: 0,
  };
  const currentCoverageBinding = {
    analysis_sha256: coverage.coverage_binding.analysis_sha256,
    approved_by: coverage.coverage_binding.approved_by,
    approved_at: coverage.coverage_binding.approved_at,
    facts_hash: coverage.coverage_binding.facts_hash,
    source_fingerprint: coverage.coverage_binding.source_fingerprint,
    requirement_keys: coverageBinding.requirement_keys,
    requirement_hash: coverageBinding.requirement_hash,
  };
  return {
    shot_id: shotId,
    source: {
      work_id: Number(shot.work_id),
      asset_id: Number(shot.source_asset_id),
      fingerprint: shot.source_fingerprint,
    },
    clip: {
      start_ms: timeline.start_ms,
      end_ms: timeline.end_ms,
      duration_ms: timeline.duration_ms,
    },
    face_tracks: faces,
    text_regions: texts,
    coverage_review: coverageReview,
    coverage_binding: currentCoverageBinding,
    coverage_binding_sha256: sha256(stableJson(currentCoverageBinding)),
    face_coverage_sha256: sha256(stableJson(faces)),
    text_coverage_sha256: sha256(stableJson(texts)),
    identity_binding_sha256: sha256(stableJson(identities)),
    clean_binding_sha256: sha256(stableJson(cleanPlates)),
  };
}

async function buildTrustedReferenceBundleInput(rawCtx, input = {}) {
  const ctx = normalizeContext(rawCtx);
  const bindings = await buildCurrentReferenceBindings(ctx, input);
  return {
    shot_id: bindings.shot_id,
    motion_reference_asset_id: currentMotionAsset(ctx, bindings),
    face_tracks: bindings.face_tracks,
    text_regions: bindings.text_regions,
    coverage_review: bindings.coverage_review,
  };
}

function getRows(ctx, shotId) {
  const shot = ctx.db.prepare(`
    SELECT s.*, v.locale, v.market, v.name_map_json, v.source_facts_json, v.facts_hash,
           w.source_asset_id, w.source_fingerprint
    FROM redraw_shots s
    JOIN redraw_versions v ON v.id = s.version_id AND v.deleted_at IS NULL
    JOIN redraw_works w ON w.id = s.work_id AND w.deleted_at IS NULL
    WHERE s.id = ? AND s.tenant_id = ? AND s.user_id = ? AND s.version_id = ?
      AND s.deleted_at IS NULL
  `).get(shotId, ctx.tenantId, ctx.userId, ctx.versionId);
  if (!shot) fail(NOT_FOUND_CODE);
  const sourceAsset = ctx.db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(Number(shot.source_asset_id));
  if (!sourceAsset || !HEX_64.test(String(shot.source_fingerprint || ''))) fail(INPUT_CODE);
  if (sha256File(ctx.storageRoot, sourceAsset, INPUT_CODE) !== shot.source_fingerprint) fail(INPUT_CODE);
  return { shot, sourceAsset };
}

function normalizeRanges(value, durationMs, code) {
  if (!Array.isArray(value) || value.length === 0) fail(code);
  const ranges = value.map((range) => {
    if (!Array.isArray(range) || range.length !== 2) fail(code);
    const start = Number(range[0]);
    const end = Number(range[1]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= end || end > durationMs) fail(code);
    return [start, end];
  }).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index][0] < ranges[index - 1][1]) fail(code);
  }
  return ranges;
}

function normalizeCoverage(input) {
  assertPlainObject(input.coverage_review, FACE_CODE);
  const review = input.coverage_review;
  if (review.status !== 'approved'
    || Number(review.recognizable_face_count) !== Number(review.mapped_face_count)
    || Number(review.unresolved_face_count) !== 0) fail(FACE_CODE);
  if (Number(review.recognizable_text_region_count) !== Number(review.mapped_text_region_count)
    || Number(review.unresolved_text_region_count) !== 0) fail(TEXT_CODE);
  return {
    recognizable_face_count: Number(review.recognizable_face_count),
    mapped_face_count: Number(review.mapped_face_count),
    unresolved_face_count: 0,
    recognizable_text_region_count: Number(review.recognizable_text_region_count),
    mapped_text_region_count: Number(review.mapped_text_region_count),
    unresolved_text_region_count: 0,
  };
}

function normalizeFaces(input, durationMs) {
  if (!Array.isArray(input.face_tracks)) fail(FACE_CODE);
  if (input.face_tracks.length > 9) fail(LIMIT_CODE);
  const seenTracks = new Set();
  const faces = input.face_tracks.map((entry) => {
    assertPlainObject(entry, FACE_CODE);
    const track = String(entry.track_key || '').trim();
    const source = String(entry.source_character_key || '').trim();
    const assetId = Number(entry.identity_redraw_asset_id);
    if (!track || !source || !Number.isSafeInteger(assetId) || assetId <= 0 || seenTracks.has(track)) fail(FACE_CODE);
    seenTracks.add(track);
    return {
      track_key: track,
      source_character_key: source,
      time_ranges: normalizeRanges(entry.time_ranges, durationMs, FACE_CODE),
      identity_redraw_asset_id: assetId,
    };
  }).sort((a, b) => a.track_key.localeCompare(b.track_key));
  return faces;
}

function normalizeTexts(input, durationMs) {
  if (!Array.isArray(input.text_regions)) fail(TEXT_CODE);
  const seen = new Set();
  const texts = input.text_regions.map((entry) => {
    assertPlainObject(entry, TEXT_CODE);
    const region = String(entry.region_key || '').trim();
    const kind = String(entry.kind || '').trim();
    const assetId = Number(entry.text_clean_redraw_asset_id);
    if (!region || !['text_subtitle', 'text_screen'].includes(kind)
      || !Number.isSafeInteger(assetId) || assetId <= 0 || seen.has(region)) fail(TEXT_CODE);
    seen.add(region);
    return {
      region_key: region,
      kind,
      time_ranges: normalizeRanges(entry.time_ranges, durationMs, TEXT_CODE),
      text_clean_redraw_asset_id: assetId,
    };
  }).sort((a, b) => a.region_key.localeCompare(b.region_key));
  return texts;
}

function identityHash(pack) {
  return sha256(stableJson({
    artifact: pack.artifact,
    adult_status: pack.adult_status,
    confirmed_views: pack.confirmed_views,
    identity_consistency_confirmed: pack.identity_consistency_confirmed,
    live_action_human_confirmed: pack.live_action_human_confirmed,
    persona_origin: pack.persona_origin,
    ready: pack.ready,
    reviewed_at: pack.reviewed_at,
    reviewed_by: pack.reviewed_by,
    schema_version: pack.schema_version,
    source_character_key: pack.source_character_key,
    target_actor_label: pack.target_actor_label,
    target_country: pack.target_country,
    wardrobe: pack.wardrobe,
  }));
}

function assertAssetDigest(ctx, assetId, expectedSha, kind, code) {
  const asset = ctx.db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(Number(assetId));
  if (!asset || String(asset.type || '') !== kind) fail(code);
  if (sha256File(ctx.storageRoot, asset, code) !== expectedSha) fail(code);
  return asset;
}

function verifyIdentities(ctx, shot, faces, nameMap) {
  const targetCountry = normalizeMarket(shot.market, IDENTITY_CODE);
  return faces.map((face) => {
    const row = ctx.db.prepare(`
      SELECT * FROM redraw_assets
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND version_id = ?
        AND kind = 'character' AND deleted_at IS NULL
    `).get(face.identity_redraw_asset_id, ctx.tenantId, ctx.userId, ctx.versionId);
    if (!row || row.approval_status !== 'approved') fail(IDENTITY_CODE);
    const payload = parseJson(row.source_ref_json, {});
    const pack = payload.identity_pack;
    if (!pack || sourceKey(row) !== face.source_character_key
      || pack.source_character_key !== face.source_character_key
      || row.localized_name !== pack.target_actor_label
      || !nameMap[face.source_character_key]) fail(IDENTITY_CODE);
    const views = new Set(Array.isArray(pack.confirmed_views) ? pack.confirmed_views : []);
    if (pack.schema_version !== 'target-actor-identity-v1'
      || pack.ready !== true
      || pack.live_action_human_confirmed !== true
      || pack.identity_consistency_confirmed !== true
      || pack.adult_status !== 'verified_18_plus'
      || pack.persona_origin !== 'fictional_ai_generated'
      || pack.target_country !== targetCountry
      || ![...REQUIRED_VIEWS].every((view) => views.has(view))
      || pack.pack_sha256 !== identityHash(pack)
      || !pack.artifact || Number(pack.artifact.asset_id) !== Number(row.asset_id)
      || !HEX_64.test(String(pack.artifact.sha256 || ''))
      || !pack.wardrobe
      || pack.wardrobe.label !== '整集主服装'
      || pack.wardrobe.consistency_confirmed !== true
      || !Number.isSafeInteger(Number(pack.wardrobe.reference_asset_id))
      || Number(pack.wardrobe.reference_asset_id) <= 0
      || !HEX_64.test(String(pack.wardrobe.reference_sha256 || ''))) fail(IDENTITY_CODE);
    assertAssetDigest(ctx, pack.artifact.asset_id, pack.artifact.sha256, 'image', IDENTITY_CODE);
    assertAssetDigest(ctx, pack.wardrobe.reference_asset_id, pack.wardrobe.reference_sha256, 'image', IDENTITY_CODE);
    return {
      redraw_asset_id: row.id,
      source_character_key: face.source_character_key,
      target_character_name: nameMap[face.source_character_key],
      target_actor_label: pack.target_actor_label,
      identity_asset_id: Number(pack.artifact.asset_id),
      identity_pack_sha256: pack.pack_sha256,
      persona_origin: pack.persona_origin,
      target_country: pack.target_country,
      adult_status: pack.adult_status,
      artifact: pack.artifact,
      wardrobe: {
        reference_asset_id: Number(pack.wardrobe.reference_asset_id),
        reference_sha256: pack.wardrobe.reference_sha256,
        consistency_confirmed: true,
      },
      pack_sha256: pack.pack_sha256,
    };
  });
}

function assertFaceOneToOne(faces) {
  const sourceToIdentity = new Map();
  const identityToSource = new Map();
  for (const face of faces) {
    if (sourceToIdentity.has(face.source_character_key)
      && sourceToIdentity.get(face.source_character_key) !== face.identity_redraw_asset_id) fail(FACE_CODE);
    if (identityToSource.has(face.identity_redraw_asset_id)
      && identityToSource.get(face.identity_redraw_asset_id) !== face.source_character_key) fail(FACE_CODE);
    sourceToIdentity.set(face.source_character_key, face.identity_redraw_asset_id);
    identityToSource.set(face.identity_redraw_asset_id, face.source_character_key);
  }
}

function textHash(pack) {
  const { pack_sha256: _ignored, ...rest } = pack;
  return sha256(stableJson(rest));
}

function verifyTexts(ctx, texts) {
  return texts.map((text) => {
    const row = ctx.db.prepare(`
      SELECT * FROM redraw_assets
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND version_id = ?
        AND kind = 'scene' AND deleted_at IS NULL
    `).get(text.text_clean_redraw_asset_id, ctx.tenantId, ctx.userId, ctx.versionId);
    if (!row || row.approval_status !== 'approved') fail(TEXT_CODE);
    const payload = parseJson(row.source_ref_json, {});
    const pack = payload.text_clean_plate_pack;
    if (payload.source_ref?.stable_id !== text.region_key
      || payload.source_ref?.kind !== text.kind
      || payload.snapshot?.mode !== 'text_clean_plate'
      || !pack
      || pack.region_key !== text.region_key
      || pack.kind !== text.kind
      || pack.ready !== true
      || pack.pack_sha256 !== textHash(pack)
      || pack.source_fingerprint !== ctx.sourceFingerprint
      || !pack.artifact
      || Number(pack.artifact.asset_id) !== Number(row.clean_plate_asset_id)
      || !HEX_64.test(String(pack.artifact.sha256 || ''))) fail(TEXT_CODE);
    assertAssetDigest(ctx, pack.artifact.asset_id, pack.artifact.sha256, 'image', TEXT_CODE);
    return {
      redraw_asset_id: row.id,
      region_key: text.region_key,
      kind: text.kind,
      artifact: pack.artifact,
      pack_sha256: pack.pack_sha256,
    };
  });
}

function containsChinese(value) {
  return /[\u3400-\u9fff]/.test(JSON.stringify(value));
}

function isSilenceToken(value) {
  return SILENCE_TOKENS.has(String(value || '').trim().toLowerCase().replace(/\s+/g, ' '));
}

function normalizeNameMap(value) {
  assertPlainObject(value, DIALOGUE_CODE);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(DIALOGUE_CODE);
  const entries = Object.keys(value).map((rawKey) => ({
    key: String(rawKey).trim(),
    name: String(value[rawKey] || '').trim(),
  })).sort((left, right) => left.key.localeCompare(right.key));
  const keys = new Set();
  for (const entry of entries) {
    if (!entry.key || !entry.name || keys.has(entry.key)
      || ['__proto__', 'prototype', 'constructor'].includes(entry.key)
      || containsChinese(entry.name)) fail(DIALOGUE_CODE);
    keys.add(entry.key);
  }
  return Object.fromEntries(entries.map((entry) => [entry.key, entry.name]));
}

function normalizeShotTimeline(shot) {
  const timeline = {
    start_ms: shot.start_ms,
    end_ms: shot.end_ms,
    duration_ms: shot.duration_ms,
  };
  if (!Number.isSafeInteger(timeline.start_ms)
    || !Number.isSafeInteger(timeline.end_ms)
    || !Number.isSafeInteger(timeline.duration_ms)
    || timeline.start_ms < 0
    || timeline.end_ms <= timeline.start_ms
    || timeline.duration_ms !== timeline.end_ms - timeline.start_ms) fail(DIALOGUE_CODE);
  return timeline;
}

function relativeDialogueRange(entry, timeline) {
  const start = entry.start_ms;
  const end = entry.end_ms;
  if (!Number.isInteger(start) || !Number.isInteger(end)
    || start < timeline.start_ms || start >= end || end > timeline.end_ms) fail(DIALOGUE_CODE);
  return { start_ms: start - timeline.start_ms, end_ms: end - timeline.start_ms };
}

function canonicalSourceDialogue(value, timeline) {
  return parseDialogueArray(value).map((entry) => {
    assertPlainObject(entry, DIALOGUE_CODE);
    const normalized = {
      id: String(entry.id || '').trim(),
      speaker_id: String(entry.speaker_id || '').trim(),
      source_text: String(entry.source_text ?? entry.text ?? '').trim(),
      ...relativeDialogueRange(entry, timeline),
    };
    if (!normalized.speaker_id || !normalized.source_text) fail(DIALOGUE_CODE);
    return normalized;
  }).sort((left, right) => left.start_ms - right.start_ms
    || left.end_ms - right.end_ms
    || left.speaker_id.localeCompare(right.speaker_id)
    || left.id.localeCompare(right.id));
}

function canonicalLocalizedDialogue(value, timeline, nameMap, boundCharacters) {
  return parseDialogueArray(value).map((entry) => {
    assertPlainObject(entry, DIALOGUE_CODE);
    const speaker = String(entry.speaker_id || '').trim();
    if (typeof entry.localized_text !== 'string') fail(DIALOGUE_CODE);
    const text = entry.localized_text.trim();
    const range = relativeDialogueRange(entry, timeline);
    if (!boundCharacters.has(speaker) || !nameMap[speaker] || !text || containsChinese(text) || isSilenceToken(text)) {
      fail(DIALOGUE_CODE);
    }
    return { speaker_id: speaker, localized_text: text, ...range };
  }).sort((left, right) => left.start_ms - right.start_ms
    || left.end_ms - right.end_ms
    || left.speaker_id.localeCompare(right.speaker_id));
}

function localizationBinding(shot, timeline, nameMap, sourceDialogue, localizedDialogue) {
  const sourceDialogueSha256 = sha256(stableJson(sourceDialogue));
  const scriptSha256 = sha256(stableJson(localizedDialogue));
  const characterNameMapSha256 = sha256(stableJson(nameMap));
  const binding = {
    contract: LOCALIZATION_BINDING_CONTRACT,
    version_id: Number(shot.version_id),
    facts_hash: String(shot.facts_hash || ''),
    target: {
      locale: normalizeLocale(shot.locale),
      market: normalizeMarket(shot.market),
    },
    shot: {
      id: Number(shot.id),
      shot_id: String(shot.shot_id || '').trim(),
      ...timeline,
    },
    source_dialogue_sha256: sourceDialogueSha256,
    script_sha256: scriptSha256,
    character_name_map_sha256: characterNameMapSha256,
  };
  if (!HEX_64.test(binding.facts_hash) || !binding.shot.shot_id) fail(DIALOGUE_CODE);
  return {
    ...binding,
    localization_binding_sha256: sha256(stableJson(binding)),
  };
}

function verifyDialogue(shot, timeline, nameMap, boundCharacters) {
  const sourceDialogue = canonicalSourceDialogue(shot.source_dialogue_json, timeline);
  const rawDialogue = parseDialogueArray(shot.localized_dialogue_json);
  const sourceSilent = sourceDialogue.length === 0;
  const localizedSilent = rawDialogue.length === 0;
  if (sourceSilent !== localizedSilent) fail(DIALOGUE_CODE);
  const dialogue = sourceSilent
    ? []
    : canonicalLocalizedDialogue(rawDialogue, timeline, nameMap, boundCharacters);
  const binding = localizationBinding(shot, timeline, nameMap, sourceDialogue, dialogue);
  const common = {
    localized_script_version_id: Number(shot.version_id),
    target_locale: binding.target.locale,
    target_market: binding.target.market,
    source_dialogue_sha256: binding.source_dialogue_sha256,
    script_sha256: binding.script_sha256,
    character_name_map_sha256: binding.character_name_map_sha256,
    localization_binding_sha256: binding.localization_binding_sha256,
  };
  if (sourceSilent) {
    return {
      ...common,
      kind: 'silent',
      speech_required: false,
      turns: [],
    };
  }
  return {
    ...common,
    kind: 'spoken',
    speech_required: true,
    turns: dialogue,
  };
}

function validateInput(input) {
  assertPlainObject(input, INPUT_CODE);
  for (const key of Object.keys(input)) {
    if (!INPUT_FIELDS.has(key)) fail(INPUT_CODE);
  }
  const shotId = Number(input.shot_id);
  const motionId = Number(input.motion_reference_asset_id);
  const expectedUpdatedAt = String(input.expected_updated_at || '').trim();
  if (!Number.isSafeInteger(shotId) || shotId <= 0 || !Number.isSafeInteger(motionId) || motionId <= 0 || !expectedUpdatedAt) {
    fail(CONFLICT_CODE);
  }
  return { shotId, motionId, expectedUpdatedAt };
}

async function buildBundle(ctx, input, options = {}) {
  const ids = validateInput(input);
  const { shot } = getRows(ctx, ids.shotId);
  if (String(shot.updated_at || '') !== ids.expectedUpdatedAt) fail(CONFLICT_CODE);
  const timeline = normalizeShotTimeline(shot);
  const durationMs = timeline.duration_ms;
  const coverageReview = normalizeCoverage(input);
  const faces = normalizeFaces(input, durationMs);
  const texts = normalizeTexts(input, durationMs);
  if (faces.length !== coverageReview.mapped_face_count) fail(FACE_CODE);
  if (texts.length !== coverageReview.mapped_text_region_count) fail(TEXT_CODE);
  assertFaceOneToOne(faces);

  const nameMap = normalizeNameMap(parseJson(shot.name_map_json, {}));
  const dialogue = verifyDialogue(shot, timeline, nameMap, new Set(faces.map((face) => face.source_character_key)));
  const identityEvidence = verifyIdentities(ctx, shot, faces, nameMap);
  const textEvidence = verifyTexts({ ...ctx, sourceFingerprint: shot.source_fingerprint }, texts);
  const faceCoverageSha256 = sha256(stableJson(faces));
  const textCoverageSha256 = sha256(stableJson(texts));
  const currentBindings = await buildCurrentReferenceBindings(ctx, {
    shot_id: ids.shotId,
    clean_results: texts.map((text) => ({
      kind: 'text_clean',
      key: text.region_key,
      status: 'completed',
      redraw_asset_id: text.text_clean_redraw_asset_id,
    })),
  });
  if (currentBindings.face_coverage_sha256 !== faceCoverageSha256
    || currentBindings.text_coverage_sha256 !== textCoverageSha256) fail(MOTION_CODE);
  assertMotionAssetCurrent(ctx, ids.motionId, currentBindings);
  const motion = await verifyMotionReference({
    ...ctx,
    shotId: ids.shotId,
    assetId: ids.motionId,
    expected: {
      source_asset_id: Number(shot.source_asset_id),
      source_fingerprint: shot.source_fingerprint,
      clip_start_ms: timeline.start_ms,
      clip_end_ms: timeline.end_ms,
      face_coverage_sha256: faceCoverageSha256,
      text_coverage_sha256: textCoverageSha256,
    },
    probeRunner: ctx.probeRunner,
  });

  const reviewedAt = options.reviewedAt || timestamp(ctx, shot.updated_at);
  const reviewedBy = options.reviewedBy || ctx.userId;
  const coverage = {
    ...coverageReview,
    reviewed_by: reviewedBy,
    reviewed_at: reviewedAt,
    face_coverage_sha256: faceCoverageSha256,
    text_coverage_sha256: textCoverageSha256,
  };
  const bundle = {
    schema_version: REFERENCE_BUNDLE_SCHEMA_VERSION,
    shot_id: ids.shotId,
    version_id: ctx.versionId,
    duration_ms: durationMs,
    locale: dialogue.target_locale,
    market: dialogue.target_market,
    source: {
      asset_id: Number(shot.source_asset_id),
      sha256: shot.source_fingerprint,
      clip_start_ms: timeline.start_ms,
      clip_end_ms: timeline.end_ms,
    },
    name_map: nameMap,
    dialogue,
    face_tracks: faces.map((face) => ({
      ...face,
      ...(() => {
        const identity = identityEvidence.find((entry) => entry.redraw_asset_id === face.identity_redraw_asset_id);
        return {
          target_character_name: identity.target_character_name,
          identity_asset_id: identity.identity_asset_id,
          identity_pack_sha256: identity.identity_pack_sha256,
          persona_origin: identity.persona_origin,
          target_country: identity.target_country,
          adult_status: identity.adult_status,
          identity,
        };
      })(),
    })),
    text_regions: texts.map((text) => ({
      ...text,
      clean_plate: textEvidence.find((entry) => entry.redraw_asset_id === text.text_clean_redraw_asset_id),
    })),
    motion_reference: {
      asset_id: motion.asset_id,
      sha256: motion.sha256,
      duration_ms: motion.duration_ms,
      width: motion.width,
      height: motion.height,
      mime_type: motion.mime_type,
      video_codec: motion.video_codec,
      audio_stream_count: motion.audio_stream_count,
    },
    coverage_review: coverage,
    coverage_sha256: sha256(stableJson({
      face_coverage_sha256: faceCoverageSha256,
      text_coverage_sha256: textCoverageSha256,
      review: coverageReview,
    })),
  };
  return { ids, shot, bundle, hash: canonicalBundleHash(bundle), reviewedAt };
}

async function saveReferenceBundle(rawCtx, input) {
  const ctx = normalizeContext(rawCtx);
  const built = await buildBundle(ctx, input);
  const updated = ctx.db.prepare(`
    UPDATE redraw_shots
    SET reference_bundle_json = ?, reference_bundle_hash = ?,
        reference_bundle_updated_at = ?, updated_at = ?
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND version_id = ?
      AND updated_at = ? AND deleted_at IS NULL
  `).run(
    stableJson(built.bundle),
    built.hash,
    built.reviewedAt,
    built.reviewedAt,
    built.ids.shotId,
    ctx.tenantId,
    ctx.userId,
    ctx.versionId,
    built.ids.expectedUpdatedAt,
  );
  if (updated.changes !== 1) fail(CONFLICT_CODE);
  return {
    shot_id: built.ids.shotId,
    reference_bundle_hash: built.hash,
    reference_bundle_updated_at: built.reviewedAt,
    bundle: built.bundle,
  };
}

function classifyBundleMismatch(saved, rebuilt) {
  if (stableJson(saved.dialogue) !== stableJson(rebuilt.dialogue)
    || stableJson(saved.name_map) !== stableJson(rebuilt.name_map)) return DIALOGUE_CODE;
  if (stableJson(saved.face_tracks) !== stableJson(rebuilt.face_tracks)) return IDENTITY_CODE;
  if (stableJson(saved.text_regions) !== stableJson(rebuilt.text_regions)) return TEXT_CODE;
  if (stableJson(saved.motion_reference) !== stableJson(rebuilt.motion_reference)) return MOTION_CODE;
  return CONFLICT_CODE;
}

async function loadCurrentReferenceBundle(rawCtx, shotId) {
  const ctx = normalizeContext(rawCtx);
  const id = Number(shotId);
  const { shot } = getRows(ctx, id);
  const bundle = parseJson(shot.reference_bundle_json, null);
  if (!bundle || bundle.schema_version !== REFERENCE_BUNDLE_SCHEMA_VERSION || !shot.reference_bundle_hash) fail(NOT_FOUND_CODE);
  if (canonicalBundleHash(bundle) !== shot.reference_bundle_hash) fail(CONFLICT_CODE);
  const timeline = normalizeShotTimeline(shot);
  const currentNameMap = normalizeNameMap(parseJson(shot.name_map_json, {}));
  const currentDialogue = verifyDialogue(
    shot,
    timeline,
    currentNameMap,
    new Set(Array.isArray(bundle.face_tracks)
      ? bundle.face_tracks.map((entry) => String(entry?.source_character_key || '').trim()).filter(Boolean)
      : []),
  );
  if (stableJson(bundle.name_map) !== stableJson(currentNameMap)
    || stableJson(bundle.dialogue) !== stableJson(currentDialogue)) fail(DIALOGUE_CODE);
  const input = {
    shot_id: id,
    expected_updated_at: shot.updated_at,
    motion_reference_asset_id: bundle.motion_reference?.asset_id,
    face_tracks: bundle.face_tracks?.map((entry) => ({
      track_key: entry.track_key,
      source_character_key: entry.source_character_key,
      time_ranges: entry.time_ranges,
      identity_redraw_asset_id: entry.identity_redraw_asset_id,
    })),
    text_regions: bundle.text_regions?.map((entry) => ({
      region_key: entry.region_key,
      kind: entry.kind,
      time_ranges: entry.time_ranges,
      text_clean_redraw_asset_id: entry.text_clean_redraw_asset_id,
    })),
    coverage_review: {
      recognizable_face_count: bundle.coverage_review?.recognizable_face_count,
      mapped_face_count: bundle.coverage_review?.mapped_face_count,
      unresolved_face_count: bundle.coverage_review?.unresolved_face_count,
      recognizable_text_region_count: bundle.coverage_review?.recognizable_text_region_count,
      mapped_text_region_count: bundle.coverage_review?.mapped_text_region_count,
      unresolved_text_region_count: bundle.coverage_review?.unresolved_text_region_count,
      status: 'approved',
    },
  };
  if (!bundle.coverage_review?.reviewed_at || !bundle.coverage_review?.reviewed_by) fail(CONFLICT_CODE);
  const rebuilt = await buildBundle(ctx, input, {
    reviewedAt: bundle.coverage_review.reviewed_at,
    reviewedBy: bundle.coverage_review.reviewed_by,
  });
  if (rebuilt.hash !== shot.reference_bundle_hash || stableJson(rebuilt.bundle) !== stableJson(bundle)) {
    fail(classifyBundleMismatch(bundle, rebuilt.bundle));
  }
  return {
    shot_id: id,
    reference_bundle_hash: shot.reference_bundle_hash,
    reference_bundle_updated_at: shot.reference_bundle_updated_at,
    bundle,
  };
}

function assertReferenceUrl(value, sourceUrl) {
  if (typeof value !== 'string' || (!value.startsWith('/static/') && !value.startsWith('https://')) || value === sourceUrl) {
    fail(PROJECTION_CODE);
  }
  return value;
}

function promptTimeRange(entry) {
  return `${Number(entry.start_ms)}-${Number(entry.end_ms)}ms`;
}

function buildGenerationPrompt(bundle, identityBindings) {
  const targetLocale = normalizeLocale(bundle.locale);
  const targetMarket = normalizeMarket(bundle.market, PROJECTION_CODE);
  const nameByCharacter = new Map(identityBindings.map((entry) => [
    entry.source_character_key,
    entry.target_character_name,
  ]));
  const imageIndexByAsset = new Map();
  const characterLines = identityBindings.map((entry) => {
    if (!imageIndexByAsset.has(entry.reference_image_asset_id)) {
      imageIndexByAsset.set(entry.reference_image_asset_id, imageIndexByAsset.size + 1);
    }
    return `- Reference image ${imageIndexByAsset.get(entry.reference_image_asset_id)} is the exclusive identity anchor for ${entry.target_character_name}, portrayed by ${entry.target_actor_label}, target country ${entry.target_country}. Preserve that face, apparent ethnicity, adult age, hair, and wardrobe.`;
  });
  let dialogueSection;
  if (bundle.dialogue.kind === 'spoken' && bundle.dialogue.speech_required === true) {
    const dialogueLines = bundle.dialogue.turns.map((turn) => {
      const speaker = nameByCharacter.get(turn.speaker_id);
      if (!speaker) fail(PROJECTION_CODE);
      return `- ${promptTimeRange(turn)} ${speaker}: ${turn.localized_text}`;
    });
    dialogueSection = [
      'Dialogue mode: spoken.',
      'Dialogue timing:',
      ...dialogueLines,
      `Generate synchronized ${targetLocale} speech audio for the approved dialogue timing only.`,
    ];
  } else if (bundle.dialogue.kind === 'silent' && bundle.dialogue.speech_required === false) {
    dialogueSection = [
      'Dialogue mode: silent.',
      'Do not generate spoken dialogue, voiceover, narration, chanting, or intelligible vocalization.',
      'Generate only scene-appropriate non-speech ambience and action sound effects.',
    ];
  } else {
    fail(PROJECTION_CODE);
  }
  return [
    `Create a 1:1 live-action redraw of this short-drama shot for target locale ${targetLocale} and market ${targetMarket}.`,
    'Use the approved fictional AI-generated adult character references and the silent motion reference only.',
    'Use the motion reference only for action, blocking, framing, and camera movement; never use it as a face or identity source.',
    'Do not replace any character with a different face or apparent ethnicity.',
    'Keep the same plot beats, blocking, camera framing, pacing, and visible text coverage.',
    `Target locale: ${targetLocale}.`,
    'Character mapping:',
    ...characterLines,
    ...dialogueSection,
    'Do not include any Chinese subtitles, Chinese dialogue, watermarks, URLs, file paths, keys, or authorization text.',
  ].join('\n');
}

async function projectReferenceBundleForGeneration(rawCtx, shotId) {
  const ctx = normalizeContext(rawCtx);
  const loaded = await loadCurrentReferenceBundle(ctx, shotId);
  const bundle = loaded.bundle;
  try {
    if (typeof ctx.createReferenceUrl !== 'function') fail(PROJECTION_CODE);
    const sourceAsset = ctx.db.prepare('SELECT url FROM assets WHERE id = ? AND deleted_at IS NULL')
      .get(bundle.source.asset_id);
    const sourceUrl = String(sourceAsset?.url || '');
    const imageByIdentity = new Map();
    for (const face of bundle.face_tracks) {
      const identity = face.identity;
      if (!imageByIdentity.has(identity.artifact.asset_id)) {
        imageByIdentity.set(identity.artifact.asset_id, assertReferenceUrl(ctx.createReferenceUrl({
          asset_id: identity.artifact.asset_id,
          sha256: identity.artifact.sha256,
          kind: 'identity',
        }), sourceUrl));
      }
    }
    const referenceVideoUrl = assertReferenceUrl(ctx.createReferenceUrl({
      asset_id: bundle.motion_reference.asset_id,
      sha256: bundle.motion_reference.sha256,
      kind: 'motion',
    }), sourceUrl);
    const identityBindings = bundle.face_tracks.map((face) => ({
      track_key: face.track_key,
      source_character_key: face.source_character_key,
      target_character_name: face.identity.target_character_name,
      target_actor_label: face.identity.target_actor_label,
      reference_image_asset_id: face.identity.artifact.asset_id,
      redraw_asset_id: face.identity_redraw_asset_id,
      identity_pack_sha256: face.identity_pack_sha256,
      target_country: face.identity.target_country,
    }));
    return {
      prompt: buildGenerationPrompt(bundle, identityBindings),
      targetLocale: normalizeLocale(bundle.locale),
      generateAudio: true,
      referenceImageUrls: [...imageByIdentity.values()],
      referenceVideoUrl,
      identityBindings,
      referenceBundleSnapshot: {
        schema_version: REFERENCE_BUNDLE_SCHEMA_VERSION,
        reference_bundle_hash: loaded.reference_bundle_hash,
        coverage_sha256: bundle.coverage_sha256,
        source_sha256: bundle.source.sha256,
        motion_sha256: bundle.motion_reference.sha256,
        dialogue_kind: bundle.dialogue.kind,
        speech_required: bundle.dialogue.speech_required,
        source_dialogue_sha256: bundle.dialogue.source_dialogue_sha256,
        dialogue_script_sha256: bundle.dialogue.script_sha256,
        character_name_map_sha256: bundle.dialogue.character_name_map_sha256,
        localization_binding_sha256: bundle.dialogue.localization_binding_sha256,
      },
    };
  } catch (_) {
    fail(PROJECTION_CODE);
  }
}

module.exports = {
  REFERENCE_BUNDLE_SCHEMA_VERSION,
  loadReviewedReferenceCoverage,
  loadReviewedReferenceCoverageBinding,
  buildCurrentReferenceBindings,
  buildTrustedReferenceBundleInput,
  saveReferenceBundle,
  loadCurrentReferenceBundle,
  projectReferenceBundleForGeneration,
  canonicalBundleHash,
};
