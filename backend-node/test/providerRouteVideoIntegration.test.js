const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const aiConfigService = require('../src/services/aiConfigService');
const creditLedgerService = require('../src/services/creditLedgerService');
const modelPriceService = require('../src/services/modelPriceService');
const taskService = require('../src/services/taskService');
const videoClient = require('../src/services/videoClient');
const videoService = require('../src/services/videoService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { MINIMAL_MP4, isoBmffTopLevelBoxes } = require('./fixtures/media');

const log = { info() {}, warn() {}, error() {} };

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
  modelPriceService.set(db, 'logical-video', 3, {
    category: 'video',
    cost_unit: 'second',
    cost_micros_per_unit: 120000,
  });
  return db;
}

function addRoute(db, values) {
  const config = aiConfigService.createConfig(db, log, {
    service_type: 'video',
    provider: values.provider,
    api_protocol: 'openai',
    name: values.provider,
    base_url: values.baseUrl,
    api_key: 'local-test-key',
    model: [values.upstreamModel],
    default_model: values.upstreamModel,
    endpoint: '/video/generations',
    query_endpoint: '/video/task/{taskId}',
    priority: values.priority,
    logical_model_id: 'logical-video',
    failover_enabled: Boolean(values.failover),
  });
  db.prepare("UPDATE ai_service_configs SET verification_status = 'verified' WHERE id = ?")
    .run(config.id);
  return config.id;
}

function addGeneration(db, id) {
  const now = '2026-08-15T00:00:00.000Z';
  db.prepare(`INSERT INTO video_generations
    (id, prompt, model, duration, status, created_at, updated_at)
    VALUES (?, 'user prompt', 'logical-video', 5, 'processing', ?, ?)`)
    .run(id, now, now);
}

function waitFor(predicate, timeoutMs = 3000, intervalMs = 20) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() - started >= timeoutMs) return reject(new Error('等待视频状态更新超时'));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

test('明确未受理才切换到已验证同逻辑视频供应商并固定任务配置', async (t) => {
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
      res.end(JSON.stringify({ id: 'backup-task-1', status: 'processing' }));
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
  addGeneration(db, 4001);

  const result = await videoClient.callVideoApi(db, log, {
    prompt: 'user prompt', model: 'logical-video', duration: 5, video_gen_id: 4001,
  });

  assert.equal(result.task_id, 'backup-task-1');
  assert.equal(result.config_id, backupId);
  assert.deepEqual(requests, ['primary', 'upstream-backup']);
  assert.deepEqual(
    db.prepare('SELECT config_id, provider_task_id FROM video_generations WHERE id = 4001').get(),
    { config_id: backupId, provider_task_id: 'backup-task-1' },
  );
  assert.deepEqual(
    db.prepare('SELECT state, final_config_id FROM generation_route_requests').get(),
    { state: 'accepted', final_config_id: null },
  );
  assert.deepEqual(
    db.prepare('SELECT config_id, state, error_category FROM generation_route_attempts ORDER BY attempt_no').all(),
    [
      { config_id: primaryId, state: 'failed', error_category: 'provider_unavailable' },
      { config_id: backupId, state: 'accepted', error_category: null },
    ],
  );
  assert.deepEqual(
    db.prepare(`SELECT event_type, config_id, target_config_id
      FROM provider_stability_events WHERE event_type = 'route_switched'`).get(),
    { event_type: 'route_switched', config_id: primaryId, target_config_id: backupId },
  );
});

test('视频备用供应商半开探测被占用时不会重复调用或误记切换', async (t) => {
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
    res.end(JSON.stringify({ id: 'should-not-run', status: 'processing' }));
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

  const result = await videoClient.callVideoApi(db, log, {
    prompt: 'user prompt', model: 'logical-video', duration: 5, video_gen_id: 4002,
  });
  assert.deepEqual(result, { error: '视频生成服务暂时不可用，请稍后再试。' });
  assert.deepEqual(requests, ['primary']);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM provider_stability_events WHERE event_type = 'route_switched'")
      .get().count,
    0,
  );
  assert.equal(db.prepare('SELECT state FROM generation_route_requests').get().state, 'failed');
});

