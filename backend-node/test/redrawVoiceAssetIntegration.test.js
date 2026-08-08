const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const realAssetService = require('../src/services/assetService');
const aiConfigService = require('../src/services/aiConfigService');
const creditLedger = require('../src/services/creditLedgerService');
const modelPrice = require('../src/services/modelPriceService');
const redrawAssetService = require('../src/services/redrawAssetService');
const { quoteAssetBatch, startAssetBatch } = require('../src/services/redrawAssetBatchService');
const { createRedrawProviderAdapters } = require('../src/services/redrawProviderAdapters');
const redrawVoiceService = require('../src/services/redrawVoiceService');

const TENANT_ID = 'tenant-a';
const USER_ID = 'user-a';
const LOCALE = 'en-US';
const MARKET = 'US';
const MODEL = 'verified-tts-model';
const PROVIDER = 'verified-tts-provider';

function createState() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-voice-integration-'));
  const now = new Date().toISOString();
  fs.mkdirSync(path.join(root, 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(root, 'fixtures', 'source.png'), 'source');
  fs.writeFileSync(path.join(root, 'fixtures', 'capability.txt'), 'verified capability');
  db.prepare(`INSERT INTO assets
    (id, name, type, category, url, local_path, mime_type, width, height, created_at, updated_at)
    VALUES
      (101, 'source', 'image', 'source', '', 'fixtures/source.png', 'image/png', 640, 360, ?, ?),
      (900, 'capability', 'text', 'evidence', '', 'fixtures/capability.txt', 'text/plain', NULL, NULL, ?, ?)`)
    .run(now, now, now, now);
  db.prepare(`INSERT INTO redraw_projects
    (tenant_id, user_id, title, created_at, updated_at)
    VALUES (?, ?, 'Voice integration', ?, ?)`).run(TENANT_ID, USER_ID, now, now);
  db.prepare(`INSERT INTO redraw_works
    (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms, created_at, updated_at)
    VALUES (1, ?, ?, 'Voice work', 101, ?, 15000, ?, ?)`)
    .run(TENANT_ID, USER_ID, 'f'.repeat(64), now, now);
  const workId = Number(db.prepare('SELECT id FROM redraw_works LIMIT 1').get().id);
  db.prepare(`INSERT INTO redraw_versions
    (work_id, tenant_id, user_id, version, locale, market, source_facts_json, facts_hash, status, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, '{}', 'facts', 'asset_review', ?, ?)`)
    .run(workId, TENANT_ID, USER_ID, LOCALE, MARKET, now, now);
  const versionId = Number(db.prepare('SELECT id FROM redraw_versions LIMIT 1').get().id);
  const ttsConfigId = Number(db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, name, model, default_model, priority, is_default, is_active, settings, created_at, updated_at)
    VALUES ('tts', ?, 'base verified TTS', ?, ?, 0, 0, 1, '{}', ?, ?)`)
    .run(PROVIDER, JSON.stringify([MODEL]), MODEL, now, now).lastInsertRowid);
  const ttsConfig = aiConfigService.getConfig(db, ttsConfigId);

  const canRead = (asset) => Boolean(asset?.local_path && fs.existsSync(path.join(root, asset.local_path)));
  const ctx = {
    db,
    versionId,
    tenantId: TENANT_ID,
    userId: USER_ID,
    assetReader: { canRead },
    canReadArtifact(assetId) {
      return canRead(db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(Number(assetId)));
    },
  };
  return { db, root, versionId, ctx, canRead, ttsConfig };
}

function insertDraft(state, kind, sourceRef, prompt, name) {
  const now = new Date().toISOString();
  return Number(state.db.prepare(`INSERT INTO redraw_assets
    (version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     localized_description, prompt, version_number, approval_status, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', 'draft', ?, ?)`)
    .run(
      state.versionId,
      TENANT_ID,
      USER_ID,
      kind,
      JSON.stringify({ source_ref: sourceRef }),
      name,
      `${name} description`,
      prompt,
      now,
      now,
    ).lastInsertRowid);
}

function insertAuthorizationAsset(state, { tenantId = TENANT_ID, userId = USER_ID, filename }) {
  const now = new Date().toISOString();
  const dramaId = Number(state.db.prepare(`INSERT INTO dramas
    (title, tenant_id, user_id, created_at, updated_at)
    VALUES ('Authorization owner', ?, ?, ?, ?)`)
    .run(tenantId, userId, now, now).lastInsertRowid);
  const localPath = `fixtures/${filename}`;
  fs.writeFileSync(path.join(state.root, localPath), 'voice authorization');
  return Number(state.db.prepare(`INSERT INTO assets
    (drama_id, name, type, category, url, local_path, mime_type, created_at, updated_at)
    VALUES (?, 'Voice authorization', 'text', 'voice_authorization', '', ?, 'text/plain', ?, ?)`)
    .run(dramaId, localPath, now, now).lastInsertRowid);
}

function createLocaleVerifier(calls = [], overrides = {}) {
  return {
    assertReady(locale) {
      if (overrides.readyError) throw overrides.readyError;
      calls.push({ type: 'ready', locale });
    },
    async verify(input) {
      calls.push({ type: 'verify', input });
      if (overrides.verifyError) throw overrides.verifyError;
      return {
        languageVerified: true,
        detectedLocale: input.locale,
        source: 'offline-worker',
        localePack: `${input.locale}@1`,
        modelManifestSha256: 'a'.repeat(64),
        calibrationManifestSha256: 'b'.repeat(64),
        ...overrides.evidence,
      };
    },
  };
}

function createVoiceAdapter(state, providerTaskId, calls, resultOverrides = {}, options = {}) {
  const verifierCalls = options.verifierCalls || [];
  const deps = {
    db: state.db,
    log: { info() {}, warn() {}, error() {} },
    cfg: { storage: { local_path: state.root } },
    localeVerifier: options.localeVerifier || createLocaleVerifier(verifierCalls),
    ttsService: {
      async synthesize(_db, _log, options) {
        calls.push(options);
        const localPath = `redraw-assets/v${state.versionId}/${providerTaskId}.mp3`;
        const absolutePath = path.join(state.root, localPath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, 'provider audio');
        return {
          status: 'completed',
          provider_task_id: providerTaskId,
          local_path: localPath,
          duration: 1.25,
          detected_locale: LOCALE,
          language_verified: true,
          is_cloned: false,
          ...resultOverrides,
        };
      },
    },
    assetService: {
      create(db, log, payload) {
        return realAssetService.create(db, log, payload);
      },
    },
  };
  if (options.useDatabaseTtsConfig !== true) {
    deps.ttsConfig = state.ttsConfig;
  }
  const adapter = createRedrawProviderAdapters(deps);
  adapter.verifierCalls = verifierCalls;
  return adapter;
}

