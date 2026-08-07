const mediaModelSelection = require('./mediaModelSelectionService');

const SUPPORTED_MODELS = ['GPT-5.5', 'gpt-image-2', 'seedance 2.0'];
const MODEL_CATEGORIES = ['text', 'image', 'video', 'audio', 'other'];
const MODEL_STATUSES = ['enabled', 'disabled'];
const COST_UNITS = ['request', 'image', 'second', 'token'];
const BILLING_UNITS = ['request', 'second'];
const VIDEO_RESOLUTIONS = ['480p', '720p'];
const IMAGE_RESOLUTIONS = ['1k', '2k', '4k'];
const SERVICE_CATEGORIES = {
  text: 'text',
  image: 'image',
  storyboard_image: 'image',
  video: 'video',
  tts: 'audio',
  audio: 'audio',
};

function hasConnectionCredential(config) {
  return require('./aiConfigService').hasConnectionCredential(config);
}

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

function isToken6688PerRequestVideo(value) {
  const selected = mediaModelSelection.parseQualifiedSelection(value);
  return /^seedance-2-0-special-(?:mini|fast|full)-720p$/i.test(
    String(selected?.upstreamModel || value || '').trim(),
  );
}

function billingUnit(value, category = '', configuredUnit = '') {
  if (isToken6688PerRequestVideo(value)) return 'request';
  const explicit = String(configuredUnit || '').trim().toLowerCase();
  if (BILLING_UNITS.includes(explicit)) return explicit;
  return String(category || '').toLowerCase() === 'video' || canonicalModel(value) === 'seedance 2.0'
    ? 'second'
    : 'request';
}

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS model_credit_prices (
    model TEXT PRIMARY KEY,
    credits INTEGER NOT NULL CHECK (credits > 0),
    display_name TEXT,
    category TEXT NOT NULL DEFAULT 'other',
    status TEXT NOT NULL DEFAULT 'enabled',
    billing_unit TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  )`);
  ensureColumn(db, 'display_name', 'ALTER TABLE model_credit_prices ADD COLUMN display_name TEXT');
  ensureColumn(db, 'category', "ALTER TABLE model_credit_prices ADD COLUMN category TEXT NOT NULL DEFAULT 'other'");
  ensureColumn(db, 'status', "ALTER TABLE model_credit_prices ADD COLUMN status TEXT NOT NULL DEFAULT 'enabled'");
  ensureColumn(db, 'billing_unit', "ALTER TABLE model_credit_prices ADD COLUMN billing_unit TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'cost_unit', "ALTER TABLE model_credit_prices ADD COLUMN cost_unit TEXT NOT NULL DEFAULT 'request'");
  ensureColumn(db, 'cost_micros_per_unit', 'ALTER TABLE model_credit_prices ADD COLUMN cost_micros_per_unit INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'input_cost_micros_per_1k', 'ALTER TABLE model_credit_prices ADD COLUMN input_cost_micros_per_1k INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'output_cost_micros_per_1k', 'ALTER TABLE model_credit_prices ADD COLUMN output_cost_micros_per_1k INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'public_note', 'ALTER TABLE model_credit_prices ADD COLUMN public_note TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS model_resolution_prices (
    model TEXT NOT NULL COLLATE NOCASE,
    resolution TEXT NOT NULL CHECK (resolution IN ('480p', '720p')),
    credits INTEGER NOT NULL CHECK (credits > 0),
    cost_micros_per_second INTEGER NOT NULL DEFAULT 0 CHECK (cost_micros_per_second >= 0),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (model, resolution)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS model_image_resolution_prices (
    model TEXT NOT NULL COLLATE NOCASE,
    resolution TEXT NOT NULL CHECK (resolution IN ('1k', '2k', '4k')),
    credits INTEGER NOT NULL CHECK (credits > 0),
    cost_micros_per_unit INTEGER NOT NULL DEFAULT 0 CHECK (cost_micros_per_unit >= 0),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (model, resolution)
  )`);
}

