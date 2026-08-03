const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const tenantService = require('../src/services/tenantService');
const userAuth = require('../src/services/userAuthService');
const creditLedger = require('../src/services/creditLedgerService');
const recharge = require('../src/services/alipay-recharge-service');

function setup() {
  const db = new Database(':memory:');
  userAuth.ensureSchema(db);
  tenantService.ensureSchema(db);
  creditLedger.ensureSchema(db);
  recharge.ensureSchema(db);
  db.prepare(`INSERT INTO platform_users
    (id, email, password_hash, password_salt, status)
    VALUES ('user-1', 'owner@example.com', 'hash', 'salt', 'active')`).run();
  const tenant = tenantService.createTenant(db, 'user-1', {
    name: '一号工作区',
    slug: 'workspace-one',
  });
  creditLedger.setTenantAccountBalance(db, tenant.id, 0);
  return { db, tenant };
}

test('用户自定义充值固定按 1 元兑换 100 积分且幂等建单不提前入账', () => {
  const { db, tenant } = setup();
  const first = recharge.createOrder(db, {
    tenantId: tenant.id,
    userId: 'user-1',
    amountYuan: '12.34',
    clientOrderKey: 'custom-order-001',
  });
  const repeated = recharge.createOrder(db, {
    tenantId: tenant.id,
    userId: 'user-1',
    amountYuan: '12.34',
    clientOrderKey: 'custom-order-001',
  });

  assert.equal(first.id, repeated.id);
  assert.equal(first.order_kind, 'custom');
  assert.equal(first.amount_cents, 1234);
  assert.equal(first.credits, 1234);
  assert.equal(first.status, 'pending');
  assert.match(first.out_trade_no, /^MOLI[0-9A-F]{32}$/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_recharge_orders').get().count, 1);
  assert.equal(creditLedger.getTenantAccount(db, tenant.id).available, 0);
});

test('同一幂等键不能被改成不同金额或不同套餐', () => {
  const { db, tenant } = setup();
  recharge.createOrder(db, {
    tenantId: tenant.id,
    userId: 'user-1',
    amountYuan: '10',
    clientOrderKey: 'same-key-different-payload',
  });

  assert.throws(() => recharge.createOrder(db, {
    tenantId: tenant.id,
    userId: 'user-1',
    amountYuan: '20',
    clientOrderKey: 'same-key-different-payload',
  }), (error) => error.code === 'RECHARGE_ORDER_IDEMPOTENCY_CONFLICT');
});

test('同一工作区的不同用户只能查看本人充值订单', () => {
  const { db, tenant } = setup();
  db.prepare(`INSERT INTO platform_users
    (id, email, password_hash, password_salt, status)
    VALUES ('user-2', 'member@example.com', 'hash', 'salt', 'active')`).run();
  tenantService.addMemberByEmail(db, tenant.id, 'user-1', {
    email: 'member@example.com',
    role: 'member',
  });
  const ownerOrder = recharge.createOrder(db, {
    tenantId: tenant.id,
    userId: 'user-1',
    amountYuan: '10',
    clientOrderKey: 'owner-private-order',
  });
  const memberOrder = recharge.createOrder(db, {
    tenantId: tenant.id,
    userId: 'user-2',
    amountYuan: '20',
    clientOrderKey: 'member-private-order',
  });

  assert.deepEqual(recharge.listOrders(db, tenant.id, 'user-1').map((item) => item.id), [ownerOrder.id]);
  assert.deepEqual(recharge.listOrders(db, tenant.id, 'user-2').map((item) => item.id), [memberOrder.id]);
});

test('自定义充值拒绝小于 1 元、超过两位小数和超过 5 万元的金额', () => {
  const { db, tenant } = setup();
  for (const amountYuan of ['0.99', '1.001', '50000.01', 'abc']) {
    assert.throws(() => recharge.createOrder(db, {
      tenantId: tenant.id,
      userId: 'user-1',
      amountYuan,
      clientOrderKey: `invalid-${amountYuan}`,
    }), (error) => error.code === 'INVALID_RECHARGE_AMOUNT');
  }
});

test('管理员限时套餐按售价和积分展示并在下单时保存快照', () => {
  const { db, tenant } = setup();
  const active = recharge.createPackage(db, {
    name: '暑期限时包',
    amountYuan: '9.90',
    credits: 1500,
    startsAt: '2026-08-01T00:00:00.000Z',
    endsAt: '2026-08-10T00:00:00.000Z',
    imageUrl: 'https://cdn.example.com/summer.jpg',
    status: 'active',
  });
  recharge.createPackage(db, {
    name: '尚未开始',
    amountYuan: '19.90',
    credits: 2500,
    startsAt: '2026-08-20T00:00:00.000Z',
    endsAt: '2026-08-30T00:00:00.000Z',
    imageUrl: 'https://cdn.example.com/future.jpg',
    status: 'active',
  });

  const available = recharge.listAvailablePackages(db, '2026-08-03T00:00:00.000Z');
  assert.deepEqual(available.map((item) => item.id), [active.id]);
  assert.equal(available[0].amount_cents, 990);
  assert.equal(available[0].credits, 1500);

  const order = recharge.createOrder(db, {
    tenantId: tenant.id,
    userId: 'user-1',
    packageId: active.id,
    clientOrderKey: 'package-order-001',
    now: '2026-08-03T00:00:00.000Z',
  });
  recharge.updatePackage(db, active.id, {
    name: '暑期限时包（已调整）',
    amountYuan: '19.90',
    credits: 2000,
    startsAt: '2026-08-01T00:00:00.000Z',
    endsAt: '2026-08-10T00:00:00.000Z',
    imageUrl: 'https://cdn.example.com/summer-v2.jpg',
    status: 'active',
  });

  const persisted = db.prepare('SELECT * FROM tenant_recharge_orders WHERE id = ?').get(order.id);
  assert.equal(persisted.order_kind, 'package');
  assert.equal(persisted.package_id, active.id);
  assert.equal(persisted.package_name, '暑期限时包');
  assert.equal(persisted.amount_cents, 990);
  assert.equal(persisted.credits, 1500);
});

test('套餐拒绝无效时间、非 HTTPS 广告图且过期后不能下单', () => {
  const { db, tenant } = setup();
  assert.throws(() => recharge.createPackage(db, {
    name: '缺少广告图',
    amountYuan: '0.01',
    credits: 10,
    status: 'active',
  }), (error) => error.code === 'INVALID_RECHARGE_PACKAGE');

  const smallAmount = recharge.createPackage(db, {
    name: '一分钱体验包',
    amountYuan: '0.01',
    credits: 10,
    imageUrl: 'https://cdn.example.com/trial.jpg',
    status: 'active',
  });
  assert.equal(smallAmount.amount_cents, 1);

  assert.throws(() => recharge.createPackage(db, {
    name: '错误套餐',
    amountYuan: '10',
    credits: 1000,
    startsAt: '2026-08-10T00:00:00.000Z',
    endsAt: '2026-08-01T00:00:00.000Z',
    imageUrl: 'http://cdn.example.com/banner.jpg',
    status: 'active',
  }), (error) => error.code === 'INVALID_RECHARGE_PACKAGE');

  const expired = recharge.createPackage(db, {
    name: '已结束套餐',
    amountYuan: '10',
    credits: 1200,
    startsAt: '2026-07-01T00:00:00.000Z',
    endsAt: '2026-08-01T00:00:00.000Z',
    imageUrl: 'https://cdn.example.com/expired.jpg',
    status: 'active',
  });
  assert.throws(() => recharge.createOrder(db, {
    tenantId: tenant.id,
    userId: 'user-1',
    packageId: expired.id,
    clientOrderKey: 'expired-package-order',
    now: '2026-08-03T00:00:00.000Z',
  }), (error) => error.code === 'RECHARGE_PACKAGE_NOT_AVAILABLE');
});

function fakeGateway() {
  return {
    configured: true,
    appId: 'app-123',
    sellerId: '2088000000000000',
    verifyNotification(payload) {
      return payload.sign === 'valid-signature';
    },
  };
}

test('合法支付宝成功通知原子入账且重复通知不重复增加积分', () => {
  const { db, tenant } = setup();
  const order = recharge.createOrder(db, {
    tenantId: tenant.id,
    userId: 'user-1',
    amountYuan: '12.34',
    clientOrderKey: 'notify-order-001',
  });
  const payload = {
    sign: 'valid-signature',
    app_id: 'app-123',
    seller_id: '2088000000000000',
    trade_status: 'TRADE_SUCCESS',
    out_trade_no: order.out_trade_no,
    trade_no: '2026080322000000000001',
    total_amount: '12.34',
  };

  const first = recharge.processNotification(db, payload, fakeGateway());
  const repeated = recharge.processNotification(db, payload, fakeGateway());

  assert.equal(first.credited, true);
  assert.equal(repeated.credited, false);
  assert.equal(repeated.order.status, 'paid');
  assert.equal(repeated.order.alipay_trade_no, payload.trade_no);
  assert.equal(creditLedger.getTenantAccount(db, tenant.id).available, 1234);
  const adjustments = creditLedger.listTenantAdjustments(db, tenant.id);
  assert.equal(adjustments.length, 1);
  assert.equal(adjustments[0].event_type, 'recharge');
  assert.equal(adjustments[0].amount, 1234);
  assert.equal(adjustments[0].reference_type, 'alipay_recharge_order');
  assert.equal(adjustments[0].reference_id, order.id);
});

test('低于一元的套餐订单仍能按支付宝通知金额正确入账', () => {
  const { db, tenant } = setup();
  const rechargePackage = recharge.createPackage(db, {
    name: '一分钱体验包',
    amountYuan: '0.01',
    credits: 10,
    imageUrl: 'https://cdn.example.com/trial.jpg',
    status: 'active',
  });
  const order = recharge.createOrder(db, {
    tenantId: tenant.id,
    userId: 'user-1',
    packageId: rechargePackage.id,
    clientOrderKey: 'small-package-notify',
  });

  recharge.processNotification(db, {
    sign: 'valid-signature',
    app_id: 'app-123',
    seller_id: '2088000000000000',
    trade_status: 'TRADE_SUCCESS',
    out_trade_no: order.out_trade_no,
    trade_no: '2026080322000000000004',
    total_amount: '0.01',
  }, fakeGateway());

  assert.equal(creditLedger.getTenantAccount(db, tenant.id).available, 10);
});

test('伪造签名、身份或金额不匹配的通知不会入账', () => {
  const { db, tenant } = setup();
  const order = recharge.createOrder(db, {
    tenantId: tenant.id,
    userId: 'user-1',
    amountYuan: '10',
    clientOrderKey: 'notify-order-invalid',
  });
  const valid = {
    sign: 'valid-signature',
    app_id: 'app-123',
    seller_id: '2088000000000000',
    trade_status: 'TRADE_SUCCESS',
    out_trade_no: order.out_trade_no,
    trade_no: '2026080322000000000002',
    total_amount: '10.00',
  };
  const invalidPayloads = [
    { ...valid, sign: 'forged' },
    { ...valid, app_id: 'wrong-app' },
    { ...valid, seller_id: '2088999999999999' },
    { ...valid, trade_status: 'WAIT_BUYER_PAY' },
    { ...valid, total_amount: '9.99' },
    { ...valid, out_trade_no: 'MOLIUNKNOWNORDER' },
  ];

  for (const payload of invalidPayloads) {
    assert.throws(
      () => recharge.processNotification(db, payload, fakeGateway()),
      (error) => error.code?.startsWith('ALIPAY_') || error.code === 'RECHARGE_ORDER_NOT_FOUND',
    );
  }
  assert.equal(db.prepare('SELECT status FROM tenant_recharge_orders WHERE id = ?').get(order.id).status, 'pending');
  assert.equal(creditLedger.getTenantAccount(db, tenant.id).available, 0);
});

test('同一支付宝交易号不能为两个订单重复入账', () => {
  const { db, tenant } = setup();
  const first = recharge.createOrder(db, {
    tenantId: tenant.id,
    userId: 'user-1',
    amountYuan: '10',
    clientOrderKey: 'trade-number-first',
  });
  const second = recharge.createOrder(db, {
    tenantId: tenant.id,
    userId: 'user-1',
    amountYuan: '10',
    clientOrderKey: 'trade-number-second',
  });
  const payload = {
    sign: 'valid-signature',
    app_id: 'app-123',
    seller_id: '2088000000000000',
    trade_status: 'TRADE_SUCCESS',
    trade_no: '2026080322000000000099',
    total_amount: '10.00',
  };

  recharge.processNotification(db, { ...payload, out_trade_no: first.out_trade_no }, fakeGateway());
  assert.throws(
    () => recharge.processNotification(db, { ...payload, out_trade_no: second.out_trade_no }, fakeGateway()),
    (error) => error.code === 'ALIPAY_ORDER_CONFLICT',
  );
  assert.equal(db.prepare('SELECT status FROM tenant_recharge_orders WHERE id = ?').get(second.id).status, 'pending');
  assert.equal(creditLedger.getTenantAccount(db, tenant.id).available, 1000);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM tenant_credit_adjustments
    WHERE event_type = 'recharge'`).get().count, 1);
});
