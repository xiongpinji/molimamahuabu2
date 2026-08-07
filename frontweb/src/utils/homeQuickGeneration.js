import {
  assertVideoDurationAllowed,
  videoDurationOptionsForCapability,
} from './videoDuration.js'

const QUICK_GENERATION_MODES = new Set(['text', 'image', 'video'])
const IMAGE_RESOLUTIONS = ['1k', '2k', '4k']
const STRICT_CATALOG_PROTOCOLS = new Set(['usmercari_image', 'toapis_video'])
const VERIFIED_IMAGE_MODELS = Object.freeze({
  'gpt-image-2-2-4k': Object.freeze({ resolutions: Object.freeze(['1k', '2k']), quantities: Object.freeze([1]), maxReferences: 6 }),
  'nano-banana-2': Object.freeze({ resolutions: Object.freeze(['1k', '2k', '4k']), quantities: Object.freeze([1]), maxReferences: 6 }),
})
const VERIFIED_VIDEO_MODELS = Object.freeze({
  'seedance-2-fast': Object.freeze({
    resolutions: Object.freeze(['480p', '720p']),
    durations: Object.freeze(Array.from({ length: 12 }, (_, index) => index + 4)),
  }),
  'seedance-2-mini': Object.freeze({
    resolutions: Object.freeze(['480p', '720p']),
    durations: Object.freeze([4, 8, 10, 12, 15]),
  }),
})
const STRICT_CATALOG_PROVIDER_PROTOCOLS = Object.freeze({
  toapis: 'toapis_video',
  toapis_video: 'toapis_video',
  usmercari: 'usmercari_image',
  usmercari_image: 'usmercari_image',
})

function catalogProtocol(item = {}) {
  const protocol = String(item.protocol || item.api_protocol || '').trim().toLowerCase()
  if (STRICT_CATALOG_PROTOCOLS.has(protocol)) return protocol
  const provider = String(item.provider || '').trim().toLowerCase()
  if (STRICT_CATALOG_PROVIDER_PROTOCOLS[provider]) return STRICT_CATALOG_PROVIDER_PROTOCOLS[provider]
  const model = String(item.model || '').trim().toLowerCase()
  if (verifiedImageModel(model)) return 'usmercari_image'
  if (verifiedVideoModel(model)) return 'toapis_video'
  return protocol
}

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

function verifiedVideoModel(model) {
  return VERIFIED_VIDEO_MODELS[String(model || '').trim().toLowerCase()] || null
}

function uniqueNormalizedStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean))]
}

function intersectValues(declared, verified) {
  if (!verified) return declared
  return declared.filter((value) => verified.includes(value))
}

