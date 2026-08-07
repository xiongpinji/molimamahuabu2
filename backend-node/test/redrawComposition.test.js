const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const {
  buildCompositionPlan,
  createComposition,
  runComposition,
  recoverInterruptedCompositions,
} = require('../src/services/redrawCompositionService');

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-composition-'));
  const now = '2026-08-07T00:00:00.000Z';
  db.prepare(`INSERT INTO redraw_projects (tenant_id, user_id, title, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', '合成项目', ?, ?)`).run(now, now);
  const projectId = db.prepare('SELECT id FROM redraw_projects').get().id;
  db.prepare(`INSERT INTO redraw_works
    (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', '合成作品', 1, 'source-hash', 15000, ?, ?)`).run(projectId, now, now);
  const workId = db.prepare('SELECT id FROM redraw_works').get().id;
  db.prepare(`INSERT INTO redraw_versions
    (work_id, tenant_id, user_id, version, locale, market, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 1, 'en-US', 'US', 'ready_to_generate', ?, ?)`).run(workId, now, now);
  const versionId = db.prepare('SELECT id FROM redraw_versions').get().id;
  return { db, root, now, versionId };
}

function cleanup(state) {
  state.db.close();
  fs.rmSync(state.root, { recursive: true, force: true });
}

function touch(root, relative, body = 'media') {
  const abs = path.join(root, relative);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return relative.replace(/\\/g, '/');
}

function addVideo(state, id, relative, overrides = {}) {
  state.db.prepare(`INSERT INTO video_generations
    (id, tenant_id, user_id, local_path, status, duration, aspect_ratio, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '16:9', ?, ?)`)
    .run(
      id,
      overrides.tenantId || 'tenant-a',
      overrides.userId || 'user-a',
      relative,
      overrides.status || 'completed',
      (overrides.durationMs || 1000) / 1000,
      state.now,
      state.now,
    );
}

