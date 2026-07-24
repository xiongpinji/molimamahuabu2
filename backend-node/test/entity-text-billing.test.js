const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const aiConfig = require('../src/services/aiConfigService');
const aiClient = require('../src/services/aiClient');
const characterLibrary = require('../src/services/characterLibraryService');
const characterRoutes = require('../src/routes/characters');
const credits = require('../src/services/creditLedgerService');
const imageClient = require('../src/services/imageClient');
const prices = require('../src/services/modelPriceService');
const propRoutes = require('../src/routes/prop');
const propExtractionService = require('../src/services/propExtractionService');
const propService = require('../src/services/propService');
const sceneRoutes = require('../src/routes/scenes');
const sceneService = require('../src/services/sceneService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {} };

function setup({ withPrice = true } = {}) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, style, status, created_at, updated_at)
     VALUES ('测试项目', 'realistic', 'draft', ?, ?)`,
  ).run(now, now).lastInsertRowid;
  const characterId = db.prepare(
    `INSERT INTO characters (drama_id, name, appearance, created_at, updated_at)
     VALUES (?, '小茉', '黑色长发，粉色外套', ?, ?)`,
  ).run(dramaId, now, now).lastInsertRowid;
  const episodeId = db.prepare(
    `INSERT INTO episodes
      (drama_id, episode_number, title, script_content, created_at, updated_at)
     VALUES (?, 1, '第一集', '小茉拿起刻纹木牌。', ?, ?)`,
  ).run(dramaId, now, now).lastInsertRowid;
  const propId = db.prepare(
    `INSERT INTO props (drama_id, name, description, created_at, updated_at)
     VALUES (?, '木牌', '刻纹木牌', ?, ?)`,
  ).run(dramaId, now, now).lastInsertRowid;
  const scene = sceneService.createScene(db, log, dramaId, {
    location: '雨后庭院',
    time: '清晨',
    prompt: '青石板上有积水。',
  });
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
  credits.setTenantAccountBalance(db, 'tenant-a', 30);
  if (withPrice) prices.set(db, 'GPT-5.5', 5);
  return { db, episodeId, characterId, propId, sceneId: scene.id };
}

function capture() {
  const result = {};
  return {
    result,
    res: {
      status(code) { result.status = code; return this; },
      json(body) { result.body = body; return this; },
    },
  };
}

function request(id, body = {}) {
  return {
    params: { id, scene_id: id },
    body: { model: 'GPT-5.5', ...body },
    user: { id: 'user-1' },
    tenant: { id: 'tenant-a' },
  };
}

async function waitForTask(db, taskId) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const task = db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(taskId);
    if (task && ['completed', 'failed'].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待任务 ${taskId} 超时`);
}

test('角色提示词生成成功后确认文本模型积分', async (t) => {
  const { db, characterId } = setup();
  const original = characterLibrary.generateCharacterPromptOnly;
  t.after(() => { characterLibrary.generateCharacterPromptOnly = original; db.close(); });
  characterLibrary.generateCharacterPromptOnly = async () => ({
    ok: true,
    polished_prompt: '角色四视图提示词',
  });
  const { res, result } = capture();

  await characterRoutes(db, {}, log, null, { billingEnabled: true })
    .generatePrompt(request(characterId), res);

  assert.equal(result.status, 200);
  const reservation = db.prepare(
    `SELECT * FROM tenant_usage_reservations
     WHERE resource_type = 'character_prompt' AND resource_id = ?`,
  ).get(String(characterId));
  assert.equal(reservation.status, 'confirmed');
  assert.equal(reservation.model, 'GPT-5.5');
});

test('角色提示词模型未定价时返回 503 且不调用服务', async (t) => {
  const { db, characterId } = setup({ withPrice: false });
  const original = characterLibrary.generateCharacterPromptOnly;
  let calls = 0;
  t.after(() => { characterLibrary.generateCharacterPromptOnly = original; db.close(); });
  characterLibrary.generateCharacterPromptOnly = async () => {
    calls += 1;
    return { ok: true, polished_prompt: '不应调用' };
  };
  const { res, result } = capture();

  await characterRoutes(db, {}, log, null, { billingEnabled: true })
    .generatePrompt(request(characterId), res);

  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'MODEL_PRICE_NOT_CONFIGURED');
  assert.equal(calls, 0);
});