function normalizeResolution(value, category = 'video') {
  const resolution = String(value || '').trim().toLowerCase();
  const allowed = category === 'image' ? IMAGE_RESOLUTIONS : VIDEO_RESOLUTIONS;
  return allowed.includes(resolution) ? resolution : null;
}

function readResolutionPrices(db, model, category) {
  if (category === 'image') {
    return Object.fromEntries(db.prepare(`SELECT resolution, credits, cost_micros_per_unit
      FROM model_image_resolution_prices WHERE model = ? COLLATE NOCASE ORDER BY resolution`).all(model)
      .map((row) => [row.resolution, {
        credits: row.credits,
        cost_micros_per_unit: row.cost_micros_per_unit,
      }]));
  }
  return Object.fromEntries(db.prepare(`SELECT resolution, credits, cost_micros_per_second
    FROM model_resolution_prices WHERE model = ? COLLATE NOCASE ORDER BY resolution`).all(model)
    .map((row) => [row.resolution, {
      credits: row.credits,
      cost_micros_per_second: row.cost_micros_per_second,
    }]));
}

function withResolutionPrices(db, row) {
  return row ? { ...row, resolution_prices: readResolutionPrices(db, row.model, row.category) } : null;
}

function readRow(db, model) {
  const row = db.prepare(`SELECT model, display_name, public_note, category, credits, status, billing_unit,
      cost_unit, cost_micros_per_unit, input_cost_micros_per_1k,
      output_cost_micros_per_1k, updated_at
    FROM model_credit_prices WHERE model = ? COLLATE NOCASE`).get(model) || null;
  return withResolutionPrices(db, row);
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

function isToken6688Config(row) {
  const provider = String(row.provider || '').trim().toLowerCase();
  const protocol = String(row.api_protocol || '').trim().toLowerCase();
  return provider === 'token6688' || provider === 'tokengo' || protocol === 'token6688';
}

function isRealGenerationVerified(row, model) {
  if (!isToken6688Config(row)) return true;
  try {
    const settings = typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings;
    const verified = Array.isArray(settings?.real_generation_verified_models)
      ? settings.real_generation_verified_models
      : [];
    const target = String(model || '').trim().toLowerCase();
    return verified.some((item) => String(item || '').trim().toLowerCase() === target);
  } catch (_) {
    return false;
  }
}

function listConfiguredModels(db) {
  if (!hasTable(db, 'ai_service_configs')) return [];
  const rows = db.prepare(`SELECT *
    FROM ai_service_configs
    WHERE deleted_at IS NULL
    ORDER BY id`).all();
  const models = [];
  const seen = new Set();
  for (const entry of mediaModelSelection.listEntries(rows)) {
    const category = entry.kind;
    let model;
    try {
      model = canonicalModel(entry.model);
    } catch {
      continue;
    }
    const key = model.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({
      model,
      display_name: entry.duplicated
        ? `${entry.config.name || entry.config.provider || `配置 ${entry.config.id}`} · ${entry.upstreamModel}`
        : model,
      category,
    });
  }
  for (const row of rows.filter((item) => !mediaModelSelection.KIND_BY_SERVICE[item.service_type])) {
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
  const rows = db.prepare(`SELECT model, display_name, public_note, category, credits, status, billing_unit,
      cost_unit, cost_micros_per_unit, input_cost_micros_per_1k,
      output_cost_micros_per_1k, updated_at
    FROM model_credit_prices ORDER BY category, model COLLATE NOCASE`).all()
    .map((row) => withResolutionPrices(db, row));
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
    public_note: null,
    credits: null,
    status: 'unconfigured',
    billing_unit: item.category === 'video' ? 'second' : 'request',
    cost_unit: item.category === 'text' ? 'token' : item.category === 'image' ? 'image' : 'request',
    cost_micros_per_unit: 0,
    input_cost_micros_per_1k: 0,
    output_cost_micros_per_1k: 0,
    resolution_prices: {},
    updated_at: null,
  });
  return [...defaults, ...rows.filter((row) => !seen.has(row.model.toLowerCase()))]
    .map((row) => ({ ...row, billing_unit: billingUnit(row.model, row.category, row.billing_unit) }));
}

