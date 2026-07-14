const response = require('../response');
const modelPrice = require('../services/modelPriceService');
const creditLedger = require('../services/creditLedgerService');
const auditEvents = require('../services/auditEventService');

function routes(db, log) {
  return {
    getAccount: (req, res) => {
      try {
        const userId = String(req.user.id);
        const account = creditLedger.getAccount(db, userId) || { user_id: userId, available: 0, held: 0, spent: 0 };
        response.success(res, account);
      } catch (error) {
        log.error('billing get account', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    listAuditEvents: (req, res) => {
      try {
        const events = auditEvents.listForUser(db, req.user.id, req.query?.limit);
        response.success(res, events);
      } catch (error) {
        log.error('billing list audit events', { error: error.message });
        response.internalError(res, error.message);
      }
    },

    listPrices: (_req, res) => {
      try {
        response.success(res, modelPrice.list(db));
      } catch (error) {
        log.error('billing list prices', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    updatePrice: (req, res) => {
      try {
        response.success(res, modelPrice.set(db, req.params.model, req.body?.credits));
      } catch (error) {
        log.error('billing update price', { error: error.message });
        if (error.code === 'INVALID_MODEL_PRICE' || error.code === 'UNSUPPORTED_BILLING_MODEL') {
          return response.badRequest(res, error.message);
        }
        response.internalError(res, error.message);
      }
    },
  };
}

module.exports = routes;
