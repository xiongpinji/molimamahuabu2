const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Database = require('better-sqlite3');

const aiClient = require('../src/services/aiClient');
const aiConfigService = require('../src/services/aiConfigService');
const creditLedgerService = require('../src/services/creditLedgerService');
const modelPriceService = require('../src/services/modelPriceService');
const textBilling = require('../src/services/text-generation-billing-service');
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
  modelPriceService.set(db, 'logical-text', 5, { category: 'text' });
  return db;
}

function addRoute(db, values) {
  const config = aiConfigService.createConfig(db, log, {
    service_type: 'text',
    provider: values.provider,
    api_protocol: 'openai',
    name: values.provider,
    base_url: values.baseUrl,
    api_key: 'local-test-key',
    model: [values.upstreamModel],
    default_model: values.upstreamModel,
    endpoint: '/chat/completions',
    priority: values.priority,
    logical_model_id: 'logical-text',
    failover_enabled: Boolean(values.failover),
  });
  db.prepare("UPDATE ai_service_configs SET verification_status = 'verified' WHERE id = ?")
    .run(config.id);
  return config.id;
}

function jsonResponse(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function visionSource() {
  return { imageUrl: 'data:image/png;base64,iVBORw0KGgo=' };
}

test('非流式文本明确无通道时切换到已验证的同逻辑模型', async (t) => {
  const requests = [];
  const primary = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push('primary');
      jsonResponse(res, 503, {
        error: { code: 'NO_AVAILABLE_CHANNEL', message: 'No available channel' },
      });
    });
  });
  const backup = await listen((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')).model);
      jsonResponse(res, 200, { choices: [{ message: { content: '备用供应商结果' } }] });
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

  const result = await aiClient.generateTextWithVision(
    db, log, 'text', '描述图片', '', visionSource(),
    { model: 'logical-text', idempotency_key: 'text-vision-no-channel-1' },
  );

  assert.equal(result, '备用供应商结果');
  assert.deepEqual(requests, ['primary', 'upstream-backup']);
  assert.deepEqual(db.prepare(`SELECT config_id, state, error_category
    FROM generation_route_attempts ORDER BY attempt_no`).all(), [
    { config_id: primaryId, state: 'failed', error_category: 'provider_unavailable' },
    { config_id: backupId, state: 'succeeded', error_category: null },
  ]);
  assert.deepEqual(db.prepare('SELECT state, final_config_id FROM generation_route_requests').get(), {
    state: 'succeeded', final_config_id: backupId,
  });
});

test('流式首 token 后断线标记结果未知且绝不提交备用供应商', async (t) => {
  const requests = [];
  const primary = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push('primary');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '已输出' } }] })}\n\n`);
      setImmediate(() => res.destroy(new Error('upstream disconnected')));
    });
  });
  const backup = await listen((req, res) => {
    requests.push('backup');
    req.resume();
    jsonResponse(res, 200, { choices: [{ message: { content: '不应执行' } }] });
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
  const deltas = [];

  await assert.rejects(
    () => aiClient.streamGenerateText(
      db, log, 'text', '生成文本', '',
      { model: 'logical-text', idempotency_key: 'text-stream-token-1' },
      (delta) => deltas.push(delta),
    ),
    (error) => error.code === 'TEXT_RESULT_UNKNOWN'
      && /结果未知/.test(error.message)
      && !/private|127\.0\.0\.1|config/i.test(error.message),
  );

  assert.deepEqual(deltas, ['已输出']);
  assert.deepEqual(requests, ['primary']);
  assert.deepEqual(db.prepare('SELECT state FROM generation_route_requests').get(), {
    state: 'needs_attention',
  });
  assert.equal(db.prepare('SELECT error_category FROM generation_route_attempts').get().error_category,
    'result_unknown');
});

test('安全路由收到空流后不再流式重试或改成非流式重提', async (t) => {
  const requests = [];
  const primary = await listen((req, res) => {
    requests.push('primary');
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: [DONE]\n\n');
  });
  const backup = await listen((req, res) => {
    requests.push('backup');
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '不应执行' } }] })}\n\n`);
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

  await assert.rejects(
    () => aiClient.generateText(db, log, 'text', '生成文本', '', {
      model: 'logical-text', idempotency_key: 'text-empty-stream-1',
    }),
    (error) => error.code === 'TEXT_RESULT_UNKNOWN',
  );
  assert.deepEqual(requests, ['primary']);
});

test('内容安全拒绝不切换且普通用户错误不含中转信息', async (t) => {
  const requests = [];
  const primary = await listen((req, res) => {
    requests.push('primary');
    req.resume();
    jsonResponse(res, 400, { error: { code: 'CONTENT_POLICY', message: 'private provider detail' } });
  });
  const backup = await listen((req, res) => {
    requests.push('backup');
    req.resume();
    jsonResponse(res, 200, { choices: [{ message: { content: '不应执行' } }] });
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

  await assert.rejects(
    () => aiClient.generateTextWithVision(
      db, log, 'text', '描述图片', '', visionSource(),
      { model: 'logical-text', idempotency_key: 'text-policy-1' },
    ),
    (error) => error.code === 'TEXT_POLICY_REJECTED'
      && !/private|127\.0\.0\.1|config/i.test(error.message),
  );
  assert.deepEqual(requests, ['primary']);
});

test('结构化 401 且没有任务号时允许切换已验证供应商', async (t) => {
  const requests = [];
  const primary = await listen((req, res) => {
    requests.push('primary');
    req.resume();
    jsonResponse(res, 401, { error: { code: 'INVALID_API_KEY', message: 'expired' } });
  });
  const backup = await listen((req, res) => {
    requests.push('backup');
    req.resume();
    jsonResponse(res, 200, { choices: [{ message: { content: '鉴权切换成功' } }] });
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

  const result = await aiClient.generateTextWithVision(
    db, log, 'text', '描述图片', '', visionSource(),
    { model: 'logical-text', idempotency_key: 'text-auth-1' },
  );
  assert.equal(result, '鉴权切换成功');
  assert.deepEqual(requests, ['primary', 'backup']);
});

test('相同文本幂等键重放只创建一次预扣积分', (t) => {
  const db = createDb();
  t.after(() => db.close());
  creditLedgerService.setTenantAccountBalance(db, 'tenant-a', 20);
  addRoute(db, {
    provider: 'private-primary', baseUrl: 'https://example.invalid/v1',
    upstreamModel: 'upstream-primary', priority: 100,
  });
  const input = {
    enabled: true,
    tenantId: 'tenant-a',
    userId: 'user-1',
    requestedModel: 'logical-text',
    resourceType: 'canvas_text',
    resourceId: 'node-1',
    operation: 'canvas_text',
    idempotencyKey: 'canvas-text-node-1-submit-1',
  };

  const first = textBilling.begin(db, input);
  const replay = textBilling.begin(db, input);

  assert.equal(replay.reservationId, first.reservationId);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 1);
  assert.deepEqual(creditLedgerService.getTenantAccount(db, 'tenant-a'), {
    tenant_id: 'tenant-a', available: 15, held: 5, spent: 0,
  });
});
