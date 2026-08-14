'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const response = require('../response');
const redrawService = require('../services/redrawService');
const redrawUploadService = require('../services/redrawUploadService');
const redrawCapabilityService = require('../services/redrawCapabilityService');
const redrawOrchestrator = require('../services/redrawOrchestrator');
const redrawLocalizationOrchestrator = require('../services/redrawLocalizationOrchestrator');
const redrawAssetService = require('../services/redrawAssetService');
const redrawReviewService = require('../services/redrawReviewService');
const redrawCharacterIdentityService = require('../services/redrawCharacterIdentityService');
const redrawShotService = require('../services/redrawShotService');
const redrawGenerationService = require('../services/redrawGenerationService');
const redrawBillingService = require('../services/redrawBillingService');
const redrawAssetBatchService = require('../services/redrawAssetBatchService');
const redrawDialogueOrchestrator = require('../services/redrawDialogueOrchestrator');
const redrawVoiceService = require('../services/redrawVoiceService');
const redrawCompositionService = require('../services/redrawCompositionService');
const redrawExportService = require('../services/redrawExportService');
const redrawNativeSourceAnalysisService = require('../services/redrawNativeSourceAnalysisService');
const assetService = require('../services/assetService');
const uploadServiceModule = require('../services/uploadService');

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      cb(null, `redraw-source-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 1024 * 1024 * 1024 },
});

const referenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, /^image\/(png|jpe?g|webp)$/i.test(String(file.mimetype || '')));
  },
});

const ALLOWED_ASPECT_RATIOS = new Set(['1:1', '9:16', '16:9', '3:4', '4:3', '21:9']);

function parseJSON(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function owner(req) {
  return {
    tenantId: req.tenant?.id == null ? null : String(req.tenant.id),
    userId: req.user?.id == null ? null : String(req.user.id),
  };
}

function numericId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function storageRootFromConfig(cfg = {}) {
  const raw = cfg?.storage?.local_path || './data/storage';
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

function safeStoragePath(storageRoot, localPath) {
  if (!localPath || path.isAbsolute(String(localPath))) return null;
  const root = path.resolve(storageRoot);
  const target = path.resolve(root, String(localPath));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return target;
}

function createCanReadArtifact(db, cfg) {
  const reader = redrawOrchestrator.createAssetReader({ storageRoot: storageRootFromConfig(cfg) });
  return (assetId) => {
    const row = db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(assetId);
    return reader.canRead(row);
  };
}

function sanitizeExportValue(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^(?:[a-zA-Z]:[\\/]|\/|\\\\|file:\/\/|https?:\/\/)/i.test(trimmed)) return undefined;
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitizeExportValue).filter((item) => item !== undefined);
  if (value && typeof value === 'object') {
    const entries = [];
    for (const [key, item] of Object.entries(value)) {
      const normalized = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (normalized === 'manifestjson'
        || normalized === 'absolutepath'
        || normalized === 'localpath'
        || normalized.endsWith('path')
        || normalized.endsWith('url')) {
        continue;
      }
      const sanitized = sanitizeExportValue(item);
      if (sanitized !== undefined) entries.push([key, sanitized]);
    }
    return Object.fromEntries(entries);
  }
  return value;
}

function safeExportErrorMessage(value) {
  if (!value) return null;
  return 'export failed';
}

function mapProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    title: row.title,
    default_locale: row.default_locale,
    default_market: row.default_market,
    localization_level: row.localization_level,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapWork(row, sourceAsset = null, extras = {}) {
  if (!row) return null;
  const task = extras.task || null;
  const item = {
    id: row.id,
    project_id: row.project_id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    title: row.title,
    source_asset_id: row.source_asset_id,
    source_fingerprint: row.source_fingerprint,
    duration_ms: row.duration_ms,
    current_version: row.current_version,
    version_id: extras.versionId || null,
    current_step: row.current_step,
    status: row.status,
    task_id: row.task_id,
    provider_task_id: row.provider_task_id,
    analysis_quote: extras.analysisQuote || null,
    task_status: task?.status || null,
    task_progress: Number.isFinite(Number(task?.progress)) ? Number(task.progress) : null,
    task_message: task?.message || null,
    reused: row.reused === true,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (sourceAsset) {
    item.local_path = sourceAsset.local_path || null;
    item.url = sourceAsset.url || null;
  }
  return item;
}

function analysisQuote() {
  return typeof redrawOrchestrator.quoteAnalysis === 'function'
    ? redrawOrchestrator.quoteAnalysis
    : () => null;
}

function normalizeFreeStyle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const positive = String(value.positive ?? value.positivePrompt ?? '').trim();
  const negative = String(value.negative ?? value.negativePrompt ?? '').trim();
  const referenceValue = value.reference && typeof value.reference === 'object' ? value.reference : {};
  const filename = String(referenceValue.filename ?? referenceValue.name ?? value.reference_filename ?? '').trim();
  const id = String(referenceValue.id ?? value.reference_id ?? '').trim();
  const reference = {};
  if (filename) reference.filename = filename;
  if (id) reference.id = id;
  if (!positive && !negative && Object.keys(reference).length === 0) return null;
  return {
    positive,
    negative,
    ...(Object.keys(reference).length ? { reference } : {}),
  };
}

function normalizeAnalysisSettings(body) {
  const locale = String(body?.locale || '').trim();
  const market = String(body?.market || '').trim();
  const aspectRatio = String(body?.aspect_ratio || body?.aspectRatio || '').trim();
  if (!locale) throw Object.assign(new Error('请选择语言'), { code: 'INVALID_REDRAW_ANALYSIS_SETTINGS' });
  if (!ALLOWED_ASPECT_RATIOS.has(aspectRatio)) {
    throw Object.assign(new Error('请选择有效输出比例'), { code: 'INVALID_REDRAW_ANALYSIS_SETTINGS' });
  }
  const presetId = body?.style_preset_id ?? body?.stylePresetId;
  const hasPreset = presetId !== undefined && presetId !== null && String(presetId).trim() !== '';
  const freeStyleValue = parseJSON(body?.free_style ?? body?.freeStyle, body?.free_style ?? body?.freeStyle);
  const freeStyle = normalizeFreeStyle(freeStyleValue);
  if (hasPreset && freeStyle) {
    throw Object.assign(new Error('普通预设和自由风格不能同时提交'), { code: 'INVALID_REDRAW_ANALYSIS_SETTINGS' });
  }
  if (!hasPreset && !freeStyle) {
    throw Object.assign(new Error('请选择风格预设或填写自由风格'), { code: 'INVALID_REDRAW_ANALYSIS_SETTINGS' });
  }
  const settings = { locale, market, aspect_ratio: aspectRatio };
  if (hasPreset) {
    const stylePresetId = Number(presetId);
    if (!Number.isInteger(stylePresetId) || stylePresetId <= 0) {
      throw Object.assign(new Error('风格预设无效'), { code: 'INVALID_REDRAW_ANALYSIS_SETTINGS' });
    }
    settings.style_preset_id = stylePresetId;
  } else {
    settings.free_style = freeStyle;
  }
  return settings;
}

function registerReferenceImage(db, log, currentOwner, file, cfg, uploadLimits) {
  if (!file) return null;
  const buffer = file.buffer || (file.path ? fs.readFileSync(file.path) : null);
  if (!buffer) throw Object.assign(new Error('参考图上传内容为空'), { code: 'INVALID_REDRAW_ANALYSIS_SETTINGS' });
  const uploadLog = log && typeof log.info === 'function' ? log : { info() {} };
  const uploaded = uploadServiceModule.uploadFile(
    uploadLimits.storageRoot,
    cfg?.storage?.base_url || '',
    uploadLog,
    buffer,
    file.originalname || 'style-reference.png',
    file.mimetype || 'image/png',
    'redraw-references',
  );
  return assetService.create(db, log, {
    name: file.originalname || 'style-reference.png',
    type: 'image',
    category: 'redraw_style_reference',
    url: uploaded.url,
    local_path: uploaded.local_path,
    file_size: file.size ?? buffer.length,
    mime_type: file.mimetype || 'image/png',
    metadata: {
      source: 'redraw_style_reference_upload',
      tenant_id: currentOwner.tenantId,
      user_id: currentOwner.userId,
    },
  });
}

function cleanupReferenceImage(db, log, asset, storageRoot) {
  if (!asset?.id) return;
  try {
    assetService.deleteById(db, log, asset.id);
  } catch (error) {
    log?.warn?.({ err: error, asset_id: asset.id }, 'redraw reference asset cleanup failed');
  }
  const target = safeStoragePath(storageRoot, asset.local_path);
  if (target) fs.rmSync(target, { force: true });
}

function mapStylePreset(row) {
  return {
    id: row.id,
    stable_key: row.stable_key,
    name: row.name,
    category: row.category,
    sort_order: row.sort_order,
    version: row.version,
    prompt_template: row.prompt_template,
    negative_prompt_template: row.negative_prompt_template,
    preview_asset_id: row.preview_asset_id,
    compatible_models: parseJSON(row.compatible_models_json, []),
    supported_ratios: parseJSON(row.supported_ratios_json, []),
  };
}

function billingPayload(value) {
  const billing = value && typeof value === 'object' ? value : {};
  return {
    charged: billing.charged ?? 0,
    held: billing.held ?? 0,
    released: billing.released ?? 0,
  };
}

function workflowPhase(work, analysisTask, localizationTask, assetBatch) {
  if (Number(work?.current_step) >= 3) return 'video_generation';
  if (['pending', 'processing'].includes(String(assetBatch?.status || ''))) return 'asset_generating';
  if (Number(work?.current_step) === 2) return 'asset_review';
  if (['pending', 'processing'].includes(String(localizationTask?.status || ''))) return 'localizing';
  if (String(localizationTask?.status || '') === 'needs_attention') return 'localization_needs_attention';
  if (String(analysisTask?.status || '') === 'completed') return 'analysis_review';
  if (['pending', 'processing'].includes(String(analysisTask?.status || ''))) return 'analyzing';
  return 'source';
}

function safeStaticAssetUrl(asset) {
  const url = String(asset?.url || '').trim();
  if (url.startsWith('/static/')) {
    const normalizedUrl = url.replace(/\\/g, '/');
    if (!normalizedUrl.split('/').includes('..')) return normalizedUrl;
  }
  const localPath = String(asset?.local_path || '').trim();
  if (!localPath || path.isAbsolute(localPath) || /^[a-zA-Z]:[\\/]/.test(localPath)) return null;
  const normalized = localPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').includes('..')) return null;
  return `/static/${normalized}`;
}

function parseStrictObject(value, label) {
  if (value == null || value === '') return {};
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (_) {}
  const error = new Error(`${label} JSON 无效`);
  error.code = 'REDRAW_SHOT_INVALID';
  throw error;
}

function codedRouteError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

const SAFE_GENERATION_FIELDS = new Set([
  'duration', 'resolution', 'aspect_ratio', 'aspectRatio', 'idempotency_key', 'idempotencyKey',
  'negative_prompt', 'negativePrompt',
]);
const SAFE_BATCH_GENERATION_FIELDS = new Set([
  ...SAFE_GENERATION_FIELDS,
  'shot_ids', 'shotIds', 'version_id', 'versionId', 'count',
]);
const NATIVE_AUDIO_REVIEW_APPROVE_FIELDS = new Set([
  'validation_hash',
  'expected_updated_at',
  'decision',
  'speaker_order',
  'lip_sync',
  'extra_dialogue',
]);
const NATIVE_AUDIO_REVIEW_REJECT_FIELDS = new Set([
  'validation_hash',
  'expected_updated_at',
  'decision',
  'reason',
]);
const LOCALIZATION_CLIENT_CONTROL_FIELDS = new Set([
  'dialogue',
  'localized_dialogue',
  'name_map',
  'culture_map',
  'glossary',
  'source_facts',
  'model',
  'provider',
  'credit_amount',
  'credits',
  'reservation_id',
]);
const LOCALIZATION_VERSION_FIELDS = new Set([
  'locale',
  'market',
  'localization_level',
  'quote_hash',
  'idempotency_key',
]);
const ASSET_BATCH_CLIENT_CONTROL_FIELDS = new Set([
  'model',
  'provider',
  'credits',
  'credit_amount',
  'reservation_id',
  'asset_results',
]);
const ASSET_BATCH_QUOTE_FIELDS = new Set(['asset_ids']);
const ASSET_BATCH_CREATE_FIELDS = new Set(['asset_ids', 'quote_hash', 'idempotency_key']);
const DIALOGUE_CLIENT_CONTROL_FIELDS = new Set([
  'model',
  'provider',
  'asset',
  'asset_id',
  'assetId',
  'path',
  'local_path',
  'localPath',
  'url',
  'audio_url',
  'audioUrl',
  'credits',
  'credit_amount',
  'creditAmount',
  'reservation_id',
  'reservationId',
]);
const DIALOGUE_START_FIELDS = new Set(['quote_hash', 'idempotency_key']);
const VOICE_ASSIGN_FIELDS = new Set(['voice_asset_id', 'expected_updated_at']);
const IDENTITY_PACK_FIELDS = new Set([
  'target_actor_label', 'targetActorLabel',
  'confirmed_views', 'confirmedViews',
  'live_action_human_confirmed', 'liveActionHumanConfirmed',
  'adult_status', 'adultStatus',
  'identity_consistency_confirmed', 'identityConsistencyConfirmed',
  'persona_origin', 'personaOrigin',
  'target_country', 'targetCountry',
  'expected_updated_at', 'expectedUpdatedAt',
]);
const IDENTITY_PACK_FIELD_ALIASES = [
  ['target_actor_label', 'targetActorLabel'],
  ['confirmed_views', 'confirmedViews'],
  ['live_action_human_confirmed', 'liveActionHumanConfirmed'],
  ['adult_status', 'adultStatus'],
  ['identity_consistency_confirmed', 'identityConsistencyConfirmed'],
  ['persona_origin', 'personaOrigin'],
  ['target_country', 'targetCountry'],
  ['expected_updated_at', 'expectedUpdatedAt'],
];
const IDENTITY_PACK_VIEWS = new Set(['front', 'profile', 'full_body']);

function generationInputError(message) {
  return codedRouteError('REDRAW_GENERATION_INPUT_INVALID', message);
}

function identityPackInputError(message) {
  return codedRouteError('REDRAW_CHARACTER_IDENTITY_INPUT_INVALID', message);
}

function identityPackInput(body) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    throw identityPackInputError('角色身份包参数必须是对象');
  }
  for (const key of Object.keys(body)) {
    if (!IDENTITY_PACK_FIELDS.has(key)) {
      throw identityPackInputError(`角色身份包不接受字段 ${key}`);
    }
  }
  for (const [snake, camel] of IDENTITY_PACK_FIELD_ALIASES) {
    if (Object.prototype.hasOwnProperty.call(body, snake)
      && Object.prototype.hasOwnProperty.call(body, camel)) {
      throw identityPackInputError(`${snake} 与 ${camel} 不能同时提交`);
    }
  }
  const read = (snake, camel) => (Object.prototype.hasOwnProperty.call(body, snake)
    ? body[snake]
    : body[camel]);
  const targetActorLabelValue = read('target_actor_label', 'targetActorLabel');
  if (typeof targetActorLabelValue !== 'string') {
    throw identityPackInputError('target_actor_label 必须是字符串');
  }
  const targetActorLabel = targetActorLabelValue.trim();
  if (!targetActorLabel || targetActorLabel.length > 100) {
    throw identityPackInputError('target_actor_label 必须为 1 到 100 个字符');
  }
  const confirmedViewsValue = read('confirmed_views', 'confirmedViews');
  if (!Array.isArray(confirmedViewsValue)) {
    throw identityPackInputError('confirmed_views 必须是数组');
  }
  const confirmedViews = [];
  const seenViews = new Set();
  for (const value of confirmedViewsValue) {
    if (typeof value !== 'string') {
      throw identityPackInputError('confirmed_views 只能包含 front、profile、full_body');
    }
    const view = value.trim().toLowerCase();
    if (!IDENTITY_PACK_VIEWS.has(view)) {
      throw identityPackInputError('confirmed_views 只能包含 front、profile、full_body');
    }
    if (!seenViews.has(view)) {
      seenViews.add(view);
      confirmedViews.push(view);
    }
  }
  const liveActionHumanConfirmed = read('live_action_human_confirmed', 'liveActionHumanConfirmed');
  if (typeof liveActionHumanConfirmed !== 'boolean') {
    throw identityPackInputError('live_action_human_confirmed 必须是布尔值');
  }
  const adultStatusValue = read('adult_status', 'adultStatus');
  if (typeof adultStatusValue !== 'string'
    || !['verified_18_plus', 'unverified'].includes(adultStatusValue.trim())) {
    throw identityPackInputError('adult_status 必须是 verified_18_plus 或 unverified');
  }
  const identityConsistencyConfirmed = read(
    'identity_consistency_confirmed',
    'identityConsistencyConfirmed',
  );
  if (typeof identityConsistencyConfirmed !== 'boolean') {
    throw identityPackInputError('identity_consistency_confirmed 必须是布尔值');
  }
  const hasPersonaOrigin = Object.prototype.hasOwnProperty.call(body, 'persona_origin')
    || Object.prototype.hasOwnProperty.call(body, 'personaOrigin');
  const personaOriginValue = read('persona_origin', 'personaOrigin');
  if (hasPersonaOrigin && (typeof personaOriginValue !== 'string'
    || personaOriginValue.trim() !== 'fictional_ai_generated')) {
    throw identityPackInputError('persona_origin 必须是 fictional_ai_generated');
  }
  const hasTargetCountry = Object.prototype.hasOwnProperty.call(body, 'target_country')
    || Object.prototype.hasOwnProperty.call(body, 'targetCountry');
  const targetCountryValue = read('target_country', 'targetCountry');
  if (hasTargetCountry && (typeof targetCountryValue !== 'string'
    || targetCountryValue.trim() !== 'US')) {
    throw identityPackInputError('target_country 必须是 US');
  }
  const expectedUpdatedAtValue = read('expected_updated_at', 'expectedUpdatedAt');
  if (typeof expectedUpdatedAtValue !== 'string' || !expectedUpdatedAtValue.trim()) {
    throw identityPackInputError('expected_updated_at 必须是非空字符串');
  }
  return {
    target_actor_label: targetActorLabel,
    confirmed_views: confirmedViews,
    live_action_human_confirmed: liveActionHumanConfirmed,
    adult_status: adultStatusValue.trim(),
    identity_consistency_confirmed: identityConsistencyConfirmed,
    ...(hasPersonaOrigin ? { persona_origin: personaOriginValue.trim() } : {}),
    ...(hasTargetCountry ? { target_country: targetCountryValue.trim() } : {}),
    expected_updated_at: expectedUpdatedAtValue.trim(),
  };
}

function sanitizeIdentityPackResponse(value) {
  if (Array.isArray(value)) return value.map(sanitizeIdentityPackResponse);
  if (value && typeof value === 'object') {
    const entries = [];
    for (const [key, item] of Object.entries(value)) {
      const normalized = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (normalized === 'sourcerefjson' || normalized === 'storageroot' || normalized.endsWith('path')) continue;
      entries.push([key, sanitizeIdentityPackResponse(item)]);
    }
    return Object.fromEntries(entries);
  }
  return value;
}

function rejectAliasPair(input, snake, camel) {
  if (Object.prototype.hasOwnProperty.call(input, snake)
    && Object.prototype.hasOwnProperty.call(input, camel)) {
    throw generationInputError(`${snake} 与 ${camel} 不能同时提交`);
  }
}

function validateSafeGenerationFields(input, allowed) {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw generationInputError(`生成参数不允许包含 ${key}`);
  }
  rejectAliasPair(input, 'aspect_ratio', 'aspectRatio');
  rejectAliasPair(input, 'negative_prompt', 'negativePrompt');
  for (const key of ['model', 'resolution', 'aspect_ratio', 'aspectRatio', 'locale', 'negative_prompt', 'negativePrompt']) {
    if (Object.prototype.hasOwnProperty.call(input, key) && typeof input[key] !== 'string') {
      throw generationInputError(`${key} 必须是字符串`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, 'duration')) {
    const duration = Number(input.duration);
    if (!Number.isSafeInteger(duration) || duration < 5 || duration > 15) {
      throw generationInputError('duration 必须是 5 到 15 秒的整数');
    }
  }
}

function singleGenerationInput(body) {
  if (body != null && (typeof body !== 'object' || Array.isArray(body))) {
    throw generationInputError('生成参数必须是对象');
  }
  const input = body || {};
  const allowed = new Set([...SAFE_GENERATION_FIELDS, 'retry']);
  validateSafeGenerationFields(input, allowed);
  if (Object.prototype.hasOwnProperty.call(input, 'retry') && typeof input.retry !== 'boolean') {
    throw generationInputError('retry 必须是布尔值');
  }
  const sanitized = {};
  for (const key of SAFE_GENERATION_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) sanitized[key] = input[key];
  }
  return { input: sanitized, retry: input.retry === true };
}

function batchGenerationInput(body) {
  if (body != null && (typeof body !== 'object' || Array.isArray(body))) {
    throw generationInputError('生成参数必须是对象');
  }
  const input = body || {};
  validateSafeGenerationFields(input, SAFE_BATCH_GENERATION_FIELDS);
  rejectAliasPair(input, 'shot_ids', 'shotIds');
  rejectAliasPair(input, 'version_id', 'versionId');
  if (Object.prototype.hasOwnProperty.call(input, 'count') && Number(input.count) !== 1) {
    throw generationInputError('批量生成 count 必须为 1');
  }
  const sanitized = {};
  for (const key of SAFE_BATCH_GENERATION_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) sanitized[key] = input[key];
  }
  if (Object.prototype.hasOwnProperty.call(sanitized, 'count')) sanitized.count = 1;
  return sanitized;
}

function nativeAudioReviewInput(body) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    throw codedRouteError('REDRAW_NATIVE_AUDIO_REVIEW_INVALID', '原生音轨审核参数必须是对象');
  }
  const decision = String(body.decision || '').trim();
  const allowed = decision === 'rejected'
    ? NATIVE_AUDIO_REVIEW_REJECT_FIELDS
    : NATIVE_AUDIO_REVIEW_APPROVE_FIELDS;
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw codedRouteError('REDRAW_NATIVE_AUDIO_REVIEW_INVALID', `原生音轨审核不接受字段 ${key}`);
    }
  }
  const validationHash = String(body.validation_hash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(validationHash)) {
    throw codedRouteError('REDRAW_NATIVE_AUDIO_REVIEW_INVALID', 'validation_hash 必须是 64 位 hex');
  }
  const expectedUpdatedAt = String(body.expected_updated_at || '').trim();
  if (!expectedUpdatedAt || Number.isNaN(Date.parse(expectedUpdatedAt))) {
    throw codedRouteError('REDRAW_NATIVE_AUDIO_REVIEW_INVALID', 'expected_updated_at 必须是 ISO 时间');
  }
  if (decision === 'approved') {
    for (const key of ['speaker_order', 'lip_sync', 'extra_dialogue']) {
      if (body[key] !== 'passed') {
        throw codedRouteError('REDRAW_NATIVE_AUDIO_REVIEW_INVALID', `${key} 必须为 passed`);
      }
    }
    return {
      validation_hash: validationHash,
      expected_updated_at: expectedUpdatedAt,
      decision,
      speaker_order: 'passed',
      lip_sync: 'passed',
      extra_dialogue: 'passed',
    };
  }
  if (decision === 'rejected') {
    const reason = String(body.reason || '').trim();
    if (!reason) throw codedRouteError('REDRAW_NATIVE_AUDIO_REVIEW_INVALID', '驳回必须填写 reason');
    return {
      validation_hash: validationHash,
      expected_updated_at: expectedUpdatedAt,
      decision,
      reason,
    };
  }
  throw codedRouteError('REDRAW_NATIVE_AUDIO_REVIEW_INVALID', 'decision 必须是 approved 或 rejected');
}

function localizationInputError(code, message, details) {
  return codedRouteError(code, message, details);
}

function rejectLocalizationClientControl(body) {
  const input = body || {};
  for (const field of LOCALIZATION_CLIENT_CONTROL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      throw localizationInputError(
        'REDRAW_LOCALIZATION_CLIENT_CONTROL_FORBIDDEN',
        '本地化生成内容、模型与积分只能由服务端决定',
      );
    }
  }
}

function localizationQuoteInput(body, work, currentOwner, canReadArtifact) {
  const input = body || {};
  return {
    workId: Number(work.id),
    tenantId: currentOwner.tenantId,
    userId: currentOwner.userId,
    locale: String(input.locale || '').trim(),
    market: String(input.market || '').trim(),
    localizationLevel: String(input.localization_level ?? input.localizationLevel ?? 'faithful').trim() || 'faithful',
    canReadArtifact,
  };
}

function localizationStartInput(body, work, currentOwner, canReadArtifact) {
  const input = body || {};
  for (const key of Object.keys(input)) {
    if (!LOCALIZATION_VERSION_FIELDS.has(key)) {
      throw localizationInputError(
        'REDRAW_LOCALIZATION_CLIENT_CONTROL_FORBIDDEN',
        '本地化版本提交只接受 locale、market、localization_level、quote_hash 和 idempotency_key',
      );
    }
  }
  return {
    ...localizationQuoteInput(input, work, currentOwner, canReadArtifact),
    quoteHash: String(input.quote_hash || '').trim(),
    idempotencyKey: String(input.idempotency_key || '').trim(),
  };
}

function localizationBillingPayload(result) {
  if (result?.billing) return billingPayload(result.billing);
  const reservation = result?.reservation || null;
  if (reservation && typeof reservation === 'object') return billingFromReservation(reservation, null);
  const held = Number(result?.quote?.credits ?? result?.quote?.amount);
  return {
    charged: 0,
    held: Number.isFinite(held) && held > 0 ? held : 0,
    released: 0,
  };
}

function rejectAssetBatchClientControl(body, allowedFields) {
  const input = body == null ? {} : body;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw codedRouteError(
      'REDRAW_ASSET_CLIENT_CONTROL_FORBIDDEN',
      '批量资产参数必须是对象',
    );
  }
  for (const key of Object.keys(input)) {
    if (!allowedFields.has(key) || ASSET_BATCH_CLIENT_CONTROL_FIELDS.has(key)) {
      throw codedRouteError(
        'REDRAW_ASSET_CLIENT_CONTROL_FORBIDDEN',
        '批量资产生成模型、供应商、积分与结果只能由服务端决定',
      );
    }
  }
}

function assetBatchAssetIds(body) {
  if (!Object.prototype.hasOwnProperty.call(body, 'asset_ids')) return undefined;
  const value = body.asset_ids;
  if (!Array.isArray(value) || value.length === 0) {
    throw codedRouteError('REDRAW_ASSET_CLIENT_CONTROL_FORBIDDEN', 'asset_ids 必须是正整数数组');
  }
  const ids = [];
  const seen = new Set();
  for (const raw of value) {
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw codedRouteError('REDRAW_ASSET_CLIENT_CONTROL_FORBIDDEN', 'asset_ids 必须是正整数数组');
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function assetBatchQuoteInput(body) {
  const input = body == null ? {} : body;
  rejectAssetBatchClientControl(input, ASSET_BATCH_QUOTE_FIELDS);
  return { assetIds: assetBatchAssetIds(input) };
}

function assetBatchCreateInput(body) {
  const input = body == null ? {} : body;
  rejectAssetBatchClientControl(input, ASSET_BATCH_CREATE_FIELDS);
  return {
    assetIds: assetBatchAssetIds(input),
    quoteHash: String(input.quote_hash || '').trim(),
    idempotencyKey: String(input.idempotency_key || '').trim(),
  };
}

function assetBatchResponsePayload(result, billing) {
  const batch = result?.batch || result?.asset_batch || null;
  const task = result?.task || null;
  return {
    batch_id: Number(batch?.id ?? result?.batch_id ?? result?.id ?? 0) || null,
    task_id: task?.id ?? result?.task_id ?? batch?.task_id ?? null,
    status: result?.status ?? batch?.status ?? task?.status ?? 'pending',
    billing,
    current_step: 2,
  };
}

function rejectDialogueClientControl(body, allowedFields = null) {
  const input = body == null ? {} : body;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw codedRouteError('REDRAW_DIALOGUE_CLIENT_CONTROL_FORBIDDEN', '配音参数必须是对象');
  }
  for (const key of Object.keys(input)) {
    if (DIALOGUE_CLIENT_CONTROL_FIELDS.has(key) || (allowedFields && !allowedFields.has(key))) {
      throw codedRouteError(
        'REDRAW_DIALOGUE_CLIENT_CONTROL_FORBIDDEN',
        '配音模型、积分、资产和路径只能由服务端决定',
      );
    }
  }
}

function dialogueStartInput(body) {
  rejectDialogueClientControl(body, DIALOGUE_START_FIELDS);
  return {
    quoteHash: String(body?.quote_hash || '').trim(),
    idempotencyKey: String(body?.idempotency_key || '').trim(),
  };
}

function dialogueTaskPayload(row) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    progress: Number(row.progress || 0),
    message: row.message || null,
    result: parseJSON(row.result, null),
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at || null,
  };
}

function voiceAssignmentInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw codedRouteError('REDRAW_VOICE_ASSIGN_INPUT_INVALID', '音色绑定参数无效');
  }
  const invalidField = Object.keys(body).find((field) => !VOICE_ASSIGN_FIELDS.has(field));
  if (invalidField) {
    throw codedRouteError(
      'REDRAW_VOICE_ASSIGN_INPUT_INVALID',
      `音色绑定不接受字段 ${invalidField}`,
    );
  }
  const voiceAssetId = numericId(body.voice_asset_id);
  if (!voiceAssetId) {
    throw codedRouteError('REDRAW_VOICE_ASSIGN_INPUT_INVALID', '缺少有效的 voice_asset_id');
  }
  let expectedUpdatedAt;
  if (Object.prototype.hasOwnProperty.call(body, 'expected_updated_at')) {
    expectedUpdatedAt = typeof body.expected_updated_at === 'string'
      ? body.expected_updated_at.trim()
      : '';
    if (!expectedUpdatedAt) {
      throw codedRouteError('REDRAW_VOICE_ASSIGN_INPUT_INVALID', 'expected_updated_at 无效');
    }
  }
  return { voiceAssetId, expectedUpdatedAt };
}

function sendDialogueError(res, error, fallbackMessage, log, context = {}) {
  const code = String(error?.code || '');
  const details = error?.details || (error?.quote ? { quote: error.quote } : undefined);
  if (code === 'INSUFFICIENT_CREDITS') {
    return response.error(res, 402, code, '积分不足，请充值后重试');
  }
  if ([
    'REDRAW_DIALOGUE_PLAN_NOT_READY',
    'REDRAW_DIALOGUE_QUOTE_MISMATCH',
    'REDRAW_DIALOGUE_IDEMPOTENCY_CONFLICT',
    'REDRAW_DIALOGUE_RETRY_REQUIRED',
    'pricing_unconfigured',
  ].includes(code)) {
    return response.error(res, 409, code, error.message || fallbackMessage, details);
  }
  if (code === 'REDRAW_DIALOGUE_CLIENT_CONTROL_FORBIDDEN'
    || code.startsWith('REDRAW_DIALOGUE_')) {
    return response.error(res, 400, code, error.message || fallbackMessage, details);
  }
  log?.error?.({ err: error, ...context }, fallbackMessage);
  return response.error(res, 500, 'INTERNAL_ERROR', fallbackMessage);
}

function reservationBillingFromRows(rows) {
  return rows.reduce((acc, row) => {
    const amount = Number(row?.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) return acc;
    if (row.status === 'confirmed') acc.charged += amount;
    else if (row.status === 'held') acc.held += amount;
    else if (row.status === 'refunded') acc.released += amount;
    return acc;
  }, { charged: 0, held: 0, released: 0 });
}

function assetBatchBillingFromReservations(db, result, currentOwner) {
  const ids = [
    ...(Array.isArray(result?.batch?.attempt_ids) ? result.batch.attempt_ids : []),
    ...(Array.isArray(result?.batch?.asset_ids) ? result.batch.asset_ids : []),
    ...(Array.isArray(result?.attempt_ids) ? result.attempt_ids : []),
    ...(Array.isArray(result?.asset_ids) ? result.asset_ids : []),
    ...(Array.isArray(result?.batch?.quote_snapshot?.items)
      ? result.batch.quote_snapshot.items.map((item) => item.asset_id)
      : []),
    ...(Array.isArray(result?.quote_snapshot?.items)
      ? result.quote_snapshot.items.map((item) => item.asset_id)
      : []),
  ]
    .map((id) => Number(id))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) return { charged: 0, held: 0, released: 0 };
  try {
    const assets = db.prepare(`
      SELECT credit_reservation_id
      FROM redraw_assets
      WHERE id IN (${uniqueIds.map(() => '?').join(',')})
        AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
        AND credit_reservation_id IS NOT NULL
    `).all(...uniqueIds, currentOwner.tenantId, currentOwner.userId);
    const reservationIds = [...new Set(assets.map((row) => String(row.credit_reservation_id || '').trim()).filter(Boolean))];
    if (!reservationIds.length) return { charged: 0, held: 0, released: 0 };
    const rows = [];
    try {
      rows.push(...db.prepare(`
        SELECT id, amount, status
        FROM tenant_usage_reservations
        WHERE id IN (${reservationIds.map(() => '?').join(',')})
          AND tenant_id = ?
      `).all(...reservationIds, currentOwner.tenantId));
    } catch (error) {
      if (!isMissingSchemaError(error)) throw error;
    }
    try {
      rows.push(...db.prepare(`
        SELECT id, amount, status
        FROM usage_reservations
        WHERE id IN (${reservationIds.map(() => '?').join(',')})
          AND user_id = ?
      `).all(...reservationIds, currentOwner.userId));
    } catch (error) {
      if (!isMissingSchemaError(error)) throw error;
    }
    return reservationBillingFromRows(rows);
  } catch (error) {
    if (isMissingSchemaError(error)) return { charged: 0, held: 0, released: 0 };
    throw error;
  }
}

function assetBatchBillingPayload(db, result, currentOwner) {
  if (result?.billing) return billingPayload(result.billing);
  return assetBatchBillingFromReservations(db, result, currentOwner);
}

function sendAssetBatchError(res, error, fallbackMessage, log, context = {}) {
  const code = String(error?.code || '');
  const details = error?.quote
    ? { ...(error?.details || {}), quote: error.quote }
    : (error?.details || error?.quote_snapshot || undefined);
  if (code === 'REDRAW_VERSION_NOT_FOUND' || code === 'REDRAW_ASSET_NOT_FOUND') {
    return response.error(res, 404, code, error.message || fallbackMessage, details);
  }
  if (code === 'INSUFFICIENT_CREDITS') {
    return response.error(res, 402, code, error.message || '积分不足', details);
  }
  if ([
    'REDRAW_ASSET_VERSION_NOT_CURRENT',
    'REDRAW_ASSET_BATCH_QUOTE_CHANGED',
    'REDRAW_ASSET_QUOTE_CHANGED',
    'REDRAW_ASSET_BATCH_UNPRICED',
    'REDRAW_ASSET_BATCH_EMPTY',
    'REDRAW_ASSET_PROVIDER_REQUIRED',
    'REDRAW_ASSET_BATCH_CAPABILITY_UNVERIFIED',
    'REDRAW_ASSET_BATCH_PRICING_UNCONFIGURED',
    'pricing_unconfigured',
  ].includes(code)) {
    return response.error(res, 409, code, error.message || fallbackMessage, details);
  }
  if (code === 'REDRAW_ASSET_CLIENT_CONTROL_FORBIDDEN') {
    return response.error(res, 400, code, error.message || fallbackMessage, details);
  }
  if (code.startsWith('REDRAW_ASSET') || code.startsWith('REDRAW_')) {
    return response.error(res, 400, code, error.message || fallbackMessage, details);
  }
  log?.error?.({ err: error, ...context }, fallbackMessage);
  return response.error(res, 500, 'INTERNAL_ERROR', fallbackMessage);
}

function sendLocalizationError(res, error, fallbackMessage, log, context = {}) {
  const code = String(error?.code || '');
  const details = error?.quote
    ? { ...(error?.details || {}), quote: error.quote }
    : error?.details;
  if (code === 'REDRAW_LOCALIZATION_WORK_NOT_FOUND') {
    return response.error(res, 404, code, error.message || fallbackMessage, details);
  }
  if (code === 'INSUFFICIENT_CREDITS') {
    return response.error(res, 402, code, error.message || '积分不足', details);
  }
  if ([
    'pricing_unconfigured',
    'REDRAW_LOCALIZATION_CAPABILITY_UNVERIFIED',
    'REDRAW_LOCALIZATION_QUOTE_CHANGED',
    'REDRAW_LOCALIZATION_IDEMPOTENCY_CONFLICT',
  ].includes(code)) {
    return response.error(res, 409, code, error.message || fallbackMessage, details);
  }
  if (code === 'REDRAW_LOCALIZATION_CLIENT_CONTROL_FORBIDDEN') {
    return response.error(res, 400, code, error.message || fallbackMessage, details);
  }
  if (code.startsWith('REDRAW_LOCALIZATION') || code.startsWith('REDRAW_')) {
    return response.error(res, 400, code, error.message || fallbackMessage, details);
  }
  log?.error?.({ err: error, ...context }, fallbackMessage);
  return response.error(res, 500, 'INTERNAL_ERROR', fallbackMessage);
}

function sendRedrawError(res, error, fallbackMessage, log, context = {}) {
  const code = String(error?.code || '');
  if (code === 'REDRAW_IDENTITY_PROJECTION_FAILED') {
    log?.error?.({ err: error, ...context }, fallbackMessage);
    return response.error(res, 500, code, fallbackMessage);
  }
  if (['REDRAW_WORK_NOT_FOUND', 'REDRAW_VERSION_NOT_FOUND', 'REDRAW_SHOT_NOT_FOUND',
    'REDRAW_SHOT_TASK_NOT_FOUND', 'REDRAW_VIDEO_NOT_FOUND'].includes(code)) {
    return response.error(res, 404, code, error.message || fallbackMessage, error.details);
  }
  if (code === 'INSUFFICIENT_CREDITS') {
    return response.error(res, 402, code, error.message || '积分不足', error.details);
  }
  if (['REDRAW_ASSET_REVIEW_REQUIRED', 'REDRAW_SHOT_CONFLICT', 'REDRAW_VERSION_CONFLICT',
    'REDRAW_SHOT_EDIT_CONFLICT', 'REDRAW_RETRY_UNCERTAIN', 'REDRAW_SHOT_RETRY_REQUIRED',
    'REDRAW_SHOT_PRICING_UNCONFIGURED', 'REDRAW_NATIVE_AUDIO_REVIEW_CONFLICT',
    'REDRAW_NATIVE_AUDIO_REVIEW_UNAVAILABLE'].includes(code)) {
    return response.error(res, 409, code, error.message || fallbackMessage, error.details);
  }
  if (code.startsWith('REDRAW_') || code.startsWith('INVALID_')) {
    return response.error(res, 400, code, error.message || fallbackMessage, error.details);
  }
  log?.error?.({ err: error, ...context }, fallbackMessage);
  return response.error(res, 500, 'INTERNAL_ERROR', fallbackMessage);
}

function isMissingSchemaError(error) {
  return /no such (table|column)/i.test(String(error?.message || ''));
}

function registerSourceAsset(db, log, currentOwner, sourceAsset) {
  const existingId = sourceAsset?.id ?? sourceAsset?.asset_id;
  if (existingId != null) return { sourceAsset, asset: null };
  const asset = assetService.create(db, log, {
    name: sourceAsset?.name || '转绘源片',
    type: 'video',
    category: 'redraw_source',
    url: sourceAsset?.url || '',
    local_path: sourceAsset?.local_path || null,
    file_size: sourceAsset?.file_size ?? sourceAsset?.size ?? null,
    mime_type: sourceAsset?.mime_type || (sourceAsset?.kind ? `video/${sourceAsset.kind}` : null),
    width: sourceAsset?.width ?? null,
    height: sourceAsset?.height ?? null,
    duration: sourceAsset?.duration_ms == null ? null : Number(sourceAsset.duration_ms) / 1000,
    metadata: {
      source: 'redraw_source_upload',
      tenant_id: currentOwner.tenantId,
      user_id: currentOwner.userId,
      sha256: sourceAsset?.sha256 || null,
      source_fingerprint: sourceAsset?.source_fingerprint || sourceAsset?.sha256 || null,
      duration_ms: sourceAsset?.duration_ms ?? null,
      kind: sourceAsset?.kind || null,
    },
  });
  return {
    asset,
    sourceAsset: {
      ...sourceAsset,
      id: asset.id,
      asset_id: asset.id,
    },
  };
}

function cleanupRegisteredSource(db, log, registered, storageRoot) {
  if (!registered?.asset?.id) return;
  try {
    assetService.deleteById(db, log, registered.asset.id);
  } catch (error) {
    log?.warn?.({ err: error, asset_id: registered.asset.id }, 'redraw source asset cleanup failed');
  }
  if (!registered.sourceAsset?.persisted_file_created) return;
  const target = safeStoragePath(storageRoot, registered.sourceAsset.local_path);
  if (target) fs.rmSync(target, { force: true });
}

module.exports = function redrawRoutes(db, log, options = {}) {
  const uploadService = options.uploadService || redrawUploadService;
  const capabilityService = options.capabilityService || redrawCapabilityService;
  const orchestrator = options.orchestrator || redrawOrchestrator;
  const shotService = options.shotService || redrawShotService;
  const generationService = options.generationService || redrawGenerationService;
  const localizationOrchestrator = options.localizationOrchestrator || redrawLocalizationOrchestrator;
  const assetBatchService = options.assetBatchService || {
    quoteAssetBatch: (ctx, input) => redrawAssetBatchService.quoteAssetBatch(db, { ...ctx, ...input }),
    startAssetBatch: (ctx, input) => redrawAssetBatchService.startAssetBatch(ctx, input, {
      concurrency: ctx.concurrency,
    }),
  };
  const dialogueOrchestrator = options.dialogueOrchestrator || redrawDialogueOrchestrator;
  const compositionService = options.compositionService || redrawCompositionService;
  const exportService = options.exportService || redrawExportService;
  const cfg = options.cfg || {};
  const quoteAnalysis = options.quoteAnalysis || analysisQuote();
  const canReadArtifact = options.canReadArtifact || createCanReadArtifact(db, cfg);
  const uploadLimits = {
    storageRoot: storageRootFromConfig(cfg),
    assetUrlPrefix: '/static/redraw-sources',
    ...(options.uploadLimits || {}),
  };
  const analysisOptions = { ...(options.analysisOptions || {}) };
  if (!analysisOptions.assetReader) {
    analysisOptions.assetReader = redrawOrchestrator.createAssetReader({ storageRoot: uploadLimits.storageRoot });
  }
  if (!analysisOptions.provider) {
    const nativeSourceAnalysis = options.nativeSourceAnalysis
      || redrawNativeSourceAnalysisService.analyzeNativeSource;
    analysisOptions.provider = {
      startAnalysis: (request) => nativeSourceAnalysis({
        db,
        log,
        storageRoot: uploadLimits.storageRoot,
        assetService: options.assetService || assetService,
        visionDetailed: options.visionDetailed,
        serviceType: options.nativeAnalysisServiceType || 'video_understanding',
      }, {
        taskId: request.taskId,
        workId: request.workId,
        tenantId: request.tenantId,
        userId: request.userId,
        model: request.model,
        probeTimeoutMs: options.nativeAnalysisProbeTimeoutMs,
        ffmpegTimeoutMs: options.nativeAnalysisFfmpegTimeoutMs,
        maxTokens: options.nativeAnalysisMaxTokens,
      }),
    };
  }

  function findOwnedProject(id, currentOwner) {
    return db.prepare(`
      SELECT *
      FROM redraw_projects
      WHERE id = ?
        AND tenant_id = ?
        AND user_id = ?
        AND deleted_at IS NULL
    `).get(Number(id), currentOwner.tenantId, currentOwner.userId);
  }

  function findOwnedWork(id, currentOwner) {
    return db.prepare(`
      SELECT *
      FROM redraw_works
      WHERE id = ?
        AND tenant_id = ?
        AND user_id = ?
        AND deleted_at IS NULL
    `).get(Number(id), currentOwner.tenantId, currentOwner.userId);
  }

  function findOwnedVersion(id, currentOwner) {
    return db.prepare(`
      SELECT *
      FROM redraw_versions
      WHERE id = ?
        AND tenant_id = ?
        AND user_id = ?
        AND deleted_at IS NULL
    `).get(Number(id), currentOwner.tenantId, currentOwner.userId);
  }

  function assertCurrentPromotedAssetBatchVersion(version, currentOwner) {
    const work = findOwnedWork(version.work_id, currentOwner);
    if (!work
      || String(version.status || '') === 'draft'
      || Number(version.version) !== Number(work.current_version)) {
      throw codedRouteError(
        'REDRAW_ASSET_VERSION_NOT_CURRENT',
        '批量资产生成只能用于当前已提升版本',
      );
    }
    return work;
  }

  function findOwnedAsset(id, currentOwner) {
    return db.prepare(`
      SELECT *
      FROM redraw_assets
      WHERE id = ?
        AND tenant_id = ?
        AND user_id = ?
        AND deleted_at IS NULL
    `).get(Number(id), currentOwner.tenantId, currentOwner.userId);
  }

  function productionVoiceRowsForVersion(version, currentOwner) {
    const rows = db.prepare(`
      SELECT id, localized_name
      FROM redraw_assets
      WHERE version_id = ?
        AND tenant_id = ?
        AND user_id = ?
        AND kind = 'voice'
        AND deleted_at IS NULL
    `).all(Number(version.id), currentOwner.tenantId, currentOwner.userId);
    const rowsById = new Map(rows.map((row) => [Number(row.id), row]));
    return redrawVoiceService.listProductionVoices(db, {
      tenantId: currentOwner.tenantId,
      userId: currentOwner.userId,
      versionId: Number(version.id),
      locale: version.locale,
      market: version.market,
    }, (asset) => Boolean(asset && canReadArtifact(asset.id)))
      .filter((voice) => rowsById.has(Number(voice.id))
        && String(voice.locale) === String(version.locale)
        && String(voice.market) === String(version.market))
      .map((voice) => ({ ...voice, localized_name: rowsById.get(Number(voice.id)).localized_name || '' }));
  }

  function productionVoicesForVersion(version, currentOwner) {
    return productionVoiceRowsForVersion(version, currentOwner)
      .map((voice) => ({
        id: Number(voice.id),
        localized_name: voice.localized_name,
        voice_id: voice.voice_id,
        locale: voice.locale,
        market: voice.market,
        audio_asset_id: Number(voice.audio_asset_id),
        duration_ms: Number(voice.duration_ms),
        preview_url: `/api/v1/redraw/versions/${Number(version.id)}/voices/${Number(voice.id)}/preview`,
        provider_verified: true,
        audio_readable: true,
      }));
  }

  function assetBatchContext(version, currentOwner) {
    const ctx = {
      db,
      versionId: Number(version.id),
      tenantId: currentOwner.tenantId,
      userId: currentOwner.userId,
      canReadArtifact,
      assetReader: {
        canRead: (row) => Boolean(row && typeof canReadArtifact === 'function' && canReadArtifact(row.id)),
      },
      provider: options.assetGenerationProvider || options.assetProvider,
      concurrency: Number(options.assetBatchConcurrency || options.assetConcurrency || 3),
      localeVerifier: options.localeVerifier,
      log,
    };
    if (typeof options.assetBatchSchedule === 'function') ctx.schedule = options.assetBatchSchedule;
    return ctx;
  }

  function dialogueContext(version, currentOwner) {
    const reader = redrawOrchestrator.createAssetReader({ storageRoot: storageRootFromConfig(cfg) });
    return {
      db,
      tenantId: currentOwner.tenantId,
      userId: currentOwner.userId,
      versionId: Number(version.id),
      canReadAudioAsset: (asset) => reader.canRead(asset),
      localeVerifier: options.localeVerifier,
    };
  }

  function compositionContext(version, currentOwner) {
    return {
      db,
      log,
      tenantId: currentOwner.tenantId,
      userId: currentOwner.userId,
      versionId: Number(version.id),
      storageRoot: storageRootFromConfig(cfg),
      config: cfg,
      compositionRunner: options.compositionRunner,
      probeRunner: options.compositionProbeRunner || options.probeRunner,
      execFile: options.execFile,
      artifactVerifier: options.artifactVerifier,
      clock: options.clock,
    };
  }

  function exportContext(currentOwner) {
    return {
      db,
      tenantId: currentOwner.tenantId,
      userId: currentOwner.userId,
      storageRoot: storageRootFromConfig(cfg),
      config: cfg,
    };
  }

  function findOwnedShot(id, currentOwner) {
    return db.prepare(`
      SELECT s.*
      FROM redraw_shots s
      JOIN redraw_versions v ON v.id = s.version_id
      WHERE s.id = ?
        AND s.tenant_id = ? AND s.user_id = ?
        AND v.tenant_id = ? AND v.user_id = ?
        AND s.deleted_at IS NULL AND v.deleted_at IS NULL
      LIMIT 1
    `).get(
      Number(id),
      currentOwner.tenantId,
      currentOwner.userId,
      currentOwner.tenantId,
      currentOwner.userId,
    );
  }

  function findVersionForWork(work, versionValue, currentOwner) {
    const versionNumber = Number(versionValue);
    if (!Number.isSafeInteger(versionNumber) || versionNumber <= 0) return null;
    return db.prepare(`
      SELECT * FROM redraw_versions
      WHERE work_id = ? AND tenant_id = ? AND user_id = ?
        AND version = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(work.id, currentOwner.tenantId, currentOwner.userId, versionNumber);
  }

  function findCurrentPromotedVersionForWork(work, currentOwner) {
    const versionNumber = Number(work.current_version);
    const exact = Number.isSafeInteger(versionNumber) && versionNumber > 0
      ? db.prepare(`
        SELECT * FROM redraw_versions
        WHERE work_id = ? AND tenant_id = ? AND user_id = ?
          AND version = ? AND COALESCE(locale, '') != 'source'
          AND COALESCE(status, '') != 'draft' AND deleted_at IS NULL
        LIMIT 1
      `).get(work.id, currentOwner.tenantId, currentOwner.userId, versionNumber)
      : null;
    if (exact) return exact;
    return db.prepare(`
      SELECT * FROM redraw_versions
      WHERE work_id = ? AND tenant_id = ? AND user_id = ?
        AND COALESCE(locale, '') != 'source'
        AND COALESCE(status, '') != 'draft' AND deleted_at IS NULL
      ORDER BY version DESC, id DESC
      LIMIT 1
    `).get(work.id, currentOwner.tenantId, currentOwner.userId);
  }

  function publicTask(row) {
    if (!row) return null;
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      progress: Number.isFinite(Number(row.progress)) ? Number(row.progress) : null,
      message: row.message || null,
      provider_task_id: row.provider_task_id || null,
      credit_reservation_id: row.credit_reservation_id || null,
      error: row.error || null,
    };
  }

  function publicAssetBatch(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      version_id: Number(row.version_id),
      task_id: row.task_id,
      status: row.status,
      total_count: Number(row.total_count || 0),
      success_count: Number(row.success_count || 0),
      failed_count: Number(row.failed_count || 0),
      error_code: row.error_code || null,
      error_message: row.error_message || null,
      updated_at: row.updated_at,
    };
  }

