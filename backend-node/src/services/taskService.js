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

function getTasksByResource(db, resourceId) {
  const rows = db.prepare(
    'SELECT * FROM async_tasks WHERE resource_id = ? AND deleted_at IS NULL ORDER BY created_at DESC'
  ).all(resourceId);
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
    user_id: r.user_id,
    model: r.model,
    credit_reservation_id: r.credit_reservation_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    completed_at: r.completed_at,
  };
}

const ORPHAN_ASYNC_TASK_MSG = '服务重启后任务中断，请重新操作';
const USER_CANCEL_TASK_MSG = '用户已取消';

/**
 * 用户主动取消进行中的异步任务（无法中断已在执行的 AI 调用，但会停止前端轮询并防止恢复）。
 */
function cancelTask(db, log, taskId, reason) {
  const task = getTask(db, taskId);
  if (!task) return { ok: false, reason: 'not_found' };
  if (task.status === 'completed' || task.status === 'failed') {
    return { ok: true, already_done: true, task };
  }
  const msg = (reason || USER_CANCEL_TASK_MSG).toString().trim() || USER_CANCEL_TASK_MSG;
  if (task.credit_reservation_id) {
    try {
      creditLedger.settleGeneration(db, task.credit_reservation_id, 'failed', msg);
    } catch (error) {
      log.warn('取消任务积分结算失败', { task_id: taskId, reservation_id: task.credit_reservation_id, error: error.message });
    }
  }
  updateTaskError(db, taskId, msg);
  log.info('Task cancelled by user', { task_id: taskId, type: task.type });
  return { ok: true, task: getTask(db, taskId) };
}

/**
 * 进程内 setImmediate 任务在重启后会丢失；启动时将遗留的 pending/processing 标为失败，避免前端无限轮询。
 */
function failOrphanedAsyncTasksOnStartup(db, log) {
  let rows;
  try {
    rows = db.prepare(
      `SELECT id, type, status, resource_id, credit_reservation_id FROM async_tasks
       WHERE status IN ('pending', 'processing') AND deleted_at IS NULL`
    ).all();
  } catch (error) {
    if (!String(error.message || '').includes('credit_reservation_id')) throw error;
    rows = db.prepare(
      `SELECT id, type, status, resource_id FROM async_tasks
       WHERE status IN ('pending', 'processing') AND deleted_at IS NULL`
    ).all().map((row) => ({ ...row, credit_reservation_id: null }));
  }
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
  if (!rows.length) return 0;
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
    log.info('Orphaned async task marked failed', {
      task_id: row.id,
      type: row.type,
      resource_id: row.resource_id,
      previous_status: row.status,
    });
  }
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
  cancelTask,
  ORPHAN_ASYNC_TASK_MSG,
  USER_CANCEL_TASK_MSG,
};
