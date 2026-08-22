'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { pollVideoTask, queryVideoTaskStatusOnce } = require('../src/services/videoClient');

const log = { info() {}, warn() {}, error() {} };

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

test('单次任务查询对会二次取结果的协议严格只发一个网络请求', async () => {
  const cases = [
    {
      name: 'AIHubCC',
      config: {
        provider: 'aihubcc',
        api_protocol: 'aihubcc',
        base_url: 'https://relay.invalid/v1',
        api_key: 'test-key',
        query_endpoint: '/videos/{taskId}',
      },
      payload: { status: 'completed' },
    },
    {
      name: 'DeepWL',
      config: {
        provider: 'deepwl',
        api_protocol: 'deepwl_grok_openai',
        base_url: 'https://relay.invalid',
        api_key: 'test-key',
      },
      payload: { status: 'completed' },
    },
    {
      name: 'iCreat',
      config: {
        provider: 'icreat',
        api_protocol: 'icreat_task',
        base_url: 'https://relay.invalid',
        api_key: 'test-key',
      },
      payload: { status: 'SUCCEEDED' },
    },
  ];

  for (const scenario of cases) {
    let requests = 0;
    const result = await queryVideoTaskStatusOnce(
      null,
      log,
      'saved-task-id',
      scenario.config,
      {
        async fetchImpl() {
          requests += 1;
          if (requests > 1) throw new Error(`${scenario.name} attempted a second request`);
          return jsonResponse(scenario.payload);
        },
      },
    );
    assert.deepEqual(result, { state: 'artifact_unreadable' }, scenario.name);
    assert.equal(requests, 1, scenario.name);
  }
});

test('所有单响应异步视频协议完成但无可信产物时都归为产物不可读', async (t) => {
  const config = (provider, apiProtocol, baseUrl = 'https://relay.invalid/v1') => ({
    provider,
    api_protocol: apiProtocol,
    base_url: baseUrl,
    api_key: 'test-key',
  });
  const cases = [
    {
      name: 'ToAPIs',
      config: config('toapis', 'toapis_video', 'https://toapis.com'),
      payload: { status: 'completed', result: { data: [] } },
    },
    {
      name: 'DJPSD legacy',
      config: config('djpsd', 'djpsd', 'https://relay.invalid'),
      payload: { code: 200, data: { status: 'completed' } },
    },
    {
      name: 'DJPSD OpenAPI',
      config: config('djpsd_openapi', 'djpsd_openapi'),
      payload: { data: { state: 'completed' } },
    },
    ...['success', 'succeeded', 'completed', 'done'].map((status) => ({
      name: `Feituo ${status}`,
      config: config('feituo', 'feituo_open'),
      payload: { status },
    })),
    {
      name: 'USMercari SUCCESS',
      config: config('usmercari', 'usmercari_media'),
      payload: { data: [{ task_id: 'saved-task-id', status: 'SUCCESS', data: { items: [] } }] },
    },
    {
      name: 'Token6688',
      config: config('token6688', 'token6688'),
      payload: { status: 'completed', result: { videos: [] } },
    },
    ...['success', 'succeeded', 'completed', 'done'].map((status) => ({
      name: `Fumin ${status}`,
      config: config('fumin', 'fumin_video'),
      payload: { status },
    })),
    {
      name: 'DeepWL Grok',
      config: config('deepwl', 'deepwl_grok'),
      payload: { status: 'completed' },
    },
    {
      name: 'AIHubCC',
      config: { ...config('aihubcc', 'aihubcc'), query_endpoint: '/videos/{taskId}' },
      payload: { status: 'completed' },
    },
    {
      name: 'iCreat',
      config: config('icreat', 'icreat_task'),
      payload: { status: 'SUCCEEDED' },
    },
    {
      name: 'Kling',
      config: config('kling', 'kling'),
      payload: { code: 0, data: { task_status: 'succeed', task_result: { videos: [] } } },
    },
    {
      name: 'Kling Omni',
      config: config('ffir', 'kling_omni'),
      payload: { code: 0, data: { task_status: 'completed' } },
    },
    {
      name: 'Veo3',
      config: config('custom', 'veo3'),
      payload: { status: 'completed' },
    },
    {
      name: 'Sora',
      config: config('custom', 'sora'),
      payload: { status: 'completed' },
    },
    {
      name: 'Agnes',
      config: config('agnes', 'agnes'),
      payload: { status: 'completed' },
    },
    {
      name: 'Vidu',
      config: config('vidu', 'vidu'),
      payload: { state: 'success', creations: [] },
    },
    {
      name: 'Gemini',
      config: config('gemini', 'gemini'),
      payload: { done: true },
    },
    {
      name: 'DashScope',
      config: config('dashscope', 'dashscope'),
      payload: { output: { task_status: 'SUCCEEDED' } },
    },
    {
      name: 'Volcengine',
      config: config('volcengine', 'volcengine'),
      payload: { status: 'completed' },
    },
    {
      name: 'Volcengine Omni',
      config: config('custom', 'volcengine_omni'),
      payload: { status: 'completed' },
    },
    {
      name: 'OpenAI-compatible',
      config: config('custom', 'openai'),
      payload: { status: 'completed' },
    },
    {
      name: 'xAI',
      config: config('xai', 'xai'),
      payload: { status: 'completed' },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      let requests = 0;
      const result = await queryVideoTaskStatusOnce(null, log, 'saved-task-id', scenario.config, {
        async fetchImpl() {
          requests += 1;
          return jsonResponse(scenario.payload);
        },
      });
      assert.deepEqual(result, { state: 'artifact_unreadable' });
      assert.equal(requests, 1);
    });
  }
});

