const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const userAuth = require('./userAuthService');

const PURPOSES = new Set(['register', 'password_reset']);
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function verificationError(code = 'VERIFICATION_INVALID', message = '验证码无效或已过期') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_verification_codes (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL COLLATE NOCASE,
      purpose TEXT NOT NULL CHECK (purpose IN ('register', 'password_reset')),
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_verification_lookup
      ON auth_verification_codes(email, purpose, created_at DESC);
  `);
}

function validatePurpose(value) {
  const purpose = String(value || '');
  if (!PURPOSES.has(purpose)) throw verificationError('INVALID_INPUT', '验证码用途无效');
  return purpose;
}

function validateSecret(secret) {
  if (!userAuth.validSecret(secret)) {
    throw verificationError('AUTH_NOT_CONFIGURED', '邮箱验证码密钥未安全配置');
  }
  return secret;
}

function hashCode(secret, email, purpose, code) {
  return crypto
    .createHmac('sha256', secret)
    .update(`email-verification:v1:${email}:${purpose}:${code}`)
    .digest('hex');
}

function defaultGenerateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function issue(db, options = {}) {
  ensureSchema(db);
  const email = userAuth.normalizeEmail(options.email);
  const purpose = validatePurpose(options.purpose);
  const secret = validateSecret(options.secret);
  const now = options.now instanceof Date ? options.now : new Date();
  const code = String((options.generateCode || defaultGenerateCode)());
  if (!/^\d{6}$/.test(code)) {
    throw verificationError('INVALID_INPUT', '验证码生成器必须返回 6 位数字');
  }

  db.prepare(`
    UPDATE auth_verification_codes
    SET consumed_at = ?
    WHERE email = ? AND purpose = ? AND consumed_at IS NULL
  `).run(now.toISOString(), email, purpose);

  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
  db.prepare(`
    INSERT INTO auth_verification_codes
      (id, email, purpose, code_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    uuidv4(),
    email,
    purpose,
    hashCode(secret, email, purpose, code),
    expiresAt.toISOString(),
    now.toISOString(),
  );
  return { code, email, purpose, expiresAt: expiresAt.toISOString() };
}

function consume(db, options = {}) {
  ensureSchema(db);
  const email = userAuth.normalizeEmail(options.email);
  const purpose = validatePurpose(options.purpose);
  const secret = validateSecret(options.secret);
  const code = String(options.code || '').trim();
  const now = options.now instanceof Date ? options.now : new Date();
  const row = db.prepare(`
    SELECT *
    FROM auth_verification_codes
    WHERE email = ? AND purpose = ? AND consumed_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `).get(email, purpose);

  if (!row || row.failed_attempts >= MAX_ATTEMPTS || new Date(row.expires_at).getTime() < now.getTime()) {
    throw verificationError();
  }
  const actual = Buffer.from(hashCode(secret, email, purpose, code), 'hex');
  const expected = Buffer.from(row.code_hash, 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    db.prepare(`
      UPDATE auth_verification_codes
      SET failed_attempts = failed_attempts + 1
      WHERE id = ?
    `).run(row.id);
    throw verificationError();
  }
  db.prepare('UPDATE auth_verification_codes SET consumed_at = ? WHERE id = ?')
    .run(now.toISOString(), row.id);
}

module.exports = {
  ensureSchema,
  issue,
  consume,
};
