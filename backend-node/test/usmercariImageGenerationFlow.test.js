const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const aiConfig = require('../src/services/aiConfigService');
const credits = require('../src/services/creditLedgerService');
const imageClient = require('../src/services/imageClient');
const rawImageService = require('../src/services/imageService');
const prices = require('../src/services/modelPriceService');
const uploadService = require('../src/services/uploadService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const storageLayout = require('../src/services/storageLayout');
const { evidenceRoots, withExternalModelEvidence } = require('./helpers/externalModelEvidenceFixture');

const log = { info() {}, warn() {}, error() {}, errorw() {} };
const imageService = {
  ...rawImageService,
  create(db, logger, request, options = {}) {
    return rawImageService.create(db, logger, request, { ...options, evidenceRoots });
  },
  processImageGeneration(db, logger, id, runtime = {}) {
    return rawImageService.processImageGeneration(db, logger, id, { ...runtime, evidenceRoots });
  },
};
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const COSTS = {
  '1k': { credits: 70, cost_micros_per_unit: 80000 },
  '2k': { credits: 87, cost_micros_per_unit: 100000 },
  '4k': { credits: 105, cost_micros_per_unit: 120000 },
};

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const dramaId = Number(db.prepare(
    `INSERT INTO dramas (title, status, user_id, metadata, created_at, updated_at)
     VALUES ('USMercari 图片闭环', 'draft', 'user-1', '{}', ?, ?)`,
  ).run(now, now).lastInsertRowid);
  credits.setAccountBalance(db, 'user-1', 1000);
  return { db, dramaId };
}

function assertNoSideEffects(db) {
  assert.equal(db.prepare('SELECT COUNT(*) count FROM image_generations').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM async_tasks').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM usage_reservations').get().count, 0);
}

function installModel(db, model, resolutions, options = {}) {
  const config = aiConfig.createConfig(db, log, {
    service_type: 'image',
    provider: options.provider || 'usmercari_image',
    api_protocol: options.apiProtocol || 'usmercari_image',
    name: `${model} 测试配置`,
    base_url: options.baseUrl || 'https://chat-ai.mercarimx.com',
    api_key: options.apiKey === undefined ? 'test-key' : options.apiKey,
    model: [model],
    default_model: model,
    is_default: true,
  });
  db.prepare(`UPDATE ai_service_configs
    SET verification_status = ?, verified_capabilities = ?, is_active = ? WHERE id = ?`).run(
    options.verificationStatus || 'verified',
    JSON.stringify({
      [model]: withExternalModelEvidence(model, {
        supportsTextToImage: true,
        supportsImageReference: true,
        maxReferences: 6,
        resolutions,
      }),
    }),
    options.isActive === false ? 0 : 1,
    config.id,
  );
  prices.set(db, model, COSTS[resolutions[0]].credits, {
    category: 'image',
    cost_unit: 'image',
    resolution_prices: Object.fromEntries(resolutions.map((resolution) => [resolution, COSTS[resolution]])),
  });
  return config.id;
}

function createImage(db, dramaId, body = {}, optionOverrides = {}) {
  return imageService.create(db, log, {
    drama_id: dramaId,
    model: 'nano-banana-2',
    prompt: '一只橙色小猫站在雨后花园里',
    resolution: '1k',
    n: 1,
    ...body,
  }, {
    billingEnabled: true,
    userId: 'user-1',
    schedule() {},
    ...optionOverrides,
  });
}

function createDrama(db, title, tenantId = 'tenant-1') {
  const now = new Date().toISOString();
  return Number(db.prepare(
    `INSERT INTO dramas (title, status, tenant_id, metadata, created_at, updated_at)
     VALUES (?, 'draft', ?, '{}', ?, ?)`,
  ).run(title, tenantId, now, now).lastInsertRowid);
}

function fundTenant(db, tenantId, available = 1000) {
  credits.setTenantAccountBalance(db, tenantId, available);
}

