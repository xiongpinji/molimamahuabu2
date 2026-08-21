import { normalizeCanvasModelCatalog } from './canvasModelCapabilities.js'
import { normalizeModelOption } from './modelSelection.js'

export function createFilmCreateModelCatalogLoader(loadCatalog) {
  let state = { status: 'idle', catalog: [], error: null }
  let inFlight = null

  function snapshot() {
    return { ...state, catalog: [...state.catalog] }
  }

  function load({ forceRefresh = false } = {}) {
    if (inFlight) return inFlight
    if (!forceRefresh && state.status === 'loaded') return Promise.resolve(state.catalog)

    state = { ...state, status: 'loading', error: null }
    let response
    try {
      response = loadCatalog()
    } catch (error) {
      state = { status: 'error', catalog: [], error }
      return Promise.reject(error)
    }

    const request = Promise.resolve(response)
      .then((items) => {
        const catalog = normalizeCanvasModelCatalog(Array.isArray(items) ? items : [])
        state = { status: 'loaded', catalog, error: null }
        return catalog
      })
      .catch((error) => {
        state = { status: 'error', catalog: [], error }
        throw error
      })
      .finally(() => {
        if (inFlight === request) inFlight = null
      })
    inFlight = request
    return request
  }

  return {
    load,
    forceRefresh: () => load({ forceRefresh: true }),
    snapshot,
  }
}

export function intersectFilmCreateVideoModels(aiModels = [], catalog = []) {
  const publicByModel = new Map(normalizeCanvasModelCatalog(catalog)
    .filter((item) => item.kind === 'video')
    .map((item) => [item.model, item]))
  return [...new Set(aiModels.map(normalizeModelOption).filter(Boolean))]
    .filter((model) => publicByModel.has(model))
    .map((model) => {
      const item = publicByModel.get(model)
      return { value: model, label: item.label, note: item.note }
    })
}

export function filmCreateVideoModelDecision(state, options = [], model = '') {
  const normalizedModel = normalizeModelOption(model)
  if (state?.status === 'error') return { ok: false, code: 'CATALOG_ERROR', model: normalizedModel }
  if (state?.status !== 'loaded') return { ok: false, code: 'CATALOG_NOT_READY', model: normalizedModel }
  const publicVideoModels = normalizeCanvasModelCatalog(state.catalog).filter((item) => item.kind === 'video')
  if (!publicVideoModels.length) return { ok: false, code: 'CATALOG_EMPTY', model: normalizedModel }
  if (!options.length) return { ok: false, code: 'NO_AVAILABLE_MODELS', model: normalizedModel }
  if (!normalizedModel) return { ok: false, code: 'MODEL_REQUIRED', model: '' }
  return options.some((item) => item.value === normalizedModel)
    ? { ok: true, code: 'MODEL_AVAILABLE', model: normalizedModel }
    : { ok: false, code: 'MODEL_UNAVAILABLE', model: normalizedModel }
}
