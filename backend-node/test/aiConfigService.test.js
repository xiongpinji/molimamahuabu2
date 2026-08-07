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

  assert.equal(config.verification_status, 'pending');
  assert.deepEqual(config.verified_capabilities, {});
  const safe = aiConfig.toPublicConfig(config);
  assert.equal(safe.api_key, undefined);
  assert.equal(safe.has_api_key, true);
  assert.equal(safe.verification_status, 'pending');
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
  assert.equal(aiConfig.getConfig(db, config.id).verification_status, 'pending');
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
  assert.equal(manual.verification_status, 'pending');
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
