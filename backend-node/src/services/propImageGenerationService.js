// 与 Go PropService.GeneratePropImage + processPropImageGeneration 对齐：道具图片生成
const path = require('path');
const taskService = require('./taskService');
const imageClient = require('./imageClient');
const propService = require('./propService');
const uploadService = require('./uploadService');
const storageLayout = require('./storageLayout');
const {
  aspectRatioToSize,
  resolveImageBillingRequest,
  verifyLocalImageArtifact,
} = require('./imageService');
const creditLedger = require('./creditLedgerService');
const generationCost = require('./generationCostLedgerService');
const auditEvent = require('./auditEventService');
const assetService = require('./assetService');

const USMERCARI_IMAGE_MODELS = new Set(['gpt-image-2-2-4k', 'nano-banana-2']);

const PROP_FOUR_VIEW_PROMPT = [
  '在同一张画布中展示该道具的四个视角：正面、背面、左侧面、右侧面。',
  '四个视角必须是同一个道具，外形、材质、颜色、磨损和细节完全一致；使用整齐四宫格布局，不要文字和水印。',
].join(' ');

function appendPrompt(base, extra) {
  const add = (extra || '').toString().trim();
  if (!add) return (base || '').toString().trim();
  const current = (base || '').toString().trim();
  if (!current) return add;
  const lowerCurrent = current.toLowerCase();
  const lowerAdd = add.toLowerCase();
  if (lowerCurrent.includes(lowerAdd)) return current;
  return current + ', ' + add;
}

function settlePropImageCredit(db, log, taskId, outcome, message = '') {
  const task = taskService.getTask(db, taskId);
  if (!task?.credit_reservation_id) return null;
  try {
    const settled = creditLedger.settleGeneration(
      db,
      task.credit_reservation_id,
      outcome,
      message,
    );
    auditEvent.record(db, {
      userId: settled?.actor_user_id || settled?.user_id,
      tenantId: settled?.tenant_id,
      eventType: `generation.prop_image.${outcome}`,
      resourceType: 'prop_image',
      resourceId: task.resource_id,
      outcome: outcome === 'completed' ? 'success' : 'failed',
      code: outcome === 'failed' ? 'GENERATION_FAILED' : null,
    });
    return settled;
  } catch (error) {
    log?.error?.('道具生图积分结算失败，保留原预扣状态', {
      task_id: taskId,
      reservation_id: task.credit_reservation_id,
      error: error.message,
    });
    return null;
  }
}

function failPropImageGeneration(db, log, taskId, propId, message) {
  const errorMessage = message || '道具图片生成失败';
  taskService.updateTaskError(db, taskId, errorMessage);
  try {
    db.prepare('UPDATE props SET error_msg = ?, updated_at = ? WHERE id = ?')
      .run(errorMessage, new Date().toISOString(), propId);
  } catch (_) {}
  settlePropImageCredit(db, log, taskId, 'failed', errorMessage);
}

function markPropImageNeedsAttention(db, log, taskId, propId, message) {
  const reviewMessage = `供应商最终状态未知：${message || '未取得可验证的生成结果'}。请勿重复提交，等待管理员核对。`;
  const task = taskService.getTask(db, taskId);
  taskService.updateTaskStatus(db, taskId, 'needs_attention', 90, reviewMessage);
  try {
    db.prepare('UPDATE props SET error_msg = ?, updated_at = ? WHERE id = ?')
      .run(reviewMessage, new Date().toISOString(), propId);
  } catch (_) {}
  try {
    auditEvent.record(db, {
      userId: task?.user_id,
      tenantId: task?.tenant_id,
      eventType: 'generation.prop_image.needs_attention',
      resourceType: 'prop_image',
      resourceId: task?.resource_id || `prop_${propId}`,
      outcome: 'needs_attention',
      code: 'PROVIDER_RESULT_UNKNOWN',
    });
  } catch (error) {
    log?.warn?.('道具生图待核对审计写入失败', { task_id: taskId, error: error.message });
  }
}

