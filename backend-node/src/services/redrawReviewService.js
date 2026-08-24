'use strict';

const {
  identityPackStatus,
  identityBindingForAsset,
} = require('./redrawCharacterIdentityService');
const { evaluatePreparationGate } = require('./redrawPreparationGateService');
const {
  REFERENCE_BUNDLE_SCHEMA_VERSION,
  canonicalBundleHash,
} = require('./redrawReferenceBundleService');

const HEX_64 = /^[0-9a-f]{64}$/;

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
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

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function trustedPreparationContext(value = {}) {
  const output = {};
  for (const key of ['storageRoot', 'fs', 'assetReader', 'canReadArtifact', 'probeRunner']) {
    if (value[key] !== undefined) output[key] = value[key];
  }
  return output;
}

function normalizeOwner(input = {}) {
  return {
    tenantId: input.tenantId ?? input.tenant_id ?? null,
    userId: input.userId ?? input.user_id ?? null,
  };
}

function getVersion(db, versionId, owner = {}) {
  const { tenantId, userId } = normalizeOwner(owner);
  const clauses = ['id = ?', 'deleted_at IS NULL'];
  const params = [Number(versionId)];
  if (tenantId != null) {
    clauses.push('tenant_id = ?');
    params.push(String(tenantId));
  }
  if (userId != null) {
    clauses.push('user_id = ?');
    params.push(String(userId));
  }
  const version = db.prepare(`SELECT * FROM redraw_versions WHERE ${clauses.join(' AND ')}`).get(...params);
  if (!version) throw codedError('REDRAW_VERSION_NOT_FOUND', '本地化版本不存在');
  return version;
}

function referenceKey(kind, assetId) {
  return `${String(kind)}:${Number(assetId)}`;
}

function normalizeReference(value, fallbackKind = null) {
  if (Number.isInteger(value) && value > 0 && fallbackKind) {
    return { kind: fallbackKind, asset_id: value, anchor: `asset-${value}-${fallbackKind}` };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const kind = String(value.kind || value.type || value.asset_kind || fallbackKind || '').trim();
  let rawId = value.asset_id ?? value.assetId ?? value.redraw_asset_id ?? value.redrawAssetId;
  let inferredKind = kind;
  for (const candidate of ['character', 'scene', 'prop', 'voice']) {
    const candidateId = value[`${candidate}_asset_id`] ?? value[`${candidate}AssetId`];
    if (rawId == null && candidateId != null) {
      rawId = candidateId;
      inferredKind = candidate;
    }
  }
  if (rawId == null && value.clean_plate_asset_id != null) {
    rawId = value.clean_plate_asset_id;
    inferredKind = 'scene';
  }
  const assetId = Number(rawId);
  if (!['character', 'scene', 'prop', 'voice'].includes(inferredKind) || !Number.isInteger(assetId) || assetId <= 0) return null;
  const normalized = {
    kind: inferredKind,
    asset_id: assetId,
    anchor: String(value.anchor || `asset-${assetId}-${inferredKind}`),
  };
  if (inferredKind === 'character') {
    normalized.source_character_key = String(value.source_character_key || '').trim();
    normalized.target_actor_label = String(value.target_actor_label || '').trim();
    normalized.identity_pack_sha256 = String(value.identity_pack_sha256 || '').trim();
  }
  return normalized;
}

function collectReferences(value, output, fallbackKind = null) {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, output, fallbackKind);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const normalized = normalizeReference(value, fallbackKind);
  if (normalized) output.push(normalized);
  for (const key of ['references', 'assets', 'asset_references', 'assetReferences']) {
    if (value[key] != null) collectReferences(value[key], output, fallbackKind);
  }
}

function readShotReferences(row) {
  const refs = [];
  collectReferences(parseJson(row.references_json, []), refs);
  const draft = parseJson(row.draft_json, null);
  if (draft) collectReferences(draft.references || draft.assets || draft.asset_references, refs);
  return refs;
}

function findAsset(db, version, reference) {
  return db.prepare(`
    SELECT * FROM redraw_assets
    WHERE id = ? AND version_id = ? AND tenant_id = ? AND user_id = ? AND kind = ? AND deleted_at IS NULL
  `).get(reference.asset_id, version.id, version.tenant_id, version.user_id, reference.kind) || null;
}

