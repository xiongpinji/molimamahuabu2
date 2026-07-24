const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const tenantService = require('../src/services/tenantService');
const userAuth = require('../src/services/userAuthService');

function setup() {
  const db = new Database(':memory:');
  userAuth.ensureSchema(db);
  tenantService.ensureSchema(db);
  db.prepare(`INSERT INTO platform_users
    (id, email, password_hash, password_salt, status)
    VALUES
      ('owner-1', 'owner1@example.com', 'hash', 'salt', 'active'),
      ('admin-1', 'admin1@example.com', 'hash', 'salt', 'active'),
      ('admin-2', 'admin2@example.com', 'hash', 'salt', 'active'),
      ('member-1', 'member1@example.com', 'hash', 'salt', 'active')`).run();
  const tenant = tenantService.createTenant(db, 'owner-1', {
    name: '安全边界测试租户',
    slug: 'security-boundary',
  });
  tenantService.addMemberByEmail(db, tenant.id, 'owner-1', {
    email: 'admin1@example.com',
    role: 'admin',
  });
  tenantService.addMemberByEmail(db, tenant.id, 'owner-1', {
    email: 'admin2@example.com',
    role: 'admin',
  });
  tenantService.addMemberByEmail(db, tenant.id, 'owner-1', {
    email: 'member1@example.com',
    role: 'member',
  });
  return { db, tenant };
}

test('admin 不能移除另一个 admin', () => {
  const { db, tenant } = setup();

  assert.throws(
    () => tenantService.removeMember(db, tenant.id, 'admin-1', 'admin-2'),
    (error) => error.code === 'TENANT_NOT_FOUND',
  );
  assert.deepEqual(
    db.prepare(`SELECT role, status FROM tenant_members
      WHERE tenant_id = ? AND user_id = ?`).get(tenant.id, 'admin-2'),
    { role: 'admin', status: 'active' },
  );
});

test('admin 可以移除 member', () => {
  const { db, tenant } = setup();

  assert.equal(
    tenantService.removeMember(db, tenant.id, 'admin-1', 'member-1'),
    true,
  );
  assert.equal(
    db.prepare(`SELECT 1 FROM tenant_members
      WHERE tenant_id = ? AND user_id = ?`).get(tenant.id, 'member-1'),
    undefined,
  );
});

test('admin 不能移除 owner', () => {
  const { db, tenant } = setup();

  assert.throws(
    () => tenantService.removeMember(db, tenant.id, 'admin-1', 'owner-1'),
    (error) => error.code === 'TENANT_NOT_FOUND',
  );
  assert.deepEqual(
    db.prepare(`SELECT role, status FROM tenant_members
      WHERE tenant_id = ? AND user_id = ?`).get(tenant.id, 'owner-1'),
    { role: 'owner', status: 'active' },
  );
});

test('owner 不能移除最后一个活跃 owner', () => {
  const { db, tenant } = setup();

  assert.throws(
    () => tenantService.removeMember(db, tenant.id, 'owner-1', 'owner-1'),
    (error) => error.code === 'LAST_TENANT_OWNER',
  );
  assert.deepEqual(
    db.prepare(`SELECT role, status FROM tenant_members
      WHERE tenant_id = ? AND user_id = ?`).get(tenant.id, 'owner-1'),
    { role: 'owner', status: 'active' },
  );
});

test('owner 可以移除 admin', () => {
  const { db, tenant } = setup();

  assert.equal(
    tenantService.removeMember(db, tenant.id, 'owner-1', 'admin-1'),
    true,
  );
  assert.equal(
    db.prepare(`SELECT 1 FROM tenant_members
      WHERE tenant_id = ? AND user_id = ?`).get(tenant.id, 'admin-1'),
    undefined,
  );
});
