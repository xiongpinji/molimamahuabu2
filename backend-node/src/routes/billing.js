const response = require('../response');
const modelPrice = require('../services/modelPriceService');
const creditLedger = require('../services/creditLedgerService');
const auditEvents = require('../services/auditEventService');
const subscriptions = require('../services/subscriptionBillingService');
const redeemCodes = require('../services/redeem-code-service');
const platformAdmin = require('../services/platform-admin-service');
const tenants = require('../services/tenantService');
const reconciliation = require('../services/billingReconciliationService');
const generationCost = require('../services/generationCostLedgerService');

function adminRedeemInput(db, req) {
  const input = {
    ...(req.body || {}),
    createdBy: req.user?.id,
  };
  const tenantId = String(input.tenantId ?? input.tenant_id ?? '').trim();
  if (tenantId) {
    tenants.ensureSchema(db);
    const tenant = db.prepare("SELECT id FROM tenants WHERE id = ? AND status = 'active'")
      .get(tenantId);
    if (!tenant) {
      const error = new Error('目标租户不存在或已停用');
      error.code = 'INVALID_REDEEM_CODE';
      throw error;
    }
  }
  return input;
}
function routes(db, log, runtime = {}) {
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
        const events = auditEvents.listForUser(db, req.user.id, req.query?.limit);
        response.success(res, events);
      } catch (error) {
        log.error('billing list audit events', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    redeemCredits: (req, res) => {
      try {
        response.success(res, redeemCodes.redeem(db, {
          code: req.body?.code,
          tenantId: req.tenant.id,
          userId: req.user.id,
        }));
      } catch (error) {
        if (['INVALID_REDEEM_CODE'].includes(error.code)) return response.badRequest(res, error.message);
        if (['REDEEM_CODE_NOT_FOUND'].includes(error.code)) return response.notFound(res, error.message);
        if (['CODE_DISABLED', 'CODE_EXPIRED', 'CODE_ALREADY_REDEEMED', 'CODE_EXHAUSTED'].includes(error.code)) {
          return response.error(res, 409, error.code, error.message);
        }
        log.error('billing redeem credits', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    listCreditTransactions: (req, res) => {
      try {
        response.success(res, creditLedger.listTenantAdjustments(
          db,
          req.tenant.id,
          req.query?.limit,
        ));
      } catch (error) {
        log.error('billing list credit transactions', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    listAdminUsers: (_req, res) => {
      try {
        response.success(res, platformAdmin.listUsers(db));
      } catch (error) {
        log.error('billing admin list users', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    updateAdminUser: (req, res) => {
      try {
        response.success(res, platformAdmin.updateUser(db, req.params.userId, {
          ...(req.body || {}),
          actorUserId: req.user?.id,
        }));
      } catch (error) {
        if (error.code === 'INVALID_USER_UPDATE') return response.badRequest(res, error.message);
        if (error.code === 'USER_NOT_FOUND') return response.notFound(res, error.message);
        log.error('billing admin update user', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    listAdminTenants: (_req, res) => {
      try {
        response.success(res, platformAdmin.listTenants(db));
      } catch (error) {
        log.error('billing admin list tenants', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    adjustAdminTenantCredits: (req, res) => {
      try {
        response.success(res, platformAdmin.adjustTenantCredits(
          db,
          req.params.tenantId,
          {
            ...(req.body || {}),
            actorUserId: req.user?.id,
          },
        ));
      } catch (error) {
        if (error.code === 'INVALID_CREDIT_ADJUSTMENT') return response.badRequest(res, error.message);
        if (error.code === 'TENANT_NOT_FOUND') return response.notFound(res, error.message);
        if (error.code === 'INSUFFICIENT_CREDITS') {
          return response.error(res, 409, error.code, error.message);
        }
        log.error('billing admin adjust tenant credits', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    listAdminCreditTransactions: (req, res) => {
      try {
        response.success(res, platformAdmin.listCreditTransactions(db, {
          tenantId: req.query?.tenant_id,
          limit: req.query?.limit,
        }));
      } catch (error) {
        log.error('billing admin list credit transactions', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    listReconciliationAnomalies: (req, res) => {
      try {
        response.success(res, reconciliation.listAnomalies(db, {
          olderThanMinutes: req.query?.older_than_minutes,
          limit: req.query?.limit,
        }));
      } catch (error) {
        if (error.code === 'INVALID_RECONCILIATION_INPUT') {
          return response.badRequest(res, error.message);
        }
        log.error('billing admin list reconciliation anomalies', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    listReconciliationHistory: (req, res) => {
      try {
        response.success(res, reconciliation.listHistory(db, {
          limit: req.query?.limit,
        }));
      } catch (error) {
        log.error('billing admin list reconciliation history', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    refundReconciliationReservation: (req, res) => {
      try {
        response.success(res, reconciliation.refundReservation(db, {
          reservationId: req.params.reservationId,
          idempotencyKey: req.body?.idempotency_key,
          reason: req.body?.reason,
          actorUserId: req.user?.id,
        }));
      } catch (error) {
        if (error.code === 'INVALID_RECONCILIATION_INPUT') {
          return response.badRequest(res, error.message);
        }
        if (error.code === 'RECONCILIATION_RESERVATION_NOT_FOUND') {
          return response.notFound(res, error.message);
        }
        if (['UNSAFE_RECONCILIATION_REFUND', 'RECONCILIATION_IDEMPOTENCY_CONFLICT'].includes(error.code)) {
          return response.error(res, 409, error.code, error.message);
        }
        log.error('billing admin refund reconciliation reservation', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    listAdminRedeemCodes: (_req, res) => {
      try {
        response.success(res, redeemCodes.listCodes(db));
      } catch (error) {
        log.error('billing admin list redeem codes', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    createAdminRedeemCode: (req, res) => {
      try {
        response.created(res, redeemCodes.createCode(db, adminRedeemInput(db, req)));
      } catch (error) {
        if (error.code === 'INVALID_REDEEM_CODE') return response.badRequest(res, error.message);
        log.error('billing admin create redeem code', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    createAdminRedeemCodes: (req, res) => {
      try {
        response.created(res, redeemCodes.createCodes(db, adminRedeemInput(db, req)));
      } catch (error) {
        if (error.code === 'INVALID_REDEEM_CODE') return response.badRequest(res, error.message);
        log.error('billing admin create redeem codes', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    listAdminRedeemCodeUsages: (req, res) => {
      try {
        response.success(res, redeemCodes.listUsages(db, req.params.codeId));
      } catch (error) {
        if (error.code === 'REDEEM_CODE_NOT_FOUND') return response.notFound(res, error.message);
        log.error('billing admin list redeem code usages', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    updateAdminRedeemCode: (req, res) => {
      try {
        response.success(res, redeemCodes.updateCode(db, req.params.codeId, req.body || {}));
      } catch (error) {
        if (error.code === 'INVALID_REDEEM_CODE') return response.badRequest(res, error.message);
        if (error.code === 'REDEEM_CODE_NOT_FOUND') return response.notFound(res, error.message);
        log.error('billing admin update redeem code', { error: error.message });
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
    listPublicCatalog: (_req, res) => {
      try {
        response.success(res, modelPrice.listPublic(db, runtime));
      } catch (error) {
        log.error('billing list public catalog', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    updatePrice: (req, res) => {
      try {
        response.success(res, modelPrice.set(db, req.params.model, req.body?.credits, req.body || {}));
      } catch (error) {
        log.error('billing update price', { error: error.message });
        if (error.code === 'INVALID_MODEL_PRICE' || error.code === 'UNSUPPORTED_BILLING_MODEL') {
          return response.badRequest(res, error.message);
        }
        response.internalError(res, error.message);
      }
    },
    getLedgerSettings: (_req, res) => {
      try {
        response.success(res, generationCost.getSettings(db));
      } catch (error) {
        log.error('billing get ledger settings', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    updateLedgerSettings: (req, res) => {
      try {
        response.success(res, generationCost.updateSettings(
          db,
          req.body?.credit_value_micros,
        ));
      } catch (error) {
        if (error.code === 'INVALID_BILLING_SETTING') {
          return response.badRequest(res, error.message);
        }
        log.error('billing update ledger settings', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    getLedgerReport: (req, res) => {
      try {
        response.success(res, generationCost.report(db, req.query?.period || 'day'));
      } catch (error) {
        if (error.code === 'INVALID_LEDGER_PERIOD') {
          return response.badRequest(res, error.message);
        }
        log.error('billing get ledger report', { error: error.message });
        response.internalError(res, error.message);
      }
    },
  };
}

module.exports = routes;
