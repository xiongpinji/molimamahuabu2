'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');

const aiConfigService = require('./aiConfigService');
const budgetService = require('./providerCanaryBudgetService');
const evidenceService = require('./providerCanaryEvidenceService');
const executorService = require('./providerCanaryExecutor');
const fixtureService = require('./providerCanaryFixtureService');
const inventoryService = require('./providerCanaryInventoryService');
const modelPriceService = require('./modelPriceService');
const runtimeService = require('./providerRuntimeFingerprintService');

const DEFAULT_INTERVAL_MS = 300_000;
const VALID_MODES = new Set(['off', 'shadow', 'enforce']);
const UNKNOWN_STATES = ['submission_unknown', 'result_unknown', 'artifact_unreadable'];
const BLOCK_EVENT_TYPES = {
  canary_paused: 'provider_canary_paused',
  cost_missing: 'provider_canary_cost_missing',
  budget_blocked: 'provider_canary_budget_blocked',
};

let schedulerState = null;
let paidRunInFlight = false;
const zeroCostMetrics = { unknown: null };

function nowIso(value) {
  const raw = typeof value === 'function' ? value() : value;
  const date = raw == null ? new Date() : new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new TypeError('now must be a valid date');
  return date.toISOString();
}

function parseMode(value, log) {
  const mode = String(value == null || value === '' ? 'off' : value).trim().toLowerCase();
  if (VALID_MODES.has(mode)) return mode;
  log?.error?.('Invalid provider canary mode; scheduler remains off', { mode });
  return 'off';
}

function parsePaidEnabled(value, log) {
  if (value === true || String(value).trim().toLowerCase() === 'true') return true;
  if (value === false || value == null || value === ''
      || String(value).trim().toLowerCase() === 'false') return false;
  log?.error?.('Invalid provider canary paid flag; paid scheduler remains off');
  return false;
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function uniqueSorted(values, normalize = (value) => value) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(normalize).filter((value) => value !== null))]
    .sort((left, right) => (typeof left === 'number' && typeof right === 'number'
      ? left - right
      : String(left).localeCompare(String(right), 'en')));
}

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function declaredCapabilities(config) {
  const settings = parseObject(config?.settings);
  const base = parseObject(settings.canvas_capabilities);
  const model = String(config?.default_model || config?.model?.[0] || '').trim();
  const entries = parseObject(settings.canvas_capabilities_by_model);
  const modelKey = Object.keys(entries).find((key) => key.toLowerCase() === model.toLowerCase());
  const perModel = modelKey ? parseObject(entries[modelKey]) : {};
  return { ...base, ...perModel };
}

function enumerateCapabilityProfiles(config) {
  const serviceType = String(config?.service_type || '').trim().toLowerCase();
  if (!serviceType) return [];
  const declared = declaredCapabilities(config);
  if (!Object.keys(declared).length) return [];
  const resolutions = uniqueSorted(declared.resolutions, (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized || null;
  });
  const aspectRatios = uniqueSorted(declared.aspectRatios ?? declared.aspect_ratios, (value) => {
    const normalized = String(value || '').trim();
    return normalized || null;
  });
  const durations = uniqueSorted(declared.durations, (value) => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  });
  if (serviceType === 'video' && durations.length === 0) return [];
  const dimensions = {
    resolutions: resolutions.length ? resolutions : [null],
    aspectRatios: aspectRatios.length ? aspectRatios : [null],
    durations: durations.length ? durations : [0],
    audioModes: declared.supportsAudio === true ? [false, true] : [false],
  };
  const maxImages = nonNegativeInteger(
    declared.maxImageReferences ?? declared.maxReferences ?? declared.max_reference_images,
  );
  const maxVideos = nonNegativeInteger(
    declared.maxVideoReferences ?? declared.max_video_references,
  );
  const maxAudio = nonNegativeInteger(
    declared.maxAudioReferences ?? declared.max_audio_references,
  );
  const profiles = [];
  for (const resolution of dimensions.resolutions) {
    for (const aspectRatio of dimensions.aspectRatios) {
      for (const duration of dimensions.durations) {
        for (const requiresAudio of dimensions.audioModes) {
          profiles.push(evidenceService.normalizeCapability(serviceType, {
            generationType: serviceType,
            resolution,
            aspectRatio,
            duration,
            count: 1,
            referenceImageCount: maxImages,
            referenceVideoCount: maxVideos,
            referenceAudioCount: maxAudio,
            requiresAudio,
            firstFrame: false,
            lastFrame: false,
            slotSemantics: Array.isArray(declared.slotSemantics) ? declared.slotSemantics : [],
            modelFeatures: declared.modelFeatures || [],
            userPriceContract: declared.userPriceContract || null,
          }));
        }
      }
    }
  }
  return profiles;
}

