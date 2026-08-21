'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const modelPriceService = require('../src/services/modelPriceService');
const routeCostService = require('../src/services/providerRouteCostService');

const SAFE_PUBLIC_DNS = [{ address: '93.184.216.34', family: 4 }];

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

function paidFingerprintOverrides(scope = (route) => `scope-${route.id}`) {
  return {
    config: (route) => `cfg-${route.id}`,
    cost: (route) => `cost-${route.id}`,
    runtime: (route) => ({ ok: true, fingerprint: `runtime-${route.id}` }),
    scope,
  };
}

function paidCandidate(scheduler, route) {
  return {
    config: route,
    capability: scheduler.enumerateCapabilityProfiles(route)[0],
    reservedCostMicros: 10,
    profileKey: `profile-${route.id}`,
  };
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
  const invalidMode = 'secret-invalid-mode-must-not-appear';
  for (let index = 0; index < 2; index += 1) {
    assert.equal(scheduler.startProviderCanaryScheduler({}, {
      error(message, details) { errors.push({ message, details }); },
    }, { mode: invalidMode, setIntervalFn }), null);
  }
  assert.equal(timers.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /mode/i);
  assert.equal(JSON.stringify(errors).includes(invalidMode), false);
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

test('route mapping failure records the affected route first actionable blocker', async (t) => {
  const scheduler = loadScheduler();
  const { db, storageRoot } = setup(t);
  const ready = config(1);
  const blocked = config(2, { logical_model_id: null });
  insertRoute(db, ready);
  insertRoute(db, blocked);
  db.prepare("UPDATE ai_service_configs SET verification_status = 'verified'").run();
  const prices = require('../src/services/modelPriceService');
  prices.set(db, ready.logical_model_id, 10, {
    category: 'video', cost_micros_per_unit: 10,
  });
  prices.set(db, blocked.default_model, 10, {
    category: 'video', cost_micros_per_unit: 10,
  });
  require('../src/services/providerRouteCostService').setRouteCost(db, ready.id, {
    cost_unit: 'second',
    micros_per_unit: 10,
  });
  const probes = { ...allHealthyProbes };
  delete probes.mappings;

  const result = await scheduler.runZeroCostSweep(db, {}, {
    now: '2026-08-18T00:00:00.000Z', storageRoot,
    configs: [ready, blocked], probes,
  });

  assert.deepEqual(result.routes.map((route) => ({
    config_id: route.config_id,
    state: route.state,
    category: route.category,
  })), [
    { config_id: ready.id, state: 'healthy', category: null },
    { config_id: blocked.id, state: 'failed', category: 'missing_logical_model_id' },
  ]);
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
    dnsLookup: async (hostname) => { calls.push(['dns', hostname]); return SAFE_PUBLIC_DNS; },
    tlsConnect(connectOptions, callback) {
      calls.push(['tls', connectOptions.host, connectOptions.rejectUnauthorized]);
      const socket = { once() {}, destroy() {} };
      queueMicrotask(callback);
      return socket;
    },
    fetchFn: async (url, request) => {
      calls.push(['fetch', url, request.method, request.redirect, request.headers.authorization]);
      return { ok: true };
    },
  });
  assert.deepEqual(calls, [
    ['dns', 'provider.example'],
    ['tls', SAFE_PUBLIC_DNS[0].address, true],
    ['fetch', 'https://provider.example/v1/models', 'GET', 'manual', `Bearer ${route.api_key}`],
  ]);
});

