const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { validateGeneratedCoverageManifest } = require('../src/services/redrawFullFrameCoverageService');
const {
  normalizeReviewDecisions,
  REVIEWER,
  DECISIONS_SCHEMA,
} = require('../src/services/redrawFullFrameReviewService');

const OUTPUT_INVALID = 'REDRAW_FULL_FRAME_OUTPUT_INVALID';
const REVIEW_LOCKED = 'REDRAW_FULL_FRAME_REVIEW_LOCKED';
const ACTION_KEYS = new Map([
  ['add_person_region', ['action', 'region_id', 'frame_index', 'track_key', 'bbox', 'visibility', 'kind', 'source_character_key', 'target_strategy']],
  ['remove_person_candidate', ['action', 'region_id']],
  ['merge_person_tracks', ['action', 'source_track_keys', 'target_track_key', 'kind', 'source_character_key', 'target_strategy']],
  ['split_person_track', ['action', 'track_key', 'split_frame_index', 'new_track_key']],
  ['add_text_region', ['action', 'region_id', 'frame_index', 'region_key', 'polygon', 'kind', 'treatment', 'target_text_key']],
  ['remove_text_candidate', ['action', 'region_id']],
  ['change_text_kind', ['action', 'region_key', 'kind']],
  ['change_text_treatment', ['action', 'region_key', 'treatment', 'target_text_key']],
]);

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function fail(code = OUTPUT_INVALID) {
  throw coded(code);
}

function safeArg(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('\0')
    && !/^(https?|file):\/\//i.test(value)
    && !/(api[_-]?key|authorization|bearer|client[_-]?secret|secret|token)=/i.test(value);
}

function parsePairs(argv, allowed, required) {
  const parsed = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const key = allowed.get(flag);
    if (!key || value === undefined || parsed[key] !== undefined || !safeArg(value)) fail();
    parsed[key] = value;
  }
  for (const key of required) if (!parsed[key]) fail();
  return parsed;
}

function parseArgs(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  if (argv.includes('--approved') || argv.includes('--source') || argv.includes('--model') || argv.includes('--provider')) fail();
  if (argv[0] === 'init') {
    return { command: 'init', ...parsePairs(argv, new Map([['--analysis-dir', 'analysisDir'], ['--output', 'output']]), ['analysisDir', 'output']) };
  }
  if (argv[0] === 'decide') {
    const parsed = parsePairs(argv, new Map([
      ['--decisions', 'decisions'],
      ['--frame-index', 'frameIndex'],
      ['--decision', 'decision'],
      ['--correction-json', 'correctionJson'],
    ]), ['decisions', 'frameIndex', 'decision']);
    const frameIndex = Number(parsed.frameIndex);
    if (!Number.isInteger(frameIndex) || frameIndex < 0 || !['accepted', 'corrected'].includes(parsed.decision)) fail();
    if (parsed.decision === 'accepted' && parsed.correctionJson !== undefined) fail();
    if (parsed.decision === 'corrected' && parsed.correctionJson === undefined) fail();
    return { command: 'decide', decisions: parsed.decisions, frameIndex, decision: parsed.decision, correctionJson: parsed.correctionJson };
  }
  if (argv[0] === 'show-pending') {
    return { command: 'show-pending', ...parsePairs(argv, new Map([['--decisions', 'decisions']]), ['decisions']) };
  }
  fail();
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function assertSafeExistingDirectory(dirPath) {
  const resolved = path.resolve(dirPath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const parts = resolved.slice(parsed.root.length).split(/[\\/]/).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await fsp.lstat(current, { bigint: true }).catch(() => fail());
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
    const real = await fsp.realpath(current).catch(() => fail());
    if (!samePath(real, current)) fail();
  }
  return resolved;
}

async function secureReadExistingFile(filePath) {
  const abs = path.resolve(filePath);
  await assertSafeExistingDirectory(path.dirname(abs));
  const pathStat = await fsp.lstat(abs, { bigint: true }).catch(() => fail());
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) fail();
  const realBefore = await fsp.realpath(abs).catch(() => fail());
  if (!samePath(realBefore, abs)) fail();
  let handle;
  try {
    handle = await fsp.open(abs, 'r');
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameIdentity(pathStat, before)) fail();
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await fsp.lstat(abs, { bigint: true }).catch(() => fail());
    const realAfter = await fsp.realpath(abs).catch(() => fail());
    if (!samePath(realBefore, realAfter) || !sameIdentity(before, after) || !sameIdentity(before, pathAfter)) fail();
    return { abs, bytes, sha256: sha256(bytes), stat: before };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function assertRegularNoLink(filePath, missingOk = false) {
  const abs = path.resolve(filePath);
  await assertSafeExistingDirectory(path.dirname(abs));
  const stat = await fsp.lstat(abs).catch((error) => {
    if (missingOk && error.code === 'ENOENT') return null;
    fail();
  });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) fail();
  return abs;
}

