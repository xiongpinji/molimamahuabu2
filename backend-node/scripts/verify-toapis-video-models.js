const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const {
  TOAPIS_VIDEO_MODELS,
  buildToapisVideoBody,
  callToapisVideoApi,
  fetchToapisTask,
  normalizeToapisBaseUrl,
} = require('../src/services/toapisVideoClient');
const { loadConfig } = require('../src/config');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiConfigService = require('../src/services/aiConfigService');

const BASE_URL = 'https://toapis.cn';
const STATE_VERSION = 'toapis-video-verification-state-v1';
const EVIDENCE_VERSION = 'toapis-video-real-verification-v1';
const LOG = { info() {}, warn() {}, error() {} };
const PUBLIC_PRICE_FLOORS = Object.freeze({
  'seedance-2-fast|480p': 0.584,
  'seedance-2-fast|720p': 0.584,
  'seedance-2-mini|480p': 0.3358,
  'seedance-2-mini|720p': 0.6789,
});
const REQUIRED_MATRIX = Object.freeze([
  Object.freeze({ id: 'fast-t2v-480', model: 'seedance-2-fast', mode: 't2v', resolution: '480p', duration: 5, generateAudio: true }),
  Object.freeze({ id: 'fast-t2v-720', model: 'seedance-2-fast', mode: 't2v', resolution: '720p', duration: 5, generateAudio: false }),
  Object.freeze({ id: 'mini-t2v-480', model: 'seedance-2-mini', mode: 't2v', resolution: '480p', duration: 4, generateAudio: true }),
  Object.freeze({ id: 'mini-t2v-720', model: 'seedance-2-mini', mode: 't2v', resolution: '720p', duration: 4, generateAudio: false }),
  Object.freeze({ id: 'fast-first-last-480', model: 'seedance-2-fast', mode: 'first-last', resolution: '480p', duration: 4, generateAudio: false }),
  Object.freeze({ id: 'mini-first-last-480', model: 'seedance-2-mini', mode: 'first-last', resolution: '480p', duration: 4, generateAudio: false }),
  Object.freeze({ id: 'fast-omni-480', model: 'seedance-2-fast', mode: 'omni', resolution: '480p', duration: 4, generateAudio: false }),
  Object.freeze({ id: 'mini-omni-480', model: 'seedance-2-mini', mode: 'omni', resolution: '480p', duration: 4, generateAudio: false }),
]);

function buildRequiredMatrix() {
  return REQUIRED_MATRIX.map((item) => ({ ...item }));
}

function selectVerificationCases(selector = process.env.TOAPIS_VERIFY_CASES) {
  const requested = String(selector || '').split(/[;,]/).map((value) => value.trim()).filter(Boolean);
  if (!requested.length) return buildRequiredMatrix();
  if (new Set(requested).size !== requested.length) throw new Error('验证用例不能重复');
  const allowed = new Map(REQUIRED_MATRIX.map((item) => [item.id, item]));
  return requested.map((id) => {
    const item = allowed.get(id);
    if (!item) throw new Error(`未知验证用例: ${id}`);
    return { ...item };
  });
}

function publicReferences(env = process.env) {
  return {
    firstFrameUrl: String(env.TOAPIS_VERIFY_FIRST_FRAME_URL || '').trim(),
    lastFrameUrl: String(env.TOAPIS_VERIFY_LAST_FRAME_URL || '').trim(),
    referenceImageUrl: String(env.TOAPIS_VERIFY_REFERENCE_IMAGE_URL || '').trim(),
    referenceVideoUrl: String(env.TOAPIS_VERIFY_REFERENCE_VIDEO_URL || '').trim(),
    referenceAudioUrl: String(env.TOAPIS_VERIFY_REFERENCE_AUDIO_URL || '').trim(),
  };
}

function buildVerificationOptions(item, refs = {}, runId = '') {
  if (!item || !REQUIRED_MATRIX.some((entry) => entry.id === item.id)) throw new Error('未知验证用例');
  const normalizedRunId = String(runId || '').trim();
  const runSuffix = normalizedRunId
    ? `-${crypto.createHash('sha256').update(normalizedRunId).digest('hex').slice(0, 16)}`
    : '';
  const options = {
    model: item.model,
    prompt: item.mode === 'omni'
      ? '保持图片1主体形象，参考视频1的镜头运动与音频1的节奏，生成一段稳定连贯的电影感短视频。'
      : item.mode === 'first-last'
        ? '从首帧自然运动到尾帧，主体与环境连续，镜头稳定，电影感。'
        : '雨后森林中的橙色小猫沿石板路缓慢前行，镜头平稳跟随，电影感，无文字。',
    resolution: item.resolution,
    duration: item.duration,
    aspect_ratio: '16:9',
    generate_audio: item.generateAudio === true,
    client_business_id: `moli-verify-${item.id}${runSuffix}`,
  };
  if (item.mode === 'first-last') {
    options.first_frame_url = refs.firstFrameUrl;
    options.last_frame_url = refs.lastFrameUrl;
  } else if (item.mode === 'omni') {
    options.reference_urls = [refs.referenceImageUrl];
    options.reference_video_urls = [refs.referenceVideoUrl];
    options.reference_audio_urls = [refs.referenceAudioUrl];
  }
  return options;
}

function buildVerificationRequest(item, refs = {}, runId = '') {
  return buildToapisVideoBody(buildVerificationOptions(item, refs, runId));
}

function decideResumeAction(entry) {
  if (!entry) return 'submit';
  if (entry.status === 'completed' && entry.artifact?.sha256
      && Number(entry.billing?.debited_balance) > 0
      && Number(entry.billing?.debited_credits) > 0
      && Number(entry.billing?.cost_yuan) > 0) return 'complete';
  if (entry.artifact?.sha256 && entry.provider_task_id) return 'finalize';
  if (entry.provider_task_id) return 'poll';
  if (['submitting', 'indeterminate'].includes(entry.submission_state)) return 'stop-indeterminate';
  return 'submit';
}

