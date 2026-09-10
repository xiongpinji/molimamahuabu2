const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { probeVideo, generateSegment } = require('./redrawSourceConditioningService');

const SHA256 = /^[a-f0-9]{64}$/;
const MIMES = { '.mp4': 'video/mp4', '.mov': 'video/quicktime' };

function failure(kind = 'UNAVAILABLE') {
  return Object.assign(new Error(`REDRAW_SOURCE_VIDEO_${kind}`), { code: `REDRAW_SOURCE_VIDEO_${kind}` });
}

function positiveId(value) {
  return /^[1-9][0-9]*$/.test(String(value)) && Number.isSafeInteger(Number(value));
}

function binding(db, input) {
  const work = db.prepare(`SELECT id, source_asset_id, source_fingerprint FROM redraw_works
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL`)
    .get(Number(input.workId), input.tenantId, input.userId);
  if (!work) throw failure('NOT_FOUND');
  if (!SHA256.test(work.source_fingerprint)) throw failure();
  if (work.source_asset_id !== Number(input.expectedSourceAssetId)
    || work.source_fingerprint !== input.expectedSourceSha256) throw failure('CONFLICT');
  const asset = db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(work.source_asset_id);
  if (!asset) throw failure('NOT_FOUND');
  let metadata;
  try { metadata = JSON.parse(asset.metadata); } catch { throw failure(); }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw failure();
  if (metadata.tenant_id !== input.tenantId || metadata.user_id !== input.userId) throw failure('NOT_FOUND');
  if (asset.type !== 'video' || asset.category !== 'redraw_source') throw failure();
  for (const hash of [asset.sha256, asset.source_fingerprint, metadata.sha256, metadata.source_fingerprint]) {
    if (hash !== null && hash !== undefined && hash !== ''
      && (typeof hash !== 'string' || !SHA256.test(hash) || hash !== work.source_fingerprint)) throw failure();
  }
  if (asset.file_size !== null && (!Number.isSafeInteger(asset.file_size) || asset.file_size < 0)) throw failure();
  return {
    sourceAssetId: work.source_asset_id, sha256: work.source_fingerprint,
    localPath: asset.local_path, size: asset.file_size, metadata: asset.metadata,
    mime: MIMES[path.extname(String(asset.local_path)).toLowerCase()],
  };
}

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

// Inspect every component, including ancestors of the configured storage root.
function checkedPath(target, directory) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw failure();
  const resolved = path.resolve(target);
  let current = path.parse(resolved).root;
  const parts = resolved.slice(current.length).split(path.sep).filter(Boolean);
  let stat = fs.lstatSync(current, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure();
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    stat = fs.lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink()
      || ((index < parts.length - 1 || directory) ? !stat.isDirectory() : !stat.isFile())) throw failure();
  }
  if (!samePath(resolved, fs.realpathSync.native(resolved))) throw failure();
  return stat;
}

function sameStat(left, right) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((key) => left[key] === right[key]);
}

function privateStat(stat, mode) {
  if (typeof process.getuid === 'function'
    && (stat.uid !== BigInt(process.getuid()) || (stat.mode & BigInt(mode)) !== 0n)) throw failure();
}

