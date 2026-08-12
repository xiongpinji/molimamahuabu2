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
  updateShot(shotId, body) {
    return request.put(`/redraw/shots/${shotId}`, body)
  },
  generateShot(shotId, body = {}) {
    return request.post(`/redraw/shots/${shotId}/generate`, body)
  },
  generateBatch(workId, body = {}) {
    return request.post(`/redraw/works/${workId}/generate-batch`, body)
  },
  quoteLocalization(workId, body) {
    return request.post(`/redraw/works/${workId}/localization-quote`, body)
  },
  createVersion(workId, body) {
    return request.post(`/redraw/works/${workId}/versions`, body)
  },
  listAssets(versionId, kind) {
    const suffix = kind ? `?kind=${encodeURIComponent(kind)}` : ''
    return request.get(`/redraw/versions/${versionId}/assets${suffix}`)
  },
  getGenerationGate(versionId) {
    return request.get(`/redraw/versions/${versionId}/generation-gate`)
  },
  getAssetQuote(assetId) {
    return request.get(`/redraw/assets/${assetId}/quote`)
  },
  quoteAssetBatch(versionId, body = {}) {
    return request.post(`/redraw/versions/${versionId}/assets/batch-quote`, body)
  },
  createAssetBatch(versionId, body) {
    return request.post(`/redraw/versions/${versionId}/assets/batches`, body)
  },
  updateAsset(assetId, body) {
    return request.put(`/redraw/assets/${assetId}`, body)
  },
  generateAsset(assetId, body = {}) {
    return request.post(`/redraw/assets/${assetId}/generate`, body)
  },
  reviewAsset(assetId, body) {
    return request.post(`/redraw/assets/${assetId}/review`, {
      ...body,
      expected_updated_at: body?.expected_updated_at || body?.expectedUpdatedAt,
    })
  },
  getAssetPreview(assetId, variant) {
    return request.get(`/redraw/assets/${assetId}/preview/${encodeURIComponent(variant)}`, {
      responseType: 'blob',
      silentError: true,
    })
  },
  listProductionVoices(versionId) {
    return request.get(`/redraw/versions/${versionId}/voices`)
  },
  getVoicePreview(versionId, voiceAssetId) {
    return request.get(`/redraw/versions/${versionId}/voices/${voiceAssetId}/preview`, { responseType: 'blob' })
  },
  assignVoice(characterAssetId, body) {
    const payload = { voice_asset_id: body?.voice_asset_id }
    if (body?.expected_updated_at) payload.expected_updated_at = body.expected_updated_at
    return request.post(`/redraw/assets/${characterAssetId}/voice`, payload)
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
  quoteDialogue(versionId, body = {}) {
    return request.post(`/redraw/versions/${versionId}/dialogue/quote`, body)
  },
  startDialogue(versionId, body) {
    return request.post(`/redraw/versions/${versionId}/dialogue/start`, body)
  },
  getDialogueTask(versionId, taskId) {
    return request.get(`/redraw/versions/${versionId}/dialogue/tasks/${taskId}`)
  },
  composeVersion(versionId, body) {
    return request.post(`/redraw/versions/${versionId}/compose`, body)
  },
  listExports(versionId) {
    return request.get(`/redraw/versions/${versionId}/exports`)
  },
  getExport(exportId) {
    return request.get(`/redraw/exports/${exportId}`)
  },
  downloadExport(exportId, kind) {
    return request.get(`/redraw/exports/${exportId}/download/${encodeURIComponent(kind)}`, { responseType: 'blob' })
  },
}