test('响应携带供应商任务号时固定原供应商且绝不重复提交', async (t) => {
  const requests = [];
  const primary = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push('primary');
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ task_id: 'possibly-accepted', error: { message: 'late gateway response' } }));
    });
  });
  const backup = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push('backup');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'must-not-submit' }));
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
  addGeneration(db, 4002);

  const result = await videoClient.callVideoApi(db, log, {
    prompt: 'user prompt', model: 'logical-video', duration: 5, video_gen_id: 4002,
  });

  assert.equal(result.task_id, 'possibly-accepted');
  assert.equal(result.config_id, primaryId);
  assert.deepEqual(requests, ['primary']);
  assert.deepEqual(
    db.prepare('SELECT config_id, provider_task_id FROM video_generations WHERE id = 4002').get(),
    { config_id: primaryId, provider_task_id: 'possibly-accepted' },
  );
  assert.equal(db.prepare('SELECT state FROM generation_route_requests').get().state, 'accepted');
});

test('无明确未受理证据的 503 不切换视频供应商', async (t) => {
  const requests = [];
  const primary = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push('primary');
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'temporary gateway failure' } }));
    });
  });
  const backup = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push('backup');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'must-not-submit' }));
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

  const result = await videoClient.callVideoApi(db, log, {
    prompt: 'user prompt', model: 'logical-video', duration: 5, video_gen_id: 4003,
  });

  assert.equal(result.indeterminate, true);
  assert.match(result.error, /结果未知/);
  assert.deepEqual(requests, ['primary']);
  assert.equal(db.prepare('SELECT error_category FROM generation_route_attempts').get().error_category,
    'submission_unknown');
});

