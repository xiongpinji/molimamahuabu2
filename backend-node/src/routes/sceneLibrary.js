const response = require('../response');
const sceneLibraryService = require('../services/sceneLibraryService');
const { createLibraryOwnershipHelpers } = require('./libraryOwnership');

function routes(db, cfg, log, options = {}) {
  const ownership = createLibraryOwnershipHelpers(db, options);

  return {
    list: (req, res) => {
      try {
        const query = ownership.gateListQuery(req, res, {
          page: req.query.page,
          page_size: req.query.page_size,
          drama_id: req.query.drama_id,
          global: req.query.global,
          category: req.query.category,
          source_type: req.query.source_type,
          source_id: req.query.source_id,
          source_ids: req.query.source_ids,
          keyword: req.query.keyword,
        });
        if (!query) return;
        const { items, total, page, pageSize } = sceneLibraryService.listLibraryItems(db, query);
        response.successWithPagination(res, items, total, page, pageSize);
      } catch (err) {
        log.error('scene-library list', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    create: (req, res) => {
      try {
        const body = ownership.gateCreateBody(req, res, req.body || {});
        if (!body) return;
        const item = sceneLibraryService.createLibraryItem(db, log, body);
        response.created(res, item);
      } catch (err) {
        log.error('scene-library create', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    get: (req, res) => {
      try {
        const item = sceneLibraryService.getLibraryItem(db, req.params.id);
        const gated = ownership.gateLibraryItem(req, res, item, 'read');
        if (!gated) return;
        response.success(res, gated);
      } catch (err) {
        log.error('scene-library get', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    update: (req, res) => {
      try {
        const existing = sceneLibraryService.getLibraryItem(db, req.params.id);
        if (!ownership.gateLibraryItem(req, res, existing, 'write')) return;
        const body = { ...(req.body || {}) };
        if (ownership.publicPlatformEnabled && body.drama_id !== undefined) {
          if (!ownership.requireOwnedDrama(req, res, body.drama_id)) return;
        }
        const item = sceneLibraryService.updateLibraryItem(db, log, req.params.id, body);
        if (!item) return response.notFound(res, '场景库项不存在');
        response.success(res, item);
      } catch (err) {
        log.error('scene-library update', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    delete: (req, res) => {
      try {
        const existing = sceneLibraryService.getLibraryItem(db, req.params.id);
        if (!ownership.gateLibraryItem(req, res, existing, 'write')) return;
        const ok = sceneLibraryService.deleteLibraryItem(db, log, req.params.id);
        if (!ok) return response.notFound(res, '场景库项不存在');
        response.success(res, { message: '删除成功' });
      } catch (err) {
        log.error('scene-library delete', { error: err.message });
        response.internalError(res, err.message);
      }
    },
  };
}

module.exports = routes;
