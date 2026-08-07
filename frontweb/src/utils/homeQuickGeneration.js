const QUICK_GENERATION_MODES = new Set(['text', 'image', 'video'])
const IMAGE_RESOLUTIONS = ['1k', '2k', '4k']
const VERIFIED_IMAGE_MODELS = Object.freeze({
  'gpt-image-2-2-4k': Object.freeze({ resolutions: Object.freeze(['1k', '2k']), quantities: Object.freeze([1]), maxReferences: 6 }),
  'nano-banana-2': Object.freeze({ resolutions: Object.freeze(['1k', '2k', '4k']), quantities: Object.freeze([1]), maxReferences: 6 }),
})

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase()
  return QUICK_GENERATION_MODES.has(mode) ? mode : 'image'
}

function normalizeReferenceImageUrl(value) {
  const url = String(value || '').trim()
  return url && url.length <= 2048 ? url : ''
}

function normalizeImageResolution(value, fallback = '1k') {
  const resolution = String(value || '').trim().toLowerCase()
  return IMAGE_RESOLUTIONS.includes(resolution) ? resolution : fallback
}

function verifiedImageModel(model) {
  return VERIFIED_IMAGE_MODELS[String(model || '').trim().toLowerCase()] || null
}

export function imageModelMaxReferences(model) {
  return verifiedImageModel(model)?.maxReferences || null
}

export function validateQuickImageSelection({ model, resolution, quantity = 1 } = {}) {
  const limits = verifiedImageModel(model)
  if (!limits) return
  const normalizedResolution = normalizeImageResolution(resolution, '')
  if (!limits.resolutions.includes(normalizedResolution)) {
    throw new Error(`当前模型只开放 ${limits.resolutions.join('、')}`)
  }
  if (!limits.quantities.includes(Number(quantity))) {
    throw new Error('当前模型只开放单张生成')
  }
}

function normalizeResolutionPrices(value, allowedResolutions = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const allowed = allowedResolutions ? new Set(allowedResolutions) : null
  return Object.fromEntries(Object.entries(value)
    .map(([resolution, tier]) => [String(resolution || '').trim().toLowerCase(), tier])
    .filter(([resolution]) => resolution && (!allowed || allowed.has(resolution))))
}

export function imageSizeFromResolution(aspectRatio, resolution) {
  const longEdge = { '1k': 1024, '2k': 2048, '4k': 4096 }[normalizeImageResolution(resolution, '')]
  if (!longEdge) return ''
  const [rawWidth, rawHeight] = String(aspectRatio || '').trim().split(':').map(Number)
  if (!rawWidth || !rawHeight) return ''
  const landscape = rawWidth >= rawHeight
  const width = landscape ? longEdge : Math.round(longEdge * rawWidth / rawHeight)
  const height = landscape ? Math.round(longEdge * rawHeight / rawWidth) : longEdge
  const even = (number) => Math.max(2, Math.round(number / 2) * 2)
  return `${even(width)}x${even(height)}`
}

export function normalizeQuickGenerationCatalog(items = []) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item?.model && (item?.kind || item?.category))
    .filter((item) => {
      const protocol = String(item.protocol || item.api_protocol || '').trim().toLowerCase()
      const verificationStatus = String(item.verification_status || item.verificationStatus || '').trim().toLowerCase()
      return protocol !== 'usmercari_image' || verificationStatus === 'verified'
    })
    .map((item) => {
      const model = String(item.model).trim()
      const category = String(item.kind || item.category).trim().toLowerCase()
      const declaredResolutions = Array.isArray(item.capabilities?.resolutions)
        ? item.capabilities.resolutions.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
        : []
      const verifiedLimits = category === 'image' ? verifiedImageModel(model) : null
      const verifiedResolutions = verifiedLimits?.resolutions
      const allowedResolutions = verifiedResolutions
        ? declaredResolutions.filter((value) => verifiedResolutions.includes(value))
        : declaredResolutions
      const resolutionPrices = normalizeResolutionPrices(
        item.resolution_prices || item.resolutionPrices,
        category === 'image' && verifiedResolutions ? verifiedResolutions : null,
      )
      return {
        ...item,
        model,
        category,
        kind: category,
        label: String(item.label || item.display_name || model),
        display_name: String(item.label || item.display_name || model),
        publicNote: String(item.public_note || item.publicNote || '').trim(),
        verificationStatus: String(item.verification_status || item.verificationStatus || '').trim(),
        protocol: String(item.protocol || item.api_protocol || '').trim(),
        resolution_prices: resolutionPrices,
        capabilities: {
          ...(item.capabilities || {}),
          ...(allowedResolutions.length ? { resolutions: allowedResolutions } : {}),
          ...(verifiedLimits ? {
            quantities: [...verifiedLimits.quantities],
            maxReferences: verifiedLimits.maxReferences,
          } : {}),
        },
      }
    })
}

