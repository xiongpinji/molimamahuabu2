const { randomUUID } = require('crypto');
const tenants = require('./tenantService');

function billingError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
      monthly_credits INTEGER NOT NULL DEFAULT 0 CHECK (monthly_credits >= 0),
      currency TEXT NOT NULL DEFAULT 'CNY',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tenant_subscriptions (
      tenant_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'canceled')),
      source_order_id TEXT,
      starts_at TEXT NOT NULL,
      current_period_end TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tenant_billing_orders (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      client_order_key TEXT NOT NULL,
      plan_name TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
      monthly_credits INTEGER NOT NULL CHECK (monthly_credits >= 0),
      currency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'canceled', 'refunded')),
      external_reference TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      paid_at TEXT,
      UNIQUE (tenant_id, client_order_key)
    );
  `);
}

function normalizePlan(planIdValue, input = {}) {
  const id = String(planIdValue || '').trim().toLowerCase();
  const name = String(input.name || '').trim();
  const description = String(input.description || '').trim();
  const priceCents = Number(input.price_cents);
  const monthlyCredits = Number(input.monthly_credits);
  const currency = String(input.currency || 'CNY').trim().toUpperCase();
  const status = String(input.status || 'active');
  if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(id)
    || !name
    || !Number.isSafeInteger(priceCents) || priceCents < 0
    || !Number.isSafeInteger(monthlyCredits) || monthlyCredits < 0
    || !/^[A-Z]{3}$/.test(currency)
    || !['active', 'archived'].includes(status)) {
    throw billingError('INVALID_BILLING_PLAN', '套餐配置不合法');
  }
  return {
    id,
    name,
    description: description || null,
    price_cents: priceCents,
    monthly_credits: monthlyCredits,
    currency,
    status,
  };
}

function upsertPlan(db, planId, input) {
  ensureSchema(db);
  const plan = normalizePlan(planId, input);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO billing_plans
    (id, name, description, price_cents, monthly_credits, currency, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      price_cents = excluded.price_cents,
      monthly_credits = excluded.monthly_credits,
      currency = excluded.currency,
      status = excluded.status,
      updated_at = excluded.updated_at`)
    .run(plan.id, plan.name, plan.description, plan.price_cents, plan.monthly_credits,
      plan.currency, plan.status, now, now);
  return db.prepare('SELECT * FROM billing_plans WHERE id = ?').get(plan.id);
}

function listPlans(db, { includeArchived = false } = {}) {
  ensureSchema(db);
  const where = includeArchived ? '' : " WHERE status = 'active'";
  return db.prepare(`SELECT * FROM billing_plans${where} ORDER BY price_cents ASC, id ASC`).all();
}

function getCurrentSubscription(db, tenantId) {
  ensureSchema(db);
  return db.prepare(`SELECT s.*, p.name AS plan_name, p.description AS plan_description,
      p.price_cents, p.monthly_credits, p.currency
    FROM tenant_subscriptions s
    JOIN billing_plans p ON p.id = s.plan_id
    WHERE s.tenant_id = ?`).get(String(tenantId)) || null;
}

function normalizeClientOrderKey(value) {
  const key = String(value || '').trim();
  if (key.length < 8 || key.length > 100) {
    throw billingError('INVALID_ORDER', '订单幂等键长度需为 8 到 100 位');
  }
  return key;
}

function createOrder(db, input) {
  ensureSchema(db);
  const tenantId = String(input.tenantId || '');
  const userId = String(input.userId || '');
  tenants.requireManager(db, tenantId, userId);
  const clientOrderKey = normalizeClientOrderKey(input.clientOrderKey);
  const existing = db.prepare(`SELECT * FROM tenant_billing_orders
    WHERE tenant_id = ? AND client_order_key = ?`).get(tenantId, clientOrderKey);
  if (existing) return existing;
  const plan = db.prepare("SELECT * FROM billing_plans WHERE id = ? AND status = 'active'")
    .get(String(input.planId || '').trim().toLowerCase());
  if (!plan) throw billingError('PLAN_NOT_FOUND', '套餐不存在');
  const now = new Date().toISOString();
  const id = randomUUID();
  try {
    db.prepare(`INSERT INTO tenant_billing_orders
      (id, tenant_id, plan_id, created_by, client_order_key, plan_name,
        amount_cents, monthly_credits, currency, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(id, tenantId, plan.id, userId, clientOrderKey, plan.name,
        plan.price_cents, plan.monthly_credits, plan.currency, now, now);
  } catch (error) {
    if (String(error.code || '').includes('CONSTRAINT_UNIQUE')) {
      return db.prepare(`SELECT * FROM tenant_billing_orders
        WHERE tenant_id = ? AND client_order_key = ?`).get(tenantId, clientOrderKey);
    }
    throw error;
  }
  return db.prepare('SELECT * FROM tenant_billing_orders WHERE id = ?').get(id);
}

function listOrders(db, tenantIdValue, userId) {
  ensureSchema(db);
  const tenantId = String(tenantIdValue);
  tenants.requireManager(db, tenantId, userId);
  return db.prepare(`SELECT * FROM tenant_billing_orders
    WHERE tenant_id = ? ORDER BY created_at DESC`).all(tenantId);
}

function cancelOrder(db, tenantIdValue, userId, orderIdValue) {
  ensureSchema(db);
  const tenantId = String(tenantIdValue);
  tenants.requireManager(db, tenantId, userId);
  const orderId = String(orderIdValue);
  const order = db.prepare(`SELECT * FROM tenant_billing_orders
    WHERE id = ? AND tenant_id = ?`).get(orderId, tenantId);
  if (!order) throw billingError('ORDER_NOT_FOUND', '订单不存在');
  if (order.status !== 'pending') throw billingError('ORDER_NOT_CANCELABLE', '只有待支付订单可以取消');
  const now = new Date().toISOString();
  db.prepare(`UPDATE tenant_billing_orders SET status = 'canceled', updated_at = ?
    WHERE id = ? AND tenant_id = ? AND status = 'pending'`).run(now, orderId, tenantId);
  return db.prepare('SELECT * FROM tenant_billing_orders WHERE id = ?').get(orderId);
}

module.exports = {
  ensureSchema,
  upsertPlan,
  listPlans,
  getCurrentSubscription,
  createOrder,
  listOrders,
  cancelOrder,
};
