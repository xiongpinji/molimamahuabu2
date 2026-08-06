const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const billing = require('../src/services/redrawBillingService');
const credits = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  prices.set(db, 'seedance 2.0', 2, {
    category: 'video',
    billing_unit: 'second',
    resolution_prices: {
      '480p': { credits: 2 },
      '720p': { credits: 3 },
    },
  });
  credits.setTenantAccountBalance(db, 'tenant-redraw', 500);
  credits.setAccountBalance(db, 'user-redraw', 500);
  return db;
}

function shotInput(overrides = {}) {
  return {
    tenantId: 'tenant-redraw',
    actorUserId: 'actor-redraw',
    versionId: 'version-1',
    shotId: 'shot-1',
    model: 'seedance 2.0',
    duration: 6,
    resolution: '720P',
    count: 2,
    locale: 'zh-CN',
    styleSnapshot: { lighting: 'soft', palette: ['red', 'cyan'] },
    attempt: 1,
    ...overrides,
  };
}

test('单镜报价按时长、分辨率和 count 计价并返回稳定快照', () => {
  const db = setup();
  try {
    const quote = billing.quoteShotGeneration(db, shotInput());

    assert.equal(quote.success, true);
    assert.equal(quote.unit_amount, 18);
    assert.equal(quote.count, 2);
    assert.equal(quote.amount, 36);
    assert.deepEqual(quote.snapshot, {
      model: 'seedance 2.0',
      duration: 6,
      resolution: '720P',
      count: 2,
      locale: 'zh-CN',
      style_snapshot: { lighting: 'soft', palette: ['red', 'cyan'] },
      version_id: 'version-1',
      shot_ids: ['shot-1'],
      attempt: 1,
      input_hash: quote.snapshot.input_hash,
    });
    assert.match(quote.snapshot.input_hash, /^[a-f0-9]{64}$/);
  } finally {
    db.close();
  }
});

test('styleSnapshot 对象键顺序不同得到相同 input_hash', () => {
  const db = setup();
  try {
    const first = billing.quoteShotGeneration(db, shotInput({
      styleSnapshot: { a: 1, b: { c: 2, d: 3 } },
    }));
    const second = billing.quoteShotGeneration(db, shotInput({
      styleSnapshot: { b: { d: 3, c: 2 }, a: 1 },
    }));

    assert.equal(first.snapshot.input_hash, second.snapshot.input_hash);
  } finally {
    db.close();
  }
});

test('未配置价格返回 pricing_unconfigured 且不创建 reservation', () => {
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    prices.ensureSchema(db);
    credits.setTenantAccountBalance(db, 'tenant-redraw', 500);

    const result = billing.reserveShotGeneration(db, shotInput({ model: 'unknown-video-model' }));

    assert.equal(result.success, false);
    assert.equal(result.code, 'pricing_unconfigured');
    assert.equal(result.amount, null);
    assert.equal(result.snapshot, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 0);
  } finally {
    db.close();
  }
});

test('同一镜头和参数重复 reserve 返回同一 reservation 且余额只冻结一次', () => {
  const db = setup();
  try {
    const first = billing.reserveShotGeneration(db, shotInput({ count: 1 }));
    const second = billing.reserveShotGeneration(db, shotInput({ count: 1 }));

    assert.equal(first.success, true);
    assert.equal(second.reservation_id, first.reservation_id);
    assert.equal(second.operation_key, first.operation_key);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 1);
    assert.equal(credits.getTenantAccount(db, 'tenant-redraw').held, 18);
    assert.equal(credits.getTenantAccount(db, 'tenant-redraw').available, 482);
    assert.deepEqual(first.billing, { held: 18, charged: 0, released: 0 });
  } finally {
    db.close();
  }
});

