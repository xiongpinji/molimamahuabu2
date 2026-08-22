const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { getFfprobePath } = require('../utils/ffmpegPath');

const execFileAsync = promisify(execFile);
const INPUT_CODE = 'REDRAW_REFERENCE_BUNDLE_INPUT_INVALID';
const STALE_CODE = 'REDRAW_REFERENCE_BUNDLE_MOTION_REFERENCE_STALE';
const HEX_64 = /^[a-f0-9]{64}$/;
const RELATIVE_PATH = /^redraw-conditioning\/([a-f0-9]{64})\.mp4$/;
const METADATA_SCHEMA = 'redraw-motion-reference-v1';

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function inputError() {
  return codedError(INPUT_CODE, '运动参考校验输入非法');
}

function staleError() {
  return codedError(STALE_CODE, '运动参考不可用或已失效');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isExpectedBinding(value) {
  return isObject(value)
    && isPositiveInteger(value.source_asset_id)
    && HEX_64.test(value.source_fingerprint)
    && Number.isInteger(value.clip_start_ms)
    && value.clip_start_ms >= 0
    && Number.isInteger(value.clip_end_ms)
    && value.clip_end_ms > value.clip_start_ms
    && HEX_64.test(value.face_coverage_sha256)
    && HEX_64.test(value.text_coverage_sha256);
}

function assertValidInput(input) {
  if (!isObject(input)
    || !input.db
    || typeof input.db.prepare !== 'function'
    || !isNonEmptyString(input.storageRoot)
    || !path.isAbsolute(input.storageRoot)
    || !isNonEmptyString(input.tenantId)
    || !isNonEmptyString(input.userId)
    || !isPositiveInteger(input.versionId)
    || !isPositiveInteger(input.shotId)
    || !isPositiveInteger(input.assetId)
    || !isExpectedBinding(input.expected)
    || (input.probeRunner !== undefined && typeof input.probeRunner !== 'function')) {
    throw inputError();
  }
}

function selectVideoAsset(db, assetId) {
  return db.prepare(`
    SELECT id, type, mime_type, local_path, metadata
    FROM assets
    WHERE id = ? AND deleted_at IS NULL
  `).get(assetId);
}

function readBoundMetadata(asset) {
  if (!asset || asset.type !== 'video' || asset.mime_type !== 'video/mp4') {
    throw staleError();
  }

  let metadata;
  try {
    metadata = JSON.parse(asset.metadata);
  } catch (_) {
    throw staleError();
  }
  const motion = metadata?.redraw_motion_reference;
  if (!isObject(motion)
    || motion.schema_version !== METADATA_SCHEMA
    || !isNonEmptyString(motion.tenant_id)
    || !isNonEmptyString(motion.user_id)
    || !isPositiveInteger(motion.version_id)
    || !isPositiveInteger(motion.shot_id)
    || !isExpectedBinding(motion)) {
    throw staleError();
  }
  return motion;
}

function assertMetadataBinding(motion, input) {
  const expected = input.expected;
  if (motion.tenant_id !== input.tenantId
    || motion.user_id !== input.userId
    || motion.version_id !== input.versionId
    || motion.shot_id !== input.shotId
    || motion.source_asset_id !== expected.source_asset_id
    || motion.source_fingerprint !== expected.source_fingerprint
    || motion.clip_start_ms !== expected.clip_start_ms
    || motion.clip_end_ms !== expected.clip_end_ms
    || motion.face_coverage_sha256 !== expected.face_coverage_sha256
    || motion.text_coverage_sha256 !== expected.text_coverage_sha256) {
    throw staleError();
  }
}

function comparablePath(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isStrictlyInside(root, candidate) {
  const relative = path.relative(comparablePath(root), comparablePath(candidate));
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function resolveConditioningPath(storageRoot, localPath) {
  const match = RELATIVE_PATH.exec(localPath);
  if (!match) throw staleError();

  const rootAbsolute = path.resolve(storageRoot);
  const conditioningAbsolute = path.join(rootAbsolute, 'redraw-conditioning');
  const rootReal = await fsp.realpath(rootAbsolute);
  const conditioningReal = await fsp.realpath(conditioningAbsolute);
  if (!isStrictlyInside(rootReal, conditioningReal)) throw staleError();

  return {
    absolutePath: path.join(conditioningAbsolute, `${match[1]}.mp4`),
    conditioningReal,
    filenameSha256: match[1],
  };
}

function statEvidence(stat) {
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    size: stat.size.toString(),
    mtime: stat.mtimeNs.toString(),
    ctime: stat.ctimeNs.toString(),
  };
}

function sameStat(left, right) {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.mtime === right.mtime
    && left.ctime === right.ctime;
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

async function readFileEvidence(resolved) {
  const firstRealPath = await fsp.realpath(resolved.absolutePath);
  if (!isStrictlyInside(resolved.conditioningReal, firstRealPath)) throw staleError();
  const firstStat = await fsp.stat(firstRealPath, { bigint: true });
  if (!firstStat.isFile()) throw staleError();

  const sha256 = await sha256File(firstRealPath);

  const secondRealPath = await fsp.realpath(resolved.absolutePath);
  if (!isStrictlyInside(resolved.conditioningReal, secondRealPath)) throw staleError();
  const secondStat = await fsp.stat(secondRealPath, { bigint: true });
  if (!secondStat.isFile()) throw staleError();

  const first = statEvidence(firstStat);
  const second = statEvidence(secondStat);
  if (comparablePath(firstRealPath) !== comparablePath(secondRealPath) || !sameStat(first, second)) {
    throw staleError();
  }

  return {
    realPath: secondRealPath,
    stat: second,
    sha256,
  };
}

function parseDurationMs(format, video) {
  const seconds = Number(format?.duration ?? video?.duration);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : Number.NaN;
}

async function runLocalProbe(absolutePath) {
  const { stdout } = await execFileAsync(getFfprobePath(), [
    '-v',
    'error',
    '-show_streams',
    '-show_format',
    '-of',
    'json',
    absolutePath,
  ], {
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 15000,
    killSignal: 'SIGKILL',
  });
  const parsed = JSON.parse(stdout);
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((stream) => stream?.codec_type === 'video');
  const formatNames = String(parsed.format?.format_name || '').split(',');
  return {
    duration_ms: parseDurationMs(parsed.format, video),
    width: video?.width,
    height: video?.height,
    mime_type: formatNames.includes('mp4') ? 'video/mp4' : null,
    video_codec: video?.codec_name,
    audio_stream_count: streams.filter((stream) => stream?.codec_type === 'audio').length,
  };
}

function assertMotionContract(probe, expected) {
  const expectedDuration = expected.clip_end_ms - expected.clip_start_ms;
  if (!isObject(probe)
    || !Number.isFinite(probe.duration_ms)
    || Math.abs(probe.duration_ms - expectedDuration) > 100
    || !isPositiveInteger(probe.width)
    || !isPositiveInteger(probe.height)
    || probe.mime_type !== 'video/mp4'
    || probe.video_codec !== 'h264'
    || probe.audio_stream_count !== 0) {
    throw staleError();
  }
}

function sameEvidence(before, after) {
  return comparablePath(before.realPath) === comparablePath(after.realPath)
    && sameStat(before.stat, after.stat)
    && before.sha256 === after.sha256;
}

function createProbeSnapshotPath() {
  const randomName = crypto.randomBytes(32).toString('hex');
  return path.join(os.tmpdir(), `redraw-motion.probe-${randomName}.mp4`);
}

async function removeProbeSnapshot(snapshotPath) {
  try {
    await fsp.unlink(snapshotPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function verifyMotionReference(input) {
  assertValidInput(input);

  try {
    const asset = selectVideoAsset(input.db, input.assetId);
    const motion = readBoundMetadata(asset);
    assertMetadataBinding(motion, input);

    const resolved = await resolveConditioningPath(input.storageRoot, asset.local_path);
    const before = await readFileEvidence(resolved);
    if (before.sha256 !== resolved.filenameSha256) throw staleError();

    const runner = input.probeRunner || runLocalProbe;
    const snapshotPath = createProbeSnapshotPath();
    let probe;
    try {
      await fsp.copyFile(before.realPath, snapshotPath, fs.constants.COPYFILE_EXCL);
      if (await sha256File(snapshotPath) !== before.sha256) throw staleError();

      probe = await runner(snapshotPath);
      assertMotionContract(probe, input.expected);

      if (await sha256File(snapshotPath) !== before.sha256) throw staleError();
    } finally {
      await removeProbeSnapshot(snapshotPath);
    }

    const after = await readFileEvidence(resolved);
    if (after.sha256 !== resolved.filenameSha256 || !sameEvidence(before, after)) {
      throw staleError();
    }

    return {
      asset_id: asset.id,
      sha256: after.sha256,
      duration_ms: probe.duration_ms,
      width: probe.width,
      height: probe.height,
      mime_type: probe.mime_type,
      video_codec: probe.video_codec,
      audio_stream_count: probe.audio_stream_count,
      source_asset_id: motion.source_asset_id,
      source_fingerprint: motion.source_fingerprint,
      clip_start_ms: motion.clip_start_ms,
      clip_end_ms: motion.clip_end_ms,
      face_coverage_sha256: motion.face_coverage_sha256,
      text_coverage_sha256: motion.text_coverage_sha256,
    };
  } catch (_) {
    throw staleError();
  }
}

module.exports = { verifyMotionReference };
