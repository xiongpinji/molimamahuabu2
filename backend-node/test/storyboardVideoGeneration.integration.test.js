const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
        res.end(Buffer.from('local-compatible-video-artifact'));
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

    const video = await readJson(await fetch(`${backendBaseUrl}/videos/${generated.body.data.id}`));
    assert.equal(video.status, 200);
    assert.equal(video.body.data.status, 'completed');
    assert.equal(video.body.data.model, 'grok-video-3');
    assert.equal(video.body.data.storyboard_id, storyboardId);
    assert.equal(video.body.data.first_frame_url, firstFrameUrl);
    assert.equal(video.body.data.last_frame_url, lastFrameUrl);
    assert.equal(video.body.data.video_url, `${providerBaseUrl}/output.mp4`);
    assert.ok(video.body.data.local_path);
    assert.ok(fs.existsSync(path.join(storagePath, video.body.data.local_path)));

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
