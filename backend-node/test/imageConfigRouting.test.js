const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Database = require('better-sqlite3');

const aiConfig = require('../src/services/aiConfigService');
const imageClient = require('../src/services/imageClient');
const imageService = require('../src/services/imageService');
const imageRoutes = require('../src/routes/images');
const credits = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

function createDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  if (!db.prepare('PRAGMA table_info(ai_service_configs)').all().some((column) => column.name === 'verification_status')) {
    db.exec('ALTER TABLE ai_service_configs ADD COLUMN verification_status TEXT');
  }
  return db;
}

function addConfig(db, values = {}) {
  const config = aiConfig.createConfig(db, log, {
    service_type: values.service_type || 'image',
    provider: values.provider || 'openai',
    api_protocol: values.api_protocol || 'openai',
    name: values.name || 'test image config',
    base_url: values.base_url || 'http://127.0.0.1:9',
    api_key: 'test-key',
    model: values.model || ['gpt-image-2'],
    default_model: values.default_model || 'gpt-image-2',
    endpoint: '/images/generations',
    priority: values.priority || 0,
    is_default: Boolean(values.is_default),
  });
  if (values.is_active === false) {
    db.prepare('UPDATE ai_service_configs SET is_active = 0 WHERE id = ?').run(config.id);
  }
  db.prepare('UPDATE ai_service_configs SET verification_status = ? WHERE id = ?')
    .run(values.verification_status || 'verified', config.id);
  return aiConfig.getConfig(db, config.id);
}

function captureResponse() {
  const result = {};
  return {
    result,
    res: {
      status(code) { result.status = code; return this; },
      json(body) { result.body = body; return this; },
    },
  };
}

function assertConfigError(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

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

test('getImageConfigById returns the exact verified storyboard image config by id', () => {
  const db = createDb();
  try {
    const target = addConfig(db, {
      service_type: 'storyboard_image',
      name: 'storyboard gpt-image-2',
      model: ['gpt-image-2'],
      priority: 10,
      is_default: true,
    });
    const sameNameImage = addConfig(db, {
      service_type: 'image',
      name: 'storyboard gpt-image-2',
      model: ['gpt-image-2'],
      priority: 100,
      is_default: true,
    });

    const result = imageClient.getImageConfigById(db, target.id, 'gpt-image-2');

    assert.equal(result.id, target.id);
    assert.equal(result.service_type, 'storyboard_image');
    assert.notEqual(result.id, sameNameImage.id);
  } finally {
    db.close();
  }
});

test('getImageConfigById rejects invalid config ids and unavailable configs with exact error codes', () => {
  const db = createDb();
  try {
    assertConfigError(
      () => imageClient.getImageConfigById(db, 0, 'gpt-image-2'),
      'IMAGE_CONFIG_NOT_FOUND',
    );
    assertConfigError(
      () => imageClient.getImageConfigById(db, 999999, 'gpt-image-2'),
      'IMAGE_CONFIG_NOT_FOUND',
    );

    const inactive = addConfig(db, { is_active: false });
    assertConfigError(
      () => imageClient.getImageConfigById(db, inactive.id, 'gpt-image-2'),
      'IMAGE_CONFIG_INACTIVE',
    );

    const unverified = addConfig(db, { verification_status: 'failed' });
    assertConfigError(
      () => imageClient.getImageConfigById(db, unverified.id, 'gpt-image-2'),
      'IMAGE_CONFIG_UNVERIFIED',
    );

    const mismatch = addConfig(db, {
      model: ['gpt-image-2-2k'],
      default_model: 'gpt-image-2-2k',
    });
    assertConfigError(
      () => imageClient.getImageConfigById(db, mismatch.id, 'gpt-image-2'),
      'IMAGE_CONFIG_MODEL_MISMATCH',
    );
  } finally {
    db.close();
  }
});

test('getImageConfigById accepts only safe positive integers or decimal digit strings', () => {
  const db = createDb();
  try {
    const first = addConfig(db);
    db.prepare("UPDATE sqlite_sequence SET seq = 99 WHERE name = 'ai_service_configs'").run();
    const hundred = addConfig(db);
    assert.equal(hundred.id, 100);

    assert.equal(imageClient.getImageConfigById(db, first.id, 'gpt-image-2').id, first.id);
    assert.equal(imageClient.getImageConfigById(db, ` ${first.id} `, 'gpt-image-2').id, first.id);

    for (const invalidId of [
      true,
      false,
      [first.id],
      { id: first.id },
      '1e2',
      '1.0',
      `+${first.id}`,
      `-${first.id}`,
      '',
      '   ',
    ]) {
      assertConfigError(
        () => imageClient.getImageConfigById(db, invalidId, 'gpt-image-2'),
        'IMAGE_CONFIG_NOT_FOUND',
      );
    }
  } finally {
    db.close();
  }
});

test('callImageApi with explicit config_id does not fail over to another matching image config after 503', async (t) => {
  const db = createDb();
  t.after(() => db.close());

  const requests = [];
  const primary = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push('primary');
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'temporarily unavailable' } }));
    });
  });
  const backup = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push('backup');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ url: 'https://cdn.example/backup.jpg' }] }));
    });
  });
  t.after(async () => {
    await Promise.all([close(primary), close(backup)]);
  });

  prices.set(db, 'gpt-image-2', 40, { category: 'image' });
  const target = addConfig(db, {
    base_url: `http://127.0.0.1:${primary.address().port}`,
    model: ['gpt-image-2'],
    priority: 100,
    is_default: true,
  });
  addConfig(db, {
    base_url: `http://127.0.0.1:${backup.address().port}`,
    model: ['gpt-image-2'],
    priority: 90,
  });

  const result = await imageClient.callImageApi(db, log, {
    config_id: target.id,
    configId: ` ${target.id} `,
    prompt: 'local test prompt',
    model: 'gpt-image-2',
    size: '1024x1024',
    image_gen_id: 902,
  });

  assert.match(result.error, /^图片生成请求失败: 503\b/);
  assert.deepEqual(requests, ['primary']);
});

