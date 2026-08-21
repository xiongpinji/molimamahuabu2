import request from '@/utils/request'

const EXTRACTED_VOICE_QUALITY_NOTICE = '按剧本对白顺序和静音切点从混合视频音轨裁剪，不是真实说话人分离；背景音乐或环境音可能残留，请试听确认后再复用。'

function normalizeVoiceAssetCatalog(items = []) {
  return items.map((asset) => {
    const metadata = asset.metadata || {}
    const voiceAsset = metadata.voice_asset || {}
    const isExtractedVoice = metadata.source === 'storyboard_voice_extraction'
      || voiceAsset.source === 'storyboard_video'
      || Boolean(metadata.storyboard_id)
    const qualityNotice = voiceAsset.quality_notice
      || (isExtractedVoice ? EXTRACTED_VOICE_QUALITY_NOTICE : '')
    return {
      id: `asset-${asset.id}`,
      asset_id: asset.id,
      engine: 'audio-library',
      voice_id: `asset-${asset.id}`,
      language: '项目音色',
      label: asset.name || `${metadata.character_name || '角色'} · 提取音色`,
      description: `来源：${metadata.character_name || '角色'}，分镜 ${metadata.storyboard_id || '-'}；可复用于本项目角色${qualityNotice ? `；${qualityNotice}` : ''}`,
      available: Boolean(asset.url || asset.local_path),
      can_bind: Boolean(asset.url || asset.local_path),
      preview_url: asset.url || (asset.local_path ? `/static/${String(asset.local_path).replace(/^\//, '')}` : null),
      url: asset.url || '',
      local_path: asset.local_path || '',
      audio_url: asset.url || '',
      voice_url: asset.url || '',
      voice_local_path: asset.local_path || '',
      source: 'extracted_voice_asset',
      duration: asset.duration ?? voiceAsset.duration ?? null,
      quality_status: voiceAsset.quality_status || (isExtractedVoice ? 'requires_preview_confirmation' : null),
      quality_notice: qualityNotice,
      speaker_diarization: voiceAsset.speaker_diarization ?? (isExtractedVoice ? false : null),
      source_audio_kind: voiceAsset.source_audio_kind || (isExtractedVoice ? 'mixed_video_track' : null),
      metadata,
    }
  })
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
      try {
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
      } catch (fallbackError) {
        if (fallbackError?.response?.status !== 404) throw fallbackError
        return {
          items: [],
          degraded: true,
          unavailable: true,
          message: '音色库接口暂不可用，请确认后端已更新并重启',
        }
      }
    }
  },
  bindVoiceCatalog(characterId, voiceId, config = {}) {
    return request.post(`/characters/${characterId}/sd2-voice-catalog`, { voice_id: voiceId }, config)
  },
  listBuiltinVoices(dramaId) {
    return this.listVoiceCatalog(dramaId ? { drama_id: dramaId } : {})
  },
  bindBuiltinVoice(characterId, catalogId) {
    return this.bindVoiceCatalog(characterId, catalogId)
  }
}
