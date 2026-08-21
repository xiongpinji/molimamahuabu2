const test = require('node:test');
const assert = require('node:assert/strict');

const { testConnection } = require('../src/services/aiConfigService');

test('MiniMax TTS 配置测试使用官方 t2a_v2 协议', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      data: { audio: '494433' },
      base_resp: { status_code: 0, status_msg: 'success' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    await testConnection({
      service_type: 'tts',
      provider: 'minimax',
      base_url: 'https://api.minimaxi.com/v1',
      api_key: 'test-key',
      model: ['speech-2.8-hd'],
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(request.url, 'https://api.minimaxi.com/v1/t2a_v2');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.equal(request.body.model, 'speech-2.8-hd');
  assert.equal(request.body.output_format, 'hex');
  assert.equal(request.body.voice_setting.voice_id, 'male-qn-qingse');
});

test('非 MiniMax TTS 配置保持原有连接探针', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response('', { status: 404 });
  };

  try {
    await testConnection({
      service_type: 'tts',
      provider: 'openai',
      base_url: 'https://tts.example.com/v1',
      api_key: 'test-key',
      model: ['legacy-voice-model'],
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(request.url, 'https://tts.example.com/v1/text_to_speech');
  assert.equal(request.body.model, 'legacy-voice-model');
  assert.equal(request.body.text, 'hi');
});