const COMPOSITION_ALLOWED_FIELDS = new Set(['idempotency_key', 'audio_mode']);
const COMPOSITION_CLIENT_CONTROL_FIELDS = new Set([
  'model',
  'provider',
  'credits',
  'credit_amount',
  'reservation',
  'reservation_id',
  'asset_id',
  'subtitle_asset_id',
  'manifest',
  'manifest_json',
  'outputs',
  'mp4_path',
  'srt_path',
  'vtt_path',
  'local_path',
  'absolute_path',
]);

function compositionStartInput(body) {
  const input = body == null ? {} : body;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw codedRouteError('REDRAW_COMPOSITION_INPUT_INVALID', '合成参数必须是对象');
  }
  for (const key of Object.keys(input)) {
    if (!COMPOSITION_ALLOWED_FIELDS.has(key) || COMPOSITION_CLIENT_CONTROL_FIELDS.has(key)) {
      throw codedRouteError(
        'REDRAW_COMPOSITION_CLIENT_CONTROL_FORBIDDEN',
        '合成模型、积分、产物与路径只能由服务端决定',
      );
    }
  }
  const idempotencyKey = String(input.idempotency_key || '').trim();
  if (!idempotencyKey) {
    throw codedRouteError('REDRAW_COMPOSITION_IDEMPOTENCY_REQUIRED', 'idempotency_key required');
  }
  const audioMode = String(input.audio_mode || 'replace').trim();
  if (audioMode !== 'replace') {
    throw codedRouteError('REDRAW_COMPOSITION_AUDIO_MODE_UNSUPPORTED', 'audio_mode 目前只能为 replace');
  }
  return { idempotencyKey, audioMode };
}

