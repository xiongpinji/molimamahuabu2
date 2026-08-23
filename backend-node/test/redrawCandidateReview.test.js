'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const credits = require('../src/services/creditLedgerService');
const taskService = require('../src/services/taskService');
const {
  reviewCandidate,
  getCurrentCandidateReview,
  assertCurrentApprovedCandidate,
} = require('../src/services/redrawCandidateReviewService');

const FIRST = '2026-08-24T00:00:00.000Z';
const SECOND = '2026-08-24T00:00:01.000Z';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function quality(overrides = {}) {
  return {
    decision: 'approved',
    reason_codes: [],
    metrics: {
      media: { readable: true },
      dependencies: { current: true },
      identity: { stable: true },
      lip_sync: { evidence_available: true, passed: true },
    },
    ...overrides,
  };
}

function setup(t, options = {}) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-review-'));
  const candidatePath = path.join(storageRoot, 'candidate.mp4');
  fs.writeFileSync(candidatePath, options.bytes || 'candidate-v1');
  db.prepare(`INSERT INTO redraw_projects
    (tenant_id, user_id, title, execution_mode, budget_limit_credits, max_auto_attempts_per_shot,
     created_at, updated_at)
    VALUES ('tenant-a', 'user-a', '项目', ?, 100, 2, ?, ?)`)
    .run(options.mode || 'auto', FIRST, FIRST);
  const projectId = Number(db.prepare('SELECT id FROM redraw_projects').get().id);
  db.prepare(`INSERT INTO redraw_works
    (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
     duration_ms, current_version, current_step, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', '作品', 1, ?, 12000, 1, 3, 'generating', ?, ?)`)
    .run(projectId, sha256('source'), FIRST, FIRST);
  const workId = Number(db.prepare('SELECT id FROM redraw_works').get().id);
  db.prepare(`INSERT INTO redraw_versions
    (work_id, tenant_id, user_id, version, locale, market, style_snapshot_json, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 1, 'en-US', 'US', '{}', 'generating', ?, ?)`)
    .run(workId, FIRST, FIRST);
  const versionId = Number(db.prepare('SELECT id FROM redraw_versions').get().id);
  const dependencyEvidence = sha256('dependency-v1');
  db.prepare(`INSERT INTO redraw_shots
    (version_id, tenant_id, user_id, batch_index, shot_index, start_ms, end_ms, duration_ms,
     prompt, compiled_prompt_json, draft_json, preparation_state, preparation_evidence_hash,
     video_generation_id, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 1, 1, 0, 5000, 5000,
      'prompt', '{}', '{}', 'reference_ready', ?, NULL, 'pending', ?, ?)`)
    .run(versionId, dependencyEvidence, FIRST, FIRST);
  const shotId = Number(db.prepare('SELECT id FROM redraw_shots').get().id);
  db.prepare(`INSERT INTO video_generations
    (tenant_id, user_id, local_path, video_url, status, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', 'candidate.mp4', 'https://result.test/candidate.mp4', 'completed', ?, ?)`)
    .run(FIRST, FIRST);
  const videoId = Number(db.prepare('SELECT id FROM video_generations').get().id);
  db.prepare('UPDATE redraw_shots SET video_generation_id = ? WHERE id = ?').run(videoId, shotId);
  let tick = 0;
  const ctx = {
    db,
    tenantId: 'tenant-a',
    userId: 'user-a',
    storageRoot,
    clock: () => (tick++ === 0 ? SECOND : new Date(Date.parse(SECOND) + tick).toISOString()),
    candidateQualityVerifier: async () => quality(),
  };
  t.after(() => {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });
  return { db, ctx, storageRoot, candidatePath, projectId, workId, versionId, shotId, videoId };
}

function shot(state) {
  return state.db.prepare('SELECT * FROM redraw_shots WHERE id = ?').get(state.shotId);
}

