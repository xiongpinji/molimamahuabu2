import request from '@/utils/request'

export const scriptAnalysisAPI = {
  skills() {
    return request.get('/script-analysis/skills')
  },
  productionPresets() {
    return request.get('/script-analysis/production-presets')
  },
  list() {
    return request.get('/script-analysis/projects')
  },
  get(id) {
    return request.get(`/script-analysis/projects/${id}`)
  },
  versions(id) {
    return request.get(`/script-analysis/projects/${id}/versions`)
  },
  create(body) {
    return request.post('/script-analysis/projects', body)
  },
  update(id, body) {
    return request.put(`/script-analysis/projects/${id}`, body)
  },
  revise(id, body) {
    return request.post(`/script-analysis/projects/${id}/revisions`, body)
  },
  review(id, body) {
    return request.post(`/script-analysis/projects/${id}/review`, body)
  },
  run(id, body = {}) {
    return request.post(`/script-analysis/projects/${id}/run`, body)
  },
  importToFactory(id, body) {
    return request.post(`/script-analysis/projects/${id}/import-to-factory`, body)
  },
}
