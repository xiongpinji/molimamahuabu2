const response = require('../response');
const modelPrice = require('../services/modelPriceService');
const creditLedger = require('../services/creditLedgerService');
const auditEvents = require('../services/auditEventService');
const subscriptions = require('../services/subscriptionBillingService');

function routes(db, log) {
  return {
    getAccount: (req, res) => {
      try {
        const userId = String(req.user.id);
        const tenantId = req.tenant?.id;
        const account = tenantId
          ? creditLedger.getTenantAccount(db, tenantId)
            || { tenant_id: tenantId, available: 0, held: 0, spent: 0 }
          : creditLedger.getAccount(db, userId)
            || { user_id: userId, available: 0, held: 0, spent: 0 };
        response.success(res, account);
      } catch (error) {
        log.error('billing get account', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    listAuditEvents: (req, res) => {
      try {
        const events = req.tenant?.id
          ? auditEvents.listForTenant(db, req.tenant.id, req.query?.limit)
          : auditEvents.listForUser(db, req.user.id, req.query?.limit);
        response.success(res, events);
      } catch (error) {
        log.error('billing list audit events', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    listPlans: (_req, res) => {
      try {
        response.success(res, subscriptions.listPlans(db));
      } catch (error) {
        log.error('billing list plans', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    listAdminPlans: (_req, res) => {
      try {
        response.success(res, subscriptions.listPlans(db, { includeArchived: true }));
      } catch (error) {
        log.error('billing admin list plans', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    upsertPlan: (req, res) => {
      try {
        response.success(res, subscriptions.upsertPlan(db, req.params.planId, req.body || {}));
      } catch (error) {
        if (error.code === 'INVALID_BILLING_PLAN') return response.badRequest(res, error.message);
        log.error('billing upsert plan', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    getSubscription: (req, res) => {
      try {
        response.success(res, subscriptions.getCurrentSubscription(db, req.tenant.id));
      } catch (error) {
        log.error('billing get subscription', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    listOrders: (req, res) => {
      try {
        response.success(res, subscriptions.listOrders(db, req.tenant.id, req.user.id));
      } catch (error) {
        if (error.code === 'TENANT_NOT_FOUND') return response.notFound(res, '租户不存在');
        log.error('billing list orders', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    createOrder: (req, res) => {
      try {
        response.created(res, subscriptions.createOrder(db, {
          tenantId: req.tenant.id,
          userId: req.user.id,
          planId: req.body?.plan_id,
          clientOrderKey: req.body?.client_order_key,
        }));
      } catch (error) {
        if (['INVALID_ORDER'].includes(error.code)) return response.badRequest(res, error.message);
        if (['TENANT_NOT_FOUND', 'PLAN_NOT_FOUND'].includes(error.code)) return response.notFound(res, error.message);
        log.error('billing create order', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    cancelOrder: (req, res) => {
      try {
        response.success(res, subscriptions.cancelOrder(
          db, req.tenant.id, req.user.id, req.params.orderId,
        ));
      } catch (error) {
        if (['TENANT_NOT_FOUND', 'ORDER_NOT_FOUND'].includes(error.code)) {
          return response.notFound(res, error.message);
        }
        if (error.code === 'ORDER_NOT_CANCELABLE') {
          return response.error(res, 409, error.code, error.message);
        }
        log.error('billing cancel order', { error: error.message });
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
