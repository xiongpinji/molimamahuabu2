const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const credits = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const taskService = require('../src/services/taskService');
const videoService = require('../src/services/videoService');
const redrawOrchestrator = require('../src/services/redrawOrchestrator');
const { resetGenerationConcurrencyForTests } = require('../src/services/generationConcurrency');
const {
  generateShot,
  generateBatch,
  retryShot,
  recoverInterruptedShotGenerations,
  markInterruptedShotGenerationsNeedsAttention,
  runShotGeneration,
  verifyVideoArtifact,
  classifyVideoOutcome,
} = require('../src/services/redrawGenerationService');

const log = { info() {}, warn() {}, error() {} };

function setup(overrides = {}) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  prices.set(db, 'seedance 2.0', 2, {
    category: 'video',
    billing_unit: 'second',
    resolution_prices: { '720p': { credits: 3 }, '480p': { credits: 2 } },
  });
  addVerifiedGenerationCapability(db, 'seedance 2.0');
  credits.setTenantAccountBalance(db, 'tenant-a', 500);
  credits.setAccountBalance(db, 'user-a', 500);
  const now = new Date('2026-08-06T00:00:00.000Z').toISOString();
  db.prepare(`INSERT INTO redraw_projects
    (tenant_id, user_id, title, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', '转绘项目', ?, ?)`).run(now, now);
  const projectId = db.prepare('SELECT id FROM redraw_projects LIMIT 1').get().id;
  db.prepare(`INSERT INTO redraw_works
    (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
     duration_ms, current_version, current_step, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', '转绘作品', 1, ?, 15000, 1, 3, 'ready_to_generate', ?, ?)`)
    .run(projectId, `source-${Math.random()}`, now, now);
  const workId = db.prepare('SELECT id FROM redraw_works LIMIT 1').get().id;
  db.prepare(`INSERT INTO redraw_versions
    (work_id, tenant_id, user_id, version, locale, market, style_snapshot_json, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 1, 'zh-CN', 'CN', ?, 'ready_to_generate', ?, ?)`)
    .run(workId, JSON.stringify(overrides.styleSnapshot || { tone: 'warm', lens: '35mm' }), now, now);
  const versionId = db.prepare('SELECT id FROM redraw_versions LIMIT 1').get().id;
  return { db, now, versionId };
}

function addBaseAsset(db, input) {
  const now = new Date().toISOString();
  return db.prepare(`INSERT INTO assets
    (name, type, category, url, local_path, created_at, updated_at)
    VALUES (?, 'image', ?, ?, ?, ?, ?)`)
    .run(input.name, input.category || 'redraw', input.url || '', input.localPath || null, now, now)
    .lastInsertRowid;
}

function addRedrawAsset(db, versionId, input) {
  const now = new Date().toISOString();
  return db.prepare(`INSERT INTO redraw_assets
    (version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     asset_id, clean_plate_asset_id, approval_status, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', ?, '{}', ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      versionId,
      input.kind,
      input.name || input.kind,
      input.assetId || null,
      input.cleanPlateAssetId || null,
      input.approvalStatus || 'approved',
      input.status || 'generated',
      now,
      now,
    ).lastInsertRowid;
}

function addShot(db, versionId, overrides = {}) {
  const now = new Date().toISOString();
  const durationMs = overrides.durationMs || overrides.duration_ms || 6000;
  const startMs = overrides.startMs || overrides.start_ms || 0;
  const endMs = overrides.endMs || overrides.end_ms || (startMs + durationMs);
  const references = overrides.references || [];
  const compiled = overrides.compiledPrompt || {
    text: 'compiled hero prompt',
    negative_prompt: 'low quality',
    model: 'seedance 2.0',
    duration: 6,
    resolution: '720p',
    aspect_ratio: '9:16',
  };
  const draft = overrides.draft || { attempt: 1, model: 'seedance 2.0' };
  return db.prepare(`INSERT INTO redraw_shots
    (version_id, tenant_id, user_id, batch_index, shot_index, start_ms, end_ms, duration_ms,
     references_json, prompt, negative_prompt, compiled_prompt_json, draft_json, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      versionId,
      overrides.shotIndex || 1,
      startMs,
      endMs,
      durationMs,
      JSON.stringify(references),
      overrides.prompt || 'fallback prompt',
      overrides.negativePrompt || '',
      typeof compiled === 'string' ? compiled : JSON.stringify(compiled),
      typeof draft === 'string' ? draft : JSON.stringify(draft),
      overrides.status || 'draft',
      now,
      now,
    ).lastInsertRowid;
}

function ctx(db, overrides = {}) {
  return {
    db,
    log,
    tenantId: 'tenant-a',
    userId: 'user-a',
    clock: () => '2026-08-06T00:00:00.000Z',
    canReadArtifact: () => true,
    ...overrides,
  };
}

function count(db, table, where = '1=1') {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get().count;
}

function addVerifiedGenerationCapability(db, model, overrides = {}) {
  const now = new Date('2026-08-06T00:00:00.000Z').toISOString();
  db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, model, default_model, is_active, is_default, priority, settings, created_at, updated_at)
    VALUES ('video', 'test-provider', '转绘生成能力', ?, ?, 1, 1, 0, ?, ?, ?)
  `).run(
    model,
    model,
    JSON.stringify({
      redraw_locale_capabilities: [{
        locale: overrides.locale || 'zh-CN',
        market: overrides.market || 'CN',
        status: 'verified',
        evidence: {
          video: {
            provider: 'test-provider',
            model,
            task_id: `verified-${model}`,
            terminal_status: 'completed',
            artifact_id: `artifact-${model}`,
          },
        },
      }],
    }),
    now,
    now,
  );
}

function addRawVideoConfig(db, settings, model = 'raw-config-model') {
  const now = new Date('2026-08-06T00:00:00.000Z').toISOString();
  db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, model, default_model, is_active, is_default, priority, settings, created_at, updated_at)
    VALUES ('video', 'test-provider', 'raw config', ?, ?, 1, 0, 0, ?, ?, ?)
  `).run(model, model, settings, now, now);
}

test('verified 生成模型跳过坏配置并按确定顺序选中后续有效非 seedance 模型', async () => {
  const state = setup();
  const model = 'verified-later-video-v1';
  try {
    state.db.prepare('DELETE FROM ai_service_configs').run();
    addRawVideoConfig(state.db, '{bad-settings-json', 'bad-settings');
    addRawVideoConfig(state.db, JSON.stringify({
      redraw_locale_capabilities: [{
        locale: 'zh-CN',
        market: 'CN',
        status: 'verified',
        video_evidence_json: '{bad-evidence-json',
      }],
    }), 'bad-evidence');
    prices.set(state.db, model, 5, {
      category: 'video',
      billing_unit: 'second',
      resolution_prices: { '720p': { credits: 7 } },
    });
    addVerifiedGenerationCapability(state.db, model);
    const shotId = addShot(state.db, state.versionId, {
      draft: { model: 'draft-stale-model', duration: 6, resolution: '720p' },
    });

    const result = await generateShot(ctx(state.db, {
      canReadArtifact: (artifactId) => artifactId === `artifact-${model}`,
      schedule() {},
    }), { shotId, model: 'client-forged-model' });

    assert.equal(result.status, 'processing');
    assert.equal(state.db.prepare('SELECT model FROM tenant_usage_reservations').get().model, model);
    assert.equal(state.db.prepare('SELECT model FROM video_generations').get().model, model);
    assert.equal(state.db.prepare("SELECT model FROM async_tasks WHERE type = 'redraw_shot'").get().model, model);
  } finally {
    state.db.close();
  }
});

test('批量生成全是坏 capability 配置时 fail closed 且不冻结不提交 provider', async () => {
  const state = setup();
  let providerCalls = 0;
  try {
    state.db.prepare('DELETE FROM ai_service_configs').run();
    addRawVideoConfig(state.db, '{bad-settings-json', 'bad-settings');
    addRawVideoConfig(state.db, JSON.stringify({
      redraw_locale_capabilities: [{
        locale: 'zh-CN',
        market: 'CN',
        status: 'verified',
        video_evidence_json: '{bad-evidence-json',
      }],
    }), 'bad-evidence');
    const shotId = addShot(state.db, state.versionId);

    const batch = await generateBatch(ctx(state.db, {
      videoProcessor: async () => { providerCalls += 1; },
    }), {
      versionId: state.versionId,
      shotIds: [shotId],
      model: 'client-forged-model',
    });

    assert.equal(batch.results[0].error_code, 'REDRAW_NO_VERIFIED_VIDEO_MODEL');
    assert.notEqual(batch.results[0].status, 'processing');
    assert.equal(providerCalls, 0);
    assert.equal(count(state.db, 'tenant_usage_reservations'), 0);
    assert.equal(count(state.db, 'async_tasks'), 0);
    assert.equal(count(state.db, 'video_generations'), 0);
    assert.equal(credits.getTenantAccount(state.db, 'tenant-a').held, 0);
  } finally {
    state.db.close();
  }
});

