const creditLedger = require('./creditLedgerService');

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function normalizeOwner(ctx = {}) {
  return {
    tenantId: ctx.tenantId ?? ctx.tenant_id ?? null,
    userId: ctx.userId ?? ctx.user_id ?? null,
  };
}

function assertContext(ctx) {
  if (!ctx?.db) throw codedError('REDRAW_ASSET_DB_REQUIRED', '缺少数据库');
  const { tenantId, userId } = normalizeOwner(ctx);
  if (!tenantId) throw codedError('REDRAW_ASSET_TENANT_REQUIRED', '缺少租户');
  if (!userId) throw codedError('REDRAW_ASSET_USER_REQUIRED', '缺少用户');
  if (!ctx.versionId) throw codedError('REDRAW_VERSION_REQUIRED', '缺少本地化版本');
  return { db: ctx.db, tenantId: String(tenantId), userId: String(userId) };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
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

function getVersion(ctx) {
  const { db, tenantId, userId } = assertContext(ctx);
  const version = db.prepare(`
    SELECT * FROM redraw_versions
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(Number(ctx.versionId), tenantId, userId);
  if (!version) throw codedError('REDRAW_VERSION_NOT_FOUND', '本地化版本不存在');
  return version;
}

function rowToAsset(row) {
  if (!row) return null;
  const sourcePayload = parseJson(row.source_ref_json, {});
  return {
    ...row,
    source_ref: sourcePayload.source_ref || sourcePayload.source || sourcePayload,
    snapshot: sourcePayload.snapshot || {},
  };
}

function assetWhere(ctx, extra = '') {
  const { tenantId, userId } = assertContext(ctx);
  return {
    sql: `SELECT * FROM redraw_assets WHERE tenant_id = ? AND user_id = ? AND deleted_at IS NULL${extra}`,
    params: [tenantId, userId],
  };
}

function listAssets(db, ctx, filters = {}) {
  const scoped = assetWhere({ ...ctx, db });
  const clauses = ['version_id = ?'];
  const params = [...scoped.params, Number(ctx.versionId)];
  if (filters.kind) {
    clauses.push('kind = ?');
    params.push(String(filters.kind));
  }
  const rows = db.prepare(`${scoped.sql} AND ${clauses.join(' AND ')} ORDER BY kind ASC, version_number DESC, id DESC`)
    .all(...params);
  return rows.map(rowToAsset);
}

function updateAsset(db, ctx, assetId, changes = {}) {
  const { tenantId, userId } = assertContext({ ...ctx, db });
  const row = db.prepare(`
    SELECT * FROM redraw_assets
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(Number(assetId), tenantId, userId);
  if (!row) return null;
  const updates = [];
  const params = [];
  const fields = {
    localizedName: 'localized_name',
    localizedDescription: 'localized_description',
    prompt: 'prompt',
    approvalStatus: 'approval_status',
  };
  for (const [input, column] of Object.entries(fields)) {
    if (changes[input] !== undefined) {
      updates.push(`${column} = ?`);
      params.push(String(changes[input]));
    }
  }
  if (updates.length === 0) return rowToAsset(row);
  params.push(new Date().toISOString(), Number(assetId));
  db.prepare(`UPDATE redraw_assets SET ${updates.join(', ')}, updated_at = ? WHERE id = ?`).run(...params);
  return rowToAsset(db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(Number(assetId)));
}

function listAssetVersions(db, ctx, assetId) {
  const { tenantId, userId } = assertContext({ ...ctx, db });
  const current = db.prepare(`
    SELECT version_id, kind, source_ref_json
    FROM redraw_assets
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(Number(assetId), tenantId, userId);
  if (!current) return [];
  const sourceKey = stableJson(parseJson(current.source_ref_json, {}).source_ref || {});
  return db.prepare(`
    SELECT * FROM redraw_assets
    WHERE version_id = ? AND kind = ?
      AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    ORDER BY version_number DESC, id DESC
  `).all(current.version_id, current.kind, tenantId, userId)
    .filter((row) => stableJson(parseJson(row.source_ref_json, {}).source_ref || {}) === sourceKey)
    .map(rowToAsset);
}

function createAssetAttempt(ctx, input = {}) {
  const { db, tenantId, userId } = assertContext(ctx);
  const version = getVersion({ ...ctx, db });
  const kind = String(input.kind || '').trim();
  if (!['character', 'scene', 'prop', 'voice'].includes(kind)) {
    throw codedError('REDRAW_ASSET_KIND_INVALID', '不支持的转绘资产类型');
  }
  const sourceRef = input.sourceRef || input.source_ref;
  if (!sourceRef || typeof sourceRef !== 'object') throw codedError('REDRAW_ASSET_SOURCE_REQUIRED', '缺少资产来源引用');
  const sourceKey = stableJson(sourceRef);
  const previousRows = db.prepare(`
    SELECT version_number, source_ref_json
    FROM redraw_assets
    WHERE version_id = ? AND kind = ?
      AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).all(Number(version.id), kind, tenantId, userId);
  const previous = previousRows
    .filter((row) => stableJson(parseJson(row.source_ref_json, {}).source_ref || {}) === sourceKey)
    .reduce((max, row) => Math.max(max, Number(row.version_number || 0)), 0);
  const versionNumber = previous + 1;
  const snapshot = input.snapshot || input.generationSnapshot || input.generation_snapshot || {};
  let reservation = null;
  const amount = Number(ctx.creditAmount || input.creditAmount || 0);
  const model = String(input.model || ctx.model || 'redraw-asset');
  const operationKey = `redraw_asset:${version.id}:${kind}:${sourceKey}:${versionNumber}`;
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    if (amount > 0) {
      reservation = creditLedger.reserve(db, {
        tenantId,
        actorUserId: userId,
        userId,
        operationKey,
        amount,
        model,
        resourceType: 'redraw_asset',
        resourceId: `${version.id}:${kind}:${versionNumber}`,
      });
    }
    const sourcePayload = JSON.stringify({ source_ref: sourceRef, snapshot });
    const result = db.prepare(`
      INSERT INTO redraw_assets
        (version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
         localized_description, prompt, generation_task_id, credit_reservation_id, version_number,
         approval_status, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'processing', ?, ?)
    `).run(
      Number(version.id), tenantId, userId, kind, sourcePayload,
      String(input.localizedName || input.localized_name || ''),
      String(input.localizedDescription || input.localized_description || ''),
      String(input.prompt || ''), input.generationTaskId || input.generation_task_id || null,
      reservation?.id || null, versionNumber, now, now,
    );
    return Number(result.lastInsertRowid);
  })();
  return {
    id: transaction,
    version_id: Number(version.id),
    version_number: versionNumber,
    kind,
    source_ref: sourceRef,
    reservation_id: reservation?.id || null,
    snapshot,
  };
}

