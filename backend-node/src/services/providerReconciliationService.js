const creditLedger = require('./creditLedgerService');

const DEFINITE_FAILURES = new Set([
  'auth_unavailable',
  'policy_rejected',
  'provider_unavailable',
  'rate_limited',
  'transport_not_sent',
  'validation_error',
]);
const UNKNOWN_MESSAGE = '供应商提交结果未知，等待管理员核对，请勿重新提交';
const DEFAULT_INTERVAL_MS = 60_000;
let reconciliationTimer = null;

function routeRows(db, limit = 100) {
  return db.prepare(`SELECT r.*, a.attempt_no, a.config_id, a.state AS attempt_state,
      a.provider_task_id, a.http_status, a.error_category
    FROM generation_route_requests r
    LEFT JOIN generation_route_attempts a ON a.id = (
      SELECT latest.id FROM generation_route_attempts latest
      WHERE latest.request_id = r.id
      ORDER BY latest.attempt_no DESC LIMIT 1
    )
    WHERE r.state IN ('running', 'accepted', 'failed', 'needs_attention')
    ORDER BY r.updated_at ASC
    LIMIT ?`).all(Math.min(Math.max(Number(limit) || 100, 1), 500));
}

function hasEvent(db, requestId, eventType) {
  return Boolean(db.prepare(`SELECT 1 FROM provider_stability_events
    WHERE request_id = ? AND event_type = ? LIMIT 1`).get(requestId, eventType));
}

function recordEventOnce(db, route, eventType, input = {}) {
  if (hasEvent(db, route.id, eventType)) return false;
  db.prepare(`INSERT INTO provider_stability_events
    (severity, event_type, request_id, tenant_id, user_ref, logical_model_id, config_id,
     task_state, credit_state, safe_details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.severity || 'warning',
    eventType,
    route.id,
    route.tenant_id || null,
    route.user_id || null,
    route.logical_model_id || null,
    route.config_id || null,
    input.taskState || route.state,
    input.creditState || null,
    JSON.stringify(input.safeDetails || {}),
    input.now || new Date().toISOString(),
  );
  return true;
}

function holdForReview(db, route, now, eventType) {
  return db.transaction(() => {
    if (route.attempt_no != null && route.attempt_state === 'submitting') {
      db.prepare(`UPDATE generation_route_attempts
        SET state = 'submission_unknown', error_category = 'submission_unknown',
          safe_error_summary = 'category=submission_unknown', finished_at = ?
        WHERE request_id = ? AND attempt_no = ?`).run(now, route.id, route.attempt_no);
    }
    db.prepare("UPDATE generation_route_requests SET state = 'needs_attention', updated_at = ? WHERE id = ?")
      .run(now, route.id);
    if (route.credit_reservation_id) {
      db.prepare(`UPDATE async_tasks SET status = 'processing', progress = 90, message = ?,
        error = NULL, completed_at = NULL, updated_at = ?
        WHERE credit_reservation_id = ? AND status IN ('pending', 'processing', 'failed')
          AND deleted_at IS NULL`).run(UNKNOWN_MESSAGE, now, route.credit_reservation_id);
      for (const table of ['image_generations', 'video_generations']) {
        try {
          db.prepare(`UPDATE ${table} SET status = 'processing', error_msg = ?, updated_at = ?
            WHERE credit_reservation_id = ? AND status IN ('pending', 'processing', 'failed')
              AND deleted_at IS NULL`).run(UNKNOWN_MESSAGE, now, route.credit_reservation_id);
        } catch (error) {
          if (!/no such (table|column)/i.test(String(error.message || ''))) throw error;
        }
      }
    }
    const inserted = recordEventOnce(db, route, eventType, {
      now,
      taskState: 'needs_attention',
      creditState: 'held_for_review',
      safeDetails: { category: route.error_category || 'submission_unknown' },
    });
    return inserted;
  })();
}

function refundDefiniteFailure(db, route, now) {
  if (!route.credit_reservation_id || route.provider_task_id) return false;
  const reservation = creditLedger.getReservation(db, route.credit_reservation_id);
  if (!reservation || reservation.status !== 'held') return false;
  creditLedger.settleGeneration(
    db,
    route.credit_reservation_id,
    'failed',
    '供应商明确拒绝且未创建供应商任务',
  );
  recordEventOnce(db, route, 'provider_request_refunded', {
    severity: 'info',
    now,
    taskState: 'failed',
    creditState: 'refunded',
    safeDetails: { category: route.error_category },
  });
  return true;
}

function reconcileProviderRequests(db, log, nowValue = new Date().toISOString(), options = {}) {
  const now = new Date(nowValue).toISOString();
  const summary = { processed: 0, needs_attention: 0, refunded: 0, resumable: 0 };
  for (const route of routeRows(db, options.limit)) {
    if (route.service_type === 'video' && route.provider_task_id) {
      summary.resumable += 1;
      continue;
    }
    const artifactUnreadable = route.error_category === 'artifact_unreadable'
      || route.attempt_state === 'artifact_unreadable';
    const uncertain = artifactUnreadable
      || ['submitting', 'submission_unknown', 'result_unknown', 'forbidden_unknown']
        .includes(route.attempt_state)
      || ['submission_unknown', 'result_unknown', 'forbidden_unknown']
        .includes(route.error_category)
      || (route.state === 'accepted' && !route.provider_task_id);
    if (uncertain) {
      const eventType = artifactUnreadable
        ? 'provider_artifact_unreadable'
        : 'provider_request_needs_attention';
      if (route.state === 'needs_attention' && hasEvent(db, route.id, eventType)) continue;
      holdForReview(db, route, now, eventType);
      summary.processed += 1;
      summary.needs_attention += 1;
      continue;
    }
    if (route.state === 'failed' && DEFINITE_FAILURES.has(route.error_category)) {
      if (refundDefiniteFailure(db, route, now)) {
        summary.processed += 1;
        summary.refunded += 1;
      }
    }
  }
  if (summary.processed) log?.warn?.('Provider reconciliation updated requests', summary);
  return summary;
}

function startProviderReconciliation(db, log, options = {}) {
  stopProviderReconciliation();
  const intervalMs = Math.max(Number(options.intervalMs) || DEFAULT_INTERVAL_MS, 1_000);
  reconciliationTimer = setInterval(() => {
    try {
      reconcileProviderRequests(db, log);
    } catch (error) {
      log?.error?.('Provider reconciliation failed', { error: error.message });
    }
  }, intervalMs);
  reconciliationTimer.unref?.();
  return reconciliationTimer;
}

function stopProviderReconciliation() {
  if (!reconciliationTimer) return false;
  clearInterval(reconciliationTimer);
  reconciliationTimer = null;
  return true;
}

module.exports = {
  reconcileProviderRequests,
  startProviderReconciliation,
  stopProviderReconciliation,
  UNKNOWN_MESSAGE,
};
