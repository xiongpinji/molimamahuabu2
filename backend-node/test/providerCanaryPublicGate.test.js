'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiClient = require('../src/services/aiClient');
const aiConfigService = require('../src/services/aiConfigService');
const catalog = require('../src/services/canvasModelCatalogService');
const evidenceService = require('../src/services/providerCanaryEvidenceService');
const imageClient = require('../src/services/imageClient');
const modelPriceService = require('../src/services/modelPriceService');
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
  return Number(db.prepare(`INSERT INTO ai_service_configs
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
}

function costFingerprint(db) {
  const price = modelPriceService.list(db)
    .find((row) => row.model.toLowerCase() === 'seedance-logical');
  const tiers = Object.entries(price.resolution_prices || {})
    .map(([resolution, value]) => ({ resolution, ...value }));
  return evidenceService.costFingerprint(price, tiers);
}

function addEvidence(db, configId, capability, suffix, state = 'fresh') {
  const config = aiConfigService.getConfig(db, configId);
  const configFingerprint = evidenceService.configFingerprint(config);
  const runtime = runtimeService.runtimeFingerprintForConfig(config);
  assert.equal(runtime.ok, true, runtime.code);
  const normalized = evidenceService.normalizeCapability('video', capability);
  const capabilityFingerprint = evidenceService.capabilityFingerprint('video', normalized);
  const runId = `public-gate-${configId}-${suffix}`;
  const cost = costFingerprint(db);
  db.prepare(`INSERT INTO provider_canary_runs
    (id, idempotency_key, config_id, logical_model_id, service_type, capability_fingerprint,
     config_fingerprint, cost_fingerprint, runtime_fingerprint, provider_scope_key, state,
     reserved_cost_micros, actual_cost_micros, currency, budget_day, budget_month,
     created_at, finished_at, updated_at)
    VALUES (?, ?, ?, 'seedance-logical', 'video', ?, ?, ?, ?, ?, 'succeeded',
      1, 1, 'CNY', '2026-08-18', '2026-08', ?, ?, ?)`)
    .run(
      runId,
      `idem-${runId}`,
      configId,
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
    serviceType: 'video',
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
  try {
    process.env.PROVIDER_CANARY_MODE = 'EnForCe';
    const enforced = stability.selectVerifiedCandidates(db, {
      serviceType: 'video', logicalModelId: 'seedance-logical', primaryConfigId: ids.primary,
      capabilities: REQUESTED, now: NOW,
    });
    assert.deepEqual(enforced.candidates.map((row) => row.name), ['fresh-primary', 'fresh-backup']);

    process.env.PROVIDER_CANARY_MODE = 'invalid-mode';
    const invalidFallsBackOff = stability.selectVerifiedCandidates(db, {
      serviceType: 'video', logicalModelId: 'seedance-logical', primaryConfigId: ids.primary,
      capabilities: REQUESTED, now: NOW,
    });
    assert.equal(invalidFallsBackOff.candidates.some((row) => row.name === 'unknown-route'), true);
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

test('全部线路从可公开变为不可公开时隐藏模型且 P1 只写一次', () => {
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
      severity: 'P1',
      event_type: 'provider_canary_public_unavailable',
      logical_model_id: 'seedance-logical',
      safe_details: '{"category":"fresh_evidence_unavailable"}',
    }]);
  } finally {
    db.close();
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
