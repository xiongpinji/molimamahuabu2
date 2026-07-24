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
