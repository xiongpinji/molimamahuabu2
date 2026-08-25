const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Database = require('better-sqlite3');

const imageClient = require('../src/services/imageClient');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

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

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ai_service_configs (
      id INTEGER PRIMARY KEY,
      service_type TEXT NOT NULL,
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
  `);
  return db;
}

function createStabilityDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  return db;
}

function temporaryUnavailableResponse(res) {
  res.writeHead(503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    error: {
      message: 'provider temporary unavailable',
      type: 'bad_response_status_code',
      code: 'bad_response_status_code',
    },
  }));
}

test('默认模型候选包含已启用的跨模型备用，并保留指定供应商优先顺序', () => {
  const db = createDb();
  try {
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO ai_service_configs
        (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
         endpoint, priority, is_default, is_active, created_at, updated_at)
      VALUES ('image', ?, 'openai', ?, ?, 'test-key', ?, ?, '/v1/images/generations', ?, ?, ?, ?, ?)
    `);
    const primaryId = Number(insert.run(
      'relay-a',
      '默认中转',
      'https://relay-a.example',
      JSON.stringify(['gpt-image-2-2k']),
      'gpt-image-2-2k',
      100,
      1,
      1,
      now,
      now
    ).lastInsertRowid);
    const fallbackId = Number(insert.run(
      'relay-b',
      '备用中转',
      'https://relay-b.example',
      JSON.stringify(['gpt-image-2-2k']),
      'gpt-image-2-2k',
      90,
      0,
      1,
      now,
      now
    ).lastInsertRowid);
    const differentModelId = Number(insert.run(
      'relay-c',
      '不同模型',
      'https://relay-c.example',
      JSON.stringify(['gpt-image-3']),
      'gpt-image-3',
      80,
      0,
      1,
      now,
      now
    ).lastInsertRowid);
    insert.run(
      'relay-d',
      '已停用同模型',
      'https://relay-d.example',
      JSON.stringify(['gpt-image-2-2k']),
      'gpt-image-2-2k',
      70,
      0,
      0,
      now,
      now
    );

    assert.deepEqual(
      imageClient.getImageConfigCandidates(db, 'gpt-image-2-2k').map((config) => config.id),
      [primaryId, fallbackId, differentModelId]
    );
    assert.deepEqual(
      imageClient.getImageConfigCandidates(db).map((config) => config.name),
      ['默认中转', '备用中转', '不同模型']
    );
    assert.deepEqual(
      imageClient.getImageConfigCandidates(db, 'gpt-image-2-2k', 'relay-b').map((config) => config.id),
      [fallbackId, primaryId, differentModelId]
    );
    assert.equal(
      imageClient.getDefaultImageConfig(db, 'gpt-image-2-2k', 'relay-b').id,
      fallbackId
    );
  } finally {
    db.close();
  }
});

test('默认图片中转返回 503 时不自动重复提交到其他图片模型', async () => {
  const db = createStabilityDb();
  const primaryRequests = [];
  const fallbackRequests = [];
  let primaryServer;
  let fallbackServer;

  try {
    primaryServer = await listen(http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        primaryRequests.push({
          authorization: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        });
        temporaryUnavailableResponse(res);
      });
    }));
    fallbackServer = await listen(http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        fallbackRequests.push({
          authorization: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ url: 'https://result.example/fallback.png' }] }));
      });
    }));

    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO ai_service_configs
        (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
         endpoint, priority, is_default, is_active, settings, verification_status, created_at, updated_at)
      VALUES ('image', 'openai', 'openai', ?, ?, ?, ?, ?, '/v1/images/generations', ?, ?, 1, ?, 'verified', ?, ?)
    `);
    insert.run(
      '默认中转',
      `http://127.0.0.1:${primaryServer.address().port}`,
      'primary-key',
      JSON.stringify(['gpt-image-2-2k']),
      'gpt-image-2-2k',
      100,
      1,
      JSON.stringify({ canvas_capabilities: {} }),
      now,
      now
    );
    insert.run(
      '4K 备用中转',
      `http://127.0.0.1:${fallbackServer.address().port}`,
      'fallback-key',
      JSON.stringify(['image-v1-4k']),
      'image-v1-4k',
      90,
      0,
      JSON.stringify({ canvas_capabilities: {} }),
      now,
      now
    );

    const result = await imageClient.callImageApi(db, {
      info() {},
      warn() {},
      error() {},
    }, {
      prompt: '同模型切站测试',
      size: '1024x1024',
      image_gen_id: 991,
    });

    assert.match(result.error, /503/);
    assert.equal(primaryRequests.length, 1);
    assert.equal(fallbackRequests.length, 0);
    assert.equal(primaryRequests[0].authorization, 'Bearer primary-key');
    assert.equal(primaryRequests[0].body.model, 'gpt-image-2-2k');
    assert.equal(
      db.prepare('SELECT state FROM generation_route_requests').get()?.state,
      'needs_attention',
    );
    assert.deepEqual(
      db.prepare(`SELECT task_state, credit_state FROM provider_stability_events
        ORDER BY id DESC LIMIT 1`).get(),
      { task_state: 'needs_attention', credit_state: 'held' },
    );
  } finally {
    db.close();
    if (primaryServer) await close(primaryServer);
    if (fallbackServer) await close(fallbackServer);
  }
});

