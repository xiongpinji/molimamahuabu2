const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const aiConfig = require('../src/services/aiConfigService');
const imageClient = require('../src/services/imageClient');
const uploadService = require('../src/services/uploadService');
const credits = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { evidenceRoots, withExternalModelEvidence } = require('./helpers/externalModelEvidenceFixture');

const log = { info() {}, warn() {}, error() {}, errorw() {} };
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function setup(available = 100) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  credits.setAccountBalance(db, 'user-1', available);
  return db;
}

function createAssetImage(db, asset = {}) {
  return imageClient.createAndGenerateImage(db, log, {
    drama_id: 1,
    character_id: asset.characterId ?? 4,
    scene_id: asset.sceneId ?? null,
    image_type: asset.imageType ?? null,
    prompt: 'test only',
    model: asset.model ?? 'gpt-image-2',
    provider: asset.provider ?? 'openai',
    resolution: asset.resolution,
    billingEnabled: true,
    userId: asset.userId ?? 'user-1',
    schedule() {},
  }, { evidenceRoots });
}

function installUsmercariImageModel(db, model, resolutions, options = {}) {
  const config = aiConfig.createConfig(db, log, {
    service_type: 'image',
    provider: 'usmercari_image',
    api_protocol: 'usmercari_image',
    name: `${model} 测试配置`,
    base_url: 'https://chat-ai.mercarimx.com',
    api_key: options.apiKey === undefined ? 'test-key' : options.apiKey,
    model: [model],
    default_model: model,
    is_default: true,
  });
  db.prepare(`UPDATE ai_service_configs
    SET verification_status = ?, verified_capabilities = ? WHERE id = ?`).run(
    options.verificationStatus || 'verified',
    JSON.stringify({
      [model]: withExternalModelEvidence(model, {
        supportsTextToImage: true,
        supportsImageReference: true,
        maxReferences: 6,
        resolutions,
      }),
    }),
    config.id,
  );
  prices.set(db, model, 70, {
    category: 'image',
    cost_unit: 'image',
    resolution_prices: Object.fromEntries(resolutions.map((resolution) => [
      resolution,
      { credits: resolution === '4k' ? 105 : 70, cost_micros_per_unit: resolution === '4k' ? 120000 : 80000 },
    ])),
  });
  return config;
}

test('公开计费模式缺少图片价格时不创建旧资产图片任务', () => {
  const db = setup();

  assert.throws(() => createAssetImage(db), (error) => error.code === 'MODEL_PRICE_NOT_CONFIGURED');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM image_generations').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM async_tasks').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage_reservations').get().count, 0);
});

