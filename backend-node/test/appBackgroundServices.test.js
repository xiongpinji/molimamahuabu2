'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { resolveStorageRoot, startBackgroundServices } = require('../src/app');

test('one absolute storage root is shared with the scheduler', () => {
  const cwd = path.resolve('C:/fixture/app');
  const storageRoot = resolveStorageRoot({ storage: { local_path: 'data/storage' } }, cwd);
  assert.equal(storageRoot, path.resolve(cwd, 'data/storage'));
  const calls = [];
  const background = startBackgroundServices({
    db: {}, log: {}, storageRoot,
    providerReconciliation: {
      startProviderReconciliation() { calls.push('reconcile:start'); },
      stopProviderReconciliation() { calls.push('reconcile:stop'); return true; },
    },
    providerCanary: {
      startProviderCanaryScheduler(_db, _log, options) {
        calls.push(['canary:start', options.storageRoot, options.mode, options.paidEnabled]);
      },
      stopProviderCanaryScheduler() { calls.push('canary:stop'); return true; },
    },
    env: { PROVIDER_CANARY_MODE: 'shadow', PROVIDER_CANARY_PAID_ENABLED: 'false' },
  });
  assert.deepEqual(calls, [
    'reconcile:start',
    ['canary:start', storageRoot, 'shadow', 'false'],
  ]);
  assert.deepEqual(background.stop(), { scheduler: true, reconciliation: true });
  assert.deepEqual(calls.slice(-2), ['canary:stop', 'reconcile:stop']);
});

test('background services receive fixed intervals and stop remains complete', () => {
  const starts = [];
  const providerReconciliation = {
    startProviderReconciliation(_db, _log, options) { starts.push(['reconcile', options.intervalMs]); },
    stopProviderReconciliation() { return false; },
  };
  const providerCanary = {
    startProviderCanaryScheduler(_db, _log, options) { starts.push(['canary', options.intervalMs]); },
    stopProviderCanaryScheduler() { return false; },
  };
  const background = startBackgroundServices({
    db: {}, log: {}, storageRoot: path.resolve('storage'),
    providerReconciliation, providerCanary, env: {},
  });
  assert.deepEqual(starts, [['reconcile', 60_000], ['canary', 300_000]]);
  assert.deepEqual(background.stop(), { scheduler: false, reconciliation: false });
});

test('后台服务可启用中转站成本同步并在停止时释放调度器', () => {
  const calls = [];
  const providerPricing = {
    startProviderPricingSync(_db, _log, options) { calls.push(['pricing:start', options.intervalMs]); },
    stopProviderPricingSync() { calls.push('pricing:stop'); return true; },
  };
  const background = startBackgroundServices({
    db: {}, log: {}, storageRoot: path.resolve('storage'),
    providerReconciliation: {
      startProviderReconciliation() {},
      stopProviderReconciliation() { return false; },
    },
    providerCanary: {
      startProviderCanaryScheduler() {},
      stopProviderCanaryScheduler() { return false; },
    },
    providerPricing,
    env: { PROVIDER_PRICING_SYNC_INTERVAL_MS: '123456' },
  });
  assert.deepEqual(calls, [['pricing:start', 123456]]);
  assert.deepEqual(background.stop(), { scheduler: false, reconciliation: false, pricing: true });
  assert.deepEqual(calls, [['pricing:start', 123456], 'pricing:stop']);
});
