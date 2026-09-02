'use strict';

const pricingSync = require('./providerPricingSyncService');

let schedulerState = null;

function startProviderPricingSync(db, log, options = {}) {
  if (schedulerState) return false;
  const minIntervalMs = Math.max(1, Number(options.minIntervalMs) || 60_000);
  const intervalMs = Math.max(minIntervalMs, Number(options.intervalMs) || 6 * 60 * 60 * 1000);
  const syncFn = options.syncFn || pricingSync.syncAllProviderPricing;
  const setIntervalFn = options.setIntervalFn || setInterval;
  const setImmediateFn = options.setImmediateFn || setImmediate;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  const run = () => Promise.resolve(syncFn(db, { log }))
    .catch((error) => log?.warn?.('Provider pricing sync failed', { code: error?.code || 'UNKNOWN' }));
  const timer = setIntervalFn(run, intervalMs);
  schedulerState = { timer, clearIntervalFn };
  setImmediateFn(run);
  return true;
}

function stopProviderPricingSync() {
  if (!schedulerState) return false;
  schedulerState.clearIntervalFn(schedulerState.timer);
  schedulerState = null;
  return true;
}

module.exports = { startProviderPricingSync, stopProviderPricingSync };