function loadConfigs(db) {
  const paused = new Map(db.prepare(`SELECT id, canary_paused FROM ai_service_configs
    WHERE deleted_at IS NULL`).all().map((row) => [row.id, row.canary_paused === 1]));
  return aiConfigService.listConfigs(db).map((config) => ({
    ...config,
    canary_paused: paused.get(config.id) || false,
  }));
}

function loadEvidenceRows(db) {
  return db.prepare('SELECT * FROM provider_canary_evidence ORDER BY config_id, capability_fingerprint').all();
}

function loadUnresolvedScopes(db) {
  const placeholders = UNKNOWN_STATES.map(() => '?').join(',');
  return new Set(db.prepare(`SELECT DISTINCT provider_scope_key FROM provider_canary_runs
    WHERE state IN (${placeholders})`).all(...UNKNOWN_STATES).map((row) => row.provider_scope_key));
}

function loadUserImpact(db) {
  const rows = db.prepare(`SELECT logical_model_id, COUNT(*) AS count
    FROM generation_route_requests GROUP BY logical_model_id`).all();
  return Object.fromEntries(rows.map((row) => [row.logical_model_id, row.count]));
}

function evidenceDue(row, nowMs, horizonMs) {
  if (!row) return true;
  if (['failing', 'submission_unknown', 'budget_blocked', 'disabled'].includes(row.state)) return false;
  if (row.state !== 'fresh') return row.state === 'stale' || row.state === 'never_verified';
  const expiresAt = Date.parse(row.expires_at || '');
  return !Number.isFinite(expiresAt) || expiresAt <= nowMs + horizonMs;
}

function selectDueProfiles(db, options = {}) {
  const now = nowIso(options.now);
  const nowMs = Date.parse(now);
  const horizonMs = Number.isFinite(Number(options.dueHorizonMs))
    ? Math.max(0, Number(options.dueHorizonMs))
    : DEFAULT_INTERVAL_MS;
  const configs = options.configs || loadConfigs(db);
  const evidenceRows = options.evidenceRows || loadEvidenceRows(db);
  const unresolvedScopes = options.unresolvedProviderScopes || loadUnresolvedScopes(db);
  const impact = options.userImpactByLogicalModel || loadUserImpact(db);
  const capabilityFingerprint = options.capabilityFingerprint || evidenceService.capabilityFingerprint;
  const providerScopeKey = options.providerScopeKey || evidenceService.providerScopeKey;
  const estimateCost = options.estimateCost || executorService.estimateCanaryCost;
  const evidenceByKey = new Map(evidenceRows.map((row) => [
    `${row.config_id}:${row.capability_fingerprint}`, row,
  ]));
  const due = [];
  for (const config of configs) {
    if (!config?.is_active || !config.logical_model_id) continue;
    const profiles = enumerateCapabilityProfiles(config);
    let scope;
    try { scope = providerScopeKey(config); } catch (_) { continue; }
    if (unresolvedScopes.has(scope)) continue;
    for (const capability of profiles) {
      const profileHash = capabilityFingerprint(config.service_type, capability, config);
      const evidence = evidenceByKey.get(`${config.id}:${profileHash}`) || null;
      if (!evidenceDue(evidence, nowMs, horizonMs) && !config.canary_paused) continue;
      let reservedCostMicros = null;
      let blockedReason = config.canary_paused ? 'canary_paused' : null;
      if (!blockedReason) {
        try {
          reservedCostMicros = estimateCost(db, config, capability);
          if (!Number.isSafeInteger(reservedCostMicros) || reservedCostMicros <= 0) {
            blockedReason = 'cost_missing';
          }
        } catch (_) {
          blockedReason = 'cost_missing';
        }
      }
      due.push({
        config,
        capability,
        profileKey: profileHash,
        providerScopeKey: scope,
        evidence,
        expiresAt: evidence?.expires_at || '0000-01-01T00:00:00.000Z',
        userImpact: nonNegativeInteger(impact[config.logical_model_id]),
        priority: Number(config.priority) || 0,
        reservedCostMicros,
        blockedReason,
        would_be_hidden: !evidence || evidence.state !== 'fresh' || Date.parse(evidence.expires_at) <= nowMs,
      });
    }
  }
  return due.sort((left, right) => (
    String(left.expiresAt).localeCompare(String(right.expiresAt))
    || right.userImpact - left.userImpact
    || right.priority - left.priority
    || (left.reservedCostMicros ?? Number.MAX_SAFE_INTEGER)
      - (right.reservedCostMicros ?? Number.MAX_SAFE_INTEGER)
    || left.config.id - right.config.id
    || left.profileKey.localeCompare(right.profileKey)
  ));
}

