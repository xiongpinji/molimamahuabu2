'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiClient = require('../src/services/aiClient');
const aiConfigService = require('../src/services/aiConfigService');
const catalog = require('../src/services/canvasModelCatalogService');
const evidenceService = require('../src/services/providerCanaryEvidenceService');
const imageClient = require('../src/services/imageClient');
const modelPriceService = require('../src/services/modelPriceService');
const routeCostService = require('../src/services/providerRouteCostService');
const runtimeService = require('../src/services/providerRuntimeFingerprintService');
const stability = require('../src/services/providerRouteStabilityService');
const videoClient = require('../src/services/videoClient');

const NOW = '2026-08-18T00:00:00.000Z';
const REQUESTED = {
  resolution: '720p',
  aspectRatio: '16:9',
  duration: 15,
  referenceImageCount: 2,
  referenceVideoCount: 1,
  referenceAudioCount: 1,
  requiresAudio: true,
};

function createDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  modelPriceService.set(db, 'seedance-logical', 10, {
    category: 'video',
    billing_unit: 'second',
    cost_unit: 'second',
    cost_micros_per_unit: 1000,
    resolution_prices: {
      '480p': { credits: 5, cost_micros_per_second: 500 },
      '720p': { credits: 10, cost_micros_per_second: 1000 },
    },
  });
  return db;
}

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function addConfig(db, values = {}) {
  const capabilities = values.capabilities || {
    resolutions: ['480p', '720p'],
    aspectRatios: ['16:9', '9:16'],
    durations: [5, 15],
    maxReferences: 4,
    maxVideoReferences: 1,
    maxAudioReferences: 1,
    supportsAudio: true,
  };
  const configId = Number(db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
     priority, is_default, is_active, settings, logical_model_id, failover_enabled,
     verification_status, created_at, updated_at)
    VALUES ('video', @provider, 'openai', @name, @base_url, @api_key, @model, @default_model,
     @priority, 0, 1, @settings, 'seedance-logical', @failover_enabled,
     'verified', @now, @now)`)
    .run({
      provider: values.provider || values.name,
      name: values.name,
      base_url: `https://${values.name}.example/v1`,
      api_key: `secret-${values.name}`,
      model: JSON.stringify([`upstream-${values.name}`]),
      default_model: `upstream-${values.name}`,
      priority: values.priority,
      settings: JSON.stringify({ canvas_capabilities: capabilities }),
      failover_enabled: values.failover_enabled ?? 1,
      now: NOW,
    }).lastInsertRowid);
  routeCostService.setRouteCost(db, configId, {
    cost_unit: 'second',
    micros_per_unit: 500,
    resolution_prices: {
      '480p': { micros_per_unit: 500 },
      '720p': { micros_per_unit: 1000 },
    },
  }, { now: NOW });
  return configId;
}

function addPublicConfig(db, values) {
  const capabilities = values.capabilities || {};
  const config = aiConfigService.createConfig(db, { info() {}, warn() {}, error() {} }, {
    service_type: values.serviceType,
    provider: `public-${values.serviceType}`,
    api_protocol: 'openai',
    name: `${values.serviceType}-${values.suffix}`,
    base_url: values.baseUrl,
    api_key: 'test-key',
    model: [values.upstreamModel],
    default_model: values.upstreamModel,
    endpoint: values.serviceType === 'video' ? '/video/generations' : '/images/generations',
    priority: 100,
    logical_model_id: values.logicalModelId,
    failover_enabled: false,
    settings: JSON.stringify({ canvas_capabilities: capabilities }),
  });
  db.prepare("UPDATE ai_service_configs SET verification_status = 'verified' WHERE id = ?")
    .run(config.id);
  routeCostService.setRouteCost(db, config.id, values.serviceType === 'text' ? {
    cost_unit: 'token',
    input_cost_micros_per_1k: 1000,
    output_cost_micros_per_1k: 2000,
  } : values.serviceType === 'video' ? {
    cost_unit: 'second',
    micros_per_unit: 1000,
    resolution_prices: Object.fromEntries(
      (capabilities.resolutions || []).map((resolution) => [resolution, { micros_per_unit: 1000 }]),
    ),
  } : {
    cost_unit: 'image',
    micros_per_unit: 1000,
  }, { now: NOW });
  return config;
}

