const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const sharp = require('sharp');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const realAssetService = require('../src/services/assetService');
const redrawAssetService = require('../src/services/redrawAssetService');
const {
  createRedrawProviderAdapters,
  normalizeVideoProviderResult,
} = require('../src/services/redrawProviderAdapters');

const MODEL_MANIFEST_SHA256 = 'a'.repeat(64);
const CALIBRATION_MANIFEST_SHA256 = 'b'.repeat(64);
const AUDIO_SHA256 = 'c'.repeat(64);
const TRANSCRIPT_SHA256 = 'd'.repeat(64);

test('供应商 completed 只映射为 completed_candidate', () => {
  assert.deepEqual(normalizeVideoProviderResult({
    status: 'completed',
    task_id: 'p1',
    url: 'https://result',
  }), {
    status: 'completed_candidate',
    provider_task_id: 'p1',
    result_url: 'https://result',
  });
});

test('视频供应商常见状态只映射到规范候选终态', () => {
  assert.deepEqual(normalizeVideoProviderResult({ status: 'queued', task_id: 'p2' }), {
    status: 'accepted',
    provider_task_id: 'p2',
  });
  assert.deepEqual(normalizeVideoProviderResult({ status: 'in_progress', provider_task_id: 'p3' }), {
    status: 'running',
    provider_task_id: 'p3',
  });
  assert.deepEqual(normalizeVideoProviderResult({ status: 'rejected', task_id: 'p4' }), {
    status: 'failed_terminal',
    provider_task_id: 'p4',
    safe_stage: 'provider_terminal',
  });
  assert.deepEqual(normalizeVideoProviderResult({ status: 'indeterminate', task_id: 'p5' }), {
    status: 'submission_unknown',
    provider_task_id: 'p5',
    safe_stage: 'provider_status',
  });
  assert.deepEqual(normalizeVideoProviderResult({ status: 'result_unavailable', task_id: 'p6' }), {
    status: 'result_unavailable',
    provider_task_id: 'p6',
    safe_stage: 'provider_result',
  });
});

test('completed 携带 error_msg 或 error_message 时必须降级 submission_unknown', () => {
  for (const errorField of ['error_msg', 'error_message']) {
    const normalized = normalizeVideoProviderResult({
      status: 'completed',
      task_id: `conflict-${errorField}`,
      url: 'https://result',
      local_path: 'videos/candidate.mp4',
      [errorField]: 'Authorization Bearer secret provider body',
    });
    assert.deepEqual(normalized, {
      status: 'submission_unknown',
      provider_task_id: `conflict-${errorField}`,
      result_url: 'https://result',
      safe_stage: 'provider_status',
    });
    assert.equal(JSON.stringify(normalized).includes('secret'), false);
    assert.equal(JSON.stringify(normalized).includes('provider body'), false);
  }
});

test('未知空白或矛盾视频状态 fail-safe 且不泄露供应商正文', () => {
  const cases = [
    { status: '', task_id: 'empty', error: 'Authorization Bearer secret' },
    { status: 'mystery', task_id: 'unknown', message: 'https://private.provider/task' },
    { status: 'completed', task_id: 'missing-result', error: 'raw provider body' },
    { status: 'failed', task_id: 'contradictory', url: 'https://result', headers: { authorization: 'secret' } },
  ];
  for (const raw of cases) {
    const normalized = normalizeVideoProviderResult(raw);
    assert.ok(['submission_unknown', 'result_unavailable'].includes(normalized.status));
    assert.deepEqual(
      Object.keys(normalized).sort(),
      Object.keys(normalized).filter((key) => [
        'provider_task_id', 'status', 'result_url', 'safe_stage',
      ].includes(key)).sort(),
    );
    assert.equal(JSON.stringify(normalized).includes('secret'), false);
    assert.equal(JSON.stringify(normalized).includes('private.provider'), false);
    assert.equal(JSON.stringify(normalized).includes('raw provider body'), false);
  }
});

function createLog() {
  return { info() {}, warn() {}, error() {} };
}

const DIALOGUE_TTS_CONFIG = {
  id: 88,
  service_type: 'tts',
  provider: 'openai',
  name: 'pinned dialogue TTS',
  model: ['verified-dialogue-model'],
  default_model: 'verified-dialogue-model',
  is_active: true,
  created_at: '2026-08-08T00:00:00.000Z',
  updated_at: '2026-08-08T00:00:00.000Z',
};

function fakeTtsConfigDb(config = DIALOGUE_TTS_CONFIG) {
  return {
    prepare() {
      return {
        get(id) {
          if (Number(id) !== Number(config.id)) return null;
          return {
            ...config,
            model: JSON.stringify(config.model),
            is_active: config.is_active ? 1 : 0,
            settings: '{}',
          };
        },
      };
    },
  };
}

