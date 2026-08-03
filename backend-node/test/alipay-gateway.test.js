const test = require('node:test');
const assert = require('node:assert/strict');

const { createAlipayGateway } = require('../src/services/alipay-gateway');

class FakeAlipaySdk {
  constructor(options) {
    this.options = options;
    FakeAlipaySdk.lastInstance = this;
  }

  pageExecute(method, httpMethod, params) {
    this.pageRequest = { method, httpMethod, params };
    return 'https://openapi.alipay.test/gateway.do?signed=1';
  }

  checkNotifySignV2(payload) {
    this.notifyPayload = payload;
    return payload.sign === 'valid';
  }
}

const configuredEnv = {
  ALIPAY_APP_ID: 'app-123',
  ALIPAY_SELLER_ID: '2088000000000000',
  ALIPAY_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nprivate\\n-----END PRIVATE KEY-----',
  ALIPAY_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\\npublic\\n-----END PUBLIC KEY-----',
  ALIPAY_NOTIFY_URL: 'https://api.example.com/api/v1/billing/recharge/alipay/notify',
  ALIPAY_RETURN_URL: 'https://app.example.com/tenant-console?section=recharge',
};

test('支付宝配置不完整时关闭支付且不创建 SDK', () => {
  FakeAlipaySdk.lastInstance = null;
  const gateway = createAlipayGateway({}, { AlipaySdk: FakeAlipaySdk });
  assert.equal(gateway.configured, false);
  assert.equal(FakeAlipaySdk.lastInstance, null);
  assert.throws(
    () => gateway.createPaymentUrl({}),
    (error) => error.code === 'ALIPAY_NOT_CONFIGURED',
  );
});

test('支付宝适配器生成电脑网站支付链接并使用官方通知验签', () => {
  const gateway = createAlipayGateway(configuredEnv, { AlipaySdk: FakeAlipaySdk });
  const url = gateway.createPaymentUrl({
    out_trade_no: 'MOLI123',
    amount_cents: 1234,
    credits: 1500,
    package_name: '限时套餐',
  });
  const sdk = FakeAlipaySdk.lastInstance;

  assert.equal(gateway.configured, true);
  assert.equal(gateway.appId, configuredEnv.ALIPAY_APP_ID);
  assert.equal(gateway.sellerId, configuredEnv.ALIPAY_SELLER_ID);
  assert.equal(sdk.options.privateKey.includes('\\n'), false);
  assert.equal(sdk.options.keyType, 'PKCS8');
  assert.equal(sdk.pageRequest.method, 'alipay.trade.page.pay');
  assert.equal(sdk.pageRequest.httpMethod, 'GET');
  assert.deepEqual(sdk.pageRequest.params.bizContent, {
    out_trade_no: 'MOLI123',
    product_code: 'FAST_INSTANT_TRADE_PAY',
    subject: '茉莉妈妈积分充值 - 限时套餐',
    body: '支付后到账 1500 积分',
    total_amount: '12.34',
    timeout_express: '30m',
  });
  assert.equal(sdk.pageRequest.params.notifyUrl, configuredEnv.ALIPAY_NOTIFY_URL);
  assert.equal(sdk.pageRequest.params.returnUrl, configuredEnv.ALIPAY_RETURN_URL);
  assert.match(url, /^https:\/\/openapi\.alipay\.test\//);
  assert.equal(gateway.verifyNotification({ sign: 'valid' }), true);
  assert.deepEqual(sdk.notifyPayload, { sign: 'valid' });
});
