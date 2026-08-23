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
      ('user-2', 'member@example.com', 'hash', 'salt', 'active'),
      ('user-3', 'target@example.com', 'hash', 'salt', 'active')`).run();
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

test('owner 可通过角色接口晋升成员', () => {
  const db = setup();
  const tenant = tenantService.createTenant(db, 'user-1', {
    name: '制作团队',
    slug: 'studio-team',
  });
  tenantService.addMemberByEmail(db, tenant.id, 'user-1', {
    email: 'member@example.com',
    role: 'member',
  });
  const handlers = tenantRoutes(db, log);
  const changed = capture();

  handlers.changeMemberRole({
    user: { id: 'user-1' },
    params: { tenantId: tenant.id, userId: 'user-2' },
    body: { role: 'admin' },
  }, changed.res);

  assert.equal(changed.result.status, 200);
  assert.equal(changed.result.body.data.role, 'admin');
});

test('角色接口缺少 role 时拒绝修改', () => {
  const db = setup();
  const tenant = tenantService.createTenant(db, 'user-1', {
    name: '制作团队',
    slug: 'studio-team',
  });
  tenantService.addMemberByEmail(db, tenant.id, 'user-1', {
    email: 'member@example.com',
    role: 'admin',
  });
  const handlers = tenantRoutes(db, log);
  const changed = capture();

  handlers.changeMemberRole({
    user: { id: 'user-1' },
    params: { tenantId: tenant.id, userId: 'user-2' },
    body: {},
  }, changed.res);

  assert.equal(changed.result.status, 400);
  assert.equal(changed.result.body.error.code, 'BAD_REQUEST');
  assert.equal(
    db.prepare(`SELECT role FROM tenant_members
      WHERE tenant_id = ? AND user_id = ?`).get(tenant.id, 'user-2').role,
    'admin',
  );
});

test('tenant admin 不能授予管理员角色或降级 owner', () => {
  const db = setup();
  const tenant = tenantService.createTenant(db, 'user-1', {
    name: '制作团队',
    slug: 'studio-team',
  });
  tenantService.addMemberByEmail(db, tenant.id, 'user-1', {
    email: 'member@example.com',
    role: 'admin',
  });
  const handlers = tenantRoutes(db, log);

  const grantAdmin = capture();
  handlers.addMember({
    user: { id: 'user-2' },
    params: { tenantId: tenant.id },
    body: { email: 'target@example.com', role: 'admin' },
  }, grantAdmin.res);
  assert.equal(grantAdmin.result.status, 403);
  assert.equal(grantAdmin.result.body.error.code, 'TENANT_ROLE_FORBIDDEN');

  const demoteOwner = capture();
  handlers.addMember({
    user: { id: 'user-2' },
    params: { tenantId: tenant.id },
    body: { email: 'owner@example.com', role: 'member' },
  }, demoteOwner.res);
  assert.equal(demoteOwner.result.status, 403);
  assert.equal(demoteOwner.result.body.error.code, 'TENANT_ROLE_FORBIDDEN');
});
