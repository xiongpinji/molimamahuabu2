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
    settings: JSON.stringify({ canvas_capabilities: {} }),
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

function createLegacyImageFailure(db, reservation, suffix, errorMessage) {
  const now = '2026-08-15T10:00:00.000Z';
  const imageId = 900 + Number(suffix);
  const taskId = `legacy-image-task-${suffix}`;
  db.prepare(`INSERT INTO async_tasks
    (id, type, status, progress, message, error, resource_id, created_at, updated_at,
     user_id, model, credit_reservation_id, tenant_id)
    VALUES (?, 'image_generation', 'failed', 100, ?, ?, ?, ?, ?,
      'user-a', 'logical-image', ?, 'tenant-a')`)
    .run(taskId, errorMessage, errorMessage, String(imageId), now, now, reservation.id);
  db.prepare(`INSERT INTO image_generations
    (id, provider, prompt, model, status, task_id, error_msg, created_at, updated_at,
     user_id, credit_reservation_id, tenant_id)
    VALUES (?, 'private-relay', 'test prompt', 'logical-image', 'failed', ?, ?, ?, ?,
      'user-a', ?, 'tenant-a')`)
    .run(imageId, taskId, errorMessage, now, now, reservation.id);
  db.prepare(`UPDATE tenant_usage_reservations SET created_at = ?, updated_at = ? WHERE id = ?`)
    .run(now, now, reservation.id);
  return { imageId, taskId };
}

function createLegacyPropImageFailure(db, reservation, suffix, errorMessage) {
  const now = '2026-08-15T10:00:00.000Z';
  const taskId = `legacy-prop-image-task-${suffix}`;
  db.prepare(`INSERT INTO async_tasks
    (id, type, status, progress, message, error, resource_id, created_at, updated_at,
     user_id, model, credit_reservation_id, tenant_id)
    VALUES (?, 'prop_image_generation', 'failed', 0, ?, ?, ?, ?, ?,
      'user-a', 'logical-image', ?, 'tenant-a')`)
    .run(taskId, errorMessage, errorMessage, `prop_${suffix}`, now, now, reservation.id);
  db.prepare(`UPDATE tenant_usage_reservations SET created_at = ?, updated_at = ? WHERE id = ?`)
    .run(now, now, reservation.id);
  return { taskId };
}

test('遗留图片结果未知超过 30 分钟自动失败并退款', (t) => {
  const { db } = setup();
  t.after(() => db.close());
  const reservation = reserve(db, 'legacy-unknown');
  const linked = createLegacyImageFailure(
    db,
    reservation,
    1,
    '图片创建成功但未返回图片地址（结果未知）。请先核对供应商记录，不要连续重试。',
  );

  const first = providerReconciliation.reconcileProviderRequests(db, log, '2026-08-15T12:00:00.000Z');
  const second = providerReconciliation.reconcileProviderRequests(db, log, '2026-08-15T12:01:00.000Z');

  assert.equal(first.refunded, 1);
  assert.equal(second.processed, 0);
  assert.equal(creditLedgerService.getReservation(db, reservation.id).status, 'refunded');
  assert.equal(db.prepare('SELECT status FROM image_generations WHERE id = ?').get(linked.imageId).status,
    'failed');
  assert.equal(db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(linked.taskId).status,
    'failed');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM tenant_credit_ledger
    WHERE reservation_id = ? AND event_type = 'refund'`).get(reservation.id).count, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM billing_reconciliation_events
    WHERE reservation_id = ? AND safety_code = 'expired_generation_timeout'`)
    .get(reservation.id).count, 1);
});

test('仅有异步任务的道具生图结果未知超过 30 分钟也自动失败退款', (t) => {
  const { db } = setup();
  t.after(() => db.close());
  const reservation = reserve(db, 'legacy-prop-unknown');
  const linked = createLegacyPropImageFailure(
    db,
    reservation,
    7,
    '供应商最终状态未知：图片生成结果未知，请先核对生成记录，不要连续重试。',
  );

  const first = providerReconciliation.reconcileProviderRequests(db, log, '2026-08-15T12:00:00.000Z');
  const second = providerReconciliation.reconcileProviderRequests(db, log, '2026-08-15T12:01:00.000Z');

  assert.equal(first.refunded, 1);
  assert.equal(second.processed, 0);
  assert.equal(creditLedgerService.getReservation(db, reservation.id).status, 'refunded');
  assert.equal(db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(linked.taskId).status,
    'failed');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM tenant_credit_ledger
    WHERE reservation_id = ? AND event_type = 'refund'`).get(reservation.id).count, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM billing_reconciliation_events
    WHERE reservation_id = ? AND safety_code = 'expired_generation_timeout'`)
    .get(reservation.id).count, 1);
});

