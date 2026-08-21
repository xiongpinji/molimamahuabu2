#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { getFfmpegPath, getFfprobePath } = require('../src/utils/ffmpegPath');

const execFileAsync = promisify(execFile);
const MANIFEST_FILENAME = 'redraw-full-episode-reference-local-manifest.json';
const EXPECTED_SHOT_IDS = Object.freeze(Array.from({ length: 9 }, (_, index) => `shot-${index + 1}`));
const HEX_64 = /^[a-f0-9]{64}$/;
const CHINESE = /[\u3400-\u9fff\uf900-\ufaff]/u;
const SILENCE_TOKENS = new Set([
  'silence',
  '[silence]',
  '(silence)',
  'silent',
  'no dialogue',
  '[no dialogue]',
]);
const CLI_CODE = 'REDRAW_FULL_EPISODE_CLI_INVALID';
const CASE_CODE = 'REDRAW_FULL_EPISODE_CASE_INVALID';
const SOURCE_CODE = 'REDRAW_FULL_EPISODE_SOURCE_MISMATCH';
const OUTPUT_CODE = 'REDRAW_FULL_EPISODE_OUTPUT_INVALID';
const MEDIA_CODE = 'REDRAW_FULL_EPISODE_MEDIA_FAILED';
const FORBIDDEN_KEYS = /^(?:path|url|key|api[_-]?key|authorization|auth|token|secret|provider|request)$/i;

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function fail(code, message) {
  throw codedError(code, message);
}

function readFlagValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value == null || String(value).startsWith('--')) fail(CLI_CODE, `${flag} missing value`);
  return String(value);
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = { source: null, caseManifest: null, outputDir: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--source') {
      options.source = path.resolve(readFlagValue(argv, index, arg));
      index += 1;
    } else if (arg === '--case-manifest') {
      options.caseManifest = path.resolve(readFlagValue(argv, index, arg));
      index += 1;
    } else if (arg === '--output-dir') {
      options.outputDir = path.resolve(readFlagValue(argv, index, arg));
      index += 1;
    } else {
      fail(CLI_CODE, `unknown argument: ${arg}`);
    }
  }
  if (!options.help && (!options.source || !options.caseManifest || !options.outputDir)) {
    fail(CLI_CODE, '--source, --case-manifest and --output-dir are required');
  }
  return options;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(CASE_CODE, `${label} must be an object`);
}

function assertExactKeys(value, allowed, label) {
  assertPlainObject(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(CASE_CODE, `${label} contains unsupported field`);
  }
}

function assertSafeInputTree(value) {
  if (Array.isArray(value)) {
    value.forEach(assertSafeInputTree);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.test(key) || /(?:_path|_url)$/i.test(key)) fail(CASE_CODE, 'case manifest contains forbidden field');
      assertSafeInputTree(child);
    }
    return;
  }
  if (typeof value !== 'string') return;
  if (/^https?:\/\//i.test(value)
    || /^(?:[a-z]:[\\/]|[\\/]{1,2})/i.test(value)
    || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value)) {
    fail(CASE_CODE, 'case manifest contains unsafe reference');
  }
}

function normalizeHash(value, allowNull = false) {
  if (allowNull && value == null) return null;
  const normalized = String(value || '').toLowerCase();
  if (!HEX_64.test(normalized)) fail(CASE_CODE, 'invalid sha256');
  return normalized;
}

function normalizeStatus(value) {
  const status = String(value || '');
  if (!['approved', 'pending', 'rejected'].includes(status)) fail(CASE_CODE, 'invalid review status');
  return status;
}

function normalizeReview(value, label) {
  assertExactKeys(value, new Set(['status', 'unresolved_reason']), label);
  const status = normalizeStatus(value.status);
  const unresolvedReason = value.unresolved_reason == null ? '' : String(value.unresolved_reason).trim();
  if (status !== 'approved' && !unresolvedReason) fail(CASE_CODE, `${label} requires unresolved_reason`);
  return { status, unresolved_reason: unresolvedReason };
}

