const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const aiConfig = require('../src/services/aiConfigService');
const characterLibrary = require('../src/services/characterLibraryService');
const characterRoutes = require('../src/routes/characters');
const credits = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const propRoutes = require('../src/routes/prop');
const propService = require('../src/services/propService');
const sceneRoutes = require('../src/routes/scenes');
const sceneService = require('../src/services/sceneService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {} };

function setup({ withPrice = true } = {}) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, style, status, created_at, updated_at)
     VALUES ('测试项目', 'realistic', 'draft', ?, ?)`,
  ).run(now, now).lastInsertRowid;
  const characterId = db.prepare(
    `INSERT INTO characters (drama_id, name, appearance, created_at, updated_at)
     VALUES (?, '小茉', '黑色长发，粉色外套', ?, ?)`,
  ).run(dramaId, now, now).lastInsertRowid;
  const propId = db.prepare(
    `INSERT INTO props (drama_id, name, description, created_at, updated_at)
     VALUES (?, '木牌', '刻纹木牌', ?, ?)`,
  ).run(dramaId, now, now).lastInsertRowid;
  const scene = sceneService.createScene(db, log, dramaId, {
    location: '雨后庭院',
    time: '清晨',
    prompt: '青石板上有积水。',
  });
  aiConfig.createConfig(db, log, {
    service_type: 'text',
    provider: 'openai',
    name: '测试文本模型',
    base_url: 'https://example.invalid/v1',
    api_key: 'test-key',
    model: ['GPT-5.5'],
    default_model: 'GPT-5.5',
    is_default: true,
  });
  credits.setTenantAccountBalance(db, 'tenant-a', 30);
  if (withPrice) prices.set(db, 'GPT-5.5', 5);
  return { db, characterId, propId, sceneId: scene.id };
}

function capture() {
  const result = {};
  return {
    result,
    res: {
      status(code) { result.status = code; return this; },
      json(body) { result.body = body; return this; },
    },
  };
}

function request(id, body = {}) {
  return {
    params: { id, scene_id: id },
    body: { model: 'GPT-5.5', ...body },
    user: { id: 'user-1' },
    tenant: { id: 'tenant-a' },
  };
}

test('角色提示词生成成功后确认文本模型积分', async (t) => {
  const { db, characterId } = setup();
  const original = characterLibrary.generateCharacterPromptOnly;
  t.after(() => { characterLibrary.generateCharacterPromptOnly = original; db.close(); });
  characterLibrary.generateCharacterPromptOnly = async () => ({
    ok: true,
    polished_prompt: '角色四视图提示词',
  });
  const { res, result } = capture();

  await characterRoutes(db, {}, log, null, { billingEnabled: true })
    .generatePrompt(request(characterId), res);

  assert.equal(result.status, 200);
  const reservation = db.prepare(
    `SELECT * FROM tenant_usage_reservations
     WHERE resource_type = 'character_prompt' AND resource_id = ?`,
  ).get(String(characterId));
  assert.equal(reservation.status, 'confirmed');
  assert.equal(reservation.model, 'GPT-5.5');
});

test('角色提示词模型未定价时返回 503 且不调用服务', async (t) => {
  const { db, characterId } = setup({ withPrice: false });
  const original = characterLibrary.generateCharacterPromptOnly;
  let calls = 0;
  t.after(() => { characterLibrary.generateCharacterPromptOnly = original; db.close(); });
  characterLibrary.generateCharacterPromptOnly = async () => {
    calls += 1;
    return { ok: true, polished_prompt: '不应调用' };
  };
  const { res, result } = capture();

  await characterRoutes(db, {}, log, null, { billingEnabled: true })
    .generatePrompt(request(characterId), res);

  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'MODEL_PRICE_NOT_CONFIGURED');
  assert.equal(calls, 0);
});

test('道具视觉提取失败时退回文本模型预扣积分', async (t) => {
  const { db, propId } = setup();
  const original = propService.extractPropFromImage;
  t.after(() => { propService.extractPropFromImage = original; db.close(); });
  propService.extractPropFromImage = async () => ({ ok: false, error: '供应商明确失败' });
  const { res, result } = capture();

  await propRoutes(db, log, {}, { billingEnabled: true })
    .extractPropFromImage(request(propId), res);

  assert.equal(result.status, 400);
  const reservation = db.prepare(
    `SELECT * FROM tenant_usage_reservations
     WHERE resource_type = 'prop_vision' AND resource_id = ?`,
  ).get(String(propId));
  assert.equal(reservation.status, 'refunded');
  assert.deepEqual(credits.getTenantAccount(db, 'tenant-a'), {
    tenant_id: 'tenant-a', available: 30, held: 0, spent: 0,
  });
});

test('场景视觉提取成功后确认文本模型积分', async (t) => {
  const { db, sceneId } = setup();
  const original = sceneService.extractSceneFromImage;
  t.after(() => { sceneService.extractSceneFromImage = original; db.close(); });
  sceneService.extractSceneFromImage = async () => ({ ok: true, prompt: '雨后庭院描述' });
  const { res, result } = capture();

  await sceneRoutes(db, log, {}, { billingEnabled: true })
    .extractFromImage(request(sceneId), res);

  assert.equal(result.status, 200);
  const reservation = db.prepare(
    `SELECT * FROM tenant_usage_reservations
     WHERE resource_type = 'scene_vision' AND resource_id = ?`,
  ).get(String(sceneId));
  assert.equal(reservation.status, 'confirmed');
});
