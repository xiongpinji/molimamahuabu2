import request from '@/utils/request'

export const redrawAPI = {
  listProjects() {
    return request.get('/redraw/projects')
  },
  createProject(body) {
    return request.post('/redraw/projects', body)
  },
  getProject(id) {
    return request.get(`/redraw/projects/${id}`)
  },
  createWorks(projectId, file) {
    const form = new FormData()
    form.append('file', file)
    return request.post(`/redraw/projects/${projectId}/works`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
  getWork(workId) {
    return request.get(`/redraw/works/${workId}`)
  },
  listStylePresets() {
    return request.get('/redraw/style-presets')
  },
  listLocales() {
    return request.get('/redraw/locales')
  },
  analyzeWork(workId, body = {}) {
    return request.post(`/redraw/works/${workId}/analyze`, body)
  },
}