function addLegacyPublicConfig(db, values) {
  const endpointByService = {
    image: '/images/generations',
    video: '/video/generations',
    text: '/chat/completions',
  };
  const upstreamModel = `legacy-${values.serviceType}`;
  const config = aiConfigService.createConfig(db, { info() {}, warn() {}, error() {} }, {
    service_type: values.serviceType,
    provider: `legacy-${values.serviceType}`,
    api_protocol: 'openai',
    name: `legacy-${values.serviceType}`,
    base_url: values.baseUrl,
    api_key: 'test-key',
    model: [upstreamModel],
    default_model: upstreamModel,
    endpoint: endpointByService[values.serviceType],
    priority: 100,
  });
  db.prepare("UPDATE ai_service_configs SET verification_status = 'verified' WHERE id = ?")
    .run(config.id);
  return { config, upstreamModel };
}

function costFingerprint(db, configId) {
  const cost = routeCostService.getRouteCost(db, configId);
  return cost
    ? routeCostService.fingerprintRouteCost(cost)
    : evidenceService.costFingerprint(null, []);
}

function addEvidence(db, configId, capability, suffix, state = 'fresh') {
  const config = aiConfigService.getConfig(db, configId);
  const configFingerprint = evidenceService.configFingerprint(config);
  const runtime = runtimeService.runtimeFingerprintForConfig(config);
  assert.equal(runtime.ok, true, runtime.code);
  const serviceType = config.service_type;
  const logicalModelId = config.logical_model_id;
  const normalized = evidenceService.normalizeCapability(serviceType, capability);
  const capabilityFingerprint = evidenceService.capabilityFingerprint(serviceType, normalized);
  const runId = `public-gate-${configId}-${suffix}`;
  const cost = costFingerprint(db, configId);
  db.prepare(`INSERT INTO provider_canary_runs
    (id, idempotency_key, config_id, logical_model_id, service_type, capability_fingerprint,
     config_fingerprint, cost_fingerprint, runtime_fingerprint, provider_scope_key, state,
     reserved_cost_micros, actual_cost_micros, currency, budget_day, budget_month,
     created_at, finished_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'succeeded',
      1, 1, 'CNY', '2026-08-18', '2026-08', ?, ?, ?)`)
    .run(
      runId,
      `idem-${runId}`,
      configId,
      logicalModelId,
      serviceType,
      capabilityFingerprint,
      configFingerprint,
      cost,
      runtime.fingerprint,
      `scope-${configId}`,
      NOW,
      NOW,
      NOW,
    );
  const evidence = evidenceService.recordSuccess(db, {
    runId,
    configId,
    serviceType,
    capability: normalized,
    configFingerprint,
    costFingerprint: cost,
    runtimeFingerprint: runtime.fingerprint,
    now: NOW,
  });
  if (state !== 'fresh') {
    db.prepare(`UPDATE provider_canary_evidence SET state = ?, updated_at = ?
      WHERE config_id = ? AND capability_fingerprint = ?`)
      .run(state, NOW, configId, capabilityFingerprint);
  }
  return evidence;
}

function routeFixture() {
  const db = createDb();
  try {
    const ids = {
      stale: addConfig(db, { name: 'stale-high-priority', priority: 120 }),
      primary: addConfig(db, { name: 'fresh-primary', priority: 110, failover_enabled: 0 }),
      backup: addConfig(db, { name: 'fresh-backup', priority: 100 }),
      unknown: addConfig(db, { name: 'unknown-route', priority: 90 }),
      insufficient: addConfig(db, {
        name: 'insufficient-capability',
        priority: 80,
        capabilities: {
          resolutions: ['720p'], aspectRatios: ['16:9'], durations: [15],
          maxReferences: 1, maxVideoReferences: 1, maxAudioReferences: 1, supportsAudio: true,
        },
      }),
      circuit: addConfig(db, { name: 'open-circuit', priority: 70 }),
    };
    addEvidence(db, ids.stale, REQUESTED, 'stale', 'stale');
    addEvidence(db, ids.primary, REQUESTED, 'primary');
    addEvidence(db, ids.backup, REQUESTED, 'backup');
    addEvidence(db, ids.insufficient, { ...REQUESTED, referenceImageCount: 1 }, 'insufficient');
    addEvidence(db, ids.circuit, REQUESTED, 'circuit');
    db.prepare(`INSERT INTO provider_route_health
      (config_id, state, consecutive_failures, open_until, updated_at)
      VALUES (?, 'open', 3, '2026-08-18T01:00:00.000Z', ?)`)
      .run(ids.circuit, NOW);
    return { db, ids };
  } catch (error) {
    db.close();
    throw new Error(error.message, { cause: error });
  }
}

