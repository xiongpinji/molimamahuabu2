const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Database = require('better-sqlite3');

const aiConfigService = require('../src/services/aiConfigService');
const creditLedgerService = require('../src/services/creditLedgerService');
const imageClient = require('../src/services/imageClient');
const imageService = require('../src/services/imageService');
const imageRoutes = require('../src/routes/images');
const modelPriceService = require('../src/services/modelPriceService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function createDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  modelPriceService.set(db, 'logical-image', 40, { category: 'image' });
  return db;
}

function addRoute(db, values) {
  const config = aiConfigService.createConfig(db, log, {
    service_type: 'image',
    provider: values.provider,
    api_protocol: values.apiProtocol || 'openai',
    name: values.provider,
    base_url: values.baseUrl,
    api_key: 'local-test-key',
    model: [values.upstreamModel],
    default_model: values.upstreamModel,
    endpoint: values.endpoint || '/images/generations',
    priority: values.priority,
    logical_model_id: values.logicalModelId === undefined ? 'logical-image' : values.logicalModelId,
    failover_enabled: Boolean(values.failover),
    settings: values.settings || JSON.stringify({ canvas_capabilities: {} }),
  });
  db.prepare("UPDATE ai_service_configs SET verification_status = 'verified' WHERE id = ?")
    .run(config.id);
  return config.id;
}

function addGeneration(db, id) {
  db.prepare(`INSERT INTO image_generations
    (id, prompt, model, status, created_at, updated_at)
    VALUES (?, 'user prompt', 'logical-image', 'processing', ?, ?)`)
    .run(id, '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z');
}

test('明确无通道才切换到已验证的同逻辑模型并保留最终配置', async (t) => {
  const requests = [];
  const primary = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push('primary');
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NO_AVAILABLE_CHANNEL', message: 'No available channel' } }));
    });
  });
  const backup = await listen((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')).model);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ url: 'https://cdn.example/success.png' }] }));
    });
  });
  t.after(async () => Promise.all([close(primary), close(backup)]));

  const db = createDb();
  t.after(() => db.close());
  const primaryId = addRoute(db, {
    provider: 'private-primary', baseUrl: `http://127.0.0.1:${primary.address().port}`,
    upstreamModel: 'upstream-primary', priority: 100,
  });
  const backupId = addRoute(db, {
    provider: 'private-backup', baseUrl: `http://127.0.0.1:${backup.address().port}`,
    upstreamModel: 'upstream-backup', priority: 90, failover: true,
  });
  addGeneration(db, 3001);

  const result = await imageClient.callImageApi(db, log, {
    prompt: 'user prompt', model: 'logical-image', image_gen_id: 3001,
  });

  assert.deepEqual(result, { image_url: 'https://cdn.example/success.png' });
  assert.deepEqual(requests, ['primary', 'upstream-backup']);
  assert.equal(db.prepare('SELECT config_id FROM image_generations WHERE id = 3001').get().config_id, backupId);
  assert.deepEqual(
    db.prepare('SELECT state, final_config_id FROM generation_route_requests').get(),
    { state: 'succeeded', final_config_id: backupId },
  );
  assert.deepEqual(
    db.prepare(`SELECT config_id, state, error_category FROM generation_route_attempts
      ORDER BY attempt_no`).all(),
    [
      { config_id: primaryId, state: 'failed', error_category: 'provider_unavailable' },
      { config_id: backupId, state: 'succeeded', error_category: null },
    ],
  );
  assert.deepEqual(
    db.prepare(`SELECT event_type, config_id, target_config_id
      FROM provider_stability_events WHERE event_type = 'route_switched'`).get(),
    { event_type: 'route_switched', config_id: primaryId, target_config_id: backupId },
  );
});

