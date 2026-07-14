const path = require('path');
const multer = require('multer');
const response = require('../response');
const assetService = require('../services/assetService');
const uploadService = require('../services/uploadService');
const storageLayout = require('../services/storageLayout');

const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
const maxSize = 16 * 1024 * 1024; // 16MB，单张图片上限
const MAX_SIZE_MB = 16;

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

function routes(cfg, log, db) {
  const singleUpload = upload.single('file');
  return {
    multerSingle: singleUpload,
    multerModelSingle: modelUpload.single('file'),
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
  };
}

module.exports = {
  routes,
  upload,
  modelUpload,
  multerSingle: upload.single('file'),
  multerModelSingle: modelUpload.single('file'),
  multerAudioSingle: audioUpload.single('file'),
  MAX_IMAGE_SIZE_MB: MAX_SIZE_MB,
};
