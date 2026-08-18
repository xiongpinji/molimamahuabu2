const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const catalog = require('../src/services/canvasModelCatalogService');
const prices = require('../src/services/modelPriceService');

const { parseModels, safeCapabilities, providerCapabilities } = catalog;

test('canvas model catalog parses model lists without exposing config secrets', () => {
  assert.deepEqual(parseModels('["v1","v2"]'), ['v1', 'v2']);
  assert.deepEqual(parseModels('v1,v2'), ['v1', 'v2']);
  assert.deepEqual(safeCapabilities(JSON.stringify({
    api_key: 'secret',
    canvas_capabilities: {
      durations: [5, 10],
      provider: 'private-relay',
      base_url: 'https://private-relay.example/v1',
      api_key: 'nested-secret',
      hostname: 'private-relay.example',
      domain: 'private-relay.example',
    },
  })), { durations: [5, 10] });
})

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
  insert.run(
    'private-relay-a', 'private-protocol-a', 'Private Route A', 'https://relay-a.example/v1',
    'private-key-a', JSON.stringify(['safe-public-video']), 'safe-public-video', 100,
    settings, null, now, now,
  );
  insert.run(
    'private-relay-a2', 'private-protocol-a2', 'Private Route A2', 'https://relay-a2.example/v1',
    'private-key-a2', JSON.stringify(['safe-public-video']), 'safe-public-video', 95,
    settings, null, now, now,
  );
  insert.run(
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