function normalizeRanges(value, shot, label) {
  if (!Array.isArray(value) || value.length === 0) fail(CASE_CODE, `${label} requires time_ranges`);
  return value.map((range) => {
    if (!Array.isArray(range) || range.length !== 2) fail(CASE_CODE, `${label} has invalid time range`);
    const start = Number(range[0]);
    const end = Number(range[1]);
    if (!Number.isInteger(start) || !Number.isInteger(end)
      || start < shot.start_ms || start >= end || end > shot.end_ms) {
      fail(CASE_CODE, `${label} time range is outside shot`);
    }
    return [start, end];
  });
}

function normalizeShot(value, index) {
  const label = `shots[${index}]`;
  assertExactKeys(value, new Set([
    'id', 'start_ms', 'end_ms', 'face_tracks', 'face_track_review', 'identity_packs',
    'text_regions', 'text_region_review', 'motion_reference', 'dialogue',
  ]), label);
  const id = String(value.id || '');
  const startMs = Number(value.start_ms);
  const endMs = Number(value.end_ms);
  if (id !== EXPECTED_SHOT_IDS[index]
    || !Number.isInteger(startMs) || !Number.isInteger(endMs)
    || startMs < 0 || startMs >= endMs || endMs > 68733) {
    fail(CASE_CODE, 'shots must use the fixed shot-1..shot-9 order and legal millisecond ranges');
  }
  const shot = { id, start_ms: startMs, end_ms: endMs };

  if (!Array.isArray(value.face_tracks)) fail(CASE_CODE, `${label}.face_tracks must be an array`);
  const faceTracks = value.face_tracks.map((entry, trackIndex) => {
    assertExactKeys(entry, new Set(['character_id', 'time_ranges']), `${label}.face_tracks[${trackIndex}]`);
    const characterId = String(entry.character_id || '').trim();
    if (!characterId) fail(CASE_CODE, 'face track requires character_id');
    return {
      character_id: characterId,
      time_ranges: normalizeRanges(entry.time_ranges, shot, `${label}.face_tracks[${trackIndex}]`),
    };
  });
  const faceReview = normalizeReview(value.face_track_review, `${label}.face_track_review`);

  if (!Array.isArray(value.identity_packs)) fail(CASE_CODE, `${label}.identity_packs must be an array`);
  const identityPacks = value.identity_packs.map((entry, packIndex) => {
    assertExactKeys(entry, new Set(['character_id', 'status', 'sha256']), `${label}.identity_packs[${packIndex}]`);
    const characterId = String(entry.character_id || '').trim();
    if (!characterId) fail(CASE_CODE, 'identity pack requires character_id');
    return {
      character_id: characterId,
      status: normalizeStatus(entry.status),
      sha256: normalizeHash(entry.sha256, true),
    };
  });

  if (!Array.isArray(value.text_regions)) fail(CASE_CODE, `${label}.text_regions must be an array`);
  const textRegions = value.text_regions.map((entry, regionIndex) => {
    assertExactKeys(entry, new Set([
      'region_key', 'kind', 'time_ranges', 'clean_plate_status', 'clean_plate_sha256',
    ]), `${label}.text_regions[${regionIndex}]`);
    const regionKey = String(entry.region_key || '').trim();
    const kind = String(entry.kind || '');
    if (!regionKey || !['text_subtitle', 'text_screen'].includes(kind)) fail(CASE_CODE, 'invalid text region');
    return {
      region_key: regionKey,
      kind,
      time_ranges: normalizeRanges(entry.time_ranges, shot, `${label}.text_regions[${regionIndex}]`),
      clean_plate_status: normalizeStatus(entry.clean_plate_status),
      clean_plate_sha256: normalizeHash(entry.clean_plate_sha256, true),
    };
  });
  const textReview = normalizeReview(value.text_region_review, `${label}.text_region_review`);

  assertExactKeys(value.motion_reference, new Set(['review_status', 'evidence_sha256']), `${label}.motion_reference`);
  const motionReference = {
    review_status: normalizeStatus(value.motion_reference.review_status),
    evidence_sha256: normalizeHash(value.motion_reference.evidence_sha256, true),
  };

  assertExactKeys(value.dialogue, new Set(['kind', 'speech_required', 'target_locale', 'turns']), `${label}.dialogue`);
  const dialogueKind = String(value.dialogue.kind || '');
  const speechRequired = value.dialogue.speech_required;
  if (!['spoken', 'silent'].includes(dialogueKind) || value.dialogue.target_locale !== 'en-US'
    || typeof speechRequired !== 'boolean' || !Array.isArray(value.dialogue.turns)) {
    fail(CASE_CODE, 'invalid dialogue contract');
  }
  const turns = value.dialogue.turns.map((entry, turnIndex) => {
    assertExactKeys(entry, new Set(['speaker_id', 'text', 'start_ms', 'end_ms']), `${label}.dialogue.turns[${turnIndex}]`);
    const speakerId = String(entry.speaker_id || '').trim();
    const text = String(entry.text || '').trim();
    const start = Number(entry.start_ms);
    const end = Number(entry.end_ms);
    if (!speakerId || !text || !Number.isInteger(start) || !Number.isInteger(end)
      || start < startMs || start >= end || end > endMs) fail(CASE_CODE, 'invalid dialogue turn');
    return { speaker_id: speakerId, text, start_ms: start, end_ms: end };
  });
  const blockers = [];
  if (faceReview.status !== 'approved') blockers.push('face_track_review_not_approved');
  const identities = new Map(identityPacks.map((entry) => [entry.character_id, entry]));
  if (faceTracks.some((entry) => {
    const pack = identities.get(entry.character_id);
    return !pack || pack.status !== 'approved' || !pack.sha256;
  })) blockers.push('identity_pack_not_approved');
  if (textReview.status !== 'approved') blockers.push('text_region_review_not_approved');
  if (textRegions.some((entry) => entry.clean_plate_status !== 'approved' || !entry.clean_plate_sha256)) {
    blockers.push('text_clean_plate_not_approved');
  }
  if (motionReference.review_status !== 'approved' || !motionReference.evidence_sha256) {
    blockers.push('motion_reference_not_approved');
  }
  if (speechRequired !== (dialogueKind === 'spoken')) blockers.push('dialogue_speech_contract_mismatch');
  if (dialogueKind === 'silent' && turns.length !== 0) blockers.push('silent_dialogue_has_turns');
  if (dialogueKind === 'spoken' && turns.length === 0) blockers.push('spoken_dialogue_missing');
  if (turns.some((entry) => SILENCE_TOKENS.has(entry.text.toLowerCase().replace(/\s+/g, ' ')))) {
    blockers.push('dialogue_silence_token_forbidden');
  }
  if (turns.some((entry) => CHINESE.test(entry.text))) blockers.push('dialogue_contains_chinese');

  return {
    ...shot,
    face_tracks: faceTracks,
    face_track_review: faceReview,
    identity_packs: identityPacks,
    text_regions: textRegions,
    text_region_review: textReview,
    motion_reference: motionReference,
    dialogue: {
      kind: dialogueKind,
      speech_required: speechRequired,
      target_locale: 'en-US',
      turns,
    },
    reference_bundle_ready: blockers.length === 0,
    blockers,
  };
}