test('角色身份锚点模型未定价时返回 503 且不调用 AI', async (t) => {
  const { db, characterId } = setup({ withPrice: false });
  const original = aiClient.generateText;
  let calls = 0;
  t.after(() => { aiClient.generateText = original; db.close(); });
  aiClient.generateText = async () => {
    calls += 1;
    return '{}';
  };
  const { res, result } = capture();

  await characterRoutes(db, {}, log, null, { billingEnabled: true })
    .extractAnchors(request(characterId), res);

  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'MODEL_PRICE_NOT_CONFIGURED');
  assert.equal(calls, 0);
});

test('角色身份锚点提炼成功后确认文本模型积分', async (t) => {
  const { db, characterId } = setup();
  const original = aiClient.generateText;
  t.after(() => { aiClient.generateText = original; db.close(); });
  aiClient.generateText = async (_db, _log, _type, _prompt, _system, options) => {
    assert.equal(options.model, 'GPT-5.5');
    return JSON.stringify({
      color_anchors: { hair: '#111111', clothing: '#f6a5b5' },
      face: '圆脸',
    });
  };
  const { res, result } = capture();

  await characterRoutes(db, {}, log, null, { billingEnabled: true })
    .extractAnchors(request(characterId), res);

  assert.equal(result.status, 200);
  const reservation = db.prepare(
    `SELECT * FROM tenant_usage_reservations
     WHERE resource_type = 'character_identity_anchors' AND resource_id = ?`,
  ).get(String(characterId));
  assert.equal(reservation.status, 'confirmed');
  assert.equal(reservation.model, 'GPT-5.5');
  assert.ok(db.prepare('SELECT identity_anchors FROM characters WHERE id = ?').get(characterId).identity_anchors);
});

test('角色身份锚点提炼失败时退款并返回可见错误', async (t) => {
  const { db, characterId } = setup();
  const original = aiClient.generateText;
  t.after(() => { aiClient.generateText = original; db.close(); });
  aiClient.generateText = async () => {
    throw new Error('锚点供应商失败');
  };
  const { res, result } = capture();

  await characterRoutes(db, {}, log, null, { billingEnabled: true })
    .extractAnchors(request(characterId), res);

  assert.equal(result.status, 500);
  assert.match(result.body.error.message, /锚点供应商失败/);
  const reservation = db.prepare(
    `SELECT * FROM tenant_usage_reservations
     WHERE resource_type = 'character_identity_anchors' AND resource_id = ?`,
  ).get(String(characterId));
  assert.equal(reservation.status, 'refunded');
  assert.equal(credits.getTenantAccount(db, 'tenant-a').available, 30);
});

test('道具视觉提取失败时退回文本模型预扣积分', async (t) => {
  const { db, propId } = setup();
  const original = propService.extractPropFromImage;
  t.after(() => { propService.extractPropFromImage = original; db.close(); });
  propService.extractPropFromImage = async () => ({ ok: false, error: '供应商明确失败' });
  const { res, result } = capture();

  await propRoutes(db, log, {}, { billingEnabled: true })
    .extractPropFromImage(request(propId), res);

  assert.equal(result.status, 400);
  const reservation = db.prepare(
    `SELECT * FROM tenant_usage_reservations
     WHERE resource_type = 'prop_vision' AND resource_id = ?`,
  ).get(String(propId));
  assert.equal(reservation.status, 'refunded');
  assert.deepEqual(credits.getTenantAccount(db, 'tenant-a'), {
    tenant_id: 'tenant-a', available: 30, held: 0, spent: 0,
  });
});

test('场景视觉提取成功后确认文本模型积分', async (t) => {
  const { db, sceneId } = setup();
  const original = sceneService.extractSceneFromImage;
  t.after(() => { sceneService.extractSceneFromImage = original; db.close(); });
  sceneService.extractSceneFromImage = async () => ({ ok: true, prompt: '雨后庭院描述' });
  const { res, result } = capture();

  await sceneRoutes(db, log, {}, { billingEnabled: true })
    .extractFromImage(request(sceneId), res);

  assert.equal(result.status, 200);
  const reservation = db.prepare(
    `SELECT * FROM tenant_usage_reservations
     WHERE resource_type = 'scene_vision' AND resource_id = ?`,
  ).get(String(sceneId));
  assert.equal(reservation.status, 'confirmed');
});

