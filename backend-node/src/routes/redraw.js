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
const assetService = require('../services/assetService');
const taskService = require('../services/taskService');

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
  if (!['16:9', '9:16', '1:1', '4:3'].includes(aspectRatio)) {
    throw Object.assign(new Error('请选择有效输出比例'), { code: 'INVALID_REDRAW_ANALYSIS_SETTINGS' });
  }
  const presetId = body?.style_preset_id ?? body?.stylePresetId;
  const hasPreset = presetId !== undefined && presetId !== null && String(presetId).trim() !== '';
  const freeStyle = normalizeFreeStyle(body?.free_style ?? body?.freeStyle);
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
            analysisQuote: quoteAnalysis(db),
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
    const work = findOwnedWork(req.params.id, owner(req));
    if (!work) return response.notFound(res, '转绘作品不存在');
    const task = work.task_id ? taskService.getTask(db, work.task_id) : null;
    return response.success(res, mapWork(work, null, {
      task,
      analysisQuote: quoteAnalysis(db),
    }));
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

    try {
      const analysisSettings = normalizeAnalysisSettings(req.body || {});
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
    listProjects,
    createProject,
    getProject,
    createWorks,
    getWork,
    listStylePresets,
    listLocales,
    analyzeWork,
  };
};
