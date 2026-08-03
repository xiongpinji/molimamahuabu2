const test = require('node:test');
const assert = require('node:assert/strict');

const taskService = require('../src/services/taskService');

test('task service exposes the in-flight shutdown contract', async () => {
  assert.equal(typeof taskService.trackInFlightTask, 'function');
  assert.equal(typeof taskService.waitForInFlightTasks, 'function');
  assert.equal(typeof taskService.getInFlightTaskCount, 'function');

  let finish;
  const work = new Promise((resolve) => { finish = resolve; });
  taskService.trackInFlightTask('script-analysis:contract', work);

  const waiting = taskService.waitForInFlightTasks(100);
  finish();

  assert.equal(await waiting, true);
  assert.equal(taskService.getInFlightTaskCount(), 0);
});

test('in-flight shutdown wait stops at the configured grace timeout', async () => {
  let finish;
  const work = new Promise((resolve) => { finish = resolve; });
  taskService.trackInFlightTask('script-analysis:timeout', work);

  assert.equal(await taskService.waitForInFlightTasks(5), false);
  assert.equal(taskService.getInFlightTaskCount(), 1);

  finish();
  await work;
  await Promise.resolve();
  assert.equal(taskService.getInFlightTaskCount(), 0);
});
