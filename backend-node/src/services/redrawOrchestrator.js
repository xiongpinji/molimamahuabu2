const fs = require('fs');
const path = require('path');
const creditLedger = require('./creditLedgerService');
const modelPrice = require('./modelPriceService');
const taskService = require('./taskService');
const { normalizeSourceFacts } = require('./redrawAnalysisService');

const DEFAULT_RESUME_QUERY_TIMEOUT_MS = 10_000;
const RESUME_ERROR_SNIPPET_LIMIT = 512;

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

function quoteAnalysis(db) {
  try {
    const config = loadVerifiedCapability(db);
    const model = modelPrice.canonicalModel(config.default_model || config.model || 'GPT-5.5');
    const amount = modelPrice.calculateCharge(db, model);
    return { model, credits: amount, amount };
  } catch (_) {
    return null;
  }
}

function getWork(db, workId) {
  return db.prepare('SELECT * FROM redraw_works WHERE id = ?').get(String(workId)) || null;
}

function getTask(db, taskId) {
  return db.prepare('SELECT * FROM async_tasks WHERE id = ? AND deleted_at IS NULL').get(String(taskId)) || null;
}

function getAsset(db, assetId) {
  if (!assetId) return null;
  return db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(assetId) || null;
}

function defaultCanRead(asset) {
  return createAssetReader({}).canRead(asset);
}

function isPathInside(parent, child) {
  const from = process.platform === 'win32' ? path.resolve(parent).toLowerCase() : path.resolve(parent);
  const to = process.platform === 'win32' ? path.resolve(child).toLowerCase() : path.resolve(child);
  const relative = path.relative(from, to);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function createAssetReader(options = {}) {
  const storageRoot = path.resolve(options.storageRoot || process.cwd());
  return {
    canRead(asset) {
      if (!asset) return false;
      if (asset.local_path) {
        const localPath = String(asset.local_path);
        if (path.isAbsolute(localPath)) return false;
        const absPath = path.resolve(storageRoot, localPath);
        try {
          const realRoot = fs.realpathSync(storageRoot);
          if (!isPathInside(realRoot, absPath)) return false;
          const realPath = fs.realpathSync(absPath);
          if (!isPathInside(realRoot, realPath)) return false;
          fs.accessSync(realPath, fs.constants.R_OK);
          return true;
        } catch (_) {
          return false;
        }
      }
      return asset.readable === true || asset.readable === 1 || asset.readable === 'true';
    },
  };
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

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function insertDynamic(db, table, values) {
  const columns = tableColumns(db, table);
  const names = Object.keys(values).filter((name) => columns.has(name));
  const placeholders = names.map(() => '?').join(', ');
  return db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${placeholders})`)
    .run(...names.map((name) => values[name]));
}

function buildUrl(baseUrl, endpoint, providerTaskId) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  const ep = String(endpoint || '').trim();
  if (!base || !ep) return '';
  const replaced = ep.replace('{taskId}', encodeURIComponent(String(providerTaskId)));
  return replaced.startsWith('http://') || replaced.startsWith('https://')
    ? replaced
    : `${base}${replaced.startsWith('/') ? '' : '/'}${replaced}`;
}

function normalizeProviderResult(payload) {
  const status = String(payload?.status || payload?.state || payload?.task_status || '').toLowerCase();
  if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(status)) {
    return {
      status: 'completed',
      result_asset_id: payload.result_asset_id || payload.asset_id || payload.result_asset?.id,
      facts: payload.facts || payload.source_facts || payload.result?.facts || payload.result?.source_facts,
    };
  }
  if (['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(status)) {
    return { status: 'failed', error: payload.error || payload.message || '供应商源片分析失败' };
  }
  if (['processing', 'pending', 'running', 'queued', 'in_progress'].includes(status)) {
    return { status: 'processing' };
  }
  return { status: 'unknown', error: '源片分析状态未知，请人工确认后再处理' };
}

function createProviderResumeUnavailable(message) {
  return codedError('REDRAW_PROVIDER_RESUME_UNAVAILABLE', message || '源片分析供应商恢复查询不可用');
}

function resumeQueryTimeoutMs() {
  const raw = Number(process.env.REDRAW_RESUME_QUERY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_RESUME_QUERY_TIMEOUT_MS;
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

async function readErrorSnippet(response) {
  try {
    if (!response.body?.getReader) return (await response.text()).slice(0, RESUME_ERROR_SNIPPET_LIMIT);
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (total < RESUME_ERROR_SNIPPET_LIMIT) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8', 0, RESUME_ERROR_SNIPPET_LIMIT);
  } catch (_) {
    return '';
  }
}

function createStartupResumeOptions(db, log, options = {}) {
  let config = null;
  try {
    config = db ? loadVerifiedCapability(db) : null;
  } catch (error) {
    log?.warn?.('redraw resume capability unavailable', { code: error.code, message: error.message });
  }
  const queryEndpoint = config?.query_endpoint || parseSettings(config)?.query_endpoint;
  const queryUrlTemplate = buildUrl(config?.base_url, queryEndpoint, '{taskId}');
  return {
    provider: {
      pollAnalysisTask: async ({ providerTaskId }) => {
        if (!queryUrlTemplate) {
          throw createProviderResumeUnavailable('video_understanding 未配置 query_endpoint，无法恢复源片分析任务');
        }
        const url = buildUrl(config.base_url, queryEndpoint, providerTaskId);
        const headers = {};
        if (config.api_key) headers.authorization = `Bearer ${config.api_key}`;
        try {
          const response = await fetch(url, { method: 'GET', headers, signal: timeoutSignal(resumeQueryTimeoutMs()) });
          if (!response.ok) {
            const detail = await readErrorSnippet(response);
            throw createProviderResumeUnavailable(`源片分析恢复查询失败: HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
          }
          return normalizeProviderResult(await response.json());
        } catch (error) {
          if (error.code === 'REDRAW_PROVIDER_RESUME_UNAVAILABLE') throw error;
          throw createProviderResumeUnavailable(`源片分析恢复查询不可用: ${error.message}`);
        }
      },
    },
    assetReader: createAssetReader({ storageRoot: options.storageRoot }),
  };
}

