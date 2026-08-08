const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiConfigRoutes = require('../src/routes/aiConfig');
const videoRoutes = require('../src/routes/videos');
const aiConfig = require('../src/services/aiConfigService');
const modelPrice = require('../src/services/modelPriceService');
const videoService = require('../src/services/videoService');
const { evidenceRoots, withExternalModelEvidence } = require('./helpers/externalModelEvidenceFixture');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

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

test('旧 video-models 路由不公开缺少任一严格门槛的 ToAPIs 模型', () => {
  const db = new Database(':memory:');
  const previousKey = process.env.TOAPIS_API_KEY;
  delete process.env.TOAPIS_API_KEY;
  runMigrationsAndEnsure(db);
  try {
    aiConfig.createConfig(db, log, {
      service_type: 'video', provider: 'openai', api_protocol: 'openai',
      name: 'Generic Video', base_url: 'https://example.invalid', api_key: 'generic-key',
      model: ['seedance-2-fast'], default_model: 'seedance-2-fast',
    });
    const config = aiConfig.createConfig(db, log, {
      service_type: 'video', provider: 'toapis', api_protocol: 'toapis_video',
      name: 'ToAPIs 视频', base_url: 'https://toapis.com', api_key: 'stored-key',
      model: ['seedance-2-fast'], default_model: 'seedance-2-fast',
    });
    aiConfig.recordVerification(db, config.id, {
      status: 'verified',
      capabilities: {
        'seedance-2-fast': withExternalModelEvidence('seedance-2-fast', {
          durations: [4, 5], resolutions: ['480p', '720p'],
        }),
      },
    });
    modelPrice.set(db, 'seedance-2-fast', 511, {
      category: 'video',
      resolution_prices: {
        '480p': { credits: 511, cost_micros_per_second: 584000 },
      },
    });
    const handlers = aiConfigRoutes(db, log, {}, { evidenceRoots });
    let captured = capture();
    handlers.listPublicVideoModels({}, captured.res);
    assert.deepEqual(captured.result.body.data, []);

    modelPrice.set(db, 'seedance-2-fast', 511, {
      category: 'video',
      resolution_prices: {
        '480p': { credits: 511, cost_micros_per_second: 584000 },
        '720p': { credits: 511, cost_micros_per_second: 584000 },
      },
    });
    captured = capture();
    handlers.listPublicVideoModels({}, captured.res);
    assert.deepEqual(captured.result.body.data, ['seedance-2-fast']);
  } finally {
    if (previousKey === undefined) delete process.env.TOAPIS_API_KEY;
    else process.env.TOAPIS_API_KEY = previousKey;
    db.close();
  }
});

test('视频创建路由保留门禁错误码并映射参数错误 400、服务门禁 503', () => {
  const originalCreate = videoService.create;
  const handlers = videoRoutes({}, log, {});
  try {
    for (const [code, expectedStatus] of [
      ['INVALID_VIDEO_DURATION', 400],
      ['INVALID_VIDEO_REQUEST', 400],
      ['VIDEO_REFERENCE_FORBIDDEN', 400],
      ['MODEL_NOT_VERIFIED', 503],
      ['MODEL_RESOLUTION_PRICE_REQUIRED', 503],
      ['MODEL_PRICE_NOT_CONFIGURED', 503],
      ['MODEL_DISABLED', 503],
    ]) {
      videoService.create = () => {
        const error = new Error(`expected ${code}`);
        error.code = code;
        throw error;
      };
      const captured = capture();
      handlers.create({ body: {} }, captured.res);
      assert.equal(captured.result.status, expectedStatus, code);
      assert.equal(captured.result.body.error.code, code, code);
    }
  } finally {
    videoService.create = originalCreate;
  }
});
