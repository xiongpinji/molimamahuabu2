const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const credits = require('../src/services/creditLedgerService');
const reconciliation = require('../src/services/billingReconciliationService');
const billingRoutes = require('../src/routes/billing');

const NOW = '2026-07-24T12:00:00.000Z';
const OLD = '2026-07-24T09:00:00.000Z';
const FRESH = '2026-07-24 11:30:00';
const log = { error() {} };

function setup() {
  const db = new Database(':memory:');
  credits.ensureSchema(db);
  db.exec(`
    CREATE TABLE async_tasks (
      id TEXT PRIMARY KEY,
      type TEXT,
      status TEXT,
      message TEXT,
      error TEXT,
      credit_reservation_id TEXT,
      created_at TEXT,
      updated_at TEXT,
      completed_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE image_generations (
      id INTEGER PRIMARY KEY,
      status TEXT,
      error_msg TEXT,
      credit_reservation_id TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE video_generations (
      id INTEGER PRIMARY KEY,
      status TEXT,
      error_msg TEXT,
      provider_task_id TEXT,
      credit_reservation_id TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
  `);
  credits.setAccountBalance(db, 'user-1', 1000);
  credits.setTenantAccountBalance(db, 'tenant-1', 1000);
  return db;
}

function reserve(db, key, options = {}) {
  const reservation = credits.reserve(db, {
    userId: 'user-1',
    tenantId: options.tenant ? 'tenant-1' : undefined,
    actorUserId: options.tenant ? 'user-1' : undefined,
    operationKey: key,
    amount: 10,
    model: 'test-model',
    resourceType: options.resourceType || 'text',
    resourceId: options.resourceId || key,
  });
  const table = options.tenant ? 'tenant_usage_reservations' : 'usage_reservations';
  db.prepare(`UPDATE ${table} SET created_at = ?, updated_at = ? WHERE id = ?`)
    .run(options.fresh ? FRESH : OLD, options.fresh ? FRESH : OLD, reservation.id);
  return reservation;
}

function linkTask(db, reservation, status, error = '') {
  const terminalAt = ['failed', 'completed', 'cancelled', 'timed_out'].includes(status) ? OLD : null;
  db.prepare(`INSERT INTO async_tasks
    (id, type, status, message, error, credit_reservation_id, created_at, updated_at, completed_at)
    VALUES (?, 'story_generation', ?, '', ?, ?, ?, ?, ?)`)
    .run(`task-${reservation.operation_key}`, status, error, reservation.id, OLD, OLD, terminalAt);
}

function capture() {
  const result = {};
  return {
    result,
    res: {
      status(code) { result.status = code; return this; },
      json(body) { result.body = body; return this; },
    },
  };
}

test('陈旧 held 扫描覆盖个人和租户，并阻断运行中、不确定、取消、完成及无证据记录', () => {
  const db = setup();
  const failedUser = reserve(db, 'failed-user');
  const failedTenant = reserve(db, 'failed-tenant', { tenant: true });
  const running = reserve(db, 'running');
  const uncertain = reserve(db, 'uncertain');
  const cancelled = reserve(db, 'cancelled');
  const completed = reserve(db, 'completed');
  reserve(db, 'orphan');
  const fresh = reserve(db, 'fresh', { fresh: true });

  linkTask(db, failedUser, 'failed', '供应商明确拒绝');
  linkTask(db, failedTenant, 'failed', '服务重启后任务中断，请重新操作');
  linkTask(db, running, 'processing');
  linkTask(db, uncertain, 'failed', '供应商任务仍可能处理中，请勿重新提交');
  linkTask(db, cancelled, 'failed', '用户已取消');
  linkTask(db, completed, 'completed');
  linkTask(db, fresh, 'failed', '供应商明确拒绝');

  const rows = reconciliation.listAnomalies(db, {
    olderThanMinutes: 60,
    now: NOW,
  });
  const byKey = Object.fromEntries(rows.map((row) => [row.operation_key, row]));

  assert.equal(rows.length, 7);
  assert.equal(byKey['failed-user'].refundable, true);
  assert.equal(byKey['failed-user'].safety_status, 'definite_failure');
  assert.equal(byKey['failed-tenant'].refundable, true);
  assert.equal(byKey['failed-tenant'].scope, 'tenant');
  assert.equal(byKey.running.safety_status, 'running');
  assert.equal(byKey.uncertain.safety_status, 'indeterminate');
  assert.equal(byKey.cancelled.safety_status, 'cancelled_may_still_run');
  assert.equal(byKey.completed.safety_status, 'completed_requires_review');
  assert.equal(byKey.orphan.safety_status, 'missing_terminal_evidence');
  assert.equal(byKey.fresh, undefined);
});