function isApprovedAsset(row) {
  return Boolean(row
    && ['generated', 'needs_attention'].includes(String(row.status))
    && String(row.approval_status) === 'approved');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function inspectCurrentV2Bundle(shot, version) {
  const bundle = parseJson(shot.reference_bundle_json, null);
  const hash = String(shot.reference_bundle_hash || '');
  if (!isPlainObject(bundle)
    || bundle.schema_version !== REFERENCE_BUNDLE_SCHEMA_VERSION
    || Number(bundle.version_id) !== Number(version.id)
    || Number(bundle.shot_id) !== Number(shot.id)
    || !Array.isArray(bundle.face_tracks)) {
    return { bundle: null, reason: 'reference_bundle_malformed' };
  }
  if (!HEX_64.test(hash) || canonicalBundleHash(bundle) !== hash) {
    return { bundle: null, reason: 'reference_hash_drift' };
  }
  return { bundle, reason: null };
}

function currentV2Bundle(shot, version) {
  return inspectCurrentV2Bundle(shot, version).bundle;
}

function sameIdentityArtifact(left, right) {
  return isPlainObject(left)
    && isPlainObject(right)
    && Number(left.asset_id) === Number(right.asset_id)
    && String(left.sha256 || '') === String(right.sha256 || '')
    && Number(left.width) === Number(right.width)
    && Number(left.height) === Number(right.height)
    && String(left.mime_type || '') === String(right.mime_type || '');
}

function v2IdentityBindingMatches(bundle, face, row, currentBinding, targetCharacterName, targetMarket) {
  if (!bundle || !isPlainObject(face) || !row || !currentBinding) return false;
  const assetId = Number(row.id);
  const faces = bundle.face_tracks.filter((face) => (
    isPlainObject(face) && Number(face.identity_redraw_asset_id) === assetId
  ));
  if (faces.length !== 1) return false;
  const identity = face.identity;
  const artifact = currentBinding.artifact;
  return isPlainObject(identity)
    && isPlainObject(artifact)
    && Number(row.asset_id) === Number(artifact.asset_id)
    && String(row.localized_name || '') === currentBinding.target_actor_label
    && Number(face.identity_redraw_asset_id) === assetId
    && String(face.source_character_key || '') === currentBinding.source_character_key
    && String(face.target_character_name || '') === targetCharacterName
    && String(face.identity_pack_sha256 || '') === currentBinding.pack_sha256
    && Number(face.identity_asset_id) === Number(artifact.asset_id)
    && String(face.persona_origin || '') === 'fictional_ai_generated'
    && String(face.target_country || '') === targetMarket
    && String(face.adult_status || '') === 'verified_18_plus'
    && Number(identity.redraw_asset_id) === assetId
    && String(identity.source_character_key || '') === currentBinding.source_character_key
    && String(identity.target_character_name || '') === targetCharacterName
    && String(identity.target_actor_label || '') === currentBinding.target_actor_label
    && String(identity.identity_pack_sha256 || '') === currentBinding.pack_sha256
    && String(identity.pack_sha256 || '') === currentBinding.pack_sha256
    && Number(identity.identity_asset_id) === Number(artifact.asset_id)
    && String(identity.persona_origin || '') === 'fictional_ai_generated'
    && String(identity.target_country || '') === targetMarket
    && String(identity.adult_status || '') === 'verified_18_plus'
    && currentBinding.persona_origin === 'fictional_ai_generated'
    && currentBinding.target_country === targetMarket
    && sameIdentityArtifact(identity.artifact, artifact);
}

function assetReviewAllowsPreparation(db, version, preparation) {
  if (Array.isArray(preparation?.missing) && preparation.missing.some((item) => (
    item?.resource_type === 'character_plan' || item?.reason_code === 'character_plan_not_ready'
  ))) return false;
  const canReadDraftJson = hasColumn(db, 'redraw_shots', 'draft_json');
  const shots = db.prepare(`
    SELECT references_json${canReadDraftJson ? ', draft_json' : ''}
    FROM redraw_shots
    WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).all(version.id, version.tenant_id, version.user_id);
  if (shots.length === 0) return false;
  return shots.every((shot) => readShotReferences(shot).every((reference) => {
    const asset = findAsset(db, version, reference);
    return isApprovedAsset(asset)
      && (reference.kind !== 'character' || identityPackStatus(asset).ready);
  }));
}

function evaluateGenerationGate(db, versionId, owner = {}, options = {}) {
  if (!db) throw codedError('REDRAW_REVIEW_DB_REQUIRED', '缺少数据库');
  const version = getVersion(db, versionId, owner);
  if (Number(version.reference_bundle_required || 0) === 1) {
    const preparationGate = options.preparationGate || evaluatePreparationGate;
    const preparation = preparationGate({
      ...trustedPreparationContext(options.preparationContext),
      db,
      ...normalizeOwner(owner),
    }, version.id);
    if (!preparation.ok) {
      return {
        ok: false,
        version_id: Number(version.id),
        current_step: assetReviewAllowsPreparation(db, version, preparation) ? 3 : 2,
        missing: preparation.missing,
        blocking: [{
          code: 'preparation_not_ready',
          reason: '整集参考准备未完成或已过期',
          shot_count: preparation.ready_shot_ids.length,
        }],
      };
    }
  }
  const referenceBundleRequired = Number(version.reference_bundle_required || 0) === 1;
  const canReadDraftJson = hasColumn(db, 'redraw_shots', 'draft_json');
  const shots = db.prepare(`
    SELECT id, shot_id, shot_index, references_json${referenceBundleRequired ? ', reference_bundle_json, reference_bundle_hash' : ''}${canReadDraftJson ? ', draft_json' : ''}
    FROM redraw_shots
    WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    ORDER BY batch_index ASC, shot_index ASC, id ASC
  `).all(version.id, version.tenant_id, version.user_id);
  const blocking = [];
  if (shots.length === 0) {
    blocking.push({ code: 'shots_missing', reason: '当前版本没有可生成分镜' });
  }
  const missing = new Map();
  const invalidReferenceKeys = new Set();
  const unapprovedReferenceKeys = new Set();
  const characterIdentityPackRequired = new Set();
  const characterIdentityBindingStale = new Set();
  const referenceBundleNotCurrentShots = new Set();
  const nameMap = referenceBundleRequired && isPlainObject(parseJson(version.name_map_json, null))
    ? parseJson(version.name_map_json, null)
    : {};
  for (const shot of shots) {
    const shotId = shot.shot_id || Number(shot.id) || Number(shot.shot_index);
    const bundle = referenceBundleRequired ? currentV2Bundle(shot, version) : null;
    if (referenceBundleRequired && !bundle) {
      const reasonCode = inspectCurrentV2Bundle(shot, version).reason;
      const key = `reference_bundle:${Number(shot.id)}`;
      referenceBundleNotCurrentShots.add(Number(shot.id));
      missing.set(key, {
        resource_type: 'reference_bundle',
        resource_id: String(Number(shot.id)),
        reason_code: reasonCode,
        anchor: `shot-${Number(shot.id)}`,
        kind: 'reference_bundle',
        asset_id: null,
        shot_ids: [shotId],
      });
    }
    for (const reference of readShotReferences(shot)) {
      const row = findAsset(db, version, reference);
      if (!isApprovedAsset(row)) {
        const assetId = row ? Number(row.id) : reference.asset_id;
        const key = referenceKey(reference.kind, assetId);
        if (row) unapprovedReferenceKeys.add(key);
        else invalidReferenceKeys.add(key);
        const item = missing.get(key) || {
          kind: reference.kind,
          asset_id: assetId,
          shot_ids: [],
          anchor: reference.anchor || `asset-${assetId}-${reference.kind}`,
        };
        if (!item.shot_ids.includes(shotId)) item.shot_ids.push(shotId);
        missing.set(key, item);
        continue;
      }
      if (reference.kind !== 'character' || referenceBundleRequired) continue;

      const currentBinding = identityBindingForAsset(row);
      const assetId = Number(row.id);
      const key = referenceKey(reference.kind, assetId);
      let code = null;
      let reason = null;
      if (!currentBinding) {
        code = 'character_identity_pack_required';
        reason = '角色资产缺少当前可用的真人身份包';
        characterIdentityPackRequired.add(key);
      } else {
        const bindingComplete = Boolean(
          reference.source_character_key
          && reference.target_actor_label
          && HEX_64.test(reference.identity_pack_sha256),
        );
        const bindingMatches = bindingComplete
          && reference.source_character_key === currentBinding.source_character_key
          && reference.target_actor_label === currentBinding.target_actor_label
          && reference.identity_pack_sha256 === currentBinding.pack_sha256;
        if (!bindingMatches) {
          code = 'character_identity_binding_stale';
          reason = '分镜角色身份绑定缺失或已过期，请重新保存分镜';
          characterIdentityBindingStale.add(key);
        }
      }
      if (code) {
        const item = missing.get(key) || {
          kind: reference.kind,
          asset_id: assetId,
          shot_ids: [],
          anchor: reference.anchor || `asset-${assetId}-${reference.kind}`,
          code,
          reason,
        };
        if (!item.shot_ids.includes(shotId)) item.shot_ids.push(shotId);
        if (currentBinding) {
          item.source_character_key = reference.source_character_key || null;
          item.target_actor_label = reference.target_actor_label || null;
          item.identity_pack_sha256 = reference.identity_pack_sha256 || null;
          item.expected_identity_pack_sha256 = currentBinding.pack_sha256;
        }
        missing.set(key, item);
      }
    }
    if (!referenceBundleRequired) continue;
    const faces = bundle?.face_tracks;
    if (!Array.isArray(faces)) continue;
    for (const face of faces) {
      const assetId = Number(face?.identity_redraw_asset_id);
      const row = Number.isSafeInteger(assetId) && assetId > 0
        ? findAsset(db, version, { kind: 'character', asset_id: assetId })
        : null;
      const currentBinding = isApprovedAsset(row) ? identityBindingForAsset(row) : null;
      const sourceCharacterKey = String(face?.source_character_key || '').trim();
      const targetCharacterName = String(nameMap[sourceCharacterKey] || '').trim();
      if (v2IdentityBindingMatches(
        bundle,
        face,
        row,
        currentBinding,
        targetCharacterName,
        String(version.market || '').trim(),
      )) continue;
      const key = Number.isSafeInteger(assetId) && assetId > 0
        ? referenceKey('character', assetId)
        : `reference_bundle:${Number(shot.id)}:${String(face?.track_key || '')}`;
      characterIdentityBindingStale.add(key);
      const item = missing.get(key) || {
        kind: 'character',
        asset_id: Number.isSafeInteger(assetId) && assetId > 0 ? assetId : null,
        shot_ids: [],
        anchor: Number.isSafeInteger(assetId) && assetId > 0
          ? `asset-${assetId}-character`
          : `shot-${Number(shot.id)}`,
        code: 'character_identity_binding_stale',
        reason: '当前 V2 参考包角色身份绑定缺失或已过期',
      };
      if (!item.shot_ids.includes(shotId)) item.shot_ids.push(shotId);
      item.source_character_key = sourceCharacterKey || null;
      item.target_actor_label = face?.identity?.target_actor_label || null;
      item.identity_pack_sha256 = face?.identity_pack_sha256 || null;
      item.expected_identity_pack_sha256 = currentBinding?.pack_sha256 || null;
      missing.set(key, item);
    }
  }
  const items = [...missing.values()].sort((left, right) => (
    left.shot_ids[0] - right.shot_ids[0] || left.kind.localeCompare(right.kind) || left.asset_id - right.asset_id
  ));
  if (referenceBundleNotCurrentShots.size > 0) {
    blocking.push({
      code: 'preparation_not_ready',
      reason: '整集参考准备未完成或已过期',
      shot_count: Math.max(0, shots.length - referenceBundleNotCurrentShots.size),
    });
  }
  if (invalidReferenceKeys.size > 0) {
    blocking.push({
      code: 'asset_reference_invalid',
      reason: '分镜引用不属于当前版本的转绘资产',
      asset_count: invalidReferenceKeys.size,
    });
  }
  if (unapprovedReferenceKeys.size > 0) {
    blocking.push({
      code: 'asset_not_approved',
      reason: '存在尚未生成或批准的分镜引用资产',
      asset_count: unapprovedReferenceKeys.size,
    });
  }
  if (characterIdentityPackRequired.size > 0) {
    blocking.push({
      code: 'character_identity_pack_required',
      reason: '存在缺少当前可用真人身份包的角色资产',
      asset_count: characterIdentityPackRequired.size,
    });
  }
  if (characterIdentityBindingStale.size > 0) {
    blocking.push({
      code: 'character_identity_binding_stale',
      reason: '存在缺失或已漂移的逐镜角色身份绑定',
      asset_count: characterIdentityBindingStale.size,
    });
  }
  return {
    ok: blocking.length === 0,
    version_id: Number(version.id),
    current_step: blocking.length === 0 ? 3 : 2,
    missing: items,
    blocking,
  };
}

function reviewAsset(db, assetId, input = {}) {
  if (!db) throw codedError('REDRAW_REVIEW_DB_REQUIRED', '缺少数据库');
  const actionInput = String(input.action || '').trim().toLowerCase();
  const action = actionInput === 'approve' ? 'approved'
    : actionInput === 'reject' ? 'rejected' : actionInput;
  if (!['approved', 'rejected'].includes(action)) {
    throw codedError('REDRAW_REVIEW_ACTION_INVALID', '审核动作只能是 approved 或 rejected');
  }
  const reviewerId = input.reviewerId ?? input.reviewer_id ?? input.userId ?? input.user_id;
  if (!reviewerId) throw codedError('REDRAW_REVIEWER_REQUIRED', '缺少审核人');
  const expectedUpdatedAt = input.expectedUpdatedAt ?? input.expected_updated_at;
  if (!expectedUpdatedAt) throw codedError('REDRAW_REVIEW_EXPECTED_UPDATED_AT_REQUIRED', '缺少 expected_updated_at');
  const { tenantId, userId } = normalizeOwner(input);
  const clauses = ['id = ?', 'deleted_at IS NULL'];
  const params = [Number(assetId)];
  if (tenantId != null) {
    clauses.push('tenant_id = ?');
    params.push(String(tenantId));
  }
  if (userId != null) {
    clauses.push('user_id = ?');
    params.push(String(userId));
  }
  const current = db.prepare(`SELECT * FROM redraw_assets WHERE ${clauses.join(' AND ')}`).get(...params);
  if (!current) throw codedError('REDRAW_ASSET_NOT_FOUND', '转绘资产不存在');
  if (String(current.updated_at) !== String(expectedUpdatedAt)) {
    throw codedError('REDRAW_REVIEW_CONFLICT', '资产已被其他操作更新，请刷新后重试');
  }
  if (input.versionNumber != null || input.version_number != null) {
    const expectedVersion = Number(input.versionNumber ?? input.version_number);
    if (!Number.isInteger(expectedVersion) || expectedVersion !== Number(current.version_number)) {
      throw codedError('REDRAW_REVIEW_VERSION_CONFLICT', '资产版本已变化，请刷新后重试');
    }
  }
  if (action === 'approved'
    && current.kind === 'character'
    && !identityPackStatus(current).ready) {
    throw codedError('REDRAW_CHARACTER_IDENTITY_REQUIRED', '角色资产必须先完成真人身份包审核');
  }
  const now = new Date().toISOString();
  const version = db.prepare('SELECT work_id FROM redraw_versions WHERE id = ?').get(current.version_id);
  if (action === 'rejected') {
    db.transaction(() => {
      const result = db.prepare(`
        UPDATE redraw_assets
        SET approval_status = ?, approved_by = ?, approved_at = ?, version_number = ?,
            status = ?, updated_at = ?
        WHERE id = ? AND updated_at = ?
      `).run(action, String(reviewerId), now, Number(current.version_number),
        'needs_attention',
        now, Number(current.id), String(expectedUpdatedAt));
      if (result.changes !== 1) {
        throw codedError('REDRAW_REVIEW_CONFLICT', '资产已被其他操作更新，请刷新后重试');
      }
      db.prepare(`UPDATE redraw_versions SET status = 'asset_review', updated_at = ? WHERE id = ?`).run(now, current.version_id);
      db.prepare(`UPDATE redraw_works SET status = 'asset_review', current_step = 2, updated_at = ? WHERE id = ?`).run(now, version?.work_id);
    })();
    return db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(Number(current.id));
  }
  db.transaction(() => {
    const result = db.prepare(`
      UPDATE redraw_assets
      SET approval_status = ?, approved_by = ?, approved_at = ?, version_number = ?,
          status = ?, updated_at = ?
      WHERE id = ? AND updated_at = ?
    `).run(action, String(reviewerId), now, Number(current.version_number),
      current.status,
      now, Number(current.id), String(expectedUpdatedAt));
    if (result.changes !== 1) {
      throw codedError('REDRAW_REVIEW_CONFLICT', '资产已被其他操作更新，请刷新后重试');
    }
  })();
  const gate = evaluateGenerationGate(db, current.version_id, { tenantId: current.tenant_id, userId: current.user_id }, {
    preparationContext: input.preparationContext,
    preparationGate: input.preparationGate,
  });
  db.transaction(() => {
    const stillCurrent = db.prepare(`
      SELECT id
      FROM redraw_assets
      WHERE id = ? AND version_id = ? AND tenant_id = ? AND user_id = ?
        AND approval_status = 'approved' AND updated_at = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(Number(current.id), Number(current.version_id), String(current.tenant_id), String(current.user_id), now);
    if (!stillCurrent) return;
    db.prepare(`UPDATE redraw_versions SET status = ?, updated_at = ? WHERE id = ?`)
      .run(gate.ok ? 'ready_to_generate' : 'asset_review', now, current.version_id);
    db.prepare(`UPDATE redraw_works SET status = ?, current_step = ?, updated_at = ? WHERE id = ?`)
      .run(gate.ok ? 'ready_to_generate' : 'asset_review', gate.current_step, now, version?.work_id);
  })();
  return db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(Number(current.id));
}

module.exports = {
  evaluateGenerationGate,
  reviewAsset,
  trustedPreparationContext,
};
