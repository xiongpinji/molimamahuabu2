const fs = require('fs');
const path = require('path');
const multer = require('multer');
const response = require('../response');
const assetService = require('../services/assetService');
const uploadService = require('../services/uploadService');
const storageLayout = require('../services/storageLayout');

const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
const rechargePackageImageRules = {
  'image/jpeg': { family: 'jpeg', extension: '.jpg' },
  'image/jpg': { family: 'jpeg', extension: '.jpg' },
  'image/png': { family: 'png', extension: '.png' },
  'image/webp': { family: 'webp', extension: '.webp' },
};
const allowedRechargePackageImageTypes = Object.keys(rechargePackageImageRules);
const maxSize = 16 * 1024 * 1024; // 16MB，单张图片上限
const MAX_SIZE_MB = 16;
const allowedMediaTypes = [
  ...allowedTypes,
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/m4a',
  'audio/aac',
  'audio/ogg',
  'audio/webm',
  'audio/flac',
  'audio/x-flac',
];
const mediaSizeLimits = {
  image: 16 * 1024 * 1024,
  audio: 32 * 1024 * 1024,
  video: 128 * 1024 * 1024,
};
const mediaMaxSize = mediaSizeLimits.video;
const mediaFamilyRules = {
  png: { mimeTypes: ['image/png'], extensions: ['.png'], extension: '.png', type: 'image', mimeType: 'image/png' },
  jpeg: { mimeTypes: ['image/jpeg', 'image/jpg'], extensions: ['.jpg', '.jpeg'], extension: '.jpg', type: 'image', mimeType: 'image/jpeg' },
  gif: { mimeTypes: ['image/gif'], extensions: ['.gif'], extension: '.gif', type: 'image', mimeType: 'image/gif' },
  webp: { mimeTypes: ['image/webp'], extensions: ['.webp'], extension: '.webp', type: 'image', mimeType: 'image/webp' },
  mp4: { mimeTypes: ['video/mp4'], extensions: ['.mp4'], extension: '.mp4', type: 'video', mimeType: 'video/mp4' },
  mov: { mimeTypes: ['video/quicktime'], extensions: ['.mov'], extension: '.mov', type: 'video', mimeType: 'video/quicktime' },
  m4a: { mimeTypes: ['audio/mp4', 'audio/m4a'], extensions: ['.m4a', '.m4b'], extension: '.m4a', type: 'audio', mimeType: 'audio/mp4' },
  webm: { mimeTypes: ['video/webm', 'audio/webm'], extensions: ['.webm'], extension: '.webm' },
  wav: { mimeTypes: ['audio/wav', 'audio/x-wav'], extensions: ['.wav'], extension: '.wav', type: 'audio', mimeType: 'audio/wav' },
  mp3: { mimeTypes: ['audio/mpeg', 'audio/mp3'], extensions: ['.mp3'], extension: '.mp3', type: 'audio', mimeType: 'audio/mpeg' },
  ogg: { mimeTypes: ['audio/ogg'], extensions: ['.ogg', '.oga'], extension: '.ogg', type: 'audio', mimeType: 'audio/ogg' },
  flac: { mimeTypes: ['audio/flac', 'audio/x-flac'], extensions: ['.flac'], extension: '.flac', type: 'audio', mimeType: 'audio/flac' },
  aac: { mimeTypes: ['audio/aac'], extensions: ['.aac'], extension: '.aac', type: 'audio', mimeType: 'audio/aac' },
};

const memoryStorage = multer.memoryStorage();
const upload = multer({
  storage: memoryStorage,
  limits: { fileSize: maxSize },
  fileFilter: (req, file, cb) => {
    const ct = file.mimetype || 'application/octet-stream';
    if (!allowedTypes.includes(ct)) {
      return cb(new Error('只支持图片格式 (jpg, png, gif, webp)'));
    }
    cb(null, true);
  },
});

const rechargePackageImageUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: maxSize },
  fileFilter: (req, file, cb) => {
    const ct = file.mimetype || 'application/octet-stream';
    if (!allowedRechargePackageImageTypes.includes(ct)) {
      return cb(new Error('套餐广告图只支持 jpg、png、webp'));
    }
    cb(null, true);
  },
});

