const test = require('node:test');
const assert = require('node:assert/strict');
const providerAssetUrl = require('../src/services/providerAssetUrlService');

const {
  buildToken6688ImageBody,
  callToken6688ImageApi,
  callImageApi,
} = require('../src/services/imageClient');

const log = { info() {}, warn() {}, error() {} };
const originalFetch = global.fetch;
const originalPlatformJwtSecret = process.env.PLATFORM_JWT_SECRET;

test.afterEach(() => {
  global.fetch = originalFetch;
  if (originalPlatformJwtSecret == null) delete process.env.PLATFORM_JWT_SECRET;
  else process.env.PLATFORM_JWT_SECRET = originalPlatformJwtSecret;
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

test('Token6688 图片提交后网络中断返回结构化结果未知元数据', async () => {
  global.fetch = async () => {
    const error = new Error('fetch failed');
    error.code = 'UND_ERR_SOCKET';
    throw error;
  };

  const result = await callToken6688ImageApi({
    base_url: 'https://qd.token6688.com',
    api_key: 'secret',
  }, log, {
    model: 'token6688-gpt-image-2',
    prompt: '测试网络中断',
    size: '1024x1024',
  });

  assert.equal(result.indeterminate, true);
  assert.match(result.error, /结果未知/);
  assert.deepEqual(result.route_meta, {
    phase: 'submit',
    requestBodySent: true,
    transportCode: 'UND_ERR_SOCKET',
  });
});

test('Token6688 图片 200 但未返回图片地址时标记产物不可读且结果未知', async () => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: [{}] }),
  });

  const result = await callToken6688ImageApi({
    base_url: 'https://qd.token6688.com',
    api_key: 'secret',
  }, log, {
    model: 'token6688-gpt-image-2',
    prompt: '测试无结果地址',
    size: '1024x1024',
  });

  assert.equal(result.indeterminate, true);
  assert.match(result.error, /结果未知/);
  assert.deepEqual(result.route_meta, {
    phase: 'result',
    requestBodySent: true,
    httpStatus: 200,
    artifactReadable: false,
  });
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

test('Token6688 图生图把平台静态参考图转换为限时签名直链', async () => {
  process.env.PLATFORM_JWT_SECRET = 'test-provider-asset-secret-at-least-32-characters';
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ url: 'https://cdn.example/result.jpg' }] }),
    };
  };

  await callToken6688ImageApi({
    base_url: 'https://qd.token6688.com',
    api_key: 'secret',
  }, log, {
    model: 'token6688-gpt-image-2',
    prompt: '使用平台内部参考图',
    size: '1024x1024',
    files_base_url: 'https://molimama.vip/static',
    reference_image_urls: ['/static/projects/0011/images/frame.jpg'],
  });

  const body = JSON.parse(request.options.body);
  const signedUrl = new URL(body.images[0]);
  assert.equal(signedUrl.pathname, '/static/projects/0011/images/frame.jpg');
  assert.equal(providerAssetUrl.verifyProviderAssetRequest({
    pathname: signedUrl.pathname,
    expires: signedUrl.searchParams.get(providerAssetUrl.EXPIRES_PARAM),
    signature: signedUrl.searchParams.get(providerAssetUrl.SIGNATURE_PARAM),
    secret: process.env.PLATFORM_JWT_SECRET,
  }), true);
});