test('角色四视图缺少润色提示词时按独立文本模型计费', async (t) => {
  const { db, characterId } = setup();
  const originalText = aiClient.generateText;
  const originalImage = imageClient.createAndGenerateImage;
  t.after(() => {
    aiClient.generateText = originalText;
    imageClient.createAndGenerateImage = originalImage;
    db.close();
  });
  aiClient.generateText = async (_db, _log, _type, _prompt, _system, options) => {
    assert.equal(options.model, 'GPT-5.5');
    return '角色四视图描述';
  };
  imageClient.createAndGenerateImage = (_db, _log, options) => {
    assert.equal(options.model, 'image-model');
    return { id: 101 };
  };

  const out = await characterLibrary.generateCharacterFourViewImage(
    db,
    log,
    {},
    characterId,
    'image-model',
    undefined,
    {
      billingEnabled: true,
      tenantId: 'tenant-a',
      userId: 'user-1',
      textModel: 'GPT-5.5',
    },
  );

  assert.equal(out.ok, true);
  const reservation = db.prepare(
    `SELECT * FROM tenant_usage_reservations
     WHERE resource_type = 'character_image_prompt' AND resource_id = ?`,
  ).get(String(characterId));
  assert.equal(reservation.status, 'confirmed');
  assert.equal(reservation.model, 'GPT-5.5');
  assert.equal(credits.getTenantAccount(db, 'tenant-a').spent, 5);
});

test('角色四视图文本生成失败时退回提示词预扣积分', async (t) => {
  const { db, characterId } = setup();
  const originalText = aiClient.generateText;
  const originalImage = imageClient.createAndGenerateImage;
  let imageCalls = 0;
  t.after(() => {
    aiClient.generateText = originalText;
    imageClient.createAndGenerateImage = originalImage;
    db.close();
  });
  aiClient.generateText = async () => { throw new Error('文本供应商失败'); };
  imageClient.createAndGenerateImage = () => {
    imageCalls += 1;
    return { id: 102 };
  };

  await assert.rejects(
    characterLibrary.generateCharacterFourViewImage(
      db,
      log,
      {},
      characterId,
      'image-model',
      undefined,
      {
        billingEnabled: true,
        tenantId: 'tenant-a',
        userId: 'user-1',
        textModel: 'GPT-5.5',
      },
    ),
    /文本供应商失败/,
  );

  const reservation = db.prepare(
    `SELECT * FROM tenant_usage_reservations
     WHERE resource_type = 'character_image_prompt' AND resource_id = ?`,
  ).get(String(characterId));
  assert.equal(reservation.status, 'refunded');
  assert.equal(imageCalls, 0);
  assert.equal(credits.getTenantAccount(db, 'tenant-a').available, 30);
});

test('场景四视图缺少润色提示词时按独立文本模型计费', async (t) => {
  const { db, sceneId } = setup();
  const originalText = aiClient.generateText;
  const originalImage = imageClient.createAndGenerateImage;
  t.after(() => {
    aiClient.generateText = originalText;
    imageClient.createAndGenerateImage = originalImage;
    db.close();
  });
  aiClient.generateText = async (_db, _log, _type, _prompt, _system, options) => {
    assert.equal(options.model, 'GPT-5.5');
    return '场景四视图描述';
  };
  imageClient.createAndGenerateImage = (_db, _log, options) => {
    assert.equal(options.model, 'image-model');
    return { id: 201 };
  };

  const out = await sceneService.generateSceneFourViewImage(
    db,
    log,
    {},
    sceneId,
    'image-model',
    undefined,
    {
      billingEnabled: true,
      tenantId: 'tenant-a',
      userId: 'user-1',
      textModel: 'GPT-5.5',
    },
  );

  assert.equal(out.ok, true);
  const reservation = db.prepare(
    `SELECT * FROM tenant_usage_reservations
     WHERE resource_type = 'scene_image_prompt' AND resource_id = ?`,
  ).get(String(sceneId));
  assert.equal(reservation.status, 'confirmed');
  assert.equal(reservation.model, 'GPT-5.5');
});

