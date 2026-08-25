'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { reviewCandidate } = require('../src/services/redrawCandidateReviewService');
const { buildEpisodeRelease } = require('../src/services/redrawEpisodeReleaseService');
const { assertCurrentApprovedDialogueScope } = require('../src/services/redrawDialogueOrchestrator');

const NOW = '2026-08-24T08:00:00.000Z';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function write(state, relative, body) {
  const absolute = path.join(state.root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, body);
  return relative.replace(/\\/g, '/');
}

function setup(t) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-episode-release-'));
  const projectId = Number(db.prepare(`INSERT INTO redraw_projects
    (tenant_id, user_id, title, execution_mode, budget_limit_credits, max_auto_attempts_per_shot, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', '项目', 'auto', 100, 2, ?, ?)`).run(NOW, NOW).lastInsertRowid);
  const workId = Number(db.prepare(`INSERT INTO redraw_works
    (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
     duration_ms, current_version, current_step, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', '作品', 1, ?, 12000, 1, 3, 'generating', ?, ?)`)
    .run(projectId, sha256('source'), NOW, NOW).lastInsertRowid);
  const versionId = Number(db.prepare(`INSERT INTO redraw_versions
    (work_id, tenant_id, user_id, version, locale, market, localization_level,
     facts_hash, style_snapshot_json, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 1, 'en-US', 'US', 'faithful', ?, '{}', 'generating', ?, ?)`)
    .run(workId, sha256('facts'), NOW, NOW).lastInsertRowid);
  const ctx = {
    db,
    tenantId: 'tenant-a',
    userId: 'user-a',
    storageRoot: root,
    candidateQualityVerifier: async () => ({
      decision: 'approved',
      reason_codes: [],
      metrics: {
        media: { readable: true },
        dependencies: { current: true },
        identity: { stable: true },
        dialogue: { dialogue_mode: 'dialogue', language_matches: true },
        subtitles: { present: true, within_shot: true },
        lip_sync: { evidence_available: true, passed: true },
      },
    }),
  };
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { db, root, projectId, workId, versionId, ctx, shotIds: [], videoIds: [] };
}

function addAudio(state, localized, { shotId, turnIndex }) {
  const segmentId = `${shotId}:${turnIndex}`;
  const relative = write(state, `audio/${shotId}-${turnIndex}.mp3`, `audio-${segmentId}`);
  const reservationId = `res-${shotId}-${turnIndex}`;
  const assetId = Number(state.db.prepare(`INSERT INTO assets
    (name, type, category, local_path, mime_type, duration, metadata, created_at, updated_at)
    VALUES (?, 'audio', 'redraw_dialogue', ?, 'audio/mpeg', ?, ?, ?, ?)`).run(
    segmentId,
    relative,
    (localized.end_ms - localized.start_ms - 100) / 1000,
    JSON.stringify({ redraw_dialogue: {
      tenant_id: 'tenant-a', user_id: 'user-a', version_id: state.versionId,
      segment_id: segmentId, reservation_id: reservationId,
      idempotency_key: `idem-${shotId}-${turnIndex}`,
    } }),
    NOW,
    NOW,
  ).lastInsertRowid);
  state.db.prepare(`INSERT INTO tenant_usage_reservations
    (id, tenant_id, operation_key, actor_user_id, model, resource_type, resource_id,
     amount, status, created_at, updated_at)
    VALUES (?, 'tenant-a', ?, 'user-a', 'tts', 'redraw_dialogue', ?, 1, 'confirmed', ?, ?)`).run(
    reservationId, `op-${shotId}-${turnIndex}`, `${state.versionId}:${segmentId}`, NOW, NOW,
  );
  return {
    segment_id: segmentId,
    turn_index: turnIndex,
    speaker_id: localized.speaker_id,
    start_ms: localized.start_ms,
    end_ms: localized.end_ms,
    text_hash: sha256(localized.target_text ?? localized.localized_text ?? localized.text ?? ''),
    status: 'completed',
    reservation_status: 'confirmed',
    reservation_id: reservationId,
    idempotency_key: `idem-${shotId}-${turnIndex}`,
    audio_asset_id: assetId,
  };
}

