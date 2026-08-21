const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiConfigService = require('../src/services/aiConfigService');
const aiConfigRoutes = require('../src/routes/aiConfig');
const modelPriceService = require('../src/services/modelPriceService');
const catalog = require('../src/services/canvasModelCatalogService');
const prices = require('../src/services/modelPriceService');
const canvasProviderConfigService = require('../src/services/canvasProviderConfigService');
const aiConfig = require('../src/services/aiConfigService');
const { list, parseModels, safeCapabilities, providerCapabilities } = catalog;
const { evidenceRoots, withExternalModelEvidence } = require('./helpers/externalModelEvidenceFixture');
const routeCosts = require('../src/services/providerRouteCostService');

const log = { info() {}, error() {}, errorw() {} };

test('canvas model catalog parses model lists without exposing config secrets', () => {
  assert.deepEqual(parseModels('["v1","v2"]'), ['v1', 'v2']);
  assert.deepEqual(parseModels('v1,v2'), ['v1', 'v2']);
  assert.deepEqual(safeCapabilities(JSON.stringify({
    api_key: 'secret',
    canvas_capabilities: { durations: [5, 10] },
  })), { durations: [5, 10] });
});

test('画布目录自动公开配置内全部已验证且已定价模型并使用管理员前端名称', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const verified = aiConfigService.createConfig(db, log, {
    service_type: 'image',
    provider: 'openai',
    name: '图片供应商',
    base_url: 'https://image.example/v1',
    api_key: 'secret',
    model: ['image-one', 'image-two', 'image-unpriced'],
    default_model: 'image-two',
    is_active: true,
  });
  aiConfigService.setVerificationResult(db, verified.id, 'verified');
  aiConfigService.createConfig(db, log, {
    service_type: 'image',
    provider: 'openai',
    name: '未验证图片供应商',
    base_url: 'https://unverified.example/v1',
    api_key: 'secret',
    model: ['image-unverified'],
    default_model: 'image-unverified',
    is_active: true,
  });
  modelPriceService.set(db, 'image-one', 18, {
    category: 'image',
    displayName: '写实图片 Pro',
  });
  modelPriceService.set(db, 'image-two', 26, {
    category: 'image',
    displayName: '角色一致性 Max',
  });
  modelPriceService.set(db, 'image-unverified', 30, { category: 'image' });

  assert.deepEqual(
    list(db, { evidenceRoots }).filter((item) => item.kind === 'image').map((item) => ({
      model: item.model,
      label: item.label,
      credits: item.credits,
    })),
    [
      { model: 'image-two', label: '角色一致性 Max', credits: 26 },
      { model: 'image-one', label: '写实图片 Pro', credits: 18 },
    ],
  );
});

