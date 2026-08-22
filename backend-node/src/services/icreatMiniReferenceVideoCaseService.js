'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { getFfmpegPath, getFfprobePath } = require('../utils/ffmpegPath');
const { buildIcreatVideoBody } = require('./videoClient');

const execFileAsync = promisify(execFile);
const ICREAT_MINI_MODEL = 'bytedance/seedance-2-0-mini';
const EXPECTED_SOURCE_SHA256 = '24eb1d8ba3ff11e6aa3e547b7ac400f6b177dcf541d1af36354d3e46cc05e9ae';
const EXPECTED_CAST_SHA256 = '35b1f9f65d819b12b11f61e17720f202a6ebb4292660a7fe93ec55fedddc319e';
const MATEO_CROP = Object.freeze({ left: 176, top: 330, width: 510, height: 1100 });
const SOURCE_DURATION_SECONDS = 68.733333;
const MANUAL_REVIEW_KEYS = Object.freeze([
  'live_action_humans',
  'foreground_mateo',
  'background_actor_replacement',
  'shot_motion_timing_preserved',
  'english_dialogue_correct',
  'lip_sync_acceptable',
  'no_severe_artifacts',
]);
const MANUAL_REVIEW_VALUES = new Set(['passed', 'failed', 'uncertain']);

function codedError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function assertHash(value, expected, label) {
  if (String(value || '').trim().toLowerCase() !== expected) {
    throw codedError('ICREAT_CASE_INPUT_MISMATCH', `${label} SHA-256 与已批准案例不匹配`);
  }
}

function assertCaseInputContract(input = {}) {
  assertHash(input.sourceSha256, EXPECTED_SOURCE_SHA256, '源片');
  assertHash(input.castSha256, EXPECTED_CAST_SHA256, '演员合照');
  const probe = input.sourceProbe || {};
  const duration = Number(probe.durationSeconds);
  const fps = Number(probe.fps);
  if (!Number.isFinite(duration) || Math.abs(duration - SOURCE_DURATION_SECONDS) > 0.05
    || Number(probe.width) !== 720 || Number(probe.height) !== 1280
    || !Number.isFinite(fps) || Math.abs(fps - 30) > 0.05
    || String(probe.videoCodec || '').trim().toLowerCase() !== 'hevc'
    || String(probe.audioCodec || '').trim().toLowerCase() !== 'aac') {
    throw codedError('ICREAT_CASE_INPUT_MISMATCH', '源片媒体参数与已批准 HEVC/AAC 竖屏案例不匹配');
  }
  return {
    sourceSha256: EXPECTED_SOURCE_SHA256,
    castSha256: EXPECTED_CAST_SHA256,
    sourceProbe: {
      durationSeconds: duration,
      width: 720,
      height: 1280,
      fps,
      videoCodec: 'hevc',
      audioCodec: 'aac',
    },
  };
}

function assertCaseUrl(value, label) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw codedError('ICREAT_CASE_INPUT_MISMATCH', `${label}必须是 HTTPS URL`);
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || !hostname.endsWith('.localhost.run')) {
    throw codedError('ICREAT_CASE_INPUT_MISMATCH', `${label}必须来自本次 localhost.run HTTPS 通道`);
  }
  return url.toString();
}

const CASE_PROMPT = [
  'Recreate this exact 4-second vertical live-action shot at the same school entrance.',
  'Preserve the original framing, camera movement, blocking, action order, and timing.',
  'Replace every visible person with realistic live-action Latino students aged 18 or older.',
  'Use the primary Mateo portrait for the foreground speaker and the cast reference for every background actor.',
  'Do not retain East Asian faces. Do not create animation, dolls, extra people, fused bodies, or malformed limbs.',
  'Mateo looks confused and naturally challenging, then says exactly: "Dude, who are you?"',
  'Deliver the line in natural American English from approximately 0.7 to 2.4 seconds with believable lip sync.',
].join(' ');

