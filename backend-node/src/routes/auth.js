const response = require('../response');
const auth = require('../services/userAuthService');
const credits = require('../services/creditLedgerService');
const audit = require('../services/auditEventService');
const tenants = require('../services/tenantService');

function createAuthRoutes(db, options = {}) {
  auth.ensureSchema(db);
  credits.ensureSchema(db);
  audit.ensureSchema(db);
  tenants.ensureSchema(db);

  function register(req, res) {
    if (!options.registrationEnabled) {
      return response.error(res, 403, 'REGISTRATION_DISABLED', '注册暂未开放');
    }
    if (!auth.validSecret(options.jwtSecret)) {
      return response.error(res, 503, 'AUTH_NOT_CONFIGURED', '用户登录密钥未安全配置');
    }
    try {
      const user = db.transaction(() => {
        const created = auth.register(db, req.body || {});
        credits.setAccountBalance(db, created.id, 0);
        const tenant = tenants.ensurePersonalTenant(db, created);
        credits.setTenantAccountBalance(db, tenant.id, 0);
        audit.record(db, {
          userId: created.id,
          tenantId: tenant.id,
          eventType: 'auth.register.success',
          outcome: 'success',
        });
        return created;
      })();
      const token = auth.issueToken(user, options.jwtSecret);
      return response.created(res, { user, token });
    } catch (error) {
      if (error.code === 'EMAIL_EXISTS') return response.error(res, 409, error.code, error.message);
      if (error.code === 'INVALID_INPUT') return response.badRequest(res, error.message);
      if (error.code === 'AUTH_NOT_CONFIGURED') return response.error(res, 503, error.code, error.message);
      return response.internalError(res, '注册失败');
    }
  }

  function login(req, res) {
    try {
      const user = auth.authenticate(db, req.body?.email, req.body?.password);
      const tenant = tenants.ensurePersonalTenant(db, user);
      if (!credits.getTenantAccount(db, tenant.id)) credits.setTenantAccountBalance(db, tenant.id, 0);
      const token = auth.issueToken(user, options.jwtSecret);
      audit.record(db, {
        userId: user.id,
        tenantId: tenant.id,
        eventType: 'auth.login.success',
        outcome: 'success',
      });
      return response.success(res, { user, token });
    } catch (error) {
      if (error.code === 'INVALID_CREDENTIALS' || error.code === 'INVALID_INPUT') {
        audit.record(db, { eventType: 'auth.login.failed', outcome: 'failed', code: 'INVALID_CREDENTIALS' });
        return response.error(res, 401, 'INVALID_CREDENTIALS', '邮箱或密码错误');
      }
      if (error.code === 'AUTH_NOT_CONFIGURED') return response.error(res, 503, error.code, error.message);
      return response.internalError(res, '登录失败');
    }
  }

  function me(req, res) {
    return response.success(res, req.user);
  }

  return { register, login, me };
}

module.exports = createAuthRoutes;
