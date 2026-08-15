const fs = require('fs');

const aiConfigService = require('./aiConfigService');
const modelPriceService = require('./modelPriceService');
const { toSafeErrorSummary } = require('./providerErrorClassifier');

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_SECONDS = 300;

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function nonNegativeInteger(value) {
  const number = Number(value || 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function normalizeCapabilities(serviceType, capabilities = {}) {
  const normalized = { serviceType: String(serviceType || '').trim().toLowerCase() };
  const resolution = String(capabilities.resolution || '').trim().toLowerCase();
  const aspectRatio = String(capabilities.aspectRatio || '').trim();
  const duration = Number(capabilities.duration);
  if (resolution) normalized.resolution = resolution;
  if (aspectRatio) normalized.aspectRatio = aspectRatio;
  if (Number.isFinite(duration) && duration > 0) normalized.duration = duration;
  for (const field of ['referenceImageCount', 'referenceVideoCount', 'referenceAudioCount']) {
    const count = nonNegativeInteger(capabilities[field]);
    if (count) normalized[field] = count;
  }
  if (capabilities.requiresAudio === true) normalized.requiresAudio = true;
  return normalized;
}

function values(settings, field) {
  return Array.isArray(settings[field]) ? settings[field] : [];
}

function includesNormalized(items, value, lowerCase = false) {
  if (!value || items.length === 0) return true;
  const expected = lowerCase ? String(value).toLowerCase() : String(value);
  return items.some((item) => (lowerCase ? String(item).toLowerCase() : String(item)) === expected);
}

function capabilitiesForConfig(config) {
  const settings = parseJson(config.settings);
  const base = parseJson(settings.canvas_capabilities);
  const upstreamModel = config.default_model || (Array.isArray(config.model) ? config.model[0] : null);
  const perModel = parseJson(settings.canvas_capabilities_by_model?.[upstreamModel]);
  return { ...base, ...perModel };
}

function matchesCapabilities(config, requested) {
  const declared = capabilitiesForConfig(config);
  if (!includesNormalized(values(declared, 'resolutions'), requested.resolution, true)) return false;
  if (!includesNormalized(values(declared, 'aspectRatios'), requested.aspectRatio)) return false;
  if (!includesNormalized(values(declared, 'durations'), requested.duration)) return false;
  if (requested.referenceImageCount > nonNegativeInteger(declared.maxReferences)
    && Object.prototype.hasOwnProperty.call(declared, 'maxReferences')) return false;
  if (requested.referenceVideoCount > nonNegativeInteger(declared.maxVideoReferences)
    && Object.prototype.hasOwnProperty.call(declared, 'maxVideoReferences')) return false;
  if (requested.referenceAudioCount > nonNegativeInteger(declared.maxAudioReferences)
    && Object.prototype.hasOwnProperty.call(declared, 'maxAudioReferences')) return false;
  if (requested.requiresAudio && declared.supportsAudio === false) return false;
  return true;
}

function selectVerifiedCandidates(db, input) {
  const logicalModelId = modelPriceService.canonicalModel(input.logicalModelId);
  const credits = modelPriceService.requirePrice(db, logicalModelId);
  const requested = normalizeCapabilities(input.serviceType, input.capabilities);
  const now = input.now || new Date().toISOString();
  const rows = db.prepare(`SELECT c.*, h.state AS health_state, h.open_until
    FROM ai_service_configs c
    LEFT JOIN provider_route_health h ON h.config_id = c.id
    WHERE c.deleted_at IS NULL
      AND c.service_type = ?
      AND c.logical_model_id = ? COLLATE NOCASE
      AND c.is_active = 1
      AND c.verification_status = 'verified'
    ORDER BY c.priority DESC,
      CASE COALESCE(h.state, 'healthy')
        WHEN 'healthy' THEN 0 WHEN 'degraded' THEN 1 WHEN 'half_open' THEN 2 ELSE 3 END,
      c.id ASC`).all(String(input.serviceType || '').trim(), logicalModelId);
  const primaryConfigId = input.primaryConfigId == null ? rows[0]?.id : Number(input.primaryConfigId);
  const candidates = rows
    .map((row) => aiConfigService.getConfig(db, row.id))
    .filter(Boolean)
    .filter((config) => config.id === primaryConfigId || config.failover_enabled)
    .filter((config) => {
      const health = rows.find((row) => row.id === config.id);
      if (health?.health_state === 'disabled') return false;
      return health?.health_state !== 'open' || !health.open_until || health.open_until <= now;
    })
    .filter((config) => matchesCapabilities(config, requested));
  return {
    candidates,
    userPriceSnapshot: { model: logicalModelId, credits },
    capabilityFingerprint: stableJson(requested),
  };
}

function routeRequest(row) {
  if (!row) return null;
  return {
    ...row,
    user_price_snapshot: parseJson(row.user_price_snapshot, null),
    candidate_config_ids: parseJson(row.candidate_config_ids, []),
  };
}

function createOrGetRouteRequest(db, input) {
  const existing = db.prepare('SELECT * FROM generation_route_requests WHERE idempotency_key = ?')
    .get(input.idempotencyKey);
  if (existing) return routeRequest(existing);
  const now = input.now || new Date().toISOString();
  const capabilityFingerprint = stableJson(normalizeCapabilities(input.serviceType, input.capabilities));
  db.prepare(`INSERT INTO generation_route_requests
    (id, idempotency_key, service_type, business_type, business_id, tenant_id, user_id,
     logical_model_id, capability_fingerprint, user_price_snapshot, candidate_config_ids,
     state, credit_reservation_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?)`)
    .run(
      input.id,
      input.idempotencyKey,
      input.serviceType,
      input.businessType,
      input.businessId || null,
      input.tenantId || null,
      input.userId || null,
      modelPriceService.canonicalModel(input.logicalModelId),
      capabilityFingerprint,
      stableJson(input.userPriceSnapshot || null),
      stableJson(input.candidateConfigIds || []),
      input.creditReservationId || null,
      now,
      now,
    );
  return routeRequest(db.prepare('SELECT * FROM generation_route_requests WHERE id = ?').get(input.id));
}

function startAttempt(db, input) {
  return db.transaction(() => {
    const request = db.prepare('SELECT id FROM generation_route_requests WHERE id = ?').get(input.requestId);
    if (!request) throw new Error('路由请求不存在');
    const attemptNo = Number(db.prepare(`SELECT COALESCE(MAX(attempt_no), 0) + 1 AS attempt_no
      FROM generation_route_attempts WHERE request_id = ?`).get(input.requestId).attempt_no);
    const now = input.now || new Date().toISOString();
    const info = db.prepare(`INSERT INTO generation_route_attempts
      (request_id, attempt_no, config_id, provider, upstream_model, state, started_at)
      VALUES (?, ?, ?, ?, ?, 'submitting', ?)`)
      .run(input.requestId, attemptNo, input.configId, input.provider, input.upstreamModel, now);
    db.prepare("UPDATE generation_route_requests SET state = 'running', updated_at = ? WHERE id = ?")
      .run(now, input.requestId);
    return db.prepare('SELECT * FROM generation_route_attempts WHERE id = ?').get(info.lastInsertRowid);
  })();
}

function finishAttempt(db, input) {
  const now = input.now || new Date().toISOString();
  db.prepare(`UPDATE generation_route_attempts
    SET state = ?, http_status = ?, error_category = ?, safe_error_summary = ?,
      provider_cost_snapshot = ?, finished_at = ?
    WHERE request_id = ? AND attempt_no = ?`)
    .run(
      input.state,
      input.httpStatus ?? null,
      input.errorCategory || null,
      toSafeErrorSummary({ category: input.errorCategory, httpStatus: input.httpStatus }),
      input.providerCostSnapshot ? stableJson(input.providerCostSnapshot) : null,
      now,
      input.requestId,
      input.attemptNo,
    );
  return db.prepare(`SELECT * FROM generation_route_attempts
    WHERE request_id = ? AND attempt_no = ?`).get(input.requestId, input.attemptNo);
}

function recordAcceptedTask(db, input) {
  const now = input.now || new Date().toISOString();
  db.prepare(`UPDATE generation_route_attempts
    SET state = 'accepted', provider_task_id = ?
    WHERE request_id = ? AND attempt_no = ?`)
    .run(input.providerTaskId, input.requestId, input.attemptNo);
  db.prepare("UPDATE generation_route_requests SET state = 'accepted', updated_at = ? WHERE id = ?")
    .run(now, input.requestId);
}

function recordArtifactVerified(db, input) {
  const now = input.now || new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE generation_route_attempts SET state = 'succeeded', finished_at = ?
      WHERE request_id = ? AND attempt_no = ?`).run(now, input.requestId, input.attemptNo);
    db.prepare(`UPDATE generation_route_requests
      SET state = 'succeeded', final_config_id = ?, updated_at = ? WHERE id = ?`)
      .run(input.configId, now, input.requestId);
    db.prepare(`INSERT INTO provider_route_health
      (config_id, state, consecutive_failures, updated_at)
      VALUES (?, 'healthy', 0, ?)
      ON CONFLICT(config_id) DO UPDATE SET state = 'healthy', consecutive_failures = 0,
        open_until = NULL, half_open_claimed_at = NULL, last_error_category = NULL, updated_at = excluded.updated_at`)
      .run(input.configId, now);
  })();
}

function stabilitySettings(db, configId) {
  const row = db.prepare('SELECT settings FROM ai_service_configs WHERE id = ?').get(configId);
  const settings = parseJson(row?.settings).provider_stability || {};
  const failureThreshold = Number.isSafeInteger(Number(settings.failure_threshold))
    && Number(settings.failure_threshold) > 0 ? Number(settings.failure_threshold) : DEFAULT_FAILURE_THRESHOLD;
  const cooldownSeconds = Number.isSafeInteger(Number(settings.cooldown_seconds))
    && Number(settings.cooldown_seconds) > 0 ? Number(settings.cooldown_seconds) : DEFAULT_COOLDOWN_SECONDS;
  return { failureThreshold, cooldownSeconds };
}

function addSeconds(iso, seconds) {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

function insertEvent(db, event) {
  db.prepare(`INSERT INTO provider_stability_events
    (severity, event_type, request_id, tenant_id, user_ref, logical_model_id, config_id,
     target_config_id, task_state, credit_state, safe_details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      event.severity || 'warning',
      event.eventType,
      event.requestId || null,
      event.tenantId || null,
      event.userRef || null,
      event.logicalModelId || null,
      event.configId || null,
      event.targetConfigId || null,
      event.taskState || null,
      event.creditState || null,
      stableJson(event.safeDetails || {}),
      event.now || new Date().toISOString(),
    );
}

function recordFailureAndHealth(db, input) {
  const now = input.now || new Date().toISOString();
  const classification = input.classification || {};
  return db.transaction(() => {
    const current = db.prepare('SELECT * FROM provider_route_health WHERE config_id = ?').get(input.configId);
    const { failureThreshold, cooldownSeconds } = stabilitySettings(db, input.configId);
    let failures = Number(current?.consecutive_failures || 0);
    let state = current?.state || 'healthy';
    let openUntil = current?.open_until || null;
    if (classification.disableConfig) {
      state = 'disabled';
    } else if (classification.affectsHealth) {
      failures += 1;
      state = failures >= failureThreshold ? 'open' : 'degraded';
      openUntil = state === 'open' ? addSeconds(now, cooldownSeconds) : null;
    }
    db.prepare(`INSERT INTO provider_route_health
      (config_id, state, consecutive_failures, open_until, last_error_category, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(config_id) DO UPDATE SET state = excluded.state,
        consecutive_failures = excluded.consecutive_failures, open_until = excluded.open_until,
        last_error_category = excluded.last_error_category, updated_at = excluded.updated_at`)
      .run(input.configId, state, failures, openUntil, classification.category || 'unknown', now);
    insertEvent(db, {
      eventType: state === 'open' ? 'route_opened' : 'provider_failure',
      requestId: input.requestId,
      tenantId: input.tenantId,
      logicalModelId: input.logicalModelId,
      configId: input.configId,
      safeDetails: { category: classification.category || 'unknown', state },
      now,
    });
    return db.prepare('SELECT * FROM provider_route_health WHERE config_id = ?').get(input.configId);
  })();
}

function claimHalfOpen(db, configId, now = new Date().toISOString()) {
  const result = db.prepare(`UPDATE provider_route_health
    SET state = 'half_open', half_open_claimed_at = ?, updated_at = ?
    WHERE config_id = ? AND state = 'open' AND open_until <= ? AND half_open_claimed_at IS NULL`)
    .run(now, now, configId, now);
  return result.changes === 1;
}

function listAdminRoutes(db, filters = {}) {
  const clauses = [];
  const params = [];
  if (filters.state) {
    clauses.push('r.state = ?');
    params.push(filters.state);
  }
  if (filters.logicalModelId) {
    clauses.push('r.logical_model_id = ? COLLATE NOCASE');
    params.push(filters.logicalModelId);
  }
  return db.prepare(`SELECT r.* FROM generation_route_requests r
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY r.updated_at DESC LIMIT 200`).all(...params).map(routeRequest);
}

function listAdminEvents(db, filters = {}) {
  const clauses = [];
  const params = [];
  if (filters.eventType) {
    clauses.push('event_type = ?');
    params.push(filters.eventType);
  }
  if (filters.logicalModelId) {
    clauses.push('logical_model_id = ? COLLATE NOCASE');
    params.push(filters.logicalModelId);
  }
  return db.prepare(`SELECT * FROM provider_stability_events
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY created_at DESC, id DESC LIMIT 500`).all(...params)
    .map((row) => ({ ...row, safe_details: parseJson(row.safe_details) }));
}

function resetHealth(db, configId, actor = 'admin', now = new Date().toISOString()) {
  db.prepare(`INSERT INTO provider_route_health
    (config_id, state, consecutive_failures, updated_at)
    VALUES (?, 'healthy', 0, ?)
    ON CONFLICT(config_id) DO UPDATE SET state = 'healthy', consecutive_failures = 0,
      open_until = NULL, half_open_claimed_at = NULL, last_error_category = NULL,
      updated_at = excluded.updated_at`).run(configId, now);
  insertEvent(db, {
    severity: 'info',
    eventType: 'health_reset',
    configId,
    safeDetails: { actor: String(actor || 'admin').slice(0, 80) },
    now,
  });
  return db.prepare('SELECT * FROM provider_route_health WHERE config_id = ?').get(configId);
}

function verificationError() {
  const error = new Error('验证产物不可读');
  error.code = 'VERIFICATION_ARTIFACT_UNREADABLE';
  return error;
}

function verifyConfigFromGenerationEvidence(db, input) {
  const serviceType = String(input.serviceType || '').toLowerCase();
  const table = serviceType === 'video' ? 'video_generations'
    : ['image', 'storyboard_image'].includes(serviceType) ? 'image_generations' : null;
  if (!table) throw verificationError();
  const generation = db.prepare(`SELECT id, config_id, status, local_path FROM ${table} WHERE id = ?`)
    .get(input.generationId);
  const succeeded = ['completed', 'succeeded'].includes(String(generation?.status || '').toLowerCase());
  let readable = false;
  try {
    readable = Boolean(generation?.local_path && fs.statSync(generation.local_path).isFile()
      && fs.statSync(generation.local_path).size > 0);
  } catch (_) {}
  if (!generation || Number(generation.config_id) !== Number(input.configId) || !succeeded || !readable) {
    throw verificationError();
  }
  const now = input.now || new Date().toISOString();
  const evidence = {
    generationId: Number(generation.id),
    serviceType,
    artifactReadable: true,
  };
  db.prepare(`UPDATE ai_service_configs SET verification_status = 'verified', verified_at = ?,
    verification_evidence = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
    .run(now, stableJson(evidence), now, input.configId);
  const config = aiConfigService.getConfig(db, input.configId);
  return aiConfigService.toPublicConfig(config);
}

module.exports = {
  createOrGetRouteRequest,
  selectVerifiedCandidates,
  startAttempt,
  finishAttempt,
  recordAcceptedTask,
  recordArtifactVerified,
  recordFailureAndHealth,
  claimHalfOpen,
  listAdminRoutes,
  listAdminEvents,
  resetHealth,
  verifyConfigFromGenerationEvidence,
};
