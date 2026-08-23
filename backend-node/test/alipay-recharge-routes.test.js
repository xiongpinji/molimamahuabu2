const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');

const rechargeRoutes = require('../src/routes/alipay-recharge');
const { setupRouter } = require('../src/routes');
const recharge = require('../src/services/alipay-recharge-service');
const tenantService = require('../src/services/tenantService');
const userAuth = require('../src/services/userAuthService');
const creditLedger = require('../src/services/creditLedgerService');

const log = { error() {} };
const SECRET = 'recharge-route-jwt-secret-value-123456';
const ADMIN_TOKEN = 'recharge-route-admin-token-value-123456';

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
    createPaymentUrl(order) {
      return `https://openapi.alipay.com/gateway.do?out_trade_no=${encodeURIComponent(order.out_trade_no)}`;
    },
    verifyNotification(payload) { return payload.sign === 'valid'; },
  };
  return { db, tenant, gateway };
}

function insertPlatformUser(db, { id, email, platformRole = 'user' }) {
  db.prepare(`INSERT INTO platform_users
    (id, email, password_hash, password_salt, role, platform_role, status)
    VALUES (?, ?, 'hash', 'salt', ?, ?, 'active')`)
    .run(id, email, platformRole === 'admin' ? 'admin' : 'user', platformRole);
}

function tokenFor(user) {
  return userAuth.issueToken({ id: user.id, email: user.email, role: user.platformRole }, SECRET);
}