test('enforce 只保留新鲜证据覆盖且健康的主线和备线', () => {
  const { db, ids } = routeFixture();
  try {
    const selected = stability.selectVerifiedCandidates(db, {
      serviceType: 'video',
      logicalModelId: 'seedance-logical',
      primaryConfigId: ids.primary,
      capabilities: REQUESTED,
      canaryMode: 'enforce',
      now: NOW,
    });
    assert.deepEqual(selected.candidates.map((row) => row.name), ['fresh-primary', 'fresh-backup']);
    assert.deepEqual(selected.userPriceSnapshot, { model: 'seedance-logical', credits: 10 });
  } finally {
    db.close();
  }
});

test('shadow 保留现有候选并仅在内部标注 would_be_hidden，off 不附加标注', () => {
  const { db, ids } = routeFixture();
  try {
    const input = {
      serviceType: 'video', logicalModelId: 'seedance-logical', primaryConfigId: ids.primary,
      capabilities: REQUESTED, now: NOW,
    };
    const shadow = stability.selectVerifiedCandidates(db, { ...input, canaryMode: 'shadow' });
    assert.deepEqual(shadow.candidates.map((row) => [row.name, row.would_be_hidden]), [
      ['stale-high-priority', true],
      ['fresh-primary', false],
      ['fresh-backup', false],
      ['unknown-route', true],
    ]);
    const off = stability.selectVerifiedCandidates(db, { ...input, canaryMode: 'off' });
    assert.equal(off.candidates.every((row) => row.would_be_hidden === undefined), true);
  } finally {
    db.close();
  }
});

test('调用方省略模式时统一读取并校验 PROVIDER_CANARY_MODE', () => {
  const previous = process.env.PROVIDER_CANARY_MODE;
  const { db, ids } = routeFixture();
  const errors = [];
  const log = { error(message, details) { errors.push({ message, details }); } };
  try {
    process.env.PROVIDER_CANARY_MODE = 'EnForCe';
    const enforced = stability.selectVerifiedCandidates(db, {
      serviceType: 'video', logicalModelId: 'seedance-logical', primaryConfigId: ids.primary,
      capabilities: REQUESTED, now: NOW,
    });
    assert.deepEqual(enforced.candidates.map((row) => row.name), ['fresh-primary', 'fresh-backup']);

    process.env.PROVIDER_CANARY_MODE = 'secret-invalid-mode-must-not-appear';
    for (let index = 0; index < 2; index += 1) {
      const invalidFallsBackOff = stability.selectVerifiedCandidates(db, {
        serviceType: 'video', logicalModelId: 'seedance-logical', primaryConfigId: ids.primary,
        capabilities: REQUESTED, now: NOW, log,
      });
      assert.equal(invalidFallsBackOff.candidates.some((row) => row.name === 'unknown-route'), true);
    }
    assert.ok(catalog.list(db, { log }).some((row) => row.model === 'seedance-logical'));
    assert.equal(errors.length, 1);
    assert.equal(JSON.stringify(errors).includes(process.env.PROVIDER_CANARY_MODE), false);
  } finally {
    if (previous === undefined) delete process.env.PROVIDER_CANARY_MODE;
    else process.env.PROVIDER_CANARY_MODE = previous;
    db.close();
  }
});

