'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiConfig = require('../src/services/aiConfigService');

const log = { info() {}, warn() {}, error() {} };

test('Wan 3.0 管理配置接受 2 秒并保持独立协议且不公开 Key', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  try {
    const config = aiConfig.createConfig(db, log, {
      service_type: 'video',
      provider: 'toapis',
      api_protocol: 'toapis_wan3_video',
      name: 'ToAPIs Wan 3.0',
      base_url: 'https://toapis.xyz',
      api_key: 'wan3-secret',
      model: ['wan3.0-video'],
      default_model: 'wan3.0-video',
      settings: { video_duration: 2 },
    });

    assert.equal(config.api_protocol, 'toapis_wan3_video');
    assert.equal(config.endpoint, '/v1/videos/generations');
    assert.equal(config.query_endpoint, '/v1/videos/generations/{taskId}');
    assert.equal(JSON.parse(config.settings).video_duration, 2);
    assert.equal(config.verification_status, 'unverified');
    assert.equal(aiConfig.toPublicConfig(config).api_key, undefined);
    assert.equal(aiConfig.toPublicConfig(config).has_api_key, true);

    assert.throws(() => aiConfig.updateConfig(db, log, config.id, {
      settings: { video_duration: 31 },
    }), (error) => error.code === 'INVALID_VIDEO_DURATION');
  } finally {
    db.close();
  }
});

test('Wan 3.0 连接测试只读模型目录且优先使用独立配置 Key', async (t) => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const config = aiConfig.createConfig(db, log, {
    service_type: 'video',
    provider: 'toapis',
    api_protocol: 'toapis_wan3_video',
    name: 'ToAPIs Wan 3.0',
    base_url: 'https://toapis.xyz',
    api_key: 'wan3-secret',
    model: ['wan3.0-video'],
    default_model: 'wan3.0-video',
    settings: { video_duration: 2 },
  });
  const originalFetch = global.fetch;
  const originalLegacyKey = process.env.TOAPIS_API_KEY;
  const originalWanKey = process.env.TOAPIS_WAN3_API_KEY;
  process.env.TOAPIS_API_KEY = 'legacy-global-key-must-not-be-used';
  process.env.TOAPIS_WAN3_API_KEY = 'wan-env-key-must-not-override-config';
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({ data: [{ id: 'wan3.0-video' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => {
    global.fetch = originalFetch;
    if (originalLegacyKey == null) delete process.env.TOAPIS_API_KEY;
    else process.env.TOAPIS_API_KEY = originalLegacyKey;
    if (originalWanKey == null) delete process.env.TOAPIS_WAN3_API_KEY;
    else process.env.TOAPIS_WAN3_API_KEY = originalWanKey;
    db.close();
  });
  await aiConfig.testConnection(config);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://toapis.xyz/v1/models?type=video');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer wan3-secret');
  assert.equal(requests[0].options.body, undefined);
  assert.equal(aiConfig.getConfig(db, config.id).verification_status, 'unverified');
});

test('旧 ToAPIs FAST/MINI 连接测试继续使用 legacy Key 解析', async (t) => {
  const originalFetch = global.fetch;
  const originalLegacyKey = process.env.TOAPIS_API_KEY;
  process.env.TOAPIS_API_KEY = 'legacy-global-fast-key';
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({ data: [{ id: 'seedance-2-fast' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => {
    global.fetch = originalFetch;
    if (originalLegacyKey == null) delete process.env.TOAPIS_API_KEY;
    else process.env.TOAPIS_API_KEY = originalLegacyKey;
  });

  await aiConfig.testConnection({
    service_type: 'video',
    provider: 'toapis',
    api_protocol: 'toapis_video',
    base_url: 'https://toapis.xyz',
    api_key: 'config-fast-key-must-not-override-legacy-env',
    model: ['seedance-2-fast'],
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer legacy-global-fast-key');
});
