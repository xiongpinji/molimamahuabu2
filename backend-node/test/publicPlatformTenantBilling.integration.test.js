const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');

const { setupRouter } = require('../src/routes');
const userAuth = require('../src/services/userAuthService');

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  return { response, body: await response.json() };
}

test('公开平台租户隔离、兑换码入账和模型独立计费形成真实 HTTP 闭环', async (t) => {
  const previous = {
    PUBLIC_PLATFORM_MODE: process.env.PUBLIC_PLATFORM_MODE,
    PLATFORM_REGISTRATION_ENABLED: process.env.PLATFORM_REGISTRATION_ENABLED,
    PLATFORM_JWT_SECRET: process.env.PLATFORM_JWT_SECRET,
    PLATFORM_ADMIN_TOKEN: process.env.PLATFORM_ADMIN_TOKEN,
  };
  const jwtSecret = 'tenant-billing-jwt-secret-value-123456789';
  const adminToken = 'tenant-billing-admin-token-value-12345678';
  process.env.PUBLIC_PLATFORM_MODE = 'true';
  process.env.PLATFORM_REGISTRATION_ENABLED = 'true';
  process.env.PLATFORM_JWT_SECRET = jwtSecret;
  process.env.PLATFORM_ADMIN_TOKEN = adminToken;

  const db = new Database(':memory:');
  db.exec('CREATE TABLE prompt_overrides (key TEXT PRIMARY KEY, content TEXT, updated_at TEXT)');
  const admin = userAuth.register(db, {
    email: 'admin@example.com',
    password: 'correct horse battery staple',
  });
  const ownerA = userAuth.register(db, {
    email: 'owner-a@example.com',
    password: 'correct horse battery staple',
  });
  const ownerB = userAuth.register(db, {
    email: 'owner-b@example.com',
    password: 'correct horse battery staple',
  });
  const member = userAuth.register(db, {
    email: 'member@example.com',
    password: 'correct horse battery staple',
  });
  const redeemAdmin = userAuth.register(db, {
    email: 'redeem-admin@example.com',
    password: 'correct horse battery staple',
  });
  db.prepare("UPDATE platform_users SET role = 'admin', platform_role = 'admin' WHERE id = ?")
    .run(admin.id);
  db.prepare("UPDATE platform_users SET platform_role = 'redeem_admin' WHERE id = ?")
    .run(redeemAdmin.id);

  const tokens = Object.fromEntries([
    ['admin', admin.id],
    ['ownerA', ownerA.id],
    ['ownerB', ownerB.id],
    ['member', member.id],
    ['redeemAdmin', redeemAdmin.id],
  ].map(([key, userId]) => {
    const user = userAuth.getUserById(db, userId);
    return [key, userAuth.issueToken(user, jwtSecret, userAuth.getTokenVersion(db, userId))];
  }));

  const app = express();
  app.use(express.json());
  app.use('/api/v1', setupRouter({}, db, { error() {}, warn() {}, info() {} }));
  const server = await new Promise((resolve) => {
    const running = app.listen(0, '127.0.0.1', () => resolve(running));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => {
    db.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
  const authHeaders = (token, tenantId) => ({
    Authorization: `Bearer ${token}`,
    ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
  });

  const tenantAResult = await request(baseUrl, '/tenants', {
    method: 'POST',
    headers: authHeaders(tokens.ownerA),
    body: JSON.stringify({ name: '甲工作区', slug: 'tenant-a' }),
  });
  const tenantBResult = await request(baseUrl, '/tenants', {
    method: 'POST',
    headers: authHeaders(tokens.ownerB),
    body: JSON.stringify({ name: '乙工作区', slug: 'tenant-b' }),
  });
  assert.equal(tenantAResult.response.status, 201);
  assert.equal(tenantBResult.response.status, 201);
  const tenantA = tenantAResult.body.data.id;
  const tenantB = tenantBResult.body.data.id;

  const addMember = await request(baseUrl, `/tenants/${tenantA}/members`, {
    method: 'POST',
    headers: authHeaders(tokens.ownerA),
    body: JSON.stringify({ email: 'member@example.com', role: 'member' }),
  });
  assert.equal(addMember.response.status, 201);

  const crossTenant = await request(baseUrl, '/billing/account', {
    headers: authHeaders(tokens.member, tenantB),
  });
  assert.equal(crossTenant.response.status, 404);
  assert.equal(crossTenant.body.error.code, 'NOT_FOUND');

  const deniedAdmin = await request(baseUrl, '/billing/admin/redeem-codes', {
    method: 'POST',
    headers: {
      ...authHeaders(tokens.member),
      'X-Platform-Admin-Token': adminToken,
    },
    body: JSON.stringify({ tenant_id: tenantA, credits: 120 }),
  });
  assert.equal(deniedAdmin.response.status, 403);
  assert.equal(deniedAdmin.body.error.code, 'PLATFORM_PERMISSION_DENIED');

  const codeResult = await request(baseUrl, '/billing/admin/redeem-codes', {
    method: 'POST',
    headers: authHeaders(tokens.redeemAdmin),
    body: JSON.stringify({
      tenant_id: tenantA,
      credits: 120,
      max_redemptions: 1,
      label: '测试入账',
    }),
  });
  assert.equal(codeResult.response.status, 201);

  for (const path of ['/billing/prices', '/billing/admin/ledger/report']) {
    const deniedFinancialData = await request(baseUrl, path, {
      headers: {
        ...authHeaders(tokens.redeemAdmin),
        'X-Platform-Admin-Token': adminToken,
      },
    });
    assert.equal(deniedFinancialData.response.status, 403);
    assert.equal(deniedFinancialData.body.error.code, 'ADMIN_ROLE_REQUIRED');
  }

  const redeemed = await request(baseUrl, '/billing/redeem', {
    method: 'POST',
    headers: authHeaders(tokens.member, tenantA),
    body: JSON.stringify({ code: codeResult.body.data.code }),
  });
  assert.equal(redeemed.response.status, 200);
  assert.equal(redeemed.body.data.account.available, 120);

  const accountA = await request(baseUrl, '/billing/account', {
    headers: authHeaders(tokens.member, tenantA),
  });
  const accountB = await request(baseUrl, '/billing/account', {
    headers: authHeaders(tokens.ownerB, tenantB),
  });
  assert.equal(accountA.body.data.available, 120);
  assert.equal(accountB.body.data.available, 0);

  const priceResult = await request(baseUrl, '/billing/prices/grok-imagine-video', {
    method: 'PUT',
    headers: {
      ...authHeaders(tokens.admin),
      'X-Platform-Admin-Token': adminToken,
    },
    body: JSON.stringify({
      credits: 35,
      display_name: 'Grok Imagine Video',
      category: 'video',
      status: 'enabled',
    }),
  });
  assert.equal(priceResult.response.status, 200);
  assert.equal(priceResult.body.data.credits, 35);

  const prices = await request(baseUrl, '/billing/prices', {
    headers: {
      ...authHeaders(tokens.admin),
      'X-Platform-Admin-Token': adminToken,
    },
  });
  assert.equal(prices.response.status, 200);
  assert.equal(
    prices.body.data.find((item) => item.model === 'grok-imagine-video')?.credits,
    35,
  );
});
