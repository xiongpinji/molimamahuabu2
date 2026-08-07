const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TOAPIS_VIDEO_MODELS,
  buildToapisVideoBody,
  callToapisVideoApi,
  fetchToapisTask,
  normalizeToapisBaseUrl,
  parseToapisTask,
  parseToapisVideoStatus,
  validateToapisVideoOptions,
} = require('../src/services/toapisVideoClient');

test('ToAPIs 视频模型能力按模型分别限制分辨率、时长和参考素材数量', () => {
  assert.deepEqual(TOAPIS_VIDEO_MODELS['seedance-2-fast'].resolutions, ['480p', '720p']);
  assert.deepEqual(TOAPIS_VIDEO_MODELS['seedance-2-mini'].resolutions, ['480p', '720p']);
  assert.deepEqual(TOAPIS_VIDEO_MODELS['seedance-2-fast'].durations, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.deepEqual(TOAPIS_VIDEO_MODELS['seedance-2-mini'].durations, [4, 8, 10, 12, 15]);
  assert.equal(TOAPIS_VIDEO_MODELS['seedance-2-fast'].maxReferences, 1);
  assert.equal(TOAPIS_VIDEO_MODELS['seedance-2-fast'].maxVideoReferences, 1);
  assert.equal(TOAPIS_VIDEO_MODELS['seedance-2-fast'].maxAudioReferences, 1);
  assert.equal(TOAPIS_VIDEO_MODELS['seedance-2-mini'].maxReferences, 9);
  assert.equal(TOAPIS_VIDEO_MODELS['seedance-2-mini'].maxVideoReferences, 3);
  assert.equal(TOAPIS_VIDEO_MODELS['seedance-2-mini'].maxAudioReferences, 3);

  assert.throws(
    () => validateToapisVideoOptions({ model: 'seedance-2-fast', resolution: '1080p', duration: 4, prompt: 'x' }),
    /不支持 1080p/,
  );
  assert.throws(
    () => validateToapisVideoOptions({ model: 'seedance-2-mini', resolution: '480p', duration: 5, prompt: 'x' }),
    /不支持 5 秒/,
  );
  assert.throws(
    () => validateToapisVideoOptions({
      model: 'seedance-2-fast',
      resolution: '480p',
      duration: 4,
      prompt: 'x',
      reference_urls: ['https://moli.example/a.png', 'https://moli.example/b.png'],
    }),
    /最多支持 1 张参考图/,
  );
});

test('ToAPIs 请求体生成官方 roles，默认不生成音频，并 enforcing 首尾帧与多模态互斥', () => {
  const body = buildToapisVideoBody({
    model: 'seedance-2-mini',
    prompt: '森林镜头',
    resolution: '720p',
    duration: 8,
    aspect_ratio: '16:9',
    client_business_id: 'biz-1',
    reference_urls: ['https://moli.example/a.png'],
    reference_video_urls: ['https://moli.example/a.mp4'],
    reference_audio_urls: ['https://moli.example/a.mp3'],
  });

  assert.deepEqual(body, {
    model: 'seedance-2-mini',
    prompt: '森林镜头',
    duration: 8,
    aspect_ratio: '16:9',
    resolution: '720p',
    generate_audio: false,
    client_business_id: 'biz-1',
    image_with_roles: [{ url: 'https://moli.example/a.png', role: 'reference_image' }],
    video_with_roles: [{ url: 'https://moli.example/a.mp4', role: 'reference_video' }],
    audio_with_roles: [{ url: 'https://moli.example/a.mp3', role: 'reference_audio' }],
  });

  assert.deepEqual(buildToapisVideoBody({
    model: 'seedance-2-fast',
    prompt: '首尾帧',
    resolution: '480p',
    duration: 4,
    generate_audio: true,
    first_frame_url: 'https://moli.example/first.png',
    last_frame_url: 'https://moli.example/last.png',
  }).image_with_roles, [
    { url: 'https://moli.example/first.png', role: 'first_frame' },
    { url: 'https://moli.example/last.png', role: 'last_frame' },
  ]);

  assert.equal(buildToapisVideoBody({
    model: 'seedance-2-fast',
    prompt: '生成音频',
    resolution: '480p',
    duration: 4,
    generate_audio: true,
  }).generate_audio, true);

  assert.throws(
    () => buildToapisVideoBody({
      model: 'seedance-2-fast',
      prompt: 'x',
      resolution: '480p',
      duration: 4,
      last_frame_url: 'https://moli.example/last.png',
    }),
    /尾帧必须与首帧/,
  );
  assert.throws(
    () => buildToapisVideoBody({
      model: 'seedance-2-fast',
      prompt: 'x',
      resolution: '480p',
      duration: 4,
      first_frame_url: 'https://moli.example/first.png',
      reference_urls: ['https://moli.example/ref.png'],
    }),
    /互斥/,
  );
  assert.throws(
    () => buildToapisVideoBody({
      model: 'seedance-2-mini',
      prompt: 'x',
      resolution: '480p',
      duration: 4,
      reference_audio_urls: ['https://moli.example/ref.mp3'],
    }),
    /参考音频不能单独使用/,
  );
});

test('ToAPIs 引用素材只接受公网 HTTPS 且拒绝泄露身份的 URL', () => {
  for (const badUrl of [
    'http://moli.example/a.png',
    'data:image/png;base64,xxx',
    'asset://local/a.png',
    'file:///tmp/a.png',
    '/static/projects/1/a.png',
    'https://user:pass@moli.example/a.png',
  ]) {
    assert.throws(
      () => buildToapisVideoBody({
        model: 'seedance-2-mini',
        prompt: 'x',
        resolution: '480p',
        duration: 4,
        reference_urls: [badUrl],
      }),
      /公网 HTTPS/,
      badUrl,
    );
  }
});

test('ToAPIs 引用素材拒绝本地主机、私网和链路本地地址', () => {
  for (const badUrl of [
    'https://localhost/a.png',
    'https://localhost./a.png',
    'https://intranet/a.png',
    'https://127.0.0.1/a.png',
    'https://127.255.255.255/a.png',
    'https://10.1.2.3/a.png',
    'https://172.16.0.1/a.png',
    'https://172.31.255.255/a.png',
    'https://192.168.1.1/a.png',
    'https://169.254.10.20/a.png',
    'https://0.0.0.0/a.png',
    'https://[::1]/a.png',
    'https://[fc00::1]/a.png',
    'https://[fdff::1]/a.png',
    'https://[fe80::1]/a.png',
    'https://[::ffff:127.0.0.1]/a.png',
    'https://[::ffff:10.0.0.1]/a.png',
    'https://[::ffff:172.16.0.1]/a.png',
    'https://[::ffff:192.168.1.1]/a.png',
    'https://[::ffff:169.254.1.1]/a.png',
  ]) {
    assert.throws(
      () => buildToapisVideoBody({
        model: 'seedance-2-mini',
        prompt: 'x',
        resolution: '480p',
        duration: 4,
        reference_urls: [badUrl],
      }),
      /公网 HTTPS/,
      badUrl,
    );
  }

  assert.equal(buildToapisVideoBody({
    model: 'seedance-2-mini',
    prompt: 'x',
    resolution: '480p',
    duration: 4,
    reference_urls: ['https://cdn.example.com/a.png', 'https://93.184.216.34/a.png'],
  }).image_with_roles.length, 2);
});

test('ToAPIs POST 使用注入 fetch，规范化 base URL，并把不确定创建结果标为不可重试', async () => {
  assert.equal(normalizeToapisBaseUrl('https://toapis.com/v1/'), 'https://toapis.com');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      async text() { return JSON.stringify({ task_id: 'tsk_1', status: 'queued' }); },
    };
  };

  const result = await callToapisVideoApi(
    { base_url: 'https://toapis.com/v1/', api_key: 'secret-key' },
    { info() {} },
    {
      model: 'seedance-2-fast',
      prompt: 'x',
      resolution: '480p',
      duration: 4,
    },
    { fetchImpl },
  );

  assert.deepEqual(result, { task_id: 'tsk_1', status: 'queued' });
  assert.equal(calls[0].url, 'https://toapis.com/v1/videos/generations');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-key');

  const broken = await callToapisVideoApi(
    { api_key: 'secret-key' },
    null,
    { model: 'seedance-2-fast', prompt: 'x', resolution: '480p', duration: 4 },
    { fetchImpl: async () => { throw new Error('socket closed secret-key https://moli.example/ref.png'); } },
  );
  assert.equal(broken.indeterminate, true);
  assert.match(broken.error, /不得自动重试/);
  assert.doesNotMatch(broken.error, /secret-key|moli\.example/);

  for (const fetchImplCase of [
    async () => ({ ok: true, status: 200, async text() { return '<html>bad</html>'; } }),
    async () => ({ ok: true, status: 200, async text() { return JSON.stringify({ status: 'queued' }); } }),
  ]) {
    const unknown = await callToapisVideoApi(
      { api_key: 'secret-key' },
      null,
      { model: 'seedance-2-fast', prompt: 'x', resolution: '480p', duration: 4 },
      { fetchImpl: fetchImplCase },
    );
    assert.equal(unknown.indeterminate, true);
    assert.match(unknown.error, /不得自动重试|未取得 task_id/);
  }
});

