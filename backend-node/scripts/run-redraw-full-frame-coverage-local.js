const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const sharp = require('sharp');

const sourcePolicy = require('../config/redraw-full-frame-model-sources.json');
const { getFfmpegPath, getFfprobePath } = require('../src/utils/ffmpegPath');
const { validateModelLock } = require('../src/services/redrawFullFrameModelLockService');
const { detectFrames: defaultDetectFrames } = require('../src/services/redrawFullFrameDetectorProcess');
const {
  buildGeneratedCoverageManifest,
  validateGeneratedCoverageManifest,
} = require('../src/services/redrawFullFrameCoverageService');
const reviewService = require('../src/services/redrawFullFrameReviewService');

const OUTPUT_INVALID = 'REDRAW_FULL_FRAME_OUTPUT_INVALID';
const SOURCE_MISMATCH = 'REDRAW_FULL_FRAME_SOURCE_MISMATCH';
const MODEL_LOCK_INVALID = 'REDRAW_FULL_FRAME_MODEL_LOCK_INVALID';
const MODEL_UNAVAILABLE = 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE';
const FRAME_GAP = 'REDRAW_FULL_FRAME_FRAME_GAP';
const MASK_INVALID = 'REDRAW_FULL_FRAME_MASK_INVALID';
const DEFAULT_CASE_POLICY = Object.freeze({
  case_id: 'ac087bcd-latam-en-us',
  duration_ms: 68733,
  source: Object.freeze({
    sha256: '24eb1d8ba3ff11e6aa3e547b7ac400f6b177dcf541d1af36354d3e46cc05e9ae',
    video: Object.freeze({ width: 720, height: 1280, codec: 'hevc', frame_rate: 30 }),
    audio: Object.freeze({ codec: 'aac', channels: 1, sample_rate: 44100 }),
  }),
  target: Object.freeze({ language: 'en', locale: 'en-US', market: 'US' }),
  cast_ids: Object.freeze(['mateo', 'diego', 'lucas', 'elena', 'rafael']),
  shots: Object.freeze([
    Object.freeze({ id: 'shot-1', start_ms: 0, end_ms: 8000 }),
    Object.freeze({ id: 'shot-2', start_ms: 8000, end_ms: 16000 }),
    Object.freeze({ id: 'shot-3', start_ms: 16000, end_ms: 24000 }),
    Object.freeze({ id: 'shot-4', start_ms: 24000, end_ms: 32000 }),
    Object.freeze({ id: 'shot-5', start_ms: 32000, end_ms: 40000 }),
    Object.freeze({ id: 'shot-6', start_ms: 40000, end_ms: 48000 }),
    Object.freeze({ id: 'shot-7', start_ms: 48000, end_ms: 56000 }),
    Object.freeze({ id: 'shot-8', start_ms: 56000, end_ms: 64000 }),
    Object.freeze({ id: 'shot-9', start_ms: 64000, end_ms: 68733 }),
  ]),
});
const FAULTS = new Set(['mask_write']);

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function fail(code) {
  throw coded(code);
}

function sanitizeCatch(error, fallback) {
  if (error && typeof error.code === 'string' && /^REDRAW_FULL_FRAME_/.test(error.code)) throw coded(error.code);
  throw coded(fallback);
}

function assertPlainObject(value, code = OUTPUT_INVALID) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
}

function assertExactKeys(value, keys, code = OUTPUT_INVALID) {
  assertPlainObject(value, code);
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(code);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(code);
  }
}

function assertTargetKeys(value) {
  assertPlainObject(value);
  const allowed = new Set(['language', 'locale', 'market', 'cast_direction']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(OUTPUT_INVALID);
  }
  for (const key of ['language', 'locale', 'market']) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(OUTPUT_INVALID);
  }
}

function assertNoForbidden(value, code = OUTPUT_INVALID) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbidden(item, code);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (/^(url|ocr|ocr_text|text|content|prompt|key|token|authorization|approved|ready)$/i.test(key)) fail(code);
    assertNoForbidden(nested, code);
  }
}

function resolveFsOps(fsOps) {
  if (fsOps === undefined) {
    return {
      writeFile: (...args) => fsp.writeFile(...args),
      rename: (...args) => fsp.rename(...args),
      rmdir: (...args) => fsp.rmdir(...args),
    };
  }
  assertExactKeys(fsOps, ['writeFile', 'rename', 'rmdir']);
  for (const key of ['writeFile', 'rename', 'rmdir']) {
    if (typeof fsOps[key] !== 'function') fail(OUTPUT_INVALID);
  }
  return fsOps;
}

function safeArg(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return false;
  if (/^(https?|file):\/\//i.test(value)) return false;
  if (/(api[_-]?key|access[_-]?token|authorization|bearer|client[_-]?secret|secret|token)=/i.test(value)) return false;
  return true;
}

function parseArgs(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  if (argv[0] === 'finalize') return parseFinalizeArgs(argv);
  if (argv[0] !== 'analyze') fail(OUTPUT_INVALID);
  const required = new Map([
    ['--source', 'source'],
    ['--case', 'casePath'],
    ['--model-lock', 'modelLockPath'],
    ['--output-dir', 'outputDir'],
  ]);
  const parsed = { command: 'analyze' };
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const key = required.get(flag);
    if (!key || value === undefined || parsed[key] !== undefined || !safeArg(value)) fail(OUTPUT_INVALID);
    parsed[key] = value;
  }
  for (const key of required.values()) {
    if (!parsed[key]) fail(OUTPUT_INVALID);
  }
  return parsed;
}

