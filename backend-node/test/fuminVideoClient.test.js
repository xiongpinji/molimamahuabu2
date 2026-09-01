'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildFuminVideoBody,
  callFuminVideoApi,
  resolveFuminApiKey,
  uploadFuminReferenceAsset,
} = require('../src/services/fuminVideoClient');

const originalFetch = global.fetch;
const originalApiKey = process.env.FUMIN_API_KEY;

test.afterEach(() => {
  global.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.FUMIN_API_KEY;
  else process.env.FUMIN_API_KEY = originalApiKey;
});

test('Fumin Seedance Mini 保留有声开关和多参考合同', () => {
  const body = buildFuminVideoBody({
    model: 'fumin-seedance-2.0-mini',
    prompt: 'Diego Santos says exactly in Spanish: No sigas.',
    duration: 5,
    resolution: '480p',
    aspect_ratio: '16:9',
    generate_audio: true,
    reference_urls: ['https://assets.example.test/diego.png'],
    reference_video_urls: ['https://assets.example.test/motion.mp4'],
  });

  assert.equal(body.model, 'seedance-2.0-mini');
  assert.equal(body.generate_audio, true);
  assert.equal(body.content.filter((item) => item.type === 'image_url').length, 1);
  assert.equal(body.content.filter((item) => item.type === 'video_url').length, 1);
});
test('Fumin 有声开关 false 不被丢失', () => {
  const body = buildFuminVideoBody({
    model: 'fumin-seedance-2.0-mini',
    prompt: 'silent shot',
    duration: 5,
    resolution: '480p',
    aspect_ratio: '16:9',
    generate_audio: false,
  });

  assert.equal(body.generate_audio, false);
});

test('Fumin Seedance Mini 允许已在供应商页面核验的 9:16 竖屏合同', () => {
  const body = buildFuminVideoBody({
    model: 'fumin-seedance-2.0-mini',
    prompt: 'Mateo says exactly in English: We leave tonight.',
    duration: 8,
    resolution: '480p',
    aspect_ratio: '9:16',
    generate_audio: true,
    reference_urls: ['https://assets.example.test/cast.png'],
    reference_video_urls: ['https://assets.example.test/shot-01.mp4'],
  });

  assert.equal(body.model, 'seedance-2.0-mini');
  assert.equal(body.ratio, '9:16');
  assert.equal(body.duration, 8);
  assert.equal(body.resolution, '480p');
  assert.equal(body.generate_audio, true);
});

test('Fumin 继续拒绝未核验的视频比例', () => {
  assert.throws(() => buildFuminVideoBody({
    model: 'fumin-seedance-2.0-mini',
    prompt: 'unsupported ratio',
    duration: 8,
    resolution: '480p',
    aspect_ratio: '1:1',
    generate_audio: true,
  }), /仅开放已核验的 16:9 和 9:16/);
});

