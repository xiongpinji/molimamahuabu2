const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { segmentId } = require('./redrawEvidenceFusionService');
const { normalizeDialogueSourceCorrection } = require('./redrawEpisodeBlueprintService');
const { validatePersistedSourceAudioV2, createVerifiedSourceAudioContext } = require('./redrawSourceAudioEvidenceService');

const AUDIO_KINDS = new Set(['asr', 'audio', 'audio_transcript', 'transcript']);
const SCHEMA_VERSION = 'redraw-source-audio-evidence-v1';
const V2_SCHEMA_VERSION = 'redraw-source-audio-evidence-v2';
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isId = (value) => typeof value === 'string' && /^[a-zA-Z0-9._-]{1,96}$/.test(value);
const isSha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const isProbability = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const validText = (value, limit) => typeof value === 'string' && Boolean(value.trim()) && value.length <= limit && !value.includes('\0');

function fail(reason) {
  throw new Error(`SOURCE_DIALOGUE_${reason}`);
}

function assetId(value) {
  if (isPositiveInteger(value)) return value;
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && isPositiveInteger(Number(value))) return Number(value);
  fail('ASSET_INVALID');
}

function rangeValid(value, duration, precise = false) {
  const validTime = precise ? Number.isFinite : Number.isSafeInteger;
  return isObject(value) && validTime(value.start_ms) && value.start_ms >= 0
    && validTime(value.end_ms) && value.end_ms > value.start_ms && value.end_ms <= duration;
}

function metadataObject(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (isObject(parsed)) return parsed;
  } catch { /* Reject invalid metadata without exposing its contents. */ }
  fail('ASSET_INVALID');
}

function samePath(left, right) {
  return path.relative(left, right) === '';
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function readEvidenceBuffer(storageRoot, localPath) {
  let descriptor;
  try {
    if (typeof storageRoot !== 'string' || !path.isAbsolute(storageRoot)
      || typeof localPath !== 'string' || !localPath || path.isAbsolute(localPath)) fail('PATH_INVALID');
    const root = path.resolve(storageRoot);
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || !samePath(root, fs.realpathSync.native(root))) fail('PATH_INVALID');
    const target = path.resolve(root, localPath);
    if (!contained(root, target)) fail('PATH_INVALID');
    const parts = path.relative(root, target).split(path.sep);
    let current = root;
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) fail('PATH_INVALID');
    }
    if (!samePath(target, fs.realpathSync.native(target))) fail('PATH_INVALID');
    const before = fs.lstatSync(target);
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !sameFile(before, opened)
      || !samePath(target, fs.realpathSync.native(target))) fail('PATH_INVALID');
    const buffer = fs.readFileSync(descriptor);
    const after = fs.lstatSync(target);
    if (after.isSymbolicLink() || !sameFile(opened, after) || !sameFile(opened, fs.fstatSync(descriptor))
      || buffer.length !== opened.size || !samePath(target, fs.realpathSync.native(target))) fail('PATH_INVALID');
    return buffer;
  } catch {
    fail('FILE_UNAVAILABLE');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function validateEvidence(evidence, metadata, binding) {
  if (!isObject(evidence) || ![SCHEMA_VERSION, V2_SCHEMA_VERSION].includes(evidence.schema_version)
    || evidence.schema_version !== metadata.schema_version
    || evidence.tenant_id !== binding.tenantId || evidence.user_id !== binding.userId
    || evidence.work_id !== binding.workId || evidence.source_asset_id !== binding.sourceId
    || evidence.source_video_sha256 !== binding.sourceSha
    || !validText(evidence.task_id, 128) || !Number.isFinite(Date.parse(evidence.created_at))
    || !isSha(evidence.transcript_sha256) || evidence.transcript_sha256 !== metadata.transcript_sha256
    || evidence.audio_sha256 !== metadata.audio_sha256
    || !['spoken', 'silent'].includes(evidence.dialogue_mode)
    || !Array.isArray(evidence.segments) || evidence.segments.length > 4096) fail('EVIDENCE_INVALID');
  if (evidence.schema_version === V2_SCHEMA_VERSION) {
    validatePersistedSourceAudioV2(evidence);
    if (evidence.segments.some(segment => !rangeValid(segment, binding.duration, true))) fail('EVIDENCE_INVALID');
    return;
  }
  if (evidence.dialogue_mode === 'silent') {
    if (evidence.segments.length !== 0) fail('EVIDENCE_INVALID');
    return;
  }
  if (!isSha(evidence.audio_sha256) || !validText(evidence.source_language, 128)
    || !isProbability(evidence.language_probability) || evidence.segments.length === 0) fail('EVIDENCE_INVALID');
  let previousEnd = 0;
  for (const segment of evidence.segments) {
    if (!rangeValid(segment, binding.duration) || segment.start_ms < previousEnd
      || !validText(segment.source_text, 16384)
      || !/^speaker-cluster-[1-9][0-9]*$/.test(segment.speaker_cluster_id)
      || (segment.id != null && !isId(segment.id))
      || (segment.evidence_ref != null && !isId(segment.evidence_ref))
      || (segment.confidence !== undefined && !isProbability(segment.confidence))) fail('EVIDENCE_INVALID');
    previousEnd = segment.end_ms;
  }
}

function loadEvidence(ctx, manifest, binding) {
  const id = assetId(manifest.asset_id);
  const asset = ctx.db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!asset || asset.type !== 'json' || asset.category !== 'redraw_source_audio_evidence') fail('ASSET_INVALID');
  const metadata = metadataObject(asset.metadata);
  if (![SCHEMA_VERSION, V2_SCHEMA_VERSION].includes(metadata.schema_version) || metadata.tenant_id !== binding.tenantId
    || metadata.user_id !== binding.userId || metadata.work_id !== binding.workId
    || metadata.source_asset_id !== binding.sourceId || metadata.source_video_sha256 !== binding.sourceSha
    || metadata.evidence_sha256 !== manifest.sha256) fail('ASSET_BINDING_MISMATCH');
  const buffer = readEvidenceBuffer(ctx.storageRoot, asset.local_path);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (sha256 !== manifest.sha256) fail('EVIDENCE_HASH_MISMATCH');
  let evidence;
  try { evidence = JSON.parse(buffer.toString('utf8')); } catch { fail('EVIDENCE_INVALID'); }
  validateEvidence(evidence, metadata, binding);
  return { evidence, sha256 };
}

