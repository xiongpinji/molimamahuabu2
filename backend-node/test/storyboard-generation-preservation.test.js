const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const aiClient = require('../src/services/aiClient');
const storyboards = require('../src/services/episodeStoryboardService');
const taskService = require('../src/services/taskService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

async function waitForTask(db, taskId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = taskService.getTask(db, taskId);
    if (task && ['completed', 'failed'].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`任务未结束: ${taskId}`);
}

function setupStoryboardFailureTest() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const dramaId = Number(db.prepare(
    `INSERT INTO dramas (title, style, status, metadata, created_at, updated_at)
     VALUES ('失败恢复测试', 'realistic', 'draft', '{}', ?, ?)`,
  ).run(now, now).lastInsertRowid);
  const episodeId = Number(db.prepare(
    `INSERT INTO episodes
      (drama_id, episode_number, title, script_content, created_at, updated_at)
     VALUES (?, 1, '第一集', '母女在雨后的庭院重逢。', ?, ?)`,
  ).run(dramaId, now, now).lastInsertRowid);
  const oldStoryboardId = Number(db.prepare(
    `INSERT INTO storyboards
      (episode_id, storyboard_number, title, duration, status, created_at, updated_at)
     VALUES (?, 1, '原有分镜', 6, 'completed', ?, ?)`,
  ).run(episodeId, now, now).lastInsertRowid);
  return { db, episodeId, oldStoryboardId };
}

function assertOnlyOriginalStoryboardActive(db, episodeId, oldStoryboardId) {
  const oldStoryboard = db.prepare(
    'SELECT id, title, deleted_at FROM storyboards WHERE id = ?',
  ).get(oldStoryboardId);
  assert.equal(oldStoryboard.title, '原有分镜');
  assert.equal(oldStoryboard.deleted_at, null);
  assert.equal(
    db.prepare(
      'SELECT COUNT(*) AS count FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL',
    ).get(episodeId).count,
    1,
  );
}

function startStoryboardGeneration(db, episodeId) {
  return storyboards.generateStoryboard(
    db,
    log,
    episodeId,
    undefined,
    'realistic',
    6,
    60,
    '16:9',
    false,
    false,
    { billingEnabled: false },
  );
}

function incrementalStoryboardText() {
  const storyboard = {
    shot_number: 1,
    title: '临时分镜',
    description: '母女在雨后的庭院重逢。',
    location: '庭院',
    time: '清晨',
    duration: 6,
    dialogue: '',
    action: '两人相望',
    atmosphere: '克制',
    image_prompt: '雨后的庭院，母女相望',
    video_prompt: '中景，缓慢推进',
    characters: [],
  };
  return `[${JSON.stringify(storyboard)},${' '.repeat(500)}`;
}

test('分镜 AI 在首轮返回空内容时保留当前有效分镜', async (t) => {
  const { db, episodeId, oldStoryboardId } = setupStoryboardFailureTest();
  const originalGenerateText = aiClient.generateText;
  aiClient.generateText = async () => {
    throw new Error('AI 返回内容为空');
  };
  t.after(() => {
    aiClient.generateText = originalGenerateText;
    db.close();
  });

  const created = startStoryboardGeneration(db, episodeId);
  const task = await waitForTask(db, created.task_id);

  assert.equal(task.status, 'failed');
  assert.match(task.error, /AI 返回内容为空/);
  assertOnlyOriginalStoryboardActive(db, episodeId, oldStoryboardId);
});

test('分镜最终解析失败时丢弃增量结果并恢复原有分镜', async (t) => {
  const { db, episodeId, oldStoryboardId } = setupStoryboardFailureTest();
  const originalGenerateText = aiClient.generateText;
  aiClient.generateText = async (_db, _log, _type, _prompt, _system, options) => {
    options.streamCallback(incrementalStoryboardText());
    return 'not valid json';
  };
  t.after(() => {
    aiClient.generateText = originalGenerateText;
    db.close();
  });

  const created = startStoryboardGeneration(db, episodeId);
  const task = await waitForTask(db, created.task_id);

  assert.equal(task.status, 'failed');
  assert.match(task.error, /解析分镜头结果失败/);
  assertOnlyOriginalStoryboardActive(db, episodeId, oldStoryboardId);
});

test('分镜流式连接中断时丢弃增量结果并恢复原有分镜', async (t) => {
  const { db, episodeId, oldStoryboardId } = setupStoryboardFailureTest();
  const originalGenerateText = aiClient.generateText;
  aiClient.generateText = async (_db, _log, _type, _prompt, _system, options) => {
    options.streamCallback(incrementalStoryboardText());
    throw new Error('连接重置');
  };
  t.after(() => {
    aiClient.generateText = originalGenerateText;
    db.close();
  });

  const created = startStoryboardGeneration(db, episodeId);
  const task = await waitForTask(db, created.task_id);

  assert.equal(task.status, 'failed');
  assert.match(task.error, /连接重置/);
  assertOnlyOriginalStoryboardActive(db, episodeId, oldStoryboardId);
});