export function quickGenerationResolutions(model = {}, mode = '') {
  const category = String(mode || model.category || model.kind || '').trim().toLowerCase()
  const declared = Array.isArray(model?.capabilities?.resolutions)
    ? model.capabilities.resolutions.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
    : []
  if (declared.length) return [...new Set(declared)]
  const priced = Object.keys(model?.resolution_prices || model?.resolutionPrices || {})
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
  if (priced.length) return [...new Set(priced)]
  return category === 'image' ? ['1k', '2k'] : category === 'video' ? ['720p'] : []
}

export function normalizeQuickGenerationDraft(value = {}) {
  const mode = normalizeMode(value.mode)
  return {
    mode,
    prompt: String(value.prompt || '').trim(),
    model: String(value.model || '').trim(),
    aspectRatio: String(value.aspectRatio || '16:9').trim() || '16:9',
    duration: Math.min(15, Math.max(5, Math.trunc(Number(value.duration) || 5))),
    resolution: mode === 'image'
      ? normalizeImageResolution(value.resolution)
      : String(value.resolution || '720p').trim().toLowerCase() || '720p',
    quantity: Math.min(4, Math.max(1, Math.trunc(Number(value.quantity) || 1))),
    autoStart: value.autoStart === true,
    referenceImageUrl: normalizeReferenceImageUrl(value.referenceImageUrl),
  }
}

export function estimateGenerationCredits(model = {}, options = {}) {
  const resolution = String(options.resolution || '').trim().toLowerCase()
  const prices = model?.resolution_prices || model?.resolutionPrices || {}
  const hasResolutionPrices = Object.keys(prices).length > 0
  const tierCredits = Number(prices?.[resolution]?.credits)
  const category = String(model?.category || model?.kind || '').trim().toLowerCase()
  if (hasResolutionPrices && ['image', 'video'].includes(category)
      && (!Number.isSafeInteger(tierCredits) || tierCredits <= 0)) return null
  const credits = Number.isSafeInteger(tierCredits) && tierCredits > 0
    ? tierCredits
    : Number(model?.credits)
  if (!Number.isSafeInteger(credits) || credits <= 0) return null
  const quantity = Number(options.quantity ?? 1)
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 4) return null
  if (category === 'image') return credits * quantity
  if (model?.billing_unit !== 'second') return credits
  const duration = Number(options.duration)
  if (!Number.isSafeInteger(duration) || duration < 5 || duration > 15) return null
  return credits * duration * quantity
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
    const requestedResolution = String(input.resolution || '1k').trim().toLowerCase()
    const requestedQuantity = input.quantity == null ? 1 : Number(input.quantity)
    validateQuickImageSelection({ model, resolution: requestedResolution, quantity: requestedQuantity })
    const resolution = normalizeImageResolution(input.resolution)
    const quantity = Math.min(4, Math.max(1, Math.trunc(Number(input.quantity) || 1)))
    body.resolution = resolution
    body.size = imageSizeFromResolution(body.aspect_ratio, resolution)
    body.n = quantity
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
