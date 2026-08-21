const dramaService = require('./dramaService');
const dramaExportService = require('./dramaExportService');
const dramaImportService = require('./dramaImportService');

function resolveDuplicateTitle(db, sourceTitle, userId, tenantId) {
  const baseTitle = `${sourceTitle || '未命名项目'} 副本`;
  let rows;
  if (tenantId != null) {
    rows = db.prepare('SELECT title FROM dramas WHERE tenant_id = ? AND deleted_at IS NULL').all(tenantId);
  } else if (userId != null) {
    rows = db.prepare('SELECT title FROM dramas WHERE user_id = ? AND deleted_at IS NULL').all(userId);
  } else {
    rows = db.prepare('SELECT title FROM dramas WHERE deleted_at IS NULL').all();
  }
  const existing = new Set(rows.map((row) => row.title));
  if (!existing.has(baseTitle)) return baseTitle;
  let index = 2;
  while (existing.has(`${baseTitle} ${index}`)) index += 1;
  return `${baseTitle} ${index}`;
}

function duplicateDrama(db, cfg, log, dramaId, { userId, tenantId } = {}) {
  const source = dramaService.getDramaById(db, Number(dramaId), userId, tenantId);
  if (!source) return null;

  const title = resolveDuplicateTitle(db, source.title, userId, tenantId);
  const { buffer } = dramaExportService.exportDrama(db, cfg, log, source.id);
  const duplicated = dramaImportService.importDrama(db, cfg, log, buffer, {
    userId,
    tenantId,
    title,
  });
  if (source.folder_id != null) {
    const updated = dramaService.updateDrama(
      db,
      log,
      duplicated.drama_id,
      { folder_id: source.folder_id },
      userId,
      tenantId,
    );
    return updated ? duplicated : null;
  }
  return duplicated;
}

module.exports = { duplicateDrama, resolveDuplicateTitle };
