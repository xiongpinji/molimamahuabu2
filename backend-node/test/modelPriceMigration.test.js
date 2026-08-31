const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');

test('图片分辨率迁移幂等且不改动既有视频价格', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  db.prepare(`INSERT INTO model_resolution_prices
    (model, resolution, credits, cost_micros_per_second, updated_at)
    VALUES (?, ?, ?, ?, ?)`).run('legacy-video', '720p', 9, 140000, '2026-08-07T00:00:00.000Z');

  runMigrationsAndEnsure(db);

  assert.deepEqual(
    db.prepare(`SELECT model, resolution, credits, cost_micros_per_second
      FROM model_resolution_prices WHERE model = ?`).get('legacy-video'),
    { model: 'legacy-video', resolution: '720p', credits: 9, cost_micros_per_second: 140000 },
  );
  db.prepare(`INSERT INTO model_resolution_prices
    (model, resolution, credits, cost_micros_per_second, updated_at)
    VALUES (?, ?, ?, ?, ?)`).run('wan3.0-video', '1080p', 134, 350000, '2026-08-31T00:00:00.000Z');
  assert.equal(
    db.prepare('SELECT credits FROM model_resolution_prices WHERE model = ? AND resolution = ?')
      .get('wan3.0-video', '1080p').credits,
    134,
  );
  db.prepare(`INSERT INTO model_image_resolution_prices
    (model, resolution, credits, cost_micros_per_unit, updated_at)
    VALUES (?, ?, ?, ?, ?)`).run('nano-banana-2', '4k', 105, 120000, '2026-08-07T00:00:00.000Z');
  assert.equal(
    db.prepare('SELECT cost_micros_per_unit FROM model_image_resolution_prices WHERE model = ? AND resolution = ?')
      .get('nano-banana-2', '4k').cost_micros_per_unit,
    120000,
  );
  assert.throws(() => db.prepare(`INSERT INTO model_image_resolution_prices
    (model, resolution, credits, cost_micros_per_unit, updated_at)
    VALUES ('bad-image', '1080p', 1, 1, 'now')`).run(), /CHECK constraint/);
  db.close();
});
