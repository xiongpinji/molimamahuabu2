const NATIVE_AUDIO_DOWNLOAD_FAILURE_CODE = 'REDRAW_NATIVE_AUDIO_DOWNLOAD_FAILED';

/** 轮询/同步返回的 video_url 须为 http(s)，避免中转 FAILURE 时 result_url 为错误文案 */
function resolveRemoteVideoUrl(videoUrl, fallbackError) {
  if (videoUrl && videoClient.isPlausibleHttpVideoUrl(videoUrl)) {
    return { ok: true, video_url: String(videoUrl).trim() };
  }
  if (videoUrl) {
    return { ok: false, error: (fallbackError || String(videoUrl)).slice(0, 500) };
  }
  return { ok: false, error: (fallbackError || '超时或失败').slice(0, 500) };
}

/** 将 video_generations 标为失败；若无 error_msg 列则只更新 status/updated_at */
function setVideoGenFailed(db, videoGenId, errorMsg, now, failure = {}) {
  try {
    db.prepare('UPDATE video_generations SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?').run(
      'failed', (errorMsg || '').slice(0, 500), now, videoGenId
    );
  } catch (e) {
    if ((e.message || '').includes('error_msg')) {
      db.prepare('UPDATE video_generations SET status = ?, updated_at = ? WHERE id = ?').run('failed', now, videoGenId);
    } else throw e;
  }
  let row = null;
  try {
    row = db.prepare('SELECT id, credit_reservation_id FROM video_generations WHERE id = ?').get(Number(videoGenId));
  } catch (_) {}
  settleVideoCredit(db, null, row, 'failed', errorMsg, failure);
}

function setVideoGenNeedsAttention(db, videoGenId, taskId, errorMsg, now) {
  const message = String(errorMsg || '供应商任务状态未知，请勿重新提交').slice(0, 500);
  db.prepare('UPDATE video_generations SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?')
    .run('needs_attention', message, now, videoGenId);
  if (taskId) {
    taskService.updateTaskStatus(db, taskId, 'needs_attention', 90, message);
    try { db.prepare('UPDATE async_tasks SET error = ? WHERE id = ?').run(message, taskId); } catch (_) {}
  }
}

function list(db, query, options = {}) {
  let sql = 'FROM video_generations WHERE deleted_at IS NULL';
  const params = [];
  if (options.billingEnabled) {
    sql += options.tenantId ? ' AND tenant_id = ?' : ' AND user_id = ?';
    params.push(options.tenantId || options.userId || '');
  }
  if (query.drama_id) {
    sql += ' AND drama_id = ?';
    params.push(query.drama_id);
  }
  if (query.storyboard_id) {
    sql += ' AND storyboard_id = ?';
    params.push(query.storyboard_id);
  }
  // 与 Go 前端行为对齐：请求 status=processing 时，同时包含“刚结束”的记录（5 分钟内变为 completed/failed），
  // 这样轮询刷新后任务不会从列表消失，无需改 Vue
  if (query.status === 'processing') {
    sql += " AND (status = 'processing' OR (status IN ('completed','failed') AND updated_at >= datetime('now', '-5 minutes')))";
  } else if (query.status) {
    sql += ' AND status = ?';
    params.push(query.status);
  }
  const countRow = db.prepare('SELECT COUNT(*) as total ' + sql).get(...params);
  const total = countRow.total || 0;
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.page_size, 10) || 20));
  const offset = (page - 1) * pageSize;
  const rows = db.prepare('SELECT * ' + sql + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params, pageSize, offset);
  return { items: rows.map(rowToItem), total, page, pageSize };
}

function parseReferenceImageUrls(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function rowToItem(r) {
  return {
    id: r.id,
    storyboard_id: r.storyboard_id,
    drama_id: r.drama_id,
    provider: r.provider,
    prompt: r.prompt,
    model: r.model,
    image_gen_id: r.image_gen_id,
    image_url: r.image_url,
    first_frame_url: r.first_frame_url,
    last_frame_url: r.last_frame_url,
    output_first_frame_url: r.output_first_frame_url,
    output_last_frame_url: r.output_last_frame_url,
    reference_image_urls: parseReferenceImageUrls(r.reference_image_urls),
    reference_video_url: r.reference_video_url,
    reference_audio_url: r.reference_audio_url,
    reference_video_urls: parseReferenceUrls(r.reference_video_urls),
    reference_audio_urls: parseReferenceUrls(r.reference_audio_urls),
    reference_mode: r.reference_mode,
    generate_audio: r.generate_audio === 1 || r.generate_audio === true,
    request_snapshot: parseJsonValue(r.request_snapshot, null),
    video_url: r.video_url,
    local_path: r.local_path,
    status: r.status,
    task_id: r.task_id,
    provider_task_id: r.provider_task_id,
    duration: r.duration,
    aspect_ratio: r.aspect_ratio,
    resolution: r.resolution,
    error_msg: r.error_msg,
    created_at: r.created_at,
    updated_at: r.updated_at,
    completed_at: r.completed_at,
  };
}

function getById(db, id, options = {}) {
  const ownerClause = options.billingEnabled
    ? options.tenantId ? ' AND tenant_id = ?' : ' AND user_id = ?'
    : '';
  const params = options.billingEnabled
    ? [Number(id), options.tenantId || options.userId || '']
    : [Number(id)];
  const r = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL' + ownerClause).get(...params);
  return r ? rowToItem(r) : null;
}

function localVideoDeliveryWarning(localPath) {
  return localPath ? '' : '视频已生成并可在线播放，但保存到本地失败；请稍后处理本地保存，不要重新生成视频';
}

function findActiveForStoryboard(db, storyboardId, options = {}) {
  if (!storyboardId) return null;
  const ownerClause = options.billingEnabled
    ? options.tenantId ? ' AND tenant_id = ?' : ' AND user_id = ?'
    : '';
  const params = options.billingEnabled
    ? [Number(storyboardId), options.tenantId || options.userId || '']
    : [Number(storyboardId)];
  return db.prepare(
    `SELECT * FROM video_generations
     WHERE storyboard_id = ? AND status IN ('pending', 'processing', 'needs_attention') AND deleted_at IS NULL${ownerClause}
     ORDER BY created_at DESC, id DESC LIMIT 1`
  ).get(...params) || null;
}

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawnSync } = require('child_process');
const { createHash, randomUUID } = require('crypto');
const videoClient = require('./videoClient');
const redrawSourceConditioningService = require('./redrawSourceConditioningService');
const usmercariVideoClient = require('./usmercariVideoClient');
const aiConfigService = require('./aiConfigService');
const toapisVideoClient = require('./toapisVideoClient');
const { TOAPIS_VIDEO_MODELS } = toapisVideoClient;
const toapisWan3VideoClient = require('./toapisWan3VideoClient');
const { TOAPIS_WAN3_MODEL, TOAPIS_WAN3_SPEC } = toapisWan3VideoClient;
const lingjingVideoClient = require('./lingjingVideoClient');
const { LINGJING_VIDEO_SPEC } = lingjingVideoClient;
const feituoVideoClient = require('./feituoVideoClient');
const { FEITUO_MODELS } = feituoVideoClient;
const taskService = require('./taskService');
const storageLayout = require('./storageLayout');
const creditLedger = require('./creditLedgerService');
const generationCost = require('./generationCostLedgerService');
const modelPrice = require('./modelPriceService');
const auditEvent = require('./auditEventService');
const voicePrompt = require('./storyboardVoicePromptService');
const videoReferenceCapability = require('./videoReferenceCapabilityService');
const providerRouteStability = require('./providerRouteStabilityService');
const { classifyProviderFailure } = require('./providerErrorClassifier');
const { hasTrustedEvidenceBinding } = require('./externalModelEvidenceService');
const providerAssetUrl = require('./providerAssetUrlService');
const { getFfmpegPath, hasLocalFfmpeg } = require('../utils/ffmpegPath');