async function prepareSnapshot(ctx, input) {
  if (!positiveId(input.workId) || !positiveId(input.expectedSourceAssetId)
    || typeof input.expectedSourceSha256 !== 'string' || !SHA256.test(input.expectedSourceSha256)) {
    throw failure('INPUT_INVALID');
  }
  const initial = binding(ctx.db, input);
  const signal = ctx.signal;
  let source;
  let snapshot;
  let privateDir;
  let snapshotPath;
  let directoryStat;
  const assertPrivateDirectory = () => {
    const current = checkedPath(privateDir, true);
    if (current.dev !== directoryStat.dev || current.ino !== directoryStat.ino) throw failure();
  };
  const cleanup = async () => {
    try { await source?.close(); } finally {
      source = null;
      try { await snapshot?.close(); } finally {
        snapshot = null;
        if (privateDir) {
          assertPrivateDirectory();
          // Only our fixed file and empty request directory; never recursively remove a shared root.
          if (snapshotPath) await fs.promises.unlink(snapshotPath).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
          });
          await fs.promises.rmdir(privateDir);
          privateDir = null;
        }
      }
    }
  };
  try {
    signal?.throwIfAborted();
    checkedPath(ctx.storageRoot, true);
    const local = initial.localPath;
    if (typeof local !== 'string' || !local || !initial.mime
      || path.isAbsolute(local) || path.win32.isAbsolute(local)
      || local.includes(':') || local.split(/[\\/]/).some((part) => part === '..' || part === '.')) throw failure();
    const sourcePath = path.resolve(ctx.storageRoot, local);
    if (!inside(ctx.storageRoot, sourcePath)) throw failure();
    const before = checkedPath(sourcePath, false);
    if (before.size <= 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw failure();
    source = await fs.promises.open(sourcePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const assertSource = async () => {
      const handleStat = await source.stat({ bigint: true });
      if (!handleStat.isFile() || !sameStat(before, handleStat)
        || !sameStat(before, checkedPath(sourcePath, false))) throw failure();
    };
    await assertSource();
    signal?.throwIfAborted();
    const tempRoot = ctx.tempRoot || os.tmpdir();
    if (!path.isAbsolute(tempRoot)) throw failure();
    await fs.promises.mkdir(tempRoot, { recursive: true, mode: 0o700 });
    checkedPath(tempRoot, true);
    if (samePath(ctx.storageRoot, tempRoot) || inside(ctx.storageRoot, tempRoot)) throw failure();
    privateDir = await fs.promises.mkdtemp(path.join(tempRoot, 'source-video-'));
    directoryStat = checkedPath(privateDir, true);
    privateStat(directoryStat, 0o077);
    snapshotPath = path.join(privateDir, 'source.snapshot');
    snapshot = await fs.promises.open(snapshotPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0), 0o600);
    const openedSnapshot = await snapshot.stat({ bigint: true });
    if (!sameStat(openedSnapshot, checkedPath(snapshotPath, false))) throw failure();
    privateStat(openedSnapshot, 0o077);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const hash = crypto.createHash('sha256');
    let copied = 0;
    while (copied < Number(before.size)) {
      signal?.throwIfAborted();
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, Number(before.size) - copied), copied);
      signal?.throwIfAborted();
      if (bytesRead === 0) throw failure();
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        signal?.throwIfAborted();
        const { bytesWritten } = await snapshot.write(buffer, written, bytesRead - written, copied + written);
        if (bytesWritten <= 0) throw failure();
        written += bytesWritten;
      }
      copied += bytesRead;
    }
    await assertSource();
    const digest = hash.digest('hex');
    if (digest !== initial.sha256 || (initial.size !== null && copied !== initial.size)) throw failure();
    const copiedStat = await snapshot.stat({ bigint: true });
    if (copiedStat.size !== BigInt(copied) || copiedStat.dev !== openedSnapshot.dev
      || copiedStat.ino !== openedSnapshot.ino || !sameStat(copiedStat, checkedPath(snapshotPath, false))) throw failure();
    await source.close();
    source = null;
    signal?.throwIfAborted();
    const assertCurrentBinding = () => {
      signal?.throwIfAborted();
      if (JSON.stringify(binding(ctx.db, input)) !== JSON.stringify(initial)) throw failure('CONFLICT');
    };
    assertCurrentBinding();
    return {
      sha256: digest, size: copied, mime: initial.mime, assertCurrentBinding,
      createReadStream: () => snapshot.createReadStream({ start: 0, autoClose: false }),
      cleanup,
      path: snapshotPath, directory: privateDir, assertPrivateDirectory,
      assertSnapshot: () => {
        assertPrivateDirectory();
        if (!sameStat(copiedStat, fs.fstatSync(snapshot.fd, { bigint: true }))
          || !sameStat(copiedStat, checkedPath(snapshotPath, false))) throw failure();
      },
      assertSourceUnchanged: () => {
        try { if (!sameStat(before, checkedPath(sourcePath, false))) throw failure('CONFLICT'); }
        catch { throw failure('CONFLICT'); }
      },
    };
  } catch (error) {
    await cleanup();
    if (signal?.aborted) throw signal.reason;
    if (String(error.code).startsWith('REDRAW_SOURCE_VIDEO_')) throw error;
    throw Object.defineProperty(failure(), 'cause', { value: error });
  }
}

async function prepareSourceVideo(ctx, input) {
  const snapshot = await prepareSnapshot(ctx, input);
  return {
    sha256: snapshot.sha256, size: snapshot.size, mime: snapshot.mime,
    assertCurrentBinding: snapshot.assertCurrentBinding,
    createReadStream: snapshot.createReadStream, cleanup: snapshot.cleanup,
  };
}