test('Feituo、USMercari 和 Fumin 显式失败才归为供应商任务失败', async (t) => {
  const cases = [
    ...['failed', 'error', 'cancelled'].map((status) => ({
      name: `Feituo ${status}`,
      config: { provider: 'feituo', api_protocol: 'feituo_open' },
      payload: { status, errorMessage: 'provider detail must stay internal' },
    })),
    {
      name: 'USMercari FAILURE',
      config: { provider: 'usmercari', api_protocol: 'usmercari_media' },
      payload: {
        data: [{
          task_id: 'saved-task-id',
          status: 'FAILURE',
          fail_reason: 'provider detail must stay internal',
        }],
      },
    },
    ...['failed', 'error', 'cancelled'].map((status) => ({
      name: `Fumin ${status}`,
      config: { provider: 'fumin', api_protocol: 'fumin_video' },
      payload: { status, error: { message: 'provider detail must stay internal' } },
    })),
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      let requests = 0;
      const result = await queryVideoTaskStatusOnce(null, log, 'saved-task-id', {
        ...scenario.config,
        base_url: 'https://relay.invalid/v1',
        api_key: 'test-key',
      }, {
        async fetchImpl() {
          requests += 1;
          return jsonResponse(scenario.payload);
        },
      });
      assert.deepEqual(result, { state: 'failed', category: 'provider_task_failed' });
      assert.equal(requests, 1);
      assert.doesNotMatch(JSON.stringify(result), /provider detail/);
    });
  }
});

test('普通轮询保留新增 strict 分类协议的旧完成无产物行为', async (t) => {
  const cases = [
    {
      name: 'ToAPIs',
      config: { provider: 'toapis', api_protocol: 'toapis_video' },
      baseUrl: 'https://toapis.com',
      payload: { status: 'completed', result: { data: [] } },
      error: 'ToAPIs 任务完成但未返回视频地址',
    },
    {
      name: 'Feituo',
      config: { provider: 'feituo', api_protocol: 'feituo_open' },
      payload: { status: 'completed' },
      error: '飞拓任务完成但未返回视频地址',
    },
    {
      name: 'USMercari',
      config: { provider: 'usmercari', api_protocol: 'usmercari_media' },
      payload: { data: [{ task_id: 'saved-task-id', status: 'SUCCESS', data: { items: [] } }] },
      error: 'USMercari 任务完成但未返回视频地址',
    },
    {
      name: 'Fumin',
      config: { provider: 'fumin', api_protocol: 'fumin_video' },
      payload: { status: 'completed' },
      error: 'fumin 任务已完成但未返回视频地址',
    },
    {
      name: 'DashScope',
      config: { provider: 'dashscope', api_protocol: 'dashscope' },
      payload: { output: { task_status: 'SUCCEEDED' } },
      indeterminate: true,
    },
    {
      name: 'OpenAI-compatible',
      config: { provider: 'custom', api_protocol: 'openai' },
      payload: { status: 'completed' },
      indeterminate: true,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      let requests = 0;
      const result = await pollVideoTask(null, log, null, 'saved-task-id', {
        ...scenario.config,
        base_url: scenario.baseUrl || 'https://relay.invalid/v1',
        api_key: 'test-key',
      }, 1, 0, {
        async fetchImpl() {
          requests += 1;
          return jsonResponse(scenario.payload);
        },
      });
      if (scenario.error) assert.deepEqual(result, { error: scenario.error });
      else assert.equal(result.indeterminate, scenario.indeterminate);
      assert.equal(requests, 1);
    });
  }
});

