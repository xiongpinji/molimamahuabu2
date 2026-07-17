const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  callDeepwlGrokVideoApi,
  callVideoApi,
  buildDeepwlGrokVideoBody,
  resolveDeepwlGrokMode,
  pollVideoTask,
} = require('../src/services/videoClient');
const { testConnection } = require('../src/services/aiConfigService');

const log = {
  info() {},
  warn() {},
  error() {},
};

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe('DeepWL Grok video protocol routing', () => {
  it('selects the protocol mode from explicit configuration and model names', () => {
    assert.equal(resolveDeepwlGrokMode({ api_protocol: 'deepwl_grok_unified' }, 'grok-video-3'), 'unified');
    assert.equal(resolveDeepwlGrokMode({ api_protocol: 'deepwl_grok_openai' }, 'grok-video-3'), 'openai');
    assert.equal(resolveDeepwlGrokMode({}, 'grok-imagine-video-1.5-preview'), 'imagine');
    assert.equal(resolveDeepwlGrokMode({}, 'grok-video-3-pro'), 'openai');
    assert.equal(resolveDeepwlGrokMode({ endpoint: '/v1/video/create' }, 'grok-video-3-pro'), 'unified');
  });

  it('builds the unified JSON body with first/last references and normalized duration', () => {
    const body = buildDeepwlGrokVideoBody({
      mode: 'unified',
      model: 'grok-video-3',
      prompt: 'a mother and child walk through a garden',
      duration: 12,
      aspect_ratio: '9:16',
      resolution: '1080p',
      images: ['data:image/png;base64,first', 'data:image/png;base64,last'],
    });

    assert.deepEqual(body, {
      model: 'grok-video-3',
      prompt: 'a mother and child walk through a garden',
      images: ['data:image/png;base64,first', 'data:image/png;base64,last'],
      aspect_ratio: '9:16',
      size: '1080P',
      duration: 15,
    });
  });

  it('builds Imagine JSON with a single image string', () => {
    const image = 'data:image/jpeg;base64,reference';
    const body = buildDeepwlGrokVideoBody({
      mode: 'imagine',
      model: 'grok-imagine-video',
      prompt: 'slow camera push in',
      duration: 6,
      aspect_ratio: '16:9',
      resolution: '480p',
      images: [image],
    });

    assert.equal(body.seconds, '6');
    assert.equal(body.resolution, '480P');
    assert.equal(body.image, image);
    assert.equal(body.images, undefined);
  });

  it('uses DeepWL unified API default duration when the caller omits duration', () => {
    const body = buildDeepwlGrokVideoBody({ mode: 'unified', model: 'grok-video-3', prompt: 'test' });
    assert.equal(body.duration, 10);
  });

  it('submits the unified DeepWL endpoint and returns the async task id', async () => {
    let request;
    global.fetch = async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'grok:unified-1', status: 'processing' }) };
    };

    const result = await callDeepwlGrokVideoApi({
      provider: 'deepwl',
      api_protocol: 'deepwl_grok_unified',
      base_url: 'https://zx1.deepwl.net',
      api_key: 'secret',
    }, log, {
      model: 'grok-video-3',
      prompt: 'test',
      duration: 10,
      aspect_ratio: '16:9',
      resolution: '720p',
    });

    assert.equal(request.url, 'https://zx1.deepwl.net/v1/video/create');
    assert.equal(request.options.headers.Authorization, 'Bearer secret');
    assert.equal(request.body.model, 'grok-video-3');
    assert.equal(request.body.duration, 10);
    assert.deepEqual(result, { task_id: 'grok:unified-1', status: 'processing' });
  });

  it('submits Imagine models as JSON to the shared /v1/videos endpoint', async () => {
    let request;
    global.fetch = async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'grok:imagine-1' }) };
    };

    const result = await callDeepwlGrokVideoApi({
      provider: 'deepwl',
      base_url: 'https://zx1.deepwl.net',
      api_key: 'secret',
    }, log, {
      model: 'grok-imagine-video-1.5-preview',
      prompt: 'test',
      duration: 8,
      aspect_ratio: '16:9',
      resolution: '720p',
    });

    assert.equal(request.url, 'https://zx1.deepwl.net/v1/videos');
    assert.equal(request.options.headers['Content-Type'], 'application/json');
    assert.equal(request.body.seconds, '8');
    assert.equal(request.body.resolution, '720P');
    assert.deepEqual(result, { task_id: 'grok:imagine-1', status: 'processing' });
  });

  it('submits the OpenAI-compatible multipart endpoint for Grok video models', async () => {
    let request;
    global.fetch = async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'grok:openai-1', status: 'queued' }) };
    };

    const result = await callDeepwlGrokVideoApi({
      provider: 'deepwl',
      api_protocol: 'deepwl_grok_openai',
      base_url: 'https://zx1.deepwl.net',
      api_key: 'secret',
    }, log, {
      model: 'grok-video-3-pro',
      prompt: 'test',
      duration: 10,
      aspect_ratio: '16:9',
      resolution: '720p',
    });

    assert.equal(request.url, 'https://zx1.deepwl.net/v1/videos');
    assert.equal(request.options.headers.Authorization, 'Bearer secret');
    assert.equal(request.options.body.get('model'), 'grok-video-3-pro');
    assert.equal(request.options.body.get('seconds'), '10');
    assert.deepEqual(result, { task_id: 'grok:openai-1', status: 'queued' });
  });

  it('forces the dedicated Grok 1.5 15-second model to 15 seconds', async () => {
    let request;
    global.fetch = async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'grok:15s-1', status: 'queued' }) };
    };

    await callDeepwlGrokVideoApi({
      provider: 'deepwl',
      api_protocol: 'deepwl_grok_openai',
      base_url: 'https://zx1.deepwl.net',
      api_key: 'secret',
    }, log, {
      model: 'grok-1.5-video-15s',
      prompt: 'test',
      duration: 5,
    });

    assert.equal(request.options.body.get('model'), 'grok-1.5-video-15s');
    assert.equal(request.options.body.get('seconds'), '15');
  });

  it('rejects overlong Imagine prompts before making a paid request', async () => {
    let called = false;
    global.fetch = async () => {
      called = true;
      return { ok: true, status: 200, text: async () => '{}' };
    };
    const result = await callDeepwlGrokVideoApi({
      provider: 'deepwl',
      api_protocol: 'deepwl_grok_imagine',
      base_url: 'https://zx1.deepwl.net',
      api_key: 'secret',
    }, log, { model: 'grok-imagine-video', prompt: 'x'.repeat(4097) });
    assert.match(result.error, /4096/);
    assert.equal(called, false);
  });

  it('routes a deepwl provider through the production callVideoApi entry point', async () => {
    let requestedUrl = '';
    global.fetch = async (url) => {
      requestedUrl = url;
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'grok:routed-1' }) };
    };
    const row = {
      id: 7,
      service_type: 'video',
      provider: 'deepwl',
      api_protocol: '',
      name: 'DeepWL',
      base_url: 'https://zx1.deepwl.net',
      api_key: 'secret',
      model: JSON.stringify(['grok-video-3']),
      default_model: 'grok-video-3',
      endpoint: '',
      query_endpoint: '',
      priority: 0,
      is_default: 1,
      is_active: 1,
      settings: null,
    };
    const db = {
      prepare(sql) {
        return {
          all: () => sql.includes('SELECT * FROM ai_service_configs') ? [row] : [],
        };
      },
    };

    const result = await callVideoApi(db, log, { model: 'grok-video-3', prompt: 'test' });

    assert.equal(requestedUrl, 'https://zx1.deepwl.net/v1/videos');
    assert.deepEqual(result, { task_id: 'grok:routed-1', status: 'processing' });
  });
});

