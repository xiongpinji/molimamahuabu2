const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require(require.resolve('better-sqlite3', {
  paths: [path.join(__dirname, '..', 'backend-node')],
}));

const { runMigrationsAndEnsure } = require('../backend-node/src/db/migrate');
const modelPriceService = require('../backend-node/src/services/modelPriceService');
const {
  EVIDENCE_VERSION,
  buildRequiredMatrix,
  hasCompleteRequiredMatrix,
} = require('../backend-node/scripts/verify-feituo-video-models');

const CONTRACT = 'feituo-h3-seedance25-config-v1';
const PROVIDER_ORIGIN = 'https://feituokuajing.com';
const H3_MODEL = 'xuan-video-v1-6e7b4763634e6206';
const SEEDANCE_MODEL = 'xuan-seedance-2.5';
const TARGET_MODELS = Object.freeze([H3_MODEL, SEEDANCE_MODEL]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function loadVerifiedEvidence(evidencePath, publicDir, now = new Date()) {
  const evidenceBuffer = fs.readFileSync(evidencePath);
  const evidence = JSON.parse(evidenceBuffer.toString('utf8'));
  if (evidence.contract_version !== EVIDENCE_VERSION || evidence.provider_origin !== PROVIDER_ORIGIN) {
    throw new Error('飞拓真实验证证据合同或供应商来源不匹配');
  }
  const generatedAt = Date.parse(String(evidence.generated_at || ''));
  const validUntil = Date.parse(String(evidence.valid_until || ''));
  const current = new Date(now).getTime();
  if (!Number.isFinite(generatedAt) || !Number.isFinite(validUntil)
      || generatedAt > current || current - generatedAt > 24 * 60 * 60 * 1000 || validUntil <= current) {
    throw new Error('飞拓真实验证证据已过期或时间无效');
  }
  if (!hasCompleteRequiredMatrix(evidence.results)) throw new Error('飞拓三组真实生成证据不完整');
  for (const item of evidence.results) {
    const fileName = String(item.artifact?.output_file || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._~-]*\.mp4$/.test(fileName) || path.basename(fileName) !== fileName) {
      throw new Error('飞拓真实成品文件名不安全');
    }
    const filePath = path.join(publicDir, fileName);
    const publicUrl = new URL(String(item.artifact.public_url || ''));
    if (path.posix.basename(publicUrl.pathname) !== fileName) throw new Error(`${item.id} 公网地址与成品文件名不一致`);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1024) throw new Error(`${item.id} 真实成品文件无效`);
    if (sha256(fs.readFileSync(filePath)) !== item.artifact.sha256) throw new Error(`${item.id} 真实成品哈希不匹配`);
  }
  return {
    payload: evidence,
    sha256: sha256(evidenceBuffer),
    generatedAt: new Date(generatedAt).toISOString(),
  };
}

function verifiedCapabilities(evidence) {
  const byModel = new Map(evidence.payload.results.map((item) => [item.id, item]));
  if (!byModel.has('h3-2k') || !byModel.has('seedance25-480') || !byModel.has('seedance25-720')) {
    throw new Error('飞拓三组真实生成证据矩阵不完整');
  }
  const noReferences = {
    referenceTypes: [],
    maxReferences: 0,
    maxImageReferences: 0,
    maxVideoReferences: 0,
    maxAudioReferences: 0,
    supportsFirstFrame: false,
    supportsLastFrame: false,
    supportsImageReference: false,
    supportsVideoReference: false,
    supportsAudioReference: false,
    supportsAudio: false,
    quantities: [1],
    aspectRatios: ['16:9'],
  };
  return {
    [H3_MODEL]: { ...noReferences, resolutions: ['2k'], durations: [15] },
    [SEEDANCE_MODEL]: { ...noReferences, resolutions: ['480p', '720p'], durations: [4] },
  };
}

function parseModels(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (_) {
    return [];
  }
}

