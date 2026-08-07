const { createHash } = require('node:crypto');

const dialogueService = require('./redrawDialogueService');
const taskService = require('./taskService');

const TASK_TYPE = 'redraw_dialogue';

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function trim(value) {
  return String(value ?? '').trim();
}

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
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

function normalizeContext(ctx = {}) {
  const tenantId = trim(ctx.tenantId ?? ctx.tenant_id);
  const userId = trim(ctx.userId ?? ctx.user_id);
  const versionId = Number(ctx.versionId ?? ctx.version_id);
  if (!tenantId || !userId || !Number.isSafeInteger(versionId) || versionId <= 0) {
    throw codedError('REDRAW_DIALOGUE_CONTEXT_INVALID', '缺少配音上下文');
  }
  return { tenantId, userId, versionId };
}

function normalizeInput(input = {}) {
  const quoteHash = trim(input.quoteHash ?? input.quote_hash);
  const idempotencyKey = trim(input.idempotencyKey ?? input.idempotency_key);
  if (!quoteHash) throw codedError('REDRAW_DIALOGUE_QUOTE_REQUIRED', '缺少配音报价');
  if (!idempotencyKey) throw codedError('REDRAW_DIALOGUE_IDEMPOTENCY_REQUIRED', '缺少配音幂等键');
  return { quoteHash, idempotencyKey };
}

function resourceIdFor(ctx, input) {
  return `${TASK_TYPE}:${ctx.versionId}:${hash(`${ctx.tenantId}:${ctx.userId}:${ctx.versionId}:${input.idempotencyKey}`)}`;
}

function taskMetadata(ctx, input) {
  return {
    request_hash: hash(`${ctx.tenantId}:${ctx.userId}:${ctx.versionId}:${input.idempotencyKey}`),
    quote_hash: input.quoteHash,
  };
}

function quoteDialogue(db, ctx = {}) {
  const normalized = normalizeContext(ctx);
  return dialogueService.quoteDialoguePlan(db, normalized);
}

function existingTask(db, ctx, resourceId) {
  return db.prepare(`
    SELECT *
    FROM async_tasks
    WHERE type = ? AND resource_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    ORDER BY created_at ASC
    LIMIT 1
  `).get(TASK_TYPE, resourceId, ctx.tenantId, ctx.userId);
}

function createOrReuseTask(db, log, ctx, input) {
  const resourceId = resourceIdFor(ctx, input);
  const metadata = taskMetadata(ctx, input);
  let selected;
  let created = false;
  db.transaction(() => {
    const existing = existingTask(db, ctx, resourceId);
    if (existing) {
      const existingMetadata = parseJson(existing.metadata, {});
      if (existingMetadata.quote_hash !== input.quoteHash) {
        throw codedError('REDRAW_DIALOGUE_IDEMPOTENCY_CONFLICT', '配音幂等键已绑定其他报价');
      }
      selected = existing;
      return;
    }
    const task = taskService.createTask(db, log, TASK_TYPE, resourceId);
    db.prepare(`
      UPDATE async_tasks
      SET tenant_id = ?, user_id = ?, status = 'pending', progress = 0, message = ?, metadata = ?, updated_at = ?
      WHERE id = ?
    `).run(ctx.tenantId, ctx.userId, '配音任务已创建', JSON.stringify(metadata), new Date().toISOString(), task.id);
    selected = taskService.getTask(db, task.id);
    created = true;
  }).immediate();
  return { task: selected, created };
}

function setTaskStatus(db, taskId, status, progress, message) {
  const now = new Date().toISOString();
  const completedAt = ['completed', 'failed'].includes(status) ? now : null;
  db.prepare(`
    UPDATE async_tasks
    SET status = ?, progress = ?, message = ?, error = CASE WHEN ? = 'failed' THEN ? ELSE error END,
        completed_at = ?, updated_at = ?
    WHERE id = ?
  `).run(status, progress, message || '', status, message || '', completedAt, now, taskId);
}

function setProviderTaskId(db, taskId, providerTaskId) {
  if (!trim(providerTaskId)) return;
  db.prepare('UPDATE async_tasks SET provider_task_id = ?, updated_at = ? WHERE id = ?')
    .run(trim(providerTaskId), new Date().toISOString(), taskId);
}

function providerTaskIdFrom(error) {
  return trim(error?.provider_task_id || error?.providerTaskId || error?.task_id || error?.taskId);
}

