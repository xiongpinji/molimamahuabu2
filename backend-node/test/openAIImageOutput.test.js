const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Database = require('better-sqlite3');

const aiConfig = require('../src/services/aiConfigService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const {
  getOpenAIImageOutputOptions,
  normalizeGptImageSize,
  imageMimeFromOutputFormat,
  imageMimeFromBase64,
  formatGptImageUnknownResultError,
  MAX_PROVIDER_IMAGE_BASE64_LENGTH,
  normalizeProviderImageOutput,
  extractOpenAIImageResult,
  summarizeImageResponse,
  callImageApi,
} = require('../src/services/imageClient');

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('GPT Image 使用压缩 JPEG，缩短同步响应时间并减小返回体', () => {
  assert.deepEqual(getOpenAIImageOutputOptions('gpt-image-2', null), {
    output_format: 'jpeg',
    output_compression: 85,
    quality: 'low',
  });
  assert.equal(getOpenAIImageOutputOptions('gpt-image-2', 'high').quality, undefined);
  assert.deepEqual(getOpenAIImageOutputOptions('dall-e-3', null), {});
});

test('GPT Image 将项目尺寸映射到模型支持的较小尺寸', () => {
  assert.equal(normalizeGptImageSize('2560x1440'), '1536x1024');
  assert.equal(normalizeGptImageSize('1440x2560'), '1024x1536');
  assert.equal(normalizeGptImageSize('1024x1024'), '1024x1024');
});

test('base64 图片 MIME 与请求输出格式保持一致', () => {
  assert.equal(imageMimeFromOutputFormat('jpeg'), 'image/jpeg');
  assert.equal(imageMimeFromOutputFormat('webp'), 'image/webp');
  assert.equal(imageMimeFromOutputFormat(), 'image/png');
});

test('base64 图片 MIME 优先使用实际文件格式', () => {
  const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
  const jpegBase64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64');
  const webpBase64 = Buffer.from('RIFF1234WEBP', 'ascii').toString('base64');
  assert.equal(imageMimeFromBase64(pngBase64, 'jpeg'), 'image/png');
  assert.equal(imageMimeFromBase64(jpegBase64, 'png'), 'image/jpeg');
  assert.equal(imageMimeFromBase64(webpBase64, 'png'), 'image/webp');
  assert.equal(imageMimeFromBase64(Buffer.from('unknown').toString('base64'), 'jpeg'), 'image/jpeg');
});

test('GPT Image 同步连接中断明确提示结果未知与重复扣费风险', () => {
  const message = formatGptImageUnknownResultError(new Error('socket hang up'));
  assert.match(message, /结果未知/);
  assert.match(message, /不要连续重试/);
  assert.match(message, /重复扣费/);
  assert.match(message, /socket hang up/);
});

test('OpenAI 兼容图片响应按固定优先级解析七种格式', () => {
  const cases = [
    [{ data: [{ url: 'https://cdn.example/data-url.png' }] }, null, 'https://cdn.example/data-url.png'],
    [{ data: [{ image_url: 'https://cdn.example/data-image-url.png' }] }, null, 'https://cdn.example/data-image-url.png'],
    [{ data: [{ b64_json: ' YW Jj\nZA== ' }] }, 'jpeg', 'data:image/jpeg;base64,YWJjZA=='],
    [{ image_url: 'https://cdn.example/top-image-url.png' }, null, 'https://cdn.example/top-image-url.png'],
    [{ result: { url: 'https://cdn.example/result-url.png' } }, null, 'https://cdn.example/result-url.png'],
    [{ images: ['data:image/webp;base64,existing'] }, null, 'data:image/webp;base64,existing'],
    [{ images: [' aG Vs\nbG8= '] }, null, 'data:image/png;base64,aGVsbG8='],
  ];

  for (const [data, outputFormat, expected] of cases) {
    assert.deepEqual(extractOpenAIImageResult(data, outputFormat), { image_url: expected });
  }

  assert.deepEqual(extractOpenAIImageResult({
    data: [{
      url: 'https://cdn.example/priority-1.png',
      image_url: 'https://cdn.example/priority-2.png',
      b64_json: 'cHJpb3JpdHkz',
    }],
    image_url: 'https://cdn.example/priority-4.png',
    result: { url: 'https://cdn.example/priority-5.png' },
    images: ['cHJpb3JpdHk2'],
  }, 'webp'), { image_url: 'https://cdn.example/priority-1.png' });
});

test('供应商图片产物仅接受可读取的 HTTP(S)、受支持 data image 或合规 Base64', () => {
  assert.equal(
    normalizeProviderImageOutput('  https://cdn.example/image.png?X-Amz-Signature=test  '),
    'https://cdn.example/image.png?X-Amz-Signature=test',
  );
  assert.equal(
    normalizeProviderImageOutput(' data:image/jpeg;base64, YW Jj\nZA== '),
    'data:image/jpeg;base64,YWJjZA==',
  );
  assert.equal(
    normalizeProviderImageOutput(' YW Jj\nZA== ', { allowRawBase64: true, mimeType: 'image/webp' }),
    'data:image/webp;base64,YWJjZA==',
  );

  for (const invalid of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'ftp://cdn.example/image.png',
    'http:relative-path',
    'https://cdn.example/image name.png',
    'ordinary string as url',
    'data:text/html;base64,PGgxPnNlY3JldDwvaDE+',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'data:image/png;base64,not*base64',
    'data:image/png;base64,abc',
    '',
    '   ',
    123,
    {},
    [],
  ]) {
    assert.equal(normalizeProviderImageOutput(invalid), null);
  }

  const oversized = 'A'.repeat(MAX_PROVIDER_IMAGE_BASE64_LENGTH + 4);
  assert.equal(normalizeProviderImageOutput(oversized, { allowRawBase64: true }), null);
  assert.equal(normalizeProviderImageOutput(`data:image/png;base64,${oversized}`), null);
});

