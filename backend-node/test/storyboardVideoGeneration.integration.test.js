const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const {
  MINIMAL_MP4,
  MINIMAL_MP4_EXTENDED_FTYP_HEADER_ONLY,
  MINIMAL_MP4_MDAT_ONLY,
  MINIMAL_MP4_MOOV_ONLY,
  isoBmffTopLevelBoxes,
} = require('./fixtures/media');

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

async function readJson(response) {
  const body = await response.json();
  return { status: response.status, body };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const httpServer = server.listen(0, '127.0.0.1', () => resolve(httpServer));
    httpServer.once('error', reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function findFileByName(root, name) {
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findFileByName(absolute, name);
      if (nested) return nested;
    } else if (entry.name === name) {
      return absolute;
    }
  }
  return null;
}

function assertIsoBmffVideoBytes(buffer) {
  const boxes = isoBmffTopLevelBoxes(buffer);
  assert.equal(boxes[0]?.type, 'ftyp');
  assert.ok(boxes.some((box) => box.type === 'moov' && box.size > 16));
  assert.ok(boxes.some((box) => box.type === 'mdat' && box.size > 8));
}

function waitFor(predicate, timeoutMs = 5000, intervalMs = 20) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = async () => {
      let value;
      try {
        value = await predicate();
      } catch (error) {
        reject(error);
        return;
      }
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error('等待视频任务完成超时'));
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

