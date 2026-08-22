'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');
const { getFfmpegPath, hasLocalFfmpeg } = require('../utils/ffmpegPath');
const { signProviderAssetUrl } = require('./providerAssetUrlService');

const MAX_SIGNED_TTL_SECONDS = 2 * 60 * 60;
const COLORS = ['#2563eb', '#f59e0b', '#10b981', '#8b5cf6', '#ef4444', '#06b6d4'];

function count(value, name) {
  const result = value ?? 0;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return result;
}

function fixtureRoot(storageRoot) {
  if (typeof storageRoot !== 'string' || !storageRoot.trim()) {
    throw new TypeError('storageRoot must be a non-empty string');
  }
  return path.join(path.resolve(storageRoot), '_system', 'provider-canary', 'fixtures');
}

function relativeFixturePath(fileName) {
  return path.posix.join('_system', 'provider-canary', 'fixtures', fileName);
}

function item(filePath) {
  return { path: filePath, relativePath: relativeFixturePath(path.basename(filePath)) };
}

function existingFile(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0;
  } catch (_) {
    return false;
  }
}

function validFixture(filePath, kind) {
  if (!existingFile(filePath)) return false;
  const bytes = fs.readFileSync(filePath).subarray(0, 12);
  if (kind === 'image') return bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (kind === 'video') return bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp';
  return bytes.length >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WAVE';
}

async function atomicCreate(targetPath, extension, kind, writer) {
  if (validFixture(targetPath, kind)) return;
  if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { force: true });
  const tempPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp${extension}`,
  );
  try {
    await writer(tempPath);
    if (!validFixture(tempPath, kind)) throw new Error(`fixture was not created: ${path.basename(targetPath)}`);
    fs.chmodSync(tempPath, 0o600);
    try {
      fs.renameSync(tempPath, targetPath);
    } catch (error) {
      if (!validFixture(targetPath, kind)) throw error;
    }
    fs.chmodSync(targetPath, 0o600);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function ffmpegBlocked() {
  const error = new Error('ffmpeg unavailable for provider canary reference fixtures');
  error.code = 'PROVIDER_CANARY_BUDGET_BLOCKED';
  error.state = 'budget_blocked';
  error.reason = 'ffmpeg_unavailable';
  return error;
}

function runFfmpeg(options, args, outputPath) {
  const runner = options.spawnSync || spawnSync;
  const result = runner(options.ffmpegPath || getFfmpegPath(), args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result?.error || result?.status !== 0 || !existingFile(outputPath)) {
    throw new Error(`provider canary fixture ffmpeg failed: ${String(result?.error?.message || result?.stderr || 'unknown').trim()}`);
  }
}

async function ensureFixtureSet(options = {}) {
  const imageCount = count(options.imageCount, 'imageCount');
  const videoCount = count(options.videoCount, 'videoCount');
  const audioCount = count(options.audioCount, 'audioCount');
  const needsFfmpeg = videoCount > 0 || audioCount > 0;
  const ffmpegAvailable = options.ffmpegAvailable ?? hasLocalFfmpeg();
  if (needsFfmpeg && !ffmpegAvailable) throw ffmpegBlocked();

  const root = fixtureRoot(options.storageRoot);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const images = [];
  const videos = [];
  const audios = [];

  for (let index = 0; index < imageCount; index += 1) {
    const fileName = `image-${String(index + 1).padStart(2, '0')}.png`;
    const filePath = path.join(root, fileName);
    await atomicCreate(filePath, '.png', 'image', (tempPath) => sharp({
      create: {
        width: 96,
        height: 96,
        channels: 4,
        background: COLORS[index % COLORS.length],
      },
    }).composite([{
      input: Buffer.from(`<svg width="96" height="96"><rect x="20" y="20" width="56" height="56" rx="8" fill="#ffffff"/></svg>`),
    }]).png().toFile(tempPath));
    images.push(item(filePath));
  }

  for (let index = 0; index < videoCount; index += 1) {
    const fileName = `video-${String(index + 1).padStart(2, '0')}.mp4`;
    const filePath = path.join(root, fileName);
    await atomicCreate(filePath, '.mp4', 'video', async (tempPath) => runFfmpeg(options, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=${COLORS[index % COLORS.length]}:s=96x96:d=1`,
      '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      '-f', 'mp4', tempPath,
    ], tempPath));
    videos.push(item(filePath));
  }

  for (let index = 0; index < audioCount; index += 1) {
    const fileName = `audio-${String(index + 1).padStart(2, '0')}.wav`;
    const filePath = path.join(root, fileName);
    await atomicCreate(filePath, '.wav', 'audio', async (tempPath) => runFfmpeg(options, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `sine=frequency=${440 + (index * 110)}:duration=1`,
      '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', tempPath,
    ], tempPath));
    audios.push(item(filePath));
  }

  return { root, images, videos, audios };
}