test('canvas model catalog exposes video resolution prices to the node editor', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, name, model, default_model, is_active, verification_status, settings, created_at, updated_at)
    VALUES ('video', 'test', 'Resolution Video', ?, 'resolution-video', 1, 'verified', ?, ?, ?)`)
    .run(JSON.stringify(['resolution-video']), JSON.stringify({
      canvas_capabilities: { resolutions: ['480p', '720p'] },
    }), now, now);
  prices.set(db, 'resolution-video', 2, {
    category: 'video',
    resolution_prices: {
      '480p': { credits: 2, cost_micros_per_second: 50000 },
      '720p': { credits: 5, cost_micros_per_second: 120000 },
    },
  });

  const item = catalog.list(db, { evidenceRoots }).find((row) => row.model === 'resolution-video');
  assert.deepEqual(item.resolution_prices, {
    '480p': { credits: 2 },
    '720p': { credits: 5 },
  });
  assert.equal(/cost/i.test(JSON.stringify(item)), false);
  db.close();
});

test('Token6688 画布目录按模型公开图片参考上限和 Seedance 9/3/9 能力', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);

  const imageConfig = aiConfigService.createConfig(db, log, {
    service_type: 'image',
    provider: 'token6688',
    api_protocol: 'token6688',
    name: 'Token6688 图片',
    base_url: 'https://qd.token6688.com',
    api_key: 'secret',
    model: ['doubao-seedream-5-0', 'token6688-gpt-image-2', 'gemini-3-pro-image'],
    default_model: 'token6688-gpt-image-2',
    settings: JSON.stringify({
      real_generation_verified_models: ['doubao-seedream-5-0', 'token6688-gpt-image-2', 'gemini-3-pro-image'],
    }),
  });
  const existingGptImageConfig = aiConfigService.createConfig(db, log, {
    service_type: 'image',
    provider: 'openai',
    api_protocol: 'openai',
    name: '现有 GPT Image 2 供应商',
    base_url: 'https://image.example/v1',
    api_key: 'secret',
    model: ['gpt-image-2'],
    default_model: 'gpt-image-2',
  });
  const videoConfig = aiConfigService.createConfig(db, log, {
    service_type: 'video',
    provider: 'token6688',
    api_protocol: 'token6688',
    name: 'Token6688 视频',
    base_url: 'https://qd.token6688.com',
    api_key: 'secret',
    model: ['seedance-2-0-special-mini-720p', 'seedance-2-0-special-fast-720p', 'seedance-2-0-special-full-720p'],
    default_model: 'seedance-2-0-special-mini-720p',
    settings: JSON.stringify({
      real_generation_verified_models: ['seedance-2-0-special-mini-720p', 'seedance-2-0-special-fast-720p', 'seedance-2-0-special-full-720p'],
    }),
  });
  const connectionOnlyConfig = aiConfigService.createConfig(db, log, {
    service_type: 'image',
    provider: 'token6688',
    api_protocol: 'token6688',
    name: '仅连接验证配置',
    base_url: 'https://qd.token6688.com',
    api_key: 'secret',
    model: ['token6688-unverified-image'],
    default_model: 'token6688-unverified-image',
  });
  aiConfigService.setVerificationResult(db, imageConfig.id, 'verified');
  aiConfigService.setVerificationResult(db, existingGptImageConfig.id, 'verified');
  aiConfigService.setVerificationResult(db, videoConfig.id, 'verified');
  aiConfigService.setVerificationResult(db, connectionOnlyConfig.id, 'verified');
  for (const [model, category, credits] of [
    ['doubao-seedream-5-0', 'image', 60],
    ['gpt-image-2', 'image', 40],
    ['token6688-gpt-image-2', 'image', 60],
    ['gemini-3-pro-image', 'image', 60],
    ['seedance-2-0-special-mini-720p', 'video', 650],
    ['seedance-2-0-special-fast-720p', 'video', 960],
    ['seedance-2-0-special-full-720p', 'video', 2120],
    ['token6688-unverified-image', 'image', 1],
  ]) modelPriceService.set(db, model, credits, { category });

  const entries = list(db);
  assert.equal(entries.filter((item) => ['gpt-image-2', 'token6688-gpt-image-2'].includes(item.model)).length, 2);
  assert.equal(entries.some((item) => item.model === 'token6688-unverified-image'), false);
  assert.equal(entries.find((item) => item.model === 'doubao-seedream-5-0').capabilities.maxReferences, 3);
  assert.equal(entries.find((item) => item.model === 'token6688-gpt-image-2').capabilities.maxReferences, 9);
  assert.equal(entries.find((item) => item.model === 'gemini-3-pro-image').capabilities.maxReferences, 3);
  assert.deepEqual(
    entries
      .filter((item) => ['doubao-seedream-5-0', 'token6688-gpt-image-2', 'gemini-3-pro-image'].includes(item.model))
      .map((item) => item.credits),
    [60, 60, 60],
  );
  assert.equal(entries.some((item) => item.model === 'seedance-2-0-special-mini-720p'), true);
  const video = entries.find((item) => item.model === 'seedance-2-0-special-fast-720p');
  assert.deepEqual(video.capabilities.referenceTypes, ['image', 'video', 'audio']);
  assert.equal(video.capabilities.maxImageReferences, 9);
  assert.equal(video.capabilities.maxVideoReferences, 3);
  assert.equal(video.capabilities.maxAudioReferences, 9);
  assert.deepEqual(video.capabilities.durations, [15]);
  assert.deepEqual(video.capabilities.resolutions, ['720p']);

  const publicPrices = modelPriceService.listPublic(db);
  assert.equal(publicPrices.some((item) => item.model === 'token6688-unverified-image'), false);
  assert.equal(publicPrices.some((item) => item.model === 'seedance-2-0-special-mini-720p'), true);
  assert.equal(publicPrices.some((item) => item.model === 'seedance-2-0-special-fast-720p'), true);

  let imageRoutePayload;
  aiConfigRoutes(db, log, {}).listPublicImageModels({}, {
    status() { return this; },
    json(payload) { imageRoutePayload = payload; return this; },
  });
  assert.equal(imageRoutePayload.data.includes('token6688-unverified-image'), false);
  assert.equal(imageRoutePayload.data.includes('token6688-gpt-image-2'), true);
});

test('USMercari 图片目录只公开有 Key、已验证且所有验证档位已定价的模型', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const capabilities = {
    'gpt-image-2-2-4k': withExternalModelEvidence('gpt-image-2-2-4k', {
      supportsTextToImage: true, supportsImageReference: true, maxReferences: 6,
      resolutions: ['1k', '2k'],
    }),
    'nano-banana-2': withExternalModelEvidence('nano-banana-2', {
      supportsTextToImage: true, supportsImageReference: true, maxReferences: 6,
      resolutions: ['1k', '2k', '4k'],
    }),
  };
  db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
     is_active, verification_status, verified_capabilities, created_at, updated_at)
    VALUES ('image', 'usmercari_image', 'usmercari_image', 'USMercari 图片',
      'https://chat-ai.mercarimx.com', 'secret', ?, 'gpt-image-2-2-4k', 1, 'verified', ?, ?, ?)`)
    .run(JSON.stringify(Object.keys(capabilities)), JSON.stringify(capabilities), now, now);
  modelPriceService.set(db, 'gpt-image-2-2-4k', 70, {
    category: 'image', display_name: 'GPT Image 2', public_note: '稳定高精度，支持参考图',
    resolution_prices: {
      '1k': { credits: 70, cost_micros_per_unit: 80000 },
      '2k': { credits: 87, cost_micros_per_unit: 100000 },
    },
  });

  let models = list(db, { evidenceRoots });
  const gpt = models.find((item) => item.model === 'gpt-image-2-2-4k');
  assert.equal(gpt.label, 'GPT Image 2');
  assert.equal(gpt.public_note, '稳定高精度，支持参考图');
  assert.equal(gpt.verification_status, 'verified');
  assert.deepEqual(gpt.capabilities.resolutions, ['1k', '2k']);
  assert.equal(gpt.capabilities.resolutions.includes('4k'), false);
  assert.equal(models.some((item) => item.model === 'nano-banana-2'), false);

  modelPriceService.set(db, 'nano-banana-2', 70, {
    category: 'image', display_name: 'Nano Banana 2', public_note: '支持最高 4K',
    resolution_prices: {
      '1k': { credits: 70, cost_micros_per_unit: 80000 },
      '2k': { credits: 87, cost_micros_per_unit: 100000 },
      '4k': { credits: 105, cost_micros_per_unit: 120000 },
    },
  });
  models = list(db, { evidenceRoots });
  const nano = models.find((item) => item.model === 'nano-banana-2');
  assert.deepEqual(nano.capabilities.resolutions, ['1k', '2k', '4k']);
  assert.deepEqual(nano.resolution_prices['4k'], { credits: 105 });
  assert.equal(/cost/i.test(JSON.stringify(nano)), false);
  db.close();
});

