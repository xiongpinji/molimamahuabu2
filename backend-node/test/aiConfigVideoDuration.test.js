const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const aiConfigRoutes = require('../src/routes/aiConfig');

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

function captureResponse() {
  const result = { statusCode: 200, body: null };
  return {
    result,
    res: {
      status(code) {
        result.statusCode = code;
        return this;
      },
      json(body) {
        result.body = body;
      },
    },
  };
}

const log = {
  info() {},
  errorw() {},
  error() {},
};

test('视频模型配置接口拒绝 5 到 15 秒之外或非整数的默认时长', () => {
  const db = createDb();
  const routes = aiConfigRoutes(db, log, {});

  for (const video_duration of [4, 16, 7.5]) {
    const { result, res } = captureResponse();
    routes.create({
      body: {
        service_type: 'video',
        provider: 'test',
        name: '测试视频',
        base_url: 'https://example.test',
        api_key: 'secret',
        model: ['seedance 2.0'],
        settings: JSON.stringify({ video_duration }),
      },
    }, res);
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.error.code, 'BAD_REQUEST');
  }

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_service_configs').get().count, 0);
  db.close();
});

test('更新视频默认时长会保留数据库中的敏感设置并拒绝非法值', () => {
  const db = createDb();
  const info = db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, base_url, api_key, model, settings)
    VALUES ('video', 'klingai', '可灵视频', 'https://example.test', 'secret', ?, ?)
  `).run(
    JSON.stringify(['kling-video-o1']),
    JSON.stringify({
      kling_access_key: 'access-secret',
      kling_secret_key: 'signing-secret',
      video_duration: 5,
      keep_me: true,
    })
  );
  const routes = aiConfigRoutes(db, log, {});

  const updated = captureResponse();
  routes.update({
    params: { id: String(info.lastInsertRowid) },
    body: { settings: JSON.stringify({ video_duration: 12, keep_me: true }) },
  }, updated.res);
  assert.equal(updated.result.statusCode, 200);

  let settings = JSON.parse(
    db.prepare('SELECT settings FROM ai_service_configs WHERE id = ?').get(info.lastInsertRowid).settings
  );
  assert.equal(settings.video_duration, 12);
  assert.equal(settings.kling_access_key, 'access-secret');
  assert.equal(settings.kling_secret_key, 'signing-secret');
  assert.equal(settings.keep_me, true);

  const invalid = captureResponse();
  routes.update({
    params: { id: String(info.lastInsertRowid) },
    body: { settings: JSON.stringify({ video_duration: 16 }) },
  }, invalid.res);
  assert.equal(invalid.result.statusCode, 400);

  settings = JSON.parse(
    db.prepare('SELECT settings FROM ai_service_configs WHERE id = ?').get(info.lastInsertRowid).settings
  );
  assert.equal(settings.video_duration, 12);
  assert.equal(settings.kling_access_key, 'access-secret');
  assert.equal(settings.kling_secret_key, 'signing-secret');
  db.close();
});
