'use strict';

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
  return {
    kind: inferredKind,
    asset_id: assetId,
    anchor: String(value.anchor || `asset-${assetId}-${inferredKind}`),
  };
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

function evaluateGenerationGate(db, versionId, owner = {}) {
  if (!db) throw codedError('REDRAW_REVIEW_DB_REQUIRED', '缺少数据库');
  const version = getVersion(db, versionId, owner);
  const shots = db.prepare(`
    SELECT id, shot_id, shot_index, references_json, draft_json
    FROM redraw_shots
    WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    ORDER BY batch_index ASC, shot_index ASC, id ASC
  `).all(version.id, version.tenant_id, version.user_id);
  const blocking = [];
  if (shots.length === 0) {
    blocking.push({ code: 'shots_missing', reason: '当前版本没有可生成分镜' });
  }
  const missing = new Map();
  let invalidReferenceCount = 0;
  let unapprovedReferenceCount = 0;
  for (const shot of shots) {
    const shotId = shot.shot_id || Number(shot.id) || Number(shot.shot_index);
    for (const reference of readShotReferences(shot)) {
      const row = findAsset(db, version, reference);
      if (isApprovedAsset(row)) continue;
      if (row) unapprovedReferenceCount += 1;
      else invalidReferenceCount += 1;
      const assetId = row ? Number(row.id) : reference.asset_id;
      const key = referenceKey(reference.kind, assetId);
      const item = missing.get(key) || {
        kind: reference.kind,
        asset_id: assetId,
        shot_ids: [],
        anchor: reference.anchor || `asset-${assetId}-${reference.kind}`,
      };
      if (!item.shot_ids.includes(shotId)) item.shot_ids.push(shotId);
      missing.set(key, item);
    }
  }
  const items = [...missing.values()].sort((left, right) => (
    left.shot_ids[0] - right.shot_ids[0] || left.kind.localeCompare(right.kind) || left.asset_id - right.asset_id
  ));
  if (invalidReferenceCount > 0) {
    blocking.push({
      code: 'asset_reference_invalid',
      reason: '分镜引用不属于当前版本的转绘资产',
      asset_count: invalidReferenceCount,
    });
  }
  if (unapprovedReferenceCount > 0) {
    blocking.push({
      code: 'asset_not_approved',
      reason: '存在尚未生成或批准的分镜引用资产',
      asset_count: unapprovedReferenceCount,
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
  const now = new Date().toISOString();
  const version = db.prepare('SELECT work_id FROM redraw_versions WHERE id = ?').get(current.version_id);
  const transaction = db.transaction(() => {
    db.prepare(`
      UPDATE redraw_assets
      SET approval_status = ?, approved_by = ?, approved_at = ?, version_number = ?,
          status = ?, updated_at = ?
      WHERE id = ? AND updated_at = ?
    `).run(action, String(reviewerId), now, Number(current.version_number),
      action === 'rejected' ? 'needs_attention' : current.status,
      now, Number(current.id), String(expectedUpdatedAt));
    if (action === 'rejected') {
      db.prepare(`UPDATE redraw_versions SET status = 'asset_review', updated_at = ? WHERE id = ?`).run(now, current.version_id);
      db.prepare(`UPDATE redraw_works SET status = 'asset_review', current_step = 2, updated_at = ? WHERE id = ?`).run(now, version?.work_id);
    } else {
      const gate = evaluateGenerationGate(db, current.version_id, { tenantId: current.tenant_id, userId: current.user_id });
      db.prepare(`UPDATE redraw_versions SET status = ?, updated_at = ? WHERE id = ?`)
        .run(gate.ok ? 'ready_to_generate' : 'asset_review', now, current.version_id);
      db.prepare(`UPDATE redraw_works SET status = ?, current_step = ?, updated_at = ? WHERE id = ?`)
        .run(gate.ok ? 'ready_to_generate' : 'asset_review', gate.current_step, now, version?.work_id);
    }
  })();
  return db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(Number(current.id));
}

module.exports = {
  evaluateGenerationGate,
  reviewAsset,
};
