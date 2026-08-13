'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const ALLOWED_SHOT_IDS = Object.freeze(['shot-1', 'shot-6', 'shot-7', 'shot-8']);
const NON_MASK_SIMILARITY_MIN = 0.97;
const SCHEMA_VERSION = 'redraw-clean-plate-local-v1';

const MIME_TYPES = Object.freeze({
  avif: 'image/avif',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  jp2: 'image/jp2',
  png: 'image/png',
  svg: 'image/svg+xml',
  tiff: 'image/tiff',
  webp: 'image/webp',
});

const REVIEW_STATUSES = new Set(['approved', 'failed', 'needs_attention', 'pending', 'rejected']);

function codedError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function isPathWithin(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function normalizeRelativePath(root, candidatePath) {
  if (typeof candidatePath !== 'string' || candidatePath.length === 0 || candidatePath.includes('\0')) {
    throw codedError('REDRAW_CLEAN_PLATE_PATH_INVALID', '净景文件路径无效');
  }

  // Check both path dialects so a manifest cannot smuggle a path that is
  // absolute on another platform into this Windows/Node runner.
  if (path.isAbsolute(candidatePath) || path.win32.isAbsolute(candidatePath) || path.posix.isAbsolute(candidatePath)) {
    throw codedError('REDRAW_CLEAN_PLATE_PATH_INVALID', '净景文件路径必须是受控根目录内的相对路径');
  }

  const segments = candidatePath.split(/[\\/]+/);
  if (segments.some((segment) => segment === '..') || /^[A-Za-z]:/.test(candidatePath)) {
    throw codedError('REDRAW_CLEAN_PLATE_PATH_INVALID', '净景文件路径不得包含 .. 或驱动器前缀');
  }

  const normalized = path.normalize(candidatePath);
  if (normalized === '.' || path.isAbsolute(normalized)) {
    throw codedError('REDRAW_CLEAN_PLATE_PATH_INVALID', '净景文件路径无效');
  }

  const lexicalPath = path.resolve(root, normalized);
  const lexicalRelative = path.relative(root, lexicalPath);
  if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) {
    throw codedError('REDRAW_CLEAN_PLATE_PATH_INVALID', '净景文件路径逃逸受控根目录');
  }

  let realPath;
  try {
    realPath = fs.realpathSync.native(lexicalPath);
  } catch (error) {
    throw codedError('REDRAW_CLEAN_PLATE_PATH_INVALID', '净景文件不存在或不可读取', error);
  }
  if (!isPathWithin(root, realPath)) {
    throw codedError('REDRAW_CLEAN_PLATE_PATH_INVALID', '净景文件符号链接逃逸受控根目录');
  }

  // Use a canonical relative path in the manifest. It cannot disclose root,
  // and normalizing separators keeps manifests reproducible across hosts.
  return {
    realPath,
    relativePath: path.relative(root, lexicalPath).split(path.sep).join('/'),
  };
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function readImageEvidence(root, evidence, label) {
  if (!evidence || typeof evidence !== 'object') {
    throw codedError('REDRAW_CLEAN_PLATE_PATH_INVALID', `${label}文件证据缺失`);
  }

  const expectedSha = typeof evidence.sha256 === 'string' ? evidence.sha256.toLowerCase() : '';
  if (!/^[a-f0-9]{64}$/.test(expectedSha)) {
    throw codedError('REDRAW_CLEAN_PLATE_HASH_MISMATCH', `${label} SHA-256 无效`);
  }

  const resolved = normalizeRelativePath(root, evidence.path);
  let file;
  let metadata;
  try {
    const stat = await fs.promises.stat(resolved.realPath);
    if (!stat.isFile()) throw new Error('not a regular file');
    file = await fs.promises.readFile(resolved.realPath);
    metadata = await sharp(resolved.realPath).metadata();
  } catch (error) {
    throw codedError('REDRAW_CLEAN_PLATE_PATH_INVALID', `${label}文件不存在、不可读取或不是有效图片`, error);
  }

  const actualSha = sha256Buffer(file);
  if (actualSha !== expectedSha) {
    throw codedError('REDRAW_CLEAN_PLATE_HASH_MISMATCH', `${label} SHA-256 与文件内容不匹配`);
  }

  const width = Number(metadata.width);
  const height = Number(metadata.height);
  const format = typeof metadata.format === 'string' ? metadata.format.toLowerCase() : '';
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0 || !format) {
    throw codedError('REDRAW_CLEAN_PLATE_PATH_INVALID', `${label}图片元数据不可读`);
  }

  const mimeType = MIME_TYPES[format] || `image/${format}`;
  const declaredMimeType = typeof evidence.mime_type === 'string' ? evidence.mime_type.toLowerCase() : '';
  if (!/^image\/[a-z0-9.+-]+$/i.test(mimeType) || declaredMimeType !== mimeType) {
    throw codedError('REDRAW_CLEAN_PLATE_DIMENSIONS_INVALID', `${label} MIME 类型与图片内容不一致`);
  }

  return {
    path: resolved.relativePath,
    sha256: actualSha,
    width,
    height,
    mime_type: mimeType,
    bytes: file.length,
  };
}

