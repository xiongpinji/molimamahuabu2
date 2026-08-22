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

const BASE_URL = 'https://toapis.com';
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

function buildVerificationOptions(item, refs = {}) {
  if (!item || !REQUIRED_MATRIX.some((entry) => entry.id === item.id)) throw new Error('未知验证用例');
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
    client_business_id: `moli-verify-${item.id}`,
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

function buildVerificationRequest(item, refs = {}) {
  return buildToapisVideoBody(buildVerificationOptions(item, refs));
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
  const intervals = results.map((item) => ({
    before: item?.billing?.before,
    after: item?.billing?.after,
    beforeAt: Date.parse(String(item?.billing?.before?.captured_at || '')),
    afterAt: Date.parse(String(item?.billing?.after?.captured_at || '')),
  })).sort((left, right) => left.beforeAt - right.beforeAt);
  const windows = new Set(intervals.map((item) => `${item.beforeAt}|${item.afterAt}`));
  if (windows.size !== intervals.length) return false;
  for (let index = 1; index < intervals.length; index += 1) {
    const previous = intervals[index - 1];
    const current = intervals[index];
    if (previous.afterAt > current.beforeAt
        || Number(previous.after?.used_balance) !== Number(current.before?.used_balance)
        || Number(previous.after?.used_credits) !== Number(current.before?.used_credits)) return false;
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

function buildVerifiedCapabilities(results) {
  if (!hasCompleteRequiredMatrix(results)) return {};
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
      maxReferences: omni?.request?.image_with_roles?.length || 0,
      maxVideoReferences: omni?.request?.video_with_roles?.length || 0,
      maxAudioReferences: omni?.request?.audio_with_roles?.length || 0,
    };
  }
  return output;
}

function requireApiKey(argv = process.argv, env = process.env) {
  if (argv.some((value) => /(?:api[-_]?key|token)=/i.test(value))) throw new Error('禁止通过命令行参数传入供应商 Key');
  const value = String(env.TOAPIS_API_KEY || '').trim();
  if (!value) throw new Error('缺少 TOAPIS_API_KEY');
  return value;
}

function requireDedicatedVerificationToken(env = process.env) {
  if (String(env.TOAPIS_VERIFY_DEDICATED_TOKEN || '').trim() !== '1') {
    throw new Error('真实扣费验证必须使用不被其他业务并发调用的专用验证 Token');
  }
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
  return {
    used_balance: Number(payload.used_balance),
    used_credits: Number(payload.used_credits),
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

function openVerificationDb() {
  const configured = String(process.env.TOAPIS_VERIFY_DATABASE_PATH || process.env.DATABASE_PATH || '').trim()
    || loadConfig().database?.path;
  if (!configured || configured === ':memory:') throw new Error('缺少可写入验证状态的数据库路径');
  const db = new Database(path.resolve(process.cwd(), configured));
  runMigrationsAndEnsure(db);
  return db;
}

function recordVerificationResult(results, error = null) {
  const configId = Number(process.env.TOAPIS_VERIFY_CONFIG_ID || 0);
  if (!configId) return null;
  const db = openVerificationDb();
  try {
    if (error) return aiConfigService.recordVerification(db, configId, { status: 'failed', error: error.message || error });
    if (!hasCompleteRequiredMatrix(results)) return null;
    return aiConfigService.recordVerification(db, configId, {
      status: 'verified',
      verifiedAt: new Date().toISOString(),
      capabilities: buildVerifiedCapabilities(results),
    });
  } finally {
    db.close();
  }
}

function parseJsonEnv(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (_) { throw new Error(`${name} 必须是有效 JSON`); }
}

function expectedCostForCase(item) {
  const values = parseJsonEnv('TOAPIS_EXPECTED_COST_YUAN_JSON', {});
  const value = Number(values[item.id]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`缺少 ${item.id} 的预计人民币成本，禁止提交付费请求`);
  return value;
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
    const status = await (deps.fetchTask || fetchToapisTask)(config, taskId, { fetchImpl: deps.fetchImpl });
    await onProgress(status);
    if (status.state === 'completed') return status;
    if (status.state === 'failed') throw new Error(status.error || 'ToAPIs 视频任务失败');
    await (deps.sleep || sleep)(intervalMs);
  }
  throw new Error(`ToAPIs 任务轮询超时: ${taskId}`);
}

async function processCase(item, context, deps = {}) {
  const previous = context.state.cases[item.id] || null;
  const action = decideResumeAction(previous);
  if (action === 'stop-indeterminate') {
    throw new Error(`${item.id} 上次提交结果未知，为避免重复扣费已停止；必须人工核对供应商任务后写入 task_id`);
  }
  if (action === 'complete') {
    await verifyStoredArtifact(previous, item, context, deps);
    context.state.cases[item.id] = previous;
    writeJsonAtomic(context.statePath, context.state);
    return previous;
  }

  let entry = previous;
  if (action === 'submit') {
    context.submittedCaseIds.push(item.id);
    const expectedCostYuan = expectedCostForCase(item);
    const clientOptions = buildVerificationOptions(item, context.refs);
    const request = buildToapisVideoBody(clientOptions);
    const balanceBefore = await (deps.fetchBalance || fetchBalance)(context.apiKey, deps.fetchImpl);
    const startedAt = nowDate(deps);
    entry = {
      id: item.id,
      model: item.model,
      mode: item.mode,
      requested_resolution: item.resolution,
      requested_duration: item.duration,
      status: 'submitting',
      submission_state: 'submitting',
      request,
      billing: { expected_cost_yuan: expectedCostYuan, before: balanceBefore, reviewed: false },
      started_at: startedAt.toISOString(),
    };
    context.state.cases[item.id] = entry;
    writeJsonAtomic(context.statePath, context.state);
    process.stdout.write(`SUBMIT ${item.id} model=${item.model} resolution=${item.resolution} duration=${item.duration}s expected_cost_yuan=${expectedCostYuan}\n`);
    const created = await (deps.createTask || callToapisVideoApi)(
      context.config,
      LOG,
      clientOptions,
      { fetchImpl: deps.fetchImpl },
    );
    const acceptedAt = nowDate(deps);
    if (created.indeterminate) {
      entry.status = 'indeterminate';
      entry.submission_state = 'indeterminate';
      entry.error = created.error;
      writeJsonAtomic(context.statePath, context.state);
      throw new Error(created.error);
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
    const completed = await waitForTask(context.config, entry.provider_task_id, async (status) => {
      entry.status = status.state;
      entry.progress = status.progress;
      if (status.error) entry.poll_message = status.error;
      writeJsonAtomic(context.statePath, context.state);
    }, deps);
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
  const balanceAfter = await (deps.fetchBalance || fetchBalance)(context.apiKey, deps.fetchImpl);
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
  const apiKey = requireApiKey();
  const {
    outputDir,
    publicArtifactDir,
    publicAssetBaseUrl,
    statePath,
    evidencePath,
    lockPath,
  } = resolveVerificationPaths(process.env);
  await fs.promises.mkdir(outputDir, { recursive: true });
  await fs.promises.mkdir(publicArtifactDir, { recursive: true });
  const releaseLock = acquireVerificationLock(lockPath);
  try {
  const state = readJson(statePath, { state_version: STATE_VERSION, cases: {} });
  if (state.state_version !== STATE_VERSION || !state.cases || typeof state.cases !== 'object') {
    throw new Error('验证状态文件版本不兼容');
  }
  const context = {
    apiKey,
    config: { base_url: BASE_URL, api_key: apiKey },
    outputDir,
    artifactOutputDir: publicArtifactDir,
    publicAssetBaseUrl,
    statePath,
    state,
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
    for (const item of selectVerificationCases()) {
      activeCase = item.id;
      const result = await processCase(item, context, deps);
      process.stdout.write(`VERIFIED ${result.id} task=${result.provider_task_id} sha256=${result.artifact.sha256}\n`);
    }
    const results = await verifyAllStoredResults(context, deps);
    const pricing = loadPricingEvidence();
    const evidence = buildReleaseEvidence(results, pricing, state.last_cost_review || null);
    writeJsonAtomic(evidencePath, evidence);
    process.stdout.write(`${formatSpeedEvidenceSummary(evidence.speed_evidence)}\n`);
    if (context.confirmCostReview && !canConfirmCostReview(context)) {
      throw new Error('本轮发生了付费提交或运行开始前尚未完成 8 个组合，费用确认必须在下一次零 POST 运行中执行');
    }
    if (!hasCompleteRequiredMatrix(results)) throw new Error('8 个必需真实验证组合尚未全部完成并复核费用');
    if (!hasCompletePricing(pricing, results)) throw new Error('两模型 480P/720P 的人民币成本与积分价格尚未全部复核');
    recordVerificationResult(results);
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
    recordVerificationResult(Object.values(state.cases), new Error(safeError));
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
  hasCompletePricing,
  hasCompleteRequiredMatrix,
  parseFfprobeJson,
  processCase,
  recordVerificationResult,
  redactEvidence,
  requireDedicatedVerificationToken,
  requiredPriceFloors,
  resolveVerificationPaths,
  runVerification,
  safeChildProcessEnv,
  selectVerificationCases,
  validateCompletedResult,
  verifyAllStoredResults,
};
