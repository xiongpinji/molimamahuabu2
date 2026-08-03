const { spawnSync } = require('node:child_process');

const response = require('../response');
const videoToolService = require('../services/videoToolService');
const {
  getFfmpegPath,
  getFfprobePath,
  hasLocalFfmpeg,
  hasLocalFfprobe,
} = require('../utils/ffmpegPath');

let cachedRuntimeCapabilities = null;

function commandOutput(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 5000,
  });
  return result.status === 0 ? `${result.stdout || ''}\n${result.stderr || ''}` : '';
}

function listed(output, name) {
  return new RegExp(`(^|\\s)${name}(\\s|$)`, 'm').test(output);
}

function inspectRuntimeCapabilities() {
  if (cachedRuntimeCapabilities) return cachedRuntimeCapabilities;
  const ffmpegAvailable = hasLocalFfmpeg();
  const ffprobeAvailable = hasLocalFfprobe()
    && Boolean(commandOutput(getFfprobePath(), ['-version']));
  const filters = ffmpegAvailable
    ? commandOutput(getFfmpegPath(), ['-hide_banner', '-filters'])
    : '';
  const encoders = ffmpegAvailable
    ? commandOutput(getFfmpegPath(), ['-hide_banner', '-encoders'])
    : '';
  cachedRuntimeCapabilities = {
    ffmpegAvailable: Boolean(filters && encoders),
    ffprobeAvailable,
    filter: (name) => listed(filters, name),
    encoder: (name) => listed(encoders, name),
  };
  return cachedRuntimeCapabilities;
}

function operationCapabilities() {
  const runtime = inspectRuntimeCapabilities();
  const base = runtime.ffmpegAvailable && runtime.ffprobeAvailable;
  const videoEncoder = runtime.encoder('libx264');
  const audioEncoder = runtime.encoder('aac');
  const capability = (available, engine, extra = {}) => ({
    available,
    engine,
    reason: available ? '' : '服务器 FFmpeg/ffprobe 缺少该工具所需的滤镜或编码器',
    ...extra,
  });
  const videoOutput = base && videoEncoder && audioEncoder;
  const upscaleFilters = runtime.filter('scale') && runtime.filter('pad') && runtime.filter('unsharp');
  const editFilters = ['hflip', 'vflip', 'transpose', 'eq', 'setpts', 'atempo']
    .every((name) => runtime.filter(name));
  return {
    crop: capability(videoOutput && runtime.filter('crop'), 'ffmpeg', {
      encoderVerified: videoEncoder && audioEncoder,
      filterVerified: runtime.filter('crop'),
    }),
    upscale: capability(videoOutput && upscaleFilters, 'ffmpeg', {
      resolutions: ['1080p', '2k', '4k'],
      encoderVerified: videoEncoder && audioEncoder,
      filterVerified: upscaleFilters,
      interpolateAvailable: runtime.filter('minterpolate'),
      slowMotionAvailable: runtime.filter('setpts') && runtime.filter('atempo'),
    }),
    analyze: capability(
      base && runtime.filter('select') && runtime.filter('showinfo') && runtime.encoder('mjpeg'),
      'ffprobe+ffmpeg',
      { filterVerified: runtime.filter('select') && runtime.filter('showinfo') },
    ),
    remove_subtitles: capability(videoOutput && runtime.filter('delogo'), 'ffmpeg', {
      mode: 'selected-region',
      encoderVerified: videoEncoder && audioEncoder,
      filterVerified: runtime.filter('delogo'),
    }),
    extract_audio: capability(base && audioEncoder, 'ffmpeg', { encoderVerified: audioEncoder }),
    mute: capability(base && videoEncoder, 'ffmpeg', { encoderVerified: videoEncoder }),
    edit: capability(videoOutput && editFilters, 'ffmpeg', {
      encoderVerified: videoEncoder && audioEncoder,
      filterVerified: editFilters,
    }),
  };
}

function handleError(res, log, error) {
  if (error.code === 'VIDEO_TOOL_ASSET_NOT_FOUND') return response.notFound(res, error.message);
  if ([
    'VIDEO_TOOL_INVALID_INPUT',
    'VIDEO_TOOL_SOURCE_UNAVAILABLE',
    'VIDEO_TOOL_UNSUPPORTED_VIDEO',
  ].includes(error.code)) return response.badRequest(res, error.message);
  if (error.code === 'VIDEO_TOOL_OPERATION_UNAVAILABLE') {
    return response.error(res, 503, error.code, error.message);
  }
  if (error.code === 'VIDEO_TOOL_LIMIT_EXCEEDED') {
    return response.error(res, 413, error.code, error.message);
  }
  if (error.code === 'VIDEO_TOOL_BUSY') {
    return response.error(res, 429, error.code, error.message);
  }
  if (error.code === 'VIDEO_TOOL_PROCESSING_FAILED') {
    return response.error(res, 503, error.code, error.message);
  }
  log.error('video tools operation', { error: error.message });
  return response.internalError(res, error.message);
}

function routes(db, log, options = {}) {
  return {
    capabilities: (_req, res) => response.success(res, { operations: operationCapabilities() }),
    createOperation: async (req, res) => {
      try {
        const operation = String(req.body?.operation || '').trim();
        const capability = operationCapabilities()[operation];
        if (capability && !capability.available) {
          return response.error(res, 503, 'VIDEO_TOOL_OPERATION_UNAVAILABLE', capability.reason);
        }
        if (operation === 'upscale' && req.body?.parameters?.interpolate && !capability?.interpolateAvailable) {
          return response.error(res, 503, 'VIDEO_TOOL_OPERATION_UNAVAILABLE', '当前 FFmpeg 不支持视频补帧');
        }
        if (operation === 'upscale'
          && Number(req.body?.parameters?.slowMotion || 1) > 1
          && !capability?.slowMotionAvailable) {
          return response.error(res, 503, 'VIDEO_TOOL_OPERATION_UNAVAILABLE', '当前 FFmpeg 不支持视频慢动作');
        }
        let acceptedTask = null;
        const operationPromise = videoToolService.createOperation(db, log, req.body || {}, {
          cfg: options.cfg,
          publicPlatformEnabled: Boolean(options.publicPlatformEnabled),
          tenantId: req.tenant?.id,
          userId: req.user?.id,
          onTaskCreated: (task) => {
            acceptedTask = { taskId: task.id, status: 'processing', operation };
          },
        });
        if (options.backgroundOperations && acceptedTask) {
          operationPromise.catch((error) => {
            log.error('视频工具后台任务失败', {
              task_id: acceptedTask.taskId,
              operation,
              error: error.message,
            });
          });
          return response.accepted(res, acceptedTask);
        }
        return response.created(res, await operationPromise);
      } catch (error) {
        return handleError(res, log, error);
      }
    },
    getOperation: (req, res) => {
      const task = videoToolService.getOperation(db, req.params.taskId, {
        publicPlatformEnabled: Boolean(options.publicPlatformEnabled),
        tenantId: req.tenant?.id,
        userId: req.user?.id,
      });
      if (!task) return response.notFound(res, '视频处理任务不存在');
      return response.success(res, task);
    },
  };
}

module.exports = routes;