test('ToAPIs 请求前强制官方 base URL，非法入口不会触发 fetch 且不泄露 Key', async () => {
  assert.equal(normalizeToapisBaseUrl(), 'https://toapis.com');
  for (const badBaseUrl of [
    'http://toapis.com',
    'https://user:pass@toapis.com',
    'https://localhost',
    'https://127.0.0.1',
    'https://10.0.0.1',
    'https://api.toapis.com',
    'https://evil.example',
  ]) {
    let calls = 0;
    const result = await callToapisVideoApi(
      { base_url: badBaseUrl, api_key: 'secret-key' },
      null,
      { model: 'seedance-2-fast', prompt: 'x', resolution: '480p', duration: 4 },
      { fetchImpl: async () => { calls += 1; throw new Error('should not fetch'); } },
    );
    assert.equal(calls, 0, badBaseUrl);
    assert.match(result.error, /ToAPIs 官方入口/);
    assert.doesNotMatch(result.error, /secret-key/);
  }
});

test('ToAPIs POST 和 GET 供应商错误会统一脱敏，不回显 Key、URL 或完整 raw JSON', async () => {
  const noisyError = {
    error: {
      message: 'failed Bearer secret-key api_key=secret-key token=secret-key key=secret-key https://signed.example/ref.png',
    },
    request: { url: 'https://signed.example/ref.png', api_key: 'secret-key' },
  };

  const created = await callToapisVideoApi(
    { api_key: 'secret-key' },
    null,
    { model: 'seedance-2-fast', prompt: 'x', resolution: '480p', duration: 4 },
    {
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        async text() { return JSON.stringify(noisyError); },
      }),
    },
  );

  assert.match(created.error, /ToAPIs 创建视频任务失败 \(400\)/);
  assert.doesNotMatch(created.error, /secret-key|Bearer|https?:\/\/|signed\.example|request/);

  for (const status of [408, 500, 502, 503, 504]) {
    const uncertain = await callToapisVideoApi(
      { api_key: 'secret-key' },
      null,
      { model: 'seedance-2-fast', prompt: 'x', resolution: '480p', duration: 4 },
      {
        fetchImpl: async () => ({
          ok: false,
          status,
          async text() { return JSON.stringify(noisyError); },
        }),
      },
    );
    assert.equal(uncertain.indeterminate, true, `HTTP ${status}`);
    assert.match(uncertain.error, /不得自动重试/);
    assert.doesNotMatch(uncertain.error, /secret-key|signed\.example/);
  }

  const queried = await fetchToapisTask(
    { api_key: 'secret-key' },
    'tsk_2',
    {
      fetchImpl: async () => ({
        ok: false,
        status: 502,
        async text() { return JSON.stringify(noisyError); },
      }),
    },
  );

  assert.match(queried.error, /ToAPIs 查询任务失败 \(502\)/);
  assert.doesNotMatch(queried.error, /secret-key|Bearer|https?:\/\/|signed\.example|request/);
});