async function addApprovedShot(state, {
  index, startMs, endMs, text = null, textField = 'localized_text',
}) {
  const videoRelative = write(state, `video/shot-${index}.mp4`, `video-${index}`);
  const videoId = Number(state.db.prepare(`INSERT INTO video_generations
    (tenant_id, user_id, local_path, status, duration, aspect_ratio, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', ?, 'completed', ?, '16:9', ?, ?)`).run(
    videoRelative, (endMs - startMs) / 1000, NOW, NOW,
  ).lastInsertRowid);
  const localized = text == null ? [] : [{
    segment_id: `line-${index}`, speaker_id: `speaker-${index}`,
    start_ms: startMs + 100, end_ms: endMs - 100, [textField]: text,
  }];
  const shotId = Number(state.db.prepare(`INSERT INTO redraw_shots
    (version_id, tenant_id, user_id, batch_index, shot_index, start_ms, end_ms, duration_ms,
     source_dialogue_json, localized_dialogue_json, references_json, prompt, compiled_prompt_json,
     draft_json, preparation_state, preparation_version, preparation_evidence_hash,
     video_generation_id, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 1, ?, ?, ?, ?, '[]', ?, '[]', ?, '{}', '{}',
      'reference_ready', 1, ?, ?, 'candidate_ready', ?, ?)`).run(
    state.versionId, index, startMs, endMs, endMs - startMs, JSON.stringify(localized),
    `prompt-${index}`, sha256(`prep-${index}`), videoId, NOW, NOW,
  ).lastInsertRowid);
  if (localized.length) {
    const generated = localized.map((segment, turnIndex) => addAudio(state, segment, { shotId, turnIndex }));
    state.db.prepare('UPDATE redraw_shots SET draft_json = ? WHERE id = ?').run(
      JSON.stringify({ dialogue_generation: { status: 'completed', segments: generated } }), shotId,
    );
  }
  const review = await reviewCandidate(state.ctx, {
    shot_id: shotId,
    video_generation_id: videoId,
    decision_source: 'automatic',
  });
  state.shotIds.push(shotId);
  state.videoIds.push(videoId);
  return { shotId, videoId, review };
}

async function readyEpisode(t) {
  const state = setup(t);
  await addApprovedShot(state, {
    index: 1, startMs: 0, endMs: 1000, text: ' Come with me. ', textField: 'target_text',
  });
  await addApprovedShot(state, { index: 2, startMs: 1000, endMs: 2000 });
  await addApprovedShot(state, { index: 3, startMs: 2000, endMs: 3000, text: 'We are safe.' });
  return state;
}

test('release 只锁定当前版本全部批准候选的服务端重算哈希', async (t) => {
  const state = await readyEpisode(t);
  const release = await buildEpisodeRelease(state.ctx, { version_id: state.versionId });
  const replay = await buildEpisodeRelease(state.ctx, { versionId: state.versionId });

  assert.deepEqual(release, replay);
  assert.deepEqual(Object.keys(release), [
    'schema_version', 'project_id', 'work_id', 'version_id', 'locale', 'market',
    'shots', 'quality_summary', 'release_hash',
  ]);
  assert.equal(release.schema_version, 'redraw-episode-release-v1');
  assert.deepEqual(release.shots.map((item) => item.shot_id), state.shotIds);
  assert.deepEqual(release.shots.map((item) => item.shot_index), [1, 2, 3]);
  assert.equal(release.shots.every((item) => item.candidate_review_id > 0), true);
  assert.equal(release.shots.every((item) => [
    'shot_id', 'shot_index', 'start_ms', 'end_ms', 'candidate_review_id',
    'candidate_sha256', 'audio_sha256', 'subtitle_sha256', 'dependency_hash',
  ].every((key) => Object.hasOwn(item, key))), true);
  assert.equal(release.shots.every((item) => (
    /^[a-f0-9]{64}$/.test(item.candidate_sha256)
      && /^[a-f0-9]{64}$/.test(item.audio_sha256)
      && /^[a-f0-9]{64}$/.test(item.subtitle_sha256)
      && /^[a-f0-9]{64}$/.test(item.dependency_hash)
  )), true);
  assert.match(release.release_hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(release).includes(state.root), false);
  assert.equal(/https?:|local_path|absolute_path|provider/i.test(JSON.stringify(release)), false);
});

