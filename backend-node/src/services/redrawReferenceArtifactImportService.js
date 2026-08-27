'use strict';

const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const sharp = require('sharp');

const assetService = require('./assetService');
const { getFfprobePath } = require('../utils/ffmpegPath');
const {
  invalidateCharacterDependents,
} = require('./redrawDependencyInvalidationService');

const INPUT_INVALID_CODE = 'REDRAW_REFERENCE_ARTIFACT_INPUT_INVALID';
const NOT_FOUND_CODE = 'REDRAW_REFERENCE_ARTIFACT_NOT_FOUND';
const CONFLICT_CODE = 'REDRAW_REFERENCE_ARTIFACT_CONFLICT';
const IDEMPOTENCY_CONFLICT_CODE = 'REDRAW_REFERENCE_ARTIFACT_IDEMPOTENCY_CONFLICT';
const FORBIDDEN_FIELD_CODE = 'REDRAW_REFERENCE_ARTIFACT_FORBIDDEN_FIELD';
const MEDIA_INVALID_CODE = 'REDRAW_REFERENCE_ARTIFACT_MEDIA_INVALID';
const TOO_LARGE_CODE = 'REDRAW_REFERENCE_ARTIFACT_TOO_LARGE';
const STORAGE_FAILED_CODE = 'REDRAW_REFERENCE_ARTIFACT_STORAGE_FAILED';
const MOTION_REVIEW_REQUIRED_CODE = 'REDRAW_MOTION_REFERENCE_REVIEW_REQUIRED';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 4096;
const MAX_IMAGE_PIXELS = MAX_IMAGE_DIMENSION * MAX_IMAGE_DIMENSION;
const MAX_MOTION_BYTES = 200 * 1024 * 1024;
const MOTION_DURATION_TOLERANCE_MS = 100;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const execFileAsync = promisify(execFile);
const ALLOWED_INPUT_FIELDS = new Set([
  'assetId',
  'purpose',
  'expectedUpdatedAt',
  'idempotencyKey',
  'file',
]);
const CHARACTER_PURPOSES = new Set(['identity', 'wardrobe']);
const MOTION_INPUT_FIELDS = new Set([
  'shotId',
  'expectedUpdatedAt',
  'idempotencyKey',
  'fullFrameReviewed',
  'sourceIdentityObscured',
  'sourceTextObscured',
  'motionPreserved',
  'file',
]);
const IMAGE_TYPES = Object.freeze({
  'image/png': {
    format: 'png',
    extensions: new Set(['.png']),
    extension: 'png',
    matchesMagic(buffer) {
      return buffer.length >= 8
        && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    },
  },
  'image/jpeg': {
    format: 'jpeg',
    extensions: new Set(['.jpg', '.jpeg']),
    extension: 'jpg',
    matchesMagic(buffer) {
      return buffer.length >= 3
        && buffer[0] === 0xff
        && buffer[1] === 0xd8
        && buffer[2] === 0xff;
    },
  },
  'image/webp': {
    format: 'webp',
    extensions: new Set(['.webp']),
    extension: 'webp',
    matchesMagic(buffer) {
      return buffer.length >= 12
        && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
        && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
    },
  },
});

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function fail(code, message) {
  throw codedError(code, message);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseJson(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function normalizeContext(rawCtx) {
  const ctx = rawCtx && typeof rawCtx === 'object' ? rawCtx : {};
  const tenantId = String(ctx.tenantId ?? '').trim();
  const userId = String(ctx.userId ?? '').trim();
  const versionId = Number(ctx.versionId);
  const storageRoot = String(ctx.storageRoot ?? '').trim();
  if (!ctx.db || typeof ctx.db.prepare !== 'function'
    || !ctx.log || typeof ctx.log !== 'object'
    || !tenantId || !userId
    || !Number.isSafeInteger(versionId) || versionId <= 0
    || !storageRoot || !path.isAbsolute(storageRoot)) {
    fail(INPUT_INVALID_CODE, '参考素材导入上下文无效');
  }
  return {
    ...ctx,
    tenantId,
    userId,
    versionId,
    storageRoot: path.resolve(storageRoot),
  };
}

function inputKeys(input) {
  const keys = new Set();
  for (const key in input) keys.add(key);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string') fail(FORBIDDEN_FIELD_CODE, '参考素材导入包含禁止字段');
    keys.add(key);
  }
  return keys;
}

function normalizeInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    fail(INPUT_INVALID_CODE, '参考素材导入参数无效');
  }
  for (const key of inputKeys(rawInput)) {
    if (!ALLOWED_INPUT_FIELDS.has(key)) {
      fail(FORBIDDEN_FIELD_CODE, '参考素材导入包含禁止字段');
    }
  }
  const assetId = Number(rawInput.assetId);
  const purpose = String(rawInput.purpose ?? '').trim();
  const expectedUpdatedAt = String(rawInput.expectedUpdatedAt ?? '').trim();
  const idempotencyKey = String(rawInput.idempotencyKey ?? '').trim();
  if (!Number.isSafeInteger(assetId) || assetId <= 0
    || !CHARACTER_PURPOSES.has(purpose)
    || !expectedUpdatedAt || !idempotencyKey) {
    fail(INPUT_INVALID_CODE, '参考素材导入参数无效');
  }
  return {
    assetId,
    purpose,
    expectedUpdatedAt,
    idempotencyKey,
    file: rawInput.file,
  };
}

