import request from '@/utils/request'

export const providerStabilityAPI = {
  listRoutes(params = {}) {
    return request.get('/admin/provider-stability/routes', { params })
  },
  listEvents(params = {}) {
    return request.get('/admin/provider-stability/events', { params })
  },
  updateRoute(configId, body) {
    return request.patch(`/admin/provider-stability/routes/${configId}`, body)
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
