const response = require('../response');
const videoService = require('../services/videoService');
const taskService = require('../services/taskService');

function routes(db, log, options = {}) {
  return {
    list: (req, res) => {
      try {
        const query = { ...req.query };
        const { items, total, page, pageSize } = videoService.list(db, query, {
          billingEnabled: options.billingEnabled,
          userId: req.user?.id,
          tenantId: req.tenant?.id,
        });
        response.successWithPagination(res, items, total, page, pageSize);
      } catch (err) {
        log.error('videos list', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    create: (req, res) => {
      try {
        const item = videoService.create(db, log, req.body || {}, {
          billingEnabled: options.billingEnabled,
          userId: req.user?.id,
          tenantId: req.tenant?.id,
          schedule: options.schedule,
        });
        if (item.reused) return response.success(res, item);
        response.created(res, item);
      } catch (err) {
        log.error('videos create', { error: err.message });
        if (err.code === 'MODEL_PRICE_NOT_CONFIGURED') {
          return response.error(res, 503, err.code, err.message);
        }
        if (err.code === 'INSUFFICIENT_CREDITS') {
          return response.error(res, 402, err.code, '积分不足，请充值后重试');
        }
        if (err.code === 'UNSUPPORTED_BILLING_MODEL') {
          return response.badRequest(res, err.message);
        }
        response.internalError(res, err.message);
      }
    },
    get: (req, res) => {
      try {
        const item = videoService.getById(db, req.params.id, {
          billingEnabled: options.billingEnabled,
          userId: req.user?.id,
          tenantId: req.tenant?.id,
        });
        if (!item) return response.notFound(res, '记录不存在');
        response.success(res, item);
      } catch (err) {
        log.error('videos get', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    delete: (req, res) => {
      try {
        const ok = videoService.deleteById(db, log, req.params.id, {
          billingEnabled: options.billingEnabled,
          userId: req.user?.id,
          tenantId: req.tenant?.id,
        });
        if (!ok) return response.notFound(res, '记录不存在');
        response.success(res, { message: '删除成功' });
      } catch (err) {
        log.error('videos delete', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    fromImage: (req, res) => {
      try {
        const task = taskService.createTask(db, log, 'video_generation', req.params.image_gen_id);
        response.success(res, { task_id: task.id });
      } catch (err) {
        log.error('videos fromImage', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    attach: (req, res) => {
      try {
        const item = videoService.attach(db, log, req.body || {});
        response.created(res, item);
      } catch (err) {
        log.error('videos attach', { error: err.message });
        if (/必填|不存在|至少提供/.test(err.message)) return response.badRequest(res, err.message);
        response.internalError(res, err.message);
      }
    },
    episodeBatch: (req, res) => {
      try {
        response.success(res, []);
      } catch (err) {
        log.error('videos episode batch', { error: err.message });
        response.internalError(res, err.message);
      }
    },
  };
}

module.exports = routes;
