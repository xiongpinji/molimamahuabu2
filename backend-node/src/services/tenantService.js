const { randomUUID } = require('crypto');

function tenantError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tenant_members (
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, user_id)
    );
  `);
}

function personalTenantId(userId) {
  return `personal:${String(userId)}`;
}

function personalTenantSlug(userId) {
  return `personal-${Buffer.from(String(userId), 'utf8').toString('hex')}`;
}

function ensurePersonalTenant(db, user) {
  ensureSchema(db);
  const userId = String(user?.id || '');
  if (!userId) throw new Error('用户 ID 不能为空');
  const current = db.prepare('SELECT id, email FROM platform_users WHERE id = ?').get(userId);
  const email = String(user?.email || current?.email || '');
  const localPart = email.includes('@') ? email.slice(0, email.indexOf('@')) : '个人';
  const id = personalTenantId(userId);
  const now = new Date().toISOString();
  return db.transaction(() => {
    db.prepare(`INSERT OR IGNORE INTO tenants
      (id, name, slug, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?)`)
      .run(id, `${localPart || '个人'} 的空间`, personalTenantSlug(userId), userId, now, now);
    db.prepare(`INSERT OR IGNORE INTO tenant_members
      (tenant_id, user_id, role, status, created_at, updated_at)
      VALUES (?, ?, 'owner', 'active', ?, ?)`)
      .run(id, userId, now, now);
    return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
  })();
}

function normalizeSlug(value) {
  const slug = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(slug)) {
    throw tenantError('INVALID_TENANT_SLUG', '租户标识需为 3 到 63 位小写字母、数字或连字符');
  }
  return slug;
}

function createTenant(db, userIdValue, input = {}) {
  ensureSchema(db);
  const userId = String(userIdValue || '');
  const name = String(input.name || '').trim();
  if (!userId || !name) throw tenantError('INVALID_INPUT', '租户名称不能为空');
  const slug = normalizeSlug(input.slug);
  const now = new Date().toISOString();
  const id = randomUUID();
  try {
    return db.transaction(() => {
      db.prepare(`INSERT INTO tenants
        (id, name, slug, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?, ?)`).run(id, name, slug, userId, now, now);
      db.prepare(`INSERT INTO tenant_members
        (tenant_id, user_id, role, status, created_at, updated_at)
        VALUES (?, ?, 'owner', 'active', ?, ?)`).run(id, userId, now, now);
      return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
    })();
  } catch (error) {
    if (String(error.code || '').includes('CONSTRAINT_UNIQUE')) {
      throw tenantError('TENANT_SLUG_EXISTS', '租户标识已被使用');
    }
    throw error;
  }
}

function listForUser(db, userId) {
  ensureSchema(db);
  return db.prepare(`SELECT t.*, m.role, m.status AS membership_status
    FROM tenant_members m
    JOIN tenants t ON t.id = m.tenant_id
    WHERE m.user_id = ? AND m.status = 'active' AND t.status = 'active'
    ORDER BY t.created_at ASC`).all(String(userId));
}

function resolveForUser(db, userIdValue, requestedTenantId) {
  const userId = String(userIdValue || '');
  if (!userId) return null;
  ensurePersonalTenant(db, { id: userId });
  const tenantId = requestedTenantId ? String(requestedTenantId) : personalTenantId(userId);
  return db.prepare(`SELECT t.id, t.name, t.slug, m.role
    FROM tenant_members m
    JOIN tenants t ON t.id = m.tenant_id
    WHERE m.user_id = ? AND m.tenant_id = ?
      AND m.status = 'active' AND t.status = 'active'`).get(userId, tenantId) || null;
}

function membership(db, tenantId, userId) {
  ensureSchema(db);
  return db.prepare(`SELECT role, status FROM tenant_members
    WHERE tenant_id = ? AND user_id = ?`).get(String(tenantId), String(userId)) || null;
}

function requireManager(db, tenantId, requesterUserId) {
  const row = membership(db, tenantId, requesterUserId);
  if (!row || row.status !== 'active' || !['owner', 'admin'].includes(row.role)) {
    throw tenantError('TENANT_NOT_FOUND', '租户不存在');
  }
  return row;
}

function listMembers(db, tenantId, requesterUserId) {
  requireManager(db, tenantId, requesterUserId);
  return db.prepare(`SELECT m.user_id, u.email, m.role, m.status, m.created_at, m.updated_at
    FROM tenant_members m
    JOIN platform_users u ON u.id = m.user_id
    WHERE m.tenant_id = ?
    ORDER BY m.created_at ASC`).all(String(tenantId));
}

function addMemberByEmail(db, tenantIdValue, requesterUserId, input = {}) {
  const tenantId = String(tenantIdValue);
  const manager = requireManager(db, tenantId, requesterUserId);
  const email = String(input.email || '').trim().toLowerCase();
  const role = String(input.role || 'member');
  if (!['owner', 'admin', 'member'].includes(role) || (role === 'owner' && manager.role !== 'owner')) {
    throw tenantError('INVALID_TENANT_ROLE', '无权分配该租户角色');
  }
  const user = db.prepare("SELECT id, email FROM platform_users WHERE email = ? AND status = 'active'").get(email);
  if (!user) throw tenantError('USER_NOT_FOUND', '用户不存在');
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO tenant_members
    (tenant_id, user_id, role, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
    ON CONFLICT(tenant_id, user_id) DO UPDATE
    SET role = excluded.role, status = 'active', updated_at = excluded.updated_at`)
    .run(tenantId, user.id, role, now, now);
  return db.prepare(`SELECT m.user_id, u.email, m.role, m.status
    FROM tenant_members m JOIN platform_users u ON u.id = m.user_id
    WHERE m.tenant_id = ? AND m.user_id = ?`).get(tenantId, user.id);
}

function removeMember(db, tenantIdValue, requesterUserId, targetUserIdValue) {
  const tenantId = String(tenantIdValue);
  const manager = requireManager(db, tenantId, requesterUserId);
  const targetUserId = String(targetUserIdValue);
  const target = membership(db, tenantId, targetUserId);
  if (!target) throw tenantError('USER_NOT_FOUND', '成员不存在');
  if (target.role === 'owner') {
    if (manager.role !== 'owner') throw tenantError('TENANT_NOT_FOUND', '租户不存在');
    const owners = db.prepare(`SELECT COUNT(*) AS count FROM tenant_members
      WHERE tenant_id = ? AND role = 'owner' AND status = 'active'`).get(tenantId).count;
    if (owners <= 1) throw tenantError('LAST_TENANT_OWNER', '不能移除租户最后一个所有者');
  }
  db.prepare('DELETE FROM tenant_members WHERE tenant_id = ? AND user_id = ?').run(tenantId, targetUserId);
  return true;
}

module.exports = {
  ensureSchema,
  personalTenantId,
  ensurePersonalTenant,
  createTenant,
  listForUser,
  resolveForUser,
  listMembers,
  addMemberByEmail,
  removeMember,
};
