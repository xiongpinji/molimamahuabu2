const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const rawVideoService = require('../src/services/videoService');
const videoClient = require('../src/services/videoClient');
const aiConfig = require('../src/services/aiConfigService');
const taskService = require('../src/services/taskService');
const credits = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const routeCosts = require('../src/services/providerRouteCostService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { evidenceRoots, withExternalModelEvidence } = require('./helpers/externalModelEvidenceFixture');

const log = { info() {}, warn() {}, error() {} };
const videoService = {
  ...rawVideoService,
  create(db, logger, request, options = {}) {
    return rawVideoService.create(db, logger, request, { ...options, evidenceRoots });
  },
  processVideoGeneration(db, logger, id, runtime = {}) {
    return rawVideoService.processVideoGeneration(db, logger, id, { ...runtime, evidenceRoots });
  },
};

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO dramas (title, style, status, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?)`).run('视频测试', 'realistic', now, now);
  db.prepare(`INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at) VALUES (1, 1, ?, ?, ?)`).run('第一集', now, now);
  db.prepare(`INSERT INTO storyboards (episode_id, storyboard_number, title, created_at, updated_at) VALUES (1, 1, ?, ?, ?)`).run('首尾帧视频段', now, now);
  credits.setAccountBalance(db, 'user-1', 100);
  credits.setAccountBalance(db, 'user-2', 100);
  prices.set(db, 'seedance 2.0', 12);
  return db;
}

function configureToapis(db, {
  model = 'seedance-2-fast',
  verificationStatus = 'verified',
  apiKey = 'test-key',
  durations,
  resolutions = ['480p', '720p'],
  pricedResolutions = resolutions,
} = {}) {
  const officialDurations = durations || (model === 'seedance-2-mini'
    ? [4, 8, 10, 12, 15]
    : [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  const config = aiConfig.createConfig(db, log, {
    service_type: 'video',
    provider: 'toapis',
    api_protocol: 'toapis_video',
    name: 'ToAPIs 视频测试',
    base_url: 'https://toapis.com',
    api_key: apiKey,
    model: [model],
    default_model: model,
    is_active: true,
    is_default: true,
  });
  if (verificationStatus !== 'pending') {
    aiConfig.recordVerification(db, config.id, {
      status: verificationStatus,
      capabilities: {
        [model]: withExternalModelEvidence(model, {
          durations: officialDurations,
          resolutions,
          supportsFirstFrame: true,
          supportsLastFrame: true,
          supportsImageReference: true,
          supportsVideoReference: true,
          supportsAudioReference: true,
          supportsAudio: true,
          maxReferences: 9,
        }),
      },
    });
  }
  const resolutionPrices = Object.fromEntries(pricedResolutions.map((resolution) => [
    resolution,
    {
      credits: model === 'seedance-2-mini' && resolution === '720p' ? 595 : model === 'seedance-2-mini' ? 294 : 511,
      cost_micros_per_second: model === 'seedance-2-mini' && resolution === '720p'
        ? 678900
        : model === 'seedance-2-mini' ? 335800 : 584000,
    },
  ]));
  prices.set(db, model, Object.values(resolutionPrices)[0]?.credits || 1, {
    category: 'video',
    cost_unit: 'second',
    resolution_prices: resolutionPrices,
  });
  credits.setAccountBalance(db, 'user-1', 100000);
  return config;
}

function generationSideEffects(db) {
  const hasCostTable = Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'generation_cost_records'"
  ).get());
  return {
    tasks: db.prepare('SELECT COUNT(*) AS count FROM async_tasks').get().count,
    videos: db.prepare('SELECT COUNT(*) AS count FROM video_generations').get().count,
    reservations: db.prepare('SELECT COUNT(*) AS count FROM usage_reservations').get().count,
    costs: hasCostTable
      ? db.prepare('SELECT COUNT(*) AS count FROM generation_cost_records').get().count
      : 0,
  };
}

test('ToAPIs pending strict config blocks generic same-model fallback before every side effect', () => {
  for (const billingEnabled of [false, true]) {
    const db = setup();
    let scheduled = 0;
    aiConfig.createConfig(db, log, {
      service_type: 'video', provider: 'openai', api_protocol: 'openai',
      name: 'generic fallback', base_url: 'https://example.invalid', api_key: 'generic-key',
      model: ['seedance-2-fast'], default_model: 'seedance-2-fast', is_active: true,
    });
    configureToapis(db, { verificationStatus: 'pending' });

    assert.throws(() => videoService.create(db, log, {
      drama_id: 1,
      storyboard_id: 1,
      model: 'seedance-2-fast',
      prompt: 'pending config must not submit',
      duration: 4,
      resolution: '480p',
    }, {
      billingEnabled,
      userId: billingEnabled ? 'user-1' : undefined,
      schedule() { scheduled += 1; },
    }), (error) => error.code === 'MODEL_NOT_VERIFIED');
    assert.deepEqual(generationSideEffects(db), { tasks: 0, videos: 0, reservations: 0, costs: 0 });
    assert.equal(scheduled, 0);
    db.close();
  }
});

test('ToAPIs missing protected credential fails before task, reservation, cost record or schedule', () => {
  const previousKey = process.env.TOAPIS_API_KEY;
  delete process.env.TOAPIS_API_KEY;
  const db = setup();
  let scheduled = 0;
  try {
    configureToapis(db, { apiKey: '' });
    assert.throws(() => videoService.create(db, log, {
      drama_id: 1, storyboard_id: 1, model: 'seedance-2-fast',
      prompt: 'missing key', duration: 4, resolution: '480p',
    }, {
      billingEnabled: true, userId: 'user-1', schedule() { scheduled += 1; },
    }), (error) => error.code === 'MODEL_NOT_VERIFIED');
    assert.deepEqual(generationSideEffects(db), { tasks: 0, videos: 0, reservations: 0, costs: 0 });
    assert.equal(scheduled, 0);
  } finally {
    if (previousKey === undefined) delete process.env.TOAPIS_API_KEY;
    else process.env.TOAPIS_API_KEY = previousKey;
    db.close();
  }
});

test('ToAPIs rejects missing price tier, Mini 5 seconds, 1080P and omitted resolution before side effects', () => {
  const cases = [
    {
      configure: { model: 'seedance-2-fast', pricedResolutions: [] },
      body: { model: 'seedance-2-fast', duration: 4, resolution: '480p' },
      code: 'MODEL_RESOLUTION_PRICE_REQUIRED',
    },
    {
      configure: { model: 'seedance-2-fast', pricedResolutions: ['480p'] },
      body: { model: 'seedance-2-fast', duration: 4, resolution: '720p' },
      code: 'MODEL_RESOLUTION_PRICE_REQUIRED',
    },
    {
      configure: { model: 'seedance-2-mini' },
      body: { model: 'seedance-2-mini', duration: 5, resolution: '480p' },
      code: 'INVALID_VIDEO_DURATION',
    },
    {
      configure: { model: 'seedance-2-fast', durations: [4] },
      body: { model: 'seedance-2-fast', duration: 5, resolution: '480p' },
      code: 'INVALID_VIDEO_DURATION',
    },
    {
      configure: { model: 'seedance-2-fast', resolutions: ['480p'], pricedResolutions: ['480p', '720p'] },
      body: { model: 'seedance-2-fast', duration: 4, resolution: '720p' },
      code: 'MODEL_RESOLUTION_PRICE_REQUIRED',
    },
    {
      configure: { model: 'seedance-2-fast' },
      body: { model: 'seedance-2-fast', duration: 4, resolution: '1080p' },
      code: 'MODEL_RESOLUTION_PRICE_REQUIRED',
    },
    {
      configure: { model: 'seedance-2-fast' },
      body: { model: 'seedance-2-fast', duration: 4 },
      code: 'MODEL_RESOLUTION_PRICE_REQUIRED',
    },
    {
      configure: { model: 'seedance-2-fast' },
      body: { model: 'seedance-2-fast', prompt: '', duration: 4, resolution: '480p' },
      code: 'INVALID_VIDEO_REQUEST',
    },
  ];
  for (const scenario of cases) {
    const db = setup();
    let scheduled = 0;
    configureToapis(db, scenario.configure);
    assert.throws(() => videoService.create(db, log, {
      drama_id: 1,
      storyboard_id: 1,
      prompt: 'strict request validation',
      ...scenario.body,
    }, {
      billingEnabled: true, userId: 'user-1', schedule() { scheduled += 1; },
    }), (error) => error.code === scenario.code, `${scenario.body.model}:${scenario.body.duration}:${scenario.body.resolution}`);
    assert.deepEqual(generationSideEffects(db), { tasks: 0, videos: 0, reservations: 0, costs: 0 });
    assert.equal(scheduled, 0);
    db.close();
  }
});

test('verified ToAPIs Fast 480P 4-second request reserves exact credits and defers route cost', () => {
  const db = setup();
  let scheduled = 0;
  const config = configureToapis(db, { model: 'seedance-2-fast' });

  const created = videoService.create(db, log, {
    drama_id: 1,
    storyboard_id: 1,
    model: 'seedance-2-fast',
    prompt: 'verified four second request',
    duration: 4,
    resolution: '480p',
  }, {
    billingEnabled: true, userId: 'user-1', schedule() { scheduled += 1; },
  });

  const row = db.prepare('SELECT duration, resolution, credit_reservation_id FROM video_generations WHERE id = ?').get(created.id);
  const task = db.prepare('SELECT credit_reservation_id, model FROM async_tasks WHERE id = ?').get(created.task_id);
  assert.deepEqual({ duration: row.duration, resolution: row.resolution }, { duration: 4, resolution: '480p' });
  assert.equal(credits.getReservation(db, row.credit_reservation_id).amount, 2044);
  assert.deepEqual(task, {
    credit_reservation_id: row.credit_reservation_id,
    model: 'seedance-2-fast',
  });
  assert.deepEqual(
    db.prepare('SELECT model, quantity, resolution, cost_micros, cost_source FROM generation_cost_records').get(),
    { model: 'seedance-2-fast', quantity: 0, resolution: '480p', cost_micros: 0, cost_source: 'unavailable' },
  );
  assert.equal(scheduled, 1);

  assert.throws(() => videoService.create(db, log, {
    drama_id: 1,
    storyboard_id: 1,
    model: 'seedance-2-fast',
    prompt: 'different resolution must not reuse',
    duration: 4,
    resolution: '720p',
  }, {
    billingEnabled: true, userId: 'user-1', schedule() { scheduled += 1; },
  }), (error) => error.code === 'VIDEO_GENERATION_ACTIVE');
  assert.deepEqual(generationSideEffects(db), { tasks: 1, videos: 1, reservations: 1, costs: 1 });
  assert.equal(scheduled, 1);

  aiConfig.recordVerification(db, config.id, { status: 'pending', capabilities: {} });
  assert.throws(() => videoService.create(db, log, {
    drama_id: 1,
    storyboard_id: 1,
    model: 'seedance-2-fast',
    prompt: 'active task must not bypass downgraded verification',
    duration: 4,
    resolution: '480p',
  }, {
    billingEnabled: true, userId: 'user-1', schedule() { scheduled += 1; },
  }), (error) => error.code === 'MODEL_NOT_VERIFIED');
  assert.deepEqual(generationSideEffects(db), { tasks: 1, videos: 1, reservations: 1, costs: 1 });
  assert.equal(scheduled, 1);
  db.close();
});

test('ToAPIs protected environment credential is valid but cannot replace model capability evidence', () => {
  const previousKey = process.env.TOAPIS_API_KEY;
  process.env.TOAPIS_API_KEY = 'environment-test-key';
  const db = setup();
  try {
    const config = configureToapis(db, { apiKey: '' });
    aiConfig.recordVerification(db, config.id, {
      status: 'verified',
      capabilities: {
        'another-model': { durations: [4], resolutions: ['480p'] },
      },
    });
    assert.throws(() => videoService.create(db, log, {
      drama_id: 1, storyboard_id: 1, model: 'seedance-2-fast',
      prompt: 'wrong capability object', duration: 4, resolution: '480p',
    }, { billingEnabled: false, schedule() {} }), (error) => error.code === 'MODEL_NOT_VERIFIED');
    assert.deepEqual(generationSideEffects(db), { tasks: 0, videos: 0, reservations: 0, costs: 0 });

    aiConfig.recordVerification(db, config.id, {
      status: 'verified',
      capabilities: {
        'seedance-2-fast': withExternalModelEvidence('seedance-2-fast', {
          durations: [4], resolutions: ['480p'],
          supportsFirstFrame: true, supportsLastFrame: true,
          supportsImageReference: true, supportsVideoReference: true,
          supportsAudioReference: true, supportsAudio: true,
        }),
      },
    });
    const created = videoService.create(db, log, {
      drama_id: 1, storyboard_id: 1, model: 'seedance-2-fast',
      prompt: 'environment credential accepted', duration: 4, resolution: '480p',
    }, { billingEnabled: false, schedule() {} });
    assert.ok(created.id);
  } finally {
    if (previousKey === undefined) delete process.env.TOAPIS_API_KEY;
    else process.env.TOAPIS_API_KEY = previousKey;
    db.close();
  }
});

test('scheduled ToAPIs Fast 4-second task reaches provider adapter and preserves indeterminate submission for review', async () => {
  const db = setup();
  configureToapis(db, { model: 'seedance-2-fast' });
  let scheduled;
  let submitted;
  const originalCall = videoClient.callVideoApi;
  videoClient.callVideoApi = async (_db, _log, options) => {
    submitted = options;
    return { indeterminate: true, error: 'test indeterminate result' };
  };
  try {
    const created = videoService.create(db, log, {
      drama_id: 1, storyboard_id: 1, model: 'seedance-2-fast',
      prompt: 'four second async path', duration: 4, resolution: '480p',
    }, {
      billingEnabled: true,
      userId: 'user-1',
      schedule(callback) { scheduled = callback; },
    });
    assert.equal(typeof scheduled, 'function');
    await scheduled();
    assert.equal(submitted.model, 'seedance-2-fast');
    assert.equal(submitted.duration, 4);
    assert.equal(submitted.resolution, '480p');
    const row = db.prepare('SELECT status, error_msg FROM video_generations WHERE id = ?').get(created.id);
    assert.equal(row.status, 'needs_attention');
    assert.match(row.error_msg, /^VIDEO_SUBMISSION_INDETERMINATE:/);
  } finally {
    videoClient.callVideoApi = originalCall;
    db.close();
  }
});

test('ToAPIs verification downgrade after reservation prevents supplier POST and refunds locally', async () => {
  const db = setup();
  const config = configureToapis(db, { model: 'seedance-2-fast' });
  let scheduled;
  let supplierCalls = 0;
  const originalCall = videoClient.callVideoApi;
  videoClient.callVideoApi = async () => {
    supplierCalls += 1;
    return { task_id: 'must-not-exist' };
  };
  try {
    const created = videoService.create(db, log, {
      drama_id: 1, storyboard_id: 1, model: 'seedance-2-fast',
      prompt: 'downgrade before submit', duration: 4, resolution: '480p',
    }, {
      billingEnabled: true,
      userId: 'user-1',
      schedule(callback) { scheduled = callback; },
    });
    aiConfig.recordVerification(db, config.id, { status: 'pending', capabilities: {} });
    await scheduled();
    assert.equal(supplierCalls, 0);
    const row = db.prepare('SELECT status, credit_reservation_id FROM video_generations WHERE id = ?').get(created.id);
    assert.equal(row.status, 'failed');
    assert.equal(credits.getReservation(db, row.credit_reservation_id).status, 'refunded');
  } finally {
    videoClient.callVideoApi = originalCall;
    db.close();
  }
});

test('画布视频明确失败状态即使错误文案含未知也立即退款', async () => {
  const db = setup();
  const originalCall = videoClient.callVideoApi;
  const originalGetDefaultVideoConfig = videoClient.getDefaultVideoConfig;
  videoClient.getDefaultVideoConfig = () => ({
    model: 'seedance 2.0',
    api_url: 'https://example.com',
  });
  videoClient.callVideoApi = async () => ({ error: '网络中断，供应商结果未知' });
  try {
    const created = videoService.create(db, log, {
      drama_id: 1,
      storyboard_id: 1,
      model: 'seedance 2.0',
      prompt: '明确失败即时退款',
      duration: 5,
    }, { billingEnabled: true, userId: 'user-1', schedule() {} });

    await videoService.processVideoGeneration(db, log, created.id);

    const row = db.prepare(
      'SELECT status, credit_reservation_id FROM video_generations WHERE id = ?',
    ).get(created.id);
    assert.equal(row.status, 'failed');
    assert.equal(credits.getReservation(db, row.credit_reservation_id).status, 'refunded');
  } finally {
    videoClient.callVideoApi = originalCall;
    videoClient.getDefaultVideoConfig = originalGetDefaultVideoConfig;
    db.close();
  }
});

function create(db, userId) {
  return videoService.create(db, log, {
    drama_id: 1,
    storyboard_id: 1,
    model: 'seedance 2.0',
    prompt: '固定首帧与尾帧之间的连续动作',
    first_frame_url: 'https://example.com/first.jpg',
    last_frame_url: 'https://example.com/last.jpg',
    duration: 5,
  }, { billingEnabled: true, userId, schedule() {} });
}

test('视频任务按每秒单价乘用户选择时长预扣积分', () => {
  const db = setup();
  prices.set(db, 'seedance 2.0', 3);

  const created = videoService.create(db, log, {
    drama_id: 1,
    storyboard_id: 1,
    model: 'seedance 2.0',
    prompt: '8 秒视频计费测试',
    duration: 8,
  }, { billingEnabled: true, userId: 'user-1', schedule() {} });

  const row = db.prepare('SELECT duration, credit_reservation_id FROM video_generations WHERE id = ?').get(created.id);
  assert.equal(row.duration, 8);
  assert.equal(credits.getReservation(db, row.credit_reservation_id).amount, 24);
  assert.equal(credits.getAccount(db, 'user-1').held, 24);
  db.close();
});

test('视频任务按模型能力分别持久化图片、音频和视频参考', () => {
  const db = setup();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, name, base_url, api_key, model, default_model, is_default, is_active, settings, created_at, updated_at)
    VALUES ('video', 'custom', '全媒体参考', 'https://video.example', 'test-key', ?, 'omni-model', 1, 1, ?, ?, ?)`)
    .run(JSON.stringify(['omni-model']), JSON.stringify({
      canvas_capabilities: {
        referenceTypes: ['image', 'audio', 'video'],
        maxImageReferences: 10,
        maxAudioReferences: 1,
        maxVideoReferences: 1,
      },
    }), now, now);

  const created = videoService.create(db, log, {
    drama_id: 1,
    model: 'omni-model',
    prompt: '全媒体参考入库测试',
    reference_image_urls: ['/static/ref-1.jpg', '/static/ref-2.jpg'],
    reference_audio_urls: ['/static/voice.wav'],
    reference_video_urls: ['/static/motion.mp4'],
  }, { schedule() {} });
  const row = db.prepare(`SELECT reference_image_urls, reference_audio_urls, reference_video_urls
    FROM video_generations WHERE id = ?`).get(created.id);
  assert.deepEqual(JSON.parse(row.reference_image_urls), ['/static/ref-1.jpg', '/static/ref-2.jpg']);
  assert.deepEqual(JSON.parse(row.reference_audio_urls), ['/static/voice.wav']);
  assert.deepEqual(JSON.parse(row.reference_video_urls), ['/static/motion.mp4']);
  db.close();
});