// Internal callback scope: only trusted server-side media consumers receive the private path.
async function withSourceVideoSnapshot(ctx, input, consume) {
  if (typeof consume !== 'function') throw failure('INPUT_INVALID');
  const snapshot = await prepareSnapshot(ctx, input);
  let active = true, failed = false;
  const streams = new Set();
  const assertActive = () => {
    if (!active) throw failure('EXPIRED');
  };
  const assertCurrent = () => {
    assertActive();
    snapshot.assertCurrentBinding();
    snapshot.assertSnapshot();
    snapshot.assertSourceUnchanged();
  };
  try {
    assertCurrent();
    const result = await consume({
      path: snapshot.path, directory: snapshot.directory, mime: snapshot.mime,
      sha256: snapshot.sha256, size: snapshot.size,
      createReadStream: () => {
        assertCurrent();
        const stream = snapshot.createReadStream();
        streams.add(stream); stream.once('close', () => streams.delete(stream)); return stream;
      },
      assertCurrentBinding: assertCurrent,
      assertSnapshot: () => { assertActive(); snapshot.assertSnapshot(); },
      assertSourceUnchanged: () => { assertActive(); snapshot.assertSourceUnchanged(); },
      assertPrivateDirectory: () => { assertActive(); snapshot.assertPrivateDirectory(); },
    });
    assertCurrent();
    return result;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    active = false;
    for (const stream of streams) stream.destroy();
    try { await snapshot.cleanup(); } catch (error) {
      if (!failed) throw Object.assign(failure('CLEANUP_FAILED'), {
        cleanup_code: ['EIO', 'EACCES', 'EPERM', 'EBUSY', 'ENOTEMPTY', 'ENOENT', 'EBADF'].includes(error?.code) ? error.code : 'UNAVAILABLE',
      });
    }
  }
}

function motionFailure(kind = 'UNAVAILABLE') {
  return Object.assign(new Error(`REDRAW_MOTION_DRAFT_${kind}`), { code: `REDRAW_MOTION_DRAFT_${kind}` });
}

function motionBinding(db, input) {
  const row = db.prepare(`SELECT s.id, s.work_id AS shot_work_id, s.version_id,
      s.start_ms, s.end_ms, s.duration_ms, s.updated_at,
      v.updated_at AS version_updated_at, w.id AS work_id, w.updated_at AS work_updated_at,
      w.source_asset_id, w.source_fingerprint, w.duration_ms AS source_duration_ms,
      a.width, a.height, a.duration, a.file_size, a.metadata, a.local_path,
      a.type, a.category, a.updated_at AS asset_updated_at
    FROM redraw_shots s JOIN redraw_versions v ON v.id = s.version_id
      AND v.tenant_id = s.tenant_id AND v.user_id = s.user_id AND v.deleted_at IS NULL
    JOIN redraw_works w ON w.id = v.work_id
      AND w.tenant_id = s.tenant_id AND w.user_id = s.user_id AND w.deleted_at IS NULL
    JOIN assets a ON a.id = w.source_asset_id AND a.deleted_at IS NULL
    JOIN tenant_members m ON m.tenant_id = s.tenant_id AND m.user_id = s.user_id AND m.status = 'active'
    JOIN tenants t ON t.id = m.tenant_id AND t.status = 'active'
    WHERE s.id = ? AND s.tenant_id = ? AND s.user_id = ? AND s.deleted_at IS NULL`)
    .get(Number(input.shotId), input.tenantId, input.userId);
  if (!row || (row.shot_work_id !== '' && (
    typeof row.shot_work_id !== 'string' || row.shot_work_id.trim() !== row.shot_work_id
    || !/^[1-9]\d*(?:\.0)?$/.test(row.shot_work_id)
    || !Number.isSafeInteger(Number(row.shot_work_id))
    || Number(row.shot_work_id) !== row.work_id))) throw motionFailure('NOT_FOUND');
  let metadata;
  try { metadata = JSON.parse(row.metadata); } catch { throw motionFailure(); }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw motionFailure();
  if (metadata.tenant_id !== input.tenantId || metadata.user_id !== input.userId) throw motionFailure('NOT_FOUND');
  if (row.updated_at !== input.expectedUpdatedAt || row.source_fingerprint !== input.expectedSourceSha256) {
    throw motionFailure('CONFLICT');
  }
  if (!Number.isSafeInteger(row.width) || row.width <= 0
    || !Number.isSafeInteger(row.height) || row.height <= 0
    || !Number.isSafeInteger(row.start_ms) || row.start_ms < 0
    || !Number.isSafeInteger(row.end_ms) || row.end_ms <= row.start_ms
    || row.duration_ms !== row.end_ms - row.start_ms) throw motionFailure();
  return row;
}