async function startAnalysis(db, log, input, options = {}) {
  const work = getWork(db, input.workId);
  if (!work) throw codedError('REDRAW_WORK_NOT_FOUND', '转绘作品不存在');
  const userId = String(input.userId || work.user_id || '');
  const tenantId = input.tenantId || work.tenant_id;
  if (!userId) throw codedError('UNAUTHORIZED', '缺少用户身份');

  const config = loadVerifiedCapability(db);
  const model = modelPrice.canonicalModel(config.default_model || config.model || 'GPT-5.5');
  const price = modelPrice.calculateCharge(db, model);
  const sourceAssetId = input.sourceAssetId || work.source_asset_id;
  if (!sourceAssetId) throw codedError('SOURCE_ASSET_REQUIRED', '缺少源片资产');
  const analysisSettings = input.analysisSettings && typeof input.analysisSettings === 'object'
    ? input.analysisSettings
    : {};
  const metadata = JSON.stringify({ redraw_analysis: analysisSettings });

  const now = new Date().toISOString();
  const created = db.transaction(() => {
    const reservation = creditLedger.reserve(db, {
      userId,
      tenantId: tenantId == null ? null : String(tenantId),
      actorUserId: userId,
      operationKey: `redraw_analysis:${work.id}:${sourceAssetId}`,
      amount: price,
      model,
      resourceType: 'redraw_analysis',
      resourceId: work.id,
    });
    const task = taskService.createTask(db, log, 'redraw_analysis', work.id);
    db.prepare(
      'UPDATE async_tasks SET user_id = ?, model = ?, credit_reservation_id = ?, status = ?, progress = ?, message = ?, updated_at = ? WHERE id = ?'
    ).run(userId, model, reservation.id, 'processing', 10, '源片分析已开始', now, task.id);
    db.prepare('UPDATE async_tasks SET metadata = ?, updated_at = ? WHERE id = ?')
      .run(metadata, now, task.id);
    db.prepare(
      `UPDATE redraw_works
       SET source_asset_id = ?, status = 'analyzing', current_step = 1, task_id = ?,
           credit_reservation_id = ?, updated_at = ?
       WHERE id = ?`
    ).run(sourceAssetId, task.id, reservation.id, now, work.id);
    return {
      task_id: task.id,
      reservation_id: reservation.id,
      model,
      billing: { charged: 0, held: reservation.amount, released: 0 },
    };
  })();

  let providerResult;
  try {
    providerResult = options.provider?.startAnalysis
      ? await options.provider.startAnalysis({
        work,
        sourceAssetId,
        config,
        analysisSettings,
        operationKey: `redraw_analysis:${work.id}:${sourceAssetId}`,
      })
      : {};
  } catch (error) {
    markFailure(db, log, getTask(db, created.task_id), getWork(db, work.id), error.message);
    throw error;
  }
  const providerTaskId = providerResult?.provider_task_id || providerResult?.task_id || '';
  if (!providerTaskId) {
    const error = codedError('PROVIDER_TASK_ID_REQUIRED', '源片分析启动失败：缺少厂商任务 ID');
    markFailure(db, log, getTask(db, created.task_id), getWork(db, work.id), error.message);
    throw error;
  }
  if (providerTaskId) {
    db.prepare('UPDATE async_tasks SET provider_task_id = ?, updated_at = ? WHERE id = ?')
      .run(String(providerTaskId), new Date().toISOString(), created.task_id);
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
  if (version) {
    if (version.facts_hash === normalized.facts_hash) return { version, changed: false };
    const error = codedError('SOURCE_FACTS_HASH_CONFLICT', '源片事实 hash 冲突，请人工确认后再继续');
    error.existing_hash = version.facts_hash;
    error.incoming_hash = normalized.facts_hash;
    throw error;
  } else {
    const existing = db.prepare('SELECT * FROM redraw_versions WHERE work_id = ? ORDER BY id ASC LIMIT 1').get(work.id);
    if (existing) {
      db.prepare('UPDATE redraw_versions SET source_facts_json = ?, facts_hash = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(normalized), normalized.facts_hash, now, existing.id);
      version = { ...existing, source_facts_json: JSON.stringify(normalized), facts_hash: normalized.facts_hash };
    } else {
      const id = insertDynamic(db, 'redraw_versions', {
        work_id: work.id,
        tenant_id: work.tenant_id || null,
        user_id: work.user_id || null,
        version: 1,
        locale: 'source',
        market: '',
        localization_level: 'faithful',
        source_facts_json: JSON.stringify(normalized),
        facts_hash: normalized.facts_hash,
        status: 'asset_review',
        created_at: now,
        updated_at: now,
      }).lastInsertRowid;
      version = { id, work_id: work.id, source_facts_json: JSON.stringify(normalized), facts_hash: normalized.facts_hash };
    }
  }
  const shotColumns = tableColumns(db, 'redraw_shots');
  for (const [index, shot] of normalized.shots.entries()) {
    if (shotColumns.has('work_id')) {
      const existingShot = db.prepare('SELECT id FROM redraw_shots WHERE work_id = ? AND shot_id = ? LIMIT 1').get(work.id, shot.id);
      if (existingShot) continue;
    } else {
      const existingShot = db.prepare('SELECT id FROM redraw_shots WHERE version_id = ? AND batch_index = ? AND shot_index = ? LIMIT 1')
        .get(version.id, 1, index + 1);
      if (existingShot) continue;
    }
    insertDynamic(db, 'redraw_shots', {
      work_id: work.id,
      version_id: version.id,
      tenant_id: work.tenant_id || null,
      user_id: work.user_id || null,
      shot_id: shot.id,
      batch_index: 1,
      shot_index: index + 1,
      start_ms: shot.start_ms,
      end_ms: shot.end_ms,
      duration_ms: shot.end_ms - shot.start_ms,
      source_dialogue_json: JSON.stringify(shot.dialogue || []),
      localized_dialogue_json: JSON.stringify(shot.dialogue || []),
      opening_state: shot.opening_state,
      continuous_action: shot.continuous_action,
      ending_state: shot.ending_state,
      draft_json: JSON.stringify(shot),
      status: 'draft',
      created_at: now,
      updated_at: now,
    });
  }
  db.prepare('UPDATE redraw_works SET status = ?, current_step = ?, error_msg = NULL, updated_at = ? WHERE id = ?')
    .run('asset_review', 2, now, work.id);
  return { version, changed: true };
}

async function runAnalyzeTask(db, log, taskId, options = {}) {
  const task = getTask(db, taskId);
  if (!task || task.type !== 'redraw_analysis') return null;
  const work = getWork(db, task.resource_id);
  if (!work) throw codedError('REDRAW_WORK_NOT_FOUND', '转绘作品不存在');
  const providerTaskId = task.provider_task_id || work.provider_task_id;
  let result;
  try {
    result = options.provider?.pollAnalysisTask
      ? await options.provider.pollAnalysisTask({ task, work, providerTaskId })
      : { status: 'unknown', error: '源片分析供应商恢复查询不可用' };
  } catch (error) {
    if (error.code === 'REDRAW_PROVIDER_RESUME_UNAVAILABLE') {
      markNeedsAttention(db, task, work, error.message);
      return { status: 'needs_attention', error: error.message };
    }
    throw error;
  }

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
    const { version, changed } = db.transaction(() => writeFactsOnce(db, work, normalized))();
    if (changed || task.status !== 'completed') {
      taskService.updateTaskResult(db, task.id, {
        status: 'completed',
        work_id: work.id,
        version_id: version.id,
        facts_hash: normalized.facts_hash,
      });
      creditLedger.settleGeneration(db, task.credit_reservation_id || work.credit_reservation_id, 'completed');
    }
    return { status: 'completed', facts_hash: normalized.facts_hash };
  } catch (error) {
    if (error.code === 'SOURCE_FACTS_HASH_CONFLICT') {
      markNeedsAttention(db, task, work, error.message);
      return { status: 'needs_attention', error: error.message };
    }
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
       WHERE t.type = 'redraw_analysis' AND t.status = 'processing' AND w.status = 'analyzing' AND t.deleted_at IS NULL`
    ).all();
  } catch (error) {
    if (!/no such column: t\.provider_task_id/i.test(String(error.message || ''))) throw error;
    rows = db.prepare(
      `SELECT t.id AS task_id, NULL AS task_provider_task_id,
              w.id AS work_id, w.provider_task_id AS work_provider_task_id
       FROM async_tasks t
       JOIN redraw_works w ON w.id = t.resource_id
       WHERE t.type = 'redraw_analysis' AND t.status = 'processing' AND w.status = 'analyzing' AND t.deleted_at IS NULL`
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
  quoteAnalysis,
  loadVerifiedCapability,
  createStartupResumeOptions,
  createAssetReader,
};
