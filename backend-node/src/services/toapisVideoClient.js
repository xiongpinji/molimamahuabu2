const TOAPIS_VIDEO_COMMON_CAPABILITIES = Object.freeze({
  aspectRatios: Object.freeze(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive']),
  supportsFirstFrame: true,
  supportsLastFrame: true,
  supportsImageReference: true,
  supportsVideoReference: true,
  supportsAudioReference: true,
  supportsAudio: true,
});

const TOAPIS_VIDEO_MODELS = Object.freeze({
  'seedance-2-fast': Object.freeze({
    ...TOAPIS_VIDEO_COMMON_CAPABILITIES,
    durations: Object.freeze([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
    resolutions: Object.freeze(['480p', '720p']),
    maxReferences: 9,
    maxVideoReferences: 3,
    maxAudioReferences: 3,
  }),
  'seedance-2-mini': Object.freeze({
    ...TOAPIS_VIDEO_COMMON_CAPABILITIES,
    durations: Object.freeze([4, 8, 10, 12, 15]),
    resolutions: Object.freeze(['480p', '720p']),
    maxReferences: 9,
    maxVideoReferences: 3,
    maxAudioReferences: 3,
  }),
});

const TOAPIS_VIDEO_CAPABILITIES = TOAPIS_VIDEO_MODELS['seedance-2-mini'];

function normalizeToapisBaseUrl(value) {
  const raw = String(value || 'https://toapis.com').trim();
  const officialHosts = new Set(['toapis.com', 'toapis.xyz']);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new Error('ToAPIs 官方入口必须是 https://toapis.com 或 https://toapis.xyz');
  }
  const pathname = parsed.pathname.replace(/\/+$/, '') || '';
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || !officialHosts.has(parsed.hostname)
    || !['', '/v1'].includes(pathname)
  ) {
    throw new Error('ToAPIs 官方入口必须是 https://toapis.com 或 https://toapis.xyz');
  }
  return `https://${parsed.hostname}`;
}

function resolveToapisApiKey(config = {}, env = process.env) {
  return String(env.TOAPIS_API_KEY || config.api_key || '').trim();
}

function uniqueValues(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
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
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function parseIpv4MappedIpv6(hostname) {
  const match = String(hostname || '').toLowerCase().match(/^(?:::)?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return match ? parseIpv4Address(match[1]) : null;
}

function expandIpv6Address(hostname) {
  const value = String(hostname || '').toLowerCase();
  if (!value.includes(':')) return null;
  if (value.includes('.')) return null;
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
  const first = hextets[0];
  const isLoopback = hextets.slice(0, 7).every((part) => part === 0) && hextets[7] === 1;
  return isLoopback
    || (first >= 0xfc00 && first <= 0xfdff)
    || (first >= 0xfe80 && first <= 0xfebf);
}

function isLocalHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return normalized === 'localhost' || !normalized.includes('.');
}

function isPrivateOrLocalHost(hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return isLocalHostname(normalized)
    || isPrivateIpv4(parseIpv4Address(normalized))
    || isPrivateIpv6(normalized);
}

function assertPublicHttpsUrl(value, field) {
  const raw = String(value || '').trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new Error(`ToAPIs ${field} 必须是公网 HTTPS URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || isPrivateOrLocalHost(parsed.hostname)) {
    throw new Error(`ToAPIs ${field} 必须是公网 HTTPS URL`);
  }
  return raw;
}

function trustedAssetUrls(values) {
  return new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter((value) => /^asset:\/\/pa_[A-Za-z0-9_-]+$/.test(value)));
}

function assertReferenceUrl(value, field, trustedAssets) {
  const raw = String(value || '').trim();
  if (/^asset:/i.test(raw)) {
    if (/^asset:\/\/pa_[A-Za-z0-9_-]+$/.test(raw) && trustedAssets.has(raw)) return raw;
    throw new Error(`ToAPIs ${field} 必须是公网 HTTPS URL 或可信虚拟人像素材`);
  }
  return assertPublicHttpsUrl(raw, field);
}

function assertReferenceUrls(values, field, trustedAssets) {
  return values.map((value) => assertReferenceUrl(value, field, trustedAssets));
}

function validateToapisVideoOptions(opts = {}) {
  const model = String(opts.model || '').trim();
  const spec = TOAPIS_VIDEO_MODELS[model];
  if (!spec) throw new Error(`ToAPIs 模型 ${model || '(empty)'} 未开放，禁止提交`);
  const prompt = String(opts.prompt || '').trim();
  if (!prompt) throw new Error('ToAPIs 视频提示词不能为空');
  const resolution = String(opts.resolution || '720p').trim().toLowerCase();
  if (!spec.resolutions.includes(resolution)) {
    throw new Error(`ToAPIs 模型 ${model} 不支持 ${resolution}；只开放 ${spec.resolutions.join('、')}`);
  }
  const duration = Number(opts.duration ?? spec.durations[0]);
  if (!Number.isSafeInteger(duration) || !spec.durations.includes(duration)) {
    throw new Error(`ToAPIs 模型 ${model} 不支持 ${duration} 秒；只开放 ${spec.durations.join('、')} 秒`);
  }
  const aspectRatio = String(opts.aspect_ratio || '16:9').trim().replace('：', ':');
  if (!spec.aspectRatios.includes(aspectRatio)) {
    throw new Error(`ToAPIs Seedance 2 不支持画幅 ${aspectRatio}`);
  }

  const trustedAssets = trustedAssetUrls(opts.trusted_asset_urls);
  const firstFrameRaw = String(opts.first_frame_url || opts.image_url || '').trim();
  const lastFrameRaw = String(opts.last_frame_url || '').trim();
  const images = assertReferenceUrls(uniqueValues(opts.reference_urls), '参考图', trustedAssets);
  const videos = assertReferenceUrls(uniqueValues(opts.reference_video_urls), '参考视频', trustedAssets);
  const audio = assertReferenceUrls(uniqueValues([
    ...(Array.isArray(opts.reference_audio_urls) ? opts.reference_audio_urls : []),
    opts.voice_reference_url,
  ]), '参考音频', trustedAssets);
  const firstFrame = firstFrameRaw ? assertReferenceUrl(firstFrameRaw, '首帧', trustedAssets) : '';
  const lastFrame = lastFrameRaw ? assertReferenceUrl(lastFrameRaw, '尾帧', trustedAssets) : '';
  if (images.length > spec.maxReferences) throw new Error(`ToAPIs 模型 ${model} 最多支持 ${spec.maxReferences} 张参考图`);
  if (videos.length > spec.maxVideoReferences) throw new Error(`ToAPIs 模型 ${model} 最多支持 ${spec.maxVideoReferences} 个参考视频`);
  if (audio.length > spec.maxAudioReferences) throw new Error(`ToAPIs 模型 ${model} 最多支持 ${spec.maxAudioReferences} 个参考音频`);
  if ((firstFrame || lastFrame) && (images.length || videos.length || audio.length)) {
    throw new Error('ToAPIs 首尾帧模式与多模态参考模式互斥');
  }
  if (lastFrame && !firstFrame) throw new Error('ToAPIs 尾帧必须与首帧一起使用');
  if (audio.length && !images.length && !videos.length) throw new Error('ToAPIs 参考音频不能单独使用');
  return { model, spec, prompt, resolution, duration, aspectRatio, firstFrame, lastFrame, images, videos, audio };
}

function buildToapisVideoBody(opts = {}) {
  const checked = validateToapisVideoOptions(opts);
  const body = {
    model: checked.model,
    prompt: checked.prompt,
    duration: checked.duration,
    aspect_ratio: checked.aspectRatio,
    resolution: checked.resolution,
    generate_audio: opts.generate_audio === true,
  };
  if (opts.client_business_id) body.client_business_id = String(opts.client_business_id);
  const imageWithRoles = [];
  if (checked.firstFrame) imageWithRoles.push({ url: checked.firstFrame, role: 'first_frame' });
  if (checked.lastFrame) imageWithRoles.push({ url: checked.lastFrame, role: 'last_frame' });
  for (const url of checked.images) imageWithRoles.push({ url, role: 'reference_image' });
  if (imageWithRoles.length) body.image_with_roles = imageWithRoles;
  if (checked.videos.length) body.video_with_roles = checked.videos.map((url) => ({ url, role: 'reference_video' }));
  if (checked.audio.length) body.audio_with_roles = checked.audio.map((url) => ({ url, role: 'reference_audio' }));
  return body;
}

function parseJson(raw) {
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function extractError(payload) {
  const candidates = [
    payload?.error?.message,
    typeof payload?.error === 'string' ? payload.error : null,
    payload?.message,
    payload?.detail,
  ];
  return String(candidates.find((value) => value != null && String(value).trim()) || '').trim();
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

function formatProviderError(payload) {
  const code = String(payload?.error?.code || payload?.code || '').trim();
  const message = extractError(payload);
  if (/PrivacyInformation|real person/i.test(`${code} ${message}`)) {
    return '该供应商禁止使用疑似真人参考图，请改用非真人或卡通素材，或切换其他已验证模型；本次未生成';
  }
  return sanitizeProviderMessage(message);
}

function indeterminateCreateError(message, routeMeta = {}) {
  return {
    indeterminate: true,
    error: `ToAPIs 创建请求结果未知，供应商可能已受理或扣费但本平台未取得 task_id；为避免重复扣费，不得自动重试。${message || ''}`.trim(),
    route_meta: { phase: 'submit', requestBodySent: true, ...routeMeta },
  };
}

function parseToapisVideoStatus(payload) {
  const status = String(payload?.status || payload?.data?.status || '').trim().toLowerCase();
  const progressRaw = payload?.progress ?? payload?.data?.progress;
  const progress = Number.isFinite(Number(progressRaw)) ? Number(progressRaw) : null;
  const data = Array.isArray(payload?.result?.data)
    ? payload.result.data
    : Array.isArray(payload?.data?.result?.data)
      ? payload.data.result.data
      : [];
  const videoUrl = data.map((item) => String(item?.url || item?.video_url || '').trim())
    .find((url) => /^https?:\/\//i.test(url));
  if (videoUrl) return { state: 'completed', videoUrl, progress };
  if (['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(status)) {
    return { state: 'failed', error: extractError(payload) || 'ToAPIs 视频生成失败', progress };
  }
  if (status === 'completed' || status === 'succeeded' || status === 'success') {
    return { state: 'failed', error: 'ToAPIs 任务完成但未返回视频地址', progress };
  }
  return { state: 'processing', progress };
}

const parseToapisTask = parseToapisVideoStatus;

async function readJsonResponse(response) {
  let raw = '';
  try {
    raw = await response.text();
  } catch (_) {
    return { raw: '', payload: null };
  }
  return { raw, payload: parseJson(raw) };
}

async function callToapisVideoApi(config, log, opts = {}, requestOpts = {}) {
  const apiKey = resolveToapisApiKey(config);
  if (!apiKey) return {
    error: 'ToAPIs API Key 未配置',
    route_meta: { phase: 'validation', requestBodySent: false, providerCode: 'AUTH_INVALID', explicitlyRejected: true },
  };
  let body;
  try {
    body = buildToapisVideoBody(opts);
  } catch (error) {
    return {
      error: error.message,
      route_meta: { phase: 'validation', requestBodySent: false, providerCode: 'INVALID_ARGUMENT', explicitlyRejected: true },
    };
  }
  let baseUrl;
  try {
    baseUrl = normalizeToapisBaseUrl(config?.base_url);
  } catch (error) {
    return {
      error: error.message,
      route_meta: { phase: 'validation', requestBodySent: false, providerCode: 'INVALID_ARGUMENT', explicitlyRejected: true },
    };
  }
  const recoveryTaskId = String(body.client_business_id || '').trim();
  const recoveryRouteMeta = recoveryTaskId ? { recoveryTaskId } : {};
  const url = `${baseUrl}/v1/videos/generations`;
  const fetchImpl = requestOpts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return {
    error: 'ToAPIs fetch 不可用',
    route_meta: { phase: 'connect', requestBodySent: false },
  };
  log?.info?.('[ToAPIs 视频] 创建任务', {
    video_gen_id: opts.video_gen_id,
    model: body.model,
    duration: body.duration,
    aspect_ratio: body.aspect_ratio,
    resolution: body.resolution,
    image_reference_count: body.image_with_roles?.length || 0,
    video_reference_count: body.video_with_roles?.length || 0,
    audio_reference_count: body.audio_with_roles?.length || 0,
  });
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return indeterminateCreateError('连接中断。', {
      transportCode: error?.cause?.code || error?.code,
      ...recoveryRouteMeta,
      recoveryCode: 'TOAPIS_TRANSPORT_INTERRUPTED',
    });
  }
  const { raw, payload } = await readJsonResponse(response);
  if (!response.ok) {
    if (response.status === 408 || response.status >= 500) {
      return indeterminateCreateError(`HTTP ${response.status}。`, {
        httpStatus: response.status,
        ...recoveryRouteMeta,
        recoveryCode: 'TOAPIS_HTTP_STATUS_UNKNOWN',
      });
    }
    if (!payload) return indeterminateCreateError(`HTTP ${response.status} 返回非 JSON 响应。`, {
      httpStatus: response.status,
      ...recoveryRouteMeta,
      recoveryCode: 'TOAPIS_NON_JSON_RESPONSE',
    });
    const message = formatProviderError(payload);
    return {
      error: `ToAPIs 创建视频任务失败 (${response.status})${message ? `: ${message}` : ''}`,
      route_meta: {
        phase: 'submit',
        requestBodySent: true,
        httpStatus: response.status,
        providerCode: String(payload?.error?.code || payload?.code || '').trim() || undefined,
        explicitlyRejected: [400, 401, 413, 422, 429].includes(Number(response.status)),
      },
    };
  }
  if (!payload) return indeterminateCreateError('返回非 JSON 响应。', {
    httpStatus: response.status,
    ...recoveryRouteMeta,
    recoveryCode: 'TOAPIS_NON_JSON_RESPONSE',
  });
  const taskId = payload.id ?? payload.task_id ?? payload?.data?.id ?? payload?.data?.task_id;
  if (taskId == null || String(taskId).trim() === '') {
    return indeterminateCreateError('未取得 task_id。', {
      httpStatus: response.status,
      ...recoveryRouteMeta,
      recoveryCode: 'TOAPIS_TASK_ID_MISSING',
    });
  }
  return {
    task_id: String(taskId),
    status: String(payload.status || payload?.data?.status || 'processing').toLowerCase(),
    route_meta: { httpStatus: response.status, providerTaskId: String(taskId) },
  };
}

async function fetchToapisTask(config, taskId, opts = {}) {
  const apiKey = resolveToapisApiKey(config);
  if (!apiKey) return { state: 'failed', error: 'ToAPIs API Key 未配置' };
  const id = String(taskId || '').trim();
  if (!id) return { state: 'failed', error: 'ToAPIs task_id 不能为空' };
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { state: 'failed', error: 'ToAPIs fetch 不可用' };
  let baseUrl;
  try {
    baseUrl = normalizeToapisBaseUrl(config?.base_url);
  } catch (error) {
    return { state: 'failed', error: error.message };
  }
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/v1/videos/generations/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (_) {
    return { state: 'processing', retryable: true, error: 'ToAPIs 查询连接中断，可稍后重试' };
  }
  const { raw, payload } = await readJsonResponse(response);
  if (!payload) {
    return { state: 'processing', retryable: true, error: `ToAPIs 查询返回非 JSON 响应 (${response.status || 'unknown'})` };
  }
  if (!response.ok) {
    const message = formatProviderError(payload);
    return { state: 'failed', error: `ToAPIs 查询任务失败 (${response.status})${message ? `: ${message}` : ''}` };
  }
  return parseToapisTask(payload);
}

module.exports = {
  TOAPIS_VIDEO_CAPABILITIES,
  TOAPIS_VIDEO_MODELS,
  normalizeToapisBaseUrl,
  resolveToapisApiKey,
  validateToapisVideoOptions,
  buildToapisVideoBody,
  parseToapisTask,
  parseToapisVideoStatus,
  callToapisVideoApi,
  fetchToapisTask,
};