async function prepareMotionReferenceDraft(ctx, input) {
  if (!positiveId(input.shotId) || typeof input.expectedUpdatedAt !== 'string'
    || !input.expectedUpdatedAt || input.expectedUpdatedAt.trim() !== input.expectedUpdatedAt
    || /[\x00-\x1f\x7f]/.test(input.expectedUpdatedAt)
    || typeof input.expectedSourceSha256 !== 'string' || !SHA256.test(input.expectedSourceSha256)) {
    throw motionFailure('INPUT_INVALID');
  }
  const initial = motionBinding(ctx.db, input);
  let snapshot;
  let output;
  let outputPath;
  let outputStat;
  const cleanup = async () => {
    try { await output?.close(); } finally {
      output = null;
      try {
        if (outputPath) {
          snapshot.assertPrivateDirectory();
          await fs.promises.unlink(outputPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
          outputPath = null;
        }
      } finally { await snapshot?.cleanup(); }
    }
  };
  const assertCurrentBinding = () => {
    ctx.signal?.throwIfAborted();
    if (JSON.stringify(motionBinding(ctx.db, input)) !== JSON.stringify(initial)) throw motionFailure('CONFLICT');
    snapshot.assertCurrentBinding();
    snapshot.assertSnapshot();
    snapshot.assertSourceUnchanged();
    if (outputStat && (!sameStat(outputStat, fs.fstatSync(output.fd, { bigint: true }))
      || !sameStat(outputStat, checkedPath(outputPath, false)))) throw motionFailure();
  };
  try {
    snapshot = await prepareSnapshot(ctx, {
      tenantId: input.tenantId, userId: input.userId, workId: initial.work_id,
      expectedSourceAssetId: initial.source_asset_id, expectedSourceSha256: input.expectedSourceSha256,
    });
    assertCurrentBinding();
    const mediaInput = { execFile: ctx.execFile, signal: ctx.signal, videoOnly: true };
    const sourceProbe = await probeVideo(snapshot.path, mediaInput);
    if (sourceProbe.width !== initial.width || sourceProbe.height !== initial.height
      || Math.abs(sourceProbe.durationMs - initial.source_duration_ms) > 100
      || (initial.duration !== null && (!Number.isFinite(initial.duration) || initial.duration <= 0
        || Math.abs(sourceProbe.durationMs - initial.duration * 1000) > 100))
      || initial.end_ms > sourceProbe.durationMs) throw motionFailure();
    assertCurrentBinding();
    outputPath = path.join(snapshot.directory, 'motion-draft.mp4');
    output = await fs.promises.open(outputPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0), 0o600);
    const opened = await output.stat({ bigint: true });
    privateStat(opened, 0o077);
    await generateSegment(snapshot.path, outputPath, sourceProbe, {
      start_ms: initial.start_ms, end_ms: initial.end_ms, audio_mode: 'strip',
    }, mediaInput);
    outputStat = await output.stat({ bigint: true });
    if (!outputStat.isFile() || outputStat.dev !== opened.dev || outputStat.ino !== opened.ino
      || outputStat.size <= 0n || outputStat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw motionFailure();
    privateStat(outputStat, 0o077);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const hash = crypto.createHash('sha256');
    let position = 0;
    while (position < Number(outputStat.size)) {
      ctx.signal?.throwIfAborted();
      const { bytesRead } = await output.read(buffer, 0, Math.min(buffer.length, Number(outputStat.size) - position), position);
      if (!bytesRead) throw motionFailure();
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    assertCurrentBinding();
    return {
      mime: 'video/mp4', size: position, sha256: hash.digest('hex'), assertCurrentBinding,
      createReadStream: () => output.createReadStream({ start: 0, autoClose: false }), cleanup,
    };
  } catch (error) {
    await cleanup();
    if (ctx.signal?.aborted) throw ctx.signal.reason;
    if (String(error.code).startsWith('REDRAW_MOTION_DRAFT_')) throw error;
    if (String(error.code).startsWith('REDRAW_SOURCE_VIDEO_')) {
      throw motionFailure(error.code.slice('REDRAW_SOURCE_VIDEO_'.length));
    }
    throw motionFailure();
  }
}

module.exports = { prepareSourceVideo, prepareMotionReferenceDraft, withSourceVideoSnapshot };
