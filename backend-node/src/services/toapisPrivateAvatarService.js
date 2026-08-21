'use strict';

const { normalizeToapisBaseUrl, resolveToapisApiKey } = require('./toapisVideoClient');

const PRIVATE_AVATAR_PREFIX = '/v1/videos/doubao-seedance-2-0/private-avatar';
const ALLOWED_ASSET_TYPES = new Set(['image', 'video', 'audio']);

function serviceError(code, message) {
  return Object.assign(new Error(message), { code });
}

function sanitizeProviderMessage(value) {
  return String(value || '')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, '[redacted]')
    .replace(/(["']?\b(?:api[_-]?key|access_token|token|key)\b["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]+["']?/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url-redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function parseJson(raw) {
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function payloadMessage(payload) {
  return sanitizeProviderMessage(
    payload?.error?.message
      || (typeof payload?.error === 'string' ? payload.error : '')
      || payload?.message
      || payload?.detail
      || '',
  );
}

function assertPublicHttpsUrl(value) {
  const raw = String(value || '').trim();
  let parsed;
  try { parsed = new URL(raw); } catch (_) {
    throw serviceError('TOAPIS_AVATAR_INVALID_REQUEST', 'ToAPIs 虚拟人像素材必须使用公网 HTTPS URL');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
      || hostname === 'localhost' || !hostname.includes('.')
      || /^(?:0|10|127|169\.254|192\.168)\./.test(hostname)
      || /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname)
      || hostname === '::1' || /^(?:fc|fd|fe8|fe9|fea|feb)/i.test(hostname)) {
    throw serviceError('TOAPIS_AVATAR_INVALID_REQUEST', 'ToAPIs 虚拟人像素材必须使用公网 HTTPS URL');
  }
  return raw;
}

function assertIdentifier(value, prefix, field) {
  const normalized = String(value || '').trim();
  if (!new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`).test(normalized)) {
    throw serviceError('TOAPIS_AVATAR_INVALID_RESPONSE', `ToAPIs 虚拟人像未返回有效 ${field}`);
  }
  return normalized;
}

function normalizedAsset(payload, requireActiveUrl = false) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const assetId = assertIdentifier(data?.asset_id, 'pa', 'asset_id');
  const assetUrl = String(data?.asset_url || `asset://${assetId}`).trim();
  if (assetUrl !== `asset://${assetId}`) {
    throw serviceError('TOAPIS_AVATAR_INVALID_RESPONSE', 'ToAPIs 虚拟人像未返回匹配的 asset_url');
  }
  const status = String(data?.status || '').trim().toLowerCase();
  if (!['processing', 'active', 'failed'].includes(status)) {
    throw serviceError('TOAPIS_AVATAR_INVALID_RESPONSE', 'ToAPIs 虚拟人像返回了未知状态');
  }
  if (requireActiveUrl && status === 'active' && !assetUrl) {
    throw serviceError('TOAPIS_AVATAR_INVALID_RESPONSE', 'ToAPIs 虚拟人像 active 状态缺少 asset_url');
  }
  return {
    asset_id: assetId,
    asset_url: assetUrl,
    group_id: data?.group_id ? assertIdentifier(data.group_id, 'pg', 'group_id') : null,
    status,
    message: payloadMessage(data),
  };
}

async function requestJson(config, path, init, options = {}) {
  const apiKey = resolveToapisApiKey(config);
  if (!apiKey) throw serviceError('TOAPIS_AVATAR_KEY_MISSING', 'ToAPIs API Key 未配置');
  const baseUrl = normalizeToapisBaseUrl(config?.base_url);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw serviceError('TOAPIS_AVATAR_FETCH_UNAVAILABLE', 'ToAPIs fetch 不可用');
  let response;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch (_) {
    const code = options.submission
      ? 'TOAPIS_AVATAR_SUBMISSION_INDETERMINATE'
      : 'TOAPIS_AVATAR_QUERY_RETRYABLE';
    throw serviceError(code, options.submission
      ? 'ToAPIs 虚拟人像提交结果未知，为避免重复创建已停止自动重试'
      : 'ToAPIs 虚拟人像状态查询连接中断，请稍后重试');
  }
  let raw = '';
  try { raw = await response.text(); } catch (_) {}
  const payload = parseJson(raw);
  if (!response.ok) {
    if (options.submission && (response.status === 408 || response.status >= 500)) {
      throw serviceError(
        'TOAPIS_AVATAR_SUBMISSION_INDETERMINATE',
        `ToAPIs 虚拟人像提交结果未知 (HTTP ${response.status})，为避免重复创建已停止自动重试`,
      );
    }
    const message = payloadMessage(payload);
    throw serviceError(
      response.status >= 500 ? 'TOAPIS_AVATAR_QUERY_RETRYABLE' : 'TOAPIS_AVATAR_REJECTED',
      `ToAPIs 虚拟人像请求失败 (HTTP ${response.status})${message ? `: ${message}` : ''}`,
    );
  }
  if (!payload) {
    const code = options.submission
      ? 'TOAPIS_AVATAR_SUBMISSION_INDETERMINATE'
      : 'TOAPIS_AVATAR_INVALID_RESPONSE';
    throw serviceError(code, options.submission
      ? 'ToAPIs 虚拟人像提交返回非 JSON，结果未知，已停止自动重试'
      : 'ToAPIs 虚拟人像查询返回非 JSON');
  }
  return payload;
}

async function createPrivateAvatarGroup(config, input = {}, options = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw serviceError('TOAPIS_AVATAR_INVALID_REQUEST', 'ToAPIs 虚拟人像素材组名称不能为空');
  const body = { name };
  const description = String(input.description || '').trim();
  if (description) body.description = description;
  const payload = await requestJson(config, `${PRIVATE_AVATAR_PREFIX}/groups`, {
    method: 'POST',
    body: JSON.stringify(body),
  }, { ...options, submission: true });
  return { group_id: assertIdentifier(payload?.data?.group_id, 'pg', 'group_id') };
}

async function createPrivateAvatarAsset(config, input = {}, options = {}) {
  const groupId = assertIdentifier(input.group_id, 'pg', 'group_id');
  const assetType = String(input.asset_type || '').trim().toLowerCase();
  if (!ALLOWED_ASSET_TYPES.has(assetType)) {
    throw serviceError('TOAPIS_AVATAR_INVALID_REQUEST', 'ToAPIs 虚拟人像素材类型只支持 image、video、audio');
  }
  const body = {
    group_id: groupId,
    asset_type: assetType,
    source_url: assertPublicHttpsUrl(input.source_url),
  };
  const name = String(input.name || '').trim();
  const description = String(input.description || '').trim();
  if (name) body.name = name;
  if (description) body.description = description;
  const payload = await requestJson(config, `${PRIVATE_AVATAR_PREFIX}/assets`, {
    method: 'POST',
    body: JSON.stringify(body),
  }, { ...options, submission: true });
  const asset = normalizedAsset(payload);
  if (asset.group_id && asset.group_id !== groupId) {
    throw serviceError('TOAPIS_AVATAR_INVALID_RESPONSE', 'ToAPIs 虚拟人像返回的 group_id 不匹配');
  }
  return { ...asset, group_id: groupId };
}

async function fetchPrivateAvatarAsset(config, assetId, options = {}) {
  const id = assertIdentifier(assetId, 'pa', 'asset_id');
  const payload = await requestJson(
    config,
    `${PRIVATE_AVATAR_PREFIX}/assets/${encodeURIComponent(id)}`,
    { method: 'GET' },
    { ...options, submission: false },
  );
  const asset = normalizedAsset(payload, true);
  if (asset.asset_id !== id) {
    throw serviceError('TOAPIS_AVATAR_INVALID_RESPONSE', 'ToAPIs 虚拟人像查询返回的 asset_id 不匹配');
  }
  return asset;
}

function publicAsset(row) {
  return {
    asset_id: row.asset_id,
    asset_url: row.asset_url,
    group_id: row.group_id,
    status: row.status,
  };
}

function setRowError(db, id, status, error) {
  const now = new Date().toISOString();
  db.prepare(`UPDATE toapis_private_avatar_assets
    SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?`)
    .run(status, sanitizeProviderMessage(error?.message || error), now, id);
}

async function ensurePrivateAvatarAsset(db, config, input = {}, options = {}) {
  const configId = Number(config?.id);
  const dramaId = Number(input.dramaId);
  const sourceId = Number(input.sourceId);
  const sourceKind = String(input.sourceKind || '').trim();
  const assetType = String(input.assetType || 'image').trim().toLowerCase();
  if (!Number.isSafeInteger(configId) || configId <= 0
      || !Number.isSafeInteger(dramaId) || dramaId <= 0
      || !Number.isSafeInteger(sourceId) || sourceId <= 0
      || !['image_generation', 'asset'].includes(sourceKind)
      || !ALLOWED_ASSET_TYPES.has(assetType)) {
    throw serviceError('TOAPIS_AVATAR_INVALID_REQUEST', 'ToAPIs 虚拟人像缺少可信的平台素材绑定');
  }
  const sourceUrl = assertPublicHttpsUrl(input.sourceUrl);
  const select = db.prepare(`SELECT * FROM toapis_private_avatar_assets
    WHERE ai_service_config_id = ? AND source_kind = ? AND source_id = ? AND asset_type = ?`);
  let row = select.get(configId, sourceKind, sourceId, assetType);
  if (row?.status === 'active') return publicAsset(row);
  if (row?.status === 'failed') {
    throw serviceError('TOAPIS_AVATAR_REJECTED', row.error_msg || 'ToAPIs 虚拟人像素材处理失败');
  }
  if (row?.status === 'needs_attention') {
    throw serviceError(
      'TOAPIS_AVATAR_SUBMISSION_INDETERMINATE',
      row.error_msg || 'ToAPIs 虚拟人像提交结果未知，禁止自动重复提交',
    );
  }

  let ownsCreation = false;
  if (!row) {
    const now = new Date().toISOString();
    const inserted = db.prepare(`INSERT OR IGNORE INTO toapis_private_avatar_assets
      (ai_service_config_id, drama_id, source_kind, source_id, source_url, asset_type,
       status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'preparing', ?, ?)`)
      .run(configId, dramaId, sourceKind, sourceId, sourceUrl, assetType, now, now);
    ownsCreation = inserted.changes === 1;
    row = select.get(configId, sourceKind, sourceId, assetType);
  }

  if (ownsCreation) {
    try {
      const group = await createPrivateAvatarGroup(config, {
        name: `drama-${dramaId}-${sourceKind}-${sourceId}`,
        description: '茉莉妈妈 AI 虚拟人物素材',
      }, options);
      db.prepare(`UPDATE toapis_private_avatar_assets
        SET group_id = ?, status = 'creating_asset', updated_at = ? WHERE id = ?`)
        .run(group.group_id, new Date().toISOString(), row.id);
      const created = await createPrivateAvatarAsset(config, {
        group_id: group.group_id,
        asset_type: assetType,
        source_url: sourceUrl,
        name: `${sourceKind.replace(/_/g, '-')}-${sourceId}`,
      }, options);
      db.prepare(`UPDATE toapis_private_avatar_assets
        SET asset_id = ?, asset_url = ?, status = ?, error_msg = NULL, updated_at = ? WHERE id = ?`)
        .run(created.asset_id, created.asset_url, created.status, new Date().toISOString(), row.id);
      row = select.get(configId, sourceKind, sourceId, assetType);
    } catch (error) {
      setRowError(
        db,
        row.id,
        error?.code === 'TOAPIS_AVATAR_SUBMISSION_INDETERMINATE' ? 'needs_attention' : 'failed',
        error,
      );
      throw error;
    }
  } else if (row?.status === 'preparing' || row?.status === 'creating_asset') {
    throw serviceError('TOAPIS_AVATAR_NOT_READY', 'ToAPIs 虚拟人像素材正在创建，请稍后重试');
  }

  const maxPolls = Math.max(1, Number.isSafeInteger(Number(options.maxPolls)) ? Number(options.maxPolls) : 60);
  const pollIntervalMs = Math.max(0, Number.isFinite(Number(options.pollIntervalMs))
    ? Number(options.pollIntervalMs)
    : 5000);
  const sleep = options.sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    if (row.status === 'active') return publicAsset(row);
    if (!row.asset_id) throw serviceError('TOAPIS_AVATAR_NOT_READY', 'ToAPIs 虚拟人像素材缺少 asset_id');
    if (attempt > 0 && pollIntervalMs > 0) await sleep(pollIntervalMs);
    let checked;
    try {
      checked = await fetchPrivateAvatarAsset(config, row.asset_id, options);
    } catch (error) {
      if (error?.code === 'TOAPIS_AVATAR_QUERY_RETRYABLE' && attempt + 1 < maxPolls) continue;
      throw error;
    }
    const now = new Date().toISOString();
    if (checked.status === 'failed') {
      const message = checked.message || 'ToAPIs 虚拟人像素材处理失败';
      db.prepare(`UPDATE toapis_private_avatar_assets
        SET status = 'failed', error_msg = ?, updated_at = ? WHERE id = ?`)
        .run(message, now, row.id);
      throw serviceError('TOAPIS_AVATAR_REJECTED', `ToAPIs 虚拟人像素材处理失败${checked.message ? `: ${checked.message}` : ''}`);
    }
    db.prepare(`UPDATE toapis_private_avatar_assets
      SET group_id = COALESCE(?, group_id), asset_url = ?, status = ?, error_msg = NULL,
          activated_at = CASE WHEN ? = 'active' THEN ? ELSE activated_at END, updated_at = ?
      WHERE id = ?`)
      .run(checked.group_id, checked.asset_url, checked.status, checked.status, now, now, row.id);
    row = select.get(configId, sourceKind, sourceId, assetType);
  }
  throw serviceError('TOAPIS_AVATAR_NOT_READY', 'ToAPIs 虚拟人像素材仍在处理中，请稍后重试');
}

module.exports = {
  createPrivateAvatarGroup,
  createPrivateAvatarAsset,
  fetchPrivateAvatarAsset,
  ensurePrivateAvatarAsset,
};
