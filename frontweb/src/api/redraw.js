import request from '@/utils/request'
import { controlledReleaseRequestPath } from '@/utils/redrawTimelineState'

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

function referenceBundleInputError() {
  return new Error('参考包编辑内容格式错误')
}

function referenceBundleString(value) {
  if (typeof value !== 'string') throw referenceBundleInputError()
  const normalized = value.trim()
  if (!normalized) throw referenceBundleInputError()
  return normalized
}

function referenceBundleId(value) {
  if (value == null || typeof value === 'boolean' || String(value).trim() === '') {
    throw referenceBundleInputError()
  }
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw referenceBundleInputError()
  return id
}

function referenceBundleCount(value) {
  if (value == null || typeof value === 'boolean' || String(value).trim() === '') {
    throw referenceBundleInputError()
  }
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0) throw referenceBundleInputError()
  return count
}

function referenceBundleRanges(value) {
  if (!Array.isArray(value)) throw referenceBundleInputError()
  return value.map((range) => {
    if (!Array.isArray(range) || range.length !== 2) throw referenceBundleInputError()
    const start = Number(range[0])
    const end = Number(range[1])
    if (range[0] == null || range[1] == null
      || typeof range[0] === 'boolean' || typeof range[1] === 'boolean'
      || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= end) {
      throw referenceBundleInputError()
    }
    return [start, end]
  })
}

export function buildReferenceBundlePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw referenceBundleInputError()
  if (!Array.isArray(body.face_tracks) || !Array.isArray(body.text_regions)) {
    throw referenceBundleInputError()
  }
  const review = body.coverage_review
  if (!review || typeof review !== 'object' || Array.isArray(review)) throw referenceBundleInputError()
  return {
    expected_updated_at: referenceBundleString(body.expected_updated_at),
    motion_reference_asset_id: referenceBundleId(body.motion_reference_asset_id),
    face_tracks: body.face_tracks.map((track) => ({
      track_key: referenceBundleString(track?.track_key),
      source_character_key: referenceBundleString(track?.source_character_key),
      time_ranges: referenceBundleRanges(track?.time_ranges),
      identity_redraw_asset_id: referenceBundleId(track?.identity_redraw_asset_id),
    })),
    text_regions: body.text_regions.map((region) => {
      const kind = referenceBundleString(region?.kind)
      if (!['text_subtitle', 'text_screen'].includes(kind)) throw referenceBundleInputError()
      return {
        region_key: referenceBundleString(region?.region_key),
        kind,
        time_ranges: referenceBundleRanges(region?.time_ranges),
        text_clean_redraw_asset_id: referenceBundleId(region?.text_clean_redraw_asset_id),
      }
    }),
    coverage_review: {
      recognizable_face_count: referenceBundleCount(review.recognizable_face_count),
      mapped_face_count: referenceBundleCount(review.mapped_face_count),
      unresolved_face_count: referenceBundleCount(review.unresolved_face_count),
      recognizable_text_region_count: referenceBundleCount(review.recognizable_text_region_count),
      mapped_text_region_count: referenceBundleCount(review.mapped_text_region_count),
      unresolved_text_region_count: referenceBundleCount(review.unresolved_text_region_count),
      status: referenceBundleString(review.status),
    },
  }
}

function referencePreparationShotIds(value) {
  if (value == null) return undefined
  if (!Array.isArray(value) || value.length === 0) throw new Error('参考准备镜头集合格式错误')
  const ids = value.map(Number)
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
    throw new Error('参考准备镜头集合格式错误')
  }
  return ids
}

export function buildReferencePreparationPayload(body = {}) {
  const payload = {}
  if (body?.quote_hash != null) payload.quote_hash = String(body.quote_hash).trim()
  if (body?.idempotency_key != null) payload.idempotency_key = String(body.idempotency_key).trim()
  const shotIds = referencePreparationShotIds(body?.shot_ids)
  if (shotIds) payload.shot_ids = shotIds
  return payload
}

export function buildReferencePreparationQuotePayload(body = {}) {
  const shotIds = referencePreparationShotIds(body?.shot_ids)
  return shotIds ? { shot_ids: shotIds } : {}
}

export function buildCandidateReviewPayload(body = {}) {
  return {
    decision: String(body?.decision || '').trim(),
    reason_code: String(body?.reason_code || '').trim(),
    candidate_sha256: String(body?.candidate_sha256 || '').trim(),
    expected_updated_at: String(body?.expected_updated_at || '').trim(),
  }
}

export function buildReleasePayload(body = {}) {
  return {
    idempotency_key: String(body?.idempotency_key || '').trim(),
    readiness_hash: String(body?.readiness_hash || '').trim(),
  }
}

function assertControlledReleaseUrl(value, report) {
  const requestPath = controlledReleaseRequestPath(value, report)
  if (!requestPath) {
    throw new Error('服务端返回的下载地址无效')
  }
  return requestPath
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
  updateProjectPolicy(projectId, body) {
    return request.put(`/redraw/projects/${projectId}/policy`, body)
  },
  listProjectEvents(projectId) {
    return request.get(`/redraw/projects/${projectId}/events`)
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
  getReferenceBundle(shotId) {
    return request.get(`/redraw/shots/${shotId}/reference-bundle`)
  },
  saveReferenceBundle(shotId, body) {
    return request.put(`/redraw/shots/${shotId}/reference-bundle`, buildReferenceBundlePayload(body))
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
  getCharacterPlan(versionId) {
    return request.get(`/redraw/versions/${versionId}/character-plan`)
  },
  getPreparationGate(versionId) {
    return request.get(`/redraw/versions/${versionId}/preparation-gate`)
  },
  quoteReferencePreparation(versionId, body = {}) {
    return request.post(
      `/redraw/versions/${versionId}/reference-preparation-quote`,
      buildReferencePreparationQuotePayload(body),
    )
  },
  startReferencePreparation(versionId, body) {
    return request.post(
      `/redraw/versions/${versionId}/reference-preparations`,
      buildReferencePreparationPayload(body),
    )
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
  saveRedrawCharacterIdentityPack(assetId, body) {
    return request.put(`/redraw/assets/${assetId}/identity-pack`, body)
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
  getGenerationSummary(versionId) {
    return request.get(`/redraw/versions/${versionId}/generation-summary`)
  },
  listCandidateReviews(shotId) {
    return request.get(`/redraw/shots/${shotId}/candidate-reviews`)
  },
  reviewCandidate(shotId, body) {
    return request.post(`/redraw/shots/${shotId}/candidate-reviews`, buildCandidateReviewPayload(body))
  },
  getReleaseReadiness(versionId) {
    return request.get(`/redraw/versions/${versionId}/release-readiness`)
  },
  createRelease(versionId, body) {
    return request.post(`/redraw/versions/${versionId}/releases`, buildReleasePayload(body))
  },
  downloadReleaseArtifact(relativeUrl, report = false) {
    const isReport = report === true
    const requestPath = assertControlledReleaseUrl(relativeUrl, isReport)
    return request.get(requestPath, isReport ? {} : { responseType: 'blob' })
  },
}