function readCharacter(ctx, assetId) {
  const row = ctx.db.prepare(`
    SELECT *
    FROM redraw_assets
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND version_id = ?
      AND kind = 'character' AND deleted_at IS NULL
  `).get(assetId, ctx.tenantId, ctx.userId, ctx.versionId);
  if (!row) fail(NOT_FOUND_CODE, '角色参考素材不存在');
  return row;
}

async function inspectImage(file) {
  if (!file || typeof file !== 'object' || !Buffer.isBuffer(file.buffer)) {
    fail(MEDIA_INVALID_CODE, '参考图片无效');
  }
  const declaredSize = Number(file.size);
  if ((Number.isFinite(declaredSize) && declaredSize > MAX_IMAGE_BYTES)
    || file.buffer.length > MAX_IMAGE_BYTES) {
    fail(TOO_LARGE_CODE, '参考图片超过大小限制');
  }
  if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0
    || declaredSize !== file.buffer.length) {
    fail(MEDIA_INVALID_CODE, '参考图片无效');
  }
  const mimetype = String(file.mimetype ?? '').trim().toLowerCase();
  const originalname = String(file.originalname ?? '').trim();
  const extension = path.extname(originalname).toLowerCase();
  const imageType = IMAGE_TYPES[mimetype];
  if (!originalname || !imageType || !imageType.extensions.has(extension)
    || !imageType.matchesMagic(file.buffer)) {
    fail(MEDIA_INVALID_CODE, '参考图片格式不一致');
  }

  let metadata;
  try {
    metadata = await sharp(file.buffer, {
      failOn: 'error',
      limitInputPixels: MAX_IMAGE_PIXELS,
    }).metadata();
  } catch (_) {
    fail(MEDIA_INVALID_CODE, '参考图片无法解码');
  }
  const width = Number(metadata.width);
  const height = Number(metadata.height);
  if (metadata.format !== imageType.format
    || !Number.isSafeInteger(width) || width <= 0
    || !Number.isSafeInteger(height) || height <= 0
    || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION
    || (width * height) > MAX_IMAGE_PIXELS) {
    fail(MEDIA_INVALID_CODE, '参考图片媒体信息无效');
  }
  let decoded;
  try {
    decoded = await sharp(file.buffer, {
      failOn: 'error',
      limitInputPixels: MAX_IMAGE_PIXELS,
    }).raw().toBuffer({ resolveWithObject: true });
  } catch (_) {
    fail(MEDIA_INVALID_CODE, '参考图片无法解码');
  }
  if (Number(decoded.info.width) !== width || Number(decoded.info.height) !== height) {
    fail(MEDIA_INVALID_CODE, '参考图片媒体信息无效');
  }
  return {
    buffer: file.buffer,
    fileSize: file.buffer.length,
    mimeType: mimetype,
    extension: imageType.extension,
    width,
    height,
    originalname: path.basename(originalname),
    fileSha256: sha256(file.buffer),
  };
}

function requestHash(ctx, input, fileSha256) {
  return sha256(stableJson({
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    version_id: ctx.versionId,
    scope_type: 'character',
    scope_id: input.assetId,
    purpose: input.purpose,
    expected_updated_at: input.expectedUpdatedAt,
    file_sha256: fileSha256,
  }));
}

function findImportRecord(ctx, input, idempotencyHash) {
  return ctx.db.prepare(`
    SELECT *
    FROM redraw_reference_artifact_imports
    WHERE tenant_id = ? AND user_id = ? AND version_id = ?
      AND scope_type = 'character' AND scope_id = ? AND purpose = ?
      AND idempotency_hash = ?
  `).get(
    ctx.tenantId,
    ctx.userId,
    ctx.versionId,
    input.assetId,
    input.purpose,
    idempotencyHash,
  );
}

function assetRelativePath(fileSha256, extension) {
  return `redraw-reference-artifacts/${fileSha256}.${extension}`;
}