test('未审批 gate 不冻结、不建任务或视频、不调用处理器', async () => {
  const state = setup();
  let calls = 0;
  try {
    const baseId = addBaseAsset(state.db, { name: 'char', url: 'https://cdn.test/char.png' });
    const redrawAssetId = addRedrawAsset(state.db, state.versionId, {
      kind: 'character',
      assetId: baseId,
      approvalStatus: 'pending',
    });
    const shotId = addShot(state.db, state.versionId, {
      references: [{ kind: 'character', asset_id: redrawAssetId }],
    });

    await assert.rejects(
      () => generateShot(ctx(state.db, {
        awaitCompletion: true,
        videoProcessor: async () => { calls += 1; },
      }), { shotId }),
      (error) => {
        assert.equal(error.code, 'REDRAW_ASSET_REVIEW_REQUIRED');
        assert.equal(error.details.missing.length, 1);
        return true;
      },
    );
    assert.equal(calls, 0);
    assert.equal(count(state.db, 'tenant_usage_reservations'), 0);
    assert.equal(count(state.db, 'async_tasks'), 0);
    assert.equal(count(state.db, 'video_generations'), 0);
  } finally {
    state.db.close();
  }
});

test('gate 通过后只创建 redraw_shot task 和单条 video row，供应商输入受控', async () => {
  const state = setup();
  const processorInputs = [];
  try {
    const character = addBaseAsset(state.db, { name: 'char', url: 'https://cdn.test/char.png' });
    const prop = addBaseAsset(state.db, { name: 'prop', localPath: 'props/knife.png' });
    const sceneDirty = addBaseAsset(state.db, { name: 'scene-raw', url: 'https://cdn.test/raw.png' });
    const sceneClean = addBaseAsset(state.db, { name: 'scene-clean', localPath: 'scenes/clean.png' });
    const voice = addBaseAsset(state.db, { name: 'voice', url: 'https://cdn.test/voice.mp3' });
    const characterRef = addRedrawAsset(state.db, state.versionId, { kind: 'character', assetId: character });
    const propRef = addRedrawAsset(state.db, state.versionId, { kind: 'prop', assetId: prop });
    const sceneRef = addRedrawAsset(state.db, state.versionId, {
      kind: 'scene',
      assetId: sceneDirty,
      cleanPlateAssetId: sceneClean,
    });
    const voiceRef = addRedrawAsset(state.db, state.versionId, { kind: 'voice', assetId: voice });
    const shotId = addShot(state.db, state.versionId, {
      references: [
        { kind: 'character', asset_id: characterRef },
        { kind: 'prop', asset_id: propRef },
        { kind: 'scene', asset_id: sceneRef },
        { kind: 'voice', asset_id: voiceRef },
      ],
      draft: { model: 'seedance 2.0', reference_image_urls: ['https://evil.test/free.png'] },
    });

    const result = await generateShot(ctx(state.db, {
      awaitCompletion: false,
      schedule: () => {},
      videoProcessor: async (db, _log, videoGenerationId) => {
        processorInputs.push(db.prepare('SELECT * FROM video_generations WHERE id = ?').get(videoGenerationId));
      },
    }), { shotId, count: 9 });

    assert.equal(result.status, 'processing');
    assert.equal(count(state.db, "async_tasks", "type = 'redraw_shot'"), 1);
    assert.equal(count(state.db, "async_tasks", "type = 'video_generation'"), 0);
    assert.equal(count(state.db, 'video_generations'), 1);
    assert.equal(count(state.db, 'tenant_usage_reservations'), 1);
    const task = state.db.prepare("SELECT * FROM async_tasks WHERE type = 'redraw_shot'").get();
    const video = state.db.prepare('SELECT * FROM video_generations').get();
    const reservation = state.db.prepare('SELECT * FROM tenant_usage_reservations').get();
    const metadata = JSON.parse(task.metadata);
    const draft = JSON.parse(state.db.prepare('SELECT draft_json FROM redraw_shots WHERE id = ?').get(shotId).draft_json);

    assert.equal(video.task_id, task.id);
    assert.equal(video.credit_reservation_id, null);
    assert.equal(video.model, 'seedance 2.0');
    assert.equal(video.duration, 6);
    assert.equal(video.resolution, '720p');
    assert.equal(video.aspect_ratio, '9:16');
    assert.match(video.prompt, /compiled hero prompt/);
    assert.match(video.prompt, /Negative prompt: low quality/);
    assert.deepEqual(JSON.parse(video.reference_image_urls), [
      'https://cdn.test/char.png',
      '/static/props/knife.png',
      '/static/scenes/clean.png',
    ]);
    assert.equal(reservation.status, 'held');
    assert.equal(reservation.amount, 18);
    assert.equal(metadata.redraw_shot.reservation_id, reservation.id);
    assert.equal(draft.generation.reservation_id, reservation.id);
    assert.equal(draft.generation.count, 1);
    assert.deepEqual(processorInputs, []);
  } finally {
    state.db.close();
  }
});

test('重复相同 attempt 复用已有 processing task/video/reservation', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId);
    const first = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId });
    const second = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId });

    assert.equal(second.reused, true);
    assert.equal(second.task_id, first.task_id);
    assert.equal(second.video_generation_id, first.video_generation_id);
    assert.equal(count(state.db, "async_tasks", "type = 'redraw_shot'"), 1);
    assert.equal(count(state.db, 'video_generations'), 1);
    assert.equal(count(state.db, 'tenant_usage_reservations'), 1);
  } finally {
    state.db.close();
  }
});

test('两个 draft 并发生成由 CAS 保证 loser 复用 winner 且只冻结调度一次', async () => {
  const state = setup();
  let hookCalls = 0;
  let scheduled = 0;
  let releaseFirst;
  let firstEnteredResolve;
  const firstEntered = new Promise((resolve) => { firstEnteredResolve = resolve; });
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const beforeCreateTransaction = async () => {
    hookCalls += 1;
    if (hookCalls === 1) {
      firstEnteredResolve();
      await firstBlocked;
    }
  };
  try {
    const shotId = addShot(state.db, state.versionId);
    const context = ctx(state.db, {
      beforeCreateTransaction,
      schedule: () => { scheduled += 1; },
    });
    const firstPromise = generateShot(context, { shotId });
    await Promise.resolve();
    assert.equal(hookCalls, 1, 'beforeCreateTransaction hook must pause the first creator');
    await firstEntered;
    const winner = await generateShot(context, { shotId });
    releaseFirst();
    const loser = await firstPromise;

    assert.equal(loser.reused, true);
    assert.equal(loser.task_id, winner.task_id);
    assert.equal(loser.video_generation_id, winner.video_generation_id);
    assert.equal(loser.reservation_id, winner.reservation_id);
    assert.equal(count(state.db, "async_tasks", "type = 'redraw_shot'"), 1);
    assert.equal(count(state.db, 'video_generations'), 1);
    assert.equal(count(state.db, 'tenant_usage_reservations'), 1);
    assert.equal(credits.getTenantAccount(state.db, 'tenant-a').held, 18);
    assert.equal(scheduled, 1);
  } finally {
    releaseFirst?.();
    state.db.close();
  }
});

test('并发 loser 传入不同客户端模型时仍复用 verified 生成链且不产生第二冻结', async () => {
  const state = setup();
  prices.set(state.db, 'other-video-model', 4, {
    category: 'video',
    billing_unit: 'second',
    resolution_prices: { '720p': { credits: 4 } },
  });
  let hookCalls = 0;
  let scheduled = 0;
  let releaseFirst;
  let firstEnteredResolve;
  const firstEntered = new Promise((resolve) => { firstEnteredResolve = resolve; });
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const beforeCreateTransaction = async () => {
    hookCalls += 1;
    if (hookCalls === 1) {
      firstEnteredResolve();
      await firstBlocked;
    }
  };
  try {
    const shotId = addShot(state.db, state.versionId);
    const context = ctx(state.db, {
      beforeCreateTransaction,
      schedule: () => { scheduled += 1; },
    });
    const loserPromise = generateShot(context, { shotId, model: 'other-video-model' });
    await Promise.resolve();
    assert.equal(hookCalls, 1, 'beforeCreateTransaction hook must pause the first creator');
    await firstEntered;
    const winner = await generateShot(context, { shotId, model: 'seedance 2.0' });
    releaseFirst();
    const loser = await loserPromise;

    assert.equal(loser.reused, true);
    assert.equal(loser.task_id, winner.task_id);
    assert.equal(loser.video_generation_id, winner.video_generation_id);
    assert.equal(loser.reservation_id, winner.reservation_id);
    assert.equal(count(state.db, "async_tasks", "type = 'redraw_shot'"), 1);
    assert.equal(count(state.db, 'video_generations'), 1);
    assert.equal(count(state.db, 'tenant_usage_reservations'), 1);
    assert.equal(credits.getTenantAccount(state.db, 'tenant-a').held, 18);
    assert.equal(scheduled, 1);
    assert.equal(winner.status, 'processing');
  } finally {
    releaseFirst?.();
    state.db.close();
  }
});

