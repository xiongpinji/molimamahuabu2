const test = require('node:test');
const assert = require('node:assert/strict');

const { callAihubccImageApi } = require('../src/services/imageClient');

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
}

test('AIHubCC async image submits then polls to image URL', async () => {
  const originalFetch = global.fetch;
  const originalInterval = process.env.AIHUBCC_POLL_INTERVAL_MS;
  process.env.AIHUBCC_POLL_INTERVAL_MS = '0';
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).endsWith('/videos')) return jsonResponse({ task_id: 'img_task_1', status: 'processing' });
    return jsonResponse({ status: 'completed', video_url: 'https://cdn.example.com/generated.png' });
  };
  try {
    const result = await callAihubccImageApi(
      { base_url: 'https://aihubcc.cc/v1', api_key: 'test-key', endpoint: '/images/generations', query_endpoint: '/videos/{taskId}' },
      { info() {}, warn() {}, error() {} },
      { model: 'gpt-image-2-2k', prompt: 'a tree', size: '1024x1024' }
    );
    assert.deepEqual(result, { image_url: 'https://cdn.example.com/generated.png' });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.method, 'POST');
    assert.match(calls[1].url, /\/videos\/img_task_1$/);
  } finally {
    global.fetch = originalFetch;
    if (originalInterval == null) delete process.env.AIHUBCC_POLL_INTERVAL_MS;
    else process.env.AIHUBCC_POLL_INTERVAL_MS = originalInterval;
  }
});
