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
const assetService = require('../services/assetService');
const taskService = require('../services/taskService');
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
    const work = findOwnedWork(req.params.id, owner(req));
    if (!work) return response.notFound(res, '转绘作品不存在');
    const task = work.task_id ? taskService.getTask(db, work.task_id) : null;
    const currentVersion = db.prepare(`
      SELECT id
      FROM redraw_versions
      WHERE work_id = ? AND tenant_id = ? AND user_id = ? AND version = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(work.id, owner(req).tenantId, owner(req).userId, Number(work.current_version || 0));
    return response.success(res, mapWork(work, null, {
      task,
      versionId: currentVersion?.id || null,
      analysisQuote: quoteAnalysis(db, log),
    }));
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
