const { randomUUID } = require('crypto');
const creditLedger = require('./creditLedgerService');

const CREDIT_RATIO = 100;
const MIN_AMOUNT_CENTS = 100;
const MAX_AMOUNT_CENTS = 5_000_000;

function rechargeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recharge_packages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      credits INTEGER NOT NULL CHECK (credits > 0),
      starts_at TEXT,
      ends_at TEXT,
      image_url TEXT NOT NULL,
      badge_text TEXT NOT NULL DEFAULT '',
      ad_title TEXT NOT NULL DEFAULT '',
      ad_subtitle TEXT NOT NULL DEFAULT '',
      button_text TEXT NOT NULL DEFAULT '立即购买',
      accent_color TEXT NOT NULL DEFAULT '#ff7139',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_featured INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0, 1)),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tenant_recharge_orders (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      client_order_key TEXT NOT NULL,
      out_trade_no TEXT NOT NULL UNIQUE,
      order_kind TEXT NOT NULL CHECK (order_kind IN ('custom', 'package')),
      package_id TEXT,
      package_name TEXT,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      credits INTEGER NOT NULL CHECK (credits > 0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
      alipay_trade_no TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      paid_at TEXT,
      UNIQUE (tenant_id, created_by, client_order_key)
    );
    CREATE INDEX IF NOT EXISTS idx_recharge_orders_user_created
      ON tenant_recharge_orders(tenant_id, created_by, created_at DESC);
  `);
  const packageColumns = new Set(
    db.prepare('PRAGMA table_info(recharge_packages)').all().map((column) => column.name),
  );
  const presentationColumns = [
    ['badge_text', "TEXT NOT NULL DEFAULT ''"],
    ['ad_title', "TEXT NOT NULL DEFAULT ''"],
    ['ad_subtitle', "TEXT NOT NULL DEFAULT ''"],
    ['button_text', "TEXT NOT NULL DEFAULT '立即购买'"],
    ['accent_color', "TEXT NOT NULL DEFAULT '#ff7139'"],
    ['sort_order', 'INTEGER NOT NULL DEFAULT 0'],
    ['is_featured', 'INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0, 1))'],
  ];
  for (const [name, definition] of presentationColumns) {
    if (!packageColumns.has(name)) {
      db.exec(`ALTER TABLE recharge_packages ADD COLUMN ${name} ${definition}`);
    }
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_recharge_packages_featured
    ON recharge_packages(is_featured) WHERE is_featured = 1`);
}

function parseAmountCents(value, code, message) {
  const normalized = String(value ?? '').trim();
  if (!/^\d{1,5}(?:\.\d{1,2})?$/.test(normalized)) {
    throw rechargeError(code, message);
  }
  const [yuan, fraction = ''] = normalized.split('.');
  const cents = Number(yuan) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > MAX_AMOUNT_CENTS) {
    throw rechargeError(code, message);
  }
  return cents;
}

function parseCustomAmount(value) {
  const cents = parseAmountCents(value, 'INVALID_RECHARGE_AMOUNT', '充值金额格式不正确');
  if (cents < MIN_AMOUNT_CENTS) {
    throw rechargeError('INVALID_RECHARGE_AMOUNT', '充值金额需在 1.00 至 50000.00 元之间');
  }
  return cents;
}

function parsePackageAmount(value) {
  return parseAmountCents(
    value,
    'INVALID_RECHARGE_PACKAGE',
    '套餐售价需在 0.01 至 50000.00 元之间且最多保留两位小数',
  );
}

function normalizeClientOrderKey(value) {
  const key = String(value || '').trim();
  if (key.length < 8 || key.length > 100) {
    throw rechargeError('INVALID_RECHARGE_ORDER', '订单幂等键长度需为 8 到 100 位');
  }
  return key;
}

function requireActiveMembership(db, tenantId, userId) {
  const membership = db.prepare(`SELECT 1 FROM tenant_members
    WHERE tenant_id = ? AND user_id = ? AND status = 'active'`).get(tenantId, userId);
  if (!membership) throw rechargeError('TENANT_NOT_FOUND', '工作区不存在');
}

function normalizeOptionalDate(value) {
  if (value == null || String(value).trim() === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw rechargeError('INVALID_RECHARGE_PACKAGE', '套餐时间格式不正确');
  }
  return parsed.toISOString();
}

