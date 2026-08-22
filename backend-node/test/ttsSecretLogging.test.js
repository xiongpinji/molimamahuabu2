const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { synthesize } = require('../src/services/ttsService');
const minimalMp3 = require('./fixtures/minimalMp3');

test('TTS 服务的日志调用不得直接引用 API Key', () => {
  const servicePath = path.join(__dirname, '..', 'src', 'services', 'ttsService.js');
  const source = fs.readFileSync(servicePath, 'utf8');
  const sensitiveLogLines = source
    .split(/\r?\n/)
    .filter((line) => /console\.(?:log|info|warn|error|debug)\s*\(/.test(line) && /\bapi_key\b/.test(line));

  assert.deepEqual(sensitiveLogLines, []);
});

test('OpenAI 兼容 TTS 请求使用 API Key 但日志不泄露密钥', async () => {
  const secret = 'tts-secret-behavior-test';
  let authorization = '';
  const server = http.createServer((req, res) => {
    authorization = req.headers.authorization || '';
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end(minimalMp3);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const storageBase = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-tts-security-'));
  const consoleMessages = [];
  const appMessages = [];
  const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'];
  const originalConsoleMethods = Object.fromEntries(
    consoleMethods.map((method) => [method, console[method]]),
  );
  for (const method of consoleMethods) {
    console[method] = (...args) => consoleMessages.push([method, ...args]);
  }

  try {
    const address = server.address();
    const result = await synthesize(null, {
      info: (...args) => appMessages.push(args),
      warn: (...args) => appMessages.push(args),
      error: (...args) => appMessages.push(args),
    }, {
      text: '安全测试文本',
      storyboard_id: 7,
      config: {
        provider: 'openai',
        api_key: secret,
        base_url: `http://127.0.0.1:${address.port}/v1`,
        default_model: 'tts-1',
        settings: '{}',
      },
      storage_base: storageBase,
    });

    assert.equal(authorization, `Bearer ${secret}`);
    assert.equal(fs.existsSync(path.join(storageBase, result.local_path)), true);
    assert.equal(JSON.stringify({ consoleMessages, appMessages }).includes(secret), false);
  } finally {
    for (const method of consoleMethods) console[method] = originalConsoleMethods[method];
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(storageBase, { recursive: true, force: true });
  }
});
