const SUPPORTED_MODELS = ['GPT-5.5', 'gpt-image-2', 'seedance 2.0'];
const MODEL_CATEGORIES = ['text', 'image', 'video', 'audio', 'other'];
const MODEL_STATUSES = ['enabled', 'disabled'];
const COST_UNITS = ['request', 'image', 'second', 'token'];
const SERVICE_CATEGORIES = {
  text: 'text',
  image: 'image',
  storyboard_image: 'image',
  video: 'video',
  tts: 'audio',
  audio: 'audio',
};

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
  ensureColumn(db, 'cost_unit', "ALTER TABLE model_credit_prices ADD COLUMN cost_unit TEXT NOT NULL DEFAULT 'request'");
  ensureColumn(db, 'cost_micros_per_unit', 'ALTER TABLE model_credit_prices ADD COLUMN cost_micros_per_unit INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'input_cost_micros_per_1k', 'ALTER TABLE model_credit_prices ADD COLUMN input_cost_micros_per_1k INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'output_cost_micros_per_1k', 'ALTER TABLE model_credit_prices ADD COLUMN output_cost_micros_per_1k INTEGER NOT NULL DEFAULT 0');
}

function readRow(db, model) {
  return db.prepare(`SELECT model, display_name, category, credits, status,
      cost_unit, cost_micros_per_unit, input_cost_micros_per_1k,
      output_cost_micros_per_1k, updated_at
    FROM model_credit_prices WHERE model = ? COLLATE NOCASE`).get(model) || null;
}

function hasTable(db, name) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
}

function parseConfiguredModels(value) {
  if (value == null || value === '') return [];
  try {
    const parsed = JSON.parse(value);
    return (Array.isArray(parsed) ? parsed : [parsed])
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  } catch {
    return [String(value).trim()].filter(Boolean);
  }
}

function listConfiguredModels(db) {
  if (!hasTable(db, 'ai_service_configs')) return [];
  const rows = db.prepare(`SELECT service_type, model, default_model
    FROM ai_service_configs
    WHERE deleted_at IS NULL
    ORDER BY id`).all();
  const models = [];
  const seen = new Set();
  for (const row of rows) {
    const category = SERVICE_CATEGORIES[String(row.service_type || '').toLowerCase()] || 'other';
    const configured = [...parseConfiguredModels(row.model), String(row.default_model || '').trim()]
      .filter(Boolean);
    for (const value of configured) {
      let model;
      try {
        model = canonicalModel(value);
      } catch {
        continue;
      }
      const key = model.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      models.push({ model, display_name: model, category });
    }
  }
  return models;
}

function defaultCategory(model) {
  if (model === 'GPT-5.5') return 'text';
  if (model === 'gpt-image-2') return 'image';
  return 'video';
}

