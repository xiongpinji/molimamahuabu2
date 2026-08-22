const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const billingRoutes = require('../src/routes/billing');
const modelPrice = require('../src/services/modelPriceService');
const { evidenceRoots, withExternalModelEvidence } = require('./helpers/externalModelEvidenceFixture');

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

test('用户模型目录只返回管理员启用、已验证且已计费的模型', () => {
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
    (service_type, model, default_model, is_active, verification_status)
    VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`).run(
    'image', 'gpt-image-2', '', 1, 'verified',
    'video', 'seedance 2.0', '', 0, 'verified',
  );
  modelPrice.set(db, 'gpt-image-2', 12, { category: 'image', display_name: '图片模型' });
  modelPrice.set(db, 'seedance 2.0', 35, { category: 'video' });
  const handlers = billingRoutes(db, log, { evidenceRoots });
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

test('公共计费目录对 USMercari 图片复用真实验证和完整档位价格门禁', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE ai_service_configs (
    id INTEGER PRIMARY KEY,
    service_type TEXT,
    provider TEXT,
    api_protocol TEXT,
    api_key TEXT,
    model TEXT,
    default_model TEXT,
    is_active INTEGER DEFAULT 1,
    verification_status TEXT DEFAULT 'pending',
    verified_capabilities TEXT DEFAULT '{}',
    deleted_at TEXT
  )`);
  const capabilities = {
    'gpt-image-2-2-4k': withExternalModelEvidence('gpt-image-2-2-4k', {
      supportsTextToImage: true,
      supportsImageReference: true,
      maxReferences: 6,
      resolutions: ['1k', '2k'],
    }),
  };
  db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, api_protocol, api_key, model, is_active, verification_status, verified_capabilities)
    VALUES ('image', 'usmercari_image', 'usmercari_image', 'secret', ?, 1, 'verified', ?)`)
    .run(JSON.stringify(['gpt-image-2-2-4k']), JSON.stringify(capabilities));
  modelPrice.set(db, 'gpt-image-2-2-4k', 70, {
    category: 'image', display_name: 'GPT Image 2', public_note: '仅开放已验证档位',
    resolution_prices: { '1k': { credits: 70, cost_micros_per_unit: 80000 } },
  });
  const handlers = billingRoutes(db, log, { evidenceRoots });
  let captured = capture();
  handlers.listPublicCatalog({}, captured.res);
  assert.deepEqual(captured.result.body.data, []);

  modelPrice.set(db, 'gpt-image-2-2-4k', 70, {
    category: 'image', display_name: 'GPT Image 2', public_note: '仅开放已验证档位',
    resolution_prices: {
      '1k': { credits: 70, cost_micros_per_unit: 80000 },
      '2k': { credits: 87, cost_micros_per_unit: 100000 },
      '4k': { credits: 105, cost_micros_per_unit: 120000 },
    },
  });
  captured = capture();
  handlers.listPublicCatalog({}, captured.res);
  assert.equal(captured.result.body.data.length, 1);
  assert.equal(captured.result.body.data[0].public_note, '仅开放已验证档位');
  assert.deepEqual(Object.keys(captured.result.body.data[0].resolution_prices), ['1k', '2k']);
  db.close();
});

test('公共计费目录识别 USMercari 图片专用环境 Key', () => {
  const db = new Database(':memory:');
  const previousImageKey = process.env.USMERCARI_IMAGE_API_KEY;
  const previousGenericKey = process.env.USMERCARI_API_KEY;
  delete process.env.USMERCARI_API_KEY;
  process.env.USMERCARI_IMAGE_API_KEY = 'env-image-key';
  try {
    db.exec(`CREATE TABLE ai_service_configs (
      id INTEGER PRIMARY KEY,
      service_type TEXT,
      provider TEXT,
      api_protocol TEXT,
      api_key TEXT,
      model TEXT,
      default_model TEXT,
      is_active INTEGER DEFAULT 1,
      verification_status TEXT DEFAULT 'pending',
      verified_capabilities TEXT DEFAULT '{}',
      deleted_at TEXT
    )`);
    db.prepare(`INSERT INTO ai_service_configs
      (service_type, provider, api_protocol, api_key, model, is_active, verification_status, verified_capabilities)
      VALUES ('image', 'usmercari_image', 'usmercari_image', '', ?, 1, 'verified', ?)`)
      .run(JSON.stringify(['gpt-image-2-2-4k']), JSON.stringify({
        'gpt-image-2-2-4k': withExternalModelEvidence('gpt-image-2-2-4k', {
          supportsTextToImage: true,
          supportsImageReference: true,
          maxReferences: 1,
          resolutions: ['1k', '2k'],
        }),
      }));
    modelPrice.set(db, 'gpt-image-2-2-4k', 70, {
      category: 'image',
      resolution_prices: {
        '1k': { credits: 70, cost_micros_per_unit: 80000 },
        '2k': { credits: 87, cost_micros_per_unit: 100000 },
      },
    });
    const handlers = billingRoutes(db, log, { evidenceRoots });
    const captured = capture();
    handlers.listPublicCatalog({}, captured.res);
    assert.equal(captured.result.body.data.length, 1);
  } finally {
    if (previousImageKey === undefined) delete process.env.USMERCARI_IMAGE_API_KEY;
    else process.env.USMERCARI_IMAGE_API_KEY = previousImageKey;
    if (previousGenericKey === undefined) delete process.env.USMERCARI_API_KEY;
    else process.env.USMERCARI_API_KEY = previousGenericKey;
    db.close();
  }
});

test('公共计费目录对 ToAPIs 视频复用真实验证、凭据和完整档位价格门禁', () => {
  const db = new Database(':memory:');
  const previousKey = process.env.TOAPIS_API_KEY;
  delete process.env.TOAPIS_API_KEY;
  try {
    db.exec(`CREATE TABLE ai_service_configs (
      id INTEGER PRIMARY KEY,
      service_type TEXT,
      provider TEXT,
      api_protocol TEXT,
      api_key TEXT,
      model TEXT,
      default_model TEXT,
      is_active INTEGER DEFAULT 1,
      verification_status TEXT DEFAULT 'pending',
      verified_capabilities TEXT DEFAULT '{}',
      deleted_at TEXT
    )`);
    db.prepare(`INSERT INTO ai_service_configs
      (service_type, provider, api_protocol, api_key, model, is_active, verification_status, verified_capabilities)
      VALUES ('video', 'toapis', 'toapis_video', 'stored-key', ?, 1, 'verified', ?)`)
      .run(JSON.stringify(['seedance-2-fast']), JSON.stringify({
        'seedance-2-fast': withExternalModelEvidence('seedance-2-fast', {
          durations: [4, 5], resolutions: ['480p', '720p'],
        }),
      }));
    modelPrice.set(db, 'seedance-2-fast', 511, {
      category: 'video',
      resolution_prices: {
        '480p': { credits: 511, cost_micros_per_second: 584000 },
      },
    });
    const handlers = billingRoutes(db, log, { evidenceRoots });
    let captured = capture();
    handlers.listPublicCatalog({}, captured.res);
    assert.deepEqual(captured.result.body.data, []);

    modelPrice.set(db, 'seedance-2-fast', 511, {
      category: 'video',
      resolution_prices: {
        '480p': { credits: 511, cost_micros_per_second: 584000 },
        '720p': { credits: 511, cost_micros_per_second: 584000 },
      },
    });
    captured = capture();
    handlers.listPublicCatalog({}, captured.res);
    assert.equal(captured.result.body.data.length, 1);
    assert.deepEqual(Object.keys(captured.result.body.data[0].resolution_prices), ['480p', '720p']);

    db.prepare("UPDATE ai_service_configs SET verification_status = 'pending'").run();
    captured = capture();
    handlers.listPublicCatalog({}, captured.res);
    assert.deepEqual(captured.result.body.data, []);

    db.prepare("UPDATE ai_service_configs SET verification_status = 'verified', verified_capabilities = ?")
      .run(JSON.stringify({
        'seedance-2-fast': withExternalModelEvidence('seedance-2-fast', {
          durations: [99], resolutions: ['480p', '720p'],
        }),
      }));
    captured = capture();
    handlers.listPublicCatalog({}, captured.res);
    assert.deepEqual(captured.result.body.data, []);
  } finally {
    if (previousKey === undefined) delete process.env.TOAPIS_API_KEY;
    else process.env.TOAPIS_API_KEY = previousKey;
    db.close();
  }
});
