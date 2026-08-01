'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

test('剧本分析项目通过 API 总路由保存并读取', async () => {
  const previousCwd = process.cwd();
  const previousPublicMode = process.env.PUBLIC_PLATFORM_MODE;
  const previousWebDist = process.env.WEB_DIST_PATH;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-script-analysis-'));
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
  try {
    process.chdir(tempRoot);
    process.env.PUBLIC_PLATFORM_MODE = '0';
    process.env.WEB_DIST_PATH = path.join(tempRoot, 'missing-web-dist');

    // Require after chdir so the backend config resolver selects the isolated fixture.
    const { createApp } = require('../src/app');
    const created = createApp();
    server = await listen(created.app);
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
    const project = {
      title: '验收-剧本分析-20260801',
      source_script: '深夜，母亲在厨房发现女儿留下的一封信。她追到车站，在列车开动前与女儿和解。',
      locked_facts: [
        '母亲与女儿是亲生母女',
        '故事发生在现代城市',
        '结局是母女在车站和解',
      ],
    };

    const saved = await fetch(`${baseUrl}/script-analysis/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(project),
    });
    assert.equal(saved.status, 201);
    const savedBody = await saved.json();
    assert.equal(savedBody.data.title, project.title);
    assert.equal(savedBody.data.source_script, project.source_script);
    assert.deepEqual(savedBody.data.locked_facts, project.locked_facts);

    const listed = await fetch(`${baseUrl}/script-analysis/projects`);
    assert.equal(listed.status, 200);
    const listedBody = await listed.json();
    assert.equal(listedBody.data.length, 1);
    assert.equal(listedBody.data[0].id, savedBody.data.id);
    assert.deepEqual(listedBody.data[0].locked_facts, project.locked_facts);
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
