const response = require('../response');
const imageToolService = require('../services/imageToolService');
const imageToolBilling = require('../services/imageToolBillingService');

const unavailable = (reason) => ({ available: false, reason });

const BASE_OPERATIONS = Object.freeze({
  crop: { available: true, engine: 'sharp' },
  compress: { available: true, engine: 'sharp' },
  mirror: { available: true, engine: 'sharp' },
  rotate: { available: true, engine: 'sharp' },
  grid_crop: { available: true, engine: 'sharp' },
  adjust: { available: true, engine: 'sharp' },
  lut: { available: true, engine: 'sharp', presets: ['cinematic', 'warm', 'cool', 'mono'] },
  markup_retouch: unavailable('标记修图处理链尚未完成'),
  smart_cutout: unavailable('本地抠图模型尚未通过许可证审计'),
  selection_cutout: unavailable('框选抠图处理链尚未完成'),
  upscale: unavailable('高清增强模型尚未通过许可证审计'),
  detail_enhance: unavailable('细节增强模型尚未通过许可证审计'),
  lighting: {
    available: true,
    engine: 'director-stage',
    action: 'open',
    mode: 'lighting',
  },
  cinematic_relight: unavailable('电影光影模型能力尚未配置'),
  panorama: unavailable('全景模型能力尚未配置'),
  panorama_scene: unavailable('全景场景模型能力尚未配置'),
  outpaint: unavailable('扩图模型能力尚未配置'),
  pose: {
    available: true,
    engine: 'director-stage',
    action: 'open',
    mode: 'pose',
  },
  angle: {
    available: true,
    engine: 'director-stage',
    action: 'open',
    mode: 'angle',
  },
  image_ideation: unavailable('画面联想模型能力尚未配置'),
  angle_ideation: unavailable('角度联想模型能力尚未配置'),
  character_views: unavailable('角色三视图模型能力尚未配置'),
  narrative_grid: unavailable('多机位九宫格模型能力尚未配置'),
  frame_forward: unavailable('画面后推模型能力尚未配置'),
  frame_backward: unavailable('画面前推模型能力尚未配置'),
  director_stage: {
    available: true,
    engine: 'director-stage',
    action: 'open',
  },
  lip_sync: unavailable('对口型模型能力尚未配置'),
});

function handleError(res, log, error) {
  if (imageToolBilling.respondError(response, res, error)) return;
  if (error.code === 'IMAGE_TOOL_ASSET_NOT_FOUND') return response.notFound(res, error.message);
  if ([
    'IMAGE_TOOL_INVALID_INPUT',
    'IMAGE_TOOL_SOURCE_UNAVAILABLE',
    'IMAGE_TOOL_UNSUPPORTED_IMAGE',
  ].includes(error.code)) {
    return response.badRequest(res, error.message);
  }
  if (error.code === 'IMAGE_TOOL_OPERATION_UNAVAILABLE') {
    return response.error(res, 503, error.code, error.message);
  }
  if (error.code === 'IMAGE_TOOL_PROCESSING_FAILED') {
    return response.error(res, 503, error.code, error.message);
  }
  if (error.code === 'IMAGE_TOOL_BUSY') {
    return response.error(res, 429, error.code, error.message);
  }
  log.error('image tools operation', { error: error.message });
  return response.internalError(res, error.message);
}

function routes(db, log, options = {}) {
  const modelTools = imageToolService.resolveModelTools(
    options.modelTools,
    options.env,
    options.auditedModelHashes,
    options.auditedUpscaleFiles,
  );
  const resolveReferenceAvailability = () => {
    const resolvedReferenceImageTool = imageToolService.resolveReferenceImageTool(
      db,
      log,
      options.referenceImageTool,
    );
    return options.publicPlatformEnabled
      ? imageToolBilling.availability(db, resolvedReferenceImageTool)
      : { tool: resolvedReferenceImageTool, reason: undefined };
  };
  return {
    capabilities: (_req, res) => {
      const referenceAvailability = resolveReferenceAvailability();
      return response.success(res, {
        operations: {
          ...BASE_OPERATIONS,
          ...imageToolService.modelCapabilities(modelTools),
          ...imageToolService.referenceImageCapabilities(
            referenceAvailability.tool,
            referenceAvailability.reason,
          ),
        },
      });
    },
    createOperation: async (req, res) => {
      let billing = null;
      try {
        const operation = String(req.body?.operation || '').trim();
        const referenceImageTool = resolveReferenceAvailability().tool;
        const isRemoteReferenceOperation = Boolean(
          referenceImageTool?.operations?.includes(operation),
        );
        billing = imageToolBilling.begin(db, {
          enabled: Boolean(options.publicPlatformEnabled && isRemoteReferenceOperation),
          tenantId: req.tenant?.id,
          userId: req.user?.id,
          model: referenceImageTool?.model,
          operation,
          resourceId: req.body?.assetId,
        });
        let acceptedTask = null;
        const operationPromise = imageToolService.createOperation(db, log, req.body || {}, {
          cfg: options.cfg,
          publicPlatformEnabled: Boolean(options.publicPlatformEnabled),
          tenantId: req.tenant?.id,
          userId: req.user?.id,
          modelTools,
          referenceImageTool,
          onTaskCreated: (task) => {
            acceptedTask = {
              taskId: task.id,
              status: 'processing',
              operation,
            };
            if (billing?.reservationId || billing?.model) {
              db.prepare(
                'UPDATE async_tasks SET credit_reservation_id = ?, model = ? WHERE id = ?',
              ).run(billing?.reservationId || null, billing?.model || null, task.id);
            }
          },
        });
        if (options.backgroundOperations && isRemoteReferenceOperation && acceptedTask) {
          operationPromise.then(
            () => imageToolBilling.settle(db, log, billing, 'completed'),
            (error) => {
              imageToolBilling.settle(db, log, billing, 'failed', error.message);
              log.error('图片工具后台任务失败', {
                task_id: acceptedTask.taskId,
                operation,
                error: error.message,
              });
            },
          );
          response.accepted(res, acceptedTask);
          return;
        }
        const result = await operationPromise;
        imageToolBilling.settle(db, log, billing, 'completed');
        response.created(res, result);
      } catch (error) {
        imageToolBilling.settle(db, log, billing, 'failed', error.message);
        handleError(res, log, error);
      }
    },
    getOperation: (req, res) => {
      const task = imageToolService.getOperation(db, req.params.taskId, {
        publicPlatformEnabled: Boolean(options.publicPlatformEnabled),
        tenantId: req.tenant?.id,
        userId: req.user?.id,
      });
      if (!task) return response.notFound(res, '图片处理任务不存在');
      response.success(res, task);
    },
  };
}

module.exports = routes;