function effectiveVideoCapability(model, capability = {}) {
  const limits = verifiedVideoModel(model)
  if (!limits) return capability || {}
  const declaredResolutions = uniqueNormalizedStrings(capability?.resolutions)
  const declaredDurations = Array.isArray(capability?.durations)
    ? capability.durations.map(Number).filter(Number.isSafeInteger)
    : []
  return {
    ...(capability || {}),
    resolutions: declaredResolutions.length
      ? intersectValues(declaredResolutions, limits.resolutions)
      : [...limits.resolutions],
    durations: declaredDurations.length
      ? intersectValues(declaredDurations, limits.durations)
      : [...limits.durations],
  }
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
      const protocol = catalogProtocol(item)
      const verificationStatus = String(item.verification_status || item.verificationStatus || '').trim().toLowerCase()
      return !STRICT_CATALOG_PROTOCOLS.has(protocol) || verificationStatus === 'verified'
    })
    .map((item) => {
      const model = String(item.model).trim()
      const category = String(item.kind || item.category).trim().toLowerCase()
      const protocol = catalogProtocol(item)
      const declaredResolutions = uniqueNormalizedStrings(item.capabilities?.resolutions)
      const verifiedLimits = category === 'image' ? verifiedImageModel(model) : null
      const verifiedVideoLimits = category === 'video' ? verifiedVideoModel(model) : null
      const verifiedResolutions = verifiedLimits?.resolutions
        || verifiedVideoLimits?.resolutions
      const allowedResolutions = intersectValues(declaredResolutions, verifiedResolutions)
      const declaredDurations = Array.isArray(item.capabilities?.durations)
        ? item.capabilities.durations.map(Number).filter(Number.isSafeInteger)
        : []
      const allowedDurations = intersectValues(declaredDurations, verifiedVideoLimits?.durations)
      const resolutionPrices = normalizeResolutionPrices(
        item.resolution_prices || item.resolutionPrices,
        verifiedResolutions || null,
      )
      const exposedResolutions = STRICT_CATALOG_PROTOCOLS.has(protocol)
        ? allowedResolutions.filter((resolution) => Number(resolutionPrices?.[resolution]?.credits) > 0)
        : allowedResolutions
      return {
        ...item,
        model,
        category,
        kind: category,
        label: String(item.label || item.display_name || model),
        display_name: String(item.label || item.display_name || model),
        publicNote: String(item.public_note || item.publicNote || '').trim(),
        verificationStatus: String(item.verification_status || item.verificationStatus || '').trim(),
        protocol,
        resolution_prices: resolutionPrices,
        capabilities: {
          ...(item.capabilities || {}),
          ...(exposedResolutions.length ? { resolutions: exposedResolutions } : {}),
          ...(allowedDurations.length ? { durations: allowedDurations } : {}),
          ...(verifiedLimits ? {
            quantities: [...verifiedLimits.quantities],
            maxReferences: verifiedLimits.maxReferences,
          } : {}),
        },
      }
    })
    .filter((item) => {
      if (!STRICT_CATALOG_PROTOCOLS.has(item.protocol)) return true
      const verifiedModel = item.category === 'image'
        ? verifiedImageModel(item.model)
        : verifiedVideoModel(item.model)
      if (!verifiedModel || !item.capabilities.resolutions?.length) return false
      return item.protocol !== 'toapis_video' || item.capabilities.durations?.length
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

export function quickGenerationDurations(model = {}) {
  const capability = effectiveVideoCapability(model?.model, model?.capabilities || {})
  return videoDurationOptionsForCapability(capability)
}

export function normalizeQuickGenerationDraft(value = {}, modelMetadata = {}) {
  const mode = normalizeMode(value.mode)
  const hasModelMetadata = Boolean(modelMetadata?.model)
  const capability = hasModelMetadata
    ? effectiveVideoCapability(modelMetadata.model, modelMetadata?.capabilities || {})
    : {}
  const durationOptions = videoDurationOptionsForCapability(capability)
  const requestedDuration = Math.trunc(Number(value.duration) || durationOptions[0] || 5)
  const resolutionOptions = hasModelMetadata ? quickGenerationResolutions(modelMetadata, mode) : []
  const requestedResolution = String(value.resolution || (mode === 'image' ? '1k' : '720p')).trim().toLowerCase()
  const quantityOptions = Array.isArray(capability.quantities) && capability.quantities.length
    ? capability.quantities.map(Number).filter(Number.isSafeInteger)
    : [1, 2, 3, 4]
  const requestedQuantity = Math.trunc(Number(value.quantity) || 1)
  return {
    mode,
    prompt: String(value.prompt || '').trim(),
    model: String(value.model || '').trim(),
    aspectRatio: String(value.aspectRatio || '16:9').trim() || '16:9',
    duration: mode === 'video'
      ? (hasModelMetadata
        ? (durationOptions.includes(requestedDuration) ? requestedDuration : durationOptions[0])
        : requestedDuration)
      : Math.min(15, Math.max(5, requestedDuration)),
    resolution: mode === 'image'
      ? normalizeImageResolution(value.resolution)
      : (resolutionOptions.length && !resolutionOptions.includes(requestedResolution)
        ? resolutionOptions[0]
        : requestedResolution || '720p'),
    quantity: quantityOptions.includes(requestedQuantity)
      ? requestedQuantity
      : quantityOptions[0] || 1,
    autoStart: value.autoStart === true,
    referenceImageUrl: normalizeReferenceImageUrl(value.referenceImageUrl),
    generateAudio: hasModelMetadata
      ? capability.supportsAudio === true && value.generateAudio === true
      : value.generateAudio === true,
  }
}

export function estimateGenerationCredits(model = {}, options = {}) {
  const resolution = String(options.resolution || '').trim().toLowerCase()
  const prices = model?.resolution_prices || model?.resolutionPrices || {}
  const hasResolutionPrices = Object.keys(prices).length > 0
  const tierCredits = Number(prices?.[resolution]?.credits)
  const protocol = String(model?.protocol || model?.api_protocol || '').trim().toLowerCase()
  if (protocol === 'toapis_video' && (!Number.isSafeInteger(tierCredits) || tierCredits <= 0)) return null
  const category = String(model?.category || model?.kind || (model?.billing_unit === 'second' ? 'video' : '')).trim().toLowerCase()
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
  try {
    assertVideoDurationAllowed(duration, effectiveVideoCapability(model?.model, model?.capabilities || {}))
  } catch (_) {
    return null
  }
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

  const providedCapability = input.capability || input.capabilities || {}
  if (verifiedVideoModel(model) && !Object.keys(providedCapability).length) {
    throw new Error('当前视频模型目录尚未就绪，请刷新后重试')
  }
  const capability = effectiveVideoCapability(input.model, providedCapability)
  const declaredResolutions = uniqueNormalizedStrings(capability.resolutions)
  const requestedResolution = String(input.resolution || '720p').trim().toLowerCase() || '720p'
  if (declaredResolutions.length && !declaredResolutions.includes(requestedResolution)) {
    throw new Error(`当前模型视频清晰度仅支持 ${declaredResolutions.join('、')}`)
  }
  body.duration = assertVideoDurationAllowed(input.duration, capability)
  body.resolution = requestedResolution
  if (input.generateAudio === true && capability.supportsAudio !== true) {
    throw new Error('当前模型未开放同步音频')
  }
  if (capability.supportsAudio === true) body.generate_audio = input.generateAudio === true
  if (referenceImageUrl) {
    if (capability.supportsFirstFrame === false) throw new Error('当前模型未开放首帧参考')
    body.reference_mode = 'first_last'
    body.first_frame_url = referenceImageUrl.startsWith('/static/')
      ? referenceImageUrl.slice('/static/'.length)
      : referenceImageUrl
    body.image_url = referenceImageUrl
  }
  return { endpoint: '/videos', body }
}

export { QUICK_GENERATION_MODES }
