const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const aiClient = require('../src/services/aiClient');
const storyService = require('../src/services/storyGenerationService');
const taskService = require('../src/services/taskService');
const credits = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {} };

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  db.prepare(`INSERT INTO dramas (title, style, status, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?)`).run(
    '测试项目', 'realistic', new Date().toISOString(), new Date().toISOString()
  );
  credits.setAccountBalance(db, 'user-1', 20);
  credits.setAccountBalance(db, 'user-2', 20);
  prices.set(db, 'GPT-5.5', 5);
  return db;
}

async function waitForTask(db, taskId) {
  for (let i = 0; i < 50; i += 1) {
    const task = taskService.getTask(db, taskId);
    if (task && ['completed', 'failed'].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`任务未在预期时间内结束: ${taskId}`);
}

test('GPT-5.5 故事任务按用户隔离幂等预扣并在成功后结算', async (t) => {
  const db = setup();
  const original = aiClient.generateText;
  t.after(() => { aiClient.generateText = original; db.close(); });
  aiClient.generateText = async () => '[{"episode":1,"title":"第一集","content":"测试剧本内容"}]';

  const first = storyService.startStoryGeneration(db, log, { drama_id: 1, premise: '母女在夏日相遇' }, {
    billingEnabled: true, userId: 'user-1',
  });
  const sameUser = storyService.startStoryGeneration(db, log, { drama_id: 1, premise: '母女在夏日相遇' }, {
    billingEnabled: true, userId: 'user-1',
  });
  const otherUser = storyService.startStoryGeneration(db, log, { drama_id: 1, premise: '母女在夏日相遇' }, {
    billingEnabled: true, userId: 'user-2',
  });

  assert.equal(sameUser, first);
  assert.notEqual(otherUser, first);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage_reservations').get().count, 2);
  assert.equal(credits.getAccount(db, 'user-1').held, 5);
  assert.equal(credits.getAccount(db, 'user-2').held, 5);
  assert.equal((await waitForTask(db, first)).status, 'completed');
  assert.equal((await waitForTask(db, otherUser)).status, 'completed');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM usage_reservations WHERE status = 'confirmed'").get().count, 2);
  assert.equal(credits.getAccount(db, 'user-1').spent, 5);
  assert.equal(credits.getAccount(db, 'user-2').spent, 5);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM episodes WHERE drama_id = 1').get().count, 1);
});

test('GPT-5.5 同步生成供应商失败时退回预扣积分', async (t) => {
  const db = setup();
  const original = aiClient.generateText;
  t.after(() => { aiClient.generateText = original; db.close(); });
  aiClient.generateText = async () => { throw new Error('供应商明确失败'); };

  await assert.rejects(storyService.generateStory(db, log, {
    premise: '测试失败路径', billingEnabled: true, userId: 'user-1', model: 'GPT-5.5',
    billingOperationKey: 'text-failure-test',
  }), /供应商明确失败/);
  const reservation = db.prepare('SELECT status, reason FROM usage_reservations WHERE operation_key = ?').get('text-failure-test');
  assert.equal(reservation.status, 'refunded');
  assert.equal(credits.getAccount(db, 'user-1').available, 20);
  assert.equal(credits.getAccount(db, 'user-1').held, 0);
});

test('重启遗留任务退款，但用户取消在底层调用结束前保持冻结', () => {
  const db = setup();
  const now = new Date().toISOString();
  const held = credits.reserve(db, {
    userId: 'user-1', operationKey: 'orphan-test', model: 'GPT-5.5',
    resourceType: 'text', resourceId: 'orphan-task', amount: 5,
  });
  db.prepare(`INSERT INTO async_tasks
    (id, type, status, progress, message, resource_id, user_id, model, credit_reservation_id, created_at, updated_at)
    VALUES (?, 'story_generation', 'processing', 10, '', ?, ?, ?, ?, ?, ?)`).run(
    'orphan-task', '1', 'user-1', 'GPT-5.5', held.id, now, now
  );
  assert.equal(taskService.failOrphanedAsyncTasksOnStartup(db, log), 1);
  assert.equal(credits.getReservation(db, held.id).status, 'refunded');

  const heldCancel = credits.reserve(db, {
    userId: 'user-1', operationKey: 'cancel-test', model: 'GPT-5.5',
    resourceType: 'text', resourceId: 'cancel-task', amount: 5,
  });
  db.prepare(`INSERT INTO async_tasks
    (id, type, status, progress, message, resource_id, user_id, model, credit_reservation_id, created_at, updated_at)
    VALUES (?, 'story_generation', 'processing', 10, '', ?, ?, ?, ?, ?, ?)`).run(
    'cancel-task', '1', 'user-1', 'GPT-5.5', heldCancel.id, now, now
  );
  assert.equal(taskService.cancelTask(db, log, 'cancel-task').ok, true);
  assert.equal(credits.getReservation(db, heldCancel.id).status, 'held');
  assert.equal(credits.getAccount(db, 'user-1').held, 5);
  db.close();
});
