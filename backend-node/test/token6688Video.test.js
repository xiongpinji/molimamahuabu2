const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const modelPriceService = require('../src/services/modelPriceService');
const providerAssetUrl = require('../src/services/providerAssetUrlService');

const {
  buildToken6688VideoBody,
  callToken6688VideoApi,
  callVideoApi,
  pollVideoTask,
} = require('../src/services/videoClient');

const log = { info() {}, warn() {}, error() {} };
const originalFetch = global.fetch;
const originalPlatformJwtSecret = process.env.PLATFORM_JWT_SECRET;

test.afterEach(() => {
  global.fetch = originalFetch;
  if (originalPlatformJwtSecret == null) delete process.env.PLATFORM_JWT_SECRET;
  else process.env.PLATFORM_JWT_SECRET = originalPlatformJwtSecret;
});

test('Token6688 Seedance 三档按次扣固定积分，不乘 15 秒', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const tiers = [
    ['seedance-2-0-special-mini-720p', 650],
    ['seedance-2-0-special-fast-720p', 960],
    ['seedance-2-0-special-full-720p', 2120],
  ];
  for (const [model, credits] of tiers) {
    const saved = modelPriceService.set(db, model, credits, { category: 'video' });
    assert.equal(saved.billing_unit, 'request');
    assert.equal(modelPriceService.calculateCharge(db, model, { duration: 15 }), credits);
  }
});

test('Token6688 Seedance 三个前端档位映射固定 15 秒 720P 参数', () => {
  const expected = [
    ['seedance-2-0-special-mini-720p', '标准'],
    ['seedance-2-0-special-fast-720p', '快速'],
    ['seedance-2-0-special-full-720p', '高清'],
  ];
  for (const [model, quality] of expected) {
    assert.deepEqual(buildToken6688VideoBody({ model, prompt: '镜头缓慢推进' }), {
      model: 'seedance-2-0-special',
      prompt: '镜头缓慢推进',
      duration: '15',
      aspect_ratio: '16:9',
      resolution: '720p',
      quality,
      mode: 'text-to-video',
      n: 1,
    });
  }
});

test('Token6688 Seedance 完整保留 9 图、3 视频、9 音频参考', () => {
  const images = Array.from({ length: 9 }, (_, index) => `https://cdn.example/image-${index + 1}.jpg`);
  const videos = Array.from({ length: 3 }, (_, index) => `https://cdn.example/video-${index + 1}.mp4`);
  const audios = Array.from({ length: 9 }, (_, index) => `https://cdn.example/audio-${index + 1}.mp3`);
  const body = buildToken6688VideoBody({
    model: 'seedance-2-0-special-fast-720p',
    prompt: '融合全部参考素材',
    aspect_ratio: '9:16',
    images,
    videos,
    audios,
  });

  assert.equal(body.mode, 'reference');
  assert.deepEqual(body.images, images);
  assert.deepEqual(body.videos, videos);
  assert.deepEqual(body.audios, audios);
});

test('Token6688 Seedance 首帧和首尾帧使用供应商专用模式', () => {
  const firstFrame = buildToken6688VideoBody({
    model: 'seedance-2-0-special-mini-720p',
    prompt: '从首帧开始',
    mode: 'first-frame',
    images: ['https://cdn.example/first.jpg'],
  });
  const firstLast = buildToken6688VideoBody({
    model: 'seedance-2-0-special-full-720p',
    prompt: '从首帧过渡到尾帧',
    mode: 'first-last',
    images: ['https://cdn.example/first.jpg', 'https://cdn.example/last.jpg'],
  });

  assert.equal(firstFrame.mode, 'first-frame');
  assert.equal(firstLast.mode, 'first-last');
});

test('Token6688 视频适配器创建任务并使用统一任务状态端点', async () => {
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ task_id: 'task-1', status: 'pending' }),
    };
  };

  const result = await callToken6688VideoApi({
    base_url: 'https://qd.token6688.com',
    api_key: 'secret',
  }, log, {
    model: 'seedance-2-0-special-mini-720p',
    prompt: '测试',
  });

  assert.equal(request.url, 'https://qd.token6688.com/v1/videos/generations');
  assert.equal(request.options.headers.Authorization, 'Bearer secret');
  assert.deepEqual(result, { task_id: 'task-1', status: 'pending' });
});

