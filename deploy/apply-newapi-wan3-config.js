'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('../backend-node/node_modules/better-sqlite3');
const aiConfigService = require('../backend-node/src/services/aiConfigService');
const mediaModelSelection = require('../backend-node/src/services/mediaModelSelectionService');
const modelPriceService = require('../backend-node/src/services/modelPriceService');
const providerPricingSyncService = require('../backend-node/src/services/providerPricingSyncService');

const CONFIG_ID = 29;
const MODEL = 'alibaba/wan-3.0';
const EXPECTED_MODELS = Object.freeze([
  'seedance-2.0-fast',
  'seedance-2.0',
  'seedance-2.0-mini',
  'seedance-2.5',
  'minimax_h3_image_audio_to_video_v2',
  MODEL,
]);

function noReferenceCapability(duration, resolution, supportsAudio = false) {
  return Object.freeze({
    validated: true,
    durations: [duration],
    aspectRatios: ['16:9'],
    resolutions: [resolution],
    maxReferences: 0,
    maxImageReferences: 0,
    maxVideoReferences: 0,
    maxAudioReferences: 0,
    supportsFirstFrame: false,
    supportsImageReference: false,
    supportsVideoReference: false,
    supportsAudioReference: false,
    supportsAudio,
  });
}

const CAPABILITIES = Object.freeze({
  'seedance-2.0-fast': noReferenceCapability(5, '480p'),
  'seedance-2.0': noReferenceCapability(5, '480p'),
  'seedance-2.0-mini': noReferenceCapability(4, '480p'),
  'seedance-2.5': noReferenceCapability(5, '480p'),
  minimax_h3_image_audio_to_video_v2: Object.freeze({
    validated: true,
    durations: [5],
    aspectRatios: ['16:9'],
    resolutions: ['768p'],
    maxReferences: 1,
    maxImageReferences: 1,
    maxVideoReferences: 0,
    maxAudioReferences: 0,
    supportsFirstFrame: true,
    supportsImageReference: true,
    supportsVideoReference: false,
    supportsAudioReference: false,
    requiresReference: true,
    supportsAudio: false,
  }),
  [MODEL]: noReferenceCapability(4, '480p'),
});

const PRICES = Object.freeze({
  'seedance-2.0-fast': Object.freeze({ displayName: 'Seedance 2.0 Fast', duration: 5, resolution: '480p', credits: 175, cost: 200_000 }),
  'seedance-2.0': Object.freeze({ displayName: 'Seedance 2.0', duration: 5, resolution: '480p', credits: 140, cost: 160_000 }),
  'seedance-2.0-mini': Object.freeze({ displayName: 'Seedance 2.0 Mini', duration: 4, resolution: '480p', credits: 44, cost: 50_000 }),
  'seedance-2.5': Object.freeze({ displayName: 'Seedance 2.5', duration: 5, resolution: '480p', credits: 228, cost: 260_000 }),
  minimax_h3_image_audio_to_video_v2: Object.freeze({ displayName: 'MiniMax H3 图生视频', duration: 5, resolution: '768p', credits: 27, cost: 30_000 }),
  [MODEL]: Object.freeze({ displayName: 'Wan 3.0', duration: 4, resolution: '480p', credits: 134, cost: 150_000 }),
});

function parseObject(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    throw new Error('NewAPI #29 JSON 配置损坏，禁止写入');
  }
}

function safeConfig(row) {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    api_protocol: row.api_protocol,
    base_url: row.base_url,
    model: JSON.parse(row.model),
    default_model: row.default_model,
    verification_status: row.verification_status,
    verified_at: row.verified_at,
    updated_at: row.updated_at,
  };
}

function requireCurrentConfig(db, expectedUpdatedAt) {
  const row = db.prepare('SELECT * FROM ai_service_configs WHERE id = ? AND deleted_at IS NULL').get(CONFIG_ID);
  if (!row) throw new Error('NewAPI #29 不存在');
  if (row.provider !== 'newapi' || row.api_protocol !== 'newapi_video'
      || row.base_url !== 'https://newapi.megabyai.cc' || row.verification_status !== 'verified'
      || row.is_active !== 1) throw new Error('NewAPI #29 身份或状态不匹配，禁止写入');
  if (row.updated_at !== expectedUpdatedAt) throw new Error('NewAPI #29 已变化，禁止覆盖其他管理员修改');
  const models = JSON.parse(row.model);
  if (JSON.stringify(models) !== JSON.stringify(EXPECTED_MODELS)) {
    throw new Error('NewAPI #29 模型集合已变化，禁止覆盖');
  }
  const capabilities = parseObject(row.verified_capabilities);
  const evidence = parseObject(row.verification_evidence);
  if (!EXPECTED_MODELS.every((model) => capabilities[model]?.validated === true && evidence.models?.[model])) {
    throw new Error('NewAPI #29 模型证据不完整，禁止写入');
  }
  for (const model of EXPECTED_MODELS) {
    const price = PRICES[model];
    const cost = providerPricingSyncService.getCost(db, CONFIG_ID, model);
    if (cost?.cost_source !== 'relay_auto'
        || Number(cost?.resolution_prices?.[price.resolution]?.micros_per_unit) !== price.cost) {
      throw new Error(`NewAPI #29 ${model} 的自动中转站成本未匹配实测报价，禁止写入`);
    }
  }
  return { row, capabilities };
}