test('七种响应槽位中的危险协议、普通字符串和畸形 Base64 均不可进入 completed', () => {
  for (const data of [
    { data: [{ url: 'javascript:alert(1)' }] },
    { data: [{ image_url: 'file:///tmp/private.png' }] },
    { data: [{ b64_json: 'not*base64' }] },
    { image_url: 'ftp://cdn.example/private.png' },
    { result: { url: 'ordinary string as url' } },
    { images: ['data:text/html;base64,PGgxPnNlY3JldDwvaDE+'] },
    { images: ['abc'] },
  ]) {
    assert.equal(extractOpenAIImageResult(data, 'png'), null);
  }
});

test('OpenAI 兼容图片响应对空值和不可读值返回 null', () => {
  for (const data of [
    null,
    {},
    { data: [] },
    { data: [{ url: '', image_url: '  ', b64_json: '\n\t' }] },
    { image_url: 42, result: { url: {} }, images: [{ url: 'not-a-string' }] },
  ]) {
    assert.equal(extractOpenAIImageResult(data, 'png'), null);
  }
});

test('图片响应安全摘要只包含白名单元数据', () => {
  const secret = 'sk-super-secret';
  const signedUrl = 'https://cdn.example/image.png?X-Amz-Signature=top-secret';
  const base64 = 'c2VjcmV0LWltYWdlLWJ5dGVz';
  const raw = JSON.stringify({ secret, signedUrl, base64, prompt: 'private prompt' });
  const data = {
    request_id: 'req_safe-123',
    task_id: 'task_safe-456',
    data: [{ url: signedUrl, image_url: signedUrl, b64_json: base64, [secret]: 'value' }],
    images: [base64],
    authorization: `Bearer ${secret}`,
    [signedUrl]: 'malicious-key',
  };

  const summary = summarizeImageResponse(data, raw, 200, 876, 'gpt-image-2');

  assert.deepEqual(summary, {
    response_bytes: Buffer.byteLength(raw, 'utf8'),
    response_keys: ['request_id', 'task_id', 'data', 'images'],
    first_item_keys: ['url', 'image_url', 'b64_json'],
    upstream_request_id: 'req_safe-123',
    upstream_task_id: 'task_safe-456',
    http_status: 200,
    image_gen_id: 876,
    model: 'gpt-image-2',
  });
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /sk-super-secret|X-Amz-Signature|top-secret|c2VjcmV0|private prompt|Bearer/i);

  const maliciousIdentifiers = summarizeImageResponse({
    id: 'sk-provider-key-shaped-value',
    task_id: 'Bearer_provider_token',
  }, raw, 200, 877, signedUrl);
  assert.equal('upstream_request_id' in maliciousIdentifiers, false);
  assert.equal('upstream_task_id' in maliciousIdentifiers, false);
  assert.equal('model' in maliciousIdentifiers, false);
});

test('OpenAI 兼容同步 2xx 无可读图片时返回结果未知且日志不含响应正文', async (t) => {
  const responseSecret = 'private-provider-diagnostic';
  const signedUrl = 'https://cdn.example/private.png?X-Amz-Signature=private-signature';
  const server = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        request_id: 'req_local_789',
        data: [{ url: 'javascript:alert(1)' }],
        diagnostic: responseSecret,
        unusable: signedUrl,
      }));
    });
  });
  t.after(() => close(server));

  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  t.after(() => db.close());
  const config = aiConfig.createConfig(db, { info() {} }, {
    service_type: 'image',
    provider: 'openai',
    api_protocol: 'openai',
    name: 'local OpenAI image result test',
    base_url: `http://127.0.0.1:${server.address().port}`,
    endpoint: '/images/generations',
    api_key: 'local-test-key',
    model: ['gpt-image-2'],
    default_model: 'gpt-image-2',
    is_default: true,
  });
  if (db.prepare('PRAGMA table_info(ai_service_configs)').all().some((column) => column.name === 'verification_status')) {
    db.prepare('UPDATE ai_service_configs SET verification_status = ? WHERE id = ?').run('verified', config.id);
  }
  const entries = [];
  const log = {
    info(message, details) { entries.push({ level: 'info', message, details }); },
    warn(message, details) { entries.push({ level: 'warn', message, details }); },
    error(message, details) { entries.push({ level: 'error', message, details }); },
  };

  const result = await callImageApi(db, log, {
    config_id: config.id,
    prompt: 'local-only prompt',
    model: 'gpt-image-2',
    image_gen_id: 877,
  });

  assert.equal(result.indeterminate, true);
  assert.match(result.error, /结果未知/);
  assert.match(result.error, /不要连续重试/);
  const warning = entries.find((entry) => entry.message === 'Image API result indeterminate');
  assert.ok(warning);
  assert.equal(warning.details.upstream_request_id, 'req_local_789');
  const serializedWarning = JSON.stringify(warning);
  assert.doesNotMatch(serializedWarning, new RegExp(responseSecret));
  assert.doesNotMatch(serializedWarning, /X-Amz-Signature|private-signature/i);
});
