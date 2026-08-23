const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiConfigRoutes = require('../src/routes/aiConfig');
const aiConfigService = require('../src/services/aiConfigService');
const canvasModelCatalogService = require('../src/services/canvasModelCatalogService');
const modelPriceService = require('../src/services/modelPriceService');

const log = { info() {}, error() {}, errorw() {} };

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  return db;
}

function capture() {
  const result = {};
  return {
    result,
    res: {
      status(code) { result.status = code; return this; },
      json(body) { result.body = body; return this; },
    },
  };
}

function createVideoConfig(db, overrides = {}) {
  return aiConfigService.createConfig(db, log, {
    service_type: 'video',
    provider: 'xai',
    api_protocol: 'xai',
    name: '视频供应商',
    base_url: 'https://video.example/v1',
    api_key: 'secret',
    model: ['video-model'],
    default_model: 'video-model',
    endpoint: '/videos',
    query_endpoint: '/videos/{taskId}',
    ...overrides,
  });
}

async function testSavedConnection(db, configId, fetchImpl, routeLog = log) {
  const originalFetch = global.fetch;
  global.fetch = fetchImpl;
  try {
    const handlers = aiConfigRoutes(db, routeLog, {});
    const { res, result } = capture();
    await handlers.testConnection({ body: { config_id: configId } }, res);
    return result;
  } finally {
    global.fetch = originalFetch;
  }
}

test('AI 配置迁移保存最近一次连接验证状态', (t) => {
  const db = setup();
  t.after(() => db.close());
  const columns = new Set(db.prepare('PRAGMA table_info(ai_service_configs)').all().map((row) => row.name));

  assert.equal(columns.has('verification_status'), true);
  assert.equal(columns.has('verification_checked_at'), true);
  assert.equal(columns.has('verified_at'), true);
  assert.equal(columns.has('verification_error'), true);
});

test('三套公开目录只返回全部已验证、启用且已计费的视频模型', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const lingjing = createVideoConfig(db, {
    name: '灵境',
    model: ['lingjing-video-v1'],
    default_model: 'lingjing-video-v1',
  });
  const djpsd = createVideoConfig(db, {
    provider: 'djpsd_openapi',
    api_protocol: 'djpsd_openapi',
    name: 'DJPSD',
    base_url: 'https://shiping.djpsd.com',
    model: ['video-v1'],
    default_model: 'video-v1',
    endpoint: '/v1/media/generate',
    query_endpoint: '/v1/media/status?task_id={taskId}',
  });
  createVideoConfig(db, {
    name: '未验证',
    model: ['unverified-video'],
    default_model: 'unverified-video',
  });
  const unpriced = createVideoConfig(db, {
    name: '已验证但未计费',
    model: ['unpriced-video'],
    default_model: 'unpriced-video',
  });
  for (const model of ['lingjing-video-v1', 'video-v1', 'unverified-video', 'env-only-video']) {
    modelPriceService.set(db, model, 60, { category: 'video' });
  }

  const okResponse = async (url) => ({
    ok: false,
    status: 404,
    text: async () => JSON.stringify({ detail: `not found: ${url}` }),
  });
  assert.equal((await testSavedConnection(db, lingjing.id, okResponse)).status, 200);
  assert.equal((await testSavedConnection(db, djpsd.id, okResponse)).status, 200);
  assert.equal((await testSavedConnection(db, unpriced.id, okResponse)).status, 200);

  const publicCapture = capture();
  aiConfigRoutes(db, log, {}).listPublicVideoModels({}, publicCapture.res);
  assert.deepEqual(publicCapture.result.body.data.sort(), ['video-v1']);

  const previousKey = process.env.CANVAS_VIDEO_API_KEY;
  const previousModel = process.env.CANVAS_VIDEO_MODEL;
  process.env.CANVAS_VIDEO_API_KEY = 'env-secret';
  process.env.CANVAS_VIDEO_MODEL = 'env-only-video';
  t.after(() => {
    if (previousKey === undefined) delete process.env.CANVAS_VIDEO_API_KEY;
    else process.env.CANVAS_VIDEO_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.CANVAS_VIDEO_MODEL;
    else process.env.CANVAS_VIDEO_MODEL = previousModel;
  });

  assert.deepEqual(
    canvasModelCatalogService.list(db)
      .filter((item) => item.kind === 'video')
      .map((item) => item.model)
      .sort(),
    ['video-v1'],
  );
  const videoCapabilities = Object.fromEntries(canvasModelCatalogService.list(db)
    .filter((item) => item.kind === 'video')
    .map((item) => [item.model, item.capabilities]));
  assert.equal(videoCapabilities['video-v1'].maxReferences, 10);
  assert.deepEqual(videoCapabilities['video-v1'].referenceTypes, ['image']);
  assert.deepEqual(
    modelPriceService.listPublic(db)
      .filter((item) => item.category === 'video')
      .map((item) => item.model)
      .sort(),
    ['video-v1'],
  );
});

test('保存配置连接验证失败会记录失败并从公开目录移除', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const config = createVideoConfig(db, { model: ['failed-video'], default_model: 'failed-video' });
  modelPriceService.set(db, 'failed-video', 60, { category: 'video' });

  let loggedError = '';
  const result = await testSavedConnection(db, config.id, async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: { message: 'invalid api key secret' } }),
  }), { ...log, error(_message, details) { loggedError = details.error; } });

  assert.equal(result.status, 400);
  const saved = aiConfigService.getConfig(db, config.id);
  assert.equal(saved.verification_status, 'failed');
  assert.match(saved.verification_checked_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(saved.verified_at, null);
  assert.match(saved.verification_error, /invalid api key/i);
  assert.match(saved.verification_error, /\[REDACTED\]/);
  assert.doesNotMatch(saved.verification_error, /secret/);
  assert.doesNotMatch(JSON.stringify(result.body), /secret/);
  assert.doesNotMatch(loggedError, /secret/);
  assert.deepEqual(modelPriceService.listPublic(db), []);
});

test('只有连接字段实际变化才撤销既有验证', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const config = createVideoConfig(db);
  await testSavedConnection(db, config.id, async () => ({ ok: false, status: 404, text: async () => '' }));

  aiConfigService.updateConfig(db, log, config.id, { priority: 50 });
  assert.equal(aiConfigService.getConfig(db, config.id).verification_status, 'verified');

    aiConfigService.updateConfig(db, log, config.id, {
      settings: JSON.stringify({ video_duration: 10, canvas_capabilities: { ratios: ['9:16'] } }),
    });
    assert.equal(aiConfigService.getConfig(db, config.id).verification_status, 'verified');

  aiConfigService.updateConfig(db, log, config.id, { base_url: 'https://new-video.example/v1' });
  const changed = aiConfigService.getConfig(db, config.id);
  assert.equal(changed.verification_status, 'unverified');
  assert.equal(changed.verification_checked_at, null);
  assert.equal(changed.verified_at, null);
  assert.equal(changed.verification_error, null);
});