test('改参数或 attempt 产生不同 operation key 和独立冻结', () => {
  const db = setup();
  try {
    const first = billing.reserveShotGeneration(db, shotInput({ count: 1, attempt: 1 }));
    const changedDuration = billing.reserveShotGeneration(db, shotInput({ count: 1, duration: 7, attempt: 1 }));
    const changedAttempt = billing.reserveShotGeneration(db, shotInput({ count: 1, attempt: 2 }));

    assert.notEqual(changedDuration.operation_key, first.operation_key);
    assert.notEqual(changedAttempt.operation_key, first.operation_key);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 3);
    assert.equal(credits.getTenantAccount(db, 'tenant-redraw').held, 57);
  } finally {
    db.close();
  }
});

test('结算成功、明确失败释放、未知状态保持冻结且重复 settle 不重复账本事件', () => {
  const db = setup();
  try {
    const completed = billing.reserveShotGeneration(db, shotInput({ shotId: 'shot-completed', count: 1 }));
    const failed = billing.reserveShotGeneration(db, shotInput({ shotId: 'shot-failed', count: 1 }));
    const unknown = billing.reserveShotGeneration(db, shotInput({ shotId: 'shot-unknown', count: 1 }));

    assert.deepEqual(
      billing.settleShotGeneration(db, completed.reservation_id, 'completed'),
      { success: true, reservation_id: completed.reservation_id, status: 'confirmed', amount: 18, billing: { held: 0, charged: 18, released: 0 } },
    );
    assert.deepEqual(
      billing.settleShotGeneration(db, failed.reservation_id, 'failed', '供应商明确失败'),
      { success: true, reservation_id: failed.reservation_id, status: 'refunded', amount: 18, billing: { held: 0, charged: 0, released: 18 } },
    );
    assert.deepEqual(
      billing.settleShotGeneration(db, unknown.reservation_id, 'failed', '网络中断，供应商结果未知'),
      { success: true, reservation_id: unknown.reservation_id, status: 'held', amount: 18, billing: { held: 18, charged: 0, released: 0 } },
    );

    billing.settleShotGeneration(db, completed.reservation_id, 'completed');
    billing.settleShotGeneration(db, failed.reservation_id, 'failed', '供应商明确失败');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tenant_credit_ledger WHERE event_type = 'confirm'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tenant_credit_ledger WHERE event_type = 'refund'").get().count, 1);
  } finally {
    db.close();
  }
});

test('批量报价去重 shotIds 并按唯一镜头数计算总价', () => {
  const db = setup();
  try {
    const quote = billing.quoteBatchGeneration(db, {
      tenantId: 'tenant-redraw',
      versionId: 'version-1',
      shotIds: ['shot-1', 'shot-2', 'shot-1', 'shot-3'],
      model: 'seedance 2.0',
      duration: 5,
      resolution: '480p',
      count: 2,
      locale: 'zh-CN',
      styleSnapshot: { tone: 'warm' },
      attempt: 1,
    });

    assert.equal(quote.success, true);
    assert.equal(quote.unit_amount, 10);
    assert.equal(quote.shot_count, 3);
    assert.equal(quote.count, 2);
    assert.equal(quote.amount, 60);
    assert.deepEqual(quote.snapshot.shot_ids, ['shot-1', 'shot-2', 'shot-3']);
  } finally {
    db.close();
  }
});

test('非法 count、shotIds、账户、version、shot、attempt fail closed', () => {
  const db = setup();
  try {
    for (const overrides of [
      { count: 0 },
      { count: 1.5 },
      { tenantId: '', userId: '' },
      { versionId: '' },
      { shotId: '' },
      { attempt: 0 },
      { attempt: 1.5 },
    ]) {
      assert.throws(() => billing.quoteShotGeneration(db, shotInput(overrides)));
    }
    for (const shotIds of [[], [''], ['shot-1', 2]]) {
      assert.throws(() => billing.quoteBatchGeneration(db, { ...shotInput(), shotIds, shotId: undefined }));
    }
    assert.throws(() => billing.reserveShotGeneration(db, { ...shotInput(), shotId: undefined, shotIds: ['shot-1'] }));
  } finally {
    db.close();
  }
});
