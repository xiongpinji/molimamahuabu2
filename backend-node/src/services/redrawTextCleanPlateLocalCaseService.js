'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const ALLOWED_TEXT_SHOT_IDS = Object.freeze(['shot-4', 'shot-8']);
const TEXT_KINDS = Object.freeze(['text_subtitle', 'text_screen']);
const EXPECTED_TEXT_KIND_BY_SHOT = Object.freeze({
  'shot-4': 'text_subtitle',
  'shot-8': 'text_screen',
});
const NON_MASK_SIMILARITY_MIN = 0.97;
const SCHEMA_VERSION = 'redraw-text-clean-plate-local-v1';

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

const ENTRY_FIELDS = new Set([
  'shot_id',
  'text_kind',
  'source_asset_id',
  'representative_frame',
  'mask_asset_id',
  'mask_asset',
  'text_clean_asset_id',
  'clean_plate',
  'region',
  'text_regions',
  'quality',
  'review',
]);
const IMAGE_FIELDS = new Set(['path', 'sha256', 'width', 'height', 'mime_type', 'bytes']);
const QUALITY_FIELDS = new Set([
  'width',
  'height',
  'mask_area_changed',
  'non_mask_similarity',
  'text_residual',
]);
const REVIEW_FIELDS = new Set(['status']);
const REGION_FIELDS = new Set(['kind', 'shape', 'points', 'polygon', 'source']);

function codedError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function rejectUnknownFields(value, allowed, code, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw codedError(code, `${label}结构无效`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw codedError(code, `${label}包含未允许字段 ${key}`);
    }
  }
}

function isPathWithin(root, target) {
  const relative = path.relative(root, target);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function normalizeRelativePath(root, candidatePath) {
  if (typeof candidatePath !== 'string' || candidatePath.length === 0 || candidatePath.includes('\0')) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_PATH_INVALID', '文字净景文件路径无效');
  }

  if (
    path.isAbsolute(candidatePath)
    || path.win32.isAbsolute(candidatePath)
    || path.posix.isAbsolute(candidatePath)
    || /^[A-Za-z]:/.test(candidatePath)
  ) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_PATH_INVALID', '文字净景文件路径必须是受控根目录内的相对路径');
  }

  const segments = candidatePath.split(/[\\/]+/);
  if (segments.some((segment) => segment === '..')) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_PATH_INVALID', '文字净景文件路径不得包含 ..');
  }

  const normalized = path.normalize(candidatePath);
  if (normalized === '.' || path.isAbsolute(normalized)) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_PATH_INVALID', '文字净景文件路径无效');
  }

  const lexicalPath = path.resolve(root, normalized);
  if (!isPathWithin(root, lexicalPath)) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_PATH_INVALID', '文字净景文件路径逃逸受控根目录');
  }

  let realPath;
  try {
    realPath = fs.realpathSync.native(lexicalPath);
  } catch (error) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_PATH_INVALID', '文字净景文件不存在或不可读取', error);
  }
  if (!isPathWithin(root, realPath)) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_PATH_INVALID', '文字净景文件符号链接逃逸受控根目录');
  }

  return {
    realPath,
    relativePath: path.relative(root, lexicalPath).split(path.sep).join('/'),
  };
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function mimeForFormat(format) {
  const normalized = typeof format === 'string' ? format.toLowerCase() : '';
  return MIME_TYPES[normalized] || (normalized ? `image/${normalized}` : '');
}

