const response = require('../response');
const imageService = require('../services/imageService');
const taskService = require('../services/taskService');
const backgroundExtractionService = require('../services/backgroundExtractionService');

function routes(db, cfg, log, options = {}) {
  return {
    list: (req, res) => {
      try {
        const query = { ...req.query };
        const { items, total, page, pageSize } = imageService.list(db, query, {
          billingEnabled: options.billingEnabled,
          userId: req.user?.id,
          tenantId: req.tenant?.id,
        });
        response.successWithPagination(res, items, total, page, pageSize);
      } catch (err) {
        log.error('images list', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    create: (req, res) => {
      try {
        const body = req.body || {};
        const rec = imageService.create(db, log, body, {
          billingEnabled: options.billingEnabled,
          userId: req.user?.id,
          tenantId: req.tenant?.id,
          schedule: options.schedule,
        });
        response.created(res, rec);
      } catch (err) {
        log.error('images create', { error: err.message });
        if (['MODEL_PRICE_NOT_CONFIGURED', 'MODEL_DISABLED', 'MODEL_RESOLUTION_PRICE_REQUIRED',
          'MODEL_NOT_VERIFIED', 'MODEL_CREDENTIAL_MISSING'].includes(err.code)) {
          return response.error(res, 503, err.code, err.message);
        }
        if (['IMAGE_CONFIG_NOT_FOUND', 'IMAGE_CONFIG_MODEL_MISMATCH'].includes(err.code)) {
          return response.error(res, 400, err.code, err.message);
        }
        if (['IMAGE_CONFIG_INACTIVE', 'IMAGE_CONFIG_UNVERIFIED'].includes(err.code)) {
          return response.error(res, 503, err.code, err.message);
        }
        if (err.code === 'INSUFFICIENT_CREDITS') {
          return response.error(res, 402, err.code, '积分不足，请充值后重试');
        }
        if (err.code === 'RESULT_UNKNOWN_NEEDS_REVIEW') {
          return response.error(res, 409, err.code, err.message, {
            status: err.status || 'needs_attention',
            storyboard_id: err.storyboardId,
            frame_type: err.frameType,
            active_id: err.activeId,
            active_task_id: err.activeTaskId,
          });
        }
        if (['UNSUPPORTED_BILLING_MODEL', 'IMAGE_RESOLUTION_REQUIRED',
          'IMAGE_RESOLUTION_NOT_VERIFIED', 'IMAGE_REFERENCE_NOT_VERIFIED',
          'IMAGE_REFERENCE_LIMIT_EXCEEDED', 'INVALID_IMAGE_QUANTITY'].includes(err.code)) {
          return response.badRequest(res, err.message);
        }
        response.internalError(res, err.message);
      }
    },
    get: (req, res) => {
      try {
        const item = imageService.getById(db, req.params.id, {
          billingEnabled: options.billingEnabled,
          userId: req.user?.id,
          tenantId: req.tenant?.id,
        });
        if (!item) return response.notFound(res, '记录不存在');
        response.success(res, item);
      } catch (err) {
        log.error('images get', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    delete: (req, res) => {
      try {
        const ok = imageService.deleteById(db, log, req.params.id, {
          billingEnabled: options.billingEnabled,
          userId: req.user?.id,
          tenantId: req.tenant?.id,
        });
        if (!ok) return response.notFound(res, '记录不存在');
        response.success(res, { message: '删除成功' });
      } catch (err) {
        log.error('images delete', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    scene: (req, res) => {
      try {
        const task = taskService.createTask(db, log, 'image_generation', req.params.scene_id);
        setTimeout(() => taskService.updateTaskResult(db, task.id, []), 100);
        response.success(res, { task_id: task.id });
      } catch (err) {
        log.error('images scene', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    episodeBackgrounds: (req, res) => {
      try {
        const list = imageService.getBackgroundsForEpisode(db, req.params.episode_id);
        response.success(res, list);
      } catch (err) {
        log.error('images episode backgrounds', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    episodeBackgroundsExtract: (req, res) => {
      try {
        const body = req.body || {};
        const taskId = backgroundExtractionService.extractBackgroundsForEpisode(
          db,
          cfg,
          log,
          req.params.episode_id,
          body.model,
          body.style,
          body.language,
          {
            billingEnabled: options.billingEnabled,
            userId: req.user?.id,
            tenantId: req.tenant?.id,
          },
        );
        response.success(res, { task_id: taskId, status: 'pending', message: '场景提取任务已创建，正在后台处理...' });
      } catch (err) {
        log.error('images episode backgrounds extract', { error: err.message });
        if (err.message && (err.message.includes('script content') || err.message.includes('not found'))) {
          return response.badRequest(res, err.message);
        }
        if (['MODEL_PRICE_NOT_CONFIGURED', 'MODEL_DISABLED'].includes(err.code)) {
          return response.error(res, 503, err.code, err.message);
        }
        if (err.code === 'INSUFFICIENT_CREDITS') {
          return response.error(res, 402, err.code, '积分不足，请充值后重试');
        }
        response.internalError(res, err.message || '任务创建失败');
      }
    },
    episodeBatch: (req, res) => {
      try {
        response.success(res, []);
      } catch (err) {
        log.error('images episode batch', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    upload: (req, res) => {
      try {
        const body = req.body || {};
        const item = imageService.upload(db, log, body, {
          billingEnabled: options.billingEnabled,
          userId: req.user?.id,
          tenantId: req.tenant?.id,
        });
        response.created(res, item);
      } catch (err) {
        log.error('images upload', { error: err.message });
        response.internalError(res, err.message);
      }
    },
  };
}

module.exports = routes;
