'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');

function loadScheduler() {
  return require('../src/services/providerCanarySchedulerService');
}

function setup(t) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-canary-scheduler-'));
  t.after(() => {
    try { loadScheduler().stopProviderCanaryScheduler(); } catch (_) {}
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });
  return { db, storageRoot };
}

function config(id, overrides = {}) {
  const capabilities = overrides.capabilities || {
    resolutions: ['480p'],
    aspectRatios: ['16:9'],
    durations: [5],
    maxImageReferences: 2,
    maxVideoReferences: 1,
    maxAudioReferences: 1,
    supportsAudio: false,
  };
  return {
    id,
    service_type: 'video',
    provider: `provider-${id}`,
    api_protocol: 'openai',
    name: `route-${id}`,
    base_url: `https://provider-${id}.invalid/v1`,
    api_key: `key-${id}`,
    model: [`upstream-${id}`],
    default_model: `upstream-${id}`,
    logical_model_id: `logical-${id}`,
    priority: 10,
    is_active: true,
    canary_paused: false,
    settings: JSON.stringify({ canvas_capabilities: capabilities }),
    ...overrides,
  };
}

function insertRoute(db, route) {
  db.prepare(`INSERT INTO ai_service_configs
      (id, service_type, provider, api_protocol, name, base_url, api_key, model,
       default_model, priority, is_active, settings, logical_model_id, canary_paused,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
    .run(route.id, route.service_type, route.provider, route.api_protocol, route.name,
      route.base_url, route.api_key, JSON.stringify(route.model), route.default_model,
      route.priority, route.settings, route.logical_model_id, route.canary_paused ? 1 : 0,
      '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
}

const allHealthyProbes = {
  async applicationHealth() { return { ok: true }; },
  database() { return { ok: true }; },
  storage() { return { ok: true, freeBytes: 1024 }; },
  reconciliation() { return { ok: true, unknown: 0, active: 0 }; },
  credits() { return { ok: true }; },
  mappings() { return { ok: true }; },
  async provider() { return { ok: true }; },
};

test('default off and invalid mode never install a timer', () => {
  const scheduler = loadScheduler();
  const timers = [];
  const errors = [];
  const setIntervalFn = (...args) => {
    timers.push(args);
    return { unref() {} };
  };
  assert.equal(scheduler.startProviderCanaryScheduler({}, {}, { setIntervalFn }), null);
  assert.equal(scheduler.startProviderCanaryScheduler({}, {
    error(message, details) { errors.push({ message, details }); },
  }, { mode: 'invalid', setIntervalFn }), null);
  assert.equal(timers.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /mode/i);
});

test('shadow installs an unref five-minute timer and paid false never calls executor', async (t) => {
  const scheduler = loadScheduler();
  const { db, storageRoot } = setup(t);
  let callback;
  let unrefCount = 0;
  let executorCalls = 0;
  const timer = {
    unref() { unrefCount += 1; },
  };
  const returned = scheduler.startProviderCanaryScheduler(db, {}, {
    mode: 'shadow',
    paidEnabled: 'false',
    storageRoot,
    setIntervalFn(fn, intervalMs) {
      callback = fn;
      assert.equal(intervalMs, 300_000);
      return timer;
    },
    clearIntervalFn() {},
    zeroCostOptions: { configs: [], probes: allHealthyProbes },
    executor: { async executeCanaryRun() { executorCalls += 1; } },
  });
  assert.equal(returned, timer);
  assert.equal(unrefCount, 1);
  await callback();
  assert.equal(executorCalls, 0);
});

test('capability profiles form deterministic exact dimension combinations and use declared maxima', () => {
  const scheduler = loadScheduler();
  const profiles = scheduler.enumerateCapabilityProfiles(config(1, {
    capabilities: {
      resolutions: ['720P', '480p'],
      aspectRatios: ['9:16', '16:9'],
      durations: [15, 5],
      maxReferences: 9,
      maxVideoReferences: 3,
      maxAudioReferences: 3,
      supportsAudio: true,
    },
  }));
  assert.equal(profiles.length, 16);
  assert.equal(new Set(profiles.map((row) => JSON.stringify(row))).size, 16);
  assert.deepEqual(profiles[0], {
    serviceType: 'video', generationType: 'video', resolution: '480p',
    aspectRatio: '16:9', duration: 5, count: 1,
    referenceImageCount: 9, referenceVideoCount: 3, referenceAudioCount: 3,
    requiresAudio: false, firstFrame: false, lastFrame: false,
    slotSemantics: [], modelFeatures: [], userPriceContract: null,
  });
  assert.equal(profiles.some((row) => row.requiresAudio === true), true);
  assert.equal(profiles.some((row) => row.resolution === '720p' && row.duration === 15), true);
});

test('per-model declarations override base declarations without cross-dimension inference', () => {
  const scheduler = loadScheduler();
  const route = config(1, {
    default_model: 'selected-model',
    model: ['selected-model'],
    settings: JSON.stringify({
      canvas_capabilities: { resolutions: ['480p'], aspectRatios: ['16:9'], durations: [5] },
      canvas_capabilities_by_model: {
        'selected-model': { resolutions: ['720p'], durations: [15], maxReferences: 4 },
      },
    }),
  });
  const profiles = scheduler.enumerateCapabilityProfiles(route);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].resolution, '720p');
  assert.equal(profiles[0].aspectRatio, '16:9');
  assert.equal(profiles[0].duration, 15);
  assert.equal(profiles[0].referenceImageCount, 4);
});

test('zero-cost sweep covers every fixed category, marks expired evidence stale, and never records success', async (t) => {
  const scheduler = loadScheduler();
  const { db, storageRoot } = setup(t);
  const route = config(1);
  db.prepare(`INSERT INTO ai_service_configs
      (id, service_type, provider, api_protocol, name, base_url, api_key, model,
       default_model, priority, is_active, settings, logical_model_id, canary_paused,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0, ?, ?)`)
    .run(route.id, route.service_type, route.provider, route.api_protocol, route.name,
      route.base_url, route.api_key, JSON.stringify(route.model), route.default_model,
      route.priority, route.settings, route.logical_model_id,
      '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
  const capability = scheduler.enumerateCapabilityProfiles(route)[0];
  const evidenceService = require('../src/services/providerCanaryEvidenceService');
  const capabilityHash = evidenceService.capabilityFingerprint('video', capability);
  db.prepare(`INSERT INTO provider_canary_runs
      (id, idempotency_key, config_id, logical_model_id, service_type,
       capability_fingerprint, config_fingerprint, cost_fingerprint, runtime_fingerprint,
       provider_scope_key, state, reserved_cost_micros, currency, budget_day, budget_month,
       created_at, updated_at, finished_at)
    VALUES ('old-run', 'old-key', 1, ?, 'video', ?, 'cfg', 'cost', 'runtime',
      'scope', 'succeeded', 10, 'CNY', '2026-08-18', '2026-08', ?, ?, ?)`)
    .run(route.logical_model_id, capabilityHash,
      '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z');
  db.prepare(`INSERT INTO provider_canary_evidence
      (config_id, service_type, capability_fingerprint, capability_json, state, run_id,
       config_fingerprint, cost_fingerprint, runtime_fingerprint, verified_at, expires_at,
       created_at, updated_at)
    VALUES (1, 'video', ?, ?, 'fresh', 'old-run', 'cfg', 'cost', 'runtime', ?, ?, ?, ?)`)
    .run(capabilityHash, JSON.stringify(capability),
      '2026-08-16T00:00:00.000Z', '2026-08-18T00:00:00.000Z',
      '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z');

  const calls = [];
  const probes = Object.fromEntries(Object.entries(allHealthyProbes).map(([name, fn]) => [
    name,
    async (...args) => { calls.push(name); return fn(...args); },
  ]));
  const result = await scheduler.runZeroCostSweep(db, {}, {
    now: '2026-08-18T00:00:00.000Z', storageRoot, configs: [route], probes,
    evidenceService: { recordSuccess() { throw new Error('must not refresh evidence'); } },
  });
  assert.deepEqual([...new Set(calls)].sort(), Object.keys(allHealthyProbes).sort());
  assert.equal(db.prepare('SELECT state FROM provider_canary_evidence').get().state, 'stale');
  assert.equal(db.prepare('SELECT state FROM provider_zero_cost_checks WHERE config_id = 1').get().state, 'healthy');
  assert.equal(result.routes[0].would_be_hidden, true);
  assert.equal(result.catalog_mutated, false);
});

test('default application-health probe uses the injected health URL and fetch client', async (t) => {
  const scheduler = loadScheduler();
  const { db, storageRoot } = setup(t);
  const urls = [];
  const probes = { ...allHealthyProbes };
  delete probes.applicationHealth;
  const result = await scheduler.runZeroCostSweep(db, {}, {
    now: '2026-08-18T00:00:00.000Z',
    storageRoot,
    healthUrl: 'http://127.0.0.1:43210/health',
    fetchFn: async (url, request) => {
      urls.push([url, request.method]);
      return { ok: true };
    },
    configs: [],
    probes,
  });
  assert.deepEqual(urls, [['http://127.0.0.1:43210/health', 'GET']]);
  assert.equal(result.global.applicationHealth.ok, true);
});

test('default provider probe performs injected DNS TLS auth and read-only GET only', async (t) => {
  const scheduler = loadScheduler();
  const { db, storageRoot } = setup(t);
  const route = config(1, { base_url: 'https://provider.example/v1/' });
  db.prepare(`INSERT INTO ai_service_configs
      (id, service_type, provider, api_protocol, name, base_url, api_key, model,
       default_model, priority, is_active, settings, logical_model_id, canary_paused,
       created_at, updated_at)
    VALUES (1, 'video', ?, 'openai', 'route', ?, ?, ?, ?, 1, 1, ?, ?, 0, ?, ?)`)
    .run(route.provider, route.base_url, route.api_key, JSON.stringify(route.model), route.default_model,
      route.settings, route.logical_model_id, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
  const calls = [];
  const probes = { ...allHealthyProbes };
  delete probes.provider;
  await scheduler.runZeroCostSweep(db, {}, {
    now: '2026-08-18T00:00:00.000Z', storageRoot, configs: [route], probes,
    dnsLookup: async (hostname) => { calls.push(['dns', hostname]); },
    tlsConnect(connectOptions, callback) {
      calls.push(['tls', connectOptions.host, connectOptions.rejectUnauthorized]);
      const socket = { once() {}, destroy() {} };
      queueMicrotask(callback);
      return socket;
    },
    fetchFn: async (url, request) => {
      calls.push(['fetch', url, request.method, request.headers.authorization]);
      return { ok: true };
    },
  });
  assert.deepEqual(calls, [
    ['dns', 'provider.example'],
    ['tls', 'provider.example', true],
    ['fetch', 'https://provider.example/v1/models', 'GET', `Bearer ${route.api_key}`],
  ]);
});

test('cross-origin read-only endpoint fails closed before any authenticated fetch', async (t) => {
  const scheduler = loadScheduler();
  const { db, storageRoot } = setup(t);
  const route = config(1, {
    base_url: 'https://provider.example/v1/',
    query_endpoint: 'https://attacker.example/collect',
  });
  insertRoute(db, route);
  const probes = { ...allHealthyProbes };
  delete probes.provider;
  const fetches = [];
  const result = await scheduler.runZeroCostSweep(db, {}, {
    now: '2026-08-18T00:00:00.000Z', storageRoot, configs: [route], probes,
    dnsLookup: async () => {},
    tlsConnect() { throw new Error('TLS must not start for an unsafe endpoint'); },
    fetchFn: async (...args) => { fetches.push(args); return { ok: true }; },
  });
  assert.equal(fetches.length, 0);
  assert.equal(result.routes[0].category, 'provider_read_only_origin_mismatch');
});

test('plaintext provider base fails closed without DNS TLS fetch or Authorization', async (t) => {
  const scheduler = loadScheduler();
  const { db, storageRoot } = setup(t);
  const route = config(1, { base_url: 'http://provider.example/v1/' });
  insertRoute(db, route);
  const probes = { ...allHealthyProbes };
  delete probes.provider;
  const externalCalls = [];
  const result = await scheduler.runZeroCostSweep(db, {}, {
    now: '2026-08-18T00:00:00.000Z', storageRoot, configs: [route], probes,
    dnsLookup: async () => { externalCalls.push('dns'); },
    tlsConnect() { externalCalls.push('tls'); },
    fetchFn: async (_url, request) => {
      externalCalls.push(['fetch', request?.headers?.authorization]);
      return { ok: true };
    },
  });
  assert.deepEqual(externalCalls, []);
  assert.equal(result.routes[0].category, 'provider_tls_required');
});

test('userinfo protocol-relative backslash and encoded-host endpoints fail before auth', async (t) => {
  const scheduler = loadScheduler();
  const { db, storageRoot } = setup(t);
  const probes = { ...allHealthyProbes };
  delete probes.provider;
  const unsafeEndpoints = [
    '//attacker.example/collect',
    String.raw`\\attacker.example\collect`,
    'https://user:password@provider.example/v1/models',
    'https://provider.example@attacker.example/v1/models',
    'https://%61ttacker.example/v1/models',
  ];
  for (const [index, queryEndpoint] of unsafeEndpoints.entries()) {
    let fetchCalls = 0;
    const route = config(index + 1, {
      base_url: 'https://provider.example/v1/',
      query_endpoint: queryEndpoint,
    });
    insertRoute(db, route);
    const result = await scheduler.runZeroCostSweep(db, {}, {
      now: `2026-08-18T00:0${index}:00.000Z`, storageRoot, configs: [route], probes,
      dnsLookup: async () => {},
      tlsConnect() { throw new Error('TLS must not start for an unsafe endpoint'); },
      fetchFn: async () => { fetchCalls += 1; return { ok: true }; },
    });
    assert.equal(fetchCalls, 0, queryEndpoint);
    assert.match(result.routes[0].category, /^provider_read_only_(origin_mismatch|credentials_forbidden)$/);
  }
});

test('same-origin relative read-only endpoint remains allowed and substitutes placeholders', async (t) => {
  const scheduler = loadScheduler();
  const { db, storageRoot } = setup(t);
  const route = config(1, {
    base_url: 'https://provider.example/v1/',
    query_endpoint: '/v1/tasks/{taskId}',
  });
  insertRoute(db, route);
  const probes = { ...allHealthyProbes };
  delete probes.provider;
  const fetches = [];
  await scheduler.runZeroCostSweep(db, {}, {
    now: '2026-08-18T00:00:00.000Z', storageRoot, configs: [route], probes,
    dnsLookup: async () => {},
    tlsConnect(_connectOptions, callback) {
      const socket = { once() {}, destroy() {} };
      queueMicrotask(callback);
      return socket;
    },
    fetchFn: async (url, request) => {
      fetches.push([url, request.method, request.headers.authorization]);
      return { ok: true };
    },
  });
  assert.deepEqual(fetches, [[
    'https://provider.example/v1/tasks/provider-canary-read-only-check',
    'GET',
    `Bearer ${route.api_key}`,
  ]]);
});

test('provider base URL userinfo fails before any external operation', async (t) => {
  const scheduler = loadScheduler();
  const { db, storageRoot } = setup(t);
  const route = config(1, { base_url: 'https://user:password@provider.example/v1/' });
  insertRoute(db, route);
  const probes = { ...allHealthyProbes };
  delete probes.provider;
  let externalCalls = 0;
  const result = await scheduler.runZeroCostSweep(db, {}, {
    now: '2026-08-18T00:00:00.000Z', storageRoot, configs: [route], probes,
    dnsLookup: async () => { externalCalls += 1; },
    tlsConnect() { externalCalls += 1; },
    fetchFn: async () => { externalCalls += 1; return { ok: true }; },
  });
  assert.equal(externalCalls, 0);
  assert.equal(result.routes[0].category, 'provider_url_credentials_forbidden');
});

test('zero-cost events deduplicate by type model config and category within one window', async (t) => {
  const scheduler = loadScheduler();
  const { db, storageRoot } = setup(t);
  const route = config(1);
  db.prepare(`INSERT INTO ai_service_configs
      (id, service_type, provider, api_protocol, name, base_url, api_key, model,
       default_model, priority, is_active, settings, logical_model_id, canary_paused,
       created_at, updated_at)
    VALUES (1, 'video', ?, 'openai', 'route', ?, 'key', ?, ?, 1, 1, ?, ?, 0, ?, ?)`)
    .run(route.provider, route.base_url, JSON.stringify(route.model), route.default_model,
      route.settings, route.logical_model_id, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
  const probes = { ...allHealthyProbes, async provider() {
    return { ok: false, category: 'auth_failed', summary: 'auth unavailable' };
  } };
  const options = { now: '2026-08-18T00:01:00.000Z', storageRoot, configs: [route], probes };
  await scheduler.runZeroCostSweep(db, {}, options);
  await scheduler.runZeroCostSweep(db, {}, options);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM provider_stability_events
    WHERE event_type = 'provider_canary_zero_cost_check'`).get().count, 1);
});

