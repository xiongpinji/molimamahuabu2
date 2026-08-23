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