test('角色四视图文本模型未定价时返回 503 且不提交图片任务', async (t) => {
  const { db, characterId } = setup({ withPrice: false });
  const originalImage = imageClient.createAndGenerateImage;
  let imageCalls = 0;
  t.after(() => {
    imageClient.createAndGenerateImage = originalImage;
    db.close();
  });
  imageClient.createAndGenerateImage = () => {
    imageCalls += 1;
    return { id: 103 };
  };
  const { res, result } = capture();

  await characterRoutes(db, {}, log, null, { billingEnabled: true })
    .generateFourViewImage(request(characterId, {
      model: 'image-model',
      text_model: 'GPT-5.5',
    }), res);

  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'MODEL_PRICE_NOT_CONFIGURED');
  assert.equal(imageCalls, 0);
});

test('剧集道具异步提取成功后确认积分', async (t) => {
  const { db, episodeId } = setup();
  const original = aiClient.generateText;
  t.after(() => { aiClient.generateText = original; db.close(); });
  aiClient.generateText = async (_db, _log, _type, _prompt, _system, options) => {
    assert.equal(options.model, 'GPT-5.5');
    return JSON.stringify([{
      name: '刻纹木牌',
      type: '线索',
      description: '一块刻有纹路的旧木牌',
      image_prompt: 'an old carved wooden tablet',
    }]);
  };

  const taskId = propExtractionService.extractPropsForEpisode(
    db,
    log,
    episodeId,
    {},
    {
      billingEnabled: true,
      tenantId: 'tenant-a',
      userId: 'user-1',
      model: 'GPT-5.5',
    },
  );

  const task = await waitForTask(db, taskId);
  assert.equal(task.status, 'completed');
  const reservation = db.prepare(
    'SELECT * FROM tenant_usage_reservations WHERE id = ?',
  ).get(task.credit_reservation_id);
  assert.equal(reservation.status, 'confirmed');
  assert.equal(credits.getTenantAccount(db, 'tenant-a').spent, 5);
});

test('道具提取缺少图片提示词时按第二次实际模型调用独立计费', async (t) => {
  const { db, episodeId } = setup();
  const original = aiClient.generateText;
  let calls = 0;
  t.after(() => { aiClient.generateText = original; db.close(); });
  aiClient.generateText = async (_db, _log, _type, _prompt, _system, options) => {
    calls += 1;
    assert.equal(options.model, 'GPT-5.5');
    return calls === 1
      ? JSON.stringify([{
        name: '刻纹木牌',
        type: '线索',
        description: '一块刻有纹路的旧木牌',
      }])
      : 'an old carved wooden tablet';
  };

  const taskId = propExtractionService.extractPropsForEpisode(
    db,
    log,
    episodeId,
    {},
    {
      billingEnabled: true,
      tenantId: 'tenant-a',
      userId: 'user-1',
      model: 'GPT-5.5',
    },
  );

  const task = await waitForTask(db, taskId);
  assert.equal(task.status, 'completed');
  assert.equal(calls, 2);
  const reservations = db.prepare(
    "SELECT * FROM tenant_usage_reservations WHERE resource_type IN ('episode_props', 'prop_prompt')",
  ).all();
  assert.equal(reservations.length, 2);
  assert.ok(reservations.every((item) => item.status === 'confirmed'));
  assert.equal(credits.getTenantAccount(db, 'tenant-a').spent, 10);
});

test('剧集道具异步提取失败后退款', async (t) => {
  const { db, episodeId } = setup();
  const original = aiClient.generateText;
  t.after(() => { aiClient.generateText = original; db.close(); });
  aiClient.generateText = async () => { throw new Error('供应商明确失败'); };

  const taskId = propExtractionService.extractPropsForEpisode(
    db,
    log,
    episodeId,
    {},
    {
      billingEnabled: true,
      tenantId: 'tenant-a',
      userId: 'user-1',
      model: 'GPT-5.5',
    },
  );

  const task = await waitForTask(db, taskId);
  assert.equal(task.status, 'failed');
  const reservation = db.prepare(
    'SELECT * FROM tenant_usage_reservations WHERE id = ?',
  ).get(task.credit_reservation_id);
  assert.equal(reservation.status, 'refunded');
  assert.equal(credits.getTenantAccount(db, 'tenant-a').available, 30);
});
