const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const taskService = require('../src/services/taskService');

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