function parseFinalizeArgs(argv = process.argv.slice(2)) {
  if (argv[0] !== 'finalize') fail(OUTPUT_INVALID);
  const required = new Map([
    ['--analysis-dir', 'analysisDir'],
    ['--review-decisions', 'reviewDecisions'],
    ['--output-dir', 'outputDir'],
  ]);
  const parsed = { command: 'finalize' };
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const key = required.get(flag);
    if (!key || value === undefined || parsed[key] !== undefined || !safeArg(value)) fail(OUTPUT_INVALID);
    parsed[key] = value;
  }
  for (const key of required.values()) {
    if (!parsed[key]) fail(OUTPUT_INVALID);
  }
  return parsed;
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function sha256File(filePath) {
  return sha256Bytes(await fsp.readFile(filePath));
}

function parseRate(value) {
  const match = /^(\d+)\/(\d+)$/.exec(String(value || ''));
  if (!match || Number(match[2]) === 0) fail(SOURCE_MISMATCH);
  return Number(match[1]) / Number(match[2]);
}

function parseTimeBase(value) {
  const match = /^(\d+)\/(\d+)$/.exec(String(value || ''));
  if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) fail(SOURCE_MISMATCH);
  return { numerator: Number(match[1]), denominator: Number(match[2]) };
}

function safeEnv() {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) env[key] = process.env[key];
  }
  return env;
}

function runProcess(command, args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      env: safeEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        reject(coded(SOURCE_MISMATCH));
      }
    }, timeoutMs);
    const failProcess = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(coded(SOURCE_MISMATCH));
      }
    };
    child.on('error', failProcess);
    child.stdout.on('data', (chunk) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > 16 * 1024 * 1024) failProcess();
    });
    child.stderr.on('data', (chunk) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > 1024 * 1024) failProcess();
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(coded(SOURCE_MISMATCH));
        return;
      }
      resolve(stdout.toString('utf8'));
    });
  });
}

async function probeVideo({ source, ffprobePath }) {
  try {
    const streamsRaw = await runProcess(ffprobePath, [
      '-v',
      'error',
      '-count_frames',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      source,
    ]);
    const frameRaw = await runProcess(ffprobePath, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_frames',
      '-show_entries',
      'frame=best_effort_timestamp,pkt_pts,best_effort_timestamp_time,pkt_pts_time',
      '-of',
      'json',
      source,
    ]);
    const parsed = JSON.parse(streamsRaw);
    const stream = (parsed.streams || []).find((item) => item.codec_type === 'video');
    const audioStream = (parsed.streams || []).find((item) => item.codec_type === 'audio');
    if (!stream) fail(SOURCE_MISMATCH);
    const frames = JSON.parse(frameRaw).frames || [];
    const timeBase = parseTimeBase(stream.time_base);
    const timestamps = frames.map((frame, index) => {
      const rawTicks = frame.best_effort_timestamp ?? frame.pkt_pts;
      const ticks = rawTicks === undefined || rawTicks === 'N/A' ? index : Number(rawTicks);
      if (!Number.isInteger(ticks) || ticks < 0) fail(FRAME_GAP);
      const ms = Number((BigInt(ticks) * BigInt(timeBase.numerator) * 1000n + (BigInt(timeBase.denominator) / 2n)) / BigInt(timeBase.denominator));
      return { timestamp_ticks: ticks, timestamp_ms: ms };
    });
    const width = Number(stream.width);
    const height = Number(stream.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || timestamps.length === 0) fail(SOURCE_MISMATCH);
    return {
      width,
      height,
      codec: String(stream.codec_name || '').toLowerCase(),
      frame_rate: parseRate(stream.avg_frame_rate || stream.r_frame_rate),
      time_base: timeBase,
      frame_count: timestamps.length,
      duration_ms: Math.round(Number(parsed.format?.duration || 0) * 1000),
      audio: audioStream ? {
        codec: String(audioStream.codec_name || '').toLowerCase(),
        channels: Number(audioStream.channels),
        sample_rate: Number(audioStream.sample_rate),
      } : null,
      timestamps,
    };
  } catch (error) {
    sanitizeCatch(error, SOURCE_MISMATCH);
  }
}

async function extractFrames({ source, framesDir, ffmpegPath }) {
  await fsp.mkdir(framesDir, { recursive: true });
  await runProcess(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    source,
    '-vsync',
    '0',
    '-start_number',
    '0',
    path.join(framesDir, 'frame-%06d.png'),
  ], { timeoutMs: 120000 });
}