test('旧版 DJPSD 完成但无视频时严格单次查询保持产物不可读', async (t) => {
  for (const status of ['success', 'succeeded', 'completed']) {
    await t.test(status, async () => {
      let requests = 0;
      const result = await queryVideoTaskStatusOnce(null, log, 'saved-task-id', {
        provider: 'djpsd',
        api_protocol: 'djpsd',
        base_url: 'https://relay.invalid',
        api_key: 'test-key',
      }, {
        async fetchImpl() {
          requests += 1;
          return jsonResponse({ code: 200, data: { status } });
        },
      });
      assert.deepEqual(result, { state: 'artifact_unreadable' });
      assert.equal(requests, 1);
    });
  }
});

test('旧版 DJPSD 显式失败仍是供应商任务失败', async (t) => {
  for (const status of ['failed', 'error']) {
    await t.test(status, async () => {
      let requests = 0;
      const result = await queryVideoTaskStatusOnce(null, log, 'saved-task-id', {
        provider: 'djpsd',
        api_protocol: 'djpsd',
        base_url: 'https://relay.invalid',
        api_key: 'test-key',
      }, {
        async fetchImpl() {
          requests += 1;
          return jsonResponse({
            code: 200,
            data: { status, error_message: 'provider detail must stay internal' },
          });
        },
      });
      assert.deepEqual(result, { state: 'failed', category: 'provider_task_failed' });
      assert.equal(requests, 1);
      assert.doesNotMatch(JSON.stringify(result), /provider detail/);
    });
  }
});

test('普通轮询保留旧版 DJPSD 完成无视频的旧错误行为', async () => {
  let requests = 0;
  const result = await pollVideoTask(null, log, null, 'saved-task-id', {
    provider: 'djpsd',
    api_protocol: 'djpsd',
    base_url: 'https://relay.invalid',
    api_key: 'test-key',
  }, 1, 0, {
    async fetchImpl() {
      requests += 1;
      return jsonResponse({ code: 200, data: { status: 'completed' } });
    },
  });
  assert.deepEqual(result, { error: '任务已完成但未返回视频地址' });
  assert.equal(requests, 1);
});

test('DJPSD OpenAPI 和 Token6688 完成但无视频时只查询一次并保持产物不可读', async (t) => {
  const cases = [
    {
      name: 'DJPSD OpenAPI completed without URL',
      config: {
        provider: 'djpsd_openapi',
        api_protocol: 'djpsd_openapi',
        base_url: 'https://relay.invalid/openapi',
        api_key: 'test-key',
      },
      payload: { data: { state: 'completed' } },
    },
    {
      name: 'DJPSD OpenAPI non-video result',
      config: {
        provider: 'djpsd_openapi',
        api_protocol: 'djpsd_openapi',
        base_url: 'https://relay.invalid/openapi',
        api_key: 'test-key',
      },
      payload: {
        data: {
          state: 'completed',
          result_type: 'image',
          url: 'https://cdn.invalid/result.png',
        },
      },
    },
    {
      name: 'Token6688 completed without URL',
      config: {
        provider: 'token6688',
        api_protocol: 'token6688',
        base_url: 'https://relay.invalid/v1',
        api_key: 'test-key',
      },
      payload: { status: 'completed', result: { videos: [] } },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      let requests = 0;
      const result = await queryVideoTaskStatusOnce(null, log, 'saved-task-id', scenario.config, {
        async fetchImpl() {
          requests += 1;
          return jsonResponse(scenario.payload);
        },
      });
      assert.deepEqual(result, { state: 'artifact_unreadable' }, scenario.name);
      assert.equal(requests, 1, scenario.name);
    });
  }
});

test('DJPSD OpenAPI 和 Token6688 的显式失败仍是供应商任务失败', async () => {
  const cases = [
    {
      config: {
        provider: 'djpsd_openapi', api_protocol: 'djpsd_openapi',
        base_url: 'https://relay.invalid/openapi', api_key: 'test-key',
      },
      payload: { data: { state: 'failed', message: 'provider detail must stay internal' } },
    },
    {
      config: {
        provider: 'token6688', api_protocol: 'token6688',
        base_url: 'https://relay.invalid/v1', api_key: 'test-key',
      },
      payload: { status: 'failed', error: { message: 'provider detail must stay internal' } },
    },
  ];

  for (const scenario of cases) {
    let requests = 0;
    const result = await queryVideoTaskStatusOnce(null, log, 'saved-task-id', scenario.config, {
      async fetchImpl() {
        requests += 1;
        return jsonResponse(scenario.payload);
      },
    });
    assert.deepEqual(result, { state: 'failed', category: 'provider_task_failed' });
    assert.equal(requests, 1);
    assert.doesNotMatch(JSON.stringify(result), /provider detail/);
  }
});