async function setupAdminHttpServer() {
  const db = new Database(':memory:');
  userAuth.ensureSchema(db);
  tenantService.ensureSchema(db);
  creditLedger.ensureSchema(db);
  recharge.ensureSchema(db);
  insertPlatformUser(db, {
    id: 'plain-user',
    email: 'plain@example.com',
    platformRole: 'user',
  });
  insertPlatformUser(db, {
    id: 'billing-admin',
    email: 'billing-admin@example.com',
    platformRole: 'admin',
  });
  const seededPackage = recharge.createPackage(db, {
    name: '权限矩阵套餐',
    amount_yuan: '10.00',
    daily_bonus_credits: 0,
    image_url: 'https://cdn.example.com/permission.webp',
    ad_title: '权限矩阵广告',
    status: 'active',
  });
  const previousEnv = {
    PUBLIC_PLATFORM_MODE: process.env.PUBLIC_PLATFORM_MODE,
    PLATFORM_JWT_SECRET: process.env.PLATFORM_JWT_SECRET,
    PLATFORM_ADMIN_TOKEN: process.env.PLATFORM_ADMIN_TOKEN,
  };
  process.env.PUBLIC_PLATFORM_MODE = 'true';
  process.env.PLATFORM_JWT_SECRET = SECRET;
  process.env.PLATFORM_ADMIN_TOKEN = ADMIN_TOKEN;

  const app = express();
  app.use(express.json());
  app.use('/api/v1', setupRouter({}, db, log));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
  return {
    db,
    server,
    baseUrl,
    seededPackage,
    plainToken: tokenFor({ id: 'plain-user', email: 'plain@example.com', platformRole: 'user' }),
    adminToken: tokenFor({ id: 'billing-admin', email: 'billing-admin@example.com', platformRole: 'admin' }),
    async close() {
      await new Promise((resolve) => server.close(resolve));
      db.close();
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

async function jsonRequest(baseUrl, endpoint, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

function adminPackagePayload(overrides = {}) {
  return {
    name: 'HTTP 权限新增套餐',
    amount_yuan: '20.00',
    daily_bonus_credits: 200,
    image_url: 'https://cdn.example.com/http-permission.webp',
    ad_title: 'HTTP 权限广告',
    status: 'active',
    ...overrides,
  };
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
      daily_bonus_credits: 500,
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
  assert.equal(created.result.body.data.order.credits, 1000);
  assert.equal(created.result.body.data.order.daily_bonus_credits, 500);
  assert.match(created.result.body.data.payment_url, /^https:\/\/openapi\.alipay\.com\/gateway\.do\?/);

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
    daily_bonus_credits: 0,
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
    daily_bonus_credits: 200,
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
  const imageUploadIndex = source.indexOf("r.post('/billing/admin/recharge-packages/image'");
  const reorderIndex = source.indexOf("r.put('/billing/admin/recharge-packages/order'");
  const updateIndex = source.indexOf("r.put('/billing/admin/recharge-packages/:packageId'");
  const uploadHandlersDeclaration = 'const uploadHandlers = uploadModule.routes(cfg, log, db, { publicPlatformEnabled });';
  const uploadHandlersIndex = source.indexOf(uploadHandlersDeclaration);
  assert.ok(notifyIndex >= 0 && notifyIndex < authIndex);
  assert.ok(userOrderIndex > tenantIndex);
  assert.ok(uploadHandlersIndex >= 0 && uploadHandlersIndex < imageUploadIndex);
  assert.equal(source.split(uploadHandlersDeclaration).length - 1, 1);
  assert.ok(imageUploadIndex >= 0 && imageUploadIndex < tenantIndex);
  assert.ok(reorderIndex >= 0 && reorderIndex < updateIndex && reorderIndex < tenantIndex);
  for (const route of [
    "r.get('/billing/admin/recharge-packages'",
    "r.post('/billing/admin/recharge-packages'",
    "r.post('/billing/admin/recharge-packages/image'",
    "r.put('/billing/admin/recharge-packages/order'",
    "r.put('/billing/admin/recharge-packages/:packageId'",
  ]) {
    const line = source.split(/\r?\n/).find((item) => item.includes(route));
    assert.match(line || '', /requireAdmin, requireBillingManager/);
  }
  const imageUploadLine = source.split(/\r?\n/)
    .find((item) => item.includes("r.post('/billing/admin/recharge-packages/image'"));
  assert.match(
    imageUploadLine || '',
    /requireAdmin, requireBillingManager, uploadHandlers\.multerRechargePackageImageSingle, uploadHandlers\.uploadRechargePackageImage/,
  );
});

test('管理员套餐 list/create/update/reorder 真实 HTTP 路由要求计费管理员权限', async () => {
  const ctx = await setupAdminHttpServer();
  try {
    const endpoints = [
      {
        name: 'list',
        method: 'GET',
        path: '/billing/admin/recharge-packages',
        successStatus: 200,
        assertSuccess(body) {
          assert.equal(body.success, true);
          assert.deepEqual(body.data.map((item) => item.id), [ctx.seededPackage.id]);
        },
      },
      {
        name: 'create',
        method: 'POST',
        path: '/billing/admin/recharge-packages',
        body: adminPackagePayload({ name: 'HTTP 权限新增套餐' }),
        successStatus: 201,
        assertSuccess(body) {
          assert.equal(body.success, true);
          assert.equal(body.data.name, 'HTTP 权限新增套餐');
          assert.equal(body.data.credits, 2000);
          assert.equal(body.data.daily_bonus_credits, 200);
        },
      },
      {
        name: 'update',
        method: 'PUT',
        path: `/billing/admin/recharge-packages/${ctx.seededPackage.id}`,
        body: adminPackagePayload({
          name: 'HTTP 权限更新套餐',
          image_url: 'https://cdn.example.com/http-permission-updated.webp',
        }),
        successStatus: 200,
        assertSuccess(body) {
          assert.equal(body.success, true);
          assert.equal(body.data.id, ctx.seededPackage.id);
          assert.equal(body.data.name, 'HTTP 权限更新套餐');
        },
      },
      {
        name: 'reorder',
        method: 'PUT',
        path: '/billing/admin/recharge-packages/order',
        body: { package_ids: [ctx.seededPackage.id] },
        successStatus: 200,
        assertSuccess(body) {
          assert.equal(body.success, true);
          assert.deepEqual(body.data.map((item) => item.id), this.body.package_ids);
        },
      },
    ];

    for (const endpoint of endpoints) {
      if (endpoint.name === 'reorder') {
        endpoint.body = {
          package_ids: ctx.db.prepare('SELECT id FROM recharge_packages ORDER BY sort_order ASC, created_at ASC')
            .all()
            .map((item) => item.id),
        };
      }
      const countBefore = ctx.db.prepare('SELECT COUNT(*) AS count FROM recharge_packages').get().count;
      const anonymous = await jsonRequest(ctx.baseUrl, endpoint.path, {
        method: endpoint.method,
        body: endpoint.body,
      });
      assert.equal(anonymous.status, 401, `${endpoint.name} should reject anonymous users`);
      assert.equal(anonymous.body.error.code, 'UNAUTHORIZED');
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM recharge_packages').get().count, countBefore);

      const plainUser = await jsonRequest(ctx.baseUrl, endpoint.path, {
        method: endpoint.method,
        token: ctx.plainToken,
        body: endpoint.body,
      });
      assert.equal(plainUser.status, 403, `${endpoint.name} should reject non-admin users`);
      assert.equal(plainUser.body.error.code, 'ADMIN_ROLE_REQUIRED');
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM recharge_packages').get().count, countBefore);

      const admin = await jsonRequest(ctx.baseUrl, endpoint.path, {
        method: endpoint.method,
        token: ctx.adminToken,
        body: endpoint.body,
      });
      assert.equal(admin.status, endpoint.successStatus, `${endpoint.name} should allow billing admins`);
      endpoint.assertSuccess(admin.body);
    }
  } finally {
    await ctx.close();
  }
});
