export function parseModelList(models, defaultModel = '') {
  if (Array.isArray(models)) {
    return models.map((m) => String(m).trim()).filter(Boolean)
  }
  if (typeof models === 'string') {
    return models.split(/[\n,，]/).map((s) => s.trim()).filter(Boolean)
  }
  return defaultModel ? [String(defaultModel).trim()].filter(Boolean) : []
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