function absoluteStoragePath(storageRoot, relativePath) {
  return path.join(storageRoot, ...relativePath.split('/'));
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function verifyStoredFile(filePath, expectedSha256) {
  let stat;
  try {
    stat = await fs.promises.lstat(filePath);
  } catch (_) {
    fail(STORAGE_FAILED_CODE, '参考素材存储校验失败');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(STORAGE_FAILED_CODE, '参考素材存储校验失败');
  }
  let actualSha256;
  try {
    actualSha256 = await hashFile(filePath);
  } catch (_) {
    fail(STORAGE_FAILED_CODE, '参考素材存储校验失败');
  }
  if (actualSha256 !== expectedSha256) {
    fail(STORAGE_FAILED_CODE, '参考素材存储校验失败');
  }
}

async function existingFile(filePath, expectedSha256) {
  try {
    await fs.promises.lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    fail(STORAGE_FAILED_CODE, '参考素材存储校验失败');
  }
  await verifyStoredFile(filePath, expectedSha256);
  return true;
}

async function storeImage(ctx, media) {
  const relativePath = assetRelativePath(media.fileSha256, media.extension);
  const finalPath = absoluteStoragePath(ctx.storageRoot, relativePath);
  const directory = path.dirname(finalPath);
  try {
    await fs.promises.mkdir(directory, { recursive: true });
  } catch (_) {
    fail(STORAGE_FAILED_CODE, '参考素材存储失败');
  }
  if (await existingFile(finalPath, media.fileSha256)) {
    return { relativePath, finalPath, created: false };
  }

  const tempPath = path.join(
    directory,
    `.${media.fileSha256}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let handle = null;
  let tempExists = false;
  let createdFinal = false;
  try {
    handle = await fs.promises.open(tempPath, 'wx', 0o600);
    tempExists = true;
    await handle.writeFile(media.buffer);
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await fs.promises.rename(tempPath, finalPath);
      tempExists = false;
      createdFinal = true;
      await verifyStoredFile(finalPath, media.fileSha256);
      return { relativePath, finalPath, created: true };
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
      await verifyStoredFile(finalPath, media.fileSha256);
      return { relativePath, finalPath, created: false };
    }
  } catch (error) {
    if (createdFinal) {
      try {
        await cleanupCreatedFile(ctx, { relativePath, finalPath, created: true });
      } catch (_) {
        // The caller still receives a redacted storage failure.
      }
    }
    if (error?.code === STORAGE_FAILED_CODE) throw error;
    fail(STORAGE_FAILED_CODE, '参考素材存储失败');
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (_) {
        // Preserve the original failure.
      }
    }
    if (tempExists) {
      try {
        await fs.promises.unlink(tempPath);
      } catch (_) {
        // The original storage error is more useful than a temp cleanup error.
      }
    }
  }
}

function currentTimestamp(ctx) {
  const supplied = typeof ctx.now === 'function' ? ctx.now() : ctx.now;
  const date = new Date(supplied ?? Date.now());
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function nextTimestamp(ctx, previousTimestamp) {
  const candidate = new Date(currentTimestamp(ctx)).getTime();
  const previous = new Date(previousTimestamp).getTime();
  return new Date(Math.max(
    candidate,
    Number.isFinite(previous) ? previous + 1 : candidate,
  )).toISOString();
}

function sourceCharacterKey(row) {
  const payload = parseJson(row.source_ref_json);
  const source = payload.source_ref || payload.source || {};
  const key = [
    source.source_character_key,
    source.stable_id,
    source.id,
    source.source_character_id,
  ].map((value) => {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
    return '';
  }).find(Boolean);
  if (!key) fail(INPUT_INVALID_CODE, '角色来源缺少稳定身份键');
  return key;
}

function summarizeCharacter(row) {
  return {
    id: Number(row.id),
    asset_id: row.asset_id == null ? null : Number(row.asset_id),
    status: row.status,
    approval_status: row.approval_status,
    approved_by: row.approved_by ?? null,
    approved_at: row.approved_at ?? null,
    error_code: row.error_code ?? null,
    updated_at: row.updated_at,
  };
}

function summarizeAsset(row, fileSha256) {
  return {
    id: Number(row.id),
    type: row.type,
    mime_type: row.mime_type,
    sha256: fileSha256,
    width: Number(row.width),
    height: Number(row.height),
    file_size: Number(row.file_size),
  };
}

function buildResult(purpose, asset, fileSha256, character = null) {
  const result = {
    purpose,
    asset: summarizeAsset(asset, fileSha256),
  };
  if (purpose === 'identity') result.redraw_asset = summarizeCharacter(character);
  result.billing = { credits: 0, held: 0, charged: 0 };
  return result;
}

async function replayResult(ctx, input, media, record) {
  if (record.status !== 'completed' || !Number.isSafeInteger(Number(record.stored_asset_id))) {
    fail(record.error_code || STORAGE_FAILED_CODE, '参考素材导入未完成');
  }
  const asset = ctx.db.prepare(`
    SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL
  `).get(Number(record.stored_asset_id));
  const metadata = parseJson(asset?.metadata);
  const expectedRelativePath = assetRelativePath(media.fileSha256, media.extension);
  if (!asset || asset.type !== 'image' || asset.category !== 'redraw'
    || asset.mime_type !== media.mimeType
    || Number(asset.width) !== media.width
    || Number(asset.height) !== media.height
    || Number(asset.file_size) !== media.fileSize
    || metadata.sha256 !== media.fileSha256
    || asset.local_path !== expectedRelativePath) {
    fail(STORAGE_FAILED_CODE, '参考素材幂等结果校验失败');
  }
  await verifyStoredFile(
    absoluteStoragePath(ctx.storageRoot, expectedRelativePath),
    media.fileSha256,
  );
  const character = input.purpose === 'identity' ? readCharacter(ctx, input.assetId) : null;
  return buildResult(input.purpose, asset, media.fileSha256, character);
}

async function cleanupCreatedFile(ctx, stored) {
  if (!stored?.created) return;
  let referenced;
  try {
    referenced = Number(ctx.db.prepare(`
      SELECT COUNT(*) AS count
      FROM assets
      WHERE local_path = ? AND deleted_at IS NULL
    `).get(stored.relativePath).count) > 0;
  } catch (_) {
    referenced = true;
  }
  if (referenced) return;
  try {
    await fs.promises.unlink(stored.finalPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function isReferenceArtifactError(error) {
  return typeof error?.code === 'string' && error.code.startsWith('REDRAW_REFERENCE_ARTIFACT_');
}

function isUniqueConstraintError(error) {
  return error?.code === 'SQLITE_CONSTRAINT_UNIQUE'
    || (error?.code === 'SQLITE_CONSTRAINT'
      && /UNIQUE constraint failed/.test(String(error.message || '')));
}

function assertMatchingImportRecord(record, currentRequestHash, fileSha256) {
  if (record.request_hash !== currentRequestHash || record.file_sha256 !== fileSha256) {
    fail(IDEMPOTENCY_CONFLICT_CODE, '参考素材幂等请求冲突');
  }
}

function normalizeMotionInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    fail(INPUT_INVALID_CODE, '动作参考导入参数无效');
  }
  for (const key of inputKeys(rawInput)) {
    if (!MOTION_INPUT_FIELDS.has(key)) {
      fail(FORBIDDEN_FIELD_CODE, '动作参考导入包含禁止字段');
    }
  }
  const shotId = Number(rawInput.shotId);
  const expectedUpdatedAt = String(rawInput.expectedUpdatedAt ?? '').trim();
  const idempotencyKey = String(rawInput.idempotencyKey ?? '').trim();
  if (!Number.isSafeInteger(shotId) || shotId <= 0 || !expectedUpdatedAt || !idempotencyKey) {
    fail(INPUT_INVALID_CODE, '动作参考导入参数无效');
  }
  return {
    shotId,
    expectedUpdatedAt,
    idempotencyKey,
    fullFrameReviewed: rawInput.fullFrameReviewed,
    sourceIdentityObscured: rawInput.sourceIdentityObscured,
    sourceTextObscured: rawInput.sourceTextObscured,
    motionPreserved: rawInput.motionPreserved,
    file: rawInput.file,
  };
}

function assertMotionReview(input) {
  if (input.fullFrameReviewed !== true
    || input.sourceIdentityObscured !== true
    || input.sourceTextObscured !== true
    || input.motionPreserved !== true) {
    fail(MOTION_REVIEW_REQUIRED_CODE, '动作参考需要完成全部人工复核');
  }
}

function readMotionScope(ctx, shotId) {
  const row = ctx.db.prepare(`
    SELECT
      shot.*,
      version.work_id AS source_work_id,
      work.source_asset_id AS source_asset_id,
      work.source_fingerprint AS source_fingerprint,
      source_asset.width AS source_width,
      source_asset.height AS source_height
    FROM redraw_shots AS shot
    JOIN redraw_versions AS version
      ON version.id = shot.version_id
      AND version.tenant_id = shot.tenant_id
      AND version.user_id = shot.user_id
      AND version.deleted_at IS NULL
    JOIN redraw_works AS work
      ON work.id = version.work_id
      AND work.tenant_id = shot.tenant_id
      AND work.user_id = shot.user_id
      AND work.deleted_at IS NULL
    JOIN assets AS source_asset
      ON source_asset.id = work.source_asset_id
      AND source_asset.type = 'video'
      AND source_asset.deleted_at IS NULL
    WHERE shot.id = ? AND shot.version_id = ?
      AND shot.tenant_id = ? AND shot.user_id = ?
      AND shot.deleted_at IS NULL
  `).get(shotId, ctx.versionId, ctx.tenantId, ctx.userId);
  if (!row
    || !Number.isSafeInteger(Number(row.source_work_id))
    || !Number.isSafeInteger(Number(row.source_asset_id))
    || !SHA256_PATTERN.test(String(row.source_fingerprint || '').trim())
    || !Number.isSafeInteger(Number(row.source_width)) || Number(row.source_width) <= 0
    || !Number.isSafeInteger(Number(row.source_height)) || Number(row.source_height) <= 0
    || !Number.isSafeInteger(Number(row.start_ms)) || Number(row.start_ms) < 0
    || !Number.isSafeInteger(Number(row.end_ms)) || Number(row.end_ms) <= Number(row.start_ms)) {
    fail(NOT_FOUND_CODE, '动作参考镜头不存在');
  }
  return row;
}

function inspectMotionHeader(file) {
  if (!file || typeof file !== 'object' || !Buffer.isBuffer(file.buffer)) {
    fail(MEDIA_INVALID_CODE, '动作参考视频无效');
  }
  const declaredSize = Number(file.size);
  if ((Number.isFinite(declaredSize) && declaredSize > MAX_MOTION_BYTES)
    || file.buffer.length > MAX_MOTION_BYTES) {
    fail(TOO_LARGE_CODE, '动作参考视频超过大小限制');
  }
  if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0
    || declaredSize !== file.buffer.length) {
    fail(MEDIA_INVALID_CODE, '动作参考视频无效');
  }
  const mimetype = String(file.mimetype ?? '').trim().toLowerCase();
  const originalname = String(file.originalname ?? '').trim();
  if (mimetype !== 'video/mp4'
    || path.extname(originalname).toLowerCase() !== '.mp4'
    || file.buffer.length < 12
    || file.buffer.subarray(4, 8).toString('ascii') !== 'ftyp') {
    fail(MEDIA_INVALID_CODE, '动作参考视频格式不一致');
  }
  return {
    buffer: file.buffer,
    fileSize: file.buffer.length,
    mimeType: mimetype,
    originalname: path.basename(originalname),
    fileSha256: sha256(file.buffer),
  };
}

async function defaultMotionProbe(filePath) {
  const { stdout } = await execFileAsync(getFfprobePath(), [
    '-v', 'error',
    '-show_streams',
    '-show_format',
    '-of', 'json',
    filePath,
  ], {
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
    killSignal: 'SIGKILL',
  });
  const parsed = JSON.parse(stdout);
  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const videos = streams.filter((stream) => stream?.codec_type === 'video');
  const video = videos[0];
  const durationSeconds = Number(parsed?.format?.duration ?? video?.duration);
  const formatNames = String(parsed?.format?.format_name || '')
    .split(',')
    .map((value) => value.trim().toLowerCase());
  return {
    duration_ms: Number.isFinite(durationSeconds) ? Math.round(durationSeconds * 1000) : Number.NaN,
    width: Number(video?.width),
    height: Number(video?.height),
    mime_type: formatNames.includes('mp4') ? 'video/mp4' : null,
    video_codec: String(video?.codec_name || '').trim().toLowerCase(),
    video_stream_count: videos.length,
    audio_stream_count: streams.filter((stream) => stream?.codec_type === 'audio').length,
  };
}

function assertMotionProbe(probe, scope) {
  const durationMs = Number(probe?.duration_ms);
  const width = Number(probe?.width);
  const height = Number(probe?.height);
  const expectedDurationMs = Number(scope.end_ms) - Number(scope.start_ms);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0
    || Math.abs(durationMs - expectedDurationMs) > MOTION_DURATION_TOLERANCE_MS
    || !Number.isSafeInteger(width) || width !== Number(scope.source_width)
    || !Number.isSafeInteger(height) || height !== Number(scope.source_height)
    || probe?.mime_type !== 'video/mp4'
    || probe?.video_codec !== 'h264'
    || Number(probe?.video_stream_count) !== 1
    || Number(probe?.audio_stream_count) !== 0) {
    fail(MEDIA_INVALID_CODE, '动作参考视频媒体信息无效');
  }
  return {
    durationMs,
    width,
    height,
    mimeType: 'video/mp4',
    videoCodec: 'h264',
    audioStreamCount: 0,
  };
}

async function inspectMotionMedia(ctx, media, scope) {
  const directory = path.join(ctx.storageRoot, 'redraw-conditioning');
  try {
    await fs.promises.mkdir(directory, { recursive: true });
  } catch (_) {
    fail(STORAGE_FAILED_CODE, '动作参考临时存储失败');
  }
  const probePath = path.join(
    directory,
    `.${media.fileSha256}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.probe.mp4`,
  );
  let handle = null;
  try {
    handle = await fs.promises.open(probePath, 'wx', 0o600);
    await handle.writeFile(media.buffer);
    await handle.sync();
    await handle.close();
    handle = null;
    const runner = typeof ctx.motionProbeRunner === 'function'
      ? ctx.motionProbeRunner
      : defaultMotionProbe;
    const probe = await runner(probePath);
    return { ...media, ...assertMotionProbe(probe, scope) };
  } catch (error) {
    if (isReferenceArtifactError(error)) throw error;
    fail(MEDIA_INVALID_CODE, '动作参考视频无法探测');
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (_) {
        // Preserve the media validation failure.
      }
    }
    try {
      await fs.promises.unlink(probePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        fail(STORAGE_FAILED_CODE, '动作参考临时文件清理失败');
      }
    }
  }
}

function motionRequestHash(ctx, input, scope, fileSha256) {
  return sha256(stableJson({
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    version_id: ctx.versionId,
    scope_type: 'shot',
    scope_id: input.shotId,
    purpose: 'motion',
    expected_updated_at: input.expectedUpdatedAt,
    source_work_id: Number(scope.source_work_id),
    source_asset_id: Number(scope.source_asset_id),
    source_fingerprint: String(scope.source_fingerprint),
    source_width: Number(scope.source_width),
    source_height: Number(scope.source_height),
    clip_start_ms: Number(scope.start_ms),
    clip_end_ms: Number(scope.end_ms),
    full_frame_reviewed: input.fullFrameReviewed,
    source_identity_obscured: input.sourceIdentityObscured,
    source_text_obscured: input.sourceTextObscured,
    motion_preserved: input.motionPreserved,
    file_sha256: fileSha256,
  }));
}

function findMotionImportRecord(ctx, input, idempotencyHash) {
  return ctx.db.prepare(`
    SELECT *
    FROM redraw_reference_artifact_imports
    WHERE tenant_id = ? AND user_id = ? AND version_id = ?
      AND scope_type = 'shot' AND scope_id = ? AND purpose = 'motion'
      AND idempotency_hash = ?
  `).get(
    ctx.tenantId,
    ctx.userId,
    ctx.versionId,
    input.shotId,
    idempotencyHash,
  );
}

function motionRelativePath(fileSha256) {
  return `redraw-conditioning/${fileSha256}.mp4`;
}

async function storeMotion(ctx, media) {
  const relativePath = motionRelativePath(media.fileSha256);
  const finalPath = absoluteStoragePath(ctx.storageRoot, relativePath);
  const directory = path.dirname(finalPath);
  try {
    await fs.promises.mkdir(directory, { recursive: true });
  } catch (_) {
    fail(STORAGE_FAILED_CODE, '动作参考存储失败');
  }
  if (await existingFile(finalPath, media.fileSha256)) {
    return { relativePath, finalPath, created: false };
  }
  const tempPath = path.join(
    directory,
    `.${media.fileSha256}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let handle = null;
  let tempExists = false;
  let createdFinal = false;
  try {
    handle = await fs.promises.open(tempPath, 'wx', 0o600);
    tempExists = true;
    await handle.writeFile(media.buffer);
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await fs.promises.rename(tempPath, finalPath);
      tempExists = false;
      createdFinal = true;
      await verifyStoredFile(finalPath, media.fileSha256);
      return { relativePath, finalPath, created: true };
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
      await verifyStoredFile(finalPath, media.fileSha256);
      return { relativePath, finalPath, created: false };
    }
  } catch (error) {
    if (createdFinal) {
      try {
        await cleanupCreatedFile(ctx, { relativePath, finalPath, created: true });
      } catch (_) {
        // The caller still receives a redacted storage failure.
      }
    }
    if (error?.code === STORAGE_FAILED_CODE) throw error;
    fail(STORAGE_FAILED_CODE, '动作参考存储失败');
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (_) {
        // Preserve the original failure.
      }
    }
    if (tempExists) {
      try {
        await fs.promises.unlink(tempPath);
      } catch (_) {
        // Preserve the original failure.
      }
    }
  }
}

