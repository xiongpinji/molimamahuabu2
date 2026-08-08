const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  USMERCARI_IMAGE_ORIGIN,
  USMERCARI_IMAGE_MODELS,
  normalizeUsmercariImageBaseUrl,
  validateUsmercariImageOptions,
  buildUsmercariImageBody,
  callUsmercariImageApi,
} = require('../src/services/usmercariImageClient');
const { callImageApi } = require('../src/services/imageClient');
const aiConfigService = require('../src/services/aiConfigService');
const modelPriceService = require('../src/services/modelPriceService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { evidenceRoots, withExternalModelEvidence } = require('./helpers/externalModelEvidenceFixture');

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
  it('locks provider requests to the reviewed HTTPS origin', async () => {
    assert.equal(USMERCARI_IMAGE_ORIGIN, 'https://chat-ai.mercarimx.com');
    assert.equal(normalizeUsmercariImageBaseUrl('https://chat-ai.mercarimx.com/'), USMERCARI_IMAGE_ORIGIN);
    assert.equal(normalizeUsmercariImageBaseUrl('https://chat-ai.mercarimx.com/v1/'), USMERCARI_IMAGE_ORIGIN);

    const blocked = [
      'http://chat-ai.mercarimx.com',
      'https://evil.example',
      'https://chat-ai.mercarimx.com.evil.example',
      'https://user:secret@chat-ai.mercarimx.com',
      'https://chat-ai.mercarimx.com:444',
      'https://chat-ai.mercarimx.com/v2',
      'https://chat-ai.mercarimx.com/?redirect=https://evil.example',
      'https://chat-ai.mercarimx.com/#fragment',
    ];
    for (const value of blocked) {
      assert.throws(() => normalizeUsmercariImageBaseUrl(value), /官方 HTTPS 地址/);
    }

    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return jsonResponse({ data: [{ url: 'https://cdn.example/unexpected.png' }] });
    };
    for (const base_url of blocked) {
      const result = await callUsmercariImageApi({ base_url, api_key: 'secret' }, log, {
        model: 'nano-banana-2', prompt: 'x', resolution: '1k',
      });
      assert.match(result.error, /官方 HTTPS 地址/);
    }
    assert.equal(calls, 0);
  });

  it('declares only the two requested image models and supplier resolution values', () => {
    assert.deepEqual(Object.keys(USMERCARI_IMAGE_MODELS), [
      'gpt-image-2-2-4k',
      'nano-banana-2',
    ]);
    assert.deepEqual(USMERCARI_IMAGE_MODELS['gpt-image-2-2-4k'].resolutions, ['1k', '2k']);
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
      model: 'gpt-image-2-2-4k', prompt: 'x', resolution: '4k',
    }), /只开放 1k、2k/);
    assert.throws(() => validateUsmercariImageOptions({
      model: 'nano-banana-2', prompt: 'x', resolution: '1k', reference_image_urls: Array(7).fill('ref'),
    }), /最多支持 6 张参考图/);
    assert.throws(() => validateUsmercariImageOptions({
      model: 'nano-banana-2', prompt: 'x', resolution: '1k', n: 2,
    }), /仅开放已实测的 1 张/);

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
      model: 'nano-banana-2', prompt: 'test', n: 1, aspect_ratio: '9:16', resolution: '4k',
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://chat-ai.mercarimx.com/v1/images/generations');
    assert.equal(requests[0].options.headers.Authorization, 'Bearer secret');
    assert.deepEqual(requests[0].body, {
      model: 'nano-banana-2', prompt: 'test', n: 1, aspect_ratio: '9:16', resolution: '4k',
    });
    assert.equal(result.image_url, 'https://cdn.example/result.png');
    assert.deepEqual(result.provider, { credits_used: 0.1, model_id: 'provider-model' });
  });

  it('rejects non-public references before provider I/O because the upload/edits contract is not verified', async () => {
    let calls = 0;
    global.fetch = async (url, options) => {
      calls += 1;
      return jsonResponse({ data: [{ url: 'https://cdn.example/unexpected.png' }] });
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

    assert.equal(calls, 0);
    assert.match(result.error, /公网 URL/);
  });

  it('uses the documented generations image_url contract for same-storage public references', async () => {
    const requests = [];
    global.fetch = async (url, options) => {
      requests.push({ url: String(url), body: JSON.parse(options.body) });
      return jsonResponse({ data: [{ url: 'https://cdn.example/referenced.png' }] });
    };

    const result = await callUsmercariImageApi({
      base_url: 'https://chat-ai.mercarimx.com', api_key: 'secret',
    }, log, {
      model: 'nano-banana-2', prompt: 'keep the subject', resolution: '1k',
      reference_image_urls: ['https://molimama.vip/static/reference.png'],
      allowed_reference_base_url: 'https://molimama.vip/static',
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://chat-ai.mercarimx.com/v1/images/generations');
    assert.equal(requests[0].body.image_url, 'https://molimama.vip/static/reference.png');
    assert.equal(requests[0].body.image_urls, undefined);
    assert.equal(result.image_url, 'https://cdn.example/referenced.png');
  });

  it('rejects strict USMercari references outside STORAGE_BASE_URL before provider I/O', async () => {
    const blocked = [
      'http://169.254.169.254/latest/meta-data',
      'https://10.1.2.3/static/ref.png',
      'https://192.168.1.5/static/ref.png',
      'http://[::1]/static/ref.png',
      'https://user:pass@molimama.vip/static/ref.png',
      'https://assets.example/reference.png',
      'https://molimama.vip/other/ref.png',
      'https://molimama.vip/static/../secret.png',
      'ftp://molimama.vip/static/ref.png',
    ];
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return jsonResponse({ data: [{ url: 'https://cdn.example/unexpected.png' }] });
    };

    for (const reference of blocked) {
      const result = await callUsmercariImageApi({
        base_url: 'https://chat-ai.mercarimx.com', api_key: 'secret',
      }, log, {
        model: 'nano-banana-2',
        prompt: 'keep the subject',
        resolution: '1k',
        reference_image_urls: [reference],
        allowed_reference_base_url: 'https://molimama.vip/static',
      });
      assert.match(result.error, /站内静态资源公网 URL/);
    }
    assert.equal(calls, 0);
  });

  it('routes nano-banana-2 through explicit usmercari_image instead of nano_banana', async () => {
    const db = new Database(':memory:');
    runMigrationsAndEnsure(db);
    aiConfigService.createConfig(db, log, {
      service_type: 'image',
      provider: 'nano_banana',
      api_protocol: 'nano_banana',
      name: '旧 Nano Banana',
      base_url: 'https://legacy-nano.example',
      api_key: 'legacy-secret',
      model: ['nano-banana-2'],
      default_model: 'nano-banana-2',
      is_default: true,
      is_active: true,
    });
    const config = aiConfigService.createConfig(db, log, {
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
    db.prepare(`UPDATE ai_service_configs
      SET verification_status = 'verified', verified_capabilities = ? WHERE id = ?`)
      .run(JSON.stringify({
        'nano-banana-2': withExternalModelEvidence('nano-banana-2', {
          supportsTextToImage: true,
          supportsImageReference: true,
          maxReferences: 6,
          resolutions: ['1k', '2k', '4k'],
        }),
      }), config.id);
    modelPriceService.set(db, 'nano-banana-2', 70, {
      category: 'image',
      cost_unit: 'image',
      resolution_prices: {
        '1k': { credits: 70, cost_micros_per_unit: 80000 },
        '2k': { credits: 87, cost_micros_per_unit: 100000 },
        '4k': { credits: 105, cost_micros_per_unit: 120000 },
      },
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
        reference_image_urls: ['/static/projects/demo/reference.png'],
        files_base_url: 'https://molimama.vip/static',
        imageServiceType: 'image',
        preferred_provider: 'usmercari_image',
        preferred_config_id: config.id,
      }, { evidenceRoots });
      assert.equal(result.image_url, 'https://cdn.example/routed.png');
      assert.equal(requests.some((request) => request.url.endsWith('/api/v1/nanobanana/generate-2')), false);
      assert.equal(requests.at(-1).url, 'https://chat-ai.mercarimx.com/v1/images/generations');
      assert.equal(requests.at(-1).body.image_url, 'https://molimama.vip/static/projects/demo/reference.png');
    } finally {
      db.close();
    }
  });

  it('blocks the direct USMercari submit when the current resolution price is missing', async () => {
    const db = new Database(':memory:');
    runMigrationsAndEnsure(db);
    const config = aiConfigService.createConfig(db, log, {
      service_type: 'image',
      provider: 'usmercari_image',
      api_protocol: 'usmercari_image',
      name: 'USMercari direct gate',
      base_url: 'https://chat-ai.mercarimx.com',
      api_key: 'secret',
      model: ['nano-banana-2'],
      default_model: 'nano-banana-2',
      is_default: true,
      is_active: true,
    });
    db.prepare(`UPDATE ai_service_configs
      SET verification_status = 'verified', verified_capabilities = ? WHERE id = ?`)
      .run(JSON.stringify({
        'nano-banana-2': withExternalModelEvidence('nano-banana-2', {
          supportsTextToImage: true,
          supportsImageReference: true,
          maxReferences: 6,
          resolutions: ['1k', '2k', '4k'],
        }),
      }), config.id);
    let posts = 0;
    global.fetch = async () => {
      posts += 1;
      return jsonResponse({ data: [{ url: 'https://cdn.example/must-not-submit.png' }] });
    };
    try {
      await assert.rejects(callImageApi(db, log, {
        model: 'nano-banana-2',
        prompt: 'must be priced',
        resolution: '2k',
        preferred_provider: 'usmercari_image',
        preferred_config_id: config.id,
      }, { evidenceRoots }), (error) => error.code === 'MODEL_PRICE_NOT_CONFIGURED');
      assert.equal(posts, 0);
    } finally {
      db.close();
    }
  });

  it('blocks a protected model from a non-USMercari override before provider I/O', async () => {
    const db = new Database(':memory:');
    runMigrationsAndEnsure(db);
    const config = aiConfigService.createConfig(db, log, {
      service_type: 'image',
      provider: 'openai',
      api_protocol: 'openai',
      name: '错误的同名图片配置',
      base_url: 'https://wrong-provider.example/v1',
      api_key: 'secret',
      model: ['nano-banana-2'],
      default_model: 'nano-banana-2',
      is_default: true,
      is_active: true,
    });
    db.prepare(`UPDATE ai_service_configs
      SET verification_status = 'verified', verified_capabilities = ? WHERE id = ?`)
      .run(JSON.stringify({
        'nano-banana-2': withExternalModelEvidence('nano-banana-2', {
          supportsTextToImage: true,
          supportsImageReference: true,
          maxReferences: 6,
          resolutions: ['1k', '2k', '4k'],
        }),
      }), config.id);
    modelPriceService.set(db, 'nano-banana-2', 70, {
      category: 'image',
      cost_unit: 'image',
      resolution_prices: {
        '1k': { credits: 70, cost_micros_per_unit: 80000 },
      },
    });
    let posts = 0;
    global.fetch = async () => {
      posts += 1;
      return jsonResponse({ data: [{ url: 'https://cdn.example/must-not-submit.png' }] });
    };
    try {
      await assert.rejects(callImageApi(db, log, {
        model: 'nano-banana-2',
        prompt: 'must stay on the reviewed provider',
        resolution: '1k',
        _imageConfigOverride: config,
      }, { evidenceRoots }), (error) => error.code === 'MODEL_PROTOCOL_MISMATCH');
      assert.equal(posts, 0);
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

    global.fetch = async () => jsonResponse({
      detail: { code: 'unsupported_resolution', message: '4K is not supported for this ratio' },
    }, 400);
    const structured = await callUsmercariImageApi({ api_key: 'secret' }, log, {
      model: 'nano-banana-2', prompt: 'x', resolution: '4k',
    });
    assert.match(structured.error, /unsupported_resolution/);
    assert.match(structured.error, /4K is not supported/);

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
