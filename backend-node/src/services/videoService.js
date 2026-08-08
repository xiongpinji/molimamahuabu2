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
     WHERE storyboard_id = ? AND status IN ('pending', 'processing') AND deleted_at IS NULL${ownerClause}
     ORDER BY created_at DESC, id DESC LIMIT 1`
  ).get(...params) || null;
}

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawnSync } = require('child_process');
const { randomUUID } = require('crypto');
const videoClient = require('./videoClient');
const usmercariVideoClient = require('./usmercariVideoClient');
const aiConfigService = require('./aiConfigService');
const toapisVideoClient = require('./toapisVideoClient');
const { TOAPIS_VIDEO_MODELS } = toapisVideoClient;
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
const { hasTrustedEvidenceBinding } = require('./externalModelEvidenceService');
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

function isFeituoVideoConfig(config) {
  return [config?.provider, config?.api_protocol]
    .map((value) => String(value || '').trim().toLowerCase())
    .some((value) => value === 'feituo' || value === 'feituo_open');
}

function matchingToapisConfigs(db, model) {
  const target = String(model || '').trim().toLowerCase();
  if (!TOAPIS_VIDEO_MODELS[target]) return [];
  return aiConfigService.listConfigs(db, 'video').filter((config) => (
    isToapisVideoConfig(config)
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

function processingVideoConfig(db, model) {
  const target = String(model || '').trim().toLowerCase();
  if (FEITUO_MODELS[target] && target.startsWith('xuan-')) {
    return matchingFeituoConfigs(db, target)
      .find((config) => config.is_active && aiConfigService.hasConnectionCredential(config)) || null;
  }
  if (!TOAPIS_VIDEO_MODELS[target]) return videoClient.getDefaultVideoConfig(db, model);
  return matchingToapisConfigs(db, target)
    .find((config) => config.is_active && aiConfigService.hasConnectionCredential(config)) || null;
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

function findVideoPlatformReference(db, kind, relativePath, publicUrl) {
  const asset = db.prepare(`SELECT id, drama_id, metadata FROM assets
    WHERE deleted_at IS NULL AND type = ? AND (local_path = ? OR url = ? OR url = ?)
    ORDER BY id DESC LIMIT 1`).get(kind, relativePath, `/static/${relativePath}`, publicUrl);
  if (asset) return { source: 'asset', drama_id: asset.drama_id, metadata: parseJsonObject(asset.metadata) };
  if (kind === 'image') {
    const generated = db.prepare(`SELECT id, drama_id FROM image_generations
      WHERE deleted_at IS NULL AND status = 'completed' AND (local_path = ? OR image_url = ? OR image_url = ?)
      ORDER BY id DESC LIMIT 1`).get(relativePath, `/static/${relativePath}`, publicUrl);
    if (generated) return { source: 'image_generation', drama_id: generated.drama_id, metadata: {} };
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
  };
  for (const item of allRefs) {
    const ref = normalizeToapisReferenceUrl(item.url, context);
    const row = findVideoPlatformReference(db, item.kind, ref.relativePath, ref.url);
    if (!row) throw videoRequestError('VIDEO_REFERENCE_FORBIDDEN', '参考素材不是当前项目可用素材');
    const metadata = row.metadata || {};
    if (!(row.drama_id == null && metadata.system_shared === true) && Number(row.drama_id) !== targetDramaId) {
      throw videoRequestError('VIDEO_REFERENCE_FORBIDDEN', '参考素材不属于当前项目');
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
  let videoConfig = videoClient.getDefaultVideoConfig(db, selectedModel);
  let model = String(videoConfig?.canvas_selected_model
    || selectedModel
    || videoConfig?.default_model
    || configModels(videoConfig)[0]
    || '').trim() || null;
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
  const strictVideoState = toapisState || feituoState;
  const videoProtocol = String(videoConfig?.api_protocol || videoConfig?.provider || '').trim().toLowerCase();
  const isToapisVideo = Boolean(toapisState)
    || videoProtocol === 'toapis_video'
    || videoProtocol === 'toapis';
  const toapisSpec = toapisState
    ? {
        ...toapisState.official,
        maxReferences: verifiedReferenceLimit(toapisState.capabilities?.maxReferences),
        maxVideoReferences: verifiedReferenceLimit(toapisState.capabilities?.maxVideoReferences),
        maxAudioReferences: verifiedReferenceLimit(toapisState.capabilities?.maxAudioReferences),
      }
    : (isToapisVideo ? TOAPIS_VIDEO_MODELS[String(model || '').trim().toLowerCase()] : null);
  const feituoSpec = feituoState
    ? {
        ...feituoState.official,
        maxReferences: verifiedReferenceLimit(feituoState.capabilities?.maxReferences),
        maxVideoReferences: verifiedReferenceLimit(feituoState.capabilities?.maxVideoReferences),
        maxAudioReferences: verifiedReferenceLimit(feituoState.capabilities?.maxAudioReferences),
      }
    : null;
  const inputReferenceImageUrls = cleanUrlList(body.reference_image_urls);
  if (toapisSpec && inputReferenceImageUrls.length > toapisSpec.maxReferences) {
    throw videoRequestError(
      'VIDEO_REFERENCE_LIMIT_EXCEEDED',
      `ToAPIs 模型 ${model} 最多支持 ${toapisSpec.maxReferences} 张参考图`
    );
  }
  const requestedResolution = String(body.resolution || '').trim().toLowerCase();
  if (strictVideoState && (!requestedResolution || !strictVideoState.resolutions.includes(requestedResolution))) {
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
  const strictReferenceSpec = toapisSpec || feituoSpec;
  const effectiveCapabilities = strictReferenceSpec
    ? {
        ...resolvedCapabilities,
        referenceTypes: [
          strictVideoState?.capabilities?.supportsImageReference === true ? 'image' : null,
          strictVideoState?.capabilities?.supportsVideoReference === true ? 'video' : null,
          strictVideoState?.capabilities?.supportsAudioReference === true ? 'audio' : null,
        ].filter(Boolean),
        maxImageReferences: strictReferenceSpec.maxReferences,
        maxVideoReferences: strictReferenceSpec.maxVideoReferences,
        maxAudioReferences: strictReferenceSpec.maxAudioReferences,
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
    if (toapisState) requireToapisResolutionPrice(db, billingModel, requestedResolution);
    if (feituoState) requireFeituoPrice(db, feituoState, requestedResolution);
    price = modelPrice.calculateCharge(db, billingModel, {
      duration,
      resolution: requestedResolution,
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
  let imageUrl = cleanUrlList(body.image_url)[0] || null;
  let firstFrameUrl = cleanUrlList(body.first_frame_url, body.first_frame_local_path, body.image_url)[0] || null;
  let lastFrameUrl = cleanUrlList(body.last_frame_url, body.last_frame_local_path)[0] || null;
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
  }
  const referenceMode = hasOmniRefs ? 'omni' : hasFrameRefs ? 'frame' : 'text';
  const generateAudio = body.generate_audio === true;
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
    resolution: body.resolution,
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
  });

  const now = new Date().toISOString();
  const result = db.transaction(() => {
    const task = taskService.createTask(db, log, 'video_generation', String(dramaId || ''));
    if (billingEnabled && options.tenantId) {
      db.prepare('UPDATE async_tasks SET tenant_id = ?, user_id = ? WHERE id = ?')
        .run(options.tenantId, options.userId, task.id);
    }
    const refs = referenceImageUrls.length ? JSON.stringify(referenceImageUrls) : null;
    const persistedFirstFrameUrl = firstFrameUrl;
    const referenceVideoUrl = referenceVideoUrls[0] || null;
    const referenceAudioUrl = referenceAudioUrls[0] || null;
    db.prepare(`INSERT INTO video_generations
      (drama_id, storyboard_id, provider, prompt, model, duration, aspect_ratio, resolution, seed, camera_fixed, watermark,
       image_url, first_frame_url, last_frame_url, reference_image_urls, reference_video_url, reference_audio_url,
       reference_mode, generate_audio, reference_video_urls, reference_audio_urls, request_snapshot,
       status, task_id, tenant_id, user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?, ?)`)
      .run(
        dramaId, storyboardId, body.provider || videoConfig?.provider || 'chatfire', prompt, model, duration,
        aspectRatio, body.resolution ?? null, body.seed != null ? Number(body.seed) : null,
        body.camera_fixed != null ? (body.camera_fixed ? 1 : 0) : null, body.watermark ? 1 : 0,
        imageUrl ?? null, persistedFirstFrameUrl,
        lastFrameUrl ?? null, refs, referenceVideoUrl, referenceAudioUrl,
        referenceMode, generateAudio ? 1 : 0, JSON.stringify(referenceVideoUrls), JSON.stringify(referenceAudioUrls),
        JSON.stringify(requestSnapshot), task.id,
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
  schedule(() => processVideoGeneration(db, log, result.id, { evidenceRoots: options.evidenceRoots }));
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
      return { localPath: null };
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
    return { localPath: null };
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
    maybeNormalizeVideoAfterDownload(storagePath, localPath, rowForAspect, videoGenId, log);
    boundaryFrames = extractVideoBoundaryFrames(storagePath, localPath, videoGenId, log);
  } catch (_) {}
  if (downloadError) {
    setVideoGenFailed(db, videoGenId, downloadError, now);
    if (row.task_id) taskService.updateTaskError(db, row.task_id, downloadError);
    log.error('Video generation failed before completion', { id: videoGenId, error: downloadError });
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

  const config = processingVideoConfig(db, row.model);
  if (!config) {
    keepVideoProcessing(db, row, videoGenId, '视频模型配置暂不可用，已保留供应商任务 ID，恢复配置后继续查询');
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
    setVideoGenFailed(db, videoGenId, err.message, now);
    if (row.task_id) taskService.updateTaskError(db, row.task_id, err.message);
    log.error('Video generation resume poll error', { id: videoGenId, error: err.message });
  } finally {
    activeVideoPolls.delete(videoGenId);
  }
}

/** 启动时恢复 processing 视频任务；无 provider_task_id 的视为中断 */
function resumeProcessingVideoGenerations(db, log) {
  const indeterminate = db
    .prepare(
      `SELECT id, task_id, error_msg FROM video_generations
       WHERE status = 'processing' AND deleted_at IS NULL
         AND (provider_task_id IS NULL OR TRIM(provider_task_id) = '')
         AND error_msg LIKE 'VIDEO_SUBMISSION_INDETERMINATE:%'`
    )
    .all();
  for (const s of indeterminate) {
    if (s.task_id) taskService.updateTaskStatus(db, s.task_id, 'processing', 90, s.error_msg);
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
    const existingProviderTaskId = row.provider_task_id && String(row.provider_task_id).trim();
    const config = processingVideoConfig(db, row.model);
    if (!config) {
      if (existingProviderTaskId) {
        keepVideoProcessing(db, row, videoGenId, '视频模型配置暂不可用，已保留供应商任务 ID，恢复配置后继续查询', now);
      } else {
        setVideoGenFailed(db, videoGenId, '未配置视频模型', now);
        if (row.task_id) taskService.updateTaskError(db, row.task_id, '未配置视频模型');
      }
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
    const referenceVideoUrls = snapshotHas('reference_video_urls')
      ? cleanUrlList(Array.isArray(snapshot.reference_video_urls) ? snapshot.reference_video_urls : [])
      : cleanUrlList(parseReferenceUrls(row.reference_video_urls), row.reference_video_url);
    const referenceAudioUrls = snapshotHas('reference_audio_urls')
      ? cleanUrlList(Array.isArray(snapshot.reference_audio_urls) ? snapshot.reference_audio_urls : [])
      : cleanUrlList(parseReferenceUrls(row.reference_audio_urls), row.reference_audio_url);
    const processingModel = String(snapshot.model ?? row.model ?? '').trim();
    const normalizedProcessingModel = processingModel.toLowerCase();
    const processingAllowedDurations = TOAPIS_VIDEO_MODELS[normalizedProcessingModel]?.durations
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
      await pollProviderTaskAndFinalize(db, log, videoGenId, row, rowForAspect, existingProviderTaskId, config);
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
    if (FEITUO_MODELS[normalizedProcessingModel] && normalizedProcessingModel.startsWith('xuan-')) {
      feituoReadyState(db, normalizedProcessingModel);
    }
    const result = await videoClient.callVideoApi(db, log, {
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
      voice_reference_url: referenceAudioUrls[0] || undefined,
      video_url: referenceVideoUrls[0] || undefined,
      generate_audio: snapshot.generate_audio ?? (row.generate_audio === 1),
      files_base_url: filesBaseUrl,
      storage_local_path: storageLocalPath,
      video_gen_id: videoGenId,
    }, runtime);
    const now2 = new Date().toISOString();
    if (result.indeterminate) {
      const message = `VIDEO_SUBMISSION_INDETERMINATE: ${String(result.error || '供应商提交结果未知，请人工对账').slice(0, 450)}`;
      db.prepare('UPDATE video_generations SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?')
        .run('processing', message, now2, videoGenId);
      if (row.task_id) taskService.updateTaskStatus(db, row.task_id, 'processing', 90, message);
      log.warn('Video submission indeterminate; reservation remains held', { id: videoGenId });
      return;
    }
    if (result.error) {
      setVideoGenFailed(db, videoGenId, result.error, now2);
      if (row.task_id) taskService.updateTaskError(db, row.task_id, result.error);
      log.error('Video generation failed', { id: videoGenId, error: result.error });
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
        config
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
      await pollProviderTaskAndFinalize(db, log, videoGenId, row, rowForAspect, result.task_id, config);
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
  shouldNormalizeVideoAfterDownload,
  extractVideoBoundaryFrames,
  ensureBoundaryFrames,
};
