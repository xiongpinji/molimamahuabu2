'use strict';

const crypto = require('node:crypto');

const { appendWorkflowEvent } = require('./redrawWorkflowEventService');
const { canonicalBundleHash } = require('./redrawReferenceBundleService');

const INPUT_CODE = 'REDRAW_DEPENDENCY_INVALIDATION_INPUT_INVALID';
const NOT_FOUND_CODE = 'REDRAW_DEPENDENCY_INVALIDATION_VERSION_NOT_FOUND';
const CONFLICT_CODE = 'REDRAW_DEPENDENCY_INVALIDATION_CONFLICT';
const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const CHARACTER_DEPENDENCY_KINDS = new Set(['character', 'wardrobe']);
const CHARACTER_REF_KINDS = new Set(['character', 'identity', 'wardrobe']);
const VOICE_REF_KINDS = new Set(['voice', 'dialogue', 'speaker']);
const TEXT_REF_KINDS = new Set(['text', 'text_region', 'text_subtitle', 'text_screen']);

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function fail(code, message = '逐镜依赖失效失败') {
  throw codedError(code, message);
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

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value || '');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function parseJsonStrict(value, fallback, code = CONFLICT_CODE) {
  if (value == null || value === '') return fallback;
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (_) {
    // handled below
  }
  fail(code, 'JSON 证据不合法');
}

function normalizeContext(ctx = {}) {
  if (!ctx.db || typeof ctx.db.prepare !== 'function') fail(INPUT_CODE, '缺少数据库');
  const tenantId = String(ctx.tenantId ?? ctx.tenant_id ?? '').trim();
  const userId = String(ctx.userId ?? ctx.user_id ?? '').trim();
  const versionId = Number(ctx.versionId ?? ctx.version_id);
  if (!tenantId || !userId || !Number.isSafeInteger(versionId) || versionId <= 0) {
    fail(INPUT_CODE, '缺少 owner 或版本');
  }
  return { ...ctx, db: ctx.db, tenantId, userId, versionId };
}

function normalizeReason(input = {}, fallback) {
  const reasonCode = String(input.reason_code ?? input.reasonCode ?? fallback ?? '').trim();
  if (!REASON_CODE.test(reasonCode)) fail(INPUT_CODE, '失效原因不合法');
  return reasonCode;
}

function timestamp(ctx) {
  const value = typeof ctx.now === 'function' ? ctx.now() : ctx.now;
  const date = new Date(value || Date.now());
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function readVersion(ctx) {
  const row = ctx.db.prepare(`
    SELECT v.id, v.work_id, w.project_id
    FROM redraw_versions v
    JOIN redraw_works w
      ON w.id = v.work_id
     AND w.tenant_id = v.tenant_id
     AND w.user_id = v.user_id
     AND w.deleted_at IS NULL
    JOIN redraw_projects p
      ON p.id = w.project_id
     AND p.tenant_id = v.tenant_id
     AND p.user_id = v.user_id
     AND p.deleted_at IS NULL
    WHERE v.id = ? AND v.tenant_id = ? AND v.user_id = ?
      AND v.deleted_at IS NULL
  `).get(ctx.versionId, ctx.tenantId, ctx.userId);
  if (!row) fail(NOT_FOUND_CODE, '本地化版本不存在');
  return row;
}

function readShots(ctx) {
  return ctx.db.prepare(`
    SELECT id, shot_id, references_json, reference_bundle_json, reference_bundle_hash,
           video_generation_id, preparation_state, preparation_version, status, draft_json, updated_at
    FROM redraw_shots
    WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    ORDER BY id ASC
  `).all(ctx.versionId, ctx.tenantId, ctx.userId);
}

function bundleCharacterKeys(bundle) {
  const keys = new Set();
  for (const face of Array.isArray(bundle.face_tracks) ? bundle.face_tracks : []) {
    const value = String(face?.source_character_key || face?.identity?.source_character_key || '').trim();
    if (value) keys.add(value);
  }
  return keys;
}

function bundleSpeakerKeys(bundle) {
  const keys = new Set();
  for (const turn of Array.isArray(bundle.dialogue?.turns) ? bundle.dialogue.turns : []) {
    const value = String(turn?.speaker_id || turn?.source_character_key || '').trim();
    if (value) keys.add(value);
  }
  return keys;
}

function bundleTextKeys(bundle) {
  const keys = new Set();
  for (const text of Array.isArray(bundle.text_regions) ? bundle.text_regions : []) {
    const value = String(text?.region_key || text?.stable_id || '').trim();
    if (value) keys.add(value);
  }
  return keys;
}

function refKind(ref) {
  return String(ref?.kind ?? ref?.type ?? ref?.role ?? '').trim().toLowerCase();
}

function addString(out, value) {
  const normalized = String(value ?? '').trim();
  if (normalized) out.add(normalized);
}

function refsCharacterKeys(references) {
  const keys = new Set();
  for (const ref of Array.isArray(references) ? references : []) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) || !CHARACTER_REF_KINDS.has(refKind(ref))) continue;
    addString(keys, ref.source_character_key ?? ref.sourceCharacterKey ?? ref.character_key ?? ref.characterKey);
  }
  return keys;
}

