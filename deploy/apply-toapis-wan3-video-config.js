'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require(require.resolve('better-sqlite3', {
  paths: [path.join(__dirname, '..', 'backend-node')],
}));
const { TOAPIS_WAN3_SPEC } = require('../backend-node/src/services/toapisWan3VideoClient');

const CONTRACT = 'toapis-wan3-video-config-v1';
const EVIDENCE_CONTRACT = 'toapis-wan3-video-real-verification-v1';
const MODEL = 'wan3.0-video';
const BASE_URL = 'https://toapis.cn';
const ENDPOINT = '/v1/videos/generations';
const QUERY_ENDPOINT = '/v1/videos/generations/{taskId}';
const DISPLAY_NAME = 'ToAPIs Wan 3.0';
const PUBLIC_NOTE = '支持 480P/720P/1080P、2-30 秒、有声或静音、首尾帧，以及最多 10 张图片、5 个视频、5 个音频参考';
const LEGACY_DISPLAY_NAME = 'ToAPIs Wan 3.0（480P 2 秒静音）';
const LEGACY_PUBLIC_NOTE = '仅支持纯文本生成：480P、2 秒、16:9、静音；不支持图片、视频或音频参考';
const RESOLUTIONS = TOAPIS_WAN3_SPEC.resolutions;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
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

