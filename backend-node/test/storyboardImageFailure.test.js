const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const aiClient = require('../src/services/aiClient');
const aiConfig = require('../src/services/aiConfigService');
const credits = require('../src/services/creditLedgerService');
const imageClient = require('../src/services/imageClient');
const imageService = require('../src/services/imageService');
const prices = require('../src/services/modelPriceService');
const providerRouteStability = require('../src/services/providerRouteStabilityService');
const uploadService = require('../src/services/uploadService');
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
       endpoint, is_active, is_default, priority, verification_status, created_at, updated_at)
     VALUES ('storyboard_image', 'openai', 'openai', ?, ?, ?, ?, ?, ?, 1, 1, 0, 'verified', ?, ?)`
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

test('分镜图片供应商返回远程图但本地保存失败时不标记完成也不绑定首帧', async () => {
  const { db, dramaId, storyboardId } = setup();
  const originalCall = imageClient.callImageApi;
  const originalDownload = uploadService.downloadImageToLocal;
  imageClient.callImageApi = async () => ({ image_url: 'https://cdn.example/generated.png' });
  uploadService.downloadImageToLocal = async () => {
    throw new Error('disk full');
  };

  try {
    const created = imageService.create(db, log, {
      drama_id: dramaId,
      storyboard_id: storyboardId,
      model: 'dall-e-3',
      prompt: '雨后森林中的小狐狸',
      frame_type: 'storyboard_first',
    }, { schedule() {} });
    const configId = db.prepare("SELECT id FROM ai_service_configs WHERE service_type = 'storyboard_image'").get().id;
    const route = providerRouteStability.createOrGetRouteRequest(db, {
      id: 'route-local-save-failure',
      idempotencyKey: 'route-local-save-failure',
      serviceType: 'storyboard_image',
      businessType: 'image_generation',
      businessId: String(created.id),
      logicalModelId: 'dall-e-3',
      userPriceSnapshot: null,
      candidateConfigIds: [configId],
    });
    const attempt = providerRouteStability.startAttempt(db, {
      requestId: route.id,
      configId,
      provider: 'openai',
      upstreamModel: 'dall-e-3',
    });
    providerRouteStability.recordArtifactVerified(db, {
      requestId: route.id,
      attemptNo: attempt.attempt_no,
      configId,
    });

    await imageService.processImageGeneration(db, log, created.id);

    const image = db.prepare(
      'SELECT status, model, image_url, local_path, error_msg, task_id FROM image_generations WHERE id = ?'
    ).get(created.id);
    const task = db.prepare(
      'SELECT status, error FROM async_tasks WHERE id = ?'
    ).get(image.task_id);
    const storyboard = db.prepare(
      'SELECT first_frame_image_id, image_url, local_path, error_msg FROM storyboards WHERE id = ?'
    ).get(storyboardId);

    assert.equal(image.status, 'needs_attention');
    assert.equal(image.model, 'dall-e-3');
    assert.equal(image.image_url, null);
    assert.equal(image.local_path, null);
    assert.match(image.error_msg, /本地保存失败/);
    assert.equal(task.status, 'needs_attention');
    assert.equal(task.error, image.error_msg);
    assert.equal(storyboard.first_frame_image_id, null);
    assert.equal(storyboard.image_url, null);
    assert.equal(storyboard.local_path, null);
    assert.equal(storyboard.error_msg, image.error_msg);
    assert.doesNotMatch(image.error_msg, /重试/);
    assert.equal(imageService.findActiveForTarget(db, storyboardId, 'storyboard_first').id, created.id);
    assert.equal(db.prepare('SELECT state FROM generation_route_requests WHERE id = ?').get(route.id).state, 'needs_attention');
    assert.deepEqual(
      db.prepare('SELECT state, error_category FROM generation_route_attempts WHERE request_id = ?').get(route.id),
      { state: 'artifact_unreadable', error_category: 'artifact_unreadable' },
    );
  } finally {
    imageClient.callImageApi = originalCall;
    uploadService.downloadImageToLocal = originalDownload;
    db.close();
  }
});

test('分镜图片供应商结果未知时挂起任务且阻止重复提交', async () => {
  const { db, dramaId, storyboardId } = setup();
  const originalCall = imageClient.callImageApi;
  imageClient.callImageApi = async () => ({
    indeterminate: true,
    error: '图片生成结果未知，为避免重复提交或重复扣费，请先核对生成记录，不要连续重试。',
  });

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
      'SELECT status, error_msg, task_id FROM image_generations WHERE id = ?'
    ).get(created.id);
    const task = db.prepare(
      'SELECT status, error, completed_at FROM async_tasks WHERE id = ?'
    ).get(image.task_id);

    assert.equal(image.status, 'needs_attention');
    assert.match(image.error_msg, /结果未知/);
    assert.equal(task.status, 'needs_attention');
    assert.equal(task.error, image.error_msg);
    assert.equal(task.completed_at, null);
    assert.equal(imageService.findActiveForTarget(db, storyboardId, 'single').id, created.id);
  } finally {
    imageClient.callImageApi = originalCall;
    db.close();
  }
});

test('分镜图片内部润色与连戏快照按独立文本模型调用计费', async () => {
  const { db, dramaId, storyboardId } = setup();
  const originalText = aiClient.generateText;
  const originalImage = imageClient.callImageApi;
  let textCalls = 0;
  aiConfig.createConfig(db, log, {
    service_type: 'text',
    provider: 'openai',
    name: '测试文本模型',
    base_url: 'https://example.invalid/v1',
    api_key: 'test-key',
    model: ['GPT-5.5'],
    default_model: 'GPT-5.5',
    is_default: true,
  });
  credits.setTenantAccountBalance(db, 'tenant-a', 50);
  prices.set(db, 'dall-e-3', 10);
  prices.set(db, 'GPT-5.5', 5);
  aiClient.generateText = async (_db, _log, _type, _prompt, _system, options) => {
    textCalls += 1;
    assert.equal(options.model, 'GPT-5.5');
    return textCalls === 1
      ? '雨后森林里，小狐狸站在苔藓树根旁，保持单镜头构图。'
      : JSON.stringify({ character_state: '小狐狸位于画面中央' });
  };
  imageClient.callImageApi = async () => ({ error: '图片供应商明确失败' });

  try {
    const created = imageService.create(db, log, {
      drama_id: dramaId,
      storyboard_id: storyboardId,
      model: 'dall-e-3',
      prompt: '雨后森林中的小狐狸',
      frame_type: 'single',
    }, {
      billingEnabled: true,
      tenantId: 'tenant-a',
      userId: 'user-1',
      schedule() {},
    });

    await imageService.processImageGeneration(db, log, created.id);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(textCalls, 2);
    const textReservations = db.prepare(
      "SELECT * FROM tenant_usage_reservations WHERE resource_type IN ('image_prompt', 'continuity_snapshot')",
    ).all();
    assert.equal(textReservations.length, 2);
    assert.ok(textReservations.every((item) => item.status === 'confirmed'));
    const imageReservation = db.prepare(
      "SELECT * FROM tenant_usage_reservations WHERE resource_type = 'image'",
    ).get();
    assert.equal(imageReservation.status, 'refunded');
    assert.deepEqual(credits.getTenantAccount(db, 'tenant-a'), {
      tenant_id: 'tenant-a', available: 40, held: 0, spent: 10,
    });
  } finally {
    aiClient.generateText = originalText;
    imageClient.callImageApi = originalImage;
    db.close();
  }
});
