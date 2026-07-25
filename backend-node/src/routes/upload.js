const path = require('path');
const multer = require('multer');
const response = require('../response');
const assetService = require('../services/assetService');
const uploadService = require('../services/uploadService');
const storageLayout = require('../services/storageLayout');

const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
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

function resolveMediaType(mimeType) {
  const ct = mimeType || '';
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('audio/')) return 'audio';
  return 'image';
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
  const publicPlatformEnabled = Boolean(options.publicPlatformEnabled);
  const mediaSingleUpload = mediaUpload.single('file');
  return {
    multerSingle: singleUpload,
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
        const rawStorage = cfg?.storage?.local_path || './data/storage';
        const storagePath = path.isAbsolute(rawStorage)
          ? rawStorage
          : path.join(process.cwd(), rawStorage);
        const baseUrl = cfg?.storage?.base_url || '';
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
        const result = uploadService.uploadFile(
          storagePath,
          baseUrl,
          log,
          req.file.buffer,
          req.file.originalname || 'image.png',
          req.file.mimetype,
          'uploads',
          projectSubdir
        );
        response.success(res, {
          url: result.url,
          path: result.local_path,
          local_path: result.local_path,
          filename: req.file.originalname,
          size: req.file.size,
        });
      } catch (err) {
        log.error('upload image', { error: err.message });
        response.internalError(res, err.message || '上传失败');
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
      try {
        const { storagePath, baseUrl } = resolveStorage(cfg);
        const projectSubdir = db ? storageLayout.getProjectStorageSubdir(db, dramaId) : null;
        const type = resolveMediaType(req.file.mimetype);
        if (req.file.size > mediaSizeLimits[type]) {
          const limitMb = mediaSizeLimits[type] / 1024 / 1024;
          return response.error(res, 413, 'FILE_TOO_LARGE', `${type} 素材不能超过 ${limitMb}MB`);
        }
        const result = uploadService.uploadFile(
          storagePath,
          baseUrl,
          log,
          req.file.buffer,
          req.file.originalname || 'media',
          req.file.mimetype,
          'assets',
          projectSubdir
        );
        const asset = db ? assetService.create(db, log, {
          drama_id: dramaId,
          name: req.body?.name || req.file.originalname || '未命名素材',
          type,
          category: 'library',
          url: result.url,
          local_path: result.local_path,
          file_size: req.file.size,
          mime_type: req.file.mimetype,
          metadata: {
            source: 'media_library_upload',
            original_filename: req.file.originalname || null,
          },
        }) : null;
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
};
