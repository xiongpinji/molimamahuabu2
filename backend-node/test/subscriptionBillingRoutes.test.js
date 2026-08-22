const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const billingRoutes = require('../src/routes/billing');
const subscriptions = require('../src/services/subscriptionBillingService');
const tenantService = require('../src/services/tenantService');
const userAuth = require('../src/services/userAuthService');

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
  userAuth.ensureSchema(db);
  tenantService.ensureSchema(db);
  subscriptions.ensureSchema(db);
  db.prepare(`INSERT INTO platform_users
    (id, email, password_hash, password_salt, status)
    VALUES ('owner-1', 'owner@example.com', 'hash', 'salt', 'active')`).run();
  const tenant = tenantService.createTenant(db, 'owner-1', { name: '制作团队', slug: 'studio-team' });
  subscriptions.upsertPlan(db, 'creator', {
    name: '创作版',
    price_cents: 9900,
    monthly_credits: 1000,
    currency: 'CNY',
    status: 'active',
  });
  return { db, tenant };
}

test('租户可读取有效套餐并创建自己的待支付订单', () => {
  const { db, tenant } = setup();
  const handlers = billingRoutes(db, log);
  const plans = capture();
  handlers.listPlans({}, plans.res);
  assert.equal(plans.result.body.data[0].id, 'creator');

  const created = capture();
  handlers.createOrder({
    user: { id: 'owner-1' },
    tenant,
    body: { plan_id: 'creator', client_order_key: 'checkout-1' },
  }, created.res);
  assert.equal(created.result.status, 201);
  assert.equal(created.result.body.data.tenant_id, tenant.id);
  assert.equal(created.result.body.data.status, 'pending');
});

test('同一订单幂等键改换套餐返回 409 而不是 500', () => {
  const { db, tenant } = setup();
  subscriptions.upsertPlan(db, 'studio', {
    name: '团队版',
    price_cents: 29900,
    monthly_credits: 5000,
    currency: 'CNY',
    status: 'active',
  });
  const handlers = billingRoutes(db, log);

  handlers.createOrder({
    user: { id: 'owner-1' },
    tenant,
    body: { plan_id: 'creator', client_order_key: 'checkout-conflict' },
  }, capture().res);
  const conflict = capture();
  handlers.createOrder({
    user: { id: 'owner-1' },
    tenant,
    body: { plan_id: 'studio', client_order_key: 'checkout-conflict' },
  }, conflict.res);

  assert.equal(conflict.result.status, 409);
  assert.equal(conflict.result.body.error.code, 'BILLING_ORDER_IDEMPOTENCY_CONFLICT');
});

test('平台管理员可新增或更新套餐配置', () => {
  const { db } = setup();
  const handlers = billingRoutes(db, log);
  const saved = capture();
  handlers.upsertPlan({
    params: { planId: 'studio' },
    body: {
      name: '团队版',
      price_cents: 29900,
      monthly_credits: 5000,
      currency: 'CNY',
      status: 'active',
    },
  }, saved.res);
  assert.equal(saved.result.body.data.id, 'studio');
  assert.equal(saved.result.body.data.monthly_credits, 5000);
});
