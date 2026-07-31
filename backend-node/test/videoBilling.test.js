const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const videoService = require('../src/services/videoService');
const videoClient = require('../src/services/videoClient');
const taskService = require('../src/services/taskService');
const credits = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {} };

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

test('灵境视频按供应商支持值归一化后再入库和计费', () => {
  const db = setup();
  prices.set(db, 'lingjing-video-v1', 2, { category: 'video' });

  const created = videoService.create(db, log, {
    drama_id: 1,
    storyboard_id: 1,
    model: 'lingjing-video-v1',
    prompt: '原计划 9 秒的视频',
    duration: 9,
  }, { billingEnabled: true, userId: 'user-1', schedule() {} });

  const row = db.prepare('SELECT duration, credit_reservation_id FROM video_generations WHERE id = ?').get(created.id);
  assert.equal(row.duration, 10);
  assert.equal(credits.getReservation(db, row.credit_reservation_id).amount, 20);
  db.close();
});

test('灵境视频允许供应商声明的 4 秒时长', () => {
  const db = setup();
  prices.set(db, 'lingjing-video-v1', 2, { category: 'video' });

  const created = videoService.create(db, log, {
    drama_id: 1,
    storyboard_id: 1,
    model: 'lingjing-video-v1',
    prompt: '4 秒视频',
    duration: 4,
  }, { billingEnabled: true, userId: 'user-1', schedule() {} });

  const row = db.prepare('SELECT duration, credit_reservation_id FROM video_generations WHERE id = ?').get(created.id);
  assert.equal(row.duration, 4);
  assert.equal(credits.getReservation(db, row.credit_reservation_id).amount, 8);
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
