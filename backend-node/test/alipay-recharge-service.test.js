const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const tenantService = require('../src/services/tenantService');
const userAuth = require('../src/services/userAuthService');
const creditLedger = require('../src/services/creditLedgerService');
const recharge = require('../src/services/alipay-recharge-service');

function setup() {
  const db = new Database(':memory:');
  userAuth.ensureSchema(db);
  tenantService.ensureSchema(db);
  creditLedger.ensureSchema(db);
  recharge.ensureSchema(db);
  db.prepare(`INSERT INTO platform_users
    (id, email, password_hash, password_salt, status)
    VALUES ('user-1', 'owner@example.com', 'hash', 'salt', 'active')`).run();
  const tenant = tenantService.createTenant(db, 'user-1', {
    name: '一号工作区',
    slug: 'workspace-one',
  });
  creditLedger.setTenantAccountBalance(db, tenant.id, 0);
  return { db, tenant };
}

test('用户自定义充值固定按 1 元兑换 100 积分且幂等建单不提前入账', () => {
  const { db, tenant } = setup();
  const first = recharge.createOrder(db, {
    tenantId: tenant.id,
    userId: 'user-1',
    amountYuan: '12.34',
    clientOrderKey: 'custom-order-001',
  });
  const repeated = recharge.createOrder(db, {
    tenantId: tenant.id,
    userId: 'user-1',
    amountYuan: '12.34',
    clientOrderKey: 'custom-order-001',
  });

  assert.equal(first.id, repeated.id);
  assert.equal(first.order_kind, 'custom');
  assert.equal(first.amount_cents, 1234);
  assert.equal(first.credits, 1234);
  assert.equal(first.status, 'pending');
  assert.match(first.out_trade_no, /^MOLI[0-9A-F]{32}$/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_recharge_orders').get().count, 1);
  assert.equal(creditLedger.getTenantAccount(db, tenant.id).available, 0);
});

test('同一幂等键不能被改成不同金额或不同套餐', () => {
  const { db, tenant } = setup();
  recharge.createOrder(db, {
    tenantId: tenant.id,
    userId: 'user-1',
    amountYuan: '10',
    clientOrderKey: 'same-key-different-payload',
  });

  assert.throws(() => recharge.createOrder(db, {
    tenantId: tenant.id,
    userId: 'user-1',
    amountYuan: '20',
    clientOrderKey: 'same-key-different-payload',
  }), (error) => error.code === 'RECHARGE_ORDER_IDEMPOTENCY_CONFLICT');
});

test('同一工作区的不同用户只能查看本人充值订单', () => {
  const { db, tenant } = setup();
  db.prepare(`INSERT INTO platform_users
    (id, email, password_hash, password_salt, status)
    VALUES ('user-2', 'member@example.com', 'hash', 'salt', 'active')`).run();
  tenantService.addMemberByEmail(db, tenant.id, 'user-1', {
    email: 'member@example.com',
    role: 'member',
  });
  const ownerOrder = recharge.createOrder(db, {
    tenantId: tenant.id,
    userId: 'user-1',
    amountYuan: '10',
    clientOrderKey: 'owner-private-order',
  });
  const memberOrder = recharge.createOrder(db, {
    tenantId: tenant.id,
    userId: 'user-2',
    amountYuan: '20',
    clientOrderKey: 'member-private-order',
  });

  assert.deepEqual(recharge.listOrders(db, tenant.id, 'user-1').map((item) => item.id), [ownerOrder.id]);
  assert.deepEqual(recharge.listOrders(db, tenant.id, 'user-2').map((item) => item.id), [memberOrder.id]);
});

test('自定义充值拒绝小于 1 元、超过两位小数和超过 5 万元的金额', () => {
  const { db, tenant } = setup();
  for (const amountYuan of ['0.99', '1.001', '50000.01', 'abc']) {
    assert.throws(() => recharge.createOrder(db, {
      tenantId: tenant.id,
      userId: 'user-1',
      amountYuan,
      clientOrderKey: `invalid-${amountYuan}`,
    }), (error) => error.code === 'INVALID_RECHARGE_AMOUNT');
  }
});

test('管理员限时套餐按售价和积分展示并在下单时保存快照', () => {
  const { db, tenant } = setup();
  const active = recharge.createPackage(db, {
    name: '暑期限时包',
    adTitle: '暑期限时加赠',
    amountYuan: '9.90',
    credits: 1500,
    startsAt: '2026-08-01T00:00:00.000Z',
    endsAt: '2026-08-10T00:00:00.000Z',
    imageUrl: 'https://cdn.example.com/summer.jpg',
    status: 'active',
  });
  recharge.createPackage(db, {
    name: '尚未开始',
    adTitle: '秋季预售套餐',
    amountYuan: '19.90',
    credits: 2500,
    startsAt: '2026-08-20T00:00:00.000Z',
    endsAt: '2026-08-30T00:00:00.000Z',
    imageUrl: 'https://cdn.example.com/future.jpg',
    status: 'active',
  });

  const available = recharge.listAvailablePackages(db, '2026-08-03T00:00:00.000Z');
  assert.deepEqual(available.map((item) => item.id), [active.id]);
  assert.equal(available[0].amount_cents, 990);
  assert.equal(available[0].credits, 1500);

  const order = recharge.createOrder(db, {
    tenantId: tenant.id,
    userId: 'user-1',
    packageId: active.id,
    clientOrderKey: 'package-order-001',
    now: '2026-08-03T00:00:00.000Z',
  });
  recharge.updatePackage(db, active.id, {
    name: '暑期限时包（已调整）',
    adTitle: '暑期加赠已升级',
    amountYuan: '19.90',
    credits: 2000,
    startsAt: '2026-08-01T00:00:00.000Z',
    endsAt: '2026-08-10T00:00:00.000Z',
    imageUrl: 'https://cdn.example.com/summer-v2.jpg',
    status: 'active',
  });

  const persisted = db.prepare('SELECT * FROM tenant_recharge_orders WHERE id = ?').get(order.id);
  assert.equal(persisted.order_kind, 'package');
  assert.equal(persisted.package_id, active.id);
  assert.equal(persisted.package_name, '暑期限时包');
  assert.equal(persisted.amount_cents, 990);
  assert.equal(persisted.credits, 1500);
});

test('套餐拒绝无效时间、非 HTTPS 广告图且过期后不能下单', () => {
  const { db, tenant } = setup();
  assert.throws(() => recharge.createPackage(db, {
    name: '缺少广告图',
    adTitle: '体验套餐',
    amountYuan: '0.01',
    credits: 10,
    status: 'active',
  }), (error) => error.code === 'INVALID_RECHARGE_PACKAGE');

  const smallAmount = recharge.createPackage(db, {
    name: '一分钱体验包',
    adTitle: '新人一分体验',
    amountYuan: '0.01',
    credits: 10,
    imageUrl: 'https://cdn.example.com/trial.jpg',
    status: 'active',
  });
  assert.equal(smallAmount.amount_cents, 1);

  assert.throws(() => recharge.createPackage(db, {
    name: '错误套餐',
    adTitle: '错误套餐',
    amountYuan: '10',
    credits: 1000,
    startsAt: '2026-08-10T00:00:00.000Z',
    endsAt: '2026-08-01T00:00:00.000Z',
    imageUrl: 'http://cdn.example.com/banner.jpg',
    status: 'active',
  }), (error) => error.code === 'INVALID_RECHARGE_PACKAGE');

  const expired = recharge.createPackage(db, {
    name: '已结束套餐',
    adTitle: '活动已结束',
    amountYuan: '10',
    credits: 1200,
    startsAt: '2026-07-01T00:00:00.000Z',
    endsAt: '2026-08-01T00:00:00.000Z',
    imageUrl: 'https://cdn.example.com/expired.jpg',
    status: 'active',
  });
  assert.throws(() => recharge.createOrder(db, {
    tenantId: tenant.id,
    userId: 'user-1',
    packageId: expired.id,
    clientOrderKey: 'expired-package-order',
    now: '2026-08-03T00:00:00.000Z',
  }), (error) => error.code === 'RECHARGE_PACKAGE_NOT_AVAILABLE');
});

test('套餐结构化展示字段支持 snake_case 与 camelCase 并保存本地广告图', () => {
  const { db } = setup();
  const created = recharge.createPackage(db, {
    name: '春日加赠包',
    amountYuan: '29.90',
    credits: 4000,
    image_url: '/static/uploads/recharge-packages/spring.webp',
    badge_text: '限时',
    ad_title: '春日积分加赠',
    ad_subtitle: '购买即享额外积分',
    button_text: '抢先购买',
    accent_color: '#FFAA33',
    sort_order: 12,
    is_featured: '1',
    status: 'active',
  });

  assert.equal(created.image_url, '/static/uploads/recharge-packages/spring.webp');
  assert.equal(created.badge_text, '限时');
  assert.equal(created.ad_title, '春日积分加赠');
  assert.equal(created.ad_subtitle, '购买即享额外积分');
  assert.equal(created.button_text, '抢先购买');
  assert.equal(created.accent_color, '#ffaa33');
  assert.equal(created.sort_order, 12);
  assert.equal(created.is_featured, 1);

  const updated = recharge.updatePackage(db, created.id, {
    name: '春日加赠包升级版',
    amountYuan: '39.90',
    credits: 5500,
    imageUrl: 'https://cdn.example.com/spring-v2.webp',
    badgeText: '推荐',
    adTitle: '春日积分升级',
    adSubtitle: '更多积分限时加赠',
    buttonText: '立即升级',
    accentColor: '#A1B2C3',
    sortOrder: 18,
    isFeatured: true,
    status: 'active',
  });

  assert.equal(updated.badge_text, '推荐');
  assert.equal(updated.ad_title, '春日积分升级');
  assert.equal(updated.ad_subtitle, '更多积分限时加赠');
  assert.equal(updated.button_text, '立即升级');
  assert.equal(updated.accent_color, '#a1b2c3');
  assert.equal(updated.sort_order, 18);
  assert.equal(updated.is_featured, 1);
});

test('套餐展示字段和广告图拒绝非法值且有效 HTTPS 仍可使用', () => {
  const { db } = setup();
  const valid = {
    name: '标准套餐',
    adTitle: '标准积分套餐',
    amountYuan: '10',
    credits: 1000,
    imageUrl: 'https://cdn.example.com/banner.webp',
    status: 'active',
  };
  const invalidInputs = [
    { badgeText: '徽'.repeat(21) },
    { adTitle: ' ' },
    { adTitle: '标题'.repeat(25) },
    { adSubtitle: '副'.repeat(81) },
    { buttonText: '购'.repeat(21) },
    { accentColor: 'linear-gradient(red, blue)' },
    { sortOrder: -1 },
    { sortOrder: true },
    { isFeatured: 'true' },
  ];
  const invalidImages = [
    '/static/other/banner.webp',
    '/static/uploads/recharge-packages/../outside.webp',
    '/static/uploads/recharge-packages/./a.webp',
    '/static/uploads/recharge-packages//a.webp',
    String.raw`/static/uploads/recharge-packages/nested\a.webp`,
    'http://cdn.example.com/banner.webp',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    'https://',
  ];

  for (const invalid of invalidInputs) {
    assert.throws(
      () => recharge.createPackage(db, { ...valid, ...invalid }),
      (error) => error.code === 'INVALID_RECHARGE_PACKAGE',
    );
  }
  for (const imageUrl of invalidImages) {
    assert.throws(
      () => recharge.createPackage(db, { ...valid, imageUrl }),
      (error) => error.code === 'INVALID_RECHARGE_PACKAGE',
    );
  }

  const saved = recharge.createPackage(db, valid);
  assert.equal(saved.image_url, valid.imageUrl);
  assert.equal(saved.button_text, '立即购买');
  assert.equal(saved.accent_color, '#ff7139');
  assert.equal(saved.sort_order, 0);
  assert.equal(saved.is_featured, 0);

  const nested = recharge.createPackage(db, {
    ...valid,
    name: '嵌套目录套餐',
    imageUrl: '/static/uploads/recharge-packages/campaigns/2026/spring.webp',
  });
  assert.equal(
    nested.image_url,
    '/static/uploads/recharge-packages/campaigns/2026/spring.webp',
  );
});

test('重复设置推荐套餐时返回业务错误而非 SQLite 唯一约束', () => {
  const { db } = setup();
  const packageInput = {
    name: '推荐套餐',
    adTitle: '推荐套餐广告',
    amountYuan: '10',
    credits: 1000,
    imageUrl: 'https://cdn.example.com/featured.webp',
    isFeatured: true,
    status: 'active',
  };
  recharge.createPackage(db, packageInput);

  assert.throws(
    () => recharge.createPackage(db, { ...packageInput, name: '第二个推荐套餐' }),
    (error) => error.code === 'INVALID_RECHARGE_PACKAGE'
      && error.message === '推荐套餐只能设置一个',
  );

  const regular = recharge.createPackage(db, {
    ...packageInput,
    name: '普通套餐',
    isFeatured: false,
  });
  assert.throws(
    () => recharge.updatePackage(db, regular.id, packageInput),
    (error) => error.code === 'INVALID_RECHARGE_PACKAGE'
      && error.message === '推荐套餐只能设置一个',
  );
});

test('ensureSchema 为旧套餐表补齐展示列和推荐套餐唯一索引', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE recharge_packages (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    credits INTEGER NOT NULL CHECK (credits > 0),
    starts_at TEXT,
    ends_at TEXT,
    image_url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  recharge.ensureSchema(db);

  const columns = db.prepare('PRAGMA table_info(recharge_packages)').all();
  for (const name of [
    'badge_text', 'ad_title', 'ad_subtitle', 'button_text',
    'accent_color', 'sort_order', 'is_featured',
  ]) {
    assert.ok(columns.some((column) => column.name === name), `缺少展示列 ${name}`);
  }
  const featuredIndex = db.prepare('PRAGMA index_list(recharge_packages)').all()
    .find((index) => index.name === 'uq_recharge_packages_featured');
  assert.equal(featuredIndex?.unique, 1);
  const indexSql = db.prepare(`SELECT sql FROM sqlite_master
    WHERE type = 'index' AND name = 'uq_recharge_packages_featured'`).get().sql;
  assert.match(indexSql, /WHERE\s+is_featured\s*=\s*1/i);
});

function fakeGateway() {
  return {
    configured: true,
    appId: 'app-123',
    sellerId: '2088000000000000',
    verifyNotification(payload) {
      return payload.sign === 'valid-signature';
    },
  };
}

test('合法支付宝成功通知原子入账且重复通知不重复增加积分', () => {
  const { db, tenant } = setup();
  const order = recharge.createOrder(db, {
    tenantId: tenant.id,
    userId: 'user-1',
    amountYuan: '12.34',
    clientOrderKey: 'notify-order-001',
  });
  const payload = {
    sign: 'valid-signature',
    app_id: 'app-123',
    seller_id: '2088000000000000',
    trade_status: 'TRADE_SUCCESS',
    out_trade_no: order.out_trade_no,
    trade_no: '2026080322000000000001',
    total_amount: '12.34',
  };

  const first = recharge.processNotification(db, payload, fakeGateway());
  const repeated = recharge.processNotification(db, payload, fakeGateway());

  assert.equal(first.credited, true);
  assert.equal(repeated.credited, false);
  assert.equal(repeated.order.status, 'paid');
  assert.equal(repeated.order.alipay_trade_no, payload.trade_no);
  assert.equal(creditLedger.getTenantAccount(db, tenant.id).available, 1234);
  const adjustments = creditLedger.listTenantAdjustments(db, tenant.id);
  assert.equal(adjustments.length, 1);
  assert.equal(adjustments[0].event_type, 'recharge');
  assert.equal(adjustments[0].amount, 1234);
  assert.equal(adjustments[0].reference_type, 'alipay_recharge_order');
  assert.equal(adjustments[0].reference_id, order.id);
});

test('低于一元的套餐订单仍能按支付宝通知金额正确入账', () => {
  const { db, tenant } = setup();
  const rechargePackage = recharge.createPackage(db, {
    name: '一分钱体验包',
    adTitle: '新人一分体验',
    amountYuan: '0.01',
    credits: 10,
    imageUrl: 'https://cdn.example.com/trial.jpg',
    status: 'active',
  });
  const order = recharge.createOrder(db, {
    tenantId: tenant.id,
    userId: 'user-1',
    packageId: rechargePackage.id,
    clientOrderKey: 'small-package-notify',
  });

  recharge.processNotification(db, {
    sign: 'valid-signature',
    app_id: 'app-123',
    seller_id: '2088000000000000',
    trade_status: 'TRADE_SUCCESS',
    out_trade_no: order.out_trade_no,
    trade_no: '2026080322000000000004',
    total_amount: '0.01',
  }, fakeGateway());

  assert.equal(creditLedger.getTenantAccount(db, tenant.id).available, 10);
});

test('伪造签名、身份或金额不匹配的通知不会入账', () => {
  const { db, tenant } = setup();
  const order = recharge.createOrder(db, {
    tenantId: tenant.id,
    userId: 'user-1',
    amountYuan: '10',
    clientOrderKey: 'notify-order-invalid',
  });
  const valid = {
    sign: 'valid-signature',
    app_id: 'app-123',
    seller_id: '2088000000000000',
    trade_status: 'TRADE_SUCCESS',
    out_trade_no: order.out_trade_no,
    trade_no: '2026080322000000000002',
    total_amount: '10.00',
  };
  const invalidPayloads = [
    { ...valid, sign: 'forged' },
    { ...valid, app_id: 'wrong-app' },
    { ...valid, seller_id: '2088999999999999' },
    { ...valid, trade_status: 'WAIT_BUYER_PAY' },
    { ...valid, total_amount: '9.99' },
    { ...valid, out_trade_no: 'MOLIUNKNOWNORDER' },
  ];

  for (const payload of invalidPayloads) {
    assert.throws(
      () => recharge.processNotification(db, payload, fakeGateway()),
      (error) => error.code?.startsWith('ALIPAY_') || error.code === 'RECHARGE_ORDER_NOT_FOUND',
    );
  }
  assert.equal(db.prepare('SELECT status FROM tenant_recharge_orders WHERE id = ?').get(order.id).status, 'pending');
  assert.equal(creditLedger.getTenantAccount(db, tenant.id).available, 0);
});

test('同一支付宝交易号不能为两个订单重复入账', () => {
  const { db, tenant } = setup();
  const first = recharge.createOrder(db, {
    tenantId: tenant.id,
    userId: 'user-1',
    amountYuan: '10',
    clientOrderKey: 'trade-number-first',
  });
  const second = recharge.createOrder(db, {
    tenantId: tenant.id,
    userId: 'user-1',
    amountYuan: '10',
    clientOrderKey: 'trade-number-second',
  });
  const payload = {
    sign: 'valid-signature',
    app_id: 'app-123',
    seller_id: '2088000000000000',
    trade_status: 'TRADE_SUCCESS',
    trade_no: '2026080322000000000099',
    total_amount: '10.00',
  };

  recharge.processNotification(db, { ...payload, out_trade_no: first.out_trade_no }, fakeGateway());
  assert.throws(
    () => recharge.processNotification(db, { ...payload, out_trade_no: second.out_trade_no }, fakeGateway()),
    (error) => error.code === 'ALIPAY_ORDER_CONFLICT',
  );
  assert.equal(db.prepare('SELECT status FROM tenant_recharge_orders WHERE id = ?').get(second.id).status, 'pending');
  assert.equal(creditLedger.getTenantAccount(db, tenant.id).available, 1000);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM tenant_credit_adjustments
    WHERE event_type = 'recharge'`).get().count, 1);
});
