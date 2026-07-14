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
      req.user = auth.verifyToken(match[1], secret);
      if (db) {
        const current = db.prepare('SELECT status FROM platform_users WHERE id = ?').get(req.user.id);
        if (!current || current.status !== 'active') throw new Error('inactive user');
      }
      return next();
    } catch {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: '登录已失效，请重新登录' } });
    }
  };
}

module.exports = { createUserAuthMiddleware };
