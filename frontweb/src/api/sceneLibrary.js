import request from '@/utils/request'

export const sceneLibraryAPI = {
  list(params, config = {}) {
    return request.get('/scene-library', { ...config, params })
  },
  get(id) {
    return request.get(`/scene-library/${id}`)
  },
  create(data) {
    return request.post('/scene-library', data)
  },
  update(id, data) {
    return request.put(`/scene-library/${id}`, data)
  },
  delete(id) {
    return request.delete(`/scene-library/${id}`)
  }
}