function parseReferenceUrls(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function parseJsonValue(value, fallback = null) {
  if (!value) return fallback;
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (_) {
    return fallback;
  }
}

function loadStoryboardVideoDefaults(db, storyboardId) {
  const sid = Number(storyboardId);
  if (!db || !Number.isInteger(sid) || sid <= 0) return null;
  try {
    return db.prepare(
      `SELECT s.video_prompt, s.video_model, s.duration, e.drama_id
       FROM storyboards s
       LEFT JOIN episodes e ON e.id = s.episode_id AND e.deleted_at IS NULL
       WHERE s.id = ? AND s.deleted_at IS NULL`
    ).get(sid) || null;
  } catch (_) {
    return null;
  }
}

function settleVideoCredit(db, log, row, outcome, message = '', failure = {}) {
  if (!row?.credit_reservation_id) return null;
  try {
    const actual = db.prepare('SELECT * FROM video_generations WHERE credit_reservation_id = ?')
      .get(row.credit_reservation_id) || row;
    const settled = creditLedger.settleGeneration(
      db,
      row.credit_reservation_id,
      outcome,
      message,
      failure,
    );
    try {
      if (outcome === 'completed') {
        generationCost.record(db, {
          reservationId: row.credit_reservation_id,
          model: actual.model || settled?.model,
          configId: actual.config_id,
          count: 1,
          duration: actual.duration,
          resolution: actual.resolution,
          usageSource: 'provider',
        });
      } else if (settled?.status === 'held') {
        generationCost.record(db, {
          reservationId: row.credit_reservation_id,
          model: actual.model || settled?.model,
          usageSource: 'unknown',
        });
      }
    } catch (costError) {
      log?.error?.('视频生成成本记录失败，保留未计成本标记', {
        id: actual.id,
        error: costError.message,
      });
    }
    auditEvent.record(db, {
      userId: settled?.user_id,
      tenantId: settled?.tenant_id,
      eventType: outcome === 'completed' ? 'generation.video.completed' : 'generation.video.failed',
      resourceType: 'video',
      resourceId: row.id,
      outcome: outcome === 'completed' ? 'success' : 'failed',
      code: outcome === 'failed' ? 'VIDEO_GENERATION_FAILED' : null,
    });
    return settled;
  } catch (error) {
    log?.error('视频积分结算失败，保留原预扣状态', { id: row.id, error: error.message });
    return null;
  }
}

function markVideoCostUnknown(db, log, row) {
  if (!row?.credit_reservation_id) return;
  try {
    generationCost.record(db, {
      reservationId: row.credit_reservation_id,
      model: row.model,
      usageSource: 'unknown',
    });
  } catch (error) {
    log?.error?.('视频生成结果未知成本标记失败，保留未计成本状态', {
      id: row.id,
      error: error.message,
    });
  }
}

function getVideoRouteAttempt(db, videoGenId) {
  try {
    return db.prepare(`SELECT r.id AS request_id, r.logical_model_id, r.tenant_id,
        r.state AS route_state, a.attempt_no, a.config_id, a.state AS attempt_state,
        a.query_protocol
      FROM generation_route_requests r
      JOIN generation_route_attempts a ON a.request_id = r.id
      WHERE r.business_type = 'video_generation' AND r.business_id = ?
      ORDER BY a.attempt_no DESC LIMIT 1`).get(String(videoGenId)) || null;
  } catch (_) {
    return null;
  }
}

function wan3RouteCapabilities(request = {}) {
  return {
    resolution: request.resolution,
    aspectRatio: request.aspect_ratio,
    duration: request.duration,
    referenceImageCount: Array.isArray(request.reference_urls)
      ? request.reference_urls.filter(Boolean).length
      : 0,
    referenceVideoCount: Array.isArray(request.reference_video_urls)
      ? request.reference_video_urls.filter(Boolean).length
      : 0,
    referenceAudioCount: Array.isArray(request.reference_audio_urls)
      ? request.reference_audio_urls.filter(Boolean).length
      : 0,
    requiresAudio: request.generate_audio === true,
  };
}

function prepareWan3SubmissionRoute(db, row, config, request, now) {
  const owner = String(row.tenant_id || row.user_id || 'local');
  const businessId = String(row.id);
  const reservation = row.credit_reservation_id
    ? creditLedger.getReservation(db, row.credit_reservation_id)
    : null;
  return db.transaction(() => {
    const route = providerRouteStability.createOrGetRouteRequest(db, {
      id: randomUUID(),
      idempotencyKey: `${owner}:video:${businessId}`,
      serviceType: 'video',
      businessType: 'video_generation',
      businessId,
      tenantId: row.tenant_id || null,
      userId: row.user_id || null,
      logicalModelId: config.logical_model_id || row.model || request.model,
      capabilities: wan3RouteCapabilities(request),
      userPriceSnapshot: reservation
        ? { model: reservation.model, credits: reservation.amount }
        : null,
      candidateConfigIds: [config.id],
      creditReservationId: row.credit_reservation_id || null,
      now,
    });
    const existing = db.prepare(`SELECT * FROM generation_route_attempts
      WHERE request_id = ? ORDER BY attempt_no DESC LIMIT 1`).get(route.id) || null;
    if (existing) {
      const error = new Error('Wan3 提交已被领取，禁止重复提交');
      error.code = 'WAN3_SUBMISSION_ALREADY_CLAIMED';
      error.routeState = route.state;
      error.attemptState = existing.state;
      throw error;
    }
    if (route.state !== 'created') throw new Error('Wan3 路由状态无法开始供应商提交');
    const attempt = providerRouteStability.startAttempt(db, {
      requestId: route.id,
      configId: config.id,
      upstreamModel: request.model || row.model || config.default_model,
      queryProtocol: 'toapis_wan3_video',
      now,
    });
    if (!attempt) {
      const error = new Error('Wan3 当前线路不可提交');
      error.code = 'WAN3_ROUTE_UNAVAILABLE';
      throw error;
    }
    return { route, attempt };
  })();
}

function persistWan3AcceptedTaskReceipt(db, row, config, request, providerTaskId, now) {
  const taskId = String(providerTaskId || '').trim();
  if (!taskId) throw new Error('Wan3 已受理任务缺少供应商任务号');
  const owner = String(row.tenant_id || row.user_id || 'local');
  const businessId = String(row.id);
  const reservation = row.credit_reservation_id
    ? creditLedger.getReservation(db, row.credit_reservation_id)
    : null;
  return db.transaction(() => {
    const route = providerRouteStability.createOrGetRouteRequest(db, {
      id: randomUUID(),
      idempotencyKey: `${owner}:video:${businessId}`,
      serviceType: 'video',
      businessType: 'video_generation',
      businessId,
      tenantId: row.tenant_id || null,
      userId: row.user_id || null,
      logicalModelId: config.logical_model_id || row.model || request.model,
      capabilities: wan3RouteCapabilities(request),
      userPriceSnapshot: reservation
        ? { model: reservation.model, credits: reservation.amount }
        : null,
      candidateConfigIds: [config.id],
      creditReservationId: row.credit_reservation_id || null,
      now,
    });
    let attempt = db.prepare(`SELECT * FROM generation_route_attempts
      WHERE request_id = ? ORDER BY attempt_no DESC LIMIT 1`).get(route.id) || null;
    if (attempt) {
      if (Number(attempt.config_id) !== Number(config.id)) {
        const error = new Error('Wan3 供应商任务凭证与既有路由冲突');
        error.code = 'PROVIDER_TASK_RECEIPT_CONFLICT';
        throw error;
      }
      if (attempt.provider_task_id == null) {
        attempt = providerRouteStability.recordAcceptedTask(db, {
          requestId: route.id,
          attemptNo: attempt.attempt_no,
          providerTaskId: taskId,
          now,
        });
      } else if (String(attempt.provider_task_id) !== taskId) {
        const error = new Error('Wan3 供应商任务凭证与既有路由冲突');
        error.code = 'PROVIDER_TASK_RECEIPT_CONFLICT';
        throw error;
      }
    } else {
      if (route.state !== 'created') throw new Error('Wan3 路由状态无法固化供应商任务凭证');
      const receipt = providerRouteStability.buildAttemptReceipt(db, {
        requestId: route.id,
        configId: config.id,
        upstreamModel: request.model || row.model || config.default_model,
        queryProtocol: 'toapis_wan3_video',
      });
      const attemptNo = Number(db.prepare(`SELECT COALESCE(MAX(attempt_no), 0) + 1 AS attempt_no
        FROM generation_route_attempts WHERE request_id = ?`).get(route.id).attempt_no);
      const inserted = db.prepare(`INSERT INTO generation_route_attempts
        (request_id, attempt_no, config_id, provider, upstream_model, config_fingerprint,
         query_protocol, state, provider_task_id, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'submitting', NULL, ?)`)
        .run(
          route.id,
          attemptNo,
          config.id,
          receipt.provider,
          receipt.upstreamModel,
          receipt.configFingerprint,
          receipt.queryProtocol,
          now,
        );
      db.prepare("UPDATE generation_route_requests SET state = 'running', updated_at = ? WHERE id = ?")
        .run(now, route.id);
      attempt = db.prepare('SELECT * FROM generation_route_attempts WHERE id = ?').get(inserted.lastInsertRowid);
      attempt = providerRouteStability.recordAcceptedTask(db, {
        requestId: route.id,
        attemptNo: attempt.attempt_no,
        providerTaskId: taskId,
        now,
      });
    }
    const videoChanged = db.prepare(`UPDATE video_generations
      SET status = 'processing', provider_task_id = ?, config_id = ?, ai_service_config_id = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL`).run(taskId, config.id, config.id, now, row.id);
    if (videoChanged.changes !== 1) throw new Error('Wan3 视频任务凭证持久化失败');
    if (row.task_id) {
      const taskChanged = db.prepare(`UPDATE async_tasks
        SET provider_task_id = ?, credit_reservation_id = ?, tenant_id = ?, user_id = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL`).run(
        taskId,
        row.credit_reservation_id || null,
        row.tenant_id || null,
        row.user_id || null,
        now,
        row.task_id,
      );
      if (taskChanged.changes !== 1) throw new Error('Wan3 异步任务凭证持久化失败');
    }
    return { route, attempt };
  })();
}

function markVideoRouteNeedsAttention(db, videoGenId, category, now) {
  const route = getVideoRouteAttempt(db, videoGenId);
  if (!route) return false;
  providerRouteStability.finishAttempt(db, {
    requestId: route.request_id,
    attemptNo: route.attempt_no,
    state: 'needs_attention',
    errorCategory: category || 'result_unknown',
    now,
  });
  const changed = db.prepare(`UPDATE generation_route_requests
    SET state = 'needs_attention', final_config_id = ?, updated_at = ?
    WHERE id = ? AND state IN ('running', 'accepted', 'needs_attention')`)
    .run(route.config_id, now, route.request_id);
  return changed.changes === 1;
}

function markVideoRouteFailed(db, videoGenId, category, now) {
  const route = getVideoRouteAttempt(db, videoGenId);
  if (!route) return false;
  providerRouteStability.finishAttempt(db, {
    requestId: route.request_id,
    attemptNo: route.attempt_no,
    state: 'failed',
    errorCategory: category || 'provider_task_failed',
    now,
  });
  const changed = db.prepare(`UPDATE generation_route_requests
    SET state = 'failed', final_config_id = ?, updated_at = ?
    WHERE id = ? AND state IN ('running', 'accepted', 'needs_attention')`)
    .run(route.config_id, now, route.request_id);
  if (changed.changes !== 1) throw new Error('Wan3 路由终态结算失败');
  return true;
}

function markVideoArtifactUnreadable(db, videoGenId) {
  const route = getVideoRouteAttempt(db, videoGenId);
  if (!route) return false;
  const classification = classifyProviderFailure({ httpStatus: 200, artifactReadable: false });
  providerRouteStability.finishAttempt(db, {
    requestId: route.request_id,
    attemptNo: route.attempt_no,
    state: classification.category,
    httpStatus: 200,
    errorCategory: classification.category,
  });
  providerRouteStability.recordFailureAndHealth(db, {
    requestId: route.request_id,
    tenantId: route.tenant_id,
    configId: route.config_id,
    logicalModelId: route.logical_model_id,
    classification,
  });
  db.prepare("UPDATE generation_route_requests SET state = 'needs_attention', updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), route.request_id);
  return true;
}

function markVideoArtifactVerified(db, videoGenId) {
  const route = getVideoRouteAttempt(db, videoGenId);
  if (!route) return false;
  providerRouteStability.recordArtifactVerified(db, {
    requestId: route.request_id,
    attemptNo: route.attempt_no,
    configId: route.config_id,
  });
  return true;
}

function minimumVideoDuration(model) {
  return /^bytedance\/seedance-2-0-(?:mini|fast)$/.test(String(model || '').trim().toLowerCase()) ? 4 : 5;
}

function normalizeVideoDuration(value, fallback = 5, allowedDurationsOrMinimum = null) {
  const duration = value == null || value === '' ? Number(fallback) : Number(value);
  const allowed = Array.isArray(allowedDurationsOrMinimum) && allowedDurationsOrMinimum.length
    ? [...new Set(allowedDurationsOrMinimum.map(Number).filter(Number.isSafeInteger))]
    : null;
  const minimum = Number.isSafeInteger(allowedDurationsOrMinimum) ? allowedDurationsOrMinimum : 5;
  if (!Number.isSafeInteger(duration) || (allowed ? !allowed.includes(duration) : duration < minimum || duration > 15)) {
    const error = new Error(allowed
      ? `视频时长必须是 ${allowed.join('、')} 秒之一`
      : `视频时长必须是 ${minimum} 到 15 秒之间的整数`);
    error.code = 'INVALID_VIDEO_DURATION';
    throw error;
  }
  return duration;
}

function configuredVideoDuration(config, allowedDurationsOrMinimum = null) {
  if (!config?.settings) return null;
  try {
    const settings = typeof config.settings === 'string' ? JSON.parse(config.settings) : config.settings;
    const duration = Number(settings?.video_duration);
    if (!Number.isSafeInteger(duration)) return null;
    if (Array.isArray(allowedDurationsOrMinimum) && allowedDurationsOrMinimum.length) {
      return allowedDurationsOrMinimum.includes(duration) ? duration : null;
    }
    const minimum = Number.isSafeInteger(allowedDurationsOrMinimum) ? allowedDurationsOrMinimum : 5;
    return duration >= minimum && duration <= 15 ? duration : null;
  } catch (_) {
    return null;
  }
}

function videoRequestError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function configModels(config) {
  const values = Array.isArray(config?.model) ? config.model : [config?.model];
  return [...new Set([
    ...values,
    config?.default_model,
  ].map((value) => String(value || '').trim()).filter(Boolean))];
}

function isToapisVideoConfig(config) {
  return [config?.provider, config?.api_protocol]
    .map((value) => String(value || '').trim().toLowerCase())
    .some((value) => value === 'toapis' || value === 'toapis_video');
}

function isToapisWan3VideoConfig(config) {
  const provider = String(config?.provider || '').trim().toLowerCase();
  const protocol = String(config?.api_protocol || '').trim().toLowerCase();
  return provider === 'toapis_wan3_video' || protocol === 'toapis_wan3_video';
}

function isFeituoVideoConfig(config) {
  return [config?.provider, config?.api_protocol]
    .map((value) => String(value || '').trim().toLowerCase())
    .some((value) => value === 'feituo' || value === 'feituo_open');
}

function isLingjingVideoConfig(config) {
  return [config?.provider, config?.api_protocol]
    .map((value) => String(value || '').trim().toLowerCase())
    .some((value) => value === 'lingjing' || value === 'lingjing_open');
}

function matchingToapisConfigs(db, model) {
  const target = String(model || '').trim().toLowerCase();
  if (!TOAPIS_VIDEO_MODELS[target]) return [];
  return aiConfigService.listConfigs(db, 'video').filter((config) => (
    isToapisVideoConfig(config)
    && configModels(config).some((value) => value.toLowerCase() === target)
  ));
}

function matchingToapisWan3Configs(db, model) {
  const target = String(model || '').trim().toLowerCase();
  if (target !== TOAPIS_WAN3_MODEL) return [];
  return aiConfigService.listConfigs(db, 'video').filter((config) => (
    isToapisWan3VideoConfig(config)
    && configModels(config).some((value) => value.toLowerCase() === target)
  ));
}

function matchingLingjingConfigs(db, model) {
  const target = String(model || '').trim().toLowerCase();
  if (target !== lingjingVideoClient.PUBLIC_MODEL) return [];
  return aiConfigService.listConfigs(db, 'video').filter((config) => (
    isLingjingVideoConfig(config)
    && configModels(config).some((value) => value.toLowerCase() === target)
  ));
}

function verifiedCapabilitiesForModel(config, model) {
  const target = String(model || '').trim().toLowerCase();
  const capabilities = config?.verified_capabilities;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return null;
  const key = Object.keys(capabilities).find((value) => value.toLowerCase() === target);
  const result = key ? capabilities[key] : null;
  return result && typeof result === 'object' && !Array.isArray(result) ? result : null;
}

function hasVerifiedFeituoGeneration(config, model) {
  let settings = config?.settings;
  try {
    if (typeof settings === 'string') settings = JSON.parse(settings || '{}');
  } catch (_) {
    return false;
  }
  const target = String(model || '').trim().toLowerCase();
  return Array.isArray(settings?.real_generation_verified_models)
    && settings.real_generation_verified_models
      .some((value) => String(value || '').trim().toLowerCase() === target);
}

function matchingFeituoConfigs(db, model) {
  const target = String(model || '').trim().toLowerCase();
  if (!FEITUO_MODELS[target] || !target.startsWith('xuan-')) return [];
  return aiConfigService.listConfigs(db, 'video').filter((config) => (
    isFeituoVideoConfig(config)
    && configModels(config).some((value) => value.toLowerCase() === target)
  ));
}

function feituoReadyState(db, model) {
  const target = String(model || '').trim().toLowerCase();
  const official = FEITUO_MODELS[target];
  if (!official || !target.startsWith('xuan-')) return null;
  const candidates = matchingFeituoConfigs(db, target);
  for (const config of candidates) {
    const capabilities = verifiedCapabilitiesForModel(config, target);
    const verifiedDurations = new Set(Array.isArray(capabilities?.durations)
      ? capabilities.durations.map(Number).filter(Number.isSafeInteger)
      : []);
    const verifiedResolutions = new Set(Array.isArray(capabilities?.resolutions)
      ? capabilities.resolutions.map((value) => String(value || '').trim().toLowerCase())
      : []);
    const durations = official.durations.filter((duration) => verifiedDurations.has(duration));
    const resolutions = official.resolutions.filter((resolution) => verifiedResolutions.has(resolution));
    if (config.is_active
        && config.verification_status === 'verified'
        && aiConfigService.hasConnectionCredential(config)
        && hasVerifiedFeituoGeneration(config, target)
        && durations.length
        && resolutions.length) {
      return { config, capabilities, official, durations, resolutions, model: target };
    }
  }
  throw videoRequestError('MODEL_NOT_VERIFIED', `${target} 尚未完成真实生成验证或凭据不可用`);
}

function toapisReadyState(db, model, evidenceRoots) {
  const target = String(model || '').trim().toLowerCase();
  const official = TOAPIS_VIDEO_MODELS[target];
  if (!official) return null;
  const candidates = matchingToapisConfigs(db, target);
  for (const config of candidates) {
    const capabilities = verifiedCapabilitiesForModel(config, target);
    const verifiedDurations = new Set(Array.isArray(capabilities?.durations)
      ? capabilities.durations.map(Number).filter(Number.isSafeInteger)
      : []);
    const verifiedResolutions = new Set(Array.isArray(capabilities?.resolutions)
      ? capabilities.resolutions.map((value) => String(value || '').trim().toLowerCase())
      : []);
    const durations = official.durations.filter((duration) => verifiedDurations.has(duration));
    const resolutions = official.resolutions.filter((resolution) => verifiedResolutions.has(resolution));
    if (config.is_active
        && config.verification_status === 'verified'
        && aiConfigService.hasConnectionCredential(config)
        && hasTrustedEvidenceBinding(target, capabilities, evidenceRoots)
        && durations.length
        && resolutions.length) {
      return { config, capabilities, official, durations, resolutions, model: target };
    }
  }
  throw videoRequestError('MODEL_NOT_VERIFIED', `${target} 尚未完成真实生成验证或凭据不可用`);
}

function toapisWan3ReadyState(db, model, evidenceRoots, preferredConfigId = null) {
  const target = String(model || '').trim().toLowerCase();
  if (target !== TOAPIS_WAN3_MODEL) return null;
  const preferredId = Number(preferredConfigId);
  const candidates = matchingToapisWan3Configs(db, target)
    .filter((config) => !Number.isSafeInteger(preferredId) || preferredId <= 0 || Number(config.id) === preferredId);
  for (const config of candidates) {
    const capabilities = verifiedCapabilitiesForModel(config, target);
    const verifiedDurations = new Set(Array.isArray(capabilities?.durations)
      ? capabilities.durations.map(Number).filter(Number.isSafeInteger)
      : []);
    const verifiedResolutions = new Set(Array.isArray(capabilities?.resolutions)
      ? capabilities.resolutions.map((value) => String(value || '').trim().toLowerCase())
      : []);
    const ratioValues = Array.isArray(capabilities?.ratios)
      ? capabilities.ratios
      : capabilities?.aspectRatios;
    const verifiedRatios = new Set(Array.isArray(ratioValues)
      ? ratioValues.map((value) => String(value || '').trim())
      : []);
    const audioValues = [...new Set(Array.isArray(capabilities?.audio_values)
      ? capabilities.audio_values.filter((value) => typeof value === 'boolean')
      : [])];
    const durations = TOAPIS_WAN3_SPEC.durations.filter((duration) => verifiedDurations.has(duration));
    const resolutions = TOAPIS_WAN3_SPEC.resolutions.filter((resolution) => verifiedResolutions.has(resolution));
    const aspectRatios = TOAPIS_WAN3_SPEC.aspectRatios.filter((ratio) => verifiedRatios.has(ratio));
    if (config.is_active
        && config.verification_status === 'verified'
        && aiConfigService.hasConnectionCredential(config)
        && hasTrustedEvidenceBinding(target, capabilities, evidenceRoots, config)
        && durations.length
        && resolutions.length
        && aspectRatios.length
        && audioValues.length) {
      return {
        config,
        capabilities,
        official: TOAPIS_WAN3_SPEC,
        durations,
        resolutions,
        aspectRatios,
        audioValues,
        model: target,
      };
    }
  }
  throw videoRequestError('MODEL_NOT_VERIFIED', `${target} 尚未完成真实生成验证或凭据不可用`);
}

function lingjingReadyState(db, model, evidenceRoots) {
  const target = String(model || '').trim().toLowerCase();
  if (target !== lingjingVideoClient.PUBLIC_MODEL) return null;
  const candidates = matchingLingjingConfigs(db, target);
  for (const config of candidates) {
    const capabilities = verifiedCapabilitiesForModel(config, target);
    const verifiedDurations = new Set(Array.isArray(capabilities?.durations)
      ? capabilities.durations.map(Number).filter(Number.isSafeInteger)
      : []);
    const verifiedRatios = new Set(Array.isArray(capabilities?.aspectRatios)
      ? capabilities.aspectRatios.map((value) => String(value || '').trim())
      : []);
    const durations = LINGJING_VIDEO_SPEC.durations.filter((duration) => verifiedDurations.has(duration));
    const aspectRatios = LINGJING_VIDEO_SPEC.aspectRatios.filter((ratio) => verifiedRatios.has(ratio));
    const resolutions = Array.isArray(capabilities?.resolutions)
      ? capabilities.resolutions.map((value) => String(value || '').trim()).filter(Boolean)
      : null;
    const maxReferences = Number(capabilities?.maxReferences);
    if (config.is_active
        && config.verification_status === 'verified'
        && String(config.updated_at || '').trim()
        && aiConfigService.hasConnectionCredential(config)
        && hasTrustedEvidenceBinding(target, capabilities, evidenceRoots)
        && durations.length === LINGJING_VIDEO_SPEC.durations.length
        && aspectRatios.length === LINGJING_VIDEO_SPEC.aspectRatios.length
        && Array.isArray(resolutions) && resolutions.length === 0
        && capabilities.supportsImageReference === true
        && capabilities.supportsFirstFrame === false
        && capabilities.supportsLastFrame === false
        && capabilities.supportsVideoReference === false
        && capabilities.supportsAudioReference === false
        && capabilities.supportsAudio === false
        && Number.isSafeInteger(maxReferences) && maxReferences >= 0
        && maxReferences <= lingjingVideoClient.MAX_IMAGE_REFERENCES) {
      return {
        config,
        capabilities,
        official: LINGJING_VIDEO_SPEC,
        durations,
        resolutions: [],
        aspectRatios,
        model: target,
      };
    }
  }
  throw videoRequestError('MODEL_NOT_VERIFIED', `${target} 尚未完成真实生成验证或凭据不可用`);
}

function processingVideoConfig(db, model, preferredConfigId, evidenceRoots) {
  const target = String(model || '').trim().toLowerCase();
  if (target === TOAPIS_WAN3_MODEL) {
    const candidates = matchingToapisWan3Configs(db, target);
    if (preferredConfigId != null && String(preferredConfigId).trim() !== '') {
      const preferredId = Number(preferredConfigId);
      if (!Number.isSafeInteger(preferredId) || preferredId <= 0) return null;
      return candidates.find((config) => (
        Number(config.id) === preferredId
        && config.is_active
        && aiConfigService.hasConnectionCredential(config)
      )) || null;
    }
    return candidates.find((config) => (
      config.is_active && aiConfigService.hasConnectionCredential(config)
    )) || null;
  }
  if (preferredConfigId != null && String(preferredConfigId).trim() !== '') {
    return videoClient.getDefaultVideoConfig(db, model, evidenceRoots, preferredConfigId);
  }
  if (target === lingjingVideoClient.PUBLIC_MODEL) {
    return matchingLingjingConfigs(db, target)
      .find((config) => config.is_active && aiConfigService.hasConnectionCredential(config)) || null;
  }
  if (FEITUO_MODELS[target] && target.startsWith('xuan-')) {
    return matchingFeituoConfigs(db, target)
      .find((config) => config.is_active && aiConfigService.hasConnectionCredential(config)) || null;
  }
  if (!TOAPIS_VIDEO_MODELS[target]) return videoClient.getDefaultVideoConfig(db, model);
  return matchingToapisConfigs(db, target)
    .find((config) => config.is_active && aiConfigService.hasConnectionCredential(config)) || null;
}

function pinnedVideoCapability(row) {
  if (!row?.source_conditioning_json) return null;
  let parsed;
  try { parsed = JSON.parse(row.source_conditioning_json); } catch (_) {
    const error = new Error('固定模型配置与任务创建时不一致：source_conditioning_json 无效');
    error.code = 'VIDEO_PINNED_CONFIG_MISMATCH';
    throw error;
  }
  return parsed?.video_capability || null;
}

function assertPinnedVideoConfig(row, config) {
  if (!row?.ai_service_config_id) return null;
  const fail = (detail) => {
    const error = new Error(`固定模型配置与任务创建时不一致：${detail}`);
    error.code = 'VIDEO_PINNED_CONFIG_MISMATCH';
    throw error;
  };
  if (Number(config?.id) !== Number(row.ai_service_config_id)) fail('config_id 已变化');
  const expectedProvider = String(row.provider || '').trim().toLowerCase();
  const actualProvider = String(config?.provider || '').trim().toLowerCase();
  if (expectedProvider && expectedProvider !== actualProvider) fail('provider 已变化');
  const snapshot = pinnedVideoCapability(row);
  if (!snapshot) return null;
  if (Number(snapshot.config_id) !== Number(row.ai_service_config_id)) fail('能力 config_id 已变化');
  if (!snapshot.config_updated_at || String(snapshot.config_updated_at) !== String(config.updated_at || '')) {
    fail('配置版本已变化');
  }
  if (String(snapshot.provider || '').trim().toLowerCase() !== actualProvider) fail('能力 provider 已变化');
  const expectedProtocol = String(snapshot.protocol || '').trim().toLowerCase();
  const actualProtocol = String(videoClient.resolveVideoProtocol(config, row.model) || '').trim().toLowerCase();
  if (!expectedProtocol || expectedProtocol !== actualProtocol) fail('api_protocol 已变化');
  if (String(snapshot.model || '').trim() !== String(row.model || '').trim()) fail('model 已变化');
  return snapshot;
}

function requireVerifiedToapisReferenceCapabilities(state, refs) {
  if (!state) return;
  const required = [
    [refs.firstFrameUrl, 'supportsFirstFrame', '首帧参考'],
    [refs.lastFrameUrl, 'supportsLastFrame', '尾帧参考'],
    [refs.referenceImageUrls.length, 'supportsImageReference', '参考图'],
    [refs.referenceVideoUrls.length, 'supportsVideoReference', '参考视频'],
    [refs.referenceAudioUrls.length, 'supportsAudioReference', '参考音频'],
    [refs.generateAudio, 'supportsAudio', '同步音频'],
  ];
  const missing = required.find(([used, capability]) => used && state.capabilities?.[capability] !== true);
  if (missing) {
    throw videoRequestError('MODEL_NOT_VERIFIED', `${state.model} 尚未验证${missing[2]}能力`);
  }
}

function requireVerifiedFeituoReferenceCapabilities(state, refs) {
  if (!state) return;
  const required = [
    [refs.firstFrameUrl, 'supportsFirstFrame', '首帧参考'],
    [refs.lastFrameUrl, 'supportsLastFrame', '尾帧参考'],
    [refs.referenceImageUrls.length, 'supportsImageReference', '参考图'],
    [refs.referenceVideoUrls.length, 'supportsVideoReference', '参考视频'],
    [refs.referenceAudioUrls.length, 'supportsAudioReference', '参考音频'],
    [refs.generateAudio, 'supportsAudio', '同步音频'],
  ];
  const missing = required.find(([used, capability]) => used && state.capabilities?.[capability] !== true);
  if (missing) throw videoRequestError('MODEL_NOT_VERIFIED', `${state.model} 尚未验证${missing[2]}能力`);
}

function verifiedReferenceLimit(value) {
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit >= 0 ? limit : 0;
}

function reuseActiveGeneration(db, active, duration, billingEnabled, options, expected = {}) {
  const activeModel = String(active.model || '').trim().toLowerCase();
  const expectedModel = String(expected.model || '').trim().toLowerCase();
  const activeResolution = String(active.resolution || '').trim().toLowerCase();
  const expectedResolution = String(expected.resolution || '').trim().toLowerCase();
  if (Number(active.duration) !== duration
      || (expectedModel && activeModel !== expectedModel)
      || (expectedResolution && activeResolution !== expectedResolution)) {
    const error = new Error('该分镜已有不同模型、分辨率或时长的视频正在生成，请完成后再修改参数');
    error.code = 'VIDEO_GENERATION_ACTIVE';
    throw error;
  }
  if (billingEnabled) {
    auditEvent.record(db, {
      userId: options.userId,
      tenantId: options.tenantId,
      eventType: 'generation.video.reused',
      resourceType: 'video',
      resourceId: active.id,
      outcome: 'success',
      code: 'REUSED',
    });
  }
  return { ...getById(db, active.id), reused: true };
}

function requireToapisResolutionPrice(db, model, resolution) {
  const target = String(model || '').trim().toLowerCase();
  const price = modelPrice.list(db).find((row) => String(row.model || '').trim().toLowerCase() === target);
  if (price && (price.category !== 'video' || !price.resolution_prices?.[resolution])) {
    throw videoRequestError('MODEL_RESOLUTION_PRICE_REQUIRED', '当前分辨率积分待管理员配置');
  }
}

function cleanUrlList(...values) {
  const result = [];
  for (const value of values) {
    const list = Array.isArray(value) ? value : [value];
    for (const item of list) {
      const text = String(item || '').trim();
      if (text) result.push(text);
    }
  }
  return [...new Set(result)];
}

function normalizeHostname(hostname) {
  return String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function parseIpv4Address(hostname) {
  const parts = String(hostname || '').split('.');
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function isPrivateIpv4(octets) {
  if (!octets) return false;
  const [a, b] = octets;
  return a === 10
    || a === 127
    || a === 0
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254);
}

function parseIpv4MappedIpv6(hostname) {
  const match = String(hostname || '').toLowerCase().match(/^(?:::)?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return match ? parseIpv4Address(match[1]) : null;
}

function expandIpv6Address(hostname) {
  const value = String(hostname || '').toLowerCase();
  if (!value.includes(':') || value.includes('.')) return null;
  const sections = value.split('::');
  if (sections.length > 2) return null;
  const left = sections[0] ? sections[0].split(':') : [];
  const right = sections[1] ? sections[1].split(':') : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (sections.length === 1 && missing !== 0)) return null;
  const hextets = [
    ...left,
    ...Array(sections.length === 2 ? missing : 0).fill('0'),
    ...right,
  ].map((part) => Number.parseInt(part, 16));
  return hextets.length === 8 && hextets.every((part) => Number.isInteger(part)) ? hextets : null;
}

function isPrivateIpv6(hostname) {
  const mappedIpv4 = parseIpv4MappedIpv6(hostname);
  if (mappedIpv4) return isPrivateIpv4(mappedIpv4);
  const hextets = expandIpv6Address(hostname);
  if (!hextets) return false;
  const isHexMappedIpv4 = hextets.slice(0, 5).every((part) => part === 0) && hextets[5] === 0xffff;
  if (isHexMappedIpv4) {
    return isPrivateIpv4([
      (hextets[6] >> 8) & 0xff,
      hextets[6] & 0xff,
      (hextets[7] >> 8) & 0xff,
      hextets[7] & 0xff,
    ]);
  }
  const first = hextets[0];
  const isLoopback = hextets.slice(0, 7).every((part) => part === 0) && hextets[7] === 1;
  return isLoopback
    || (first >= 0xfc00 && first <= 0xfdff)
    || (first >= 0xfe80 && first <= 0xfebf);
}

function assertPublicHttpsStorageOrigin(parsed) {
  const hostname = normalizeHostname(parsed.hostname);
  const ipVersion = net.isIP(hostname);
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || (ipVersion === 4 && isPrivateIpv4(parseIpv4Address(hostname)))
    || (ipVersion === 6 && isPrivateIpv6(hostname))
  ) {
    throw videoRequestError('VIDEO_REFERENCE_FORBIDDEN', 'ToAPIs 参考素材要求配置公网 HTTPS 存储地址');
  }
}

function parseJsonObject(value) {
  if (!value) return {};
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function parseRequestSnapshotForProcessing(value) {
  if (!value) return { valid: true, present: false, snapshot: {} };
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { valid: true, present: true, snapshot: parsed };
    }
  } catch (_) {}
  return { valid: false, present: true, snapshot: {} };
}

function keepVideoProcessing(db, row, videoGenId, message, now = new Date().toISOString()) {
  db.prepare('UPDATE video_generations SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?')
    .run('processing', String(message || '').slice(0, 500), now, videoGenId);
  if (row?.task_id) taskService.updateTaskStatus(db, row.task_id, 'processing', 90, message);
}

function toapisStorageContext() {
  const cfg = require('../config').loadConfig();
  const rawBase = String(cfg.storage?.base_url || '').trim().replace(/\/+$/, '');
  let parsed = null;
  try {
    parsed = new URL(rawBase);
  } catch (_) {
    throw videoRequestError('VIDEO_REFERENCE_FORBIDDEN', 'ToAPIs 参考素材要求配置公网 HTTPS 存储地址');
  }
  assertPublicHttpsStorageOrigin(parsed);
  const prefix = parsed.pathname.replace(/\/+$/, '') || '';
  return {
    origin: parsed.origin,
    staticPrefix: prefix.endsWith('/static') ? prefix : '/static',
  };
}

function normalizeToapisReferenceUrl(ref, context) {
  const raw = String(ref || '').trim();
  if (!raw) return null;
  let pathname = raw;
  if (/^https?:\/\//i.test(raw)) {
    let parsed = null;
    try {
      parsed = new URL(raw);
    } catch (_) {
      throw videoRequestError('VIDEO_REFERENCE_FORBIDDEN', '参考素材地址非法');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.origin !== context.origin) {
      throw videoRequestError('VIDEO_REFERENCE_FORBIDDEN', 'ToAPIs 只允许使用平台自身存储的公网 HTTPS 素材');
    }
    pathname = parsed.pathname;
  } else if (!raw.startsWith('/static/')) {
    throw videoRequestError('VIDEO_REFERENCE_FORBIDDEN', 'ToAPIs 只允许使用平台自身存储的公网 HTTPS 素材');
  }
  let decoded = pathname;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch (_) {
      throw videoRequestError('VIDEO_REFERENCE_FORBIDDEN', '参考素材路径非法');
    }
  }
  if (decoded.includes('\\')) {
    throw videoRequestError('VIDEO_REFERENCE_FORBIDDEN', '参考素材路径非法');
  }
  const normalized = path.posix.normalize(decoded);
  if (normalized !== decoded || !normalized.startsWith('/static/projects/')) {
    throw videoRequestError('VIDEO_REFERENCE_FORBIDDEN', '参考素材路径非法');
  }
  const relativePath = normalized.replace(/^\/static\/+/, '');
  return {
    url: `${context.origin}/static/${relativePath}`,
    relativePath,
  };
}

