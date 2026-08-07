export function normalizeStep(value) {
  const step = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(step)) return 1
  return Math.min(4, Math.max(1, step))
}

export function resolveAllowedStep(routeStepValue, backendStepValue) {
  const routeStep = normalizeStep(routeStepValue)
  const backendStep = normalizeStep(backendStepValue)
  return Math.min(routeStep, backendStep)
}

export function isExistingWorkId(value) {
  const id = Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(id) && id > 0
}

export function analysisQuoteCredits(work) {
  const credits = Number(work?.analysis_quote?.credits ?? work?.analysis_quote?.amount)
  return Number.isSafeInteger(credits) && credits > 0 ? credits : null
}

export function localizationQuoteCredits(work) {
  const quote = work?.localization_quote
  const credits = Number(quote?.credits ?? quote?.amount)
  return quote?.priced === true && Number.isSafeInteger(credits) && credits > 0 ? credits : null
}

export function localeReady(locales) {
  return Array.isArray(locales) && locales.length > 0
}

function referencePayload(referenceImage) {
  if (!referenceImage) return null
  const filename = String(referenceImage.filename || referenceImage.name || '').trim()
  const id = String(referenceImage.id || referenceImage.asset_id || '').trim()
  const reference = {}
  if (filename) reference.filename = filename
  if (id) reference.id = id
  if (typeof referenceImage.arrayBuffer === 'function') reference.file = referenceImage
  return Object.keys(reference).length ? reference : null
}

export function buildAnalyzePayload({ locale, market, aspectRatio, selectedPreset, freeStyle }) {
  const payload = {
    locale: String(locale || '').trim(),
    market: String(market || '').trim(),
    aspect_ratio: String(aspectRatio || '').trim(),
  }
  if (selectedPreset?.id != null) {
    payload.style_preset_id = Number(selectedPreset.id)
    return payload
  }
  const positive = String(freeStyle?.positivePrompt || freeStyle?.positive || '').trim()
  const negative = String(freeStyle?.negativePrompt || freeStyle?.negative || '').trim()
  const reference = referencePayload(freeStyle?.referenceImage || freeStyle?.reference)
  payload.free_style = {
    positive,
    negative,
    ...(reference ? { reference } : {}),
  }
  return payload
}

export function taskStateFromWork(work) {
  return {
    task_id: work?.task_id || '',
    status: work?.task_status || work?.status || '',
    progress: Number.isFinite(Number(work?.task_progress)) ? Number(work.task_progress) : 0,
    message: work?.task_message || '',
  }
}

function normalizedStatus(value) {
  return String(value || '').trim().toLowerCase()
}

function hasRefundOrReleaseEvidence(task) {
  return ['refunded', 'refund_confirmed'].includes(normalizedStatus(task?.refund_status))
    || ['released', 'release_confirmed'].includes(normalizedStatus(task?.credit_hold_status))
    || task?.refunded === true
    || task?.credits_refunded === true
    || task?.credit_released === true
}

export function redrawWorkflowPhase(work) {
  const localizationStatus = normalizedStatus(work?.localization_task?.status)
  if (['pending', 'processing', 'localizing'].includes(localizationStatus)) return 'localizing'
  if (['failed', 'needs_attention'].includes(localizationStatus)) return 'localization_needs_attention'
  if (localizationStatus === 'completed' || Number(work?.current_step || 1) > 1) return 'assets'
  const phase = normalizedStatus(work?.workflow_phase)
  if (phase) return phase
  if (normalizedStatus(work?.analysis_task?.status) === 'completed') return 'analysis_review'
  return 'source'
}

export function localizationTaskState(work) {
  const task = work?.localization_task || {}
  const progress = Number(task.progress ?? task.task_progress)
  return {
    task_id: task.id || task.task_id || '',
    status: task.status || task.task_status || '',
    progress: Number.isFinite(progress) ? progress : 0,
    message: task.message || task.task_message || '',
  }
}

export function canConfirmLocalization(work, expectedQuoteHash) {
  const quote = work?.localization_quote
  if (localizationQuoteCredits(work) == null || !String(quote?.quote_hash || '').trim()) return false
  if (expectedQuoteHash && String(quote.quote_hash).trim() !== String(expectedQuoteHash).trim()) return false
  const phase = redrawWorkflowPhase(work)
  if (phase === 'analysis_review') return true
  if (!['localization_needs_attention', 'failed'].includes(phase)) return false
  const task = work?.localization_task || {}
  return normalizedStatus(task.status || task.task_status) === 'failed' && hasRefundOrReleaseEvidence(task)
}

export function buildLocalizationPayload(body) {
  return {
    locale: String(body?.locale || '').trim(),
    market: String(body?.market || '').trim(),
    localization_level: String(body?.localizationLevel || 'faithful').trim(),
    quote_hash: String(body?.quoteHash || '').trim(),
    idempotency_key: String(body?.idempotencyKey || '').trim(),
  }
}

export function canStartRedrawAnalysis({ work, selectedFile, locales, selectedPreset, freeStyle }) {
  const hasStyle = Boolean(
    selectedPreset?.id != null
      || String(freeStyle?.positivePrompt || freeStyle?.positive || '').trim(),
  )
  return Boolean(
    analysisQuoteCredits(work) != null
      && localeReady(locales)
      && (work?.id || selectedFile)
      && hasStyle,
  )
}

export function createRedrawStyleSelection() {
  return {
    selectedPreset: null,
    freeStyle: { positivePrompt: '', negativePrompt: '', referenceImage: null },
    selectPreset(preset) {
      this.selectedPreset = preset || null
      this.freeStyle = { positivePrompt: '', negativePrompt: '', referenceImage: null }
    },
    setFreeStyle(style) {
      this.selectedPreset = null
      this.freeStyle = {
        positivePrompt: String(style?.positivePrompt || style?.positive || '').trim(),
        negativePrompt: String(style?.negativePrompt || style?.negative || '').trim(),
        referenceImage: style?.referenceImage || style?.reference || null,
      }
    },
  }
}
