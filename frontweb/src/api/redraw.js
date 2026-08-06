import request from '@/utils/request'

function referenceImageFile(body) {
  const file = body?.free_style?.reference?.file
  return file && typeof file.arrayBuffer === 'function' ? file : null
}

function stripReferenceFile(body) {
  const freeStyle = body?.free_style
  const reference = freeStyle?.reference
  if (!reference?.file) return body
  const { file: _file, ...safeReference } = reference
  return {
    ...body,
    free_style: {
      ...freeStyle,
      reference: safeReference,
    },
  }
}

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
    const file = referenceImageFile(body)
    if (!file) return request.post(`/redraw/works/${workId}/analyze`, body)
    const form = new FormData()
    const payload = stripReferenceFile(body)
    for (const [key, value] of Object.entries(payload)) {
      form.append(key, value && typeof value === 'object' ? JSON.stringify(value) : value)
    }
    form.append('reference_image', file)
    return request.post(`/redraw/works/${workId}/analyze`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
}
