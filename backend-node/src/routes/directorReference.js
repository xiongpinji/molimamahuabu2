const response = require('../response');
const defaultService = require('../services/directorReferenceService');

function routes(db, log, {
  billingEnabled = false,
  billing = null,
  service = defaultService,
} = {}) {
  return {
    analyze: async (req, res) => {
      const dramaId = Number(req.params.id);
      const imageUrl = String(req.body?.image_url || '').trim();
      if (!Number.isInteger(dramaId) || dramaId <= 0) return response.badRequest(res, 'drama_id 无效');
      if (!imageUrl) return response.badRequest(res, '请上传参考图');

      let reservation = null;
      const billingService = billing || require('../services/text-generation-billing-service');
      try {
        reservation = billingService.begin(db, {
          enabled: billingEnabled,
          tenantId: req.tenant?.id,
          userId: req.user?.id,
          sceneKey: 'director_reference',
          requestedModel: req.body?.model,
          resourceType: 'director_reference',
          resourceId: dramaId,
          operation: 'director_reference_analysis',
        });
        const analysis = await service.analyzeDirectorReference(db, log, imageUrl, reservation.model);
        billingService.settle(db, log, reservation, 'completed');
        return response.success(res, { analysis, model: reservation.model || null });
      } catch (error) {
        billingService.settle(db, log, reservation, 'failed', error.message);
        log?.error?.('director reference analysis', { drama_id: dramaId, error: error.message });
        if (billingService.respondError(response, res, error)) return;
        return response.error(res, 502, 'DIRECTOR_REFERENCE_ANALYSIS_FAILED', error.message);
      }
    },
  };
}

module.exports = routes;
