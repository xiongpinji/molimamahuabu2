'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const userAuth = require('../src/services/userAuthService');
const tenants = require('../src/services/tenantService');
const credits = require('../src/services/creditLedgerService');
const subscriptions = require('../src/services/subscriptionBillingService');
const redeemCodes = require('../src/services/redeem-code-service');
const recharge = require('../src/services/alipay-recharge-service');
const reconciliation = require('../src/services/billingReconciliationService');

function openAcceptanceDb(filePath) {
  const db = new Database(filePath);
  userAuth.ensureSchema(db);
  tenants.ensureSchema(db);
  credits.ensureSchema(db);
  subscriptions.ensureSchema(db);
  redeemCodes.ensureSchema(db);
  recharge.ensureSchema(db);
  return db;
}

function seedWorkspace(db) {
  db.prepare(`INSERT INTO platform_users
    (id, email, password_hash, password_salt, status)
    VALUES
      ('owner-a', 'owner-a@example.com', 'hash', 'salt', 'active'),
      ('member-a', 'member-a@example.com', 'hash', 'salt', 'active'),
      ('owner-b', 'owner-b@example.com', 'hash', 'salt', 'active')`).run();
  const tenantA = tenants.createTenant(db, 'owner-a', { name: '验收工作区 A', slug: 'acceptance-a' });
  const tenantB = tenants.createTenant(db, 'owner-b', { name: '验收工作区 B', slug: 'acceptance-b' });
  tenants.addMemberByEmail(db, tenantA.id, 'owner-a', {
    email: 'member-a@example.com',
    role: 'member',
  });
  credits.setTenantAccountBalance(db, tenantA.id, 100);
  credits.setTenantAccountBalance(db, tenantB.id, 50);
  return { tenantA, tenantB };
}

