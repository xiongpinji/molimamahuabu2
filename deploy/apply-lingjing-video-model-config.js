'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require(require.resolve('better-sqlite3', {
  paths: [path.join(__dirname, '..', 'backend-node')],
}));

const {
  EVIDENCE_VERSION,
  hasCompleteRequiredMatrix,
  validatePricingSnapshot,
} = require('../backend-node/scripts/verify-lingjing-video-model');
const {
  PUBLIC_MODEL,
  UPSTREAM_MODEL,
  OFFICIAL_BASE_URL,
  DURATIONS,
  RATIOS,
  MAX_IMAGE_REFERENCES,
} = require('../backend-node/src/services/lingjingVideoClient');

const CONTRACT = 'lingjing-relay-video-config-v1';
const PROVIDER_ORIGIN = 'https://seed.alimyun.xyz';
const TARGET_NAME = '灵境 Seedance 2.0 Fast（9 图参考）';
const TARGET_PUBLIC_NOTE = '4/5/6/8/10/11/15 秒，最多 9 张图片参考；不支持首尾帧、视频或音频参考';
const TARGET_CREDITS_PER_SECOND = 149;
const TARGET_COST_MICROS_PER_SECOND = 170000;
const LEGACY_CREDITS_PER_SECOND = 69;
const LEGACY_COST_MICROS_PER_SECOND = 180000;

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

function parseJson(value, fallback = {}) {
  try { return typeof value === 'string' ? JSON.parse(value || '{}') : (value || fallback); } catch (_) { return fallback; }
}

function parseModels(value) {
  const parsed = parseJson(value, null);
  if (Array.isArray(parsed)) return parsed.map((item) => String(item || '').trim()).filter(Boolean);
  const direct = String(value || '').trim();
  return direct ? [direct] : [];
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function loadVerifiedEvidence(evidencePath, publicDir, now = new Date()) {
  const bytes = fs.readFileSync(evidencePath);
  const payload = JSON.parse(bytes.toString('utf8'));
  if (payload.contract_version !== EVIDENCE_VERSION || payload.provider_origin !== PROVIDER_ORIGIN) {
    throw new Error('灵境真实验证证据合同或供应商来源不匹配');
  }
  const current = new Date(now).getTime();
  const generatedAt = Date.parse(String(payload.generated_at || ''));
  const validUntil = Date.parse(String(payload.valid_until || ''));
  if (!Number.isFinite(current) || !Number.isFinite(generatedAt) || !Number.isFinite(validUntil)
      || generatedAt > current || current - generatedAt > 24 * 60 * 60 * 1000 || validUntil <= current) {
    throw new Error('灵境真实验证证据已过期或时间无效');
  }
  if (!hasCompleteRequiredMatrix(payload.results) || !validatePricingSnapshot(payload.pricing)) {
    throw new Error('灵境真实生成或价格证据不完整');
  }
  const result = payload.results[0];
  if (result.provider_audit.uploads[0].reference_sha256 !== payload.verification_scope?.reference_image_sha256) {
    throw new Error('灵境参考图上传绑定证据不完整');
  }
  const fileName = String(result.artifact?.output_file || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]*\.mp4$/.test(fileName) || path.basename(fileName) !== fileName) {
    throw new Error('灵境真实成品文件名不安全');
  }
  const publicUrl = new URL(String(result.artifact.public_url || ''));
  if (publicUrl.origin !== 'https://molimama.vip'
      || publicUrl.pathname !== `/verification-assets/lingjing/${fileName}`
      || publicUrl.search || publicUrl.hash) throw new Error('灵境真实成品公网地址不匹配');
  const filePath = path.join(publicDir, fileName);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1024 || stat.size !== Number(result.artifact.bytes)) {
    throw new Error('灵境真实成品文件无效');
  }
  if (sha256(fs.readFileSync(filePath)) !== result.artifact.sha256) throw new Error('灵境真实成品哈希不匹配');
  return {
    payload,
    sha256: sha256(bytes),
    generatedAt: new Date(generatedAt).toISOString(),
  };
}

