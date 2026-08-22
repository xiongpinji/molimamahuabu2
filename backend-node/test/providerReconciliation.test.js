const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const aiConfigService = require('../src/services/aiConfigService');
const creditLedgerService = require('../src/services/creditLedgerService');
const providerRouteStability = require('../src/services/providerRouteStabilityService');
const providerReconciliation = require('../src/services/providerReconciliationService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {} };

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  creditLedgerService.setTenantAccountBalance(db, 'tenant-a', 100);
  const config = aiConfigService.createConfig(db, log, {
    service_type: 'image',
    provider: 'private-relay',
    name: 'private-relay',
    base_url: 'https://provider.invalid/v1',
    api_key: 'test-key',
    model: ['upstream-image'],
    default_model: 'upstream-image',
    logical_model_id: 'logical-image',
    is_default: true,
  });
  db.prepare("UPDATE ai_service_configs SET verification_status = 'verified' WHERE id = ?")
    .run(config.id);
  return { db, config };
}

function reserve(db, key) {
  return creditLedgerService.reserve(db, {
    tenantId: 'tenant-a',
    actorUserId: 'user-a',
    userId: 'user-a',
    operationKey: key,
    amount: 10,
    model: 'logical-image',
    resourceType: 'image_generation',
    resourceId: key,
  });
}

function createRoute(db, config, reservation, suffix) {
  const route = providerRouteStability.createOrGetRouteRequest(db, {
    id: `route-${suffix}`,
    idempotencyKey: `tenant-a:image:${suffix}`,
    serviceType: 'image',
    businessType: 'image_generation',
    businessId: suffix,
    tenantId: 'tenant-a',
    userId: 'user-a',
    logicalModelId: 'logical-image',
    userPriceSnapshot: { model: 'logical-image', credits: 10 },
    candidateConfigIds: [config.id],
    creditReservationId: reservation.id,
  });
  const attempt = providerRouteStability.startAttempt(db, {
    requestId: route.id,
    configId: config.id,
    provider: config.provider,
    upstreamModel: 'upstream-image',
  });
  return { route, attempt };
}

test('submitting 未知请求转 needs_attention 并保持积分冻结且重复对账幂等', (t) => {
  const { db, config } = setup();
  t.after(() => db.close());
  const reservation = reserve(db, 'unknown-submit');
  createRoute(db, config, reservation, 'unknown-submit');
  db.prepare(`UPDATE generation_route_attempts SET started_at = ?
    WHERE request_id = ?`).run('2026-08-15T11:30:00.000Z', 'route-unknown-submit');

  const first = providerReconciliation.reconcileProviderRequests(db, log, '2026-08-15T12:00:00.000Z');
  const second = providerReconciliation.reconcileProviderRequests(db, log, '2026-08-15T12:01:00.000Z');

  assert.equal(first.needs_attention, 1);
  assert.equal(second.processed, 0);
  assert.equal(db.prepare('SELECT state FROM generation_route_requests').get().state, 'needs_attention');
  assert.equal(db.prepare('SELECT state, error_category FROM generation_route_attempts').get().state,
    'submission_unknown');
  assert.equal(db.prepare('SELECT error_category FROM generation_route_attempts').get().error_category,
    'submission_unknown');
  assert.equal(creditLedgerService.getReservation(db, reservation.id).status, 'held');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM provider_stability_events
    WHERE request_id = ? AND event_type = 'provider_request_needs_attention'`).get('route-unknown-submit').count, 1);
});

test('已有 needs_attention 事件仍把遗留图片任务收口且保持预扣', (t) => {
  const { db, config } = setup();
  t.after(() => db.close());
  const reservation = reserve(db, 'existing-needs-attention');
  const { route } = createRoute(db, config, reservation, 'existing-needs-attention');
  const now = '2026-08-15T12:00:00.000Z';

  db.prepare(`INSERT INTO async_tasks
    (id, type, status, progress, message, resource_id, created_at, updated_at,
     user_id, model, credit_reservation_id, tenant_id)
    VALUES ('task-existing-needs-attention', 'image_generation', 'processing', 90,
      '供应商提交结果未知，等待管理员核对，请勿重新提交', '101', ?, ?,
      'user-a', 'logical-image', ?, 'tenant-a')`)
    .run(now, now, reservation.id);
  db.prepare(`INSERT INTO image_generations
    (id, provider, prompt, model, status, task_id, error_msg, created_at, updated_at,
     user_id, credit_reservation_id, tenant_id)
    VALUES (101, 'private-relay', 'test prompt', 'logical-image', 'processing',
      'task-existing-needs-attention', '供应商提交结果未知，等待管理员核对，请勿重新提交',
      ?, ?, 'user-a', ?, 'tenant-a')`)
    .run(now, now, reservation.id);
  db.prepare(`UPDATE generation_route_attempts
    SET state = 'submission_unknown', error_category = 'submission_unknown',
        safe_error_summary = 'category=submission_unknown', finished_at = ?
    WHERE request_id = ?`).run(now, route.id);
  db.prepare("UPDATE generation_route_requests SET state = 'needs_attention', updated_at = ? WHERE id = ?")
    .run(now, route.id);
  db.prepare(`INSERT INTO provider_stability_events
    (severity, event_type, request_id, tenant_id, user_ref, logical_model_id,
     config_id, task_state, credit_state, safe_details, created_at)
    VALUES ('warning', 'provider_request_needs_attention', ?, 'tenant-a', 'user-a',
      'logical-image', ?, 'needs_attention', 'held_for_review',
      '{"category":"submission_unknown"}', ?)`)
    .run(route.id, config.id, now);

  const result = providerReconciliation.reconcileProviderRequests(
    db,
    log,
    '2026-08-15T12:01:00.000Z',
  );
  const updatedAfterFirst = db.prepare(
    'SELECT updated_at FROM generation_route_requests WHERE id = ?',
  ).get(route.id).updated_at;
  const second = providerReconciliation.reconcileProviderRequests(
    db,
    log,
    '2026-08-15T12:02:00.000Z',
  );

  assert.equal(result.needs_attention, 1);
  assert.equal(second.processed, 0);
  assert.equal(db.prepare(
    'SELECT updated_at FROM generation_route_requests WHERE id = ?',
  ).get(route.id).updated_at, updatedAfterFirst);
  assert.equal(db.prepare("SELECT status FROM async_tasks WHERE id = 'task-existing-needs-attention'").get().status,
    'needs_attention');
  assert.equal(db.prepare('SELECT status FROM image_generations WHERE id = 101').get().status,
    'needs_attention');
  assert.equal(creditLedgerService.getReservation(db, reservation.id).status, 'held');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM provider_stability_events
    WHERE request_id = ? AND event_type = 'provider_request_needs_attention'`).get(route.id).count, 1);
});