test('创建事务前 updated_at 被改变时 CAS 回滚且不冻结不调度', async () => {
  const state = setup();
  let scheduled = 0;
  try {
    const shotId = addShot(state.db, state.versionId);
    await assert.rejects(
      () => generateShot(ctx(state.db, {
        beforeCreateTransaction: async () => {
          state.db.prepare('UPDATE redraw_shots SET updated_at = ? WHERE id = ?')
            .run('2026-08-06T00:00:01.000Z', shotId);
        },
        schedule: () => { scheduled += 1; },
      }), { shotId }),
      (error) => error.code === 'REDRAW_SHOT_CONFLICT',
    );
    assert.equal(count(state.db, "async_tasks", "type = 'redraw_shot'"), 0);
    assert.equal(count(state.db, 'video_generations'), 0);
    assert.equal(count(state.db, 'tenant_usage_reservations'), 0);
    assert.equal(credits.getTenantAccount(state.db, 'tenant-a').held, 0);
    assert.equal(scheduled, 0);
  } finally {
    state.db.close();
  }
});

test('跨租户调用 redraw_shot task fail closed 且不调用处理器不改状态账单', async () => {
  const state = setup();
  let calls = 0;
  try {
    const shotId = addShot(state.db, state.versionId);
    const created = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId });
    const beforeTask = state.db.prepare('SELECT status, result, completed_at FROM async_tasks WHERE id = ?').get(created.task_id);
    const beforeShot = state.db.prepare('SELECT status, error_message FROM redraw_shots WHERE id = ?').get(shotId);
    const beforeVideo = state.db.prepare('SELECT status, error_msg FROM video_generations WHERE id = ?').get(created.video_generation_id);
    const beforeReservation = state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id);

    await assert.rejects(
      () => runShotGeneration(ctx(state.db, {
        tenantId: 'tenant-b',
        userId: 'user-b',
        videoProcessor: async () => { calls += 1; },
      }), created.task_id),
      (error) => ['REDRAW_SHOT_NOT_FOUND', 'UNAUTHORIZED', 'REDRAW_SHOT_TASK_NOT_FOUND'].includes(error.code),
    );

    assert.equal(calls, 0);
    assert.deepEqual(state.db.prepare('SELECT status, result, completed_at FROM async_tasks WHERE id = ?').get(created.task_id), beforeTask);
    assert.deepEqual(state.db.prepare('SELECT status, error_message FROM redraw_shots WHERE id = ?').get(shotId), beforeShot);
    assert.deepEqual(state.db.prepare('SELECT status, error_msg FROM video_generations WHERE id = ?').get(created.video_generation_id), beforeVideo);
    assert.deepEqual(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id), beforeReservation);
  } finally {
    state.db.close();
  }
});

test('awaitCompletion 成功后写回成片素材、task result 并确认账单', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId);
    const result = await generateShot(ctx(state.db, {
      awaitCompletion: true,
      videoProcessor: async (db, _log, id) => {
        db.prepare('UPDATE video_generations SET status = ?, video_url = ?, local_path = ? WHERE id = ?')
          .run('completed', 'https://cdn.test/video.mp4', 'videos/shot.mp4', id);
      },
      artifactVerifier: async () => ({ duration: 6.1, width: 720, height: 1280 }),
      assetImporter: () => ({ id: 77 }),
    }), { shotId });

    const shot = state.db.prepare('SELECT * FROM redraw_shots WHERE id = ?').get(shotId);
    const task = state.db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(result.task_id);
    const reservation = state.db.prepare('SELECT * FROM tenant_usage_reservations').get();
    const draft = JSON.parse(shot.draft_json);
    assert.equal(result.status, 'completed');
    assert.equal(shot.status, 'completed');
    assert.equal(draft.new_video_ref.asset_id, 77);
    assert.equal(draft.new_video_ref.video_url, 'https://cdn.test/video.mp4');
    assert.equal(JSON.parse(task.result).asset_id, 77);
    assert.equal(reservation.status, 'confirmed');
  } finally {
    state.db.close();
  }
});

test('completed 终态再次 run 直接复用结果不重跑处理器也不重复确认账单', async () => {
  const state = setup();
  let calls = 0;
  try {
    const shotId = addShot(state.db, state.versionId);
    const first = await generateShot(ctx(state.db, {
      awaitCompletion: true,
      videoProcessor: async (db, _log, id) => {
        calls += 1;
        db.prepare('UPDATE video_generations SET status = ?, video_url = ?, local_path = ? WHERE id = ?')
          .run('completed', 'https://cdn.test/video.mp4', 'videos/shot.mp4', id);
      },
      artifactVerifier: async () => ({ duration: 6, width: 720, height: 1280 }),
      assetImporter: () => ({ id: 77 }),
    }), { shotId });
    const before = {
      task: state.db.prepare('SELECT status, result, completed_at FROM async_tasks WHERE id = ?').get(first.task_id),
      shot: state.db.prepare('SELECT status, draft_json FROM redraw_shots WHERE id = ?').get(shotId),
      video: state.db.prepare('SELECT status, video_url, local_path, error_msg FROM video_generations WHERE id = ?').get(first.video_generation_id),
      confirms: count(state.db, 'tenant_credit_ledger', "event_type = 'confirm'"),
    };

    const second = await runShotGeneration(ctx(state.db, {
      videoProcessor: async () => { calls += 1; },
    }), first.task_id);

    assert.equal(second.status, 'completed');
    assert.equal(second.task_id, first.task_id);
    assert.equal(second.video_generation_id, first.video_generation_id);
    assert.equal(second.asset_id, 77);
    assert.equal(calls, 1);
    assert.deepEqual(state.db.prepare('SELECT status, result, completed_at FROM async_tasks WHERE id = ?').get(first.task_id), before.task);
    assert.deepEqual(state.db.prepare('SELECT status, draft_json FROM redraw_shots WHERE id = ?').get(shotId), before.shot);
    assert.deepEqual(state.db.prepare('SELECT status, video_url, local_path, error_msg FROM video_generations WHERE id = ?').get(first.video_generation_id), before.video);
    assert.equal(count(state.db, 'tenant_credit_ledger', "event_type = 'confirm'"), before.confirms);
  } finally {
    state.db.close();
  }
});

test('同一 task 两个 runner 并发成功收口只导入一次素材并只确认一次账单', async () => {
  const state = setup();
  let processorArrivals = 0;
  let releaseProcessors;
  const processorBarrier = new Promise((resolve) => { releaseProcessors = resolve; });
  let importCalls = 0;
  try {
    const shotId = addShot(state.db, state.versionId);
    const created = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId });
    const runnerContext = ctx(state.db, {
      videoProcessor: async (db, _log, videoId) => {
        processorArrivals += 1;
        if (processorArrivals === 2) releaseProcessors();
        await processorBarrier;
        db.prepare("UPDATE video_generations SET status = 'completed', video_url = 'https://cdn.test/race.mp4', local_path = 'videos/race.mp4' WHERE id = ?")
          .run(videoId);
      },
      artifactVerifier: async () => ({ duration: 6, width: 720, height: 1280 }),
      assetImporter: (db, _log, videoId) => {
        importCalls += 1;
        const assetId = addBaseAsset(db, { name: `race-${importCalls}`, category: 'video', localPath: 'videos/race.mp4' });
        db.prepare('UPDATE assets SET video_gen_id = ? WHERE id = ?').run(videoId, assetId);
        return { id: assetId };
      },
    });
    const results = await Promise.all([
      runShotGeneration(runnerContext, created.task_id),
      runShotGeneration(runnerContext, created.task_id),
    ]);
    assert.deepEqual(results.map((result) => result.status), ['completed', 'completed']);
    assert.equal(importCalls, 1);
    assert.equal(count(state.db, 'assets', `video_gen_id = ${created.video_generation_id}`), 1);
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id).status, 'confirmed');
    assert.equal(count(state.db, 'tenant_credit_ledger', `reservation_id = '${created.reservation_id}' AND event_type = 'confirm'`), 1);
  } finally {
    releaseProcessors?.();
    state.db.close();
  }
});

test('明确失败会标记 shot failed 并退款', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId);
    const result = await generateShot(ctx(state.db, {
      awaitCompletion: true,
      videoProcessor: async (db, _log, id) => {
        db.prepare('UPDATE video_generations SET status = ?, error_msg = ? WHERE id = ?')
          .run('failed', 'provider rejected prompt', id);
      },
    }), { shotId });

    assert.equal(result.status, 'failed');
    assert.equal(state.db.prepare('SELECT status, error_message FROM redraw_shots WHERE id = ?').get(shotId).status, 'failed');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations').get().status, 'refunded');
  } finally {
    state.db.close();
  }
});

test('失败结算异常会回滚 failed 终态并原子降级 needs_attention 且保持 held', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId);
    const created = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId });
    state.db.prepare('UPDATE tenant_credit_accounts SET held = 0 WHERE tenant_id = ?').run('tenant-a');
    const result = await runShotGeneration(ctx(state.db, {
      videoProcessor: async (db, _log, id) => {
        db.prepare('UPDATE video_generations SET status = ?, error_msg = ? WHERE id = ?')
          .run('failed', 'provider rejected prompt', id);
      },
    }), created.task_id);

    assert.equal(result.status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status, error_message FROM redraw_shots WHERE id = ?').get(shotId).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status, error FROM async_tasks WHERE id = ?').get(created.task_id).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status, error_msg FROM video_generations WHERE id = ?').get(created.video_generation_id).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id).status, 'held');
  } finally {
    state.db.close();
  }
});