describe('DeepWL Grok video polling', () => {
  it('queries the unified endpoint with an encoded task id and returns output.url', async () => {
    let requestedUrl = '';
    global.fetch = async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 'completed', output: { url: 'https://cdn.example/video.mp4' } }),
      };
    };

    const result = await pollVideoTask(null, log, 1, 'grok:test', {
      provider: 'deepwl',
      api_protocol: 'deepwl_grok_unified',
      base_url: 'https://zx1.deepwl.net',
      api_key: 'secret',
    }, 1, 0);

    assert.equal(requestedUrl, 'https://zx1.deepwl.net/v1/video/query?id=grok%3Atest');
    assert.deepEqual(result, { video_url: 'https://cdn.example/video.mp4' });
  });

  it('uses the OpenAI-compatible query path for Grok video models even with the unified default query setting', async () => {
    let requestedUrl = '';
    global.fetch = async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 'completed', video_url: 'https://cdn.example/video.mp4' }),
      };
    };

    const result = await pollVideoTask(null, log, 1, 'grok:openai', {
      provider: 'deepwl',
      api_protocol: 'deepwl_grok_openai',
      base_url: 'https://zx1.deepwl.net',
      api_key: 'secret',
      query_endpoint: '/v1/video/query?id={taskId}',
    }, 1, 0);

    assert.equal(requestedUrl, 'https://zx1.deepwl.net/v1/videos/grok%3Aopenai');
    assert.deepEqual(result, { video_url: 'https://cdn.example/video.mp4' });
  });

  it('falls back to the DeepWL content endpoint when a completed task has no URL', async () => {
    const requested = [];
    global.fetch = async (url) => {
      requested.push(url);
      if (requested.length === 1) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ status: 'completed' }),
        };
      }
      return {
        ok: true,
        status: 200,
        url: 'https://cdn.example/signed-video.mp4',
        headers: { get: () => null },
        text: async () => '',
      };
    };

    const result = await pollVideoTask(null, log, 1, 'grok:content', {
      provider: 'deepwl',
      api_protocol: 'deepwl_grok_openai',
      base_url: 'https://zx1.deepwl.net',
      api_key: 'secret',
    }, 1, 0);

    assert.equal(requested[1], 'https://zx1.deepwl.net/v1/videos/grok%3Acontent/content');
    assert.deepEqual(result, { video_url: 'https://cdn.example/signed-video.mp4' });
  });
});

describe('DeepWL Grok connectivity probe', () => {
  it('uses the read-only query endpoint instead of chat/completions', async () => {
    let request;
    global.fetch = async (url, options) => {
      request = { url, options };
      return { ok: false, status: 404, text: async () => JSON.stringify({ message: 'task not found' }) };
    };

    await testConnection({
      provider: 'deepwl',
      service_type: 'video',
      api_protocol: 'deepwl_grok_openai',
      base_url: 'https://zx1.deepwl.net',
      api_key: 'secret',
    });

    assert.equal(request.url, 'https://zx1.deepwl.net/v1/videos/codex-connectivity-check');
    assert.equal(request.options.method, 'GET');
    assert.equal(request.options.headers.Authorization, 'Bearer secret');
  });
});