function signedWan3SubmissionPayload(payload) {
  const signAsset = (value) => providerAssetUrl.signProviderAssetUrl(value, {
    filesBaseUrl: payload.files_base_url,
  });
  const signAssets = (values) => Array.isArray(values) ? values.map(signAsset) : values;
  const hasMultimodalReferences = [
    payload.reference_urls,
    payload.reference_video_urls,
    payload.reference_audio_urls,
  ].some((values) => Array.isArray(values) && values.some((value) => String(value || '').trim()))
    || String(payload.voice_reference_url || '').trim();
  return {
    ...payload,
    image_url: hasMultimodalReferences ? '' : signAsset(payload.image_url),
    first_frame_url: signAsset(payload.first_frame_url),
    last_frame_url: signAsset(payload.last_frame_url),
    reference_urls: signAssets(payload.reference_urls),
    reference_video_urls: signAssets(payload.reference_video_urls),
    reference_audio_urls: signAssets(payload.reference_audio_urls),
    voice_reference_url: signAsset(payload.voice_reference_url),
    audio: typeof payload.audio === 'boolean' ? payload.audio : payload.generate_audio,
  };
}

function findVideoPlatformReference(db, kind, relativePath, publicUrl) {
  const assets = db.prepare(`SELECT id, drama_id, image_gen_id, metadata FROM assets
    WHERE deleted_at IS NULL AND type = ? AND (local_path = ? OR url = ? OR url = ?)
    ORDER BY id DESC`).all(kind, relativePath, `/static/${relativePath}`, publicUrl);
  if (assets.length) {
    if (kind === 'image') {
      for (const asset of assets) {
        if (!(Number(asset.image_gen_id) > 0)) continue;
        const imageGeneration = db.prepare(`SELECT id, drama_id FROM image_generations
          WHERE id = ? AND deleted_at IS NULL AND status = 'completed'
            AND (local_path = ? OR image_url = ? OR image_url = ?)`)
          .get(asset.image_gen_id, relativePath, `/static/${relativePath}`, publicUrl);
        if (imageGeneration && Number(imageGeneration.drama_id) === Number(asset.drama_id)) {
          return {
            id: asset.id,
            source: 'asset',
            drama_id: asset.drama_id,
            ai_generated_image: true,
            metadata: parseJsonObject(asset.metadata),
          };
        }
      }
    }
    if (kind !== 'image') {
      const asset = assets[0];
      return {
        id: asset.id,
        source: 'asset',
        drama_id: asset.drama_id,
        ai_generated_image: false,
        metadata: parseJsonObject(asset.metadata),
      };
    }
  }
  if (kind === 'image') {
    const generated = db.prepare(`SELECT id, drama_id FROM image_generations
      WHERE deleted_at IS NULL AND status = 'completed' AND (local_path = ? OR image_url = ? OR image_url = ?)
      ORDER BY id DESC LIMIT 1`).get(relativePath, `/static/${relativePath}`, publicUrl);
    if (generated) return {
      id: generated.id,
      source: 'image_generation',
      drama_id: generated.drama_id,
      ai_generated_image: true,
      metadata: {},
    };
  }
  if (assets.length) {
    const asset = assets[0];
    return {
      id: asset.id,
      source: 'asset',
      drama_id: asset.drama_id,
      ai_generated_image: false,
      metadata: parseJsonObject(asset.metadata),
    };
  }
  if (kind === 'video') {
    const generated = db.prepare(`SELECT id, drama_id FROM video_generations
      WHERE deleted_at IS NULL AND status = 'completed' AND (local_path = ? OR video_url = ? OR video_url = ?)
      ORDER BY id DESC LIMIT 1`).get(relativePath, `/static/${relativePath}`, publicUrl);
    if (generated) return { source: 'video_generation', drama_id: generated.drama_id, metadata: {} };
  }
  return null;
}

function assertToapisReferencesAllowed(db, references, dramaId, options = {}) {
  const inputImageUrls = cleanUrlList(references.imageUrls);
  const inputVideoUrls = cleanUrlList(references.videoUrls);
  const inputAudioUrls = cleanUrlList(references.audioUrls);
  const inputFirstFrameUrl = cleanUrlList(references.firstFrameUrl)[0] || null;
  const inputLastFrameUrl = cleanUrlList(references.lastFrameUrl)[0] || null;
  const inputImageUrl = cleanUrlList(references.imageUrl)[0] || null;
  const allRefs = [
    ...inputImageUrls.map((url) => ({ kind: 'image', url })),
    ...inputVideoUrls.map((url) => ({ kind: 'video', url })),
    ...inputAudioUrls.map((url) => ({ kind: 'audio', url })),
    ...cleanUrlList(inputFirstFrameUrl, inputLastFrameUrl, inputImageUrl)
      .map((url) => ({ kind: 'image', url })),
  ];
  if (allRefs.length === 0) {
    return {
      imageUrls: [],
      videoUrls: [],
      audioUrls: [],
      firstFrameUrl: null,
      lastFrameUrl: null,
      imageUrl: null,
      privateAvatarImages: [],
    };
  }
  const targetDramaId = Number(dramaId);
  if (!Number.isSafeInteger(targetDramaId) || targetDramaId <= 0) {
    throw videoRequestError('VIDEO_REFERENCE_FORBIDDEN', '参考素材所属项目不存在');
  }
  const drama = db.prepare('SELECT id, tenant_id, user_id FROM dramas WHERE id = ? AND deleted_at IS NULL').get(targetDramaId);
  if (!drama) throw videoRequestError('VIDEO_REFERENCE_FORBIDDEN', '参考素材所属项目不存在');
  if (options.billingEnabled) {
    if (options.tenantId) {
      if (!drama.tenant_id || String(drama.tenant_id) !== String(options.tenantId)) {
        throw videoRequestError('VIDEO_REFERENCE_FORBIDDEN', '参考素材请求租户与当前项目不一致');
      }
    } else if (!options.userId || String(drama.user_id || '') !== String(options.userId)) {
      throw videoRequestError('VIDEO_REFERENCE_FORBIDDEN', '参考素材请求用户与当前项目不一致');
    }
  }
  const context = toapisStorageContext();
  const normalized = {
    imageUrls: [],
    videoUrls: [],
    audioUrls: [],
    firstFrameUrl: null,
    lastFrameUrl: null,
    imageUrl: null,
    privateAvatarImages: [],
  };
  for (const item of allRefs) {
    const ref = normalizeToapisReferenceUrl(item.url, context);
    const row = findVideoPlatformReference(db, item.kind, ref.relativePath, ref.url);
    if (!row) throw videoRequestError('VIDEO_REFERENCE_FORBIDDEN', '参考素材不是当前项目可用素材');
    const metadata = row.metadata || {};
    if (!(row.drama_id == null && metadata.system_shared === true) && Number(row.drama_id) !== targetDramaId) {
      throw videoRequestError('VIDEO_REFERENCE_FORBIDDEN', '参考素材不属于当前项目');
    }
    if (item.kind === 'image' && row.ai_generated_image === true) {
      normalized.privateAvatarImages.push({
        url: ref.url,
        source_kind: row.source,
        source_id: Number(row.id),
      });
    }
    if (item.kind === 'image' && item.url === inputFirstFrameUrl) normalized.firstFrameUrl = ref.url;
    if (item.kind === 'image' && item.url === inputLastFrameUrl) normalized.lastFrameUrl = ref.url;
    if (item.kind === 'image' && item.url === inputImageUrl) normalized.imageUrl = ref.url;
    if (item.kind === 'image' && inputImageUrls.includes(item.url)) normalized.imageUrls.push(ref.url);
    if (item.kind === 'video') normalized.videoUrls.push(ref.url);
    if (item.kind === 'audio') normalized.audioUrls.push(ref.url);
  }
  normalized.imageUrls = [...new Set(normalized.imageUrls)];
  normalized.videoUrls = [...new Set(normalized.videoUrls)];
  normalized.audioUrls = [...new Set(normalized.audioUrls)];
  normalized.privateAvatarImages = [...new Map(
    normalized.privateAvatarImages.map((item) => [`${item.source_kind}:${item.source_id}:${item.url}`, item])
  ).values()];
  return normalized;
}

function buildVideoRequestSnapshot(input) {
  return {
    model: input.model || null,
    prompt: input.prompt || '',
    duration: input.duration,
    aspect_ratio: input.aspectRatio || null,
    resolution: input.resolution ?? null,
    seed: input.seed ?? null,
    camera_fixed: input.cameraFixed ?? null,
    watermark: input.watermark === true,
    reference_mode: input.referenceMode,
    generate_audio: input.generateAudio === true,
    image_url: input.imageUrl || null,
    first_frame_url: input.firstFrameUrl || null,
    last_frame_url: input.lastFrameUrl || null,
    reference_image_urls: input.referenceImageUrls || [],
    reference_video_urls: input.referenceVideoUrls || [],
    reference_audio_urls: input.referenceAudioUrls || [],
    _toapis_private_avatar_images: input.toapisPrivateAvatarImages || [],
  };
}

