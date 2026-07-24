const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiConfigService = require('../src/services/aiConfigService');
const storyboardService = require('../src/services/storyboardService');
const videoClient = require('../src/services/videoClient');
const videoService = require('../src/services/videoService');

const log = { info() {}, warn() {}, error() {} };

test('分镜视频模型覆盖可以保存、恢复，并在重新读取时保留', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (title, created_at, updated_at) VALUES (?, ?, ?)').run('测试剧', now, now);
  const dramaId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare('INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(dramaId, 1, '第1集', now, now);
  const episodeId = db.prepare('SELECT last_insert_rowid() AS id').get().id;

  const created = storyboardService.createStoryboard(db, log, {
    episode_id: episodeId,
    storyboard_number: 1,
    title: '首镜',
  });
  assert.equal(created.video_model, null);

  const saved = storyboardService.updateStoryboard(db, log, created.id, { video_model: 'grok-video-3' });
  assert.equal(saved.video_model, 'grok-video-3');
  assert.equal(storyboardService.getStoryboardById(db, created.id).video_model, 'grok-video-3');

  const restored = storyboardService.updateStoryboard(db, log, created.id, { video_model: null });
  assert.equal(restored.video_model, null);
  assert.equal(storyboardService.getStoryboardById(db, created.id).video_model, null);
  db.close();
});

test('分镜指定的视频模型未配置时失败写回且不静默调用默认模型', async () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (title, created_at, updated_at) VALUES (?, ?, ?)').run('模型严格路由测试', now, now);
  const dramaId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare('INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(dramaId, 1, '第1集', now, now);
  const episodeId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  const storyboard = storyboardService.createStoryboard(db, log, {
    episode_id: episodeId,
    storyboard_number: 1,
    title: '严格模型镜头',
    video_prompt: '小狐狸沿着雨后森林向前走。',
  });
  storyboardService.updateStoryboard(db, log, storyboard.id, { video_model: 'missing-video-model' });
  aiConfigService.createConfig(db, log, {
    service_type: 'video',
    provider: 'deepwl',
    api_protocol: 'deepwl_grok_unified',
    name: '默认视频配置',
    base_url: 'https://provider.invalid',
    api_key: 'test-only',
    model: ['default-video-model'],
    default_model: 'default-video-model',
    is_default: true,
  });

  const scheduled = [];
  let providerCallCount = 0;
  const originalCallVideoApi = videoClient.callVideoApi;
  videoClient.callVideoApi = async () => {
    providerCallCount += 1;
    return { error: '不应调用默认供应商模型' };
  };
  try {
    const created = videoService.create(db, log, {
      drama_id: dramaId,
      storyboard_id: storyboard.id,
      first_frame_url: 'https://example.com/first.png',
      last_frame_url: 'https://example.com/last.png',
    }, {
      schedule(callback) {
        scheduled.push(callback);
      },
    });
    assert.equal(created.model, 'missing-video-model');
    await scheduled[0]();

    const failed = db.prepare(
      'SELECT status, error_msg, task_id FROM video_generations WHERE id = ?'
    ).get(created.id);
    assert.equal(providerCallCount, 0);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error_msg, '未配置视频模型');
    const task = db.prepare('SELECT status, error FROM async_tasks WHERE id = ?').get(failed.task_id);
    assert.equal(task.status, 'failed');
    assert.equal(task.error, '未配置视频模型');

    storyboardService.updateStoryboard(db, log, storyboard.id, { video_model: 'default-video-model' });
    const retry = videoService.create(db, log, {
      drama_id: dramaId,
      storyboard_id: storyboard.id,
    }, { schedule() {} });
    assert.notEqual(retry.id, created.id);
    assert.equal(retry.model, 'default-video-model');
  } finally {
    videoClient.callVideoApi = originalCallVideoApi;
    db.close();
  }
});

test('分镜模型首尾帧和音色提示进入供应商请求，失败后写回并可重试', async () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (title, created_at, updated_at) VALUES (?, ?, ?)').run('视频同链审计', now, now);
  const dramaId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare('INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(dramaId, 1, '第1集', now, now);
  const episodeId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare('INSERT INTO characters (drama_id, name, voice_style, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(dramaId, '小狐狸', 'bright youthful voice, clear diction', now, now);
  const characterId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  const storyboard = storyboardService.createStoryboard(db, log, {
    episode_id: episodeId,
    storyboard_number: 1,
    title: '供应商失败镜头',
    dialogue: '小狐狸：我们继续往前走。',
    video_prompt: '雨后森林，镜头跟随小狐狸向前走。',
    character_ids: [characterId],
  });
  storyboardService.updateStoryboard(db, log, storyboard.id, { video_model: 'grok-video-3' });
  aiConfigService.createConfig(db, log, {
    service_type: 'video',
    provider: 'deepwl',
    api_protocol: 'deepwl_grok_unified',
    name: 'DeepWL Mock',
    base_url: 'https://provider.invalid',
    api_key: 'test-only',
    model: ['grok-video-3'],
    default_model: 'grok-video-3',
    is_default: true,
  });

  const scheduled = [];
  let providerRequest = null;
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    providerRequest = {
      url,
      body: JSON.parse(options.body),
    };
    return {
      ok: false,
      status: 422,
      text: async () => JSON.stringify({ message: 'mock provider rejected request' }),
    };
  };
  try {
    const created = videoService.create(db, log, {
      drama_id: dramaId,
      storyboard_id: storyboard.id,
      first_frame_url: 'https://cdn.example/first.png',
      last_frame_url: 'https://cdn.example/last.png',
      aspect_ratio: '16:9',
      duration: 5,
    }, {
      schedule(callback) {
        scheduled.push(callback);
      },
    });
    await scheduled[0]();

    assert.equal(providerRequest.url, 'https://provider.invalid/v1/video/create');
    assert.equal(providerRequest.body.model, 'grok-video-3');
    assert.deepEqual(providerRequest.body.images, [
      'https://cdn.example/first.png',
      'https://cdn.example/last.png',
    ]);
    assert.match(providerRequest.body.prompt, /VOICE CONTINUITY/);
    assert.match(providerRequest.body.prompt, /bright youthful voice, clear diction/);

    const failed = db.prepare(
      `SELECT model, first_frame_url, last_frame_url, status, error_msg, task_id
       FROM video_generations WHERE id = ?`
    ).get(created.id);
    assert.equal(failed.model, 'grok-video-3');
    assert.equal(failed.first_frame_url, 'https://cdn.example/first.png');
    assert.equal(failed.last_frame_url, 'https://cdn.example/last.png');
    assert.equal(failed.status, 'failed');
    assert.match(failed.error_msg, /mock provider rejected request/);
    const task = db.prepare('SELECT status, error FROM async_tasks WHERE id = ?').get(failed.task_id);
    assert.equal(task.status, 'failed');
    assert.match(task.error, /mock provider rejected request/);

    const retry = videoService.create(db, log, {
      drama_id: dramaId,
      storyboard_id: storyboard.id,
      first_frame_url: 'https://cdn.example/first.png',
      last_frame_url: 'https://cdn.example/last.png',
    }, { schedule() {} });
    assert.notEqual(retry.id, created.id);
    assert.equal(retry.model, 'grok-video-3');
    assert.equal(retry.status, 'processing');
  } finally {
    global.fetch = originalFetch;
    db.close();
  }
});
