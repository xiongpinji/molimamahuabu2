const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildNewApiVideoBody,
  inferVideoProtocol,
  parseNewApiPollResponse,
  parseNewApiSubmitResponse,
  validateNewApiVideoOptions,
  getVideoArtifactFetchOptions,
} = require('../src/services/videoClient');
const aiConfigService = require('../src/services/aiConfigService');

test('NewAPI provider uses the dedicated video protocol', () => {
  assert.equal(inferVideoProtocol('newapi'), 'newapi_video');
});

test('NewAPI body normalizes duration and references', () => {
  assert.deepEqual(buildNewApiVideoBody({
    model: 'seedance-2.0', prompt: 'A kite over a lake', duration: 99, aspect_ratio: '9:16', resolution: '480p',
    image_url: 'https://example.com/first.png', reference_urls: ['https://example.com/ref.png'],
    voice_reference_url: 'https://example.com/voice.wav',
  }), {
    model: 'seedance-2.0', prompt: 'A kite over a lake', duration: 15, ratio: '9:16', resolution: '480p',
    referenceImages: ['https://example.com/first.png', 'https://example.com/ref.png'],
    referenceAudios: ['https://example.com/voice.wav'],
  });
});

test('NewAPI validates the Minimax reference and resolution contract', () => {
  assert.throws(() => validateNewApiVideoOptions({ model: 'minimax_h3_image_audio_to_video_v2', resolution: '480p' }), /不支持 480p/);
  assert.equal(buildNewApiVideoBody({ model: 'minimax_h3_image_audio_to_video_v2', resolution: '720p', image_url: 'https://example.com/ref.png' }).resolution, '768p');
});

test('NewAPI submit and poll responses normalize task state and URL', () => {
  assert.deepEqual(parseNewApiSubmitResponse({ id: 'vid_123', status: 'queued' }), { task_id: 'vid_123', status: 'queued' });
  assert.deepEqual(parseNewApiPollResponse({ status: 'completed', video_url: 'https://example.com/video.mp4' }), { state: 'completed', videoUrl: 'https://example.com/video.mp4' });
  assert.deepEqual(parseNewApiPollResponse({ status: 'failed', error: { message: 'quota' } }), { state: 'failed', error: 'quota' });
});

test('NewAPI artifact downloads carry Bearer authentication', () => {
  assert.deepEqual(getVideoArtifactFetchOptions({ provider: 'newapi', api_protocol: 'newapi_video', api_key: 'secret' }, 'https://cdn.example/video.mp4'), { headers: { Authorization: 'Bearer secret' } });
});

test('NewAPI connection test only reads the model catalog', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, method: options?.method });
    return { ok: true, status: 200, async text() { return JSON.stringify({ data: [
      { id: 'seedance-2.0-fast' }, { id: 'seedance-2.0' }, { id: 'seedance-2.0-mini' },
      { id: 'seedance-2.5' }, { id: 'minimax_h3_image_audio_to_video_v2' },
    ] }); } };
  };
  try {
    await aiConfigService.testConnection({ base_url: 'https://newapi.megabyai.cc', api_key: 'secret', provider: 'newapi', service_type: 'video', api_protocol: 'newapi_video' });
  } finally {
    global.fetch = originalFetch;
  }
  assert.deepEqual(calls, [{ url: 'https://newapi.megabyai.cc/v1/models', method: 'GET' }]);
});