function findSourceConfig(db) {
  const rows = db.prepare(`SELECT * FROM ai_service_configs
    WHERE deleted_at IS NULL AND is_active = 1
      AND (LOWER(provider) = 'feituo' OR LOWER(api_protocol) = 'feituo_open')
    ORDER BY is_default DESC, priority DESC, id ASC`).all();
  const source = rows.find((row) => String(row.api_key || '').trim()
    && String(row.base_url || '').replace(/\/+$/, '') === PROVIDER_ORIGIN);
  if (!source) throw new Error('未找到可复用凭据的现有飞拓配置');
  return source;
}

function targetConfigs(db) {
  return db.prepare(`SELECT * FROM ai_service_configs
    WHERE deleted_at IS NULL AND (LOWER(provider) = 'feituo' OR LOWER(api_protocol) = 'feituo_open')
    ORDER BY id`).all().filter((row) => parseModels(row.model).some((model) => TARGET_MODELS.includes(model)));
}

function expectedSettings(evidence) {
  const caps = verifiedCapabilities(evidence);
  return {
    integration_contract: CONTRACT,
    evidence_contract: EVIDENCE_VERSION,
    evidence_sha256: evidence.sha256,
    real_generation_verified_models: [...TARGET_MODELS],
    canvas_capabilities_by_model: Object.fromEntries(TARGET_MODELS.map((model) => [model, caps[model]])),
  };
}

function assertExactTargetConfig(row, evidence) {
  if (!row) throw new Error('飞拓新模型配置不存在');
  const settings = readSettings(row.settings);
  const caps = readSettings(row.verified_capabilities);
  if (row.service_type !== 'video' || row.provider !== 'feituo' || row.api_protocol !== 'feituo_open'
      || row.name !== '飞拓 H3-2K / Seedance 2.5'
      || String(row.base_url || '').replace(/\/+$/, '') !== PROVIDER_ORIGIN
      || row.endpoint !== '/api/open/v1/video/generate'
      || row.query_endpoint !== '/api/open/v1/video/status?jobId={taskId}'
      || row.verification_status !== 'verified' || Number(row.is_active) !== 1
      || JSON.stringify(parseModels(row.model)) !== JSON.stringify(TARGET_MODELS)
      || row.default_model !== SEEDANCE_MODEL
      || settings.integration_contract !== CONTRACT
      || settings.evidence_sha256 !== evidence.sha256
      || JSON.stringify(caps) !== JSON.stringify(verifiedCapabilities(evidence))) {
    throw new Error('现有飞拓新模型配置与已审查事务不一致，禁止覆盖');
  }
}

function readSettings(value) {
  try { return typeof value === 'string' ? JSON.parse(value || '{}') : (value || {}); } catch (_) { return {}; }
}

function assertPrices(db) {
  const h3 = db.prepare('SELECT * FROM model_credit_prices WHERE model = ? COLLATE NOCASE').get(H3_MODEL);
  const seedance = db.prepare('SELECT * FROM model_credit_prices WHERE model = ? COLLATE NOCASE').get(SEEDANCE_MODEL);
  if (!h3 || h3.display_name !== 'MiniMax H3-2K（飞拓）'
      || h3.public_note !== '固定 2K；已完成真实生成验证；按次计费'
      || h3.credits !== 1313 || h3.status !== 'enabled' || h3.category !== 'video'
      || h3.billing_unit !== 'request' || h3.cost_unit !== 'request' || h3.cost_micros_per_unit !== 1500000) {
    throw new Error('MiniMax H3-2K 积分价格与管理员批准值不一致');
  }
  if (!seedance || seedance.display_name !== 'Seedance 2.5（飞拓）'
      || seedance.public_note !== '已实测 480P、720P；按秒计费'
      || seedance.credits !== 350 || seedance.status !== 'enabled' || seedance.category !== 'video'
      || seedance.billing_unit !== 'second' || seedance.cost_unit !== 'second' || seedance.cost_micros_per_unit !== 400000) {
    throw new Error('Seedance 2.5 积分价格与管理员批准值不一致');
  }
  const tiers = db.prepare(`SELECT resolution, credits, cost_micros_per_second
    FROM model_resolution_prices WHERE model = ? COLLATE NOCASE ORDER BY resolution`).all(SEEDANCE_MODEL);
  if (JSON.stringify(tiers) !== JSON.stringify([
    { resolution: '480p', credits: 350, cost_micros_per_second: 400000 },
    { resolution: '720p', credits: 350, cost_micros_per_second: 400000 },
  ])) throw new Error('Seedance 2.5 的 480P/720P 分档价格不完整');
  const h3Tiers = db.prepare('SELECT COUNT(*) count FROM model_resolution_prices WHERE model = ? COLLATE NOCASE').get(H3_MODEL).count;
  if (h3Tiers !== 0) throw new Error('MiniMax H3-2K 固定档位不应伪造 480P/720P 分档价格');
}