function refsVoiceKeys(references) {
  const keys = new Set();
  for (const ref of Array.isArray(references) ? references : []) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) || !VOICE_REF_KINDS.has(refKind(ref))) continue;
    addString(keys, ref.source_character_key ?? ref.sourceCharacterKey ?? ref.speaker_id ?? ref.speakerId);
  }
  return keys;
}

function refsTextKeys(references) {
  const keys = new Set();
  for (const ref of Array.isArray(references) ? references : []) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) || !TEXT_REF_KINDS.has(refKind(ref))) continue;
    addString(keys, ref.region_key ?? ref.regionKey ?? ref.text_region_key ?? ref.textRegionKey ?? ref.stable_id);
  }
  return keys;
}

function includesKey(set, key) {
  return set.has(String(key || '').trim());
}

function matchCharacter(shot, sourceCharacterKey, dependencyKind) {
  const bundle = currentReferenceBundle(shot);
  if (!bundle) return false;
  const refs = parseJson(shot.references_json, []);
  const refKeys = dependencyKind === 'voice' ? refsVoiceKeys(refs) : refsCharacterKeys(refs);
  const bundleKeys = dependencyKind === 'voice' ? bundleSpeakerKeys(bundle) : bundleCharacterKeys(bundle);
  if (dependencyKind === 'voice') {
    return includesKey(refKeys, sourceCharacterKey) || includesKey(bundleKeys, sourceCharacterKey);
  }
  return includesKey(refKeys, sourceCharacterKey) || includesKey(bundleKeys, sourceCharacterKey);
}

function matchText(shot, regionKey) {
  const bundle = currentReferenceBundle(shot);
  if (!bundle) return false;
  const refs = parseJson(shot.references_json, []);
  return includesKey(refsTextKeys(refs), regionKey) || includesKey(bundleTextKeys(bundle), regionKey);
}

function currentReferenceBundle(shot) {
  if (!HEX_64.test(String(shot.reference_bundle_hash || ''))) return null;
  const bundle = parseJsonStrict(shot.reference_bundle_json, null);
  if (!bundle || bundle.schema_version !== 'redraw-reference-bundle-v1') fail(CONFLICT_CODE, '当前参考包证据不合法');
  if (canonicalBundleHash(bundle) !== String(shot.reference_bundle_hash || '')) {
    fail(CONFLICT_CODE, '当前参考包证据漂移');
  }
  return bundle;
}

function hasCurrentReferenceBundle(shot) {
  return currentReferenceBundle(shot) != null;
}

