'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const assetService = require('./assetService');
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
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 4096;
const MAX_IMAGE_PIXELS = MAX_IMAGE_DIMENSION * MAX_IMAGE_DIMENSION;
const ALLOWED_INPUT_FIELDS = new Set([
  'assetId',
  'purpose',
  'expectedUpdatedAt',
  'idempotencyKey',
  'file',
]);
const CHARACTER_PURPOSES = new Set(['identity', 'wardrobe']);
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

async function importMotionReferenceArtifact() {
  fail(INPUT_INVALID_CODE, '参考素材导入参数无效');
}

async function bindReadyMotionReference() {
  fail(INPUT_INVALID_CODE, '参考素材导入参数无效');
}

module.exports = {
  importCharacterReferenceArtifact,
  importMotionReferenceArtifact,
  bindReadyMotionReference,
};
