const test = require('node:test');
const assert = require('node:assert/strict');

const aiConfigService = require('../src/services/aiConfigService');

test('可灵官方 AK/SK 满足连接测试凭据校验', () => {
  assert.equal(typeof aiConfigService.hasConnectionCredential, 'function');
  assert.equal(aiConfigService.hasConnectionCredential({
    provider: 'kling',
    settings: JSON.stringify({ kling_access_key: 'ak', kling_secret_key: 'sk' }),
  }), true);
});

test('可灵图片连接测试只读查询任务且支持官方 AK/SK', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: false,
      status: 404,
      async json() { return { code: 0 }; },
      async text() { return JSON.stringify({ code: 0 }); },
    };
  };

  try {
    await aiConfigService.testConnection({
      service_type: 'storyboard_image',
      provider: 'kling',
      api_protocol: 'kling',
      base_url: 'https://api.klingai.com',
      endpoint: '/v1/images/generations',
      query_endpoint: '/v1/images/generations/{taskId}',
      model: 'kling-image',
      settings: JSON.stringify({
        kling_access_key: 'test-access-key',
        kling_secret_key: 'test-secret-key',
      }),
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(request.options.method, 'GET');
  assert.equal(request.url, 'https://api.klingai.com/v1/images/generations/codex-connectivity-check');
  assert.match(request.options.headers.Authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
});
