const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TOAPIS_WAN3_MODEL,
  TOAPIS_WAN3_SPEC,
  buildToapisWan3VideoBody,
  callToapisWan3VideoApi,
  fetchToapisWan3Task,
  validateToapisWan3VideoOptions,
} = require('../src/services/toapisWan3VideoClient');

test('Wan 3.0 独立能力合同按官方限制构建多模态请求', () => {
  assert.equal(TOAPIS_WAN3_MODEL, 'wan3.0-video');
  assert.deepEqual(TOAPIS_WAN3_SPEC.resolutions, ['480p', '720p', '1080p']);
  assert.deepEqual(TOAPIS_WAN3_SPEC.durations, Array.from({ length: 29 }, (_, index) => index + 2));
  assert.deepEqual(TOAPIS_WAN3_SPEC.aspectRatios, ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4']);
  assert.equal(TOAPIS_WAN3_SPEC.maxReferences, 10);
  assert.equal(TOAPIS_WAN3_SPEC.maxVideoReferences, 5);
  assert.equal(TOAPIS_WAN3_SPEC.maxAudioReferences, 5);

  assert.deepEqual(buildToapisWan3VideoBody({
    model: 'wan3.0-video',
    prompt: '使用官方默认参数',
    duration: 2,
  }), {
    model: 'wan3.0-video',
    prompt: '使用官方默认参数',
    duration: 2,
    ratio: 'adaptive',
    resolution: '1080p',
    audio: false,
  });

  assert.deepEqual(buildToapisWan3VideoBody({
    model: 'wan3.0-video',
    prompt: '多模态战争短片',
    resolution: '480p',
    duration: 30,
    aspect_ratio: '16:9',
    generate_audio: true,
    audio: false,
    watermark: true,
    seed: 12345,
    client_business_id: 'wan-biz-1',
    reference_urls: ['https://moli.example/ref.png'],
    reference_video_urls: ['https://moli.example/ref.mp4'],
    reference_video_durations: [5],
    reference_audio_urls: ['https://moli.example/ref.mp3'],
    reference_audio_durations: [4],
  }), {
    model: 'wan3.0-video',
    prompt: '多模态战争短片',
    duration: 30,
    ratio: '16:9',
    resolution: '480p',
    audio: false,
    watermark: true,
    seed: 12345,
    client_business_id: 'wan-biz-1',
    reference_images: ['https://moli.example/ref.png'],
    video_list: [{ video_url: 'https://moli.example/ref.mp4' }],
    audio_with_roles: [{ url: 'https://moli.example/ref.mp3', role: 'reference_audio' }],
  });
});

test('Wan 3.0 拒绝越界参数、内网素材和互斥参考模式', () => {
  assert.throws(() => validateToapisWan3VideoOptions({
    model: 'wan3.0-video', prompt: 'x', resolution: '480p',
  }), /必须显式指定 2 至 30 秒/);
  assert.throws(() => validateToapisWan3VideoOptions({
    model: 'wan3.0-video', prompt: 'x', duration: 31, resolution: '480p',
  }), /不支持 31 秒/);
  assert.throws(() => validateToapisWan3VideoOptions({
    model: 'wan3.0-video', prompt: 'x', duration: 2, resolution: '2k',
  }), /不支持 2k/);
  assert.throws(() => validateToapisWan3VideoOptions({
    model: 'wan3.0-video', prompt: 'x', duration: 2, reference_urls: ['http:\/\/127.0.0.1\/a.png'],
  }), /公网 HTTPS URL/);
  assert.throws(() => validateToapisWan3VideoOptions({
    model: 'wan3.0-video', prompt: 'x', duration: 2,
    reference_urls: ['asset:\/\/pa_private'], trusted_asset_urls: ['asset:\/\/pa_private'],
  }), /公网 HTTPS URL/);
  assert.throws(() => validateToapisWan3VideoOptions({
    model: 'wan3.0-video', prompt: 'x', duration: 2,
    first_frame_url: 'https://moli.example/first.png',
    reference_urls: ['https://moli.example/ref.png'],
  }), /互斥/);
  assert.doesNotThrow(() => validateToapisWan3VideoOptions({
    model: 'wan3.0-video', prompt: 'x', duration: 2,
    reference_audio_urls: ['https://moli.example/ref.mp3'],
    reference_audio_durations: [4],
  }));
  assert.throws(() => validateToapisWan3VideoOptions({
    model: 'wan3.0-video', prompt: 'x', duration: 2,
    reference_video_urls: ['https://moli.example/ref.mp4'],
  }), /参考视频.*时长/);
  assert.throws(() => validateToapisWan3VideoOptions({
    model: 'wan3.0-video', prompt: 'x', duration: 2,
    reference_video_urls: ['https://moli.example/a.mp4', 'https://moli.example/b.mp4'],
    reference_video_durations: [8, 8],
  }), /参考视频总时长最多 15 秒/);
  assert.throws(() => validateToapisWan3VideoOptions({
    model: 'wan3.0-video', prompt: 'x', duration: 2,
    reference_audio_urls: ['https://moli.example/a.mp3', 'https://moli.example/b.mp3'],
    reference_audio_durations: [9, 7],
  }), /参考音频总时长最多 15 秒/);
});

test('Wan 3.0 配置 Key 不会被旧全局 ToAPIs Key 覆盖', async () => {
  const previous = process.env.TOAPIS_API_KEY;
  process.env.TOAPIS_API_KEY = 'wrong-global-key';
  let authorization;
  try {
    const created = await callToapisWan3VideoApi(
      { base_url: 'https://toapis.xyz', api_key: 'wan-config-key' },
      null,
      {
        model: 'wan3.0-video', prompt: '安全路由', duration: 2, resolution: '480p',
        client_business_id: 'wan-config-key-test',
      },
      {
        fetchImpl: async (_url, init) => {
          authorization = init.headers.Authorization;
          return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'wan-task-config-key' }) };
        },
      },
    );
    assert.equal(created.task_id, 'wan-task-config-key');
    assert.equal(authorization, 'Bearer wan-config-key');
  } finally {
    if (previous === undefined) delete process.env.TOAPIS_API_KEY;
    else process.env.TOAPIS_API_KEY = previous;
  }
});

