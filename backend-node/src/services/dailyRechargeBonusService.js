const { randomUUID } = require('node:crypto');

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const BENEFIT_DAYS = 30;

function shanghaiBusinessDate(nowValue = Date.now()) {
  return new Date(new Date(nowValue).getTime() + SHANGHAI_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

function addCalendarDays(dateText, days) {
  const [year, month, day] = String(dateText).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + Number(days)))
    .toISOString()
    .slice(0, 10);
}

function shanghaiBenefitWindow(nowValue = Date.now()) {
  const startsOn = shanghaiBusinessDate(nowValue);
  return { startsOn, endsOn: addCalendarDays(startsOn, BENEFIT_DAYS) };
}

function tableExists(db, table) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

function ensureColumn(db, table, name, definition) {
  if (!tableExists(db, table)) return;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((column) => column.name === name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

function ensureSchema(db) {
  ensureColumn(db, 'recharge_packages', 'daily_bonus_credits', 'INTEGER NOT NULL DEFAULT 0 CHECK (daily_bonus_credits >= 0)');
  ensureColumn(db, 'recharge_packages', 'benefit_version', "TEXT NOT NULL DEFAULT 'legacy_once'");
  ensureColumn(db, 'tenant_recharge_orders', 'base_credits', 'INTEGER');
  ensureColumn(db, 'tenant_recharge_orders', 'daily_bonus_credits', 'INTEGER NOT NULL DEFAULT 0 CHECK (daily_bonus_credits >= 0)');
  ensureColumn(db, 'tenant_recharge_orders', 'benefit_days', 'INTEGER NOT NULL DEFAULT 0 CHECK (benefit_days >= 0)');
  ensureColumn(db, 'tenant_recharge_orders', 'benefit_version', "TEXT NOT NULL DEFAULT 'legacy_once'");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_recharge_memberships (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      recharge_order_id TEXT NOT NULL UNIQUE,
      package_id TEXT NOT NULL,
      package_name TEXT NOT NULL,
      daily_bonus_credits INTEGER NOT NULL CHECK (daily_bonus_credits >= 0),
      starts_on TEXT NOT NULL,
      ends_on TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'expired')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_active_recharge_membership
      ON tenant_recharge_memberships(tenant_id) WHERE status = 'active';
    CREATE TABLE IF NOT EXISTS tenant_daily_bonus_buckets (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      membership_id TEXT NOT NULL,
      benefit_date TEXT NOT NULL,
      granted INTEGER NOT NULL CHECK (granted >= 0),
      available INTEGER NOT NULL CHECK (available >= 0),
      held INTEGER NOT NULL CHECK (held >= 0),
      spent INTEGER NOT NULL CHECK (spent >= 0),
      expired INTEGER NOT NULL CHECK (expired >= 0),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (membership_id, benefit_date)
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_daily_bonus_buckets_tenant_date
      ON tenant_daily_bonus_buckets(tenant_id, benefit_date);
    CREATE TABLE IF NOT EXISTS tenant_usage_reservation_allocations (
      reservation_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      bonus_bucket_id TEXT,
      bonus_amount INTEGER NOT NULL CHECK (bonus_amount >= 0),
      permanent_amount INTEGER NOT NULL CHECK (permanent_amount >= 0),
      created_at TEXT NOT NULL,
      CHECK (bonus_amount + permanent_amount > 0)
    );
  `);
}

function nowIso(nowValue) {
  return new Date(nowValue ?? Date.now()).toISOString();
}

function expireMemberships(db, tenantId, businessDate, updatedAt) {
  db.prepare(`UPDATE tenant_recharge_memberships
    SET status = 'expired', updated_at = ?
    WHERE tenant_id = ? AND status = 'active' AND ends_on <= ?`)
    .run(updatedAt, String(tenantId), businessDate);
}

function getActiveMembership(db, tenantId, nowValue = Date.now()) {
  ensureSchema(db);
  const id = String(tenantId || '').trim();
  if (!id) return null;
  const businessDate = shanghaiBusinessDate(nowValue);
  expireMemberships(db, id, businessDate, nowIso(nowValue));
  return db.prepare(`SELECT * FROM tenant_recharge_memberships
    WHERE tenant_id = ? AND status = 'active'
      AND starts_on <= ? AND ends_on > ?
    ORDER BY created_at DESC LIMIT 1`).get(id, businessDate, businessDate) || null;
}

function createMembership(db, input) {
  ensureSchema(db);
  const tenantId = String(input?.tenantId || '').trim();
  const orderId = String(input?.orderId || '').trim();
  const packageId = String(input?.packageId || '').trim();
  const packageName = String(input?.packageName || '').trim();
  const dailyBonusCredits = Number(input?.dailyBonusCredits);
  if (!tenantId || !orderId || !packageId || !packageName) {
    throw new Error('会员权益参数不完整');
  }
  if (!Number.isSafeInteger(dailyBonusCredits) || dailyBonusCredits < 0) {
    throw new Error('每日赠送积分必须是非负整数');
  }
  const createdAt = nowIso(input?.now);
  const { startsOn, endsOn } = shanghaiBenefitWindow(input?.now);
  return db.transaction(() => {
    const existingOrder = db.prepare(`SELECT * FROM tenant_recharge_memberships
      WHERE recharge_order_id = ?`).get(orderId);
    if (existingOrder) return existingOrder;
    expireMemberships(db, tenantId, startsOn, createdAt);
    const active = db.prepare(`SELECT * FROM tenant_recharge_memberships
      WHERE tenant_id = ? AND status = 'active' LIMIT 1`).get(tenantId);
    if (active) {
      const error = new Error('当前会员权益尚未到期，不能重复购买会员档');
      error.code = 'RECHARGE_MEMBERSHIP_ACTIVE';
      throw error;
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO tenant_recharge_memberships
      (id, tenant_id, recharge_order_id, package_id, package_name,
        daily_bonus_credits, starts_on, ends_on, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
      .run(
        id, tenantId, orderId, packageId, packageName, dailyBonusCredits,
        startsOn, endsOn, createdAt, createdAt,
      );
    return db.prepare('SELECT * FROM tenant_recharge_memberships WHERE id = ?').get(id);
  }).immediate();
}

function expirePastBuckets(db, tenantId, businessDate, updatedAt = new Date().toISOString()) {
  ensureSchema(db);
  return db.prepare(`UPDATE tenant_daily_bonus_buckets
    SET expired = expired + available, available = 0, updated_at = ?
    WHERE tenant_id = ? AND benefit_date < ? AND available > 0`)
    .run(updatedAt, String(tenantId), businessDate);
}

function materializeTodayBucket(db, tenantId, nowValue = Date.now()) {
  ensureSchema(db);
  const id = String(tenantId || '').trim();
  if (!id) return null;
  const businessDate = shanghaiBusinessDate(nowValue);
  const updatedAt = nowIso(nowValue);
  return db.transaction(() => {
    expirePastBuckets(db, id, businessDate, updatedAt);
    const membership = getActiveMembership(db, id, nowValue);
    if (!membership) return null;
    const bucketId = randomUUID();
    const expiresAt = `${addCalendarDays(businessDate, 1)}T00:00:00+08:00`;
    db.prepare(`INSERT OR IGNORE INTO tenant_daily_bonus_buckets
      (id, tenant_id, membership_id, benefit_date, granted, available,
        held, spent, expired, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?)`)
      .run(
        bucketId, id, membership.id, businessDate,
        membership.daily_bonus_credits, membership.daily_bonus_credits,
        expiresAt, updatedAt, updatedAt,
      );
    return db.prepare(`SELECT * FROM tenant_daily_bonus_buckets
      WHERE membership_id = ? AND benefit_date = ?`).get(membership.id, businessDate);
  }).immediate();
}

function getDailyBonusState(db, tenantId, nowValue = Date.now()) {
  const bucket = materializeTodayBucket(db, tenantId, nowValue);
  const membership = getActiveMembership(db, tenantId, nowValue);
  return {
    available: bucket?.available || 0,
    held: bucket?.held || 0,
    spent: bucket?.spent || 0,
    expired: bucket?.expired || 0,
    bucketId: bucket?.id || null,
    expiresAt: bucket?.expires_at || null,
    membershipEndsOn: membership?.ends_on || null,
    membership,
  };
}

module.exports = {
  SHANGHAI_OFFSET_MS,
  BENEFIT_DAYS,
  shanghaiBusinessDate,
  addCalendarDays,
  shanghaiBenefitWindow,
  ensureSchema,
  getActiveMembership,
  createMembership,
  expirePastBuckets,
  materializeTodayBucket,
  getDailyBonusState,
};
