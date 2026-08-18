'use strict';

const crypto = require('node:crypto');

const MAX_EVIDENCE_AGE_MS = 48 * 60 * 60 * 1000;
const UNKNOWN_STATES = new Set([
  'submission_unknown',
  'result_unknown',
  'artifact_unreadable',
]);
const SAFE_INVALIDATION_REASONS = new Set([
  'admin_invalidated',
  'capability_changed',
  'config_changed',
  'cost_changed',
  'logical_model_changed',
  'runtime_changed',
]);
const SET_ARRAY_KEYS = new Set([
  'aspectRatios',
  'durations',
  'features',
  'modelFeatures',
  'models',
  'resolutions',
  'requiredFeatures',
  'supportedFeatures',
]);
const FORBIDDEN_SNAPSHOT_KEY = /(api.?key|authorization|base.?url|provider|prompt|secret|signed.?url|task.?url|token|host)/i;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableValue(value, options = {}, key = '') {
  if (value === null) return null;
  if (Array.isArray(value)) {
    const normalized = value.map((item) => stableValue(item, options));
    if (options.sortArrays || SET_ARRAY_KEYS.has(key)) {
      const byJson = normalized
        .map((item) => ({ item, json: JSON.stringify(item) }))
        .sort((left, right) => (left.json < right.json ? -1 : left.json > right.json ? 1 : 0));
      return byJson.filter((entry, index) => index === 0 || entry.json !== byJson[index - 1].json)
        .map((entry) => entry.item);
    }
    return normalized;
  }
  if (isPlainObject(value)) {
    const result = {};
    for (const childKey of Object.keys(value).sort()) {
      if (options.rejectSensitiveKeys && FORBIDDEN_SNAPSHOT_KEY.test(childKey)) {
        throw new TypeError(`capability contains unsafe field: ${childKey}`);
      }
      const child = value[childKey];
      if (child === undefined) throw new TypeError(`${childKey} must not be undefined`);
      result[childKey] = stableValue(child, options, childKey);
    }
    return result;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${key || 'value'} must be finite`);
    if (options.requireNonNegativeIntegers && (!Number.isSafeInteger(value) || value < 0)) {
      throw new TypeError(`${key || 'value'} must be a non-negative safe integer`);
    }
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim();
    return options.lowercaseStrings ? normalized.toLowerCase() : normalized;
  }
  if (typeof value === 'boolean') return value;
  throw new TypeError(`${key || 'value'} has unsupported type`);
}

function stableJson(value, options) {
  return JSON.stringify(stableValue(value, options));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizedRequiredString(value, name, { lowercase = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  const result = value.trim();
  return lowercase ? result.toLowerCase() : result;
}

function normalizedOptionalString(value, name, { lowercase = false } = {}) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  const result = value.trim();
  if (!result) return null;
  return lowercase ? result.toLowerCase() : result;
}

function normalizedCount(value, name, fallback) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return candidate;
}

function normalizedBoolean(value, name, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
  return value;
}

function capabilityValue(capability, camel, snake) {
  if (Object.prototype.hasOwnProperty.call(capability, camel)) return capability[camel];
  if (snake && Object.prototype.hasOwnProperty.call(capability, snake)) return capability[snake];
  return undefined;
}

function normalizeSlotSemantics(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError('slotSemantics must be an array');
  return value.map((slot, index) => {
    if (typeof slot === 'string') {
      const result = slot.trim().toLowerCase();
      if (!result) throw new TypeError(`slotSemantics[${index}] must not be empty`);
      return result;
    }
    if (!isPlainObject(slot)) throw new TypeError(`slotSemantics[${index}] has unsupported type`);
    return stableValue(slot, {
      rejectSensitiveKeys: true,
      requireNonNegativeIntegers: true,
      lowercaseStrings: true,
    });
  });
}

function normalizeModelFeatures(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    const normalized = value.map((feature, index) => {
      if (typeof feature !== 'string' || !feature.trim()) {
        throw new TypeError(`modelFeatures[${index}] must be a non-empty string`);
      }
      return feature.trim().toLowerCase();
    });
    return [...new Set(normalized)].sort();
  }
  if (!isPlainObject(value)) throw new TypeError('modelFeatures must be an array or object');
  const normalized = stableValue(value, {
    rejectSensitiveKeys: true,
    requireNonNegativeIntegers: true,
    lowercaseStrings: true,
  });
  return normalized;
}

function normalizeCapability(serviceType, capability = {}) {
  const normalizedServiceType = normalizedRequiredString(serviceType, 'serviceType', { lowercase: true });
  if (!isPlainObject(capability)) throw new TypeError('capability must be an object');
  const explicitGenerationType = capabilityValue(capability, 'generationType', 'generation_type');
  const generationType = explicitGenerationType === undefined ? normalizedServiceType : explicitGenerationType;
  const slotSemantics = capabilityValue(capability, 'slotSemantics', 'slot_semantics')
    ?? capability.slots;
  const modelFeatures = capabilityValue(capability, 'modelFeatures', 'model_features')
    ?? capability.requiredFeatures
    ?? capability.features;
  const userPriceContract = capability.userPriceContract ?? capability.user_price_contract ?? null;
  if (userPriceContract !== null && !isPlainObject(userPriceContract)) {
    throw new TypeError('userPriceContract must be an object or null');
  }
  return {
    serviceType: normalizedServiceType,
    generationType: normalizedRequiredString(generationType, 'generationType', { lowercase: true }),
    resolution: normalizedOptionalString(capability.resolution, 'resolution', { lowercase: true }),
    aspectRatio: normalizedOptionalString(
      capability.aspectRatio ?? capability.aspect_ratio,
      'aspectRatio',
      { lowercase: true },
    ),
    duration: normalizedCount(capability.duration, 'duration', 0),
    count: normalizedCount(capability.count, 'count', 1),
    referenceImageCount: normalizedCount(
      capabilityValue(capability, 'referenceImageCount', 'reference_image_count'),
      'referenceImageCount',
      0,
    ),
    referenceVideoCount: normalizedCount(
      capabilityValue(capability, 'referenceVideoCount', 'reference_video_count'),
      'referenceVideoCount',
      0,
    ),
    referenceAudioCount: normalizedCount(
      capabilityValue(capability, 'referenceAudioCount', 'reference_audio_count'),
      'referenceAudioCount',
      0,
    ),
    requiresAudio: normalizedBoolean(
      capabilityValue(capability, 'requiresAudio', 'requires_audio'),
      'requiresAudio',
    ),
    firstFrame: normalizedBoolean(
      capabilityValue(capability, 'firstFrame', 'first_frame'),
      'firstFrame',
    ),
    lastFrame: normalizedBoolean(
      capabilityValue(capability, 'lastFrame', 'last_frame'),
      'lastFrame',
    ),
    slotSemantics: normalizeSlotSemantics(slotSemantics),
    modelFeatures: normalizeModelFeatures(modelFeatures),
    userPriceContract: userPriceContract === null
      ? null
      : stableValue(userPriceContract, {
        rejectSensitiveKeys: true,
        requireNonNegativeIntegers: true,
        lowercaseStrings: true,
      }),
  };
}

function capabilityFingerprint(serviceType, capability) {
  return sha256(stableJson(normalizeCapability(serviceType, capability)));
}

function capabilityCovers(evidenceCapability, requestedCapability) {
  if (!isPlainObject(evidenceCapability) || !isPlainObject(requestedCapability)) return false;
  const serviceType = evidenceCapability.serviceType
    || evidenceCapability.service_type
    || evidenceCapability.generationType
    || evidenceCapability.generation_type
    || requestedCapability.serviceType
    || requestedCapability.service_type
    || requestedCapability.generationType
    || requestedCapability.generation_type;
  let evidence;
  let requested;
  try {
    evidence = normalizeCapability(serviceType, evidenceCapability);
    requested = normalizeCapability(serviceType, requestedCapability);
  } catch (_) {
    return false;
  }
  for (const key of [
    'serviceType', 'generationType', 'resolution', 'aspectRatio', 'duration',
    'requiresAudio', 'firstFrame', 'lastFrame',
  ]) {
    if (evidence[key] !== requested[key]) return false;
  }
  for (const key of ['count', 'referenceImageCount', 'referenceVideoCount', 'referenceAudioCount']) {
    if (evidence[key] < requested[key]) return false;
  }
  for (const key of ['slotSemantics', 'modelFeatures', 'userPriceContract']) {
    if (stableJson(evidence[key]) !== stableJson(requested[key])) return false;
  }
  return true;
}

function covers(evidence, requestedCapability) {
  if (!evidence || typeof evidence !== 'object') return false;
  let capability = evidence.capability || evidence;
  if (!evidence.capability && typeof evidence.capability_json === 'string') {
    try { capability = JSON.parse(evidence.capability_json); } catch (_) { return false; }
  }
  const serviceType = evidence.serviceType || evidence.service_type;
  if (serviceType && !capability.serviceType && !capability.service_type) {
    capability = { ...capability, serviceType };
  }
  return capabilityCovers(capability, requestedCapability);
}

function ownValue(object, names, label) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(object, name)) return object[name];
  }
  throw new TypeError(`config must include ${label}`);
}

function parsedMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return value;
  try { return JSON.parse(trimmed); } catch (_) { return value; }
}

function configFingerprint(config) {
  if (!isPlainObject(config)) throw new TypeError('config must be an object');
  const apiKey = ownValue(config, ['apiKey', 'api_key'], 'apiKey');
  const baseUrl = ownValue(config, ['baseUrl', 'base_url'], 'baseUrl');
  const protocol = ownValue(config, ['protocol', 'apiProtocol', 'api_protocol'], 'protocol');
  let upstreamModel;
  if (Object.prototype.hasOwnProperty.call(config, 'upstreamModel')
      || Object.prototype.hasOwnProperty.call(config, 'upstream_model')) {
    upstreamModel = ownValue(config, ['upstreamModel', 'upstream_model'], 'upstreamModel');
  } else if (Object.prototype.hasOwnProperty.call(config, 'model')
      || Object.prototype.hasOwnProperty.call(config, 'default_model')) {
    upstreamModel = {
      model: Object.prototype.hasOwnProperty.call(config, 'model') ? parsedMaybeJson(config.model) : null,
      defaultModel: Object.prototype.hasOwnProperty.call(config, 'default_model')
        ? parsedMaybeJson(config.default_model)
        : null,
    };
  } else {
    throw new TypeError('config must include upstreamModel');
  }
  let capabilities;
  for (const name of ['capabilities', 'capability', 'capabilityConfig', 'capability_config']) {
    if (Object.prototype.hasOwnProperty.call(config, name)) {
      capabilities = config[name];
      break;
    }
  }
  if (capabilities === undefined && Object.prototype.hasOwnProperty.call(config, 'settings')) {
    const settings = parsedMaybeJson(config.settings);
    if (isPlainObject(settings)) {
      capabilities = settings.canvas_capabilities_by_model ?? settings.canvas_capabilities ?? settings.capabilities;
    }
  }
  if (capabilities === undefined) throw new TypeError('config must include capabilities');
  if (typeof apiKey !== 'string') throw new TypeError('apiKey must be a string');
  if (typeof protocol !== 'string') throw new TypeError('protocol must be a string');
  return sha256(stableJson({
    serviceType: normalizedOptionalString(
      config.serviceType ?? config.service_type,
      'serviceType',
      { lowercase: true },
    ),
    apiKey,
    baseUrl: normalizedRequiredString(baseUrl, 'baseUrl'),
    protocol: protocol.trim().toLowerCase() || 'auto',
    provider: normalizedOptionalString(config.provider, 'provider', { lowercase: true }),
    upstreamModel: stableValue(parsedMaybeJson(upstreamModel), { sortArrays: true }),
    capabilities: stableValue(parsedMaybeJson(capabilities)),
  }));
}

function costFingerprint(priceRow, resolutionPrices = []) {
  if (priceRow !== null && !isPlainObject(priceRow)) throw new TypeError('priceRow must be an object or null');
  if (!Array.isArray(resolutionPrices)) throw new TypeError('resolutionPrices must be an array');
  const tiers = resolutionPrices.map((row) => {
    if (!isPlainObject(row)) throw new TypeError('resolutionPrices rows must be objects');
    return stableValue(row);
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return sha256(stableJson({ price: priceRow === null ? null : stableValue(priceRow), resolutionPrices: tiers }));
}

function providerScopeKey(config) {
  if (!isPlainObject(config)) throw new TypeError('config must be an object');
  let origin = 'invalid-origin';
  const baseUrl = config.baseUrl ?? config.base_url ?? '';
  try {
    const parsed = new URL(String(baseUrl));
    if (parsed.origin !== 'null') origin = parsed.origin.toLowerCase();
  } catch (_) {}
  const identity = {
    provider: String(config.provider || '').trim().toLowerCase(),
    origin,
    apiKey: String(config.apiKey ?? config.api_key ?? ''),
    accountId: String(config.accountId ?? config.account_id ?? config.account ?? '').trim(),
  };
  return sha256(stableJson(identity));
}

function normalizedNow(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new TypeError('now must be a valid date');
  return date;
}

function evidenceAgeMs(input = {}) {
  const requested = input.maxAgeMs ?? process.env.PROVIDER_CANARY_MAX_EVIDENCE_AGE_MS;
  if (requested === undefined || requested === null || requested === '') return MAX_EVIDENCE_AGE_MS;
  const numeric = Number(requested);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) return MAX_EVIDENCE_AGE_MS;
  return Math.min(numeric, MAX_EVIDENCE_AGE_MS);
}

function nonEmptyFingerprint(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function loadMatchingRun(db, input, capabilityHash, options = {}) {
  const runId = normalizedRequiredString(input.runId ?? input.run_id, 'runId');
  const configId = input.configId ?? input.config_id;
  if (!Number.isSafeInteger(configId) || configId <= 0) throw new TypeError('configId must be a positive safe integer');
  const run = db.prepare('SELECT * FROM provider_canary_runs WHERE id = ?').get(runId);
  const serviceType = normalizedRequiredString(input.serviceType ?? input.service_type, 'serviceType', { lowercase: true });
  if (!run
      || run.config_id !== configId
      || String(run.service_type).toLowerCase() !== serviceType
      || run.capability_fingerprint !== capabilityHash) {
    throw new Error(options.requiredState
      ? `matching ${options.requiredState} canary run not found`
      : 'matching canary run not found');
  }
  if (options.requiredState && run.state !== options.requiredState) {
    throw new Error(`matching ${options.requiredState} canary run not found`);
  }
  return { run, runId, configId, serviceType };
}

function rowWithCapability(row) {
  if (!row) return row;
  return { ...row, capability: JSON.parse(row.capability_json) };
}

function runImmediate(db, work) {
  if (db.inTransaction) return work();
  return db.transaction(work).immediate();
}

function recordSuccess(db, input) {
  const capability = normalizeCapability(input.serviceType ?? input.service_type, input.capability);
  const capabilityJson = stableJson(capability);
  const capabilityHash = sha256(capabilityJson);
  const configHash = nonEmptyFingerprint(input.configFingerprint ?? input.config_fingerprint, 'configFingerprint');
  const costHash = nonEmptyFingerprint(input.costFingerprint ?? input.cost_fingerprint, 'costFingerprint');
  const runtimeHash = nonEmptyFingerprint(input.runtimeFingerprint ?? input.runtime_fingerprint, 'runtimeFingerprint');
  const now = normalizedNow(input.now);
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + evidenceAgeMs(input)).toISOString();
  const row = runImmediate(db, () => {
    const match = loadMatchingRun(db, input, capabilityHash, { requiredState: 'succeeded' });
    if (match.run.config_fingerprint !== configHash
        || match.run.cost_fingerprint !== costHash
        || match.run.runtime_fingerprint !== runtimeHash) {
      throw new Error('matching succeeded canary run not found');
    }
    db.prepare(`INSERT INTO provider_canary_evidence
      (config_id, service_type, capability_fingerprint, capability_json, state,
       run_id, config_fingerprint, cost_fingerprint, runtime_fingerprint,
       verified_at, expires_at, invalidated_at, invalidation_reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'fresh', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
      ON CONFLICT(config_id, capability_fingerprint) DO UPDATE SET
        service_type = excluded.service_type,
        capability_json = excluded.capability_json,
        state = 'fresh',
        run_id = excluded.run_id,
        config_fingerprint = excluded.config_fingerprint,
        cost_fingerprint = excluded.cost_fingerprint,
        runtime_fingerprint = excluded.runtime_fingerprint,
        verified_at = excluded.verified_at,
        expires_at = excluded.expires_at,
        invalidated_at = NULL,
        invalidation_reason = NULL,
        updated_at = excluded.updated_at`)
      .run(
        match.configId, match.serviceType, capabilityHash, capabilityJson,
        match.runId, configHash, costHash, runtimeHash,
        nowIso, expiresAt, nowIso, nowIso,
      );
    return db.prepare(`SELECT * FROM provider_canary_evidence
      WHERE config_id = ? AND capability_fingerprint = ?`).get(match.configId, capabilityHash);
  });
  return rowWithCapability(row);
}

function writeNonFreshEvidence(db, input, runState, evidenceState) {
  const capability = normalizeCapability(input.serviceType ?? input.service_type, input.capability);
  const capabilityJson = stableJson(capability);
  const capabilityHash = sha256(capabilityJson);
  const match = loadMatchingRun(db, input, capabilityHash);
  const nowIso = normalizedNow(input.now).toISOString();
  db.prepare(`UPDATE provider_canary_runs
    SET state = ?, finished_at = ?, updated_at = ? WHERE id = ?`)
    .run(runState, nowIso, nowIso, match.runId);
  db.prepare(`INSERT INTO provider_canary_evidence
    (config_id, service_type, capability_fingerprint, capability_json, state,
     run_id, config_fingerprint, cost_fingerprint, runtime_fingerprint,
     verified_at, expires_at, invalidated_at, invalidation_reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
    ON CONFLICT(config_id, capability_fingerprint) DO UPDATE SET
      service_type = excluded.service_type,
      capability_json = excluded.capability_json,
      state = excluded.state,
      run_id = excluded.run_id,
      config_fingerprint = excluded.config_fingerprint,
      cost_fingerprint = excluded.cost_fingerprint,
      runtime_fingerprint = excluded.runtime_fingerprint,
      verified_at = NULL,
      expires_at = NULL,
      invalidated_at = excluded.invalidated_at,
      invalidation_reason = excluded.invalidation_reason,
      updated_at = excluded.updated_at`)
    .run(
      match.configId, match.serviceType, capabilityHash, capabilityJson, evidenceState,
      match.runId, match.run.config_fingerprint, match.run.cost_fingerprint,
      match.run.runtime_fingerprint, nowIso, runState, nowIso, nowIso,
    );
  return {
    match,
    row: rowWithCapability(db.prepare(`SELECT * FROM provider_canary_evidence
      WHERE config_id = ? AND capability_fingerprint = ?`).get(match.configId, capabilityHash)),
  };
}

function recordFailure(db, input) {
  return runImmediate(db, () => writeNonFreshEvidence(db, input, 'failed', 'failing').row);
}

function recordBudgetBlocked(db, input) {
  return runImmediate(
    db,
    () => writeNonFreshEvidence(db, input, 'budget_blocked', 'budget_blocked').row,
  );
}

function recordUnknown(db, input) {
  const state = input.state ?? input.taskState ?? input.task_state;
  if (!UNKNOWN_STATES.has(state)) {
    throw new TypeError('state must be submission_unknown, result_unknown, or artifact_unreadable');
  }
  return runImmediate(db, () => {
    const result = writeNonFreshEvidence(db, input, state, 'submission_unknown');
    const safeDetails = stableJson({
      capability_ref: sha256(result.match.run.capability_fingerprint),
      provider_scope_ref: sha256(result.match.run.provider_scope_key),
      run_ref: sha256(result.match.runId),
    });
    db.prepare(`INSERT INTO provider_stability_events
      (severity, event_type, logical_model_id, config_id, task_state, safe_details, created_at)
      SELECT 'warning', 'provider_canary_unknown', ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM provider_stability_events
        WHERE event_type = 'provider_canary_unknown'
          AND config_id = ? AND task_state = ? AND safe_details = ?
      )`)
      .run(
        result.match.run.logical_model_id,
        result.match.configId,
        state,
        safeDetails,
        normalizedNow(input.now).toISOString(),
        result.match.configId,
        state,
        safeDetails,
      );
    return result.row;
  });
}

function safeInvalidationReason(reason) {
  if (typeof reason !== 'string' || !SAFE_INVALIDATION_REASONS.has(reason.trim())) {
    throw new TypeError('reason must be an approved safe invalidation reason');
  }
  return reason.trim();
}

function invalidateConfig(db, configId, reason, now) {
  if (!Number.isSafeInteger(configId) || configId <= 0) throw new TypeError('configId must be a positive safe integer');
  const safeReason = safeInvalidationReason(reason);
  const nowIso = normalizedNow(now).toISOString();
  return db.prepare(`UPDATE provider_canary_evidence
    SET state = 'stale', invalidated_at = ?, invalidation_reason = ?, updated_at = ?
    WHERE config_id = ?`).run(nowIso, safeReason, nowIso, configId);
}

function invalidateLogicalModel(db, logicalModelId, reason, now) {
  const model = normalizedRequiredString(logicalModelId, 'logicalModelId');
  const safeReason = safeInvalidationReason(reason);
  const nowIso = normalizedNow(now).toISOString();
  return db.prepare(`UPDATE provider_canary_evidence
    SET state = 'stale', invalidated_at = ?, invalidation_reason = ?, updated_at = ?
    WHERE config_id IN (
      SELECT id FROM ai_service_configs WHERE logical_model_id = ?
    )`).run(nowIso, safeReason, nowIso, model);
}

function rowValue(row, camel, snake) {
  return row[snake] ?? row[camel];
}

function effectiveEvidenceState(row, context = {}) {
  if (!row || typeof row !== 'object') return 'never_verified';
  if (context.canaryPaused === true || context.disabled === true || context.isActive === false) {
    return 'disabled';
  }
  if (row.state !== 'fresh') return row.state;
  if (row.invalidated_at || row.invalidatedAt) return 'stale';
  const expected = [
    ['configFingerprint', 'config_fingerprint'],
    ['costFingerprint', 'cost_fingerprint'],
    ['runtimeFingerprint', 'runtime_fingerprint'],
  ];
  for (const [camel, snake] of expected) {
    const expectedValue = context[camel] ?? context[snake];
    if (expectedValue == null || rowValue(row, camel, snake) !== expectedValue) return 'stale';
  }
  const now = normalizedNow(context.now);
  const expiresAt = new Date(row.expires_at ?? row.expiresAt);
  if (!Number.isFinite(expiresAt.getTime()) || now.getTime() >= expiresAt.getTime()) return 'stale';
  return 'fresh';
}

function fingerprintForConfig(input, camel, snake, configId) {
  const direct = input[camel] ?? input[snake];
  if (typeof direct === 'string') return direct;
  const maps = input.fingerprints ?? input.fingerprintsByConfig;
  if (maps && maps[configId]) return maps[configId][camel] ?? maps[configId][snake];
  return undefined;
}

function listFreshCoveringEvidence(db, input) {
  const serviceType = normalizedRequiredString(input.serviceType ?? input.service_type, 'serviceType', { lowercase: true });
  const requested = normalizeCapability(serviceType, input.capability);
  const clauses = ['e.service_type = ?'];
  const params = [serviceType];
  if (input.configId != null || input.config_id != null) {
    const configId = input.configId ?? input.config_id;
    clauses.push('e.config_id = ?');
    params.push(configId);
  }
  if (input.logicalModelId != null || input.logical_model_id != null) {
    clauses.push('c.logical_model_id = ?');
    params.push(input.logicalModelId ?? input.logical_model_id);
  }
  const rows = db.prepare(`SELECT e.*, c.logical_model_id, c.is_active, c.canary_paused
    FROM provider_canary_evidence e
    JOIN ai_service_configs c ON c.id = e.config_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY e.config_id, e.capability_fingerprint`).all(...params);
  const result = [];
  for (const row of rows) {
    let capability;
    try {
      const parsed = JSON.parse(row.capability_json);
      capability = normalizeCapability(serviceType, parsed);
      const canonical = stableJson(capability);
      if (canonical !== row.capability_json || sha256(canonical) !== row.capability_fingerprint) continue;
    } catch (_) {
      continue;
    }
    const state = effectiveEvidenceState(row, {
      now: input.now,
      canaryPaused: row.canary_paused === 1,
      isActive: row.is_active === 1,
      configFingerprint: fingerprintForConfig(input, 'configFingerprint', 'config_fingerprint', row.config_id),
      costFingerprint: fingerprintForConfig(input, 'costFingerprint', 'cost_fingerprint', row.config_id),
      runtimeFingerprint: fingerprintForConfig(input, 'runtimeFingerprint', 'runtime_fingerprint', row.config_id),
    });
    if (state === 'fresh' && capabilityCovers(capability, requested)) {
      result.push({ ...row, effective_state: state, capability });
    }
  }
  return result;
}

module.exports = {
  MAX_EVIDENCE_AGE_MS,
  capabilityCovers,
  capabilityFingerprint,
  configFingerprint,
  costFingerprint,
  covers,
  effectiveEvidenceState,
  invalidateConfig,
  invalidateLogicalModel,
  listFreshCoveringEvidence,
  normalizeCapability,
  providerScopeKey,
  recordBudgetBlocked,
  recordFailure,
  recordSuccess,
  recordUnknown,
};
