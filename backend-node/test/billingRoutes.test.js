const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const billingRoutes = require('../src/routes/billing');
const modelPrice = require('../src/services/modelPriceService');
const credits = require('../src/services/creditLedgerService');
const auditEvents = require('../src/services/auditEventService');

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

test('管理接口列出且只列出三个允许模型', () => {
  const db = new Database(':memory:');
  const handlers = billingRoutes(db, log);
  const { res, result } = capture();
  handlers.listPrices({}, res);
  assert.deepEqual(result.body.data.map((item) => item.model), modelPrice.SUPPORTED_MODELS);
  assert.equal(result.body.data.every((item) => item.credits === null), true);
});

test('管理接口保存正整数价格', () => {
  const db = new Database(':memory:');
  const handlers = billingRoutes(db, log);
  const { res, result } = capture();
  handlers.updatePrice({ params: { model: 'seedance 2.0' }, body: { credits: 35 } }, res);
  assert.equal(result.body.data.model, 'seedance 2.0');
  assert.equal(result.body.data.credits, 35);
});

test('管理接口拒绝小数价格', () => {
  const db = new Database(':memory:');
  const handlers = billingRoutes(db, log);
  const { res, result } = capture();
  handlers.updatePrice({ params: { model: 'gpt-image-2' }, body: { credits: 1.5 } }, res);
  assert.equal(result.status, 400);
});

test('登录用户只能读取自己的积分账户', () => {
  const db = new Database(':memory:');
  credits.ensureSchema(db);
  credits.setAccountBalance(db, 'user-1', 80);
  credits.setAccountBalance(db, 'user-2', 20);
  const handlers = billingRoutes(db, log);
  const { res, result } = capture();
  handlers.getAccount({ user: { id: 'user-1' } }, res);
  assert.deepEqual(result.body.data, { user_id: 'user-1', available: 80, held: 0, spent: 0 });
});

test('积分账户不存在时返回零余额而不是其他用户账户', () => {
  const db = new Database(':memory:');
  credits.ensureSchema(db);
  credits.setAccountBalance(db, 'user-2', 20);
  const handlers = billingRoutes(db, log);
  const { res, result } = capture();
  handlers.getAccount({ user: { id: 'user-1' } }, res);
  assert.deepEqual(result.body.data, { user_id: 'user-1', available: 0, held: 0, spent: 0 });
});

test('��¼�û�ֻ�ܶ�ȡ�Լ��İ�ȫ����¼�', () => {
  const db = new Database(':memory:');
  auditEvents.record(db, { userId: 'user-1', eventType: 'generation.image.created', resourceType: 'image', resourceId: '1' });
  auditEvents.record(db, { userId: 'user-2', eventType: 'generation.video.created', resourceType: 'video', resourceId: '2' });
  const handlers = billingRoutes(db, log);
  const { res, result } = capture();
  handlers.listAuditEvents({ user: { id: 'user-1' }, query: { limit: 10 } }, res);
  assert.equal(result.body.data.length, 1);
  assert.equal(result.body.data[0].user_id, 'user-1');
  assert.equal(result.body.data[0].event_type, 'generation.image.created');
});
