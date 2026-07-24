const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const credits = require('../src/services/creditLedgerService');

function setup() {
  const db = new Database(':memory:');
  credits.ensureSchema(db);
  credits.setTenantAccountBalance(db, 'tenant-a', 100);
  credits.setTenantAccountBalance(db, 'tenant-b', 60);
  return db;
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
