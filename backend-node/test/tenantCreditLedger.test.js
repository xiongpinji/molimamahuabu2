const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const credits = require('../src/services/creditLedgerService');
const dailyBonus = require('../src/services/dailyRechargeBonusService');

const DAY_ONE = '2026-08-11T02:00:00.000Z';
const DAY_TWO = '2026-08-12T02:00:00.000Z';

function setup() {
  const db = new Database(':memory:');
  credits.ensureSchema(db);
  credits.setTenantAccountBalance(db, 'tenant-a', 100);
  credits.setTenantAccountBalance(db, 'tenant-b', 60);
  return db;
}

function setupDailyTenant(input = {}) {
  const db = new Database(':memory:');
  credits.ensureSchema(db);
  credits.setTenantAccountBalance(db, 'tenant-a', input.permanent ?? 100);
  dailyBonus.createMembership(db, {
    tenantId: 'tenant-a',
    orderId: 'order-daily-1',
    packageId: 'vip-daily',
    packageName: '每日会员',
    dailyBonusCredits: input.daily ?? 30,
    now: input.now || DAY_ONE,
  });
  return db;
}

function reserveMixed(db, amount = 50, now = DAY_ONE) {
  return credits.reserve(db, {
    tenantId: 'tenant-a',
    actorUserId: 'user-1',
    operationKey: `video:mixed:${now}`,
    model: 'seedance-2',
    resourceType: 'video',
    resourceId: 'v1',
    amount,
    now,
  });
}

test('相同操作键在不同租户内独立预占', () => {
  const db = setup();
  const common = {
    actorUserId: 'user-1',
    operationKey: 'generate:shot-1',
    model: 'gpt-image-2',
    resourceType: 'image',
    resourceId: 'shot-1',
    amount: 20,
  };
  const a = credits.reserve(db, { ...common, tenantId: 'tenant-a' });
  const b = credits.reserve(db, { ...common, tenantId: 'tenant-b' });

  assert.notEqual(a.id, b.id);
  assert.deepEqual(credits.getTenantAccount(db, 'tenant-a'), {
    tenant_id: 'tenant-a', available: 80, held: 20, spent: 0,
  });
  assert.deepEqual(credits.getTenantAccount(db, 'tenant-b'), {
    tenant_id: 'tenant-b', available: 40, held: 20, spent: 0,
  });
});

test('确认和退款只改变预占所属租户', () => {
  const db = setup();
  const a = credits.reserve(db, {
    tenantId: 'tenant-a',
    actorUserId: 'user-1',
    operationKey: 'video:a',
    model: 'seedance 2.0',
    resourceType: 'video',
    resourceId: '1',
    amount: 35,
  });
  const b = credits.reserve(db, {
    tenantId: 'tenant-b',
    actorUserId: 'user-1',
    operationKey: 'video:b',
    model: 'seedance 2.0',
    resourceType: 'video',
    resourceId: '2',
    amount: 35,
  });

  credits.confirm(db, a.id);
  credits.refund(db, b.id, 'provider_failed');

  assert.deepEqual(credits.getTenantAccount(db, 'tenant-a'), {
    tenant_id: 'tenant-a', available: 65, held: 0, spent: 35,
  });
  assert.deepEqual(credits.getTenantAccount(db, 'tenant-b'), {
    tenant_id: 'tenant-b', available: 60, held: 0, spent: 0,
  });
});

test('用户积分记录同时返回兑换记录和已确认的模型消耗', () => {
  const db = setup();
  credits.adjustTenantBalance(db, {
    tenantId: 'tenant-a',
    actorUserId: 'user-1',
    eventType: 'redeem',
    amount: 20,
    reason: '兑换码 MOLI-TEST',
    referenceType: 'redeem_code',
    referenceId: 'code-1',
  });
  const reservation = credits.reserve(db, {
    tenantId: 'tenant-a',
    actorUserId: 'user-1',
    operationKey: 'video:history',
    model: 'lingjing-video-v1',
    resourceType: 'video',
    resourceId: 'shot-9',
    amount: 35,
  });
  credits.confirm(db, reservation.id);

  const rows = credits.listTenantAdjustments(db, 'tenant-a');
  const redemption = rows.find((row) => row.event_type === 'redeem');
  const consumption = rows.find((row) => row.event_type === 'confirm');

  assert.equal(redemption.amount, 20);
  assert.equal(consumption.amount, -35);
  assert.equal(consumption.model, 'lingjing-video-v1');
  assert.equal(consumption.resource_type, 'video');
  assert.equal(consumption.resource_id, 'shot-9');
});

