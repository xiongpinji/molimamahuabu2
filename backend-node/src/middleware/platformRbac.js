const PERMISSIONS = Object.freeze({
  USERS_READ: 'platform.users.read',
  USERS_ROLE: 'platform.users.role',
  USERS_STATUS: 'platform.users.status',
  USERS_FORCE_LOGOUT: 'platform.users.force_logout',
  BILLING_MANAGE: 'platform.billing.manage',
  REDEEM_CODES_MANAGE: 'platform.redeem_codes.manage',
});

const ROLE_PERMISSIONS = Object.freeze({
  admin: Object.freeze(Object.values(PERMISSIONS)),
  ops: Object.freeze([
    PERMISSIONS.USERS_READ,
    PERMISSIONS.USERS_STATUS,
    PERMISSIONS.USERS_FORCE_LOGOUT,
  ]),
  support: Object.freeze([
    PERMISSIONS.USERS_READ,
    PERMISSIONS.USERS_FORCE_LOGOUT,
  ]),
  read_only: Object.freeze([PERMISSIONS.USERS_READ]),
  redeem_admin: Object.freeze([PERMISSIONS.REDEEM_CODES_MANAGE]),
  user: Object.freeze([]),
});

function createPlatformPermissionMiddleware(permission, { enabled = true } = {}) {
  return (req, res, next) => {
    if (!enabled) return next();
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: '请先登录' },
      });
    }
    if (!(ROLE_PERMISSIONS[req.user.role] || []).includes(permission)) {
      return res.status(403).json({
        success: false,
        error: { code: 'PLATFORM_PERMISSION_DENIED', message: '无权执行此操作' },
      });
    }
    return next();
  };
}

module.exports = { PERMISSIONS, ROLE_PERMISSIONS, createPlatformPermissionMiddleware };