test('灵境目录只公开专用协议、可信证据和基础按秒价格且无需伪造分辨率档', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const capabilities = withExternalModelEvidence('lingjing-video-v1', {
    declared: true,
    referenceTypes: ['image'],
    maxReferences: 9,
    maxImageReferences: 9,
    maxVideoReferences: 0,
    maxAudioReferences: 0,
    supportsImageReference: true,
    supportsFirstFrame: false,
    supportsLastFrame: false,
    supportsVideoReference: false,
    supportsAudioReference: false,
    supportsAudio: false,
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    resolutions: [],
    durations: [4, 5, 6, 8, 10, 11, 15],
    quantities: [1],
  });
  const insert = db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
     is_active, verification_status, verified_capabilities, created_at, updated_at)
    VALUES ('video', ?, ?, ?, ?, 'secret', ?, 'lingjing-video-v1', 1, ?, ?, ?, ?)`);
  insert.run('xai', 'xai', '错误同名配置', 'https://seed.alimyun.xyz/api/open/v1',
    JSON.stringify(['lingjing-video-v1']), 'verified', JSON.stringify({ 'lingjing-video-v1': capabilities }), now, now);
  insert.run('lingjing', 'lingjing_open', '灵境专用配置', 'https://seed.alimyun.xyz/api/open/v1',
    JSON.stringify(['lingjing-video-v1']), 'verified', JSON.stringify({ 'lingjing-video-v1': capabilities }), now, now);
  modelPriceService.set(db, 'lingjing-video-v1', 69, {
    category: 'video', display_name: '灵境 Seedance 2.0 Fast（9 图参考）',
    public_note: '最多 9 张非真人参考图', billing_unit: 'second',
    cost_unit: 'second', cost_micros_per_unit: 180000,
  });

  const entries = list(db, { evidenceRoots }).filter((item) => item.model === 'lingjing-video-v1');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].protocol, undefined);
  assert.equal(entries[0].label, '灵境 Seedance 2.0 Fast（9 图参考）');
  assert.equal(entries[0].public_note, '最多 9 张非真人参考图');
  assert.deepEqual(entries[0].resolution_prices, {});
  const { evidence_contract: _contract, evidence_sha256: _sha, ...publicCapabilities } = capabilities;
  assert.deepEqual(entries[0].capabilities, publicCapabilities);

  const publicPrices = modelPriceService.listPublic(db, { evidenceRoots })
    .filter((item) => item.model === 'lingjing-video-v1');
  assert.equal(publicPrices.length, 1);
  assert.deepEqual(publicPrices[0].resolution_prices, {});
});

test('USMercari 图片目录识别专用环境 Key，canvas 与 billing Key 门禁一致', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const previousImageKey = process.env.USMERCARI_IMAGE_API_KEY;
  const previousGenericKey = process.env.USMERCARI_API_KEY;
  delete process.env.USMERCARI_API_KEY;
  process.env.USMERCARI_IMAGE_API_KEY = 'env-image-key';
  try {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO ai_service_configs
      (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
       is_active, verification_status, verified_capabilities, created_at, updated_at)
      VALUES ('image', 'usmercari_image', 'usmercari_image', 'USMercari 图片',
        'https://chat-ai.mercarimx.com', '', ?, 'gpt-image-2-2-4k', 1, 'verified', ?, ?, ?)`)
      .run(JSON.stringify(['gpt-image-2-2-4k']), JSON.stringify({
        'gpt-image-2-2-4k': withExternalModelEvidence('gpt-image-2-2-4k', {
          supportsTextToImage: true,
          supportsImageReference: true,
          maxReferences: 1,
          resolutions: ['1k', '2k'],
        }),
      }), now, now);
    modelPriceService.set(db, 'gpt-image-2-2-4k', 70, {
      category: 'image',
      resolution_prices: {
        '1k': { credits: 70, cost_micros_per_unit: 80000 },
        '2k': { credits: 87, cost_micros_per_unit: 100000 },
      },
    });
    assert.equal(list(db, { evidenceRoots }).some((item) => item.model === 'gpt-image-2-2-4k'), true);
  } finally {
    if (previousImageKey === undefined) delete process.env.USMERCARI_IMAGE_API_KEY;
    else process.env.USMERCARI_IMAGE_API_KEY = previousImageKey;
    if (previousGenericKey === undefined) delete process.env.USMERCARI_API_KEY;
    else process.env.USMERCARI_API_KEY = previousGenericKey;
    db.close();
  }
});

