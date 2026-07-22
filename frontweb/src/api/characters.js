import request from '@/utils/request'

function normalizeVoiceAssetCatalog(items = []) {
  return items.map((asset) => ({
    id: `asset-${asset.id}`,
    asset_id: asset.id,
    engine: 'audio-library',
    voice_id: `asset-${asset.id}`,
    language: '项目音色',
    label: asset.name || `${asset.metadata?.character_name || '角色'} · 提取音色`,
    description: `来源：${asset.metadata?.character_name || '角色'}，分镜 ${asset.metadata?.storyboard_id || '-'}；可复用于本项目角色`,
    available: Boolean(asset.url || asset.local_path),
    can_bind: Boolean(asset.url || asset.local_path),
    preview_url: asset.url || (asset.local_path ? `/static/${String(asset.local_path).replace(/^\//, '')}` : null),
    source: 'extracted_voice_asset',
    duration: asset.duration ?? asset.metadata?.voice_asset?.duration ?? null,
    metadata: asset.metadata || {},
  }))
}

export const characterAPI = {
  get(characterId) {
    return request.get(`/characters/${characterId}`)
  },
  generateImage(characterId, model, style) {
    return request.post(`/characters/${characterId}/generate-image`, { model, style })
  },
  generateFourViewImage(characterId, model, style) {
    return request.post(`/characters/${characterId}/generate-four-view-image`, { model, style })
  },
  generatePrompt(characterId, model, style) {
    return request.post(`/characters/${characterId}/generate-prompt`, { model, style })
  },
  batchGenerateImages(characterIds, model, style) {
    return request.post('/characters/batch-generate-images', {
      character_ids: characterIds.map(String),
      model,
      style
    })
  },
  update(characterId, data) {
    return request.put(`/characters/${characterId}`, data)
  },
  putImage(characterId, data) {
    return request.put(`/characters/${characterId}/image`, data)
  },
  putRefImage(characterId, refImagePath) {
    return request.put(`/characters/${characterId}/image`, { ref_image: refImagePath })
  },
  delete(characterId) {
    return request.delete(`/characters/${characterId}`)
  },
  addToLibrary(characterId, body) {
    return request.post(`/characters/${characterId}/add-to-library`, body || {})
  },
  addToMaterialLibrary(characterId) {
    return request.post(`/characters/${characterId}/add-to-material-library`, {})
  },
  addToTeamLibrary(characterId, body = {}) {
    return request.post(`/characters/${characterId}/add-to-team-library`, body)
  },
  extractFromImage(characterId) {
    return request.post(`/characters/${characterId}/extract-from-image`, {})
  },
  extractAnchors(characterId) {
    return request.post(`/characters/${characterId}/extract-anchors`, {})
  },
  sd2Certify(characterId) {
    return request.post(`/characters/${characterId}/sd2-certify`, {})
  },
  sd2CertifyRefresh(characterId) {
    return request.post(`/characters/${characterId}/sd2-certify/refresh`, {})
  },
  sd2VoiceUpload(characterId, file) {
    const form = new FormData()
    form.append('file', file)
    return request.post(`/characters/${characterId}/sd2-voice-upload`, form, {
      headers: { 'Content-Type': 'multipart/form-data' }
    })
  },
  sd2VoiceRefresh(characterId) {
    return request.post(`/characters/${characterId}/sd2-voice-refresh`, {})
  },
  async listVoiceCatalog(params, config = {}) {
    const requestConfig = { silentError: true, ...config, params: params || {} }
    try {
      return await request.get('/voice-catalog', requestConfig)
    } catch (e) {
      const status = e?.response?.status
      if (status !== 404) throw e
      const fallback = await request.get('/assets', {
        silentError: true,
        params: {
          drama_id: params?.drama_id,
          type: 'audio',
          category: 'voice',
          page: 1,
          page_size: 100,
        }
      })
      const items = Array.isArray(fallback) ? fallback : (fallback?.items || [])
      return { items: normalizeVoiceAssetCatalog(items), degraded: true }
    }
  },
  bindVoiceCatalog(characterId, voiceId) {
    return request.post(`/characters/${characterId}/sd2-voice-catalog`, { voice_id: voiceId })
  },
  listBuiltinVoices(dramaId) {
    return this.listVoiceCatalog(dramaId ? { drama_id: dramaId } : {})
  },
  bindBuiltinVoice(characterId, catalogId) {
    return this.bindVoiceCatalog(characterId, catalogId)
  }
}