test('due profiles sort by expiry, impact, priority, then cost and skip unresolved provider scopes', () => {
  const scheduler = loadScheduler();
  const routes = [
    config(1, { priority: 5 }),
    config(2, { priority: 20 }),
    config(3, { priority: 20 }),
    config(4, { priority: 99 }),
  ];
  const evidenceRows = routes.map((route, index) => ({
    config_id: route.id,
    capability_fingerprint: `hash-${route.id}`,
    state: 'fresh',
    expires_at: index === 0 ? '2026-08-18T00:01:00.000Z' : '2026-08-18T00:00:00.000Z',
    run_id: `prior-${route.id}`,
  }));
  const result = scheduler.selectDueProfiles({}, {
    now: '2026-08-18T00:00:00.000Z',
    dueHorizonMs: 60_000,
    configs: routes,
    evidenceRows,
    capabilityFingerprint: (_serviceType, _profile, route) => `hash-${route.id}`,
    providerScopeKey: (route) => `scope-${route.id}`,
    unresolvedProviderScopes: new Set(['scope-4']),
    userImpactByLogicalModel: { 'logical-1': 99, 'logical-2': 2, 'logical-3': 2 },
    estimateCost: (_db, route) => (route.id === 2 ? 20 : route.id === 3 ? 10 : 1),
  });
  assert.deepEqual(result.map((row) => row.config.id), [3, 2, 1]);
});