async function readImageEvidence(root, evidence, label) {
  try {
    rejectUnknownFields(evidence, IMAGE_FIELDS, 'REDRAW_TEXT_CLEAN_PLATE_PATH_INVALID', label);
  } catch (error) {
    if (error.code) throw error;
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_PATH_INVALID', `${label}文件证据无效`, error);
  }

  const expectedSha = typeof evidence.sha256 === 'string' ? evidence.sha256.toLowerCase() : '';
  if (!/^[a-f0-9]{64}$/.test(expectedSha)) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_HASH_MISMATCH', `${label} SHA-256 无效`);
  }

  const resolved = normalizeRelativePath(root, evidence.path);
  let buffer;
  let metadata;
  let stat;
  try {
    stat = await fs.promises.stat(resolved.realPath);
    if (!stat.isFile()) throw new Error('not a regular file');
    buffer = await fs.promises.readFile(resolved.realPath);
    metadata = await sharp(resolved.realPath).metadata();
  } catch (error) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_PATH_INVALID', `${label}文件不存在、不可读取或不是有效图片`, error);
  }

  const actualSha = sha256Buffer(buffer);
  if (actualSha !== expectedSha) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_HASH_MISMATCH', `${label} SHA-256 与文件内容不匹配`);
  }

  const width = Number(metadata.width);
  const height = Number(metadata.height);
  const mimeType = mimeForFormat(metadata.format);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0 || !mimeType) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_DIMENSIONS_INVALID', `${label}图片元数据不可读`);
  }

  const declaredMime = typeof evidence.mime_type === 'string' ? evidence.mime_type.toLowerCase() : '';
  if (declaredMime !== mimeType) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_DIMENSIONS_INVALID', `${label} MIME 类型与图片内容不一致`);
  }
  if (Object.prototype.hasOwnProperty.call(evidence, 'width') && Number(evidence.width) !== width) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_DIMENSIONS_INVALID', `${label} 宽度声明与图片内容不一致`);
  }
  if (Object.prototype.hasOwnProperty.call(evidence, 'height') && Number(evidence.height) !== height) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_DIMENSIONS_INVALID', `${label} 高度声明与图片内容不一致`);
  }
  if (Object.prototype.hasOwnProperty.call(evidence, 'bytes') && Number(evidence.bytes) !== buffer.length) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_HASH_MISMATCH', `${label} 字节数声明与文件内容不一致`);
  }

  return {
    path: resolved.relativePath,
    sha256: actualSha,
    width,
    height,
    mime_type: mimeType,
    bytes: buffer.length,
  };
}

function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length !== ALLOWED_TEXT_SHOT_IDS.length) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_SHOTS_INVALID', '必须提供 shot-4 和 shot-8 两个文字净景镜头');
  }

  const byShotId = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw codedError('REDRAW_TEXT_CLEAN_PLATE_SHOTS_INVALID', '文字净景镜头条目结构无效');
    }
    for (const key of Object.keys(entry)) {
      if (!ENTRY_FIELDS.has(key)) {
        throw codedError('REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID', `文字净景镜头包含未允许字段 ${key}`);
      }
    }
    const shotId = entry.shot_id;
    if (!ALLOWED_TEXT_SHOT_IDS.includes(shotId) || byShotId.has(shotId)) {
      throw codedError('REDRAW_TEXT_CLEAN_PLATE_SHOTS_INVALID', '文字净景镜头只能是 shot-4、shot-8 且不得重复');
    }
    if (!TEXT_KINDS.includes(entry.text_kind) || EXPECTED_TEXT_KIND_BY_SHOT[shotId] !== entry.text_kind) {
      throw codedError('REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID', `${shotId} 文字类型不在白名单或与镜头不匹配`);
    }
    byShotId.set(shotId, entry);
  }

  if (byShotId.size !== ALLOWED_TEXT_SHOT_IDS.length) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_SHOTS_INVALID', '文字净景镜头清单不完整');
  }
  return ALLOWED_TEXT_SHOT_IDS.map((shotId) => byShotId.get(shotId));
}

function pointXY(point) {
  if (Array.isArray(point)) {
    if (point.length !== 2) return null;
    if (typeof point[0] !== 'number' || typeof point[1] !== 'number') return null;
    return { x: point[0], y: point[1], output: [point[0], point[1]] };
  }
  if (!point || typeof point !== 'object') return null;
  const keys = Object.keys(point);
  if (keys.some((key) => key !== 'x' && key !== 'y') || !Object.prototype.hasOwnProperty.call(point, 'x') || !Object.prototype.hasOwnProperty.call(point, 'y')) {
    return null;
  }
  if (typeof point.x !== 'number' || typeof point.y !== 'number') return null;
  return { x: point.x, y: point.y, output: { x: point.x, y: point.y } };
}