function buildIcreatMiniCaseSnapshot(input = {}) {
  const contract = assertCaseInputContract({
    sourceSha256: input.sourceSha256,
    castSha256: input.castSha256 ?? EXPECTED_CAST_SHA256,
    sourceProbe: input.sourceProbe ?? {
      durationSeconds: SOURCE_DURATION_SECONDS,
      width: 720,
      height: 1280,
      fps: 30,
      videoCodec: 'hevc',
      audioCodec: 'aac',
    },
  });
  const segmentUrl = assertCaseUrl(input.segmentUrl, '源片片段');
  const mateoUrl = assertCaseUrl(input.mateoUrl, 'Mateo 参考图');
  const castUrl = assertCaseUrl(input.castUrl, '演员合照');
  if (new Set([segmentUrl, mateoUrl, castUrl]).size !== 3) {
    throw codedError('ICREAT_CASE_INPUT_MISMATCH', '案例媒体 URL 不得重复');
  }
  const request = {
    model: ICREAT_MINI_MODEL,
    prompt: CASE_PROMPT,
    duration: 4,
    resolution: '480p',
    aspect_ratio: '9:16',
    generate_audio: true,
    reference_video_urls: [segmentUrl],
    reference_urls: [mateoUrl, castUrl],
    case_input: {
      source_sha256: contract.sourceSha256,
      cast_sha256: contract.castSha256,
      segment_sha256: input.segmentSha256 || null,
      mateo_sha256: input.mateoSha256 || null,
    },
  };
  buildIcreatVideoBody(request);
  const requestHash = sha256(canonicalJson(request));
  return deepFreeze({ ...request, request_sha256: requestHash });
}

function parseRate(value) {
  const [left, right] = String(value || '').split('/').map(Number);
  if (!Number.isFinite(left)) return NaN;
  if (!Number.isFinite(right)) return left;
  return right === 0 ? NaN : left / right;
}

function normalizeProbe(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (error) {
      throw codedError('ICREAT_CASE_INPUT_MISMATCH', 'ffprobe 返回无效 JSON', error);
    }
  }
  if (value?.videoCodec || value?.audioCodec !== undefined) return value;
  const streams = Array.isArray(value?.streams) ? value.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  return {
    durationSeconds: Number(value?.format?.duration ?? video?.duration),
    audioDurationSeconds: audio ? Number(audio.duration ?? value?.format?.duration) : null,
    width: Number(video?.width),
    height: Number(video?.height),
    fps: parseRate(video?.avg_frame_rate || video?.r_frame_rate),
    videoCodec: String(video?.codec_name || '').toLowerCase(),
    audioCodec: audio ? String(audio.codec_name || '').toLowerCase() : null,
    pixelFormat: String(video?.pix_fmt || '').toLowerCase(),
    formatName: String(value?.format?.format_name || '').toLowerCase(),
  };
}

