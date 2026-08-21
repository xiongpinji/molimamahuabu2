'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const config = require('../config');
const { getFfmpegPath, getFfprobePath } = require('../utils/ffmpegPath');

const execFileAsync = promisify(execFile);
const CONDITIONING_DIR = 'redraw-conditioning';
const PROVIDER_ASSET_ROUTE = '/api/v1/redraw-provider-assets';
const DEFAULT_SEGMENT_VERSION = 'h264-aac-v1';
const STRIPPED_SEGMENT_VERSION = 'h264-video-only-v1';
const DEFAULT_TTL_SECONDS = 30 * 60;
const MAX_TTL_SECONDS = 30 * 60;
const DURATION_TOLERANCE_MS = 100;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const FILE_PATTERN = /^([a-f0-9]{64})\.mp4$/;

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function isLoopbackHostname(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true;
  if (net.isIP(host) === 4) return host.startsWith('127.');
  return false;
}

function publicStorageOrigin(storageBaseUrl) {
  let parsed;
  try {
    parsed = new URL(String(storageBaseUrl || '').trim());
  } catch (_) {
    throw codedError('REDRAW_PROVIDER_ASSET_ORIGIN_UNSAFE', 'storage.base_url 必须是可供供应商访问的 HTTPS 地址');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || isLoopbackHostname(parsed.hostname)) {
    throw codedError('REDRAW_PROVIDER_ASSET_ORIGIN_UNSAFE', 'storage.base_url 必须是非 localhost 的 HTTPS 地址');
  }
  return parsed.origin;
}

function signingSecret(value) {
  const secret = String(value || '');
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw codedError('REDRAW_PROVIDER_ASSET_SECRET_REQUIRED', '缺少至少 32 字节的源片 provider asset HMAC secret');
  }
  return secret;
}

function routePrefix(value = PROVIDER_ASSET_ROUTE) {
  const normalized = String(value || PROVIDER_ASSET_ROUTE).trim().replace(/\/+$/, '');
  if (!normalized.startsWith('/') || normalized.includes('..') || normalized.includes('?') || normalized.includes('#')) {
    throw codedError('REDRAW_PROVIDER_ASSET_PATH_INVALID', 'provider asset 路由路径无效');
  }
  return normalized;
}

function hmacSignature(secret, pathname, expiresAt) {
  return crypto.createHmac('sha256', secret)
    .update(`GET\n${pathname}\n${expiresAt}`)
    .digest('hex');
}

function normalizeNowMs(value) {
  const number = value == null ? Date.now() : Number(value);
  if (!Number.isFinite(number) || number < 0) throw codedError('REDRAW_PROVIDER_ASSET_TIME_INVALID', '签名时间无效');
  return Math.floor(number);
}

function createProviderAssetUrl(input = {}) {
  const hash = String(input.segmentSha256 || '').trim().toLowerCase();
  if (!HASH_PATTERN.test(hash)) throw codedError('REDRAW_PROVIDER_ASSET_PATH_INVALID', 'segment hash 无效');
  const origin = publicStorageOrigin(input.storageBaseUrl);
  const secret = signingSecret(input.signingSecret);
  const prefix = routePrefix(input.routePrefix);
  const nowMs = normalizeNowMs(input.nowMs);
  const ttlSeconds = Number(input.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_TTL_SECONDS) {
    throw codedError('REDRAW_PROVIDER_ASSET_TTL_INVALID', `provider asset 有效期必须在 1 到 ${MAX_TTL_SECONDS} 秒之间`);
  }
  const pathname = `${prefix}/${hash}.mp4`;
  const expiresAt = Math.floor(nowMs / 1000) + ttlSeconds;
  const signature = hmacSignature(secret, pathname, expiresAt);
  const url = new URL(pathname, origin);
  url.searchParams.set('expires', String(expiresAt));
  url.searchParams.set('signature', signature);
  return { url: url.toString(), pathname, expiresAt };
}