async function readJsonNoLink(filePath) {
  const read = await secureReadExistingFile(filePath);
  return JSON.parse(read.bytes.toString('utf8'));
}

async function readGenerated(analysisDir) {
  const root = path.resolve(analysisDir);
  const stat = await fsp.lstat(root).catch(() => fail());
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  const manifest = await readJsonNoLink(path.join(root, 'redraw-full-frame-coverage-manifest.json'));
  return validateGeneratedCoverageManifest({ evidenceRoot: root, manifest });
}

async function writeMissingJson(filePath, value) {
  const abs = await assertRegularNoLink(filePath, true);
  if (fs.existsSync(abs)) fail();
  const parent = await assertSafeExistingDirectory(path.dirname(abs));
  const temp = path.join(path.dirname(abs), `.tmp-${path.basename(abs)}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  let wroteTemp = false;
  try {
    await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    wroteTemp = true;
    await assertSafeExistingDirectory(parent);
    const targetStat = await fsp.lstat(abs).catch((error) => {
      if (error.code === 'ENOENT') return null;
      fail();
    });
    if (targetStat) fail();
    await fsp.rename(temp, abs);
    wroteTemp = false;
    await secureReadExistingFile(abs);
  } finally {
    if (wroteTemp) await fsp.rm(temp, { force: true }).catch(() => {});
  }
}

async function runInit({ analysisDir, output }) {
  try {
    const manifest = await readGenerated(analysisDir);
    const decisions = {
      schema_version: DECISIONS_SCHEMA,
      analysis_sha256: manifest.analysis_sha256,
      reviewer: REVIEWER,
      review_points: manifest.frames
        .filter((frame) => frame.review_point_reasons.length > 0)
        .map((frame) => ({
          frame_index: frame.frame_index,
          reasons: frame.review_point_reasons,
          decision: 'pending',
          corrections: [],
        })),
    };
    await writeMissingJson(output, decisions);
    return decisions;
  } catch (error) {
    if (error?.code && /^REDRAW_FULL_FRAME_/.test(error.code)) throw error;
    fail();
  }
}

function parseCorrections(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail();
  }
  const corrections = Array.isArray(parsed) ? parsed : [parsed];
  if (corrections.length === 0) fail();
  for (const correction of corrections) {
    if (!correction || typeof correction !== 'object' || Array.isArray(correction) || typeof correction.action !== 'string') fail();
    const keys = ACTION_KEYS.get(correction.action);
    if (!keys) fail();
    const allowed = new Set(keys);
    for (const key of Object.keys(correction)) if (!allowed.has(key)) fail();
    for (const key of keys) if (!Object.prototype.hasOwnProperty.call(correction, key)) fail();
    if (JSON.stringify(correction).match(/https?:\/\/|file:\/\/|[A-Za-z]:\\|api[_-]?key|authorization|token|secret|approved/i)) fail();
  }
  return corrections;
}

async function runDecide({ decisions, frameIndex, decision, correctionJson }) {
  let lockHandle;
  let lockPath;
  let ownsLock = false;
  let temp;
  try {
    const initial = await secureReadExistingFile(decisions);
    const abs = initial.abs;
    lockPath = `${abs}.lock`;
    await assertSafeExistingDirectory(path.dirname(lockPath));
    lockHandle = await fsp.open(lockPath, 'wx').catch((error) => {
      if (error.code === 'EEXIST') fail(REVIEW_LOCKED);
      fail();
    });
    ownsLock = true;
    const locked = await secureReadExistingFile(abs);
    const beforeBytes = locked.bytes;
    const beforeSha = locked.sha256;
    await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString(), decisions_sha256: beforeSha })}\n`);
    const parsed = JSON.parse(beforeBytes.toString('utf8'));
    if (parsed.schema_version !== DECISIONS_SCHEMA || parsed.reviewer !== REVIEWER || !/^[a-f0-9]{64}$/.test(parsed.analysis_sha256) || !Array.isArray(parsed.review_points)) fail();
    for (const item of parsed.review_points) {
      const keys = Object.keys(item).sort();
      if (JSON.stringify(keys) !== JSON.stringify(['corrections', 'decision', 'frame_index', 'reasons'])) fail();
      if (!Number.isInteger(item.frame_index) || !Array.isArray(item.reasons) || !Array.isArray(item.corrections)) fail();
    }
    const point = parsed.review_points?.find((item) => item.frame_index === frameIndex);
    if (!point) fail();
    if (point.decision !== 'pending' || point.corrections.length !== 0) fail();
    point.decision = decision;
    point.corrections = decision === 'accepted' ? [] : parseCorrections(correctionJson);
    const nextBytes = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`);
    temp = path.join(path.dirname(abs), `.tmp-${path.basename(abs)}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    await assertSafeExistingDirectory(path.dirname(temp));
    await fsp.writeFile(temp, nextBytes, { flag: 'wx' });
    const current = await secureReadExistingFile(abs);
    if (current.sha256 !== beforeSha) fail();
    await assertSafeExistingDirectory(path.dirname(abs));
    await fsp.rename(temp, abs);
    temp = null;
    await secureReadExistingFile(abs);
    return parsed;
  } catch (error) {
    if (error?.code && /^REDRAW_FULL_FRAME_/.test(error.code)) throw error;
    fail();
  } finally {
    if (lockHandle) await lockHandle.close().catch(() => {});
    if (temp) await fsp.rm(temp, { force: true }).catch(() => {});
    if (lockPath && ownsLock) await fsp.rm(lockPath, { force: true }).catch(() => {});
  }
}

