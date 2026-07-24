const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const credits = require('../src/services/creditLedgerService');
const redeemCodes = require('../src/services/redeemCodeService');

function setup() {
  const db = new Database(':memory:');
  credits.ensureSchema(db);
  redeemCodes.ensureSchema(db);
  credits.setTenantAccountBalance(db, 'tenant-a', 10);
  credits.setTenantAccountBalance(db, 'tenant-b', 0);
  return db;
}

test('创建兑换码只返回一次明文且数据库不保存明文', () => {
  const db = setup();
  const created = redeemCodes.createCode(db, {
    label: '内测赠送',
    credits: 100,
    maxRedemptions: 2,
  });
  assert.match(created.code, /^MOLI-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redeem_codes WHERE code_hash = ?').get(created.code).count, 0);
  const stored = db.prepare('SELECT code_hash, code_hint FROM redeem_codes WHERE id = ?').get(created.id);
  assert.notEqual(stored.code_hash, created.code);
  assert.equal(stored.code_hint.includes(created.code.slice(-4)), true);
  assert.equal('code' in redeemCodes.listCodes(db)[0], false);
});

test('兑换码向当前租户入账且同租户重复兑换不重复加积分', () => {
  const db = setup();
  const created = redeemCodes.createCode(db, { credits: 30, maxRedemptions: 2 });
  const first = redeemCodes.redeem(db, {
    code: created.code,
    tenantId: 'tenant-a',
    userId: 'user-1',
  });
  assert.equal(first.credits, 30);
  assert.equal(credits.getTenantAccount(db, 'tenant-a').available, 40);
  assert.throws(
    () => redeemCodes.redeem(db, {
      code: created.code,
      tenantId: 'tenant-a',
      userId: 'user-1',
    }),
    (error) => error.code === 'CODE_ALREADY_REDEEMED',
  );
  assert.equal(credits.getTenantAccount(db, 'tenant-a').available, 40);

  redeemCodes.redeem(db, { code: created.code, tenantId: 'tenant-b', userId: 'user-2' });
  assert.equal(credits.getTenantAccount(db, 'tenant-b').available, 30);
});

test('停用、过期或次数耗尽的兑换码拒绝入账', () => {
  const db = setup();
  const disabled = redeemCodes.createCode(db, { credits: 10, maxRedemptions: 1 });
  redeemCodes.updateCode(db, disabled.id, { status: 'disabled' });
  assert.throws(
    () => redeemCodes.redeem(db, { code: disabled.code, tenantId: 'tenant-a', userId: 'user-1' }),
    (error) => error.code === 'CODE_DISABLED',
  );

  const expired = redeemCodes.createCode(db, {
    credits: 10,
    maxRedemptions: 1,
    expiresAt: '2020-01-01T00:00:00.000Z',
  });
  assert.throws(
    () => redeemCodes.redeem(db, { code: expired.code, tenantId: 'tenant-a', userId: 'user-1' }),
    (error) => error.code === 'CODE_EXPIRED',
  );

  const exhausted = redeemCodes.createCode(db, { credits: 10, maxRedemptions: 1 });
  redeemCodes.redeem(db, { code: exhausted.code, tenantId: 'tenant-a', userId: 'user-1' });
  assert.throws(
    () => redeemCodes.redeem(db, { code: exhausted.code, tenantId: 'tenant-b', userId: 'user-2' }),
    (error) => error.code === 'CODE_EXHAUSTED',
  );
});

test('无效到期时间作为业务错误拒绝而不是抛出日期异常', () => {
  const db = setup();
  assert.throws(
    () => redeemCodes.createCode(db, {
      credits: 10,
      expiresAt: '不是日期',
    }),
    (error) => error.code === 'INVALID_REDEEM_CODE',
  );
});
