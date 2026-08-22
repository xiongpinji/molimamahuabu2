'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const config = require('../config');
const { getFfmpegPath, getFfprobePath } = require('../utils/ffmpegPath');
const { stableStringify } = require('./redrawAnalysisService');

const execFileAsync = promisify(execFile);

const CONTRACT = 'redraw-native-audio-validation-v1';
const DEFAULT_FFPROBE_TIMEOUT_MS = 15_000;
const DEFAULT_FFMPEG_TIMEOUT_MS = 30_000;
const DEFAULT_WORKER_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_PCM_BYTES = 16_000 * 2 * 16;
const DEFAULT_MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_DURATION_DELTA_MS = 750;
const DEFAULT_SILENCE_THRESHOLD_DB = -45;

async function validateNativeAudio(input = {}) {
  const storageRoot = resolveStorageRoot(input.storageRoot);
  const videoPath = resolveSafePath(storageRoot, input.videoPath);
  const privateTempRoot = resolvePrivateTempRoot(storageRoot, input.privateTempRoot);
  let tempDir = null;
  try {
    tempDir = fs.mkdtempSync(path.join(privateTempRoot, 'native-audio-'));
    const snapshotPath = createPrivateVideoSnapshot(videoPath, tempDir, input);
    const artifactSha256 = await sha256File(snapshotPath);
    const invocation = normalizeInvocation(input.videoInvocation, artifactSha256);
    const probe = await probeMedia(snapshotPath, input);
    const videoStream = probe.streams.find((stream) => stream.codec_type === 'video');
    const audioStream = probe.streams.find((stream) => stream.codec_type === 'audio');
    if (!videoStream) throw codedError('REDRAW_NATIVE_AUDIO_VIDEO_STREAM_MISSING', '视频缺少视频流');
    if (!audioStream) throw codedError('REDRAW_NATIVE_AUDIO_STREAM_MISSING', '视频缺少音频流');

    const videoDurationMs = durationMs(probe.format?.duration ?? videoStream.duration);
    const audioDurationMs = durationMs(audioStream.duration ?? probe.format?.duration);
    if (input.expectedDurationMs != null) {
      const delta = Math.abs(videoDurationMs - Number(input.expectedDurationMs));
      if (!Number.isFinite(delta) || delta > Number(input.maxDurationDeltaMs || DEFAULT_MAX_DURATION_DELTA_MS)) {
        throw codedError('REDRAW_NATIVE_AUDIO_DURATION_MISMATCH', '视频时长与请求窗口不一致');
      }
    }
    if (audioDurationMs > 0 && videoDurationMs > 0) {
      const delta = Math.abs(audioDurationMs - videoDurationMs);
      if (delta > Number(input.maxDurationDeltaMs || DEFAULT_MAX_DURATION_DELTA_MS)) {
        throw codedError('REDRAW_NATIVE_AUDIO_DURATION_MISMATCH', '音视频时长差超限');
      }
    }

    const wavPath = path.join(tempDir, 'audio.wav');
    await extractPcmWav(snapshotPath, wavPath, input);
    const audioSha256 = await sha256File(wavPath);
    const silence = await analyzeWavRms(wavPath, input);
    if (silence.rms_db <= silence.threshold_db) {
      throw codedError('REDRAW_NATIVE_AUDIO_SILENT', '原生对白音轨近似静音');
    }
    const workerEvidence = await verifyWithWorker({
      input,
      wavPath,
      audioSha256,
      invocation,
    });
    const verification = compactVerification(workerEvidence);
    assertWorkerEvidence(workerEvidence, {
      audioSha256,
      invocation,
      expectedLanguage: input.expectedLanguage,
      packId: input.localePack?.id || input.packId,
      thresholds: input.localePack?.thresholds || {},
    });
    const currentArtifactSha256 = await sha256File(videoPath);
    if (currentArtifactSha256 !== artifactSha256) {
      throw codedError('REDRAW_NATIVE_AUDIO_ARTIFACT_CHANGED', '原生对白视频文件验证期间发生变化');
    }
    const compact = {
      contract: CONTRACT,
      artifact_sha256: artifactSha256,
      audio_stream: compactAudioStream(audioStream, audioDurationMs),
      video_duration_ms: videoDurationMs,
      silence,
      verification,
    };
    return {
      ...compact,
      validation_hash: sha256(stableStringify(compact)),
    };
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function createPrivateVideoSnapshot(videoPath, tempDir, input) {
  const maxArtifactBytes = Number(input.maxArtifactBytes || DEFAULT_MAX_ARTIFACT_BYTES);
  if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes <= 0) {
    throw codedError('REDRAW_NATIVE_AUDIO_ARTIFACT_TOO_LARGE', '视频文件大小超限');
  }
  let stat;
  try {
    stat = fs.statSync(videoPath);
  } catch (error) {
    const wrapped = codedError('REDRAW_NATIVE_AUDIO_ARTIFACT_COPY_FAILED', '原生对白视频快照复制失败');
    wrapped.cause = error;
    throw wrapped;
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > maxArtifactBytes) {
    throw codedError('REDRAW_NATIVE_AUDIO_ARTIFACT_TOO_LARGE', '视频文件大小超限');
  }
  const snapshotPath = path.join(tempDir, `artifact${path.extname(videoPath) || '.mp4'}`);
  try {
    fs.copyFileSync(videoPath, snapshotPath, fs.constants.COPYFILE_EXCL);
    const copied = fs.statSync(snapshotPath);
    if (!copied.isFile() || copied.size !== stat.size || copied.size > maxArtifactBytes) {
      throw codedError('REDRAW_NATIVE_AUDIO_ARTIFACT_COPY_FAILED', '原生对白视频快照复制失败');
    }
    return snapshotPath;
  } catch (error) {
    if (error.code === 'REDRAW_NATIVE_AUDIO_ARTIFACT_COPY_FAILED') throw error;
    const wrapped = codedError('REDRAW_NATIVE_AUDIO_ARTIFACT_COPY_FAILED', '原生对白视频快照复制失败');
    wrapped.cause = error;
    throw wrapped;
  }
}

function resolveStorageRoot(value) {
  if (value && typeof value === 'string') return path.resolve(value);
  const cfg = config.loadConfig();
  const storagePath = cfg.storage?.local_path || './data/storage';
  return path.isAbsolute(storagePath) ? storagePath : path.join(process.cwd(), storagePath);
}

function resolvePrivateTempRoot(storageRoot, value) {
  const rawRoot = value && typeof value === 'string'
    ? value
    : path.join(os.tmpdir(), 'moli-redraw-native-audio');
  const tempRoot = path.resolve(rawRoot);
  try {
    fs.mkdirSync(tempRoot, { recursive: true });
    const realStorageRoot = fs.realpathSync.native(storageRoot);
    const realTempRoot = fs.realpathSync.native(tempRoot);
    if (isInside(realStorageRoot, realTempRoot)) {
      throw codedError('REDRAW_NATIVE_AUDIO_PRIVATE_TEMP_INVALID', '原生对白临时目录不能位于公开存储目录内');
    }
    return realTempRoot;
  } catch (error) {
    if (error.code === 'REDRAW_NATIVE_AUDIO_PRIVATE_TEMP_INVALID') throw error;
    const wrapped = codedError('REDRAW_NATIVE_AUDIO_PRIVATE_TEMP_INVALID', '原生对白临时目录不可用');
    wrapped.cause = error;
    throw wrapped;
  }
}

function resolveSafePath(storageRoot, rawPath) {
  const absPath = path.resolve(storageRoot, String(rawPath || ''));
  if (!isInside(storageRoot, absPath)) {
    throw codedError('REDRAW_NATIVE_AUDIO_PATH_INVALID', '视频路径越界');
  }
  try {
    const realRoot = fs.realpathSync.native(storageRoot);
    const realPath = fs.realpathSync.native(absPath);
    if (!isInside(realRoot, realPath)) {
      throw codedError('REDRAW_NATIVE_AUDIO_PATH_INVALID', '视频路径越界');
    }
    fs.accessSync(realPath, fs.constants.R_OK);
    return realPath;
  } catch (error) {
    if (error.code === 'REDRAW_NATIVE_AUDIO_PATH_INVALID') throw error;
    throw codedError('REDRAW_NATIVE_AUDIO_PATH_INVALID', '视频文件不可读取');
  }
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

async function probeMedia(videoPath, input) {
  try {
    const { stdout } = await execFileAsync(getFfprobePath(), [
      '-v', 'error',
      '-show_streams',
      '-show_format',
      '-of', 'json',
      videoPath,
    ], {
      timeout: Number(input.ffprobeTimeoutMs || DEFAULT_FFPROBE_TIMEOUT_MS),
      maxBuffer: 1024 * 1024,
      killSignal: 'SIGKILL',
      windowsHide: true,
    });
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed.streams)) throw new Error('streams missing');
    return parsed;
  } catch (error) {
    const wrapped = codedError('REDRAW_NATIVE_AUDIO_FFPROBE_FAILED', 'ffprobe 解析原生对白视频失败');
    wrapped.cause = error;
    throw wrapped;
  }
}

