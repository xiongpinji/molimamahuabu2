const test = require('node:test');
const assert = require('node:assert/strict');
const { evidenceRoots, withExternalModelEvidence } = require('./helpers/externalModelEvidenceFixture');

const {
  callVideoApi,
  getDefaultVideoConfig,
  inferVideoProtocol,
  pollVideoTask,
  resolveVideoProtocol,
} = require('../src/services/videoClient');
const providerAssetUrl = require('../src/services/providerAssetUrlService');
const {
  buildToapisVideoBody,
  callToapisVideoApi,
  TOAPIS_VIDEO_MODELS,
} = require('../src/services/toapisVideoClient');

const log = { info() {}, warn() {}, error() {} };

function configRow(model) {
  return {
    id: model === 'seedance-2-fast' ? 71 : 72,
    service_type: 'video',
    provider: 'toapis',
    api_protocol: 'toapis_video',
    base_url: 'https://toapis.com',
    api_key: 'secret-key',
    model: JSON.stringify([model]),
    default_model: model,
    is_default: true,
    is_active: true,
  };
}

function configDb(row) {
  return {
    prepare(sql) {
      return { all: () => sql.includes('SELECT * FROM ai_service_configs') ? [row] : [] };
    },
  };
}

function makeLog() {
  const entries = [];
  return {
    entries,
    info(message, data) { entries.push({ level: 'info', message, data }); },
    warn(message, data) { entries.push({ level: 'warn', message, data }); },
    error(message, data) { entries.push({ level: 'error', message, data }); },
  };
}

function assertSignedProviderAsset(value, expectedPath, secret) {
  const url = new URL(value);
  assert.equal(url.pathname, expectedPath);
  assert.equal(providerAssetUrl.verifyProviderAssetRequest({
    pathname: url.pathname,
    expires: url.searchParams.get(providerAssetUrl.EXPIRES_PARAM),
    signature: url.searchParams.get(providerAssetUrl.SIGNATURE_PARAM),
    secret,
  }), true);
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
    verified_capabilities: JSON.stringify({
      'seedance-2-fast': withExternalModelEvidence('seedance-2-fast', {
        resolutions: ['480p', '720p'],
        durations: [4, 5],
        supportsFirstFrame: true,
        supportsLastFrame: true,
        supportsImageReference: true,
        supportsVideoReference: true,
        supportsAudioReference: true,
        supportsAudio: true,
        maxReferences: 9,
        maxVideoReferences: 3,
        maxAudioReferences: 3,
      }),
      'seedance-2-mini': withExternalModelEvidence('seedance-2-mini', {
        resolutions: ['480p', '720p'],
        durations: [4, 8, 10, 12, 15],
        supportsFirstFrame: true,
        supportsLastFrame: true,
        supportsImageReference: true,
        supportsVideoReference: true,
        supportsAudioReference: true,
        supportsAudio: true,
        maxReferences: 9,
        maxVideoReferences: 3,
        maxAudioReferences: 3,
      }),
    }),
    ...overrides,
  };
}

function makeVideoPrice(model, resolutionPrices = {
  '480p': { credits: 64, cost_micros_per_second: 73000 },
  '720p': { credits: 96, cost_micros_per_second: 109000 },
}) {
  return {
    model,
    display_name: model,
    public_note: '',
    category: 'video',
    credits: 1,
    status: 'enabled',
    billing_unit: 'second',
    cost_unit: 'second',
    cost_micros_per_unit: 0,
    input_cost_micros_per_1k: 0,
    output_cost_micros_per_1k: 0,
    updated_at: '2026-08-08T00:00:00.000Z',
    resolution_prices: resolutionPrices,
  };
}

