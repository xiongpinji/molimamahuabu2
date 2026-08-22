const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Database = require('better-sqlite3');

const aiConfig = require('../src/services/aiConfigService');
const imageClient = require('../src/services/imageClient');
const prices = require('../src/services/modelPriceService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

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

function addImageConfig(db, values) {
  const config = aiConfig.createConfig(db, log, {
    service_type: 'image',
    provider: 'openai',
    api_protocol: 'openai',
    name: values.name,
    base_url: values.baseUrl,
    api_key: 'test-key',
    model: [values.model],
    default_model: values.model,
    endpoint: '/images/generations',
    priority: values.priority,
    is_default: values.isDefault,
  });
  db.prepare('UPDATE ai_service_configs SET verification_status = ? WHERE id = ?')
    .run(values.verified ? 'verified' : 'failed', config.id);
  return config.id;
}

test('默认图片模型明确不可用时只切换到同价、已启用且已验证的备用模型', async (t) => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  if (!db.prepare('PRAGMA table_info(ai_service_configs)').all().some((column) => column.name === 'verification_status')) {
    db.exec('ALTER TABLE ai_service_configs ADD COLUMN verification_status TEXT');
  }
  t.after(() => db.close());

  const requests = [];
  const primary = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push('primary');
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'model_not_found', message: 'No available channel' } }));
    });
  });
  const backup = await listen((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(`backup:${body.model}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ url: 'https://cdn.example/fallback.jpg' }] }));
    });
  });
  const forbidden = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push('forbidden');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ url: 'https://cdn.example/forbidden.jpg' }] }));
    });
  });
  t.after(async () => {
    await Promise.all([close(primary), close(backup), close(forbidden)]);
  });

  prices.set(db, 'gpt-image-2-2k', 40, { category: 'image' });
  prices.set(db, 'gpt-image-2', 40, { category: 'image' });
  prices.set(db, 'gpt-image-2-3.5k', 60, { category: 'image' });
  addImageConfig(db, {
    name: '默认模型', model: 'gpt-image-2-2k', baseUrl: `http://127.0.0.1:${primary.address().port}`,
    priority: 100, isDefault: true, verified: true,
  });
  addImageConfig(db, {
    name: '未验证模型', model: 'gpt-image-2', baseUrl: `http://127.0.0.1:${forbidden.address().port}`,
    priority: 95, verified: false,
  });
  addImageConfig(db, {
    name: '不同价格模型', model: 'gpt-image-2-3.5k', baseUrl: `http://127.0.0.1:${forbidden.address().port}`,
    priority: 90, verified: true,
  });
  addImageConfig(db, {
    name: '同价备用模型', model: 'gpt-image-2', baseUrl: `http://127.0.0.1:${backup.address().port}`,
    priority: 80, verified: true,
  });

  const result = await imageClient.callImageApi(db, log, {
    prompt: '一张风景参考图',
    model: 'gpt-image-2-2k',
    size: '1792x1024',
    image_gen_id: 901,
  });

  assert.deepEqual(result, { image_url: 'https://cdn.example/fallback.jpg' });
  assert.deepEqual(requests, ['primary', 'backup:gpt-image-2']);
});
