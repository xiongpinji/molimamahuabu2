const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Database = require('better-sqlite3');

const aiConfig = require('../src/services/aiConfigService');
const imageClient = require('../src/services/imageClient');
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
    provider: 'openai',
    api_protocol: 'openai',
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
