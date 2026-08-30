'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const modelPriceService = require('../src/services/modelPriceService');
const providerRouteCostService = require('../src/services/providerRouteCostService');
const {
  CONTRACT,
  finalizeConfiguration,
  loadFinalizeEvidence,
  prepareConfiguration,
  verifyConfiguration,
} = require('../../deploy/apply-toapis-wan3-video-config');

const MODEL = 'wan3.0-video';
const EVIDENCE_CONTRACT = 'toapis-wan3-video-real-verification-v1';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-wan3-config-'));
  const db = new Database(path.join(root, 'drama.db'));
  runMigrationsAndEnsure(db);
  modelPriceService.ensureSchema(db);
  const now = '2026-08-30T08:00:00.000Z';
  const sourceConfigId = Number(db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
     endpoint, query_endpoint, priority, is_default, is_active, verification_status,
     verified_capabilities, settings, logical_model_id, failover_enabled, canary_paused,
     created_at, updated_at)
    VALUES ('video', 'toapis', 'toapis_video', 'ToAPIs FAST', 'https://toapis.xyz',
      'shared-fast-secret', '["fumin-seedance-2.0-fast"]', 'fumin-seedance-2.0-fast',
      '/v1/videos/generations', '/v1/videos/generations/{taskId}', 11, 0, 1, 'verified',
      '{}', '{}', 'fumin-seedance-2.0-fast', 0, 0, ?, ?)`)
    .run(now, now).lastInsertRowid);
  const protectedConfigId = Number(db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
     priority, is_default, is_active, verification_status, verified_capabilities, settings,
     logical_model_id, failover_enabled, canary_paused, created_at, updated_at)
    VALUES ('video', 'protected', 'protected_video', 'Protected route', 'https://protected.example/v1',
      'protected-secret', '["protected-video"]', 'protected-video', 3, 1, 1, 'verified',
      '{"protected-video":{"durations":[5]}}', '{"owner":"admin"}', 'protected-video',
      1, 0, ?, ?)`)
    .run(now, now).lastInsertRowid);
  modelPriceService.set(db, 'protected-video', 77, {
    category: 'video', status: 'enabled', displayName: 'Protected price', publicNote: 'do not change',
    billingUnit: 'second', costUnit: 'second', cost_micros_per_unit: 123000,
    resolution_prices: { '720p': { credits: 77, cost_micros_per_second: 123000 } },
  });
  providerRouteCostService.setRouteCost(db, protectedConfigId, {
    currency: 'CNY', cost_unit: 'second', micros_per_unit: 123000,
    resolution_prices: { '720p': { micros_per_unit: 123000 } },
  }, { now });
  return { root, db, sourceConfigId, protectedConfigId, now };
}

function close(current) {
  current.db.close();
  fs.rmSync(current.root, { recursive: true, force: true });
}

function protectedSnapshot(current) {
  return {
    source: current.db.prepare('SELECT * FROM ai_service_configs WHERE id = ?').get(current.sourceConfigId),
    protectedConfig: current.db.prepare('SELECT * FROM ai_service_configs WHERE id = ?').get(current.protectedConfigId),
    protectedPrice: current.db.prepare("SELECT * FROM model_credit_prices WHERE model = 'protected-video'").get(),
    protectedTiers: current.db.prepare("SELECT * FROM model_resolution_prices WHERE model = 'protected-video' ORDER BY resolution").all(),
    protectedRouteCost: providerRouteCostService.getRouteCost(current.db, current.protectedConfigId),
  };
}

function wan3Snapshot(current, configId) {
  return {
    config: current.db.prepare('SELECT * FROM ai_service_configs WHERE id = ?').get(configId),
    price: current.db.prepare('SELECT * FROM model_credit_prices WHERE model = ? COLLATE NOCASE').get(MODEL),
    tiers: current.db.prepare('SELECT * FROM model_resolution_prices WHERE model = ? COLLATE NOCASE ORDER BY resolution').all(MODEL),
    routeCost: providerRouteCostService.getRouteCost(current.db, configId),
  };
}

function preparedPaths(current, suffix = 'prepare') {
  return {
    backupPath: path.join(current.root, `${suffix}-backup.db`),
    receiptPath: path.join(current.root, `${suffix}-receipt.json`),
  };
}

async function prepare(current, suffix = 'prepare') {
  return prepareConfiguration(current.db, {
    sourceConfigId: current.sourceConfigId,
    now: current.now,
    ...preparedPaths(current, suffix),
  });
}