function normalizeRegionList(entry) {
  const hasLegacy = Object.prototype.hasOwnProperty.call(entry, 'region');
  const hasCanonical = Object.prototype.hasOwnProperty.call(entry, 'text_regions');
  if (hasLegacy === hasCanonical) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID', '必须且只能提供 region 或 text_regions');
  }

  if (hasLegacy) {
    const region = entry.region;
    rejectUnknownFields(region, REGION_FIELDS, 'REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID', '文字区域');
    if (Object.prototype.hasOwnProperty.call(region, 'shape') || Object.prototype.hasOwnProperty.call(region, 'points')) {
      throw codedError('REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID', 'legacy region 不得混用 shape/points');
    }
    if (!Array.isArray(region.polygon)) {
      throw codedError('REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID', '文字区域 polygon 无效');
    }
    return [{
      kind: region.kind,
      shape: 'polygon',
      points: region.polygon,
      source: region.source,
      legacy: true,
    }];
  }

  if (!Array.isArray(entry.text_regions) || entry.text_regions.length === 0) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID', 'text_regions 必须是非空数组');
  }
  return entry.text_regions.map((region) => {
    rejectUnknownFields(region, REGION_FIELDS, 'REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID', '文字区域');
    if (Object.prototype.hasOwnProperty.call(region, 'polygon')) {
      throw codedError('REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID', 'text_regions 必须使用 points');
    }
    return {
      kind: region.kind,
      shape: region.shape,
      points: region.points,
      source: region.source,
      legacy: false,
    };
  });
}

function validateRegions(entry, source) {
  const regions = normalizeRegionList(entry);
  const sanitized = regions.map((region) => {
    if (!TEXT_KINDS.includes(region.kind) || region.kind !== entry.text_kind) {
      throw codedError('REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID', `${entry.shot_id} 文字区域类型不匹配`);
    }
    if (region.shape !== 'polygon') {
      throw codedError('REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID', `${entry.shot_id} 文字区域形状必须是 polygon`);
    }
    if (region.source !== undefined && (typeof region.source !== 'string' || region.source.length === 0)) {
      throw codedError('REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID', `${entry.shot_id} 文字区域 source 无效`);
    }
    if (!Array.isArray(region.points) || region.points.length < 3) {
      throw codedError('REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID', `${entry.shot_id} polygon 至少需要三个点`);
    }

    const points = region.points.map(pointXY);
    if (points.some((point) => !point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y)))) {
      throw codedError('REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID', `${entry.shot_id} polygon 坐标必须是有限数字`);
    }
    const numericPoints = points.map((point) => ({ x: Number(point.x), y: Number(point.y) }));
    if (numericPoints.some((point) => point.x < 0 || point.x > source.width || point.y < 0 || point.y > source.height)) {
      throw codedError('REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID', `${entry.shot_id} polygon 坐标必须在图片边界内`);
    }
    let doubledArea = 0;
    for (let index = 0; index < numericPoints.length; index += 1) {
      const current = numericPoints[index];
      const next = numericPoints[(index + 1) % numericPoints.length];
      doubledArea += current.x * next.y - next.x * current.y;
    }
    if (!(Math.abs(doubledArea) > 0)) {
      throw codedError('REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID', `${entry.shot_id} polygon 面积必须大于零`);
    }

    const output = {
      kind: region.kind,
      shape: 'polygon',
      points: points.map((point) => point.output),
    };
    if (region.source !== undefined) output.source = region.source;
    return { ...output, legacy: region.legacy, polygon: points.map((point) => point.output) };
  });
  return sanitized;
}

