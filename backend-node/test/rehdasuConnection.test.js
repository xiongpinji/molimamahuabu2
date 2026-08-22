const test = require('node:test');
const assert = require('node:assert/strict');

const { testConnection } = require('../src/services/aiConfigService');

for (const serviceType of ['text', 'image']) {
  test(`Rehdasu ${serviceType} 连接测试只读模型列表，不触发付费生成`, async () => {
    const originalFetch = global.fetch;
    let request;
    global.fetch = async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [] }),
      };
    };

    try {
      await testConnection({
        service_type: serviceType,
        provider: 'openai',
        base_url: 'https://rehdasu.cn/v1/',
        api_key: 'secret',
        model: [serviceType === 'image' ? 'gpt-image-2' : 'GPT-5.5'],
      });
    } finally {
      global.fetch = originalFetch;
    }

    assert.equal(request.url, 'https://rehdasu.cn/v1/models');
    assert.equal(request.options.method, 'GET');
    assert.equal(request.options.headers.Authorization, 'Bearer secret');
    assert.equal(request.options.body, undefined);
  });
}