// Seedance 2.0 音色参考音频上传（支持常见音频格式）
const allowedAudioTypes = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/m4a',
  'audio/ogg',
  'audio/webm',
];
const audioMaxSize = 10 * 1024 * 1024; // 10MB
const audioUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: audioMaxSize },
  fileFilter: (req, file, cb) => {
    const ct = file.mimetype || 'application/octet-stream';
    if (!allowedAudioTypes.includes(ct)) {
      return cb(new Error('只支持音频格式 (mp3, wav, m4a, ogg)'));
    }
    cb(null, true);
  },
});

const mediaUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: mediaMaxSize },
  fileFilter: (req, file, cb) => {
    const ct = file.mimetype || 'application/octet-stream';
    if (!allowedMediaTypes.includes(ct)) {
      return cb(new Error('只支持图片、视频或音频素材格式'));
    }
    cb(null, true);
  },
});

// 导演台三维资源：只接收自包含的 GLB/VRM，避免单独 .gltf 引用未上传的外部贴图/二进制文件。
const modelMaxSize = 128 * 1024 * 1024;
const modelUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: modelMaxSize },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!['.glb', '.vrm'].includes(ext)) {
      return cb(new Error('三维资源只支持 GLB 或 VRM 格式'));
    }
    cb(null, true);
  },
});

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function resolveStorage(cfg) {
  const rawStorage = cfg?.storage?.local_path || './data/storage';
  return {
    storagePath: path.isAbsolute(rawStorage) ? rawStorage : path.join(process.cwd(), rawStorage),
    baseUrl: cfg?.storage?.base_url || '',
  };
}

function saveImageUpload(
  cfg,
  log,
  req,
  res,
  category,
  projectSubdir = null,
  storedName = req.file.originalname || 'image.png',
) {
  const { storagePath, baseUrl } = resolveStorage(cfg);
  const result = uploadService.uploadFile(
    storagePath,
    baseUrl,
    log,
    req.file.buffer,
    storedName,
    req.file.mimetype,
    category,
    projectSubdir,
  );
  return response.success(res, {
    url: result.url,
    path: result.local_path,
    local_path: result.local_path,
    filename: req.file.originalname,
    size: req.file.size,
  });
}

function resolveMediaType(mimeType) {
  const ct = mimeType || '';
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('audio/')) return 'audio';
  return 'image';
}

function bufferStartsWith(buffer, signature) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= signature.length
    && buffer.subarray(0, signature.length).equals(signature);
}

