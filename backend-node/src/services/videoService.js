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
function setVideoGenFailed(db, videoGenId, errorMsg, now) {
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
  settleVideoCredit(db, null, row, 'failed', errorMsg);
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

function parseReferenceUrls(value, fallback = null) {
  if (value) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item || '').trim()).filter(Boolean);
    } catch (_) {}
  }
  const single = String(fallback || '').trim();
  return single ? [single] : [];
}

function normalizeReferenceUrls(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
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
    reference_video_urls: parseReferenceUrls(r.reference_video_urls, r.reference_video_url),
    reference_audio_urls: parseReferenceUrls(r.reference_audio_urls, r.reference_audio_url),
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
     WHERE storyboard_id = ? AND status IN ('pending', 'processing') AND deleted_at IS NULL${ownerClause}
     ORDER BY created_at DESC, id DESC LIMIT 1`
  ).get(...params) || null;
}

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { randomUUID } = require('crypto');
const videoClient = require('./videoClient');
const fuminVideoClient = require('./fuminVideoClient');
const taskService = require('./taskService');
const storageLayout = require('./storageLayout');
const creditLedger = require('./creditLedgerService');
const generationCost = require('./generationCostLedgerService');
const modelPrice = require('./modelPriceService');
const auditEvent = require('./auditEventService');
const voicePrompt = require('./storyboardVoicePromptService');
const providerRouteStability = require('./providerRouteStabilityService');
const { classifyProviderFailure } = require('./providerErrorClassifier');
const { getFfmpegPath, hasLocalFfmpeg } = require('../utils/ffmpegPath');

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

function settleVideoCredit(db, log, row, outcome, message = '') {
  if (!row?.credit_reservation_id) return null;
  try {
    const settled = creditLedger.settleGeneration(db, row.credit_reservation_id, outcome, message);
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

function getVideoRouteAttempt(db, videoGenId) {
  try {
    return db.prepare(`SELECT r.id AS request_id, r.logical_model_id, r.tenant_id,
        a.attempt_no, a.config_id
      FROM generation_route_requests r
      JOIN generation_route_attempts a ON a.request_id = r.id
      WHERE r.business_type = 'video_generation' AND r.business_id = ?
      ORDER BY a.attempt_no DESC LIMIT 1`).get(String(videoGenId)) || null;
  } catch (_) {
    return null;
  }
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

function normalizeVideoDuration(value, fallback = 5) {
  const duration = value == null || value === '' ? Number(fallback) : Number(value);
  if (!Number.isSafeInteger(duration) || duration < 5 || duration > 15) {
    const error = new Error('视频时长必须是 5 到 15 秒之间的整数');
    error.code = 'INVALID_VIDEO_DURATION';
    throw error;
  }
  return duration;
}

function configuredVideoDuration(config) {
  if (!config?.settings) return null;
  try {
    const settings = typeof config.settings === 'string' ? JSON.parse(config.settings) : config.settings;
    const duration = Number(settings?.video_duration);
    return Number.isSafeInteger(duration) && duration >= 5 && duration <= 15 ? duration : null;
  } catch (_) {
    return null;
  }
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
  const videoConfig = videoClient.getDefaultVideoConfig(db, selectedModel);
  const storyboardDuration = Number(storyboardDefaults?.duration);
  const fallbackDuration = Number.isSafeInteger(storyboardDuration) && storyboardDuration >= 5 && storyboardDuration <= 15
    ? storyboardDuration
    : configuredVideoDuration(videoConfig) || 5;
  const duration = normalizeVideoDuration(body.duration, fallbackDuration);

  // fumin 的媒体数量和参数必须在创建任务、预扣积分前校验，避免异步提交阶段才失败。
  const videoProtocol = String(videoConfig?.api_protocol || videoConfig?.provider || '').trim().toLowerCase();
  if (videoProtocol === 'fumin_video' || videoProtocol === 'fumin') {
    fuminVideoClient.buildFuminVideoBody({
      model: selectedModel || videoConfig?.default_model || videoConfig?.model,
      prompt: body.prompt,
      duration,
      aspect_ratio: body.aspect_ratio || '16:9',
      resolution: body.resolution || '480p',
      image_url: body.image_url,
      first_frame_url: body.first_frame_url ?? body.first_frame_local_path,
      last_frame_url: body.last_frame_url ?? body.last_frame_local_path,
      reference_urls: Array.isArray(body.reference_image_urls) ? body.reference_image_urls : [],
      reference_video_urls: [
        body.reference_video_url,
        ...(Array.isArray(body.reference_video_urls) ? body.reference_video_urls : []),
      ],
      reference_audio_urls: [
        body.reference_audio_url,
        ...(Array.isArray(body.reference_audio_urls) ? body.reference_audio_urls : []),
      ],
      watermark: body.watermark,
      seed: body.seed,
      guidance_scale: body.guidance_scale,
    });
  }

  const active = findActiveForStoryboard(db, storyboardId, {
    billingEnabled,
    userId: options.userId,
    tenantId: options.tenantId,
  });
  if (active) {
    if (Number(active.duration) !== duration) {
      const error = new Error(`该分镜已有 ${active.duration} 秒视频正在生成，请完成后再更改时长`);
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

  let billingModel = selectedModel;
  let price = null;
  if (billingEnabled) {
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

  const persistedPrompt = storyboardId
    ? voicePrompt.ensureStoryboardVoicePrompt(db, storyboardId)
    : null;
  const storyboardPrompt = String(persistedPrompt || storyboardDefaults?.video_prompt || '').trim();

  const now = new Date().toISOString();
  const result = db.transaction(() => {
    const task = taskService.createTask(db, log, 'video_generation', String(dramaId || ''));
    if (billingEnabled && options.tenantId) {
      db.prepare('UPDATE async_tasks SET tenant_id = ?, user_id = ? WHERE id = ?')
        .run(options.tenantId, options.userId, task.id);
    }
    let prompt = String(body.prompt ?? '').trim();
    if (!prompt) prompt = storyboardPrompt;
    const style = String(body.style || '').trim();
    if (style && !String(prompt).toLowerCase().includes(style.toLowerCase())) {
      prompt = prompt ? `${prompt}. Style: ${style}` : `Style: ${style}`;
    }
    const model = selectedModel || videoConfig?.default_model || null;
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
    const referenceImageUrls = Array.isArray(body.reference_image_urls) ? body.reference_image_urls.slice(0, 10) : [];
    const refs = Array.isArray(body.reference_image_urls) ? JSON.stringify(referenceImageUrls) : null;
    const firstReferenceFallback = ['usmercari', 'usmercari_media'].includes(videoProtocol)
      ? null
      : referenceImageUrls[0] || null;
    const persistedFirstFrameUrl = body.first_frame_url
      ?? body.first_frame_local_path
      ?? body.image_url
      ?? firstReferenceFallback;
    const referenceVideoUrls = normalizeReferenceUrls([
      body.reference_video_url,
      ...(Array.isArray(body.reference_video_urls) ? body.reference_video_urls : []),
    ]);
    const referenceAudioUrls = normalizeReferenceUrls([
      body.reference_audio_url,
      ...(Array.isArray(body.reference_audio_urls) ? body.reference_audio_urls : []),
    ]);
    const referenceVideoUrl = referenceVideoUrls[0] || null;
    const referenceAudioUrl = referenceAudioUrls[0] || null;
    const referenceVideoUrlsJson = referenceVideoUrls.length ? JSON.stringify(referenceVideoUrls) : null;
    const referenceAudioUrlsJson = referenceAudioUrls.length ? JSON.stringify(referenceAudioUrls) : null;
    db.prepare(`INSERT INTO video_generations
      (drama_id, storyboard_id, provider, prompt, model, duration, aspect_ratio, resolution, seed, camera_fixed, watermark,
       image_url, first_frame_url, last_frame_url, reference_image_urls, reference_video_url, reference_audio_url,
       reference_video_urls, reference_audio_urls,
       status, task_id, tenant_id, user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?, ?)`)
      .run(
        dramaId, storyboardId, body.provider || 'chatfire', prompt, billingModel || model, duration,
        aspectRatio, body.resolution ?? null, body.seed != null ? Number(body.seed) : null,
        body.camera_fixed != null ? (body.camera_fixed ? 1 : 0) : null, body.watermark ? 1 : 0,
        body.image_url ?? null, persistedFirstFrameUrl,
        body.last_frame_url ?? body.last_frame_local_path ?? null, refs, referenceVideoUrl, referenceAudioUrl,
        referenceVideoUrlsJson, referenceAudioUrlsJson, task.id,
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
        resolution: body.resolution,
        usageSource: 'configured',
      });
      db.prepare('UPDATE video_generations SET credit_reservation_id = ? WHERE id = ?').run(reservation.id, id);
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
  schedule(() => processVideoGeneration(db, log, result.id));
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
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ext = (videoUrl.split('?')[0].match(/\.(mp4|webm|mov)$/i) || [])[1] || 'mp4';
    const name = `vg_${videoGenId}_${randomUUID().slice(0, 8)}.${ext}`;
    const filePath = path.join(dir, name);
    const res = await fetch(videoUrl, { method: 'GET', ...fetchOptions });
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
    fs.writeFileSync(filePath, buf);
    const relativePath = `${relPrefix}/${name}`.replace(/\\/g, '/');
    log.info('Video saved to local', { videoGenId, local_path: relativePath, projectSubdir: projectSubdir || '(root)' });
    return { localPath: relativePath };
  } catch (e) {
    log.warn('Download video error', { videoGenId, error: e.message });
    return {
      localPath: null,
      indeterminate: true,
      error: '供应商视频链接暂时不可读取（结果未知）',
    };
  }
}

/** 与图生 aspectRatioToSize 对齐的归一化分辨率（偶数像素，便于 H.264） */
function targetVideoPixelsForAspect(aspectRatio) {
  const r = String(aspectRatio || '16:9').trim();
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

function maybeNormalizeVideoAfterDownload(storagePath, localPath, row, videoGenId, log) {
  if (!localPath) return;
  const abs = path.join(storagePath, localPath);
  const dim = targetVideoPixelsForAspect(row.aspect_ratio);
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
    maybeNormalizeVideoAfterDownload(storagePath, localPath, rowForAspect, videoGenId, log);
    boundaryFrames = extractVideoBoundaryFrames(storagePath, localPath, videoGenId, log);
  } catch (error) {
    downloadError = error?.message || '视频产物下载或校验失败';
  }
  if (!localPath) {
    const message = `${downloadError || '供应商视频链接暂时不可读取（结果未知）'}，请勿重新提交，等待管理员核对`;
    if (downloadIndeterminate || markVideoArtifactUnreadable(db, videoGenId)) {
      db.prepare('UPDATE video_generations SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?')
        .run('processing', message.slice(0, 500), now, videoGenId);
      if (row.task_id) taskService.updateTaskStatus(db, row.task_id, 'processing', 90, message);
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

async function pollProviderTaskAndFinalize(db, log, videoGenId, row, rowForAspect, providerTaskId, config) {
  const cfg = require('../config').loadConfig();
  const POLL_INTERVAL_MS = 10000;
  const { resolveVideoGenerationTimeoutMinutes } = require('../config/videoGeneration');
  const generationTimeoutMinutes = resolveVideoGenerationTimeoutMinutes(cfg);
  const pollMaxAttempts = Math.max(
    1,
    Math.ceil((generationTimeoutMinutes * 60 * 1000) / POLL_INTERVAL_MS)
  );
  const pollResult = await videoClient.pollVideoTask(
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
    db.prepare('UPDATE video_generations SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?')
      .run('processing', message, now, videoGenId);
    if (row.task_id) taskService.updateTaskStatus(db, row.task_id, 'processing', 90, message);
    log.warn('Video generation final status indeterminate; duplicate guard remains active', {
      id: videoGenId,
      provider_task_id: providerTaskId,
    });
  } else {
    setVideoGenFailed(db, videoGenId, polledVideo.error, now);
    if (row.task_id) taskService.updateTaskError(db, row.task_id, polledVideo.error);
    log.error('Video generation failed (after poll)', { id: videoGenId, error: polledVideo.error });
  }
}

/**
 * 服务重启后恢复对厂商异步任务的轮询（需已持久化 provider_task_id）
 */
async function resumePollForVideoGeneration(db, log, videoGenId) {
  if (activeVideoPolls.has(videoGenId)) {
    log.info('Video poll already active, skip resume', { videoGenId });
    return;
  }
  const row = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(videoGenId));
  if (!row || row.status !== 'processing') return;
  const providerTaskId = row.provider_task_id && String(row.provider_task_id).trim();
  if (!providerTaskId) return;

  const config = row.config_id
    ? videoClient.getVideoConfigById(db, row.config_id)
    : videoClient.getDefaultVideoConfig(db, row.model);
  if (!config) {
    const now = new Date().toISOString();
    setVideoGenFailed(db, videoGenId, '未配置视频模型', now);
    if (row.task_id) taskService.updateTaskError(db, row.task_id, '未配置视频模型');
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
    await pollProviderTaskAndFinalize(db, log, videoGenId, row, rowForAspect, providerTaskId, config);
  } catch (err) {
    const now = new Date().toISOString();
    const message = '供应商任务轮询暂时中断，将继续使用原任务号恢复，请勿重新提交';
    db.prepare('UPDATE video_generations SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?')
      .run('processing', message, now, videoGenId);
    if (row.task_id) taskService.updateTaskStatus(db, row.task_id, 'processing', 90, message);
    log.error('Video generation resume poll error', { id: videoGenId, error: err.message });
  } finally {
    activeVideoPolls.delete(videoGenId);
  }
}

/** 启动时恢复 processing 视频任务；无 provider_task_id 的视为中断 */
function resumeProcessingVideoGenerations(db, log) {
  const stuck = db
    .prepare(
      `SELECT id, task_id FROM video_generations
       WHERE status = 'processing' AND deleted_at IS NULL
         AND (provider_task_id IS NULL OR TRIM(provider_task_id) = '')`
    )
    .all();
  const stuckMsg = '服务重启后无法恢复轮询（缺少厂商任务 ID），请重新生成';
  for (const s of stuck) {
    const now = new Date().toISOString();
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
      resumePollForVideoGeneration(db, log, r.id).catch((e) => {
        log.error('resumePollForVideoGeneration unhandled', { videoGenId: r.id, error: e.message });
      });
    });
  }
}

async function processVideoGeneration(db, log, videoGenId) {
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
    const initialConfig = videoClient.getDefaultVideoConfig(db, row.model);
    if (!initialConfig) {
      setVideoGenFailed(db, videoGenId, '未配置视频模型', now);
      if (row.task_id) taskService.updateTaskError(db, row.task_id, '未配置视频模型');
      return;
    }
    let reference_urls = null;
    if (row.reference_image_urls) {
      try {
        reference_urls = JSON.parse(row.reference_image_urls);
        if (!Array.isArray(reference_urls)) reference_urls = null;
      } catch (_) {}
    }
    const reference_video_urls = parseReferenceUrls(row.reference_video_urls, row.reference_video_url);
    const reference_audio_urls = parseReferenceUrls(row.reference_audio_urls, row.reference_audio_url);
    const effectiveDuration = normalizeVideoDuration(row.duration, 5);
    let aspectForVideo = row.aspect_ratio;
    if (aspectForVideo) {
      const n = videoClient.normalizeAspectRatioForApi(aspectForVideo);
      if (n) aspectForVideo = n;
    }
    if (!aspectForVideo && row.drama_id) {
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
    const rowForAspect = { ...row, aspect_ratio: aspectForVideo || row.aspect_ratio };
    const hasOmniRefs = !!(
      (reference_urls && reference_urls.length > 0)
      || reference_video_urls.length > 0
      || reference_audio_urls.length > 0
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
    const result = await videoClient.callVideoApi(db, log, {
      prompt: row.prompt,
      model: row.model,
      duration: effectiveDuration,
      aspect_ratio: rowForAspect.aspect_ratio,
      resolution: row.resolution,
      seed: row.seed,
      camera_fixed: row.camera_fixed,
      watermark: row.watermark,
      provider: row.provider,
      drama_id: row.drama_id,
      storyboard_id: row.storyboard_id || undefined,
      image_url: row.image_url,
      first_frame_url: row.first_frame_url,
      last_frame_url: row.last_frame_url,
      reference_urls,
      reference_video_urls,
      reference_audio_urls,
      voice_reference_url: reference_audio_urls[0] || undefined,
      files_base_url: filesBaseUrl,
      storage_local_path: storageLocalPath,
      video_gen_id: videoGenId,
      userId: row.user_id || undefined,
      tenantId: row.tenant_id || undefined,
      creditReservationId: row.credit_reservation_id || undefined,
    });
    const now2 = new Date().toISOString();
    if (result.error) {
      if (result.indeterminate) {
        db.prepare('UPDATE video_generations SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?')
          .run('processing', String(result.error).slice(0, 500), now2, videoGenId);
        if (row.task_id) taskService.updateTaskStatus(db, row.task_id, 'processing', 90, result.error);
        log.warn('Video generation submission result unknown; duplicate guard remains active', {
          id: videoGenId,
        });
        return;
      }
      setVideoGenFailed(db, videoGenId, result.error, now2);
      if (row.task_id) taskService.updateTaskError(db, row.task_id, result.error);
      log.error('Video generation failed', { id: videoGenId, error: result.error });
      return;
    }
    const selectedConfig = result.config_id
      ? videoClient.getVideoConfigById(db, result.config_id)
      : initialConfig;
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
      db.prepare(
        'UPDATE video_generations SET status = ?, provider_task_id = ?, updated_at = ? WHERE id = ?'
      ).run('processing', result.task_id, now2, videoGenId);
      await pollProviderTaskAndFinalize(db, log, videoGenId, row, rowForAspect, result.task_id, selectedConfig);
      return;
    }
    setVideoGenFailed(db, videoGenId, '未返回 task_id 或 video_url', now2);
    if (row.task_id) taskService.updateTaskError(db, row.task_id, '未返回 task_id 或 video_url');
  } catch (err) {
    const now2 = new Date().toISOString();
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
  extractVideoBoundaryFrames,
  ensureBoundaryFrames,
};