function insertProjectAsset(db, dramaId, localPath) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO assets (drama_id, name, type, category, url, local_path, metadata, created_at, updated_at)
     VALUES (?, '参考图', 'image', 'reference', ?, ?, '{}', ?, ?)`,
  ).run(dramaId, `/static/${localPath}`, localPath, now, now);
  return `/static/${localPath}`;
}

function insertStoryboardWithFirstFrame(db, dramaId) {
  const now = new Date().toISOString();
  const storyboardId = Number(db.prepare(
    `INSERT INTO storyboards (episode_id, storyboard_number, title, created_at, updated_at)
     VALUES (1, 1, '尾帧', ?, ?)`,
  ).run(now, now).lastInsertRowid);
  const firstFrameId = Number(db.prepare(
    `INSERT INTO image_generations (storyboard_id, drama_id, provider, prompt, model, frame_type, image_url, status, created_at, updated_at, completed_at)
     VALUES (?, ?, 'usmercari_image', '首帧', 'nano-banana-2', 'storyboard_first', 'https://cdn.example.com/first-frame.png', 'completed', ?, ?, ?)`,
  ).run(storyboardId, dramaId, now, now, now).lastInsertRowid);
  db.prepare('UPDATE storyboards SET first_frame_image_id = ? WHERE id = ?').run(firstFrameId, storyboardId);
  return storyboardId;
}

function insertStoryboardWithSceneRef(db, dramaId) {
  const now = new Date().toISOString();
  const sceneId = Number(db.prepare(
    `INSERT INTO scenes (drama_id, location, image_url, status, created_at, updated_at)
     VALUES (?, '花园', 'https://cdn.example.com/scene.png', 'completed', ?, ?)`,
  ).run(dramaId, now, now).lastInsertRowid);
  return Number(db.prepare(
    `INSERT INTO storyboards (episode_id, scene_id, storyboard_number, title, created_at, updated_at)
     VALUES (1, ?, 1, '普通分镜', ?, ?)`,
  ).run(sceneId, now, now).lastInsertRowid);
}

test('USMercari 图片在验证、档位或参考图门禁失败时不创建任务和预扣', () => {
  const cases = [
    {
      name: '模型未验证',
      install: (db) => installModel(db, 'nano-banana-2', ['1k', '2k', '4k'], { verificationStatus: 'pending' }),
      body: {},
      code: 'MODEL_NOT_VERIFIED',
    },
    {
      name: '模型配置已停用',
      install: (db) => installModel(db, 'nano-banana-2', ['1k', '2k', '4k'], { isActive: false }),
      body: {},
      code: 'MODEL_NOT_VERIFIED',
    },
    {
      name: '受保护模型禁止使用同名的其他供应商配置',
      install: (db) => installModel(db, 'nano-banana-2', ['1k', '2k', '4k'], {
        provider: 'openai',
        apiProtocol: 'openai',
        baseUrl: 'https://wrong-provider.example/v1',
      }),
      body: {},
      code: 'MODEL_NOT_VERIFIED',
    },
    {
      name: '未明确分辨率',
      install: (db) => installModel(db, 'nano-banana-2', ['1k', '2k', '4k']),
      body: { resolution: '' },
      code: 'IMAGE_RESOLUTION_REQUIRED',
    },
    {
      name: 'GPT 4K 未通过真实验证',
      install: (db) => installModel(db, 'gpt-image-2-2-4k', ['1k', '2k']),
      body: { model: 'gpt-image-2-2-4k', resolution: '4k' },
      code: 'IMAGE_RESOLUTION_NOT_VERIFIED',
    },
    {
      name: '第七张参考图',
      install: (db) => installModel(db, 'nano-banana-2', ['1k', '2k', '4k']),
      body: { reference_images: Array.from({ length: 7 }, (_, index) => `/static/ref-${index}.png`) },
      code: 'IMAGE_REFERENCE_LIMIT_EXCEEDED',
    },
  ];

  for (const item of cases) {
    const { db, dramaId } = setup();
    try {
      item.install(db);
      assert.throws(() => createImage(db, dramaId, item.body), (error) => {
        assert.equal(error.code, item.code, item.name);
        return true;
      });
      assert.equal(db.prepare('SELECT COUNT(*) count FROM image_generations').get().count, 0, item.name);
      assert.equal(db.prepare('SELECT COUNT(*) count FROM async_tasks').get().count, 0, item.name);
      assert.equal(db.prepare('SELECT COUNT(*) count FROM usage_reservations').get().count, 0, item.name);
    } finally {
      db.close();
    }
  }
});

test('USMercari 图片缺少有效 Key 时在预扣前失败', () => {
  const { db, dramaId } = setup();
  const previousKey = process.env.USMERCARI_API_KEY;
  delete process.env.USMERCARI_API_KEY;
  try {
    installModel(db, 'nano-banana-2', ['1k', '2k', '4k'], { apiKey: '' });
    assert.throws(() => createImage(db, dramaId), (error) => {
      assert.equal(error.code, 'MODEL_CREDENTIAL_MISSING');
      return true;
    });
    assert.equal(db.prepare('SELECT COUNT(*) count FROM async_tasks').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM usage_reservations').get().count, 0);
  } finally {
    if (previousKey === undefined) delete process.env.USMERCARI_API_KEY;
    else process.env.USMERCARI_API_KEY = previousKey;
    db.close();
  }
});

test('USMercari 非计费内部入口同样禁止未验证的 GPT 4K', () => {
  const { db, dramaId } = setup();
  try {
    installModel(db, 'gpt-image-2-2-4k', ['1k', '2k']);
    assert.throws(() => imageService.create(db, log, {
      drama_id: dramaId,
      model: 'gpt-image-2-2-4k',
      prompt: '内部生成也必须受能力门禁保护',
      resolution: '4k',
    }, {
      billingEnabled: false,
      schedule() {},
    }), (error) => {
      assert.equal(error.code, 'IMAGE_RESOLUTION_NOT_VERIFIED');
      return true;
    });
    assert.equal(db.prepare('SELECT COUNT(*) count FROM image_generations').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM async_tasks').get().count, 0);
  } finally {
    db.close();
  }
});

test('USMercari 图片按分辨率预扣并持久化不可变请求及人民币成本快照', () => {
  const { db, dramaId } = setup();
  try {
    installModel(db, 'gpt-image-2-2-4k', ['1k', '2k']);
    const created = createImage(db, dramaId, {
      model: 'gpt-image-2-2-4k',
      resolution: '2K',
      reference_images: ['/static/ref-a.png'],
    });
    const row = db.prepare(`SELECT resolution, quantity, request_snapshot, credit_reservation_id
      FROM image_generations WHERE id = ?`).get(created.id);
    const reservation = credits.getReservation(db, row.credit_reservation_id);
    const cost = db.prepare('SELECT * FROM generation_cost_records WHERE reservation_id = ?')
      .get(row.credit_reservation_id);
    const snapshot = JSON.parse(row.request_snapshot);

    assert.equal(row.resolution, '2k');
    assert.equal(row.quantity, 1);
    assert.equal(reservation.amount, 87);
    assert.equal(cost.model, 'gpt-image-2-2-4k');
    assert.equal(cost.resolution, '2k');
    assert.equal(cost.quantity, 1);
    assert.equal(cost.cost_micros, 100000);
    assert.deepEqual(snapshot, {
      model: 'gpt-image-2-2-4k',
      provider: 'usmercari_image',
      protocol: 'usmercari_image',
      config_id: snapshot.config_id,
      resolution: '2k',
      quantity: 1,
      reference_images: ['/static/ref-a.png'],
      credits: 87,
      cost_micros_per_unit: 100000,
      capabilities: withExternalModelEvidence('gpt-image-2-2-4k', {
        supportsTextToImage: true,
        supportsImageReference: true,
        maxReferences: 6,
        resolutions: ['1k', '2k'],
      }),
    });
  } finally {
    db.close();
  }
});

test('USMercari 图片参考图必须属于当前项目且在预扣前 fail closed', () => {
  const { db, dramaId } = setup();
  try {
    db.prepare('UPDATE dramas SET tenant_id = ? WHERE id = ?').run('tenant-1', dramaId);
    fundTenant(db, 'tenant-1');
    const otherDramaId = createDrama(db, '同租户另一个项目', 'tenant-1');
    installModel(db, 'nano-banana-2', ['1k', '2k', '4k']);
    const ownDir = storageLayout.getProjectStorageSubdir(db, dramaId);
    const otherDir = storageLayout.getProjectStorageSubdir(db, otherDramaId);
    const ownUrl = insertProjectAsset(db, dramaId, `${ownDir}/assets/ref.png`);
    const otherUrl = insertProjectAsset(db, otherDramaId, `${otherDir}/assets/ref.png`);

    const created = createImage(db, dramaId, { reference_images: [ownUrl] }, { tenantId: 'tenant-1' });
    assert.equal(created.status, 'pending');

    for (const badUrl of [
      otherUrl,
      `/static/${ownDir}/assets/missing.png`,
    ]) {
      assert.throws(() => createImage(db, dramaId, { reference_images: [badUrl] }, { tenantId: 'tenant-1' }), (error) => {
        assert.equal(error.code, 'IMAGE_REFERENCE_FORBIDDEN');
        return true;
      });
    }
    assert.equal(db.prepare('SELECT COUNT(*) count FROM image_generations').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM tenant_usage_reservations').get().count, 1);
  } finally {
    db.close();
  }
});

test('USMercari 本站绝对参考图只接受配置的 storage origin，不接受伪造 origin', () => {
  const { db, dramaId } = setup();
  const previousBase = process.env.STORAGE_BASE_URL;
  process.env.STORAGE_BASE_URL = 'https://molimama.test/static';
  try {
    db.prepare('UPDATE dramas SET tenant_id = ?, user_id = ? WHERE id = ?').run('tenant-1', 'owner-1', dramaId);
    fundTenant(db, 'tenant-1');
    installModel(db, 'nano-banana-2', ['1k', '2k', '4k']);
    const ownDir = storageLayout.getProjectStorageSubdir(db, dramaId);
    const otherDramaId = createDrama(db, '伪造同路径项目', 'tenant-1');
    const otherDir = storageLayout.getProjectStorageSubdir(db, otherDramaId);
    const ownUrl = insertProjectAsset(db, dramaId, `${ownDir}/assets/ref.png`);
    insertProjectAsset(db, otherDramaId, `${otherDir}/assets/ref.png`);
    const encodedOwnUrl = `https://molimama.test/static/${encodeURI(`${ownDir}/assets/ref.png`)}`;
    const evilSamePath = `https://evil.example/static/${otherDir}/assets/ref.png`;
    const credentialed = `https://attacker:pass@molimama.test/static/${ownDir}/assets/ref.png`;

    const created = imageService.create(db, log, {
      drama_id: dramaId,
      model: 'nano-banana-2',
      prompt: '同项目本站绝对参考图允许',
      resolution: '1k',
      reference_images: [encodedOwnUrl],
    }, {
      billingEnabled: true,
      userId: 'owner-1',
      tenantId: 'tenant-1',
      schedule() {},
    });
    assert.equal(created.status, 'pending');

    for (const ref of [evilSamePath, credentialed]) {
      const external = imageService.create(db, log, {
        drama_id: dramaId,
        model: 'nano-banana-2',
        prompt: '非本站或非法路径按外部/普通 URL 保持既有路径',
        resolution: '1k',
        reference_images: [ref],
      }, {
        billingEnabled: true,
        userId: 'owner-1',
        tenantId: 'tenant-1',
        schedule() {},
      });
      const row = db.prepare('SELECT reference_images FROM image_generations WHERE id = ?').get(external.id);
      assert.deepEqual(JSON.parse(row.reference_images), [ref]);
    }
    assert.equal(ownUrl, `/static/${ownDir}/assets/ref.png`);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM image_generations').get().count, 3);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM tenant_usage_reservations').get().count, 3);
  } finally {
    if (previousBase === undefined) delete process.env.STORAGE_BASE_URL;
    else process.env.STORAGE_BASE_URL = previousBase;
    db.close();
  }
});