function windowStart(now, intervalMs = DEFAULT_INTERVAL_MS) {
  const millis = Date.parse(now);
  return new Date(Math.floor(millis / intervalMs) * intervalMs).toISOString();
}

function recordEventOnce(db, input) {
  const rows = db.prepare(`SELECT safe_details FROM provider_stability_events
    WHERE event_type = ? AND logical_model_id IS ? AND config_id IS ? AND created_at >= ?`)
    .all(input.eventType, input.logicalModelId || null, input.configId || null, input.windowStart);
  const duplicate = rows.some((row) => {
    try { return JSON.parse(row.safe_details || '{}').category === input.category; } catch (_) { return false; }
  });
  if (duplicate) return false;
  db.prepare(`INSERT INTO provider_stability_events
      (severity, event_type, logical_model_id, config_id, task_state, safe_details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(
      input.severity || 'P3',
      input.eventType,
      input.logicalModelId || null,
      input.configId || null,
      input.taskState || null,
      JSON.stringify({ category: input.category }),
      input.now,
    );
  return true;
}

async function withTimeout(work, timeoutMs, options = {}) {
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  let timeout;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timeout = setTimeoutFn(() => reject(new Error('probe timeout')), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeoutFn(timeout);
  }
}

async function probeApplicationHealth(_db, options = {}) {
  const healthUrl = options.healthUrl || `http://127.0.0.1:${process.env.PORT || 5679}/health`;
  const fetchFn = options.fetchFn || fetch;
  try {
    const response = await withTimeout(
      fetchFn(healthUrl, { method: 'GET' }),
      options.timeoutMs || 5_000,
      options,
    );
    return { ok: response.ok, category: response.ok ? null : 'application_health_failed' };
  } catch (_) {
    return { ok: false, category: 'application_health_failed' };
  }
}

function probeDatabase(db) {
  try {
    const one = db.prepare('SELECT 1 AS ok').get();
    const quick = db.pragma('quick_check', { simple: true });
    return { ok: one?.ok === 1 && String(quick).toLowerCase() === 'ok', category: 'database_integrity' };
  } catch (_) {
    return { ok: false, category: 'database_unavailable' };
  }
}

function probeStorage(_db, options = {}) {
  const fsApi = options.fsApi || fs;
  try {
    const root = path.resolve(options.storageRoot);
    fsApi.accessSync(root, fs.constants.W_OK);
    const stats = typeof fsApi.statfsSync === 'function' ? fsApi.statfsSync(root) : null;
    const freeBytes = stats ? Number(stats.bavail) * Number(stats.bsize) : null;
    return { ok: freeBytes == null || freeBytes > 0, freeBytes, category: 'storage_unavailable' };
  } catch (_) {
    return { ok: false, freeBytes: 0, category: 'storage_unavailable' };
  }
}

function probeReconciliation(db, options = {}) {
  try {
    const active = db.prepare(`SELECT COUNT(*) AS count FROM generation_route_requests
      WHERE state IN ('running', 'accepted')`).get().count;
    const routeUnknown = db.prepare(`SELECT COUNT(*) AS count FROM generation_route_requests
      WHERE state = 'needs_attention'`).get().count;
    const canaryUnknown = db.prepare(`SELECT COUNT(*) AS count FROM provider_canary_runs
      WHERE state IN ('submission_unknown', 'result_unknown', 'artifact_unreadable')`).get().count;
    const unknown = routeUnknown + canaryUnknown;
    const state = options.metricState || zeroCostMetrics;
    const growth = state.unknown == null ? 0 : Math.max(0, unknown - state.unknown);
    state.unknown = unknown;
    return {
      ok: growth === 0,
      active,
      unknown,
      routeUnknown,
      canaryUnknown,
      growth,
      category: 'unknown_reconciliation_growth',
    };
  } catch (_) {
    return { ok: false, category: 'reconciliation_unavailable' };
  }
}

function heldMatches(db, accountTable, reservationTable, key) {
  const accounts = db.prepare(`SELECT ${key} AS id, held FROM ${accountTable}`).all();
  const held = new Map(db.prepare(`SELECT ${key} AS id, COALESCE(SUM(amount), 0) AS amount
    FROM ${reservationTable} WHERE status = 'held' GROUP BY ${key}`).all()
    .map((row) => [row.id, row.amount]));
  const accountIds = new Set(accounts.map((row) => row.id));
  return accounts.every((row) => row.held === (held.get(row.id) || 0))
    && [...held.keys()].every((id) => accountIds.has(id));
}

function probeCredits(db) {
  try {
    const tenantOk = heldMatches(db, 'tenant_credit_accounts', 'tenant_usage_reservations', 'tenant_id');
    const legacyOk = heldMatches(db, 'credit_accounts', 'usage_reservations', 'user_id');
    return { ok: tenantOk && legacyOk, category: 'credit_held_mismatch' };
  } catch (_) {
    return { ok: false, category: 'credit_held_unavailable' };
  }
}

function probeMappings(db, options = {}) {
  try {
    const report = inventoryService.buildCanaryReadiness(db, {
      runtimeFingerprintResolver: options.runtimeFingerprintResolver
        || ((config) => runtimeService.runtimeFingerprintForConfig(config)),
    });
    return {
      ok: report.routes.every((row) => row.blockers.length === 0),
      blocked: report.routes.filter((row) => row.blockers.length > 0).length,
      category: 'route_mapping_incomplete',
    };
  } catch (_) {
    return { ok: false, category: 'route_mapping_unavailable' };
  }
}

function openTls(hostname, port, timeoutMs, options = {}) {
  const tlsConnect = options.tlsConnect || tls.connect;
  let socket;
  return withTimeout(new Promise((resolve, reject) => {
    socket = tlsConnect({ host: hostname, port, servername: hostname, rejectUnauthorized: true }, resolve);
    socket.once('error', reject);
  }), timeoutMs, options).finally(() => socket?.destroy?.());
}

async function probeProvider(_db, config, options = {}) {
  let base;
  try { base = new URL(config.base_url); } catch (_) {
    return { ok: false, category: 'provider_url_invalid' };
  }
  const timeoutMs = options.timeoutMs || 5_000;
  const dnsLookup = options.dnsLookup || dns.lookup;
  const fetchFn = options.fetchFn || fetch;
  try {
    await withTimeout(dnsLookup(base.hostname), timeoutMs, options);
  } catch (_) {
    return { ok: false, category: 'provider_dns_failed' };
  }
  if (base.protocol === 'https:') {
    try { await openTls(base.hostname, Number(base.port) || 443, timeoutMs, options); } catch (_) {
      return { ok: false, category: 'provider_tls_failed' };
    }
  }
  if (!String(config.api_key || '').trim()) return { ok: false, category: 'provider_auth_missing' };
  let endpoint;
  try {
    endpoint = config.query_endpoint
      ? new URL(String(config.query_endpoint).replace(/\{[^}]+\}/g, 'provider-canary-read-only-check'), base).toString()
      : new URL('models', base.toString().endsWith('/') ? base : `${base}/`).toString();
  } catch (_) {
    return { ok: false, category: 'provider_read_only_url_invalid' };
  }
  try {
    const response = await withTimeout(fetchFn(endpoint, {
      method: 'GET',
      headers: { authorization: `Bearer ${config.api_key}` },
    }), timeoutMs, options);
    return { ok: response.ok, category: response.ok ? null : 'provider_read_only_failed' };
  } catch (_) {
    return { ok: false, category: 'provider_read_only_failed' };
  }
}