function validateCaseManifest(value) {
  assertSafeInputTree(value);
  assertExactKeys(value, new Set(['case_id', 'reference_bundle_required', 'target', 'source', 'shots']), 'case manifest');
  const caseId = String(value.case_id || '').trim();
  if (!caseId || value.reference_bundle_required !== true) fail(CASE_CODE, 'reference_bundle_required must be true');

  assertExactKeys(value.target, new Set(['language', 'locale', 'market']), 'target');
  if (value.target.language !== 'en' || value.target.locale !== 'en-US' || value.target.market !== 'US') {
    fail(CASE_CODE, 'target must be en/en-US/US');
  }

  assertExactKeys(value.source, new Set([
    'sha256', 'duration_ms', 'duration_tolerance_ms', 'video', 'audio',
  ]), 'source');
  assertExactKeys(value.source.video, new Set(['width', 'height', 'codec', 'frame_rate']), 'source.video');
  assertExactKeys(value.source.audio, new Set(['codec', 'channels', 'sample_rate']), 'source.audio');
  const durationMs = Number(value.source.duration_ms);
  const toleranceMs = Number(value.source.duration_tolerance_ms);
  const video = {
    width: Number(value.source.video.width),
    height: Number(value.source.video.height),
    codec: String(value.source.video.codec || '').toLowerCase(),
    frame_rate: Number(value.source.video.frame_rate),
  };
  const audio = {
    codec: String(value.source.audio.codec || '').toLowerCase(),
    channels: Number(value.source.audio.channels),
    sample_rate: Number(value.source.audio.sample_rate),
  };
  if (durationMs !== 68733 || !Number.isInteger(toleranceMs) || toleranceMs < 0 || toleranceMs > 500
    || !Number.isInteger(video.width) || video.width <= 0
    || !Number.isInteger(video.height) || video.height <= 0
    || !video.codec || !Number.isFinite(video.frame_rate) || video.frame_rate <= 0
    || !audio.codec || !Number.isInteger(audio.channels) || audio.channels <= 0
    || !Number.isInteger(audio.sample_rate) || audio.sample_rate <= 0) {
    fail(CASE_CODE, 'invalid source media contract');
  }
  if (!Array.isArray(value.shots) || value.shots.length !== 9) fail(CASE_CODE, 'exactly nine shots are required');
  const shots = value.shots.map(normalizeShot);
  if (new Set(shots.map((entry) => entry.id)).size !== 9) fail(CASE_CODE, 'shot ids must be unique');
  if (shots[0].start_ms !== 0 || shots[8].end_ms !== 68733
    || shots.some((shot, index) => index > 0 && shot.start_ms !== shots[index - 1].end_ms)) {
    fail(CASE_CODE, 'shots must cover 0..68733 without gaps or overlaps');
  }

  return {
    case_id: caseId,
    reference_bundle_required: true,
    target: { language: 'en', locale: 'en-US', market: 'US' },
    source: {
      sha256: normalizeHash(value.source.sha256),
      duration_ms: durationMs,
      duration_tolerance_ms: toleranceMs,
      video,
      audio,
    },
    shots,
  };
}