function dialogueVoiceSnapshot() {
  return {
    provider: DIALOGUE_TTS_CONFIG.provider,
    model: DIALOGUE_TTS_CONFIG.default_model,
    ai_service_config_id: DIALOGUE_TTS_CONFIG.id,
    config_updated_at: DIALOGUE_TTS_CONFIG.updated_at,
  };
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

function verifiedLocaleVerifier(calls = []) {
  return {
    assertReady() {},
    async verify(input) {
      calls.push(input);
      return {
        languageVerified: true,
        detectedLocale: input.locale,
        source: 'offline-worker',
        localePack: `${input.locale}@fixture`,
        audio_sha256: AUDIO_SHA256,
        transcript_sha256: TRANSCRIPT_SHA256,
        model_manifest_sha256: MODEL_MANIFEST_SHA256,
        calibration_manifest_sha256: CALIBRATION_MANIFEST_SHA256,
        asr_model_revision: 'asr-en-20260808',
        accent_model_revision: 'accent-en-20260808',
        metrics: { word_error_rate: 0, accent_confidence: 0.99 },
        completed_at: '2026-08-08T00:00:01.000Z',
      };
    },
  };
}

async function makePngFile(root, rel, width = 640, height = 360) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const bytes = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 20, g: 120, b: 200, alpha: 1 },
    },
  }).png().toBuffer();
  fs.writeFileSync(abs, bytes);
  return rel.replace(/\\/g, '/');
}

async function pngBuffer(width = 640, height = 360) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 20, g: 120, b: 200, alpha: 1 },
    },
  }).png().toBuffer();
}

