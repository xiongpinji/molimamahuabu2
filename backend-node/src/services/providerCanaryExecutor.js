'use strict';

const aiClient = require('./aiClient');
const aiConfigService = require('./aiConfigService');
const imageClient = require('./imageClient');
const videoClient = require('./videoClient');
const modelPriceService = require('./modelPriceService');
const budgetService = require('./providerCanaryBudgetService');
const evidenceService = require('./providerCanaryEvidenceService');
const artifactService = require('./providerCanaryArtifactService');
const { classifyProviderFailure, toSafeErrorSummary } = require('./providerErrorClassifier');

const SAFE_MEDIA_PROMPT = '生成一个蓝色圆形位于白色背景中央。';
const SAFE_TEXT_PROMPT = '只返回固定短词 CANARY_OK';
const SAFE_TEXT_SYSTEM_PROMPT = '严格按要求返回，不添加解释。';

function serviceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isoNow(value) {
  const candidate = typeof value === 'function' ? value() : value;
  const date = candidate == null ? new Date() : new Date(candidate);
  if (!Number.isFinite(date.getTime())) throw new TypeError('now must be a valid date');
  return date.toISOString();
}

function positiveConfigId(config) {
  if (!config || !Number.isSafeInteger(config.id) || config.id <= 0) {
    throw serviceError('PROVIDER_CANARY_CONFIG_INVALID', 'provider canary config is invalid');
  }
  return config.id;
}

function array(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : [];
}