function list(db) {
  ensureSchema(db);
  const rows = db.prepare(`SELECT model, display_name, category, credits, status,
      cost_unit, cost_micros_per_unit, input_cost_micros_per_1k,
      output_cost_micros_per_1k, updated_at
    FROM model_credit_prices ORDER BY category, model COLLATE NOCASE`).all();
  const byModel = new Map(rows.map((row) => [row.model.toLowerCase(), row]));
  const catalog = [
    ...SUPPORTED_MODELS.map((model) => ({
      model,
      display_name: model,
      category: defaultCategory(model),
    })),
    ...listConfiguredModels(db),
  ];
  const seen = new Set();
  const defaults = catalog
    .filter((item) => {
      const key = item.model.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((item) => byModel.get(item.model.toLowerCase()) || {
    ...item,
    credits: null,
    status: 'unconfigured',
    cost_unit: item.category === 'text' ? 'token' : item.category === 'image' ? 'image' : 'request',
    cost_micros_per_unit: 0,
    input_cost_micros_per_1k: 0,
    output_cost_micros_per_1k: 0,
    updated_at: null,
  });
  return [...defaults, ...rows.filter((row) => !seen.has(row.model.toLowerCase()))];
}

function listPublic(db) {
  if (!hasTable(db, 'ai_service_configs')) return [];
  const activeModels = new Set(
    db.prepare(`SELECT model, default_model
      FROM ai_service_configs
      WHERE deleted_at IS NULL AND is_active = 1`).all()
      .flatMap((row) => [...parseConfiguredModels(row.model), String(row.default_model || '').trim()])
      .filter(Boolean)
      .map((model) => model.toLowerCase()),
  );
  return list(db).filter((row) => (
    row.status === 'enabled'
    && Number.isSafeInteger(row.credits)
    && row.credits > 0
    && activeModels.has(row.model.toLowerCase())
  ));
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
  const costUnit = String(options.costUnit || options.cost_unit || existing?.cost_unit
    || (category === 'text' ? 'token' : category === 'image' ? 'image' : 'request')).trim().toLowerCase();
  const costMicrosPerUnit = parseCost(options.cost_micros_per_unit ?? existing?.cost_micros_per_unit ?? 0);
  const inputCostMicrosPer1k = parseCost(options.input_cost_micros_per_1k ?? existing?.input_cost_micros_per_1k ?? 0);
  const outputCostMicrosPer1k = parseCost(options.output_cost_micros_per_1k ?? existing?.output_cost_micros_per_1k ?? 0);
  if (!MODEL_CATEGORIES.includes(category)) {
    throw priceError('INVALID_MODEL_PRICE', '模型类型必须是 text、image、video、audio 或 other');
  }
  if (!MODEL_STATUSES.includes(status)) {
    throw priceError('INVALID_MODEL_PRICE', '模型状态必须是 enabled 或 disabled');
  }
  if (!COST_UNITS.includes(costUnit)) {
    throw priceError('INVALID_MODEL_PRICE', '成本单位必须是 request、image、second 或 token');
  }
  if (!displayName || displayName.length > 120) {
    throw priceError('INVALID_MODEL_PRICE', '模型显示名称必须是 1 到 120 个字符');
  }
  const updatedAt = new Date().toISOString();
  db.prepare(`INSERT INTO model_credit_prices
      (model, display_name, category, credits, status, cost_unit, cost_micros_per_unit,
       input_cost_micros_per_1k, output_cost_micros_per_1k, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(model) DO UPDATE SET
      display_name = excluded.display_name,
      category = excluded.category,
      credits = excluded.credits,
      status = excluded.status,
      cost_unit = excluded.cost_unit,
      cost_micros_per_unit = excluded.cost_micros_per_unit,
      input_cost_micros_per_1k = excluded.input_cost_micros_per_1k,
      output_cost_micros_per_1k = excluded.output_cost_micros_per_1k,
      updated_at = excluded.updated_at`)
    .run(model, displayName, category, credits, status, costUnit, costMicrosPerUnit,
      inputCostMicrosPer1k, outputCostMicrosPer1k, updatedAt);
  return readRow(db, model);
}

function parseCost(value) {
  const cost = Number(value);
  if (!Number.isSafeInteger(cost) || cost < 0) {
    throw priceError('INVALID_MODEL_PRICE', '模型成本必须是非负整数微元');
  }
  return cost;
}

function quoteCost(db, value, usage = {}) {
  ensureSchema(db);
  const model = canonicalModel(value);
  const row = readRow(db, model);
  if (!row) throw priceError('MODEL_PRICE_NOT_CONFIGURED', `${model} 尚未配置积分价格，已禁止生成`);
  if (row.status !== 'enabled') throw priceError('MODEL_DISABLED', `${row.model} 已被管理员停用`);
  const quantity = Number(usage.quantity ?? 1);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw priceError('INVALID_MODEL_PRICE', '成本数量必须大于零');
  }
  const inputTokens = Math.max(0, Math.trunc(Number(usage.inputTokens) || 0));
  const outputTokens = Math.max(0, Math.trunc(Number(usage.outputTokens) || 0));
  const reasoningTokens = Math.max(0, Math.trunc(Number(usage.reasoningTokens) || 0));
  const costMicros = row.cost_unit === 'token'
    ? Math.ceil((inputTokens * row.input_cost_micros_per_1k
      + outputTokens * row.output_cost_micros_per_1k) / 1000)
    : Math.ceil(quantity * row.cost_micros_per_unit);
  return {
    model: row.model,
    cost_unit: row.cost_unit,
    quantity,
    cost_micros: costMicros,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: reasoningTokens,
  };
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
  COST_UNITS,
  ensureSchema,
  list,
  listPublic,
  set,
  requirePrice,
  quoteCost,
  canonicalModel,
};