test('USMercari 本站参考图编码点段和反斜杠必须在预扣前 fail closed', () => {
  for (const ref of [
    '/static/projects/demo/%2e%2e/escape.png',
    '/static/projects/demo/%252e%252e/escape.png',
    '/static/projects/demo/%5cref.png',
    '/static\\projects\\demo\\ref.png',
    '/static/%70rojects/demo/missing.png',
  ]) {
    const { db, dramaId } = setup();
    try {
      installModel(db, 'nano-banana-2', ['1k', '2k', '4k']);
      assert.throws(() => createImage(db, dramaId, {
        reference_images: [ref],
      }), (error) => {
        assert.equal(error.code, 'IMAGE_REFERENCE_FORBIDDEN');
        return true;
      }, ref);
      assertNoSideEffects(db);
    } finally {
      db.close();
    }
  }
});

test('USMercari 本站参考图无 tenant 时必须匹配项目 owner', () => {
  const { db, dramaId } = setup();
  try {
    db.prepare('UPDATE dramas SET tenant_id = NULL, user_id = ? WHERE id = ?').run('owner-1', dramaId);
    credits.setAccountBalance(db, 'owner-1', 1000);
    installModel(db, 'nano-banana-2', ['1k', '2k', '4k']);
    const ownDir = storageLayout.getProjectStorageSubdir(db, dramaId);
    const ownUrl = insertProjectAsset(db, dramaId, `${ownDir}/assets/ref.png`);

    const created = imageService.create(db, log, {
      drama_id: dramaId,
      model: 'nano-banana-2',
      prompt: 'owner 模式允许同项目参考图',
      resolution: '1k',
      reference_images: [ownUrl],
    }, {
      billingEnabled: true,
      userId: 'owner-1',
      schedule() {},
    });
    assert.equal(created.status, 'pending');

    for (const userId of ['', 'other-user']) {
      assert.throws(() => imageService.create(db, log, {
        drama_id: dramaId,
        model: 'nano-banana-2',
        prompt: 'owner 不匹配必须拒绝',
        resolution: '1k',
        reference_images: [ownUrl],
      }, {
        billingEnabled: true,
        userId,
        schedule() {},
      }), (error) => {
        assert.equal(error.code, userId ? 'IMAGE_REFERENCE_FORBIDDEN' : 'UNAUTHORIZED');
        return true;
      });
    }
    assert.equal(db.prepare('SELECT COUNT(*) count FROM image_generations').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM async_tasks').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM usage_reservations').get().count, 1);
  } finally {
    db.close();
  }
});

