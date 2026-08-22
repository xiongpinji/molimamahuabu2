const test = require('node:test');
const assert = require('node:assert/strict');

const { testConnection } = require('../src/services/aiConfigService');

test('AIHubCC 域名即使沿用 openai 标识也只查询不存在任务验证鉴权', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ detail: 'task not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await testConnection({
      service_type: 'image',
      provider: 'openai',
      base_url: 'https://aihubcc.cc/v1',
      api_key: 'test-key',
      endpoint: '/images/generations',
      query_endpoint: '/images/generations/{taskId}',
      model: ['gpt-image-2-2k'],
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(request.url, 'https://aihubcc.cc/v1/videos/codex-connectivity-check');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.equal(request.options.body, undefined);
});
