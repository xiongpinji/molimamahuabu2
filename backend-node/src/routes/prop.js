const propService = require('../services/propService');
const propLibraryService = require('../services/propLibraryService');
const response = require('../response');
const textGenerationBilling = require('../services/textGenerationBillingService');

function listProps(db) {
  return (req, res) => {
    const props = propService.listByDramaId(db, req.params.id);
    response.success(res, props);
  };
}

function createProp(db, log) {
  return (req, res) => {
    const body = req.body || {};
    if (!body.drama_id || !body.name) return response.badRequest(res, 'drama_id 和 name 必填');
    try {
      const prop = propService.create(db, log, body);
      response.created(res, prop);
    } catch (err) {
      log.errorw('Create prop failed', { error: err.message });
      response.internalError(res, '创建失败');
    }
  };
}

function updateProp(db, log) {
  return (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return response.badRequest(res, '无效的ID');
    const prop = propService.update(db, log, id, req.body || {});
    if (!prop) return response.notFound(res, '道具不存在');
    response.success(res, prop);
  };
}

function deleteProp(db, log) {
  return (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return response.badRequest(res, '无效的ID');
    const ok = propService.deleteById(db, log, id);
    if (!ok) return response.notFound(res, '道具不存在');
    response.success(res, { message: '删除成功' });
  };
}

function generateImage(db, log) {
  const propImageGenerationService = require('../services/propImageGenerationService');
  return (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return response.badRequest(res, '无效的ID');
    const model = req.body?.model != null ? String(req.body.model).trim() || null : null;
    const style = req.body?.style != null ? String(req.body.style).trim() || null : null;
    try {
      const taskId = propImageGenerationService.generatePropImage(db, log, id, { model, style });
      response.success(res, { task_id: taskId });
    } catch (err) {
      if (err.message === '道具不存在') return response.notFound(res, err.message);
      if (err.message === '道具没有图片提示词') return response.badRequest(res, err.message);
      log.error('generatePropImage failed', { error: err.message });
      response.internalError(res, err.message || '生成失败');
    }
  };
}

function extractProps(db, log, cfg, generationOptions = {}) {
  const propExtractionService = require('../services/propExtractionService');
  return (req, res) => {
    const episodeId = req.params.episode_id;
    if (!episodeId) return response.badRequest(res, '缺少 episode_id');
    try {
      const taskId = propExtractionService.extractPropsForEpisode(
        db,
        log,
        episodeId,
        cfg,
        {
          billingEnabled: Boolean(generationOptions.billingEnabled),
          tenantId: req.tenant?.id,
          userId: req.user?.id,
          model: req.body?.model || undefined,
        },
      );
      response.success(res, { task_id: taskId });
    } catch (err) {
      if (textGenerationBilling.respondError(response, res, err)) return;
      if (err.message === 'episode not found' || err.message?.includes('剧本内容为空')) {
        return response.badRequest(res, err.message);
      }
      log.error('extractProps failed', { error: err.message });
      response.internalError(res, err.message || '提取失败');
    }
  };
}

function associateProps(db, log) {
  return (req, res) => {
    const storyboardId = parseInt(req.params.id, 10);
    const propIds = Array.isArray(req.body?.prop_ids) ? req.body.prop_ids : [];
    propService.associateWithStoryboard(db, log, storyboardId, propIds);
    response.success(res, { message: '关联成功' });
  };
}

function addToLibrary(db, log) {
  return (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return response.badRequest(res, '无效的ID');
    const out = propLibraryService.addPropToLibrary(db, log, id);
    if (!out.ok) {
      if (out.error === 'prop not found') return response.notFound(res, '道具不存在');
      if (out.error === 'unauthorized') return response.forbidden(res, '无权限');
      return response.badRequest(res, out.error);
    }
    response.success(res, { message: '已加入本剧道具库', item: out.item });
  };
}

