const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { setupRouter } = require('../src/routes');
const { createProviderAssetUrl } = require('../src/services/redrawSourceConditioningService');

function routeSet(router) {
  return new Set(router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods)
      .map((method) => `${method.toUpperCase()} ${layer.route.path}`)));
}

test('keeps primary image and video generation endpoints registered', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE prompt_overrides (key TEXT PRIMARY KEY, content TEXT, updated_at TEXT)');
  try {
    const router = setupRouter({}, db, { error() {}, warn() {}, info() {} });
    const routes = routeSet(router);
    assert.equal(routes.has('POST /images'), true);
    assert.equal(routes.has('POST /videos'), true);
    assert.equal(routes.has('GET /video-models'), true);
    assert.equal(routes.has('GET /image-models'), true);
    assert.equal(routes.has('GET /audio-models'), true);
    assert.equal(routes.has('GET /voice-catalog'), true);
    assert.equal(routes.has('GET /voice-catalog/:id/preview'), true);
    assert.equal(routes.has('POST /dramas/:id/director/reference-analysis'), true);
    assert.equal(routes.has('POST /characters/:id/sd2-voice-catalog'), true);
  } finally {
    db.close();
  }
});

test('keeps voice preview before user auth middleware', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/index.js'), 'utf8');
  const previewIndex = source.indexOf("r.get('/voice-catalog/:id/preview'");
  const authIndex = source.indexOf('r.use(requireUser)');
  assert.notEqual(previewIndex, -1);
  assert.notEqual(authIndex, -1);
  assert.equal(previewIndex < authIndex, true);
});

test('serves a signed redraw provider asset through setupRouter before user auth', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-provider-router-'));
  const conditioningRoot = path.join(storageRoot, 'redraw-conditioning');
  fs.mkdirSync(conditioningRoot, { recursive: true });
  const bytes = Buffer.from('signed-redraw-provider-video-fixture');
  const segmentSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(conditioningRoot, `${segmentSha256}.mp4`), bytes);
  const secret = 'router-provider-asset-secret-'.padEnd(64, 'x');
  const storageBaseUrl = 'https://media.example.test/static';
  const signed = createProviderAssetUrl({
    storageBaseUrl,
    segmentSha256,
    signingSecret: secret,
    ttlSeconds: 300,
  });
  const db = new Database(':memory:');
  db.exec('CREATE TABLE prompt_overrides (key TEXT PRIMARY KEY, content TEXT, updated_at TEXT)');
  const app = express();
  app.use('/api/v1', setupRouter({
    storage: { local_path: storageRoot, base_url: storageBaseUrl },
  }, db, { error() {}, warn() {}, info() {} }, {
    providerAssetSecret: secret,
  }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => db.close());
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));

  const providerUrl = new URL(signed.url);
  const localUrl = `http://127.0.0.1:${server.address().port}${providerUrl.pathname}${providerUrl.search}`;
  const response = await fetch(localUrl, {
    headers: {
      'x-forwarded-host': providerUrl.host,
      'x-forwarded-proto': 'https',
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);

  const directHttpResponse = await fetch(localUrl);
  assert.equal(directHttpResponse.status, 403);
  const wrongHostResponse = await fetch(localUrl, {
    headers: {
      'x-forwarded-host': 'evil.example.test',
      'x-forwarded-proto': 'https',
    },
  });
  assert.equal(wrongHostResponse.status, 403);
  const ambiguousHostResponse = await fetch(localUrl, {
    headers: {
      host: providerUrl.host,
      'x-forwarded-host': `${providerUrl.host}, evil.example.test`,
      'x-forwarded-proto': 'https',
    },
  });
  assert.equal(ambiguousHostResponse.status, 403);

  const source = fs.readFileSync(path.join(__dirname, '../src/routes/index.js'), 'utf8');
  const providerRouteIndex = source.indexOf("r.use('/redraw-provider-assets'");
  const authIndex = source.indexOf('r.use(requireUser)');
  assert.notEqual(providerRouteIndex, -1);
  assert.equal(providerRouteIndex < authIndex, true);
});

