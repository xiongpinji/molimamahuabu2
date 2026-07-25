const response = require('../response');
const assetService = require('../services/assetService');

function positiveId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function ownedDrama(db, req, dramaId) {
  const id = positiveId(dramaId);
  if (!id) return null;
  if (req.tenant?.id) {
    return db.prepare(`SELECT id FROM dramas
      WHERE id = ? AND deleted_at IS NULL
        AND (tenant_id = ? OR (tenant_id IS NULL AND user_id = ?))`)
      .get(id, req.tenant.id, req.user?.id);
  }
  return db.prepare('SELECT id FROM dramas WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(id, req.user?.id);
}

function storyboardDramaId(db, storyboardId) {
  const id = positiveId(storyboardId);
  if (!id) return null;
  const row = db.prepare(`SELECT e.drama_id
    FROM storyboards s
    JOIN episodes e ON e.id = s.episode_id
    WHERE s.id = ? AND s.deleted_at IS NULL AND e.deleted_at IS NULL`).get(id);
  return positiveId(row?.drama_id);
}

function generationDramaId(db, table, id) {
  const row = db.prepare(`SELECT drama_id FROM ${table} WHERE id = ? AND deleted_at IS NULL`)
    .get(positiveId(id));
  return positiveId(row?.drama_id);
}

function routes(db, log, options = {}) {
  const publicPlatformEnabled = Boolean(options.publicPlatformEnabled || options.billingEnabled);
  const requireOwnedDrama = (req, res, dramaId) => {
    const owned = ownedDrama(db, req, dramaId);
    if (!owned) response.notFound(res, '资源不存在');
    return owned;
  };
  const requireAsset = (req, res) => {
    const item = assetService.getById(db, req.params.id);
    if (!item) {
      response.notFound(res, '资源不存在');
      return null;
    }
    if (!requireOwnedDrama(req, res, item.drama_id)) return null;
    return item;
  };

  return {
    list: (req, res) => {
      try {
        const query = { ...req.query };
        if (publicPlatformEnabled) {
          const dramaId = positiveId(query.drama_id);
          if (!dramaId) {
            return response.error(res, 400, 'DRAMA_ID_REQUIRED', '素材查询必须指定项目');
          }
          if (!requireOwnedDrama(req, res, dramaId)) return;
          query.drama_id = dramaId;
          query.public_system_global_only = true;
        }
        const { items, total, page, pageSize } = assetService.list(db, query);
        response.successWithPagination(res, items, total, page, pageSize);
      } catch (err) {
        log.error('assets list', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    create: (req, res) => {
      try {
        const body = req.body || {};
        if (publicPlatformEnabled) {
          const dramaId = positiveId(body.drama_id);
          if (!requireOwnedDrama(req, res, dramaId)) return;
          if (body.storyboard_id != null && storyboardDramaId(db, body.storyboard_id) !== dramaId) {
            return response.notFound(res, '资源不存在');
          }
        }
        const item = assetService.create(db, log, body);
        response.created(res, item);
      } catch (err) {
        log.error('assets create', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    get: (req, res) => {
      try {
        const item = publicPlatformEnabled
          ? requireAsset(req, res)
          : assetService.getById(db, req.params.id);
        if (publicPlatformEnabled && !item) return;
        if (!item) return response.notFound(res, '资源不存在');
        response.success(res, item);
      } catch (err) {
        log.error('assets get', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    update: (req, res) => {
      try {
        const body = req.body || {};
        if (publicPlatformEnabled) {
          const existing = requireAsset(req, res);
          if (!existing) return;
          const targetDramaId = body.drama_id !== undefined
            ? positiveId(body.drama_id)
            : positiveId(existing.drama_id);
          if (!requireOwnedDrama(req, res, targetDramaId)) return;
          const targetStoryboardId = body.storyboard_id !== undefined
            ? body.storyboard_id
            : existing.storyboard_id;
          if (targetStoryboardId != null
            && storyboardDramaId(db, targetStoryboardId) !== targetDramaId) {
            return response.notFound(res, '资源不存在');
          }
        }
        const item = assetService.update(db, log, req.params.id, body);
        if (!item) return response.notFound(res, '资源不存在');
        response.success(res, item);
      } catch (err) {
        log.error('assets update', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    delete: (req, res) => {
      try {
        if (publicPlatformEnabled && !requireAsset(req, res)) return;
        const ok = assetService.deleteById(db, log, req.params.id);
        if (!ok) return response.notFound(res, '资源不存在');
        response.success(res, { message: '删除成功' });
      } catch (err) {
        log.error('assets delete', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    importImage: (req, res) => {
      try {
        if (publicPlatformEnabled) {
          const dramaId = generationDramaId(db, 'image_generations', req.params.image_gen_id);
          if (!requireOwnedDrama(req, res, dramaId)) return;
        }
        const item = assetService.importFromImage(db, log, req.params.image_gen_id);
        if (!item) return response.notFound(res, '图片生成记录不存在');
        response.created(res, item);
      } catch (err) {
        log.error('assets import image', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    importVideo: (req, res) => {
      try {
        if (publicPlatformEnabled) {
          const dramaId = generationDramaId(db, 'video_generations', req.params.video_gen_id);
          if (!requireOwnedDrama(req, res, dramaId)) return;
        }
        const item = assetService.importFromVideo(db, log, req.params.video_gen_id);
        if (!item) return response.notFound(res, '视频生成记录不存在');
        response.created(res, item);
      } catch (err) {
        log.error('assets import video', { error: err.message });
        response.internalError(res, err.message);
      }
    },
  };
}

module.exports = routes;
