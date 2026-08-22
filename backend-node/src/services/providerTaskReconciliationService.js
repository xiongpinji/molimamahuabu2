const { randomUUID } = require('crypto');

const aiConfigService = require('./aiConfigService');
const creditLedger = require('./creditLedgerService');
const providerRouteStability = require('./providerRouteStabilityService');
const videoClient = require('./videoClient');
const videoService = require('./videoService');

const RECONCILE_LEASE_MS = 120_000;
const RECONCILE_DEBOUNCE_MS = 60_000;
const TERMINAL_ROUTE_STATES = new Set(['succeeded', 'failed']);
const SAFE_TASK_STATES = new Set([
  'cancelled', 'completed', 'failed', 'needs_attention', 'pending', 'processing', 'succeeded',
]);
const SAFE_UNKNOWN_CATEGORIES = new Set([
  'artifact_unreadable',
  'auth_unavailable',
  'forbidden_unknown',
  'policy_rejected',
  'provider_unavailable',
  'query_protocol_error',
  'rate_limited',
  'result_unknown',
  'submission_unknown',
  'transport_not_sent',
  'validation_error',
]);
const SAFE_PUBLIC_CATEGORIES = new Set([...SAFE_UNKNOWN_CATEGORIES, 'provider_task_failed']);

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeRequestId(value) {
  const requestId = typeof value === 'string' ? value.trim() : '';
  if (!requestId || requestId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(requestId)) {
    throw codedError('PROVIDER_TASK_REQUEST_INVALID', '普通生成请求 ID 无效');
  }
  return requestId;
}

function normalizeNow(value) {
  const parsed = value == null ? new Date() : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError('now must be a valid date');
  return parsed.toISOString();
}

function loadReconciliationState(db, requestId) {
  const route = db.prepare('SELECT * FROM generation_route_requests WHERE id = ?').get(requestId);
  if (!route) throw codedError('PROVIDER_TASK_REQUEST_NOT_FOUND', '普通生成请求不存在');
  const attempt = db.prepare(`SELECT * FROM generation_route_attempts
    WHERE request_id = ? ORDER BY attempt_no DESC LIMIT 1`).get(requestId) || null;
  const video = route.business_type === 'video_generation' && route.business_id != null
    ? db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL')
      .get(route.business_id) || null
    : null;
  const task = video?.task_id
    ? db.prepare('SELECT * FROM async_tasks WHERE id = ? AND deleted_at IS NULL').get(video.task_id) || null
    : null;
  const reservation = route.credit_reservation_id
    ? creditLedger.getReservation(db, route.credit_reservation_id) || null
    : null;
  return { db, requestId, route, attempt, video, task, reservation, config: null };
}

function sameValue(left, right) {
  return String(left ?? '') === String(right ?? '');
}

function currentReceipt(state) {
  const { route, attempt, video, task, reservation } = state;
  if (!attempt || !video || !task || !reservation) return null;
  if (route.service_type !== 'video' || route.business_type !== 'video_generation') return null;
  if (route.state !== 'needs_attention'
      || attempt.state !== 'needs_attention'
      || video.status !== 'needs_attention'
      || task.status !== 'needs_attention') return null;
  if (task.type !== 'video_generation') return null;
  if (!String(attempt.provider_task_id || '').trim()
      || !Number.isSafeInteger(Number(attempt.config_id))
      || Number(attempt.config_id) <= 0
      || !/^[a-f0-9]{64}$/.test(String(attempt.config_fingerprint || ''))
      || !String(attempt.query_protocol || '').trim()) return null;
  if (!sameValue(video.provider_task_id, attempt.provider_task_id)
      || Number(video.config_id) !== Number(attempt.config_id)
      || (route.final_config_id != null && Number(route.final_config_id) !== Number(attempt.config_id))) {
    return null;
  }
  if (!sameValue(video.credit_reservation_id, route.credit_reservation_id)
      || !sameValue(task.credit_reservation_id, route.credit_reservation_id)
      || !sameValue(reservation.id, route.credit_reservation_id)
      || reservation.status !== 'held') return null;

  const config = aiConfigService.getConfig(state.db, attempt.config_id);
  if (!config || !aiConfigService.hasConnectionCredential(config)) return null;
  try {
    const queryProtocol = videoClient.resolveVideoProtocol(config, attempt.upstream_model);
    const receipt = providerRouteStability.buildAttemptReceipt(state.db, {
      configId: attempt.config_id,
      serviceType: route.service_type,
      upstreamModel: attempt.upstream_model,
      queryProtocol,
    });
    if (receipt.serviceType !== 'video'
        || receipt.provider !== attempt.provider
        || receipt.upstreamModel !== attempt.upstream_model
        || receipt.queryProtocol !== attempt.query_protocol
        || receipt.configFingerprint !== attempt.config_fingerprint) return null;
    state.config = config;
    return receipt;
  } catch (_) {
    return null;
  }
}

