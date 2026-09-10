'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

const { getFfprobePath } = require('../utils/ffmpegPath');

const PROBE_TIMEOUT_MS = 30_000;

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function isExecTimeout(error) {
  return error?.code === 'ETIMEDOUT' || error?.killed === true || /timed out/i.test(String(error?.message || ''));
}

function execFileWithTimeout(execFileImpl, bin, args, options, timeoutCode) {
  return new Promise((resolve, reject) => {
    execFileImpl(bin, args, options, (error, stdout, stderr) => {
      if (error) {
        if (isExecTimeout(error)) {
          reject(codedError(timeoutCode, timeoutCode === 'REDRAW_COMPOSITION_TIMEOUT'
            ? 'ffmpeg composition timed out'
            : 'ffprobe timed out'));
          return;
        }
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function defaultCompositionRunner(job) {
  await execFileWithTimeout(job.execFile || execFile, job.bin, job.args, {
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    timeout: job.timeoutMs,
    killSignal: 'SIGKILL',
  }, 'REDRAW_COMPOSITION_TIMEOUT');
}

async function defaultProbeRunner(filePath, options = {}) {
  const { stdout } = await execFileWithTimeout(options.execFile || execFile, getFfprobePath(), [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,width,height,start_time,sample_aspect_ratio,display_aspect_ratio:stream_tags=rotate:stream_side_data',
    '-of', 'json',
    filePath,
  ], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    timeout: PROBE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  }, 'REDRAW_COMPOSITION_PROBE_TIMEOUT');
  const parsed = JSON.parse(stdout);
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  return {
    duration: Number(parsed.format?.duration),
    width: Number(video?.width),
    height: Number(video?.height),
    videoStartTime: video?.start_time == null ? NaN : Number(video.start_time),
    audioStartTime: audio?.start_time == null ? NaN : Number(audio.start_time),
    sampleAspectRatio: video?.sample_aspect_ratio,
    displayAspectRatio: video?.display_aspect_ratio,
    rotationClaims: [
      ...(Object.prototype.hasOwnProperty.call(video?.tags || {}, 'rotate') ? [video.tags.rotate] : []),
      ...(Array.isArray(video?.side_data_list)
        ? video.side_data_list.filter((item) => Object.prototype.hasOwnProperty.call(item || {}, 'rotation'))
          .map((item) => item.rotation)
        : []),
    ],
    displayMatrixFacts: Array.isArray(video?.side_data_list)
      ? video.side_data_list.filter((item) => item?.side_data_type === 'Display Matrix')
        .map((item) => ({ matrix: item.displaymatrix, rotation: item.rotation }))
      : [],
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
  };
}

function gcdBigInt(left, right) {
  let a = left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function parsePositiveRational(value) {
  const match = /^(\d+)\s*[:/]\s*(\d+)$/.exec(String(value || '').trim());
  if (!match) return null;
  const rawNumerator = BigInt(match[1]);
  const rawDenominator = BigInt(match[2]);
  if (rawNumerator <= 0n || rawDenominator <= 0n) return null;
  const divisor = gcdBigInt(rawNumerator, rawDenominator);
  return { numerator: rawNumerator / divisor, denominator: rawDenominator / divisor };
}

function rationalEquals(left, right) {
  return left.numerator * right.denominator === right.numerator * left.denominator;
}

function isIdentityDisplayMatrix(value) {
  const rows = String(value || '').split(/\r?\n/).filter((line) => line.trim());
  if (rows.length !== 3) return false;
  const values = [];
  for (const row of rows) {
    const match = /^\s*\d+:\s+([+-]?\d+)\s+([+-]?\d+)\s+([+-]?\d+)\s*$/.exec(row);
    if (!match) return false;
    values.push(...match.slice(1).map((item) => BigInt(item)));
  }
  const identity = [65536n, 0n, 0n, 0n, 65536n, 0n, 0n, 0n, 1073741824n];
  return values.every((item, index) => item === identity[index]);
}

function validateGeometryProbe(probe, dimensions, code) {
  const width = Number(probe?.width);
  const height = Number(probe?.height);
  const sar = parsePositiveRational(probe?.sampleAspectRatio);
  const dar = parsePositiveRational(probe?.displayAspectRatio);
  const claims = Array.isArray(probe?.rotationClaims)
    ? probe.rotationClaims
    : (Object.prototype.hasOwnProperty.call(probe || {}, 'rotation') ? [probe.rotation] : []);
  const matrices = Array.isArray(probe?.displayMatrixFacts) ? probe.displayMatrixFacts : [];
  const rotations = claims.map((claim) => {
    const text = String(claim).trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
  });
  if (!probe?.hasVideo || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width <= 0 || height <= 0 || width !== Number(dimensions.width) || height !== Number(dimensions.height)
    || !sar || !dar || rotations.includes(null) || rotations.some((rotation) => rotation % 360 !== 0)
    || matrices.some((fact) => !isIdentityDisplayMatrix(fact?.matrix))) {
    throw codedError(code, 'composition display geometry invalid');
  }
  const calculatedDar = { numerator: BigInt(width) * sar.numerator, denominator: BigInt(height) * sar.denominator };
  if (sar.numerator > 65535n || sar.denominator > 65535n || !rationalEquals(calculatedDar, dar)) {
    throw codedError(code, 'composition display geometry contradictory');
  }
  return { width, height, sar, dar };
}

module.exports = { defaultCompositionRunner, defaultProbeRunner, validateGeometryProbe, rationalEquals, sha256File };
