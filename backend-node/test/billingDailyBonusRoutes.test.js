const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const billingRoutes = require('../src/routes/billing');
const credits = require('../src/services/creditLedgerService');
const dailyBonus = require('../src/services/dailyRechargeBonusService');

test('租户账户接口保留总余额并返回永久和今日赠送明细', () => {
  const db = new Database(':memory:');
  credits.ensureSchema(db);
  credits.setTenantAccountBalance(db, 'tenant-a', 100);
  const now = '2026-08-11T03:00:00.000Z';
  dailyBonus.createMembership(db, {
    tenantId: 'tenant-a', orderId: 'order-1', packageId: 'vip-1',
    packageName: '会员档', dailyBonusCredits: 30, now,
  });
  const handlers = billingRoutes(db, { error() {} }, { nowValue: now });
  const result = {};
  const res = {
    status(code) { result.status = code; return this; },
    json(body) { result.body = body; return this; },
  };

  handlers.getAccount({ user: { id: 'user-1' }, tenant: { id: 'tenant-a' } }, res);

  assert.deepEqual(result.body.data, {
    tenant_id: 'tenant-a', available: 130, held: 0, spent: 0,
    permanent_available: 100,
    daily_bonus_available: 30,
    daily_bonus_expires_at: '2026-08-12T00:00:00+08:00',
    membership_ends_on: '2026-09-10',
  });
});

