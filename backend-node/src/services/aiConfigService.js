// AI 配置 CRUD，与 Go application/services/ai_service.go 对齐
const fs = require('fs');
const path = require('path');
const { normalizeMaterialHubToken } = require('./jimengMaterialHubService');
const { resolveKlingBearerToken } = require('./klingJwt');
const { buildFeituoStatusUrl } = require('./feituoVideoClient');
const token6688Client = require('./token6688Client');
const usmercariVideoClient = require('./usmercariVideoClient');
const toapisVideoClient = require('./toapisVideoClient');

function normalizeApiKeyForService(serviceType, apiKey) {
  if (serviceType === 'jimeng2_character_auth' && apiKey != null) {
    return normalizeMaterialHubToken(apiKey);
  }
  return apiKey;
}

function hasConnectionCredential(opts = {}) {
  if (String(opts.api_key || '').trim()) return true;
  if (['usmercari', 'usmercari_image'].includes(String(opts.provider || '').toLowerCase())
      || String(opts.api_protocol || '').toLowerCase() === 'usmercari_image') {
    return !!usmercariVideoClient.resolveUsmercariApiKey(opts);
  }
  if (['toapis', 'toapis_video'].includes(String(opts.provider || '').toLowerCase())
      || String(opts.api_protocol || '').toLowerCase() === 'toapis_video') {
    return !!toapisVideoClient.resolveToapisApiKey(opts);
  }
  if (String(opts.provider || '').toLowerCase() !== 'kling') return false;
  try {
    const settings = typeof opts.settings === 'object' ? opts.settings : JSON.parse(opts.settings || '{}');
    return !!String(settings.kling_access_key || settings.access_key || '').trim()
      && !!String(settings.kling_secret_key || settings.secret_key || '').trim();
  } catch (_) {
    return false;
  }
}
const { applyDeepSeekConnectivityOptions } = require('./deepseekConfig');
function modelToDb(model) {
  if (model == null) return null;
  if (Array.isArray(model)) return JSON.stringify(model);
  if (typeof model === 'string') return JSON.stringify([model]);
  return JSON.stringify([]);
}

function modelFromDb(val) {
  if (val == null || val === '') return [];
  try {
    const arr = JSON.parse(val);
    return Array.isArray(arr) ? arr : [String(arr)];
  } catch {
    return [String(val)];
  }
}

/** 每种服务类型只保留一个默认：若有多个 is_default=1，只保留优先级最高（同优先级取 id 最小）的那条 */
function ensureSingleDefaultPerType(db) {
  const types = ['text', 'image', 'storyboard_image', 'video', 'tts', 'jimeng2_character_auth', 'model_ark_asset'];
  for (const st of types) {
    const rows = db.prepare(
      'SELECT id, priority FROM ai_service_configs WHERE deleted_at IS NULL AND service_type = ? AND is_default = 1 ORDER BY priority DESC, id ASC'
    ).all(st);
    if (rows.length <= 1) continue;
    const keepId = rows[0].id;
    db.prepare(
      'UPDATE ai_service_configs SET is_default = 0 WHERE deleted_at IS NULL AND service_type = ? AND id != ?'
    ).run(st, keepId);
  }
}

function listConfigs(db, serviceType) {
  ensureSingleDefaultPerType(db);
  const order = 'ORDER BY is_default DESC, priority DESC, created_at DESC';
  let sql = 'SELECT * FROM ai_service_configs WHERE deleted_at IS NULL ' + order;
  const params = [];
  if (serviceType) {
    sql = 'SELECT * FROM ai_service_configs WHERE deleted_at IS NULL AND service_type = ? ' + order;
    params.push(serviceType);
  }
  const rows = params.length ? db.prepare(sql).all(...params) : db.prepare(sql).all();
  return rows.map(rowToConfig);
}

function clearOtherDefault(db, serviceType, exceptId) {
  const stmt = db.prepare(
    'UPDATE ai_service_configs SET is_default = 0 WHERE deleted_at IS NULL AND service_type = ? AND id != ?'
  );
  stmt.run(serviceType, exceptId);
}

function getConfig(db, id) {
  const row = db.prepare('SELECT * FROM ai_service_configs WHERE id = ? AND deleted_at IS NULL').get(id);
  return row ? rowToConfig(row) : null;
}

const USMERCARI_VIDEO_MODELS = new Set(['MiniMax H3', 'seedance-2.0-fast', 'seedance-2.0-mini']);

function allowsUsmercariFourSecondDuration(context = {}) {
  const provider = String(context.provider || '').trim().toLowerCase();
  if (!['usmercari', 'usmercari_media'].includes(provider)) return false;
  const models = [
    ...(Array.isArray(context.model) ? context.model : [context.model]),
    context.default_model,
  ].map((model) => String(model || '').trim());
  return models.some((model) => USMERCARI_VIDEO_MODELS.has(model));
}

function resolveVideoSettingsDurations(context = {}) {
  if (Array.isArray(context.allowedDurations) && context.allowedDurations.length) {
    return [...new Set(context.allowedDurations.map(Number).filter(Number.isSafeInteger))];
  }
  const protocols = [context.api_protocol, context.protocol, context.provider]
    .map((value) => String(value || '').trim().toLowerCase());
  const configuredModel = context.default_model
    || (Array.isArray(context.model) ? context.model[0] : context.model);
  if (protocols.some((protocol) => ['toapis', 'toapis_video'].includes(protocol))) {
    return toapisVideoClient.TOAPIS_VIDEO_MODELS[String(configuredModel || '').trim().toLowerCase()]?.durations || null;
  }
  if (allowsUsmercariFourSecondDuration(context)) {
    return Array.from({ length: 12 }, (_, index) => index + 4);
  }
  return null;
}