test('callImageApi rejects conflicting or invalid explicit config id aliases before calling providers', async (t) => {
  const db = createDb();
  t.after(() => db.close());

  const requests = [];
  const server = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push('provider-called');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ url: 'https://cdn.example/primary.jpg' }] }));
    });
  });
  t.after(() => close(server));

  const target = addConfig(db, {
    base_url: `http://127.0.0.1:${server.address().port}`,
    model: ['gpt-image-2'],
    priority: 100,
    is_default: true,
  });
  const other = addConfig(db, {
    base_url: `http://127.0.0.1:${server.address().port}`,
    model: ['gpt-image-2'],
    priority: 90,
  });

  await assert.rejects(
    () => imageClient.callImageApi(db, log, {
      config_id: target.id,
      configId: other.id,
      prompt: 'local test prompt',
      model: 'gpt-image-2',
      image_gen_id: 903,
    }),
    (error) => {
      assert.equal(error.code, 'IMAGE_CONFIG_NOT_FOUND');
      return true;
    },
  );
  await assert.rejects(
    () => imageClient.callImageApi(db, log, {
      config_id: target.id,
      configId: '1.0',
      prompt: 'local test prompt',
      model: 'gpt-image-2',
      image_gen_id: 904,
    }),
    (error) => {
      assert.equal(error.code, 'IMAGE_CONFIG_NOT_FOUND');
      return true;
    },
  );

  assert.deepEqual(requests, []);
});

