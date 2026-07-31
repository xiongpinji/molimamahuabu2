import request from '@/utils/request'

export const scriptAnalysisAPI = {
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
  review(id, body) {
    return request.post(`/script-analysis/projects/${id}/review`, body)
  },
  run(id) {
    return request.post(`/script-analysis/projects/${id}/run`)
  },
}