function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length !== ALLOWED_SHOT_IDS.length) {
    throw codedError('REDRAW_CLEAN_PLATE_SHOTS_INVALID', '必须提供四个净景镜头');
  }

  const byShotId = new Map();
  for (const entry of entries) {
    const shotId = entry && entry.shot_id;
    if (!ALLOWED_SHOT_IDS.includes(shotId) || byShotId.has(shotId)) {
      throw codedError('REDRAW_CLEAN_PLATE_SHOTS_INVALID', '净景镜头必须是 shot-1、shot-6、shot-7、shot-8 且不得重复');
    }
    byShotId.set(shotId, entry);
  }

  if (byShotId.size !== ALLOWED_SHOT_IDS.length) {
    throw codedError('REDRAW_CLEAN_PLATE_SHOTS_INVALID', '净景镜头清单不完整');
  }
  return ALLOWED_SHOT_IDS.map((shotId) => byShotId.get(shotId));
}

function assertSameDimensions(shotId, source, mask, cleanPlate, quality) {
  if (
    source.width !== mask.width
    || source.height !== mask.height
    || source.width !== cleanPlate.width
    || source.height !== cleanPlate.height
    || source.mime_type !== mask.mime_type
    || source.mime_type !== cleanPlate.mime_type
  ) {
    throw codedError('REDRAW_CLEAN_PLATE_DIMENSIONS_INVALID', `${shotId} 源帧、遮罩和净景尺寸及 MIME 必须一致`);
  }

  if (quality && (Object.prototype.hasOwnProperty.call(quality, 'width') || Object.prototype.hasOwnProperty.call(quality, 'height'))) {
    const qualityWidth = Number(quality.width);
    const qualityHeight = Number(quality.height);
    if (!Number.isInteger(qualityWidth) || !Number.isInteger(qualityHeight) || qualityWidth !== source.width || qualityHeight !== source.height) {
      throw codedError('REDRAW_CLEAN_PLATE_DIMENSIONS_INVALID', `${shotId} 质量尺寸与图片不一致`);
    }
  }
}

function assertQuality(quality, shotId) {
  if (!quality || quality.mask_area_changed !== true || !Number.isFinite(Number(quality.non_mask_similarity)) || Number(quality.non_mask_similarity) < NON_MASK_SIMILARITY_MIN) {
    throw codedError('REDRAW_CLEAN_PLATE_QUALITY_FAILED', `${shotId} 净景质量未达到 0.97 门禁`);
  }
}

function sanitizeQuality(quality, source) {
  const sanitized = {
    width: source.width,
    height: source.height,
    mask_area_changed: quality.mask_area_changed,
    non_mask_similarity: Number(quality.non_mask_similarity),
  };
  return sanitized;
}

function sanitizeReview(review) {
  const candidate = typeof review?.status === 'string' ? review.status : '';
  const status = REVIEW_STATUSES.has(candidate) ? candidate : 'pending';
  return { status };
}

async function buildLocalCleanPlateManifest({ root, entries, now = new Date().toISOString() } = {}) {
  let realRoot;
  try {
    if (typeof root !== 'string' || root.length === 0) throw new Error('root is required');
    realRoot = fs.realpathSync.native(root);
    if (!fs.statSync(realRoot).isDirectory()) throw new Error('root is not a directory');
  } catch (error) {
    throw codedError('REDRAW_CLEAN_PLATE_PATH_INVALID', '净景受控根目录不可读取', error);
  }

  const normalizedEntries = validateEntries(entries);
  const shots = [];
  for (const entry of normalizedEntries) {
    const shotId = entry.shot_id;
    const source = await readImageEvidence(realRoot, entry.representative_frame, `${shotId} 源帧`);
    const mask = await readImageEvidence(realRoot, entry.mask, `${shotId} 遮罩`);
    const cleanPlate = await readImageEvidence(realRoot, entry.clean_plate, `${shotId} 净景`);
    assertSameDimensions(shotId, source, mask, cleanPlate, entry.quality);
    assertQuality(entry.quality, shotId);

    const review = sanitizeReview(entry.review);
    shots.push({
      shot_id: shotId,
      source,
      mask,
      clean_plate: cleanPlate,
      quality: sanitizeQuality(entry.quality, source),
      review,
      ready_for_reference: review.status === 'approved',
    });
  }

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: now,
    shots,
  };
}

module.exports = {
  ALLOWED_SHOT_IDS,
  NON_MASK_SIMILARITY_MIN,
  buildLocalCleanPlateManifest,
};