const DEFAULT_PROBES = {
  applicationHealth: probeApplicationHealth,
  database: probeDatabase,
  storage: probeStorage,
  reconciliation: probeReconciliation,
  credits: probeCredits,
  mappings: probeMappings,
  provider: probeProvider,
};

async function invokeProbe(probe, args, fallbackCategory) {
  try {
    const result = await probe(...args);
    if (result && typeof result.ok === 'boolean') return result;
    return { ok: false, category: fallbackCategory };
  } catch (_) {
    return { ok: false, category: fallbackCategory };
  }
}

async function runZeroCostSweep(db, log, options = {}) {
  const now = nowIso(options.now);
  const intervalMs = Number(options.intervalMs) || DEFAULT_INTERVAL_MS;
  const start = windowStart(now, intervalMs);
  const configs = options.configs || loadConfigs(db).filter((config) => config.is_active);
  const probes = { ...DEFAULT_PROBES, ...(options.probes || {}) };
  const globalChecks = {};
  for (const name of ['applicationHealth', 'database', 'storage', 'reconciliation', 'credits', 'mappings']) {
    globalChecks[name] = await invokeProbe(probes[name], [db, options], `${name}_failed`);
  }
  db.prepare(`UPDATE provider_canary_evidence
    SET state = 'stale', updated_at = ?
    WHERE state = 'fresh' AND (expires_at IS NULL OR expires_at <= ?)`)
    .run(now, now);

  const routes = [];
  for (const config of configs) {
    const provider = await invokeProbe(probes.provider, [db, config, options], 'provider_probe_failed');
    const failures = [
      ...Object.entries(globalChecks).filter(([, result]) => !result.ok),
      ...(!provider.ok ? [['provider', provider]] : []),
    ];
    const state = config.canary_paused ? 'disabled' : failures.length ? 'failed' : 'healthy';
    const category = config.canary_paused
      ? 'canary_paused'
      : failures[0]?.[1]?.category || null;
    db.prepare(`INSERT INTO provider_zero_cost_checks
        (config_id, state, category, safe_summary, checked_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(config_id) DO UPDATE SET state = excluded.state, category = excluded.category,
        safe_summary = excluded.safe_summary, checked_at = excluded.checked_at,
        updated_at = excluded.updated_at`)
      .run(config.id, state, category, category ? `category=${category}` : null, now, now);
    if (category && category !== 'canary_paused') {
      recordEventOnce(db, {
        severity: category === 'database_unavailable' || category === 'storage_unavailable' ? 'P0' : 'P2',
        eventType: 'provider_canary_zero_cost_check',
        logicalModelId: config.logical_model_id,
        configId: config.id,
        category,
        taskState: state,
        now,
        windowStart: start,
      });
    }
    const fresh = db.prepare(`SELECT 1 FROM provider_canary_evidence
      WHERE config_id = ? AND state = 'fresh' AND expires_at > ? LIMIT 1`).get(config.id, now);
    routes.push({
      logical_model_id: config.logical_model_id,
      config_id: config.id,
      state,
      category,
      would_be_hidden: !fresh || state !== 'healthy',
    });
  }
  const summary = {
    checked_at: now,
    global: globalChecks,
    routes,
    catalog_mutated: false,
  };
  if (routes.some((row) => row.state === 'failed')) {
    log?.warn?.('Provider canary zero-cost sweep found degraded routes', {
      failed: routes.filter((row) => row.state === 'failed').length,
    });
  }
  return summary;
}