function audioManifestIndex(blueprint) {
  const items = blueprint.evidence_manifest?.items ?? [];
  if (!Array.isArray(items)) fail('MANIFEST_INVALID');
  const manifests = new Map();
  for (const item of items) {
    if (!isObject(item) || !isId(item.id) || !isId(item.kind) || !isSha(item.sha256)
      || manifests.has(item.id)) fail('MANIFEST_INVALID');
    manifests.set(item.id, item);
  }
  return manifests;
}

function blueprintAudioBinding(ctx, workId, source, work) {
  if (!ctx.db || !validText(ctx.tenantId, 128) || !validText(ctx.userId, 128)) fail('WORK_NOT_FOUND');
  const ownedWorkId = assetId(workId);
  const ownedWork = work || ctx.db.prepare(`SELECT source_asset_id, source_fingerprint, duration_ms FROM redraw_works
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL`)
    .get(ownedWorkId, ctx.tenantId, ctx.userId);
  if (!ownedWork) fail('WORK_NOT_FOUND');
  if (!isObject(source) || assetId(ownedWork.source_asset_id) !== assetId(source.asset_id)
    || !isSha(ownedWork.source_fingerprint) || source.sha256 !== ownedWork.source_fingerprint
    || !isPositiveInteger(source.duration_ms) || ownedWork.duration_ms !== source.duration_ms) fail('SOURCE_BINDING_MISMATCH');
  return { workId: ownedWorkId, tenantId: ctx.tenantId, userId: ctx.userId,
    sourceId: assetId(source.asset_id), sourceSha: source.sha256, duration: source.duration_ms };
}