async function extractPcmWav(videoPath, wavPath, input) {
  try {
    await execFileAsync(getFfmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', videoPath,
      '-map', '0:a:0',
      '-t', '15',
      '-ac', '1',
      '-ar', '16000',
      '-acodec', 'pcm_s16le',
      '-f', 'wav',
      wavPath,
    ], {
      timeout: Number(input.ffmpegTimeoutMs || DEFAULT_FFMPEG_TIMEOUT_MS),
      maxBuffer: 512 * 1024,
      killSignal: 'SIGKILL',
      windowsHide: true,
    });
  } catch (error) {
    const wrapped = codedError('REDRAW_NATIVE_AUDIO_FFMPEG_FAILED', 'ffmpeg 抽取原生对白音轨失败');
    wrapped.cause = error;
    throw wrapped;
  }
}

async function analyzeWavRms(wavPath, input) {
  const maxPcmBytes = Number(input.maxPcmBytes || DEFAULT_MAX_PCM_BYTES);
  const thresholdDb = Number(input.silenceThresholdDb || DEFAULT_SILENCE_THRESHOLD_DB);
  if (!Number.isSafeInteger(maxPcmBytes) || maxPcmBytes <= 0) {
    throw codedError('REDRAW_NATIVE_AUDIO_PCM_LIMIT_EXCEEDED', 'PCM/WAV 字节数超限');
  }
  const maxWavBytes = maxPcmBytes + 4096;
  const stat = fs.statSync(wavPath);
  if (stat.size > maxWavBytes) {
    throw codedError('REDRAW_NATIVE_AUDIO_PCM_LIMIT_EXCEEDED', 'PCM/WAV 字节数超限');
  }
  let squares = 0;
  let samples = 0;
  let pcmBytes = 0;
  let totalBytes = 0;
  let header = Buffer.alloc(0);
  let dataOffset = null;
  let carry = null;
  const stream = fs.createReadStream(wavPath, { highWaterMark: 64 * 1024 });
  for await (const chunk of stream) {
    totalBytes += chunk.length;
    if (totalBytes > maxWavBytes) {
      throw codedError('REDRAW_NATIVE_AUDIO_PCM_LIMIT_EXCEEDED', 'PCM/WAV 字节数超限');
    }
    let pcm = chunk;
    if (dataOffset == null) {
      header = Buffer.concat([header, chunk]);
      dataOffset = findWavDataOffset(header, true);
      if (dataOffset == null) {
        if (header.length > 4096) throw codedError('REDRAW_NATIVE_AUDIO_PCM_INVALID', 'WAV data chunk 缺失');
        continue;
      }
      pcm = header.subarray(dataOffset);
      header = null;
    }
    if (carry != null) {
      pcm = Buffer.concat([Buffer.from([carry]), pcm]);
      carry = null;
    }
    if (pcm.length % 2 === 1) {
      carry = pcm[pcm.length - 1];
      pcm = pcm.subarray(0, pcm.length - 1);
    }
    pcmBytes += pcm.length;
    if (pcmBytes > maxPcmBytes) {
      throw codedError('REDRAW_NATIVE_AUDIO_PCM_LIMIT_EXCEEDED', 'PCM/WAV 字节数超限');
    }
    for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
      const sample = pcm.readInt16LE(offset) / 32768;
      squares += sample * sample;
      samples += 1;
    }
  }
  if (dataOffset == null) throw codedError('REDRAW_NATIVE_AUDIO_PCM_INVALID', 'WAV data chunk 缺失');
  if (samples === 0) throw codedError('REDRAW_NATIVE_AUDIO_PCM_INVALID', 'PCM 音频为空');
  const rms = Math.sqrt(squares / samples);
  const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  return {
    rms_db: Number(rmsDb.toFixed(1)),
    threshold_db: thresholdDb,
  };
}

