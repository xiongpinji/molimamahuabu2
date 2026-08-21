const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const aiClient = require('../src/services/aiClient');
const aiConfig = require('../src/services/aiConfigService');
const credits = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const storyboardRoutes = require('../src/routes/storyboards');
const episodeStoryboardService = require('../src/services/episodeStoryboardService');
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
  const episodeId = db.prepare(
    `INSERT INTO episodes
      (drama_id, episode_number, title, script_content, created_at, updated_at)
     VALUES (?, 1, '第一集', '母女在雨后的庭院相遇。', ?, ?)`,
  ).run(dramaId, now, now).lastInsertRowid;
  const storyboardId = db.prepare(
    `INSERT INTO storyboards
      (episode_id, storyboard_number, title, action, dialogue, duration,
        creation_mode, created_at, updated_at)
     VALUES (?, 1, '相遇', '母亲走进庭院', '妈妈：你回来了。', 5, 'classic', ?, ?)`,
  ).run(episodeId, now, now).lastInsertRowid;
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
  credits.setTenantAccountBalance(db, 'tenant-a', 20);
  if (withPrice) prices.set(db, 'GPT-5.5', 5);
  return { db, dramaId, episodeId, storyboardId };
}

function request(storyboardId, body = {}) {
  return {
    params: { id: storyboardId },
    body: { model: 'GPT-5.5', force_without_reference_images: true, ...body },
    user: { id: 'user-1' },
    tenant: { id: 'tenant-a' },
  };
}

function captureJson() {
  const result = {};
  return {
    result,
    res: {
      status(code) { result.status = code; return this; },
      json(body) { result.body = body; return this; },
    },
  };
}

function captureStream() {
  const result = { chunks: [], headers: {} };
  return {
    result,
    res: {
      status(code) { result.status = code; return this; },
      json(body) { result.body = body; return this; },
      setHeader(name, value) { result.headers[name] = value; },
      flushHeaders() {},
      write(chunk) { result.chunks.push(String(chunk)); return true; },
      end() { result.ended = true; return this; },
    },
  };
}

