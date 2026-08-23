const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeDjpsdBaseUrl,
  buildDjpsdVideoSubmitBody,
  parseDjpsdSubmitResponse,
  parseDjpsdPollResponse,
  formatDjpsdUnknownSubmitError,
} = require('../src/services/videoClient');

test('DJPSD 视频地址去掉误配的 OpenAI /v1 后缀', () => {
  assert.equal(normalizeDjpsdBaseUrl('https://shiping.djpsd.com/v1'), 'https://shiping.djpsd.com');
});

test('DJPSD 创建任务使用供应商要求的请求体并将 9 秒向上适配为 10 秒', () => {
  const body = buildDjpsdVideoSubmitBody('secret', {
    prompt: '镜头缓慢推进',
    aspect_ratio: '16:9',
    duration: 9,
  });

  assert.equal(body.api_key, 'secret');
  assert.equal(body.prompt, '镜头缓慢推进');
  assert.equal(body.task_type, 'video');
  assert.deepEqual(JSON.parse(body.extra_params), {
    ratio: '16:9',
    duration: 10,
    material_count: 0,
  });
});

test('DJPSD 创建响应能提取任务编号', () => {
  assert.equal(parseDjpsdSubmitResponse({ code: 200, data: { task_id: 123 } }), '123');
  assert.equal(parseDjpsdSubmitResponse({ code: 200, data: { id: 456 } }), '456');
});

test('DJPSD 查询响应区分完成、失败和处理中', () => {
  assert.deepEqual(parseDjpsdPollResponse({
    code: 200,
    data: { status: 'success', video_url: 'https://cdn.example/video.mp4' },
  }), { state: 'completed', videoUrl: 'https://cdn.example/video.mp4' });

  assert.deepEqual(parseDjpsdPollResponse({
    code: 200,
    data: { status: 'failed', error_message: '生成失败' },
  }), { state: 'failed', error: '生成失败' });

  assert.deepEqual(parseDjpsdPollResponse({
    code: 200,
    data: { status: 'processing' },
  }), { state: 'processing' });
});

test('DJPSD 创建请求连接中断明确提示结果未知和重复扣费风险', () => {
  const message = formatDjpsdUnknownSubmitError(new Error('fetch failed'));
  assert.match(message, /结果未知/);
  assert.match(message, /不要连续重试/);
  assert.match(message, /重复扣费/);
  assert.match(message, /fetch failed/);
});

test('DJPSD 轮询到期时返回状态未知而不是失败', async () => {
  const videoClient = require('../src/services/videoClient');
  const result = await videoClient.pollVideoTask(
    null,
    { info() {}, warn() {}, error() {} },
    1,
    '83047',
    { provider: 'djpsd', protocol: 'djpsd', base_url: 'https://shiping.djpsd.com', api_key: 'test' },
    0,
    0
  );
  assert.equal(result.indeterminate, true);
  assert.equal(result.provider_task_id, '83047');
  assert.match(result.error, /仍可能处理中/);
});
