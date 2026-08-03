const test = require('node:test');
const assert = require('node:assert/strict');

const imageClient = require('../src/services/imageClient');

const temporaryUnavailable = {
  statusCode: 503,
  raw: JSON.stringify({
    error: {
      message: 'provider temporary unavailable',
      type: 'bad_response_status_code',
      code: 'bad_response_status_code',
    },
  }),
};

test('图片供应商明确返回 temporary unavailable 时有限重试并复用原请求', async () => {
  const responses = [
    temporaryUnavailable,
    temporaryUnavailable,
    { statusCode: 200, raw: JSON.stringify({ data: [{ url: 'https://example.test/result.jpg' }] }) },
  ];
  const requests = [];
  const delays = [];

  const result = await imageClient.postOpenAIImageJSONWithRetry(
    'https://provider.example/v1/images/generations',
    { Authorization: 'Bearer test' },
    { model: 'gpt-image-2-2k', prompt: 'test prompt' },
    1_000,
    {
      request: async (...args) => {
        requests.push(args);
        return responses.shift();
      },
      sleep: async (delay) => delays.push(delay),
      retryDelays: [2, 5],
    },
  );

  assert.equal(result.statusCode, 200);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map((args) => args[2]), [
    { model: 'gpt-image-2-2k', prompt: 'test prompt' },
    { model: 'gpt-image-2-2k', prompt: 'test prompt' },
    { model: 'gpt-image-2-2k', prompt: 'test prompt' },
  ]);
  assert.deepEqual(delays, [2, 5]);
});

test('其他 503 不自动重放 POST，避免未知受理状态下重复扣费', async () => {
  let requestCount = 0;

  const result = await imageClient.postOpenAIImageJSONWithRetry(
    'https://provider.example/v1/images/generations',
    {},
    { prompt: 'test prompt' },
    1_000,
    {
      request: async () => {
        requestCount += 1;
        return { statusCode: 503, raw: '{"error":{"message":"gateway timeout"}}' };
      },
      sleep: async () => {
        throw new Error('不应等待重试');
      },
      retryDelays: [2, 5],
    },
  );

  assert.equal(result.statusCode, 503);
  assert.equal(requestCount, 1);
});

test('temporary unavailable 最终失败时返回可理解的中文提示', () => {
  assert.equal(
    imageClient.formatImageHttpError(503, temporaryUnavailable.raw),
    '图片生成服务暂时繁忙，自动重试后仍不可用，请稍后再试',
  );
});
