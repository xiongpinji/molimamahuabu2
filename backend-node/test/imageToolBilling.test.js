const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const billing = require('../src/services/imageToolBillingService');
const credits = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  prices.set(db, 'doubao-seedream-4-5-251128', 7, { category: 'image' });
  credits.setTenantAccountBalance(db, 'tenant-image-tools', 20);
  return db;
}

test('公开图片工具预扣、成功确认并记录租户审计事件', () => {
  const db = setup();
  try {
    const held = billing.begin(db, {
      enabled: true,
      tenantId: 'tenant-image-tools',
      userId: 'user-image-tools',
      model: 'doubao-seedream-4-5-251128',
      operation: 'upscale',
      resourceId: 42,
    });
    assert.equal(credits.getTenantAccount(db, 'tenant-image-tools').available, 13);
    assert.equal(credits.getTenantAccount(db, 'tenant-image-tools').held, 7);

    billing.settle(db, { error() {} }, held, 'completed');
    const account = credits.getTenantAccount(db, 'tenant-image-tools');
    assert.deepEqual(
      { available: account.available, held: account.held, spent: account.spent },
      { available: 13, held: 0, spent: 7 },
    );
    assert.deepEqual(
      db.prepare(`SELECT event_type, tenant_id, user_id, outcome
        FROM audit_events ORDER BY rowid`).all(),
      [
        {
          event_type: 'generation.image_tool.upscale.created',
          tenant_id: 'tenant-image-tools',
          user_id: 'user-image-tools',
          outcome: 'success',
        },
        {
          event_type: 'generation.image_tool.upscale.completed',
          tenant_id: 'tenant-image-tools',
          user_id: 'user-image-tools',
          outcome: 'success',
        },
      ],
    );
  } finally {
    db.close();
  }
});

test('公开图片工具失败退款且积分不足时不产生预扣或审计事件', () => {
  const db = setup();
  try {
    const held = billing.begin(db, {
      enabled: true,
      tenantId: 'tenant-image-tools',
      userId: 'user-image-tools',
      model: 'doubao-seedream-4-5-251128',
      operation: 'detail_enhance',
      resourceId: 43,
    });
    billing.settle(db, { error() {} }, held, 'failed', 'provider failed');
    const account = credits.getTenantAccount(db, 'tenant-image-tools');
    assert.deepEqual(
      { available: account.available, held: account.held, spent: account.spent },
      { available: 20, held: 0, spent: 0 },
    );
    assert.equal(
      db.prepare("SELECT status FROM tenant_usage_reservations WHERE id = ?").get(
        held.reservationId,
      ).status,
      'refunded',
    );

    credits.setTenantAccountBalance(db, 'tenant-image-tools', 1);
    assert.throws(
      () => billing.begin(db, {
        enabled: true,
        tenantId: 'tenant-image-tools',
        userId: 'user-image-tools',
        model: 'doubao-seedream-4-5-251128',
        operation: 'upscale',
        resourceId: 44,
      }),
      (error) => error.code === 'INSUFFICIENT_CREDITS',
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count,
      1,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE resource_id = '44'").get().count,
      0,
    );
  } finally {
    db.close();
  }
});

test('公开图片工具只有配置了启用价格才公布远程能力', () => {
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    const tool = { model: 'doubao-seedream-4-5-251128' };
    assert.equal(billing.availability(db, tool).tool, null);
    assert.match(billing.availability(db, tool).reason, /积分价格/);

    prices.set(db, tool.model, 7, { category: 'image' });
    assert.equal(billing.availability(db, tool).tool, tool);

    prices.set(db, tool.model, 7, { category: 'image', status: 'disabled' });
    assert.equal(billing.availability(db, tool).tool, null);
    assert.match(billing.availability(db, tool).reason, /停用/);
  } finally {
    db.close();
  }
});