function tempDatabase(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-shared-billing-'));
  const filePath = path.join(dir, 'acceptance.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return filePath;
}

function reserveTenant(db, tenantId, operationKey, amount, resourceId = operationKey) {
  return credits.reserve(db, {
    tenantId,
    actorUserId: 'owner-a',
    operationKey,
    amount,
    model: 'acceptance-model',
    resourceType: 'image',
    resourceId,
  });
}

test('积分预占、确认、退款和结果未知在重开数据库后保持幂等且租户隔离', (t) => {
  const filePath = tempDatabase(t);
  let db = openAcceptanceDb(filePath);
  const { tenantA, tenantB } = seedWorkspace(db);

  const completed = reserveTenant(db, tenantA.id, 'completed-operation', 10);
  assert.equal(reserveTenant(db, tenantA.id, 'completed-operation', 10).id, completed.id);
  const repriced = reserveTenant(db, tenantA.id, 'completed-operation', 11);
  assert.equal(repriced.id, completed.id);
  assert.equal(repriced.amount, 10);
  assert.throws(
    () => reserveTenant(db, tenantA.id, 'completed-operation', 10, 'changed-resource'),
    (error) => error.code === 'CREDIT_RESERVATION_IDEMPOTENCY_CONFLICT',
  );
  credits.confirm(db, completed.id);
  credits.confirm(db, completed.id);

  const failed = reserveTenant(db, tenantA.id, 'failed-operation', 20);
  credits.refund(db, failed.id, 'provider_rejected');
  credits.refund(db, failed.id, 'provider_rejected');

  const unknown = reserveTenant(db, tenantA.id, 'unknown-operation', 15);
  credits.settleGeneration(db, unknown.id, 'failed', '供应商最终状态未知，请勿重新提交');

  assert.deepEqual(credits.getTenantAccount(db, tenantA.id), {
    tenant_id: tenantA.id,
    available: 75,
    held: 15,
    spent: 10,
  });
  assert.deepEqual(credits.getTenantAccount(db, tenantB.id), {
    tenant_id: tenantB.id,
    available: 50,
    held: 0,
    spent: 0,
  });
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM tenant_credit_ledger
    WHERE tenant_id = ?`).get(tenantA.id).count, 5);
  assert.equal(credits.getReservation(db, unknown.id).status, 'held');

  db.close();
  db = openAcceptanceDb(filePath);
  assert.deepEqual(credits.getTenantAccount(db, tenantA.id), {
    tenant_id: tenantA.id,
    available: 75,
    held: 15,
    spent: 10,
  });
  assert.equal(credits.getReservation(db, completed.id).status, 'confirmed');
  assert.equal(credits.getReservation(db, failed.id).status, 'refunded');
  assert.equal(credits.getReservation(db, unknown.id).status, 'held');
  db.close();
});

test('兑换与套餐订单只产生一次事实，幂等键不能绑定变化后的请求', (t) => {
  const filePath = tempDatabase(t);
  const db = openAcceptanceDb(filePath);
  const { tenantA, tenantB } = seedWorkspace(db);

  const code = redeemCodes.createCode(db, { credits: 30, maxRedemptions: 1 });
  redeemCodes.redeem(db, { code: code.code, tenantId: tenantA.id, userId: 'owner-a' });
  assert.throws(
    () => redeemCodes.redeem(db, { code: code.code, tenantId: tenantA.id, userId: 'owner-a' }),
    (error) => error.code === 'CODE_ALREADY_REDEEMED',
  );
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM tenant_credit_adjustments
    WHERE tenant_id = ? AND reference_type = 'redeem_code'`).get(tenantA.id).count, 1);

  subscriptions.upsertPlan(db, 'creator', {
    name: '创作版', price_cents: 9900, monthly_credits: 1000, currency: 'CNY', status: 'active',
  });
  subscriptions.upsertPlan(db, 'studio', {
    name: '工作室版', price_cents: 19900, monthly_credits: 2500, currency: 'CNY', status: 'active',
  });
  const order = subscriptions.createOrder(db, {
    tenantId: tenantA.id,
    userId: 'owner-a',
    planId: 'creator',
    clientOrderKey: 'shared-acceptance-order',
  });
  assert.equal(subscriptions.createOrder(db, {
    tenantId: tenantA.id,
    userId: 'owner-a',
    planId: 'creator',
    clientOrderKey: 'shared-acceptance-order',
  }).id, order.id);
  assert.throws(
    () => subscriptions.createOrder(db, {
      tenantId: tenantA.id,
      userId: 'owner-a',
      planId: 'studio',
      clientOrderKey: 'shared-acceptance-order',
    }),
    (error) => error.code === 'BILLING_ORDER_IDEMPOTENCY_CONFLICT',
  );
  assert.throws(
    () => subscriptions.createOrder(db, {
      tenantId: tenantA.id,
      userId: 'member-a',
      planId: 'creator',
      clientOrderKey: 'member-cannot-order',
    }),
    (error) => error.code === 'TENANT_NOT_FOUND',
  );
  assert.deepEqual(subscriptions.listOrders(db, tenantB.id, 'owner-b'), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_billing_orders').get().count, 1);
  assert.equal(credits.getTenantAccount(db, tenantA.id).available, 130);
  assert.equal(credits.getTenantAccount(db, tenantB.id).available, 50);
  db.close();
});