function sameMotionScope(left, right) {
  return Number(left.id) === Number(right.id)
    && Number(left.source_work_id) === Number(right.source_work_id)
    && Number(left.source_asset_id) === Number(right.source_asset_id)
    && String(left.source_fingerprint) === String(right.source_fingerprint)
    && Number(left.start_ms) === Number(right.start_ms)
    && Number(left.end_ms) === Number(right.end_ms)
    && Number(left.source_width) === Number(right.source_width)
    && Number(left.source_height) === Number(right.source_height);
}

function motionMetadata(ctx, input, scope, media, reviewedAt) {
  return {
    sha256: media.fileSha256,
    source: 'redraw_motion_reference_import',
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    version_id: ctx.versionId,
    scope_type: 'shot',
    scope_id: input.shotId,
    purpose: 'motion',
    redraw_motion_import: {
      schema_version: 'redraw-motion-import-v1',
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      version_id: ctx.versionId,
      shot_id: input.shotId,
      source_work_id: Number(scope.source_work_id),
      source_asset_id: Number(scope.source_asset_id),
      source_fingerprint: String(scope.source_fingerprint),
      clip_start_ms: Number(scope.start_ms),
      clip_end_ms: Number(scope.end_ms),
      file_sha256: media.fileSha256,
      duration_ms: media.durationMs,
      width: media.width,
      height: media.height,
      mime_type: media.mimeType,
      video_codec: media.videoCodec,
      audio_stream_count: media.audioStreamCount,
      reviewed_by: ctx.userId,
      reviewed_at: reviewedAt,
      review: {
        full_frame_reviewed: true,
        source_identity_obscured: true,
        source_text_obscured: true,
        motion_preserved: true,
      },
    },
  };
}

