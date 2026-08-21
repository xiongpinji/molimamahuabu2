import request from '@/utils/request'

export const providerStabilityAPI = {
  listRoutes(params = {}) {
    return request.get('/admin/provider-stability/routes', { params })
  },
  listEvents(params = {}) {
    return request.get('/admin/provider-stability/events', { params })
  },
  getCanarySummary() {
    return request.get('/admin/provider-stability/canary/summary')
  },
  listCanaryRuns(params = {}) {
    return request.get('/admin/provider-stability/canary/runs', { params })
  },
  reconcileCanaryRun(runId) {
    return request.post(`/admin/provider-stability/canary/runs/${runId}/reconcile`, {})
  },
  updateRoute(configId, body) {
    return request.patch(`/admin/provider-stability/routes/${configId}`, body)
  },
  getRouteCost(configId) {
    return request.get(`/admin/provider-stability/routes/${configId}/cost`)
  },
  updateRouteCost(configId, body) {
    return request.put(`/admin/provider-stability/routes/${configId}/cost`, body)
  },
  resetHealth(configId) {
    return request.post(`/admin/provider-stability/routes/${configId}/reset-health`)
  },
  verifyFromGeneration(configId, generationId) {
    return request.post(`/admin/provider-stability/routes/${configId}/verify-from-generation`, {
      generation_id: generationId,
    })
  },
}
