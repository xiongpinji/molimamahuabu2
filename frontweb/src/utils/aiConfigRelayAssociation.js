function normalizeModels(value) {
  if (Array.isArray(value)) return value
  if (value == null) return []

  const raw = String(value).trim()
  if (!raw) return []

  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed
  } catch (_) {}

  return raw.split(/[,，]/)
}

function relayHostname(baseUrl) {
  try {
    const url = new URL(String(baseUrl || ''))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '未识别域名'
    return url.hostname || '未识别域名'
  } catch (_) {
    return '未识别域名'
  }
}

export function buildAiConfigRelayAssociations(row = {}) {
  const models = [...new Set(
    normalizeModels(row.model)
      .map((model) => String(model ?? '').trim())
      .filter(Boolean),
  )]
  if (models.length === 0) return []

  const configName = String(row.name ?? '').trim() || '未命名配置'
  const configId = String(row.id ?? '').trim() || '—'
  const detail = `${configName} · ${relayHostname(row.base_url)} · #${configId}`

  return models.map((model) => ({ model, detail }))
}