function buildMotionResult(asset, motion) {
  return {
    purpose: 'motion',
    asset: {
      id: Number(asset.id),
      type: asset.type,
      mime_type: asset.mime_type,
      sha256: motion.file_sha256,
      duration_ms: Number(motion.duration_ms),
      width: Number(asset.width),
      height: Number(asset.height),
      file_size: Number(asset.file_size),
    },
    billing: { credits: 0, held: 0, charged: 0 },
  };
}

async function replayMotionResult(ctx, input, media, record, scope) {
  if (record.status !== 'completed' || !Number.isSafeInteger(Number(record.stored_asset_id))) {
    fail(record.error_code || STORAGE_FAILED_CODE, '动作参考导入未完成');
  }
  const asset = ctx.db.prepare(`
    SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL
  `).get(Number(record.stored_asset_id));
  const metadata = parseJson(asset?.metadata);
  const motion = metadata.redraw_motion_import;
  const expectedRelativePath = motionRelativePath(media.fileSha256);
  if (!asset || asset.type !== 'video' || asset.category !== 'redraw'
    || asset.mime_type !== 'video/mp4'
    || Number(asset.width) !== media.width
    || Number(asset.height) !== media.height
    || Number(asset.file_size) !== media.fileSize
    || !motion || motion.schema_version !== 'redraw-motion-import-v1'
    || motion.tenant_id !== ctx.tenantId || motion.user_id !== ctx.userId
    || Number(motion.version_id) !== ctx.versionId
    || Number(motion.shot_id) !== input.shotId
    || Number(motion.source_work_id) !== Number(scope.source_work_id)
    || Number(motion.source_asset_id) !== Number(scope.source_asset_id)
    || motion.source_fingerprint !== String(scope.source_fingerprint)
    || Number(motion.clip_start_ms) !== Number(scope.start_ms)
    || Number(motion.clip_end_ms) !== Number(scope.end_ms)
    || motion.file_sha256 !== media.fileSha256
    || Number(motion.duration_ms) <= 0
    || Math.abs(Number(motion.duration_ms) - (Number(scope.end_ms) - Number(scope.start_ms)))
      > MOTION_DURATION_TOLERANCE_MS
    || Number(motion.width) !== Number(scope.source_width)
    || Number(motion.height) !== Number(scope.source_height)
    || motion.mime_type !== 'video/mp4'
    || motion.video_codec !== 'h264'
    || Number(motion.audio_stream_count) !== 0
    || motion.reviewed_by !== ctx.userId
    || motion.review?.full_frame_reviewed !== true
    || motion.review?.source_identity_obscured !== true
    || motion.review?.source_text_obscured !== true
    || motion.review?.motion_preserved !== true
    || Object.hasOwn(metadata, 'redraw_motion_reference')
    || asset.local_path !== expectedRelativePath) {
    fail(STORAGE_FAILED_CODE, '动作参考幂等结果校验失败');
  }
  await verifyStoredFile(
    absoluteStoragePath(ctx.storageRoot, expectedRelativePath),
    media.fileSha256,
  );
  return buildMotionResult(asset, motion);
}