test('新增真实验证列不会隐藏已验证且已定价的既有非 USMercari 图片模型', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, name, base_url, api_key, model, is_active,
     verification_status, created_at, updated_at)
    VALUES ('image', 'openai', 'Existing Image', 'https://example.invalid', 'secret', ?, 1,
      'verified', ?, ?)`)
    .run(JSON.stringify(['existing-image']), now, now);
  modelPriceService.set(db, 'existing-image', 12, { category: 'image' });
  assert.equal(list(db, { evidenceRoots }).some((item) => item.model === 'existing-image'), true);
  db.close();
});

test('ToAPIs 视频目录同时要求启用、真实验证、凭据、模型能力和完整公开档位价格', () => {
  const db = new Database(':memory:');
  const previousKey = process.env.TOAPIS_API_KEY;
  delete process.env.TOAPIS_API_KEY;
  runMigrationsAndEnsure(db);
  try {
    const now = new Date().toISOString();
    const capabilities = {
      'seedance-2-fast': withExternalModelEvidence('seedance-2-fast', {
        durations: [4, 5, 6, 99],
        resolutions: ['480P', '720p', '1080p'],
        maxReferences: 1,
        supportsImageReference: true,
      }),
    };
    db.prepare(`INSERT INTO ai_service_configs
      (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
       is_active, verification_status, verified_capabilities, settings, created_at, updated_at)
      VALUES ('video', 'toapis', 'toapis_video', 'ToAPIs 视频', 'https://toapis.com', '', ?,
        'seedance-2-fast', 1, 'pending', ?, ?, ?, ?)`)
      .run(JSON.stringify(['seedance-2-fast']), JSON.stringify(capabilities), JSON.stringify({
        canvas_capabilities: { durations: [99], maxReferences: 99, unsafeFallback: true },
      }), now, now);
    prices.set(db, 'seedance-2-fast', 511, {
      category: 'video',
      status: 'enabled',
      resolution_prices: {
        '480p': { credits: 511, cost_micros_per_second: 584000 },
      },
    });

    const toapisItems = () => catalog.list(db, { evidenceRoots })
      .filter((item) => item.kind === 'video' && item.model === 'seedance-2-fast');
    assert.deepEqual(toapisItems(), []);

    db.prepare("UPDATE ai_service_configs SET api_key = 'stored-key' WHERE provider = 'toapis'").run();
    assert.deepEqual(toapisItems(), []);

    db.prepare("UPDATE ai_service_configs SET verification_status = 'verified' WHERE provider = 'toapis'").run();
    assert.deepEqual(toapisItems(), []);

    prices.set(db, 'seedance-2-fast', 511, {
      category: 'video',
      status: 'disabled',
      resolution_prices: {
        '480p': { credits: 511, cost_micros_per_second: 584000 },
        '720p': { credits: 511, cost_micros_per_second: 584000 },
      },
    });
    assert.deepEqual(toapisItems(), []);

    prices.set(db, 'seedance-2-fast', 511, {
      category: 'video',
      status: 'enabled',
      resolution_prices: {
        '480p': { credits: 511, cost_micros_per_second: 584000 },
        '720p': { credits: 511, cost_micros_per_second: 584000 },
      },
    });
    const [item] = toapisItems();
    assert.equal(item.model, 'seedance-2-fast');
    assert.deepEqual(item.capabilities, {
      durations: [4, 5, 6],
      resolutions: ['480p', '720p'],
      maxReferences: 1,
      supportsImageReference: true,
    });
    assert.deepEqual(Object.keys(item.resolution_prices), ['480p', '720p']);

    db.prepare("UPDATE ai_service_configs SET api_key = '' WHERE provider = 'toapis'").run();
    assert.deepEqual(toapisItems(), []);

    db.prepare("UPDATE ai_service_configs SET api_key = 'stored-key', verified_capabilities = ? WHERE provider = 'toapis'")
      .run(JSON.stringify({
        'seedance-2-fast': { resolutions: ['480p', '720p'], maxReferences: 1 },
      }));
    assert.deepEqual(toapisItems(), []);
  } finally {
    if (previousKey === undefined) delete process.env.TOAPIS_API_KEY;
    else process.env.TOAPIS_API_KEY = previousKey;
    db.close();
  }
});

test('ToAPIs Mini 目录时长只发布验证证据与官方模型矩阵的交集', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
     is_active, verification_status, verified_capabilities, created_at, updated_at)
    VALUES ('video', 'toapis', 'toapis_video', 'ToAPIs Mini', 'https://toapis.com', 'stored-key', ?,
      'seedance-2-mini', 1, 'verified', ?, ?, ?)`)
    .run(JSON.stringify(['seedance-2-mini']), JSON.stringify({
      'seedance-2-mini': withExternalModelEvidence('seedance-2-mini', {
        durations: [99, 15, 12, 10, 8, 5, 4],
        resolutions: ['480p'],
        supportsImageReference: false,
      }),
    }), now, now);
  prices.set(db, 'seedance-2-mini', 294, {
    category: 'video',
    resolution_prices: {
      '480p': { credits: 294, cost_micros_per_second: 335800 },
    },
  });

  const item = catalog.list(db, { evidenceRoots }).find((row) => row.model === 'seedance-2-mini');
  assert.deepEqual(item.capabilities, {
    durations: [4, 8, 10, 12, 15],
    resolutions: ['480p'],
    supportsImageReference: false,
  });
  db.close();
});

