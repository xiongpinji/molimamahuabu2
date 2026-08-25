const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiConfigService = require('../src/services/aiConfigService');
const modelPriceService = require('../src/services/modelPriceService');
const evidenceService = require('../src/services/providerCanaryEvidenceService');
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
    (service_type, provider, api_protocol, name, base_url, api_key, model, default_model, priority,
     is_default, is_active, settings, logical_model_id, failover_enabled,
     verification_status, created_at, updated_at)
    VALUES (@service_type, @provider, @api_protocol, @name, @base_url, @api_key, @model, @default_model,
     @priority, 0, @is_active, @settings, @logical_model_id, @failover_enabled,
     @verification_status, @created_at, @updated_at)`)
    .run({
      service_type: 'image',
      provider: 'relay',
      api_protocol: '  OPENAI  ',
      name: 'Relay',
      base_url: 'https://relay.example/v1',
      api_key: 'secret',
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
      provider: 'caller-provider-must-not-override-db',
      upstreamModel: 'upstream-image',
      now: input.now,
    });
    assert.equal(attempt.attempt_no, 1);
    assert.equal(attempt.provider, 'relay');
    const expectedFingerprint = evidenceService.configFingerprint(aiConfigService.getConfig(db, configId));
    assert.match(attempt.config_fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(attempt.config_fingerprint, expectedFingerprint);
    assert.equal(attempt.query_protocol, 'openai');
    assert.equal(attempt.provider_task_id, null);
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
      db.prepare(`SELECT state, provider_task_id, error_category, safe_error_summary
        FROM generation_route_attempts
        WHERE request_id = ? AND attempt_no = 1`).get(first.id),
      {
        state: 'succeeded',
        provider_task_id: 'provider-task-1',
        error_category: null,
        safe_error_summary: null,
      },
    );
  } finally {
    db.close();
  }
});

test('attempt fingerprint binds to the selected model declared capability snapshot', () => {
  const db = createDb();
  try {
    const model2k = { resolutions: ['2k'], maxReferences: 9 };
    const model4k = { resolutions: ['4k'], maxReferences: 0 };
    const configId = addConfig(db, {
      model: JSON.stringify(['upstream-image', 'upstream-image-4k']),
      settings: JSON.stringify({
        canvas_capabilities_by_model: {
          'upstream-image': model2k,
          'upstream-image-4k': model4k,
        },
      }),
    });
    const config = aiConfigService.getConfig(db, configId);
    const receipt2k = stability.buildAttemptReceipt(db, {
      configId,
      upstreamModel: 'upstream-image',
    });
    const receipt4k = stability.buildAttemptReceipt(db, {
      configId,
      upstreamModel: 'upstream-image-4k',
    });

    assert.deepEqual(receipt2k.capabilities, model2k);
    assert.deepEqual(receipt4k.capabilities, model4k);
    assert.equal(
      receipt2k.configFingerprint,
      evidenceService.configFingerprint({ ...config, capabilities: model2k }),
    );
    assert.equal(
      receipt4k.configFingerprint,
      evidenceService.configFingerprint({ ...config, capabilities: model4k }),
    );
    assert.notEqual(receipt2k.configFingerprint, receipt4k.configFingerprint);
  } finally {
    db.close();
  }
});

test('text routes without canvas capability metadata still start with an empty capability fingerprint', () => {
  const db = createDb();
  try {
    const configId = addConfig(db, {
      service_type: 'text',
      provider: 'openai',
      api_protocol: 'openai',
      model: JSON.stringify(['gpt-5.6-sol']),
      default_model: 'gpt-5.6-sol',
      endpoint: '/chat/completions',
      settings: JSON.stringify({ models: ['gpt-5.6-sol'] }),
      logical_model_id: 'gpt-5.6-sol',
    });
    stability.createOrGetRouteRequest(db, {
      id: 'text-route-without-capability-metadata',
      idempotencyKey: 'text-route-without-capability-metadata',
      serviceType: 'text',
      businessType: 'text_generation',
      logicalModelId: 'gpt-5.6-sol',
      candidateConfigIds: [configId],
    });

    const attempt = stability.startAttempt(db, {
      requestId: 'text-route-without-capability-metadata',
      configId,
      upstreamModel: 'gpt-5.6-sol',
    });
    const config = aiConfigService.getConfig(db, configId);

    assert.equal(attempt.state, 'submitting');
    assert.equal(
      attempt.config_fingerprint,
      evidenceService.configFingerprint({ ...config, capabilities: {} }),
    );
  } finally {
    db.close();
  }
});

test('non-text routes still reject missing capability metadata', () => {
  const db = createDb();
  try {
    const configId = addConfig(db, { settings: '{}' });
    stability.createOrGetRouteRequest(db, {
      id: 'image-route-without-capability-metadata',
      idempotencyKey: 'image-route-without-capability-metadata',
      serviceType: 'image',
      businessType: 'image_generation',
      logicalModelId: 'logical-image',
      candidateConfigIds: [configId],
    });

    assert.throws(
      () => stability.startAttempt(db, {
        requestId: 'image-route-without-capability-metadata',
        configId,
        upstreamModel: 'upstream-image',
      }),
      /config must include capabilities/,
    );
  } finally {
    db.close();
  }
});

test('attempt receipt construction fails closed before inserting when config identity is unavailable', () => {
  const db = createDb();
  try {
    const configId = addConfig(db);
    stability.createOrGetRouteRequest(db, {
      id: 'missing-receipt-config',
      idempotencyKey: 'missing-receipt-config',
      serviceType: 'image',
      businessType: 'image_generation',
      logicalModelId: 'logical-image',
      userPriceSnapshot: { model: 'logical-image', credits: 40 },
      candidateConfigIds: [configId],
    });

    assert.throws(
      () => stability.startAttempt(db, {
        requestId: 'missing-receipt-config',
        configId: configId + 999,
        provider: 'caller-value-must-not-be-used',
        upstreamModel: 'upstream-image',
      }),
      (error) => error.code === 'PROVIDER_TASK_CONFIG_NOT_FOUND',
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM generation_route_attempts').get().count, 0);

    db.prepare("UPDATE ai_service_configs SET base_url = '' WHERE id = ?").run(configId);
    assert.throws(() => stability.startAttempt(db, {
      requestId: 'missing-receipt-config',
      configId,
      provider: 'relay',
      upstreamModel: 'upstream-image',
    }));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM generation_route_attempts').get().count, 0);
    assert.equal(
      db.prepare('SELECT state FROM generation_route_requests WHERE id = ?').get('missing-receipt-config').state,
      'created',
    );
  } finally {
    db.close();
  }
});

test('accepted provider task receipt is write-once, same-value idempotent, and conflict-atomic', () => {
  const db = createDb();
  try {
    const configId = addConfig(db);
    stability.createOrGetRouteRequest(db, {
      id: 'accepted-task-write-once',
      idempotencyKey: 'accepted-task-write-once',
      serviceType: 'image',
      businessType: 'image_generation',
      logicalModelId: 'logical-image',
      userPriceSnapshot: { model: 'logical-image', credits: 40 },
      candidateConfigIds: [configId],
    });
    const attempt = stability.startAttempt(db, {
      requestId: 'accepted-task-write-once',
      configId,
      provider: 'relay',
      upstreamModel: 'upstream-image',
    });

    stability.recordAcceptedTask(db, {
      requestId: 'accepted-task-write-once',
      attemptNo: attempt.attempt_no,
      providerTaskId: 'provider-task-fixed',
      now: '2026-08-15T00:01:00.000Z',
    });
    const acceptedAfterFirstWrite = db.prepare('SELECT state, updated_at FROM generation_route_requests WHERE id = ?')
      .get('accepted-task-write-once');
    stability.recordAcceptedTask(db, {
      requestId: 'accepted-task-write-once',
      attemptNo: attempt.attempt_no,
      providerTaskId: 'provider-task-fixed',
      now: '2026-08-15T00:02:00.000Z',
    });
    assert.deepEqual(
      db.prepare('SELECT state, updated_at FROM generation_route_requests WHERE id = ?')
        .get('accepted-task-write-once'),
      acceptedAfterFirstWrite,
    );
    const acceptedBeforeConflict = db.prepare(`SELECT state, provider_task_id
      FROM generation_route_attempts WHERE request_id = ? AND attempt_no = ?`)
      .get('accepted-task-write-once', attempt.attempt_no);
    const requestBeforeConflict = db.prepare('SELECT state, updated_at FROM generation_route_requests WHERE id = ?')
      .get('accepted-task-write-once');

    assert.throws(
      () => stability.recordAcceptedTask(db, {
        requestId: 'accepted-task-write-once',
        attemptNo: attempt.attempt_no,
        providerTaskId: 'provider-task-conflict',
      }),
      (error) => error.code === 'PROVIDER_TASK_RECEIPT_CONFLICT',
    );
    assert.deepEqual(
      db.prepare(`SELECT state, provider_task_id FROM generation_route_attempts
        WHERE request_id = ? AND attempt_no = ?`).get('accepted-task-write-once', attempt.attempt_no),
      acceptedBeforeConflict,
    );
    assert.deepEqual(
      db.prepare('SELECT state, updated_at FROM generation_route_requests WHERE id = ?')
        .get('accepted-task-write-once'),
      requestBeforeConflict,
    );
    assert.throws(() => stability.recordAcceptedTask(db, {
      requestId: 'accepted-task-write-once',
      attemptNo: attempt.attempt_no,
      providerTaskId: '   ',
    }));
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

test('expired circuit permits only one half-open attempt', () => {
  const db = createDb();
  try {
    const configId = addConfig(db);
    db.prepare(`INSERT INTO provider_route_health
      (config_id, state, consecutive_failures, open_until, updated_at)
      VALUES (?, 'open', 3, '2026-08-15T00:08:00.000Z', '2026-08-15T00:03:00.000Z')`)
      .run(configId);
    for (const requestId of ['half-open-1', 'half-open-2']) {
      stability.createOrGetRouteRequest(db, {
        id: requestId,
        idempotencyKey: requestId,
        serviceType: 'image',
        businessType: 'image_generation',
        businessId: requestId,
        logicalModelId: 'logical-image',
        userPriceSnapshot: { model: 'logical-image', credits: 40 },
        candidateConfigIds: [configId],
        now: '2026-08-15T00:09:00.000Z',
      });
    }

    const first = stability.startAttempt(db, {
      requestId: 'half-open-1', configId, provider: 'relay', upstreamModel: 'upstream-image',
      now: '2026-08-15T00:09:00.000Z',
    });
    const second = stability.startAttempt(db, {
      requestId: 'half-open-2', configId, provider: 'relay', upstreamModel: 'upstream-image',
      now: '2026-08-15T00:09:01.000Z',
    });

    assert.ok(first);
    assert.equal(second, null);
    assert.deepEqual(
      db.prepare('SELECT state, half_open_claimed_at FROM provider_route_health WHERE config_id = ?')
        .get(configId),
      { state: 'half_open', half_open_claimed_at: '2026-08-15T00:09:00.000Z' },
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM generation_route_attempts').get().count, 1);

    stability.recordFailureAndHealth(db, {
      requestId: 'half-open-1',
      configId,
      logicalModelId: 'logical-image',
      classification: {
        category: 'provider_unavailable',
        affectsHealth: true,
        disableConfig: false,
      },
      now: '2026-08-15T00:09:02.000Z',
    });
    assert.deepEqual(
      db.prepare(`SELECT state, open_until, half_open_claimed_at
        FROM provider_route_health WHERE config_id = ?`).get(configId),
      { state: 'open', open_until: '2026-08-15T00:14:02.000Z', half_open_claimed_at: null },
    );
    const retry = stability.startAttempt(db, {
      requestId: 'half-open-2', configId, provider: 'relay', upstreamModel: 'upstream-image',
      now: '2026-08-15T00:15:00.000Z',
    });
    assert.ok(retry);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM generation_route_attempts').get().count, 2);
  } finally {
    db.close();
  }
});

test('non-health terminal response releases a claimed half-open route', () => {
  const db = createDb();
  try {
    const configId = addConfig(db);
    db.prepare(`INSERT INTO provider_route_health
      (config_id, state, consecutive_failures, open_until, updated_at)
      VALUES (?, 'open', 3, '2026-08-15T00:08:00.000Z', '2026-08-15T00:03:00.000Z')`)
      .run(configId);
    for (const requestId of ['policy-probe-1', 'policy-probe-2']) {
      stability.createOrGetRouteRequest(db, {
        id: requestId,
        idempotencyKey: requestId,
        serviceType: 'image',
        businessType: 'image_generation',
        businessId: requestId,
        logicalModelId: 'logical-image',
        userPriceSnapshot: { model: 'logical-image', credits: 40 },
        candidateConfigIds: [configId],
        now: '2026-08-15T00:09:00.000Z',
      });
    }
    assert.ok(stability.startAttempt(db, {
      requestId: 'policy-probe-1', configId, provider: 'relay', upstreamModel: 'upstream-image',
      now: '2026-08-15T00:09:00.000Z',
    }));
    stability.recordFailureAndHealth(db, {
      requestId: 'policy-probe-1',
      configId,
      logicalModelId: 'logical-image',
      classification: {
        category: 'policy_rejected',
        affectsHealth: false,
        disableConfig: false,
      },
      now: '2026-08-15T00:09:01.000Z',
    });

    assert.deepEqual(
      db.prepare(`SELECT state, consecutive_failures, open_until, half_open_claimed_at
        FROM provider_route_health WHERE config_id = ?`).get(configId),
      { state: 'healthy', consecutive_failures: 0, open_until: null, half_open_claimed_at: null },
    );
    assert.ok(stability.startAttempt(db, {
      requestId: 'policy-probe-2', configId, provider: 'relay', upstreamModel: 'upstream-image',
      now: '2026-08-15T00:09:02.000Z',
    }));
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
