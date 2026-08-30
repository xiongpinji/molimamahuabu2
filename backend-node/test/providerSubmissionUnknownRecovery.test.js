const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const modelPriceService = require('../src/services/modelPriceService');
const stability = require('../src/services/providerRouteStabilityService');

function setupRoute() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  modelPriceService.set(db, 'wan3.0-video', 1, { category: 'video' });
  const now = '2026-08-30T00:00:00.000Z';
  const configId = Number(db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
     priority, is_default, is_active, settings, logical_model_id, failover_enabled,
     verification_status, created_at, updated_at)
    VALUES ('video', 'toapis_wan3', 'toapis_video', 'Wan3', 'https://toapis.xyz',
      'secret-key-must-not-leak', '["wan3.0-video"]', 'wan3.0-video', 10, 0, 1,
      '{"canvas_capabilities":{"resolutions":["480p"],"durations":[2]}}',
      'wan3.0-video', 0, 'verified', ?, ?)`)
    .run(now, now).lastInsertRowid);
  stability.createOrGetRouteRequest(db, {
    id: 'wan3-route-unknown',
    idempotencyKey: 'wan3-route-unknown',
    serviceType: 'video',
    businessType: 'video_generation',
    businessId: '901',
    tenantId: 'tenant-1',
    userId: 'user-1',
    logicalModelId: 'wan3.0-video',
    capabilities: { resolution: '480p', duration: 2 },
    userPriceSnapshot: { model: 'wan3.0-video', credits: 2 },
    candidateConfigIds: [configId],
    creditReservationId: 'reservation-901',
    now,
  });
  const attempt = stability.startAttempt(db, {
    requestId: 'wan3-route-unknown',
    configId,
    upstreamModel: 'wan3.0-video',
    now,
  });
  return { db, configId, attempt };
}

test('submission unknown stores a safe recovery event without pretending the recovery id is a provider task id', () => {
  const { db, configId, attempt } = setupRoute();
  try {
    const input = {
      requestId: 'wan3-route-unknown',
      attemptNo: attempt.attempt_no,
      recoveryTaskId: 'video-901',
      requestSha256: 'a'.repeat(64),
      requestBodySent: true,
      recoveryCode: 'TOAPIS_SUBMISSION_INDETERMINATE',
      httpStatus: 504,
      now: '2026-08-30T00:01:00.000Z',
      prompt: 'private prompt must not leak',
      apiKey: 'secret-key-must-not-leak',
      resultUrl: 'https://signed.example/result?token=hidden',
    };
    const stored = stability.recordSubmissionUnknownRecovery(db, input);

    assert.deepEqual(stored, {
      requestId: input.requestId,
      attemptNo: input.attemptNo,
      recoveryTaskId: input.recoveryTaskId,
      requestSha256: input.requestSha256,
      requestBodySent: true,
      recoveryCode: input.recoveryCode,
      httpStatus: 504,
    });
    assert.deepEqual(db.prepare(`SELECT state, provider_task_id, http_status, error_category,
      safe_error_summary, finished_at FROM generation_route_attempts
      WHERE request_id = ? AND attempt_no = ?`).get(input.requestId, input.attemptNo), {
      state: 'needs_attention',
      provider_task_id: null,
      http_status: 504,
      error_category: 'submission_unknown',
      safe_error_summary: 'category=submission_unknown status=504 code=TOAPIS_SUBMISSION_INDETERMINATE',
      finished_at: input.now,
    });
    assert.equal(db.prepare('SELECT state FROM generation_route_requests WHERE id = ?')
      .get(input.requestId).state, 'needs_attention');

    const event = db.prepare(`SELECT event_type, request_id, tenant_id, logical_model_id,
      config_id, task_state, credit_state, safe_details
      FROM provider_stability_events WHERE request_id = ?`).get(input.requestId);
    assert.equal(event.event_type, 'submission_unknown_recovery');
    assert.equal(event.config_id, configId);
    assert.equal(event.task_state, 'needs_attention');
    assert.equal(event.credit_state, 'held');
    assert.deepEqual(JSON.parse(event.safe_details), {
      httpStatus: 504,
      recoveryCode: 'TOAPIS_SUBMISSION_INDETERMINATE',
      recoveryTaskId: 'video-901',
      requestBodySent: true,
      requestSha256: 'a'.repeat(64),
    });
    const serialized = JSON.stringify(event);
    for (const sensitive of ['private prompt', 'secret-key', 'signed.example', 'token=hidden']) {
      assert.equal(serialized.includes(sensitive), false);
    }

    assert.deepEqual(stability.recordSubmissionUnknownRecovery(db, {
      ...input,
      httpStatus: 500,
      now: '2026-08-30T00:02:00.000Z',
    }), stored);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM provider_stability_events
      WHERE request_id = ? AND event_type = 'submission_unknown_recovery'`)
      .get(input.requestId).count, 1);
    assert.deepEqual(db.prepare(`SELECT http_status, finished_at FROM generation_route_attempts
      WHERE request_id = ? AND attempt_no = ?`).get(input.requestId, input.attemptNo), {
      http_status: 504,
      finished_at: input.now,
    });
  } finally {
    db.close();
  }
});

test('submission unknown rejects invalid or conflicting recovery metadata atomically', () => {
  const { db, attempt } = setupRoute();
  try {
    const base = {
      requestId: 'wan3-route-unknown',
      attemptNo: attempt.attempt_no,
      recoveryTaskId: 'video-901',
      requestSha256: 'b'.repeat(64),
      requestBodySent: true,
      recoveryCode: 'TOAPIS_SUBMISSION_INDETERMINATE',
      httpStatus: 504,
    };
    assert.throws(
      () => stability.recordSubmissionUnknownRecovery(db, { ...base, requestSha256: 'bad' }),
      (error) => error.code === 'PROVIDER_RECOVERY_METADATA_INVALID',
    );
    assert.equal(db.prepare('SELECT state FROM generation_route_attempts').get().state, 'submitting');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM provider_stability_events').get().count, 0);

    stability.recordSubmissionUnknownRecovery(db, base);
    assert.throws(
      () => stability.recordSubmissionUnknownRecovery(db, { ...base, recoveryTaskId: 'video-other' }),
      (error) => error.code === 'PROVIDER_RECOVERY_METADATA_CONFLICT',
    );
    assert.equal(db.prepare('SELECT provider_task_id FROM generation_route_attempts').get().provider_task_id, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM provider_stability_events').get().count, 1);
  } finally {
    db.close();
  }
});
