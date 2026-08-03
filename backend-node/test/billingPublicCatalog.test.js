const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const billingRoutes = require('../src/routes/billing');
const modelPrice = require('../src/services/modelPriceService');

const log = { error() {} };

function capture() {
  const result = {};
  return {
    result,
    res: {
      status(code) { result.status = code; return this; },
      json(body) { result.body = body; return this; },
    },
  };
}

test('用户模型目录只返回管理员启用且已计费的模型', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE ai_service_configs (
    id INTEGER PRIMARY KEY,
    service_type TEXT,
    model TEXT,
    default_model TEXT,
    is_active INTEGER DEFAULT 1,
    verification_status TEXT NOT NULL DEFAULT 'unverified',
    deleted_at TEXT
  )`);
  db.prepare(`INSERT INTO ai_service_configs
    (service_type, model, default_model, is_active)
    VALUES (?, ?, ?, ?), (?, ?, ?, ?)`).run(
    'image', 'gpt-image-2', '', 1,
    'video', 'seedance 2.0', '', 0,
  );
  modelPrice.set(db, 'gpt-image-2', 12, { category: 'image', display_name: '图片模型' });
  modelPrice.set(db, 'seedance 2.0', 35, { category: 'video' });
  const handlers = billingRoutes(db, log);
  const { res, result } = capture();

  handlers.listPublicCatalog({}, res);

  assert.deepEqual(
    result.body.data.map(({ model, display_name, category, credits, status }) => ({
      model, display_name, category, credits, status,
    })),
    [{
      model: 'gpt-image-2',
      display_name: '图片模型',
      category: 'image',
      credits: 12,
      status: 'enabled',
    }],
  );
});
