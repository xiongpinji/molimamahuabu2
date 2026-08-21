const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiConfigService = require('../src/services/aiConfigService');
const creditLedger = require('../src/services/creditLedgerService');

const {
  buildDjpsdOpenApiImageBody,
  callDjpsdOpenApiImageApi,
  callImageApi,
  parseDjpsdOpenApiImagePollResponse,
} = require('../src/services/imageClient');

const log = {
  info() {},
  warn() {},
  error() {},
};

const originalFetch = global.fetch;

test.afterEach(() => {
  global.fetch = originalFetch;
});

test('DJPSD 图片配置自动使用开放媒体创建和状态端点', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  const config = aiConfigService.createConfig(db, log, {
    service_type: 'image',
    provider: 'djpsd_openapi',
    api_protocol: 'djpsd_openapi',
    name: 'DJPSD 图片',
    base_url: 'https://shiping.djpsd.com',
    api_key: 'secret',
    model: ['image-v1', 'image-v1-2k', 'image-v1-4k'],
    default_model: 'image-v1',
  });

  assert.equal(config.endpoint, '/v1/media/generate');
  assert.equal(config.query_endpoint, '/v1/media/status?task_id={taskId}');
});

test('DJPSD 图片请求按模型保留分辨率档位并从尺寸转换画幅', () => {
  assert.deepEqual(buildDjpsdOpenApiImageBody({
    model: 'image-v1-2k',
    prompt: '雨夜街道上的电影感人物肖像',
    size: '1536x656',
    images: ['/uploads/reference-1.png', '/uploads/reference-2.png'],
  }), {
    model: 'image-v1-2k',
    prompt: '雨夜街道上的电影感人物肖像',
    params: {
      aspect_ratio: '21:9',
      images: ['/uploads/reference-1.png', '/uploads/reference-2.png'],
    },
  });
});

test('DJPSD 图片适配器逐张上传参考图并轮询相对图片结果地址', async () => {
  const requests = [];
  let uploadIndex = 0;
  global.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/v1/media/upload')) {
      uploadIndex += 1;
      assert.equal(options.headers.Authorization, 'Bearer secret');
      assert.equal(options.body.get('file') instanceof Blob, true);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ url: `/uploads/reference-${uploadIndex}.png` }),
      };
    }
    if (url.endsWith('/v1/media/generate')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ task_id: 456, task_status: 'PENDING' }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        task_id: 456,
        state: 'success',
        is_final: true,
        result_type: 'image',
        result_url: '/uploads/image/result.png',
      }),
    };
  };

  const result = await callDjpsdOpenApiImageApi({
    provider: 'djpsd_openapi',
    api_protocol: 'djpsd_openapi',
    base_url: 'https://shiping.djpsd.com/v1',
    api_key: 'secret',
    endpoint: '/v1/media/generate',
    query_endpoint: '/v1/media/status?task_id={taskId}',
  }, log, {
    model: 'image-v1-4k',
    prompt: '保持人物一致性，生成电影海报',
    size: '1024x1024',
    reference_image_urls: [
      'data:image/png;base64,aGVsbG8=',
      'data:image/jpeg;base64,d29ybGQ=',
    ],
    poll_interval_ms: 0,
    max_poll_attempts: 1,
  });

  assert.deepEqual(requests.map((item) => item.url), [
    'https://shiping.djpsd.com/v1/media/upload',
    'https://shiping.djpsd.com/v1/media/upload',
    'https://shiping.djpsd.com/v1/media/generate',
    'https://shiping.djpsd.com/v1/media/status?task_id=456',
  ]);
  assert.deepEqual(JSON.parse(requests[2].options.body), {
    model: 'image-v1-4k',
    prompt: '保持人物一致性，生成电影海报',
    params: {
      aspect_ratio: '1:1',
      images: ['/uploads/reference-1.png', '/uploads/reference-2.png'],
    },
  });
  assert.deepEqual(result, {
    image_url: 'https://shiping.djpsd.com/uploads/image/result.png',
  });
});