test('未知或仍 processing 保持 held 并转 needs_attention，不重提', async () => {
  for (const errorMsg of ['供应商结果未知，请勿重新提交', '状态未知', '仍可能处理中']) {
    const state = setup();
    let calls = 0;
    try {
      const shotId = addShot(state.db, state.versionId);
      const result = await generateShot(ctx(state.db, {
        awaitCompletion: true,
        videoProcessor: async (db, _log, id) => {
          calls += 1;
          db.prepare('UPDATE video_generations SET status = ?, error_msg = ? WHERE id = ?')
            .run('processing', errorMsg, id);
        },
      }), { shotId });

      assert.equal(result.status, 'needs_attention');
      assert.equal(calls, 1);
      assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'needs_attention');
      assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations').get().status, 'held');
    } finally {
      state.db.close();
    }
  }
});

test('completed 但成片校验或素材导入不完整时 needs_attention 且保持 held', async () => {
  for (const mode of ['missing_local_path', 'artifact_failed', 'import_failed']) {
    const state = setup();
    try {
      const shotId = addShot(state.db, state.versionId);
      const result = await generateShot(ctx(state.db, {
        awaitCompletion: true,
        videoProcessor: async (db, _log, id) => {
          db.prepare('UPDATE video_generations SET status = ?, video_url = ?, local_path = ? WHERE id = ?')
            .run('completed', 'https://cdn.test/video.mp4', mode === 'missing_local_path' ? null : 'videos/shot.mp4', id);
        },
        artifactVerifier: async () => {
          if (mode === 'artifact_failed') throw Object.assign(new Error('bad artifact'), { code: 'REDRAW_VIDEO_ARTIFACT_INVALID' });
          return { duration: 6, width: 720, height: 1280 };
        },
        assetImporter: () => (mode === 'import_failed' ? null : { id: 91 }),
      }), { shotId });
      const video = state.db.prepare(`
        SELECT status, error_msg, video_url, local_path
        FROM video_generations
        WHERE id = ?
      `).get(result.video_generation_id);
      assert.equal(result.status, 'needs_attention');
      assert.equal(video.status, 'needs_attention');
      assert.match(video.error_msg, mode === 'import_failed' ? /素材入库失败/ : /视频|artifact|bad artifact|不完整/);
      assert.equal(video.video_url, 'https://cdn.test/video.mp4');
      if (mode !== 'missing_local_path') assert.equal(video.local_path, 'videos/shot.mp4');
      assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations').get().status, 'held');
    } finally {
      state.db.close();
    }
  }
});

test('素材导入写入后抛错会回滚新增 asset 并降级 needs_attention 保持 held', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId);
    const result = await generateShot(ctx(state.db, {
      awaitCompletion: true,
      videoProcessor: async (db, _log, id) => {
        db.prepare('UPDATE video_generations SET status = ?, video_url = ?, local_path = ? WHERE id = ?')
          .run('completed', 'https://cdn.test/video.mp4', 'videos/shot.mp4', id);
      },
      artifactVerifier: async () => ({ duration: 6, width: 720, height: 1280 }),
      assetImporter: (db, _log, id) => {
        addBaseAsset(db, { name: 'orphan-video', category: 'video', localPath: 'videos/shot.mp4' });
        db.prepare('UPDATE assets SET video_gen_id = ? WHERE name = ?').run(id, 'orphan-video');
        throw new Error('asset import exploded');
      },
    }), { shotId });

    assert.equal(result.status, 'needs_attention');
    assert.equal(count(state.db, 'assets', "video_gen_id IS NOT NULL"), 0);
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(result.task_id).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM video_generations WHERE id = ?').get(result.video_generation_id).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations').get().status, 'held');
  } finally {
    state.db.close();
  }
});

test('processor 先写 completed result 后成片校验失败会清理 task 终态并保持 held', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId);
    const result = await generateShot(ctx(state.db, {
      awaitCompletion: true,
      videoProcessor: async (db, _log, id) => {
        const taskId = db.prepare('SELECT task_id FROM video_generations WHERE id = ?').get(id).task_id;
        db.prepare('UPDATE video_generations SET status = ?, video_url = ?, local_path = ? WHERE id = ?')
          .run('completed', 'https://cdn.test/video.mp4', 'videos/shot.mp4', id);
        taskService.updateTaskResult(db, taskId, { status: 'completed', video_generation_id: id });
      },
      artifactVerifier: async () => {
        throw Object.assign(new Error('ffprobe failed'), { code: 'REDRAW_VIDEO_ARTIFACT_INVALID' });
      },
    }), { shotId });

    const task = state.db.prepare('SELECT status, result, completed_at FROM async_tasks WHERE id = ?').get(result.task_id);
    const video = state.db.prepare('SELECT status, error_msg, video_url, local_path FROM video_generations WHERE id = ?').get(result.video_generation_id);
    assert.equal(result.status, 'needs_attention');
    assert.equal(task.status, 'needs_attention');
    assert.equal(task.result, null);
    assert.equal(task.completed_at, null);
    assert.equal(video.status, 'needs_attention');
    assert.match(video.error_msg, /ffprobe failed/);
    assert.equal(video.video_url, 'https://cdn.test/video.mp4');
    assert.equal(video.local_path, 'videos/shot.mp4');
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations').get().status, 'held');
  } finally {
    state.db.close();
  }
});

test('processor 写入互相矛盾终态时原子降级 needs_attention 且不重跑第二次', async () => {
  const state = setup();
  let calls = 0;
  try {
    const shotId = addShot(state.db, state.versionId);
    const created = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId });
    state.db.prepare("UPDATE redraw_shots SET status = 'completed' WHERE id = ?").run(shotId);
    state.db.prepare("UPDATE async_tasks SET status = 'completed', result = '{}' WHERE id = ?").run(created.task_id);
    state.db.prepare("UPDATE video_generations SET status = 'failed', error_msg = 'provider failed' WHERE id = ?").run(created.video_generation_id);

    const result = await runShotGeneration(ctx(state.db, {
      videoProcessor: async () => { calls += 1; },
    }), created.task_id);

    assert.equal(result.status, 'needs_attention');
    assert.equal(calls, 0);
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(created.task_id).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM video_generations WHERE id = ?').get(created.video_generation_id).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id).status, 'held');
  } finally {
    state.db.close();
  }
});

test('resumeRedrawTasks 先将中断 redraw_shot 降级 needs_attention，避免视频恢复误失败和退款', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId);
    const created = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId });

    const resumed = await redrawOrchestrator.resumeRedrawTasks(state.db, log);
    videoService.resumeProcessingVideoGenerations(state.db, log);

    const task = state.db.prepare('SELECT status, result, completed_at, error FROM async_tasks WHERE id = ?').get(created.task_id);
    const shot = state.db.prepare('SELECT status, error_message FROM redraw_shots WHERE id = ?').get(shotId);
    const video = state.db.prepare('SELECT status, error_msg FROM video_generations WHERE id = ?').get(created.video_generation_id);
    const reservation = state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id);

    assert.equal(resumed.shot_needs_attention, 1);
    assert.equal(task.status, 'needs_attention');
    assert.equal(task.result, null);
    assert.equal(task.completed_at, null);
    assert.match(task.error, /请勿重新提交/);
    assert.equal(shot.status, 'needs_attention');
    assert.match(shot.error_message, /请勿重新提交/);
    assert.equal(video.status, 'needs_attention');
    assert.match(video.error_msg, /请勿重新提交/);
    assert.equal(reservation.status, 'held');
  } finally {
    state.db.close();
  }
});

test('verifyVideoArtifact 使用 realpath 阻止指向根外的 symlink 但允许根内 symlink', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-video-symlink-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-video-outside-'));
  try {
    const db = new Database(':memory:');
    runMigrationsAndEnsure(db);
    const realInside = path.join(tempRoot, 'real', 'inside.mp4');
    const realOutside = path.join(outsideRoot, 'outside.mp4');
    const linkInside = path.join(tempRoot, 'videos', 'inside-link.mp4');
    const linkOutside = path.join(tempRoot, 'videos', 'outside-link.mp4');
    fs.mkdirSync(path.dirname(realInside), { recursive: true });
    fs.mkdirSync(path.dirname(linkInside), { recursive: true });
    fs.writeFileSync(realInside, Buffer.from('video'));
    fs.writeFileSync(realOutside, Buffer.from('video'));
    try {
      fs.symlinkSync(realInside, linkInside);
      fs.symlinkSync(realOutside, linkOutside);
    } catch (error) {
      t.skip(`symlink unavailable: ${error.message}`);
      db.close();
      return;
    }
    const now = new Date().toISOString();
    const insideId = db.prepare(`INSERT INTO video_generations
      (status, local_path, created_at, updated_at) VALUES ('completed', 'videos/inside-link.mp4', ?, ?)`)
      .run(now, now).lastInsertRowid;
    const outsideId = db.prepare(`INSERT INTO video_generations
      (status, local_path, created_at, updated_at) VALUES ('completed', 'videos/outside-link.mp4', ?, ?)`)
      .run(now, now).lastInsertRowid;

    const verified = await verifyVideoArtifact({
      db,
      storageRoot: tempRoot,
      probeRunner: async () => ({ duration: 6, width: 720, height: 1280 }),
    }, insideId);
    assert.deepEqual(verified, { duration: 6, width: 720, height: 1280 });
    await assert.rejects(
      () => verifyVideoArtifact({
        db,
        storageRoot: tempRoot,
        probeRunner: async () => ({ duration: 6, width: 720, height: 1280 }),
      }, outsideId),
      (error) => error.code === 'REDRAW_VIDEO_ARTIFACT_INVALID',
    );
    db.close();
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('default ffprobe 调用设置超时、buffer、killSignal 和 Windows 隐藏窗口', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'redrawGenerationService.js'), 'utf8');
  assert.match(source, /timeout:\s*15000/);
  assert.match(source, /maxBuffer:\s*1024\s*\*\s*1024/);
  assert.match(source, /killSignal:\s*'SIGKILL'/);
  assert.match(source, /windowsHide:\s*true/);
});

