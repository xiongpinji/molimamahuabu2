const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const catalog = require('../src/services/canvasModelCatalogService');
const prices = require('../src/services/modelPriceService');

const { parseModels, safeCapabilities } = catalog;

test('canvas model catalog parses model lists without exposing config secrets', () => {
  assert.deepEqual(parseModels('["v1","v2"]'), ['v1', 'v2']);
  assert.deepEqual(parseModels('v1,v2'), ['v1', 'v2']);
  assert.deepEqual(safeCapabilities(JSON.stringify({
    api_key: 'secret',
    canvas_capabilities: { durations: [5, 10] },
  })), { durations: [5, 10] });
})

test('canvas model catalog exposes video resolution prices to the node editor', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, name, model, default_model, is_active, settings, created_at, updated_at)
    VALUES ('video', 'test', 'Resolution Video', ?, 'resolution-video', 1, ?, ?, ?)`)
    .run(JSON.stringify(['resolution-video']), JSON.stringify({
      canvas_capabilities: { resolutions: ['480p', '720p'] },
    }), now, now);
  prices.set(db, 'resolution-video', 2, {
    category: 'video',
    resolution_prices: {
      '480p': { credits: 2, cost_micros_per_second: 50000 },
      '720p': { credits: 5, cost_micros_per_second: 120000 },
    },
  });

  const item = catalog.list(db).find((row) => row.model === 'resolution-video');
  assert.deepEqual(item.resolution_prices, {
    '480p': { credits: 2, cost_micros_per_second: 50000 },
    '720p': { credits: 5, cost_micros_per_second: 120000 },
  });
  db.close();
});