test('普通轮询保留 DJPSD OpenAPI 和 Token6688 完成无视频的旧错误行为', async () => {
  const cases = [
    {
      config: {
        provider: 'djpsd_openapi', api_protocol: 'djpsd_openapi',
        base_url: 'https://relay.invalid/openapi', api_key: 'test-key',
      },
      payload: { data: { state: 'completed' } },
      error: 'DJPSD 开放 API 任务已结束但未返回视频地址',
    },
    {
      config: {
        provider: 'token6688', api_protocol: 'token6688',
        base_url: 'https://relay.invalid/v1', api_key: 'test-key',
      },
      payload: { status: 'completed', result: { videos: [] } },
      error: 'Token6688 任务完成但未返回可下载的视频地址',
    },
  ];

  for (const scenario of cases) {
    let requests = 0;
    const result = await pollVideoTask(null, log, null, 'saved-task-id', scenario.config, 1, 0, {
      async fetchImpl() {
        requests += 1;
        return jsonResponse(scenario.payload);
      },
    });
    assert.deepEqual(result, { error: scenario.error });
    assert.equal(requests, 1);
  }
});

test('单次任务查询复用现有解析并区分成功、明确失败和仍处理中', async () => {
  const baseConfig = {
    provider: 'aihubcc',
    api_protocol: 'aihubcc',
    base_url: 'https://relay.invalid/v1',
    api_key: 'test-key',
    query_endpoint: '/videos/{taskId}',
  };
  for (const scenario of [
    {
      payload: { status: 'completed', video_url: 'https://cdn.invalid/result.mp4' },
      expected: { state: 'succeeded', artifactUrl: 'https://cdn.invalid/result.mp4' },
    },
    {
      payload: { status: 'failed', error: { message: 'provider detail must stay internal' } },
      expected: { state: 'failed', category: 'provider_task_failed' },
    },
    {
      payload: { status: 'processing' },
      expected: { state: 'unknown', category: 'result_unknown' },
    },
  ]) {
    let requests = 0;
    const result = await queryVideoTaskStatusOnce(null, log, 'saved-task-id', baseConfig, {
      async fetchImpl() {
        requests += 1;
        return jsonResponse(scenario.payload);
      },
    });
    assert.deepEqual(result, scenario.expected);
    assert.equal(requests, 1);
    assert.equal(JSON.stringify(result).includes('provider detail'), false);
  }
});

test('单次任务查询禁止自动跟随重定向且设置请求超时信号', async () => {
  let requestOptions;
  const result = await queryVideoTaskStatusOnce(null, log, 'saved-task-id', {
    provider: 'aihubcc',
    api_protocol: 'aihubcc',
    base_url: 'https://relay.invalid/v1',
    api_key: 'test-key',
    query_endpoint: '/videos/{taskId}',
  }, {
    async fetchImpl(_url, options) {
      requestOptions = options;
      return jsonResponse({ status: 'processing' });
    },
  });
  assert.deepEqual(result, { state: 'unknown', category: 'result_unknown' });
  assert.equal(requestOptions.redirect, 'manual');
  assert.equal(requestOptions.signal instanceof AbortSignal, true);
});

test('单次任务查询把上游 HTTP 状态归为安全查询故障而不伪造任务失败', async () => {
  const logEntries = [];
  const capturingLog = {
    info(...args) { logEntries.push(args); },
    warn(...args) { logEntries.push(args); },
    error(...args) { logEntries.push(args); },
  };
  const cases = [
    [302, 'validation_error'],
    [400, 'validation_error'],
    [401, 'auth_unavailable'],
    [403, 'forbidden_unknown'],
    [404, 'result_unknown'],
    [408, 'result_unknown'],
    [429, 'rate_limited'],
    [503, 'provider_unavailable'],
  ];
  for (const [status, category] of cases) {
    const result = await queryVideoTaskStatusOnce(null, capturingLog, 'saved-task-id', {
      provider: 'aihubcc',
      api_protocol: 'aihubcc',
      base_url: 'https://relay.invalid/v1',
      api_key: 'test-key',
      query_endpoint: '/videos/{taskId}',
    }, {
      async fetchImpl() {
        return jsonResponse({
          error: { message: 'raw provider response Authorization Bearer secret' },
        }, status);
      },
    });
    assert.deepEqual(result, { state: 'query_failed', category }, String(status));
    assert.equal(JSON.stringify(result).includes('Bearer secret'), false);
  }
  assert.deepEqual(logEntries, []);
});