function requirePolicy(policy) {
  try {
    assertExactKeys(policy, ['case_id', 'duration_ms', 'source', 'target', 'cast_ids', 'shots']);
    assertExactKeys(policy.source, ['sha256', 'video', 'audio']);
    assertExactKeys(policy.source.video, ['width', 'height', 'codec', 'frame_rate']);
    assertExactKeys(policy.source.audio, ['codec', 'channels', 'sample_rate']);
    assertExactKeys(policy.target, ['language', 'locale', 'market']);
    if (typeof policy.case_id !== 'string' || !Number.isInteger(policy.duration_ms) || !/^[a-f0-9]{64}$/i.test(policy.source.sha256)) fail(OUTPUT_INVALID);
    if (!Array.isArray(policy.cast_ids) || policy.cast_ids.length !== 5) fail(OUTPUT_INVALID);
    if (!Array.isArray(policy.shots) || policy.shots.length !== 9) fail(OUTPUT_INVALID);
    for (const shot of policy.shots) assertExactKeys(shot, ['id', 'start_ms', 'end_ms']);
    return policy;
  } catch (error) {
    sanitizeCatch(error, OUTPUT_INVALID);
  }
}

function validateCase(raw, policy = DEFAULT_CASE_POLICY) {
  try {
    policy = requirePolicy(policy);
    assertNoForbidden(raw);
    assertExactKeys(raw, ['case_id', 'source', 'target', 'cast', 'shots']);
    assertExactKeys(raw.source, ['sha256', 'duration_ms', 'duration_tolerance_ms', 'video', 'audio']);
    assertExactKeys(raw.source.video, ['width', 'height', 'codec', 'frame_rate']);
    assertExactKeys(raw.source.audio, ['codec', 'channels', 'sample_rate']);
    assertTargetKeys(raw.target);
    if (raw.case_id !== policy.case_id) fail(OUTPUT_INVALID);
    if (raw.source.sha256 !== policy.source.sha256) fail(SOURCE_MISMATCH);
    if (raw.target.language !== 'en' || raw.target.locale !== 'en-US' || raw.target.market !== 'US') fail(OUTPUT_INVALID);
    if (raw.target.language !== policy.target.language || raw.target.locale !== policy.target.locale || raw.target.market !== policy.target.market) fail(OUTPUT_INVALID);
    if (raw.source.duration_ms !== policy.duration_ms) fail(OUTPUT_INVALID);
    if (raw.source.video.width !== policy.source.video.width
      || raw.source.video.height !== policy.source.video.height
      || String(raw.source.video.codec).toLowerCase() !== String(policy.source.video.codec).toLowerCase()
      || Number(raw.source.video.frame_rate) !== Number(policy.source.video.frame_rate)) fail(OUTPUT_INVALID);
    if (String(raw.source.audio.codec).toLowerCase() !== String(policy.source.audio.codec).toLowerCase()
      || raw.source.audio.channels !== policy.source.audio.channels
      || raw.source.audio.sample_rate !== policy.source.audio.sample_rate) fail(OUTPUT_INVALID);
    if (!Array.isArray(raw.cast) || raw.cast.length !== 5) fail(OUTPUT_INVALID);
    const castIds = new Set();
    for (const item of raw.cast) {
      assertExactKeys(item, ['id', 'role', 'age_min']);
      if (!/^[A-Za-z0-9_-]+$/.test(item.id) || castIds.has(item.id) || !Number.isInteger(item.age_min) || item.age_min < 18) fail(OUTPUT_INVALID);
      castIds.add(item.id);
    }
    if (JSON.stringify([...castIds]) !== JSON.stringify(policy.cast_ids)) fail(OUTPUT_INVALID);
    if (!Array.isArray(raw.shots) || raw.shots.length !== 9) fail(FRAME_GAP);
    for (let index = 0; index < raw.shots.length; index += 1) {
      const shot = raw.shots[index];
      const expectedShot = policy.shots[index];
      assertExactKeys(shot, ['id', 'start_ms', 'end_ms', 'speaking_character_ids', 'text_regions']);
      if (shot.id !== expectedShot.id || shot.start_ms !== expectedShot.start_ms || shot.end_ms !== expectedShot.end_ms) fail(FRAME_GAP);
      if (shot.id !== `shot-${index + 1}`) fail(FRAME_GAP);
      if (index === 0 && shot.start_ms !== 0) fail(FRAME_GAP);
      if (index > 0 && shot.start_ms !== raw.shots[index - 1].end_ms) fail(FRAME_GAP);
      if (shot.end_ms <= shot.start_ms) fail(FRAME_GAP);
      for (const speakerId of shot.speaking_character_ids) {
        if (!castIds.has(speakerId)) fail(OUTPUT_INVALID);
      }
      for (const region of shot.text_regions) {
        assertExactKeys(region, ['region_key', 'kind', 'time_ranges', 'treatment']);
        if (!['text_subtitle', 'text_screen'].includes(region.kind)) fail(OUTPUT_INVALID);
        if (region.kind === 'text_subtitle' && region.treatment !== 'translate_subtitle') fail(OUTPUT_INVALID);
        if (region.kind === 'text_screen' && region.treatment !== 'localize_screen') fail(OUTPUT_INVALID);
        for (const range of region.time_ranges) {
          if (!Array.isArray(range) || range.length !== 2 || range[0] < shot.start_ms || range[1] > shot.end_ms || range[1] <= range[0]) fail(FRAME_GAP);
        }
      }
    }
    if (raw.shots.at(-1).end_ms !== raw.source.duration_ms) fail(FRAME_GAP);
    return JSON.parse(JSON.stringify(raw));
  } catch (error) {
    sanitizeCatch(error, OUTPUT_INVALID);
  }
}