function capabilities(evidenceSha) {
  return {
    evidence_contract: EVIDENCE_VERSION,
    evidence_sha256: evidenceSha,
    referenceTypes: ['image'],
    maxReferences: MAX_IMAGE_REFERENCES,
    maxImageReferences: MAX_IMAGE_REFERENCES,
    maxVideoReferences: 0,
    maxAudioReferences: 0,
    supportsFirstFrame: false,
    supportsLastFrame: false,
    supportsImageReference: true,
    supportsVideoReference: false,
    supportsAudioReference: false,
    supportsAudio: false,
    quantities: [1],
    aspectRatios: [...RATIOS],
    resolutions: [],
    durations: [...DURATIONS],
  };
}

function expectedSettings(evidence) {
  const modelCapabilities = capabilities(evidence.sha256);
  return {
    integration_contract: CONTRACT,
    upstream_model: UPSTREAM_MODEL,
    evidence_contract: EVIDENCE_VERSION,
    evidence_sha256: evidence.sha256,
    real_generation_verified_models: [PUBLIC_MODEL],
    canvas_capabilities_by_model: { [PUBLIC_MODEL]: modelCapabilities },
  };
}

function targetConfigs(db) {
  return db.prepare('SELECT * FROM ai_service_configs WHERE deleted_at IS NULL ORDER BY id').all()
    .filter((row) => parseModels(row.model).some((model) => model.toLowerCase() === PUBLIC_MODEL));
}

function assertUniqueSource(row) {
  if (!row) throw new Error('未找到唯一的现有灵境视频配置');
  if (row.service_type !== 'video'
      || JSON.stringify(parseModels(row.model)) !== JSON.stringify([PUBLIC_MODEL])
      || String(row.default_model || '').trim().toLowerCase() !== PUBLIC_MODEL) {
    throw new Error('现有灵境配置模型绑定已被管理员修改，禁止覆盖');
  }
  if (normalizeBaseUrl(row.base_url) !== OFFICIAL_BASE_URL) throw new Error('现有灵境配置 Base URL 与审核地址不一致');
  if (!String(row.api_key || '').trim()) throw new Error('现有灵境配置缺少可复用凭据');
  const hasTargetIdentity = row.provider === 'lingjing' || row.api_protocol === 'lingjing_open';
  if (!hasTargetIdentity && (row.provider !== 'xai' || row.api_protocol !== 'xai' || Number(row.is_active) !== 0)) {
    throw new Error('现有灵境配置来源或启用状态已被管理员修改，禁止覆盖');
  }
}

function pricingSnapshot(db) {
  return {
    base: db.prepare('SELECT * FROM model_credit_prices WHERE model = ? COLLATE NOCASE').get(PUBLIC_MODEL),
    tiers: db.prepare('SELECT * FROM model_resolution_prices WHERE model = ? COLLATE NOCASE ORDER BY resolution').all(PUBLIC_MODEL),
  };
}

function assertCommonPrice(row) {
  if (!row || row.category !== 'video' || row.status !== 'enabled'
      || row.billing_unit !== 'second' || row.cost_unit !== 'second'
      || !Number.isSafeInteger(Number(row.credits)) || Number(row.credits) <= 0
      || !Number.isSafeInteger(Number(row.cost_micros_per_unit)) || Number(row.cost_micros_per_unit) <= 0) {
    throw new Error('灵境模型必须使用已启用的按秒积分价格和正成本');
  }
}

function assertLegacyPricing(snapshot) {
  assertCommonPrice(snapshot?.base);
  const tiers = (snapshot?.tiers || []).map((row) => ({
    model: String(row.model || '').toLowerCase(),
    resolution: String(row.resolution || '').toLowerCase(),
    credits: Number(row.credits),
    cost_micros_per_second: Number(row.cost_micros_per_second),
  }));
  const expectedTiers = [
    { model: PUBLIC_MODEL, resolution: '480p', credits: 69, cost_micros_per_second: 180000 },
    { model: PUBLIC_MODEL, resolution: '720p', credits: 60, cost_micros_per_second: 180000 },
  ];
  if (Number(snapshot.base.credits) !== LEGACY_CREDITS_PER_SECOND
      || Number(snapshot.base.cost_micros_per_unit) !== LEGACY_COST_MICROS_PER_SECOND
      || JSON.stringify(tiers) !== JSON.stringify(expectedTiers)) {
    throw new Error('灵境旧价格或分辨率分档已被管理员修改，禁止覆盖');
  }
  return snapshot;
}

