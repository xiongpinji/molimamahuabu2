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
    return FakeAlipaySdk.nextPageUrl;
  }

  async exec(method, params, options) {
    this.execRequest = { method, params, options };
    return FakeAlipaySdk.nextQueryResult;
  }

  checkNotifySignV2(payload) {
    this.notifyPayload = payload;
    return payload.sign === 'valid';
  }
}

FakeAlipaySdk.nextPageUrl = 'https://openapi.alipay.com/gateway.do?signed=1';
FakeAlipaySdk.nextQueryResult = {
  code: '10000',
  tradeStatus: 'TRADE_SUCCESS',
  outTradeNo: 'MOLI123',
  tradeNo: '2026080722000000000001',
  totalAmount: '12.34',
};

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
  FakeAlipaySdk.nextPageUrl = 'https://openapi.alipay.com/gateway.do?signed=1';
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
  assert.match(url, /^https:\/\/openapi\.alipay\.com\/gateway\.do\?/);
  assert.equal(gateway.verifyNotification({ sign: 'valid' }), true);
  assert.deepEqual(sdk.notifyPayload, { sign: 'valid' });
});

test('支付宝网关只允许官方生产与新版沙箱地址', () => {
  for (const gatewayUrl of [
    'https://openapi.alipay.com/gateway.do',
    'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
  ]) {
    FakeAlipaySdk.lastInstance = null;
    const gateway = createAlipayGateway(
      { ...configuredEnv, ALIPAY_GATEWAY: gatewayUrl },
      { AlipaySdk: FakeAlipaySdk },
    );
    assert.equal(gateway.configured, true);
    assert.equal(FakeAlipaySdk.lastInstance.options.gateway, gatewayUrl);
  }

  for (const gatewayUrl of [
    'https://pay.example.com/gateway.do',
    'https://openapi.alipay.com.example.com/gateway.do',
    'https://openapi.alipay.com:444/gateway.do',
    'https://user@openapi.alipay.com/gateway.do',
    'https://openapi.alipay.com/not-gateway.do',
  ]) {
    FakeAlipaySdk.lastInstance = null;
    const gateway = createAlipayGateway(
      { ...configuredEnv, ALIPAY_GATEWAY: gatewayUrl },
      { AlipaySdk: FakeAlipaySdk },
    );
    assert.equal(gateway.configured, false, gatewayUrl);
    assert.equal(FakeAlipaySdk.lastInstance, null, gatewayUrl);
  }
});

test('支付宝 SDK 返回非官方支付地址时拒绝跳转', () => {
  FakeAlipaySdk.nextPageUrl = 'https://pay.example.com/phishing';
  const gateway = createAlipayGateway(configuredEnv, { AlipaySdk: FakeAlipaySdk });
  assert.throws(
    () => gateway.createPaymentUrl({
      out_trade_no: 'MOLI-UNTRUSTED',
      amount_cents: 100,
      credits: 100,
    }),
    (error) => error.code === 'ALIPAY_PAYMENT_URL_INVALID',
  );
  FakeAlipaySdk.nextPageUrl = 'https://openapi.alipay.com/gateway.do?signed=1';
});

test('支付宝适配器可主动查询指定商户订单', async () => {
  const gateway = createAlipayGateway(configuredEnv, { AlipaySdk: FakeAlipaySdk });
  const result = await gateway.queryTrade('MOLI123');
  const sdk = FakeAlipaySdk.lastInstance;

  assert.deepEqual(sdk.execRequest, {
    method: 'alipay.trade.query',
    params: { bizContent: { out_trade_no: 'MOLI123' } },
    options: { validateSign: true },
  });
  assert.deepEqual(result, FakeAlipaySdk.nextQueryResult);
});
