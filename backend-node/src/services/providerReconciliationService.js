const creditLedger = require('./creditLedgerService');
const billingReconciliation = require('./billingReconciliationService');

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
const DEFAULT_SUBMITTING_GRACE_MS = 20 * 60_000;
const DEFAULT_REVIEW_SLA_MS = 60 * 60_000;
let reconciliationTimer = null;

function routeRows(db, limit = 100) {
  return db.prepare(`SELECT r.*, a.attempt_no, a.config_id, a.state AS attempt_state,
      a.started_at AS attempt_started_at,
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

function isStaleSubmitting(route, now, graceMs) {
  if (route.attempt_state !== 'submitting') return false;
  const startedAt = Date.parse(route.attempt_started_at || '');
  if (!Number.isFinite(startedAt)) return true;
  return Date.parse(now) - startedAt >= graceMs;
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
    let stateChanges = 0;
    let linkedChanges = 0;
    if (route.attempt_no != null && route.attempt_state === 'submitting') {
      stateChanges += db.prepare(`UPDATE generation_route_attempts
        SET state = 'submission_unknown', error_category = 'submission_unknown',
          safe_error_summary = 'category=submission_unknown', finished_at = ?
        WHERE request_id = ? AND attempt_no = ?`).run(now, route.id, route.attempt_no).changes;
    }
    stateChanges += db.prepare(`UPDATE generation_route_requests
      SET state = 'needs_attention', updated_at = ?
      WHERE id = ? AND state <> 'needs_attention'`).run(now, route.id).changes;
    if (route.credit_reservation_id) {
      linkedChanges += db.prepare(`UPDATE async_tasks SET status = 'needs_attention', progress = 90, message = ?,
        error = NULL, completed_at = NULL, updated_at = ?
        WHERE credit_reservation_id = ? AND status IN ('pending', 'processing', 'failed')
          AND deleted_at IS NULL`).run(UNKNOWN_MESSAGE, now, route.credit_reservation_id).changes;
      for (const table of ['image_generations', 'video_generations']) {
        try {
          linkedChanges += db.prepare(`UPDATE ${table} SET status = 'needs_attention', error_msg = ?, updated_at = ?
            WHERE credit_reservation_id = ? AND status IN ('pending', 'processing', 'failed')
              AND deleted_at IS NULL`).run(UNKNOWN_MESSAGE, now, route.credit_reservation_id).changes;
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
    return inserted || stateChanges + linkedChanges > 0;
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

function isReviewSlaBreached(route, now, reviewSlaMs) {
  if (route.state !== 'needs_attention') return false;
  const updatedAt = Date.parse(route.updated_at || '');
  return Number.isFinite(updatedAt) && Date.parse(now) - updatedAt >= reviewSlaMs;
}

function recordReviewSlaOnce(db, route, now, reviewSlaMs) {
  if (!isReviewSlaBreached(route, now, reviewSlaMs)) return false;
  if (!route.credit_reservation_id) return false;
  const reservation = creditLedger.getReservation(db, route.credit_reservation_id);
  if (!reservation || reservation.status !== 'held') return false;
  return recordEventOnce(db, route, 'provider_credit_hold_sla_breached', {
    severity: 'error',
    now,
    taskState: 'needs_attention',
    creditState: 'held_for_review',
    safeDetails: { category: route.error_category || 'submission_unknown' },
  });
}

function markLegacyHeldForReview(db, row, now) {
  const route = {
    id: `legacy-credit:${row.reservation_id}`,
    tenant_id: row.tenant_id || null,
    user_id: row.user_id || row.actor_user_id || null,
    logical_model_id: row.model || null,
    state: 'needs_attention',
  };
  return db.transaction(() => {
    let changes = db.prepare(`UPDATE async_tasks
      SET status = 'needs_attention', progress = 90, message = ?, error = NULL,
        completed_at = NULL, updated_at = ?
      WHERE credit_reservation_id = ? AND status IN ('pending', 'processing', 'failed')
        AND deleted_at IS NULL`).run(UNKNOWN_MESSAGE, now, row.reservation_id).changes;
    for (const table of ['image_generations', 'video_generations']) {
      try {
        changes += db.prepare(`UPDATE ${table}
          SET status = 'needs_attention', error_msg = ?, updated_at = ?
          WHERE credit_reservation_id = ? AND status IN ('pending', 'processing', 'failed')
            AND deleted_at IS NULL`).run(UNKNOWN_MESSAGE, now, row.reservation_id).changes;
      } catch (error) {
        if (!/no such (table|column)/i.test(String(error.message || ''))) throw error;
      }
    }
    const inserted = recordEventOnce(db, route, 'provider_legacy_generation_needs_attention', {
      severity: 'error',
      now,
      taskState: 'needs_attention',
      creditState: 'held_for_review',
      safeDetails: { category: 'submission_unknown' },
    });
    return inserted || changes > 0;
  })();
}

function reconcileLegacyHeldReservations(db, now, options, summary) {
  const rows = billingReconciliation.listAnomalies(db, {
    olderThanMinutes: options.legacyGraceMinutes ?? 5,
    limit: options.limit,
    now,
  });
  for (const row of rows) {
    if (row.evidence.providerRoutes.length) continue;
    if (!row.evidence.images.length && !row.evidence.videos.length) continue;
    if (row.safety_status === 'indeterminate') {
      if (!markLegacyHeldForReview(db, row, now)) continue;
      summary.processed += 1;
      summary.needs_attention += 1;
      continue;
    }
    if (row.safety_status !== 'definite_failure') continue;
    billingReconciliation.refundReservation(db, {
      reservationId: row.reservation_id,
      idempotencyKey: `provider-auto-refund:${row.reservation_id}`,
      reason: '系统对账确认生成明确失败并自动返还冻结积分',
      actorUserId: null,
    });
    summary.processed += 1;
    summary.refunded += 1;
  }
}

function reconcileProviderRequests(db, log, nowValue = new Date().toISOString(), options = {}) {
  const now = new Date(nowValue).toISOString();
  const configuredGraceMs = Number(options.submittingGraceMs);
  const submittingGraceMs = Number.isFinite(configuredGraceMs) && configuredGraceMs >= 0
    ? configuredGraceMs
    : DEFAULT_SUBMITTING_GRACE_MS;
  const configuredReviewSlaMs = Number(options.reviewSlaMs);
  const reviewSlaMs = Number.isFinite(configuredReviewSlaMs) && configuredReviewSlaMs >= 0
    ? configuredReviewSlaMs
    : DEFAULT_REVIEW_SLA_MS;
  const summary = { processed: 0, needs_attention: 0, refunded: 0, resumable: 0, alerted: 0 };
  for (const route of routeRows(db, options.limit)) {
    if (route.service_type === 'video' && route.provider_task_id) {
      summary.resumable += 1;
      continue;
    }
    const artifactUnreadable = route.error_category === 'artifact_unreadable'
      || route.attempt_state === 'artifact_unreadable';
    const staleSubmitting = isStaleSubmitting(route, now, submittingGraceMs);
    const uncertain = artifactUnreadable
      || staleSubmitting
      || ['submission_unknown', 'result_unknown', 'forbidden_unknown']
        .includes(route.attempt_state)
      || ['submission_unknown', 'result_unknown', 'forbidden_unknown']
        .includes(route.error_category)
      || (route.state === 'accepted' && !route.provider_task_id);
    if (uncertain) {
      const eventType = artifactUnreadable
        ? 'provider_artifact_unreadable'
        : 'provider_request_needs_attention';
      const heldForReview = holdForReview(db, route, now, eventType);
      const alerted = recordReviewSlaOnce(db, route, now, reviewSlaMs);
      if (heldForReview) summary.needs_attention += 1;
      if (alerted) summary.alerted += 1;
      if (heldForReview || alerted) summary.processed += 1;
      continue;
    }
    if (route.state === 'failed' && DEFINITE_FAILURES.has(route.error_category)) {
      if (refundDefiniteFailure(db, route, now)) {
        summary.processed += 1;
        summary.refunded += 1;
      }
    }
  }
  reconcileLegacyHeldReservations(db, now, options, summary);
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