function parseRate(value) {
  const text = String(value || '');
  if (text.includes('/')) {
    const [left, right] = text.split('/').map(Number);
    return right ? left / right : NaN;
  }
  return Number(text);
}

function safeMediaEnv() {
  return {
    PATH: process.env.PATH || '',
    SystemRoot: process.env.SystemRoot || '',
    WINDIR: process.env.WINDIR || '',
    TEMP: process.env.TEMP || '',
    TMP: process.env.TMP || '',
  };
}

async function runMedia(executable, args, code = MEDIA_CODE) {
  try {
    return await execFileAsync(executable, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
      env: safeMediaEnv(),
    });
  } catch (_) {
    fail(code, 'local media command failed');
  }
}

async function probeMedia(filePath, options = {}) {
  const result = await runMedia(options.ffprobePath || getFfprobePath(), [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath,
  ], options.errorCode || MEDIA_CODE);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (_) {
    fail(options.errorCode || MEDIA_CODE, 'ffprobe returned invalid JSON');
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videoStream = streams.find((entry) => entry.codec_type === 'video');
  const audioStream = streams.find((entry) => entry.codec_type === 'audio');
  const durationSeconds = Number(parsed.format?.duration || videoStream?.duration);
  if (!videoStream || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    fail(options.errorCode || MEDIA_CODE, 'ffprobe media contract is incomplete');
  }
  const frameRate = parseRate(videoStream.avg_frame_rate || videoStream.r_frame_rate);
  return {
    duration_ms: Math.round(durationSeconds * 1000),
    video: {
      width: Number(videoStream.width),
      height: Number(videoStream.height),
      codec: String(videoStream.codec_name || '').toLowerCase(),
      frame_rate: frameRate,
    },
    audio: audioStream ? {
      codec: String(audioStream.codec_name || '').toLowerCase(),
      channels: Number(audioStream.channels),
      sample_rate: Number(audioStream.sample_rate),
    } : null,
    has_audio: Boolean(audioStream),
  };
}

async function probeImage(filePath) {
  const result = await runMedia(getFfprobePath(), [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,codec_name:format=format_name',
    '-of', 'json', filePath,
  ]);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (_) {
    fail(MEDIA_CODE, 'representative frame probe returned invalid JSON');
  }
  const stream = Array.isArray(parsed.streams) ? parsed.streams[0] : null;
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  const codec = String(stream?.codec_name || '').toLowerCase();
  const format = String(parsed.format?.format_name || '').toLowerCase();
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0
    || !codec || !format) {
    fail(MEDIA_CODE, 'representative frame is not readable');
  }
  return { width, height, codec, format };
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

function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function assertSourceContract(expected, hash, probe) {
  const video = probe.video;
  const audio = probe.audio;
  if (hash !== expected.sha256
    || Math.abs(probe.duration_ms - expected.duration_ms) > expected.duration_tolerance_ms
    || video.width !== expected.video.width
    || video.height !== expected.video.height
    || video.codec !== expected.video.codec
    || Math.abs(video.frame_rate - expected.video.frame_rate) > 0.01
    || !audio
    || audio.codec !== expected.audio.codec
    || audio.channels !== expected.audio.channels
    || audio.sample_rate !== expected.audio.sample_rate) {
    fail(SOURCE_CODE, 'source file does not match the approved media contract');
  }
}

async function inspectOutputTarget(outputDir) {
  const parentDir = path.dirname(outputDir);
  const baseName = path.basename(outputDir);
  if (!baseName || outputDir === parentDir) fail(OUTPUT_CODE, 'output-dir cannot be a filesystem root');
  try {
    await fsp.mkdir(parentDir, { recursive: true });
    await fsp.access(parentDir, fs.constants.W_OK);
    let stat = null;
    try {
      stat = await fsp.lstat(outputDir);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (!stat) return { existed: false, parentDir, baseName };
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(OUTPUT_CODE, 'output-dir is not a directory');
    if ((await fsp.readdir(outputDir)).length !== 0) fail(OUTPUT_CODE, 'output-dir must be empty');
    return { existed: true, parentDir, baseName, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (error?.code === OUTPUT_CODE) throw error;
    fail(OUTPUT_CODE, 'output-dir is not writable');
  }
}

async function createStagingDirectory(target) {
  try {
    const stagingDir = await fsp.mkdtemp(path.join(target.parentDir, `.${target.baseName}.staging-`));
    await fsp.mkdir(path.join(stagingDir, 'shots'));
    await fsp.mkdir(path.join(stagingDir, 'frames'));
    return stagingDir;
  } catch (_) {
    fail(OUTPUT_CODE, 'cannot create staging directory');
  }
}

async function publishStagingDirectory(stagingDir, outputDir, target) {
  let removedEmptyTarget = false;
  try {
    if (target.existed) {
      const stat = await fsp.lstat(outputDir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== target.dev || stat.ino !== target.ino
        || (await fsp.readdir(outputDir)).length !== 0) {
        fail(OUTPUT_CODE, 'output-dir changed before publish');
      }
      await fsp.rmdir(outputDir);
      removedEmptyTarget = true;
    } else {
      try {
        await fsp.lstat(outputDir);
        fail(OUTPUT_CODE, 'output-dir appeared before publish');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    await fsp.rename(stagingDir, outputDir);
  } catch (error) {
    if (removedEmptyTarget) {
      try {
        await fsp.mkdir(outputDir);
      } catch (_) {
        // A concurrent writer may have recreated the destination; never remove it.
      }
    }
    if (error?.code === OUTPUT_CODE) throw error;
    fail(OUTPUT_CODE, 'atomic output publish failed');
  }
}

async function writeAtomic(filePath, content) {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx' });
    await fsp.rename(tempPath, filePath);
  } catch (_) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    fail(OUTPUT_CODE, 'atomic manifest write failed');
  }
}

async function generateArtifact(finalPath, args) {
  const extension = path.extname(finalPath);
  const tempPath = `${finalPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp${extension}`;
  try {
    await runMedia(getFfmpegPath(), [...args, tempPath]);
    await fsp.rename(tempPath, finalPath);
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function seconds(milliseconds) {
  return (milliseconds / 1000).toFixed(3);
}

async function generateShotArtifacts(sourcePath, outputDir, shot) {
  const clipRelative = `shots/${shot.id}-motion.mp4`;
  const frameRelative = `frames/${shot.id}-representative.jpg`;
  const clipPath = path.join(outputDir, ...clipRelative.split('/'));
  const framePath = path.join(outputDir, ...frameRelative.split('/'));
  const durationMs = shot.end_ms - shot.start_ms;
  await generateArtifact(clipPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', seconds(shot.start_ms), '-i', sourcePath,
    '-t', seconds(durationMs), '-map', '0:v:0', '-an',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  ]);
  await generateArtifact(framePath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', seconds(shot.start_ms + Math.floor(durationMs / 2)), '-i', sourcePath,
    '-map', '0:v:0', '-frames:v', '1', '-q:v', '2',
  ]);
  const [clipHash, frameHash, clipProbe, frameProbe] = await Promise.all([
    sha256File(clipPath),
    sha256File(framePath),
    probeMedia(clipPath),
    probeImage(framePath),
  ]);
  if (clipProbe.has_audio || Math.abs(clipProbe.duration_ms - durationMs) > 250) {
    fail(MEDIA_CODE, 'generated motion clip failed media validation');
  }
  return {
    motion_reference: {
      ...shot.motion_reference,
      kind: 'audio_free_source_motion',
      artifact: {
        path: clipRelative,
        sha256: clipHash,
        probe: {
          duration_ms: clipProbe.duration_ms,
          width: clipProbe.video.width,
          height: clipProbe.video.height,
          codec: clipProbe.video.codec,
          frame_rate: clipProbe.video.frame_rate,
          has_audio: false,
        },
      },
    },
    representative_frame: { path: frameRelative, sha256: frameHash, probe: frameProbe },
  };
}

async function readCase(casePath) {
  let stat;
  try {
    stat = await fsp.stat(casePath);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) fail(CASE_CODE, 'case manifest is not a valid local JSON file');
    return validateCaseManifest(JSON.parse(await fsp.readFile(casePath, 'utf8')));
  } catch (error) {
    if (error?.code === CASE_CODE) throw error;
    fail(CASE_CODE, 'case manifest is not valid JSON');
  }
}

async function runLocalPreparation(options, deps = {}) {
  const sourcePath = path.resolve(String(options?.source || ''));
  const casePath = path.resolve(String(options?.caseManifest || ''));
  const outputDir = path.resolve(String(options?.outputDir || ''));
  const outputTarget = await inspectOutputTarget(outputDir);
  const caseManifest = await readCase(casePath);

  let before;
  try {
    before = await fsp.stat(sourcePath);
    if (!before.isFile()) fail(SOURCE_CODE, 'source must be a local file');
  } catch (error) {
    if (error?.code === SOURCE_CODE) throw error;
    fail(SOURCE_CODE, 'source must be a readable local file');
  }
  let sourceHash;
  let sourceProbe;
  try {
    [sourceHash, sourceProbe] = await Promise.all([
      sha256File(sourcePath),
      probeMedia(sourcePath, { errorCode: SOURCE_CODE }),
    ]);
  } catch (error) {
    if (error?.code) throw error;
    fail(SOURCE_CODE, 'source hashing failed');
  }
  const after = await fsp.stat(sourcePath);
  if (!sameStat(before, after)) fail(SOURCE_CODE, 'source changed during verification');
  assertSourceContract(caseManifest.source, sourceHash, sourceProbe);

  const stagingDir = await createStagingDirectory(outputTarget);
  let published = false;
  try {
    const outputShots = [];
    const artifactGenerator = deps.generateShotArtifacts || generateShotArtifacts;
    for (const shot of caseManifest.shots) {
      const artifacts = await artifactGenerator(sourcePath, stagingDir, shot);
      outputShots.push({
        id: shot.id,
        start_ms: shot.start_ms,
        end_ms: shot.end_ms,
        face_tracks: shot.face_tracks,
        face_track_review: shot.face_track_review,
        identity_packs: shot.identity_packs,
        text_regions: shot.text_regions,
        text_region_review: shot.text_region_review,
        motion_reference: artifacts.motion_reference,
        representative_frame: artifacts.representative_frame,
        dialogue: shot.dialogue,
        reference_bundle_ready: shot.reference_bundle_ready,
        blockers: shot.blockers,
      });
    }
    let finalSourceStat;
    try {
      finalSourceStat = await fsp.stat(sourcePath);
    } catch (_) {
      fail(SOURCE_CODE, 'source changed during local preprocessing');
    }
    if (!sameStat(before, finalSourceStat)) fail(SOURCE_CODE, 'source changed during local preprocessing');

    const manifest = {
      schema_version: 'redraw-full-episode-reference-local-v1',
      case_id: caseManifest.case_id,
      reference_bundle_required: true,
      target: caseManifest.target,
      source: {
        sha256: sourceHash,
        duration_ms: sourceProbe.duration_ms,
        video: sourceProbe.video,
        audio: sourceProbe.audio,
      },
      timeline_contiguous: true,
      provider_request_constructed: false,
      supplier_call_performed: false,
      shots: outputShots,
      summary: {
        shot_count: outputShots.length,
        ready_count: outputShots.filter((shot) => shot.reference_bundle_ready).length,
        blocked_count: outputShots.filter((shot) => !shot.reference_bundle_ready).length,
      },
    };
    await writeAtomic(path.join(stagingDir, MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`);
    await publishStagingDirectory(stagingDir, outputDir, outputTarget);
    published = true;
    return { manifestPath: path.join(outputDir, MANIFEST_FILENAME), manifest };
  } finally {
    if (!published) await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

function exitCodeFor(error) {
  if (error?.code === CLI_CODE) return 2;
  if (error?.code === CASE_CODE) return 3;
  if (error?.code === SOURCE_CODE) return 4;
  if (error?.code === OUTPUT_CODE) return 5;
  return 6;
}

function usage() {
  return 'Usage: node scripts/run-redraw-full-episode-reference-local.js --source <mp4> --case-manifest <json> --output-dir <dir>';
}

async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    const result = await runLocalPreparation(options);
    process.stdout.write(`${JSON.stringify({ manifest: path.basename(result.manifestPath), summary: result.manifest.summary })}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error?.code || MEDIA_CODE}: ${error?.message || 'local preparation failed'}\n`);
    return exitCodeFor(error);
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  MANIFEST_FILENAME,
  EXPECTED_SHOT_IDS,
  exitCodeFor,
  main,
  parseArgs,
  probeMedia,
  runLocalPreparation,
  validateCaseManifest,
};
