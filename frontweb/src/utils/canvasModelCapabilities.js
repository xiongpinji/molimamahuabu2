import { normalizeQuickGenerationCatalog } from './homeQuickGeneration.js'
import { normalizeModelOption } from './modelSelection.js'

const DEFAULTS = {
  image: { aspectRatios: ['16:9', '9:16', '1:1'], resolutions: ['1K', '2K'], quantities: [1], maxReferences: 0, declared: false },
  video: {
    aspectRatios: ['16:9', '9:16', '1:1'],
    resolutions: ['720p'],
    durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    quantities: [1],
    referenceTypes: ['image'],
    maxReferences: 3,
    maxImageReferences: 3,
    maxAudioReferences: 0,
    maxVideoReferences: 0,
    supportsAudio: false,
    declared: false,
  },
  text: { quantities: [1] },
  audio: { quantities: [1] },
}

function normalizeCapabilities(kind, value) {
  const defaults = DEFAULTS[kind] || {}
  const declared = value && typeof value === 'object' ? value : {}
  const capabilities = { ...defaults, ...declared }
  if (kind === 'video') {
    capabilities.referenceTypes = [...new Set((Array.isArray(declared.referenceTypes)
      ? declared.referenceTypes
      : defaults.referenceTypes).filter((type) => ['image', 'audio', 'video'].includes(type)))]
    const imageLimit = Number(declared.maxImageReferences ?? declared.maxReferences ?? defaults.maxImageReferences)
    capabilities.maxImageReferences = Number.isInteger(imageLimit) && imageLimit >= 0 ? imageLimit : defaults.maxImageReferences
    capabilities.maxReferences = capabilities.maxImageReferences
    for (const type of ['Audio', 'Video']) {
      const key = `max${type}References`
      const limit = Number(declared[key] ?? defaults[key])
      capabilities[key] = Number.isInteger(limit) && limit >= 0 ? limit : defaults[key]
    }
    for (const [type, key] of [
      ['image', 'supportsImageReference'],
      ['video', 'supportsVideoReference'],
      ['audio', 'supportsAudioReference'],
    ]) {
      capabilities[key] = typeof declared[key] === 'boolean'
        ? declared[key]
        : capabilities.referenceTypes.includes(type)
    }
    capabilities.supportsFirstFrame = declared.supportsFirstFrame === true
    capabilities.supportsLastFrame = declared.supportsLastFrame === true
  }
  capabilities.declared = Boolean(Object.keys(declared).length)
  return capabilities
}

