const QUICK_GENERATION_MODES = new Set(['text', 'image', 'video'])

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase()
  return QUICK_GENERATION_MODES.has(mode) ? mode : 'image'
}

function normalizeReferenceImageUrl(value) {
  const url = String(value || '').trim()
  return url && url.length <= 2048 ? url : ''
}

export function normalizeQuickGenerationDraft(value = {}) {
  return {
    mode: normalizeMode(value.mode),
    prompt: String(value.prompt || '').trim(),
    model: String(value.model || '').trim(),
    aspectRatio: String(value.aspectRatio || '16:9').trim() || '16:9',
    duration: Math.min(15, Math.max(5, Math.trunc(Number(value.duration) || 5))),
    resolution: String(value.resolution || '720p').trim() || '720p',
    autoStart: value.autoStart === true,
    referenceImageUrl: normalizeReferenceImageUrl(value.referenceImageUrl),
  }
}

export function estimateGenerationCredits(model = {}, options = {}) {
  const credits = Number(model?.credits)
  if (!Number.isSafeInteger(credits) || credits <= 0) return null
  if (model?.billing_unit !== 'second') return credits
  const duration = Number(options.duration)
  if (!Number.isSafeInteger(duration) || duration < 5 || duration > 15) return null
  return credits * duration
}

export function buildQuickGenerationRequest(input = {}) {
  const mode = normalizeMode(input.mode)
  const prompt = String(input.prompt || '').trim()
  const model = String(input.model || '').trim()
  const referenceImageUrl = normalizeReferenceImageUrl(input.referenceImageUrl)
  if (mode === 'text') {
    return {
      endpoint: '/canvas/text/generate',
      body: {
        prompt,
        model,
        request_id: String(input.requestId || '').trim(),
      },
    }
  }

  const body = {
    prompt,
    model,
    ...(String(input.style || '').trim() ? { style: String(input.style).trim() } : {}),
    aspect_ratio: String(input.aspectRatio || '16:9').trim() || '16:9',
  }
  if (mode === 'image') {
    if (referenceImageUrl) body.reference_images = [referenceImageUrl]
    return { endpoint: '/images', body }
  }

  body.duration = Math.min(15, Math.max(5, Math.trunc(Number(input.duration) || 5)))
  body.resolution = String(input.resolution || '720p').trim() || '720p'
  if (referenceImageUrl) {
    body.first_frame_url = referenceImageUrl.startsWith('/static/')
      ? referenceImageUrl.slice('/static/'.length)
      : referenceImageUrl
    body.image_url = referenceImageUrl
  }
  return { endpoint: '/videos', body }
}

export { QUICK_GENERATION_MODES }
