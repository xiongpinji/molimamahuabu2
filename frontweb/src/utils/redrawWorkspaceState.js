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

export function resolveUpdatedStep({ routeStep, previousBackendStep, nextBackendStep }) {
  const route = normalizeStep(routeStep)
  const previousBackend = normalizeStep(previousBackendStep)
  const nextBackend = normalizeStep(nextBackendStep)
  if (nextBackend > previousBackend && route < nextBackend) return nextBackend
  return Math.min(route, nextBackend)
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

function hasRefundOrReleaseEvidence(work) {
  return Number(work?.localization_billing?.released || 0) > 0
}

export function redrawWorkflowPhase(work) {
  const localizationStatus = normalizedStatus(work?.localization_task?.status)
  if (['pending', 'processing', 'localizing'].includes(localizationStatus)) return 'localizing'
  if (['failed', 'needs_attention'].includes(localizationStatus)) return 'localization_needs_attention'
  if (localizationStatus === 'completed') return 'assets'
  const phase = normalizedStatus(work?.workflow_phase)
  if (['asset_review', 'assets'].includes(phase)) return 'assets'
  if (phase) return phase
  if (Number(work?.current_step || 1) > 1) return 'assets'
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
  return normalizedStatus(task.status || task.task_status) === 'failed' && hasRefundOrReleaseEvidence(work)
}

export function shouldResetLocalizationIdempotencyKey(work) {
  const task = work?.localization_task || {}
  const status = normalizedStatus(task.status || task.task_status)
  return status === 'completed' || (status === 'failed' && hasRefundOrReleaseEvidence(work))
}

export function localizationQuoteRequestKey(input) {
  return [
    String(input?.workId || '').trim(),
    String(input?.locale || '').trim(),
    String(input?.market || '').trim(),
    String(input?.localizationLevel || input?.localization_level || 'faithful').trim() || 'faithful',
  ].join('|')
}

export function createLocalizationQuoteRequestGate() {
  const active = new Set()
  let desiredKey = ''
  return {
    begin(input) {
      const key = localizationQuoteRequestKey(input)
      desiredKey = key
      if (active.has(key)) return false
      active.add(key)
      return true
    },
    finish(input) {
      active.delete(localizationQuoteRequestKey(input))
    },
    isActive(input) {
      return active.has(localizationQuoteRequestKey(input))
    },
    accepts(input) {
      return desiredKey === localizationQuoteRequestKey(input)
    },
  }
}

export function createLocalizationConfirmationSnapshot({ work, quoteBody }) {
  const request = {
    workId: work?.id,
    locale: quoteBody?.locale,
    market: quoteBody?.market,
    localizationLevel: quoteBody?.localization_level || quoteBody?.localizationLevel || 'faithful',
  }
  return {
    workId: work?.id,
    phase: redrawWorkflowPhase(work),
    previousHash: String(work?.localization_quote?.quote_hash || '').trim(),
    requestKey: localizationQuoteRequestKey(request),
    quoteBody: {
      locale: String(quoteBody?.locale || '').trim(),
      market: String(quoteBody?.market || '').trim(),
      localization_level: String(quoteBody?.localization_level || quoteBody?.localizationLevel || 'faithful').trim() || 'faithful',
    },
  }
}

export function isCurrentLocalizationConfirmation(snapshot, { work, quoteBody }) {
  if (!snapshot?.workId || String(work?.id || '') !== String(snapshot.workId)) return false
  if (redrawWorkflowPhase(work) !== snapshot.phase) return false
  if (!['analysis_review', 'localization_needs_attention', 'failed'].includes(snapshot.phase)) return false
  if (!canConfirmLocalization(work, snapshot.previousHash)) return false
  const currentKey = localizationQuoteRequestKey({
    workId: work?.id,
    locale: quoteBody?.locale,
    market: quoteBody?.market,
    localizationLevel: quoteBody?.localization_level || quoteBody?.localizationLevel || 'faithful',
  })
  return currentKey === snapshot.requestKey
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
