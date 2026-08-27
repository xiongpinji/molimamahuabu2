'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildFuminVideoBody,
  callFuminVideoApi,
  resolveFuminApiKey,
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