test('verifyVideoArtifact 路径越界和缺文件 fail closed，probeRunner 成功时返回元数据', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-video-artifact-'));
  try {
    const db = new Database(':memory:');
    runMigrationsAndEnsure(db);
    const inside = path.join(tempRoot, 'videos', 'ok.mp4');
    fs.mkdirSync(path.dirname(inside), { recursive: true });
    fs.writeFileSync(inside, Buffer.from('video'));
    const now = new Date().toISOString();
    const insideId = db.prepare(`INSERT INTO video_generations
      (status, local_path, created_at, updated_at) VALUES ('completed', 'videos/ok.mp4', ?, ?)`)
      .run(now, now).lastInsertRowid;
    const missingId = db.prepare(`INSERT INTO video_generations
      (status, local_path, created_at, updated_at) VALUES ('completed', 'videos/missing.mp4', ?, ?)`)
      .run(now, now).lastInsertRowid;
    const outsideId = db.prepare(`INSERT INTO video_generations
      (status, local_path, created_at, updated_at) VALUES ('completed', '../outside.mp4', ?, ?)`)
      .run(now, now).lastInsertRowid;

    await assert.rejects(
      () => verifyVideoArtifact({ db, storageRoot: tempRoot }, outsideId),
      (error) => error.code === 'REDRAW_VIDEO_ARTIFACT_INVALID',
    );
    await assert.rejects(
      () => verifyVideoArtifact({ db, storageRoot: tempRoot }, missingId),
      (error) => error.code === 'REDRAW_VIDEO_ARTIFACT_INVALID',
    );
    const verified = await verifyVideoArtifact({
      db,
      storageRoot: tempRoot,
      probeRunner: async () => ({ duration: 6, width: 720, height: 1280 }),
    }, insideId);
    assert.deepEqual(verified, { duration: 6, width: 720, height: 1280 });
    db.close();
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('坏 JSON 在冻结前失败并保持事务无写入', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId, { compiledPrompt: '{bad json' });
    await assert.rejects(
      () => generateShot(ctx(state.db, { awaitCompletion: true }), { shotId }),
      (error) => error.code === 'REDRAW_INVALID_JSON',
    );
    assert.equal(count(state.db, 'tenant_usage_reservations'), 0);
    assert.equal(count(state.db, 'async_tasks'), 0);
    assert.equal(count(state.db, 'video_generations'), 0);
  } finally {
    state.db.close();
  }
});

test('classifyVideoOutcome 不把不完整 completed 当 completed', () => {
  assert.equal(classifyVideoOutcome({ status: 'completed', local_path: 'videos/a.mp4' }, { duration: 1, width: 1, height: 1 }).status, 'completed');
  assert.equal(classifyVideoOutcome({ status: 'completed', local_path: '' }, null).status, 'needs_attention');
  assert.equal(classifyVideoOutcome({ status: 'failed', error_msg: 'bad prompt' }, null).status, 'failed');
  assert.equal(classifyVideoOutcome({ status: 'processing', error_msg: '结果未知，请勿重新提交' }, null).status, 'needs_attention');
});

test('批量只提交同版本中通过门禁且未完成未处理的镜头，并逐镜独立计费', async () => {
  const state = setup();
  const submitted = [];
  let scheduled = null;
  try {
    const shot1 = addShot(state.db, state.versionId, { shotIndex: 1 });
    const shot2 = addShot(state.db, state.versionId, { shotIndex: 2, status: 'completed' });
    const shot3 = addShot(state.db, state.versionId, { shotIndex: 3 });
    const shot4 = addShot(state.db, state.versionId, { shotIndex: 4, status: 'processing' });
    const result = await generateBatch(ctx(state.db, {
      generationConcurrency: 2,
      batchScheduler: (callback) => { scheduled = callback; },
      videoProcessor: async (db, _log, videoId) => {
        const row = db.prepare(`SELECT t.resource_id FROM video_generations v JOIN async_tasks t ON t.id = v.task_id WHERE v.id = ?`).get(videoId);
        submitted.push(Number(row.resource_id));
        db.prepare("UPDATE video_generations SET status = 'processing', error_msg = '状态未知' WHERE id = ?").run(videoId);
      },
    }), { versionId: state.versionId, shotIds: [shot1, shot2, shot3, shot4] });

    assert.equal(result.results.every((item) => item.status === 'processing'), true);
    assert.equal(typeof scheduled, 'function');
    await scheduled();
    assert.deepEqual(submitted.sort((a, b) => a - b), [shot1, shot3]);
    assert.deepEqual(result.results.map((item) => item.shot_id), [shot1, shot3]);
    assert.equal(result.skipped.length, 2);
    assert.equal(result.results.every((item) => item.task_id && item.billing.held === 18), true);
    assert.equal(count(state.db, 'tenant_usage_reservations'), 2);
  } finally {
    state.db.close();
  }
});

test('批量生成使用 verified capability 模型贯穿报价、冻结、视频任务和分镜快照', async () => {
  const state = setup();
  const model = 'verified-redraw-video-v9';
  let scheduled = null;
  try {
    prices.set(state.db, model, 5, {
      category: 'video',
      billing_unit: 'second',
      resolution_prices: { '720p': { credits: 7 } },
    });
    addVerifiedGenerationCapability(state.db, model);
    const shotId = addShot(state.db, state.versionId, {
      draft: { model: 'client-stale-draft-model', duration: 6, resolution: '720p' },
      compiledPrompt: {
        text: 'compiled hero prompt',
        model: 'compiled-stale-model',
        duration: 6,
        resolution: '720p',
        aspect_ratio: '9:16',
      },
    });

    const batch = await generateBatch(ctx(state.db, {
      canReadArtifact: (artifactId) => artifactId === `artifact-${model}`,
      batchScheduler: (callback) => { scheduled = callback; },
    }), {
      versionId: state.versionId,
      shotIds: [shotId],
      model: 'client-forged-model',
    });

    assert.equal(typeof scheduled, 'function');
    assert.equal(batch.results[0].status, 'processing');
    const reservation = state.db.prepare('SELECT * FROM tenant_usage_reservations').get();
    const video = state.db.prepare('SELECT * FROM video_generations').get();
    const task = state.db.prepare("SELECT * FROM async_tasks WHERE type = 'redraw_shot'").get();
    const draft = JSON.parse(state.db.prepare('SELECT draft_json FROM redraw_shots WHERE id = ?').get(shotId).draft_json);
    const metadata = JSON.parse(task.metadata).redraw_shot;

    assert.equal(reservation.model, model);
    assert.equal(reservation.amount, 42);
    assert.equal(video.model, model);
    assert.equal(task.model, model);
    assert.equal(draft.generation.model, model);
    assert.equal(metadata.quote.snapshot.model, model);
    assert.equal(metadata.quote.amount, 42);
  } finally {
    state.db.close();
  }
});

test('批量生成在本地化物化镜头缺省 duration 时从 duration_ms 推导 12 秒并保持幂等键稳定', async () => {
  const state = setup();
  const model = 'verified-redraw-video-12s';
  let scheduled = null;
  try {
    prices.set(state.db, model, 5, {
      category: 'video',
      billing_unit: 'second',
      resolution_prices: { '720p': { credits: 7 } },
    });
    addVerifiedGenerationCapability(state.db, model);
    const shotId = addShot(state.db, state.versionId, {
      durationMs: 12000,
      endMs: 12000,
      draft: { revision: 1, resolution: '720p' },
      compiledPrompt: {
        text: 'localized materialized prompt',
        resolution: '720p',
        aspect_ratio: '9:16',
      },
    });

    const batch = await generateBatch(ctx(state.db, {
      canReadArtifact: (artifactId) => artifactId === `artifact-${model}`,
      batchScheduler: (callback) => { scheduled = callback; },
    }), {
      versionId: state.versionId,
      shotIds: [shotId],
      model: 'client-forged-model',
    });

    assert.equal(typeof scheduled, 'function');
    assert.equal(batch.results[0].status, 'processing');
    const reservation = state.db.prepare('SELECT * FROM tenant_usage_reservations').get();
    const video = state.db.prepare('SELECT * FROM video_generations').get();
    const task = state.db.prepare("SELECT * FROM async_tasks WHERE type = 'redraw_shot'").get();
    const draft = JSON.parse(state.db.prepare('SELECT draft_json FROM redraw_shots WHERE id = ?').get(shotId).draft_json);
    const metadata = JSON.parse(task.metadata).redraw_shot;

    assert.equal(reservation.model, model);
    assert.equal(reservation.amount, 84);
    assert.match(reservation.operation_key, /redraw-shot:/);
    assert.equal(video.model, model);
    assert.equal(video.duration, 12);
    assert.equal(task.model, model);
    assert.equal(draft.generation.model, model);
    assert.equal(draft.generation.duration, 12);
    assert.equal(metadata.quote.snapshot.model, model);
    assert.equal(metadata.quote.snapshot.duration, 12);
    assert.equal(metadata.quote.snapshot.attempt, 1);
    assert.equal(metadata.quote.amount, 84);
    assert.equal(metadata.operation_key, reservation.operation_key);

    const duplicate = await generateShot(ctx(state.db, {
      canReadArtifact: (artifactId) => artifactId === `artifact-${model}`,
      schedule() {},
    }), { shotId });
    assert.equal(duplicate.reused, true);
    assert.equal(duplicate.reservation_id, reservation.id);
    assert.equal(count(state.db, 'tenant_usage_reservations'), 1);
    assert.equal(count(state.db, 'async_tasks', "type = 'redraw_shot'"), 1);
    assert.equal(count(state.db, 'video_generations'), 1);
  } finally {
    state.db.close();
  }
});