test('图片备用供应商半开探测被占用时不会重复调用或误记切换', async (t) => {
  const requests = [];
  const primary = await listen((req, res) => {
    requests.push('primary');
    req.resume();
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NO_AVAILABLE_CHANNEL', message: 'No available channel' } }));
  });
  const backup = await listen((req, res) => {
    requests.push('backup');
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ url: 'https://cdn.example/should-not-run.png' }] }));
  });
  t.after(async () => Promise.all([close(primary), close(backup)]));
  const db = createDb();
  t.after(() => db.close());
  addRoute(db, {
    provider: 'private-primary', baseUrl: `http://127.0.0.1:${primary.address().port}`,
    upstreamModel: 'upstream-primary', priority: 100,
  });
  const backupId = addRoute(db, {
    provider: 'private-backup', baseUrl: `http://127.0.0.1:${backup.address().port}`,
    upstreamModel: 'upstream-backup', priority: 90, failover: true,
  });
  db.prepare(`INSERT INTO provider_route_health
    (config_id, state, consecutive_failures, half_open_claimed_at, updated_at)
    VALUES (?, 'half_open', 3, ?, ?)`).run(
    backupId, '2026-08-15T00:09:00.000Z', '2026-08-15T00:09:00.000Z',
  );

  const result = await imageClient.callImageApi(db, log, {
    prompt: 'user prompt', model: 'logical-image', image_gen_id: 3002,
  });
  assert.deepEqual(result, { error: '图片生成服务暂时不可用，请稍后再试。' });
  assert.deepEqual(requests, ['primary']);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM provider_stability_events WHERE event_type = 'route_switched'")
      .get().count,
    0,
  );
  assert.equal(db.prepare('SELECT state FROM generation_route_requests').get().state, 'failed');
});

for (const scenario of [
  {
    name: '内容安全 400',
    status: 400,
    payload: { error: { code: 'CONTENT_POLICY', message: 'content policy rejected' } },
    expectedCategory: 'policy_rejected',
  },
  {
    name: '无结构化证据的通用 503',
    status: 503,
    payload: { error: { message: 'temporary upstream error' } },
    expectedCategory: 'submission_unknown',
  },
  {
    name: '无法区分原因的 403',
    status: 403,
    payload: { error: { message: 'forbidden' } },
    expectedCategory: 'forbidden_unknown',
  },
  {
    name: '参考图超限 413',
    status: 413,
    payload: { error: { code: 'BAD_REQUEST', message: 'too many reference images' } },
    expectedCategory: 'validation_error',
  },
  {
    name: '参数不支持 422',
    status: 422,
    payload: { error: { code: 'INVALID_ARGUMENT', message: 'unsupported image size' } },
    expectedCategory: 'validation_error',
  },
  {
    name: '已返回任务号的 503',
    status: 503,
    payload: { task_id: 'accepted-task-1', error: { code: 'NO_AVAILABLE_CHANNEL', message: 'late response' } },
    expectedCategory: 'result_unknown',
  },
]) {
  test(`${scenario.name}不会重复提交到备用供应商`, async (t) => {
    const requests = [];
    const primary = await listen((req, res) => {
      req.resume();
      req.on('end', () => {
        requests.push('primary');
        res.writeHead(scenario.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(scenario.payload));
      });
    });
    const backup = await listen((req, res) => {
      req.resume();
      req.on('end', () => {
        requests.push('backup');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ url: 'https://cdn.example/should-not-run.png' }] }));
      });
    });
    t.after(async () => Promise.all([close(primary), close(backup)]));

    const db = createDb();
    t.after(() => db.close());
    addRoute(db, {
      provider: 'private-primary', baseUrl: `http://127.0.0.1:${primary.address().port}`,
      upstreamModel: 'upstream-primary', priority: 100,
    });
    addRoute(db, {
      provider: 'private-backup', baseUrl: `http://127.0.0.1:${backup.address().port}`,
      upstreamModel: 'upstream-backup', priority: 90, failover: true,
    });

    const result = await imageClient.callImageApi(db, log, {
      prompt: 'user prompt', model: 'logical-image', image_gen_id: 3100 + scenario.status,
    });

    assert.ok(result.error);
    assert.deepEqual(requests, ['primary']);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM generation_route_attempts').get().count, 1);
    assert.equal(
      db.prepare('SELECT error_category FROM generation_route_attempts').get().error_category,
      scenario.expectedCategory,
    );
  });
}