function listPublic(db) {
  if (!hasTable(db, 'ai_service_configs')) return [];
  const rows = db.prepare(`SELECT * FROM ai_service_configs
    WHERE deleted_at IS NULL`).all();
  const configsByModel = new Map();
  const addConfig = (model, upstreamModel, config) => {
    const key = String(model || '').trim().toLowerCase();
    if (!key) return;
    const entries = configsByModel.get(key) || [];
    entries.push({ config, upstreamModel: String(upstreamModel || model).trim() });
    configsByModel.set(key, entries);
  };
  for (const entry of mediaModelSelection.listEntries(rows)) {
    const row = entry.config;
    if (!row.is_active) continue;
    if (row.verification_status !== 'verified') continue;
    if (!isRealGenerationVerified(row, entry.upstreamModel)) continue;
    addConfig(entry.model, entry.upstreamModel, row);
  }
  for (const row of rows.filter((item) => !mediaModelSelection.KIND_BY_SERVICE[item.service_type])) {
    if (!row.is_active) continue;
    if (isToken6688Config(row) && row.verification_status !== 'verified') continue;
    for (const model of [...parseConfiguredModels(row.model), String(row.default_model || '').trim()]) {
      if (model && isRealGenerationVerified(row, model)) addConfig(model, model, row);
    }
  }
  return list(db).flatMap((row) => {
    if (row.status !== 'enabled' || !Number.isSafeInteger(row.credits) || row.credits <= 0) return [];
    const entries = configsByModel.get(row.model.toLowerCase()) || [];
    const selected = mediaModelSelection.parseQualifiedSelection(row.model);
    const upstreamModel = selected?.upstreamModel || entries[0]?.upstreamModel || row.model;
    const protectedUsmercariModel = ['gpt-image-2-2-4k', 'nano-banana-2']
      .includes(String(upstreamModel).toLowerCase());
    const strictEntries = entries.filter((entry) => isStrictPublicConfig(entry.config));
    const candidates = protectedUsmercariModel || strictEntries.length ? strictEntries : entries;
    const matched = candidates.find((entry) => isPublicConfigReady(entry.config, row, entry.upstreamModel));
    if (!matched) return [];
    if (!isStrictPublicConfig(matched.config)) return [row];
    const resolutions = verifiedImageResolutions(matched.config, matched.upstreamModel);
    return [{
      ...row,
      resolution_prices: Object.fromEntries(Object.entries(row.resolution_prices || {})
        .filter(([resolution]) => resolutions.includes(String(resolution).toLowerCase()))),
    }];
  });
}

function isStrictPublicConfig(config) {
  return String(config.provider || '').toLowerCase() === 'usmercari_image'
    || String(config.api_protocol || '').toLowerCase() === 'usmercari_image';
}

function verifiedImageCapabilities(config, model) {
  let capabilities = config.verified_capabilities || {};
  try {
    if (typeof capabilities === 'string') capabilities = JSON.parse(capabilities || '{}');
  } catch (_) {
    capabilities = {};
  }
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return {};
  const target = String(model || '').toLowerCase();
  const key = Object.keys(capabilities).find((item) => item.toLowerCase() === target);
  return key ? capabilities[key] || {} : {};
}

function verifiedImageResolutions(config, model) {
  const capabilities = verifiedImageCapabilities(config, model);
  return Array.isArray(capabilities.resolutions)
    ? capabilities.resolutions.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    : [];
}

