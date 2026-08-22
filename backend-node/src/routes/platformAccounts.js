const response = require('../response');
const platformAdmin = require('../services/platform-admin-service');

function handleError(res, log, action, error) {
  if (['INVALID_USER_ROLE', 'INVALID_USER_STATUS'].includes(error.code)) {
    return response.badRequest(res, error.message);
  }
  if (error.code === 'USER_NOT_FOUND') return response.notFound(res, error.message);
  if (['CANNOT_SUSPEND_SELF', 'LAST_ACTIVE_ADMIN'].includes(error.code)) {
    return response.error(res, 409, error.code, error.message);
  }
  log.error(`platform accounts ${action}`, { error: error.message });
  return response.internalError(res, '账号管理操作失败');
}

function routes(db, log) {
  return {
    listUsers: (_req, res) => {
      try {
        return response.success(res, platformAdmin.listUsers(db));
      } catch (error) {
        return handleError(res, log, 'list users', error);
      }
    },
    changeRole: (req, res) => {
      try {
        return response.success(res, platformAdmin.changeUserRole(db, {
          actorUserId: req.user?.id,
          targetUserId: req.params.userId,
          role: req.body?.role,
        }));
      } catch (error) {
        return handleError(res, log, 'change role', error);
      }
    },
    changeStatus: (req, res) => {
      try {
        return response.success(res, platformAdmin.changeUserStatus(db, {
          actorUserId: req.user?.id,
          targetUserId: req.params.userId,
          status: req.body?.status,
        }));
      } catch (error) {
        return handleError(res, log, 'change status', error);
      }
    },
    forceLogout: (req, res) => {
      try {
        return response.success(res, platformAdmin.forceLogout(db, {
          actorUserId: req.user?.id,
          targetUserId: req.params.userId,
        }));
      } catch (error) {
        return handleError(res, log, 'force logout', error);
      }
    },
  };
}

module.exports = routes;