async function importCharacterReferenceArtifact(rawCtx, rawInput) {
  const ctx = normalizeContext(rawCtx);
  const input = normalizeInput(rawInput);
  const character = readCharacter(ctx, input.assetId);
  if (input.purpose === 'identity') sourceCharacterKey(character);
  const media = await inspectImage(input.file);
  const idempotencyHash = sha256(input.idempotencyKey);
  const currentRequestHash = requestHash(ctx, input, media.fileSha256);
  const existing = findImportRecord(ctx, input, idempotencyHash);
  if (existing) {
    assertMatchingImportRecord(existing, currentRequestHash, media.fileSha256);
    return replayResult(ctx, input, media, existing);
  }

  const stored = await storeImage(ctx, media);
  try {
    const transaction = ctx.db.transaction(() => {
      const concurrentImport = findImportRecord(ctx, input, idempotencyHash);
      if (concurrentImport) {
        assertMatchingImportRecord(concurrentImport, currentRequestHash, media.fileSha256);
        return { replayRecord: concurrentImport };
      }
      const currentCharacter = readCharacter(ctx, input.assetId);
      if (String(currentCharacter.updated_at || '') !== input.expectedUpdatedAt) {
        fail(CONFLICT_CODE, '角色资产已被其他操作更新');
      }
      if (input.purpose === 'identity') sourceCharacterKey(currentCharacter);
      const asset = assetService.create(ctx.db, ctx.log, {
        name: media.originalname,
        type: 'image',
        category: 'redraw',
        url: `/static/${stored.relativePath}`,
        local_path: stored.relativePath,
        file_size: media.fileSize,
        mime_type: media.mimeType,
        width: media.width,
        height: media.height,
        metadata: {
          sha256: media.fileSha256,
          source: 'redraw_reference_artifact_import',
          tenant_id: ctx.tenantId,
          user_id: ctx.userId,
          version_id: ctx.versionId,
          scope_type: 'character',
          scope_id: input.assetId,
          purpose: input.purpose,
        },
      });
      let savedCharacter = null;
      const completedAt = input.purpose === 'identity'
        ? nextTimestamp(ctx, currentCharacter.updated_at)
        : currentTimestamp(ctx);
      if (input.purpose === 'identity') {
        const updated = ctx.db.prepare(`
          UPDATE redraw_assets
          SET asset_id = ?, status = 'generated', approval_status = 'pending',
              approved_by = NULL, approved_at = NULL,
              error_code = NULL, error_message = NULL, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND user_id = ? AND version_id = ?
            AND kind = 'character' AND updated_at = ? AND deleted_at IS NULL
        `).run(
          asset.id,
          completedAt,
          input.assetId,
          ctx.tenantId,
          ctx.userId,
          ctx.versionId,
          input.expectedUpdatedAt,
        );
        if (updated.changes !== 1) {
          fail(CONFLICT_CODE, '角色资产已被其他操作更新');
        }
        invalidateCharacterDependents({ ...ctx, now: completedAt }, {
          source_character_key: sourceCharacterKey(currentCharacter),
          reason_code: 'character_identity_changed',
        });
        savedCharacter = readCharacter(ctx, input.assetId);
      }
      ctx.db.prepare(`
        INSERT INTO redraw_reference_artifact_imports (
          tenant_id, user_id, version_id, scope_type, scope_id, purpose,
          idempotency_hash, request_hash, file_sha256, stored_asset_id,
          status, error_code, created_at, updated_at
        ) VALUES (?, ?, ?, 'character', ?, ?, ?, ?, ?, ?, 'completed', NULL, ?, ?)
      `).run(
        ctx.tenantId,
        ctx.userId,
        ctx.versionId,
        input.assetId,
        input.purpose,
        idempotencyHash,
        currentRequestHash,
        media.fileSha256,
        asset.id,
        completedAt,
        completedAt,
      );
      return { assetId: Number(asset.id), character: savedCharacter };
    });
    const completed = transaction.immediate();
    if (completed.replayRecord) {
      return replayResult(ctx, input, media, completed.replayRecord);
    }
    const asset = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(completed.assetId);
    return buildResult(input.purpose, asset, media.fileSha256, completed.character);
  } catch (error) {
    try {
      await cleanupCreatedFile(ctx, stored);
    } catch (_) {
      throw codedError(STORAGE_FAILED_CODE, '参考素材清理失败');
    }
    if (isUniqueConstraintError(error)) {
      const racedImport = findImportRecord(ctx, input, idempotencyHash);
      if (racedImport) {
        assertMatchingImportRecord(racedImport, currentRequestHash, media.fileSha256);
        return replayResult(ctx, input, media, racedImport);
      }
    }
    if (isReferenceArtifactError(error)) throw error;
    throw codedError(STORAGE_FAILED_CODE, '参考素材导入存储失败');
  }
}