function snapshotField(snapshot, key, fallback) {
  return Object.prototype.hasOwnProperty.call(snapshot || {}, key) ? snapshot[key] : fallback;
}

function create(db, log, req, options = {}) {
  const body = req || {};
  const billingEnabled = Boolean(options.billingEnabled);
  if (billingEnabled && !options.userId) throw Object.assign(new Error('公开计费模式缺少用户身份'), { code: 'UNAUTHORIZED' });
  let dramaId = Number(body.drama_id) || 0;
  const storyboardId = body.storyboard_id != null ? Number(body.storyboard_id) : null;
  const storyboardDefaults = loadStoryboardVideoDefaults(db, storyboardId);
  if (!dramaId && storyboardDefaults?.drama_id) dramaId = Number(storyboardDefaults.drama_id) || 0;
  const selectedModel = body.model || storyboardDefaults?.video_model || null;
  let videoConfig = videoClient.getDefaultVideoConfig(db, selectedModel, options.evidenceRoots);
  let model = String(videoConfig?.canvas_selected_model
    || selectedModel
    || videoConfig?.default_model
    || configModels(videoConfig)[0]
    || '').trim() || null;
  const wan3State = String(model || '').toLowerCase() === TOAPIS_WAN3_MODEL
    ? toapisWan3ReadyState(db, model, options.evidenceRoots)
    : null;
  if (wan3State) {
    videoConfig = wan3State.config;
    model = wan3State.model;
  }
  const lingjingState = String(model || '').toLowerCase() === lingjingVideoClient.PUBLIC_MODEL
    ? lingjingReadyState(db, model, options.evidenceRoots)
    : null;
  if (lingjingState) {
    videoConfig = lingjingState.config;
    model = lingjingState.model;
  }
  const toapisState = TOAPIS_VIDEO_MODELS[String(model || '').toLowerCase()]
    ? toapisReadyState(db, model, options.evidenceRoots)
    : null;
  if (toapisState) {
    videoConfig = toapisState.config;
    model = toapisState.model;
  }
  const feituoState = FEITUO_MODELS[String(model || '').toLowerCase()]
    && String(model || '').toLowerCase().startsWith('xuan-')
    ? feituoReadyState(db, model)
    : null;
  if (feituoState) {
    videoConfig = feituoState.config;
    model = feituoState.model;
  }
  const strictVideoState = wan3State || lingjingState || toapisState || feituoState;
  const videoProtocol = String(videoConfig?.api_protocol || videoConfig?.provider || '').trim().toLowerCase();
  const isToapisVideo = Boolean(toapisState || wan3State)
    || videoProtocol === 'toapis_video'
    || videoProtocol === 'toapis'
    || videoProtocol === 'toapis_wan3_video';
  const isLingjingVideo = Boolean(lingjingState)
    || videoProtocol === 'lingjing_open'
    || videoProtocol === 'lingjing';
  const toapisSpec = toapisState
    ? {
        ...toapisState.official,
        maxReferences: verifiedReferenceLimit(toapisState.capabilities?.maxReferences),
        maxVideoReferences: verifiedReferenceLimit(toapisState.capabilities?.maxVideoReferences),
        maxAudioReferences: verifiedReferenceLimit(toapisState.capabilities?.maxAudioReferences),
      }
    : (isToapisVideo ? TOAPIS_VIDEO_MODELS[String(model || '').trim().toLowerCase()] : null);
  const wan3Spec = wan3State
    ? {
        ...wan3State.official,
        maxReferences: verifiedReferenceLimit(wan3State.capabilities?.maxReferences),
        maxVideoReferences: verifiedReferenceLimit(wan3State.capabilities?.maxVideoReferences),
        maxAudioReferences: verifiedReferenceLimit(wan3State.capabilities?.maxAudioReferences),
      }
    : null;
  const feituoSpec = feituoState
    ? {
        ...feituoState.official,
        maxReferences: verifiedReferenceLimit(feituoState.capabilities?.maxReferences),
        maxVideoReferences: verifiedReferenceLimit(feituoState.capabilities?.maxVideoReferences),
        maxAudioReferences: verifiedReferenceLimit(feituoState.capabilities?.maxAudioReferences),
      }
    : null;
  const inputReferenceImageUrls = cleanUrlList(
    body.reference_image_urls,
    isLingjingVideo ? body.image_url : null,
  );
  if (toapisSpec && inputReferenceImageUrls.length > toapisSpec.maxReferences) {
    throw videoRequestError(
      'VIDEO_REFERENCE_LIMIT_EXCEEDED',
      `ToAPIs 模型 ${model} 最多支持 ${toapisSpec.maxReferences} 张参考图`
    );
  }
  const requestedResolution = String(body.resolution || '').trim().toLowerCase();
  if (strictVideoState && strictVideoState.resolutions.length > 0
      && (!requestedResolution || !strictVideoState.resolutions.includes(requestedResolution))) {
    throw videoRequestError(
      'MODEL_RESOLUTION_PRICE_REQUIRED',
      `${strictVideoState.model} 当前只开放已验证且已定价的 ${strictVideoState.resolutions.join('、')}`
    );
  }
  const allowedDurations = strictVideoState?.durations || null;
  const minimumDuration = minimumVideoDuration(model);
  const storyboardDuration = Number(storyboardDefaults?.duration);
  const storyboardDurationAllowed = Number.isSafeInteger(storyboardDuration)
    && (allowedDurations
      ? allowedDurations.includes(storyboardDuration)
      : storyboardDuration >= minimumDuration && storyboardDuration <= 15);
  const fallbackDuration = storyboardDurationAllowed
    ? storyboardDuration
    : configuredVideoDuration(videoConfig, allowedDurations || minimumDuration)
      || allowedDurations?.[0]
      || minimumDuration;
  const duration = normalizeVideoDuration(
    body.duration,
    fallbackDuration,
    allowedDurations || minimumDuration,
  );
  const resolvedCapabilities = videoReferenceCapability.resolve(videoConfig || {}, model);
  const strictReferenceSpec = wan3Spec || toapisSpec || feituoSpec;
  const lingjingSpec = lingjingState
    ? {
        maxReferences: verifiedReferenceLimit(lingjingState.capabilities?.maxReferences),
        maxVideoReferences: 0,
        maxAudioReferences: 0,
      }
    : null;
  const effectiveCapabilities = (strictReferenceSpec || lingjingSpec)
    ? {
        ...resolvedCapabilities,
        referenceTypes: [
          strictVideoState?.capabilities?.supportsImageReference === true ? 'image' : null,
          strictVideoState?.capabilities?.supportsVideoReference === true ? 'video' : null,
          strictVideoState?.capabilities?.supportsAudioReference === true ? 'audio' : null,
        ].filter(Boolean),
        maxImageReferences: (strictReferenceSpec || lingjingSpec).maxReferences,
        maxVideoReferences: (strictReferenceSpec || lingjingSpec).maxVideoReferences,
        maxAudioReferences: (strictReferenceSpec || lingjingSpec).maxAudioReferences,
      }
    : resolvedCapabilities;
  const normalizedReferences = videoReferenceCapability.validateAndNormalize({
    model,
    capabilities: effectiveCapabilities,
    referenceImageUrls: inputReferenceImageUrls,
    referenceAudioUrls: cleanUrlList(body.reference_audio_urls, body.reference_audio_url),
    referenceVideoUrls: cleanUrlList(body.reference_video_urls, body.reference_video_url),
  });

  let billingModel = strictVideoState ? model : (selectedModel || model);
  let price = null;
  if (strictVideoState) {
    billingModel = modelPrice.canonicalModel(billingModel);
    if (toapisState || wan3State) requireToapisResolutionPrice(db, billingModel, requestedResolution);
    if (feituoState) requireFeituoPrice(db, feituoState, requestedResolution);
    if (lingjingState) {
      const configured = modelPrice.list(db)
        .find((row) => String(row.model || '').trim().toLowerCase() === billingModel);
      if (!configured || configured.category !== 'video' || configured.status !== 'enabled'
          || configured.billing_unit !== 'second' || configured.cost_unit !== 'second'
          || !Number.isSafeInteger(configured.credits) || configured.credits <= 0
          || !Number.isSafeInteger(configured.cost_micros_per_unit) || configured.cost_micros_per_unit <= 0
          || Object.keys(configured.resolution_prices || {}).length > 0) {
        throw videoRequestError('MODEL_PRICE_NOT_CONFIGURED', '灵境视频积分待管理员配置');
      }
    }
    price = modelPrice.calculateCharge(db, billingModel, {
      duration,
      resolution: lingjingState ? undefined : requestedResolution,
      allowedDurations,
    });
  }

  const active = findActiveForStoryboard(db, storyboardId, {
    billingEnabled,
    userId: options.userId,
    tenantId: options.tenantId,
  });
  if (active && !strictVideoState) return reuseActiveGeneration(db, active, duration, billingEnabled, options);

  if (billingEnabled && !strictVideoState) {
    if (!options.userId) throw Object.assign(new Error('公开计费模式缺少用户身份'), { code: 'UNAUTHORIZED' });
    if (!billingModel) {
      billingModel = videoConfig?.default_model || videoConfig?.model || null;
    }
    billingModel = modelPrice.canonicalModel(billingModel);
    price = modelPrice.calculateCharge(db, billingModel, {
      duration,
      resolution: body.resolution,
    });
  }

  // USMercari 能力预检：超限时必须在任务入库、积分预扣与供应商提交之前阻断
  const precheckProtocol = String(videoConfig?.api_protocol || videoConfig?.provider || '').trim().toLowerCase();
  if (['usmercari', 'usmercari_media'].includes(precheckProtocol)) {
    usmercariVideoClient.validateUsmercariVideoOptions({
      model: model || selectedModel || videoConfig?.default_model,
      duration,
      aspect_ratio: body.aspect_ratio,
      resolution: body.resolution,
      image_url: body.image_url,
      first_frame_url: body.first_frame_url ?? body.first_frame_local_path ?? body.image_url,
      last_frame_url: body.last_frame_url ?? body.last_frame_local_path,
      reference_urls: Array.isArray(body.reference_image_urls) ? body.reference_image_urls : [],
      reference_video_urls: Array.isArray(body.reference_video_urls)
        ? body.reference_video_urls
        : (body.reference_video_url ? [body.reference_video_url] : []),
      reference_audio_urls: Array.isArray(body.reference_audio_urls)
        ? body.reference_audio_urls
        : (body.reference_audio_url ? [body.reference_audio_url] : []),
    });
  }

  const persistedPrompt = storyboardId
    ? voicePrompt.ensureStoryboardVoicePrompt(db, storyboardId)
    : null;
  const storyboardPrompt = String(persistedPrompt || storyboardDefaults?.video_prompt || '').trim();
  let prompt = String(body.prompt ?? '').trim();
  if (!prompt) prompt = storyboardPrompt;
  const style = String(body.style || '').trim();
  if (style && !String(prompt).toLowerCase().includes(style.toLowerCase())) {
    prompt = prompt ? `${prompt}. Style: ${style}` : `Style: ${style}`;
  }
  prompt = voicePrompt.appendVoiceAnchors({
    db,
    dramaId,
    storyboardId,
    prompt,
    protocol: body.api_protocol,
    model,
  });
  let aspectRatio = body.aspect_ratio ? videoClient.normalizeAspectRatioForApi(body.aspect_ratio) : null;
  if (!aspectRatio && dramaId) {
    try {
      const drama = db.prepare('SELECT metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(dramaId);
      const metadata = drama?.metadata ? JSON.parse(drama.metadata) : null;
      if (metadata?.aspect_ratio) aspectRatio = videoClient.normalizeAspectRatioForApi(metadata.aspect_ratio);
    } catch (_) {}
  }
  let referenceImageUrls = cleanUrlList(normalizedReferences.referenceImageUrls);
  let referenceVideoUrls = cleanUrlList(normalizedReferences.referenceVideoUrls);
  let referenceAudioUrls = cleanUrlList(normalizedReferences.referenceAudioUrls);
  let imageUrl = isLingjingVideo ? null : cleanUrlList(body.image_url)[0] || null;
  let firstFrameUrl = isLingjingVideo
    ? cleanUrlList(body.first_frame_url, body.first_frame_local_path)[0] || null
    : cleanUrlList(body.first_frame_url, body.first_frame_local_path, body.image_url)[0] || null;
  let lastFrameUrl = cleanUrlList(body.last_frame_url, body.last_frame_local_path)[0] || null;
  let toapisPrivateAvatarImages = [];
  const hasFrameRefs = !!(firstFrameUrl || lastFrameUrl);
  const hasOmniRefs = referenceImageUrls.length > 0 || referenceVideoUrls.length > 0 || referenceAudioUrls.length > 0;
  if (isToapisVideo) {
    if (lastFrameUrl && !firstFrameUrl) {
      throw videoRequestError('VIDEO_REFERENCE_FORBIDDEN', 'ToAPIs 尾帧参考必须同时提供首帧');
    }
    if (hasFrameRefs && hasOmniRefs) {
      throw videoRequestError('VIDEO_REFERENCE_FORBIDDEN', 'ToAPIs 首尾帧和全能参考不能混用');
    }
    const normalizedRefs = assertToapisReferencesAllowed(db, {
      imageUrls: referenceImageUrls,
      videoUrls: referenceVideoUrls,
      audioUrls: referenceAudioUrls,
      imageUrl,
      firstFrameUrl,
      lastFrameUrl,
    }, dramaId, options);
    referenceImageUrls = normalizedRefs.imageUrls;
    referenceVideoUrls = normalizedRefs.videoUrls;
    referenceAudioUrls = normalizedRefs.audioUrls;
    imageUrl = normalizedRefs.imageUrl || imageUrl;
    firstFrameUrl = normalizedRefs.firstFrameUrl || (hasFrameRefs ? null : firstFrameUrl);
    lastFrameUrl = normalizedRefs.lastFrameUrl || (hasFrameRefs ? null : lastFrameUrl);
    toapisPrivateAvatarImages = normalizedRefs.privateAvatarImages;
  }
  if (isLingjingVideo) {
    if (firstFrameUrl || lastFrameUrl) {
      throw videoRequestError('VIDEO_REFERENCE_FORBIDDEN', '灵境 relay 当前不支持首尾帧参考');
    }
    if (referenceVideoUrls.length || referenceAudioUrls.length || body.generate_audio === true) {
      throw videoRequestError('VIDEO_REFERENCE_UNSUPPORTED', '灵境 relay 当前只支持图片参考');
    }
    const normalizedRefs = assertToapisReferencesAllowed(db, {
      imageUrls: referenceImageUrls,
      videoUrls: [],
      audioUrls: [],
      imageUrl: null,
      firstFrameUrl: null,
      lastFrameUrl: null,
    }, dramaId, options);
    referenceImageUrls = normalizedRefs.imageUrls;
    referenceVideoUrls = [];
    referenceAudioUrls = [];
    imageUrl = null;
    firstFrameUrl = null;
    lastFrameUrl = null;
  }
  const referenceMode = hasOmniRefs ? 'omni' : hasFrameRefs ? 'frame' : 'text';
  const generateAudio = body.generate_audio === true;
  if (wan3State) {
    requireVerifiedToapisReferenceCapabilities(wan3State, {
      firstFrameUrl,
      lastFrameUrl,
      referenceImageUrls,
      referenceVideoUrls,
      referenceAudioUrls,
      generateAudio,
    });
    const requestedAspectRatio = aspectRatio || '16:9';
    if (!wan3State.aspectRatios.includes(requestedAspectRatio)) {
      throw videoRequestError('MODEL_NOT_VERIFIED', `${wan3State.model} 尚未验证 ${requestedAspectRatio} 画幅`);
    }
    if (!wan3State.audioValues.includes(generateAudio)) {
      throw videoRequestError('MODEL_NOT_VERIFIED', `${wan3State.model} 尚未验证同步音频=${generateAudio}`);
    }
    try {
      toapisWan3VideoClient.validateToapisWan3VideoOptions({
        model,
        prompt,
        duration,
        resolution: requestedResolution,
        aspect_ratio: requestedAspectRatio,
        image_url: imageUrl,
        first_frame_url: firstFrameUrl,
        last_frame_url: lastFrameUrl,
        reference_urls: referenceImageUrls,
        reference_video_urls: referenceVideoUrls,
        reference_audio_urls: referenceAudioUrls,
        generate_audio: generateAudio,
      });
    } catch (error) {
      const message = String(error?.message || 'ToAPIs Wan 3.0 视频请求参数无效');
      if (/不支持.*秒|时长/.test(message)) throw videoRequestError('INVALID_VIDEO_DURATION', message);
      if (/不支持.*(?:480|720|1080)p|分辨率/.test(message)) {
        throw videoRequestError('MODEL_RESOLUTION_PRICE_REQUIRED', message);
      }
      if (/画幅/.test(message)) throw videoRequestError('MODEL_NOT_VERIFIED', message);
      if (/提示词/.test(message)) throw videoRequestError('INVALID_VIDEO_REQUEST', message);
      throw videoRequestError('VIDEO_REFERENCE_FORBIDDEN', message);
    }
    if (active) {
      return reuseActiveGeneration(db, active, duration, billingEnabled, options, {
        model,
        resolution: requestedResolution,
      });
    }
  }
  if (toapisState) {
    requireVerifiedToapisReferenceCapabilities(toapisState, {
      firstFrameUrl,
      lastFrameUrl,
      referenceImageUrls,
      referenceVideoUrls,
      referenceAudioUrls,
      generateAudio,
    });
    try {
      toapisVideoClient.validateToapisVideoOptions({
        model,
        prompt,
        duration,
        resolution: requestedResolution,
        aspect_ratio: aspectRatio || '16:9',
        image_url: imageUrl,
        first_frame_url: firstFrameUrl,
        last_frame_url: lastFrameUrl,
        reference_urls: referenceImageUrls,
        reference_video_urls: referenceVideoUrls,
        reference_audio_urls: referenceAudioUrls,
        generate_audio: generateAudio,
      });
    } catch (error) {
      const message = String(error?.message || 'ToAPIs 视频请求参数无效');
      if (/不支持.*秒|时长/.test(message)) throw videoRequestError('INVALID_VIDEO_DURATION', message);
      if (/不支持.*(?:480|720|1080)p|分辨率/.test(message)) {
        throw videoRequestError('MODEL_RESOLUTION_PRICE_REQUIRED', message);
      }
      if (/提示词/.test(message)) throw videoRequestError('INVALID_VIDEO_REQUEST', message);
      throw videoRequestError('VIDEO_REFERENCE_FORBIDDEN', message);
    }
    if (active) {
      return reuseActiveGeneration(db, active, duration, billingEnabled, options, {
        model,
        resolution: requestedResolution,
      });
    }
  }
  if (lingjingState) {
    try {
      lingjingVideoClient.buildLingjingVideoBody({
        model,
        prompt,
        duration,
        aspect_ratio: aspectRatio || '16:9',
        request_id: 'create-validation',
        reference_image_paths: referenceImageUrls.map((_, index) => `uploads/reference-${index + 1}.png`),
      });
    } catch (error) {
      const message = String(error?.message || '灵境视频请求参数无效');
      if (/不支持.*秒|时长/.test(message)) throw videoRequestError('INVALID_VIDEO_DURATION', message);
      if (/画幅/.test(message)) throw videoRequestError('INVALID_VIDEO_REQUEST', message);
      throw videoRequestError('VIDEO_REFERENCE_FORBIDDEN', message);
    }
    if (active) {
      return reuseActiveGeneration(db, active, duration, billingEnabled, options, {
        model,
      });
    }
  }
  if (feituoState) {
    requireVerifiedFeituoReferenceCapabilities(feituoState, {
      firstFrameUrl,
      lastFrameUrl,
      referenceImageUrls,
      referenceVideoUrls,
      referenceAudioUrls,
      generateAudio,
    });
    try {
      feituoVideoClient.buildFeituoVideoBody({
        model,
        prompt,
        duration,
        resolution: requestedResolution,
        aspect_ratio: aspectRatio || '16:9',
        image_url: imageUrl,
        first_frame_url: firstFrameUrl,
        last_frame_url: lastFrameUrl,
        reference_urls: referenceImageUrls,
        reference_video_urls: referenceVideoUrls,
        reference_audio_urls: referenceAudioUrls,
      });
    } catch (error) {
      const message = String(error?.message || '飞拓视频请求参数无效');
      if (/不支持.*秒|时长/.test(message)) throw videoRequestError('INVALID_VIDEO_DURATION', message);
      if (/不支持分辨率/.test(message)) throw videoRequestError('MODEL_RESOLUTION_PRICE_REQUIRED', message);
      throw videoRequestError('VIDEO_REFERENCE_FORBIDDEN', message);
    }
    if (active) {
      return reuseActiveGeneration(db, active, duration, billingEnabled, options, {
        model,
        resolution: requestedResolution,
      });
    }
  }
  const requestSnapshot = buildVideoRequestSnapshot({
    model,
    prompt,
    duration,
    aspectRatio,
    resolution: lingjingState ? null : body.resolution,
    seed: body.seed != null ? Number(body.seed) : null,
    cameraFixed: body.camera_fixed != null ? (body.camera_fixed ? 1 : 0) : null,
    watermark: body.watermark ? true : false,
    referenceMode,
    generateAudio,
    imageUrl,
    firstFrameUrl,
    lastFrameUrl,
    referenceImageUrls,
    referenceVideoUrls,
    referenceAudioUrls,
    toapisPrivateAvatarImages,
  });
  const sourceConditioningJson = (lingjingState || wan3State)
    ? JSON.stringify({
        video_capability: {
          config_id: videoConfig.id,
          config_updated_at: videoConfig.updated_at || '',
          provider: videoConfig.provider,
          protocol: videoClient.resolveVideoProtocol(videoConfig, model),
          model,
        },
      })
    : null;

  const now = new Date().toISOString();
  const result = db.transaction(() => {
    const task = taskService.createTask(db, log, 'video_generation', String(dramaId || ''));
    if (billingEnabled && options.tenantId) {
      db.prepare('UPDATE async_tasks SET tenant_id = ?, user_id = ? WHERE id = ?')
        .run(options.tenantId, options.userId, task.id);
    }
    const refs = referenceImageUrls.length ? JSON.stringify(referenceImageUrls) : null;
    const firstReferenceFallback = ['usmercari', 'usmercari_media'].includes(videoProtocol)
      || isToapisVideo
      ? null
      : referenceImageUrls[0] || null;
    const persistedFirstFrameUrl = firstFrameUrl || firstReferenceFallback;
    const referenceVideoUrl = referenceVideoUrls[0] || null;
    const referenceAudioUrl = referenceAudioUrls[0] || null;
    db.prepare(`INSERT INTO video_generations
      (drama_id, storyboard_id, provider, prompt, model, duration, aspect_ratio, resolution, seed, camera_fixed, watermark,
       image_url, first_frame_url, last_frame_url, reference_image_urls, reference_video_url, reference_audio_url,
       reference_mode, generate_audio, reference_video_urls, reference_audio_urls, request_snapshot,
       ai_service_config_id, source_conditioning_json,
       status, task_id, tenant_id, user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?, ?)`)
      .run(
        dramaId, storyboardId, wan3State ? videoConfig?.provider : (body.provider || videoConfig?.provider || 'chatfire'), prompt, model, duration,
        aspectRatio, lingjingState ? null : body.resolution ?? null, body.seed != null ? Number(body.seed) : null,
        body.camera_fixed != null ? (body.camera_fixed ? 1 : 0) : null, body.watermark ? 1 : 0,
        imageUrl ?? null, persistedFirstFrameUrl,
        lastFrameUrl ?? null, refs, referenceVideoUrl, referenceAudioUrl,
        referenceMode, generateAudio ? 1 : 0, JSON.stringify(referenceVideoUrls), JSON.stringify(referenceAudioUrls),
        JSON.stringify(requestSnapshot), (lingjingState || wan3State) ? videoConfig.id : null, sourceConditioningJson, task.id,
        billingEnabled ? options.tenantId || null : null,
        billingEnabled ? String(options.userId) : null, now, now
      );
    const id = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    if (billingEnabled) {
      const reservation = creditLedger.reserve(db, {
        tenantId: options.tenantId,
        actorUserId: options.userId,
        userId: options.userId,
        operationKey: `video:${id}`,
        amount: price,
        model: billingModel,
        resourceType: 'video',
        resourceId: id,
      });
      generationCost.record(db, {
        reservationId: reservation.id,
        model: billingModel,
        quantity: duration,
        resolution: lingjingState ? undefined : body.resolution,
        usageSource: 'configured',
      });
      db.prepare('UPDATE video_generations SET credit_reservation_id = ? WHERE id = ?').run(reservation.id, id);
      db.prepare('UPDATE async_tasks SET credit_reservation_id = ?, model = ? WHERE id = ?')
        .run(reservation.id, billingModel, task.id);
      auditEvent.record(db, {
        userId: options.userId,
        tenantId: options.tenantId,
        eventType: 'generation.video.created',
        resourceType: 'video',
        resourceId: id,
        outcome: 'success',
        code: 'CREATED',
      });
    }
    return { id, taskId: task.id };
  })();

  const schedule = options.schedule || ((callback) => setImmediate(callback));
  schedule((runtime = {}) => processVideoGeneration(db, log, result.id, {
    evidenceRoots: options.evidenceRoots,
    ...runtime,
  }));
  return getById(db, result.id) || { id: result.id, task_id: result.taskId, status: 'processing' };
}

/** @returns {{ dir: string, relPrefix: string }} 与图片 uploads 一致的工程子目录规则 */
function resolveVideosDir(storagePath, projectSubdir) {
  const sub = projectSubdir && String(projectSubdir).trim();
  if (sub) {
    const relPrefix = `${sub.replace(/\\/g, '/')}/videos`;
    return { dir: path.join(storagePath, sub, 'videos'), relPrefix };
  }
  return { dir: path.join(storagePath, 'videos'), relPrefix: 'videos' };
}

function ensureContainedVideoOutputDir(safetyRoot, outputDir) {
  const rootPath = path.resolve(String(safetyRoot || ''));
  if (!fs.existsSync(rootPath)) fs.mkdirSync(rootPath, { recursive: true });
  if (!fs.statSync(rootPath).isDirectory()) throw new Error('Unsafe video output root');
  const canonicalRoot = fs.realpathSync(rootPath);
  const relativeDir = path.relative(rootPath, path.resolve(outputDir));
  if (!relativeDir || path.isAbsolute(relativeDir) || relativeDir === '..'
      || relativeDir.startsWith(`..${path.sep}`)) {
    throw new Error('Unsafe video output directory');
  }

  let current = rootPath;
  for (const segment of relativeDir.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) fs.mkdirSync(current);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe video output directory');
    const canonicalCurrent = fs.realpathSync(current);
    if (!isCanonicalChild(canonicalRoot, canonicalCurrent)) {
      throw new Error('Unsafe video output directory');
    }
  }
  return canonicalRoot;
}

