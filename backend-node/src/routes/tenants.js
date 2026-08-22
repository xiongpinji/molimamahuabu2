const response = require('../response');
const tenants = require('../services/tenantService');
const credits = require('../services/creditLedgerService');

function routes(db, log) {
  return {
    list: (req, res) => {
      try {
        response.success(res, tenants.listForUser(db, req.user.id));
      } catch (error) {
        log.error('tenant list', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    create: (req, res) => {
      try {
        const tenant = db.transaction(() => {
          const created = tenants.createTenant(db, req.user.id, req.body || {});
          credits.setTenantAccountBalance(db, created.id, 0);
          return created;
        })();
        response.created(res, tenant);
      } catch (error) {
        if (['INVALID_INPUT', 'INVALID_TENANT_SLUG'].includes(error.code)) return response.badRequest(res, error.message);
        if (error.code === 'TENANT_SLUG_EXISTS') return response.error(res, 409, error.code, error.message);
        log.error('tenant create', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    listMembers: (req, res) => {
      try {
        response.success(res, tenants.listMembers(db, req.params.tenantId, req.user.id));
      } catch (error) {
        if (error.code === 'TENANT_NOT_FOUND') return response.notFound(res, '租户不存在');
        log.error('tenant members list', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    addMember: (req, res) => {
      try {
        response.created(res, tenants.addMemberByEmail(
          db, req.params.tenantId, req.user.id, req.body || {},
        ));
      } catch (error) {
        if (error.code === 'TENANT_NOT_FOUND') return response.notFound(res, '租户不存在');
        if (['INVALID_TENANT_ROLE', 'USER_NOT_FOUND'].includes(error.code)) return response.badRequest(res, error.message);
        if (error.code === 'TENANT_ROLE_FORBIDDEN') return response.error(res, 403, error.code, error.message);
        if (error.code === 'LAST_TENANT_OWNER') return response.error(res, 409, error.code, error.message);
        log.error('tenant member add', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    changeMemberRole: (req, res) => {
      try {
        response.success(res, tenants.changeMemberRole(
          db,
          req.params.tenantId,
          req.user.id,
          req.params.userId,
          req.body?.role,
        ));
      } catch (error) {
        if (error.code === 'TENANT_NOT_FOUND') return response.notFound(res, '租户不存在');
        if (error.code === 'USER_NOT_FOUND') return response.notFound(res, '成员不存在');
        if (error.code === 'INVALID_TENANT_ROLE') return response.badRequest(res, error.message);
        if (error.code === 'TENANT_ROLE_FORBIDDEN') return response.error(res, 403, error.code, error.message);
        if (error.code === 'LAST_TENANT_OWNER') return response.error(res, 409, error.code, error.message);
        log.error('tenant member role change', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    removeMember: (req, res) => {
      try {
        tenants.removeMember(db, req.params.tenantId, req.user.id, req.params.userId);
        response.success(res, { removed: true });
      } catch (error) {
        if (['TENANT_NOT_FOUND', 'USER_NOT_FOUND'].includes(error.code)) return response.notFound(res, '成员不存在');
        if (error.code === 'LAST_TENANT_OWNER') return response.error(res, 409, error.code, error.message);
        log.error('tenant member remove', { error: error.message });
        response.internalError(res, error.message);
      }
    },
  };
}

module.exports = routes;
