'use strict';

const fs = require('node:fs');
const path = require('node:path');

const IMAGE_TYPES = Object.freeze({
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
});
const VIDEO_TYPES = Object.freeze({ '.mp4': 'video/mp4' });
const AUDIO_TYPES = Object.freeze({ '.mp3': 'audio/mpeg', '.wav': 'audio/wav' });
const ASSET_SIZE_LIMITS = Object.freeze({
  image: Object.freeze({ bytes: 16 * 1024 * 1024, label: '图片', megabytes: 16 }),
  audio: Object.freeze({ bytes: 32 * 1024 * 1024, label: '音频', megabytes: 32 }),
  video: Object.freeze({ bytes: 128 * 1024 * 1024, label: '视频', megabytes: 128 }),
});

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function decodedPathname(value) {
  let current = String(value || '');
  for (let index = 0; index < 3; index += 1) {
    let decoded;
    try {
      decoded = decodeURIComponent(current);
    } catch (_) {
      throw codedError('FUMIN_REFERENCE_ASSET_INVALID', 'Fumin 参考素材路径无效');
    }
    if (decoded === current) break;
    current = decoded;
  }
  return current.replace(/\\/g, '/');
}

function localStaticPath(rawUrl, filesBaseUrl, storageRoot, kind) {
  const raw = String(rawUrl || '').trim();
  let pathname = raw;
  if (/^https:\/\//i.test(raw)) {
    const inputUrl = new URL(raw);
    let baseUrl = null;
    try { baseUrl = new URL(String(filesBaseUrl || '').trim()); } catch (_) {}
    if (!baseUrl || inputUrl.origin !== baseUrl.origin) return null;
    pathname = inputUrl.pathname;
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    throw codedError('FUMIN_REFERENCE_ASSET_INVALID', 'Fumin 参考素材协议无效');
  } else {
    pathname = raw.split(/[?#]/, 1)[0];
  }
  const decoded = decodedPathname(pathname);
  const normalized = path.posix.normalize(decoded);
  if (decoded !== normalized || !normalized.startsWith('/static/')) {
    throw codedError('FUMIN_REFERENCE_ASSET_INVALID', 'Fumin 参考素材路径无效');
  }
  const relative = normalized.slice('/static/'.length);
  if (!relative || relative.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw codedError('FUMIN_REFERENCE_ASSET_INVALID', 'Fumin 参考素材路径无效');
  }
  const configuredRoot = String(storageRoot || '').trim();
  if (!configuredRoot) {
    throw codedError('FUMIN_REFERENCE_ASSET_INVALID', 'Fumin 参考素材缺少隔离存储根目录');
  }
  const root = path.resolve(configuredRoot);
  const target = path.resolve(root, ...relative.split('/'));
  if (!isInside(root, target)) {
    throw codedError('FUMIN_REFERENCE_ASSET_INVALID', 'Fumin 参考素材路径越界');
  }
  let realRoot;
  let realTarget;
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw new Error('not a regular file');
    const sizeLimit = ASSET_SIZE_LIMITS[kind];
    if (!sizeLimit) throw codedError('FUMIN_REFERENCE_ASSET_INVALID', 'Fumin 参考素材类型无效');
    if (stat.size > sizeLimit.bytes) {
      throw codedError(
        'FUMIN_REFERENCE_ASSET_TOO_LARGE',
        `Fumin ${sizeLimit.label}参考素材不能超过 ${sizeLimit.megabytes}MB`,
      );
    }
    realRoot = fs.realpathSync.native(root);
    realTarget = fs.realpathSync.native(target);
    fs.accessSync(realTarget, fs.constants.R_OK);
  } catch (error) {
    if (error?.code === 'FUMIN_REFERENCE_ASSET_TOO_LARGE') throw error;
    throw codedError('FUMIN_REFERENCE_ASSET_INVALID', 'Fumin 参考素材文件不可读取');
  }
  if (!isInside(realRoot, realTarget)) {
    throw codedError('FUMIN_REFERENCE_ASSET_INVALID', 'Fumin 参考素材路径越界');
  }
  return realTarget;
}

function mimeTypeFor(kind, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const table = kind === 'image' ? IMAGE_TYPES : kind === 'video' ? VIDEO_TYPES : kind === 'audio' ? AUDIO_TYPES : null;
  const mimeType = table?.[extension];
  if (!mimeType) throw codedError('FUMIN_REFERENCE_ASSET_INVALID', 'Fumin 参考素材类型无效');
  return mimeType;
}

async function resolveFuminReference(input = {}) {
  const raw = String(input.rawUrl || '').trim();
  if (!raw) return null;
  if (raw.startsWith('asset://')) return raw;
  const localPath = localStaticPath(raw, input.filesBaseUrl, input.storageRoot, input.kind);
  if (!localPath) return raw;
  if (typeof input.uploadAsset !== 'function') {
    throw codedError('FUMIN_REFERENCE_UPLOAD_UNAVAILABLE', 'Fumin 参考素材上传器未配置');
  }
  const result = await input.uploadAsset({
    bytes: fs.readFileSync(localPath),
    filename: path.basename(localPath),
    mimeType: mimeTypeFor(input.kind, localPath),
  });
  const url = String(result?.url || '').trim();
  if (!/^https:\/\//i.test(url)) {
    throw codedError('FUMIN_REFERENCE_URL_INVALID', 'Fumin 参考素材上传未返回 HTTPS URL');
  }
  return url;
}

module.exports = {
  resolveFuminReference,
};