test('批量显式镜头包含跨租户、跨版本或缺失时 fail closed 且零冻结', async () => {
  for (const invalidKind of ['other_version', 'other_owner', 'missing']) {
    const state = setup();
    try {
      const validShot = addShot(state.db, state.versionId, { shotIndex: 1 });
      let invalidShot = 999999;
      if (invalidKind !== 'missing') {
        const now = new Date().toISOString();
        state.db.prepare(`INSERT INTO redraw_versions
          (work_id, tenant_id, user_id, version, locale, market, style_snapshot_json, status, created_at, updated_at)
          SELECT work_id, tenant_id, user_id, 2, locale, market, style_snapshot_json, status, ?, ? FROM redraw_versions WHERE id = ?`)
          .run(now, now, state.versionId);
        const otherVersionId = state.db.prepare('SELECT MAX(id) AS id FROM redraw_versions').get().id;
        invalidShot = addShot(state.db, otherVersionId, { shotIndex: 2 });
        if (invalidKind === 'other_owner') {
          state.db.prepare("UPDATE redraw_shots SET tenant_id = 'tenant-b', user_id = 'user-b', version_id = ? WHERE id = ?")
            .run(state.versionId, invalidShot);
        }
      }
      await assert.rejects(
        () => generateBatch(ctx(state.db), { versionId: state.versionId, shotIds: [validShot, invalidShot] }),
        (error) => error.code === 'REDRAW_BATCH_SHOT_INVALID',
      );
      assert.equal(count(state.db, 'tenant_usage_reservations'), 0);
      assert.equal(count(state.db, 'async_tasks'), 0);
    } finally {
      state.db.close();
    }
  }
});

test('批量同时携带 singular shot_id 或 shotId 时在任何冻结和任务创建前 fail closed', async () => {
  for (const singularKey of ['shot_id', 'shotId']) {
    const state = setup();
    try {
      const shotA = addShot(state.db, state.versionId, { shotIndex: 1 });
      const now = new Date().toISOString();
      state.db.prepare(`INSERT INTO redraw_versions
        (work_id, tenant_id, user_id, version, locale, market, style_snapshot_json, status, created_at, updated_at)
        SELECT work_id, tenant_id, user_id, 2, locale, market, style_snapshot_json, status, ?, ?
        FROM redraw_versions WHERE id = ?`).run(now, now, state.versionId);
      const versionB = state.db.prepare('SELECT MAX(id) AS id FROM redraw_versions').get().id;
      const shotB = addShot(state.db, versionB, { shotIndex: 2 });
      const before = state.db.prepare('SELECT id, status FROM redraw_shots ORDER BY id').all();

      await assert.rejects(
        () => generateBatch(ctx(state.db), {
          versionId: state.versionId,
          shotIds: [shotA],
          [singularKey]: shotB,
        }),
        (error) => error.code === 'REDRAW_BATCH_INPUT_INVALID',
      );
      assert.equal(count(state.db, 'tenant_usage_reservations'), 0);
      assert.equal(count(state.db, 'async_tasks'), 0);
      assert.deepEqual(state.db.prepare('SELECT id, status FROM redraw_shots ORDER BY id').all(), before);
    } finally {
      state.db.close();
    }
  }
});

test('批量生成遵守 generationConcurrency 有界并发', async () => {
  const state = setup();
  let active = 0;
  let maxActive = 0;
  let scheduled = null;
  try {
    const shotIds = Array.from({ length: 5 }, (_, index) => addShot(state.db, state.versionId, { shotIndex: index + 1 }));
    await generateBatch(ctx(state.db, {
      generationConcurrency: 2,
      batchScheduler: (callback) => { scheduled = callback; },
      videoProcessor: async (db, _log, videoId) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        db.prepare("UPDATE video_generations SET status = 'failed', error_msg = 'provider failed' WHERE id = ?").run(videoId);
        active -= 1;
      },
    }), { versionId: state.versionId, shotIds });
    await scheduled();
    assert.equal(maxActive, 2);
  } finally {
    state.db.close();
  }
});

test('批量单镜处理器异常不影响其他镜头且如实返回 held 账单', async () => {
  const state = setup();
  let scheduled = null;
  try {
    const shotIds = [
      addShot(state.db, state.versionId, { shotIndex: 1 }),
      addShot(state.db, state.versionId, { shotIndex: 2 }),
    ];
    let calls = 0;
    const result = await generateBatch(ctx(state.db, {
      generationConcurrency: 1,
      batchScheduler: (callback) => { scheduled = callback; },
      videoProcessor: async (db, _log, videoId) => {
        calls += 1;
        if (calls === 1) throw new Error('processor exploded');
        db.prepare("UPDATE video_generations SET status = 'failed', error_msg = 'provider failed' WHERE id = ?").run(videoId);
      },
    }), { versionId: state.versionId, shotIds });
    assert.equal(result.results[0].status, 'processing');
    assert.equal(result.results[0].billing.held, 18);
    assert.equal(result.results[1].status, 'processing');
    assert.equal(result.results[1].billing.held, 18);
    await scheduled();
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotIds[0]).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotIds[1]).status, 'failed');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(result.results[0].reservation_id).status, 'held');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(result.results[1].reservation_id).status, 'refunded');
  } finally {
    state.db.close();
  }
});

test('批量创建不等待供应商终态即可返回 processing，并将后台执行交给批次调度器', async () => {
  const state = setup();
  let scheduled = null;
  let providerCalls = 0;
  try {
    const shotIds = [
      addShot(state.db, state.versionId, { shotIndex: 1 }),
      addShot(state.db, state.versionId, { shotIndex: 2 }),
    ];
    const batch = generateBatch(ctx(state.db, {
      videoProcessor: async () => {
        providerCalls += 1;
        await new Promise(() => {});
      },
      batchScheduler: (callback) => { scheduled = callback; },
    }), { versionId: state.versionId, shotIds });
    const result = await Promise.race([
      batch,
      new Promise((_, reject) => setTimeout(() => reject(new Error('batch waited for provider')), 250)),
    ]);
    assert.equal(providerCalls, 0);
    assert.equal(typeof scheduled, 'function');
    assert.equal(result.results.length, 2);
    assert.equal(result.results.every((item) => item.status === 'processing' && item.task_id && item.billing.held === 18), true);
    assert.equal(count(state.db, 'async_tasks', "status = 'processing'"), 2);
    assert.equal(count(state.db, 'tenant_usage_reservations', "status = 'held'"), 2);
  } finally {
    state.db.close();
  }
});

test('批量后台 drain 按 generationConcurrency 限流并与返回生命周期解耦', async () => {
  const state = setup();
  let scheduled = null;
  let active = 0;
  let maxActive = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  try {
    const shotIds = Array.from({ length: 4 }, (_, index) => addShot(state.db, state.versionId, { shotIndex: index + 1 }));
    const result = await generateBatch(ctx(state.db, {
      generationConcurrency: 2,
      batchScheduler: (callback) => { scheduled = callback; },
      videoProcessor: async (db, _log, videoId) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate;
        db.prepare("UPDATE video_generations SET status = 'failed', error_msg = 'provider failed' WHERE id = ?").run(videoId);
        active -= 1;
      },
    }), { versionId: state.versionId, shotIds });
    assert.equal(result.results.every((item) => item.status === 'processing'), true);
    const drain = scheduled();
    for (let index = 0; index < 20 && active < 2; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(active, 2);
    assert.equal(maxActive, 2);
    release();
    await drain;
    assert.equal(maxActive, 2);
  } finally {
    state.db.close();
  }
});

