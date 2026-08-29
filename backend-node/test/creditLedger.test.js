const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

test('claim 原子认领新预扣并标记 created', () => {
  const db = setup(100);
  const result = creditLedger.claim(db, {
    userId: 'user-1', operationKey: 'claim:image:1', amount: 20,
    model: 'gpt-image-2', resourceType: 'image', resourceId: '1',
  });

  assert.equal(result.created, true);
  assert.equal(result.reservation.status, 'held');
  assert.equal(creditLedger.getAccount(db, 'user-1').available, 80);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM credit_ledger').get().n, 1);
});

test('claim 遇到已存在操作号返回 existing 且不重复扣款', () => {
  const db = setup(100);
  const input = {
    userId: 'user-1', operationKey: 'claim:image:existing', amount: 20,
    model: 'gpt-image-2', resourceType: 'image', resourceId: 'existing',
  };
  const first = creditLedger.claim(db, input);
  const second = creditLedger.claim(db, input);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.reservation.id, first.reservation.id);
  assert.equal(creditLedger.getAccount(db, 'user-1').available, 80);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM credit_ledger').get().n, 1);
});

test('tenant claim 按租户和 operation_key 隔离 existing 检查', () => {
  const db = setup(100);
  creditLedger.setTenantAccountBalance(db, 'tenant-a', 100);
  creditLedger.setTenantAccountBalance(db, 'tenant-b', 100);
  const base = {
    userId: 'user-1', operationKey: 'claim:tenant:image', amount: 20,
    model: 'gpt-image-2', resourceType: 'image', resourceId: 'tenant-image',
  };
  const first = creditLedger.claim(db, { ...base, tenantId: 'tenant-a' });
  const sameTenant = creditLedger.claim(db, { ...base, tenantId: 'tenant-a' });
  const otherTenant = creditLedger.claim(db, { ...base, tenantId: 'tenant-b' });

  assert.equal(first.created, true);
  assert.equal(sameTenant.created, false);
  assert.equal(otherTenant.created, true);
  assert.equal(creditLedger.getTenantAccount(db, 'tenant-a').available, 80);
  assert.equal(creditLedger.getTenantAccount(db, 'tenant-b').available, 80);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tenant_credit_ledger').get().n, 2);
});