function assertSameImageContract(shotId, source, mask, cleanPlate, quality) {
  if (
    source.width !== mask.width
    || source.height !== mask.height
    || source.width !== cleanPlate.width
    || source.height !== cleanPlate.height
    || source.mime_type !== mask.mime_type
    || source.mime_type !== cleanPlate.mime_type
  ) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_DIMENSIONS_INVALID', `${shotId} 源帧、文字遮罩和文字净景尺寸及 MIME 必须一致`);
  }
  if (quality && (Object.prototype.hasOwnProperty.call(quality, 'width') || Object.prototype.hasOwnProperty.call(quality, 'height'))) {
    const qualityWidth = Number(quality.width);
    const qualityHeight = Number(quality.height);
    if (!Number.isInteger(qualityWidth) || !Number.isInteger(qualityHeight) || qualityWidth !== source.width || qualityHeight !== source.height) {
      throw codedError('REDRAW_TEXT_CLEAN_PLATE_DIMENSIONS_INVALID', `${shotId} 质量尺寸与图片不一致`);
    }
  }
}

function assertQuality(quality, shotId) {
  try {
    rejectUnknownFields(quality, QUALITY_FIELDS, 'REDRAW_TEXT_CLEAN_PLATE_QUALITY_FAILED', `${shotId} 质量`);
  } catch (error) {
    if (error.code) throw error;
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_QUALITY_FAILED', `${shotId} 质量结构无效`, error);
  }
  if (
    quality.mask_area_changed !== true
    || !Number.isFinite(Number(quality.non_mask_similarity))
    || Number(quality.non_mask_similarity) < NON_MASK_SIMILARITY_MIN
    || quality.text_residual !== false
  ) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_QUALITY_FAILED', `${shotId} 文字净景质量未通过`);
  }
}

function sanitizeReview(review) {
  if (review !== undefined) {
    rejectUnknownFields(review, REVIEW_FIELDS, 'REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID', '审核结果');
  }
  const approved = review && review.status === 'approved';
  return { status: approved ? 'approved' : 'pending' };
}

async function buildTextCleanPlateManifest({ root, entries, now = new Date().toISOString() } = {}) {
  let realRoot;
  try {
    if (typeof root !== 'string' || root.length === 0) throw new Error('root is required');
    realRoot = fs.realpathSync.native(root);
    if (!fs.statSync(realRoot).isDirectory()) throw new Error('root is not a directory');
  } catch (error) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_PATH_INVALID', '文字净景受控根目录不可读取', error);
  }

  const normalizedEntries = validateEntries(entries);
  const shots = [];
  for (const entry of normalizedEntries) {
    const source = await readImageEvidence(realRoot, entry.representative_frame, `${entry.shot_id} 源帧`);
    const mask = await readImageEvidence(realRoot, entry.mask_asset, `${entry.shot_id} 文字遮罩`);
    const cleanPlate = await readImageEvidence(realRoot, entry.clean_plate, `${entry.shot_id} 文字净景`);
    assertSameImageContract(entry.shot_id, source, mask, cleanPlate, entry.quality);
    const regions = validateRegions(entry, source);
    assertQuality(entry.quality, entry.shot_id);
    const review = sanitizeReview(entry.review);
    const legacyRegion = regions.length === 1 ? {
      kind: regions[0].kind,
      polygon: regions[0].polygon,
    } : undefined;
    const textRegions = regions.map(({ legacy, polygon, ...region }) => region);
    shots.push({
      shot_id: entry.shot_id,
      mode: 'text_clean_plate',
      text_kind: entry.text_kind,
      source,
      mask,
      text_clean: cleanPlate,
      text_mask: mask,
      text_clean_plate: cleanPlate,
      ...(legacyRegion ? { region: legacyRegion } : {}),
      text_regions: textRegions,
      quality: {
        mask_area_changed: entry.quality.mask_area_changed,
        non_mask_similarity: Number(entry.quality.non_mask_similarity),
        text_residual: entry.quality.text_residual,
      },
      review,
      ready_for_reference: review.status === 'approved',
    });
  }

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: now,
    mode: 'text_clean_plate',
    shots,
  };
}

module.exports = {
  ALLOWED_TEXT_SHOT_IDS,
  TEXT_KINDS,
  NON_MASK_SIMILARITY_MIN,
  buildTextCleanPlateManifest,
};
