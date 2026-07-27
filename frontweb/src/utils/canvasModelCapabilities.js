const DEFAULTS = {
  image: { aspectRatios: ['16:9', '9:16', '1:1'], resolutions: ['1K', '2K'], quantities: [1], maxReferences: 4, declared: false },
  video: { aspectRatios: ['16:9', '9:16', '1:1'], resolutions: ['720p'], durations: [5], quantities: [1], maxReferences: 3, supportsAudio: false, declared: false },
  text: { quantities: [1] },
  audio: { quantities: [1] },
}

export function normalizeCanvasModelCatalog(items = []) {
  return items.filter((item) => item?.model && item?.kind).map((item) => ({
    model: String(item.model),
    label: String(item.label || item.model),
    kind: String(item.kind),
    credits: Number.isFinite(Number(item.credits)) && Number(item.credits) > 0 ? Number(item.credits) : null,
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

export function estimateCanvasCredits(catalog, kind, model, quantity = 1) {
  const entry = normalizeCanvasModelCatalog(catalog).find((item) => item.kind === kind && item.model === model)
  return entry?.credits ? entry.credits * Math.max(1, Number(quantity) || 1) : null
}
