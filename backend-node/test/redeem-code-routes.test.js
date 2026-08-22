const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const billingRoutes = require('../src/routes/billing');
const credits = require('../src/services/creditLedgerService');
const redeemCodes = require('../src/services/redeem-code-service');

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

test('兑换只使用认证后的租户和用户上下文并忽略请求体伪造身份', () => {
  const db = new Database(':memory:');
  credits.ensureSchema(db);
  credits.setTenantAccountBalance(db, 'tenant-a', 0);
  credits.setTenantAccountBalance(db, 'tenant-b', 0);
  const created = redeemCodes.createCode(db, { credits: 30 });
  const handlers = billingRoutes(db, log);
  const { res, result } = capture();

  handlers.redeemCredits({
    body: {
      code: created.code,
      tenant_id: 'tenant-b',
      user_id: 'forged-user',
    },
    tenant: { id: 'tenant-a' },
    user: { id: 'user-1' },
  }, res);

  assert.equal(result.body.data.tenant_id, 'tenant-a');
  assert.equal(result.body.data.user_id, 'user-1');
  assert.equal(credits.getTenantAccount(db, 'tenant-a').available, 30);
  assert.equal(credits.getTenantAccount(db, 'tenant-b').available, 0);
});

test('管理路由批量创建并返回兑换明细账本', () => {
  const db = new Database(':memory:');
  credits.ensureSchema(db);
  credits.setTenantAccountBalance(db, 'tenant-a', 0);
  const handlers = billingRoutes(db, log);
  const batchCapture = capture();

  handlers.createAdminRedeemCodes({
    body: { quantity: 2, credits: 20, max_redemptions: 1 },
    user: { id: 'admin-1' },
  }, batchCapture.res);
  assert.equal(batchCapture.result.status, 201);
  assert.equal(batchCapture.result.body.data.items.length, 2);
  assert.equal(batchCapture.result.body.data.items[0].created_by, 'admin-1');

  redeemCodes.redeem(db, {
    code: batchCapture.result.body.data.items[0].code,
    tenantId: 'tenant-a',
    userId: 'user-1',
  });
  const usageCapture = capture();
  handlers.listAdminRedeemCodeUsages({
    params: { codeId: batchCapture.result.body.data.items[0].id },
  }, usageCapture.res);

  assert.equal(usageCapture.result.body.data.length, 1);
  assert.equal(usageCapture.result.body.data[0].user_id, 'user-1');
  assert.equal(usageCapture.result.body.data[0].ledger_amount, 20);
});

test('管理路由只记录当前管理员且拒绝绑定不存在的租户', () => {
  const db = new Database(':memory:');
  const handlers = billingRoutes(db, log);
  const validCapture = capture();

  db.exec(`CREATE TABLE tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.prepare(`INSERT INTO tenants
    (id, name, slug, status, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?, ?)`)
    .run('tenant-a', '租户 A', 'tenant-a', 'owner-1', '2026-07-24', '2026-07-24');

  handlers.createAdminRedeemCode({
    body: {
      credits: 10,
      tenant_id: 'tenant-a',
      createdBy: 'forged-admin',
    },
    user: { id: 'admin-1' },
  }, validCapture.res);
  assert.equal(validCapture.result.status, 201);
  assert.equal(validCapture.result.body.data.created_by, 'admin-1');
  assert.equal(validCapture.result.body.data.tenant_id, 'tenant-a');

  const invalidCapture = capture();
  handlers.createAdminRedeemCodes({
    body: {
      quantity: 2,
      credits: 10,
      tenant_id: 'missing-tenant',
    },
    user: { id: 'admin-1' },
  }, invalidCapture.res);
  assert.equal(invalidCapture.result.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redeem_codes').get().count, 1);
});

test('租户流水查询忽略跨租户查询参数', () => {
  const db = new Database(':memory:');
  credits.ensureSchema(db);
  credits.setTenantAccountBalance(db, 'tenant-a', 0);
  credits.setTenantAccountBalance(db, 'tenant-b', 0);
  const created = redeemCodes.createCode(db, { credits: 20 });
  redeemCodes.redeem(db, {
    code: created.code,
    tenantId: 'tenant-a',
    userId: 'user-1',
  });
  const handlers = billingRoutes(db, log);
  const { res, result } = capture();

  handlers.listCreditTransactions({
    tenant: { id: 'tenant-b' },
    query: { tenant_id: 'tenant-a' },
  }, res);

  assert.deepEqual(result.body.data, []);
});