function normalizePackage(input) {
  const name = String(input.name || '').trim();
  const amountCents = parsePackageAmount(input.amountYuan ?? input.amount_yuan);
  const credits = Number(input.credits);
  const startsAt = normalizeOptionalDate(input.startsAt ?? input.starts_at);
  const endsAt = normalizeOptionalDate(input.endsAt ?? input.ends_at);
  const imageUrl = String(input.imageUrl ?? input.image_url ?? '').trim();
  const badgeText = String(input.badgeText ?? input.badge_text ?? '').trim();
  const adTitle = String(input.adTitle ?? input.ad_title ?? '').trim();
  const adSubtitle = String(input.adSubtitle ?? input.ad_subtitle ?? '').trim();
  const buttonInput = input.buttonText !== undefined
    ? input.buttonText
    : input.button_text !== undefined ? input.button_text : '立即购买';
  const buttonText = String(buttonInput ?? '').trim();
  const accentInput = input.accentColor !== undefined
    ? input.accentColor
    : input.accent_color !== undefined ? input.accent_color : '#ff7139';
  const accentColor = String(accentInput ?? '').trim().toLowerCase();
  const sortInput = input.sortOrder !== undefined
    ? input.sortOrder
    : input.sort_order !== undefined ? input.sort_order : 0;
  const sortOrder = sortInput;
  const featuredInput = input.isFeatured !== undefined
    ? input.isFeatured
    : input.is_featured !== undefined ? input.is_featured : 0;
  let isFeatured = null;
  if (featuredInput === true || featuredInput === 1 || featuredInput === '1') isFeatured = 1;
  if (featuredInput === false || featuredInput === 0 || featuredInput === '0') isFeatured = 0;
  const status = String(input.status || 'active').trim();
  if (!name || name.length > 60
    || badgeText.length > 20
    || !adTitle || adTitle.length > 48
    || adSubtitle.length > 80
    || !buttonText || buttonText.length > 20
    || !/^#[0-9a-f]{6}$/.test(accentColor)
    || !Number.isSafeInteger(sortOrder) || sortOrder < 0
    || isFeatured == null
    || !Number.isSafeInteger(credits) || credits <= 0 || credits > 100_000_000
    || !['active', 'inactive'].includes(status)
    || (startsAt && endsAt && startsAt >= endsAt)) {
    throw rechargeError('INVALID_RECHARGE_PACKAGE', '套餐名称、售价、积分、时间或状态不合法');
  }
  if (!imageUrl) {
    throw rechargeError('INVALID_RECHARGE_PACKAGE', '请填写套餐广告图片');
  }
  const localUpload = /^\/static\/uploads\/recharge-packages\/[A-Za-z0-9_./-]+$/.test(imageUrl);
  let secureRemote = false;
  try {
    const parsed = new URL(imageUrl);
    secureRemote = parsed.protocol === 'https:' && Boolean(parsed.hostname);
  } catch (_) { // Invalid remote URL; the local path may still be valid.
  }
  if (!localUpload && !secureRemote) {
    throw rechargeError('INVALID_RECHARGE_PACKAGE', '套餐广告图必须使用有效的 HTTPS 地址');
  }
  return {
    name,
    amount_cents: amountCents,
    credits,
    starts_at: startsAt,
    ends_at: endsAt,
    image_url: imageUrl,
    badge_text: badgeText,
    ad_title: adTitle,
    ad_subtitle: adSubtitle,
    button_text: buttonText,
    accent_color: accentColor,
    sort_order: sortOrder,
    is_featured: isFeatured,
    status,
  };
}

function createPackage(db, input) {
  ensureSchema(db);
  const value = normalizePackage(input);
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO recharge_packages
    (id, name, amount_cents, credits, starts_at, ends_at, image_url, badge_text, ad_title,
      ad_subtitle, button_text, accent_color, sort_order, is_featured, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, value.name, value.amount_cents, value.credits, value.starts_at,
      value.ends_at, value.image_url, value.badge_text, value.ad_title, value.ad_subtitle,
      value.button_text, value.accent_color, value.sort_order, value.is_featured,
      value.status, now, now);
  return db.prepare('SELECT * FROM recharge_packages WHERE id = ?').get(id);
}

