const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');

const { callAihubccImageApi } = require('../src/services/imageClient');

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
}

test('AIHubCC gpt-image-2-2k returns synchronous chat image URL', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return jsonResponse({
      choices: [{ message: { content: '![image](https://cdn.example.com/generated.png)' } }],
    });
  };
  try {
    const result = await callAihubccImageApi(
      { base_url: 'https://aihubcc.cc/v1', api_key: 'test-key', endpoint: '/images/generations', query_endpoint: '/videos/{taskId}' },
      { info() {}, warn() {}, error() {} },
      { model: 'gpt-image-2-2k', prompt: 'a tree', size: '1024x1024' }
    );
    assert.deepEqual(result, { image_url: 'https://cdn.example.com/generated.png' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.method, 'POST');
    assert.match(calls[0].url, /\/chat\/completions$/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('AIHubCC Flow image posts chat completion and extracts markdown image URL', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return jsonResponse({
      choices: [{
        message: {
          content: '![Generated Image](https://flow-content.google/image/generated.png?Expires=1&Signature=x)',
        },
      }],
    });
  };
  try {
    const result = await callAihubccImageApi(
      { base_url: 'https://aihubcc.cc/v1', api_key: 'test-key', endpoint: '/images/generations' },
      { info() {}, warn() {}, error() {} },
      {
        model: 'gemini-3.1-flash-image-landscape',
        prompt: 'a cinematic forest',
        reference_image_urls: ['https://example.com/character.png'],
      }
    );
    assert.deepEqual(result, {
      image_url: 'https://flow-content.google/image/generated.png?Expires=1&Signature=x',
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v1\/chat\/completions$/);
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.model, 'gemini-3.1-flash-image-landscape');
    assert.equal(body.messages[0].content[1].type, 'image_url');
  } finally {
    global.fetch = originalFetch;
  }
});

test('AIHubCC resolves generated /static image references from local storage', async () => {
  const originalFetch = global.fetch;
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-image-ref-'));
  const imagePath = path.join(storagePath, 'projects', 'demo', 'generated.png');
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.writeFileSync(imagePath, Buffer.from('generated-image'));

  let requestBody;
  global.fetch = async (_url, options = {}) => {
    requestBody = JSON.parse(options.body);
    return jsonResponse({
      data: [{ url: 'https://cdn.example.com/generated.png' }],
    });
  };

  try {
    await callAihubccImageApi(
      { base_url: 'https://aihubcc.cc/v1', api_key: 'test-key', endpoint: '/images/generations' },
      { info() {}, warn() {}, error() {} },
      {
        model: 'gpt-image-2-2k',
        prompt: 'change the clothes',
        reference_image_urls: ['/static/projects/demo/generated.png'],
        files_base_url: 'http://localhost:5679/static',
        storage_local_path: storagePath,
      }
    );

    assert.equal(
      requestBody.messages[0].content[1].image_url.url,
      `data:image/png;base64,${Buffer.from('generated-image').toString('base64')}`
    );
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
});

test('AIHubCC compresses oversized local references before building the request body', async () => {
  const originalFetch = global.fetch;
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-aihubcc-large-ref-'));
  const imagePath = path.join(storagePath, 'projects', 'demo', 'large.png');
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  const width = 1536;
  const height = 1536;
  await sharp(crypto.randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 },
  }).png({ compressionLevel: 0 }).toFile(imagePath);

  let requestBodyText = '';
  global.fetch = async (_url, options = {}) => {
    requestBodyText = String(options.body || '');
    return jsonResponse({
      choices: [{ message: { content: '![image](https://cdn.example.com/generated.png)' } }],
    });
  };

  try {
    await callAihubccImageApi(
      { base_url: 'https://aihubcc.cc/v1', api_key: 'test-key', endpoint: '/images/generations' },
      { info() {}, warn() {}, error() {} },
      {
        model: 'gpt-image-2-2k',
        prompt: 'keep the person identity',
        reference_image_urls: ['/static/projects/demo/large.png'],
        files_base_url: 'http://localhost:5679/static',
        storage_local_path: storagePath,
      }
    );

    const body = JSON.parse(requestBodyText);
    const reference = body.messages[0].content[1].image_url.url;
    assert.match(reference, /^data:image\/jpeg;base64,/);
    assert.ok(Buffer.byteLength(requestBodyText, 'utf8') < 3 * 1024 * 1024);
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
});

test('AIHubCC 413 error does not expose the Cloudflare HTML response', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 413,
    text: async () => '<html><head><title>413 Payload Too Large</title></head></html>',
  });

  try {
    const result = await callAihubccImageApi(
      { base_url: 'https://aihubcc.cc/v1', api_key: 'test-key', endpoint: '/images/generations' },
      { info() {}, warn() {}, error() {} },
      { model: 'gpt-image-2-2k', prompt: 'a portrait' }
    );
    assert.equal(result.error, 'AIHubCC 图片请求失败: 413 参考图请求体过大，已尝试压缩，请更换较小的参考图');
    assert.equal(result.retryOnAnotherProvider, true);
    assert.equal(result.failureStatus, 413);
    assert.doesNotMatch(result.error, /<html>/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test('AIHubCC 400 invalid JSON error is sanitized and eligible for provider failover', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => jsonResponse({
    code: 'fail_to_fetch_task',
    message: '{"error":{"code":"invalid_request","message":"请求体不是合法 JSON。"},"data":null}',
  }, 400);

  try {
    const result = await callAihubccImageApi(
      { base_url: 'https://aihubcc.cc/v1', api_key: 'test-key', endpoint: '/images/generations' },
      { info() {}, warn() {}, error() {} },
      { model: 'gpt-image-2-2k', prompt: 'a storyboard' }
    );
    assert.equal(result.error, 'AIHubCC 图片请求失败: 400 上游未接受图片请求');
    assert.equal(result.retryOnAnotherProvider, true);
    assert.equal(result.failureStatus, 400);
    assert.doesNotMatch(result.error, /invalid_request|合法 JSON|\\"error\\"/i);
  } finally {
    global.fetch = originalFetch;
  }
});
