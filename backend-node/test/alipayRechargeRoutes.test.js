const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const createRoutes = require('../src/routes/alipay-recharge');
const recharge = require('../src/services/alipay-recharge-service');
const dailyBonus = require('../src/services/dailyRechargeBonusService');

const log = { error() {} };

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

function setup() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE tenant_members (
    tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
    PRIMARY KEY (tenant_id, user_id)
  )`);
  db.prepare(`INSERT INTO tenant_members VALUES ('tenant-a', 'user-1', 'active')`).run();
  recharge.ensureSchema(db);
  const selected = recharge.createPackage(db, {
    name: '每日会员', amountYuan: '100.00', dailyBonusCredits: 1000,
    imageUrl: 'https://molimama.vip/static/package.png', badgeText: '推荐',
    adTitle: '每日会员权益', adSubtitle: '连续30天', buttonText: '立即购买',
    accentColor: '#ff7139', sortOrder: 0, isFeatured: false, status: 'active',
  });
  const gateway = {
    configured: true,
    createPaymentUrl(order) { return `https://pay.example/${order.id}`; },
  };
  return { db, selected, handlers: createRoutes(db, log, gateway) };
}

test('有效会员购买任意套餐返回409且自定义充值仍创建订单', () => {
  const { db, selected, handlers } = setup();
  dailyBonus.createMembership(db, {
    tenantId: 'tenant-a', orderId: 'paid-order', packageId: selected.id,
    packageName: selected.name, dailyBonusCredits: 1000,
  });
  const request = { tenant: { id: 'tenant-a' }, user: { id: 'user-1' } };
  const blocked = capture();
  handlers.createOrder({
    ...request,
    body: { package_id: selected.id, client_order_key: 'package-route-0001' },
  }, blocked.res);
  assert.equal(blocked.result.status, 409);
  assert.equal(blocked.result.body.error.code, 'RECHARGE_MEMBERSHIP_ACTIVE');

  const custom = capture();
  handlers.createOrder({
    ...request,
    body: { amount_yuan: '20.00', client_order_key: 'custom-route-0001' },
  }, custom.res);
  assert.equal(custom.result.status, 201);
  assert.equal(custom.result.body.data.order.order_kind, 'custom');
});

test('套餐列表响应携带当前会员状态', () => {
  const { db, selected, handlers } = setup();
  const membership = dailyBonus.createMembership(db, {
    tenantId: 'tenant-a', orderId: 'paid-order', packageId: selected.id,
    packageName: selected.name, dailyBonusCredits: 1000,
  });
  const output = capture();

  handlers.listPackages({ tenant: { id: 'tenant-a' } }, output.res);

  assert.equal(output.result.body.data.membership.active, true);
  assert.equal(output.result.body.data.membership.ends_on, membership.ends_on);
  assert.ok(Array.isArray(output.result.body.data.packages));
});

