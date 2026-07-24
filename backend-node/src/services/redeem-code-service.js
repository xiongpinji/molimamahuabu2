const crypto = require('crypto');
const { randomUUID } = require('crypto');
const credits = require('./creditLedgerService');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function redeemError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeCode(value) {
  const code = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!/^MOLI-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
    throw redeemError('INVALID_REDEEM_CODE', '兑换码格式无效');
  }
  return code;
}

function hashCode(code) {
  return crypto.createHash('sha256').update(normalizeCode(code), 'utf8').digest('hex');
}

function generateCode() {
  const bytes = crypto.randomBytes(12);
  let value = '';
  for (let index = 0; index < 12; index += 1) {
    value += CODE_ALPHABET[bytes[index] % CODE_ALPHABET.length];
  }
  return `MOLI-${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8, 12)}`;
}

function ensureSchema(db) {
  credits.ensureSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS redeem_codes (
      id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      code_hint TEXT NOT NULL,
      label TEXT,
      tenant_id TEXT,
      credits INTEGER NOT NULL CHECK (credits > 0),
      max_redemptions INTEGER NOT NULL CHECK (max_redemptions > 0),
      redeemed_count INTEGER NOT NULL DEFAULT 0 CHECK (redeemed_count >= 0),
      expires_at TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS redeem_code_usages (
      id TEXT PRIMARY KEY,
      code_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      credits INTEGER NOT NULL CHECK (credits > 0),
      redeemed_at TEXT NOT NULL,
      UNIQUE (code_id, tenant_id)
    );
  `);
  const columns = db.prepare('PRAGMA table_info(redeem_codes)').all();
  if (!columns.some((column) => column.name === 'tenant_id')) {
    db.exec('ALTER TABLE redeem_codes ADD COLUMN tenant_id TEXT');
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_redeem_codes_tenant_created
    ON redeem_codes(tenant_id, created_at DESC)`);
}

function publicCode(row) {
  if (!row) return null;
  const { code_hash: _hash, ...safe } = row;
  return safe;
}

function createCode(db, input = {}) {
  ensureSchema(db);
  const creditsValue = Number(input.credits);
  const maxRedemptions = Number(input.maxRedemptions ?? input.max_redemptions ?? 1);
  const label = String(input.label || '').trim();
  const tenantId = String(input.tenantId ?? input.tenant_id ?? '').trim() || null;
  const expiresAtInput = input.expiresAt ?? input.expires_at ?? null;
  const expiresAtDate = expiresAtInput ? new Date(expiresAtInput) : null;
  if (expiresAtDate && Number.isNaN(expiresAtDate.getTime())) {
    throw redeemError('INVALID_REDEEM_CODE', '兑换码到期时间无效');
  }
  const expiresAt = expiresAtDate ? expiresAtDate.toISOString() : null;
  if (!Number.isSafeInteger(creditsValue) || creditsValue <= 0) {
    throw redeemError('INVALID_REDEEM_CODE', '兑换积分必须是正整数');
  }
  if (!Number.isSafeInteger(maxRedemptions) || maxRedemptions <= 0 || maxRedemptions > 100000) {
    throw redeemError('INVALID_REDEEM_CODE', '最大兑换次数必须是 1 到 100000 的整数');
  }
  if (label.length > 120) throw redeemError('INVALID_REDEEM_CODE', '兑换码说明不能超过 120 个字符');
  if (tenantId && tenantId.length > 120) {
    throw redeemError('INVALID_REDEEM_CODE', '目标租户 ID 不能超过 120 个字符');
  }
  let code;
  let digest;
  do {
    code = generateCode();
    digest = hashCode(code);
  } while (db.prepare('SELECT 1 FROM redeem_codes WHERE code_hash = ?').get(digest));
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(`INSERT INTO redeem_codes
    (id, code_hash, code_hint, label, tenant_id, credits, max_redemptions, redeemed_count,
      expires_at, status, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'active', ?, ?, ?)`)
    .run(
      id,
      digest,
      `MOLI-****-****-${code.slice(-4)}`,
      label || null,
      tenantId,
      creditsValue,
      maxRedemptions,
      expiresAt,
      input.createdBy ? String(input.createdBy) : 'platform-admin',
      now,
      now,
    );
  return { ...publicCode(db.prepare('SELECT * FROM redeem_codes WHERE id = ?').get(id)), code };
}

function createCodes(db, input = {}) {
  ensureSchema(db);
  const quantity = Number(input.quantity);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 500) {
    throw redeemError('INVALID_REDEEM_CODE', '批量创建数量必须是 1 到 500 的整数');
  }
  const items = db.transaction(() => Array.from(
    { length: quantity },
    () => createCode(db, input),
  ))();
  return { quantity, items };
}

function listCodes(db) {
  ensureSchema(db);
  return db.prepare(`SELECT id, code_hint, label, tenant_id, credits, max_redemptions,
      redeemed_count, expires_at, status, created_by, created_at, updated_at
    FROM redeem_codes ORDER BY created_at DESC, id DESC`).all();
}