test('video-v1 在创建付费任务前拒绝音频参考', () => {
  const db = setup();
  assert.throws(() => videoService.create(db, log, {
    drama_id: 1,
    model: 'video-v1',
    prompt: '不支持的音频参考',
    reference_audio_urls: ['/static/voice.wav'],
  }, { billingEnabled: true, userId: 'user-1', schedule() {} }), (error) => error.code === 'UNSUPPORTED_VIDEO_REFERENCE');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_generations').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage_reservations').get().count, 0);
  db.close();
});

test('视频任务缺少显式时长时按 5 秒入库并计费', () => {
  const db = setup();
  prices.set(db, 'seedance 2.0', 2);

  const created = videoService.create(db, log, {
    drama_id: 1,
    storyboard_id: 1,
    model: 'seedance 2.0',
    prompt: '默认时长计费测试',
  }, { billingEnabled: true, userId: 'user-1', schedule() {} });

  const row = db.prepare('SELECT duration, credit_reservation_id FROM video_generations WHERE id = ?').get(created.id);
  assert.equal(row.duration, 5);
  assert.equal(credits.getReservation(db, row.credit_reservation_id).amount, 10);
  db.close();
});

test('中转站限定的 NewAPI 模型创建后固定原配置且按限定 ID 计费', () => {
  const db = setup();
  aiConfig.createConfig(db, log, {
    service_type: 'video', provider: 'usmercari', api_protocol: 'usmercari_media',
    name: '另一中转站', base_url: 'https://other.example', api_key: 'other-secret',
    model: ['seedance-2.0-mini'], default_model: 'seedance-2.0-mini', is_active: true,
  });
  const config = aiConfig.createConfig(db, log, {
    service_type: 'video', provider: 'newapi', api_protocol: 'newapi_video',
    name: 'NewAPI megabyai', base_url: 'https://newapi.example', api_key: 'newapi-secret',
    model: ['seedance-2.0-mini'], default_model: 'seedance-2.0-mini', is_active: true,
  });
  aiConfig.recordVerification(db, config.id, {
    status: 'verified',
    capabilities: {
      'seedance-2.0-mini': {
        validated: true,
        durations: [4],
        aspectRatios: ['16:9'],
        resolutions: ['480p'],
      },
    },
  });
  const selection = `cfg-${config.id}::seedance-2.0-mini`;
  prices.set(db, selection, 44, {
    category: 'video', billingUnit: 'second', costUnit: 'second',
    resolution_prices: { '480p': { credits: 44, cost_micros_per_second: 50000 } },
  });
  credits.setAccountBalance(db, 'user-1', 10000);

  const created = videoService.create(db, log, {
    drama_id: 1,
    storyboard_id: 1,
    model: selection,
    prompt: 'NewAPI 限定路由测试',
    duration: 4,
    aspect_ratio: '16:9',
    resolution: '480p',
  }, { billingEnabled: true, userId: 'user-1', schedule() {} });
  const row = db.prepare(`SELECT model, provider, duration, ai_service_config_id, credit_reservation_id
    FROM video_generations WHERE id = ?`).get(created.id);
  const task = db.prepare('SELECT model FROM async_tasks WHERE id = ?').get(created.task_id);

  assert.equal(row.model, 'seedance-2.0-mini');
  assert.equal(row.provider, 'newapi');
  assert.equal(row.duration, 4);
  assert.equal(row.ai_service_config_id, config.id);
  assert.equal(task.model, selection);
  assert.equal(credits.getReservation(db, row.credit_reservation_id).amount, 176);
  db.close();
});