function isPublicConfigReady(config, price, model = price.model) {
  if (!isStrictPublicConfig(config)) return true;
  if (config.verification_status !== 'verified'
      || !hasConnectionCredential(config)) return false;
  const modelCapabilities = verifiedImageCapabilities(config, model);
  const resolutions = verifiedImageResolutions(config, model);
  return modelCapabilities?.supportsTextToImage === true
    && resolutions.length > 0
    && resolutions.every((resolution) => Number.isSafeInteger(price.resolution_prices?.[resolution]?.credits)
      && price.resolution_prices[resolution].credits > 0);
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
  const publicNote = String(options.publicNote ?? options.public_note ?? existing?.public_note ?? '').trim();
  const configuredBillingUnit = String(options.billingUnit || options.billing_unit || existing?.billing_unit
    || billingUnit(model, category)).trim().toLowerCase();
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
  if (!BILLING_UNITS.includes(configuredBillingUnit)) {
    throw priceError('INVALID_MODEL_PRICE', '计费单位必须是 request 或 second');
  }
  if (!displayName || displayName.length > 120) {
    throw priceError('INVALID_MODEL_PRICE', '模型显示名称必须是 1 到 120 个字符');
  }
  if (publicNote.length > 500) {
    throw priceError('INVALID_MODEL_PRICE', '模型公开备注不能超过 500 个字符');
  }
  const resolutionPrices = options.resolution_prices == null
    ? null
    : Object.entries(options.resolution_prices).map(([value, tier]) => {
      const resolution = normalizeResolution(value, category);
      const tierCredits = Number(tier?.credits);
      if (!resolution || !Number.isSafeInteger(tierCredits) || tierCredits <= 0) {
        const label = category === 'image' ? '图片分辨率价格只支持 1K、2K、4K' : '视频分辨率价格只支持 480P、720P';
        throw priceError('INVALID_MODEL_PRICE', `${label} 的正整数积分`);
      }
      return category === 'image'
        ? { resolution, credits: tierCredits, cost_micros_per_unit: parseCost(tier?.cost_micros_per_unit ?? 0) }
        : { resolution, credits: tierCredits, cost_micros_per_second: parseCost(tier?.cost_micros_per_second ?? 0) };
    });
  if (resolutionPrices?.length && !['image', 'video'].includes(category)) {
    throw priceError('INVALID_MODEL_PRICE', '只有图片或视频模型可以配置分辨率价格');
  }
  const updatedAt = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`INSERT INTO model_credit_prices
        (model, display_name, public_note, category, credits, status, billing_unit, cost_unit, cost_micros_per_unit,
         input_cost_micros_per_1k, output_cost_micros_per_1k, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model) DO UPDATE SET
        display_name = excluded.display_name,
        public_note = excluded.public_note,
        category = excluded.category,
        credits = excluded.credits,
        status = excluded.status,
        billing_unit = excluded.billing_unit,
        cost_unit = excluded.cost_unit,
        cost_micros_per_unit = excluded.cost_micros_per_unit,
        input_cost_micros_per_1k = excluded.input_cost_micros_per_1k,
        output_cost_micros_per_1k = excluded.output_cost_micros_per_1k,
        updated_at = excluded.updated_at`)
      .run(model, displayName, publicNote || null, category, credits, status, configuredBillingUnit, costUnit, costMicrosPerUnit,
        inputCostMicrosPer1k, outputCostMicrosPer1k, updatedAt);
    if (resolutionPrices != null) {
      if (category === 'image') {
        db.prepare('DELETE FROM model_image_resolution_prices WHERE model = ? COLLATE NOCASE').run(model);
        const insert = db.prepare(`INSERT INTO model_image_resolution_prices
          (model, resolution, credits, cost_micros_per_unit, updated_at) VALUES (?, ?, ?, ?, ?)`);
        for (const tier of resolutionPrices) {
          insert.run(model, tier.resolution, tier.credits, tier.cost_micros_per_unit, updatedAt);
        }
      } else {
        db.prepare('DELETE FROM model_resolution_prices WHERE model = ? COLLATE NOCASE').run(model);
        const insert = db.prepare(`INSERT INTO model_resolution_prices
          (model, resolution, credits, cost_micros_per_second, updated_at) VALUES (?, ?, ?, ?, ?)`);
        for (const tier of resolutionPrices) {
          insert.run(model, tier.resolution, tier.credits, tier.cost_micros_per_second, updatedAt);
        }
      }
    }
  })();
  const saved = readRow(db, model);
  return { ...saved, billing_unit: billingUnit(saved.model, saved.category, saved.billing_unit) };
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
  const requestedQuantity = Number(usage.quantity ?? 1);
  if (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0) {
    throw priceError('INVALID_MODEL_PRICE', '成本数量必须大于零');
  }
  const inputTokens = Math.max(0, Math.trunc(Number(usage.inputTokens) || 0));
  const outputTokens = Math.max(0, Math.trunc(Number(usage.outputTokens) || 0));
  const reasoningTokens = Math.max(0, Math.trunc(Number(usage.reasoningTokens) || 0));
  const hasResolutionPrices = Object.keys(row.resolution_prices || {}).length > 0;
  const resolution = ['image', 'video'].includes(row.category)
    ? normalizeResolution(usage.resolution, row.category)
    : null;
  const tier = resolution ? row.resolution_prices[resolution] : null;
  if (row.category === 'image' && hasResolutionPrices && !tier) {
    throw priceError('MODEL_RESOLUTION_PRICE_REQUIRED', '当前图片分辨率积分待管理员配置');
  }
  const costUnit = tier ? (row.category === 'video' ? 'second' : 'image') : row.cost_unit;
  if (costUnit === 'image' && !Number.isSafeInteger(requestedQuantity)) {
    throw priceError('INVALID_MODEL_PRICE', '图片数量必须是正整数');
  }
  const quantity = costUnit === 'request' ? 1 : requestedQuantity;
  const costMicros = costUnit === 'token'
    ? Math.ceil((inputTokens * row.input_cost_micros_per_1k
      + outputTokens * row.output_cost_micros_per_1k) / 1000)
    : Math.ceil(quantity * (tier?.cost_micros_per_second ?? tier?.cost_micros_per_unit ?? row.cost_micros_per_unit));
  return {
    model: row.model,
    cost_unit: costUnit,
    quantity,
    cost_micros: costMicros,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: reasoningTokens,
    ...(tier ? { resolution } : {}),
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

function calculateCharge(db, value, usage = {}) {
  const model = canonicalModel(value);
  const row = readRow(db, model);
  if (!row) throw priceError('MODEL_PRICE_NOT_CONFIGURED', `${model} 尚未配置积分价格，已禁止生成`);
  if (row.status !== 'enabled') throw priceError('MODEL_DISABLED', `${row.model} 已被管理员停用`);
  const hasResolutionPrices = Object.keys(row.resolution_prices || {}).length > 0;
  const resolution = ['image', 'video'].includes(row.category)
    ? normalizeResolution(usage.resolution, row.category)
    : null;
  const tier = resolution ? row.resolution_prices[resolution] : null;
  if (row.category === 'image' && hasResolutionPrices) {
    if (!tier) throw priceError('MODEL_RESOLUTION_PRICE_REQUIRED', '当前图片分辨率积分待管理员配置');
    const quantity = Number(usage.quantity ?? 1);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw priceError('INVALID_MODEL_PRICE', '图片数量必须是正整数');
    }
    return tier.credits * quantity;
  }
  const price = tier && row.category === 'video' ? tier.credits : row.credits;
  if (billingUnit(model, row?.category, row?.billing_unit) !== 'second') return price;
  const duration = Number(usage.duration);
  const normalizedModel = String(
    mediaModelSelection.parseQualifiedSelection(model)?.upstreamModel || model,
  ).toLowerCase();
  const minimum = normalizedModel === 'lingjing-video-v1'
    || /^bytedance\/seedance-2-0-(?:mini|fast)$/.test(normalizedModel)
    ? 4
    : 5;
  if (!Number.isSafeInteger(duration) || duration < minimum || duration > 15) {
    const error = new Error(`视频时长必须是 ${minimum} 到 15 秒之间的整数`);
    error.code = 'INVALID_VIDEO_DURATION';
    throw error;
  }
  return price * duration;
}

module.exports = {
  SUPPORTED_MODELS,
  MODEL_CATEGORIES,
  MODEL_STATUSES,
  COST_UNITS,
  BILLING_UNITS,
  VIDEO_RESOLUTIONS,
  IMAGE_RESOLUTIONS,
  ensureSchema,
  list,
  listPublic,
  set,
  requirePrice,
  calculateCharge,
  quoteCost,
  canonicalModel,
  billingUnit,
  normalizeResolution,
  isToken6688PerRequestVideo,
};
