const SUPPORTED_MODELS = ['GPT-5.5', 'gpt-image-2', 'seedance 2.0'];
const MODEL_CATEGORIES = ['text', 'image', 'video', 'audio', 'other'];
const MODEL_STATUSES = ['enabled', 'disabled'];

function priceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function canonicalModel(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 120 || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw priceError('UNSUPPORTED_BILLING_MODEL', '模型 ID 必须是 1 到 120 个可见字符');
  }
  const known = SUPPORTED_MODELS.find((item) => item.toLowerCase() === raw.toLowerCase());
  return known || raw.toLowerCase();
}

function ensureColumn(db, name, sql) {
  const columns = db.prepare('PRAGMA table_info(model_credit_prices)').all();
  if (!columns.some((column) => column.name === name)) db.exec(sql);
}

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS model_credit_prices (
    model TEXT PRIMARY KEY,
    credits INTEGER NOT NULL CHECK (credits > 0),
    display_name TEXT,
    category TEXT NOT NULL DEFAULT 'other',
    status TEXT NOT NULL DEFAULT 'enabled',
    updated_at TEXT NOT NULL
  )`);
  ensureColumn(db, 'display_name', 'ALTER TABLE model_credit_prices ADD COLUMN display_name TEXT');
  ensureColumn(db, 'category', "ALTER TABLE model_credit_prices ADD COLUMN category TEXT NOT NULL DEFAULT 'other'");
  ensureColumn(db, 'status', "ALTER TABLE model_credit_prices ADD COLUMN status TEXT NOT NULL DEFAULT 'enabled'");
}

function readRow(db, model) {
  return db.prepare(`SELECT model, display_name, category, credits, status, updated_at
    FROM model_credit_prices WHERE model = ? COLLATE NOCASE`).get(model) || null;
}

function list(db) {
  ensureSchema(db);
  const rows = db.prepare(`SELECT model, display_name, category, credits, status, updated_at
    FROM model_credit_prices ORDER BY category, model COLLATE NOCASE`).all();
  const byModel = new Map(rows.map((row) => [row.model.toLowerCase(), row]));
  const defaults = SUPPORTED_MODELS.map((model) => byModel.get(model.toLowerCase()) || {
    model,
    display_name: model,
    category: model === 'GPT-5.5' ? 'text' : model === 'gpt-image-2' ? 'image' : 'video',
    credits: null,
    status: 'unconfigured',
    updated_at: null,
  });
  const defaultIds = new Set(SUPPORTED_MODELS.map((model) => model.toLowerCase()));
  return [...defaults, ...rows.filter((row) => !defaultIds.has(row.model.toLowerCase()))];
}

function set(db, value, creditsValue, options = {}) {
  ensureSchema(db);
  const model = canonicalModel(value);
  const credits = Number(creditsValue);
  if (!Number.isSafeInteger(credits) || credits <= 0) {
    throw priceError('INVALID_MODEL_PRICE', '模型价格必须是正整数积分');
  }
  const existing = readRow(db, model);
  const category = String(options.category || existing?.category || 'other').trim().toLowerCase();
  const status = String(options.status || existing?.status || 'enabled').trim().toLowerCase();
  const displayName = String(options.displayName || options.display_name || existing?.display_name || model).trim();
  if (!MODEL_CATEGORIES.includes(category)) {
    throw priceError('INVALID_MODEL_PRICE', '模型类型必须是 text、image、video、audio 或 other');
  }
  if (!MODEL_STATUSES.includes(status)) {
    throw priceError('INVALID_MODEL_PRICE', '模型状态必须是 enabled 或 disabled');
  }
  if (!displayName || displayName.length > 120) {
    throw priceError('INVALID_MODEL_PRICE', '模型显示名称必须是 1 到 120 个字符');
  }
  const updatedAt = new Date().toISOString();
  db.prepare(`INSERT INTO model_credit_prices
      (model, display_name, category, credits, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(model) DO UPDATE SET
      display_name = excluded.display_name,
      category = excluded.category,
      credits = excluded.credits,
      status = excluded.status,
      updated_at = excluded.updated_at`)
    .run(model, displayName, category, credits, status, updatedAt);
  return readRow(db, model);
}

function requirePrice(db, value) {
  ensureSchema(db);
  const model = canonicalModel(value);
  const row = readRow(db, model);
  if (!row) throw priceError('MODEL_PRICE_NOT_CONFIGURED', `${model} 尚未配置积分价格，已禁止生成`);
  if (row.status !== 'enabled') throw priceError('MODEL_DISABLED', `${row.model} 已被管理员停用`);
  return row.credits;
}

module.exports = {
  SUPPORTED_MODELS,
  MODEL_CATEGORIES,
  MODEL_STATUSES,
  ensureSchema,
  list,
  set,
  requirePrice,
  canonicalModel,
};
