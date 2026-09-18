'use strict';

/**
 * 转绘公开能力目录（风格预设 / 语区）——从单体 redraw.js 拆出的第一刀。
 */
function attachCatalogHandlers(target, {
  db,
  capabilityService,
  canReadArtifact,
  mapStylePreset,
  response,
}) {
  target.listStylePresets = function listStylePresets(_req, res) {
    const rows = capabilityService.listPublicStylePresets(db, canReadArtifact);
    return response.success(res, rows.map(mapStylePreset));
  };
  target.listLocales = function listLocales(_req, res) {
    return response.success(res, capabilityService.listLocaleCapabilities(db, canReadArtifact));
  };
  return target;
}

module.exports = {
  attachCatalogHandlers,
};
