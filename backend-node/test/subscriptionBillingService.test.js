const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const tenantService = require('../src/services/tenantService');
const userAuth = require('../src/services/userAuthService');
const subscriptions = require('../src/services/subscriptionBillingService');
const creditLedger = require('../src/services/creditLedgerService');

function setup() {
  const db = new Database(':memory:');
  userAuth.ensureSchema(db);
  tenantService.ensureSchema(db);
  subscriptions.ensureSchema(db);
  creditLedger.ensureSchema(db);
  db.prepare(`INSERT INTO platform_users
    (id, email, password_hash, password_salt, status)
    VALUES ('owner-1', 'owner@example.com', 'hash', 'salt', 'active'),
      ('member-1', 'member@example.com', 'hash', 'salt', 'active'),
      ('owner-2', 'other@example.com', 'hash', 'salt', 'active')`).run();
  const tenant = tenantService.createTenant(db, 'owner-1', { name: '一号团队', slug: 'team-one' });
  const other = tenantService.createTenant(db, 'owner-2', { name: '二号团队', slug: 'team-two' });
  creditLedger.setTenantAccountBalance(db, tenant.id, 321);
  tenantService.addMemberByEmail(db, tenant.id, 'owner-1', {
    email: 'member@example.com',
    role: 'member',
  });
  subscriptions.upsertPlan(db, 'creator', {
    name: '创作版',
    description: '创作团队套餐',
    price_cents: 9900,
    monthly_credits: 1000,
    currency: 'CNY',
    status: 'active',
  });
  return { db, tenant, other };
}

test('套餐配置只接受合法金额、积分、币种和状态', () => {
  const db = new Database(':memory:');
  subscriptions.ensureSchema(db);
  assert.throws(() => subscriptions.upsertPlan(db, 'bad plan', {
    name: '错误套餐',
    price_cents: -1,
    monthly_credits: 1.5,
    currency: 'yuan',
  }), (error) => error.code === 'INVALID_BILLING_PLAN');
});

test('owner 创建待支付订单且相同幂等键不会重复下单', () => {
  const { db, tenant } = setup();
  const accountBefore = db.prepare(`SELECT available, held, spent
    FROM tenant_credit_accounts WHERE tenant_id = ?`).get(tenant.id);
  const first = subscriptions.createOrder(db, {
    tenantId: tenant.id,
    userId: 'owner-1',
    planId: 'creator',
    clientOrderKey: 'checkout-1',
  });
  const repeated = subscriptions.createOrder(db, {
    tenantId: tenant.id,
    userId: 'owner-1',
    planId: 'creator',
    clientOrderKey: 'checkout-1',
  });

  assert.equal(first.id, repeated.id);
  assert.equal(first.status, 'pending');
  assert.equal(first.amount_cents, 9900);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_billing_orders').get().count, 1);
  assert.equal(subscriptions.getCurrentSubscription(db, tenant.id), null);
  assert.deepEqual(
    db.prepare(`SELECT available, held, spent
      FROM tenant_credit_accounts WHERE tenant_id = ?`).get(tenant.id),
    accountBefore,
  );
});

test('普通成员不能创建订单且另一租户看不到订单', () => {
  const { db, tenant, other } = setup();
  assert.throws(() => subscriptions.createOrder(db, {
    tenantId: tenant.id,
    userId: 'member-1',
    planId: 'creator',
    clientOrderKey: 'member-checkout',
  }), (error) => error.code === 'TENANT_NOT_FOUND');

  subscriptions.createOrder(db, {
    tenantId: tenant.id,
    userId: 'owner-1',
    planId: 'creator',
    clientOrderKey: 'owner-checkout',
  });
  assert.deepEqual(subscriptions.listOrders(db, other.id, 'owner-2'), []);
});

test('只能取消本租户待支付订单', () => {
  const { db, tenant, other } = setup();
  const order = subscriptions.createOrder(db, {
    tenantId: tenant.id,
    userId: 'owner-1',
    planId: 'creator',
    clientOrderKey: 'cancel-checkout',
  });
  assert.throws(
    () => subscriptions.cancelOrder(db, other.id, 'owner-2', order.id),
    (error) => error.code === 'ORDER_NOT_FOUND',
  );
  assert.equal(subscriptions.cancelOrder(db, tenant.id, 'owner-1', order.id).status, 'canceled');
});
