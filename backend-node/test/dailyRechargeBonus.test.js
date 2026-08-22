const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const bonus = require('../src/services/dailyRechargeBonusService');

const NOW = '2026-08-11T02:00:00.000Z';

function setupLegacyRechargeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE recharge_packages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      credits INTEGER NOT NULL,
      starts_at TEXT,
      ends_at TEXT,
      image_url TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE tenant_recharge_orders (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      client_order_key TEXT NOT NULL,
      out_trade_no TEXT NOT NULL UNIQUE,
      order_kind TEXT NOT NULL,
      package_id TEXT,
      package_name TEXT,
      amount_cents INTEGER NOT NULL,
      credits INTEGER NOT NULL,
      status TEXT NOT NULL,
      alipay_trade_no TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      paid_at TEXT
    );
  `);
  return db;
}

function runDailyBonusMigration(db) {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '55_daily_recharge_bonus.sql'),
    'utf8',
  );
  for (const statement of sql.split(';').map((value) => value.trim()).filter(Boolean)) {
    db.exec(`${statement};`);
  }
}

function setupDailyBonusDb() {
  const db = new Database(':memory:');
  bonus.ensureSchema(db);
  return db;
}

function setupActiveMembership(input = {}) {
  const db = setupDailyBonusDb();
  bonus.createMembership(db, {
    tenantId: 'tenant-a',
    orderId: 'order-1',
    packageId: 'vip-1',
    packageName: '会员档',
    dailyBonusCredits: input.dailyBonusCredits ?? 1000,
    now: input.startsAt || NOW,
  });
  return db;
}

test('旧套餐把一次性额外赠送迁移为每日赠送且基础积分固定为售价换算', () => {
  const db = setupLegacyRechargeDb();
  db.prepare(`INSERT INTO recharge_packages
    (id, name, amount_cents, credits, image_url, status, created_at, updated_at)
    VALUES ('vip-1', '会员档', 10000, 11000, '/static/uploads/recharge-packages/a.png', 'active', ?, ?)`)
    .run(NOW, NOW);
  db.prepare(`INSERT INTO tenant_recharge_orders
    (id, tenant_id, created_by, client_order_key, out_trade_no, order_kind,
      package_id, package_name, amount_cents, credits, status, created_at, updated_at)
    VALUES ('order-1', 'tenant-a', 'user-1', 'legacy-order-1', 'MOLILEGACY1', 'package',
      'vip-1', '会员档', 10000, 11000, 'pending', ?, ?)`)
    .run(NOW, NOW);

  runDailyBonusMigration(db);

  assert.deepEqual(
    db.prepare(`SELECT credits, daily_bonus_credits, benefit_version
      FROM recharge_packages WHERE id = 'vip-1'`).get(),
    { credits: 10000, daily_bonus_credits: 1000, benefit_version: 'daily_30d_v1' },
  );
  assert.deepEqual(
    db.prepare(`SELECT credits, base_credits, daily_bonus_credits, benefit_days, benefit_version
      FROM tenant_recharge_orders WHERE id = 'order-1'`).get(),
    {
      credits: 11000,
      base_credits: 11000,
      daily_bonus_credits: 0,
      benefit_days: 0,
      benefit_version: 'legacy_once',
    },
  );
});

test('支付日算第1天并覆盖连续30个上海自然日', () => {
  assert.deepEqual(bonus.shanghaiBenefitWindow('2026-08-11T15:59:00.000Z'), {
    startsOn: '2026-08-11',
    endsOn: '2026-09-10',
  });
  assert.equal(bonus.shanghaiBusinessDate('2026-08-11T16:00:00.000Z'), '2026-08-12');
});

test('同一会员同一天只创建一个赠送积分桶', () => {
  const db = setupDailyBonusDb();
  const membership = bonus.createMembership(db, {
    tenantId: 'tenant-a',
    orderId: 'order-1',
    packageId: 'vip-1',
    packageName: '会员档',
    dailyBonusCredits: 1000,
    now: NOW,
  });

  const first = bonus.materializeTodayBucket(db, 'tenant-a', '2026-08-11T03:00:00.000Z');
  const second = bonus.materializeTodayBucket(db, 'tenant-a', '2026-08-11T04:00:00.000Z');

  assert.equal(first.id, second.id);
  assert.equal(first.available, 1000);
  assert.equal(first.membership_id, membership.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_daily_bonus_buckets').get().count, 1);
});

test('昨日未使用赠送在次日读取时转为过期且不计入昨日余额', () => {
  const db = setupActiveMembership({ dailyBonusCredits: 1000 });
  bonus.materializeTodayBucket(db, 'tenant-a', '2026-08-11T03:00:00.000Z');

  const state = bonus.getDailyBonusState(db, 'tenant-a', '2026-08-12T03:00:00.000Z');

  assert.equal(state.available, 1000);
  const yesterday = db.prepare(`SELECT available, expired FROM tenant_daily_bonus_buckets
    WHERE benefit_date = '2026-08-11'`).get();
  assert.deepEqual(yesterday, { available: 0, expired: 1000 });
});

test('第31个自然日不再创建赠送积分桶', () => {
  const db = setupActiveMembership({ startsAt: NOW });

  assert.equal(bonus.materializeTodayBucket(db, 'tenant-a', '2026-09-10T00:00:00.000Z'), null);
  assert.equal(bonus.getActiveMembership(db, 'tenant-a', '2026-09-10T00:00:00.000Z'), null);
  assert.equal(
    db.prepare("SELECT status FROM tenant_recharge_memberships WHERE tenant_id = 'tenant-a'").get().status,
    'expired',
  );
});

test('有效会员存在时拒绝创建另一份会员权益', () => {
  const db = setupActiveMembership();

  assert.throws(
    () => bonus.createMembership(db, {
      tenantId: 'tenant-a',
      orderId: 'order-2',
      packageId: 'vip-2',
      packageName: '会员档2',
      dailyBonusCredits: 2000,
      now: '2026-08-12T02:00:00.000Z',
    }),
    (error) => error?.code === 'RECHARGE_MEMBERSHIP_ACTIVE',
  );
});
