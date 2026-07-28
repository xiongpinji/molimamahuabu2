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
      model: 'lingjing-video-v1',
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
