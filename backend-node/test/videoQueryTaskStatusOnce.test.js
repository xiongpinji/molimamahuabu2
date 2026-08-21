'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { queryVideoTaskStatusOnce } = require('../src/services/videoClient');

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