function writeEvidence(current, targetConfigId, overrides = {}) {
  const credentialFingerprint = sha256('shared-fast-secret');
  const configFingerprint = sha256(JSON.stringify({
    id: String(targetConfigId),
    provider: 'toapis_wan3',
    model: MODEL,
    base_url: 'https://toapis.xyz',
    api_key: 'shared-fast-secret',
  }));
  const base = {
    contract_version: EVIDENCE_CONTRACT,
    provider_origin: 'https://toapis.xyz',
    generated_at: '2026-08-30T07:30:00.000Z',
    results: [{
      model: MODEL,
      mode: 't2v',
      requested_resolution: '480p',
      requested_ratio: '16:9',
      requested_duration: 2,
      requested_audio: false,
      status: 'completed',
      submission_state: 'accepted',
      post_count: 1,
      source_config_id: current.sourceConfigId,
      target_config_id: targetConfigId,
      config_id: targetConfigId,
      credential_fingerprint: credentialFingerprint,
      config_fingerprint: configFingerprint,
      request: {
        model: MODEL,
        prompt: 'A quiet two-second establishing shot.',
        duration: 2,
        ratio: '16:9',
        resolution: '480p',
        audio: false,
        client_business_id: 'molimama-wan3-smoke-test',
      },
      artifact: { output_file: 'wan3.mp4', sha256: 'a'.repeat(64), bytes: 4096 },
    }],
    verified_capabilities: {
      model: MODEL,
      text_to_video: true,
      resolutions: ['480p'],
      durations: [2],
      ratios: ['16:9'],
      audio_values: [false],
    },
  };
  const payload = {
    ...base,
    ...overrides,
    results: overrides.results || [{ ...base.results[0], ...(overrides.result || {}) }],
    verified_capabilities: overrides.verified_capabilities || base.verified_capabilities,
  };
  const evidencePath = path.join(current.root, `evidence-${crypto.randomUUID()}.json`);
  fs.writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`);
  return { evidencePath, evidence: loadFinalizeEvidence(evidencePath) };
}

function finalizeOptions(current, targetConfigId, suffix = 'finalize', overrides = {}) {
  return {
    sourceConfigId: current.sourceConfigId,
    targetConfigId,
    userCreditsPerSecond: 10,
    modelCostMicrosPerSecond: 350000,
    routeCostMicrosPerSecond: 360000,
    now: '2026-08-30T09:00:00.000Z',
    ...preparedPaths(current, suffix),
    ...overrides,
  };
}

test('prepare creates one independent inactive Wan3 route by copying only the source credential', async () => {
  const current = fixture();
  try {
    const before = protectedSnapshot(current);
    const result = await prepare(current);
    assert.equal(result.created, true);
    assert.equal(result.sourceConfigId, current.sourceConfigId);
    assert.equal(JSON.stringify(result).includes('shared-fast-secret'), false);
    const row = current.db.prepare('SELECT * FROM ai_service_configs WHERE id = ?').get(result.configId);
    assert.equal(row.provider, 'toapis_wan3');
    assert.equal(row.api_protocol, 'toapis_wan3_video');
    assert.equal(row.service_type, 'video');
    assert.equal(row.base_url, 'https://toapis.xyz');
    assert.deepEqual(JSON.parse(row.model), [MODEL]);
    assert.equal(row.default_model, MODEL);
    assert.equal(row.logical_model_id, MODEL);
    assert.equal(row.endpoint, '/v1/videos/generations');
    assert.equal(row.query_endpoint, '/v1/videos/generations/{taskId}');
    assert.equal(row.api_key, 'shared-fast-secret');
    assert.equal(row.is_active, 0);
    assert.equal(row.verification_status, 'unverified');
    assert.equal(row.canary_paused, 1);
    assert.equal(row.failover_enabled, 0);
    assert.equal(current.db.prepare("SELECT COUNT(*) count FROM ai_service_configs WHERE logical_model_id = ? COLLATE NOCASE").get(MODEL).count, 1);
    assert.equal(fs.existsSync(preparedPaths(current).backupPath), true);
    assert.equal(fs.existsSync(preparedPaths(current).receiptPath), true);
    assert.equal(fs.readFileSync(preparedPaths(current).receiptPath, 'utf8').includes('shared-fast-secret'), false);
    assert.deepEqual(protectedSnapshot(current), before);

    const reused = await prepareConfiguration(current.db, { sourceConfigId: current.sourceConfigId, now: current.now });
    assert.deepEqual(reused, {
      created: false,
      reused: true,
      configId: result.configId,
      sourceConfigId: current.sourceConfigId,
      state: 'prepared',
    });
  } finally { close(current); }
});

test('prepare refuses a duplicate logical Wan3 route or a non-ToAPIs source without changing protected rows', async () => {
  for (const mutate of [
    (current) => current.db.prepare(`INSERT INTO ai_service_configs
      (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
       logical_model_id, is_active, verification_status, created_at, updated_at)
      VALUES ('video', 'other', 'other', 'conflict', 'https://other.example', 'other-secret',
       '["wan3.0-video"]', 'wan3.0-video', 'wan3.0-video', 0, 'unverified', ?, ?)`)
      .run(current.now, current.now),
    (current) => current.db.prepare("UPDATE ai_service_configs SET api_protocol = 'other_video' WHERE id = ?")
      .run(current.sourceConfigId),
  ]) {
    const current = fixture();
    try {
      mutate(current);
      const before = protectedSnapshot(current);
      await assert.rejects(
        prepareConfiguration(current.db, {
          sourceConfigId: current.sourceConfigId,
          now: current.now,
          ...preparedPaths(current),
        }),
        /Wan3|ToAPIs|来源|冲突/,
      );
      assert.deepEqual(protectedSnapshot(current), before);
    } finally { close(current); }
  }
});

test('finalize fails closed until evidence targets the independent row and all user and route price inputs are explicit', async () => {
  const current = fixture();
  try {
    const prepared = await prepare(current);
    const before = protectedSnapshot(current);
    const wanBefore = wan3Snapshot(current, prepared.configId);
    const wrongTarget = writeEvidence(current, prepared.configId + 99).evidence;
    await assert.rejects(
      finalizeConfiguration(current.db, wrongTarget, finalizeOptions(current, prepared.configId, 'wrong-target')),
      /target|目标|配置/,
    );
    const exact = writeEvidence(current, prepared.configId).evidence;
    for (const missing of ['userCreditsPerSecond', 'modelCostMicrosPerSecond', 'routeCostMicrosPerSecond']) {
      const options = finalizeOptions(current, prepared.configId, `missing-${missing}`);
      delete options[missing];
      await assert.rejects(finalizeConfiguration(current.db, exact, options), /积分|成本|price|cost/i);
    }
    const row = current.db.prepare('SELECT * FROM ai_service_configs WHERE id = ?').get(prepared.configId);
    assert.equal(row.is_active, 0);
    assert.equal(row.verification_status, 'unverified');
    assert.equal(current.db.prepare('SELECT COUNT(*) count FROM model_credit_prices WHERE model = ?').get(MODEL).count, 0);
    assert.equal(providerRouteCostService.getRouteCost(current.db, prepared.configId), null);
    assert.deepEqual(wan3Snapshot(current, prepared.configId), wanBefore);
    assert.deepEqual(protectedSnapshot(current), before);
  } finally { close(current); }
});

test('finalize atomically binds exact evidence, the 480P user price and the independent route cost before activation', async () => {
  const current = fixture();
  try {
    const prepared = await prepare(current);
    const before = protectedSnapshot(current);
    const { evidence } = writeEvidence(current, prepared.configId);
    const result = await finalizeConfiguration(
      current.db,
      evidence,
      finalizeOptions(current, prepared.configId),
    );
    assert.equal(result.finalized, true);
    assert.equal(result.configId, prepared.configId);
    assert.equal(JSON.stringify(result).includes('shared-fast-secret'), false);
    const verified = verifyConfiguration(current.db, evidence, finalizeOptions(current, prepared.configId, 'unused'));
    assert.equal(verified.ok, true);

    const row = current.db.prepare('SELECT * FROM ai_service_configs WHERE id = ?').get(prepared.configId);
    assert.equal(row.is_active, 1);
    assert.equal(row.verification_status, 'verified');
    assert.equal(row.canary_paused, 0);
    assert.equal(row.api_key, 'shared-fast-secret');
    const capabilities = JSON.parse(row.verified_capabilities)[MODEL];
    assert.deepEqual(capabilities.durations, [2]);
    assert.deepEqual(capabilities.resolutions, ['480p']);
    assert.deepEqual(capabilities.aspectRatios, ['16:9']);
    assert.deepEqual(capabilities.audio_values, [false]);
    assert.equal(capabilities.supportsAudio, false);
    assert.equal(capabilities.maxReferences, 0);
    assert.equal(capabilities.evidence_contract, EVIDENCE_CONTRACT);
    assert.equal(capabilities.evidence_sha256, evidence.sha256);
    const settings = JSON.parse(row.settings);
    assert.equal(settings.integration_contract, CONTRACT);
    assert.equal(settings.source_config_id, current.sourceConfigId);
    assert.equal(settings.target_config_id, prepared.configId);
    assert.equal(settings.credential_fingerprint, sha256('shared-fast-secret'));

    const price = modelPriceService.list(current.db).find((item) => item.model === MODEL);
    assert.equal(price.credits, 10);
    assert.equal(price.billing_unit, 'second');
    assert.equal(price.cost_unit, 'second');
    assert.equal(price.cost_micros_per_unit, 350000);
    assert.deepEqual(price.resolution_prices, {
      '480p': { credits: 10, cost_micros_per_second: 350000 },
    });
    assert.deepEqual(providerRouteCostService.getRouteCost(current.db, prepared.configId), {
      config_id: prepared.configId,
      currency: 'CNY',
      cost_unit: 'second',
      micros_per_unit: 360000,
      input_cost_micros_per_1k: 0,
      output_cost_micros_per_1k: 0,
      updated_at: '2026-08-30T09:00:00.000Z',
      resolution_prices: { '480p': { micros_per_unit: 360000 } },
    });
    assert.equal(fs.existsSync(preparedPaths(current, 'finalize').backupPath), true);
    assert.equal(fs.existsSync(preparedPaths(current, 'finalize').receiptPath), true);
    assert.equal(fs.readFileSync(preparedPaths(current, 'finalize').receiptPath, 'utf8').includes('shared-fast-secret'), false);
    assert.deepEqual(protectedSnapshot(current), before);
  } finally { close(current); }
});

test('finalize rolls back prices, route cost and activation when the audit receipt cannot be persisted', async () => {
  const current = fixture();
  try {
    const prepared = await prepare(current);
    const { evidence } = writeEvidence(current, prepared.configId);
    const before = wan3Snapshot(current, prepared.configId);
    const blockedParent = path.join(current.root, 'receipt-parent-is-a-file');
    fs.writeFileSync(blockedParent, 'blocked');
    await assert.rejects(
      finalizeConfiguration(current.db, evidence, finalizeOptions(current, prepared.configId, 'rollback', {
        receiptPath: path.join(blockedParent, 'receipt.json'),
      })),
      /exist|directory|目录|路径/i,
    );
    assert.deepEqual(wan3Snapshot(current, prepared.configId), before);
  } finally { close(current); }
});

test('finalize rejects credential drift, over-claimed capabilities and pre-existing administrator pricing', async () => {
  const overClaimed = fixture();
  try {
    const prepared = await prepare(overClaimed);
    assert.throws(() => writeEvidence(overClaimed, prepared.configId, {
      verified_capabilities: {
        model: MODEL, text_to_video: true, resolutions: ['480p', '720p'], durations: [2],
        ratios: ['16:9'], audio_values: [false],
      },
    }), /能力/);
  } finally { close(overClaimed); }

  const referenced = fixture();
  try {
    const prepared = await prepare(referenced);
    assert.throws(() => writeEvidence(referenced, prepared.configId, {
      result: {
        request: {
          model: MODEL,
          prompt: 'Invalid referenced request.',
          duration: 2,
          ratio: '16:9',
          resolution: '480p',
          audio: false,
          reference_images: ['https://example.invalid/reference.jpg'],
        },
      },
    }), /无参考|纯文本/);
  } finally { close(referenced); }

  for (const arrange of [
    async (current, prepared) => {
      const result = writeEvidence(current, prepared.configId);
      result.evidence.payload.results[0].credential_fingerprint = 'f'.repeat(64);
      return result.evidence;
    },
    async (current, prepared) => {
      modelPriceService.set(current.db, MODEL, 99, {
        category: 'video', status: 'enabled', billingUnit: 'second', costUnit: 'second',
        cost_micros_per_unit: 999999,
        resolution_prices: { '480p': { credits: 99, cost_micros_per_second: 999999 } },
      });
      return writeEvidence(current, prepared.configId).evidence;
    },
  ]) {
    const current = fixture();
    try {
      const prepared = await prepare(current);
      const evidence = await arrange(current, prepared);
      const before = protectedSnapshot(current);
      const wanBefore = wan3Snapshot(current, prepared.configId);
      await assert.rejects(
        finalizeConfiguration(current.db, evidence, finalizeOptions(current, prepared.configId)),
        /凭据|能力|价格|管理员|evidence/i,
      );
      const row = current.db.prepare('SELECT * FROM ai_service_configs WHERE id = ?').get(prepared.configId);
      assert.equal(row.is_active, 0);
      assert.equal(row.verification_status, 'unverified');
      assert.equal(providerRouteCostService.getRouteCost(current.db, prepared.configId), null);
      assert.deepEqual(wan3Snapshot(current, prepared.configId), wanBefore);
      assert.deepEqual(protectedSnapshot(current), before);
    } finally { close(current); }
  }
});