async function importMotionReferenceArtifact(rawCtx, rawInput) {
  const ctx = normalizeContext(rawCtx);
  const input = normalizeMotionInput(rawInput);
  assertMotionReview(input);
  const scope = readMotionScope(ctx, input.shotId);
  if (String(scope.updated_at || '') !== input.expectedUpdatedAt) {
    fail(CONFLICT_CODE, '动作参考镜头已被其他操作更新');
  }
  const header = inspectMotionHeader(input.file);
  const idempotencyHash = sha256(input.idempotencyKey);
  const currentRequestHash = motionRequestHash(ctx, input, scope, header.fileSha256);
  const existing = findMotionImportRecord(ctx, input, idempotencyHash);
  if (existing) {
    assertMatchingImportRecord(existing, currentRequestHash, header.fileSha256);
    const existingAsset = ctx.db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL')
      .get(Number(existing.stored_asset_id));
    const motion = parseJson(existingAsset?.metadata).redraw_motion_import;
    const replayMedia = {
      ...header,
      durationMs: Number(motion?.duration_ms),
      width: Number(motion?.width),
      height: Number(motion?.height),
    };
    return replayMotionResult(ctx, input, replayMedia, existing, scope);
  }

  const media = await inspectMotionMedia(ctx, header, scope);
  const stored = await storeMotion(ctx, media);
  try {
    const transaction = ctx.db.transaction(() => {
      const concurrentImport = findMotionImportRecord(ctx, input, idempotencyHash);
      if (concurrentImport) {
        assertMatchingImportRecord(concurrentImport, currentRequestHash, media.fileSha256);
        return { replayRecord: concurrentImport };
      }
      const currentScope = readMotionScope(ctx, input.shotId);
      if (String(currentScope.updated_at || '') !== input.expectedUpdatedAt
        || !sameMotionScope(currentScope, scope)) {
        fail(CONFLICT_CODE, '动作参考镜头已被其他操作更新');
      }
      const completedAt = currentTimestamp(ctx);
      const metadata = motionMetadata(ctx, input, currentScope, media, completedAt);
      const asset = assetService.create(ctx.db, ctx.log, {
        name: media.originalname,
        type: 'video',
        category: 'redraw',
        url: `/static/${stored.relativePath}`,
        local_path: stored.relativePath,
        file_size: media.fileSize,
        mime_type: media.mimeType,
        width: media.width,
        height: media.height,
        duration: media.durationMs / 1000,
        metadata,
      });
      ctx.db.prepare(`
        INSERT INTO redraw_reference_artifact_imports (
          tenant_id, user_id, version_id, scope_type, scope_id, purpose,
          idempotency_hash, request_hash, file_sha256, stored_asset_id,
          status, error_code, created_at, updated_at
        ) VALUES (?, ?, ?, 'shot', ?, 'motion', ?, ?, ?, ?, 'completed', NULL, ?, ?)
      `).run(
        ctx.tenantId,
        ctx.userId,
        ctx.versionId,
        input.shotId,
        idempotencyHash,
        currentRequestHash,
        media.fileSha256,
        asset.id,
        completedAt,
        completedAt,
      );
      return { assetId: Number(asset.id) };
    });
    const completed = transaction.immediate();
    if (completed.replayRecord) {
      return replayMotionResult(ctx, input, media, completed.replayRecord, scope);
    }
    const asset = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(completed.assetId);
    return buildMotionResult(asset, parseJson(asset.metadata).redraw_motion_import);
  } catch (error) {
    try {
      await cleanupCreatedFile(ctx, stored);
    } catch (_) {
      throw codedError(STORAGE_FAILED_CODE, '动作参考清理失败');
    }
    if (isUniqueConstraintError(error)) {
      const racedImport = findMotionImportRecord(ctx, input, idempotencyHash);
      if (racedImport) {
        assertMatchingImportRecord(racedImport, currentRequestHash, media.fileSha256);
        return replayMotionResult(ctx, input, media, racedImport, scope);
      }
    }
    if (isReferenceArtifactError(error)) throw error;
    throw codedError(STORAGE_FAILED_CODE, '动作参考导入存储失败');
  }
}

async function bindReadyMotionReference() {
  fail(INPUT_INVALID_CODE, '参考素材导入参数无效');
}

module.exports = {
  importCharacterReferenceArtifact,
  importMotionReferenceArtifact,
  bindReadyMotionReference,
};
