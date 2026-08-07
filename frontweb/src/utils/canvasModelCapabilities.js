import { normalizeQuickGenerationCatalog } from './homeQuickGeneration.js'

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
  }
  capabilities.declared = Boolean(Object.keys(declared).length)
  return capabilities
}

export function normalizeCanvasModelCatalog(items = []) {
  return normalizeQuickGenerationCatalog(items).map((item) => ({
    model: item.model,
    label: item.label,
    publicNote: item.publicNote,
    verificationStatus: item.verificationStatus,
    protocol: item.protocol,
    kind: item.kind,
    credits: Number.isFinite(Number(item.credits)) && Number(item.credits) > 0 ? Number(item.credits) : null,
    billingUnit: String(item.billing_unit || item.billingUnit || '').trim(),
    resolutionPrices: item.resolution_prices || {},
    capabilities: normalizeCapabilities(item.kind, item.capabilities),
  }))
}
const CATALOG_ONLY_IMAGE_MODELS = new Set(['gpt-image-2-2-4k', 'nano-banana-2'])

export function filterCanvasCatalogFallbackModels(models = [], kind = '') {
  const uniqueModels = [...new Set((Array.isArray(models) ? models : [])
    .map((model) => String(model || '').trim())
    .filter(Boolean))]
  if (kind !== 'image') return uniqueModels
  return uniqueModels.filter((model) => !CATALOG_ONLY_IMAGE_MODELS.has(model.toLowerCase()))
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

export function canvasModelEntry(catalog, kind, model, requirements = {}) {
  const kindEntries = normalizeCanvasModelCatalog(catalog).filter((item) => item.kind === kind)
  return kindEntries.find((item) => item.model === model)
    || (!model ? kindEntries.find((item) => supportsRequirements(item, kind, requirements)) : null)
    || null
}

export function canvasModelOptions(catalog, kind, requirements = {}) {
  return normalizeCanvasModelCatalog(catalog)
    .filter((item) => item.kind === kind)
    .map((item) => {
      const disabled = !supportsRequirements(item, kind, requirements)
      const option = {
        value: item.model,
        label: disabled ? `${item.label}（不支持参考图）` : item.label,
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
  const durationMultiplier = kind === 'video' && entry.billingUnit === 'second'
    ? Math.max(1, Number(duration) || 1)
    : 1
  return credits * normalizedQuantity * durationMultiplier
}