function frameShot(caseData, timestampMs) {
  return caseData.shots.find((shot) => timestampMs >= shot.start_ms && timestampMs < shot.end_ms) || caseData.shots.at(-1);
}

function rangesFromFrames(indexes) {
  const sorted = [...new Set(indexes)].sort((a, b) => a - b);
  const ranges = [];
  for (const index of sorted) {
    const previous = ranges.at(-1);
    if (previous && index === previous.end_frame + 1) previous.end_frame = index;
    else ranges.push({ start_frame: index, end_frame: index });
  }
  return ranges;
}

function bboxOverlap(left, right) {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  return x2 > x1 && y2 > y1;
}

function clampBox(box, width, height) {
  const x = Math.max(0, Math.min(width - 1, Math.round(box.x)));
  const y = Math.max(0, Math.min(height - 1, Math.round(box.y)));
  return {
    x,
    y,
    width: Math.max(1, Math.min(width - x, Math.round(box.width))),
    height: Math.max(1, Math.min(height - y, Math.round(box.height))),
  };
}

async function writeMask(maskPath, width, height, fill, fault, fsOps) {
  if (fault === 'mask_write') fail(MASK_INVALID);
  const pixels = Buffer.alloc(width * height, 0);
  fill(pixels);
  const bytes = await sharp(pixels, { raw: { width, height, channels: 1 } }).toColourspace('b-w').png().toBuffer();
  await fsp.mkdir(path.dirname(maskPath), { recursive: true });
  await writeAtomic(maskPath, bytes, fsOps);
  return sha256Bytes(bytes);
}

function fillBbox(pixels, sourceWidth, box) {
  const bbox = clampBox(box, sourceWidth, Number.MAX_SAFE_INTEGER);
  for (let y = bbox.y; y < bbox.y + bbox.height; y += 1) {
    for (let x = bbox.x; x < bbox.x + bbox.width; x += 1) pixels[(y * sourceWidth) + x] = 255;
  }
}

function fillPolygon(pixels, width, height, polygon) {
  const xs = polygon.map((point) => point.x);
  const ys = polygon.map((point) => point.y);
  const box = clampBox({
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  }, width, height);
  fillBbox(pixels, width, box);
}

function classifyPerson(trackKey, castIds) {
  if (castIds.has(trackKey)) return { track_key: trackKey, kind: 'story_role', source_character_key: trackKey, target_strategy: 'fixed_actor' };
  const match = /^character:(.+)$/.exec(trackKey);
  if (match && castIds.has(match[1])) return { track_key: trackKey, kind: 'story_role', source_character_key: match[1], target_strategy: 'fixed_actor' };
  return { track_key: trackKey, kind: 'background_extra', source_character_key: null, target_strategy: 'foreign_adult_extra' };
}

function matchTextRegion(caseData, frame, polygon, height) {
  const shot = frameShot(caseData, frame.timestamp_ms);
  const active = shot.text_regions
    .filter((region) => region.time_ranges.some(([start, end]) => frame.timestamp_ms >= start && frame.timestamp_ms < end))
    .sort((left, right) => left.region_key.localeCompare(right.region_key));
  if (active.length === 0) return null;
  if (active.length === 1) return active[0];
  const centerY = polygon.reduce((sum, point) => sum + point.y, 0) / polygon.length;
  const preferredKind = centerY > (height / 3) ? 'text_subtitle' : 'text_screen';
  return active.find((region) => region.kind === preferredKind) || active[0];
}

function validateDetections(detections, frames) {
  if (!Array.isArray(detections)) fail(MODEL_UNAVAILABLE);
  const expected = new Set(frames.map((frame) => frame.frame_index));
  const seen = new Set();
  let candidateCount = 0;
  for (const detection of detections) {
    if (!detection || typeof detection !== 'object' || Array.isArray(detection)) fail(MODEL_UNAVAILABLE);
    const frameIndex = detection.frame_index;
    if (!Number.isInteger(frameIndex) || !expected.has(frameIndex) || seen.has(frameIndex)) fail(MODEL_UNAVAILABLE);
    if (!Array.isArray(detection.persons) || !Array.isArray(detection.faces) || !Array.isArray(detection.texts)) fail(MODEL_UNAVAILABLE);
    seen.add(frameIndex);
    candidateCount += detection.persons.length + detection.faces.length + detection.texts.length;
  }
  if (seen.size !== expected.size || candidateCount === 0) fail(MODEL_UNAVAILABLE);
  return detections;
}