test('tenant claim 在两个 SQLite 连接间串行且不重复扣款', () => {
  const file = path.join(os.tmpdir(), `credit-claim-${Date.now()}-${process.pid}.db`);
  const db1 = new Database(file);
  const db2 = new Database(file);
  try {
    creditLedger.ensureSchema(db1);
    creditLedger.setTenantAccountBalance(db1, 'tenant-a', 100);
    const input = {
      tenantId: 'tenant-a',
      userId: 'user-1',
      actorUserId: 'user-1',
      operationKey: 'claim:tenant:shared-file',
      amount: 20,
      model: 'gpt-image-2',
      resourceType: 'image',
      resourceId: 'shared-file',
    };

    const first = creditLedger.claim(db1, input);
    const second = creditLedger.claim(db2, input);

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.reservation.id, first.reservation.id);
    assert.equal(creditLedger.getTenantAccount(db2, 'tenant-a').available, 80);
    assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM tenant_credit_ledger').get().n, 1);
  } finally {
    db1.close();
    db2.close();
    fs.rmSync(file, { force: true });
  }
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

test('相同 id 的租户迁移副本不抢占用户预扣结算', () => {
  const db = setup(100);
  const held = creditLedger.reserve(db, {
    userId: 'user-1', operationKey: 'image:migrated', amount: 20,
    model: 'gpt-image-2', resourceType: 'image', resourceId: 'migrated',
  });
  creditLedger.setTenantAccountBalance(db, 'personal:user-1', 100);
  db.prepare(`
    INSERT INTO tenant_usage_reservations
      (id, tenant_id, operation_key, actor_user_id, model, resource_type, resource_id, amount, status, created_at, updated_at)
    VALUES (?, 'personal:user-1', 'image:migrated', 'user-1', 'gpt-image-2', 'image', 'migrated', 20, 'held', ?, ?)
  `).run(held.id, new Date().toISOString(), new Date().toISOString());

  creditLedger.settleGeneration(db, held.id, 'completed');

  assert.equal(db.prepare('SELECT status FROM usage_reservations WHERE id = ?').get(held.id).status, 'confirmed');
  assert.equal(db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(held.id).status, 'held');
  assert.equal(creditLedger.getAccount(db, 'user-1').spent, 20);
});

test('显式积分作用域在相同 id 下只查询并结算指定账户', () => {
  const db = setup(100);
  const userHeld = creditLedger.reserve(db, {
    userId: 'user-1', operationKey: 'video:scoped-user', amount: 20,
    model: 'seedance-2.0', resourceType: 'video', resourceId: 'scoped-video',
  });
  creditLedger.setTenantAccountBalance(db, 'tenant-1', 100);
  const tenantHeld = creditLedger.reserve(db, {
    tenantId: 'tenant-1', actorUserId: 'user-1', operationKey: 'video:scoped-tenant', amount: 30,
    model: 'seedance-2.0', resourceType: 'video', resourceId: 'scoped-video',
  });
  db.prepare('UPDATE tenant_usage_reservations SET id = ? WHERE id = ?')
    .run(userHeld.id, tenantHeld.id);
  db.prepare('UPDATE tenant_credit_ledger SET reservation_id = ? WHERE reservation_id = ?')
    .run(userHeld.id, tenantHeld.id);

  assert.equal(creditLedger.getReservation(db, userHeld.id).user_id, 'user-1');
  assert.equal(
    creditLedger.getReservationForScope(db, userHeld.id, { tenantId: 'tenant-1' }).tenant_id,
    'tenant-1',
  );
  assert.equal(
    creditLedger.getReservationForScope(db, userHeld.id, { userId: 'user-1' }).user_id,
    'user-1',
  );

  creditLedger.confirmForScope(db, userHeld.id, { tenantId: 'tenant-1' });
  assert.equal(db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(userHeld.id).status, 'confirmed');
  assert.equal(db.prepare('SELECT status FROM usage_reservations WHERE id = ?').get(userHeld.id).status, 'held');
  assert.deepEqual(creditLedger.getTenantAccount(db, 'tenant-1'), {
    tenant_id: 'tenant-1', available: 70, held: 0, spent: 30,
  });
  assert.deepEqual(creditLedger.getAccount(db, 'user-1'), {
    user_id: 'user-1', available: 80, held: 20, spent: 0,
  });

  creditLedger.refundForScope(db, userHeld.id, { userId: 'user-1' }, 'provider_task_failed');
  assert.equal(db.prepare('SELECT status FROM usage_reservations WHERE id = ?').get(userHeld.id).status, 'refunded');
  assert.deepEqual(creditLedger.getAccount(db, 'user-1'), {
    user_id: 'user-1', available: 100, held: 0, spent: 0,
  });
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

test('结构化明确失败优先于错误文案并立即退款', () => {
  const db = setup(100);
  const held = creditLedger.reserve(db, {
    userId: 'user-1', operationKey: 'video:structured-refund', amount: 20,
    model: 'wan3.0-video', resourceType: 'video', resourceId: 'structured-refund',
  });
  const result = creditLedger.settleGeneration(
    db,
    held.id,
    'failed',
    '错误文案包含状态未知，但供应商已明确拒绝',
    { failureDisposition: 'refund', category: 'validation_error' },
  );
  assert.equal(result.status, 'refunded');
  assert.deepEqual(creditLedger.getAccount(db, 'user-1'), {
    user_id: 'user-1', available: 100, held: 0, spent: 0,
  });
});

test('结构化未知结果优先于错误文案并保持冻结', () => {
  const db = setup(100);
  const held = creditLedger.reserve(db, {
    userId: 'user-1', operationKey: 'video:structured-hold', amount: 20,
    model: 'wan3.0-video', resourceType: 'video', resourceId: 'structured-hold',
  });
  const result = creditLedger.settleGeneration(
    db,
    held.id,
    'failed',
    '错误文案声称供应商明确失败',
    { failureDisposition: 'hold', category: 'submission_unknown' },
  );
  assert.equal(result.status, 'held');
  assert.deepEqual(creditLedger.getAccount(db, 'user-1'), {
    user_id: 'user-1', available: 80, held: 20, spent: 0,
  });
});
