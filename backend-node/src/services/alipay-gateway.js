const fs = require('fs');

function gatewayError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function inlinePem(value) {
  return String(value || '').replaceAll('\\n', '\n').trim();
}

function readSecret(env, valueName, pathName, readFileSync) {
  if (env[valueName]) return inlinePem(env[valueName]);
  if (!env[pathName]) return '';
  try {
    return String(readFileSync(env[pathName], 'utf8')).trim();
  } catch (_) {
    return '';
  }
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function createAlipayGateway(env = process.env, dependencies = {}) {
  const readFileSync = dependencies.readFileSync || fs.readFileSync;
  const appId = String(env.ALIPAY_APP_ID || '').trim();
  const sellerId = String(env.ALIPAY_SELLER_ID || '').trim();
  const privateKey = readSecret(env, 'ALIPAY_PRIVATE_KEY', 'ALIPAY_PRIVATE_KEY_PATH', readFileSync);
  const alipayPublicKey = readSecret(env, 'ALIPAY_PUBLIC_KEY', 'ALIPAY_PUBLIC_KEY_PATH', readFileSync);
  const notifyUrl = String(env.ALIPAY_NOTIFY_URL || '').trim();
  const returnUrl = String(env.ALIPAY_RETURN_URL || '').trim();
  const keyType = ['PKCS1', 'PKCS8'].includes(String(env.ALIPAY_KEY_TYPE || '').toUpperCase())
    ? String(env.ALIPAY_KEY_TYPE).toUpperCase()
    : 'PKCS8';
  const configured = Boolean(
    appId && sellerId && privateKey && alipayPublicKey
      && isHttpsUrl(notifyUrl) && isHttpsUrl(returnUrl),
  );

  let sdk = null;
  if (configured) {
    const AlipaySdk = dependencies.AlipaySdk || require('alipay-sdk').AlipaySdk;
    sdk = new AlipaySdk({
      appId,
      privateKey,
      alipayPublicKey,
      keyType,
      signType: 'RSA2',
      gateway: String(env.ALIPAY_GATEWAY || 'https://openapi.alipay.com/gateway.do'),
    });
  }

  function requireConfigured() {
    if (!configured) throw gatewayError('ALIPAY_NOT_CONFIGURED', '支付宝充值尚未完成配置');
  }

  return {
    configured,
    appId,
    sellerId,
    createPaymentUrl(order) {
      requireConfigured();
      const packageName = String(order.package_name || '自定义充值');
      return sdk.pageExecute('alipay.trade.page.pay', 'GET', {
        bizContent: {
          out_trade_no: String(order.out_trade_no),
          product_code: 'FAST_INSTANT_TRADE_PAY',
          subject: `茉莉妈妈积分充值 - ${packageName}`,
          body: `支付后到账 ${Number(order.credits)} 积分`,
          total_amount: (Number(order.amount_cents) / 100).toFixed(2),
          timeout_express: '30m',
        },
        notifyUrl,
        returnUrl,
      });
    },
    verifyNotification(payload) {
      requireConfigured();
      return sdk.checkNotifySignV2(payload);
    },
  };
}

module.exports = { createAlipayGateway };
