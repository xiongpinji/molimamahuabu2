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
      expected: { state: 'unknown' },
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
  assert.deepEqual(result, { state: 'unknown' });
  assert.equal(requestOptions.redirect, 'manual');
  assert.equal(requestOptions.signal instanceof AbortSignal, true);
});