async function defaultProbeMedia(filePath, options = {}) {
  const runner = options.execFile || execFileAsync;
  const result = await runner(options.ffprobePath || getFfprobePath(), [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath,
  ], { timeout: Number(options.ffprobeTimeoutMs || 15000), maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  return normalizeProbe(result?.stdout ?? result);
}

async function defaultTranscodeSegment(input, options = {}) {
  const runner = options.execFile || execFileAsync;
  await runner(options.ffmpegPath || getFfmpegPath(), [
    '-y', '-v', 'error', '-i', input.sourcePath,
    '-ss', (input.startMs / 1000).toFixed(3),
    '-t', ((input.endMs - input.startMs) / 1000).toFixed(3),
    '-map', '0:v:0', '-c:v', 'libx264', '-pix_fmt', input.pixelFormat,
    '-an', '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', input.targetPath,
  ], { timeout: Number(options.ffmpegTimeoutMs || 120000), maxBuffer: 8 * 1024 * 1024, windowsHide: true });
}

async function defaultCropImage(input) {
  const sharp = require('sharp');
  return sharp(input.sourcePath).extract(input.crop).png().toFile(input.targetPath);
}

function assertReadableFile(filePath, label) {
  try {
    const real = fs.realpathSync(String(filePath || ''));
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size <= 0) throw new Error('empty file');
    return real;
  } catch (error) {
    throw codedError('ICREAT_CASE_INPUT_MISMATCH', `${label}不可读取`, error);
  }
}

function assertPreparedSegment(probe) {
  if (Math.abs(Number(probe.durationSeconds) - 4) > 0.1
    || Number(probe.width) !== 720 || Number(probe.height) !== 1280
    || Math.abs(Number(probe.fps) - 30) > 0.05
    || String(probe.videoCodec || '').toLowerCase() !== 'h264'
    || probe.audioCodec != null
    || String(probe.pixelFormat || '').toLowerCase() !== 'yuv420p') {
    throw codedError('ICREAT_CASE_INPUT_MISMATCH', 'A 镜头转码结果不符合 4 秒 H.264 无音轨合同');
  }
}

async function prepareCaseMedia(options = {}) {
  const sourcePath = assertReadableFile(options.sourcePath, '源片');
  const castPath = assertReadableFile(options.castPath, '演员合照');
  const hashFile = options.hashFile || sha256File;
  const probeMedia = options.probeMedia || ((filePath) => defaultProbeMedia(filePath, options));
  const sourceSha256 = String(await hashFile(sourcePath)).toLowerCase();
  const castSha256 = String(await hashFile(castPath)).toLowerCase();
  const sourceProbe = normalizeProbe(await probeMedia(sourcePath));
  assertCaseInputContract({ sourceSha256, castSha256, sourceProbe });

  const base = path.resolve(options.tempRoot || os.tmpdir());
  fs.mkdirSync(base, { recursive: true });
  const rootDir = fs.mkdtempSync(path.join(base, 'icreat-mini-case-'));
  try { fs.chmodSync(rootDir, 0o700); } catch (_) {}
  const segmentPath = path.join(rootDir, 'source-shot.mp4');
  const castCopyPath = path.join(rootDir, 'cast-reference.png');
  const mateoPath = path.join(rootDir, 'mateo-reference.png');
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    fs.rmSync(rootDir, { recursive: true, force: true });
  };

  try {
    fs.copyFileSync(castPath, castCopyPath);
    const transcodeInput = {
      sourcePath,
      targetPath: segmentPath,
      startMs: 0,
      endMs: 4000,
      videoCodec: 'h264',
      pixelFormat: 'yuv420p',
      audioMode: 'strip',
      fastStart: true,
    };
    await (options.transcodeSegment || ((input) => defaultTranscodeSegment(input, options)))(transcodeInput);
    const cropInfo = await (options.cropImage || defaultCropImage)({
      sourcePath: castCopyPath,
      targetPath: mateoPath,
      crop: { ...MATEO_CROP },
    });
    assertReadableFile(segmentPath, 'A 镜头片段');
    assertReadableFile(castCopyPath, '演员合照副本');
    assertReadableFile(mateoPath, 'Mateo 裁剪图');
    if (Number(cropInfo?.width) !== MATEO_CROP.width || Number(cropInfo?.height) !== MATEO_CROP.height) {
      throw codedError('ICREAT_CASE_INPUT_MISMATCH', 'Mateo 裁剪尺寸不符合固定合同');
    }
    const segmentProbe = normalizeProbe(await probeMedia(segmentPath));
    assertPreparedSegment(segmentProbe);
    const [segmentSha256, copiedCastSha256, mateoSha256] = await Promise.all([
      hashFile(segmentPath), hashFile(castCopyPath), hashFile(mateoPath),
    ]);
    assertHash(copiedCastSha256, EXPECTED_CAST_SHA256, '演员合照副本');
    return {
      rootDir,
      source: { path: sourcePath, sha256: sourceSha256, probe: sourceProbe },
      segment: { path: segmentPath, sha256: String(segmentSha256).toLowerCase(), probe: segmentProbe },
      mateo: { path: mateoPath, sha256: String(mateoSha256).toLowerCase(), crop: { ...MATEO_CROP } },
      cast: { path: castCopyPath, sha256: String(copiedCastSha256).toLowerCase() },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    if (error?.code) throw error;
    throw codedError('ICREAT_CASE_INPUT_MISMATCH', '案例媒体准备失败', error);
  }
}

function validateRequestHash(value) {
  const hash = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw codedError('ICREAT_CASE_INPUT_MISMATCH', '请求快照 SHA-256 无效');
  return hash;
}

function readLock(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (error) {
    throw codedError('ICREAT_CASE_LOCK_INVALID', '一次性提交状态不可读取', error);
  }
}

function createSubmissionLock(statePath, requestHash, options = {}) {
  const target = path.resolve(String(statePath || ''));
  const hash = validateRequestHash(requestHash);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const state = {
    schema_version: '1.0',
    request_hash: hash,
    consumed: false,
    status: 'ready',
    created_at: options.created_at || new Date().toISOString(),
  };
  try {
    fs.writeFileSync(target, JSON.stringify(state, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST') throw codedError('ICREAT_CASE_LOCK_EXISTS', '一次性提交锁已存在');
    throw codedError('ICREAT_CASE_LOCK_INVALID', '无法创建一次性提交锁', error);
  }
  return state;
}

function consumeSubmissionLock(statePath, requestHash, metadata = {}) {
  const target = path.resolve(String(statePath || ''));
  const hash = validateRequestHash(requestHash);
  const state = readLock(target);
  if (state.request_hash !== hash) throw codedError('ICREAT_CASE_LOCK_MISMATCH', '一次性提交锁与请求不匹配');
  const marker = `${target}.consumed`;
  const attemptedAt = metadata.attempted_at || new Date().toISOString();
  try {
    fs.writeFileSync(marker, JSON.stringify({ request_hash: hash, attempted_at: attemptedAt }), {
      encoding: 'utf8', flag: 'wx', mode: 0o600,
    });
  } catch (error) {
    if (error.code === 'EEXIST') throw codedError('ICREAT_CASE_ALREADY_SUBMITTED', '该案例请求已经尝试提交，禁止重试');
    throw codedError('ICREAT_CASE_LOCK_INVALID', '无法消费一次性提交锁', error);
  }
  const next = {
    ...state,
    consumed: true,
    attempted_at: attemptedAt,
    status: metadata.task_id ? 'submitted' : 'submission_unknown',
  };
  if (metadata.task_id) next.provider_task_id = String(metadata.task_id);
  fs.writeFileSync(target, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  return next;
}

function updateSubmissionLock(statePath, requestHash, patch = {}) {
  const target = path.resolve(String(statePath || ''));
  const hash = validateRequestHash(requestHash);
  const state = readLock(target);
  if (state.request_hash !== hash || state.consumed !== true) {
    throw codedError('ICREAT_CASE_LOCK_MISMATCH', '一次性提交锁状态与请求不匹配');
  }
  const next = { ...state };
  if (patch.status) next.status = String(patch.status);
  if (patch.task_id) next.provider_task_id = String(patch.task_id);
  if (patch.clear_task_id === true) delete next.provider_task_id;
  if (patch.updated_at) next.updated_at = String(patch.updated_at);
  fs.writeFileSync(target, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  return next;
}

function defaultManualReview() {
  return Object.fromEntries(MANUAL_REVIEW_KEYS.map((key) => [key, 'uncertain']));
}

function redactedMedia(value) {
  if (!value || typeof value !== 'object') return null;
  const output = {};
  for (const key of [
    'sha256', 'bytes', 'width', 'height', 'duration_seconds', 'audio_duration_seconds',
    'video_codec', 'audio_codec', 'audio_mode', 'non_silent', 'max_volume_db',
  ]) {
    if (value[key] !== undefined) output[key] = value[key];
  }
  return Object.keys(output).length ? output : null;
}

function buildRedactedEvidence(input = {}) {
  const providerTaskId = String(input.task_id || input.provider_task_id || '');
  const media = input.media && typeof input.media === 'object'
    ? Object.fromEntries(Object.entries(input.media)
      .map(([key, value]) => [key, redactedMedia(value)])
      .filter(([, value]) => value))
    : {};
  return {
    schema_version: '1.0',
    run_id: input.run_id ? String(input.run_id) : null,
    created_at: input.created_at || new Date().toISOString(),
    model: ICREAT_MINI_MODEL,
    config_id: Number.isSafeInteger(Number(input.config_id)) ? Number(input.config_id) : null,
    request_snapshot_sha256: input.request_snapshot_sha256 ? String(input.request_snapshot_sha256) : null,
    provider_task_id_sha256: providerTaskId ? sha256(providerTaskId) : null,
    status: String(input.status || 'dry_run'),
    status_timeline: Array.isArray(input.status_timeline)
      ? input.status_timeline.map((item) => ({ at: String(item?.at || ''), status: String(item?.status || '') }))
      : [],
    estimated_cost: input.estimated_cost ? {
      credits: Number(input.estimated_cost.credits),
      usd: Number(input.estimated_cost.usd),
    } : null,
    actual_cost: input.actual_cost ? {
      credits: Number(input.actual_cost.credits),
      usd: Number(input.actual_cost.usd),
    } : null,
    media,
    manual_review: defaultManualReview(),
    visual_actor_replacement_verified: false,
  };
}

function applyManualReview(evidence, updates = {}) {
  const current = { ...defaultManualReview(), ...(evidence?.manual_review || {}) };
  for (const [key, raw] of Object.entries(updates)) {
    const value = String(raw || '').trim().toLowerCase();
    if (!MANUAL_REVIEW_KEYS.includes(key) || !MANUAL_REVIEW_VALUES.has(value)) {
      throw codedError('ICREAT_CASE_REVIEW_INVALID', '人工审核字段或状态无效');
    }
    current[key] = value;
  }
  return {
    ...evidence,
    manual_review: current,
    visual_actor_replacement_verified: MANUAL_REVIEW_KEYS.every((key) => current[key] === 'passed'),
  };
}

async function defaultAnalyzeAudio(filePath, options = {}) {
  const runner = options.execFile || execFileAsync;
  const result = await runner(options.ffmpegPath || getFfmpegPath(), [
    '-hide_banner', '-i', filePath, '-vn', '-af', 'volumedetect', '-f', 'null', '-',
  ], { timeout: Number(options.ffmpegTimeoutMs || 60000), maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  const output = `${result?.stdout || ''}\n${result?.stderr || ''}`;
  const match = output.match(/max_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/i);
  const maxVolumeDb = match && match[1].toLowerCase() !== '-inf' ? Number(match[1]) : -Infinity;
  return { nonSilent: Number.isFinite(maxVolumeDb) && maxVolumeDb > -55, maxVolumeDb };
}

async function verifyCandidateMedia(options = {}) {
  let outputPath;
  try {
    outputPath = assertReadableFile(options.outputPath, '候选视频');
  } catch (error) {
    throw codedError('ICREAT_CASE_CANDIDATE_INVALID', error.message, error);
  }
  const probeMedia = options.probeMedia || ((filePath) => defaultProbeMedia(filePath, options));
  const analyzeAudio = options.analyzeAudio || ((filePath) => defaultAnalyzeAudio(filePath, options));
  const probe = normalizeProbe(await probeMedia(outputPath));
  const duration = Number(probe.durationSeconds);
  const audioDuration = Number(probe.audioDurationSeconds ?? duration);
  const audio = await analyzeAudio(outputPath);
  if (path.extname(outputPath).toLowerCase() !== '.mp4'
    || !String(probe.videoCodec || '') || !String(probe.audioCodec || '')
    || Number(probe.width) !== 480 || Number(probe.height) < 840 || Number(probe.height) > 864
    || !(duration >= 3.75 && duration <= 4.25)
    || !Number.isFinite(audioDuration) || Math.abs(audioDuration - duration) > 0.25
    || audio?.nonSilent !== true) {
    throw codedError('ICREAT_CASE_CANDIDATE_INVALID', '候选视频未通过 4 秒 480p 竖屏声画门禁');
  }
  const stat = fs.statSync(outputPath);
  return {
    sha256: await (options.hashFile || sha256File)(outputPath),
    bytes: stat.size,
    width: Number(probe.width),
    height: Number(probe.height),
    duration_seconds: duration,
    audio_duration_seconds: audioDuration,
    video_codec: String(probe.videoCodec),
    audio_codec: String(probe.audioCodec),
    non_silent: true,
    max_volume_db: Number(audio.maxVolumeDb),
  };
}

module.exports = {
  EXPECTED_CAST_SHA256,
  EXPECTED_SOURCE_SHA256,
  ICREAT_MINI_MODEL,
  MANUAL_REVIEW_KEYS,
  MATEO_CROP,
  applyManualReview,
  assertCaseInputContract,
  buildIcreatMiniCaseSnapshot,
  buildRedactedEvidence,
  canonicalJson,
  consumeSubmissionLock,
  createSubmissionLock,
  prepareCaseMedia,
  sha256File,
  updateSubmissionLock,
  verifyCandidateMedia,
};
