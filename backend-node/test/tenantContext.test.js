const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const tenantService = require('../src/services/tenantService');
const { createTenantContextMiddleware } = require('../src/middleware/tenantContext');

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  db.prepare('INSERT INTO platform_users (id, email, password_hash, password_salt) VALUES (?, ?, ?, ?)')
    .run('user-1', 'one@example.com', 'hash', 'salt');
  db.prepare('INSERT INTO platform_users (id, email, password_hash, password_salt) VALUES (?, ?, ?, ?)')
    .run('user-2', 'two@example.com', 'hash', 'salt');
  return db;
}

function invoke(middleware, { userId, tenantId }) {
  const result = { next: false };
  const req = {
    user: { id: userId },
    get(name) { return name.toLowerCase() === 'x-tenant-id' ? tenantId : ''; },
  };
  const res = {
    status(code) { result.status = code; return this; },
    json(body) { result.body = body; return this; },
  };
  middleware(req, res, () => { result.next = true; });
  return { req, result };
}

test('个人租户可重复初始化且用户是 owner', () => {
  const db = setup();
  const first = tenantService.ensurePersonalTenant(db, { id: 'user-1', email: 'one@example.com' });
  const second = tenantService.ensurePersonalTenant(db, { id: 'user-1', email: 'one@example.com' });
  assert.equal(first.id, second.id);
  assert.equal(first.id, 'personal:user-1');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenants').get().count, 1);
  assert.deepEqual(
    db.prepare('SELECT role, status FROM tenant_members WHERE tenant_id = ? AND user_id = ?').get(first.id, 'user-1'),
    { role: 'owner', status: 'active' },
  );
});

test('未指定租户时默认个人租户，指定时只允许活跃成员', () => {
  const db = setup();
  const personal = tenantService.ensurePersonalTenant(db, { id: 'user-1', email: 'one@example.com' });
  const foreign = tenantService.ensurePersonalTenant(db, { id: 'user-2', email: 'two@example.com' });
  const middleware = createTenantContextMiddleware({ db, enabled: true });

  const defaultResult = invoke(middleware, { userId: 'user-1' });
  assert.equal(defaultResult.result.next, true);
  assert.equal(defaultResult.req.tenant.id, personal.id);
  assert.equal(defaultResult.req.tenant.role, 'owner');

  const denied = invoke(middleware, { userId: 'user-1', tenantId: foreign.id });
  assert.equal(denied.result.next, false);
  assert.equal(denied.result.status, 404);
  assert.equal(denied.result.body.error.code, 'NOT_FOUND');
});

test('租户成员可以显式选择共享租户', () => {
  const db = setup();
  tenantService.ensurePersonalTenant(db, { id: 'user-1', email: 'one@example.com' });
  const shared = tenantService.createTenant(db, 'user-1', { name: '共享制作组', slug: 'shared-studio' });
  tenantService.addMemberByEmail(db, shared.id, 'user-1', {
    email: 'two@example.com',
    role: 'member',
  });

  const selected = invoke(createTenantContextMiddleware({ db, enabled: true }), {
    userId: 'user-2',
    tenantId: shared.id,
  });
  assert.equal(selected.result.next, true);
  assert.equal(selected.req.tenant.id, shared.id);
  assert.equal(selected.req.tenant.role, 'member');
});
