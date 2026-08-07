const { v4: uuidv4 } = require('uuid');
const creditLedger = require('./creditLedgerService');

function createTask(db, log, taskType, resourceId) {
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO async_tasks (id, type, status, progress, message, resource_id, created_at, updated_at)
     VALUES (?, ?, 'pending', 0, '', ?, ?, ?)`
  ).run(id, taskType, resourceId || '', now, now);
  log.info('Task created', { task_id: id, type: taskType, resource_id: resourceId });
  const task = getTask(db, id);
  return task || { id, type: taskType, status: 'pending', progress: 0, message: '', resource_id: resourceId || '', created_at: now, updated_at: now, completed_at: null };
}

function getTask(db, taskId) {
  const row = db.prepare('SELECT * FROM async_tasks WHERE id = ? AND deleted_at IS NULL').get(taskId);
  if (!row) return null;
  return rowToTask(row);
}

function getTasksByResource(db, resourceId, options = {}) {
  const ownerClause = options.tenantId
    ? ' AND tenant_id = ?'
    : options.userId ? ' AND user_id = ?' : '';
  const ownerParams = options.tenantId
    ? [String(options.tenantId)]
    : options.userId ? [String(options.userId)] : [];
  const rows = db.prepare(
    `SELECT * FROM async_tasks
     WHERE resource_id = ? AND deleted_at IS NULL${ownerClause}
     ORDER BY created_at DESC`
  ).all(resourceId, ...ownerParams);
  return rows.map(rowToTask);
}

function updateTaskStatus(db, taskId, status, progress, message) {
  const now = new Date().toISOString();
  let completedAt = null;
  if (status === 'completed' || status === 'failed') completedAt = now;
  db.prepare(
    `UPDATE async_tasks SET status = ?, progress = ?, message = ?, updated_at = ?, completed_at = ?
     WHERE id = ?`
  ).run(status, progress ?? 0, message || '', now, completedAt, taskId);
}

async function withTaskHeartbeat(db, taskId, message, operation, intervalMs = 60_000) {
  if (!taskId) return operation();
  const touch = () => db.prepare(
    `UPDATE async_tasks
     SET status = 'processing', progress = 10, message = ?, updated_at = ?
     WHERE id = ? AND status IN ('pending', 'processing')`
  ).run(message || '', new Date().toISOString(), taskId);
  touch();
  const timer = setInterval(() => {
    touch();
  }, intervalMs);
  timer.unref?.();
  try {
    return await operation();
  } finally {
    clearInterval(timer);
  }
}

function updateTaskError(db, taskId, errMsg) {
  const now = new Date().toISOString();
  try {
    db.prepare(
      `UPDATE async_tasks SET status = 'failed', error = ?, progress = 0, completed_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(errMsg || '', now, now, taskId);
  } catch (e) {
    if ((e.message || '').includes('error')) {
      updateTaskStatus(db, taskId, 'failed', 0, errMsg || '任务失败');
    } else throw e;
  }
}

