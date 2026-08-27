const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const rawVideoService = require('../src/services/videoService');
const videoClient = require('../src/services/videoClient');
const taskService = require('../src/services/taskService');
const credits = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const { evidenceRoots, withExternalModelEvidence } = require('./helpers/externalModelEvidenceFixture');

const log = { info() {}, warn() {}, error() {} };

function waitFor(predicate, timeoutMs = 3000, intervalMs = 20) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() - started >= timeoutMs) {
        return reject(new Error('等待视频恢复轮询完成超时'));
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

const videoService = {
  ...rawVideoService,
  create(db, logger, request, options = {}) {
    return rawVideoService.create(db, logger, request, { ...options, evidenceRoots });
  },
  processVideoGeneration(db, logger, id, runtime = {}) {
    return rawVideoService.processVideoGeneration(db, logger, id, { ...runtime, evidenceRoots });
  },
};
const ORIGINAL_CWD = process.cwd();

function withTempConfig(t, options = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-video-snapshot-'));
  const configRoot = path.join(tempRoot, 'configs');
  const storageRoot = path.join(tempRoot, 'storage').replace(/\\/g, '/');
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, 'config.yaml'),
    [
      'app:',
      '  name: video snapshot test',
      '  version: test',
      'server:',
      '  host: 127.0.0.1',
      '  port: 0',
      'storage:',
      '  type: local',
      `  local_path: ${storageRoot}`,
      `  base_url: ${options.baseUrl || 'https://molimama.vip/static'}`,
    ].join('\n'),
    'utf8'
  );
  process.chdir(tempRoot);
  delete require.cache[require.resolve('../src/config')];
  t.after(() => {
    delete require.cache[require.resolve('../src/config')];
    process.chdir(ORIGINAL_CWD);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
}

function setup(t, options = {}) {
  withTempConfig(t, options);
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const insertDrama = db.prepare(
    `INSERT INTO dramas (tenant_id, user_id, title, status, metadata, created_at, updated_at)
     VALUES (?, ?, ?, 'draft', ?, ?, ?)`
  );
  const drama1 = Number(insertDrama.run('tenant-1', 'user-1', '主项目', JSON.stringify({ project_type: 'canvas', aspect_ratio: '16:9' }), now, now).lastInsertRowid);
  const drama2 = Number(insertDrama.run('tenant-1', 'user-1', '同租户其他项目', '{}', now, now).lastInsertRowid);
  const drama3 = Number(insertDrama.run('tenant-2', 'user-2', '其他租户项目', '{}', now, now).lastInsertRowid);
  db.prepare(`INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at) VALUES (?, 1, '第一集', ?, ?)`).run(drama1, now, now);
  db.prepare(`INSERT INTO storyboards (episode_id, storyboard_number, title, created_at, updated_at) VALUES (1, 1, '分镜', ?, ?)`).run(now, now);
  db.prepare(
    `INSERT INTO ai_service_configs
      (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
       is_active, is_default, priority, verification_status, verified_capabilities, created_at, updated_at)
     VALUES ('video', 'toapis', 'toapis_video', 'ToAPIs 测试', 'https://toapis.com/v1', 'test-key', ?,
       'seedance-2-mini', 1, 1, 0, 'verified', ?, ?, ?)`
  ).run(
    JSON.stringify(['seedance-2-mini']),
    JSON.stringify({
      'seedance-2-mini': withExternalModelEvidence('seedance-2-mini', {
        durations: [4, 8, 10, 12, 15], resolutions: ['480p', '720p'],
        supportsFirstFrame: true, supportsLastFrame: true, supportsImageReference: true,
        supportsVideoReference: true, supportsAudioReference: true, supportsAudio: true,
        maxReferences: 1, maxVideoReferences: 1, maxAudioReferences: 1,
      }),
      'seedance-2-fast': withExternalModelEvidence('seedance-2-fast', {
        durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolutions: ['480p', '720p'],
        supportsFirstFrame: true, supportsLastFrame: true, supportsImageReference: true,
        supportsVideoReference: true, supportsAudioReference: true, supportsAudio: true,
        maxReferences: 1, maxVideoReferences: 1, maxAudioReferences: 1,
      }),
    }),
    now,
    now
  );
  credits.setAccountBalance(db, 'user-1', 10000);
  credits.setTenantAccountBalance(db, 'tenant-1', 10000);
  prices.set(db, 'seedance-2-mini', 2, {
    category: 'video',
    cost_unit: 'second',
    resolution_prices: {
      '480p': { credits: 2, cost_micros_per_second: 1 },
      '720p': { credits: 2, cost_micros_per_second: 1 },
    },
  });
  t.after(() => db.close());
  return { db, now, drama1, drama2, drama3 };
}

function insertAsset(db, dramaId, type, relPath, metadata = {}) {
  const now = new Date().toISOString();
  return Number(db.prepare(
    `INSERT INTO assets (drama_id, name, type, url, local_path, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    dramaId,
    path.basename(relPath),
    type,
    `/static/${relPath}`,
    relPath,
    JSON.stringify(metadata),
    now,
    now
  ).lastInsertRowid);
}

function createVideo(db, body, options) {
  return videoService.create(db, log, { resolution: '480p', ...body }, options);
}

function sideEffectCounts(db) {
  return {
    tasks: db.prepare('SELECT COUNT(*) AS count FROM async_tasks').get().count,
    videos: db.prepare('SELECT COUNT(*) AS count FROM video_generations').get().count,
    reservations: db.prepare('SELECT COUNT(*) AS count FROM usage_reservations').get().count,
    tenantReservations: db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count,
  };
}

test('ToAPIs create stores normalized omni arrays and request snapshot before processing', (t) => {
  const { db, drama1 } = setup(t);
  insertAsset(db, drama1, 'image', 'projects/0001/assets/ref-image.png');
  insertAsset(db, drama1, 'video', 'projects/0001/assets/ref-video.mp4');
  insertAsset(db, drama1, 'audio', 'projects/0001/assets/ref-audio.mp3');

  const created = createVideo(db, {
    drama_id: drama1,
    storyboard_id: 1,
    model: 'seedance-2-mini',
    prompt: '按多模态参考生成视频',
    duration: 8,
    resolution: '480p',
    aspect_ratio: '16:9',
    seed: 123,
    camera_fixed: true,
    watermark: false,
    reference_image_urls: ['/static/projects/0001/assets/ref-image.png'],
    reference_video_urls: ['https://molimama.vip/static/projects/0001/assets/ref-video.mp4'],
    reference_audio_urls: ['/static/projects/0001/assets/ref-audio.mp3'],
    generate_audio: true,
  }, { billingEnabled: true, tenantId: 'tenant-1', userId: 'user-1', schedule() {} });

  const row = db.prepare('SELECT * FROM video_generations WHERE id = ?').get(created.id);
  assert.equal(row.reference_mode, 'omni');
  assert.equal(row.generate_audio, 1);
  assert.equal(row.first_frame_url, null);
  assert.equal(row.reference_video_url, 'https://molimama.vip/static/projects/0001/assets/ref-video.mp4');
  assert.equal(row.reference_audio_url, 'https://molimama.vip/static/projects/0001/assets/ref-audio.mp3');
  assert.deepEqual(JSON.parse(row.reference_image_urls), ['https://molimama.vip/static/projects/0001/assets/ref-image.png']);
  assert.deepEqual(JSON.parse(row.reference_video_urls), ['https://molimama.vip/static/projects/0001/assets/ref-video.mp4']);
  assert.deepEqual(JSON.parse(row.reference_audio_urls), ['https://molimama.vip/static/projects/0001/assets/ref-audio.mp3']);
  const snapshot = JSON.parse(row.request_snapshot);
  assert.equal(snapshot.model, 'seedance-2-mini');
  assert.equal(snapshot.duration, 8);
  assert.equal(snapshot.resolution, '480p');
  assert.equal(snapshot.reference_mode, 'omni');
  assert.equal(snapshot.generate_audio, true);
  assert.deepEqual(snapshot.reference_video_urls, ['https://molimama.vip/static/projects/0001/assets/ref-video.mp4']);
  assert.deepEqual(videoService.getById(db, created.id).request_snapshot.reference_audio_urls, ['https://molimama.vip/static/projects/0001/assets/ref-audio.mp3']);
});

test('ToAPIs process uses request_snapshot arrays and does not rebuild from mutated row fields', async (t) => {
  const { db, drama1 } = setup(t);
  insertAsset(db, drama1, 'image', 'projects/0001/assets/ref-image.png');
  insertAsset(db, drama1, 'video', 'projects/0001/assets/ref-video.mp4');
  insertAsset(db, drama1, 'audio', 'projects/0001/assets/ref-audio.mp3');

  let captured = null;
  const originalCall = videoClient.callVideoApi;
  videoClient.callVideoApi = async (_db, _log, payload) => {
    captured = payload;
    return { error: 'capture-only' };
  };
  t.after(() => { videoClient.callVideoApi = originalCall; });

  const created = createVideo(db, {
    drama_id: drama1,
    storyboard_id: 1,
    model: 'seedance-2-mini',
    prompt: '快照恢复测试',
    duration: 8,
    reference_image_urls: ['/static/projects/0001/assets/ref-image.png'],
    reference_video_urls: ['/static/projects/0001/assets/ref-video.mp4'],
    reference_audio_urls: ['/static/projects/0001/assets/ref-audio.mp3'],
    generate_audio: true,
  }, { billingEnabled: false, schedule() {} });
  db.prepare(`UPDATE video_generations SET reference_image_urls = ?, reference_video_urls = ?, reference_video_url = ?, reference_audio_urls = ?, reference_audio_url = ?, first_frame_url = ? WHERE id = ?`)
    .run(JSON.stringify(['https://evil.example/ref.png']), JSON.stringify(['https://evil.example/ref.mp4']), 'https://evil.example/ref.mp4', JSON.stringify(['https://evil.example/ref.mp3']), 'https://evil.example/ref.mp3', 'https://evil.example/first.png', created.id);

  await videoService.processVideoGeneration(db, log, created.id);

  assert.deepEqual(captured.reference_urls, ['https://molimama.vip/static/projects/0001/assets/ref-image.png']);
  assert.deepEqual(captured.reference_video_urls, ['https://molimama.vip/static/projects/0001/assets/ref-video.mp4']);
  assert.deepEqual(captured.reference_audio_urls, ['https://molimama.vip/static/projects/0001/assets/ref-audio.mp3']);
  assert.equal(captured.first_frame_url, null);
  assert.equal(captured.generate_audio, true);
});

test('ToAPIs snapshot empty arrays and null aspect ratio stay authoritative during direct processing', async (t) => {
  const { db, drama1 } = setup(t);
  let captured = null;
  const originalCall = videoClient.callVideoApi;
  videoClient.callVideoApi = async (_db, _log, payload) => {
    captured = payload;
    return { error: 'capture-only' };
  };
  t.after(() => { videoClient.callVideoApi = originalCall; });

  const created = createVideo(db, {
    drama_id: drama1,
    storyboard_id: 1,
    model: 'seedance-2-mini',
    prompt: '空引用快照权威',
    duration: 8,
  }, { billingEnabled: false, schedule() {} });
  const snapshot = JSON.parse(db.prepare('SELECT request_snapshot FROM video_generations WHERE id = ?').get(created.id).request_snapshot);
  snapshot.aspect_ratio = null;
  db.prepare(`UPDATE video_generations
    SET request_snapshot = ?, reference_video_urls = ?, reference_video_url = ?, reference_audio_urls = ?, reference_audio_url = ?
    WHERE id = ?`)
    .run(
      JSON.stringify(snapshot),
      JSON.stringify(['https://evil.example/ref.mp4']),
      'https://evil.example/ref.mp4',
      JSON.stringify(['https://evil.example/ref.mp3']),
      'https://evil.example/ref.mp3',
      created.id
    );
  db.prepare('UPDATE dramas SET metadata = ? WHERE id = ?').run(JSON.stringify({ aspect_ratio: '9:16' }), drama1);

  await videoService.processVideoGeneration(db, log, created.id);

  assert.deepEqual(captured.reference_video_urls, []);
  assert.deepEqual(captured.reference_audio_urls, []);
  assert.equal(captured.voice_reference_url, undefined);
  assert.equal(captured.aspect_ratio, null);
});

test('ToAPIs rejects forbidden references before task row or credit reservation', (t) => {
  const cases = [
    { name: '外站', url: 'https://evil.example/projects/0001/assets/ref-image.png', setupAsset: false },
    { name: 'encoded dot', url: '/static/projects/0001/%2e%2e/assets/ref-image.png', setupAsset: true },
    { name: '伪造同源用户名密码', url: 'https://evil.example@molimama.vip/static/projects/0001/assets/ref-image.png', setupAsset: true },
    { name: '同租户其他项目', url: '/static/projects/0002/assets/ref-image.png', setupAsset: 'other-project' },
    { name: '其他租户项目', url: '/static/projects/0003/assets/ref-image.png', setupAsset: 'other-tenant' },
  ];

  for (const item of cases) {
    const { db, drama1, drama2, drama3 } = setup(t);
    if (item.setupAsset === true) insertAsset(db, drama1, 'image', 'projects/0001/assets/ref-image.png');
    if (item.setupAsset === 'other-project') insertAsset(db, drama2, 'image', 'projects/0002/assets/ref-image.png');
    if (item.setupAsset === 'other-tenant') insertAsset(db, drama3, 'image', 'projects/0003/assets/ref-image.png');
    assert.throws(() => createVideo(db, {
      drama_id: drama1,
      storyboard_id: 1,
      model: 'seedance-2-mini',
      prompt: item.name,
      duration: 8,
      reference_image_urls: [item.url],
    }, { billingEnabled: true, tenantId: 'tenant-1', userId: 'user-1', schedule() {} }), (error) => error.code === 'VIDEO_REFERENCE_FORBIDDEN', item.name);
    assert.deepEqual(sideEffectCounts(db), { tasks: 0, videos: 0, reservations: 0, tenantReservations: 0 }, item.name);
  }
});

test('ToAPIs cleans blank duplicate reference image entries before snapshot and provider payload', async (t) => {
  const { db, drama1 } = setup(t);
  insertAsset(db, drama1, 'image', 'projects/0001/assets/ref-image.png');
  let captured = null;
  const originalCall = videoClient.callVideoApi;
  videoClient.callVideoApi = async (_db, _log, payload) => {
    captured = payload;
    return { error: 'capture-only' };
  };
  t.after(() => { videoClient.callVideoApi = originalCall; });

  const created = createVideo(db, {
    drama_id: drama1,
    storyboard_id: 1,
    model: 'seedance-2-mini',
    prompt: '清理空白重复引用',
    duration: 8,
    reference_image_urls: [
      null,
      '',
      '   ',
      '/static/projects/0001/assets/ref-image.png',
      '/static/projects/0001/assets/ref-image.png',
    ],
  }, { billingEnabled: false, schedule() {} });

  const row = db.prepare('SELECT reference_image_urls, request_snapshot FROM video_generations WHERE id = ?').get(created.id);
  assert.deepEqual(JSON.parse(row.reference_image_urls), ['https://molimama.vip/static/projects/0001/assets/ref-image.png']);
  assert.deepEqual(JSON.parse(row.request_snapshot).reference_image_urls, ['https://molimama.vip/static/projects/0001/assets/ref-image.png']);

  await videoService.processVideoGeneration(db, log, created.id);
  assert.deepEqual(captured.reference_urls, ['https://molimama.vip/static/projects/0001/assets/ref-image.png']);
});

test('ToAPIs explicit frame mode and omni references are mutually exclusive before side effects', (t) => {
  const { db, drama1 } = setup(t);
  insertAsset(db, drama1, 'image', 'projects/0001/assets/ref-image.png');
  assert.throws(() => createVideo(db, {
    drama_id: drama1,
    storyboard_id: 1,
    model: 'seedance-2-mini',
    prompt: '模式互斥',
    duration: 8,
    first_frame_url: '/static/projects/0001/assets/ref-image.png',
    reference_image_urls: ['/static/projects/0001/assets/ref-image.png'],
  }, { billingEnabled: true, tenantId: 'tenant-1', userId: 'user-1', schedule() {} }), (error) => error.code === 'VIDEO_REFERENCE_FORBIDDEN');
  assert.deepEqual(sideEffectCounts(db), { tasks: 0, videos: 0, reservations: 0, tenantReservations: 0 });
});

test('ToAPIs client validation rejects standalone reference audio before side effects', (t) => {
  const { db, drama1 } = setup(t);
  insertAsset(db, drama1, 'audio', 'projects/0001/assets/ref-audio.mp3');
  assert.throws(() => createVideo(db, {
    drama_id: drama1,
    storyboard_id: 1,
    model: 'seedance-2-mini',
    prompt: '音频不能单独作为全能参考',
    duration: 8,
    reference_audio_urls: ['/static/projects/0001/assets/ref-audio.mp3'],
  }, { billingEnabled: false, schedule() {} }), (error) => error.code === 'VIDEO_REFERENCE_FORBIDDEN');
  assert.deepEqual(sideEffectCounts(db), { tasks: 0, videos: 0, reservations: 0, tenantReservations: 0 });
});

test('ToAPIs rejects last frame without first frame before side effects', (t) => {
  const { db, drama1 } = setup(t);
  insertAsset(db, drama1, 'image', 'projects/0001/assets/last.png');
  assert.throws(() => createVideo(db, {
    drama_id: drama1,
    storyboard_id: 1,
    model: 'seedance-2-mini',
    prompt: '只有尾帧',
    duration: 8,
    last_frame_url: '/static/projects/0001/assets/last.png',
  }, { billingEnabled: false, schedule() {} }), (error) => error.code === 'VIDEO_REFERENCE_FORBIDDEN');
  assert.deepEqual(sideEffectCounts(db), { tasks: 0, videos: 0, reservations: 0, tenantReservations: 0 });
});

test('ToAPIs rejects platform references when storage base URL is not HTTPS', (t) => {
  const { db, drama1 } = setup(t, { baseUrl: 'http://molimama.vip/static' });
  insertAsset(db, drama1, 'image', 'projects/0001/assets/ref-image.png');
  assert.throws(() => createVideo(db, {
    drama_id: drama1,
    storyboard_id: 1,
    model: 'seedance-2-mini',
    prompt: 'HTTP 存储地址禁止',
    duration: 8,
    reference_image_urls: ['/static/projects/0001/assets/ref-image.png'],
  }, { billingEnabled: false, schedule() {} }), (error) => error.code === 'VIDEO_REFERENCE_FORBIDDEN');
  assert.deepEqual(sideEffectCounts(db), { tasks: 0, videos: 0, reservations: 0, tenantReservations: 0 });
});

test('ToAPIs rejects private HTTPS storage base URL before side effects', (t) => {
  const { db, drama1 } = setup(t, { baseUrl: 'https://127.0.0.1/static' });
  insertAsset(db, drama1, 'image', 'projects/0001/assets/ref-image.png');
  assert.throws(() => createVideo(db, {
    drama_id: drama1,
    storyboard_id: 1,
    model: 'seedance-2-mini',
    prompt: '私网存储地址禁止',
    duration: 8,
    reference_image_urls: ['/static/projects/0001/assets/ref-image.png'],
  }, { billingEnabled: false, schedule() {} }), (error) => error.code === 'VIDEO_REFERENCE_FORBIDDEN');
  assert.deepEqual(sideEffectCounts(db), { tasks: 0, videos: 0, reservations: 0, tenantReservations: 0 });
});

test('ToAPIs rejects bracketed IPv6 and IPv4-mapped private storage base URL before side effects', (t) => {
  const cases = [
    '"https://[::1]/static"',
    '"https://[fd00::1]/static"',
    '"https://[fe80::1]/static"',
    '"https://[::ffff:127.0.0.1]/static"',
  ];
  for (const baseUrl of cases) {
    const { db, drama1 } = setup(t, { baseUrl });
    insertAsset(db, drama1, 'image', 'projects/0001/assets/ref-image.png');
    assert.throws(() => createVideo(db, {
      drama_id: drama1,
      storyboard_id: 1,
      model: 'seedance-2-mini',
      prompt: 'IPv6 私网拦截',
      duration: 8,
      reference_image_urls: ['/static/projects/0001/assets/ref-image.png'],
    }, { billingEnabled: false, schedule() {} }), (error) => error.code === 'VIDEO_REFERENCE_FORBIDDEN');
    assert.deepEqual(sideEffectCounts(db), { tasks: 0, videos: 0, reservations: 0, tenantReservations: 0 });
  }
});

test('ToAPIs local non-billing mode still rejects references from another project before side effects', (t) => {
  const { db, drama1, drama2 } = setup(t);
  insertAsset(db, drama2, 'image', 'projects/0002/assets/ref-image.png');
  assert.throws(() => createVideo(db, {
    drama_id: drama1,
    storyboard_id: 1,
    model: 'seedance-2-mini',
    prompt: '本地非计费也必须同项目',
    duration: 8,
    reference_image_urls: ['/static/projects/0002/assets/ref-image.png'],
  }, { billingEnabled: false, schedule() {} }), (error) => error.code === 'VIDEO_REFERENCE_FORBIDDEN');
  assert.deepEqual(sideEffectCounts(db), { tasks: 0, videos: 0, reservations: 0, tenantReservations: 0 });
});

test('ToAPIs allows system_shared platform assets for references', (t) => {
  const { db, drama1 } = setup(t);
  db.prepare(
    `INSERT INTO assets (drama_id, name, type, url, local_path, metadata, created_at, updated_at)
     VALUES (NULL, 'shared-ref.png', 'image', '/static/projects/shared/assets/shared-ref.png', 'projects/shared/assets/shared-ref.png', ?, ?, ?)`
  ).run(JSON.stringify({ system_shared: true }), new Date().toISOString(), new Date().toISOString());

  const created = createVideo(db, {
    drama_id: drama1,
    storyboard_id: 1,
    model: 'seedance-2-mini',
    prompt: '系统共享素材',
    duration: 8,
    reference_image_urls: ['/static/projects/shared/assets/shared-ref.png'],
  }, { billingEnabled: false, schedule() {} });

  assert.deepEqual(videoService.getById(db, created.id).reference_image_urls, ['https://molimama.vip/static/projects/shared/assets/shared-ref.png']);
});

test('ToAPIs direct create rejects references over verified limits before side effects', (t) => {
  const { db, drama1 } = setup(t);
  for (const [type, ext] of [['image', 'png'], ['video', 'mp4'], ['audio', 'mp3']]) {
    for (let i = 1; i <= 2; i += 1) {
      insertAsset(db, drama1, type, `projects/0001/assets/${type}-${i}.${ext}`);
    }
  }
  const cases = [
    {
      label: '参考图',
      body: { reference_image_urls: [
        '/static/projects/0001/assets/image-1.png',
        '/static/projects/0001/assets/image-2.png',
      ] },
    },
    {
      label: '参考视频',
      body: { reference_video_urls: [
        '/static/projects/0001/assets/video-1.mp4',
        '/static/projects/0001/assets/video-2.mp4',
      ] },
    },
    {
      label: '参考音频',
      body: {
        reference_image_urls: ['/static/projects/0001/assets/image-1.png'],
        reference_audio_urls: [
          '/static/projects/0001/assets/audio-1.mp3',
          '/static/projects/0001/assets/audio-2.mp3',
        ],
      },
    },
  ];
  for (const item of cases) {
    assert.throws(() => createVideo(db, {
      drama_id: drama1,
      storyboard_id: 1,
      model: 'seedance-2-mini',
      prompt: `${item.label}超过已验证上限`,
      duration: 8,
      ...item.body,
    }, {
      billingEnabled: true,
      tenantId: 'tenant-1',
      userId: 'user-1',
      schedule() {},
    }), (error) => error.code === 'VIDEO_REFERENCE_LIMIT_EXCEEDED'
      && /最多支持 1/.test(error.message));
    assert.deepEqual(sideEffectCounts(db), { tasks: 0, videos: 0, reservations: 0, tenantReservations: 0 });
  }
});

test('indeterminate provider submission keeps reservation and duplicate guard without refund or retry', async (t) => {
  const { db, drama1 } = setup(t);
  let calls = 0;
  const callbacks = [];
  const originalCall = videoClient.callVideoApi;
  videoClient.callVideoApi = async () => {
    calls += 1;
    return { indeterminate: true, error: 'network timeout after POST' };
  };
  t.after(() => { videoClient.callVideoApi = originalCall; });

  const created = createVideo(db, {
    drama_id: drama1,
    storyboard_id: 1,
    model: 'seedance-2-mini',
    prompt: '未知提交',
    duration: 8,
  }, { billingEnabled: true, tenantId: 'tenant-1', userId: 'user-1', schedule(callback) { callbacks.push(callback); } });
  await callbacks[0]();

  const row = db.prepare('SELECT * FROM video_generations WHERE id = ?').get(created.id);
  const reservation = credits.getReservation(db, row.credit_reservation_id);
  assert.equal(calls, 1);
  assert.equal(row.status, 'needs_attention');
  assert.match(row.error_msg, /^VIDEO_SUBMISSION_INDETERMINATE:/);
  assert.equal(reservation.status, 'held');

  const reused = createVideo(db, {
    drama_id: drama1,
    storyboard_id: 1,
    model: 'seedance-2-mini',
    prompt: '未知提交重复点击',
    duration: 8,
  }, { billingEnabled: true, tenantId: 'tenant-1', userId: 'user-1', schedule() {} });
  assert.equal(reused.id, created.id);
  assert.equal(reused.reused, true);
  assert.equal(calls, 1);

  videoService.resumeProcessingVideoGenerations(db, log);
  const afterResume = db.prepare('SELECT status, error_msg FROM video_generations WHERE id = ?').get(created.id);
  assert.equal(afterResume.status, 'needs_attention');
  assert.match(afterResume.error_msg, /^VIDEO_SUBMISSION_INDETERMINATE:/);
  assert.equal(credits.getReservation(db, row.credit_reservation_id).status, 'held');
  assert.equal(calls, 1);
});

test('damaged request_snapshot keeps manual reconciliation state and never calls supplier', async (t) => {
  const { db, drama1 } = setup(t);
  const originalCall = videoClient.callVideoApi;
  let calls = 0;
  videoClient.callVideoApi = async () => { calls += 1; return { error: 'must not submit' }; };
  t.after(() => { videoClient.callVideoApi = originalCall; });
  const created = createVideo(db, {
    drama_id: drama1,
    storyboard_id: 1,
    model: 'seedance-2-mini',
    prompt: '坏快照不得提交',
    duration: 8,
  }, { billingEnabled: true, tenantId: 'tenant-1', userId: 'user-1', schedule() {} });
  const row = db.prepare('SELECT credit_reservation_id FROM video_generations WHERE id = ?').get(created.id);
  db.prepare('UPDATE video_generations SET request_snapshot = ? WHERE id = ?').run('{bad-json', created.id);

  await videoService.processVideoGeneration(db, log, created.id);

  const after = db.prepare('SELECT status, error_msg FROM video_generations WHERE id = ?').get(created.id);
  assert.equal(after.status, 'processing');
  assert.match(after.error_msg, /^VIDEO_SUBMISSION_INDETERMINATE: request_snapshot/);
  assert.equal(credits.getReservation(db, row.credit_reservation_id).status, 'held');
  assert.equal(calls, 0);
});

test('resumable provider task polls existing task_id and does not POST again', async (t) => {
  const { db, drama1, now } = setup(t);
  const originalPoll = videoClient.pollVideoTask;
  const originalCall = videoClient.callVideoApi;
  let pollCalls = 0;
  let postCalls = 0;
  videoClient.callVideoApi = async () => { postCalls += 1; return { error: 'must not post' }; };
  videoClient.pollVideoTask = async (_db, _log, _videoId, providerTaskId) => {
    pollCalls += 1;
    assert.equal(providerTaskId, 'tsk_existing');
    return { indeterminate: true, error: 'still running' };
  };
  t.after(() => {
    videoClient.pollVideoTask = originalPoll;
    videoClient.callVideoApi = originalCall;
  });
  const task = taskService.createTask(db, log, 'video_generation', String(drama1));
  db.prepare(`INSERT INTO video_generations
    (drama_id, provider, prompt, model, duration, status, task_id, provider_task_id, request_snapshot, created_at, updated_at)
    VALUES (?, 'toapis', '恢复现有任务', 'seedance-2-mini', 8, 'processing', ?, 'tsk_existing', ?, ?, ?)`)
    .run(drama1, task.id, JSON.stringify({ model: 'seedance-2-mini', prompt: '恢复现有任务', duration: 8, reference_mode: 'text', generate_audio: false }), now, now);

  videoService.resumeProcessingVideoGenerations(db, log);
  await waitFor(() => pollCalls === 1);
  assert.equal(postCalls, 0);
  assert.equal(pollCalls, 1);
});

test('direct existing provider_task_id keeps held reservation when config is disabled and does not poll or fail', async (t) => {
  const { db, drama1 } = setup(t);
  const originalPoll = videoClient.pollVideoTask;
  const originalCall = videoClient.callVideoApi;
  let pollCalls = 0;
  let postCalls = 0;
  videoClient.pollVideoTask = async () => { pollCalls += 1; return { error: 'must not poll' }; };
  videoClient.callVideoApi = async () => { postCalls += 1; return { error: 'must not post' }; };
  t.after(() => {
    videoClient.pollVideoTask = originalPoll;
    videoClient.callVideoApi = originalCall;
  });
  const created = createVideo(db, {
    drama_id: drama1,
    storyboard_id: 1,
    model: 'seedance-2-mini',
    prompt: '配置禁用仍需保留任务',
    duration: 8,
  }, { billingEnabled: true, tenantId: 'tenant-1', userId: 'user-1', schedule() {} });
  const row = db.prepare('SELECT credit_reservation_id FROM video_generations WHERE id = ?').get(created.id);
  db.prepare('UPDATE video_generations SET provider_task_id = ? WHERE id = ?').run('tsk_config_disabled', created.id);
  db.prepare('UPDATE ai_service_configs SET is_active = 0 WHERE service_type = ?').run('video');

  await videoService.processVideoGeneration(db, log, created.id);

  const after = db.prepare('SELECT status, error_msg FROM video_generations WHERE id = ?').get(created.id);
  assert.equal(after.status, 'processing');
  assert.match(after.error_msg, /视频模型配置暂不可用/);
  assert.equal(credits.getReservation(db, row.credit_reservation_id).status, 'held');
  assert.equal(postCalls, 0);
  assert.equal(pollCalls, 0);
});

test('resume existing provider_task_id keeps held reservation when config is disabled and does not poll or fail', async (t) => {
  const { db, drama1 } = setup(t);
  const originalPoll = videoClient.pollVideoTask;
  let pollCalls = 0;
  videoClient.pollVideoTask = async () => { pollCalls += 1; return { error: 'must not poll' }; };
  t.after(() => { videoClient.pollVideoTask = originalPoll; });
  const created = createVideo(db, {
    drama_id: drama1,
    storyboard_id: 1,
    model: 'seedance-2-mini',
    prompt: '恢复时配置禁用',
    duration: 8,
  }, { billingEnabled: true, tenantId: 'tenant-1', userId: 'user-1', schedule() {} });
  const row = db.prepare('SELECT credit_reservation_id FROM video_generations WHERE id = ?').get(created.id);
  db.prepare('UPDATE video_generations SET provider_task_id = ? WHERE id = ?').run('tsk_resume_config_disabled', created.id);
  db.prepare('UPDATE ai_service_configs SET is_active = 0 WHERE service_type = ?').run('video');

  videoService.resumeProcessingVideoGenerations(db, log);
  await waitFor(() => db
    .prepare('SELECT status FROM video_generations WHERE id = ?')
    .get(created.id)?.status === 'needs_attention');

  const after = db.prepare('SELECT status, error_msg FROM video_generations WHERE id = ?').get(created.id);
  assert.equal(after.status, 'needs_attention');
  assert.match(after.error_msg, /固定模型配置暂不可用/);
  assert.equal(credits.getReservation(db, row.credit_reservation_id).status, 'held');
  assert.equal(pollCalls, 0);
});

test('direct process with existing provider_task_id polls only and never submits again', async (t) => {
  const { db, drama1, now } = setup(t);
  const originalPoll = videoClient.pollVideoTask;
  const originalCall = videoClient.callVideoApi;
  let pollCalls = 0;
  let postCalls = 0;
  videoClient.callVideoApi = async () => { postCalls += 1; return { error: 'must not post' }; };
  videoClient.pollVideoTask = async (_db, _log, _videoId, providerTaskId) => {
    pollCalls += 1;
    assert.equal(providerTaskId, 'tsk_existing_direct');
    return { indeterminate: true, error: 'still running' };
  };
  t.after(() => {
    videoClient.pollVideoTask = originalPoll;
    videoClient.callVideoApi = originalCall;
  });
  const task = taskService.createTask(db, log, 'video_generation', String(drama1));
  db.prepare(`INSERT INTO video_generations
    (drama_id, provider, prompt, model, duration, status, task_id, provider_task_id, request_snapshot, created_at, updated_at)
    VALUES (?, 'toapis', '直接处理已有任务', 'seedance-2-mini', 8, 'processing', ?, 'tsk_existing_direct', ?, ?, ?)`)
    .run(drama1, task.id, JSON.stringify({ model: 'seedance-2-mini', prompt: '直接处理已有任务', duration: 8, reference_mode: 'text', generate_audio: false }), now, now);
  const videoId = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);

  await videoService.processVideoGeneration(db, log, videoId);

  assert.equal(postCalls, 0);
  assert.equal(pollCalls, 1);
  assert.equal(db.prepare('SELECT status FROM video_generations WHERE id = ?').get(videoId).status, 'needs_attention');
});
