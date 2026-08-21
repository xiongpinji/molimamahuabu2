const test = require('node:test');
const assert = require('node:assert/strict');

const providerConfig = require('../src/services/canvasProviderConfigService');

test('canvas provider configs come from server env without exposing api keys', () => {
  const env = {
    CANVAS_TEXT_BASE_URL: 'https://text.example/v1',
    CANVAS_TEXT_API_KEY: 'text-secret',
    CANVAS_TEXT_MODEL: 'gpt-5.6-sol',
    CANVAS_IMAGE_BASE_URL: 'https://image.example/v1',
    CANVAS_IMAGE_API_KEY: 'image-secret',
    CANVAS_IMAGE_MODEL: 'gpt-image-2-2k',
    CANVAS_VIDEO_BASE_URL: 'https://video.example/api/open/v1',
    CANVAS_VIDEO_API_KEY: 'video-secret',
    CANVAS_VIDEO_MODEL: 'lingjing-video-v1',
  };

  assert.deepEqual(providerConfig.getConfig('text', 'gpt-5.6-sol', env), {
    service_type: 'text',
    provider: 'canvas_responses',
    api_protocol: 'responses',
    base_url: 'https://text.example/v1',
    api_key: 'text-secret',
    endpoint: '/responses',
    model: ['gpt-5.6-sol'],
    default_model: 'gpt-5.6-sol',
    is_active: true,
    is_default: false,
    settings: {},
  });
  assert.equal(providerConfig.getConfig('image', 'other-model', env), null);

  const safe = providerConfig.listSafe(env);
  assert.deepEqual(safe.map(({ kind, model }) => ({ kind, model })), [
    { kind: 'text', model: 'gpt-5.6-sol' },
    { kind: 'image', model: 'gpt-image-2-2k' },
    { kind: 'video', model: 'lingjing-video-v1' },
  ]);
  assert.deepEqual(safe.find((item) => item.kind === 'image').capabilities.quantities, [1, 2, 3, 4]);
  assert.deepEqual(safe.find((item) => item.kind === 'video').capabilities.aspectRatios, ['16:9', '9:16', '1:1', '21:9']);
  assert.deepEqual(safe.find((item) => item.kind === 'video').capabilities.durations, [4, 5, 6, 8, 10, 11, 15]);
  assert.equal(JSON.stringify(safe).includes('secret'), false);
});
