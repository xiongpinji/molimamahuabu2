const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const aiClient = require('../src/services/aiClient');
const imageService = require('../src/services/imageService');
const episodeStoryboardService = require('../src/services/episodeStoryboardService');
const taskService = require('../src/services/taskService');
const storyboardRoutes = require('../src/routes/storyboards');
const { setupRouter } = require('../src/routes');
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

function setupAssetRematchTest() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const deletedAt = new Date(Date.now() - 60_000).toISOString();
  const dramaId = Number(db.prepare(
    `INSERT INTO dramas (title, style, status, metadata, created_at, updated_at)
     VALUES ('分镜资产匹配测试', 'realistic', 'draft', '{}', ?, ?)`,
  ).run(now, now).lastInsertRowid);
  const episodeId = Number(db.prepare(
    `INSERT INTO episodes
      (drama_id, episode_number, title, script_content, created_at, updated_at)
     VALUES (?, 1, '第一集', '林夏和小狐狸在雨后森林寻找旧地图。', ?, ?)`,
  ).run(dramaId, now, now).lastInsertRowid);

  const addCharacter = db.prepare(
    `INSERT INTO characters (drama_id, name, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const staleLinXiaId = Number(addCharacter.run(dramaId, '林夏', now, now, deletedAt).lastInsertRowid);
  const linXiaId = Number(addCharacter.run(dramaId, '林夏', now, now, null).lastInsertRowid);
  const foxId = Number(addCharacter.run(dramaId, '小狐狸', now, now, null).lastInsertRowid);
  const manualCharacterId = Number(addCharacter.run(dramaId, '摄影师', now, now, null).lastInsertRowid);

  const addScene = db.prepare(
    `INSERT INTO scenes (drama_id, location, time, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const staleSceneId = Number(
    addScene.run(dramaId, '雨后的原始森林泥泞小路', '白天，雨后', now, now, deletedAt).lastInsertRowid,
  );
  const sceneId = Number(
    addScene.run(dramaId, '雨后的原始森林泥泞小路', '白天，雨后', now, now, null).lastInsertRowid,
  );

  const addProp = db.prepare(
    `INSERT INTO props (drama_id, name, type, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const staleMapId = Number(addProp.run(dramaId, '泛黄旧地图', '线索', now, now, deletedAt).lastInsertRowid);
  const mapId = Number(addProp.run(dramaId, '泛黄旧地图', '线索', now, now, null).lastInsertRowid);
  const phoneId = Number(addProp.run(dramaId, '低电量手机', '通信', now, now, null).lastInsertRowid);
  const manualPropId = Number(addProp.run(dramaId, '备用电池', '工具', now, now, null).lastInsertRowid);

  const storyboardId = Number(db.prepare(
    `INSERT INTO storyboards
      (episode_id, scene_id, storyboard_number, title, description, location, time,
       dialogue, action, image_prompt, characters, status, created_at, updated_at)
     VALUES (?, ?, 1, '泥路独行', '林夏与小狐狸穿过森林。',
       '雨后的原始森林泥泞小路，巨树和蕨类夹出狭窄通道', '白天，雨后',
       '林夏：“手机只剩3%了。”', '小狐狸叼起泛黄旧地图，林夏举起低电量手机。',
       '林夏、小狐狸、泛黄旧地图、低电量手机，雨后的原始森林泥泞小路',
       ?, 'pending', ?, ?)`,
  ).run(
    episodeId,
    staleSceneId,
    JSON.stringify([staleLinXiaId, manualCharacterId]),
    now,
    now,
  ).lastInsertRowid);
  db.prepare('INSERT INTO storyboard_props (storyboard_id, prop_id) VALUES (?, ?)').run(storyboardId, staleMapId);
  db.prepare('INSERT INTO storyboard_props (storyboard_id, prop_id) VALUES (?, ?)').run(storyboardId, manualPropId);

  return {
    db,
    episodeId,
    storyboardId,
    staleLinXiaId,
    linXiaId,
    foxId,
    manualCharacterId,
    staleSceneId,
    sceneId,
    staleMapId,
    mapId,
    phoneId,
    manualPropId,
  };
}

test('统一匹配会迁移失效角色、场景和物品，并保留仍有效的人工选择', (t) => {
  const fixture = setupAssetRematchTest();
  const {
    db,
    storyboardId,
    linXiaId,
    foxId,
    manualCharacterId,
    sceneId,
    mapId,
    phoneId,
    manualPropId,
  } = fixture;
  t.after(() => db.close());

  imageService.syncStoryboardCharacters(db, log, storyboardId);

  const row = db.prepare(
    'SELECT scene_id, characters FROM storyboards WHERE id = ?',
  ).get(storyboardId);
  const characterIds = JSON.parse(row.characters).map((item) =>
    Number(typeof item === 'object' && item != null ? item.id : item),
  );
  const propIds = db.prepare(
    'SELECT prop_id FROM storyboard_props WHERE storyboard_id = ? ORDER BY prop_id',
  ).all(storyboardId).map((item) => Number(item.prop_id));

  assert.deepEqual(characterIds, [linXiaId, manualCharacterId, foxId]);
  assert.equal(Number(row.scene_id), sceneId);
  assert.deepEqual(
    propIds,
    [mapId, phoneId, manualPropId].sort((a, b) => a - b),
  );
});

test('统一匹配兼容 AI 把角色名称写入 characters 而不是角色 ID', (t) => {
  const { db, storyboardId, linXiaId } = setupAssetRematchTest();
  t.after(() => db.close());
  db.prepare(
    `UPDATE storyboards
     SET characters = '["林夏"]', title = '建立镜头', description = '',
         dialogue = '', action = '', result = '', image_prompt = '', video_prompt = ''
     WHERE id = ?`,
  ).run(storyboardId);

  imageService.syncStoryboardCharacters(db, log, storyboardId);

  const row = db.prepare('SELECT characters FROM storyboards WHERE id = ?').get(storyboardId);
  assert.deepEqual(JSON.parse(row.characters).map(Number), [linXiaId]);
});

test('分镜轻量刷新返回物品关联，避免生成轮询期间把已匹配物品清空', (t) => {
  const {
    db,
    episodeId,
    storyboardId,
    staleMapId,
    manualPropId,
  } = setupAssetRematchTest();
  t.after(() => db.close());

  const storyboards = episodeStoryboardService.getStoryboardsForEpisode(db, episodeId);
  const row = storyboards.find((item) => Number(item.id) === storyboardId);

  assert.deepEqual(
    row.prop_ids.map(Number).sort((a, b) => a - b),
    [staleMapId, manualPropId].sort((a, b) => a - b),
  );
});

test('分镜没有场景线索时不会仅凭空时间文本误选场景', (t) => {
  const { db, storyboardId } = setupAssetRematchTest();
  t.after(() => db.close());
  db.prepare(
    `UPDATE storyboards
     SET scene_id = NULL, title = '', description = '', location = '', time = '',
         dialogue = '', action = '', result = '', image_prompt = '', video_prompt = ''
     WHERE id = ?`,
  ).run(storyboardId);

  imageService.syncStoryboardCharacters(db, log, storyboardId);

  const row = db.prepare('SELECT scene_id FROM storyboards WHERE id = ?').get(storyboardId);
  assert.equal(row.scene_id, null);
});

test('注册当前集强制匹配分镜资产接口', (t) => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  t.after(() => db.close());

  const router = setupRouter({}, db, log);
  const routes = new Set(router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods)
      .map((method) => `${method.toUpperCase()} ${layer.route.path}`)));

  assert.equal(
    routes.has('POST /episodes/:episode_id/storyboards/rematch-assets'),
    true,
  );
});

test('强制匹配接口返回当前集的匹配汇总', (t) => {
  const { db, episodeId } = setupAssetRematchTest();
  t.after(() => db.close());
  const handler = storyboardRoutes(db, log).episodeStoryboardsRematchAssets;
  const res = {
    statusCode: null,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };

  handler({ params: { episode_id: String(episodeId) } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.success, true);
  assert.equal(res.payload.data.total, 1);
  assert.equal(res.payload.data.updated, 1);
  assert.equal(res.payload.data.character_links, 3);
  assert.equal(res.payload.data.scene_links, 1);
  assert.equal(res.payload.data.prop_links, 3);
});

test('AI 生成分镜完成后自动迁移失效关联并补齐文本命中的资产', async (t) => {
  const {
    db,
    episodeId,
    staleLinXiaId,
    linXiaId,
    foxId,
    sceneId,
    mapId,
    phoneId,
  } = setupAssetRematchTest();
  const originalGenerateText = aiClient.generateText;
  t.after(() => {
    aiClient.generateText = originalGenerateText;
    db.close();
  });
  aiClient.generateText = async () => JSON.stringify([{
    shot_number: 1,
    title: '泥路寻图',
    description: '林夏和小狐狸在雨后的原始森林泥泞小路寻找线索。',
    location: '雨后的原始森林泥泞小路',
    time: '白天，雨后',
    duration: 6,
    dialogue: '林夏：“手机快没电了。”',
    action: '小狐狸叼起泛黄旧地图，林夏查看低电量手机。',
    image_prompt: '林夏、小狐狸、泛黄旧地图、低电量手机',
    characters: [staleLinXiaId],
  }]);

  const started = episodeStoryboardService.generateStoryboard(
    db,
    log,
    episodeId,
    'test-chat-model',
    'realistic',
    1,
    6,
    '16:9',
    false,
    false,
    { billingEnabled: false },
  );
  const task = await waitForTask(db, started.task_id);

  assert.equal(task.status, 'completed', task.error);
  const row = db.prepare(
    `SELECT id, scene_id, characters FROM storyboards
     WHERE episode_id = ? AND deleted_at IS NULL`,
  ).get(episodeId);
  const characterIds = JSON.parse(row.characters).map(Number);
  const propIds = db.prepare(
    'SELECT prop_id FROM storyboard_props WHERE storyboard_id = ? ORDER BY prop_id',
  ).all(row.id).map((item) => Number(item.prop_id));
  assert.deepEqual(characterIds, [linXiaId, foxId]);
  assert.equal(Number(row.scene_id), sceneId);
  assert.deepEqual(propIds, [mapId, phoneId].sort((a, b) => a - b));
});