function priceSnapshot(db, config) {
  const model = String(config.logical_model_id || config.default_model || config.model?.[0] || '').trim();
  return modelPriceService.list(db).find((row) => row.model.toLowerCase() === model.toLowerCase()) || null;
}

function costHash(db, config) {
  const price = priceSnapshot(db, config);
  const tiers = price
    ? Object.entries(price.resolution_prices || {}).map(([resolution, value]) => ({ resolution, ...value }))
    : [];
  return evidenceService.costFingerprint(price, tiers);
}

function blockEvent(db, candidate, reason, now) {
  return recordEventOnce(db, {
    severity: 'P3',
    eventType: BLOCK_EVENT_TYPES[reason],
    logicalModelId: candidate.config.logical_model_id,
    configId: candidate.config.id,
    category: reason,
    taskState: 'budget_blocked',
    now,
    windowStart: windowStart(now),
  });
}

function deterministicRunIdentity(candidate) {
  const predecessor = candidate.evidence?.run_id || 'initial';
  const dependencyKey = [
    candidate.configFingerprint,
    candidate.costFingerprint,
    candidate.runtimeFingerprint,
  ].join(':');
  const key = `provider-canary:${candidate.config.id}:${candidate.profileKey}:${dependencyKey}:after:${predecessor}`;
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return { idempotencyKey: key, id: `pc-${hash.slice(0, 40)}` };
}

