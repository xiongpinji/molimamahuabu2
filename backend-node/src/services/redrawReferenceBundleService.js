const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { verifyMotionReference } = require('./redrawMotionReferenceService');

const SCHEMA_VERSION = 'redraw-reference-bundle-v1';
const INPUT_CODE = 'REDRAW_REFERENCE_BUNDLE_INPUT_INVALID';
const NOT_FOUND_CODE = 'REDRAW_REFERENCE_BUNDLE_NOT_FOUND';
const CONFLICT_CODE = 'REDRAW_REFERENCE_BUNDLE_CONFLICT';
const FACE_CODE = 'REDRAW_REFERENCE_BUNDLE_FACE_INVALID';
const IDENTITY_CODE = 'REDRAW_REFERENCE_BUNDLE_IDENTITY_INVALID';
const TEXT_CODE = 'REDRAW_REFERENCE_BUNDLE_TEXT_INVALID';
const DIALOGUE_CODE = 'REDRAW_REFERENCE_BUNDLE_DIALOGUE_INVALID';
const LIMIT_CODE = 'REDRAW_REFERENCE_BUNDLE_REFERENCE_LIMIT_EXCEEDED';
const PROJECTION_CODE = 'REDRAW_REFERENCE_BUNDLE_PROJECTION_FAILED';
const DRIFT_CODE = 'REDRAW_REFERENCE_BUNDLE_DRIFT';
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
  }));
}

function assertAssetDigest(ctx, assetId, expectedSha, kind, code) {
  const asset = ctx.db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(Number(assetId));
  if (!asset || String(asset.type || '') !== kind) fail(code);
  if (sha256File(ctx.storageRoot, asset, code) !== expectedSha) fail(code);
  return asset;
}