test('受保护环境 Key 是有效 credential，但 pending ToAPIs 仍阻断同模型 generic 配置', () => {
  const db = new Database(':memory:');
  const previousKey = process.env.TOAPIS_API_KEY;
  process.env.TOAPIS_API_KEY = 'protected-env-key';
  runMigrationsAndEnsure(db);
  try {
    const now = new Date().toISOString();
    const insert = db.prepare(`INSERT INTO ai_service_configs
      (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
       is_active, verification_status, verified_capabilities, created_at, updated_at)
      VALUES ('video', ?, ?, ?, ?, ?, ?, 'seedance-2-fast', 1, ?, ?, ?, ?)`);
    insert.run('openai', 'openai', 'Generic Video', 'https://example.invalid', 'generic-key',
      JSON.stringify(['seedance-2-fast']), 'verified', '{}', now, now);
    insert.run('toapis', 'toapis_video', 'ToAPIs Video', 'https://toapis.com', '',
      JSON.stringify([]), 'pending', JSON.stringify({
        'seedance-2-fast': { durations: [4, 5], resolutions: ['480p', '720p'] },
      }), now, now);
    prices.set(db, 'seedance-2-fast', 511, {
      category: 'video',
      resolution_prices: {
        '480p': { credits: 511, cost_micros_per_second: 584000 },
        '720p': { credits: 511, cost_micros_per_second: 584000 },
      },
    });

    const strictConfig = aiConfig.listConfigs(db, 'video').find((config) => config.provider === 'toapis');
    assert.equal(aiConfig.hasConnectionCredential(strictConfig), true);
    assert.deepEqual(catalog.list(db, { evidenceRoots }).filter((item) => item.kind === 'video'
      && item.model === 'seedance-2-fast'), []);
  } finally {
    if (previousKey === undefined) delete process.env.TOAPIS_API_KEY;
    else process.env.TOAPIS_API_KEY = previousKey;
    db.close();
  }
});