function updatePackage(db, packageIdValue, input) {
  ensureSchema(db);
  const id = String(packageIdValue || '');
  if (!db.prepare('SELECT 1 FROM recharge_packages WHERE id = ?').get(id)) {
    throw rechargeError('RECHARGE_PACKAGE_NOT_FOUND', '充值套餐不存在');
  }
  const value = normalizePackage(input);
  db.prepare(`UPDATE recharge_packages
    SET name = ?, amount_cents = ?, credits = ?, starts_at = ?, ends_at = ?,
      image_url = ?, badge_text = ?, ad_title = ?, ad_subtitle = ?, button_text = ?,
      accent_color = ?, sort_order = ?, is_featured = ?, status = ?, updated_at = ?
    WHERE id = ?`)
    .run(value.name, value.amount_cents, value.credits, value.starts_at, value.ends_at,
      value.image_url, value.badge_text, value.ad_title, value.ad_subtitle, value.button_text,
      value.accent_color, value.sort_order, value.is_featured, value.status,
      new Date().toISOString(), id);
  return db.prepare('SELECT * FROM recharge_packages WHERE id = ?').get(id);
}

function listPackages(db) {
  ensureSchema(db);
  return db.prepare('SELECT * FROM recharge_packages ORDER BY created_at DESC').all();
}

function listAvailablePackages(db, nowValue = new Date().toISOString()) {
  ensureSchema(db);
  const now = new Date(nowValue).toISOString();
  return db.prepare(`SELECT * FROM recharge_packages
    WHERE status = 'active'
      AND (starts_at IS NULL OR starts_at <= ?)
      AND (ends_at IS NULL OR ends_at > ?)
    ORDER BY amount_cents ASC, created_at ASC`).all(now, now);
}

