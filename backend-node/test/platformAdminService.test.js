const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const admin = require('../src/services/platformAdminService');
const credits = require('../src/services/creditLedgerService');
const tenants = require('../src/services/tenantService');
const users = require('../src/services/userAuthService');

function setup() {
  const db = new Database(':memory:');
  users.ensureSchema(db);
  tenants.ensureSchema(db);
  credits.ensureSchema(db);
  db.prepare(`INSERT INTO platform_users
    (id, email, password_hash, password_salt, role, status)
    VALUES ('user-1', 'one@example.com', 'hash', 'salt', 'user', 'active'),
      ('user-2', 'two@example.com', 'hash', 'salt', 'user', 'active')`).run();
  const tenant = tenants.createTenant(db, 'user-1', { name: '一号团队', slug: 'team-one' });
  credits.setTenantAccountBalance(db, tenant.id, 50);
  return { db, tenant };
}

test('管理员可查看账号并启停账号', () => {
  const { db } = setup();
  assert.equal(admin.listUsers(db).length, 2);
  const updated = admin.updateUser(db, 'user-1', { status: 'disabled', role: 'admin' });
  assert.equal(updated.status, 'disabled');
  assert.equal(updated.role, 'admin');
  assert.equal(db.prepare('SELECT status FROM platform_users WHERE id = ?').get('user-1').status, 'disabled');
});

test('管理员正负调账写入流水且负调账不能透支', () => {
  const { db, tenant } = setup();
  admin.adjustTenantCredits(db, tenant.id, {
    amount: 25,
    reason: '活动赠送',
  });
  assert.equal(credits.getTenantAccount(db, tenant.id).available, 75);

  admin.adjustTenantCredits(db, tenant.id, {
    amount: -20,
    reason: '纠错扣回',
  });
  assert.equal(credits.getTenantAccount(db, tenant.id).available, 55);
  assert.deepEqual(
    admin.listCreditTransactions(db, { tenantId: tenant.id }).map((row) => row.amount),
    [-20, 25],
  );
  assert.throws(
    () => admin.adjustTenantCredits(db, tenant.id, { amount: -56, reason: '错误操作' }),
    (error) => error.code === 'INSUFFICIENT_CREDITS',
  );
  assert.equal(credits.getTenantAccount(db, tenant.id).available, 55);
});

test('管理员租户列表包含余额和成员数量', () => {
  const { db, tenant } = setup();
  const row = admin.listTenants(db).find((item) => item.id === tenant.id);
  assert.equal(row.available, 50);
  assert.equal(row.member_count, 1);
});