function findWavDataOffset(buffer, allowIncomplete = false) {
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'data') return offset + 8;
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (allowIncomplete) return null;
  throw codedError('REDRAW_NATIVE_AUDIO_PCM_INVALID', 'WAV data chunk 缺失');
}

async function verifyWithWorker({ input, wavPath, audioSha256, invocation }) {
  const verifier = input.localeVerifier;
  if (!verifier || typeof verifier.verifyNativeAudio !== 'function') {
    throw codedError('REDRAW_NATIVE_AUDIO_WORKER_UNAVAILABLE', '原生对白 Worker 未配置');
  }
  const timeoutMs = Number(input.workerTimeoutMs || DEFAULT_WORKER_TIMEOUT_MS);
  const controller = new AbortController();
  return withTimeout((signal) => verifier.verifyNativeAudio({
    audioPath: wavPath,
    audioSha256,
    approvedText: String(input.approvedText || ''),
    expectedLanguage: String(input.expectedLanguage || ''),
    packId: String(input.localePack?.id || input.packId || ''),
    videoInvocation: invocation,
    signal,
  }), timeoutMs, controller);
}

function withTimeout(start, timeoutMs, controller) {
  let timer = null;
  let settled = false;
  return new Promise((resolve, reject) => {
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    timer = setTimeout(() => {
      const error = codedError('REDRAW_NATIVE_AUDIO_WORKER_TIMEOUT', '原生对白 Worker 超时');
      settle(() => reject(error));
      controller.abort();
    }, timeoutMs);
    Promise.resolve()
      .then(() => start(controller.signal))
      .then(
        (value) => settle(() => resolve(value)),
        (error) => settle(() => reject(error)),
      );
  });
}