async function processPropImageGeneration(db, log, taskId, propId, opts) {
  taskService.updateTaskStatus(db, taskId, 'processing', 0, '正在生成图片...');

  const prop = propService.getById(db, propId);
  if (!prop) {
    failPropImageGeneration(db, log, taskId, propId, '道具不存在');
    return;
  }
  if (!prop.prompt || !String(prop.prompt).trim()) {
    failPropImageGeneration(db, log, taskId, propId, '道具没有图片提示词');
    return;
  }

  db.prepare('UPDATE props SET error_msg = NULL, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), propId);

  const loadConfig = require('../config').loadConfig;
  const { mergeCfgStyleWithDrama } = require('../utils/dramaStyleMerge');
  let cfg = loadConfig();
  if (prop.drama_id) {
    try {
      const dr = db.prepare('SELECT style, metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(prop.drama_id);
      cfg = mergeCfgStyleWithDrama(cfg, dr || {});
    } catch (_) {}
  }
  const styleOverride = (opts && opts.style) ? String(opts.style).trim() : '';
  const baseStyle = styleOverride || (cfg?.style?.default_style_en || cfg?.style?.default_style || '');
  let style = '';
  style = appendPrompt(style, baseStyle);
  if (!styleOverride) {
    style = appendPrompt(style, cfg?.style?.default_prop_style || '');
  }
  // 优先用项目 aspect_ratio 推导尺寸；兜底 1920x1920（满足 ≥3,686,400 像素要求）
  let imageSize = null;
  if (prop.drama_id) {
    try {
      const dramaRow = db.prepare('SELECT metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(prop.drama_id);
      if (dramaRow && dramaRow.metadata) {
        const meta = typeof dramaRow.metadata === 'string' ? JSON.parse(dramaRow.metadata) : dramaRow.metadata;
        if (meta && meta.aspect_ratio) imageSize = aspectRatioToSize(meta.aspect_ratio);
      }
    } catch (_) {}
  }
  if (!imageSize) imageSize = cfg?.style?.default_image_size || '1920x1920';
  let fullPrompt = appendPrompt(String(prop.prompt).trim(), style);
  if (opts?.useQuadGrid) fullPrompt = appendPrompt(fullPrompt, PROP_FOUR_VIEW_PROMPT);
  // 与角色/场景一致：使用显式模型；未传时由图片配置中的全局默认模型决定
  const task = taskService.getTask(db, taskId);
  const model = (opts && opts.model)
    ? String(opts.model).trim() || null
    : task?.model || null;
  const userNeg = imageClient.resolveAssetUserNegativeForApi(model, prop.negative_prompt);

  let result;
  try {
    result = await imageClient.callImageApi(db, log, {
      prompt: fullPrompt,
      size: imageSize,
      resolution: opts?.resolution || undefined,
      n: 1,
      drama_id: prop.drama_id,
      model: model || undefined,
      user_negative_prompt: userNeg || undefined,
    }, { evidenceRoots: opts?.evidenceRoots });
  } catch (err) {
    const errMsg = '图片生成请求失败: ' + (err.message || '未知错误');
    log.error('Prop image API failed', { prop_id: propId, error: err.message });
    failPropImageGeneration(db, log, taskId, propId, errMsg);
    return;
  }

  if (result.indeterminate) {
    markPropImageNeedsAttention(db, log, taskId, propId, result.error);
    return;
  }
  if (result.error) {
    failPropImageGeneration(db, log, taskId, propId, result.error);
    return;
  }
  if (!result.image_url) {
    const errMsg = '未返回图片地址';
    failPropImageGeneration(db, log, taskId, propId, errMsg);
    return;
  }

  taskService.updateTaskStatus(db, taskId, 'processing', 80, '正在保存图片...');

  let localPath = null;
  let artifact = null;
  let storagePath = null;
  try {
    storagePath = path.isAbsolute(cfg.storage?.local_path)
      ? cfg.storage.local_path
      : path.join(process.cwd(), cfg.storage?.local_path || './data/storage');
    const projectSubdir = storageLayout.getProjectStorageSubdir(db, prop.drama_id);
    localPath = await uploadService.downloadImageToLocal(
      storagePath,
      result.image_url,
      'props',
      log,
      'prop_' + propId,
      projectSubdir
    );
    if (USMERCARI_IMAGE_MODELS.has(String(model || '').toLowerCase())) {
      artifact = await verifyLocalImageArtifact(storagePath, localPath);
    }
  } catch (error) {
    if (USMERCARI_IMAGE_MODELS.has(String(model || '').toLowerCase())) {
      failPropImageGeneration(db, log, taskId, propId, `图片本地保存失败：${error.message}`);
      return;
    }
  }

  if (USMERCARI_IMAGE_MODELS.has(String(model || '').toLowerCase()) && !localPath) {
    failPropImageGeneration(db, log, taskId, propId, '图片本地保存失败：未生成本地文件');
    return;
  }

  const now = new Date().toISOString();
  const isStrictUsmercari = USMERCARI_IMAGE_MODELS.has(String(model || '').toLowerCase());
  const persistedImageUrl = isStrictUsmercari && localPath
    ? '/static/' + String(localPath).replace(/^\//, '')
    : result.image_url;
  // 旧图追加到 extra_images，与上传逻辑保持一致
  const oldProp = db.prepare('SELECT local_path, image_url, extra_images FROM props WHERE id = ?').get(propId);
  const oldPath = oldProp?.local_path || oldProp?.image_url || '';
  let extras = [];
  try { extras = oldProp?.extra_images ? JSON.parse(oldProp.extra_images) : []; } catch (_) {}
  if (!Array.isArray(extras)) extras = [];
  if (oldPath && !extras.includes(oldPath)) extras.push(oldPath);
  const extraJson = extras.length ? JSON.stringify(extras) : null;
  db.transaction(() => {
    try {
      db.prepare(
        'UPDATE props SET image_url = ?, local_path = ?, extra_images = ?, error_msg = NULL, updated_at = ? WHERE id = ?'
      ).run(persistedImageUrl, localPath, extraJson, now, propId);
    } catch (e) {
      if ((e.message || '').includes('extra_images')) {
        db.prepare('UPDATE props SET image_url = ?, local_path = ?, error_msg = NULL, updated_at = ? WHERE id = ?').run(persistedImageUrl, localPath, now, propId);
      } else {
        throw e;
      }
    }

    if (artifact) {
      assetService.create(db, log, {
        drama_id: prop.drama_id,
        name: `${prop.name || '道具'} 图片`,
        type: 'image',
        category: 'prop',
        url: persistedImageUrl,
        local_path: localPath,
        file_size: artifact.fileSize,
        mime_type: artifact.mimeType,
        width: artifact.width,
        height: artifact.height,
        metadata: {
          source: 'prop_image_generation',
          prop_id: propId,
          model,
          resolution: opts?.resolution || null,
        },
      });
    }
    taskService.updateTaskResult(db, taskId, {
      image_url: persistedImageUrl,
      local_path: localPath,
      prop_id: propId,
    });
  })();
  settlePropImageCredit(db, log, taskId, 'completed');
  log.info('Prop image generation completed', { prop_id: propId, image_url: persistedImageUrl, local_path: localPath });
}

function generatePropImage(db, log, propId, opts) {
  const prop = propService.getById(db, propId);
  if (!prop) throw new Error('道具不存在');
  if (!prop.prompt || !String(prop.prompt).trim()) {
    throw new Error('道具没有图片提示词');
  }

  const options = opts || {};
  let billedModel = null;
  let billedCredits = null;
  if (options.billingEnabled) {
    if (!options.userId) {
      const error = new Error('公开计费模式缺少用户身份');
      error.code = 'UNAUTHORIZED';
      throw error;
    }
  }
  const billingRequest = resolveImageBillingRequest(db, {
    model: options.model,
    provider: options.provider,
    resolution: options.resolution,
    n: 1,
  }, 'image', {
    requirePricing: options.billingEnabled === true,
    allowMissingModel: !options.billingEnabled,
    evidenceRoots: options.evidenceRoots,
  });
  if (options.billingEnabled) {
    billedModel = billingRequest.model;
    billedCredits = billingRequest.credits;
  }

  const task = db.transaction(() => {
    const created = taskService.createTask(db, log, 'prop_image_generation', `prop_${propId}`);
    if (!options.billingEnabled) return created;
    const reservation = creditLedger.reserve(db, {
      tenantId: options.tenantId,
      actorUserId: options.userId,
      userId: options.userId,
      operationKey: `prop_image:${created.id}`,
      model: billedModel,
      resourceType: 'prop_image',
      resourceId: `prop_${propId}`,
      amount: billedCredits,
    });
    generationCost.record(db, {
      reservationId: reservation.id,
      model: billedModel,
      resolution: billingRequest.resolution,
      quantity: 1,
      usageSource: 'configured',
    });
    db.prepare(
      `UPDATE async_tasks
       SET tenant_id = ?, user_id = ?, model = ?, credit_reservation_id = ?
       WHERE id = ?`,
    ).run(
      options.tenantId ? String(options.tenantId) : null,
      String(options.userId),
      billedModel,
      reservation.id,
      created.id,
    );
    auditEvent.record(db, {
      userId: options.userId,
      tenantId: options.tenantId,
      eventType: 'generation.prop_image.created',
      resourceType: 'prop_image',
      resourceId: `prop_${propId}`,
      outcome: 'success',
      code: 'CREATED',
    });
    return taskService.getTask(db, created.id);
  })();

  const schedule = typeof options.schedule === 'function'
    ? options.schedule
    : (callback) => setImmediate(callback);
  const processingOptions = billingRequest
    ? { ...options, model: billingRequest.model, resolution: billingRequest.resolution }
    : options;
  schedule(() => {
    processPropImageGeneration(db, log, task.id, propId, processingOptions).catch((err) => {
      log.error('processPropImageGeneration fatal', { error: err.message, task_id: task.id });
      failPropImageGeneration(db, log, task.id, propId, err.message);
    });
  });
  return task.id;
}

module.exports = {
  generatePropImage,
  processPropImageGeneration,
  settlePropImageCredit,
};