function timingSafeHexEqual(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function verifyProviderAssetUrl(value, input = {}) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch (_) {
    throw codedError('REDRAW_PROVIDER_ASSET_URL_INVALID', 'provider asset URL 无效');
  }
  const expectedOrigin = publicStorageOrigin(input.storageBaseUrl);
  if (url.origin !== expectedOrigin || url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw codedError('REDRAW_PROVIDER_ASSET_ORIGIN_UNSAFE', 'provider asset URL origin 不匹配');
  }
  const prefix = routePrefix(input.routePrefix);
  const match = url.pathname.match(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\/([a-f0-9]{64})\\.mp4$`));
  if (!match) throw codedError('REDRAW_PROVIDER_ASSET_PATH_INVALID', 'provider asset URL 路径无效');
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 2 || keys.filter((key) => key === 'expires').length !== 1
    || keys.filter((key) => key === 'signature').length !== 1) {
    throw codedError('REDRAW_PROVIDER_ASSET_SIGNATURE_INVALID', 'provider asset URL 签名参数无效');
  }
  const expiresAt = Number(url.searchParams.get('expires'));
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(normalizeNowMs(input.nowMs) / 1000)) {
    throw codedError('REDRAW_PROVIDER_ASSET_EXPIRED', 'provider asset URL 已过期');
  }
  const secret = signingSecret(input.signingSecret);
  const actual = String(url.searchParams.get('signature') || '').toLowerCase();
  const expected = hmacSignature(secret, url.pathname, expiresAt);
  if (!timingSafeHexEqual(actual, expected)) {
    throw codedError('REDRAW_PROVIDER_ASSET_SIGNATURE_INVALID', 'provider asset URL HMAC 校验失败');
  }
  return { segmentSha256: match[1], pathname: url.pathname, expiresAt };
}

function resolveStorageRoot(value) {
  if (value) return path.resolve(String(value));
  const cfg = config.loadConfig();
  const raw = cfg.storage?.local_path || './data/storage';
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(process.cwd(), raw);
}

function readConfigDefaults(input) {
  if (input.storageRoot && input.storageBaseUrl) return input;
  const cfg = config.loadConfig();
  return {
    ...input,
    storageRoot: input.storageRoot || cfg.storage?.local_path,
    storageBaseUrl: input.storageBaseUrl || cfg.storage?.base_url,
  };
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

async function resolveProviderAssetPath(input = {}) {
  const filename = String(input.filename || '').trim().toLowerCase();
  const match = FILE_PATTERN.exec(filename);
  if (!match) throw codedError('REDRAW_PROVIDER_ASSET_PATH_INVALID', 'provider asset 文件名无效');
  const storageRoot = resolveStorageRoot(input.storageRoot);
  const conditioningRoot = path.resolve(storageRoot, CONDITIONING_DIR);
  const candidate = path.resolve(conditioningRoot, filename);
  if (path.dirname(candidate) !== conditioningRoot || !isInside(storageRoot, candidate)) {
    throw codedError('REDRAW_PROVIDER_ASSET_PATH_INVALID', 'provider asset 路径越界');
  }
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch (_) {
    throw codedError('REDRAW_PROVIDER_ASSET_NOT_FOUND', 'provider asset 不存在');
  }
  if (!isInside(conditioningRoot, real) && path.resolve(real) !== candidate) {
    throw codedError('REDRAW_PROVIDER_ASSET_PATH_INVALID', 'provider asset realpath 越界');
  }
  const stat = fs.statSync(real);
  if (!stat.isFile() || stat.size <= 0) throw codedError('REDRAW_PROVIDER_ASSET_NOT_FOUND', 'provider asset 不可读');
  const actualHash = await sha256File(real);
  if (actualHash !== match[1]) {
    throw codedError('REDRAW_PROVIDER_ASSET_HASH_MISMATCH', 'provider asset 内容 hash 不匹配');
  }
  return real;
}

function safeSourcePath(storageRoot, localPath) {
  const raw = String(localPath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw || path.isAbsolute(raw) || raw.split('/').includes('..')) {
    throw codedError('REDRAW_SOURCE_CONDITIONING_PATH_INVALID', '源片本地路径无效');
  }
  const candidate = path.resolve(storageRoot, raw);
  if (!isInside(storageRoot, candidate)) {
    throw codedError('REDRAW_SOURCE_CONDITIONING_PATH_INVALID', '源片路径越界');
  }
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch (_) {
    throw codedError('REDRAW_SOURCE_CONDITIONING_NOT_FOUND', '源片文件不存在');
  }
  if (!isInside(storageRoot, real)) {
    throw codedError('REDRAW_SOURCE_CONDITIONING_PATH_INVALID', '源片 realpath 越界');
  }
  const stat = fs.statSync(real);
  if (!stat.isFile() || stat.size <= 0) throw codedError('REDRAW_SOURCE_CONDITIONING_NOT_FOUND', '源片文件不可读');
  return real;
}

function normalizeAudioMode(value) {
  return value === 'strip' ? 'strip' : 'preserve';
}

function segmentVersion(audioMode) {
  return audioMode === 'strip' ? STRIPPED_SEGMENT_VERSION : DEFAULT_SEGMENT_VERSION;
}

function parseProbe(raw, requirements) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (_) {
    throw codedError('REDRAW_SOURCE_CONDITIONING_PROBE_INVALID', 'ffprobe 返回无效 JSON');
  }
  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const width = Number(video?.width);
  const height = Number(video?.height);
  const durationSeconds = Number(video?.duration ?? parsed?.format?.duration);
  if (!video || !Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0
    || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw codedError('REDRAW_SOURCE_CONDITIONING_PROBE_INVALID', 'ffprobe 未返回有效视频时长或尺寸');
  }
  if (requirements?.videoCodec === 'h264' && video.codec_name !== 'h264') {
    throw codedError('REDRAW_SOURCE_CONDITIONING_CODEC_INVALID', 'conditioning segment 必须是 H.264 MP4');
  }
  if (requirements?.audioMode === 'preserve' && audio?.codec_name !== 'aac') {
    throw codedError('REDRAW_SOURCE_CONDITIONING_CODEC_INVALID', 'conditioning segment 必须包含 AAC 音轨');
  }
  if (requirements?.audioMode === 'strip' && audio) {
    throw codedError('REDRAW_SOURCE_CONDITIONING_CODEC_INVALID', 'conditioning segment 不得保留源音轨');
  }
  return {
    durationMs: Math.round(durationSeconds * 1000),
    width,
    height,
    videoCodec: String(video.codec_name || ''),
    audioCodec: audio ? String(audio.codec_name || '') : null,
  };
}

async function probeVideo(filePath, input, requirements) {
  const runner = input.execFile || execFileAsync;
  let result;
  try {
    result = await runner(input.ffprobePath || getFfprobePath(), [
      '-v', 'error',
      '-show_streams',
      '-show_format',
      '-of', 'json',
      filePath,
    ], {
      timeout: Number(input.probeTimeoutMs || 15000),
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    throw codedError('REDRAW_SOURCE_CONDITIONING_PROBE_FAILED', `ffprobe 校验失败: ${error.message}`);
  }
  return parseProbe(result?.stdout ?? result, requirements);
}

function normalizeBoundary(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw codedError('REDRAW_SOURCE_CONDITIONING_BOUNDARY_INVALID', `${name} 必须是非负整数毫秒`);
  }
  return number;
}

function readMetadata(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (_) {
    return null;
  }
}

function conditioningKey(sourceAssetId, sourceFingerprint, startMs, endMs, audioMode) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({
      version: segmentVersion(audioMode),
      audio_mode: audioMode,
      source_asset_id: sourceAssetId,
      source_fingerprint: sourceFingerprint,
      start_ms: startMs,
      end_ms: endMs,
    }))
    .digest('hex');
}

function auditSnapshot(metadata, signed, shotId) {
  return {
    schema_version: '1.0',
    segment_version: metadata.version,
    audio_mode: metadata.audio_mode,
    shot_id: shotId,
    source_asset_id: metadata.source_asset_id,
    source_fingerprint: metadata.source_fingerprint,
    start_ms: metadata.start_ms,
    end_ms: metadata.end_ms,
    segment_duration_ms: metadata.segment_duration_ms,
    width: metadata.width,
    height: metadata.height,
    video_codec: metadata.video_codec,
    audio_codec: metadata.audio_codec,
    segment_sha256: metadata.segment_sha256,
    segment_local_path: metadata.segment_local_path,
    provider_asset_path: signed.pathname,
    provider_asset_expires_at: new Date(signed.expiresAt * 1000).toISOString(),
  };
}

async function cachedMetadata(metadata, expected, input, storageRoot) {
  if (!metadata || metadata.version !== expected.version
    || metadata.audio_mode !== expected.audio_mode
    || metadata.source_asset_id !== expected.source_asset_id
    || metadata.source_fingerprint !== expected.source_fingerprint
    || metadata.start_ms !== expected.start_ms
    || metadata.end_ms !== expected.end_ms
    || !HASH_PATTERN.test(String(metadata.segment_sha256 || ''))
    || metadata.segment_local_path !== `${CONDITIONING_DIR}/${metadata.segment_sha256}.mp4`) {
    return null;
  }
  let absolute;
  try {
    absolute = await resolveProviderAssetPath({ storageRoot, filename: `${metadata.segment_sha256}.mp4` });
  } catch (_) {
    return null;
  }
  const probe = await probeVideo(absolute, input, {
    videoCodec: 'h264',
    audioMode: expected.audio_mode,
  });
  const expectedDuration = expected.end_ms - expected.start_ms;
  if (Math.abs(probe.durationMs - expectedDuration) > DURATION_TOLERANCE_MS
    || probe.width !== metadata.width || probe.height !== metadata.height) return null;
  return { ...metadata, segment_duration_ms: probe.durationMs };
}

function atomicWriteJson(target, value) {
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

async function generateSegment(sourcePath, targetTemp, sourceProbe, expected, input) {
  const runner = input.execFile || execFileAsync;
  const startSeconds = (expected.start_ms / 1000).toFixed(3);
  const durationSeconds = ((expected.end_ms - expected.start_ms) / 1000).toFixed(3);
  try {
    const audioArgs = expected.audio_mode === 'strip'
      ? ['-an']
      : ['-map', '0:a:0?', '-c:a', 'aac'];
    await runner(input.ffmpegPath || getFfmpegPath(), [
      '-y',
      '-v', 'error',
      '-i', sourcePath,
      '-ss', startSeconds,
      '-t', durationSeconds,
      '-map', '0:v:0',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      ...audioArgs,
      '-movflags', '+faststart',
      '-avoid_negative_ts', 'make_zero',
      targetTemp,
    ], {
      timeout: Number(input.ffmpegTimeoutMs || 120000),
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    throw codedError('REDRAW_SOURCE_CONDITIONING_FFMPEG_FAILED', `ffmpeg 切分源片失败: ${error.message}`);
  }
  if (!fs.existsSync(targetTemp) || fs.statSync(targetTemp).size <= 0) {
    throw codedError('REDRAW_SOURCE_CONDITIONING_FFMPEG_FAILED', 'ffmpeg 未生成可读 segment');
  }
  const probe = await probeVideo(targetTemp, input, {
    videoCodec: 'h264',
    audioMode: expected.audio_mode,
  });
  const expectedDuration = expected.end_ms - expected.start_ms;
  if (Math.abs(probe.durationMs - expectedDuration) > DURATION_TOLERANCE_MS) {
    throw codedError('REDRAW_SOURCE_CONDITIONING_DURATION_MISMATCH', 'conditioning segment 时长与 shot 边界不一致');
  }
  if (probe.width !== sourceProbe.width || probe.height !== sourceProbe.height) {
    throw codedError('REDRAW_SOURCE_CONDITIONING_DIMENSION_MISMATCH', 'conditioning segment 尺寸与源片不一致');
  }
  return probe;
}

async function prepareSourceConditioning(rawInput = {}) {
  const input = readConfigDefaults(rawInput);
  if (!input.db) throw codedError('REDRAW_SOURCE_CONDITIONING_CONTEXT_INVALID', '缺少数据库上下文');
  const shotId = Number(input.shot?.id);
  if (!Number.isSafeInteger(shotId) || shotId <= 0) {
    throw codedError('REDRAW_SOURCE_CONDITIONING_SHOT_REQUIRED', '缺少服务器选定的 shot 记录');
  }
  const sourceAssetId = Number(input.sourceAssetId);
  if (!Number.isSafeInteger(sourceAssetId) || sourceAssetId <= 0) {
    throw codedError('REDRAW_SOURCE_CONDITIONING_NOT_FOUND', '源片资产不存在');
  }
  const sourceFingerprint = String(input.sourceFingerprint || '').trim().toLowerCase();
  if (!HASH_PATTERN.test(sourceFingerprint)) {
    throw codedError('REDRAW_SOURCE_FINGERPRINT_INVALID', '源片 fingerprint 必须是 SHA-256');
  }
  const startMs = normalizeBoundary(input.startMs, 'start_ms');
  const endMs = normalizeBoundary(input.endMs, 'end_ms');
  const audioMode = normalizeAudioMode(input.audioMode);
  if (endMs <= startMs) throw codedError('REDRAW_SOURCE_CONDITIONING_BOUNDARY_INVALID', 'end_ms 必须大于 start_ms');

  const asset = input.db.prepare('SELECT id, local_path, deleted_at FROM assets WHERE id = ? AND deleted_at IS NULL')
    .get(sourceAssetId);
  if (!asset) throw codedError('REDRAW_SOURCE_CONDITIONING_NOT_FOUND', '源片资产不存在');
  const storageRoot = resolveStorageRoot(input.storageRoot);
  const sourcePath = safeSourcePath(storageRoot, asset.local_path);
  const actualSourceHash = await sha256File(sourcePath);
  if (actualSourceHash !== sourceFingerprint) {
    throw codedError('REDRAW_SOURCE_FINGERPRINT_MISMATCH', '源片内容与 work.source_fingerprint 不一致');
  }
  const sourceProbe = await probeVideo(sourcePath, input, false);
  if (endMs > sourceProbe.durationMs + DURATION_TOLERANCE_MS) {
    throw codedError('REDRAW_SOURCE_CONDITIONING_BOUNDARY_INVALID', 'shot 边界超出源片时长');
  }

  const expected = {
    version: segmentVersion(audioMode),
    audio_mode: audioMode,
    source_asset_id: sourceAssetId,
    source_fingerprint: sourceFingerprint,
    start_ms: startMs,
    end_ms: endMs,
  };
  const conditioningRoot = path.resolve(storageRoot, CONDITIONING_DIR);
  if (!isInside(storageRoot, conditioningRoot)) {
    throw codedError('REDRAW_SOURCE_CONDITIONING_PATH_INVALID', 'conditioning 存储目录越界');
  }
  fs.mkdirSync(conditioningRoot, { recursive: true });
  const key = conditioningKey(sourceAssetId, sourceFingerprint, startMs, endMs, audioMode);
  const metadataPath = path.join(conditioningRoot, `${key}.json`);
  let metadata = await cachedMetadata(readMetadata(metadataPath), expected, input, storageRoot);
  let reused = Boolean(metadata);

  if (!metadata) {
    const targetTemp = path.join(conditioningRoot, `.${key}.${process.pid}.${crypto.randomUUID()}.mp4`);
    try {
      const probe = await generateSegment(sourcePath, targetTemp, sourceProbe, expected, input);
      const segmentSha256 = await sha256File(targetTemp);
      const finalPath = path.join(conditioningRoot, `${segmentSha256}.mp4`);
      if (fs.existsSync(finalPath)) {
        const existingHash = await sha256File(finalPath);
        if (existingHash === segmentSha256) {
          fs.rmSync(targetTemp, { force: true });
        } else {
          fs.rmSync(finalPath, { force: true });
          fs.renameSync(targetTemp, finalPath);
        }
      } else {
        fs.renameSync(targetTemp, finalPath);
      }
      metadata = {
        ...expected,
        segment_duration_ms: probe.durationMs,
        width: probe.width,
        height: probe.height,
        video_codec: probe.videoCodec,
        audio_codec: probe.audioCodec,
        segment_sha256: segmentSha256,
        segment_local_path: `${CONDITIONING_DIR}/${segmentSha256}.mp4`,
      };
      atomicWriteJson(metadataPath, metadata);
    } finally {
      fs.rmSync(targetTemp, { force: true });
    }
  }

  const signed = createProviderAssetUrl({
    storageBaseUrl: input.storageBaseUrl,
    segmentSha256: metadata.segment_sha256,
    signingSecret: input.signingSecret ?? process.env.REDRAW_PROVIDER_ASSET_HMAC_SECRET,
    routePrefix: input.routePrefix,
    nowMs: input.nowMs,
    ttlSeconds: input.ttlSeconds,
  });
  return {
    referenceVideoUrl: signed.url,
    segmentSha256: metadata.segment_sha256,
    relativePath: metadata.segment_local_path,
    reused,
    billingSnapshot: {
      source_asset_id: metadata.source_asset_id,
      source_fingerprint: metadata.source_fingerprint,
      start_ms: metadata.start_ms,
      end_ms: metadata.end_ms,
      segment_sha256: metadata.segment_sha256,
      audio_mode: metadata.audio_mode,
    },
    auditSnapshot: auditSnapshot(metadata, signed, shotId),
  };
}

module.exports = {
  CONDITIONING_DIR,
  PROVIDER_ASSET_ROUTE,
  prepareSourceConditioning,
  createProviderAssetUrl,
  verifyProviderAssetUrl,
  resolveProviderAssetPath,
};