test('AIHubCC 图片请求 413 时不静默切换模型重新提交', async () => {
  const db = createDb();
  let primaryServer;
  let fallbackServer;
  let primaryRequests = 0;
  let fallbackRequests = 0;

  try {
    primaryServer = await listen(http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        primaryRequests += 1;
        res.writeHead(413, { 'content-type': 'text/html' });
        res.end('<html><head><title>413 Payload Too Large</title></head></html>');
      });
    }));
    fallbackServer = await listen(http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        fallbackRequests += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ url: 'https://result.example/after-413.png' }] }));
      });
    }));

    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO ai_service_configs
        (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
         endpoint, priority, is_default, is_active, settings, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'test-key', ?, ?, '/v1/images/generations', ?, ?, 1, ?, ?, ?)
    `);
    insert.run(
      'storyboard_image',
      'aihubcc',
      'aihubcc',
      'AIHubCC',
      `http://127.0.0.1:${primaryServer.address().port}/v1`,
      JSON.stringify(['gpt-image-2-2k']),
      'gpt-image-2-2k',
      100,
      1,
      JSON.stringify({ canvas_capabilities: {} }),
      now,
      now
    );
    insert.run(
      'image',
      'openai',
      'openai',
      '备用图片模型',
      `http://127.0.0.1:${fallbackServer.address().port}`,
      JSON.stringify(['image-v1-4k']),
      'image-v1-4k',
      90,
      0,
      JSON.stringify({ canvas_capabilities: {} }),
      now,
      now
    );

    const result = await imageClient.callImageApi(db, {
      info() {},
      warn() {},
      error() {},
    }, {
      prompt: 'AIHubCC 413 容灾测试',
      size: '1024x1024',
      image_gen_id: 993,
      imageServiceType: 'storyboard_image',
    });

    assert.match(result.error, /413/);
    assert.equal(primaryRequests, 1);
    assert.equal(fallbackRequests, 0);
  } finally {
    db.close();
    if (primaryServer) await close(primaryServer);
    if (fallbackServer) await close(fallbackServer);
  }
});

test('DJPSD 4K 图片模型按媒体任务协议提交并轮询成功结果', async () => {
  const db = createDb();
  const requests = [];
  let providerServer;

  try {
    providerServer = await listen(http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/v1/media/generate') {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
          if (body.params?.aspect_ratio !== '16:9') {
            res.writeHead(422, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ detail: 'aspect_ratio required' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ task_id: 7123, status: 'pending' }));
          return;
        }
        if (req.method === 'GET' && req.url === '/v1/media/status?task_id=7123') {
          requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            task_id: 7123,
            status: 'success',
            result_url: 'https://result.example/image-v1-4k.png',
          }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    }));

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO ai_service_configs
        (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
         endpoint, query_endpoint, priority, is_default, is_active, created_at, updated_at)
      VALUES ('image', 'djpsd', 'djpsd_media', 'DJPSD 4K', ?, 'djpsd-key', ?, 'image-v1-4k',
              '/v1/media/generate', '/v1/media/status', 100, 1, 1, ?, ?)
    `).run(
      `http://127.0.0.1:${providerServer.address().port}`,
      JSON.stringify(['image-v1-4k']),
      now,
      now
    );

    const result = await imageClient.callImageApi(db, {
      info() {},
      warn() {},
      error() {},
    }, {
      prompt: '4K 媒体协议测试',
      model: 'image-v1-4k',
      size: '16:9',
      image_gen_id: 992,
    });

    assert.deepEqual(result, { image_url: 'https://result.example/image-v1-4k.png' });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].authorization, 'Bearer djpsd-key');
    assert.deepEqual(requests[0].body, {
      model: 'image-v1-4k',
      prompt: '4K 媒体协议测试',
      params: { aspect_ratio: '16:9', images: [] },
    });
    assert.equal(requests[1].authorization, 'Bearer djpsd-key');
  } finally {
    db.close();
    if (providerServer) await close(providerServer);
  }
});
