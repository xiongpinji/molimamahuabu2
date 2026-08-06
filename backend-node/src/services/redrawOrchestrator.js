const creditLedger = require('./creditLedgerService');
const modelPrice = require('./modelPriceService');
const taskService = require('./taskService');
const { normalizeSourceFacts } = require('./redrawAnalysisService');

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseSettings(row) {
  if (!row?.settings) return {};
  try {
    return typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings;
  } catch (_) {
    return {};
  }
}

function loadVerifiedCapability(db) {
  const rows = db.prepare(
    `SELECT * FROM ai_service_configs
     WHERE deleted_at IS NULL AND service_type = 'video_understanding' AND is_active = 1
     ORDER BY is_default DESC, priority DESC, id ASC`
  ).all();
  for (const row of rows) {
    const settings = parseSettings(row);
    const evidence = settings.evidence || settings.real_generation_evidence || {};
    if (
      settings.real_generation_verified === true &&
      evidence.provider_task_id &&
      evidence.result_asset_id &&
      evidence.result_asset_readable === true &&
      evidence.completed_at
    ) {
      return row;
    }
  }
  throw codedError('VIDEO_UNDERSTANDING_NOT_VERIFIED', '视频理解模型缺少真实生成且结果可读的验证证据');
}

function getWork(db, workId) {
  return db.prepare('SELECT * FROM redraw_works WHERE id = ?').get(String(workId)) || null;
}

function getTask(db, taskId) {
  return db.prepare('SELECT * FROM async_tasks WHERE id = ? AND deleted_at IS NULL').get(String(taskId)) || null;
}

function getAsset(db, assetId) {
  if (!assetId) return null;
  try {
    return db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(String(assetId)) || null;
  } catch (_) {
    return { id: String(assetId) };
  }
}

function defaultCanRead(asset) {
  return Boolean(asset && (asset.local_path || asset.url || asset.id));
}

function assertAssetReadable(db, assetReader, assetId, label) {
  const asset = getAsset(db, assetId);
  const canRead = assetReader?.canRead || defaultCanRead;
  if (!asset || !canRead(asset)) throw codedError('ASSET_NOT_READABLE', `${label}资产不可回读`);
  return asset;
}

function safeUpdate(db, sql, params) {
  try {
    return db.prepare(sql).run(...params);
  } catch (error) {
    if (/no such column/i.test(String(error.message || ''))) return null;
    throw error;
  }
}

async function startAnalysis(db, log, input, options = {}) {
  const work = getWork(db, input.workId);
  if (!work) throw codedError('REDRAW_WORK_NOT_FOUND', '转绘作品不存在');
  const userId = String(input.userId || work.user_id || '');
  if (!userId) throw codedError('UNAUTHORIZED', '缺少用户身份');

  const config = loadVerifiedCapability(db);
  const model = modelPrice.canonicalModel(config.default_model || config.model || 'GPT-5.5');
  const price = modelPrice.calculateCharge(db, model);
  const sourceAssetId = input.sourceAssetId || work.source_asset_id;
  if (!sourceAssetId) throw codedError('SOURCE_ASSET_REQUIRED', '缺少源片资产');

  const now = new Date().toISOString();
  const created = db.transaction(() => {
    const reservation = creditLedger.reserve(db, {
      userId,
      operationKey: `redraw_analysis:${work.id}:${sourceAssetId}`,
      amount: price,
      model,
      resourceType: 'redraw_analysis',
      resourceId: work.id,
    });
    const task = taskService.createTask(db, log, 'redraw_analysis', work.id);
    safeUpdate(
      db,
      'UPDATE async_tasks SET user_id = ?, model = ?, credit_reservation_id = ?, status = ?, progress = ?, message = ?, updated_at = ? WHERE id = ?',
      [userId, model, reservation.id, 'processing', 10, '源片分析已开始', now, task.id]
    );
    db.prepare(
      `UPDATE redraw_works
       SET source_asset_id = ?, status = 'processing', current_step = 1, task_id = ?,
           credit_reservation_id = ?, updated_at = ?
       WHERE id = ?`
    ).run(sourceAssetId, task.id, reservation.id, now, work.id);
    return { task_id: task.id, reservation_id: reservation.id, model };
  })();

  const providerResult = options.provider?.startAnalysis
    ? await options.provider.startAnalysis({ work, sourceAssetId, config, operationKey: `redraw_analysis:${work.id}:${sourceAssetId}` })
    : {};
  const providerTaskId = providerResult?.provider_task_id || providerResult?.task_id || '';
  if (providerTaskId) {
    safeUpdate(db, 'UPDATE async_tasks SET provider_task_id = ?, updated_at = ? WHERE id = ?', [String(providerTaskId), new Date().toISOString(), created.task_id]);
    db.prepare('UPDATE redraw_works SET provider_task_id = ?, updated_at = ? WHERE id = ?')
      .run(String(providerTaskId), new Date().toISOString(), work.id);
  }
  return { ...created, provider_task_id: providerTaskId || null };
}

function markFailure(db, log, task, work, message) {
  const now = new Date().toISOString();
  db.prepare('UPDATE redraw_works SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?')
    .run('failed', String(message || '').slice(0, 500), now, work.id);
  taskService.updateTaskError(db, task.id, message || '源片分析失败');
  creditLedger.settleGeneration(db, task.credit_reservation_id || work.credit_reservation_id, 'failed', message || '源片分析失败');
  log?.warn?.('redraw analysis failed', { task_id: task.id, work_id: work.id, message });
}