function addToMaterialLibrary(db, log) {
  return (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return response.badRequest(res, '无效的ID');
    const out = propLibraryService.addPropToMaterialLibrary(db, log, id);
    if (!out.ok) {
      if (out.error === 'prop not found') return response.notFound(res, '道具不存在');
      return response.badRequest(res, out.error);
    }
    response.success(res, { message: '已加入全局素材库', item: out.item });
  };
}

function getPropById(db, log) {
  return (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return response.badRequest(res, '无效的ID');
    const prop = propService.getById(db, id);
    if (!prop) return response.notFound(res, '道具不存在');
    response.success(res, { prop });
  };
}

function generatePropPrompt(db, log, cfg, generationOptions) {
  return async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return response.badRequest(res, '无效的ID');
    let billing = null;
    try {
      const body = req.body || {};
      if (!propService.getById(db, id)) return response.notFound(res, '道具不存在');
      billing = textGenerationBilling.begin(db, {
        enabled: Boolean(generationOptions.billingEnabled),
        tenantId: req.tenant?.id,
        userId: req.user?.id,
        requestedModel: body.model || undefined,
        sceneKey: 'prop_image_polish',
        resourceType: 'prop_prompt',
        resourceId: id,
        operation: 'prop_prompt',
      });
      const out = await propService.generatePropPromptOnly(
        db, log, cfg, id, billing.model, body.style || undefined,
      );
      if (!out.ok) {
        textGenerationBilling.settle(db, log, billing, 'failed', out.error);
        if (out.error === 'prop not found') return response.notFound(res, '道具不存在');
        return response.badRequest(res, out.error);
      }
      textGenerationBilling.settle(db, log, billing, 'completed');
      response.success(res, { message: '提示词已生成', prompt: out.prompt });
    } catch (err) {
      log.error('generatePropPrompt failed', { error: err.message });
      textGenerationBilling.settle(db, log, billing, 'failed', err.message);
      if (textGenerationBilling.respondError(response, res, err)) return;
      response.internalError(res, err.message);
    }
  };
}

function extractPropFromImage(db, log, cfg, generationOptions) {
  return async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return response.badRequest(res, '无效的ID');
    let billing = null;
    try {
      if (!propService.getById(db, id)) return response.notFound(res, '道具不存在');
      billing = textGenerationBilling.begin(db, {
        enabled: Boolean(generationOptions.billingEnabled),
        tenantId: req.tenant?.id,
        userId: req.user?.id,
        requestedModel: req.body?.model || undefined,
        resourceType: 'prop_vision',
        resourceId: id,
        operation: 'prop_vision',
      });
      const out = await propService.extractPropFromImage(db, log, cfg, id, billing.model);
      if (!out.ok) {
        textGenerationBilling.settle(db, log, billing, 'failed', out.error);
        if (out.error === 'prop not found') return response.notFound(res, '道具不存在');
        return response.badRequest(res, out.error);
      }
      textGenerationBilling.settle(db, log, billing, 'completed');
      response.success(res, { message: '道具描述已提取', description: out.description });
    } catch (err) {
      log.error('extractPropFromImage failed', { error: err.message });
      textGenerationBilling.settle(db, log, billing, 'failed', err.message);
      if (textGenerationBilling.respondError(response, res, err)) return;
      response.internalError(res, err.message);
    }
  };
}

module.exports = function propRoutes(db, log, cfg, generationOptions = {}) {
  return {
    listProps: listProps(db),
    createProp: createProp(db, log),
    updateProp: updateProp(db, log),
    deleteProp: deleteProp(db, log),
    getPropById: getPropById(db, log),
    generateImage: generateImage(db, log),
    generatePropPrompt: generatePropPrompt(db, log, cfg, generationOptions),
    extractProps: extractProps(db, log, cfg, generationOptions),
    associateProps: associateProps(db, log),
    addToLibrary: addToLibrary(db, log),
    addToMaterialLibrary: addToMaterialLibrary(db, log),
    extractPropFromImage: extractPropFromImage(db, log, cfg, generationOptions),
  };
};
