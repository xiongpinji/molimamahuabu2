const crypto = require('crypto');

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createAdminAuthMiddleware({ enabled, token, requireRole = true } = {}) {
  return (req, res, next) => {
    if (!enabled) return next();
    if (requireRole && req.user) {
      if (req.user.role === 'admin') return next();
      return res.status(403).json({
        success: false,
        error: { code: 'ADMIN_ROLE_REQUIRED', message: '当前账号不具备管理员权限' },
      });
    }
    const expected = String(token || '');
    if (expected.length < 32) {
      return res.status(503).json({
        success: false,
        error: { code: 'ADMIN_AUTH_NOT_CONFIGURED', message: '公开模式尚未配置安全的管理员令牌' },
      });
    }
    const supplied = String(req.get('x-platform-admin-token') || '');
    if (!secureEqual(supplied, expected)) {
      return res.status(401).json({
        success: false,
        error: { code: 'ADMIN_AUTH_REQUIRED', message: '需要管理员身份' },
      });
    }
    if (requireRole && req.user?.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: { code: 'ADMIN_ROLE_REQUIRED', message: '当前账号不具备管理员权限' },
      });
    }
    next();
  };
}

module.exports = { createAdminAuthMiddleware };
