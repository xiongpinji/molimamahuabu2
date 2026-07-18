const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildIcreatVideoBody,
  normalizeIcreatModel,
  callIcreatVideoApi,
  callVideoApi,
  pollVideoTask,
} = require('../src/services/videoClient');
const { testConnection } = require('../src/services/aiConfigService');

const log = { info() {}, warn() {}, error() {} };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe('iCreat Seedance video protocol', () => {
  it('normalizes the user-facing Mini model name to the documented capability code', () => {
    assert.equal(normalizeIcreatModel('Seedance 2.0 Mini'), 'bytedance/seedance-2-0-mini');
    assert.equal(normalizeIcreatModel('bytedance/seedance-2-0-fast'), 'bytedance/seedance-2-0-fast');
  });

  it('builds the documented content body with first and last frame roles', () => {
    const body = buildIcreatVideoBody({
      prompt: '母女在花园里慢慢走近镜头',
      duration: 2,
      aspect_ratio: '9:16',
      resolution: '1080p',
      first_frame_url: 'https://cdn.example/first.png',
      last_frame_url: 'https://cdn.example/last.png',
    });

    assert.deepEqual(body, {
      content: [
        { type: 'text', text: '母女在花园里慢慢走近镜头' },
        { type: 'image_url', image_url: { url: 'https://cdn.example/first.png' }, role: 'first_frame', need_review: true },
        { type: 'image_url', image_url: { url: 'https://cdn.example/last.png' }, role: 'last_frame', need_review: true },
      ],
      ratio: '9:16',
      resolution: '1080p',
      duration: 4,
    });
  });

  it('submits to the iCreat capability-code endpoint and returns the task id', async () => {
    let request;
    global.fetch = async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ taskId: 'icreat-task-1', status: 'SUBMITTED' }) };
    };

    const result = await callIcreatVideoApi({
      provider: 'icreat',
      api_protocol: 'icreat_task',
      base_url: 'https://zh.icreat.ai',
      api_key: 'secret',
      endpoint: '/v1/task/submit/{model}',
      settings: JSON.stringify({ icreat_group: 'default' }),
    }, log, { model: 'Seedance 2.0 Mini', prompt: 'test', duration: 5 });

    assert.equal(request.url, 'https://api.icreat.ai/v1/task/submit/bytedance/seedance-2-0-mini');
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers.Authorization, 'Bearer secret');
    assert.equal(request.options.headers['X-ICREAT-AI-GROUP'], 'default');
    assert.equal(request.body.content[0].text, 'test');
    assert.equal(request.body.duration, 5);
    assert.deepEqual(result, { task_id: 'icreat-task-1', status: 'SUBMITTED' });
  });

  it('polls status with POST and fetches the result only after SUCCEEDED', async () => {
    const requests = [];
    global.fetch = async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      if (requests.length === 1) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'SUCCEEDED' }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify([{ type: 'Video', url: 'https://cdn.example/result.mp4' }]) };
    };

    const result = await pollVideoTask(null, log, 1, 'icreat-task-1', {
      provider: 'icreat',
      api_protocol: 'icreat_task',
      base_url: 'https://api.icreat.ai',
      api_key: 'secret',
    }, 1, 0);

    assert.equal(requests[0].url, 'https://api.icreat.ai/v1/task/query-status');
    assert.deepEqual(requests[0].body, { task_id: 'icreat-task-1' });
    assert.equal(requests[1].url, 'https://api.icreat.ai/v1/task/get-result');
    assert.deepEqual(requests[1].body, { task_id: 'icreat-task-1' });
    assert.deepEqual(result, { video_url: 'https://cdn.example/result.mp4' });
  });

  it('preserves the provider failure detail instead of returning only FAILED', async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        status: 'FAILED',
        error_code: 'http_400',
        error_message: 'request failed with HTTP 400',
      }),
    });

    const result = await pollVideoTask(null, log, 1, 'icreat-task-failed', {
      provider: 'icreat',
      api_protocol: 'icreat_task',
      base_url: 'https://api.icreat.ai',
      api_key: 'secret',
    }, 1, 0);

    assert.equal(result.error, 'iCreat 任务失败或不存在: FAILED: request failed with HTTP 400');
  });

  it('routes an iCreat config through the production callVideoApi entry point', async () => {
    let requestedUrl = '';
    global.fetch = async (url) => {
      requestedUrl = url;
      return { ok: true, status: 200, text: async () => JSON.stringify({ taskId: 'icreat-routed-1' }) };
    };
    const row = {
      id: 9,
      service_type: 'video',
      provider: 'icreat',
      api_protocol: 'icreat_task',
      base_url: 'https://api.icreat.ai',
      api_key: 'secret',
      model: JSON.stringify(['bytedance/seedance-2-0-fast']),
      default_model: 'bytedance/seedance-2-0-fast',
      endpoint: '/v1/task/submit/{model}',
      query_endpoint: '/v1/task/query-status',
      settings: null,
      is_default: 1,
      is_active: 1,
    };
    const db = {
      prepare(sql) {
        return { all: () => sql.includes('SELECT * FROM ai_service_configs') ? [row] : [] };
      },
    };

    const result = await callVideoApi(db, log, { model: 'bytedance/seedance-2-0-fast', prompt: 'test' });

    assert.equal(requestedUrl, 'https://api.icreat.ai/v1/task/submit/bytedance/seedance-2-0-fast');
    assert.deepEqual(result, { task_id: 'icreat-routed-1', status: 'processing' });
  });
});

describe('iCreat read-only connectivity probe', () => {
  it('queries an unknown task instead of creating a billable video', async () => {
    let request;
    global.fetch = async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'NOT_FOUND' }) };
    };

    await testConnection({
      provider: 'icreat',
      service_type: 'video',
      api_protocol: 'icreat_task',
      base_url: 'https://zh.icreat.ai',
      api_key: 'secret',
    });

    assert.equal(request.url, 'https://api.icreat.ai/v1/task/query-status');
    assert.equal(request.options.method, 'POST');
    assert.deepEqual(request.body, { task_id: 'codex-connectivity-check' });
  });
});