function readProviderAsset(db, assetId) {
  if (!assetId) return null;
  return db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(Number(assetId)) || null;
}

function finalizeAssetAttempt(ctx, attemptId, providerResult = {}) {
  const { db, tenantId, userId } = assertContext(ctx);
  const attempt = db.prepare(`
    SELECT * FROM redraw_assets
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(Number(attemptId), tenantId, userId);
  if (!attempt) throw codedError('REDRAW_ASSET_NOT_FOUND', '转绘资产尝试不存在');
  const reservationId = attempt.credit_reservation_id || null;
  const fail = (message, code = 'REDRAW_ASSET_GENERATION_FAILED') => {
    const now = new Date().toISOString();
    db.prepare('UPDATE redraw_assets SET status = ?, error_code = ?, error_message = ?, updated_at = ? WHERE id = ?')
      .run('failed', code, String(message), now, Number(attempt.id));
    if (reservationId) creditLedger.settleGeneration(db, reservationId, 'failed', String(message));
    throw codedError(code, String(message));
  };
  const status = String(providerResult.status || '').toLowerCase();
  if (!['completed', 'complete', 'succeeded', 'success', 'done'].includes(status)) {
    return fail(providerResult.error || '资产生成失败');
  }
  const assetId = providerResult.asset_id || providerResult.assetId || providerResult.asset?.id;
  const asset = readProviderAsset(db, assetId);
  const canRead = typeof ctx.assetReader?.canRead === 'function'
    ? ctx.assetReader.canRead(asset)
    : providerResult.readable === true;
  if (!asset || !canRead) return fail('生成图片不可读取', 'ASSET_NOT_READABLE');
  if (attempt.kind === 'character' && providerResult.metadata?.views
    && (!Array.isArray(providerResult.metadata.views) || providerResult.metadata.views.length < 3)) {
    return fail('角色资产缺少正面、侧面、背面三视图', 'CHARACTER_VIEWS_INCOMPLETE');
  }
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE redraw_assets
    SET asset_id = ?, status = 'generated', approval_status = 'pending',
        error_code = NULL, error_message = NULL, updated_at = ?
    WHERE id = ?
  `).run(Number(asset.id), now, Number(attempt.id));
  if (reservationId) creditLedger.settleGeneration(db, reservationId, 'completed');
  return rowToAsset(db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(Number(attempt.id)));
}

async function generateAsset(ctx, input = {}) {
  const attempt = createAssetAttempt(ctx, input);
  try {
    if (typeof ctx.provider !== 'function') throw codedError('REDRAW_ASSET_PROVIDER_REQUIRED', '缺少资产生成 provider');
    const result = await ctx.provider({ attempt, input, versionId: attempt.version_id });
    return finalizeAssetAttempt(ctx, attempt.id, result);
  } catch (error) {
    const row = ctx.db.prepare('SELECT status FROM redraw_assets WHERE id = ?').get(attempt.id);
    if (row?.status !== 'failed') {
      const now = new Date().toISOString();
      ctx.db.prepare('UPDATE redraw_assets SET status = ?, error_code = ?, error_message = ?, updated_at = ? WHERE id = ?')
        .run('failed', error.code || 'REDRAW_ASSET_GENERATION_FAILED', String(error.message || error), now, attempt.id);
      if (attempt.reservation_id) creditLedger.settleGeneration(ctx.db, attempt.reservation_id, 'failed', String(error.message || error));
    }
    throw error;
  }
}

module.exports = {
  listAssets,
  updateAsset,
  createAssetAttempt,
  finalizeAssetAttempt,
  listAssetVersions,
  generateAsset,
};