function updateTaskResult(db, taskId, result) {
  const now = new Date().toISOString();
  const resultStr = typeof result === 'string' ? result : JSON.stringify(result || {});
  db.prepare(
    `UPDATE async_tasks SET status = 'completed', progress = 100, result = ?, completed_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(resultStr, now, now, taskId);
}

function rowToTask(r) {
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    progress: r.progress ?? 0,
    message: r.message,
    error: r.error,
    result: r.result,
    resource_id: r.resource_id,
    tenant_id: r.tenant_id,
    user_id: r.user_id,
    model: r.model,
    credit_reservation_id: r.credit_reservation_id,
    provider_task_id: r.provider_task_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    completed_at: r.completed_at,
  };
}

const ORPHAN_ASYNC_TASK_MSG = '服务重启后任务中断，请重新操作';
const USER_CANCEL_TASK_MSG = '用户已取消';
const inFlightTasks = new Map();

function trackInFlightTask(taskId, work) {
  const key = String(taskId);
  const tracked = Promise.resolve(work);
  inFlightTasks.set(key, tracked);
  const remove = () => {
    if (inFlightTasks.get(key) === tracked) inFlightTasks.delete(key);
  };
  tracked.then(remove, remove);
  return tracked;
}

function getInFlightTaskCount() {
  return inFlightTasks.size;
}

async function waitForInFlightTasks(timeoutMs = 60_000) {
  const tasks = [...inFlightTasks.values()];
  if (!tasks.length) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, Number(timeoutMs) || 0));
    Promise.allSettled(tasks).then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function reconcileOrphanedScriptAnalysisProjects(db, log) {
  const now = new Date().toISOString();
  try {
    const result = db.prepare(`
      UPDATE script_analysis_projects
      SET status = 'failed', review_json = ?, updated_at = ?
      WHERE status = 'analyzing' AND deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM async_tasks
          WHERE type = 'script_analysis'
            AND resource_id = 'script-analysis:' || CAST(script_analysis_projects.id AS TEXT)
            AND status IN ('pending', 'processing')
            AND deleted_at IS NULL
        )
    `).run(
      JSON.stringify({ status: 'failed', issues: [ORPHAN_ASYNC_TASK_MSG] }),
      now,
    );
    if (result.changes) {
      log.info('Orphaned script analysis projects marked failed', { count: result.changes });
    }
    return result.changes;
  } catch (error) {
    if (/no such (table|column)/i.test(String(error.message || ''))) return 0;
    throw error;
  }
}

/**
 * 用户主动取消进行中的异步任务（无法中断已在执行的 AI 调用，但会停止前端轮询并防止恢复）。
 * 预扣积分继续保持 held，等待实际调用返回后由生成流程结算，避免运行中的任务被误退款。
 */
function cancelTask(db, log, taskId, reason) {
  const task = getTask(db, taskId);
  if (!task) return { ok: false, reason: 'not_found' };
  if (task.status === 'completed' || task.status === 'failed') {
    return { ok: true, already_done: true, task };
  }
  const msg = (reason || USER_CANCEL_TASK_MSG).toString().trim() || USER_CANCEL_TASK_MSG;
  updateTaskError(db, taskId, msg);
  log.info('Task cancelled by user', { task_id: taskId, type: task.type });
  return { ok: true, task: getTask(db, taskId) };
}

/**
 * 进程内 setImmediate 任务在重启后会丢失；启动时将遗留的 pending/processing 标为失败，避免前端无限轮询。
 */
function selectOrphanedAsyncTasks(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(async_tasks)').all().map((column) => column.name));
  const optional = (name) => (columns.has(name) ? name : `NULL AS ${name}`);
  return db.prepare(`
    SELECT id, type, ${optional('task_type')}, status, resource_id,
           ${optional('credit_reservation_id')}, ${optional('provider_task_id')},
           ${optional('tenant_id')}, ${optional('user_id')}
    FROM async_tasks
    WHERE status IN ('pending', 'processing')${columns.has('deleted_at') ? ' AND deleted_at IS NULL' : ''}
  `).all();
}

function failOrphanedAsyncTasksOnStartup(db, log) {
  let rows = selectOrphanedAsyncTasks(db);
  rows = rows.filter((row) => {
    const kind = String(row.type || row.task_type || '');
    return !['redraw_localization', 'redraw_asset_batch'].includes(kind);
  });
  try {
    const resumableVideoTaskIds = new Set(
      db.prepare(
        `SELECT task_id FROM video_generations
         WHERE status = 'processing' AND deleted_at IS NULL
           AND provider_task_id IS NOT NULL AND TRIM(provider_task_id) != ''
           AND task_id IS NOT NULL AND TRIM(task_id) != ''`
      ).all().map((row) => row.task_id)
    );
    rows = rows.filter(
      (row) => row.type !== 'video_generation' || !resumableVideoTaskIds.has(row.id)
    );
  } catch (error) {
    if (!/no such (table|column)/i.test(String(error.message || ''))) throw error;
  }
  try {
    const resumableRedrawTaskIds = new Set(
      db.prepare(
        `SELECT task_id FROM redraw_works
         WHERE status = 'analyzing'
           AND provider_task_id IS NOT NULL AND TRIM(provider_task_id) != ''
           AND task_id IS NOT NULL AND TRIM(task_id) != ''`
      ).all().map((row) => row.task_id)
    );
    rows = rows.filter(
      (row) => row.type !== 'redraw_analysis' || !resumableRedrawTaskIds.has(row.id)
    );
  } catch (error) {
    if (!/no such (table|column)/i.test(String(error.message || ''))) throw error;
  }
  try {
    const redrawRows = rows.filter((row) => row.type === 'redraw_shot');
    if (redrawRows.length) {
      const timestamp = new Date().toISOString();
      const keepOutOfGenericCleanup = new Set();
      db.transaction(() => {
        for (const row of redrawRows) {
          keepOutOfGenericCleanup.add(row.id);
          const hasOwner = String(row.tenant_id || '').trim() && String(row.user_id || '').trim();
          const video = hasOwner ? db.prepare(`
            SELECT v.id, v.provider_task_id
            FROM video_generations v
            JOIN redraw_shots s
              ON s.video_generation_id = v.id
              AND CAST(s.id AS TEXT) = CAST(? AS TEXT)
              AND s.deleted_at IS NULL
              AND s.tenant_id = ? AND s.user_id = ?
            WHERE v.task_id = ? AND v.deleted_at IS NULL
              AND v.tenant_id = ? AND v.user_id = ?
            ORDER BY v.id DESC LIMIT 1
          `).get(
            row.resource_id,
            String(row.tenant_id),
            String(row.user_id),
            row.id,
            String(row.tenant_id),
            String(row.user_id),
          ) : null;
          if (String(video?.provider_task_id || '').trim()) continue;
          db.prepare(`
            UPDATE async_tasks
            SET status = 'needs_attention', progress = CASE WHEN COALESCE(progress, 0) > 90 THEN progress ELSE 90 END,
                message = ?, error = ?, result = NULL, completed_at = NULL, updated_at = ?
            WHERE id = ?
          `).run('服务重启后缺少厂商任务 ID，请勿重新提交', '服务重启后缺少厂商任务 ID，请勿重新提交', timestamp, row.id);
          if (video) {
            db.prepare(`
              UPDATE video_generations SET status = 'needs_attention', error_msg = ?, updated_at = ?
              WHERE id = ? AND tenant_id = ? AND user_id = ?
            `).run(
              '服务重启后缺少厂商任务 ID，请勿重新提交',
              timestamp,
              video.id,
              String(row.tenant_id),
              String(row.user_id),
            );
          }
          if (hasOwner) {
            db.prepare(`
              UPDATE redraw_shots
              SET status = 'needs_attention', error_code = 'REDRAW_VIDEO_NEEDS_ATTENTION',
                  error_message = ?, updated_at = ?
              WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
            `).run(
              '服务重启后缺少厂商任务 ID，请勿重新提交',
              timestamp,
              Number(row.resource_id),
              String(row.tenant_id),
              String(row.user_id),
            );
          }
        }
      })();
      rows = rows.filter((row) => !keepOutOfGenericCleanup.has(row.id));
    }
  } catch (error) {
    if (!/no such (table|column)/i.test(String(error.message || ''))) throw error;
  }
  if (!rows.length) {
    reconcileOrphanedScriptAnalysisProjects(db, log);
    return 0;
  }
  log.warn('Failing orphaned async tasks after startup', { count: rows.length });
  for (const row of rows) {
    if (row.credit_reservation_id) {
      try {
        creditLedger.settleGeneration(db, row.credit_reservation_id, 'failed', ORPHAN_ASYNC_TASK_MSG);
      } catch (error) {
        log.warn('遗留任务积分结算失败', { task_id: row.id, reservation_id: row.credit_reservation_id, error: error.message });
      }
    }
    updateTaskError(db, row.id, ORPHAN_ASYNC_TASK_MSG);
    if (row.type === 'image_generation') {
      try {
        db.prepare(
          `UPDATE image_generations
           SET status = 'failed', error_msg = ?, updated_at = ?
           WHERE task_id = ? AND status IN ('pending', 'processing') AND deleted_at IS NULL`
        ).run(ORPHAN_ASYNC_TASK_MSG, new Date().toISOString(), row.id);
      } catch (error) {
        log.warn('遗留图片生成记录清理失败', { task_id: row.id, error: error.message });
      }
    }
    if (row.type === 'video_merge') {
      try {
        const merge = db.prepare(
          'SELECT episode_id FROM video_merges WHERE task_id = ? AND deleted_at IS NULL'
        ).get(row.id);
        db.prepare(
          `UPDATE video_merges
           SET status = 'failed', error_msg = ?, completed_at = ?
           WHERE task_id = ? AND status IN ('pending', 'processing') AND deleted_at IS NULL`
        ).run(ORPHAN_ASYNC_TASK_MSG, new Date().toISOString(), row.id);
        if (merge?.episode_id != null) {
          db.prepare(
            `UPDATE episodes SET status = 'failed', updated_at = ?
             WHERE id = ? AND status = 'processing'`
          ).run(new Date().toISOString(), merge.episode_id);
        }
      } catch (error) {
        log.warn('遗留视频合成记录清理失败', { task_id: row.id, error: error.message });
      }
    }
    log.info('Orphaned async task marked failed', {
      task_id: row.id,
      type: row.type,
      resource_id: row.resource_id,
      previous_status: row.status,
    });
  }
  reconcileOrphanedScriptAnalysisProjects(db, log);
  return rows.length;
}

module.exports = {
  createTask,
  getTask,
  getTasksByResource,
  updateTaskStatus,
  withTaskHeartbeat,
  updateTaskError,
  updateTaskResult,
  failOrphanedAsyncTasksOnStartup,
  trackInFlightTask,
  waitForInFlightTasks,
  getInFlightTaskCount,
  cancelTask,
  ORPHAN_ASYNC_TASK_MSG,
  USER_CANCEL_TASK_MSG,
};
