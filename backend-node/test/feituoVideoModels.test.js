const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  FEITUO_MODELS,
  buildFeituoVideoBody,
} = require('../src/services/feituoVideoClient');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const canvasModelCatalogService = require('../src/services/canvasModelCatalogService');
const creditLedgerService = require('../src/services/creditLedgerService');
const modelPriceService = require('../src/services/modelPriceService');
const videoClient = require('../src/services/videoClient');
const videoService = require('../src/services/videoService');

const log = { info() {}, warn() {}, error() {} };
const H3_MODEL = 'xuan-video-v1-6e7b4763634e6206';
const SEEDANCE_MODEL = 'xuan-seedance-2.5';
const SEEDANCE_DURATIONS = Array.from({ length: 27 }, (_, index) => index + 4);

function verifiedCapabilities() {
  return {
    [H3_MODEL]: {
      resolutions: ['2k'],
      durations: [15],
      aspectRatios: ['16:9'],
      supportsFirstFrame: false,
      supportsLastFrame: false,
      supportsImageReference: false,
      supportsVideoReference: false,
      supportsAudioReference: false,
      supportsAudio: false,
      maxReferences: 0,
      maxVideoReferences: 0,
      maxAudioReferences: 0,
    },
    [SEEDANCE_MODEL]: {
      resolutions: ['480p', '720p'],
      durations: SEEDANCE_DURATIONS,
      aspectRatios: ['16:9'],
      supportsFirstFrame: false,
      supportsLastFrame: false,
      supportsImageReference: true,
      supportsVideoReference: true,
      supportsAudioReference: true,
      supportsAudio: false,
      referenceTypes: ['image', 'video', 'audio'],
      maxReferences: 30,
      maxImageReferences: 30,
      maxVideoReferences: 10,
      maxAudioReferences: 10,
    },
  };
}

function setupDb(t, options = {}) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const dramaId = Number(db.prepare(
    `INSERT INTO dramas (tenant_id, user_id, title, status, metadata, created_at, updated_at)
     VALUES ('tenant-1', 'user-1', '飞拓测试', 'draft', '{}', ?, ?)`,
  ).run(now, now).lastInsertRowid);
  db.prepare(
    `INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at)
     VALUES (?, 1, '第一集', ?, ?)`,
  ).run(dramaId, now, now);
  const storyboardId = Number(db.prepare(
    `INSERT INTO storyboards (episode_id, storyboard_number, title, created_at, updated_at)
     VALUES (1, 1, '分镜', ?, ?)`,
  ).run(now, now).lastInsertRowid);
  const settings = {
    real_generation_verified_models: options.realVerified === false
      ? []
      : [H3_MODEL, SEEDANCE_MODEL],
  };
  const configId = Number(db.prepare(
    `INSERT INTO ai_service_configs
      (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
       is_active, is_default, priority, verification_status, verified_capabilities, settings,
       created_at, updated_at)
     VALUES ('video', 'feituo', 'feituo_open', '飞拓测试', 'https://feituokuajing.com',
       'test-key', ?, ?, 1, 1, 0, ?, ?, ?, ?, ?)`,
  ).run(
    JSON.stringify([H3_MODEL, SEEDANCE_MODEL]),
    SEEDANCE_MODEL,
    options.verificationStatus || 'verified',
    JSON.stringify(options.capabilities === false ? {} : verifiedCapabilities()),
    JSON.stringify(settings),
    now,
    now,
  ).lastInsertRowid);
  modelPriceService.set(db, H3_MODEL, 1313, {
    category: 'video',
    status: options.priceStatus || 'enabled',
    displayName: 'MiniMax H3-2K（飞拓）',
    publicNote: '固定 2K，按次计费',
    billingUnit: 'request',
    costUnit: 'request',
    cost_micros_per_unit: 1500000,
  });
  modelPriceService.set(db, SEEDANCE_MODEL, 350, {
    category: 'video',
    status: options.priceStatus || 'enabled',
    displayName: 'Seedance 2.5（飞拓）',
    publicNote: '支持 480P、720P，按秒计费',
    billingUnit: 'second',
    costUnit: 'second',
    cost_micros_per_unit: 400000,
    resolution_prices: {
      '480p': { credits: 350, cost_micros_per_second: 400000 },
      '720p': { credits: 350, cost_micros_per_second: 400000 },
    },
  });
  creditLedgerService.setAccountBalance(db, 'user-1', 100000);
  creditLedgerService.setTenantAccountBalance(db, 'tenant-1', 100000);
  return { db, configId, dramaId, storyboardId };
}

