const crypto = require('crypto');

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createAdminAuthMiddleware({ enabled, token } = {}) {
  return (req, res, next) => {
    if (!enabled) return next();
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
    next();
  };
}

module.exports = { createAdminAuthMiddleware };