function makeDb(config, prices = [
  makeVideoPrice('seedance-2-fast'),
  makeVideoPrice('seedance-2-mini'),
]) {
  const configs = Array.isArray(config) ? config : [config];
  return {
    exec() {},
    prepare(sql) {
      return {
        all(...args) {
          if (/PRAGMA table_info/i.test(sql)) return [];
          if (/FROM ai_service_configs/i.test(sql)) {
            return /is_default\s*=\s*1/i.test(sql)
              ? configs.filter((item) => item.is_default)
              : configs;
          }
          if (/FROM model_resolution_prices/i.test(sql)) {
            const model = String(args[0] || '').toLowerCase();
            const price = prices.find((item) => item.model.toLowerCase() === model);
            return Object.entries(price?.resolution_prices || {}).map(([resolution, tier]) => ({
              resolution,
              ...tier,
            }));
          }
          if (/FROM model_image_resolution_prices/i.test(sql)) return [];
          if (/FROM model_credit_prices/i.test(sql)) {
            return prices.map(({ resolution_prices, ...price }) => price);
          }
          return [];
        },
        get(...args) {
          if (/FROM sqlite_master/i.test(sql)) return { exists: 1 };
          if (/FROM ai_service_configs/i.test(sql)) return configs[0];
          if (/FROM model_credit_prices/i.test(sql)) {
            const model = String(args[0] || '').toLowerCase();
            const price = prices.find((item) => item.model.toLowerCase() === model);
            if (!price) return undefined;
            const { resolution_prices, ...row } = price;
            return row;
          }
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
  assert.equal(getDefaultVideoConfig(makeDb([generic, strict]), 'seedance-2-fast', evidenceRoots).id, 2);
  assert.equal(getDefaultVideoConfig(makeDb(generic), 'seedance-2-fast', evidenceRoots), null);
});

test('official ToAPIs model never selects a strict config whose evidence binding is stale', () => {
  const stale = makeVideoConfig({
    id: 3,
    model: ['seedance-2-fast'],
    default_model: 'seedance-2-fast',
    is_default: 1,
    verified_capabilities: JSON.stringify({
      'seedance-2-fast': {
        resolutions: ['480p', '720p'],
        durations: [4, 5],
        evidence_contract: 'toapis-video-real-verification-v1',
        evidence_sha256: '0'.repeat(64),
      },
    }),
  });
  const bound = makeVideoConfig({
    id: 4,
    model: ['seedance-2-fast'],
    default_model: 'seedance-2-fast',
    is_default: 0,
  });

  assert.equal(getDefaultVideoConfig(makeDb([stale, bound]), 'seedance-2-fast', evidenceRoots).id, 4);
  assert.equal(getDefaultVideoConfig(makeDb(stale), 'seedance-2-fast', evidenceRoots), null);
});

test('ToAPIs callVideoApi signs protected multimodal references and never degrades them into first_frame', async (t) => {
  const originalSecret = process.env.PLATFORM_JWT_SECRET;
  process.env.PLATFORM_JWT_SECRET = 'test-provider-asset-secret-at-least-32-characters';
  t.after(() => {
    if (originalSecret == null) delete process.env.PLATFORM_JWT_SECRET;
    else process.env.PLATFORM_JWT_SECRET = originalSecret;
  });
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
    image_url: 'https://molimama.vip/static/projects/0039/cover.png',
    reference_urls: ['https://molimama.vip/static/projects/0039/ref.png'],
    reference_video_urls: ['https://molimama.vip/static/projects/0039/ref.mp4'],
    reference_audio_urls: ['https://molimama.vip/static/projects/0039/ref.mp3'],
    files_base_url: 'https://molimama.vip/static',
    generate_audio: false,
    client_business_id: 'video-70',
    fetchImpl,
  }, { evidenceRoots });

  assert.deepEqual(result, { task_id: 'tsk_multi', status: 'queued' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://toapis.com/v1/videos/generations');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-key');
  assert.equal(calls[0].body.generate_audio, false);
  assert.equal(calls[0].body.image_with_roles[0].role, 'reference_image');
  assertSignedProviderAsset(calls[0].body.image_with_roles[0].url, '/static/projects/0039/ref.png', process.env.PLATFORM_JWT_SECRET);
  assert.equal(calls[0].body.video_with_roles[0].role, 'reference_video');
  assertSignedProviderAsset(calls[0].body.video_with_roles[0].url, '/static/projects/0039/ref.mp4', process.env.PLATFORM_JWT_SECRET);
  assert.equal(calls[0].body.audio_with_roles[0].role, 'reference_audio');
  assertSignedProviderAsset(calls[0].body.audio_with_roles[0].url, '/static/projects/0039/ref.mp3', process.env.PLATFORM_JWT_SECRET);
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
  }, { evidenceRoots });

  assert.deepEqual(result, { task_id: 'tsk_frames', status: 'queued' });
  assert.deepEqual(calls[0].body.image_with_roles, [
    { url: 'https://cdn.example.com/first.png', role: 'first_frame' },
    { url: 'https://cdn.example.com/last.png', role: 'last_frame' },
  ]);
});

test('ToAPIs short-drama frame request signs the protected platform asset without auto-injecting character voice', async (t) => {
  const originalSecret = process.env.PLATFORM_JWT_SECRET;
  process.env.PLATFORM_JWT_SECRET = 'test-provider-asset-secret-at-least-32-characters';
  t.after(() => {
    if (originalSecret == null) delete process.env.PLATFORM_JWT_SECRET;
    else process.env.PLATFORM_JWT_SECRET = originalSecret;
  });
  const db = makeDb(makeVideoConfig());
  const basePrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (/seedance2_voice_asset/i.test(sql)) {
      return {
        all() {
          return [{
            id: 7,
            seedance2_voice_asset: JSON.stringify({
              status: 'active',
              url: '/static/projects/0039/characters/voice/character-7.mp3',
            }),
          }];
        },
      };
    }
    if (/SELECT characters, dialogue FROM storyboards/i.test(sql)) {
      return { get() { return { characters: '[7]', dialogue: '林溪：别怕。' }; } };
    }
    if (/SELECT voice_snapshot FROM storyboards/i.test(sql)) {
      return { get() { return { voice_snapshot: null }; } };
    }
    if (/SELECT id, name FROM characters/i.test(sql)) {
      return { all() { return [{ id: 7, name: '林溪' }]; } };
    }
    if (/SELECT character_id FROM storyboard_characters/i.test(sql)) {
      return { all() { return []; } };
    }
    return basePrepare(sql);
  };

  const calls = [];
  const result = await callVideoApi(db, makeLog(), {
    model: 'seedance-2-mini',
    prompt: '短剧工厂首帧生成',
    duration: 4,
    resolution: '480p',
    aspect_ratio: '16:9',
    drama_id: 39,
    storyboard_id: 48,
    first_frame_url: 'https://molimama.vip/static/projects/0039_[全流程实测]/images/frame.jpg',
    generate_audio: false,
    files_base_url: 'https://molimama.vip/static',
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
      return {
        ok: true,
        status: 200,
        async text() { return JSON.stringify({ task_id: 'tsk_short_drama_frame', status: 'queued' }); },
      };
    },
  }, { evidenceRoots });

  assert.deepEqual(result, { task_id: 'tsk_short_drama_frame', status: 'queued' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.image_with_roles.length, 1);
  const signedFrame = new URL(calls[0].body.image_with_roles[0].url);
  assert.equal(signedFrame.pathname, '/static/projects/0039_[%E5%85%A8%E6%B5%81%E7%A8%8B%E5%AE%9E%E6%B5%8B]/images/frame.jpg');
  assert.equal(providerAssetUrl.verifyProviderAssetRequest({
    pathname: signedFrame.pathname,
    expires: signedFrame.searchParams.get(providerAssetUrl.EXPIRES_PARAM),
    signature: signedFrame.searchParams.get(providerAssetUrl.SIGNATURE_PARAM),
    secret: process.env.PLATFORM_JWT_SECRET,
  }), true);
  assert.equal(calls[0].body.image_with_roles[0].role, 'first_frame');
  assert.equal(Object.hasOwn(calls[0].body, 'audio_with_roles'), false);
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
  }, { evidenceRoots });
  const badDuration = await callVideoApi(db, makeLog(), {
    model: 'seedance-2-mini',
    prompt: 'x',
    duration: 5,
    resolution: '480p',
    fetchImpl,
  }, { evidenceRoots });

  assert.equal(calls, 0);
  assert.match(badResolution.error, /不支持 1080p/);
  assert.match(badDuration.error, /不支持 5 秒/);
});