test('paused and missing-cost profiles emit one P3 each and never submit', async (t) => {
  const scheduler = loadScheduler();
  const { db } = setup(t);
  const paused = config(1, { canary_paused: true });
  const missingCost = config(2);
  let executeCalls = 0;
  const result = await scheduler.runOnePaidCanary(db, {}, {
    paidEnabled: true,
    now: '2026-08-18T00:00:00.000Z',
    dueProfiles: [
      { config: paused, capability: {}, blockedReason: 'canary_paused' },
      { config: missingCost, capability: {}, blockedReason: 'cost_missing' },
    ],
    executor: { async executeCanaryRun() { executeCalls += 1; } },
  });
  assert.equal(result.state, 'blocked');
  assert.equal(executeCalls, 0);
  const events = db.prepare(`SELECT severity, event_type, config_id FROM provider_stability_events
    ORDER BY config_id`).all();
  assert.deepEqual(events, [
    { severity: 'P3', event_type: 'provider_canary_paused', config_id: 1 },
    { severity: 'P3', event_type: 'provider_canary_cost_missing', config_id: 2 },
  ]);
});

test('blocked profiles still emit P3 when the same tick submits one valid profile', async (t) => {
  const scheduler = loadScheduler();
  const { db } = setup(t);
  const valid = config(1);
  const paused = config(2, { canary_paused: true });
  const missingCost = config(3);
  let executeCalls = 0;
  const result = await scheduler.runOnePaidCanary(db, {}, {
    paidEnabled: true,
    now: '2026-08-18T00:00:00.000Z',
    dueProfiles: [
      { config: valid, capability: {}, reservedCostMicros: 10, profileKey: 'valid' },
      { config: paused, capability: {}, blockedReason: 'canary_paused' },
      { config: missingCost, capability: {}, blockedReason: 'cost_missing' },
    ],
    budgetService: { reserve(_db, input) { return { id: input.id }; } },
    buildFixtures: async () => ({}),
    executor: { async executeCanaryRun() { executeCalls += 1; return { state: 'succeeded' }; } },
    fingerprint: {
      capability: () => 'cap', config: () => 'cfg', cost: () => 'cost',
      runtime: () => ({ ok: true, fingerprint: 'runtime' }), scope: () => 'scope',
    },
  });
  assert.equal(result.state, 'succeeded');
  assert.equal(executeCalls, 1);
  assert.deepEqual(db.prepare(`SELECT event_type, config_id FROM provider_stability_events
    ORDER BY config_id`).all(), [
    { event_type: 'provider_canary_paused', config_id: 2 },
    { event_type: 'provider_canary_cost_missing', config_id: 3 },
  ]);
});