test('旧资产图片任务预扣积分，复用处理中任务且写入审计事件', () => {
  const db = setup();
  prices.set(db, 'gpt-image-2', 18);

  const first = createAssetImage(db);
  const second = createAssetImage(db);
  const row = db.prepare('SELECT user_id, credit_reservation_id FROM image_generations WHERE id = ?').get(first.id);
  const task = db.prepare('SELECT credit_reservation_id, model FROM async_tasks WHERE id = ?').get(first.task_id);

  assert.equal(row.user_id, 'user-1');
  assert.equal(typeof row.credit_reservation_id, 'string');
  assert.equal(task.credit_reservation_id, row.credit_reservation_id);
  assert.equal(task.model, 'gpt-image-2');
  assert.equal(second.id, first.id);
  assert.equal(second.reused, true);
  assert.deepEqual(credits.getAccount(db, 'user-1'), { user_id: 'user-1', available: 82, held: 18, spent: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage_reservations').get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'generation.image.created'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'generation.image.reused'").get().count, 1);
});

test('旧资产图片结果未知时保留预扣积分', () => {
  const db = setup();
  prices.set(db, 'gpt-image-2', 18);

  const image = createAssetImage(db);
  imageClient.settleImageCredit(db, log, image.id, 'failed', '供应商最终状态未知，请勿重新提交');

  const row = db.prepare('SELECT credit_reservation_id FROM image_generations WHERE id = ?').get(image.id);
  assert.equal(credits.getReservation(db, row.credit_reservation_id).status, 'held');
});

test('旧资产图片明确失败时退回预扣积分', () => {
  const db = setup();
  prices.set(db, 'gpt-image-2', 18);

  const image = createAssetImage(db);
  imageClient.settleImageCredit(db, log, image.id, 'failed', '供应商明确拒绝请求');

  const row = db.prepare('SELECT credit_reservation_id FROM image_generations WHERE id = ?').get(image.id);
  assert.equal(credits.getReservation(db, row.credit_reservation_id).status, 'refunded');
});


test('公开计费模式不复用其他用户的处理中资产图任务', () => {
  const db = setup();
  credits.setAccountBalance(db, 'user-2', 100);
  prices.set(db, 'gpt-image-2', 18);

  const first = createAssetImage(db, { userId: 'user-1' });
  const second = createAssetImage(db, { userId: 'user-2' });

  assert.notEqual(second.id, first.id);
  assert.equal(second.reused, undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM image_generations').get().count, 2);
  assert.equal(credits.getAccount(db, 'user-1').held, 18);
  assert.equal(credits.getAccount(db, 'user-2').held, 18);
});

test('场景全景图任务与场景主参考图任务独立去重', () => {
  const db = setup();
  prices.set(db, 'gpt-image-2', 18);

  const reference = createAssetImage(db, { sceneId: 9, imageType: 'scene_reference' });
  const panorama = createAssetImage(db, { sceneId: 9, imageType: 'scene_panorama' });
  const panoramaAgain = createAssetImage(db, { sceneId: 9, imageType: 'scene_panorama' });

  assert.notEqual(panorama.id, reference.id);
  assert.equal(panoramaAgain.id, panorama.id);
  assert.equal(panoramaAgain.reused, true);
});
test('人物、场景和全景图未显式传模型时统一使用已验证的默认图片模型', () => {
  const db = setup(200);
  if (!db.prepare('PRAGMA table_info(ai_service_configs)').all().some((column) => column.name === 'verification_status')) {
    db.exec('ALTER TABLE ai_service_configs ADD COLUMN verification_status TEXT');
  }
  const config = aiConfig.createConfig(db, log, {
    service_type: 'image',
    provider: 'openai',
    api_protocol: 'openai',
    name: '默认图片模型',
    base_url: 'https://example.invalid/v1',
    api_key: 'test-key',
    model: ['gpt-image-2-2k'],
    default_model: 'gpt-image-2-2k',
    is_default: true,
  });
  db.prepare("UPDATE ai_service_configs SET verification_status = 'verified' WHERE id = ?").run(config.id);
  prices.set(db, 'gpt-image-2-2k', 40, { category: 'image' });

  const createWithoutModel = (asset) => imageClient.createAndGenerateImage(db, log, {
    drama_id: 1,
    character_id: asset.characterId ?? null,
    scene_id: asset.sceneId ?? null,
    image_type: asset.imageType,
    prompt: 'test only',
    provider: 'openai',
    billingEnabled: true,
    userId: 'user-1',
    schedule() {},
  }, { evidenceRoots });

  const character = createWithoutModel({ characterId: 41, imageType: 'character_reference' });
  const scene = createWithoutModel({ sceneId: 51, imageType: 'scene_reference' });
  const panorama = createWithoutModel({ sceneId: 51, imageType: 'scene_panorama' });
  const ids = [character.id, scene.id, panorama.id];
  const rows = db.prepare(`SELECT ig.model, t.model AS task_model
    FROM image_generations ig
    JOIN async_tasks t ON t.id = ig.task_id
    WHERE ig.id IN (?, ?, ?)
    ORDER BY ig.id`).all(...ids);

  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.model), Array(3).fill('gpt-image-2-2k'));
  assert.deepEqual(rows.map((row) => row.task_model), Array(3).fill('gpt-image-2-2k'));
  assert.deepEqual(credits.getAccount(db, 'user-1'), {
    user_id: 'user-1',
    available: 80,
    held: 120,
    spent: 0,
  });
});

test('旧资产 USMercari 角色场景全景图在严格门禁失败时不创建任务或预扣', () => {
  const cases = [
    {
      name: '角色图模型仍在 pending',
      install: (db) => installUsmercariImageModel(db, 'nano-banana-2', ['1k', '2k', '4k'], { verificationStatus: 'pending' }),
      asset: { characterId: 7, model: 'nano-banana-2', provider: 'usmercari_image', resolution: '1k' },
      code: 'MODEL_NOT_VERIFIED',
    },
    {
      name: '场景图缺少 Key',
      install: (db) => installUsmercariImageModel(db, 'nano-banana-2', ['1k', '2k', '4k'], { apiKey: '' }),
      asset: { characterId: null, sceneId: 8, imageType: 'scene_reference', model: 'nano-banana-2', provider: 'usmercari_image', resolution: '1k' },
      code: 'MODEL_CREDENTIAL_MISSING',
    },
    {
      name: '全景图缺少分辨率',
      install: (db) => installUsmercariImageModel(db, 'nano-banana-2', ['1k', '2k', '4k']),
      asset: { characterId: null, sceneId: 9, imageType: 'scene_panorama', model: 'nano-banana-2', provider: 'usmercari_image', resolution: '' },
      code: 'IMAGE_RESOLUTION_REQUIRED',
    },
    {
      name: 'GPT 4K 未验证',
      install: (db) => installUsmercariImageModel(db, 'gpt-image-2-2-4k', ['1k', '2k']),
      asset: { characterId: 10, model: 'gpt-image-2-2-4k', provider: 'usmercari_image', resolution: '4k' },
      code: 'IMAGE_RESOLUTION_NOT_VERIFIED',
    },
  ];

  for (const item of cases) {
    const db = setup(500);
    const previousKey = process.env.USMERCARI_API_KEY;
    delete process.env.USMERCARI_API_KEY;
    try {
      item.install(db);
      assert.throws(() => createAssetImage(db, item.asset), (error) => {
        assert.equal(error.code, item.code, item.name);
        return true;
      });
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM image_generations').get().count, 0, item.name);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM async_tasks').get().count, 0, item.name);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage_reservations').get().count, 0, item.name);
    } finally {
      if (previousKey === undefined) delete process.env.USMERCARI_API_KEY;
      else process.env.USMERCARI_API_KEY = previousKey;
      db.close();
    }
  }
});