function assertWorkerEvidence(evidence, expected) {
  const invocation = evidence?.videoInvocation || {};
  const expectedTaskHash = sha256(expected.invocation.providerTaskId);
  const similarityMin = Number(expected.thresholds.dialogue_similarity_min ?? 0);
  const charsPerSecondMax = Number(expected.thresholds.speech_chars_per_second_max ?? Infinity);
  if (!evidence || evidence.audioSha256 !== expected.audioSha256
    || evidence.localePack !== expected.packId
    || evidence.detectedLanguage !== expected.expectedLanguage
    || evidence.detectedLocale !== null
    || evidence.languageVerified !== true
    || evidence.localeVerified !== false
    || !isSha256(evidence.transcriptSha256)
    || !isProbability(evidence.dialogueSimilarity)
    || evidence.dialogueSimilarity < similarityMin
    || !Number.isFinite(Number(evidence.speechCharsPerSecond))
    || Number(evidence.speechCharsPerSecond) > charsPerSecondMax
    || invocation.provider !== expected.invocation.provider
    || invocation.model !== expected.invocation.model
    || Number(invocation.aiServiceConfigId) !== Number(expected.invocation.aiServiceConfigId)
    || invocation.configUpdatedAt !== expected.invocation.configUpdatedAt
    || invocation.artifactSha256 !== expected.invocation.artifactSha256
    || invocation.providerTaskIdSha256 !== expectedTaskHash) {
    throw codedError('REDRAW_NATIVE_AUDIO_WORKER_EVIDENCE_INVALID', '原生对白 Worker 证据与视频调用不一致');
  }
}

function compactVerification(evidence) {
  return {
    detected_language: evidence.detectedLanguage,
    detected_locale: null,
    language_verified: true,
    locale_verified: false,
    transcript_sha256: evidence.transcriptSha256,
    dialogue_similarity: evidence.dialogueSimilarity,
    speech_chars_per_second: evidence.speechCharsPerSecond,
  };
}

function compactAudioStream(stream, duration) {
  return {
    codec_type: 'audio',
    codec: String(stream.codec_name || ''),
    channels: Number(stream.channels || 0),
    sample_rate: Number(stream.sample_rate || 0),
    duration_ms: duration,
  };
}

function normalizeInvocation(value, artifactSha256) {
  const invocation = {
    provider: String(value?.provider || ''),
    model: String(value?.model || ''),
    aiServiceConfigId: Number(value?.aiServiceConfigId),
    configUpdatedAt: String(value?.configUpdatedAt || ''),
    providerTaskId: String(value?.providerTaskId || ''),
    artifactSha256: isSha256(value?.artifactSha256) ? String(value.artifactSha256) : artifactSha256,
  };
  if (!invocation.provider || !invocation.model || !Number.isSafeInteger(invocation.aiServiceConfigId)
    || !invocation.configUpdatedAt || !invocation.providerTaskId || invocation.artifactSha256 !== artifactSha256) {
    throw codedError('REDRAW_NATIVE_AUDIO_INVOCATION_INVALID', '视频调用证据不完整或 artifact hash 漂移');
  }
  return invocation;
}

function durationMs(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.round(seconds * 1000);
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function isSha256(value) {
  return /^[0-9a-f]{64}$/.test(String(value || ''));
}

function isProbability(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  CONTRACT,
  validateNativeAudio,
};
