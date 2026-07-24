const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const tenantRoutes = require('../src/routes/tenants');
const tenantService = require('../src/services/tenantService');
const userAuth = require('../src/services/userAuthService');

const log = { error() {} };

function capture() {
  const result = {};
  return {
    result,
    res: {
      status(code) { result.status = code; return this; },
      json(body) { result.body = body; return this; },
    },
  };
}

function setup() {
  const db = new Database(':memory:');
  userAuth.ensureSchema(db);
  tenantService.ensureSchema(db);
  db.prepare(`INSERT INTO platform_users
    (id, email, password_hash, password_salt, status)
    VALUES ('user-1', 'owner@example.com', 'hash', 'salt', 'active'),
      ('user-2', 'member@example.com', 'hash', 'salt', 'active')`).run();
  return db;
}

test('创建租户后建立 owner 成员关系和独立零余额账户', () => {
  const db = setup();
  const handlers = tenantRoutes(db, log);
  const { res, result } = capture();
  handlers.create({
    user: { id: 'user-1' },
    body: { name: '制作团队', slug: 'studio-team' },
  }, res);

  assert.equal(result.status, 201);
  const tenantId = result.body.data.id;
  assert.deepEqual(
    db.prepare('SELECT role, status FROM tenant_members WHERE tenant_id = ? AND user_id = ?')
      .get(tenantId, 'user-1'),
    { role: 'owner', status: 'active' },
  );
  assert.deepEqual(
    db.prepare('SELECT available, held, spent FROM tenant_credit_accounts WHERE tenant_id = ?').get(tenantId),
    { available: 0, held: 0, spent: 0 },
  );
});

test('owner 可添加成员，非管理员无法读取成员列表', () => {
  const db = setup();
  const tenant = tenantService.createTenant(db, 'user-1', {
    name: '制作团队',
    slug: 'studio-team',
  });
  const handlers = tenantRoutes(db, log);
  const added = capture();
  handlers.addMember({
    user: { id: 'user-1' },
    params: { tenantId: tenant.id },
    body: { email: 'member@example.com', role: 'member' },
  }, added.res);
  assert.equal(added.result.status, 201);
  assert.equal(added.result.body.data.user_id, 'user-2');

  const denied = capture();
  handlers.listMembers({
    user: { id: 'user-2' },
    params: { tenantId: tenant.id },
  }, denied.res);
  assert.equal(denied.result.status, 404);
  assert.equal(denied.result.body.error.code, 'NOT_FOUND');
});