function reserveWithGlobalSlot(db, input, injectedBudgetService) {
  if (injectedBudgetService) return injectedBudgetService.reserve(db, input);
  return db.transaction(() => {
    const active = db.prepare(`SELECT id FROM provider_canary_runs
      WHERE state IN ('reserved', 'submitting', 'accepted', 'verifying')
      ORDER BY created_at, id LIMIT 1`).get();
    if (active) {
      const error = new Error('another provider canary run owns the global execution slot');
      error.code = 'PROVIDER_CANARY_GLOBAL_BUSY';
      throw error;
    }
    return budgetService.reserve(db, input);
  }).immediate();
}

async function runOnePaidCanary(db, log, options = {}) {
  if (!parsePaidEnabled(options.paidEnabled, log)) return { state: 'paid_disabled' };
  if (paidRunInFlight) return { state: 'busy' };
  paidRunInFlight = true;
  try {
    const now = nowIso(options.now);
    const candidates = options.dueProfiles || selectDueProfiles(db, options);
    let sawBlock = false;
    for (const candidate of candidates.filter((row) => row.blockedReason)) {
      blockEvent(db, candidate, candidate.blockedReason, now);
      sawBlock = true;
    }
    for (const candidate of candidates.filter((row) => !row.blockedReason)) {
      const fingerprint = options.fingerprint || {};
      const capabilityFingerprint = (fingerprint.capability || evidenceService.capabilityFingerprint)(
        candidate.config.service_type, candidate.capability, candidate.config,
      );
      const configFingerprint = (fingerprint.config || evidenceService.configFingerprint)(candidate.config);
      const routeCostFingerprint = (fingerprint.cost || (() => costHash(db, candidate.config)))(candidate.config);
      const runtime = (fingerprint.runtime || runtimeService.runtimeFingerprintForConfig)(candidate.config);
      if (!runtime || runtime.ok === false || !runtime.fingerprint) {
        blockEvent(db, candidate, 'cost_missing', now);
        return { state: 'blocked', reason: 'runtime_missing' };
      }
      const scope = candidate.providerScopeKey
        || (fingerprint.scope || evidenceService.providerScopeKey)(candidate.config);
      const identity = deterministicRunIdentity({
        ...candidate,
        profileKey: candidate.profileKey || capabilityFingerprint,
        configFingerprint,
        costFingerprint: routeCostFingerprint,
        runtimeFingerprint: runtime.fingerprint,
      });
      let run;
      try {
        run = reserveWithGlobalSlot(db, {
          id: identity.id,
          idempotencyKey: identity.idempotencyKey,
          route: {
            configId: candidate.config.id,
            logicalModelId: candidate.config.logical_model_id,
            serviceType: candidate.config.service_type,
            capabilityFingerprint,
            configFingerprint,
            costFingerprint: routeCostFingerprint,
            runtimeFingerprint: runtime.fingerprint,
            providerScopeKey: scope,
          },
          reservedCostMicros: candidate.reservedCostMicros,
          currency: 'CNY',
          now,
        }, options.budgetService);
      } catch (error) {
        if (error.code === 'PROVIDER_CANARY_GLOBAL_BUSY') return { state: 'busy' };
        if (String(error.code || '').includes('BUDGET_EXCEEDED')) {
          blockEvent(db, candidate, 'budget_blocked', now);
          return { state: 'budget_blocked' };
        }
        throw error;
      }
      if (run.state && run.state !== 'reserved') return { state: run.state, runId: run.id };
      const buildFixtures = options.buildFixtures || ((input) => fixtureService.buildReferenceInputs(input));
      const fixtures = await buildFixtures({
        capability: candidate.capability,
        storageRoot: options.storageRoot,
        filesBaseUrl: options.filesBaseUrl || process.env.PROVIDER_CANARY_FILES_BASE_URL,
        secret: options.assetSecret || process.env.PROVIDER_CANARY_ASSET_SECRET,
        now,
      });
      const result = await (options.executor || executorService).executeCanaryRun(db, log, run, {
        capability: candidate.capability,
        fixtures,
        storageRoot: options.storageRoot,
        now,
        ...(options.executorOptions || {}),
      });
      return { ...result, runId: run.id };
    }
    return sawBlock ? { state: 'blocked' } : { state: 'not_due' };
  } finally {
    paidRunInFlight = false;
  }
}