function markNeedsAttention(db, task, work, message) {
  const now = new Date().toISOString();
  db.prepare('UPDATE redraw_works SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?')
    .run('needs_attention', String(message || '').slice(0, 500), now, work.id);
  safeUpdate(
    db,
    'UPDATE async_tasks SET status = ?, progress = ?, message = ?, error = ?, updated_at = ? WHERE id = ?',
    ['needs_attention', 90, message || '源片分析状态未知', message || '源片分析状态未知', now, task.id]
  );
}

function writeFactsOnce(db, work, normalized) {
  const now = new Date().toISOString();
  let version = db.prepare(
    'SELECT * FROM redraw_versions WHERE work_id = ? AND source_facts_json IS NOT NULL ORDER BY id ASC LIMIT 1'
  ).get(work.id);
  if (!version) {
    const existing = db.prepare('SELECT * FROM redraw_versions WHERE work_id = ? ORDER BY id ASC LIMIT 1').get(work.id);
    if (existing) {
      db.prepare('UPDATE redraw_versions SET source_facts_json = ?, facts_hash = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(normalized), normalized.facts_hash, now, existing.id);
      version = { ...existing, source_facts_json: JSON.stringify(normalized), facts_hash: normalized.facts_hash };
    } else {
      const id = db.prepare(
        'INSERT INTO redraw_versions (work_id, source_facts_json, facts_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(work.id, JSON.stringify(normalized), normalized.facts_hash, now, now).lastInsertRowid;
      version = { id, work_id: work.id, source_facts_json: JSON.stringify(normalized), facts_hash: normalized.facts_hash };
    }
  }
  for (const shot of normalized.shots) {
    db.prepare(
      `INSERT OR IGNORE INTO redraw_shots
        (work_id, version_id, shot_id, start_ms, end_ms, draft_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
    ).run(work.id, version.id, shot.id, shot.start_ms, shot.end_ms, JSON.stringify(shot), now, now);
  }
  db.prepare('UPDATE redraw_works SET status = ?, current_step = ?, error_msg = NULL, updated_at = ? WHERE id = ?')
    .run('asset_review', 2, now, work.id);
  return version;
}

async function runAnalyzeTask(db, log, taskId, options = {}) {
  const task = getTask(db, taskId);
  if (!task || task.type !== 'redraw_analysis') return null;
  const work = getWork(db, task.resource_id);
  if (!work) throw codedError('REDRAW_WORK_NOT_FOUND', '转绘作品不存在');
  const providerTaskId = task.provider_task_id || work.provider_task_id;
  const result = options.provider?.pollAnalysisTask
    ? await options.provider.pollAnalysisTask({ task, work, providerTaskId })
    : { status: 'processing' };

  if (result.status === 'processing' || result.status === 'pending') {
    taskService.updateTaskStatus(db, task.id, 'processing', 90, '供应商仍在分析源片');
    return { status: 'processing' };
  }
  if (result.status === 'failed') {
    markFailure(db, log, task, work, result.error || '供应商源片分析失败');
    return { status: 'failed' };
  }
  if (result.status !== 'completed') {
    markNeedsAttention(db, task, work, '源片分析状态未知，请人工确认后再处理');
    return { status: 'needs_attention' };
  }

  try {
    assertAssetReadable(db, options.assetReader, work.source_asset_id, '源片');
    assertAssetReadable(db, options.assetReader, result.result_asset_id || result.result_asset?.id, '分析结果');
    const normalized = normalizeSourceFacts(result.facts || result.source_facts);
    const version = db.transaction(() => writeFactsOnce(db, work, normalized))();
    taskService.updateTaskResult(db, task.id, {
      status: 'completed',
      work_id: work.id,
      version_id: version.id,
      facts_hash: normalized.facts_hash,
    });
    creditLedger.settleGeneration(db, task.credit_reservation_id || work.credit_reservation_id, 'completed');
    return { status: 'completed', facts_hash: normalized.facts_hash };
  } catch (error) {
    markFailure(db, log, task, work, error.message);
    return { status: 'failed', error: error.message };
  }
}

async function resumeRedrawTasks(db, log, options = {}) {
  let rows;
  try {
    rows = db.prepare(
      `SELECT t.id AS task_id, t.provider_task_id AS task_provider_task_id,
              w.id AS work_id, w.provider_task_id AS work_provider_task_id
       FROM async_tasks t
       JOIN redraw_works w ON w.id = t.resource_id
       WHERE t.type = 'redraw_analysis' AND t.status = 'processing' AND t.deleted_at IS NULL`
    ).all();
  } catch (error) {
    if (!/no such column: t\.provider_task_id/i.test(String(error.message || ''))) throw error;
    rows = db.prepare(
      `SELECT t.id AS task_id, NULL AS task_provider_task_id,
              w.id AS work_id, w.provider_task_id AS work_provider_task_id
       FROM async_tasks t
       JOIN redraw_works w ON w.id = t.resource_id
       WHERE t.type = 'redraw_analysis' AND t.status = 'processing' AND t.deleted_at IS NULL`
    ).all();
  }
  let resumed = 0;
  let failed = 0;
  for (const row of rows) {
    const providerTaskId = row.task_provider_task_id || row.work_provider_task_id;
    if (providerTaskId && String(providerTaskId).trim()) {
      resumed += 1;
      await runAnalyzeTask(db, log, row.task_id, options);
    } else {
      const task = getTask(db, row.task_id);
      const work = getWork(db, row.work_id);
      markFailure(db, log, task, work, '服务重启后无法恢复源片分析（缺少厂商任务 ID）');
      failed += 1;
    }
  }
  return { resumed, failed };
}

module.exports = {
  startAnalysis,
  runAnalyzeTask,
  resumeRedrawTasks,
  loadVerifiedCapability,
};