async function buildTracks({ staging, source, caseData, frames, detections, fault, fsOps }) {
  const castIds = new Set(caseData.cast.map((item) => item.id));
  const personGroups = new Map();
  const textGroups = new Map();
  const frameRegionIds = new Map(frames.map((frame) => [frame.frame_index, { persons: [], texts: [] }]));
  const detectionByFrame = new Map(detections.map((item) => [item.frame_index, item]));

  for (const frame of frames) {
    const detection = detectionByFrame.get(frame.frame_index);
    const personBoxes = [];
    for (const person of detection.persons) {
      const classification = classifyPerson(person.track_key, castIds);
      const groupKey = classification.track_key;
      if (!personGroups.has(groupKey)) personGroups.set(groupKey, { ...classification, regions: [] });
      const regionId = `person-${frame.frame_index}-${person.candidate_id}`.replace(/[^A-Za-z0-9_:-]/g, '-');
      const maskPath = `masks/person/${regionId}.png`;
      const bbox = clampBox(person.bbox, source.width, source.height);
      const maskSha = await writeMask(path.join(staging, maskPath), source.width, source.height, (pixels) => fillBbox(pixels, source.width, bbox), fault, fsOps);
      personGroups.get(groupKey).regions.push({
        region_id: regionId,
        frame_index: frame.frame_index,
        bbox,
        mask: { path: maskPath, sha256: maskSha, width: source.width, height: source.height, mime_type: 'image/png' },
        association_confidence: person.confidence,
        detector_disagreement: false,
      });
      personBoxes.push(bbox);
      frameRegionIds.get(frame.frame_index).persons.push(regionId);
    }
    for (const face of detection.faces) {
      if (personBoxes.some((box) => bboxOverlap(box, face.bbox))) continue;
      const regionId = `person-${frame.frame_index}-${face.candidate_id}`.replace(/[^A-Za-z0-9_:-]/g, '-');
      const groupKey = `face-only-${face.candidate_id}`;
      if (!personGroups.has(groupKey)) {
        personGroups.set(groupKey, {
          track_key: groupKey,
          kind: 'background_extra',
          source_character_key: null,
          target_strategy: 'foreign_adult_extra',
          regions: [],
        });
      }
      const bbox = clampBox(face.bbox, source.width, source.height);
      const maskPath = `masks/person/${regionId}.png`;
      const maskSha = await writeMask(path.join(staging, maskPath), source.width, source.height, (pixels) => fillBbox(pixels, source.width, bbox), fault, fsOps);
      personGroups.get(groupKey).regions.push({
        region_id: regionId,
        frame_index: frame.frame_index,
        bbox,
        mask: { path: maskPath, sha256: maskSha, width: source.width, height: source.height, mime_type: 'image/png' },
        association_confidence: face.confidence,
        detector_disagreement: true,
      });
      frameRegionIds.get(frame.frame_index).persons.push(regionId);
    }
    for (const text of detection.texts) {
      const matched = matchTextRegion(caseData, frame, text.polygon, source.height);
      const groupKey = matched ? matched.region_key : `watermark-${text.candidate_id}`;
      if (!textGroups.has(groupKey)) {
        textGroups.set(groupKey, {
          region_key: groupKey,
          kind: matched ? (matched.kind === 'text_subtitle' ? 'subtitle' : 'screen') : 'watermark',
          treatment: matched ? matched.treatment : 'remove',
          target_text_key: matched ? matched.region_key : null,
          regions: [],
        });
      }
      const regionId = `text-${frame.frame_index}-${text.candidate_id}`.replace(/[^A-Za-z0-9_:-]/g, '-');
      const maskPath = `masks/text/${regionId}.png`;
      const polygon = text.polygon.map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) }));
      const maskSha = await writeMask(path.join(staging, maskPath), source.width, source.height, (pixels) => fillPolygon(pixels, source.width, source.height, polygon), fault, fsOps);
      textGroups.get(groupKey).regions.push({
        region_id: regionId,
        frame_index: frame.frame_index,
        polygon,
        mask: { path: maskPath, sha256: maskSha, width: source.width, height: source.height, mime_type: 'image/png' },
      });
      frameRegionIds.get(frame.frame_index).texts.push(regionId);
    }
  }

  const visibility = (regions) => rangesFromFrames(regions.map((region) => region.frame_index)).map((range) => ({ ...range, state: 'visible' }));
  const personTracks = [...personGroups.values()].map((group) => ({
    track_key: group.track_key,
    kind: group.kind,
    source_character_key: group.source_character_key,
    target_strategy: group.target_strategy,
    frame_ranges: rangesFromFrames(group.regions.map((region) => region.frame_index)),
    visibility: visibility(group.regions),
    regions: group.regions,
    review_status: 'pending',
    reviewer: null,
  }));
  const textTracks = [...textGroups.values()].map((group) => ({
    region_key: group.region_key,
    kind: group.kind,
    treatment: group.treatment,
    target_text_key: group.target_text_key,
    frame_ranges: rangesFromFrames(group.regions.map((region) => region.frame_index)),
    regions: group.regions,
    review_status: 'pending',
    reviewer: null,
  }));
  return { personTracks, textTracks, frameRegionIds };
}