test('目录省略模式时与路由使用相同的 PROVIDER_CANARY_MODE 校验语义', () => {
  const previous = process.env.PROVIDER_CANARY_MODE;
  const db = createDb();
  try {
    addConfig(db, { name: 'catalog-env-no-evidence', priority: 100 });
    process.env.PROVIDER_CANARY_MODE = 'enforce';
    assert.equal(catalog.list(db).some((row) => row.model === 'seedance-logical'), false);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM provider_stability_events
      WHERE event_type = 'provider_canary_public_unavailable'`).get().count, 0);

    process.env.PROVIDER_CANARY_MODE = 'invalid-mode';
    assert.equal(catalog.list(db).some((row) => row.model === 'seedance-logical'), true);
  } finally {
    if (previous === undefined) delete process.env.PROVIDER_CANARY_MODE;
    else process.env.PROVIDER_CANARY_MODE = previous;
    db.close();
  }
});

test('公共目录能力包络只由 fresh 证据并集生成且不暴露线路身份', () => {
  const db = createDb();
  try {
    const declaredCapabilities = {
      resolutions: ['480p', '720p', '1080p'],
      aspectRatios: ['16:9', '9:16', '1:1'],
      durations: [5, 10, 15],
      maxReferences: 9,
      maxVideoReferences: 3,
      maxAudioReferences: 3,
      supportsAudio: true,
    };
    const primary = addConfig(db, {
      name: 'catalog-primary', priority: 100, failover_enabled: 0, capabilities: declaredCapabilities,
    });
    const backup = addConfig(db, {
      name: 'catalog-backup', priority: 90, capabilities: declaredCapabilities,
    });
    addEvidence(db, primary, {
      resolution: '480p', aspectRatio: '16:9', duration: 5,
      referenceImageCount: 2,
    }, '480p');
    addEvidence(db, backup, {
      resolution: '720p', aspectRatio: '9:16', duration: 15,
      referenceImageCount: 4, referenceVideoCount: 1, referenceAudioCount: 1, requiresAudio: true,
    }, '720p');
    addEvidence(db, primary, {
      resolution: '1080p', aspectRatio: '1:1', duration: 10,
      referenceImageCount: 9,
    }, 'stale-1080p', 'stale');

    const item = catalog.list(db, { canaryMode: 'enforce', now: NOW })
      .find((row) => row.model === 'seedance-logical');
    assert.ok(item);
    assert.deepEqual(item.capabilities.resolutions, ['480p', '720p']);
    assert.deepEqual(item.capabilities.aspectRatios, ['16:9', '9:16']);
    assert.deepEqual(item.capabilities.durations, [5, 15]);
    assert.equal(item.capabilities.maxReferences, 4);
    assert.equal(item.capabilities.maxImageReferences, 4);
    assert.equal(item.capabilities.maxVideoReferences, 1);
    assert.equal(item.capabilities.maxAudioReferences, 1);
    assert.equal(item.capabilities.supportsAudio, true);
    assert.deepEqual(item.resolution_prices, {
      '480p': { credits: 5 },
      '720p': { credits: 10 },
    });
    const serialized = JSON.stringify(item);
    for (const forbidden of [
      'provider', 'relay_host', 'base_url', 'config_id', 'cost', 'evidence_run_id',
      'catalog-primary.example', 'catalog-backup.example', 'secret-', 'upstream-',
    ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  } finally {
    db.close();
  }
});

test('shadow 不隐藏公共模型也不向用户暴露 would_be_hidden', () => {
  const db = createDb();
  try {
    const configId = addConfig(db, { name: 'shadow-catalog', priority: 100 });
    addEvidence(db, configId, REQUESTED, 'stale-shadow', 'stale');
    const item = catalog.list(db, { canaryMode: 'shadow', now: NOW })
      .find((row) => row.model === 'seedance-logical');
    assert.ok(item);
    assert.equal(JSON.stringify(item).includes('would_be_hidden'), false);
  } finally {
    db.close();
  }
});

test('全部线路从可公开变为不可公开时隐藏模型且 error 只写一次', () => {
  const db = createDb();
  try {
    const configId = addConfig(db, { name: 'transition-route', priority: 100 });
    const evidence = addEvidence(db, configId, REQUESTED, 'transition');
    assert.ok(catalog.list(db, { canaryMode: 'enforce', now: NOW })
      .some((row) => row.model === 'seedance-logical'));

    db.prepare(`UPDATE provider_canary_evidence
      SET state = 'stale', invalidated_at = ?, invalidation_reason = 'admin_invalidated', updated_at = ?
      WHERE config_id = ? AND capability_fingerprint = ?`)
      .run(
        '2026-08-18T00:01:00.000Z',
        '2026-08-18T00:01:00.000Z',
        configId,
        evidence.capability_fingerprint,
      );
    for (let index = 0; index < 2; index += 1) {
      assert.equal(catalog.list(db, {
        canaryMode: 'enforce', now: '2026-08-18T00:02:00.000Z',
      }).some((row) => row.model === 'seedance-logical'), false);
    }
    assert.deepEqual(db.prepare(`SELECT severity, event_type, logical_model_id, safe_details
      FROM provider_stability_events
      WHERE event_type = 'provider_canary_public_unavailable'`).all(), [{
      severity: 'error',
      event_type: 'provider_canary_public_unavailable',
      logical_model_id: 'seedance-logical',
      safe_details: '{"category":"fresh_evidence_unavailable"}',
    }]);
  } finally {
    db.close();
  }
});

test('enforce 不信任成本缺失、零成本或缺少对应分辨率 tier 的 fresh 证据', async (t) => {
  const scenarios = [
    {
      name: 'missing price',
      capability: REQUESTED,
      mutate(db) {
        db.prepare("DELETE FROM model_credit_prices WHERE model = 'seedance-logical'").run();
      },
    },
    {
      name: 'zero base cost',
      capability: { ...REQUESTED, resolution: null },
      mutate(db, configId) {
        db.prepare('DELETE FROM provider_route_resolution_costs WHERE config_id = ?').run(configId);
        db.prepare('UPDATE provider_route_costs SET micros_per_unit = 0 WHERE config_id = ?')
          .run(configId);
      },
    },
    {
      name: 'missing resolution tier',
      capability: REQUESTED,
      mutate(db, configId) {
        db.prepare("DELETE FROM provider_route_resolution_costs WHERE config_id = ? AND resolution = '720p'")
          .run(configId);
      },
    },
    {
      name: 'zero resolution tier cost',
      capability: REQUESTED,
      mutate(db, configId) {
        db.pragma('ignore_check_constraints = ON');
        db.prepare(`UPDATE provider_route_resolution_costs SET micros_per_unit = 0
          WHERE config_id = ? AND resolution = '720p'`).run(configId);
      },
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, () => {
      const db = createDb();
      try {
        const configId = addConfig(db, { name: `price-${scenario.name}`, priority: 100 });
        scenario.mutate(db, configId);
        addEvidence(db, configId, scenario.capability, `price-${scenario.name}`);
        let candidates = [];
        try {
          candidates = stability.selectVerifiedCandidates(db, {
            serviceType: 'video', logicalModelId: 'seedance-logical', primaryConfigId: configId,
            capabilities: scenario.capability, canaryMode: 'enforce', now: NOW,
          }).candidates;
        } catch (_) {}
        assert.deepEqual(candidates, []);
        assert.equal(catalog.list(db, { canaryMode: 'enforce', now: NOW })
          .some((row) => row.model === 'seedance-logical'), false);
      } finally {
        db.close();
      }
    });
  }
});

const EXPLICIT_BLOCK_SCENARIOS = [
  { name: 'stale', evidenceState: 'stale' },
  { name: 'failing', evidenceState: 'failing' },
  { name: 'submission_unknown', evidenceState: 'submission_unknown' },
  { name: 'budget_blocked', evidenceState: 'budget_blocked' },
  { name: 'open circuit', evidenceState: 'fresh', openCircuit: true },
  { name: 'insufficient capability', evidenceState: 'fresh', insufficient: true },
];

for (const serviceType of ['image', 'video']) {
  test(`public ${serviceType} 显式 config_id 在 enforce 下不能绕过证据和健康门禁`, async (t) => {
    const previous = process.env.PROVIDER_CANARY_MODE;
    let submissions = 0;
    const server = await listen((req, res) => {
      submissions += 1;
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(serviceType === 'image'
        ? { data: [{ url: 'https://cdn.example/public-gate.png' }] }
        : { id: 'public-gate-task', status: 'processing' }));
    });
    t.after(async () => {
      if (previous === undefined) delete process.env.PROVIDER_CANARY_MODE;
      else process.env.PROVIDER_CANARY_MODE = previous;
      await close(server);
    });
    process.env.PROVIDER_CANARY_MODE = 'enforce';

    for (const scenario of EXPLICIT_BLOCK_SCENARIOS) {
      await t.test(scenario.name, async () => {
        const db = createDb();
        try {
          const logicalModelId = `explicit-${serviceType}-${scenario.name}`;
          const upstreamModel = `upstream-${serviceType}-${scenario.name}`;
          const capabilities = serviceType === 'image'
            ? { resolutions: ['1k'], aspectRatios: ['1:1'], maxReferences: 2 }
            : { resolutions: ['720p'], aspectRatios: ['16:9'], durations: [5], maxReferences: 2 };
          modelPriceService.set(db, logicalModelId, 5, serviceType === 'image'
            ? { category: 'image', cost_unit: 'image', cost_micros_per_unit: 1000 }
            : {
              category: 'video', cost_unit: 'second', cost_micros_per_unit: 1000,
              resolution_prices: { '720p': { credits: 5, cost_micros_per_second: 1000 } },
            });
          const config = addPublicConfig(db, {
            serviceType,
            suffix: scenario.name,
            baseUrl: `http://127.0.0.1:${server.address().port}`,
            upstreamModel,
            logicalModelId,
            capabilities,
          });
          const requestedCapability = serviceType === 'image'
            ? { resolution: '1k', aspectRatio: '1:1', referenceImageCount: 2 }
            : { resolution: '720p', aspectRatio: '16:9', duration: 5, referenceImageCount: 2 };
          addEvidence(
            db,
            config.id,
            scenario.insufficient ? { ...requestedCapability, referenceImageCount: 1 } : requestedCapability,
            scenario.name,
            scenario.evidenceState,
          );
          if (scenario.openCircuit) {
            db.prepare(`INSERT INTO provider_route_health
              (config_id, state, consecutive_failures, open_until, updated_at)
              VALUES (?, 'open', 3, '2099-01-01T00:00:00.000Z', ?)`).run(config.id, NOW);
          }
          const before = submissions;
          const request = serviceType === 'image'
            ? {
              config_id: config.id,
              prompt: 'local public gate',
              model: upstreamModel,
              resolution: '1k',
              aspect_ratio: '1:1',
              reference_image_urls: ['https://refs.invalid/1.png', 'https://refs.invalid/2.png'],
            }
            : {
              config_id: config.id,
              prompt: 'local public gate',
              model: upstreamModel,
              duration: 5,
              resolution: '720p',
              aspect_ratio: '16:9',
              reference_urls: ['https://refs.invalid/1.png', 'https://refs.invalid/2.png'],
            };
          await assert.rejects(
            () => serviceType === 'image'
              ? imageClient.callImageApi(db, { info() {}, warn() {}, error() {} }, request)
              : videoClient.callVideoApi(db, { info() {}, warn() {}, error() {} }, request),
            /匹配|可用|验证|模型/,
          );
          assert.equal(submissions, before);
        } finally {
          db.close();
        }
      });
    }

    await t.test('canary internal ForConfigId remains executable', async () => {
      const db = createDb();
      try {
        const logicalModelId = `internal-${serviceType}`;
        const upstreamModel = `upstream-internal-${serviceType}`;
        const config = addPublicConfig(db, {
          serviceType,
          suffix: 'internal',
          baseUrl: `http://127.0.0.1:${server.address().port}`,
          upstreamModel,
          logicalModelId,
        });
        const before = submissions;
        const result = serviceType === 'image'
          ? await imageClient.callImageApiForConfigId(db, { info() {}, warn() {}, error() {} }, config.id, {
            prompt: 'internal canary', model: upstreamModel,
          })
          : await videoClient.callVideoApiForConfigId(db, { info() {}, warn() {}, error() {} }, config.id, {
            prompt: 'internal canary', model: upstreamModel, duration: 5,
          });
        assert.equal(submissions, before + 1);
        assert.ok(serviceType === 'image' ? result.image_url : result.task_id);
      } finally {
        db.close();
      }
    });
  });
}