test('ToAPIs 供应商错误脱敏覆盖常见 Key 字段格式且保留普通中文消息', async () => {
  const noisyMessage = [
    '供应商拒绝参考图',
    'api_key: secret-key',
    'token = secret-key',
    '"api_key":"secret-key"',
    '{"token":"secret-key"}',
    'api-key = secret-key',
    'access_token: secret-key',
    'KEY: secret-key',
  ].join(' ');

  const createResult = await callToapisVideoApi(
    { api_key: 'secret-key' },
    null,
    { model: 'seedance-2-fast', prompt: 'x', resolution: '480p', duration: 4 },
    {
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        async text() { return JSON.stringify({ message: noisyMessage }); },
      }),
    },
  );

  assert.match(createResult.error, /供应商拒绝参考图/);
  assert.doesNotMatch(createResult.error, /secret-key/);
  assert.match(createResult.error, /api_key:\s*\[redacted\]/i);
  assert.match(createResult.error, /token\s*=\s*\[redacted\]/i);
  assert.match(createResult.error, /api-key\s*=\s*\[redacted\]/i);
  assert.match(createResult.error, /access_token:\s*\[redacted\]/i);

  const queryResult = await fetchToapisTask(
    { api_key: 'secret-key' },
    'tsk_3',
    {
      fetchImpl: async () => ({
        ok: false,
        status: 502,
        async text() { return JSON.stringify({ error: { message: noisyMessage } }); },
      }),
    },
  );

  assert.match(queryResult.error, /供应商拒绝参考图/);
  assert.doesNotMatch(queryResult.error, /secret-key/);
  assert.match(queryResult.error, /api_key:\s*\[redacted\]/i);
  assert.match(queryResult.error, /token\s*=\s*\[redacted\]/i);
  assert.match(queryResult.error, /api-key\s*=\s*\[redacted\]/i);
  assert.match(queryResult.error, /access_token:\s*\[redacted\]/i);
});

