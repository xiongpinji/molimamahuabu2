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
const localizationService = require('../services/localizationService');
const redrawAssetService = require('../services/redrawAssetService');
const redrawReviewService = require('../services/redrawReviewService');
const redrawShotService = require('../services/redrawShotService');
const redrawGenerationService = require('../services/redrawGenerationService');
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
  'model', 'duration', 'resolution', 'aspect_ratio', 'aspectRatio', 'locale',
  'negative_prompt', 'negativePrompt',
]);
const SAFE_BATCH_GENERATION_FIELDS = new Set([
  ...SAFE_GENERATION_FIELDS,
  'shot_ids', 'shotIds', 'version_id', 'versionId', 'count',
]);

function generationInputError(message) {
  return codedRouteError('REDRAW_GENERATION_INPUT_INVALID', message);
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

function sendRedrawError(res, error, fallbackMessage, log, context = {}) {
  const code = String(error?.code || '');
  if (['REDRAW_WORK_NOT_FOUND', 'REDRAW_VERSION_NOT_FOUND', 'REDRAW_SHOT_NOT_FOUND',
    'REDRAW_SHOT_TASK_NOT_FOUND', 'REDRAW_VIDEO_NOT_FOUND'].includes(code)) {
    return response.error(res, 404, code, error.message || fallbackMessage, error.details);
  }
  if (code === 'INSUFFICIENT_CREDITS') {
    return response.error(res, 402, code, error.message || '积分不足', error.details);
  }
  if (['REDRAW_ASSET_REVIEW_REQUIRED', 'REDRAW_SHOT_CONFLICT', 'REDRAW_VERSION_CONFLICT',
    'REDRAW_SHOT_EDIT_CONFLICT', 'REDRAW_RETRY_UNCERTAIN', 'REDRAW_SHOT_RETRY_REQUIRED',
    'REDRAW_SHOT_PRICING_UNCONFIGURED'].includes(code)) {
    return response.error(res, 409, code, error.message || fallbackMessage, error.details);
  }
  if (code.startsWith('REDRAW_') || code.startsWith('INVALID_')) {
    return response.error(res, 400, code, error.message || fallbackMessage, error.details);
  }
  log?.error?.({ err: error, ...context }, fallbackMessage);
  return response.error(res, 500, 'INTERNAL_ERROR', fallbackMessage);
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
  const cfg = options.cfg || {};
  const quoteAnalysis = options.quoteAnalysis || analysisQuote();
  const canReadArtifact = options.canReadArtifact || createCanReadArtifact(db, cfg);
  const uploadLimits = {
    storageRoot: storageRootFromConfig(cfg),
    assetUrlPrefix: '/static/redraw-sources',
    ...(options.uploadLimits || {}),
  };

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

  function findOwnedAnalysisTask(work, currentOwner) {
    if (!work.task_id) return null;
    return db.prepare(`SELECT * FROM async_tasks
      WHERE id = ? AND type = 'redraw_analysis' AND resource_id = ?
        AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
      LIMIT 1`)
      .get(String(work.task_id), String(work.id), currentOwner.tenantId, currentOwner.userId);
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

  function shotRuntime(raw, snapshot, currentOwner) {
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
    const billing = billingFromReservation(reservation, metadata.quote || null);
    return {
      ...snapshot,
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

  function listOwnedShotRuntime(version, currentOwner) {
    const rows = db.prepare(`SELECT * FROM redraw_shots
      WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
      ORDER BY batch_index ASC, shot_index ASC, id ASC`)
      .all(version.id, currentOwner.tenantId, currentOwner.userId);
    const rowsById = new Map(rows.map((row) => [Number(row.id), row]));
    return shotService.snapshotShots(db, version.id)
      .filter((snapshot) => rowsById.has(Number(snapshot.id)))
      .map((snapshot) => shotRuntime(rowsById.get(Number(snapshot.id)), snapshot, currentOwner));
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
    const currentVersion = findVersionForWork(work, work.current_version, currentOwner);
    try {
      const task = findOwnedAnalysisTask(work, currentOwner);
      const shots = currentVersion ? listOwnedShotRuntime(currentVersion, currentOwner) : [];
      const batches = shotService.groupShotsIntoBatches(shots);
      return response.success(res, {
        ...mapWork(work, null, {
          task,
          versionId: currentVersion?.id || null,
          analysisQuote: quoteAnalysis(db, log),
        }),
        analysis_billing: analysisBilling(work, currentOwner),
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
      const id = Number(reference.redraw_asset_id ?? reference.redrawAssetId ?? reference.asset_id ?? reference.assetId);
      const asset = Number.isSafeInteger(id) ? assetsById.get(id) : null;
      if (!asset || (reference.kind && String(reference.kind) !== String(asset.kind))) {
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
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw codedRouteError('REDRAW_SHOT_INVALID', 'count 必须是正整数');
    }
    return { model, duration, resolution, count };
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
      const current = shotService.snapshotShots(db, shot.version_id)
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
      const snapshot = shotService.snapshotShots(db, shot.version_id)
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

  function createVersion(req, res) {
    const currentOwner = owner(req);
    const work = findOwnedWork(req.params.id, currentOwner);
    if (!work) return response.notFound(res, '转绘作品不存在');
    const sourceVersion = db.prepare(`
      SELECT source_facts_json, facts_hash
      FROM redraw_versions
      WHERE work_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
        AND source_facts_json IS NOT NULL
      ORDER BY version ASC
      LIMIT 1
    `).get(work.id, currentOwner.tenantId, currentOwner.userId);
    if (!sourceVersion) return response.badRequest(res, '源片事实尚未确认');
    try {
      const version = localizationService.createLocalizationVersion(db, currentOwner, work.id, {
        ...req.body,
        sourceFacts: parseJSON(sourceVersion.source_facts_json, {}),
        sourceFactsHash: sourceVersion.facts_hash,
      });
      const now = new Date().toISOString();
      db.prepare(`UPDATE redraw_versions SET status = 'asset_review', updated_at = ? WHERE id = ?`).run(now, version.id);
      db.prepare(`UPDATE redraw_works SET status = 'asset_review', current_step = 2, updated_at = ? WHERE id = ?`).run(now, work.id);
      return response.created(res, {
        version,
        work_id: Number(work.id),
        project_id: Number(work.project_id),
        status: 'asset_review',
        current_step: 2,
        updated_at: now,
      });
    } catch (error) {
      if (String(error.code || '').startsWith('LOCALIZATION_')) return response.badRequest(res, error.message);
      log?.error?.({ err: error, workId: work.id }, 'redraw create version failed');
      return response.internalError(res, error.message || '创建本地化版本失败');
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

  function generationGate(req, res) {
    const currentOwner = owner(req);
    try {
      return response.success(res, redrawReviewService.evaluateGenerationGate(db, req.params.id, currentOwner));
    } catch (error) {
      if (error.code === 'REDRAW_VERSION_NOT_FOUND') return response.notFound(res, '本地化版本不存在');
      return response.internalError(res, error.message || '读取生成审核门禁失败');
    }
  }

  async function assetQuote(req, res) {
    const currentOwner = owner(req);
    const asset = findOwnedAsset(req.params.id, currentOwner);
    if (!asset) return response.notFound(res, '转绘资产不存在');
    try {
      const quoteProvider = options.assetQuoteProvider;
      const quote = typeof quoteProvider === 'function'
        ? await quoteProvider({ asset, tenantId: currentOwner.tenantId, userId: currentOwner.userId })
        : { credits: asset.quote_credits ?? null, model: asset.model || null };
      const credits = Number(quote?.credits);
      return response.success(res, {
        asset_id: Number(asset.id),
        model: quote?.model || null,
        credits: Number.isSafeInteger(credits) && credits > 0 ? credits : null,
        priced: Number.isSafeInteger(credits) && credits > 0,
      });
    } catch (error) {
      if (String(error.code || '').startsWith('MODEL_') || error.code === 'INVALID_MODEL_PRICE') {
        return response.success(res, { asset_id: Number(asset.id), model: null, credits: null, priced: false });
      }
      log?.error?.({ err: error, assetId: asset.id }, 'redraw asset quote failed');
      return response.internalError(res, error.message || '读取资产报价失败');
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
    const sourcePayload = parseJSON(asset.source_ref_json, {});
    const provider = options.assetGenerationProvider || options.assetProvider;
    if (typeof provider !== 'function') return response.badRequest(res, '资产生成能力尚未配置');
    try {
      const generated = await redrawAssetService.generateAsset({
        db,
        versionId: asset.version_id,
        tenantId: currentOwner.tenantId,
        userId: currentOwner.userId,
        provider,
        assetReader: {
          canRead: (row) => Boolean(row && typeof canReadArtifact === 'function' && canReadArtifact(row.id)),
        },
      }, {
        kind: asset.kind,
        sourceRef: sourcePayload.source_ref || sourcePayload.source || {},
        localizedName: req.body?.localized_name ?? asset.localized_name,
        localizedDescription: req.body?.localized_description ?? asset.localized_description,
        prompt: req.body?.prompt ?? asset.prompt,
        model: req.body?.model,
        creditAmount: req.body?.credit_amount,
      });
      return response.accepted(res, {
        asset: generated,
        version_id: Number(asset.version_id),
        status: generated.status,
        current_step: 2,
      });
    } catch (error) {
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
      }, options.analysisOptions || {});
      return response.created(res, {
        task_id: result.task_id,
        provider_task_id: result.provider_task_id || null,
        billing: billingPayload(result.billing),
        current_step: 1,
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
    generateBatch,
    createVersion,
    listVersionAssets,
    generationGate,
    assetQuote,
    updateRedrawAsset,
    generateRedrawAsset,
    reviewRedrawAsset,
    listStylePresets,
    listLocales,
    analyzeWork,
  };
};