function voiceSnapshot(state, overrides = {}) {
  return {
    model: MODEL,
    provider: PROVIDER,
    ai_service_config_id: state.ttsConfig.id,
    config_updated_at: state.ttsConfig.updated_at,
    ...overrides,
  };
}

function addVerifiedTtsCapability(state, options = {}) {
  const carrierConfigId = Number(options.carrierConfigId || state.ttsConfig.id);
  const evidenceConfigId = Number(options.evidenceConfigId || carrierConfigId);
  const carrier = aiConfigService.getConfig(state.db, carrierConfigId);
  const evidenceConfig = aiConfigService.getConfig(state.db, evidenceConfigId);
  const settings = JSON.parse(carrier.settings || '{}');
  settings.redraw_locale_capabilities = [{
    locale: LOCALE,
    market: MARKET,
    status: 'verified',
    evidence: {
      tts: {
        provider: options.provider || PROVIDER,
        model: options.model || MODEL,
        task_id: options.taskId || 'capability-task',
        terminal_status: 'completed',
        artifact_id: 900,
        ai_service_config_id: evidenceConfigId,
        config_updated_at: options.configUpdatedAt || evidenceConfig?.updated_at,
      },
    },
  }];
  state.db.prepare('UPDATE ai_service_configs SET settings = ? WHERE id = ?')
    .run(JSON.stringify(settings), carrierConfigId);
}

function assertProductionVoiceAndBind(state, voiceAttemptId, characterAssetId, providerTaskId) {
  const payload = JSON.parse(state.db.prepare('SELECT source_ref_json FROM redraw_assets WHERE id = ?')
    .get(voiceAttemptId).source_ref_json);
  assert.equal(payload.snapshot.voice_evidence.task_id, providerTaskId);
  assert.equal(payload.snapshot.voice_evidence.locale, LOCALE);
  assert.equal(payload.snapshot.voice_evidence.market, MARKET);
  assert.equal(payload.snapshot.voice_evidence.terminal_status, 'completed');
  assert.ok(payload.snapshot.voice_evidence.ai_service_config_id > 0);
  assert.ok(payload.snapshot.voice_evidence.config_updated_at);
  assert.equal(payload.snapshot.voice_evidence.language_verified, true);
  assert.equal(payload.snapshot.voice_evidence.detected_locale, LOCALE);
  assert.equal(payload.snapshot.voice_evidence.real_generation_verified, true);
  assert.ok(payload.snapshot.voice_evidence.audio_asset_id > 0);

  const voices = redrawVoiceService.listProductionVoices(state.db, {
    tenantId: TENANT_ID,
    userId: USER_ID,
    locale: LOCALE,
    market: MARKET,
  }, state.canRead);
  assert.equal(voices.length, 1);
  assert.equal(Number(voices[0].id), Number(voiceAttemptId));
  assert.equal(voices[0].task_id, providerTaskId);
  const assigned = redrawVoiceService.assignVoice(state.db, characterAssetId, voices[0], {
    tenantId: TENANT_ID,
    userId: USER_ID,
    versionId: state.versionId,
    voiceAssetId: voiceAttemptId,
    canReadAsset: state.canRead,
  });
  assert.equal(assigned.conflict, false);
  assert.equal(assigned.snapshot.task_id, providerTaskId);
  assert.equal(assigned.snapshot.locale, LOCALE);
}

