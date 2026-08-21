const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiConfig = require('../src/services/aiConfigService');

const log = { info() {}, warn() {}, error() {} };

test('USMercari 图片配置公开验证元数据但不泄露 Key', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const config = aiConfig.createConfig(db, log, {
    service_type: 'image',
    provider: 'usmercari_image',
    api_protocol: 'usmercari_image',
    name: 'USMercari 图片',
    base_url: 'https://chat-ai.mercarimx.com',
    api_key: 'secret',
    model: ['gpt-image-2-2-4k', 'nano-banana-2'],
    default_model: 'gpt-image-2-2-4k',
  });

  assert.equal(config.verification_status, 'unverified');
  assert.deepEqual(config.verified_capabilities, {});
  const safe = aiConfig.toPublicConfig(config);
  assert.equal(safe.api_key, undefined);
  assert.equal(safe.has_api_key, true);
  assert.equal(safe.verification_status, 'unverified');
  db.close();
});

test('USMercari 图片连接测试只读取模型目录且不会升级真实验证状态', async () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const config = aiConfig.createConfig(db, log, {
    service_type: 'image', provider: 'usmercari_image', api_protocol: 'usmercari_image',
    name: 'USMercari 图片', base_url: 'https://chat-ai.mercarimx.com', api_key: 'secret',
    model: ['gpt-image-2-2-4k', 'nano-banana-2'],
  });
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({
      data: [{ id: 'gpt-image-2-2-4k' }, { id: 'nano-banana-2' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await aiConfig.testConnection(config);
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://chat-ai.mercarimx.com/v1/models');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(aiConfig.getConfig(db, config.id).verification_status, 'unverified');
  db.close();
});

test('USMercari 图片真实验证只能通过受控写回升级状态', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const config = aiConfig.createConfig(db, log, {
    service_type: 'image',
    provider: 'usmercari_image',
    api_protocol: 'usmercari_image',
    name: 'USMercari 图片',
    base_url: 'https://chat-ai.mercarimx.com',
    api_key: 'secret',
    model: ['nano-banana-2'],
    default_model: 'nano-banana-2',
  });

  const manual = aiConfig.updateConfig(db, log, config.id, {
    verification_status: 'verified',
    verified_capabilities: { 'nano-banana-2': { resolutions: ['1k'] } },
  });
  assert.equal(manual.verification_status, 'unverified');
  assert.deepEqual(manual.verified_capabilities, {});

  const verified = aiConfig.recordVerification(db, config.id, {
    status: 'verified',
    verifiedAt: '2026-08-07T00:00:00.000Z',
    capabilities: {
      'nano-banana-2': {
        supportsTextToImage: true,
        supportsImageReference: true,
        maxReferences: 6,
        resolutions: ['1k', '2k', '4k'],
      },
    },
  });
  assert.equal(verified.verification_status, 'verified');
  assert.equal(verified.verified_at, '2026-08-07T00:00:00.000Z');
  assert.deepEqual(verified.verified_capabilities['nano-banana-2'].resolutions, ['1k', '2k', '4k']);
  assert.equal(verified.verification_error, null);

  const failed = aiConfig.recordVerification(db, config.id, {
    status: 'failed',
    error: 'Authorization: Bearer should be redacted from provider failure body',
  });
  assert.equal(failed.verification_status, 'failed');
  assert.match(failed.verification_error, /Authorization: Bearer \[REDACTED\]/);
  db.close();
});

test('recordVerification rejects unknown status and missing config', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  assert.throws(() => aiConfig.recordVerification(db, 999, { status: 'verified' }), /配置不存在/);
  const config = aiConfig.createConfig(db, log, {
    service_type: 'image',
    provider: 'usmercari_image',
    name: 'USMercari 图片',
  });
  assert.throws(() => aiConfig.recordVerification(db, config.id, { status: 'done' }), /验证状态必须/);
  db.close();
});

test('bulkUpdateApiKey invalidates real generation verification and evidence binding', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const config = aiConfig.createConfig(db, log, {
    service_type: 'video',
    provider: 'toapis',
    api_protocol: 'toapis_video',
    name: 'ToAPIs 视频',
    base_url: 'https://toapis.com',
    api_key: 'old-key',
    model: ['seedance-2-fast'],
    default_model: 'seedance-2-fast',
  });

  aiConfig.recordVerification(db, config.id, {
    status: 'verified',
    verifiedAt: '2026-08-07T00:00:00.000Z',
    capabilities: {
      'seedance-2-fast': {
        resolutions: ['480p', '720p'],
        evidence_contract: 'toapis-video-real-verification-v1',
        evidence_sha256: 'a'.repeat(64),
      },
    },
  });
  db.prepare(`UPDATE ai_service_configs
    SET verification_checked_at = ?, verification_error = ?
    WHERE id = ?`).run('2026-08-07T00:01:00.000Z', 'old verification failure detail', config.id);

  assert.equal(aiConfig.bulkUpdateApiKey(db, log, 'new-key'), 1);

  const updated = aiConfig.getConfig(db, config.id);
  assert.equal(updated.api_key, 'new-key');
  assert.equal(updated.verification_status, 'unverified');
  assert.equal(updated.verification_checked_at, null);
  assert.equal(updated.verified_at, null);
  assert.equal(updated.verification_error, null);
  assert.deepEqual(updated.verified_capabilities, {});
  db.close();
});

