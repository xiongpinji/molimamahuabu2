const response = require('../response');
const imageToolService = require('../services/imageToolService');

const unavailable = (reason) => ({ available: false, reason });

const OPERATIONS = Object.freeze({
  crop: { available: true, engine: 'sharp' },
  compress: { available: true, engine: 'sharp' },
  mirror: { available: true, engine: 'sharp' },
  grid_crop: { available: true, engine: 'sharp' },
  adjust: { available: true, engine: 'sharp' },
  lut: { available: true, engine: 'sharp', presets: ['cinematic', 'warm', 'cool', 'mono'] },
  markup_retouch: unavailable('标记修图处理链尚未完成'),
  smart_cutout: unavailable('本地抠图模型尚未通过许可证审计'),
  selection_cutout: unavailable('框选抠图处理链尚未完成'),
  upscale: unavailable('高清增强模型尚未通过许可证审计'),
  detail_enhance: unavailable('细节增强模型尚未通过许可证审计'),
  lighting: unavailable('灯光模型能力尚未配置'),
  cinematic_relight: unavailable('电影光影模型能力尚未配置'),
  panorama: unavailable('全景模型能力尚未配置'),
  panorama_scene: unavailable('全景场景模型能力尚未配置'),
  outpaint: unavailable('扩图模型能力尚未配置'),
  pose: unavailable('姿势控制模型能力尚未配置'),
  angle: unavailable('角度控制模型能力尚未配置'),
  image_ideation: unavailable('画面联想模型能力尚未配置'),
  angle_ideation: unavailable('角度联想模型能力尚未配置'),
  character_views: unavailable('角色三视图模型能力尚未配置'),
  narrative_grid: unavailable('多机位九宫格模型能力尚未配置'),
  frame_forward: unavailable('画面后推模型能力尚未配置'),
  frame_backward: unavailable('画面前推模型能力尚未配置'),
  director_stage: unavailable('导演台生成能力尚未配置'),
  lip_sync: unavailable('对口型模型能力尚未配置'),
});

function handleError(res, log, error) {
  if (error.code === 'IMAGE_TOOL_ASSET_NOT_FOUND') return response.notFound(res, error.message);
  if ([
    'IMAGE_TOOL_INVALID_INPUT',
    'IMAGE_TOOL_SOURCE_UNAVAILABLE',
    'IMAGE_TOOL_UNSUPPORTED_IMAGE',
  ].includes(error.code)) {
    return response.badRequest(res, error.message);
  }
  if (error.code === 'IMAGE_TOOL_OPERATION_UNAVAILABLE') {
    return response.error(res, 503, error.code, error.message);
  }
  log.error('image tools operation', { error: error.message });
  return response.internalError(res, error.message);
}

function routes(db, log, options = {}) {
  return {
    capabilities: (_req, res) => response.success(res, {
      operations: OPERATIONS,
    }),
    createOperation: async (req, res) => {
      try {
        const result = await imageToolService.createOperation(db, log, req.body || {}, {
          cfg: options.cfg,
          publicPlatformEnabled: Boolean(options.publicPlatformEnabled),
          tenantId: req.tenant?.id,
          userId: req.user?.id,
        });
        response.created(res, result);
      } catch (error) {
        handleError(res, log, error);
      }
    },
    getOperation: (req, res) => {
      const task = imageToolService.getOperation(db, req.params.taskId, {
        publicPlatformEnabled: Boolean(options.publicPlatformEnabled),
        tenantId: req.tenant?.id,
        userId: req.user?.id,
      });
      if (!task) return response.notFound(res, '图片处理任务不存在');
      response.success(res, task);
    },
  };
}

module.exports = routes;
