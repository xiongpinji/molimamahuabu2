const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const Database = require('better-sqlite3');

const aiClient = require('../src/services/aiClient');
const aiConfig = require('../src/services/aiConfigService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

function setupTextConfig(baseUrl) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  aiConfig.createConfig(db, log, {
    service_type: 'text',
    provider: 'openai',
    name: '本地 SSE 回归供应商',
    base_url: baseUrl,
    api_key: 'test-key',
    model: ['test-chat-model'],
    default_model: 'test-chat-model',
    is_default: true,
  });
  return db;
}

test('responses payload extracts output text from both supported shapes', () => {
  assert.equal(aiClient.extractTextResponseContent({ output_text: 'direct' }), 'direct');
  assert.equal(aiClient.extractTextResponseContent({
    output: [{ content: [{ type: 'output_text', text: 'nested' }] }],
  }), 'nested');
});

test('responses request uses input and max_output_tokens', () => {
  assert.deepEqual(aiClient.buildResponsesBody({
    model: 'gpt-5.6-sol',
    prompt: 'hello',
    systemPrompt: 'system',
    maxTokens: 32,
  }), {
    model: 'gpt-5.6-sol',
    input: 'hello',
    instructions: 'system',
    max_output_tokens: 32,
  });
});

test('chat stream consumes a final unterminated SSE event with message content', async (t) => {
  const provider = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({
      choices: [{ message: { content: 'final message content' } }],
    })}`);
  });
  const port = await listen(provider);
  t.after(() => provider.close());
  const db = setupTextConfig(`http://127.0.0.1:${port}/v1`);
  t.after(() => db.close());

  const text = await aiClient.generateText(db, log, 'text', 'hello', '');

  assert.equal(text, 'final message content');
});

test('chat stream retries one successful-but-empty response and returns the retry content', async (t) => {
  let requests = 0;
  const provider = http.createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (requests === 1) {
      res.end('data: [DONE]\n\n');
      return;
    }
    res.end(`data: ${JSON.stringify({
      choices: [{ delta: { content: 'retry succeeded' } }],
    })}\n\ndata: [DONE]\n\n`);
  });
  const port = await listen(provider);
  t.after(() => provider.close());
  const db = setupTextConfig(`http://127.0.0.1:${port}/v1`);
  t.after(() => db.close());

  const text = await aiClient.generateText(db, log, 'text', 'hello', '');

  assert.equal(text, 'retry succeeded');
  assert.equal(requests, 2);
});

test('chat stream accepts response output-text deltas without logging generated content', async (t) => {
  const provider = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({
      type: 'response.output_text.delta',
      delta: 'private generated content',
    })}\n\ndata: [DONE]\n\n`);
  });
  const port = await listen(provider);
  t.after(() => provider.close());
  const db = setupTextConfig(`http://127.0.0.1:${port}/v1`);
  t.after(() => db.close());
  const entries = [];
  const capturedLog = {
    info(message, fields) { entries.push({ message, fields }); },
    warn(message, fields) { entries.push({ message, fields }); },
    error(message, fields) { entries.push({ message, fields }); },
    errorw(message, fields) { entries.push({ message, fields }); },
  };

  const text = await aiClient.generateText(db, capturedLog, 'text', 'hello', '');

  assert.equal(text, 'private generated content');
  assert.ok(entries.some((entry) => entry.fields?.text_length === text.length));
  assert.ok(entries.every((entry) => !Object.hasOwn(entry.fields || {}, 'text_preview')));
  assert.doesNotMatch(JSON.stringify(entries), /private generated content/);
});