test('旧资产 USMercari Nano 4K 通过门禁并持久化请求快照', () => {
  const db = setup(500);
  try {
    installUsmercariImageModel(db, 'nano-banana-2', ['1k', '2k', '4k']);
    const created = createAssetImage(db, {
      characterId: 11,
      model: 'nano-banana-2',
      provider: 'usmercari_image',
      resolution: '4K',
    });
    const row = db.prepare(`SELECT resolution, quantity, request_snapshot, credit_reservation_id
      FROM image_generations WHERE id = ?`).get(created.id);
    assert.equal(row.resolution, '4k');
    assert.equal(row.quantity, 1);
    assert.equal(JSON.parse(row.request_snapshot).resolution, '4k');
    assert.equal(db.prepare('SELECT amount FROM usage_reservations WHERE id = ?').get(row.credit_reservation_id).amount, 105);
  } finally {
    db.close();
  }
});

test('旧资产 strict USMercari n=2 在创建任务和预扣前失败', () => {
  const db = setup(500);
  try {
    installUsmercariImageModel(db, 'nano-banana-2', ['1k', '2k', '4k']);
    assert.throws(() => imageClient.createAndGenerateImage(db, log, {
      drama_id: 1,
      character_id: 14,
      prompt: 'strict quantity',
      model: 'nano-banana-2',
      provider: 'usmercari_image',
      resolution: '1k',
      n: 2,
      billingEnabled: true,
      userId: 'user-1',
      schedule() {},
    }, { evidenceRoots }), (error) => {
      assert.equal(error.code, 'INVALID_IMAGE_QUANTITY');
      return true;
    });
    assert.equal(db.prepare('SELECT COUNT(*) count FROM image_generations').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM async_tasks').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM usage_reservations').get().count, 0);
  } finally {
    db.close();
  }
});

test('旧资产 strict USMercari 非计费入口也拒绝 n=2 而不创建任务', () => {
  const db = setup(500);
  try {
    installUsmercariImageModel(db, 'nano-banana-2', ['1k', '2k', '4k']);
    assert.throws(() => imageClient.createAndGenerateImage(db, log, {
      drama_id: 1,
      character_id: 14,
      prompt: 'strict internal quantity',
      model: 'nano-banana-2',
      provider: 'usmercari_image',
      resolution: '1k',
      n: 2,
      billingEnabled: false,
      schedule() {},
    }, { evidenceRoots }), (error) => {
      assert.equal(error.code, 'INVALID_IMAGE_QUANTITY');
      return true;
    });
    assert.equal(db.prepare('SELECT COUNT(*) count FROM image_generations').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM async_tasks').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM usage_reservations').get().count, 0);
  } finally {
    db.close();
  }
});

