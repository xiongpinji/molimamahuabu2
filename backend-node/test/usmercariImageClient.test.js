const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  USMERCARI_IMAGE_MODELS,
  validateUsmercariImageOptions,
  buildUsmercariImageBody,
  callUsmercariImageApi,
} = require('../src/services/usmercariImageClient');
const { callImageApi } = require('../src/services/imageClient');
const aiConfigService = require('../src/services/aiConfigService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const originalFetch = global.fetch;
const log = { info() {}, warn() {}, error() {} };

afterEach(() => {
  global.fetch = originalFetch;
});

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

describe('USMercari image protocol', () => {
  it('declares only the two requested image models and three priced resolutions', () => {
    assert.deepEqual(Object.keys(USMERCARI_IMAGE_MODELS), [
      'gpt-image-2-2-4k',
      'nano-banana-2',
    ]);
    assert.deepEqual(USMERCARI_IMAGE_MODELS['gpt-image-2-2-4k'].resolutions, ['1k', '2k', '4k']);
    assert.deepEqual(USMERCARI_IMAGE_MODELS['nano-banana-2'].resolutions, ['1k', '2k', '4k']);
  });

  it('builds the documented text-to-image body without unrelated OpenAI fields', () => {
    assert.deepEqual(buildUsmercariImageBody({
      model: 'gpt-image-2-2-4k',
      prompt: '电影感森林晨雾',
      n: 1,
      aspect_ratio: '16:9',
      resolution: '2K',
    }), {
      model: 'gpt-image-2-2-4k',
      prompt: '电影感森林晨雾',
      n: 1,
      aspect_ratio: '16:9',
      resolution: '2k',
    });
  });

  it('validates model, resolution and all references before provider I/O', async () => {
    assert.throws(() => validateUsmercariImageOptions({
      model: 'unknown', prompt: 'x', resolution: '1k',
    }), /未经真实生成验证/);
    assert.throws(() => validateUsmercariImageOptions({
      model: 'nano-banana-2', prompt: 'x', resolution: '1080p',
    }), /不支持 1080p/);
    assert.throws(() => validateUsmercariImageOptions({
      model: 'nano-banana-2', prompt: 'x', resolution: '1k', reference_image_urls: Array(7).fill('ref'),
    }), /最多支持 6 张参考图/);

    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return jsonResponse({});
    };
    const result = await callUsmercariImageApi({
      base_url: 'https://chat-ai.mercarimx.com', api_key: 'secret',
    }, log, {
      model: 'nano-banana-2', prompt: 'x', resolution: '1k', reference_image_urls: Array(7).fill('ref'),
    });
    assert.match(result.error, /最多支持 6 张参考图/);
    assert.equal(calls, 0);
  });

  it('submits text-to-image once with bearer auth', async () => {
    const requests = [];
    global.fetch = async (url, options) => {
      requests.push({ url: String(url), options, body: JSON.parse(options.body) });
      return jsonResponse({
        created: 1,
        data: [{ url: 'https://cdn.example/result.png' }],
        provider: { credits_used: 0.1, model_id: 'provider-model' },
      });
    };

    const result = await callUsmercariImageApi({
      base_url: 'https://chat-ai.mercarimx.com/v1/', api_key: 'secret',
    }, log, {
      model: 'gpt-image-2-2-4k', prompt: 'test', n: 1, aspect_ratio: '9:16', resolution: '4k',
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://chat-ai.mercarimx.com/v1/images/generations');
    assert.equal(requests[0].options.headers.Authorization, 'Bearer secret');
    assert.deepEqual(requests[0].body, {
      model: 'gpt-image-2-2-4k', prompt: 'test', n: 1, aspect_ratio: '9:16', resolution: '4k',
    });
    assert.equal(result.image_url, 'https://cdn.example/result.png');
    assert.deepEqual(result.provider, { credits_used: 0.1, model_id: 'provider-model' });
  });

  it('uploads references first and submits only image_ids to edits', async () => {
    const requests = [];
    let uploadIndex = 0;
    global.fetch = async (url, options) => {
      const request = { url: String(url), options, body: JSON.parse(options.body) };
      requests.push(request);
      if (request.url.endsWith('/v1/media/upload/image')) {
        uploadIndex += 1;
        return jsonResponse({ id: `image-${uploadIndex}` });
      }
      return jsonResponse({ data: [{ url: 'https://cdn.example/edited.png' }] });
    };

    const result = await callUsmercariImageApi({
      base_url: 'https://chat-ai.mercarimx.com', api_key: 'secret',
    }, log, {
      model: 'nano-banana-2', prompt: 'keep the subject', n: 1, aspect_ratio: '1:1', resolution: '1k',
      reference_image_urls: [
        'data:image/png;base64,aW1hZ2Ux',
        'data:image/png;base64,aW1hZ2Uy',
      ],
    });

    assert.equal(requests.filter((request) => request.url.endsWith('/v1/media/upload/image')).length, 2);
    const edit = requests.find((request) => request.url.endsWith('/v1/images/edits'));
    assert.deepEqual(edit.body, {
      model: 'nano-banana-2',
      prompt: 'keep the subject',
      n: 1,
      aspect_ratio: '1:1',
      resolution: '1k',
      image_ids: ['image-1', 'image-2'],
    });
    assert.equal(JSON.stringify(edit.body).includes('data:image/'), false);
    assert.equal(result.image_url, 'https://cdn.example/edited.png');
  });

  it('routes nano-banana-2 through explicit usmercari_image instead of nano_banana', async () => {
    const db = new Database(':memory:');
    runMigrationsAndEnsure(db);
    aiConfigService.createConfig(db, log, {
      service_type: 'image',
      provider: 'usmercari_image',
      api_protocol: 'usmercari_image',
      name: 'USMercari 图片',
      base_url: 'https://chat-ai.mercarimx.com',
      api_key: 'secret',
      model: ['nano-banana-2'],
      default_model: 'nano-banana-2',
      is_default: true,
      is_active: true,
    });
    const requests = [];
    global.fetch = async (url, options) => {
      const request = { url: String(url), body: JSON.parse(options.body) };
      requests.push(request);
      if (request.url.endsWith('/v1/media/upload/image')) return jsonResponse({ id: 'ref-id' });
      return jsonResponse({ data: [{ url: 'https://cdn.example/routed.png' }] });
    };

    try {
      const result = await callImageApi(db, log, {
        model: 'nano-banana-2',
        prompt: 'test',
        aspect_ratio: '16:9',
        resolution: '2k',
        reference_image_urls: ['data:image/png;base64,aW1hZ2U='],
        imageServiceType: 'image',
      });
      assert.equal(result.image_url, 'https://cdn.example/routed.png');
      assert.equal(requests.some((request) => request.url.endsWith('/api/v1/nanobanana/generate-2')), false);
      assert.deepEqual(requests.at(-1).body.image_ids, ['ref-id']);
    } finally {
      db.close();
    }
  });

  it('rejects HTML, empty data and interrupted paid submissions without retrying', async () => {
    global.fetch = async () => ({ ok: false, status: 502, text: async () => '<!DOCTYPE html><html>bad gateway</html>' });
    const html = await callUsmercariImageApi({ api_key: 'secret' }, log, {
      model: 'gpt-image-2-2-4k', prompt: 'x', resolution: '1k',
    });
    assert.match(html.error, /502/);
    assert.doesNotMatch(html.error, /<!DOCTYPE html>/i);

    global.fetch = async () => jsonResponse({ data: [] });
    const empty = await callUsmercariImageApi({ api_key: 'secret' }, log, {
      model: 'gpt-image-2-2-4k', prompt: 'x', resolution: '1k',
    });
    assert.match(empty.error, /未返回图片地址/);

    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      throw new Error('socket closed');
    };
    const interrupted = await callUsmercariImageApi({ api_key: 'secret' }, log, {
      model: 'gpt-image-2-2-4k', prompt: 'x', resolution: '1k',
    });
    assert.equal(calls, 1);
    assert.equal(interrupted.indeterminate, true);
    assert.match(interrupted.error, /不得自动重试/);
  });
});