test('USMercari 本站参考图 tenant 模式拒绝另一租户且拒绝不产生副作用', () => {
  const { db, dramaId } = setup();
  try {
    db.prepare('UPDATE dramas SET tenant_id = ?, user_id = ? WHERE id = ?').run('tenant-1', 'owner-1', dramaId);
    installModel(db, 'nano-banana-2', ['1k', '2k', '4k']);
    const ownDir = storageLayout.getProjectStorageSubdir(db, dramaId);
    const ownUrl = insertProjectAsset(db, dramaId, `${ownDir}/assets/ref.png`);

    assert.throws(() => imageService.create(db, log, {
      drama_id: dramaId,
      model: 'nano-banana-2',
      prompt: 'tenant 不匹配必须拒绝',
      resolution: '1k',
      reference_images: [ownUrl],
    }, {
      billingEnabled: true,
      userId: 'owner-1',
      tenantId: 'tenant-2',
      schedule() {},
    }), (error) => {
      assert.equal(error.code, 'IMAGE_REFERENCE_FORBIDDEN');
      return true;
    });
    assertNoSideEffects(db);
  } finally {
    db.close();
  }
});

test('USMercari 图片外部公网参考图保持既有路径', () => {
  const { db, dramaId } = setup();
  try {
    installModel(db, 'nano-banana-2', ['1k', '2k', '4k']);
    const created = createImage(db, dramaId, {
      reference_images: ['https://cdn.example.com/reference.png'],
    });
    const row = db.prepare('SELECT reference_images FROM image_generations WHERE id = ?').get(created.id);
    assert.deepEqual(JSON.parse(row.reference_images), ['https://cdn.example.com/reference.png']);
  } finally {
    db.close();
  }
});