test('分镜视频通过本地 DeepWL 兼容供应商完成提交、下载与结果回写', async () => {
  const previousCwd = process.cwd();
  const previousPublicMode = process.env.PUBLIC_PLATFORM_MODE;
  const previousWebDist = process.env.WEB_DIST_PATH;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-video-'));
  const configRoot = path.join(tempRoot, 'configs');
  const databasePath = path.join(tempRoot, 'drama.sqlite').replace(/\\/g, '/');
  const storagePath = path.join(tempRoot, 'storage').replace(/\\/g, '/');
  fs.mkdirSync(configRoot, { recursive: true });

  let providerServer;
  let backendServer;
  try {
    let providerRequest;
    let uploadCount = 0;
    providerServer = await listen(http.createServer((req, res) => {
      if (
        req.method === 'GET'
        && (req.url === '/first.png' || req.url === '/last.png' || /^\/uploaded-\d+\.png$/.test(req.url))
      ) {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(ONE_PIXEL_PNG);
        return;
      }
      if (req.method === 'GET' && req.url === '/output.mp4') {
        res.writeHead(200, { 'content-type': 'video/mp4' });
        res.end(MINIMAL_MP4);
        return;
      }
      if (req.method === 'POST' && req.url === '/api/upload') {
        uploadCount += 1;
        const providerBaseUrl = `http://127.0.0.1:${providerServer.address().port}`;
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ url: `${providerBaseUrl}/uploaded-${uploadCount}.png` }));
        });
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/video/create') {
        res.writeHead(404);
        res.end();
        return;
      }
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        providerRequest = {
          authorization: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        };
        const providerBaseUrl = `http://127.0.0.1:${providerServer.address().port}`;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ output: { video_url: `${providerBaseUrl}/output.mp4` } }));
      });
    }));

    const providerBaseUrl = `http://127.0.0.1:${providerServer.address().port}`;
    fs.writeFileSync(
      path.join(configRoot, 'config.yaml'),
      [
        'app:',
        '  name: LocalMiniDrama video integration',
        '  version: test',
        'server:',
        '  host: 127.0.0.1',
        '  port: 0',
        '  cors_origins:',
        '    - http://127.0.0.1:3014',
        'database:',
        '  type: sqlite',
        `  path: ${databasePath}`,
        'storage:',
        '  type: local',
        `  local_path: ${storagePath}`,
        '  base_url: http://127.0.0.1:0/static',
        'vendor_lock:',
        '  enabled: false',
        'image_proxy:',
        `  upload_url: ${providerBaseUrl}/api/upload`,
        '  upload_timeout_seconds: 5',
        '  upload_max_attempts: 1',
      ].join('\n'),
      'utf8'
    );

    process.chdir(tempRoot);
    process.env.PUBLIC_PLATFORM_MODE = '0';
    process.env.WEB_DIST_PATH = path.join(tempRoot, 'missing-web-dist');

    const { createApp } = require('../src/app');
    const created = createApp();
    const db = created.db;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO ai_service_configs
        (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
         endpoint, is_active, is_default, priority, created_at, updated_at)
       VALUES ('video', 'deepwl', 'deepwl_grok_unified', ?, ?, ?, ?, ?, ?, 1, 1, 0, ?, ?)`
    ).run(
      '本地视频回归供应商',
      providerBaseUrl,
      'integration-secret',
      JSON.stringify(['grok-video-3']),
      'grok-video-3',
      '/v1/video/create',
      now,
      now
    );

    const dramaId = Number(
      db.prepare(
        `INSERT INTO dramas (title, style, status, metadata, created_at, updated_at)
         VALUES (?, ?, 'draft', ?, ?, ?)`
      ).run('视频闭环回归', 'realistic', JSON.stringify({ aspect_ratio: '16:9' }), now, now).lastInsertRowid
    );
    const episodeId = Number(
      db.prepare(
        `INSERT INTO episodes (drama_id, episode_number, title, script_content, created_at, updated_at)
         VALUES (?, 1, ?, ?, ?, ?)`
      ).run(dramaId, '第1集', '本地供应商生成测试', now, now).lastInsertRowid
    );
    const characterId = Number(
      db.prepare(
        `INSERT INTO characters (drama_id, name, voice_style, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(dramaId, '小狐狸', 'bright youthful voice, clear diction', now, now).lastInsertRowid
    );
    const storyboardId = Number(
      db.prepare(
        `INSERT INTO storyboards
          (episode_id, storyboard_number, title, dialogue, video_prompt, video_model,
           characters, duration, status, created_at, updated_at)
         VALUES (?, 1, ?, ?, ?, ?, ?, 5, 'pending', ?, ?)`
      ).run(
        episodeId,
        '连续镜头',
        '小狐狸：我们继续往前走。',
        '雨后森林，镜头跟随小狐狸向前走。',
        'grok-video-3',
        JSON.stringify([characterId]),
        now,
        now
      ).lastInsertRowid
    );

    backendServer = await listen(created.app);
    const backendBaseUrl = `http://127.0.0.1:${backendServer.address().port}/api/v1`;
    const firstFrameUrl = `${providerBaseUrl}/first.png`;
    const lastFrameUrl = `${providerBaseUrl}/last.png`;
    const generated = await readJson(
      await fetch(`${backendBaseUrl}/videos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          storyboard_id: storyboardId,
          drama_id: dramaId,
          first_frame_url: firstFrameUrl,
          last_frame_url: lastFrameUrl,
          resolution: '720P',
        }),
      })
    );
    assert.equal(generated.status, 201);
    assert.equal(generated.body.data.status, 'processing');
    assert.ok(generated.body.data.task_id);

    const task = await waitFor(async () => {
      const result = await readJson(await fetch(`${backendBaseUrl}/tasks/${generated.body.data.task_id}`));
      return result.body.data?.status === 'completed' ? result.body.data : false;
    });
    assert.equal(task.status, 'completed');
    const taskResult = JSON.parse(task.result);
    assert.equal(taskResult.video_generation_id, generated.body.data.id);
    assert.ok(taskResult.local_path);

    const video = await readJson(await fetch(`${backendBaseUrl}/videos/${generated.body.data.id}`));
    assert.equal(video.status, 200);
    assert.equal(video.body.data.status, 'completed');
    assert.equal(video.body.data.model, 'grok-video-3');
    assert.equal(video.body.data.storyboard_id, storyboardId);
    assert.equal(video.body.data.first_frame_url, firstFrameUrl);
    assert.equal(video.body.data.last_frame_url, lastFrameUrl);
    assert.equal(video.body.data.video_url, `${providerBaseUrl}/output.mp4`);
    assert.ok(video.body.data.local_path);
    assert.equal(taskResult.local_path, video.body.data.local_path);
    const localVideoRelPath = video.body.data.local_path.replace(/^\/?static\//, '').replace(/^\/+/, '');
    let localVideoPath = path.join(storagePath, localVideoRelPath);
    if (!fs.existsSync(localVideoPath)) {
      localVideoPath = findFileByName(tempRoot, path.basename(localVideoRelPath));
    }
    assert.ok(localVideoPath && fs.existsSync(localVideoPath));
    const localVideoBytes = fs.readFileSync(localVideoPath);
    assert.ok(localVideoBytes.length > 16);
    assertIsoBmffVideoBytes(localVideoBytes);

    const storyboard = await readJson(await fetch(`${backendBaseUrl}/storyboards/${storyboardId}`));
    assert.equal(storyboard.status, 200);
    assert.equal(storyboard.body.data.video_url, `${providerBaseUrl}/output.mp4`);
    assert.equal(storyboard.body.data.local_path, video.body.data.local_path);

    assert.equal(providerRequest.authorization, 'Bearer integration-secret');
    assert.equal(providerRequest.body.model, 'grok-video-3');
    assert.equal(uploadCount, 2);
    assert.deepEqual(providerRequest.body.images, [
      `${providerBaseUrl}/uploaded-1.png`,
      `${providerBaseUrl}/uploaded-2.png`,
    ]);
    assert.equal(providerRequest.body.aspect_ratio, '16:9');
    assert.equal(providerRequest.body.duration, 6);
    assert.match(providerRequest.body.prompt, /VOICE CONTINUITY/);
    assert.match(providerRequest.body.prompt, /bright youthful voice, clear diction/);
  } finally {
    if (backendServer) await close(backendServer);
    if (providerServer) await close(providerServer);
    try { require('../src/db').closeDb(); } catch (_) {}
    process.chdir(previousCwd);
    if (previousPublicMode === undefined) delete process.env.PUBLIC_PLATFORM_MODE;
    else process.env.PUBLIC_PLATFORM_MODE = previousPublicMode;
    if (previousWebDist === undefined) delete process.env.WEB_DIST_PATH;
    else process.env.WEB_DIST_PATH = previousWebDist;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('异步供应商同一创建链持久化任务编号后轮询完成并只提交一次', async () => {
  const previousCwd = process.cwd();
  const originalSetTimeout = global.setTimeout;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-async-video-'));
  const configRoot = path.join(tempRoot, 'configs');
  const storagePath = path.join(tempRoot, 'storage').replace(/\\/g, '/');
  const configModulePath = require.resolve('../src/config');
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, 'config.yaml'),
    [
      'app:',
      '  name: LocalMiniDrama async video integration',
      '  version: test',
      'server:',
      '  host: 127.0.0.1',
      '  port: 0',
      'storage:',
      '  type: local',
      `  local_path: ${storagePath}`,
      '  base_url: http://127.0.0.1:0/static',
    ].join('\n'),
    'utf8'
  );

  const db = new Database(':memory:');
  const { runMigrationsAndEnsure } = require('../src/db/migrate');
  const credits = require('../src/services/creditLedgerService');
  const prices = require('../src/services/modelPriceService');
  const taskService = require('../src/services/taskService');
  const videoService = require('../src/services/videoService');
  const log = { info() {}, warn() {}, error() {} };
  let providerServer;
  let releaseCompletedPoll;
  let scheduledPromise;
  let submitCount = 0;
  let pollCount = 0;
  try {
    process.chdir(tempRoot);
    delete require.cache[configModulePath];
    runMigrationsAndEnsure(db);
    credits.setTenantAccountBalance(db, 'tenant-a', 40);
    prices.set(db, 'seedance-2.0-720p', 13);

    const completedPollGate = new Promise((resolve) => {
      releaseCompletedPoll = resolve;
    });
    providerServer = await listen(http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/videos') {
        submitCount += 1;
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ task_id: 'async-video-1', status: 'queued' }));
        });
        return;
      }
      if (req.method === 'GET' && req.url === '/videos/async-video-1') {
        pollCount += 1;
        if (pollCount === 1) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'async-video-1', status: 'processing' }));
          return;
        }
        await completedPollGate;
        const providerBaseUrl = `http://127.0.0.1:${providerServer.address().port}`;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'async-video-1',
          status: 'completed',
          video_url: `${providerBaseUrl}/output.mp4`,
        }));
        return;
      }
      if (req.method === 'GET' && req.url === '/output.mp4') {
        res.writeHead(200, { 'content-type': 'video/mp4' });
        res.end(MINIMAL_MP4);
        return;
      }
      res.writeHead(404);
      res.end();
    }));

    const providerBaseUrl = `http://127.0.0.1:${providerServer.address().port}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO ai_service_configs
        (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
         endpoint, query_endpoint, is_active, is_default, priority, created_at, updated_at)
       VALUES ('video', 'aihubcc', 'aihubcc', ?, ?, ?, ?, ?, ?, ?, 1, 1, 0, ?, ?)`
    ).run(
      '本地异步视频供应商',
      providerBaseUrl,
      'integration-secret',
      JSON.stringify(['seedance-2.0-720p']),
      'seedance-2.0-720p',
      '/videos',
      '/videos/{taskId}',
      now,
      now
    );
    const dramaId = Number(db.prepare(
      `INSERT INTO dramas (title, status, created_at, updated_at)
       VALUES (?, 'draft', ?, ?)`
    ).run('异步视频闭环', now, now).lastInsertRowid);
    const episodeId = Number(db.prepare(
      `INSERT INTO episodes (drama_id, episode_number, title, script_content, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?, ?)`
    ).run(dramaId, '第1集', '异步视频测试', now, now).lastInsertRowid);
    const storyboardId = Number(db.prepare(
      `INSERT INTO storyboards
        (episode_id, storyboard_number, title, video_prompt, video_model, duration, status, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?, 5, 'pending', ?, ?)`
    ).run(
      episodeId,
      '异步镜头',
      '单镜头连续跟随角色向前走。',
      'seedance-2.0-720p',
      now,
      now
    ).lastInsertRowid);

    global.setTimeout = (callback, delay, ...args) => (
      originalSetTimeout(callback, delay === 10000 ? 0 : delay, ...args)
    );
    const created = videoService.create(db, log, {
      drama_id: dramaId,
      storyboard_id: storyboardId,
      provider: 'aihubcc',
      model: 'seedance-2.0-720p',
      prompt: '单镜头连续跟随角色向前走。',
    }, {
      billingEnabled: true,
      tenantId: 'tenant-a',
      userId: 'user-1',
      schedule(callback) {
        scheduledPromise = callback();
      },
    });

    await waitFor(() => {
      const state = db.prepare(
        'SELECT status, error_msg FROM video_generations WHERE id = ?'
      ).get(created.id);
      if (state?.status === 'failed') {
        throw new Error(`异步视频在完成轮询前失败: ${state.error_msg || 'unknown error'}`);
      }
      return pollCount >= 2;
    });
    const processingVideo = db.prepare(
      'SELECT status, provider_task_id, task_id, credit_reservation_id FROM video_generations WHERE id = ?'
    ).get(created.id);
    assert.equal(processingVideo.provider_task_id, 'async-video-1');
    assert.equal(processingVideo.status, 'processing');
    assert.equal(taskService.getTask(db, processingVideo.task_id).status, 'processing');
    assert.equal(credits.getReservation(db, processingVideo.credit_reservation_id).status, 'held');

    releaseCompletedPoll();
    await scheduledPromise;

    const completedVideo = db.prepare(
      'SELECT status, video_url, local_path, provider_task_id FROM video_generations WHERE id = ?'
    ).get(created.id);
    assert.equal(completedVideo.status, 'completed');
    assert.equal(completedVideo.provider_task_id, 'async-video-1');
    assert.equal(completedVideo.video_url, `${providerBaseUrl}/output.mp4`);
    const localVideoPath = path.join(storagePath, completedVideo.local_path);
    assert.ok(fs.existsSync(localVideoPath));
    assertIsoBmffVideoBytes(fs.readFileSync(localVideoPath));

    const completedTask = taskService.getTask(db, processingVideo.task_id);
    assert.equal(completedTask.status, 'completed');
    assert.equal(JSON.parse(completedTask.result).video_generation_id, created.id);
    assert.deepEqual(
      db.prepare('SELECT video_url, local_path FROM storyboards WHERE id = ?').get(storyboardId),
      { video_url: `${providerBaseUrl}/output.mp4`, local_path: completedVideo.local_path }
    );
    assert.equal(credits.getReservation(db, processingVideo.credit_reservation_id).status, 'confirmed');
    assert.deepEqual(
      credits.getTenantAccount(db, 'tenant-a'),
      { tenant_id: 'tenant-a', available: 27, held: 0, spent: 13 }
    );
    assert.equal(submitCount, 1);
    assert.equal(pollCount, 2);
  } finally {
    if (releaseCompletedPoll) releaseCompletedPoll();
    if (scheduledPromise) await scheduledPromise.catch(() => {});
    if (providerServer) await close(providerServer);
    global.setTimeout = originalSetTimeout;
    db.close();
    delete require.cache[configModulePath];
    process.chdir(previousCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

async function runRejectedVendorVideoCase({ videoUrl, payload, expectedError }) {
  const previousCwd = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-bad-video-'));
  const configRoot = path.join(tempRoot, 'configs');
  const storagePath = path.join(tempRoot, 'storage').replace(/\\/g, '/');
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, 'config.yaml'),
    [
      'app:',
      '  name: LocalMiniDrama bad video test',
      '  version: test',
      'server:',
      '  host: 127.0.0.1',
      '  port: 0',
      'storage:',
      '  type: local',
      `  local_path: ${storagePath}`,
      '  base_url: http://127.0.0.1:0/static',
    ].join('\n'),
    'utf8'
  );

  const db = new Database(':memory:');
  const { runMigrationsAndEnsure } = require('../src/db/migrate');
  const credits = require('../src/services/creditLedgerService');
  const prices = require('../src/services/modelPriceService');
  const taskService = require('../src/services/taskService');
  const videoClient = require('../src/services/videoClient');
  const videoService = require('../src/services/videoService');
  const originalCall = videoClient.callVideoApi;
  const originalFetch = global.fetch;
  const configModulePath = require.resolve('../src/config');
  const scheduled = [];
  try {
    process.chdir(tempRoot);
    delete require.cache[configModulePath];
    runMigrationsAndEnsure(db);
    credits.setAccountBalance(db, 'user-1', 100);
    prices.set(db, 'grok-video-3', 11);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO ai_service_configs
        (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
         is_active, is_default, priority, created_at, updated_at)
       VALUES ('video', 'deepwl', 'deepwl_grok_unified', ?, ?, ?, ?, ?, 1, 1, 0, ?, ?)`
    ).run(
      '本地垃圾视频供应商',
      'http://127.0.0.1:9',
      'test-only',
      JSON.stringify(['grok-video-3']),
      'grok-video-3',
      now,
      now
    );
    const dramaId = Number(db.prepare(
      `INSERT INTO dramas (title, status, created_at, updated_at)
       VALUES (?, 'draft', ?, ?)`
    ).run('垃圾视频拒绝', now, now).lastInsertRowid);
    const episodeId = Number(db.prepare(
      `INSERT INTO episodes (drama_id, episode_number, title, script_content, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?, ?)`
    ).run(dramaId, '第1集', '垃圾视频拒绝测试', now, now).lastInsertRowid);
    const storyboardId = Number(db.prepare(
      `INSERT INTO storyboards (episode_id, storyboard_number, title, video_prompt, video_model, status, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?, 'pending', ?, ?)`
    ).run(episodeId, '拒绝镜头', '供应商返回垃圾视频', 'grok-video-3', now, now).lastInsertRowid);

    videoClient.callVideoApi = async () => ({ video_url: videoUrl });
    global.fetch = async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => payload,
    });

    const created = videoService.create(db, { info() {}, warn() {}, error() {} }, {
      drama_id: dramaId,
      storyboard_id: storyboardId,
      provider: 'deepwl',
      model: 'grok-video-3',
      prompt: 'bad bytes',
    }, {
      billingEnabled: true,
      userId: 'user-1',
      schedule(callback) {
        scheduled.push(callback());
      },
    });
    await Promise.all(scheduled);

    const row = db.prepare(
      'SELECT status, error_msg, local_path, task_id, credit_reservation_id FROM video_generations WHERE id = ?'
    ).get(created.id);
    assert.equal(row.status, 'failed');
    assert.match(row.error_msg, expectedError);
    assert.equal(row.local_path, null);
    const task = taskService.getTask(db, row.task_id);
    assert.equal(task.status, 'failed');
    assert.match(task.error, expectedError);
    const storyboard = db.prepare('SELECT video_url, local_path FROM storyboards WHERE id = ?').get(storyboardId);
    assert.equal(storyboard.video_url, null);
    assert.equal(storyboard.local_path, null);
    assert.equal(credits.getReservation(db, row.credit_reservation_id).status, 'refunded');
    assert.deepEqual(credits.getAccount(db, 'user-1'), { user_id: 'user-1', available: 100, held: 0, spent: 0 });
    videoService.settleVideoCredit(db, { error() {} }, row, 'failed', '重复失败结算');
    assert.equal(credits.getReservation(db, row.credit_reservation_id).status, 'refunded');
    assert.deepEqual(credits.getAccount(db, 'user-1'), { user_id: 'user-1', available: 100, held: 0, spent: 0 });
    const storedFiles = fs.existsSync(storagePath)
      ? fs.readdirSync(storagePath, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
      : [];
    assert.equal(storedFiles.length, 0);
  } finally {
    videoClient.callVideoApi = originalCall;
    global.fetch = originalFetch;
    delete require.cache[configModulePath];
    db.close();
    process.chdir(previousCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

test('供应商声明视频但返回垃圾或不完整结构时拒绝完成并不确认计费', async () => {
  const cases = [
    {
      videoUrl: 'https://cdn.example/bad.mp4',
      payload: Buffer.from('declared-video-but-not-mp4'),
      expectedError: /不是可识别的 MP4/,
    },
    {
      videoUrl: 'https://cdn.example/moov-only.mp4',
      payload: MINIMAL_MP4_MOOV_ONLY,
      expectedError: /不是可识别的 MP4/,
    },
    {
      videoUrl: 'https://cdn.example/extended-ftyp-header-only.mp4',
      payload: MINIMAL_MP4_EXTENDED_FTYP_HEADER_ONLY,
      expectedError: /不是可识别的 MP4/,
    },
    {
      videoUrl: 'https://cdn.example/mdat-only.mp4',
      payload: MINIMAL_MP4_MDAT_ONLY,
      expectedError: /不是可识别的 MP4/,
    },
    {
      videoUrl: 'https://cdn.example/bad.webm',
      payload: Buffer.from('declared-video-but-not-webm'),
      expectedError: /不是可识别的 WEBM/,
    },
  ];
  for (const item of cases) {
    await runRejectedVendorVideoCase(item);
  }
});