test('仍在正常等待窗口内的 submitting 请求不会被提前标记为结果未知', (t) => {
  const { db, config } = setup();
  t.after(() => db.close());
  const reservation = reserve(db, 'fresh-submit');
  createRoute(db, config, reservation, 'fresh-submit');
  db.prepare(`UPDATE generation_route_attempts SET started_at = ?
    WHERE request_id = ?`).run('2026-08-15T11:59:30.000Z', 'route-fresh-submit');

  const result = providerReconciliation.reconcileProviderRequests(
    db,
    log,
    '2026-08-15T12:00:00.000Z',
  );

  assert.equal(result.processed, 0);
  assert.equal(db.prepare('SELECT state FROM generation_route_requests').get().state, 'running');
  assert.equal(db.prepare('SELECT state, error_category FROM generation_route_attempts').get().state,
    'submitting');
  assert.equal(db.prepare('SELECT error_category FROM generation_route_attempts').get().error_category,
    null);
  assert.equal(creditLedgerService.getReservation(db, reservation.id).status, 'held');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM provider_stability_events
    WHERE request_id = ?`).get('route-fresh-submit').count, 0);
});

test('artifact_unreadable 保持冻结并只产生一次管理员事件', (t) => {
  const { db, config } = setup();
  t.after(() => db.close());
  const reservation = reserve(db, 'artifact-unreadable');
  const { route, attempt } = createRoute(db, config, reservation, 'artifact-unreadable');
  providerRouteStability.finishAttempt(db, {
    requestId: route.id,
    attemptNo: attempt.attempt_no,
    state: 'artifact_unreadable',
    httpStatus: 200,
    errorCategory: 'artifact_unreadable',
  });

  providerReconciliation.reconcileProviderRequests(db, log, '2026-08-15T12:00:00.000Z');
  providerReconciliation.reconcileProviderRequests(db, log, '2026-08-15T12:01:00.000Z');

  assert.equal(creditLedgerService.getReservation(db, reservation.id).status, 'held');
  assert.equal(db.prepare('SELECT state FROM generation_route_requests WHERE id = ?').get(route.id).state,
    'needs_attention');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM provider_stability_events
    WHERE request_id = ? AND event_type = 'provider_artifact_unreadable'`).get(route.id).count, 1);
});

test('只有明确失败且无供应商任务号的请求才自动退款一次', (t) => {
  const { db, config } = setup();
  t.after(() => db.close());
  const reservation = reserve(db, 'definite-failure');
  const { route, attempt } = createRoute(db, config, reservation, 'definite-failure');
  providerRouteStability.finishAttempt(db, {
    requestId: route.id,
    attemptNo: attempt.attempt_no,
    state: 'failed',
    httpStatus: 400,
    errorCategory: 'policy_rejected',
  });
  db.prepare("UPDATE generation_route_requests SET state = 'failed' WHERE id = ?").run(route.id);

  const first = providerReconciliation.reconcileProviderRequests(db, log, '2026-08-15T12:00:00.000Z');
  const second = providerReconciliation.reconcileProviderRequests(db, log, '2026-08-15T12:01:00.000Z');

  assert.equal(first.refunded, 1);
  assert.equal(second.refunded, 0);
  assert.equal(creditLedgerService.getReservation(db, reservation.id).status, 'refunded');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM tenant_credit_ledger
    WHERE reservation_id = ? AND event_type = 'refund'`).get(reservation.id).count, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM provider_stability_events
    WHERE request_id = ? AND event_type = 'provider_request_refunded'`).get(route.id).count, 1);
});

test('定时对账计时器 unref 且可显式停止', (t) => {
  const { db } = setup();
  t.after(() => {
    providerReconciliation.stopProviderReconciliation();
    db.close();
  });

  const timer = providerReconciliation.startProviderReconciliation(db, log, { intervalMs: 60_000 });

  assert.equal(timer.hasRef(), false);
  assert.equal(providerReconciliation.stopProviderReconciliation(), true);
  assert.equal(providerReconciliation.stopProviderReconciliation(), false);
});
