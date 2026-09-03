'use strict';

const aiClient = require('./aiClient');
const aiConfigService = require('./aiConfigService');
const imageClient = require('./imageClient');
const ttsService = require('./ttsService');
const videoClient = require('./videoClient');
const routeCostService = require('./providerRouteCostService');
const budgetService = require('./providerCanaryBudgetService');
const evidenceService = require('./providerCanaryEvidenceService');
const artifactService = require('./providerCanaryArtifactService');
const { classifyProviderFailure, toSafeErrorSummary } = require('./providerErrorClassifier');

const SAFE_MEDIA_PROMPT = '生成一个蓝色圆形位于白色背景中央。';
const SAFE_TEXT_PROMPT = '只返回固定短词 CANARY_OK';
const SAFE_TEXT_SYSTEM_PROMPT = '严格按要求返回，不添加解释。';
const SAFE_TTS_TEXT = '这是一段系统连通性测试语音。';

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

function requireSingleOutput(capability) {
  if (capability?.count !== 1) {
    throw serviceError(
      'PROVIDER_CANARY_OUTPUT_COUNT_UNSUPPORTED',
      'provider canary supports exactly one output per run',
    );
  }
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
  requireSingleOutput(capability);
  const configId = positiveConfigId(config);
  const serviceType = String(config.service_type || '').trim().toLowerCase();
  if (!['image', 'storyboard_image', 'video', 'text', 'tts'].includes(serviceType)) {
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
  if (serviceType === 'tts') {
    return { config_id: configId, text: SAFE_TTS_TEXT };
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

function estimateCanaryCost(db, config, capability = {}) {
  requireSingleOutput(capability);
  const serviceType = String(config?.service_type || '').trim().toLowerCase();
  let quote;
  try {
    quote = routeCostService.quoteRouteCost(db, {
      configId: positiveConfigId(config),
      model: config.default_model || config.model,
      count: 1,
      duration: serviceType === 'video' ? capability.duration : undefined,
      resolution: capability.resolution,
      characters: serviceType === 'tts' ? Array.from(SAFE_TTS_TEXT).length : 0,
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

function runImmediate(db, work) {
  if (db.inTransaction) return work();
  return db.transaction(work).immediate();
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
  return {
    httpStatus: Number.isInteger(meta.httpStatus)
      ? meta.httpStatus
      : fallback.httpStatus,
    providerCode: meta.providerCode ?? fallback.providerCode,
    providerTaskId: meta.providerTaskId
      ?? errorOrResult?.provider_task_id
      ?? fallback.providerTaskId,
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
  return runImmediate(db, () => {
    budgetService.settleDefinitiveFailure(db, run.id, 0, classification.category, now);
    updateSafeSummary(db, run.id, classification.category, meta, now);
    evidenceService.recordFailure(db, evidenceInput(run, capability, now));
    return { state: 'failed', category: classification.category };
  });
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
  return runImmediate(db, () => {
    if (state === 'submission_unknown' || taskId) {
      budgetService.settleUnknown(db, run.id, state, category, taskId, now);
    } else {
      settleUnknownWithoutTask(db, run, state, category, now);
    }
    updateSafeSummary(db, run.id, category, meta, now);
    evidenceService.recordUnknown(db, evidenceInput(run, capability, now, state));
    return { state, category };
  });
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
  const config = loadConfig(db, run);
  const capability = evidenceService.normalizeCapability(run.service_type, options.capability);
  requireSingleOutput(capability);
  if (evidenceService.capabilityFingerprint(run.service_type, capability) !== run.capability_fingerprint) {
    throw serviceError('PROVIDER_CANARY_CAPABILITY_MISMATCH', 'provider canary capability does not match the run');
  }
  const now = isoNow(options.now);
  const request = buildCanaryRequest(db, config, capability, options.fixtures);
  const clients = {
    callImageApi: options.clients?.callImageApi || ((clientDb, clientLog, imageRequest) => (
      imageClient.callImageApiForConfigId(
        clientDb, clientLog, imageRequest.config_id, imageRequest,
      )
    )),
    callVideoApi: options.clients?.callVideoApi || ((clientDb, clientLog, videoRequest) => (
      videoClient.callVideoApiForConfigId(
        clientDb, clientLog, videoRequest.config_id, videoRequest,
      )
    )),
    pollVideoTask: options.clients?.pollVideoTask || videoClient.pollVideoTask,
    generateTextForConfigId: options.clients?.generateTextForConfigId || aiClient.generateTextForConfigId,
    synthesizeTts: options.clients?.synthesizeTts || ttsService.synthesize,
  };
  const artifacts = {
    materializeImage: options.artifacts?.materializeImage || artifactService.materializeImage,
    materializeVideo: options.artifacts?.materializeVideo || artifactService.materializeVideo,
    verifyText: options.artifacts?.verifyText || artifactService.verifyText,
    verifyAudio: options.artifacts?.verifyAudio || artifactService.verifyAudio,
  };
  let submitCount = 0;
  budgetService.claimForExecution(db, run.id, now);
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
    } else if (run.service_type === 'tts') {
      result = await clients.synthesizeTts(db, log, {
        text: request.text,
        storyboard_id: null,
        config,
        storage_base: options.storageRoot,
        storage_subdir: `_system/provider-canary/runs/${run.id}`,
      });
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
    const settled = settleUnknown(
      db, run, capability, category, category, meta.providerTaskId || null, meta, now,
    );
    return { ...settled, submitCount };
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

  if (run.service_type === 'tts') {
    providerTaskId = String(result?.provider_task_id || '').trim() || null;
    if (providerTaskId) budgetService.markAccepted(db, run.id, providerTaskId, now);
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
      const settled = settleUnknown(db, run, capability, state, state, null, meta, now);
      return { ...settled, submitCount };
    }
    if (meta.providerTaskId) {
      budgetService.markAccepted(db, run.id, String(meta.providerTaskId), now);
    }
    markVerifying(db, run.id, now);
    const state = 'result_unknown';
    const settled = settleUnknown(
      db, run, capability, state, state, meta.providerTaskId || null, meta, now,
    );
    return { ...settled, submitCount };
  }

  if (run.service_type !== 'text'
      && run.service_type !== 'tts'
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
    } else if (run.service_type === 'tts') {
      summary = artifacts.verifyAudio(result.local_path, {
        storageRoot: options.storageRoot,
        runId: run.id,
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
  return runImmediate(db, () => {
    budgetService.settleSuccess(db, run.id, actualCostMicros, artifact, now);
    evidenceService.recordSuccess(db, evidenceInput(run, capability, now));
    return { state: 'succeeded', submitCount, artifact };
  });
}

module.exports = {
  buildCanaryRequest,
  estimateCanaryCost,
  executeCanaryRun,
};
