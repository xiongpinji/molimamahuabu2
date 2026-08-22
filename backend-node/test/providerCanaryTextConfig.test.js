'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Database = require('better-sqlite3');

const aiClient = require('../src/services/aiClient');
const aiConfigService = require('../src/services/aiConfigService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

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

function addConfig(db, values) {
  const config = aiConfigService.createConfig(db, log, {
    service_type: values.serviceType || 'text',
    provider: values.name,
    api_protocol: 'openai',
    name: values.name,
    base_url: values.baseUrl,
    api_key: values.apiKey || 'local-private-key',
    model: [values.model],
    default_model: values.model,
    endpoint: '/chat/completions',
    is_active: values.active !== false,
  });
  if (values.active === false) {
    db.prepare('UPDATE ai_service_configs SET is_active = 0 WHERE id = ?').run(config.id);
    return aiConfigService.getConfig(db, config.id);
  }
  return config;
}

test('generateTextForConfigId calls only the requested active text config once', async (t) => {
  const requestsA = [];
  const requestsB = [];
  const serverA = await listen((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requestsA.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'private upstream failure' } }));
    });
  });
  const serverB = await listen((req, res) => {
    requestsB.push(req.url);
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'must not run' } }] }));
  });
  t.after(async () => Promise.all([close(serverA), close(serverB)]));

  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  const configA = addConfig(db, {
    name: 'config-a',
    baseUrl: `http://127.0.0.1:${serverA.address().port}`,
    model: 'text-a',
    apiKey: 'sk-private-config-a',
  });
  const configB = addConfig(db, {
    name: 'config-b',
    baseUrl: `http://127.0.0.1:${serverB.address().port}`,
    model: 'text-b',
  });

  await assert.rejects(
    () => aiClient.generateTextForConfigId(db, log, configA.id, 'canary', 'reply ok', {
      max_tokens: 16,
      _routeConfig: configB,
    }),
    /HTTP 503/,
  );
  assert.equal(requestsA.length, 1);
  assert.equal(requestsB.length, 0);
  const serialized = JSON.stringify(requestsA[0]);
  assert.equal(requestsA[0].model, 'text-a');
  assert.doesNotMatch(serialized, /_routeConfig|base_url|api_key|sk-private-config-a/);
});

test('generateTextForConfigId rejects missing inactive and non-text configs locally', async (t) => {
  let requests = 0;
  const server = await listen((req, res) => {
    requests += 1;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'must not run' } }] }));
  });
  t.after(() => close(server));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  const inactive = addConfig(db, {
    name: 'inactive-text', baseUrl, model: 'inactive-text', active: false,
  });
  const image = addConfig(db, {
    name: 'wrong-type', baseUrl, model: 'wrong-type', serviceType: 'image',
  });

  for (const id of [999999, inactive.id, image.id]) {
    await assert.rejects(
      () => aiClient.generateTextForConfigId(db, log, id, 'canary', 'reply ok'),
      /不存在|停用|类型不匹配/,
    );
  }
  assert.equal(requests, 0);
});