test('single real voice provider completion derives locale/market from the owned version and becomes bindable', async () => {
  const state = createState();
  const calls = [];
  try {
    const voiceSource = { id: 'voice-single', voice_id: 'voice-en-us', is_cloned: false };
    const voiceAssetId = insertDraft(state, 'voice', voiceSource, 'Welcome home.', 'Narrator');
    const characterAssetId = insertDraft(state, 'character', { character_id: 'maya' }, 'Maya', 'Maya');
    const adapter = createVoiceAdapter(state, 'provider-single-1', calls);

    const generated = await redrawAssetService.generateAsset({
      ...state.ctx,
      provider: adapter.generateAsset,
    }, {
      kind: 'voice',
      sourceRef: voiceSource,
      localizedName: 'Narrator',
      prompt: 'Welcome home.',
      model: MODEL,
      snapshot: voiceSnapshot(state),
    });

    assert.equal(generated.id, voiceAssetId);
    assert.equal(generated.status, 'generated');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].locale, LOCALE);
    assert.equal(calls[0].market, MARKET);
    assertProductionVoiceAndBind(state, voiceAssetId, characterAssetId, 'provider-single-1');
  } finally {
    state.db.close();
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('batch real voice provider completion preserves capability evidence and stores actual voice evidence for binding', async () => {
  const state = createState();
  const calls = [];
  try {
    const now = new Date().toISOString();
    modelPrice.set(state.db, MODEL, 3, { category: 'audio' });
    creditLedger.setTenantAccountBalance(state.db, TENANT_ID, 10);
    state.db.prepare(`INSERT INTO ai_service_configs
      (service_type, provider, name, model, default_model, priority, is_default, is_active, settings, created_at, updated_at)
      VALUES ('tts', 'wrong-first-provider', 'wrong first TTS', ?, ?, 100, 1, 1, '{}', ?, ?)`)
      .run(JSON.stringify([MODEL]), MODEL, now, now);
    const pinnedTtsConfigId = Number(state.db.prepare(`INSERT INTO ai_service_configs
      (service_type, provider, name, model, default_model, priority, is_default, is_active, settings, created_at, updated_at)
      VALUES ('tts', ?, 'pinned TTS', ?, ?, 10, 0, 1, '{}', ?, ?)`)
      .run(PROVIDER, JSON.stringify([MODEL]), MODEL, now, now).lastInsertRowid);
    addVerifiedTtsCapability(state, { carrierConfigId: pinnedTtsConfigId });
    const voiceSource = { id: 'voice-batch', voice_id: 'voice-en-us', is_cloned: false };
    const voiceAssetId = insertDraft(state, 'voice', voiceSource, 'Stay with me.', 'Maya voice');
    const characterAssetId = insertDraft(state, 'character', { character_id: 'maya' }, 'Maya', 'Maya');
    const quote = quoteAssetBatch(state.db, { ...state.ctx, assetIds: [voiceAssetId] });
    assert.equal(quote.priced, true);
    const adapter = createVoiceAdapter(state, 'provider-batch-1', calls, {}, { useDatabaseTtsConfig: true });

    const started = startAssetBatch({
      ...state.ctx,
      provider: adapter.generateAsset,
      schedule: (job) => job(),
    }, {
      quoteHash: quote.quote_hash,
      idempotencyKey: 'voice-batch-real-provider',
      assetIds: [voiceAssetId],
    });
    const completed = await started.completion;

    assert.equal(completed.status, 'completed');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].locale, LOCALE);
    assert.equal(calls[0].market, MARKET);
    assert.equal(calls[0].config.id, pinnedTtsConfigId);
    assert.equal(calls[0].config.provider, PROVIDER);
    const attemptId = Number(started.batch.asset_ids[0]);
    const payload = JSON.parse(state.db.prepare('SELECT source_ref_json FROM redraw_assets WHERE id = ?')
      .get(attemptId).source_ref_json);
    assert.equal(payload.snapshot.evidence.task_id, 'capability-task');
    assertProductionVoiceAndBind(state, attemptId, characterAssetId, 'provider-batch-1');
  } finally {
    state.db.close();
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('batch quote blocks a TTS capability whose pinned config provider does not match before reservation or dispatch', () => {
  const state = createState();
  let providerCalls = 0;
  try {
    const now = new Date().toISOString();
    modelPrice.set(state.db, MODEL, 3, { category: 'audio' });
    creditLedger.setTenantAccountBalance(state.db, TENANT_ID, 10);
    const wrongConfigId = Number(state.db.prepare(`INSERT INTO ai_service_configs
      (service_type, provider, name, model, default_model, priority, is_default, is_active, settings, created_at, updated_at)
      VALUES ('tts', 'provider-a', 'provider A', ?, ?, 100, 1, 1, '{}', ?, ?)`)
      .run(JSON.stringify([MODEL]), MODEL, now, now).lastInsertRowid);
    state.db.prepare(`INSERT INTO ai_service_configs
      (service_type, provider, name, model, default_model, priority, is_default, is_active, settings, created_at, updated_at)
      VALUES ('tts', 'provider-b', 'provider B', ?, ?, 10, 0, 1, '{}', ?, ?)`)
      .run(JSON.stringify([MODEL]), MODEL, now, now);
    addVerifiedTtsCapability(state, {
      carrierConfigId: wrongConfigId,
      provider: 'provider-b',
      taskId: 'capability-provider-b',
    });
    const voiceAssetId = insertDraft(state, 'voice', {
      id: 'mismatched-pin', voice_id: 'voice-en-us', is_cloned: false,
    }, 'Pinned sample.', 'Pinned voice');

    const quote = quoteAssetBatch(state.db, { ...state.ctx, assetIds: [voiceAssetId] });
    assert.equal(quote.priced, false);
    assert.equal(quote.blocked[0].code, 'REDRAW_TTS_CONFIG_PIN_INVALID');
    assert.throws(
      () => startAssetBatch({
        ...state.ctx,
        provider: async () => {
          providerCalls += 1;
          return { status: 'completed' };
        },
      }, {
        quoteHash: quote.quote_hash,
        idempotencyKey: 'mismatched-tts-pin',
        assetIds: [voiceAssetId],
      }),
      (error) => error.code === 'REDRAW_ASSET_BATCH_UNPRICED',
    );
    assert.equal(providerCalls, 0);
    assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 0);
    assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM async_tasks').get().count, 0);
  } finally {
    state.db.close();
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('batch quote rejects stale TTS evidence and evidence carried by a different config row before billing or dispatch', async (t) => {
  for (const mismatch of ['stale-config-version', 'different-carrier-row']) {
    await t.test(mismatch, () => {
      const state = createState();
      let providerCalls = 0;
      try {
        modelPrice.set(state.db, MODEL, 3, { category: 'audio' });
        creditLedger.setTenantAccountBalance(state.db, TENANT_ID, 10);
        if (mismatch === 'stale-config-version') {
          addVerifiedTtsCapability(state, { configUpdatedAt: '2026-01-01T00:00:00.000Z' });
        } else {
          const now = new Date().toISOString();
          const otherConfigId = Number(state.db.prepare(`INSERT INTO ai_service_configs
            (service_type, provider, name, model, default_model, priority, is_default, is_active, settings, created_at, updated_at)
            VALUES ('tts', ?, 'same model other config', ?, ?, 0, 0, 1, '{}', ?, ?)`)
            .run(PROVIDER, JSON.stringify([MODEL]), MODEL, now, now).lastInsertRowid);
          addVerifiedTtsCapability(state, {
            carrierConfigId: state.ttsConfig.id,
            evidenceConfigId: otherConfigId,
          });
        }
        const voiceAssetId = insertDraft(state, 'voice', {
          id: `invalid-pin-${mismatch}`, voice_id: 'voice-en-us', is_cloned: false,
        }, 'Pinned sample.', 'Pinned voice');

        const quote = quoteAssetBatch(state.db, { ...state.ctx, assetIds: [voiceAssetId] });
        assert.equal(quote.priced, false);
        assert.equal(quote.blocked[0].code, 'REDRAW_TTS_CONFIG_PIN_INVALID');
        assert.throws(
          () => startAssetBatch({
            ...state.ctx,
            provider: async () => {
              providerCalls += 1;
              return { status: 'completed' };
            },
          }, {
            quoteHash: quote.quote_hash,
            idempotencyKey: `invalid-pin-${mismatch}`,
            assetIds: [voiceAssetId],
          }),
          (error) => error.code === 'REDRAW_ASSET_BATCH_UNPRICED',
        );
        assert.equal(providerCalls, 0);
        assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 0);
        assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM async_tasks').get().count, 0);
      } finally {
        state.db.close();
        fs.rmSync(state.root, { recursive: true, force: true });
      }
    });
  }
});

test('batch completed voice with worker locale verification timeout keeps attempt, child, parent, batch and billing in needs_attention', async () => {
  const state = createState();
  const calls = [];
  try {
    modelPrice.set(state.db, MODEL, 3, { category: 'audio' });
    creditLedger.setTenantAccountBalance(state.db, TENANT_ID, 10);
    addVerifiedTtsCapability(state);
    const voiceSource = { id: 'voice-batch-incomplete', voice_id: 'voice-en-us', is_cloned: false };
    const voiceAssetId = insertDraft(state, 'voice', voiceSource, 'Incomplete sample.', 'Incomplete voice');
    const quote = quoteAssetBatch(state.db, { ...state.ctx, assetIds: [voiceAssetId] });
    assert.equal(quote.priced, true);
    const verifyError = Object.assign(new Error('worker verification timed out'), {
      code: 'REDRAW_LOCALE_VERIFIER_TIMEOUT',
    });
    const verifierCalls = [];
    const adapter = createVoiceAdapter(state, 'provider-batch-incomplete', calls, {
      language_verified: true,
      detected_locale: LOCALE,
    }, {
      verifierCalls,
      localeVerifier: createLocaleVerifier(verifierCalls, { verifyError }),
    });
    const started = startAssetBatch({
      ...state.ctx,
      provider: adapter.generateAsset,
      schedule: (job) => job(),
    }, {
      quoteHash: quote.quote_hash,
      idempotencyKey: 'voice-batch-incomplete',
      assetIds: [voiceAssetId],
    });
    const completed = await started.completion;
    const attemptId = Number(started.batch.asset_ids[0]);
    const attempt = state.db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(attemptId);
    const child = state.db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(attempt.generation_task_id);
    const parent = state.db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(started.task.id);
    assert.equal(calls.length, 1);
    assert.equal(verifierCalls.some((call) => call.type === 'verify'), true);
    assert.equal(attempt.status, 'needs_attention');
    assert.equal(attempt.error_code, 'REDRAW_ASSET_PROVIDER_UNKNOWN');
    assert.equal(child.status, 'needs_attention');
    assert.equal(parent.status, 'needs_attention');
    assert.equal(completed.status, 'needs_attention');
    assert.equal(creditLedger.getReservation(state.db, attempt.credit_reservation_id).status, 'held');
    assert.equal(quoteAssetBatch(state.db, { ...state.ctx, assetIds: [attemptId] }).items.length, 0);
  } finally {
    state.db.close();
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('single completed voice with worker locale verification timeout keeps real provider task id and audio for review', async () => {
  const state = createState();
  const calls = [];
  const verifierCalls = [];
  const providerTaskId = 'provider-single-locale-timeout';
  const verifyError = Object.assign(new Error('worker verification timed out'), {
    code: 'REDRAW_LOCALE_VERIFIER_TIMEOUT',
  });
  try {
    creditLedger.setTenantAccountBalance(state.db, TENANT_ID, 10);
    const voiceSource = { id: 'voice-single-locale-timeout', voice_id: 'voice-en-us', is_cloned: false };
    const voiceAssetId = insertDraft(state, 'voice', voiceSource, 'Timeout sample.', 'Timeout voice');
    const adapter = createVoiceAdapter(state, providerTaskId, calls, {
      detected_locale: LOCALE,
      language_verified: true,
    }, {
      verifierCalls,
      localeVerifier: createLocaleVerifier(verifierCalls, { verifyError }),
    });

    const generated = await redrawAssetService.generateAsset({
      ...state.ctx,
      provider: adapter.generateAsset,
      creditAmount: 3,
    }, {
      kind: 'voice',
      sourceRef: voiceSource,
      prompt: 'Timeout sample.',
      model: MODEL,
      snapshot: voiceSnapshot(state),
    });

    const payload = JSON.parse(state.db.prepare('SELECT source_ref_json FROM redraw_assets WHERE id = ?')
      .get(voiceAssetId).source_ref_json);
    const audioPath = path.join(state.root, `redraw-assets/v${state.versionId}/${providerTaskId}.mp3`);
    assert.equal(calls.length, 1);
    assert.equal(verifierCalls.some((call) => call.type === 'verify'), true);
    assert.equal(generated.status, 'needs_attention');
    assert.equal(generated.error_code, 'REDRAW_LOCALE_VERIFY_UNKNOWN');
    assert.equal(payload.snapshot.provider_task_id, providerTaskId);
    assert.equal(creditLedger.getReservation(state.db, generated.credit_reservation_id).status, 'held');
    assert.equal(fs.existsSync(audioPath), true);
    await assert.rejects(
      redrawAssetService.generateAsset({
        ...state.ctx,
        provider: adapter.generateAsset,
        creditAmount: 3,
      }, {
        kind: 'voice',
        sourceRef: voiceSource,
        prompt: 'Timeout sample.',
        model: MODEL,
        snapshot: voiceSnapshot(state),
      }),
      (error) => error.code === 'REDRAW_ASSET_ATTEMPT_NEEDS_ATTENTION',
    );
    assert.equal(calls.length, 1);
  } finally {
    state.db.close();
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('batch PROVIDER_STATUS_UNKNOWN keeps attempt, child, parent, batch and billing held without replay dispatch', async () => {
  const state = createState();
  let providerCalls = 0;
  try {
    modelPrice.set(state.db, MODEL, 3, { category: 'audio' });
    creditLedger.setTenantAccountBalance(state.db, TENANT_ID, 10);
    addVerifiedTtsCapability(state);
    const voiceAssetId = insertDraft(state, 'voice', {
      id: 'voice-batch-provider-unknown', voice_id: 'voice-en-us', is_cloned: false,
    }, 'Unknown batch sample.', 'Unknown voice');
    const quote = quoteAssetBatch(state.db, { ...state.ctx, assetIds: [voiceAssetId] });
    const provider = async () => {
      providerCalls += 1;
      const error = new Error('provider response status could not be audited');
      error.code = 'PROVIDER_STATUS_UNKNOWN';
      error.unknown = true;
      error.provider_task_id = 'provider-batch-unknown';
      throw error;
    };
    const request = {
      quoteHash: quote.quote_hash,
      idempotencyKey: 'voice-batch-provider-unknown',
      assetIds: [voiceAssetId],
    };
    const context = { ...state.ctx, provider, schedule: (job) => job() };
    const started = startAssetBatch(context, request);
    const completed = await started.completion;
    const attempt = state.db.prepare('SELECT * FROM redraw_assets WHERE id = ?')
      .get(Number(started.batch.asset_ids[0]));
    const child = state.db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(attempt.generation_task_id);
    const parent = state.db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(started.task.id);
    assert.equal(providerCalls, 1);
    assert.equal(attempt.status, 'needs_attention');
    assert.equal(child.status, 'needs_attention');
    assert.equal(child.provider_task_id, 'provider-batch-unknown');
    assert.equal(parent.status, 'needs_attention');
    assert.equal(completed.status, 'needs_attention');
    assert.equal(creditLedger.getReservation(state.db, attempt.credit_reservation_id).status, 'held');
    const replay = startAssetBatch(context, request);
    await replay.completion;
    assert.equal(providerCalls, 1);
    assert.equal(quoteAssetBatch(state.db, { ...state.ctx, assetIds: [attempt.id] }).items.length, 0);
  } finally {
    state.db.close();
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('batch start rechecks clone authorization before reservation and provider dispatch', () => {
  const state = createState();
  let providerCalls = 0;
  try {
    modelPrice.set(state.db, MODEL, 3, { category: 'audio' });
    creditLedger.setTenantAccountBalance(state.db, TENANT_ID, 10);
    addVerifiedTtsCapability(state);
    const authorizationAssetId = insertAuthorizationAsset(state, { filename: 'batch-revoked-authorization.txt' });
    const voiceAssetId = insertDraft(state, 'voice', {
      id: 'batch-revoked-clone',
      voice_id: 'cloned-en-us',
      is_cloned: true,
      authorization_asset_id: authorizationAssetId,
    }, 'Revoked sample.', 'Revoked clone');
    const validQuote = quoteAssetBatch(state.db, { ...state.ctx, assetIds: [voiceAssetId] });
    assert.equal(validQuote.priced, true);
    state.db.prepare('UPDATE assets SET deleted_at = ? WHERE id = ?')
      .run(new Date().toISOString(), authorizationAssetId);
    const revokedQuote = quoteAssetBatch(state.db, { ...state.ctx, assetIds: [voiceAssetId] });
    assert.equal(revokedQuote.priced, false);
    assert.equal(revokedQuote.blocked[0].code, 'REDRAW_VOICE_AUTHORIZATION_REQUIRED');
    assert.throws(
      () => startAssetBatch({
        ...state.ctx,
        provider: async () => {
          providerCalls += 1;
          return { status: 'completed' };
        },
      }, {
        quoteHash: validQuote.quote_hash,
        idempotencyKey: 'batch-revoked-clone',
        assetIds: [voiceAssetId],
      }),
      (error) => error.code === 'REDRAW_ASSET_BATCH_UNPRICED',
    );
    assert.equal(providerCalls, 0);
    assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 0);
    assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM async_tasks').get().count, 0);
  } finally {
    state.db.close();
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('single voice rechecks clone authorization after reservation and refunds without provider dispatch when consent is revoked', async () => {
  const state = createState();
  let providerCalls = 0;
  try {
    creditLedger.setTenantAccountBalance(state.db, TENANT_ID, 10);
    const authorizationAssetId = insertAuthorizationAsset(state, { filename: 'single-race-authorization.txt' });
    const sourceRef = {
      id: 'single-race-clone',
      voice_id: 'cloned-en-us',
      is_cloned: true,
      authorization_asset_id: authorizationAssetId,
    };
    const voiceAssetId = insertDraft(state, 'voice', sourceRef, 'Revoked after reserve.', 'Revoked clone');
    state.db.exec(`CREATE TRIGGER revoke_single_voice_authorization_after_reserve
      AFTER UPDATE OF credit_reservation_id ON redraw_assets
      WHEN NEW.id = ${voiceAssetId} AND NEW.credit_reservation_id IS NOT NULL
      BEGIN
        UPDATE assets SET deleted_at = '${new Date().toISOString()}' WHERE id = ${authorizationAssetId};
      END`);

    await assert.rejects(
      redrawAssetService.generateAsset({
        ...state.ctx,
        creditAmount: 3,
        provider: async () => {
          providerCalls += 1;
          return { status: 'failed', error: 'must not dispatch' };
        },
      }, {
        kind: 'voice',
        sourceRef,
        prompt: 'Revoked after reserve.',
        model: MODEL,
        snapshot: voiceSnapshot(state),
      }),
      (error) => error.code === 'REDRAW_VOICE_AUTHORIZATION_REQUIRED',
    );
    const attempt = state.db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(voiceAssetId);
    assert.equal(providerCalls, 0);
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.error_code, 'REDRAW_VOICE_AUTHORIZATION_REQUIRED');
    assert.equal(creditLedger.getReservation(state.db, attempt.credit_reservation_id).status, 'refunded');
  } finally {
    state.db.close();
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('batch voice rechecks clone authorization after reservation and refunds without provider dispatch when consent is revoked', async () => {
  const state = createState();
  let providerCalls = 0;
  try {
    modelPrice.set(state.db, MODEL, 3, { category: 'audio' });
    creditLedger.setTenantAccountBalance(state.db, TENANT_ID, 10);
    addVerifiedTtsCapability(state);
    const authorizationAssetId = insertAuthorizationAsset(state, { filename: 'batch-race-authorization.txt' });
    const voiceAssetId = insertDraft(state, 'voice', {
      id: 'batch-race-clone',
      voice_id: 'cloned-en-us',
      is_cloned: true,
      authorization_asset_id: authorizationAssetId,
    }, 'Revoked after reserve.', 'Revoked clone');
    const quote = quoteAssetBatch(state.db, { ...state.ctx, assetIds: [voiceAssetId] });
    assert.equal(quote.priced, true);
    state.db.exec(`CREATE TRIGGER revoke_batch_voice_authorization_after_reserve
      AFTER UPDATE OF credit_reservation_id ON redraw_assets
      WHEN NEW.id = ${voiceAssetId} AND NEW.credit_reservation_id IS NOT NULL
      BEGIN
        UPDATE assets SET deleted_at = '${new Date().toISOString()}' WHERE id = ${authorizationAssetId};
      END`);

    const started = startAssetBatch({
      ...state.ctx,
      provider: async () => {
        providerCalls += 1;
        return { status: 'failed', error: 'must not dispatch' };
      },
      schedule: (job) => job(),
    }, {
      quoteHash: quote.quote_hash,
      idempotencyKey: 'batch-race-revoked-clone',
      assetIds: [voiceAssetId],
    });
    const completed = await started.completion;
    const attempt = state.db.prepare('SELECT * FROM redraw_assets WHERE id = ?')
      .get(Number(started.batch.asset_ids[0]));
    const child = state.db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(attempt.generation_task_id);
    assert.equal(providerCalls, 0);
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.error_code, 'REDRAW_VOICE_AUTHORIZATION_REQUIRED');
    assert.equal(child.status, 'failed');
    assert.equal(completed.status, 'failed');
    assert.equal(creditLedger.getReservation(state.db, attempt.credit_reservation_id).status, 'refunded');
  } finally {
    state.db.close();
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('voice attempts without a provider completion audit chain never become production voices', async (t) => {
  const cases = [
    ['missing provider task id', { provider_task_id: null }, null],
    ['missing terminal status', { status: undefined }, null],
    ['tampered worker language evidence', {}, (result) => { result.voice_evidence.language_verified = false; }],
    ['cloned voice without authorization', { is_cloned: true, authorization_asset_id: null }, null],
    ['provider mismatch', {}, (result) => { result.voice_evidence.provider = 'different-provider'; }],
  ];
  for (const [name, overrides, tamper] of cases) {
    await t.test(name, async () => {
      const state = createState();
      const calls = [];
      try {
        creditLedger.setTenantAccountBalance(state.db, TENANT_ID, 10);
        const sourceRef = {
          id: `voice-${name}`,
          voice_id: 'voice-en-us',
          is_cloned: name === 'cloned voice without authorization' ? false : overrides.is_cloned === true,
        };
        const voiceAssetId = insertDraft(state, 'voice', sourceRef, 'Verification sample.', 'Sample voice');
        const adapter = createVoiceAdapter(state, `provider-${name}`, calls, overrides);
        const provider = async (request) => {
          const result = await adapter.generateAsset(request);
          tamper?.(result);
          return result;
        };
        const generated = await redrawAssetService.generateAsset({
          ...state.ctx,
          provider,
          creditAmount: 3,
        }, {
          kind: 'voice',
          sourceRef,
          prompt: 'Verification sample.',
          model: MODEL,
          snapshot: voiceSnapshot(state),
        });
        assert.equal(generated.status, 'needs_attention');
        assert.equal(generated.error_code, 'REDRAW_VOICE_EVIDENCE_INCOMPLETE');
        const payload = JSON.parse(state.db.prepare('SELECT source_ref_json FROM redraw_assets WHERE id = ?')
          .get(voiceAssetId).source_ref_json);
        assert.equal(payload.snapshot.voice_evidence, undefined);
        const reservation = creditLedger.getReservation(state.db, generated.credit_reservation_id);
        assert.equal(reservation.status, 'held');
        assert.deepEqual(creditLedger.getTenantAccount(state.db, TENANT_ID), {
          tenant_id: TENANT_ID, available: 7, held: 3, spent: 0,
        });
        assert.deepEqual(redrawVoiceService.listProductionVoices(state.db, {
          tenantId: TENANT_ID,
          userId: USER_ID,
          locale: LOCALE,
          market: MARKET,
        }, state.canRead), []);
        await assert.rejects(
          redrawAssetService.generateAsset({
            ...state.ctx,
            provider,
            creditAmount: 3,
          }, {
            kind: 'voice',
            sourceRef,
            prompt: 'Verification sample.',
            model: MODEL,
            snapshot: voiceSnapshot(state),
          }),
          (error) => error.code === 'REDRAW_ASSET_ATTEMPT_NEEDS_ATTENTION',
        );
        assert.equal(calls.length, 1);
      } finally {
        state.db.close();
        fs.rmSync(state.root, { recursive: true, force: true });
      }
    });
  }
});

test('tenant A cannot use tenant B authorization asset to create clone voice evidence', async () => {
  const state = createState();
  try {
    const authorizationAssetId = insertAuthorizationAsset(state, {
      tenantId: 'tenant-b',
      userId: 'user-b',
      filename: 'tenant-b-authorization.txt',
    });
    const sourceRef = {
      id: 'cross-tenant-clone',
      voice_id: 'cloned-en-us',
      is_cloned: true,
      authorization_asset_id: authorizationAssetId,
    };
    const voiceAssetId = insertDraft(state, 'voice', sourceRef, 'Authorized sample.', 'Cloned voice');
    const calls = [];
    const adapter = createVoiceAdapter(state, 'provider-cross-tenant-clone', calls, {
      is_cloned: true,
      authorization_asset_id: authorizationAssetId,
    });

    await assert.rejects(
      redrawAssetService.generateAsset({
        ...state.ctx,
        provider: adapter.generateAsset,
        creditAmount: 3,
      }, {
        kind: 'voice',
        sourceRef,
        prompt: 'Authorized sample.',
        model: MODEL,
        snapshot: voiceSnapshot(state),
      }),
      (error) => error.code === 'REDRAW_VOICE_AUTHORIZATION_REQUIRED',
    );
    assert.equal(calls.length, 0);
    assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 0);
    const payload = JSON.parse(state.db.prepare('SELECT source_ref_json FROM redraw_assets WHERE id = ?')
      .get(voiceAssetId).source_ref_json);
    assert.equal(payload.snapshot?.voice_evidence, undefined);
    assert.deepEqual(redrawVoiceService.listProductionVoices(state.db, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      locale: LOCALE,
      market: MARKET,
      versionId: state.versionId,
    }, state.canRead), []);
  } finally {
    state.db.close();
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('owned images and source videos cannot be substituted for dedicated voice authorization', async (t) => {
  for (const candidate of [
    { type: 'image', category: 'voice_authorization', mime: 'image/png', filename: 'owned-consent-image.png' },
    { type: 'video', category: 'source', mime: 'video/mp4', filename: 'owned-source-video.mp4' },
  ]) {
    await t.test(candidate.type, async () => {
      const state = createState();
      try {
        const now = new Date().toISOString();
        const dramaId = Number(state.db.prepare(`INSERT INTO dramas
          (title, tenant_id, user_id, created_at, updated_at)
          VALUES ('Owned candidate', ?, ?, ?, ?)`)
          .run(TENANT_ID, USER_ID, now, now).lastInsertRowid);
        fs.writeFileSync(path.join(state.root, 'fixtures', candidate.filename), 'not consent');
        const authorizationAssetId = Number(state.db.prepare(`INSERT INTO assets
          (drama_id, name, type, category, local_path, mime_type, created_at, updated_at)
          VALUES (?, 'Owned candidate', ?, ?, ?, ?, ?, ?)`)
          .run(
            dramaId,
            candidate.type,
            candidate.category,
            `fixtures/${candidate.filename}`,
            candidate.mime,
            now,
            now,
          ).lastInsertRowid);
        const sourceRef = {
          id: `clone-${candidate.type}`,
          voice_id: 'cloned-en-us',
          is_cloned: true,
          authorization_asset_id: authorizationAssetId,
        };
        const voiceAssetId = insertDraft(state, 'voice', sourceRef, 'Consent sample.', 'Clone');
        const calls = [];
        const adapter = createVoiceAdapter(state, `provider-${candidate.type}`, calls, {
          is_cloned: true,
          authorization_asset_id: authorizationAssetId,
        });
        await assert.rejects(
          redrawAssetService.generateAsset({
            ...state.ctx,
            provider: adapter.generateAsset,
            creditAmount: 3,
          }, {
            kind: 'voice',
            sourceRef,
            prompt: 'Consent sample.',
            model: MODEL,
            snapshot: voiceSnapshot(state),
          }),
          (error) => error.code === 'REDRAW_VOICE_AUTHORIZATION_REQUIRED',
        );
        assert.equal(calls.length, 0);
        assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 0);
        const payload = JSON.parse(state.db.prepare('SELECT source_ref_json FROM redraw_assets WHERE id = ?')
          .get(voiceAssetId).source_ref_json);
        assert.equal(payload.snapshot?.voice_evidence, undefined);
      } finally {
        state.db.close();
        fs.rmSync(state.root, { recursive: true, force: true });
      }
    });
  }
});

test('single voice unknown results and network timeouts keep billing held and block replay', async (t) => {
  const cases = [
    ['unknown result', async () => ({
      status: 'unknown', unknown: true, provider_task_id: 'provider-unknown', error: 'status unknown',
    }), 'provider-unknown'],
    ['network timeout', async () => {
      const error = new Error('provider network timeout');
      error.code = 'ETIMEDOUT';
      throw error;
    }, null],
    ['provider status unknown error', async () => {
      const error = new Error('provider returned a non-auditable response');
      error.code = 'PROVIDER_STATUS_UNKNOWN';
      error.unknown = true;
      error.provider_task_id = 'provider-status-unknown';
      throw error;
    }, 'provider-status-unknown'],
    ['post-provider registration failure', async () => {
      throw Object.assign(new Error('asset registration failed after provider completion'), {
        code: 'ASSET_CREATE_FAILED',
        provider_completed: true,
        provider_task_id: 'provider-post-registration',
      });
    }, 'provider-post-registration'],
  ];
  for (const [name, provider, expectedProviderTaskId] of cases) {
    await t.test(name, async () => {
      const state = createState();
      let calls = 0;
      const trackedProvider = async (request) => {
        calls += 1;
        return provider(request);
      };
      try {
        creditLedger.setTenantAccountBalance(state.db, TENANT_ID, 10);
        const sourceRef = { id: `voice-${name}`, voice_id: 'voice-en-us', is_cloned: false };
        const voiceAssetId = insertDraft(state, 'voice', sourceRef, 'Unknown sample.', 'Unknown voice');
        const generated = await redrawAssetService.generateAsset({
          ...state.ctx,
          provider: trackedProvider,
          creditAmount: 3,
        }, {
          kind: 'voice',
          sourceRef,
          prompt: 'Unknown sample.',
          model: MODEL,
          snapshot: voiceSnapshot(state),
        });
        assert.equal(generated.id, voiceAssetId);
        assert.equal(generated.status, 'needs_attention');
        assert.equal(creditLedger.getReservation(state.db, generated.credit_reservation_id).status, 'held');
        const payload = JSON.parse(state.db.prepare('SELECT source_ref_json FROM redraw_assets WHERE id = ?')
          .get(voiceAssetId).source_ref_json);
        assert.equal(payload.snapshot.provider_task_id || null, expectedProviderTaskId);
        await assert.rejects(
          redrawAssetService.generateAsset({
            ...state.ctx,
            provider: trackedProvider,
            creditAmount: 3,
          }, {
            kind: 'voice',
            sourceRef,
            prompt: 'Unknown sample.',
            model: MODEL,
            snapshot: voiceSnapshot(state),
          }),
          (error) => error.code === 'REDRAW_ASSET_ATTEMPT_NEEDS_ATTENTION',
        );
        assert.equal(calls, 1);
      } finally {
        state.db.close();
        fs.rmSync(state.root, { recursive: true, force: true });
      }
    });
  }
});

test('voice finalization and credit confirmation are atomic when settlement fails', async () => {
  const state = createState();
  const originalSettleGeneration = creditLedger.settleGeneration;
  try {
    creditLedger.setTenantAccountBalance(state.db, TENANT_ID, 10);
    const sourceRef = { id: 'voice-settlement-failure', voice_id: 'voice-en-us', is_cloned: false };
    const voiceAssetId = insertDraft(state, 'voice', sourceRef, 'Settlement sample.', 'Settlement voice');
    const adapter = createVoiceAdapter(state, 'provider-settlement-failure', []);
    creditLedger.settleGeneration = () => { throw new Error('injected settlement mismatch'); };
    const generated = await redrawAssetService.generateAsset({
      ...state.ctx,
      provider: adapter.generateAsset,
      creditAmount: 3,
    }, {
      kind: 'voice',
      sourceRef,
      prompt: 'Settlement sample.',
      model: MODEL,
      snapshot: voiceSnapshot(state),
    });
    assert.equal(generated.id, voiceAssetId);
    assert.equal(generated.status, 'needs_attention');
    assert.equal(generated.error_code, 'REDRAW_VOICE_SETTLEMENT_UNKNOWN');
    assert.equal(creditLedger.getReservation(state.db, generated.credit_reservation_id).status, 'held');
    const payload = JSON.parse(state.db.prepare('SELECT source_ref_json FROM redraw_assets WHERE id = ?')
      .get(voiceAssetId).source_ref_json);
    assert.equal(payload.snapshot?.voice_evidence, undefined);
    assert.deepEqual(redrawVoiceService.listProductionVoices(state.db, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      locale: LOCALE,
      market: MARKET,
      versionId: state.versionId,
    }, state.canRead), []);
    await assert.rejects(
      redrawAssetService.generateAsset({
        ...state.ctx,
        provider: adapter.generateAsset,
        creditAmount: 3,
      }, {
        kind: 'voice',
        sourceRef,
        prompt: 'Settlement sample.',
        model: MODEL,
        snapshot: voiceSnapshot(state),
      }),
      (error) => error.code === 'REDRAW_ASSET_ATTEMPT_NEEDS_ATTENTION',
    );
  } finally {
    creditLedger.settleGeneration = originalSettleGeneration;
    state.db.close();
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('deleted or unreadable clone authorization is rejected again by list and bind', async (t) => {
  for (const invalidation of ['soft-delete', 'unreadable']) {
    await t.test(invalidation, async () => {
      const state = createState();
      try {
        const filename = `${invalidation}-authorization.txt`;
        const authorizationAssetId = insertAuthorizationAsset(state, { filename });
        const sourceRef = {
          id: `clone-${invalidation}`,
          voice_id: 'cloned-en-us',
          is_cloned: true,
          authorization_asset_id: authorizationAssetId,
        };
        const voiceAssetId = insertDraft(state, 'voice', sourceRef, 'Authorized sample.', 'Cloned voice');
        const characterAssetId = insertDraft(state, 'character', { character_id: 'maya' }, 'Maya', 'Maya');
        const adapter = createVoiceAdapter(state, `provider-clone-${invalidation}`, [], {
          is_cloned: true,
          authorization_asset_id: authorizationAssetId,
        });
        await redrawAssetService.generateAsset({
          ...state.ctx,
          provider: adapter.generateAsset,
        }, {
          kind: 'voice',
          sourceRef,
          prompt: 'Authorized sample.',
          model: MODEL,
          snapshot: voiceSnapshot(state),
        });
        const [voice] = redrawVoiceService.listProductionVoices(state.db, {
          tenantId: TENANT_ID,
          userId: USER_ID,
          locale: LOCALE,
          market: MARKET,
          versionId: state.versionId,
        }, state.canRead);
        assert.ok(voice);

        if (invalidation === 'soft-delete') {
          state.db.prepare('UPDATE assets SET deleted_at = ? WHERE id = ?')
            .run(new Date().toISOString(), authorizationAssetId);
        } else {
          fs.rmSync(path.join(state.root, 'fixtures', filename), { force: true });
        }
        assert.deepEqual(redrawVoiceService.listProductionVoices(state.db, {
          tenantId: TENANT_ID,
          userId: USER_ID,
          locale: LOCALE,
          market: MARKET,
          versionId: state.versionId,
        }, state.canRead), []);
        assert.throws(
          () => redrawVoiceService.assignVoice(state.db, characterAssetId, voice, {
            tenantId: TENANT_ID,
            userId: USER_ID,
            versionId: state.versionId,
            voiceAssetId,
            canReadAsset: state.canRead,
          }),
          (error) => error.code === 'REDRAW_VOICE_AUTHORIZATION_REQUIRED',
        );
        const character = state.db.prepare('SELECT voice_asset_id FROM redraw_assets WHERE id = ?').get(characterAssetId);
        assert.equal(character.voice_asset_id, null);
      } finally {
        state.db.close();
        fs.rmSync(state.root, { recursive: true, force: true });
      }
    });
  }
});

test('assignVoice owner-scoped CAS cannot update a character owned by another tenant', async () => {
  const state = createState();
  try {
    const sourceRef = { id: 'owned-voice', voice_id: 'voice-en-us', is_cloned: false };
    const voiceAssetId = insertDraft(state, 'voice', sourceRef, 'Owner sample.', 'Owned voice');
    const characterAssetId = insertDraft(state, 'character', { character_id: 'maya' }, 'Maya', 'Maya');
    const adapter = createVoiceAdapter(state, 'provider-owner-cas', []);
    await redrawAssetService.generateAsset({
      ...state.ctx,
      provider: adapter.generateAsset,
    }, {
      kind: 'voice',
      sourceRef,
      prompt: 'Owner sample.',
      model: MODEL,
      snapshot: voiceSnapshot(state),
    });
    const [voice] = redrawVoiceService.listProductionVoices(state.db, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      locale: LOCALE,
      market: MARKET,
      versionId: state.versionId,
    }, state.canRead);

    assert.throws(
      () => redrawVoiceService.assignVoice(state.db, characterAssetId, voice, {
        tenantId: 'tenant-b',
        userId: 'user-b',
        versionId: state.versionId,
        voiceAssetId,
        canReadAsset: state.canRead,
      }),
      (error) => error.code === 'REDRAW_CHARACTER_ASSET_NOT_FOUND',
    );
    assert.equal(state.db.prepare('SELECT voice_asset_id FROM redraw_assets WHERE id = ?')
      .get(characterAssetId).voice_asset_id, null);
  } finally {
    state.db.close();
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});