test('release 按轮次绑定业务对白与生成音频且对白业务 ID 可以不同', async (t) => {
  const valid = await readyEpisode(t);
  const localized = JSON.parse(valid.db.prepare(
    'SELECT localized_dialogue_json FROM redraw_shots WHERE shot_index = 1',
  ).get().localized_dialogue_json);
  const generated = JSON.parse(valid.db.prepare(
    'SELECT draft_json FROM redraw_shots WHERE shot_index = 1',
  ).get().draft_json).dialogue_generation.segments;
  assert.equal(localized[0].segment_id, 'line-1');
  assert.equal(generated[0].segment_id, `${valid.shotIds[0]}:0`);
  await assert.doesNotReject(buildEpisodeRelease(valid.ctx, { version_id: valid.versionId }));

  for (const mutation of ['turn_index', 'start_ms', 'start_ms_type', 'end_ms', 'speaker_id', 'text_hash']) {
    await t.test(`${mutation} 漂移时 fail closed`, async (subtest) => {
      const state = await readyEpisode(subtest);
      const row = state.db.prepare('SELECT id, draft_json FROM redraw_shots WHERE shot_index = 1').get();
      const draft = JSON.parse(row.draft_json);
      const segment = draft.dialogue_generation.segments[0];
      if (mutation === 'turn_index') segment.turn_index = 1;
      if (mutation === 'start_ms') segment.start_ms += 1;
      if (mutation === 'start_ms_type') segment.start_ms = String(segment.start_ms);
      if (mutation === 'end_ms') segment.end_ms -= 1;
      if (mutation === 'speaker_id') segment.speaker_id = 'speaker-drift';
      if (mutation === 'text_hash') segment.text_hash = sha256('stale localized text');
      state.db.prepare('UPDATE redraw_shots SET draft_json = ? WHERE id = ?')
        .run(JSON.stringify(draft), row.id);

      await assert.rejects(
        buildEpisodeRelease(state.ctx, { version_id: state.versionId }),
        { code: 'REDRAW_EPISODE_RELEASE_AUDIO_CONTRACT_INVALID' },
      );
    });
  }
});

test('release 拒绝缺镜头、顺序或时间线 gap 与跨 owner', async (t) => {
  const state = await readyEpisode(t);
  state.db.prepare('UPDATE redraw_shots SET approved_candidate_review_id = NULL WHERE shot_index = 2').run();
  await assert.rejects(buildEpisodeRelease(state.ctx, { version_id: state.versionId }), {
    code: 'REDRAW_EPISODE_RELEASE_CANDIDATE_NOT_APPROVED',
  });
  state.db.prepare(`UPDATE redraw_shots SET approved_candidate_review_id = (
    SELECT id FROM redraw_candidate_reviews WHERE shot_id = redraw_shots.id AND decision = 'approved'
  ) WHERE shot_index = 2`).run();
  state.db.prepare('UPDATE redraw_shots SET shot_index = 4 WHERE shot_index = 3').run();
  await assert.rejects(buildEpisodeRelease(state.ctx, { version_id: state.versionId }), {
    code: 'REDRAW_EPISODE_RELEASE_ORDER_INVALID',
  });
  state.db.prepare('UPDATE redraw_shots SET shot_index = 3, start_ms = 2100, end_ms = 3100 WHERE shot_index = 4').run();
  await assert.rejects(buildEpisodeRelease(state.ctx, { version_id: state.versionId }), {
    code: 'REDRAW_EPISODE_RELEASE_TIMELINE_INVALID',
  });
  await assert.rejects(buildEpisodeRelease({ ...state.ctx, userId: 'user-b' }, { version_id: state.versionId }), {
    code: 'REDRAW_EPISODE_RELEASE_VERSION_NOT_FOUND',
  });
});