test('enforce 下缺少 logical model 的 active legacy 配置不能直连上游', async (t) => {
  const previous = process.env.PROVIDER_CANARY_MODE;
  let submissions = 0;
  const server = await listen((req, res) => {
    submissions += 1;
    req.resume();
    if (req.url.includes('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'legacy text' } }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url.includes('/images/')
      ? { data: [{ url: 'https://cdn.example/legacy.png' }] }
      : { id: 'legacy-video-task', status: 'processing' }));
  });
  t.after(async () => {
    if (previous === undefined) delete process.env.PROVIDER_CANARY_MODE;
    else process.env.PROVIDER_CANARY_MODE = previous;
    await close(server);
  });
  process.env.PROVIDER_CANARY_MODE = 'enforce';
  const log = { info() {}, warn() {}, error() {}, errorw() {} };

  for (const serviceType of ['image', 'video', 'text']) {
    await t.test(`${serviceType} public legacy route`, async () => {
      const db = createDb();
      try {
        const { config, upstreamModel } = addLegacyPublicConfig(db, {
          serviceType,
          baseUrl: `http://127.0.0.1:${server.address().port}`,
        });
        const before = submissions;
        const invocation = serviceType === 'image'
          ? () => imageClient.callImageApi(db, log, { prompt: 'legacy', model: upstreamModel })
          : serviceType === 'video'
            ? () => videoClient.callVideoApi(db, log, {
              prompt: 'legacy', model: upstreamModel, duration: 5,
            })
            : () => aiClient.generateText(db, log, 'text', 'legacy', '', { model: upstreamModel });
        await assert.rejects(invocation, /匹配|可用|验证|路由|模型/);
        assert.equal(submissions, before);

        if (serviceType !== 'text') {
          await assert.rejects(
            () => serviceType === 'image'
              ? imageClient.callImageApi(db, log, {
                config_id: config.id, prompt: 'legacy explicit', model: upstreamModel,
              })
              : videoClient.callVideoApi(db, log, {
                config_id: config.id, prompt: 'legacy explicit', model: upstreamModel, duration: 5,
              }),
            /匹配|可用|验证|路由|模型/,
          );
          assert.equal(submissions, before);
        }
      } finally {
        db.close();
      }
    });
  }

  for (const serviceType of ['image', 'video']) {
    await t.test(`${serviceType} internal ForConfigId remains executable`, async () => {
      const db = createDb();
      try {
        const { config, upstreamModel } = addLegacyPublicConfig(db, {
          serviceType,
          baseUrl: `http://127.0.0.1:${server.address().port}`,
        });
        const before = submissions;
        const result = serviceType === 'image'
          ? await imageClient.callImageApiForConfigId(db, log, config.id, {
            prompt: 'internal legacy', model: upstreamModel,
          })
          : await videoClient.callVideoApiForConfigId(db, log, config.id, {
            prompt: 'internal legacy', model: upstreamModel, duration: 5,
          });
        assert.equal(submissions, before + 1);
        assert.ok(serviceType === 'image' ? result.image_url : result.task_id);
      } finally {
        db.close();
      }
    });
  }
});