async function jpegBuffer(width = 640, height = 360) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 80, b: 40 },
    },
  }).jpeg().toBuffer();
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
    localeRegistry: {
      assertEvidenceTrusted(evidence) {
        if (evidence.source !== 'offline-worker'
          || evidence.locale_pack !== 'en-US@fixture'
          || evidence.model_manifest_sha256 !== MODEL_MANIFEST_SHA256
          || evidence.calibration_manifest_sha256 !== CALIBRATION_MANIFEST_SHA256) {
          throw Object.assign(new Error('worker evidence not trusted'), {
            code: 'REDRAW_LOCALE_VERIFIER_NOT_READY',
          });
        }
        return evidence;
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
  for (const term of [
    'shot IDs', 'order', 'timing', 'speakers', 'causal', 'reversal', 'locked facts', 'hook',
    'facts_hash', 'dialogue', 'start_ms', 'end_ms', 'localized_text',
  ]) {
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
        return makePngFile(storageRoot, 'redraw-assets/v7/scene.png', 1024, 576);
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

test('generateAsset accepts trusted nested clean scene version and kind from the default wrapper contract', async () => {
  const storageRoot = tempStorage();
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-clean-adapter-stage-'));
  const calls = [];
  const adapters = createRedrawProviderAdapters({
    db: {},
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    imageClient: {
      async callImageApi(...args) {
        calls.push(args);
        return {
          image_url: 'https://provider.example/nested-clean.png',
          provider_task_id: 'nested-clean-task',
          width: 64,
          height: 48,
          quality: { width: 64, height: 48 },
        };
      },
    },
    uploadService: {
      async downloadImageToLocal() {
        return makePngFile(storageRoot, 'redraw-assets/v17/nested-clean.png', 64, 48);
      },
    },
    assetService: {
      create(_db, _log, payload) {
        return { id: 177, ...payload };
      },
    },
  });

  try {
    const input = Object.freeze({
      version_id: 17,
      kind: 'scene',
      mode: 'clean_plate',
      model: 'verified-clean-model',
      prompt: 'remove the person and preserve the empty scene',
      source_asset_id: 401,
      mask_asset_id: 402,
    });
    const result = await adapters.generateAsset({
      outputDir: stagingRoot,
      input,
      model: input.model,
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.clean_plate, true);
    assert.equal(result.clean_plate_asset_id, 177);
    assert.equal(result.asset_id, 177);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][2].imageServiceType, 'redraw_scene');
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
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
        return makePngFile(state.storageRoot, `redraw-assets/v${state.versionId}/prop.png`, 640, 360);
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
        return makePngFile(storageRoot, 'redraw-assets/v7/prop.png', 640, 360);
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
        return makePngFile(storageRoot, 'redraw-assets/v7/prop.png', 640, 360);
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
        return makePngFile(storageRoot, 'redraw-assets/v7/prop.png', 640, 360);
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
  state.db.prepare(`INSERT INTO ai_service_configs
    (id, service_type, provider, name, model, default_model, is_active, settings, created_at, updated_at)
    VALUES (77, 'tts', 'tts-provider', 'contract TTS', ?, 'snapshot-tts-model', 1, '{}', ?, ?)`)
    .run(JSON.stringify(['snapshot-tts-model']), '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z');
  const synthCalls = [];
  const createCalls = [];
  const adapters = createRedrawProviderAdapters({
    db: state.db,
    log: createLog(),
    cfg: { storage: { local_path: state.storageRoot } },
    ttsConfig: {
      id: 77,
      service_type: 'tts',
      provider: 'tts-provider',
      default_model: 'snapshot-tts-model',
      is_active: true,
      updated_at: '2026-08-08T00:00:00.000Z',
    },
    ttsService: {
      async synthesize(...args) {
        synthCalls.push(args);
        return {
          status: 'completed',
          provider_task_id: 'voice-contract-task',
          local_path: makeReadableFile(state.storageRoot, `redraw-assets/v${state.versionId}/voice.mp3`, 'mp3'),
          detected_locale: 'en-US',
          language_verified: true,
        };
      },
    },
    audioProbe: () => 0.144,
    localeVerifier: verifiedLocaleVerifier(),
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
      snapshot: {
        model: 'snapshot-tts-model',
        provider: 'tts-provider',
        ai_service_config_id: 77,
        config_updated_at: '2026-08-08T00:00:00.000Z',
      },
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

test('generateAsset probes actual image dimensions when provider omits them', async () => {
  const storageRoot = tempStorage();
  const created = [];
  const adapters = createRedrawProviderAdapters({
    db: {},
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    imageClient: {
      async callImageApi() {
        return { image_url: 'https://provider.example/scene.png' };
      },
    },
    uploadService: {
      async downloadImageToLocal() {
        return makePngFile(storageRoot, 'redraw-assets/v7/scene.png', 321, 123);
      },
    },
    assetService: {
      create(_db, _log, payload) {
        created.push(payload);
        return { id: 1, ...payload };
      },
    },
  });

  const result = await adapters.generateAsset({
    taskId: 9,
    versionId: 7,
    model: 'verified-image-model',
    asset: { id: 5, kind: 'scene', prompt: 'clean room' },
  });

  assert.equal(result.status, 'completed');
  assert.equal(created[0].width, 321);
  assert.equal(created[0].height, 123);
  assert.deepEqual(created[0].metadata.quality, { width: 321, height: 123 });
});

test('generateAsset rejects invalid provider dimensions when actual image probe also fails', async () => {
  const storageRoot = tempStorage();
  const created = [];
  const adapters = createRedrawProviderAdapters({
    db: {},
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    imageClient: {
      async callImageApi() {
        return { image_url: 'https://provider.example/scene.png', width: 0, height: 360 };
      },
    },
    uploadService: {
      async downloadImageToLocal() {
        return makeReadableFile(storageRoot, 'redraw-assets/v7/scene.png', 'not an image');
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
    (error) => error.code === 'REDRAW_PROVIDER_ARTIFACT_INVALID',
  );
  assert.equal(created.length, 0);
});

test('generateAsset rejects provider dimensions that conflict with actual file metadata', async () => {
  const storageRoot = tempStorage();
  const created = [];
  const adapters = createRedrawProviderAdapters({
    db: {},
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    imageClient: {
      async callImageApi() {
        return { image_url: 'https://provider.example/scene.png', width: 640, height: 360 };
      },
    },
    uploadService: {
      async downloadImageToLocal() {
        return makePngFile(storageRoot, 'redraw-assets/v7/scene.png', 320, 180);
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
    (error) => error.code === 'REDRAW_PROVIDER_ARTIFACT_INVALID' && /dimension/i.test(error.message),
  );
  assert.equal(created.length, 0);
});

test('generateAsset rejects non-image downloaded artifact before registration', async () => {
  const storageRoot = tempStorage();
  const created = [];
  const adapters = createRedrawProviderAdapters({
    db: {},
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    imageClient: {
      async callImageApi() {
        return { image_url: 'https://provider.example/scene.png' };
      },
    },
    uploadService: {
      async downloadImageToLocal() {
        return makeReadableFile(storageRoot, 'redraw-assets/v7/scene.png', 'not an image');
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
    (error) => error.code === 'REDRAW_PROVIDER_ARTIFACT_INVALID',
  );
  assert.equal(created.length, 0);
});

test('generateAsset registers mime type from actual image magic', async () => {
  const storageRoot = tempStorage();
  const created = [];
  const adapters = createRedrawProviderAdapters({
    db: {},
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    imageClient: {
      async callImageApi() {
        return { image_url: 'https://provider.example/prop.jpg', width: 320, height: 180 };
      },
    },
    publicImageDownloader: async () => ({ bytes: await jpegBuffer(320, 180), mimeType: 'image/jpeg' }),
    assetService: {
      create(_db, _log, payload) {
        created.push(payload);
        return { id: 1, ...payload };
      },
    },
  });

  const result = await adapters.generateAsset({
    taskId: 9,
    versionId: 7,
    model: 'verified-image-model',
    asset: { id: 5, kind: 'prop', prompt: 'prop' },
  });

  assert.equal(result.status, 'completed');
  assert.equal(created[0].mime_type, 'image/jpeg');
  assert.equal(created[0].width, 320);
  assert.equal(created[0].height, 180);
});

test('generateAsset rejects image magic that conflicts with extension or declared mime', async () => {
  const storageRoot = tempStorage();
  const created = [];
  const adapters = createRedrawProviderAdapters({
    db: {},
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    imageClient: {
      async callImageApi() {
        return { image_url: 'https://provider.example/prop.png', width: 320, height: 180 };
      },
    },
    publicImageDownloader: async () => ({ bytes: await jpegBuffer(320, 180), mimeType: 'image/png' }),
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
    (error) => error.code === 'REDRAW_PROVIDER_ARTIFACT_INVALID' && !String(error.message).includes(storageRoot),
  );
  assert.equal(created.length, 0);
});

test('generateAsset rejects realpath escaping the redraw version directory before probing', async () => {
  const storageRoot = tempStorage();
  const created = [];
  const calls = [];
  const adapters = createRedrawProviderAdapters({
    db: {},
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    imageClient: {
      async callImageApi() {
        return { image_url: 'https://provider.example/scene.png', width: 640, height: 360 };
      },
    },
    uploadService: {
      async downloadImageToLocal() {
        return makePngFile(storageRoot, 'redraw-assets/v7/scene.png', 640, 360);
      },
    },
    realpathSync(target) {
      calls.push(target);
      if (target.endsWith(path.join('redraw-assets', 'v7', 'scene.png'))) {
        return path.join(storageRoot, 'outside', 'scene.png');
      }
      return path.resolve(target);
    },
    imageMetadataProbe() {
      throw new Error('probe must not run after containment failure');
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
    (error) => error.code === 'REDRAW_PROVIDER_ARTIFACT_INVALID' && !String(error.message).includes(storageRoot),
  );
  assert.equal(created.length, 0);
  assert.equal(calls.length >= 3, true);
});

test('generateAsset does not delete external target when version directory link escapes storage', async () => {
  const storageRoot = tempStorage();
  const externalRoot = tempStorage();
  const versionDir = path.join(storageRoot, 'redraw-assets', 'v7');
  const externalFile = path.join(externalRoot, 'scene.png');
  fs.mkdirSync(path.dirname(versionDir), { recursive: true });
  fs.symlinkSync(externalRoot, versionDir, process.platform === 'win32' ? 'junction' : 'dir');
  await makePngFile(externalRoot, 'scene.png', 640, 360);
  const created = [];
  let probeCalls = 0;
  const adapters = createRedrawProviderAdapters({
    db: {},
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    imageClient: {
      async callImageApi() {
        return { image_url: 'https://provider.example/scene.png', width: 640, height: 360 };
      },
    },
    uploadService: {
      async downloadImageToLocal() {
        return 'redraw-assets/v7/scene.png';
      },
    },
    imageMetadataProbe() {
      probeCalls += 1;
      throw new Error('probe must not run after containment failure');
    },
    assetService: {
      create(_db, _log, payload) {
        created.push(payload);
        return { id: 1, ...payload };
      },
    },
  });

  try {
    await assert.rejects(
      () => adapters.generateAsset({
        taskId: 9,
        versionId: 7,
        model: 'verified-image-model',
        asset: { id: 5, kind: 'scene', prompt: 'clean room' },
      }),
      (error) => error.code === 'REDRAW_PROVIDER_ARTIFACT_INVALID' && !String(error.message).includes(storageRoot),
    );
    assert.equal(probeCalls, 0);
    assert.equal(created.length, 0);
    assert.equal(fs.existsSync(externalFile), true);
  } finally {
    fs.rmSync(versionDir, { force: true });
    fs.rmSync(storageRoot, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});

test('generateAsset public downloader rejects version directory link before writing bytes outside storage', async () => {
  const storageRoot = tempStorage();
  const externalRoot = tempStorage();
  const versionDir = path.join(storageRoot, 'redraw-assets', 'v7');
  fs.mkdirSync(path.dirname(versionDir), { recursive: true });
  fs.symlinkSync(externalRoot, versionDir, process.platform === 'win32' ? 'junction' : 'dir');
  const created = [];
  const adapters = createRedrawProviderAdapters({
    db: {},
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    imageClient: {
      async callImageApi() {
        return { image_url: 'https://provider.example/scene.png', width: 640, height: 360 };
      },
    },
    publicImageDownloader: async () => ({ bytes: await pngBuffer(640, 360), mimeType: 'image/png' }),
    assetService: {
      create(_db, _log, payload) {
        created.push(payload);
        return { id: 1, ...payload };
      },
    },
  });

  try {
    await assert.rejects(
      () => adapters.generateAsset({
        taskId: 9,
        versionId: 7,
        model: 'verified-image-model',
        asset: { id: 5, kind: 'scene', prompt: 'clean room' },
      }),
      (error) => error.code === 'REDRAW_PROVIDER_ARTIFACT_INVALID' && !String(error.message).includes(storageRoot),
    );
    assert.deepEqual(fs.readdirSync(externalRoot), []);
    assert.equal(created.length, 0);
  } finally {
    fs.rmSync(versionDir, { force: true });
    fs.rmSync(storageRoot, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});

test('generateAsset rejects upload paths containing a link even when realpath stays inside version', async () => {
  const storageRoot = tempStorage();
  const versionDir = path.join(storageRoot, 'redraw-assets', 'v7');
  const realDir = path.join(versionDir, 'real');
  const linkedDir = path.join(versionDir, 'linked');
  fs.mkdirSync(realDir, { recursive: true });
  fs.symlinkSync(realDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
  await makePngFile(storageRoot, 'redraw-assets/v7/real/scene.png', 640, 360);
  const targetFile = path.join(realDir, 'scene.png');
  const created = [];
  let probeCalls = 0;
  const adapters = createRedrawProviderAdapters({
    db: {},
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    imageClient: {
      async callImageApi() {
        return { image_url: 'https://provider.example/scene.png', width: 640, height: 360 };
      },
    },
    uploadService: {
      async downloadImageToLocal() {
        return 'redraw-assets/v7/linked/scene.png';
      },
    },
    imageMetadataProbe() {
      probeCalls += 1;
      throw new Error('probe must not run for linked upload path');
    },
    assetService: {
      create(_db, _log, payload) {
        created.push(payload);
        return { id: 1, ...payload };
      },
    },
  });

  try {
    await assert.rejects(
      () => adapters.generateAsset({
        taskId: 9,
        versionId: 7,
        model: 'verified-image-model',
        asset: { id: 5, kind: 'scene', prompt: 'clean room' },
      }),
      (error) => error.code === 'REDRAW_PROVIDER_ARTIFACT_INVALID' && !String(error.message).includes(storageRoot),
    );
    assert.equal(probeCalls, 0);
    assert.equal(created.length, 0);
    assert.equal(fs.existsSync(targetFile), true);
  } finally {
    fs.rmSync(linkedDir, { force: true });
    fs.rmSync(storageRoot, { recursive: true, force: true });
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
    publicImageDownloader: async () => ({ bytes: await pngBuffer(640, 360), mimeType: 'image/png' }),
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
        return {
          status: 'completed',
          provider_task_id: 'voice-duration-task',
          local_path: makeReadableFile(storageRoot, 'redraw-assets/v8/voice.mp3', 'mp3'),
          duration: 0,
        };
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
    (error) => error.code === 'REDRAW_VOICE_DURATION_REQUIRED'
      && error.provider_completed === true
      && error.provider_task_id === 'voice-duration-task',
  );
  assert.equal(created.length, 0);
  assert.equal(calls[0][2].text, 'Hello');
  assert.equal(calls[0][2].voice_id, 'voice-a');
  assert.equal(calls[0][2].config.model, 'verified-tts-model');
  assert.equal(calls[0][2].storage_base, storageRoot);
  assert.equal(calls[0][2].storage_subdir, 'redraw-assets/v8');
});

test('generateAsset voice rejects provider self-reported language without worker evidence', async () => {
  const storageRoot = tempStorage();
  const created = [];
  let readyLocale = null;
  const verifyCalls = [];
  const adapters = createRedrawProviderAdapters({
    db: {},
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    ttsConfig: { provider: 'openai', default_model: 'verified-tts-model' },
    ttsService: {
      async synthesize() {
        return {
          status: 'completed',
          provider_task_id: 'voice-provider-self-report',
          local_path: makeReadableFile(storageRoot, 'redraw-assets/v8/self-report.mp3', 'mp3'),
          duration: 1,
          detected_locale: 'en-US',
          language_verified: true,
        };
      },
    },
    localeVerifier: {
      assertReady(locale) {
        readyLocale = locale;
      },
      async verify(input) {
        verifyCalls.push(input);
        throw Object.assign(new Error('worker timeout'), { code: 'REDRAW_LOCALE_VERIFIER_TIMEOUT' });
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
      versionId: 8,
      model: 'verified-tts-model',
      locale: 'en-US',
      asset: { id: 6, kind: 'voice', prompt: 'Hello' },
    }),
    (error) => error.code === 'REDRAW_LOCALE_VERIFY_UNKNOWN'
      && error.provider_completed === true
      && error.provider_task_id === 'voice-provider-self-report',
  );
  assert.equal(readyLocale, 'en-US');
  assert.equal(verifyCalls.length, 1);
  assert.equal(verifyCalls[0].requestId, 'voice-provider-self-report');
  assert.equal(verifyCalls[0].approvedText, 'Hello');
  assert.equal(verifyCalls[0].ttsInvocation.providerTaskId, 'voice-provider-self-report');
  assert.equal(created.length, 0);
  assert.equal(fs.existsSync(path.join(storageRoot, 'redraw-assets/v8/self-report.mp3')), true);
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
        return { status: 'completed', provider_task_id: 'voice-probe-task', local_path: voicePath };
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
    (error) => error.code === 'REDRAW_VOICE_DURATION_REQUIRED'
      && error.provider_completed === true
      && error.provider_task_id === 'voice-probe-task',
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
        return { status: 'completed', provider_task_id: 'voice-register-task', local_path: voicePath };
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
    (error) => error.code === 'ASSET_CREATE_FAILED'
      && error.provider_completed === true
      && error.provider_task_id === 'voice-register-task',
  );
  assert.equal(fs.existsSync(path.join(storageRoot, voicePath)), false);
});

test('generateAsset voice marks scoped-path failure as post-provider with the real task id', async () => {
  const storageRoot = tempStorage();
  const adapters = createRedrawProviderAdapters({
    db: {},
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    ttsConfig: { provider: 'openai', default_model: 'verified-tts-model' },
    ttsService: {
      async synthesize() {
        return {
          status: 'completed',
          provider_task_id: 'voice-scope-task',
          local_path: '../outside.mp3',
          duration: 1,
        };
      },
    },
    assetService: { create() { throw new Error('must not register'); } },
  });

  await assert.rejects(
    () => adapters.generateAsset({
      versionId: 8,
      model: 'verified-tts-model',
      locale: 'en-US',
      asset: { id: 6, kind: 'voice', prompt: 'Hello' },
    }),
    (error) => error.code === 'REDRAW_ASSET_STORAGE_SCOPE_INVALID'
      && error.provider_completed === true
      && error.provider_task_id === 'voice-scope-task',
  );
});

test('generateAsset dialogue reuses TTS storage but writes isolated category and server metadata', async () => {
  const storageRoot = tempStorage();
  const synthCalls = [];
  const created = [];
  const adapters = createRedrawProviderAdapters({
    db: fakeTtsConfigDb(),
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    ttsConfig: { provider: 'openai', default_model: 'verified-dialogue-model' },
    ttsService: {
      async synthesize(...args) {
        synthCalls.push(args);
        return {
          local_path: makeReadableFile(storageRoot, 'redraw-assets/v8/dialogue.mp3', 'mp3'),
          duration: 1.25,
          provider_task_id: 'dialogue-provider-task',
        };
      },
    },
    assetService: {
      create(_db, _log, payload) {
        created.push(payload);
        return { id: 188, ...payload };
      },
    },
  });

  const result = await adapters.generateAsset({
    versionId: 8,
    model: 'verified-dialogue-model',
    locale: 'en-US',
    kind: 'dialogue',
    segment: {
      tenant_id: 'tenant-a',
      user_id: 'user-a',
      version_id: 8,
      segment_id: '801:0',
      text: 'Come with me.',
      voice_id: 'voice-c1',
      voice_snapshot: dialogueVoiceSnapshot(),
      idempotency_key: 'idem-dialogue',
      reservation_id: 'reservation-dialogue',
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.asset_id, 188);
  assert.equal(result.duration, 1.25);
  assert.equal(result.provider_task_id, 'dialogue-provider-task');
  assert.equal(synthCalls.length, 1);
  assert.equal(synthCalls[0][2].text, 'Come with me.');
  assert.equal(synthCalls[0][2].voice_id, 'voice-c1');
  assert.equal(synthCalls[0][2].storage_subdir, 'redraw-assets/v8');
  assert.equal(created[0].type, 'audio');
  assert.equal(created[0].category, 'redraw_dialogue');
  assert.equal(created[0].metadata.kind, 'dialogue');
  assert.equal(created[0].metadata.provider_task_id, 'dialogue-provider-task');
  assert.equal(created[0].metadata.provider, DIALOGUE_TTS_CONFIG.provider);
  assert.equal(created[0].metadata.model, DIALOGUE_TTS_CONFIG.default_model);
  assert.equal(created[0].metadata.ai_service_config_id, DIALOGUE_TTS_CONFIG.id);
  assert.equal(created[0].metadata.config_updated_at, DIALOGUE_TTS_CONFIG.updated_at);
  assert.deepEqual(created[0].metadata.voice_snapshot, dialogueVoiceSnapshot());
  assert.equal(typeof created[0].metadata.invocation_id, 'string');
  assert.deepEqual(created[0].metadata.redraw_dialogue, {
    tenant_id: 'tenant-a',
    user_id: 'user-a',
    version_id: 8,
    segment_id: '801:0',
    idempotency_key: 'idem-dialogue',
    reservation_id: 'reservation-dialogue',
    provider_task_id: 'dialogue-provider-task',
    provider: DIALOGUE_TTS_CONFIG.provider,
    model: DIALOGUE_TTS_CONFIG.default_model,
    ai_service_config_id: DIALOGUE_TTS_CONFIG.id,
    config_updated_at: DIALOGUE_TTS_CONFIG.updated_at,
    voice_snapshot: dialogueVoiceSnapshot(),
    invocation_id: created[0].metadata.invocation_id,
  });
});

test('generateAsset dialogue treats a completed-looking audio without provider task id as unknown', async () => {
  const storageRoot = tempStorage();
  const created = [];
  const adapters = createRedrawProviderAdapters({
    db: fakeTtsConfigDb(),
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    ttsService: {
      async synthesize() {
        return {
          status: 'completed',
          local_path: makeReadableFile(storageRoot, 'redraw-assets/v8/dialogue-no-task.mp3', 'mp3'),
          duration: 1.25,
        };
      },
    },
    assetService: {
      create(_db, _log, payload) {
        created.push(payload);
        return { id: 189, ...payload };
      },
    },
  });

  await assert.rejects(
    () => adapters.generateAsset({
      versionId: 8,
      model: 'verified-dialogue-model',
      locale: 'en-US',
      market: 'US',
      kind: 'dialogue',
      segment: {
        tenant_id: 'tenant-a',
        user_id: 'user-a',
        version_id: 8,
        segment_id: '801:1',
        text: 'Do not confirm this charge.',
        voice_id: 'voice-c1',
        voice_snapshot: dialogueVoiceSnapshot(),
        idempotency_key: 'idem-dialogue-no-task',
        reservation_id: 'reservation-dialogue-no-task',
      },
    }),
    (error) => error.code === 'PROVIDER_STATUS_UNKNOWN' && error.unknown === true,
  );
  assert.equal(created.length, 0);
});

test('generateAsset dialogue rejects failed provider result before registration and retains task id', async () => {
  const storageRoot = tempStorage();
  const created = [];
  const localPath = makeReadableFile(storageRoot, 'redraw-assets/v8/dialogue-failed.mp3', 'mp3');
  const adapters = createRedrawProviderAdapters({
    db: fakeTtsConfigDb(),
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    ttsService: {
      async synthesize() {
        return {
          status: 'failed',
          error: 'provider rejected dialogue',
          provider_task_id: 'dialogue-failed-task',
          local_path: localPath,
          duration: 1.25,
        };
      },
    },
    assetService: {
      create(_db, _log, payload) {
        created.push(payload);
        return { id: 190, ...payload };
      },
    },
  });

  await assert.rejects(
    () => adapters.generateAsset({
      versionId: 8,
      model: 'verified-dialogue-model',
      locale: 'en-US',
      market: 'US',
      kind: 'dialogue',
      segment: {
        tenant_id: 'tenant-a',
        user_id: 'user-a',
        version_id: 8,
        segment_id: '801:2',
        text: 'Do not register this failed dialogue.',
        voice_id: 'voice-c1',
        voice_snapshot: dialogueVoiceSnapshot(),
        idempotency_key: 'idem-dialogue-failed',
        reservation_id: 'reservation-dialogue-failed',
      },
    }),
    (error) => error.code === 'REDRAW_DIALOGUE_PROVIDER_FAILED'
      && error.provider_completed === true
      && error.provider_task_id === 'dialogue-failed-task',
  );
  assert.equal(created.length, 0);
  assert.equal(fs.existsSync(path.join(storageRoot, localPath)), true);
});

test('dialogue post-provider storage and registration failures retain the provider completion trace', async (t) => {
  const cases = [
    {
      name: 'scoped path',
      localPath: '../outside.mp3',
      create() { throw new Error('must not register'); },
      code: 'REDRAW_ASSET_STORAGE_SCOPE_INVALID',
    },
    {
      name: 'registration',
      localPath: 'redraw-assets/v8/register-failure.mp3',
      create() { throw Object.assign(new Error('asset insert failed'), { code: 'ASSET_CREATE_FAILED' }); },
      code: 'ASSET_CREATE_FAILED',
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const storageRoot = tempStorage();
      const localPath = item.localPath.startsWith('redraw-assets/')
        ? makeReadableFile(storageRoot, item.localPath, 'mp3')
        : item.localPath;
      try {
        const adapters = createRedrawProviderAdapters({
          db: fakeTtsConfigDb(),
          log: createLog(),
          cfg: { storage: { local_path: storageRoot } },
          ttsService: {
            async synthesize() {
              return {
                status: 'completed',
                provider_task_id: `dialogue-${item.name}-task`,
                local_path: localPath,
                duration: 1,
              };
            },
          },
          assetService: { create: item.create },
        });
        await assert.rejects(
          adapters.generateAsset({
            versionId: 8,
            model: 'verified-dialogue-model',
            locale: 'en-US',
            market: 'US',
            kind: 'dialogue',
            segment: {
              tenant_id: 'tenant-a',
              user_id: 'user-a',
              version_id: 8,
              segment_id: '801:2',
              text: 'Retain the provider trace.',
              voice_id: 'voice-c1',
              voice_snapshot: dialogueVoiceSnapshot(),
              idempotency_key: `dialogue-${item.name}`,
              reservation_id: `reservation-${item.name}`,
            },
          }),
          (error) => error.code === item.code
            && error.provider_completed === true
            && error.provider_task_id === `dialogue-${item.name}-task`,
        );
      } finally {
        fs.rmSync(storageRoot, { recursive: true, force: true });
      }
    });
  }
});

test('dialogue adapter uses the exact pinned provider/config and rejects rewritten or inactive pins before TTS', async (t) => {
  const pinned = {
    ...DIALOGUE_TTS_CONFIG,
    id: 89,
    provider: 'provider-b',
    name: 'provider B exact pin',
  };
  const request = {
    versionId: 8,
    model: pinned.default_model,
    locale: 'en-US',
    market: 'US',
    kind: 'dialogue',
    segment: {
      tenant_id: 'tenant-a',
      user_id: 'user-a',
      version_id: 8,
      segment_id: '801:0',
      text: 'Pinned provider.',
      voice_id: 'voice-b',
      voice_snapshot: {
        provider: pinned.provider,
        model: pinned.default_model,
        ai_service_config_id: pinned.id,
        config_updated_at: pinned.updated_at,
      },
      idempotency_key: 'pinned-provider-b',
      reservation_id: 'reservation-provider-b',
    },
  };

  await t.test('provider B wins over injected provider A with the same model', async () => {
    const storageRoot = tempStorage();
    const synthCalls = [];
    try {
      const adapters = createRedrawProviderAdapters({
        db: fakeTtsConfigDb(pinned),
        log: createLog(),
        cfg: { storage: { local_path: storageRoot } },
        ttsConfig: { ...pinned, id: 90, provider: 'provider-a' },
        ttsService: {
          async synthesize(_db, _log, options) {
            synthCalls.push(options);
            return {
              status: 'completed',
              provider_task_id: 'dialogue-provider-b',
              local_path: makeReadableFile(storageRoot, 'redraw-assets/v8/pinned-b.mp3', 'mp3'),
              duration: 1,
            };
          },
        },
        assetService: { create(_db, _log, payload) { return { id: 190, ...payload }; } },
      });
      await adapters.generateAsset(request);
      assert.equal(synthCalls.length, 1);
      assert.equal(synthCalls[0].config.id, pinned.id);
      assert.equal(synthCalls[0].config.provider, 'provider-b');
    } finally {
      fs.rmSync(storageRoot, { recursive: true, force: true });
    }
  });

  for (const invalid of [
    { name: 'rewritten', config: { ...pinned, updated_at: '2026-08-08T00:00:01.000Z' } },
    { name: 'inactive', config: { ...pinned, is_active: false } },
  ]) {
    await t.test(invalid.name, async () => {
      const storageRoot = tempStorage();
      let synthCalls = 0;
      try {
        const adapters = createRedrawProviderAdapters({
          db: fakeTtsConfigDb(invalid.config),
          log: createLog(),
          cfg: { storage: { local_path: storageRoot } },
          ttsService: { async synthesize() { synthCalls += 1; } },
          assetService: { create() { throw new Error('must not register'); } },
        });
        await assert.rejects(
          adapters.generateAsset(request),
          (error) => error.code === 'REDRAW_TTS_CONFIG_PIN_INVALID',
        );
        assert.equal(synthCalls, 0);
      } finally {
        fs.rmSync(storageRoot, { recursive: true, force: true });
      }
    });
  }
});

test('generateAsset dialogue throws unknown provider result for needs_attention handling', async () => {
  const storageRoot = tempStorage();
  const adapters = createRedrawProviderAdapters({
    db: fakeTtsConfigDb(),
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    ttsConfig: { provider: 'openai', default_model: 'verified-dialogue-model' },
    ttsService: {
      async synthesize() {
        return { status: 'unknown', provider_task_id: 'provider-unknown' };
      },
    },
    assetService: {
      create() {
        throw new Error('unknown result must not register asset');
      },
    },
  });

  await assert.rejects(
    () => adapters.generateAsset({
      versionId: 8,
      model: 'verified-dialogue-model',
      locale: 'en-US',
      kind: 'dialogue',
      segment: {
        tenant_id: 'tenant-a',
        user_id: 'user-a',
        version_id: 8,
        segment_id: '801:0',
        text: 'Come with me.',
        voice_snapshot: dialogueVoiceSnapshot(),
        idempotency_key: 'idem-dialogue',
        reservation_id: 'reservation-dialogue',
      },
    }),
    (error) => error.code === 'PROVIDER_STATUS_UNKNOWN'
      && error.unknown === true
      && error.provider_task_id === 'provider-unknown',
  );
});

test('generateAsset dialogue fails closed without server segment bindings before TTS', async () => {
  const storageRoot = tempStorage();
  let synthCalls = 0;
  const adapters = createRedrawProviderAdapters({
    db: {},
    log: createLog(),
    cfg: { storage: { local_path: storageRoot } },
    ttsConfig: { provider: 'openai', default_model: 'verified-dialogue-model' },
    ttsService: {
      async synthesize() {
        synthCalls += 1;
        return { local_path: makeReadableFile(storageRoot, 'redraw-assets/v8/dialogue.mp3', 'mp3'), duration: 1 };
      },
    },
    assetService: { create(_db, _log, payload) { return { id: 1, ...payload }; } },
  });

  await assert.rejects(
    () => adapters.generateAsset({
      versionId: 8,
      model: 'verified-dialogue-model',
      kind: 'dialogue',
      segment: {
        tenant_id: 'tenant-a',
        user_id: 'user-a',
        version_id: 8,
        segment_id: '801:0',
        text: 'Come with me.',
        voice_id: 'voice-c1',
        idempotency_key: 'idem-dialogue',
      },
    }),
    (error) => error.code === 'REDRAW_DIALOGUE_CONTEXT_REQUIRED',
  );
  assert.equal(synthCalls, 0);
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
  const localeVerifier = { assertReady() {}, async verify() {} };
  const candidateQualityVerifier = async () => ({ decision: 'pass' });
  const candidateQualityDependencies = {
    probeMedia: async () => ({}),
    verifyFullFrameCoverage: async () => ({}),
    verifyLocale: async () => ({}),
    verifyNativeAudio: async () => ({}),
    verifySubtitles: async () => ({}),
    verifyLipSync: async () => ({}),
  };
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
    setupRouter({ storage: {} }, {}, createLog(), {
      localeVerifier,
      candidateQualityVerifier,
      candidateQualityDependencies,
    });
    assert.equal(seen.some((entry) => entry.localizationProvider === fakeAdapters.localize), true);
    const redrawOptions = seen.find((entry) => typeof entry.assetGenerationProvider === 'function'
      && !entry.factoryDeps);
    assert.notEqual(redrawOptions.assetGenerationProvider, fakeAdapters.generateAsset);
    assert.equal(typeof redrawOptions.dialogueProvider, 'function');
  await redrawOptions.assetGenerationProvider({
      attempt: { id: 1, kind: 'prop' },
      input: { model: 'server-verified-model', provider: 'ignored-input-provider' },
      versionId: 7,
    });
    assert.equal(adapterRequests.length, 1);
    assert.equal(adapterRequests[0].model, 'server-verified-model');
    assert.equal(adapterRequests[0].provider, undefined);
    assert.equal(adapterRequests[0].input.model, 'server-verified-model');
    await redrawOptions.dialogueProvider({
      segment: { text: 'Hello' },
      model: 'server-dialogue-model',
      versionId: 7,
    });
    assert.equal(adapterRequests.length, 2);
    assert.equal(adapterRequests[1].kind, 'dialogue');
    assert.equal(adapterRequests[1].model, 'server-dialogue-model');
    const factoryDeps = seen.find((entry) => entry.factoryDeps).factoryDeps;
    assert.equal(factoryDeps.localeVerifier, localeVerifier);
    assert.equal(adapterRequests[0].localeVerifier, factoryDeps.localeVerifier);
    assert.equal(adapterRequests[1].localeVerifier, factoryDeps.localeVerifier);
    assert.equal(redrawOptions.candidateQualityVerifier, candidateQualityVerifier);
    assert.equal(redrawOptions.candidateQualityDependencies, candidateQualityDependencies);
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
  const dialogueProvider = async () => ({});
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
      redrawOptions: { localizationProvider, assetGenerationProvider, dialogueProvider },
    });
    assert.equal(seen.some((entry) => entry.localizationProvider === localizationProvider), true);
    assert.equal(seen.some((entry) => entry.assetGenerationProvider === assetGenerationProvider), true);
    assert.equal(seen.some((entry) => entry.dialogueProvider === dialogueProvider), true);
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
  mock('../src/services/redrawDialogueOrchestrator', {
    reconcileOrphanedDialogueTasks: () => { order.push('dialogue'); return { needs_attention: 0 }; },
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
    assert.deepEqual(order, ['analysis', 'localization', 'batch', 'dialogue', 'generic']);
  } finally {
    delete require.cache[appPath];
    for (const [resolved, original] of moduleMocks) {
      if (original) require.cache[resolved] = original;
      else delete require.cache[resolved];
    }
  }
});
