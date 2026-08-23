const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

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
        reject(new Error('等待图片任务完成超时'));
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

test('分镜图片通过本地 OpenAI 兼容供应商完成提交、轮询与结果回写', async () => {
  const previousCwd = process.cwd();
  const previousPublicMode = process.env.PUBLIC_PLATFORM_MODE;
  const previousWebDist = process.env.WEB_DIST_PATH;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-image-'));
  const configRoot = path.join(tempRoot, 'configs');
  const databasePath = path.join(tempRoot, 'drama.sqlite').replace(/\\/g, '/');
  const storagePath = path.join(tempRoot, 'storage').replace(/\\/g, '/');
  fs.mkdirSync(configRoot, { recursive: true });

  let providerServer;
  let backendServer;
  try {
    let providerRequest;
    providerServer = await listen(http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/images/generations') {
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
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }));
      });
    }));

    const providerBaseUrl = `http://127.0.0.1:${providerServer.address().port}/v1`;
    fs.writeFileSync(
      path.join(configRoot, 'config.yaml'),
      [
        'app:',
        '  name: LocalMiniDrama image integration',
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
    const configId = db.prepare(
      `INSERT INTO ai_service_configs
        (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
         endpoint, is_active, is_default, priority, verification_status, created_at, updated_at)
       VALUES ('storyboard_image', 'openai', 'openai', ?, ?, ?, ?, ?, ?, 1, 1, 0, 'verified', ?, ?)`
    ).run(
      '本地图片回归供应商',
      providerBaseUrl,
      'integration-secret',
      JSON.stringify(['dall-e-3']),
      'dall-e-3',
      '/images/generations',
      now,
      now
    ).lastInsertRowid;
    assert.ok(configId);

    const dramaId = Number(
      db.prepare(
        `INSERT INTO dramas (title, style, status, metadata, created_at, updated_at)
         VALUES (?, ?, 'draft', ?, ?, ?)`
      ).run('图片闭环回归', 'realistic', JSON.stringify({}), now, now).lastInsertRowid
    );
    const episodeId = Number(
      db.prepare(
        `INSERT INTO episodes (drama_id, episode_number, title, script_content, created_at, updated_at)
         VALUES (?, 1, ?, ?, ?, ?)`
      ).run(dramaId, '第1集', '本地供应商生成测试', now, now).lastInsertRowid
    );
    const storyboardId = Number(
      db.prepare(
        `INSERT INTO storyboards
          (episode_id, storyboard_number, title, image_prompt, image_model, grid_frame_type, status, created_at, updated_at)
         VALUES (?, 1, ?, ?, ?, 'single', 'pending', ?, ?)`
      ).run(episodeId, '连续镜头', '一只小狐狸站在雨后森林中，保持单一连续画面', 'dall-e-3', now, now).lastInsertRowid
    );

    backendServer = await listen(created.app);
    const backendBaseUrl = `http://127.0.0.1:${backendServer.address().port}/api/v1`;
    const generated = await readJson(
      await fetch(`${backendBaseUrl}/images`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          storyboard_id: storyboardId,
          drama_id: dramaId,
          prompt: '一只小狐狸站在雨后森林中，保持单一连续画面',
          model: 'dall-e-3',
          frame_type: 'single',
        }),
      })
    );
    assert.equal(generated.status, 201);
    assert.equal(generated.body.data.status, 'pending');
    assert.ok(generated.body.data.task_id);

    const task = await waitFor(async () => {
      const result = await readJson(await fetch(`${backendBaseUrl}/tasks/${generated.body.data.task_id}`));
      return result.body.data?.status === 'completed' ? result.body.data : false;
    });
    assert.equal(task.status, 'completed');
    const taskResult = JSON.parse(task.result);
    assert.equal(taskResult.image_generation_id, generated.body.data.id);

    const image = await readJson(await fetch(`${backendBaseUrl}/images/${generated.body.data.id}`));
    assert.equal(image.status, 200);
    assert.equal(image.body.data.status, 'completed');
    assert.equal(image.body.data.model, 'dall-e-3');
    assert.equal(image.body.data.storyboard_id, storyboardId);
    assert.match(image.body.data.image_url, /^\/static\//);
    assert.ok(image.body.data.local_path);
    const savedPath = path.join(storagePath, image.body.data.local_path);
    assert.ok(fs.existsSync(savedPath));
    const savedBytes = fs.readFileSync(savedPath);
    const fixtureBytes = Buffer.from(ONE_PIXEL_PNG, 'base64');
    assert.equal(savedBytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.deepEqual(savedBytes, fixtureBytes);

    assert.equal(providerRequest.authorization, 'Bearer integration-secret');
    assert.equal(providerRequest.body.model, 'dall-e-3');
    assert.match(providerRequest.body.prompt, /小狐狸/);
    assert.equal(db.prepare('SELECT status FROM image_generations WHERE id = ?').get(generated.body.data.id).status, 'completed');
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
