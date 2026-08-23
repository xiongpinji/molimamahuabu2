'use strict';

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function nonNegativeInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw codedError('REDRAW_GENERATION_POLICY_INVALID', `${field} 必须是非负整数`);
  }
  return number;
}

function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw codedError('REDRAW_GENERATION_POLICY_INVALID', `${field} 必须是正整数`);
  }
  return number;
}

function optionalPositiveInteger(value, field) {
  return value == null ? null : positiveInteger(value, field);
}

function evaluateGenerationPolicy(input = {}) {
  const executionMode = String(input.execution_mode || 'safe').trim();
  if (!['safe', 'auto'].includes(executionMode)) {
    throw codedError('REDRAW_GENERATION_POLICY_INVALID', 'execution_mode 必须是 safe 或 auto');
  }
  const spent = nonNegativeInteger(input.spent_credits ?? 0, 'spent_credits');
  const held = nonNegativeInteger(input.held_credits ?? 0, 'held_credits');
  const quote = positiveInteger(input.quote_credits, 'quote_credits');
  const completedAttempts = nonNegativeInteger(input.completed_attempts ?? 0, 'completed_attempts');
  const priorState = input.prior_state == null ? null : String(input.prior_state).trim();

  if (input.exact_reusable === true) {
    return { action: 'reuse', attempt: Math.max(completedAttempts, 1) };
  }
  if (input.prior_held_reservation === true) {
    return { action: 'blocked', reason: 'prior_reservation_held' };
  }
  if (['submission_unknown', 'needs_attention'].includes(priorState)) {
    return { action: 'blocked', reason: 'submission_state_uncertain' };
  }

  const attempt = completedAttempts + 1;
  if (executionMode === 'safe') return { action: 'submit', attempt };

  const budgetLimit = optionalPositiveInteger(input.budget_limit_credits, 'budget_limit_credits');
  if (budgetLimit == null) return { action: 'blocked', reason: 'auto_budget_missing' };
  const maxAttempts = optionalPositiveInteger(input.max_auto_attempts_per_shot, 'max_auto_attempts_per_shot');
  if (maxAttempts == null) return { action: 'blocked', reason: 'auto_attempt_limit_missing' };
  if (completedAttempts >= maxAttempts) {
    return { action: 'needs_review', effective_mode: 'safe', reason: 'auto_attempt_limit_reached' };
  }
  if (spent + held + quote > budgetLimit) {
    return { action: 'needs_review', effective_mode: 'safe', reason: 'project_budget_exceeded' };
  }
  return { action: 'submit', attempt };
}

function parseTaskEvidence(metadata) {
  if (!metadata) return null;
  try {
    const parsed = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    const attempt = Number(parsed?.redraw_shot?.attempt);
    const reservationId = String(parsed?.redraw_shot?.reservation_id || '').trim();
    return Number.isSafeInteger(attempt) && attempt > 0 && reservationId
      ? { attempt, reservationId }
      : null;
  } catch (_) {
    return null;
  }
}