function addShot(state, input) {
  const start = input.startMs;
  const end = input.endMs;
  return state.db.prepare(`INSERT INTO redraw_shots
    (version_id, tenant_id, user_id, batch_index, shot_index, start_ms, end_ms, duration_ms,
     localized_dialogue_json, draft_json, video_generation_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      input.versionId || state.versionId,
      input.tenantId || 'tenant-a',
      input.userId || 'user-a',
      input.batchIndex || 1,
      input.shotIndex || 1,
      start,
      end,
      end - start,
      JSON.stringify(input.dialogue || [{ segment_id: `s${input.shotIndex || 1}`, start_ms: start, end_ms: end, text: `Line ${input.shotIndex || 1}` }]),
      JSON.stringify(input.draft || {}),
      input.videoGenerationId,
      input.status || 'completed',
      state.now,
      state.now,
    ).lastInsertRowid;
}

function addDialogueAsset(state, id, relative, metadata) {
  state.db.prepare(`INSERT INTO assets
    (id, name, type, category, local_path, mime_type, duration, metadata, created_at, updated_at)
    VALUES (?, '配音', 'audio', 'redraw_dialogue', ?, 'audio/mpeg', ?, ?, ?, ?)`)
    .run(id, relative, metadata.duration_ms / 1000, JSON.stringify(metadata), state.now, state.now);
}

function addReadyVersion(state) {
  const v1 = touch(state.root, 'videos/shot-1.mp4');
  const v2 = touch(state.root, 'videos/shot-2.mp4');
  addVideo(state, 101, v1, { durationMs: 1000 });
  addVideo(state, 102, v2, { durationMs: 2000 });
  const a1 = touch(state.root, 'audio/a1.mp3');
  const a2 = touch(state.root, 'audio/a2.mp3');
  addDialogueAsset(state, 201, a1, {
    tenant_id: 'tenant-a',
    user_id: 'user-a',
    version_id: state.versionId,
    segment_id: 'a',
    reservation_status: 'confirmed',
    reservation_id: 'res-a',
    idempotency_key: 'dialogue-key-a',
    duration_ms: 900,
  });
  addDialogueAsset(state, 202, a2, {
    tenant_id: 'tenant-a',
    user_id: 'user-a',
    version_id: state.versionId,
    segment_id: 'b',
    reservation_status: 'confirmed',
    reservation_id: 'res-b',
    idempotency_key: 'dialogue-key-b',
    duration_ms: 700,
  });
  addShot(state, {
    shotIndex: 1,
    startMs: 0,
    endMs: 1000,
    videoGenerationId: 101,
    dialogue: [{ segment_id: 'a', start_ms: 0, end_ms: 1000, text: 'Hello' }],
    draft: { dialogue_generation: { segments: [{
      segment_id: 'a',
      start_ms: 0,
      end_ms: 1000,
      status: 'completed',
      reservation_status: 'confirmed',
      reservation_id: 'res-a',
      audio_asset_id: 201,
      idempotency_key: 'dialogue-key-a',
    }] } },
  });
  addShot(state, {
    shotIndex: 2,
    startMs: 1000,
    endMs: 3000,
    videoGenerationId: 102,
    dialogue: [{ segment_id: 'b', start_ms: 1400, end_ms: 2300, text: 'World' }],
    draft: { dialogue_generation: { segments: [{
      segment_id: 'b',
      start_ms: 1400,
      end_ms: 2300,
      status: 'completed',
      reservation_status: 'confirmed',
      reservation_id: 'res-b',
      audio_asset_id: 202,
      idempotency_key: 'dialogue-key-b',
    }] } },
  });
}

function ctx(state, overrides = {}) {
  return {
    db: state.db,
    tenantId: 'tenant-a',
    userId: 'user-a',
    storageRoot: state.root,
    clock: () => state.now,
    artifactVerifier: async (_ctx, videoId) => {
      const row = state.db.prepare('SELECT duration FROM video_generations WHERE id = ?').get(videoId);
      return {
        duration: row.duration,
        width: overrides.width || 1280,
        height: overrides.height || 720,
        hasVideo: true,
      };
    },
    probeRunner: async () => ({
      duration: 3,
      width: 1280,
      height: 720,
      hasVideo: true,
      hasAudio: true,
      hash: 'final-hash',
    }),
    compositionRunner: async ({ outputPath }) => {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, 'mp4');
    },
    ...overrides,
  };
}

test('buildCompositionPlan enforces owner, completed ordered continuous shots, and ignores deleted shots', async () => {
  const state = setup();
  try {
    addReadyVersion(state);
    addShot(state, {
      tenantId: 'tenant-other',
      userId: 'user-a',
      shotIndex: 3,
      startMs: 3000,
      endMs: 4000,
      videoGenerationId: 101,
      status: 'completed',
    });
    state.db.prepare('UPDATE redraw_shots SET deleted_at = ? WHERE shot_index = 3').run(state.now);

    const plan = await buildCompositionPlan(ctx(state), { versionId: state.versionId, audioMode: 'replace' });

    assert.deepEqual(plan.timeline.map((item) => [item.shot_id, item.start_ms, item.end_ms, item.duration_ms]), [
      [1, 0, 1000, 1000],
      [2, 1000, 3000, 2000],
    ]);
    assert.equal(plan.total_duration_ms, 3000);
    assert.equal(plan.video_inputs.length, 2);
  } finally {
    cleanup(state);
  }
});

test('buildCompositionPlan rejects owner mismatch, gaps, unfinished videos, bad duration, and dimension drift', async () => {
  for (const mutate of ['owner', 'gap', 'unfinished', 'duration', 'dimension']) {
    const state = setup();
    try {
      addReadyVersion(state);
      if (mutate === 'owner') state.db.prepare('UPDATE video_generations SET tenant_id = ? WHERE id = 101').run('tenant-other');
      if (mutate === 'gap') state.db.prepare('UPDATE redraw_shots SET start_ms = 1200, end_ms = 3200, duration_ms = 2000 WHERE shot_index = 2').run();
      if (mutate === 'unfinished') state.db.prepare('UPDATE video_generations SET status = ? WHERE id = 101').run('processing');
      if (mutate === 'duration') state.db.prepare('UPDATE video_generations SET duration = ? WHERE id = 101').run(1.5);
      const options = mutate === 'dimension' ? { artifactVerifier: async (_ctx, videoId) => (
        videoId === 101
          ? { duration: 1, width: 1280, height: 720, hasVideo: true }
          : { duration: 2, width: 720, height: 1280, hasVideo: true }
      ) } : {};

      await assert.rejects(
        () => buildCompositionPlan(ctx(state, options), { versionId: state.versionId, audioMode: 'replace' }),
        (error) => error.code && error.code.startsWith('REDRAW_COMPOSITION_'),
      );
    } finally {
      cleanup(state);
    }
  }
});

test('buildCompositionPlan rejects unreadable or escaping media paths and invalid audio binding', async () => {
  for (const mutate of ['video-missing', 'video-escape', 'audio-owner', 'audio-window', 'audio-unconfirmed']) {
    const state = setup();
    try {
      addReadyVersion(state);
      if (mutate === 'video-missing') state.db.prepare('UPDATE video_generations SET local_path = ? WHERE id = 101').run('missing.mp4');
      if (mutate === 'video-escape') state.db.prepare('UPDATE video_generations SET local_path = ? WHERE id = 101').run('../escape.mp4');
      if (mutate === 'audio-owner') {
        const meta = JSON.parse(state.db.prepare('SELECT metadata FROM assets WHERE id = 201').get().metadata);
        meta.tenant_id = 'tenant-other';
        state.db.prepare('UPDATE assets SET metadata = ? WHERE id = 201').run(JSON.stringify(meta));
      }
      if (mutate === 'audio-window') state.db.prepare('UPDATE assets SET duration = ? WHERE id = 201').run(1.5);
      if (mutate === 'audio-unconfirmed') {
        const draft = JSON.parse(state.db.prepare('SELECT draft_json FROM redraw_shots WHERE shot_index = 1').get().draft_json);
        draft.dialogue_generation.segments[0].reservation_status = 'held';
        state.db.prepare('UPDATE redraw_shots SET draft_json = ? WHERE shot_index = 1').run(JSON.stringify(draft));
      }

      await assert.rejects(
        () => buildCompositionPlan(ctx(state), { versionId: state.versionId, audioMode: 'replace' }),
        (error) => error.code && error.code.startsWith('REDRAW_COMPOSITION_'),
      );
    } finally {
      cleanup(state);
    }
  }
});

test('buildCompositionPlan rejects non-replace audio mode and subtitle needs_rewrite', async () => {
  const state = setup();
  try {
    addReadyVersion(state);
    await assert.rejects(
      () => buildCompositionPlan(ctx(state), { versionId: state.versionId, audioMode: 'mix' }),
      /audioMode/,
    );
    state.db.prepare('UPDATE redraw_shots SET localized_dialogue_json = ? WHERE shot_index = 1')
      .run(JSON.stringify([{ segment_id: 'bad', start_ms: 0, end_ms: 1000, text: '' }]));
    await assert.rejects(
      () => buildCompositionPlan(ctx(state), { versionId: state.versionId, audioMode: 'replace' }),
      (error) => error.code === 'REDRAW_COMPOSITION_SUBTITLE_NEEDS_REWRITE',
    );
  } finally {
    cleanup(state);
  }
});

test('createComposition serializes active exports and enforces idempotency key request hash', async () => {
  const state = setup();
  try {
    addReadyVersion(state);
    const first = await createComposition(ctx(state), {
      versionId: state.versionId,
      idempotencyKey: 'compose-1',
      audioMode: 'replace',
    });
    const replay = await createComposition(ctx(state), {
      versionId: state.versionId,
      idempotencyKey: 'compose-1',
      audioMode: 'replace',
    });
    assert.equal(hasAbsoluteString(JSON.parse(first.manifest_json)), false);
    assert.equal(replay.id, first.id);
    await assert.rejects(
      () => createComposition(ctx(state), { versionId: state.versionId, idempotencyKey: 'compose-1', audioMode: 'mix' }),
      (error) => error.code === 'REDRAW_COMPOSITION_IDEMPOTENCY_CONFLICT',
    );
    await assert.rejects(
      () => createComposition(ctx(state), { versionId: state.versionId, idempotencyKey: 'compose-2', audioMode: 'replace' }),
      (error) => error.code === 'REDRAW_COMPOSITION_ACTIVE_CONFLICT',
    );
  } finally {
    cleanup(state);
  }
});

test('runComposition uses ffmpeg args for concat plus delayed replacement audio without atempo', async () => {
  const state = setup();
  const calls = [];
  try {
    addReadyVersion(state);
    const created = await createComposition(ctx(state), {
      versionId: state.versionId,
      idempotencyKey: 'compose-run',
      audioMode: 'replace',
    });
    await runComposition(ctx(state, {
      compositionRunner: async (job) => {
        calls.push(job);
        const argText = job.args.join(' ');
        assert.ok(argText.includes('adelay=0|0'));
        assert.ok(argText.includes('adelay=1400|1400'));
        assert.ok(argText.includes('amix=inputs=2:normalize=0'));
        assert.ok(argText.includes('apad'));
        assert.ok(argText.includes('atrim=0:3'));
        assert.equal(job.args.some((arg) => /atempo/i.test(arg)), false);
        fs.mkdirSync(path.dirname(job.outputPath), { recursive: true });
        fs.writeFileSync(job.outputPath, 'mp4');
      },
    }), created.id);

    assert.equal(calls.length, 1);
  } finally {
    cleanup(state);
  }
});

test('runComposition completes atomically with three assets, version number, relative manifest paths, and subtitles', async () => {
  const state = setup();
  try {
    addReadyVersion(state);
    const created = await createComposition(ctx(state), {
      versionId: state.versionId,
      idempotencyKey: 'compose-success',
      audioMode: 'replace',
    });
    const completed = await runComposition(ctx(state), created.id);
    const row = state.db.prepare('SELECT * FROM redraw_exports WHERE id = ?').get(created.id);
    const assets = state.db.prepare('SELECT * FROM assets WHERE id IN (?, ?, ?) ORDER BY id').all(
      row.asset_id,
      row.subtitle_asset_id,
      JSON.parse(row.manifest_json).outputs.vtt_asset_id,
    );

    assert.equal(completed.status, 'completed');
    assert.equal(row.status, 'completed');
    assert.equal(row.export_type, 'video');
    assert.equal(row.version_number, 1);
    assert.equal(assets.length, 3);
    assert.deepEqual(assets.map((asset) => asset.type), ['video', 'subtitle', 'subtitle']);
    assert.ok(fs.existsSync(path.join(state.root, assets.find((asset) => asset.type === 'video').local_path)));
    assert.ok(fs.readFileSync(path.join(state.root, assets.find((asset) => asset.mime_type === 'application/x-subrip').local_path), 'utf8').includes('Hello'));
    assert.ok(fs.readFileSync(path.join(state.root, assets.find((asset) => asset.mime_type === 'text/vtt').local_path), 'utf8').startsWith('WEBVTT'));
    for (const asset of assets) {
      const metadata = JSON.parse(asset.metadata);
      assert.equal(metadata.tenant_id, 'tenant-a');
      assert.equal(metadata.user_id, 'user-a');
      assert.equal(metadata.version_id, state.versionId);
      assert.equal(metadata.export_id, created.id);
      assert.equal(path.isAbsolute(asset.local_path), false);
    }
    const manifest = JSON.parse(row.manifest_json);
    assert.equal(manifest.audio_mode, 'replace');
    assert.equal(manifest.idempotency_key, 'compose-success');
    assert.equal(manifest.outputs.srt_asset_id, row.subtitle_asset_id);
    assert.equal(hasAbsoluteString(manifest), false);
  } finally {
    cleanup(state);
  }
});

test('runComposition marks failed without deleting prior completed export assets', async () => {
  const state = setup();
  try {
    addReadyVersion(state);
    const oldPath = touch(state.root, 'redraw/version-1/exports/old.mp4', 'old');
    const oldAssetId = state.db.prepare(`INSERT INTO assets
      (name, type, category, local_path, metadata, created_at, updated_at)
      VALUES ('old', 'video', 'redraw_composition', ?, '{}', ?, ?)`)
      .run(oldPath, state.now, state.now).lastInsertRowid;
    state.db.prepare(`INSERT INTO redraw_exports
      (version_id, tenant_id, user_id, export_type, asset_id, version_number, manifest_json, status, created_at, updated_at)
      VALUES (?, 'tenant-a', 'user-a', 'video', ?, 1, '{}', 'completed', ?, ?)`)
      .run(state.versionId, oldAssetId, state.now, state.now);
    const created = await createComposition(ctx(state), {
      versionId: state.versionId,
      idempotencyKey: 'compose-fail',
      audioMode: 'replace',
    });

    await assert.rejects(
      () => runComposition(ctx(state, { compositionRunner: async () => { throw new Error('runner failed'); } }), created.id),
      /runner failed/,
    );

    assert.equal(state.db.prepare('SELECT status FROM redraw_exports WHERE id = ?').get(created.id).status, 'failed');
    assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM assets WHERE id = ?').get(oldAssetId).count, 1);
    assert.equal(fs.existsSync(path.join(state.root, oldPath)), true);
  } finally {
    cleanup(state);
  }
});

test('recoverInterruptedCompositions moves processing exports to needs_attention', () => {
  const state = setup();
  try {
    state.db.prepare(`INSERT INTO redraw_exports
      (version_id, tenant_id, user_id, export_type, version_number, manifest_json, status, created_at, updated_at)
      VALUES (?, 'tenant-a', 'user-a', 'video', 1, '{}', 'processing', ?, ?)`)
      .run(state.versionId, state.now, state.now);

    const changed = recoverInterruptedCompositions(state.db);

    assert.equal(changed, 1);
    assert.equal(state.db.prepare('SELECT status FROM redraw_exports').get().status, 'needs_attention');
  } finally {
    cleanup(state);
  }
});

function hasAbsoluteString(value) {
  if (typeof value === 'string') return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
  if (Array.isArray(value)) return value.some(hasAbsoluteString);
  if (value && typeof value === 'object') return Object.values(value).some(hasAbsoluteString);
  return false;
}