async function writeAtomic(filePath, bytesOrText, fsOps) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.tmp-${path.basename(filePath)}-${process.pid}-${Date.now()}`);
  await fsOps.writeFile(temp, bytesOrText, { flag: 'wx' });
  await fsOps.rename(temp, filePath);
}

async function writeJson(filePath, value, fsOps) {
  await writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, fsOps);
}

async function makeOverlay({ framePath, outputPath, boxes = [], polygons = [], color, fsOps }) {
  const input = sharp(framePath);
  const metadata = await input.metadata();
  const svg = `<svg width="${metadata.width}" height="${metadata.height}" xmlns="http://www.w3.org/2000/svg">${boxes.map((box) => `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="none" stroke="${color}" stroke-width="2"/>`).join('')}${polygons.map((polygon) => `<polygon points="${polygon.map((point) => `${point.x},${point.y}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2"/>`).join('')}</svg>`;
  await writeAtomic(outputPath, await input.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 86 }).toBuffer(), fsOps);
}

async function writeReviewArtifacts({ staging, manifest, fsOps }) {
  const personByFrame = new Map(manifest.frames.map((frame) => [frame.frame_index, []]));
  const textByFrame = new Map(manifest.frames.map((frame) => [frame.frame_index, []]));
  for (const track of manifest.person_tracks) {
    for (const region of track.regions) personByFrame.get(region.frame_index).push({ ...region, track });
  }
  for (const track of manifest.text_tracks) {
    for (const region of track.regions) textByFrame.get(region.frame_index).push({ ...region, track });
  }
  for (const frame of manifest.frames) {
    await makeOverlay({
      framePath: path.join(staging, frame.path),
      outputPath: path.join(staging, 'overlays', 'person', `frame-${String(frame.frame_index).padStart(6, '0')}.jpg`),
      boxes: personByFrame.get(frame.frame_index).map((item) => item.bbox),
      color: '#00ff66',
      fsOps,
    });
    await makeOverlay({
      framePath: path.join(staging, frame.path),
      outputPath: path.join(staging, 'overlays', 'text', `frame-${String(frame.frame_index).padStart(6, '0')}.jpg`),
      polygons: textByFrame.get(frame.frame_index).map((item) => item.polygon),
      color: '#ffcc00',
      fsOps,
    });
  }
  const contactSheets = [];
  for (const shot of manifest.shots) {
    const shotFrames = manifest.frames.filter((frame) => frame.shot_id === shot.shot_id);
    const reviewFrames = shotFrames.filter((frame) => frame.review_point_reasons.length > 0);
    const selected = reviewFrames.length > 0 ? reviewFrames : [shotFrames[0]];
    const rows = [];
    for (const frame of selected) {
      const resizeCell = { fit: 'contain', background: '#111111' };
      const source = await sharp(path.join(staging, frame.path)).resize(320, 180, resizeCell).jpeg().toBuffer();
      const person = await sharp(path.join(staging, 'overlays', 'person', `frame-${String(frame.frame_index).padStart(6, '0')}.jpg`)).resize(320, 180, resizeCell).jpeg().toBuffer();
      const text = await sharp(path.join(staging, 'overlays', 'text', `frame-${String(frame.frame_index).padStart(6, '0')}.jpg`)).resize(320, 180, resizeCell).jpeg().toBuffer();
      rows.push({ source, person, text });
    }
    const canvas = sharp({
      create: {
        width: 960,
        height: rows.length * 180,
        channels: 3,
        background: '#111111',
      },
    });
    const composite = [];
    rows.forEach((row, index) => {
      composite.push({ input: row.source, left: 0, top: index * 180 });
      composite.push({ input: row.person, left: 320, top: index * 180 });
      composite.push({ input: row.text, left: 640, top: index * 180 });
    });
    const relative = `contact-sheets/${shot.shot_id}.jpg`;
    await writeAtomic(path.join(staging, relative), await canvas.composite(composite).jpeg({ quality: 88 }).toBuffer(), fsOps);
    contactSheets.push(relative);
  }
  const template = {
    schema_version: 'redraw-full-frame-review-decisions-v1',
    analysis_sha256: manifest.analysis_sha256,
    reviewer: null,
    review_points: manifest.frames
      .filter((frame) => frame.review_point_reasons.length > 0)
      .map((frame) => ({ frame_index: frame.frame_index, decision: null, corrections: [] })),
  };
  await writeJson(path.join(staging, 'review-decisions.template.json'), template, fsOps);
  const html = [
    '<!doctype html><html><head><meta charset="utf-8"><title>Redraw Full Frame Review</title></head><body>',
    '<h1>Redraw Full Frame Review</h1>',
    ...manifest.shots.map((shot) => {
      const frames = manifest.frames.filter((frame) => frame.shot_id === shot.shot_id && frame.review_point_reasons.length > 0);
      const items = frames.map((frame) => {
        const persons = personByFrame.get(frame.frame_index).map((item) => `${item.region_id}:${item.track.kind}/${item.track.target_strategy}`).join(', ');
        const texts = textByFrame.get(frame.frame_index).map((item) => `${item.region_id}:${item.track.kind}/${item.track.treatment}`).join(', ');
        return `<li>frame_index ${frame.frame_index}, timestamp ${frame.timestamp_ms}, reasons ${frame.review_point_reasons.join(', ')}; persons ${persons}; texts ${texts}</li>`;
      }).join('');
      return `<section><h2>${shot.shot_id}</h2><a href="../contact-sheets/${shot.shot_id}.jpg">contact sheet</a><ul>${items}</ul></section>`;
    }),
    '</body></html>',
  ].join('');
  await writeAtomic(path.join(staging, 'review', 'index.html'), html, fsOps);
  return contactSheets;
}