function detectMediaFamily(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (bufferStartsWith(buffer, Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  const prefix = buffer.subarray(0, 12).toString('ascii');
  if (prefix.startsWith('GIF87a') || prefix.startsWith('GIF89a')) return 'gif';
  if (prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP') return 'webp';
  if (prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WAVE') return 'wav';
  if (bufferStartsWith(buffer, Buffer.from('1a45dfa3', 'hex'))
    && buffer.subarray(0, 64).toString('ascii').includes('webm')) return 'webm';
  if (prefix.startsWith('OggS')) return 'ogg';
  if (prefix.startsWith('fLaC')) return 'flac';
  if (prefix.startsWith('ID3')) return 'mp3';
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0) return 'aac';
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'mp3';
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii');
    if (brand === 'qt  ') return 'mov';
    if (brand === 'M4A ' || brand === 'M4B ') return 'm4a';
    return 'mp4';
  }
  return null;
}

function identifyMediaUpload(buffer, declaredMimeType, originalName) {
  const family = detectMediaFamily(buffer);
  const rule = family ? mediaFamilyRules[family] : null;
  const mimeType = String(declaredMimeType || '').toLowerCase();
  const extension = path.extname(path.basename(String(originalName || ''))).toLowerCase();
  if (!rule || !rule.mimeTypes.includes(mimeType) || !rule.extensions.includes(extension)) return null;
  return {
    family,
    extension: rule.extension,
    type: rule.type || resolveMediaType(mimeType),
    mimeType: rule.mimeType || mimeType,
  };
}

function safeAssetName(rawName, extension) {
  const source = path.basename(String(rawName || ''));
  const stem = path.basename(source, path.extname(source))
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .trim()
    .slice(0, 120);
  return `${stem || '上传素材'}${extension}`;
}

function removeUploadedFile(storagePath, localPath, log) {
  if (!localPath) return;
  const storageRoot = path.resolve(storagePath);
  const filePath = path.resolve(storagePath, localPath);
  if (!filePath.startsWith(`${storageRoot}${path.sep}`)) return;
  try {
    fs.rmSync(filePath, { force: true });
  } catch (err) {
    log.warn('remove failed media upload', { path: filePath, error: err.message });
  }
}

function assertOwnedDrama(db, req, dramaId) {
  if (!db) return true;
  if (!req.user?.id) return false;
  const row = db.prepare(
    `SELECT id FROM dramas
     WHERE id = ?
       AND deleted_at IS NULL
       AND (
         (? IS NOT NULL AND tenant_id = ?)
         OR (? IS NOT NULL AND user_id = ? AND tenant_id IS NULL)
       )`
  ).get(
    dramaId,
    req.tenant?.id || null,
    req.tenant?.id || null,
    req.user?.id || null,
    req.user?.id || null,
  );
  return Boolean(row);
}

function dramaExists(db, dramaId) {
  if (!db) return true;
  return Boolean(db.prepare(
    'SELECT id FROM dramas WHERE id = ? AND deleted_at IS NULL',
  ).get(dramaId));
}

function routes(cfg, log, db, options = {}) {
  const singleUpload = upload.single('file');
  const rechargePackageImageSingleUpload = rechargePackageImageUpload.single('file');
  const publicPlatformEnabled = Boolean(options.publicPlatformEnabled);
  const mediaSingleUpload = mediaUpload.single('file');
  return {
    multerSingle: singleUpload,
    multerRechargePackageImageSingle: (req, res, next) => {
      rechargePackageImageSingleUpload(req, res, (err) => {
        if (!err) return next();
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          return response.error(res, 413, 'FILE_TOO_LARGE', '套餐广告图不能超过 16MB');
        }
        return response.badRequest(res, err.message || '套餐广告图上传失败');
      });
    },
    multerModelSingle: modelUpload.single('file'),
    multerMediaSingle: (req, res, next) => {
      mediaSingleUpload(req, res, (err) => {
        if (!err) return next();
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          return response.error(res, 413, 'FILE_TOO_LARGE', '素材文件不能超过 128MB');
        }
        return response.badRequest(res, err.message || '素材文件格式不受支持');
      });
    },
    uploadImage: (req, res) => {
      if (!req.file || !req.file.buffer) {
        return response.badRequest(res, '请选择文件');
      }
      try {
        let projectSubdir = null;
        if (db) {
          const raw = req.body?.drama_id;
          const did =
            raw !== undefined && raw !== null && String(raw).trim() !== ''
              ? Number(raw)
              : NaN;
          if (Number.isFinite(did) && did > 0) {
            projectSubdir = storageLayout.getProjectStorageSubdir(db, did);
          }
        }
        saveImageUpload(cfg, log, req, res, 'uploads', projectSubdir);
      } catch (err) {
        log.error('upload image', { error: err.message });
        response.internalError(res, err.message || '上传失败');
      }
    },
    uploadRechargePackageImage: (req, res) => {
      if (!req.file || !Buffer.isBuffer(req.file.buffer)) {
        return response.badRequest(res, '请选择文件');
      }
      const imageRule = rechargePackageImageRules[req.file.mimetype];
      if (!imageRule || detectMediaFamily(req.file.buffer) !== imageRule.family) {
        return response.badRequest(res, '套餐广告图只支持 jpg、png、webp');
      }
      try {
        return saveImageUpload(
          cfg,
          log,
          req,
          res,
          'uploads/recharge-packages',
          null,
          `recharge-package${imageRule.extension}`,
        );
      } catch (err) {
        log.error('upload recharge package image', { error: err.message });
        return response.internalError(res, err.message || '上传失败');
      }
    },
    uploadModel: (req, res) => {
      if (!req.file || !req.file.buffer) {
        return response.badRequest(res, '请选择 GLB 或 VRM 文件');
      }
      try {
        const rawStorage = cfg?.storage?.local_path || './data/storage';
        const storagePath = path.isAbsolute(rawStorage)
          ? rawStorage
          : path.join(process.cwd(), rawStorage);
        const baseUrl = cfg?.storage?.base_url || '';
        let projectSubdir = null;
        let did = NaN;
        if (db) {
          const raw = req.body?.drama_id;
          did = raw !== undefined && raw !== null && String(raw).trim() !== '' ? Number(raw) : NaN;
          if (Number.isFinite(did) && did > 0) projectSubdir = storageLayout.getProjectStorageSubdir(db, did);
        }
        const result = uploadService.uploadFile(
          storagePath,
          baseUrl,
          log,
          req.file.buffer,
          req.file.originalname || 'model.glb',
          req.file.mimetype,
          'models',
          projectSubdir,
        );
        let asset = null;
        if (db && Number.isFinite(did) && did > 0) {
          asset = assetService.create(db, log, {
            drama_id: did,
            name: req.file.originalname || '未命名三维资源',
            type: 'model',
            category: 'director',
            url: result.url,
            local_path: result.local_path,
            file_size: req.file.size,
            mime_type: req.file.mimetype,
          });
        }
        response.success(res, {
          url: result.url,
          path: result.local_path,
          local_path: result.local_path,
          filename: req.file.originalname,
          size: req.file.size,
          asset_id: asset?.id || null,
          asset,
        });
      } catch (err) {
        log.error('upload model', { error: err.message });
        response.internalError(res, err.message || '三维资源上传失败');
      }
    },
    uploadMedia: (req, res) => {
      if (!req.file || !req.file.buffer) {
        return response.badRequest(res, '请选择素材文件');
      }
      if (publicPlatformEnabled && !req.user?.id) {
        return response.error(res, 401, 'UNAUTHORIZED', '请先登录');
      }
      const dramaId = toPositiveInt(req.body?.drama_id);
      if (!dramaId) return response.badRequest(res, '请选择素材所属项目');
      if ((req.user?.id || req.tenant?.id) && !assertOwnedDrama(db, req, dramaId)) {
        return response.notFound(res, '项目不存在');
      }
      if (!req.user?.id && !req.tenant?.id && !dramaExists(db, dramaId)) {
        return response.notFound(res, '项目不存在');
      }
      const identified = identifyMediaUpload(
        req.file.buffer,
        req.file.mimetype,
        req.file.originalname,
      );
      if (!identified) {
        return response.badRequest(res, '素材文件内容、格式或扩展名不一致');
      }
      try {
        const { storagePath, baseUrl } = resolveStorage(cfg);
        const projectSubdir = db ? storageLayout.getProjectStorageSubdir(db, dramaId) : null;
        if (req.file.size > mediaSizeLimits[identified.type]) {
          const limitMb = mediaSizeLimits[identified.type] / 1024 / 1024;
          return response.error(res, 413, 'FILE_TOO_LARGE', `${identified.type} 素材不能超过 ${limitMb}MB`);
        }
        const displayName = safeAssetName(
          req.body?.name || req.file.originalname,
          identified.extension,
        );
        const result = uploadService.uploadFile(
          storagePath,
          baseUrl,
          log,
          req.file.buffer,
          `media${identified.extension}`,
          identified.mimeType,
          'assets',
          projectSubdir
        );
        let asset = null;
        try {
          asset = db ? assetService.create(db, log, {
            drama_id: dramaId,
            name: displayName,
            type: identified.type,
            category: 'library',
            url: result.url,
            local_path: result.local_path,
            file_size: req.file.size,
            mime_type: identified.mimeType,
            metadata: {
              source: 'media_library_upload',
              original_filename: safeAssetName(req.file.originalname, identified.extension),
            },
          }) : null;
          if (db && !asset) throw new Error('素材资产记录创建失败');
        } catch (err) {
          removeUploadedFile(storagePath, result.local_path, log);
          throw err;
        }
        response.created(res, asset);
      } catch (err) {
        log.error('upload media', { error: err.message });
        response.internalError(res, err.message || '素材上传失败');
      }
    },
  };
}

module.exports = {
  routes,
  upload,
  modelUpload,
  mediaUpload,
  multerSingle: upload.single('file'),
  multerModelSingle: modelUpload.single('file'),
  multerMediaSingle: mediaUpload.single('file'),
  multerAudioSingle: audioUpload.single('file'),
  MAX_IMAGE_SIZE_MB: MAX_SIZE_MB,
  identifyMediaUpload,
};