test('ToAPIs final submit gate rejects missing exact resolution price before fetch', async () => {
  const db = makeDb(makeVideoConfig(), [
    makeVideoPrice('seedance-2-fast'),
    makeVideoPrice('seedance-2-mini', {
      '480p': { credits: 64, cost_micros_per_second: 73000 },
    }),
  ]);
  let calls = 0;
  const result = await callVideoApi(db, makeLog(), {
    model: 'seedance-2-mini',
    prompt: '价格门禁',
    duration: 8,
    resolution: '720p',
    fetchImpl: async () => {
      calls += 1;
      throw new Error('should not fetch');
    },
  }, { evidenceRoots });

  assert.equal(calls, 0);
  assert.match(result.error, /720p.*积分待管理员配置/);
});

test('ToAPIs final submit gate rejects capabilities not covered by bound evidence before fetch', async () => {
  const capabilities = JSON.parse(makeVideoConfig().verified_capabilities);
  capabilities['seedance-2-mini'] = withExternalModelEvidence('seedance-2-mini', {
    ...capabilities['seedance-2-mini'],
    supportsVideoReference: false,
    supportsAudio: false,
    maxReferences: 1,
  });
  const db = makeDb(makeVideoConfig({ verified_capabilities: JSON.stringify(capabilities) }));
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error('should not fetch');
  };

  const unverifiedVideoReference = await callVideoApi(db, makeLog(), {
    model: 'seedance-2-mini',
    prompt: '参考视频门禁',
    duration: 8,
    resolution: '480p',
    reference_urls: ['https://cdn.example.com/ref.png'],
    reference_video_urls: ['https://cdn.example.com/ref.mp4'],
    fetchImpl,
  }, { evidenceRoots });
  const unverifiedAudioGeneration = await callVideoApi(db, makeLog(), {
    model: 'seedance-2-mini',
    prompt: '同步音频门禁',
    duration: 8,
    resolution: '480p',
    generate_audio: true,
    fetchImpl,
  }, { evidenceRoots });
  const evidenceReferenceLimit = await callVideoApi(db, makeLog(), {
    model: 'seedance-2-mini',
    prompt: '实测数量门禁',
    duration: 8,
    resolution: '480p',
    reference_urls: [
      'https://cdn.example.com/ref-1.png',
      'https://cdn.example.com/ref-2.png',
    ],
    fetchImpl,
  }, { evidenceRoots });

  assert.equal(calls, 0);
  assert.match(unverifiedVideoReference.error, /参考视频.*尚未通过真实验证/);
  assert.match(unverifiedAudioGeneration.error, /同步音频.*尚未通过真实验证/);
  assert.match(evidenceReferenceLimit.error, /参考图数量超过已验证上限/);
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

test('ToAPIs Fast and Mini both preserve two reference images through the shared video route', async (t) => {
  assert.equal(TOAPIS_VIDEO_MODELS['seedance-2-fast'].maxReferences, 9);
  assert.equal(TOAPIS_VIDEO_MODELS['seedance-2-mini'].maxReferences, 9);

  const originalSecret = process.env.PLATFORM_JWT_SECRET;
  process.env.PLATFORM_JWT_SECRET = 'test-provider-asset-secret-at-least-32-characters';
  t.after(() => {
    if (originalSecret == null) delete process.env.PLATFORM_JWT_SECRET;
    else process.env.PLATFORM_JWT_SECRET = originalSecret;
  });

  for (const model of ['seedance-2-fast', 'seedance-2-mini']) {
    const calls = [];
    const submitted = await callVideoApi(makeDb(makeVideoConfig({
      id: model === 'seedance-2-fast' ? 71 : 72,
      model: JSON.stringify([model]),
      default_model: model,
    })), log, {
      model,
      prompt: '保持两张参考图中的人物和服装一致',
      duration: 4,
      resolution: '480p',
      aspect_ratio: '16:9',
      reference_urls: [
        'https://molimama.vip/static/projects/0039/reference-1.png',
        'https://cdn.example.com/reference-2.png',
      ],
      files_base_url: 'https://molimama.vip/static',
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) });
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ task_id: `task-${model}`, status: 'queued' }),
        };
      },
    }, { evidenceRoots });

    assert.deepEqual(submitted, { task_id: `task-${model}`, status: 'queued' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://toapis.com/v1/videos/generations');
    assert.equal(calls[0].body.image_with_roles.length, 2);
    assert.deepEqual(calls[0].body.image_with_roles.map((item) => item.role), [
      'reference_image',
      'reference_image',
    ]);
    const signed = new URL(calls[0].body.image_with_roles[0].url);
    assert.equal(signed.pathname, '/static/projects/0039/reference-1.png');
    assert.ok(signed.searchParams.get('provider_asset_signature'));
    assert.equal(calls[0].body.image_with_roles[1].url, 'https://cdn.example.com/reference-2.png');
  }
});

