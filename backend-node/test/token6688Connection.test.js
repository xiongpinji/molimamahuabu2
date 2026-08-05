const test = require('node:test');
const assert = require('node:assert/strict');

const { testConnection } = require('../src/services/aiConfigService');

const originalFetch = global.fetch;

test.afterEach(() => {
  global.fetch = originalFetch;
});

for (const serviceType of ['image', 'storyboard_image', 'video']) {
  test(`Token6688 ${serviceType} 连接验证只读模型目录且确认目标模型存在`, async () => {
    let request;
    global.fetch = async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: [
            { id: 'doubao-seedream-5-0' },
            { id: 'gpt-image-2' },
            { id: 'gemini-3-pro-image' },
            { id: 'seedance-2-0-special' },
          ],
        }),
      };
    };

    await testConnection({
      service_type: serviceType,
      provider: 'token6688',
      api_protocol: 'token6688',
      base_url: 'https://qd.token6688.com/v1/',
      api_key: 'secret',
      model: serviceType === 'video'
        ? ['seedance-2-0-special-mini-720p', 'seedance-2-0-special-fast-720p', 'seedance-2-0-special-full-720p']
        : ['doubao-seedream-5-0', 'token6688-gpt-image-2', 'gemini-3-pro-image'],
    });

    assert.equal(request.url, 'https://qd.token6688.com/v1/models');
    assert.equal(request.options.method, 'GET');
    assert.equal(request.options.body, undefined);
    assert.equal(request.options.headers.Authorization, 'Bearer secret');
  });
}

test('Token6688 连接验证拒绝目录中不存在的目标模型', async () => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: [{ id: 'gpt-image-2' }] }),
  });
  await assert.rejects(() => testConnection({
    service_type: 'image',
    provider: 'token6688',
    api_protocol: 'token6688',
    base_url: 'https://qd.token6688.com',
    api_key: 'secret',
    model: ['gemini-3-pro-image'],
  }), /未找到已配置模型/);
});