function loadVerifiedBlueprintAudioContext(ctx, { workId, blueprint }) {
  const entries = [];
  const items = blueprint?.evidence_manifest?.items;
  if (!Array.isArray(items)) return createVerifiedSourceAudioContext(entries);
  let binding;
  for (const manifest of items) {
    let id;
    try { id = assetId(manifest.asset_id); } catch { continue; }
    let asset;
    try {
      asset = ctx.db.prepare('SELECT metadata FROM assets WHERE id = ?').get(id);
    } catch (error) {
      if (error?.code === 'SQLITE_ERROR' && error.message === 'no such table: assets') continue;
      throw error;
    }
    if (!asset) continue;
    let metadata;
    try { metadata = metadataObject(asset.metadata); } catch (error) {
      if (AUDIO_KINDS.has(manifest?.kind)) throw error;
      continue;
    }
    // Historical v1 drafts retain their optional asset-loading behavior and never gain precision.
    if (metadata.schema_version !== V2_SCHEMA_VERSION) continue;
    // The stored asset decides its evidence type; a client label cannot downgrade v2 to subtitles.
    if (!AUDIO_KINDS.has(manifest?.kind)) fail('REFERENCE_INVALID');
    binding ||= blueprintAudioBinding(ctx, workId, blueprint.source);
    const loaded = loadEvidence(ctx, manifest, binding);
    entries.push([manifest.id, { assetId: id, sha256: loaded.sha256,
      schemaVersion: V2_SCHEMA_VERSION, evidence: loaded.evidence }]);
  }
  return createVerifiedSourceAudioContext(entries);
}

function assertBlueprintBoundarySources(ctx, { workId, blueprint }) {
  const shots = blueprint.shots.filter((shot) => shot.manual_boundary === true);
  if (shots.length === 0) return;
  const sources = resolveBlueprintDialogueSources(ctx, { workId, blueprint });
  const resolved = new Set(sources.filter((source) => source.status === 'resolved')
    .map((source) => `${source.shot_id}:${source.dialogue_id}`));
  if (shots.some((shot) => shot.dialogue.some((turn) => !resolved.has(`${shot.id}:${turn.id}`)))) {
    fail('BOUNDARY_EVIDENCE_INVALID');
  }
  const silentShots = shots.filter((shot) => shot.dialogue.length === 0);
  if (silentShots.length === 0) return;
  const manifests = audioManifestIndex(blueprint);
  const binding = blueprintAudioBinding(ctx, workId, blueprint.source);
  const evidenceByRef = new Map();
  for (const shot of silentShots) {
    if (!rangeValid(shot, binding.duration)) fail('PROJECTION_INVALID');
    const refs = shot.evidence_refs.filter((ref) => AUDIO_KINDS.has(manifests.get(ref)?.kind));
    if (refs.length !== 1) fail('REFERENCE_INVALID');
    const ref = refs[0];
    if (!evidenceByRef.has(ref)) evidenceByRef.set(ref, loadEvidence(ctx, manifests.get(ref), binding));
    const { evidence, sha256 } = evidenceByRef.get(ref);
    if (evidence.dialogue_mode === 'spoken') {
      // Empty dialogue means no sentence is assigned here, not that neighboring whole speech cannot overlap.
      for (const segment of evidence.segments.filter((item) => item.start_ms < shot.end_ms && item.end_ms > shot.start_ms)) {
        const segmentRef = evidence.schema_version === V2_SCHEMA_VERSION ? ref : segment.evidence_ref || ref;
        const originalId = segmentId(segment, segmentRef, evidence.source_language);
        const matches = sources.filter((source) => source.dialogue_id === originalId && source.status === 'resolved'
          && source.evidence_ref === segmentRef && source.evidence_sha256 === sha256
          && (source.original_start_ms ?? source.source_start_ms) === segment.start_ms
          && (source.original_end_ms ?? source.source_end_ms) === segment.end_ms);
        if (matches.length !== 1) fail('BOUNDARY_SPEECH_UNASSIGNED');
      }
      continue;
    }
    if (evidence.transcript_sha256 !== crypto.createHash('sha256').update('[]').digest('hex')
      || evidence.source_language !== null || evidence.language_probability !== null) fail('EVIDENCE_INVALID');
    if (evidence.schema_version === V2_SCHEMA_VERSION) {
      // Revalidation above proved every window's VAD and gap-free committed coverage.
      if (evidence.coverage.expected_duration_ms < shot.end_ms) fail('EVIDENCE_INVALID');
      continue;
    }
    if (evidence.audio_sha256 === null) {
      if (Object.hasOwn(evidence, 'no_speech_evidence')) fail('EVIDENCE_INVALID');
      continue;
    }
    const vad = evidence.no_speech_evidence;
    if (!isSha(evidence.audio_sha256) || !isObject(vad)
      || Object.keys(vad).sort().join(',') !== 'audio_duration_ms,method,speech_duration_ms'
      || vad.method !== 'faster-whisper-vad' || vad.speech_duration_ms !== 0
      || !Number.isSafeInteger(vad.audio_duration_ms) || vad.audio_duration_ms < binding.duration) fail('EVIDENCE_INVALID');
  }
}