function parseManifestSafe(row) {
  return parseJSON(row?.manifest_json, {});
}

function exportSummary(row) {
  const manifest = parseManifestSafe(row);
  const inputs = manifest.plan || manifest.inputs || {};
  const outputs = manifest.outputs || {};
  return {
    id: Number(row.id),
    version_id: Number(row.version_id),
    export_type: row.export_type,
    version_number: Number(row.version_number),
    status: row.status,
    asset_id: row.asset_id == null ? null : Number(row.asset_id),
    subtitle_asset_id: row.subtitle_asset_id == null ? null : Number(row.subtitle_asset_id),
    project_asset_id: row.project_asset_id == null ? null : Number(row.project_asset_id),
    request_hash: manifest.request_hash || null,
    audio_mode: manifest.audio_mode || null,
    input_hash: inputs.input_hash || outputs.input_hash || null,
    timeline: sanitizeExportValue(inputs.timeline || []),
    video_generation_ids: sanitizeExportValue(inputs.video_generation_ids || []),
    audio_asset_ids: sanitizeExportValue(inputs.audio_asset_ids || []),
    output_asset_ids: sanitizeExportValue({
      mp4: outputs.mp4_asset_id ?? row.asset_id ?? null,
      srt: outputs.srt_asset_id ?? row.subtitle_asset_id ?? null,
      vtt: outputs.vtt_asset_id ?? null,
    }),
    hashes: sanitizeExportValue(outputs.hashes || (outputs.hash ? { mp4: outputs.hash } : {})),
    probe: sanitizeExportValue(outputs.probe || null),
    error_code: row.error_code || null,
    error_message: row.error_message ? safeExportErrorMessage(row.error_message) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function sendCompositionError(res, error, fallbackMessage, log, meta = {}) {
  const code = String(error?.code || '');
  if (code === 'REDRAW_EXPORT_NOT_FOUND' || code === 'REDRAW_COMPOSITION_EXPORT_NOT_FOUND') {
    return response.notFound(res, '转绘导出不存在');
  }
  if (code === 'REDRAW_EXPORT_NOT_READY') {
    return response.error(res, 409, code, '导出尚未完成');
  }
  if (code === 'REDRAW_EXPORT_KIND_INVALID' || code === 'REDRAW_EXPORT_CHECKSUM_MISMATCH') {
    return response.error(res, 422, code, '导出产物校验失败');
  }
  if (code.startsWith('REDRAW_EXPORT_')) {
    return response.error(res, 409, code, '导出产物不可用');
  }
  if (code === 'REDRAW_COMPOSITION_ACTIVE_CONFLICT'
    || code === 'REDRAW_COMPOSITION_IDEMPOTENCY_CONFLICT') {
    return response.error(res, 409, code, error.message || fallbackMessage);
  }
  if (code.startsWith('REDRAW_COMPOSITION_')) {
    return response.badRequest(res, error.message || fallbackMessage);
  }
  log?.error?.({ err: error, ...meta }, fallbackMessage);
  return response.internalError(res, fallbackMessage);
}

  function taskMetadata(row) {
    try {
      return parseStrictObject(row?.metadata, 'async_tasks.metadata').redraw_shot || {};
    } catch (_) {
      return {};
    }
  }

  function billingFromReservation(reservation, quote = null) {
    const amount = Number(reservation?.amount || 0);
    return {
      held: reservation?.status === 'held' ? amount : 0,
      charged: reservation?.status === 'confirmed' ? amount : 0,
      released: reservation?.status === 'refunded' ? amount : 0,
      quote,
    };
  }

  function durationSeconds(snapshot) {
    const explicit = Number(snapshot.duration);
    if (Number.isSafeInteger(explicit) && explicit >= 5 && explicit <= 15) return explicit;
    const derived = Math.ceil(Number(snapshot.duration_ms || 0) / 1000);
    return Math.max(5, Math.min(15, derived || 5));
  }

  function generationAttempt(raw, snapshot) {
    const draft = snapshot.draft || {};
    const persisted = Number(draft.generation?.attempt ?? draft.attempt);
    const hasPersisted = Number.isSafeInteger(persisted) && persisted > 0;
    if (String(raw.status || '') === 'failed') return hasPersisted ? persisted + 1 : 2;
    return hasPersisted ? persisted : 1;
  }

  function sourceVideoRef(work, snapshot) {
    if (!work?.source_asset_id) return null;
    const asset = db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL')
      .get(Number(work.source_asset_id));
    const url = safeStaticAssetUrl(asset);
    if (!asset || !url) return null;
    return {
      asset_id: Number(asset.id),
      url,
      start_ms: Number(snapshot.start_ms),
      end_ms: Number(snapshot.end_ms),
    };
  }

  function draftGenerationRuntime(work, version, raw, snapshot) {
    if (!work || !version) return {};
    if (!['draft', 'failed'].includes(String(raw.status || ''))) return {};
    const model = generationService.resolveVerifiedGenerationModel(db, version, canReadArtifact);
    if (!model) {
      return {
        generation_availability: {
          ok: false,
          code: 'no_verified_video_model',
          reason: '当前语言市场没有已验证可读的视频生成能力',
        },
        quote: null,
      };
    }
    const quote = redrawBillingService.quoteShotGeneration(db, {
      tenantId: raw.tenant_id,
      actorUserId: raw.user_id,
      versionId: String(version.id),
      shotId: String(raw.id),
      model,
      duration: durationSeconds(snapshot),
      resolution: snapshot.resolution || '720p',
      count: 1,
      locale: version.locale,
      styleSnapshot: parseJSON(version.style_snapshot_json, {}),
      attempt: generationAttempt(raw, snapshot),
    });
    if (!quote.success) {
      return {
        generation_availability: {
          ok: false,
          code: quote.code,
          reason: quote.message,
        },
        quote: null,
      };
    }
    return {
      model: quote.snapshot.model,
      duration: quote.snapshot.duration,
      resolution: quote.snapshot.resolution,
      count: 1,
      quote,
      generation_snapshot: quote.snapshot,
      generation_availability: { ok: true },
    };
  }

  function findOwnedAnalysisTask(work, currentOwner) {
    if (!work.task_id) return null;
    return db.prepare(`SELECT * FROM async_tasks
      WHERE id = ? AND type = 'redraw_analysis' AND resource_id = ?
        AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
      LIMIT 1`)
      .get(String(work.task_id), String(work.id), currentOwner.tenantId, currentOwner.userId);
  }

  function findOwnedLocalizationTask(work, currentVersion, currentOwner) {
    try {
      let taskId = currentVersion?.localization_task_id || null;
      if (!taskId) {
        const version = db.prepare(`
          SELECT localization_task_id
          FROM redraw_versions
          WHERE work_id = ? AND tenant_id = ? AND user_id = ?
            AND localization_task_id IS NOT NULL AND TRIM(localization_task_id) != ''
            AND deleted_at IS NULL
          ORDER BY id DESC
          LIMIT 1
        `).get(work.id, currentOwner.tenantId, currentOwner.userId);
        taskId = version?.localization_task_id || null;
      }
      if (!taskId) return null;
      return db.prepare(`SELECT * FROM async_tasks
        WHERE id = ? AND type = 'redraw_localization' AND resource_id = ?
          AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
        LIMIT 1`)
        .get(String(taskId), String(work.id), currentOwner.tenantId, currentOwner.userId);
    } catch (error) {
      if (isMissingSchemaError(error)) return null;
      throw error;
    }
  }

  function findCurrentAssetBatch(currentVersion, currentOwner) {
    if (!currentVersion) return null;
    try {
      return db.prepare(`
        SELECT *
        FROM redraw_asset_batches
        WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `).get(currentVersion.id, currentOwner.tenantId, currentOwner.userId);
    } catch (error) {
      if (isMissingSchemaError(error)) return null;
      throw error;
    }
  }

  function analysisBilling(work, currentOwner) {
    const reservation = work.credit_reservation_id
      ? db.prepare(`SELECT * FROM tenant_usage_reservations
        WHERE id = ? AND tenant_id = ? AND actor_user_id = ?
          AND resource_type = 'redraw_analysis' AND resource_id = ?`)
        .get(
          String(work.credit_reservation_id),
          currentOwner.tenantId,
          currentOwner.userId,
          String(work.id),
        )
      : null;
    return billingFromReservation(reservation, reservation
      ? { model: reservation.model, amount: Number(reservation.amount) }
      : null);
  }

  function localizationBilling(work, localizationTask, currentOwner) {
    const reservation = localizationTask?.credit_reservation_id
      ? db.prepare(`SELECT * FROM tenant_usage_reservations
        WHERE id = ? AND tenant_id = ? AND actor_user_id = ?
          AND resource_type = 'redraw_localization' AND resource_id = ?`)
        .get(
          String(localizationTask.credit_reservation_id),
          currentOwner.tenantId,
          currentOwner.userId,
          String(work.id),
        )
      : null;
    return billingFromReservation(reservation, reservation
      ? { model: reservation.model, amount: Number(reservation.amount) }
      : null);
  }

  function shotRuntime(raw, snapshot, currentOwner, context = {}) {
    const video = raw.video_generation_id
      ? db.prepare(`SELECT * FROM video_generations
        WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL`)
        .get(Number(raw.video_generation_id), currentOwner.tenantId, currentOwner.userId)
      : null;
    const draftGeneration = snapshot.draft?.generation || {};
    const taskId = video?.task_id || draftGeneration.task_id || null;
    const task = taskId
      ? db.prepare(`SELECT * FROM async_tasks
        WHERE id = ? AND type = 'redraw_shot' AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL`)
        .get(String(taskId), currentOwner.tenantId, currentOwner.userId)
      : null;
    const metadata = taskMetadata(task);
    const reservationId = metadata.reservation_id || draftGeneration.reservation_id || null;
    const reservation = reservationId
      ? db.prepare(`SELECT * FROM tenant_usage_reservations
        WHERE id = ? AND tenant_id = ? AND actor_user_id = ?
          AND resource_type = 'redraw_shot' AND resource_id = ?`)
        .get(String(reservationId), currentOwner.tenantId, currentOwner.userId, String(raw.id))
      : null;
    const draftRuntime = draftGenerationRuntime(context.work, context.version, raw, snapshot);
    let billing = billingFromReservation(reservation, metadata.quote || null);
    if (Object.prototype.hasOwnProperty.call(draftRuntime, 'quote')) {
      billing = {
        ...billing,
        quote: draftRuntime.quote,
      };
    }
    return {
      ...snapshot,
      ...draftRuntime,
      source_video_ref: sourceVideoRef(context.work, snapshot),
      status: raw.status,
      updated_at: raw.updated_at,
      error_code: raw.error_code || null,
      error_message: raw.error_message || null,
      video_generation_id: raw.video_generation_id || null,
      new_video_ref: snapshot.new_video_ref || snapshot.draft?.new_video_ref || null,
      generation: {
        task_id: task?.id || null,
        status: task?.status || null,
        progress: task && Number.isFinite(Number(task.progress)) ? Number(task.progress) : null,
        message: task?.message || null,
      },
      billing,
    };
  }

  function listOwnedShotRuntime(version, currentOwner, work) {
    const rows = db.prepare(`SELECT * FROM redraw_shots
      WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
      ORDER BY batch_index ASC, shot_index ASC, id ASC`)
      .all(version.id, currentOwner.tenantId, currentOwner.userId);
    const rowsById = new Map(rows.map((row) => [Number(row.id), row]));
    return shotService.snapshotShots(db, version.id, currentOwner)
      .filter((snapshot) => rowsById.has(Number(snapshot.id)))
      .map((snapshot) => shotRuntime(rowsById.get(Number(snapshot.id)), snapshot, currentOwner, {
        version,
        work,
      }));
  }

  function listProjects(req, res) {
    const currentOwner = owner(req);
    const rows = db.prepare(`
      SELECT *
      FROM redraw_projects
      WHERE tenant_id = ?
        AND user_id = ?
        AND deleted_at IS NULL
      ORDER BY updated_at DESC, id DESC
    `).all(currentOwner.tenantId, currentOwner.userId);
    return response.success(res, rows.map(mapProject));
  }

  function createProject(req, res) {
    const currentOwner = owner(req);
    if (!currentOwner.tenantId || !currentOwner.userId) {
      return response.badRequest(res, '缺少租户或用户身份');
    }
    const title = String(req.body?.title || '').trim();
    if (!title) return response.badRequest(res, '请输入转绘项目标题');

    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO redraw_projects
        (tenant_id, user_id, title, default_locale, default_market, localization_level,
         status, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, NULL)
    `).run(
      currentOwner.tenantId,
      currentOwner.userId,
      title,
      String(req.body?.default_locale || 'en-US').trim() || 'en-US',
      String(req.body?.default_market || '').trim(),
      String(req.body?.localization_level || 'faithful').trim() || 'faithful',
      now,
      now,
    );
    return response.created(res, mapProject(findOwnedProject(result.lastInsertRowid, currentOwner)));
  }

  function getProject(req, res) {
    const project = findOwnedProject(req.params.id, owner(req));
    if (!project) return response.notFound(res, '转绘项目不存在');
    return response.success(res, mapProject(project));
  }

  async function createWorks(req, res) {
    const currentOwner = owner(req);
    const projectId = numericId(req.params.id);
    if (!projectId || !findOwnedProject(projectId, currentOwner)) {
      return response.notFound(res, '转绘项目不存在');
    }
    if (!req.file) return response.badRequest(res, '请上传转绘源片');

    const registeredSources = [];
    try {
      const sources = await uploadService.expandSourceUpload(req.file, uploadLimits, options.probeVideo);
      const items = db.transaction(() => {
        const createdItems = [];
        for (const sourceAsset of sources) {
          const registered = registerSourceAsset(db, log, currentOwner, sourceAsset);
          registeredSources.push(registered);
          const work = redrawService.createWorkFromSource(db, currentOwner, projectId, registered.sourceAsset);
          if (!findOwnedWork(work.id, currentOwner)) {
            throw Object.assign(new Error('转绘项目不存在'), { code: 'REDRAW_PROJECT_NOT_FOUND' });
          }
          if (work.reused === true && registered.asset?.id && Number(work.source_asset_id) !== Number(registered.asset.id)) {
            cleanupRegisteredSource(db, log, registered, uploadLimits.storageRoot);
          }
          createdItems.push(mapWork(work, registered.sourceAsset, {
            analysisQuote: quoteAnalysis(db, log),
          }));
        }
        return createdItems;
      })();
      return response.created(res, { items });
    } catch (error) {
      for (const registered of registeredSources || []) {
        cleanupRegisteredSource(db, log, registered, uploadLimits.storageRoot);
      }
      if (error.code === 'REDRAW_PROJECT_NOT_FOUND') return response.notFound(res, '转绘项目不存在');
      if (String(error.code || '').startsWith('REDRAW_')) return response.badRequest(res, error.message);
      log?.error?.({ err: error }, 'redraw create works failed');
      return response.internalError(res, error.message || '创建转绘作品失败');
    } finally {
      if (req.file?.path) fs.rm(req.file.path, { force: true }, () => {});
    }
  }

  function getWork(req, res) {
    const currentOwner = owner(req);
    const work = findOwnedWork(req.params.id, currentOwner);
    if (!work) return response.error(res, 404, 'REDRAW_WORK_NOT_FOUND', '转绘作品不存在');
    try {
      const currentVersion = findCurrentPromotedVersionForWork(work, currentOwner);
      const analysisTask = findOwnedAnalysisTask(work, currentOwner);
      const localizationTask = findOwnedLocalizationTask(work, currentVersion, currentOwner);
      const assetBatch = findCurrentAssetBatch(currentVersion, currentOwner);
      const projectedWork = { ...work };
      projectedWork.current_version = currentVersion ? Number(currentVersion.version) : 0;
      if (
        Number(projectedWork.current_step) === 2
        && !currentVersion
        && !localizationTask
        && !assetBatch
        && String(analysisTask?.status || '') === 'completed'
      ) {
        projectedWork.current_step = 1;
      }
      const shots = currentVersion ? listOwnedShotRuntime(currentVersion, currentOwner, work) : [];
      const batches = shotService.groupShotsIntoBatches(shots);
      return response.success(res, {
        ...mapWork(projectedWork, null, {
          task: analysisTask,
          versionId: currentVersion?.id || null,
          analysisQuote: quoteAnalysis(db, log),
        }),
        analysis_task: publicTask(analysisTask),
        localization_task: publicTask(localizationTask),
        asset_batch: publicAssetBatch(assetBatch),
        workflow_phase: workflowPhase(projectedWork, analysisTask, localizationTask, assetBatch),
        analysis_billing: analysisBilling(work, currentOwner),
        localization_billing: localizationBilling(work, localizationTask, currentOwner),
        shots,
        batches,
      });
    } catch (error) {
      return sendRedrawError(res, error, '读取转绘作品失败', log, { workId: work.id });
    }
  }

  function referenceTokens(value, assetsById) {
    if (value == null) return [];
    if (!Array.isArray(value)) throw codedRouteError('REDRAW_SHOT_INVALID', 'references 必须是数组');
    return value.map((reference) => {
      if (typeof reference === 'string') return reference;
      if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
        throw codedRouteError('REDRAW_SHOT_INVALID', 'references 项无效');
      }
      const historicalCharacterId = reference.character_asset_id ?? reference.characterAssetId;
      const explicitKind = reference.kind == null ? null : String(reference.kind);
      if (historicalCharacterId != null && explicitKind !== null && explicitKind !== 'character') {
        throw codedRouteError('REDRAW_SHOT_INVALID', '分镜引用包含未知资产');
      }
      const id = Number(
        reference.redraw_asset_id ?? reference.redrawAssetId ?? reference.asset_id ?? reference.assetId
          ?? historicalCharacterId,
      );
      const asset = Number.isSafeInteger(id) ? assetsById.get(id) : null;
      const referenceKind = historicalCharacterId != null ? 'character' : explicitKind;
      if (!asset || (referenceKind && referenceKind !== String(asset.kind))) {
        throw codedRouteError('REDRAW_SHOT_INVALID', '分镜引用包含未知资产');
      }
      if (!asset.localized_name) throw codedRouteError('REDRAW_SHOT_INVALID', '分镜引用资产缺少名称');
      return `@__redraw_asset_${asset.id}`;
    });
  }

  function nextUpdatedAt(previous) {
    const timestamp = new Date().toISOString();
    if (timestamp !== previous) return timestamp;
    return new Date(new Date(previous).getTime() + 1).toISOString();
  }

  function validateGenerationDraft(input) {
    const model = String(input.model || '').trim();
    const duration = Number(input.duration);
    const resolution = String(input.resolution || '').trim();
    const count = Number(input.count);
    if (!model) throw codedRouteError('REDRAW_SHOT_INVALID', 'model 不能为空');
    if (!Number.isSafeInteger(duration) || duration < 5 || duration > 15) {
      throw codedRouteError('REDRAW_SHOT_INVALID', 'duration 必须是 5 到 15 秒的整数');
    }
    if (!resolution) throw codedRouteError('REDRAW_SHOT_INVALID', 'resolution 不能为空');
    if (!Number.isSafeInteger(count) || count !== 1) {
      throw codedRouteError('REDRAW_SHOT_INVALID', '单镜 count 必须为 1');
    }
    return { model, duration, resolution, count: 1 };
  }

  function updateShot(req, res) {
    const currentOwner = owner(req);
    const shot = findOwnedShot(req.params.id, currentOwner);
    if (!shot) return response.error(res, 404, 'REDRAW_SHOT_NOT_FOUND', '转绘镜头不存在');
    if (!['draft', 'failed'].includes(String(shot.status))) {
      return response.error(
        res,
        409,
        'REDRAW_SHOT_EDIT_CONFLICT',
        '当前分镜正在生成或已进入终态，不能原地编辑',
      );
    }
    const body = req.body || {};
    const expectedUpdatedAt = body.expected_updated_at ?? body.expectedUpdatedAt
      ?? body.updated_at ?? body.updatedAt;
    const hasRevision = body.version !== undefined && body.version !== null && body.version !== '';
    if (!expectedUpdatedAt && !hasRevision) {
      return response.error(res, 400, 'REDRAW_SHOT_LOCK_REQUIRED', '更新分镜必须提交 updated_at 或 version');
    }
    try {
      const current = shotService.snapshotShots(db, shot.version_id, currentOwner)
        .find((item) => Number(item.id) === Number(shot.id));
      if (!current) throw codedRouteError('REDRAW_SHOT_NOT_FOUND', '转绘镜头不存在');
      const draft = parseStrictObject(shot.draft_json, 'draft_json');
      const currentRevision = Number(draft.revision ?? 1);
      if (expectedUpdatedAt && String(expectedUpdatedAt) !== String(shot.updated_at)) {
        throw codedRouteError('REDRAW_SHOT_CONFLICT', '分镜已被其他操作更新，请刷新后重试');
      }
      if (hasRevision && (!Number.isSafeInteger(Number(body.version))
        || Number(body.version) !== currentRevision)) {
        throw codedRouteError('REDRAW_SHOT_CONFLICT', '分镜版本已变化，请刷新后重试');
      }

      const assetRows = db.prepare(`SELECT * FROM redraw_assets
        WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL`)
        .all(shot.version_id, currentOwner.tenantId, currentOwner.userId);
      const assetsById = new Map(assetRows.map((asset) => [Number(asset.id), asset]));
      const approvedAssets = assetRows.map((asset) => ({
        ...asset,
        asset_id: asset.id,
        name: `__redraw_asset_${asset.id}`,
        display_name: asset.localized_name,
        identity_binding: asset.kind === 'character'
          ? redrawCharacterIdentityService.identityBindingForAsset(asset)
          : null,
      }));
      const editableKeys = [
        'start_ms', 'end_ms', 'opening_state', 'continuous_action', 'ending_state',
        'shot_type', 'camera_movement', 'composition', 'lighting', 'atmosphere',
        'source_dialogue', 'localized_dialogue', 'speaker', 'speakable_duration_ms',
        'prompt', 'negative_prompt',
      ];
      const normalizedInput = {};
      for (const key of editableKeys) {
        normalizedInput[key] = Object.prototype.hasOwnProperty.call(body, key) ? body[key] : current[key];
      }
      normalizedInput.references = referenceTokens(
        Object.prototype.hasOwnProperty.call(body, 'references') ? body.references : current.references,
        assetsById,
      );
      let normalized;
      try {
        normalized = shotService.normalizeShot(normalizedInput, { approvedAssets });
      } catch (error) {
        throw codedRouteError('REDRAW_SHOT_INVALID', error.message || '转绘分镜内容无效');
      }
      normalized.references = normalized.references.map((reference) => ({
        ...reference,
        name: assetsById.get(Number(reference.asset_id))?.localized_name || reference.name,
      }));
      const generationDraft = validateGenerationDraft({
        model: Object.prototype.hasOwnProperty.call(body, 'model') ? body.model : (current.model || 'seedance 2.0'),
        duration: Object.prototype.hasOwnProperty.call(body, 'duration')
          ? body.duration
          : (current.duration || Math.max(5, Math.min(15, Math.ceil(current.duration_ms / 1000)))),
        resolution: Object.prototype.hasOwnProperty.call(body, 'resolution')
          ? body.resolution
          : (current.resolution || '720p'),
        count: Object.prototype.hasOwnProperty.call(body, 'count') ? body.count : (current.count || 1),
      });
      const compiledPrompt = {
        ...current.compiled_prompt,
        ...normalized,
        ...generationDraft,
        text: normalized.prompt || '',
        prompt: normalized.prompt || '',
        negative_prompt: normalized.negative_prompt || '',
        references: normalized.references,
      };
      delete compiledPrompt.compiled_prompt;
      const nextDraft = {
        ...draft,
        ...normalized,
        ...generationDraft,
        references: normalized.references,
        revision: currentRevision + 1,
      };
      delete nextDraft.compiled_prompt;
      const updatedAt = nextUpdatedAt(shot.updated_at);
      const changed = db.prepare(`UPDATE redraw_shots SET
        start_ms = ?, end_ms = ?, duration_ms = ?,
        source_dialogue_json = ?, localized_dialogue_json = ?, references_json = ?,
        opening_state = ?, continuous_action = ?, ending_state = ?,
        prompt = ?, negative_prompt = ?, compiled_prompt_json = ?, draft_json = ?, updated_at = ?
        WHERE id = ? AND version_id = ? AND tenant_id = ? AND user_id = ?
          AND status IN ('draft', 'failed') AND updated_at = ? AND deleted_at IS NULL`)
        .run(
          normalized.start_ms,
          normalized.end_ms,
          normalized.duration_ms,
          JSON.stringify(normalized.source_dialogue || []),
          JSON.stringify(normalized.localized_dialogue || []),
          JSON.stringify(normalized.references || []),
          normalized.opening_state || '',
          normalized.continuous_action || '',
          normalized.ending_state || '',
          normalized.prompt || '',
          normalized.negative_prompt || '',
          JSON.stringify(compiledPrompt),
          JSON.stringify(nextDraft),
          updatedAt,
          shot.id,
          shot.version_id,
          currentOwner.tenantId,
          currentOwner.userId,
          shot.updated_at,
        );
      if (changed.changes !== 1) {
        const latest = findOwnedShot(shot.id, currentOwner);
        if (latest && !['draft', 'failed'].includes(String(latest.status))) {
          throw codedRouteError('REDRAW_SHOT_EDIT_CONFLICT', '当前分镜正在生成或已进入终态，不能原地编辑');
        }
        throw codedRouteError('REDRAW_SHOT_CONFLICT', '分镜已被其他操作更新，请刷新后重试');
      }
      const raw = findOwnedShot(shot.id, currentOwner);
      const snapshot = shotService.snapshotShots(db, shot.version_id, currentOwner)
        .find((item) => Number(item.id) === Number(shot.id));
      return response.success(res, shotRuntime(raw, snapshot, currentOwner));
    } catch (error) {
      return sendRedrawError(res, error, '更新转绘分镜失败', log, { shotId: shot.id });
    }
  }

  function generationContext(currentOwner) {
    return {
      storageRoot: storageRootFromConfig(cfg),
      ...(options.generationOptions || {}),
      db,
      log,
      tenantId: currentOwner.tenantId,
      userId: currentOwner.userId,
      canReadArtifact,
      localeVerifier: options.localeVerifier,
    };
  }

  async function generateShot(req, res) {
    const currentOwner = owner(req);
    const shot = findOwnedShot(req.params.id, currentOwner);
    if (!shot) return response.error(res, 404, 'REDRAW_SHOT_NOT_FOUND', '转绘镜头不存在');
    try {
      const safe = singleGenerationInput(req.body);
      const input = { ...safe.input, shotId: shot.id };
      const result = safe.retry
        ? await generationService.retryShot(generationContext(currentOwner), input)
        : await generationService.generateShot(generationContext(currentOwner), input);
      return response.accepted(res, { shot_id: shot.id, ...result });
    } catch (error) {
      return sendRedrawError(res, error, '提交转绘单镜生成失败', log, { shotId: shot.id });
    }
  }

  async function generateBatch(req, res) {
    const currentOwner = owner(req);
    const work = findOwnedWork(req.params.id, currentOwner);
    if (!work) return response.error(res, 404, 'REDRAW_WORK_NOT_FOUND', '转绘作品不存在');
    const body = req.body || {};
    if (Object.prototype.hasOwnProperty.call(body, 'shot_id')
      || Object.prototype.hasOwnProperty.call(body, 'shotId')) {
      return response.error(res, 400, 'REDRAW_BATCH_INPUT_INVALID', '批量生成不接受单镜 shot_id 或 shotId');
    }
    try {
      const input = batchGenerationInput(body);
      const version = findVersionForWork(work, work.current_version, currentOwner);
      if (!version) throw codedRouteError('REDRAW_VERSION_CONFLICT', '转绘作品没有可生成的当前版本');
      if (input.version_id !== undefined || input.versionId !== undefined) {
        const versionId = numericId(input.version_id ?? input.versionId);
        if (!versionId) throw generationInputError('version_id 无效');
        if (Number(version.id) !== versionId) {
          throw codedRouteError('REDRAW_VERSION_CONFLICT', '只能生成作品当前版本');
        }
      }
      delete input.version_id;
      delete input.versionId;
      input.versionId = version.id;
      const result = await generationService.generateBatch(generationContext(currentOwner), input);
      return response.accepted(res, result);
    } catch (error) {
      return sendRedrawError(res, error, '提交转绘批量生成失败', log, { workId: work.id });
    }
  }

  async function nativeAudioReview(req, res) {
    const currentOwner = owner(req);
    const shot = findOwnedShot(req.params.id, currentOwner);
    if (!shot) return response.error(res, 404, 'REDRAW_SHOT_NOT_FOUND', '转绘镜头不存在');
    try {
      const input = {
        ...nativeAudioReviewInput(req.body || {}),
        shotId: shot.id,
      };
      const result = await generationService.reviewNativeAudio(generationContext(currentOwner), input);
      return response.accepted(res, { shot_id: shot.id, ...result });
    } catch (error) {
      return sendRedrawError(res, error, '审核原生音轨失败', log, { shotId: shot.id });
    }
  }

  function localizationQuote(req, res) {
    const currentOwner = owner(req);
    const work = findOwnedWork(req.params.id, currentOwner);
    if (!work) return response.error(res, 404, 'REDRAW_WORK_NOT_FOUND', '转绘作品不存在');
    try {
      rejectLocalizationClientControl(req.body || {});
      const quote = localizationOrchestrator.quoteLocalization(
        db,
        localizationQuoteInput(req.body || {}, work, currentOwner, canReadArtifact),
      );
      if (!quote?.priced) {
        return response.error(
          res,
          409,
          quote?.code || 'pricing_unconfigured',
          '本地化模型暂不可报价',
          quote ? { quote } : undefined,
        );
      }
      return response.success(res, quote);
    } catch (error) {
      return sendLocalizationError(res, error, '读取本地化报价失败', log, { workId: work.id });
    }
  }

  async function createVersion(req, res) {
    const currentOwner = owner(req);
    const work = findOwnedWork(req.params.id, currentOwner);
    if (!work) return response.error(res, 404, 'REDRAW_WORK_NOT_FOUND', '转绘作品不存在');
    try {
      rejectLocalizationClientControl(req.body || {});
      if (localizationOrchestrator === redrawLocalizationOrchestrator && typeof options.localizationProvider !== 'function') {
        return response.error(res, 409, 'REDRAW_LOCALIZATION_PROVIDER_UNAVAILABLE', '本地化供应商未配置');
      }
      const result = localizationOrchestrator.startLocalization(
        db,
        log,
        localizationStartInput(req.body || {}, work, currentOwner, canReadArtifact),
        {
          provider: options.localizationProvider,
          schedule: options.localizationSchedule,
          canReadArtifact,
        },
      );
      const versionId = result.version_id ?? result.draft_version_id ?? null;
      const status = result.status ?? result.task?.status ?? 'pending';
      return response.accepted(res, {
        task_id: result.task_id,
        version_id: versionId == null ? null : Number(versionId),
        status,
        current_step: 1,
        billing: localizationBillingPayload(result),
      });
    } catch (error) {
      return sendLocalizationError(res, error, '提交本地化任务失败', log, { workId: work.id });
    }
  }

  function listVersionAssets(req, res) {
    const currentOwner = owner(req);
    const version = findOwnedVersion(req.params.id, currentOwner);
    if (!version) return response.notFound(res, '本地化版本不存在');
    return response.success(res, redrawAssetService.listAssets(db, {
      versionId: version.id,
      tenantId: currentOwner.tenantId,
      userId: currentOwner.userId,
    }, { kind: req.query?.kind }));
  }

  function previewRedrawAsset(req, res) {
    const currentOwner = owner(req);
    const redrawAsset = findOwnedAsset(req.params.id, currentOwner);
    if (!redrawAsset) return response.notFound(res, '资产预览不存在');
    const variant = String(req.params.variant || '').trim().toLowerCase();
    const providerAssetId = variant === 'primary'
      ? redrawAsset.asset_id
      : variant === 'clean_plate' && redrawAsset.kind === 'scene'
        ? redrawAsset.clean_plate_asset_id
        : null;
    if (!providerAssetId) return response.notFound(res, '资产预览不存在');
    const providerAsset = db.prepare(
      'SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL',
    ).get(Number(providerAssetId));
    const mime = String(providerAsset?.mime_type || '').trim().toLowerCase();
    if (!providerAsset || providerAsset.type !== 'image'
      || !/^image\/(?:png|jpe?g|webp|avif)$/.test(mime)) {
      return response.notFound(res, '资产预览不存在');
    }
    const root = storageRootFromConfig(cfg);
    const candidate = safeStoragePath(root, providerAsset.local_path);
    let absolutePath;
    try {
      const realRoot = fs.realpathSync(root);
      const realCandidate = candidate ? fs.realpathSync(candidate) : null;
      const relative = realCandidate ? path.relative(realRoot, realCandidate) : '';
      if (!realCandidate || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return response.notFound(res, '资产预览不存在');
      }
      absolutePath = realCandidate;
    } catch (_) {
      return response.notFound(res, '资产预览不存在');
    }
    if (typeof res.setHeader === 'function') {
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
    if (typeof res.sendFile === 'function') {
      return res.sendFile(absolutePath, (error) => {
        if (error && !res.headersSent) response.notFound(res, '资产预览不存在');
      });
    }
    const stream = fs.createReadStream(absolutePath);
    stream.once('error', () => {
      if (!res.headersSent) response.notFound(res, '资产预览不存在');
      else if (typeof res.destroy === 'function') res.destroy();
    });
    return stream.pipe(res);
  }

  function listProductionVoices(req, res) {
    const currentOwner = owner(req);
    const version = findOwnedVersion(req.params.id, currentOwner);
    if (!version) return response.notFound(res, '本地化版本不存在');
    return response.success(res, productionVoicesForVersion(version, currentOwner));
  }

  function previewProductionVoice(req, res) {
    const currentOwner = owner(req);
    const version = findOwnedVersion(req.params.versionId, currentOwner);
    if (!version) return response.notFound(res, '音色预览不存在');
    const voice = productionVoiceRowsForVersion(version, currentOwner)
      .find((item) => Number(item.id) === Number(req.params.voiceAssetId));
    if (!voice) return response.notFound(res, '音色预览不存在');
    const root = storageRootFromConfig(cfg);
    const candidate = safeStoragePath(root, voice.audio_asset?.local_path);
    let absolutePath;
    try {
      const realRoot = fs.realpathSync(root);
      const realCandidate = candidate ? fs.realpathSync(candidate) : null;
      const relative = realCandidate ? path.relative(realRoot, realCandidate) : '';
      if (!realCandidate || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return response.notFound(res, '音色预览不存在');
      }
      absolutePath = realCandidate;
    } catch (_) {
      return response.notFound(res, '音色预览不存在');
    }
    const mime = String(voice.audio_asset.mime_type || 'audio/mpeg');
    if (!mime.startsWith('audio/')) return response.notFound(res, '音色预览不存在');
    if (typeof res.setHeader === 'function') {
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
    if (typeof res.sendFile === 'function') {
      return res.sendFile(absolutePath, (error) => {
        if (error && !res.headersSent) response.notFound(res, '音色预览不存在');
      });
    }
    const stream = fs.createReadStream(absolutePath);
    stream.once('error', () => {
      if (!res.headersSent) response.notFound(res, '音色预览不存在');
      else if (typeof res.destroy === 'function') res.destroy();
    });
    return stream.pipe(res);
  }

  function assignVoice(req, res) {
    const currentOwner = owner(req);
    const character = findOwnedAsset(req.params.id, currentOwner);
    if (!character || character.kind !== 'character') {
      return response.error(res, 404, 'REDRAW_CHARACTER_ASSET_NOT_FOUND', '角色资产不存在');
    }
    const version = findOwnedVersion(character.version_id, currentOwner);
    if (!version) return response.notFound(res, '本地化版本不存在');

    let input;
    try {
      input = voiceAssignmentInput(req.body);
    } catch (error) {
      return response.error(res, 400, error.code, error.message);
    }
    const voiceRow = db.prepare(`
      SELECT *
      FROM redraw_assets
      WHERE id = ?
        AND version_id = ?
        AND tenant_id = ?
        AND user_id = ?
        AND kind = 'voice'
        AND deleted_at IS NULL
    `).get(
      input.voiceAssetId,
      Number(version.id),
      currentOwner.tenantId,
      currentOwner.userId,
    );
    if (!voiceRow) {
      return response.error(res, 404, 'REDRAW_VOICE_ASSET_NOT_FOUND', '音色资产不存在');
    }
    const productionVoice = productionVoicesForVersion(version, currentOwner)
      .find((voice) => Number(voice.id) === input.voiceAssetId);
    if (!productionVoice) {
      return response.error(res, 409, 'REDRAW_VOICE_NOT_PRODUCTION', '音色未通过真实生成或产物可读验证');
    }
    if (input.expectedUpdatedAt !== undefined
      && String(character.updated_at || '') !== input.expectedUpdatedAt) {
      return response.error(res, 409, 'REDRAW_VOICE_BIND_CONFLICT', '角色资产已被更新，请刷新后重试');
    }

    try {
      const evidence = redrawVoiceService.evidenceFromPayload(voiceRow.source_ref_json);
      const assigned = redrawVoiceService.assignVoice(db, character.id, evidence, {
        expectedUpdatedAt: input.expectedUpdatedAt,
        tenantId: currentOwner.tenantId,
        userId: currentOwner.userId,
        versionId: Number(version.id),
        voiceAssetId: Number(voiceRow.id),
        canReadAsset: (asset) => Boolean(asset && canReadArtifact(asset.id)),
      });
      if (assigned.conflict) {
        return response.error(res, 409, 'REDRAW_VOICE_BIND_CONFLICT', '角色已绑定其他音色');
      }
      const asset = redrawAssetService.listAssets(db, {
        versionId: version.id,
        tenantId: currentOwner.tenantId,
        userId: currentOwner.userId,
      }, { kind: 'character' }).find((item) => Number(item.id) === Number(character.id));
      return response.success(res, {
        conflict: false,
        asset,
        voice_snapshot: assigned.snapshot,
      });
    } catch (error) {
      if (String(error.code || '').startsWith('REDRAW_VOICE_')) {
        return response.error(res, 409, error.code, error.message);
      }
      if (error.code === 'REDRAW_CHARACTER_ASSET_NOT_FOUND') {
        return response.error(res, 404, error.code, error.message);
      }
      log?.error?.({ err: error, assetId: character.id }, 'redraw voice assignment failed');
      return response.internalError(res, error.message || '绑定音色失败');
    }
  }

  async function assetBatchQuote(req, res) {
    const currentOwner = owner(req);
    const version = findOwnedVersion(req.params.id, currentOwner);
    if (!version) return response.notFound(res, '本地化版本不存在');
    try {
      assertCurrentPromotedAssetBatchVersion(version, currentOwner);
    } catch (error) {
      return sendAssetBatchError(res, error, '批量资产版本不可用', log, { versionId: req.params.id });
    }
    let input;
    try {
      input = assetBatchQuoteInput(req.body);
    } catch (error) {
      return sendAssetBatchError(res, error, '批量资产报价参数无效', log, { versionId: req.params.id });
    }
    try {
      const quote = await assetBatchService.quoteAssetBatch(assetBatchContext(version, currentOwner), input);
      if (quote?.priced === false) {
        return response.error(
          res,
          409,
          'REDRAW_ASSET_BATCH_UNPRICED',
          '批量资产存在未验证能力或未配置价格',
          quote,
        );
      }
      return response.success(res, quote);
    } catch (error) {
      return sendAssetBatchError(res, error, '批量资产报价失败', log, { versionId: version.id });
    }
  }

  async function createAssetBatch(req, res) {
    const currentOwner = owner(req);
    const version = findOwnedVersion(req.params.id, currentOwner);
    if (!version) return response.notFound(res, '本地化版本不存在');
    try {
      assertCurrentPromotedAssetBatchVersion(version, currentOwner);
    } catch (error) {
      return sendAssetBatchError(res, error, '批量资产版本不可用', log, { versionId: req.params.id });
    }
    let input;
    try {
      input = assetBatchCreateInput(req.body);
    } catch (error) {
      return sendAssetBatchError(res, error, '批量资产生成参数无效', log, { versionId: req.params.id });
    }
    const ctx = assetBatchContext(version, currentOwner);
    if (typeof ctx.provider !== 'function') {
      return response.error(
        res,
        409,
        'REDRAW_ASSET_PROVIDER_REQUIRED',
        '资产生成能力尚未配置',
      );
    }
    try {
      const result = assetBatchService.startAssetBatch(ctx, input);
      if (result && typeof result.then === 'function') {
        throw new Error('assetBatchService.startAssetBatch must return synchronously');
      }
      return response.accepted(res, assetBatchResponsePayload(
        result,
        assetBatchBillingPayload(db, result, currentOwner),
      ));
    } catch (error) {
      return sendAssetBatchError(res, error, '提交批量资产生成失败', log, { versionId: version.id });
    }
  }

  function dialogueQuote(req, res) {
    const currentOwner = owner(req);
    const version = findOwnedVersion(req.params.id, currentOwner);
    if (!version) return response.notFound(res, '本地化版本不存在');
    try {
      rejectDialogueClientControl(req.body || {});
      const quote = dialogueOrchestrator.quoteDialogue(db, dialogueContext(version, currentOwner));
      if (quote.status !== 'ready') {
        return response.error(res, 409, 'REDRAW_DIALOGUE_PLAN_NOT_READY', '配音计划需要重写', { quote });
      }
      return response.success(res, quote);
    } catch (error) {
      return sendDialogueError(res, error, '读取配音报价失败', log, { versionId: version.id });
    }
  }

  async function startDialogue(req, res) {
    const currentOwner = owner(req);
    const version = findOwnedVersion(req.params.id, currentOwner);
    if (!version) return response.notFound(res, '本地化版本不存在');
    let input;
    try {
      input = dialogueStartInput(req.body || {});
    } catch (error) {
      return sendDialogueError(res, error, '配音参数无效', log, { versionId: version.id });
    }
    const provider = options.dialogueProvider;
    if (typeof provider !== 'function') {
      return response.error(res, 409, 'REDRAW_DIALOGUE_PROVIDER_REQUIRED', '配音生成能力尚未配置');
    }
    try {
      const ctx = dialogueContext(version, currentOwner);
      const result = dialogueOrchestrator.startDialogue(db, log, ctx, input, {
        schedule: options.dialogueSchedule,
        canReadAudioAsset: ctx.canReadAudioAsset,
        localeVerifier: options.localeVerifier,
        synthesizeSegment: (segment) => provider({
          taskId: segment.task_id,
          versionId: Number(version.id),
          model: segment.model,
          locale: version.locale,
          segment,
          kind: 'dialogue',
        }),
      });
      return response.accepted(res, {
        task_id: result.task_id,
        status: result.status || 'pending',
        quote: result.quote,
      });
    } catch (error) {
      return sendDialogueError(res, error, '提交配音任务失败', log, { versionId: version.id });
    }
  }

  function getDialogueTask(req, res) {
    const currentOwner = owner(req);
    const version = findOwnedVersion(req.params.id, currentOwner);
    if (!version) return response.notFound(res, '本地化版本不存在');
    const row = db.prepare(`
      SELECT *
      FROM async_tasks
      WHERE id = ? AND type = 'redraw_dialogue'
        AND resource_id LIKE ?
        AND tenant_id = ? AND user_id = ?
        AND deleted_at IS NULL
      LIMIT 1
    `).get(
      String(req.params.taskId || ''),
      `redraw_dialogue:${Number(version.id)}:%`,
      currentOwner.tenantId,
      currentOwner.userId,
    );
    if (!row) return response.error(res, 404, 'REDRAW_DIALOGUE_TASK_NOT_FOUND', '配音任务不存在');
    return response.success(res, dialogueTaskPayload(row));
  }

  function scheduleCompositionRun(ctx, exportId) {
    const failSchedule = () => {
      db.prepare(`
        UPDATE redraw_exports
        SET status = 'failed',
            error_code = 'REDRAW_COMPOSITION_SCHEDULE_FAILED',
            error_message = 'composition scheduler failed',
            updated_at = ?
        WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'pending'
      `).run(new Date().toISOString(), Number(exportId), String(ctx.tenantId), String(ctx.userId));
    };
    const job = () => Promise.resolve()
      .then(() => compositionService.runComposition(ctx, Number(exportId)))
      .catch((error) => {
        log?.error?.({ err: error, exportId }, 'redraw composition background run failed');
      });
    if (typeof options.compositionSchedule === 'function') {
      try {
        const scheduled = options.compositionSchedule(job, { exportId: Number(exportId), versionId: ctx.versionId });
        if (scheduled && typeof scheduled.then === 'function') {
          scheduled.catch((error) => {
            failSchedule();
            log?.error?.({ err: error, exportId }, 'redraw composition scheduler rejected');
          });
        }
        return scheduled;
      } catch (error) {
        failSchedule();
        throw error;
      }
    }
    queueMicrotask(job);
    return undefined;
  }

  async function composeVersion(req, res) {
    const currentOwner = owner(req);
    const version = findOwnedVersion(req.params.id, currentOwner);
    if (!version) return response.notFound(res, '本地化版本不存在');
    let input;
    try {
      input = compositionStartInput(req.body || {});
    } catch (error) {
      return sendCompositionError(res, error, '合成参数无效', log, { versionId: req.params.id });
    }
    try {
      const ctx = compositionContext(version, currentOwner);
      const exportRow = await compositionService.createComposition(ctx, {
        versionId: Number(version.id),
        idempotencyKey: input.idempotencyKey,
        audioMode: input.audioMode,
      });
      if (exportRow?.created === true) {
        scheduleCompositionRun(ctx, Number(exportRow.id));
      }
      return response.accepted(res, {
        export_id: Number(exportRow.id),
        status: exportRow.status,
        version_number: Number(exportRow.version_number),
        created: exportRow.created === true,
      });
    } catch (error) {
      return sendCompositionError(res, error, '提交合成任务失败', log, { versionId: version.id });
    }
  }

  function listVersionExports(req, res) {
    const currentOwner = owner(req);
    const version = findOwnedVersion(req.params.id, currentOwner);
    if (!version) return response.notFound(res, '本地化版本不存在');
    const rows = db.prepare(`
      SELECT *
      FROM redraw_exports
      WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
      ORDER BY version_number DESC, id DESC
    `).all(Number(version.id), currentOwner.tenantId, currentOwner.userId);
    return response.success(res, rows.map(exportSummary));
  }

  function getExport(req, res) {
    const currentOwner = owner(req);
    const row = db.prepare(`
      SELECT *
      FROM redraw_exports
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(Number(req.params.id), currentOwner.tenantId, currentOwner.userId);
    if (!row) return response.notFound(res, '转绘导出不存在');
    return response.success(res, exportSummary(row));
  }

  async function downloadExport(req, res) {
    const currentOwner = owner(req);
    try {
      const artifact = await exportService.resolveDownloadArtifact(exportContext(currentOwner), {
        exportId: req.params.id,
        kind: req.params.kind,
      });
      if (typeof res.sendFile === 'function') {
        res.setHeader('Content-Type', artifact.mime_type);
        res.setHeader('Content-Length', String(artifact.size));
        res.setHeader('X-Content-SHA256', artifact.sha256);
        res.setHeader('Content-Disposition', `attachment; filename="${String(artifact.filename).replace(/["\\]/g, '')}"`);
        return res.sendFile(artifact.absolute_path, (error) => {
          if (error && !res.headersSent) {
            sendCompositionError(res, error, '下载导出产物失败', log, { exportId: req.params.id });
          }
        });
      }
      return new Promise((resolve) => {
        const stream = fs.createReadStream(artifact.absolute_path);
        let headersWritten = false;
        let resolved = false;
        const done = () => {
          if (!resolved) {
            resolved = true;
            resolve();
          }
        };
        stream.once('error', (error) => {
          if (!headersWritten && !res.headersSent) {
            sendCompositionError(res, error, '下载导出产物失败', log, { exportId: req.params.id });
          } else if (typeof res.destroy === 'function') {
            res.destroy();
          } else if (typeof stream.destroy === 'function') {
            stream.destroy();
          }
          done();
        });
        stream.once('open', () => {
          headersWritten = true;
          res.setHeader('Content-Type', artifact.mime_type);
          res.setHeader('Content-Length', String(artifact.size));
          res.setHeader('X-Content-SHA256', artifact.sha256);
          res.setHeader('Content-Disposition', `attachment; filename="${String(artifact.filename).replace(/["\\]/g, '')}"`);
          stream.pipe(res);
          done();
        });
      });
    } catch (error) {
      return sendCompositionError(res, error, '下载导出产物失败', log, { exportId: req.params.id });
    }
  }

  function generationGate(req, res) {
    const currentOwner = owner(req);
    try {
      return response.success(res, redrawReviewService.evaluateGenerationGate(db, req.params.id, currentOwner));
    } catch (error) {
      if (error.code === 'REDRAW_VERSION_NOT_FOUND') return response.notFound(res, '本地化版本不存在');
      return response.internalError(res, error.message || '读取生成审核门禁失败');
    }
  }

  async function resolveAssetQuote(asset, currentOwner) {
    if (asset.kind === 'voice') {
      const batchQuote = await assetBatchService.quoteAssetBatch({
        db,
        versionId: Number(asset.version_id),
        tenantId: currentOwner.tenantId,
        userId: currentOwner.userId,
        canReadArtifact,
        assetReader: {
          canRead: (row) => Boolean(row && canReadArtifact(row.id)),
        },
        localeVerifier: options.localeVerifier,
      }, { assetIds: [Number(asset.id)] });
      const item = batchQuote.items?.find((entry) => Number(entry.asset_id) === Number(asset.id));
      return {
        asset_id: Number(asset.id),
        capability: item?.capability || 'tts',
        provider: item?.provider || null,
        model: item?.model || null,
        evidence: item?.evidence || null,
        ai_service_config_id: item?.ai_service_config_id || null,
        config_updated_at: item?.config_updated_at || null,
        locale_pack: item?.locale_pack || null,
        model_manifest_sha256: item?.model_manifest_sha256 || null,
        calibration_manifest_sha256: item?.calibration_manifest_sha256 || null,
        credits: item?.priced ? Number(item.credits) : null,
        priced: batchQuote.priced === true && item?.priced === true,
        quote_hash: batchQuote.quote_hash,
        blocking: item?.blocking || batchQuote.blocked?.[0] || null,
      };
    }
    const quoteProvider = options.assetQuoteProvider;
    const quote = typeof quoteProvider === 'function'
      ? await quoteProvider({ asset, tenantId: currentOwner.tenantId, userId: currentOwner.userId })
      : { credits: asset.quote_credits ?? null, model: asset.model || null };
    const credits = Number(quote?.credits);
    const validCredits = Number.isSafeInteger(credits) && credits > 0;
    const model = String(quote?.model || '').trim() || null;
    return {
      asset_id: Number(asset.id),
      model,
      credits: validCredits ? credits : null,
      priced: validCredits && Boolean(model),
    };
  }

  async function assetQuote(req, res) {
    const currentOwner = owner(req);
    const asset = findOwnedAsset(req.params.id, currentOwner);
    if (!asset) return response.notFound(res, '转绘资产不存在');
    try {
      const quote = await resolveAssetQuote(asset, currentOwner);
      return response.success(res, {
        asset_id: quote.asset_id,
        model: quote.model,
        credits: quote.credits,
        priced: quote.priced,
        ...(quote.quote_hash ? { quote_hash: quote.quote_hash } : {}),
      });
    } catch (error) {
      if (String(error.code || '').startsWith('MODEL_') || error.code === 'INVALID_MODEL_PRICE') {
        return response.success(res, { asset_id: Number(asset.id), model: null, credits: null, priced: false });
      }
      log?.error?.({ err: error, assetId: asset.id }, 'redraw asset quote failed');
      return response.internalError(res, error.message || '读取资产报价失败');
    }
  }

  function saveRedrawCharacterIdentityPack(req, res) {
    const currentOwner = owner(req);
    const asset = findOwnedAsset(req.params.id, currentOwner);
    if (!asset) {
      return response.error(res, 404, 'REDRAW_ASSET_NOT_FOUND', '转绘资产不存在');
    }
    try {
      const saved = redrawCharacterIdentityService.saveIdentityPack({
        db,
        assetId: Number(asset.id),
        versionId: Number(asset.version_id),
        tenantId: currentOwner.tenantId,
        userId: currentOwner.userId,
        reviewerId: currentOwner.userId,
        storageRoot: storageRootFromConfig(cfg),
        canReadArtifact,
        assetReader: {
          canRead: (row) => Boolean(row && canReadArtifact(row.id)),
        },
      }, asset.id, identityPackInput(req.body));
      const projected = redrawAssetService.listAssets(db, {
        versionId: Number(asset.version_id),
        tenantId: currentOwner.tenantId,
        userId: currentOwner.userId,
      }).find((item) => Number(item.id) === Number(saved.id));
      if (!projected) {
        throw codedRouteError('REDRAW_IDENTITY_PROJECTION_FAILED', '保存角色身份包后无法读取当前资产投影');
      }
      const safeAsset = sanitizeIdentityPackResponse(projected);
      return response.success(res, {
        asset: safeAsset,
        identity_pack: safeAsset.identity_pack,
        identity_pack_status: safeAsset.identity_pack_status,
        version_id: Number(asset.version_id),
        status: 'asset_review',
        current_step: 2,
      });
    } catch (error) {
      if (['REDRAW_ASSET_NOT_FOUND', 'REDRAW_IDENTITY_ASSET_NOT_FOUND'].includes(error.code)) {
        return response.error(res, 404, 'REDRAW_ASSET_NOT_FOUND', '转绘资产不存在');
      }
      if (['REDRAW_IDENTITY_CONFLICT', 'REDRAW_CHARACTER_IDENTITY_CONFLICT'].includes(error.code)) {
        return response.error(res, 409, error.code, error.message || '角色资产已被其他操作更新');
      }
      return sendRedrawError(res, error, '保存角色身份包失败', log, { assetId: asset.id });
    }
  }

  function updateRedrawAsset(req, res) {
    const currentOwner = owner(req);
    const asset = findOwnedAsset(req.params.id, currentOwner);
    if (!asset) return response.notFound(res, '转绘资产不存在');
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'approval_status')
      || Object.prototype.hasOwnProperty.call(req.body || {}, 'approvalStatus')) {
      return response.badRequest(res, '审核状态只能通过审核接口修改');
    }
    const updated = redrawAssetService.updateAsset(db, {
      versionId: asset.version_id,
      tenantId: currentOwner.tenantId,
      userId: currentOwner.userId,
    }, asset.id, {
      localizedName: req.body?.localized_name ?? req.body?.localizedName,
      localizedDescription: req.body?.localized_description ?? req.body?.localizedDescription,
      prompt: req.body?.prompt,
    });
    return response.success(res, updated);
  }

  async function generateRedrawAsset(req, res) {
    const currentOwner = owner(req);
    const asset = findOwnedAsset(req.params.id, currentOwner);
    if (!asset) return response.notFound(res, '转绘资产不存在');
    const clientControlledFields = [
      'model',
      'credit_amount',
      'creditAmount',
      'credits',
      'provider',
      'capability',
      'evidence',
      'snapshot',
      'ai_service_config_id',
      'config_updated_at',
      'quote',
      'reservation',
      'reservation_id',
      'credit_reservation_id',
    ];
    if (clientControlledFields.some((field) => Object.prototype.hasOwnProperty.call(req.body || {}, field))) {
      return response.error(
        res,
        400,
        'REDRAW_ASSET_CLIENT_CONTROL_FORBIDDEN',
        '资产生成模型与积分只能由服务端报价决定',
      );
    }
    const sourcePayload = parseJSON(asset.source_ref_json, {});
    const provider = options.assetGenerationProvider || options.assetProvider;
    if (typeof provider !== 'function') return response.badRequest(res, '资产生成能力尚未配置');
    try {
      const quote = await resolveAssetQuote(asset, currentOwner);
      const voiceInputChanged = asset.kind === 'voice' && [
        ['prompt', asset.prompt],
        ['localized_name', asset.localized_name],
        ['localizedName', asset.localized_name],
        ['localized_description', asset.localized_description],
        ['localizedDescription', asset.localized_description],
      ].some(([field, persisted]) => Object.prototype.hasOwnProperty.call(req.body || {}, field)
        && String(req.body[field] ?? '') !== String(persisted ?? ''));
      if (asset.kind === 'voice'
        && (String(req.body?.quote_hash || '').trim() !== String(quote.quote_hash || '').trim()
          || voiceInputChanged)) {
        return response.error(
          res,
          409,
          'REDRAW_ASSET_QUOTE_CHANGED',
          '音色生成报价已变化，请重新确认',
          { quote: {
            asset_id: quote.asset_id,
            model: quote.model,
            credits: quote.credits,
            priced: quote.priced,
            quote_hash: quote.quote_hash,
          } },
        );
      }
      if (!quote.priced) {
        return response.error(res, 409, 'pricing_unconfigured', '资产生成积分待管理员配置');
      }
      const generated = await redrawAssetService.generateAsset({
        db,
        versionId: asset.version_id,
        tenantId: currentOwner.tenantId,
        userId: currentOwner.userId,
        provider,
        model: quote.model,
        creditAmount: quote.credits,
        assetReader: {
          canRead: (row) => Boolean(row && typeof canReadArtifact === 'function' && canReadArtifact(row.id)),
        },
      }, {
        kind: asset.kind,
        sourceRef: sourcePayload.source_ref || sourcePayload.source || {},
        localizedName: asset.kind === 'voice' ? asset.localized_name : req.body?.localized_name ?? asset.localized_name,
        localizedDescription: asset.kind === 'voice' ? asset.localized_description : req.body?.localized_description ?? asset.localized_description,
        prompt: asset.kind === 'voice' ? asset.prompt : req.body?.prompt ?? asset.prompt,
        model: quote.model,
        creditAmount: quote.credits,
        snapshot: {
          capability: quote.capability,
          provider: quote.provider,
          model: quote.model,
          evidence: quote.evidence,
          ai_service_config_id: quote.ai_service_config_id,
          config_updated_at: quote.config_updated_at,
          locale_pack: quote.locale_pack,
          model_manifest_sha256: quote.model_manifest_sha256,
          calibration_manifest_sha256: quote.calibration_manifest_sha256,
          credits: quote.credits,
          quote_hash: quote.quote_hash,
        },
      });
      return response.accepted(res, {
        asset: generated,
        version_id: Number(asset.version_id),
        status: generated.status,
        current_step: 2,
      });
    } catch (error) {
      if (String(error.code || '').startsWith('MODEL_') || error.code === 'INVALID_MODEL_PRICE') {
        return response.error(res, 409, 'pricing_unconfigured', '资产生成积分待管理员配置');
      }
      if (String(error.code || '').startsWith('REDRAW_') || error.code === 'ASSET_NOT_READABLE') {
        return response.badRequest(res, error.message);
      }
      log?.error?.({ err: error, assetId: asset.id }, 'redraw asset generation failed');
      return response.internalError(res, error.message || '生成转绘资产失败');
    }
  }

  function reviewRedrawAsset(req, res) {
    const currentOwner = owner(req);
    const asset = findOwnedAsset(req.params.id, currentOwner);
    if (!asset) return response.notFound(res, '转绘资产不存在');
    try {
      const reviewed = redrawReviewService.reviewAsset(db, asset.id, {
        action: req.body?.action,
        expected_updated_at: req.body?.expected_updated_at ?? req.body?.expectedUpdatedAt,
        reviewerId: currentOwner.userId,
        tenantId: currentOwner.tenantId,
        userId: currentOwner.userId,
      });
      const gate = redrawReviewService.evaluateGenerationGate(db, asset.version_id, currentOwner);
      return response.success(res, {
        asset: reviewed,
        gate,
        version_id: Number(asset.version_id),
        status: gate.ok ? 'ready_to_generate' : 'asset_review',
        current_step: gate.current_step,
        updated_at: reviewed.updated_at,
      });
    } catch (error) {
      if (error.code === 'REDRAW_ASSET_NOT_FOUND') return response.notFound(res, '转绘资产不存在');
      if (error.code === 'REDRAW_REVIEW_CONFLICT') return response.error(res, 409, error.code, error.message);
      if (String(error.code || '').startsWith('REDRAW_REVIEW_')) return response.badRequest(res, error.message);
      log?.error?.({ err: error, assetId: asset.id }, 'redraw asset review failed');
      return response.internalError(res, error.message || '审核转绘资产失败');
    }
  }

  function listStylePresets(_req, res) {
    const rows = capabilityService.listPublicStylePresets(db, canReadArtifact);
    return response.success(res, rows.map(mapStylePreset));
  }

  function listLocales(_req, res) {
    return response.success(res, capabilityService.listLocaleCapabilities(db, canReadArtifact));
  }

  async function analyzeWork(req, res) {
    const currentOwner = owner(req);
    const work = findOwnedWork(req.params.id, currentOwner);
    if (!work) return response.notFound(res, '转绘作品不存在');

    let referenceAsset = null;
    try {
      const analysisSettings = normalizeAnalysisSettings(req.body || {});
      if (req.file) {
        if (!analysisSettings.free_style) {
          throw Object.assign(new Error('参考图只能随自由风格提交'), { code: 'INVALID_REDRAW_ANALYSIS_SETTINGS' });
        }
        referenceAsset = registerReferenceImage(db, log, currentOwner, req.file, cfg, uploadLimits);
        analysisSettings.free_style.reference = {
          ...(analysisSettings.free_style.reference || {}),
          filename: req.file.originalname || analysisSettings.free_style.reference?.filename || 'style-reference.png',
          id: String(referenceAsset.id),
          asset_id: referenceAsset.id,
          url: referenceAsset.url,
          local_path: referenceAsset.local_path,
        };
      }
      const result = await orchestrator.startAnalysis(db, log, {
        workId: work.id,
        userId: currentOwner.userId,
        tenantId: currentOwner.tenantId,
        sourceAssetId: work.source_asset_id,
        analysisSettings,
      }, analysisOptions);
      return response.created(res, {
        task_id: result.task_id,
        provider_task_id: result.provider_task_id || null,
        billing: billingPayload(result.billing),
        current_step: Number(result.current_step || 1),
        status: result.status || 'processing',
        facts_hash: result.facts_hash || null,
      });
    } catch (error) {
      cleanupReferenceImage(db, log, referenceAsset, uploadLimits.storageRoot);
      if (error.code === 'REDRAW_WORK_NOT_FOUND') return response.notFound(res, '转绘作品不存在');
      if (['INSUFFICIENT_CREDITS'].includes(error.code)) {
        return response.error(res, 402, error.code, error.message);
      }
      if (String(error.code || '').startsWith('REDRAW_') || error.code === 'SOURCE_ASSET_REQUIRED') {
        return response.badRequest(res, error.message);
      }
      if (error.code === 'INVALID_REDRAW_ANALYSIS_SETTINGS') return response.badRequest(res, error.message);
      log?.error?.({ err: error, workId: req.params.id }, 'redraw analyze work failed');
      return response.internalError(res, error.message || '提交转绘分析失败');
    }
  }

  return {
    uploadSource: upload.single('file'),
    uploadReferenceImage: referenceUpload.single('reference_image'),
    listProjects,
    createProject,
    getProject,
    createWorks,
    getWork,
    updateShot,
    generateShot,
    nativeAudioReview,
    generateBatch,
    localizationQuote,
    createVersion,
    listVersionAssets,
    previewRedrawAsset,
    listProductionVoices,
    previewProductionVoice,
    assignVoice,
    assetBatchQuote,
    createAssetBatch,
    dialogueQuote,
    startDialogue,
    getDialogueTask,
    composeVersion,
    listVersionExports,
    getExport,
    downloadExport,
    generationGate,
    assetQuote,
    saveRedrawCharacterIdentityPack,
    updateRedrawAsset,
    generateRedrawAsset,
    reviewRedrawAsset,
    listStylePresets,
    listLocales,
    analyzeWork,
  };
};

module.exports.workflowPhase = workflowPhase;