test('遗留明确失败在安全证据齐全后自动退款且保持幂等', (t) => {
  const { db } = setup();
  t.after(() => db.close());
  const reservation = reserve(db, 'legacy-definite-failure');
  createLegacyImageFailure(db, reservation, 2, '供应商明确拒绝：请求参数无效');

  const first = providerReconciliation.reconcileProviderRequests(db, log, '2026-08-15T12:00:00.000Z');
  const second = providerReconciliation.reconcileProviderRequests(db, log, '2026-08-15T12:01:00.000Z');

  assert.equal(first.refunded, 1);
  assert.equal(second.refunded, 0);
  assert.equal(creditLedgerService.getReservation(db, reservation.id).status, 'refunded');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM tenant_credit_ledger
    WHERE reservation_id = ? AND event_type = 'refund'`).get(reservation.id).count, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM billing_reconciliation_events
    WHERE reservation_id = ?`).get(reservation.id).count, 1);
});

test('长期待核对冻结写一次升级告警而不退款或重试', (t) => {
  const { db, config } = setup();
  t.after(() => db.close());
  const reservation = reserve(db, 'held-sla');
  const { route } = createRoute(db, config, reservation, 'held-sla');
  db.prepare(`UPDATE generation_route_attempts
    SET state = 'submission_unknown', error_category = 'submission_unknown',
        safe_error_summary = 'category=submission_unknown', finished_at = ?
    WHERE request_id = ?`).run('2026-08-15T10:00:00.000Z', route.id);
  db.prepare(`UPDATE generation_route_requests SET state = 'needs_attention', updated_at = ? WHERE id = ?`)
    .run('2026-08-15T10:00:00.000Z', route.id);
  db.prepare(`INSERT INTO provider_stability_events
    (severity, event_type, request_id, tenant_id, user_ref, logical_model_id,
     config_id, task_state, credit_state, safe_details, created_at)
    VALUES ('warning', 'provider_request_needs_attention', ?, 'tenant-a', 'user-a',
      'logical-image', ?, 'needs_attention', 'held_for_review',
      '{"category":"submission_unknown"}', ?)`)
    .run(route.id, config.id, '2026-08-15T10:00:00.000Z');

  const first = providerReconciliation.reconcileProviderRequests(db, log, '2026-08-15T12:00:00.000Z');
  const second = providerReconciliation.reconcileProviderRequests(db, log, '2026-08-15T12:01:00.000Z');

  assert.equal(first.alerted, 1);
  assert.equal(second.alerted, 0);
  assert.equal(creditLedgerService.getReservation(db, reservation.id).status, 'held');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM provider_stability_events
    WHERE request_id = ? AND event_type = 'provider_credit_hold_sla_breached'`).get(route.id).count, 1);
});

test('生成冻结积分满 30 分钟自动失败并幂等返还', (t) => {
  const { db, config } = setup();
  t.after(() => db.close());
  const reservation = reserve(db, 'held-timeout-refund');
  const { route } = createRoute(db, config, reservation, 'held-timeout-refund');
  db.prepare(`INSERT INTO async_tasks
    (id, type, status, progress, message, resource_id, created_at, updated_at,
     user_id, model, credit_reservation_id, tenant_id)
    VALUES ('task-held-timeout-refund', 'image_generation', 'processing', 90,
      '等待供应商结果', '102', ?, ?, 'user-a', 'logical-image', ?, 'tenant-a')`)
    .run('2026-08-15T11:30:00.000Z', '2026-08-15T11:40:00.000Z', reservation.id);
  db.prepare(`INSERT INTO image_generations
    (id, provider, prompt, model, status, task_id, created_at, updated_at,
     user_id, credit_reservation_id, tenant_id)
    VALUES (102, 'private-relay', 'test prompt', 'logical-image', 'processing',
      'task-held-timeout-refund', ?, ?, 'user-a', ?, 'tenant-a')`)
    .run('2026-08-15T11:30:00.000Z', '2026-08-15T11:40:00.000Z', reservation.id);
  db.prepare(`UPDATE tenant_usage_reservations SET created_at = ?, updated_at = ? WHERE id = ?`)
    .run('2026-08-15T11:30:00.000Z', '2026-08-15T11:30:00.000Z', reservation.id);
  db.prepare(`UPDATE generation_route_attempts
    SET state = 'submission_unknown', error_category = 'submission_unknown', finished_at = ?
    WHERE request_id = ?`).run('2026-08-15T11:40:00.000Z', route.id);
  db.prepare(`UPDATE generation_route_requests SET state = 'needs_attention', updated_at = ? WHERE id = ?`)
    .run('2026-08-15T11:40:00.000Z', route.id);

  const first = providerReconciliation.reconcileProviderRequests(db, log, '2026-08-15T12:00:00.000Z');
  const second = providerReconciliation.reconcileProviderRequests(db, log, '2026-08-15T12:01:00.000Z');

  assert.equal(first.refunded, 1);
  assert.equal(second.refunded, 0);
  assert.equal(creditLedgerService.getReservation(db, reservation.id).status, 'refunded');
  assert.equal(db.prepare("SELECT status FROM async_tasks WHERE id = 'task-held-timeout-refund'").get().status,
    'failed');
  assert.equal(db.prepare('SELECT status FROM image_generations WHERE id = 102').get().status, 'failed');
  assert.equal(db.prepare('SELECT state FROM generation_route_requests WHERE id = ?').get(route.id).state,
    'failed');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM tenant_credit_ledger
    WHERE reservation_id = ? AND event_type = 'refund'`).get(reservation.id).count, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM billing_reconciliation_events
    WHERE reservation_id = ? AND safety_code = 'expired_generation_timeout'`)
    .get(reservation.id).count, 1);
});

test('生成冻结积分未满 30 分钟不提前失败或退款', (t) => {
  const { db, config } = setup();
  t.after(() => db.close());
  const reservation = reserve(db, 'held-before-timeout');
  const { route } = createRoute(db, config, reservation, 'held-before-timeout');
  db.prepare(`UPDATE tenant_usage_reservations SET created_at = ?, updated_at = ? WHERE id = ?`)
    .run('2026-08-15T11:30:01.000Z', '2026-08-15T11:30:01.000Z', reservation.id);

  const result = providerReconciliation.reconcileProviderRequests(db, log, '2026-08-15T12:00:00.000Z');

  assert.equal(result.refunded, 0);
  assert.equal(creditLedgerService.getReservation(db, reservation.id).status, 'held');
  assert.equal(db.prepare('SELECT state FROM generation_route_requests WHERE id = ?').get(route.id).state,
    'running');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM billing_reconciliation_events
    WHERE reservation_id = ?`).get(reservation.id).count, 0);
});