function generationSideEffects(db) {
  return {
    tasks: db.prepare('SELECT COUNT(*) count FROM async_tasks').get().count,
    videos: db.prepare('SELECT COUNT(*) count FROM video_generations').get().count,
    reservations: db.prepare('SELECT COUNT(*) count FROM usage_reservations').get().count,
    tenantReservations: db.prepare('SELECT COUNT(*) count FROM tenant_usage_reservations').get().count,
  };
}

test('飞拓新视频模型使用精确上游 ID 和独立分辨率时长能力', () => {
  assert.deepEqual(
    FEITUO_MODELS['xuan-video-v1-6e7b4763634e6206'].resolutions,
    ['2k'],
  );
  assert.deepEqual(
    FEITUO_MODELS['xuan-video-v1-6e7b4763634e6206'].durations,
    [15],
  );
  assert.deepEqual(FEITUO_MODELS['xuan-seedance-2.5'].resolutions, ['480p', '720p']);
  assert.deepEqual(
    FEITUO_MODELS['xuan-seedance-2.5'].durations,
    SEEDANCE_DURATIONS,
  );
  assert.equal(FEITUO_MODELS['xuan-seedance-2.5'].maxImages, 30);
  assert.equal(FEITUO_MODELS['xuan-seedance-2.5'].maxVideos, 10);
  assert.equal(FEITUO_MODELS['xuan-seedance-2.5'].maxAudio, 10);
  assert.equal(FEITUO_MODELS['seedance-2.5'], undefined);
});

test('MiniMax H3-2K 请求只接受固定 2K 档位', () => {
  const body = buildFeituoVideoBody({
    model: 'xuan-video-v1-6e7b4763634e6206',
    prompt: '森林中的人物镜头',
    resolution: '2K',
    duration: 15,
    aspect_ratio: '16:9',
  });

  assert.equal(body.model, 'xuan-video-v1-6e7b4763634e6206');
  assert.equal(body.resolution, '2k');
  assert.equal(body.duration, 15);
  assert.throws(
    () => buildFeituoVideoBody({
      model: 'xuan-video-v1-6e7b4763634e6206',
      prompt: 'x',
      resolution: '720p',
      duration: 15,
    }),
    /不支持分辨率 720p/,
  );
  assert.throws(
    () => buildFeituoVideoBody({
      model: 'xuan-video-v1-6e7b4763634e6206',
      prompt: 'x',
      resolution: '2k',
      duration: 5,
    }),
    /不支持 5 秒/,
  );
});

test('Seedance 2.5 仅接受 xuan 渠道的 480P/720P', () => {
  const body = buildFeituoVideoBody({
    model: 'xuan-seedance-2.5',
    prompt: '镜头缓慢推进',
    resolution: '720P',
    duration: 4,
    ratio: '9:16',
  });

  assert.equal(body.model, 'xuan-seedance-2.5');
  assert.equal(body.resolution, '720p');
  assert.equal(body.duration, 4);
  assert.throws(
    () => buildFeituoVideoBody({
      model: 'seedance-2.5',
      prompt: 'x',
      resolution: '720p',
      duration: 5,
    }),
    /未经真实生成验证/,
  );
  assert.throws(
    () => buildFeituoVideoBody({
      model: 'xuan-seedance-2.5',
      prompt: 'x',
      resolution: '1080p',
      duration: 5,
    }),
    /不支持分辨率 1080p/,
  );
});

test('Seedance 2.5 完整透传 30 秒与 30 图 10 视频 10 音频并拒绝任一超限', () => {
  const referenceUrls = Array.from({ length: 30 }, (_, index) => `https://cdn.example/image-${index + 1}.jpg`);
  const referenceVideoUrls = Array.from({ length: 10 }, (_, index) => `https://cdn.example/video-${index + 1}.mp4`);
  const referenceAudioUrls = Array.from({ length: 10 }, (_, index) => `https://cdn.example/audio-${index + 1}.mp3`);
  const body = buildFeituoVideoBody({
    model: SEEDANCE_MODEL,
    prompt: '满参考能力验证',
    resolution: '720p',
    duration: 30,
    aspect_ratio: '16:9',
    reference_urls: referenceUrls,
    reference_video_urls: referenceVideoUrls,
    reference_audio_urls: referenceAudioUrls,
  });

  assert.equal(body.duration, 30);
  assert.deepEqual(body.imageUrls, referenceUrls);
  assert.deepEqual(body.videoUrls, referenceVideoUrls);
  assert.deepEqual(body.audioUrls, referenceAudioUrls);
  assert.throws(
    () => buildFeituoVideoBody({ ...body, model: SEEDANCE_MODEL, reference_urls: [...referenceUrls, 'https://cdn.example/image-31.jpg'] }),
    /最多支持 30 个图片素材/,
  );
  assert.throws(
    () => buildFeituoVideoBody({ ...body, model: SEEDANCE_MODEL, reference_video_urls: [...referenceVideoUrls, 'https://cdn.example/video-11.mp4'] }),
    /最多支持 10 个视频素材/,
  );
  assert.throws(
    () => buildFeituoVideoBody({ ...body, model: SEEDANCE_MODEL, reference_audio_urls: [...referenceAudioUrls, 'https://cdn.example/audio-11.mp3'] }),
    /最多支持 10 个音频素材/,
  );
  assert.throws(
    () => buildFeituoVideoBody({ model: SEEDANCE_MODEL, prompt: 'x', resolution: '720p', duration: 31 }),
    /不支持 31 秒/,
  );
});