for (const failover of [
  {
    name: '明确 401',
    status: 401,
    payload: { error: { code: 'INVALID_API_KEY', message: 'rejected before task creation' } },
    expectedHealth: 'disabled',
  },
  {
    name: '明确限流 429',
    status: 429,
    payload: { error: { code: 'RATE_LIMITED', message: 'request rejected by rate limiter' } },
    expectedHealth: 'degraded',
  },
]) {
  test(`${failover.name}可切换且用户结果不暴露中转站`, async (t) => {
    const primary = await listen((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(failover.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(failover.payload));
      });
    });
    const backup = await listen((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ url: 'https://cdn.example/failover-success.png' }] }));
      });
    });
    t.after(async () => Promise.all([close(primary), close(backup)]));

    const db = createDb();
    t.after(() => db.close());
    const primaryId = addRoute(db, {
      provider: 'private-primary', baseUrl: `http://127.0.0.1:${primary.address().port}`,
      upstreamModel: 'upstream-primary', priority: 100,
    });
    addRoute(db, {
      provider: 'private-backup', baseUrl: `http://127.0.0.1:${backup.address().port}`,
      upstreamModel: 'upstream-backup', priority: 90, failover: true,
    });

    const result = await imageClient.callImageApi(db, log, {
      prompt: 'user prompt', model: 'logical-image', image_gen_id: 3400 + failover.status,
    });

    assert.deepEqual(result, { image_url: 'https://cdn.example/failover-success.png' });
    assert.equal(JSON.stringify(result).includes('private-'), false);
    assert.equal(db.prepare('SELECT state FROM provider_route_health WHERE config_id = ?').get(primaryId).state,
      failover.expectedHealth);
  });
}

test('所有已验证供应商均明确拒绝时只返回安全错误摘要', async (t) => {
  const primary = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: { code: 'INVALID_API_KEY', message: 'secret primary relay detail' },
      }));
    });
  });
  const backup = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: { code: 'RATE_LIMITED', message: 'secret backup relay detail' },
      }));
    });
  });
  t.after(async () => Promise.all([close(primary), close(backup)]));

  const db = createDb();
  t.after(() => db.close());
  addRoute(db, {
    provider: 'private-primary', baseUrl: `http://127.0.0.1:${primary.address().port}`,
    upstreamModel: 'upstream-primary', priority: 100,
  });
  addRoute(db, {
    provider: 'private-backup', baseUrl: `http://127.0.0.1:${backup.address().port}`,
    upstreamModel: 'upstream-backup', priority: 90, failover: true,
  });

  const result = await imageClient.callImageApi(db, log, {
    prompt: 'user prompt', model: 'logical-image', image_gen_id: 3499,
  });

  assert.deepEqual(result, { error: '图片生成服务暂时不可用，请稍后再试。' });
  assert.equal(JSON.stringify(result).includes('private-'), false);
  assert.equal(JSON.stringify(result).includes('upstream-'), false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.deepEqual(
    db.prepare('SELECT state, error_category FROM generation_route_attempts ORDER BY attempt_no').all(),
    [
      { state: 'failed', error_category: 'auth_unavailable' },
      { state: 'failed', error_category: 'rate_limited' },
    ],
  );
  assert.equal(db.prepare('SELECT state FROM generation_route_requests').get().state, 'failed');
});