function redactEvidence(value) {
  if (Array.isArray(value)) return value.map(redactEvidence);
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (/(?:authorization|api[_-]?key|access[_-]?token|^token$|request[_-]?headers|^headers$)/i.test(key)) continue;
      output[key] = redactEvidence(item);
    }
    return output;
  }
  if (typeof value !== 'string') return value;
  return value
    .replace(/\bBearer\s+[^\s"'<>]+/gi, '[redacted]')
    .replace(/authorization\s*[:=]\s*[^\s,;]+/gi, '[redacted]')
    .replace(/(api[_-]?key|access[_-]?token|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}

function round(value, precision = 6) {
  const factor = 10 ** precision;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function nowDate(deps = {}) {
  const value = deps.now ? deps.now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('ToAPIs 验证时间无效');
  return date;
}

function elapsedMs(startedAt, completedAt) {
  return Math.max(0, Math.round(completedAt.getTime() - startedAt.getTime()));
}

function ceilDecimalProduct(value, multiplier) {
  const text = String(value);
  if (!/^\d+(?:\.\d+)?$/.test(text) || !Number.isInteger(multiplier) || multiplier <= 0) return NaN;
  const [whole, fraction = ''] = text.split('.');
  const scale = 10n ** BigInt(fraction.length);
  const numerator = BigInt(`${whole}${fraction}`) * BigInt(multiplier);
  return Number((numerator + scale - 1n) / scale);
}

function calculateBalanceDelta(before, after) {
  const usedBalanceBefore = Number(before?.used_balance);
  const usedBalanceAfter = Number(after?.used_balance);
  const usedCreditsBefore = Number(before?.used_credits);
  const usedCreditsAfter = Number(after?.used_credits);
  const debitedBalance = round(usedBalanceAfter - usedBalanceBefore);
  const debitedCredits = round(usedCreditsAfter - usedCreditsBefore);
  if (!Number.isFinite(debitedBalance) || !Number.isFinite(debitedCredits)
      || debitedBalance <= 0 || debitedCredits <= 0) {
    throw new Error('未取得可绑定到本任务的真实扣费证据');
  }
  const creditsPerUsd = Number(after?.credits_per_usd ?? before?.credits_per_usd);
  return {
    debited_balance: debitedBalance,
    debited_credits: debitedCredits,
    credits_per_usd: Number.isFinite(creditsPerUsd) && creditsPerUsd > 0 ? creditsPerUsd : null,
  };
}

function parseFfprobeJson(raw) {
  let payload;
  try { payload = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) {
    throw new Error('ffprobe 返回无效 JSON');
  }
  const streams = Array.isArray(payload?.streams) ? payload.streams : [];
  const video = streams.find((item) => item?.codec_type === 'video');
  if (!video || !Number(video.width) || !Number(video.height)) throw new Error('ffprobe 未找到有效视频流');
  const audio = streams.find((item) => item?.codec_type === 'audio');
  const duration = Number(video.duration ?? payload?.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('ffprobe 未取得有效时长');
  return {
    format: String(payload?.format?.format_name || ''),
    width: Number(video.width),
    height: Number(video.height),
    duration_seconds: round(duration),
    video_codec: String(video.codec_name || ''),
    has_audio: Boolean(audio),
    audio_codec: audio ? String(audio.codec_name || '') : null,
  };
}

function assertResolutionBand(resolution, ffprobe) {
  const shortEdge = Math.min(Number(ffprobe?.width) || 0, Number(ffprobe?.height) || 0);
  if (resolution === '480p' && shortEdge >= 400 && shortEdge <= 576) return;
  if (resolution === '720p' && shortEdge >= 640 && shortEdge <= 800) return;
  throw new Error(`${resolution} 结果尺寸不在对应档位: ${ffprobe?.width}x${ffprobe?.height}`);
}

function hasExactRoles(items, expectedRoles) {
  if (!Array.isArray(items) || items.length !== expectedRoles.length) return false;
  const roles = items.map((entry) => String(entry?.role || '')).sort();
  if (roles.join('|') !== [...expectedRoles].sort().join('|')) return false;
  return items.every((entry) => {
    try { return new URL(String(entry?.url || '')).protocol === 'https:'; } catch (_) { return false; }
  });
}

function validateCompletedResult(item) {
  const expected = REQUIRED_MATRIX.find((entry) => entry.id === item?.id);
  if (!expected || item.status !== 'completed') return false;
  if (item.model !== expected.model || item.mode !== expected.mode
      || String(item.requested_resolution).toLowerCase() !== expected.resolution
      || Number(item.requested_duration) !== expected.duration) return false;
  if (!String(item.provider_task_id || '').trim()) return false;
  const startedAt = Date.parse(String(item.started_at || ''));
  const completedAt = Date.parse(String(item.completed_at || ''));
  const speed = item.speed || {};
  const submitLatencyMs = Number(speed.submit_latency_ms);
  const generationElapsedSeconds = Number(speed.generation_elapsed_seconds);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || startedAt >= completedAt
      || !Number.isInteger(submitLatencyMs) || submitLatencyMs < 0
      || !Number.isFinite(generationElapsedSeconds) || generationElapsedSeconds <= 0
      || round((completedAt - startedAt) / 1000) !== generationElapsedSeconds) return false;
  const request = item.request || {};
  if (request.model !== expected.model
      || String(request.resolution || '').toLowerCase() !== expected.resolution
      || Number(request.duration) !== expected.duration
      || request.aspect_ratio !== '16:9'
      || request.generate_audio !== (expected.generateAudio === true)) return false;
  if (expected.mode === 't2v') {
    if (request.image_with_roles != null || request.video_with_roles != null || request.audio_with_roles != null) return false;
  } else if (expected.mode === 'first-last') {
    if (!hasExactRoles(request.image_with_roles, ['first_frame', 'last_frame'])
        || request.video_with_roles != null || request.audio_with_roles != null) return false;
  } else if (expected.mode === 'omni') {
    if (!hasExactRoles(request.image_with_roles, ['reference_image'])
        || !hasExactRoles(request.video_with_roles, ['reference_video'])
        || !hasExactRoles(request.audio_with_roles, ['reference_audio'])) return false;
  }
  const artifact = item.artifact || {};
  try {
    const outputFile = assertSafeMp4Basename(artifact.output_file);
    const publicUrl = new URL(assertMoliPublicArtifactUrl(artifact.public_url));
    if (publicUrl.pathname.slice(publicUrl.pathname.lastIndexOf('/') + 1) !== outputFile) return false;
  } catch (_) { return false; }
  if (!String(artifact.output_file || '').trim()
      || !Number.isFinite(Number(artifact.bytes)) || Number(artifact.bytes) <= 0
      || !/^[a-f0-9]{64}$/i.test(String(artifact.sha256 || ''))
      || !Number(artifact.ffprobe?.width) || !Number(artifact.ffprobe?.height)
      || !Number(artifact.ffprobe?.duration_seconds) || !artifact.ffprobe?.video_codec
      || (expected.generateAudio === true && artifact.ffprobe?.has_audio !== true)) return false;
  try { assertResolutionBand(expected.resolution, artifact.ffprobe); } catch (_) { return false; }
  if (Math.abs(Number(artifact.ffprobe.duration_seconds) - expected.duration) > 1.5) return false;
  const billing = item.billing || {};
  let delta;
  try { delta = calculateBalanceDelta(billing.before, billing.after); } catch (_) { return false; }
  const beforeCapturedAt = Date.parse(String(billing.before?.captured_at || ''));
  const afterCapturedAt = Date.parse(String(billing.after?.captured_at || ''));
  if (!Number.isFinite(beforeCapturedAt) || !Number.isFinite(afterCapturedAt)
      || beforeCapturedAt >= afterCapturedAt) return false;
  const usdCnyRate = Number(billing.usd_cny_rate);
  return Number(billing.debited_balance) === delta.debited_balance
    && Number(billing.debited_credits) === delta.debited_credits
    && Number.isFinite(usdCnyRate) && usdCnyRate > 0
    && Number(billing.cost_yuan) === round(delta.debited_balance * usdCnyRate)
    && billing.reviewed === true
    && String(billing.review_run_id || '').trim() !== ''
    && Number.isFinite(Date.parse(String(billing.reviewed_at || '')));
}

function hasContinuousBillingChain(results) {
  const chains = new Map();
  const fingerprintsByModel = new Map();
  for (const item of results) {
    const model = String(item?.model || '');
    const fingerprint = String(item?.config_fingerprint || '');
    if (!model || !/^[a-f0-9]{64}$/i.test(fingerprint)) return false;
    if (fingerprintsByModel.has(model) && fingerprintsByModel.get(model) !== fingerprint) return false;
    fingerprintsByModel.set(model, fingerprint);
    const key = `${model}|${fingerprint}`;
    if (!chains.has(key)) chains.set(key, []);
    chains.get(key).push({
      before: item?.billing?.before,
      after: item?.billing?.after,
      beforeAt: Date.parse(String(item?.billing?.before?.captured_at || '')),
      afterAt: Date.parse(String(item?.billing?.after?.captured_at || '')),
    });
  }
  if (new Set(fingerprintsByModel.values()).size !== fingerprintsByModel.size) return false;
  for (const intervals of chains.values()) {
    intervals.sort((left, right) => left.beforeAt - right.beforeAt);
    const windows = new Set(intervals.map((item) => `${item.beforeAt}|${item.afterAt}`));
    if (windows.size !== intervals.length) return false;
    for (let index = 1; index < intervals.length; index += 1) {
      const previous = intervals[index - 1];
      const current = intervals[index];
      if (previous.afterAt > current.beforeAt
          || Number(previous.after?.used_balance) !== Number(current.before?.used_balance)
          || Number(previous.after?.used_credits) !== Number(current.before?.used_credits)) return false;
    }
  }
  return true;
}

function canConfirmCostReview(context) {
  return context?.confirmCostReview === true
    && Array.isArray(context?.submittedCaseIds) && context.submittedCaseIds.length === 0
    && Array.isArray(context?.completedBeforeRun)
    && context.completedBeforeRun.length === REQUIRED_MATRIX.length
    && REQUIRED_MATRIX.every((item) => context.completedBeforeRun.includes(item.id));
}

function hasCompleteRequiredMatrix(results) {
  if (!Array.isArray(results) || results.length !== REQUIRED_MATRIX.length) return false;
  const byId = new Map(results.map((item) => [item?.id, item]));
  if (byId.size !== REQUIRED_MATRIX.length) return false;
  const unique = (selector) => new Set(results.map(selector)).size === results.length;
  if (!unique((item) => item.provider_task_id)
      || !unique((item) => item.artifact?.public_url)
      || !unique((item) => item.artifact?.output_file)
      || !unique((item) => item.artifact?.sha256)) return false;
  if (new Set(results.map((item) => item.billing?.review_run_id)).size !== 1) return false;
  return REQUIRED_MATRIX.every((expected) => validateCompletedResult(byId.get(expected.id)))
    && hasContinuousBillingChain(results);
}

function buildVerifiedCapabilities(results, evidenceBinding) {
  if (!hasCompleteRequiredMatrix(results)) return {};
  const binding = normalizeEvidenceBinding(evidenceBinding);
  const output = {};
  for (const model of ['seedance-2-fast', 'seedance-2-mini']) {
    const spec = TOAPIS_VIDEO_MODELS[model];
    const modelResults = results.filter((item) => item.model === model);
    const t2vResolutions = new Set(modelResults.filter((item) => item.mode === 't2v')
      .map((item) => String(item.requested_resolution).toLowerCase()));
    const firstLast = modelResults.some((item) => item.mode === 'first-last');
    const omni = modelResults.find((item) => item.mode === 'omni');
    const roles = new Set(omni?.request?.image_with_roles?.map((item) => item.role) || []);
    const videoRoles = new Set(omni?.request?.video_with_roles?.map((item) => item.role) || []);
    const audioRoles = new Set(omni?.request?.audio_with_roles?.map((item) => item.role) || []);
    output[model] = {
      durations: [...spec.durations],
      resolutions: spec.resolutions.filter((resolution) => t2vResolutions.has(resolution)),
      supportsFirstFrame: firstLast,
      supportsLastFrame: firstLast,
      supportsImageReference: roles.has('reference_image'),
      supportsVideoReference: videoRoles.has('reference_video'),
      supportsAudioReference: audioRoles.has('reference_audio'),
      supportsAudio: modelResults.some((item) => item.request?.generate_audio === true
        && item.artifact?.ffprobe?.has_audio === true),
      maxReferences: spec.maxReferences,
      maxVideoReferences: spec.maxVideoReferences,
      maxAudioReferences: spec.maxAudioReferences,
      ...binding,
    };
  }
  return output;
}

function requireDedicatedVerificationToken(env = process.env) {
  if (String(env.TOAPIS_VERIFY_DEDICATED_TOKEN || '').trim() !== '1') {
    throw new Error('真实扣费验证必须使用不被其他业务并发调用的专用验证 Token');
  }
}

function requireVerificationConfigIds(env = process.env) {
  const configIds = {
    'seedance-2-fast': Number(env.TOAPIS_VERIFY_FAST_CONFIG_ID),
    'seedance-2-mini': Number(env.TOAPIS_VERIFY_MINI_CONFIG_ID),
  };
  if (!Number.isInteger(configIds['seedance-2-fast']) || configIds['seedance-2-fast'] <= 0) {
    throw new Error('缺少有效的 TOAPIS_VERIFY_FAST_CONFIG_ID，禁止启动付费验证');
  }
  if (!Number.isInteger(configIds['seedance-2-mini']) || configIds['seedance-2-mini'] <= 0) {
    throw new Error('缺少有效的 TOAPIS_VERIFY_MINI_CONFIG_ID，禁止启动付费验证');
  }
  if (configIds['seedance-2-fast'] === configIds['seedance-2-mini']) {
    throw new Error('FAST_CONFIG_ID 与 MINI_CONFIG_ID 必须分别指向两个配置');
  }
  return configIds;
}

function normalizeEvidenceBinding(binding) {
  const evidenceContract = String(binding?.evidence_contract || '').trim();
  const evidenceSha256 = String(binding?.evidence_sha256 || '').trim().toLowerCase();
  if (evidenceContract !== EVIDENCE_VERSION || !/^[a-f0-9]{64}$/.test(evidenceSha256)) {
    throw new Error('ToAPIs 最终证据绑定缺失或无效');
  }
  return { evidence_contract: evidenceContract, evidence_sha256: evidenceSha256 };
}

function evidenceBindingForFile(evidencePath) {
  const resolved = path.resolve(String(evidencePath || ''));
  const bytes = fs.readFileSync(resolved);
  const evidence = JSON.parse(bytes.toString('utf8'));
  return normalizeEvidenceBinding({
    evidence_contract: evidence?.contract_version,
    evidence_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  });
}

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(redactEvidence(payload), null, 2)}\n`);
  fs.renameSync(temporary, filePath);
}

function restoreEvidenceFile(filePath, previousBytes) {
  if (previousBytes == null) {
    try { fs.unlinkSync(filePath); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.restore.tmp`;
  fs.writeFileSync(temporary, previousBytes);
  fs.renameSync(temporary, filePath);
}

function preserveExistingVerification(error) {
  const normalized = error instanceof Error ? error : new Error(String(error));
  normalized.preserveExistingVerification = true;
  return normalized;
}

function acquireVerificationLock(lockPath) {
  let fileDescriptor;
  try {
    fileDescriptor = fs.openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('已有验证进程或待人工核对的验证锁，禁止并发付费提交');
    throw error;
  }
  fs.writeFileSync(fileDescriptor, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fs.closeSync(fileDescriptor);
    fs.unlinkSync(lockPath);
  };
}

function safeChildProcessEnv(env = process.env) {
  const allowed = [
    'PATH', 'Path', 'SystemRoot', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP',
    'HOME', 'USERPROFILE', 'COMSPEC', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH',
    'LANG', 'LC_ALL',
  ];
  return Object.fromEntries(allowed.filter((key) => env[key] != null).map((key) => [key, env[key]]));
}

function runFfprobe(filePath, executable = process.env.FFPROBE_PATH || 'ffprobe') {
  const result = spawnSync(executable, [
    '-v', 'error', '-show_entries',
    'format=format_name,duration:stream=codec_type,codec_name,width,height,duration',
    '-of', 'json', filePath,
  ], { encoding: 'utf8', windowsHide: true, env: safeChildProcessEnv(process.env) });
  if (result.error) throw new Error(`ffprobe 执行失败: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`ffprobe 校验失败: ${String(result.stderr || '').trim().slice(0, 300)}`);
  return parseFfprobeJson(result.stdout);
}

async function fetchBalance(apiKey, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${BASE_URL}/v1/balance`, {
    method: 'GET', headers: { Authorization: `Bearer ${apiKey}` },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true) throw new Error(`ToAPIs 余额查询失败 (${response.status})`);
  const usedBalance = Number(payload.used_balance);
  const usedCredits = Number(payload.used_credits);
  if (!Number.isFinite(usedBalance) || usedBalance < 0) {
    throw new Error('ToAPIs 余额字段 used_balance 必须是非负有效数字');
  }
  if (!Number.isFinite(usedCredits) || usedCredits < 0) {
    throw new Error('ToAPIs 余额字段 used_credits 必须是非负有效数字');
  }
  return {
    used_balance: usedBalance,
    used_credits: usedCredits,
    remain_balance: Number(payload.remain_balance),
    remain_credits: Number(payload.remain_credits),
    credits_per_usd: Number(payload.credits_per_usd),
    captured_at: new Date().toISOString(),
  };
}

async function assertPublicArtifact(url, expectedSha256, fetchImpl = globalThis.fetch) {
  assertMoliPublicArtifactUrl(url);
  const response = await fetchImpl(url, { method: 'GET' });
  if (response.status !== 200) throw new Error(`本站长期资产公网读取失败 (${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (sha256 !== expectedSha256) throw new Error('本站公网资产与本地校验文件哈希不一致');
}

function speedStats(values) {
  return {
    sample_count: values.length,
    min_generation_elapsed_seconds: Math.min(...values),
    max_generation_elapsed_seconds: Math.max(...values),
    avg_generation_elapsed_seconds: round(values.reduce((sum, value) => sum + value, 0) / values.length, 3),
  };
}

function buildSpeedEvidenceSummary(results = []) {
  const cases = REQUIRED_MATRIX.map((expected) => {
    const item = Array.isArray(results) ? results.find((entry) => entry?.id === expected.id) : null;
    return {
      id: expected.id,
      model: expected.model,
      resolution: expected.resolution,
      mode: expected.mode,
      submit_latency_ms: Number(item?.speed?.submit_latency_ms),
      generation_elapsed_seconds: Number(item?.speed?.generation_elapsed_seconds),
      started_at: item?.started_at || null,
      completed_at: item?.completed_at || null,
    };
  });
  return {
    measurement_basis: 'actual_verification_run_not_provider_sla',
    cases,
    model_summary: Object.fromEntries(['seedance-2-fast', 'seedance-2-mini'].map((model) => {
      const values = cases
        .filter((item) => item.model === model && Number.isFinite(item.generation_elapsed_seconds))
        .map((item) => item.generation_elapsed_seconds);
      return [model, values.length ? speedStats(values) : {
        sample_count: 0,
        min_generation_elapsed_seconds: null,
        max_generation_elapsed_seconds: null,
        avg_generation_elapsed_seconds: null,
      }];
    })),
  };
}

function formatSpeedEvidenceSummary(speedEvidence) {
  const lines = ['TOAPIS_VIDEO_SPEED_EVIDENCE measurement=actual_verification_run_not_provider_sla'];
  for (const item of speedEvidence.cases || []) {
    lines.push(`SPEED_DETAIL model=${item.model} resolution=${item.resolution} mode=${item.mode} case=${item.id} submit_latency_ms=${item.submit_latency_ms} generation_elapsed_seconds=${item.generation_elapsed_seconds}`);
  }
  for (const [model, summary] of Object.entries(speedEvidence.model_summary || {})) {
    lines.push(`SPEED_SUMMARY model=${model} sample_count=${summary.sample_count} min_generation_elapsed_seconds=${summary.min_generation_elapsed_seconds} max_generation_elapsed_seconds=${summary.max_generation_elapsed_seconds} avg_generation_elapsed_seconds=${summary.avg_generation_elapsed_seconds}`);
  }
  return lines.join('\n');
}

function buildReleaseEvidence(results, pricing, costReview, now = new Date()) {
  const generated = new Date(now);
  if (!Number.isFinite(generated.getTime())) throw new Error('ToAPIs 证据生成时间无效');
  const generatedAt = generated.toISOString();
  return redactEvidence({
    contract_version: EVIDENCE_VERSION,
    provider_origin: BASE_URL,
    generated_at: generatedAt,
    valid_until: new Date(generated.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    results,
    speed_evidence: buildSpeedEvidenceSummary(results),
    pricing,
    cost_review: costReview || null,
  });
}

function assertMoliPublicArtifactUrl(url) {
  const raw = String(url || '').trim();
  const parsed = new URL(raw);
  if (parsed.origin !== 'https://molimama.vip'
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || parsed.href !== raw
      || !/^\/verification-assets\/toapis\/[A-Za-z0-9][A-Za-z0-9._~-]*\.mp4$/.test(parsed.pathname)) {
    throw new Error('本站长期资产必须位于 https://molimama.vip/verification-assets/toapis/');
  }
  return parsed.href;
}

function assertSafeMp4Basename(value) {
  const fileName = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]*\.mp4$/.test(fileName) || path.basename(fileName) !== fileName) {
    throw new Error('ToAPIs 成品文件名必须是安全的 .mp4 basename');
  }
  return fileName;
}

function assertMoliPublicAssetBaseUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); } catch (_) {
    throw new Error('TOAPIS_VERIFY_PUBLIC_ASSET_BASE_URL 必须固定为 https://molimama.vip/verification-assets/toapis');
  }
  const pathname = parsed.pathname.replace(/\/+$/, '');
  if (parsed.origin !== 'https://molimama.vip'
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || pathname !== '/verification-assets/toapis') {
    throw new Error('TOAPIS_VERIFY_PUBLIC_ASSET_BASE_URL 必须固定为 https://molimama.vip/verification-assets/toapis');
  }
  return 'https://molimama.vip/verification-assets/toapis';
}

function resolveVerificationPaths(env = process.env) {
  const outputDirRaw = String(env.TOAPIS_VERIFY_OUTPUT_DIR || '').trim();
  const publicArtifactDirRaw = String(env.TOAPIS_VERIFY_PUBLIC_ARTIFACT_DIR || '').trim();
  if (!outputDirRaw) throw new Error('缺少 TOAPIS_VERIFY_OUTPUT_DIR；私有验证状态必须写入受保护目录');
  if (!publicArtifactDirRaw) throw new Error('缺少 TOAPIS_VERIFY_PUBLIC_ARTIFACT_DIR；真实成品必须写入固定 public/toapis 目录');
  if (!path.isAbsolute(outputDirRaw) || !path.isAbsolute(publicArtifactDirRaw)) {
    throw new Error('ToAPIs 验证目录必须使用绝对路径');
  }
  const outputDir = path.resolve(outputDirRaw);
  const publicArtifactDir = path.resolve(publicArtifactDirRaw);
  if (outputDir === publicArtifactDir) throw new Error('公网成品目录不能与私有验证目录相同');
  const publicFromPrivate = path.relative(outputDir, publicArtifactDir);
  const privateFromPublic = path.relative(publicArtifactDir, outputDir);
  const publicInsidePrivate = publicFromPrivate && !publicFromPrivate.startsWith(`..${path.sep}`)
    && publicFromPrivate !== '..' && !path.isAbsolute(publicFromPrivate);
  const privateInsidePublic = privateFromPublic && !privateFromPublic.startsWith(`..${path.sep}`)
    && privateFromPublic !== '..' && !path.isAbsolute(privateFromPublic);
  if (publicInsidePrivate || privateInsidePublic) {
    throw new Error('公网成品目录必须与私有验证目录分离');
  }
  return {
    outputDir,
    publicArtifactDir,
    publicAssetBaseUrl: assertMoliPublicAssetBaseUrl(env.TOAPIS_VERIFY_PUBLIC_ASSET_BASE_URL),
    statePath: path.join(outputDir, 'toapis-video-verification-state.json'),
    evidencePath: path.join(outputDir, 'toapis-video-verification.json'),
    lockPath: path.join(outputDir, '.toapis-video-verification.lock'),
  };
}

async function downloadAndInspect(url, filePath, item, publicUrl, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`视频结果下载失败 (${response.status})`);
  const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!contentType.startsWith('video/') && contentType !== 'application/octet-stream') {
    throw new Error(`结果 MIME 不是视频: ${contentType || '(empty)'}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1024) throw new Error('视频结果为空或过小');
  await fs.promises.writeFile(filePath, buffer);
  await fs.promises.chmod(filePath, 0o444);
  const ffprobe = (deps.runFfprobe || runFfprobe)(filePath);
  assertResolutionBand(item.resolution, ffprobe);
  if (Math.abs(ffprobe.duration_seconds - item.duration) > 1.5) {
    throw new Error(`结果时长与请求不符: ${ffprobe.duration_seconds}s / ${item.duration}s`);
  }
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  await (deps.assertPublicArtifact || assertPublicArtifact)(publicUrl, sha256, fetchImpl);
  return {
    public_url: publicUrl,
    output_file: path.basename(filePath),
    content_type: contentType,
    bytes: buffer.length,
    sha256,
    ffprobe,
  };
}

async function verifyStoredArtifact(entry, item, context, deps = {}) {
  const fileName = assertSafeMp4Basename(entry.artifact?.output_file);
  const publicUrl = new URL(assertMoliPublicArtifactUrl(entry.artifact?.public_url));
  if (publicUrl.pathname.slice(publicUrl.pathname.lastIndexOf('/') + 1) !== fileName) {
    throw new Error(`${item.id} 本站长期资产 URL 与文件名不一致`);
  }
  const filePath = path.join(context.artifactOutputDir, fileName);
  const buffer = await fs.promises.readFile(filePath);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (sha256 !== entry.artifact.sha256) throw new Error(`${item.id} 本站长期资产哈希不匹配`);
  const ffprobe = (deps.runFfprobe || runFfprobe)(filePath);
  assertResolutionBand(item.resolution, ffprobe);
  if (Math.abs(ffprobe.duration_seconds - item.duration) > 1.5) throw new Error(`${item.id} 本站长期资产时长不匹配`);
  if (item.generateAudio === true && ffprobe.has_audio !== true) throw new Error(`${item.id} 未验证同步音频输出`);
  await (deps.assertPublicArtifact || assertPublicArtifact)(
    entry.artifact.public_url,
    entry.artifact.sha256,
    deps.fetchImpl || globalThis.fetch,
  );
  entry.artifact.ffprobe = ffprobe;
  return entry.artifact;
}

async function verifyAllStoredResults(context, deps = {}) {
  const results = [];
  for (const item of REQUIRED_MATRIX) {
    const entry = context.state.cases[item.id];
    if (!entry) throw new Error(`${item.id} 缺少已完成验证状态`);
    await verifyStoredArtifact(entry, item, context, deps);
    results.push(entry);
  }
  if (canConfirmCostReview(context)) {
    const reviewedAt = new Date().toISOString();
    for (const entry of results) {
      entry.billing.reviewed = true;
      entry.billing.review_run_id = context.runId;
      entry.billing.reviewed_at = reviewedAt;
    }
    context.state.last_cost_review = {
      run_id: context.runId,
      reviewed_at: reviewedAt,
      completed_before_run: [...context.completedBeforeRun],
      submitted_case_ids: [],
    };
  }
  writeJsonAtomic(context.statePath, context.state);
  return results;
}

function openVerificationDb(databasePath = '', options = {}) {
  const configured = String(databasePath || process.env.TOAPIS_VERIFY_DATABASE_PATH || process.env.DATABASE_PATH || '').trim()
    || loadConfig().database?.path;
  if (!configured || configured === ':memory:') throw new Error('缺少验证状态数据库路径');
  const resolved = path.resolve(process.cwd(), configured);
  if (options.readonly === true) {
    return new Database(resolved, { readonly: true, fileMustExist: true });
  }
  const db = new Database(resolved);
  runMigrationsAndEnsure(db);
  return db;
}

function assertDedicatedVerificationConfig(config, model) {
  const models = new Set([
    config?.default_model,
    ...(Array.isArray(config?.model) ? config.model : []),
  ].filter(Boolean));
  const otherModel = model === 'seedance-2-fast' ? 'seedance-2-mini' : 'seedance-2-fast';
  if (String(config?.service_type || '').toLowerCase() !== 'video'
      || String(config?.provider || '').toLowerCase() !== 'toapis'
      || String(config?.api_protocol || '').toLowerCase() !== 'toapis_video'
      || normalizeToapisBaseUrl(config?.base_url) !== BASE_URL
      || !models.has(model)
      || models.has(otherModel)
      || (config?.default_model && config.default_model !== model)) {
    throw new Error(`${model} 对应配置不是专用 ToAPIs 视频配置`);
  }
}

function verificationConfigFingerprint(config) {
  return crypto.createHash('sha256').update(JSON.stringify({
    id: Number(config?.id),
    service_type: String(config?.service_type || '').toLowerCase(),
    provider: String(config?.provider || '').toLowerCase(),
    api_protocol: String(config?.api_protocol || '').toLowerCase(),
    base_url: normalizeToapisBaseUrl(config?.base_url),
    api_key: String(config?.api_key || ''),
    model: [...(Array.isArray(config?.model) ? config.model : [])].sort(),
    default_model: String(config?.default_model || ''),
    logical_model_id: String(config?.logical_model_id || ''),
    endpoint: String(config?.endpoint || ''),
    query_endpoint: String(config?.query_endpoint || ''),
    settings: config?.settings || null,
    is_active: config?.is_active === true,
    canary_paused: config?.canary_paused === true,
    failover_enabled: config?.failover_enabled === true,
  })).digest('hex');
}

function validateVerificationConfigs(options = {}) {
  const configIds = options.configIds || requireVerificationConfigIds();
  const db = openVerificationDb(options.databasePath, { readonly: true });
  try {
    const snapshots = ['seedance-2-fast', 'seedance-2-mini'].map((model) => {
      const configId = configIds[model];
      const config = aiConfigService.getConfig(db, configId);
      assertDedicatedVerificationConfig(config, model);
      const apiKey = String(config?.api_key || '').trim();
      if (!apiKey) throw new Error(`${model} 验证配置缺少供应商 Key`);
      return { model, configId, fingerprint: verificationConfigFingerprint(config), apiKey };
    });
    if (snapshots[0].apiKey === snapshots[1].apiKey) {
      throw new Error('FAST 与 MINI 验证配置的供应商 Key 必须分别配置，不能共用');
    }
    return snapshots;
  } finally {
    db.close();
  }
}

function recordVerificationResult(results, error = null, options = {}) {
  if (error || !hasCompleteRequiredMatrix(results)) return null;
  const configIds = options.configIds || requireVerificationConfigIds();
  const configSnapshots = new Map((options.configSnapshots || []).map((item) => [item?.model, item]));
  if (configSnapshots.size !== 2) throw new Error('缺少 FAST/MINI 付费验证前配置快照');
  const binding = evidenceBindingForFile(options.evidencePath);
  const db = openVerificationDb(options.databasePath);
  try {
    const recordVerification = options.recordVerification || aiConfigService.recordVerification;
    return db.transaction(() => {
      const configs = ['seedance-2-fast', 'seedance-2-mini'].map((model) => {
        const configId = configIds[model];
        const config = aiConfigService.getConfig(db, configId);
        assertDedicatedVerificationConfig(config, model);
        const snapshot = configSnapshots.get(model);
        if (Number(snapshot?.configId) !== configId
            || snapshot?.fingerprint !== verificationConfigFingerprint(config)) {
          throw new Error(`${model} 配置已在验证期间发生变化，禁止绑定旧证据`);
        }
        return { model, configId };
      });
      const capabilities = buildVerifiedCapabilities(results, binding);
      const verifiedAt = new Date().toISOString();
      const updated = configs.map(({ model, configId }) => recordVerification(db, configId, {
        status: 'verified',
        verifiedAt,
        capabilities: { [model]: capabilities[model] },
      }));
      for (const { model, configId } of configs) {
        const saved = aiConfigService.getConfig(db, configId);
        const keys = Object.keys(saved?.verified_capabilities || {});
        const modelCapabilities = saved?.verified_capabilities?.[model];
        if (saved?.verification_status !== 'verified'
            || keys.length !== 1 || keys[0] !== model
            || saved?.verified_at !== verifiedAt
            || modelCapabilities?.evidence_contract !== binding.evidence_contract
            || modelCapabilities?.evidence_sha256 !== binding.evidence_sha256) {
          throw new Error(`${model} ToAPIs 最终证据绑定写回校验失败`);
        }
      }
      return updated;
    }).immediate();
  } finally {
    db.close();
  }
}

function publishVerifiedEvidence(results, pricing, evidence, options = {}) {
  if (!hasCompleteRequiredMatrix(results)) {
    throw preserveExistingVerification(new Error('8 个必需真实验证组合尚未全部完成并复核费用'));
  }
  if (!hasCompletePricing(pricing, results)) {
    throw preserveExistingVerification(new Error('两模型 480P/720P 的人民币成本与积分价格尚未全部复核'));
  }
  if (!options.evidencePath) {
    throw preserveExistingVerification(new Error('缺少最终 ToAPIs 证据路径'));
  }
  const evidencePath = path.resolve(String(options.evidencePath));
  let previousBytes = null;
  try { previousBytes = fs.readFileSync(evidencePath); } catch (error) {
    if (error.code !== 'ENOENT') throw preserveExistingVerification(error);
  }
  try { writeJsonAtomic(evidencePath, evidence); } catch (error) {
    throw preserveExistingVerification(error);
  }
  try {
    const recorder = options.recordResult || recordVerificationResult;
    return recorder(results, null, {
      configIds: options.configIds,
      configSnapshots: options.configSnapshots,
      databasePath: options.databasePath,
      evidencePath,
      recordVerification: options.recordVerification,
    });
  } catch (error) {
    try { restoreEvidenceFile(evidencePath, previousBytes); } catch (restoreError) {
      throw preserveExistingVerification(new Error(`ToAPIs 证据绑定写回失败，且旧证据恢复失败: ${restoreError.message}`));
    }
    throw preserveExistingVerification(error);
  }
}

function parseJsonEnv(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (_) { throw new Error(`${name} 必须是有效 JSON`); }
}

function expectedCostForCase(item, values = parseJsonEnv('TOAPIS_EXPECTED_COST_YUAN_JSON', {})) {
  const value = Number(values[item.id]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`缺少 ${item.id} 的预计人民币成本，禁止提交付费请求`);
  return value;
}

function positiveYuanEnv(name) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`缺少 ${name}，禁止执行供应商余额查询或付费请求`);
  return value;
}

function assertHttpsReference(value, label, caseId) {
  const raw = String(value || '').trim();
  let parsed;
  try { parsed = new URL(raw); } catch (_) {
    throw new Error(`${caseId} 缺少有效的 ${label} HTTPS URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.href !== raw) {
    throw new Error(`${caseId} 缺少有效的 ${label} HTTPS URL`);
  }
  return parsed.href;
}

function assertFfprobeAvailable(executable = process.env.FFPROBE_PATH || 'ffprobe') {
  const result = spawnSync(executable, ['-version'], {
    encoding: 'utf8', windowsHide: true, env: safeChildProcessEnv(process.env),
  });
  if (result.error) throw new Error(`ffprobe 预检失败: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`ffprobe 预检失败: ${String(result.stderr || '').trim().slice(0, 300)}`);
}

function configFingerprintMap(configSnapshots = []) {
  const output = Object.fromEntries(configSnapshots.map((item) => [item?.model, String(item?.fingerprint || '')]));
  for (const model of ['seedance-2-fast', 'seedance-2-mini']) {
    if (!/^[a-f0-9]{64}$/i.test(output[model] || '')) throw new Error(`缺少 ${model} 付费验证配置指纹`);
  }
  return output;
}

function bindAndValidateVerificationState(state, configSnapshots = []) {
  const fingerprints = configFingerprintMap(configSnapshots);
  const cases = state?.cases && typeof state.cases === 'object' ? state.cases : null;
  if (!cases) throw new Error('验证状态文件版本不兼容');
  const hasCases = Object.keys(cases).length > 0;
  const hasBinding = Boolean(state.provider_origin || state.config_fingerprints);
  if (!hasCases && !hasBinding) {
    state.provider_origin = BASE_URL;
    state.config_fingerprints = { ...fingerprints };
  }
  if (state.provider_origin !== BASE_URL) throw new Error('验证状态未绑定 ToAPIs 官方入口 https://toapis.cn');
  for (const model of ['seedance-2-fast', 'seedance-2-mini']) {
    if (state.config_fingerprints?.[model] !== fingerprints[model]) {
      throw new Error(`${model} 验证状态配置指纹不匹配，禁止零 POST 重放`);
    }
  }
  for (const [caseId, entry] of Object.entries(cases)) {
    const expected = REQUIRED_MATRIX.find((item) => item.id === caseId);
    if (!expected || entry?.model !== expected.model
        || entry?.provider_origin !== BASE_URL
        || entry?.config_fingerprint !== fingerprints[expected.model]) {
      throw new Error(`${caseId} 验证状态未绑定官方入口和当前 ${expected?.model || '未知'} 配置指纹`);
    }
  }
  return fingerprints;
}

function actualCostTotal(state) {
  return round(Object.values(state?.cases || {}).reduce((sum, entry) => {
    const value = Number(entry?.billing?.cost_yuan);
    return sum + (Number.isFinite(value) && value > 0 ? value : 0);
  }, 0));
}

function assertNoGlobalUnknownSubmission(state) {
  const blocked = Object.entries(state?.cases || {}).find(([, entry]) => (
    ['submitting', 'indeterminate'].includes(entry?.submission_state)
  ));
  if (blocked) {
    throw preserveExistingVerification(new Error(`${blocked[0]} 上次提交结果未知，禁止选择其他 case 继续提交`));
  }
  const costCapExceeded = Object.entries(state?.cases || {}).find(([, entry]) => entry?.status === 'cost_cap_exceeded');
  if (costCapExceeded) {
    throw preserveExistingVerification(new Error(`${costCapExceeded[0]} 已触发人民币成本硬上限，禁止继续供应商调用`));
  }
}

function requirePreparedCaseBudget(item, context) {
  const budget = context?.costBudget;
  const expected = Number(budget?.expectedCosts?.[item.id]);
  const aggregateHardCapYuan = Number(budget?.aggregateHardCapYuan);
  if (!Number.isFinite(expected) || expected <= 0
      || !Number.isFinite(aggregateHardCapYuan) || aggregateHardCapYuan <= 0) {
    throw new Error(`${item.id} 未完成整轮成本预检，禁止执行供应商余额查询或付费请求`);
  }
  const fingerprint = String(context?.configFingerprints?.[item.model] || '');
  if (!/^[a-f0-9]{64}$/i.test(fingerprint)
      || context?.state?.provider_origin !== BASE_URL
      || context?.state?.config_fingerprints?.[item.model] !== fingerprint) {
    throw new Error(`${item.id} 未绑定官方入口和当前配置指纹，禁止执行供应商调用`);
  }
  return expected;
}

function preflightVerificationRun(selectedCases, context, deps = {}) {
  assertNoGlobalUnknownSubmission(context.state);
  const plans = selectedCases.map((item) => ({ item, action: decideResumeAction(context.state.cases[item.id] || null) }));
  const supplierBalanceCases = plans.filter(({ action }) => ['submit', 'poll', 'finalize'].includes(action));
  if (!supplierBalanceCases.length) return { plans, expectedCosts: {}, aggregateHardCapYuan: null, perCaseHardCaps: {} };

  const expectedValues = parseJsonEnv('TOAPIS_EXPECTED_COST_YUAN_JSON', {});
  const perCaseHardCaps = parseJsonEnv('TOAPIS_VERIFY_CASE_HARD_CAP_YUAN_JSON', {});
  if (perCaseHardCaps == null || Array.isArray(perCaseHardCaps) || typeof perCaseHardCaps !== 'object') {
    throw new Error('TOAPIS_VERIFY_CASE_HARD_CAP_YUAN_JSON 必须是 JSON 对象');
  }
  const aggregateHardCapYuan = positiveYuanEnv('TOAPIS_VERIFY_AGGREGATE_HARD_CAP_YUAN');
  const expectedCosts = {};
  for (const { item, action } of supplierBalanceCases) {
    const expected = action === 'submit'
      ? expectedCostForCase(item, expectedValues)
      : Number(context.state.cases[item.id]?.billing?.expected_cost_yuan);
    if (!Number.isFinite(expected) || expected <= 0) {
      throw new Error(`缺少 ${item.id} 的预计人民币成本，禁止执行供应商余额查询`);
    }
    expectedCosts[item.id] = expected;
    if (Object.keys(perCaseHardCaps).length) {
      const caseHardCap = Number(perCaseHardCaps[item.id]);
      if (!Number.isFinite(caseHardCap) || caseHardCap <= 0) throw new Error(`缺少 ${item.id} 的人民币单 case 硬上限`);
      if (expected > caseHardCap) throw new Error(`${item.id} 预计人民币成本 ${expected} 超过单 case 硬上限 ${caseHardCap}`);
    }
    if (action === 'submit') {
      if (item.mode === 'first-last') {
        assertHttpsReference(context.refs.firstFrameUrl, '首帧', item.id);
        assertHttpsReference(context.refs.lastFrameUrl, '尾帧', item.id);
      } else if (item.mode === 'omni') {
        assertHttpsReference(context.refs.referenceImageUrl, '参考图片', item.id);
        assertHttpsReference(context.refs.referenceVideoUrl, '参考视频', item.id);
        assertHttpsReference(context.refs.referenceAudioUrl, '参考音频', item.id);
      }
      buildVerificationRequest(item, context.refs, context.runId);
    }
  }
  const projectedCostYuan = round(actualCostTotal(context.state)
    + Object.values(expectedCosts).reduce((sum, value) => sum + value, 0));
  if (projectedCostYuan > aggregateHardCapYuan) {
    throw new Error(`预计人民币总成本 ${projectedCostYuan} 超过硬上限 ${aggregateHardCapYuan}`);
  }
  fs.accessSync(context.outputDir, fs.constants.W_OK);
  fs.accessSync(context.artifactOutputDir, fs.constants.W_OK);
  (deps.assertFfprobeAvailable || assertFfprobeAvailable)();
  return { plans, expectedCosts, aggregateHardCapYuan, perCaseHardCaps };
}

function verificationClientForModel(context, model) {
  const client = context?.verificationClients?.[model];
  if (!client || !String(client.apiKey || '').trim()
      || client.config?.api_key !== client.apiKey
      || normalizeToapisBaseUrl(client.config?.base_url) !== BASE_URL) {
    throw new Error(`${model} 缺少数据库配置绑定的独立验证凭据`);
  }
  return client;
}

async function preflightVerificationBalances(context, deps = {}) {
  const models = [...new Set((context?.costBudget?.plans || [])
    .filter(({ action }) => ['submit', 'poll', 'finalize'].includes(action))
    .map(({ item }) => item.model))];
  const balances = {};
  for (const model of models) {
    const client = verificationClientForModel(context, model);
    balances[model] = await (deps.fetchBalance || fetchBalance)(client.apiKey, deps.fetchImpl);
  }
  return balances;
}

function assertActualCostWithinHardCap(item, context) {
  const budget = context.costBudget;
  if (!budget || !Number.isFinite(budget.aggregateHardCapYuan)) {
    throw preserveExistingVerification(new Error(`${item.id} 缺少整轮人民币成本硬上限`));
  }
  const actual = Number(context.state.cases[item.id]?.billing?.cost_yuan);
  const caseHardCap = Number(budget.perCaseHardCaps?.[item.id]);
  if (Number.isFinite(caseHardCap) && caseHardCap > 0 && actual > caseHardCap) {
    throw preserveExistingVerification(new Error(`${item.id} 实际人民币成本 ${actual} 超过单 case 硬上限 ${caseHardCap}`));
  }
  const total = actualCostTotal(context.state);
  if (total > budget.aggregateHardCapYuan) {
    throw preserveExistingVerification(new Error(`实际人民币总成本 ${total} 超过硬上限 ${budget.aggregateHardCapYuan}`));
  }
  const remainingExpected = Object.entries(budget.expectedCosts || {}).reduce((sum, [caseId, expected]) => {
    const recorded = Number(context.state.cases[caseId]?.billing?.cost_yuan);
    return sum + (Number.isFinite(recorded) && recorded > 0 ? 0 : Number(expected) || 0);
  }, 0);
  const projected = round(total + remainingExpected);
  if (projected > budget.aggregateHardCapYuan) {
    throw preserveExistingVerification(new Error(`按实际扣费重算的人民币总成本 ${projected} 超过硬上限 ${budget.aggregateHardCapYuan}`));
  }
}

function loadPricingEvidence() {
  const pricing = parseJsonEnv('TOAPIS_VERIFIED_PRICING_JSON', []);
  return Array.isArray(pricing) ? redactEvidence(pricing) : [];
}

function requiredPriceFloors(results = []) {
  const floors = { ...PUBLIC_PRICE_FLOORS };
  for (const item of Array.isArray(results) ? results : []) {
    const key = `${item?.model}|${String(item?.requested_resolution || '').toLowerCase()}`;
    if (!Object.hasOwn(floors, key)) continue;
    const actualPerSecond = Number(item?.billing?.cost_yuan) / Number(item?.requested_duration);
    if (Number.isFinite(actualPerSecond) && actualPerSecond > floors[key]) floors[key] = round(actualPerSecond);
  }
  return floors;
}

function hasCompletePricing(pricing, results = []) {
  if (!Array.isArray(pricing) || pricing.length !== Object.keys(PUBLIC_PRICE_FLOORS).length) return false;
  const prices = new Map(pricing.map((item) => [
    `${item?.model}|${String(item?.resolution || '').toLowerCase()}`,
    item,
  ]));
  if (prices.size !== pricing.length) return false;
  const floors = requiredPriceFloors(results);
  return Object.entries(floors).every(([key, floor]) => {
    const item = prices.get(key);
    const cost = Number(item?.cost_yuan_per_second);
    const credits = Number(item?.credits_per_second);
    return item?.reviewed === true
      && Number.isFinite(cost) && cost === floor
      && Number.isInteger(credits) && credits === ceilDecimalProduct(cost, 875);
  });
}

function casePublicUrl(publicBaseUrl, fileName) {
  return `${String(publicBaseUrl).replace(/\/+$/, '')}/${encodeURIComponent(fileName)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTask(config, taskId, onProgress, deps = {}) {
  const maxAttempts = Number(process.env.TOAPIS_VERIFY_MAX_POLLS || 180);
  const intervalMs = Number(process.env.TOAPIS_VERIFY_POLL_MS || 10000);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const status = await (deps.fetchTask || fetchToapisTask)(config, taskId, {
      fetchImpl: deps.fetchImpl,
      apiKey: deps.apiKey,
    });
    await onProgress(status);
    if (status.state === 'completed') return status;
    if (status.state === 'failed') throw new Error(status.error || 'ToAPIs 视频任务失败');
    await (deps.sleep || sleep)(intervalMs);
  }
  throw new Error(`ToAPIs 任务轮询超时: ${taskId}`);
}

async function processCase(item, context, deps = {}) {
  assertNoGlobalUnknownSubmission(context.state);
  const previous = context.state.cases[item.id] || null;
  const action = decideResumeAction(previous);
  if (action === 'stop-indeterminate') {
    throw preserveExistingVerification(new Error(`${item.id} 上次提交结果未知，为避免重复扣费已停止；必须人工核对供应商任务后写入 task_id`));
  }
  if (action === 'complete') {
    await verifyStoredArtifact(previous, item, context, deps);
    context.state.cases[item.id] = previous;
    writeJsonAtomic(context.statePath, context.state);
    return previous;
  }

  const preparedExpectedCostYuan = requirePreparedCaseBudget(item, context);
  const client = verificationClientForModel(context, item.model);
  let entry = previous;
  if (action === 'submit') {
    context.submittedCaseIds.push(item.id);
    const clientOptions = buildVerificationOptions(item, context.refs, context.runId);
    const request = buildToapisVideoBody(clientOptions);
    const balanceBefore = await (deps.fetchBalance || fetchBalance)(client.apiKey, deps.fetchImpl);
    const startedAt = nowDate(deps);
    entry = {
      id: item.id,
      model: item.model,
      mode: item.mode,
      requested_resolution: item.resolution,
      requested_duration: item.duration,
      status: 'submitting',
      submission_state: 'submitting',
      provider_origin: BASE_URL,
      config_fingerprint: context.configFingerprints?.[item.model],
      request,
      billing: { expected_cost_yuan: preparedExpectedCostYuan, before: balanceBefore, reviewed: false },
      started_at: startedAt.toISOString(),
    };
    context.state.cases[item.id] = entry;
    writeJsonAtomic(context.statePath, context.state);
    process.stdout.write(`SUBMIT ${item.id} model=${item.model} resolution=${item.resolution} duration=${item.duration}s expected_cost_yuan=${preparedExpectedCostYuan}\n`);
    const created = await (deps.createTask || callToapisVideoApi)(
      client.config,
      LOG,
      clientOptions,
      { fetchImpl: deps.fetchImpl, apiKey: client.apiKey },
    );
    const acceptedAt = nowDate(deps);
    if (created.indeterminate) {
      entry.status = 'indeterminate';
      entry.submission_state = 'indeterminate';
      entry.error = created.error;
      writeJsonAtomic(context.statePath, context.state);
      throw preserveExistingVerification(new Error(created.error));
    }
    if (created.error || !created.task_id) {
      entry.status = 'rejected';
      entry.submission_state = 'rejected';
      entry.error = created.error || 'ToAPIs 未返回 task_id';
      writeJsonAtomic(context.statePath, context.state);
      throw new Error(entry.error);
    }
    entry.provider_task_id = String(created.task_id);
    entry.speed = {
      submit_latency_ms: elapsedMs(startedAt, acceptedAt),
    };
    entry.status = 'processing';
    entry.submission_state = 'accepted';
    writeJsonAtomic(context.statePath, context.state);
  }

  if (action === 'finalize') {
    await verifyStoredArtifact(entry, item, context, deps);
  } else {
    const completed = await waitForTask(client.config, entry.provider_task_id, async (status) => {
      entry.status = status.state;
      entry.progress = status.progress;
      if (status.error) entry.poll_message = status.error;
      writeJsonAtomic(context.statePath, context.state);
    }, { ...deps, apiKey: client.apiKey });
    const fileName = `${item.id}-${entry.provider_task_id}.mp4`.replace(/[^a-zA-Z0-9._-]+/g, '-');
    const publicUrl = casePublicUrl(context.publicAssetBaseUrl, fileName);
    entry.artifact = await (deps.downloadAndInspect || downloadAndInspect)(
      completed.videoUrl,
      path.join(context.artifactOutputDir, fileName),
      item,
      publicUrl,
      deps,
    );
  }
  const balanceAfter = await (deps.fetchBalance || fetchBalance)(client.apiKey, deps.fetchImpl);
  const delta = calculateBalanceDelta(entry.billing.before, balanceAfter);
  const usdCnyRate = Number(process.env.TOAPIS_USD_CNY_RATE || 0);
  if (!Number.isFinite(usdCnyRate) || usdCnyRate <= 0) throw new Error('缺少 TOAPIS_USD_CNY_RATE，无法记录人民币实际成本');
  entry.billing = {
    ...entry.billing,
    after: balanceAfter,
    ...delta,
    provider_currency: 'USD',
    usd_cny_rate: usdCnyRate,
    cost_yuan: round(delta.debited_balance * usdCnyRate),
    reviewed: false,
  };
  try {
    assertActualCostWithinHardCap(item, context);
  } catch (error) {
    entry.status = 'cost_cap_exceeded';
    writeJsonAtomic(context.statePath, context.state);
    throw error;
  }
  entry.status = 'completed';
  if (!entry.completed_at) entry.completed_at = nowDate(deps).toISOString();
  entry.speed = {
    ...entry.speed,
    generation_elapsed_seconds: round((Date.parse(entry.completed_at) - Date.parse(entry.started_at)) / 1000),
  };
  delete entry.poll_message;
  writeJsonAtomic(context.statePath, context.state);
  return entry;
}

async function runVerification(deps = {}) {
  normalizeToapisBaseUrl(process.env.TOAPIS_BASE_URL || BASE_URL);
  requireDedicatedVerificationToken();
  const configIds = requireVerificationConfigIds();
  const {
    outputDir,
    publicArtifactDir,
    publicAssetBaseUrl,
    statePath,
    evidencePath,
    lockPath,
  } = resolveVerificationPaths(process.env);
  await fs.promises.mkdir(outputDir, { recursive: true });
  const releaseLock = acquireVerificationLock(lockPath);
  try {
  const configSnapshots = validateVerificationConfigs({ configIds });
  const verificationClients = Object.fromEntries(configSnapshots.map(({ model, apiKey }) => [model, {
    apiKey,
    config: { base_url: BASE_URL, api_key: apiKey },
  }]));
  await fs.promises.mkdir(publicArtifactDir, { recursive: true });
  const state = readJson(statePath, { state_version: STATE_VERSION, cases: {} });
  if (state.state_version !== STATE_VERSION || !state.cases || typeof state.cases !== 'object') {
    throw new Error('验证状态文件版本不兼容');
  }
  const configFingerprints = bindAndValidateVerificationState(state, configSnapshots);
  const selectedCases = selectVerificationCases();
  const context = {
    verificationClients,
    outputDir,
    artifactOutputDir: publicArtifactDir,
    publicAssetBaseUrl,
    statePath,
    state,
    configFingerprints,
    refs: publicReferences(),
    confirmCostReview: process.env.TOAPIS_VERIFY_CONFIRM_COST === '1',
    runId: crypto.randomUUID(),
    completedBeforeRun: REQUIRED_MATRIX
      .filter((item) => state.cases[item.id]?.status === 'completed')
      .map((item) => item.id),
    submittedCaseIds: [],
  };
  let activeCase = null;
  try {
    context.costBudget = preflightVerificationRun(selectedCases, context, deps);
    context.preflightBalances = await preflightVerificationBalances(context, deps);
    writeJsonAtomic(statePath, state);
    for (const item of selectedCases) {
      activeCase = item.id;
      const result = await processCase(item, context, deps);
      process.stdout.write(`VERIFIED ${result.id} task=${result.provider_task_id} sha256=${result.artifact.sha256}\n`);
    }
    const results = await verifyAllStoredResults(context, deps);
    let pricing;
    try { pricing = loadPricingEvidence(); } catch (error) {
      throw preserveExistingVerification(error);
    }
    const evidence = buildReleaseEvidence(results, pricing, state.last_cost_review || null);
    process.stdout.write(`${formatSpeedEvidenceSummary(evidence.speed_evidence)}\n`);
    if (context.confirmCostReview && !canConfirmCostReview(context)) {
      throw preserveExistingVerification(new Error('本轮发生了付费提交或运行开始前尚未完成 8 个组合，费用确认必须在下一次零 POST 运行中执行'));
    }
    publishVerifiedEvidence(results, pricing, evidence, { configIds, configSnapshots, evidencePath });
    process.stdout.write(`TOAPIS_VIDEO_VERIFIED 8/8 evidence=${evidencePath}\n`);
    return { evidencePath, results, pricing };
  } catch (error) {
    const safeError = String(redactEvidence(error.message || error)).slice(0, 800);
    writeJsonAtomic(path.join(outputDir, 'toapis-video-verification-failure.json'), {
      contract_version: EVIDENCE_VERSION,
      failed_at: new Date().toISOString(),
      failed_case: activeCase,
      error: safeError,
      completed_case_ids: Object.values(state.cases).filter((item) => item.status === 'completed').map((item) => item.id),
    });
    throw new Error(`${safeError}；脱敏失败证据已写入长期验证目录`);
  }
  } finally {
    releaseLock();
  }
}

if (require.main === module) {
  runVerification().catch((error) => {
    process.stderr.write(`TOAPIS_VIDEO_VERIFICATION_FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  EVIDENCE_VERSION,
  acquireVerificationLock,
  assertMoliPublicAssetBaseUrl,
  assertPublicArtifact,
  buildRequiredMatrix,
  buildReleaseEvidence,
  buildSpeedEvidenceSummary,
  buildVerificationRequest,
  buildVerifiedCapabilities,
  calculateBalanceDelta,
  canConfirmCostReview,
  decideResumeAction,
  downloadAndInspect,
  evidenceBindingForFile,
  hasCompletePricing,
  hasCompleteRequiredMatrix,
  parseFfprobeJson,
  processCase,
  publishVerifiedEvidence,
  recordVerificationResult,
  redactEvidence,
  requireDedicatedVerificationToken,
  requireVerificationConfigIds,
  requiredPriceFloors,
  resolveVerificationPaths,
  runVerification,
  safeChildProcessEnv,
  selectVerificationCases,
  validateCompletedResult,
  validateVerificationConfigs,
  verifyAllStoredResults,
};