function verifyConfiguration(db, evidence) {
  modelPriceService.ensureSchema(db);
  const configs = targetConfigs(db);
  if (configs.length !== 1) throw new Error(`飞拓新模型配置数量应为 1，实际为 ${configs.length}`);
  assertExactTargetConfig(configs[0], evidence);
  if (!String(configs[0].api_key || '').trim()) throw new Error('飞拓新模型配置未复用凭据');
  assertPrices(db);
  return { ok: true, configId: configs[0].id };
}

async function applyConfiguration(db, evidence, options = {}) {
  modelPriceService.ensureSchema(db);
  const existing = targetConfigs(db);
  if (existing.length) {
    if (existing.length !== 1) throw new Error('检测到多个飞拓新模型配置，禁止自动修复');
    assertExactTargetConfig(existing[0], evidence);
    assertPrices(db);
    return { created: false, configId: existing[0].id };
  }
  const source = findSourceConfig(db);
  const conflictingPrices = TARGET_MODELS.filter((model) => db.prepare(
    'SELECT 1 FROM model_credit_prices WHERE model = ? COLLATE NOCASE',
  ).get(model));
  if (conflictingPrices.length) throw new Error(`飞拓新模型价格已存在，禁止覆盖: ${conflictingPrices.join(', ')}`);
  if (!options.backupPath || !path.isAbsolute(options.backupPath)) throw new Error('应用前必须指定绝对数据库备份路径');
  if (!options.receiptPath || !path.isAbsolute(options.receiptPath)) throw new Error('应用前必须指定绝对事务回执路径');
  await db.backup(options.backupPath);
  const now = new Date().toISOString();
  const caps = verifiedCapabilities(evidence);
  const settings = expectedSettings(evidence);
  let configId;
  db.transaction(() => {
    configId = Number(db.prepare(`INSERT INTO ai_service_configs
      (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
       endpoint, query_endpoint, priority, is_default, is_active, verification_status,
       verification_checked_at, verified_capabilities, verified_at, verification_error,
       settings, created_at, updated_at)
      VALUES ('video', 'feituo', 'feituo_open', '飞拓 H3-2K / Seedance 2.5', ?, ?, ?, ?,
        '/api/open/v1/video/generate', '/api/open/v1/video/status?jobId={taskId}', ?, 0, 1,
        'verified', ?, ?, ?, NULL, ?, ?, ?)`)
      .run(
        PROVIDER_ORIGIN,
        source.api_key,
        JSON.stringify(TARGET_MODELS),
        SEEDANCE_MODEL,
        Number(source.priority || 0),
        evidence.generatedAt,
        JSON.stringify(caps),
        evidence.generatedAt,
        JSON.stringify(settings),
        now,
        now,
      ).lastInsertRowid);
    modelPriceService.set(db, H3_MODEL, 1313, {
      category: 'video', status: 'enabled', displayName: 'MiniMax H3-2K（飞拓）',
      publicNote: '固定 2K；已完成真实生成验证；按次计费', billingUnit: 'request',
      costUnit: 'request', cost_micros_per_unit: 1500000, resolution_prices: {},
    });
    modelPriceService.set(db, SEEDANCE_MODEL, 350, {
      category: 'video', status: 'enabled', displayName: 'Seedance 2.5（飞拓）',
      publicNote: '已实测 480P、720P；按秒计费', billingUnit: 'second',
      costUnit: 'second', cost_micros_per_unit: 400000,
      resolution_prices: {
        '480p': { credits: 350, cost_micros_per_second: 400000 },
        '720p': { credits: 350, cost_micros_per_second: 400000 },
      },
    });
    writeJsonAtomic(options.receiptPath, {
      contract: CONTRACT,
      applied_at: now,
      database_backup: options.backupPath,
      evidence_sha256: evidence.sha256,
      config_id: configId,
      config_updated_at: now,
      models: TARGET_MODELS,
    });
  })();
  verifyConfiguration(db, evidence);
  return { created: true, configId, backupPath: options.backupPath, receiptPath: options.receiptPath };
}

