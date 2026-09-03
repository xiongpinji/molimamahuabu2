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
  const storageRoot = resolveRoot(fsApi, ctx.storageRoot, 'SOURCE_AUDIO_STORAGE_ROOT_INVALID', false);
  const privateAudioRoot = resolveRoot(
    fsApi,
    ctx.privateAudioRoot || process.env.REDRAW_NATIVE_AUDIO_PRIVATE_TEMP_ROOT,
    'SOURCE_AUDIO_PRIVATE_ROOT_INVALID',
    true,
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
  const sourcePath = resolveSourcePath(fsApi, storageRoot, sourceAsset.local_path);
  const sourceVideoSha256 = await sha256File(fsApi, sourcePath);

  const taskId = safeGeneratedId((ctx.idFactory || crypto.randomUUID)());
  const wavId = safeGeneratedId((ctx.idFactory || crypto.randomUUID)());
  const tempDir = path.join(privateAudioRoot, `source-audio-${taskId}`);
  const wavPath = path.join(tempDir, `${wavId}.wav`);
  fsApi.mkdirSync(tempDir);

  try {
    let workerEvidence = null;
    let silent = false;
    try {
      await (ctx.execFile || execFileAsync)(ctx.ffmpegPath || getFfmpegPath(), [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', sourcePath,
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
      sourceVideoSha256,
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
    fsApi.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
    SELECT id, tenant_id, user_id, source_asset_id
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

function resolveRoot(fsApi, value, code, create) {
  try {
    if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) throw new Error(code);
    const resolved = path.resolve(value);
    if (create) fsApi.mkdirSync(resolved, { recursive: true });
    const real = fsApi.realpathSync.native(resolved);
    if (!fsApi.statSync(real).isDirectory()) throw new Error(code);
    return real;
  } catch {
    throw codedError(code);
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
    if (inputStat.isSymbolicLink()
      || !fsApi.statSync(real).isFile()
      || !isInside(storageRoot, real)) {
      throw new Error('source path escaped');
    }
    fsApi.accessSync(real, fs.constants.R_OK);
    return real;
  } catch {
    throw codedError('SOURCE_AUDIO_SOURCE_PATH_INVALID');
  }
}

function assertExtractedWav(fsApi, wavPath, privateAudioRoot) {
  try {
    const inputStat = fsApi.lstatSync(wavPath);
    const real = fsApi.realpathSync.native(wavPath);
    const stat = fsApi.statSync(real);
    if (inputStat.isSymbolicLink()
      || !stat.isFile()
      || stat.size <= 0
      || path.extname(real).toLowerCase() !== '.wav'
      || !isInside(privateAudioRoot, real)) {
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
  fsApi.mkdirSync(parentDir, { recursive: true });
  fsApi.mkdirSync(outputDir);
  try {
    atomicWriteJson(fsApi, outputPath, evidence, (ctx.idFactory || crypto.randomUUID)());
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
    fsApi.rmSync(outputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    if (error?.code === 'SOURCE_AUDIO_ASSET_REGISTRATION_FAILED') throw error;
    throw codedError('SOURCE_AUDIO_PERSISTENCE_FAILED');
  }
}

function atomicWriteJson(fsApi, outputPath, payload, rawId) {
  const tempId = safeGeneratedId(rawId);
  const tempPath = path.join(path.dirname(outputPath), `.audio-evidence-${tempId}.tmp`);
  try {
    fsApi.writeFileSync(tempPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', flag: 'wx' });
    fsApi.renameSync(tempPath, outputPath);
  } finally {
    fsApi.rmSync(tempPath, { force: true });
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
