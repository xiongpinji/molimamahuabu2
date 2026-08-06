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
const {
  generateShot,
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
    VALUES (?, 'tenant-a', 'user-a', 1, ?, 0, 6000, 6000, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      versionId,
      overrides.shotIndex || 1,
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
    ...overrides,
  };
}

function count(db, table, where = '1=1') {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get().count;
}

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
      assetImporter: async () => ({ id: 77 }),
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
        assetImporter: async () => (mode === 'import_failed' ? null : { id: 91 }),
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