test('租户预扣优先使用今日赠送再使用永久积分', () => {
  const db = setupDailyTenant({ permanent: 100, daily: 30, now: DAY_ONE });

  const reservation = reserveMixed(db, 50, DAY_ONE);
  const allocation = db.prepare(`SELECT bonus_amount, permanent_amount
    FROM tenant_usage_reservation_allocations WHERE reservation_id = ?`).get(reservation.id);

  assert.deepEqual(allocation, { bonus_amount: 30, permanent_amount: 20 });
  assert.equal(credits.getTenantAccount(db, 'tenant-a', DAY_ONE).available, 80);
  assert.equal(credits.getTenantAccountBreakdown(db, 'tenant-a', DAY_ONE).permanent_available, 80);
});

test('同日失败把赠送积分退回原日积分桶', () => {
  const db = setupDailyTenant({ permanent: 100, daily: 30, now: DAY_ONE });
  const reservation = reserveMixed(db, 50, DAY_ONE);

  credits.refund(db, reservation.id, 'provider_failed', DAY_ONE);

  const account = credits.getTenantAccountBreakdown(db, 'tenant-a', DAY_ONE);
  assert.equal(account.permanent_available, 100);
  assert.equal(account.daily_bonus_available, 30);
  assert.equal(account.held, 0);
});

test('跨日失败只退永久积分且过期赠送不复活', () => {
  const db = setupDailyTenant({ permanent: 100, daily: 30, now: DAY_ONE });
  const reservation = reserveMixed(db, 50, DAY_ONE);

  credits.refund(db, reservation.id, 'provider_failed', DAY_TWO);

  const account = credits.getTenantAccountBreakdown(db, 'tenant-a', DAY_TWO);
  assert.equal(account.permanent_available, 100);
  assert.equal(account.daily_bonus_available, 30);
  const oldBucket = db.prepare(`SELECT available, held, expired
    FROM tenant_daily_bonus_buckets WHERE benefit_date = '2026-08-11'`).get();
  assert.deepEqual(oldBucket, { available: 0, held: 0, expired: 30 });
});

test('跨日成功确认仍消费原日已冻结赠送', () => {
  const db = setupDailyTenant({ permanent: 100, daily: 30, now: DAY_ONE });
  const reservation = reserveMixed(db, 50, DAY_ONE);

  credits.confirm(db, reservation.id, DAY_TWO);

  assert.equal(credits.getTenantAccount(db, 'tenant-a', DAY_TWO).spent, 50);
  assert.equal(db.prepare(`SELECT spent FROM tenant_daily_bonus_buckets
    WHERE benefit_date = '2026-08-11'`).get().spent, 30);
});

test('混合余额不足时不落预扣、分配或账本', () => {
  const db = setupDailyTenant({ permanent: 10, daily: 30, now: DAY_ONE });

  assert.throws(
    () => reserveMixed(db, 50, DAY_ONE),
    (error) => error?.code === 'INSUFFICIENT_CREDITS',
  );
  assert.deepEqual(credits.getTenantAccountBreakdown(db, 'tenant-a', DAY_ONE), {
    tenant_id: 'tenant-a',
    available: 40,
    held: 0,
    spent: 0,
    permanent_available: 10,
    daily_bonus_available: 30,
    daily_bonus_expires_at: '2026-08-12T00:00:00+08:00',
    membership_ends_on: '2026-09-10',
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservation_allocations').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_credit_ledger').get().count, 0);
});