function attachHeldGeneration(state) {
  credits.setTenantAccountBalance(state.db, 'tenant-a', 100);
  const reservation = credits.reserve(state.db, {
    tenantId: 'tenant-a',
    actorUserId: 'user-a',
    operationKey: `candidate-review:${state.shotId}`,
    model: 'verified-video-model',
    resourceType: 'redraw_shot',
    resourceId: state.shotId,
    amount: 12,
  });
  const task = taskService.createTask(state.db, { info() {}, warn() {}, error() {} }, 'redraw_shot', String(state.shotId));
  state.db.prepare(`
    UPDATE async_tasks
    SET status = 'processing', tenant_id = 'tenant-a', user_id = 'user-a', metadata = ?
    WHERE id = ?
  `).run(JSON.stringify({ redraw_shot: { reservation_id: reservation.id } }), task.id);
  state.db.prepare('UPDATE video_generations SET task_id = ? WHERE id = ?').run(task.id, state.videoId);
  state.db.prepare("UPDATE redraw_shots SET status = 'candidate_ready' WHERE id = ?").run(state.shotId);
  return { reservation, task };
}

test('auto 质量全过时追加审核并以 updated_at CAS 绑定当前候选', async (t) => {
  const state = setup(t);
  const review = await reviewCandidate(state.ctx, {
    shot_id: state.shotId,
    video_generation_id: state.videoId,
    decision_source: 'automatic',
  });

  assert.equal(review.decision, 'approved');
  assert.equal(shot(state).approved_candidate_review_id, review.id);
  assert.equal(shot(state).status, 'approved');
  assert.match(review.candidate_sha256, /^[a-f0-9]{64}$/);
  assert.match(review.dependency_hash, /^[a-f0-9]{64}$/);
  assert.equal(getCurrentCandidateReview(state.ctx, { shot_id: state.shotId }).id, review.id);
  assert.equal(assertCurrentApprovedCandidate(state.ctx, { shot_id: state.shotId }).id, review.id);
});

test('A 自动结果始终 needs_review，B 边界结果也降级等待人工', async (t) => {
  const safe = setup(t, { mode: 'safe' });
  const safeReview = await reviewCandidate(safe.ctx, {
    shot_id: safe.shotId,
    video_generation_id: safe.videoId,
    decision_source: 'automatic',
  });
  assert.equal(safeReview.decision, 'needs_review');
  assert.equal(shot(safe).approved_candidate_review_id, null);
  assert.equal(shot(safe).status, 'needs_review');

  const boundary = setup(t, { mode: 'auto' });
  boundary.ctx.candidateQualityVerifier = async () => quality({
    decision: 'needs_review',
    reason_codes: ['lip_sync_evidence_missing'],
  });
  const boundaryReview = await reviewCandidate(boundary.ctx, {
    shot_id: boundary.shotId,
    video_generation_id: boundary.videoId,
    decision_source: 'automatic',
  });
  assert.equal(boundaryReview.decision, 'needs_review');
  assert.deepEqual(boundaryReview.reason_codes, ['lip_sync_evidence_missing']);
  assert.equal(shot(boundary).status, 'needs_review');
});

test('人工批准必须提交当前 expected_updated_at 与 candidate_sha256', async (t) => {
  const state = setup(t, { mode: 'safe' });
  const automatic = await reviewCandidate(state.ctx, {
    shot_id: state.shotId,
    video_generation_id: state.videoId,
    decision_source: 'automatic',
  });
  const current = shot(state);

  await assert.rejects(
    () => reviewCandidate(state.ctx, {
      shot_id: state.shotId,
      video_generation_id: state.videoId,
      decision_source: 'human',
      decision: 'approved',
      candidate_sha256: automatic.candidate_sha256,
    }),
    { code: 'REDRAW_CANDIDATE_REVIEW_EXPECTED_UPDATED_AT_REQUIRED' },
  );
  await assert.rejects(
    () => reviewCandidate(state.ctx, {
      shot_id: state.shotId,
      video_generation_id: state.videoId,
      decision_source: 'human',
      decision: 'approved',
      expected_updated_at: current.updated_at,
    }),
    { code: 'REDRAW_CANDIDATE_REVIEW_SHA_REQUIRED' },
  );
  await assert.rejects(
    () => reviewCandidate(state.ctx, {
      shot_id: state.shotId,
      video_generation_id: state.videoId,
      decision_source: 'human',
      decision: 'approved',
      expected_updated_at: FIRST,
      candidate_sha256: automatic.candidate_sha256,
    }),
    { code: 'REDRAW_CANDIDATE_REVIEW_CONFLICT' },
  );

  const approved = await reviewCandidate(state.ctx, {
    shot_id: state.shotId,
    video_generation_id: state.videoId,
    decision_source: 'human',
    decision: 'approved',
    expected_updated_at: current.updated_at,
    candidate_sha256: automatic.candidate_sha256,
    reviewer_id: 'reviewer-a',
  });
  assert.equal(approved.decision, 'approved');
  assert.equal(approved.reviewer_id, 'user-a');
  assert.equal(shot(state).approved_candidate_review_id, approved.id);
  assert.equal(shot(state).status, 'approved');
});

