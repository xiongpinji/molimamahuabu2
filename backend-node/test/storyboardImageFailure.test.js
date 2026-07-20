const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const imageClient = require('../src/services/imageClient');
const imageService = require('../src/services/imageService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const dramaId = Number(
    db.prepare(
      `INSERT INTO dramas (title, style, status, metadata, created_at, updated_at)
       VALUES (?, ?, 'draft', ?, ?, ?)`
    ).run('图片失败回归', 'realistic', JSON.stringify({}), now, now).lastInsertRowid
  );
  const episodeId = Number(
    db.prepare(
      `INSERT INTO episodes (drama_id, episode_number, title, script_content, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?, ?)`
    ).run(dramaId, '第1集', '失败回写测试', now, now).lastInsertRowid
  );
  const storyboardId = Number(
    db.prepare(
      `INSERT INTO storyboards
        (episode_id, storyboard_number, title, image_prompt, status, created_at, updated_at)
       VALUES (?, 1, ?, ?, 'pending', ?, ?)`
    ).run(episodeId, '失败镜头', '雨后森林中的小狐狸', now, now).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO ai_service_configs
      (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
       endpoint, is_active, is_default, priority, created_at, updated_at)
     VALUES ('storyboard_image', 'openai', 'openai', ?, ?, ?, ?, ?, ?, 1, 1, 0, ?, ?)`
  ).run(
    '失败回归图片供应商',
    'http://127.0.0.1:9/v1',
    'unused-in-stub',
    JSON.stringify(['dall-e-3']),
    'dall-e-3',
    '/images/generations',
    now,
    now
  );
  return { db, dramaId, storyboardId };
}

test('分镜图片供应商明确失败时写回图片、任务和分镜状态并保留可重试模型', async () => {
  const { db, dramaId, storyboardId } = setup();
  const originalCall = imageClient.callImageApi;
  let request;
  imageClient.callImageApi = async (_db, _log, options) => {
    request = options;
    return { error: '图片生成请求失败: 402 - insufficient balance' };
  };

  try {
    const created = imageService.create(db, log, {
      drama_id: dramaId,
      storyboard_id: storyboardId,
      model: 'dall-e-3',
      prompt: '雨后森林中的小狐狸',
      frame_type: 'single',
    }, { schedule() {} });

    await imageService.processImageGeneration(db, log, created.id);

    const image = db.prepare(
      'SELECT status, model, error_msg, task_id FROM image_generations WHERE id = ?'
    ).get(created.id);
    const task = db.prepare(
      'SELECT status, error FROM async_tasks WHERE id = ?'
    ).get(image.task_id);
    const storyboard = db.prepare(
      'SELECT error_msg FROM storyboards WHERE id = ?'
    ).get(storyboardId);

    assert.equal(request.model, 'dall-e-3');
    assert.equal(request.imageServiceType, 'storyboard_image');
    assert.equal(image.status, 'failed');
    assert.equal(image.model, 'dall-e-3');
    assert.match(image.error_msg, /402/);
    assert.equal(task.status, 'failed');
    assert.equal(task.error, image.error_msg);
    assert.equal(storyboard.error_msg, image.error_msg);
    assert.equal(imageService.findActiveForTarget(db, storyboardId, 'single'), null);
  } finally {
    imageClient.callImageApi = originalCall;
    db.close();
  }
});
