const fs = require('fs');
const crypto = require('crypto');

const defaultLog = require('../logger');
const aiConfigService = require('./aiConfigService');
const modelPriceService = require('./modelPriceService');
const routeCostService = require('./providerRouteCostService');
const evidenceService = require('./providerCanaryEvidenceService');
const runtimeService = require('./providerRuntimeFingerprintService');
const budgetService = require('./providerCanaryBudgetService');
const artifactService = require('./providerCanaryArtifactService');
const auditEvent = require('./auditEventService');
const { classifyProviderFailure, toSafeErrorSummary } = require('./providerErrorClassifier');

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_SECONDS = 300;
const VALID_CANARY_MODES = new Set(['off', 'shadow', 'enforce']);
let invalidCanaryModeLogged = false;

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

function capabilitiesForConfig(config, upstreamModel) {
  const settings = parseJson(config.settings);
  const base = parseJson(settings.canvas_capabilities);
  const selectedModel = upstreamModel || config.default_model
    || (Array.isArray(config.model) ? config.model[0] : null);
  const perModel = parseJson(settings.canvas_capabilities_by_model?.[selectedModel]);
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

function resolveCanaryMode(value, log = defaultLog) {
  const raw = value === undefined ? process.env.PROVIDER_CANARY_MODE : value;
  const mode = String(raw == null || raw === '' ? 'off' : raw).trim().toLowerCase();
  if (VALID_CANARY_MODES.has(mode)) return mode;
  if (!invalidCanaryModeLogged) {
    invalidCanaryModeLogged = true;
    log?.error?.('Invalid provider canary mode; using off');
  }
  return 'off';
}

function priceSnapshot(db, config) {
  const model = String(config.logical_model_id || config.default_model || config.model?.[0] || '').trim();
  return modelPriceService.list(db)
    .find((row) => row.model.toLowerCase() === model.toLowerCase()) || null;
}

function positiveInteger(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function currentPriceCoversCapability(db, config, capability = {}) {
  const price = priceSnapshot(db, config);
  if (!price || price.status !== 'enabled' || !positiveInteger(price.credits)) return false;
  const serviceType = String(config.service_type || '').trim().toLowerCase();
  if (serviceType === 'video') {
    if (capability.duration != null && !positiveInteger(capability.duration)) return false;
    const resolution = String(capability.resolution || '').trim().toLowerCase();
    if (resolution) {
      const tier = price.resolution_prices?.[resolution];
      if (!positiveInteger(tier?.credits)) return false;
    }
  }
  return routeCostService.routeCostCoversCapability(db, config.id, capability);
}

function evidenceFingerprints(db, config) {
  try {
    const cost = routeCostService.getRouteCost(db, config.id);
    if (!cost) return null;
    const runtime = runtimeService.runtimeFingerprintForConfig(config);
    if (!runtime.ok || !runtime.fingerprint) return null;
    return {
      configFingerprint: evidenceService.configFingerprint(config),
      costFingerprint: routeCostService.fingerprintRouteCost(cost),
      runtimeFingerprint: runtime.fingerprint,
    };
  } catch (_) {
    return null;
  }
}

function freshEvidenceForCapability(db, config, capability, now, fingerprints = evidenceFingerprints(db, config)) {
  if (!currentPriceCoversCapability(db, config, capability)) return [];
  if (!fingerprints) return [];
  return evidenceService.listFreshCoveringEvidence(db, {
    serviceType: config.service_type,
    logicalModelId: config.logical_model_id,
    configId: config.id,
    capability,
    now,
    ...fingerprints,
  });
}

function availableConfigs(rows, db, primaryConfigId) {
  return rows
    .map((row) => aiConfigService.getConfig(db, row.id))
    .filter(Boolean)
    .filter((config) => config.id === primaryConfigId || config.failover_enabled)
    .filter((config) => {
      const health = rows.find((row) => row.id === config.id);
      return !['disabled', 'open', 'half_open'].includes(health?.health_state);
    });
}

function listFreshCandidateEvidence(db, configs, now = new Date().toISOString()) {
  const byService = new Map();
  for (const config of configs || []) {
    const serviceType = String(config?.service_type || '').trim().toLowerCase();
    if (!serviceType) continue;
    if (!byService.has(serviceType)) byService.set(serviceType, []);
    byService.get(serviceType).push(config);
  }
  const result = [];
  for (const group of byService.values()) {
    const ordered = [...group].sort((left, right) => (
      Number(right.priority || 0) - Number(left.priority || 0) || Number(left.id) - Number(right.id)
    ));
    const configIds = ordered.map((config) => config.id);
    if (!configIds.length) continue;
    const placeholders = configIds.map(() => '?').join(',');
    const healthRows = db.prepare(`SELECT c.id, h.state AS health_state
      FROM ai_service_configs c
      LEFT JOIN provider_route_health h ON h.config_id = c.id
      WHERE c.id IN (${placeholders})`).all(...configIds);
    const healthById = new Map(healthRows.map((row) => [row.id, row]));
    const primaryConfigId = ordered[0].id;
    const candidates = ordered
      .filter((config) => config.id === primaryConfigId || config.failover_enabled)
      .filter((config) => {
        const health = healthById.get(config.id);
        return !['disabled', 'open', 'half_open'].includes(health?.health_state);
      });
    for (const config of candidates) {
      const fingerprints = evidenceFingerprints(db, config);
      if (!fingerprints) continue;
      const rawRows = db.prepare(`SELECT capability_fingerprint, capability_json
        FROM provider_canary_evidence WHERE config_id = ? ORDER BY capability_fingerprint`)
        .all(config.id);
      for (const raw of rawRows) {
        let capability;
        try { capability = JSON.parse(raw.capability_json); } catch (_) { continue; }
        const matching = freshEvidenceForCapability(db, config, capability, now, fingerprints)
          .find((row) => row.capability_fingerprint === raw.capability_fingerprint);
        if (matching) result.push(matching);
      }
    }
  }
  return result;
}

function selectVerifiedCandidates(db, input) {
  const logicalModelId = modelPriceService.canonicalModel(input.logicalModelId);
  const credits = modelPriceService.requirePrice(db, logicalModelId);
  const requested = normalizeCapabilities(input.serviceType, input.capabilities);
  const now = input.now || new Date().toISOString();
  const rows = db.prepare(`SELECT c.*, h.state AS health_state
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
  const currentCandidates = availableConfigs(rows, db, primaryConfigId)
    .filter((config) => matchesCapabilities(config, requested));
  const canaryMode = resolveCanaryMode(input.canaryMode, input.log);
  const evidenceByConfig = canaryMode === 'off'
    ? new Map()
    : new Map(currentCandidates.map((config) => [
      config.id,
      freshEvidenceForCapability(db, config, input.capabilities || {}, now),
    ]));
  const candidates = canaryMode === 'enforce'
    ? currentCandidates.filter((config) => evidenceByConfig.get(config.id)?.length)
    : canaryMode === 'shadow'
      ? currentCandidates.map((config) => ({
        ...config,
        would_be_hidden: !evidenceByConfig.get(config.id)?.length,
      }))
      : currentCandidates;
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

function normalizedQueryProtocol(input, config) {
  for (const value of [input.queryProtocol, config.api_protocol, config.provider, 'auto']) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized) return normalized;
  }
  return 'auto';
}

function buildAttemptReceipt(db, input) {
  const config = aiConfigService.getConfig(db, input.configId);
  if (!config) {
    const error = new Error('供应商配置不存在');
    error.code = 'PROVIDER_TASK_CONFIG_NOT_FOUND';
    throw error;
  }
  const upstreamModel = String(input.upstreamModel || config.default_model || '').trim();
  if (!upstreamModel) throw new TypeError('upstream model is required');
  const queryProtocol = normalizedQueryProtocol(input, config);
  const capabilities = capabilitiesForConfig(config, upstreamModel);
  return {
    serviceType: String(config.service_type || input.serviceType || '').trim().toLowerCase(),
    provider: config.provider,
    upstreamModel,
    queryProtocol,
    capabilities,
    configFingerprint: evidenceService.configFingerprint({
      serviceType: config.service_type || input.serviceType,
      apiKey: config.api_key,
      baseUrl: config.base_url,
      protocol: queryProtocol,
      provider: config.provider,
      upstreamModel,
      capabilities,
    }),
  };
}

function startAttempt(db, input) {
  return db.transaction(() => {
    const request = db.prepare('SELECT id, service_type FROM generation_route_requests WHERE id = ?')
      .get(input.requestId);
    if (!request) throw new Error('路由请求不存在');
    const receipt = buildAttemptReceipt(db, { ...input, serviceType: request.service_type });
    const now = input.now || new Date().toISOString();
    const health = db.prepare(`SELECT state, open_until FROM provider_route_health
      WHERE config_id = ?`).get(input.configId);
    if (health?.state === 'disabled' || health?.state === 'half_open') return null;
    if (health?.state === 'open') {
      if (!health.open_until || health.open_until > now) return null;
      if (!claimHalfOpen(db, input.configId, now)) return null;
    }
    const attemptNo = Number(db.prepare(`SELECT COALESCE(MAX(attempt_no), 0) + 1 AS attempt_no
      FROM generation_route_attempts WHERE request_id = ?`).get(input.requestId).attempt_no);
    const info = db.prepare(`INSERT INTO generation_route_attempts
      (request_id, attempt_no, config_id, provider, upstream_model, config_fingerprint,
       query_protocol, state, provider_task_id, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'submitting', NULL, ?)`)
      .run(
        input.requestId,
        attemptNo,
        input.configId,
        receipt.provider,
        receipt.upstreamModel,
        receipt.configFingerprint,
        receipt.queryProtocol,
        now,
      );
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
  const providerTaskId = String(input.providerTaskId || '').trim();
  if (!providerTaskId) {
    const error = new Error('供应商任务号不能为空');
    error.code = 'PROVIDER_TASK_RECEIPT_INVALID';
    throw error;
  }
  return db.transaction(() => {
    const attempt = db.prepare(`SELECT * FROM generation_route_attempts
      WHERE request_id = ? AND attempt_no = ?`).get(input.requestId, input.attemptNo);
    if (!attempt) throw new Error('路由尝试不存在');
    if (attempt.provider_task_id != null) {
      if (attempt.provider_task_id === providerTaskId) return attempt;
      const error = new Error('供应商任务号与已固化凭证冲突');
      error.code = 'PROVIDER_TASK_RECEIPT_CONFLICT';
      throw error;
    }
    const now = input.now || new Date().toISOString();
    db.prepare(`UPDATE generation_route_attempts
      SET state = 'accepted', provider_task_id = ?
      WHERE request_id = ? AND attempt_no = ? AND provider_task_id IS NULL`)
      .run(providerTaskId, input.requestId, input.attemptNo);
    db.prepare("UPDATE generation_route_requests SET state = 'accepted', updated_at = ? WHERE id = ?")
      .run(now, input.requestId);
    return db.prepare(`SELECT * FROM generation_route_attempts
      WHERE request_id = ? AND attempt_no = ?`).get(input.requestId, input.attemptNo);
  })();
}

function recordArtifactVerified(db, input) {
  const now = input.now || new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE generation_route_attempts SET state = 'succeeded', error_category = NULL,
      safe_error_summary = NULL, finished_at = ?
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

function recordBusinessArtifactUnreadable(db, input) {
  const route = db.prepare(`SELECT r.id AS request_id, r.logical_model_id, r.tenant_id,
      a.attempt_no, a.config_id
    FROM generation_route_requests r
    JOIN generation_route_attempts a ON a.request_id = r.id
    WHERE r.business_type = ? AND r.business_id = ?
    ORDER BY a.attempt_no DESC LIMIT 1`).get(
    String(input.businessType || ''),
    String(input.businessId || ''),
  );
  if (!route) return false;
  const classification = classifyProviderFailure({ httpStatus: 200, artifactReadable: false });
  finishAttempt(db, {
    requestId: route.request_id,
    attemptNo: route.attempt_no,
    state: classification.category,
    httpStatus: 200,
    errorCategory: classification.category,
  });
  recordFailureAndHealth(db, {
    requestId: route.request_id,
    tenantId: route.tenant_id,
    configId: route.config_id,
    logicalModelId: route.logical_model_id,
    classification,
  });
  db.prepare("UPDATE generation_route_requests SET state = 'needs_attention', updated_at = ? WHERE id = ?")
    .run(input.now || new Date().toISOString(), route.request_id);
  return true;
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
      openUntil = null;
    } else if (classification.affectsHealth) {
      failures += 1;
      state = failures >= failureThreshold ? 'open' : 'degraded';
      openUntil = state === 'open' ? addSeconds(now, cooldownSeconds) : null;
    } else if (current?.state === 'half_open') {
      failures = 0;
      state = 'healthy';
      openUntil = null;
    }
    db.prepare(`INSERT INTO provider_route_health
      (config_id, state, consecutive_failures, open_until, last_error_category, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(config_id) DO UPDATE SET state = excluded.state,
        consecutive_failures = excluded.consecutive_failures, open_until = excluded.open_until,
        half_open_claimed_at = NULL, last_error_category = excluded.last_error_category,
        updated_at = excluded.updated_at`)
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

function recordRouteSwitch(db, input) {
  insertEvent(db, {
    eventType: 'route_switched',
    requestId: input.requestId,
    tenantId: input.tenantId,
    logicalModelId: input.logicalModelId,
    configId: input.configId,
    targetConfigId: input.targetConfigId,
    safeDetails: { category: input.category || 'provider_unavailable', state: 'switching' },
    now: input.now,
  });
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

const UNKNOWN_CANARY_STATES = new Set([
  'submission_unknown',
  'result_unknown',
  'artifact_unreadable',
]);
const TERMINAL_CANARY_STATES = new Set(['succeeded', 'failed']);
const RECONCILE_DEBOUNCE_MS = 60 * 1000;
const RECONCILE_LEASE_MS = 120 * 1000;

function maskedRouteName(config) {
  const digest = crypto.createHash('sha256')
    .update(`${config?.id || ''}:${config?.name || ''}`)
    .digest('hex')
    .slice(0, 8);
  return `线路-${digest}`;
}

function safeCategory(value, fallback = 'unknown') {
  const category = String(value || '').trim();
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(category) ? category : fallback;
}

function parsedCapability(serviceType, value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return evidenceService.normalizeCapability(serviceType, parseJson(value));
  } catch (_) {
    return null;
  }
}

function reconciliationAvailable(row, now = new Date().toISOString()) {
  if (row.service_type !== 'video'
      || !UNKNOWN_CANARY_STATES.has(row.state)
      || row.deleted_at
      || typeof row.provider_task_id !== 'string'
      || !row.provider_task_id.trim()) return false;
  const nowMs = Date.parse(now);
  const leaseMs = Date.parse(row.reconcile_lease_until || '');
  const checkedMs = Date.parse(row.reconcile_checked_at || '');
  if (Number.isFinite(leaseMs) && leaseMs > nowMs) return false;
  return !Number.isFinite(checkedMs) || checkedMs <= nowMs - RECONCILE_DEBOUNCE_MS;
}

function canaryRunDto(row, now) {
  return {
    id: row.id,
    logical_model_id: row.logical_model_id,
    route_name: maskedRouteName(row),
    service_type: row.service_type,
    capability: parsedCapability(row.service_type, row.capability_json),
    state: row.state,
    cost: {
      reserved_micros: row.reserved_cost_micros,
      actual_micros: row.actual_cost_micros,
      currency: row.currency,
    },
    times: {
      created_at: row.created_at,
      submitted_at: row.submitted_at,
      finished_at: row.finished_at,
      updated_at: row.updated_at,
    },
    error_category: row.error_category ? safeCategory(row.error_category) : null,
    reconcilable: reconciliationAvailable(row, now),
  };
}

const CANARY_RUN_STATES = new Set([
  'reserved',
  'submitting',
  'accepted',
  'verifying',
  'succeeded',
  'failed',
  'submission_unknown',
  'result_unknown',
  'artifact_unreadable',
  'budget_blocked',
]);

function invalidCanaryList() {
  throw canaryError('PROVIDER_CANARY_LIST_INVALID', '巡检运行筛选条件无效');
}

function canonicalIso(value) {
  if (typeof value !== 'string') return null;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return null;
  const canonical = new Date(millis).toISOString();
  return canonical === value ? canonical : null;
}

function encodeCanaryRunCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCanaryRunCursor(value) {
  if (typeof value !== 'string'
      || value.length < 1
      || value.length > 512
      || !/^[A-Za-z0-9_-]+$/.test(value)) invalidCanaryList();
  let decoded;
  try {
    const buffer = Buffer.from(value, 'base64url');
    if (buffer.toString('base64url') !== value) invalidCanaryList();
    decoded = JSON.parse(buffer.toString('utf8'));
  } catch (_) {
    invalidCanaryList();
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)
      || Object.keys(decoded).sort().join(',') !== 'i,s,u,v'
      || decoded.v !== 1
      || !canonicalIso(decoded.s)
      || !canonicalIso(decoded.u)
      || decoded.u > decoded.s
      || typeof decoded.i !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/.test(decoded.i)) invalidCanaryList();
  return decoded;
}

function normalizedCanaryRunFilters(filters) {
  let limit = 50;
  if (filters.limit !== undefined) {
    if (typeof filters.limit !== 'string' || !/^[1-9][0-9]{0,2}$/.test(filters.limit)) {
      invalidCanaryList();
    }
    limit = Number(filters.limit);
    if (limit > 200) invalidCanaryList();
  }
  let state = null;
  if (filters.state !== undefined) {
    if (typeof filters.state !== 'string' || !CANARY_RUN_STATES.has(filters.state)) {
      invalidCanaryList();
    }
    state = filters.state;
  }
  let logicalModelId = null;
  if (filters.logicalModelId !== undefined) {
    if (typeof filters.logicalModelId !== 'string'
        || filters.logicalModelId.length > 200
        || !filters.logicalModelId.trim()
        || /[\u0000-\u001f\u007f]/.test(filters.logicalModelId)) invalidCanaryList();
    logicalModelId = filters.logicalModelId.trim();
  }
  const cursor = filters.before === undefined ? null : decodeCanaryRunCursor(filters.before);
  const snapshotAt = cursor?.s || canonicalIso(filters.now) || new Date().toISOString();
  return { limit, state, logicalModelId, cursor, snapshotAt };
}

function listCanaryRuns(db, filters = {}) {
  const normalized = normalizedCanaryRunFilters(filters);
  if (!normalized.cursor) {
    const latestStored = canonicalIso(db.prepare(`SELECT MAX(updated_at) AS updated_at
      FROM provider_canary_runs`).get()?.updated_at);
    if (latestStored && latestStored > normalized.snapshotAt) normalized.snapshotAt = latestStored;
  }
  const clauses = ['r.updated_at <= ?'];
  const params = [normalized.snapshotAt];
  if (normalized.state) {
    clauses.push('r.state = ?');
    params.push(normalized.state);
  }
  if (normalized.logicalModelId) {
    clauses.push('r.logical_model_id = ? COLLATE NOCASE');
    params.push(normalized.logicalModelId);
  }
  if (normalized.cursor) {
    clauses.push('(r.updated_at < ? OR (r.updated_at = ? AND r.id < ?))');
    params.push(normalized.cursor.u, normalized.cursor.u, normalized.cursor.i);
  }
  const rows = db.prepare(`SELECT r.*, c.name, c.deleted_at,
      e.capability_json
    FROM provider_canary_runs r
    JOIN ai_service_configs c ON c.id = r.config_id
    LEFT JOIN provider_canary_evidence e
      ON e.config_id = r.config_id
     AND e.capability_fingerprint = r.capability_fingerprint
    WHERE ${clauses.join(' AND ')}
    ORDER BY r.updated_at DESC, r.id DESC LIMIT ?`)
    .all(...params, normalized.limit + 1);
  const hasMore = rows.length > normalized.limit;
  const pageRows = hasMore ? rows.slice(0, normalized.limit) : rows;
  const last = pageRows.at(-1);
  return {
    items: pageRows.map((row) => canaryRunDto(row, filters.now)),
    pagination: {
      limit: normalized.limit,
      has_more: hasMore,
      next_cursor: hasMore && last
        ? encodeCanaryRunCursor({
          v: 1,
          s: normalized.snapshotAt,
          u: last.updated_at,
          i: last.id,
        })
        : null,
    },
  };
}

function unknownBudgetUsage(db, column, bucket) {
  return Number(db.prepare(`SELECT COALESCE(SUM(reserved_cost_micros), 0) AS used
    FROM provider_canary_runs
    WHERE ${column} = ?
      AND state IN ('submission_unknown', 'result_unknown', 'artifact_unreadable')`)
    .get(bucket)?.used || 0);
}

const EVIDENCE_STATE_PRIORITY = [
  'disabled',
  'submission_unknown',
  'failing',
  'budget_blocked',
  'stale',
  'never_verified',
  'fresh',
];

function aggregateEvidenceState(states, config) {
  if (!config.is_active || config.canary_paused) return 'disabled';
  if (!states.length) return 'never_verified';
  return EVIDENCE_STATE_PRIORITY.find((state) => states.includes(state)) || 'never_verified';
}

function routeCanarySummary(db, config, now, canaryMode) {
  const zeroCost = db.prepare(`SELECT state, category, checked_at
    FROM provider_zero_cost_checks WHERE config_id = ?`).get(config.id);
  const rows = db.prepare(`SELECT * FROM provider_canary_evidence
    WHERE config_id = ? ORDER BY updated_at DESC`).all(config.id);
  const fingerprints = evidenceFingerprints(db, config);
  const states = rows.map((row) => evidenceService.effectiveEvidenceState(row, {
    now,
    canaryPaused: config.canary_paused,
    isActive: config.is_active,
    configFingerprint: fingerprints?.configFingerprint,
    costFingerprint: fingerprints?.costFingerprint,
    runtimeFingerprint: fingerprints?.runtimeFingerprint,
  }));
  const hasFresh = states.includes('fresh');
  const health = db.prepare('SELECT state FROM provider_route_health WHERE config_id = ?')
    .get(config.id)?.state || 'healthy';
  const currentVisible = config.is_active
    && config.verification_status === 'verified'
    && !['disabled', 'open', 'half_open'].includes(health);
  const visible = currentVisible && (canaryMode !== 'enforce' || hasFresh);
  const latestSuccess = rows.reduce((latest, row) => (
    row.verified_at && (!latest || row.verified_at > latest) ? row.verified_at : latest
  ), null);
  const freshExpiry = rows
    .filter((row, index) => states[index] === 'fresh' && row.expires_at)
    .map((row) => row.expires_at)
    .sort()[0] || null;
  const budgetBlock = db.prepare(`SELECT error_category FROM provider_canary_runs
    WHERE config_id = ? AND state = 'budget_blocked'
    ORDER BY updated_at DESC, id DESC LIMIT 1`).get(config.id);
  return {
    route_id: config.id,
    route_name: maskedRouteName(config),
    logical_model_id: config.logical_model_id,
    service_type: config.service_type,
    canary_paused: Boolean(config.canary_paused),
    public_state: visible ? 'visible' : 'hidden',
    would_be_hidden: !hasFresh,
    latest_zero_cost_check: zeroCost ? {
      state: zeroCost.state,
      category: zeroCost.category ? safeCategory(zeroCost.category) : null,
      checked_at: zeroCost.checked_at,
    } : null,
    latest_real_success_at: latestSuccess,
    evidence_expires_at: freshExpiry,
    evidence_state: aggregateEvidenceState(states, config),
    budget_block_reason: budgetBlock?.error_category
      ? safeCategory(budgetBlock.error_category)
      : null,
  };
}

function getCanaryAdminSummary(db, now = new Date().toISOString()) {
  const budget = budgetService.getBudgetSummary(db, now);
  const mode = resolveCanaryMode(undefined);
  const configs = aiConfigService.listConfigs(db);
  return {
    mode,
    budget: {
      budget_day: budget.budgetDay,
      budget_month: budget.budgetMonth,
      daily_limit_micros: budget.effectiveDailyLimitMicros,
      monthly_limit_micros: budget.effectiveMonthlyLimitMicros,
      daily_used_micros: budget.dailyUsedMicros,
      monthly_used_micros: budget.monthlyUsedMicros,
      daily_remaining_micros: budget.dailyRemainingMicros,
      monthly_remaining_micros: budget.monthlyRemainingMicros,
      daily_unknown_micros: unknownBudgetUsage(db, 'budget_day', budget.budgetDay),
      monthly_unknown_micros: unknownBudgetUsage(db, 'budget_month', budget.budgetMonth),
    },
    routes: configs.map((config) => routeCanarySummary(db, config, now, mode)),
  };
}

function canaryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function loadCanaryForReconciliation(db, runId) {
  const row = db.prepare(`SELECT r.*, c.name, c.service_type AS config_service_type,
      c.deleted_at, e.capability_json
    FROM provider_canary_runs r
    JOIN ai_service_configs c ON c.id = r.config_id
    LEFT JOIN provider_canary_evidence e
      ON e.config_id = r.config_id
     AND e.capability_fingerprint = r.capability_fingerprint
    WHERE r.id = ?`).get(runId);
  if (!row) throw canaryError('PROVIDER_CANARY_RUN_NOT_FOUND', '巡检运行不存在');
  return row;
}

function assertReconcilableUnknown(row) {
  if (!UNKNOWN_CANARY_STATES.has(row.state)
      || row.service_type !== 'video'
      || row.deleted_at
      || typeof row.provider_task_id !== 'string'
      || !row.provider_task_id.trim()
      || !row.capability_json) {
    throw canaryError('PROVIDER_CANARY_RUN_NOT_RECONCILABLE', '该巡检运行不可对账');
  }
}

function isoAfter(now, milliseconds) {
  return new Date(Date.parse(now) + milliseconds).toISOString();
}

function claimReconciliation(db, before, token, now) {
  return db.transaction(() => {
    const current = loadCanaryForReconciliation(db, before.id);
    if (TERMINAL_CANARY_STATES.has(current.state)) return { claimed: false, row: current };
    assertReconcilableUnknown(current);
    if (current.provider_task_id !== before.provider_task_id) {
      throw canaryError('PROVIDER_CANARY_RUN_CHANGED', '巡检运行已变化');
    }
    const result = db.prepare(`UPDATE provider_canary_runs
      SET reconcile_claim_token = ?, reconcile_lease_until = ?, updated_at = updated_at
      WHERE id = ? AND provider_task_id = ?
        AND state IN ('submission_unknown', 'result_unknown', 'artifact_unreadable')
        AND (reconcile_lease_until IS NULL OR reconcile_lease_until <= ?)
        AND (reconcile_checked_at IS NULL OR reconcile_checked_at <= ?)`)
      .run(
        token,
        isoAfter(now, RECONCILE_LEASE_MS),
        before.id,
        before.provider_task_id,
        now,
        isoAfter(now, -RECONCILE_DEBOUNCE_MS),
      );
    return {
      claimed: result.changes === 1,
      row: loadCanaryForReconciliation(db, before.id),
    };
  }).immediate();
}

function ownedReconciliation(db, before, token) {
  const current = loadCanaryForReconciliation(db, before.id);
  return {
    owned: current.reconcile_claim_token === token
      && current.provider_task_id === before.provider_task_id
      && UNKNOWN_CANARY_STATES.has(current.state),
    row: current,
  };
}

async function defaultQueryTaskOnce(input) {
  // 延迟加载，避免 videoClient -> providerRouteStabilityService 的循环依赖。
  const videoClient = require('./videoClient');
  const safeLog = { info() {}, warn() {}, error() {} };
  return videoClient.queryVideoTaskStatusOnce(
    input.db,
    safeLog,
    input.taskId,
    input.config,
    input.requestOptions || {},
  );
}

const SAFE_QUERY_CATEGORIES = new Set([
  'result_unknown',
  'validation_error',
  'auth_unavailable',
  'forbidden_unknown',
  'rate_limited',
  'provider_unavailable',
  'query_request_limit',
  'query_protocol_error',
]);

function normalizedQueryCategory(value, fallback = 'query_protocol_error') {
  const category = safeCategory(value, fallback);
  return SAFE_QUERY_CATEGORIES.has(category) ? category : fallback;
}

function thrownQueryCategory(error) {
  if (error?.code === 'PROVIDER_QUERY_REQUEST_LIMIT') return 'query_request_limit';
  if (error?.code === 'PROVIDER_QUERY_PROTOCOL_ERROR') return 'query_protocol_error';
  if (error?.code === 'PROVIDER_QUERY_VALIDATION_ERROR') return 'validation_error';
  if (error?.name === 'AbortError'
      || error?.name === 'TimeoutError'
      || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(error?.code)) {
    return 'result_unknown';
  }
  return 'query_protocol_error';
}

function reconciliationAudit(db, input) {
  auditEvent.record(db, {
    userId: input.actorId,
    eventType: 'provider.canary.reconciled',
    resourceType: 'provider_canary_run',
    resourceId: input.runId,
    outcome: input.outcome,
    code: input.category,
  });
}

function reconciliationEvent(db, run, eventType, severity, category, now) {
  insertEvent(db, {
    severity,
    eventType,
    requestId: run.id,
    logicalModelId: run.logical_model_id,
    configId: run.config_id,
    taskState: run.state,
    safeDetails: { category, state: run.state },
    now,
  });
}

function reconciliationEvidenceInput(run, capability, now) {
  return {
    runId: run.id,
    configId: run.config_id,
    serviceType: run.service_type,
    capability,
    configFingerprint: run.config_fingerprint,
    costFingerprint: run.cost_fingerprint,
    runtimeFingerprint: run.runtime_fingerprint,
    now,
  };
}

function normalizedReconciledArtifact(value, runId) {
  const expectedPrefix = `_system/provider-canary/runs/${runId}/`;
  const relativePath = String(value?.relative_path || '');
  const sha256 = String(value?.sha256 || '').toLowerCase();
  const bytes = Number(value?.bytes);
  if (!relativePath.startsWith(expectedPrefix)
      || relativePath.slice(expectedPrefix.length).includes('/')
      || !/^[a-f0-9]{64}$/.test(sha256)
      || !Number.isSafeInteger(bytes)
      || bytes <= 0) {
    throw canaryError('PROVIDER_CANARY_ARTIFACT_UNREADABLE', '巡检产物不可读');
  }
  return { relative_path: relativePath, sha256, bytes };
}

function safeReconcileResult(run, now) {
  return {
    id: run.id,
    state: run.state,
    reconciled: TERMINAL_CANARY_STATES.has(run.state),
    error_category: run.error_category ? safeCategory(run.error_category) : null,
    reconcilable: reconciliationAvailable(run, now),
  };
}

async function reconcileCanaryRun(db, log, runId, options = {}) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/.test(runId)) {
    throw canaryError('PROVIDER_CANARY_RUN_INVALID', '巡检运行 ID 无效');
  }
  const before = loadCanaryForReconciliation(db, runId);
  const now = options.now || new Date().toISOString();
  if (TERMINAL_CANARY_STATES.has(before.state)) return safeReconcileResult(before, now);
  assertReconcilableUnknown(before);
  const config = aiConfigService.getConfig(db, before.config_id);
  if (!config) throw canaryError('PROVIDER_CANARY_RUN_NOT_RECONCILABLE', '巡检线路不可用');
  const capability = parsedCapability(before.service_type, before.capability_json);
  if (!capability
      || evidenceService.capabilityFingerprint(before.service_type, capability)
        !== before.capability_fingerprint) {
    throw canaryError('PROVIDER_CANARY_RUN_NOT_RECONCILABLE', '巡检能力证据不可对账');
  }
  const claimToken = crypto.randomUUID();
  const claim = claimReconciliation(db, before, claimToken, now);
  if (!claim.claimed) return safeReconcileResult(claim.row, now);
  const query = options.queryTaskOnce || defaultQueryTaskOnce;
  let queryResult;
  try {
    queryResult = await query({
      db,
      log,
      config,
      taskId: before.provider_task_id,
      requestOptions: options.pollRequestOptions,
    });
  } catch (error) {
    const category = thrownQueryCategory(error);
    queryResult = category === 'result_unknown'
      ? { state: 'unknown', category }
      : { state: 'query_failed', category };
  }

  if (queryResult?.state === 'succeeded' && queryResult.artifactUrl) {
    let artifact;
    const currentClaim = ownedReconciliation(db, before, claimToken);
    if (!currentClaim.owned) return safeReconcileResult(currentClaim.row, now);
    try {
      artifact = await (options.materializeVideo || artifactService.materializeVideo)(
        queryResult.artifactUrl,
        { storageRoot: options.storageRoot, runId: before.id },
      );
      artifact = normalizedReconciledArtifact(artifact, before.id);
    } catch (_) {
      queryResult = { state: 'artifact_unreadable' };
    }
    if (artifact) {
      const after = db.transaction(() => {
        const ownership = ownedReconciliation(db, before, claimToken);
        if (!ownership.owned) return ownership.row;
        const current = ownership.row;
        db.prepare(`UPDATE provider_canary_runs
          SET state = 'succeeded', actual_cost_micros = reserved_cost_micros,
            artifact_path = ?, artifact_sha256 = ?, artifact_bytes = ?,
            error_category = NULL, safe_error_summary = NULL,
            reconcile_claim_token = NULL, reconcile_lease_until = NULL,
            reconcile_checked_at = ?, finished_at = ?, updated_at = ?
          WHERE id = ? AND reconcile_claim_token = ?`).run(
          artifact.relative_path,
          artifact.sha256,
          artifact.bytes,
          now,
          now,
          now,
          runId,
          claimToken,
        );
        evidenceService.recordSuccess(
          db,
          reconciliationEvidenceInput(current, capability, now),
        );
        const updated = db.prepare('SELECT * FROM provider_canary_runs WHERE id = ?').get(runId);
        reconciliationEvent(
          db,
          updated,
          'provider_canary_reconciled_success',
          'info',
          'reconciled_success',
          now,
        );
        reconciliationAudit(db, {
          actorId: options.actorId,
          runId,
          outcome: 'success',
          category: 'reconciled_success',
        });
        return updated;
      }).immediate();
      return safeReconcileResult(after, now);
    }
  }

  if (queryResult?.state === 'succeeded') {
    queryResult = { state: 'artifact_unreadable' };
  }

  if (queryResult?.state === 'failed') {
    const category = safeCategory(queryResult.category, 'provider_task_failed');
    const after = db.transaction(() => {
      const ownership = ownedReconciliation(db, before, claimToken);
      if (!ownership.owned) return ownership.row;
      const current = ownership.row;
      db.prepare(`UPDATE provider_canary_runs
        SET state = 'failed', actual_cost_micros = reserved_cost_micros,
          error_category = ?, safe_error_summary = ?, reconcile_claim_token = NULL,
          reconcile_lease_until = NULL, reconcile_checked_at = ?,
          finished_at = ?, updated_at = ?
        WHERE id = ? AND reconcile_claim_token = ?`)
        .run(category, `category=${category}`, now, now, now, runId, claimToken);
      evidenceService.recordFailure(
        db,
        reconciliationEvidenceInput(current, capability, now),
      );
      const updated = db.prepare('SELECT * FROM provider_canary_runs WHERE id = ?').get(runId);
      reconciliationEvent(
        db,
        updated,
        'provider_canary_reconciled_failure',
        'warning',
        category,
        now,
      );
      reconciliationAudit(db, {
        actorId: options.actorId,
        runId,
        outcome: 'failed',
        category,
      });
      return updated;
    }).immediate();
    return safeReconcileResult(after, now);
  }

  if (queryResult?.state === 'artifact_unreadable') {
    const after = db.transaction(() => {
      const ownership = ownedReconciliation(db, before, claimToken);
      if (!ownership.owned) return ownership.row;
      const current = ownership.row;
      db.prepare(`UPDATE provider_canary_runs SET state = 'artifact_unreadable',
        error_category = 'artifact_unreadable', safe_error_summary = 'category=artifact_unreadable',
        reconcile_claim_token = NULL, reconcile_lease_until = NULL,
        reconcile_checked_at = ?, finished_at = ?, updated_at = ?
        WHERE id = ? AND reconcile_claim_token = ?`).run(now, now, now, runId, claimToken);
      evidenceService.recordUnknown(db, {
        ...reconciliationEvidenceInput(current, capability, now),
        state: 'artifact_unreadable',
      });
      const updated = db.prepare('SELECT * FROM provider_canary_runs WHERE id = ?').get(runId);
      reconciliationEvent(
        db,
        updated,
        'provider_canary_reconcile_unknown',
        'warning',
        'artifact_unreadable',
        now,
      );
      reconciliationAudit(db, {
        actorId: options.actorId,
        runId,
        outcome: 'unknown',
        category: 'artifact_unreadable',
      });
      return updated;
    }).immediate();
    return safeReconcileResult(after, now);
  }

  const unknownCategory = queryResult?.state === 'query_failed'
    ? normalizedQueryCategory(queryResult.category)
    : normalizedQueryCategory(queryResult?.category, 'result_unknown');
  const unchanged = db.transaction(() => {
    const ownership = ownedReconciliation(db, before, claimToken);
    if (!ownership.owned) return ownership.row;
    const current = ownership.row;
    db.prepare(`UPDATE provider_canary_runs SET reconcile_claim_token = NULL,
      reconcile_lease_until = NULL, reconcile_checked_at = ?, error_category = ?,
      safe_error_summary = ?
      WHERE id = ? AND reconcile_claim_token = ?`)
      .run(now, unknownCategory, `category=${unknownCategory}`, runId, claimToken);
    const updated = loadCanaryForReconciliation(db, runId);
    reconciliationEvent(
      db,
      updated,
      'provider_canary_reconcile_unknown',
      'warning',
      unknownCategory,
      now,
    );
    reconciliationAudit(db, {
      actorId: options.actorId,
      runId,
      outcome: 'unknown',
      category: unknownCategory,
    });
    return updated;
  }).immediate();
  log?.warn?.('Provider canary reconciliation remains unknown', { run_id: runId });
  return safeReconcileResult(unchanged, now);
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

function getRouteCostForAdmin(db, configId) {
  const config = aiConfigService.getConfig(db, configId);
  if (!config) {
    const error = new Error('provider route does not exist');
    error.code = 'PROVIDER_ROUTE_NOT_FOUND';
    throw error;
  }
  return routeCostService.getRouteCost(db, configId);
}

function updateRouteCostForAdmin(db, configId, input) {
  return routeCostService.setRouteCost(db, configId, input);
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
  buildAttemptReceipt,
  startAttempt,
  finishAttempt,
  recordAcceptedTask,
  recordArtifactVerified,
  recordBusinessArtifactUnreadable,
  recordFailureAndHealth,
  recordRouteSwitch,
  claimHalfOpen,
  listAdminRoutes,
  listAdminEvents,
  getCanaryAdminSummary,
  listCanaryRuns,
  reconcileCanaryRun,
  getRouteCostForAdmin,
  updateRouteCostForAdmin,
  resetHealth,
  resolveCanaryMode,
  listFreshCandidateEvidence,
  verifyConfigFromGenerationEvidence,
};
