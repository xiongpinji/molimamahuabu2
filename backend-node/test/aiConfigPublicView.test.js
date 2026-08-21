const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const aiConfigService = require('../src/services/aiConfigService');
const { toPublicConfig } = aiConfigService;
const aiConfigRoutes = require('../src/routes/aiConfig');
const modelPriceService = require('../src/services/modelPriceService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

test('AI 配置公开视图不返回供应商密钥', () => {
  const output = toPublicConfig({
    id: 1,
    api_key: 'supplier-secret',
    settings: JSON.stringify({ kling_access_key: 'ak', kling_secret_key: 'sk', deepseek_thinking: 'enabled' }),
  });
  assert.equal(output.api_key, undefined);
  assert.equal(output.has_api_key, true);
  const settings = JSON.parse(output.settings);
  assert.equal(settings.kling_access_key, undefined);
  assert.equal(settings.kling_secret_key, undefined);
  assert.equal(settings.deepseek_thinking, 'enabled');
});

test('普通用户视频模型接口只返回管理员启用、已验证且已定价的模型名称', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ai_service_configs (
      id INTEGER PRIMARY KEY,
      service_type TEXT NOT NULL,
      provider TEXT,
      api_protocol TEXT,
      name TEXT,
      base_url TEXT,
      api_key TEXT,
      model TEXT,
      default_model TEXT,
      endpoint TEXT,
      query_endpoint TEXT,
      priority INTEGER DEFAULT 0,
      is_default INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      verification_status TEXT NOT NULL DEFAULT 'unverified',
      settings TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
  `);
  db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, api_protocol, name, base_url, api_key, model, default_model, is_default, is_active, verification_status)
    VALUES ('video', 'grok', 'openai', 'Grok 视频', 'https://private.example', 'secret', ?, 'grok-video-3', 1, 1, 'verified')
  `).run(JSON.stringify(['grok-video-3', 'grok-video-3-fast']));
  db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, model, is_active)
    VALUES ('video', 'disabled', '停用模型', ?, 0)
  `).run(JSON.stringify(['disabled-model']));
  modelPriceService.set(db, 'grok-video-3', 20, { category: 'video' });
  modelPriceService.set(db, 'grok-video-3-fast', 25, { category: 'video' });
  modelPriceService.set(db, 'disabled-model', 30, { category: 'video' });

  let payload;
  const res = {
    status() { return this; },
    json(body) { payload = body; },
  };
  aiConfigRoutes(db, {}, {}).listPublicVideoModels({ query: {} }, res);

  assert.equal(payload.success, true);
  assert.deepEqual(payload.data, ['grok-video-3', 'grok-video-3-fast']);
  db.close();
});

test('普通用户图像模型接口只返回管理员启用、已验证且已定价的模型名称', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ai_service_configs (
      id INTEGER PRIMARY KEY,
      service_type TEXT NOT NULL,
      provider TEXT,
      api_protocol TEXT,
      name TEXT,
      base_url TEXT,
      api_key TEXT,
      model TEXT,
      default_model TEXT,
      endpoint TEXT,
      query_endpoint TEXT,
      priority INTEGER DEFAULT 0,
      is_default INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      verification_status TEXT NOT NULL DEFAULT 'unverified',
      settings TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
  `);
  db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, api_protocol, name, base_url, api_key, model, default_model, is_default, is_active, verification_status)
    VALUES ('image', 'lib', 'openai', '通用图片', 'https://private.example', 'secret', ?, 'lib-image', 1, 1, 'verified')
  `).run(JSON.stringify(['lib-image']));
  db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, model, default_model, is_active, verification_status)
    VALUES ('storyboard_image', 'lib', '分镜图片', ?, 'lib-storyboard', 1, 'verified')
  `).run(JSON.stringify(['lib-storyboard']));
  db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, model, is_active)
    VALUES ('image', 'disabled', '停用图片', ?, 0)
  `).run(JSON.stringify(['disabled-image']));
  modelPriceService.set(db, 'lib-image', 12, { category: 'image' });
  modelPriceService.set(db, 'lib-storyboard', 13, { category: 'image' });
  modelPriceService.set(db, 'disabled-image', 14, { category: 'image' });

  let payload;
  const res = {
    status() { return this; },
    json(body) { payload = body; },
  };
  aiConfigRoutes(db, {}, {}).listPublicImageModels({ query: {} }, res);

  assert.equal(payload.success, true);
  assert.deepEqual(payload.data, ['lib-image', 'lib-storyboard']);
  db.close();
});

test('普通用户音频模型接口只返回管理员启用的模型名称', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, base_url, api_key, model, default_model,
       is_default, is_active, verification_status)
    VALUES ('tts', 'voice', '平台音色', 'https://private.example', 'secret', ?,
      'voice-1', 1, 1, 'verified')
  `).run(JSON.stringify(['voice-1']));

  let payload;
  const res = {
    status() { return this; },
    json(body) { payload = body; },
  };
  aiConfigRoutes(db, {}, {}).listPublicAudioModels({ query: {} }, res);

  assert.equal(payload.success, true);
  assert.deepEqual(payload.data, ['voice-1']);
  db.close();
});

