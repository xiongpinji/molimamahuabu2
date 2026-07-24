const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const credits = require('../src/services/creditLedgerService');
const redeemCodes = require('../src/services/redeem-code-service');

function setup() {
  const db = new Database(':memory:');
  credits.ensureSchema(db);
  redeemCodes.ensureSchema(db);
  credits.setTenantAccountBalance(db, 'tenant-a', 10);
  credits.setTenantAccountBalance(db, 'tenant-b', 0);
  return db;
}

test('兼容旧表时补齐可选租户绑定列', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE redeem_codes (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    code_hint TEXT NOT NULL,
    label TEXT,
    credits INTEGER NOT NULL,
    max_redemptions INTEGER NOT NULL,
    redeemed_count INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  redeemCodes.ensureSchema(db);
  const columns = db.prepare('PRAGMA table_info(redeem_codes)').all().map((item) => item.name);
  assert.equal(columns.includes('tenant_id'), true);
});

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

test('平台通用码兼容且租户绑定码不向其他租户泄漏或入账', () => {
  const db = setup();
  const globalCode = redeemCodes.createCode(db, {
    credits: 10,
    maxRedemptions: 2,
  });
  redeemCodes.redeem(db, {
    code: globalCode.code,
    tenantId: 'tenant-b',
    userId: 'user-2',
  });
  assert.equal(credits.getTenantAccount(db, 'tenant-b').available, 10);

  const boundCode = redeemCodes.createCode(db, {
    tenantId: 'tenant-a',
    credits: 25,
  });
  assert.equal(boundCode.tenant_id, 'tenant-a');
  assert.throws(
    () => redeemCodes.redeem(db, {
      code: boundCode.code,
      tenantId: 'tenant-b',
      userId: 'user-2',
    }),
    (error) => error.code === 'REDEEM_CODE_NOT_FOUND',
  );
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM redeem_code_usages
    WHERE code_id = ?`).get(boundCode.id).count, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM tenant_credit_adjustments
    WHERE reference_type = 'redeem_code' AND reference_id = ?`).get(boundCode.id).count, 0);
  assert.equal(credits.getTenantAccount(db, 'tenant-b').available, 10);

  redeemCodes.redeem(db, {
    code: boundCode.code,
    tenantId: 'tenant-a',
    userId: 'user-1',
  });
  assert.equal(credits.getTenantAccount(db, 'tenant-a').available, 35);
  const listed = redeemCodes.listCodes(db).find((item) => item.id === boundCode.id);
  assert.equal(listed.tenant_id, 'tenant-a');
  assert.equal('code' in listed, false);
  assert.equal('code_hash' in listed, false);
});

test('同租户竞态兑换只成功一次且只产生一条账本', async () => {
  const db = setup();
  const created = redeemCodes.createCode(db, { credits: 40, maxRedemptions: 2 });
  const attempts = await Promise.allSettled([1, 2].map(() => new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        resolve(redeemCodes.redeem(db, {
          code: created.code,
          tenantId: 'tenant-a',
          userId: 'user-1',
        }));
      } catch (error) {
        reject(error);
      }
    });
  })));

  assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
  const rejected = attempts.find((item) => item.status === 'rejected');
  assert.equal(rejected.reason.code, 'CODE_ALREADY_REDEEMED');
  assert.equal(credits.getTenantAccount(db, 'tenant-a').available, 50);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redeem_code_usages').get().count, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM tenant_credit_adjustments
    WHERE tenant_id = 'tenant-a' AND reference_type = 'redeem_code'`).get().count, 1);
  assert.equal(db.prepare('SELECT redeemed_count FROM redeem_codes WHERE id = ?').get(created.id).redeemed_count, 1);
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

test('批量创建原子生成唯一兑换码且后续查询不泄露明文或哈希', () => {
  const db = setup();
  const created = redeemCodes.createCodes(db, {
    quantity: 3,
    tenantId: 'tenant-a',
    label: '批量活动',
    credits: 88,
    maxRedemptions: 1,
    expiresAt: '2026-08-01T00:00:00.000Z',
  });

  assert.equal(created.quantity, 3);
  assert.equal(created.items.length, 3);
  assert.equal(new Set(created.items.map((item) => item.code)).size, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redeem_codes').get().count, 3);
  assert.equal(created.items.every((item) => item.code.startsWith('MOLI-')), true);
  assert.equal(created.items.every((item) => item.tenant_id === 'tenant-a'), true);

  const listed = redeemCodes.listCodes(db);
  assert.equal(listed.every((item) => !('code' in item) && !('code_hash' in item)), true);
  const persisted = JSON.stringify(db.prepare('SELECT * FROM redeem_codes').all());
  for (const item of created.items) assert.equal(persisted.includes(item.code), false);
});

test('批量数量越界时整批拒绝且不留下部分记录', () => {
  const db = setup();
  for (const quantity of [0, 501, 1.5]) {
    assert.throws(
      () => redeemCodes.createCodes(db, { quantity, credits: 10 }),
      (error) => error.code === 'INVALID_REDEEM_CODE',
    );
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redeem_codes').get().count, 0);
});

test('管理员可更新或清空有效期并查询兑换人与对应账本', () => {
  const db = setup();
  const created = redeemCodes.createCode(db, {
    label: '账本查询',
    credits: 25,
    expiresAt: '2026-08-01T00:00:00.000Z',
  });
  const updated = redeemCodes.updateCode(db, created.id, {
    expiresAt: '2026-09-01T00:00:00.000Z',
  });
  assert.equal(updated.expires_at, '2026-09-01T00:00:00.000Z');

  redeemCodes.redeem(db, {
    code: created.code,
    tenantId: 'tenant-a',
    userId: 'user-1',
  });
  const usages = redeemCodes.listUsages(db, created.id);
  assert.equal(usages.length, 1);
  assert.equal(usages[0].tenant_id, 'tenant-a');
  assert.equal(usages[0].user_id, 'user-1');
  assert.equal(usages[0].credits, 25);
  assert.equal(usages[0].ledger_amount, 25);
  assert.equal(usages[0].ledger_reference_id, created.id);
  assert.ok(usages[0].ledger_id);
  assert.ok(usages[0].redeemed_at);
  assert.ok(usages[0].ledger_created_at);
  assert.equal('code' in usages[0], false);
  assert.equal('code_hash' in usages[0], false);

  const permanent = redeemCodes.updateCode(db, created.id, { expiresAt: null });
  assert.equal(permanent.expires_at, null);
});

test('不存在的兑换码明细返回业务级不存在错误', () => {
  const db = setup();
  assert.throws(
    () => redeemCodes.listUsages(db, 'missing-code'),
    (error) => error.code === 'REDEEM_CODE_NOT_FOUND',
  );
});