test('same-origin and cross-origin redirects both fail closed without following or reading Location', async (t) => {
  const scheduler = loadScheduler();
  const { db, storageRoot } = setup(t);
  const probes = { ...allHealthyProbes };
  delete probes.provider;
  const redirects = [
    'https://provider.example/v1/other-read-only',
    'https://attacker.example/collect',
  ];
  const logs = [];
  for (const [index, location] of redirects.entries()) {
    const route = config(index + 1, { base_url: 'https://provider.example/v1/' });
    insertRoute(db, route);
    let fetchCalls = 0;
    let locationReads = 0;
    const result = await scheduler.runZeroCostSweep(db, {
      warn(message, details) { logs.push({ message, details }); },
    }, {
      now: `2026-08-18T00:0${index}:00.000Z`, storageRoot, configs: [route], probes,
      dnsLookup: async () => SAFE_PUBLIC_DNS,
      tlsConnect(_connectOptions, callback) {
        const socket = { once() {}, destroy() {} };
        queueMicrotask(callback);
        return socket;
      },
      fetchFn: async (_url, request) => {
        fetchCalls += 1;
        assert.equal(request.redirect, 'manual');
        assert.equal(request.headers.authorization, `Bearer ${route.api_key}`);
        return {
          ok: false,
          status: 302,
          headers: { get() { locationReads += 1; return location; } },
        };
      },
    });
    assert.equal(fetchCalls, 1);
    assert.equal(locationReads, 0);
    assert.equal(result.routes[0].category, 'provider_read_only_redirect_forbidden');
  }
  const events = db.prepare(`SELECT safe_details FROM provider_stability_events
    WHERE event_type = 'provider_canary_zero_cost_check' ORDER BY id`).all();
  const serialized = JSON.stringify({ logs, events });
  for (const forbidden of [...redirects, 'key-1', 'key-2', 'Bearer']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
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
    dnsLookup: async () => SAFE_PUBLIC_DNS,
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
    dnsLookup: async () => SAFE_PUBLIC_DNS,
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

test('literal local private metadata mapped and transition addresses fail before DNS TLS or auth', async (t) => {
  const scheduler = loadScheduler();
  const { db, storageRoot } = setup(t);
  const probes = { ...allHealthyProbes };
  delete probes.provider;
  const hosts = [
    'localhost', '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1',
    '169.254.169.254', '[::1]', '[::ffff:8.8.8.8]', '[::192.168.1.1]',
    '[64:ff9b::808:808]', '[2002:0808:0808::]', '[2001:0000::1]',
  ];
  for (const [index, host] of hosts.entries()) {
    const route = config(index + 1, { base_url: `https://${host}/v1/` });
    insertRoute(db, route);
    let externalCalls = 0;
    const result = await scheduler.runZeroCostSweep(db, {}, {
      now: `2026-08-18T01:${String(index).padStart(2, '0')}:00.000Z`,
      storageRoot, configs: [route], probes,
      dnsLookup: async () => { externalCalls += 1; return SAFE_PUBLIC_DNS; },
      tlsConnect() { externalCalls += 1; },
      fetchFn: async () => { externalCalls += 1; return { ok: true }; },
      readOnlyRequest: async () => { externalCalls += 1; return { ok: true, status: 200 }; },
    });
    assert.equal(externalCalls, 0, host);
    assert.equal(result.routes[0].category, 'provider_address_forbidden', host);
  }
});

test('public IPv4 and IPv6 literals also fail before DNS TLS request or auth', async (t) => {
  const scheduler = loadScheduler();
  const { db, storageRoot } = setup(t);
  const probes = { ...allHealthyProbes };
  delete probes.provider;
  for (const [index, host] of ['8.8.8.8', '[2001:4860:4860::8888]'].entries()) {
    const route = config(index + 1, { base_url: `https://${host}/v1/` });
    insertRoute(db, route);
    let externalCalls = 0;
    const result = await scheduler.runZeroCostSweep(db, {}, {
      now: `2026-08-18T02:0${index}:00.000Z`, storageRoot, configs: [route], probes,
      dnsLookup: async () => { externalCalls += 1; return SAFE_PUBLIC_DNS; },
      tlsConnect() { externalCalls += 1; },
      readOnlyRequest: async () => { externalCalls += 1; return { ok: true, status: 200 }; },
    });
    assert.equal(externalCalls, 0, host);
    assert.equal(result.routes[0].category, 'provider_address_forbidden', host);
  }
});

test('mixed public and private DNS answers fail closed before TLS request or auth', async (t) => {
  const scheduler = loadScheduler();
  const { db, storageRoot } = setup(t);
  const route = config(1, { base_url: 'https://provider.example/v1/' });
  insertRoute(db, route);
  const probes = { ...allHealthyProbes };
  delete probes.provider;
  let tlsCalls = 0;
  let requestCalls = 0;
  const result = await scheduler.runZeroCostSweep(db, {}, {
    now: '2026-08-18T00:00:00.000Z', storageRoot, configs: [route], probes,
    dnsLookup: async () => [...SAFE_PUBLIC_DNS, { address: '10.0.0.8', family: 4 }],
    tlsConnect() { tlsCalls += 1; },
    fetchFn: async () => { requestCalls += 1; return { ok: true }; },
    readOnlyRequest: async () => { requestCalls += 1; return { ok: true, status: 200 }; },
  });
  assert.equal(tlsCalls, 0);
  assert.equal(requestCalls, 0);
  assert.equal(result.routes[0].category, 'provider_address_forbidden');
});

test('provider probe pins TLS and HTTPS request to one verified public address', async (t) => {
  const scheduler = loadScheduler();
  const { db, storageRoot } = setup(t);
  const route = config(1, { base_url: 'https://provider.example/v1/' });
  insertRoute(db, route);
  const probes = { ...allHealthyProbes };
  delete probes.provider;
  const calls = [];
  const result = await scheduler.runZeroCostSweep(db, {}, {
    now: '2026-08-18T00:00:00.000Z', storageRoot, configs: [route], probes,
    dnsLookup: async (_hostname, options) => {
      calls.push(['dns', options]);
      return [...SAFE_PUBLIC_DNS, { address: '93.184.216.35', family: 4 }];
    },
    tlsConnect(connectOptions, callback) {
      calls.push(['tls', connectOptions.host, connectOptions.servername]);
      const socket = { once() {}, destroy() {} };
      queueMicrotask(callback);
      return socket;
    },
    fetchFn: async () => { calls.push(['fetch']); return { ok: true, status: 200 }; },
    readOnlyRequest: async (endpoint, request) => {
      calls.push(['request', endpoint, request.address, request.servername, request.hostHeader]);
      return { ok: true, status: 200 };
    },
  });
  assert.equal(result.routes[0].state, 'healthy');
  assert.deepEqual(calls, [
    ['dns', { all: true, verbatim: true }],
    ['tls', SAFE_PUBLIC_DNS[0].address, 'provider.example'],
    ['request', 'https://provider.example/v1/models', SAFE_PUBLIC_DNS[0].address,
      'provider.example', 'provider.example'],
  ]);
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

test('due profiles reserve independent route cost for configs sharing one logical model', () => {
  const scheduler = loadScheduler();
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    const first = config(25, { logical_model_id: 'shared-video', priority: 20 });
    const second = config(26, { logical_model_id: 'shared-video', priority: 10 });
    insertRoute(db, first);
    insertRoute(db, second);
    modelPriceService.set(db, 'shared-video', 10, {
      category: 'video',
      billing_unit: 'second',
      cost_unit: 'second',
      cost_micros_per_unit: 46_000,
    });
    routeCostService.setRouteCost(db, first.id, {
      cost_unit: 'request', micros_per_unit: 46_000,
    });
    routeCostService.setRouteCost(db, second.id, {
      cost_unit: 'request', micros_per_unit: 100_000,
    });

    const rows = scheduler.selectDueProfiles(db, {
      now: '2026-08-18T00:00:00.000Z',
      configs: [first, second],
      evidenceRows: [],
      capabilityFingerprint: (_serviceType, _profile, route) => `hash-${route.id}`,
      providerScopeKey: (route) => `scope-${route.id}`,
    });
    assert.deepEqual(rows.map((row) => ({
      config_id: row.config.id,
      reserved_cost_micros: row.reservedCostMicros,
    })), [
      { config_id: 25, reserved_cost_micros: 46_000 },
      { config_id: 26, reserved_cost_micros: 100_000 },
    ]);
  } finally {
    db.close();
  }
});

test('fixture failure happens before reservation and leaves the global slot free', async (t) => {
  const scheduler = loadScheduler();
  const { db } = setup(t);
  const route = config(1);
  insertRoute(db, route);
  const secret = 'https://secret.example/path?token=fixture-secret';
  const result = await scheduler.runOnePaidCanary(db, {}, {
    paidEnabled: true, now: '2026-08-18T00:00:00.000Z',
    dueProfiles: [paidCandidate(scheduler, route)],
    buildFixtures: async () => { throw new Error(secret); },
    fingerprint: paidFingerprintOverrides(),
  });
  assert.equal(result.state, 'local_failed');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM provider_canary_runs').get().count, 0);
  const event = db.prepare(`SELECT severity, safe_details FROM provider_stability_events
    WHERE event_type = 'provider_canary_fixture_failed'`).get();
  assert.equal(event.severity, 'info');
  assert.equal(event.safe_details.includes(secret), false);
});

test('executor failure before claim settles reserved at zero cost and frees the slot', async (t) => {
  const scheduler = loadScheduler();
  const { db } = setup(t);
  const route = config(1);
  insertRoute(db, route);
  const secret = 'sk-local-secret https://secret.example/prompt';
  const result = await scheduler.runOnePaidCanary(db, {}, {
    paidEnabled: true, now: '2026-08-18T00:00:00.000Z',
    dueProfiles: [paidCandidate(scheduler, route)], buildFixtures: async () => ({}),
    executor: { async executeCanaryRun() { throw new Error(secret); } },
    fingerprint: paidFingerprintOverrides(),
  });
  assert.equal(result.state, 'local_failed');
  const run = db.prepare(`SELECT state, actual_cost_micros, safe_error_summary
    FROM provider_canary_runs`).get();
  assert.deepEqual(run, {
    state: 'failed', actual_cost_micros: 0,
    safe_error_summary: 'category=local_pre_submit_failure',
  });
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM provider_canary_runs
    WHERE state IN ('reserved', 'submitting', 'accepted', 'verifying')`).get().count, 0);
  const serialized = JSON.stringify(db.prepare(`SELECT safe_details FROM provider_stability_events`).all());
  assert.equal(serialized.includes(secret), false);
});

test('scope-blocked claim closes its reservation while preserving the prior unknown scope', async (t) => {
  const scheduler = loadScheduler();
  const budget = require('../src/services/providerCanaryBudgetService');
  const { db } = setup(t);
  const route = config(1);
  insertRoute(db, route);
  db.prepare(`INSERT INTO provider_canary_runs
      (id, idempotency_key, config_id, logical_model_id, service_type,
       capability_fingerprint, config_fingerprint, cost_fingerprint, runtime_fingerprint,
       provider_scope_key, state, reserved_cost_micros, currency, budget_day, budget_month,
       created_at, updated_at, finished_at)
    VALUES ('unknown-owner', 'unknown-key', 1, ?, 'video', 'prior-cap', 'cfg', 'cost', 'runtime',
      'shared-scope', 'submission_unknown', 10, 'CNY', '2026-08-18', '2026-08', ?, ?, ?)`)
    .run(route.logical_model_id, '2026-08-18T00:00:00.000Z',
      '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z');
  const result = await scheduler.runOnePaidCanary(db, {}, {
    paidEnabled: true, now: '2026-08-18T00:00:00.000Z',
    dueProfiles: [paidCandidate(scheduler, route)], buildFixtures: async () => ({}),
    executor: { async executeCanaryRun(executorDb, _log, run) {
      budget.claimForExecution(executorDb, run.id, '2026-08-18T00:00:00.000Z');
    } },
    fingerprint: paidFingerprintOverrides(() => 'shared-scope'),
  });
  assert.equal(result.state, 'local_failed');
  assert.equal(db.prepare(`SELECT state FROM provider_canary_runs WHERE id = 'unknown-owner'`).get().state,
    'submission_unknown');
  assert.equal(db.prepare(`SELECT state FROM provider_canary_runs WHERE id <> 'unknown-owner'`).get().state,
    'failed');
});

test('unexpected throw after claim becomes atomic submission unknown and blocks only that scope', async (t) => {
  const scheduler = loadScheduler();
  const budget = require('../src/services/providerCanaryBudgetService');
  const { db } = setup(t);
  const first = config(1);
  const second = config(2);
  insertRoute(db, first);
  insertRoute(db, second);
  const secret = 'sk-submit-secret https://secret.example/result';
  const firstResult = await scheduler.runOnePaidCanary(db, {}, {
    paidEnabled: true, now: '2026-08-18T00:00:00.000Z',
    dueProfiles: [paidCandidate(scheduler, first)], buildFixtures: async () => ({}),
    executor: { async executeCanaryRun(executorDb, _log, run) {
      budget.claimForExecution(executorDb, run.id, '2026-08-18T00:00:00.000Z');
      throw new Error(secret);
    } },
    fingerprint: paidFingerprintOverrides(),
  });
  assert.equal(firstResult.state, 'submission_unknown');
  assert.equal(db.prepare(`SELECT state FROM provider_canary_runs WHERE config_id = 1`).get().state,
    'submission_unknown');
  assert.equal(db.prepare(`SELECT safe_error_summary FROM provider_canary_runs WHERE config_id = 1`)
    .get().safe_error_summary, 'category=submission_unknown');
  assert.equal(db.prepare(`SELECT state FROM provider_canary_evidence WHERE config_id = 1`).get().state,
    'submission_unknown');
  assert.equal(JSON.stringify(db.prepare('SELECT safe_details FROM provider_stability_events').all()).includes(secret), false);

  let secondCalls = 0;
  const secondResult = await scheduler.runOnePaidCanary(db, {}, {
    paidEnabled: true, now: '2026-08-18T00:01:00.000Z',
    dueProfiles: [paidCandidate(scheduler, second)], buildFixtures: async () => ({}),
    executor: { async executeCanaryRun(executorDb, _log, run) {
      secondCalls += 1;
      budget.claimForExecution(executorDb, run.id, '2026-08-18T00:01:00.000Z');
      budget.settleDefinitiveFailure(executorDb, run.id, 0, 'local_test_failure',
        '2026-08-18T00:01:00.000Z');
      return { state: 'failed' };
    } },
    fingerprint: paidFingerprintOverrides(),
  });
  assert.equal(secondResult.state, 'failed');
  assert.equal(secondCalls, 1);
});

test('recordFailure bookkeeping errors emergency-close reserved runs before alerting', async (t) => {
  const scheduler = loadScheduler();
  const evidence = require('../src/services/providerCanaryEvidenceService');
  const budget = require('../src/services/providerCanaryBudgetService');
  const { db } = setup(t);
  const first = config(1);
  const second = config(2);
  insertRoute(db, first);
  insertRoute(db, second);
  const raw = 'recordFailure secret sk-bookkeeping https://private.example/prompt';
  const original = evidence.recordFailure;
  evidence.recordFailure = () => { throw new Error(raw); };
  t.after(() => { evidence.recordFailure = original; });
  const logs = [];
  const result = await scheduler.runOnePaidCanary(db, { error(...args) { logs.push(args); } }, {
    paidEnabled: true, now: '2026-08-18T03:00:00.000Z',
    dueProfiles: [paidCandidate(scheduler, first)], buildFixtures: async () => ({}),
    executor: { async executeCanaryRun() { throw new Error('executor raw secret'); } },
    fingerprint: paidFingerprintOverrides(),
  });
  assert.equal(result.state, 'local_failed');
  assert.deepEqual(db.prepare(`SELECT state, actual_cost_micros, error_category, safe_error_summary
    FROM provider_canary_runs WHERE config_id = 1`).get(), {
    state: 'failed', actual_cost_micros: 0,
    error_category: 'canary_bookkeeping_failed',
    safe_error_summary: 'category=canary_bookkeeping_failed',
  });
  assert.equal(db.prepare(`SELECT severity FROM provider_stability_events
    WHERE event_type = 'provider_canary_bookkeeping_failed'`).get().severity, 'error');
  assert.equal(JSON.stringify(logs).includes(raw), false);

  let nextCalls = 0;
  const next = await scheduler.runOnePaidCanary(db, {}, {
    paidEnabled: true, now: '2026-08-18T03:01:00.000Z',
    dueProfiles: [paidCandidate(scheduler, second)], buildFixtures: async () => ({}),
    executor: { async executeCanaryRun(executorDb, _log, run) {
      nextCalls += 1;
      budget.claimForExecution(executorDb, run.id, '2026-08-18T03:01:00.000Z');
      budget.settleDefinitiveFailure(executorDb, run.id, 0, 'local_test_failure',
        '2026-08-18T03:01:00.000Z');
      return { state: 'failed' };
    } },
    fingerprint: paidFingerprintOverrides(),
  });
  assert.equal(next.state, 'failed');
  assert.equal(nextCalls, 1);
});

test('recordUnknown bookkeeping errors retain held cost and free the global slot', async (t) => {
  const scheduler = loadScheduler();
  const evidence = require('../src/services/providerCanaryEvidenceService');
  const budget = require('../src/services/providerCanaryBudgetService');
  const { db } = setup(t);
  const first = config(1);
  const second = config(2);
  insertRoute(db, first);
  insertRoute(db, second);
  const raw = 'recordUnknown secret sk-bookkeeping https://private.example/result';
  const original = evidence.recordUnknown;
  evidence.recordUnknown = () => { throw new Error(raw); };
  t.after(() => { evidence.recordUnknown = original; });
  const logs = [];
  const result = await scheduler.runOnePaidCanary(db, { error(...args) { logs.push(args); } }, {
    paidEnabled: true, now: '2026-08-18T03:02:00.000Z',
    dueProfiles: [paidCandidate(scheduler, first)], buildFixtures: async () => ({}),
    executor: { async executeCanaryRun(executorDb, _log, run) {
      budget.claimForExecution(executorDb, run.id, '2026-08-18T03:02:00.000Z');
      throw new Error('executor raw secret');
    } },
    fingerprint: paidFingerprintOverrides(),
  });
  assert.equal(result.state, 'submission_unknown');
  assert.deepEqual(db.prepare(`SELECT state, reserved_cost_micros, actual_cost_micros,
      error_category, safe_error_summary FROM provider_canary_runs WHERE config_id = 1`).get(), {
    state: 'submission_unknown', reserved_cost_micros: 10, actual_cost_micros: null,
    error_category: 'canary_bookkeeping_failed',
    safe_error_summary: 'category=canary_bookkeeping_failed',
  });
  assert.equal(db.prepare(`SELECT severity FROM provider_stability_events
    WHERE event_type = 'provider_canary_bookkeeping_failed'`).get().severity, 'error');
  assert.equal(JSON.stringify(logs).includes(raw), false);

  let nextCalls = 0;
  const next = await scheduler.runOnePaidCanary(db, {}, {
    paidEnabled: true, now: '2026-08-18T03:03:00.000Z',
    dueProfiles: [paidCandidate(scheduler, second)], buildFixtures: async () => ({}),
    executor: { async executeCanaryRun(executorDb, _log, run) {
      nextCalls += 1;
      budget.claimForExecution(executorDb, run.id, '2026-08-18T03:03:00.000Z');
      budget.settleDefinitiveFailure(executorDb, run.id, 0, 'local_test_failure',
        '2026-08-18T03:03:00.000Z');
      return { state: 'failed' };
    } },
    fingerprint: paidFingerprintOverrides(),
  });
  assert.equal(next.state, 'failed');
  assert.equal(nextCalls, 1);
});

test('recordUnknown bookkeeping emergency maps accepted and verifying states without releasing cost', async (t) => {
  const scheduler = loadScheduler();
  const evidence = require('../src/services/providerCanaryEvidenceService');
  const budget = require('../src/services/providerCanaryBudgetService');
  const { db } = setup(t);
  const accepted = config(1);
  const verifying = config(2);
  insertRoute(db, accepted);
  insertRoute(db, verifying);
  const original = evidence.recordUnknown;
  evidence.recordUnknown = () => { throw new Error('raw bookkeeping secret'); };
  t.after(() => { evidence.recordUnknown = original; });
  for (const [route, expected] of [
    [accepted, 'result_unknown'],
    [verifying, 'artifact_unreadable'],
  ]) {
    const result = await scheduler.runOnePaidCanary(db, {}, {
      paidEnabled: true, now: '2026-08-18T03:06:00.000Z',
      dueProfiles: [paidCandidate(scheduler, route)], buildFixtures: async () => ({}),
      executor: { async executeCanaryRun(executorDb, _log, run) {
        budget.claimForExecution(executorDb, run.id, '2026-08-18T03:06:00.000Z');
        budget.markAccepted(executorDb, run.id, `task-${route.id}`, '2026-08-18T03:06:00.000Z');
        if (expected === 'artifact_unreadable') {
          executorDb.prepare(`UPDATE provider_canary_runs SET state = 'verifying'
            WHERE id = ? AND state = 'accepted'`).run(run.id);
        }
        throw new Error('executor raw secret');
      } },
      fingerprint: paidFingerprintOverrides(),
    });
    assert.equal(result.state, expected);
    assert.deepEqual(db.prepare(`SELECT state, provider_task_id, reserved_cost_micros,
        actual_cost_micros, error_category, safe_error_summary
      FROM provider_canary_runs WHERE config_id = ?`).get(route.id), {
      state: expected,
      provider_task_id: `task-${route.id}`,
      reserved_cost_micros: 10,
      actual_cost_micros: null,
      error_category: 'canary_bookkeeping_failed',
      safe_error_summary: 'category=canary_bookkeeping_failed',
    });
  }
});

test('event insert bookkeeping errors still close unknown runs and emit only a safe log', async (t) => {
  const scheduler = loadScheduler();
  const budget = require('../src/services/providerCanaryBudgetService');
  const { db } = setup(t);
  const first = config(1);
  const second = config(2);
  insertRoute(db, first);
  insertRoute(db, second);
  const raw = 'event secret sk-bookkeeping https://private.example/location';
  db.exec(`CREATE TRIGGER fail_canary_event BEFORE INSERT ON provider_stability_events
    BEGIN SELECT RAISE(ABORT, '${raw}'); END`);
  const logs = [];
  const result = await scheduler.runOnePaidCanary(db, { error(...args) { logs.push(args); } }, {
    paidEnabled: true, now: '2026-08-18T03:04:00.000Z',
    dueProfiles: [paidCandidate(scheduler, first)], buildFixtures: async () => ({}),
    executor: { async executeCanaryRun(executorDb, _log, run) {
      budget.claimForExecution(executorDb, run.id, '2026-08-18T03:04:00.000Z');
      throw new Error('executor raw secret');
    } },
    fingerprint: paidFingerprintOverrides(),
  });
  assert.equal(result.state, 'submission_unknown');
  assert.deepEqual(db.prepare(`SELECT state, reserved_cost_micros, actual_cost_micros,
      error_category, safe_error_summary FROM provider_canary_runs WHERE config_id = 1`).get(), {
    state: 'submission_unknown', reserved_cost_micros: 10, actual_cost_micros: null,
    error_category: 'canary_bookkeeping_failed',
    safe_error_summary: 'category=canary_bookkeeping_failed',
  });
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM provider_canary_runs
    WHERE state IN ('reserved', 'submitting', 'accepted', 'verifying')`).get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM provider_stability_events').get().count, 0);
  assert.equal(JSON.stringify(logs).includes(raw), false);
  assert.match(JSON.stringify(logs), /bookkeeping alert could not be recorded/);

  let nextCalls = 0;
  const next = await scheduler.runOnePaidCanary(db, {}, {
    paidEnabled: true, now: '2026-08-18T03:05:00.000Z',
    dueProfiles: [paidCandidate(scheduler, second)], buildFixtures: async () => ({}),
    executor: { async executeCanaryRun(executorDb, _log, run) {
      nextCalls += 1;
      budget.claimForExecution(executorDb, run.id, '2026-08-18T03:05:00.000Z');
      budget.settleDefinitiveFailure(executorDb, run.id, 0, 'local_test_failure',
        '2026-08-18T03:05:00.000Z');
      return { state: 'failed' };
    } },
    fingerprint: paidFingerprintOverrides(),
  });
  assert.equal(next.state, 'failed');
  assert.equal(nextCalls, 1);
});

test('unexpected throws after acceptance or verification close each active slot as unknown', async (t) => {
  const scheduler = loadScheduler();
  const budget = require('../src/services/providerCanaryBudgetService');
  const { db } = setup(t);
  const accepted = config(1);
  const verifying = config(2);
  insertRoute(db, accepted);
  insertRoute(db, verifying);
  const secret = 'sk-lifecycle-secret https://secret.example/artifact';
  for (const [route, expectedState] of [
    [accepted, 'result_unknown'],
    [verifying, 'artifact_unreadable'],
  ]) {
    const result = await scheduler.runOnePaidCanary(db, {}, {
      paidEnabled: true, now: '2026-08-18T00:02:00.000Z',
      dueProfiles: [paidCandidate(scheduler, route)], buildFixtures: async () => ({}),
      executor: { async executeCanaryRun(executorDb, _log, run) {
        budget.claimForExecution(executorDb, run.id, '2026-08-18T00:02:00.000Z');
        budget.markAccepted(executorDb, run.id, `task-${route.id}`, '2026-08-18T00:02:00.000Z');
        if (expectedState === 'artifact_unreadable') {
          executorDb.prepare(`UPDATE provider_canary_runs SET state = 'verifying'
            WHERE id = ? AND state = 'accepted'`).run(run.id);
        }
        throw new Error(secret);
      } },
      fingerprint: paidFingerprintOverrides(),
    });
    assert.equal(result.state, expectedState);
    assert.equal(db.prepare('SELECT state FROM provider_canary_runs WHERE config_id = ?')
      .get(route.id).state, expectedState);
  }
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM provider_canary_runs
    WHERE state IN ('reserved', 'submitting', 'accepted', 'verifying')`).get().count, 0);
  assert.equal(JSON.stringify(db.prepare('SELECT safe_details FROM provider_stability_events').all())
    .includes(secret), false);
});

test('paused and missing-cost profiles emit one info event each and never submit', async (t) => {
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
    { severity: 'info', event_type: 'provider_canary_paused', config_id: 1 },
    { severity: 'info', event_type: 'provider_canary_cost_missing', config_id: 2 },
  ]);
});

test('blocked profiles still emit info when the same tick submits one valid profile', async (t) => {
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

test('budget rejection emits info and never calls executor', async (t) => {
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
    buildFixtures: async () => ({}),
    executor: { async executeCanaryRun() { executeCalls += 1; } },
    fingerprint: {
      capability: () => 'cap', config: () => 'cfg', cost: () => 'cost',
      runtime: () => ({ ok: true, fingerprint: 'runtime' }), scope: () => 'scope',
    },
  });
  assert.equal(result.state, 'budget_blocked');
  assert.equal(executeCalls, 0);
  assert.equal(db.prepare(`SELECT severity FROM provider_stability_events
    WHERE event_type = 'provider_canary_budget_blocked'`).get().severity, 'info');
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
    buildFixtures: async () => ({}),
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