function parseVideoSettings(settings, context = {}) {
  let parsed;
  try {
    parsed = typeof settings === 'string' ? JSON.parse(settings) : settings;
  } catch (_) {
    const error = new Error('视频模型设置格式无效');
    error.code = 'INVALID_VIDEO_SETTINGS';
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error('视频模型设置格式无效');
    error.code = 'INVALID_VIDEO_SETTINGS';
    throw error;
  }
  if (Object.prototype.hasOwnProperty.call(parsed, 'video_duration')) {
    const duration = Number(parsed.video_duration);
    const allowedDurations = resolveVideoSettingsDurations(context);
    const minimum = allowsUsmercariFourSecondDuration(context) ? 4 : 5;
    const invalidDuration = !Number.isSafeInteger(duration)
      || (allowedDurations ? !allowedDurations.includes(duration) : duration < minimum || duration > 15);
    if (invalidDuration) {
      const error = new Error(allowedDurations
        ? `视频默认时长必须是 ${allowedDurations.join('、')} 秒之一`
        : `视频默认时长必须是 ${minimum} 到 15 秒之间的整数`);
      error.code = 'INVALID_VIDEO_DURATION';
      throw error;
    }
    parsed.video_duration = duration;
  }
  return parsed;
}

function normalizeCreateSettings(serviceType, settings, context = {}) {
  if (serviceType !== 'video' || settings == null) return settings || null;
  return JSON.stringify(parseVideoSettings(settings, context));
}

function mergeVideoSettings(existingSettings, incomingSettings, context = {}) {
  let existing = {};
  try {
    const parsed = typeof existingSettings === 'string' ? JSON.parse(existingSettings) : existingSettings;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
  } catch (_) {}
  const incoming = parseVideoSettings(incomingSettings, context);
  for (const [key, value] of Object.entries(incoming)) {
    if (SENSITIVE_SETTING_KEYS.has(key.toLowerCase()) && (value == null || value === '')) continue;
    existing[key] = value;
  }
  return JSON.stringify(parseVideoSettings(existing, context));
}

function verificationSettingsFingerprint(settings) {
  try {
    if (settings == null || settings === '') return '{}';
    const parsed = typeof settings === 'string' ? JSON.parse(settings) : settings;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return String(settings || '');
    const connectionSettings = {};
    for (const key of Object.keys(parsed).sort()) {
      if (CONNECTION_SETTING_KEYS.has(key.toLowerCase())) connectionSettings[key] = parsed[key];
    }
    return JSON.stringify(connectionSettings);
  } catch (_) {
    return String(settings || '');
  }
}