function timingAllowsClaim(attempt, now) {
  const nowMs = Date.parse(now);
  if (attempt.reconcile_claim_token) {
    const leaseMs = Date.parse(attempt.reconcile_lease_until || '');
    if (!Number.isFinite(leaseMs) || leaseMs > nowMs) return false;
  }
  if (attempt.reconcile_checked_at) {
    const checkedMs = Date.parse(attempt.reconcile_checked_at);
    if (!Number.isFinite(checkedMs) || checkedMs > nowMs - RECONCILE_DEBOUNCE_MS) return false;
  }
  return true;
}

function isReconcilable(state, now, options = {}) {
  if (TERMINAL_ROUTE_STATES.has(state.route.state)) return false;
  if (!currentReceipt(state)) return false;
  return options.ignoreTiming === true || timingAllowsClaim(state.attempt, now);
}

function safeResult(db, requestId, now = new Date().toISOString()) {
  const state = loadReconciliationState(db, requestId);
  const routeState = String(state.route.state || '');
  const rawTaskState = String(state.video?.status || state.task?.status || routeState || '')
    .trim()
    .toLowerCase();
  const rawCheckedAt = state.attempt?.reconcile_checked_at;
  const checkedAtMs = typeof rawCheckedAt === 'string' && rawCheckedAt.length <= 40
    ? Date.parse(rawCheckedAt)
    : Number.NaN;
  return {
    request_id: state.requestId,
    task_state: SAFE_TASK_STATES.has(rawTaskState) ? rawTaskState : null,
    error_category: SAFE_PUBLIC_CATEGORIES.has(String(state.attempt?.error_category || ''))
      ? state.attempt.error_category
      : null,
    reconciled: TERMINAL_ROUTE_STATES.has(routeState),
    reconcilable: isReconcilable(state, now),
    credit_state: state.reservation?.status || null,
    checked_at: Number.isFinite(checkedAtMs) ? new Date(checkedAtMs).toISOString() : null,
  };
}

function claimForReconciliation(db, requestId, options = {}) {
  const now = normalizeNow(options.now);
  const claimToken = randomUUID();
  const leaseUntil = new Date(Date.parse(now) + RECONCILE_LEASE_MS).toISOString();
  const debounceCutoff = new Date(Date.parse(now) - RECONCILE_DEBOUNCE_MS).toISOString();
  return db.transaction(() => {
    const state = loadReconciliationState(db, requestId);
    if (!isReconcilable(state, now)) return { acquired: false, now };
    const changed = db.prepare(`UPDATE generation_route_attempts
      SET reconcile_claim_token = ?, reconcile_lease_until = ?
      WHERE id = ? AND request_id = ? AND attempt_no = ? AND provider_task_id = ?
        AND state = 'needs_attention'
        AND (reconcile_claim_token IS NULL OR reconcile_lease_until <= ?)
        AND (reconcile_checked_at IS NULL OR reconcile_checked_at <= ?)`)
      .run(
        claimToken,
        leaseUntil,
        state.attempt.id,
        requestId,
        state.attempt.attempt_no,
        state.attempt.provider_task_id,
        now,
        debounceCutoff,
      );
    if (changed.changes !== 1) return { acquired: false, now };
    return {
      acquired: true,
      now,
      token: claimToken,
      requestId,
      attemptId: state.attempt.id,
      attemptNo: state.attempt.attempt_no,
      providerTaskId: state.attempt.provider_task_id,
      configId: state.attempt.config_id,
      config: state.config,
      video: state.video,
    };
  }).immediate();
}

