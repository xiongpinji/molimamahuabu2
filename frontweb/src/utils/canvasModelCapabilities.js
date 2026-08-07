const DEFAULTS = {
  image: { aspectRatios: ['16:9', '9:16', '1:1'], resolutions: ['1K', '2K'], quantities: [1], maxReferences: 4, declared: false },
  video: { aspectRatios: ['16:9', '9:16', '1:1'], resolutions: ['720p'], durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], quantities: [1], maxReferences: 3, supportsAudio: false, declared: false },
  text: { quantities: [1] },
  audio: { quantities: [1] },
}

export function normalizeCanvasModelCatalog(items = []) {
  return items.filter((item) => item?.model && item?.kind).map((item) => ({
    model: String(item.model),
    label: String(item.label || item.model),
    kind: String(item.kind),
    credits: Number.isFinite(Number(item.credits)) && Number(item.credits) > 0 ? Number(item.credits) : null,
    billingUnit: String(item.billing_unit || item.billingUnit || '').trim(),
    resolutionPrices: item.resolution_prices || item.resolutionPrices || {},
    capabilities: {
      ...(DEFAULTS[item.kind] || {}),
      ...(item.capabilities || {}),
      declared: Boolean(item.capabilities && Object.keys(item.capabilities).length),
    },
  }))
}

export function canvasModelCapability(catalog, kind, model) {
  return normalizeCanvasModelCatalog(catalog).find((item) => item.kind === kind && item.model === model)?.capabilities
    || { ...(DEFAULTS[kind] || {}) }
}

export function estimateCanvasCredits(catalog, kind, model, quantity = 1, duration = 1, resolution = '') {
  const entry = normalizeCanvasModelCatalog(catalog).find((item) => item.kind === kind && item.model === model)
  const tierCredits = kind === 'video'
    ? Number(entry?.resolutionPrices?.[String(resolution).trim().toLowerCase()]?.credits)
    : NaN
  const credits = Number.isSafeInteger(tierCredits) && tierCredits > 0 ? tierCredits : entry?.credits
  if (!credits) return null
  const durationMultiplier = kind === 'video' && entry.billingUnit === 'second'
    ? Math.max(1, Number(duration) || 1)
    : 1
  return credits * Math.max(1, Number(quantity) || 1) * durationMultiplier
}
