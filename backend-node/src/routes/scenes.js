const response = require('../response');
const sceneService = require('../services/sceneService');
const sceneLibraryService = require('../services/sceneLibraryService');
const imageService = require('../services/imageService');
const aiClient = require('../services/aiClient');
const auditEvent = require('../services/auditEventService');
const creditLedger = require('../services/creditLedgerService');
const modelPrice = require('../services/modelPriceService');
const { randomUUID } = require('crypto');
const textGenerationBilling = require('../services/textGenerationBillingService');

function resolveTextModel(db, requestedModel) {
  const config = requestedModel
    ? aiClient.getConfigForModel(db, 'text', requestedModel)
    : aiClient.getDefaultConfig(db, 'text');
  if (!config) throw new Error('未配置场景提示词文本模型');
  return modelPrice.canonicalModel(aiClient.getModelFromConfig(config, requestedModel));
}

function settlePromptCredit(db, log, reservationId, outcome, message = '') {
  if (!reservationId) return null;
  try {
    const settled = creditLedger.settleGeneration(db, reservationId, outcome, message);
    auditEvent.record(db, {
      userId: settled?.actor_user_id || settled?.user_id,
      tenantId: settled?.tenant_id,
      eventType: outcome === 'completed'
        ? 'generation.scene_prompt.completed'
        : 'generation.scene_prompt.failed',
      resourceType: 'text',
      resourceId: settled?.resource_id,
      outcome: outcome === 'completed' ? 'success' : 'failed',
      code: outcome === 'failed' ? 'SCENE_PROMPT_FAILED' : null,
    });
    return settled;
  } catch (error) {
    log?.error?.('场景提示词积分结算失败，保留原预扣状态', {
      reservation_id: reservationId,
      error: error.message,
    });
    return null;
  }
}