test('pending ToAPIs strict key 阻止 canvas provider fallback 重新注入同模型', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const originalListSafe = canvasProviderConfigService.listSafe;
  try {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO ai_service_configs
      (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
       is_active, verification_status, verified_capabilities, created_at, updated_at)
      VALUES ('video', 'toapis', 'toapis_video', 'ToAPIs Video', 'https://toapis.com', 'stored-key', ?,
        'seedance-2-fast', 1, 'pending', ?, ?, ?)`)
      .run(JSON.stringify(['seedance-2-fast']), JSON.stringify({
        'seedance-2-fast': { durations: [4, 5], resolutions: ['480p', '720p'] },
      }), now, now);
    prices.set(db, 'seedance-2-fast', 511, {
      category: 'video',
      resolution_prices: {
        '480p': { credits: 511, cost_micros_per_second: 584000 },
        '720p': { credits: 511, cost_micros_per_second: 584000 },
      },
    });
    canvasProviderConfigService.listSafe = () => [{
      kind: 'video', model: 'seedance-2-fast', label: 'Unsafe fallback', capabilities: { durations: [5] },
    }];

    assert.deepEqual(catalog.list(db, { evidenceRoots }).filter((item) => item.kind === 'video'
      && item.model === 'seedance-2-fast'), []);
  } finally {
    canvasProviderConfigService.listSafe = originalListSafe;
    db.close();
  }
});

test('canvas model catalog preserves public capability names while removing relay metadata', () => {
  assert.deepEqual(safeCapabilities(JSON.stringify({
    canvas_capabilities: {
      presets: [{
        id: 'p1',
        name: 'Public Preset',
        value: 'x',
        provider: 'private-relay',
        base_url: 'https://private-relay.example/v1',
        baseUrl: 'https://camel-private-relay.example/v1',
        api_key: 'nested-secret',
        apiKey: 'camel-nested-secret',
        accessToken: 'access-secret',
        refreshToken: 'refresh-secret',
        sessionToken: 'session-secret',
        token: 'token-secret',
        secret: 'plain-secret',
        secretKey: 'key-secret',
        secret_access_key: 'secret-access-key',
        klingSecretKey: 'kling-secret-key',
        access_key_id: 'access-key-id',
        databaseCredential: 'database-credential',
        password: 'password-secret',
        hostname: 'private-relay.example',
        domain: 'private-relay.example',
        keyboardShortcut: 'Ctrl+K',
      }],
    },
  })), {
    presets: [{ id: 'p1', name: 'Public Preset', value: 'x', keyboardShortcut: 'Ctrl+K' }],
  });
})

test('canvas capability sanitizer recursively rejects composed identity fields in every key style', () => {
  const capabilities = safeCapabilities(JSON.stringify({
    canvas_capabilities: {
      durations: [5, 10],
      resolutions: ['480p', '720p'],
      aspectRatios: ['16:9'],
      maxReferences: 3,
      supportsImageReference: true,
      providerName: 'private-provider-name',
      provider_name: 'private-provider-snake',
      'provider-id': 'private-provider-kebab',
      providerId: 'private-provider-id',
      providerCode: 'private-provider-code',
      modelProvider: 'private-model-provider',
      configName: 'private-config-name',
      configId: 998,
      upstreamProvider: 'private-upstream-provider',
      upstreamModel: 'private-upstream-model',
      protocolName: 'private-protocol-name',
      'ProViDeR.Name': 'private-provider-mixed',
      nested: [{
        publicFlag: true,
        ENDPOINT_URL: 'https://private-endpoint.example/v1',
        deeper: {
          providerName: 'private-deep-provider',
          config_name: 'private-deep-config',
          upstream_provider: 'private-deep-upstream',
          protocolName: 'private-deep-protocol',
        },
      }],
      presets: [{
        id: 'public-preset',
        name: 'Public Preset',
        value: 'public-value',
        keyboardShortcut: 'Ctrl+K',
        publicFlag: true,
        modelProvider: 'private-preset-provider',
      }],
    },
  }));

  assert.deepEqual(capabilities, {
    durations: [5, 10],
    resolutions: ['480p', '720p'],
    aspectRatios: ['16:9'],
    maxReferences: 3,
    supportsImageReference: true,
    nested: [{ publicFlag: true, deeper: {} }],
    presets: [{
      id: 'public-preset',
      name: 'Public Preset',
      value: 'public-value',
      keyboardShortcut: 'Ctrl+K',
      publicFlag: true,
    }],
  });
  const serialized = JSON.stringify(capabilities);
  for (const privateKey of [
    'providerName', 'provider_name', 'provider-id', 'providerId', 'providerCode', 'modelProvider',
    'configName', 'configId', 'upstreamProvider', 'upstreamModel', 'protocolName',
    'ProViDeR.Name', 'ENDPOINT_URL', 'config_name', 'upstream_provider',
  ]) assert.equal(serialized.includes(privateKey), false, privateKey);
  assert.equal(serialized.includes('private-'), false);
});

test('canvas model catalog exposes only user video resolution prices to the node editor', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, name, model, default_model, is_active, settings,
      verification_status, created_at, updated_at)
    VALUES ('video', 'test', 'Resolution Video', ?, 'resolution-video', 1, ?, 'verified', ?, ?)`)
    .run(JSON.stringify(['resolution-video']), JSON.stringify({
      canvas_capabilities: { resolutions: ['480p', '720p'] },
    }), now, now);
  prices.set(db, 'resolution-video', 2, {
    category: 'video',
    resolution_prices: {
      '480p': { credits: 2, cost_micros_per_second: 50000 },
      '720p': { credits: 5, cost_micros_per_second: 120000 },
    },
  });

  const item = catalog.list(db).find((row) => row.model === 'resolution-video');
  assert.deepEqual(item.resolution_prices, {
    '480p': { credits: 2 },
    '720p': { credits: 5 },
  });
  assert.equal(/cost/i.test(JSON.stringify(item.resolution_prices)), false);
  db.close();
});

