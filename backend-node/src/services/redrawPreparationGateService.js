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
    return HEX_64.test(String(plan.plan_hash || '')) ? plan.plan_hash : '';
  } catch (_) {
    addMissing(missing, 'character_plan', versionId, 'character_plan_not_ready', `version-${Number(versionId)}-character-plan`);
    return '';
  }
}

function validateBundleShape(shot, bundle, missing) {
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
  }
  const textRegions = Array.isArray(bundle.text_regions) ? bundle.text_regions : null;
  const textCountOk = Number(review.recognizable_text_region_count) === Number(review.mapped_text_region_count)
    && Number(review.unresolved_text_region_count) === 0;
  if (!textRegions || !textCountOk || Number(review.mapped_text_region_count) !== textRegions.length) {
    addMissing(missing, 'reference_bundle', shot.id, 'text_cleanup_missing', shotAnchor);
  }
  if (!bundle.motion_reference || typeof bundle.motion_reference !== 'object'
    || !Number.isSafeInteger(Number(bundle.motion_reference.asset_id))
    || !HEX_64.test(String(bundle.motion_reference.sha256 || ''))) {
    addMissing(missing, 'reference_bundle', shot.id, 'motion_reference_not_current', shotAnchor);
  }
}

function validateShot(shot, version, characterPlanHash, missing) {
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
  validateBundleShape(shot, bundle, missing);
  const snapshot = parseJson(shot.preparation_snapshot_json);
  if (!snapshot
    || Number(snapshot.version_id) !== Number(version.id)
    || Number(snapshot.shot_id) !== Number(shot.id)
    || snapshot.character_plan_hash !== characterPlanHash
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
  const characterPlanHash = readPlan({ ...ctx, tenantId: owner.tenantId, userId: owner.userId }, version.id, missing);
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
    validateShot(shot, version, characterPlanHash, missing);
    if (missing.size === before) readyShotIds.push(Number(shot.id));
  }
  const missingList = sortedMissing(missing);
  return {
    ok: missingList.length === 0,
    version_id: Number(version.id),
    character_plan_hash: characterPlanHash,
    ready_shot_ids: readyShotIds.sort((left, right) => left - right),
    missing: missingList,
  };
}

module.exports = {
  evaluatePreparationGate,
  preparationEvidenceHash: expectedPreparationHash,
};