function routes(db, log, cfg, generationOptions = {}) {
  return {
    getOne: (req, res) => {
      try {
        const scene = sceneService.getSceneById(db, Number(req.params.scene_id));
        if (!scene) return response.notFound(res, '场景不存在');
        response.success(res, { scene });
      } catch (err) {
        log.error('scenes getOne', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    generatePrompt: async (req, res) => {
      let reservationId = null;
      try {
        const body = req.body || {};
        let billingModel = body.model || undefined;
        if (generationOptions.billingEnabled) {
          const userId = req.user?.id;
          const tenantId = req.tenant?.id;
          if (!userId) {
            return response.error(res, 401, 'UNAUTHORIZED', '公开计费模式缺少用户身份');
          }
          if (!sceneService.getSceneById(db, Number(req.params.scene_id))) {
            return response.notFound(res, '场景不存在');
          }
          billingModel = resolveTextModel(db, billingModel);
          const amount = modelPrice.requirePrice(db, billingModel);
          const reservation = creditLedger.reserve(db, {
            tenantId,
            actorUserId: userId,
            userId,
            operationKey: `scene_prompt:${req.params.scene_id}:${randomUUID()}`,
            model: billingModel,
            resourceType: 'text',
            resourceId: req.params.scene_id,
            amount,
          });
          reservationId = reservation.id;
          auditEvent.record(db, {
            userId,
            tenantId,
            eventType: 'generation.scene_prompt.created',
            resourceType: 'text',
            resourceId: req.params.scene_id,
            outcome: 'success',
            code: 'CREATED',
          });
        }
        const out = await sceneService.generateScenePromptOnly(
          db, log, cfg, req.params.scene_id, billingModel, body.style || undefined
        );
        if (!out.ok) {
          settlePromptCredit(db, log, reservationId, 'failed', out.error);
          if (out.error === 'scene not found') return response.notFound(res, '场景不存在');
          return response.badRequest(res, out.error);
        }
        settlePromptCredit(db, log, reservationId, 'completed');
        response.success(res, { message: '提示词已生成', polished_prompt: out.polished_prompt });
      } catch (err) {
        log.error('scenes generatePrompt', { error: err.message });
        settlePromptCredit(db, log, reservationId, 'failed', err.message);
        if (['MODEL_PRICE_NOT_CONFIGURED', 'MODEL_DISABLED'].includes(err.code)) {
          return response.error(res, 503, err.code, err.message);
        }
        if (err.code === 'INSUFFICIENT_CREDITS') {
          return response.error(res, 402, err.code, '积分不足，请充值后重试');
        }
        response.internalError(res, err.message);
      }
    },
    extractFromImage: async (req, res) => {
      let billing = null;
      try {
        if (!sceneService.getSceneById(db, Number(req.params.scene_id))) {
          return response.notFound(res, '场景不存在');
        }
        billing = textGenerationBilling.begin(db, {
          enabled: Boolean(generationOptions.billingEnabled),
          tenantId: req.tenant?.id,
          userId: req.user?.id,
          requestedModel: req.body?.model || undefined,
          resourceType: 'scene_vision',
          resourceId: req.params.scene_id,
          operation: 'scene_vision',
        });
        const out = await sceneService.extractSceneFromImage(
          db, log, cfg, req.params.scene_id, billing.model,
        );
        if (!out.ok) {
          textGenerationBilling.settle(db, log, billing, 'failed', out.error);
          if (out.error === 'scene not found') return response.notFound(res, '场景不存在');
          return response.badRequest(res, out.error);
        }
        textGenerationBilling.settle(db, log, billing, 'completed');
        response.success(res, { message: '场景描述已提取', prompt: out.prompt });
      } catch (err) {
        log.error('scenes extract-from-image', { error: err.message });
        textGenerationBilling.settle(db, log, billing, 'failed', err.message);
        if (textGenerationBilling.respondError(response, res, err)) return;
        response.internalError(res, err.message);
      }
    },
    update: (req, res) => {
      try {
        const out = sceneService.updateScene(db, log, req.params.scene_id, req.body || {});
        if (!out.ok) return response.notFound(res, '场景不存在');
        response.success(res, { message: '保存成功' });
      } catch (err) {
        log.error('scenes update', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    updatePrompt: (req, res) => {
      try {
        const out = sceneService.updateScenePrompt(db, log, req.params.scene_id, req.body || {});
        if (!out.ok) return response.notFound(res, '场景不存在');
        response.success(res, { message: '场景提示词已更新' });
      } catch (err) {
        log.error('scenes updatePrompt', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    delete: (req, res) => {
      try {
        const out = sceneService.deleteScene(db, log, req.params.scene_id);
        if (!out.ok) return response.notFound(res, '场景不存在');
        response.success(res, { message: '场景已删除' });
      } catch (err) {
        log.error('scenes delete', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    create: (req, res) => {
      try {
        const body = req.body || {};
        const dramaId = body.drama_id;
        if (dramaId == null) return response.badRequest(res, '缺少 drama_id');
        const scene = sceneService.createScene(db, log, dramaId, body);
        response.created(res, scene);
      } catch (err) {
        log.error('scenes create', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    generateImage: async (req, res) => {
      try {
        const body = req.body || {};
        const sceneId = body.scene_id != null ? Number(body.scene_id) : null;
        if (sceneId == null) return response.badRequest(res, '缺少 scene_id');
        const out = await sceneService.generateSceneFourViewImage(
          db,
          log,
          cfg,
          sceneId,
          body.model || undefined,
          body.style || undefined,
          {
            billingEnabled: Boolean(generationOptions.billingEnabled),
            userId: req.user?.id,
            tenantId: req.tenant?.id,
            textModel: body.text_model_name || body.text_model || undefined,
          },
        );
        if (!out.ok) {
          if (out.error === 'scene not found') return response.notFound(res, '场景不存在');
          if (out.error === 'unauthorized') return response.notFound(res, '剧集不存在或无权限');
          return response.badRequest(res, out.error);
        }
        response.success(res, {
          message: '场景四视图生成任务已提交',
          image_generation: out.image_generation,
        });
      } catch (err) {
        log.error('scenes generateImage', { error: err.message });
        if (textGenerationBilling.respondError(response, res, err)) return;
        response.internalError(res, err.message);
      }
    },
    addToLibrary: (req, res) => {
      try {
        const out = sceneLibraryService.addSceneToLibrary(db, log, req.params.scene_id);
        if (!out.ok) {
          if (out.error === 'scene not found') return response.notFound(res, '场景不存在');
          if (out.error === 'unauthorized') return response.forbidden(res, '无权限');
          return response.badRequest(res, out.error);
        }
        response.success(res, { message: '已加入本剧场景库', item: out.item });
      } catch (err) {
        log.error('scenes add-to-library', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    addToMaterialLibrary: (req, res) => {
      try {
        const out = sceneLibraryService.addSceneToMaterialLibrary(db, log, req.params.scene_id);
        if (!out.ok) {
          if (out.error === 'scene not found') return response.notFound(res, '场景不存在');
          return response.badRequest(res, out.error);
        }
        response.success(res, { message: '已加入全局素材库', item: out.item });
      } catch (err) {
        log.error('scenes add-to-material-library', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    generateFourViewImage: async (req, res) => {
      try {
        const body = req.body || {};
        const modelName = body.model_name || body.model || undefined;
        const style = body.style || undefined;
        const out = await sceneService.generateSceneFourViewImage(
          db,
          log,
          cfg,
          req.params.scene_id,
          modelName,
          style,
          {
            billingEnabled: Boolean(generationOptions.billingEnabled),
            userId: req.user?.id,
            tenantId: req.tenant?.id,
            textModel: body.text_model_name || body.text_model || undefined,
          },
        );
        if (!out.ok) {
          if (out.error === 'scene not found') return response.notFound(res, '场景不存在');
          if (out.error === 'unauthorized') return response.notFound(res, '剧集不存在或无权限');
          return response.badRequest(res, out.error);
        }
        response.success(res, { message: '场景四视图生成任务已提交', image_generation: out.image_generation });
      } catch (err) {
        log.error('scenes generate-four-view-image', { error: err.message });
        if (textGenerationBilling.respondError(response, res, err)) return;
        response.internalError(res, err.message);
      }
    },
    generatePanoramaImage: async (req, res) => {
      try {
        const body = req.body || {};
        const out = await sceneService.generateScenePanoramaImage(
          db, log, cfg, req.params.scene_id, body.model || undefined, body.style || undefined,
          { billingEnabled: Boolean(generationOptions.billingEnabled), userId: req.user?.id, tenantId: req.tenant?.id }
        );
        if (!out.ok) {
          if (out.error === 'scene not found') return response.notFound(res, '场景不存在');
          if (out.error === 'unauthorized') return response.notFound(res, '剧集不存在或无权限');
          return response.badRequest(res, out.error);
        }
        response.success(res, { message: '场景全景图生成任务已提交', image_generation: out.image_generation });
      } catch (err) {
        log.error('scenes generate-panorama-image', { error: err.message });
        response.internalError(res, err.message);
      }
    },
  };
}

module.exports = routes;