test('A 模式 held 候选可由人工双 CAS 批准并原子完成任务和结算', async (t) => {
  const state = setup(t, { mode: 'safe' });
  const generation = attachHeldGeneration(state);
  const automatic = await reviewCandidate(state.ctx, {
    shot_id: state.shotId,
    video_generation_id: state.videoId,
    decision_source: 'automatic',
  });
  assert.equal(automatic.decision, 'needs_review');
  assert.equal(shot(state).status, 'needs_review');
  assert.equal(state.db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(generation.task.id).status, 'needs_attention');
  assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(generation.reservation.id).status, 'held');

  const approved = await reviewCandidate(state.ctx, {
    shot_id: state.shotId,
    video_generation_id: state.videoId,
    decision_source: 'human',
    decision: 'approved',
    expected_updated_at: shot(state).updated_at,
    candidate_sha256: automatic.candidate_sha256,
  });

  assert.equal(approved.decision, 'approved');
  assert.equal(shot(state).status, 'approved');
  assert.equal(shot(state).approved_candidate_review_id, approved.id);
  assert.equal(state.db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(generation.task.id).status, 'completed');
  assert.equal(state.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?').get(generation.reservation.id).status, 'confirmed');
  assert.deepEqual(
    state.db.prepare(`
      SELECT v.status AS version_status, w.status AS work_status, w.current_step
      FROM redraw_versions v JOIN redraw_works w ON w.id = v.work_id
      WHERE v.id = ?
    `).get(state.versionId),
    { version_status: 'composing', work_status: 'composing', current_step: 4 },
  );
});

test('全镜门禁只接受当前批准，带有效批准指针的 legacy completed 可兼容', async (t) => {
  async function addSecondCandidate(state) {
    state.db.prepare(`INSERT INTO redraw_shots
      (version_id, tenant_id, user_id, batch_index, shot_index, start_ms, end_ms, duration_ms,
       prompt, compiled_prompt_json, draft_json, preparation_state, preparation_evidence_hash,
       video_generation_id, status, created_at, updated_at)
      VALUES (?, 'tenant-a', 'user-a', 1, 2, 5000, 10000, 5000,
        'prompt-2', '{}', '{}', 'reference_ready', ?, NULL, 'candidate_ready', ?, ?)`)
      .run(state.versionId, sha256('dependency-v2'), FIRST, FIRST);
    const shotId = Number(state.db.prepare('SELECT last_insert_rowid() AS id').get().id);
    state.db.prepare(`INSERT INTO video_generations
      (tenant_id, user_id, local_path, video_url, status, created_at, updated_at)
      VALUES ('tenant-a', 'user-a', 'candidate.mp4', 'https://result.test/candidate-2.mp4', 'completed', ?, ?)`)
      .run(FIRST, FIRST);
    const videoId = Number(state.db.prepare('SELECT last_insert_rowid() AS id').get().id);
    state.db.prepare('UPDATE redraw_shots SET video_generation_id = ? WHERE id = ?').run(videoId, shotId);
    return { shotId, videoId };
  }

  await t.test('未绑定批准指针的 completed 不得推进', async (st) => {
    const state = setup(st);
    const second = await addSecondCandidate(state);
    state.db.prepare("UPDATE redraw_shots SET status = 'completed' WHERE id = ?").run(state.shotId);
    await reviewCandidate(state.ctx, {
      shot_id: second.shotId,
      video_generation_id: second.videoId,
      decision_source: 'automatic',
    });
    assert.equal(state.db.prepare('SELECT status FROM redraw_versions WHERE id = ?').get(state.versionId).status, 'generating');
  });

  await t.test('有效批准指针绑定的 legacy completed 可推进', async (st) => {
    const state = setup(st);
    const second = await addSecondCandidate(state);
    await reviewCandidate(state.ctx, {
      shot_id: state.shotId,
      video_generation_id: state.videoId,
      decision_source: 'automatic',
    });
    state.db.prepare("UPDATE redraw_shots SET status = 'completed' WHERE id = ?").run(state.shotId);
    await reviewCandidate(state.ctx, {
      shot_id: second.shotId,
      video_generation_id: second.videoId,
      decision_source: 'automatic',
    });
    assert.equal(state.db.prepare('SELECT status FROM redraw_versions WHERE id = ?').get(state.versionId).status, 'composing');
  });
});