function opaqueConfigId(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null
  const number = Number(value.trim())
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function catalogConfigId(items, normalizedItem) {
  const direct = opaqueConfigId(normalizedItem?.config_id ?? normalizedItem?.configId)
  if (direct !== null) return direct
  const source = (Array.isArray(items) ? items : []).find((item) => (
    String(item?.kind || '') === normalizedItem?.kind
    && normalizeModelOption(item?.model) === normalizedItem?.model
  ))
  return opaqueConfigId(source?.config_id ?? source?.configId)
}

export function normalizeCanvasModelCatalog(items = []) {
  return normalizeQuickGenerationCatalog(items).map((item) => ({
    configId: catalogConfigId(items, item),
    model: item.model,
    label: item.label,
    publicNote: item.publicNote,
    note: item.publicNote,
    verificationStatus: item.verificationStatus,
    protocol: item.protocol,
    kind: item.kind,
    provider: String(item.provider || '').toLowerCase(),
    defaultVoiceId: String(item.default_voice_id || item.defaultVoiceId || '').trim(),
    credits: Number.isFinite(Number(item.credits)) && Number(item.credits) > 0 ? Number(item.credits) : null,
    billingUnit: String(item.billing_unit || item.billingUnit || '').trim(),
    resolutionPrices: item.resolution_prices || {},
    capabilities: normalizeCapabilities(item.kind, item.capabilities),
  }))
}

export function createCanvasModelCatalogLoader(loadCatalog) {
  let state = { status: 'idle', catalog: [], error: null }
  let inFlight = null

  function snapshot() {
    return { ...state }
  }

  function load() {
    if (state.status === 'loaded') return Promise.resolve(state.catalog)
    if (inFlight) return inFlight

    state = { ...state, status: 'loading', error: null }
    let response
    try {
      response = loadCatalog()
    } catch (error) {
      state = { ...state, status: 'error', error }
      return Promise.reject(error)
    }

    const request = Promise.resolve(response)
      .then((items) => {
        const catalog = normalizeCanvasModelCatalog(Array.isArray(items) ? items : [])
        state = { status: 'loaded', catalog, error: null }
        return catalog
      })
      .catch((error) => {
        state = { ...state, status: 'error', error }
        throw error
      })
      .finally(() => {
        if (inFlight === request) inFlight = null
      })
    inFlight = request
    return request
  }

  return { load, snapshot }
}

export function canvasModelSelectionDecision(catalog, kind, model, catalogStatus = 'loaded') {
  const normalizedModel = normalizeModelOption(model)
  if (catalogStatus === 'error') return { ok: false, code: 'CATALOG_ERROR', model: normalizedModel }
  if (catalogStatus !== 'loaded') return { ok: false, code: 'CATALOG_NOT_READY', model: normalizedModel }
  if (!normalizedModel) return { ok: true, code: 'MODEL_DEFAULT', model: '' }
  const entry = canvasModelEntry(catalog, kind, normalizedModel)
  return entry
    ? { ok: true, code: 'MODEL_AVAILABLE', model: entry.model }
    : { ok: false, code: 'MODEL_UNAVAILABLE', model: normalizedModel }
}

const CATALOG_ONLY_IMAGE_MODELS = new Set(['gpt-image-2-2-4k', 'nano-banana-2'])
const CATALOG_ONLY_VIDEO_MODELS = new Set([
  'minimax h3',
  'seedance-2.0-fast',
  'seedance-2.0-mini',
  'seedance-2-fast',
  'seedance-2-mini',
  'xuan-video-v1-6e7b4763634e6206',
  'xuan-seedance-2.5',
  'sdas-my-seedance-2.0-fast-upscaled-1080p',
  'lingjing-video-v1',
])

export function filterCanvasCatalogFallbackModels(models = [], kind = '') {
  const uniqueModels = [...new Set((Array.isArray(models) ? models : [])
    .map((model) => String(model || '').trim())
    .filter(Boolean))]
  if (kind === 'image') {
    return uniqueModels.filter((model) => !CATALOG_ONLY_IMAGE_MODELS.has(model.toLowerCase()))
  }
  if (kind === 'video') {
    return uniqueModels.filter((model) => !CATALOG_ONLY_VIDEO_MODELS.has(model.toLowerCase()))
  }
  return uniqueModels
}

export function canvasModelCapability(catalog, kind, model) {
  return canvasModelEntry(catalog, kind, model)?.capabilities
    || normalizeCapabilities(kind, {})
}

function supportsRequirements(entry, kind, requirements = {}) {
  if (kind !== 'image') return true
  const referenceCount = Math.max(0, Number(requirements.referenceCount) || 0)
  const limit = Math.max(0, Number(entry?.capabilities?.maxReferences) || 0)
  return referenceCount <= limit
}

function safePositiveInteger(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : 0
}

function imageReferenceCapability(capabilities = {}) {
  const limit = safePositiveInteger(capabilities.maxReferences ?? capabilities.maxImageReferences)
  const supported = capabilities.supportsImageReference === true
    || capabilities.supportsReferenceImages === true
    || limit > 0
  const declaredUnsupported = capabilities.supportsImageReference === false
    || capabilities.supportsReferenceImages === false
    || (Object.prototype.hasOwnProperty.call(capabilities, 'maxReferences') && limit === 0)
  return { limit, supported, declaredUnsupported }
}

export function imageModelCapabilityBadges(capabilities = {}) {
  const badges = ['文生图']
  const reference = imageReferenceCapability(capabilities)
  if (reference.supported) badges.push(`图生图：最多 ${reference.limit} 张参考图`)
  else badges.push(reference.declaredUnsupported ? '参考图：不支持' : '参考图：能力未标明')

  const resolutions = Array.isArray(capabilities.resolutions)
    ? capabilities.resolutions.map(String).filter(Boolean)
    : []
  if (resolutions.length) badges.push(`清晰度：${resolutions.join(' / ')}`)

  const aspectRatios = Array.isArray(capabilities.aspectRatios)
    ? capabilities.aspectRatios.map(String).filter(Boolean)
    : []
  if (aspectRatios.length) {
    badges.push(aspectRatios.length <= 5
      ? `画面比例：${aspectRatios.join(' / ')}`
      : `画面比例：${aspectRatios.length} 种`)
  }

  const quantities = Array.isArray(capabilities.quantities)
    ? capabilities.quantities.map(Number).filter((value) => Number.isSafeInteger(value) && value > 0)
    : []
  if (quantities.length === 1) badges.push(`每次 ${quantities[0]} 张`)
  else if (quantities.length > 1) badges.push(`每次可生成：${quantities.join(' / ')} 张`)
  return badges
}

export function imageModelCapabilityLabel(capabilities = {}) {
  const reference = imageReferenceCapability(capabilities)
  if (reference.supported) return `文生图 · 图生图（${reference.limit} 张参考图）`
  return `文生图 · ${reference.declaredUnsupported ? '不支持参考图' : '参考图能力未标明'}`
}

export function canvasModelEntry(catalog, kind, model, requirements = {}) {
  const kindEntries = normalizeCanvasModelCatalog(catalog).filter((item) => item.kind === kind)
  return kindEntries.find((item) => item.model === model)
    || (!model ? kindEntries.find((item) => supportsRequirements(item, kind, requirements)) : null)
    || null
}

export function canvasModelRoute(catalog, kind, model) {
  return normalizeCanvasModelCatalog(catalog).find((item) => item.kind === kind && item.model === model)
}

export function canvasModelOptions(catalog, kind, requirements = {}) {
  return normalizeCanvasModelCatalog(catalog)
    .filter((item) => item.kind === kind)
    .map((item) => {
      const disabled = !supportsRequirements(item, kind, requirements)
      const capabilityLabel = kind === 'image' ? `｜${imageModelCapabilityLabel(item.capabilities)}` : ''
      const option = {
        value: item.model,
        label: disabled
          ? `${item.label}${capabilityLabel}（超出参考图上限）`
          : `${item.label}${capabilityLabel}`,
      }
      if (disabled) option.disabled = true
      return option
    })
}

export function estimateCanvasCredits(catalog, kind, model, quantity = 1, duration = 1, resolution = '') {
  const entry = canvasModelEntry(catalog, kind, model)
  const normalizedResolution = String(resolution).trim().toLowerCase()
  const hasResolutionPrices = Object.keys(entry?.resolutionPrices || {}).length > 0
  const tierCredits = ['image', 'video'].includes(kind)
    ? Number(entry?.resolutionPrices?.[normalizedResolution]?.credits)
    : NaN
  if (entry?.protocol === 'toapis_video' && (!Number.isSafeInteger(tierCredits) || tierCredits <= 0)) return null
  if (hasResolutionPrices && ['image', 'video'].includes(kind)
      && (!Number.isSafeInteger(tierCredits) || tierCredits <= 0)) return null
  const credits = Number.isSafeInteger(tierCredits) && tierCredits > 0 ? tierCredits : entry?.credits
  if (!credits) return null
  const normalizedQuantity = Number(quantity)
  if (!Number.isSafeInteger(normalizedQuantity) || normalizedQuantity < 1 || normalizedQuantity > 4) return null
  const declaredQuantities = Array.isArray(entry?.capabilities?.quantities)
    ? entry.capabilities.quantities.map(Number)
    : []
  if (entry?.capabilities?.declared && declaredQuantities.length && !declaredQuantities.includes(normalizedQuantity)) return null
  if (kind === 'video' && entry?.capabilities?.declared) {
    const durations = Array.isArray(entry.capabilities?.durations)
      ? entry.capabilities.durations.map(Number)
      : []
    if (!durations.includes(Number(duration))) return null
  }
  const durationMultiplier = kind === 'video' && entry.billingUnit === 'second'
    ? Math.max(1, Number(duration) || 1)
    : 1
  return credits * normalizedQuantity * durationMultiplier
}
