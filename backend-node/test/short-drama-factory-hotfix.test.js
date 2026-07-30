const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const aiClient = require('../src/services/aiClient');
const aiConfig = require('../src/services/aiConfigService');
const credits = require('../src/services/creditLedgerService');
const imageClient = require('../src/services/imageClient');
const prices = require('../src/services/modelPriceService');
const storyboardService = require('../src/services/episodeStoryboardService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { DEFAULT_LINE3 } = require('../src/services/universalOmniMultiBeatFormat');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

function createDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  return db;
}

async function waitForTask(db, taskId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = db.prepare('SELECT status, error FROM async_tasks WHERE id = ?').get(taskId);
    if (task?.status === 'completed') return task;
    if (task?.status === 'failed') throw new Error(task.error || 'task failed');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('task timeout');
}

test('迁移链为场景单图提示词补齐 polished_prompt_single 字段', () => {
  const db = createDb();
  try {
    const columns = db.prepare('PRAGMA table_info(scenes)').all().map((row) => row.name);
    assert.equal(columns.includes('polished_prompt_single'), true);
  } finally {
    db.close();
  }
});

test('资产生图未显式选择模型时使用默认图片模型完成计费建单', () => {
  const db = createDb();
  try {
    aiConfig.createConfig(db, log, {
      service_type: 'image',
      provider: 'openai',
      name: '非默认 OpenAI 图片模型',
      base_url: 'https://example.invalid/v1',
      api_key: 'test-key',
      model: ['gpt-image-1'],
      default_model: 'gpt-image-1',
      is_default: false,
    });
    aiConfig.createConfig(db, log, {
      service_type: 'image',
      provider: 'dashscope',
      name: '默认图片模型',
      base_url: 'https://example.invalid/v1',
      api_key: 'test-key',
      model: ['gpt-image-2'],
      default_model: 'gpt-image-2',
      is_default: true,
    });
    prices.set(db, 'gpt-image-1', 9);
    prices.set(db, 'gpt-image-2', 18);
    credits.setAccountBalance(db, 'user-1', 100);

    const created = imageClient.createAndGenerateImage(db, log, {
      drama_id: 1,
      character_id: 4,
      image_type: 'character_reference',
      prompt: 'test only',
      provider: 'openai',
      billingEnabled: true,
      userId: 'user-1',
      schedule() {},
    });

    const row = db.prepare(
      'SELECT model, provider, task_id, credit_reservation_id FROM image_generations WHERE id = ?',
    ).get(created.id);
    assert.equal(row.model, 'gpt-image-2');
    assert.equal(row.provider, 'dashscope');
    const task = db.prepare(
      'SELECT model, credit_reservation_id FROM async_tasks WHERE id = ?',
    ).get(row.task_id);
    assert.equal(task.model, 'gpt-image-2');
    assert.equal(task.credit_reservation_id, row.credit_reservation_id);
    assert.deepEqual(
      credits.getAccount(db, 'user-1'),
      { user_id: 'user-1', available: 82, held: 18, spent: 0 },
    );

    const explicit = imageClient.createAndGenerateImage(db, log, {
      drama_id: 1,
      character_id: 5,
      image_type: 'character_reference',
      prompt: 'explicit model test only',
      model: 'gpt-image-2',
      provider: 'openai',
      schedule() {},
    });
    const explicitRow = db.prepare(
      'SELECT model, provider FROM image_generations WHERE id = ?',
    ).get(explicit.id);
    assert.equal(explicitRow.model, 'gpt-image-2');
    assert.equal(explicitRow.provider, 'dashscope');
  } finally {
    db.close();
  }
});

test('全能分镜批量生成使用精简基础请求并在本地补齐多子分镜文本', async (t) => {
  const db = createDb();
  const originalGenerateText = aiClient.generateText;
  t.after(() => {
    aiClient.generateText = originalGenerateText;
    db.close();
  });

  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, style, status, created_at, updated_at)
     VALUES ('热修测试项目', 'realistic', 'draft', ?, ?)`,
  ).run(now, now).lastInsertRowid;
  const episodeId = db.prepare(
    `INSERT INTO episodes (drama_id, episode_number, title, script_content, status, created_at, updated_at)
     VALUES (?, 1, '第一集', '林夏走进雨后的庭院，发现石桌上的旧信。', 'draft', ?, ?)`,
  ).run(dramaId, now, now).lastInsertRowid;

  let capturedSystemPrompt = '';
  aiClient.generateText = async (_db, _log, _type, _userPrompt, systemPrompt) => {
    capturedSystemPrompt = systemPrompt;
    return JSON.stringify([{
      shot_number: 1,
      title: '发现旧信',
      segment_index: 0,
      segment_title: '线索出现',
      location: '雨后庭院',
      time: '清晨',
      shot_type: '中景',
      camera_angle: '平视',
      camera_movement: 'push',
      lighting_style: 'natural',
      depth_of_field: 'medium',
      duration: 10,
      action: '林夏走到石桌前拿起旧信',
      result: '旧信进入画面中心',
      dialogue: '',
      emotion: '疑惑',
      emotion_intensity: 1,
      universal_segment_text: '旧版单行全能提示词',
    }]);
  };

  const task = storyboardService.generateStoryboard(
    db,
    log,
    episodeId,
    'test-chat-model',
    'realistic',
    1,
    10,
    '16:9',
    false,
    true,
    { billingEnabled: false },
  );
  await waitForTask(db, task.task_id);

  assert.doesNotMatch(capturedSystemPrompt, /universal_segment_text/);
  const row = db.prepare(
    'SELECT creation_mode, universal_segment_text FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL',
  ).get(episodeId);
  assert.equal(row.creation_mode, 'universal');
  assert.match(row.universal_segment_text, /^画面风格和类型:/);
  assert.match(row.universal_segment_text, /生成一个由以下2个分镜组成的视频。/);
  assert.equal(row.universal_segment_text.includes(DEFAULT_LINE3), true);
  const seconds = [...row.universal_segment_text.matchAll(/分镜\d+：\s*(\d+)秒:/g)]
    .reduce((sum, match) => sum + Number(match[1]), 0);
  assert.equal(seconds, 10);
});
