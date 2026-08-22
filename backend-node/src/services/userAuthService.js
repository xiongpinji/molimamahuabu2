const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const audit = require('./auditEventService');

const DEFAULT_TOKEN_TTL = '12h';

function resolveTokenTtl(env = process.env) {
  return String(env?.PLATFORM_JWT_TTL || '').trim() || DEFAULT_TOKEN_TTL;
}

function authError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS platform_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
      platform_role TEXT NOT NULL DEFAULT 'user',
      token_version INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(platform_users)').all().map((row) => row.name));
  if (!columns.has('platform_role')) {
    db.exec("ALTER TABLE platform_users ADD COLUMN platform_role TEXT NOT NULL DEFAULT 'user'");
    db.exec("UPDATE platform_users SET platform_role = role WHERE role = 'admin'");
  }
  if (!columns.has('token_version')) {
    db.exec('ALTER TABLE platform_users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0');
  }
}

function publicUser(row) {
  return row && {
    id: row.id,
    email: row.email,
    role: row.platform_role || row.role,
    status: row.status,
    created_at: row.created_at,
  };
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw authError('INVALID_INPUT', '请输入有效邮箱');
  }
  return email;
}

function validatePassword(value) {
  const password = String(value || '');
  if (password.length < 12 || Buffer.byteLength(password, 'utf8') > 256) {
    throw authError('INVALID_INPUT', '密码长度需为 12 到 256 字节');
  }
  return password;
}

function derivePassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function register(db, input) {
  ensureSchema(db);
  const email = normalizeEmail(input?.email);
  const password = validatePassword(input?.password);
  const salt = crypto.randomBytes(16).toString('hex');
  const row = {
    id: uuidv4(), email, password_hash: derivePassword(password, salt), password_salt: salt,
  };
  try {
    db.prepare(`INSERT INTO platform_users (id, email, password_hash, password_salt) VALUES (?, ?, ?, ?)`)
      .run(row.id, row.email, row.password_hash, row.password_salt);
  } catch (error) {
    if (String(error.code).includes('CONSTRAINT_UNIQUE')) throw authError('EMAIL_EXISTS', '该邮箱已注册');
    throw error;
  }
  return publicUser(db.prepare('SELECT * FROM platform_users WHERE id = ?').get(row.id));
}

function bootstrapFirstAdmin(db, emailValue) {
  ensureSchema(db);
  if (!String(emailValue || '').trim()) return null;
  let email;
  try {
    email = normalizeEmail(emailValue);
  } catch {
    return null;
  }
  return db.transaction(() => {
    const existingAdmin = db.prepare(`SELECT 1 FROM platform_users
      WHERE platform_role = 'admin' LIMIT 1`).get();
    if (existingAdmin) return null;
    const target = db.prepare(`SELECT id FROM platform_users
      WHERE email = ? AND status = 'active'`).get(email);
    if (!target) return null;
    db.prepare(`UPDATE platform_users
      SET role = 'admin', platform_role = 'admin',
        token_version = token_version + 1, updated_at = ?
      WHERE id = ?`).run(new Date().toISOString(), target.id);
    const user = getUserById(db, target.id);
    audit.record(db, {
      userId: user.id,
      eventType: 'platform.admin.bootstrap',
      resourceType: 'platform_user',
      resourceId: user.id,
      outcome: 'success',
    });
    return user;
  })();
}

function authenticate(db, emailValue, passwordValue) {
  ensureSchema(db);
  const email = normalizeEmail(emailValue);
  const row = db.prepare('SELECT * FROM platform_users WHERE email = ?').get(email);
  const invalid = () => { throw authError('INVALID_CREDENTIALS', '邮箱或密码错误'); };
  if (!row || row.status !== 'active') return invalid();
  const actual = Buffer.from(derivePassword(String(passwordValue || ''), row.password_salt), 'hex');
  const expected = Buffer.from(row.password_hash, 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return invalid();
  return publicUser(row);
}

function getUserById(db, userId) {
  ensureSchema(db);
  return publicUser(db.prepare('SELECT * FROM platform_users WHERE id = ?').get(String(userId)));
}

function getUserByEmail(db, emailValue) {
  ensureSchema(db);
  const email = normalizeEmail(emailValue);
  return publicUser(db.prepare('SELECT * FROM platform_users WHERE email = ?').get(email));
}

function resetPassword(db, emailValue, passwordValue) {
  ensureSchema(db);
  const email = normalizeEmail(emailValue);
  const password = validatePassword(passwordValue);
  const salt = crypto.randomBytes(16).toString('hex');
  const result = db.prepare(`
    UPDATE platform_users
    SET password_hash = ?, password_salt = ?,
      token_version = token_version + 1, updated_at = ?
    WHERE email = ? AND status = 'active'
  `).run(derivePassword(password, salt), salt, new Date().toISOString(), email);
  if (result.changes !== 1) throw authError('VERIFICATION_INVALID', '验证码无效或已过期');
  return getUserByEmail(db, email);
}

function getTokenVersion(db, userId) {
  ensureSchema(db);
  const row = db.prepare('SELECT token_version FROM platform_users WHERE id = ?').get(String(userId));
  return row ? Number(row.token_version) || 0 : null;
}

function validSecret(secret) {
  return typeof secret === 'string' && Buffer.byteLength(secret, 'utf8') >= 32;
}

function issueToken(user, secret, tokenVersion = 0) {
  if (!validSecret(secret)) throw authError('AUTH_NOT_CONFIGURED', '用户登录密钥未安全配置');
  return jwt.sign({ email: user.email, role: user.role, ver: Number(tokenVersion) || 0 }, secret, {
    subject: user.id,
    expiresIn: resolveTokenTtl(),
    algorithm: 'HS256',
  });
}

function verifyToken(token, secret) {
  if (!validSecret(secret)) throw authError('AUTH_NOT_CONFIGURED', '用户登录密钥未安全配置');
  const claims = jwt.verify(token, secret, { algorithms: ['HS256'] });
  return {
    id: claims.sub,
    email: claims.email,
    role: claims.role,
    tokenVersion: Number(claims.ver) || 0,
  };
}

module.exports = {
  ensureSchema,
  register,
  bootstrapFirstAdmin,
  authenticate,
  getUserById,
  getUserByEmail,
  getTokenVersion,
  resetPassword,
  issueToken,
  verifyToken,
  validSecret,
  resolveTokenTtl,
  normalizeEmail,
};