test('视频节点未覆盖时使用模型配置的默认时长计费', () => {
  const db = setup();
  prices.set(db, 'seedance 2.0', 3);
  db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, base_url, api_key, model, default_model, is_default, is_active, settings)
    VALUES ('video', 'djpsd', 'Seedance 计费测试', 'https://example.com', 'test-key', ?, 'seedance 2.0', 1, 1, ?)
  `).run(JSON.stringify(['seedance 2.0']), JSON.stringify({ video_duration: 11 }));

  const created = videoService.create(db, log, {
    drama_id: 1,
    storyboard_id: 1,
    model: 'seedance 2.0',
    prompt: '模型默认时长测试',
  }, { billingEnabled: true, userId: 'user-1', schedule() {} });

  const row = db.prepare('SELECT duration, credit_reservation_id FROM video_generations WHERE id = ?').get(created.id);
  assert.equal(row.duration, 11);
  assert.equal(credits.getReservation(db, row.credit_reservation_id).amount, 33);
  db.close();
});

test('视频任务拒绝 5 到 15 秒之外或非整数的时长', () => {
  for (const duration of [4, 16, 7.5]) {
    const db = setup();
    assert.throws(() => videoService.create(db, log, {
      drama_id: 1,
      storyboard_id: 1,
      model: 'seedance 2.0',
      prompt: '非法时长测试',
      duration,
    }, { billingEnabled: true, userId: 'user-1', schedule() {} }), (error) => error.code === 'INVALID_VIDEO_DURATION');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_generations').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage_reservations').get().count, 0);
    db.close();
  }
});

test('iCreat Seedance Mini 和 Fast 的 4 秒任务可创建并进入供应商调用', async () => {
  const originalCallVideoApi = videoClient.callVideoApi;
  const originalGetDefaultVideoConfig = videoClient.getDefaultVideoConfig;
  const submitted = [];
  videoClient.getDefaultVideoConfig = (_db, model) => ({
    model,
    default_model: model,
    provider: 'icreat',
    settings: '{}',
  });
  videoClient.callVideoApi = async (_db, _log, payload) => {
    submitted.push({ model: payload.model, duration: payload.duration });
    return { error: '结束测试任务，不访问外部供应商' };
  };

  try {
    for (const model of [
      'bytedance/seedance-2-0-mini',
      'bytedance/seedance-2-0-fast',
    ]) {
      const db = setup();
      credits.setAccountBalance(db, 'user-1', 1000);
      prices.set(db, model, 60, { category: 'video', cost_unit: 'second' });
      const created = videoService.create(db, log, {
        drama_id: 1,
        model,
        prompt: 'iCreat 4 秒任务',
        duration: 4,
      }, { billingEnabled: true, userId: 'user-1', schedule() {} });

      const row = db.prepare('SELECT duration, credit_reservation_id FROM video_generations WHERE id = ?').get(created.id);
      assert.equal(row.duration, 4);
      assert.equal(credits.getReservation(db, row.credit_reservation_id).amount, 240);
      await videoService.processVideoGeneration(db, log, created.id);
      db.close();
    }
  } finally {
    videoClient.callVideoApi = originalCallVideoApi;
    videoClient.getDefaultVideoConfig = originalGetDefaultVideoConfig;
  }

  assert.deepEqual(submitted, [
    { model: 'bytedance/seedance-2-0-mini', duration: 4 },
    { model: 'bytedance/seedance-2-0-fast', duration: 4 },
  ]);
});

test('已有处理中任务时仍校验时长且不静默复用不同秒数', () => {
  const db = setup();
  prices.set(db, 'seedance 2.0', 2);
  videoService.create(db, log, {
    drama_id: 1,
    storyboard_id: 1,
    model: 'seedance 2.0',
    prompt: '处理中 5 秒任务',
    duration: 5,
  }, { billingEnabled: true, userId: 'user-1', schedule() {} });

  assert.throws(() => videoService.create(db, log, {
    drama_id: 1,
    storyboard_id: 1,
    model: 'seedance 2.0',
    prompt: '非法 16 秒任务',
    duration: 16,
  }, { billingEnabled: true, userId: 'user-1', schedule() {} }), (error) => error.code === 'INVALID_VIDEO_DURATION');
  assert.throws(() => videoService.create(db, log, {
    drama_id: 1,
    storyboard_id: 1,
    model: 'seedance 2.0',
    prompt: '改为 8 秒任务',
    duration: 8,
  }, { billingEnabled: true, userId: 'user-1', schedule() {} }), (error) => error.code === 'VIDEO_GENERATION_ACTIVE');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_generations').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage_reservations').get().count, 1);
  db.close();
});

test('seedance 2.0 首尾帧视频任务按用户隔离幂等预扣', () => {
  const db = setup();
  const first = create(db, 'user-1');
  const sameUser = create(db, 'user-1');
  const otherUser = create(db, 'user-2');

  assert.equal(sameUser.id, first.id);
  assert.equal(sameUser.reused, true);
  assert.notEqual(otherUser.id, first.id);
  const rows = db.prepare('SELECT id, user_id, model, first_frame_url, last_frame_url, credit_reservation_id FROM video_generations ORDER BY id').all();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.user_id), ['user-1', 'user-2']);
  assert.deepEqual(rows.map((row) => row.model), ['seedance 2.0', 'seedance 2.0']);
  assert.equal(rows[0].first_frame_url, 'https://example.com/first.jpg');
  assert.equal(rows[0].last_frame_url, 'https://example.com/last.jpg');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage_reservations').get().count, 2);
  assert.equal(credits.getAccount(db, 'user-1').held, 60);
  assert.equal(credits.getAccount(db, 'user-2').held, 60);

  videoService.settleVideoCredit(db, log, rows[0], 'completed');
  videoService.settleVideoCredit(db, log, rows[1], 'failed', '供应商明确失败');
  assert.equal(credits.getReservation(db, rows[0].credit_reservation_id).status, 'confirmed');
  assert.equal(credits.getReservation(db, rows[1].credit_reservation_id).status, 'refunded');
  assert.equal(credits.getAccount(db, 'user-1').spent, 60);
  assert.equal(credits.getAccount(db, 'user-2').available, 100);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type IN ('generation.video.completed', 'generation.video.failed')").get().count, 2);
  db.close();
});

test('公开计费视频创建缺少用户身份时拒绝，不泄露处理中任务', () => {
  const db = setup();
  assert.throws(() => videoService.create(db, log, {
    drama_id: 1, storyboard_id: 1, model: 'seedance 2.0', prompt: 'test',
  }, { billingEnabled: true, schedule() {} }), (error) => error.code === 'UNAUTHORIZED');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_generations').get().count, 0);
  db.close();
});

test('视频请求缺少提示词和模型时读取分镜持久化配置并固化声线', () => {
  const db = setup();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO characters (drama_id, name, voice_style, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(1, '小狐狸', 'bright youthful voice, clear diction', now, now);
  const characterId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare(
    `UPDATE storyboards
     SET characters = ?, dialogue = ?, video_prompt = ?, video_model = ?
     WHERE id = 1`
  ).run(
    JSON.stringify([characterId]),
    '小狐狸：我们继续往前走。',
    '雨后森林，镜头跟随小狐狸向前走。',
    'grok-video-3'
  );

  const created = videoService.create(db, log, {
    drama_id: 1,
    storyboard_id: 1,
  }, { billingEnabled: false, schedule() {} });

  assert.equal(created.model, 'grok-video-3');
  assert.match(created.prompt, /雨后森林/);
  assert.match(created.prompt, /VOICE CONTINUITY/);
  assert.match(created.prompt, /bright youthful voice, clear diction/);
  const persisted = db.prepare('SELECT video_prompt FROM storyboards WHERE id = 1').get();
  assert.match(persisted.video_prompt, /VOICE CONTINUITY/);

  db.prepare("UPDATE video_generations SET status = 'failed' WHERE id = ?").run(created.id);
  const explicit = videoService.create(db, log, {
    drama_id: 1,
    storyboard_id: 1,
    prompt: '显式覆盖后的镜头动作',
    model: 'explicit-video-model',
  }, { billingEnabled: false, schedule() {} });
  assert.equal(explicit.model, 'explicit-video-model');
  assert.match(explicit.prompt, /显式覆盖后的镜头动作/);
  assert.match(explicit.prompt, /VOICE CONTINUITY/);
  assert.match(explicit.prompt, /bright youthful voice, clear diction/);
  db.close();
});

test('持久化分镜提示词和模型会传入实际视频供应商请求', async () => {
  const db = setup();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO characters (drama_id, name, voice_style, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(1, '小狐狸', 'bright youthful voice, clear diction', now, now);
  const characterId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare(
    `UPDATE storyboards
     SET characters = ?, dialogue = ?, video_prompt = ?, video_model = ?
     WHERE id = 1`
  ).run(
    JSON.stringify([characterId]),
    '小狐狸：我们继续往前走。',
    '雨后森林，镜头跟随小狐狸向前走。',
    'grok-video-3'
  );

  const callbacks = [];
  let captured = null;
  const originalCallVideoApi = videoClient.callVideoApi;
  const originalGetDefaultVideoConfig = videoClient.getDefaultVideoConfig;
  videoClient.callVideoApi = async (_db, _log, payload) => {
    captured = payload;
    return { error: 'capture-only: do not send provider request' };
  };
  videoClient.getDefaultVideoConfig = () => ({ model: 'grok-video-3', api_url: 'https://example.com' });
  try {
    const created = videoService.create(db, log, {
      drama_id: 1,
      storyboard_id: 1,
    }, { billingEnabled: false, schedule(callback) { callbacks.push(callback); } });
    await callbacks[0]();
    assert.equal(created.model, 'grok-video-3');
    assert.equal(captured.model, 'grok-video-3');
    assert.match(captured.prompt, /雨后森林/);
    assert.match(captured.prompt, /VOICE CONTINUITY/);
    assert.match(captured.prompt, /bright youthful voice, clear diction/);
  } finally {
    videoClient.callVideoApi = originalCallVideoApi;
    videoClient.getDefaultVideoConfig = originalGetDefaultVideoConfig;
    db.close();
  }
});

test('已失败的视频任务不会被生成处理重新拉回 processing', async () => {
  const db = setup();
  const originalCallVideoApi = videoClient.callVideoApi;
  const originalGetDefaultVideoConfig = videoClient.getDefaultVideoConfig;
  const originalUpdateTaskStatus = taskService.updateTaskStatus;
  const processingUpdates = [];
  let providerCalls = 0;
  try {
    const created = videoService.create(db, log, {
      drama_id: 1,
      storyboard_id: 1,
      model: 'seedance 2.0',
      prompt: '验证失败任务状态保持不变',
      reference_image_urls: ['https://example.com/ref.png'],
    }, { billingEnabled: false, schedule() {} });
    db.prepare("UPDATE async_tasks SET status = 'failed' WHERE id = ?").run(created.task_id);

    videoClient.getDefaultVideoConfig = () => ({ model: 'seedance 2.0', api_url: 'https://example.com' });
    videoClient.callVideoApi = async () => {
      providerCalls += 1;
      return { error: 'expected provider failure' };
    };
    taskService.updateTaskStatus = (...args) => {
      if (args[2] === 'processing') processingUpdates.push(args);
      return originalUpdateTaskStatus(...args);
    };

    await videoService.processVideoGeneration(db, log, created.id);

    assert.equal(taskService.getTask(db, created.task_id).status, 'failed');
    assert.equal(processingUpdates.length, 0);
    assert.equal(providerCalls, 1);
  } finally {
    taskService.updateTaskStatus = originalUpdateTaskStatus;
    videoClient.callVideoApi = originalCallVideoApi;
    videoClient.getDefaultVideoConfig = originalGetDefaultVideoConfig;
    db.close();
  }
});

test('供应商请求使用已计费时长，不被旧分镜时长覆盖', async () => {
  const db = setup();
  prices.set(db, 'seedance 2.0', 3);
  db.prepare('UPDATE storyboards SET duration = 30 WHERE id = 1').run();

  const callbacks = [];
  let capturedDuration = null;
  const originalCallVideoApi = videoClient.callVideoApi;
  const originalGetDefaultVideoConfig = videoClient.getDefaultVideoConfig;
  videoClient.callVideoApi = async (_db, _log, payload) => {
    capturedDuration = payload.duration;
    return { error: 'capture-only: do not send provider request' };
  };
  videoClient.getDefaultVideoConfig = () => ({ model: 'seedance 2.0', api_url: 'https://example.com' });
  try {
    const created = videoService.create(db, log, {
      drama_id: 1,
      storyboard_id: 1,
      model: 'seedance 2.0',
      prompt: '按 8 秒计费并生成',
      duration: 8,
    }, {
      billingEnabled: true,
      userId: 'user-1',
      schedule(callback) { callbacks.push(callback); },
    });
    const row = db.prepare('SELECT credit_reservation_id FROM video_generations WHERE id = ?').get(created.id);
    assert.equal(credits.getReservation(db, row.credit_reservation_id).amount, 24);

    await callbacks[0]();
    assert.equal(capturedDuration, 8);
  } finally {
    videoClient.callVideoApi = originalCallVideoApi;
    videoClient.getDefaultVideoConfig = originalGetDefaultVideoConfig;
    db.close();
  }
});

test('USMercari 多图参考入库时不混入首帧字段', () => {
  const db = setup();
  const originalGetDefaultVideoConfig = videoClient.getDefaultVideoConfig;
  try {
    videoClient.getDefaultVideoConfig = () => ({
      provider: 'usmercari',
      api_protocol: 'usmercari_media',
      default_model: 'MiniMax H3',
    });
    const created = videoService.create(db, log, {
      drama_id: 1,
      model: 'MiniMax H3',
      prompt: '多图参考链路',
      duration: 5,
      reference_image_urls: ['/static/reference-1.png', '/static/reference-2.png'],
    }, { billingEnabled: false, schedule() {} });

    const row = db.prepare('SELECT first_frame_url, reference_image_urls FROM video_generations WHERE id = ?').get(created.id);
    assert.equal(row.first_frame_url, null);
    assert.deepEqual(JSON.parse(row.reference_image_urls), ['/static/reference-1.png', '/static/reference-2.png']);
  } finally {
    videoClient.getDefaultVideoConfig = originalGetDefaultVideoConfig;
    db.close();
  }
});

test('ToAPIs 全能参考保持首帧字段与请求快照互斥', () => {
  const db = setup();
  const previousStorageBaseUrl = process.env.STORAGE_BASE_URL;
  try {
    process.env.STORAGE_BASE_URL = 'https://cdn.example/static';
    configureToapis(db);
    const now = new Date().toISOString();
    const insertAsset = db.prepare(`INSERT INTO assets
      (drama_id, name, type, url, local_path, metadata, created_at, updated_at)
      VALUES (1, ?, 'image', ?, ?, '{}', ?, ?)`);
    for (const name of ['reference-1.png', 'reference-2.png']) {
      const relativePath = `projects/0001/assets/${name}`;
      insertAsset.run(name, `/static/${relativePath}`, relativePath, now, now);
    }
    const created = videoService.create(db, log, {
      drama_id: 1,
      model: 'seedance-2-fast',
      prompt: '全能参考链路',
      duration: 4,
      resolution: '480p',
      reference_mode: 'omni',
      reference_image_urls: [
        'https://cdn.example/static/projects/0001/assets/reference-1.png',
        'https://cdn.example/static/projects/0001/assets/reference-2.png',
      ],
      generate_audio: false,
    }, { billingEnabled: false, schedule() {} });

    const row = db.prepare(
      'SELECT first_frame_url, reference_mode, request_snapshot FROM video_generations WHERE id = ?',
    ).get(created.id);
    const snapshot = JSON.parse(row.request_snapshot);
    assert.equal(row.first_frame_url, null);
    assert.equal(row.reference_mode, 'omni');
    assert.equal(snapshot.first_frame_url, null);
    assert.equal(snapshot.reference_mode, 'omni');
    assert.deepEqual(snapshot.reference_image_urls, [
      'https://cdn.example/static/projects/0001/assets/reference-1.png',
      'https://cdn.example/static/projects/0001/assets/reference-2.png',
    ]);
  } finally {
    if (previousStorageBaseUrl === undefined) delete process.env.STORAGE_BASE_URL;
    else process.env.STORAGE_BASE_URL = previousStorageBaseUrl;
    db.close();
  }
});

test('普通视频参考链把第一张参考图保存为首帧证据', () => {
  const db = setup();
  const originalGetDefaultVideoConfig = videoClient.getDefaultVideoConfig;
  try {
    videoClient.getDefaultVideoConfig = () => ({
      provider: 'mock',
      api_protocol: 'openai_compat',
      default_model: 'seedance 2.0',
    });
    const created = videoService.create(db, log, {
      drama_id: 1,
      model: 'seedance 2.0',
      prompt: '首帧参考链路',
      duration: 5,
      reference_image_urls: ['/static/reference-1.png', '/static/reference-2.png'],
    }, { billingEnabled: false, schedule() {} });

    const row = db.prepare('SELECT first_frame_url, reference_image_urls FROM video_generations WHERE id = ?').get(created.id);
    assert.equal(row.first_frame_url, '/static/reference-1.png');
    assert.deepEqual(JSON.parse(row.reference_image_urls), ['/static/reference-1.png', '/static/reference-2.png']);
  } finally {
    videoClient.getDefaultVideoConfig = originalGetDefaultVideoConfig;
    db.close();
  }
});

test('视频任务按所选 480P 或 720P 分辨率预扣积分但创建阶段不猜供应商成本', () => {
  const db = setup();
  prices.set(db, 'seedance 2.0', 3, {
    category: 'video',
    cost_unit: 'second',
    resolution_prices: {
      '480p': { credits: 3, cost_micros_per_second: 50000 },
      '720p': { credits: 5, cost_micros_per_second: 120000 },
    },
  });

  const amounts = [];
  for (const [userId, resolution] of [['user-1', '480P'], ['user-2', '720p']]) {
    const created = videoService.create(db, log, {
      drama_id: 1,
      storyboard_id: 1,
      model: 'seedance 2.0',
      prompt: `${resolution} 视频计费测试`,
      duration: 5,
      resolution,
    }, { billingEnabled: true, userId, schedule() {} });
    const row = db.prepare('SELECT credit_reservation_id FROM video_generations WHERE id = ?').get(created.id);
    amounts.push(credits.getReservation(db, row.credit_reservation_id).amount);
  }

  assert.deepEqual(amounts, [15, 25]);
  assert.deepEqual(
    db.prepare('SELECT resolution, cost_micros, cost_source FROM generation_cost_records ORDER BY resolution').all(),
    [
      { resolution: '480p', cost_micros: 0, cost_source: 'unavailable' },
      { resolution: '720p', cost_micros: 0, cost_source: 'unavailable' },
    ],
  );
  db.close();
});

test('视频成功按最终 config_id 与分辨率线路成本结算', () => {
  const db = setup();
  prices.set(db, 'seedance 2.0', 3, {
    category: 'video', cost_unit: 'second',
    resolution_prices: { '720p': { credits: 5, cost_micros_per_second: 1 } },
  });
  const config = aiConfig.createConfig(db, log, {
    service_type: 'video', provider: 'video-cost-route', name: '视频成本线路',
    base_url: 'https://video-cost.invalid/v1', api_key: 'test-key',
    model: ['video-upstream'], default_model: 'video-upstream',
    logical_model_id: 'seedance 2.0', is_active: true,
  });
  routeCosts.setRouteCost(db, config.id, {
    cost_unit: 'second', micros_per_unit: 50_000,
    resolution_prices: { '720p': { micros_per_unit: 120_000 } },
  });
  const created = videoService.create(db, log, {
    drama_id: 1, storyboard_id: 1, model: 'seedance 2.0',
    prompt: '线路成本结算', duration: 5, resolution: '720p',
  }, { billingEnabled: true, userId: 'user-1', schedule() {} });
  db.prepare('UPDATE video_generations SET config_id = ? WHERE id = ?').run(config.id, created.id);
  const row = db.prepare('SELECT * FROM video_generations WHERE id = ?').get(created.id);

  videoService.settleVideoCredit(db, log, row, 'completed');

  assert.deepEqual(
    db.prepare('SELECT config_id, cost_micros, cost_source FROM generation_cost_records WHERE reservation_id = ?')
      .get(row.credit_reservation_id),
    { config_id: config.id, cost_micros: 600_000, cost_source: 'provider_route' },
  );
  db.close();
});

test('fumin 参考媒体超限在建任务和预扣积分前拒绝', () => {
  const db = setup();
  const originalGetDefaultVideoConfig = videoClient.getDefaultVideoConfig;
  prices.set(db, 'fumin-seedance-2.0-fast', 107, {
    category: 'video',
    cost_unit: 'second',
    cost_micros_per_second: 280000,
  });
  try {
    videoClient.getDefaultVideoConfig = () => ({
      provider: 'fumin',
      api_protocol: 'fumin_video',
      default_model: 'fumin-seedance-2.0-fast',
    });

    assert.throws(() => videoService.create(db, log, {
      drama_id: 1,
      storyboard_id: 1,
      model: 'fumin-seedance-2.0-fast',
      prompt: '超限参考图不应进入队列',
      duration: 15,
      reference_image_urls: Array.from({ length: 10 }, (_, index) => `/static/reference-${index + 1}.png`),
    }, { billingEnabled: true, userId: 'user-1', schedule() {} }),
    (error) => error.code === 'VIDEO_REFERENCE_LIMIT_EXCEEDED');

    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_generations').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage_reservations').get().count, 0);
    assert.equal(credits.getAccount(db, 'user-1').held, 0);
  } finally {
    videoClient.getDefaultVideoConfig = originalGetDefaultVideoConfig;
    db.close();
  }
});
