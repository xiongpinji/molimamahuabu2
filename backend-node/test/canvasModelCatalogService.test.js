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

test('canvas model catalog exposes video resolution prices to the node editor', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, name, model, default_model, is_active, settings, created_at, updated_at)
    VALUES ('video', 'test', 'Resolution Video', ?, 'resolution-video', 1, ?, ?, ?)`)
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
    '480p': { credits: 2, cost_micros_per_second: 50000 },
    '720p': { credits: 5, cost_micros_per_second: 120000 },
  });
  db.close();
});

test('canvas model catalog exposes only the selected verified config identity', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  db.exec('ALTER TABLE ai_service_configs ADD COLUMN verification_status TEXT');
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
  assert.equal(item.config_id, Number(verified.lastInsertRowid));
  assert.notEqual(item.config_id, Number(unverified.lastInsertRowid));
  for (const field of ['provider', 'base_url', 'api_key', 'name', 'hostname', 'domain']) {
    assert.equal(item[field], undefined);
  }
  assert.equal(JSON.stringify(item).includes('selected-relay.example'), false);
  assert.equal(JSON.stringify(item).includes('selected-secret'), false);
  db.close();
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
    durations: [5],
    aspectRatios: ['16:9'],
    maxReferences: 4,
    maxVideoReferences: 1,
    maxAudioReferences: 1,
    supportsFirstFrame: true,
    supportsLastFrame: true,
    supportsImageReference: true,
    supportsVideoReference: true,
    supportsAudioReference: true,
    supportsAudio: true,
    resolutions: ['480p'],
  });
  assert.deepEqual(providerCapabilities('usmercari', 'seedance-2.0-fast').resolutions, ['480p', '720p']);
  assert.deepEqual(providerCapabilities('usmercari', 'seedance-2.0-mini').resolutions, ['480p', '720p']);
  assert.equal(providerCapabilities('usmercari_media', 'seedance-2.0-fast').supportsAudioReference, true);
});