test('ToAPIs 配置接受模型允许的 4 秒，受保护环境 Key 是有效 credential 且不回传', () => {
  const db = new Database(':memory:');
  const previousKey = process.env.TOAPIS_API_KEY;
  process.env.TOAPIS_API_KEY = 'env-only-key';
  runMigrationsAndEnsure(db);
  try {
    const config = aiConfig.createConfig(db, log, {
      service_type: 'video',
      provider: 'toapis',
      api_protocol: 'toapis_video',
      name: 'ToAPIs 视频',
      base_url: 'https://toapis.com',
      api_key: '',
      model: ['seedance-2-fast'],
      default_model: 'seedance-2-fast',
      settings: { video_duration: 4 },
    });
    assert.equal(config.endpoint, '/v1/videos/generations');
    assert.equal(config.query_endpoint, '/v1/videos/generations/{taskId}');
    assert.equal(JSON.parse(config.settings).video_duration, 4);
    const safe = aiConfig.toPublicConfig(config);
    assert.equal(safe.api_key, undefined);
    assert.equal(safe.has_api_key, true);

    assert.throws(() => aiConfig.createConfig(db, log, {
      service_type: 'video', provider: 'openai', name: '旧视频', base_url: 'https://example.invalid',
      model: ['legacy-video'], settings: { video_duration: 4 },
    }), (error) => error.code === 'INVALID_VIDEO_DURATION');
  } finally {
    if (previousKey === undefined) delete process.env.TOAPIS_API_KEY;
    else process.env.TOAPIS_API_KEY = previousKey;
    db.close();
  }
});

test('ToAPIs 连接测试只 GET 官方模型目录且不会升级真实验证状态', async () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const config = aiConfig.createConfig(db, log, {
    service_type: 'video', provider: 'toapis', api_protocol: 'toapis_video',
    name: 'ToAPIs 视频', base_url: 'https://toapis.com', api_key: 'stored-key',
    model: ['seedance-2-fast', 'seedance-2-mini'], default_model: 'seedance-2-fast',
  });
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({
      data: [{ id: 'seedance-2-fast' }, { id: 'seedance-2-mini' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await aiConfig.testConnection(config);
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://toapis.com/v1/models?type=video');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.body, undefined);
  assert.equal(aiConfig.getConfig(db, config.id).verification_status, 'unverified');
  db.close();
});

test('更新为 ToAPIs Mini 且不传 settings 时仍重校验既有 7 秒默认值', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const config = aiConfig.createConfig(db, log, {
    service_type: 'video', provider: 'openai', api_protocol: 'openai',
    name: 'Legacy Video', base_url: 'https://example.invalid', api_key: 'stored-key',
    model: ['legacy-video'], default_model: 'legacy-video', settings: { video_duration: 7 },
  });

  assert.throws(() => aiConfig.updateConfig(db, log, config.id, {
    provider: 'toapis',
    api_protocol: 'toapis_video',
    model: ['seedance-2-mini'],
    default_model: 'seedance-2-mini',
  }), (error) => error.code === 'INVALID_VIDEO_DURATION');
  const unchanged = aiConfig.getConfig(db, config.id);
  assert.equal(unchanged.provider, 'openai');
  assert.deepEqual(unchanged.model, ['legacy-video']);
  assert.equal(JSON.parse(unchanged.settings).video_duration, 7);
  db.close();
});