function assertTargetPricing(snapshot) {
  assertCommonPrice(snapshot?.base);
  if (snapshot.base.display_name !== TARGET_NAME
      || snapshot.base.public_note !== TARGET_PUBLIC_NOTE
      || Number(snapshot.base.credits) !== TARGET_CREDITS_PER_SECOND
      || Number(snapshot.base.cost_micros_per_unit) !== TARGET_COST_MICROS_PER_SECOND
      || (snapshot.tiers || []).length !== 0) {
    throw new Error('灵境目标按秒价格与已审核合同不一致');
  }
  return snapshot;
}

function assertTargetConfig(row, evidence) {
  if (!row) throw new Error('灵境目标配置不存在');
  const expectedCaps = { [PUBLIC_MODEL]: capabilities(evidence.sha256) };
  if (row.service_type !== 'video' || row.provider !== 'lingjing' || row.api_protocol !== 'lingjing_open'
      || row.name !== TARGET_NAME || normalizeBaseUrl(row.base_url) !== OFFICIAL_BASE_URL
      || JSON.stringify(parseModels(row.model)) !== JSON.stringify([PUBLIC_MODEL])
      || row.default_model !== PUBLIC_MODEL || row.endpoint !== '/videos'
      || row.query_endpoint !== '/videos/{taskId}' || Number(row.is_active) !== 1
      || row.verification_status !== 'verified' || !String(row.api_key || '').trim()
      || JSON.stringify(parseJson(row.verified_capabilities)) !== JSON.stringify(expectedCaps)
      || JSON.stringify(parseJson(row.settings)) !== JSON.stringify(expectedSettings(evidence))) {
    throw new Error('灵境配置与已审查目标不一致，禁止覆盖');
  }
}

function planConfiguration(db, evidence) {
  const rows = targetConfigs(db);
  if (rows.length !== 1) throw new Error(`现有灵境配置数量必须为 1，实际为 ${rows.length}`);
  const row = rows[0];
  assertUniqueSource(row);
  const targetIdentity = row.provider === 'lingjing' || row.api_protocol === 'lingjing_open';
  if (targetIdentity) {
    assertTargetConfig(row, evidence);
    const pricing = assertTargetPricing(pricingSnapshot(db));
    return { operation: 'noop', configId: row.id, price: { model: pricing.base.model, credits: pricing.base.credits, cost_micros_per_unit: pricing.base.cost_micros_per_unit } };
  }
  const pricing = assertLegacyPricing(pricingSnapshot(db));
  return { operation: 'upgrade', configId: row.id, price: { model: pricing.base.model, credits: pricing.base.credits, cost_micros_per_unit: pricing.base.cost_micros_per_unit } };
}

function verifyConfiguration(db, evidence) {
  const plan = planConfiguration(db, evidence);
  if (plan.operation !== 'noop') throw new Error('灵境配置尚未升级到已验证目标');
  return { ok: true, configId: plan.configId };
}

function beforeSnapshot(row) {
  return Object.fromEntries([
    'provider', 'api_protocol', 'name', 'base_url', 'model', 'default_model', 'endpoint', 'query_endpoint',
    'verification_status', 'verification_checked_at', 'verified_capabilities', 'verified_at',
    'verification_error', 'settings', 'is_active', 'updated_at',
  ].map((key) => [key, row[key]]));
}