test('已退款的视频任务即使缺少异步任务预扣关联也会收口为失败以允许重新提交', (t) => {
  const { db } = setup();
  t.after(() => db.close());
  const reservation = reserve(db, 'refunded-video-task-with-missing-link');
  const now = '2026-08-15T12:00:00.000Z';

  db.prepare(`INSERT INTO async_tasks
    (id, type, status, progress, message, error, resource_id, created_at, updated_at,
     user_id, model, tenant_id)
    VALUES ('task-refunded-video-missing-link', 'video_generation', 'needs_attention', 90,
      '供应商提交结果未知，等待管理员核对，请勿重新提交', '供应商明确拒绝', '105', ?, ?,
      'user-a', 'logical-image', 'tenant-a')`)
    .run(now, now);
  db.prepare(`INSERT INTO video_generations
    (id, provider, prompt, model, status, task_id, error_msg, created_at, updated_at,
     user_id, credit_reservation_id, tenant_id)
    VALUES (105, 'private-relay', 'test prompt', 'logical-image', 'failed',
      'task-refunded-video-missing-link', '供应商明确拒绝', ?, ?, 'user-a', ?, 'tenant-a')`)
    .run(now, now, reservation.id);
  creditLedgerService.settleGeneration(db, reservation.id, 'failed', '已确认失败');

  const result = providerReconciliation.reconcileProviderRequests(db, log, now);
  const task = db.prepare(`SELECT status, progress, completed_at
    FROM async_tasks WHERE id = 'task-refunded-video-missing-link'`).get();

  assert.equal(result.repaired, 1);
  assert.equal(task.status, 'failed');
  assert.equal(task.progress, 100);
  assert.equal(task.completed_at, now);
});