test('canvas model catalog selects a verified config without exposing its identity', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const insert = db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, name, base_url, api_key, model, default_model, priority,
      is_default, is_active, settings, verification_status, created_at, updated_at)
    VALUES ('storyboard_image', ?, ?, ?, ?, ?, ?, ?, ?, 1, '{}', ?, ?, ?)`);
  const unverified = insert.run(
    'private-relay',
    'Unverified Relay',
    'https://unverified-relay.example/v1',
    'unverified-secret',
    JSON.stringify(['catalog-route-image']),
    'catalog-route-image',
    100,
    1,
    'failed',
    now,
    now,
  );
  const verified = insert.run(
    'selected-relay',
    'Selected Relay',
    'https://selected-relay.example/v1',
    'selected-secret',
    JSON.stringify(['catalog-route-image']),
    'catalog-route-image',
    10,
    0,
    'verified',
    now,
    now,
  );
  prices.set(db, 'catalog-route-image', 40, { category: 'image' });

  const item = catalog.list(db).find((row) => row.model === 'catalog-route-image');
  assert.equal(item.config_id, undefined);
  assert.equal(item.upstream_model, undefined);
  assert.notEqual(Number(verified.lastInsertRowid), Number(unverified.lastInsertRowid));
  for (const field of ['provider', 'protocol', 'base_url', 'api_key', 'name', 'hostname', 'domain']) {
    assert.equal(item[field], undefined);
  }
  assert.equal(JSON.stringify(item).includes('selected-relay.example'), false);
  assert.equal(JSON.stringify(item).includes('selected-secret'), false);
  db.close();
});

test('canvas public items hide route, relay, evidence, and cost metadata for logical and non-logical models', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const settings = JSON.stringify({
    canvas_capabilities: {
      durations: [5, 10],
      protocol: 'private-capability-protocol',
      config_id: 991,
      relay_url: 'https://nested-relay.example/v1',
      evidence_sha256: 'private-evidence-sha',
      cost_micros_per_second: 70000,
      nested: {
        base_url: 'https://nested-base.example/v1',
        provider: 'nested-private-provider',
        publicFlag: true,
      },
    },
  });
  const insert = db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
     priority, is_active, settings, logical_model_id, verification_status, created_at, updated_at)
    VALUES ('video', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'verified', ?, ?)`);
  const routeA = insert.run(
    'private-relay-a', 'private-protocol-a', 'Private Route A', 'https://relay-a.example/v1',
    'private-key-a', JSON.stringify(['safe-public-video']), 'safe-public-video', 100,
    settings, null, now, now,
  );
  const routeA2 = insert.run(
    'private-relay-a2', 'private-protocol-a2', 'Private Route A2', 'https://relay-a2.example/v1',
    'private-key-a2', JSON.stringify(['safe-public-video']), 'safe-public-video', 95,
    settings, null, now, now,
  );
  const routeB = insert.run(
    'private-relay-b', 'private-protocol-b', 'Private Route B', 'https://relay-b.example/v1',
    'private-key-b', JSON.stringify(['private-upstream-video']), 'private-upstream-video', 90,
    settings, 'logical-public-video', now, now,
  );
  for (const model of ['safe-public-video', 'logical-public-video']) {
    prices.set(db, model, 4, {
      category: 'video',
      cost_unit: 'second',
      cost_micros_per_unit: 80000,
      resolution_prices: {
        '480p': { credits: 4, cost_micros_per_second: 50000 },
        '720p': { credits: 7, cost_micros_per_second: 110000 },
      },
    });
  }
  for (const configId of [routeA.lastInsertRowid, routeA2.lastInsertRowid, routeB.lastInsertRowid]) {
    routeCosts.setRouteCost(db, Number(configId), {
      currency: 'CNY',
      cost_unit: 'second',
      micros_per_unit: 91001,
      resolution_prices: {
        '480p': { micros_per_unit: 52001 },
        '720p': { micros_per_unit: 121001 },
      },
    });
  }

  const items = catalog.list(db).filter((row) => (
    row.model === 'safe-public-video' || row.model === 'logical-public-video'
  ));
  assert.equal(items.length, 2);
  for (const item of items) {
    assert.deepEqual(Object.keys(item).sort(), [
      'billing_unit', 'capabilities', 'credits', 'default_voice_id', 'kind', 'label', 'model',
      'public_note', 'resolution_prices', 'verification_status',
    ]);
    assert.deepEqual(item.resolution_prices, {
      '480p': { credits: 4 },
      '720p': { credits: 7 },
    });
    assert.deepEqual(item.capabilities.durations, [5, 10]);
    assert.deepEqual(item.capabilities.nested, { publicFlag: true });
  }
  const serialized = JSON.stringify(items);
  for (const privateKey of [
    '"provider"', '"protocol"', '"config_id"', '"upstream_model"', '"base_url"',
    '"relay_url"', '"evidence_sha256"', '"cost_micros_per_second"',
    '"micros_per_unit"', '"input_cost_micros_per_1k"', '"output_cost_micros_per_1k"',
  ]) assert.equal(serialized.includes(privateKey), false, privateKey);
  for (const privateValue of [
    'private-relay', 'private-protocol', 'private-upstream-video', 'private-key', 'cfg-',
    'relay-a.example', 'relay-a2.example', 'relay-b.example', 'nested-relay.example', 'nested-base.example',
    'private-evidence-sha',
  ]) assert.equal(serialized.includes(privateValue), false, privateValue);
  db.close();
});