test('两个批次同时 drain 共享全局 redraw_video 并发上限', async () => {
  const state = setup();
  const previousLimit = process.env.GENERATION_REDRAW_VIDEO_CONCURRENCY;
  let drainA = null;
  let drainB = null;
  let active = 0;
  let maxActive = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  process.env.GENERATION_REDRAW_VIDEO_CONCURRENCY = '2';
  resetGenerationConcurrencyForTests();
  try {
    const shots = Array.from({ length: 4 }, (_, index) => addShot(state.db, state.versionId, { shotIndex: index + 1 }));
    const common = {
      generationConcurrency: 8,
      videoProcessor: async (db, _log, videoId) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate;
        db.prepare("UPDATE video_generations SET status = 'failed', error_msg = 'provider failed' WHERE id = ?").run(videoId);
        active -= 1;
      },
    };
    await generateBatch(ctx(state.db, { ...common, batchScheduler: (callback) => { drainA = callback; } }), {
      versionId: state.versionId,
      shotIds: shots.slice(0, 2),
    });
    await generateBatch(ctx(state.db, { ...common, batchScheduler: (callback) => { drainB = callback; } }), {
      versionId: state.versionId,
      shotIds: shots.slice(2),
    });
    const runningA = drainA();
    const runningB = drainB();
    for (let index = 0; index < 20 && active < 2; index += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(active, 2);
    assert.equal(maxActive, 2);
    release();
    await Promise.all([runningA, runningB]);
    assert.equal(maxActive, 2);
  } finally {
    release?.();
    resetGenerationConcurrencyForTests();
    if (previousLimit == null) delete process.env.GENERATION_REDRAW_VIDEO_CONCURRENCY;
    else process.env.GENERATION_REDRAW_VIDEO_CONCURRENCY = previousLimit;
    state.db.close();
  }
});

test('全局 redraw_video 队列满时未执行任务转 needs_attention 且保持 held', async () => {
  const state = setup();
  const previousLimit = process.env.GENERATION_REDRAW_VIDEO_CONCURRENCY;
  const previousQueue = process.env.GENERATION_REDRAW_VIDEO_MAX_QUEUE_SIZE;
  let scheduled = null;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  process.env.GENERATION_REDRAW_VIDEO_CONCURRENCY = '1';
  process.env.GENERATION_REDRAW_VIDEO_MAX_QUEUE_SIZE = '1';
  resetGenerationConcurrencyForTests();
  try {
    const shots = Array.from({ length: 3 }, (_, index) => addShot(state.db, state.versionId, { shotIndex: index + 1 }));
    const batch = await generateBatch(ctx(state.db, {
      batchScheduler: (callback) => { scheduled = callback; },
      videoProcessor: async (db, _log, videoId) => {
        await gate;
        db.prepare("UPDATE video_generations SET status = 'failed', error_msg = 'provider failed' WHERE id = ?").run(videoId);
      },
    }), { versionId: state.versionId, shotIds: shots });
    const draining = scheduled();
    for (let index = 0; index < 20; index += 1) {
      if (state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shots[2]).status === 'needs_attention') break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shots[2]).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(batch.results[2].reservation_id).status, 'held');
    release();
    await draining;
  } finally {
    release?.();
    resetGenerationConcurrencyForTests();
    if (previousLimit == null) delete process.env.GENERATION_REDRAW_VIDEO_CONCURRENCY;
    else process.env.GENERATION_REDRAW_VIDEO_CONCURRENCY = previousLimit;
    if (previousQueue == null) delete process.env.GENERATION_REDRAW_VIDEO_MAX_QUEUE_SIZE;
    else process.env.GENERATION_REDRAW_VIDEO_MAX_QUEUE_SIZE = previousQueue;
    state.db.close();
  }
});

test('批量中的明确 failed 镜头通过 retry 创建 attempt=2 新链且旧账保持原终态', async () => {
  const state = setup();
  let scheduled = null;
  try {
    const shotId = addShot(state.db, state.versionId);
    const first = await generateShot(ctx(state.db, {
      awaitCompletion: true,
      videoProcessor: async (db, _log, videoId) => {
        db.prepare("UPDATE video_generations SET status = 'failed', error_msg = 'first failed' WHERE id = ?").run(videoId);
      },
    }), { shotId });
    const oldTask = state.db.prepare('SELECT status, error, result FROM async_tasks WHERE id = ?').get(first.task_id);
    const oldVideo = state.db.prepare('SELECT status, provider_task_id FROM video_generations WHERE id = ?').get(first.video_generation_id);
    const oldReservation = state.db.prepare('SELECT status, operation_key FROM tenant_usage_reservations WHERE id = ?').get(first.reservation_id);

    const batch = await generateBatch(ctx(state.db, {
      batchScheduler: (callback) => { scheduled = callback; },
    }), { versionId: state.versionId, shotIds: [shotId] });
    const retried = batch.results[0];
    assert.equal(typeof scheduled, 'function');
    assert.equal(retried.status, 'processing');
    assert.equal(retried.attempt, 2);
    assert.notEqual(retried.task_id, first.task_id);
    assert.notEqual(retried.video_generation_id, first.video_generation_id);
    assert.notEqual(retried.reservation_id, first.reservation_id);
    assert.notEqual(
      state.db.prepare('SELECT operation_key FROM tenant_usage_reservations WHERE id = ?').get(retried.reservation_id).operation_key,
      oldReservation.operation_key,
    );
    assert.deepEqual(state.db.prepare('SELECT status, error, result FROM async_tasks WHERE id = ?').get(first.task_id), oldTask);
    assert.deepEqual(state.db.prepare('SELECT status, provider_task_id FROM video_generations WHERE id = ?').get(first.video_generation_id), oldVideo);
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(first.reservation_id).status, oldReservation.status);
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(retried.reservation_id).status, 'held');
  } finally {
    state.db.close();
  }
});

test('批量创建失败返回状态与数据库真实旧链一致，不伪报 needs_attention', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId);
    const first = await generateShot(ctx(state.db, {
      awaitCompletion: true,
      videoProcessor: async (db, _log, videoId) => {
        db.prepare("UPDATE video_generations SET status = 'failed', error_msg = 'first failed' WHERE id = ?").run(videoId);
      },
    }), { shotId });
    state.db.prepare("DELETE FROM model_credit_prices WHERE model = 'seedance 2.0'").run();
    const batch = await generateBatch(ctx(state.db, { batchScheduler: () => {} }), {
      versionId: state.versionId,
      shotIds: [shotId],
    });
    const item = batch.results[0];
    assert.equal(item.status, 'failed');
    assert.equal(item.billing.released, 18);
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, item.status);
    assert.equal(state.db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(first.task_id).status, item.status);
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(first.reservation_id).status, 'refunded');
  } finally {
    state.db.close();
  }
});

test('重试只对明确 failed 镜头创建 attempt=2 新任务新冻结且旧账不二次结算', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId);
    const first = await generateShot(ctx(state.db, {
      awaitCompletion: true,
      videoProcessor: async (db, _log, id) => {
        db.prepare("UPDATE video_generations SET status = 'failed', error_msg = 'first failed' WHERE id = ?").run(id);
      },
    }), { shotId });
    const oldTask = state.db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(first.task_id);
    const oldVideo = state.db.prepare('SELECT * FROM video_generations WHERE id = ?').get(first.video_generation_id);
    const oldReservation = state.db.prepare('SELECT * FROM tenant_usage_reservations WHERE id = ?').get(first.reservation_id);

    const retried = await retryShot(ctx(state.db, {
      schedule: () => {},
      videoProcessor: async (db, _log, id) => {
        db.prepare("UPDATE video_generations SET status = 'failed', error_msg = 'second failed' WHERE id = ?").run(id);
      },
    }), { shotId });

    assert.equal(retried.attempt, 2);
    assert.notEqual(retried.task_id, first.task_id);
    assert.notEqual(retried.video_generation_id, first.video_generation_id);
    assert.notEqual(retried.reservation_id, first.reservation_id);
    assert.notEqual(
      state.db.prepare('SELECT operation_key FROM tenant_usage_reservations WHERE id = ?').get(retried.reservation_id).operation_key,
      oldReservation.operation_key,
    );
    assert.deepEqual(state.db.prepare('SELECT status, result, error FROM async_tasks WHERE id = ?').get(first.task_id), {
      status: oldTask.status, result: oldTask.result, error: oldTask.error,
    });
    assert.equal(state.db.prepare('SELECT status, provider_task_id FROM video_generations WHERE id = ?').get(first.video_generation_id).status, oldVideo.status);
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(first.reservation_id).status, oldReservation.status);
    assert.equal(count(state.db, 'tenant_credit_ledger', "reservation_id = '" + first.reservation_id + "' AND event_type = 'refund'"), 1);
  } finally {
    state.db.close();
  }
});

