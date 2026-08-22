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

test('DJPSD 开放 API 连接测试查询不存在任务验证密钥且不创建付费视频', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ detail: '任务不存在' }),
    };
  };
  try {
    await testConnection({
      service_type: 'video',
      provider: 'djpsd_openapi',
      api_protocol: 'djpsd_openapi',
      base_url: 'https://shiping.djpsd.com/v1',
      api_key: 'secret',
      model: ['video-v1'],
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(request.url, 'https://shiping.djpsd.com/v1/media/status?task_id=0');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.headers.Authorization, 'Bearer secret');
});

test('DJPSD 旧图片协议标识也使用只读开放 API 验证', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ detail: '任务不存在' }),
    };
  };
  try {
    await testConnection({
      service_type: 'image',
      provider: 'djpsd',
      api_protocol: 'djpsd_media',
      base_url: 'https://shiping.djpsd.com',
      api_key: 'secret',
      model: ['image-v1-4k'],
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(request.url, 'https://shiping.djpsd.com/v1/media/status?task_id=0');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.headers.Authorization, 'Bearer secret');
});