test('支付宝本地签名回调在服务重启后仍只入账一次，非法通知不改变订单和积分', (t) => {
  const filePath = tempDatabase(t);
  let db = openAcceptanceDb(filePath);
  const { tenantA, tenantB } = seedWorkspace(db);
  const gateway = {
    configured: true,
    appId: 'acceptance-app',
    sellerId: '2088000000000000',
    verifyNotification(payload) { return payload.sign === 'valid'; },
  };
  const order = recharge.createOrder(db, {
    tenantId: tenantA.id,
    userId: 'owner-a',
    amountYuan: '1.00',
    clientOrderKey: 'shared-recharge-order',
  });
  const payload = {
    sign: 'valid',
    app_id: gateway.appId,
    seller_id: gateway.sellerId,
    trade_status: 'TRADE_SUCCESS',
    out_trade_no: order.out_trade_no,
    trade_no: '202608220000000001',
    total_amount: '1.00',
  };
  assert.equal(recharge.processNotification(db, payload, gateway).credited, true);
  db.close();

  db = openAcceptanceDb(filePath);
  assert.equal(recharge.processNotification(db, payload, gateway).credited, false);
  const invalidOrder = recharge.createOrder(db, {
    tenantId: tenantA.id,
    userId: 'owner-a',
    amountYuan: '2.00',
    clientOrderKey: 'invalid-recharge-order',
  });
  assert.throws(
    () => recharge.processNotification(db, {
      ...payload,
      out_trade_no: invalidOrder.out_trade_no,
      trade_no: '202608220000000002',
      total_amount: '1.00',
    }, gateway),
    (error) => error.code === 'ALIPAY_AMOUNT_MISMATCH',
  );
  assert.throws(
    () => recharge.processNotification(db, { ...payload, sign: 'invalid' }, gateway),
    (error) => error.code === 'ALIPAY_INVALID_SIGNATURE',
  );
  assert.equal(db.prepare('SELECT status FROM tenant_recharge_orders WHERE id = ?')
    .get(invalidOrder.id).status, 'pending');
  assert.deepEqual(credits.getTenantAccount(db, tenantA.id), {
    tenant_id: tenantA.id,
    available: 200,
    held: 0,
    spent: 0,
  });
  assert.deepEqual(credits.getTenantAccount(db, tenantB.id), {
    tenant_id: tenantB.id,
    available: 50,
    held: 0,
    spent: 0,
  });
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM tenant_credit_adjustments
    WHERE reference_type = 'alipay_recharge_order'`).get().count, 1);
  db.close();
});

test('人工对账只退款明确失败，运行中与结果未知继续冻结且重复退款不重复记账', (t) => {
  const filePath = tempDatabase(t);
  const db = openAcceptanceDb(filePath);
  const { tenantA } = seedWorkspace(db);
  reconciliation.ensureSchema(db);
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
  const failed = reserveTenant(db, tenantA.id, 'reconcile-failed', 10);
  const unknown = reserveTenant(db, tenantA.id, 'reconcile-unknown', 10);
  const old = '2026-08-21T00:00:00.000Z';
  db.prepare('UPDATE tenant_usage_reservations SET created_at = ?, updated_at = ? WHERE id IN (?, ?)')
    .run(old, old, failed.id, unknown.id);
  const insertTask = db.prepare(`INSERT INTO async_tasks
    (id, type, status, message, error, credit_reservation_id, created_at, updated_at, completed_at)
    VALUES (?, 'acceptance', ?, '', ?, ?, ?, ?, ?)`);
  insertTask.run('failed-task', 'failed', '供应商明确拒绝', failed.id, old, old, old);
  insertTask.run('unknown-task', 'failed', '供应商最终状态未知，请勿重新提交', unknown.id, old, old, old);

  const anomalies = reconciliation.listAnomalies(db, {
    olderThanMinutes: 60,
    now: '2026-08-22T12:00:00.000Z',
  });
  const byId = Object.fromEntries(anomalies.map((row) => [row.reservation_id, row]));
  assert.equal(byId[failed.id].refundable, true);
  assert.equal(byId[unknown.id].refundable, false);
  assert.equal(byId[unknown.id].safety_status, 'indeterminate');

  const refundInput = {
    reservationId: failed.id,
    idempotencyKey: 'shared-reconcile-refund',
    reason: '公共底座验收明确失败退款',
    actorUserId: 'platform-admin',
  };
  const first = reconciliation.refundReservation(db, refundInput);
  const repeated = reconciliation.refundReservation(db, refundInput);
  assert.equal(first.history.id, repeated.history.id);
  assert.equal(credits.getReservation(db, failed.id).status, 'refunded');
  assert.equal(credits.getReservation(db, unknown.id).status, 'held');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM tenant_credit_ledger
    WHERE reservation_id = ? AND event_type = 'refund'`).get(failed.id).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM billing_reconciliation_events').get().count, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM audit_events
    WHERE event_type = 'billing.reconciliation.refunded'`).get().count, 1);
  db.close();
});