test('重试使用 failed 分镜当前持久 attempt 加一并写入 reservation task draft 快照', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId, {
      durationMs: 12000,
      endMs: 12000,
      draft: { revision: 1, resolution: '720p' },
      compiledPrompt: {
        text: 'retry localized prompt',
        resolution: '720p',
        aspect_ratio: '9:16',
      },
    });
    const first = await generateShot(ctx(state.db, {
      awaitCompletion: true,
      videoProcessor: async (db, _log, id) => {
        db.prepare("UPDATE video_generations SET status = 'failed', error_msg = 'first failed' WHERE id = ?").run(id);
      },
    }), { shotId });
    const failedDraft = JSON.parse(state.db.prepare('SELECT draft_json FROM redraw_shots WHERE id = ?').get(shotId).draft_json);
    failedDraft.generation.attempt = 4;
    state.db.prepare('UPDATE redraw_shots SET draft_json = ? WHERE id = ?')
      .run(JSON.stringify(failedDraft), shotId);
    const oldReservation = state.db.prepare('SELECT operation_key FROM tenant_usage_reservations WHERE id = ?').get(first.reservation_id);

    const retried = await retryShot(ctx(state.db, {
      schedule: () => {},
    }), { shotId });

    const reservation = state.db.prepare('SELECT * FROM tenant_usage_reservations WHERE id = ?').get(retried.reservation_id);
    const task = state.db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(retried.task_id);
    const video = state.db.prepare('SELECT * FROM video_generations WHERE id = ?').get(retried.video_generation_id);
    const draft = JSON.parse(state.db.prepare('SELECT draft_json FROM redraw_shots WHERE id = ?').get(shotId).draft_json);
    const metadata = JSON.parse(task.metadata).redraw_shot;

    assert.equal(retried.attempt, 5);
    assert.equal(reservation.amount, 36);
    assert.notEqual(reservation.operation_key, oldReservation.operation_key);
    assert.equal(video.duration, 12);
    assert.equal(draft.generation.attempt, 5);
    assert.equal(draft.generation.duration, 12);
    assert.equal(metadata.attempt, 5);
    assert.equal(metadata.quote.snapshot.attempt, 5);
    assert.equal(metadata.quote.snapshot.duration, 12);
    assert.equal(metadata.operation_key, reservation.operation_key);
  } finally {
    state.db.close();
  }
});

test('旧重试终态不明确时降级 needs_attention 并保持 held，绝不重提', async () => {
  const state = setup();
  let submissions = 0;
  try {
    const shotId = addShot(state.db, state.versionId);
    const created = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId });
    state.db.prepare("UPDATE redraw_shots SET status = 'failed' WHERE id = ?").run(shotId);
    await assert.rejects(
      () => retryShot(ctx(state.db, { videoProcessor: async () => { submissions += 1; } }), { shotId }),
      (error) => error.code === 'REDRAW_RETRY_UNCERTAIN',
    );
    assert.equal(submissions, 0);
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id).status, 'held');
  } finally {
    state.db.close();
  }
});

test('有 provider_task_id 的恢复只回读零提交，并复用成片校验入库与账单确认', async () => {
  const state = setup();
  let recoverCalls = 0;
  let submitCalls = 0;
  try {
    const shotId = addShot(state.db, state.versionId);
    const created = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId });
    state.db.prepare("UPDATE video_generations SET provider_task_id = 'provider-1' WHERE id = ?").run(created.video_generation_id);
    const results = await recoverInterruptedShotGenerations(ctx(state.db, {
      videoProcessor: async () => { submitCalls += 1; },
      videoRecoveryProcessor: async (db, _log, videoId) => {
        recoverCalls += 1;
        db.prepare("UPDATE video_generations SET status = 'completed', video_url = 'https://cdn.test/recovered.mp4', local_path = 'videos/recovered.mp4' WHERE id = ?")
          .run(videoId);
      },
      artifactVerifier: async () => ({ duration: 6, width: 720, height: 1280 }),
      assetImporter: () => ({ id: 202 }),
    }));
    assert.equal(recoverCalls, 1);
    assert.equal(submitCalls, 0);
    assert.equal(results[0].status, 'completed');
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'completed');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id).status, 'confirmed');
  } finally {
    state.db.close();
  }
});

test('恢复未知供应商状态转 needs_attention 且 held；无 provider ID 的启动任务不重提', async () => {
  const state = setup();
  let recoverCalls = 0;
  let scheduled = 0;
  try {
    const withProviderShot = addShot(state.db, state.versionId, { shotIndex: 1 });
    const withProvider = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId: withProviderShot });
    state.db.prepare("UPDATE video_generations SET provider_task_id = 'provider-unknown' WHERE id = ?").run(withProvider.video_generation_id);
    const results = await recoverInterruptedShotGenerations(ctx(state.db, {
      videoRecoveryProcessor: async () => { recoverCalls += 1; },
    }));
    assert.equal(results[0].status, 'needs_attention');
    assert.equal(recoverCalls, 1);
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(withProvider.reservation_id).status, 'held');

    const noProviderShot = addShot(state.db, state.versionId, { shotIndex: 2 });
    const noProvider = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId: noProviderShot });
    const marked = markInterruptedShotGenerationsNeedsAttention(state.db, log, {
      schedule: () => { scheduled += 1; },
    });
    assert.equal(marked, 1);
    assert.equal(scheduled, 0);
    assert.equal(state.db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(noProvider.task_id).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(noProvider.reservation_id).status, 'held');
  } finally {
    state.db.close();
  }
});

test('启动孤儿清理排除带 provider_task_id 的 redraw_shot，交由转绘恢复收口', async () => {
  const state = setup();
  try {
    const shotId = addShot(state.db, state.versionId);
    const created = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId });
    state.db.prepare("UPDATE video_generations SET provider_task_id = 'provider-recoverable' WHERE id = ?").run(created.video_generation_id);
    const failed = taskService.failOrphanedAsyncTasksOnStartup(state.db, log);
    assert.equal(failed, 0);
    assert.equal(state.db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(created.task_id).status, 'processing');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id).status, 'held');
  } finally {
    state.db.close();
  }
});

test('启动孤儿清理遇到跨租户 resource_id 混淆时不更新其他租户镜头', async () => {
  const state = setup();
  try {
    const protectedShotId = addShot(state.db, state.versionId, { status: 'draft' });
    const dirtyTask = taskService.createTask(state.db, log, 'redraw_shot', String(protectedShotId));
    state.db.prepare(`UPDATE async_tasks
      SET status = 'processing', tenant_id = 'tenant-b', user_id = 'user-b'
      WHERE id = ?`).run(dirtyTask.id);
    const now = new Date().toISOString();
    const dirtyVideoId = state.db.prepare(`INSERT INTO video_generations
      (status, task_id, tenant_id, user_id, created_at, updated_at)
      VALUES ('processing', ?, 'tenant-b', 'user-b', ?, ?)`)
      .run(dirtyTask.id, now, now).lastInsertRowid;

    taskService.failOrphanedAsyncTasksOnStartup(state.db, log);

    assert.equal(state.db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(dirtyTask.id).status, 'needs_attention');
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(protectedShotId).status, 'draft');
    assert.equal(state.db.prepare('SELECT status FROM video_generations WHERE id = ?').get(dirtyVideoId).status, 'processing');
  } finally {
    state.db.close();
  }
});

test('启动 mark 对带 provider_task_id 的镜头安排只回读恢复并完成本地收口', async () => {
  const state = setup();
  let scheduled = null;
  let recoveryCalls = 0;
  try {
    const shotId = addShot(state.db, state.versionId);
    const created = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId });
    state.db.prepare("UPDATE video_generations SET provider_task_id = 'provider-startup' WHERE id = ?").run(created.video_generation_id);
    const marked = markInterruptedShotGenerationsNeedsAttention(state.db, log, {
      schedule: (callback) => { scheduled = callback; },
      recoveryContext: {
        videoRecoveryProcessor: async (db, _log, videoId) => {
          recoveryCalls += 1;
          db.prepare("UPDATE video_generations SET status = 'completed', video_url = 'https://cdn.test/startup.mp4', local_path = 'videos/startup.mp4' WHERE id = ?")
            .run(videoId);
        },
        artifactVerifier: async () => ({ duration: 6, width: 720, height: 1280 }),
        assetImporter: () => ({ id: 303 }),
      },
    });
    assert.equal(marked, 0);
    assert.equal(typeof scheduled, 'function');
    await scheduled();
    assert.equal(recoveryCalls, 1);
    assert.equal(state.db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(created.task_id).status, 'completed');
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'completed');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id).status, 'confirmed');
  } finally {
    state.db.close();
  }
});

test('供应商回读已先落 completed 终态时启动 mark 仍安排 shot 与账单收口', async () => {
  const state = setup();
  let recoveryCalls = 0;
  let scheduled = null;
  try {
    const shotId = addShot(state.db, state.versionId);
    const created = await generateShot(ctx(state.db, { schedule: () => {} }), { shotId });
    state.db.prepare(`UPDATE video_generations
      SET status = 'completed', provider_task_id = 'provider-race', video_url = 'https://cdn.test/race.mp4', local_path = 'videos/race.mp4'
      WHERE id = ?`).run(created.video_generation_id);
    taskService.updateTaskResult(state.db, created.task_id, { status: 'completed', video_generation_id: created.video_generation_id });
    const marked = markInterruptedShotGenerationsNeedsAttention(state.db, log, {
      schedule: (callback) => { scheduled = callback; },
      recoveryContext: ctx(state.db, {
        videoRecoveryProcessor: async () => { recoveryCalls += 1; },
        artifactVerifier: async () => ({ duration: 6, width: 720, height: 1280 }),
        assetImporter: () => ({ id: 404 }),
      }),
    });
    assert.equal(marked, 0);
    assert.equal(typeof scheduled, 'function');
    const results = await scheduled();
    assert.equal(recoveryCalls, 0);
    assert.equal(results[0].status, 'completed');
    assert.equal(state.db.prepare('SELECT status FROM redraw_shots WHERE id = ?').get(shotId).status, 'completed');
    assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(created.reservation_id).status, 'confirmed');
  } finally {
    state.db.close();
  }
});
