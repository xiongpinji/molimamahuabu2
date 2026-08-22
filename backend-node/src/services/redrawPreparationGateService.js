'use strict';

const crypto = require('node:crypto');

const { buildCharacterPlan } = require('./redrawCharacterPlanService');
const { canonicalBundleHash } = require('./redrawReferenceBundleService');

const HEX_64 = /^[0-9a-f]{64}$/;

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

function parseJsonStrict(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const parsed = JSON.parse(value || '');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid json');
  return parsed;
}

function parseJson(value) {
  try {
    return parseJsonStrict(value);
  } catch (_) {
    return null;
  }
}

function parseJsonAny(value, fallback = null) {
  try {
    if (value && typeof value === 'object') return value;
    return JSON.parse(value || '');
  } catch (_) {
    return fallback;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasTable(db, table) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return Boolean(row);
}

function validRanges(value, durationMs) {
  return Array.isArray(value) && value.length > 0 && value.every((range) => (
    Array.isArray(range)
    && range.length === 2
    && Number.isInteger(Number(range[0]))
    && Number.isInteger(Number(range[1]))
    && Number(range[0]) >= 0
    && Number(range[0]) < Number(range[1])
    && Number(range[1]) <= Number(durationMs)
  ));
}

function normalizeOwner(input = {}) {
  return {
    tenantId: String(input.tenantId ?? input.tenant_id ?? '').trim(),
    userId: String(input.userId ?? input.user_id ?? '').trim(),
  };
}

function missingItem(resourceType, resourceId, reasonCode, anchor) {
  return {
    resource_type: String(resourceType),
    resource_id: String(resourceId),
    reason_code: String(reasonCode),
    anchor: String(anchor),
  };
}

function addMissing(items, resourceType, resourceId, reasonCode, anchor) {
  items.set(stableJson(missingItem(resourceType, resourceId, reasonCode, anchor)), missingItem(
    resourceType,
    resourceId,
    reasonCode,
    anchor,
  ));
}

function sortedMissing(items) {
  return [...items.values()].sort((left, right) => (
    left.resource_type.localeCompare(right.resource_type)
    || left.resource_id.localeCompare(right.resource_id, undefined, { numeric: true })
    || left.reason_code.localeCompare(right.reason_code)
    || left.anchor.localeCompare(right.anchor)
  ));
}

function expectedPreparationHash(shot) {
  return sha256(stableJson({
    version_id: Number(shot.version_id),
    shot_id: Number(shot.id),
    preparation_version: Number(shot.preparation_version),
    reference_bundle_hash: shot.reference_bundle_hash,
  }));
}

function findVersion(db, versionId, owner) {
  const version = db.prepare(`
    SELECT * FROM redraw_versions
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(Number(versionId), owner.tenantId, owner.userId);
  return version || null;
}

function readPlan(ctx, versionId, missing) {
  try {
    const plan = buildCharacterPlan(ctx, versionId);
    if (!plan.ready) {
      addMissing(missing, 'character_plan', versionId, 'character_plan_not_ready', `version-${Number(versionId)}-character-plan`);
    }
    const characters = new Map();
    for (const character of Array.isArray(plan.characters) ? plan.characters : []) {
      if (!isPlainObject(character)) continue;
      const sourceKey = String(character.source_character_key || '').trim();
      const packHash = String(character.identity_pack_sha256 || '').trim();
      if (sourceKey && HEX_64.test(packHash)) characters.set(sourceKey, { sourceKey, packHash });
    }
    return {
      hash: HEX_64.test(String(plan.plan_hash || '')) ? plan.plan_hash : '',
      characters,
    };
  } catch (_) {
    addMissing(missing, 'character_plan', versionId, 'character_plan_not_ready', `version-${Number(versionId)}-character-plan`);
    return { hash: '', characters: new Map() };
  }
}

function identityPackHash(pack) {
  if (!isPlainObject(pack)) return '';
  const hash = String(pack.pack_sha256 || '').trim();
  return HEX_64.test(hash) ? hash : '';
}

function textPackHash(pack) {
  if (!isPlainObject(pack)) return '';
  const hash = String(pack.pack_sha256 || '').trim();
  const { pack_sha256: _ignored, ...rest } = pack;
  return HEX_64.test(hash) && sha256(stableJson(rest)) === hash ? hash : '';
}

function sourceKeyFromPayload(payload) {
  const ref = isPlainObject(payload?.source_ref) ? payload.source_ref : {};
  return String(ref.source_character_key || ref.stable_id || ref.id || '').trim();
}

function loadCharacterRow(ctx, shot, face) {
  return ctx.db.prepare(`
    SELECT *
    FROM redraw_assets
    WHERE id = ? AND version_id = ? AND tenant_id = ? AND user_id = ?
      AND kind = 'character' AND deleted_at IS NULL
    LIMIT 1
  `).get(
    Number(face.identity_redraw_asset_id),
    Number(shot.version_id),
    String(shot.tenant_id || ''),
    String(shot.user_id || ''),
  ) || null;
}

function validateFace(ctx, shot, face, plan) {
  if (!isPlainObject(face)) return false;
  const sourceKey = String(face.source_character_key || '').trim();
  const packHash = String(face.identity_pack_sha256 || '').trim();
  const rowId = Number(face.identity_redraw_asset_id);
  if (!String(face.track_key || '').trim()
    || !sourceKey
    || !Number.isSafeInteger(rowId)
    || rowId <= 0
    || !HEX_64.test(packHash)
    || !validRanges(face.time_ranges, shot.duration_ms)) return false;
  const expected = plan.characters.get(sourceKey);
  if (!expected || expected.packHash !== packHash) return false;
  const row = loadCharacterRow(ctx, shot, face);
  if (!row || row.approval_status !== 'approved' || row.status !== 'generated') return false;
  const payload = parseJsonAny(row.source_ref_json, {});
  const pack = isPlainObject(payload?.identity_pack) ? payload.identity_pack : null;
  return sourceKeyFromPayload(payload) === sourceKey
    && identityPackHash(pack) === packHash
    && String(pack.source_character_key || '').trim() === sourceKey
    && Number(row.asset_id || 0) === Number(pack.artifact?.asset_id || 0);
}

function loadTextRow(ctx, shot, text) {
  return ctx.db.prepare(`
    SELECT *
    FROM redraw_assets
    WHERE id = ? AND version_id = ? AND tenant_id = ? AND user_id = ?
      AND kind = 'scene' AND deleted_at IS NULL
    LIMIT 1
  `).get(
    Number(text.text_clean_redraw_asset_id),
    Number(shot.version_id),
    String(shot.tenant_id || ''),
    String(shot.user_id || ''),
  ) || null;
}

function validateText(ctx, shot, text) {
  if (!isPlainObject(text)) return false;
  const regionKey = String(text.region_key || '').trim();
  const kind = String(text.kind || '').trim();
  const rowId = Number(text.text_clean_redraw_asset_id);
  if (!regionKey
    || !['text_subtitle', 'text_screen'].includes(kind)
    || !Number.isSafeInteger(rowId)
    || rowId <= 0
    || !validRanges(text.time_ranges, shot.duration_ms)) return false;
  const row = loadTextRow(ctx, shot, text);
  if (!row || row.approval_status !== 'approved' || row.status !== 'generated' || !Number(row.clean_plate_asset_id || 0)) return false;
  const payload = parseJsonAny(row.source_ref_json, {});
  const pack = isPlainObject(payload?.text_clean_plate_pack) ? payload.text_clean_plate_pack : null;
  const expectedHash = String(text.clean_plate?.pack_sha256 || text.pack_sha256 || pack?.pack_sha256 || '').trim();
  return sourceKeyFromPayload(payload) === regionKey
    && payload.source_ref?.kind === kind
    && payload.snapshot?.mode === 'text_clean_plate'
    && isPlainObject(pack)
    && pack.schema_version === 'text-clean-plate-reference-v1'
    && pack.region_key === regionKey
    && pack.kind === kind
    && pack.ready === true
    && textPackHash(pack)
    && (!expectedHash || expectedHash === pack.pack_sha256)
    && Number(pack.artifact?.asset_id || 0) === Number(row.clean_plate_asset_id || 0)
    && HEX_64.test(String(pack.artifact?.sha256 || ''));
}

function assetSha(asset) {
  const metadata = parseJsonAny(asset?.metadata, {});
  return String(metadata?.sha256 || asset?.sha256 || '').trim();
}

function validateMotion(ctx, shot, motion) {
  if (!isPlainObject(motion)) return false;
  const assetId = Number(motion.asset_id);
  const expectedSha = String(motion.sha256 || '').trim();
  if (!Number.isSafeInteger(assetId) || assetId <= 0 || !HEX_64.test(expectedSha)) return false;
  const row = ctx.db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL LIMIT 1').get(assetId);
  if (!row || String(row.type || '') !== 'video' || !String(row.mime_type || '').startsWith('video/')) return false;
  if (assetSha(row) !== expectedSha) return false;
  if (row.drama_id != null && hasTable(ctx.db, 'dramas')) {
    const drama = ctx.db.prepare('SELECT tenant_id, user_id FROM dramas WHERE id = ? LIMIT 1').get(Number(row.drama_id));
    if (drama && (String(drama.tenant_id || '') !== String(shot.tenant_id || '')
      || String(drama.user_id || '') !== String(shot.user_id || ''))) return false;
  } else if (ctx.assetReader && typeof ctx.assetReader.owns === 'function' && !ctx.assetReader.owns(row, shot)) {
    return false;
  }
  return true;
}

function validateBundleShape(ctx, shot, bundle, plan, missing) {
  const shotAnchor = `shot-${Number(shot.id)}`;
  if (Number(bundle.version_id) !== Number(shot.version_id)) {
    addMissing(missing, 'reference_bundle', shot.id, 'bundle_version_mismatch', shotAnchor);
  }
  if (Number(bundle.shot_id) !== Number(shot.id)) {
    addMissing(missing, 'reference_bundle', shot.id, 'bundle_shot_mismatch', shotAnchor);
  }
  const review = bundle.coverage_review && typeof bundle.coverage_review === 'object' ? bundle.coverage_review : {};
  if (review.status !== 'approved' || !review.reviewed_at || !review.reviewed_by) {
    addMissing(missing, 'reference_bundle', shot.id, 'coverage_review_not_current', shotAnchor);
  }
  if (!Array.isArray(bundle.face_tracks)
    || bundle.face_tracks.length === 0
    || Number(review.recognizable_face_count) !== Number(review.mapped_face_count)
    || Number(review.unresolved_face_count) !== 0
    || Number(review.mapped_face_count) !== bundle.face_tracks.length) {
    addMissing(missing, 'reference_bundle', shot.id, 'face_coverage_missing', shotAnchor);
  } else if (!bundle.face_tracks.every((face) => isPlainObject(face))) {
    addMissing(missing, 'reference_bundle', shot.id, 'face_coverage_missing', shotAnchor);
  } else if (!bundle.face_tracks.every((face) => validateFace(ctx, shot, face, plan))) {
    addMissing(missing, 'reference_bundle', shot.id, 'character_reference_invalid', shotAnchor);
  }
  const textRegions = Array.isArray(bundle.text_regions) ? bundle.text_regions : null;
  const textCountOk = Number(review.recognizable_text_region_count) === Number(review.mapped_text_region_count)
    && Number(review.unresolved_text_region_count) === 0;
  if (!textRegions || !textCountOk || Number(review.mapped_text_region_count) !== textRegions.length) {
    addMissing(missing, 'reference_bundle', shot.id, 'text_cleanup_missing', shotAnchor);
  } else if (Number(review.recognizable_text_region_count) > 0
    && !textRegions.every((text) => validateText(ctx, shot, text))) {
    addMissing(missing, 'reference_bundle', shot.id, 'text_cleanup_missing', shotAnchor);
  }
  if (!validateMotion(ctx, shot, bundle.motion_reference)) {
    addMissing(missing, 'reference_bundle', shot.id, 'motion_reference_not_current', shotAnchor);
  }
}

function validateShot(ctx, shot, version, characterPlan, missing) {
  const shotAnchor = `shot-${Number(shot.id)}`;
  if (String(shot.tenant_id || '') !== String(version.tenant_id || '')
    || String(shot.user_id || '') !== String(version.user_id || '')) {
    addMissing(missing, 'shot', shot.id, 'owner_mismatch', shotAnchor);
    return false;
  }
  if (String(shot.preparation_state || '') === 'stale') {
    addMissing(missing, 'shot', shot.id, 'shot_stale', shotAnchor);
    return false;
  }
  if (String(shot.preparation_state || '') !== 'reference_ready') {
    addMissing(missing, 'shot', shot.id, 'preparation_required', shotAnchor);
  }
  const bundle = parseJson(shot.reference_bundle_json);
  if (!bundle || bundle.schema_version !== 'redraw-reference-bundle-v1') {
    addMissing(missing, 'reference_bundle', shot.id, 'reference_bundle_malformed', shotAnchor);
    return false;
  }
  if (!HEX_64.test(String(shot.reference_bundle_hash || ''))
    || canonicalBundleHash(bundle) !== String(shot.reference_bundle_hash || '')) {
    addMissing(missing, 'reference_bundle', shot.id, 'reference_hash_drift', shotAnchor);
  }
  validateBundleShape(ctx, shot, bundle, characterPlan, missing);
  const snapshot = parseJson(shot.preparation_snapshot_json);
  if (!snapshot
    || Number(snapshot.version_id) !== Number(version.id)
    || Number(snapshot.shot_id) !== Number(shot.id)
    || snapshot.character_plan_hash !== characterPlan.hash
    || snapshot.reference_bundle_hash !== shot.reference_bundle_hash) {
    addMissing(missing, 'shot', shot.id, 'preparation_evidence_mismatch', shotAnchor);
  }
  if (shot.preparation_evidence_hash !== expectedPreparationHash(shot)) {
    addMissing(missing, 'shot', shot.id, 'preparation_evidence_mismatch', shotAnchor);
  }
  return true;
}

function evaluatePreparationGate(ctx = {}, versionId) {
  if (!ctx.db || typeof ctx.db.prepare !== 'function') {
    return {
      ok: false,
      version_id: Number(versionId),
      character_plan_hash: '',
      ready_shot_ids: [],
      missing: [missingItem('version', versionId, 'db_required', `version-${Number(versionId)}`)],
    };
  }
  const owner = normalizeOwner(ctx);
  const version = findVersion(ctx.db, versionId, owner);
  const id = Number(versionId);
  const missing = new Map();
  if (!version) {
    addMissing(missing, 'version', id, 'version_not_found', `version-${id}`);
    return {
      ok: false,
      version_id: id,
      character_plan_hash: '',
      ready_shot_ids: [],
      missing: sortedMissing(missing),
    };
  }
  const characterPlan = readPlan({ ...ctx, tenantId: owner.tenantId, userId: owner.userId }, version.id, missing);
  const shots = ctx.db.prepare(`
    SELECT *
    FROM redraw_shots
    WHERE version_id = ? AND deleted_at IS NULL
    ORDER BY batch_index ASC, shot_index ASC, id ASC
  `).all(Number(version.id));
  if (shots.length === 0) {
    addMissing(missing, 'version', version.id, 'shots_missing', `version-${Number(version.id)}-shots`);
  }
  const readyShotIds = [];
  for (const shot of shots) {
    const before = missing.size;
    validateShot(ctx, shot, version, characterPlan, missing);
    if (missing.size === before) readyShotIds.push(Number(shot.id));
  }
  const missingList = sortedMissing(missing);
  return {
    ok: missingList.length === 0,
    version_id: Number(version.id),
    character_plan_hash: characterPlan.hash,
    ready_shot_ids: readyShotIds.sort((left, right) => left - right),
    missing: missingList,
  };
}

module.exports = {
  evaluatePreparationGate,
  preparationEvidenceHash: expectedPreparationHash,
};