function rollbackConfiguration(db, receiptPath) {
  modelPriceService.ensureSchema(db);
  const receipt = readJson(receiptPath);
  if (receipt.contract !== CONTRACT || JSON.stringify(receipt.models) !== JSON.stringify(TARGET_MODELS)) {
    throw new Error('飞拓配置事务回执不匹配');
  }
  const row = db.prepare('SELECT * FROM ai_service_configs WHERE id = ? AND deleted_at IS NULL').get(Number(receipt.config_id));
  if (!row || readSettings(row.settings).integration_contract !== CONTRACT
      || readSettings(row.settings).evidence_sha256 !== receipt.evidence_sha256
      || row.updated_at !== receipt.config_updated_at) {
    throw new Error('飞拓配置已被修改，禁止自动回滚');
  }
  assertPrices(db);
  db.transaction(() => {
    db.prepare('DELETE FROM model_resolution_prices WHERE model IN (?, ?)').run(...TARGET_MODELS);
    db.prepare('DELETE FROM model_credit_prices WHERE model IN (?, ?)').run(...TARGET_MODELS);
    db.prepare('DELETE FROM ai_service_configs WHERE id = ?').run(Number(receipt.config_id));
  })();
  return { rolledBack: true, configId: Number(receipt.config_id) };
}

function openDb(databasePath) {
  const db = new Database(databasePath);
  runMigrationsAndEnsure(db);
  modelPriceService.ensureSchema(db);
  return db;
}

async function main() {
  const command = process.argv[2] || 'plan';
  const databasePath = path.resolve(String(process.env.FEITUO_CONFIG_DATABASE_PATH || ''));
  const evidencePath = path.resolve(String(process.env.FEITUO_CONFIG_EVIDENCE_PATH || ''));
  const publicDir = path.resolve(String(process.env.FEITUO_CONFIG_PUBLIC_DIR || ''));
  if (!process.env.FEITUO_CONFIG_DATABASE_PATH || !process.env.FEITUO_CONFIG_EVIDENCE_PATH || !process.env.FEITUO_CONFIG_PUBLIC_DIR) {
    throw new Error('缺少 FEITUO_CONFIG_DATABASE_PATH / EVIDENCE_PATH / PUBLIC_DIR');
  }
  const evidence = loadVerifiedEvidence(evidencePath, publicDir);
  const db = openDb(databasePath);
  try {
    if (command === 'plan') {
      const existing = targetConfigs(db);
      process.stdout.write(`${JSON.stringify({ command, existing_target_configs: existing.map((row) => row.id), models: TARGET_MODELS, evidence_sha256: evidence.sha256 }, null, 2)}\n`);
      return;
    }
    if (command === 'verify') {
      process.stdout.write(`${JSON.stringify(verifyConfiguration(db, evidence), null, 2)}\n`);
      return;
    }
    if (command === 'apply') {
      const result = await applyConfiguration(db, evidence, {
        evidencePath,
        backupPath: path.resolve(String(process.env.FEITUO_CONFIG_BACKUP_PATH || '')),
        receiptPath: path.resolve(String(process.env.FEITUO_CONFIG_RECEIPT_PATH || '')),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    if (command === 'rollback') {
      process.stdout.write(`${JSON.stringify(rollbackConfiguration(db, path.resolve(String(process.env.FEITUO_CONFIG_RECEIPT_PATH || ''))), null, 2)}\n`);
      return;
    }
    throw new Error(`未知命令: ${command}`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`FEITUO_CONFIG_TRANSACTION_FAILED: ${String(error.message || error).slice(0, 500)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  applyConfiguration,
  loadVerifiedEvidence,
  rollbackConfiguration,
  verifyConfiguration,
};
