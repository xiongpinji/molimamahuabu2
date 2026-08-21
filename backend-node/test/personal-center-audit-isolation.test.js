const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const billingRoutes = require('../src/routes/billing');
const auditEvents = require('../src/services/auditEventService');

test('个人中心在租户上下文中只返回当前用户的审计记录', () => {
  const db = new Database(':memory:');
  auditEvents.record(db, { userId: 'user-1', tenantId: 'tenant-1', eventType: 'auth.login.success' });
  auditEvents.record(db, { userId: 'user-2', tenantId: 'tenant-1', eventType: 'auth.login.success' });
  const result = {};
  const res = {
    status(code) { result.status = code; return this; },
    json(body) { result.body = body; return this; },
  };

  billingRoutes(db, { error() {} }).listAuditEvents({
    user: { id: 'user-1' },
    tenant: { id: 'tenant-1' },
    query: { limit: 10 },
  }, res);

  assert.equal(result.body.data.length, 1);
  assert.equal(result.body.data[0].user_id, 'user-1');
});
