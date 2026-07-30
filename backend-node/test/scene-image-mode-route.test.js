const test = require('node:test');
const assert = require('node:assert/strict');

const sceneRoutes = require('../src/routes/scenes');
const sceneService = require('../src/services/sceneService');

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
