const DEFAULTS = {
  image: { aspectRatios: ['16:9', '9:16', '1:1'], resolutions: ['1K', '2K'], quantities: [1], maxReferences: 4, declared: false },
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
  return items.filter((item) => item?.model && item?.kind).map((item) => ({
    model: String(item.model),
    label: String(item.label || item.model),
    kind: String(item.kind),
    credits: Number.isFinite(Number(item.credits)) && Number(item.credits) > 0 ? Number(item.credits) : null,
    billingUnit: String(item.billing_unit || item.billingUnit || '').trim(),
    capabilities: normalizeCapabilities(item.kind, item.capabilities),
  }))
}

export function canvasModelCapability(catalog, kind, model) {
  return canvasModelEntry(catalog, kind, model)?.capabilities
    || normalizeCapabilities(kind, {})
}

export function canvasModelEntry(catalog, kind, model) {
  const kindEntries = normalizeCanvasModelCatalog(catalog).filter((item) => item.kind === kind)
  return kindEntries.find((item) => item.model === model) || (!model ? kindEntries[0] : null) || null
}

export function canvasModelOptions(catalog, kind) {
  return normalizeCanvasModelCatalog(catalog)
    .filter((item) => item.kind === kind)
    .map((item) => ({ value: item.model, label: item.label }))
}

export function estimateCanvasCredits(catalog, kind, model, quantity = 1, duration = 1) {
  const entry = canvasModelEntry(catalog, kind, model)
  if (!entry?.credits) return null
  const durationMultiplier = kind === 'video' && entry.billingUnit === 'second'
    ? Math.max(1, Number(duration) || 1)
    : 1
  return entry.credits * Math.max(1, Number(quantity) || 1) * durationMultiplier
}