async function applyConfiguration(db, evidence, options = {}) {
  const plan = planConfiguration(db, evidence);
  if (plan.operation === 'noop') return { updated: false, configId: plan.configId };
  if (!options.backupPath || !path.isAbsolute(options.backupPath) || fs.existsSync(options.backupPath)) {
    throw new Error('应用前必须指定尚不存在的绝对数据库备份路径');
  }
  if (!options.receiptPath || !path.isAbsolute(options.receiptPath) || fs.existsSync(options.receiptPath)) {
    throw new Error('应用前必须指定尚不存在的绝对事务回执路径');
  }
  const row = targetConfigs(db)[0];
  const pricingBefore = assertLegacyPricing(pricingSnapshot(db));
  await db.backup(options.backupPath);
  const appliedAt = new Date().toISOString();
  const settings = expectedSettings(evidence);
  const verified = { [PUBLIC_MODEL]: capabilities(evidence.sha256) };
  const receipt = {
    contract: CONTRACT,
    operation: 'updated',
    applied_at: appliedAt,
    database_backup: options.backupPath,
    evidence_sha256: evidence.sha256,
    evidence_generated_at: evidence.generatedAt,
    config_id: row.id,
    config_updated_at: appliedAt,
    api_key_sha256: sha256(String(row.api_key)),
    pricing_before: pricingBefore,
    before: beforeSnapshot(row),
  };
  try {
    db.transaction(() => {
      const changed = db.prepare(`UPDATE ai_service_configs SET
        provider = 'lingjing', api_protocol = 'lingjing_open', name = ?, base_url = ?,
        model = ?, default_model = ?, endpoint = '/videos', query_endpoint = '/videos/{taskId}',
        verification_status = 'verified', verification_checked_at = ?, verified_capabilities = ?,
        verified_at = ?, verification_error = NULL, settings = ?, is_active = 1, updated_at = ?
        WHERE id = ? AND updated_at = ? AND api_key = ?`).run(
        TARGET_NAME, OFFICIAL_BASE_URL, JSON.stringify([PUBLIC_MODEL]), PUBLIC_MODEL,
        evidence.generatedAt, JSON.stringify(verified), evidence.generatedAt,
        JSON.stringify(settings), appliedAt, row.id, row.updated_at, row.api_key,
      );
      if (changed.changes !== 1) throw new Error('灵境配置在应用前已发生变化，禁止覆盖');
      const priceChanged = db.prepare(`UPDATE model_credit_prices SET
        display_name = ?, public_note = ?, credits = ?, cost_micros_per_unit = ?, updated_at = ?
        WHERE model = ? COLLATE NOCASE AND updated_at = ? AND category = 'video' AND status = 'enabled'
          AND billing_unit = 'second' AND cost_unit = 'second' AND credits = ? AND cost_micros_per_unit = ?`).run(
        TARGET_NAME, TARGET_PUBLIC_NOTE, TARGET_CREDITS_PER_SECOND, TARGET_COST_MICROS_PER_SECOND, appliedAt,
        PUBLIC_MODEL, pricingBefore.base.updated_at, LEGACY_CREDITS_PER_SECOND, LEGACY_COST_MICROS_PER_SECOND,
      );
      if (priceChanged.changes !== 1) throw new Error('灵境价格在应用前已发生变化，禁止覆盖');
      const tiersDeleted = db.prepare('DELETE FROM model_resolution_prices WHERE model = ? COLLATE NOCASE').run(PUBLIC_MODEL);
      if (tiersDeleted.changes !== pricingBefore.tiers.length) throw new Error('灵境分辨率价格在应用前已发生变化，禁止覆盖');
      writeJsonAtomic(options.receiptPath, receipt);
    })();
  } catch (error) {
    fs.rmSync(options.receiptPath, { force: true });
    throw error;
  }
  verifyConfiguration(db, evidence);
  assertTargetPricing(pricingSnapshot(db));
  return { updated: true, configId: row.id, backupPath: options.backupPath, receiptPath: options.receiptPath };
}

