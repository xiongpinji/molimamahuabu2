const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov']);
const ZIP_EXTENSIONS = new Set(['.zip']);

function uploadError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function getFileSize(file) {
  const explicit = Number(file?.size);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  return fs.statSync(file.path).size;
}

function assertFileSize(file, limits = {}) {
  const maxBytes = limits.maxBytes ?? limits.maxFileBytes;
  if (maxBytes != null && getFileSize(file) > Number(maxBytes)) {
    throw uploadError('REDRAW_SOURCE_TOO_LARGE', '转绘源文件超过大小限制');
  }
}

function extensionKind(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) {
    throw uploadError('REDRAW_SOURCE_EXTENSION_UNSUPPORTED', '仅支持 mp4/mov 源片');
  }
  return ext.slice(1);
}

function assertMime(kind, mimetype) {
  const mime = String(mimetype || '').toLowerCase();
  if (!mime || mime === 'application/octet-stream') return;
  const allowed = kind === 'mov'
    ? new Set(['video/quicktime', 'video/mov'])
    : new Set(['video/mp4', 'application/mp4']);
  if (!allowed.has(mime)) {
    throw uploadError('REDRAW_SOURCE_MIME_UNSUPPORTED', '源片 MIME 与扩展名不匹配');
  }
}

function hasVideoMagic(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(12);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return bytes >= 12 && buffer.slice(4, 8).toString('ascii') === 'ftyp';
  } finally {
    fs.closeSync(fd);
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function durationRange(limits = {}) {
  return {
    min: Number(limits.minDurationMs ?? 15000),
    max: Number(limits.maxDurationMs ?? 3600000),
  };
}

function normalizeProbeResult(raw) {
  const durationMs = raw?.duration_ms ?? (raw?.duration != null ? Number(raw.duration) * 1000 : null);
  return {
    duration_ms: Math.round(Number(durationMs)),
    width: Math.round(Number(raw?.width)),
    height: Math.round(Number(raw?.height)),
  };
}

async function validateSourceFile(file, limits = {}, probeVideo) {
  if (!file?.path) throw uploadError('REDRAW_SOURCE_FILE_REQUIRED', '缺少转绘源文件');
  assertFileSize(file, limits);
  const kind = extensionKind(file.originalname || file.path);
  assertMime(kind, file.mimetype);
  if (!hasVideoMagic(file.path)) {
    throw uploadError('REDRAW_SOURCE_MAGIC_MISMATCH', '源片文件头与视频格式不匹配');
  }
  if (typeof probeVideo !== 'function') {
    throw uploadError('REDRAW_SOURCE_PROBE_REQUIRED', '缺少视频探测器');
  }
  const facts = normalizeProbeResult(await probeVideo(file.path));
  if (!Number.isFinite(facts.duration_ms) || facts.duration_ms <= 0) {
    throw uploadError('REDRAW_SOURCE_PROBE_INVALID', '无法读取源片时长');
  }
  if (!Number.isFinite(facts.width) || facts.width <= 0 || !Number.isFinite(facts.height) || facts.height <= 0) {
    throw uploadError('REDRAW_SOURCE_PROBE_INVALID', '无法读取源片分辨率');
  }
  const { min, max } = durationRange(limits);
  if (facts.duration_ms < min || facts.duration_ms > max) {
    throw uploadError('REDRAW_SOURCE_DURATION_OUT_OF_RANGE', '源片时长超出限制');
  }
  return {
    kind,
    duration_ms: facts.duration_ms,
    width: facts.width,
    height: facts.height,
    sha256: sha256File(file.path),
  };
}

function safeZipEntry(entry) {
  const rawName = typeof entry === 'string' ? entry : entry?.entryName;
  const name = String(rawName || '').replace(/\\/g, '/');
  if (!name || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw uploadError('REDRAW_ZIP_UNSAFE_PATH', 'ZIP 条目路径不安全');
  }
  const parts = name.split('/');
  if (parts.some((part) => part === '..') || path.posix.normalize(name).startsWith('../')) {
    throw uploadError('REDRAW_ZIP_UNSAFE_PATH', 'ZIP 条目路径不安全');
  }
  extensionKind(name);
  return name;
}

function isZipUpload(file) {
  const ext = path.extname(String(file?.originalname || file?.path || '')).toLowerCase();
  const mime = String(file?.mimetype || '').toLowerCase();
  return ZIP_EXTENSIONS.has(ext) || mime === 'application/zip' || mime === 'application/x-zip-compressed';
}

function controlledUrl(prefix, facts) {
  const safePrefix = String(prefix || '/static/redraw-sources').replace(/\/+$/, '');
  return `${safePrefix}/${facts.sha256}.${facts.kind}`;
}

function resolveStorageRoot(limits = {}) {
  const raw = limits.storageRoot || limits.storageLocalPath || './data/storage';
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

function persistSourceFile(sourcePath, facts, limits = {}) {
  const relPath = `redraw-sources/${facts.sha256}.${facts.kind}`;
  const storageRoot = resolveStorageRoot(limits);
  const targetPath = path.resolve(storageRoot, relPath);
  const resolvedRoot = path.resolve(storageRoot);
  if (!targetPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw uploadError('REDRAW_STORAGE_PATH_UNSAFE', '源片存储路径不安全');
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const sourceSize = fs.statSync(sourcePath).size;
  if (fs.existsSync(targetPath)) {
    const targetSize = fs.statSync(targetPath).size;
    if (targetSize !== sourceSize || sha256File(targetPath) !== facts.sha256) {
      throw uploadError('REDRAW_STORAGE_CONFLICT', '已存在的源片文件不完整或内容不匹配');
    }
    return relPath;
  }

  const tempPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.copyFileSync(sourcePath, tempPath);
    if (fs.statSync(tempPath).size !== sourceSize || sha256File(tempPath) !== facts.sha256) {
      throw uploadError('REDRAW_STORAGE_WRITE_FAILED', '源片持久化校验失败');
    }
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
  return relPath;
}

function toUploadItem(name, facts, prefix, localPath = null) {
  return {
    name,
    kind: facts.kind,
    duration_ms: facts.duration_ms,
    width: facts.width,
    height: facts.height,
    sha256: facts.sha256,
    source_fingerprint: facts.sha256,
    local_path: localPath,
    url: localPath ? `/static/${localPath}` : controlledUrl(prefix, facts),
  };
}

function assertZipSize(file, limits = {}) {
  assertFileSize(file, limits);
}

async function expandZipUpload(file, limits, probeVideo) {
  let zip;
  let entries;
  try {
    zip = new AdmZip(file.path);
    entries = zip.getEntries().filter((entry) => !entry.isDirectory);
  } catch (_) {
    throw uploadError('REDRAW_ZIP_INVALID', 'ZIP 文件损坏或格式不受支持');
  }
  const maxEntries = Number(limits.zipMaxEntries ?? 20);
  if (entries.length > maxEntries) {
    throw uploadError('REDRAW_ZIP_TOO_MANY_ENTRIES', 'ZIP 源片数量超过限制');
  }

  let totalBytes = 0;
  for (const entry of entries) {
    safeZipEntry(entry);
    totalBytes += Number(entry.header?.size || 0);
    if (limits.zipMaxTotalBytes != null && totalBytes > Number(limits.zipMaxTotalBytes)) {
      throw uploadError('REDRAW_ZIP_EXPANDED_TOO_LARGE', 'ZIP 展开后超过大小限制');
    }
  }

  const tempRoot = limits.tempRoot || os.tmpdir();
  const extractDir = fs.mkdtempSync(path.join(tempRoot, 'redraw-upload-'));
  try {
    const items = [];
    for (const entry of entries) {
      const entryName = safeZipEntry(entry);
      const targetPath = path.join(extractDir, entryName);
      const resolved = path.resolve(targetPath);
      const root = path.resolve(extractDir);
      if (!resolved.startsWith(root + path.sep)) {
        throw uploadError('REDRAW_ZIP_UNSAFE_PATH', 'ZIP 条目路径不安全');
      }
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      let data;
      try {
        data = entry.getData();
      } catch (_) {
        throw uploadError('REDRAW_ZIP_ENTRY_READ_FAILED', 'ZIP 条目读取失败');
      }
      fs.writeFileSync(resolved, data);
      const facts = await validateSourceFile(
        {
          path: resolved,
          originalname: path.basename(entryName),
          mimetype: path.extname(entryName).toLowerCase() === '.mov' ? 'video/quicktime' : 'video/mp4',
          size: fs.statSync(resolved).size,
        },
        {
          maxBytes: limits.zipMaxEntryBytes ?? limits.maxBytes,
          minDurationMs: limits.zipMinDurationMs ?? 15000,
          maxDurationMs: limits.zipMaxDurationMs ?? 180000,
        },
        probeVideo,
      );
      const localPath = persistSourceFile(resolved, facts, limits);
      items.push(toUploadItem(entryName, facts, limits.assetUrlPrefix, localPath));
    }
    return items;
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

async function expandSourceUpload(file, limits = {}, probeVideo) {
  if (isZipUpload(file)) {
    assertZipSize(file, limits);
    return expandZipUpload(file, limits, probeVideo);
  }
  const facts = await validateSourceFile(file, limits, probeVideo);
  const localPath = persistSourceFile(file.path, facts, limits);
  return [toUploadItem(file.originalname || path.basename(file.path), facts, limits.assetUrlPrefix, localPath)];
}

module.exports = {
  validateSourceFile,
  safeZipEntry,
  expandSourceUpload,
};
