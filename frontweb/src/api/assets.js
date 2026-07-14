import request from '@/utils/request'

export const assetsAPI = {
  list(params) {
    return request.get('/assets', { params: params || {} })
  },
  get(id) {
    return request.get(`/assets/${id}`)
  },
}
