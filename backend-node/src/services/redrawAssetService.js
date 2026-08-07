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
    source_asset_id: sourcePayload.source_asset_id
      ?? sourcePayload.source_ref?.source_asset_id
      ?? row.source_asset_id
      ?? null,
    snapshot: sourcePayload.snapshot || {},
    review_status: row.status === 'needs_attention' && row.approval_status === 'pending'
      ? 'needs_review'
      : row.approval_status,
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
  };
  for (const [input, column] of Object.entries(fields)) {
    if (changes[input] !== undefined) {
      updates.push(`${column} = ?`);
      params.push(String(changes[input]));
    }
  }
  if (updates.length === 0) return rowToAsset(row);
  updates.push("approval_status = 'pending'");
  updates.push('approved_by = NULL');
  updates.push('approved_at = NULL');
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
    SELECT *
    FROM redraw_assets
    WHERE version_id = ? AND kind = ?
      AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).all(Number(version.id), kind, tenantId, userId);
  const matchingRows = previousRows
    .filter((row) => stableJson(parseJson(row.source_ref_json, {}).source_ref || {}) === sourceKey);
  if (matchingRows.some((row) => String(row.status) === 'processing')) {
    throw codedError('REDRAW_ASSET_ATTEMPT_IN_PROGRESS', '该资产已有生成任务处理中');
  }
  const placeholder = matchingRows
    .filter((row) => String(row.status) === 'draft'
      && !row.generation_task_id && !row.credit_reservation_id && !row.asset_id
      && !row.voice_asset_id && !row.clean_plate_asset_id)
    .sort((left, right) => Number(right.version_number) - Number(left.version_number) || Number(right.id) - Number(left.id))[0] || null;
  const previous = matchingRows
    .reduce((max, row) => Math.max(max, Number(row.version_number || 0)), 0);
  if (!placeholder && previous === 0 && ctx.allowUnmaterializedDraft !== true) {
    throw codedError('REDRAW_ASSET_PLACEHOLDER_REQUIRED', '当前版本缺少可认领的本地化资产草稿');
  }
  const versionNumber = placeholder ? Number(placeholder.version_number) : previous + 1;
  const snapshot = input.snapshot || input.generationSnapshot || input.generation_snapshot || {};
  let reservation = null;
  const amount = Number(ctx.creditAmount || input.creditAmount || 0);
  const model = String(input.model || ctx.model || 'redraw-asset');
  const operationKey = String(input.operationKey || ctx.operationKey || `redraw_asset:${version.id}:${kind}:${sourceKey}:${versionNumber}`);
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
    const localizedName = String(input.localizedName ?? input.localized_name ?? placeholder?.localized_name ?? '');
    const localizedDescription = String(input.localizedDescription ?? input.localized_description
      ?? placeholder?.localized_description ?? '');
    const prompt = String(input.prompt ?? placeholder?.prompt ?? '');
    const generationTaskId = input.generationTaskId || input.generation_task_id || null;
    if (placeholder) {
      const claimed = db.prepare(`
        UPDATE redraw_assets
        SET source_ref_json = ?, localized_name = ?, localized_description = ?, prompt = ?,
            generation_task_id = ?, credit_reservation_id = ?, approval_status = 'pending',
            status = 'processing', error_code = NULL, error_message = NULL, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'draft'
          AND generation_task_id IS NULL AND credit_reservation_id IS NULL
          AND asset_id IS NULL AND voice_asset_id IS NULL AND clean_plate_asset_id IS NULL
      `).run(
        sourcePayload, localizedName, localizedDescription, prompt,
        generationTaskId, reservation?.id || null, now,
        Number(placeholder.id), tenantId, userId,
      );
      if (claimed.changes !== 1) {
        throw codedError('REDRAW_ASSET_ATTEMPT_CONFLICT', '资产草稿已被其他任务认领');
      }
      return Number(placeholder.id);
    }
    const result = db.prepare(`
        INSERT INTO redraw_assets
          (version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
           localized_description, prompt, generation_task_id, credit_reservation_id, version_number,
           approval_status, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'processing', ?, ?)
      `).run(
        Number(version.id), tenantId, userId, kind, sourcePayload,
        localizedName, localizedDescription, prompt, generationTaskId,
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

function assertReadableAsset(ctx, assetId, label) {
  const asset = readProviderAsset(ctx.db, assetId);
  const canRead = typeof ctx.assetReader?.canRead === 'function'
    ? ctx.assetReader.canRead(asset)
    : asset?.readable === true;
  if (!asset || !canRead) throw codedError('ASSET_NOT_READABLE', `${label}资产不可读取`);
  return asset;
}

function validateCleanPlateQuality(sceneAsset, options, providerResult) {
  const quality = providerResult.quality || providerResult.metrics;
  const width = Number(quality?.width);
  const height = Number(quality?.height);
  if (!quality || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw codedError('CLEAN_PLATE_QUALITY_UNVERIFIED', '净景质量未通过：缺少可审计尺寸');
  }
  const expectedWidth = Number(options.width || sceneAsset.width || sceneAsset.source_width);
  const expectedHeight = Number(options.height || sceneAsset.height || sceneAsset.source_height);
  if ((Number.isFinite(expectedWidth) && width !== expectedWidth)
    || (Number.isFinite(expectedHeight) && height !== expectedHeight)) {
    throw codedError('CLEAN_PLATE_QUALITY_FAILED', '净景质量未通过：输出尺寸与源场景不一致');
  }
  if (quality.mask_area_changed !== true) {
    throw codedError('CLEAN_PLATE_QUALITY_FAILED', '净景质量未通过：遮罩区域没有可验证变化');
  }
  const similarity = Number(quality.non_mask_similarity);
  const minimum = Number(options.nonMaskSimilarityMin ?? 0.9);
  if (!Number.isFinite(similarity) || similarity < minimum) {
    throw codedError('CLEAN_PLATE_QUALITY_FAILED', '净景质量未通过：非遮罩区域结构相似度不足');
  }
}

function cleanPlateQualityOptions(attempt, providerResult = {}) {
  const snapshot = parseJson(attempt.source_ref_json, {}).snapshot || {};
  return {
    width: providerResult.width ?? providerResult.source_width ?? snapshot.width ?? snapshot.source_width,
    height: providerResult.height ?? providerResult.source_height ?? snapshot.height ?? snapshot.source_height,
    nonMaskSimilarityMin: providerResult.nonMaskSimilarityMin ?? providerResult.non_mask_similarity_min,
  };
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
    failAssetAttempt(ctx, attempt.id, Object.assign(new Error(String(message)), { code }));
    throw codedError(code, String(message));
  };
  const status = String(providerResult.status || '').toLowerCase();
  if (!['completed', 'complete', 'succeeded', 'success', 'done'].includes(status)) {
    return fail(providerResult.error || '资产生成失败');
  }
  const assetId = providerResult.asset_id || providerResult.assetId || providerResult.asset?.id
    || providerResult.voice_asset_id || providerResult.voiceAssetId
    || providerResult.clean_plate_asset_id || providerResult.cleanPlateAssetId;
  const asset = readProviderAsset(db, assetId);
  const canRead = typeof ctx.assetReader?.canRead === 'function'
    ? ctx.assetReader.canRead(asset)
    : providerResult.readable === true;
  if (!asset || !canRead) return fail('生成图片不可读取', 'ASSET_NOT_READABLE');
  if (attempt.kind === 'voice' && asset.type !== 'audio' && !String(asset.mime_type || '').startsWith('audio/')) {
    return fail('语音资产类型不是音频', 'VOICE_ASSET_TYPE_INVALID');
  }
  if (attempt.kind === 'character' && providerResult.metadata?.views
    && (!Array.isArray(providerResult.metadata.views) || providerResult.metadata.views.length < 3)) {
    return fail('角色资产缺少正面、侧面、背面三视图', 'CHARACTER_VIEWS_INCOMPLETE');
  }
  if (attempt.kind === 'scene' && providerResult.clean_plate === true) {
    try {
      validateCleanPlateQuality(asset, cleanPlateQualityOptions(attempt, providerResult), providerResult);
    } catch (error) {
      return fail(error.message, error.code || 'CLEAN_PLATE_QUALITY_FAILED');
    }
  }
  const now = new Date().toISOString();
  if (attempt.kind === 'voice') {
    db.prepare(`
      UPDATE redraw_assets
      SET voice_asset_id = ?, status = 'generated', approval_status = 'pending',
          error_code = NULL, error_message = NULL, updated_at = ?
      WHERE id = ?
    `).run(Number(asset.id), now, Number(attempt.id));
  } else if (attempt.kind === 'scene' && providerResult.clean_plate === true) {
    db.prepare(`
      UPDATE redraw_assets
      SET clean_plate_asset_id = ?, status = 'needs_attention', approval_status = 'pending',
          error_code = NULL, error_message = NULL, updated_at = ?
      WHERE id = ?
    `).run(Number(asset.id), now, Number(attempt.id));
  } else {
    db.prepare(`
      UPDATE redraw_assets
      SET asset_id = ?, status = 'generated', approval_status = 'pending',
          error_code = NULL, error_message = NULL, updated_at = ?
      WHERE id = ?
    `).run(Number(asset.id), now, Number(attempt.id));
  }
  if (reservationId) creditLedger.settleGeneration(db, reservationId, 'completed');
  return rowToAsset(db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(Number(attempt.id)));
}