function capabilityCount(capability, camel, snake) {
  return count(capability?.[camel] ?? capability?.[snake], camel);
}

function signedFixture(itemValue, options, ttlSeconds) {
  const value = signProviderAssetUrl(itemValue.relativePath, {
    filesBaseUrl: options.filesBaseUrl,
    secret: options.secret,
    now: options.now,
    ttlSeconds,
  });
  let signed;
  try { signed = new URL(value); } catch (_) { throw new Error('filesBaseUrl must produce an absolute signed URL'); }
  if (!['http:', 'https:'].includes(signed.protocol)
      || !signed.searchParams.get('provider_asset_expires')
      || !signed.searchParams.get('provider_asset_signature')) {
    throw new Error('fixture signed URL could not be created');
  }
  return signed.toString();
}

async function buildReferenceInputs(options = {}) {
  const capability = options.capability || {};
  const referenceImageCount = capabilityCount(capability, 'referenceImageCount', 'reference_image_count');
  const referenceVideoCount = capabilityCount(capability, 'referenceVideoCount', 'reference_video_count');
  const referenceAudioCount = capabilityCount(capability, 'referenceAudioCount', 'reference_audio_count');
  const firstFrame = capability.firstFrame ?? capability.first_frame ?? false;
  const lastFrame = capability.lastFrame ?? capability.last_frame ?? false;
  if (typeof firstFrame !== 'boolean' || typeof lastFrame !== 'boolean') {
    throw new TypeError('firstFrame and lastFrame must be booleans');
  }
  const fixtures = await ensureFixtureSet({
    ...options,
    imageCount: referenceImageCount + Number(firstFrame) + Number(lastFrame),
    videoCount: referenceVideoCount,
    audioCount: referenceAudioCount,
  });
  const requestedTtl = Number(options.ttlSeconds ?? MAX_SIGNED_TTL_SECONDS);
  const ttlSeconds = Number.isFinite(requestedTtl)
    ? Math.min(MAX_SIGNED_TTL_SECONDS, Math.max(60, Math.floor(requestedTtl)))
    : MAX_SIGNED_TTL_SECONDS;
  let imageIndex = 0;
  const imageUrls = fixtures.images.slice(0, referenceImageCount)
    .map((entry) => signedFixture(entry, options, ttlSeconds));
  imageIndex += referenceImageCount;
  const firstFrameUrl = firstFrame
    ? signedFixture(fixtures.images[imageIndex++], options, ttlSeconds)
    : null;
  const lastFrameUrl = lastFrame
    ? signedFixture(fixtures.images[imageIndex], options, ttlSeconds)
    : null;
  return {
    imageUrls,
    videoUrls: fixtures.videos.slice(0, referenceVideoCount)
      .map((entry) => signedFixture(entry, options, ttlSeconds)),
    audioUrls: fixtures.audios.slice(0, referenceAudioCount)
      .map((entry) => signedFixture(entry, options, ttlSeconds)),
    firstFrameUrl,
    lastFrameUrl,
  };
}

module.exports = {
  MAX_SIGNED_TTL_SECONDS,
  ensureFixtureSet,
  buildReferenceInputs,
};