async function assertReadableArtifacts(staging, manifest, contactSheets) {
  await validateGeneratedCoverageManifest({ evidenceRoot: staging, manifest });
  await Promise.all([
    fsp.access(path.join(staging, 'redraw-full-frame-coverage-manifest.json'), fs.constants.R_OK),
    fsp.access(path.join(staging, 'review', 'index.html'), fs.constants.R_OK),
    fsp.access(path.join(staging, 'review-decisions.template.json'), fs.constants.R_OK),
  ]);
  for (const relative of contactSheets) {
    const metadata = await sharp(path.join(staging, relative)).metadata();
    if (metadata.format !== 'jpeg') fail(OUTPUT_INVALID);
  }
  const serialized = JSON.stringify({
    manifest,
    html: await fsp.readFile(path.join(staging, 'review', 'index.html'), 'utf8'),
    template: JSON.parse(await fsp.readFile(path.join(staging, 'review-decisions.template.json'), 'utf8')),
  });
  if (/https?:\/\/|file:\/\/|[A-Za-z]:\\|authorization\s*[:=]|api[_-]?key\s*[:=]|client_secret\s*[:=]|access-token\s*[:=]|bearer\s+|不是哥们|新浪体育|南非对墨西哥|世界杯/i.test(serialized)) {
    fail(OUTPUT_INVALID);
  }
}

async function publishStaging(staging, outputDir, fsOps) {
  if (fs.existsSync(outputDir)) {
    const entries = await fsp.readdir(outputDir);
    if (entries.length !== 0) fail(OUTPUT_INVALID);
    await fsOps.rmdir(outputDir);
  }
  await fsOps.rename(staging, outputDir);
}