function updateCode(db, codeId, input = {}) {
  ensureSchema(db);
  const id = String(codeId);
  const current = db.prepare('SELECT * FROM redeem_codes WHERE id = ?').get(id);
  if (!current) throw redeemError('REDEEM_CODE_NOT_FOUND', '兑换码不存在');
  const hasStatus = Object.prototype.hasOwnProperty.call(input, 'status');
  const hasExpiresAt = Object.prototype.hasOwnProperty.call(input, 'expiresAt')
    || Object.prototype.hasOwnProperty.call(input, 'expires_at');
  if (!hasStatus && !hasExpiresAt) {
    throw redeemError('INVALID_REDEEM_CODE', '请提供兑换码状态或到期时间');
  }
  const status = hasStatus ? String(input.status || '').trim() : current.status;
  if (!['active', 'disabled'].includes(status)) {
    throw redeemError('INVALID_REDEEM_CODE', '兑换码状态必须是 active 或 disabled');
  }
  let expiresAt = current.expires_at;
  if (hasExpiresAt) {
    const value = input.expiresAt ?? input.expires_at ?? null;
    const parsed = value ? new Date(value) : null;
    if (parsed && Number.isNaN(parsed.getTime())) {
      throw redeemError('INVALID_REDEEM_CODE', '兑换码到期时间无效');
    }
    expiresAt = parsed ? parsed.toISOString() : null;
  }
  db.prepare(`UPDATE redeem_codes
    SET status = ?, expires_at = ?, updated_at = ? WHERE id = ?`)
    .run(status, expiresAt, new Date().toISOString(), id);
  return publicCode(db.prepare('SELECT * FROM redeem_codes WHERE id = ?').get(id));
}

function listUsages(db, codeId) {
  ensureSchema(db);
  const id = String(codeId);
  if (!db.prepare('SELECT 1 FROM redeem_codes WHERE id = ?').get(id)) {
    throw redeemError('REDEEM_CODE_NOT_FOUND', '兑换码不存在');
  }
  return db.prepare(`SELECT
      usages.id,
      usages.code_id,
      usages.tenant_id,
      usages.user_id,
      usages.credits,
      usages.redeemed_at,
      adjustments.id AS ledger_id,
      adjustments.amount AS ledger_amount,
      adjustments.reason AS ledger_reason,
      adjustments.reference_id AS ledger_reference_id,
      adjustments.created_at AS ledger_created_at
    FROM redeem_code_usages AS usages
    LEFT JOIN tenant_credit_adjustments AS adjustments
      ON adjustments.tenant_id = usages.tenant_id
      AND adjustments.reference_type = 'redeem_code'
      AND adjustments.reference_id = usages.code_id
    WHERE usages.code_id = ?
    ORDER BY usages.rowid DESC`).all(id);
}

function redeem(db, input = {}) {
  ensureSchema(db);
  const tenantId = String(input.tenantId || '').trim();
  const userId = String(input.userId || '').trim();
  if (!tenantId || !userId) throw redeemError('INVALID_REDEEM_CODE', '兑换缺少租户或用户身份');
  const digest = hashCode(input.code);
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM redeem_codes WHERE code_hash = ?').get(digest);
    if (!row) throw redeemError('REDEEM_CODE_NOT_FOUND', '兑换码不存在');
    if (row.tenant_id && row.tenant_id !== tenantId) {
      throw redeemError('REDEEM_CODE_NOT_FOUND', '兑换码不存在');
    }
    if (row.status !== 'active') throw redeemError('CODE_DISABLED', '兑换码已停用');
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
      throw redeemError('CODE_EXPIRED', '兑换码已过期');
    }
    const used = db.prepare('SELECT id FROM redeem_code_usages WHERE code_id = ? AND tenant_id = ?')
      .get(row.id, tenantId);
    if (used) throw redeemError('CODE_ALREADY_REDEEMED', '当前工作区已经使用过该兑换码');
    const now = new Date().toISOString();
    const claimed = db.prepare(`UPDATE redeem_codes
      SET redeemed_count = redeemed_count + 1, updated_at = ?
      WHERE id = ? AND status = 'active' AND redeemed_count < max_redemptions`)
      .run(now, row.id);
    if (claimed.changes !== 1) throw redeemError('CODE_EXHAUSTED', '兑换码使用次数已耗尽');
    const usage = {
      id: randomUUID(),
      code_id: row.id,
      tenant_id: tenantId,
      user_id: userId,
      credits: row.credits,
      redeemed_at: now,
    };
    db.prepare(`INSERT INTO redeem_code_usages
      (id, code_id, tenant_id, user_id, credits, redeemed_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(
        usage.id, usage.code_id, usage.tenant_id, usage.user_id,
        usage.credits, usage.redeemed_at,
      );
    credits.adjustTenantBalance(db, {
      tenantId,
      actorUserId: userId,
      amount: row.credits,
      eventType: 'redeem',
      reason: row.label ? `兑换码：${row.label}` : '兑换码入账',
      referenceType: 'redeem_code',
      referenceId: row.id,
    });
    return {
      ...usage,
      account: credits.getTenantAccount(db, tenantId),
    };
  })();
}

module.exports = {
  ensureSchema,
  createCode,
  createCodes,
  listCodes,
  listUsages,
  updateCode,
  redeem,
  normalizeCode,
  hashCode,
};