function safeCategory(value, fallback = 'result_unknown') {
  const category = String(value || '').trim().toLowerCase();
  return SAFE_UNKNOWN_CATEGORIES.has(category) ? category : fallback;
}

function unknownCategory(outcome) {
  if (outcome?.state === 'succeeded' || outcome?.state === 'artifact_unreadable') {
    return 'artifact_unreadable';
  }
  return safeCategory(outcome?.category);
}

function claimMatches(state, claim) {
  return state.attempt
    && state.attempt.id === claim.attemptId
    && state.attempt.attempt_no === claim.attemptNo
    && state.attempt.request_id === claim.requestId
    && state.attempt.provider_task_id === claim.providerTaskId
    && state.attempt.reconcile_claim_token === claim.token;
}

function releaseClaimAsUnknown(db, claim, category, now) {
  return db.transaction(() => {
    const state = loadReconciliationState(db, claim.requestId);
    if (!claimMatches(state, claim)) return false;
    const changed = db.prepare(`UPDATE generation_route_attempts
      SET state = 'needs_attention', error_category = ?, safe_error_summary = ?,
        reconcile_checked_at = ?, reconcile_claim_token = NULL, reconcile_lease_until = NULL
      WHERE id = ? AND request_id = ? AND attempt_no = ? AND provider_task_id = ?
        AND reconcile_claim_token = ? AND state = 'needs_attention'`)
      .run(
        category,
        `category=${category}`,
        now,
        claim.attemptId,
        claim.requestId,
        claim.attemptNo,
        claim.providerTaskId,
        claim.token,
      );
    if (changed.changes !== 1) {
      db.prepare(`UPDATE generation_route_attempts
        SET reconcile_claim_token = NULL, reconcile_lease_until = NULL
        WHERE id = ? AND reconcile_claim_token = ?`).run(claim.attemptId, claim.token);
    }
    return changed.changes === 1;
  }).immediate();
}

