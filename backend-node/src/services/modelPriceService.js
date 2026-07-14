const SUPPORTED_MODELS = ['GPT-5.5', 'gpt-image-2', 'seedance 2.0'];

function priceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function canonicalModel(value) {
  const input = String(value || '').trim().toLowerCase();
  const model = SUPPORTED_MODELS.find((item) => item.toLowerCase() === input);
  if (!model) throw priceError('UNSUPPORTED_BILLING_MODEL', '该模型不在平台允许的计费模型组中');
  return model;
}

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS model_credit_prices (
    model TEXT PRIMARY KEY,
    credits INTEGER NOT NULL CHECK (credits > 0),
    updated_at TEXT NOT NULL
  )`);
}

function list(db) {
  ensureSchema(db);
  const rows = db.prepare('SELECT model, credits, updated_at FROM model_credit_prices').all();
  const byModel = new Map(rows.map((row) => [row.model, row]));
  return SUPPORTED_MODELS.map((model) => byModel.get(model) || { model, credits: null, updated_at: null });
}

function set(db, value, creditsValue) {
  ensureSchema(db);
  const model = canonicalModel(value);
  const credits = Number(creditsValue);
  if (!Number.isSafeInteger(credits) || credits <= 0) {
    throw priceError('INVALID_MODEL_PRICE', '模型价格必须是正整数积分');
  }
  const updatedAt = new Date().toISOString();
  db.prepare(`INSERT INTO model_credit_prices (model, credits, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(model) DO UPDATE SET credits = excluded.credits, updated_at = excluded.updated_at`)
    .run(model, credits, updatedAt);
  return db.prepare('SELECT model, credits, updated_at FROM model_credit_prices WHERE model = ?').get(model);
}

function requirePrice(db, value) {
  ensureSchema(db);
  const model = canonicalModel(value);
  const row = db.prepare('SELECT credits FROM model_credit_prices WHERE model = ?').get(model);
  if (!row) throw priceError('MODEL_PRICE_NOT_CONFIGURED', `${model} 尚未配置积分价格，已禁止生成`);
  return row.credits;
}

module.exports = { SUPPORTED_MODELS, ensureSchema, list, set, requirePrice, canonicalModel };