test('旧资产 strict USMercari 成功保存本站静态图，远程图本地保存失败则挂起且不建资产', async (t) => {
  const db = setup(500);
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-usmercari-'));
  const previousStoragePath = process.env.STORAGE_LOCAL_PATH;
  const previousStorageBase = process.env.STORAGE_BASE_URL;
  const originalFetch = global.fetch;
  const originalDownload = uploadService.downloadImageToLocal;
  t.after(() => {
    if (previousStoragePath === undefined) delete process.env.STORAGE_LOCAL_PATH;
    else process.env.STORAGE_LOCAL_PATH = previousStoragePath;
    if (previousStorageBase === undefined) delete process.env.STORAGE_BASE_URL;
    else process.env.STORAGE_BASE_URL = previousStorageBase;
    global.fetch = originalFetch;
    uploadService.downloadImageToLocal = originalDownload;
    fs.rmSync(storageRoot, { recursive: true, force: true });
    db.close();
  });
  process.env.STORAGE_LOCAL_PATH = storageRoot;
  process.env.STORAGE_BASE_URL = 'https://molimama.vip/static';
  installUsmercariImageModel(db, 'nano-banana-2', ['1k', '2k', '4k']);
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: [{ url: 'https://cdn.example/generated.png' }] }),
  });
  uploadService.downloadImageToLocal = async (storagePath) => {
    const rel = 'characters/generated.png';
    const full = path.join(storagePath, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, ONE_PIXEL_PNG);
    return rel;
  };
  let scheduled;
  const created = imageClient.createAndGenerateImage(db, log, {
    drama_id: 1,
    character_id: 12,
    prompt: 'strict success',
    model: 'nano-banana-2',
    provider: 'usmercari_image',
    resolution: '4k',
    billingEnabled: true,
    userId: 'user-1',
    schedule(callback) { scheduled = callback; },
  }, { evidenceRoots });

  await scheduled();
  const row = db.prepare('SELECT status, image_url, local_path, error_msg, credit_reservation_id FROM image_generations WHERE id = ?').get(created.id);
  const asset = db.prepare('SELECT * FROM assets WHERE image_gen_id = ?').get(created.id);

  assert.equal(row.status, 'completed', row.error_msg);
  assert.equal(row.image_url, '/static/characters/generated.png');
  assert.equal(row.local_path, 'characters/generated.png');
  assert.equal(asset.url, '/static/characters/generated.png');
  assert.equal(asset.mime_type, 'image/png');
  assert.equal(asset.width, 1);
  assert.equal(asset.height, 1);
  assert.equal(credits.getReservation(db, row.credit_reservation_id).status, 'confirmed');

  uploadService.downloadImageToLocal = async () => null;
  let failedScheduled;
  const failed = imageClient.createAndGenerateImage(db, log, {
    drama_id: 1,
    character_id: 13,
    prompt: 'strict download failure',
    model: 'nano-banana-2',
    provider: 'usmercari_image',
    resolution: '1k',
    billingEnabled: true,
    userId: 'user-1',
    schedule(callback) { failedScheduled = callback; },
  }, { evidenceRoots });

  await failedScheduled();
  const failedRow = db.prepare('SELECT status, error_msg, credit_reservation_id FROM image_generations WHERE id = ?').get(failed.id);

  assert.equal(failedRow.status, 'needs_attention');
  assert.match(failedRow.error_msg, /本地保存失败|未生成本地文件/);
  assert.doesNotMatch(failedRow.error_msg, /重试/);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM assets WHERE image_gen_id = ?').get(failed.id).count, 0);
  assert.equal(credits.getReservation(db, failedRow.credit_reservation_id).status, 'held');

  const reused = imageClient.createAndGenerateImage(db, log, {
    drama_id: 1,
    character_id: 13,
    prompt: 'strict download failure',
    model: 'nano-banana-2',
    provider: 'usmercari_image',
    resolution: '1k',
    billingEnabled: true,
    userId: 'user-1',
    schedule() { assert.fail('needs_attention 任务不得再次调度'); },
  }, { evidenceRoots });
  assert.equal(reused.id, failed.id);
  assert.equal(reused.reused, true);
});

test('旧资产异步提交前证据失效时不调用 USMercari', async (t) => {
  const db = setup(500);
  const originalFetch = global.fetch;
  const originalDownload = uploadService.downloadImageToLocal;
  t.after(() => {
    global.fetch = originalFetch;
    uploadService.downloadImageToLocal = originalDownload;
    db.close();
  });
  const config = installUsmercariImageModel(db, 'nano-banana-2', ['1k', '2k', '4k']);
  let posts = 0;
  global.fetch = async () => {
    posts += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ url: 'https://cdn.example/must-not-submit.png' }] }),
    };
  };
  uploadService.downloadImageToLocal = async () => null;
  let scheduled;
  const created = imageClient.createAndGenerateImage(db, log, {
    drama_id: 1,
    character_id: 21,
    prompt: 'evidence changed after reservation',
    model: 'nano-banana-2',
    provider: 'usmercari_image',
    resolution: '1k',
    billingEnabled: true,
    userId: 'user-1',
    schedule(callback) { scheduled = callback; },
  }, { evidenceRoots });
  const capabilities = JSON.parse(db.prepare(
    'SELECT verified_capabilities FROM ai_service_configs WHERE id = ?',
  ).get(config.id).verified_capabilities);
  capabilities['nano-banana-2'].evidence_sha256 = '0'.repeat(64);
  db.prepare('UPDATE ai_service_configs SET verified_capabilities = ? WHERE id = ?')
    .run(JSON.stringify(capabilities), config.id);

  await scheduled();

  const row = db.prepare('SELECT status, credit_reservation_id FROM image_generations WHERE id = ?')
    .get(created.id);
  assert.equal(posts, 0);
  assert.equal(row.status, 'failed');
  assert.equal(credits.getReservation(db, row.credit_reservation_id).status, 'refunded');
});