test('图片任务从预扣到异步执行始终使用请求 config_id', async (t) => {
  const db = createDb();
  t.after(() => db.close());
  credits.setAccountBalance(db, 'user-1', 100);
  prices.set(db, 'relay-exact-model', 37, { category: 'image' });

  const exact = addConfig(db, {
    service_type: 'storyboard_image',
    provider: 'exact-relay',
    name: 'exact relay',
    model: ['relay-exact-model'],
    default_model: 'relay-exact-model',
    priority: 10,
    is_default: true,
  });
  addConfig(db, {
    service_type: 'image',
    provider: 'backup-relay',
    name: 'same model backup',
    model: ['relay-exact-model'],
    default_model: 'relay-exact-model',
    priority: 100,
    is_default: true,
  });

  const scheduled = [];
  const calls = [];
  const originalCallImageApi = imageClient.callImageApi;
  imageClient.callImageApi = async (_db, _log, options) => {
    calls.push(options);
    return { error: 'local stub stop' };
  };
  t.after(() => { imageClient.callImageApi = originalCallImageApi; });

  const created = imageService.create(db, log, {
    drama_id: 7,
    prompt: '测试精确路由',
    config_id: exact.id,
  }, {
    billingEnabled: true,
    userId: 'user-1',
    schedule(callback) { scheduled.push(callback); },
  });

  const row = db.prepare(
    'SELECT config_id, model, provider, credit_reservation_id FROM image_generations WHERE id = ?',
  ).get(created.id);
  const task = db.prepare('SELECT model, credit_reservation_id FROM async_tasks WHERE id = ?')
    .get(created.task_id);
  assert.equal(row.config_id, exact.id);
  assert.equal(row.model, 'relay-exact-model');
  assert.equal(row.provider, 'exact-relay');
  assert.equal(task.model, 'relay-exact-model');
  assert.equal(task.credit_reservation_id, row.credit_reservation_id);
  assert.deepEqual(credits.getAccount(db, 'user-1'), {
    user_id: 'user-1', available: 63, held: 37, spent: 0,
  });
  assert.equal(scheduled.length, 1);

  await scheduled[0]();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].config_id, exact.id);
  assert.equal(calls[0].model, 'relay-exact-model');
});

test('非法显式图片配置在记录、任务和积分预占前拒绝', () => {
  const cases = [
    {
      name: '不存在',
      expected: 'IMAGE_CONFIG_NOT_FOUND',
      setup: () => ({ configId: 999999, model: 'gpt-image-2' }),
    },
    {
      name: '已停用',
      expected: 'IMAGE_CONFIG_INACTIVE',
      setup: (db) => ({ configId: addConfig(db, { is_active: false }).id, model: 'gpt-image-2' }),
    },
    {
      name: '未验证',
      expected: 'IMAGE_CONFIG_UNVERIFIED',
      setup: (db) => ({
        configId: addConfig(db, { verification_status: 'failed' }).id,
        model: 'gpt-image-2',
      }),
    },
    {
      name: '模型不匹配',
      expected: 'IMAGE_CONFIG_MODEL_MISMATCH',
      setup: (db) => ({
        configId: addConfig(db, {
          model: ['gpt-image-2-2k'],
          default_model: 'gpt-image-2-2k',
        }).id,
        model: 'gpt-image-2',
      }),
    },
  ];

  for (const item of cases) {
    const db = createDb();
    try {
      credits.setAccountBalance(db, 'user-1', 100);
      prices.set(db, 'gpt-image-2', 18, { category: 'image' });
      const { configId, model } = item.setup(db);
      let scheduled = 0;
      assert.throws(() => imageService.create(db, log, {
        drama_id: 8,
        prompt: `reject ${item.name}`,
        model,
        config_id: configId,
      }, {
        billingEnabled: true,
        userId: 'user-1',
        schedule() { scheduled += 1; },
      }), (error) => error.code === item.expected);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM image_generations').get().count, 0, item.name);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM async_tasks').get().count, 0, item.name);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage_reservations').get().count, 0, item.name);
      assert.equal(scheduled, 0, item.name);
    } finally {
      db.close();
    }
  }
});

