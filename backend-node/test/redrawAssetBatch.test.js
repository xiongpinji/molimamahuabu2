const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const credits = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const taskService = require('../src/services/taskService');
const aiConfigService = require('../src/services/aiConfigService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const {
  quoteAssetBatch,
  startAssetBatch,
  getAssetBatch,
  reconcileOrphanedBatches,
} = require('../src/services/redrawAssetBatchService');

const MODEL_MANIFEST_SHA256 = 'a'.repeat(64);
const CALIBRATION_MANIFEST_SHA256 = 'b'.repeat(64);
const AUDIO_SHA256 = 'c'.repeat(64);
const TRANSCRIPT_SHA256 = 'd'.repeat(64);

function setupBatchState(options = {}) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-batch-'));
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  for (const file of ['character.png', 'scene.png', 'prop.png', 'voice.mp3', 'evidence.txt']) {
    fs.writeFileSync(path.join(root, 'artifacts', file), file);
  }
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO assets (id, name, type, category, url, local_path, mime_type, duration, width, height, created_at, updated_at)
    VALUES
      (101, 'character', 'image', 'redraw', '', 'artifacts/character.png', 'image/png', NULL, 1280, 720, ?, ?),
      (102, 'scene', 'image', 'redraw', '', 'artifacts/scene.png', 'image/png', NULL, 1280, 720, ?, ?),
      (103, 'prop', 'image', 'redraw', '', 'artifacts/prop.png', 'image/png', NULL, 1280, 720, ?, ?),
      (104, 'voice', 'audio', 'redraw', '', 'artifacts/voice.mp3', 'audio/mpeg', 3.2, NULL, NULL, ?, ?),
      (900, 'evidence', 'text', 'redraw', '', 'artifacts/evidence.txt', 'text/plain', NULL, NULL, NULL, ?, ?)`)
    .run(now, now, now, now, now, now, now, now, now, now);
  db.prepare(`INSERT INTO redraw_projects
    (tenant_id, user_id, title, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', '测试项目', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO redraw_works
    (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms, created_at, updated_at)
    VALUES (1, 'tenant-a', 'user-a', '测试作品', 101, 'source-a', 15000, ?, ?)`).run(now, now);
  const workId = db.prepare('SELECT id FROM redraw_works LIMIT 1').get().id;
  db.prepare(`INSERT INTO redraw_versions
    (work_id, tenant_id, user_id, version, locale, market, source_facts_json, facts_hash, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 2, 'en-US', 'US', '{}', 'facts-a', 'asset_review', ?, ?)`)
    .run(workId, now, now);
  const versionId = db.prepare('SELECT id FROM redraw_versions LIMIT 1').get().id;
  const models = {
    character_image: 'model-character',
    clean_plate_image: 'model-clean',
    tts: 'model-tts',
  };
  if (options.prices !== false) {
    prices.set(db, models.character_image, 7, { category: 'image' });
    prices.set(db, models.clean_plate_image, 5, { category: 'image' });
    prices.set(db, models.tts, 3, { category: 'audio' });
  }
  credits.setTenantAccountBalance(db, 'tenant-a', options.balance ?? 30);
  const evidence = (provider, model, taskId) => ({
    provider,
    model,
    task_id: taskId,
    terminal_status: 'completed',
    artifact_id: 900,
  });
  let ttsConfigId = null;
  if (options.capabilities !== false) {
    db.prepare(`INSERT INTO ai_service_configs
      (service_type, provider, name, model, default_model, priority, is_default, is_active, settings, created_at, updated_at)
      VALUES ('redraw', 'fake', 'fake redraw', ?, ?, 10, 1, 1, ?, ?, ?)`)
      .run(
        JSON.stringify(Object.values(models)),
        models.character_image,
        JSON.stringify({
          redraw_locale_capabilities: [{
            locale: 'en-US',
            market: 'US',
            status: 'verified',
            evidence: {
              character_image: evidence('fake-character', models.character_image, 'ev-character'),
              clean_plate_image: evidence('fake-clean', models.clean_plate_image, 'ev-clean'),
            },
          }],
        }),
        now,
        now,
      );
    ttsConfigId = Number(db.prepare(`INSERT INTO ai_service_configs
      (service_type, provider, name, model, default_model, priority, is_default, is_active, settings, created_at, updated_at)
      VALUES ('tts', 'fake-tts', 'verified fake TTS', ?, ?, 9, 0, 1, '{}', ?, ?)`)
      .run(JSON.stringify([models.tts]), models.tts, now, now).lastInsertRowid);
    db.prepare('UPDATE ai_service_configs SET settings = ? WHERE id = ?').run(JSON.stringify({
      redraw_locale_capabilities: [{
        locale: 'en-US',
        market: 'US',
        status: 'verified',
        evidence: {
          tts: {
            ...evidence('fake-tts', models.tts, 'ev-tts'),
            ai_service_config_id: ttsConfigId,
            config_updated_at: now,
          },
        },
      }],
    }), ttsConfigId);
  }
  const assetIds = {};
  for (const [kind, name] of [
    ['character', 'Maya'],
    ['scene', 'Market'],
    ['prop', 'Phone'],
    ['voice', 'Narrator'],
  ]) {
    const result = db.prepare(`INSERT INTO redraw_assets
      (version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
       localized_description, prompt, version_number, approval_status, status, created_at, updated_at)
      VALUES (?, 'tenant-a', 'user-a', ?, ?, ?, ?, ?, 1, 'pending', ?, ?, ?)`)
      .run(
        versionId,
        kind,
        JSON.stringify({
          source_ref: {
            id: `${kind}-1`,
            kind,
            ...(kind === 'voice' ? { voice_id: 'fixture-voice', is_cloned: false } : {}),
          },
        }),
        name,
        `${name} description`,
        `${name} prompt`,
        options.failedOnly ? 'generated' : 'draft',
        now,
        now,
      );
    assetIds[kind] = Number(result.lastInsertRowid);
  }
  if (options.failedOnly) {
    db.prepare("UPDATE redraw_assets SET status = 'failed', asset_id = NULL, clean_plate_asset_id = NULL, voice_asset_id = NULL WHERE kind = 'scene'")
      .run();
  }
  const ctx = {
    db,
    versionId,
    tenantId: 'tenant-a',
    userId: 'user-a',
    canReadArtifact(id) {
      const asset = db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(Number(id));
      return Boolean(asset?.local_path && fs.existsSync(path.join(root, asset.local_path)));
    },
    assetReader: {
      canRead(asset) {
        return Boolean(asset?.local_path && fs.existsSync(path.join(root, asset.local_path)));
      },
    },
    localeRegistry: trustedRegistry(),
    localeVerifier: readyLocaleVerifier(),
  };
  return { db, root, versionId, assetIds, ctx, ttsConfigId, ttsConfigUpdatedAt: now };
}

function voiceCompletionEvidence(state, job) {
  if (job.asset.kind !== 'voice') return {};
  const providerTaskId = `voice-provider-${job.taskId}`;
  return {
    provider_task_id: providerTaskId,
    duration: 3.2,
    voice_evidence: {
      source: 'offline-worker',
      locale: 'en-US',
      market: 'US',
      locale_pack: 'en-US@fixture',
      audio_sha256: AUDIO_SHA256,
      transcript_sha256: TRANSCRIPT_SHA256,
      model_manifest_sha256: MODEL_MANIFEST_SHA256,
      calibration_manifest_sha256: CALIBRATION_MANIFEST_SHA256,
      asr_model_revision: 'asr-en-20260808',
      accent_model_revision: 'accent-en-20260808',
      metrics: { word_error_rate: 0, accent_confidence: 0.99 },
      completed_at: '2026-08-08T00:00:01.000Z',
      provider: 'fake-tts',
      model: 'model-tts',
      ai_service_config_id: state.ttsConfigId,
      config_updated_at: state.ttsConfigUpdatedAt,
      voice_id: 'fixture-voice',
      task_id: providerTaskId,
      terminal_status: 'completed',
      audio_asset_id: 104,
      duration_ms: 3200,
      real_generation_verified: true,
      language_verified: true,
      detected_locale: 'en-US',
      is_cloned: false,
      authorization_asset_id: null,
    },
  };
}

function trustedRegistry() {
  return {
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
  };
}

function cleanup(state) {
  fs.rmSync(state.root, { recursive: true, force: true });
  state.db.close();
}

function readyLocaleVerifier(calls = []) {
  return {
    assertReady(locale) {
      calls.push(locale);
      return {
        id: `${locale}@fixture`,
        model_manifest_sha256: 'a'.repeat(64),
        calibration_manifest_sha256: 'b'.repeat(64),
      };
    },
  };
}

test('quoteAssetBatch returns a stable four item total for eligible drafts', () => {
  const state = setupBatchState();
  const quote = quoteAssetBatch(state.db, state.ctx);
  const second = quoteAssetBatch(state.db, state.ctx);

  assert.equal(quote.priced, true);
  assert.equal(quote.total_credits, 20);
  assert.match(quote.quote_hash, /^[a-f0-9]{64}$/);
  assert.equal(second.quote_hash, quote.quote_hash);
  assert.deepEqual(
    quote.items.map((item) => [item.kind, item.capability, item.credits]),
    [
      ['character', 'character_image', 7],
      ['scene', 'clean_plate_image', 5],
      ['prop', 'clean_plate_image', 5],
      ['voice', 'tts', 3],
    ],
  );
  cleanup(state);
});

test('voice quote requires ready locale verifier and binds worker pack manifests into the hash', () => {
  const state = setupBatchState();
  const calls = [];
  const readyCtx = { ...state.ctx, localeVerifier: readyLocaleVerifier(calls), assetIds: [state.assetIds.voice] };
  const ready = quoteAssetBatch(state.db, readyCtx);
  const { localeVerifier: _missing, ...ctxWithoutVerifier } = state.ctx;
  const missing = quoteAssetBatch(state.db, {
    ...ctxWithoutVerifier,
    assetIds: [state.assetIds.voice],
  });
  const blocked = quoteAssetBatch(state.db, {
    ...state.ctx,
    assetIds: [state.assetIds.voice],
    localeVerifier: {
      assertReady(locale) {
        calls.push(locale);
        throw Object.assign(new Error('worker not ready'), { code: 'REDRAW_LOCALE_VERIFIER_NOT_READY' });
      },
    },
  });

  assert.equal(ready.priced, true);
  assert.equal(ready.items[0].locale_pack, 'en-US@fixture');
  assert.equal(ready.items[0].model_manifest_sha256, 'a'.repeat(64));
  assert.equal(ready.items[0].calibration_manifest_sha256, 'b'.repeat(64));
  assert.equal(missing.priced, false);
  assert.equal(missing.total_credits, 0);
  assert.equal(missing.items[0].credits, undefined);
  assert.equal(missing.blocked[0].code, 'REDRAW_LOCALE_VERIFIER_NOT_READY');
  assert.equal(blocked.priced, false);
  assert.equal(blocked.total_credits, 0);
  assert.equal(blocked.items[0].credits, undefined);
  assert.equal(blocked.blocked[0].code, 'REDRAW_LOCALE_VERIFIER_NOT_READY');
  assert.notEqual(blocked.quote_hash, ready.quote_hash);
  assert.deepEqual(calls, ['en-US', 'en-US']);
  cleanup(state);
});

test('startAssetBatch rejects missing locale verifier before voice billing or provider dispatch', async () => {
  const state = setupBatchState();
  const quote = quoteAssetBatch(state.db, {
    ...state.ctx,
    assetIds: [state.assetIds.voice],
  });
  const { localeVerifier: _missing, ...ctxWithoutVerifier } = state.ctx;
  let providerCalls = 0;

  assert.throws(
    () => startAssetBatch({
      ...ctxWithoutVerifier,
      provider: async () => { providerCalls += 1; },
      schedule: (job) => job(),
    }, {
      quoteHash: quote.quote_hash,
      idempotencyKey: 'voice-locale-verifier-missing',
      assetIds: [state.assetIds.voice],
    }),
    (error) => error.code === 'REDRAW_ASSET_BATCH_UNPRICED'
      && error.quote?.blocked?.[0]?.code === 'REDRAW_LOCALE_VERIFIER_NOT_READY',
  );
  assert.equal(providerCalls, 0);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 0);
  cleanup(state);
});

test('startAssetBatch rejects stale voice quote when locale verifier readiness changes before billing', async () => {
  const state = setupBatchState();
  const quote = quoteAssetBatch(state.db, {
    ...state.ctx,
    assetIds: [state.assetIds.voice],
    localeVerifier: readyLocaleVerifier(),
  });
  let providerCalls = 0;

  assert.throws(
    () => startAssetBatch({
      ...state.ctx,
      localeVerifier: {
        assertReady() {
          throw Object.assign(new Error('worker not ready'), { code: 'REDRAW_LOCALE_VERIFIER_NOT_READY' });
        },
      },
      provider: async () => { providerCalls += 1; },
      schedule: (job) => job(),
    }, {
      quoteHash: quote.quote_hash,
      idempotencyKey: 'voice-locale-not-ready-before-billing',
      assetIds: [state.assetIds.voice],
    }),
    (error) => error.code === 'REDRAW_ASSET_BATCH_UNPRICED'
      && error.quote?.blocked?.[0]?.code === 'REDRAW_LOCALE_VERIFIER_NOT_READY',
  );
  assert.equal(providerCalls, 0);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 0);
  cleanup(state);
});

test('startAssetBatch rechecks voice locale verifier before provider and refunds deterministic failure', async () => {
  const state = setupBatchState();
  let verifierCalls = 0;
  let providerCalls = 0;
  const context = {
    ...state.ctx,
    assetIds: [state.assetIds.voice],
    localeVerifier: {
      assertReady(locale) {
        verifierCalls += 1;
        if (verifierCalls >= 3) {
          throw Object.assign(new Error('worker not ready before provider'), { code: 'REDRAW_LOCALE_VERIFIER_NOT_READY' });
        }
        return {
          id: `${locale}@fixture`,
          model_manifest_sha256: 'a'.repeat(64),
          calibration_manifest_sha256: 'b'.repeat(64),
        };
      },
    },
    provider: async () => {
      providerCalls += 1;
      throw new Error('must not dispatch');
    },
    schedule: (job) => job(),
  };
  const quote = quoteAssetBatch(state.db, context);
  const started = startAssetBatch(context, {
    quoteHash: quote.quote_hash,
    idempotencyKey: 'voice-locale-not-ready-provider',
    assetIds: [state.assetIds.voice],
  });

  const completed = await started.completion;
  const attempt = state.db.prepare('SELECT status, error_code, credit_reservation_id FROM redraw_assets WHERE id = ?')
    .get(started.batch.asset_ids[0]);
  assert.equal(completed.status, 'failed');
  assert.equal(providerCalls, 0);
  assert.equal(attempt.status, 'failed');
  assert.equal(attempt.error_code, 'REDRAW_LOCALE_VERIFIER_NOT_READY');
  assert.equal(credits.getReservation(state.db, attempt.credit_reservation_id).status, 'refunded');
  assert.equal(state.db.prepare("SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE status = 'held'").get().count, 0);
  cleanup(state);
});

test('quoteAssetBatch blocks the whole batch with per-item reasons when capability or price is missing', () => {
  const state = setupBatchState({ prices: false });
  const quote = quoteAssetBatch(state.db, state.ctx);

  assert.equal(quote.priced, false);
  assert.equal(quote.total_credits, 0);
  assert.equal(quote.items.length, 4);
  assert.equal(quote.blocked.length, 4);
  assert.equal(quote.blocked.every((item) => item.code === 'MODEL_PRICE_NOT_CONFIGURED'), true);
  assert.throws(
    () => startAssetBatch(state.ctx, { quoteHash: quote.quote_hash, idempotencyKey: 'blocked' }),
    (error) => error.code === 'REDRAW_ASSET_BATCH_UNPRICED',
  );
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM redraw_asset_batches').get().count, 0);
  cleanup(state);
});

test('quoteAssetBatch returns empty when no eligible selected or default assets remain', () => {
  const defaultState = setupBatchState();
  defaultState.db.prepare(`
    UPDATE redraw_assets
    SET status = 'generated', asset_id = 101
    WHERE kind = 'character'
  `).run();
  defaultState.db.prepare(`
    UPDATE redraw_assets
    SET status = 'needs_attention', clean_plate_asset_id = 102
    WHERE kind = 'scene'
  `).run();
  defaultState.db.prepare(`
    UPDATE redraw_assets
    SET status = 'generated', asset_id = 103
    WHERE kind = 'prop'
  `).run();
  defaultState.db.prepare(`
    UPDATE redraw_assets
    SET status = 'generated', voice_asset_id = 104
    WHERE kind = 'voice'
  `).run();
  const defaultQuote = quoteAssetBatch(defaultState.db, defaultState.ctx);
  assert.equal(defaultQuote.priced, false);
  assert.equal(defaultQuote.blocked[0].code, 'REDRAW_ASSET_BATCH_EMPTY');
  assert.throws(
    () => startAssetBatch(defaultState.ctx, { quoteHash: defaultQuote.quote_hash, idempotencyKey: 'empty-default' }),
    (error) => error.code === 'REDRAW_ASSET_BATCH_EMPTY',
  );
  assert.equal(defaultState.db.prepare('SELECT COUNT(*) AS count FROM redraw_asset_batches').get().count, 0);
  assert.equal(defaultState.db.prepare("SELECT COUNT(*) AS count FROM async_tasks WHERE type = 'redraw_asset_batch'").get().count, 0);
  cleanup(defaultState);

  const selectedState = setupBatchState();
  selectedState.db.prepare("UPDATE redraw_assets SET status = 'generated', asset_id = 101 WHERE id = ?")
    .run(selectedState.assetIds.character);
  const selectedQuote = quoteAssetBatch(selectedState.db, { ...selectedState.ctx, assetIds: [selectedState.assetIds.character] });
  assert.equal(selectedQuote.priced, false);
  assert.equal(selectedQuote.blocked[0].code, 'REDRAW_ASSET_BATCH_EMPTY');
  assert.equal(selectedState.db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 0);
  cleanup(selectedState);
});

test('startAssetBatch fails before dispatch on insufficient balance without residual rows', () => {
  const state = setupBatchState({ balance: 19 });
  const quote = quoteAssetBatch(state.db, state.ctx);
  let calls = 0;

  assert.throws(
    () => startAssetBatch({
      ...state.ctx,
      provider: async () => {
        calls += 1;
        return { status: 'completed', asset_id: 101 };
      },
    }, { quoteHash: quote.quote_hash, idempotencyKey: 'low-balance' }),
    (error) => error.code === 'INSUFFICIENT_CREDITS',
  );
  assert.equal(calls, 0);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM redraw_asset_batches').get().count, 0);
  assert.equal(state.db.prepare("SELECT COUNT(*) AS count FROM async_tasks WHERE type IN ('redraw_asset_batch', 'redraw_asset')").get().count, 0);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 0);
  cleanup(state);
});

test('startAssetBatch rejects quote drift and explicit cross-owner asset ids', () => {
  const state = setupBatchState();
  const quote = quoteAssetBatch(state.db, state.ctx);
  state.db.prepare("UPDATE redraw_assets SET prompt = 'changed prompt' WHERE id = ?").run(state.assetIds.voice);

  assert.throws(
    () => startAssetBatch(state.ctx, { quoteHash: quote.quote_hash, idempotencyKey: 'drift' }),
    (error) => error.code === 'REDRAW_ASSET_BATCH_QUOTE_CHANGED' && Boolean(error.quote?.quote_hash),
  );
  assert.throws(
    () => quoteAssetBatch(state.db, { ...state.ctx, assetIds: [99999] }),
    (error) => error.code === 'REDRAW_ASSET_NOT_FOUND',
  );
  cleanup(state);
});

test('startAssetBatch dispatches after commit, settles partial failure, and retry quotes only failed assets', async () => {
  const state = setupBatchState();
  const quote = quoteAssetBatch(state.db, state.ctx);
  const calls = [];
  const provider = async (job) => {
    calls.push(job);
    if (job.asset.kind === 'scene') throw Object.assign(new Error('scene provider failed'), { code: 'FAKE_SCENE_FAILED' });
    const assetId = job.asset.kind === 'character' ? 101 : job.asset.kind === 'prop' ? 103 : 104;
    return {
      status: 'completed',
      asset_id: assetId,
      ...voiceCompletionEvidence(state, job),
      metadata: job.asset.kind === 'character' ? { views: ['front', 'side', 'back'] } : {},
    };
  };
  const started = startAssetBatch({
    ...state.ctx,
    provider,
    schedule: (job) => job(),
  }, { quoteHash: quote.quote_hash, idempotencyKey: 'partial' });
  await started.completion;
  const batch = getAssetBatch(state.db, state.ctx, started.batch.id);

  assert.equal(calls.length, 4);
  assert.equal(batch.status, 'partial_failed');
  assert.equal(batch.success_count, 3);
  assert.equal(batch.failed_count, 1);
  assert.deepEqual(credits.getTenantAccount(state.db, 'tenant-a'), {
    tenant_id: 'tenant-a',
    available: 15,
    held: 0,
    spent: 15,
  });
  assert.equal(state.db.prepare("SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE status = 'confirmed'").get().count, 3);
  assert.equal(state.db.prepare("SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE status = 'refunded'").get().count, 1);
  const scene = state.db.prepare("SELECT asset_id, clean_plate_asset_id, status FROM redraw_assets WHERE kind = 'scene' ORDER BY id DESC LIMIT 1").get();
  assert.equal(scene.asset_id, null);
  assert.equal(scene.clean_plate_asset_id, null);
  assert.equal(scene.status, 'failed');
  const retryQuote = quoteAssetBatch(state.db, state.ctx);
  assert.deepEqual(retryQuote.items.map((item) => item.kind), ['scene']);
  assert.equal(retryQuote.total_credits, 5);
  cleanup(state);
});

test('startAssetBatch keeps unknown provider state held, needs attention, and out of retry quote', async () => {
  const state = setupBatchState();
  const quote = quoteAssetBatch(state.db, { ...state.ctx, assetIds: [state.assetIds.scene] });
  const started = startAssetBatch({
    ...state.ctx,
    provider: async () => ({
      status: 'processing',
      provider_task_id: 'provider-scene-unknown',
      unknown: true,
    }),
    schedule: (job) => job(),
  }, { quoteHash: quote.quote_hash, idempotencyKey: 'unknown-scene', assetIds: [state.assetIds.scene] });
  await started.completion;

  const batch = getAssetBatch(state.db, state.ctx, started.batch.id);
  const attempt = state.db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(started.batch.asset_ids[0]);
  const childTask = taskService.getTask(state.db, attempt.generation_task_id);
  const parentTask = taskService.getTask(state.db, started.task.id);

  assert.equal(batch.status, 'needs_attention');
  assert.equal(batch.success_count, 0);
  assert.equal(batch.failed_count, 0);
  assert.equal(attempt.status, 'needs_attention');
  assert.equal(attempt.error_code, 'REDRAW_ASSET_PROVIDER_UNKNOWN');
  assert.equal(attempt.generation_task_id, childTask.id);
  assert.equal(childTask.provider_task_id, 'provider-scene-unknown');
  assert.equal(childTask.status, 'needs_attention');
  assert.equal(parentTask.status, 'needs_attention');
  assert.equal(state.db.prepare("SELECT status FROM tenant_usage_reservations WHERE id = ?").get(attempt.credit_reservation_id).status, 'held');
  assert.deepEqual(credits.getTenantAccount(state.db, 'tenant-a'), {
    tenant_id: 'tenant-a',
    available: 25,
    held: 5,
    spent: 0,
  });
  assert.deepEqual(quoteAssetBatch(state.db, state.ctx).items.map((item) => item.kind), ['character', 'prop', 'voice']);
  cleanup(state);
});

test('startAssetBatch keeps post-provider local failure held and blocks replay', async () => {
  const state = setupBatchState();
  const quote = quoteAssetBatch(state.db, { ...state.ctx, assetIds: [state.assetIds.prop] });
  let providerCalls = 0;
  const request = {
    quoteHash: quote.quote_hash,
    idempotencyKey: 'post-provider-local-failure',
    assetIds: [state.assetIds.prop],
  };
  const context = {
    ...state.ctx,
    provider: async () => {
      providerCalls += 1;
      throw Object.assign(new Error('asset registration failed after provider completion'), {
        code: 'ASSET_CREATE_FAILED',
        provider_completed: true,
        provider_task_id: 'provider-post-local',
      });
    },
    schedule: (job) => job(),
  };
  const started = startAssetBatch(context, request);
  const completed = await started.completion;
  const attempt = state.db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(started.batch.asset_ids[0]);
  const childTask = taskService.getTask(state.db, attempt.generation_task_id);
  const parentTask = taskService.getTask(state.db, started.task.id);

  assert.equal(completed.status, 'needs_attention');
  assert.equal(attempt.status, 'needs_attention');
  assert.equal(childTask.status, 'needs_attention');
  assert.equal(childTask.provider_task_id, 'provider-post-local');
  assert.equal(parentTask.status, 'needs_attention');
  assert.equal(credits.getReservation(state.db, attempt.credit_reservation_id).status, 'held');
  const replay = startAssetBatch(context, request);
  await replay.completion;
  assert.equal(providerCalls, 1);
  cleanup(state);
});

test('startAssetBatch stores internal child task id on asset and provider id only on async task', async () => {
  const state = setupBatchState();
  const quote = quoteAssetBatch(state.db, { ...state.ctx, assetIds: [state.assetIds.prop] });
  const started = startAssetBatch({
    ...state.ctx,
    provider: async () => ({ status: 'completed', asset_id: 103, provider_task_id: 'provider-prop-1' }),
    schedule: (job) => job(),
  }, { quoteHash: quote.quote_hash, idempotencyKey: 'provider-id-columns', assetIds: [state.assetIds.prop] });
  await started.completion;

  const attempt = state.db.prepare('SELECT generation_task_id FROM redraw_assets WHERE id = ?').get(started.batch.asset_ids[0]);
  const childTask = taskService.getTask(state.db, attempt.generation_task_id);
  assert.equal(attempt.generation_task_id, childTask.id);
  assert.equal(childTask.provider_task_id, 'provider-prop-1');
  assert.notEqual(attempt.generation_task_id, 'provider-prop-1');
  cleanup(state);
});

test('startAssetBatch escalates system failures to parent needs_attention without refunding held reservations', async () => {
  const state = setupBatchState();
  const quote = quoteAssetBatch(state.db, { ...state.ctx, assetIds: [state.assetIds.prop] });
  const started = startAssetBatch({
    ...state.ctx,
    assetReader: {
      canRead() {
        throw new TypeError('reader crashed');
      },
    },
    provider: async () => ({ status: 'completed', asset_id: 103 }),
    schedule: (job) => job(),
  }, { quoteHash: quote.quote_hash, idempotencyKey: 'system-write-failure', assetIds: [state.assetIds.prop] });

  await assert.rejects(started.completion, /reader crashed/);
  const batch = getAssetBatch(state.db, state.ctx, started.batch.id);
  const parentTask = taskService.getTask(state.db, started.task.id);
  const attempt = state.db.prepare('SELECT credit_reservation_id FROM redraw_assets WHERE id = ?').get(started.batch.asset_ids[0]);
  assert.equal(batch.status, 'needs_attention');
  assert.equal(parentTask.status, 'needs_attention');
  assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(attempt.credit_reservation_id).status, 'held');
  cleanup(state);
});

test('startAssetBatch keeps provider system errors unknown without refunding held reservations', async () => {
  const state = setupBatchState();
  const quote = quoteAssetBatch(state.db, { ...state.ctx, assetIds: [state.assetIds.prop] });
  const started = startAssetBatch({
    ...state.ctx,
    provider: async () => {
      throw new TypeError('provider runtime crashed');
    },
    schedule: (job) => job(),
  }, { quoteHash: quote.quote_hash, idempotencyKey: 'provider-system-error', assetIds: [state.assetIds.prop] });

  await assert.rejects(started.completion, /provider runtime crashed/);
  const batch = getAssetBatch(state.db, state.ctx, started.batch.id);
  const parentTask = taskService.getTask(state.db, started.task.id);
  const attempt = state.db.prepare('SELECT status, error_code, generation_task_id, credit_reservation_id FROM redraw_assets WHERE id = ?')
    .get(started.batch.asset_ids[0]);
  const childTask = taskService.getTask(state.db, attempt.generation_task_id);

  assert.equal(batch.status, 'needs_attention');
  assert.equal(parentTask.status, 'needs_attention');
  assert.equal(attempt.status, 'needs_attention');
  assert.equal(attempt.error_code, 'REDRAW_ASSET_BATCH_SYSTEM_UNKNOWN');
  assert.equal(childTask.status, 'needs_attention');
  assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(attempt.credit_reservation_id).status, 'held');
  assert.equal(state.db.prepare("SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE status = 'refunded'").get().count, 0);
  cleanup(state);
});

test('startAssetBatch refunds a voice child when authorization reading crashes before provider dispatch', async () => {
  const state = setupBatchState();
  const now = new Date().toISOString();
  const dramaId = Number(state.db.prepare(`INSERT INTO dramas
    (title, tenant_id, user_id, created_at, updated_at)
    VALUES ('Voice authorization owner', 'tenant-a', 'user-a', ?, ?)`)
    .run(now, now).lastInsertRowid);
  fs.writeFileSync(path.join(state.root, 'artifacts', 'voice-authorization.txt'), 'voice authorization');
  const authorizationAssetId = Number(state.db.prepare(`INSERT INTO assets
    (drama_id, name, type, category, url, local_path, mime_type, created_at, updated_at)
    VALUES (?, 'Voice authorization', 'text', 'voice_authorization', '',
      'artifacts/voice-authorization.txt', 'text/plain', ?, ?)`)
    .run(dramaId, now, now).lastInsertRowid);
  state.db.prepare('UPDATE redraw_assets SET source_ref_json = ? WHERE id = ?').run(JSON.stringify({
    source_ref: {
      id: 'voice-1',
      kind: 'voice',
      voice_id: 'fixture-voice',
      is_cloned: true,
      authorization_asset_id: authorizationAssetId,
    },
  }), state.assetIds.voice);

  let authorizationReads = 0;
  let providerCalls = 0;
  const context = {
    ...state.ctx,
    assetReader: {
      canRead(asset) {
        if (asset?.category === 'voice_authorization') {
          authorizationReads += 1;
          if (authorizationReads >= 4) throw new TypeError('authorization reader crashed before dispatch');
        }
        return state.ctx.assetReader.canRead(asset);
      },
    },
    provider: async () => {
      providerCalls += 1;
      return { status: 'failed', error: 'must not dispatch' };
    },
    schedule: (job) => job(),
  };
  const quote = quoteAssetBatch(state.db, { ...context, assetIds: [state.assetIds.voice] });
  const started = startAssetBatch(context, {
    quoteHash: quote.quote_hash,
    idempotencyKey: 'voice-pre-dispatch-system-refund',
    assetIds: [state.assetIds.voice],
  });

  await assert.rejects(started.completion, /authorization reader crashed before dispatch/);
  const batch = getAssetBatch(state.db, state.ctx, started.batch.id);
  const attempt = state.db.prepare(`SELECT status, error_code, generation_task_id, credit_reservation_id
    FROM redraw_assets WHERE id = ?`).get(started.batch.asset_ids[0]);
  const childTask = taskService.getTask(state.db, attempt.generation_task_id);
  assert.equal(providerCalls, 0);
  assert.equal(batch.status, 'needs_attention');
  assert.equal(batch.success_count, 0);
  assert.equal(batch.failed_count, 1);
  assert.equal(attempt.status, 'failed');
  assert.equal(attempt.error_code, 'REDRAW_ASSET_BATCH_NOT_DISPATCHED');
  assert.equal(childTask.status, 'failed');
  assert.equal(credits.getReservation(state.db, attempt.credit_reservation_id).status, 'refunded');
  cleanup(state);
});

test('startAssetBatch refunds a voice child when its exact config reload crashes before provider dispatch', async () => {
  const state = setupBatchState();
  const originalGetConfig = aiConfigService.getConfig;
  let configReads = 0;
  let providerCalls = 0;
  try {
    aiConfigService.getConfig = (...args) => {
      configReads += 1;
      if (configReads >= 4) throw new TypeError('TTS config reload crashed before dispatch');
      return originalGetConfig(...args);
    };
    const context = {
      ...state.ctx,
      provider: async () => {
        providerCalls += 1;
        return { status: 'failed', error: 'must not dispatch' };
      },
      schedule: (job) => job(),
    };
    const quote = quoteAssetBatch(state.db, { ...context, assetIds: [state.assetIds.voice] });
    const started = startAssetBatch(context, {
      quoteHash: quote.quote_hash,
      idempotencyKey: 'voice-config-pre-dispatch-system-refund',
      assetIds: [state.assetIds.voice],
    });

    await assert.rejects(started.completion, /TTS config reload crashed before dispatch/);
    const batch = getAssetBatch(state.db, state.ctx, started.batch.id);
    const attempt = state.db.prepare(`SELECT status, error_code, generation_task_id, credit_reservation_id
      FROM redraw_assets WHERE id = ?`).get(started.batch.asset_ids[0]);
    assert.equal(providerCalls, 0);
    assert.equal(batch.status, 'needs_attention');
    assert.equal(batch.failed_count, 1);
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.error_code, 'REDRAW_ASSET_BATCH_NOT_DISPATCHED');
    assert.equal(taskService.getTask(state.db, attempt.generation_task_id).status, 'failed');
    assert.equal(credits.getReservation(state.db, attempt.credit_reservation_id).status, 'refunded');
  } finally {
    aiConfigService.getConfig = originalGetConfig;
    cleanup(state);
  }
});

test('startAssetBatch drains started workers after fatal and prevents late settlement side effects', async () => {
  const state = setupBatchState();
  const selected = [state.assetIds.character, state.assetIds.prop];
  const quote = quoteAssetBatch(state.db, { ...state.ctx, assetIds: selected });
  let releaseDelayed;
  let completionSettled = false;
  const started = startAssetBatch({
    ...state.ctx,
    provider: async (job) => {
      if (job.asset.kind === 'character') throw new TypeError('provider fatal for character');
      await new Promise((resolve) => { releaseDelayed = resolve; });
      return { status: 'completed', asset_id: 103 };
    },
    schedule: (job) => job(),
  }, { quoteHash: quote.quote_hash, idempotencyKey: 'fatal-drain', assetIds: selected }, { concurrency: 2 });
  const observed = started.completion.then(
    (value) => {
      completionSettled = true;
      return value;
    },
    (error) => {
      completionSettled = true;
      throw error;
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  const settledBeforeDelayedProviderReturned = completionSettled;
  releaseDelayed();
  await assert.rejects(observed, /provider fatal for character/);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(settledBeforeDelayedProviderReturned, false);
  const batch = getAssetBatch(state.db, state.ctx, started.batch.id);
  const attempts = state.db.prepare(`SELECT status, error_code, credit_reservation_id, asset_id
    FROM redraw_assets WHERE id IN (${started.batch.asset_ids.map(() => '?').join(',')})`).all(...started.batch.asset_ids);
  assert.equal(batch.status, 'needs_attention');
  assert.equal(attempts.every((row) => row.status === 'needs_attention'), true);
  assert.equal(attempts.every((row) => row.error_code === 'REDRAW_ASSET_BATCH_SYSTEM_UNKNOWN'), true);
  assert.equal(attempts.every((row) => row.asset_id === null), true);
  assert.equal(state.db.prepare("SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE status = 'confirmed'").get().count, 0);
  assert.equal(state.db.prepare("SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE status = 'refunded'").get().count, 0);
  assert.equal(state.db.prepare("SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE status = 'held'").get().count, 2);
  cleanup(state);
});

test('startAssetBatch refunds queued children that were never dispatched after a fatal worker error', async () => {
  const state = setupBatchState();
  const selected = [state.assetIds.character, state.assetIds.scene, state.assetIds.prop];
  const quote = quoteAssetBatch(state.db, { ...state.ctx, assetIds: selected });
  let providerCalls = 0;
  const started = startAssetBatch({
    ...state.ctx,
    provider: async () => {
      providerCalls += 1;
      throw new TypeError('provider fatal before queued siblings');
    },
    schedule: (job) => job(),
  }, { quoteHash: quote.quote_hash, idempotencyKey: 'fatal-queued-refund', assetIds: selected }, { concurrency: 1 });

  await assert.rejects(started.completion, /provider fatal before queued siblings/);
  assert.equal(providerCalls, 1);
  const batch = getAssetBatch(state.db, state.ctx, started.batch.id);
  const attempts = state.db.prepare(`SELECT id, status, generation_task_id, credit_reservation_id
    FROM redraw_assets WHERE id IN (${started.batch.asset_ids.map(() => '?').join(',')}) ORDER BY id ASC`)
    .all(...started.batch.asset_ids);
  assert.equal(batch.status, 'needs_attention');
  assert.equal(batch.success_count, 0);
  assert.equal(batch.failed_count, 2);
  assert.equal(attempts[0].status, 'needs_attention');
  assert.equal(taskService.getTask(state.db, attempts[0].generation_task_id).status, 'needs_attention');
  assert.equal(credits.getReservation(state.db, attempts[0].credit_reservation_id).status, 'held');
  for (const attempt of attempts.slice(1)) {
    assert.equal(attempt.status, 'failed');
    assert.equal(taskService.getTask(state.db, attempt.generation_task_id).status, 'failed');
    assert.equal(credits.getReservation(state.db, attempt.credit_reservation_id).status, 'refunded');
  }
  cleanup(state);
});

test('startAssetBatch treats provider task id persistence failure as fatal before finalize', async () => {
  const state = setupBatchState();
  state.db.exec(`
    CREATE TRIGGER block_provider_task_id_update
    BEFORE UPDATE OF provider_task_id ON async_tasks
    WHEN NEW.provider_task_id = 'blocked-provider'
    BEGIN
      SELECT RAISE(FAIL, 'provider_task_id audit write failed');
    END;
  `);
  const quote = quoteAssetBatch(state.db, { ...state.ctx, assetIds: [state.assetIds.prop] });
  const started = startAssetBatch({
    ...state.ctx,
    provider: async () => ({ status: 'completed', asset_id: 103, provider_task_id: 'blocked-provider' }),
    schedule: (job) => job(),
  }, { quoteHash: quote.quote_hash, idempotencyKey: 'provider-id-write-fatal', assetIds: [state.assetIds.prop] });

  await assert.rejects(started.completion, /provider_task_id audit write failed/);
  const batch = getAssetBatch(state.db, state.ctx, started.batch.id);
  const attempt = state.db.prepare('SELECT status, error_code, error_message, credit_reservation_id, asset_id, generation_task_id FROM redraw_assets WHERE id = ?')
    .get(started.batch.asset_ids[0]);
  const childTask = taskService.getTask(state.db, attempt.generation_task_id);
  assert.equal(batch.status, 'needs_attention');
  assert.match(batch.error_message, /provider_task_id/);
  assert.equal(attempt.status, 'needs_attention');
  assert.equal(attempt.asset_id, null);
  assert.match(attempt.error_message, /provider_task_id/);
  assert.equal(childTask.status, 'needs_attention');
  assert.equal(childTask.provider_task_id, null);
  assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(attempt.credit_reservation_id).status, 'held');
  cleanup(state);
});

test('quoteAssetBatch blocks scene clean plate when trusted source dimensions are missing', () => {
  const state = setupBatchState();
  state.db.prepare('UPDATE assets SET width = NULL, height = NULL WHERE id = 101').run();
  const quote = quoteAssetBatch(state.db, { ...state.ctx, assetIds: [state.assetIds.scene] });

  assert.equal(quote.priced, false);
  assert.equal(quote.blocked[0].code, 'CLEAN_PLATE_SOURCE_DIMENSIONS_REQUIRED');
  assert.throws(
    () => startAssetBatch(state.ctx, { quoteHash: quote.quote_hash, idempotencyKey: 'missing-clean-dimensions', assetIds: [state.assetIds.scene] }),
    (error) => error.code === 'REDRAW_ASSET_BATCH_UNPRICED',
  );
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM redraw_asset_batches').get().count, 0);
  cleanup(state);
});

test('quoteAssetBatch uses scene snapshot dimensions before version source asset dimensions', () => {
  const state = setupBatchState();
  state.db.prepare('UPDATE redraw_assets SET source_ref_json = ? WHERE id = ?').run(
    JSON.stringify({
      source_ref: { id: 'scene-1', kind: 'scene' },
      snapshot: { source_width: 320, source_height: 180 },
    }),
    state.assetIds.scene,
  );
  const quote = quoteAssetBatch(state.db, { ...state.ctx, assetIds: [state.assetIds.scene] });

  assert.equal(quote.priced, true);
  assert.equal(quote.items[0].expected_width, 320);
  assert.equal(quote.items[0].expected_height, 180);
  cleanup(state);
});

test('startAssetBatch validates clean plate output against quoted source dimensions', async () => {
  const mismatch = setupBatchState();
  mismatch.db.prepare('UPDATE assets SET width = 320, height = 180 WHERE id = 101').run();
  const mismatchQuote = quoteAssetBatch(mismatch.db, { ...mismatch.ctx, assetIds: [mismatch.assetIds.scene] });
  assert.equal(mismatchQuote.items[0].expected_width, 320);
  assert.equal(mismatchQuote.items[0].expected_height, 180);
  const mismatchStarted = startAssetBatch({
    ...mismatch.ctx,
    provider: async () => ({
      status: 'completed',
      asset_id: 102,
      quality: {
        width: 640,
        height: 360,
        mask_area_changed: true,
        non_mask_similarity: 0.97,
      },
    }),
    schedule: (job) => job(),
  }, { quoteHash: mismatchQuote.quote_hash, idempotencyKey: 'clean-dim-mismatch', assetIds: [mismatch.assetIds.scene] });
  await mismatchStarted.completion;
  const mismatchAttempt = mismatch.db.prepare('SELECT status, error_code, credit_reservation_id, source_ref_json FROM redraw_assets WHERE id = ?')
    .get(mismatchStarted.batch.asset_ids[0]);
  assert.equal(mismatchAttempt.status, 'failed');
  assert.equal(mismatchAttempt.error_code, 'CLEAN_PLATE_QUALITY_FAILED');
  assert.equal(JSON.parse(mismatchAttempt.source_ref_json).snapshot.expected_width, 320);
  assert.equal(mismatch.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(mismatchAttempt.credit_reservation_id).status, 'refunded');
  cleanup(mismatch);

  const success = setupBatchState();
  success.db.prepare('UPDATE assets SET width = 320, height = 180 WHERE id = 101').run();
  const successQuote = quoteAssetBatch(success.db, { ...success.ctx, assetIds: [success.assetIds.scene] });
  const successStarted = startAssetBatch({
    ...success.ctx,
    provider: async () => ({
      status: 'completed',
      asset_id: 102,
      quality: {
        width: 320,
        height: 180,
        mask_area_changed: true,
        non_mask_similarity: 0.97,
      },
    }),
    schedule: (job) => job(),
  }, { quoteHash: successQuote.quote_hash, idempotencyKey: 'clean-dim-match', assetIds: [success.assetIds.scene] });
  await successStarted.completion;
  const successAttempt = success.db.prepare('SELECT status, clean_plate_asset_id, credit_reservation_id FROM redraw_assets WHERE id = ?')
    .get(successStarted.batch.asset_ids[0]);
  assert.equal(successAttempt.status, 'needs_attention');
  assert.equal(successAttempt.clean_plate_asset_id, 102);
  assert.equal(success.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(successAttempt.credit_reservation_id).status, 'confirmed');
  cleanup(success);
});

test('startAssetBatch reports completed and failed for all-success and all-failed batches with per-attempt snapshots', async () => {
  const success = setupBatchState();
  const successQuote = quoteAssetBatch(success.db, success.ctx);
  const successStarted = startAssetBatch({
    ...success.ctx,
    provider: async (job) => ({
      status: 'completed',
      asset_id: job.asset.kind === 'voice' ? 104 : job.asset.kind === 'prop' ? 103 : job.asset.kind === 'scene' ? 102 : 101,
      ...voiceCompletionEvidence(success, job),
      quality: job.asset.kind === 'scene' ? {
        width: 1280,
        height: 720,
        mask_area_changed: true,
        non_mask_similarity: 0.97,
      } : undefined,
      metadata: job.asset.kind === 'character' ? { views: ['front', 'side', 'back'] } : {},
    }),
    schedule: (job) => job(),
  }, { quoteHash: successQuote.quote_hash, idempotencyKey: 'all-success' });
  await successStarted.completion;
  assert.equal(getAssetBatch(success.db, success.ctx, successStarted.batch.id).status, 'completed');
  const completedBatch = getAssetBatch(success.db, success.ctx, successStarted.batch.id);
  assert.deepEqual(completedBatch.selected_asset_ids, successQuote.items.map((item) => item.asset_id));
  assert.deepEqual(completedBatch.attempt_ids, successStarted.batch.asset_ids);
  const rows = success.db.prepare(`
    SELECT id, kind, source_ref_json, asset_id, clean_plate_asset_id, voice_asset_id, status
    FROM redraw_assets
    WHERE id IN (${successStarted.batch.asset_ids.map(() => '?').join(',')})
    ORDER BY CASE kind WHEN 'character' THEN 1 WHEN 'scene' THEN 2 WHEN 'prop' THEN 3 WHEN 'voice' THEN 4 ELSE 9 END
  `).all(...successStarted.batch.asset_ids);
  const byKind = new Map(successQuote.items.map((item) => [item.kind, item]));
  for (const row of rows) {
    const snapshot = JSON.parse(row.source_ref_json).snapshot;
    const quoted = byKind.get(row.kind);
    assert.equal(snapshot.asset_id, quoted.asset_id);
    assert.equal(snapshot.version_number, quoted.version_number);
    assert.equal(snapshot.kind, quoted.kind);
    assert.equal(snapshot.prompt_hash, quoted.prompt_hash);
    assert.equal(snapshot.capability, quoted.capability);
    assert.equal(snapshot.provider, quoted.provider);
    assert.equal(snapshot.model, quoted.model);
    assert.deepEqual(snapshot.evidence, quoted.evidence);
    assert.equal(snapshot.credits, quoted.credits);
    assert.equal(snapshot.quote_hash, successQuote.quote_hash);
  }
  const scene = rows.find((row) => row.kind === 'scene');
  const prop = rows.find((row) => row.kind === 'prop');
  assert.equal(scene.clean_plate_asset_id, 102);
  assert.equal(scene.asset_id, null);
  assert.equal(scene.status, 'needs_attention');
  assert.equal(prop.asset_id, 103);
  assert.equal(prop.clean_plate_asset_id, null);
  cleanup(success);

  const failed = setupBatchState();
  const failedQuote = quoteAssetBatch(failed.db, failed.ctx);
  const failedStarted = startAssetBatch({
    ...failed.ctx,
    provider: async () => { throw new Error('provider failed'); },
    schedule: (job) => job(),
  }, { quoteHash: failedQuote.quote_hash, idempotencyKey: 'all-failed' });
  await failedStarted.completion;
  assert.equal(getAssetBatch(failed.db, failed.ctx, failedStarted.batch.id).status, 'failed');
  assert.equal(credits.getTenantAccount(failed.db, 'tenant-a').spent, 0);
  cleanup(failed);
});

test('startAssetBatch idempotency replays the existing batch without refreezing or dispatching', async () => {
  const state = setupBatchState();
  const quote = quoteAssetBatch(state.db, state.ctx);
  const batchReads = [];
  let releaseProvider;
  let calls = 0;
  const first = startAssetBatch({
    ...state.ctx,
    provider: async (job) => {
      calls += 1;
      if (calls === 1) await new Promise((resolve) => { releaseProvider = resolve; });
      return {
        status: 'completed',
        asset_id: job.asset.kind === 'voice' ? 104 : job.asset.kind === 'prop' ? 103 : job.asset.kind === 'scene' ? 102 : 101,
        ...voiceCompletionEvidence(state, job),
        quality: job.asset.kind === 'scene' ? {
          width: 1280,
          height: 720,
          mask_area_changed: true,
          non_mask_similarity: 0.97,
        } : undefined,
        metadata: job.asset.kind === 'character' ? { views: ['front', 'side', 'back'] } : {},
      };
    },
    schedule: (job) => job(),
  }, { quoteHash: quote.quote_hash, idempotencyKey: 'same-key' }, {
    trace(event) {
      if (event.event === 'idempotency_read') batchReads.push(event);
    },
  });
  const replay = startAssetBatch({
    ...state.ctx,
    provider: async () => {
      throw new Error('must not dispatch replay');
    },
  }, { quoteHash: quote.quote_hash, idempotencyKey: 'same-key' }, {
    trace(event) {
      if (event.event === 'idempotency_read') batchReads.push(event);
    },
  });
  assert.equal(replay.completion, first.completion);
  releaseProvider();
  await first.completion;

  assert.equal(replay.batch.id, first.batch.id);
  assert.equal(replay.task.id, first.task.id);
  assert.equal(calls, 4);
  assert.equal(batchReads.length, 2);
  assert.equal(batchReads.every((entry) => entry.inImmediateTransaction === true), true);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 4);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM redraw_asset_batches').get().count, 1);
  assert.equal(state.db.prepare("SELECT COUNT(*) AS count FROM async_tasks WHERE type = 'redraw_asset_batch'").get().count, 1);
  cleanup(state);
});

test('startAssetBatch returns null completion for untracked non-terminal replay after restart', () => {
  const state = setupBatchState();
  const now = new Date().toISOString();
  const parentTask = taskService.createTask(state.db, { info() {} }, 'redraw_asset_batch', 'redraw_asset_batch:restart');
  state.db.prepare('UPDATE async_tasks SET tenant_id = ?, user_id = ? WHERE id = ?')
    .run(state.ctx.tenantId, state.ctx.userId, parentTask.id);
  const quote = quoteAssetBatch(state.db, { ...state.ctx, assetIds: [state.assetIds.prop] });
  const result = state.db.prepare(`INSERT INTO redraw_asset_batches
    (version_id, tenant_id, user_id, task_id, idempotency_key, quote_snapshot_json,
     asset_ids_json, status, total_count, success_count, failed_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'restart-key', ?, '[]', 'processing', 1, 0, 0, ?, ?)`)
    .run(state.versionId, state.ctx.tenantId, state.ctx.userId, parentTask.id, JSON.stringify(quote), now, now);

  const replay = startAssetBatch(state.ctx, {
    quoteHash: quote.quote_hash,
    idempotencyKey: 'restart-key',
    assetIds: [state.assetIds.prop],
  });

  assert.equal(replay.batch.id, Number(result.lastInsertRowid));
  assert.equal(replay.completion, null);
  cleanup(state);
});

test('reconcileOrphanedBatches refunds unsubmitted pending children and flags possibly dispatched work', () => {
  const pending = setupBatchState({ failedOnly: true });
  const quote = quoteAssetBatch(pending.db, pending.ctx);
  const started = startAssetBatch({
    ...pending.ctx,
    schedule: () => new Promise(() => {}),
    provider: async () => ({ status: 'completed', asset_id: 102 }),
  }, { quoteHash: quote.quote_hash, idempotencyKey: 'orphan-pending' });
  pending.db.prepare("UPDATE redraw_asset_batches SET status = 'processing' WHERE id = ?").run(started.batch.id);
  const count = reconcileOrphanedBatches(pending.db, { warn() {}, info() {} });
  assert.equal(count, 1);
  assert.equal(getAssetBatch(pending.db, pending.ctx, started.batch.id).status, 'failed');
  assert.equal(credits.getTenantAccount(pending.db, 'tenant-a').held, 0);
  const pendingAttempt = pending.db.prepare('SELECT status, generation_task_id FROM redraw_assets WHERE id = ?')
    .get(started.batch.asset_ids[0]);
  assert.equal(pendingAttempt.status, 'failed');
  assert.equal(taskService.getTask(pending.db, pendingAttempt.generation_task_id).status, 'failed');
  cleanup(pending);

  const dispatched = setupBatchState({ failedOnly: true });
  const dispatchedQuote = quoteAssetBatch(dispatched.db, dispatched.ctx);
  const dispatchedStarted = startAssetBatch({
    ...dispatched.ctx,
    schedule: () => new Promise(() => {}),
    provider: async () => ({ status: 'completed', asset_id: 102 }),
  }, { quoteHash: dispatchedQuote.quote_hash, idempotencyKey: 'orphan-dispatched' });
  const generationTaskId = dispatched.db.prepare('SELECT generation_task_id FROM redraw_assets WHERE id = ?')
    .get(dispatchedStarted.batch.asset_ids[0]).generation_task_id;
  dispatched.db.prepare('UPDATE async_tasks SET provider_task_id = ? WHERE id = ?')
    .run('provider-task-live', generationTaskId);
  const dispatchedCount = reconcileOrphanedBatches(dispatched.db, { warn() {}, info() {} });
  assert.equal(dispatchedCount, 1);
  assert.equal(getAssetBatch(dispatched.db, dispatched.ctx, dispatchedStarted.batch.id).status, 'needs_attention');
  assert.equal(credits.getTenantAccount(dispatched.db, 'tenant-a').held, 5);
  cleanup(dispatched);
});

test('reconcileOrphanedBatches refunds provably pending children while holding a dispatched sibling', () => {
  const state = setupBatchState();
  const selected = [state.assetIds.character, state.assetIds.scene];
  const quote = quoteAssetBatch(state.db, { ...state.ctx, assetIds: selected });
  const started = startAssetBatch({
    ...state.ctx,
    schedule: () => new Promise(() => {}),
    provider: async () => ({ status: 'completed', asset_id: 102 }),
  }, { quoteHash: quote.quote_hash, idempotencyKey: 'orphan-mixed', assetIds: selected });
  state.db.prepare("UPDATE redraw_asset_batches SET status = 'processing' WHERE id = ?").run(started.batch.id);
  const [dispatchedAttemptId, pendingAttemptId] = started.batch.asset_ids;
  const dispatchedAttempt = state.db.prepare('SELECT generation_task_id FROM redraw_assets WHERE id = ?')
    .get(dispatchedAttemptId);
  state.db.prepare("UPDATE redraw_assets SET status = 'processing' WHERE id = ?").run(dispatchedAttemptId);
  taskService.updateTaskStatus(state.db, dispatchedAttempt.generation_task_id, 'processing', 10, 'worker entered');

  assert.equal(reconcileOrphanedBatches(state.db, { warn() {}, info() {} }), 1);
  const reconciled = getAssetBatch(state.db, state.ctx, started.batch.id);
  assert.equal(reconciled.status, 'needs_attention');
  assert.equal(reconciled.success_count, 0);
  assert.equal(reconciled.failed_count, 1);
  assert.equal(state.db.prepare('SELECT status FROM redraw_assets WHERE id = ?').get(dispatchedAttemptId).status, 'needs_attention');
  assert.equal(taskService.getTask(state.db, dispatchedAttempt.generation_task_id).status, 'needs_attention');
  const pendingAttempt = state.db.prepare('SELECT status, generation_task_id FROM redraw_assets WHERE id = ?')
    .get(pendingAttemptId);
  assert.equal(pendingAttempt.status, 'failed');
  assert.equal(taskService.getTask(state.db, pendingAttempt.generation_task_id).status, 'failed');
  assert.equal(credits.getTenantAccount(state.db, 'tenant-a').held, quote.items[0].credits);
  cleanup(state);
});

test('reconcileOrphanedBatches keeps processing or unknown-no-id children held without replay', async (t) => {
  for (const stage of ['worker processing', 'unknown without id']) {
    await t.test(stage, async () => {
      const state = setupBatchState({ failedOnly: true });
      const quote = quoteAssetBatch(state.db, state.ctx);
      let providerCalls = 0;
      const request = { quoteHash: quote.quote_hash, idempotencyKey: `orphan-${stage}` };
      const context = {
        ...state.ctx,
        schedule: () => new Promise(() => {}),
        provider: async () => { providerCalls += 1; },
      };
      const started = startAssetBatch(context, request);
      const attempt = state.db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(started.batch.asset_ids[0]);
      state.db.prepare("UPDATE redraw_asset_batches SET status = 'processing' WHERE id = ?").run(started.batch.id);
      if (stage === 'worker processing') {
        state.db.prepare("UPDATE redraw_assets SET status = 'processing' WHERE id = ?").run(attempt.id);
        taskService.updateTaskStatus(state.db, attempt.generation_task_id, 'processing', 10, 'worker entered');
      } else {
        state.db.prepare("UPDATE redraw_assets SET status = 'needs_attention', error_code = 'REDRAW_ASSET_PROVIDER_UNKNOWN' WHERE id = ?")
          .run(attempt.id);
        taskService.updateTaskStatus(state.db, attempt.generation_task_id, 'needs_attention', 90, 'unknown without provider id');
      }

      assert.equal(taskService.getTask(state.db, attempt.generation_task_id).provider_task_id, null);
      assert.equal(reconcileOrphanedBatches(state.db, { warn() {}, info() {} }), 1);
      assert.equal(getAssetBatch(state.db, state.ctx, started.batch.id).status, 'needs_attention');
      assert.equal(state.db.prepare('SELECT status FROM redraw_assets WHERE id = ?').get(attempt.id).status, 'needs_attention');
      assert.equal(taskService.getTask(state.db, attempt.generation_task_id).status, 'needs_attention');
      assert.equal(credits.getTenantAccount(state.db, 'tenant-a').held, 5);
      const replay = startAssetBatch(context, request);
      await replay.completion;
      assert.equal(providerCalls, 0);
      cleanup(state);
    });
  }
});