test('2xx 无可读产物为结果未知且不切换', async (t) => {
  const requests = [];
  const primary = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push('primary');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ request_id: 'request-known', data: [{ url: 'javascript:alert(1)' }] }));
    });
  });
  const backup = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push('backup');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ url: 'https://cdn.example/should-not-run.png' }] }));
    });
  });
  t.after(async () => Promise.all([close(primary), close(backup)]));

  const db = createDb();
  t.after(() => db.close());
  addRoute(db, {
    provider: 'private-primary', baseUrl: `http://127.0.0.1:${primary.address().port}`,
    upstreamModel: 'upstream-primary', priority: 100,
  });
  addRoute(db, {
    provider: 'private-backup', baseUrl: `http://127.0.0.1:${backup.address().port}`,
    upstreamModel: 'upstream-backup', priority: 90, failover: true,
  });

  const result = await imageClient.callImageApi(db, log, {
    prompt: 'user prompt', model: 'logical-image', image_gen_id: 3201,
  });

  assert.equal(result.indeterminate, true);
  assert.match(result.error, /结果未知/);
  assert.deepEqual(requests, ['primary']);
  assert.equal(db.prepare('SELECT error_category FROM generation_route_attempts').get().error_category,
    'artifact_unreadable');
});

test('Token6688 200 无图片地址进入 needs_attention 且不切换备用供应商', async (t) => {
  const requests = [];
  const primary = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push('token6688-primary');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{}] }));
    });
  });
  const backup = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push('backup');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ url: 'https://cdn.example/should-not-run.png' }] }));
    });
  });
  t.after(async () => Promise.all([close(primary), close(backup)]));

  const db = createDb();
  t.after(() => db.close());
  const primaryId = addRoute(db, {
    provider: 'token6688-primary',
    apiProtocol: 'token6688',
    endpoint: '/v1/images/generations',
    baseUrl: `http://127.0.0.1:${primary.address().port}`,
    upstreamModel: 'token6688-gpt-image-2',
    priority: 100,
  });
  addRoute(db, {
    provider: 'private-backup',
    baseUrl: `http://127.0.0.1:${backup.address().port}`,
    upstreamModel: 'upstream-backup',
    priority: 90,
    failover: true,
  });

  const result = await imageClient.callImageApi(db, log, {
    prompt: 'user prompt',
    model: 'logical-image',
    image_gen_id: 3202,
  });

  assert.equal(result.indeterminate, true);
  assert.match(result.error, /结果未知/);
  assert.deepEqual(requests, ['token6688-primary']);
  assert.deepEqual(
    db.prepare('SELECT state, final_config_id FROM generation_route_requests').get(),
    { state: 'needs_attention', final_config_id: null },
  );
  assert.deepEqual(
    db.prepare('SELECT config_id, state, error_category FROM generation_route_attempts').get(),
    { config_id: primaryId, state: 'artifact_unreadable', error_category: 'artifact_unreadable' },
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM provider_stability_events WHERE event_type = 'route_switched'")
      .get().count,
    0,
  );
  const stabilityEvent = db.prepare(
    "SELECT event_type, task_state, credit_state, safe_details FROM provider_stability_events WHERE event_type = 'provider_failure'",
  ).get();
  assert.equal(stabilityEvent.task_state, 'needs_attention');
  assert.equal(stabilityEvent.credit_state, 'held');
  assert.deepEqual(JSON.parse(stabilityEvent.safe_details), {
    category: 'artifact_unreadable',
    state: 'degraded',
    business_type: 'image_generation',
    business_id: 3202,
  });
});

