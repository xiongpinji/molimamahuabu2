const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function readJson(response) {
  const body = await response.json();
  return { status: response.status, body };
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('画布分镜图设置与真实生图请求通过后端持久化并可恢复', async () => {
  const previousCwd = process.cwd();
  const previousPublicMode = process.env.PUBLIC_PLATFORM_MODE;
  const previousWebDist = process.env.WEB_DIST_PATH;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-canvas-'));
  const configRoot = path.join(tempRoot, 'configs');
  const databasePath = path.join(tempRoot, 'drama.sqlite').replace(/\\/g, '/');
  const storagePath = path.join(tempRoot, 'storage').replace(/\\/g, '/');
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, 'config.yaml'),
    [
      'app:',
      '  name: LocalMiniDrama integration',
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

  let server;
  let db;
  try {
    process.chdir(tempRoot);
    process.env.PUBLIC_PLATFORM_MODE = '0';
    process.env.WEB_DIST_PATH = path.join(tempRoot, 'missing-web-dist');

    // Require after chdir so the backend config resolver selects the isolated fixture.
    const { createApp } = require('../src/app');
    const created = createApp();
    db = created.db;
    const now = new Date().toISOString();
    const dramaId = Number(
      db.prepare(
        `INSERT INTO dramas (title, style, status, metadata, created_at, updated_at)
         VALUES (?, ?, 'draft', ?, ?, ?)`
      ).run('画布后端回归', 'realistic', JSON.stringify({ aspect_ratio: '16:9' }), now, now).lastInsertRowid
    );
    const episodeId = Number(
      db.prepare(
        `INSERT INTO episodes (drama_id, episode_number, title, script_content, created_at, updated_at)
         VALUES (?, 1, ?, ?, ?, ?)`
      ).run(dramaId, '第1集', '连续镜头测试', now, now).lastInsertRowid
    );
    const storyboardId = Number(
      db.prepare(
        `INSERT INTO storyboards
          (episode_id, storyboard_number, title, image_prompt, status, created_at, updated_at)
         VALUES (?, 1, ?, ?, 'pending', ?, ?)`
      ).run(episodeId, '画布镜头', '雨后森林中的连续镜头', now, now).lastInsertRowid
    );

    server = await listen(created.app);
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;

    const health = await readJson(await fetch(`http://127.0.0.1:${server.address().port}/health`));
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');

    const initial = await readJson(await fetch(`${baseUrl}/storyboards/${storyboardId}`));
    assert.equal(initial.status, 200);
    assert.equal(initial.body.data.image_model, null);
    assert.equal(initial.body.data.video_model, null);
    assert.equal(initial.body.data.grid_frame_type, 'single');

    const saved = await readJson(
      await fetch(`${baseUrl}/storyboards/${storyboardId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          image_model: 'lib-image-grid',
          video_model: 'lib-video-continuity',
          grid_frame_type: 'nine_grid',
        }),
      })
    );
    assert.equal(saved.status, 200);
    assert.equal(saved.body.data.image_model, 'lib-image-grid');
    assert.equal(saved.body.data.video_model, 'lib-video-continuity');
    assert.equal(saved.body.data.grid_frame_type, 'nine_grid');

    const refreshed = await readJson(await fetch(`${baseUrl}/storyboards/${storyboardId}`));
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.data.image_model, 'lib-image-grid');
    assert.equal(refreshed.body.data.video_model, 'lib-video-continuity');
    assert.equal(refreshed.body.data.grid_frame_type, 'nine_grid');
    assert.deepEqual(
      db.prepare('SELECT image_model, video_model, grid_frame_type FROM storyboards WHERE id = ?').get(storyboardId),
      {
        image_model: 'lib-image-grid',
        video_model: 'lib-video-continuity',
        grid_frame_type: 'nine_grid',
      }
    );

    const dramaReadback = await readJson(await fetch(`${baseUrl}/dramas/${dramaId}`));
    assert.equal(dramaReadback.status, 200);
    const nestedStoryboard = dramaReadback.body.data.episodes[0].storyboards[0];
    assert.equal(nestedStoryboard.image_model, 'lib-image-grid');
    assert.equal(nestedStoryboard.video_model, 'lib-video-continuity');
    assert.equal(nestedStoryboard.grid_frame_type, 'nine_grid');

    const generated = await readJson(
      await fetch(`${baseUrl}/images`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          storyboard_id: storyboardId,
          drama_id: dramaId,
          prompt: '保持连续动作与同一画面构图',
          model: refreshed.body.data.image_model,
          frame_type: refreshed.body.data.grid_frame_type,
          aspect_ratio: '16:9',
        }),
      })
    );
    assert.equal(generated.status, 201);
    assert.equal(generated.body.data.model, 'lib-image-grid');
    assert.equal(generated.body.data.frame_type, 'nine_grid');

    const persistedGeneration = db
      .prepare('SELECT storyboard_id, drama_id, model, frame_type, prompt FROM image_generations WHERE id = ?')
      .get(generated.body.data.id);
    assert.equal(persistedGeneration.storyboard_id, storyboardId);
    assert.equal(persistedGeneration.drama_id, dramaId);
    assert.equal(persistedGeneration.model, 'lib-image-grid');
    assert.equal(persistedGeneration.frame_type, 'nine_grid');
    assert.match(persistedGeneration.prompt, /3x3 grid storyboard image/i);

    const imageReadback = await readJson(await fetch(`${baseUrl}/images/${generated.body.data.id}`));
    assert.equal(imageReadback.status, 200);
    assert.equal(imageReadback.body.data.model, 'lib-image-grid');
    assert.equal(imageReadback.body.data.frame_type, 'nine_grid');
  } finally {
    if (server) await close(server);
    const { closeDb } = require('../src/db');
    closeDb();
    process.chdir(previousCwd);
    if (previousPublicMode === undefined) delete process.env.PUBLIC_PLATFORM_MODE;
    else process.env.PUBLIC_PLATFORM_MODE = previousPublicMode;
    if (previousWebDist === undefined) delete process.env.WEB_DIST_PATH;
    else process.env.WEB_DIST_PATH = previousWebDist;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