async function waitForTask(db, taskId) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const task = db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(taskId);
    if (task && ['completed', 'failed'].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待任务 ${taskId} 超时`);
}

test('分镜全能提示词按实际文本模型计费并确认积分', async (t) => {
  const { db, storyboardId } = setup();
  const original = aiClient.generateText;
  t.after(() => { aiClient.generateText = original; db.close(); });
  aiClient.generateText = async () => '分镜1：5秒。镜头缓慢推进，母亲走进雨后庭院并说出对白。';
  const { res, result } = captureJson();

  await storyboardRoutes(db, log, { billingEnabled: true })
    .generateUniversalSegmentPrompt(request(storyboardId), res);

  assert.equal(result.status, 200);
  const reservation = db.prepare(
    `SELECT * FROM tenant_usage_reservations
     WHERE resource_type = 'storyboard_prompt' AND resource_id = ?`,
  ).get(String(storyboardId));
  assert.equal(reservation.model, 'GPT-5.5');
  assert.equal(reservation.status, 'confirmed');
  assert.equal(credits.getTenantAccount(db, 'tenant-a').spent, 5);
});

test('分镜全能提示词在模型未定价时返回 503 且不调用供应商', async (t) => {
  const { db, storyboardId } = setup({ withPrice: false });
  const original = aiClient.generateText;
  let calls = 0;
  t.after(() => { aiClient.generateText = original; db.close(); });
  aiClient.generateText = async () => { calls += 1; return '不应调用'; };
  const { res, result } = captureJson();

  await storyboardRoutes(db, log, { billingEnabled: true })
    .generateUniversalSegmentPrompt(request(storyboardId), res);

  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'MODEL_PRICE_NOT_CONFIGURED');
  assert.equal(calls, 0);
});

test('分镜提示词润色与连戏快照按两次实际模型调用分别计费', async (t) => {
  const { db, storyboardId } = setup();
  const original = aiClient.generateText;
  let calls = 0;
  t.after(() => { aiClient.generateText = original; db.close(); });
  aiClient.generateText = async (_db, _log, _type, _userPrompt, _systemPrompt, options) => {
    calls += 1;
    assert.equal(options.model, 'GPT-5.5');
    return calls === 1
      ? '雨后庭院里，母亲沿石阶缓慢走近，画面保持单镜头构图。'
      : JSON.stringify({ character_state: '母亲站在石阶左侧' });
  };
  const { res, result } = captureJson();

  await storyboardRoutes(db, log, { billingEnabled: true })
    .polishPrompt(request(storyboardId), res);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(result.status, 200);
  assert.equal(calls, 2);
  const reservations = db.prepare(
    `SELECT * FROM tenant_usage_reservations
     WHERE resource_type = 'storyboard_prompt' AND resource_id = ?`,
  ).all(String(storyboardId));
  assert.equal(reservations.length, 2);
  assert.ok(reservations.every((item) => item.status === 'confirmed'));
  assert.equal(credits.getTenantAccount(db, 'tenant-a').spent, 10);
});

test('分镜流式提示词供应商失败时退回预扣积分', async (t) => {
  const { db, storyboardId } = setup();
  const original = aiClient.streamGenerateText;
  t.after(() => { aiClient.streamGenerateText = original; db.close(); });
  aiClient.streamGenerateText = async () => { throw new Error('供应商明确失败'); };
  const { res, result } = captureStream();

  await storyboardRoutes(db, log, { billingEnabled: true })
    .generateUniversalSegmentStream(request(storyboardId), res);

  assert.equal(result.status, 200);
  assert.match(result.chunks.join(''), /"type":"error"/);
  const reservation = db.prepare(
    `SELECT * FROM tenant_usage_reservations
     WHERE resource_type = 'storyboard_prompt' AND resource_id = ?`,
  ).get(String(storyboardId));
  assert.equal(reservation.status, 'refunded');
  assert.deepEqual(credits.getTenantAccount(db, 'tenant-a'), {
    tenant_id: 'tenant-a', available: 20, held: 0, spent: 0,
  });
});

test('五个分镜文本入口均声明独立计费操作', () => {
  const source = require('fs').readFileSync(
    require.resolve('../src/routes/storyboards'),
    'utf8',
  );
  for (const operation of [
    'storyboard_image_polish',
    'storyboard_universal_prompt',
    'storyboard_universal_prompt_stream',
    'storyboard_universal_polish_stream',
    'storyboard_classic_video_polish_stream',
  ]) {
    assert.match(source, new RegExp(`beginStoryboardTextBilling\\([^\\n]+${operation}`));
  }
});

test('帧提示词异步任务成功后确认预扣积分', async (t) => {
  const { db, storyboardId } = setup();
  const original = aiClient.generateText;
  t.after(() => { aiClient.generateText = original; db.close(); });
  aiClient.generateText = async () => JSON.stringify({
    prompt: '雨后庭院里，母亲站在石阶前。',
    description: '镜头开始的静态画面',
  });
  const { res, result } = captureJson();

  storyboardRoutes(db, log, { billingEnabled: true })
    .framePrompt(request(storyboardId, { frame_type: 'first' }), res);

  assert.equal(result.status, 200);
  const task = await waitForTask(db, result.body.data.task_id);
  assert.equal(task.status, 'completed');
  assert.equal(task.model, 'GPT-5.5');
  assert.ok(task.credit_reservation_id);
  const reservation = db.prepare(
    'SELECT * FROM tenant_usage_reservations WHERE id = ?',
  ).get(task.credit_reservation_id);
  assert.equal(reservation.status, 'confirmed');
  assert.equal(credits.getTenantAccount(db, 'tenant-a').spent, 5);
});

test('帧提示词供应商失败后任务失败并退款', async (t) => {
  const { db, storyboardId } = setup();
  const original = aiClient.generateText;
  t.after(() => { aiClient.generateText = original; db.close(); });
  aiClient.generateText = async () => { throw new Error('供应商明确失败'); };
  const { res, result } = captureJson();

  storyboardRoutes(db, log, { billingEnabled: true })
    .framePrompt(request(storyboardId, { frame_type: 'first' }), res);

  assert.equal(result.status, 200);
  const task = await waitForTask(db, result.body.data.task_id);
  assert.equal(task.status, 'failed');
  const reservation = db.prepare(
    'SELECT * FROM tenant_usage_reservations WHERE id = ?',
  ).get(task.credit_reservation_id);
  assert.equal(reservation.status, 'refunded');
  assert.equal(credits.getTenantAccount(db, 'tenant-a').available, 20);
});

test('帧提示词模型未定价时返回 503 且不创建任务', () => {
  const { db, storyboardId } = setup({ withPrice: false });
  const { res, result } = captureJson();

  storyboardRoutes(db, log, { billingEnabled: true })
    .framePrompt(request(storyboardId, { frame_type: 'first' }), res);

  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'MODEL_PRICE_NOT_CONFIGURED');
  assert.equal(db.prepare(
    "SELECT COUNT(*) AS count FROM async_tasks WHERE type = 'frame_prompt_generation'",
  ).get().count, 0);
  db.close();
});

test('布局描述重生成按实际文本模型计费并确认积分', async (t) => {
  const { db, storyboardId } = setup();
  const original = aiClient.generateText;
  t.after(() => { aiClient.generateText = original; db.close(); });
  aiClient.generateText = async (_db, _log, _type, _userPrompt, _systemPrompt, options) => {
    assert.equal(options.model, 'GPT-5.5');
    return '母亲位于画面左侧，庭院石阶沿纵深延伸。';
  };
  const { res, result } = captureJson();

  await storyboardRoutes(db, log, { billingEnabled: true })
    .regenerateLayoutDescription(request(storyboardId), res);

  assert.equal(result.status, 200);
  const reservation = db.prepare(
    `SELECT * FROM tenant_usage_reservations
     WHERE resource_type = 'storyboard_layout' AND resource_id = ?`,
  ).get(String(storyboardId));
  assert.equal(reservation.status, 'confirmed');
  assert.equal(credits.getTenantAccount(db, 'tenant-a').spent, 5);
});

test('整集分镜异步生成成功后确认积分', async (t) => {
  const { db, episodeId } = setup();
  const original = aiClient.generateText;
  t.after(() => { aiClient.generateText = original; db.close(); });
  aiClient.generateText = async (_db, _log, _type, _userPrompt, _systemPrompt, options) => {
    assert.equal(options.model, 'GPT-5.5');
    return JSON.stringify([{
      shot_number: 1,
      title: '庭院相遇',
      action: '母亲走进雨后庭院。',
      dialogue: '妈妈：你回来了。',
      duration: 5,
    }]);
  };

  const started = episodeStoryboardService.generateStoryboard(
    db,
    log,
    episodeId,
    'GPT-5.5',
    undefined,
    1,
    5,
    '16:9',
    false,
    false,
    {
      billingEnabled: true,
      tenantId: 'tenant-a',
      userId: 'user-1',
    },
  );

  const task = await waitForTask(db, started.task_id);
  assert.equal(task.status, 'completed');
  assert.equal(task.model, 'GPT-5.5');
  const reservation = db.prepare(
    'SELECT * FROM tenant_usage_reservations WHERE id = ?',
  ).get(task.credit_reservation_id);
  assert.equal(reservation.status, 'confirmed');
  assert.equal(credits.getTenantAccount(db, 'tenant-a').spent, 5);
});

test('整集分镜截断续写按第二次实际模型调用独立计费', async (t) => {
  const { db, episodeId } = setup();
  const original = aiClient.generateText;
  let calls = 0;
  t.after(() => { aiClient.generateText = original; db.close(); });
  aiClient.generateText = async () => {
    calls += 1;
    if (calls === 1) {
      return '[{"shot_number":1,"title":"相遇","action":"母亲走进庭院","duration":5},{"shot_number":2';
    }
    return JSON.stringify([{
      shot_number: 2,
      title: '对望',
      action: '母女在雨中对望。',
      duration: 5,
    }]);
  };

  const started = episodeStoryboardService.generateStoryboard(
    db, log, episodeId, 'GPT-5.5', undefined, undefined, undefined, undefined,
    false, false,
    { billingEnabled: true, tenantId: 'tenant-a', userId: 'user-1' },
  );

  const task = await waitForTask(db, started.task_id);
  assert.equal(task.status, 'completed');
  assert.equal(calls, 2);
  const reservations = db.prepare(
    "SELECT * FROM tenant_usage_reservations WHERE resource_type = 'episode_storyboards'",
  ).all();
  assert.equal(reservations.length, 2);
  assert.ok(reservations.every((item) => item.status === 'confirmed'));
  assert.equal(credits.getTenantAccount(db, 'tenant-a').spent, 10);
});

test('整集分镜数量校正按第二次实际模型调用独立计费', async (t) => {
  const { db, episodeId } = setup();
  const original = aiClient.generateText;
  let calls = 0;
  t.after(() => { aiClient.generateText = original; db.close(); });
  aiClient.generateText = async () => {
    calls += 1;
    const count = calls === 1 ? 1 : 2;
    return JSON.stringify(Array.from({ length: count }, (_, index) => ({
      shot_number: index + 1,
      title: `镜头${index + 1}`,
      action: `动作${index + 1}`,
      duration: 5,
    })));
  };

  const started = episodeStoryboardService.generateStoryboard(
    db, log, episodeId, 'GPT-5.5', undefined, 2, 10, '16:9',
    false, false,
    { billingEnabled: true, tenantId: 'tenant-a', userId: 'user-1' },
  );

  const task = await waitForTask(db, started.task_id);
  assert.equal(task.status, 'completed');
  assert.equal(calls, 2);
  const reservations = db.prepare(
    "SELECT * FROM tenant_usage_reservations WHERE resource_type = 'episode_storyboards'",
  ).all();
  assert.equal(reservations.length, 2);
  assert.ok(reservations.every((item) => item.status === 'confirmed'));
  assert.equal(credits.getTenantAccount(db, 'tenant-a').spent, 10);
});

test('公开计费模式不隐式重试被模型拒绝的 max_tokens 参数', async (t) => {
  const { db, episodeId } = setup();
  const original = aiClient.generateText;
  let calls = 0;
  t.after(() => { aiClient.generateText = original; db.close(); });
  aiClient.generateText = async () => {
    calls += 1;
    throw new Error('HTTP 400: max_tokens is not supported');
  };

  const started = episodeStoryboardService.generateStoryboard(
    db, log, episodeId, 'GPT-5.5', undefined, undefined, undefined, undefined,
    false, false,
    { billingEnabled: true, tenantId: 'tenant-a', userId: 'user-1' },
  );

  const task = await waitForTask(db, started.task_id);
  assert.equal(task.status, 'failed');
  assert.equal(calls, 1);
  assert.equal(credits.getReservation(db, task.credit_reservation_id).status, 'refunded');
  assert.equal(credits.getTenantAccount(db, 'tenant-a').available, 20);
});

test('整集分镜供应商失败后退款', async (t) => {
  const { db, episodeId } = setup();
  const original = aiClient.generateText;
  t.after(() => { aiClient.generateText = original; db.close(); });
  aiClient.generateText = async () => { throw new Error('供应商明确失败'); };

  const started = episodeStoryboardService.generateStoryboard(
    db,
    log,
    episodeId,
    'GPT-5.5',
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    false,
    {
      billingEnabled: true,
      tenantId: 'tenant-a',
      userId: 'user-1',
    },
  );

  const task = await waitForTask(db, started.task_id);
  assert.equal(task.status, 'failed');
  const reservation = db.prepare(
    'SELECT * FROM tenant_usage_reservations WHERE id = ?',
  ).get(task.credit_reservation_id);
  assert.equal(reservation.status, 'refunded');
  assert.equal(credits.getTenantAccount(db, 'tenant-a').available, 20);
});

test('整集分镜模型未定价时拒绝创建任务', () => {
  const { db, episodeId } = setup({ withPrice: false });

  assert.throws(
    () => episodeStoryboardService.generateStoryboard(
      db,
      log,
      episodeId,
      'GPT-5.5',
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      false,
      {
        billingEnabled: true,
        tenantId: 'tenant-a',
        userId: 'user-1',
      },
    ),
    { code: 'MODEL_PRICE_NOT_CONFIGURED' },
  );
  assert.equal(db.prepare(
    "SELECT COUNT(*) AS count FROM async_tasks WHERE type = 'storyboard_generation'",
  ).get().count, 0);
  db.close();
});