function projectBudgetSnapshot(db, input = {}) {
  if (!db) throw codedError('REDRAW_GENERATION_POLICY_INVALID', '缺少数据库连接');
  const tenantId = String(input.tenantId || '').trim();
  const userId = String(input.userId || '').trim();
  const versionId = Number(input.versionId);
  const shotId = Number(input.shotId);
  if (!tenantId || !userId || !Number.isSafeInteger(versionId) || versionId <= 0
    || !Number.isSafeInteger(shotId) || shotId <= 0) {
    throw codedError('REDRAW_GENERATION_POLICY_INVALID', '项目预算查询范围无效');
  }
  const scope = db.prepare(`
    SELECT p.id AS project_id, p.execution_mode, p.budget_limit_credits,
           p.max_auto_attempts_per_shot, s.status AS shot_status
    FROM redraw_projects p
    JOIN redraw_works w
      ON w.project_id = p.id AND w.tenant_id = p.tenant_id AND w.user_id = p.user_id
      AND w.deleted_at IS NULL
    JOIN redraw_versions v
      ON v.work_id = w.id AND v.tenant_id = p.tenant_id AND v.user_id = p.user_id
      AND v.deleted_at IS NULL
    JOIN redraw_shots s
      ON s.version_id = v.id AND s.tenant_id = p.tenant_id AND s.user_id = p.user_id
      AND s.deleted_at IS NULL
    WHERE p.tenant_id = ? AND p.user_id = ? AND p.deleted_at IS NULL
      AND v.id = ? AND s.id = ?
    LIMIT 1
  `).get(tenantId, userId, versionId, shotId);
  if (!scope) {
    throw codedError('REDRAW_GENERATION_SCOPE_NOT_FOUND', '转绘项目、版本或镜头不存在或无权访问');
  }

  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN r.status = 'confirmed' THEN r.amount ELSE 0 END), 0) AS spent_credits,
      COALESCE(SUM(CASE WHEN r.status = 'held' THEN r.amount ELSE 0 END), 0) AS held_credits
    FROM tenant_usage_reservations r
    JOIN redraw_shots s
      ON CAST(s.id AS TEXT) = r.resource_id
      AND s.tenant_id = ? AND s.user_id = ?
    JOIN redraw_versions v
      ON v.id = s.version_id AND v.tenant_id = s.tenant_id AND v.user_id = s.user_id
    JOIN redraw_works w
      ON w.id = v.work_id AND w.tenant_id = v.tenant_id AND w.user_id = v.user_id
    WHERE r.tenant_id = ? AND r.resource_type = 'redraw_shot' AND w.project_id = ?
  `).get(tenantId, userId, tenantId, scope.project_id);
  const priorHeld = db.prepare(`
    SELECT 1 AS found
    FROM tenant_usage_reservations
    WHERE tenant_id = ? AND resource_type = 'redraw_shot' AND resource_id = ? AND status = 'held'
    LIMIT 1
  `).get(tenantId, String(shotId));
  const taskRows = db.prepare(`
    SELECT id, metadata
    FROM async_tasks
    WHERE type = 'redraw_shot' AND resource_id = ?
      AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).all(String(shotId), tenantId, userId);
  const completedAttempts = taskRows.reduce((maximum, row) => {
    const evidence = parseTaskEvidence(row.metadata);
    if (!evidence) return maximum;
    const video = db.prepare(`
      SELECT 1 AS found FROM video_generations
      WHERE task_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(String(row.id), tenantId, userId);
    const reservation = db.prepare(`
      SELECT 1 AS found FROM tenant_usage_reservations
      WHERE id = ? AND tenant_id = ? AND resource_type = 'redraw_shot' AND resource_id = ?
      LIMIT 1
    `).get(evidence.reservationId, tenantId, String(shotId));
    return video && reservation ? Math.max(maximum, evidence.attempt) : maximum;
  }, 0);
  const priorState = ['draft', 'pending'].includes(String(scope.shot_status || '')) && completedAttempts === 0
    ? null
    : String(scope.shot_status || '') || null;

  return {
    project_id: Number(scope.project_id),
    execution_mode: String(scope.execution_mode || 'safe'),
    budget_limit_credits: scope.budget_limit_credits == null ? null : Number(scope.budget_limit_credits),
    max_auto_attempts_per_shot: scope.max_auto_attempts_per_shot == null
      ? null
      : Number(scope.max_auto_attempts_per_shot),
    spent_credits: Number(totals.spent_credits || 0),
    held_credits: Number(totals.held_credits || 0),
    completed_attempts: completedAttempts,
    prior_state: priorState,
    prior_held_reservation: Boolean(priorHeld),
  };
}

module.exports = {
  evaluateGenerationPolicy,
  projectBudgetSnapshot,
};
