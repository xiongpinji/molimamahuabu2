const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const realAssetService = require('./assetService');
const { getFfmpegPath } = require('../utils/ffmpegPath');

const execFileAsync = promisify(execFile);
const SCHEMA_VERSION = 'redraw-source-audio-evidence-v1';
const INPUT_KEYS = ['sourceAssetId', 'tenantId', 'userId', 'workId'];
const EMPTY_TRANSCRIPT_SHA256 = sha256Text('[]');

async function analyzeSourceAudio(ctx = {}, input = {}) {
  const parsed = parseInput(input);
  const db = ctx.db;
  if (!db || typeof db.prepare !== 'function') throw codedError('SOURCE_AUDIO_DB_REQUIRED');
  const fsApi = ctx.fs || fs;
  const storageRoot = resolveDirectoryRoot(
    fsApi,
    ctx.storageRoot,
    'SOURCE_AUDIO_STORAGE_ROOT_INVALID',
  );
  const privateAudioRoot = resolvePrivateRoot(
    fsApi,
    ctx.privateAudioRoot || process.env.REDRAW_NATIVE_AUDIO_PRIVATE_TEMP_ROOT,
  );
  if (isInside(storageRoot, privateAudioRoot) || isInside(privateAudioRoot, storageRoot)) {
    throw codedError('SOURCE_AUDIO_PRIVATE_ROOT_INVALID');
  }

  const work = getOwnedWork(db, parsed);
  if (Number(work.source_asset_id) !== parsed.sourceAssetId) {
    throw codedError('SOURCE_AUDIO_SOURCE_ASSET_MISMATCH');
  }
  const assetService = ctx.assetService || realAssetService;
  const lookup = ctx.assetLookup || ((assetId) => assetService.getById(db, assetId));
  const sourceAsset = await lookup(parsed.sourceAssetId);
  assertSourceAsset(sourceAsset, parsed);
  const sourceFile = resolveSourcePath(fsApi, storageRoot, sourceAsset.local_path);
  const expectedSourceHashes = sourceHashBindings(work, sourceAsset);

  const taskId = safeGeneratedId((ctx.idFactory || crypto.randomUUID)());
  const wavId = safeGeneratedId((ctx.idFactory || crypto.randomUUID)());
  const tempDir = path.join(privateAudioRoot, `source-audio-${taskId}`);
  const sourceSnapshotPath = path.join(tempDir, `source-${taskId}.bin`);
  const wavPath = path.join(tempDir, `${wavId}.wav`);
  try {
    fsApi.mkdirSync(tempDir, { mode: 0o700 });
  } catch {
    throw codedError('SOURCE_AUDIO_PRIVATE_ROOT_INVALID');
  }

  try {
    assertContainedDirectory(fsApi, tempDir, privateAudioRoot, 'SOURCE_AUDIO_PRIVATE_ROOT_INVALID', true);
    const sourceSnapshot = snapshotSourceFile(fsApi, sourceFile, sourceSnapshotPath, tempDir);
    assertSourceHashBindings(expectedSourceHashes, sourceSnapshot.sha256, sourceSnapshot.size);
    createPrivateFile(fsApi, wavPath, tempDir);
    let workerEvidence = null;
    let silent = false;
    try {
      await (ctx.execFile || execFileAsync)(ctx.ffmpegPath || getFfmpegPath(), [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', sourceSnapshot.path,
        '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
        wavPath,
      ], {
        shell: false,
        windowsHide: true,
        timeout: Number(ctx.ffmpegTimeoutMs || 180_000),
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      if (isNoAudioStream(error)) silent = true;
      else throw codedError('SOURCE_AUDIO_EXTRACTION_FAILED');
    }

    if (!silent) {
      assertExtractedWav(fsApi, wavPath, privateAudioRoot);
      const audioSha256 = await sha256File(fsApi, wavPath);
      workerEvidence = await invokeWorkerOnce(ctx.workerClient, {
        requestId: taskId,
        audioPath: wavPath,
        audioSha256,
        privateAudioRoot,
      });
      workerEvidence = normalizeWorkerEvidence(workerEvidence, audioSha256, taskId);
    }

    const evidence = buildEvidence({
      parsed,
      sourceVideoSha256: sourceSnapshot.sha256,
      taskId,
      workerEvidence,
      now: resolveNow(ctx.now),
    });
    return persistEvidence({
      assetService,
      ctx,
      db,
      evidence,
      fsApi,
      storageRoot,
      taskId,
    });
  } finally {
    cleanupPrivateTaskDirectory(fsApi, privateAudioRoot, tempDir);
  }
}

function parseInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !sameKeys(input, INPUT_KEYS)
    || !isPositiveInteger(input.workId)
    || !isPositiveInteger(input.sourceAssetId)
    || !validOwnerPart(input.tenantId)
    || !validOwnerPart(input.userId)) {
    throw codedError('SOURCE_AUDIO_INPUT_INVALID');
  }
  return {
    workId: Number(input.workId),
    sourceAssetId: Number(input.sourceAssetId),
    tenantId: input.tenantId.trim(),
    userId: input.userId.trim(),
  };
}

