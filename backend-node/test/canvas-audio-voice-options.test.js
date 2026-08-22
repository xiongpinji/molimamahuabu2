const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const createAudioRoutes = require('../src/routes/audio');

const audioSource = readFileSync(path.join(__dirname, '../src/routes/audio.js'), 'utf8');

test('独立画布语音参数透传到真实 TTS 服务', () => {
  assert.match(audioSource, /voice_id/);
  assert.match(audioSource, /speed/);
  assert.match(audioSource, /voice_id:\s*voice_id/);
  assert.match(audioSource, /speed:\s*speechSpeed/);
});

test('独立画布拒绝非法语速，避免 NaN 透传到真实 TTS 服务', async () => {
  const routes = createAudioRoutes({}, console, {}, { billingEnabled: false });
  let statusCode = null;
  let payload = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      payload = body;
      return this;
    },
  };

  await routes.extract({ body: { drama_id: 1, text: '测试', speed: 'fast' } }, res);

  assert.equal(statusCode, 400);
  assert.equal(payload.success, false);
  assert.match(payload.error.message, /speed/);
});