function positiveInteger(value, label) {
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value.trim())) {
    throw new Error(`${label}必须是正整数`);
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${label}必须是正整数`);
  return result;
}

function timestamp(value = new Date()) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('操作时间无效');
  return parsed.toISOString();
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function requireNewAbsolutePath(value, label) {
  if (!value || !path.isAbsolute(value) || fs.existsSync(value)) {
    throw new Error(`${label}必须是尚不存在的绝对路径`);
  }
  return value;
}

function credentialFingerprint(apiKey) {
  return sha256(String(apiKey || ''));
}

function targetConfigFingerprint(row) {
  return sha256(JSON.stringify({
    id: String(row.id),
    provider: 'toapis_wan3',
    model: MODEL,
    base_url: BASE_URL,
    api_key: String(row.api_key || ''),
  }));
}

function sourceConfig(db, sourceConfigIdValue) {
  const sourceConfigId = positiveInteger(sourceConfigIdValue, '来源配置 ID');
  const row = db.prepare('SELECT * FROM ai_service_configs WHERE id = ? AND deleted_at IS NULL').get(sourceConfigId);
  if (!row) throw new Error('未找到 ToAPIs 来源配置');
  if (row.service_type !== 'video' || row.api_protocol !== 'toapis_video'
      || !['toapis', 'toapis_video'].includes(String(row.provider || '').trim().toLowerCase())
      || !String(row.api_key || '').trim()) {
    throw new Error('来源配置不是可复用凭据的 ToAPIs 视频配置');
  }
  return row;
}

function evidenceSourceConfig(db, values) {
  if (values.sourceConfigId !== values.targetConfigId) return sourceConfig(db, values.sourceConfigId);
  const row = db.prepare('SELECT * FROM ai_service_configs WHERE id = ? AND deleted_at IS NULL')
    .get(values.sourceConfigId);
  if (!row || Number(row.is_active) !== 1 || row.verification_status !== 'verified') {
    throw new Error('Wan3 同配置 evidence 仅允许重绑已验证的活动目标配置');
  }
  return row;
}

function wan3Rows(db) {
  return db.prepare('SELECT * FROM ai_service_configs WHERE deleted_at IS NULL ORDER BY id').all()
    .filter((row) => String(row.logical_model_id || '').trim().toLowerCase() === MODEL
      || String(row.default_model || '').trim().toLowerCase() === MODEL
      || parseModels(row.model).some((item) => item.toLowerCase() === MODEL));
}

function assertTargetIdentity(row, source, options = {}) {
  if (!row) throw new Error('Wan3 目标配置不存在');
  const allowedNames = options.allowLegacyName ? [DISPLAY_NAME, LEGACY_DISPLAY_NAME] : [DISPLAY_NAME];
  if (row.service_type !== 'video' || row.provider !== 'toapis_wan3'
      || row.api_protocol !== 'toapis_wan3_video' || !allowedNames.includes(row.name)
      || String(row.base_url || '').replace(/\/+$/, '') !== BASE_URL
      || JSON.stringify(parseModels(row.model)) !== JSON.stringify([MODEL])
      || row.default_model !== MODEL || row.logical_model_id !== MODEL
      || row.endpoint !== ENDPOINT || row.query_endpoint !== QUERY_ENDPOINT
      || Number(row.is_default) !== 0 || Number(row.failover_enabled) !== 0
      || String(row.api_key || '') !== String(source.api_key || '')) {
    throw new Error('Wan3 目标配置身份或凭据已漂移，禁止覆盖');
  }
}

function preparedSettings(sourceConfigId, targetConfigId, fingerprint) {
  return {
    integration_contract: CONTRACT,
    phase: 'prepared',
    source_config_id: sourceConfigId,
    target_config_id: targetConfigId,
    credential_fingerprint: fingerprint,
    upstream_model: MODEL,
  };
}

function preparedTarget(db, source) {
  const rows = wan3Rows(db);
  if (rows.length > 1) throw new Error(`Wan3 逻辑模型配置冲突：实际 ${rows.length} 条`);
  if (!rows.length) return null;
  const row = rows[0];
  assertTargetIdentity(row, source);
  const settings = parseJson(row.settings);
  if (Number(row.is_active) === 1 && row.verification_status === 'verified') return row;
  if (Number(row.is_active) !== 0 || row.verification_status !== 'unverified'
      || Number(row.canary_paused) !== 1
      || JSON.stringify(settings) !== JSON.stringify(preparedSettings(
        Number(source.id), Number(row.id), credentialFingerprint(source.api_key),
      ))) {
    throw new Error('Wan3 已有配置不是受保护的 prepared 状态，禁止覆盖');
  }
  return row;
}

function exactEvidenceCapabilities(value) {
  const expected = {
    model: MODEL,
    text_to_video: true,
    resolutions: ['480p'],
    durations: [2],
    ratios: ['16:9'],
    audio_values: [false],
  };
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error('Wan3 正式证据能力超出 480P/2 秒/16:9/静音纯文本范围');
  }
  return expected;
}

function loadFinalizeEvidence(evidencePath) {
  if (!evidencePath || !path.isAbsolute(evidencePath)) throw new Error('正式证据必须使用绝对路径');
  const bytes = fs.readFileSync(evidencePath);
  const payload = JSON.parse(bytes.toString('utf8'));
  if (payload.contract_version !== EVIDENCE_CONTRACT || payload.provider_origin !== BASE_URL) {
    throw new Error('Wan3 正式 evidence 合同或供应商来源不匹配');
  }
  const generatedAt = timestamp(payload.generated_at);
  if (!Array.isArray(payload.results) || payload.results.length !== 1) {
    throw new Error('Wan3 正式 evidence 必须只包含一次已完成生成');
  }
  const result = payload.results[0];
  if (result.model !== MODEL || result.status !== 'completed' || result.submission_state !== 'accepted'
      || result.mode !== 't2v' || result.requested_resolution !== '480p'
      || result.requested_ratio !== '16:9' || Number(result.requested_duration) !== 2
      || result.requested_audio !== false || Number(result.post_count) !== 1) {
    throw new Error('Wan3 正式 evidence 的真实生成案例不匹配');
  }
  const request = result.request;
  if (!request || request.model !== MODEL || !String(request.prompt || '').trim()
      || Number(request.duration) !== 2 || request.ratio !== '16:9'
      || request.resolution !== '480p' || request.audio !== false
      || ['image_with_roles', 'reference_images', 'video_list', 'audio_with_roles']
        .some((key) => Object.hasOwn(request, key))) {
    throw new Error('Wan3 正式 evidence 的请求不是无参考、静音纯文本生成');
  }
  const sourceConfigId = positiveInteger(result.source_config_id, '证据来源配置 ID');
  const targetConfigId = positiveInteger(result.target_config_id, '证据目标配置 ID');
  if (Number(result.config_id) !== targetConfigId) throw new Error('Wan3 evidence config_id 未绑定目标配置');
  if (!/^[a-f0-9]{64}$/.test(String(result.credential_fingerprint || ''))
      || !/^[a-f0-9]{64}$/.test(String(result.config_fingerprint || ''))) {
    throw new Error('Wan3 evidence 凭据或目标配置指纹无效');
  }
  exactEvidenceCapabilities(payload.verified_capabilities);
  return {
    payload,
    result,
    sha256: sha256(bytes),
    generatedAt,
    sourceConfigId,
    targetConfigId,
  };
}

function runtimeCapabilities(evidenceSha) {
  return {
    durations: [...TOAPIS_WAN3_SPEC.durations],
    resolutions: [...RESOLUTIONS],
    aspectRatios: [...TOAPIS_WAN3_SPEC.aspectRatios],
    audio_values: [false, true],
    referenceTypes: ['image', 'video', 'audio'],
    maxReferences: TOAPIS_WAN3_SPEC.maxReferences,
    maxImageReferences: TOAPIS_WAN3_SPEC.maxReferences,
    maxVideoReferences: TOAPIS_WAN3_SPEC.maxVideoReferences,
    maxAudioReferences: TOAPIS_WAN3_SPEC.maxAudioReferences,
    supportsFirstFrame: TOAPIS_WAN3_SPEC.supportsFirstFrame,
    supportsLastFrame: TOAPIS_WAN3_SPEC.supportsLastFrame,
    supportsImageReference: TOAPIS_WAN3_SPEC.supportsImageReference,
    supportsVideoReference: TOAPIS_WAN3_SPEC.supportsVideoReference,
    supportsAudioReference: TOAPIS_WAN3_SPEC.supportsAudioReference,
    supportsAudio: TOAPIS_WAN3_SPEC.supportsAudio,
    quantities: [1],
    evidence_contract: EVIDENCE_CONTRACT,
    evidence_sha256: evidenceSha,
  };
}

function legacyRuntimeCapabilities(evidenceSha) {
  return {
    durations: [2], resolutions: ['480p'], aspectRatios: ['16:9'], audio_values: [false],
    referenceTypes: [], maxReferences: 0, maxImageReferences: 0, maxVideoReferences: 0,
    maxAudioReferences: 0, supportsFirstFrame: false, supportsLastFrame: false,
    supportsImageReference: false, supportsVideoReference: false, supportsAudioReference: false,
    supportsAudio: false, quantities: [1], evidence_contract: EVIDENCE_CONTRACT,
    evidence_sha256: evidenceSha,
  };
}

function settingsForCapabilities(evidence, capabilities) {
  const fingerprint = evidence.result.credential_fingerprint;
  return {
    integration_contract: CONTRACT,
    phase: 'verified',
    source_config_id: evidence.sourceConfigId,
    target_config_id: evidence.targetConfigId,
    credential_fingerprint: fingerprint,
    config_fingerprint: evidence.result.config_fingerprint,
    upstream_model: MODEL,
    evidence_contract: EVIDENCE_CONTRACT,
    evidence_sha256: evidence.sha256,
    real_generation_verified_models: [MODEL],
    canvas_capabilities_by_model: { [MODEL]: capabilities },
  };
}

function finalSettings(evidence) {
  return settingsForCapabilities(evidence, runtimeCapabilities(evidence.sha256));
}

function legacyFinalSettings(evidence) {
  return settingsForCapabilities(evidence, legacyRuntimeCapabilities(evidence.sha256));
}

function verificationEvidence(evidence) {
  return {
    evidence_contract: EVIDENCE_CONTRACT,
    evidence_sha256: evidence.sha256,
    source_config_id: evidence.sourceConfigId,
    target_config_id: evidence.targetConfigId,
    credential_fingerprint: evidence.result.credential_fingerprint,
    config_fingerprint: evidence.result.config_fingerprint,
  };
}

function pricingSnapshot(db) {
  return {
    base: db.prepare('SELECT * FROM model_credit_prices WHERE model = ? COLLATE NOCASE').get(MODEL),
    tiers: db.prepare('SELECT * FROM model_resolution_prices WHERE model = ? COLLATE NOCASE ORDER BY resolution').all(MODEL),
  };
}

function routeCostSnapshot(db, configId) {
  const base = db.prepare('SELECT * FROM provider_route_costs WHERE config_id = ?').get(configId);
  const tiers = db.prepare('SELECT * FROM provider_route_resolution_costs WHERE config_id = ? ORDER BY resolution').all(configId);
  return { base, tiers };
}

function finalizeInputs(options) {
  return {
    sourceConfigId: positiveInteger(options.sourceConfigId, '来源配置 ID'),
    targetConfigId: positiveInteger(options.targetConfigId, '目标配置 ID'),
    userCreditsPerSecond: positiveInteger(options.userCreditsPerSecond, '用户积分价格'),
    modelCostMicrosPerSecond: positiveInteger(options.modelCostMicrosPerSecond, '模型成本'),
    routeCostMicrosPerSecond: positiveInteger(options.routeCostMicrosPerSecond, '线路成本'),
  };
}

function assertEvidenceBinding(source, target, evidence, values, options = {}) {
  assertTargetIdentity(target, source, options);
  if (evidence.sourceConfigId !== values.sourceConfigId || evidence.targetConfigId !== values.targetConfigId
      || Number(source.id) !== values.sourceConfigId || Number(target.id) !== values.targetConfigId) {
    throw new Error('Wan3 evidence 的来源或目标配置绑定不匹配');
  }
  const expectedCredential = credentialFingerprint(source.api_key);
  if (String(target.api_key || '') !== String(source.api_key || '')
      || evidence.result.credential_fingerprint !== expectedCredential) {
    throw new Error('Wan3 evidence 凭据指纹与来源/目标配置不匹配');
  }
  if (evidence.result.config_fingerprint !== targetConfigFingerprint(target)) {
    throw new Error('Wan3 evidence 目标配置指纹不匹配');
  }
}

function expectedPrice(values) {
  return {
    credits: values.userCreditsPerSecond,
    cost: values.modelCostMicrosPerSecond,
  };
}

function assertExactPrice(snapshot, values) {
  const expected = expectedPrice(values);
  const base = snapshot.base;
  const tiers = new Map(snapshot.tiers.map((tier) => [String(tier.resolution).toLowerCase(), tier]));
  if (!base || base.model !== MODEL || base.display_name !== DISPLAY_NAME || base.public_note !== PUBLIC_NOTE
      || base.category !== 'video' || base.status !== 'enabled' || base.pricing_mode !== 'paid'
      || base.billing_unit !== 'second' || base.cost_unit !== 'second'
      || Number(base.credits) !== expected.credits || Number(base.cost_micros_per_unit) !== expected.cost
      || Number(base.input_cost_micros_per_1k) !== 0 || Number(base.output_cost_micros_per_1k) !== 0
      || tiers.size !== RESOLUTIONS.length
      || !RESOLUTIONS.every((resolution) => (
        Number(tiers.get(resolution)?.credits) === expected.credits
        && Number(tiers.get(resolution)?.cost_micros_per_second) === expected.cost
      ))) {
    throw new Error('Wan3 用户积分或模型成本与获批参数不一致');
  }
}

function assertExactRouteCost(snapshot, values) {
  const base = snapshot.base;
  const tiers = new Map(snapshot.tiers.map((tier) => [String(tier.resolution).toLowerCase(), tier]));
  if (!base || base.currency !== 'CNY' || base.cost_unit !== 'second'
      || Number(base.micros_per_unit) !== values.routeCostMicrosPerSecond
      || Number(base.input_cost_micros_per_1k) !== 0 || Number(base.output_cost_micros_per_1k) !== 0
      || tiers.size !== RESOLUTIONS.length
      || !RESOLUTIONS.every((resolution) => (
        Number(tiers.get(resolution)?.micros_per_unit) === values.routeCostMicrosPerSecond
      ))) {
    throw new Error('Wan3 独立线路成本与获批参数不一致');
  }
}

function assertLegacyPrice(snapshot, values) {
  const expected = expectedPrice(values);
  const base = snapshot.base;
  const tiers = new Map(snapshot.tiers.map((tier) => [String(tier.resolution).toLowerCase(), tier]));
  const tier = tiers.get('480p');
  if (!base || base.model !== MODEL || base.display_name !== LEGACY_DISPLAY_NAME
      || base.public_note !== LEGACY_PUBLIC_NOTE || base.category !== 'video'
      || base.status !== 'enabled' || base.pricing_mode !== 'paid'
      || base.billing_unit !== 'second' || base.cost_unit !== 'second'
      || Number(base.credits) !== expected.credits || Number(base.cost_micros_per_unit) !== expected.cost
      || Number(base.input_cost_micros_per_1k) !== 0 || Number(base.output_cost_micros_per_1k) !== 0
      || tiers.size !== 1 || !tier
      || Number(tier.credits) !== expected.credits
      || Number(tier.cost_micros_per_second) !== expected.cost) {
    throw new Error('Wan3 现有价格不是允许原位升级的精确旧合同');
  }
}

function assertLegacyRouteCost(snapshot, values) {
  const base = snapshot.base;
  const tiers = new Map(snapshot.tiers.map((tier) => [String(tier.resolution).toLowerCase(), tier]));
  const tier = tiers.get('480p');
  if (!base || base.currency !== 'CNY' || base.cost_unit !== 'second'
      || Number(base.micros_per_unit) !== values.routeCostMicrosPerSecond
      || Number(base.input_cost_micros_per_1k) !== 0 || Number(base.output_cost_micros_per_1k) !== 0
      || tiers.size !== 1 || !tier
      || Number(tier.micros_per_unit) !== values.routeCostMicrosPerSecond) {
    throw new Error('Wan3 现有线路成本不是允许原位升级的精确旧合同');
  }
}

function assertLegacyConfiguration(db, source, target, evidence, values) {
  assertEvidenceBinding(source, target, evidence, values, { allowLegacyName: true });
  const caps = { [MODEL]: legacyRuntimeCapabilities(evidence.sha256) };
  if (target.name !== LEGACY_DISPLAY_NAME || Number(target.is_active) !== 1
      || target.verification_status !== 'verified' || Number(target.canary_paused) !== 0
      || target.verification_error != null
      || JSON.stringify(parseJson(target.verified_capabilities)) !== JSON.stringify(caps)
      || JSON.stringify(parseJson(target.settings)) !== JSON.stringify(legacyFinalSettings(evidence))
      || JSON.stringify(parseJson(target.verification_evidence)) !== JSON.stringify(verificationEvidence(evidence))) {
    throw new Error('Wan3 现有配置不是允许原位升级的精确旧合同');
  }
  assertLegacyPrice(pricingSnapshot(db), values);
  assertLegacyRouteCost(routeCostSnapshot(db, values.targetConfigId), values);
}

function assertRebindableConfiguration(db, target, values) {
  assertTargetIdentity(target, target);
  const settings = parseJson(target.settings);
  const verification = parseJson(target.verification_evidence);
  const previousEvidenceSha = String(settings.evidence_sha256 || '');
  const expectedCredential = credentialFingerprint(target.api_key);
  const expectedConfig = targetConfigFingerprint(target);
  const previousSourceConfigId = Number(settings.source_config_id);
  const expectedCapabilities = { [MODEL]: runtimeCapabilities(previousEvidenceSha) };
  if (Number(target.is_active) !== 1 || target.verification_status !== 'verified'
      || Number(target.canary_paused) !== 0 || target.verification_error != null
      || !Number.isSafeInteger(previousSourceConfigId) || previousSourceConfigId <= 0
      || !/^[a-f0-9]{64}$/.test(previousEvidenceSha)
      || settings.integration_contract !== CONTRACT || settings.phase !== 'verified'
      || Number(settings.target_config_id) !== values.targetConfigId
      || settings.credential_fingerprint !== expectedCredential
      || settings.config_fingerprint !== expectedConfig || settings.upstream_model !== MODEL
      || settings.evidence_contract !== EVIDENCE_CONTRACT
      || JSON.stringify(settings.real_generation_verified_models) !== JSON.stringify([MODEL])
      || JSON.stringify(settings.canvas_capabilities_by_model) !== JSON.stringify(expectedCapabilities)
      || verification.evidence_contract !== EVIDENCE_CONTRACT
      || verification.evidence_sha256 !== previousEvidenceSha
      || Number(verification.source_config_id) !== previousSourceConfigId
      || Number(verification.target_config_id) !== values.targetConfigId
      || verification.credential_fingerprint !== expectedCredential
      || verification.config_fingerprint !== expectedConfig
      || JSON.stringify(parseJson(target.verified_capabilities)) !== JSON.stringify(expectedCapabilities)) {
    throw new Error('Wan3 现有配置不是允许证据重绑的精确活动合同');
  }
  assertExactPrice(pricingSnapshot(db), values);
  assertExactRouteCost(routeCostSnapshot(db, values.targetConfigId), values);
}

async function rebindCurrentConfiguration(db, target, evidence, values, options) {
  assertRebindableConfiguration(db, target, values);
  assertEvidenceBinding(target, target, evidence, values);
  const previousVerifiedAt = Date.parse(String(target.verification_checked_at || target.verified_at || ''));
  if (!Number.isFinite(previousVerifiedAt) || Date.parse(evidence.generatedAt) <= previousVerifiedAt) {
    throw new Error('Wan3 同配置 evidence 时间不新于现有验证，禁止重绑旧证据');
  }
  const backupPath = requireNewAbsolutePath(options.backupPath, '数据库备份路径');
  const receiptPath = requireNewAbsolutePath(options.receiptPath, '事务回执路径');
  await db.backup(backupPath);
  const now = timestamp(options.now);
  const caps = { [MODEL]: runtimeCapabilities(evidence.sha256) };
  try {
    db.transaction(() => {
      const currentTarget = db.prepare('SELECT * FROM ai_service_configs WHERE id = ? AND deleted_at IS NULL')
        .get(values.targetConfigId);
      assertRebindableConfiguration(db, currentTarget, values);
      assertEvidenceBinding(currentTarget, currentTarget, evidence, values);
      const updated = db.prepare(`UPDATE ai_service_configs SET
        verification_checked_at = ?, verified_capabilities = ?, verified_at = ?,
        verification_error = NULL, settings = ?, verification_evidence = ?, updated_at = ?
        WHERE id = ? AND updated_at = ? AND api_key = ? AND settings = ?
          AND verification_evidence = ? AND verified_capabilities = ?
          AND is_active = 1 AND verification_status = 'verified' AND canary_paused = 0`)
        .run(
          evidence.generatedAt,
          JSON.stringify(caps),
          now,
          JSON.stringify(finalSettings(evidence)),
          JSON.stringify(verificationEvidence(evidence)),
          now,
          values.targetConfigId,
          currentTarget.updated_at,
          currentTarget.api_key,
          currentTarget.settings,
          currentTarget.verification_evidence,
          currentTarget.verified_capabilities,
        );
      if (updated.changes !== 1) throw new Error('Wan3 配置在证据重绑前发生变化');
      verifyConfiguration(db, evidence, values);
      writeJsonAtomic(receiptPath, {
        contract: CONTRACT,
        phase: 'rebind',
        applied_at: now,
        database_backup: backupPath,
        source_config_id: values.sourceConfigId,
        target_config_id: values.targetConfigId,
        evidence_contract: EVIDENCE_CONTRACT,
        evidence_sha256: evidence.sha256,
        credential_fingerprint: evidence.result.credential_fingerprint,
        config_fingerprint: evidence.result.config_fingerprint,
        user_credits_per_second: values.userCreditsPerSecond,
        model_cost_micros_per_second: values.modelCostMicrosPerSecond,
        route_cost_micros_per_second: values.routeCostMicrosPerSecond,
      });
    })();
  } catch (error) {
    fs.rmSync(receiptPath, { force: true });
    throw error;
  }
  verifyConfiguration(db, evidence, values);
  return {
    finalized: false,
    reused: false,
    rebound: true,
    configId: values.targetConfigId,
    backupPath,
    receiptPath,
  };
}

async function upgradeLegacyConfiguration(db, source, target, evidence, values, options) {
  assertLegacyConfiguration(db, source, target, evidence, values);
  const backupPath = requireNewAbsolutePath(options.backupPath, '数据库备份路径');
  const receiptPath = requireNewAbsolutePath(options.receiptPath, '事务回执路径');
  await db.backup(backupPath);
  const now = timestamp(options.now);
  const caps = { [MODEL]: runtimeCapabilities(evidence.sha256) };
  try {
    db.transaction(() => {
      const currentSource = sourceConfig(db, values.sourceConfigId);
      const currentTarget = db.prepare('SELECT * FROM ai_service_configs WHERE id = ? AND deleted_at IS NULL')
        .get(values.targetConfigId);
      assertLegacyConfiguration(db, currentSource, currentTarget, evidence, values);
      const priceChanged = db.prepare(`UPDATE model_credit_prices
        SET display_name = ?, public_note = ?, updated_at = ?
        WHERE model = ? COLLATE NOCASE AND display_name = ? AND public_note = ?`)
        .run(DISPLAY_NAME, PUBLIC_NOTE, now, MODEL, LEGACY_DISPLAY_NAME, LEGACY_PUBLIC_NOTE);
      if (priceChanged.changes !== 1) throw new Error('Wan3 旧价格在升级前发生变化');
      const insertResolutionPrice = db.prepare(`INSERT INTO model_resolution_prices
        (model, resolution, credits, cost_micros_per_second, updated_at) VALUES (?, ?, ?, ?, ?)`);
      for (const resolution of RESOLUTIONS.filter((item) => item !== '480p')) {
        insertResolutionPrice.run(MODEL, resolution, values.userCreditsPerSecond, values.modelCostMicrosPerSecond, now);
      }
      const insertRouteResolutionCost = db.prepare(`INSERT INTO provider_route_resolution_costs
        (config_id, resolution, micros_per_unit, updated_at) VALUES (?, ?, ?, ?)`);
      for (const resolution of RESOLUTIONS.filter((item) => item !== '480p')) {
        insertRouteResolutionCost.run(values.targetConfigId, resolution, values.routeCostMicrosPerSecond, now);
      }
      const updated = db.prepare(`UPDATE ai_service_configs SET
        name = ?, verification_checked_at = ?, verified_capabilities = ?, verified_at = ?,
        verification_error = NULL, settings = ?, verification_evidence = ?, updated_at = ?
        WHERE id = ? AND updated_at = ? AND name = ? AND is_active = 1
          AND verification_status = 'verified' AND api_key = ?`).run(
        DISPLAY_NAME,
        evidence.generatedAt,
        JSON.stringify(caps),
        now,
        JSON.stringify(finalSettings(evidence)),
        JSON.stringify(verificationEvidence(evidence)),
        now,
        values.targetConfigId,
        currentTarget.updated_at,
        LEGACY_DISPLAY_NAME,
        currentTarget.api_key,
      );
      if (updated.changes !== 1) throw new Error('Wan3 旧配置在升级前发生变化');
      verifyConfiguration(db, evidence, values);
      writeJsonAtomic(receiptPath, {
        contract: CONTRACT,
        phase: 'upgrade',
        applied_at: now,
        database_backup: backupPath,
        source_config_id: values.sourceConfigId,
        target_config_id: values.targetConfigId,
        evidence_contract: EVIDENCE_CONTRACT,
        evidence_sha256: evidence.sha256,
        credential_fingerprint: evidence.result.credential_fingerprint,
        config_fingerprint: evidence.result.config_fingerprint,
        user_credits_per_second: values.userCreditsPerSecond,
        model_cost_micros_per_second: values.modelCostMicrosPerSecond,
        route_cost_micros_per_second: values.routeCostMicrosPerSecond,
      });
    })();
  } catch (error) {
    fs.rmSync(receiptPath, { force: true });
    throw error;
  }
  verifyConfiguration(db, evidence, values);
  return {
    finalized: false,
    reused: false,
    upgraded: true,
    configId: values.targetConfigId,
    backupPath,
    receiptPath,
  };
}

function verifyConfiguration(db, evidence, options = {}) {
  const values = finalizeInputs(options);
  const source = evidenceSourceConfig(db, values);
  const target = db.prepare('SELECT * FROM ai_service_configs WHERE id = ? AND deleted_at IS NULL').get(values.targetConfigId);
  assertEvidenceBinding(source, target, evidence, values);
  const caps = { [MODEL]: runtimeCapabilities(evidence.sha256) };
  if (Number(target.is_active) !== 1 || target.verification_status !== 'verified'
      || Number(target.canary_paused) !== 0 || target.verification_error != null
      || JSON.stringify(parseJson(target.verified_capabilities)) !== JSON.stringify(caps)
      || JSON.stringify(parseJson(target.settings)) !== JSON.stringify(finalSettings(evidence))
      || JSON.stringify(parseJson(target.verification_evidence)) !== JSON.stringify(verificationEvidence(evidence))) {
    throw new Error('Wan3 目标配置尚未按正式 evidence 完成启用');
  }
  assertExactPrice(pricingSnapshot(db), values);
  assertExactRouteCost(routeCostSnapshot(db, values.targetConfigId), values);
  return { ok: true, configId: values.targetConfigId };
}

async function prepareConfiguration(db, options = {}) {
  const source = sourceConfig(db, options.sourceConfigId);
  const existing = preparedTarget(db, source);
  if (existing) {
    return {
      created: false,
      reused: true,
      configId: Number(existing.id),
      sourceConfigId: Number(source.id),
      state: Number(existing.is_active) === 1 ? 'verified' : 'prepared',
    };
  }
  const backupPath = requireNewAbsolutePath(options.backupPath, '数据库备份路径');
  const receiptPath = requireNewAbsolutePath(options.receiptPath, '事务回执路径');
  await db.backup(backupPath);
  const now = timestamp(options.now);
  const fingerprint = credentialFingerprint(source.api_key);
  let configId;
  try {
    db.transaction(() => {
      const conflict = preparedTarget(db, source);
      if (conflict) throw new Error('Wan3 配置在 prepare 期间发生冲突');
      configId = Number(db.prepare(`INSERT INTO ai_service_configs
        (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
         endpoint, query_endpoint, priority, is_default, is_active, verification_status,
         verification_checked_at, verified_capabilities, verified_at, verification_error,
         settings, logical_model_id, failover_enabled, verification_evidence, canary_paused,
         created_at, updated_at)
        VALUES ('video', 'toapis_wan3', 'toapis_wan3_video', ?, ?, ?, ?, ?, ?, ?, 0, 0, 0,
          'unverified', NULL, '{}', NULL, 'awaiting_target_bound_evidence', '{}', ?, 0, NULL, 1, ?, ?)`)
        .run(
          DISPLAY_NAME,
          BASE_URL,
          source.api_key,
          JSON.stringify([MODEL]),
          MODEL,
          ENDPOINT,
          QUERY_ENDPOINT,
          MODEL,
          now,
          now,
        ).lastInsertRowid);
      const settings = JSON.stringify(preparedSettings(Number(source.id), configId, fingerprint));
      const updated = db.prepare('UPDATE ai_service_configs SET settings = ? WHERE id = ? AND updated_at = ?')
        .run(settings, configId, now);
      if (updated.changes !== 1) throw new Error('Wan3 prepare 配置发生并发变化');
      writeJsonAtomic(receiptPath, {
        contract: CONTRACT,
        phase: 'prepare',
        applied_at: now,
        database_backup: backupPath,
        source_config_id: Number(source.id),
        target_config_id: configId,
        credential_fingerprint: fingerprint,
      });
    })();
  } catch (error) {
    fs.rmSync(receiptPath, { force: true });
    throw error;
  }
  const target = preparedTarget(db, source);
  if (!target || Number(target.id) !== configId) throw new Error('Wan3 prepare 后校验失败');
  return {
    created: true,
    reused: false,
    configId,
    sourceConfigId: Number(source.id),
    backupPath,
    receiptPath,
  };
}

async function finalizeConfiguration(db, evidence, options = {}) {
  exactEvidenceCapabilities(evidence?.payload?.verified_capabilities);
  const values = finalizeInputs(options);
  const source = evidenceSourceConfig(db, values);
  const target = db.prepare('SELECT * FROM ai_service_configs WHERE id = ? AND deleted_at IS NULL').get(values.targetConfigId);
  if (Number(target.is_active) === 1 && target.verification_status === 'verified') {
    if (target.name === LEGACY_DISPLAY_NAME) {
      return upgradeLegacyConfiguration(db, source, target, evidence, values, options);
    }
    assertEvidenceBinding(source, target, evidence, values);
    if (values.sourceConfigId === values.targetConfigId) {
      try {
        verifyConfiguration(db, evidence, values);
        return { finalized: false, reused: true, configId: values.targetConfigId };
      } catch (_) {
        return rebindCurrentConfiguration(db, target, evidence, values, options);
      }
    }
    verifyConfiguration(db, evidence, values);
    return { finalized: false, reused: true, configId: values.targetConfigId };
  }
  assertEvidenceBinding(source, target, evidence, values);
  preparedTarget(db, source);
  if (pricingSnapshot(db).base || pricingSnapshot(db).tiers.length) {
    throw new Error('Wan3 价格已存在或被管理员修改，禁止覆盖');
  }
  const existingRouteCost = routeCostSnapshot(db, values.targetConfigId);
  if (existingRouteCost.base || existingRouteCost.tiers.length) {
    throw new Error('Wan3 独立线路成本已存在或被管理员修改，禁止覆盖');
  }
  const backupPath = requireNewAbsolutePath(options.backupPath, '数据库备份路径');
  const receiptPath = requireNewAbsolutePath(options.receiptPath, '事务回执路径');
  await db.backup(backupPath);
  const now = timestamp(options.now);
  const caps = { [MODEL]: runtimeCapabilities(evidence.sha256) };
  try {
    db.transaction(() => {
      const currentTarget = db.prepare('SELECT * FROM ai_service_configs WHERE id = ? AND deleted_at IS NULL')
        .get(values.targetConfigId);
      assertEvidenceBinding(sourceConfig(db, values.sourceConfigId), currentTarget, evidence, values);
      if (pricingSnapshot(db).base || pricingSnapshot(db).tiers.length
          || routeCostSnapshot(db, values.targetConfigId).base
          || routeCostSnapshot(db, values.targetConfigId).tiers.length) {
        throw new Error('Wan3 价格或线路成本在 finalize 前发生变化');
      }
      db.prepare(`INSERT INTO model_credit_prices
        (model, display_name, public_note, category, credits, pricing_mode, status, billing_unit,
         cost_unit, cost_micros_per_unit, input_cost_micros_per_1k, output_cost_micros_per_1k, updated_at)
        VALUES (?, ?, ?, 'video', ?, 'paid', 'enabled', 'second', 'second', ?, 0, 0, ?)`)
        .run(MODEL, DISPLAY_NAME, PUBLIC_NOTE, values.userCreditsPerSecond, values.modelCostMicrosPerSecond, now);
      const insertResolutionPrice = db.prepare(`INSERT INTO model_resolution_prices
        (model, resolution, credits, cost_micros_per_second, updated_at) VALUES (?, ?, ?, ?, ?)`);
      for (const resolution of RESOLUTIONS) {
        insertResolutionPrice.run(MODEL, resolution, values.userCreditsPerSecond, values.modelCostMicrosPerSecond, now);
      }
      db.prepare(`INSERT INTO provider_route_costs
        (config_id, currency, cost_unit, micros_per_unit, input_cost_micros_per_1k,
         output_cost_micros_per_1k, updated_at) VALUES (?, 'CNY', 'second', ?, 0, 0, ?)`)
        .run(values.targetConfigId, values.routeCostMicrosPerSecond, now);
      const insertRouteResolutionCost = db.prepare(`INSERT INTO provider_route_resolution_costs
        (config_id, resolution, micros_per_unit, updated_at) VALUES (?, ?, ?, ?)`);
      for (const resolution of RESOLUTIONS) {
        insertRouteResolutionCost.run(values.targetConfigId, resolution, values.routeCostMicrosPerSecond, now);
      }
      const updated = db.prepare(`UPDATE ai_service_configs SET
        verification_status = 'verified', verification_checked_at = ?, verified_capabilities = ?,
        verified_at = ?, verification_error = NULL, settings = ?, verification_evidence = ?,
        canary_paused = 0, is_active = 1, updated_at = ?
        WHERE id = ? AND updated_at = ? AND is_active = 0 AND verification_status = 'unverified'
          AND api_key = ?`).run(
        evidence.generatedAt,
        JSON.stringify(caps),
        now,
        JSON.stringify(finalSettings(evidence)),
        JSON.stringify(verificationEvidence(evidence)),
        now,
        values.targetConfigId,
        currentTarget.updated_at,
        currentTarget.api_key,
      );
      if (updated.changes !== 1) throw new Error('Wan3 finalize 配置发生并发变化');
      verifyConfiguration(db, evidence, values);
      writeJsonAtomic(receiptPath, {
        contract: CONTRACT,
        phase: 'finalize',
        applied_at: now,
        database_backup: backupPath,
        source_config_id: values.sourceConfigId,
        target_config_id: values.targetConfigId,
        evidence_contract: EVIDENCE_CONTRACT,
        evidence_sha256: evidence.sha256,
        credential_fingerprint: evidence.result.credential_fingerprint,
        config_fingerprint: evidence.result.config_fingerprint,
        user_credits_per_second: values.userCreditsPerSecond,
        model_cost_micros_per_second: values.modelCostMicrosPerSecond,
        route_cost_micros_per_second: values.routeCostMicrosPerSecond,
      });
    })();
  } catch (error) {
    fs.rmSync(receiptPath, { force: true });
    throw error;
  }
  verifyConfiguration(db, evidence, values);
  return {
    finalized: true,
    reused: false,
    configId: values.targetConfigId,
    backupPath,
    receiptPath,
  };
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
  const mode = String(options.mode || '');
  if (!['prepare', 'finalize', 'verify'].includes(mode)) throw new Error('mode 必须是 prepare/finalize/verify');
  if (!options.database || !path.isAbsolute(options.database)) throw new Error('--database 必须是绝对路径');
  const db = new Database(options.database);
  try {
    if (mode === 'prepare') {
      const result = await prepareConfiguration(db, {
        sourceConfigId: options['source-config-id'],
        backupPath: options.backup,
        receiptPath: options.receipt,
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    const evidence = loadFinalizeEvidence(options.evidence);
    const values = {
      sourceConfigId: options['source-config-id'],
      targetConfigId: options['target-config-id'],
      userCreditsPerSecond: options['credits-per-second'],
      modelCostMicrosPerSecond: options['model-cost-micros-per-second'],
      routeCostMicrosPerSecond: options['route-cost-micros-per-second'],
      backupPath: options.backup,
      receiptPath: options.receipt,
    };
    const result = mode === 'finalize'
      ? await finalizeConfiguration(db, evidence, values)
      : verifyConfiguration(db, evidence, values);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`TOAPIS_WAN3_CONFIG_TRANSACTION_FAILED: ${String(error.message || error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  CONTRACT,
  EVIDENCE_CONTRACT,
  finalizeConfiguration,
  loadFinalizeEvidence,
  prepareConfiguration,
  verifyConfiguration,
};