function requiredFixtureCount(capability, camel, snake) {
  const value = capability?.[camel] ?? capability?.[snake] ?? 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${camel} must be a non-negative safe integer`);
  return value;
}

function exactFixtures(fixtures, capability) {
  const normalized = {
    imageUrls: array(fixtures?.imageUrls),
    videoUrls: array(fixtures?.videoUrls),
    audioUrls: array(fixtures?.audioUrls),
    firstFrameUrl: typeof fixtures?.firstFrameUrl === 'string' && fixtures.firstFrameUrl.trim()
      ? fixtures.firstFrameUrl.trim()
      : null,
    lastFrameUrl: typeof fixtures?.lastFrameUrl === 'string' && fixtures.lastFrameUrl.trim()
      ? fixtures.lastFrameUrl.trim()
      : null,
  };
  const expected = {
    imageUrls: requiredFixtureCount(capability, 'referenceImageCount', 'reference_image_count'),
    videoUrls: requiredFixtureCount(capability, 'referenceVideoCount', 'reference_video_count'),
    audioUrls: requiredFixtureCount(capability, 'referenceAudioCount', 'reference_audio_count'),
  };
  for (const [key, count] of Object.entries(expected)) {
    if (normalized[key].length !== count) {
      throw serviceError('PROVIDER_CANARY_FIXTURE_MISMATCH', `${key} does not match the capability`);
    }
  }
  const firstFrame = capability?.firstFrame ?? capability?.first_frame ?? false;
  const lastFrame = capability?.lastFrame ?? capability?.last_frame ?? false;
  if (Boolean(normalized.firstFrameUrl) !== Boolean(firstFrame)
      || Boolean(normalized.lastFrameUrl) !== Boolean(lastFrame)) {
    throw serviceError('PROVIDER_CANARY_FIXTURE_MISMATCH', 'frame fixtures do not match the capability');
  }
  return normalized;
}

function buildCanaryRequest(_db, config, capability, fixtures = {}) {
  const configId = positiveConfigId(config);
  const serviceType = String(config.service_type || '').trim().toLowerCase();
  if (!['image', 'storyboard_image', 'video', 'text'].includes(serviceType)) {
    throw serviceError('PROVIDER_CANARY_SERVICE_UNSUPPORTED', 'provider canary service type is unsupported');
  }
  if (serviceType === 'text') {
    return {
      config_id: configId,
      user_prompt: SAFE_TEXT_PROMPT,
      system_prompt: SAFE_TEXT_SYSTEM_PROMPT,
      options: { max_tokens: 16, temperature: 0 },
    };
  }
  const refs = exactFixtures(fixtures, capability);
  const aspectRatio = capability?.aspectRatio ?? capability?.aspect_ratio ?? null;
  const resolution = capability?.resolution ?? null;
  if (serviceType === 'video') {
    return {
      config_id: configId,
      prompt: SAFE_MEDIA_PROMPT,
      duration: capability?.duration ?? null,
      resolution,
      aspect_ratio: aspectRatio,
      reference_urls: refs.imageUrls,
      reference_video_urls: refs.videoUrls,
      reference_audio_urls: refs.audioUrls,
      first_frame_url: refs.firstFrameUrl,
      last_frame_url: refs.lastFrameUrl,
    };
  }
  return {
    config_id: configId,
    prompt: SAFE_MEDIA_PROMPT,
    resolution,
    size: resolution,
    aspect_ratio: aspectRatio,
    reference_image_urls: refs.imageUrls,
  };
}

function configuredModel(config) {
  return String(config.logical_model_id || config.default_model || config.model?.[0] || '').trim();
}

function estimateCanaryCost(db, config, capability = {}) {
  const serviceType = String(config?.service_type || '').trim().toLowerCase();
  const model = configuredModel(config);
  if (!model) throw serviceError('PROVIDER_CANARY_COST_NOT_CONFIGURED', 'provider canary cost model is missing');
  let quote;
  try {
    quote = modelPriceService.quoteCost(db, model, {
      quantity: serviceType === 'video' ? capability.duration : 1,
      resolution: capability.resolution,
      inputTokens: serviceType === 'text' ? 32 : 0,
      outputTokens: serviceType === 'text' ? 16 : 0,
    });
  } catch (error) {
    throw serviceError('PROVIDER_CANARY_COST_NOT_CONFIGURED', error.message);
  }
  if (!Number.isSafeInteger(quote.cost_micros) || quote.cost_micros <= 0) {
    throw serviceError('PROVIDER_CANARY_COST_NOT_POSITIVE', 'provider canary cost must be positive');
  }
  return quote.cost_micros;
}

function currentRun(db, run) {
  const id = typeof run === 'string' ? run : run?.id;
  if (typeof id !== 'string' || !id.trim()) {
    throw serviceError('PROVIDER_CANARY_RUN_INVALID', 'provider canary run is invalid');
  }
  const row = db.prepare('SELECT * FROM provider_canary_runs WHERE id = ?').get(id.trim());
  if (!row) throw serviceError('PROVIDER_CANARY_RUN_NOT_FOUND', 'provider canary run not found');
  return row;
}

function loadConfig(db, run) {
  const config = aiConfigService.getConfig(db, run.config_id);
  const row = db.prepare(`SELECT service_type, is_active, canary_paused
    FROM ai_service_configs WHERE id = ? AND deleted_at IS NULL`).get(run.config_id);
  if (!config || !row || row.is_active !== 1 || row.canary_paused === 1
      || String(row.service_type).toLowerCase() !== String(run.service_type).toLowerCase()) {
    throw serviceError('PROVIDER_CANARY_CONFIG_UNAVAILABLE', 'provider canary config is unavailable');
  }
  return config;
}

function assertReservedAndUnblocked(db, run) {
  if (run.state !== 'reserved') {
    throw serviceError('PROVIDER_CANARY_INVALID_STATE_TRANSITION', 'provider canary run must be reserved');
  }
  const blocked = db.prepare(`SELECT id FROM provider_canary_runs
    WHERE provider_scope_key = ? AND id <> ?
      AND state IN ('submission_unknown', 'result_unknown', 'artifact_unreadable')
    ORDER BY created_at LIMIT 1`).get(run.provider_scope_key, run.id);
  if (blocked) {
    throw serviceError('PROVIDER_CANARY_SCOPE_BLOCKED', 'provider scope has an unresolved canary result');
  }
}

function markVerifying(db, runId, now) {
  const result = db.prepare(`UPDATE provider_canary_runs
    SET state = 'verifying', updated_at = ?
    WHERE id = ? AND state IN ('submitting', 'accepted')`).run(now, runId);
  if (result.changes !== 1) {
    throw serviceError('PROVIDER_CANARY_INVALID_STATE_TRANSITION', 'provider canary cannot enter verification');
  }
}

function safeMeta(errorOrResult, fallback = {}) {
  const meta = errorOrResult?.route_meta || errorOrResult?.routeMeta || {};
  const rawMessage = typeof errorOrResult?.error === 'string'
    ? errorOrResult.error
    : errorOrResult?.message;
  const statusMatch = typeof rawMessage === 'string'
    ? rawMessage.match(/(?:HTTP|请求失败\s*:)\s*([1-5]\d\d)\b/i)
    : null;
  const parsedStatus = statusMatch ? Number(statusMatch[1]) : undefined;
  return {
    httpStatus: Number.isInteger(meta.httpStatus)
      ? meta.httpStatus
      : (parsedStatus ?? fallback.httpStatus),
    providerCode: meta.providerCode ?? fallback.providerCode,
    providerTaskId: meta.providerTaskId ?? fallback.providerTaskId,
    phase: meta.phase ?? fallback.phase,
    requestBodySent: meta.requestBodySent ?? fallback.requestBodySent,
    transportCode: meta.transportCode || errorOrResult?.code,
    explicitlyRejected: meta.explicitlyRejected ?? fallback.explicitlyRejected,
    artifactReadable: meta.artifactReadable ?? fallback.artifactReadable,
  };
}

function updateSafeSummary(db, runId, category, meta, now) {
  const summary = toSafeErrorSummary({ ...meta, category });
  db.prepare(`UPDATE provider_canary_runs SET safe_error_summary = ?, updated_at = ?
    WHERE id = ?`).run(summary, now, runId);
  return summary;
}

function evidenceInput(run, capability, now, state) {
  return {
    runId: run.id,
    configId: run.config_id,
    serviceType: run.service_type,
    capability,
    configFingerprint: run.config_fingerprint,
    costFingerprint: run.cost_fingerprint,
    runtimeFingerprint: run.runtime_fingerprint,
    now,
    ...(state ? { state } : {}),
  };
}

function settleFailure(db, run, capability, meta, now) {
  const classification = classifyProviderFailure(meta);
  budgetService.settleDefinitiveFailure(db, run.id, 0, classification.category, now);
  updateSafeSummary(db, run.id, classification.category, meta, now);
  evidenceService.recordFailure(db, evidenceInput(run, capability, now));
  return { state: 'failed', category: classification.category };
}

function settleUnknownWithoutTask(db, run, state, category, now) {
  const result = db.prepare(`UPDATE provider_canary_runs
    SET state = ?, error_category = ?, finished_at = ?, updated_at = ?
    WHERE id = ? AND state = 'verifying'`).run(state, category, now, now, run.id);
  if (result.changes !== 1) {
    throw serviceError('PROVIDER_CANARY_INVALID_STATE_TRANSITION', 'provider canary unknown result transition failed');
  }
}

function settleUnknown(db, run, capability, state, category, taskId, meta, now) {
  if (taskId) budgetService.settleUnknown(db, run.id, state, category, taskId, now);
  else settleUnknownWithoutTask(db, run, state, category, now);
  updateSafeSummary(db, run.id, category, meta, now);
  evidenceService.recordUnknown(db, evidenceInput(run, capability, now, state));
  return { state, category };
}

function normalizedArtifact(summary, runId, serviceType) {
  const path = summary?.relative_path || (serviceType === 'text' && summary?.sha256
    ? `_system/provider-canary/runs/${runId}/text.digest`
    : null);
  if (!path) throw new Error('provider canary artifact summary is missing');
  return { path, sha256: summary.sha256, bytes: summary.bytes };
}

async function executeCanaryRun(db, log, runInput, options = {}) {
  const run = currentRun(db, runInput);
  assertReservedAndUnblocked(db, run);
  const config = loadConfig(db, run);
  const capability = evidenceService.normalizeCapability(run.service_type, options.capability);
  if (evidenceService.capabilityFingerprint(run.service_type, capability) !== run.capability_fingerprint) {
    throw serviceError('PROVIDER_CANARY_CAPABILITY_MISMATCH', 'provider canary capability does not match the run');
  }
  const now = isoNow(options.now);
  const request = buildCanaryRequest(db, config, capability, options.fixtures);
  const clients = {
    callImageApi: options.clients?.callImageApi || imageClient.callImageApi,
    callVideoApi: options.clients?.callVideoApi || videoClient.callVideoApi,
    pollVideoTask: options.clients?.pollVideoTask || videoClient.pollVideoTask,
    generateTextForConfigId: options.clients?.generateTextForConfigId || aiClient.generateTextForConfigId,
  };
  const artifacts = {
    materializeImage: options.artifacts?.materializeImage || artifactService.materializeImage,
    materializeVideo: options.artifacts?.materializeVideo || artifactService.materializeVideo,
    verifyText: options.artifacts?.verifyText || artifactService.verifyText,
  };
  let submitCount = 0;
  budgetService.markSubmitting(db, run.id, now);
  let result;
  try {
    submitCount += 1;
    if (run.service_type === 'video') result = await clients.callVideoApi(db, log, request);
    else if (['image', 'storyboard_image'].includes(run.service_type)) {
      result = await clients.callImageApi(db, log, request);
    } else if (run.service_type === 'text') {
      result = await clients.generateTextForConfigId(
        db,
        log,
        config.id,
        request.user_prompt,
        request.system_prompt,
        request.options,
      );
    } else {
      throw serviceError('PROVIDER_CANARY_SERVICE_UNSUPPORTED', 'provider canary service type is unsupported');
    }
  } catch (error) {
    const meta = safeMeta(error);
    const classification = classifyProviderFailure(meta);
    if (classification.definitiveNotAccepted) {
      return { ...settleFailure(db, run, capability, meta, now), submitCount };
    }
    const category = classification.category === 'artifact_unreadable'
      ? 'artifact_unreadable'
      : 'submission_unknown';
    budgetService.settleUnknown(db, run.id, category, category, meta.providerTaskId || null, now);
    updateSafeSummary(db, run.id, category, meta, now);
    evidenceService.recordUnknown(db, evidenceInput(run, capability, now, category));
    return { state: category, category, submitCount };
  }

  let providerTaskId = null;
  if (run.service_type === 'video') {
    providerTaskId = String(result?.task_id || result?.provider_task_id || '').trim() || null;
    if (providerTaskId) {
      budgetService.markAccepted(db, run.id, providerTaskId, now);
      try {
        result = await clients.pollVideoTask(
          db,
          log,
          null,
          providerTaskId,
          config,
          options.maxPollAttempts,
          options.pollIntervalMs,
          options.pollRequestOptions || {},
        );
      } catch (error) {
        const meta = safeMeta(error, { providerTaskId });
        const settled = settleUnknown(
          db, run, capability, 'result_unknown', 'result_unknown', providerTaskId, meta, now,
        );
        return { ...settled, submitCount };
      }
      if (!result?.video_url) {
        const meta = safeMeta(result, { providerTaskId });
        const settled = settleUnknown(
          db, run, capability, 'result_unknown', 'result_unknown', providerTaskId, meta, now,
        );
        return { ...settled, submitCount };
      }
    }
  }

  const meta = safeMeta(result);
  if (result && typeof result === 'object' && result.error
      && !(result.image_url || result.video_url)) {
    const classification = classifyProviderFailure(meta);
    if (classification.definitiveNotAccepted) {
      return { ...settleFailure(db, run, capability, meta, now), submitCount };
    }
    if (classification.category === 'submission_unknown'
        || classification.category === 'forbidden_unknown') {
      const state = 'submission_unknown';
      budgetService.settleUnknown(db, run.id, state, state, null, now);
      updateSafeSummary(db, run.id, state, meta, now);
      evidenceService.recordUnknown(db, evidenceInput(run, capability, now, state));
      return { state, category: state, submitCount };
    }
    if (meta.providerTaskId) {
      budgetService.markAccepted(db, run.id, String(meta.providerTaskId), now);
    }
    markVerifying(db, run.id, now);
    const state = classification.category === 'artifact_unreadable'
      ? 'artifact_unreadable'
      : 'result_unknown';
    const settled = settleUnknown(
      db, run, capability, state, state, meta.providerTaskId || null, meta, now,
    );
    return { ...settled, submitCount };
  }

  if (run.service_type !== 'text'
      && !result?.image_url
      && !result?.video_url) {
    markVerifying(db, run.id, now);
    const settled = settleUnknown(
      db,
      run,
      capability,
      'result_unknown',
      'result_unknown',
      providerTaskId,
      { ...meta, httpStatus: meta.httpStatus || 200 },
      now,
    );
    return { ...settled, submitCount };
  }

  markVerifying(db, run.id, now);
  let summary;
  try {
    if (run.service_type === 'video') {
      summary = await artifacts.materializeVideo(result.video_url, {
        storageRoot: options.storageRoot,
        runId: run.id,
        ...(options.artifactOptions || {}),
      });
    } else if (['image', 'storyboard_image'].includes(run.service_type)) {
      summary = await artifacts.materializeImage(result, {
        storageRoot: options.storageRoot,
        runId: run.id,
        ...(options.artifactOptions || {}),
      });
    } else {
      summary = artifacts.verifyText(result);
    }
  } catch (_) {
    const settled = settleUnknown(
      db,
      run,
      capability,
      'artifact_unreadable',
      'artifact_unreadable',
      providerTaskId,
      { httpStatus: 200, artifactReadable: false },
      now,
    );
    return { ...settled, submitCount };
  }

  const artifact = normalizedArtifact(summary, run.id, run.service_type);
  const actualCostMicros = options.actualCostMicros ?? run.reserved_cost_micros;
  budgetService.settleSuccess(db, run.id, actualCostMicros, artifact, now);
  evidenceService.recordSuccess(db, evidenceInput(run, capability, now));
  return { state: 'succeeded', submitCount, artifact };
}

module.exports = {
  buildCanaryRequest,
  estimateCanaryCost,
  executeCanaryRun,
};
