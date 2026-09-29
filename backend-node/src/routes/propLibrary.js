const response = require('../response');
const propLibraryService = require('../services/propLibraryService');
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
        const { items, total, page, pageSize } = propLibraryService.listLibraryItems(db, query);
        response.successWithPagination(res, items, total, page, pageSize);
      } catch (err) {
        log.error('prop-library list', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    create: (req, res) => {
      try {
        const body = ownership.gateCreateBody(req, res, req.body || {});
        if (!body) return;
        const item = propLibraryService.createLibraryItem(db, log, body);
        response.created(res, item);
      } catch (err) {
        log.error('prop-library create', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    get: (req, res) => {
      try {
        const item = propLibraryService.getLibraryItem(db, req.params.id);
        const gated = ownership.gateLibraryItem(req, res, item, 'read');
        if (!gated) return;
        response.success(res, gated);
      } catch (err) {
        log.error('prop-library get', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    update: (req, res) => {
      try {
        const existing = propLibraryService.getLibraryItem(db, req.params.id);
        if (!ownership.gateLibraryItem(req, res, existing, 'write')) return;
        const body = { ...(req.body || {}) };
        if (ownership.publicPlatformEnabled && body.drama_id !== undefined) {
          if (!ownership.requireOwnedDrama(req, res, body.drama_id)) return;
        }
        const item = propLibraryService.updateLibraryItem(db, log, req.params.id, body);
        if (!item) return response.notFound(res, '道具库项不存在');
        response.success(res, item);
      } catch (err) {
        log.error('prop-library update', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    delete: (req, res) => {
      try {
        const existing = propLibraryService.getLibraryItem(db, req.params.id);
        if (!ownership.gateLibraryItem(req, res, existing, 'write')) return;
        const ok = propLibraryService.deleteLibraryItem(db, log, req.params.id);
        if (!ok) return response.notFound(res, '道具库项不存在');
        response.success(res, { message: '删除成功' });
      } catch (err) {
        log.error('prop-library delete', { error: err.message });
        response.internalError(res, err.message);
      }
    },
  };
}

module.exports = routes;
