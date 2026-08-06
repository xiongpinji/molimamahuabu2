const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const rechargeRoutes = require('../src/routes/alipay-recharge');
const recharge = require('../src/services/alipay-recharge-service');
const tenantService = require('../src/services/tenantService');
const userAuth = require('../src/services/userAuthService');
const creditLedger = require('../src/services/creditLedgerService');

const log = { error() {} };

function capture() {
  const result = {};
  return {
    result,
    res: {
      status(code) { result.status = code; return this; },
      type(value) { result.type = value; return this; },
      json(body) { result.body = body; return this; },
      send(body) { result.body = body; return this; },
    },
  };
}

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
    name: '充值测试工作区',
    slug: 'recharge-test',
  });
  creditLedger.setTenantAccountBalance(db, tenant.id, 0);
  const gateway = {
    configured: true,
    appId: 'app-123',
    sellerId: '2088000000000000',
    createPaymentUrl(order) { return `https://pay.example.com/${order.out_trade_no}`; },
    verifyNotification(payload) { return payload.sign === 'valid'; },
  };
  return { db, tenant, gateway };
}

test('用户通过同一支付宝入口创建自定义或套餐订单并只能查看本人记录', () => {
  const { db, tenant, gateway } = setup();
  const handlers = rechargeRoutes(db, log, gateway);
  const savedPackage = capture();
  handlers.createAdminPackage({
    body: {
      name: '限时加赠包',
      ad_title: '限时套餐广告',
      amount_yuan: '10',
      credits: 1500,
      image_url: 'https://cdn.example.com/promo.jpg',
      status: 'active',
    },
  }, savedPackage.res);
  assert.equal(savedPackage.result.status, 201);

  const created = capture();
  handlers.createOrder({
    user: { id: 'user-1' },
    tenant,
    body: { package_id: savedPackage.result.body.data.id, client_order_key: 'package-checkout-1' },
  }, created.res);
  assert.equal(created.result.status, 201);
  assert.equal(created.result.body.data.order.credits, 1500);
  assert.match(created.result.body.data.payment_url, /^https:\/\/pay\.example\.com\//);

  const listed = capture();
  handlers.listOrders({ user: { id: 'user-1' }, tenant }, listed.res);
  assert.equal(listed.result.body.data.length, 1);
  assert.equal(listed.result.body.data[0].id, created.result.body.data.order.id);
});

test('支付宝异步通知返回纯文本 success 且无效通知返回 failure', () => {
  const { db, tenant, gateway } = setup();
  const handlers = rechargeRoutes(db, log, gateway);
  const order = recharge.createOrder(db, {
    tenantId: tenant.id,
    userId: 'user-1',
    amountYuan: '10',
    clientOrderKey: 'notify-route-order',
  });
  const payload = {
    sign: 'valid',
    app_id: gateway.appId,
    seller_id: gateway.sellerId,
    trade_status: 'TRADE_SUCCESS',
    out_trade_no: order.out_trade_no,
    trade_no: '2026080322000000000003',
    total_amount: '10.00',
  };

  const accepted = capture();
  handlers.notify({ body: payload }, accepted.res);
  assert.equal(accepted.result.status, 200);
  assert.equal(accepted.result.type, 'text/plain');
  assert.equal(accepted.result.body, 'success');

  const rejected = capture();
  handlers.notify({ body: { ...payload, out_trade_no: 'UNKNOWN' } }, rejected.res);
  assert.equal(rejected.result.status, 400);
  assert.equal(rejected.result.body, 'failure');
});

test('未配置支付宝时公开配置可读但创建订单返回 503', () => {
  const { db, tenant } = setup();
  const handlers = rechargeRoutes(db, log, { configured: false });
  const config = capture();
  handlers.getConfig({}, config.res);
  assert.deepEqual(config.result.body.data, {
    channel: 'alipay',
    configured: false,
    fixed_ratio_credits_per_yuan: 100,
    min_amount_yuan: '1.00',
    max_amount_yuan: '50000.00',
  });

  const created = capture();
  handlers.createOrder({
    user: { id: 'user-1' },
    tenant,
    body: { amount_yuan: '10', client_order_key: 'unconfigured-order' },
  }, created.res);
  assert.equal(created.result.status, 503);
  assert.equal(created.result.body.error.code, 'ALIPAY_NOT_CONFIGURED');
});

test('管理员套餐排序接口返回最终顺序并将非法请求映射为 400', () => {
  const { db, gateway } = setup();
  const handlers = rechargeRoutes(db, log, gateway);
  const first = recharge.createPackage(db, {
    name: '套餐一',
    amount_yuan: '10.00',
    credits: 1000,
    image_url: 'https://cdn.example.com/package-one.webp',
    badge_text: '推荐',
    ad_title: '套餐一广告',
    ad_subtitle: '购买后积分立即到账',
    button_text: '立即购买',
    accent_color: '#ff7139',
    sort_order: 0,
    is_featured: 0,
    status: 'active',
  });
  const second = recharge.createPackage(db, {
    name: '套餐二',
    amount_yuan: '20.00',
    credits: 2200,
    image_url: 'https://cdn.example.com/package-two.webp',
    badge_text: '加赠',
    ad_title: '套餐二广告',
    ad_subtitle: '购买后享受额外积分',
    button_text: '立即购买',
    accent_color: '#ffaa33',
    sort_order: 1,
    is_featured: 1,
    status: 'active',
  });

  const reordered = capture();
  handlers.reorderAdminPackages({
    body: { package_ids: [` ${second.id} `, first.id] },
  }, reordered.res);
  assert.deepEqual(reordered.result.body.data.map((item) => item.id), [second.id, first.id]);

  const invalid = capture();
  handlers.reorderAdminPackages({ body: { package_ids: [first.id] } }, invalid.res);
  assert.equal(invalid.result.status, 400);
  assert.equal(invalid.result.body.error.code, 'INVALID_RECHARGE_PACKAGE_ORDER');
});

test('充值路由保持通知公开、管理员套餐受保护和用户订单租户隔离的挂载顺序', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/index.js'), 'utf8');
  const notifyIndex = source.indexOf("r.post('/billing/recharge/alipay/notify'");
  const authIndex = source.indexOf('r.use(requireUser)');
  const tenantIndex = source.indexOf('r.use(createTenantContextMiddleware');
  const userOrderIndex = source.indexOf("r.post('/billing/recharge/alipay/orders'");
  const reorderIndex = source.indexOf("r.put('/billing/admin/recharge-packages/order'");
  const updateIndex = source.indexOf("r.put('/billing/admin/recharge-packages/:packageId'");
  assert.ok(notifyIndex >= 0 && notifyIndex < authIndex);
  assert.ok(userOrderIndex > tenantIndex);
  assert.ok(reorderIndex >= 0 && reorderIndex < updateIndex && reorderIndex < tenantIndex);
  for (const route of [
    "r.get('/billing/admin/recharge-packages'",
    "r.post('/billing/admin/recharge-packages'",
    "r.put('/billing/admin/recharge-packages/order'",
    "r.put('/billing/admin/recharge-packages/:packageId'",
  ]) {
    const line = source.split(/\r?\n/).find((item) => item.includes(route));
    assert.match(line || '', /requireAdmin, requireBillingManager/);
  }
});