test('ToAPIs GET 查询解析 processing/completed/failed，完成无 URL 视为失败', async () => {
  assert.equal(parseToapisTask, parseToapisVideoStatus);
  assert.deepEqual(parseToapisTask({ status: 'queued', progress: 12 }), { state: 'processing', progress: 12 });
  assert.deepEqual(parseToapisTask({ status: 'completed', result: { data: [{ url: 'https://moli.example/out.mp4' }] } }), {
    state: 'completed',
    videoUrl: 'https://moli.example/out.mp4',
    progress: null,
  });
  assert.equal(parseToapisTask({ status: 'completed', result: { data: [] } }).state, 'failed');
  assert.equal(parseToapisTask({ status: 'failed', error: { message: 'bad ref' } }).error, 'bad ref');

  const calls = [];
  const done = await fetchToapisTask(
    { base_url: 'https://toapis.com/v1', api_key: 'secret-key' },
    'tsk_2',
    {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ status: 'completed', result: { data: [{ url: 'https://moli.example/out.mp4' }] } });
          },
        };
      },
    },
  );

  assert.equal(calls[0].url, 'https://toapis.com/v1/videos/generations/tsk_2');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-key');
  assert.equal(done.state, 'completed');

  const interrupted = await fetchToapisTask(
    { api_key: 'secret-key' },
    'tsk_2',
    { fetchImpl: async () => { throw new Error('network secret-key'); } },
  );
  assert.equal(interrupted.state, 'processing');
  assert.equal(interrupted.retryable, true);
  assert.doesNotMatch(interrupted.error, /secret-key/);
});