function removeContainedPartialFile(canonicalRoot, filePath) {
  if (!canonicalRoot || !filePath || !fs.existsSync(filePath)) return;
  const canonicalFile = fs.realpathSync(filePath);
  if (!isCanonicalChild(canonicalRoot, canonicalFile)) return;
  const stat = fs.lstatSync(filePath);
  if (stat.isFile() || stat.isSymbolicLink()) fs.rmSync(filePath, { force: true });
}

function hasIsoBmffFileStructure(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return false;
  let offset = 0;
  let hasMoov = false;
  let hasMdat = false;
  while (offset + 8 <= buffer.length) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > buffer.length) return false;
      const largeSize = buffer.readBigUInt64BE(offset + 8);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      size = Number(largeSize);
      headerSize = 16;
    } else if (size === 0) {
      size = buffer.length - offset;
    }
    if (size < headerSize || offset + size > buffer.length) return false;
    if (offset === 0) {
      if (type !== 'ftyp' || size < headerSize + 8 || (size - headerSize) % 4 !== 0) return false;
      const majorBrand = buffer.subarray(offset + headerSize, offset + headerSize + 4);
      if (!majorBrand.every((byte) => byte >= 0x20 && byte <= 0x7e)) return false;
      const brands = buffer.subarray(offset + headerSize + 8, offset + size);
      for (let i = 0; i < brands.length; i += 4) {
        if (!brands.subarray(i, i + 4).every((byte) => byte >= 0x20 && byte <= 0x7e)) return false;
      }
    }
    if (type === 'moov' && size > headerSize + 8) hasMoov = true;
    if (type === 'mdat' && size > headerSize) hasMdat = true;
    offset += size;
  }
  return hasMoov && hasMdat && offset === buffer.length;
}

function validateDownloadedVideoBuffer(buffer, ext) {
  const normalized = String(ext || '').toLowerCase();
  if ((normalized === 'mp4' || normalized === 'mov') && hasIsoBmffFileStructure(buffer)) return null;
  return `供应商返回的视频不是可识别的 ${normalized.toUpperCase()} 文件`;
}

/**
 * 将远程 video_url 下载到本地
 * @returns {Promise<{localPath: string|null, error?: string}>} 相对 storage 根的路径，如 projects/.../videos/vg_1_xxx.mp4；无工程时为 videos/...
 */
async function downloadVideoToLocal(storagePath, videoUrl, videoGenId, log, projectSubdir = null, fetchOptions = {}) {
  if (!videoUrl || typeof videoUrl !== 'string') return { localPath: null };
  const { dir, relPrefix } = resolveVideosDir(storagePath, projectSubdir);
  const downloadOptions = fetchOptions || {};
  const {
    fetchImpl: injectedFetch,
    safetyRoot,
    requireContainedOutput,
    ...requestOptions
  } = downloadOptions;
  const fetchImpl = injectedFetch || fetch;
  let filePath = null;
  let canonicalSafetyRoot = null;
  try {
    if (requireContainedOutput) {
      canonicalSafetyRoot = ensureContainedVideoOutputDir(safetyRoot, dir);
    } else if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const ext = (videoUrl.split('?')[0].match(/\.(mp4|webm|mov)$/i) || [])[1] || 'mp4';
    const name = `vg_${videoGenId}_${randomUUID().slice(0, 8)}.${ext}`;
    filePath = path.join(dir, name);
    const res = await fetchImpl(videoUrl, { method: 'GET', ...requestOptions });
    if (!res.ok) {
      log.warn('Download video failed', { status: res.status, videoGenId });
      return {
        localPath: null,
        indeterminate: true,
        error: `供应商视频链接返回 HTTP ${res.status}（结果未知）`,
      };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const validationError = validateDownloadedVideoBuffer(buf, ext);
    if (validationError) {
      const message = validationError;
      log.warn('Downloaded video rejected', { videoGenId, reason: message });
      return { localPath: null, error: message };
    }
    if (requireContainedOutput) {
      canonicalSafetyRoot = ensureContainedVideoOutputDir(safetyRoot, dir);
    }
    fs.writeFileSync(filePath, buf);
    const relativePath = `${relPrefix}/${name}`.replace(/\\/g, '/');
    log.info('Video saved to local', { videoGenId, local_path: relativePath, projectSubdir: projectSubdir || '(root)' });
    return { localPath: relativePath };
  } catch (e) {
    if (filePath) {
      try {
        if (requireContainedOutput) removeContainedPartialFile(canonicalSafetyRoot, filePath);
        else fs.rmSync(filePath, { force: true });
      } catch (_) {}
    }
    log.warn('Download video error', { videoGenId });
    return {
      localPath: null,
      indeterminate: true,
      error: '供应商视频链接暂时不可读取（结果未知）',
    };
  }
}

/** 与图生 aspectRatioToSize 对齐的归一化分辨率（偶数像素，便于 H.264） */
function targetVideoPixelsForAspect(aspectRatio, resolution) {
  const r = String(aspectRatio || '16:9').trim();
  const shortEdge = {
    '480p': 480,
    '720p': 720,
    '1080p': 1080,
    '1440p': 1440,
    '2k': 1440,
    '2160p': 2160,
    '4k': 2160,
  }[String(resolution || '').trim().toLowerCase()];
  if (shortEdge) {
    const match = r.match(/^(\d+)\s*:\s*(\d+)$/);
    const a = match ? parseInt(match[1], 10) : 16;
    const b = match ? parseInt(match[2], 10) : 9;
    const even = (value) => Math.max(2, Math.round(value / 2) * 2);
    if (a >= b) return { w: even((shortEdge * a) / b), h: shortEdge };
    return { w: shortEdge, h: even((shortEdge * b) / a) };
  }
  const map = {
    '16:9': { w: 2560, h: 1440 },
    '9:16': { w: 1440, h: 2560 },
    '1:1': { w: 1920, h: 1920 },
    '4:3': { w: 1920, h: 1440 },
    '3:4': { w: 1440, h: 1920 },
    '3:2': { w: 2560, h: 1708 },
    '2:3': { w: 1708, h: 2560 },
    '21:9': { w: 2560, h: 1080 },
  };
  if (map[r]) return map[r];
  const m = r.match(/^(\d+)\s*:\s*(\d+)$/);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (a > 0 && b > 0 && a !== b) {
      if (a > b) {
        const w = 2560;
        const h = Math.max(2, Math.round((w * b) / a / 2) * 2);
        return { w, h };
      }
      const h = 2560;
      const w = Math.max(2, Math.round((h * a) / b / 2) * 2);
      return { w, h };
    }
  }
  return { w: 1280, h: 720 };
}

/**
 * 用 ffmpeg 将视频缩放并加黑边到固定分辨率，避免 Grok 等返回实际像素不一致导致连播时画面跳动。
 */
