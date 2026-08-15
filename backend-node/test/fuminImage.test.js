const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Database = require('better-sqlite3');

const aiConfigService = require('../src/services/aiConfigService');
const imageClient = require('../src/services/imageClient');
const imageService = require('../src/services/imageService');
const creditLedgerService = require('../src/services/creditLedgerService');
const {
  FUMIN_IMAGE_MODELS,
  resolveFuminImageModel,
  normalizeFuminImageBaseUrl,
  validateFuminImageModels,
} = require('../src/services/fuminImageClient');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {}, errorw() {} };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

test('fumin 图片别名映射到已验证的上游模型名', () => {
  assert.deepEqual(FUMIN_IMAGE_MODELS, {
    'fumin-gpt-image-2': 'gpt-image-2',
    'fumin-gpt-image-2-4K': 'gpt-image-2-4K',
  });
  assert.equal(resolveFuminImageModel('fumin-gpt-image-2'), 'gpt-image-2');
  assert.equal(resolveFuminImageModel('fumin-gpt-image-2-4K'), 'gpt-image-2-4K');
  assert.equal(resolveFuminImageModel('fumin-gpt-image-2-4k'), 'gpt-image-2-4K');
  assert.equal(resolveFuminImageModel('other-model'), 'other-model');
  assert.equal(normalizeFuminImageBaseUrl('https://fumin.ai/v1/'), 'https://fumin.ai/v1');
  assert.doesNotThrow(() => validateFuminImageModels({
    provider: 'fumin_image', serviceType: 'image', model: ['fumin-gpt-image-2', 'fumin-gpt-image-2-4K'],
  }));
  assert.throws(() => validateFuminImageModels({
    provider: 'fumin_image', serviceType: 'image', model: ['unverified-model'],
  }), { code: 'INVALID_FUMIN_IMAGE_MODEL' });
});

test('fumin 图片连接测试只读模型目录且不提交付费任务', async () => {
  let request;
  global.fetch = async (url, options) => {
    request = { url: String(url), options };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ id: 'gpt-image-2' }, { id: 'gpt-image-2-4K' }] }),
    };
  };

  await aiConfigService.testConnection({
    provider: 'fumin_image',
    service_type: 'image',
    base_url: 'https://fumin.ai/v1',
    api_key: 'secret',
    model: ['fumin-gpt-image-2', 'fumin-gpt-image-2-4K'],
  });

  assert.equal(request.url, 'https://fumin.ai/v1/models');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.headers.Authorization, 'Bearer secret');
  assert.equal(request.options.body, undefined);
});

test('fumin 图片配置只允许已验证别名并自动填充 OpenAI 图片端点', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  try {
    const config = aiConfigService.createConfig(db, log, {
      service_type: 'image',
      provider: 'fumin_image',
      api_protocol: 'openai',
      name: 'fumin 图片配置校验',
      base_url: 'https://fumin.ai/v1',
      api_key: 'test-key',
      model: ['fumin-gpt-image-2', 'fumin-gpt-image-2-4K'],
      default_model: 'fumin-gpt-image-2',
    });
    assert.equal(config.endpoint, '/images/generations');
    assert.throws(() => aiConfigService.createConfig(db, log, {
      service_type: 'image', provider: 'fumin_image', api_key: 'test-key', model: ['unverified-model'],
    }), { code: 'INVALID_FUMIN_IMAGE_MODEL' });
  } finally {
    db.close();
  }
});

test('fumin 4K 图片价格迁移保存前后端一致的规范别名', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  try {
    const row = db.prepare(
      "SELECT model FROM model_credit_prices WHERE model = ? COLLATE NOCASE"
    ).get('fumin-gpt-image-2-4K');
    assert.equal(row?.model, 'fumin-gpt-image-2-4K');
  } finally {
    db.close();
  }
});

test('fumin 4K 图片计费后仍保留供应商配置使用的模型大小写', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  try {
    creditLedgerService.setAccountBalance(db, 'user-1', 100);
    const config = aiConfigService.createConfig(db, log, {
      service_type: 'image',
      provider: 'fumin_image',
      api_protocol: 'openai',
      name: 'fumin GPT Image 2 计费路由',
      base_url: 'https://fumin.ai/v1',
      endpoint: '/images/generations',
      api_key: 'test-key',
      model: ['fumin-gpt-image-2', 'fumin-gpt-image-2-4K'],
      default_model: 'fumin-gpt-image-2',
      is_default: true,
    });
    db.prepare("UPDATE ai_service_configs SET verification_status = 'verified' WHERE id = ?")
      .run(config.id);

    const created = imageService.create(db, log, {
      drama_id: 1,
      model: 'fumin-gpt-image-2-4K',
      prompt: '电影感人物肖像',
    }, {
      billingEnabled: true,
      userId: 'user-1',
      schedule() {},
    });
    const row = db.prepare('SELECT model FROM image_generations WHERE id = ?').get(created.id);

    assert.equal(row.model, 'fumin-gpt-image-2-4K');
    assert.equal(
      imageClient.getDefaultImageConfig(db, row.model, null, 'image')?.provider,
      'fumin_image',
    );
    assert.equal(
      imageClient.getDefaultImageConfig(db, 'fumin-gpt-image-2-4k', null, 'image')?.provider,
      'fumin_image',
    );
  } finally {
    db.close();
  }
});

test('图片生成路由提交上游模型名并解析 base64 结果', async (t) => {
  let request;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      request = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: [{ b64_json: Buffer.from('fumin-image-result').toString('base64') }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  const config = aiConfigService.createConfig(db, log, {
    service_type: 'image',
    provider: 'fumin_image',
    api_protocol: 'openai',
    name: 'fumin GPT Image 2 测试',
    base_url: `http://127.0.0.1:${server.address().port}`,
    endpoint: '/images/generations',
    api_key: 'test-key',
    model: ['fumin-gpt-image-2', 'fumin-gpt-image-2-4K'],
    default_model: 'fumin-gpt-image-2',
    is_default: true,
  });
  db.prepare("UPDATE ai_service_configs SET verification_status = 'verified' WHERE id = ?")
    .run(config.id);

  const result = await imageClient.callImageApi(db, log, {
    prompt: '电影感客厅',
    model: 'fumin-gpt-image-2-4K',
    preferred_provider: 'fumin_image',
    size: '1024x1024',
    imageServiceType: 'image',
  });

  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/images/generations');
  assert.equal(request.authorization, 'Bearer test-key');
  assert.equal(request.body.model, 'gpt-image-2-4K');
  assert.equal(request.body.size, '1024x1024');
  assert.equal(request.body.output_format, 'jpeg');
  assert.equal(request.body.quality, 'low');
  assert.deepEqual(result, {
    image_url: `data:image/jpeg;base64,${Buffer.from('fumin-image-result').toString('base64')}`,
  });
});