test('公共路由和目录绝不把 expired open 或 half_open 当作用户探针', async (t) => {
  const scenarios = [
    { name: 'expired open', state: 'open', openUntil: '2026-08-17T00:00:00.000Z' },
    { name: 'half_open', state: 'half_open', openUntil: null },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, () => {
      const db = createDb();
      try {
        const configId = addConfig(db, { name: `health-${scenario.name}`, priority: 100 });
        addEvidence(db, configId, REQUESTED, `health-${scenario.name}`);
        db.prepare(`INSERT INTO provider_route_health
          (config_id, state, consecutive_failures, open_until, updated_at)
          VALUES (?, ?, 3, ?, ?)`).run(configId, scenario.state, scenario.openUntil, NOW);
        const selected = stability.selectVerifiedCandidates(db, {
          serviceType: 'video', logicalModelId: 'seedance-logical', primaryConfigId: configId,
          capabilities: REQUESTED, canaryMode: 'enforce', now: NOW,
        });
        assert.deepEqual(selected.candidates, []);
        assert.equal(catalog.list(db, { canaryMode: 'enforce', now: NOW })
          .some((row) => row.model === 'seedance-logical'), false);

        db.prepare(`UPDATE provider_route_health SET state = 'healthy', open_until = NULL,
          consecutive_failures = 0, half_open_claimed_at = NULL, updated_at = ? WHERE config_id = ?`)
          .run('2026-08-18T00:01:00.000Z', configId);
        assert.deepEqual(stability.selectVerifiedCandidates(db, {
          serviceType: 'video', logicalModelId: 'seedance-logical', primaryConfigId: configId,
          capabilities: REQUESTED, canaryMode: 'enforce', now: '2026-08-18T00:02:00.000Z',
        }).candidates.map((row) => row.id), [configId]);
        assert.equal(catalog.list(db, {
          canaryMode: 'enforce', now: '2026-08-18T00:02:00.000Z',
        }).some((row) => row.model === 'seedance-logical'), true);
      } finally {
        db.close();
      }
    });
  }
});

