const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const createAudioRoutes = require('../src/routes/audio');

function createResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('画布音频节点按用户选择的已配置 TTS 模型合成并写回分镜', async (t) => {
  const receivedBodies = [];
  const provider = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    });
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => provider.close(resolve)));

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-audio-model-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE ai_service_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_type TEXT,
      provider TEXT,
      api_protocol TEXT,
      name TEXT,
      base_url TEXT,
      api_key TEXT,
      model TEXT,
      default_model TEXT,
      endpoint TEXT,
      query_endpoint TEXT,
      priority INTEGER DEFAULT 0,
      is_default INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      settings TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY,
      dialogue TEXT,
      audio_local_path TEXT,
      audio_model TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
  `);
  const now = new Date().toISOString();
  const baseUrl = `http://127.0.0.1:${provider.address().port}`;
  const insert = db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, base_url, api_key, model, default_model, is_default, is_active, settings, created_at, updated_at)
    VALUES ('tts', 'openai', ?, ?, 'test-key', ?, ?, ?, 1, '{}', ?, ?)
  `);
  insert.run('默认音频模型', baseUrl, JSON.stringify(['tts-default']), 'tts-default', 1, now, now);
  insert.run('画布音频模型', baseUrl, JSON.stringify(['tts-canvas-a', 'tts-canvas-b']), 'tts-canvas-a', 0, now, now);
  db.prepare('INSERT INTO storyboards (id, dialogue, updated_at) VALUES (1, ?, ?)').run('小茉：你好', now);
  db.prepare('INSERT INTO storyboards (id, dialogue, updated_at) VALUES (2, ?, ?)').run('狐狸：等等', now);
  db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, base_url, api_key, model, default_model, is_default, is_active, settings, created_at, updated_at)
    VALUES ('tts', 'openai', '停用音频模型', ?, 'test-key', ?, 'tts-disabled', 0, 0, '{}', ?, ?)
  `).run(baseUrl, JSON.stringify(['tts-disabled']), now, now);

  const log = { info() {}, warn() {}, error() {} };
  const routes = createAudioRoutes(db, log, {
    storage: { local_path: tempRoot },
  });
  const res = createResponse();
  await routes.extract({
    body: {
      storyboard_id: 1,
      text: '小茉：你好',
      tts_kind: 'dialogue',
      tts_model: 'tts-canvas-b',
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(receivedBodies[0].model, 'tts-canvas-b');
  assert.equal(receivedBodies[0].input, '小茉：你好');
  assert.match(res.body.data.local_path, /^audio\/tts_sb1_/);
  assert.equal(
    db.prepare('SELECT audio_local_path FROM storyboards WHERE id = 1').get().audio_local_path,
    res.body.data.local_path,
  );
  assert.equal(
    db.prepare('SELECT audio_model FROM storyboards WHERE id = 1').get().audio_model,
    'tts-canvas-b',
  );

  for (const model of ['tts-unknown', 'tts-disabled']) {
    const rejected = createResponse();
    await routes.extract({
      body: {
        storyboard_id: 2,
        text: '狐狸：等等',
        tts_kind: 'dialogue',
        tts_model: model,
      },
    }, rejected);
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.body.error.code, 'TTS_MODEL_NOT_CONFIGURED');
    assert.match(rejected.body.error.message, /未找到已启用的 TTS 模型/);
  }
  assert.equal(receivedBodies.length, 1);
  assert.equal(
    db.prepare('SELECT audio_local_path FROM storyboards WHERE id = 2').get().audio_local_path,
    null,
  );
  assert.equal(
    db.prepare('SELECT audio_model FROM storyboards WHERE id = 2').get().audio_model,
    null,
  );
});
