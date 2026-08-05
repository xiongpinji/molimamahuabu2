const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildToken6688ImageBody,
  callToken6688ImageApi,
  callImageApi,
} = require('../src/services/imageClient');

const log = { info() {}, warn() {}, error() {} };
const originalFetch = global.fetch;

test.afterEach(() => {
  global.fetch = originalFetch;
});

test('Token6688 图片请求按模型映射尺寸并保留多图参考', () => {
  const references = Array.from({ length: 9 }, (_, index) => `https://cdn.example/ref-${index + 1}.jpg`);
  assert.deepEqual(buildToken6688ImageBody({
    model: 'token6688-gpt-image-2',
    prompt: '保持九个参考素材的角色、场景和服装特征',
    size: '2048x1152',
    quality: 'high',
    images: references,
  }), {
    model: 'gpt-image-2',
    prompt: '保持九个参考素材的角色、场景和服装特征',
    n: 1,
    response_format: 'url',
    mode: 'multi-reference',
    size: '2048x1152',
    quality: 'high',
    images: references,
  });

  assert.deepEqual(buildToken6688ImageBody({
    model: 'doubao-seedream-5-0',
    prompt: '横屏电影剧照',
    size: '2048x1152',
    images: [],
  }), {
    model: 'doubao-seedream-5-0',
    prompt: '横屏电影剧照',
    n: 1,
    response_format: 'url',
    mode: 'text-to-image',
    size: '16:9',
  });

  assert.deepEqual(buildToken6688ImageBody({
    model: 'gemini-3-pro-image',
    prompt: '竖屏人物海报',
    size: '1152x2048',
    images: [],
  }), {
    model: 'gemini-3-pro-image',
    prompt: '竖屏人物海报',
    n: 1,
    response_format: 'url',
    mode: 'text-to-image',
    size: '2K',
    aspect_ratio: '9:16',
  });

  assert.equal(buildToken6688ImageBody({
    model: 'gpt-image-2',
    prompt: '四比三横图',
    size: '2048x1536',
  }).size, '1280x960');
  assert.equal(buildToken6688ImageBody({
    model: 'gpt-image-2',
    prompt: '三比四竖图',
    size: '1536x2048',
  }).size, '960x1280');
});

test('Token6688 图片适配器调用 /v1/images/generations 并读取同步结果', async () => {
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ url: 'https://cdn.example/result.jpg' }] }),
    };
  };

  const result = await callToken6688ImageApi({
    base_url: 'https://qd.token6688.com',
    api_key: 'secret',
  }, log, {
    model: 'doubao-seedream-5-0',
    prompt: '测试',
    size: '1024x1024',
    reference_image_urls: ['https://cdn.example/ref.jpg'],
  });

  assert.equal(request.url, 'https://qd.token6688.com/v1/images/generations');
  assert.equal(request.options.headers.Authorization, 'Bearer secret');
  assert.equal(JSON.parse(request.options.body).images.length, 1);
  assert.deepEqual(result, { image_url: 'https://cdn.example/result.jpg' });
});

test('生产 callImageApi 路由 Token6688，并按已实测上限允许九张参考图', async () => {
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ url: 'https://cdn.example/result.jpg' }] }),
    };
  };
  const row = {
    id: 8,
    service_type: 'image',
    provider: 'token6688',
    api_protocol: 'token6688',
    name: 'Token6688 图片',
    base_url: 'https://qd.token6688.com',
    api_key: 'secret',
    model: JSON.stringify(['token6688-gpt-image-2']),
    default_model: 'token6688-gpt-image-2',
    endpoint: '/v1/images/generations',
    query_endpoint: '',
    priority: 0,
    is_default: 1,
    is_active: 1,
    settings: null,
  };
  const db = { prepare: () => ({ all: () => [row] }) };
  const references = Array.from({ length: 9 }, (_, index) => `https://cdn.example/ref-${index + 1}.jpg`);

  const result = await callImageApi(db, log, {
    model: 'token6688-gpt-image-2',
    prompt: '九图参考',
    size: '2048x1152',
    reference_image_urls: references,
  });

  assert.equal(request.url, 'https://qd.token6688.com/v1/images/generations');
  assert.equal(JSON.parse(request.options.body).model, 'gpt-image-2');
  assert.equal(JSON.parse(request.options.body).images.length, 9);
  assert.deepEqual(result, { image_url: 'https://cdn.example/result.jpg' });
});