function rollbackConfiguration(db, receiptPath) {
  const receipt = readJson(receiptPath);
  if (receipt.contract !== CONTRACT || receipt.operation !== 'updated'
      || !/^[a-f0-9]{64}$/.test(String(receipt.evidence_sha256 || ''))) {
    throw new Error('灵境配置事务回执不匹配');
  }
  const row = db.prepare('SELECT * FROM ai_service_configs WHERE id = ? AND deleted_at IS NULL').get(Number(receipt.config_id));
  if (parseJson(row?.settings).evidence_sha256 !== receipt.evidence_sha256) {
    throw new Error('灵境配置事务回执与当前证据绑定不匹配');
  }
  const evidence = { sha256: receipt.evidence_sha256, generatedAt: receipt.evidence_generated_at };
  try { assertTargetConfig(row, evidence); } catch (_) { throw new Error('灵境配置已被修改，禁止自动回滚'); }
  let pricingBefore;
  try { pricingBefore = assertLegacyPricing(receipt.pricing_before); } catch (_) { throw new Error('灵境配置事务回执中的旧价格不匹配'); }
  const pricingAfter = assertTargetPricing(pricingSnapshot(db));
  if (row.updated_at !== receipt.config_updated_at
      || sha256(String(row.api_key || '')) !== receipt.api_key_sha256
      || pricingAfter.base.updated_at !== receipt.config_updated_at) {
    throw new Error('灵境配置或管理员价格已被修改，禁止自动回滚');
  }
  const before = receipt.before || {};
  db.transaction(() => {
    const changed = db.prepare(`UPDATE ai_service_configs SET
      provider = ?, api_protocol = ?, name = ?, base_url = ?, model = ?, default_model = ?,
      endpoint = ?, query_endpoint = ?, verification_status = ?, verification_checked_at = ?,
      verified_capabilities = ?, verified_at = ?, verification_error = ?, settings = ?, is_active = ?, updated_at = ?
      WHERE id = ? AND updated_at = ?`).run(
      before.provider, before.api_protocol, before.name, before.base_url, before.model, before.default_model,
      before.endpoint, before.query_endpoint, before.verification_status, before.verification_checked_at,
      before.verified_capabilities, before.verified_at, before.verification_error, before.settings,
      before.is_active, before.updated_at, row.id, row.updated_at,
    );
    if (changed.changes !== 1) throw new Error('灵境配置回滚时发生并发修改');
    const old = pricingBefore.base;
    const restoredPrice = db.prepare(`UPDATE model_credit_prices SET
      display_name = ?, public_note = ?, category = ?, credits = ?, status = ?, billing_unit = ?, cost_unit = ?,
      cost_micros_per_unit = ?, input_cost_micros_per_1k = ?, output_cost_micros_per_1k = ?,
      updated_at = ? WHERE model = ? COLLATE NOCASE AND updated_at = ?`).run(
      old.display_name, old.public_note, old.category, old.credits, old.status, old.billing_unit, old.cost_unit,
      old.cost_micros_per_unit, old.input_cost_micros_per_1k, old.output_cost_micros_per_1k,
      old.updated_at, PUBLIC_MODEL, pricingAfter.base.updated_at,
    );
    if (restoredPrice.changes !== 1) throw new Error('灵境价格回滚时发生并发修改');
    const insertTier = db.prepare(`INSERT INTO model_resolution_prices
      (model, resolution, credits, cost_micros_per_second, updated_at) VALUES (?, ?, ?, ?, ?)`);
    for (const tier of pricingBefore.tiers) {
      insertTier.run(tier.model, tier.resolution, tier.credits, tier.cost_micros_per_second, tier.updated_at);
    }
  })();
  return { restored: true, configId: row.id };
}

function args(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = String(argv[index] || '').replace(/^--/, '');
    if (!key || argv[index + 1] == null) throw new Error('参数必须使用 --name value');
    output[key] = argv[index + 1];
  }
  return output;
}

async function main(argv = process.argv.slice(2)) {
  const options = args(argv);
  const mode = String(options.mode || 'plan');
  if (!['plan', 'apply', 'verify', 'rollback'].includes(mode)) throw new Error('mode 必须是 plan/apply/verify/rollback');
  if (!options.database || !path.isAbsolute(options.database)) throw new Error('--database 必须是绝对路径');
  const db = new Database(options.database);
  try {
    if (mode === 'rollback') {
      if (!options.receipt || !path.isAbsolute(options.receipt)) throw new Error('--receipt 必须是绝对路径');
      process.stdout.write(`${JSON.stringify(rollbackConfiguration(db, options.receipt))}\n`);
      return;
    }
    if (!options.evidence || !path.isAbsolute(options.evidence)
        || !options['public-dir'] || !path.isAbsolute(options['public-dir'])) {
      throw new Error('--evidence 与 --public-dir 必须是绝对路径');
    }
    const evidence = loadVerifiedEvidence(options.evidence, options['public-dir']);
    const result = mode === 'apply'
      ? await applyConfiguration(db, evidence, { backupPath: options.backup, receiptPath: options.receipt })
      : mode === 'verify' ? verifyConfiguration(db, evidence) : planConfiguration(db, evidence);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { db.close(); }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`LINGJING_CONFIG_TRANSACTION_FAILED: ${String(error.message || error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  CONTRACT,
  applyConfiguration,
  capabilities,
  loadVerifiedEvidence,
  planConfiguration,
  rollbackConfiguration,
  verifyConfiguration,
};
