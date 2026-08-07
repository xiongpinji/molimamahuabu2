const crypto = require('node:crypto');

const taskService = require('./taskService');
const modelPrice = require('./modelPriceService');
const redrawCapability = require('./redrawCapabilityService');
const {
  createAssetAttempt,
  finalizeAssetAttempt,
  failAssetAttempt,
  validateCleanPlateQuality,
} = require('./redrawAssetService');

const trackedBatchCompletions = new Map();

function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function normalizeOwner(input = {}) {
  return {
    tenantId: String(input.tenantId ?? input.tenant_id ?? '').trim(),
    userId: String(input.userId ?? input.user_id ?? '').trim(),
  };
}

function assertContext(ctx = {}) {
  if (!ctx.db) throw codedError('REDRAW_ASSET_DB_REQUIRED', '缺少数据库');
  const { tenantId, userId } = normalizeOwner(ctx);
  if (!tenantId) throw codedError('REDRAW_ASSET_TENANT_REQUIRED', '缺少租户');
  if (!userId) throw codedError('REDRAW_ASSET_USER_REQUIRED', '缺少用户');
  if (!ctx.versionId) throw codedError('REDRAW_VERSION_REQUIRED', '缺少本地化版本');
  return { db: ctx.db, tenantId, userId, versionId: Number(ctx.versionId) };
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

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function capabilityForKind(kind) {
  return {
    character: 'character_image',
    scene: 'clean_plate_image',
    prop: 'clean_plate_image',
    voice: 'tts',
  }[String(kind)] || '';
}

function getVersion(db, ctx) {
  const { tenantId, userId, versionId } = assertContext({ ...ctx, db });
  const version = db.prepare(`
    SELECT * FROM redraw_versions
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(versionId, tenantId, userId);
  if (!version) throw codedError('REDRAW_VERSION_NOT_FOUND', '本地化版本不存在');
  return version;
}

function canReadAsset(ctx, assetId) {
  if (!assetId) return false;
  const asset = ctx.db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(Number(assetId));
  if (!asset) return false;
  if (typeof ctx.assetReader?.canRead === 'function') return ctx.assetReader.canRead(asset) === true;
  if (typeof ctx.canReadArtifact === 'function') return ctx.canReadArtifact(assetId) === true;
  return asset.readable === true;
}

function isTerminalBatchStatus(status) {
  return ['completed', 'partial_failed', 'failed', 'needs_attention'].includes(String(status));
}

function providerTaskIdOf(result) {
  return result?.provider_task_id || result?.providerTaskId || result?.task_id || result?.taskId || '';
}

function isUnknownProviderResult(result) {
  const status = String(result?.status || '').toLowerCase();
  const code = String(result?.code || result?.error_code || '').toUpperCase();
  return result?.unknown === true
    || ['pending', 'processing', 'indeterminate', 'needs_attention', 'unknown'].includes(status)
    || ['UNKNOWN', 'PROVIDER_UNKNOWN', 'TASK_UNKNOWN', 'STATUS_UNKNOWN', 'INDETERMINATE'].includes(code);
}

function isCompletedProviderResult(result) {
  return ['completed', 'complete', 'succeeded', 'success', 'done'].includes(String(result?.status || '').toLowerCase());
}

function isSystemError(error) {
  return error instanceof TypeError
    || String(error?.code || '').startsWith('SQLITE_')
    || /database|constraint|readonly|transaction|connection/i.test(String(error?.message || ''));
}

function markAssetNeedsAttention(ctx, attemptId, message, code = 'REDRAW_ASSET_PROVIDER_UNKNOWN') {
  const base = assertContext(ctx);
  const row = base.db.prepare(`
    SELECT * FROM redraw_assets
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(Number(attemptId), base.tenantId, base.userId);
  if (!row) throw codedError('REDRAW_ASSET_NOT_FOUND', '转绘资产尝试不存在');
  if (String(row.status) === 'needs_attention') return row;
  const now = new Date().toISOString();
  base.db.prepare(`
    UPDATE redraw_assets
    SET status = 'needs_attention', approval_status = 'pending',
        error_code = ?, error_message = ?, updated_at = ?
    WHERE id = ?
  `).run(code, message, now, Number(row.id));
  return base.db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(Number(row.id));
}

function hasReadableSuccess(ctx, row) {
  return canReadAsset(ctx, row.asset_id) || canReadAsset(ctx, row.voice_asset_id) || canReadAsset(ctx, row.clean_plate_asset_id);
}

function selectAssets(db, ctx, assetIds) {
  const { tenantId, userId, versionId } = assertContext({ ...ctx, db });
  if (assetIds !== undefined) {
    const ids = [...new Set((Array.isArray(assetIds) ? assetIds : [assetIds]).map((id) => Number(id)))];
    if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      throw codedError('REDRAW_ASSET_NOT_FOUND', '转绘资产不存在');
    }
    const rows = db.prepare(`
      SELECT * FROM redraw_assets
      WHERE id IN (${ids.map(() => '?').join(',')})
        AND version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
      ORDER BY CASE kind WHEN 'character' THEN 1 WHEN 'scene' THEN 2 WHEN 'prop' THEN 3 WHEN 'voice' THEN 4 ELSE 9 END, id ASC
    `).all(...ids, versionId, tenantId, userId);
    if (rows.length !== ids.length) throw codedError('REDRAW_ASSET_NOT_FOUND', '转绘资产不存在或无权访问');
    return rows.filter((row) => ['draft', 'failed'].includes(String(row.status)) && !hasReadableSuccess({ ...ctx, db }, row));
  }
  return db.prepare(`
    SELECT * FROM redraw_assets
    WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
      AND status IN ('draft', 'failed')
    ORDER BY CASE kind WHEN 'character' THEN 1 WHEN 'scene' THEN 2 WHEN 'prop' THEN 3 WHEN 'voice' THEN 4 ELSE 9 END, id ASC
  `).all(versionId, tenantId, userId)
    .filter((row) => !hasReadableSuccess({ ...ctx, db }, row));
}

function rowToItem(row, version, ctx) {
  const capabilityName = capabilityForKind(row.kind);
  const sourcePayload = parseJson(row.source_ref_json, {});
  const prompt = String(row.prompt || '');
  const base = {
    asset_id: Number(row.id),
    version_id: Number(row.version_id),
    version_number: Number(row.version_number || 1),
    kind: row.kind,
    prompt_hash: hash(prompt),
    capability: capabilityName,
  };
  const resolved = redrawCapability.resolveVerifiedLocaleCapability(ctx.db, {
    locale: version.locale,
    market: version.market,
    capability: capabilityName,
    canReadArtifact: ctx.canReadArtifact,
  });
  if (!resolved) {
    return {
      ...base,
      source_ref: sourcePayload.source_ref || {},
      priced: false,
      blocking: { code: 'REDRAW_CAPABILITY_UNVERIFIED', message: `${capabilityName} 能力未验证` },
    };
  }
  try {
    const credits = modelPrice.requirePrice(ctx.db, resolved.model);
    return {
      ...base,
      source_ref: sourcePayload.source_ref || {},
      localized_name: row.localized_name || '',
      localized_description: row.localized_description || '',
      prompt,
      provider: resolved.provider,
      model: resolved.model,
      evidence: resolved.evidence,
      credits,
      priced: true,
    };
  } catch (error) {
    return {
      ...base,
      source_ref: sourcePayload.source_ref || {},
      provider: resolved.provider,
      model: resolved.model,
      evidence: resolved.evidence,
      priced: false,
      blocking: { code: error.code || 'MODEL_PRICE_NOT_CONFIGURED', message: error.message },
    };
  }
}

function quoteAssetBatch(db, input = {}) {
  const version = getVersion(db, input);
  const ctx = { ...input, db };
  const rows = selectAssets(db, ctx, input.assetIds ?? input.asset_ids);
  const items = rows.map((row) => rowToItem(row, version, ctx));
  if (items.length === 0) {
    const emptyQuote = {
      priced: false,
      version_id: Number(version.id),
      tenant_id: String(version.tenant_id),
      user_id: String(version.user_id),
      locale: version.locale || '',
      market: version.market || '',
      total_credits: 0,
      items: [],
      blocked: [{
        code: 'REDRAW_ASSET_BATCH_EMPTY',
        message: '没有可批量生成的转绘资产',
      }],
    };
    emptyQuote.quote_hash = hash({
      version_id: emptyQuote.version_id,
      locale: emptyQuote.locale,
      market: emptyQuote.market,
      items: [],
      blocked: emptyQuote.blocked,
      priced: false,
    });
    return emptyQuote;
  }
  const blocked = items
    .filter((item) => !item.priced)
    .map((item) => ({
      asset_id: item.asset_id,
      kind: item.kind,
      capability: item.capability,
      code: item.blocking.code,
      message: item.blocking.message,
    }));
  const priced = blocked.length === 0;
  const snapshotItems = items.map((item) => ({
    asset_id: item.asset_id,
    version_id: item.version_id,
    version_number: item.version_number,
    kind: item.kind,
    prompt_hash: item.prompt_hash,
    capability: item.capability,
    provider: item.provider || null,
    model: item.model || null,
    evidence: item.evidence || null,
    credits: item.credits || 0,
    source_ref: item.source_ref,
  }));
  const quote = {
    priced,
    version_id: Number(version.id),
    tenant_id: String(version.tenant_id),
    user_id: String(version.user_id),
    locale: version.locale || '',
    market: version.market || '',
    total_credits: priced ? items.reduce((sum, item) => sum + Number(item.credits || 0), 0) : 0,
    items,
    blocked,
  };
  quote.quote_hash = hash({
    version_id: quote.version_id,
    locale: quote.locale,
    market: quote.market,
    items: snapshotItems,
    blocked,
    priced,
  });
  return quote;
}

function rowToBatch(row) {
  if (!row) return null;
  const quoteSnapshot = parseJson(row.quote_snapshot_json, {});
  const attemptIds = parseJson(row.asset_ids_json, []);
  return {
    ...row,
    quote_snapshot: quoteSnapshot,
    selected_asset_ids: Array.isArray(quoteSnapshot.items) ? quoteSnapshot.items.map((item) => item.asset_id) : [],
    attempt_ids: attemptIds,
    asset_ids: attemptIds,
  };
}

function getAssetBatch(db, ctx, batchId) {
  const { tenantId, userId, versionId } = assertContext({ ...ctx, db });
  return rowToBatch(db.prepare(`
    SELECT * FROM redraw_asset_batches
    WHERE id = ? AND version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(Number(batchId), versionId, tenantId, userId));
}

function batchStatus(success, failed, total) {
  if (total > 0 && success === total) return 'completed';
  if (total > 0 && failed === total) return 'failed';
  if (success > 0 && failed > 0) return 'partial_failed';
  return 'processing';
}

function batchStatusFromCounts(success, failed, unknown, total) {
  if (unknown > 0) return 'needs_attention';
  return batchStatus(success, failed, total);
}

function createOwnedTask(db, log, type, resourceId, ctx) {
  const task = taskService.createTask(db, log, type, resourceId);
  db.prepare('UPDATE async_tasks SET tenant_id = ?, user_id = ? WHERE id = ?')
    .run(ctx.tenantId, ctx.userId, task.id);
  return taskService.getTask(db, task.id);
}

function updateProviderTask(db, taskId, providerTaskId) {
  if (!providerTaskId) return;
  try {
    db.prepare('UPDATE async_tasks SET provider_task_id = ?, updated_at = ? WHERE id = ?')
      .run(String(providerTaskId), new Date().toISOString(), taskId);
  } catch (_) {}
}

async function runPool(items, concurrency, worker) {
  let index = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      await worker(current);
    }
  });
  await Promise.all(workers);
}

function startAssetBatch(ctx = {}, input = {}, options = {}) {
  const base = assertContext(ctx);
  const idempotencyKey = String(input.idempotencyKey || input.idempotency_key || '').trim();
  if (!idempotencyKey) throw codedError('REDRAW_ASSET_BATCH_IDEMPOTENCY_REQUIRED', '缺少批量幂等键');
  const log = ctx.log || { info() {}, warn() {}, error() {} };

  let created;
  const tx = base.db.transaction(() => {
    const existing = base.db.prepare(`
      SELECT * FROM redraw_asset_batches
      WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND idempotency_key = ? AND deleted_at IS NULL
    `).get(base.versionId, base.tenantId, base.userId, idempotencyKey);
    options.trace?.({ event: 'idempotency_read', inImmediateTransaction: base.db.inTransaction === true, existing: Boolean(existing) });
    if (existing) {
      const existingBatch = rowToBatch(existing);
      const tracked = trackedBatchCompletions.get(Number(existing.id));
      const completion = tracked
        || (isTerminalBatchStatus(existing.status) ? Promise.resolve(existingBatch) : null);
      created = {
        replay: true,
        batch: existingBatch,
        task: taskService.getTask(base.db, existing.task_id),
        completion,
      };
      return;
    }
    const quote = quoteAssetBatch(base.db, { ...ctx, assetIds: input.assetIds ?? input.asset_ids });
    if (!quote.items.length) throw codedError('REDRAW_ASSET_BATCH_EMPTY', '没有可批量生成的转绘资产', { quote });
    if (!quote.priced) throw codedError('REDRAW_ASSET_BATCH_UNPRICED', '批量资产存在未验证能力或未配置价格', { quote });
    if (String(input.quoteHash || input.quote_hash || '') !== quote.quote_hash) {
      throw codedError('REDRAW_ASSET_BATCH_QUOTE_CHANGED', '批量报价已变化，请刷新后重试', { quote });
    }
    const parentTask = createOwnedTask(base.db, log, 'redraw_asset_batch', `redraw_asset_batch:${base.versionId}:${idempotencyKey}`, base);
    const now = new Date().toISOString();
    const batchResult = base.db.prepare(`INSERT INTO redraw_asset_batches
      (version_id, tenant_id, user_id, task_id, idempotency_key, quote_snapshot_json,
       asset_ids_json, status, total_count, success_count, failed_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, 0, ?, ?)`)
      .run(
        base.versionId,
        base.tenantId,
        base.userId,
        parentTask.id,
        idempotencyKey,
        JSON.stringify(quote),
        JSON.stringify([]),
        quote.items.length,
        now,
        now,
      );
    const batchId = Number(batchResult.lastInsertRowid);
    const childTasks = [];
    for (const item of quote.items) {
      const childTask = createOwnedTask(base.db, log, 'redraw_asset', `redraw_asset:${item.asset_id}`, base);
      const snapshot = {
        asset_id: item.asset_id,
        version_number: item.version_number,
        kind: item.kind,
        prompt_hash: item.prompt_hash,
        capability: item.capability,
        provider: item.provider,
        model: item.model,
        evidence: item.evidence,
        credits: item.credits,
        quote_hash: quote.quote_hash,
      };
      const attempt = createAssetAttempt({
        ...ctx,
        db: base.db,
        model: item.model,
        creditAmount: item.credits,
      }, {
        kind: item.kind,
        sourceRef: item.source_ref,
        localizedName: item.localized_name,
        localizedDescription: item.localized_description,
        prompt: item.prompt,
        snapshot,
        generationTaskId: childTask.id,
        operationKey: `redraw_asset_batch:${base.tenantId}:${base.userId}:${base.versionId}:${item.asset_id}:${item.version_number}:${item.prompt_hash}:${idempotencyKey}`,
      });
      childTasks.push({ item, childTask, attemptId: attempt.id });
    }
    base.db.prepare('UPDATE redraw_asset_batches SET asset_ids_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(childTasks.map((entry) => entry.attemptId)), new Date().toISOString(), batchId);
    created = {
      batch: rowToBatch(base.db.prepare('SELECT * FROM redraw_asset_batches WHERE id = ?').get(batchId)),
      task: parentTask,
      quote,
      childTasks,
    };
  });
  try {
    tx.immediate();
  } catch (error) {
    if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE' || error?.code === 'SQLITE_CONSTRAINT') {
      const existing = base.db.prepare(`
        SELECT * FROM redraw_asset_batches
        WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND idempotency_key = ? AND deleted_at IS NULL
      `).get(base.versionId, base.tenantId, base.userId, idempotencyKey);
      if (existing) {
        const batch = rowToBatch(existing);
        const tracked = trackedBatchCompletions.get(Number(existing.id));
        return {
          batch,
          task: taskService.getTask(base.db, existing.task_id),
          completion: tracked || (isTerminalBatchStatus(existing.status) ? Promise.resolve(batch) : null),
        };
      }
    }
    throw error;
  }
  if (created?.replay) {
    return { batch: created.batch, task: created.task, completion: created.completion };
  }

  const work = async () => {
    const now = new Date().toISOString();
    try {
      base.db.prepare("UPDATE redraw_asset_batches SET status = 'processing', updated_at = ? WHERE id = ?")
        .run(now, created.batch.id);
      taskService.updateTaskStatus(base.db, created.task.id, 'processing', 5, '正在批量生成转绘资产');
      await runPool(created.childTasks, Number(options.concurrency || ctx.concurrency || 3), async ({ item, childTask, attemptId }) => {
        const asset = base.db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(Number(attemptId));
        let result;
        try {
          taskService.updateTaskStatus(base.db, childTask.id, 'processing', 10, '正在生成转绘资产');
          if (typeof ctx.provider !== 'function') throw codedError('REDRAW_ASSET_PROVIDER_REQUIRED', '缺少资产生成 provider');
          result = await ctx.provider({
            taskId: childTask.id,
            batchId: created.batch.id,
            asset,
            model: item.model,
            capability: item.capability,
            locale: created.quote.locale,
            market: created.quote.market,
          });
        } catch (error) {
          if (isUnknownProviderResult(error)) {
            const providerTaskId = providerTaskIdOf(error);
            if (providerTaskId) updateProviderTask(base.db, childTask.id, providerTaskId);
            markAssetNeedsAttention(ctx, attemptId, error.message || '供应商任务状态未知');
            taskService.updateTaskStatus(base.db, childTask.id, 'needs_attention', 90, error.message || '供应商任务状态未知');
            return;
          }
          failAssetAttempt(ctx, attemptId, error);
          taskService.updateTaskError(base.db, childTask.id, String(error.message || error));
          return;
        }
        const providerTaskId = providerTaskIdOf(result);
        if (providerTaskId) updateProviderTask(base.db, childTask.id, providerTaskId);
        if (isUnknownProviderResult(result)) {
          markAssetNeedsAttention(ctx, attemptId, result?.error || '供应商任务状态未知');
          taskService.updateTaskStatus(base.db, childTask.id, 'needs_attention', 90, result?.error || '供应商任务状态未知');
          return;
        }
        if (!isCompletedProviderResult(result)) {
          const error = codedError('REDRAW_ASSET_GENERATION_FAILED', result?.error || '资产生成失败');
          failAssetAttempt(ctx, attemptId, error);
          taskService.updateTaskError(base.db, childTask.id, error.message);
          return;
        }
        try {
          if (item.kind === 'scene' && item.capability === 'clean_plate_image') {
            validateCleanPlateQuality(asset, {}, result || {});
          }
          const finalized = finalizeAssetAttempt(ctx, attemptId, {
            ...(result || {}),
            clean_plate: item.kind === 'scene' && item.capability === 'clean_plate_image',
          });
          taskService.updateTaskResult(base.db, childTask.id, { asset_id: finalized.id, status: finalized.status });
        } catch (error) {
          if (isSystemError(error)) throw error;
          failAssetAttempt(ctx, attemptId, error);
          taskService.updateTaskError(base.db, childTask.id, String(error.message || error));
        }
      });
    } catch (error) {
      try {
        const timestamp = new Date().toISOString();
        base.db.prepare(`
          UPDATE redraw_asset_batches
          SET status = 'needs_attention', error_code = 'REDRAW_ASSET_BATCH_SYSTEM_UNKNOWN',
              error_message = ?, updated_at = ?
          WHERE id = ?
        `).run(String(error.message || error), timestamp, created.batch.id);
        taskService.updateTaskStatus(base.db, created.task.id, 'needs_attention', 90, '批量资产生成状态未知，请人工确认');
      } catch (_) {}
      throw error;
    }
    const counts = base.db.prepare(`
      SELECT
        SUM(CASE WHEN status IN ('generated', 'needs_attention') AND error_code IS NULL THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'needs_attention' AND error_code IS NOT NULL THEN 1 ELSE 0 END) AS unknown
      FROM redraw_assets
      WHERE id IN (${created.childTasks.map(() => '?').join(',')})
    `).get(...created.childTasks.map((entry) => Number(entry.attemptId)));
    const success = Number(counts.success || 0);
    const failed = Number(counts.failed || 0);
    const unknown = Number(counts.unknown || 0);
    const status = batchStatusFromCounts(success, failed, unknown, created.childTasks.length);
    const completedAt = ['completed', 'partial_failed', 'failed'].includes(status) ? new Date().toISOString() : null;
    base.db.prepare(`
      UPDATE redraw_asset_batches
      SET status = ?, success_count = ?, failed_count = ?, error_message = ?, updated_at = ?, completed_at = ?
      WHERE id = ?
    `).run(
      status,
      success,
      failed,
      unknown > 0 ? '部分资产生成状态未知' : failed > 0 ? '部分资产生成失败' : null,
      new Date().toISOString(),
      completedAt,
      created.batch.id,
    );
    const finalBatch = rowToBatch(base.db.prepare('SELECT * FROM redraw_asset_batches WHERE id = ?').get(created.batch.id));
    if (status === 'completed') taskService.updateTaskResult(base.db, created.task.id, { batch_id: created.batch.id, success_count: success, failed_count: failed });
    else if (status === 'needs_attention') taskService.updateTaskStatus(base.db, created.task.id, 'needs_attention', 90, finalBatch.error_message || '批量资产生成状态未知');
    else taskService.updateTaskError(base.db, created.task.id, finalBatch.error_message || '批量资产生成失败');
    return finalBatch;
  };
  const scheduler = typeof ctx.schedule === 'function'
    ? ctx.schedule
    : (job) => taskService.trackInFlightTask(created.task.id, Promise.resolve().then(job));
  const completion = Promise.resolve(scheduler(work)).then((value) => value);
  trackedBatchCompletions.set(Number(created.batch.id), completion);
  const removeTracked = () => {
    if (trackedBatchCompletions.get(Number(created.batch.id)) === completion) trackedBatchCompletions.delete(Number(created.batch.id));
  };
  completion.then(removeTracked, removeTracked);
  return { batch: created.batch, task: created.task, completion };
}

function reconcileOrphanedBatches(db, log = { warn() {}, info() {} }) {
  const rows = db.prepare(`
    SELECT * FROM redraw_asset_batches
    WHERE status IN ('pending', 'processing') AND deleted_at IS NULL
  `).all();
  let changed = 0;
  for (const batch of rows) {
    const quote = parseJson(batch.quote_snapshot_json, {});
    const ids = parseJson(batch.asset_ids_json, []);
    const taskIds = ids.length ? ids : (quote.items?.map((item) => item.asset_id) || []);
    const assets = taskIds.length ? db.prepare(`
      SELECT * FROM redraw_assets WHERE id IN (${taskIds.map(() => '?').join(',')}) AND deleted_at IS NULL
    `).all(...taskIds) : [];
    const maybeDispatched = assets.some((asset) => {
      const generationTaskId = String(asset.generation_task_id || '').trim();
      if (!generationTaskId) return false;
      const childTask = db.prepare(`
        SELECT provider_task_id FROM async_tasks
        WHERE id = ? AND type = 'redraw_asset' AND deleted_at IS NULL
      `).get(generationTaskId);
      if (childTask) return String(childTask.provider_task_id || '').trim() !== '';
      return true;
    });
    const timestamp = new Date().toISOString();
    if (maybeDispatched) {
      db.prepare(`
        UPDATE redraw_asset_batches
        SET status = 'needs_attention', error_code = 'REDRAW_ASSET_BATCH_NEEDS_ATTENTION',
            error_message = ?, updated_at = ?
        WHERE id = ?
      `).run('服务重启后批量资产可能已派发，请人工确认供应商状态', timestamp, batch.id);
      taskService.updateTaskStatus(db, batch.task_id, 'needs_attention', 90, '服务重启后批量资产可能已派发');
    } else {
      for (const asset of assets) {
        failAssetAttempt({ db, tenantId: batch.tenant_id, userId: batch.user_id, versionId: batch.version_id }, asset.id, {
          code: 'REDRAW_ASSET_BATCH_ORPHANED',
          message: taskService.ORPHAN_ASYNC_TASK_MSG,
        });
      }
      db.prepare(`
        UPDATE redraw_asset_batches
        SET status = 'failed', failed_count = total_count,
            error_code = 'REDRAW_ASSET_BATCH_ORPHANED', error_message = ?, updated_at = ?, completed_at = ?
        WHERE id = ?
      `).run(taskService.ORPHAN_ASYNC_TASK_MSG, timestamp, timestamp, batch.id);
      taskService.updateTaskError(db, batch.task_id, taskService.ORPHAN_ASYNC_TASK_MSG);
    }
    changed += 1;
    log.warn?.('redraw asset batch reconciled', { batch_id: batch.id, status: maybeDispatched ? 'needs_attention' : 'failed' });
  }
  return changed;
}

module.exports = {
  quoteAssetBatch,
  startAssetBatch,
  getAssetBatch,
  batchStatus,
  reconcileOrphanedBatches,
};
