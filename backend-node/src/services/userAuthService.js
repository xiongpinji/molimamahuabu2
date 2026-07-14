const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const TOKEN_TTL = '2h';

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
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function publicUser(row) {
  return row && {
    id: row.id,
    email: row.email,
    role: row.role,
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

function validSecret(secret) {
  return typeof secret === 'string' && Buffer.byteLength(secret, 'utf8') >= 32;
}

function issueToken(user, secret) {
  if (!validSecret(secret)) throw authError('AUTH_NOT_CONFIGURED', '用户登录密钥未安全配置');
  return jwt.sign({ email: user.email, role: user.role }, secret, {
    subject: user.id,
    expiresIn: TOKEN_TTL,
    algorithm: 'HS256',
  });
}

function verifyToken(token, secret) {
  if (!validSecret(secret)) throw authError('AUTH_NOT_CONFIGURED', '用户登录密钥未安全配置');
  const claims = jwt.verify(token, secret, { algorithms: ['HS256'] });
  return { id: claims.sub, email: claims.email, role: claims.role };
}

module.exports = { ensureSchema, register, authenticate, issueToken, verifyToken, validSecret };
