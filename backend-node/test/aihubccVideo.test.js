const test = require('node:test');
const assert = require('node:assert/strict');

const { callAihubccVideoApi, pollVideoTask } = require('../src/services/videoClient');

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
}

test('AIHubCC video uses async submit and poll contract', async () => {
  const originalFetch = global.fetch;
  const originalInterval = process.env.AIHUBCC_POLL_INTERVAL_MS;
  process.env.AIHUBCC_POLL_INTERVAL_MS = '0';
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).endsWith('/videos')) return jsonResponse({ id: 'video_task_1', status: 'queued' });
    return jsonResponse({ status: 'completed', video_url: 'https://cdn.example.com/generated.mp4' });
  };
  try {
    const config = {
      base_url: 'https://aihubcc.cc/v1',
      api_key: 'test-key',
      endpoint: '/videos',
      query_endpoint: '/videos/{taskId}',
      provider: 'aihubcc',
    };
    const created = await callAihubccVideoApi(config, { info() {}, warn() {}, error() {} }, {
      model: 'Seedance-2.0-720p',
      prompt: 'a continuous shot',
      duration: 6,
      aspect_ratio: '16:9',
    });
    assert.deepEqual(created, { task_id: 'video_task_1', status: 'queued' });
    const result = await pollVideoTask(null, { info() {}, warn() {}, error() {} }, 'video_gen_1', created.task_id, config, 2, 0);
    assert.deepEqual(result, { video_url: 'https://cdn.example.com/generated.mp4' });
    assert.equal(calls[0].options.method, 'POST');
    assert.match(calls[1].url, /\/videos\/video_task_1$/);
  } finally {
    global.fetch = originalFetch;
    if (originalInterval == null) delete process.env.AIHUBCC_POLL_INTERVAL_MS;
    else process.env.AIHUBCC_POLL_INTERVAL_MS = originalInterval;
  }
});

test('lingjing uploads ordered references before creating video task', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url) === 'https://assets.example/ref.png') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'image/png' },
        arrayBuffer: async () => Buffer.from('image'),
      };
    }
    if (String(url).endsWith('/uploads')) return jsonResponse({ path: 'uploads/ref.png' });
    return jsonResponse({ id: 19502, status: 'pending' });
  };
  try {
    const result = await callAihubccVideoApi(
      {
        base_url: 'https://seed.example/api/open/v1',
        api_key: 'test-key',
        endpoint: '/videos',
        provider: 'aihubcc_video',
      },
      { info() {}, warn() {}, error() {} },
      {
        model: 'lingjing-video-v1',
        prompt: 'animate reference',
        duration: 5,
        aspect_ratio: '16:9',
        reference_urls: ['https://assets.example/ref.png'],
      }
    );
    assert.deepEqual(result, { task_id: '19502', status: 'pending' });
    const uploadCall = calls.find((call) => call.url.endsWith('/uploads'));
    const submitCall = calls.find((call) => call.url.endsWith('/videos'));
    assert.equal(uploadCall.options.body instanceof FormData, true);
    const submitBody = JSON.parse(submitCall.options.body);
    assert.deepEqual(submitBody.reference_images, ['uploads/ref.png']);
    assert.equal(submitBody.ratio, '16:9');
  } finally {
    global.fetch = originalFetch;
  }
});

test('AIHubCC veo-clean uploads input video as multipart task', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return jsonResponse({ task_id: 'clean_task_1', status: 'queued' });
  };
  try {
    const result = await callAihubccVideoApi(
      {
        base_url: 'https://aihubcc.cc/v1',
        api_key: 'test-key',
        provider: 'aihubcc',
      },
      { info() {}, warn() {}, error() {} },
      {
        model: 'veo-clean',
        video_url: `data:video/mp4;base64,${Buffer.from('video').toString('base64')}`,
      }
    );
    assert.deepEqual(result, { task_id: 'clean_task_1', status: 'queued' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.body instanceof FormData, true);
    assert.equal(calls[0].options.body.get('model'), 'veo-clean');
    assert.equal(calls[0].options.body.get('prompt'), 'remove watermark');
    assert.equal(calls[0].options.headers['Content-Type'], undefined);
  } finally {
    global.fetch = originalFetch;
  }
});
