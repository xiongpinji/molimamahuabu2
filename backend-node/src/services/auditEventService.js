const { randomUUID } = require('crypto');

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    tenant_id TEXT,
    event_type TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    outcome TEXT NOT NULL,
    code TEXT,
    created_at TEXT NOT NULL
  )`);
}

function record(db, input = {}) {
  const eventType = String(input.eventType || '').trim();
  if (!eventType) throw new Error('审计事件类型不能为空');
  ensureSchema(db);
  const event = {
    id: randomUUID(),
    user_id: input.userId == null ? null : String(input.userId),
    tenant_id: input.tenantId == null ? null : String(input.tenantId),
    event_type: eventType,
    resource_type: input.resourceType == null ? null : String(input.resourceType),
    resource_id: input.resourceId == null ? null : String(input.resourceId),
    outcome: String(input.outcome || 'success'),
    code: input.code == null ? null : String(input.code).slice(0, 100),
    created_at: new Date().toISOString(),
  };
  db.prepare(`INSERT INTO audit_events
    (id, user_id, tenant_id, event_type, resource_type, resource_id, outcome, code, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(event.id, event.user_id, event.tenant_id, event.event_type, event.resource_type,
      event.resource_id, event.outcome, event.code, event.created_at);
  return event;
}

function listForUser(db, userId, requestedLimit = 50) {
  ensureSchema(db);
  const limit = Math.min(100, Math.max(1, Number.parseInt(requestedLimit, 10) || 50));
  return db.prepare('SELECT * FROM audit_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(String(userId), limit);
}

function listForTenant(db, tenantId, requestedLimit = 50) {
  ensureSchema(db);
  const limit = Math.min(100, Math.max(1, Number.parseInt(requestedLimit, 10) || 50));
  return db.prepare('SELECT * FROM audit_events WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(String(tenantId), limit);
}

module.exports = { ensureSchema, record, listForUser, listForTenant };
