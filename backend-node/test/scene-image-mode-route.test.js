const test = require('node:test');
const assert = require('node:assert/strict');

const sceneRoutes = require('../src/routes/scenes');
const sceneService = require('../src/services/sceneService');
const characterRoutes = require('../src/routes/characters');
const characterLibrary = require('../src/services/characterLibraryService');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

function responseCapture() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

test('场景生图按 use_quad_grid 在单图和四宫格实现之间路由', async (t) => {
  const originalSingle = sceneService.generateSceneSingleImage;
  const originalFour = sceneService.generateSceneFourViewImage;
  const calls = [];
  sceneService.generateSceneSingleImage = async () => {
    calls.push('single');
    return { ok: true, image_generation: { task_id: 'single-task' } };
  };
  sceneService.generateSceneFourViewImage = async () => {
    calls.push('four');
    return { ok: true, image_generation: { task_id: 'four-task' } };
  };
  t.after(() => {
    sceneService.generateSceneSingleImage = originalSingle;
    sceneService.generateSceneFourViewImage = originalFour;
  });
  const handlers = sceneRoutes(null, log, {}, {});

  const single = responseCapture();
  await handlers.generateImage({
    body: { scene_id: 8, use_quad_grid: false },
  }, single);
  const four = responseCapture();
  await handlers.generateImage({
    body: { scene_id: 8, use_quad_grid: true },
  }, four);

  assert.deepEqual(calls, ['single', 'four']);
  assert.equal(single.payload.data.image_generation.task_id, 'single-task');
  assert.equal(four.payload.data.image_generation.task_id, 'four-task');
});

test('角色和场景生图路由向后端服务透传图片分辨率', async (t) => {
  const originalCharacter = characterLibrary.generateCharacterFourViewImage;
  const originalSingle = sceneService.generateSceneSingleImage;
  const originalFour = sceneService.generateSceneFourViewImage;
  const originalPanorama = sceneService.generateScenePanoramaImage;
  const seen = [];
  characterLibrary.generateCharacterFourViewImage = async (...args) => {
    seen.push(['character', args[6]?.resolution]);
    return { ok: true, image_generation: { task_id: 'character-task' } };
  };
  sceneService.generateSceneSingleImage = async (...args) => {
    seen.push(['scene-single', args[6]?.resolution]);
    return { ok: true, image_generation: { task_id: 'single-task' } };
  };
  sceneService.generateSceneFourViewImage = async (...args) => {
    seen.push(['scene-four', args[6]?.resolution]);
    return { ok: true, image_generation: { task_id: 'four-task' } };
  };
  sceneService.generateScenePanoramaImage = async (...args) => {
    seen.push(['scene-panorama', args[6]?.resolution]);
    return { ok: true, image_generation: { task_id: 'panorama-task' } };
  };
  t.after(() => {
    characterLibrary.generateCharacterFourViewImage = originalCharacter;
    sceneService.generateSceneSingleImage = originalSingle;
    sceneService.generateSceneFourViewImage = originalFour;
    sceneService.generateScenePanoramaImage = originalPanorama;
  });

  await characterRoutes(null, {}, log, null, {}).generateImage({
    params: { id: 3 },
    body: { model: 'nano-banana-2', resolution: '4k' },
  }, responseCapture());
  const sceneHandlers = sceneRoutes(null, log, {}, {});
  await sceneHandlers.generateImage({
    body: { scene_id: 8, use_quad_grid: false, resolution: '2k' },
  }, responseCapture());
  await sceneHandlers.generateImage({
    body: { scene_id: 8, use_quad_grid: true, resolution: '1k' },
  }, responseCapture());
  await sceneHandlers.generatePanoramaImage({
    params: { scene_id: 8 },
    body: { resolution: '4k' },
  }, responseCapture());

  assert.deepEqual(seen, [
    ['character', '4k'],
    ['scene-single', '2k'],
    ['scene-four', '1k'],
    ['scene-panorama', '4k'],
  ]);
});

test('角色和场景生图路由将图片门禁错误映射为 400 或 503', async (t) => {
  const originalCharacter = characterLibrary.generateCharacterFourViewImage;
  const originalPanorama = sceneService.generateScenePanoramaImage;
  const notVerified = new Error('nano-banana-2 尚未通过真实生成验证');
  notVerified.code = 'MODEL_NOT_VERIFIED';
  const missingPrice = new Error('未配置积分价格');
  missingPrice.code = 'MODEL_PRICE_NOT_CONFIGURED';
  characterLibrary.generateCharacterFourViewImage = async () => { throw notVerified; };
  sceneService.generateScenePanoramaImage = async () => { throw missingPrice; };
  t.after(() => {
    characterLibrary.generateCharacterFourViewImage = originalCharacter;
    sceneService.generateScenePanoramaImage = originalPanorama;
  });

  const characterRes = responseCapture();
  await characterRoutes(null, {}, log, null, {}).generateImage({
    params: { id: 3 },
    body: { model: 'nano-banana-2', resolution: '4k' },
  }, characterRes);
  const sceneRes = responseCapture();
  await sceneRoutes(null, log, {}, {}).generatePanoramaImage({
    params: { scene_id: 8 },
    body: { model: 'nano-banana-2', resolution: '4k' },
  }, sceneRes);

  assert.equal(characterRes.statusCode, 400);
  assert.equal(characterRes.payload.error.code, 'MODEL_NOT_VERIFIED');
  assert.equal(sceneRes.statusCode, 503);
  assert.equal(sceneRes.payload.error.code, 'MODEL_PRICE_NOT_CONFIGURED');
});