function verifyIdentities(ctx, faces, nameMap) {
  return faces.map((face) => {
    const row = ctx.db.prepare(`
      SELECT * FROM redraw_assets
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND version_id = ?
        AND kind = 'character' AND deleted_at IS NULL
    `).get(face.identity_redraw_asset_id, ctx.tenantId, ctx.userId, ctx.versionId);
    if (!row || row.approval_status !== 'approved') fail(IDENTITY_CODE);
    const payload = parseJson(row.source_ref_json, {});
    const pack = payload.identity_pack;
    if (!pack || payload.source_ref?.stable_id !== face.source_character_key
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
      || pack.target_country !== 'US'
      || ![...REQUIRED_VIEWS].every((view) => views.has(view))
      || pack.pack_sha256 !== identityHash(pack)
      || !pack.artifact || Number(pack.artifact.asset_id) !== Number(row.asset_id)
      || !HEX_64.test(String(pack.artifact.sha256 || ''))) fail(IDENTITY_CODE);
    assertAssetDigest(ctx, pack.artifact.asset_id, pack.artifact.sha256, 'image', IDENTITY_CODE);
    return {
      redraw_asset_id: row.id,
      source_character_key: face.source_character_key,
      target_character_name: nameMap[face.source_character_key],
      target_actor_label: pack.target_actor_label,
      artifact: pack.artifact,
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

function assertFullTextCoverage(texts, durationMs) {
  const ranges = [];
  for (const text of texts) {
    ranges.push(...text.time_ranges);
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cursor = 0;
  for (const range of ranges) {
    if (range[0] !== cursor) fail(TEXT_CODE);
    cursor = range[1];
  }
  if (cursor !== durationMs) fail(TEXT_CODE);
}

function containsChinese(value) {
  return /[\u3400-\u9fff]/.test(JSON.stringify(value));
}

function verifyDialogue(shot, nameMap, boundCharacters) {
  if (shot.locale !== 'en-US' || shot.market !== 'US') fail(DIALOGUE_CODE);
  const facts = parseJson(shot.source_facts_json, {});
  if (!HEX_64.test(String(facts.script_sha256 || '')) || facts.name_map_source_sha256 !== sha256(stableJson(nameMap))) {
    fail(DIALOGUE_CODE);
  }
  const dialogue = parseJson(shot.localized_dialogue_json, []);
  if (!Array.isArray(dialogue) || dialogue.length === 0 || containsChinese(dialogue) || containsChinese(nameMap)) fail(DIALOGUE_CODE);
  const normalized = dialogue.map((entry) => {
    const speaker = String(entry.speaker_id || '').trim();
    const text = String(entry.localized_text || '').trim();
    const start = Number(entry.start_ms);
    const end = Number(entry.end_ms);
    if (!boundCharacters.has(speaker) || !nameMap[speaker] || !text
      || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= end || end > Number(shot.duration_ms)) {
      fail(DIALOGUE_CODE);
    }
    return { speaker_id: speaker, localized_text: text, start_ms: start, end_ms: end };
  }).sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms || a.speaker_id.localeCompare(b.speaker_id));
  return {
    localized_script_version_id: `shot-${Number(shot.id)}`,
    script_sha256: facts.script_sha256,
    character_name_map_sha256: sha256(stableJson(nameMap)),
    turns: normalized,
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
  const durationMs = Number(shot.duration_ms);
  const coverageReview = normalizeCoverage(input);
  const faces = normalizeFaces(input, durationMs);
  const texts = normalizeTexts(input, durationMs);
  if (faces.length !== coverageReview.mapped_face_count) fail(FACE_CODE);
  if (texts.length !== coverageReview.mapped_text_region_count) fail(TEXT_CODE);
  assertFaceOneToOne(faces);
  assertFullTextCoverage(texts, durationMs);

  const nameMap = parseJson(shot.name_map_json, {});
  const dialogue = verifyDialogue(shot, nameMap, new Set(faces.map((face) => face.source_character_key)));
  const identityEvidence = verifyIdentities(ctx, faces, nameMap);
  const textEvidence = verifyTexts({ ...ctx, sourceFingerprint: shot.source_fingerprint }, texts);
  const faceCoverageSha256 = sha256(stableJson(faces));
  const textCoverageSha256 = sha256(stableJson(texts));
  const motion = await verifyMotionReference({
    ...ctx,
    shotId: ids.shotId,
    assetId: ids.motionId,
    expected: {
      source_asset_id: Number(shot.source_asset_id),
      source_fingerprint: shot.source_fingerprint,
      clip_start_ms: Number(shot.start_ms),
      clip_end_ms: Number(shot.end_ms),
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
    schema_version: SCHEMA_VERSION,
    shot_id: ids.shotId,
    version_id: ctx.versionId,
    duration_ms: durationMs,
    locale: shot.locale,
    market: shot.market,
    source: {
      asset_id: Number(shot.source_asset_id),
      sha256: shot.source_fingerprint,
      clip_start_ms: Number(shot.start_ms),
      clip_end_ms: Number(shot.end_ms),
    },
    name_map: nameMap,
    dialogue: dialogue.turns,
    face_tracks: faces.map((face) => ({
      ...face,
      identity: identityEvidence.find((entry) => entry.redraw_asset_id === face.identity_redraw_asset_id),
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

async function loadCurrentReferenceBundle(rawCtx, shotId) {
  const ctx = normalizeContext(rawCtx);
  const id = Number(shotId);
  const { shot } = getRows(ctx, id);
  const bundle = parseJson(shot.reference_bundle_json, null);
  if (!bundle || bundle.schema_version !== SCHEMA_VERSION || canonicalBundleHash(bundle) !== shot.reference_bundle_hash) fail(NOT_FOUND_CODE);
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
  if (!bundle.coverage_review?.reviewed_at || !bundle.coverage_review?.reviewed_by) fail(DRIFT_CODE);
  const rebuilt = await buildBundle(ctx, input, {
    reviewedAt: bundle.coverage_review.reviewed_at,
    reviewedBy: bundle.coverage_review.reviewed_by,
  });
  if (rebuilt.hash !== shot.reference_bundle_hash || stableJson(rebuilt.bundle) !== stableJson(bundle)) fail(DRIFT_CODE);
  return { shot_id: id, reference_bundle_hash: shot.reference_bundle_hash, bundle };
}

function assertReferenceUrl(value, sourceUrl) {
  if (typeof value !== 'string' || (!value.startsWith('/static/') && !value.startsWith('https://')) || value === sourceUrl) {
    fail(PROJECTION_CODE);
  }
  return value;
}

async function projectReferenceBundleForGeneration(rawCtx, shotId) {
  try {
    const ctx = normalizeContext(rawCtx);
    if (typeof ctx.createReferenceUrl !== 'function') fail(PROJECTION_CODE);
    const loaded = await loadCurrentReferenceBundle(ctx, shotId);
    const bundle = loaded.bundle;
    const { shot } = getRows(ctx, Number(shotId));
    const facts = parseJson(shot.source_facts_json, {});
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
    return {
      referenceImageUrls: [...imageByIdentity.values()],
      referenceVideoUrl,
      identityBindings: bundle.face_tracks.map((face) => ({
        track_key: face.track_key,
        source_character_key: face.source_character_key,
        target_character_name: face.identity.target_character_name,
        target_actor_label: face.identity.target_actor_label,
        reference_image_asset_id: face.identity.artifact.asset_id,
      })),
      referenceBundleSnapshot: {
        schema_version: SCHEMA_VERSION,
        coverage_sha256: bundle.coverage_sha256,
        source_sha256: bundle.source.sha256,
        motion_sha256: bundle.motion_reference.sha256,
        dialogue_script_sha256: facts.script_sha256,
        character_name_map_sha256: sha256(stableJson(bundle.name_map)),
      },
    };
  } catch (_) {
    fail(PROJECTION_CODE);
  }
}

module.exports = {
  saveReferenceBundle,
  loadCurrentReferenceBundle,
  projectReferenceBundleForGeneration,
  canonicalBundleHash,
};
