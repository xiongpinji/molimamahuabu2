const { randomUUID } = require('crypto');
const credits = require('./creditLedgerService');
const tenants = require('./tenantService');
const users = require('./userAuthService');
const audit = require('./auditEventService');

const PLATFORM_ROLES = Object.freeze(['user', 'admin', 'redeem_admin', 'ops', 'support', 'read_only']);
const USER_STATUSES = Object.freeze(['active', 'disabled']);

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
      platform_users.platform_role AS role,
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

function getUser(db, userId) {
  return db.prepare(`SELECT id, email, platform_role AS role, status, token_version,
      created_at, updated_at
    FROM platform_users WHERE id = ?`).get(String(userId));
}

function requireUser(db, userId) {
  const user = getUser(db, userId);
  if (!user) throw adminError('USER_NOT_FOUND', '账号不存在');
  return user;
}

function assertNotLastActiveAdmin(db, user) {
  if (user.role !== 'admin' || user.status !== 'active') return;
  const row = db.prepare(`SELECT COUNT(*) AS count FROM platform_users
    WHERE platform_role = 'admin' AND status = 'active'`).get();
  if (Number(row.count) <= 1) throw adminError('LAST_ACTIVE_ADMIN', '不能停用或降级最后一个启用管理员');
}

function recordAccountAudit(db, actorUserId, targetUserId, eventType, code) {
  audit.record(db, {
    userId: actorUserId,
    eventType,
    resourceType: 'platform_user',
    resourceId: targetUserId,
    outcome: 'success',
    code,
  });
}

function changeUserRole(db, input = {}) {
  users.ensureSchema(db);
  audit.ensureSchema(db);
  const targetUserId = String(input.targetUserId || '');
  const role = String(input.role || '').trim();
  if (!PLATFORM_ROLES.includes(role)) throw adminError('INVALID_USER_ROLE', '账号角色无效');
  return db.transaction(() => {
    const current = requireUser(db, targetUserId);
    if (current.role === role) return current;
    if (current.role === 'admin' && role !== 'admin') assertNotLastActiveAdmin(db, current);
    db.prepare(`UPDATE platform_users
      SET role = ?, platform_role = ?, token_version = token_version + 1, updated_at = ?
      WHERE id = ?`)
      .run(role === 'admin' ? 'admin' : 'user', role, new Date().toISOString(), targetUserId);
    recordAccountAudit(
      db,
      input.actorUserId,
      targetUserId,
      'platform.user.role_changed',
      `${current.role}->${role}`,
    );
    return getUser(db, targetUserId);
  })();
}

function changeUserStatus(db, input = {}) {
  users.ensureSchema(db);
  audit.ensureSchema(db);
  const targetUserId = String(input.targetUserId || '');
  const status = String(input.status || '').trim();
  if (!USER_STATUSES.includes(status)) throw adminError('INVALID_USER_STATUS', '账号状态无效');
  return db.transaction(() => {
    const current = requireUser(db, targetUserId);
    if (current.status === status) return current;
    if (status === 'disabled' && String(input.actorUserId) === targetUserId) {
      throw adminError('CANNOT_SUSPEND_SELF', '不能暂停自己的账号');
    }
    if (status === 'disabled') assertNotLastActiveAdmin(db, current);
    db.prepare(`UPDATE platform_users
      SET status = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?`)
      .run(status, new Date().toISOString(), targetUserId);
    recordAccountAudit(
      db,
      input.actorUserId,
      targetUserId,
      'platform.user.status_changed',
      `${current.status}->${status}`,
    );
    return getUser(db, targetUserId);
  })();
}

function forceLogout(db, input = {}) {
  users.ensureSchema(db);
  audit.ensureSchema(db);
  const targetUserId = String(input.targetUserId || '');
  return db.transaction(() => {
    requireUser(db, targetUserId);
    db.prepare(`UPDATE platform_users
      SET token_version = token_version + 1, updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), targetUserId);
    recordAccountAudit(
      db,
      input.actorUserId,
      targetUserId,
      'platform.user.force_logout',
      'token_version_incremented',
    );
    return getUser(db, targetUserId);
  })();
}

function updateUser(db, userId, input = {}) {
  const role = String(input.role || '').trim();
  const status = String(input.status || '').trim();
  if (!PLATFORM_ROLES.includes(role) || !USER_STATUSES.includes(status)) {
    throw adminError('INVALID_USER_UPDATE', '账号角色或状态无效');
  }
  return db.transaction(() => {
    changeUserStatus(db, {
      actorUserId: input.actorUserId,
      targetUserId: userId,
      status,
    });
    return changeUserRole(db, {
      actorUserId: input.actorUserId,
      targetUserId: userId,
      role,
    });
  })();
}

function listTenants(db, nowValue = Date.now()) {
  tenants.ensureSchema(db);
  credits.ensureSchema(db);
  const rows = db.prepare(`SELECT
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
  return rows.map((row) => {
    const account = credits.getTenantAccountBreakdown(db, row.id, nowValue);
    return {
      ...row,
      available: account.available,
      permanent_available: account.permanent_available,
      daily_bonus_available: account.daily_bonus_available,
      daily_bonus_expires_at: account.daily_bonus_expires_at,
      membership_ends_on: account.membership_ends_on,
    };
  });
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
  PLATFORM_ROLES,
  USER_STATUSES,
  listUsers,
  updateUser,
  changeUserRole,
  changeUserStatus,
  forceLogout,
  listTenants,
  adjustTenantCredits,
  listCreditTransactions,
};
