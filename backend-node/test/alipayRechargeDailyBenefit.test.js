const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const recharge = require('../src/services/alipay-recharge-service');
const credits = require('../src/services/creditLedgerService');
const dailyBonus = require('../src/services/dailyRechargeBonusService');

const NOW = '2026-08-11T03:00:00.000Z';

function setup() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE tenant_members (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (tenant_id, user_id)
  )`);
  db.prepare(`INSERT INTO tenant_members (tenant_id, user_id, status)
    VALUES ('tenant-a', 'user-1', 'active')`).run();
  recharge.ensureSchema(db);
  credits.ensureSchema(db);
  return db;
}

function packageInput(overrides = {}) {
  return {
    name: '每日会员',
    amountYuan: '100.00',
    dailyBonusCredits: 1000,
    imageUrl: 'https://molimama.vip/static/package.png',
    badgeText: '推荐',
    adTitle: '每日会员权益',
    adSubtitle: '连续30天每日赠送',
    buttonText: '立即购买',
    accentColor: '#ff7139',
    sortOrder: 0,
    isFeatured: false,
    status: 'active',
    ...overrides,
  };
}

function packageOrder(packageId, key = 'package-order-0001') {
  return {
    tenantId: 'tenant-a',
    userId: 'user-1',
    clientOrderKey: key,
    packageId,
    now: NOW,
  };
}

function customOrder(key = 'custom-order-0001') {
  return {
    tenantId: 'tenant-a',
    userId: 'user-1',
    clientOrderKey: key,
    amountYuan: '20.00',
    now: NOW,
  };
}

test('新套餐基础积分由售价派生并保存每日赠送积分', () => {
  const db = setup();

  const row = recharge.createPackage(db, packageInput());

  assert.equal(row.credits, 10000);
  assert.equal(row.daily_bonus_credits, 1000);
  assert.equal(row.benefit_version, 'daily_30d_v1');
});

test('会员有效期内拒绝当前档和其他档但允许自定义充值', () => {
  const db = setup();
  const first = recharge.createPackage(db, packageInput({ name: '会员档1' }));
  const second = recharge.createPackage(db, packageInput({ name: '会员档2', amountYuan: '200.00' }));
  dailyBonus.createMembership(db, {
    tenantId: 'tenant-a', orderId: 'paid-order-1', packageId: first.id,
    packageName: first.name, dailyBonusCredits: 1000, now: NOW,
  });

  assert.throws(
    () => recharge.createOrder(db, packageOrder(first.id, 'package-order-1001')),
    (error) => error?.code === 'RECHARGE_MEMBERSHIP_ACTIVE',
  );
  assert.throws(
    () => recharge.createOrder(db, packageOrder(second.id, 'package-order-1002')),
    (error) => error?.code === 'RECHARGE_MEMBERSHIP_ACTIVE',
  );
  assert.equal(recharge.createOrder(db, customOrder()).order_kind, 'custom');
});

test('已有待支付套餐订单时复用同档订单并拒绝切换其他档', () => {
  const db = setup();
  const firstPackage = recharge.createPackage(db, packageInput({ name: '会员档1' }));
  const secondPackage = recharge.createPackage(db, packageInput({ name: '会员档2', amountYuan: '200.00' }));

  const first = recharge.createOrder(db, packageOrder(firstPackage.id));
  const repeated = recharge.createOrder(db, packageOrder(firstPackage.id, 'package-order-0002'));

  assert.equal(repeated.id, first.id);
  assert.throws(
    () => recharge.createOrder(db, packageOrder(secondPackage.id, 'package-order-0003')),
    (error) => error?.code === 'RECHARGE_PACKAGE_ORDER_PENDING',
  );
});

test('支付套餐原子到账基础积分并建立30天权益和首日赠送', () => {
  const db = setup();
  const selected = recharge.createPackage(db, packageInput());
  const order = recharge.createOrder(db, packageOrder(selected.id));

  const result = recharge.settleVerifiedTrade(db, {
    outTradeNo: order.out_trade_no,
    alipayTradeNo: 'ali-daily-1',
    amountCents: 10000,
    now: NOW,
  });

  assert.equal(result.credited, true);
  assert.deepEqual(credits.getTenantAccountBreakdown(db, 'tenant-a', NOW), {
    tenant_id: 'tenant-a',
    available: 11000,
    held: 0,
    spent: 0,
    permanent_available: 10000,
    daily_bonus_available: 1000,
    daily_bonus_expires_at: '2026-08-12T00:00:00+08:00',
    membership_ends_on: '2026-09-10',
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_recharge_memberships').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_daily_bonus_buckets').get().count, 1);

  const repeated = recharge.settleVerifiedTrade(db, {
    outTradeNo: order.out_trade_no,
    alipayTradeNo: 'ali-daily-1',
    amountCents: 10000,
    now: NOW,
  });
  assert.equal(repeated.credited, false);
  assert.equal(credits.getTenantAccountBreakdown(db, 'tenant-a', NOW).available, 11000);
});

test('部署前待支付旧订单仍把原credits一次性永久入账', () => {
  const db = setup();
  db.prepare(`INSERT INTO tenant_recharge_orders
    (id, tenant_id, created_by, client_order_key, out_trade_no, order_kind,
      package_id, package_name, amount_cents, credits, base_credits,
      daily_bonus_credits, benefit_days, benefit_version, status, created_at, updated_at)
    VALUES ('legacy-order', 'tenant-a', 'user-1', 'legacy-key-0001', 'MOLILEGACY1',
      'package', 'legacy-package', '旧会员档', 10000, 11000, 11000,
      0, 0, 'legacy_once', 'pending', ?, ?)`)
    .run(NOW, NOW);

  recharge.settleVerifiedTrade(db, {
    outTradeNo: 'MOLILEGACY1',
    alipayTradeNo: 'ali-legacy-1',
    amountCents: 10000,
    now: NOW,
  });

  assert.equal(credits.getTenantAccountBreakdown(db, 'tenant-a', NOW).permanent_available, 11000);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_recharge_memberships').get().count, 0);
});