function expectedMap(input = {}) {
  const raw = input.expected_updated_at_by_shot_id ?? input.expectedUpdatedAtByShotId ?? null;
  if (raw == null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(INPUT_CODE, 'CAS 输入不合法');
  const mapped = new Map();
  for (const [key, value] of Object.entries(raw)) {
    const id = Number(key);
    if (!Number.isSafeInteger(id) || id <= 0 || !String(value || '').trim()) fail(INPUT_CODE, 'CAS 输入不合法');
    mapped.set(id, String(value));
  }
  return mapped;
}

function assertCas(shots, map) {
  if (!map) return;
  const affectedIds = new Set(shots.map((shot) => Number(shot.id)));
  if (map.size !== affectedIds.size) fail(CONFLICT_CODE, 'CAS 镜头集合不一致');
  for (const id of map.keys()) {
    if (!affectedIds.has(id)) fail(CONFLICT_CODE, 'CAS 镜头集合不一致');
  }
  for (const shot of shots) {
    if (String(shot.updated_at || '') !== map.get(Number(shot.id))) {
      fail(CONFLICT_CODE, '镜头已被其他操作更新');
    }
  }
}

function resetDraftGeneration(shot) {
  const draft = parseJsonStrict(shot.draft_json, {});
  draft.generation = {};
  return stableJson(draft);
}

function updateAffected(ctx, version, affected, dependencyKind, dependencyId, reasonCode, now) {
  const nextDraftById = new Map(affected.map((shot) => [Number(shot.id), resetDraftGeneration(shot)]));
  for (const shot of affected) {
    const nextDraft = nextDraftById.get(Number(shot.id));
    const nextVersion = Number(shot.preparation_version || 0) + 1;
    const evidence = sha256(stableJson({
      version_id: ctx.versionId,
      shot_id: Number(shot.id),
      dependency_kind: dependencyKind,
      dependency_id: dependencyId,
      reason_code: reasonCode,
      old_bundle_hash: shot.reference_bundle_hash || null,
      old_generation_id: shot.video_generation_id == null ? null : Number(shot.video_generation_id),
      previous_preparation_version: Number(shot.preparation_version || 0),
    }));
    const updated = ctx.db.prepare(`
      UPDATE redraw_shots
      SET preparation_state = 'stale',
          preparation_version = ?,
          preparation_evidence_hash = ?,
          stale_reason_code = ?,
          status = 'pending',
          error_code = NULL,
          error_message = NULL,
          reference_bundle_hash = NULL,
          reference_bundle_updated_at = NULL,
          video_generation_id = NULL,
          draft_json = ?,
          updated_at = ?
      WHERE id = ? AND version_id = ? AND tenant_id = ? AND user_id = ?
        AND updated_at = ? AND deleted_at IS NULL
    `).run(
      nextVersion,
      evidence,
      reasonCode,
      nextDraft,
      now,
      Number(shot.id),
      ctx.versionId,
      ctx.tenantId,
      ctx.userId,
      String(shot.updated_at || ''),
    );
    if (updated.changes !== 1) fail(CONFLICT_CODE, '镜头已被其他操作更新');
    appendWorkflowEvent(ctx.db, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      projectId: Number(version.project_id),
      resourceType: 'shot',
      resourceId: String(shot.id),
      fromState: shot.preparation_state || null,
      toState: 'stale',
      reasonCode,
      evidenceHash: evidence,
      createdAt: now,
      metadata: {
        dependency_kind: dependencyKind,
        dependency_id: dependencyId,
        old_bundle_hash: shot.reference_bundle_hash || null,
        old_generation_id: shot.video_generation_id == null ? null : Number(shot.video_generation_id),
        previous_preparation_version: Number(shot.preparation_version || 0),
      },
    });
  }
  return affected.map((shot) => Number(shot.id));
}

