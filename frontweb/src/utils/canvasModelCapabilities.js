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
  }
  capabilities.declared = Boolean(Object.keys(declared).length)
  return capabilities
}

export function normalizeCanvasModelCatalog(items = []) {
  return items.filter((item) => normalizeModelOption(item?.model) && item?.kind).map((item) => {
    const model = normalizeModelOption(item.model)
    return {
    model,
    label: String(item.label || item.model),
    note: String(item.note ?? item.public_note ?? '').trim(),
    kind: String(item.kind),
    provider: String(item.provider || '').toLowerCase(),
    defaultVoiceId: String(item.default_voice_id || item.defaultVoiceId || '').trim(),
    credits: Number.isFinite(Number(item.credits)) && Number(item.credits) > 0 ? Number(item.credits) : null,
    billingUnit: String(item.billing_unit || item.billingUnit || '').trim(),
    resolutionPrices: item.resolution_prices || item.resolutionPrices || {},
    capabilities: normalizeCapabilities(item.kind, item.capabilities),
  }
  })
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
        note: item.note,
      }
      if (disabled) option.disabled = true
      return option
    })
}

export function estimateCanvasCredits(catalog, kind, model, quantity = 1, duration = 1, resolution = '') {
  const entry = canvasModelEntry(catalog, kind, model)
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
