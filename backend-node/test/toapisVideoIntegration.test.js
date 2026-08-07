const test = require('node:test');
const assert = require('node:assert/strict');

const {
  callVideoApi,
  getDefaultVideoConfig,
  inferVideoProtocol,
  pollVideoTask,
  resolveVideoProtocol,
} = require('../src/services/videoClient');

function makeLog() {
  const entries = [];
  return {
    entries,
    info(message, data) { entries.push({ level: 'info', message, data }); },
    warn(message, data) { entries.push({ level: 'warn', message, data }); },
    error(message, data) { entries.push({ level: 'error', message, data }); },
  };
}

function makeVideoConfig(overrides = {}) {
  return {
    id: 70,
    service_type: 'video',
    provider: 'toapis',
    api_protocol: '',
    base_url: 'https://toapis.com/v1',
    api_key: 'secret-key',
    model: JSON.stringify(['seedance-2-fast', 'seedance-2-mini']),
    default_model: 'seedance-2-mini',
    is_active: 1,
    is_default: 1,
    verification_status: 'verified',
    ...overrides,
  };
}

function makeDb(config) {
  const configs = Array.isArray(config) ? config : [config];
  return {
    prepare(sql) {
      return {
        all() {
          if (/FROM ai_service_configs/i.test(sql)) {
            return /is_default\s*=\s*1/i.test(sql)
              ? configs.filter((item) => item.is_default)
              : configs;
          }
          return [];
        },
        get() {
          if (/FROM ai_service_configs/i.test(sql)) return configs[0];
          return undefined;
        },
        run() { return { changes: 0 }; },
      };
    },
  };
}

test('ToAPIs video protocol resolves from provider and explicit api_protocol', () => {
  assert.equal(inferVideoProtocol('toapis'), 'toapis_video');
  assert.equal(inferVideoProtocol('toapis_video'), 'toapis_video');
  assert.equal(resolveVideoProtocol(makeVideoConfig({ provider: 'toapis', api_protocol: '' })), 'toapis_video');
  assert.equal(resolveVideoProtocol(makeVideoConfig({ provider: 'custom', api_protocol: 'toapis_video' })), 'toapis_video');
});

test('official ToAPIs model always resolves strict config and never same-model generic fallback', () => {
  const generic = makeVideoConfig({
    id: 1,
    provider: 'openai',
    api_protocol: 'openai',
    base_url: 'https://example.invalid',
    model: ['seedance-2-fast'],
    default_model: 'seedance-2-fast',
    is_default: 1,
  });
  const strict = makeVideoConfig({
    id: 2,
    model: ['seedance-2-fast'],
    default_model: 'seedance-2-fast',
    is_default: 0,
  });
  assert.equal(getDefaultVideoConfig(makeDb([generic, strict]), 'seedance-2-fast').id, 2);
  assert.equal(getDefaultVideoConfig(makeDb(generic), 'seedance-2-fast'), null);
});

test('ToAPIs callVideoApi keeps multimodal references and never degrades them into first_frame', async () => {
  const config = makeVideoConfig();
  const db = makeDb(config);
  const log = makeLog();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    return {
      ok: true,
      status: 200,
      async text() { return JSON.stringify({ id: 'tsk_multi', status: 'queued' }); },
    };
  };

  const result = await callVideoApi(db, log, {
    model: 'seedance-2-mini',
    prompt: '根据多模态参考生成',
    duration: 8,
    resolution: '480p',
    aspect_ratio: '16:9',
    image_url: 'https://cdn.example.com/cover.png',
    reference_urls: ['https://cdn.example.com/ref.png'],
    reference_video_urls: ['https://cdn.example.com/ref.mp4'],
    reference_audio_urls: ['https://cdn.example.com/ref.mp3'],
    generate_audio: false,
    client_business_id: 'video-70',
    fetchImpl,
  });

  assert.deepEqual(result, { task_id: 'tsk_multi', status: 'queued' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://toapis.com/v1/videos/generations');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-key');
  assert.equal(calls[0].body.generate_audio, false);
  assert.deepEqual(calls[0].body.image_with_roles, [
    { url: 'https://cdn.example.com/ref.png', role: 'reference_image' },
  ]);
  assert.deepEqual(calls[0].body.video_with_roles, [
    { url: 'https://cdn.example.com/ref.mp4', role: 'reference_video' },
  ]);
  assert.deepEqual(calls[0].body.audio_with_roles, [
    { url: 'https://cdn.example.com/ref.mp3', role: 'reference_audio' },
  ]);
  assert.equal(calls[0].body.image_with_roles.some((item) => item.role === 'first_frame'), false);
});

test('ToAPIs explicit first and last frame are sent as frame roles when no multimodal refs exist', async () => {
  const db = makeDb(makeVideoConfig({ default_model: 'seedance-2-fast' }));
  const calls = [];
  const result = await callVideoApi(db, makeLog(), {
    model: 'seedance-2-fast',
    prompt: '首尾帧控制',
    duration: 4,
    resolution: '720p',
    first_frame_url: 'https://cdn.example.com/first.png',
    last_frame_url: 'https://cdn.example.com/last.png',
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
      return {
        ok: true,
        status: 200,
        async text() { return JSON.stringify({ task_id: 'tsk_frames', status: 'queued' }); },
      };
    },
  });

  assert.deepEqual(result, { task_id: 'tsk_frames', status: 'queued' });
  assert.deepEqual(calls[0].body.image_with_roles, [
    { url: 'https://cdn.example.com/first.png', role: 'first_frame' },
    { url: 'https://cdn.example.com/last.png', role: 'last_frame' },
  ]);
});

test('ToAPIs rejects unsupported options before fetch', async () => {
  const db = makeDb(makeVideoConfig());
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error('should not fetch');
  };

  const badResolution = await callVideoApi(db, makeLog(), {
    model: 'seedance-2-fast',
    prompt: 'x',
    duration: 4,
    resolution: '1080p',
    fetchImpl,
  });
  const badDuration = await callVideoApi(db, makeLog(), {
    model: 'seedance-2-mini',
    prompt: 'x',
    duration: 5,
    resolution: '480p',
    fetchImpl,
  });

  assert.equal(calls, 0);
  assert.match(badResolution.error, /不支持 1080p/);
  assert.match(badDuration.error, /不支持 5 秒/);
});

test('ToAPIs pollVideoTask delegates GET polling without raw body or bearer log leakage', async () => {
  const config = makeVideoConfig({ api_protocol: 'toapis_video' });
  const log = makeLog();
  const calls = [];
  const states = [
    { status: 'in_progress', progress: 12 },
    { status: 'completed', result: { data: [{ url: 'https://files.example.com/out.mp4' }] } },
  ];

  const result = await pollVideoTask(null, log, 88, 'tsk_poll', config, 2, 0, {
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        async text() { return JSON.stringify(states.shift()); },
      };
    },
  });

  assert.deepEqual(result, { video_url: 'https://files.example.com/out.mp4' });
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.init.method === 'GET'), true);
  assert.equal(calls.every((call) => call.url === 'https://toapis.com/v1/videos/generations/tsk_poll'), true);
  const logged = JSON.stringify(log.entries);
  assert.doesNotMatch(logged, /Bearer secret-key|secret-key/);
  assert.doesNotMatch(logged, /in_progress|files\.example\.com\/out\.mp4/);
});