test('单次任务查询仅把超时或处理中归 unknown 并保留安全 result_unknown 分类', async () => {
  const config = {
    provider: 'aihubcc',
    api_protocol: 'aihubcc',
    base_url: 'https://relay.invalid/v1',
    api_key: 'test-key',
    query_endpoint: '/videos/{taskId}',
  };
  const timeout = new Error('raw timeout target must not leak');
  timeout.name = 'TimeoutError';
  const timedOut = await queryVideoTaskStatusOnce(null, log, 'saved-task-id', config, {
    async fetchImpl() { throw timeout; },
  });
  assert.deepEqual(timedOut, { state: 'unknown', category: 'result_unknown' });
  const processing = await queryVideoTaskStatusOnce(null, log, 'saved-task-id', config, {
    async fetchImpl() { return jsonResponse({ status: 'processing' }); },
  });
  assert.deepEqual(processing, { state: 'unknown', category: 'result_unknown' });
});

test('单次任务查询安全区分非法 URL、非 JSON、协议异常与请求次数门禁', async () => {
  const invalidUrl = await queryVideoTaskStatusOnce(null, log, 'saved-task-id', {
    provider: 'aihubcc',
    api_protocol: 'aihubcc',
    base_url: 'not a valid URL',
    api_key: 'test-key',
    query_endpoint: '/videos/{taskId}',
  }, { async fetchImpl() { throw new Error('must not fetch'); } });
  assert.deepEqual(invalidUrl, { state: 'query_failed', category: 'validation_error' });

  const nonJson = await queryVideoTaskStatusOnce(null, log, 'saved-task-id', {
    provider: 'aihubcc',
    api_protocol: 'aihubcc',
    base_url: 'https://relay.invalid/v1',
    api_key: 'test-key',
    query_endpoint: '/videos/{taskId}',
  }, {
    async fetchImpl() {
      return { ok: true, status: 200, text: async () => '<html>secret upstream response</html>' };
    },
  });
  assert.deepEqual(nonJson, { state: 'query_failed', category: 'query_protocol_error' });

  for (const code of ['PROVIDER_QUERY_REQUEST_LIMIT', 'PROVIDER_QUERY_PROTOCOL_ERROR']) {
    const result = await queryVideoTaskStatusOnce(null, log, 'saved-task-id', {
      provider: 'aihubcc',
      api_protocol: 'aihubcc',
      base_url: 'https://relay.invalid/v1',
      api_key: 'test-key',
      query_endpoint: '/videos/{taskId}',
    }, {
      async fetchImpl() {
        return {
          ok: true,
          status: 200,
          async text() {
            const error = new Error('raw internal error must not leak');
            error.code = code;
            throw error;
          },
        };
      },
    });
    assert.deepEqual(result, {
      state: 'query_failed',
      category: code === 'PROVIDER_QUERY_REQUEST_LIMIT'
        ? 'query_request_limit'
        : 'query_protocol_error',
    });
  }

  const genericParserFailure = await queryVideoTaskStatusOnce(null, log, 'saved-task-id', {
    provider: 'aihubcc',
    api_protocol: 'aihubcc',
    base_url: 'https://relay.invalid/v1',
    api_key: 'test-key',
    query_endpoint: '/videos/{taskId}',
  }, {
    async fetchImpl() {
      return {
        ok: true,
        status: 200,
        async text() { throw new TypeError('raw parser implementation detail'); },
      };
    },
  });
  assert.deepEqual(genericParserFailure, {
    state: 'query_failed',
    category: 'query_protocol_error',
  });
});

test('单次任务查询只接受可信 HTTP 产物 URL', async () => {
  const result = await queryVideoTaskStatusOnce(null, log, 'saved-task-id', {
    provider: 'aihubcc',
    api_protocol: 'aihubcc',
    base_url: 'https://relay.invalid/v1',
    api_key: 'test-key',
    query_endpoint: '/videos/{taskId}',
  }, {
    async fetchImpl() {
      return jsonResponse({ status: 'completed', video_url: 'file:///private/result.mp4' });
    },
  });
  assert.deepEqual(result, { state: 'artifact_unreadable' });
});