function runInvalidation(ctx, input, dependencyKind, dependencyId, reasonCode, matcher) {
  const execute = () => {
    const version = readVersion(ctx);
    const affected = readShots(ctx)
      .filter(matcher)
      .sort((a, b) => Number(a.id) - Number(b.id));
    const cas = expectedMap(input);
    assertCas(affected, cas);
    if (affected.some((shot) => String(shot.status || '') === 'processing')) {
      fail(CONFLICT_CODE, '镜头正在生成中');
    }
    if (affected.length === 0) return [];
    return updateAffected(ctx, version, affected, dependencyKind, dependencyId, reasonCode, timestamp(ctx));
  };
  if (ctx.db.inTransaction) return execute();
  let begun = false;
  try {
    ctx.db.exec('BEGIN IMMEDIATE');
    begun = true;
    const affected = execute();
    ctx.db.exec('COMMIT');
    begun = false;
    return affected;
  } catch (error) {
    if (begun) {
      try {
        ctx.db.exec('ROLLBACK');
      } catch (_) {
        // ignore rollback errors after original failure
      }
    }
    throw error;
  }
}

function invalidateCharacterDependents(rawCtx, input = {}) {
  const ctx = normalizeContext(rawCtx);
  const sourceKey = String(input.source_character_key ?? input.sourceCharacterKey ?? '').trim();
  if (!sourceKey) fail(INPUT_CODE, '缺少角色来源 key');
  const dependencyKind = String(input.dependency_kind ?? input.dependencyKind ?? 'character').trim() || 'character';
  if (!CHARACTER_DEPENDENCY_KINDS.has(dependencyKind)) fail(INPUT_CODE, '角色依赖类型不合法');
  const reasonCode = normalizeReason(input, dependencyKind === 'wardrobe' ? 'character_wardrobe_changed' : 'character_identity_changed');
  return runInvalidation(
    ctx,
    input,
    dependencyKind,
    sourceKey,
    reasonCode,
    (shot) => matchCharacter(shot, sourceKey, dependencyKind),
  );
}

function invalidateDialogueDependents(rawCtx, input = {}) {
  const ctx = normalizeContext(rawCtx);
  const sourceKey = String(input.source_character_key ?? input.sourceCharacterKey ?? input.speaker_id ?? input.speakerId ?? '').trim();
  if (!sourceKey) fail(INPUT_CODE, '缺少声音角色 key');
  const dependencyKind = String(input.dependency_kind ?? input.dependencyKind ?? 'voice').trim() || 'voice';
  if (dependencyKind !== 'voice') fail(INPUT_CODE, '声音依赖类型不合法');
  const reasonCode = normalizeReason(input, 'voice_changed');
  return runInvalidation(
    ctx,
    input,
    dependencyKind,
    sourceKey,
    reasonCode,
    (shot) => matchCharacter(shot, sourceKey, dependencyKind),
  );
}

function invalidateTextDependents(rawCtx, input = {}) {
  const ctx = normalizeContext(rawCtx);
  const regionKey = String(input.region_key ?? input.regionKey ?? input.text_region_key ?? input.textRegionKey ?? '').trim();
  if (!regionKey) fail(INPUT_CODE, '缺少文字区域 key');
  const reasonCode = normalizeReason(input, 'text_region_changed');
  return runInvalidation(
    ctx,
    input,
    'text',
    regionKey,
    reasonCode,
    (shot) => matchText(shot, regionKey),
  );
}

function invalidateShotTimingDependents(rawCtx, input = {}) {
  const ctx = normalizeContext(rawCtx);
  const shotId = Number(input.shot_id ?? input.shotId ?? input.id);
  if (!Number.isSafeInteger(shotId) || shotId <= 0) fail(INPUT_CODE, '缺少镜头 ID');
  const reasonCode = normalizeReason(input, 'shot_timing_changed');
  return runInvalidation(
    ctx,
    input,
    'shot_timing',
    String(shotId),
    reasonCode,
    (shot) => Number(shot.id) === shotId && hasCurrentReferenceBundle(shot),
  );
}

module.exports = {
  invalidateCharacterDependents,
  invalidateDialogueDependents,
  invalidateTextDependents,
  invalidateShotTimingDependents,
};
