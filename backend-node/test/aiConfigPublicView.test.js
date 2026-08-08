const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { toPublicConfig } = require('../src/services/aiConfigService');
const aiConfigService = require('../src/services/aiConfigService');
const aiConfigRoutes = require('../src/routes/aiConfig');
const modelPriceService = require('../src/services/modelPriceService');
const { evidenceRoots, withExternalModelEvidence } = require('./helpers/externalModelEvidenceFixture');
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

test('普通用户视频模型接口只返回管理员启用且已验证的模型名称', () => {
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
      verification_checked_at TEXT,
      verified_at TEXT,
      verification_error TEXT,
      settings TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
  `);
  db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
       is_default, is_active, verification_status)
    VALUES ('video', 'grok', 'openai', 'Grok 视频', 'https://private.example', 'secret', ?, 'grok-video-3', 1, 1, 'verified')
  `).run(JSON.stringify(['grok-video-3', 'grok-video-3-fast']));
  db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, model, is_active)
    VALUES ('video', 'disabled', '停用模型', ?, 0)
  `).run(JSON.stringify(['disabled-model']));
  modelPriceService.set(db, 'grok-video-3', 60, { category: 'video' });
  modelPriceService.set(db, 'grok-video-3-fast', 60, { category: 'video' });

  let payload;
  const res = {
    status() { return this; },
    json(body) { payload = body; },
  };
  aiConfigRoutes(db, {}, {}, { evidenceRoots }).listPublicVideoModels({ query: {} }, res);

  assert.equal(payload.success, true);
  assert.deepEqual(payload.data, ['grok-video-3', 'grok-video-3-fast']);
  db.close();
});

test('同 upstream 存在 ToAPIs strict 配置时不公开 generic qualified 视频模型', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  const log = { info() {}, warn() {}, error() {} };
  const generic = aiConfigService.createConfig(db, log, {
    service_type: 'video', provider: 'openai', api_protocol: 'openai',
    name: 'Generic Video', base_url: 'https://generic.example', api_key: 'generic-key',
    model: ['seedance-2-fast'], default_model: 'seedance-2-fast', is_active: true,
  });
  aiConfigService.setVerificationResult(db, generic.id, 'verified');
  const strict = aiConfigService.createConfig(db, log, {
    service_type: 'video', provider: 'toapis', api_protocol: 'toapis_video',
    name: 'ToAPIs Video', base_url: 'https://toapis.com', api_key: 'strict-key',
    model: ['seedance-2-fast'], default_model: 'seedance-2-fast', is_active: true,
  });
  db.prepare(`UPDATE ai_service_configs SET verification_status = 'verified', verified_capabilities = ?
    WHERE id = ?`).run(JSON.stringify({
    'seedance-2-fast': withExternalModelEvidence('seedance-2-fast', {
      durations: [4, 5], resolutions: ['480p', '720p'], supportsImageReference: true,
    }),
  }), strict.id);
  const tiers = {
    '480p': { credits: 511, cost_micros_per_second: 584000 },
    '720p': { credits: 877, cost_micros_per_second: 1000000 },
  };
  modelPriceService.set(db, 'seedance-2-fast', 511, { category: 'video', resolution_prices: tiers });
  const genericAlias = `cfg-${generic.id}::seedance-2-fast`;
  modelPriceService.set(db, genericAlias, 511, { category: 'video', resolution_prices: tiers });

  assert.equal(modelPriceService.listPublic(db, { evidenceRoots })
    .some((item) => item.model === genericAlias), false);

  let payload;
  aiConfigRoutes(db, {}, {}, { evidenceRoots }).listPublicVideoModels({ query: {} }, {
    status() { return this; },
    json(body) { payload = body; },
  });
  assert.deepEqual(payload.data, ['seedance-2-fast']);
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
  aiConfigRoutes(db, {}, {}, { evidenceRoots }).listPublicImageModels({ query: {} }, res);

  assert.equal(payload.success, true);
  assert.deepEqual(payload.data, ['lib-image', 'lib-storyboard']);
  db.close();
});

test('普通用户音频模型接口只返回管理员启用的模型名称', () => {
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
      settings TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
  `);
  db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, base_url, api_key, model, default_model, is_default, is_active)
    VALUES ('tts', 'voice', '平台音色', 'https://private.example', 'secret', ?, 'voice-1', 1, 1)
  `).run(JSON.stringify(['voice-1']));

  let payload;
  const res = {
    status() { return this; },
    json(body) { payload = body; },
  };
  aiConfigRoutes(db, {}, {}, { evidenceRoots }).listPublicAudioModels({ query: {} }, res);

  assert.equal(payload.success, true);
  assert.deepEqual(payload.data, ['voice-1']);
  db.close();
});

test('普通图片模型名称接口仅对 USMercari 应用真实验证与完整档位门禁', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const log = { info() {}, warn() {}, error() {} };
  const legacy = aiConfigService.createConfig(db, log, {
    service_type: 'image', provider: 'openai', name: '既有图片', base_url: 'https://legacy.example',
    api_key: 'legacy-secret', model: ['legacy-image'], is_active: true,
  });
  aiConfigService.setVerificationResult(db, legacy.id, 'verified');
  modelPriceService.set(db, 'legacy-image', 12, { category: 'image' });
  const strict = aiConfigService.createConfig(db, log, {
    service_type: 'image', provider: 'usmercari_image', api_protocol: 'usmercari_image',
    name: 'USMercari 图片', base_url: 'https://chat-ai.mercarimx.com', api_key: 'secret',
    model: ['gpt-image-2-2-4k'], is_active: true,
  });
  modelPriceService.set(db, 'gpt-image-2-2-4k', 70, {
    category: 'image', resolution_prices: {
      '1k': { credits: 70, cost_micros_per_unit: 80000 },
      '2k': { credits: 87, cost_micros_per_unit: 100000 },
    },
  });

  const read = () => {
    let payload;
    const res = { status() { return this; }, json(body) { payload = body; } };
    aiConfigRoutes(db, {}, {}, { evidenceRoots }).listPublicImageModels({ query: {} }, res);
    return payload.data;
  };
  assert.deepEqual(read(), ['legacy-image']);

  db.prepare(`UPDATE ai_service_configs SET verification_status = 'verified', verified_capabilities = ?
    WHERE id = ?`).run(JSON.stringify({
    'gpt-image-2-2-4k': withExternalModelEvidence('gpt-image-2-2-4k', {
      supportsTextToImage: true, supportsImageReference: true, maxReferences: 6, resolutions: ['1k', '2k'],
    }),
  }), strict.id);
  assert.deepEqual(read().sort(), ['gpt-image-2-2-4k', 'legacy-image']);
  db.close();
});
