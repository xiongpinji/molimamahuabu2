const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const credits = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const taskService = require('../src/services/taskService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const {
  quoteAssetBatch,
  startAssetBatch,
  getAssetBatch,
  reconcileOrphanedBatches,
} = require('../src/services/redrawAssetBatchService');

function setupBatchState(options = {}) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-batch-'));
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  for (const file of ['character.png', 'scene.png', 'prop.png', 'voice.mp3', 'evidence.txt']) {
    fs.writeFileSync(path.join(root, 'artifacts', file), file);
  }
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO assets (id, name, type, category, url, local_path, mime_type, created_at, updated_at)
    VALUES
      (101, 'character', 'image', 'redraw', '', 'artifacts/character.png', 'image/png', ?, ?),
      (102, 'scene', 'image', 'redraw', '', 'artifacts/scene.png', 'image/png', ?, ?),
      (103, 'prop', 'image', 'redraw', '', 'artifacts/prop.png', 'image/png', ?, ?),
      (104, 'voice', 'audio', 'redraw', '', 'artifacts/voice.mp3', 'audio/mpeg', ?, ?),
      (900, 'evidence', 'text', 'redraw', '', 'artifacts/evidence.txt', 'text/plain', ?, ?)`)
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
              tts: evidence('fake-tts', models.tts, 'ev-tts'),
            },
          }],
        }),
        now,
        now,
      );
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
        JSON.stringify({ source_ref: { id: `${kind}-1`, kind } }),
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
  };
  return { db, root, versionId, assetIds, ctx };
}

function cleanup(state) {
  fs.rmSync(state.root, { recursive: true, force: true });
  state.db.close();
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

test('startAssetBatch reports completed and failed for all-success and all-failed batches with per-attempt snapshots', async () => {
  const success = setupBatchState();
  const successQuote = quoteAssetBatch(success.db, success.ctx);
  const successStarted = startAssetBatch({
    ...success.ctx,
    provider: async (job) => ({
      status: 'completed',
      asset_id: job.asset.kind === 'voice' ? 104 : job.asset.kind === 'prop' ? 103 : job.asset.kind === 'scene' ? 102 : 101,
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
  const count = reconcileOrphanedBatches(pending.db, { warn() {}, info() {} });
  assert.equal(count, 1);
  assert.equal(getAssetBatch(pending.db, pending.ctx, started.batch.id).status, 'failed');
  assert.equal(credits.getTenantAccount(pending.db, 'tenant-a').held, 0);
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