test('DJPSD 图片状态不会把视频结果误当图片', () => {
  assert.deepEqual(parseDjpsdOpenApiImagePollResponse({
    state: 'success',
    is_final: true,
    result_type: 'video',
    result_url: '/uploads/result.mp4',
  }, 'https://shiping.djpsd.com'), {
    state: 'failed',
    error: 'DJPSD 开放 API 返回的不是图片结果',
  });
});

test('DJPSD 图片适配器拒绝把 Bearer 发送到跨域提交端点', async () => {
  let requested = false;
  global.fetch = async () => {
    requested = true;
    throw new Error('不应发起请求');
  };

  const result = await callDjpsdOpenApiImageApi({
    base_url: 'https://shiping.djpsd.com',
    api_key: 'secret',
    endpoint: 'https://example.com/v1/media/generate',
  }, log, {
    model: 'image-v1',
    prompt: '测试',
  });

  assert.equal(requested, false);
  assert.match(result.error, /必须与 Base URL 同源/);
});

test('DJPSD 图片创建响应缺少任务号时按结果未知保持预扣积分', async (t) => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ task_status: 'PENDING' }),
  });

  const result = await callDjpsdOpenApiImageApi({
    base_url: 'https://shiping.djpsd.com',
    api_key: 'secret',
  }, log, {
    model: 'image-v1',
    prompt: '测试未知提交结果',
  });

  assert.match(result.error, /结果未知/);
  const db = new Database(':memory:');
  t.after(() => db.close());
  creditLedger.ensureSchema(db);
  creditLedger.setAccountBalance(db, 'user-1', 100);
  const held = creditLedger.reserve(db, {
    userId: 'user-1',
    operationKey: 'image:djpsd-missing-task-id',
    amount: 20,
    model: 'image-v1',
    resourceType: 'image',
    resourceId: 'djpsd-missing-task-id',
  });
  const settled = creditLedger.settleGeneration(db, held.id, 'failed', result.error);
  assert.equal(settled.status, 'held');
  assert.equal(creditLedger.getAccount(db, 'user-1').held, 20);
});

test('image-v1 通过生产 callImageApi 入口路由到 DJPSD 开放 API', async () => {
  const requests = [];
  global.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.includes('/status')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          task_id: 789,
          state: 'success',
          is_final: true,
          result_type: 'image',
          image_url: 'https://cdn.example.com/result.webp',
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ task_id: 789, task_status: 'PENDING' }),
    };
  };
  const row = {
    id: 5,
    service_type: 'image',
    provider: 'djpsd_openapi',
    api_protocol: 'djpsd_openapi',
    name: 'DJPSD 图片',
    base_url: 'https://shiping.djpsd.com',
    api_key: 'secret',
    model: JSON.stringify(['image-v1', 'image-v1-2k', 'image-v1-4k']),
    default_model: 'image-v1',
    endpoint: '/v1/media/generate',
    query_endpoint: '/v1/media/status?task_id={taskId}',
    priority: 0,
    is_default: 1,
    is_active: 1,
    settings: null,
  };
  const db = {
    prepare(sql) {
      return {
        all: () => sql.includes('SELECT * FROM ai_service_configs') ? [row] : [],
      };
    },
  };

  const result = await callImageApi(db, log, {
    model: 'image-v1',
    prompt: '测试 DJPSD 图片路由',
    size: '1024x1024',
    poll_interval_ms: 0,
    max_poll_attempts: 1,
  });

  assert.deepEqual(requests.map((item) => item.url), [
    'https://shiping.djpsd.com/v1/media/generate',
    'https://shiping.djpsd.com/v1/media/status?task_id=789',
  ]);
  assert.deepEqual(result, { image_url: 'https://cdn.example.com/result.webp' });
});