test('备用供应商成功并得到可读视频后只结算一次且绑定实际配置', async (t) => {
  const artifact = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': MINIMAL_MP4.length });
    res.end(MINIMAL_MP4);
  });
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
      res.end(JSON.stringify({ video_url: `http://127.0.0.1:${artifact.address().port}/video.mp4` }));
    });
  });
  t.after(async () => Promise.all([close(artifact), close(primary), close(backup)]));

  const previousCwd = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-video-route-'));
  const storageRoot = path.join(tempRoot, 'storage').replace(/\\/g, '/');
  fs.mkdirSync(path.join(tempRoot, 'configs'), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, 'configs', 'config.yaml'), [
    'app:', '  name: provider route video test', '  version: test',
    'server:', '  host: 127.0.0.1', '  port: 0',
    'storage:', '  type: local', `  local_path: ${storageRoot}`,
    '  base_url: http://127.0.0.1:0/static',
  ].join('\n'));
  const configModulePath = require.resolve('../src/config');
  process.chdir(tempRoot);
  delete require.cache[configModulePath];
  t.after(() => {
    delete require.cache[configModulePath];
    process.chdir(previousCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

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
  const video = videoService.create(db, log, {
    drama_id: 1,
    model: 'logical-video',
    prompt: 'user prompt',
    duration: 5,
  }, {
    billingEnabled: true,
    userId: 'user-1',
    schedule(callback) { scheduled.push(callback); },
  });

  assert.equal(scheduled.length, 1);
  assert.deepEqual(creditLedgerService.getAccount(db, 'user-1'), {
    user_id: 'user-1', available: 85, held: 15, spent: 0,
  });
  await scheduled[0]();

  const completed = db.prepare(`SELECT status, config_id, local_path, error_msg, credit_reservation_id
    FROM video_generations WHERE id = ?`).get(video.id);
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  assert.equal(completed.config_id, backupId);
  assert.ok(completed.local_path);
  assert.equal(completed.error_msg, null);
  const storedVideo = fs.readFileSync(path.join(storageRoot, completed.local_path));
  assert.ok(storedVideo.length > 16);
  assert.deepEqual(isoBmffTopLevelBoxes(storedVideo).slice(0, 2).map((box) => box.type), ['ftyp', 'moov']);
  assert.deepEqual(creditLedgerService.getAccount(db, 'user-1'), {
    user_id: 'user-1', available: 85, held: 0, spent: 15,
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage_reservations').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM generation_cost_records').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM generation_route_attempts').get().count, 2);
  assert.deepEqual(db.prepare('SELECT state, final_config_id FROM generation_route_requests').get(), {
    state: 'succeeded', final_config_id: backupId,
  });
});

test('供应商链接不可读取时不标记完成也不结算积分', async (t) => {
  const artifact = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>not a video</html>');
  });
  const provider = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ video_url: `http://127.0.0.1:${artifact.address().port}/broken.mp4` }));
    });
  });
  t.after(async () => Promise.all([close(artifact), close(provider)]));

  const previousCwd = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-video-artifact-'));
  const storageRoot = path.join(tempRoot, 'storage').replace(/\\/g, '/');
  fs.mkdirSync(path.join(tempRoot, 'configs'), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, 'configs', 'config.yaml'), [
    'app:', '  name: provider artifact video test', '  version: test',
    'server:', '  host: 127.0.0.1', '  port: 0',
    'storage:', '  type: local', `  local_path: ${storageRoot}`,
    '  base_url: http://127.0.0.1:0/static',
  ].join('\n'));
  const configModulePath = require.resolve('../src/config');
  process.chdir(tempRoot);
  delete require.cache[configModulePath];
  t.after(() => {
    delete require.cache[configModulePath];
    process.chdir(previousCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const db = createDb();
  t.after(() => db.close());
  creditLedgerService.setAccountBalance(db, 'user-1', 100);
  addRoute(db, {
    provider: 'private-primary', baseUrl: `http://127.0.0.1:${provider.address().port}`,
    upstreamModel: 'upstream-primary', priority: 100,
  });
  const scheduled = [];
  const video = videoService.create(db, log, {
    drama_id: 1, model: 'logical-video', prompt: 'user prompt', duration: 5,
  }, {
    billingEnabled: true, userId: 'user-1', schedule(callback) { scheduled.push(callback); },
  });
  await scheduled[0]();

  const row = db.prepare('SELECT status, local_path, credit_reservation_id FROM video_generations WHERE id = ?')
    .get(video.id);
  assert.equal(row.status, 'needs_attention', JSON.stringify(row));
  assert.equal(row.local_path, null);
  assert.equal(creditLedgerService.getReservation(db, row.credit_reservation_id).status, 'held');
  assert.equal(db.prepare('SELECT state FROM generation_route_requests').get().state, 'needs_attention');
  assert.equal(db.prepare('SELECT error_category FROM generation_route_attempts').get().error_category,
    'artifact_unreadable');
});

test('服务重启后使用已固定的配置和任务号恢复轮询', async (t) => {
  const db = createDb();
  t.after(() => db.close());
  const primaryId = addRoute(db, {
    provider: 'private-primary', baseUrl: 'https://primary.invalid',
    upstreamModel: 'upstream-primary', priority: 100,
  });
  const backupId = addRoute(db, {
    provider: 'private-backup', baseUrl: 'https://backup.invalid',
    upstreamModel: 'upstream-backup', priority: 90, failover: true,
  });
  assert.notEqual(primaryId, backupId);
  const now = new Date().toISOString();
  const task = taskService.createTask(db, log, 'video_generation', 'route-recovery');
  const videoId = Number(db.prepare(`INSERT INTO video_generations
    (prompt, model, status, task_id, provider_task_id, config_id, created_at, updated_at)
    VALUES ('resume', 'logical-video', 'processing', ?, 'fixed-task', ?, ?, ?)`)
    .run(task.id, backupId, now, now).lastInsertRowid);
  const originalPoll = videoClient.pollVideoTask;
  const originalCall = videoClient.callVideoApi;
  let polledConfigId = null;
  let submissions = 0;
  t.after(() => {
    videoClient.pollVideoTask = originalPoll;
    videoClient.callVideoApi = originalCall;
  });
  videoClient.callVideoApi = async () => {
    submissions += 1;
    return { error: 'must not submit' };
  };
  videoClient.pollVideoTask = async (_db, _log, receivedId, taskId, config) => {
    assert.equal(receivedId, videoId);
    assert.equal(taskId, 'fixed-task');
    polledConfigId = config.id;
    return { indeterminate: true, provider_task_id: taskId, error: 'still processing' };
  };

  videoService.resumeProcessingVideoGenerations(db, log);
  await waitFor(() => polledConfigId != null);

  assert.equal(submissions, 0);
  assert.equal(polledConfigId, backupId);
  assert.equal(db.prepare('SELECT status FROM video_generations WHERE id = ?').get(videoId).status,
    'needs_attention');
});