test('超过 30 分钟但已有完成证据时不退款', (t) => {
  const { db, config } = setup();
  t.after(() => db.close());
  const reservation = reserve(db, 'held-with-completed-evidence');
  const { route } = createRoute(db, config, reservation, 'held-with-completed-evidence');
  db.prepare(`INSERT INTO image_generations
    (id, provider, prompt, model, status, task_id, image_url, created_at, updated_at,
     user_id, credit_reservation_id, tenant_id)
    VALUES (103, 'private-relay', 'test prompt', 'logical-image', 'completed',
      'task-held-with-completed-evidence', 'https://example.invalid/image.png', ?, ?,
      'user-a', ?, 'tenant-a')`)
    .run('2026-08-15T11:00:00.000Z', '2026-08-15T11:10:00.000Z', reservation.id);
  db.prepare(`UPDATE tenant_usage_reservations SET created_at = ?, updated_at = ? WHERE id = ?`)
    .run('2026-08-15T11:00:00.000Z', '2026-08-15T11:00:00.000Z', reservation.id);
  db.prepare("UPDATE generation_route_requests SET state = 'succeeded', updated_at = ? WHERE id = ?")
    .run('2026-08-15T11:10:00.000Z', route.id);

  const result = providerReconciliation.reconcileProviderRequests(db, log, '2026-08-15T12:00:00.000Z');

  assert.equal(result.refunded, 0);
  assert.equal(creditLedgerService.getReservation(db, reservation.id).status, 'held');
  assert.equal(db.prepare('SELECT status FROM image_generations WHERE id = 103').get().status, 'completed');
});

test('超过 30 分钟但没有生成关联证据时不处理预扣', (t) => {
  const { db } = setup();
  t.after(() => db.close());
  const reservation = reserve(db, 'held-without-generation-evidence');
  db.prepare(`UPDATE tenant_usage_reservations SET created_at = ?, updated_at = ? WHERE id = ?`)
    .run('2026-08-15T11:00:00.000Z', '2026-08-15T11:00:00.000Z', reservation.id);

  const result = providerReconciliation.reconcileProviderRequests(db, log, '2026-08-15T12:00:00.000Z');

  assert.equal(result.refunded, 0);
  assert.equal(creditLedgerService.getReservation(db, reservation.id).status, 'held');
});

test('个人账户生成冻结积分超过 30 分钟也通过账本退款', (t) => {
  const { db } = setup();
  t.after(() => db.close());
  creditLedgerService.setAccountBalance(db, 'personal-user', 30);
  const reservation = creditLedgerService.reserve(db, {
    userId: 'personal-user',
    operationKey: 'personal-held-timeout',
    amount: 7,
    model: 'logical-image',
    resourceType: 'image',
    resourceId: 'personal-held-timeout',
  });
  db.prepare(`INSERT INTO async_tasks
    (id, type, status, progress, message, resource_id, created_at, updated_at,
     user_id, model, credit_reservation_id)
    VALUES ('task-personal-held-timeout', 'image_generation', 'processing', 90,
      '等待供应商结果', '104', ?, ?, 'personal-user', 'logical-image', ?)`)
    .run('2026-08-15T11:00:00.000Z', '2026-08-15T11:00:00.000Z', reservation.id);
  db.prepare(`UPDATE usage_reservations SET created_at = ?, updated_at = ? WHERE id = ?`)
    .run('2026-08-15T11:00:00.000Z', '2026-08-15T11:00:00.000Z', reservation.id);

  const first = providerReconciliation.reconcileProviderRequests(db, log, '2026-08-15T12:00:00.000Z');
  const second = providerReconciliation.reconcileProviderRequests(db, log, '2026-08-15T12:01:00.000Z');

  assert.equal(first.refunded, 1);
  assert.equal(second.refunded, 0);
  assert.equal(creditLedgerService.getReservation(db, reservation.id).status, 'refunded');
  assert.deepEqual(creditLedgerService.getAccount(db, 'personal-user'), {
    user_id: 'personal-user',
    available: 30,
    held: 0,
    spent: 0,
  });
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM credit_ledger
    WHERE reservation_id = ? AND event_type = 'refund'`).get(reservation.id).count, 1);
});

test('已结算的待核对记录不会误报冻结积分超时', (t) => {
  const { db, config } = setup();
  t.after(() => db.close());
  const reservation = reserve(db, 'settled-review');
  const { route } = createRoute(db, config, reservation, 'settled-review');
  db.prepare(`UPDATE generation_route_attempts
    SET state = 'submission_unknown', error_category = 'submission_unknown', finished_at = ?
    WHERE request_id = ?`).run('2026-08-15T10:00:00.000Z', route.id);
  db.prepare(`UPDATE generation_route_requests SET state = 'needs_attention', updated_at = ? WHERE id = ?`)
    .run('2026-08-15T10:00:00.000Z', route.id);
  creditLedgerService.settleGeneration(db, reservation.id, 'failed', '管理员已确认失败');

  const result = providerReconciliation.reconcileProviderRequests(db, log, '2026-08-15T12:00:00.000Z');

  assert.equal(result.alerted, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM provider_stability_events
    WHERE request_id = ? AND event_type = 'provider_credit_hold_sla_breached'`).get(route.id).count, 0);
});

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
