const response = require('../response');
const auth = require('../services/userAuthService');
const credits = require('../services/creditLedgerService');
const audit = require('../services/auditEventService');
const tenants = require('../services/tenantService');
const verification = require('../services/authVerificationService');

function createAuthRoutes(db, options = {}) {
  auth.ensureSchema(db);
  credits.ensureSchema(db);
  audit.ensureSchema(db);
  tenants.ensureSchema(db);
  verification.ensureSchema(db);

  function verificationReady(res) {
    if (!options.emailVerificationEnabled) {
      response.error(res, 503, 'EMAIL_VERIFICATION_DISABLED', '邮箱验证码功能尚未启用');
      return false;
    }
    if (!auth.validSecret(options.verificationSecret)) {
      response.error(res, 503, 'AUTH_NOT_CONFIGURED', '邮箱验证码密钥未安全配置');
      return false;
    }
    if (!options.mailer?.isConfigured?.()) {
      response.error(res, 503, 'EMAIL_NOT_CONFIGURED', '邮箱服务尚未配置');
      return false;
    }
    return true;
  }

  async function sendCode(req, res, purpose) {
    if (purpose === 'register' && !options.registrationEnabled) {
      return response.error(res, 403, 'REGISTRATION_DISABLED', '注册暂未开放');
    }
    if (!verificationReady(res)) return undefined;
    try {
      const email = auth.normalizeEmail(req.body?.email);
      if (purpose === 'register' && auth.getUserByEmail(db, email)) {
        return response.success(res, {
          message: '如该邮箱可用于注册，验证码将发送至邮箱',
        });
      }
      // 找回密码不暴露邮箱是否存在；未注册邮箱也返回同样成功响应，但不发送邮件。
      if (purpose === 'password_reset' && !auth.getUserByEmail(db, email)) {
        return response.success(res, { message: '如该邮箱已注册，验证码将发送至邮箱' });
      }
      const issued = verification.issue(db, {
        email,
        purpose,
        secret: options.verificationSecret,
        generateCode: options.generateVerificationCode,
      });
      await options.mailer.sendVerificationCode({
        to: issued.email,
        code: issued.code,
        purpose,
      });
      audit.record(db, {
        eventType: `auth.${purpose}.code_sent`,
        outcome: 'success',
      });
      return response.success(res, {
        message: purpose === 'register'
          ? '如该邮箱可用于注册，验证码将发送至邮箱'
          : '如该邮箱已注册，验证码将发送至邮箱',
      });
    } catch (error) {
      if (error.code === 'INVALID_INPUT') return response.badRequest(res, error.message);
      if (error.code === 'EMAIL_NOT_CONFIGURED' || error.code === 'AUTH_NOT_CONFIGURED') {
        return response.error(res, 503, error.code, error.message);
      }
      return response.internalError(res, '验证码发送失败');
    }
  }

  function requestRegistrationCode(req, res) {
    return sendCode(req, res, 'register');
  }

  function requestPasswordResetCode(req, res) {
    return sendCode(req, res, 'password_reset');
  }

  function register(req, res) {
    if (!options.registrationEnabled) {
      return response.error(res, 403, 'REGISTRATION_DISABLED', '注册暂未开放');
    }
    if (!auth.validSecret(options.jwtSecret)) {
      return response.error(res, 503, 'AUTH_NOT_CONFIGURED', '用户登录密钥未安全配置');
    }
    try {
      const user = db.transaction(() => {
        if (options.emailVerificationEnabled) {
          verification.consume(db, {
            email: req.body?.email,
            purpose: 'register',
            code: req.body?.verification_code,
            secret: options.verificationSecret,
          });
        }
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
      const token = auth.issueToken(user, options.jwtSecret, auth.getTokenVersion(db, user.id));
      return response.created(res, { user, token });
    } catch (error) {
      if (error.code === 'EMAIL_EXISTS') return response.error(res, 409, error.code, error.message);
      if (error.code === 'VERIFICATION_INVALID') return response.error(res, 400, error.code, error.message);
      if (error.code === 'INVALID_INPUT') return response.badRequest(res, error.message);
      if (error.code === 'AUTH_NOT_CONFIGURED') return response.error(res, 503, error.code, error.message);
      return response.internalError(res, '注册失败');
    }
  }

  function resetPassword(req, res) {
    if (!options.emailVerificationEnabled) {
      return response.error(res, 503, 'EMAIL_VERIFICATION_DISABLED', '邮箱验证码功能尚未启用');
    }
    try {
      db.transaction(() => {
        verification.consume(db, {
          email: req.body?.email,
          purpose: 'password_reset',
          code: req.body?.verification_code,
          secret: options.verificationSecret,
        });
        const user = auth.resetPassword(db, req.body?.email, req.body?.new_password);
        audit.record(db, {
          userId: user.id,
          eventType: 'auth.password_reset.success',
          outcome: 'success',
        });
      })();
      return response.success(res, { message: '密码已重置，请重新登录' });
    } catch (error) {
      if (error.code === 'VERIFICATION_INVALID') {
        return response.error(res, 400, error.code, '验证码无效或已过期');
      }
      if (error.code === 'INVALID_INPUT') return response.badRequest(res, error.message);
      if (error.code === 'AUTH_NOT_CONFIGURED') return response.error(res, 503, error.code, error.message);
      return response.internalError(res, '密码重置失败');
    }
  }

  function changePassword(req, res) {
    try {
      if (!req.user?.email) {
        return response.error(res, 401, 'UNAUTHORIZED', '请先登录');
      }
      auth.authenticate(db, req.user.email, req.body?.current_password);
      const user = auth.resetPassword(db, req.user.email, req.body?.new_password);
      audit.record(db, {
        userId: user.id,
        eventType: 'auth.password_change.success',
        outcome: 'success',
      });
      return response.success(res, { message: '密码已修改，请重新登录' });
    } catch (error) {
      if (error.code === 'INVALID_CREDENTIALS') {
        return response.error(res, 401, error.code, '当前密码错误');
      }
      if (error.code === 'INVALID_INPUT') return response.badRequest(res, error.message);
      return response.internalError(res, '密码修改失败');
    }
  }

  function login(req, res) {
    try {
      const user = auth.authenticate(db, req.body?.email, req.body?.password);
      const tenant = tenants.ensurePersonalTenant(db, user);
      if (!credits.getTenantAccount(db, tenant.id)) credits.setTenantAccountBalance(db, tenant.id, 0);
      const token = auth.issueToken(user, options.jwtSecret, auth.getTokenVersion(db, user.id));
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

  function bootstrapAdmin(req, res) {
    const configuredEmail = String(options.bootstrapAdminEmail || '').trim().toLowerCase();
    if (!configuredEmail) {
      return response.error(res, 503, 'ADMIN_BOOTSTRAP_NOT_CONFIGURED', '首管理员引导尚未配置');
    }
    if (!req.user || String(req.user.email || '').trim().toLowerCase() !== configuredEmail) {
      return response.error(res, 403, 'ADMIN_BOOTSTRAP_IDENTITY_MISMATCH', '当前账号不是指定的首管理员');
    }
    const user = auth.bootstrapFirstAdmin(db, configuredEmail);
    if (!user) {
      return response.error(res, 409, 'ADMIN_BOOTSTRAP_CLOSED', '系统已存在管理员账号');
    }
    const token = auth.issueToken(user, options.jwtSecret, auth.getTokenVersion(db, user.id));
    return response.success(res, { user, token });
  }

  return {
    requestRegistrationCode,
    register,
    login,
    requestPasswordResetCode,
    resetPassword,
    changePassword,
    me,
    bootstrapAdmin,
  };
}

module.exports = createAuthRoutes;