test('排队期间显式配置被停用时失败且不切换同模型备用配置', async (t) => {
  const db = createDb();
  t.after(() => db.close());
  const exact = addConfig(db, {
    provider: 'exact-relay',
    model: ['queue-model'],
    default_model: 'queue-model',
    priority: 100,
    is_default: true,
  });
  addConfig(db, {
    provider: 'backup-relay',
    model: ['queue-model'],
    default_model: 'queue-model',
    priority: 90,
  });

  const scheduled = [];
  const calls = [];
  const originalCallImageApi = imageClient.callImageApi;
  imageClient.callImageApi = async (...args) => {
    calls.push(args);
    return { error: 'backup must not run' };
  };
  t.after(() => { imageClient.callImageApi = originalCallImageApi; });

  const created = imageService.create(db, log, {
    drama_id: 9,
    prompt: 'queued exact config',
    model: 'queue-model',
    config_id: exact.id,
  }, {
    schedule(callback) { scheduled.push(callback); },
  });
  db.prepare('UPDATE ai_service_configs SET is_active = 0 WHERE id = ?').run(exact.id);

  await scheduled[0]();

  const row = db.prepare('SELECT status, error_msg FROM image_generations WHERE id = ?').get(created.id);
  assert.equal(row.status, 'failed');
  assert.match(row.error_msg, /图片模型配置已停用/);
  assert.equal(calls.length, 0);
});

test('新图片请求无 config_id 时不锁定配置并保留同价备用切换', async (t) => {
  const db = createDb();
  t.after(() => db.close());
  prices.set(db, 'legacy-model', 19, { category: 'image' });

  const requests = [];
  const primary = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push('primary');
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'primary unavailable' } }));
    });
  });
  const backup = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push('backup');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ url: 'https://cdn.example/backup.png' }] }));
    });
  });
  t.after(async () => Promise.all([close(primary), close(backup)]));

  addConfig(db, {
    base_url: `http://127.0.0.1:${primary.address().port}`,
    model: ['legacy-model'],
    default_model: 'legacy-model',
    priority: 100,
    is_default: true,
  });
  addConfig(db, {
    base_url: `http://127.0.0.1:${backup.address().port}`,
    model: ['legacy-model'],
    default_model: 'legacy-model',
    priority: 90,
  });
  const scheduled = [];
  const calls = [];
  const providerResults = [];
  const providerErrors = [];
  const originalCallImageApi = imageClient.callImageApi;
  imageClient.callImageApi = async (_db, _log, options) => {
    calls.push(options);
    try {
      const result = await originalCallImageApi(_db, _log, options);
      providerResults.push(result);
      return result.image_url ? { error: 'local stub stop after failover' } : result;
    } catch (error) {
      providerErrors.push({ code: error.code, message: error.message });
      throw error;
    }
  };
  t.after(() => { imageClient.callImageApi = originalCallImageApi; });

  const created = imageService.create(db, log, {
    drama_id: 10,
    prompt: 'legacy row',
    model: 'legacy-model',
  }, {
    schedule(callback) { scheduled.push(callback); },
  });
  const createdRow = db.prepare('SELECT config_id FROM image_generations WHERE id = ?').get(created.id);
  assert.equal(createdRow.config_id, null);

  await scheduled[0]();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].config_id, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0], 'config_id'), false);
  assert.equal(calls[0].model, 'legacy-model');
  assert.deepEqual(providerErrors, []);
  assert.deepEqual(providerResults[0], { image_url: 'https://cdn.example/backup.png' });
  assert.deepEqual(requests, ['primary', 'backup']);
});

test('图片路由保留显式配置错误码并映射为 400 或 503', () => {
  const db = createDb();
  try {
    const inactive = addConfig(db, { is_active: false });
    const handlers = imageRoutes(db, {}, log, { schedule() {} });

    const notFound = captureResponse();
    handlers.create({
      body: { drama_id: 11, model: 'gpt-image-2', config_id: 999999 },
    }, notFound.res);
    assert.equal(notFound.result.status, 400);
    assert.equal(notFound.result.body.error.code, 'IMAGE_CONFIG_NOT_FOUND');

    const unavailable = captureResponse();
    handlers.create({
      body: { drama_id: 11, model: 'gpt-image-2', config_id: inactive.id },
    }, unavailable.res);
    assert.equal(unavailable.result.status, 503);
    assert.equal(unavailable.result.body.error.code, 'IMAGE_CONFIG_INACTIVE');
  } finally {
    db.close();
  }
});
