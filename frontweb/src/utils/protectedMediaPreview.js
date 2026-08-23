import { readSession, readCurrentTenantId } from './authSession.js'

export function isProtectedStaticMediaUrl(value) {
  return /^\/static\//i.test(String(value || '').trim())
}

export async function loadProtectedMediaPreview(value, options = {}) {
  const url = String(value || '').trim()
  if (!url || !isProtectedStaticMediaUrl(url)) return url

  const session = options.session === undefined ? readSession() : options.session
  const tenantId = options.tenantId === undefined ? readCurrentTenantId() : options.tenantId
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const urlApi = options.urlApi || globalThis.URL
  if (typeof fetchImpl !== 'function' || !urlApi?.createObjectURL) return ''

  const headers = {}
  if (session?.token) headers.Authorization = `Bearer ${session.token}`
  if (tenantId) headers['X-Tenant-Id'] = String(tenantId)
  const response = await fetchImpl(url, { headers, credentials: 'same-origin' })
  if (!response?.ok) throw new Error(`参考素材加载失败 (${response?.status || 0})`)
  const blob = await response.blob()
  return urlApi.createObjectURL(blob)
}
