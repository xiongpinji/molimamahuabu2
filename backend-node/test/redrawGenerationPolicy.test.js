const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const {
  evaluateGenerationPolicy,
  projectBudgetSnapshot,
} = require('../src/services/redrawGenerationPolicyService');

test('auto 项目在预算刚好且未达到每镜尝试上限时提交下一次', () => {
  assert.deepEqual(evaluateGenerationPolicy({
    execution_mode: 'auto',
    budget_limit_credits: 100,
    spent_credits: 70,
    held_credits: 20,
    quote_credits: 10,
    max_auto_attempts_per_shot: 2,
    completed_attempts: 1,
    prior_state: 'failed',
  }), { action: 'submit', attempt: 2 });
});

test('auto 项目超预算或达到尝试上限时稳定降级 safe 并进入 needs_review', () => {
  assert.deepEqual(evaluateGenerationPolicy({
    execution_mode: 'auto',
    budget_limit_credits: 99,
    spent_credits: 70,
    held_credits: 20,
    quote_credits: 10,
    max_auto_attempts_per_shot: 2,
    completed_attempts: 1,
    prior_state: 'failed',
  }), {
    action: 'needs_review',
    effective_mode: 'safe',
    reason: 'project_budget_exceeded',
  });

  assert.deepEqual(evaluateGenerationPolicy({
    execution_mode: 'auto',
    budget_limit_credits: 100,
    spent_credits: 10,
    held_credits: 0,
    quote_credits: 10,
    max_auto_attempts_per_shot: 2,
    completed_attempts: 2,
    prior_state: 'failed',
  }), {
    action: 'needs_review',
    effective_mode: 'safe',
    reason: 'auto_attempt_limit_reached',
  });
});

test('auto 项目缺预算或缺自动尝试上限时 fail closed', () => {
  for (const input of [
    { budget_limit_credits: null, max_auto_attempts_per_shot: 2, reason: 'auto_budget_missing' },
    { budget_limit_credits: 100, max_auto_attempts_per_shot: null, reason: 'auto_attempt_limit_missing' },
  ]) {
    assert.deepEqual(evaluateGenerationPolicy({
      execution_mode: 'auto',
      spent_credits: 0,
      held_credits: 0,
      quote_credits: 10,
      completed_attempts: 0,
      prior_state: null,
      ...input,
    }), { action: 'blocked', reason: input.reason });
  }
});

test('结果不明或本镜旧 held 优先 blocked，新 key 和新 attempt 不能绕过', () => {
  for (const priorState of ['submission_unknown', 'needs_attention']) {
    assert.deepEqual(evaluateGenerationPolicy({
      execution_mode: 'safe',
      spent_credits: 0,
      held_credits: 0,
      quote_credits: 10,
      completed_attempts: 1,
      prior_state: priorState,
    }), { action: 'blocked', reason: 'submission_state_uncertain' });
  }
  assert.deepEqual(evaluateGenerationPolicy({
    execution_mode: 'auto',
    budget_limit_credits: 100,
    spent_credits: 0,
    held_credits: 10,
    quote_credits: 10,
    max_auto_attempts_per_shot: 5,
    completed_attempts: 1,
    prior_state: 'failed',
    prior_held_reservation: true,
  }), { action: 'blocked', reason: 'prior_reservation_held' });
});

test('safe 模式的明确 generate 允许提交，精确当前链允许复用', () => {
  assert.deepEqual(evaluateGenerationPolicy({
    execution_mode: 'safe',
    spent_credits: 0,
    held_credits: 0,
    quote_credits: 10,
    completed_attempts: 0,
    prior_state: null,
  }), { action: 'submit', attempt: 1 });
  assert.deepEqual(evaluateGenerationPolicy({
    execution_mode: 'safe',
    spent_credits: 0,
    held_credits: 10,
    quote_credits: 10,
    completed_attempts: 1,
    prior_state: 'processing',
    prior_held_reservation: true,
    exact_reusable: true,
  }), { action: 'reuse', attempt: 1 });
});