test('shadow 旧 Token6688 配置断连也记录 needs_attention 路由尝试与管理员事件', async (t) => {
  const provider = await listen((req, res) => {
    req.resume();
    req.on('end', () => req.socket.destroy());
  });
  t.after(() => close(provider));

  const db = createDb();
  t.after(() => db.close());
  const configId = addRoute(db, {
    provider: 'token6688-legacy',
    apiProtocol: 'token6688',
    endpoint: '/v1/images/generations',
    baseUrl: `http://127.0.0.1:${provider.address().port}`,
    upstreamModel: 'token6688-gpt-image-2',
    priority: 100,
    logicalModelId: null,
  });

  const result = await imageClient.callImageApi(db, log, {
    prompt: 'user prompt',
    model: 'token6688-gpt-image-2',
    image_gen_id: 3203,
    creditReservationId: 'held-3203',
  });

  assert.equal(result.indeterminate, true);
  assert.deepEqual(
    db.prepare('SELECT state, business_type, business_id FROM generation_route_requests').get(),
    { state: 'needs_attention', business_type: 'image_generation', business_id: '3203' },
  );
  assert.deepEqual(
    db.prepare('SELECT config_id, state, error_category FROM generation_route_attempts').get(),
    { config_id: configId, state: 'submission_unknown', error_category: 'submission_unknown' },
  );
  const event = db.prepare(
    "SELECT config_id, task_state, credit_state, safe_details FROM provider_stability_events WHERE event_type = 'provider_failure'",
  ).get();
  assert.equal(event.config_id, configId);
  assert.equal(event.task_state, 'needs_attention');
  assert.equal(event.credit_state, 'held');
  assert.deepEqual(JSON.parse(event.safe_details), {
    category: 'submission_unknown',
    state: 'degraded',
    business_type: 'image_generation',
    business_id: 3203,
  });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM provider_stability_events WHERE event_type = 'route_switched'").get().count,
    0,
  );
});

test('用户提示词和负面词原样提交且不注入参考图布局说明', async (t) => {
  let body;
  const provider = await listen((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ url: 'https://cdn.example/prompt.png' }] }));
    });
  });
  t.after(() => close(provider));

  const db = createDb();
  t.after(() => db.close());
  addRoute(db, {
    provider: 'private-primary', baseUrl: `http://127.0.0.1:${provider.address().port}`,
    upstreamModel: 'upstream-primary', priority: 100,
    settings: JSON.stringify({ canvas_capabilities: { maxReferences: 2 } }),
  });

  await imageClient.callImageApi(db, log, {
    prompt: 'exact user prompt',
    user_negative_prompt: 'exact user negative',
    system_prompt: 'Image 1: character reference',
    reference_image_urls: ['https://cdn.example/reference-1.png', 'https://cdn.example/reference-2.png'],
    model: 'logical-image',
    image_gen_id: 3301,
  });

  assert.equal(body.prompt, 'exact user prompt');
  assert.equal(body.negative_prompt, 'exact user negative');
});

test('主供应商明确未受理后备用成功只结算一次积分', async (t) => {
  const primary = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NO_AVAILABLE_CHANNEL', message: 'No available channel' } }));
    });
  });
  const backup = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: [{
          b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        }],
      }));
    });
  });
  t.after(async () => Promise.all([close(primary), close(backup)]));

  const db = createDb();
  t.after(() => db.close());
  creditLedgerService.setAccountBalance(db, 'user-1', 100);
  addRoute(db, {
    provider: 'private-primary', baseUrl: `http://127.0.0.1:${primary.address().port}`,
    upstreamModel: 'upstream-primary', priority: 100,
  });
  const backupId = addRoute(db, {
    provider: 'private-backup', baseUrl: `http://127.0.0.1:${backup.address().port}`,
    upstreamModel: 'upstream-backup', priority: 90, failover: true,
  });
  const scheduled = [];
  const image = imageService.create(db, log, {
    drama_id: 1,
    prompt: 'user prompt',
    model: 'logical-image',
  }, {
    billingEnabled: true,
    userId: 'user-1',
    schedule(callback) { scheduled.push(callback); },
  });

  assert.equal(scheduled.length, 1);
  assert.deepEqual(creditLedgerService.getAccount(db, 'user-1'), {
    user_id: 'user-1', available: 60, held: 40, spent: 0,
  });
  db.prepare(`UPDATE image_generations SET error_msg = 'stale unknown result' WHERE id = ?`)
    .run(image.id);
  db.prepare(`UPDATE async_tasks SET message = 'stale unknown result', error = 'stale error'
    WHERE id = ?`).run(image.task_id);
  await scheduled[0]();

  assert.deepEqual(
    db.prepare('SELECT status, config_id, error_msg FROM image_generations WHERE id = ?').get(image.id),
    { status: 'completed', config_id: backupId, error_msg: null },
  );
  assert.deepEqual(creditLedgerService.getAccount(db, 'user-1'), {
    user_id: 'user-1', available: 60, held: 0, spent: 40,
  });
  assert.deepEqual(
    db.prepare('SELECT status, message, error FROM async_tasks WHERE id = ?').get(image.task_id),
    { status: 'completed', message: '', error: null },
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage_reservations').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM generation_route_attempts').get().count, 2);
});