test('canvas model catalog exposes one logical model without supplier config identity', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const insert = db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, name, model, default_model, priority, is_active, settings,
     logical_model_id, failover_enabled, verification_status, created_at, updated_at)
    VALUES ('image', ?, ?, ?, ?, ?, 1, ?, 'logical-canvas-image', ?, 'verified', ?, ?)`);
  const settings = JSON.stringify({ canvas_capabilities: { aspectRatios: ['16:9'] } });
  insert.run('relay-a', 'Relay A', JSON.stringify(['upstream-a']), 'upstream-a', 100, settings, 0, now, now);
  insert.run('relay-b', 'Relay B', JSON.stringify(['upstream-b']), 'upstream-b', 90, settings, 1, now, now);
  prices.set(db, 'logical-canvas-image', 40, { category: 'image' });

  const items = catalog.list(db).filter((row) => row.model === 'logical-canvas-image');
  assert.equal(items.length, 1);
  assert.equal(items[0].config_id, undefined);
  assert.equal(items[0].credits, 40);
  assert.deepEqual(items[0].capabilities, { aspectRatios: ['16:9'] });
  assert.equal(JSON.stringify(items[0]).includes('relay-'), false);
  assert.equal(JSON.stringify(items[0]).includes('upstream-'), false);
  db.close();
});

test('verified catalog excludes environment fallbacks while legacy schema keeps them', () => {
  const keys = ['CANVAS_IMAGE_API_KEY', 'CANVAS_IMAGE_MODEL', 'CANVAS_IMAGE_BASE_URL'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let verifiedDb;
  let legacyDb;
  try {
    process.env.CANVAS_IMAGE_API_KEY = 'environment-fallback-secret';
    process.env.CANVAS_IMAGE_MODEL = 'environment-fallback-image';
    process.env.CANVAS_IMAGE_BASE_URL = 'https://environment-fallback.example/v1';

    verifiedDb = new Database(':memory:');
    runMigrationsAndEnsure(verifiedDb);
    assert.equal(catalog.list(verifiedDb).some((row) => row.model === 'environment-fallback-image'), false);

    legacyDb = new Database(':memory:');
    runMigrationsAndEnsure(legacyDb);
    legacyDb.exec('ALTER TABLE ai_service_configs DROP COLUMN verification_status');
    assert.equal(catalog.list(legacyDb).some((row) => row.model === 'environment-fallback-image'), true);
  } finally {
    verifiedDb?.close();
    legacyDb?.close();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('canvas model catalog applies per-model capabilities without exposing 1080p', () => {
  const settings = JSON.stringify({
    canvas_capabilities: { durations: [5], aspectRatios: ['16:9'] },
    canvas_capabilities_by_model: {
      'MiniMax H3': { resolutions: ['480p'] },
      'seedance-2.0-fast': { resolutions: ['480p', '720p'] },
      'seedance-2.0-mini': { resolutions: ['480p', '720p'] },
    },
  });

  assert.deepEqual(safeCapabilities(settings, 'MiniMax H3'), {
    durations: [5], aspectRatios: ['16:9'], resolutions: ['480p'],
  });
  assert.deepEqual(safeCapabilities(settings, 'seedance-2.0-fast'), {
    durations: [5], aspectRatios: ['16:9'], resolutions: ['480p', '720p'],
  });
  assert.equal(safeCapabilities(settings, 'seedance-2.0-mini').resolutions.includes('1080p'), false);
});

test('USMercari 三模型目录声明真实参考图、参考视频和参考音频能力', () => {
  assert.deepEqual(providerCapabilities('usmercari', 'MiniMax H3'), {
    durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    aspectRatios: ['16:9'],
    maxReferences: 3,
    maxImageReferences: 3,
    maxVideoReferences: 0,
    maxAudioReferences: 3,
    supportsFirstFrame: true,
    supportsLastFrame: true,
    supportsImageReference: true,
    supportsVideoReference: false,
    supportsAudioReference: true,
    supportsAudio: true,
    resolutions: ['1440p'],
  });
  assert.deepEqual(providerCapabilities('usmercari', 'seedance-2.0-fast').resolutions, ['480p', '720p']);
  assert.deepEqual(providerCapabilities('usmercari', 'seedance-2.0-mini').resolutions, ['480p', '720p']);
  assert.equal(providerCapabilities('usmercari_media', 'seedance-2.0-fast').supportsAudioReference, true);
});