test('does not reuse PLATFORM_JWT_SECRET for redraw provider asset signatures', async (t) => {
  const previousJwtSecret = process.env.PLATFORM_JWT_SECRET;
  const previousProviderSecret = process.env.REDRAW_PROVIDER_ASSET_HMAC_SECRET;
  process.env.PLATFORM_JWT_SECRET = 'jwt-secret-must-not-sign-provider-assets'.padEnd(64, 'j');
  delete process.env.REDRAW_PROVIDER_ASSET_HMAC_SECRET;
  t.after(() => {
    if (previousJwtSecret === undefined) delete process.env.PLATFORM_JWT_SECRET;
    else process.env.PLATFORM_JWT_SECRET = previousJwtSecret;
    if (previousProviderSecret === undefined) delete process.env.REDRAW_PROVIDER_ASSET_HMAC_SECRET;
    else process.env.REDRAW_PROVIDER_ASSET_HMAC_SECRET = previousProviderSecret;
  });

  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-provider-key-separation-'));
  const conditioningRoot = path.join(storageRoot, 'redraw-conditioning');
  fs.mkdirSync(conditioningRoot, { recursive: true });
  const bytes = Buffer.from('provider-key-separation-fixture');
  const segmentSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(conditioningRoot, `${segmentSha256}.mp4`), bytes);
  const storageBaseUrl = 'https://media.example.test/static';
  const signedWithJwt = createProviderAssetUrl({
    storageBaseUrl,
    segmentSha256,
    signingSecret: process.env.PLATFORM_JWT_SECRET,
    ttlSeconds: 300,
  });
  const db = new Database(':memory:');
  db.exec('CREATE TABLE prompt_overrides (key TEXT PRIMARY KEY, content TEXT, updated_at TEXT)');
  const app = express();
  app.use('/api/v1', setupRouter({
    storage: { local_path: storageRoot, base_url: storageBaseUrl },
  }, db, { error() {}, warn() {}, info() {} }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => db.close());
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));

  const providerUrl = new URL(signedWithJwt.url);
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}${providerUrl.pathname}${providerUrl.search}`,
    {
      headers: {
        'x-forwarded-host': providerUrl.host,
        'x-forwarded-proto': 'https',
      },
    },
  );
  assert.equal(response.status, 503);
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/index.js'), 'utf8');
  assert.doesNotMatch(
    source,
    /providerAssetSecret[\s\S]{0,240}process\.env\.PLATFORM_JWT_SECRET/,
  );
});

test('keeps tenant recovery routes before tenant context middleware', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/index.js'), 'utf8');
  const listTenantsIndex = source.indexOf("r.get('/tenants'");
  const changeMemberRoleIndex = source.indexOf(
    "r.patch('/tenants/:tenantId/members/:userId/role'",
  );
  const tenantContextIndex = source.indexOf('r.use(createTenantContextMiddleware');
  assert.notEqual(listTenantsIndex, -1);
  assert.notEqual(changeMemberRoleIndex, -1);
  assert.notEqual(tenantContextIndex, -1);
  assert.equal(listTenantsIndex < tenantContextIndex, true);
  assert.equal(changeMemberRoleIndex < tenantContextIndex, true);
});

test('keeps global billing admin routes before tenant context and tenant billing routes after it', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/index.js'), 'utf8');
  const adminUsersIndex = source.indexOf("r.get('/billing/admin/users'");
  const modelPricesIndex = source.indexOf("r.get('/billing/prices'");
  const tenantContextIndex = source.indexOf('r.use(createTenantContextMiddleware');
  const redeemIndex = source.indexOf("r.post('/billing/redeem'");
  assert.notEqual(adminUsersIndex, -1);
  assert.notEqual(modelPricesIndex, -1);
  assert.notEqual(redeemIndex, -1);
  assert.equal(adminUsersIndex < tenantContextIndex, true);
  assert.equal(modelPricesIndex < tenantContextIndex, true);
  assert.equal(redeemIndex > tenantContextIndex, true);
});

test('registers redeem operations routes before tenant context', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/index.js'), 'utf8');
  const batchIndex = source.indexOf("r.post('/billing/admin/redeem-codes/batch'");
  const usagesIndex = source.indexOf("r.get('/billing/admin/redeem-codes/:codeId/usages'");
  const tenantContextIndex = source.indexOf('r.use(createTenantContextMiddleware');
  assert.notEqual(batchIndex, -1);
  assert.notEqual(usagesIndex, -1);
  assert.equal(batchIndex < tenantContextIndex, true);
  assert.equal(usagesIndex < tenantContextIndex, true);
  assert.match(
    source,
    /r\.get\('\/billing\/admin\/redeem-codes\/:codeId\/usages', requireRedeemCodeManager,/,
  );
  assert.doesNotMatch(
    source,
    /r\.get\('\/billing\/admin\/redeem-codes\/:codeId\/usages', requireAdmin,/,
  );
});

test('registers director reference analysis behind tenant ownership and model generation guard', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/index.js'), 'utf8');
  const ownershipIndex = source.indexOf('r.use(createResourceOwnershipMiddleware');
  const guardIndex = source.indexOf('r.use(modelGenerationGuard)');
  const routeIndex = source.indexOf("r.post('/dramas/:id/director/reference-analysis'");
  assert.notEqual(ownershipIndex, -1);
  assert.notEqual(guardIndex, -1);
  assert.notEqual(routeIndex, -1);
  assert.equal(routeIndex > ownershipIndex, true);
  assert.equal(routeIndex > guardIndex, true);
});
