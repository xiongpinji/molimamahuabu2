const test = require('node:test');
const assert = require('node:assert/strict');

const { testConnection } = require('../src/services/aiConfigService');

test('MiniMax TTS 配置测试使用只读 get_voice 探针，不提交付费生成', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
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

  assert.equal(request.url, 'https://api.minimaxi.com/v1/get_voice');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(request.body, { voice_type: 'all' });
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