test('ToAPIs Fast and Mini both expose and accept 9 image, 3 video, and 3 audio references', () => {
  const images = Array.from({ length: 9 }, (_, index) => `https://cdn.example.com/image-${index + 1}.png`);
  const videos = Array.from({ length: 3 }, (_, index) => `https://cdn.example.com/video-${index + 1}.mp4`);
  const audio = Array.from({ length: 3 }, (_, index) => `https://cdn.example.com/audio-${index + 1}.mp3`);

  for (const model of ['seedance-2-fast', 'seedance-2-mini']) {
    const spec = TOAPIS_VIDEO_MODELS[model];
    assert.equal(spec.maxReferences, 9);
    assert.equal(spec.maxVideoReferences, 3);
    assert.equal(spec.maxAudioReferences, 3);

    const body = buildToapisVideoBody({
      model,
      prompt: '保持所有参考素材中的人物、环境与声音一致',
      duration: 4,
      resolution: '480p',
      aspect_ratio: '16:9',
      reference_urls: images,
      reference_video_urls: videos,
      reference_audio_urls: audio,
    });
    assert.equal(body.image_with_roles.length, 9);
    assert.equal(body.video_with_roles.length, 3);
    assert.equal(body.audio_with_roles.length, 3);

    assert.throws(() => buildToapisVideoBody({
      model,
      prompt: '超出图片上限',
      duration: 4,
      resolution: '480p',
      reference_urls: [...images, 'https://cdn.example.com/image-10.png'],
    }), /最多支持 9 张参考图/);
    assert.throws(() => buildToapisVideoBody({
      model,
      prompt: '超出视频上限',
      duration: 4,
      resolution: '480p',
      reference_urls: images,
      reference_video_urls: [...videos, 'https://cdn.example.com/video-4.mp4'],
    }), /最多支持 3 个参考视频/);
    assert.throws(() => buildToapisVideoBody({
      model,
      prompt: '超出音频上限',
      duration: 4,
      resolution: '480p',
      reference_urls: images,
      reference_audio_urls: [...audio, 'https://cdn.example.com/audio-4.mp3'],
    }), /最多支持 3 个参考音频/);
  }
});