test('release 拒绝旧审核、候选替换和依赖漂移', async (t) => {
  for (const mutation of ['old-review', 'candidate', 'dependency']) {
    await t.test(mutation, async (subtest) => {
      const state = await readyEpisode(subtest);
      if (mutation === 'old-review') {
        state.db.prepare('UPDATE redraw_shots SET approved_candidate_review_id = NULL WHERE shot_index = 1').run();
      } else if (mutation === 'candidate') {
        fs.writeFileSync(path.join(state.root, 'video/shot-1.mp4'), 'candidate-replaced');
      } else {
        state.db.prepare("UPDATE redraw_shots SET prompt = 'dependency-changed' WHERE shot_index = 1").run();
      }
      await assert.rejects(
        buildEpisodeRelease(state.ctx, { version_id: state.versionId }),
        (error) => ['REDRAW_EPISODE_RELEASE_CANDIDATE_NOT_APPROVED', 'REDRAW_EPISODE_RELEASE_INPUT_DRIFT'].includes(error.code),
      );
    });
  }
});

test('release 拒绝字幕越界及 dialogue/silent 音频合同错误', async (t) => {
  for (const mutation of ['subtitle-bounds', 'dialogue-audio-missing', 'silent-audio-present']) {
    await t.test(mutation, async (subtest) => {
      const state = await readyEpisode(subtest);
      if (mutation === 'subtitle-bounds') {
        state.db.prepare('UPDATE redraw_shots SET localized_dialogue_json = ? WHERE shot_index = 1').run(JSON.stringify([{
          segment_id: 'line-1', start_ms: 100, end_ms: 1100, localized_text: 'Come with me.',
        }]));
      } else if (mutation === 'dialogue-audio-missing') {
        state.db.prepare("UPDATE redraw_shots SET draft_json = '{}' WHERE shot_index = 1").run();
      } else {
        const row = state.db.prepare('SELECT draft_json FROM redraw_shots WHERE shot_index = 1').get();
        state.db.prepare('UPDATE redraw_shots SET draft_json = ? WHERE shot_index = 2').run(row.draft_json);
      }
      await assert.rejects(
        buildEpisodeRelease(state.ctx, { version_id: state.versionId }),
        (error) => ['REDRAW_EPISODE_RELEASE_INPUT_DRIFT', 'REDRAW_EPISODE_RELEASE_SUBTITLE_INVALID', 'REDRAW_EPISODE_RELEASE_AUDIO_CONTRACT_INVALID'].includes(error.code),
      );
    });
  }
});

test('旧 completed export 不干扰当前 release，也不能代替批准指针', async (t) => {
  const state = await readyEpisode(t);
  state.db.prepare(`INSERT INTO redraw_exports
    (version_id, tenant_id, user_id, export_type, version_number, manifest_json, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 'video', 99, '{}', 'completed', ?, ?)`).run(state.versionId, NOW, NOW);
  const release = await buildEpisodeRelease(state.ctx, { version_id: state.versionId });
  assert.deepEqual(release.shots.map((shot) => shot.shot_id), state.shotIds);

  state.db.prepare('UPDATE redraw_shots SET approved_candidate_review_id = NULL WHERE shot_index = 1').run();
  await assert.rejects(buildEpisodeRelease(state.ctx, { version_id: state.versionId }), {
    code: 'REDRAW_EPISODE_RELEASE_CANDIDATE_NOT_APPROVED',
  });
});

test('dialogue orchestrator 只处理当前批准候选指针', async (t) => {
  const state = await readyEpisode(t);
  const scope = assertCurrentApprovedDialogueScope(state.db, {
    ...state.ctx,
    versionId: state.versionId,
  });
  assert.deepEqual(scope.shot_ids, state.shotIds);
  assert.equal(scope.candidate_review_ids.length, 3);

  state.db.prepare('UPDATE redraw_shots SET approved_candidate_review_id = NULL WHERE shot_index = 2').run();
  assert.throws(() => assertCurrentApprovedDialogueScope(state.db, {
    ...state.ctx,
    versionId: state.versionId,
  }), { code: 'REDRAW_DIALOGUE_CANDIDATE_NOT_APPROVED' });
});
