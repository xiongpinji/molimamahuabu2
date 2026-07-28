const test = require('node:test');
const assert = require('node:assert/strict');

const { callXaiVideoApi } = require('../src/services/videoClient');

test('xAI grok-imagine request sends reference_images as URL strings', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  let submittedBody;
  global.fetch = async (_url, options) => {
    submittedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'task-1' }),
    };
  };

  const mainImage = `data:image/png;base64,${Buffer.from('main').toString('base64')}`;
  const referenceImage = `data:image/png;base64,${Buffer.from('reference').toString('base64')}`;
  const result = await callXaiVideoApi(
    {
      base_url: 'https://example.com',
      endpoint: '/api/open/v1/videos',
      api_key: 'test-key',
    },
    { info() {}, warn() {}, error() {} },
    {
      model: 'imagine-motion-v1',
      prompt: 'animate',
      duration: 15,
      aspect_ratio: '16:9',
      resolution: '720p',
      image_url: mainImage,
      reference_urls: [referenceImage],
    }
  );

  assert.deepEqual(result, { task_id: 'task-1', status: 'submitted' });
  assert.deepEqual(submittedBody.image, { url: mainImage });
  assert.deepEqual(submittedBody.reference_images, [referenceImage]);
});

test('lingjing open API uploads reference images before creating video', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const requests = [];
  let uploadCount = 0;
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/uploads')) {
      uploadCount += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ path: `uploads/test/ref-${uploadCount}.png` }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 42, status: 'pending' }),
    };
  };

  const mainImage = `data:image/png;base64,${Buffer.from('main').toString('base64')}`;
  const referenceImage = `data:image/png;base64,${Buffer.from('reference').toString('base64')}`;
  const result = await callXaiVideoApi(
    {
      base_url: 'https://seed.example/api/open/v1',
      endpoint: '/videos',
      api_key: 'test-key',
    },
    { info() {}, warn() {}, error() {} },
    {
      model: 'lingjing-video-v1',
      prompt: '让 @参考图1 中的人物走入 @参考图2 的场景',
      duration: 15,
      aspect_ratio: '16:9',
      resolution: '720p',
      image_url: mainImage,
      reference_urls: [referenceImage],
    }
  );

  const uploads = requests.filter(({ url }) => url.endsWith('/uploads'));
  const creates = requests.filter(({ url }) => url.endsWith('/videos'));
  assert.equal(uploads.length, 2);
  assert.equal(creates.length, 1);
  assert.equal(uploads[0].url, 'https://seed.example/api/open/v1/uploads');
  assert.equal(uploads[1].url, 'https://seed.example/api/open/v1/uploads');
  assert.equal(uploads[0].options.body instanceof FormData, true);
  assert.equal(uploads[1].options.body instanceof FormData, true);

  const createBody = JSON.parse(creates[0].options.body);
  assert.deepEqual(createBody, {
    model: 'lingjing-video-v1',
    prompt: '让 @参考图1 中的人物走入 @参考图2 的场景',
    duration: 15,
    ratio: '16:9',
    reference_images: ['uploads/test/ref-1.png', 'uploads/test/ref-2.png'],
  });
  assert.deepEqual(result, { task_id: '42', status: 'pending' });
});

test('xAI errors include FastAPI detail', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ detail: '参考图路径不合法（含非法段）' }),
  });

  const result = await callXaiVideoApi(
    { base_url: 'https://example.com', endpoint: '/videos', api_key: 'test-key' },
    { info() {}, warn() {}, error() {} },
    {
      model: 'other-video-model',
      prompt: 'animate',
      duration: 5,
      aspect_ratio: '16:9',
      resolution: '720p',
    }
  );

  assert.equal(result.error, 'xAI 视频请求失败: 400 - 参考图路径不合法（含非法段）');
});
