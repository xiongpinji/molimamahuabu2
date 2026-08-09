const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Database = require('better-sqlite3');

const aiClient = require('../src/services/aiClient');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {} };

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

function createDb(baseUrl) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
       endpoint, is_active, is_default, priority, settings, created_at, updated_at)
    VALUES ('text', 'openai-compatible', '', 'vision-test', ?, 'secret-key',
      ?, 'vision-model', '/chat/completions', 1, 1, 0, '{}', ?, ?)
  `).run(baseUrl, JSON.stringify(['vision-model']), now, now);
  return db;
}

test('generateTextWithVisionDetailed returns provider id, usage and raw hash without exposing raw response', async () => {
  let requestBody = null;
  let authorization = null;
  let server;
  server = await listen(http.createServer((req, res) => {
    authorization = req.headers.authorization;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': 'header-request-1',
      });
      res.end(JSON.stringify({
        id: 'chatcmpl-real-1',
        model: 'vision-model',
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      }));
    });
  }));
  const db = createDb(`http://127.0.0.1:${server.address().port}`);
  try {
    const result = await aiClient.generateTextWithVisionDetailed(
      db,
      log,
      'text',
      'describe',
      'system',
      { imageUrl: 'data:image/png;base64,AA==' },
      { model: 'vision-model', max_tokens: 88, temperature: 0.2 },
    );

    assert.equal(authorization, 'Bearer secret-key');
    assert.equal(requestBody.model, 'vision-model');
    assert.equal(requestBody.max_tokens, 88);
    assert.equal(result.text, '{"ok":true}');
    assert.equal(result.provider_task_id, 'chatcmpl-real-1');
    assert.equal(result.model, 'vision-model');
    assert.deepEqual(result.usage, { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });
    assert.match(result.raw_hash, /^[a-f0-9]{64}$/);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'raw'), false);
    assert.equal(JSON.stringify(result).includes('secret-key'), false);
  } finally {
    db.close();
    await close(server);
  }
});

test('generateTextWithVisionDetailed fails when provider response id is missing', async () => {
  let server;
  server = await listen(http.createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'no id' } }] }));
  }));
  const db = createDb(`http://127.0.0.1:${server.address().port}`);
  try {
    await assert.rejects(
      () => aiClient.generateTextWithVisionDetailed(
        db,
        log,
        'text',
        'describe',
        '',
        { imageUrl: 'data:image/png;base64,AA==' },
      ),
      /provider response id|响应 ID/,
    );
  } finally {
    db.close();
    await close(server);
  }
});

test('generateTextWithVision keeps the existing string API', async () => {
  let server;
  server = await listen(http.createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: 'plain description' } }],
    }));
  }));
  const db = createDb(`http://127.0.0.1:${server.address().port}`);
  try {
    const text = await aiClient.generateTextWithVision(
      db,
      log,
      'text',
      'describe',
      '',
      { imageUrl: 'data:image/png;base64,AA==' },
    );
    assert.equal(text, 'plain description');
  } finally {
    db.close();
    await close(server);
  }
});
