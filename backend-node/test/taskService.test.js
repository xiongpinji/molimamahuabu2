const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const aiConfigService = require('../src/services/aiConfigService');
const creditLedgerService = require('../src/services/creditLedgerService');
const providerRouteStability = require('../src/services/providerRouteStabilityService');
const taskService = require('../src/services/taskService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE async_tasks (
      id TEXT PRIMARY KEY,
      type TEXT,
      status TEXT,
      progress INTEGER DEFAULT 0,
      message TEXT,
      error TEXT,
      result TEXT,
      resource_id TEXT,
      created_at TEXT,
      updated_at TEXT,
      completed_at TEXT,
      deleted_at TEXT
    );
  `);
  return db;
}

describe('taskService.failOrphanedAsyncTasksOnStartup', () => {
  it('marks a submitting provider route needs_attention without failing or refunding it', () => {
    const db = new Database(':memory:');
    runMigrationsAndEnsure(db);
    const log = { info() {}, warn() {}, error() {} };
    const config = aiConfigService.createConfig(db, log, {
      service_type: 'image',
      provider: 'private-relay',
      name: 'private-relay',
      base_url: 'https://provider.invalid/v1',
      api_key: 'test-key',
      model: ['upstream-image'],
      default_model: 'upstream-image',
      logical_model_id: 'logical-image',
      is_default: true,
    });
    db.prepare("UPDATE ai_service_configs SET verification_status = 'verified' WHERE id = ?")
      .run(config.id);
    creditLedgerService.setTenantAccountBalance(db, 'tenant-a', 20);
    const reservation = creditLedgerService.reserve(db, {
      tenantId: 'tenant-a', actorUserId: 'user-a', userId: 'user-a',
      operationKey: 'startup-unknown', amount: 5, model: 'logical-image',
      resourceType: 'image_generation', resourceId: '901',
    });
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO async_tasks
      (id, type, status, progress, message, resource_id, credit_reservation_id,
       tenant_id, user_id, created_at, updated_at)
      VALUES ('task-startup-unknown', 'image_generation', 'processing', 10, '', '901', ?,
        'tenant-a', 'user-a', ?, ?)`).run(reservation.id, now, now);
    const route = providerRouteStability.createOrGetRouteRequest(db, {
      id: 'route-startup-unknown',
      idempotencyKey: 'tenant-a:image:901',
      serviceType: 'image', businessType: 'image_generation', businessId: '901',
      tenantId: 'tenant-a', userId: 'user-a', logicalModelId: 'logical-image',
      userPriceSnapshot: { model: 'logical-image', credits: 5 },
      candidateConfigIds: [config.id], creditReservationId: reservation.id,
    });
    providerRouteStability.startAttempt(db, {
      requestId: route.id, configId: config.id, provider: config.provider,
      upstreamModel: 'upstream-image',
    });

    const count = taskService.failOrphanedAsyncTasksOnStartup(db, log);

    assert.equal(count, 0);
    assert.equal(taskService.getTask(db, 'task-startup-unknown').status, 'needs_attention');
    assert.match(taskService.getTask(db, 'task-startup-unknown').message, /结果未知/);
    assert.equal(db.prepare('SELECT state FROM generation_route_requests').get().state,
      'needs_attention');
    assert.equal(creditLedgerService.getReservation(db, reservation.id).status, 'held');
    db.close();
  });

  it('marks pending and processing tasks as failed on startup', () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO async_tasks (id, type, status, progress, message, resource_id, created_at, updated_at)
       VALUES (?, ?, ?, 0, '', ?, ?, ?)`
    ).run('task-pending', 'background_extraction', 'pending', '42', now, now);
    db.prepare(
      `INSERT INTO async_tasks (id, type, status, progress, message, resource_id, created_at, updated_at)
       VALUES (?, ?, ?, 0, '', ?, ?, ?)`
    ).run('task-processing', 'background_extraction', 'processing', '42', now, now);
    db.prepare(
      `INSERT INTO async_tasks (id, type, status, progress, message, resource_id, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, 100, '', ?, ?, ?, ?)`
    ).run('task-done', 'background_extraction', 'completed', '42', now, now, now);

    const count = taskService.failOrphanedAsyncTasksOnStartup(db, { warn() {}, info() {} });
    assert.equal(count, 2);

    const pending = taskService.getTask(db, 'task-pending');
    const processing = taskService.getTask(db, 'task-processing');
    const done = taskService.getTask(db, 'task-done');

    assert.equal(pending.status, 'failed');
    assert.equal(processing.status, 'failed');
    assert.equal(pending.error, taskService.ORPHAN_ASYNC_TASK_MSG);
    assert.equal(done.status, 'completed');
  });

  it('reconciles a script analysis project left analyzing after its task failed', () => {
    const db = createTestDb();
    db.exec(`
      CREATE TABLE script_analysis_projects (
        id INTEGER PRIMARY KEY,
        status TEXT NOT NULL,
        source_script TEXT NOT NULL,
        current_version INTEGER NOT NULL,
        review_json TEXT,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
    `);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO async_tasks (
        id, type, status, progress, message, error, resource_id,
        created_at, updated_at, completed_at
      ) VALUES (?, 'script_analysis', 'failed', 0, '', ?, ?, ?, ?, ?)`
    ).run(
      'task-script-analysis-failed',
      taskService.ORPHAN_ASYNC_TASK_MSG,
      'script-analysis:42',
      now,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO script_analysis_projects (
        id, status, source_script, current_version, review_json, updated_at
      ) VALUES (42, 'analyzing', '原始剧本文本', 3, NULL, ?)`
    ).run(now);

    const count = taskService.failOrphanedAsyncTasksOnStartup(db, { warn() {}, info() {} });

    assert.equal(count, 0);
    const project = db.prepare(
      `SELECT status, source_script, current_version, review_json, updated_at
       FROM script_analysis_projects WHERE id = 42`
    ).get();
    assert.equal(project.status, 'failed');
    assert.equal(project.source_script, '原始剧本文本');
    assert.equal(project.current_version, 3);
    assert.deepEqual(JSON.parse(project.review_json), {
      status: 'failed',
      issues: [taskService.ORPHAN_ASYNC_TASK_MSG],
    });
    assert.ok(new Date(project.updated_at).getTime() >= new Date(now).getTime());
  });

  it('restores a rejected script analysis project when its revision task is orphaned', () => {
    const db = createTestDb();
    db.exec(`
      CREATE TABLE script_analysis_projects (
        id INTEGER PRIMARY KEY,
        status TEXT NOT NULL,
        source_script TEXT NOT NULL,
        current_version INTEGER NOT NULL,
        review_json TEXT,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
    `);
    const now = new Date().toISOString();
    const review = { status: 'rejected', note: '补充人物描述' };
    db.prepare(
      `INSERT INTO async_tasks (
        id, type, status, progress, message, resource_id, created_at, updated_at
      ) VALUES (?, 'script_analysis_revision', 'processing', 30, '', ?, ?, ?)`
    ).run('task-script-analysis-revision', 'script-analysis:42', now, now);
    db.prepare(
      `INSERT INTO script_analysis_projects (
        id, status, source_script, current_version, review_json, updated_at
      ) VALUES (42, 'analyzing', '原始剧本文本', 3, ?, ?)`
    ).run(JSON.stringify(review), now);

    const count = taskService.failOrphanedAsyncTasksOnStartup(db, { warn() {}, info() {} });

    assert.equal(count, 1);
    assert.equal(taskService.getTask(db, 'task-script-analysis-revision').status, 'failed');
    const project = db.prepare(
      `SELECT status, source_script, current_version, review_json
       FROM script_analysis_projects WHERE id = 42`
    ).get();
    assert.equal(project.status, 'rejected');
    assert.equal(project.source_script, '原始剧本文本');
    assert.equal(project.current_version, 3);
    assert.deepEqual(JSON.parse(project.review_json), review);
  });

  it('also marks the linked image generation as failed on startup', () => {
    const db = createTestDb();
    db.exec(`
      CREATE TABLE image_generations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT,
        status TEXT,
        error_msg TEXT,
        updated_at TEXT,
        deleted_at TEXT
      );
    `);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO async_tasks (id, type, status, progress, message, resource_id, created_at, updated_at)
       VALUES (?, 'image_generation', 'processing', 10, '', ?, ?, ?)`
    ).run('task-orphan-image', '42', now, now);
    db.prepare(
      `INSERT INTO image_generations (task_id, status, updated_at)
       VALUES (?, 'processing', ?)`
    ).run('task-orphan-image', now);

    const count = taskService.failOrphanedAsyncTasksOnStartup(db, { warn() {}, info() {} });

    assert.equal(count, 1);
    const task = taskService.getTask(db, 'task-orphan-image');
    const generation = db.prepare(
      'SELECT status, error_msg, updated_at FROM image_generations WHERE task_id = ?'
    ).get('task-orphan-image');
    assert.equal(task.status, 'failed');
    assert.equal(task.error, taskService.ORPHAN_ASYNC_TASK_MSG);
    assert.equal(generation.status, 'failed');
    assert.equal(generation.error_msg, taskService.ORPHAN_ASYNC_TASK_MSG);
    assert.ok(new Date(generation.updated_at).getTime() >= new Date(now).getTime());
  });

  it('keeps a video task processing when provider_task_id allows polling to resume', () => {
    const db = createTestDb();
    db.exec(`
      CREATE TABLE video_generations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT,
        status TEXT,
        provider_task_id TEXT,
        deleted_at TEXT
      );
    `);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO async_tasks (id, type, status, progress, message, resource_id, created_at, updated_at)
       VALUES (?, 'video_generation', 'processing', 90, '供应商处理中', ?, ?, ?)`
    ).run('task-resumable-video', '42', now, now);
    db.prepare(
      `INSERT INTO video_generations (task_id, status, provider_task_id)
       VALUES (?, 'processing', ?)`
    ).run('task-resumable-video', 'provider-task-83047');

    const count = taskService.failOrphanedAsyncTasksOnStartup(db, { warn() {}, info() {} });

    assert.equal(count, 0);
    const task = taskService.getTask(db, 'task-resumable-video');
    assert.equal(task.status, 'processing');
    assert.equal(task.error, null);
  });

  it('fails a redraw analysis task without provider_task_id on startup', () => {
    const db = createTestDb();
    db.exec('ALTER TABLE async_tasks ADD COLUMN provider_task_id TEXT;');
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO async_tasks
        (id, type, status, progress, message, resource_id, created_at, updated_at)
       VALUES (?, 'redraw_analysis', 'processing', 90, '供应商处理中', ?, ?, ?)`
    ).run('task-interrupted-redraw', 'work-2', now, now);

    const count = taskService.failOrphanedAsyncTasksOnStartup(db, { warn() {}, info() {} });

    assert.equal(count, 1);
    const task = taskService.getTask(db, 'task-interrupted-redraw');
    assert.equal(task.status, 'failed');
    assert.equal(task.error, taskService.ORPHAN_ASYNC_TASK_MSG);
  });

  it('skips redraw dialogue tasks in generic orphan cleanup', () => {
    const db = createTestDb();
    db.exec(`
      ALTER TABLE async_tasks ADD COLUMN tenant_id TEXT;
      ALTER TABLE async_tasks ADD COLUMN user_id TEXT;
      ALTER TABLE async_tasks ADD COLUMN credit_reservation_id TEXT;
    `);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO async_tasks
        (id, type, status, progress, message, resource_id, tenant_id, user_id, credit_reservation_id, created_at, updated_at)
       VALUES (?, 'redraw_dialogue', 'processing', 50, 'running', ?, 'tenant-a', 'user-a', 'reservation-held', ?, ?)`
    ).run('task-redraw-dialogue', 'redraw_dialogue:12:hash', now, now);

    const count = taskService.failOrphanedAsyncTasksOnStartup(db, { warn() {}, info() {} });

    assert.equal(count, 0);
    const task = taskService.getTask(db, 'task-redraw-dialogue');
    assert.equal(task.status, 'processing');
    assert.equal(task.error, null);
  });

  it('keeps a redraw analysis task processing when analyzing work has provider_task_id', () => {
    const db = createTestDb();
    db.exec(`
      ALTER TABLE async_tasks ADD COLUMN provider_task_id TEXT;
      CREATE TABLE redraw_works (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        status TEXT,
        provider_task_id TEXT
      );
    `);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO async_tasks
        (id, type, status, progress, message, resource_id, provider_task_id, created_at, updated_at)
       VALUES (?, 'redraw_analysis', 'processing', 90, '供应商处理中', ?, ?, ?, ?)`
    ).run('task-resumable-redraw', 'work-redraw', 'provider-redraw', now, now);
    db.prepare(
      `INSERT INTO redraw_works (id, task_id, status, provider_task_id)
       VALUES (?, ?, 'analyzing', ?)`
    ).run('work-redraw', 'task-resumable-redraw', 'provider-redraw');

    const count = taskService.failOrphanedAsyncTasksOnStartup(db, { warn() {}, info() {} });

    assert.equal(count, 0);
    const task = taskService.getTask(db, 'task-resumable-redraw');
    assert.equal(task.status, 'processing');
    assert.equal(task.error, null);
  });

  it('fails a provider-backed redraw analysis orphan when work is no longer analyzing', () => {
    const db = createTestDb();
    db.exec(`
      ALTER TABLE async_tasks ADD COLUMN provider_task_id TEXT;
      CREATE TABLE redraw_works (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        status TEXT,
        provider_task_id TEXT
      );
    `);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO async_tasks
        (id, type, status, progress, message, resource_id, provider_task_id, created_at, updated_at)
       VALUES (?, 'redraw_analysis', 'processing', 90, '供应商处理中', ?, ?, ?, ?)`
    ).run('task-stale-redraw', 'work-redraw', 'provider-redraw', now, now);
    db.prepare(
      `INSERT INTO redraw_works (id, task_id, status, provider_task_id)
       VALUES (?, ?, 'failed', ?)`
    ).run('work-redraw', 'task-stale-redraw', 'provider-redraw');

    const count = taskService.failOrphanedAsyncTasksOnStartup(db, { warn() {}, info() {} });

    assert.equal(count, 1);
    const task = taskService.getTask(db, 'task-stale-redraw');
    assert.equal(task.status, 'failed');
    assert.equal(task.error, taskService.ORPHAN_ASYNC_TASK_MSG);
  });

  it('keeps a processing task alive while a long operation is running', async () => {
    const db = createTestDb();
    const now = new Date(Date.now() - 60_000).toISOString();
    db.prepare(
      `INSERT INTO async_tasks (id, type, status, progress, message, resource_id, created_at, updated_at)
       VALUES (?, ?, 'pending', 0, '', ?, ?, ?)`
    ).run('task-image', 'image_generation', '42', now, now);

    let release;
    const operation = new Promise((resolve) => { release = resolve; });
    const running = taskService.withTaskHeartbeat(
      db,
      'task-image',
      '正在等待图片生成服务...',
      () => operation,
      10
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    const active = taskService.getTask(db, 'task-image');
    assert.equal(active.status, 'processing');
    assert.equal(active.message, '正在等待图片生成服务...');
    assert.ok(new Date(active.updated_at).getTime() > new Date(now).getTime());

    release('done');
    assert.equal(await running, 'done');
  });

  it('also marks the linked video merge and episode as failed on startup', () => {
    const db = createTestDb();
    db.exec(`
      CREATE TABLE video_merges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        episode_id INTEGER,
        task_id TEXT,
        status TEXT,
        error_msg TEXT,
        completed_at TEXT,
        deleted_at TEXT
      );
      CREATE TABLE episodes (
        id INTEGER PRIMARY KEY,
        status TEXT,
        updated_at TEXT
      );
    `);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO async_tasks (id, type, status, progress, message, resource_id, created_at, updated_at)
       VALUES (?, 'video_merge', 'processing', 10, '', ?, ?, ?)`
    ).run('task-orphan-merge', '28', now, now);
    db.prepare(
      `INSERT INTO video_merges (episode_id, task_id, status)
       VALUES (28, 'task-orphan-merge', 'processing')`
    ).run();
    db.prepare('INSERT INTO episodes (id, status, updated_at) VALUES (28, ?, ?)').run('processing', now);

    const count = taskService.failOrphanedAsyncTasksOnStartup(db, { warn() {}, info() {} });

    assert.equal(count, 1);
    assert.equal(taskService.getTask(db, 'task-orphan-merge').status, 'failed');
    const merge = db.prepare('SELECT status, error_msg FROM video_merges WHERE task_id = ?').get('task-orphan-merge');
    const episode = db.prepare('SELECT status FROM episodes WHERE id = ?').get(28);
    assert.equal(merge.status, 'failed');
    assert.equal(merge.error_msg, taskService.ORPHAN_ASYNC_TASK_MSG);
    assert.equal(episode.status, 'failed');
  });

  it('does not revive a task cancelled during a long operation', async () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO async_tasks (id, type, status, progress, message, resource_id, created_at, updated_at)
       VALUES (?, ?, 'pending', 0, '', ?, ?, ?)`
    ).run('task-cancelled-image', 'image_generation', '43', now, now);

    let release;
    const operation = new Promise((resolve) => { release = resolve; });
    const running = taskService.withTaskHeartbeat(
      db,
      'task-cancelled-image',
      '正在等待图片生成服务...',
      () => operation,
      10
    );

    taskService.cancelTask(db, { warn() {}, info() {} }, 'task-cancelled-image');
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(taskService.getTask(db, 'task-cancelled-image').status, 'failed');

    release('done');
    assert.equal(await running, 'done');
  });

  it('cancelTask marks active task as failed', () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO async_tasks (id, type, status, progress, message, resource_id, created_at, updated_at)
       VALUES (?, ?, ?, 0, '', ?, ?, ?)`
    ).run('task-active', 'background_extraction', 'processing', '42', now, now);

    const result = taskService.cancelTask(db, { info() {} }, 'task-active');
    assert.equal(result.ok, true);
    const task = taskService.getTask(db, 'task-active');
    assert.equal(task.status, 'failed');
    assert.equal(task.error, taskService.USER_CANCEL_TASK_MSG);
  });
});