function insertReconciledEvent(db, state, claim, terminalState, creditState, now) {
  const category = terminalState === 'succeeded' ? 'succeeded' : 'provider_task_failed';
  db.prepare(`INSERT INTO provider_stability_events
    (severity, event_type, request_id, tenant_id, user_ref, logical_model_id, config_id,
     task_state, credit_state, safe_details, created_at)
    VALUES ('info', 'provider_task_reconciled', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      claim.requestId,
      state.route.tenant_id || null,
      state.route.user_id || null,
      state.route.logical_model_id || null,
      claim.configId,
      terminalState === 'succeeded' ? 'completed' : 'failed',
      creditState,
      JSON.stringify({ category }),
      now,
    );
}

function finishTerminal(db, log, claim, terminalState, prepared) {
  let applied = false;
  db.transaction(() => {
    const state = loadReconciliationState(db, claim.requestId);
    if (!claimMatches(state, claim)) return;
    if (!isReconcilable(state, claim.now, { ignoreTiming: true })) {
      db.prepare(`UPDATE generation_route_attempts
        SET error_category = 'result_unknown', safe_error_summary = 'category=result_unknown',
          reconcile_checked_at = ?, reconcile_claim_token = NULL, reconcile_lease_until = NULL
        WHERE id = ? AND reconcile_claim_token = ?`)
        .run(claim.now, claim.attemptId, claim.token);
      return;
    }
    const errorCategory = terminalState === 'failed' ? 'provider_task_failed' : null;
    const attemptChanged = db.prepare(`UPDATE generation_route_attempts
      SET state = ?, error_category = ?, safe_error_summary = ?, finished_at = ?,
        reconcile_checked_at = ?, reconcile_claim_token = NULL, reconcile_lease_until = NULL
      WHERE id = ? AND request_id = ? AND attempt_no = ? AND provider_task_id = ?
        AND reconcile_claim_token = ? AND state = 'needs_attention'`)
      .run(
        terminalState,
        errorCategory,
        errorCategory ? `category=${errorCategory}` : null,
        claim.now,
        claim.now,
        claim.attemptId,
        claim.requestId,
        claim.attemptNo,
        claim.providerTaskId,
        claim.token,
      );
    if (attemptChanged.changes !== 1) return;
    const routeChanged = db.prepare(`UPDATE generation_route_requests
      SET state = ?, final_config_id = ?, updated_at = ?
      WHERE id = ? AND state = 'needs_attention'`)
      .run(terminalState, claim.configId, claim.now, claim.requestId);
    if (routeChanged.changes !== 1) throw new Error('普通视频对账路由状态已变化');

    const applyOptions = {
      now: claim.now,
      requestId: claim.requestId,
      configId: claim.configId,
    };
    if (terminalState === 'succeeded') {
      videoService.applyReconciledVideoSuccess(db, log, state.video, prepared, applyOptions);
      insertReconciledEvent(db, state, claim, terminalState, 'confirmed', claim.now);
    } else {
      videoService.applyReconciledVideoFailure(db, log, state.video, applyOptions);
      insertReconciledEvent(db, state, claim, terminalState, 'refunded', claim.now);
    }
    applied = true;
  }).immediate();
  return { applied, result: safeResult(db, claim.requestId, claim.now) };
}

function noOpLogger() {
  return { info() {}, warn() {}, error() {} };
}

async function reconcileRequest(db, log, requestIdValue, options = {}) {
  const requestId = normalizeRequestId(requestIdValue);
  const claim = claimForReconciliation(db, requestId, options);
  if (!claim.acquired) return safeResult(db, requestId, claim.now);

  const query = options.queryTaskStatusOnce || videoClient.queryVideoTaskStatusOnce;
  let outcome;
  try {
    outcome = await query(db, noOpLogger(), claim.providerTaskId, claim.config, {
      ...(options.queryFetchImpl ? { fetchImpl: options.queryFetchImpl } : {}),
    });
  } catch (_) {
    outcome = { state: 'unknown', category: 'result_unknown' };
  }

  let prepared = null;
  if (outcome?.state === 'succeeded') {
    if (!videoClient.isPlausibleHttpVideoUrl(outcome.artifactUrl)) {
      outcome = { state: 'artifact_unreadable' };
    } else {
      try {
        prepared = await videoService.prepareReconciledVideoArtifact(
          db,
          noOpLogger(),
          claim.video,
          outcome.artifactUrl,
          claim.config,
          options,
        );
      } catch (_) {
        releaseClaimAsUnknown(db, claim, 'artifact_unreadable', claim.now);
        return safeResult(db, claim.requestId, claim.now);
      }
    }
  }

  if (outcome?.state === 'succeeded' && prepared) {
    try {
      const finished = finishTerminal(db, noOpLogger(), claim, 'succeeded', prepared);
      if (!finished.applied) videoService.discardReconciledVideoArtifact(prepared);
      return finished.result;
    } catch (error) {
      videoService.discardReconciledVideoArtifact(prepared);
      throw error;
    }
  }
  if (outcome?.state === 'failed' && outcome.category === 'provider_task_failed') {
    return finishTerminal(db, noOpLogger(), claim, 'failed', null).result;
  }

  releaseClaimAsUnknown(db, claim, unknownCategory(outcome), claim.now);
  return safeResult(db, claim.requestId, claim.now);
}

module.exports = {
  RECONCILE_LEASE_MS,
  RECONCILE_DEBOUNCE_MS,
  reconcileRequest,
};