test('shared video polling reads the ToAPIs task endpoint', async () => {
  const row = configRow('seedance-2-fast');
  let requestedUrl = '';
  const completed = await pollVideoTask(null, log, row.id, 'task-fast-1', row, 1, 0, {
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          status: 'completed',
          result: { data: [{ url: 'https://cdn.example.com/result.mp4' }] },
        }),
      };
    },
  });

  assert.equal(requestedUrl, 'https://toapis.com/v1/videos/generations/task-fast-1');
  assert.deepEqual(completed, { video_url: 'https://cdn.example.com/result.mp4' });
});

test('ToAPIs interrupted POST keeps structured submission-unknown metadata', async () => {
  const error = new Error('socket closed');
  error.code = 'ECONNRESET';
  const result = await callToapisVideoApi(configRow('seedance-2-fast'), log, {
    model: 'seedance-2-fast',
    prompt: 'test',
    duration: 4,
    resolution: '480p',
    aspect_ratio: '16:9',
  }, { fetchImpl: async () => { throw error; } });

  assert.equal(result.indeterminate, true);
  assert.match(result.error, /不得自动重试/);
  assert.deepEqual(result.route_meta, {
    phase: 'submit',
    requestBodySent: true,
    transportCode: 'ECONNRESET',
  });
});
