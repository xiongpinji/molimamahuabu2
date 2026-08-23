const { randomUUID } = require('crypto');
const creditLedger = require('./creditLedgerService');
const auditEvents = require('./auditEventService');

const RUNNING_STATUSES = new Set(['pending', 'processing', 'queued', 'running', 'in_progress']);
const COMPLETED_STATUSES = new Set(['completed', 'success', 'succeeded']);
const FAILED_STATUSES = new Set(['failed', 'timed_out', 'timeout']);
const CANCELLED_STATUSES = new Set(['canceled', 'cancelled']);
const UNCERTAINTY_MARKERS = [
  '结果未知',
  '状态未知',
  '最终状态未知',
  '仍可能处理中',
  '仍在处理中',
  '请勿重新提交',
  '不要连续重试',
  '可能已受理',
  '可能已扣费',
  'fetch failed',
  'socket',
  'connection reset',
  '连接中断',
  '网络中断',
  'econn',
  'etimedout',
];
const CANCELLATION_MARKERS = ['用户已取消', 'user cancelled', 'user canceled'];

function reconciliationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function ensureSchema(db) {
  creditLedger.ensureSchema(db);
  auditEvents.ensureSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_reconciliation_events (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      reservation_id TEXT NOT NULL,
      tenant_id TEXT,
      user_id TEXT,
      actor_user_id TEXT,
      action TEXT NOT NULL CHECK (action IN ('refund')),
      previous_status TEXT NOT NULL,
      result_status TEXT NOT NULL,
      reason TEXT NOT NULL,
      safety_code TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_billing_reconciliation_created
      ON billing_reconciliation_events(created_at DESC);
  `);
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function listHeldReservations(db, cutoff, limit) {
  const tenantRows = db.prepare(`SELECT
      id AS reservation_id,
      'tenant' AS scope,
      tenant_id,
      NULL AS user_id,
      actor_user_id,
      operation_key,
      model,
      resource_type,
      resource_id,
      amount,
      status,
      reason,
      created_at,
      updated_at
    FROM tenant_usage_reservations
    WHERE status = 'held' AND julianday(created_at) <= julianday(?)`).all(cutoff);
  const userRows = db.prepare(`SELECT
      personal.id AS reservation_id,
      'user' AS scope,
      NULL AS tenant_id,
      personal.user_id,
      NULL AS actor_user_id,
      personal.operation_key,
      personal.model,
      personal.resource_type,
      personal.resource_id,
      personal.amount,
      personal.status,
      personal.reason,
      personal.created_at,
      personal.updated_at
    FROM usage_reservations AS personal
    WHERE personal.status = 'held'
      AND julianday(personal.created_at) <= julianday(?)
      AND NOT EXISTS (
        SELECT 1 FROM tenant_usage_reservations AS tenant
        WHERE tenant.id = personal.id
      )`).all(cutoff);
  return [...tenantRows, ...userRows]
    .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)))
    .slice(0, limit);
}

function evidenceForReservation(db, reservationId) {
  const tasks = db.prepare(`SELECT id, type, status, message, error, updated_at, completed_at
    FROM async_tasks
    WHERE credit_reservation_id = ? AND deleted_at IS NULL`).all(reservationId);
  const images = db.prepare(`SELECT id, status, error_msg, updated_at
    FROM image_generations
    WHERE credit_reservation_id = ? AND deleted_at IS NULL`).all(reservationId);
  const videos = db.prepare(`SELECT id, status, error_msg, provider_task_id, updated_at
    FROM video_generations
    WHERE credit_reservation_id = ? AND deleted_at IS NULL`).all(reservationId);
  let providerRoutes = [];
  try {
    providerRoutes = db.prepare(`SELECT id, service_type, state, updated_at
      FROM generation_route_requests WHERE credit_reservation_id = ?`).all(reservationId);
  } catch (error) {
    if (!/no such (table|column)/i.test(String(error.message || ''))) throw error;
  }
  return { tasks, images, videos, providerRoutes };
}

function classifyEvidence(evidence) {
  if (evidence.providerRoutes?.some((row) => (
    ['running', 'accepted', 'needs_attention'].includes(String(row.state || '').toLowerCase())
  ))) {
    return { refundable: false, safety_status: 'provider_route_needs_attention' };
  }
  if (evidence.providerRoutes?.some((row) => (
    ['succeeded', 'completed'].includes(String(row.state || '').toLowerCase())
  ))) {
    return { refundable: false, safety_status: 'completed_requires_review' };
  }
  const records = [
    ...evidence.tasks.map((row) => ({
      kind: 'async_task',
      status: row.status,
      detail: [row.message, row.error].filter(Boolean).join(' '),
    })),
    ...evidence.images.map((row) => ({
      kind: 'image_generation',
      status: row.status,
      detail: row.error_msg || '',
    })),
    ...evidence.videos.map((row) => ({
      kind: 'video_generation',
      status: row.status,
      detail: row.error_msg || '',
      provider_task_id: row.provider_task_id || null,
    })),
  ];
  if (!records.length) {
    return { refundable: false, safety_status: 'missing_terminal_evidence' };
  }
  const statuses = records.map((row) => String(row.status || '').trim().toLowerCase());
  const details = records.map((row) => String(row.detail || '').toLowerCase()).join(' ');
  const explicitTimeout = statuses.some((status) => ['timed_out', 'timeout'].includes(status));
  if (statuses.some((status) => RUNNING_STATUSES.has(status))) {
    return { refundable: false, safety_status: 'running' };
  }
  if (statuses.some((status) => COMPLETED_STATUSES.has(status))) {
    return { refundable: false, safety_status: 'completed_requires_review' };
  }
  if (
    statuses.some((status) => CANCELLED_STATUSES.has(status))
    || CANCELLATION_MARKERS.some((marker) => details.includes(marker))
  ) {
    return { refundable: false, safety_status: 'cancelled_may_still_run' };
  }
  if ((details.includes('timeout') || details.includes('超时')) && !explicitTimeout) {
    return { refundable: false, safety_status: 'indeterminate' };
  }
  if (UNCERTAINTY_MARKERS.some((marker) => details.includes(marker))) {
    return { refundable: false, safety_status: 'indeterminate' };
  }
  const unverifiedProviderFailure = records.some((row) => (
    row.kind === 'video_generation'
    && row.provider_task_id
    && FAILED_STATUSES.has(String(row.status || '').trim().toLowerCase())
    && !/(供应商.*(失败|拒绝|取消)|provider.*(failed|rejected|cancelled|canceled))/.test(
      String(row.detail || '').toLowerCase(),
    )
  ));
  if (unverifiedProviderFailure) {
    return { refundable: false, safety_status: 'indeterminate' };
  }
  if (statuses.every((status) => FAILED_STATUSES.has(status))) {
    return { refundable: true, safety_status: 'definite_failure' };
  }
  return { refundable: false, safety_status: 'inconsistent_evidence' };
}

function inspectReservation(db, reservation) {
  const evidence = evidenceForReservation(db, reservation.reservation_id || reservation.id);
  return {
    ...reservation,
    ...classifyEvidence(evidence),
    evidence,
  };
}

function listAnomalies(db, input = {}) {
  ensureSchema(db);
  const olderThanMinutes = boundedInt(input.olderThanMinutes, 60, 5, 10080);
  const limit = boundedInt(input.limit, 100, 1, 500);
  const now = input.now ? new Date(input.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw reconciliationError('INVALID_RECONCILIATION_INPUT', 'now 不是有效时间');
  }
  const cutoff = new Date(now.getTime() - olderThanMinutes * 60 * 1000).toISOString();
  return listHeldReservations(db, cutoff, limit).map((row) => inspectReservation(db, row));
}

function reservationForInspection(db, reservationId) {
  const reservation = creditLedger.getReservation(db, reservationId);
  if (!reservation) throw reconciliationError('RECONCILIATION_RESERVATION_NOT_FOUND', '积分预扣记录不存在');
  return {
    reservation_id: reservation.id,
    scope: reservation.tenant_id ? 'tenant' : 'user',
    tenant_id: reservation.tenant_id || null,
    user_id: reservation.user_id || null,
    actor_user_id: reservation.actor_user_id || null,
    operation_key: reservation.operation_key,
    model: reservation.model,
    resource_type: reservation.resource_type,
    resource_id: reservation.resource_id,
    amount: reservation.amount,
    status: reservation.status,
    reason: reservation.reason,
    created_at: reservation.created_at,
    updated_at: reservation.updated_at,
  };
}

function refundReservation(db, input = {}) {
  ensureSchema(db);
  const reservationId = String(input.reservationId || '').trim();
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  const reason = String(input.reason || '').trim();
  if (!reservationId || idempotencyKey.length < 8 || idempotencyKey.length > 100) {
    throw reconciliationError('INVALID_RECONCILIATION_INPUT', '预扣 ID 或幂等键无效');
  }
  if (!reason || reason.length > 240) {
    throw reconciliationError('INVALID_RECONCILIATION_INPUT', '请填写 1 到 240 个字符的退款原因');
  }

  return db.transaction(() => {
    const existing = db.prepare(`SELECT * FROM billing_reconciliation_events
      WHERE idempotency_key = ?`).get(idempotencyKey);
    if (existing) {
      if (existing.reservation_id !== reservationId || existing.action !== 'refund') {
        throw reconciliationError(
          'RECONCILIATION_IDEMPOTENCY_CONFLICT',
          '该幂等键已用于其他对账操作',
        );
      }
      return {
        history: existing,
        reservation: creditLedger.getReservation(db, reservationId),
      };
    }

    const reservation = reservationForInspection(db, reservationId);
    if (reservation.status !== 'held') {
      throw reconciliationError('UNSAFE_RECONCILIATION_REFUND', '只有 held 预扣可以执行对账退款');
    }
    const inspected = inspectReservation(db, reservation);
    if (!inspected.refundable) {
      throw reconciliationError(
        'UNSAFE_RECONCILIATION_REFUND',
        `当前证据不允许退款：${inspected.safety_status}`,
      );
    }

    const refunded = creditLedger.refund(db, reservationId, reason);
    const history = {
      id: randomUUID(),
      idempotency_key: idempotencyKey,
      reservation_id: reservationId,
      tenant_id: reservation.tenant_id,
      user_id: reservation.user_id,
      actor_user_id: input.actorUserId == null ? null : String(input.actorUserId),
      action: 'refund',
      previous_status: reservation.status,
      result_status: refunded.status,
      reason,
      safety_code: inspected.safety_status,
      created_at: new Date().toISOString(),
    };
    db.prepare(`INSERT INTO billing_reconciliation_events
      (id, idempotency_key, reservation_id, tenant_id, user_id, actor_user_id,
        action, previous_status, result_status, reason, safety_code, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        history.id,
        history.idempotency_key,
        history.reservation_id,
        history.tenant_id,
        history.user_id,
        history.actor_user_id,
        history.action,
        history.previous_status,
        history.result_status,
        history.reason,
        history.safety_code,
        history.created_at,
      );
    auditEvents.record(db, {
      userId: history.actor_user_id,
      tenantId: reservation.tenant_id,
      eventType: 'billing.reconciliation.refunded',
      resourceType: 'credit_reservation',
      resourceId: reservationId,
      outcome: 'success',
      code: inspected.safety_status,
    });
    return { history, reservation: refunded };
  })();
}

function listHistory(db, input = {}) {
  ensureSchema(db);
  const limit = boundedInt(input.limit, 100, 1, 500);
  return db.prepare(`SELECT * FROM billing_reconciliation_events
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?`).all(limit);
}

module.exports = {
  ensureSchema,
  listAnomalies,
  refundReservation,
  listHistory,
};
