import request from '@/utils/request'

export const assetsAPI = {
  list(params, config = {}) {
    return request.get('/assets', { ...config, params: params || {} })
  },
  get(id) {
    return request.get(`/assets/${id}`)
  },
  create(payload) {
    return request.post('/assets', payload)
  },
  update(id, payload) {
    return request.put(`/assets/${id}`, payload)
  },
}
