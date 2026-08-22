function normalizeOwner(owner = {}) {
  return {
    tenantId: owner.tenantId ?? owner.tenant_id ?? null,
    userId: owner.userId ?? owner.user_id ?? null,
  };
}

function rowToWork(row, reused = false) {
  return row ? { ...row, reused } : null;
}

function getWorkById(db, id, reused = false) {
  return rowToWork(
    db.prepare('SELECT * FROM redraw_works WHERE id = ?').get(Number(id)),
    reused,
  );
}

function sourceFingerprint(sourceAsset = {}) {
  const value = sourceAsset.source_fingerprint || sourceAsset.sha256 || sourceAsset.fingerprint;
  return String(value || '').trim();
}

function createWorkFromSource(db, owner, projectId, sourceAsset) {
  const { tenantId, userId } = normalizeOwner(owner);
  const fingerprint = sourceFingerprint(sourceAsset);
  if (!tenantId) throw Object.assign(new Error('缺少租户'), { code: 'REDRAW_TENANT_REQUIRED' });
  if (!userId) throw Object.assign(new Error('缺少用户'), { code: 'REDRAW_USER_REQUIRED' });
  if (!fingerprint) throw Object.assign(new Error('缺少源片指纹'), { code: 'REDRAW_SOURCE_FINGERPRINT_REQUIRED' });
  const project = db.prepare(
    'SELECT id FROM redraw_projects WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL'
  ).get(Number(projectId), String(tenantId), String(userId));
  if (!project) {
    throw Object.assign(new Error('转绘项目不存在'), { code: 'REDRAW_PROJECT_NOT_FOUND' });
  }

  const existing = db.prepare(`
    SELECT * FROM redraw_works
    WHERE tenant_id = ? AND user_id = ? AND source_fingerprint = ? AND deleted_at IS NULL
    ORDER BY id ASC
    LIMIT 1
  `).get(String(tenantId), String(userId), fingerprint);
  if (existing) return rowToWork(existing, true);

  const now = new Date().toISOString();
  try {
    const inserted = db.prepare(`
      INSERT INTO redraw_works
        (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms,
         current_version, current_step, status, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, 'draft', ?, ?, NULL)
    `).run(
      Number(projectId),
      String(tenantId),
      String(userId),
      sourceAsset?.name || '源片',
      sourceAsset?.id ?? sourceAsset?.asset_id ?? null,
      fingerprint,
      Math.round(Number(sourceAsset?.duration_ms || 0)),
      now,
      now,
    );
    return getWorkById(db, inserted.lastInsertRowid, false);
  } catch (error) {
    if (!/UNIQUE/i.test(String(error?.message || ''))) throw error;
    const row = db.prepare(`
      SELECT * FROM redraw_works
      WHERE tenant_id = ? AND user_id = ? AND source_fingerprint = ? AND deleted_at IS NULL
      ORDER BY id ASC
      LIMIT 1
    `).get(String(tenantId), String(userId), fingerprint);
    if (row) return rowToWork(row, true);
    throw error;
  }
}

module.exports = {
  createWorkFromSource,
};
