const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const creditLedger = require('../src/services/creditLedgerService');

function setup(available = 100) {
  const db = new Database(':memory:');
  creditLedger.ensureSchema(db);
  creditLedger.setAccountBalance(db, 'user-1', available);
  return db;
}

test('旧版积分调整表升级后保留历史流水并支持充值入账', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tenant_credit_adjustments (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_user_id TEXT,
      event_type TEXT NOT NULL CHECK (event_type IN ('redeem', 'admin_adjust')),
      amount INTEGER NOT NULL CHECK (amount != 0),
      reason TEXT NOT NULL,
      reference_type TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (tenant_id, reference_type, reference_id)
    );
    INSERT INTO tenant_credit_adjustments
      (id, tenant_id, actor_user_id, event_type, amount, reason,
        reference_type, reference_id, created_at)
    VALUES
      ('old-adjustment', 'tenant-1', 'admin-1', 'admin_adjust', 20, '历史调整',
        'admin_adjustment', 'old-reference', '2026-08-01T00:00:00.000Z');
  `);

  creditLedger.ensureSchema(db);
  const credited = creditLedger.adjustTenantBalance(db, {
    tenantId: 'tenant-1',
    actorUserId: 'user-1',
    eventType: 'recharge',
    amount: 100,
    reason: '支付宝充值到账',
    referenceType: 'alipay_recharge_order',
    referenceId: 'order-1',
  });

  assert.equal(credited.event_type, 'recharge');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_credit_adjustments').get().count, 2);
  assert.equal(db.prepare(`SELECT event_type FROM tenant_credit_adjustments
    WHERE id = 'old-adjustment'`).get().event_type, 'admin_adjust');
  assert.equal(creditLedger.getTenantAccount(db, 'tenant-1').available, 100);
});

test('预扣额度后可用余额减少且冻结额度增加', () => {
  const db = setup(100);
  const reservation = creditLedger.reserve(db, {
    userId: 'user-1', operationKey: 'image:1', amount: 20,
    model: 'gpt-image-2', resourceType: 'image', resourceId: '1',
  });
  assert.equal(reservation.status, 'held');
  assert.deepEqual(creditLedger.getAccount(db, 'user-1'), {
    user_id: 'user-1', available: 80, held: 20, spent: 0,
  });
});

test('相同操作号重复预扣只产生一次扣款', () => {
  const db = setup(100);
  const input = {
    userId: 'user-1', operationKey: 'video:7', amount: 35,
    model: 'seedance-2.0', resourceType: 'video', resourceId: '7',
  };
  const first = creditLedger.reserve(db, input);
  const second = creditLedger.reserve(db, input);
  assert.equal(second.id, first.id);
  assert.equal(creditLedger.getAccount(db, 'user-1').available, 65);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM credit_ledger').get().n, 1);
});

test('余额不足时拒绝预扣且不改变账户', () => {
  const db = setup(10);
  assert.throws(() => creditLedger.reserve(db, {
    userId: 'user-1', operationKey: 'image:2', amount: 20,
    model: 'gpt-image-2', resourceType: 'image', resourceId: '2',
  }), (error) => error.code === 'INSUFFICIENT_CREDITS');
  assert.equal(creditLedger.getAccount(db, 'user-1').available, 10);
});

test('成功确认只执行一次并把冻结额度计入已消费', () => {
  const db = setup(100);
  const held = creditLedger.reserve(db, {
    userId: 'user-1', operationKey: 'video:8', amount: 35,
    model: 'seedance-2.0', resourceType: 'video', resourceId: '8',
  });
  creditLedger.confirm(db, held.id);
  creditLedger.confirm(db, held.id);
  assert.deepEqual(creditLedger.getAccount(db, 'user-1'), {
    user_id: 'user-1', available: 65, held: 0, spent: 35,
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE event_type = 'confirm'").get().n, 1);
});

test('明确失败退款只执行一次并归还冻结额度', () => {
  const db = setup(100);
  const held = creditLedger.reserve(db, {
    userId: 'user-1', operationKey: 'image:3', amount: 20,
    model: 'gpt-image-2', resourceType: 'image', resourceId: '3',
  });
  creditLedger.refund(db, held.id, 'provider_failed');
  creditLedger.refund(db, held.id, 'provider_failed');
  assert.deepEqual(creditLedger.getAccount(db, 'user-1'), {
    user_id: 'user-1', available: 100, held: 0, spent: 0,
  });
});

test('结果未知不做确认或退款时额度保持冻结', () => {
  const db = setup(100);
  const held = creditLedger.reserve(db, {
    userId: 'user-1', operationKey: 'video:9', amount: 35,
    model: 'seedance-2.0', resourceType: 'video', resourceId: '9',
  });
  assert.equal(creditLedger.getReservation(db, held.id).status, 'held');
  assert.equal(creditLedger.getAccount(db, 'user-1').held, 35);
});

test('生成成功时结算预扣积分', () => {
  const db = setup(100);
  const held = creditLedger.reserve(db, {
    userId: 'user-1', operationKey: 'image:10', amount: 20,
    model: 'gpt-image-2', resourceType: 'image', resourceId: '10',
  });
  creditLedger.settleGeneration(db, held.id, 'completed');
  assert.equal(creditLedger.getReservation(db, held.id).status, 'confirmed');
});

test('生成明确失败时退款', () => {
  const db = setup(100);
  const held = creditLedger.reserve(db, {
    userId: 'user-1', operationKey: 'image:11', amount: 20,
    model: 'gpt-image-2', resourceType: 'image', resourceId: '11',
  });
  creditLedger.settleGeneration(db, held.id, 'failed', '供应商明确拒绝请求');
  assert.equal(creditLedger.getReservation(db, held.id).status, 'refunded');
});

test('生成结果未知时保持冻结并返回 held', () => {
  const db = setup(100);
  const held = creditLedger.reserve(db, {
    userId: 'user-1', operationKey: 'image:12', amount: 20,
    model: 'gpt-image-2', resourceType: 'image', resourceId: '12',
  });
  const result = creditLedger.settleGeneration(db, held.id, 'failed', '网络中断，供应商结果未知，请勿重复提交');
  assert.equal(result.status, 'held');
  assert.equal(creditLedger.getAccount(db, 'user-1').held, 20);
});
