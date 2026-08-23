const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { getFfmpegPath, getFfprobePath } = require('../src/utils/ffmpegPath');
const { reviewCandidate } = require('../src/services/redrawCandidateReviewService');
const { resolveDownloadArtifact } = require('../src/services/redrawExportService');
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

function fileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function addVideo(state, id, relative, overrides = {}) {
  state.db.prepare(`INSERT INTO video_generations
    (id, tenant_id, user_id, local_path, status, duration, aspect_ratio, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '16:9', ?, ?)`)
    .run(
      id,
      Object.prototype.hasOwnProperty.call(overrides, 'tenantId') ? overrides.tenantId : 'tenant-a',
      Object.prototype.hasOwnProperty.call(overrides, 'userId') ? overrides.userId : 'user-a',
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

function addDialogueAsset(state, id, relative, metadata, body = 'media') {
  const dialogue = metadata.redraw_dialogue || metadata;
  touch(state.root, relative, body);
  state.db.prepare(`INSERT INTO assets
    (id, name, type, category, local_path, mime_type, duration, metadata, created_at, updated_at)
    VALUES (?, '配音', 'audio', 'redraw_dialogue', ?, 'audio/mpeg', ?, ?, ?, ?)`)
    .run(id, relative, dialogue.duration_ms / 1000, JSON.stringify({ redraw_dialogue: dialogue }), state.now, state.now);
  state.db.prepare(`INSERT INTO tenant_usage_reservations
    (id, tenant_id, operation_key, actor_user_id, model, resource_type, resource_id, amount, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'speech-2.8-turbo', 'redraw_dialogue', ?, 1, ?, ?, ?)`)
    .run(
      dialogue.reservation_id,
      dialogue.tenant_id,
      `op-${dialogue.reservation_id}`,
      dialogue.user_id,
      `${dialogue.version_id}:${dialogue.segment_id}`,
      metadata.reservationStatus || 'confirmed',
      state.now,
      state.now,
    );
}

async function addReadyVersion(state, options = {}) {
  const v1 = touch(state.root, 'videos/shot-1.mp4', options.video1Bytes || 'media');
  const v2 = touch(state.root, 'videos/shot-2.mp4', options.video2Bytes || 'media');
  addVideo(state, 101, v1, { durationMs: 1000 });
  addVideo(state, 102, v2, { durationMs: 2000 });
  const a1 = 'audio/a1.mp3';
  const a2 = 'audio/a2.mp3';
  addDialogueAsset(state, 201, a1, {
    tenant_id: 'tenant-a',
    user_id: 'user-a',
    version_id: state.versionId,
    segment_id: 'a',
    reservation_id: 'res-a',
    idempotency_key: 'dialogue-key-a',
    duration_ms: 900,
  }, options.audio1Bytes || 'media');
  addDialogueAsset(state, 202, a2, {
    tenant_id: 'tenant-a',
    user_id: 'user-a',
    version_id: state.versionId,
    segment_id: 'b',
    reservation_id: 'res-b',
    idempotency_key: 'dialogue-key-b',
    duration_ms: 700,
  }, options.audio2Bytes || 'media');
  addShot(state, {
    shotIndex: 1,
    startMs: 0,
    endMs: 1000,
    videoGenerationId: 101,
    dialogue: options.silent ? [] : [{ segment_id: 'a', start_ms: 0, end_ms: 1000, text: 'Hello' }],
    draft: options.silent ? {} : { dialogue_generation: { segments: [{
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
    dialogue: options.silent ? [] : [{ segment_id: 'b', start_ms: 1400, end_ms: 2300, text: 'World' }],
    draft: options.silent ? {} : { dialogue_generation: { segments: [{
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
  for (const row of state.db.prepare('SELECT id, video_generation_id FROM redraw_shots ORDER BY shot_index').all()) {
    await reviewCandidate({
      ...ctx(state),
      candidateExecutionMode: 'auto',
      candidateQualityVerifier: async () => ({
        decision: 'approved',
        reason_codes: [],
        metrics: { media: { readable: true }, dependencies: { current: true } },
      }),
    }, {
      shot_id: row.id,
      video_generation_id: row.video_generation_id,
      decision_source: 'automatic',
    });
  }
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

test('buildCompositionPlan enforces owner, approved ordered continuous shots, and ignores deleted shots', async () => {
  const state = setup();
  try {
    await addReadyVersion(state);
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

test('buildCompositionPlan fails when any non-deleted version shot is incomplete or missing video', async () => {
  for (const mutate of ['pending-shot', 'missing-video']) {
    const state = setup();
    try {
      await addReadyVersion(state);
      if (mutate === 'pending-shot') {
        addShot(state, {
          shotIndex: 3,
          startMs: 3000,
          endMs: 4000,
          videoGenerationId: 101,
          status: 'pending',
        });
      } else {
        state.db.prepare('UPDATE redraw_shots SET video_generation_id = NULL WHERE shot_index = 2').run();
      }

      await assert.rejects(
        () => buildCompositionPlan(ctx(state), { versionId: state.versionId, audioMode: 'replace' }),
        (error) => ['REDRAW_COMPOSITION_SHOT_INCOMPLETE', 'REDRAW_COMPOSITION_INPUT_DRIFT'].includes(error.code),
      );
    } finally {
      cleanup(state);
    }
  }
});

test('buildCompositionPlan rejects owner mismatch, gaps, unfinished videos, bad duration, and dimension drift', async () => {
  for (const mutate of ['owner', 'owner-null', 'gap', 'unfinished', 'duration', 'dimension']) {
    const state = setup();
    try {
      await addReadyVersion(state);
      if (mutate === 'owner') state.db.prepare('UPDATE video_generations SET tenant_id = ? WHERE id = 101').run('tenant-other');
      if (mutate === 'owner-null') state.db.prepare('UPDATE video_generations SET tenant_id = NULL WHERE id = 101').run();
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
  for (const mutate of ['video-missing', 'video-escape', 'audio-owner', 'audio-reservation', 'audio-window', 'audio-unconfirmed']) {
    const state = setup();
    try {
      await addReadyVersion(state);
      if (mutate === 'video-missing') state.db.prepare('UPDATE video_generations SET local_path = ? WHERE id = 101').run('missing.mp4');
      if (mutate === 'video-escape') state.db.prepare('UPDATE video_generations SET local_path = ? WHERE id = 101').run('../escape.mp4');
      if (mutate === 'audio-owner') {
        const meta = JSON.parse(state.db.prepare('SELECT metadata FROM assets WHERE id = 201').get().metadata);
        meta.redraw_dialogue.tenant_id = 'tenant-other';
        state.db.prepare('UPDATE assets SET metadata = ? WHERE id = 201').run(JSON.stringify(meta));
      }
      if (mutate === 'audio-reservation') {
        state.db.prepare('UPDATE tenant_usage_reservations SET status = ? WHERE id = ?').run('held', 'res-a');
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

test('buildCompositionPlan hashes exact video and audio bytes, including invalid UTF-8 bytes', async () => {
  const first = setup();
  const second = setup();
  try {
    await addReadyVersion(first, { video1Bytes: Buffer.from([0xff, 0xfe, 0x00, 0x61]) });
    await addReadyVersion(second, { video1Bytes: Buffer.from([0xef, 0xbf, 0xbd, 0xef, 0xbf, 0xbd, 0x00, 0x61]) });

    const planA = await buildCompositionPlan(ctx(first), { versionId: first.versionId, audioMode: 'replace' });
    const planB = await buildCompositionPlan(ctx(second), { versionId: second.versionId, audioMode: 'replace' });

    assert.notEqual(planA.video_inputs[0].hash, planB.video_inputs[0].hash);
    assert.notEqual(planA.input_hash, planB.input_hash);
  } finally {
    cleanup(first);
    cleanup(second);
  }
});

test('buildCompositionPlan rejects non-replace audio mode and subtitle needs_rewrite', async () => {
  const state = setup();
  try {
    await addReadyVersion(state);
    await assert.rejects(
      () => buildCompositionPlan(ctx(state), { versionId: state.versionId, audioMode: 'mix' }),
      /audioMode/,
    );
    state.db.prepare('UPDATE redraw_shots SET localized_dialogue_json = ? WHERE shot_index = 1')
      .run(JSON.stringify([{ segment_id: 'bad', start_ms: 0, end_ms: 1000, text: '' }]));
    await assert.rejects(
      () => buildCompositionPlan(ctx(state), { versionId: state.versionId, audioMode: 'replace' }),
      (error) => error.code === 'REDRAW_COMPOSITION_INPUT_DRIFT',
    );
  } finally {
    cleanup(state);
  }
});

test('createComposition serializes active exports and enforces idempotency key request hash', async () => {
  const state = setup();
  try {
    await addReadyVersion(state);
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
    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    state.db.prepare('UPDATE video_generations SET local_path = ? WHERE id = 102')
      .run(touch(state.root, 'videos/shot-2-changed.mp4', 'changed-video-bytes'));
    await assert.rejects(
      () => createComposition(ctx(state), { versionId: state.versionId, idempotencyKey: 'compose-1', audioMode: 'replace' }),
      (error) => error.code === 'REDRAW_COMPOSITION_INPUT_DRIFT',
    );
    state.db.prepare('UPDATE video_generations SET local_path = ? WHERE id = 102').run('videos/shot-2.mp4');
    await assert.rejects(
      () => createComposition(ctx(state), { versionId: state.versionId, idempotencyKey: 'compose-2', audioMode: 'replace' }),
      (error) => error.code === 'REDRAW_COMPOSITION_ACTIVE_CONFLICT',
    );
  } finally {
    cleanup(state);
  }
});

test('runComposition rejects stale manifests before mutation when inputs drift after create', async () => {
  const state = setup();
  try {
    await addReadyVersion(state);
    const created = await createComposition(ctx(state), {
      versionId: state.versionId,
      idempotencyKey: 'compose-stale',
      audioMode: 'replace',
    });
    state.db.prepare('UPDATE video_generations SET local_path = ? WHERE id = 101')
      .run(touch(state.root, 'videos/shot-1-drift.mp4', 'drift'));

    await assert.rejects(
      () => runComposition(ctx(state), created.id),
      (error) => error.code === 'REDRAW_COMPOSITION_INPUT_DRIFT',
    );

    assert.equal(state.db.prepare('SELECT status FROM redraw_exports WHERE id = ?').get(created.id).status, 'pending');
  } finally {
    cleanup(state);
  }
});

test('runComposition requires owner CAS and never mutates wrong-owner or processing exports', async () => {
  const state = setup();
  try {
    await addReadyVersion(state);
    const created = await createComposition(ctx(state), {
      versionId: state.versionId,
      idempotencyKey: 'compose-owner',
      audioMode: 'replace',
    });

    await assert.rejects(
      () => runComposition(ctx(state, { userId: 'user-other' }), created.id),
      (error) => error.code === 'REDRAW_COMPOSITION_EXPORT_NOT_FOUND',
    );
    assert.equal(state.db.prepare('SELECT status FROM redraw_exports WHERE id = ?').get(created.id).status, 'pending');

    state.db.prepare("UPDATE redraw_exports SET status = 'processing' WHERE id = ?").run(created.id);
    await assert.rejects(
      () => runComposition(ctx(state), created.id),
      (error) => error.code === 'REDRAW_COMPOSITION_EXPORT_STATE_INVALID',
    );
    assert.equal(state.db.prepare('SELECT status FROM redraw_exports WHERE id = ?').get(created.id).status, 'processing');
  } finally {
    cleanup(state);
  }
});

test('runComposition uses ffmpeg args for concat plus delayed replacement audio without atempo', async () => {
  const state = setup();
  const calls = [];
  try {
    await addReadyVersion(state);
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
        assert.ok(argText.includes('setpts=PTS-STARTPTS'));
        assert.deepEqual(job.args.slice(job.args.indexOf('-t'), job.args.indexOf('-t') + 2), ['-t', '3']);
        assert.deepEqual(job.args.slice(0, 4), ['-hide_banner', '-loglevel', 'error', '-y']);
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

test('runComposition applies default process timeouts and marks ffmpeg/probe timeouts failed', async () => {
  for (const mode of ['ffmpeg', 'probe']) {
    const state = setup();
    const optionsSeen = [];
    try {
      await addReadyVersion(state);
      const created = await createComposition(ctx(state), {
        versionId: state.versionId,
        idempotencyKey: `compose-timeout-${mode}`,
        audioMode: 'replace',
      });
      const fakeExecFile = (_bin, _args, options, callback) => {
        optionsSeen.push(options);
        const error = new Error('timed out');
        error.killed = true;
        error.signal = options.killSignal;
        error.code = 'ETIMEDOUT';
        callback(error);
      };
      const overrides = mode === 'ffmpeg'
        ? { compositionRunner: undefined, probeRunner: undefined, execFile: fakeExecFile }
        : {
          compositionRunner: async ({ outputPath }) => fs.writeFileSync(outputPath, 'mp4'),
          probeRunner: undefined,
          execFile: fakeExecFile,
        };

      await assert.rejects(
        () => runComposition(ctx(state, overrides), created.id),
        (error) => error.code === (mode === 'ffmpeg' ? 'REDRAW_COMPOSITION_TIMEOUT' : 'REDRAW_COMPOSITION_PROBE_TIMEOUT'),
      );

      const row = state.db.prepare('SELECT status, error_code FROM redraw_exports WHERE id = ?').get(created.id);
      assert.equal(row.status, 'failed');
      assert.equal(row.error_code, mode === 'ffmpeg' ? 'REDRAW_COMPOSITION_TIMEOUT' : 'REDRAW_COMPOSITION_PROBE_TIMEOUT');
      assert.equal(optionsSeen.length, 1);
      assert.equal(optionsSeen[0].killSignal, 'SIGKILL');
      assert.equal(Number.isSafeInteger(optionsSeen[0].timeout), true);
      assert.ok(optionsSeen[0].timeout >= 30000);
      assert.ok(optionsSeen[0].timeout <= 1800000);
    } finally {
      cleanup(state);
    }
  }
});

test('runComposition rejects output probe dimension drift', async () => {
  const state = setup();
  try {
    await addReadyVersion(state);
    const created = await createComposition(ctx(state), {
      versionId: state.versionId,
      idempotencyKey: 'compose-output-dim',
      audioMode: 'replace',
    });
    await assert.rejects(
      () => runComposition(ctx(state, {
        probeRunner: async () => ({
          duration: 3,
          width: 640,
          height: 720,
          hasVideo: true,
          hasAudio: true,
        }),
      }), created.id),
      (error) => error.code === 'REDRAW_COMPOSITION_OUTPUT_INVALID',
    );
  } finally {
    cleanup(state);
  }
});

test('runComposition rejects symlinked export base before writing and keeps outside target unchanged', async () => {
  const state = setup();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-composition-outside-'));
  try {
    await addReadyVersion(state);
    const created = await createComposition(ctx(state), {
      versionId: state.versionId,
      idempotencyKey: 'compose-junction',
      audioMode: 'replace',
    });
    const exportsParent = path.join(state.root, 'redraw', `version-${state.versionId}`);
    fs.mkdirSync(exportsParent, { recursive: true });
    const link = path.join(exportsParent, 'exports');
    try {
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      assert.equal(error.code, 'EPERM');
      return;
    }
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'keep');

    await assert.rejects(
      () => runComposition(ctx(state), created.id),
      (error) => error.code === 'REDRAW_COMPOSITION_OUTPUT_PATH_UNSAFE',
    );

    assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'keep');
    assert.equal(fs.existsSync(path.join(outside, String(created.id))), false);
  } finally {
    cleanup(state);
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('runComposition completes atomically with three assets, version number, relative manifest paths, and subtitles', async () => {
  const state = setup();
  try {
    await addReadyVersion(state);
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
    assert.equal(manifest.episode_release.release_hash, row.release_hash);
    assert.match(row.release_hash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.parse(row.quality_summary_json).decision, 'approved');
    assert.equal(manifest.outputs.srt_asset_id, row.subtitle_asset_id);
    assert.notEqual(manifest.outputs.hashes.mp4, 'final-hash');
    assert.equal(manifest.outputs.hashes.mp4, await fileSha256(path.join(state.root, manifest.outputs.mp4_path)));
    assert.equal(manifest.outputs.hashes.srt, await fileSha256(path.join(state.root, manifest.outputs.srt_path)));
    assert.equal(manifest.outputs.hashes.vtt, await fileSha256(path.join(state.root, manifest.outputs.vtt_path)));
    assert.equal(hasAbsoluteString(manifest), false);
    assert.deepEqual(
      state.db.prepare('SELECT status FROM redraw_shots ORDER BY shot_index').all().map((shot) => shot.status),
      ['included', 'included'],
    );
    assert.equal(state.db.prepare('SELECT status FROM redraw_versions WHERE id = ?').get(state.versionId).status, 'completed');
  } finally {
    cleanup(state);
  }
});

test('runComposition marks failed without deleting prior completed export assets', async () => {
  const state = setup();
  try {
    await addReadyVersion(state);
    const oldPath = touch(state.root, 'redraw/version-1/exports/old.mp4', 'old');
    const oldAssetId = state.db.prepare(`INSERT INTO assets
      (name, type, category, local_path, metadata, created_at, updated_at)
      VALUES ('old', 'video', 'redraw_composition', ?, '{}', ?, ?)`)
      .run(oldPath, state.now, state.now).lastInsertRowid;
    const oldReleaseHash = 'a'.repeat(64);
    const oldManifest = JSON.stringify({ preserved: true });
    const oldExportId = Number(state.db.prepare(`INSERT INTO redraw_exports
      (version_id, tenant_id, user_id, export_type, asset_id, version_number, manifest_json,
       release_hash, status, created_at, updated_at)
      VALUES (?, 'tenant-a', 'user-a', 'video', ?, 1, ?, ?, 'completed', ?, ?)`)
      .run(state.versionId, oldAssetId, oldManifest, oldReleaseHash, state.now, state.now).lastInsertRowid);
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
    assert.deepEqual(
      state.db.prepare('SELECT status, manifest_json, release_hash FROM redraw_exports WHERE id = ?').get(oldExportId),
      { status: 'completed', manifest_json: oldManifest, release_hash: oldReleaseHash },
    );
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

test('runComposition gives an all-silent approved release an explicit silent audio track', async () => {
  const state = setup();
  try {
    await addReadyVersion(state, { silent: true });
    const created = await createComposition(ctx(state), {
      versionId: state.versionId,
      idempotencyKey: 'compose-silent',
      audioMode: 'replace',
    });
    const completed = await runComposition(ctx(state, {
      compositionRunner: async (job) => {
        assert.equal(job.plan.audio_inputs.length, 0);
        assert.ok(job.args.includes('anullsrc=channel_layout=stereo:sample_rate=48000'));
        fs.mkdirSync(path.dirname(job.outputPath), { recursive: true });
        fs.writeFileSync(job.outputPath, 'mp4');
      },
    }), created.id);
    assert.equal(completed.status, 'completed');
  } finally {
    cleanup(state);
  }
});

test('REQUIRE_LOCAL_FFMPEG 生成可 probe MP4、SRT、VTT 和脱敏 release manifest', async (t) => {
  if (process.env.REQUIRE_LOCAL_FFMPEG !== '1') {
    t.skip('set REQUIRE_LOCAL_FFMPEG=1 to require real media composition');
    return;
  }
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-composition-real-fixture-'));
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
  const ffmpeg = getFfmpegPath();
  const ffprobe = getFfprobePath();
  function generated(name, args) {
    const output = path.join(fixtureDir, name);
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, output], { windowsHide: true });
    return fs.readFileSync(output);
  }
  const media = {
    video1Bytes: generated('shot-1.mp4', [
      '-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=1', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '1',
    ]),
    video2Bytes: generated('shot-2.mp4', [
      '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=2', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '2',
    ]),
    audio1Bytes: generated('a1.mp3', [
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.8', '-c:a', 'libmp3lame',
    ]),
    audio2Bytes: generated('a2.mp3', [
      '-f', 'lavfi', '-i', 'sine=frequency=660:duration=0.6', '-c:a', 'libmp3lame',
    ]),
  };
  const state = setup();
  try {
    await addReadyVersion(state, media);
    const realCtx = ctx(state, {
      width: 320,
      height: 180,
      compositionRunner: undefined,
      probeRunner: undefined,
    });
    const created = await createComposition(realCtx, {
      versionId: state.versionId,
      idempotencyKey: 'real-ffmpeg-release',
      audioMode: 'replace',
    });
    const completed = await runComposition(realCtx, created.id);
    const manifest = JSON.parse(completed.manifest_json);
    const outputPath = path.join(state.root, manifest.outputs.mp4_path);
    const probe = JSON.parse(execFileSync(ffprobe, [
      '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', outputPath,
    ], { encoding: 'utf8', windowsHide: true }));
    assert.equal(probe.streams.some((stream) => stream.codec_type === 'video'), true);
    assert.equal(probe.streams.some((stream) => stream.codec_type === 'audio'), true);
    assert.ok(Math.abs(Number(probe.format.duration) - 3) <= 0.1);
    assert.ok(fs.readFileSync(path.join(state.root, manifest.outputs.srt_path), 'utf8').includes('Hello'));
    assert.ok(fs.readFileSync(path.join(state.root, manifest.outputs.vtt_path), 'utf8').startsWith('WEBVTT'));
    assert.match(completed.release_hash, /^[a-f0-9]{64}$/);
    assert.equal(hasAbsoluteString(manifest), false);
    assert.equal(/https?:|provider|api[_-]?key|token|secret/i.test(JSON.stringify(manifest.episode_release)), false);
    for (const kind of ['mp4', 'srt', 'vtt']) {
      const download = await resolveDownloadArtifact(realCtx, { exportId: completed.id, kind });
      assert.match(download.sha256, /^[a-f0-9]{64}$/);
      assert.equal(fs.existsSync(download.absolute_path), true);
    }
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