test('管理员脱敏视图保留逻辑模型与验证状态', () => {
  const output = toPublicConfig({
    id: 2,
    api_key: 'supplier-secret',
    logical_model_id: 'logical-image',
    failover_enabled: true,
    verification_status: 'verified',
    verified_at: '2026-08-15T00:00:00.000Z',
  });
  assert.equal(output.api_key, undefined);
  assert.equal(output.logical_model_id, 'logical-image');
  assert.equal(output.failover_enabled, true);
  assert.equal(output.verification_status, 'verified');
});

test('管理员可配置逻辑模型和容灾开关但不能直接标记已验证', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const log = { info() {} };
  const created = aiConfigService.createConfig(db, log, {
    service_type: 'image',
    provider: 'relay',
    name: 'Relay',
    base_url: 'https://relay.example/v1',
    api_key: 'secret',
    model: ['upstream-image'],
    default_model: 'upstream-image',
    logical_model_id: 'logical-image',
    failover_enabled: true,
    verification_status: 'verified',
  });
  assert.equal(created.logical_model_id, 'logical-image');
  assert.equal(created.failover_enabled, true);
  assert.equal(created.verification_status, 'unverified');

  const updated = aiConfigService.updateConfig(db, log, created.id, { verification_status: 'verified' });
  assert.equal(updated.verification_status, 'unverified');
  db.close();
});

test('旧生产库默认 pending 时新配置仍从 unverified 开始', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE ai_service_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_type TEXT NOT NULL,
    provider TEXT,
    api_protocol TEXT,
    name TEXT,
    base_url TEXT,
    api_key TEXT,
    model TEXT,
    default_model TEXT,
    endpoint TEXT,
    query_endpoint TEXT,
    priority INTEGER DEFAULT 0,
    is_default INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    settings TEXT,
    logical_model_id TEXT,
    failover_enabled INTEGER NOT NULL DEFAULT 0,
    verification_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT,
    updated_at TEXT,
    deleted_at TEXT
  )`);

  const created = aiConfigService.createConfig(db, { info() {} }, {
    service_type: 'image',
    provider: 'relay',
    name: 'Relay',
    base_url: 'https://relay.example/v1',
    api_key: 'secret',
    model: ['upstream-image'],
    default_model: 'upstream-image',
    logical_model_id: 'logical-image',
    failover_enabled: true,
  });

  assert.equal(created.verification_status, 'unverified');
  db.close();
});

test('普通用户模型目录只返回已验证逻辑模型并合并供应商', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const insert = db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, name, base_url, api_key, model, default_model, is_active, logical_model_id,
     failover_enabled, verification_status, created_at, updated_at)
    VALUES ('image', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`);
  const now = '2026-08-15T00:00:00.000Z';
  insert.run('relay-a', 'A', 'https://private-a.example/v1', 'supplier-secret-a',
    JSON.stringify(['upstream-a']), 'upstream-a',
    'logical-image', 0, 'verified', now, now);
  insert.run('relay-b', 'B', 'https://private-b.example/v1', 'supplier-secret-b',
    JSON.stringify(['upstream-b']), 'upstream-b',
    'logical-image', 1, 'verified', now, now);
  insert.run('relay-c', 'C', 'https://private-c.example/v1', 'supplier-secret-c',
    JSON.stringify(['hidden-upstream']), 'hidden-upstream',
    'hidden-logical', 1, 'unverified', now, now);
  db.prepare(`INSERT INTO model_credit_prices
    (model, credits, display_name, category, status, billing_unit, cost_unit,
     cost_micros_per_unit, input_cost_micros_per_1k, output_cost_micros_per_1k, updated_at)
    VALUES ('logical-image', 40, 'Logical image', 'image', 'enabled', 'request', 'image',
      987654321, 0, 0, ?)`)
    .run(now);

  let payload;
  aiConfigRoutes(db, {}, {}).listPublicImageModels({ query: {} }, {
    status() { return this; },
    json(body) { payload = body; },
  });

  assert.deepEqual(payload.data, ['logical-image']);
  const serialized = JSON.stringify(payload);
  for (const secret of ['relay-', 'upstream-', 'private-', 'supplier-secret', '987654321']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  db.close();
});