function normalizeVideoFileToTargetPixels(absPath, tw, th, log, videoGenId) {
  if (!absPath || !tw || !th || !fs.existsSync(absPath)) return false;
  if (!hasLocalFfmpeg()) {
    log.info('[视频] 未找到 ffmpeg，跳过画幅归一化', { videoGenId });
    return false;
  }
  const ffmpeg = getFfmpegPath();
  const vf = `scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:black`;
  const tmpOut = absPath + '.norm-' + randomUUID().slice(0, 8) + (path.extname(absPath) || '.mp4');
  const baseArgs = ['-y', '-i', absPath, '-vf', vf, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
  let r = spawnSync(ffmpeg, [...baseArgs, '-c:a', 'copy', tmpOut], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) {
    r = spawnSync(ffmpeg, [...baseArgs, '-an', tmpOut], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  }
  if (r.status !== 0) {
    log.warn('[视频] 画幅归一化失败（保留原文件）', {
      videoGenId,
      stderr: (r.stderr || '').slice(-500),
    });
    try {
      fs.unlinkSync(tmpOut);
    } catch (_) {}
    return false;
  }
  try {
    fs.unlinkSync(absPath);
    fs.renameSync(tmpOut, absPath);
    log.info('[视频] 已统一画幅尺寸', { videoGenId, w: tw, h: th });
    return true;
  } catch (e) {
    log.warn('[视频] 替换归一化文件失败', { videoGenId, error: e.message });
    try {
      fs.unlinkSync(tmpOut);
    } catch (_) {}
    return false;
  }
}

function requireFeituoPrice(db, state, resolution) {
  const price = modelPrice.list(db)
    .find((row) => String(row.model || '').trim().toLowerCase() === state.model);
  if (!price || price.category !== 'video' || price.status !== 'enabled'
      || !Number.isSafeInteger(price.credits) || price.credits <= 0) {
    throw videoRequestError('MODEL_PRICE_NOT_CONFIGURED', `${state.model} 积分待管理员配置`);
  }
  if (state.official.resolutions.length > 1) {
    const tier = price.resolution_prices?.[resolution];
    if (!Number.isSafeInteger(tier?.credits) || tier.credits <= 0
        || !Number.isSafeInteger(tier?.cost_micros_per_second) || tier.cost_micros_per_second <= 0) {
      throw videoRequestError('MODEL_RESOLUTION_PRICE_REQUIRED', '当前分辨率积分待管理员配置');
    }
  } else if (price.billing_unit !== 'request' || price.cost_unit !== 'request'
      || !Number.isSafeInteger(price.cost_micros_per_unit) || price.cost_micros_per_unit <= 0) {
    throw videoRequestError('MODEL_PRICE_NOT_CONFIGURED', `${state.model} 按次价格待管理员配置`);
  }
}

function shouldNormalizeVideoAfterDownload(row = {}) {
  const model = String(row.model || '').trim().split('::').pop();
  return !Object.prototype.hasOwnProperty.call(toapisVideoClient.TOAPIS_VIDEO_MODELS, model);
}

function maybeNormalizeVideoAfterDownload(storagePath, localPath, row, videoGenId, log) {
  if (!localPath) return;
  if (!shouldNormalizeVideoAfterDownload(row)) return;
  const abs = path.join(storagePath, localPath);
  const dim = targetVideoPixelsForAspect(row.aspect_ratio, row.resolution);
  normalizeVideoFileToTargetPixels(abs, dim.w, dim.h, log, videoGenId);
}

function extractVideoBoundaryFrames(storagePath, localPath, videoGenId, log, options = {}) {
  const emptyResult = {
    output_first_frame_url: null,
    output_last_frame_url: null,
  };
  if (!localPath || options.hasFfmpeg === false) return emptyResult;
  if (options.hasFfmpeg !== true && !hasLocalFfmpeg()) return emptyResult;

  const videoPath = path.join(storagePath, localPath);
  if (!fs.existsSync(videoPath)) return emptyResult;

  const frameDir = path.dirname(videoPath);
  const firstPath = path.join(frameDir, `vg_${videoGenId}_first.jpg`);
  const lastPath = path.join(frameDir, `vg_${videoGenId}_last.jpg`);
  const ffmpegPath = options.ffmpegPath || getFfmpegPath();
  const run = options.run || spawnSync;
  const commonOptions = { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 };
  const outputs = [
    {
      key: 'output_first_frame_url',
      path: firstPath,
      args: ['-y', '-i', videoPath, '-frames:v', '1', '-q:v', '2', firstPath],
    },
    {
      key: 'output_last_frame_url',
      path: lastPath,
      args: ['-y', '-sseof', '-1', '-i', videoPath, '-map', '0:v:0', '-update', '1', '-q:v', '2', lastPath],
    },
  ];
  const result = { ...emptyResult };

  for (const output of outputs) {
    const commandResult = run(ffmpegPath, output.args, commonOptions);
    if (commandResult?.status !== 0 || !fs.existsSync(output.path)) {
      log?.warn?.('[视频] 成片边界帧提取失败', {
        videoGenId,
        frame: output.key,
        stderr: String(commandResult?.stderr || '').slice(-500),
      });
      continue;
    }
    const relativePath = path.relative(storagePath, output.path).split(path.sep).join('/');
    result[output.key] = `/static/${relativePath}`;
  }
  log?.info?.('[视频] 成片首尾帧提取完成', { videoGenId, ...result });
  return result;
}

function reconciliationProjectStorageSubdir(db, row) {
  const dramaId = Number(row?.drama_id);
  if (!Number.isSafeInteger(dramaId) || dramaId <= 0) return storageLayout.LIBRARY;
  const drama = db.prepare(
    'SELECT id, title, created_at, metadata FROM dramas WHERE id = ? AND deleted_at IS NULL'
  ).get(dramaId);
  return drama ? storageLayout.buildProjectRelativeDir(drama) : storageLayout.LIBRARY;
}

function reconciledArtifactError() {
  const error = new Error('视频产物不可读取');
  error.code = 'PROVIDER_TASK_ARTIFACT_UNREADABLE';
  return error;
}

function expectedReconciledBoundaryFrames(localPath, videoGenId) {
  const normalized = String(localPath || '').replace(/\\/g, '/');
  const directory = path.posix.dirname(normalized);
  const prefix = directory === '.' ? '' : `${directory}/`;
  return {
    output_first_frame_url: `/static/${prefix}vg_${videoGenId}_first.jpg`,
    output_last_frame_url: `/static/${prefix}vg_${videoGenId}_last.jpg`,
  };
}

function isCanonicalChild(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function discardReconciledVideoArtifact(prepared) {
  const storageValue = typeof prepared?.storagePath === 'string' ? prepared.storagePath.trim() : '';
  if (!storageValue) return;

  let root;
  try {
    root = fs.realpathSync(path.resolve(storageValue));
  } catch (_) {
    return;
  }

  const targets = [
    { value: prepared?.localPath, staticUrl: false },
    { value: prepared?.boundaryFrames?.output_first_frame_url, staticUrl: true },
    { value: prepared?.boundaryFrames?.output_last_frame_url, staticUrl: true },
  ];
  for (const target of targets) {
    try {
      const raw = typeof target.value === 'string' ? target.value.trim() : '';
      if (!raw) continue;
      if (target.staticUrl && !raw.startsWith('/static/')) continue;
      const relative = target.staticUrl ? raw.slice('/static/'.length) : raw;
      if (!relative || path.win32.isAbsolute(relative) || path.posix.isAbsolute(relative)) continue;
      const candidate = path.resolve(root, relative);
      if (!isCanonicalChild(root, candidate) || !fs.existsSync(candidate)) continue;
      const canonicalCandidate = fs.realpathSync(candidate);
      if (!isCanonicalChild(root, canonicalCandidate)) continue;
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      fs.rmSync(candidate, { force: true });
    } catch (_) {}
  }
}

async function prepareReconciledVideoArtifact(db, log, row, artifactUrl, providerConfig, options = {}) {
  const storagePath = options.storagePath || resolveStoragePath(require('../config').loadConfig());
  const cleanup = {
    storagePath,
    localPath: null,
    boundaryFrames: null,
  };
  try {
    const projectSubdir = reconciliationProjectStorageSubdir(db, row);
    const fetchOptions = {
      ...videoClient.getVideoArtifactFetchOptions(providerConfig, artifactUrl),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      safetyRoot: storagePath,
      requireContainedOutput: true,
    };
    const downloaded = await downloadVideoToLocal(
      storagePath,
      artifactUrl,
      row.id,
      log,
      projectSubdir,
      fetchOptions,
    );
    if (!downloaded.localPath) throw reconciledArtifactError();

    cleanup.localPath = downloaded.localPath;
    const stagingFrameId = `${row.id}_${randomUUID()}`;
    cleanup.boundaryFrames = expectedReconciledBoundaryFrames(downloaded.localPath, stagingFrameId);
    const normalizeImpl = options.normalizeImpl || maybeNormalizeVideoAfterDownload;
    normalizeImpl(storagePath, downloaded.localPath, row, row.id, log);
    const extractBoundaryFramesImpl = options.extractBoundaryFramesImpl || extractVideoBoundaryFrames;
    const boundaryFrames = extractBoundaryFramesImpl(
      storagePath,
      downloaded.localPath,
      stagingFrameId,
      log,
      options.extractionOptions || {},
    );
    return {
      storagePath,
      localPath: downloaded.localPath,
      videoUrl: artifactUrl,
      boundaryFrames,
    };
  } catch (_) {
    discardReconciledVideoArtifact(cleanup);
    throw reconciledArtifactError();
  }
}

function applyReconciledVideoSuccess(db, log, row, prepared, options = {}) {
  const now = options.now || new Date().toISOString();
  const localPath = String(prepared?.localPath || '').replace(/\\/g, '/');
  if (!localPath) throw reconciledArtifactError();
  const publicVideoUrl = `/static/${localPath.replace(/^\/static\//, '')}`;
  const boundaryFrames = prepared.boundaryFrames || {};
  const updated = db.prepare(`UPDATE video_generations
    SET status = 'completed', video_url = ?, local_path = ?, output_first_frame_url = ?,
      output_last_frame_url = ?, error_msg = NULL, completed_at = ?, updated_at = ?
    WHERE id = ? AND status = 'needs_attention' AND deleted_at IS NULL`)
    .run(
      publicVideoUrl,
      localPath,
      boundaryFrames.output_first_frame_url || null,
      boundaryFrames.output_last_frame_url || null,
      now,
      now,
      row.id,
    );
  if (updated.changes !== 1) throw new Error('视频对账成功状态已变化');

  if (row.task_id) {
    taskService.updateTaskResult(db, row.task_id, {
      video_generation_id: row.id,
      video_url: publicVideoUrl,
      local_path: localPath,
      output_first_frame_url: boundaryFrames.output_first_frame_url || null,
      output_last_frame_url: boundaryFrames.output_last_frame_url || null,
      status: 'completed',
    });
  }
  const settled = creditLedger.confirmForScope(
    db,
    row.credit_reservation_id,
    options.reservationScope,
  );
  if (settled?.status !== 'confirmed') throw new Error('视频对账积分确认失败');
  generationCost.record(db, {
    reservationId: row.credit_reservation_id,
    model: row.model || settled.model,
    configId: options.configId ?? row.config_id,
    count: 1,
    duration: row.duration,
    resolution: row.resolution,
    usageSource: 'provider',
  });
  auditEvent.record(db, {
    userId: settled.user_id,
    tenantId: settled.tenant_id,
    eventType: 'generation.video.reconciled',
    resourceType: 'video',
    resourceId: row.id,
    outcome: 'success',
    code: 'PROVIDER_TASK_SUCCEEDED',
  });
  log?.info?.('Video provider task reconciled', { request_id: options.requestId, state: 'completed' });
  return { videoUrl: publicVideoUrl, localPath, reservation: settled };
}

function applyReconciledVideoFailure(db, log, row, options = {}) {
  const now = options.now || new Date().toISOString();
  const message = '供应商任务已明确失败';
  const updated = db.prepare(`UPDATE video_generations
    SET status = 'failed', error_msg = ?, completed_at = ?, updated_at = ?
    WHERE id = ? AND status = 'needs_attention' AND deleted_at IS NULL`)
    .run(message, now, now, row.id);
  if (updated.changes !== 1) throw new Error('视频对账失败状态已变化');

  if (row.task_id) taskService.updateTaskError(db, row.task_id, message);
  const settled = creditLedger.refundForScope(
    db,
    row.credit_reservation_id,
    options.reservationScope,
    'provider_task_failed',
  );
  if (settled?.status !== 'refunded') throw new Error('视频对账积分退款失败');
  generationCost.record(db, {
    reservationId: row.credit_reservation_id,
    model: row.model || settled.model,
    configId: options.configId ?? row.config_id,
    usageSource: 'unknown',
  });
  auditEvent.record(db, {
    userId: settled.user_id,
    tenantId: settled.tenant_id,
    eventType: 'generation.video.reconciled',
    resourceType: 'video',
    resourceId: row.id,
    outcome: 'failed',
    code: 'PROVIDER_TASK_FAILED',
  });
  log?.info?.('Video provider task reconciled', { request_id: options.requestId, state: 'failed' });
  return { reservation: settled };
}

function ensureBoundaryFrames(db, log, selector = {}, options = {}) {
  const generationId = Number(selector.video_generation_id || 0);
  const videoUrl = String(selector.video_url || '').trim();
  if (!generationId && !videoUrl) {
    const error = new Error('视频生成记录或视频地址至少提供一项');
    error.code = 'INVALID_VIDEO_SELECTOR';
    throw error;
  }

  const ownerClause = options.billingEnabled
    ? options.tenantId ? ' AND tenant_id = ?' : ' AND user_id = ?'
    : '';
  const ownerParams = options.billingEnabled
    ? [options.tenantId || options.userId || '']
    : [];
  let row = null;
  if (generationId) {
    row = db.prepare(
      `SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL${ownerClause}`
    ).get(generationId, ...ownerParams);
  } else {
    const rows = db.prepare(
      `SELECT * FROM video_generations WHERE deleted_at IS NULL${ownerClause} ORDER BY id DESC`
    ).all(...ownerParams);
    row = rows.find((item) => {
      const localUrl = item.local_path
        ? `/static/${String(item.local_path).replace(/\\/g, '/').replace(/^\/+/, '')}`
        : '';
      return item.video_url === videoUrl || localUrl === videoUrl;
    }) || null;
  }

  if (!row) {
    const error = new Error('视频生成记录不存在或无权访问');
    error.code = 'VIDEO_NOT_FOUND';
    throw error;
  }
  if (row.output_last_frame_url) return rowToItem(row);
  if (row.status !== 'completed' || !row.local_path) {
    const error = new Error('视频尚未完成本地保存，暂时无法提取尾帧');
    error.code = 'VIDEO_NOT_READY';
    throw error;
  }

  const storagePath = options.storagePath || resolveStoragePath(require('../config').loadConfig());
  const frames = extractVideoBoundaryFrames(
    storagePath,
    row.local_path,
    row.id,
    log,
    options.extractionOptions || {}
  );
  if (!frames.output_last_frame_url) {
    const error = new Error('尾帧提取失败，请确认服务器视频文件和 FFmpeg 可用');
    error.code = 'VIDEO_FRAME_EXTRACTION_FAILED';
    throw error;
  }

  db.prepare(
    'UPDATE video_generations SET output_first_frame_url = ?, output_last_frame_url = ?, updated_at = ? WHERE id = ?'
  ).run(
    frames.output_first_frame_url || row.output_first_frame_url || null,
    frames.output_last_frame_url,
    new Date().toISOString(),
    row.id
  );
  return getById(db, row.id, options);
}

/** 防止同一 videoGenId 重复发起 poll（含重启恢复） */
const activeVideoPolls = new Set();

function resolveStoragePath(cfg) {
  return path.isAbsolute(cfg.storage?.local_path)
    ? cfg.storage.local_path
    : path.join(process.cwd(), cfg.storage?.local_path || './data/storage');
}

function isPinnedNativeAudioGeneration(row) {
  if (Number(row?.generate_audio) !== 1) return false;
  const parsed = parseRequestSnapshotForProcessing(row.request_snapshot);
  if (!parsed.valid || parsed.snapshot?.generate_audio !== true) return false;
  const snapshot = parsed.snapshot;
  return !!(
    snapshot.locale_pack
    && /^[0-9a-f]{64}$/.test(String(snapshot.prompt_hash || ''))
    && /^[0-9a-f]{64}$/.test(String(snapshot.dialogue_snapshot_hash || ''))
    && snapshot.config_updated_at
    && Number(snapshot.ai_service_config_id) === Number(row.ai_service_config_id)
    && String(snapshot.model || '') === String(row.model || '')
  );
}

function compactDownloadFailureMessage(error) {
  const raw = String(error?.message || error || '视频成片下载或保存失败，请人工确认后处理');
  return raw
    .replace(/https?:\/\/[^\s"'<>]+/g, '[url]')
    .replace(/[A-Za-z]:\\[^\s"'<>]+/g, '[path]')
    .slice(0, 500);
}

async function finalizeSuccessfulVideo(db, log, videoGenId, row, rowForAspect, videoUrl, logLabel, providerConfig) {
  const now = new Date().toISOString();
  let localPath = null;
  let downloadError = null;
  let downloadIndeterminate = false;
  let boundaryFrames = {
    output_first_frame_url: null,
    output_last_frame_url: null,
  };
  try {
    const cfg = require('../config').loadConfig();
    const storagePath = resolveStoragePath(cfg);
    const projectSubdir = storageLayout.getProjectStorageSubdir(db, row.drama_id);
    const fetchOptions = videoClient.getVideoArtifactFetchOptions(providerConfig, videoUrl);
    const downloaded = await downloadVideoToLocal(
      storagePath,
      videoUrl,
      videoGenId,
      log,
      projectSubdir,
      fetchOptions
    );
    localPath = downloaded.localPath;
    downloadError = downloaded.error || null;
    downloadIndeterminate = downloaded.indeterminate === true;
    if (!localPath && !downloadError) downloadError = '视频成片下载或保存失败，请人工确认后处理';
    if (localPath) {
      maybeNormalizeVideoAfterDownload(storagePath, localPath, rowForAspect, videoGenId, log);
      boundaryFrames = extractVideoBoundaryFrames(storagePath, localPath, videoGenId, log);
    }
  } catch (error) {
    downloadError = compactDownloadFailureMessage(error);
  }
  if (!localPath) {
    const message = `${downloadError || '供应商视频链接暂时不可读取（结果未知）'}，请勿重新提交，等待管理员核对`;
    if (isPinnedNativeAudioGeneration(row)) {
      const nativeAudioMessage = `${NATIVE_AUDIO_DOWNLOAD_FAILURE_CODE}: ${compactDownloadFailureMessage(downloadError)}`.slice(0, 500);
      setVideoGenNeedsAttention(db, videoGenId, row.task_id, nativeAudioMessage, now);
      markVideoCostUnknown(db, log, row);
      log.error('Native audio video artifact download failed after provider completion', { id: videoGenId });
      return false;
    }
    if (downloadIndeterminate || markVideoArtifactUnreadable(db, videoGenId)) {
      setVideoGenNeedsAttention(db, videoGenId, row.task_id, message, now);
      markVideoCostUnknown(db, log, row);
      log.warn('Video artifact unreadable; request held for review', { id: videoGenId });
      return false;
    }
    setVideoGenFailed(db, videoGenId, message, now);
    if (row.task_id) taskService.updateTaskError(db, row.task_id, message);
    log.error('Video generation failed before completion', { id: videoGenId, error: message });
    return false;
  }
  const deliveryWarning = localVideoDeliveryWarning(localPath);
  try {
    db.prepare(
      'UPDATE video_generations SET status = ?, video_url = ?, local_path = ?, output_first_frame_url = ?, output_last_frame_url = ?, error_msg = ?, completed_at = ?, updated_at = ? WHERE id = ?'
    ).run(
      'completed',
      videoUrl,
      localPath,
      boundaryFrames.output_first_frame_url,
      boundaryFrames.output_last_frame_url,
      deliveryWarning || null,
      now,
      now,
      videoGenId
    );
  } catch (e) {
    if ((e.message || '').includes('completed_at')) {
      db.prepare(
        'UPDATE video_generations SET status = ?, video_url = ?, local_path = ?, error_msg = ?, updated_at = ? WHERE id = ?'
      ).run('completed', videoUrl, localPath, deliveryWarning || null, now, videoGenId);
    } else if ((e.message || '').includes('error_msg')) {
      db.prepare(
        'UPDATE video_generations SET status = ?, video_url = ?, local_path = ?, completed_at = ?, updated_at = ? WHERE id = ?'
      ).run('completed', videoUrl, localPath, now, now, videoGenId);
    } else throw e;
  }
  if (row.storyboard_id) {
    try {
      db.prepare('UPDATE storyboards SET video_url = ?, local_path = ?, updated_at = ? WHERE id = ?').run(
        videoUrl, localPath, now, row.storyboard_id
      );
      log.info('Updated storyboard video' + (logLabel ? ` (${logLabel})` : ''), {
        storyboard_id: row.storyboard_id,
        video_url: videoUrl,
      });
    } catch (_) {}
  }
  if (row.task_id) {
    taskService.updateTaskResult(db, row.task_id, {
      video_generation_id: videoGenId,
      video_url: videoUrl,
      local_path: localPath,
      ...boundaryFrames,
      status: 'completed',
    });
  }
  markVideoArtifactVerified(db, videoGenId);
  settleVideoCredit(db, log, row, 'completed');
  log.info('Video generation completed' + (logLabel ? ` (${logLabel})` : ''), {
    id: videoGenId,
    video_url: videoUrl,
    local_path: localPath,
  });
  return true;
}

async function pollToapisWan3Task(config, providerTaskId, runtime = {}) {
  const intervalMs = Number.isFinite(Number(runtime.wan3PollIntervalMs))
    ? Math.max(0, Number(runtime.wan3PollIntervalMs))
    : 10000;
  let maxAttempts = Number(runtime.wan3PollMaxAttempts);
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    const cfg = require('../config').loadConfig();
    const { resolveVideoGenerationTimeoutMinutes } = require('../config/videoGeneration');
    maxAttempts = Math.max(
      1,
      Math.ceil((resolveVideoGenerationTimeoutMinutes(cfg) * 60 * 1000) / Math.max(1, intervalMs)),
    );
  }
  let lastError = '';
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await toapisWan3VideoClient.fetchToapisWan3Task(config, providerTaskId, {
      fetchImpl: runtime.fetchImpl,
      apiKey: runtime.wan3ApiKey,
    });
    if (result?.state === 'completed' && result.videoUrl) return { video_url: result.videoUrl };
    if (result?.state === 'failed' && result.terminalFailure === true) {
      return {
        error: result.error || 'ToAPIs Wan 3.0 视频生成失败',
        failureDisposition: 'refund',
        failureCategory: 'provider_task_failed',
      };
    }
    lastError = String(result?.error || '').trim();
    if (attempt + 1 < maxAttempts && intervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return {
    indeterminate: true,
    error: lastError || 'ToAPIs Wan 3.0 任务仍可能处理中，最终状态未知，请勿重新提交',
  };
}

async function pollProviderTaskAndFinalize(
  db,
  log,
  videoGenId,
  row,
  rowForAspect,
  providerTaskId,
  config,
  runtime = {},
) {
  const cfg = require('../config').loadConfig();
  const POLL_INTERVAL_MS = 10000;
  const { resolveVideoGenerationTimeoutMinutes } = require('../config/videoGeneration');
  const generationTimeoutMinutes = resolveVideoGenerationTimeoutMinutes(cfg);
  const pollMaxAttempts = Math.max(
    1,
    Math.ceil((generationTimeoutMinutes * 60 * 1000) / POLL_INTERVAL_MS)
  );
  const pollResult = isToapisWan3VideoConfig(config)
    ? await pollToapisWan3Task(config, providerTaskId, runtime)
    : await videoClient.pollVideoTask(
        db,
        log,
        videoGenId,
        providerTaskId,
        config,
        pollMaxAttempts,
        POLL_INTERVAL_MS
      );
  const now = new Date().toISOString();
  const polledVideo = resolveRemoteVideoUrl(pollResult.video_url, pollResult.error);
  if (polledVideo.ok) {
    await finalizeSuccessfulVideo(
      db,
      log,
      videoGenId,
      row,
      rowForAspect,
      polledVideo.video_url,
      'after poll',
      config
    );
  } else if (pollResult.indeterminate) {
    const message = String(pollResult.error || '供应商任务仍可能处理中，请勿重新提交').slice(0, 500);
    db.transaction(() => {
      setVideoGenNeedsAttention(db, videoGenId, row.task_id, message, now);
      if (isToapisWan3VideoConfig(config)) {
        markVideoRouteNeedsAttention(db, videoGenId, 'result_unknown', now);
      }
    })();
    markVideoCostUnknown(db, log, row);
    log.warn('Video generation final status indeterminate; duplicate guard remains active', {
      id: videoGenId,
      provider_task_id: providerTaskId,
    });
  } else {
    db.transaction(() => {
      setVideoGenFailed(db, videoGenId, polledVideo.error, now, {
        failureDisposition: pollResult.failureDisposition || 'refund',
        category: pollResult.failureCategory || 'provider_task_failed',
      });
      if (row.task_id) taskService.updateTaskError(db, row.task_id, polledVideo.error);
      if (isToapisWan3VideoConfig(config)) {
        markVideoRouteFailed(
          db,
          videoGenId,
          pollResult.failureCategory || 'provider_task_failed',
          now,
        );
      }
    })();
    log.error('Video generation failed (after poll)', { id: videoGenId, error: polledVideo.error });
  }
}

/**
 * 服务重启后恢复对厂商异步任务的轮询（需已持久化 provider_task_id）
 */
async function resumePollForVideoGeneration(db, log, videoGenId, runtime = {}) {
  if (activeVideoPolls.has(videoGenId)) {
    log.info('Video poll already active, skip resume', { videoGenId });
    return;
  }
  const row = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(videoGenId));
  if (!row || row.status !== 'processing') return;
  const providerTaskId = row.provider_task_id && String(row.provider_task_id).trim();
  if (!providerTaskId) return;

  const config = processingVideoConfig(
    db,
    row.model,
    row.ai_service_config_id || row.config_id,
    runtime.evidenceRoots,
  );
  if (!config) {
    setVideoGenNeedsAttention(
      db,
      videoGenId,
      row.task_id,
      '固定模型配置暂不可用，已保留供应商任务 ID；请恢复固定配置后人工继续查询，请勿重新提交',
      new Date().toISOString(),
    );
    return;
  }
  try {
    assertPinnedVideoConfig(row, config);
  } catch (error) {
    setVideoGenNeedsAttention(db, videoGenId, row.task_id, `${error.message}；已提交任务状态未知，请勿重新提交`, new Date().toISOString());
    return;
  }

  activeVideoPolls.add(videoGenId);
  log.info('Resuming video generation poll after restart', {
    videoGenId,
    provider_task_id: providerTaskId,
  });
  try {
    let aspectForVideo = row.aspect_ratio;
    if (aspectForVideo) {
      const n = videoClient.normalizeAspectRatioForApi(aspectForVideo);
      if (n) aspectForVideo = n;
    }
    const rowForAspect = { ...row, aspect_ratio: aspectForVideo || row.aspect_ratio };
    await pollProviderTaskAndFinalize(db, log, videoGenId, row, rowForAspect, providerTaskId, config, runtime);
  } catch (err) {
    const now = new Date().toISOString();
    setVideoGenNeedsAttention(db, videoGenId, row.task_id, `供应商任务恢复轮询异常，最终状态未知，请勿重新提交：${err.message}`, now);
    log.error('Video generation resume poll indeterminate', { id: videoGenId, error: err.message });
  } finally {
    activeVideoPolls.delete(videoGenId);
  }
}

/** 启动时恢复 processing 视频任务；无 provider_task_id 的视为中断 */
function resumeProcessingVideoGenerations(db, log, runtime = {}) {
  const indeterminate = db
    .prepare(
      `SELECT id, task_id, error_msg FROM video_generations
       WHERE status = 'processing' AND deleted_at IS NULL
         AND (provider_task_id IS NULL OR TRIM(provider_task_id) = '')
         AND error_msg LIKE 'VIDEO_SUBMISSION_INDETERMINATE:%'`
    )
    .all();
  for (const s of indeterminate) {
    setVideoGenNeedsAttention(db, s.id, s.task_id, s.error_msg, new Date().toISOString());
    log.warn('Video generation submission indeterminate; keep for manual reconciliation', { videoGenId: s.id });
  }
  const stuck = db
    .prepare(
      `SELECT id, task_id FROM video_generations
       WHERE status = 'processing' AND deleted_at IS NULL
         AND (provider_task_id IS NULL OR TRIM(provider_task_id) = '')`
        + ` AND (error_msg IS NULL OR error_msg NOT LIKE 'VIDEO_SUBMISSION_INDETERMINATE:%')`
    )
    .all();
  const stuckMsg = '服务重启后无法恢复轮询（缺少厂商任务 ID），请重新生成';
  for (const s of stuck) {
    const now = new Date().toISOString();
    const claimed = getVideoRouteAttempt(db, s.id);
    if (claimed?.query_protocol === 'toapis_wan3_video') {
      db.transaction(() => {
        setVideoGenNeedsAttention(
          db,
          s.id,
          s.task_id,
          'Wan3 提交可能已发出但缺少供应商任务 ID，请人工对账；禁止重复提交',
          now,
        );
        markVideoRouteNeedsAttention(db, s.id, 'submission_unknown', now);
      })();
      log.warn('Wan3 interrupted submission requires reconciliation; reservation remains held', {
        videoGenId: s.id,
      });
      continue;
    }
    setVideoGenFailed(db, s.id, stuckMsg, now);
    if (s.task_id) taskService.updateTaskError(db, s.task_id, stuckMsg);
    log.warn('Marked interrupted video generation as failed', { videoGenId: s.id });
  }

  const resumable = db
    .prepare(
      `SELECT id FROM video_generations
       WHERE status = 'processing' AND deleted_at IS NULL
         AND provider_task_id IS NOT NULL AND TRIM(provider_task_id) != ''`
    )
    .all();
  if (resumable.length) {
    log.info('Resuming video generation polls', { count: resumable.length });
  }
  for (const r of resumable) {
    setImmediate(() => {
      resumePollForVideoGeneration(db, log, r.id, runtime).catch((e) => {
        log.error('resumePollForVideoGeneration unhandled', { videoGenId: r.id, error: e.message });
      });
    });
  }
}

async function processVideoGeneration(db, log, videoGenId, runtime = {}) {
  if (activeVideoPolls.has(videoGenId)) {
    log.info('Video generation already in progress, skip duplicate', { videoGenId });
    return;
  }
  activeVideoPolls.add(videoGenId);
  log.info('processVideoGeneration started', { videoGenId });
  const row = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(videoGenId));
  if (!row) {
    activeVideoPolls.delete(videoGenId);
    log.error('Video generation not found', { id: videoGenId });
    return;
  }
  const now = new Date().toISOString();
  let providerSubmissionStarted = false;
  let knownProviderTaskId = row.provider_task_id && String(row.provider_task_id).trim();
  let wan3Submission = null;
  try {
    db.prepare('UPDATE video_generations SET status = ?, updated_at = ? WHERE id = ?').run('processing', now, videoGenId);
    if (row.task_id) {
      const task = taskService.getTask(db, row.task_id);
      if (task?.status === 'pending') {
        taskService.updateTaskStatus(db, row.task_id, 'processing', 1, '正在提交视频生成任务');
      }
    }
    const loadConfig = require('../config').loadConfig;
    const cfg = loadConfig();
    const filesBaseUrl = (cfg.storage && cfg.storage.base_url) ? String(cfg.storage.base_url).replace(/\/$/, '') : '';
    const storageLocalPath = path.isAbsolute(cfg.storage?.local_path)
      ? cfg.storage.local_path
      : path.join(process.cwd(), cfg.storage?.local_path || './data/storage');
    const existingProviderTaskId = knownProviderTaskId;
    const config = processingVideoConfig(db, row.model, row.ai_service_config_id || row.config_id, runtime.evidenceRoots);
    if (!config) {
      if (existingProviderTaskId) {
        keepVideoProcessing(db, row, videoGenId, '视频模型配置暂不可用，已保留供应商任务 ID，恢复配置后继续查询', now);
      } else if (row.ai_service_config_id) {
        setVideoGenNeedsAttention(db, videoGenId, row.task_id, '固定模型配置暂不可用，请恢复固定配置后人工处理，拒绝供应商提交', now);
      } else {
        setVideoGenFailed(db, videoGenId, '未配置视频模型', now);
        if (row.task_id) taskService.updateTaskError(db, row.task_id, '未配置视频模型');
      }
      return;
    }
    let pinnedCapability = null;
    try {
      pinnedCapability = assertPinnedVideoConfig(row, config);
    } catch (error) {
      setVideoGenNeedsAttention(db, videoGenId, row.task_id, `${error.message}；拒绝供应商提交`, now);
      return;
    }
    const parsedSnapshot = parseRequestSnapshotForProcessing(row.request_snapshot);
    if (!existingProviderTaskId && !parsedSnapshot.valid) {
      keepVideoProcessing(db, row, videoGenId, 'VIDEO_SUBMISSION_INDETERMINATE: request_snapshot 损坏或格式非法，请人工对账后处理', now);
      log.warn('Video generation request_snapshot invalid; supplier submit skipped', { id: videoGenId });
      return;
    }
    const snapshot = parsedSnapshot.snapshot;
    const snapshotHas = (key) => Object.prototype.hasOwnProperty.call(snapshot, key);
    let reference_urls = snapshotHas('reference_image_urls')
      ? cleanUrlList(Array.isArray(snapshot.reference_image_urls) ? snapshot.reference_image_urls : [])
      : null;
    if (!snapshotHas('reference_image_urls') && row.reference_image_urls) {
      try {
        reference_urls = JSON.parse(row.reference_image_urls);
        if (!Array.isArray(reference_urls)) reference_urls = null;
      } catch (_) {}
    }
    if (Array.isArray(reference_urls)) reference_urls = cleanUrlList(reference_urls);
    let referenceVideoUrls = snapshotHas('reference_video_urls')
      ? cleanUrlList(Array.isArray(snapshot.reference_video_urls) ? snapshot.reference_video_urls : [])
      : cleanUrlList(parseReferenceUrls(row.reference_video_urls), row.reference_video_url);
    if (!existingProviderTaskId && row.source_conditioning_json && referenceVideoUrls.length > 0) {
      let conditioning = null;
      try {
        conditioning = JSON.parse(row.source_conditioning_json);
      } catch (_) {
        throw videoRequestError('REDRAW_SOURCE_CONDITIONING_INVALID', '源片 conditioning 审计记录无效');
      }
      if (String(conditioning?.mode || '') === 'redraw_reference_bundle') {
        conditioning = null;
      }
      if (conditioning) {
        const segmentSha256 = String(conditioning?.segment_sha256 || '').trim().toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(segmentSha256)) {
          throw videoRequestError('REDRAW_SOURCE_CONDITIONING_INVALID', '源片 conditioning 缺少有效 segment hash');
        }
        const signed = redrawSourceConditioningService.createProviderAssetUrl({
          storageBaseUrl: runtime.providerAssetStorageBaseUrl || filesBaseUrl,
          segmentSha256,
          signingSecret: runtime.providerAssetSigningSecret ?? process.env.REDRAW_PROVIDER_ASSET_HMAC_SECRET,
          nowMs: runtime.providerAssetNowMs,
          ttlSeconds: runtime.providerAssetTtlSeconds,
        });
        referenceVideoUrls = [signed.url];
        const refreshedConditioning = {
          ...conditioning,
          provider_asset_path: signed.pathname,
          provider_asset_expires_at: new Date(signed.expiresAt * 1000).toISOString(),
        };
        db.prepare(`UPDATE video_generations
          SET reference_video_urls = ?, reference_video_url = ?, source_conditioning_json = ?, updated_at = ?
          WHERE id = ?`).run(
          JSON.stringify(referenceVideoUrls), referenceVideoUrls[0], JSON.stringify(refreshedConditioning),
          new Date().toISOString(), videoGenId
        );
      }
    }
    const referenceAudioUrls = snapshotHas('reference_audio_urls')
      ? cleanUrlList(Array.isArray(snapshot.reference_audio_urls) ? snapshot.reference_audio_urls : [])
      : cleanUrlList(parseReferenceUrls(row.reference_audio_urls), row.reference_audio_url);
    const toapisPrivateAvatarImages = snapshotHas('_toapis_private_avatar_images')
      && Array.isArray(snapshot._toapis_private_avatar_images)
      ? snapshot._toapis_private_avatar_images
      : [];
    const processingModel = String(snapshot.model ?? row.model ?? '').trim();
    const normalizedProcessingModel = processingModel.toLowerCase();
    const processingAllowedDurations = TOAPIS_VIDEO_MODELS[normalizedProcessingModel]?.durations
      || (normalizedProcessingModel === TOAPIS_WAN3_MODEL
        ? TOAPIS_WAN3_SPEC.durations
        : null)
      || (normalizedProcessingModel === lingjingVideoClient.PUBLIC_MODEL
        ? LINGJING_VIDEO_SPEC.durations
        : null)
      || FEITUO_MODELS[normalizedProcessingModel]?.durations
      || null;
    const processingMinimumDuration = minimumVideoDuration(config.canvas_selected_model || processingModel);
    const effectiveDuration = normalizeVideoDuration(
      snapshot.duration ?? row.duration,
      processingAllowedDurations?.[0] || processingMinimumDuration,
      processingAllowedDurations || processingMinimumDuration,
    );
    const snapshotHasAspectRatio = snapshotHas('aspect_ratio');
    let aspectForVideo = snapshotHasAspectRatio ? snapshot.aspect_ratio : row.aspect_ratio;
    if (aspectForVideo) {
      const n = videoClient.normalizeAspectRatioForApi(aspectForVideo);
      if (n) aspectForVideo = n;
    }
    if (!snapshotHasAspectRatio && !aspectForVideo && row.drama_id) {
      try {
        const dramaRow = db.prepare('SELECT metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(row.drama_id);
        if (dramaRow && dramaRow.metadata) {
          const meta =
            typeof dramaRow.metadata === 'string' ? JSON.parse(dramaRow.metadata) : dramaRow.metadata;
          if (meta && meta.aspect_ratio) {
            aspectForVideo = videoClient.normalizeAspectRatioForApi(meta.aspect_ratio);
          }
        }
      } catch (_) {}
    }
    const rowForAspect = { ...row, aspect_ratio: aspectForVideo };
    if (existingProviderTaskId) {
      await pollProviderTaskAndFinalize(
        db,
        log,
        videoGenId,
        row,
        rowForAspect,
        existingProviderTaskId,
        config,
        runtime,
      );
      return;
    }
    const referenceCount = (reference_urls?.length || 0) + referenceVideoUrls.length + referenceAudioUrls.length;
    const hasOmniRefs = !!(
      (reference_urls && reference_urls.length > 0)
      || referenceVideoUrls.length > 0
      || referenceAudioUrls.length > 0
    );
    if (row.task_id && hasOmniRefs) {
      const task = taskService.getTask(db, row.task_id);
      if (task && (task.status === 'pending' || task.status === 'processing')) {
        taskService.updateTaskStatus(
          db,
          row.task_id,
          'processing',
          5,
          '正在准备参考图、参考视频与参考音频…'
        );
      }
    }
    if (TOAPIS_VIDEO_MODELS[normalizedProcessingModel]) {
      toapisReadyState(db, normalizedProcessingModel, runtime.evidenceRoots);
    }
    let wan3ProcessingState = null;
    if (normalizedProcessingModel === TOAPIS_WAN3_MODEL) {
      wan3ProcessingState = toapisWan3ReadyState(
        db,
        normalizedProcessingModel,
        runtime.evidenceRoots,
        config.id,
      );
      const processingResolution = String(snapshot.resolution ?? row.resolution ?? '').trim().toLowerCase();
      const processingAspectRatio = rowForAspect.aspect_ratio || '16:9';
      const processingGenerateAudio = snapshot.generate_audio ?? (row.generate_audio === 1);
      if (!wan3ProcessingState.durations.includes(effectiveDuration)) {
        throw videoRequestError('INVALID_VIDEO_DURATION', `${normalizedProcessingModel} 尚未验证 ${effectiveDuration} 秒时长`);
      }
      if (!wan3ProcessingState.resolutions.includes(processingResolution)) {
        throw videoRequestError('MODEL_RESOLUTION_PRICE_REQUIRED', `${normalizedProcessingModel} 尚未验证 ${processingResolution} 分辨率`);
      }
      if (!wan3ProcessingState.aspectRatios.includes(processingAspectRatio)) {
        throw videoRequestError('MODEL_NOT_VERIFIED', `${normalizedProcessingModel} 尚未验证 ${processingAspectRatio} 画幅`);
      }
      if (!wan3ProcessingState.audioValues.includes(processingGenerateAudio === true)) {
        throw videoRequestError('MODEL_NOT_VERIFIED', `${normalizedProcessingModel} 尚未验证当前同步音频参数`);
      }
      requireVerifiedToapisReferenceCapabilities(wan3ProcessingState, {
        firstFrameUrl: snapshotField(snapshot, 'first_frame_url', row.first_frame_url),
        lastFrameUrl: snapshotField(snapshot, 'last_frame_url', row.last_frame_url),
        referenceImageUrls: reference_urls || [],
        referenceVideoUrls,
        referenceAudioUrls,
        generateAudio: processingGenerateAudio === true,
      });
    }
    if (normalizedProcessingModel === lingjingVideoClient.PUBLIC_MODEL) {
      lingjingReadyState(db, normalizedProcessingModel, runtime.evidenceRoots);
    }
    if (FEITUO_MODELS[normalizedProcessingModel] && normalizedProcessingModel.startsWith('xuan-')) {
      feituoReadyState(db, normalizedProcessingModel);
    }
    const persistedConfigId = row.ai_service_config_id || row.config_id || null;
    const requestedLogicalModel = String(snapshot.model ?? row.model ?? '').trim().toLowerCase();
    const selectedLogicalModel = String(config.logical_model_id || '').trim().toLowerCase();
    const allowLogicalFailover = !persistedConfigId
      && selectedLogicalModel
      && selectedLogicalModel === requestedLogicalModel;
    const requestPayload = {
      prompt: snapshot.prompt ?? row.prompt,
      model: snapshot.model ?? row.model,
      duration: effectiveDuration,
      aspect_ratio: rowForAspect.aspect_ratio,
      resolution: snapshot.resolution ?? row.resolution,
      seed: snapshot.seed ?? row.seed,
      camera_fixed: snapshot.camera_fixed ?? row.camera_fixed,
      watermark: snapshot.watermark ?? row.watermark,
      provider: row.provider,
      drama_id: row.drama_id,
      storyboard_id: row.storyboard_id || undefined,
      image_url: snapshotField(snapshot, 'image_url', row.image_url),
      first_frame_url: snapshotField(snapshot, 'first_frame_url', row.first_frame_url),
      last_frame_url: snapshotField(snapshot, 'last_frame_url', row.last_frame_url),
      reference_urls,
      reference_video_urls: referenceVideoUrls,
      reference_audio_urls: referenceAudioUrls,
      reference_mode: snapshot.reference_mode ?? row.reference_mode,
      voice_reference_url: referenceAudioUrls[0] || undefined,
      video_url: referenceVideoUrls[0] || undefined,
      generate_audio: snapshot.generate_audio ?? (row.generate_audio === 1),
      _toapis_private_avatar_images: toapisPrivateAvatarImages,
      files_base_url: filesBaseUrl,
      storage_local_path: storageLocalPath,
      video_gen_id: videoGenId,
      ...(allowLogicalFailover ? {} : {
        config_id: config.id,
        ai_service_config_id: config.id,
      }),
      ai_service_config_updated_at: config.updated_at || config.verified_at || null,
      video_capability: pinnedCapability || undefined,
      userId: row.user_id || undefined,
      tenantId: row.tenant_id || undefined,
      creditReservationId: row.credit_reservation_id || undefined,
      provider_asset_expires_at: (() => {
        try { return JSON.parse(row.source_conditioning_json || '{}').provider_asset_expires_at || null; } catch (_) { return null; }
      })(),
    };
    if (wan3ProcessingState) {
      Object.assign(requestPayload, signedWan3SubmissionPayload({
        ...requestPayload,
        client_business_id: `video-${videoGenId}`,
      }));
      const requestBody = toapisWan3VideoClient.buildToapisWan3VideoBody(requestPayload);
      const requestSha256 = createHash('sha256')
        .update(JSON.stringify(requestBody))
        .digest('hex');
      const receipt = prepareWan3SubmissionRoute(
        db,
        row,
        config,
        requestPayload,
        new Date().toISOString(),
      );
      wan3Submission = {
        requestId: receipt.route.id,
        attemptNo: receipt.attempt.attempt_no,
        recoveryTaskId: requestPayload.client_business_id,
        requestSha256,
      };
    }
    providerSubmissionStarted = true;
    const result = wan3ProcessingState
      ? await toapisWan3VideoClient.callToapisWan3VideoApi(config, log, requestPayload, {
          fetchImpl: runtime.fetchImpl,
          apiKey: runtime.wan3ApiKey,
        })
      : await videoClient.callVideoApi(db, log, requestPayload, runtime);
    const now2 = new Date().toISOString();
    if (result.indeterminate) {
      const message = `VIDEO_SUBMISSION_INDETERMINATE: ${String(result.error || '供应商提交结果未知，请人工对账').slice(0, 450)}`;
      db.transaction(() => {
        setVideoGenNeedsAttention(db, videoGenId, row.task_id, message, now2);
        if (wan3Submission) {
          const routeMeta = result.route_meta && typeof result.route_meta === 'object'
            ? result.route_meta
            : {};
          providerRouteStability.recordSubmissionUnknownRecovery(db, {
            ...wan3Submission,
            recoveryTaskId: String(routeMeta.recoveryTaskId || wan3Submission.recoveryTaskId),
            requestBodySent: routeMeta.requestBodySent === true,
            recoveryCode: String(routeMeta.recoveryCode || 'TOAPIS_WAN3_SUBMISSION_INDETERMINATE'),
            httpStatus: routeMeta.httpStatus,
            now: now2,
          });
        }
      })();
      markVideoCostUnknown(db, log, row);
      log.warn('Video submission indeterminate; reservation remains held', { id: videoGenId });
      return;
    }
    if (result.error) {
      const routeMeta = result.route_meta && typeof result.route_meta === 'object'
        ? result.route_meta
        : null;
      const classification = routeMeta ? classifyProviderFailure(routeMeta) : null;
      if (classification && !classification.definitiveNotAccepted) {
        db.transaction(() => {
          setVideoGenNeedsAttention(db, videoGenId, row.task_id, result.error, now2);
          if (wan3Submission) {
            providerRouteStability.recordSubmissionUnknownRecovery(db, {
              ...wan3Submission,
              recoveryTaskId: String(routeMeta.recoveryTaskId || wan3Submission.recoveryTaskId),
              requestBodySent: routeMeta.requestBodySent === true,
              recoveryCode: String(
                routeMeta.recoveryCode
                || routeMeta.providerCode
                || 'TOAPIS_WAN3_SUBMISSION_INDETERMINATE'
              ),
              httpStatus: routeMeta.httpStatus,
              now: now2,
            });
          }
        })();
        markVideoCostUnknown(db, log, row);
        log.warn('Video submission failure is not definitive; reservation remains held', {
          id: videoGenId,
          category: classification.category,
        });
        return;
      }
      db.transaction(() => {
        setVideoGenFailed(db, videoGenId, result.error, now2, classification ? {
          failureDisposition: 'refund',
          category: classification.category,
        } : {});
        if (row.task_id) taskService.updateTaskError(db, row.task_id, result.error);
        if (wan3Submission) {
          markVideoRouteFailed(db, videoGenId, classification?.category || 'provider_rejected', now2);
        }
      })();
      log.error('Video generation failed', { id: videoGenId, error: result.error });
      return;
    }
    const selectedConfig = result.config_id
      ? videoClient.getVideoConfigById(db, result.config_id)
      : config;
    if (!selectedConfig) {
      setVideoGenFailed(db, videoGenId, '已受理视频任务的供应商配置不存在', now2);
      if (row.task_id) taskService.updateTaskError(db, row.task_id, '已受理视频任务的供应商配置不存在');
      return;
    }
    const directVideo = resolveRemoteVideoUrl(result.video_url, result.error);
    if (directVideo.ok) {
      await finalizeSuccessfulVideo(
        db,
        log,
        videoGenId,
        row,
        rowForAspect,
        directVideo.video_url,
        '',
        selectedConfig
      );
      return;
    }
    if (result.video_url) {
      setVideoGenFailed(db, videoGenId, directVideo.error, now2);
      if (row.task_id) taskService.updateTaskError(db, row.task_id, directVideo.error);
      log.error('Video generation failed', { id: videoGenId, error: directVideo.error });
      return;
    }
    if (result.task_id) {
      knownProviderTaskId = String(result.task_id).trim();
      if (wan3ProcessingState) {
        persistWan3AcceptedTaskReceipt(
          db,
          row,
          selectedConfig,
          requestPayload,
          knownProviderTaskId,
          now2,
        );
      } else {
        db.prepare(
          'UPDATE video_generations SET status = ?, provider_task_id = ?, updated_at = ? WHERE id = ?'
        ).run('processing', result.task_id, now2, videoGenId);
      }
      await pollProviderTaskAndFinalize(
        db,
        log,
        videoGenId,
        row,
        rowForAspect,
        result.task_id,
        selectedConfig,
        runtime,
      );
      return;
    }
    db.transaction(() => {
      setVideoGenFailed(db, videoGenId, '未返回 task_id 或 video_url', now2);
      if (row.task_id) taskService.updateTaskError(db, row.task_id, '未返回 task_id 或 video_url');
      if (wan3Submission) markVideoRouteFailed(db, videoGenId, 'provider_invalid_response', now2);
    })();
  } catch (err) {
    const now2 = new Date().toISOString();
    if (err?.code === 'WAN3_SUBMISSION_ALREADY_CLAIMED') {
      const claimed = getVideoRouteAttempt(db, videoGenId);
      db.transaction(() => {
        setVideoGenNeedsAttention(
          db,
          videoGenId,
          row.task_id,
          'Wan3 已存在提交记录且最终状态未知，请人工对账；禁止重复提交',
          now2,
        );
        markVideoRouteNeedsAttention(db, videoGenId, 'submission_unknown', now2);
      })();
      log.warn('Wan3 submission already claimed; duplicate supplier POST skipped', {
        id: videoGenId,
        route_state: claimed?.route_state || err.routeState || null,
        attempt_state: claimed?.attempt_state || err.attemptState || null,
      });
      return;
    }
    if (providerSubmissionStarted) {
      const message = `供应商提交后状态未知，请人工对账：${String(err?.message || err).slice(0, 420)}`;
      if (knownProviderTaskId) {
        db.transaction(() => {
          db.prepare('UPDATE video_generations SET status = ?, provider_task_id = ?, error_msg = ?, updated_at = ? WHERE id = ?')
            .run('needs_attention', knownProviderTaskId, message, now2, videoGenId);
          if (row && row.task_id) taskService.updateTaskStatus(db, row.task_id, 'needs_attention', 90, message);
          if (wan3Submission) markVideoRouteNeedsAttention(db, videoGenId, 'result_unknown', now2);
        })();
      } else if (wan3Submission) {
        db.transaction(() => {
          setVideoGenNeedsAttention(db, videoGenId, row.task_id, message, now2);
          providerRouteStability.recordSubmissionUnknownRecovery(db, {
            ...wan3Submission,
            requestBodySent: true,
            recoveryCode: 'TOAPIS_WAN3_POST_SUBMIT_EXCEPTION',
            httpStatus: null,
            now: now2,
          });
        })();
      } else {
        db.prepare('UPDATE video_generations SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?')
          .run('needs_attention', message, now2, videoGenId);
        if (row && row.task_id) taskService.updateTaskStatus(db, row.task_id, 'needs_attention', 90, message);
      }
      log.error('Video generation post-submit state unknown; reservation remains held', {
        id: videoGenId,
        provider_task_id: knownProviderTaskId || null,
        error: err.message,
      });
      return;
    }
    setVideoGenFailed(db, videoGenId, err.message, now2);
    if (row && row.task_id) taskService.updateTaskError(db, row.task_id, err.message);
    log.error('Video generation error', { id: videoGenId, error: err.message });
  } finally {
    activeVideoPolls.delete(videoGenId);
  }
}

function deleteById(db, log, id, options = {}) {
  const now = new Date().toISOString();
  const ownerClause = options.billingEnabled
    ? options.tenantId ? ' AND tenant_id = ?' : ' AND user_id = ?'
    : '';
  const ownerParams = options.billingEnabled
    ? [Number(id), options.tenantId || options.userId || '']
    : [Number(id)];
  const result = db.prepare('UPDATE video_generations SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL' + ownerClause).run(now, ...ownerParams);
  return result.changes > 0;
}

/**
 * 素材库视频复用：把已有视频（素材库/本地文件）直接挂到分镜作为成片。
 * 插入 status='completed' 的 video_generations 行（provider='library'），不走计费、不生成任务。
 * 画布视频节点按 storyboard_id 取最新 completed，即显示该视频。
 */
function attach(db, log, body) {
  const storyboardId = Number(body.storyboard_id);
  if (!storyboardId) throw new Error('storyboard_id 必填');
  const sb = db.prepare('SELECT id, episode_id FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(storyboardId);
  if (!sb) throw new Error('分镜不存在');
  const videoUrl = String(body.video_url || '').trim();
  const localPath = String(body.local_path || '').trim();
  if (!videoUrl && !localPath) throw new Error('video_url / local_path 至少提供一个');
  const dramaId = Number(body.drama_id) || null;
  const now = new Date().toISOString();
  const info = db.prepare(`INSERT INTO video_generations
    (drama_id, storyboard_id, provider, prompt, model, duration, video_url, local_path, status, completed_at, created_at, updated_at)
    VALUES (?, ?, 'library', ?, 'library-reuse', ?, ?, ?, 'completed', ?, ?, ?)`).run(
      dramaId,
      storyboardId,
      body.prompt || '素材库复用',
      body.duration ?? null,
      videoUrl || null,
      localPath || null,
      now,
      now,
      now
    );
  const id = info.lastInsertRowid;
  try {
    db.prepare('UPDATE storyboards SET video_url = ?, updated_at = ? WHERE id = ?')
      .run(videoUrl || ('/static/' + localPath.replace(/^\/static\//, '')), now, storyboardId);
  } catch (_) {
    // 历史库列不一致时忽略；video_generations 仍保留可读取成片。
  }
  log?.info?.('[Library] 视频复用到分镜', { storyboard_id: storyboardId, video_gen_id: id });
  return getById(db, id);
}
module.exports = {
  NATIVE_AUDIO_DOWNLOAD_FAILURE_CODE,
  list,
  getById,
  create,
  attach,
  findActiveForStoryboard,
  deleteById,
  processVideoGeneration,
  resumeProcessingVideoGenerations,
  localVideoDeliveryWarning,
  settleVideoCredit,
  targetVideoPixelsForAspect,
  shouldNormalizeVideoAfterDownload,
  extractVideoBoundaryFrames,
  prepareReconciledVideoArtifact,
  discardReconciledVideoArtifact,
  applyReconciledVideoSuccess,
  applyReconciledVideoFailure,
  ensureBoundaryFrames,
};
