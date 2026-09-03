'use strict';

const crypto = require('node:crypto');
const routeCost = require('./providerRouteCostService');
const mediaModelSelection = require('./mediaModelSelectionService');

const COST_UNITS = new Set(['request', 'image', 'second', 'character', 'token']);
const SOURCE_CURRENCIES = new Set(['USD', 'CNY']);

function syncError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1_000_000) {
    throw syncError('INVALID_PROVIDER_PRICING_RATE', 'USD/CNY 汇率必须是大于 0 的有限数值');
  }
  return rate;
}

function toMicros(usd, rate) {
  const value = Number(usd) * safeRate(rate) * 1_000_000;
  if (!Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) {
    throw syncError('INVALID_PROVIDER_PRICING', '中转站报价换算后超出安全范围');
  }
  return Math.round(value);
}

function sourceCurrency(value) {
  const currency = String(value || 'USD').trim().toUpperCase();
  return SOURCE_CURRENCIES.has(currency) ? currency : 'USD';
}

function positivePrice(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeUnit(value) {
  const unit = String(value || '').trim().toLowerCase();
  if (unit === 'seconds' || unit === 'sec') return 'second';
  if (unit === 'requests' || unit === 'call') return 'request';
  if (unit === 'images') return 'image';
  return COST_UNITS.has(unit) ? unit : null;
}

function addTier(tiers, resolution, price, unit) {
  const normalizedPrice = positivePrice(price);
  const normalizedUnit = normalizeUnit(unit);
  if (!normalizedPrice || !normalizedUnit) return;
  const key = String(resolution || '').trim().toLowerCase();
  if (!key) return;
  const existing = tiers[key];
  if (!existing || normalizedPrice > existing.price) {
    tiers[key] = { price: normalizedPrice, unit: normalizedUnit };
  }
}

function parsePricingRow(row, options = {}) {
  if (!row || typeof row !== 'object') return null;
  const model = String(row.model_name || '').trim();
  if (!model) return null;
  // NewAPI quota_type=0 is a倍率/Token计费表达式，不能在没有上游 token 规则时臆算人民币成本。
  if (Number(row.quota_type) === 0) return null;
  const source = sourceCurrency(options.sourceCurrency);
  const rate = source === 'CNY' ? 1 : safeRate(options.usdCnyRate);
  const tiers = {};

  if (row.resolution_prices && typeof row.resolution_prices === 'object') {
    for (const [resolution, price] of Object.entries(row.resolution_prices)) {
      const unit = row.resolution_price_units?.[resolution] || row.billing_unit;
      addTier(tiers, resolution, price, unit);
    }
  }
  for (const item of Array.isArray(row.conditional_prices) ? row.conditional_prices : []) {
    const resolution = item?.conditions?.resolution;
    addTier(tiers, resolution || '__base', item?.price, item?.unit || row.billing_unit);
  }
  if (row.duration_prices && typeof row.duration_prices === 'object') {
    for (const [duration, value] of Object.entries(row.duration_prices)) {
      const price = value && typeof value === 'object' ? value.price : value;
      const unit = value && typeof value === 'object' ? value.unit : row.billing_unit;
      addTier(tiers, `duration:${duration}`, price, unit);
    }
  }

  const allTiers = Object.values(tiers);
  const basePrice = allTiers.length
    ? Math.max(...allTiers.map((item) => item.price))
    : positivePrice(row.model_price);
  if (!basePrice) return null;
  const unit = allTiers.find((item) => item.unit === 'second')?.unit
    || allTiers[0]?.unit
    || normalizeUnit(row.billing_unit)
    || 'request';
  const resolutionPrices = Object.fromEntries(Object.entries(tiers)
    .filter(([key, item]) => !key.startsWith('duration:') && key !== '__base')
    .map(([key, item]) => [key, { micros_per_unit: toMicros(item.price, rate) }]));
  return {
    model,
    source_currency: source,
    cost_source: 'relay_auto',
    cost_unit: unit,
    currency: 'CNY',
    micros_per_unit: toMicros(basePrice, rate),
    resolution_prices: resolutionPrices,
    source_exchange_rate: rate,
    source_price: row,
  };
}

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS provider_route_model_costs (
    config_id INTEGER NOT NULL,
    model TEXT NOT NULL COLLATE NOCASE,
    currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
    cost_unit TEXT NOT NULL CHECK (cost_unit IN ('request', 'image', 'second', 'character', 'token')),
    micros_per_unit INTEGER NOT NULL DEFAULT 0 CHECK (micros_per_unit >= 0),
    input_cost_micros_per_1k INTEGER NOT NULL DEFAULT 0 CHECK (input_cost_micros_per_1k >= 0),
    output_cost_micros_per_1k INTEGER NOT NULL DEFAULT 0 CHECK (output_cost_micros_per_1k >= 0),
    resolution_prices_json TEXT NOT NULL DEFAULT '{}',
    source_currency TEXT NOT NULL DEFAULT 'USD' CHECK (source_currency IN ('USD', 'CNY')),
    source_price_json TEXT NOT NULL DEFAULT '{}',
    source_url TEXT,
    source_fetched_at TEXT,
    source_fingerprint TEXT,
    source_exchange_rate REAL,
    cost_source TEXT NOT NULL DEFAULT 'manual' CHECK (cost_source IN ('manual', 'relay_auto')),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (config_id, model),
    FOREIGN KEY (config_id) REFERENCES ai_service_configs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_provider_route_model_costs_model
    ON provider_route_model_costs(model COLLATE NOCASE);
  `);
}

function configExists(db, configId) {
  return Boolean(db.prepare(`SELECT id FROM ai_service_configs
    WHERE id = ? AND deleted_at IS NULL`).get(configId));
}

function positiveConfigId(value) {
  const configId = Number(value);
  if (!Number.isSafeInteger(configId) || configId <= 0) {
    throw syncError('INVALID_PROVIDER_PRICING_CONFIG', 'configId must be positive');
  }
  return configId;
}

function normalizeModel(value) {
  const model = String(value || '').trim();
  if (!model || model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) {
    throw syncError('INVALID_PROVIDER_PRICING_MODEL', 'model must be a visible identifier');
  }
  return model;
}

function readUsdCnyRate(db) {
  const settings = require('./generationCostLedgerService').getSettings(db);
  return Number(settings.usd_cny_rate_micros || 0) / 1_000_000;
}

function pricingEndpoint(baseUrl) {
  let parsed;
  try {
    parsed = new URL(String(baseUrl || '').trim());
  } catch (_) {
    throw syncError('INVALID_PROVIDER_PRICING_URL', '中转站地址不是有效 URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw syncError('INVALID_PROVIDER_PRICING_URL', '中转站地址必须是 HTTP(S) URL');
  }
  return `${parsed.origin}/api/pricing`;
}

function statusEndpoint(baseUrl) {
  const pricing = new URL(pricingEndpoint(baseUrl));
  return `${pricing.origin}/api/status`;
}

function pricingSourceCurrency(payload) {
  const status = payload?.data;
  if (payload?.success === true && status && typeof status === 'object' && !Array.isArray(status)
      && status.display_in_currency === true
      && String(status.quota_display_type || '').trim().toUpperCase() === 'CNY') return 'CNY';
  return 'USD';
}

function isNewApiConfig(config) {
  const provider = String(config?.provider || '').trim().toLowerCase();
  const protocol = String(config?.api_protocol || '').trim().toLowerCase();
  return provider === 'newapi' || provider === 'newapi_video'
    || protocol === 'newapi' || protocol === 'newapi_video';
}

async function syncProviderConfig(db, configIdValue, options = {}) {
  ensureSchema(db);
  const configId = positiveConfigId(configIdValue);
  const config = db.prepare(`SELECT id, service_type, provider, api_protocol, base_url,
      api_key, model, default_model, is_active, deleted_at
    FROM ai_service_configs WHERE id = ?`).get(configId);
  if (!config || config.deleted_at) throw syncError('PROVIDER_ROUTE_NOT_FOUND', 'provider route does not exist');
  if (!isNewApiConfig(config)) throw syncError('UNSUPPORTED_PROVIDER_PRICING', '仅支持 NewAPI 中转站报价同步');
  const endpoint = pricingEndpoint(config.base_url);
  const statusUrl = statusEndpoint(config.base_url);
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') throw syncError('PROVIDER_PRICING_FETCH_UNAVAILABLE', '当前运行环境不支持 HTTP 请求');
  const headers = { Accept: 'application/json' };
  const apiKey = String(config.api_key || '').trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || 15_000);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response;
  let detectedSourceCurrency = 'USD';
  try {
    try {
      const statusResponse = await fetchImpl(statusUrl, { headers, ...(controller ? { signal: controller.signal } : {}) });
      if (statusResponse?.ok) detectedSourceCurrency = pricingSourceCurrency(await statusResponse.json());
    } catch (_) {}
    response = await fetchImpl(endpoint, { headers, ...(controller ? { signal: controller.signal } : {}) });
  } catch (error) {
    throw syncError('PROVIDER_PRICING_FETCH_FAILED', '报价接口请求失败');
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (!response?.ok) throw syncError('PROVIDER_PRICING_FETCH_FAILED', `报价接口返回 HTTP ${response?.status || 0}`);
  const payload = await response.json();
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  if (payload?.success === false || !Array.isArray(payload?.data)) {
    throw syncError('PROVIDER_PRICING_RESPONSE_INVALID', '报价接口响应格式无效');
  }
  const byModel = new Map(rows
    .filter((row) => row && row.model_name)
    .map((row) => [String(row.model_name).trim().toLowerCase(), row]));
  const models = mediaModelSelection.orderedModels(config);
  const result = {
    config_id: configId,
    endpoint,
    fetched_at: String(options.fetchedAt || new Date().toISOString()),
    saved: 0,
    skipped: 0,
    skipped_manual: 0,
    models: [],
  };
  for (const model of models) {
    const row = byModel.get(model.toLowerCase());
    if (!row) {
      result.skipped += 1;
      result.models.push({ model, action: 'missing' });
      continue;
    }
    const outcome = saveRelayCost(db, configId, model, row, {
      usdCnyRate: options.usdCnyRate ?? readUsdCnyRate(db),
      sourceCurrency: detectedSourceCurrency,
      sourceUrl: endpoint,
      fetchedAt: result.fetched_at,
    });
    if (outcome.action === 'skipped_manual') result.skipped_manual += 1;
    else if (outcome.action === 'inserted' || outcome.action === 'updated') result.saved += 1;
    else result.skipped += 1;
    result.models.push({ model, action: outcome.action });
  }
  return result;
}

async function syncAllProviderPricing(db, options = {}) {
  ensureSchema(db);
  const configs = db.prepare(`SELECT id FROM ai_service_configs
    WHERE deleted_at IS NULL AND is_active = 1
      AND (lower(provider) IN ('newapi', 'newapi_video')
        OR lower(api_protocol) IN ('newapi', 'newapi_video'))
    ORDER BY id`).all();
  const results = [];
  for (const config of configs) {
    try {
      results.push(await syncProviderConfig(db, config.id, options));
    } catch (error) {
      results.push({ config_id: config.id, action: 'failed', code: error.code || 'UNKNOWN' });
      options.log?.warn?.('Provider pricing sync failed', { config_id: config.id, code: error.code || 'UNKNOWN' });
    }
  }
  return results;
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || '');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function getCost(db, configIdValue, modelValue) {
  ensureSchema(db);
  const configId = positiveConfigId(configIdValue);
  const model = normalizeModel(modelValue);
  const row = db.prepare(`SELECT config_id, model, currency, cost_unit, micros_per_unit,
      input_cost_micros_per_1k, output_cost_micros_per_1k, resolution_prices_json,
      source_currency, source_price_json, source_url, source_fetched_at,
      source_fingerprint, source_exchange_rate, cost_source, updated_at
    FROM provider_route_model_costs WHERE config_id = ? AND model = ? COLLATE NOCASE`)
    .get(configId, model);
  if (!row) return null;
  return {
    ...row,
    resolution_prices: parseJson(row.resolution_prices_json, {}),
    source_price: parseJson(row.source_price_json, {}),
  };
}

function saveCost(db, configIdValue, modelValue, normalized, metadata = {}) {
  ensureSchema(db);
  const configId = positiveConfigId(configIdValue);
  const model = normalizeModel(modelValue);
  if (!configExists(db, configId)) throw syncError('PROVIDER_ROUTE_NOT_FOUND', 'provider route does not exist');
  const current = getCost(db, configId, model);
  if (current?.cost_source === 'manual') return { action: 'skipped_manual', cost: current };
  const now = String(metadata.fetchedAt || metadata.now || new Date().toISOString());
  const sourcePrice = normalized.source_price || {};
  const sourceFingerprint = crypto.createHash('sha256')
    .update(JSON.stringify(sourcePrice)).digest('hex');
  const next = {
    config_id: configId,
    model,
    currency: 'CNY',
    cost_unit: normalized.cost_unit,
    micros_per_unit: normalized.micros_per_unit,
    input_cost_micros_per_1k: 0,
    output_cost_micros_per_1k: 0,
    resolution_prices: normalized.resolution_prices || {},
    source_currency: normalized.source_currency || 'USD',
    source_price: sourcePrice,
    source_url: metadata.sourceUrl || null,
    source_fetched_at: metadata.fetchedAt || now,
    source_fingerprint: sourceFingerprint,
    source_exchange_rate: normalized.source_exchange_rate || null,
    cost_source: 'relay_auto',
    updated_at: now,
  };
  const nextFingerprint = routeCost.fingerprintRouteCost({
    config_id: configId,
    currency: next.currency,
    cost_unit: next.cost_unit,
    micros_per_unit: next.micros_per_unit,
    input_cost_micros_per_1k: next.input_cost_micros_per_1k,
    output_cost_micros_per_1k: next.output_cost_micros_per_1k,
    resolution_prices: next.resolution_prices,
  });
  if (current && routeCost.fingerprintRouteCost(current) === nextFingerprint) {
    // 即使金额没有变化，也刷新来源快照时间，便于管理员判断最近一次成功抓取。
    db.prepare(`UPDATE provider_route_model_costs
      SET source_price_json = ?, source_url = ?, source_fetched_at = ?,
          source_fingerprint = ?, source_exchange_rate = ?, updated_at = ?
      WHERE config_id = ? AND model = ? COLLATE NOCASE`)
      .run(
        JSON.stringify(next.source_price),
        next.source_url,
        next.source_fetched_at,
        next.source_fingerprint,
        next.source_exchange_rate,
        next.updated_at,
        configId,
        model,
      );
    return { action: 'unchanged', cost: getCost(db, configId, model) };
  }
  db.prepare(`INSERT INTO provider_route_model_costs
      (config_id, model, currency, cost_unit, micros_per_unit,
       input_cost_micros_per_1k, output_cost_micros_per_1k, resolution_prices_json,
       source_currency, source_price_json, source_url, source_fetched_at,
       source_fingerprint, source_exchange_rate, cost_source, updated_at)
    VALUES (@config_id, @model, @currency, @cost_unit, @micros_per_unit,
      @input_cost_micros_per_1k, @output_cost_micros_per_1k, @resolution_prices_json,
      @source_currency, @source_price_json, @source_url, @source_fetched_at,
      @source_fingerprint, @source_exchange_rate, @cost_source, @updated_at)
    ON CONFLICT(config_id, model) DO UPDATE SET
      currency = excluded.currency,
      cost_unit = excluded.cost_unit,
      micros_per_unit = excluded.micros_per_unit,
      input_cost_micros_per_1k = excluded.input_cost_micros_per_1k,
      output_cost_micros_per_1k = excluded.output_cost_micros_per_1k,
      resolution_prices_json = excluded.resolution_prices_json,
      source_currency = excluded.source_currency,
      source_price_json = excluded.source_price_json,
      source_url = excluded.source_url,
      source_fetched_at = excluded.source_fetched_at,
      source_fingerprint = excluded.source_fingerprint,
      source_exchange_rate = excluded.source_exchange_rate,
      cost_source = excluded.cost_source,
      updated_at = excluded.updated_at`)
    .run({
      ...next,
      resolution_prices_json: JSON.stringify(next.resolution_prices),
      source_price_json: JSON.stringify(next.source_price),
    });
  const saved = getCost(db, configId, model);
  if (!current || routeCost.fingerprintRouteCost(current) !== routeCost.fingerprintRouteCost(saved)) {
    try {
      require('./providerCanaryEvidenceService').invalidateConfig(db, configId, 'cost_changed', now);
    } catch (error) {
      if (error?.code !== 'SQLITE_ERROR'
          || !/no such table:\s*provider_canary_evidence\b/i.test(String(error.message || ''))) {
        throw error;
      }
    }
  }
  return { action: current ? 'updated' : 'inserted', cost: saved };
}

function saveRelayCost(db, configId, model, row, options = {}) {
  const normalized = parsePricingRow(row, options);
  if (!normalized) return { action: 'skipped_unsupported', cost: getCost(db, configId, model) };
  return saveCost(db, configId, model, normalized, options);
}

function setManualCost(db, configIdValue, modelValue, input, options = {}) {
  ensureSchema(db);
  const configId = positiveConfigId(configIdValue);
  const model = normalizeModel(modelValue);
  const snapshot = routeCost.normalizeRouteCostInput(configId, input);
  const now = String(options.now || new Date().toISOString());
  const current = getCost(db, configId, model);
  db.prepare(`INSERT INTO provider_route_model_costs
      (config_id, model, currency, cost_unit, micros_per_unit,
       input_cost_micros_per_1k, output_cost_micros_per_1k, resolution_prices_json,
       source_currency, source_price_json, cost_source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CNY', '{}', 'manual', ?)
    ON CONFLICT(config_id, model) DO UPDATE SET
      currency = excluded.currency,
      cost_unit = excluded.cost_unit,
      micros_per_unit = excluded.micros_per_unit,
      input_cost_micros_per_1k = excluded.input_cost_micros_per_1k,
      output_cost_micros_per_1k = excluded.output_cost_micros_per_1k,
      resolution_prices_json = excluded.resolution_prices_json,
      source_currency = 'CNY',
      source_price_json = '{}',
      source_url = NULL,
      source_fetched_at = NULL,
      source_fingerprint = NULL,
      source_exchange_rate = NULL,
      cost_source = 'manual',
      updated_at = excluded.updated_at`)
    .run(configId, model, snapshot.currency, snapshot.cost_unit, snapshot.micros_per_unit,
      snapshot.input_cost_micros_per_1k, snapshot.output_cost_micros_per_1k,
      JSON.stringify(snapshot.resolution_prices), now);
  return getCost(db, configId, model);
}

module.exports = {
  COST_UNITS,
  ensureSchema,
  getCost,
  parsePricingRow,
  pricingEndpoint,
  statusEndpoint,
  readUsdCnyRate,
  saveRelayCost,
  syncAllProviderPricing,
  syncProviderConfig,
  setManualCost,
};