test('生产 callVideoApi 路由 Token6688 并透传三类参考素材数组', async () => {
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ task_id: 'task-production', status: 'pending' }),
    };
  };
  const row = {
    id: 9,
    service_type: 'video',
    provider: 'token6688',
    api_protocol: 'token6688',
    name: 'Token6688 视频',
    base_url: 'https://qd.token6688.com',
    api_key: 'secret',
    model: JSON.stringify(['seedance-2-0-special-fast-720p']),
    default_model: 'seedance-2-0-special-fast-720p',
    endpoint: '/v1/videos/generations',
    query_endpoint: '/v1/tasks/{taskId}',
    priority: 0,
    is_default: 1,
    is_active: 1,
    settings: null,
  };
  const db = { prepare: () => ({ all: () => [row] }) };

  const result = await callVideoApi(db, log, {
    model: 'seedance-2-0-special-fast-720p',
    prompt: '融合三类素材',
    reference_urls: ['https://cdn.example/image.jpg'],
    reference_video_urls: ['https://cdn.example/video.mp4'],
    reference_audio_urls: ['https://cdn.example/audio.mp3'],
  });

  const body = JSON.parse(request.options.body);
  assert.equal(request.url, 'https://qd.token6688.com/v1/videos/generations');
  assert.deepEqual(body.images, ['https://cdn.example/image.jpg']);
  assert.deepEqual(body.videos, ['https://cdn.example/video.mp4']);
  assert.deepEqual(body.audios, ['https://cdn.example/audio.mp3']);
  assert.deepEqual(result, { task_id: 'task-production', status: 'pending' });
});

test('短剧工厂 Token6688 请求把本地静态素材路径转换为公网 HTTPS 直链', async () => {
  process.env.PLATFORM_JWT_SECRET = 'test-provider-asset-secret-at-least-32-characters';
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ task_id: 'task-public-reference', status: 'pending' }),
    };
  };
  const row = {
    id: 91,
    service_type: 'video',
    provider: 'token6688',
    api_protocol: 'token6688',
    name: 'Token6688 视频',
    base_url: 'https://qd.token6688.com',
    api_key: 'secret',
    model: JSON.stringify(['seedance-2-0-special-mini-720p']),
    default_model: 'seedance-2-0-special-mini-720p',
    endpoint: '/v1/videos/generations',
    query_endpoint: '/v1/tasks/{taskId}',
    priority: 0,
    is_default: 1,
    is_active: 1,
    settings: null,
  };
  const db = { prepare: () => ({ all: () => [row] }) };

  await callVideoApi(db, log, {
    model: 'seedance-2-0-special-mini-720p',
    prompt: '使用短剧工厂内部参考图',
    reference_urls: ['/static/projects/0011/images/frame.jpg'],
    files_base_url: 'https://molimama.vip/static',
  });

  const body = JSON.parse(request.options.body);
  assert.equal(body.images.length, 1);
  const signedUrl = new URL(body.images[0]);
  assert.equal(signedUrl.origin, 'https://molimama.vip');
  assert.equal(signedUrl.pathname, '/static/projects/0011/images/frame.jpg');
  assert.equal(providerAssetUrl.verifyProviderAssetRequest({
    pathname: signedUrl.pathname,
    expires: signedUrl.searchParams.get(providerAssetUrl.EXPIRES_PARAM),
    signature: signedUrl.searchParams.get(providerAssetUrl.SIGNATURE_PARAM),
    secret: process.env.PLATFORM_JWT_SECRET,
  }), true);
});

test('生产 callVideoApi 根据显式首尾帧选择 first-last 模式', async () => {
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ task_id: 'task-first-last', status: 'pending' }),
    };
  };
  const row = {
    id: 10,
    service_type: 'video',
    provider: 'token6688',
    api_protocol: 'token6688',
    name: 'Token6688 视频',
    base_url: 'https://qd.token6688.com',
    api_key: 'secret',
    model: JSON.stringify(['seedance-2-0-special-full-720p']),
    default_model: 'seedance-2-0-special-full-720p',
    endpoint: '/v1/videos/generations',
    query_endpoint: '/v1/tasks/{taskId}',
    priority: 0,
    is_default: 1,
    is_active: 1,
    settings: null,
  };
  const db = { prepare: () => ({ all: () => [row] }) };

  await callVideoApi(db, log, {
    model: 'seedance-2-0-special-full-720p',
    prompt: '首尾过渡',
    first_frame_url: 'https://cdn.example/first.jpg',
    last_frame_url: 'https://cdn.example/last.jpg',
  });

  const body = JSON.parse(request.options.body);
  assert.equal(body.mode, 'first-last');
  assert.deepEqual(body.images, [
    'https://cdn.example/first.jpg',
    'https://cdn.example/last.jpg',
  ]);
});

test('Token6688 视频轮询从完成态 result.url 读取视频地址', async () => {
  let requestUrl;
  global.fetch = async (url) => {
    requestUrl = url;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        status: 'succeeded',
        is_final: true,
        result: { videos: [{ format: 'mp4', url: 'https://cdn.example/result.mp4' }] },
      }),
    };
  };

  const result = await pollVideoTask(null, log, 1, 'task-1', {
    provider: 'token6688',
    api_protocol: 'token6688',
    base_url: 'https://qd.token6688.com',
    api_key: 'secret',
    query_endpoint: '/v1/tasks/{taskId}',
  }, 1, 0);

  assert.equal(requestUrl, 'https://qd.token6688.com/v1/tasks/task-1');
  assert.deepEqual(result, { video_url: 'https://cdn.example/result.mp4' });
});
