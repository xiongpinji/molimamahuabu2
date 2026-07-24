const tenantService = require('../services/tenantService');

function createTenantContextMiddleware({ db, enabled } = {}) {
  return (req, res, next) => {
    if (!enabled) return next();
    const requestedTenantId = String(req.get('x-tenant-id') || '').trim();
    const tenant = tenantService.resolveForUser(db, req.user?.id, requestedTenantId || null);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: '租户不存在' },
      });
    }
    req.tenant = tenant;
    req.tenantId = tenant.id;
    return next();
  };
}

module.exports = { createTenantContextMiddleware };