test('budget rejection emits P3 and never calls executor', async (t) => {
  const scheduler = loadScheduler();
  const { db } = setup(t);
  let executeCalls = 0;
  const route = config(1);
  const result = await scheduler.runOnePaidCanary(db, {}, {
    paidEnabled: true,
    now: '2026-08-18T00:00:00.000Z',
    dueProfiles: [{ config: route, capability: {}, reservedCostMicros: 100, profileKey: 'one' }],
    budgetService: {
      reserve() {
        const error = new Error('budget');
        error.code = 'PROVIDER_CANARY_DAILY_BUDGET_EXCEEDED';
        throw error;
      },
    },
    executor: { async executeCanaryRun() { executeCalls += 1; } },
    fingerprint: {
      capability: () => 'cap', config: () => 'cfg', cost: () => 'cost',
      runtime: () => ({ ok: true, fingerprint: 'runtime' }), scope: () => 'scope',
    },
  });
  assert.equal(result.state, 'budget_blocked');
  assert.equal(executeCalls, 0);
  assert.equal(db.prepare(`SELECT severity FROM provider_stability_events
    WHERE event_type = 'provider_canary_budget_blocked'`).get().severity, 'P3');
});

test('default budget reservation shares the database global slot transaction', async (t) => {
  const scheduler = loadScheduler();
  const { db } = setup(t);
  const route = config(1);
  db.prepare(`INSERT INTO ai_service_configs
      (id, service_type, provider, api_protocol, name, base_url, api_key, model,
       default_model, priority, is_active, settings, logical_model_id, canary_paused,
       created_at, updated_at)
    VALUES (1, 'video', ?, 'openai', 'route', ?, 'key', ?, ?, 1, 1, ?, ?, 0, ?, ?)`)
    .run(route.provider, route.base_url, JSON.stringify(route.model), route.default_model,
      route.settings, route.logical_model_id, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
  let executeCalls = 0;
  const result = await scheduler.runOnePaidCanary(db, {}, {
    paidEnabled: true,
    now: '2026-08-18T00:00:00.000Z',
    dueProfiles: [{
      config: route, capability: {}, reservedCostMicros: 10, profileKey: 'one',
    }],
    buildFixtures: async () => ({}),
    executor: { async executeCanaryRun() { executeCalls += 1; return { state: 'succeeded' }; } },
    fingerprint: {
      capability: () => 'cap', config: () => 'cfg', cost: () => 'cost',
      runtime: () => ({ ok: true, fingerprint: 'runtime' }), scope: () => 'scope',
    },
  });
  assert.equal(result.state, 'succeeded');
  assert.equal(executeCalls, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM provider_canary_runs').get().count, 1);
  const repeated = await scheduler.runOnePaidCanary(db, {}, {
    paidEnabled: true,
    now: '2026-08-18T00:00:00.000Z',
    dueProfiles: [{
      config: route, capability: {}, reservedCostMicros: 10, profileKey: 'one',
    }],
    buildFixtures: async () => ({}),
    executor: { async executeCanaryRun() { executeCalls += 1; return { state: 'succeeded' }; } },
    fingerprint: {
      capability: () => 'cap', config: () => 'cfg', cost: () => 'cost',
      runtime: () => ({ ok: true, fingerprint: 'runtime' }), scope: () => 'scope',
    },
  });
  assert.equal(repeated.state, 'busy');
  assert.equal(executeCalls, 1);
});

test('paid tick submits at most one run and concurrent calls share a global single-flight guard', async (t) => {
  const scheduler = loadScheduler();
  const { db } = setup(t);
  const routes = [config(1), config(2)];
  let reserveCalls = 0;
  let executeCalls = 0;
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const options = {
    paidEnabled: true,
    now: '2026-08-18T00:00:00.000Z',
    dueProfiles: routes.map((route) => ({
      config: route, capability: {}, reservedCostMicros: 10, profileKey: `profile-${route.id}`,
    })),
    budgetService: { reserve(_db, input) { reserveCalls += 1; return { id: input.id }; } },
    executor: { async executeCanaryRun() { executeCalls += 1; await waiting; return { state: 'succeeded' }; } },
    buildFixtures: async () => ({}),
    fingerprint: {
      capability: () => 'cap', config: () => 'cfg', cost: () => 'cost',
      runtime: () => ({ ok: true, fingerprint: 'runtime' }),
      scope: (route) => `scope-${route.id}`,
    },
  };
  const first = scheduler.runOnePaidCanary(db, {}, options);
  const second = await scheduler.runOnePaidCanary(db, {}, options);
  assert.equal(second.state, 'busy');
  assert.equal(reserveCalls, 1);
  assert.equal(executeCalls, 1);
  release();
  await first;
});

test('an active database run owns the global slot across scheduler instances', async (t) => {
  const scheduler = loadScheduler();
  const { db } = setup(t);
  const route = config(1);
  db.prepare(`INSERT INTO ai_service_configs
      (id, service_type, provider, api_protocol, name, base_url, api_key, model,
       default_model, priority, is_active, settings, logical_model_id, canary_paused,
       created_at, updated_at)
    VALUES (1, 'video', ?, 'openai', 'route', ?, 'key', ?, ?, 1, 1, ?, ?, 0, ?, ?)`)
    .run(route.provider, route.base_url, JSON.stringify(route.model), route.default_model,
      route.settings, route.logical_model_id, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
  db.prepare(`INSERT INTO provider_canary_runs
      (id, idempotency_key, config_id, logical_model_id, service_type,
       capability_fingerprint, config_fingerprint, cost_fingerprint, runtime_fingerprint,
       provider_scope_key, state, reserved_cost_micros, currency, budget_day, budget_month,
       created_at, updated_at)
    VALUES ('owner', 'owner-key', 1, ?, 'video', 'other-cap', 'cfg', 'cost', 'runtime',
      'other-scope', 'accepted', 10, 'CNY', '2026-08-18', '2026-08', ?, ?)`)
    .run(route.logical_model_id, '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z');
  let executeCalls = 0;
  const result = await scheduler.runOnePaidCanary(db, {}, {
    paidEnabled: true,
    now: '2026-08-18T00:00:00.000Z',
    dueProfiles: [{
      config: route, capability: {}, reservedCostMicros: 10, profileKey: 'new-profile',
    }],
    executor: { async executeCanaryRun() { executeCalls += 1; } },
    fingerprint: {
      capability: () => 'new-cap', config: () => 'cfg', cost: () => 'cost',
      runtime: () => ({ ok: true, fingerprint: 'runtime' }), scope: () => 'new-scope',
    },
  });
  assert.equal(result.state, 'busy');
  assert.equal(executeCalls, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM provider_canary_runs').get().count, 1);
});

test('scheduler stop clears exactly its timer and repeated stop is inert', () => {
  const scheduler = loadScheduler();
  const cleared = [];
  const timer = { unref() {}, id: 'canary' };
  scheduler.startProviderCanaryScheduler({}, {}, {
    mode: 'shadow', setIntervalFn: () => timer, clearIntervalFn: (value) => cleared.push(value),
  });
  assert.equal(scheduler.stopProviderCanaryScheduler(), true);
  assert.equal(scheduler.stopProviderCanaryScheduler(), false);
  assert.deepEqual(cleared, [timer]);
});