async function runAnalyze(options, deps = {}) {
  const outputDir = path.resolve(options.outputDir);
  const parent = path.dirname(outputDir);
  const randomHex = deps.randomHex || (() => crypto.randomBytes(8).toString('hex'));
  const staging = path.join(parent, `.redraw-full-frame-staging-${process.pid}-${randomHex()}`);
  let published = false;
  try {
    if (!safeArg(options.source) || !safeArg(options.casePath) || !safeArg(options.modelLockPath) || !safeArg(options.outputDir)) fail(OUTPUT_INVALID);
    if (deps.fault !== undefined && !FAULTS.has(deps.fault)) fail(OUTPUT_INVALID);
    const fsOps = resolveFsOps(deps.fsOps);
    if (fs.existsSync(outputDir) && (await fsp.readdir(outputDir)).length !== 0) fail(OUTPUT_INVALID);
    await fsp.mkdir(staging, { recursive: false });

    const caseData = validateCase(JSON.parse(await fsp.readFile(options.casePath, 'utf8')), deps.casePolicy || DEFAULT_CASE_POLICY);
    const sourceSha = await sha256File(options.source);
    if (sourceSha !== caseData.source.sha256) fail(SOURCE_MISMATCH);
    const ffprobePath = deps.ffprobePath || getFfprobePath();
    const ffmpegPath = deps.ffmpegPath || getFfmpegPath();
    const probe = deps.probeVideo ? await deps.probeVideo({ source: options.source }) : await probeVideo({ source: options.source, ffprobePath });
    if (probe.width !== caseData.source.video.width || probe.height !== caseData.source.video.height) fail(SOURCE_MISMATCH);
    if (probe.codec !== String(caseData.source.video.codec).toLowerCase()) fail(SOURCE_MISMATCH);
    if (Math.abs(probe.frame_rate - Number(caseData.source.video.frame_rate)) > 0.01) fail(SOURCE_MISMATCH);
    if (Math.abs(probe.duration_ms - caseData.source.duration_ms) > caseData.source.duration_tolerance_ms) fail(SOURCE_MISMATCH);
    if (!probe.audio
      || probe.audio.codec !== String(caseData.source.audio.codec).toLowerCase()
      || probe.audio.channels !== caseData.source.audio.channels
      || probe.audio.sample_rate !== caseData.source.audio.sample_rate) fail(SOURCE_MISMATCH);

    const modelLock = await validateModelLock({
      cacheRoot: path.dirname(path.resolve(options.modelLockPath)),
      sourcePolicy,
      lock: JSON.parse(await fsp.readFile(options.modelLockPath, 'utf8')),
    }).catch(() => { throw coded(MODEL_LOCK_INVALID); });

    const framesDir = path.join(staging, 'frames');
    await extractFrames({ source: options.source, framesDir, ffmpegPath }).catch((error) => sanitizeCatch(error, SOURCE_MISMATCH));
    const frameFiles = (await fsp.readdir(framesDir)).filter((name) => /^frame-\d{6}\.png$/.test(name)).sort();
    if (frameFiles.length !== probe.frame_count) fail(FRAME_GAP);
    const source = {
      sha256: sourceSha,
      duration_ms: caseData.source.duration_ms,
      width: probe.width,
      height: probe.height,
      frame_count: probe.frame_count,
      time_base: probe.time_base,
    };
    const frames = [];
    for (let index = 0; index < frameFiles.length; index += 1) {
      if (frameFiles[index] !== `frame-${String(index).padStart(6, '0')}.png`) fail(FRAME_GAP);
      const relative = `frames/${frameFiles[index]}`;
      const bytes = await fsp.readFile(path.join(staging, relative));
      const metadata = await sharp(bytes).metadata();
      if (metadata.format !== 'png' || metadata.width !== source.width || metadata.height !== source.height) fail(SOURCE_MISMATCH);
      const timestamp = probe.timestamps[index];
      frames.push({
        frame_index: index,
        timestamp_ticks: timestamp.timestamp_ticks,
        timestamp_ms: timestamp.timestamp_ms,
        shot_id: frameShot(caseData, timestamp.timestamp_ms).id,
        path: relative,
        sha256: sha256Bytes(bytes),
        width: source.width,
        height: source.height,
        person_region_ids: [],
        text_region_ids: [],
        review_point_reasons: [],
        review_status: 'not_required',
      });
    }
    const detectFrames = deps.detectFrames || defaultDetectFrames;
    const pythonPath = deps.pythonPath || process.env.REDRAW_AUDITOR_PYTHON;
    if (!deps.detectFrames && !pythonPath) fail(MODEL_UNAVAILABLE);
    const workerRoot = path.resolve(__dirname, '..', '..', 'workers', 'redraw-full-frame-auditor');
    const detections = validateDetections(await detectFrames({
      pythonPath,
      workerRoot,
      modelLockPath: path.resolve(options.modelLockPath),
      frames: frames.map((frame) => ({
        frame_index: frame.frame_index,
        timestamp_ms: frame.timestamp_ms,
        frame_path: path.join(staging, frame.path),
      })),
    }).catch(() => { throw coded(MODEL_UNAVAILABLE); }), frames);
    const { personTracks, textTracks, frameRegionIds } = await buildTracks({ staging, source, caseData, frames, detections, fault: deps.fault, fsOps });
    for (const frame of frames) {
      const ids = frameRegionIds.get(frame.frame_index);
      frame.person_region_ids = ids.persons;
      frame.text_region_ids = ids.texts;
    }
    const shots = caseData.shots.map((shot) => ({ shot_id: shot.id, start_ms: shot.start_ms, end_ms: shot.end_ms }));
    const manifest = await buildGeneratedCoverageManifest({
      evidenceRoot: staging,
      source,
      shots,
      frames,
      personTracks,
      textTracks,
      modelLock,
    });
    await writeJson(path.join(staging, 'redraw-full-frame-coverage-manifest.json'), manifest, fsOps);
    const contactSheets = await writeReviewArtifacts({ staging, manifest, fsOps });
    await assertReadableArtifacts(staging, manifest, contactSheets);
    if (fs.existsSync(outputDir) && (await fsp.readdir(outputDir)).length !== 0) fail(OUTPUT_INVALID);
    await publishStaging(staging, outputDir, fsOps);
    published = true;
    return {
      manifest,
      contact_sheets: contactSheets,
      files: {
        manifest: 'redraw-full-frame-coverage-manifest.json',
        review: 'review/index.html',
        decisions_template: 'review-decisions.template.json',
      },
    };
  } catch (error) {
    sanitizeCatch(error, OUTPUT_INVALID);
  } finally {
    if (!published) await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

async function runFinalize(options) {
  try {
    if (!safeArg(options.analysisDir) || !safeArg(options.reviewDecisions) || !safeArg(options.outputDir)) fail(OUTPUT_INVALID);
    const stat = await fsp.lstat(options.reviewDecisions).catch(() => fail(OUTPUT_INVALID));
    if (!stat.isFile() || stat.isSymbolicLink()) fail(OUTPUT_INVALID);
    const decisions = JSON.parse(await fsp.readFile(options.reviewDecisions, 'utf8'));
    return await reviewService.finalizeReviewedCoverage({
      analysisRoot: options.analysisDir,
      decisions,
      outputRoot: options.outputDir,
    });
  } catch (error) {
    sanitizeCatch(error, OUTPUT_INVALID);
  }
}

async function runCli(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write('Usage: node scripts/run-redraw-full-frame-coverage-local.js analyze --source <local-video> --case <case-json> --model-lock <raw-model-lock-json> --output-dir <missing-or-empty-dir>\n       node scripts/run-redraw-full-frame-coverage-local.js finalize --analysis-dir <dir> --review-decisions <json> --output-dir <missing-or-empty-dir>\n');
      return;
    }
    if (args.command === 'finalize') {
      await runFinalize(args);
      process.stdout.write('REDRAW_FULL_FRAME_REVIEW_FINALIZED_OK\n');
    } else {
      await runAnalyze(args);
      process.stdout.write('REDRAW_FULL_FRAME_COVERAGE_LOCAL_OK\n');
    }
  } catch (error) {
    process.stderr.write(`${error?.code && /^REDRAW_FULL_FRAME_/.test(error.code) ? error.code : OUTPUT_INVALID}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runCli();
}

module.exports = {
  parseArgs,
  parseFinalizeArgs,
  runAnalyze,
  runFinalize,
  runCli,
  probeVideo,
  runProcess,
};