function createConfig(db, log, req) {
  const now = new Date().toISOString();
  const model = modelToDb(req.model);
  const serviceType = req.service_type || 'text';
  const settings = normalizeCreateSettings(serviceType, req.settings, req);
  let endpoint = req.endpoint || '';
  let queryEndpoint = req.query_endpoint || '';
  if (!endpoint && req.provider) {
    const p = req.provider.toLowerCase();
    const st = (req.service_type || 'text').toLowerCase();
    if (p === 'openai') {
      if (st === 'text') endpoint = '/chat/completions';
      else if (st === 'image') endpoint = '/images/generations';
      else if (st === 'video') {
        endpoint = '/videos';
        queryEndpoint = '/videos/{taskId}';
      }
    } else if (p === 'gemini' || p === 'google') {
      endpoint = '/v1beta/models/{model}:generateContent';
    } else if (p === 'dashscope' || p === 'qwen_image') {
      if (st === 'image' || st === 'storyboard_image') endpoint = '/api/v1/services/aigc/multimodal-generation/generation';
      else if (st === 'video' && p === 'dashscope') {
        endpoint = '/api/v1/services/aigc/image2video/video-synthesis';
        queryEndpoint = '/api/v1/tasks/{taskId}';
      }
    } else if (p === 'volces' || p === 'volcengine' || p === 'volc') {
      if (st === 'video') {
        endpoint = '/contents/generations/tasks';
        queryEndpoint = '/contents/generations/tasks/{taskId}';
      } else if (st === 'image' || st === 'storyboard_image') {
        endpoint = '/images/generations';
      }
    } else if (p === 'nano_banana') {
      if (st === 'image' || st === 'storyboard_image') {
        endpoint = '/api/v1/nanobanana/generate-2';
        queryEndpoint = '/api/v1/nanobanana/record-info';
      }
    } else if (p === 'agnes') {
      if (st === 'text') endpoint = '/chat/completions';
      else if (st === 'image' || st === 'storyboard_image') endpoint = '/images/generations';
      else if (st === 'video') {
        endpoint = '/videos';
        queryEndpoint = '/videos/{taskId}';
      }
    } else if (p === 'aihubcc' || p === 'aihubcc_image' || p === 'aihubcc_video') {
      if (st === 'image' || st === 'storyboard_image') endpoint = '/images/generations';
      else if (st === 'video') {
        endpoint = '/videos';
        queryEndpoint = '/videos/{taskId}';
      }
    } else if (p === 'deepwl' || p === 'deepwl_grok' || p === 'deepwl-grok') {
      if (st === 'video') {
        endpoint = '/v1/video/create';
        queryEndpoint = '/v1/video/query?id={taskId}';
      }
    } else if (p === 'icreat' || p === 'icreat_ai' || p === 'icreat-seedance') {
      if (st === 'video') {
        endpoint = '/v1/task/submit/{model}';
        queryEndpoint = '/v1/task/query-status';
      }
    } else if (p === 'usmercari' || p === 'usmercari_media') {
      if (st === 'video') {
        endpoint = '/cpa-file/submit/video';
        queryEndpoint = '/cpa-file/fetch';
      }
    } else if (p === 'token6688' || p === 'tokengo') {
      if (st === 'image' || st === 'storyboard_image') endpoint = '/v1/images/generations';
      else if (st === 'video') {
        endpoint = '/v1/videos/generations';
        queryEndpoint = '/v1/tasks/{taskId}';
      }
    } else if (p === 'djpsd_openapi' || req.api_protocol === 'djpsd_openapi' || req.api_protocol === 'djpsd_media') {
      if (st === 'image' || st === 'storyboard_image' || st === 'video') {
        endpoint = '/v1/media/generate';
        queryEndpoint = '/v1/media/status?task_id={taskId}';
      }
    } else if (p === 'toapis' || p === 'toapis_video') {
      if (st === 'video') {
        endpoint = '/v1/videos/generations';
        queryEndpoint = '/v1/videos/generations/{taskId}';
      }
    } else if (p === 'usmercari_image') {
      if (st === 'image' || st === 'storyboard_image') endpoint = '/v1/images/generations';
    }
  }
  const defaultModel = req.default_model != null ? String(req.default_model).trim() || null : null;
  const info = db.prepare(
    `INSERT INTO ai_service_configs (service_type, provider, api_protocol, name, base_url, api_key, model, default_model, endpoint, query_endpoint, priority, is_default, is_active, settings, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
  ).run(
    serviceType,
    req.provider || '',
    req.api_protocol || '',
    req.name || '',
    req.base_url || '',
    normalizeApiKeyForService(req.service_type, req.api_key || ''),
    model,
    defaultModel,
    endpoint,
    queryEndpoint,
    req.priority ?? 0,
    req.is_default ? 1 : 0,
    settings,
    now,
    now
  );
  log.info('AI config created', { config_id: info.lastInsertRowid, provider: req.provider });
  const newId = info.lastInsertRowid;
  if (req.is_default) clearOtherDefault(db, req.service_type || 'text', newId);
  return getConfig(db, newId);
}

function updateConfig(db, log, id, req) {
  const existing = getConfig(db, id);
  if (!existing) return null;
  const videoContextChanged = req.provider != null
    || req.api_protocol != null
    || req.model != null
    || req.default_model !== undefined;
  if (existing.service_type === 'video' && req.settings == null
      && existing.settings != null && videoContextChanged) {
    parseVideoSettings(existing.settings, {
      provider: req.provider ?? existing.provider,
      api_protocol: req.api_protocol ?? existing.api_protocol,
      model: req.model ?? existing.model,
      default_model: req.default_model !== undefined ? req.default_model : existing.default_model,
    });
  }
  const updates = [];
  const params = [];
  let connectivityChanged = false;
  if (req.name != null) {
    updates.push('name = ?');
    params.push(req.name);
  }
  if (req.provider != null) {
    updates.push('provider = ?');
    params.push(req.provider);
    connectivityChanged ||= String(req.provider) !== String(existing.provider || '');
  }
  if (req.api_protocol != null) {
    updates.push('api_protocol = ?');
    params.push(req.api_protocol);
    connectivityChanged ||= String(req.api_protocol) !== String(existing.api_protocol || '');
  }
  if (req.base_url != null) {
    updates.push('base_url = ?');
    params.push(req.base_url);
    connectivityChanged ||= String(req.base_url) !== String(existing.base_url || '');
  }
  if (req.api_key != null) {
    updates.push('api_key = ?');
    const st = req.service_type != null ? req.service_type : existing.service_type;
    const nextApiKey = normalizeApiKeyForService(st, req.api_key);
    params.push(nextApiKey);
    connectivityChanged ||= String(nextApiKey || '') !== String(existing.api_key || '');
  }
  if (req.model != null) {
    updates.push('model = ?');
    const nextModel = modelToDb(req.model);
    params.push(nextModel);
    connectivityChanged ||= nextModel !== modelToDb(existing.model);
  }
  if (req.default_model !== undefined) {
    updates.push('default_model = ?');
    const nextDefaultModel = req.default_model != null ? String(req.default_model).trim() || null : null;
    params.push(nextDefaultModel);
    connectivityChanged ||= nextDefaultModel !== existing.default_model;
  }
  if (req.priority != null) {
    updates.push('priority = ?');
    params.push(req.priority);
  }
  if (req.endpoint !== undefined) {
    updates.push('endpoint = ?');
    const nextEndpoint = req.endpoint || '';
    params.push(nextEndpoint);
    connectivityChanged ||= String(nextEndpoint) !== String(existing.endpoint || '');
  }
  if (req.query_endpoint !== undefined) {
    updates.push('query_endpoint = ?');
    const nextQueryEndpoint = req.query_endpoint || '';
    params.push(nextQueryEndpoint);
    connectivityChanged ||= String(nextQueryEndpoint) !== String(existing.query_endpoint || '');
  }
  if (req.settings != null) {
    updates.push('settings = ?');
    const nextSettings = existing.service_type === 'video'
      ? mergeVideoSettings(existing.settings, req.settings, {
        provider: req.provider ?? existing.provider,
        api_protocol: req.api_protocol ?? existing.api_protocol,
        model: req.model ?? existing.model,
        default_model: req.default_model !== undefined ? req.default_model : existing.default_model,
      })
      : req.settings;
    params.push(nextSettings);
    connectivityChanged ||= verificationSettingsFingerprint(nextSettings)
      !== verificationSettingsFingerprint(existing.settings);
  }
  if (typeof req.is_default === 'boolean') {
    updates.push('is_default = ?');
    params.push(req.is_default ? 1 : 0);
  }
  if (typeof req.is_active === 'boolean') {
    updates.push('is_active = ?');
    params.push(req.is_active ? 1 : 0);
  }
  if (connectivityChanged) {
    updates.push("verification_status = 'unverified'");
    updates.push('verification_checked_at = NULL');
    updates.push('verified_at = NULL');
    updates.push('verification_error = NULL');
  }
  if (updates.length === 0) return existing;
  params.push(new Date().toISOString(), id);
  db.prepare('UPDATE ai_service_configs SET ' + updates.join(', ') + ', updated_at = ? WHERE id = ?').run(...params);
  if (req.is_default === true) clearOtherDefault(db, existing.service_type, id);
  log.info('AI config updated', { config_id: id });
  return getConfig(db, id);
}

function deleteConfig(db, log, id) {
  const now = new Date().toISOString();
  const result = db.prepare('UPDATE ai_service_configs SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, id);
  if (result.changes === 0) return false;
  log.info('AI config deleted', { config_id: id });
  return true;
}

const VERIFICATION_STATUSES = new Set(['pending', 'verified', 'failed']);

function redactRealVerificationError(error) {
  return String(error || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(api[-_ ]?key|token)\s*[:=]\s*[A-Za-z0-9._~+/=-]+/gi, '$1=[REDACTED]')
    .slice(0, 800);
}

function recordVerification(db, configId, result = {}) {
  const id = Number(configId);
  const existing = getConfig(db, id);
  if (!existing) throw new Error('配置不存在');
  const status = String(result.status || '').trim().toLowerCase();
  if (!VERIFICATION_STATUSES.has(status)) {
    throw new Error('验证状态必须是 pending、verified 或 failed');
  }
  const capabilities = result.capabilities && typeof result.capabilities === 'object' && !Array.isArray(result.capabilities)
    ? result.capabilities
    : {};
  const now = new Date().toISOString();
  const verifiedAt = status === 'verified'
    ? String(result.verifiedAt || now)
    : null;
  const error = status === 'failed'
    ? redactRealVerificationError(result.error || '真实生成验证失败')
    : null;
  db.prepare(`UPDATE ai_service_configs
      SET verification_status = ?,
          verified_capabilities = ?,
          verified_at = ?,
          verification_error = ?,
          updated_at = ?
      WHERE id = ? AND deleted_at IS NULL`)
    .run(status, JSON.stringify(capabilities), verifiedAt, error, now, id);
  return getConfig(db, id);
}

function rowToConfig(r) {
  const cfg = {
    id: r.id,
    service_type: r.service_type,
    provider: r.provider,
    api_protocol: r.api_protocol || '',
    name: r.name,
    base_url: r.base_url,
    api_key: r.api_key,
    model: modelFromDb(r.model),
    default_model: r.default_model ? String(r.default_model).trim() : null,
    endpoint: r.endpoint,
    query_endpoint: r.query_endpoint,
    priority: r.priority ?? 0,
    is_default: !!r.is_default,
    is_active: r.is_active == null ? true : !!r.is_active,
    verification_status: String(r.verification_status || 'pending'),
    verification_checked_at: r.verification_checked_at || null,
    verified_capabilities: parseObject(r.verified_capabilities),
    verified_at: r.verified_at || null,
    verification_error: r.verification_error || null,
    settings: r.settings,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
  // TTS 配置：从 settings JSON 展开 voice_id / group_id 供 ttsService 直接读取
  if (r.service_type === 'tts' && r.settings) {
    try {
      const s = JSON.parse(r.settings);
      if (s.voice_id) cfg.voice_id = s.voice_id;
      if (s.group_id) cfg.group_id = s.group_id;
    } catch (_) {}
  }
  return cfg;
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

const SENSITIVE_SETTING_KEYS = new Set([
  'api_key', 'token', 'access_token', 'refresh_token', 'session_token',
  'kling_access_key', 'kling_secret_key', 'access_key', 'secret_key',
  'access_key_id', 'secret_access_key',
]);

const CONNECTION_SETTING_KEYS = new Set([
  ...SENSITIVE_SETTING_KEYS,
  'kling_secret_key_base64', 'icreat_group',
]);

function redactSettings(settings) {
  if (!settings) return settings;
  try {
    const parsed = typeof settings === 'string' ? JSON.parse(settings) : settings;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return settings;
    const safe = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!SENSITIVE_SETTING_KEYS.has(key.toLowerCase())) safe[key] = value;
    }
    return typeof settings === 'string' ? JSON.stringify(safe) : safe;
  } catch (_) {
    return null;
  }
}

function toPublicConfig(config) {
  if (!config) return config;
  const { api_key, ...safe } = config;
  return {
    ...safe,
    has_api_key: hasConnectionCredential(config),
    settings: redactSettings(config.settings),
  };
}

function isVerifiedConfig(config) {
  return String(config?.verification_status || '').toLowerCase() === 'verified';
}

function redactVerificationError(config, error) {
  let message = String(error?.message || error || '未知错误').replace(/\s+/g, ' ').trim();
  const secrets = [config?.api_key];
  try {
    const settings = typeof config?.settings === 'string' ? JSON.parse(config.settings) : config?.settings;
    if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
      for (const [key, value] of Object.entries(settings)) {
        if (SENSITIVE_SETTING_KEYS.has(key.toLowerCase())) secrets.push(value);
      }
    }
  } catch (_) {}
  for (const secret of secrets) {
    const value = String(secret || '').trim();
    if (value.length < 4) continue;
    message = message.split(value).join('[REDACTED]');
    message = message.split(encodeURIComponent(value)).join('[REDACTED]');
  }
  return message.slice(0, 500);
}

function setVerificationResult(db, id, status, error) {
  if (!['verified', 'failed'].includes(status)) throw new Error('无效的连接验证状态');
  const checkedAt = new Date().toISOString();
  const verificationError = status === 'failed'
    ? redactVerificationError(getConfig(db, id), error)
    : null;
  const result = db.prepare(`UPDATE ai_service_configs SET
      verification_status = ?, verification_checked_at = ?, verified_at = ?, verification_error = ?
    WHERE id = ? AND deleted_at IS NULL`)
    .run(status, checkedAt, status === 'verified' ? checkedAt : null, verificationError, id);
  return result.changes ? getConfig(db, id) : null;
}

/**
 * 测试连接：与 Go AIService.TestConnection 对齐，根据 provider 发最小请求验证 base_url + api_key
 * @param opts { base_url, api_key, model (string|string[]), provider?, endpoint?, settings? }
 * @returns Promise<void> 成功 resolve，失败 reject(error)
 */
async function testConnection(opts) {
  const base = (opts.base_url || '').replace(/\/$/, '');
  if (!base) throw new Error('base_url 必填');
  const models = Array.isArray(opts.model) ? opts.model : opts.model != null ? [opts.model] : [];
  const model = models[0] || '';
  if (!model && (opts.provider === 'gemini' || opts.provider === 'google')) throw new Error('model 必填');
  const provider = (opts.provider || 'openai').toLowerCase();
  const protocol = String(opts.api_protocol || '').toLowerCase();
  const serviceType = (opts.service_type || '').toLowerCase();
  let endpoint = opts.endpoint || '';

  let isAihubccHost = false;
  try { isAihubccHost = new URL(base).hostname.toLowerCase() === 'aihubcc.cc'; } catch (_) {}
  if (provider === 'aihubcc' || provider === 'aihubcc_image' || provider === 'aihubcc_video' || isAihubccHost) {
    if (!opts.api_key) throw new Error('api_key 必填');
    const queryPath = String('/videos/{taskId}')
      .replace(/\{taskId\}|\{task_id\}|\{id\}/gi, 'codex-connectivity-check');
    const url = base + (queryPath.startsWith('/') ? queryPath : '/' + queryPath);
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + opts.api_key },
    });
    if (res.status === 401 || res.status === 403) {
      const text = await res.text();
      throw new Error(`AIHubCC API Key 无效 (${res.status})${text ? `: ${text.slice(0, 160)}` : ''}`);
    }
    if (res.ok || res.status === 400 || res.status === 404) return;
    throw new Error(`AIHubCC 连接失败 (${res.status})`);
  }

  // 可灵图片：查询一个不存在的任务即可验证鉴权，禁止连接测试创建付费图片任务。
  if (provider === 'kling' && (serviceType === 'image' || serviceType === 'storyboard_image')) {
    const bearer = resolveKlingBearerToken(opts);
    if (!bearer) throw new Error('请填写 API Key，或官方 AccessKey + SecretKey');
    const queryPath = String(opts.query_endpoint || '/v1/images/generations/{taskId}')
      .replace(/\{taskId\}|\{task_id\}|\{id\}/gi, 'codex-connectivity-check');
    const url = base + (queryPath.startsWith('/') ? queryPath : '/' + queryPath);
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + bearer },
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    const message = String(data.message || data.msg || '').toLowerCase();
    const authFailed = res.status === 401 || res.status === 403
      || [1000, 1001, 1002, 1003].includes(Number(data.code))
      || message.includes('authorization') || message.includes('unauthorized');
    if (authFailed) throw new Error(data.message || data.msg || `可灵鉴权失败 (${res.status})`);
    return;
  }

  if ((provider === 'token6688' || provider === 'tokengo' || protocol === 'token6688')
      && (serviceType === 'image' || serviceType === 'storyboard_image' || serviceType === 'video')) {
    if (!opts.api_key) throw new Error('api_key 必填');
    const url = `${token6688Client.normalizeBaseUrl(base)}/v1/models`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${opts.api_key || ''}` },
    });
    const raw = await res.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch (_) {}
    if (res.status === 401 || res.status === 403) throw new Error(`Token6688 API Key 无效 (${res.status})`);
    if (!res.ok) throw new Error(`Token6688 连接失败 (${res.status})`);
    const available = new Set((Array.isArray(data?.data) ? data.data : [])
      .map((item) => String(item?.id || item?.name || '').trim())
      .filter(Boolean));
    const requested = models
      .map((item) => token6688Client.normalizeImageModel(item))
      .map((item) => String(item || '').trim())
      .map((item) => item.startsWith('seedance-2-0-special-') ? 'seedance-2-0-special' : item)
      .filter(Boolean);
    const missing = requested.filter((item) => !available.has(item));
    if (missing.length) throw new Error(`Token6688 未找到已配置模型: ${missing.join(', ')}`);
    return;
  }

  // USMercari 连接测试只读取模型目录，禁止创建会扣费的视频任务。
  if ((provider === 'usmercari' || provider === 'usmercari_media') && serviceType === 'video') {
    const apiKey = usmercariVideoClient.resolveUsmercariApiKey(opts);
    if (!apiKey) throw new Error('api_key 必填');
    const url = `${usmercariVideoClient.normalizeUsmercariBaseUrl(base)}/v1/models`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) {}
    if (res.status === 401 || res.status === 403) throw new Error(`USMercari API Key 无效 (${res.status})`);
    if (!res.ok) throw new Error(`USMercari 连接失败 (${res.status})`);
    const available = new Set((Array.isArray(data?.data) ? data.data : [])
      .map((item) => String(item?.id || item?.name || '').trim()).filter(Boolean));
    const requested = (models.length ? models : Object.keys(usmercariVideoClient.USMERCARI_MODELS))
      .map((item) => String(item || '').trim()).filter(Boolean);
    const missing = requested.filter((item) => !available.has(item));
    if (missing.length) throw new Error(`USMercari 模型目录缺少: ${missing.join(', ')}`);
    return;
  }

  // USMercari 图片连接测试只读取模型目录。真实验证状态只能由实生成证据写入，
  // 不能由这个不会产生结果文件的探针升级。
  if ((provider === 'usmercari_image' || protocol === 'usmercari_image')
      && (serviceType === 'image' || serviceType === 'storyboard_image')) {
    const apiKey = usmercariVideoClient.resolveUsmercariApiKey(opts);
    if (!apiKey) throw new Error('api_key 必填');
    const url = `${usmercariVideoClient.normalizeUsmercariBaseUrl(base)}/v1/models`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) {}
    if (res.status === 401 || res.status === 403) throw new Error(`USMercari API Key 无效 (${res.status})`);
    if (!res.ok) throw new Error(`USMercari 连接失败 (${res.status})`);
    const available = new Set((Array.isArray(data?.data) ? data.data : [])
      .map((item) => String(item?.id || item?.name || '').trim()).filter(Boolean));
    const missing = models.map((item) => String(item || '').trim()).filter(Boolean)
      .filter((item) => !available.has(item));
    if (missing.length) throw new Error(`USMercari 模型目录缺少: ${missing.join(', ')}`);
    return;
  }

  // ToAPIs 连接测试只读取官方模型目录，禁止提交可能计费的视频生成请求。
  if ((provider === 'toapis' || provider === 'toapis_video' || protocol === 'toapis_video')
      && serviceType === 'video') {
    const apiKey = toapisVideoClient.resolveToapisApiKey(opts);
    if (!apiKey) throw new Error('api_key 必填');
    const url = `${toapisVideoClient.normalizeToapisBaseUrl(base)}/v1/models?type=video`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) {}
    if (res.status === 401 || res.status === 403) throw new Error(`ToAPIs API Key 无效 (${res.status})`);
    if (!res.ok) throw new Error(`ToAPIs 连接失败 (${res.status})`);
    const available = new Set((Array.isArray(data?.data) ? data.data : [])
      .map((item) => String(item?.id || item?.name || '').trim()).filter(Boolean));
    const requested = (models.length ? models : Object.keys(toapisVideoClient.TOAPIS_VIDEO_MODELS))
      .map((item) => String(item || '').trim()).filter(Boolean);
    const missing = requested.filter((item) => !available.has(item));
    if (missing.length) throw new Error(`ToAPIs 模型目录缺少: ${missing.join(', ')}`);
    return;
  }

  if (!opts.api_key) throw new Error('api_key 必填');

  if ((provider === 'djpsd_openapi' || protocol === 'djpsd_openapi' || protocol === 'djpsd_media')
      && (serviceType === 'image' || serviceType === 'storyboard_image' || serviceType === 'video')) {
    const root = base.replace(/\/+$/, '').replace(/\/v1$/i, '');
    const res = await fetch(`${root}/v1/media/status?task_id=0`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${opts.api_key || ''}` },
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new Error(`DJPSD 开放 API Key 无效 (${res.status})`);
    if (res.ok || res.status === 400 || res.status === 404) return;
    throw new Error(`DJPSD 开放 API 连接失败 (${res.status})${text ? `: ${text.slice(0, 160)}` : ''}`);
  }

  // 飞拓连接测试只查询一个不存在的 jobId，禁止创建付费视频任务。
  if ((provider === 'feituo' || provider === 'feituo_open') && serviceType === 'video') {
    const res = await fetch(buildFeituoStatusUrl(base, 'codex-connectivity-check'), {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + opts.api_key,
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
    });
    if (res.status === 401 || res.status === 403) throw new Error(`飞拓 API Key 无效 (${res.status})`);
    if (res.ok || res.status === 400 || res.status === 404) return;
    throw new Error(`飞拓连接失败 (${res.status})`);
  }

  // iCreat 采用三段式任务接口；连接测试只查询不存在的任务，避免提交计费任务。
  if ((provider === 'icreat' || provider === 'icreat_ai' || provider === 'icreat-seedance') && serviceType === 'video') {
    let icreatBase = base;
    try {
      const url = new URL(base);
      if (url.hostname.toLowerCase() === 'zh.icreat.ai') url.hostname = 'api.icreat.ai';
      if (url.pathname === '/v1') url.pathname = '';
      icreatBase = url.toString().replace(/\/+$/, '');
    } catch (_) {
      icreatBase = base.replace(/^https:\/\/zh\.icreat\.ai/i, 'https://api.icreat.ai').replace(/\/v1$/i, '');
    }
    const settings = (() => {
      if (!opts.settings) return {};
      if (typeof opts.settings === 'object') return opts.settings;
      try { return JSON.parse(opts.settings) || {}; } catch (_) { return {}; }
    })();
    const res = await fetch(`${icreatBase}/v1/task/query-status`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + opts.api_key,
        'X-ICREAT-AI-GROUP': String(settings.icreat_group || 'default'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ task_id: 'codex-connectivity-check' }),
    });
    if (res.status === 401 || res.status === 403) throw new Error(`iCreat API Key 无效 (${res.status})`);
    if (res.ok || res.status === 400 || res.status === 404) return;
    throw new Error(`iCreat 连接失败 (${res.status})`);
  }

  // DeepWL Grok 没有 chat/completions 入口。连接测试只读查询一个不存在的任务，
  // 401/403 明确表示密钥无效，400/404 表示查询路由已连通，其他状态按真实失败处理。
  if ((provider === 'deepwl' || provider === 'deepwl_grok' || provider === 'deepwl-grok') && serviceType === 'video') {
    const protocol = String(opts.api_protocol || '').toLowerCase();
    const defaultQuery = protocol.includes('openai') || protocol.includes('imagine')
      ? '/v1/videos/{taskId}'
      : '/v1/video/query?id={taskId}';
    const queryPath = String(opts.query_endpoint || defaultQuery)
      .replace(/\{taskId\}|\{task_id\}|\{id\}/gi, 'codex-connectivity-check');
    const queryUrl = base + (queryPath.startsWith('/') ? queryPath : '/' + queryPath);
    const res = await fetch(queryUrl, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + opts.api_key },
    });
    if (res.status === 401 || res.status === 403) {
      const text = await res.text();
      let message = `DeepWL API Key 无效 (${res.status})`;
      try {
        const data = JSON.parse(text);
        message = data.error?.message || data.message || data.detail || message;
      } catch (_) {}
      throw new Error(message);
    }
    if (res.status === 400 || res.status === 404 || res.ok) return;
    throw new Error(`DeepWL 连接失败 (${res.status})`);
  }

  // 用户指定的 Rehdasu OpenAI 兼容服务：只读模型列表验证网络与密钥。
  // 文本/图片生成都可能计费，连接测试不得提交生成请求。
  let isRehdasu = false;
  try { isRehdasu = new URL(base).hostname.toLowerCase() === 'rehdasu.cn'; } catch (_) {}
  if (provider === 'openai' && isRehdasu) {
    const res = await fetch(base + '/models', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + opts.api_key },
    });
    if (!res.ok) {
      const text = await res.text();
      let errMsg = `Rehdasu 连接失败 (${res.status})`;
      try {
        const data = JSON.parse(text);
        errMsg = data.error?.message || data.message || errMsg;
      } catch (_) {}
      throw new Error(errMsg);
    }
    return;
  }

  // DJPSD 视频：只读列表可同时验证网络和密钥，避免连接测试创建付费任务。
  if (provider === 'djpsd') {
    const root = base.replace(/\/v1$/i, '');
    const res = await fetch(root + '/api/v1/video-jobs?page=1&page_size=1', {
      method: 'GET',
      headers: { 'api-key': opts.api_key || '' },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data.code !== undefined && Number(data.code) !== 0)) {
      throw new Error(data.message || data.detail || `DJPSD 连接失败 (${res.status})`);
    }
    return;
  }

  // --- NanoBanana ---
  if (provider === 'nano_banana') {
    // 用 record-info 查询一个不存在的 taskId：401/403=key 无效，404=key 有效已联通
    const url = base + '/api/v1/nanobanana/record-info?taskId=test-connectivity';
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + (opts.api_key || '') },
    });
    if (res.status === 401 || res.status === 403) {
      const text = await res.text();
      let errMsg = `API Key 无效 (${res.status})`;
      try { const j = JSON.parse(text); errMsg = j.msg || j.message || errMsg; } catch {}
      throw new Error(errMsg);
    }
    return;
  }

  // --- Gemini ---
  if (provider === 'gemini' || provider === 'google') {
    endpoint = endpoint || '/v1beta/models/{model}:generateContent';
    const path = endpoint.replace(/{model}/g, model || 'gemini-pro');
    const url = base + (path.startsWith('/') ? path : '/' + path) + '?key=' + encodeURIComponent(opts.api_key || '');
    const body = { contents: [{ parts: [{ text: 'Hello' }] }] };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`请求失败: ${res.status} ${text.slice(0, 200)}`);
    }
    const data = await res.json().catch(() => ({}));
    if (data.candidates == null && data.error != null) {
      throw new Error(data.error.message || data.error || 'Gemini 返回错误');
    }
    return;
  }

  // --- MiniMax TTS 语音合成 ---
  if (serviceType === 'tts' && provider === 'minimax') {
    const probeUrl = base + '/get_voice';
    const probeBody = JSON.stringify({ voice_type: 'all' });
    const res = await fetch(probeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (opts.api_key || '') },
      body: probeBody,
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!res.ok || Number(data.base_resp?.status_code || 0) !== 0) {
      throw new Error(data.base_resp?.status_msg || data.error?.message || data.message || `MiniMax TTS 连接失败 (${res.status})`);
    }
    return;
  }

  // 其他 TTS 供应商保持原有探针协议，避免 MiniMax 接入改变既有配置行为。
  if (serviceType === 'tts') {
    const probeUrl = base + '/text_to_speech';
    const probeBody = JSON.stringify({ model: model || 'speech-02-hd', text: 'hi', stream: false });
    const res = await fetch(probeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (opts.api_key || '') },
      body: probeBody,
    });
    if (res.status === 401 || res.status === 403) {
      const text = await res.text();
      let errMsg = `API Key 无效 (${res.status})`;
      try {
        const data = JSON.parse(text);
        errMsg = data.base_resp?.status_msg || data.error?.message || data.message || errMsg;
      } catch (_) {}
      throw new Error(errMsg);
    }
    return;
  }

  // service_type 作为主要判断信号
  const isImageService = serviceType === 'image' || serviceType === 'storyboard_image';
  const isVideoService = serviceType === 'video';
  const hasImageEndpoint = !!(endpoint && endpoint.includes('/images/'));

  const isDashscope = provider === 'dashscope' || provider === 'qwen_image';
  const isVolcengine = provider === 'volces' || provider === 'volcengine' || provider === 'volc';
  const modelLower = model.toLowerCase();

  // 兜底识别图片/视频模型（service_type 未传时使用）
  const looksLikeImageModel = /seedream|image2video|text2image|img2img|wanx|wan\d|flux|stable.?diff|dall.?e|imagen|agnes-image|-image$/i.test(modelLower)
    || (isVolcengine && /seedream|vision|image/i.test(modelLower));
  const looksLikeVideoModel = /seedance|video.?gen|video2video|kf2v|cogvideo|sora|kling|agnes-video/i.test(modelLower);
  // DashScope 图片/视频专用端点特征
  const isDashscopeNonChatEndpoint = isDashscope && !!(endpoint && (endpoint.includes('aigc') || endpoint.includes('multimodal') || endpoint.includes('video')));

  // 综合判断是否为图片服务
  const treatAsImage = isImageService || hasImageEndpoint || isDashscopeNonChatEndpoint
    || looksLikeImageModel
    || (isVolcengine && !serviceType && !endpoint);

  // --- DashScope 图片 / 视频 / 分镜 ---
  // 通义万象 / WAN 系列：API key 通过 compatible-mode chat 接口验证即可（同一 key 通用）
  if (isDashscope && (isImageService || isVideoService || looksLikeImageModel || looksLikeVideoModel || isDashscopeNonChatEndpoint)) {
    const chatUrl = base.replace(/\/(api\/v1|compatible-mode)\/.*$/, '') + '/compatible-mode/v1/chat/completions';
    const body = { model: 'qwen-turbo', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 };
    console.log('[testConnection] DashScope 非文本服务，用 compatible chat 验证 key', { chatUrl, serviceType, model });
    const res = await fetch(chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + opts.api_key },
      body: JSON.stringify(body),
    });
    // 401/403 = key 无效，其他均视为联通
    if (res.status === 401 || res.status === 403) {
      const text = await res.text();
      let errMsg = `API Key 无效 (${res.status})`;
      try { const j = JSON.parse(text); errMsg = j.error?.message || j.message || errMsg; } catch {}
      throw new Error(errMsg);
    }
    return;
  }

  // --- 视频生成服务（非 DashScope）：通过 chat/completions 验证 key 合法性 ---
  // 视频生成 API 调用代价高昂，无法直接测试；但同账号 chat 接口验证 key 有效性即可
  if (isVideoService || looksLikeVideoModel) {
    const chatPath = '/chat/completions';
    const url = base + chatPath;
    const body = { model: model || '', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 };
    console.log('[testConnection] 视频服务，用 chat/completions 验证 key', { url, serviceType, model });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (opts.api_key || '') },
      body: JSON.stringify(body),
    });
    // 401/403 = key 无效；其他（400 模型不存在等）视为联通
    if (res.status === 401 || res.status === 403) {
      const text = await res.text();
      let errMsg = `API Key 无效 (${res.status})`;
      try { const j = JSON.parse(text); errMsg = j.error?.message || j.message || errMsg; } catch {}
      throw new Error(errMsg);
    }
    return;
  }

  // --- OpenAI 兼容图片生成（volcengine、OpenAI DALL·E、其他）---
  if (treatAsImage) {
    endpoint = endpoint || '/images/generations';
    const path = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
    const url = base + path;
    const body = { model: model || '', prompt: 'test connectivity', n: 1 };
    console.log('[testConnection] 图片服务', { url, serviceType, model, body });
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (opts.api_key || ''),
      },
      body: JSON.stringify(body),
    });
    // 401/403 = key 无效；其他状态（含 400 参数错误、429 限流等）表示已联通
    if (res.status === 401 || res.status === 403) {
      const text = await res.text();
      let errMsg = `API Key 无效 (${res.status})`;
      try {
        const j = JSON.parse(text);
        errMsg = j.error?.message || j.message || errMsg;
      } catch {}
      throw new Error(errMsg);
    }
    if (!res.ok) {
      // 其他 4xx/5xx：如果能解析出明确的 auth 错误才拒绝，否则视为联通
      const text = await res.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch {}
      const msg = parsed?.error?.message || parsed?.message || '';
      const lmsg = msg.toLowerCase();
      const isAuthErr = lmsg.includes('unauthorized') || lmsg.includes('invalid api key')
        || lmsg.includes('authentication') || lmsg.includes('forbidden');
      if (isAuthErr) throw new Error(`API Key 无效: ${msg || res.status}`);
      // 其他错误（如模型不支持某个 API 参数）说明网络通、key 有效
      return;
    }
    return;
  }

  // --- OpenAI / 默认：chat completions ---
  endpoint = endpoint || '/chat/completions';
  const path = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
  const url = base + path;
  let body = {
    model: model || 'gpt-3.5-turbo',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 5,
  };
  body = applyDeepSeekConnectivityOptions(
    { provider, base_url: base, settings: opts.settings },
    body
  );
  console.log('[testConnection] 文本/chat 服务', { url, serviceType, model });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (opts.api_key || ''),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    let errMsg = `请求失败: ${res.status}`;
    try {
      const j = JSON.parse(text);
      errMsg += ' - ' + (j.error?.message || j.message || j.error || text.slice(0, 150));
    } catch {
      if (text) errMsg += ' - ' + text.slice(0, 150);
    }
    throw new Error(errMsg);
  }
  const data = await res.json().catch(() => ({}));
  if (data.choices == null && data.error != null) {
    throw new Error(data.error.message || data.error || '接口返回错误');
  }
}

/**
 * 返回 vendor_lock 状态
 */
function getVendorLockStatus(cfg) {
  const lock = cfg?.vendor_lock;
  return {
    enabled: !!(lock?.enabled),
    config_file: lock?.config_file || '',
  };
}

/**
 * 启动时同步 vendor_lock 指定的配置文件到数据库。
 * - 软删除所有现有配置，按文件重新导入
 * - 若同 service_type + provider 在 DB 中已有记录，则保留用户修改过的 api_key
 */
function applyVendorLock(db, log, cfg) {
  const status = getVendorLockStatus(cfg);
  if (!status.enabled) return;

  const configFile = status.config_file;
  if (!configFile) {
    log.warn && log.warn('vendor_lock enabled but config_file is empty');
    return;
  }

  const candidates = [
    path.join(process.cwd(), 'configs', configFile),
    path.join(__dirname, '..', '..', 'configs', configFile),
  ];
  let raw = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) { raw = fs.readFileSync(p, 'utf8'); break; }
  }
  if (!raw) {
    console.warn('[vendor_lock] config file not found:', configFile);
    return;
  }

  let configs;
  try {
    configs = JSON.parse(raw);
    if (!Array.isArray(configs)) throw new Error('config file must be a JSON array');
  } catch (e) {
    console.error('[vendor_lock] failed to parse config file:', e.message);
    return;
  }

  // 保存现有 api_key（key: "service_type:provider"）
  const existing = db.prepare('SELECT service_type, provider, api_key FROM ai_service_configs WHERE deleted_at IS NULL').all();
  const savedKeys = new Map();
  for (const row of existing) {
    savedKeys.set(`${row.service_type}:${row.provider}`, row.api_key);
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE ai_service_configs SET deleted_at = ? WHERE deleted_at IS NULL').run(now);

  for (const item of configs) {
    const mapKey = `${item.service_type}:${item.provider}`;
    const apiKey = savedKeys.get(mapKey) ?? item.api_key ?? '';
    const model = Array.isArray(item.model)
      ? JSON.stringify(item.model)
      : item.model ? JSON.stringify([item.model]) : '[]';
    db.prepare(
      `INSERT INTO ai_service_configs
        (service_type, provider, api_protocol, name, base_url, api_key, model, default_model, endpoint, query_endpoint, priority, is_default, is_active, settings, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
    ).run(
      item.service_type || 'text',
      item.provider || '',
      item.api_protocol || '',
      item.name || '',
      item.base_url || '',
      apiKey,
      model,
      item.default_model || null,
      item.endpoint || '',
      item.query_endpoint || '',
      item.priority ?? 0,
      item.is_default ? 1 : 0,
      item.settings || null,
      now,
      now
    );
  }
  for (const item of configs) {
    console.log(`[vendor_lock] loaded: service_type=${item.service_type} provider=${item.provider} api_protocol=${item.api_protocol || '(auto)'} endpoint=${item.endpoint || '(auto)'}`);
  }
  console.log(`[vendor_lock] synced ${configs.length} configs from ${configFile}`);
}

/**
 * 批量替换所有配置的 api_key（仅限锁定模式下使用）
 */
function bulkUpdateApiKey(db, log, newKey) {
  const now = new Date().toISOString();
  const info = db.prepare(
    `UPDATE ai_service_configs
      SET api_key = ?,
          verification_status = 'unverified',
          verification_checked_at = NULL,
          verified_at = NULL,
          verification_error = NULL,
          verified_capabilities = '{}',
          updated_at = ?
      WHERE deleted_at IS NULL`
  ).run(newKey, now);
  log.info('Bulk update api_key', { updated: info.changes });
  return info.changes;
}

module.exports = {
  listConfigs,
  getConfig,
  createConfig,
  updateConfig,
  deleteConfig,
  recordVerification,
  testConnection,
  getVendorLockStatus,
  applyVendorLock,
  bulkUpdateApiKey,
  hasConnectionCredential,
  toPublicConfig,
  isVerifiedConfig,
  redactVerificationError,
  setVerificationResult,
};