function failAssetAttempt(ctx, attemptId, error) {
  const { db, tenantId, userId } = assertContext(ctx);
  const attempt = db.prepare(`
    SELECT * FROM redraw_assets
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(Number(attemptId), tenantId, userId);
  if (!attempt) throw codedError('REDRAW_ASSET_NOT_FOUND', '转绘资产尝试不存在');
  const message = String(error?.message || error || '资产生成失败');
  const code = String(error?.code || 'REDRAW_ASSET_GENERATION_FAILED');
  if (String(attempt.status) === 'failed') return rowToAsset(attempt);
  const now = new Date().toISOString();
  db.prepare('UPDATE redraw_assets SET status = ?, error_code = ?, error_message = ?, updated_at = ? WHERE id = ?')
    .run('failed', code, message, now, Number(attempt.id));
  if (attempt.credit_reservation_id) creditLedger.settleGeneration(db, attempt.credit_reservation_id, 'failed', message);
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
      failAssetAttempt(ctx, attempt.id, error);
    }
    throw error;
  }
}

async function generateCleanPlate(ctx, sceneAsset = {}, options = {}) {
  const { db } = assertContext(ctx);
  const maskAssetId = options.mask_asset_id ?? options.maskAssetId;
  if (!maskAssetId) throw codedError('CLEAN_PLATE_MASK_REQUIRED', '去人净景需要人物遮罩');
  const sourceAssetId = sceneAsset.source_asset_id
    ?? sceneAsset.sourceAssetId
    ?? sceneAsset.asset_id
    ?? sceneAsset.id;
  if (!sourceAssetId) throw codedError('CLEAN_PLATE_SOURCE_REQUIRED', '去人净景缺少源场景资产');
  assertReadableAsset(ctx, maskAssetId, '人物遮罩');
  assertReadableAsset(ctx, sourceAssetId, '源场景');

  const inputFrameFingerprint = options.inputFrameFingerprint
    || options.input_frame_fingerprint
    || sceneAsset.source_fingerprint
    || sceneAsset.sourceFingerprint
    || '';
  const model = String(options.model || ctx.model || 'redraw-clean-plate');
  const prompt = String(options.prompt || '去除人物并保留场景结构');
  const sourceRef = {
    source_asset_id: sourceAssetId,
    source_fingerprint: String(inputFrameFingerprint),
    source_ref: sceneAsset.source_ref || sceneAsset.sourceRef || {},
  };
  const attempt = createAssetAttempt({
    ...ctx,
    model,
    creditAmount: options.creditAmount ?? ctx.creditAmount,
    allowUnmaterializedDraft: true,
  }, {
    kind: 'scene',
    sourceRef,
    snapshot: {
      mode: 'clean_plate',
      source_asset_id: sourceAssetId,
      mask_asset_id: maskAssetId,
      input_frame_fingerprint: String(inputFrameFingerprint),
      model,
      prompt,
    },
    prompt,
    generationTaskId: options.generationTaskId || options.generation_task_id || null,
  });
  const now = new Date().toISOString();
  db.prepare('UPDATE redraw_assets SET mask_asset_id = ?, updated_at = ? WHERE id = ?')
    .run(Number(maskAssetId), now, Number(attempt.id));

  try {
    if (typeof ctx.provider !== 'function') throw codedError('REDRAW_ASSET_PROVIDER_REQUIRED', '缺少净景生成 provider');
    const providerResult = await ctx.provider({
      attempt,
      versionId: attempt.version_id,
      input: {
        ...sceneAsset,
        source_asset_id: sourceAssetId,
        mask_asset_id: Number(maskAssetId),
        input_frame_fingerprint: inputFrameFingerprint,
        model,
        prompt,
      },
    });
    const providerTaskId = providerResult?.provider_task_id || providerResult?.task_id;
    if (providerTaskId) {
      db.prepare('UPDATE redraw_assets SET generation_task_id = ?, updated_at = ? WHERE id = ?')
        .run(String(providerTaskId), new Date().toISOString(), Number(attempt.id));
    }
    const providerStatus = String(providerResult?.status || '').toLowerCase();
    if (!['completed', 'complete', 'succeeded', 'success', 'done'].includes(providerStatus)) {
      throw codedError('REDRAW_ASSET_GENERATION_FAILED', providerResult?.error || '净景生成失败');
    }
    validateCleanPlateQuality(sceneAsset, options, providerResult || {});
    const finalized = finalizeAssetAttempt(ctx, attempt.id, providerResult);
    db.prepare(`
      UPDATE redraw_assets
      SET clean_plate_asset_id = ?, mask_asset_id = ?, status = 'needs_attention',
          approval_status = 'pending', updated_at = ?
      WHERE id = ?
    `).run(Number(finalized.asset_id), Number(maskAssetId), new Date().toISOString(), Number(attempt.id));
    return rowToAsset(db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(Number(attempt.id)));
  } catch (error) {
    const row = db.prepare('SELECT status FROM redraw_assets WHERE id = ?').get(Number(attempt.id));
    if (row?.status !== 'failed') {
      failAssetAttempt(ctx, attempt.id, error);
    }
    throw error;
  }
}

module.exports = {
  listAssets,
  updateAsset,
  createAssetAttempt,
  finalizeAssetAttempt,
  failAssetAttempt,
  listAssetVersions,
  generateAsset,
  generateCleanPlate,
  validateCleanPlateQuality,
};
