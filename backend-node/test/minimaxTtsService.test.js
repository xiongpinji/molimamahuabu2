const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { synthesize } = require('../src/services/ttsService');
const validMp3Bytes = require('./fixtures/minimalMp3');

function listen(server) {
  return new Promise((resolve, reject) => {
    const running = server.listen(0, '127.0.0.1', () => resolve(running));
    running.once('error', reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('MiniMax T2A 使用管理员 Base URL 并传递音频节点参数', async (t) => {
  let capturedPath = '';
  let capturedAuth = '';
  let capturedBody = null;
  const provider = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      capturedPath = req.url;
      capturedAuth = req.headers.authorization;
      capturedBody = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: { audio: validMp3Bytes.toString('hex') },
        base_resp: { status_code: 0, status_msg: 'success' },
      }));
    });
  });
  const server = await listen(provider);
  t.after(() => close(server));

  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-tts-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const result = await synthesize({}, { info() {} }, {
    text: '重庆银行欢迎您',
    storyboard_id: null,
    storage_base: storageRoot,
    config: {
      provider: 'minimax',
      base_url: `http://127.0.0.1:${server.address().port}/v1`,
      api_key: 'server-side-test-key',
      default_model: 'speech-2.8-hd',
      settings: '{}',
    },
    voice_id: 'Chinese (Mandarin)_Reliable_Executive',
    speed: 1.15,
    volume: 1.2,
    pitch: -2,
    emotion: 'disgusted',
    pronunciation_tones: ['重庆/(chong2)(qing4)', '银行/(yin2)(hang2)'],
  });

  assert.equal(capturedPath, '/v1/t2a_v2');
  assert.equal(capturedAuth, 'Bearer server-side-test-key');
  assert.deepEqual(capturedBody, {
    model: 'speech-2.8-hd',
    text: '重庆银行欢迎您',
    stream: false,
    output_format: 'hex',
    voice_setting: {
      voice_id: 'Chinese (Mandarin)_Reliable_Executive',
      speed: 1.15,
      vol: 1.2,
      pitch: -2,
      emotion: 'disgusted',
    },
    pronunciation_dict: {
      tone: ['重庆/(chong2)(qing4)', '银行/(yin2)(hang2)'],
    },
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: 'mp3',
      channel: 1,
    },
  });
  assert.match(result.local_path, /^audio\/tts_sbx_/);
  assert.deepEqual(fs.readFileSync(path.join(storageRoot, result.local_path)), validMp3Bytes);
});
