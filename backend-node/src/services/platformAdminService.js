const { randomUUID } = require('crypto');
const credits = require('./creditLedgerService');
const tenants = require('./tenantService');
const users = require('./userAuthService');

function adminError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function listUsers(db) {
  users.ensureSchema(db);
  tenants.ensureSchema(db);
  return db.prepare(`SELECT
      platform_users.id,
      platform_users.email,
      platform_users.role,
      platform_users.status,
      platform_users.created_at,
      platform_users.updated_at,
      COUNT(tenant_members.tenant_id) AS tenant_count
    FROM platform_users
    LEFT JOIN tenant_members
      ON tenant_members.user_id = platform_users.id
      AND tenant_members.status = 'active'
    GROUP BY platform_users.id
    ORDER BY platform_users.created_at DESC, platform_users.email COLLATE NOCASE`).all();
}

function updateUser(db, userId, input = {}) {
  users.ensureSchema(db);
  const status = String(input.status || '').trim();
  const role = String(input.role || '').trim();
  if (!['active', 'disabled'].includes(status) || !['user', 'admin'].includes(role)) {
    throw adminError('INVALID_USER_UPDATE', '账号角色或状态无效');
  }
  const result = db.prepare(`UPDATE platform_users
    SET role = ?, status = ?, updated_at = ? WHERE id = ?`)
    .run(role, status, new Date().toISOString(), String(userId));
  if (result.changes !== 1) throw adminError('USER_NOT_FOUND', '账号不存在');
  return db.prepare(`SELECT id, email, role, status, created_at, updated_at
    FROM platform_users WHERE id = ?`).get(String(userId));
}

function listTenants(db) {
  tenants.ensureSchema(db);
  credits.ensureSchema(db);
  return db.prepare(`SELECT
      tenants.id,
      tenants.name,
      tenants.slug,
      tenants.status,
      tenants.created_at,
      COALESCE(tenant_credit_accounts.available, 0) AS available,
      COALESCE(tenant_credit_accounts.held, 0) AS held,
      COALESCE(tenant_credit_accounts.spent, 0) AS spent,
      COUNT(CASE WHEN tenant_members.status = 'active' THEN 1 END) AS member_count
    FROM tenants
    LEFT JOIN tenant_credit_accounts ON tenant_credit_accounts.tenant_id = tenants.id
    LEFT JOIN tenant_members ON tenant_members.tenant_id = tenants.id
    GROUP BY tenants.id
    ORDER BY tenants.created_at DESC, tenants.name COLLATE NOCASE`).all();
}

function adjustTenantCredits(db, tenantIdValue, input = {}) {
  tenants.ensureSchema(db);
  credits.ensureSchema(db);
  const tenantId = String(tenantIdValue || '').trim();
  const tenant = db.prepare('SELECT id FROM tenants WHERE id = ?').get(tenantId);
  if (!tenant) throw adminError('TENANT_NOT_FOUND', '租户不存在');
  const amount = Number(input.amount);
  const reason = String(input.reason || '').trim();
  if (!Number.isSafeInteger(amount) || amount === 0) {
    throw adminError('INVALID_CREDIT_ADJUSTMENT', '积分调整必须是非零整数');
  }
  if (!reason || reason.length > 240) {
    throw adminError('INVALID_CREDIT_ADJUSTMENT', '请填写 1 到 240 个字符的调整原因');
  }
  const transaction = credits.adjustTenantBalance(db, {
    tenantId,
    actorUserId: input.actorUserId || null,
    amount,
    eventType: 'admin_adjust',
    reason,
    referenceType: 'admin_adjustment',
    referenceId: randomUUID(),
  });
  return {
    transaction,
    account: credits.getTenantAccount(db, tenantId),
  };
}

function listCreditTransactions(db, input = {}) {
  credits.ensureSchema(db);
  const limit = Math.min(Math.max(Number.parseInt(input.limit, 10) || 100, 1), 500);
  const tenantId = input.tenantId ? String(input.tenantId) : null;
  const where = tenantId ? 'WHERE adjustments.tenant_id = ?' : '';
  const params = tenantId ? [tenantId, limit] : [limit];
  return db.prepare(`SELECT
      adjustments.id,
      adjustments.tenant_id,
      tenants.name AS tenant_name,
      adjustments.actor_user_id,
      platform_users.email AS actor_email,
      adjustments.event_type,
      adjustments.amount,
      adjustments.reason,
      adjustments.reference_type,
      adjustments.reference_id,
      adjustments.created_at
    FROM tenant_credit_adjustments AS adjustments
    LEFT JOIN tenants ON tenants.id = adjustments.tenant_id
    LEFT JOIN platform_users ON platform_users.id = adjustments.actor_user_id
    ${where}
    ORDER BY adjustments.rowid DESC
    LIMIT ?`).all(...params);
}

module.exports = {
  listUsers,
  updateUser,
  listTenants,
  adjustTenantCredits,
  listCreditTransactions,
};