test('明确失败退款以幂等键闭环，重复调用不重复入账或审计', () => {
  const db = setup();
  const held = reserve(db, 'refund-once', { tenant: true });
  linkTask(db, held, 'failed', '供应商明确拒绝');

  const input = {
    reservationId: held.id,
    idempotencyKey: 'refund-request-0001',
    reason: '管理员核对供应商失败记录后退款',
    actorUserId: 'admin-1',
  };
  const first = reconciliation.refundReservation(db, input);
  const second = reconciliation.refundReservation(db, input);

  assert.equal(first.reservation.status, 'refunded');
  assert.equal(second.history.id, first.history.id);
  assert.equal(credits.getTenantAccount(db, 'tenant-1').available, 1000);
  assert.equal(credits.getTenantAccount(db, 'tenant-1').held, 0);
  assert.equal(db.prepare(
    "SELECT COUNT(*) AS count FROM tenant_credit_ledger WHERE reservation_id = ? AND event_type = 'refund'",
  ).get(held.id).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM billing_reconciliation_events').get().count, 1);
  assert.equal(db.prepare(
    "SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'billing.reconciliation.refunded'",
  ).get().count, 1);
  assert.equal(db.prepare(
    "SELECT user_id FROM audit_events WHERE event_type = 'billing.reconciliation.refunded'",
  ).get().user_id, 'admin-1');
});

test('租户对账退款只修改目标租户账户和账本', () => {
  const db = setup();
  credits.setTenantAccountBalance(db, 'tenant-2', 500);
  const first = reserve(db, 'tenant-one-refund', { tenant: true });
  const second = credits.reserve(db, {
    tenantId: 'tenant-2',
    actorUserId: 'user-2',
    operationKey: 'tenant-two-held',
    amount: 10,
    model: 'test-model',
    resourceType: 'text',
    resourceId: 'tenant-two-held',
  });
  db.prepare(`UPDATE tenant_usage_reservations
    SET created_at = ?, updated_at = ? WHERE id = ?`).run(OLD, OLD, second.id);
  linkTask(db, first, 'failed', '供应商明确拒绝');
  linkTask(db, second, 'failed', '供应商明确拒绝');

  reconciliation.refundReservation(db, {
    reservationId: first.id,
    idempotencyKey: 'tenant-isolation-0001',
    reason: '仅退款 tenant-1 的失败任务',
    actorUserId: 'admin-1',
  });

  assert.deepEqual(credits.getTenantAccount(db, 'tenant-1'), {
    tenant_id: 'tenant-1', available: 1000, held: 0, spent: 0,
  });
  assert.deepEqual(credits.getTenantAccount(db, 'tenant-2'), {
    tenant_id: 'tenant-2', available: 490, held: 10, spent: 0,
  });
  assert.equal(credits.getReservation(db, second.id).status, 'held');
  assert.equal(db.prepare(
    "SELECT COUNT(*) AS count FROM tenant_credit_ledger WHERE tenant_id = 'tenant-2' AND event_type = 'refund'",
  ).get().count, 0);
});

test('运行中任务不能退款，幂等键也不能跨预扣复用', () => {
  const db = setup();
  const running = reserve(db, 'unsafe-running');
  linkTask(db, running, 'processing');
  assert.throws(() => reconciliation.refundReservation(db, {
    reservationId: running.id,
    idempotencyKey: 'refund-request-0002',
    reason: '不应成功',
    actorUserId: 'admin-1',
  }), (error) => error.code === 'UNSAFE_RECONCILIATION_REFUND');
  assert.equal(credits.getReservation(db, running.id).status, 'held');

  const first = reserve(db, 'first-safe');
  const second = reserve(db, 'second-safe');
  linkTask(db, first, 'failed', '供应商明确拒绝');
  linkTask(db, second, 'failed', '供应商明确拒绝');
  reconciliation.refundReservation(db, {
    reservationId: first.id,
    idempotencyKey: 'refund-request-0003',
    reason: '首次退款',
    actorUserId: 'admin-1',
  });
  assert.throws(() => reconciliation.refundReservation(db, {
    reservationId: second.id,
    idempotencyKey: 'refund-request-0003',
    reason: '错误复用',
    actorUserId: 'admin-1',
  }), (error) => error.code === 'RECONCILIATION_IDEMPOTENCY_CONFLICT');
});

test('只有显式超时终态可退款，取消状态或失败文本仍保持冻结', () => {
  const db = setup();
  const cancelled = reserve(db, 'terminal-cancelled');
  const timedOut = reserve(db, 'terminal-timeout');
  const uncertainCancel = reserve(db, 'failed-cancel-text');
  const uncertainTimeout = reserve(db, 'failed-timeout-text');
  linkTask(db, cancelled, 'cancelled', 'provider cancelled');
  linkTask(db, timedOut, 'timed_out', 'provider timeout');
  linkTask(db, uncertainCancel, 'failed', '用户已取消');
  linkTask(db, uncertainTimeout, 'failed', '等待供应商响应超时');

  const byKey = Object.fromEntries(reconciliation.listAnomalies(db, {
    olderThanMinutes: 60,
    now: NOW,
  }).map((row) => [row.operation_key, row]));
  assert.equal(byKey['terminal-cancelled'].refundable, false);
  assert.equal(byKey['terminal-cancelled'].safety_status, 'cancelled_may_still_run');
  assert.equal(byKey['terminal-timeout'].refundable, true);
  assert.equal(byKey['failed-cancel-text'].safety_status, 'cancelled_may_still_run');
  assert.equal(byKey['failed-timeout-text'].safety_status, 'indeterminate');
});

test('关联任务表缺失时扫描显式失败，不把 schema 错误伪装成无终态证据', () => {
  const db = new Database(':memory:');
  credits.ensureSchema(db);
  credits.setAccountBalance(db, 'user-1', 20);
  const held = credits.reserve(db, {
    userId: 'user-1',
    operationKey: 'missing-schema',
    model: 'GPT-5.5',
    resourceType: 'text',
    resourceId: 'missing-schema-task',
    amount: 5,
  });
  db.prepare('UPDATE usage_reservations SET created_at = ? WHERE id = ?').run(OLD, held.id);

  assert.throws(() => reconciliation.listAnomalies(db, {
    olderThanMinutes: 60,
    now: NOW,
  }), /no such table: async_tasks/);
  db.close();
});

test('管理员 API 返回异常、处理历史并执行安全退款', () => {
  const db = setup();
  const held = reserve(db, 'route-refund', { tenant: true });
  linkTask(db, held, 'failed', '供应商明确拒绝');
  const handlers = billingRoutes(db, log);
  db.prepare('UPDATE tenant_usage_reservations SET created_at = ? WHERE id = ?')
    .run('2000-01-01T00:00:00.000Z', held.id);

  const anomaliesCapture = capture();
  handlers.listReconciliationAnomalies({
    query: { older_than_minutes: 60 },
  }, anomaliesCapture.res);
  assert.equal(anomaliesCapture.result.body.data[0].reservation_id, held.id);

  const refundCapture = capture();
  handlers.refundReconciliationReservation({
    params: { reservationId: held.id },
    body: {
      idempotency_key: 'route-refund-0001',
      reason: '后台人工核验后退款',
    },
    user: { id: 'admin-1' },
  }, refundCapture.res);
  assert.equal(refundCapture.result.body.data.reservation.status, 'refunded');

  const historyCapture = capture();
  handlers.listReconciliationHistory({ query: { limit: 20 } }, historyCapture.res);
  assert.equal(historyCapture.result.body.data.length, 1);
  assert.equal(historyCapture.result.body.data[0].reservation_id, held.id);
});
