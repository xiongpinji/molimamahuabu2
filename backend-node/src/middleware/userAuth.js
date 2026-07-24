const auth = require('../services/userAuthService');

function createUserAuthMiddleware({ enabled, secret, db } = {}) {
  return (req, res, next) => {
    if (!enabled) return next();
    if (!auth.validSecret(secret)) {
      return res.status(503).json({ success: false, error: { code: 'AUTH_NOT_CONFIGURED', message: '用户登录服务未安全配置' } });
    }
    const match = /^Bearer\s+(.+)$/i.exec(String(req.get('authorization') || ''));
    if (!match) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: '请先登录' } });
    }
    try {
      const claims = auth.verifyToken(match[1], secret);
      if (db) {
        const current = db.prepare(`SELECT email, role, platform_role, status, token_version
          FROM platform_users WHERE id = ?`).get(claims.id);
        if (!current
          || current.status !== 'active'
          || (Number(current.token_version) || 0) !== claims.tokenVersion) {
          throw new Error('inactive user');
        }
        req.user = {
          id: claims.id,
          email: current.email,
          role: current.platform_role || current.role,
        };
      } else {
        req.user = { id: claims.id, email: claims.email, role: claims.role };
      }
      return next();
    } catch {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: '登录已失效，请重新登录' } });
    }
  };
}

module.exports = { createUserAuthMiddleware };
