const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

test('AIHubCC gpt-image-2 reference generation uploads the image with the verified edits contract', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ data: [{ url: 'https://cdn.example.com/edited.png' }] });
  };

  try {
    const reference = Buffer.from('reference-image');
    const result = await callAihubccImageApi(
      { base_url: 'https://aihubcc.cc/v1', api_key: 'test-key', endpoint: '/images/generations' },
      { info() {}, warn() {}, error() {} },
      {
        model: 'gpt-image-2',
        prompt: 'keep the same character',
        size: '1024x1024',
        reference_image_urls: [`data:image/png;base64,${reference.toString('base64')}`],
      }
    );

    assert.deepEqual(result, { image_url: 'https://cdn.example.com/edited.png' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://aihubcc.cc/v1/images/edits');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-key');
    assert.equal(calls[0].options.headers['Content-Type'], undefined);
    assert.equal(calls[0].options.body instanceof FormData, true);
    assert.equal(calls[0].options.body.get('model'), 'gpt-image-2');
    assert.equal(calls[0].options.body.get('prompt'), 'keep the same character');
    assert.equal(calls[0].options.body.get('size'), '1024x1024');
    const image = calls[0].options.body.get('image[]');
    assert.equal(image.type, 'image/png');
    assert.equal(image.name, 'reference-1.png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), reference);
  } finally {
    global.fetch = originalFetch;
  }
});

test('AIHubCC gpt-image-2 uploads every one of the 20 verified references without truncation', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options = {}) => {
    request = { url: String(url), options };
    return jsonResponse({ data: [{ url: 'https://cdn.example.com/twenty-references.png' }] });
  };

  try {
    const references = Array.from({ length: 20 }, (_, index) => (
      `data:image/png;base64,${Buffer.from(`reference-${index + 1}`).toString('base64')}`
    ));
    const result = await callAihubccImageApi(
      { base_url: 'https://aihubcc.cc/v1', api_key: 'test-key', endpoint: '/images/generations' },
      { info() {}, warn() {}, error() {} },
      {
        model: 'gpt-image-2',
        prompt: 'keep the same character',
        size: '1024x1024',
        reference_image_urls: references,
      }
    );

    assert.deepEqual(result, { image_url: 'https://cdn.example.com/twenty-references.png' });
    assert.equal(request.url, 'https://aihubcc.cc/v1/images/edits');
    const images = request.options.body.getAll('image[]');
    assert.equal(images.length, 20);
    assert.deepEqual(
      await Promise.all(images.map(async (image) => Buffer.from(await image.arrayBuffer()).toString())),
      Array.from({ length: 20 }, (_, index) => `reference-${index + 1}`),
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('AIHubCC gpt-image-2 rejects the 21st reference before submission', async () => {
  const originalFetch = global.fetch;
  let requestCount = 0;
  global.fetch = async () => {
    requestCount += 1;
    return jsonResponse({ data: [{ url: 'https://cdn.example.com/should-not-exist.png' }] });
  };

  try {
    const reference = `data:image/png;base64,${Buffer.from('reference-image').toString('base64')}`;
    const result = await callAihubccImageApi(
      { base_url: 'https://aihubcc.cc/v1', api_key: 'test-key', endpoint: '/images/generations' },
      { info() {}, warn() {}, error() {} },
      {
        model: 'gpt-image-2',
        prompt: 'keep the same character',
        size: '1024x1024',
        reference_image_urls: Array(21).fill(reference),
      }
    );

    assert.equal(requestCount, 0);
    assert.match(result.error, /gpt-image-2.*最多支持 20 张参考图/);
    assert.equal(result.route_meta.requestBodySent, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('AIHubCC gpt-image-2 does not silently fall back to text generation when its reference cannot be read', async () => {
  const originalFetch = global.fetch;
  let requestCount = 0;
  global.fetch = async () => {
    requestCount += 1;
    return jsonResponse({ data: [{ url: 'https://cdn.example.com/should-not-exist.png' }] });
  };

  try {
    const result = await callAihubccImageApi(
      { base_url: 'https://aihubcc.cc/v1', api_key: 'test-key', endpoint: '/images/generations' },
      { info() {}, warn() {}, error() {} },
      {
        model: 'gpt-image-2',
        prompt: 'keep the same character',
        size: '1024x1024',
        reference_image_urls: ['C:\\outside-storage\\missing.png'],
      }
    );

    assert.equal(requestCount, 0);
    assert.match(result.error, /gpt-image-2.*参考图无法读取/);
    assert.equal(result.route_meta.requestBodySent, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('AIHubCC gpt-image-2 does not fetch an arbitrary remote reference URL', async () => {
  const originalFetch = global.fetch;
  let requestCount = 0;
  global.fetch = async () => {
    requestCount += 1;
    return jsonResponse({ data: [{ url: 'https://cdn.example.com/should-not-exist.png' }] });
  };

  try {
    const result = await callAihubccImageApi(
      { base_url: 'https://aihubcc.cc/v1', api_key: 'test-key', endpoint: '/images/generations' },
      { info() {}, warn() {}, error() {} },
      {
        model: 'gpt-image-2',
        prompt: 'keep the same character',
        size: '1024x1024',
        reference_image_urls: ['https://untrusted.example/reference.png'],
      }
    );

    assert.equal(requestCount, 0);
    assert.match(result.error, /参考图准备失败.*本地素材/);
    assert.equal(result.route_meta.requestBodySent, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('AIHubCC gpt-image-2 without a reference keeps the JSON generations contract', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options = {}) => {
    request = { url: String(url), options };
    return jsonResponse({ data: [{ url: 'https://cdn.example.com/generated.png' }] });
  };

  try {
    const result = await callAihubccImageApi(
      { base_url: 'https://aihubcc.cc/v1', api_key: 'test-key', endpoint: '/images/generations' },
      { info() {}, warn() {}, error() {} },
      { model: 'gpt-image-2', prompt: 'a cinematic forest', size: '1024x1024' }
    );

    assert.deepEqual(result, { image_url: 'https://cdn.example.com/generated.png' });
    assert.equal(request.url, 'https://aihubcc.cc/v1/images/generations');
    assert.equal(request.options.headers['Content-Type'], 'application/json');
    assert.equal(request.options.body instanceof FormData, false);
    assert.equal(JSON.parse(request.options.body).model, 'gpt-image-2');
  } finally {
    global.fetch = originalFetch;
  }
});

test('AIHubCC gpt-image-2-1k reference generation uses documented synchronous JSON contract', async () => {
  const originalFetch = global.fetch;
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-aihubcc-edit-'));
  const imagePath = path.join(storagePath, 'projects', 'demo', 'reference.png');
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.writeFileSync(imagePath, Buffer.from('reference-image'));

  let request;
  global.fetch = async (url, options = {}) => {
    request = { url: String(url), options };
    return jsonResponse({ images: ['https://cdn.example.com/edited.png'] });
  };

  try {
    const result = await callAihubccImageApi(
      { base_url: 'https://aihubcc.cc/v1', api_key: 'test-key', endpoint: '/images/generations' },
      { info() {}, warn() {}, error() {} },
      {
        model: 'gpt-image-2-1k',
        prompt: 'keep the character and change the costume',
        size: '2048x1152',
        quality: 'low',
        reference_image_urls: ['/static/projects/demo/reference.png'],
        files_base_url: 'http://localhost:5679/static',
        storage_local_path: storagePath,
      }
    );

    assert.equal(request.url, 'https://aihubcc.cc/v1/images/generations');
    assert.equal(request.options.headers.Authorization, 'Bearer test-key');
    assert.equal(request.options.headers['Content-Type'], 'application/json');
    const body = JSON.parse(request.options.body);
    assert.equal(body.model, 'gpt-image-2-1k');
    assert.equal(body.prompt, 'keep the character and change the costume');
    assert.equal(body.size, '1536x1024');
    assert.equal(body.quality, 'low');
    assert.equal(body.reference_image_urls.length, 1);
    assert.match(body.reference_image_urls[0], /^data:image\/png;base64,/);
    assert.deepEqual(result, { image_url: 'https://cdn.example.com/edited.png' });
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
});
