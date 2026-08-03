const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiConfigService = require('../src/services/aiConfigService');
const modelPriceService = require('../src/services/modelPriceService');
const { list, parseModels, safeCapabilities } = require('../src/services/canvasModelCatalogService');

const log = { info() {}, error() {}, errorw() {} };

test('canvas model catalog parses model lists without exposing config secrets', () => {
  assert.deepEqual(parseModels('["v1","v2"]'), ['v1', 'v2']);
  assert.deepEqual(parseModels('v1,v2'), ['v1', 'v2']);
  assert.deepEqual(safeCapabilities(JSON.stringify({
    api_key: 'secret',
    canvas_capabilities: { durations: [5, 10] },
  })), { durations: [5, 10] });
});

test('画布目录自动公开配置内全部已验证且已定价模型并使用管理员前端名称', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const verified = aiConfigService.createConfig(db, log, {
    service_type: 'image',
    provider: 'openai',
    name: '图片供应商',
    base_url: 'https://image.example/v1',
    api_key: 'secret',
    model: ['image-one', 'image-two', 'image-unpriced'],
    default_model: 'image-two',
    is_active: true,
  });
  aiConfigService.setVerificationResult(db, verified.id, 'verified');
  aiConfigService.createConfig(db, log, {
    service_type: 'image',
    provider: 'openai',
    name: '未验证图片供应商',
    base_url: 'https://unverified.example/v1',
    api_key: 'secret',
    model: ['image-unverified'],
    default_model: 'image-unverified',
    is_active: true,
  });
  modelPriceService.set(db, 'image-one', 18, {
    category: 'image',
    displayName: '写实图片 Pro',
  });
  modelPriceService.set(db, 'image-two', 26, {
    category: 'image',
    displayName: '角色一致性 Max',
  });
  modelPriceService.set(db, 'image-unverified', 30, { category: 'image' });

  assert.deepEqual(
    list(db).filter((item) => item.kind === 'image').map((item) => ({
      model: item.model,
      label: item.label,
      credits: item.credits,
    })),
    [
      { model: 'image-two', label: '角色一致性 Max', credits: 26 },
      { model: 'image-one', label: '写实图片 Pro', credits: 18 },
    ],
  );
});
