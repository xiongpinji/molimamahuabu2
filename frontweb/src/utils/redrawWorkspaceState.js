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