function insertProjectChain(db, input) {
  const timestamp = '2026-08-24T00:00:00.000Z';
  const projectId = Number(db.prepare(`INSERT INTO redraw_projects
    (tenant_id, user_id, title, execution_mode, budget_limit_credits, max_auto_attempts_per_shot, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(input.tenantId, input.userId, input.title, input.mode, input.budget, input.maxAttempts, timestamp, timestamp).lastInsertRowid);
  const workId = Number(db.prepare(`INSERT INTO redraw_works
    (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms,
     current_version, current_step, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, 15000, 1, 3, 'ready_to_generate', ?, ?)`)
    .run(projectId, input.tenantId, input.userId, input.title, `${input.title}-source`, timestamp, timestamp).lastInsertRowid);
  const versionId = Number(db.prepare(`INSERT INTO redraw_versions
    (work_id, tenant_id, user_id, version, locale, market, status, created_at, updated_at)
    VALUES (?, ?, ?, 1, 'en-US', 'US', 'ready_to_generate', ?, ?)`)
    .run(workId, input.tenantId, input.userId, timestamp, timestamp).lastInsertRowid);
  const shotId = Number(db.prepare(`INSERT INTO redraw_shots
    (version_id, tenant_id, user_id, batch_index, shot_index, start_ms, end_ms, duration_ms,
     status, created_at, updated_at)
    VALUES (?, ?, ?, 1, 1, 0, 5000, 5000, ?, ?, ?)`)
    .run(versionId, input.tenantId, input.userId, input.shotStatus || 'failed', timestamp, timestamp).lastInsertRowid);
  return { projectId, workId, versionId, shotId, timestamp };
}

test('projectBudgetSnapshot 只汇总当前 owner/project 且 attempt 来自服务端任务证据', () => {
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    const own = insertProjectChain(db, {
      tenantId: 'tenant-a', userId: 'user-a', title: 'own', mode: 'auto', budget: 100, maxAttempts: 3,
    });
    const other = insertProjectChain(db, {
      tenantId: 'tenant-b', userId: 'user-b', title: 'other', mode: 'auto', budget: 999, maxAttempts: 5,
    });
    const historicalShotId = Number(db.prepare(`INSERT INTO redraw_shots
      (version_id, tenant_id, user_id, batch_index, shot_index, start_ms, end_ms, duration_ms,
       status, created_at, updated_at, deleted_at)
      VALUES (?, 'tenant-a', 'user-a', 1, 2, 5000, 10000, 5000, 'completed', ?, ?, ?)`)
      .run(own.versionId, own.timestamp, own.timestamp, own.timestamp).lastInsertRowid);
    db.prepare(`INSERT INTO tenant_usage_reservations
      (id, tenant_id, operation_key, actor_user_id, model, resource_type, resource_id, amount, status, created_at, updated_at)
      VALUES
      ('own-confirmed', 'tenant-a', 'own-confirmed', 'user-a', 'video', 'redraw_shot', ?, 30, 'confirmed', ?, ?),
      ('own-refunded', 'tenant-a', 'own-refunded', 'user-a', 'video', 'redraw_shot', ?, 20, 'refunded', ?, ?),
      ('other-held', 'tenant-b', 'other-held', 'user-b', 'video', 'redraw_shot', ?, 90, 'held', ?, ?)`)
      .run(String(historicalShotId), own.timestamp, own.timestamp, String(own.shotId), own.timestamp, own.timestamp,
        String(other.shotId), other.timestamp, other.timestamp);
    const task = db.prepare(`INSERT INTO async_tasks
      (id, type, resource_id, status, progress, tenant_id, user_id, metadata, created_at, updated_at)
      VALUES ('own-task', 'redraw_shot', ?, 'failed', 100, 'tenant-a', 'user-a', ?, ?, ?)`);
    task.run(String(own.shotId), JSON.stringify({ redraw_shot: { attempt: 2, reservation_id: 'own-refunded' } }), own.timestamp, own.timestamp);
    db.prepare(`INSERT INTO video_generations
      (status, task_id, tenant_id, user_id, created_at, updated_at)
      VALUES ('failed', 'own-task', 'tenant-a', 'user-a', ?, ?)`).run(own.timestamp, own.timestamp);
    db.prepare(`INSERT INTO async_tasks
      (id, type, resource_id, status, progress, tenant_id, user_id, metadata, created_at, updated_at)
      VALUES ('orphan-task', 'redraw_shot', ?, 'failed', 100, 'tenant-a', 'user-a', ?, ?, ?)`)
      .run(String(own.shotId), JSON.stringify({ redraw_shot: { attempt: 5, reservation_id: 'missing-reservation' } }), own.timestamp, own.timestamp);

    assert.deepEqual(projectBudgetSnapshot(db, {
      tenantId: 'tenant-a',
      userId: 'user-a',
      versionId: own.versionId,
      shotId: own.shotId,
    }), {
      project_id: own.projectId,
      execution_mode: 'auto',
      budget_limit_credits: 100,
      max_auto_attempts_per_shot: 3,
      spent_credits: 30,
      held_credits: 0,
      completed_attempts: 2,
      prior_state: 'failed',
      prior_held_reservation: false,
    });
    assert.throws(() => projectBudgetSnapshot(db, {
      tenantId: 'tenant-b', userId: 'user-b', versionId: own.versionId, shotId: own.shotId,
    }), (error) => error.code === 'REDRAW_GENERATION_SCOPE_NOT_FOUND');
  } finally {
    db.close();
  }
});