function resolveBlueprintDialogueSources(ctx = {}, { workId, blueprint } = {}) {
  const entries = (Array.isArray(blueprint?.shots) ? blueprint.shots : [])
    .flatMap((shot) => (Array.isArray(shot?.dialogue) ? shot.dialogue : []).map((turn) => ({ shot, turn })));
  if (entries.length === 0) return [];
  const result = ({ shot, turn }, status, reason) => ({
    dialogue_id: isId(turn?.id) ? turn.id : null,
    shot_id: isId(shot?.id) ? shot.id : null,
    status, reason,
  });
  let binding;
  let requiresAudio;
  let manifests;
  try {
    if (!ctx.db || !validText(ctx.tenantId, 128) || !validText(ctx.userId, 128)) fail('WORK_NOT_FOUND');
    const ownedWorkId = assetId(workId);
    const work = ctx.db.prepare(`SELECT source_asset_id, source_fingerprint, duration_ms FROM redraw_works
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL`)
      .get(ownedWorkId, ctx.tenantId, ctx.userId);
    if (!work) fail('WORK_NOT_FOUND');
    manifests = audioManifestIndex(blueprint);
    // Historical registration prevents draft edits (or soft deletion) from turning ASR into a manual fallback.
    let registered;
    try {
      registered = ctx.db.prepare(`SELECT 1 FROM assets
        WHERE category = 'redraw_source_audio_evidence' AND CASE WHEN json_valid(metadata) THEN
          json_extract(metadata, '$.tenant_id') = ? AND json_extract(metadata, '$.user_id') = ?
          AND json_extract(metadata, '$.work_id') = ? AND json_extract(metadata, '$.source_asset_id') = ?
        ELSE 0 END LIMIT 1`).get(ctx.tenantId, ctx.userId, ownedWorkId, work.source_asset_id);
    } catch (error) {
      if (error?.code !== 'SQLITE_ERROR' || error.message !== 'no such table: assets') throw error;
    }
    requiresAudio = Boolean(registered) || [...manifests.values()].some((item) => AUDIO_KINDS.has(item.kind))
      || entries.some(({ turn }) => (isObject(turn) && 'source_correction' in turn)
        || (typeof turn?.id === 'string' && turn.id.startsWith('audio-segment-')));
    if (requiresAudio) {
      binding = blueprintAudioBinding(ctx, ownedWorkId, blueprint?.source, work);
    }
  } catch (error) {
    return entries.map((entry) => result(entry, 'unresolved', reasonOf(error)));
  }
  const idCounts = new Map();
  for (const { turn } of entries) idCounts.set(turn?.id, (idCounts.get(turn?.id) || 0) + 1);
  const assets = new Map();
  const segmentsByRef = new Map();
  const contextsByRef = new Map();
  return entries.map((entry) => {
    const { shot, turn } = entry;
    try {
      if (!isId(turn?.id) || !isId(shot.id) || idCounts.get(turn.id) !== 1) fail('DIALOGUE_INVALID');
      if (!requiresAudio) return result(entry, 'not_available', 'SOURCE_DIALOGUE_EVIDENCE_NOT_AVAILABLE');
      const refs = turn.evidence_refs;
      if (!Array.isArray(refs) || refs.some((ref) => !isId(ref) || !manifests.has(ref))
        || new Set(refs).size !== refs.length) fail('REFERENCE_INVALID');
      const audioRefs = refs.filter((ref) => AUDIO_KINDS.has(manifests.get(ref).kind));
      if (audioRefs.length !== 1) fail('REFERENCE_INVALID');
      if (!rangeValid(shot, binding.duration)) fail('PROJECTION_INVALID');
      const ref = audioRefs[0];
      const manifest = manifests.get(ref);
      const id = assetId(manifest.asset_id);
      if (!assets.has(id)) {
        try { assets.set(id, loadEvidence(ctx, manifest, binding)); }
        catch (error) { assets.set(id, { reason: reasonOf(error) }); }
      }
      const loaded = assets.get(id);
      if (loaded.reason) return result(entry, 'unresolved', loaded.reason);
      if (loaded.sha256 !== manifest.sha256) fail('EVIDENCE_HASH_MISMATCH');
      const isV2 = loaded.evidence.schema_version === V2_SCHEMA_VERSION;
      if (!rangeValid(turn, binding.duration, isV2)) fail('PROJECTION_INVALID');
      if (!segmentsByRef.has(ref)) {
        const byId = new Map();
        for (const segment of loaded.evidence.segments) {
          const segmentRef = isV2 ? ref : segment.evidence_ref || ref;
          const originalId = segmentId(segment, segmentRef, loaded.evidence.source_language);
          if (byId.has(originalId)) fail('SEGMENT_AMBIGUOUS');
          byId.set(originalId, { segment, ref: segmentRef });
        }
        segmentsByRef.set(ref, byId);
      }
      const match = segmentsByRef.get(ref).get(turn.id);
      if (!match || match.ref !== ref) fail('SEGMENT_NOT_FOUND');
      const original = match.segment;
      if (isV2 && 'source_correction' in turn && !contextsByRef.has(ref)) {
        contextsByRef.set(ref, createVerifiedSourceAudioContext([[ref,
          { assetId: id, sha256: loaded.sha256, schemaVersion: V2_SCHEMA_VERSION, evidence: loaded.evidence }]]));
      }
      const audioContext = contextsByRef.get(ref);
      const correction = 'source_correction' in turn
        ? normalizeDialogueSourceCorrection(turn, shot, manifests, binding.duration, audioContext) : null;
      const schemaMarker = isV2 ? { audio_evidence_schema_version: V2_SCHEMA_VERSION } : {};
      if (correction) {
        if (correction.evidence_ref !== ref || correction.evidence_sha256 !== loaded.sha256
          || correction.original_source_text !== original.source_text.trim()
          || correction.original_start_ms !== original.start_ms || correction.original_end_ms !== original.end_ms
          || turn.source_language !== loaded.evidence.source_language.trim()
          || !validText(turn.source_text, 500)) fail('CORRECTION_MISMATCH');
        return { ...result(entry, 'resolved', 'SOURCE_DIALOGUE_MANUAL_CORRECTION_RESOLVED'),
          source_origin: 'manual_correction', original_source_text: original.source_text.trim(),
          original_start_ms: original.start_ms, original_end_ms: original.end_ms,
          source_start_ms: correction.source_start_ms, source_end_ms: correction.source_end_ms,
          source_text: turn.source_text, source_language: loaded.evidence.source_language.trim(),
          projection_start_ms: turn.start_ms, projection_end_ms: turn.end_ms,
          cross_shot: correction.source_start_ms < shot.start_ms || correction.source_end_ms > shot.end_ms,
          evidence_ref: ref, evidence_sha256: loaded.sha256, ...schemaMarker };
      }
      if (turn.source_text !== original.source_text.trim()
        || turn.source_language !== loaded.evidence.source_language.trim()) fail('CONTENT_MISMATCH');
      const start = Math.max(original.start_ms, shot.start_ms);
      const end = Math.min(original.end_ms, shot.end_ms);
      if (start >= end || turn.start_ms !== start || turn.end_ms !== end) fail('PROJECTION_MISMATCH');
      return { ...result(entry, 'resolved', 'SOURCE_DIALOGUE_RESOLVED'),
        source_start_ms: original.start_ms, source_end_ms: original.end_ms,
        source_text: original.source_text.trim(), source_language: loaded.evidence.source_language.trim(),
        projection_start_ms: turn.start_ms, projection_end_ms: turn.end_ms,
        cross_shot: original.start_ms < shot.start_ms || original.end_ms > shot.end_ms,
        evidence_ref: ref, evidence_sha256: loaded.sha256, ...schemaMarker };
    } catch (error) {
      return result(entry, 'unresolved', reasonOf(error));
    }
  });
}

function reasonOf(error) {
  return /^SOURCE_DIALOGUE_[A-Z_]+$/.test(error?.message) ? error.message : 'SOURCE_DIALOGUE_EVIDENCE_INVALID';
}

module.exports = { resolveBlueprintDialogueSources, assertBlueprintBoundarySources, loadVerifiedBlueprintAudioContext };