test('Seedance 2.5 参考素材超限在任务和积分副作用前拒绝', (t) => {
  const { db, dramaId, storyboardId } = setupDb(t);
  let scheduled = 0;
  const base = {
    drama_id: dramaId,
    storyboard_id: storyboardId,
    model: SEEDANCE_MODEL,
    prompt: '测试满参考创建门禁',
    resolution: '720p',
    duration: 30,
    aspect_ratio: '16:9',
  };
  const options = {
    billingEnabled: true,
    tenantId: 'tenant-1',
    userId: 'user-1',
    schedule() { scheduled += 1; },
  };
  const cases = [
    { reference_image_urls: Array.from({ length: 31 }, (_, index) => `https://cdn.example/image-${index + 1}.jpg`) },
    { reference_video_urls: Array.from({ length: 11 }, (_, index) => `https://cdn.example/video-${index + 1}.mp4`) },
    { reference_audio_urls: Array.from({ length: 11 }, (_, index) => `https://cdn.example/audio-${index + 1}.mp3`) },
  ];

  for (const refs of cases) {
    assert.throws(
      () => videoService.create(db, log, { ...base, ...refs }, options),
      (error) => error.code === 'VIDEO_REFERENCE_LIMIT_EXCEEDED',
    );
    assert.deepEqual(generationSideEffects(db), {
      tasks: 0,
      videos: 0,
      reservations: 0,
      tenantReservations: 0,
    });
  }
  assert.equal(scheduled, 0);
});

test('飞拓模型未真实验证时在任务和积分副作用前拒绝', (t) => {
  const { db, dramaId, storyboardId } = setupDb(t, {
    verificationStatus: 'pending',
    realVerified: false,
    capabilities: false,
  });
  let scheduled = 0;

  assert.throws(
    () => videoService.create(db, log, {
      drama_id: dramaId,
      storyboard_id: storyboardId,
      model: SEEDANCE_MODEL,
      prompt: '测试未验证门禁',
      resolution: '480p',
      duration: 5,
      aspect_ratio: '16:9',
    }, {
      billingEnabled: true,
      tenantId: 'tenant-1',
      userId: 'user-1',
      schedule() { scheduled += 1; },
    }),
    (error) => error.code === 'MODEL_NOT_VERIFIED',
  );
  assert.deepEqual(generationSideEffects(db), {
    tasks: 0,
    videos: 0,
    reservations: 0,
    tenantReservations: 0,
  });
  assert.equal(scheduled, 0);
});

test('飞拓 Seedance 480P 四秒按已配置秒价预扣且保存精确请求快照', (t) => {
  const { db, dramaId, storyboardId } = setupDb(t);
  const created = videoService.create(db, log, {
    drama_id: dramaId,
    storyboard_id: storyboardId,
    model: SEEDANCE_MODEL,
    prompt: '测试四秒视频',
    resolution: '480P',
    duration: 4,
    aspect_ratio: '16:9',
  }, {
    billingEnabled: true,
    tenantId: 'tenant-1',
    userId: 'user-1',
    schedule() {},
  });

  const row = db.prepare(
    'SELECT model, resolution, duration, request_snapshot, credit_reservation_id FROM video_generations WHERE id = ?',
  ).get(created.id);
  assert.equal(row.model, SEEDANCE_MODEL);
  assert.equal(row.resolution, '480P');
  assert.equal(row.duration, 4);
  assert.equal(JSON.parse(row.request_snapshot).resolution, '480P');
  assert.equal(db.prepare('SELECT amount FROM tenant_usage_reservations WHERE id = ?')
    .get(row.credit_reservation_id).amount, 1400);
});

