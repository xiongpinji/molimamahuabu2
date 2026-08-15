export function normalizeModelOption(model) {
  if (model == null) return ''
  if (typeof model === 'object') {
    return String(model.value ?? model.model ?? model.id ?? model.name ?? '').trim()
  }
  const value = String(model).trim()
  if (!value) return ''
  if (value.startsWith('{') || value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return ''
      return normalizeModelOption(parsed)
    } catch (_) {
      // Preserve non-JSON model IDs that happen to start with a brace.
    }
  }
  return value
}

export function parseModelList(models, defaultModel = '') {
  if (Array.isArray(models)) {
    return [...new Set(models.flatMap((item) => {
      if (typeof item === 'string' && (item.trim().startsWith('[') || item.trim().startsWith('{'))) {
        try {
          const parsed = JSON.parse(item)
          return Array.isArray(parsed) ? parseModelList(parsed) : [normalizeModelOption(parsed)]
        } catch (_) {}
      }
      return [normalizeModelOption(item)]
    }).filter(Boolean))]
  }
  if (typeof models === 'string') {
    const value = models.trim()
    if (value.startsWith('[') || value.startsWith('{')) {
      try {
        const parsed = JSON.parse(value)
        return parseModelList(parsed, defaultModel)
      } catch (_) {}
    }
    return value.split(/[\n,，]/).map((s) => normalizeModelOption(s)).filter(Boolean)
  }
  const fallback = normalizeModelOption(defaultModel)
  return fallback ? [fallback] : []
}

export function getModelsFromAiConfig(config) {
  return parseModelList(config?.model, config?.default_model)
}

export function isConfigForServiceType(config, serviceType) {
  if (config?.service_type === serviceType) return true
  return serviceType === 'storyboard_image' && config?.service_type === 'image'
}

export function getSelectableModels(configs, serviceType, configId) {
  const list = Array.isArray(configs) ? configs : []
  const selectedConfig = configId
    ? list.find((c) => c.id === configId)
    : null
  const config = selectedConfig
    || list.find((c) => c.service_type === serviceType && c.is_active && c.is_default)
    || list.find((c) => isConfigForServiceType(c, serviceType) && c.is_active && c.is_default)
    || list.find((c) => c.service_type === serviceType && c.is_active)
    || list.find((c) => isConfigForServiceType(c, serviceType) && c.is_active)

  if (!config) return []
  return getModelsFromAiConfig(config)
}

export function getSelectableModelsAcrossConfigs(configs, serviceType) {
  const models = (Array.isArray(configs) ? configs : [])
    .filter((config) => config?.is_active && isConfigForServiceType(config, serviceType))
    .flatMap((config) => getModelsFromAiConfig(config))
  return [...new Set(models)]
}