test('同目标已有 needs_attention 时在预扣和调度前 409 阻断且保留 held', () => {
  const db = createDb();
  const scheduled = [];
  creditLedgerService.setAccountBalance(db, 'user-1', 100);
  const held = creditLedgerService.reserve(db, {
    actorUserId: 'user-1',
    userId: 'user-1',
    operationKey: 'image:legacy-unknown',
    amount: 40,
    model: 'logical-image',
    resourceType: 'image',
    resourceId: '9001',
  });
  db.prepare(`INSERT INTO image_generations
    (id, storyboard_id, drama_id, prompt, model, frame_type, status, task_id, tenant_id, user_id, credit_reservation_id, created_at, updated_at)
    VALUES (9001, 19, 1, 'legacy unknown', 'logical-image', 'storyboard_first', 'needs_attention', 'task-unknown', NULL, 'user-1', ?, ?, ?)`)
    .run(held.id, '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');

  assert.throws(() => imageService.create(db, log, {
    storyboard_id: 19,
    drama_id: 1,
    prompt: 'retry should be blocked',
    model: 'logical-image',
    frame_type: 'storyboard_first',
  }, {
    billingEnabled: true,
    userId: 'user-1',
    schedule(callback) { scheduled.push(callback); },
  }), (error) => {
    assert.equal(error.code, 'RESULT_UNKNOWN_NEEDS_REVIEW');
    assert.equal(error.status, 'needs_attention');
    assert.equal(error.activeId, 9001);
    return true;
  });

  assert.equal(scheduled.length, 0);
  assert.deepEqual(creditLedgerService.getAccount(db, 'user-1'), {
    user_id: 'user-1', available: 60, held: 40, spent: 0,
  });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM image_generations WHERE storyboard_id = 19").get().count,
    1,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM async_tasks').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage_reservations').get().count, 1);
  assert.deepEqual(
    db.prepare("SELECT event_type, outcome, code FROM audit_events WHERE event_type = 'generation.image.blocked_unknown'").get(),
    { event_type: 'generation.image.blocked_unknown', outcome: 'needs_attention', code: 'RESULT_UNKNOWN_NEEDS_REVIEW' },
  );
});

test('图片创建路由将 needs_attention 阻断映射为 409 结构化 JSON', () => {
  const db = createDb();
  db.prepare(`INSERT INTO image_generations
    (id, storyboard_id, drama_id, prompt, model, frame_type, status, task_id, user_id, created_at, updated_at)
    VALUES (9101, 19, 1, 'legacy unknown', 'logical-image', 'storyboard_first', 'needs_attention', 'task-unknown', 'user-1', ?, ?)`)
    .run('2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');

  let statusCode;
  let payload;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      payload = body;
      return this;
    },
  };
  imageRoutes(db, {}, log, { billingEnabled: true }).create({
    body: {
      storyboard_id: 19,
      drama_id: 1,
      prompt: 'retry should be blocked',
      model: 'logical-image',
      frame_type: 'storyboard_first',
    },
    user: { id: 'user-1' },
  }, res);

  assert.equal(statusCode, 409);
  assert.equal(payload.success, false);
  assert.equal(payload.error.code, 'RESULT_UNKNOWN_NEEDS_REVIEW');
  assert.deepEqual(payload.error.details, {
    status: 'needs_attention',
    storyboard_id: 19,
    frame_type: 'storyboard_first',
    active_id: 9101,
    active_task_id: 'task-unknown',
  });
});