async function runShowPending({ decisions }) {
  try {
    const parsed = await readJsonNoLink(decisions);
    if (parsed.schema_version !== DECISIONS_SCHEMA || parsed.reviewer !== REVIEWER || !/^[a-f0-9]{64}$/.test(parsed.analysis_sha256) || !Array.isArray(parsed.review_points)) fail();
    return {
      pending: parsed.review_points
        .filter((point) => point.decision === 'pending')
        .map((point) => ({ frame_index: point.frame_index, reasons: point.reasons })),
    };
  } catch (error) {
    if (error?.code && /^REDRAW_FULL_FRAME_/.test(error.code)) throw error;
    fail();
  }
}

async function runCli(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write('Usage: node scripts/record-redraw-full-frame-review-local.js init|decide|show-pending ...\n');
      return;
    }
    if (args.command === 'init') {
      await runInit(args);
      process.stdout.write('REDRAW_FULL_FRAME_REVIEW_INIT_OK\n');
    } else if (args.command === 'decide') {
      await runDecide(args);
      process.stdout.write('REDRAW_FULL_FRAME_REVIEW_DECISION_OK\n');
    } else if (args.command === 'show-pending') {
      process.stdout.write(`${JSON.stringify(await runShowPending(args))}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error?.code && /^REDRAW_FULL_FRAME_/.test(error.code) ? error.code : OUTPUT_INVALID}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) runCli();

module.exports = {
  parseArgs,
  runInit,
  runDecide,
  runShowPending,
  runCli,
};
