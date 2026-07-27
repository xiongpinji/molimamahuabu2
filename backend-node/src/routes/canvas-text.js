const response = require('../response');
const canvasTextGeneration = require('../services/canvas-text-generation-service');
const textGenerationBilling = require('../services/text-generation-billing-service');

function routes(db, log, options = {}) {
  return {
    generate: async (req, res) => {
      try {
        const result = await canvasTextGeneration.generate(db, log, {
          dramaId: req.body?.drama_id,
          prompt: req.body?.prompt,
          model: req.body?.model,
          billingEnabled: options.billingEnabled,
          tenantId: req.tenant?.id,
          userId: req.user?.id,
        });
        response.success(res, result);
      } catch (error) {
        if (textGenerationBilling.respondError(response, res, error)) return;
        if (error.message?.includes('请输入') || error.message?.includes('必须是正整数')) {
          return response.badRequest(res, error.message);
        }
        log.error('canvas text generation', { error: error.message });
        response.internalError(res, '画布文本生成失败，请稍后重试');
      }
    },
  };
}

module.exports = routes;
