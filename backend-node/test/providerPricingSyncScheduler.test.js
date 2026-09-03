const test = require('node:test');
const assert = require('node:assert/strict');

const scheduler = require('../src/services/providerPricingSyncSchedulerService');

test('中转站成本同步调度器启动时同步一次并按间隔运行', async () => {
  const calls = [];
  let tick;
  let unrefCalls = 0;
  const timer = { unref() { unrefCalls += 1; } };
  const started = scheduler.startProviderPricingSync({}, { info() {}, warn() {} }, {
    intervalMs: 1234,
    minIntervalMs: 1,
    syncFn: async () => { calls.push('sync'); },
    setIntervalFn: (fn, interval) => { tick = fn; assert.equal(interval, 1234); return timer; },
    clearIntervalFn: (value) => assert.equal(value, timer),
    setImmediateFn: (fn) => fn(),
  });
  assert.equal(started, true);
  assert.equal(unrefCalls, 1);
  await Promise.resolve();
  assert.deepEqual(calls, ['sync']);
  await tick();
  assert.deepEqual(calls, ['sync', 'sync']);
  assert.equal(scheduler.stopProviderPricingSync(), true);
  assert.equal(scheduler.stopProviderPricingSync(), false);
});

test('中转站成本同步调度器不会重复启动', () => {
  const setIntervalFn = () => 'timer';
  const first = scheduler.startProviderPricingSync({}, {}, {
    syncFn: async () => {},
    setIntervalFn,
    setImmediateFn: () => {},
  });
  const second = scheduler.startProviderPricingSync({}, {}, {
    syncFn: async () => {},
    setIntervalFn,
    setImmediateFn: () => {},
  });
  assert.equal(first, true);
  assert.equal(second, false);
  scheduler.stopProviderPricingSync();
});
