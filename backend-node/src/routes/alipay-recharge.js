const response = require('../response');
const recharge = require('../services/alipay-recharge-service');

function respondRechargeError(res, error) {
  if (error.code === 'ALIPAY_NOT_CONFIGURED') {
    response.error(res, 503, error.code, error.message);
    return true;
  }
  if (['INVALID_RECHARGE_AMOUNT', 'INVALID_RECHARGE_ORDER', 'INVALID_RECHARGE_PACKAGE'].includes(error.code)) {
    response.error(res, 400, error.code, error.message);
    return true;
  }
  if (['TENANT_NOT_FOUND', 'RECHARGE_PACKAGE_NOT_FOUND', 'RECHARGE_ORDER_NOT_FOUND'].includes(error.code)) {
    response.error(res, 404, error.code, error.message);
    return true;
  }
  if (['RECHARGE_PACKAGE_NOT_AVAILABLE', 'RECHARGE_ORDER_IDEMPOTENCY_CONFLICT'].includes(error.code)) {
    response.error(res, 409, error.code, error.message);
    return true;
  }
  return false;
}

function routes(db, log, gateway) {
  return {
    getConfig: (_req, res) => response.success(res, {
      channel: 'alipay',
      configured: Boolean(gateway?.configured),
      fixed_ratio_credits_per_yuan: recharge.CREDIT_RATIO,
      min_amount_yuan: (recharge.MIN_AMOUNT_CENTS / 100).toFixed(2),
      max_amount_yuan: (recharge.MAX_AMOUNT_CENTS / 100).toFixed(2),
    }),
    listPackages: (_req, res) => {
      try {
        response.success(res, recharge.listAvailablePackages(db));
      } catch (error) {
        log.error('alipay recharge list packages', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    listAdminPackages: (_req, res) => {
      try {
        response.success(res, recharge.listPackages(db));
      } catch (error) {
        log.error('alipay recharge admin list packages', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    createAdminPackage: (req, res) => {
      try {
        response.created(res, recharge.createPackage(db, req.body || {}));
      } catch (error) {
        if (respondRechargeError(res, error)) return;
        log.error('alipay recharge admin create package', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    updateAdminPackage: (req, res) => {
      try {
        response.success(res, recharge.updatePackage(db, req.params.packageId, req.body || {}));
      } catch (error) {
        if (respondRechargeError(res, error)) return;
        log.error('alipay recharge admin update package', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    createOrder: (req, res) => {
      try {
        if (!gateway?.configured) {
          const error = new Error('支付宝充值尚未完成配置');
          error.code = 'ALIPAY_NOT_CONFIGURED';
          throw error;
        }
        const order = recharge.createOrder(db, {
          tenantId: req.tenant.id,
          userId: req.user.id,
          amountYuan: req.body?.amount_yuan,
          packageId: req.body?.package_id,
          clientOrderKey: req.body?.client_order_key,
        });
        response.created(res, { order, payment_url: gateway.createPaymentUrl(order) });
      } catch (error) {
        if (respondRechargeError(res, error)) return;
        log.error('alipay recharge create order', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    listOrders: (req, res) => {
      try {
        response.success(res, recharge.listOrders(
          db,
          req.tenant.id,
          req.user.id,
          req.query?.limit,
        ));
      } catch (error) {
        if (respondRechargeError(res, error)) return;
        log.error('alipay recharge list orders', { error: error.message });
        response.internalError(res, error.message);
      }
    },
    notify: (req, res) => {
      try {
        recharge.processNotification(db, req.body || {}, gateway);
        res.status(200).type('text/plain').send('success');
      } catch (error) {
        log.error('alipay recharge notification rejected', {
          code: error.code,
          outTradeNo: String(req.body?.out_trade_no || ''),
        });
        res.status(400).type('text/plain').send('failure');
      }
    },
  };
}

module.exports = routes;