function versionIdFromResourceId(resourceId) {
  const [, versionId] = String(resourceId || '').split(':');
  const parsed = Number(versionId);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isUnknown(error) {
  const code = String(error?.code || '').toUpperCase();
  return error?.unknown === true
    || code.includes('UNKNOWN')
    || code === 'PROVIDER_STATUS_UNKNOWN'
    || code === 'REDRAW_DIALOGUE_NEEDS_ATTENTION';
}

function defaultSchedule(job) {
  return new Promise((resolve, reject) => {
    setImmediate(() => Promise.resolve().then(job).then(resolve, reject));
  });
}

function runDialogueJob(db, log, ctx, input, taskId, deps) {
  return (async () => {
    try {
      setTaskStatus(db, taskId, 'processing', 10, '正在生成英文配音');
      const result = await dialogueService.synthesizeDialogueForVersion({
        db,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        versionId: ctx.versionId,
        synthesizeSegment: deps.synthesizeSegment,
        canReadAudioAsset: deps.canReadAudioAsset,
      }, input);
      taskService.updateTaskResult(db, taskId, {
        status: 'completed',
        version_id: ctx.versionId,
        segment_count: result.segment_count,
        quote_hash: result.quote_hash,
      });
      return result;
    } catch (error) {
      setProviderTaskId(db, taskId, providerTaskIdFrom(error));
      if (isUnknown(error)) {
        setTaskStatus(db, taskId, 'needs_attention', 90, '配音供应商状态未知，请人工确认');
      } else {
        taskService.updateTaskError(db, taskId, '配音生成失败');
      }
      log?.warn?.('redraw dialogue job failed', { task_id: taskId, code: error?.code });
      throw error;
    }
  })();
}

function startDialogue(db, log, ctx = {}, input = {}, deps = {}) {
  const normalizedCtx = normalizeContext(ctx);
  const normalizedInput = normalizeInput(input);
  const quote = quoteDialogue(db, normalizedCtx);
  if (quote.status !== 'ready') {
    throw codedError('REDRAW_DIALOGUE_PLAN_NOT_READY', '配音计划需要重写', { quote });
  }
  if (normalizedInput.quoteHash !== quote.quote_hash) {
    throw codedError('REDRAW_DIALOGUE_QUOTE_MISMATCH', '配音报价已变化', { quote });
  }
  if (typeof deps.synthesizeSegment !== 'function') {
    throw codedError('REDRAW_DIALOGUE_SYNTHESIZER_REQUIRED', '缺少配音生成器');
  }
  if (typeof deps.canReadAudioAsset !== 'function') {
    throw codedError('REDRAW_DIALOGUE_READER_REQUIRED', '缺少配音音频读取器');
  }

  const { task, created } = createOrReuseTask(db, log, normalizedCtx, normalizedInput);
  if (!created) {
    return {
      task_id: task.id,
      status: task.status,
      quote,
      completion: null,
    };
  }

  const schedule = typeof deps.schedule === 'function' ? deps.schedule : defaultSchedule;
  let scheduled;
  const job = () => runDialogueJob(db, log, normalizedCtx, normalizedInput, task.id, deps);
  try {
    scheduled = schedule(job);
  } catch (error) {
    scheduled = Promise.reject(error);
  }
  const completion = taskService.trackInFlightTask(task.id, Promise.resolve(scheduled));
  return { task_id: task.id, status: 'pending', quote, completion };
}

function reconcileOrphanedDialogueTasks(db, log = { warn() {} }) {
  let rows;
  try {
    rows = db.prepare(`
      SELECT *
      FROM async_tasks
      WHERE type = ? AND status IN ('pending', 'processing') AND deleted_at IS NULL
    `).all(TASK_TYPE);
  } catch (error) {
    if (/no such (table|column)/i.test(String(error.message || ''))) return { needs_attention: 0 };
    throw error;
  }
  if (!rows.length) return { needs_attention: 0 };

  const now = new Date().toISOString();
  db.transaction(() => {
    for (const row of rows) {
      db.prepare(`
        UPDATE async_tasks
        SET status = 'needs_attention', progress = CASE WHEN COALESCE(progress, 0) > 90 THEN progress ELSE 90 END,
            message = ?, error = ?, completed_at = NULL, updated_at = ?
        WHERE id = ?
      `).run('服务重启后配音供应商任务状态未知，请人工确认', '服务重启后配音供应商任务状态未知，请人工确认', now, row.id);
      const shots = db.prepare(`
        SELECT id, draft_json
        FROM redraw_shots
        WHERE tenant_id = ? AND user_id = ? AND version_id = ? AND deleted_at IS NULL
      `).all(row.tenant_id, row.user_id, versionIdFromResourceId(row.resource_id));
      for (const shot of shots) {
        const draft = parseJson(shot.draft_json, {});
        const generation = draft.dialogue_generation;
        if (!generation || !Array.isArray(generation.segments)) continue;
        let changed = false;
        const segments = generation.segments.map((segment) => {
          if (['pending', 'processing'].includes(String(segment.status || ''))) {
            changed = true;
            return {
              ...segment,
              status: 'needs_attention',
              error_code: segment.error_code || 'REDRAW_DIALOGUE_NEEDS_ATTENTION',
            };
          }
          return segment;
        });
        if (!changed) continue;
        db.prepare('UPDATE redraw_shots SET draft_json = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify({
            ...draft,
            dialogue_generation: {
              ...generation,
              status: 'needs_attention',
              segments,
            },
          }), now, shot.id);
      }
      log?.warn?.('redraw dialogue orphan needs attention', { task_id: row.id });
    }
  })();
  return { needs_attention: rows.length };
}

module.exports = {
  quoteDialogue,
  startDialogue,
  reconcileOrphanedDialogueTasks,
};