function getOwnedWork(db, input) {
  const work = db.prepare(`
    SELECT id, tenant_id, user_id, source_asset_id, source_fingerprint
    FROM redraw_works
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(input.workId, input.tenantId, input.userId);
  if (!work) throw codedError('SOURCE_AUDIO_WORK_NOT_FOUND');
  return work;
}

function assertSourceAsset(asset, input) {
  const metadata = parseMetadata(asset?.metadata);
  if (!asset
    || Number(asset.id) !== input.sourceAssetId
    || asset.type !== 'video'
    || asset.category !== 'redraw_source'
    || metadata.tenant_id !== input.tenantId
    || metadata.user_id !== input.userId) {
    throw codedError('SOURCE_AUDIO_SOURCE_ASSET_INVALID');
  }
}

function sourceHashBindings(work, sourceAsset) {
  const metadata = parseMetadata(sourceAsset.metadata);
  return {
    work: normalizeOptionalSha256(
      work.source_fingerprint,
      'SOURCE_AUDIO_SOURCE_FINGERPRINT_INVALID',
    ),
    asset: [
      sourceAsset.sha256,
      sourceAsset.source_fingerprint,
      metadata.sha256,
      metadata.source_fingerprint,
    ].map((value) => normalizeOptionalSha256(value, 'SOURCE_AUDIO_SOURCE_ASSET_HASH_INVALID'))
      .filter(Boolean),
    assetSize: normalizeOptionalFileSize(sourceAsset.file_size),
  };
}

function normalizeOptionalSha256(value, code) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (!/^[0-9a-f]{64}$/i.test(text)) throw codedError(code);
  return text.toLowerCase();
}

function normalizeOptionalFileSize(value) {
  if (value == null || value === '') return null;
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw codedError('SOURCE_AUDIO_SOURCE_ASSET_SIZE_INVALID');
  }
  return size;
}

function assertSourceHashBindings(bindings, snapshotSha256, snapshotSize) {
  if (bindings.work && bindings.work !== snapshotSha256) {
    throw codedError('SOURCE_AUDIO_SOURCE_FINGERPRINT_INVALID');
  }
  if (bindings.asset.some((value) => value !== snapshotSha256)) {
    throw codedError('SOURCE_AUDIO_SOURCE_ASSET_HASH_INVALID');
  }
  if (bindings.assetSize != null && bindings.assetSize !== snapshotSize) {
    throw codedError('SOURCE_AUDIO_SOURCE_ASSET_SIZE_INVALID');
  }
}

function resolveDirectoryRoot(fsApi, value, code) {
  try {
    if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) throw new Error(code);
    const resolved = path.resolve(value);
    return assertDirectoryAtPath(fsApi, resolved, code);
  } catch {
    throw codedError(code);
  }
}

function resolvePrivateRoot(fsApi, value) {
  const code = 'SOURCE_AUDIO_PRIVATE_ROOT_INVALID';
  try {
    if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) throw new Error(code);
    const resolved = path.resolve(value);
    fsApi.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    const real = assertDirectoryAtPath(fsApi, resolved, code);
    assertPrivateOwnership(fsApi.statSync(real), code, 0o022);
    return real;
  } catch {
    throw codedError(code);
  }
}

function assertDirectoryAtPath(fsApi, value, code) {
  const resolved = path.resolve(value);
  const inputStat = fsApi.lstatSync(resolved);
  const real = fsApi.realpathSync.native(resolved);
  const stat = fsApi.statSync(real);
  if (inputStat.isSymbolicLink() || !stat.isDirectory() || !samePath(resolved, real)) {
    throw codedError(code);
  }
  return real;
}

function assertContainedDirectory(fsApi, value, parent, code, privateAccess) {
  const parentReal = assertDirectoryAtPath(fsApi, parent, code);
  const real = assertDirectoryAtPath(fsApi, value, code);
  if (!isStrictlyInside(parentReal, real)) throw codedError(code);
  if (privateAccess) assertPrivateOwnership(fsApi.statSync(real), code, 0o022);
  return real;
}

function assertContainedFile(fsApi, value, parent, code, privateAccess) {
  const parentReal = assertDirectoryAtPath(fsApi, parent, code);
  const resolved = path.resolve(value);
  const inputStat = fsApi.lstatSync(resolved);
  const real = fsApi.realpathSync.native(resolved);
  const stat = fsApi.statSync(real);
  if (inputStat.isSymbolicLink()
    || !stat.isFile()
    || !samePath(resolved, real)
    || !isStrictlyInside(parentReal, real)) {
    throw codedError(code);
  }
  if (privateAccess) assertPrivateOwnership(stat, code, 0o077);
  return real;
}

function assertPrivateOwnership(stat, code, forbiddenMode) {
  if (typeof process.getuid !== 'function') return;
  if (stat.uid !== process.getuid() || (stat.mode & forbiddenMode) !== 0) {
    throw codedError(code);
  }
}

function createPrivateFile(fsApi, filePath, privateTaskDir) {
  let descriptor;
  try {
    descriptor = fsApi.openSync(filePath, 'wx', 0o600);
  } catch {
    throw codedError('SOURCE_AUDIO_PRIVATE_ROOT_INVALID');
  } finally {
    if (descriptor !== undefined) fsApi.closeSync(descriptor);
  }
  assertContainedFile(fsApi, filePath, privateTaskDir, 'SOURCE_AUDIO_PRIVATE_ROOT_INVALID', true);
}

function snapshotSourceFile(fsApi, sourceFile, snapshotPath, privateTaskDir) {
  let sourceDescriptor;
  let snapshotDescriptor;
  let sourceBefore;
  let copiedBytes = 0;
  const hash = crypto.createHash('sha256');
  try {
    sourceDescriptor = fsApi.openSync(sourceFile.path, 'r');
    sourceBefore = fsApi.fstatSync(sourceDescriptor);
    assertOpenedSource(fsApi, sourceFile, sourceDescriptor, sourceBefore);
    snapshotDescriptor = fsApi.openSync(snapshotPath, 'wx', 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const readBytes = fsApi.readSync(sourceDescriptor, buffer, 0, buffer.length, null);
      if (readBytes === 0) break;
      hash.update(buffer.subarray(0, readBytes));
      writeAll(fsApi, snapshotDescriptor, buffer, readBytes);
      copiedBytes += readBytes;
    }
    if (typeof fsApi.fsyncSync === 'function') fsApi.fsyncSync(snapshotDescriptor);
    const sourceAfter = fsApi.fstatSync(sourceDescriptor);
    if (!sameFileStat(sourceBefore, sourceAfter) || copiedBytes !== sourceBefore.size) {
      throw new Error('source changed while copying');
    }
    assertOpenedSource(fsApi, sourceFile, sourceDescriptor, sourceAfter);
    fsApi.closeSync(snapshotDescriptor);
    snapshotDescriptor = undefined;
    fsApi.closeSync(sourceDescriptor);
    sourceDescriptor = undefined;
    const snapshotReal = assertContainedFile(
      fsApi,
      snapshotPath,
      privateTaskDir,
      'SOURCE_AUDIO_SOURCE_SNAPSHOT_FAILED',
      true,
    );
    if (fsApi.statSync(snapshotReal).size !== copiedBytes) {
      throw new Error('snapshot size changed');
    }
    return { path: snapshotReal, sha256: hash.digest('hex'), size: copiedBytes };
  } catch {
    throw codedError('SOURCE_AUDIO_SOURCE_SNAPSHOT_FAILED');
  } finally {
    closeQuietly(fsApi, snapshotDescriptor);
    closeQuietly(fsApi, sourceDescriptor);
  }
}

function assertOpenedSource(fsApi, sourceFile, descriptor, handleStat) {
  const inputStat = fsApi.lstatSync(sourceFile.path);
  const real = fsApi.realpathSync.native(sourceFile.path);
  const pathStat = fsApi.statSync(real);
  const descriptorStat = fsApi.fstatSync(descriptor);
  if (inputStat.isSymbolicLink()
    || !handleStat.isFile()
    || !descriptorStat.isFile()
    || !pathStat.isFile()
    || !samePath(real, sourceFile.path)
    || !isStrictlyInside(sourceFile.storageRoot, real)
    || !sameFileStat(sourceFile.stat, pathStat)
    || !sameFileStat(handleStat, descriptorStat)
    || !sameFileStat(pathStat, descriptorStat)) {
    throw new Error('source binding changed');
  }
}

function writeAll(fsApi, descriptor, buffer, byteLength) {
  let offset = 0;
  while (offset < byteLength) {
    const written = fsApi.writeSync(descriptor, buffer, offset, byteLength - offset, null);
    if (!Number.isSafeInteger(written) || written <= 0) throw new Error('snapshot write failed');
    offset += written;
  }
}

function sameFileStat(left, right) {
  return Boolean(left)
    && Boolean(right)
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function closeQuietly(fsApi, descriptor) {
  if (descriptor === undefined) return;
  try {
    fsApi.closeSync(descriptor);
  } catch {
    // Preserve the stable snapshot failure while the task directory cleanup runs.
  }
}

function createContainedDirectory(fsApi, directory, parent, allowExisting) {
  const code = 'SOURCE_AUDIO_EVIDENCE_PATH_INVALID';
  try {
    assertDirectoryAtPath(fsApi, parent, code);
    try {
      fsApi.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (!allowExisting || error?.code !== 'EEXIST') throw error;
    }
    return assertContainedDirectory(fsApi, directory, parent, code, false);
  } catch {
    throw codedError(code);
  }
}

function assertEvidenceDirectoryChain(fsApi, storageRoot, parentDir, outputDir) {
  const code = 'SOURCE_AUDIO_EVIDENCE_PATH_INVALID';
  assertDirectoryAtPath(fsApi, storageRoot, code);
  assertContainedDirectory(fsApi, parentDir, storageRoot, code, false);
  assertContainedDirectory(fsApi, outputDir, parentDir, code, false);
}

function cleanupPrivateTaskDirectory(fsApi, privateAudioRoot, tempDir) {
  if (!fsApi.existsSync(tempDir)) return;
  try {
    assertDirectoryAtPath(fsApi, privateAudioRoot, 'SOURCE_AUDIO_PRIVATE_CLEANUP_FAILED');
    assertContainedDirectory(
      fsApi,
      tempDir,
      privateAudioRoot,
      'SOURCE_AUDIO_PRIVATE_CLEANUP_FAILED',
      false,
    );
    fsApi.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    throw codedError('SOURCE_AUDIO_PRIVATE_CLEANUP_FAILED');
  }
}

function cleanupContainedFile(fsApi, parent, filePath) {
  if (!fsApi.existsSync(filePath)) return;
  try {
    assertContainedFile(fsApi, filePath, parent, 'SOURCE_AUDIO_EVIDENCE_PATH_INVALID', false);
    fsApi.rmSync(filePath, { force: true });
  } catch {
    // Refuse to follow or remove a path whose containment cannot be proven.
  }
}

function cleanupEvidenceOutput(fsApi, storageRoot, parentDir, outputDir) {
  if (!fsApi.existsSync(outputDir)) return;
  try {
    assertDirectoryAtPath(fsApi, storageRoot, 'SOURCE_AUDIO_EVIDENCE_PATH_INVALID');
    assertContainedDirectory(
      fsApi,
      parentDir,
      storageRoot,
      'SOURCE_AUDIO_EVIDENCE_PATH_INVALID',
      false,
    );
    assertContainedDirectory(
      fsApi,
      outputDir,
      parentDir,
      'SOURCE_AUDIO_EVIDENCE_PATH_INVALID',
      false,
    );
    fsApi.rmSync(outputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // Fail closed instead of recursively deleting through an untrusted path.
  }
}

function resolveSourcePath(fsApi, storageRoot, localPath) {
  try {
    const raw = String(localPath || '');
    if (!raw || path.isAbsolute(raw)) throw new Error('relative source path required');
    const candidate = path.resolve(storageRoot, path.normalize(raw));
    const relative = path.relative(storageRoot, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('source path escaped');
    const inputStat = fsApi.lstatSync(candidate);
    const real = fsApi.realpathSync.native(candidate);
    const stat = fsApi.statSync(real);
    if (inputStat.isSymbolicLink()
      || !stat.isFile()
      || !samePath(candidate, real)
      || !isStrictlyInside(storageRoot, real)) {
      throw new Error('source path escaped');
    }
    fsApi.accessSync(real, fs.constants.R_OK);
    return { path: real, stat, storageRoot };
  } catch {
    throw codedError('SOURCE_AUDIO_SOURCE_PATH_INVALID');
  }
}

function assertExtractedWav(fsApi, wavPath, privateAudioRoot) {
  try {
    const real = assertContainedFile(
      fsApi,
      wavPath,
      privateAudioRoot,
      'SOURCE_AUDIO_EXTRACTION_FAILED',
      true,
    );
    if (fsApi.statSync(real).size <= 0 || path.extname(real).toLowerCase() !== '.wav') {
      throw new Error('invalid WAV');
    }
  } catch {
    throw codedError('SOURCE_AUDIO_EXTRACTION_FAILED');
  }
}

async function invokeWorkerOnce(workerClient, request) {
  if (!workerClient || typeof workerClient.analyzeSourceAudio !== 'function') {
    throw codedError('SOURCE_AUDIO_WORKER_UNAVAILABLE');
  }
  try {
    return await workerClient.analyzeSourceAudio(request);
  } catch (error) {
    const code = String(error?.code || '');
    if (code === 'SOURCE_AUDIO_RESULT_UNKNOWN'
      || /(?:TIMEOUT|CONNECTION|CLOSED|ABORTED|RESPONSE_(?:TOO_LARGE|INVALID_JSON))/.test(code)) {
      throw codedError('SOURCE_AUDIO_RESULT_UNKNOWN');
    }
    throw codedError('SOURCE_AUDIO_ANALYSIS_FAILED');
  }
}

function normalizeWorkerEvidence(value, audioSha256, requestId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || containsAbsolutePath(value)
    || value.requestId !== requestId
    || value.audioSha256 !== audioSha256
    || !isSha256(value.transcriptSha256)
    || !validOwnerPart(value.sourceLanguage)
    || !isProbability(value.languageProbability)
    || !Array.isArray(value.segments)
    || value.segments.length === 0
    || value.segments.length > 4096) {
    throw codedError('SOURCE_AUDIO_EVIDENCE_INVALID');
  }
  let previousEnd = 0;
  const segments = value.segments.map((segment) => {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)
      || !Number.isSafeInteger(segment.startMs)
      || !Number.isSafeInteger(segment.endMs)
      || segment.startMs < previousEnd
      || segment.endMs <= segment.startMs
      || !validText(segment.text)
      || !/^speaker-cluster-[1-9][0-9]*$/.test(String(segment.speakerClusterId || ''))) {
      throw codedError('SOURCE_AUDIO_EVIDENCE_INVALID');
    }
    previousEnd = segment.endMs;
    return {
      start_ms: segment.startMs,
      end_ms: segment.endMs,
      source_text: segment.text.trim(),
      speaker_cluster_id: segment.speakerClusterId,
    };
  });
  return {
    source_language: value.sourceLanguage,
    language_probability: value.languageProbability,
    audio_sha256: value.audioSha256,
    transcript_sha256: value.transcriptSha256,
    segments,
  };
}

function buildEvidence({ parsed, sourceVideoSha256, taskId, workerEvidence, now }) {
  return {
    schema_version: SCHEMA_VERSION,
    task_id: taskId,
    work_id: parsed.workId,
    tenant_id: parsed.tenantId,
    user_id: parsed.userId,
    source_asset_id: parsed.sourceAssetId,
    source_video_sha256: sourceVideoSha256,
    audio_sha256: workerEvidence?.audio_sha256 || null,
    transcript_sha256: workerEvidence?.transcript_sha256 || EMPTY_TRANSCRIPT_SHA256,
    source_language: workerEvidence?.source_language || null,
    language_probability: workerEvidence?.language_probability ?? null,
    dialogue_mode: workerEvidence ? 'spoken' : 'silent',
    segments: workerEvidence?.segments || [],
    created_at: now,
  };
}

function persistEvidence({ assetService, ctx, db, evidence, fsApi, storageRoot, taskId }) {
  const parentDir = path.join(storageRoot, 'redraw-source-audio-evidence');
  const outputDir = path.join(parentDir, taskId);
  const outputPath = path.join(outputDir, 'audio-evidence.json');
  try {
    createContainedDirectory(fsApi, parentDir, storageRoot, true);
    createContainedDirectory(fsApi, outputDir, parentDir, false);
    atomicWriteJson({
      fsApi,
      storageRoot,
      parentDir,
      outputDir,
      outputPath,
      payload: evidence,
      rawId: (ctx.idFactory || crypto.randomUUID)(),
    });
    const evidenceSha256 = sha256Bytes(fsApi.readFileSync(outputPath));
    const stat = fsApi.statSync(outputPath);
    const asset = assetService.create(db, ctx.log || {}, {
      name: `母本音频证据 ${evidence.work_id}`,
      type: 'json',
      category: 'redraw_source_audio_evidence',
      local_path: path.relative(storageRoot, outputPath).replace(/\\/g, '/'),
      file_size: stat.size,
      mime_type: 'application/json',
      metadata: {
        schema_version: SCHEMA_VERSION,
        tenant_id: evidence.tenant_id,
        user_id: evidence.user_id,
        work_id: evidence.work_id,
        source_asset_id: evidence.source_asset_id,
        source_video_sha256: evidence.source_video_sha256,
        audio_sha256: evidence.audio_sha256,
        transcript_sha256: evidence.transcript_sha256,
        evidence_sha256: evidenceSha256,
      },
    });
    if (!asset || !isPositiveInteger(asset.id)) throw codedError('SOURCE_AUDIO_ASSET_REGISTRATION_FAILED');
    return {
      ...evidence,
      evidence_sha256: evidenceSha256,
      result_asset_id: Number(asset.id),
    };
  } catch (error) {
    cleanupEvidenceOutput(fsApi, storageRoot, parentDir, outputDir);
    if (error?.code === 'SOURCE_AUDIO_ASSET_REGISTRATION_FAILED') throw error;
    if (error?.code === 'SOURCE_AUDIO_EVIDENCE_PATH_INVALID') throw error;
    throw codedError('SOURCE_AUDIO_PERSISTENCE_FAILED');
  }
}

function atomicWriteJson({
  fsApi,
  storageRoot,
  parentDir,
  outputDir,
  outputPath,
  payload,
  rawId,
}) {
  const tempId = safeGeneratedId(rawId);
  const tempPath = path.join(path.dirname(outputPath), `.audio-evidence-${tempId}.tmp`);
  try {
    assertEvidenceDirectoryChain(fsApi, storageRoot, parentDir, outputDir);
    fsApi.writeFileSync(tempPath, JSON.stringify(payload, null, 2), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    assertContainedFile(fsApi, tempPath, outputDir, 'SOURCE_AUDIO_EVIDENCE_PATH_INVALID', false);
    assertEvidenceDirectoryChain(fsApi, storageRoot, parentDir, outputDir);
    fsApi.renameSync(tempPath, outputPath);
    assertEvidenceDirectoryChain(fsApi, storageRoot, parentDir, outputDir);
    assertContainedFile(fsApi, outputPath, outputDir, 'SOURCE_AUDIO_EVIDENCE_PATH_INVALID', false);
  } finally {
    cleanupContainedFile(fsApi, outputDir, tempPath);
  }
}

function parseMetadata(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isNoAudioStream(error) {
  if (error?.code === 'SOURCE_AUDIO_NO_AUDIO_STREAM') return true;
  const diagnostic = `${error?.stderr || ''}\n${error?.message || ''}`;
  return /(?:does not contain any stream|matches no streams|no audio stream|audio stream.*not found)/i.test(diagnostic);
}

function resolveNow(clock) {
  const value = typeof clock === 'function' ? clock() : new Date().toISOString();
  const text = value instanceof Date ? value.toISOString() : String(value || '');
  if (!text || !Number.isFinite(Date.parse(text))) throw codedError('SOURCE_AUDIO_CLOCK_INVALID');
  return text;
}

function safeGeneratedId(value) {
  const raw = String(value || '');
  if (!/^[a-zA-Z0-9-]{6,128}$/.test(raw)) throw codedError('SOURCE_AUDIO_ID_INVALID');
  return raw;
}

function sameKeys(value, expected) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function validOwnerPart(value) {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 128 && !value.includes('\0');
}

function validText(value) {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 16_384;
}

function isProbability(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isSha256(value) {
  return /^[0-9a-f]{64}$/.test(String(value || ''));
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isStrictlyInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function samePath(left, right) {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  if (process.platform === 'win32') {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

function containsAbsolutePath(value) {
  if (typeof value === 'string') {
    return path.win32.isAbsolute(value)
      || path.posix.isAbsolute(value)
      || /file:\/\//i.test(value)
      || /(?:^|\s)[a-z]:[\\/]/i.test(value)
      || /\\\\[^\\]+\\[^\\]+/.test(value);
  }
  if (Array.isArray(value)) return value.some(containsAbsolutePath);
  if (value && typeof value === 'object') return Object.values(value).some(containsAbsolutePath);
  return false;
}

async function sha256File(fsApi, filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fsApi.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256Text(value) {
  return sha256Bytes(Buffer.from(String(value), 'utf8'));
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

module.exports = {
  SCHEMA_VERSION,
  analyzeSourceAudio,
};
