const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const realAssetService = require('../src/services/assetService');
const redrawAssetService = require('../src/services/redrawAssetService');
const { createRedrawProviderAdapters } = require('../src/services/redrawProviderAdapters');

function createLog() {
  return { info() {}, warn() {}, error() {} };
}

function tempStorage() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-adapters-'));
}

function makeReadableFile(root, rel, contents = 'x') {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
  return rel.replace(/\\/g, '/');
}

function setupAssetContractState() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const storageRoot = tempStorage();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO redraw_projects
    (tenant_id, user_id, title, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', 'Project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO assets
    (id, name, type, category, url, local_path, mime_type, width, height, created_at, updated_at)
    VALUES (101, 'source', 'image', 'source', '', 'source.png', 'image/png', 640, 360, ?, ?)`).run(now, now);
  makeReadableFile(storageRoot, 'source.png', 'png');
  db.prepare(`INSERT INTO redraw_works
    (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms, created_at, updated_at)
    VALUES (1, 'tenant-a', 'user-a', 'Work', 101, ?, 15000, ?, ?)`).run('f'.repeat(64), now, now);
  const workId = db.prepare('SELECT id FROM redraw_works LIMIT 1').get().id;
  db.prepare(`INSERT INTO redraw_versions
    (work_id, tenant_id, user_id, version, locale, market, source_facts_json, facts_hash, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 1, 'en-US', 'US', '{}', 'facts', 'asset_review', ?, ?)`)
    .run(workId, now, now);
  const versionId = db.prepare('SELECT id FROM redraw_versions LIMIT 1').get().id;
  const ctx = {
    db,
    versionId,
    tenantId: 'tenant-a',
    userId: 'user-a',
    allowUnmaterializedDraft: true,
    assetReader: {
      canRead(asset) {
        return Boolean(asset?.local_path && fs.existsSync(path.join(storageRoot, asset.local_path)));
      },
    },
  };
  return { db, storageRoot, versionId, ctx };
}

test('localize calls text client with verified model and parses JSON result', async () => {
  const calls = [];
  const expected = { shots: [{ id: 's1', timing_ms: 1200, speaker: 'A' }] };
  const adapters = createRedrawProviderAdapters({
    db: { tag: 'db' },
    log: createLog(),
    cfg: {},
    aiClient: {
      async generateText(...args) {
        calls.push(args);
        return JSON.stringify(expected);
      },
    },
  });

  const result = await adapters.localize({
    taskId: 123,
    model: 'verified-text-model',
    locale: 'en-US',
    market: 'US',
    input: {
      source_facts_hash: 'facts-hash',
      source_facts: { shots: [] },
    },
  });

  assert.equal(result.provider_task_id, null);
  assert.deepEqual(result.result, expected);
  assert.equal(result.model, 'verified-text-model');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], 'text');
  assert.match(calls[0][3], /facts-hash/);
  assert.match(calls[0][4], /JSON/i);
  for (const term of ['shot IDs', 'order', 'timing', 'speakers', 'causal', 'reversal', 'locked facts', 'hook']) {
    assert.match(calls[0][4], new RegExp(term, 'i'));
  }
  assert.equal(calls[0][5].model, 'verified-text-model');
  assert.equal(calls[0][5].json_mode, true);
  assert.equal(calls[0][5].temperature, 0.2);
  assert.ok(calls[0][5].min_max_tokens >= 4096);
});

test('localize fails closed without model and rejects invalid JSON', async () => {
  const adapters = createRedrawProviderAdapters({
    db: {},
    log: createLog(),
    cfg: {},
    aiClient: { async generateText() { return 'not json'; } },
  });

  await assert.rejects(
    () => adapters.localize({ input: { source_facts: {} } }),
    (error) => error.code === 'REDRAW_PROVIDER_MODEL_REQUIRED',
  );
  await assert.rejects(
    () => adapters.localize({
      model: 'verified-text-model',
      locale: 'en-US',
      market: 'US',
      input: { source_facts_hash: 'facts-hash', source_facts: {} },
    }),
    (error) => error.code === 'REDRAW_PROVIDER_INVALID_JSON' && /invalid JSON/i.test(error.message),
  );
});

test('generateAsset registers readable clean plate image without fabricating missing quality', async () => {
  const storageRoot = tempStorage();
  const imageCalls = [];
  const downloadCalls = [];
  const created = [];
  const adapters = createRedrawProviderAdapters({
    db: {},
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    imageClient: {
      async callImageApi(...args) {
        imageCalls.push(args);
        return {
          image_url: 'https://provider.example/scene.png',
          provider_task_id: 'remote-42',
          width: 1024,
          height: 576,
          quality: { width: 1024, height: 576 },
        };
      },
    },
    uploadService: {
      async downloadImageToLocal(...args) {
        downloadCalls.push(args);
        return makeReadableFile(storageRoot, 'redraw-assets/v7/scene.png', 'png');
      },
    },
    assetService: {
      create(_db, _log, payload) {
        created.push(payload);
        return { id: 77, ...payload };
      },
    },
  });

  const result = await adapters.generateAsset({
    taskId: 9,
    versionId: 7,
    model: 'verified-image-model',
    locale: 'en-US',
    market: 'US',
    asset: {
      id: 5,
      kind: 'scene',
      prompt: 'empty store after closing',
      localized_name: 'Store',
      localized_description: 'Clean empty store',
      source_ref_json: JSON.stringify({ source_ref: { width: 1024, height: 576 } }),
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.asset_id, 77);
  assert.equal(result.readable, true);
  assert.equal(result.provider_task_id, 'remote-42');
  assert.equal(result.clean_plate, true);
  assert.deepEqual(result.quality, { width: 1024, height: 576 });
  assert.equal(Object.hasOwn(result.quality, 'non_mask_similarity'), false);
  assert.equal(imageCalls[0][2].model, 'verified-image-model');
  assert.match(imageCalls[0][2].prompt, /empty store/);
  assert.match(imageCalls[0][2].system_prompt, /context/i);
  assert.ok(Object.hasOwn(imageCalls[0][2], 'user_negative_prompt'));
  assert.equal(downloadCalls[0][0], storageRoot);
  assert.equal(created[0].type, 'image');
  assert.equal(created[0].category, 'redraw_scene');
  assert.equal(created[0].mime_type, 'image/png');
  assert.equal(created[0].width, 1024);
  assert.equal(created[0].height, 576);
  assert.equal(created[0].metadata.provider_task_id, 'remote-42');
  assert.equal(downloadCalls[0][2], 'v7');
  assert.equal(downloadCalls[0][5], 'redraw-assets');
});

test('redrawAssetService.generateAsset contract reaches image adapter with snapshot provider and model', async () => {
  const state = setupAssetContractState();
  const imageCalls = [];
  const createCalls = [];
  const adapters = createRedrawProviderAdapters({
    db: state.db,
    log: createLog(),
    cfg: { storage: { local_path: state.storageRoot } },
    imageClient: {
      async callImageApi(...args) {
        imageCalls.push(args);
        return {
          image_url: 'https://provider.example/prop.png',
          provider_task_id: 'img-provider-task',
          width: 640,
          height: 360,
        };
      },
    },
    uploadService: {
      async downloadImageToLocal() {
        return makeReadableFile(state.storageRoot, `redraw-assets/v${state.versionId}/prop.png`, 'png');
      },
    },
    assetService: {
      create(db, log, payload) {
        createCalls.push(payload);
        return realAssetService.create(db, log, payload);
      },
    },
  });
  try {
    const result = await redrawAssetService.generateAsset({
      ...state.ctx,
      provider: adapters.generateAsset,
    }, {
      kind: 'prop',
      sourceRef: { id: 'prop-1', prompt: 'source prop prompt' },
      prompt: 'localized prop prompt',
      localizedName: 'Localized prop',
      localizedDescription: 'Localized description',
      model: 'conflicting-input-model',
      snapshot: { model: 'snapshot-image-model', provider: 'snapshot-provider' },
    });

    assert.equal(result.status, 'generated');
    assert.equal(createCalls.length, 1);
    assert.equal(imageCalls[0][2].model, 'snapshot-image-model');
    assert.equal(imageCalls[0][2].preferred_provider, 'snapshot-provider');
    assert.match(imageCalls[0][2].prompt, /localized prop prompt/);
  } finally {
    state.db.close();
    fs.rmSync(state.storageRoot, { recursive: true, force: true });
  }
});

test('generateAsset prefers persisted attempt snapshot over conflicting input model hints', async () => {
  const storageRoot = tempStorage();
  const imageCalls = [];
  const adapters = createRedrawProviderAdapters({
    db: {},
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    imageClient: {
      async callImageApi(...args) {
        imageCalls.push(args);
        return {
          image_url: 'https://provider.example/prop.png',
          provider_task_id: 'img-provider-task',
          width: 640,
          height: 360,
        };
      },
    },
    uploadService: {
      async downloadImageToLocal() {
        return makeReadableFile(storageRoot, 'redraw-assets/v7/prop.png', 'png');
      },
    },
    assetService: {
      create(_db, _log, payload) {
        return { id: 1, ...payload };
      },
    },
  });

  try {
    await adapters.generateAsset({
      versionId: 7,
      attempt: {
        id: 5,
        kind: 'prop',
        prompt: 'prop',
        source_ref_json: JSON.stringify({
          source_ref: { id: 'prop-1' },
          snapshot: { model: 'persisted-model', provider: 'persisted-provider' },
        }),
      },
      input: {
        model: 'input-model',
        snapshot: { model: 'input-snapshot-model', provider: 'input-provider' },
      },
    });

    assert.equal(imageCalls[0][2].model, 'persisted-model');
    assert.equal(imageCalls[0][2].preferred_provider, 'persisted-provider');
  } finally {
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('generateAsset rejects explicit model or provider conflicting with persisted attempt snapshot before client call', async () => {
  const storageRoot = tempStorage();
  const imageCalls = [];
  const adapters = createRedrawProviderAdapters({
    db: {},
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    imageClient: {
      async callImageApi(...args) {
        imageCalls.push(args);
        return { image_url: 'https://provider.example/prop.png', width: 640, height: 360 };
      },
    },
    uploadService: {
      async downloadImageToLocal() {
        return makeReadableFile(storageRoot, 'redraw-assets/v7/prop.png', 'png');
      },
    },
    assetService: {
      create(_db, _log, payload) {
        return { id: 1, ...payload };
      },
    },
  });

  const attempt = {
    id: 5,
    kind: 'prop',
    prompt: 'prop',
    source_ref_json: JSON.stringify({
      source_ref: { id: 'prop-1' },
      snapshot: { model: 'persisted-model', provider: 'persisted-provider' },
    }),
  };

  try {
    await assert.rejects(
      () => adapters.generateAsset({
        versionId: 7,
        model: 'other-model',
        attempt,
      }),
      (error) => error.code === 'REDRAW_PROVIDER_MODEL_SNAPSHOT_MISMATCH',
    );
    await assert.rejects(
      () => adapters.generateAsset({
        versionId: 7,
        model: 'persisted-model',
        provider: 'other-provider',
        attempt,
      }),
      (error) => error.code === 'REDRAW_PROVIDER_MODEL_SNAPSHOT_MISMATCH',
    );
    assert.equal(imageCalls.length, 0);
  } finally {
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('generateAsset does not fallback to input model when no persisted snapshot or trusted request model exists', async () => {
  const storageRoot = tempStorage();
  const imageCalls = [];
  const adapters = createRedrawProviderAdapters({
    db: {},
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    imageClient: {
      async callImageApi(...args) {
        imageCalls.push(args);
        return { image_url: 'https://provider.example/prop.png', width: 640, height: 360 };
      },
    },
    assetService: {
      create(_db, _log, payload) {
        return { id: 1, ...payload };
      },
    },
  });

  try {
    await assert.rejects(
      () => adapters.generateAsset({
        versionId: 7,
        attempt: { id: 5, kind: 'prop', prompt: 'prop' },
        input: { model: 'input-only-model' },
      }),
      (error) => error.code === 'REDRAW_PROVIDER_MODEL_REQUIRED',
    );
    assert.equal(imageCalls.length, 0);
  } finally {
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('generateAsset ignores input snapshot model when no persisted snapshot or trusted request model exists', async () => {
  const storageRoot = tempStorage();
  const imageCalls = [];
  const adapters = createRedrawProviderAdapters({
    db: {},
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    imageClient: {
      async callImageApi(...args) {
        imageCalls.push(args);
        return { image_url: 'https://provider.example/prop.png', width: 640, height: 360 };
      },
    },
    assetService: {
      create(_db, _log, payload) {
        return { id: 1, ...payload };
      },
    },
  });

  try {
    await assert.rejects(
      () => adapters.generateAsset({
        versionId: 7,
        attempt: { id: 5, kind: 'prop', prompt: 'prop' },
        input: {
          snapshot: { model: 'input-snapshot-model', provider: 'input-snapshot-provider' },
        },
      }),
      (error) => error.code === 'REDRAW_PROVIDER_MODEL_REQUIRED',
    );
    assert.equal(imageCalls.length, 0);
  } finally {
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('generateAsset trusted request model is not affected by input snapshot model or provider', async () => {
  const storageRoot = tempStorage();
  const imageCalls = [];
  const adapters = createRedrawProviderAdapters({
    db: {},
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    imageClient: {
      async callImageApi(...args) {
        imageCalls.push(args);
        return { image_url: 'https://provider.example/prop.png', width: 640, height: 360 };
      },
    },
    uploadService: {
      async downloadImageToLocal() {
        return makeReadableFile(storageRoot, 'redraw-assets/v7/prop.png', 'png');
      },
    },
    assetService: {
      create(_db, _log, payload) {
        return { id: 1, ...payload };
      },
    },
  });

  try {
    await adapters.generateAsset({
      versionId: 7,
      model: 'trusted-request-model',
      attempt: { id: 5, kind: 'prop', prompt: 'prop' },
      input: {
        snapshot: { model: 'input-snapshot-model', provider: 'input-snapshot-provider' },
      },
    });

    assert.equal(imageCalls[0][2].model, 'trusted-request-model');
    assert.equal(imageCalls[0][2].preferred_provider, undefined);
  } finally {
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('redrawAssetService.generateAsset contract reaches voice adapter and probes duration', async () => {
  const state = setupAssetContractState();
  const synthCalls = [];
  const createCalls = [];
  const adapters = createRedrawProviderAdapters({
    db: state.db,
    log: createLog(),
    cfg: { storage: { local_path: state.storageRoot } },
    ttsConfig: { provider: 'openai', default_model: 'snapshot-tts-model' },
    ttsService: {
      async synthesize(...args) {
        synthCalls.push(args);
        return { local_path: makeReadableFile(state.storageRoot, `redraw-assets/v${state.versionId}/voice.mp3`, 'mp3') };
      },
    },
    audioProbe: () => 0.144,
    assetService: {
      create(db, log, payload) {
        createCalls.push(payload);
        return realAssetService.create(db, log, payload);
      },
    },
  });
  try {
    const result = await redrawAssetService.generateAsset({
      ...state.ctx,
      provider: adapters.generateAsset,
    }, {
      kind: 'voice',
      sourceRef: { id: 'voice-1', voice_id: 'voice-from-source' },
      prompt: 'Hello from real contract',
      model: 'input-tts-model',
      snapshot: { model: 'snapshot-tts-model', provider: 'tts-provider' },
    });

    assert.equal(result.status, 'generated');
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].mime_type, 'audio/mpeg');
    assert.equal(createCalls[0].duration, 0.144);
    assert.equal(synthCalls[0][2].config.model, 'snapshot-tts-model');
    assert.equal(synthCalls[0][2].voice_id, 'voice-from-source');
  } finally {
    state.db.close();
    fs.rmSync(state.storageRoot, { recursive: true, force: true });
  }
});

test('generateAsset rejects downloaded image outside exact redraw version storage scope before registration', async () => {
  const cases = [
    'other/v1/a.png',
    'redraw-assets/v70/a.png',
    'redraw-assets/v7/../v7/a.png',
    path.join(tempStorage(), 'redraw-assets', 'v7', 'absolute.png'),
  ];
  for (const localPath of cases) {
    const storageRoot = tempStorage();
    const created = [];
    const adapters = createRedrawProviderAdapters({
      db: {},
      log: createLog(),
      cfg: { storage: { local_path: storageRoot } },
      imageClient: {
        async callImageApi() {
          return {
            image_url: 'https://provider.example/scene.png',
            width: 640,
            height: 360,
          };
        },
      },
      uploadService: {
        async downloadImageToLocal() {
          if (!path.isAbsolute(localPath) && !localPath.includes('..')) {
            makeReadableFile(storageRoot, localPath, 'png');
          }
          return localPath;
        },
      },
      assetService: {
        create(_db, _log, payload) {
          created.push(payload);
          return { id: 1, ...payload };
        },
      },
    });

    await assert.rejects(
      () => adapters.generateAsset({
        taskId: 9,
        versionId: 7,
        model: 'verified-image-model',
        asset: { id: 5, kind: 'scene', prompt: 'clean room' },
      }),
      (error) => error.code === 'REDRAW_ASSET_STORAGE_SCOPE_INVALID',
    );
    assert.equal(created.length, 0);
  }
});

test('generateAsset requires positive finite image dimensions before registration', async () => {
  for (const imageResult of [
    { image_url: 'https://provider.example/scene.png' },
    { image_url: 'https://provider.example/scene.png', width: 0, height: 360 },
    { image_url: 'https://provider.example/scene.png', width: -1, height: 360 },
  ]) {
    const storageRoot = tempStorage();
    const created = [];
    const adapters = createRedrawProviderAdapters({
      db: {},
      log: createLog(),
      cfg: { storage: { local_path: storageRoot } },
      imageClient: { async callImageApi() { return imageResult; } },
      uploadService: {
        async downloadImageToLocal() {
          return makeReadableFile(storageRoot, 'redraw-assets/v7/scene.png', 'png');
        },
      },
      assetService: {
        create(_db, _log, payload) {
          created.push(payload);
          return { id: 1, ...payload };
        },
      },
    });

    await assert.rejects(
      () => adapters.generateAsset({
        taskId: 9,
        versionId: 7,
        model: 'verified-image-model',
        asset: { id: 5, kind: 'scene', prompt: 'clean room' },
      }),
      (error) => error.code === 'REDRAW_IMAGE_DIMENSIONS_REQUIRED',
    );
    assert.equal(created.length, 0);
  }
});

test('generateAsset default image download uses public downloader and rejects private URLs before registration', async () => {
  const storageRoot = tempStorage();
  const created = [];
  const adapters = createRedrawProviderAdapters({
    db: {},
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    imageClient: {
      async callImageApi() {
        return { image_url: 'http://localhost/private.png', width: 640, height: 360 };
      },
    },
    assetService: {
      create(_db, _log, payload) {
        created.push(payload);
        return { id: 1, ...payload };
      },
    },
  });

  await assert.rejects(
    () => adapters.generateAsset({
      taskId: 9,
      versionId: 7,
      model: 'verified-image-model',
      asset: { id: 5, kind: 'prop', prompt: 'prop' },
    }),
    (error) => error.code === 'REDRAW_IMAGE_DOWNLOAD_FAILED',
  );
  assert.equal(created.length, 0);
});

test('generateAsset writes public image bytes into scoped storage and cleans them if registration fails', async () => {
  const storageRoot = tempStorage();
  let writtenPath = null;
  const adapters = createRedrawProviderAdapters({
    db: {},
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    imageClient: {
      async callImageApi() {
        return { image_url: 'https://provider.example/prop.png', width: 640, height: 360 };
      },
    },
    publicImageDownloader: async () => ({ bytes: Buffer.from('png-bytes'), mimeType: 'image/png' }),
    assetService: {
      create(_db, _log, payload) {
        writtenPath = payload.local_path;
        throw Object.assign(new Error('asset insert failed'), { code: 'ASSET_CREATE_FAILED' });
      },
    },
  });

  await assert.rejects(
    () => adapters.generateAsset({
      taskId: 9,
      versionId: 7,
      model: 'verified-image-model',
      asset: { id: 5, kind: 'prop', prompt: 'prop' },
    }),
    /asset insert failed/,
  );
  assert.ok(writtenPath);
  assert.equal(fs.existsSync(path.join(storageRoot, writtenPath)), false);
});

test('generateAsset voice uses verified model and refuses unknown duration before registration', async () => {
  const storageRoot = tempStorage();
  const calls = [];
  const created = [];
  const adapters = createRedrawProviderAdapters({
    db: {},
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    ttsConfig: { provider: 'openai', default_model: 'verified-tts-model' },
    ttsService: {
      async synthesize(...args) {
        calls.push(args);
        return { local_path: makeReadableFile(storageRoot, 'redraw-assets/v8/voice.mp3', 'mp3'), duration: 0 };
      },
    },
    assetService: {
      create(_db, _log, payload) {
        created.push(payload);
        return { id: 88, ...payload };
      },
    },
  });

  await assert.rejects(
    () => adapters.generateAsset({
      versionId: 8,
      model: 'verified-tts-model',
      locale: 'en-US',
      asset: {
        id: 6,
        kind: 'voice',
        prompt: 'Hello',
        source_ref_json: JSON.stringify({ source_ref: { voice_id: 'voice-a' } }),
      },
    }),
    (error) => error.code === 'REDRAW_VOICE_DURATION_REQUIRED',
  );
  assert.equal(created.length, 0);
  assert.equal(calls[0][2].text, 'Hello');
  assert.equal(calls[0][2].voice_id, 'voice-a');
  assert.equal(calls[0][2].config.model, 'verified-tts-model');
  assert.equal(calls[0][2].storage_base, storageRoot);
  assert.equal(calls[0][2].storage_subdir, 'redraw-assets/v8');
});

test('generateAsset voice probes duration when synthesize omits it and cleans failed probes', async () => {
  const storageRoot = tempStorage();
  const created = [];
  let voicePath = '';
  const adapters = createRedrawProviderAdapters({
    db: {},
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    ttsConfig: { provider: 'openai', default_model: 'verified-tts-model' },
    ttsService: {
      async synthesize() {
        voicePath = makeReadableFile(storageRoot, 'redraw-assets/v8/voice.mp3', 'mp3');
        return { local_path: voicePath };
      },
    },
    audioProbe: () => null,
    assetService: {
      create(_db, _log, payload) {
        created.push(payload);
        return { id: 1, ...payload };
      },
    },
  });

  await assert.rejects(
    () => adapters.generateAsset({
      versionId: 8,
      model: 'verified-tts-model',
      locale: 'en-US',
      asset: { id: 6, kind: 'voice', prompt: 'Hello' },
    }),
    (error) => error.code === 'REDRAW_VOICE_DURATION_REQUIRED',
  );
  assert.equal(created.length, 0);
  assert.equal(fs.existsSync(path.join(storageRoot, voicePath)), false);
});

test('generateAsset voice cleans scoped TTS file if registration fails', async () => {
  const storageRoot = tempStorage();
  let voicePath = '';
  const adapters = createRedrawProviderAdapters({
    db: {},
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    ttsConfig: { provider: 'openai', default_model: 'verified-tts-model' },
    ttsService: {
      async synthesize() {
        voicePath = makeReadableFile(storageRoot, 'redraw-assets/v8/voice.mp3', 'mp3');
        return { local_path: voicePath };
      },
    },
    audioProbe: () => 0.25,
    assetService: {
      create() {
        throw Object.assign(new Error('asset insert failed'), { code: 'ASSET_CREATE_FAILED' });
      },
    },
  });

  await assert.rejects(
    () => adapters.generateAsset({
      versionId: 8,
      model: 'verified-tts-model',
      locale: 'en-US',
      asset: { id: 6, kind: 'voice', prompt: 'Hello' },
    }),
    /asset insert failed/,
  );
  assert.equal(fs.existsSync(path.join(storageRoot, voicePath)), false);
});

test('setupRouter bridges fake redraw asset adapters with trusted input model', async () => {
  const routesPath = require.resolve('../src/routes');
  const redrawPath = require.resolve('../src/routes/redraw');
  const adaptersPath = require.resolve('../src/services/redrawProviderAdapters');
  const mocked = new Map();
  const noop = (_req, _res, next) => { if (typeof next === 'function') next(); };
  const handlerBag = new Proxy({}, { get: () => noop });
  function mock(rel, exports) {
    const resolved = require.resolve(rel);
    mocked.set(resolved, require.cache[resolved]);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
  }
  function mockRoute(rel) {
    mock(rel, () => handlerBag);
  }
  delete require.cache[routesPath];
  const originalRedraw = require.cache[redrawPath];
  const originalAdapters = require.cache[adaptersPath];
  const seen = [];
  const adapterRequests = [];
  const fakeAdapters = {
    localize: async () => ({}),
    generateAsset: async (request) => {
      adapterRequests.push(request);
      return { status: 'completed' };
    },
  };
  require.cache[redrawPath] = {
    id: redrawPath,
    filename: redrawPath,
    loaded: true,
    exports: (_db, _log, options) => {
      seen.push(options);
      return handlerBag;
    },
  };
  require.cache[adaptersPath] = {
    id: adaptersPath,
    filename: adaptersPath,
    loaded: true,
    exports: {
      createRedrawProviderAdapters(deps) {
        seen.push({ factoryDeps: deps });
        return fakeAdapters;
      },
    },
  };
  [
    '../src/routes/drama',
    '../src/routes/task',
    '../src/routes/settings',
    '../src/routes/aiConfig',
    '../src/routes/prop',
    '../src/routes/stub',
    '../src/routes/characterLibrary',
    '../src/routes/sceneLibrary',
    '../src/routes/propLibrary',
    '../src/routes/characters',
    '../src/routes/scenes',
    '../src/routes/storyboards',
    '../src/routes/storyboards_tail_link',
    '../src/routes/images',
    '../src/routes/videos',
    '../src/routes/videoMerges',
    '../src/routes/assets',
    '../src/routes/imageTools',
    '../src/routes/videoTools',
    '../src/routes/audio',
    '../src/routes/canvas-text',
    '../src/routes/voiceCatalog',
    '../src/routes/scriptAnalysis',
    '../src/routes/directorExport',
    '../src/routes/directorReference',
    '../src/routes/sceneModelMap',
    '../src/routes/auth',
    '../src/routes/billing',
    '../src/routes/tenants',
    '../src/routes/platformAccounts',
  ].forEach(mockRoute);
  mock('../src/routes/upload', { routes: () => handlerBag, multerSingle: noop, multerAudioSingle: noop });
  mock('../src/routes/promptOverrides', { routes: () => handlerBag });
  mock('../src/middleware/adminAuth', { createAdminAuthMiddleware: () => noop });
  mock('../src/middleware/userAuth', { createUserAuthMiddleware: () => noop });
  mock('../src/middleware/rateLimit', { createRateLimitMiddleware: () => noop });
  mock('../src/middleware/modelGenerationGuard', { createModelGenerationGuard: () => noop });
  mock('../src/middleware/platformRbac', {
    PERMISSIONS: new Proxy({}, { get: (_target, prop) => prop }),
    createPlatformPermissionMiddleware: () => noop,
  });
  mock('../src/services/emailService', { createEmailService: () => ({}) });
  mock('../src/services/text-generation-billing-service', { createMiddleware: () => noop });
  mock('../src/services/uploadService', {});
  mock('../src/services/promptI18n', { loadOverridesIntoCache() {} });
  mock('../src/services/promptOverridesService', { listOverrides: () => [] });
  try {
    const { setupRouter } = require('../src/routes');
    setupRouter({ storage: {} }, {}, createLog(), { providerAdapters: fakeAdapters });
    assert.equal(seen.some((entry) => entry.localizationProvider === fakeAdapters.localize), true);
    const redrawOptions = seen.find((entry) => typeof entry.assetGenerationProvider === 'function'
      && !entry.factoryDeps);
    assert.notEqual(redrawOptions.assetGenerationProvider, fakeAdapters.generateAsset);
    await redrawOptions.assetGenerationProvider({
      attempt: { id: 1, kind: 'prop' },
      input: { model: 'server-verified-model', provider: 'ignored-input-provider' },
      versionId: 7,
    });
    assert.equal(adapterRequests.length, 1);
    assert.equal(adapterRequests[0].model, 'server-verified-model');
    assert.equal(adapterRequests[0].provider, undefined);
    assert.equal(adapterRequests[0].input.model, 'server-verified-model');
  } finally {
    delete require.cache[routesPath];
    if (originalRedraw) require.cache[redrawPath] = originalRedraw;
    else delete require.cache[redrawPath];
    if (originalAdapters) require.cache[adaptersPath] = originalAdapters;
    else delete require.cache[adaptersPath];
    for (const [resolved, original] of mocked) {
      if (original) require.cache[resolved] = original;
      else delete require.cache[resolved];
    }
  }
});

test('setupRouter uses explicit redraw providers without creating default adapters', () => {
  const routesPath = require.resolve('../src/routes');
  const redrawPath = require.resolve('../src/routes/redraw');
  const adaptersPath = require.resolve('../src/services/redrawProviderAdapters');
  const mocked = new Map();
  const noop = (_req, _res, next) => { if (typeof next === 'function') next(); };
  const handlerBag = new Proxy({}, { get: () => noop });
  function mock(rel, exports) {
    const resolved = require.resolve(rel);
    mocked.set(resolved, require.cache[resolved]);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
  }
  function mockRoute(rel) {
    mock(rel, () => handlerBag);
  }
  delete require.cache[routesPath];
  const originalRedraw = require.cache[redrawPath];
  const originalAdapters = require.cache[adaptersPath];
  const seen = [];
  const localizationProvider = async () => ({});
  const assetGenerationProvider = async () => ({});
  require.cache[redrawPath] = {
    id: redrawPath,
    filename: redrawPath,
    loaded: true,
    exports: (_db, _log, options) => {
      seen.push(options);
      return handlerBag;
    },
  };
  require.cache[adaptersPath] = {
    id: adaptersPath,
    filename: adaptersPath,
    loaded: true,
    exports: {
      createRedrawProviderAdapters() {
        throw new Error('default factory must not be called');
      },
    },
  };
  [
    '../src/routes/drama',
    '../src/routes/task',
    '../src/routes/settings',
    '../src/routes/aiConfig',
    '../src/routes/prop',
    '../src/routes/stub',
    '../src/routes/characterLibrary',
    '../src/routes/sceneLibrary',
    '../src/routes/propLibrary',
    '../src/routes/characters',
    '../src/routes/scenes',
    '../src/routes/storyboards',
    '../src/routes/storyboards_tail_link',
    '../src/routes/images',
    '../src/routes/videos',
    '../src/routes/videoMerges',
    '../src/routes/assets',
    '../src/routes/imageTools',
    '../src/routes/videoTools',
    '../src/routes/audio',
    '../src/routes/canvas-text',
    '../src/routes/voiceCatalog',
    '../src/routes/scriptAnalysis',
    '../src/routes/directorExport',
    '../src/routes/directorReference',
    '../src/routes/sceneModelMap',
    '../src/routes/auth',
    '../src/routes/billing',
    '../src/routes/tenants',
    '../src/routes/platformAccounts',
  ].forEach(mockRoute);
  mock('../src/routes/upload', { routes: () => handlerBag, multerSingle: noop, multerAudioSingle: noop });
  mock('../src/routes/promptOverrides', { routes: () => handlerBag });
  mock('../src/middleware/adminAuth', { createAdminAuthMiddleware: () => noop });
  mock('../src/middleware/userAuth', { createUserAuthMiddleware: () => noop });
  mock('../src/middleware/rateLimit', { createRateLimitMiddleware: () => noop });
  mock('../src/middleware/modelGenerationGuard', { createModelGenerationGuard: () => noop });
  mock('../src/middleware/platformRbac', {
    PERMISSIONS: new Proxy({}, { get: (_target, prop) => prop }),
    createPlatformPermissionMiddleware: () => noop,
  });
  mock('../src/services/emailService', { createEmailService: () => ({}) });
  mock('../src/services/text-generation-billing-service', { createMiddleware: () => noop });
  mock('../src/services/uploadService', {});
  mock('../src/services/promptI18n', { loadOverridesIntoCache() {} });
  mock('../src/services/promptOverridesService', { listOverrides: () => [] });
  try {
    const { setupRouter } = require('../src/routes');
    setupRouter({ storage: {} }, {}, createLog(), {
      redrawOptions: { localizationProvider, assetGenerationProvider },
    });
    assert.equal(seen.some((entry) => entry.localizationProvider === localizationProvider), true);
    assert.equal(seen.some((entry) => entry.assetGenerationProvider === assetGenerationProvider), true);
  } finally {
    delete require.cache[routesPath];
    if (originalRedraw) require.cache[redrawPath] = originalRedraw;
    else delete require.cache[redrawPath];
    if (originalAdapters) require.cache[adaptersPath] = originalAdapters;
    else delete require.cache[adaptersPath];
    for (const [resolved, original] of mocked) {
      if (original) require.cache[resolved] = original;
      else delete require.cache[resolved];
    }
  }
});

test('createApp reconciles redraw localization and asset batches after analysis resume before generic cleanup', async () => {
  const appPath = require.resolve('../src/app');
  const moduleMocks = new Map();
  const order = [];
  let resumeResolve;
  const resumePromise = new Promise((resolve) => { resumeResolve = resolve; });
  function mock(rel, exports) {
    const resolved = require.resolve(rel);
    moduleMocks.set(resolved, require.cache[resolved]);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
  }
  delete require.cache[appPath];
  mock('../src/db/index.js', { getDb: () => ({}) });
  mock('../src/config/index.js', { loadConfig: () => ({ database: {}, storage: { local_path: tempStorage() }, server: {}, app: { name: 'x', version: '1' } }) });
  mock('../src/logger.js', { info() {}, warn() {}, error() {}, errorw() {} });
  mock('../src/routes/index.js', { setupRouter: () => (_req, _res, next) => next && next() });
  mock('../src/middleware/resourceOwnership', { createStaticOwnershipMiddleware: () => (_req, _res, next) => next() });
  mock('../src/db/migrate.js', { runMigrationsAndEnsure() {} });
  mock('../src/services/aiConfigService', { applyVendorLock() {} });
  mock('../src/services/redrawOrchestrator', {
    createStartupResumeOptions: () => ({}),
    resumeRedrawTasks: () => resumePromise.then(() => { order.push('analysis'); }),
  });
  mock('../src/services/redrawLocalizationOrchestrator', {
    reconcileOrphanedTasks: () => { order.push('localization'); return 0; },
  });
  mock('../src/services/redrawAssetBatchService', {
    reconcileOrphanedBatches: () => { order.push('batch'); return 0; },
  });
  mock('../src/services/taskService', {
    failOrphanedAsyncTasksOnStartup: () => { order.push('generic'); return 0; },
  });
  mock('../src/services/videoService', { resumeProcessingVideoGenerations() {} });
  try {
    const { createApp } = require('../src/app');
    createApp();
    resumeResolve();
    await resumePromise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ['analysis', 'localization', 'batch', 'generic']);
  } finally {
    delete require.cache[appPath];
    for (const [resolved, original] of moduleMocks) {
      if (original) require.cache[resolved] = original;
      else delete require.cache[resolved];
    }
  }
});