test('image video text 现有调用方省略 mode 时仍会在 enforce 提交前拦截无 fresh 证据线路', async () => {
  const previous = process.env.PROVIDER_CANARY_MODE;
  const db = createDb();
  const log = { info() {}, warn() {}, error() {}, errorw() {} };
  try {
    process.env.PROVIDER_CANARY_MODE = 'enforce';
    const definitions = [
      ['image', 'caller-image'],
      ['video', 'caller-video'],
      ['text', 'caller-text'],
    ];
    for (const [serviceType, logicalModelId] of definitions) {
      modelPriceService.set(db, logicalModelId, 5, {
        category: serviceType,
        ...(serviceType === 'video' ? {
          billing_unit: 'second',
          cost_unit: 'second',
          cost_micros_per_unit: 100,
        } : {}),
      });
      const config = aiConfigService.createConfig(db, log, {
        service_type: serviceType,
        provider: 'openai',
        api_protocol: 'openai',
        name: `${serviceType}-no-evidence`,
        base_url: 'https://must-not-be-contacted.invalid/v1',
        api_key: 'local-test-secret',
        model: [`upstream-${serviceType}`],
        default_model: `upstream-${serviceType}`,
        logical_model_id: logicalModelId,
        failover_enabled: false,
        settings: JSON.stringify({ canvas_capabilities: serviceType === 'video'
          ? { durations: [5] }
          : {} }),
      });
      db.prepare("UPDATE ai_service_configs SET verification_status = 'verified' WHERE id = ?")
        .run(config.id);
    }

    await assert.rejects(
      imageClient.callImageApi(db, log, { prompt: 'local', model: 'caller-image' }),
      /未配置与当前图片生成参数匹配的已验证模型/,
    );
    await assert.rejects(
      videoClient.callVideoApi(db, log, { prompt: 'local', model: 'caller-video', duration: 5 }),
      /未配置与当前视频生成参数匹配的已验证模型/,
    );
    await assert.rejects(
      aiClient.generateTextWithVision(
        db,
        log,
        'text',
        'local',
        '',
        { imageUrl: 'data:image/png;base64,iVBORw0KGgo=' },
        { model: 'caller-text', idempotency_key: 'caller-text-enforce' },
      ),
      (error) => error.code === 'TEXT_PROVIDER_UNAVAILABLE',
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM generation_route_requests').get().count, 0);
  } finally {
    if (previous === undefined) delete process.env.PROVIDER_CANARY_MODE;
    else process.env.PROVIDER_CANARY_MODE = previous;
    db.close();
  }
});