function pricingModelForConfig(db, upstreamModel) {
  const entry = mediaModelSelection.listEntries(aiConfigService.listConfigs(db))
    .find((item) => Number(item.config.id) === CONFIG_ID
      && item.upstreamModel.toLowerCase() === upstreamModel.toLowerCase());
  if (!entry) throw new Error(`NewAPI #29 缺少模型 ${upstreamModel}`);
  return entry.model;
}

function readPrices(db) {
  const rows = new Map(modelPriceService.list(db).map((row) => [row.model.toLowerCase(), row]));
  return EXPECTED_MODELS.map((model) => {
    const billingModel = pricingModelForConfig(db, model);
    return { upstream_model: model, billing_model: billingModel, price: rows.get(billingModel.toLowerCase()) || null };
  });
}

function applyConfiguration(db, options = {}) {
  const expectedUpdatedAt = String(options.expectedUpdatedAt || '').trim();
  const now = String(options.now || new Date().toISOString());
  if (!expectedUpdatedAt) throw new Error('必须提供 expectedUpdatedAt');
  if (!Number.isFinite(new Date(now).getTime())) throw new Error('now 必须是有效时间');
  let receipt;
  db.transaction(() => {
    const current = requireCurrentConfig(db, expectedUpdatedAt);
    const pricesBefore = readPrices(db);
    const update = db.prepare(`UPDATE ai_service_configs SET
        name = ?, verified_capabilities = ?, updated_at = ?
      WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`).run(
      'NewAPI megabyai（6模型，已实测）',
      JSON.stringify({ ...current.capabilities, ...CAPABILITIES }),
      now,
      CONFIG_ID,
      expectedUpdatedAt,
    );
    if (update.changes !== 1) throw new Error('NewAPI #29 条件更新失败');

    for (const model of EXPECTED_MODELS) {
      const definition = PRICES[model];
      const billingModel = pricingModelForConfig(db, model);
      modelPriceService.set(db, billingModel, definition.credits, {
        displayName: definition.displayName,
        publicNote: `当前开放 ${definition.duration} 秒、16:9、${definition.resolution.toUpperCase()}`,
        category: 'video',
        status: 'enabled',
        billingUnit: 'second',
        costUnit: 'second',
        cost_micros_per_unit: definition.cost,
        resolution_prices: {
          [definition.resolution]: {
            credits: definition.credits,
            cost_micros_per_second: definition.cost,
          },
        },
      });
    }

    const after = db.prepare('SELECT * FROM ai_service_configs WHERE id = ?').get(CONFIG_ID);
    receipt = {
      contract: 'newapi-six-model-public-remediation-v1',
      applied_at: now,
      before: safeConfig(current.row),
      after: safeConfig(after),
      prices_before: pricesBefore,
      prices_after: readPrices(db),
    };
  })();
  return receipt;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') values.apply = true;
    else if (arg.startsWith('--')) values[arg.slice(2)] = argv[++index];
  }
  return values;
}

function writeReceipt(filePath, receipt) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.apply || !args.db || !args['expected-updated-at'] || !args.receipt) {
    throw new Error('用法: --db PATH --expected-updated-at ISO --receipt PATH --apply');
  }
  const db = new Database(path.resolve(args.db), { fileMustExist: true });
  try {
    const receipt = applyConfiguration(db, { expectedUpdatedAt: args['expected-updated-at'] });
    writeReceipt(args.receipt, receipt);
    process.stdout.write(`${JSON.stringify({ success: true, config_id: CONFIG_ID, models: EXPECTED_MODELS })}\n`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`${String(error?.message || error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { CONFIG_ID, MODEL, EXPECTED_MODELS, CAPABILITIES, PRICES, applyConfiguration, main };