function createOrder(db, input) {
  ensureSchema(db);
  const tenantId = String(input.tenantId || '');
  const userId = String(input.userId || '');
  requireActiveMembership(db, tenantId, userId);
  const clientOrderKey = normalizeClientOrderKey(input.clientOrderKey);
  const existing = db.prepare(`SELECT * FROM tenant_recharge_orders
    WHERE tenant_id = ? AND created_by = ? AND client_order_key = ?`)
    .get(tenantId, userId, clientOrderKey);
  if (existing) {
    const samePayload = input.packageId
      ? existing.order_kind === 'package' && existing.package_id === String(input.packageId)
      : existing.order_kind === 'custom' && existing.amount_cents === parseCustomAmount(input.amountYuan);
    if (!samePayload) {
      throw rechargeError('RECHARGE_ORDER_IDEMPOTENCY_CONFLICT', '同一充值请求不能修改金额或套餐');
    }
    return existing;
  }

  const now = new Date(input.now || Date.now()).toISOString();
  let orderKind = 'custom';
  let packageId = null;
  let packageName = null;
  let amountCents;
  let credits;
  if (input.packageId) {
    const selected = db.prepare(`SELECT * FROM recharge_packages
      WHERE id = ? AND status = 'active'
        AND (starts_at IS NULL OR starts_at <= ?)
        AND (ends_at IS NULL OR ends_at > ?)`)
      .get(String(input.packageId), now, now);
    if (!selected) {
      throw rechargeError('RECHARGE_PACKAGE_NOT_AVAILABLE', '充值套餐不存在或不在有效期内');
    }
    orderKind = 'package';
    packageId = selected.id;
    packageName = selected.name;
    amountCents = selected.amount_cents;
    credits = selected.credits;
  } else {
    amountCents = parseCustomAmount(input.amountYuan);
    credits = Math.round(amountCents * CREDIT_RATIO / 100);
  }
  const id = randomUUID();
  const outTradeNo = `MOLI${id.replaceAll('-', '').toUpperCase()}`;
  db.prepare(`INSERT INTO tenant_recharge_orders
    (id, tenant_id, created_by, client_order_key, out_trade_no, order_kind,
      package_id, package_name, amount_cents, credits, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
    .run(id, tenantId, userId, clientOrderKey, outTradeNo, orderKind,
      packageId, packageName, amountCents, credits, now, now);
  return db.prepare('SELECT * FROM tenant_recharge_orders WHERE id = ?').get(id);
}

function listOrders(db, tenantIdValue, userIdValue, limitValue = 100) {
  ensureSchema(db);
  const tenantId = String(tenantIdValue || '');
  const userId = String(userIdValue || '');
  requireActiveMembership(db, tenantId, userId);
  const limit = Math.min(Math.max(Number.parseInt(limitValue, 10) || 100, 1), 200);
  return db.prepare(`SELECT * FROM tenant_recharge_orders
    WHERE tenant_id = ? AND created_by = ?
    ORDER BY created_at DESC LIMIT ?`).all(tenantId, userId, limit);
}

function notificationAmountCents(value) {
  try {
    return parsePackageAmount(value);
  } catch (_) {
    throw rechargeError('ALIPAY_AMOUNT_MISMATCH', '支付宝通知金额不合法');
  }
}

function processNotification(db, payload, gateway) {
  ensureSchema(db);
  creditLedger.ensureSchema(db);
  if (!gateway?.configured) {
    throw rechargeError('ALIPAY_NOT_CONFIGURED', '支付宝充值尚未配置');
  }
  if (!gateway.verifyNotification(payload)) {
    throw rechargeError('ALIPAY_INVALID_SIGNATURE', '支付宝通知验签失败');
  }
  if (String(payload.app_id || '') !== gateway.appId
    || String(payload.seller_id || '') !== gateway.sellerId) {
    throw rechargeError('ALIPAY_IDENTITY_MISMATCH', '支付宝通知应用或收款商户不匹配');
  }
  if (!['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(String(payload.trade_status || ''))) {
    throw rechargeError('ALIPAY_TRADE_NOT_SUCCESS', '支付宝交易尚未成功');
  }
  const outTradeNo = String(payload.out_trade_no || '');
  const alipayTradeNo = String(payload.trade_no || '');
  if (!outTradeNo || !alipayTradeNo) {
    throw rechargeError('ALIPAY_NOTIFICATION_INVALID', '支付宝通知缺少订单号');
  }
  const amountCents = notificationAmountCents(payload.total_amount);

  try {
    return db.transaction(() => {
      const order = db.prepare('SELECT * FROM tenant_recharge_orders WHERE out_trade_no = ?')
        .get(outTradeNo);
      if (!order) throw rechargeError('RECHARGE_ORDER_NOT_FOUND', '充值订单不存在');
      if (order.amount_cents !== amountCents) {
        throw rechargeError('ALIPAY_AMOUNT_MISMATCH', '支付宝通知金额与订单不一致');
      }
      if (order.status === 'paid') {
        if (order.alipay_trade_no !== alipayTradeNo) {
          throw rechargeError('ALIPAY_ORDER_CONFLICT', '充值订单已绑定其他支付宝交易');
        }
        return { credited: false, order };
      }

      const now = new Date().toISOString();
      const changed = db.prepare(`UPDATE tenant_recharge_orders
        SET status = 'paid', alipay_trade_no = ?, paid_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'`)
        .run(alipayTradeNo, now, now, order.id);
      if (changed.changes !== 1) {
        throw rechargeError('ALIPAY_ORDER_CONFLICT', '充值订单状态冲突');
      }
      creditLedger.adjustTenantBalance(db, {
        tenantId: order.tenant_id,
        actorUserId: order.created_by,
        eventType: 'recharge',
        amount: order.credits,
        reason: `支付宝充值到账：${order.package_name || '自定义充值'}`,
        referenceType: 'alipay_recharge_order',
        referenceId: order.id,
      });
      return {
        credited: true,
        order: db.prepare('SELECT * FROM tenant_recharge_orders WHERE id = ?').get(order.id),
      };
    })();
  } catch (error) {
    if (String(error.code || '').includes('CONSTRAINT_UNIQUE')) {
      throw rechargeError('ALIPAY_ORDER_CONFLICT', '支付宝交易号已被其他订单使用');
    }
    throw error;
  }
}

module.exports = {
  CREDIT_RATIO,
  MIN_AMOUNT_CENTS,
  MAX_AMOUNT_CENTS,
  ensureSchema,
  createPackage,
  updatePackage,
  listPackages,
  listAvailablePackages,
  createOrder,
  listOrders,
  processNotification,
};
