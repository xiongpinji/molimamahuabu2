const test = require('node:test');
const assert = require('node:assert/strict');

const { testConnection } = require('../src/services/aiConfigService');

test('DJPSD 连接测试使用只读任务列表而不创建付费视频', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { items: [] } }) };
  };
  try {
    await testConnection({
      service_type: 'video',
      provider: 'djpsd',
      base_url: 'https://shiping.djpsd.com/v1',
      api_key: 'secret',
      model: ['seedance 2.0'],
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(request.url, 'https://shiping.djpsd.com/api/v1/video-jobs?page=1&page_size=1');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.headers['api-key'], 'secret');
});
