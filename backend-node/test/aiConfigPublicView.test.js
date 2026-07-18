const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { toPublicConfig } = require('../src/services/aiConfigService');
const aiConfigRoutes = require('../src/routes/aiConfig');

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

test('普通用户视频模型接口只返回可选模型字段', () => {
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
      (service_type, provider, api_protocol, name, base_url, api_key, model, default_model, is_default, is_active)
    VALUES ('video', 'grok', 'openai', 'Grok 视频', 'https://private.example', 'secret', ?, 'grok-video-3', 1, 1)
  `).run(JSON.stringify(['grok-video-3', 'grok-video-3-fast']));
  db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, model, is_active)
    VALUES ('video', 'disabled', '停用模型', ?, 0)
  `).run(JSON.stringify(['disabled-model']));

  let payload;
  const res = {
    status() { return this; },
    json(body) { payload = body; },
  };
  aiConfigRoutes(db, {}, {}).listPublicVideoModels({ query: {} }, res);

  assert.equal(payload.success, true);
  assert.equal(payload.data.length, 1);
  assert.deepEqual(payload.data[0].model, ['grok-video-3', 'grok-video-3-fast']);
  assert.equal(payload.data[0].default_model, 'grok-video-3');
  assert.equal(payload.data[0].api_key, undefined);
  assert.equal(payload.data[0].base_url, undefined);
  db.close();
});
