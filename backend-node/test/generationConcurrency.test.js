const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runWithGenerationLimit,
  resetGenerationConcurrencyForTests,
} = require('../src/services/generationConcurrency');

test.beforeEach(resetGenerationConcurrencyForTests);

test('同类生成调用不超过配置的并发上限', async () => {
  let active = 0;
  let peak = 0;
  const env = { GENERATION_TEXT_CONCURRENCY: '2', GENERATION_MAX_QUEUE_SIZE: '10' };
  const operations = Array.from({ length: 6 }, (_, index) =>
    runWithGenerationLimit('text', async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return index;
    }, env)
  );

  assert.deepEqual(await Promise.all(operations), [0, 1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
});

test('队列达到上限时明确拒绝新生成请求', async () => {
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const env = { GENERATION_VIDEO_CONCURRENCY: '1', GENERATION_MAX_QUEUE_SIZE: '1' };
  const running = runWithGenerationLimit('video', () => blocker, env);
  const queued = runWithGenerationLimit('video', async () => 'queued', env);

  await assert.rejects(
    runWithGenerationLimit('video', async () => 'overflow', env),
    (error) => error.code === 'GENERATION_QUEUE_FULL'
  );
  release('done');
  assert.equal(await running, 'done');
  assert.equal(await queued, 'queued');
});
