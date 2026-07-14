const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildKlingImageQueryUrl,
  parseKlingImagePollResult,
} = require('../src/services/imageClient');
const { resolveKlingBearerToken } = require('../src/services/klingJwt');

test('可灵图片轮询地址支持配置占位符与默认地址', () => {
  assert.equal(
    buildKlingImageQueryUrl('https://api.klingai.com', '/v1/images/generations', '/v1/images/generations/{taskId}', 'task 1'),
    'https://api.klingai.com/v1/images/generations/task%201'
  );
  assert.equal(
    buildKlingImageQueryUrl('https://api.klingai.com/', '/v1/images/generations', '', 'abc'),
    'https://api.klingai.com/v1/images/generations/abc'
  );
});

test('可灵图片轮询结果区分成功、失败和处理中', () => {
  assert.deepEqual(parseKlingImagePollResult({
    data: { task_status: 'succeed', task_result: { images: [{ url: 'https://img.example/a.jpg' }] } },
  }), { state: 'completed', imageUrl: 'https://img.example/a.jpg' });

  assert.deepEqual(parseKlingImagePollResult({
    data: { task_status: 'failed', task_status_msg: 'content risk' },
  }), { state: 'failed', error: 'content risk' });

  assert.deepEqual(parseKlingImagePollResult({ data: { task_status: 'processing' } }), {
    state: 'processing',
  });
});

test('可灵官方图片配置使用 AccessKey 和 SecretKey 生成 JWT', () => {
  assert.equal(typeof resolveKlingBearerToken, 'function');
  const token = resolveKlingBearerToken({
    settings: JSON.stringify({
      kling_access_key: 'test-access-key',
      kling_secret_key: 'test-secret-key',
    }),
  });
  const parts = token.split('.');
  assert.equal(parts.length, 3);
});
