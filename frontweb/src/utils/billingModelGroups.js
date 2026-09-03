const UNKNOWN_PROVIDER_KEY = 'unassigned'

function providerEntries(item = {}) {
  if (Array.isArray(item.providers) && item.providers.length) return item.providers
  if (item.config_id || item.provider || item.provider_name || item.provider_base_url) {
    return [{
      config_id: item.config_id,
      provider: item.provider,
      provider_name: item.provider_name,
      provider_base_url: item.provider_base_url,
    }]
  }
  return []
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol)) return raw.toLowerCase().replace(/\/+$/, '')
    const pathname = url.pathname.replace(/\/+$/, '')
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${pathname}${url.search}`
  } catch (_) {
    return raw.toLowerCase().replace(/\/+$/, '')
  }
}

function providerGroupKey(entry = {}) {
  const baseUrl = normalizeBaseUrl(entry.provider_base_url)
  if (baseUrl) return `url:${baseUrl}`
  const provider = String(entry.provider || entry.provider_name || '').trim().toLowerCase()
  return provider ? `provider:${provider}` : UNKNOWN_PROVIDER_KEY
}

function providerGroupLabel(entry = {}) {
  return String(entry.provider_name || entry.provider || '').trim() || '未关联中转站'
}

function sameProviderEntry(candidate = {}, target = {}) {
  const candidateConfigId = Number(candidate.config_id)
  const targetConfigId = Number(target.config_id)
  if (Number.isSafeInteger(candidateConfigId) && candidateConfigId > 0
      && Number.isSafeInteger(targetConfigId) && targetConfigId > 0) {
    return candidateConfigId === targetConfigId
  }
  return providerGroupKey(candidate) === providerGroupKey(target)
}

function yuanFromMicros(value) {
  const micros = Number(value)
  return Number.isFinite(micros) && micros > 0 ? micros / 1_000_000 : 0
}

function providerCostFallback(item, providerCosts) {
  if (providerCosts.length !== 1) return item
  const [cost] = providerCosts
  const resolutionPrices = Object.fromEntries(
    Object.entries(item.resolution_prices || {}).map(([resolution, tier]) => [resolution, { ...tier }]),
  )
  const providerResolutionPrices = cost.resolution_prices && typeof cost.resolution_prices === 'object'
    ? cost.resolution_prices
    : {}
  const fallbackCredits = Number(item.credits) > 0 ? Number(item.credits) : 1

  for (const [resolution, tier] of Object.entries(providerResolutionPrices)) {
    const current = resolutionPrices[resolution] || { credits: fallbackCredits }
    const amount = yuanFromMicros(tier?.micros_per_unit)
    resolutionPrices[resolution] = item.category === 'image'
      ? {
          ...current,
          cost_yuan_per_unit: Number(current.cost_yuan_per_unit) > 0
            ? Number(current.cost_yuan_per_unit)
            : amount,
        }
      : {
          ...current,
          cost_yuan_per_second: Number(current.cost_yuan_per_second) > 0
            ? Number(current.cost_yuan_per_second)
            : amount,
        }
  }

  return {
    ...item,
    cost_unit: item.cost_unit || cost.cost_unit,
    cost_yuan_per_unit: Number(item.cost_yuan_per_unit) > 0
      ? Number(item.cost_yuan_per_unit)
      : yuanFromMicros(cost.micros_per_unit),
    input_cost_yuan_per_1k: Number(item.input_cost_yuan_per_1k) > 0
      ? Number(item.input_cost_yuan_per_1k)
      : yuanFromMicros(cost.input_cost_micros_per_1k),
    output_cost_yuan_per_1k: Number(item.output_cost_yuan_per_1k) > 0
      ? Number(item.output_cost_yuan_per_1k)
      : yuanFromMicros(cost.output_cost_micros_per_1k),
    resolution_prices: resolutionPrices,
  }
}

function scopeItemToProviders(item, entries) {
  const scopedEntries = Array.isArray(entries) ? entries : []
  const providerCosts = (Array.isArray(item.provider_costs) ? item.provider_costs : [])
    .filter((cost) => scopedEntries.some((entry) => sameProviderEntry(cost, entry)))
  return providerCostFallback({
    ...item,
    providers: scopedEntries,
    provider_costs: providerCosts,
  }, providerCosts)
}

export function filterModelPricesByProviderConfig(items = [], configId) {
  const targetConfigId = Number(configId)
  if (!Number.isSafeInteger(targetConfigId) || targetConfigId <= 0) {
    return Array.isArray(items) ? items : []
  }
  return (Array.isArray(items) ? items : []).flatMap((item) => {
    const entries = providerEntries(item).filter((entry) => Number(entry.config_id) === targetConfigId)
    return entries.length ? [scopeItemToProviders(item, entries)] : []
  })
}

export function groupModelPricesByProvider(items = []) {
  const groups = new Map()
  for (const item of Array.isArray(items) ? items : []) {
    const entries = providerEntries(item)
    const uniqueEntries = entries.filter((entry, index) => (
      entries.findIndex((candidate) => providerGroupKey(candidate) === providerGroupKey(entry)) === index
    ))
    const targets = uniqueEntries.length ? uniqueEntries : [{}]
    for (const entry of targets) {
      const key = providerGroupKey(entry)
      let group = groups.get(key)
      if (!group) {
        group = {
          key,
          label: providerGroupLabel(entry),
          baseUrl: String(entry.provider_base_url || '').trim(),
          items: [],
        }
        groups.set(key, group)
      }
      group.items.push(scopeItemToProviders(item, uniqueEntries.length ? [entry] : []))
    }
  }
  return [...groups.values()]
}
