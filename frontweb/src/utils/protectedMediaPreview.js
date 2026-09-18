import { readSession, readCurrentTenantId } from './authSession.js'

const previewCache = new Map()
const inflight = new Map()

export function isProtectedStaticMediaUrl(value) {
  return /^\/static\//i.test(String(value || '').trim())
}

export function peekProtectedMediaPreview(value) {
  const url = String(value || '').trim()
  if (!url) return ''
  return previewCache.get(url) || ''
}

export function clearProtectedMediaPreviewCache() {
  for (const objectUrl of previewCache.values()) {
    if (String(objectUrl).startsWith('blob:') && globalThis.URL?.revokeObjectURL) {
      try { globalThis.URL.revokeObjectURL(objectUrl) } catch (_) { /* ignore */ }
    }
  }
  previewCache.clear()
  inflight.clear()
}

export async function loadProtectedMediaPreview(value, options = {}) {
  const url = String(value || '').trim()
  if (!url || !isProtectedStaticMediaUrl(url)) return url

  const cached = previewCache.get(url)
  if (cached) return cached
  if (inflight.has(url)) return inflight.get(url)

  const session = options.session === undefined ? readSession() : options.session
  const tenantId = options.tenantId === undefined ? readCurrentTenantId() : options.tenantId
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const urlApi = options.urlApi || globalThis.URL
  if (typeof fetchImpl !== 'function' || !urlApi?.createObjectURL) return ''

  const task = (async () => {
    const headers = {}
    if (session?.token) headers.Authorization = `Bearer ${session.token}`
    if (tenantId) headers['X-Tenant-Id'] = String(tenantId)
    const response = await fetchImpl(url, { headers, credentials: 'same-origin' })
    if (!response?.ok) throw new Error(`参考素材加载失败 (${response?.status || 0})`)
    const blob = await response.blob()
    const objectUrl = urlApi.createObjectURL(blob)
    previewCache.set(url, objectUrl)
    return objectUrl
  })()

  inflight.set(url, task)
  try {
    return await task
  } finally {
    inflight.delete(url)
  }
}