test('人工驳回可追加；重复同决定幂等，冲突的人工作终态返回 409', async (t) => {
  const state = setup(t, { mode: 'safe' });
  const automatic = await reviewCandidate(state.ctx, {
    shot_id: state.shotId,
    video_generation_id: state.videoId,
    decision_source: 'automatic',
  });
  const expectedUpdatedAt = shot(state).updated_at;
  const input = {
    shot_id: state.shotId,
    video_generation_id: state.videoId,
    decision_source: 'human',
    decision: 'rejected',
    expected_updated_at: expectedUpdatedAt,
    candidate_sha256: automatic.candidate_sha256,
    reason_codes: ['human_rejected'],
    reviewer_id: 'reviewer-a',
  };
  state.ctx.beforeCandidateReviewCommit = async () => new Promise((resolve) => setImmediate(resolve));
  const [first, duplicate] = await Promise.all([
    reviewCandidate(state.ctx, input),
    reviewCandidate(state.ctx, input),
  ]);
  assert.equal(first.id, duplicate.id);
  assert.equal(shot(state).status, 'needs_review');
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM redraw_candidate_reviews').get().count, 2);

  await assert.rejects(
    () => reviewCandidate(state.ctx, {
      ...input,
      decision: 'approved',
      expected_updated_at: shot(state).updated_at,
    }),
    (error) => error.code === 'REDRAW_CANDIDATE_REVIEW_CONFLICT' && error.status === 409,
  );
});

test('审核中候选文件或依赖漂移均 fail closed 且不追加审核', async (t) => {
  for (const kind of ['candidate', 'dependency']) {
    await t.test(kind, async (st) => {
      const state = setup(st);
      state.ctx.beforeCandidateReviewCommit = () => {
        if (kind === 'candidate') fs.writeFileSync(state.candidatePath, 'candidate-v2');
        else state.db.prepare('UPDATE redraw_shots SET preparation_evidence_hash = ? WHERE id = ?')
          .run(sha256('dependency-v2'), state.shotId);
      };
      await assert.rejects(
        () => reviewCandidate(state.ctx, {
          shot_id: state.shotId,
          video_generation_id: state.videoId,
          decision_source: 'automatic',
        }),
        { code: 'REDRAW_CANDIDATE_REVIEW_STALE' },
      );
      assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM redraw_candidate_reviews').get().count, 0);
      assert.equal(shot(state).approved_candidate_review_id, null);
    });
  }
});

test('旧审核不可更新或删除，当前查询忽略文件漂移后的旧批准', async (t) => {
  const state = setup(t);
  const review = await reviewCandidate(state.ctx, {
    shot_id: state.shotId,
    video_generation_id: state.videoId,
    decision_source: 'automatic',
  });
  assert.throws(
    () => state.db.prepare('UPDATE redraw_candidate_reviews SET decision = ? WHERE id = ?').run('rejected', review.id),
    /immutable/,
  );
  assert.throws(
    () => state.db.prepare('DELETE FROM redraw_candidate_reviews WHERE id = ?').run(review.id),
    /immutable/,
  );
  fs.writeFileSync(state.candidatePath, 'candidate-v2');
  assert.equal(getCurrentCandidateReview(state.ctx, { shot_id: state.shotId }), null);
  assert.throws(
    () => assertCurrentApprovedCandidate(state.ctx, { shot_id: state.shotId }),
    { code: 'REDRAW_CANDIDATE_NOT_APPROVED' },
  );
});
