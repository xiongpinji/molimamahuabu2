const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const audit = require('../src/services/auditEventService');

test('审计事件只记录结构化安全字段', () => {
  const db = new Database(':memory:');
  const event = audit.record(db, {
    userId: 'user-1', eventType: 'generation.image.created', resourceType: 'image', resourceId: 12,
    outcome: 'success', code: 'CREATED', prompt: '不得落库', api_key: '不得落库',
  });
  assert.equal(event.user_id, 'user-1');
  assert.equal(event.event_type, 'generation.image.created');
  assert.equal(event.resource_id, '12');
  assert.equal('prompt' in event, false);
  assert.equal('api_key' in event, false);
});

test('审计查询按用户隔离并限制最大条数', () => {
  const db = new Database(':memory:');
  audit.record(db, { userId: 'user-1', eventType: 'auth.login.success', outcome: 'success' });
  audit.record(db, { userId: 'user-2', eventType: 'auth.login.success', outcome: 'success' });
  assert.equal(audit.listForUser(db, 'user-1', 500).length, 1);
  assert.equal(audit.listForUser(db, 'user-1', 500)[0].user_id, 'user-1');
});

test('缺少事件类型时拒绝写入', () => {
  const db = new Database(':memory:');
  assert.throws(() => audit.record(db, { userId: 'user-1' }), /事件类型/);
});
