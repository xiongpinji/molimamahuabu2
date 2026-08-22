const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertPublicImageUrl,
  callAihubccVideoApi,
  pollVideoTask,
  requestPublicImage,
} = require('../src/services/videoClient');
const dns = require('dns');
const http = require('http');
const { EventEmitter } = require('events');

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

test('lingjing reference downloader rejects local, mapped IPv6 and DNS rebinding', async () => {
  await assert.rejects(() => assertPublicImageUrl('http://127.0.0.1/ref.png'), /私网/);
  await assert.rejects(() => assertPublicImageUrl('http://localhost/ref.png'), /本机/);
  await assert.rejects(() => assertPublicImageUrl('http://[::ffff:127.0.0.1]/ref.png'), /私网/);

  const originalLookup = dns.lookup;
  dns.lookup = (_hostname, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]);
  try {
    await assert.rejects(() => requestPublicImage(new URL('http://public.example/ref.png'), 1024), /私网/);
  } finally {
    dns.lookup = originalLookup;
  }
});

test('lingjing reference downloader preserves the all-address DNS callback contract', async () => {
  const originalGet = http.get;
  const originalLookup = dns.lookup;
  dns.lookup = (_hostname, options, callback) => {
    assert.equal(options.all, true);
    callback(null, [{ address: '203.0.113.10', family: 4 }]);
  };
  http.get = (_url, options) => {
    const request = new EventEmitter();
    request.destroy = (error) => request.emit('error', error);
    process.nextTick(() => {
      options.lookup('public.example', { all: true }, (error, addresses) => {
        assert.ifError(error);
        assert.deepEqual(addresses, [{ address: '203.0.113.10', family: 4 }]);
        request.emit('error', new Error('test complete'));
      });
    });
    return request;
  };
  try {
    await assert.rejects(
      () => requestPublicImage(new URL('http://public.example/ref.png'), 1024),
      /test complete/
    );
  } finally {
    http.get = originalGet;
    dns.lookup = originalLookup;
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