test('飞拓 H3 固定 2K 按次只预扣 1313 积分', (t) => {
  const { db, dramaId, storyboardId } = setupDb(t);
  const created = videoService.create(db, log, {
    drama_id: dramaId,
    storyboard_id: storyboardId,
    model: H3_MODEL,
    prompt: '测试 H3 2K',
    resolution: '2k',
    duration: 15,
    aspect_ratio: '16:9',
  }, {
    billingEnabled: true,
    tenantId: 'tenant-1',
    userId: 'user-1',
    schedule() {},
  });
  const row = db.prepare('SELECT credit_reservation_id FROM video_generations WHERE id = ?').get(created.id);
  assert.equal(db.prepare('SELECT amount FROM tenant_usage_reservations WHERE id = ?')
    .get(row.credit_reservation_id).amount, 1313);
});

test('飞拓价格停用时在任务与积分副作用前拒绝', (t) => {
  const { db, dramaId, storyboardId } = setupDb(t, { priceStatus: 'disabled' });
  assert.throws(
    () => videoService.create(db, log, {
      drama_id: dramaId,
      storyboard_id: storyboardId,
      model: SEEDANCE_MODEL,
      prompt: '测试价格门禁',
      resolution: '720p',
      duration: 5,
      aspect_ratio: '16:9',
    }, {
      billingEnabled: true,
      tenantId: 'tenant-1',
      userId: 'user-1',
      schedule() {},
    }),
    (error) => error.code === 'MODEL_PRICE_NOT_CONFIGURED',
  );
  assert.deepEqual(generationSideEffects(db), {
    tasks: 0,
    videos: 0,
    reservations: 0,
    tenantReservations: 0,
  });
});

test('飞拓最终提交前复核配置与价格并把 resolution 发送给供应商', async (t) => {
  const { db } = setupDb(t);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      async text() { return JSON.stringify({ success: true, jobId: 'job-feituo-1', status: 'queued' }); },
    };
  };
  const result = await videoClient.callVideoApi(db, log, {
    model: SEEDANCE_MODEL,
    prompt: '供应商提交门禁',
    resolution: '720p',
    duration: 4,
    aspect_ratio: '16:9',
    fetchImpl,
  });
  assert.deepEqual(result, { task_id: 'job-feituo-1', status: 'queued' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://feituokuajing.com/api/open/v1/video/generate');
  assert.equal(calls[0].body.model, SEEDANCE_MODEL);
  assert.equal(calls[0].body.resolution, '720p');

  modelPriceService.set(db, SEEDANCE_MODEL, 350, {
    category: 'video',
    status: 'disabled',
  });
  const blocked = await videoClient.callVideoApi(db, log, {
    model: SEEDANCE_MODEL,
    prompt: '供应商提交门禁',
    resolution: '720p',
    duration: 4,
    aspect_ratio: '16:9',
    fetchImpl,
  });
  assert.match(blocked.error, /积分待管理员配置/);
  assert.equal(calls.length, 1);
});

test('飞拓公开目录只展示精确真实验证且完整定价的能力', (t) => {
  const { db } = setupDb(t);
  const items = canvasModelCatalogService.list(db)
    .filter((item) => item.model.startsWith('xuan-'));

  assert.deepEqual(items.map((item) => item.model).sort(), [H3_MODEL, SEEDANCE_MODEL].sort());
  const h3 = items.find((item) => item.model === H3_MODEL);
  const seedance = items.find((item) => item.model === SEEDANCE_MODEL);
  assert.equal(h3.label, 'MiniMax H3-2K（飞拓）');
  assert.equal(h3.credits, 1313);
  assert.equal(h3.billing_unit, 'request');
  assert.deepEqual(h3.resolution_prices, {});
  assert.deepEqual(h3.capabilities.resolutions, ['2k']);
  assert.equal(seedance.label, 'Seedance 2.5（飞拓）');
  assert.equal(seedance.credits, 350);
  assert.equal(seedance.billing_unit, 'second');
  assert.deepEqual(Object.keys(seedance.resolution_prices), ['480p', '720p']);
  assert.deepEqual(seedance.capabilities.resolutions, ['480p', '720p']);
});

test('飞拓价格目录拒绝未写入精确真实生成记录的配置', (t) => {
  const { db } = setupDb(t, { realVerified: false });
  assert.deepEqual(
    modelPriceService.listPublic(db).filter((item) => item.model.startsWith('xuan-')),
    [],
  );
});

test('飞拓目录拒绝只有实生成标记但缺少精确验证能力的配置', (t) => {
  const { db } = setupDb(t, { capabilities: false });
  assert.deepEqual(
    canvasModelCatalogService.list(db).filter((item) => item.model.startsWith('xuan-')),
    [],
  );
  assert.deepEqual(
    modelPriceService.listPublic(db).filter((item) => item.model.startsWith('xuan-')),
    [],
  );
});
