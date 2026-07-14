const multer = require('multer');
const response = require('../response');
const directorExportService = require('../services/directorExportService');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 256 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = String(file.originalname || '').toLowerCase();
    if (!ext.endsWith('.webm') && !ext.endsWith('.mp4')) return cb(new Error('只支持 WebM 或 MP4 视频'));
    cb(null, true);
  },
});
const singleUpload = upload.single('file');

function uploadMiddleware(req, res, next) {
  singleUpload(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') return response.error(res, 413, 'FILE_TOO_LARGE', '导演台视频不能超过 256MB');
    return response.badRequest(res, error.message || '视频上传失败');
  });
}

function routes(db, cfg, log) {
  return {
    upload: uploadMiddleware,
    create: (req, res) => {
      try {
        const task = directorExportService.createDirectorExportTask({
          db,
          cfg,
          log,
          dramaId: req.params.id,
          file: req.file,
          timeline: req.body?.timeline,
          userId: req.user?.id,
        });
        response.success(res, { task_id: task.id, status: task.status, type: task.type });
      } catch (error) {
        log.error('director export create', { error: error.message });
        if (error.code === 'FFMPEG_UNAVAILABLE') return response.error(res, 503, error.code, error.message);
        if (error.message?.includes('请选择') || error.message?.includes('timeline') || error.message?.includes('drama_id')) {
          return response.badRequest(res, error.message);
        }
        response.internalError(res, error.message);
      }
    },
  };
}

module.exports = routes;
