const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

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
    assert.equal(routes.has('GET /voice-catalog'), true);
    assert.equal(routes.has('GET /voice-catalog/:id/preview'), true);
    assert.equal(routes.has('POST /characters/:id/sd2-voice-catalog'), true);
  } finally {
    db.close();
  }
});
