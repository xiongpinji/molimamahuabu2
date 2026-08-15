const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const modelPriceService = require('../src/services/modelPriceService');
const stability = require('../src/services/providerRouteStabilityService');

function createDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  modelPriceService.set(db, 'logical-image', 40, { category: 'image' });
  return db;
}

function addConfig(db, values = {}) {
  const now = '2026-08-15T00:00:00.000Z';
  return Number(db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, name, base_url, api_key, model, default_model, priority,
     is_default, is_active, settings, logical_model_id, failover_enabled,
     verification_status, created_at, updated_at)
    VALUES (@service_type, @provider, @name, @base_url, 'secret', @model, @default_model,
     @priority, 0, @is_active, @settings, @logical_model_id, @failover_enabled,
     @verification_status, @created_at, @updated_at)`)
    .run({
      service_type: 'image',
      provider: 'relay',
      name: 'Relay',
      base_url: 'https://relay.example/v1',
      model: JSON.stringify(['upstream-image']),
      default_model: 'upstream-image',
      priority: 10,
      is_active: 1,
      settings: JSON.stringify({
        canvas_capabilities: {
          resolutions: ['2k'],
          aspectRatios: ['16:9'],
          maxReferences: 9,
        },
      }),
      logical_model_id: 'logical-image',
      failover_enabled: 1,
      verification_status: 'verified',
      created_at: now,
      updated_at: now,
      ...values,
    }).lastInsertRowid);
}

test('selectVerifiedCandidates returns only compatible priced routes in deterministic order', () => {
  const db = createDb();
  try {
    const primaryId = addConfig(db, { provider: 'primary', priority: 100, failover_enabled: 0 });
    const degradedId = addConfig(db, { provider: 'degraded', priority: 95 });
    const healthyId = addConfig(db, { provider: 'healthy', priority: 90 });
    addConfig(db, { provider: 'not-opted-in', priority: 99, failover_enabled: 0 });
    addConfig(db, { provider: 'unverified', priority: 98, verification_status: 'failed' });
    addConfig(db, {
      provider: 'insufficient-capability',
      priority: 97,
      settings: JSON.stringify({ canvas_capabilities: { resolutions: ['1k'], maxReferences: 1 } }),
    });
    addConfig(db, { provider: 'other-model', priority: 96, logical_model_id: 'other-logical-model' });
    const openId = addConfig(db, { provider: 'open-route', priority: 94 });
    db.prepare(`INSERT INTO provider_route_health
      (config_id, state, consecutive_failures, updated_at) VALUES (?, 'degraded', 1, ?)`)
      .run(degradedId, '2026-08-15T00:00:00.000Z');
    db.prepare(`INSERT INTO provider_route_health
      (config_id, state, consecutive_failures, open_until, updated_at)
      VALUES (?, 'open', 3, '2026-08-15T01:00:00.000Z', ?)`)
      .run(openId, '2026-08-15T00:00:00.000Z');

    const selected = stability.selectVerifiedCandidates(db, {
      serviceType: 'image',
      logicalModelId: 'logical-image',
      primaryConfigId: primaryId,
      capabilities: { resolution: '2K', aspectRatio: '16:9', referenceImageCount: 2 },
      now: '2026-08-15T00:10:00.000Z',
    });

    assert.deepEqual(selected.candidates.map((row) => row.id), [primaryId, degradedId, healthyId]);
    assert.deepEqual(selected.userPriceSnapshot, { model: 'logical-image', credits: 40 });
    assert.equal(selected.capabilityFingerprint.includes('relay.example'), false);
  } finally {
    db.close();
  }
});

test('route requests and attempts are idempotent and preserve accepted provider identity', () => {
  const db = createDb();
  try {
    const configId = addConfig(db);
    const input = {
      id: 'request-1',
      idempotencyKey: 'tenant-1:image-1',
      serviceType: 'image',
      businessType: 'image_generation',
      businessId: '11',
      tenantId: 'tenant-1',
      userId: 'user-1',
      logicalModelId: 'logical-image',
      capabilities: { resolution: '2K' },
      userPriceSnapshot: { model: 'logical-image', credits: 40 },
      candidateConfigIds: [configId],
      creditReservationId: 'reservation-1',
      now: '2026-08-15T00:00:00.000Z',
    };
    const first = stability.createOrGetRouteRequest(db, input);
    const replay = stability.createOrGetRouteRequest(db, { ...input, id: 'request-2' });
    assert.equal(first.id, 'request-1');
    assert.equal(replay.id, 'request-1');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM generation_route_requests').get().count, 1);

    const attempt = stability.startAttempt(db, {
      requestId: first.id,
      configId,
      provider: 'relay',
      upstreamModel: 'upstream-image',
      now: input.now,
    });
    assert.equal(attempt.attempt_no, 1);
    const failed = stability.finishAttempt(db, {
      requestId: first.id,
      attemptNo: attempt.attempt_no,
      state: 'failed',
      httpStatus: 503,
      errorCategory: 'provider_unavailable',
      safeErrorSummary: 'prompt=private sk-secret https://signed.example/result?token=secret',
      now: input.now,
    });
    assert.equal(failed.safe_error_summary, 'category=provider_unavailable status=503');
    stability.recordAcceptedTask(db, {
      requestId: first.id,
      attemptNo: attempt.attempt_no,
      providerTaskId: 'provider-task-1',
      now: '2026-08-15T00:01:00.000Z',
    });
    stability.recordArtifactVerified(db, {
      requestId: first.id,
      attemptNo: attempt.attempt_no,
      configId,
      now: '2026-08-15T00:02:00.000Z',
    });

    assert.deepEqual(
      db.prepare('SELECT state, final_config_id FROM generation_route_requests WHERE id = ?').get(first.id),
      { state: 'succeeded', final_config_id: configId },
    );
    assert.deepEqual(
      db.prepare(`SELECT state, provider_task_id FROM generation_route_attempts
        WHERE request_id = ? AND attempt_no = 1`).get(first.id),
      { state: 'succeeded', provider_task_id: 'provider-task-1' },
    );
  } finally {
    db.close();
  }
});

test('infrastructure failures open the route while policy failures do not', () => {
  const db = createDb();
  try {
    const configId = addConfig(db);
    for (let index = 1; index <= 3; index += 1) {
      stability.recordFailureAndHealth(db, {
        configId,
        logicalModelId: 'logical-image',
        classification: {
          category: 'provider_unavailable',
          affectsHealth: true,
          disableConfig: false,
        },
        now: `2026-08-15T00:0${index}:00.000Z`,
      });
    }
    assert.deepEqual(
      db.prepare(`SELECT state, consecutive_failures, open_until
        FROM provider_route_health WHERE config_id = ?`).get(configId),
      { state: 'open', consecutive_failures: 3, open_until: '2026-08-15T00:08:00.000Z' },
    );

    stability.recordFailureAndHealth(db, {
      configId,
      logicalModelId: 'logical-image',
      classification: {
        category: 'policy_rejected',
        affectsHealth: false,
        disableConfig: false,
      },
      now: '2026-08-15T00:04:00.000Z',
    });
    assert.equal(
      db.prepare('SELECT consecutive_failures FROM provider_route_health WHERE config_id = ?').get(configId)
        .consecutive_failures,
      3,
    );
    assert.equal(stability.claimHalfOpen(db, configId, '2026-08-15T00:09:00.000Z'), true);
    assert.equal(stability.claimHalfOpen(db, configId, '2026-08-15T00:09:01.000Z'), false);
    assert.equal(stability.listAdminEvents(db, {}).every((event) => !JSON.stringify(event).includes('secret')), true);
  } finally {
    db.close();
  }
});

test('verification requires a completed generation with a readable local artifact', () => {
  const db = createDb();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-route-evidence-'));
  const artifactPath = path.join(tempDir, 'result.png');
  fs.writeFileSync(artifactPath, Buffer.from('readable-test-artifact'));
  try {
    const configId = addConfig(db, { verification_status: 'unverified' });
    const generationId = Number(db.prepare(`INSERT INTO image_generations
      (config_id, status, local_path, created_at, updated_at)
      VALUES (?, 'completed', ?, ?, ?)`)
      .run(configId, artifactPath, '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z').lastInsertRowid);

    const verified = stability.verifyConfigFromGenerationEvidence(db, {
      configId,
      serviceType: 'image',
      generationId,
      now: '2026-08-15T00:05:00.000Z',
    });
    assert.equal(verified.verification_status, 'verified');
    assert.equal(JSON.stringify(verified).includes(artifactPath), false);

    const failedConfigId = addConfig(db, { verification_status: 'unverified' });
    const missingGenerationId = Number(db.prepare(`INSERT INTO image_generations
      (config_id, status, local_path, created_at, updated_at)
      VALUES (?, 'completed', ?, ?, ?)`)
      .run(failedConfigId, path.join(tempDir, 'missing.png'), '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z').lastInsertRowid);
    assert.throws(
      () => stability.verifyConfigFromGenerationEvidence(db, {
        configId: failedConfigId,
        serviceType: 'image',
        generationId: missingGenerationId,
      }),
      (error) => error.code === 'VERIFICATION_ARTIFACT_UNREADABLE',
    );
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