test('Fumin 视频提交优先使用 DB Key，DB 为空时才使用进程环境 Key', async () => {
  process.env.FUMIN_API_KEY = 'env-only-fumin-key';
  assert.equal(resolveFuminApiKey({ api_key: 'stored-key' }), 'stored-key');
  assert.equal(resolveFuminApiKey({ api_key: '' }), 'env-only-fumin-key');

  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({ id: 'task-123', status: 'queued' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await callFuminVideoApi(
    {
      provider: 'fumin',
      api_protocol: 'fumin_video',
      base_url: 'https://fumin.ai',
      api_key: '',
    },
    { info() {}, warn() {}, error() {} },
    {
      model: 'fumin-seedance-2.0-mini',
      prompt: 'Maya says exactly in English: We leave tonight.',
      duration: 5,
      resolution: '480p',
      aspect_ratio: '16:9',
      generate_audio: true,
    },
  );

  assert.deepEqual(result, { task_id: 'task-123', status: 'queued' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer env-only-fumin-key');
});

test('Fumin 视频提交分别解析 image video audio 引用并写入精确 body', async () => {
  const requests = [];
  const resolved = [];
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ id: 'task-456', status: 'queued' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await callFuminVideoApi(
    {
      provider: 'fumin',
      api_protocol: 'fumin_video',
      base_url: 'https://fumin.ai',
      api_key: 'db-fumin-key',
    },
    { info() {}, warn() {}, error() {} },
    {
      model: 'fumin-seedance-2.0-mini',
      prompt: 'Maya says exactly in English: We leave tonight.',
      duration: 5,
      resolution: '480p',
      aspect_ratio: '16:9',
      generate_audio: true,
      reference_urls: ['/static/redraw/actor.png'],
      reference_video_urls: ['/static/redraw/motion.mp4'],
      reference_audio_urls: ['/static/redraw/voice.mp3'],
      resolve_image: async (value, index) => {
        resolved.push({ kind: 'image', value, index });
        return 'https://media.example.test/static/redraw/actor.png?provider_asset_signature=image';
      },
      resolve_media: async (value, index, kind) => {
        resolved.push({ kind, value, index });
        return `https://media.example.test/static/redraw/${kind === 'video' ? 'motion.mp4' : 'voice.mp3'}?provider_asset_signature=${kind}`;
      },
    },
  );

  assert.deepEqual(result, { task_id: 'task-456', status: 'queued' });
  assert.deepEqual(resolved, [
    { kind: 'image', value: '/static/redraw/actor.png', index: 0 },
    { kind: 'video', value: '/static/redraw/motion.mp4', index: 0 },
    { kind: 'audio', value: '/static/redraw/voice.mp3', index: 0 },
  ]);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body.content.filter((item) => item.role === 'reference_image').map((item) => item.image_url.url), [
    'https://media.example.test/static/redraw/actor.png?provider_asset_signature=image',
  ]);
  assert.deepEqual(requests[0].body.content.filter((item) => item.role === 'reference_video').map((item) => item.video_url.url), [
    'https://media.example.test/static/redraw/motion.mp4?provider_asset_signature=video',
  ]);
  assert.deepEqual(requests[0].body.content.filter((item) => item.role === 'reference_audio').map((item) => item.audio_url.url), [
    'https://media.example.test/static/redraw/voice.mp3?provider_asset_signature=audio',
  ]);
});

test('Fumin 本地视频或音频无法公开时在 POST 前 fail closed', async () => {
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return new Response('{}', { status: 200 });
  };

  const result = await callFuminVideoApi(
    {
      provider: 'fumin',
      api_protocol: 'fumin_video',
      base_url: 'https://fumin.ai',
      api_key: 'db-fumin-key',
    },
    { info() {}, warn() {}, error() {} },
    {
      model: 'fumin-seedance-2.0-mini',
      prompt: 'Maya says exactly in English: We leave tonight.',
      duration: 5,
      resolution: '480p',
      aspect_ratio: '16:9',
      reference_video_urls: ['/static/private/motion.mp4'],
      resolve_media: async () => {
        throw new Error('本地媒体无法公开给供应商读取');
      },
    },
  );

  assert.match(result.error, /参考视频或音频准备失败/);
  assert.equal(fetchCalls, 0);
});

test('Fumin 第一方素材上传使用固定端点并返回可用于生成的 HTTPS URL', async () => {
  const requests = [];
  const bytes = Buffer.from('approved-reference-bytes');
  const result = await uploadFuminReferenceAsset({
    base_url: 'https://fumin.ai',
    api_key: 'db-fumin-key',
  }, {
    bytes,
    filename: 'approved-motion.mp4',
    mimeType: 'video/mp4',
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return new Response(JSON.stringify({
        id: 'file-123',
        url: 'https://fumin.ai/api/v3/files/file-123/content',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.deepEqual(result, {
    asset_id: 'file-123',
    url: 'https://fumin.ai/api/v3/files/file-123/content',
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://fumin.ai/api/v3/files/uploads?volc_asset=true');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer db-fumin-key');
  assert.equal(requests[0].options.body instanceof FormData, true);
  const uploaded = requests[0].options.body.get('file');
  assert.equal(uploaded.name, 'approved-motion.mp4');
  assert.equal(uploaded.type, 'video/mp4');
  assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()), bytes);
});

test('Fumin 上传只返回文件 ID 时查询一次固定元数据端点', async () => {
  const requests = [];
  const result = await uploadFuminReferenceAsset({
    base_url: 'https://fumin.ai/api/v3',
    api_key: 'db-fumin-key',
  }, {
    bytes: Buffer.from('approved-image-bytes'),
    filename: 'approved-identity.png',
    mimeType: 'image/png',
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), method: options.method || 'GET' });
      if (requests.length === 1) {
        return new Response(JSON.stringify({ data: { file_id: 'file-456' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ data: { file: { url: 'https://fumin.ai/files/file-456.png' } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.deepEqual(result, {
    asset_id: 'file-456',
    url: 'https://fumin.ai/files/file-456.png',
  });
  assert.deepEqual(requests, [
    { url: 'https://fumin.ai/api/v3/files/uploads?volc_asset=true', method: 'POST' },
    { url: 'https://fumin.ai/api/v3/files/file-456', method: 'GET' },
  ]);
});

test('Fumin 素材上传连接结果未知时返回稳定错误且不查询元数据', async () => {
  let calls = 0;
  await assert.rejects(() => uploadFuminReferenceAsset({
    base_url: 'https://fumin.ai',
    api_key: 'db-fumin-key',
  }, {
    bytes: Buffer.from('approved-image-bytes'),
    filename: 'approved-identity.png',
    mimeType: 'image/png',
    fetchImpl: async () => {
      calls += 1;
      throw new Error('socket closed');
    },
  }), { code: 'FUMIN_REFERENCE_UPLOAD_UNKNOWN' });
  assert.equal(calls, 1);
});