function startProviderCanaryScheduler(db, log, options = {}) {
  stopProviderCanaryScheduler();
  const mode = parseMode(options.mode, log);
  if (mode === 'off') return null;
  const paidEnabled = parsePaidEnabled(options.paidEnabled, log);
  const intervalMs = Math.max(Number(options.intervalMs) || DEFAULT_INTERVAL_MS, 1_000);
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  const metricState = { unknown: null };
  let tickInFlight = false;
  const tick = async () => {
    if (tickInFlight) return { state: 'busy' };
    tickInFlight = true;
    try {
      await (options.runZeroCostSweep || runZeroCostSweep)(db, log, {
        ...options,
        ...(options.zeroCostOptions || {}),
        mode,
        intervalMs,
        metricState,
      });
      if (!paidEnabled) return { state: 'paid_disabled' };
      return await (options.runOnePaidCanary || runOnePaidCanary)(db, log, {
        ...options,
        mode,
        paidEnabled: true,
      });
    } catch (error) {
      log?.error?.('Provider canary scheduler tick failed', { error: error.message });
      return { state: 'failed' };
    } finally {
      tickInFlight = false;
    }
  };
  const timer = setIntervalFn(tick, intervalMs);
  timer.unref?.();
  schedulerState = { timer, clearIntervalFn };
  return timer;
}

function stopProviderCanaryScheduler() {
  if (!schedulerState) return false;
  schedulerState.clearIntervalFn(schedulerState.timer);
  schedulerState = null;
  return true;
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  runZeroCostSweep,
  enumerateCapabilityProfiles,
  selectDueProfiles,
  runOnePaidCanary,
  startProviderCanaryScheduler,
  stopProviderCanaryScheduler,
};
