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

function executionRunActionPayload(body) {
  const payload = {
    expected_revision: body?.expected_revision,
    expected_plan_hash: body?.expected_plan_hash,
    expected_quote_hash: body?.expected_quote_hash,
    expected_confirmation_hash: body?.expected_confirmation_hash,
  }
  if (body?.output_parameters !== undefined) {
    payload.output_parameters = {
      resolution: body.output_parameters?.resolution,
      aspect_ratio: body.output_parameters?.aspect_ratio,
    }
  }
  return payload
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
  listProjectWorks(projectId) {
    return request.get(`/redraw/projects/${projectId}/works`)
  },
  createWorks(projectId, file) {
    const form = new FormData()
    form.append('file', file)
    return request.post(`/redraw/projects/${projectId}/works`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
  getWork(workId, options) {
    if (options) return request.get(`/redraw/works/${workId}`, { signal: options.signal, silentError: options.silentError })
    return request.get(`/redraw/works/${workId}`)
  },
  getBlueprint(workId) {
    return request.get(`/redraw/works/${workId}/blueprint`, { silentError: true })
  },
  getSourceAudioSeamReview(workId, options = {}) {
    return request.get(`/redraw/works/${workId}/source-audio-seam-review`, {
      params: options.params,
      signal: options.signal,
      silentError: true,
    })
  },
  recordSourceAudioSeamDecision(workId, body) {
    return request.post(`/redraw/works/${workId}/source-audio-seam-review`, body, { silentError: true })
  },
  resumeSourceAudioSeamAnalysis(workId, body) {
    return request.post(`/redraw/works/${workId}/source-audio-seam-resume`, body, { silentError: true })
  },
  getSourceVideo(workId, sourceIdentity, { signal } = {}) {
    return request.get(`/redraw/works/${workId}/source-video`, {
      params: { expected_source_asset_id: sourceIdentity.asset_id, expected_source_sha256: sourceIdentity.sha256 },
      responseType: 'blob', silentError: true, signal,
    })
  },
  saveBlueprint(workId, body) {
    return request.put(`/redraw/works/${workId}/blueprint`, body, { silentError: true })
  },
  lockBlueprint(workId, body) {
    return request.post(`/redraw/works/${workId}/blueprint/lock`, body, { silentError: true })
  },
  updateShot(shotId, body) {
    return request.put(`/redraw/shots/${shotId}`, body)
  },
  getReferenceBundle(shotId, options) {
    if (options) return request.get(`/redraw/shots/${shotId}/reference-bundle`, { signal: options.signal, silentError: options.silentError })
    return request.get(`/redraw/shots/${shotId}/reference-bundle`)
  },
  getMotionDraft(shotId, identity, { signal } = {}) {
    return request.get(`/redraw/shots/${shotId}/motion-draft`, {
      params: { expected_updated_at: identity.expected_updated_at, expected_source_sha256: identity.expected_source_sha256 },
      responseType: 'blob', silentError: true, signal,
    })
  },
  getMotionProcessing(shotId, identity, { signal } = {}) {
    return request.get(`/redraw/shots/${shotId}/motion-processing`, {
      params: { expected_updated_at: identity.expected_updated_at, expected_source_sha256: identity.expected_source_sha256 },
      responseType: 'blob', silentError: true, signal,
    })
  },
  getMotionReference(shotId, identity, { signal } = {}) {
    return request.get(`/redraw/shots/${shotId}/motion-reference`, {
      params: { expected_updated_at: identity.expected_updated_at, expected_source_sha256: identity.expected_source_sha256 },
      silentError: true, signal,
    })
  },
  getMotionReferenceMedia(shotId, identity, { signal } = {}) {
    return request.get(`/redraw/shots/${shotId}/motion-reference/media`, {
      params: { expected_updated_at: identity.expected_updated_at, expected_source_sha256: identity.expected_source_sha256,
        expected_import_id: identity.expected_import_id, expected_file_sha256: identity.expected_file_sha256 },
      responseType: 'blob', silentError: true, signal,
    })
  },
  uploadMotionReference(shotId, file, { expected_updated_at, idempotencyKey, full_frame_reviewed,
    source_identity_obscured, source_text_obscured, motion_preserved, processing_report } = {}) {
    const form = new FormData()
    form.append('file', file)
    form.append('expected_updated_at', expected_updated_at)
    if (processing_report !== undefined) form.append('processing_report', processing_report)
    for (const [field, value] of Object.entries({ full_frame_reviewed, source_identity_obscured, source_text_obscured, motion_preserved })) {
      form.append(field, value === true ? 'true' : 'false')
    }
    return request.post(`/redraw/shots/${shotId}/motion-reference`, form, {
      headers: { 'Content-Type': 'multipart/form-data', 'Idempotency-Key': idempotencyKey }, silentError: true,
    })
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
  getLocalization(versionId) {
    return request.get(`/redraw/versions/${versionId}/localization`, { silentError: true })
  },
  saveLocalization(versionId, body) {
    return request.put(`/redraw/versions/${versionId}/localization`, body, { silentError: true })
  },
  lockLocalization(versionId, body) {
    return request.post(`/redraw/versions/${versionId}/localization/lock`, body, { silentError: true })
  },
  getCharacterPlan(versionId) {
    return request.get(`/redraw/versions/${versionId}/character-plan`)
  },
  getExecutionPlanReview(versionId) {
    return request.get(`/redraw/versions/${versionId}/execution-plan/review`, { silentError: true })
  },
  saveExecutionPlanReview(versionId, body) {
    return request.post(`/redraw/versions/${versionId}/execution-plan/review`, {
      expected_plan_hash: body?.expected_plan_hash,
    }, { silentError: true })
  },
  getExecutionQueue(versionId) {
    return request.get(`/redraw/versions/${versionId}/execution-queue`, { silentError: true })
  },
  prepareExecutionQueue(versionId, body) {
    return request.post(`/redraw/versions/${versionId}/execution-queue`, {
      expected_plan_hash: body?.expected_plan_hash,
    }, { silentError: true })
  },
  listExecutionRuns(versionId, options) {
    return request.get(`/redraw/versions/${versionId}/execution-runs`, { silentError: true, signal: options?.signal })
  },
  getExecutionRun(versionId, runId, options) {
    return request.get(`/redraw/versions/${versionId}/execution-runs/${runId}`, { silentError: true, signal: options?.signal })
  },
  getExecutionRunReadiness(versionId, runId, input, options) {
    return request.get(`/redraw/versions/${versionId}/execution-runs/${runId}/readiness`, {
      params: { resolution: input?.resolution, aspect_ratio: input?.aspect_ratio }, silentError: true, signal: options?.signal,
    })
  },
  getExecutionUnitCandidate(versionId, runId, unitId, options) {
    return request.get(`/redraw/versions/${versionId}/execution-runs/${runId}/units/${encodeURIComponent(unitId)}/candidate`, {
      silentError: true, signal: options?.signal,
    })
  },
  getExecutionUnitCandidateMedia(versionId, runId, unitId, input, options) {
    return request.get(`/redraw/versions/${versionId}/execution-runs/${runId}/units/${encodeURIComponent(unitId)}/candidate/media`, {
      params: { expected_candidate_hash: input?.expected_candidate_hash }, responseType: 'blob', silentError: true, signal: options?.signal,
    })
  },
  createExecutionRun(versionId, body) {
    return request.post(`/redraw/versions/${versionId}/execution-runs`, {
      expected_plan_hash: body?.expected_plan_hash, expected_queue_id: body?.expected_queue_id,
    }, { silentError: true })
  },
  pauseExecutionRun(versionId, runId, body) {
    return request.post(`/redraw/versions/${versionId}/execution-runs/${runId}/pause`, {
      expected_revision: body?.expected_revision,
    }, { silentError: true })
  },
  resumeExecutionRun(versionId, runId, body) {
    return request.post(`/redraw/versions/${versionId}/execution-runs/${runId}/resume`, executionRunActionPayload(body), { silentError: true })
  },
  advanceExecutionRun(versionId, runId, body) {
    return request.post(`/redraw/versions/${versionId}/execution-runs/${runId}/advance`, executionRunActionPayload(body), { silentError: true })
  },
  recoverExecutionUnitTask(versionId, runId, body) {
    return request.post(`/redraw/versions/${versionId}/execution-runs/${runId}/recover`, { attempt_id: body?.attempt_id }, { silentError: true })
  },
  reviewExecutionUnitCandidate(versionId, runId, unitId, body) {
    return request.post(`/redraw/versions/${versionId}/execution-runs/${runId}/units/${encodeURIComponent(unitId)}/review`, {
      expected_revision: body?.expected_revision, expected_candidate_hash: body?.expected_candidate_hash,
      decision: body?.decision,
      checks: Object.fromEntries(Object.entries(body?.checks || {}).map(([key, value]) => [key, {
        basis: value?.basis, result: value?.result,
      }])),
    }, { silentError: true })
  },
  getUnitReferenceMaterials(versionId, queueId, unitId, input) {
    return request.get(`/redraw/versions/${versionId}/execution-queues/${queueId}/units/${encodeURIComponent(unitId)}/reference-materials`, {
      params: { review_id: input?.review_id, plan_hash: input?.plan_hash, unit_hash: input?.unit_hash }, silentError: true,
    })
  },
  prepareUnitReferenceMaterials(versionId, queueId, unitId, input) {
    return request.post(`/redraw/versions/${versionId}/execution-queues/${queueId}/units/${encodeURIComponent(unitId)}/reference-materials`, {
      review_id: input?.review_id, plan_hash: input?.plan_hash, unit_hash: input?.unit_hash,
      expected_materials_hash: input?.expected_materials_hash,
    }, { silentError: true })
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
  getGenerationGate(versionId, options) {
    if (options) return request.get(`/redraw/versions/${versionId}/generation-gate`, { signal: options.signal, silentError: options.silentError })
    return request.get(`/redraw/versions/${versionId}/generation-gate`)
  },
  getAssetQuote(assetId) {
    return request.get(`/redraw/assets/${assetId}/quote`)
  },
  quoteAssetBatch(versionId, body = {}) {
    return request.post(`/redraw/versions/${versionId}/assets/batch-quote`, body, { silentError: true })
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
  uploadIdentityReference(assetId, file, { expected_updated_at, idempotencyKey } = {}) {
    const form = new FormData()
    form.append('file', file)
    form.append('purpose', 'identity')
    form.append('expected_updated_at', expected_updated_at)
    return request.post(`/redraw/assets/${assetId}/reference-artifact`, form, {
      headers: { 'Content-Type': 'multipart/form-data', 'Idempotency-Key': idempotencyKey },
      silentError: true,
    })
  },
  getIdentityReferenceState(versionId, workId) {
    return Promise.all([
      request.get(`/redraw/versions/${versionId}/assets`, { silentError: true }),
      request.get(`/redraw/versions/${versionId}/generation-gate`, { silentError: true }),
      request.get(`/redraw/versions/${versionId}/character-plan`, { silentError: true }),
      request.get(`/redraw/works/${workId}`, { silentError: true }),
    ])
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
