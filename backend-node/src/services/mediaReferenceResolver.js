'use strict';

const fs = require('fs');
const path = require('path');

const TYPE_LABELS = {
  image: '图片',
  audio: '音频',
  video: '视频',
};

const DEFAULT_MAX_BYTES = {
  image: 20 * 1024 * 1024,
  audio: 50 * 1024 * 1024,
  video: 200 * 1024 * 1024,
};

function storedMediaKey(rawValue, filesBaseUrl) {
  const value = String(rawValue || '').trim();
  if (!value || value.startsWith('data:')) return null;
  let pathname = '';
  if (/^https?:\/\//i.test(value)) {
    if (!filesBaseUrl) return null;
    try {
      const source = new URL(value);
      const base = new URL(filesBaseUrl);
      if (source.origin !== base.origin) return null;
      const basePath = base.pathname.replace(/\/+$/, '');
      if (basePath && source.pathname !== basePath && !source.pathname.startsWith(`${basePath}/`)) return null;
      pathname = source.pathname.slice(basePath.length);
    } catch (_) {
      return null;
    }
  } else {
    pathname = value.split(/[?#]/)[0];
  }
  try {
    const key = decodeURIComponent(pathname)
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/^static\/+/, '');
    if (!key) return null;
    if (key.split('/').some((segment) => segment === '..')) {
      throw new Error('参考素材本地路径无效');
    }
    return key;
  } catch (error) {
    if (/路径无效/.test(error.message)) throw error;
    throw new Error('参考素材本地路径无效');
  }
}

function detectMediaMime(bytes, fileName = '') {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { type: 'image', mimeType: 'image/jpeg' };
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image', mimeType: 'image/png' };
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return { type: 'image', mimeType: 'image/webp' };
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return { type: 'image', mimeType: 'image/gif' };

  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE') return { type: 'audio', mimeType: 'audio/wav' };
  if (bytes.length >= 3 && bytes.subarray(0, 3).toString('ascii') === 'ID3') return { type: 'audio', mimeType: 'audio/mpeg' };
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return { type: 'audio', mimeType: ['.aac', '.adts'].includes(path.extname(fileName).toLowerCase()) ? 'audio/aac' : 'audio/mpeg' };
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii') === 'OggS') return { type: 'audio', mimeType: 'audio/ogg' };
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii') === 'fLaC') return { type: 'audio', mimeType: 'audio/flac' };

  if (bytes.length >= 8 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    const extension = path.extname(fileName).toLowerCase();
    return ['.m4a', '.m4b', '.aac'].includes(extension)
      ? { type: 'audio', mimeType: 'audio/mp4' }
      : { type: 'video', mimeType: 'video/mp4' };
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { type: 'video', mimeType: 'video/webm' };
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'AVI ') return { type: 'video', mimeType: 'video/x-msvideo' };
  return null;
}

function readStoredMediaReference(rawValue, options = {}) {
  const rootValue = String(options.storageLocalPath || '').trim();
  if (!rootValue) return null;
  const key = storedMediaKey(rawValue, options.filesBaseUrl);
  if (!key) return null;
  const root = path.resolve(rootValue);
  const localPath = path.resolve(root, key);
  const relative = path.relative(root, localPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('参考素材本地路径无效');
  }
  if (!fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) return null;
  const bytes = fs.readFileSync(localPath);
  const expectedType = TYPE_LABELS[options.expectedType] ? options.expectedType : '';
  const label = TYPE_LABELS[expectedType] || '素材';
  if (!bytes.length) throw new Error(`本地参考${label}内容为空`);
  const maxBytes = Number(options.maxBytes) > 0
    ? Number(options.maxBytes)
    : (DEFAULT_MAX_BYTES[expectedType] || DEFAULT_MAX_BYTES.video);
  if (bytes.length > maxBytes) throw new Error(`参考${label}超过 ${Math.ceil(maxBytes / 1024 / 1024)}MB 限制`);
  const detected = detectMediaMime(bytes, localPath);
  if (!detected || (expectedType && detected.type !== expectedType)) {
    throw new Error(`本地参考素材不是有效的${label}`);
  }
  return {
    bytes,
    mimeType: detected.mimeType,
    fileName: path.basename(localPath),
    localPath,
  };
}

function toMediaDataUrl(media) {
  return media ? `data:${media.mimeType};base64,${media.bytes.toString('base64')}` : '';
}

module.exports = {
  detectMediaMime,
  readStoredMediaReference,
  storedMediaKey,
  toMediaDataUrl,
};
