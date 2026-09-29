'use strict';

const response = require('../response');

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

function createLibraryOwnershipHelpers(db, options = {}) {
  const publicPlatformEnabled = Boolean(options.publicPlatformEnabled || options.billingEnabled);

  const requireOwnedDrama = (req, res, dramaId) => {
    const owned = ownedDrama(db, req, dramaId);
    if (!owned) response.notFound(res, '资源不存在');
    return owned;
  };

  /**
   * 公开平台：list 必须指定自有 drama_id，或仅查询全局库（global=1）。
   * 返回规范化后的 query；失败时已写响应并返回 null。
   */
  const gateListQuery = (req, res, query) => {
    if (!publicPlatformEnabled) return query;
    const wantsGlobalOnly = query.global === '1' || query.global === 1;
    const dramaId = positiveId(query.drama_id);
    if (dramaId) {
      if (!requireOwnedDrama(req, res, dramaId)) return null;
      return { ...query, drama_id: dramaId };
    }
    if (wantsGlobalOnly) {
      return { ...query, global: 1, drama_id: undefined };
    }
    response.error(res, 400, 'DRAMA_ID_REQUIRED', '素材库查询必须指定项目或仅查询全局库');
    return null;
  };

  const gateCreateBody = (req, res, body) => {
    if (!publicPlatformEnabled) return body || {};
    const dramaId = positiveId(body?.drama_id);
    if (!requireOwnedDrama(req, res, dramaId)) return null;
    return { ...(body || {}), drama_id: dramaId };
  };

  /**
   * @param {object|null} item
   * @param {'read'|'write'} mode
   */
  const gateLibraryItem = (req, res, item, mode = 'read') => {
    if (!publicPlatformEnabled) return item;
    if (!item) {
      response.notFound(res, '资源不存在');
      return null;
    }
    const dramaId = positiveId(item.drama_id);
    if (!dramaId) {
      if (mode === 'read') return item;
      response.error(res, 403, 'ADMIN_ROLE_REQUIRED', '全局素材库项仅管理员可修改');
      return null;
    }
    if (!requireOwnedDrama(req, res, dramaId)) return null;
    return item;
  };

  return {
    publicPlatformEnabled,
    positiveId,
    requireOwnedDrama,
    gateListQuery,
    gateCreateBody,
    gateLibraryItem,
  };
}

module.exports = {
  positiveId,
  ownedDrama,
  createLibraryOwnershipHelpers,
};