test('USMercari 图片 n=2 在创建任务和预扣前失败', () => {
  const { db, dramaId } = setup();
  try {
    installModel(db, 'nano-banana-2', ['1k', '2k', '4k']);
    assert.throws(() => createImage(db, dramaId, {
      resolution: '1k',
      n: 2,
    }), (error) => {
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

test('USMercari 尾帧首帧锁自动合并超过参考图上限时在预扣前失败', () => {
  const { db, dramaId } = setup();
  try {
    installModel(db, 'nano-banana-2', ['1k', '2k', '4k']);
    const storyboardId = insertStoryboardWithFirstFrame(db, dramaId);
    const imageCountBefore = db.prepare('SELECT COUNT(*) count FROM image_generations').get().count;

    assert.throws(() => createImage(db, dramaId, {
      storyboard_id: storyboardId,
      frame_type: 'storyboard_last',
      use_first_frame_layout_lock: 1,
      reference_images: Array.from({ length: 6 }, (_, index) => `https://cdn.example.com/ref-${index}.png`),
    }), (error) => {
      assert.equal(error.code, 'IMAGE_REFERENCE_LIMIT_EXCEEDED');
      return true;
    });
    assert.equal(db.prepare('SELECT COUNT(*) count FROM image_generations').get().count, imageCountBefore);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM async_tasks').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM usage_reservations').get().count, 0);
  } finally {
    db.close();
  }
});

test('USMercari 分镜自动参考图合并超过上限时在预扣前失败', () => {
  const { db, dramaId } = setup();
  try {
    installModel(db, 'nano-banana-2', ['1k', '2k', '4k']);
    const storyboardId = insertStoryboardWithSceneRef(db, dramaId);

    assert.throws(() => createImage(db, dramaId, {
      storyboard_id: storyboardId,
      frame_type: 'storyboard_first',
      reference_images: Array.from({ length: 6 }, (_, index) => `https://cdn.example.com/ref-${index}.png`),
    }), (error) => {
      assert.equal(error.code, 'IMAGE_REFERENCE_LIMIT_EXCEEDED');
      return true;
    });
    assertNoSideEffects(db);
  } finally {
    db.close();
  }
});

test('USMercari 图片异步执行使用创建时快照，成功后写入素材并确认积分', async (t) => {
  const { db, dramaId } = setup();
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'usmercari-image-flow-'));
  const previousStoragePath = process.env.STORAGE_LOCAL_PATH;
  process.env.STORAGE_LOCAL_PATH = storageRoot;
  installModel(db, 'nano-banana-2', ['1k', '2k', '4k']);
  const originalCall = imageClient.callImageApi;
  const originalDownload = uploadService.downloadImageToLocal;
  let providerRequest;
  imageClient.callImageApi = async (_db, _log, options) => {
    providerRequest = options;
    return { image_url: 'https://cdn.example/result.png', image_urls: ['https://cdn.example/result.png'] };
  };
  uploadService.downloadImageToLocal = async () => {
    const relative = 'projects/0001/assets/generated.png';
    const absolute = path.join(storageRoot, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, ONE_PIXEL_PNG);
    return relative;
  };
  t.after(() => {
    imageClient.callImageApi = originalCall;
    uploadService.downloadImageToLocal = originalDownload;
    if (previousStoragePath === undefined) delete process.env.STORAGE_LOCAL_PATH;
    else process.env.STORAGE_LOCAL_PATH = previousStoragePath;
    fs.rmSync(storageRoot, { recursive: true, force: true });
    db.close();
  });

  const created = createImage(db, dramaId, { resolution: '4k' });
  const held = db.prepare('SELECT credit_reservation_id FROM image_generations WHERE id = ?').get(created.id);
  prices.set(db, 'nano-banana-2', 1, {
    category: 'image',
    cost_unit: 'image',
    resolution_prices: { '1k': { credits: 1, cost_micros_per_unit: 1 } },
  });

  await imageService.processImageGeneration(db, log, created.id);

  assert.equal(providerRequest.model, 'nano-banana-2');
  assert.equal(providerRequest.resolution, '4k');
  assert.equal(providerRequest.n, 1);
  const image = db.prepare('SELECT status, image_url, local_path FROM image_generations WHERE id = ?').get(created.id);
  assert.equal(image.status, 'completed');
  assert.equal(image.image_url, '/static/projects/0001/assets/generated.png');
  assert.equal(image.local_path, 'projects/0001/assets/generated.png');
  assert.equal(credits.getReservation(db, held.credit_reservation_id).status, 'confirmed');
  const asset = db.prepare('SELECT * FROM assets WHERE image_gen_id = ? AND deleted_at IS NULL').get(created.id);
  assert.equal(asset.drama_id, dramaId);
  assert.equal(asset.type, 'image');
  assert.equal(asset.url, image.image_url);
  assert.equal(asset.local_path, image.local_path);
});

test('USMercari 图片证据绑定在预扣后被篡改时不调用供应商并完整退款', async (t) => {
  const { db, dramaId } = setup();
  installModel(db, 'nano-banana-2', ['1k', '2k', '4k']);
  const originalCall = imageClient.callImageApi;
  let providerCalls = 0;
  imageClient.callImageApi = async () => {
    providerCalls += 1;
    return { image_url: 'https://cdn.example/should-not-run.png' };
  };
  t.after(() => {
    imageClient.callImageApi = originalCall;
    db.close();
  });

  const created = createImage(db, dramaId, { resolution: '1k' });
  const row = db.prepare('SELECT credit_reservation_id FROM image_generations WHERE id = ?').get(created.id);
  const config = aiConfig.listConfigs(db, 'image').find((item) => item.provider === 'usmercari_image');
  const capabilities = JSON.parse(JSON.stringify(config.verified_capabilities));
  capabilities['nano-banana-2'].evidence_sha256 = '0'.repeat(64);
  db.prepare('UPDATE ai_service_configs SET verified_capabilities = ? WHERE id = ?')
    .run(JSON.stringify(capabilities), config.id);

  await imageService.processImageGeneration(db, log, created.id);

  assert.equal(providerCalls, 0);
  assert.equal(db.prepare('SELECT status FROM image_generations WHERE id = ?').get(created.id).status, 'failed');
  assert.equal(credits.getReservation(db, row.credit_reservation_id).status, 'refunded');
});

test('USMercari 图片明确失败完整退款且重复处理不重复退款', async (t) => {
  const { db, dramaId } = setup();
  installModel(db, 'nano-banana-2', ['1k', '2k', '4k']);
  const originalCall = imageClient.callImageApi;
  imageClient.callImageApi = async () => ({ error: 'USMercari 图片生成失败 (502): upstream rejected' });
  t.after(() => {
    imageClient.callImageApi = originalCall;
    db.close();
  });

  const created = createImage(db, dramaId, { resolution: '2k' });
  const row = db.prepare('SELECT credit_reservation_id FROM image_generations WHERE id = ?').get(created.id);
  await imageService.processImageGeneration(db, log, created.id);
  await imageService.processImageGeneration(db, log, created.id);

  assert.equal(credits.getReservation(db, row.credit_reservation_id).status, 'refunded');
  assert.deepEqual(credits.getAccount(db, 'user-1'), {
    user_id: 'user-1', available: 1000, held: 0, spent: 0,
  });
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM credit_ledger
    WHERE reservation_id = ? AND event_type = 'refund'`).get(row.credit_reservation_id).count, 1);
});

test('USMercari 图片创建结果未知时保留冻结，避免自动退款后重复提交', async (t) => {
  const { db, dramaId } = setup();
  installModel(db, 'nano-banana-2', ['1k', '2k', '4k']);
  const originalCall = imageClient.callImageApi;
  imageClient.callImageApi = async () => ({
    indeterminate: true,
    error: '连接中断，供应商可能已受理或扣费但本平台未取得结果',
  });
  t.after(() => {
    imageClient.callImageApi = originalCall;
    db.close();
  });

  const created = createImage(db, dramaId, { resolution: '1k' });
  const row = db.prepare('SELECT credit_reservation_id FROM image_generations WHERE id = ?').get(created.id);
  await imageService.processImageGeneration(db, log, created.id);

  assert.equal(credits.getReservation(db, row.credit_reservation_id).status, 'held');
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM credit_ledger
    WHERE reservation_id = ? AND event_type = 'refund'`).get(row.credit_reservation_id).count, 0);
});