test('Wan 3.0 创建任务显式 Key 优先且未知结果禁止自动重试', async () => {
  let captured;
  const created = await callToapisWan3VideoApi(
    { base_url: 'https://toapis.xyz', api_key: 'config-key' },
    null,
    { model: 'wan3.0-video', prompt: '海边日落', duration: 2, resolution: '480p', video_gen_id: 17 },
    {
      apiKey: 'request-key',
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'wan-task-1', status: 'queued' }) };
      },
    },
  );
  assert.equal(created.task_id, 'wan-task-1');
  assert.equal(captured.url, 'https://toapis.xyz/v1/videos/generations');
  assert.equal(captured.init.headers.Authorization, 'Bearer request-key');
  assert.equal(JSON.parse(captured.init.body).model, 'wan3.0-video');
  assert.equal(JSON.parse(captured.init.body).client_business_id, 'video-17');

  let blockedFetches = 0;
  const blocked = await callToapisWan3VideoApi(
    { base_url: 'https://toapis.xyz', api_key: 'config-key' },
    null,
    { model: 'wan3.0-video', prompt: '海边日落', duration: 2, resolution: '480p' },
    { fetchImpl: async () => { blockedFetches += 1; throw new Error('must not run'); } },
  );
  assert.equal(blockedFetches, 0);
  assert.equal(blocked.route_meta.requestBodySent, false);
  assert.match(blocked.error, /缺少稳定业务 ID/);

  const unknown = await callToapisWan3VideoApi(
    { base_url: 'https://toapis.xyz', api_key: 'config-key' },
    null,
    {
      model: 'wan3.0-video', prompt: '海边日落', duration: 2, resolution: '480p',
      client_business_id: 'wan-recovery-1',
    },
    { fetchImpl: async () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); } },
  );
  assert.equal(unknown.indeterminate, true);
  assert.equal(unknown.route_meta.requestBodySent, true);
  assert.equal(unknown.route_meta.recoveryTaskId, 'wan-recovery-1');
  assert.match(unknown.error, /不得自动重试/);
});

test('Wan 3.0 查询任务返回可读取结果地址', async () => {
  const previous = process.env.TOAPIS_API_KEY;
  process.env.TOAPIS_API_KEY = 'wrong-global-key';
  let authorization;
  try {
    const result = await fetchToapisWan3Task(
      { base_url: 'https://toapis.xyz', api_key: 'config-key' },
      'wan-task-1',
      {
        fetchImpl: async (_url, init) => {
          authorization = init.headers.Authorization;
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              status: 'completed',
              result: { data: [{ url: 'https://cdn.example/result.mp4', format: 'mp4' }] },
            }),
          };
        },
      },
    );
    assert.equal(result.state, 'completed');
    assert.equal(result.videoUrl, 'https://cdn.example/result.mp4');
    assert.equal(authorization, 'Bearer config-key');
  } finally {
    if (previous === undefined) delete process.env.TOAPIS_API_KEY;
    else process.env.TOAPIS_API_KEY = previous;
  }
});

test('Wan 3.0 查询任务区分终态失败、查询失败和结果不可读', async () => {
  const config = { base_url: 'https://toapis.xyz', api_key: 'config-key' };
  const terminal = await fetchToapisWan3Task(config, 'wan-terminal', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'failed', error: { message: 'provider rejected' } }),
    }),
  });
  assert.equal(terminal.state, 'failed');
  assert.equal(terminal.terminalFailure, true);

  const queryFailed = await fetchToapisWan3Task(config, 'wan-query-failed', {
    fetchImpl: async () => ({
      ok: false,
      status: 502,
      text: async () => JSON.stringify({ error: { message: 'gateway unavailable' } }),
    }),
  });
  assert.equal(queryFailed.state, 'failed');
  assert.equal(queryFailed.queryFailed, true);

  const artifactUnreadable = await fetchToapisWan3Task(config, 'wan-artifact-unreadable', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'completed', result: { data: [] } }),
    }),
  });
  assert.equal(artifactUnreadable.state, 'failed');
  assert.equal(artifactUnreadable.artifactUnreadable, true);
});

test('Wan 3.0 明确拒绝会脱敏供应商返回的 Key 与 URL', async () => {
  const result = await callToapisWan3VideoApi(
    { base_url: 'https://toapis.xyz', api_key: 'config-key' },
    null,
    {
      model: 'wan3.0-video', prompt: '海边日落', duration: 2, resolution: '480p',
      client_business_id: 'wan-rejected-1',
    },
    {
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({
          error: { message: 'api_key=sk-secret failed for https://private.example/path' },
        }),
      }),
    },
  );
  assert.equal(result.indeterminate, undefined);
  assert.equal(result.route_meta.explicitlyRejected, true);
  assert.doesNotMatch(result.error, /sk-secret|private\.example/);
  assert.match(result.error, /\[redacted\]|\[url-redacted\]/);
});
