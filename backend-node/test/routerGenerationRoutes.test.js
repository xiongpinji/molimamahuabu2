const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');

const { setupRouter } = require('../src/routes');

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
    assert.equal(routes.has('GET /voice-catalog'), true);
    assert.equal(routes.has('GET /voice-catalog/:id/preview'), true);
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

test('keeps tenant recovery routes before tenant context middleware', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/index.js'), 'utf8');
  const listTenantsIndex = source.indexOf("r.get('/tenants'");
  const tenantContextIndex = source.indexOf('r.use(createTenantContextMiddleware');
  assert.notEqual(listTenantsIndex, -1);
  assert.notEqual(tenantContextIndex, -1);
  assert.equal(listTenantsIndex < tenantContextIndex, true);
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
    /r\.get\('\/billing\/admin\/redeem-codes\/:codeId\/usages', requireAdmin,/,
  );
});
